/**
 * jumpserver-browser.ts — Open JumpServer asset browser as a standalone window
 *
 * Creates a Tauri WebviewWindow for browsing JumpServer assets.
 * Communicates back to the main window via Tauri events.
 */

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { createUtilityWindow } from './window-utils';
import { t } from './i18n';
import { lastFocusedMainWindowLabel } from './app-state';
import {
  getAccounts,
  getAssets,
  getNodes,
  type AccountsResult,
  type AssetsResult,
  type JumpServerAccount,
  type JumpServerAsset,
  type JumpServerConfig,
  type NodesResult,
} from './jumpserver-api';
import { isJumpServerSessionExpired } from './jumpserver-errors';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  JUMP_SERVER_BROWSER_LABEL,
  JUMP_SERVER_CONTEXT_REQUEST_EVENT,
  JUMP_SERVER_CONTEXT_RESPONSE_EVENT,
  JUMP_SERVER_RPC_REQUEST_EVENT,
  JUMP_SERVER_RPC_RESPONSE_EVENT,
  type JumpServerBrowserAccountsParams,
  type JumpServerBrowserAssetsParams,
  type JumpServerBrowserContextRequest,
  type JumpServerBrowserRpcErrorCode,
  type JumpServerBrowserRpcRequest,
  type JumpServerBrowserRpcResponse,
  clearLegacyJumpServerBrowserStorage,
  isJumpServerBrowserContextRequest,
  isJumpServerBrowserRpcRequest,
} from './jumpserver-browser-context';

interface BrowserOwnerContext {
  name: string;
  baseUrl: string;
}

const MAX_BROWSER_RPC_IN_FLIGHT = 4;
const MAX_BROWSER_RPC_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ASSETS_PER_RESPONSE = 100;
const MAX_NODES_PER_RESPONSE = 5_000;
const MAX_ACCOUNTS_PER_RESPONSE = 1_000;
const MAX_TRACKED_BROWSER_ASSETS = 500;
const MAX_TRACKED_ACCOUNT_LISTS = 20;

let browserConfigContext: BrowserOwnerContext | null = null;
let browserContextOwnerLabel = '';
let browserRpcInFlight = 0;
let respondersReady: Promise<unknown> | null = null;
const browserVisibleAssets = new Map<string, JumpServerAsset>();
const browserVisibleAccounts = new Map<string, Map<string, JumpServerAccount>>();

function rememberBrowserRpcResult(
  request: JumpServerBrowserRpcRequest,
  result: AssetsResult | NodesResult | AccountsResult,
): void {
  if (request.operation === 'assets') {
    const assets = (result as AssetsResult).assets;
    if (!Array.isArray(assets)) return;
    for (const asset of assets) {
      if (typeof asset.id !== 'string') continue;
      browserVisibleAssets.delete(asset.id);
      browserVisibleAssets.set(asset.id, asset);
    }
    while (browserVisibleAssets.size > MAX_TRACKED_BROWSER_ASSETS) {
      const oldest = browserVisibleAssets.keys().next().value as string | undefined;
      if (!oldest) break;
      browserVisibleAssets.delete(oldest);
    }
    return;
  }
  if (request.operation === 'accounts') {
    const accounts = (result as AccountsResult).accounts;
    if (!Array.isArray(accounts)) return;
    const assetId = (request.params as JumpServerBrowserAccountsParams).assetId;
    browserVisibleAccounts.delete(assetId);
    browserVisibleAccounts.set(assetId, new Map(accounts
      .filter(account => typeof account.id === 'string')
      .map(account => [account.id, account])));
    while (browserVisibleAccounts.size > MAX_TRACKED_ACCOUNT_LISTS) {
      const oldest = browserVisibleAccounts.keys().next().value as string | undefined;
      if (!oldest) break;
      browserVisibleAccounts.delete(oldest);
    }
  }
}

