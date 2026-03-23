/**
 * session-actions.ts — Session lifecycle operations
 *
 * Extracted from main.ts. Contains:
 * - createNewSession(), createNewPrivateSession()
 * - doSplitPane()
 * - closeAllSessions()
 * - ensureMeTermReady()
 * - createNewWindowNearCurrent()
 */

import { waitForMeTerm } from './connection';
import { TabManager } from './tabs';
import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { getDefaultShellPath } from './context-menu';
import { AICapsuleManager } from './ai-capsule';
import { SplitPaneManager, getAllLeaves, findLeafById } from './split-pane';
import { StatusBar } from './status-bar';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createWindowAtPosition } from './window-utils';
import { startPairPoller } from './pairing';
import {
  removeKickedOverlay, removeReconnectOverlay,
  viewerModeSessionIds, privateSessionIds,
  reclaimSessionIds,
} from './overlays';
import { activateTab, showHomeView } from './view-manager';
import {
  port, authToken, metermReady, setPort, setAuthToken, setMetermReady,
  settings,
  sshConfigMap, remoteInfoMap, sessionProgressMap,
  remoteTabNumbers, jumpServerConfigMap,
} from './app-state';

// ── Late-bound callbacks ──

let _renderTabs: () => void = () => {};
let _renderToolbarActions: () => void = () => {};

export function setSessionActionsCallbacks(cbs: {
  renderTabs: () => void;
  renderToolbarActions: () => void;
}): void {
  _renderTabs = cbs.renderTabs;
  _renderToolbarActions = cbs.renderToolbarActions;
}

// ── Exported functions ──

export async function doSplitPane(
  tabId: string,
  paneId: string,
  direction: 'horizontal' | 'vertical',
): Promise<void> {
  const tab = TabManager.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const focusedLeaf = findLeafById(tab.splitRoot, paneId);
  const sshConfig = focusedLeaf ? sshConfigMap.get(focusedLeaf.sessionId) : undefined;
  const result = await TabManager.splitPane(tabId, paneId, direction, port, authToken, sshConfig);
  if (result && sshConfig) {
    sshConfigMap.set(result.sessionId, sshConfig);
    DrawerManager.create(result.sessionId, 'ssh');
    DrawerManager.updateServerInfo(result.sessionId, {
      host: sshConfig.host,
      username: sshConfig.username,
      port: sshConfig.port,
    });
  }
}

export async function createNewSession(shell?: string, cwd?: string): Promise<void> {
  const ready = await ensureMeTermReady();
  if (!ready) {
    return;
  }
  // Use configured default shell when no specific shell is requested.
  // Resolve from cached shell list so the tab title matches the actual shell.
  const effectiveShell = shell || settings.defaultShell || getDefaultShellPath() || undefined;
  await TabManager.addTab(port, authToken, effectiveShell, cwd);
  if (TabManager.activeTabId) {
    await activateTab(TabManager.activeTabId);
    StatusBar.setConnection('connected', 'Local');
  }
  _renderTabs();
}

export async function createNewPrivateSession(): Promise<void> {
  const ready = await ensureMeTermReady();
  if (!ready) return;
  const effectiveShell = settings.defaultShell || getDefaultShellPath() || undefined;
  await TabManager.addTab(port, authToken, effectiveShell);
  if (TabManager.activeTabId) {
    const sessionId = TabManager.getActiveSessionId();
    if (sessionId) {
      try {
        await invoke('set_session_private', { sessionId, private: true });
        privateSessionIds.add(sessionId);
      } catch (err) {
        console.error('set_session_private failed:', err);
      }
    }
    await activateTab(TabManager.activeTabId);
    StatusBar.setConnection('connected', 'Local');
  }
  _renderTabs();
}

export async function ensureMeTermReady(): Promise<boolean> {
  if (metermReady && port > 0 && authToken) {
    return true;
  }
  StatusBar.setConnection('connecting', 'Starting...');
  try {
    const info = await waitForMeTerm(40, 300);
    setPort(info.port);
    setAuthToken(info.token);
    setMetermReady(true);
    StatusBar.setConnection('connected', 'Local');
    startPairPoller(port, authToken);
    return true;
  } catch (err) {
    setMetermReady(false);
    StatusBar.setError(`Failed to start meterm: ${String(err)}`);
    return false;
  }
}

export async function closeAllSessions(): Promise<void> {
  const terminalPanelEl = document.getElementById('terminal-panel') as HTMLDivElement;
  // Destroy drawers/AI for all sessions across all tabs
  for (const tab of TabManager.tabs) {
    const leaves = getAllLeaves(tab.splitRoot);
    for (const leaf of leaves) {
      DrawerManager.destroy(leaf.sessionId);
      AICapsuleManager.destroy(leaf.sessionId);
      sshConfigMap.delete(leaf.sessionId);
      remoteInfoMap.delete(leaf.sessionId);
      jumpServerConfigMap.delete(leaf.sessionId);
      remoteTabNumbers.delete(leaf.sessionId);
      viewerModeSessionIds.delete(leaf.sessionId);
      reclaimSessionIds.delete(leaf.sessionId);
      sessionProgressMap.delete(leaf.sessionId);
      removeKickedOverlay(leaf.sessionId);
      removeReconnectOverlay(leaf.sessionId);
    }
  }
  const tabIds = TabManager.tabs.map((tab) => tab.id);
  for (const tabId of tabIds) {
    await TabManager.closeTab(tabId);
  }
  SplitPaneManager.destroy(terminalPanelEl);
  showHomeView();
  _renderTabs();
  _renderToolbarActions();
}

export async function createNewWindowNearCurrent(): Promise<void> {
  try {
    const [x, y] = await invoke<[number, number]>('get_window_position');
    const size = await getCurrentWindow().innerSize();
    const factor = window.devicePixelRatio || 1;
    const logicalWidth = size.width / factor;
    await createWindowAtPosition(x + logicalWidth / 2, y + 28);
  } catch {
    await createWindowAtPosition(260, 120);
  }
}
