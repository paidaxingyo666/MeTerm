import { invoke } from '@tauri-apps/api/core';
import QRCode from 'qrcode';
import { t } from './i18n';
import { escapeHtml } from './status-bar';
import { TerminalRegistry } from './terminal';
import { notifyUser } from './notify';
import { showInfoSystem } from './window-lifecycle';
import { port, authToken, handledPairIds, pairPollTimer, setPairPollTimer } from './app-state';

export interface PairingData {
  v: 2;
  addrs: string[];
  /** Legacy compatibility field. v2 pairing must keep this empty. */
  token?: '';
  pair_ticket: string;
  cert_fp: string;
  name: string;
  device_id?: string;
}

export async function getPairingInfo(): Promise<PairingData> {
  const raw = await invoke<string>('get_pairing_info');
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid v2 pairing data');
  }
  const value = parsed as Record<string, unknown>;
  const addrs = value.addrs;
  if (
    value.v !== 2
    || !Array.isArray(addrs)
    || !addrs.every((addr) => typeof addr === 'string')
    || typeof value.pair_ticket !== 'string'
    // A 32-byte base64url-no-pad value is 43 chars; its final symbol has only
    // four significant bits, so canonical encodings end at an index divisible by 4.
    || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value.pair_ticket)
    || typeof value.cert_fp !== 'string'
    || !/^[a-fA-F0-9]{64}$/.test(value.cert_fp)
    || typeof value.name !== 'string'
    || (value.token !== undefined && value.token !== '')
  ) {
    throw new Error('Invalid v2 pairing data');
  }
  return {
    v: 2,
    addrs,
    token: '',
    pair_ticket: value.pair_ticket,
    cert_fp: value.cert_fp.toLowerCase(),
    name: value.name,
    device_id: typeof value.device_id === 'string' ? value.device_id : undefined,
  };
}

/** 生成 16 字节随机数并转成 hex 字符串（配对 nonce，仅前端加，塞进 QR）。 */
function genPairNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 创建配对弹窗的 HTML 内容
 */
