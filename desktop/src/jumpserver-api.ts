/**
 * jumpserver-api.ts — JumpServer REST API client
 *
 * Communicates with the Go backend which proxies requests to JumpServer.
 * Handles authentication (with MFA), asset browsing, and fixed native SSH
 * operations. Short-lived Koko credentials never enter this module.
 */

import { invoke } from '@tauri-apps/api/core';
import { port, authToken } from './app-state';
import { parseJumpServerError } from './jumpserver-errors';

// ── Types ──

export interface JumpServerConfig {
  name: string;
  baseUrl: string;        // JumpServer API base URL, e.g. https://js.example.com
  sshHost: string;        // JumpServer Koko SSH host (for terminal connection)
  sshPort: number;        // Koko SSH port, default 2222
  username: string;
  authMethod: 'password' | 'token';  // password login or direct token
  password?: string;
  apiToken?: string;      // Private Token / Bearer Token
  orgId?: string;
  /** Bypass system proxy for JumpServer HTTP API requests (default true) */
  bypassProxy?: boolean;
  // SSH proxy settings for Koko SSH connections
  proxyType?: string;      // 'socks5' | 'http' | '' (direct)
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
}

export interface JumpServerAsset {
  id: string;
  name: string;
  address: string;
  platform: { id: number; name: string };
  comment?: string;
  is_active: boolean;
  protocols?: Array<{ id: number; name: string; port: number }>;
  nodes?: Array<{ id: string; name: string; value?: string; key?: string }>;
  accounts?: string[];
}

export interface JumpServerNode {
  id: string;
  name: string;
  key: string;
  value: string;
  parent?: string;
  assets_amount?: number;
}

export interface JumpServerAccount {
  id: string;
  name: string;
  username: string;
  alias?: string;
  has_secret: boolean;
  privileged: boolean;
}

export interface AuthResult {
  ok: boolean;
  token?: string;
  mfa_required?: boolean;
  mfa_choices?: string[];
  expiration?: string;
  error?: string;
}

export interface AssetsResult {
  ok: boolean;
  assets?: JumpServerAsset[];
  total?: number;
  page?: number;
  error?: string;
}

export interface NodesResult {
  ok: boolean;
  nodes?: JumpServerNode[];
  error?: string;
}

export interface AccountsResult {
  ok: boolean;
  accounts?: JumpServerAccount[];
  error?: string;
}

export interface JumpServerSecrets {
  password?: string;
  apiToken?: string;
  proxyPassword?: string;
}

export interface JumpServerCredentialBinding {
  name: string;
  baseUrl: string;
  sshHost: string;
  sshPort: number;
  username: string;
  authMethod: 'password' | 'token';
  orgId: string;
  proxyType: string;
  proxyHost: string;
  proxyPort: number;
  proxyUsername: string;
}

export interface JumpServerCredentialStatus {
  exists: boolean;
  bindingMatches: boolean;
  hasPassword: boolean;
  hasApiToken: boolean;
  hasProxyPassword: boolean;
}

// ── Storage ──

const JS_CONNECTIONS_KEY = 'meterm-jumpserver-connections';
const JS_CREDENTIAL_MIGRATION_MARKER_KEY = 'meterm-jumpserver-credential-migration-v1';
const CREDENTIAL_MIGRATION_COMPLETE = 'complete';
const CREDENTIAL_MIGRATION_MANUAL = 'manual';
export function jumpServerCredentialBinding(config: JumpServerConfig): JumpServerCredentialBinding {
  return {
    name: config.name,
    baseUrl: config.baseUrl,
    sshHost: config.sshHost,
    sshPort: config.sshPort || 2222,
    username: config.username,
    authMethod: config.authMethod,
    orgId: config.orgId || '',
    proxyType: config.proxyType || '',
    proxyHost: config.proxyHost || '',
    proxyPort: config.proxyPort || 0,
    proxyUsername: config.proxyUsername || '',
  };
}

export function stripJumpServerCredentialFields(config: JumpServerConfig): JumpServerConfig {
  const { password: _password, apiToken: _apiToken, proxyPassword: _proxyPassword, ...metadata } = config;
  return metadata;
}

