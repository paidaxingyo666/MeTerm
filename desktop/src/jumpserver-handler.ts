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
  showSSHConnectingPlaceholder, removeSSHConnectingPlaceholder,
  showReconnectOverlay, reclaimSessionIds, hideReclaimButton,
} from './overlays';
import { activateTab, setViewMode, hideHomeView, hideGalleryView } from './view-manager';
import { ensureMeTermReady } from './session-actions';
import { renderTabs } from './tab-renderer';
import { renderToolbarActions } from './toolbar';
import { createSSHSession, type SSHConnectionConfig } from './ssh';
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
  authenticate,
  authenticateWithToken,
  submitMFA,
  loadJSSecrets,
  createConnectionToken,
} from './jumpserver-api';
import { showMFADialog } from './jumpserver-ui';
import { openJumpServerBrowserWindow } from './jumpserver-browser';

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
 * Full JumpServer connection flow:
 * authenticate → (MFA) → browse assets → select → SSH connect → auto-navigate
 */
export async function handleJumpServerConnect(config: JumpServerConfig): Promise<void> {
  const ready = await ensureMeTermReady();
  if (!ready) return;

  // Step 1: Load secrets from keychain
  const secrets = await loadJSSecrets(config.name);
  const fullConfig: JumpServerConfig = {
    ...config,
    password: config.password || secrets.password,
    apiToken: config.apiToken || secrets.apiToken,
  };

  // Step 2: Authenticate
  StatusBar.setConnection('connecting', `JumpServer: ${config.name}`);

  try {
    let authResult;
    if (fullConfig.authMethod === 'token' && fullConfig.apiToken) {
      authResult = await authenticateWithToken(fullConfig);
    } else {
      authResult = await authenticate(fullConfig);
    }

    if (!authResult.ok) {
      StatusBar.setError(`JumpServer: ${extractErrorMsg(authResult.error)}`);
      return;
    }

    // Step 3: Handle MFA if required (loop to allow retries)
    if (authResult.mfa_required) {
      let mfaOk = false;
      let mfaError: string | undefined;
      const choices = authResult.mfa_choices || ['otp'];
      while (!mfaOk) {
        const mfaInput = await showMFADialog(choices, mfaError);
        if (!mfaInput) {
          StatusBar.setConnection('disconnected', '');
          return;
        }

        const mfaResult = await submitMFA(fullConfig.baseUrl, mfaInput.type, mfaInput.code);
        if (mfaResult.ok) {
          mfaOk = true;
        } else {
          mfaError = extractErrorMsg(mfaResult.error);
          // Loop continues — showMFADialog will be called again with error shown
        }
      }
      // Re-auth after MFA is handled by the Go backend (ReAuthenticate)
      // Do NOT call authenticate() here — it would resetJSClient and destroy the session
    }

    // Register as active JumpServer (enables toolbar button for re-opening asset browser)
    activeJumpServers.set(fullConfig.name, fullConfig);
    syncActiveJumpServersToStorage();
    void emit('jumpserver-state-changed');
    renderToolbarActions();

    // Step 4: Open standalone asset browser window
    await openJumpServerBrowserWindow(fullConfig);
    StatusBar.setConnection('connected', `JumpServer: ${fullConfig.name}`);
  } catch (err) {
    StatusBar.setError(`JumpServer: ${extractErrorMsg(String(err))}`);
  }
}

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
  const terminalPanelEl = document.getElementById('terminal-panel') as HTMLDivElement;

  // Step 1: Create connection token via JumpServer API
  const tokenResult = await createConnectionToken(
    config.baseUrl, asset.id, account.username, account.id, 'ssh',
  );
  if (!tokenResult.ok || !tokenResult.token) {
    throw new Error(tokenResult.error || 'Failed to create connection token');
  }

  // Step 2: Create SSH config using connection token
  // Koko accepts JMS-{token} as username, with secret as password
  const sshConfig: SSHConnectionConfig = {
    name: `${config.name} → ${asset.name}`,
    host: config.sshHost,
    port: config.sshPort || 2222,
    username: `JMS-${tokenResult.token}`,
    authMethod: 'password',
    password: tokenResult.secret || tokenResult.token || '',
    skipShellHook: true,
  };

  let jsTabId = '';
  try {
    // Create tab with placeholder
    const { generatePaneId: genPaneId } = await import('./split-pane');
    const jsPaneId = genPaneId();
    jsTabId = `tab-js-${Date.now().toString(36)}`;
    const placeholderSessionId = `pending-${jsTabId}`;
    const tab: Tab = {
      id: jsTabId,
      splitRoot: { type: 'leaf', id: jsPaneId, sessionId: placeholderSessionId },
      focusedPaneId: jsPaneId,
      title: asset.name || asset.address,
      status: 'connecting' as const,
    };
    TabManager.tabs.push(tab);
    TabManager.activeTabId = jsTabId;
    TabManager.notify();
    StatusBar.setConnection('connecting', `${account.username}@${asset.address}`);
    renderTabs();

    // Show placeholder
    setViewMode('terminal');
    hideHomeView();
    hideGalleryView();
    SplitPaneManager.destroy(terminalPanelEl);
    TerminalRegistry.hideAll(terminalPanelEl);
    DrawerManager.hideAll();
    AICapsuleManager.hideAll();
    showSSHConnectingPlaceholder(sshConfig);

    // Create SSH session to JumpServer Koko
    const sessionId = await createSSHSession(sshConfig);
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

  } catch (err) {
    removeSSHConnectingPlaceholder();
    if (jsTabId) {
      const failedTab = TabManager.tabs.find((t) => t.id === jsTabId);
      if (failedTab) {
        const idx = TabManager.tabs.indexOf(failedTab);
        if (idx >= 0) TabManager.tabs.splice(idx, 1);
        if (TabManager.tabs.length > 0) {
          TabManager.activeTabId = TabManager.tabs[TabManager.tabs.length - 1].id;
          await activateTab(TabManager.activeTabId);
        } else {
          TabManager.activeTabId = null;
          const { showHomeView } = await import('./view-manager');
          showHomeView();
        }
        TabManager.notify();
      }
    }
    renderTabs();
    StatusBar.setError(`JumpServer: ${extractErrorMsg(String(err))}`);
    throw err; // Re-throw so asset browser can show error and keep dialog open
  }
}