export function createPairingDialog(data: PairingData): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.className = 'pairing-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'pairing-dialog';

  const title = document.createElement('h2');
  title.textContent = t('pairingTitle');
  title.className = 'pairing-title';
  dialog.appendChild(title);

  const subtitle = document.createElement('p');
  subtitle.textContent = t('pairingSubtitle');
  subtitle.className = 'pairing-subtitle';
  dialog.appendChild(subtitle);

  // QR 码区域
  const qrContainer = document.createElement('div');
  qrContainer.className = 'pairing-qr-container';
  dialog.appendChild(qrContainer);

  // 本次弹窗的唯一 nonce（每次开弹窗生成一枚，仅用于 QR + 轮询归属，不改 data 原对象）
  const nonce = genPairNonce();
  // 显式白名单 QR 字段，避免后端无意添加的配置或凭据渗入剪贴板/二维码。
  const publicPairingData: PairingData = {
    v: 2,
    addrs: data.addrs,
    token: '',
    pair_ticket: data.pair_ticket,
    cert_fp: data.cert_fp,
    name: data.name,
    device_id: data.device_id,
  };
  // 复制用 JSON 不含 nonce，但包含一次性 pair_ticket。
  const pairingJson = JSON.stringify(publicPairingData);
  // QR 编码用的 JSON（附带 pair_nonce 字段，手机扫码后回传以精确匹配本弹窗）
  const qrJson = JSON.stringify({ ...publicPairingData, pair_nonce: nonce });

  // 渲染 QR 码:统一黑码白底(承托在白色圆角卡片上,观感干净、各家扫码器更稳)
  const canvas = document.createElement('canvas');
  QRCode.toCanvas(canvas, qrJson, {
    width: 196,
    margin: 1,
    color: { dark: '#000000', light: '#ffffff' },
  }).catch(() => {
    // fallback: 显示文本
    qrContainer.textContent = qrJson;
  });
  qrContainer.appendChild(canvas);

  // 状态行（默认隐藏，配对成功后显示）
  const statusLine = document.createElement('div');
  statusLine.className = 'pairing-status';
  statusLine.style.display = 'none';
  dialog.appendChild(statusLine);

  // 「配对成功后自动关闭」复选框（状态持久化到 localStorage，默认勾选）
  const autoCloseWrap = document.createElement('label');
  autoCloseWrap.className = 'pairing-autoclose';
  const autoCloseCheckbox = document.createElement('input');
  autoCloseCheckbox.type = 'checkbox';
  // 未设置过时默认 true；仅当显式存过 'false' 才不勾
  autoCloseCheckbox.checked = localStorage.getItem('meterm-pairing-autoclose') !== 'false';
  autoCloseCheckbox.onchange = () => {
    localStorage.setItem('meterm-pairing-autoclose', autoCloseCheckbox.checked ? 'true' : 'false');
  };
  const autoCloseText = document.createElement('span');
  autoCloseText.textContent = t('pairingAutoClose');
  autoCloseWrap.appendChild(autoCloseCheckbox);
  autoCloseWrap.appendChild(autoCloseText);
  dialog.appendChild(autoCloseWrap);

  // 定时器句柄（闭包持有，关闭任何路径都要清理）
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  // 统一清理：停轮询 + 停倒计时
  const cleanup = (): void => {
    if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
    if (countdownTimer !== null) { clearInterval(countdownTimer); countdownTimer = null; }
  };

  // ── 折叠区（分享/更多）：默认收起 ──
  const moreToggle = document.createElement('button');
  moreToggle.className = 'pairing-more-toggle';
  moreToggle.textContent = `${t('pairingMore')} ▾`;

  const moreSection = document.createElement('div');
  moreSection.className = 'pairing-more-section';
  moreSection.style.display = 'none';

  moreToggle.onclick = () => {
    const collapsed = moreSection.style.display === 'none';
    moreSection.style.display = collapsed ? '' : 'none';
    moreToggle.textContent = `${t('pairingMore')} ${collapsed ? '▴' : '▾'}`;
  };

  // ── 人类可读信息（不显示任何凭据或中继配置）──
  const kvList = document.createElement('div');
  kvList.className = 'pairing-kv-list';

  const kvRow = (label: string, valueNode: Node): void => {
    const row = document.createElement('div');
    row.className = 'pairing-kv';
    const k = document.createElement('span');
    k.className = 'pairing-kv-k';
    k.textContent = label;
    row.appendChild(k);
    row.appendChild(valueNode);
    kvList.appendChild(row);
  };
  const textVal = (s: string): HTMLSpanElement => {
    const v = document.createElement('span');
    v.className = 'pairing-kv-v';
    v.textContent = s;
    v.title = s;   // 溢出省略号时悬停看全
    return v;
  };

  kvRow(t('pairingDeviceName'), textVal(data.name));
  const addrSummary = data.addrs.length > 1
    ? `${data.addrs[0]} +${data.addrs.length - 1}`
    : (data.addrs[0] || '—');
  kvRow(t('pairingAddress'), textVal(addrSummary));

  moreSection.appendChild(kvList);

  // 折叠区按钮栏（仅复制 v2 一次性配对 JSON）
  const moreButtons = document.createElement('div');
  moreButtons.className = 'pairing-buttons';

  // 复制配对数据按钮
  const copyBtn = document.createElement('button');
  copyBtn.textContent = t('pairingCopyData');
  copyBtn.className = 'pairing-btn';
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(pairingJson);
      copyBtn.textContent = t('pairingCopied');
      setTimeout(() => { copyBtn.textContent = t('pairingCopyData'); }, 2000);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = pairingJson;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      copyBtn.textContent = t('pairingCopied');
      setTimeout(() => { copyBtn.textContent = t('pairingCopyData'); }, 2000);
    }
  };
  moreButtons.appendChild(copyBtn);
  moreSection.appendChild(moreButtons);

  // 「分享/更多」文字链 + 折叠区(降级为次要,不与主按钮争抢)
  dialog.appendChild(moreToggle);
  dialog.appendChild(moreSection);

  // ── 主按钮:关闭(唯一主操作,整行正常尺寸)──
  const closeBtn = document.createElement('button');
  closeBtn.textContent = t('pairingClose');
  closeBtn.className = 'pairing-btn pairing-btn-close';
  closeBtn.onclick = () => { cleanup(); overlay.remove(); };
  dialog.appendChild(closeBtn);

  overlay.appendChild(dialog);

  // ── 轮询：配对成功检测 ──
  // 命中后停轮询、显示「已配对」；若勾选自动关闭则起 5s 倒计时后关弹窗。
  const onClaimed = (deviceName?: string): void => {
    cleanup();
    const paired = deviceName ? `${t('pairingPaired')}（${deviceName}）` : t('pairingPaired');
    const withCountdown = (n: number): string =>
      `${paired} · ${t('pairingAutoCloseIn').replace('{n}', String(n))}`;
    statusLine.textContent = paired;
    statusLine.style.display = '';
    if (!autoCloseCheckbox.checked) return;
    // 5 秒倒计时自动关闭
    let remain = 5;
    statusLine.textContent = withCountdown(remain);
    countdownTimer = setInterval(() => {
      remain -= 1;
      if (remain <= 0) {
        cleanup();
        overlay.remove();
        return;
      }
      statusLine.textContent = withCountdown(remain);
    }, 1000);
  };

  // 仅在拿得到 port + token 时才轮询（仿 startPairPoller 的 fetch）
  if (port > 0 && authToken) {
    pollTimer = setInterval(async () => {
      try {
        const resp = await fetch(
          `http://127.0.0.1:${port}/api/pair/claim-status?nonce=${encodeURIComponent(nonce)}`,
          { headers: { 'Authorization': `Bearer ${authToken}` } },
        );
        if (!resp.ok) return;
        const body = await resp.json();
        if (body && body.claimed === true) {
          onClaimed(typeof body.device_name === 'string' ? body.device_name : undefined);
        }
      } catch { /* ignore network errors */ }
    }, 1500);
  }

  // 点击遮罩关闭
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { cleanup(); overlay.remove(); }
  });

  return overlay;
}

