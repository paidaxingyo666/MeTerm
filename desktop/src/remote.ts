import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n';
import { icon } from './icons';
import { escapeHtml } from './status-bar';
import { loadGroupOrder, remoteKey, setConnectionGroup, removeConnectionGroup, getConnectionGroup } from './connection-groups';
import { buildScanPanel } from './remote-scan';
import {
  addRecentRemoteConnection,
  addRemoteConnection,
  hasRemoteToken,
  prepareRemoteCredential,
} from './remote-storage';

export {
  addRecentRemoteConnection,
  addRemoteConnection,
  detectRemoteCredentialMigrationPendingAtStartup,
  loadRecentRemoteConnections,
  hasRemoteToken,
  loadSavedRemoteConnections,
  pruneUnreachableRecentRemotes,
  removeRecentRemoteConnection,
  removeRemoteConnection,
} from './remote-storage';

export interface RemoteServerInfo {
  host: string;
  port: number;
  token: string;
  name?: string;
  secure?: boolean;
  /** Optional SHA-256 TLS leaf certificate pin, stored with the native credential binding. */
  certFp?: string;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const octets = normalized.split('.');
  return octets.length === 4
    && octets[0] === '127'
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

export interface RemoteSession {
  id: string;
  title?: string;
  created_at: string;
  state: string;
  executor_type?: string;
  private?: boolean;
  clients?: number;
  connected_clients?: number;
}

type RemoteConnectHandler = (info: RemoteServerInfo, sessionId: string) => void;
let connectHandler: RemoteConnectHandler | null = null;

export function setRemoteConnectHandler(handler: RemoteConnectHandler): void {
  connectHandler = handler;
}

export function parseShareUrl(url: string, externalToken?: string): RemoteServerInfo {
  let host: string;
  let port: number;
  let token = '';
  let secure: boolean | undefined;

  const rawQuery = url.includes('?') ? url.slice(url.indexOf('?') + 1).split('#', 1)[0] : '';
  const hasCredentialQuery = Array.from(new URLSearchParams(rawQuery).keys()).some((key) =>
    ['token', 'access_token', 'authorization'].includes(key.toLowerCase()),
  );
  if (hasCredentialQuery) {
    throw new Error(t('remoteCredentialInUrlRejected'));
  }

  let parsed: URL | undefined;
  try {
    const candidate = new URL(url);
    if (['http:', 'https:', 'ws:', 'wss:'].includes(candidate.protocol)) {
      parsed = candidate;
    }
  } catch { /* handled as a bare host below */ }

  // Parse full URLs, but never import credentials from URI components.
  if (parsed) {
    if (parsed.username || parsed.password) {
      throw new Error(t('remoteCredentialInUrlRejected'));
    }
    host = parsed.hostname;
    port = parseInt(parsed.port) || 8080;
    secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  } else {
    // Bare LAN addresses default to TLS; localhost keeps the existing HTTP path.
    const trimmed = url.replace(/\/+$/, '');
    const parts = trimmed.split(':');
    host = parts[0] || '';
    port = parseInt(parts[1]) || 8080;
    secure = !isLoopbackHost(host);
  }

  // Use external token if URL didn't contain one
  if (!token && externalToken) {
    token = externalToken;
  }

  if (!host) throw new Error('Invalid address: missing host');
  return { host, port, token, secure };
}

export function parsePairingJson(json: string): RemoteServerInfo {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error(t('remoteInvalidJson'));
  }
  if (data && typeof data === 'object' && ((data as { v?: unknown }).v === 1 || (data as { v?: unknown }).v === 2)) {
    throw new Error(t('remoteSecurePairingUnavailable'));
  }
  throw new Error(t('remoteInvalidJson'));
}

/** Error subclass for 401 responses — token expired / revoked. */
export class TokenExpiredError extends Error {
  constructor(msg: string) { super(msg); this.name = 'TokenExpiredError'; }
}

export async function fetchRemoteSessions(info: RemoteServerInfo): Promise<RemoteSession[]> {
  await prepareRemoteCredential(info);
  let raw: string;
  try {
    raw = await invoke<string>('remote_list_sessions', { host: info.host, port: info.port });
  } catch (error) {
    if (String(error).includes('REMOTE_AUTH_EXPIRED')) {
      throw new TokenExpiredError(t('remoteTokenExpired'));
    }
    throw error;
  }
  const data = JSON.parse(raw);
  const sessions = data?.sessions ?? data;
  return Array.isArray(sessions) ? sessions : [];
}

