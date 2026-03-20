import { t } from './i18n';
import { icon } from './icons';
import { escapeHtml } from './status-bar';
import { invoke } from '@tauri-apps/api/core';
import { loadGroupOrder, remoteKey, setConnectionGroup, removeConnectionGroup, getConnectionGroup } from './connection-groups';

export interface RemoteServerInfo {
  host: string;
  port: number;
  token: string;
  name?: string;
  secure?: boolean;
}

function remoteHttpBase(info: RemoteServerInfo): string {
  const protocol = info.secure ? 'https' : 'http';
  return `${protocol}://${info.host}:${info.port}`;
}

export function remoteWsBase(info: RemoteServerInfo): string {
  const protocol = info.secure ? 'wss' : 'ws';
  return `${protocol}://${info.host}:${info.port}`;
}

export interface RemoteSession {
  id: string;
  title?: string;
  created_at: string;
  state: string;
  executor_type?: string;
  private?: boolean;
}

// --- Remote connection storage (metadata in localStorage, token in OS keychain) ---
const REMOTE_CONNECTIONS_KEY = 'meterm-remote-connections';
const REMOTE_RECENT_KEY = 'meterm-remote-recent';
const MAX_REMOTE_RECENT = 5;
const REMOTE_KEYCHAIN_SERVICE = 'com.meterm.app.remote';
const REMOTE_KEYCHAIN_SERVICE_OLD = 'com.meterm.dev.remote';

// ─── Secure token storage helpers ───

function remoteKeychainAccount(host: string, port: number): string {
  return `${host}:${port}:token`;
}

async function storeRemoteToken(host: string, port: number, token: string): Promise<void> {
  if (!token) return;
  const cacheKey = `${host}:${port}`;
  // Skip keychain write if cache already has identical token (avoids unnecessary system dialog)
  if (remoteTokenCache.get(cacheKey) === token) return;
  remoteTokenCache.set(cacheKey, token);
  await invoke('store_credential', { service: REMOTE_KEYCHAIN_SERVICE, account: remoteKeychainAccount(host, port), secret: token }).catch(() => {});
}

// In-memory cache + inflight dedup to avoid repeated keychain access (which triggers system dialogs)
// null means "checked but not found" (negative cache)
const remoteTokenCache = new Map<string, string | null>();
const remoteTokenInflight = new Map<string, Promise<string | undefined>>();

export async function loadRemoteToken(host: string, port: number): Promise<string | undefined> {
  const cacheKey = `${host}:${port}`;
  if (remoteTokenCache.has(cacheKey)) {
    const v = remoteTokenCache.get(cacheKey);
    return v ?? undefined;
  }
  // Deduplicate concurrent calls
  const existing = remoteTokenInflight.get(cacheKey);
  if (existing) return existing;
  const promise = (async () => {
    const account = remoteKeychainAccount(host, port);
    try {
      const token = await invoke<string>('get_credential', { service: REMOTE_KEYCHAIN_SERVICE, account });
      remoteTokenCache.set(cacheKey, token || null);
      return token || undefined;
    } catch { /* not found in new service */ }
    // Fallback: old service name (com.meterm.dev.remote → com.meterm.app.remote)
    try {
      const token = await invoke<string>('get_credential', { service: REMOTE_KEYCHAIN_SERVICE_OLD, account });
      if (token) {
        remoteTokenCache.set(cacheKey, token);
        // Migrate to new service in background
        setTimeout(() => {
          invoke('store_credential', { service: REMOTE_KEYCHAIN_SERVICE, account, secret: token })
            .then(() => invoke('delete_credential', { service: REMOTE_KEYCHAIN_SERVICE_OLD, account }).catch(() => {}))
            .catch(() => {});
        }, 3000);
        return token;
      }
    } catch { /* not found */ }
    remoteTokenCache.set(cacheKey, null);
    return undefined;
  })().finally(() => remoteTokenInflight.delete(cacheKey));
  remoteTokenInflight.set(cacheKey, promise);
  return promise;
}

async function deleteRemoteToken(host: string, port: number): Promise<void> {
  remoteTokenCache.delete(`${host}:${port}`);
  await invoke('delete_credential', { service: REMOTE_KEYCHAIN_SERVICE, account: remoteKeychainAccount(host, port) }).catch(() => {});
}

function stripToken(info: RemoteServerInfo): RemoteServerInfo {
  const { token: _t, ...rest } = info;
  return { ...rest, token: '' } as RemoteServerInfo;
}