/**
 * Extract SSH port from asset protocols.
 */
function getSSHPort(asset: JumpServerAsset): number {
  const sshProto = (asset.protocols || []).find(p => p.name === 'ssh');
  return sshProto?.port || 22;
}

/**
 * Persist activeJumpServers to localStorage so new windows can inherit the state.
 * Also emits a Tauri event so existing windows can sync.
 */
export function syncActiveJumpServersToStorage(): void {
  const data: Record<string, JumpServerConfig> = {};
  for (const [name, config] of activeJumpServers) {
    data[name] = config;
  }
  localStorage.setItem('meterm-active-jumpservers', JSON.stringify(data));
}

/**
 * Clear stale JumpServer state from localStorage (called on app restart).
 */
export function clearActiveJumpServersStorage(): void {
  localStorage.removeItem('meterm-active-jumpservers');
  activeJumpServers.clear();
}

/**
 * Restore activeJumpServers from localStorage (for new windows).
 */
export function restoreActiveJumpServersFromStorage(): void {
  const saved = localStorage.getItem('meterm-active-jumpservers');
  if (!saved) return;
  try {
    const data: Record<string, JumpServerConfig> = JSON.parse(saved);
    for (const [name, config] of Object.entries(data)) {
      if (!activeJumpServers.has(name)) {
        activeJumpServers.set(name, config);
      }
    }
  } catch { /* ignore parse errors */ }
}

/**
 * Listen for asset selection events from the standalone browser window.
 * Should be called once during main window initialization.
 * Only the last-focused main window will handle the event.
 */
export function setupJumpServerEventListener(): void {
  void listen<{
    configName: string;
    asset: JumpServerAsset;
    account: JumpServerAccount;
  }>('jumpserver-connect-asset', async (event) => {
    // Only handle in the last-focused main window to avoid duplicate sessions
    const currentLabel = getCurrentWindow().label;
    if (currentLabel !== lastFocusedMainWindowLabel) return;

    const { configName, asset, account } = event.payload;
    const config = activeJumpServers.get(configName);
    if (!config) {
      console.error('[jumpserver] No active config found for:', configName);
      return;
    }

    // Focus this main window before creating the session
    await getCurrentWindow().setFocus();
    void connectToAsset(config, asset, account);
  });

  // Listen for dock-to-panel event — close popup, open side panel in main window
  void listen<{ configName: string }>('jumpserver-dock-to-panel', async (event) => {
    const currentLabel = getCurrentWindow().label;
    if (currentLabel !== lastFocusedMainWindowLabel) return;

    const { configName } = event.payload;
    const config = activeJumpServers.get(configName);
    if (!config) return;

    await getCurrentWindow().setFocus();
    const { openJumpServerPanel } = await import('./jumpserver-panel');
    openJumpServerPanel(config);
  });

  // Listen for snap-dock event — reposition popup to main window's right edge
  void listen<{ configName: string }>('jumpserver-snap-dock', async (event) => {
    const currentLabel = getCurrentWindow().label;
    if (currentLabel !== lastFocusedMainWindowLabel) return;

    const { configName } = event.payload;
    const config = activeJumpServers.get(configName);
    if (!config) return;

    await getCurrentWindow().setFocus();
    const { startDockedBrowser } = await import('./jumpserver-panel');
    await startDockedBrowser(config);
  });
}
