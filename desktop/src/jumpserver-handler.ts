/**
 * jumpserver-handler.ts — JumpServer connection handler
 *
 * Orchestrates the full JumpServer connection flow:
 * 1. Authenticate with JumpServer API (with MFA if needed)
 * 2. Show asset browser for visual selection
 * 3. Create SSH session to JumpServer Koko (port 2222)
 * 4. Auto-navigate to selected asset in Koko's interactive menu
 */

import { TabManager, type Tab } from './tabs';
import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { AICapsuleManager } from './ai-capsule';
import { SplitPaneManager } from './split-pane';
import { StatusBar } from './status-bar';
import {
  showConnectingPlaceholder, updateConnectingPlaceholder, removeSSHConnectingPlaceholder,
  showReconnectOverlay, reclaimSessionIds, hideReclaimButton,
} from './overlays';
import { activateTab, setViewMode, hideHomeView, hideGalleryView, showHomeView } from './view-manager';
import { t } from './i18n';
import { ensureMeTermReady } from './session-actions';
import { renderTabs } from './tab-renderer';
import { renderToolbarActions } from './toolbar';
import { showHostKeyConfirmDialog } from './ssh';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  port, authToken,
  sshConfigMap, jumpServerConfigMap,
  activeJumpServers, lastFocusedMainWindowLabel,
} from './app-state';
import {
  type JumpServerConfig,
  type JumpServerAsset,
  type JumpServerAccount,
  type AuthResult,
  authenticate,
  authenticateWithToken,
  submitMFA,
  storeJSSecrets,
  createJumpServerSshSession,
  stripJumpServerCredentialFields,
} from './jumpserver-api';
import { showMFADialog, showJsCredentialPrompt } from './jumpserver-ui';
import {
  openJumpServerBrowserWindow,
  resolveJumpServerBrowserSelection,
} from './jumpserver-browser';
import { recordJSAssetConnection } from './connection-groups';
import { isSessionExpired, clearExpiredFlag, markSessionExpired } from './jumpserver-auth-state';
import { isJumpServerSessionExpired, parseJumpServerError } from './jumpserver-errors';
import {
  clearLegacyJumpServerBrowserStorage,
  stripJumpServerSecrets,
} from './jumpserver-browser-context';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBrowserConfigName(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.configName !== 'string') return null;
  if (payload.configName.length === 0 || payload.configName.length > 256) return null;
  return /[\u0000-\u001f\u007f-\u009f]/u.test(payload.configName) ? null : payload.configName;
}

/**
 * Extract a human-readable error message from JumpServer API error strings.
 * Handles raw JSON like: 'MFA verification failed (HTTP 400): {"error":"mfa_failed","msg":"..."}'
 */
function extractErrorMsg(raw?: string): string {
  if (!raw) return 'Unknown error';
  // Try to extract "msg" from JSON in the string
  const jsonMatch = raw.match(/\{[^}]+\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.msg) return parsed.msg;
      if (parsed.detail) return parsed.detail;
      if (parsed.error && typeof parsed.error === 'string' && parsed.error !== 'mfa_failed') return parsed.error;
    } catch { /* ignore */ }
  }
  // Strip "MFA verification failed (HTTP 400): " prefix
  const prefixMatch = raw.match(/:\s*(.+)/);
  if (prefixMatch) return prefixMatch[1];
  return raw;
}

/**
 * Re-open the asset browser for an already-authenticated JumpServer.
 */
export async function openJumpServerBrowser(config: JumpServerConfig): Promise<void> {
  await openJumpServerBrowserWindow(config);
}

/**
 * Ensure a JumpServer is authenticated (login + MFA if needed).
 * Skips authentication if already registered as active.
 * Returns true if authenticated, false if cancelled or failed.
 */