/**
 * 显示配对弹窗
 */
export async function showPairingDialog(): Promise<void> {
  try {
    const data = await getPairingInfo();
    const overlay = createPairingDialog(data);
    document.body.appendChild(overlay);
  } catch (error) {
    console.error('pairing data unavailable:', error);
    await showInfoSystem(t('settingsLanPairingDisabled'), t('homeNewPhonePairing'));
  }
}

// ── Pair Request Approval (extracted from main.ts) ──

/** Send pair approval via WebSocket (preferred) or HTTP fallback. */
export function respondPairApproval(approved: boolean, pairId: string): void {
  const sent = TerminalRegistry.sendPairApproval(approved, pairId);
  if (!sent && port > 0 && authToken) {
    // HTTP fallback when no active WebSocket connection
    void fetch(`http://127.0.0.1:${port}/api/pair/${pairId}/respond`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ approved }),
    }).catch(() => { /* ignore network errors */ });
  }
}

export function showPairApprovalDialog(pairId: string, deviceInfo: string, remoteAddr: string): void {
  const existing = document.getElementById('pair-approval-dialog');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'pair-approval-dialog';
  overlay.className = 'master-approval-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'master-approval-dialog';

  dialog.innerHTML = `
    <div class="master-approval-icon">
      <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
        <line x1="12" y1="18" x2="12.01" y2="18"/>
      </svg>
    </div>
    <h3>${t('pairApprovalTitle')}</h3>
    <p>${t('pairApprovalMessage')}</p>
    <div class="pair-approval-info">
      <div class="pair-approval-row"><span class="pair-approval-label">${t('pairApprovalDevice')}:</span> ${escapeHtml(deviceInfo)}</div>
      <div class="pair-approval-row"><span class="pair-approval-label">${t('pairApprovalAddress')}:</span> ${escapeHtml(remoteAddr)}</div>
    </div>
  `;

  const buttons = document.createElement('div');
  buttons.className = 'master-approval-buttons';

  const denyBtn = document.createElement('button');
  denyBtn.className = 'master-approval-btn deny';
  denyBtn.textContent = t('pairApprovalDeny');
  denyBtn.onclick = () => {
    respondPairApproval(false, pairId);
    overlay.remove();
    clearTimeout(timer);
  };

  const approveBtn = document.createElement('button');
  approveBtn.className = 'master-approval-btn approve';
  approveBtn.textContent = t('pairApprovalApprove');
  approveBtn.onclick = () => {
    respondPairApproval(true, pairId);
    overlay.remove();
    clearTimeout(timer);
  };

  buttons.appendChild(denyBtn);
  buttons.appendChild(approveBtn);
  dialog.appendChild(buttons);
  overlay.appendChild(dialog);

  // Auto-deny after 30 seconds
  const timer = setTimeout(() => {
    if (document.body.contains(overlay)) {
      respondPairApproval(false, pairId);
      overlay.remove();
    }
  }, 30000);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      clearTimeout(timer);
      respondPairApproval(false, pairId);
      overlay.remove();
    }
  });

  // System notification (dock bounce / taskbar flash)
  void notifyUser({
    id: pairId,
    type: 'pair-request',
    title: t('pairApprovalTitle'),
    body: `${deviceInfo} (${remoteAddr})`,
  });

  document.body.appendChild(overlay);
}

/** Start polling for pending pair requests — covers no-session scenario. */
export function startPairPoller(pollPort: number, pollToken: string): void {
  if (pairPollTimer) return;
  // Periodically clear stale dedup entries (pair requests expire after 90s on backend)
  setInterval(() => handledPairIds.clear(), 5 * 60 * 1000);
  setPairPollTimer(setInterval(async () => {
    try {
      const resp = await fetch(`http://127.0.0.1:${pollPort}/api/pair/pending`, {
        headers: { 'Authorization': `Bearer ${pollToken}` },
      });
      if (!resp.ok) return;
      const data = await resp.json();
      // 服务端返回 {pairs:[{id,device_info,remote_addr}]};此前读 data.requests
      // + req.pair_id 字段全错,这条兜底路径(无会话时的配对弹窗)从未工作过
      for (const req of data.pairs || []) {
        if (!handledPairIds.has(req.id)) {
          handledPairIds.add(req.id);
          showPairApprovalDialog(req.id, req.device_info, req.remote_addr);
        }
      }
    } catch { /* ignore network errors */ }
  }, 3000));
}
