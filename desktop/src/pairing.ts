import { invoke } from '@tauri-apps/api/core';
import QRCode from 'qrcode';
import { t } from './i18n';
import { escapeHtml } from './status-bar';

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