export async function ensureJSAuthenticated(config: JumpServerConfig, force = false): Promise<boolean> {
  config = stripJumpServerCredentialFields(config);
  // Skip if already authenticated AND not forced AND not in expired state
  if (!force && !isSessionExpired(config.name) && activeJumpServers.has(config.name)) return true;

  StatusBar.setConnection('connecting', `JumpServer: ${config.name}`);

  // Stored credentials stay inside the native broker. Only a value entered in
  // the current prompt is passed as a one-shot override; it is persisted after
  // authentication (including MFA) succeeds.
  const useToken = config.authMethod === 'token';
  let credentialWasPrompted = false;
  let credentialOverride: string | undefined;
  let authResult: AuthResult | undefined;
  let promptError: string | undefined;

  while (true) {
    if (promptError) {
      const entered = await showJsCredentialPrompt(config, promptError);
      if (!entered) {
        StatusBar.setConnection('disconnected', '');
        return false;
      }
      credentialOverride = useToken ? entered.apiToken : entered.password;
      credentialWasPrompted = true;
      promptError = undefined;
    }

    try {
      authResult = useToken
        ? await authenticateWithToken(config, credentialOverride)
        : await authenticate(config, credentialOverride);
    } catch (e) {
      // 客户端层异常（如序列化失败、解析失败）— 不视为凭据错，直接退出避免死循环
      StatusBar.setError(`JumpServer: ${extractErrorMsg(String(e))}`);
      return false;
    }

    if (authResult.ok) break;

    // 认证失败：带错误信息回到循环顶部重新弹对话框
    promptError = extractErrorMsg(authResult.error);
  }

  try {

    // Handle MFA if required (loop to allow retries)
    if (authResult.mfa_required) {
      let mfaOk = false;
      let mfaError: string | undefined;
      const choices = authResult.mfa_choices || ['otp'];
      while (!mfaOk) {
        const mfaInput = await showMFADialog(choices, mfaError);
        if (!mfaInput) {
          StatusBar.setConnection('disconnected', '');
          return false;
        }

        const mfaResult = await submitMFA(config, mfaInput.type, mfaInput.code);
        if (mfaResult.ok) {
          mfaOk = true;
        } else {
          mfaError = extractErrorMsg(mfaResult.error);
        }
      }
    }

    // 认证 + MFA 全部成功 → 把这次补输的值交给 native broker。推迟到
    // 这里可避免首次输错时污染持久凭据。
    if (credentialWasPrompted) {
      try {
        await storeJSSecrets(
          config,
          useToken ? undefined : credentialOverride,
          useToken ? credentialOverride : undefined,
        );
      } catch (e) {
        console.warn('[jumpserver] storeJSSecrets after successful auth failed:', e);
      }
    }

    // Active state is metadata only; later fixed operations materialize their
    // own required credential within Rust.
    activeJumpServers.set(config.name, config);
    clearExpiredFlag(config.name);
    syncActiveJumpServersToStorage();
    void emit('jumpserver-state-changed');
    renderToolbarActions();
    // 清掉函数入口设的 'connecting' 呼吸动画。调用方（如 handleJumpServerConnect /
    // connectToAsset）若紧接着会发起 SSH 等阶段，会再次覆盖此状态；如果调用方就
    // 是单纯重新登录（dropdown / overlays.ts reconnect 前置认证），则停在 connected。
    StatusBar.setConnection('connected', `JumpServer: ${config.name}`);
    return true;
  } catch (err) {
    StatusBar.setError(`JumpServer: ${extractErrorMsg(String(err))}`);
    return false;
  }
}

/**
 * Full JumpServer connection flow:
 * authenticate → (MFA) → browse assets → select → SSH connect → auto-navigate
 */
export async function handleJumpServerConnect(config: JumpServerConfig): Promise<void> {
  const ready = await ensureMeTermReady();
  if (!ready) return;

  const fullConfig = stripJumpServerCredentialFields(config);

  // Step 2: Set proxy mode based on JumpServer config (before HTTP API calls)
  const proxyMode = fullConfig.bypassProxy !== false ? 'direct' : 'system';
  void invoke('set_proxy_mode', { mode: proxyMode });

  // Step 3: Authenticate (+ MFA)
  const authed = await ensureJSAuthenticated(fullConfig);
  if (!authed) return;

  // Step 4: Open standalone asset browser window
  await openJumpServerBrowserWindow(fullConfig);
  StatusBar.setConnection('connected', `JumpServer: ${fullConfig.name}`);
}

// 正在进行的资产连接请求集合 — 同一 config+asset+account 的并发请求只跑一次。
// 防止 popup 双击 / Tauri emit 重放 / panel dblclick 导致并发 connectToAsset，
// 后者会同时弹多个 MFA 对话框并发多个固定 Broker 建连请求。
const inFlightConnects = new Set<string>();

/**
 * Connect to a specific JumpServer asset via connection token.
 * 1. Create a connection token via JumpServer API
 * 2. SSH to Koko with username=JMS-{token} (bypasses MFA and interactive menu)
 */