/**
 * Standalone pairing request — reusable from card popup and connect dialog.
 * Calls onStatus for progress updates.
 * Returns the new token on success, or null if denied/cancelled/timeout.
 */
export async function requestPairing(
  host: string,
  port: number,
  secure: boolean | undefined,
  signal: AbortSignal,
): Promise<string | null> {
  void host;
  void port;
  void secure;
  if (signal.aborted) return null;
  throw new Error(t('remoteSecurePairingUnavailable'));
}

function closeRemoteModal(): void {
  document.querySelector('.remote-modal-overlay')?.remove();
}

export function showRemoteConnectDialog(): void {
  closeRemoteModal();

  const overlay = document.createElement('div');
  overlay.className = 'remote-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'remote-modal';

  // Header
  const header = document.createElement('div');
  header.className = 'remote-modal-header';
  header.innerHTML = `<div><h3>${t('remoteConnectTitle')}</h3><p class="remote-subtitle">${t('remoteConnectSubtitle')}</p></div>`;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'ssh-modal-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.onclick = closeRemoteModal;
  header.appendChild(closeBtn);

  // Tabs
  const tabs = document.createElement('div');
  tabs.className = 'remote-tabs';
  const tabDefs = [
    { key: 'url', label: t('remoteTabUrl') },
    { key: 'json', label: t('remoteTabJson') },
    { key: 'scan', label: t('remoteTabScan') },
  ];
  const panels: Record<string, HTMLDivElement> = {};
  const tabBtns: HTMLButtonElement[] = [];

  for (const def of tabDefs) {
    const btn = document.createElement('button');
    btn.className = 'remote-tab';
    btn.textContent = def.label;
    btn.dataset.tab = def.key;
    btn.onclick = () => activateTab(def.key);
    tabs.appendChild(btn);
    tabBtns.push(btn);

    const panel = document.createElement('div');
    panel.className = 'remote-tab-panel';
    panel.dataset.tab = def.key;
    panels[def.key] = panel;
  }

  function activateTab(key: string): void {
    tabBtns.forEach((b) => b.classList.toggle('active', b.dataset.tab === key));
    Object.entries(panels).forEach(([k, el]) => el.classList.toggle('active', k === key));
  }

  // Status area
  const status = document.createElement('div');
  status.className = 'remote-status';

  function showStatus(msg: string, type: 'success' | 'error' | 'info'): void {
    status.textContent = msg;
    status.className = `remote-status remote-status-${type}`;
  }

  // Group selector for remote connections
  const remoteGroupSelect = document.createElement('select');
  remoteGroupSelect.className = 'ssh-select ssh-group-select';
  const remoteNoneOpt = document.createElement('option');
  remoteNoneOpt.value = '';
  remoteNoneOpt.textContent = t('homeGroupUngrouped');
  remoteGroupSelect.appendChild(remoteNoneOpt);
  for (const g of loadGroupOrder()) {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g;
    remoteGroupSelect.appendChild(opt);
  }

  function applyRemoteGroup(info: RemoteServerInfo): void {
    const key = remoteKey(info.host, info.port);
    const grp = remoteGroupSelect.value;
    if (grp) setConnectionGroup(key, grp);
    else removeConnectionGroup(key);
  }

  // Session list area
  const sessionList = document.createElement('div');
  sessionList.className = 'remote-session-list';

  async function renderSessions(sessions: RemoteSession[], info: RemoteServerInfo): Promise<void> {
    sessionList.innerHTML = '';
    if (sessions.length === 0) {
      // Auto-save to home when no sessions
      await addRemoteConnection(info);
      applyRemoteGroup(info);
      document.dispatchEvent(new CustomEvent('remote-connections-changed'));
      sessionList.innerHTML = `<div class="remote-no-sessions">${t('remoteNoSessions')}<div class="remote-saved-hint">${t('remoteSavedToHome')}</div></div>`;
      return;
    }

    // Group selector + save connection button above session list
    const saveRow = document.createElement('div');
    saveRow.className = 'remote-save-row';

    const groupLabel = document.createElement('label');
    groupLabel.className = 'ssh-form-label remote-group-label';
    groupLabel.textContent = t('homeGroupMoveToGroup');
    saveRow.appendChild(groupLabel);
    saveRow.appendChild(remoteGroupSelect);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'ssh-btn ssh-btn-secondary remote-save-btn';
    saveBtn.textContent = t('remoteSaveConnection');
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      try {
        await addRemoteConnection(info);
        applyRemoteGroup(info);
        document.dispatchEvent(new CustomEvent('remote-connections-changed'));
        saveBtn.textContent = t('remoteSavedToHome');
      } catch (error) {
        saveBtn.disabled = false;
        showStatus(`${t('remoteFailed')}: ${String(error)}`, 'error');
      }
    };
    saveRow.appendChild(saveBtn);
    sessionList.appendChild(saveRow);

    const hint = document.createElement('div');
    hint.className = 'remote-session-hint';
    hint.textContent = t('remoteSelectSession');
    sessionList.appendChild(hint);

    for (const session of sessions) {
      const card = document.createElement('div');
      card.className = `remote-session-card${session.private ? ' remote-session-private' : ''}`;
      const titleRow = document.createElement('div');
      titleRow.className = 'remote-session-title';
      if (session.private) {
        titleRow.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg> `;
        titleRow.appendChild(document.createTextNode(session.title || session.id.slice(0, 12)));
      } else {
        titleRow.textContent = session.title || session.id.slice(0, 12);
      }
      const meta = document.createElement('div');
      meta.className = 'remote-session-meta';
      meta.textContent = `${session.executor_type || 'local'} \u00b7 ${session.state}`;
      card.appendChild(titleRow);
      card.appendChild(meta);
      if (session.private) {
        card.onclick = () => {
          void import('@tauri-apps/plugin-dialog').then(({ message: msg }) => {
            void msg(t('sessionPrivateCannotConnect'), { kind: 'warning' });
          });
        };
      } else {
        card.onclick = () => {
          if (connectHandler) {
            connectHandler(info, session.id);
            closeRemoteModal();
          }
        };
      }
      sessionList.appendChild(card);
    }
  }

  async function doConnect(info: RemoteServerInfo): Promise<void> {
    showStatus(t('remoteConnecting'), 'info');
    sessionList.innerHTML = '';
    try {
      const sessions = await fetchRemoteSessions(info);
      const brokeredInfo = { ...info, token: '' };
      showStatus(t('remoteConnected'), 'success');
      await renderSessions(sessions, brokeredInfo);
    } catch (err) {
      showStatus(`${t('remoteFailed')}: ${String(err)}`, 'error');
    }
  }

  // URL panel — vertical layout with address + token fields
  const urlPanel = panels['url'];
  urlPanel.classList.add('remote-url-panel');

  // Address group
  const addrGroup = document.createElement('div');
  addrGroup.className = 'ssh-form-group';
  const addrLabel = document.createElement('label');
  addrLabel.textContent = t('remoteAddressLabel');
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.className = 'ssh-input';
  urlInput.placeholder = t('remoteUrlPlaceholder');
  urlInput.addEventListener('keydown', (e) => e.stopPropagation());
  urlInput.addEventListener('keyup', (e) => e.stopPropagation());
  addrGroup.appendChild(addrLabel);
  addrGroup.appendChild(urlInput);
  urlPanel.appendChild(addrGroup);

  // Token group
  const tokenGroup = document.createElement('div');
  tokenGroup.className = 'ssh-form-group';
  const tokenLabel = document.createElement('label');
  tokenLabel.textContent = t('remoteTokenLabel');
  const tokenInput = document.createElement('input');
  tokenInput.type = 'password';
  tokenInput.className = 'ssh-input';
  tokenInput.placeholder = t('remoteTokenPlaceholder');
  tokenInput.addEventListener('keydown', (e) => e.stopPropagation());
  tokenInput.addEventListener('keyup', (e) => e.stopPropagation());
  tokenGroup.appendChild(tokenLabel);
  tokenGroup.appendChild(tokenInput);

  // Token row: input + pair button + connect button
  const tokenRow = document.createElement('div');
  tokenRow.className = 'remote-token-row';

  const pairBtn = document.createElement('button');
  pairBtn.className = 'ssh-btn ssh-btn-secondary';
  pairBtn.textContent = t('remotePairRequest');
  pairBtn.onclick = () => {
    try {
      const info = parseShareUrl(urlInput.value.trim());
      void startPairing(info.host, info.port, info.secure);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : t('remoteInvalidUrl'), 'error');
    }
  };

  const urlConnectBtn = document.createElement('button');
  urlConnectBtn.className = 'ssh-btn ssh-btn-primary';
  urlConnectBtn.textContent = t('remoteConnectBtn');
  urlConnectBtn.onclick = () => {
    try {
      const info = parseShareUrl(urlInput.value.trim(), tokenInput.value.trim());
      void doConnect(info);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : t('remoteInvalidUrl'), 'error');
    }
  };

  tokenRow.appendChild(tokenInput);
  tokenRow.appendChild(pairBtn);
  tokenRow.appendChild(urlConnectBtn);
  tokenGroup.appendChild(tokenRow);
  urlPanel.appendChild(tokenGroup);

  // Check for a saved native credential without ever filling its plaintext
  // value back into the password field.
  urlInput.addEventListener('blur', async () => {
    if (tokenInput.value) return;
    try {
      const info = parseShareUrl(urlInput.value.trim());
      if (await hasRemoteToken(info)) tokenInput.placeholder = t('remoteSavedToHome');
    } catch { /* ignore parse errors during typing */ }
  });

  // Enter key triggers connect from either input
  const handleEnter = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') urlConnectBtn.click();
  };
  urlInput.addEventListener('keypress', handleEnter);
  tokenInput.addEventListener('keypress', handleEnter);

  // Browser WebViews cannot pin the self-signed v2 certificate for both HTTP
  // and WebSocket traffic. Keep this legacy desktop entry point fail-closed.
  function startPairing(host: string, port: number, secure?: boolean): void {
    void host;
    void port;
    void secure;
    sessionList.innerHTML = '';
    showStatus(t('remoteSecurePairingUnavailable'), 'error');
  }

  // JSON panel
  const jsonPanel = panels['json'];
  const jsonInput = document.createElement('textarea');
  jsonInput.className = 'ssh-input remote-json-input';
  jsonInput.placeholder = t('remoteJsonPlaceholder');
  jsonInput.rows = 5;
  jsonInput.addEventListener('keydown', (e) => e.stopPropagation());
  jsonInput.addEventListener('keyup', (e) => e.stopPropagation());
  jsonInput.addEventListener('keypress', (e) => e.stopPropagation());

  const jsonConnectBtn = document.createElement('button');
  jsonConnectBtn.className = 'ssh-btn ssh-btn-primary';
  jsonConnectBtn.textContent = t('remoteConnectBtn');
  jsonConnectBtn.onclick = () => {
    try {
      const info = parsePairingJson(jsonInput.value.trim());
      void doConnect(info);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : t('remoteInvalidJson'), 'error');
    }
  };

  jsonPanel.appendChild(jsonInput);
  const jsonBtnRow = document.createElement('div');
  jsonBtnRow.className = 'remote-input-row';
  jsonBtnRow.style.justifyContent = 'flex-end';
  jsonBtnRow.appendChild(jsonConnectBtn);
  jsonPanel.appendChild(jsonBtnRow);

  // Scan panel
  const scanPanel = panels['scan'];
  buildScanPanel(scanPanel, showStatus, sessionList, doConnect);

  // Body
  const body = document.createElement('div');
  body.className = 'remote-modal-body';
  body.appendChild(tabs);
  for (const key of Object.keys(panels)) {
    body.appendChild(panels[key]);
  }
  body.appendChild(status);
  body.appendChild(sessionList);

  modal.appendChild(header);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Activate first tab
  activateTab('url');

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeRemoteModal();
  });
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeRemoteModal();
      if (!document.querySelector('.remote-modal-overlay')) {
        document.removeEventListener('keydown', escHandler);
      }
    }
  };
  document.addEventListener('keydown', escHandler);

  // Focus URL input
  requestAnimationFrame(() => urlInput.focus());
}

// --- Remote Edit Dialog ---
export function showRemoteEditDialog(prefill?: RemoteServerInfo, onSave?: (info: RemoteServerInfo) => void): void {
  closeRemoteModal();

  const overlay = document.createElement('div');
  overlay.className = 'remote-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'remote-modal remote-edit-modal';

  const header = document.createElement('div');
  header.className = 'remote-modal-header';
  header.innerHTML = `<h3>${t('remoteEditTitle')}</h3>`;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'ssh-modal-close';
  closeBtn.textContent = '\u00d7';
  closeBtn.onclick = closeRemoteModal;
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.className = 'remote-modal-body';

  const form = document.createElement('div');
  form.className = 'ssh-form';

  // Name
  const nameGroup = document.createElement('div');
  nameGroup.className = 'ssh-form-group';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = t('remoteConnectionName');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'ssh-input';
  nameInput.value = prefill?.name || '';
  nameInput.addEventListener('keydown', (e) => e.stopPropagation());
  nameInput.addEventListener('keyup', (e) => e.stopPropagation());
  nameGroup.appendChild(nameLabel);
  nameGroup.appendChild(nameInput);
  form.appendChild(nameGroup);

  // Host + Port row
  const hostRow = document.createElement('div');
  hostRow.className = 'ssh-form-row';

  const hostGroup = document.createElement('div');
  hostGroup.className = 'ssh-form-group ssh-form-group-flex';
  const hostLabel = document.createElement('label');
  hostLabel.textContent = t('remoteHost');
  const hostInput = document.createElement('input');
  hostInput.type = 'text';
  hostInput.className = 'ssh-input';
  hostInput.value = prefill?.host || '';
  hostInput.placeholder = '192.168.1.10';
  hostInput.addEventListener('keydown', (e) => e.stopPropagation());
  hostInput.addEventListener('keyup', (e) => e.stopPropagation());
  hostGroup.appendChild(hostLabel);
  hostGroup.appendChild(hostInput);

  const portGroup = document.createElement('div');
  portGroup.className = 'ssh-form-group ssh-form-group-port';
  const portLabel = document.createElement('label');
  portLabel.textContent = t('remotePort');
  const portInput = document.createElement('input');
  portInput.type = 'number';
  portInput.className = 'ssh-input';
  portInput.value = String(prefill?.port || 8080);
  portInput.addEventListener('keydown', (e) => e.stopPropagation());
  portInput.addEventListener('keyup', (e) => e.stopPropagation());
  portGroup.appendChild(portLabel);
  portGroup.appendChild(portInput);

  hostRow.appendChild(hostGroup);
  hostRow.appendChild(portGroup);
  form.appendChild(hostRow);

  // Token
  const tokenGroup = document.createElement('div');
  tokenGroup.className = 'ssh-form-group';
  const tokenLabel = document.createElement('label');
  tokenLabel.textContent = t('remoteToken');
  const tokenInput = document.createElement('input');
  tokenInput.type = 'password';
  tokenInput.className = 'ssh-input';
  tokenInput.value = prefill?.token || '';
  tokenInput.addEventListener('keydown', (e) => e.stopPropagation());
  tokenInput.addEventListener('keyup', (e) => e.stopPropagation());
  tokenGroup.appendChild(tokenLabel);
  tokenGroup.appendChild(tokenInput);
  form.appendChild(tokenGroup);

  // Group selector
  const editGroupRow = document.createElement('div');
  editGroupRow.className = 'ssh-form-row ssh-group-row';
  const editGroupLabel = document.createElement('label');
  editGroupLabel.className = 'ssh-form-label';
  editGroupLabel.textContent = t('homeGroupMoveToGroup');
  const editGroupSelect = document.createElement('select');
  editGroupSelect.className = 'ssh-select ssh-group-select';
  const editNoneOpt = document.createElement('option');
  editNoneOpt.value = '';
  editNoneOpt.textContent = t('homeGroupUngrouped');
  editGroupSelect.appendChild(editNoneOpt);
  for (const g of loadGroupOrder()) {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g;
    editGroupSelect.appendChild(opt);
  }
  if (prefill) {
    const currentGrp = getConnectionGroup(remoteKey(prefill.host, prefill.port));
    if (currentGrp) editGroupSelect.value = currentGrp;
  }
  editGroupRow.appendChild(editGroupLabel);
  editGroupRow.appendChild(editGroupSelect);
  form.appendChild(editGroupRow);

  // Buttons
  const btnRow = document.createElement('div');
  btnRow.className = 'ssh-form-actions';
  const spacer = document.createElement('div');
  spacer.style.flex = '1';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'ssh-btn ssh-btn-primary';
  saveBtn.textContent = t('remoteSaveBtn');
  saveBtn.onclick = async () => {
    const info: RemoteServerInfo = {
      host: hostInput.value.trim(),
      port: parseInt(portInput.value) || 8080,
      token: tokenInput.value,
      name: nameInput.value.trim() || undefined,
      secure: prefill?.secure,
      certFp: prefill?.certFp,
    };
    if (!info.host) return;
    saveBtn.disabled = true;
    try {
      await addRemoteConnection(info);
      const key = remoteKey(info.host, info.port);
      const grp = editGroupSelect.value;
      if (grp) setConnectionGroup(key, grp);
      else removeConnectionGroup(key);
      document.dispatchEvent(new CustomEvent('remote-connections-changed'));
      if (onSave) onSave({ ...info, token: '' });
      closeRemoteModal();
    } catch (error) {
      saveBtn.disabled = false;
      saveBtn.title = String(error);
      console.error('[remote] Unable to save credential:', error);
    }
  };
  btnRow.appendChild(spacer);
  btnRow.appendChild(saveBtn);
  form.appendChild(btnRow);

  body.appendChild(form);
  modal.appendChild(header);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeRemoteModal();
  });
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeRemoteModal();
      if (!document.querySelector('.remote-modal-overlay')) {
        document.removeEventListener('keydown', escHandler);
      }
    }
  };
  document.addEventListener('keydown', escHandler);

  requestAnimationFrame(() => nameInput.focus());
}

// --- Card-level session list popup ---
let cardPopupTimer: ReturnType<typeof setInterval> | null = null;

function cleanupCardPopup(): void {
  if (cardPopupTimer) { clearInterval(cardPopupTimer); cardPopupTimer = null; }
}

export function showRemoteCardSessionPopup(anchor: HTMLElement, info: RemoteServerInfo): void {
  // Remove existing popup
  const existing = document.querySelector('.remote-card-popup');
  if (existing) { existing.remove(); cleanupCardPopup(); }

  const popup = document.createElement('div');
  popup.className = 'remote-list-popup remote-card-popup';

  const header = document.createElement('div');
  header.className = 'remote-list-popup-header';
  header.innerHTML = `<span class="remote-list-popup-title">${escapeHtml(info.name || `${info.host}:${info.port}`)}</span>`;

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'remote-list-refresh-btn';
  refreshBtn.type = 'button';
  refreshBtn.title = t('remoteSessionRefresh');
  refreshBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>';
  refreshBtn.onclick = () => { void loadSessions(); };
  header.appendChild(refreshBtn);
  popup.appendChild(header);

  const content = document.createElement('div');
  content.className = 'remote-list-popup-content';
  popup.appendChild(content);

  async function loadSessions(): Promise<void> {
    content.innerHTML = '<div class="remote-list-loading">...</div>';
    try {
      const sessions = await fetchRemoteSessions(info);
      if (sessions.length === 0) {
        content.innerHTML = `<div class="remote-list-empty">${t('remoteNoSessions')}</div>`;
        return;
      }
      const fragments: string[] = [];
      const lockSvg = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>';
      sessions.forEach((s, i) => {
        const stateClass = s.state === 'running' ? 'running' : 'other';
        const label = s.title || s.id.slice(0, 12);
        const privateCls = s.private ? ' remote-list-item-private' : '';
        const lockIcon = s.private ? `<span class="remote-list-lock">${lockSvg}</span>` : '';
        fragments.push(`<div class="remote-list-item${privateCls}" data-sid="${escapeHtml(s.id)}" data-private="${s.private ? '1' : ''}"><span class="remote-list-item-num">${i + 1}</span>${lockIcon}<span class="remote-list-item-id" title="${escapeHtml(label)}">${escapeHtml(label)}</span><span class="remote-list-item-meta">${escapeHtml(s.executor_type || 'local')} · <span class="remote-list-state-${stateClass}">${escapeHtml(s.state)}</span></span></div>`);
      });
      content.innerHTML = fragments.join('');
      content.querySelectorAll('.remote-list-item').forEach((el) => {
        (el as HTMLElement).onclick = () => {
          if ((el as HTMLElement).dataset.private === '1') {
            void import('@tauri-apps/plugin-dialog').then(({ message: msg }) => {
              void msg(t('sessionPrivateCannotConnect'), { kind: 'warning' });
            });
            return;
          }
          const sessionId = (el as HTMLElement).dataset.sid!;
          document.dispatchEvent(new CustomEvent('remote-session-selected', { detail: { info, sessionId } }));
          popup.remove();
          cleanupCardPopup();
        };
      });
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        // Show re-pair UI inline
        content.innerHTML = `<div class="remote-list-error">${escapeHtml(String(err))}</div>`;
        const repairBtn = document.createElement('button');
        repairBtn.className = 'remote-list-repair-btn';
        repairBtn.textContent = t('remoteRepairBtn');
        repairBtn.onclick = () => {
          void startCardRepair();
        };
        content.appendChild(repairBtn);
        // Stop auto-refresh while showing repair UI
        cleanupCardPopup();
      } else {
        content.innerHTML = `<div class="remote-list-error">${escapeHtml(String(err))}</div>`;
      }
    }
  }

  let repairAbort: AbortController | null = null;

  async function startCardRepair(): Promise<void> {
    if (repairAbort) repairAbort.abort();
    repairAbort = new AbortController();
    content.innerHTML = `<div class="remote-list-loading">${escapeHtml(t('remoteRepairWaiting'))}</div>`;
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'remote-list-repair-btn';
    cancelBtn.textContent = t('remotePairCancel');
    cancelBtn.onclick = () => { repairAbort?.abort(); void loadSessions(); };
    content.appendChild(cancelBtn);

    try {
      const newToken = await requestPairing(info.host, info.port, info.secure, repairAbort.signal);
      if (newToken) {
        // Update info with new token and reload sessions
        info = { ...info, token: newToken };
        content.innerHTML = `<div class="remote-list-loading">${escapeHtml(t('remoteRepairApproved'))}</div>`;
        // Restart auto-refresh
        cardPopupTimer = setInterval(() => {
          if (document.querySelector('.remote-card-popup')) {
            void loadSessions();
          } else {
            cleanupCardPopup();
          }
        }, 5000);
        void loadSessions();
      } else {
        content.innerHTML = `<div class="remote-list-error">${escapeHtml(t('remoteRepairDenied'))}</div>`;
        const retryBtn = document.createElement('button');
        retryBtn.className = 'remote-list-repair-btn';
        retryBtn.textContent = t('remoteRepairBtn');
        retryBtn.onclick = () => { void startCardRepair(); };
        content.appendChild(retryBtn);
      }
    } catch (error) {
      if (!repairAbort.signal.aborted) {
        const message = error instanceof Error ? error.message : t('remoteFailed');
        content.innerHTML = `<div class="remote-list-error">${escapeHtml(message)}</div>`;
      }
    }
  }

  // Position popup below anchor card
  const rect = anchor.getBoundingClientRect();
  const popupWidth = 280;
  let left = rect.left + rect.width / 2 - popupWidth / 2;
  if (left < 4) left = 4;
  if (left + popupWidth > window.innerWidth - 4) left = window.innerWidth - popupWidth - 4;

  // Decide: below or above the card
  const spaceBelow = window.innerHeight - rect.bottom;
  if (spaceBelow > 200) {
    popup.style.top = `${rect.bottom + 4}px`;
  } else {
    popup.style.bottom = `${window.innerHeight - rect.top + 4}px`;
  }
  popup.style.left = `${left}px`;

  document.body.appendChild(popup);
  void loadSessions();

  // Auto refresh every 5s
  cardPopupTimer = setInterval(() => {
    if (document.querySelector('.remote-card-popup')) {
      void loadSessions();
    } else {
      cleanupCardPopup();
    }
  }, 5000);

  // Close on outside click
  const closeHandler = (e: MouseEvent) => {
    if (!popup.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) {
      popup.remove();
      cleanupCardPopup();
      document.removeEventListener('click', closeHandler, true);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
}
