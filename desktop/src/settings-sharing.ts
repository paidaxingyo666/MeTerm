import { escapeHtml } from './status-bar';
import { t } from './i18n';
import { invoke } from '@tauri-apps/api/core';
import { loadSettings, saveSettings } from './themes';
import { listen } from '@tauri-apps/api/event';
import { confirm } from '@tauri-apps/plugin-dialog';
import { getPairingInfo } from './pairing';
import QRCode from 'qrcode';

const ALIAS_KEY = 'meterm-device-aliases';

export function getDeviceAlias(ip: string): string {
  try {
    const map = JSON.parse(localStorage.getItem(ALIAS_KEY) || '{}');
    return map[ip] || '';
  } catch { return ''; }
}

export function setDeviceAlias(ip: string, alias: string): void {
  try {
    const map = JSON.parse(localStorage.getItem(ALIAS_KEY) || '{}');
    if (alias) { map[ip] = alias; } else { delete map[ip]; }
    localStorage.setItem(ALIAS_KEY, JSON.stringify(map));
  } catch { /* ignore */ }
}

function deviceDisplayName(ip: string, serverName?: string): string {
  const alias = getDeviceAlias(ip);
  if (alias) return alias;
  if (serverName && serverName !== ip) return serverName;
  return ip;
}

export function createSharingTab(): HTMLDivElement {
  const tabSharing = document.createElement('div');

  const sharingSection = document.createElement('div');
  sharingSection.className = 'settings-section sharing-section';
  sharingSection.innerHTML = `
    <div class="sharing-loading">${t('connecting')}...</div>
  `;
  tabSharing.appendChild(sharingSection);

  // Load pairing data asynchronously
  getPairingInfo().then((data) => {
    sharingSection.innerHTML = '';

    // QR code
    const qrRow = document.createElement('div');
    qrRow.className = 'sharing-qr-row';
    const canvas = document.createElement('canvas');
    canvas.className = 'sharing-qr-canvas';
    QRCode.toCanvas(canvas, JSON.stringify(data), {
      width: 160,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    }).catch(() => {});
    qrRow.appendChild(canvas);

    const infoCol = document.createElement('div');
    infoCol.className = 'sharing-info-col';

    // Device name with edit
    const nameItem = document.createElement('div');
    nameItem.className = 'sharing-info-item';
    const nameLabel = document.createElement('span');
    nameLabel.className = 'sharing-label';
    nameLabel.textContent = t('pairingDeviceName');
    const nameValueRow = document.createElement('span');
    nameValueRow.className = 'sharing-value';
    nameValueRow.style.display = 'inline-flex';
    nameValueRow.style.alignItems = 'center';
    nameValueRow.style.gap = '6px';
    const nameText = document.createElement('span');
    nameText.textContent = data.name;
    const nameEditBtn = document.createElement('button');
    nameEditBtn.className = 'sharing-edit-btn';
    nameEditBtn.title = t('deviceAlias');
    nameEditBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'ssh-input';
    nameInput.style.display = 'none';
    nameInput.style.width = '100%';
    nameInput.style.fontSize = '12px';
    nameInput.value = data.name;
    nameEditBtn.onclick = () => {
      nameText.style.display = 'none';
      nameEditBtn.style.display = 'none';
      nameInput.style.display = '';
      nameInput.focus();
      nameInput.select();
    };
    const saveName = () => {
      const name = nameInput.value.trim() || data.name;
      nameText.textContent = name;
      nameText.style.display = '';
      nameEditBtn.style.display = '';
      nameInput.style.display = 'none';
      const s = loadSettings();
      s.deviceName = name;
      saveSettings(s);
      void invoke('set_device_name', { name });
    };
    nameInput.addEventListener('blur', saveName);
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveName(); });
    nameValueRow.appendChild(nameText);
    nameValueRow.appendChild(nameEditBtn);
    nameItem.appendChild(nameLabel);
    nameItem.appendChild(nameValueRow);
    nameItem.appendChild(nameInput);
    infoCol.appendChild(nameItem);

    // Address
    const addrItem = document.createElement('div');
    addrItem.className = 'sharing-info-item';
    addrItem.innerHTML = `<span class="sharing-label">${t('pairingAddress')}</span><span class="sharing-value">${escapeHtml(data.addrs.join(', '))}</span>`;
    infoCol.appendChild(addrItem);

    qrRow.appendChild(infoCol);
    sharingSection.appendChild(qrRow);

    // Buttons
    const btns = document.createElement('div');
    btns.className = 'sharing-buttons';

    const shareLinkBtn = document.createElement('button');
    shareLinkBtn.className = 'settings-btn settings-btn-primary';
    shareLinkBtn.textContent = t('shareLink');
    shareLinkBtn.onclick = async () => {
      const addr = data.addrs[0] || 'localhost';
      const port = addr.includes(':') ? addr.split(':')[1] : '8080';
      const host = addr.includes(':') ? addr.split(':')[0] : addr;
      const shareUrl = `http://${host}:${port}/`;
      try {
        await navigator.clipboard.writeText(shareUrl);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = shareUrl;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      shareLinkBtn.textContent = t('shareLinkCopied');
      setTimeout(() => { shareLinkBtn.textContent = t('shareLink'); }, 2000);
    };
    btns.appendChild(shareLinkBtn);

    const copyDataBtn = document.createElement('button');
    copyDataBtn.className = 'settings-btn';
    copyDataBtn.textContent = t('pairingCopyData');
    copyDataBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(data));
      } catch {
        const ta = document.createElement('textarea');
        ta.value = JSON.stringify(data);
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      copyDataBtn.textContent = t('pairingCopied');
      setTimeout(() => { copyDataBtn.textContent = t('pairingCopyData'); }, 2000);
    };
    btns.appendChild(copyDataBtn);

    // Toggle button for data preview
    const svgDown = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const svgUp = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 10l4-4 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const toggleDataBtn = document.createElement('button');
    toggleDataBtn.className = 'settings-btn sharing-toggle-data-btn';
    toggleDataBtn.innerHTML = svgDown;
    toggleDataBtn.title = t('pairingCopyData');
    btns.appendChild(toggleDataBtn);
    sharingSection.appendChild(btns);

    // Data preview (collapsed by default)
    const dataPreview = document.createElement('div');
    dataPreview.className = 'sharing-data-preview';
    dataPreview.style.display = 'none';
    const code = document.createElement('code');
    code.textContent = JSON.stringify(data, null, 2);
    dataPreview.appendChild(code);
    sharingSection.appendChild(dataPreview);

    toggleDataBtn.onclick = () => {
      const visible = dataPreview.style.display !== 'none';
      dataPreview.style.display = visible ? 'none' : '';
      toggleDataBtn.innerHTML = visible ? svgDown : svgUp;
    };
  }).catch(() => {
    sharingSection.innerHTML = `<div class="sharing-error">${t('sshFailed')}</div>`;
  });

  // Discoverable toggle (mDNS)
  const discoverSection = document.createElement('div');
  discoverSection.className = 'settings-section settings-section-checkbox';
  const discoverLabel = document.createElement('label');
  const discoverToggle = document.createElement('input');
  discoverToggle.type = 'checkbox';
  discoverToggle.id = 'discoverable-toggle';
  // Restore from localStorage
  discoverToggle.checked = localStorage.getItem('meterm-discoverable') === '1';
  discoverLabel.appendChild(discoverToggle);
  discoverLabel.appendChild(document.createTextNode(` ${t('settingsDiscoverable')}`));
  discoverSection.appendChild(discoverLabel);
  tabSharing.appendChild(discoverSection);

  discoverToggle.onchange = async () => {
    const enabled = discoverToggle.checked;
    localStorage.setItem('meterm-discoverable', enabled ? '1' : '0');
    try {
      await invoke('toggle_lan_sharing', { enabled });
      // Sync tray menu checked state
      await invoke('set_discoverable_state', { checked: enabled });
    } catch (e) {
      console.error('toggle_lan_sharing failed:', e);
    }
  };

  // Listen for tray menu toggle to sync checkbox state
  void listen<{ enabled: boolean }>('menu-toggle-lan-discover', (event) => {
    discoverToggle.checked = event.payload.enabled;
  });

  // -- Token Management --
  const tokenSection = document.createElement('div');
  tokenSection.className = 'settings-section';
  tokenSection.innerHTML = `<div class="settings-section-title">${t('tokenManagement')}</div>`;

  // Current token display
  const tokenRow = document.createElement('div');
  tokenRow.className = 'sharing-token-row';
  const tokenLabel = document.createElement('span');
  tokenLabel.className = 'sharing-label';
  tokenLabel.textContent = t('currentToken');
  const tokenValue = document.createElement('span');
  tokenValue.className = 'sharing-token-value';
  let tokenRevealed = false;
  const maskedToken = '\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF';
  tokenValue.textContent = maskedToken;
  const svgEyeOpen = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.5"/></svg>';
  const svgEyeClosed = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.5"/><line x1="2" y1="14" x2="14" y2="2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  const tokenToggle = document.createElement('button');
  tokenToggle.className = 'settings-btn settings-btn-icon';
  tokenToggle.innerHTML = svgEyeClosed;
  tokenToggle.title = 'Show/Hide';
  tokenToggle.onclick = async () => {
    if (tokenRevealed) {
      tokenValue.textContent = maskedToken;
      tokenRevealed = false;
      tokenToggle.innerHTML = svgEyeClosed;
    } else {
      try {
        const info = await invoke<{ port: number; token: string }>('get_meterm_connection_info');
        tokenValue.textContent = info.token;
        tokenRevealed = true;
        tokenToggle.innerHTML = svgEyeOpen;
      } catch { /* ignore */ }
    }
  };

  // Refresh token button (inline after eye toggle)
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'settings-btn settings-btn-small';
  refreshBtn.textContent = t('refreshToken');
  refreshBtn.onclick = async () => {
    try {
      const raw = await invoke<string>('refresh_token');
      const data = JSON.parse(raw);
      if (data.token && tokenRevealed) {
        tokenValue.textContent = data.token;
      }
      refreshBtn.textContent = t('tokenRefreshed');
      setTimeout(() => { refreshBtn.textContent = t('refreshToken'); }, 2000);
    } catch (e) {
      console.error('refresh_token failed:', e);
    }
  };

  tokenRow.appendChild(tokenLabel);
  tokenRow.appendChild(tokenValue);
  tokenRow.appendChild(tokenToggle);
  tokenRow.appendChild(refreshBtn);
  tokenSection.appendChild(tokenRow);

  // Custom token input
  const customRow = document.createElement('div');
  customRow.className = 'sharing-custom-token-row';
  const customInput = document.createElement('input');
  customInput.type = 'text';
  customInput.className = 'settings-input';
  customInput.placeholder = t('customTokenPlaceholder');
  const customBtn = document.createElement('button');
  customBtn.className = 'settings-btn';
  customBtn.textContent = t('setToken');
  customBtn.onclick = async () => {
    const val = customInput.value.trim();
    if (val.length < 8) {
      customInput.style.borderColor = 'var(--danger)';
      customInput.placeholder = t('customTokenTooShort');
      setTimeout(() => {
        customInput.style.borderColor = '';
        customInput.placeholder = t('customTokenPlaceholder');
      }, 2000);
      return;
    }
    try {
      await invoke('set_custom_token', { token: val });
      customInput.value = '';
      if (tokenRevealed) tokenValue.textContent = val;
      const origText = customBtn.textContent;
      customBtn.textContent = t('tokenSetSuccess');
      setTimeout(() => { customBtn.textContent = origText; }, 2000);
    } catch (e) {
      console.error('set_custom_token failed:', e);
    }
  };
  customRow.appendChild(customInput);
  customRow.appendChild(customBtn);
  tokenSection.appendChild(customRow);

  tabSharing.appendChild(tokenSection);

  // -- Connected Devices --
  const devicesSection = document.createElement('div');
  devicesSection.className = 'settings-section';

  // Header row: title + refresh button + revoke all button
  const devicesTitleRow = document.createElement('div');
  devicesTitleRow.className = 'devices-title-row';

  const devicesTitleEl = document.createElement('span');
  devicesTitleEl.className = 'settings-section-title';
  devicesTitleEl.style.margin = '0';
  devicesTitleEl.textContent = t('connectedDevices');

  const refreshDevicesBtn = document.createElement('button');
  refreshDevicesBtn.className = 'devices-refresh-btn';
  refreshDevicesBtn.type = 'button';
  refreshDevicesBtn.title = t('remoteSessionRefresh');
  refreshDevicesBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>';
  refreshDevicesBtn.onclick = () => { void loadDevices(); };

  const revokeBtn = document.createElement('button');
  revokeBtn.className = 'devices-revoke-btn';
  revokeBtn.textContent = t('revokeAllClients');
  revokeBtn.style.display = 'none';
  revokeBtn.onclick = async () => {
    const confirmed = await confirm(t('confirmRevokeAll'), {
      title: t('revokeAllClients'),
      kind: 'warning',
      okLabel: t('revokeAllClients'),
      cancelLabel: t('hideToTrayTipCancel'),
    });
    if (!confirmed) return;
    try {
      const raw = await invoke<string>('revoke_all_clients');
      const data = JSON.parse(raw);
      revokeBtn.textContent = `${t('revokeSuccess')} (${data.disconnected || 0})`;
      if (data.new_token && tokenRevealed) {
        tokenValue.textContent = data.new_token;
      }
      setTimeout(() => { loadDevices(); loadBans(); }, 800);
    } catch (e) {
      console.error('revoke_all_clients failed:', e);
    }
  };

  devicesTitleRow.appendChild(devicesTitleEl);
  devicesTitleRow.appendChild(refreshDevicesBtn);
  devicesTitleRow.appendChild(revokeBtn);
  devicesSection.appendChild(devicesTitleRow);

  const devicesTable = document.createElement('div');
  devicesTable.className = 'sharing-devices-table';
  devicesTable.innerHTML = `<div class="sharing-empty">${t('noConnectedDevices')}</div>`;
  devicesSection.appendChild(devicesTable);
  tabSharing.appendChild(devicesSection);

  // Load connected devices (IP-aggregated cards)
  const loadDevices = async () => {
    try {
      const raw = await invoke<string>('list_devices');
      const { devices } = JSON.parse(raw);
      if (!devices || devices.length === 0) {
        devicesTable.innerHTML = `<div class="sharing-empty">${t('noConnectedDevices')}</div>`;
        revokeBtn.style.display = 'none';
      } else {
        devicesTable.innerHTML = '';
        revokeBtn.style.display = '';
        for (const device of devices) {
          const card = document.createElement('div');
          card.className = 'device-card';

          const header = document.createElement('div');
          header.className = 'device-card-header';

          const infoArea = document.createElement('div');
          infoArea.className = 'device-card-info';

          const ipEl = document.createElement('span');
          ipEl.className = 'device-card-ip';
          const displayName = deviceDisplayName(device.ip, device.name);
          ipEl.textContent = displayName !== device.ip ? `${displayName} (${device.ip})` : device.ip;

          // Alias edit button
          const aliasBtn = document.createElement('button');
          aliasBtn.className = 'device-card-alias-btn';
          aliasBtn.title = t('deviceAlias');
          aliasBtn.textContent = '✏';
          aliasBtn.onclick = () => {
            const current = getDeviceAlias(device.ip);
            const input = prompt(t('deviceAliasPlaceholder'), current);
            if (input !== null) {
              setDeviceAlias(device.ip, input.trim());
              const newName = deviceDisplayName(device.ip, device.name);
              ipEl.textContent = newName !== device.ip ? `${newName} (${device.ip})` : device.ip;
            }
          };

          const countEl = document.createElement('span');
          countEl.className = 'device-card-count';
          countEl.textContent = device.count > 0
            ? `${device.count} ${t('deviceCardSessions')}`
            : t('devicePairedIdle');

          infoArea.appendChild(ipEl);
          infoArea.appendChild(aliasBtn);
          infoArea.appendChild(countEl);

          const actionsArea = document.createElement('div');
          actionsArea.className = 'device-card-actions';

          if (device.count > 0) {
            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'device-card-toggle';
            toggleBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
            toggleBtn.title = 'Expand/Collapse';
            actionsArea.appendChild(toggleBtn);

            const body = document.createElement('div');
            body.className = 'device-card-body collapsed';
            for (const session of (device.sessions || [])) {
              const sessionTitle = session.session_title || session.session_id.substring(0, 8);
              const row = document.createElement('div');
              row.className = 'device-session-row';
              row.innerHTML = `
                <span class="device-session-title" title="${escapeHtml(sessionTitle)}">${escapeHtml(sessionTitle)}</span>
                <span class="device-session-role">${escapeHtml(session.role)}</span>
                <button class="device-session-kick" data-sid="${escapeHtml(session.session_id)}" data-cid="${escapeHtml(session.id)}">&times;</button>
              `;
              body.appendChild(row);
            }

            toggleBtn.onclick = (e) => {
              e.stopPropagation();
              body.classList.toggle('collapsed');
              toggleBtn.classList.toggle('expanded');
            };

            card.appendChild(header);
            card.appendChild(body);

            // Bind kick buttons for individual sessions
            body.querySelectorAll('.device-session-kick').forEach(btn => {
              btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const confirmed = await confirm(t('confirmKickClient'), {
                  title: t('kickClient'),
                  kind: 'warning',
                  okLabel: t('kickClient'),
                  cancelLabel: t('hideToTrayTipCancel'),
                });
                if (!confirmed) return;
                const sid = (btn as HTMLElement).dataset.sid!;
                const cid = (btn as HTMLElement).dataset.cid!;
                try {
                  await invoke('kick_client', { sessionId: sid, clientId: cid });
                  const shouldLock = await confirm(t('confirmLockAfterKick'), {
                    title: t('tabMenuLockSession'),
                    kind: 'info',
                    okLabel: t('tabMenuLockSession'),
                    cancelLabel: t('banIpSkip'),
                  });
                  if (shouldLock) {
                    try {
                      await invoke('set_session_private', { sessionId: sid, private: true });
                    } catch (e2) {
                      console.error('set_session_private failed:', e2);
                    }
                  }
                  setTimeout(() => { loadDevices(); loadBans(); }, 800);
                } catch (err) {
                  console.error('kick_client failed:', err);
                }
              });
            });
          } else {
            card.appendChild(header);
          }

          const kickDevBtn = document.createElement('button');
          kickDevBtn.className = 'device-card-kick-btn';
          kickDevBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>';
          kickDevBtn.title = t('banDevice');
          kickDevBtn.onclick = async (e) => {
            e.stopPropagation();
            const confirmed = await confirm(t('banDeviceConfirm'), {
              title: t('banDevice'),
              kind: 'warning',
              okLabel: t('banDevice'),
              cancelLabel: t('hideToTrayTipCancel'),
            });
            if (!confirmed) return;
            try {
              await invoke('kick_device', { ip: device.ip, ban: true });
              setTimeout(() => { loadDevices(); loadBans(); }, 500);
            } catch (err) {
              console.error('kick_device failed:', err);
            }
          };
          actionsArea.appendChild(kickDevBtn);

          header.appendChild(infoArea);
          header.appendChild(actionsArea);

          devicesTable.appendChild(card);
        }
      }
    } catch { /* ignore */ }
  };

  // -- IP Ban List --
  const banSection = document.createElement('div');
  banSection.className = 'settings-section';
  banSection.innerHTML = `<div class="settings-section-title">${t('ipBanList')}</div>`;
  const banTable = document.createElement('div');
  banTable.className = 'sharing-ban-table';
  banTable.innerHTML = `<div class="sharing-empty">${t('noBannedIps')}</div>`;
  banSection.appendChild(banTable);
  tabSharing.appendChild(banSection);

  const loadBans = async () => {
    try {
      const raw = await invoke<string>('list_banned_ips');
      const { banned_ips } = JSON.parse(raw);
      if (!banned_ips || banned_ips.length === 0) {
        banTable.innerHTML = `<div class="sharing-empty">${t('noBannedIps')}</div>`;
      } else {
        banTable.innerHTML = banned_ips.map((b: any) => `
          <div class="sharing-ban-row">
            <span class="sharing-ban-ip">${escapeHtml(b.ip)}</span>
            <span class="sharing-ban-time">${escapeHtml(new Date(b.banned_at).toLocaleString())}</span>
            <button class="settings-btn settings-btn-small" data-ip="${escapeHtml(b.ip)}">${t('unbanIp')}</button>
          </div>
        `).join('');
        banTable.querySelectorAll('button[data-ip]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const ip = (btn as HTMLElement).dataset.ip!;
            try {
              await invoke('unban_ip', { ip });
              loadBans();
            } catch (e) {
              console.error('unban_ip failed:', e);
            }
          });
        });
      }
    } catch { /* ignore */ }
  };

  // Auto-refresh when entering sharing tab
  tabSharing.addEventListener('tab-activated', () => {
    loadDevices();
    loadBans();
  });
  // Initial load (will run after panel visible)
  setTimeout(() => { loadDevices(); loadBans(); }, 500);

  return tabSharing;
}