export async function connectToAsset(
  config: JumpServerConfig,
  asset: JumpServerAsset,
  account: JumpServerAccount,
): Promise<void> {
  // 全局防重入：同一 config+asset+account 的并发连接请求只跑一次。
  // 覆盖三条入口：(1) popup window emit → setupJumpServerEventListener，
  // (2) jumpserver-panel.ts 的 handleAssetConnect 直接调用，(3) 任何未来新增的路径。
  const reentryKey = `${config.name}::${asset.id}::${account.id}`;
  if (inFlightConnects.has(reentryKey)) {
    console.warn('[jumpserver] connectToAsset re-entry blocked:', reentryKey);
    return;
  }
  inFlightConnects.add(reentryKey);

  const terminalPanelEl = document.getElementById('terminal-panel') as HTMLDivElement;

  let jsTabId = '';
  let jsPaneId = '';

  // Clean up the placeholder tab on early exit (MFA cancel) or failure.
  // Centralized here because we now create the tab BEFORE any slow API
  // call, so several code paths may need to back it out.
  const cleanupTab = async (): Promise<void> => {
    removeSSHConnectingPlaceholder();
    if (!jsTabId) return;
    const failedTab = TabManager.tabs.find((tab) => tab.id === jsTabId);
    if (!failedTab) return;
    const idx = TabManager.tabs.indexOf(failedTab);
    if (idx >= 0) TabManager.tabs.splice(idx, 1);
    if (TabManager.tabs.length > 0) {
      TabManager.activeTabId = TabManager.tabs[TabManager.tabs.length - 1].id;
      await activateTab(TabManager.activeTabId);
    } else {
      TabManager.activeTabId = null;
      showHomeView();
    }
    TabManager.notify();
    renderTabs();
  };

  try {
    // Step 1: Create the tab + placeholder IMMEDIATELY, before any slow
    // JumpServer API call. Previously the auth + token-create round-trips
    // happened first, so the user saw nothing for a few seconds after
    // clicking "connect". The placeholder now appears instantly and
    // narrates the stages as we go.
    const { generatePaneId: genPaneId } = await import('./split-pane');
    jsPaneId = genPaneId();
    jsTabId = `tab-js-${Date.now().toString(36)}`;
    const placeholderSessionId = `pending-${jsTabId}`;
    const tab: Tab = {
      id: jsTabId,
      splitRoot: { type: 'leaf', id: jsPaneId, sessionId: placeholderSessionId },
      focusedPaneId: jsPaneId,
      title: asset.name || asset.address,
      status: 'connecting' as const,
      paneCounterNext: 2,
      paneNumbers: new Map([[jsPaneId, 1]]),
    };
    TabManager.tabs.push(tab);
    TabManager.activeTabId = jsTabId;
    TabManager.notify();
    StatusBar.setConnection('connecting', `${asset.name || asset.address}`);
    renderTabs();

    setViewMode('terminal');
    hideHomeView();
    hideGalleryView();
    SplitPaneManager.destroy(terminalPanelEl);
    TerminalRegistry.hideAll(terminalPanelEl);
    DrawerManager.hideAll();
    AICapsuleManager.hideAll();
    showConnectingPlaceholder(
      t('jsConnectingAsset').replace('{name}', asset.name || asset.address),
    );

    // Secondary windows restore metadata only. Native fixed operations perform
    // all stored-credential materialization.
    config = stripJumpServerCredentialFields(config);

    // Step 2: Set proxy mode before authentication. A mode change clears the
    // native client pool, so doing this after auth would discard that login.
    const proxyMode = config.bypassProxy !== false ? 'direct' : 'system';
    await invoke('set_proxy_mode', { mode: proxyMode });

    // Step 3: Ensure JumpServer auth (cached → instant; expired → network
    // round-trip; password expired → MFA dialog). User can cancel MFA,
    // which returns false — that's a "no-op cancel", not an error.
    updateConnectingPlaceholder(t('jsConnectingAuth'));
    const authed = await ensureJSAuthenticated(config);
    if (!authed) {
      await cleanupTab();
      return;
    }

    // Step 4: The fixed Rust broker creates and consumes the per-connection
    // credential while opening Koko SSH. The WebView never receives it.
    updateConnectingPlaceholder(t('jsConnectingToken'));
    const connect = () => createBoundJumpServerSshSession(config, asset, account);
    let sessionId: string;
    try {
      sessionId = await connect();
    } catch (err) {
      if (isJumpServerSessionExpired(err)) {
        markSessionExpired(config.name);
        updateConnectingPlaceholder(t('jsConnectingAuth'));
        const ok = await ensureJSAuthenticated(config, true);
        if (!ok) {
          await cleanupTab();
          return;
        }
        updateConnectingPlaceholder(t('jsConnectingToken'));
        sessionId = await connect();
      } else {
        throw err;
      }
    }

    // Keep only display/reconnect metadata in WebView state. In particular,
    // neither JMS username nor password is cached in sshConfigMap.
    const sshConfig = {
      name: `${config.name} → ${asset.name}`,
      host: config.sshHost,
      port: config.sshPort || 2222,
      username: account.username,
      authMethod: 'password' as const,
      password: '',
      skipShellHook: true,
      multiplexSftp: true,
      proxyType: config.proxyType,
      proxyHost: config.proxyHost,
      proxyPort: config.proxyPort,
      proxyUsername: config.proxyUsername,
    };

    updateConnectingPlaceholder(
      `${t('connecting')} ${account.username}@${asset.address}:${sshConfig.port}...`,
    );
    StatusBar.setConnection('connecting', `${account.username}@${asset.address}`);

    sshConfigMap.set(sessionId, sshConfig);
    jumpServerConfigMap.set(sessionId, {
      config,
      asset,
      account,
    });

    // Check if tab was closed during connection
    const existingTab = TabManager.tabs.find((t) => t.id === jsTabId);
    if (!existingTab) return;

    // Update tab with real session ID
    existingTab.splitRoot = { type: 'leaf', id: jsPaneId, sessionId };

    TerminalRegistry.create(
      sessionId,
      port,
      authToken,
      (status) => {
        const foundTab = TabManager.tabs.find((t) => t.id === jsTabId);
        if (foundTab) {
          foundTab.status = status;
          TabManager.notify();
        }
        if ((status === 'ended' || status === 'disconnected' || status === 'notfound') && sshConfigMap.has(sessionId)) {
          // Clear any stale reclaim overlay (can appear when WebSocket reconnects with viewer role)
          reclaimSessionIds.delete(sessionId);
          hideReclaimButton();
          showReconnectOverlay(sessionId, jsTabId);
        }
      },
      () => {
        // JumpServer sessions: keep asset name as tab title, ignore terminal title updates
      },
    );

    TabManager.notify();
    DrawerManager.create(sessionId, 'ssh');

    removeSSHConnectingPlaceholder();
    await activateTab(jsTabId);
    DrawerManager.updateServerInfo(sessionId, {
      host: asset.address,
      username: account.username,
      port: getSSHPort(asset),
    });
    StatusBar.setConnection('connected', `${account.username}@${asset.address}`);
    renderTabs();

    // Record asset connection history for frequency-based sorting
    recordJSAssetConnection(config.name, asset.id, asset.name, asset.address, account.username, account.id);

  } catch (err) {
    await cleanupTab();
    StatusBar.setError(`JumpServer: ${extractErrorMsg(String(err))}`);
    throw err; // Re-throw so asset browser can show error and keep dialog open
  } finally {
    inFlightConnects.delete(reentryKey);
  }
}