export function loadJumpServerConfigs(): JumpServerConfig[] {
  try {
    const raw = localStorage.getItem(JS_CONNECTIONS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as JumpServerConfig[];
  } catch {
    return [];
  }
}

export function saveJumpServerConfigs(configs: JumpServerConfig[]): void {
  // Strip secrets before saving to localStorage
  const stripped = configs.map(c => ({
    name: c.name,
    baseUrl: c.baseUrl,
    sshHost: c.sshHost,
    sshPort: c.sshPort,
    username: c.username,
    authMethod: c.authMethod,
    orgId: c.orgId,
    bypassProxy: c.bypassProxy,
    proxyType: c.proxyType,
    proxyHost: c.proxyHost,
    proxyPort: c.proxyPort,
    proxyUsername: c.proxyUsername,
  }));
  localStorage.setItem(JS_CONNECTIONS_KEY, JSON.stringify(stripped));
}

export async function addJumpServerConfig(config: JumpServerConfig, previousName?: string): Promise<void> {
  const configs = loadJumpServerConfigs();
  const oldName = previousName || config.name;
  const idx = configs.findIndex(c => c.name === oldName);
  const binding = jumpServerCredentialBinding(config);
  const hasPrimarySubmission = config.authMethod === 'token' ? !!config.apiToken : !!config.password;
  if (oldName !== config.name && !hasPrimarySubmission) {
    throw new Error('jumpserver_credential_authority_changed');
  }
  const submitted: JumpServerSecrets = {
    password: config.password,
    apiToken: config.apiToken,
    proxyPassword: config.proxyPassword,
  };
  if (submitted.password || submitted.apiToken || submitted.proxyPassword) {
    await invoke<JumpServerCredentialStatus>('jumpserver_store_credentials', {
      binding,
      credentials: submitted,
    });
  } else {
    const migrated = await invoke<JumpServerCredentialStatus>('jumpserver_migrate_credentials', { binding });
    if (migrated.exists && !migrated.bindingMatches) {
      throw new Error('jumpserver_credential_authority_changed');
    }
  }

  const metadata = stripJumpServerCredentialFields(config);
  if (idx >= 0) {
    configs[idx] = metadata;
  } else {
    configs.push(metadata);
  }
  saveJumpServerConfigs(configs);

  if (oldName !== config.name) {
    await deleteJSSecrets(oldName);
  }

  document.dispatchEvent(new CustomEvent('ssh-connections-changed'));
}

export async function removeJumpServerConfig(name: string): Promise<void> {
  const configs = loadJumpServerConfigs();
  const filtered = configs.filter(c => c.name !== name);
  // Keep the metadata/account name available for retry if Keychain deletion
  // fails; otherwise an orphaned broad-ACL item would become undiscoverable.
  await deleteJSSecrets(name);
  saveJumpServerConfigs(filtered);
  document.dispatchEvent(new CustomEvent('ssh-connections-changed'));
}

export async function storeJSSecrets(
  config: JumpServerConfig,
  password?: string,
  apiToken?: string,
  proxyPassword?: string,
): Promise<JumpServerCredentialStatus> {
  return invoke<JumpServerCredentialStatus>('jumpserver_store_credentials', {
    binding: jumpServerCredentialBinding(config),
    credentials: { password, apiToken, proxyPassword },
  });
}

export async function deleteJSSecrets(name: string): Promise<void> {
  await invoke('jumpserver_delete_credentials', { name });
}

export async function jumpServerCredentialStatus(
  config: JumpServerConfig,
): Promise<JumpServerCredentialStatus> {
  return invoke<JumpServerCredentialStatus>('jumpserver_credential_status', {
    binding: jumpServerCredentialBinding(config),
  });
}

/** Startup-only local inspection. Native migration stays on explicit UI use. */
export async function detectJumpServerCredentialMigrationPendingAtStartup(): Promise<void> {
  if (localStorage.getItem(JS_CREDENTIAL_MIGRATION_MARKER_KEY)) return;

  let raw: string | null = null;
  let configs: JumpServerConfig[] = [];
  try {
    raw = localStorage.getItem(JS_CONNECTIONS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('invalid JumpServer connection storage');
      configs = parsed as JumpServerConfig[];
    }
  } catch (error) {
    localStorage.setItem(JS_CREDENTIAL_MIGRATION_MARKER_KEY, CREDENTIAL_MIGRATION_MANUAL);
    console.warn('[security] JumpServer credential migration requires explicit re-save:', error);
    throw error;
  }

  const plaintextConfigs = configs.filter((config) => (
    !!(config?.password || config?.apiToken || config?.proxyPassword)
  ));
  if (plaintextConfigs.length === 0) {
    localStorage.setItem(JS_CREDENTIAL_MIGRATION_MARKER_KEY, CREDENTIAL_MIGRATION_COMPLETE);
    return;
  }

  // Preserve the only plaintext source. Opening/saving the JumpServer entry is
  // the explicit action that may invoke native credential migration.
  localStorage.setItem(JS_CREDENTIAL_MIGRATION_MARKER_KEY, CREDENTIAL_MIGRATION_MANUAL);
}

// ── API Calls (via Go backend proxy) ──

async function fetchJSON<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `http://127.0.0.1:${port}${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
      ...options?.headers,
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    const typed = parseJumpServerError(text);
    if (typed) throw typed;
    throw new Error(`HTTP ${resp.status}: ${text}`);
  }

  const json = await resp.json() as T;

  // Some endpoints return 200 with { ok: false, error: "SESSION_EXPIRED: ..." }
  // (depends on how the Rust handler wraps errors). Check the result shape too.
  const maybeErr = (json as unknown as { ok?: boolean; error?: string }).error;
  if (maybeErr && typeof maybeErr === 'string') {
    const typed = parseJumpServerError(maybeErr);
    if (typed) throw typed;
  }

  return json;
}

/**
 * Authenticate with JumpServer using username/password.
 * If MFA is required, the result will indicate so and the caller should
 * use submitMFA() to complete authentication.
 */
export async function authenticate(
  config: JumpServerConfig,
  credentialOverride?: string,
): Promise<AuthResult> {
  return fetchJSON<AuthResult>('/api/jumpserver/auth', {
    method: 'POST',
    body: JSON.stringify({
      binding: jumpServerCredentialBinding(config),
      credentialOverride,
    }),
  });
}

/**
 * Authenticate with a direct API token (Private Token or Bearer Token).
 */
export async function authenticateWithToken(
  config: JumpServerConfig,
  credentialOverride?: string,
): Promise<AuthResult> {
  return fetchJSON<AuthResult>('/api/jumpserver/token-auth', {
    method: 'POST',
    body: JSON.stringify({
      binding: jumpServerCredentialBinding(config),
      credentialOverride,
    }),
  });
}

/**
 * Submit MFA verification code.
 * Must be called after authenticate() returns mfa_required=true.
 */
export async function submitMFA(
  config: JumpServerConfig,
  mfaType: string,
  code: string,
): Promise<AuthResult> {
  return fetchJSON<AuthResult>('/api/jumpserver/mfa', {
    method: 'POST',
    body: JSON.stringify({
      binding: jumpServerCredentialBinding(config),
      type: mfaType,
      code,
    }),
  });
}

/**
 * Fetch assets the authenticated user has permission to access.
 */
export async function getAssets(baseUrl: string, options?: {
  search?: string;
  nodeId?: string;
  page?: number;
  pageSize?: number;
}): Promise<AssetsResult> {
  const params = new URLSearchParams({ base_url: baseUrl });
  if (options?.search) params.set('search', options.search);
  if (options?.nodeId) params.set('node_id', options.nodeId);
  if (options?.page) params.set('page', String(options.page));
  if (options?.pageSize) params.set('page_size', String(options.pageSize));

  return fetchJSON<AssetsResult>(`/api/jumpserver/assets?${params.toString()}`);
}

/**
 * Fetch the asset node tree.
 */
export async function getNodes(baseUrl: string): Promise<NodesResult> {
  return fetchJSON<NodesResult>(`/api/jumpserver/nodes?base_url=${encodeURIComponent(baseUrl)}`);
}

/**
 * Fetch accounts (system users) available for a specific asset.
 */
export async function getAccounts(baseUrl: string, assetId: string): Promise<AccountsResult> {
  const params = new URLSearchParams({ base_url: baseUrl, asset_id: assetId });
  return fetchJSON<AccountsResult>(`/api/jumpserver/accounts?${params.toString()}`);
}

/**
 * Start the fixed Koko SSH operation. Rust creates and consumes the
 * short-lived JMS credential; the WebView sends only target metadata.
 */
export async function createJumpServerSshSession(
  config: JumpServerConfig,
  asset: JumpServerAsset,
  account: JumpServerAccount,
  trustedFingerprint?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/jumpserver/ssh-session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      binding: jumpServerCredentialBinding(config),
      assetId: asset.id,
      account: account.username,
      accountName: account.name,
      accountAlias: account.alias || '',
      accountId: account.id,
      protocol: 'ssh',
      trustedFingerprint,
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  return { status: response.status, body };
}

/**
 * Test connectivity to a JumpServer instance.
 */
export async function testConnection(baseUrl: string): Promise<{ ok: boolean; error?: string }> {
  return fetchJSON<{ ok: boolean; error?: string }>('/api/jumpserver/test', {
    method: 'POST',
    body: JSON.stringify({ base_url: baseUrl }),
  });
}
