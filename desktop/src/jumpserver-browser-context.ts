/**
 * Narrow, in-memory protocol between the JumpServer browser utility window and
 * its owner main window. The child receives no backend port, bearer token, or
 * JumpServer URL; it may only invoke the explicitly allow-listed read methods.
 */

import type { JumpServerConfig } from './jumpserver-api';
import { JumpServerSessionExpiredError } from './jumpserver-errors';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const JUMP_SERVER_BROWSER_LABEL = 'jumpserver-browser';
export const JUMP_SERVER_CONTEXT_REQUEST_EVENT = 'jumpserver-browser-context-request';
export const JUMP_SERVER_CONTEXT_RESPONSE_EVENT = 'jumpserver-browser-context-response';
export const JUMP_SERVER_RPC_REQUEST_EVENT = 'jumpserver-browser-rpc-request';
export const JUMP_SERVER_RPC_RESPONSE_EVENT = 'jumpserver-browser-rpc-response';

const LEGACY_BROWSER_STORAGE_KEYS = [
  'meterm-js-browser-port',
  'meterm-js-browser-token',
  'meterm-js-browser-config',
] as const;

export interface JumpServerBrowserConfig {
  name: string;
}

export interface JumpServerBrowserContextRequest {
  requestId: string;
  browserLabel: typeof JUMP_SERVER_BROWSER_LABEL;
}

export interface JumpServerBrowserContextResponse {
  requestId: string;
  browserLabel: typeof JUMP_SERVER_BROWSER_LABEL;
  issuedAt: number;
  config: JumpServerBrowserConfig;
}

export type JumpServerBrowserRpcOperation = 'assets' | 'nodes' | 'accounts';

export interface JumpServerBrowserAssetsParams {
  search?: string;
  nodeId?: string;
  page?: number;
  pageSize?: number;
}

export interface JumpServerBrowserAccountsParams {
  assetId: string;
}

export type JumpServerBrowserRpcParams =
  | JumpServerBrowserAssetsParams
  | JumpServerBrowserAccountsParams
  | Record<string, never>;

export interface JumpServerBrowserRpcRequest {
  requestId: string;
  browserLabel: typeof JUMP_SERVER_BROWSER_LABEL;
  configName: string;
  operation: JumpServerBrowserRpcOperation;
  params: JumpServerBrowserRpcParams;
}

export type JumpServerBrowserRpcErrorCode =
  | 'busy'
  | 'invalid_request'
  | 'response_too_large'
  | 'session_expired'
  | 'upstream_error';

export interface JumpServerBrowserRpcResponse {
  requestId: string;
  browserLabel: typeof JUMP_SERVER_BROWSER_LABEL;
  configName: string;
  operation: JumpServerBrowserRpcOperation;
  issuedAt: number;
  ok: boolean;
  data?: unknown;
  error?: {
    code: JumpServerBrowserRpcErrorCode;
    message: string;
  };
}

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const RESOURCE_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const RPC_TIMEOUT_MS = 15_000;
const MAX_CHILD_RPC_IN_FLIGHT = 4;
let childRpcInFlight = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every(key => allowedKeys.has(key));
}

function isSafeConfigName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !CONTROL_CHARACTER_RE.test(value);
}

function isSafeOptionalResourceId(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && RESOURCE_ID_RE.test(value));
}

function isSafeOptionalInteger(value: unknown, min: number, max: number): value is number | undefined {
  return value === undefined
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max);
}

function isAssetsParams(value: unknown): value is JumpServerBrowserAssetsParams {
  if (!isRecord(value) || !hasOnlyKeys(value, ['search', 'nodeId', 'page', 'pageSize'])) return false;
  if (value.search !== undefined && (
    typeof value.search !== 'string'
    || value.search.length > 256
    || CONTROL_CHARACTER_RE.test(value.search)
  )) return false;
  return isSafeOptionalResourceId(value.nodeId)
    && isSafeOptionalInteger(value.page, 1, 10_000)
    && isSafeOptionalInteger(value.pageSize, 1, 100);
}

function isNodesParams(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0;
}

function isAccountsParams(value: unknown): value is JumpServerBrowserAccountsParams {
  return isRecord(value)
    && hasOnlyKeys(value, ['assetId'])
    && typeof value.assetId === 'string'
    && RESOURCE_ID_RE.test(value.assetId);
}

export function toJumpServerBrowserConfig(config: JumpServerConfig): JumpServerBrowserConfig {
  return { name: config.name };
}

export function clearLegacyJumpServerBrowserStorage(): void {
  for (const key of LEGACY_BROWSER_STORAGE_KEYS) localStorage.removeItem(key);
}

/** Return a metadata-only config suitable for JSON/Web Storage. */
export function stripJumpServerSecrets(config: JumpServerConfig): JumpServerConfig {
  // Keep an explicit allow-list so newly introduced config fields cannot be
  // persisted accidentally if they later carry credentials or session data.
  return {
    name: config.name,
    baseUrl: config.baseUrl,
    sshHost: config.sshHost,
    sshPort: config.sshPort,
    username: config.username,
    authMethod: config.authMethod,
    orgId: config.orgId,
    bypassProxy: config.bypassProxy,
    proxyType: config.proxyType,
    proxyHost: config.proxyHost,
    proxyPort: config.proxyPort,
    proxyUsername: config.proxyUsername,
  };
}

export function isJumpServerBrowserContextRequest(
  value: unknown,
): value is JumpServerBrowserContextRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ['requestId', 'browserLabel'])) return false;
  return value.browserLabel === JUMP_SERVER_BROWSER_LABEL
    && typeof value.requestId === 'string'
    && REQUEST_ID_RE.test(value.requestId);
}