/** One-time migration: move remote tokens from localStorage to OS keychain */
export async function migrateRemoteCredentials(): Promise<void> {
  const raw = localStorage.getItem(REMOTE_CONNECTIONS_KEY);
  if (raw) {
    try {
      const conns = JSON.parse(raw) as RemoteServerInfo[];
      let migrated = false;
      for (const conn of conns) {
        if (conn.token) {
          await storeRemoteToken(conn.host, conn.port, conn.token);
          migrated = true;
        }
      }
      if (migrated) {
        const stripped = conns.map(stripToken);
        localStorage.setItem(REMOTE_CONNECTIONS_KEY, JSON.stringify(stripped));
        console.log('[security] Remote connection tokens migrated to OS keychain');
      }
    } catch (e) {
      console.warn('[security] Remote migration failed, tokens remain in localStorage:', e);
    }
  }

  // Also strip tokens from recent connections
  const recentRaw = localStorage.getItem(REMOTE_RECENT_KEY);
  if (recentRaw) {
    try {
      const recent = JSON.parse(recentRaw) as RemoteServerInfo[];
      const stripped = recent.map(stripToken);
      localStorage.setItem(REMOTE_RECENT_KEY, JSON.stringify(stripped));
    } catch {}
  }
}

export function loadSavedRemoteConnections(): RemoteServerInfo[] {
  try {
    const raw = localStorage.getItem(REMOTE_CONNECTIONS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function saveSavedRemoteConnections(conns: RemoteServerInfo[]): void {
  const stripped = conns.map(stripToken);
  localStorage.setItem(REMOTE_CONNECTIONS_KEY, JSON.stringify(stripped));
}

export function addRemoteConnection(info: RemoteServerInfo): void {
  // Save token to keychain (async, best-effort)
  storeRemoteToken(info.host, info.port, info.token).catch(() => {});

  const conns = loadSavedRemoteConnections();
  const key = `${info.host}:${info.port}`;
  const existing = conns.findIndex((c) => `${c.host}:${c.port}` === key);
  const stripped = stripToken(info);
  if (existing >= 0) {
    conns[existing] = stripped;
  } else {
    conns.push(stripped);
  }
  saveSavedRemoteConnections(conns);
}

export function removeRemoteConnection(host: string, port: number): void {
  deleteRemoteToken(host, port).catch(() => {});
  const conns = loadSavedRemoteConnections().filter(
    (c) => !(c.host === host && c.port === port),
  );
  saveSavedRemoteConnections(conns);
}

export function loadRecentRemoteConnections(): RemoteServerInfo[] {
  try {
    const raw = localStorage.getItem(REMOTE_RECENT_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function saveRecentRemoteConnections(conns: RemoteServerInfo[]): void {
  // Recent connections: strip tokens (they can be loaded from saved connections' keychain entry)
  const stripped = conns.map(stripToken);
  localStorage.setItem(REMOTE_RECENT_KEY, JSON.stringify(stripped));
}

export function addRecentRemoteConnection(info: RemoteServerInfo): void {
  let recent = loadRecentRemoteConnections();
  recent = recent.filter(
    (c) => !(c.host === info.host && c.port === info.port),
  );
  recent.unshift(stripToken(info));
  if (recent.length > MAX_REMOTE_RECENT) recent.length = MAX_REMOTE_RECENT;
  saveRecentRemoteConnections(recent);
}

export function removeRecentRemoteConnection(host: string, port: number): void {
  const conns = loadRecentRemoteConnections().filter(
    (c) => !(c.host === host && c.port === port),
  );
  saveRecentRemoteConnections(conns);
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

  // Try parsing as full URL first (http://host:port/?token=xxx)
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    port = parseInt(parsed.port) || 8080;
    token = parsed.searchParams.get('token') || '';
    // Preserve explicit scheme choice from user input
    secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  } catch {
    // Fallback: parse as host:port or host (no scheme — default insecure for LAN)
    const trimmed = url.replace(/\/+$/, '');
    const parts = trimmed.split(':');
    host = parts[0] || '';
    port = parseInt(parts[1]) || 8080;
  }

  // Use external token if URL didn't contain one
  if (!token && externalToken) {
    token = externalToken;
  }

  if (!host) throw new Error('Invalid address: missing host');
  return { host, port, token, secure };
}

export function parsePairingJson(json: string): RemoteServerInfo {
  const data = JSON.parse(json);
  if (!data || data.v !== 1 || !Array.isArray(data.addrs) || !data.token) {
    throw new Error('Invalid pairing JSON');
  }
  const firstAddr = data.addrs[0] || '';
  const parts = firstAddr.split(':');
  const host = parts[0] || '';
  const port = parseInt(parts[1]) || 8080;
  if (!host) throw new Error('No address found in pairing data');
  return { host, port, token: data.token, name: data.name };
}

export async function fetchRemoteSessions(info: RemoteServerInfo): Promise<RemoteSession[]> {
  // Load token from keychain if not present in info (e.g., connecting from saved/recent card)
  let token = info.token;
  if (!token) {
    token = await loadRemoteToken(info.host, info.port) || '';
  }
  const url = `${remoteHttpBase(info)}/api/sessions`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  const data = await resp.json();
  const sessions = data?.sessions ?? data;
  return Array.isArray(sessions) ? sessions : [];
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

  function renderSessions(sessions: RemoteSession[], info: RemoteServerInfo): void {
    sessionList.innerHTML = '';
    if (sessions.length === 0) {
      // Auto-save to home when no sessions
      addRemoteConnection(info);
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
    saveBtn.onclick = () => {
      addRemoteConnection(info);
      applyRemoteGroup(info);
      document.dispatchEvent(new CustomEvent('remote-connections-changed'));
      saveBtn.textContent = t('remoteSavedToHome');
      saveBtn.disabled = true;
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
      showStatus(t('remoteConnected'), 'success');
      renderSessions(sessions, info);
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

  let pairingAbort: AbortController | null = null;

  const pairBtn = document.createElement('button');
  pairBtn.className = 'ssh-btn ssh-btn-secondary';
  pairBtn.textContent = t('remotePairRequest');
  pairBtn.onclick = () => {
    try {
      const info = parseShareUrl(urlInput.value.trim());
      void startPairing(info.host, info.port, info.secure);
    } catch {
      showStatus(t('remoteInvalidUrl'), 'error');
    }
  };

  const urlConnectBtn = document.createElement('button');
  urlConnectBtn.className = 'ssh-btn ssh-btn-primary';
  urlConnectBtn.textContent = t('remoteConnectBtn');
  urlConnectBtn.onclick = () => {
    try {
      const info = parseShareUrl(urlInput.value.trim(), tokenInput.value.trim());
      if (!info.token) {
        // No token — start pairing flow instead of showing error
        void startPairing(info.host, info.port, info.secure);
        return;
      }
      void doConnect(info);
    } catch {
      showStatus(t('remoteInvalidUrl'), 'error');
    }
  };

  tokenRow.appendChild(tokenInput);
  tokenRow.appendChild(pairBtn);
  tokenRow.appendChild(urlConnectBtn);
  tokenGroup.appendChild(tokenRow);
  urlPanel.appendChild(tokenGroup);

  // Auto-load token from keychain when address loses focus
  urlInput.addEventListener('blur', async () => {
    if (tokenInput.value) return;
    try {
      const info = parseShareUrl(urlInput.value.trim());
      if (info.token) {
        tokenInput.value = info.token;
      } else {
        const saved = await loadRemoteToken(info.host, info.port);
        if (saved) tokenInput.value = saved;
      }
    } catch { /* ignore parse errors during typing */ }
  });

  // Enter key triggers connect from either input
  const handleEnter = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') urlConnectBtn.click();
  };
  urlInput.addEventListener('keypress', handleEnter);
  tokenInput.addEventListener('keypress', handleEnter);

  // Pairing flow
  async function startPairing(host: string, port: number, secure?: boolean): Promise<void> {
    // Cancel any previous pairing
    if (pairingAbort) pairingAbort.abort();
    pairingAbort = new AbortController();
    const signal = pairingAbort.signal;

    // Disable buttons during pairing
    pairBtn.textContent = t('remotePairCancel');
    pairBtn.onclick = () => {
      pairingAbort?.abort();
      resetPairBtn();
    };
    urlConnectBtn.disabled = true;
    showStatus(t('remotePairing'), 'info');
    sessionList.innerHTML = '';

    try {
      const baseUrl = remoteHttpBase({ host, port, token: '', secure });
      // Step 1: Create pairing request
      let createResp: Response;
      try {
        createResp = await fetch(`${baseUrl}/api/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_info: 'MeTerm Desktop' }),
          signal,
        });
      } catch (fetchErr) {
        // CORS error or network error — server may not support pairing API
        showStatus(t('remoteInvalidUrl'), 'error');
        tokenInput.focus();
        resetPairBtn();
        return;
      }
      if (!createResp.ok) {
        const errText = await createResp.text();
        showStatus(`${t('remoteFailed')}: ${errText}`, 'error');
        resetPairBtn();
        return;
      }
      const { pair_id, secret } = await createResp.json();

      // Step 2: Poll for approval (every 2s, max 60s)
      const maxAttempts = 30;
      for (let i = 0; i < maxAttempts; i++) {
        if (signal.aborted) return;
        await new Promise((r) => setTimeout(r, 2000));
        if (signal.aborted) return;

        const pollResp = await fetch(`${baseUrl}/api/pair/${pair_id}?secret=${encodeURIComponent(secret)}`, { signal });
        if (!pollResp.ok) continue;
        const result = await pollResp.json();

        if (result.status === 'approved' && result.token) {
          // Success! Fill token and connect
          tokenInput.value = result.token;
          showStatus(t('remotePairApproved'), 'success');
          resetPairBtn();
          // Store token and connect
          const info: RemoteServerInfo = { host, port, token: result.token, secure };
          await storeRemoteToken(host, port, result.token);
          void doConnect(info);
          return;
        } else if (result.status === 'denied') {
          showStatus(t('remotePairDenied'), 'error');
          resetPairBtn();
          return;
        } else if (result.status === 'expired') {
          showStatus(t('remotePairTimeout'), 'error');
          resetPairBtn();
          return;
        }
        // Still pending, continue polling
      }

      // Timed out
      showStatus(t('remotePairTimeout'), 'error');
      resetPairBtn();
    } catch (err) {
      if (signal.aborted) {
        showStatus('', 'info');
      } else {
        showStatus(`${t('remoteFailed')}: ${String(err)}`, 'error');
      }
      resetPairBtn();
    }
  }

  function resetPairBtn(): void {
    pairBtn.textContent = t('remotePairRequest');
    pairBtn.onclick = () => {
      try {
        const info = parseShareUrl(urlInput.value.trim());
        void startPairing(info.host, info.port, info.secure);
      } catch {
        showStatus(t('remoteInvalidUrl'), 'error');
      }
    };
    urlConnectBtn.disabled = false;
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
    } catch {
      showStatus(t('remoteInvalidJson'), 'error');
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

  // Load token from keychain asynchronously if editing existing connection
  if (prefill && !prefill.token) {
    void loadRemoteToken(prefill.host, prefill.port).then((token) => {
      if (token) {
        const tokenEl = form.querySelector('input[type="password"]') as HTMLInputElement | null;
        if (tokenEl && !tokenEl.value) tokenEl.value = token;
      }
    });
  }

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
  saveBtn.onclick = () => {
    const info: RemoteServerInfo = {
      host: hostInput.value.trim(),
      port: parseInt(portInput.value) || 8080,
      token: tokenInput.value,
      name: nameInput.value.trim() || undefined,
      secure: prefill?.secure,
    };
    if (!info.host) return;
    addRemoteConnection(info);
    const key = remoteKey(info.host, info.port);
    const grp = editGroupSelect.value;
    if (grp) setConnectionGroup(key, grp);
    else removeConnectionGroup(key);
    document.dispatchEvent(new CustomEvent('remote-connections-changed'));
    if (onSave) onSave(info);
    closeRemoteModal();
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
      content.innerHTML = `<div class="remote-list-error">${escapeHtml(String(err))}</div>`;
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

// --- LAN Scan Panel ---

interface ScanService {
  name: string;
  host: string;
  port: number;
}

// Radar/WiFi search SVG icon (16x16)
const SCAN_SVG = '<svg class="remote-scan-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2"/><path d="M4.93 4.93a5 5 0 0 1 6.14 0"/><path d="M11.07 11.07a5 5 0 0 1-6.14 0"/><path d="M2.81 2.81a8 8 0 0 1 10.38 0"/><path d="M13.19 13.19a8 8 0 0 1-10.38 0"/></svg>';

function buildScanPanel(
  container: HTMLElement,
  showStatus: (msg: string, type: 'success' | 'error' | 'info') => void,
  sessionList: HTMLElement,
  doConnect: (info: RemoteServerInfo) => Promise<void>,
): void {
  const panel = document.createElement('div');
  panel.className = 'remote-scan-panel';

  // Results area (top)
  const results = document.createElement('div');
  results.className = 'remote-scan-results';
  panel.appendChild(results);

  // Footer area (below results, for rescan button + status)
  const footer = document.createElement('div');
  footer.className = 'remote-scan-footer';
  footer.style.display = 'none';
  panel.appendChild(footer);

  let scanAbort: AbortController | null = null;
  let isScanning = false;

  function createScanButton(small: boolean): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = small ? 'remote-scan-trigger small' : 'remote-scan-trigger';
    btn.innerHTML = `${SCAN_SVG}<span>${small ? t('remoteRescan') : t('remoteScanLan')}</span>`;
    btn.onclick = () => {
      if (isScanning) {
        scanAbort?.abort();
        resetScanUI();
      } else {
        void startScan();
      }
    };
    return btn;
  }

  // Initial state: empty state with centered scan button
  function showEmptyState(): void {
    results.innerHTML = '';
    footer.style.display = 'none';
    const emptyState = document.createElement('div');
    emptyState.className = 'remote-scan-empty-state';
    emptyState.appendChild(createScanButton(false));
    results.appendChild(emptyState);
  }

  showEmptyState();

  async function startScan(): Promise<void> {
    scanAbort?.abort();
    scanAbort = new AbortController();
    isScanning = true;

    // Show scanning state
    results.innerHTML = '';
    footer.style.display = 'none';
    const scanningState = document.createElement('div');
    scanningState.className = 'remote-scan-empty-state';
    const scanningBtn = document.createElement('button');
    scanningBtn.className = 'remote-scan-trigger scanning';
    scanningBtn.innerHTML = `${SCAN_SVG}<span>${t('remoteScanScanning')}</span>`;
    scanningBtn.onclick = () => {
      scanAbort?.abort();
      resetScanUI();
    };
    scanningState.appendChild(scanningBtn);
    results.appendChild(scanningState);

    try {
      const { port, token } = await invoke<{ port: number; token: string }>('get_meterm_connection_info');

      const resp = await fetch(`http://127.0.0.1:${port}/api/discover?timeout=5`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: scanAbort.signal,
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }

      const data = await resp.json();
      const services: ScanService[] = data.services || [];

      if (services.length === 0) {
        results.innerHTML = '';
        const emptyMsg = document.createElement('div');
        emptyMsg.className = 'remote-scan-empty';
        emptyMsg.textContent = t('remoteScanEmpty');
        results.appendChild(emptyMsg);

        // Show rescan button in footer
        footer.innerHTML = '';
        footer.style.display = '';
        footer.appendChild(createScanButton(true));
      } else {
        results.innerHTML = '';
        for (const svc of services) {
          renderScanCard(results, svc, showStatus, sessionList, doConnect);
        }

        // Show footer with rescan button + status
        footer.innerHTML = '';
        footer.style.display = '';
        footer.appendChild(createScanButton(true));
        const statusSpan = document.createElement('span');
        statusSpan.className = 'remote-scan-status';
        statusSpan.textContent = t('remoteScanFound').replace('{count}', String(services.length));
        footer.appendChild(statusSpan);
      }
    } catch (err) {
      if (scanAbort?.signal.aborted) {
        showEmptyState();
        return;
      }
      const errMsg = String(err);
      results.innerHTML = '';
      const errDiv = document.createElement('div');
      errDiv.className = 'remote-scan-empty';
      if (errMsg.includes('not running') || errMsg.includes('token not ready')) {
        errDiv.textContent = t('remoteScanNoLocalServer');
      } else {
        errDiv.textContent = `${t('remoteScanError')}: ${errMsg}`;
      }
      results.appendChild(errDiv);

      footer.innerHTML = '';
      footer.style.display = '';
      footer.appendChild(createScanButton(true));
    } finally {
      isScanning = false;
    }
  }

  function resetScanUI(): void {
    isScanning = false;
    showEmptyState();
  }

  container.appendChild(panel);
}

function renderScanCard(
  container: HTMLElement,
  svc: ScanService,
  showStatus: (msg: string, type: 'success' | 'error' | 'info') => void,
  sessionList: HTMLElement,
  doConnect: (info: RemoteServerInfo) => Promise<void>,
): void {
  const card = document.createElement('div');
  card.className = 'remote-scan-card';

  const info = document.createElement('div');
  info.className = 'remote-scan-card-info';

  const name = document.createElement('div');
  name.className = 'remote-scan-card-name';
  name.textContent = svc.name;

  const addr = document.createElement('div');
  addr.className = 'remote-scan-card-addr';
  addr.textContent = `${svc.host}:${svc.port}`;

  info.appendChild(name);
  info.appendChild(addr);
  card.appendChild(info);

  const badge = document.createElement('span');
  badge.className = 'remote-scan-card-badge verifying';
  badge.textContent = t('remoteScanVerifying');
  card.appendChild(badge);

  const connectBtn = document.createElement('button');
  connectBtn.className = 'ssh-btn ssh-btn-primary';
  connectBtn.textContent = t('remoteScanConnect');
  connectBtn.disabled = true;
  card.appendChild(connectBtn);

  container.appendChild(card);

  // Async verify via /api/ping
  verifyScanService(svc, badge, connectBtn);

  connectBtn.onclick = () => {
    // Try loading saved token first, otherwise start pairing
    void (async () => {
      const savedToken = await loadRemoteToken(svc.host, svc.port);
      if (savedToken) {
        void doConnect({ host: svc.host, port: svc.port, token: savedToken, name: svc.name });
      } else {
        // Start pairing flow: show in URL tab context
        showStatus(t('remotePairing'), 'info');
        sessionList.innerHTML = '';
        startScanPairing(svc, showStatus, doConnect);
      }
    })();
  };
}

async function verifyScanService(
  svc: ScanService,
  badge: HTMLElement,
  connectBtn: HTMLButtonElement,
): Promise<void> {
  try {
    const resp = await fetch(`${remoteHttpBase({ host: svc.host, port: svc.port, token: '' })}/api/ping`, {
      signal: AbortSignal.timeout(3000),
    });
    const data = await resp.json();
    if (data.service === 'meterm') {
      badge.className = 'remote-scan-card-badge verified';
      badge.textContent = t('remoteScanVerified');
      connectBtn.disabled = false;
    } else {
      badge.className = 'remote-scan-card-badge failed';
      badge.textContent = t('remoteScanUnreachable');
    }
  } catch {
    badge.className = 'remote-scan-card-badge failed';
    badge.textContent = t('remoteScanUnreachable');
  }
}

async function startScanPairing(
  svc: ScanService,
  showStatus: (msg: string, type: 'success' | 'error' | 'info') => void,
  doConnect: (info: RemoteServerInfo) => Promise<void>,
): Promise<void> {
  const abort = new AbortController();
  const { signal } = abort;

  // Auto-abort when dialog is closed (overlay removed from DOM)
  const checkAlive = setInterval(() => {
    if (!document.querySelector('.remote-modal-overlay')) {
      abort.abort();
      clearInterval(checkAlive);
    }
  }, 500);

  const baseUrl = remoteHttpBase({ host: svc.host, port: svc.port, token: '' });
  try {
    const createResp = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_info: 'MeTerm Desktop' }),
      signal,
    });
    if (!createResp.ok) {
      showStatus(`${t('remoteFailed')}: ${await createResp.text()}`, 'error');
      return;
    }
    const { pair_id, secret } = await createResp.json();

    // Poll for approval
    for (let i = 0; i < 30; i++) {
      if (signal.aborted) return;
      await new Promise((r) => setTimeout(r, 2000));
      if (signal.aborted) return;
      const pollResp = await fetch(
        `${baseUrl}/api/pair/${pair_id}?secret=${encodeURIComponent(secret)}`,
        { signal },
      );
      if (!pollResp.ok) continue;
      const result = await pollResp.json();

      if (result.status === 'approved' && result.token) {
        showStatus(t('remotePairApproved'), 'success');
        await storeRemoteToken(svc.host, svc.port, result.token);
        void doConnect({ host: svc.host, port: svc.port, token: result.token, name: svc.name });
        return;
      } else if (result.status === 'denied') {
        showStatus(t('remotePairDenied'), 'error');
        return;
      } else if (result.status === 'expired') {
        showStatus(t('remotePairTimeout'), 'error');
        return;
      }
    }
    showStatus(t('remotePairTimeout'), 'error');
  } catch (err) {
    if (!signal.aborted) {
      showStatus(`${t('remoteFailed')}: ${String(err)}`, 'error');
    }
  } finally {
    clearInterval(checkAlive);
  }
}