/** Resolve an action to the canonical objects returned by the owner RPC. */
export function resolveJumpServerBrowserSelection(
  configName: unknown,
  assetId: unknown,
  accountId: unknown,
): { asset: JumpServerAsset; account: JumpServerAccount } | null {
  if (typeof configName !== 'string' || browserConfigContext?.name !== configName) return null;
  if (typeof assetId !== 'string' || typeof accountId !== 'string') return null;
  const asset = browserVisibleAssets.get(assetId);
  const accounts = browserVisibleAccounts.get(assetId);
  if (!asset || !accounts) return null;
  const account = accounts.get(accountId);
  return account ? { asset, account } : null;
}

function sanitizeErrorMessage(value: unknown, baseUrl: string): string {
  const raw = value instanceof Error ? value.message : String(value || 'JumpServer request failed');
  return raw
    .split(baseUrl).join('[JumpServer]')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .slice(0, 512);
}

function sanitizeResultError<T extends { error?: string }>(result: T, baseUrl: string): T {
  if (!result.error) return result;
  return { ...result, error: sanitizeErrorMessage(result.error, baseUrl) };
}

function exceedsCollectionLimit(
  operation: JumpServerBrowserRpcRequest['operation'],
  result: AssetsResult | NodesResult | AccountsResult,
): boolean {
  if (operation === 'assets') {
    return ((result as AssetsResult).assets?.length ?? 0) > MAX_ASSETS_PER_RESPONSE;
  }
  if (operation === 'nodes') {
    return ((result as NodesResult).nodes?.length ?? 0) > MAX_NODES_PER_RESPONSE;
  }
  return ((result as AccountsResult).accounts?.length ?? 0) > MAX_ACCOUNTS_PER_RESPONSE;
}

function rpcResponseFits(response: JumpServerBrowserRpcResponse): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(response)).byteLength <= MAX_BROWSER_RPC_RESPONSE_BYTES;
  } catch {
    return false;
  }
}

async function emitRpcResponse(
  request: JumpServerBrowserRpcRequest,
  response: { ok: true; data: unknown } | {
    ok: false;
    code: JumpServerBrowserRpcErrorCode;
    message: string;
  },
): Promise<void> {
  let payload: JumpServerBrowserRpcResponse = {
    requestId: request.requestId,
    browserLabel: JUMP_SERVER_BROWSER_LABEL,
    configName: request.configName,
    operation: request.operation,
    issuedAt: Date.now(),
    ok: response.ok,
    ...(response.ok
      ? { data: response.data }
      : { error: { code: response.code, message: response.message } }),
  };
  if (response.ok && !rpcResponseFits(payload)) {
    payload = {
      requestId: request.requestId,
      browserLabel: JUMP_SERVER_BROWSER_LABEL,
      configName: request.configName,
      operation: request.operation,
      issuedAt: Date.now(),
      ok: false,
      error: {
        code: 'response_too_large',
        message: 'JumpServer response exceeded the browser limit',
      },
    };
  }
  await emitTo(JUMP_SERVER_BROWSER_LABEL, JUMP_SERVER_RPC_RESPONSE_EVENT, payload);
}

async function handleBrowserRpc(request: JumpServerBrowserRpcRequest): Promise<void> {
  const currentLabel = getCurrentWindow().label;
  if (currentLabel !== browserContextOwnerLabel || currentLabel !== lastFocusedMainWindowLabel) return;
  const ownerContext = browserConfigContext;
  if (!ownerContext || ownerContext.name !== request.configName) {
    await emitRpcResponse(request, {
      ok: false,
      code: 'invalid_request',
      message: 'JumpServer browser context is unavailable',
    });
    return;
  }
  if (browserRpcInFlight >= MAX_BROWSER_RPC_IN_FLIGHT) {
    await emitRpcResponse(request, {
      ok: false,
      code: 'busy',
      message: 'Too many JumpServer browser requests',
    });
    return;
  }

  browserRpcInFlight += 1;
  try {
    let result: AssetsResult | NodesResult | AccountsResult;
    switch (request.operation) {
      case 'assets':
        result = await getAssets(
          ownerContext.baseUrl,
          request.params as JumpServerBrowserAssetsParams,
        );
        break;
      case 'nodes':
        result = await getNodes(ownerContext.baseUrl);
        break;
      case 'accounts':
        result = await getAccounts(
          ownerContext.baseUrl,
          (request.params as JumpServerBrowserAccountsParams).assetId,
        );
        break;
    }

    if (exceedsCollectionLimit(request.operation, result)) {
      await emitRpcResponse(request, {
        ok: false,
        code: 'response_too_large',
        message: 'JumpServer response exceeded the browser item limit',
      });
      return;
    }
    rememberBrowserRpcResult(request, result);
    await emitRpcResponse(request, {
      ok: true,
      data: sanitizeResultError(result, ownerContext.baseUrl),
    });
  } catch (error) {
    if (isJumpServerSessionExpired(error)) {
      await emitRpcResponse(request, {
        ok: false,
        code: 'session_expired',
        message: 'JumpServer session expired',
      });
      return;
    }
    console.error('[jumpserver] Browser RPC failed:', error);
    await emitRpcResponse(request, {
      ok: false,
      code: 'upstream_error',
      message: sanitizeErrorMessage(error, ownerContext.baseUrl),
    });
  } finally {
    browserRpcInFlight -= 1;
  }
}

