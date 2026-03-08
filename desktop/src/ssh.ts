import { invoke } from '@tauri-apps/api/core';
import { t } from './i18n';
import { icon } from './icons';
import { escapeHtml } from './status-bar';
import {
  type RemoteServerInfo,
  loadSavedRemoteConnections,
  removeRemoteConnection,
  loadRecentRemoteConnections,
  removeRecentRemoteConnection,
  showRemoteEditDialog,
  showRemoteCardSessionPopup,
} from './remote';
export interface SSHConnectionConfig {
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'key';
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

type SSHSessionCreateResponse = {
  id: string;
  created_at: string;
  state: string;
  executor_type: string;
};

// Host key verification error from backend (409 Conflict)
interface HostKeyError {
  error: 'host_key_unknown' | 'host_key_mismatch';
  hostname: string;
  fingerprint: string;
  key_type: string;
  message: string;
}

const SSH_CONNECTIONS_KEY = 'meterm-ssh-connections';
const SSH_KEYCHAIN_SERVICE = 'com.meterm.dev.ssh';

// ─── Secure credential storage helpers ───

// In-memory cache + inflight dedup to avoid repeated keychain access (which triggers system dialogs)
type SSHSecrets = { password?: string; passphrase?: string };
const sshSecretsCache = new Map<string, SSHSecrets>();
const sshSecretsInflight = new Map<string, Promise<SSHSecrets>>();
// Track pending delete operations to prevent store/delete race conditions
const sshSecretsPendingDelete = new Map<string, Promise<void>>();

async function storeSSHSecrets(name: string, password?: string, passphrase?: string): Promise<void> {
  const secrets: SSHSecrets = { password, passphrase };
  // Skip keychain write if cache already has identical secrets (avoids unnecessary system dialog)
  const cached = sshSecretsCache.get(name);
  if (cached && cached.password === password && cached.passphrase === passphrase) {
    return;
  }
  sshSecretsCache.set(name, secrets);
  // Wait for any pending delete to complete before storing — prevents SecItemAdd/SecItemUpdate race
  const pending = sshSecretsPendingDelete.get(name);
  if (pending) await pending.catch(() => {});
  // Store as single JSON entry — one keychain item = one system dialog
  try {
    await invoke('store_credential', { service: SSH_KEYCHAIN_SERVICE, account: `${name}:secrets`, secret: JSON.stringify(secrets) });
  } catch (e) {
    console.error('[ssh] Failed to store SSH secrets to keychain:', e);
  }
  // NOTE: Legacy cleanup is handled by migrateSSHCredentials() at startup;
  // no fire-and-forget deletes here to avoid extra keychain dialogs.
}

async function loadSSHSecrets(name: string): Promise<SSHSecrets> {
  if (sshSecretsCache.has(name)) return sshSecretsCache.get(name)!;
  // Deduplicate concurrent calls
  const existing = sshSecretsInflight.get(name);
  if (existing) return existing;
  const promise = (async () => {
    // Try new unified format first (single keychain access)
    try {
      const json = await invoke<string>('get_credential', { service: SSH_KEYCHAIN_SERVICE, account: `${name}:secrets` });
      const result: SSHSecrets = JSON.parse(json);
      sshSecretsCache.set(name, result);
      return result;
    } catch { /* not found or parse error — try legacy format */ }
    // Fallback: legacy separate entries
    const result: SSHSecrets = {};
    try {
      result.password = await invoke<string>('get_credential', { service: SSH_KEYCHAIN_SERVICE, account: `${name}:password` });
    } catch { /* not found */ }
    try {
      result.passphrase = await invoke<string>('get_credential', { service: SSH_KEYCHAIN_SERVICE, account: `${name}:passphrase` });
    } catch { /* not found */ }
    sshSecretsCache.set(name, result);
    // Deferred migration: write unified format in background after a delay
    // to avoid triggering a keychain prompt during the connect flow.
    if (result.password || result.passphrase) {
      setTimeout(() => {
        invoke('store_credential', {
          service: SSH_KEYCHAIN_SERVICE,
          account: `${name}:secrets`,
          secret: JSON.stringify(result),
        }).catch(() => {});
      }, 3000);
    }
    return result;
  })();
  sshSecretsInflight.set(name, promise);
  try {
    return await promise;
  } finally {
    sshSecretsInflight.delete(name);
  }
}

async function deleteSSHSecrets(name: string): Promise<void> {
  sshSecretsCache.delete(name);
  // Await all deletes and track the operation — prevents race with subsequent storeSSHSecrets
  const deletePromise = Promise.allSettled([
    invoke('delete_credential', { service: SSH_KEYCHAIN_SERVICE, account: `${name}:secrets` }),
    invoke('delete_credential', { service: SSH_KEYCHAIN_SERVICE, account: `${name}:password` }),
    invoke('delete_credential', { service: SSH_KEYCHAIN_SERVICE, account: `${name}:passphrase` }),
  ]).then(() => {});
  sshSecretsPendingDelete.set(name, deletePromise);
  try {
    await deletePromise;
  } finally {
    sshSecretsPendingDelete.delete(name);
  }
}

function stripSecrets(config: SSHConnectionConfig): SSHConnectionConfig {
  const { password: _p, passphrase: _pp, ...rest } = config;
  return rest as SSHConnectionConfig;
}

/** One-time migration: move secrets from localStorage to OS keychain */
export async function migrateSSHCredentials(): Promise<void> {
  const raw = localStorage.getItem(SSH_CONNECTIONS_KEY);
  if (!raw) return;
  try {
    const conns = JSON.parse(raw) as SSHConnectionConfig[];
    let migrated = false;
    for (const conn of conns) {
      if (conn.password || conn.passphrase) {
        await storeSSHSecrets(conn.name, conn.password, conn.passphrase);
        migrated = true;
      }
    }
    if (migrated) {
      // Re-save with secrets stripped
      const stripped = conns.map(stripSecrets);
      localStorage.setItem(SSH_CONNECTIONS_KEY, JSON.stringify(stripped));
      console.log('[security] SSH credentials migrated to OS keychain');
    }
  } catch (e) {
    console.warn('[security] Migration failed, credentials remain in localStorage:', e);
  }

  // Also migrate recent connections
  const recentRaw = localStorage.getItem(SSH_RECENT_KEY);
  if (!recentRaw) return;
  try {
    const recent = JSON.parse(recentRaw) as SSHConnectionConfig[];
    const stripped = recent.map(stripSecrets);
    localStorage.setItem(SSH_RECENT_KEY, JSON.stringify(stripped));
  } catch {}
}

// ─── Connection storage (metadata in localStorage, secrets in keychain) ───

export function loadSavedConnections(): SSHConnectionConfig[] {
  try {
    const raw = localStorage.getItem(SSH_CONNECTIONS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

export function saveConnections(connections: SSHConnectionConfig[]): void {
  // Strip secrets before saving to localStorage; save each to keychain async
  const stripped = connections.map((c) => {
    if (c.password || c.passphrase) {
      storeSSHSecrets(c.name, c.password, c.passphrase)
        .catch((e) => console.warn('[security] Failed to save SSH secrets:', e));
    }
    return stripSecrets(c);
  });
  localStorage.setItem(SSH_CONNECTIONS_KEY, JSON.stringify(stripped));
}

export function addConnection(config: SSHConnectionConfig): void {
  // Save secrets to keychain (async, best-effort but logged on failure)
  if (config.password || config.passphrase) {
    storeSSHSecrets(config.name, config.password, config.passphrase)
      .catch((e) => console.warn('[security] Failed to save SSH secrets:', e));
  }
  const connections = loadSavedConnections();
  const stripped = stripSecrets(config);
  const existing = connections.findIndex((c) => c.name === config.name);
  if (existing >= 0) {
    connections[existing] = stripped;
  } else {
    connections.push(stripped);
  }
  localStorage.setItem(SSH_CONNECTIONS_KEY, JSON.stringify(connections));
}

export function removeConnection(name: string): void {
  deleteSSHSecrets(name).catch((e) => console.error('[ssh] deleteSSHSecrets failed:', e));
  const connections = loadSavedConnections().filter((c) => c.name !== name);
  localStorage.setItem(SSH_CONNECTIONS_KEY, JSON.stringify(connections));
}

export interface SSHExportData {
  version: 1;
  connections: SSHConnectionConfig[];
  exportedAt: string;
}

export async function exportConnectionsToJSON(): Promise<{ json: string; count: number } | null> {
  const connections = loadSavedConnections();
  if (connections.length === 0) return null;
  // Restore secrets from keychain for export
  const fullConnections = await Promise.all(
    connections.map(async (c) => {
      const secrets = await loadSSHSecrets(c.name);
      return { ...c, password: secrets.password || c.password, passphrase: secrets.passphrase || c.passphrase };
    }),
  );
  const data: SSHExportData = {
    version: 1,
    connections: fullConnections,
    exportedAt: new Date().toISOString(),
  };
  return { json: JSON.stringify(data, null, 2), count: connections.length };
}

export function importConnectionsFromJSON(json: string): { count: number } {
  const data = JSON.parse(json);
  if (!data || data.version !== 1 || !Array.isArray(data.connections)) {
    throw new Error('Invalid format');
  }
  const imported = data.connections as SSHConnectionConfig[];
  const existing = loadSavedConnections();
  let count = 0;
  for (const conn of imported) {
    if (!conn.name || !conn.host || !conn.username) continue;
    // Validate field types and ranges to prevent malformed data injection
    if (typeof conn.name !== 'string' || typeof conn.host !== 'string' || typeof conn.username !== 'string') continue;
    if (conn.name.length > 256 || conn.host.length > 256 || conn.username.length > 128) continue;
    if (conn.port !== undefined && (typeof conn.port !== 'number' || conn.port < 1 || conn.port > 65535)) continue;
    // Save secrets to keychain
    if (conn.password || conn.passphrase) {
      storeSSHSecrets(conn.name, conn.password, conn.passphrase)
        .catch((e) => console.warn('[security] Failed to save imported SSH secrets:', e));
    }
    const stripped = stripSecrets(conn);
    const idx = existing.findIndex((c) => c.name === conn.name);
    if (idx >= 0) {
      existing[idx] = stripped;
    } else {
      existing.push(stripped);
    }
    count++;
  }
  localStorage.setItem(SSH_CONNECTIONS_KEY, JSON.stringify(existing));
  return { count };
}

// --- Recent (history) connections ---
const SSH_RECENT_KEY = 'meterm-ssh-recent';
const MAX_RECENT = 5;

export function loadRecentConnections(): SSHConnectionConfig[] {
  try {
    const raw = localStorage.getItem(SSH_RECENT_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function saveRecentConnections(connections: SSHConnectionConfig[]): void {
  // Recent connections: strip secrets (they can be loaded from saved connections' keychain entry)
  const stripped = connections.map(stripSecrets);
  localStorage.setItem(SSH_RECENT_KEY, JSON.stringify(stripped));
}

export function addRecentConnection(config: SSHConnectionConfig): void {
  let recent = loadRecentConnections();
  // Deduplicate by host+port+username
  recent = recent.filter(
    (c) => !(c.host === config.host && c.port === config.port && c.username === config.username),
  );
  recent.unshift(config);
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  saveRecentConnections(recent);
}

export async function createSSHSession(config: SSHConnectionConfig, trustedFingerprint?: string): Promise<string> {
  // Load secrets from keychain if not present in config (e.g., when connecting from saved/recent)
  let password = config.password;
  let passphrase = config.passphrase;
  const needsKeychain = !password && !passphrase && !!config.name;
  console.log('[ssh] createSSHSession:', { host: config.host, port: config.port, username: config.username, authMethod: config.authMethod, hasPassword: !!password, hasPassphrase: !!passphrase, hasPrivateKey: !!config.privateKey, needsKeychain });
  if (needsKeychain) {
    const secrets = await loadSSHSecrets(config.name);
    password = secrets.password || password;
    passphrase = secrets.passphrase || passphrase;
    console.log('[ssh] keychain loaded:', { hasPassword: !!password, hasPassphrase: !!passphrase });
  }
  const raw = await invoke<string>('create_ssh_session', {
    host: config.host,
    port: config.port,
    username: config.username,
    authMethod: config.authMethod,
    password: password || null,
    privateKey: config.privateKey || null,
    passphrase: passphrase || null,
    trustedFingerprint: trustedFingerprint || null,
  });
  const parsed = JSON.parse(raw);

  // Check for host key verification errors
  if (parsed.error === 'host_key_unknown' || parsed.error === 'host_key_mismatch') {
    const hkErr = parsed as HostKeyError;
    if (hkErr.error === 'host_key_mismatch') {
      throw new Error(t('sshHostKeyMismatchMsg')
        .replace('{hostname}', hkErr.hostname)
        .replace('{fingerprint}', hkErr.fingerprint)
        .replace('{keyType}', hkErr.key_type));
    }
    // Unknown host — ask user to confirm
    const confirmed = await showHostKeyConfirmDialog(hkErr.hostname, hkErr.fingerprint, hkErr.key_type);
    if (!confirmed) {
      throw new Error('Connection cancelled by user');
    }
    // Retry with trusted fingerprint — pass resolved secrets in config to avoid re-loading
    const configWithSecrets = { ...config, password: password || undefined, passphrase: passphrase || undefined };
    return createSSHSession(configWithSecrets, hkErr.fingerprint);
  }

  return (parsed as SSHSessionCreateResponse).id;
}

// Host key confirmation dialog — TOFU (Trust On First Use) flow
function showHostKeyConfirmDialog(hostname: string, fingerprint: string, keyType: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ssh-modal-overlay';
    overlay.style.zIndex = '10001';

    const dialog = document.createElement('div');
    dialog.className = 'ssh-modal';
    dialog.style.maxWidth = '500px';
    dialog.style.width = '500px';

    const title = document.createElement('h3');
    title.textContent = t('sshHostKeyUnknownTitle');
    title.style.marginBottom = '12px';
    dialog.appendChild(title);

    const msg = document.createElement('p');
    msg.textContent = t('sshHostKeyUnknownMsg').replace('{hostname}', hostname);
    msg.style.marginBottom = '12px';
    msg.style.lineHeight = '1.5';
    dialog.appendChild(msg);

    const infoBox = document.createElement('div');
    infoBox.style.cssText = 'background:var(--bg-secondary,#1e1e2e);padding:12px;border-radius:6px;margin-bottom:16px;font-family:monospace;font-size:12px;word-break:break-all;';
    infoBox.innerHTML = `<div style="margin-bottom:4px"><strong>${t('sshHostKeyType')}:</strong> ${escapeHtml(keyType)}</div><div><strong>${t('sshHostKeyFingerprint')}:</strong> ${escapeHtml(fingerprint)}</div>`;
    dialog.appendChild(infoBox);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ssh-btn ssh-btn-secondary';
    cancelBtn.textContent = t('sshUnsavedCancel');
    cancelBtn.onclick = () => { overlay.remove(); resolve(false); };
    btnRow.appendChild(cancelBtn);

    const trustBtn = document.createElement('button');
    trustBtn.className = 'ssh-btn ssh-btn-primary';
    trustBtn.textContent = t('sshHostKeyTrust');
    trustBtn.onclick = () => { overlay.remove(); resolve(true); };
    btnRow.appendChild(trustBtn);

    dialog.appendChild(btnRow);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
  });
}

// Event types for SSH home page
type SSHConnectHandler = (config: SSHConnectionConfig) => void;
let onConnectHandler: SSHConnectHandler | null = null;

export function setSSHConnectHandler(handler: SSHConnectHandler): void {
  onConnectHandler = handler;
}

export async function testSSHConnection(config: SSHConnectionConfig, trustedFingerprint?: string): Promise<{ ok: boolean; error?: string }> {
  // Load secrets from keychain if not present in config
  let password = config.password;
  let passphrase = config.passphrase;
  const needsKeychain = !password && !passphrase && !!config.name;
  console.log('[ssh] testSSHConnection:', { host: config.host, port: config.port, username: config.username, authMethod: config.authMethod, hasPassword: !!password, hasPassphrase: !!passphrase, hasPrivateKey: !!config.privateKey, needsKeychain });
  if (needsKeychain) {
    const secrets = await loadSSHSecrets(config.name);
    password = secrets.password || password;
    passphrase = secrets.passphrase || passphrase;
    console.log('[ssh] keychain loaded:', { hasPassword: !!password, hasPassphrase: !!passphrase });
  }
  const raw = await invoke<string>('test_ssh_connection', {
    host: config.host,
    port: config.port,
    username: config.username,
    authMethod: config.authMethod,
    password: password || null,
    privateKey: config.privateKey || null,
    passphrase: passphrase || null,
    trustedFingerprint: trustedFingerprint || null,
  });
  console.log('[ssh] test result raw:', raw);
  const parsed = JSON.parse(raw);

  // Check for host key verification errors
  if (parsed.error === 'host_key_unknown' || parsed.error === 'host_key_mismatch') {
    const hkErr = parsed as HostKeyError;
    if (hkErr.error === 'host_key_mismatch') {
      return { ok: false, error: t('sshHostKeyMismatchMsg')
        .replace('{hostname}', hkErr.hostname)
        .replace('{fingerprint}', hkErr.fingerprint)
        .replace('{keyType}', hkErr.key_type) };
    }
    // Unknown host — ask user to confirm
    const confirmed = await showHostKeyConfirmDialog(hkErr.hostname, hkErr.fingerprint, hkErr.key_type);
    if (!confirmed) {
      return { ok: false, error: 'Connection cancelled by user' };
    }
    // Retry with trusted fingerprint
    return testSSHConnection(config, hkErr.fingerprint);
  }

  return parsed as { ok: boolean; error?: string };
}

/**
 * Show a dialog when SSH auth fails (e.g. password changed), let user enter
 * new password, and return it. Returns null if user cancels.
 */
export function showAuthFailedDialog(config: SSHConnectionConfig): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ssh-modal-overlay';
    overlay.style.zIndex = '10001';

    const dialog = document.createElement('div');
    dialog.className = 'ssh-modal';
    dialog.style.maxWidth = '420px';

    const title = document.createElement('h3');
    title.textContent = t('sshAuthFailedTitle');
    title.style.margin = '0 0 12px';
    dialog.appendChild(title);

    const msg = document.createElement('p');
    msg.style.cssText = 'margin:0 0 16px;font-size:13px;color:var(--text-secondary);line-height:1.5;';
    msg.textContent = t('sshAuthFailedMsg')
      .replace('{username}', config.username)
      .replace('{host}', config.host);
    dialog.appendChild(msg);

    const pwdInput = document.createElement('input');
    pwdInput.type = 'password';
    pwdInput.className = 'ssh-input';
    pwdInput.autocapitalize = 'off';
    pwdInput.autocomplete = 'off';
    pwdInput.setAttribute('autocorrect', 'off');
    pwdInput.spellcheck = false;
    pwdInput.placeholder = t('sshPassword');
    pwdInput.style.marginBottom = '16px';
    dialog.appendChild(pwdInput);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ssh-btn ssh-btn-secondary';
    cancelBtn.textContent = t('sshUnsavedCancel');
    cancelBtn.onclick = () => { overlay.remove(); resolve(null); };

    const retryBtn = document.createElement('button');
    retryBtn.className = 'ssh-btn ssh-btn-primary';
    retryBtn.textContent = t('sshAuthFailedRetry');
    retryBtn.onclick = () => {
      const pwd = pwdInput.value;
      overlay.remove();
      resolve(pwd || null);
    };

    pwdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') retryBtn.click();
      if (e.key === 'Escape') cancelBtn.click();
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(retryBtn);
    dialog.appendChild(btnRow);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { overlay.remove(); resolve(null); }
    });

    setTimeout(() => pwdInput.focus(), 50);
  });
}