export function isJumpServerBrowserContextResponse(
  value: unknown,
  expectedRequestId: string,
): value is JumpServerBrowserContextResponse {
  if (!isRecord(value) || !isRecord(value.config)) return false;
  if (!hasOnlyKeys(value, ['requestId', 'browserLabel', 'issuedAt', 'config'])) return false;
  if (!hasOnlyKeys(value.config, ['name'])) return false;
  if (value.requestId !== expectedRequestId || !REQUEST_ID_RE.test(expectedRequestId)) return false;
  if (value.browserLabel !== JUMP_SERVER_BROWSER_LABEL) return false;
  if (typeof value.issuedAt !== 'number' || Math.abs(Date.now() - value.issuedAt) > 15_000) return false;
  return isSafeConfigName(value.config.name);
}

export function isJumpServerBrowserRpcRequest(value: unknown): value is JumpServerBrowserRpcRequest {
  if (!isRecord(value) || !isRecord(value.params)) return false;
  if (!hasOnlyKeys(value, ['requestId', 'browserLabel', 'configName', 'operation', 'params'])) return false;
  if (value.browserLabel !== JUMP_SERVER_BROWSER_LABEL) return false;
  if (typeof value.requestId !== 'string' || !REQUEST_ID_RE.test(value.requestId)) return false;
  if (!isSafeConfigName(value.configName)) return false;
  switch (value.operation) {
    case 'assets': return isAssetsParams(value.params);
    case 'nodes': return isNodesParams(value.params);
    case 'accounts': return isAccountsParams(value.params);
    default: return false;
  }
}

function isJumpServerBrowserRpcResponse(
  value: unknown,
  request: JumpServerBrowserRpcRequest,
): value is JumpServerBrowserRpcResponse {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, [
    'requestId', 'browserLabel', 'configName', 'operation', 'issuedAt', 'ok', 'data', 'error',
  ])) return false;
  if (value.requestId !== request.requestId
    || value.browserLabel !== JUMP_SERVER_BROWSER_LABEL
    || value.configName !== request.configName
    || value.operation !== request.operation
    || typeof value.issuedAt !== 'number'
    || Math.abs(Date.now() - value.issuedAt) > RPC_TIMEOUT_MS + 5_000
    || typeof value.ok !== 'boolean') return false;
  if (value.ok) return value.data !== undefined && value.error === undefined;
  if (!isRecord(value.error) || value.data !== undefined) return false;
  return hasOnlyKeys(value.error, ['code', 'message'])
    && ['busy', 'invalid_request', 'response_too_large', 'session_expired', 'upstream_error'].includes(String(value.error.code))
    && typeof value.error.message === 'string'
    && value.error.message.length <= 512
    && !CONTROL_CHARACTER_RE.test(value.error.message);
}

function createRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function requestEvent<TResponse>(
  responseEvent: string,
  requestEvent: string,
  request: JumpServerBrowserContextRequest | JumpServerBrowserRpcRequest,
  validate: (value: unknown) => value is TResponse,
  timeoutMs: number,
): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unlisten: (() => void) | null = null;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      unlisten?.();
      callback();
    };
    const timeoutId = window.setTimeout(() => {
      finish(() => reject(new Error('JumpServer browser request timed out')));
    }, timeoutMs);

    void listen<TResponse>(responseEvent, (event) => {
      if (!validate(event.payload)) return;
      finish(() => resolve(event.payload));
    }).then((stop) => {
      if (settled) {
        stop();
        return;
      }
      unlisten = stop;
      return invoke('forward_jumpserver_browser_event', {
        event: requestEvent,
        payload: request,
      });
    }).catch((error) => {
      finish(() => reject(error));
    });
  });
}

/** Request only the public browser identity after installing the listener. */
export function requestJumpServerBrowserContext(
  timeoutMs = 8_000,
): Promise<JumpServerBrowserContextResponse> {
  const requestId = createRequestId();
  const request: JumpServerBrowserContextRequest = {
    requestId,
    browserLabel: JUMP_SERVER_BROWSER_LABEL,
  };
  return requestEvent(
    JUMP_SERVER_CONTEXT_RESPONSE_EVENT,
    JUMP_SERVER_CONTEXT_REQUEST_EVENT,
    request,
    (value): value is JumpServerBrowserContextResponse => (
      isJumpServerBrowserContextResponse(value, requestId)
    ),
    timeoutMs,
  );
}

/** Invoke one of the three read-only JumpServer browser operations. */
export async function requestJumpServerBrowserRpc<T>(
  configName: string,
  operation: JumpServerBrowserRpcOperation,
  params: JumpServerBrowserRpcParams,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<T> {
  if (childRpcInFlight >= MAX_CHILD_RPC_IN_FLIGHT) {
    throw new Error('Too many JumpServer browser requests');
  }
  const request: JumpServerBrowserRpcRequest = {
    requestId: createRequestId(),
    browserLabel: JUMP_SERVER_BROWSER_LABEL,
    configName,
    operation,
    params,
  };
  if (!isJumpServerBrowserRpcRequest(request)) throw new Error('Invalid JumpServer browser request');

  childRpcInFlight += 1;
  try {
    const response = await requestEvent(
      JUMP_SERVER_RPC_RESPONSE_EVENT,
      JUMP_SERVER_RPC_REQUEST_EVENT,
      request,
      (value): value is JumpServerBrowserRpcResponse => isJumpServerBrowserRpcResponse(value, request),
      timeoutMs,
    );
    if (!response.ok) {
      if (response.error?.code === 'session_expired') {
        throw new JumpServerSessionExpiredError(configName);
      }
      throw new Error(response.error?.message || 'JumpServer browser request failed');
    }
    return response.data as T;
  } finally {
    childRpcInFlight -= 1;
  }
}
