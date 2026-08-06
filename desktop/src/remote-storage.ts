import { invoke } from '@tauri-apps/api/core';

import type { RemoteServerInfo } from './remote';

const REMOTE_CONNECTIONS_KEY = 'meterm-remote-connections';
const REMOTE_RECENT_KEY = 'meterm-remote-recent';
const REMOTE_CREDENTIAL_MIGRATION_MARKER_KEY = 'meterm-remote-credential-migration-v1';
const CREDENTIAL_MIGRATION_COMPLETE = 'complete';
const CREDENTIAL_MIGRATION_MANUAL = 'manual';
const MAX_REMOTE_RECENT = 5;
function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  const octets = normalized.split('.');
  return octets.length === 4
    && octets[0] === '127'
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function isSecure(info: Pick<RemoteServerInfo, 'host' | 'secure'>): boolean {
  return info.secure ?? !isLoopbackHost(info.host);
}

async function storeRemoteToken(info: RemoteServerInfo): Promise<void> {
  const { host, port, token, certFp } = info;
  if (!token) return;
  await invoke('remote_store_token', {
    host,
    port,
    secure: isSecure(info),
    certFp: certFp || null,
    token,
  });
}

/** Make an authority usable by native HTTP/WS operations without reading its token. */
export async function prepareRemoteCredential(info: RemoteServerInfo): Promise<void> {
  if (info.token) {
    await storeRemoteToken(info);
    return;
  }
  if (!(await hasRemoteToken(info))) throw new Error('remote credential not found');
}

export async function hasRemoteToken(info: Pick<RemoteServerInfo, 'host' | 'port' | 'secure' | 'certFp'>): Promise<boolean> {
  return invoke<boolean>('remote_has_token', {
    host: info.host,
    port: info.port,
    secure: isSecure(info),
    certFp: info.certFp || null,
  });
}

async function deleteRemoteToken(host: string, port: number): Promise<void> {
  await invoke('remote_delete_token', { host, port });
}

function stripToken(info: RemoteServerInfo): RemoteServerInfo {
  const { token: _token, ...rest } = info;
  return { ...rest, token: '' } as RemoteServerInfo;
}

/** Startup-only local inspection. Credential migration happens on explicit use/re-save. */
export async function detectRemoteCredentialMigrationPendingAtStartup(): Promise<void> {
  if (localStorage.getItem(REMOTE_CREDENTIAL_MIGRATION_MARKER_KEY)) return;

  const storedLists: RemoteServerInfo[][] = [];

  try {
    for (const key of [REMOTE_CONNECTIONS_KEY, REMOTE_RECENT_KEY]) {
      const raw = localStorage.getItem(key);
      if (!raw) {
        storedLists.push([]);
        continue;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('invalid remote connection storage');
      storedLists.push(parsed as RemoteServerInfo[]);
    }
  } catch (error) {
    localStorage.setItem(REMOTE_CREDENTIAL_MIGRATION_MARKER_KEY, CREDENTIAL_MIGRATION_MANUAL);
    console.warn('[security] Remote credential migration requires explicit re-save:', error);
    throw error;
  }

  const hasPlaintext = storedLists.some((connections) => (
    connections.some((connection) => !!connection?.token)
  ));
  if (!hasPlaintext) {
    // Metadata-only storage must not cause a Keychain read or migration.
    localStorage.setItem(REMOTE_CREDENTIAL_MIGRATION_MARKER_KEY, CREDENTIAL_MIGRATION_COMPLETE);
    return;
  }

  // Preserve the only plaintext source and require an explicit connection or
  // re-save. Startup never invokes a native credential operation.
  localStorage.setItem(REMOTE_CREDENTIAL_MIGRATION_MARKER_KEY, CREDENTIAL_MIGRATION_MANUAL);
}

export function loadSavedRemoteConnections(): RemoteServerInfo[] {
  try {
    const raw = localStorage.getItem(REMOTE_CONNECTIONS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore malformed local data */ }
  return [];
}

function saveSavedRemoteConnections(conns: RemoteServerInfo[]): void {
  const stripped = conns.map(stripToken);
  localStorage.setItem(REMOTE_CONNECTIONS_KEY, JSON.stringify(stripped));
}

export async function addRemoteConnection(info: RemoteServerInfo): Promise<void> {
  // A newly supplied token crosses IPC only in the write direction. Existing
  // credentials are checked and used by fixed native operations.
  await prepareRemoteCredential(info);

  const conns = loadSavedRemoteConnections();
  const key = `${info.host}:${info.port}`;
  const existing = conns.findIndex((conn) => `${conn.host}:${conn.port}` === key);
  const stripped = stripToken(info);
  if (existing >= 0) {
    conns[existing] = stripped;
  } else {
    conns.push(stripped);
  }
  saveSavedRemoteConnections(conns);
}

export async function removeRemoteConnection(host: string, port: number): Promise<void> {
  // Retain metadata for an exact retry if any v2/legacy deletion fails.
  await deleteRemoteToken(host, port);
  const conns = loadSavedRemoteConnections().filter(
    (conn) => !(conn.host === host && conn.port === port),
  );
  saveSavedRemoteConnections(conns);
}

export function loadRecentRemoteConnections(): RemoteServerInfo[] {
  try {
    const raw = localStorage.getItem(REMOTE_RECENT_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore malformed local data */ }
  return [];
}

function saveRecentRemoteConnections(conns: RemoteServerInfo[]): void {
  const stripped = conns.map(stripToken);
  localStorage.setItem(REMOTE_RECENT_KEY, JSON.stringify(stripped));
}

export function addRecentRemoteConnection(info: RemoteServerInfo): void {
  let recent = loadRecentRemoteConnections();
  recent = recent.filter(
    (conn) => !(conn.host === info.host && conn.port === info.port),
  );
  recent.unshift(stripToken(info));
  if (recent.length > MAX_REMOTE_RECENT) recent.length = MAX_REMOTE_RECENT;
  saveRecentRemoteConnections(recent);
}

export function removeRecentRemoteConnection(host: string, port: number): void {
  const conns = loadRecentRemoteConnections().filter(
    (conn) => !(conn.host === host && conn.port === port),
  );
  saveRecentRemoteConnections(conns);
}

/** Check recent remote availability without sending any credential. */
export async function pruneUnreachableRecentRemotes(): Promise<void> {
  const recents = loadRecentRemoteConnections();
  if (recents.length === 0) return;

  const results = await Promise.allSettled(
    recents.map(async (info) => {
      try {
        await invoke<string>('ping_remote', { host: info.host, port: info.port });
        return true;
      } catch {
        return false;
      }
    }),
  );

  const reachable = recents.filter((_, index) => {
    const result = results[index];
    return result.status === 'fulfilled' && result.value;
  });

  if (reachable.length < recents.length) {
    const removed = recents.length - reachable.length;
    console.log(`[remote] pruned ${removed} unreachable recent remote connection(s)`);
    saveRecentRemoteConnections(reachable);
  }
}