export async function createBoundJumpServerSshSession(
  config: JumpServerConfig,
  asset: JumpServerAsset,
  account: JumpServerAccount,
  trustedFingerprint?: string,
): Promise<string> {
  const { status, body } = await createJumpServerSshSession(
    config,
    asset,
    account,
    trustedFingerprint,
  );
  if (status === 201 && typeof body.id === 'string') return body.id;

  const error = typeof body.error === 'string' ? body.error : '';
  if (status === 409 && (error === 'host_key_unknown' || error === 'host_key_mismatch')) {
    const hostname = typeof body.hostname === 'string' ? body.hostname : config.sshHost;
    const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint : '';
    const keyType = typeof body.key_type === 'string' ? body.key_type : '';
    if (error === 'host_key_mismatch') {
      throw new Error(t('sshHostKeyMismatchMsg')
        .replace('{hostname}', hostname)
        .replace('{fingerprint}', fingerprint)
        .replace('{keyType}', keyType));
    }
    const confirmed = await showHostKeyConfirmDialog(hostname, fingerprint, keyType);
    if (!confirmed) throw new Error('Connection cancelled by user');
    return createBoundJumpServerSshSession(config, asset, account, fingerprint);
  }
  const typed = parseJumpServerError(error);
  if (typed) throw typed;
  throw new Error(error || `JumpServer SSH failed (HTTP ${status})`);
}

/**
 * Extract SSH port from asset protocols.
 */
function getSSHPort(asset: JumpServerAsset): number {
  const sshProto = (asset.protocols || []).find(p => p.name === 'ssh');
  return sshProto?.port || 22;
}

/**
 * Persist metadata-only active JumpServer state so new main windows can inherit
 * session presence. Credentials remain exclusively in memory/Keychain.
 */
