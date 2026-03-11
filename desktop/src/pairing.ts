import { invoke } from '@tauri-apps/api/core';
import QRCode from 'qrcode';
import { t } from './i18n';
import { escapeHtml } from './status-bar';
import { TerminalRegistry } from './terminal';
import { notifyUser } from './notify';
import { port, authToken, handledPairIds, pairPollTimer, setPairPollTimer } from './app-state';

export interface PairingData {
  v: number;
  addrs: string[];
  token: string;
  name: string;
}

export async function getPairingInfo(): Promise<PairingData> {
  const raw = await invoke<string>('get_pairing_info');
  return JSON.parse(raw);
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

  // 渲染 QR 码
  const pairingJson = JSON.stringify(data);
  const canvas = document.createElement('canvas');
  const isDark = document.documentElement.dataset.theme !== 'light';
  QRCode.toCanvas(canvas, pairingJson, {
    width: 200,
    margin: 2,
    color: {
      dark: isDark ? '#ffffff' : '#000000',
      light: isDark ? '#1e1e1e' : '#ffffff',
    },
  }).catch(() => {
    // fallback: 显示文本
    qrContainer.textContent = pairingJson;
  });
  qrContainer.appendChild(canvas);

  // 配对数据（可复制）
  const dataBox = document.createElement('div');
  dataBox.className = 'pairing-data-box';
  const dataText = document.createElement('code');
  dataText.textContent = JSON.stringify(data, null, 2);
  dataBox.appendChild(dataText);
  dialog.appendChild(dataBox);

  // 设备信息
  const info = document.createElement('div');
  info.className = 'pairing-info';
  info.innerHTML = `
    <div class="pairing-info-row"><span>${t('pairingDeviceName')}</span><span>${escapeHtml(data.name)}</span></div>
    <div class="pairing-info-row"><span>${t('pairingAddress')}</span><span>${escapeHtml(data.addrs.join(', '))}</span></div>
  `;
  dialog.appendChild(info);

  // 按钮栏
  const buttons = document.createElement('div');
  buttons.className = 'pairing-buttons';

  // Share link button (web viewer URL)
  const shareLinkBtn = document.createElement('button');
  shareLinkBtn.textContent = t('shareLink');
  shareLinkBtn.className = 'pairing-btn pairing-btn-primary';
  shareLinkBtn.onclick = async () => {
    const addr = data.addrs[0] || 'localhost';
    const port = addr.includes(':') ? addr.split(':')[1] : '8080';
    const host = addr.includes(':') ? addr.split(':')[0] : addr;
    const shareUrl = `http://${host}:${port}/`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      shareLinkBtn.textContent = t('shareLinkCopied');
      setTimeout(() => { shareLinkBtn.textContent = t('shareLink'); }, 2000);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = shareUrl;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      shareLinkBtn.textContent = t('shareLinkCopied');
      setTimeout(() => { shareLinkBtn.textContent = t('shareLink'); }, 2000);
    }
  };
  buttons.appendChild(shareLinkBtn);

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
  buttons.appendChild(copyBtn);

  const closeBtn = document.createElement('button');
  closeBtn.textContent = t('pairingClose');
  closeBtn.className = 'pairing-btn';
  closeBtn.onclick = () => overlay.remove();
  buttons.appendChild(closeBtn);

  dialog.appendChild(buttons);
  overlay.appendChild(dialog);

  // 点击遮罩关闭
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  return overlay;
}

/**
 * 显示配对弹窗
 */
export async function showPairingDialog(): Promise<void> {
  const data = await getPairingInfo();
  const overlay = createPairingDialog(data);
  document.body.appendChild(overlay);
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
      for (const req of data.requests || []) {
        if (!handledPairIds.has(req.pair_id)) {
          handledPairIds.add(req.pair_id);
          showPairApprovalDialog(req.pair_id, req.device_info, req.remote_addr);
        }
      }
    } catch { /* ignore network errors */ }
  }, 3000));
}