async function ensureContextResponder(): Promise<void> {
  if (!respondersReady) {
    respondersReady = Promise.all([
      listen<JumpServerBrowserContextRequest>(
        JUMP_SERVER_CONTEXT_REQUEST_EVENT,
        (event) => {
          if (!isJumpServerBrowserContextRequest(event.payload)) return;

          const currentLabel = getCurrentWindow().label;
          if (currentLabel !== browserContextOwnerLabel) return;
          if (currentLabel !== lastFocusedMainWindowLabel) return;
          if (!browserConfigContext) return;

          void emitTo(JUMP_SERVER_BROWSER_LABEL, JUMP_SERVER_CONTEXT_RESPONSE_EVENT, {
            requestId: event.payload.requestId,
            browserLabel: JUMP_SERVER_BROWSER_LABEL,
            issuedAt: Date.now(),
            config: { name: browserConfigContext.name },
          }).catch((error) => {
            console.error('[jumpserver] Failed to deliver browser context:', error);
          });
        },
      ),
      listen<JumpServerBrowserRpcRequest>(JUMP_SERVER_RPC_REQUEST_EVENT, (event) => {
        if (!isJumpServerBrowserRpcRequest(event.payload)) return;
        void handleBrowserRpc(event.payload).catch((error) => {
          console.error('[jumpserver] Failed to handle browser RPC:', error);
        });
      }),
    ]);
  }
  await respondersReady;
}

/**
 * Open the JumpServer asset browser window (single-instance).
 * Delivers the minimal connection context through a targeted, in-memory event.
 */
export async function openJumpServerBrowserWindow(config: JumpServerConfig): Promise<void> {
  if (browserConfigContext?.name !== config.name || browserConfigContext.baseUrl !== config.baseUrl) {
    browserVisibleAssets.clear();
    browserVisibleAccounts.clear();
  }
  browserConfigContext = { name: config.name, baseUrl: config.baseUrl };
  browserContextOwnerLabel = getCurrentWindow().label;
  clearLegacyJumpServerBrowserStorage();
  // Register before checking/creating the child so a reload cannot race us.
  await ensureContextResponder();

  const label = JUMP_SERVER_BROWSER_LABEL;
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    // Update config in case it changed, then focus
    void existing.show();
    void existing.setFocus();
    return;
  }

  try {
    await createUtilityWindow({
      label,
      url: '?window=jumpserver-browser',
      title: `${config.name} — ${t('jsAssetBrowser')}`,
      width: 720,
      height: 520,
      resizable: true,
    });
    const win = await WebviewWindow.getByLabel(label);
    if (win) {
      // Check if startDockedBrowser will manage visibility (it sets a flag in localStorage)
      const dockedMode = localStorage.getItem('meterm-js-browser-docked');
      if (dockedMode === 'true') {
        localStorage.removeItem('meterm-js-browser-docked');
        // startDockedBrowser will show the window after positioning
        return;
      }
      setTimeout(async () => {
        const w = await WebviewWindow.getByLabel(label);
        if (w) void w.show().then(() => w.setFocus());
      }, 150);
    }
  } catch (e) {
    console.error('Failed to create jumpserver-browser window:', e);
  }
}
