/**
 * jumpserver-api.ts — JumpServer REST API client
 *
 * Communicates with the Go backend which proxies requests to JumpServer.
 * Handles authentication (with MFA), asset browsing, and connection tokens.
 */

import { invoke } from '@tauri-apps/api/core';
import { port, authToken } from './app-state';

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

export interface ConnectionTokenResult {
  ok: boolean;
  id?: string;
  token?: string;
  secret?: string; // v2: SSH password for JMS-{token} connection
  error?: string;
}

// ── Storage ──

const JS_CONNECTIONS_KEY = 'meterm-jumpserver-connections';
const JS_KEYCHAIN_SERVICE = 'com.meterm.dev.jumpserver';

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
  }));
  localStorage.setItem(JS_CONNECTIONS_KEY, JSON.stringify(stripped));
}

export async function addJumpServerConfig(config: JumpServerConfig): Promise<void> {
  const configs = loadJumpServerConfigs();
  const idx = configs.findIndex(c => c.name === config.name);
  if (idx >= 0) {
    configs[idx] = config;
  } else {
    configs.push(config);
  }
  saveJumpServerConfigs(configs);

  // Store secrets in keychain
  if (config.password || config.apiToken) {
    await storeJSSecrets(config.name, config.password, config.apiToken);
  }

  document.dispatchEvent(new CustomEvent('ssh-connections-changed'));
}

export async function removeJumpServerConfig(name: string): Promise<void> {
  const configs = loadJumpServerConfigs();
  const filtered = configs.filter(c => c.name !== name);
  saveJumpServerConfigs(filtered);
  await deleteJSSecrets(name);
  document.dispatchEvent(new CustomEvent('ssh-connections-changed'));
}

async function storeJSSecrets(name: string, password?: string, apiToken?: string): Promise<void> {
  const data = JSON.stringify({ password: password || '', apiToken: apiToken || '' });
  try {
    await invoke('store_credential', { service: JS_KEYCHAIN_SERVICE, account: name, secret: data });
  } catch (e) {
    console.warn('[jumpserver] Failed to store secrets:', e);
  }
}

export async function loadJSSecrets(name: string): Promise<{ password?: string; apiToken?: string }> {
  try {
    const raw = await invoke<string>('get_credential', { service: JS_KEYCHAIN_SERVICE, account: name });
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return { password: parsed.password || undefined, apiToken: parsed.apiToken || undefined };
  } catch {
    return {};
  }
}

async function deleteJSSecrets(name: string): Promise<void> {
  try {
    await invoke('delete_credential', { service: JS_KEYCHAIN_SERVICE, account: name });
  } catch {
    // ignore
  }
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
    throw new Error(`HTTP ${resp.status}: ${text}`);
  }

  return resp.json() as Promise<T>;
}

/**
 * Authenticate with JumpServer using username/password.
 * If MFA is required, the result will indicate so and the caller should
 * use submitMFA() to complete authentication.
 */
export async function authenticate(config: JumpServerConfig): Promise<AuthResult> {
  return fetchJSON<AuthResult>('/api/jumpserver/auth', {
    method: 'POST',
    body: JSON.stringify({
      base_url: config.baseUrl,
      username: config.username,
      password: config.password,
      org_id: config.orgId,
    }),
  });
}

/**
 * Authenticate with a direct API token (Private Token or Bearer Token).
 */
export async function authenticateWithToken(config: JumpServerConfig): Promise<AuthResult> {
  return fetchJSON<AuthResult>('/api/jumpserver/token-auth', {
    method: 'POST',
    body: JSON.stringify({
      base_url: config.baseUrl,
      token: config.apiToken,
      org_id: config.orgId,
    }),
  });
}

/**
 * Submit MFA verification code.
 * Must be called after authenticate() returns mfa_required=true.
 */
export async function submitMFA(baseUrl: string, mfaType: string, code: string): Promise<AuthResult> {
  return fetchJSON<AuthResult>('/api/jumpserver/mfa', {
    method: 'POST',
    body: JSON.stringify({
      base_url: baseUrl,
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
 * Create a connection token for WebSocket terminal access.
 */
export async function createConnectionToken(
  baseUrl: string,
  assetId: string,
  account: string,
  accountId: string,
  protocol = 'ssh',
): Promise<ConnectionTokenResult> {
  return fetchJSON<ConnectionTokenResult>('/api/jumpserver/connection-token', {
    method: 'POST',
    body: JSON.stringify({
      base_url: baseUrl,
      asset_id: assetId,
      account,
      account_id: accountId,
      protocol,
    }),
  });
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