export function syncActiveJumpServersToStorage(): void {
  const data: Record<string, JumpServerConfig> = {};
  for (const [name, config] of activeJumpServers) {
    data[name] = stripJumpServerSecrets(config);
  }
  localStorage.setItem('meterm-active-jumpservers', JSON.stringify(data));
}

/**
 * Clear stale JumpServer state from localStorage (called on app restart).
 */
export function clearActiveJumpServersStorage(): void {
  localStorage.removeItem('meterm-active-jumpservers');
  clearLegacyJumpServerBrowserStorage();
  activeJumpServers.clear();
}

/**
 * Restore metadata-only activeJumpServers state (for new main windows).
 */
export function restoreActiveJumpServersFromStorage(): void {
  const saved = localStorage.getItem('meterm-active-jumpservers');
  if (!saved) return;
  try {
    const data: Record<string, JumpServerConfig> = JSON.parse(saved);
    const sanitizedData: Record<string, JumpServerConfig> = {};
    for (const [name, config] of Object.entries(data)) {
      const sanitized = stripJumpServerSecrets(config);
      sanitizedData[name] = sanitized;
      if (!activeJumpServers.has(name)) {
        activeJumpServers.set(name, sanitized);
      }
    }
    // Immediately scrub legacy versions that persisted full credentials.
    localStorage.setItem('meterm-active-jumpservers', JSON.stringify(sanitizedData));
  } catch { /* ignore parse errors */ }
}

/**
 * Listen for asset selection events from the standalone browser window.
 * Should be called once during main window initialization.
 * Only the last-focused main window will handle the event.
 */
export function setupJumpServerEventListener(): void {
  void listen<unknown>('jumpserver-connect-asset', async (event) => {
    // Only handle in the last-focused main window to avoid duplicate sessions
    const currentLabel = getCurrentWindow().label;
    if (currentLabel !== lastFocusedMainWindowLabel) return;

    const configName = readBrowserConfigName(event.payload);
    if (!configName || !isRecord(event.payload)
      || !isRecord(event.payload.asset) || !isRecord(event.payload.account)) return;
    const selection = resolveJumpServerBrowserSelection(
      configName,
      event.payload.asset.id,
      event.payload.account.id,
    );
    if (!selection) return;
    const { asset, account } = selection;
    const config = activeJumpServers.get(configName);
    if (!config) {
      console.error('[jumpserver] No active config found for:', configName);
      return;
    }

    // Focus this main window before creating the session.
    // 防重入由 connectToAsset 内部 inFlightConnects 处理，这里仅做 await 保证
    // 串行：listener 在前一个 await 完成前不会处理下一个事件。
    await getCurrentWindow().setFocus();
    try {
      await connectToAsset(config, asset, account);
    } catch (e) {
      console.error('[jumpserver] connectToAsset failed:', e);
    }
  });

  // Listen for dock-to-panel event — close popup, open side panel in main window
  void listen<unknown>('jumpserver-dock-to-panel', async (event) => {
    const currentLabel = getCurrentWindow().label;
    if (currentLabel !== lastFocusedMainWindowLabel) return;

    const configName = readBrowserConfigName(event.payload);
    if (!configName) return;
    const config = activeJumpServers.get(configName);
    if (!config) return;

    await getCurrentWindow().setFocus();
    const { openJumpServerPanel } = await import('./jumpserver-panel');
    openJumpServerPanel(config);
  });

  // Listen for snap-dock event — reposition popup to main window's right edge
  void listen<unknown>('jumpserver-snap-dock', async (event) => {
    const currentLabel = getCurrentWindow().label;
    if (currentLabel !== lastFocusedMainWindowLabel) return;

    const configName = readBrowserConfigName(event.payload);
    if (!configName) return;
    const config = activeJumpServers.get(configName);
    if (!config) return;

    await getCurrentWindow().setFocus();
    const { startDockedBrowser } = await import('./jumpserver-panel');
    await startDockedBrowser(config);
  });

  // Listen for session-expired event from pop-out window — reopen panel in main window
  void listen<unknown>('jumpserver-session-expired-reopen', async (event) => {
    const currentLabel = getCurrentWindow().label;
    if (currentLabel !== lastFocusedMainWindowLabel) return;

    const configName = readBrowserConfigName(event.payload);
    if (!configName) return;
    const config = activeJumpServers.get(configName);
    if (!config) return;

    // Mark as expired so the panel renders its banner immediately
    const { markSessionExpired } = await import('./jumpserver-auth-state');
    markSessionExpired(configName);

    await getCurrentWindow().setFocus();
    const { openJumpServerPanel } = await import('./jumpserver-panel');
    openJumpServerPanel(config);
  });
}