/** Update saved password in keychain for a named connection */
export async function updateSavedPassword(name: string, newPassword: string): Promise<void> {
  await storeSSHSecrets(name, newPassword);
}

function createConnectionForm(
  prefill?: SSHConnectionConfig,
  onSubmit?: (config: SSHConnectionConfig) => void,
): HTMLDivElement {
  const form = document.createElement('div');
  form.className = 'ssh-form';

  // Connection name
  const nameGroup = document.createElement('div');
  nameGroup.className = 'ssh-form-group';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = t('sshConnectionName');
  nameLabel.setAttribute('for', 'ssh-name');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.id = 'ssh-name';
  nameInput.className = 'ssh-input';
  nameInput.autocapitalize = 'off';
  nameInput.autocomplete = 'off';
  nameInput.setAttribute('autocorrect', 'off');
  nameInput.spellcheck = false;
  nameInput.value = prefill?.name || '';
  nameGroup.appendChild(nameLabel);
  nameGroup.appendChild(nameInput);
  form.appendChild(nameGroup);

  // Host + Port row
  const hostRow = document.createElement('div');
  hostRow.className = 'ssh-form-row';

  const hostGroup = document.createElement('div');
  hostGroup.className = 'ssh-form-group ssh-form-group-flex';
  const hostLabel = document.createElement('label');
  hostLabel.textContent = t('sshHost');
  hostLabel.setAttribute('for', 'ssh-host');
  const hostInput = document.createElement('input');
  hostInput.type = 'text';
  hostInput.id = 'ssh-host';
  hostInput.className = 'ssh-input';
  hostInput.autocapitalize = 'off';
  hostInput.autocomplete = 'off';
  hostInput.setAttribute('autocorrect', 'off');
  hostInput.spellcheck = false;
  hostInput.value = prefill?.host || '';
  hostInput.placeholder = '192.168.1.1';
  hostGroup.appendChild(hostLabel);
  hostGroup.appendChild(hostInput);

  const portGroup = document.createElement('div');
  portGroup.className = 'ssh-form-group ssh-form-group-port';
  const portLabel = document.createElement('label');
  portLabel.textContent = t('sshPort');
  portLabel.setAttribute('for', 'ssh-port');
  const portInput = document.createElement('input');
  portInput.type = 'number';
  portInput.id = 'ssh-port';
  portInput.className = 'ssh-input';
  portInput.value = String(prefill?.port || 22);
  portGroup.appendChild(portLabel);
  portGroup.appendChild(portInput);

  hostRow.appendChild(hostGroup);
  hostRow.appendChild(portGroup);
  form.appendChild(hostRow);

  // Username + Credential + Auth toggle row
  const credRow = document.createElement('div');
  credRow.className = 'ssh-form-row';

  const userGroup = document.createElement('div');
  userGroup.className = 'ssh-form-group ssh-form-group-flex';
  const userLabel = document.createElement('label');
  userLabel.textContent = t('sshUsername');
  userLabel.setAttribute('for', 'ssh-username');
  const userInput = document.createElement('input');
  userInput.type = 'text';
  userInput.id = 'ssh-username';
  userInput.className = 'ssh-input';
  userInput.autocapitalize = 'off';
  userInput.autocomplete = 'off';
  userInput.setAttribute('autocorrect', 'off');
  userInput.spellcheck = false;
  userInput.value = prefill?.username || '';
  userInput.placeholder = 'root';
  userGroup.appendChild(userLabel);
  userGroup.appendChild(userInput);

  const credGroup = document.createElement('div');
  credGroup.className = 'ssh-form-group ssh-form-group-flex';

  // Hidden select to store auth method value
  const authSelect = document.createElement('select');
  authSelect.id = 'ssh-authMethod';
  authSelect.style.display = 'none';
  const optPwd = document.createElement('option');
  optPwd.value = 'password';
  const optKey = document.createElement('option');
  optKey.value = 'key';
  authSelect.appendChild(optPwd);
  authSelect.appendChild(optKey);
  authSelect.value = prefill?.authMethod || 'password';

  const credLabel = document.createElement('label');
  credLabel.id = 'ssh-cred-label';
  credLabel.textContent = authSelect.value === 'password' ? t('sshPassword') : t('sshPrivateKey');

  const credInputWrap = document.createElement('div');
  credInputWrap.className = 'ssh-cred-input-wrap';

  const pwdInput = document.createElement('input');
  pwdInput.type = 'password';
  pwdInput.id = 'ssh-password';
  pwdInput.className = 'ssh-input';
  pwdInput.autocapitalize = 'off';
  pwdInput.autocomplete = 'off';
  pwdInput.setAttribute('autocorrect', 'off');
  pwdInput.spellcheck = false;
  pwdInput.value = prefill?.password || '';

  // Password visibility toggle (eye icon)
  const pwdToggleBtn = document.createElement('button');
  pwdToggleBtn.type = 'button';
  pwdToggleBtn.className = 'ssh-pwd-toggle';
  pwdToggleBtn.title = 'Show/Hide';
  const eyeOpenSvg = `<svg class="ssh-pwd-icon ssh-pwd-icon-show" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>`;
  const eyeClosedSvg = `<svg class="ssh-pwd-icon ssh-pwd-icon-hide" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/><line x1="2" y1="14" x2="14" y2="2"/></svg>`;
  pwdToggleBtn.innerHTML = eyeOpenSvg + eyeClosedSvg;
  pwdToggleBtn.addEventListener('click', () => {
    const isHidden = pwdInput.type === 'password';
    pwdInput.type = isHidden ? 'text' : 'password';
    pwdToggleBtn.classList.toggle('is-visible', isHidden);
  });

  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.id = 'ssh-privateKey';
  keyInput.className = 'ssh-input';
  keyInput.autocapitalize = 'off';
  keyInput.autocomplete = 'off';
  keyInput.setAttribute('autocorrect', 'off');
  keyInput.spellcheck = false;
  keyInput.value = prefill?.privateKey || '';
  keyInput.placeholder = '~/.ssh/id_rsa';
  keyInput.style.display = 'none';

  // Auth toggle button with SVG icons
  const authToggleBtn = document.createElement('button');
  authToggleBtn.type = 'button';
  authToggleBtn.className = 'ssh-auth-toggle';
  authToggleBtn.title = authSelect.value === 'password' ? t('sshAuthKey') : t('sshAuthPassword');

  // Password icon (lock)
  const svgPwd = `<svg class="ssh-auth-icon ssh-auth-icon-pwd" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>`;
  // Key icon
  const svgKey = `<svg class="ssh-auth-icon ssh-auth-icon-key" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="10.5" r="2.5"/><path d="M7.5 8.5L12 4m0 0v2.5M12 4H9.5"/></svg>`;
  authToggleBtn.innerHTML = svgPwd + svgKey;

  credInputWrap.appendChild(pwdInput);
  credInputWrap.appendChild(pwdToggleBtn);
  credInputWrap.appendChild(keyInput);
  credInputWrap.appendChild(authToggleBtn);
  credInputWrap.appendChild(authSelect);

  credGroup.appendChild(credLabel);
  credGroup.appendChild(credInputWrap);

  credRow.appendChild(userGroup);
  credRow.appendChild(credGroup);
  form.appendChild(credRow);

  // Toggle auth fields
  const toggleAuth = () => {
    const isPassword = authSelect.value === 'password';
    pwdInput.style.display = isPassword ? '' : 'none';
    pwdToggleBtn.style.display = isPassword ? '' : 'none';
    keyInput.style.display = isPassword ? 'none' : '';
    credLabel.textContent = isPassword ? t('sshPassword') : t('sshPrivateKey');
    authToggleBtn.title = isPassword ? t('sshAuthKey') : t('sshAuthPassword');
    // Toggle icon: show lock for password mode, key for key mode
    authToggleBtn.classList.toggle('is-key', !isPassword);
  };
  toggleAuth();

  authToggleBtn.addEventListener('click', () => {
    authSelect.value = authSelect.value === 'password' ? 'key' : 'password';
    toggleAuth();
  });

  // Status message area
  const statusMsg = document.createElement('div');
  statusMsg.className = 'ssh-form-status';
  statusMsg.id = 'ssh-form-status';
  form.appendChild(statusMsg);

  // Helper to read form values
  const readFormConfig = (): SSHConnectionConfig => ({
    name: (document.getElementById('ssh-name') as HTMLInputElement).value || 'Unnamed',
    host: (document.getElementById('ssh-host') as HTMLInputElement).value,
    port: parseInt((document.getElementById('ssh-port') as HTMLInputElement).value) || 22,
    username: (document.getElementById('ssh-username') as HTMLInputElement).value,
    authMethod: (document.getElementById('ssh-authMethod') as HTMLSelectElement).value as 'password' | 'key',
    password: (document.getElementById('ssh-password') as HTMLInputElement).value,
    privateKey: (document.getElementById('ssh-privateKey') as HTMLInputElement).value,
  });

  const showStatus = (msg: string, type: 'success' | 'error' | 'info') => {
    statusMsg.textContent = msg;
    statusMsg.className = `ssh-form-status ssh-status-${type}`;
  };

  const clearStatus = () => {
    statusMsg.textContent = '';
    statusMsg.className = 'ssh-form-status';
  };

  // Buttons row
  const btnRow = document.createElement('div');
  btnRow.className = 'ssh-form-actions';

  const connectBtn = document.createElement('button');
  connectBtn.className = 'ssh-btn ssh-btn-primary';
  connectBtn.textContent = t('sshConnectBtn');
  connectBtn.onclick = () => {
    const config = readFormConfig();
    console.log('[ssh] connect button clicked, config:', { host: config.host, port: config.port, username: config.username, authMethod: config.authMethod, hasPassword: !!config.password, hasPrivateKey: !!config.privateKey });
    if (!config.host || !config.username) return;
    clearStatus();

    if (onSubmit) {
      onSubmit(config);
    } else if (onConnectHandler) {
      onConnectHandler(config);
    }
  };

  const testBtn = document.createElement('button');
  testBtn.className = 'ssh-btn ssh-btn-test';
  testBtn.textContent = t('sshTestConnection');
  testBtn.onclick = async () => {
    const config = readFormConfig();
    console.log('[ssh] test button clicked, config:', { host: config.host, port: config.port, username: config.username, authMethod: config.authMethod, hasPassword: !!config.password, hasPrivateKey: !!config.privateKey });
    if (!config.host || !config.username) return;

    testBtn.disabled = true;
    testBtn.textContent = t('sshTesting');
    showStatus(t('sshTesting'), 'info');

    try {
      const result = await testSSHConnection(config);
      if (result.ok) {
        showStatus(t('sshTestSuccess'), 'success');
      } else {
        showStatus(`${t('sshTestFailed')}: ${result.error || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showStatus(`${t('sshTestFailed')}: ${String(err)}`, 'error');
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = t('sshTestConnection');
    }
  };

  const connectSaveBtn = document.createElement('button');
  connectSaveBtn.className = 'ssh-btn ssh-btn-primary ssh-btn-connect-save';
  connectSaveBtn.textContent = t('sshConnectAndSave');
  connectSaveBtn.onclick = () => {
    const config = readFormConfig();
    if (!config.host || !config.username) return;
    clearStatus();
    addConnection(config);
    document.dispatchEvent(new CustomEvent('ssh-connections-changed'));
    if (onSubmit) {
      onSubmit(config);
    } else if (onConnectHandler) {
      onConnectHandler(config);
    }
  };

  const saveBtn = document.createElement('button');
  saveBtn.className = 'ssh-btn ssh-btn-secondary';
  saveBtn.textContent = t('sshSaveConnection');
  saveBtn.onclick = () => {
    const config = readFormConfig();
    if (!config.host || !config.username) return;
    addConnection(config);
    clearStatus();
    document.dispatchEvent(new CustomEvent('ssh-connections-changed'));
  };

  const spacer = document.createElement('div');
  spacer.style.flex = '1';

  btnRow.appendChild(testBtn);
  btnRow.appendChild(spacer);
  btnRow.appendChild(connectBtn);
  btnRow.appendChild(connectSaveBtn);
  btnRow.appendChild(saveBtn);
  form.appendChild(btnRow);

  // Dirty tracking: snapshot initial state, track saves
  // Use local element refs (not document.getElementById) since form may not be in DOM yet
  const getSnapshot = () =>
    `${nameInput.value}|${hostInput.value}|${portInput.value}|${userInput.value}|${authSelect.value}|${pwdInput.value}|${keyInput.value}`;
  let savedSnapshot = getSnapshot();

  // Re-snapshot after save
  const origSaveClick = saveBtn.onclick!;
  saveBtn.onclick = (e) => {
    (origSaveClick as (e: MouseEvent) => void).call(saveBtn, e!);
    savedSnapshot = getSnapshot();
  };

  // Expose dirty check on form element
  (form as any).__isDirty = () => getSnapshot() !== savedSnapshot;

  return form;
}

function closeSSHModal(): void {
  document.querySelector('.ssh-modal-overlay')?.remove();
}

export function showSSHModal(prefill?: SSHConnectionConfig): void {
  closeSSHModal();

  const overlay = document.createElement('div');
  overlay.className = 'ssh-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'ssh-modal';

  const header = document.createElement('div');
  header.className = 'ssh-modal-header';
  header.innerHTML = `<h3>${t('sshNewConnection')}</h3>`;

  const formEl = createConnectionForm(prefill, (config) => {
    if (onConnectHandler) {
      onConnectHandler(config);
      closeSSHModal();
    }
  });

  const body = document.createElement('div');
  body.className = 'ssh-modal-body';
  body.appendChild(formEl);

  // Guarded close: check dirty state before closing
  let confirmOpen = false;
  const guardedClose = () => {
    if (confirmOpen) return;
    const isDirty = (formEl as any).__isDirty?.() ?? false;
    if (!isDirty) {
      closeSSHModal();
      return;
    }
    confirmOpen = true;
    // Show inline confirm bar
    const confirmBar = document.createElement('div');
    confirmBar.className = 'ssh-confirm-bar';
    const msgSpan = document.createElement('span');
    msgSpan.className = 'ssh-confirm-msg';
    msgSpan.textContent = t('sshUnsavedConfirm');
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ssh-btn ssh-btn-secondary ssh-btn-sm';
    cancelBtn.textContent = t('sshUnsavedCancel');
    const discardBtn = document.createElement('button');
    discardBtn.className = 'ssh-btn ssh-btn-danger ssh-btn-sm';
    discardBtn.textContent = t('sshUnsavedDiscard');

    cancelBtn.onclick = () => { confirmBar.remove(); confirmOpen = false; };
    discardBtn.onclick = () => { confirmBar.remove(); confirmOpen = false; closeSSHModal(); };

    confirmBar.appendChild(msgSpan);
    confirmBar.appendChild(cancelBtn);
    confirmBar.appendChild(discardBtn);
    modal.appendChild(confirmBar);
  };

  const closeBtn = document.createElement('button');
  closeBtn.className = 'ssh-modal-close';
  closeBtn.textContent = '×';
  closeBtn.onclick = guardedClose;
  header.appendChild(closeBtn);

  modal.appendChild(header);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) guardedClose();
  });
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      guardedClose();
      if (!document.querySelector('.ssh-modal-overlay')) {
        document.removeEventListener('keydown', escHandler);
      }
    }
  };
  document.addEventListener('keydown', escHandler);
}

function showCardContextMenu(event: MouseEvent, conn: SSHConnectionConfig): void {
  document.querySelector('.home-card-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'home-card-menu';
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  const editItem = document.createElement('button');
  editItem.className = 'home-card-menu-item';
  editItem.textContent = t('homeEditConnection');
  editItem.onclick = () => { menu.remove(); showSSHModal(conn); };

  const deleteItem = document.createElement('button');
  deleteItem.className = 'home-card-menu-item danger';
  deleteItem.textContent = t('sshDeleteConnection');
  deleteItem.onclick = () => {
    menu.remove();
    removeConnection(conn.name);
    updateSSHHomeView();
  };

  menu.appendChild(editItem);
  menu.appendChild(deleteItem);
  document.body.appendChild(menu);

  // Reposition if overflows viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 4)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`;

  const cleanup = () => { menu.remove(); document.removeEventListener('click', cleanup, true); };
  document.addEventListener('click', cleanup, true);
}

export function createSSHHomeView(): HTMLDivElement {
  const container = document.createElement('div');
  container.className = 'home-view';
  container.id = 'home-view';

  const content = document.createElement('div');
  content.className = 'home-center';

  // App name
  const appName = document.createElement('h1');
  appName.className = 'home-app-name';
  appName.textContent = t('appName');
  content.appendChild(appName);

  // Buttons row: local + SSH on the same line
  const btnRow = document.createElement('div');
  btnRow.className = 'home-btn-row';

  const localBtn = document.createElement('button');
  localBtn.className = 'home-action-btn home-btn-local';
  localBtn.innerHTML = `<span class="home-btn-icon">${icon('terminal')}</span><span>${t('homeNewLocalSession')}</span>`;
  localBtn.onclick = () => {
    document.dispatchEvent(new CustomEvent('new-local-session'));
  };
  localBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    document.dispatchEvent(new CustomEvent('new-local-session-menu', { detail: { mouseEvent: e, anchor: localBtn } }));
  });

  const sshBtn = document.createElement('button');
  sshBtn.className = 'home-action-btn home-btn-ssh';
  sshBtn.innerHTML = `<span class="home-btn-icon">${icon('ssh')}</span><span>${t('homeNewSSHSession')}</span>`;
  sshBtn.onclick = () => {
    showSSHModal();
  };

  const remoteBtn = document.createElement('button');
  remoteBtn.className = 'home-action-btn home-btn-remote';
  remoteBtn.innerHTML = `<span class="home-btn-icon">${icon('remote')}</span><span>${t('homeRemoteConnect')}</span>`;
  remoteBtn.onclick = () => {
    document.dispatchEvent(new CustomEvent('remote-connect-request'));
  };

  btnRow.appendChild(localBtn);
  btnRow.appendChild(sshBtn);
  btnRow.appendChild(remoteBtn);
  content.appendChild(btnRow);

  // Saved connections area
  const savedSection = document.createElement('div');
  savedSection.className = 'home-saved-section';
  savedSection.id = 'home-saved-section';
  content.appendChild(savedSection);

  // Recent connections area
  const recentSection = document.createElement('div');
  recentSection.className = 'home-saved-section';
  recentSection.id = 'home-recent-section';
  content.appendChild(recentSection);

  container.appendChild(content);
  return container;
}

const CARDS_PER_ROW = 5;
const MAX_VISIBLE_ROWS = 2;

// --- Remote connection cards for home view ---
function showRemoteCardContextMenu(event: MouseEvent, info: RemoteServerInfo, isRecent: boolean): void {
  document.querySelector('.home-card-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'home-card-menu';
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  const editItem = document.createElement('button');
  editItem.className = 'home-card-menu-item';
  editItem.textContent = t('homeEditConnection');
  editItem.onclick = () => { menu.remove(); showRemoteEditDialog(info); };

  const deleteItem = document.createElement('button');
  deleteItem.className = 'home-card-menu-item danger';
  deleteItem.textContent = t('remoteDeleteConnection');
  deleteItem.onclick = () => {
    menu.remove();
    if (isRecent) {
      removeRecentRemoteConnection(info.host, info.port);
    } else {
      removeRemoteConnection(info.host, info.port);
    }
    updateSSHHomeView();
  };

  menu.appendChild(editItem);
  menu.appendChild(deleteItem);
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 4)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`;

  const cleanup = () => { menu.remove(); document.removeEventListener('click', cleanup, true); };
  document.addEventListener('click', cleanup, true);
}

function createRemoteConnectionCard(info: RemoteServerInfo, isRecent: boolean): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'home-connection-card remote-card';

  const name = document.createElement('div');
  name.className = 'home-card-name';
  name.textContent = info.name || info.host;

  const detail = document.createElement('div');
  detail.className = 'home-card-detail';
  detail.textContent = `${info.host}:${info.port}`;

  card.appendChild(name);
  card.appendChild(detail);

  card.onclick = () => {
    showRemoteCardSessionPopup(card, info);
  };

  card.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    showRemoteCardContextMenu(e, info, isRecent);
  };

  return card;
}

function createConnectionCard(conn: SSHConnectionConfig, withContextMenu: boolean): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'home-connection-card';

  const name = document.createElement('div');
  name.className = 'home-card-name';
  name.textContent = conn.name || conn.host;

  const detail = document.createElement('div');
  detail.className = 'home-card-detail';
  detail.textContent = `${conn.username}@${conn.host}:${conn.port}`;

  card.appendChild(name);
  card.appendChild(detail);

  card.onclick = () => {
    if (onConnectHandler) onConnectHandler(conn);
  };

  if (withContextMenu) {
    card.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showCardContextMenu(e, conn);
    };
  }

  return card;
}

export function updateSSHHomeView(): void {
  const savedSection = document.getElementById('home-saved-section');
  const recentSection = document.getElementById('home-recent-section');

  // --- Saved connections ---
  if (savedSection) {
    const sshConnections = loadSavedConnections();
    const remoteConnections = loadSavedRemoteConnections();
    savedSection.innerHTML = '';

    const totalSaved = sshConnections.length + remoteConnections.length;
    if (totalSaved > 0) {
      const title = document.createElement('div');
      title.className = 'home-saved-title';
      title.textContent = t('homeSavedConnections');
      savedSection.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'home-saved-grid';

      const maxVisible = CARDS_PER_ROW * MAX_VISIBLE_ROWS;
      const hasMore = totalSaved > maxVisible;

      let cardIndex = 0;
      sshConnections.forEach((conn) => {
        const card = createConnectionCard(conn, true);
        if (hasMore && cardIndex >= maxVisible) {
          card.classList.add('home-card-overflow');
        }
        grid.appendChild(card);
        cardIndex++;
      });

      remoteConnections.forEach((info) => {
        const card = createRemoteConnectionCard(info, false);
        if (hasMore && cardIndex >= maxVisible) {
          card.classList.add('home-card-overflow');
        }
        grid.appendChild(card);
        cardIndex++;
      });

      savedSection.appendChild(grid);

      if (hasMore) {
        const moreBtn = document.createElement('button');
        moreBtn.className = 'home-show-more-btn';
        moreBtn.textContent = t('homeShowMore');
        let expanded = false;
        moreBtn.onclick = () => {
          expanded = !expanded;
          grid.classList.toggle('expanded', expanded);
          moreBtn.textContent = expanded ? t('homeShowLess') : t('homeShowMore');
          const homeView = document.getElementById('home-view');
          if (homeView) {
            homeView.classList.toggle('has-overflow', expanded);
          }
        };
        savedSection.appendChild(moreBtn);
      }
    }
  }

  // --- Recent connections ---
  if (recentSection) {
    const recentSSH = loadRecentConnections();
    const recentRemote = loadRecentRemoteConnections();
    recentSection.innerHTML = '';

    const totalRecent = recentSSH.length + recentRemote.length;
    if (totalRecent > 0) {
      const title = document.createElement('div');
      title.className = 'home-saved-title';
      title.textContent = t('homeRecentConnections');
      recentSection.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'home-saved-grid';

      recentSSH.forEach((conn) => {
        grid.appendChild(createConnectionCard(conn, false));
      });

      recentRemote.forEach((info) => {
        grid.appendChild(createRemoteConnectionCard(info, true));
      });

      recentSection.appendChild(grid);
    }
  }
}
