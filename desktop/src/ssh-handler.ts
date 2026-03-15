/**
 * ssh-handler.ts — SSH connection handler
 *
 * Extracted from main.ts init() closure.
 */

import { TabManager, type Tab } from './tabs';
import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { AICapsuleManager } from './ai-capsule';
import { SplitPaneManager } from './split-pane';
import { StatusBar } from './status-bar';
import { t } from './i18n';
import {
  showSSHConnectingPlaceholder, removeSSHConnectingPlaceholder,
  showReconnectOverlay, reclaimSessionIds, hideReclaimButton,
} from './overlays';
import { activateTab, showHomeView, setViewMode, hideHomeView, hideGalleryView } from './view-manager';
import { ensureMeTermReady } from './session-actions';
import { renderTabs } from './tab-renderer';
import { createSSHSession, addConnection, addRecentConnection, showAuthFailedDialog, updateSavedPassword, type SSHConnectionConfig } from './ssh';
import {
  port, authToken,
  sshConfigMap,
} from './app-state';

export async function handleSSHConnect(config: SSHConnectionConfig): Promise<void> {
  const terminalPanelEl = document.getElementById('terminal-panel') as HTMLDivElement;
  const ready = await ensureMeTermReady();
  if (!ready) return;

  let sshTabId = '';
  try {
    // Create tab immediately with placeholder — don't wait for SSH connection
    const { generatePaneId: genPaneId } = await import('./split-pane');
    const sshPaneId = genPaneId();
    sshTabId = `tab-ssh-${Date.now().toString(36)}`;
    const placeholderSessionId = `pending-${sshTabId}`;
    const tab: Tab = {
      id: sshTabId,
      splitRoot: { type: 'leaf', id: sshPaneId, sessionId: placeholderSessionId },
      focusedPaneId: sshPaneId,
      title: `${config.name || config.host} (SSH)`,
      status: 'connecting' as const,
    };
    TabManager.tabs.push(tab);
    TabManager.activeTabId = sshTabId;
    TabManager.notify();
    StatusBar.setConnection('connecting', `${config.username}@${config.host}`);
    renderTabs();

    // Show connecting placeholder in terminal panel
    setViewMode('terminal');
    hideHomeView();
    hideGalleryView();
    SplitPaneManager.destroy(terminalPanelEl);
    TerminalRegistry.hideAll(terminalPanelEl);
    DrawerManager.hideAll();
    AICapsuleManager.hideAll();
    showSSHConnectingPlaceholder(config);

    // SSH connection happens in the background while tab is already visible
    const sessionId = await createSSHSession(config);
    sshConfigMap.set(sessionId, config);

    // Save connection for future use
    addConnection(config);
    addRecentConnection(config);

    // Check if tab was closed while we were connecting
    const existingTab = TabManager.tabs.find((t) => t.id === sshTabId);
    if (!existingTab) return;

    // Update tab with real session ID
    existingTab.splitRoot = { type: 'leaf', id: sshPaneId, sessionId };

    TerminalRegistry.create(
      sessionId,
      port,
      authToken,
      (status) => {
        const foundTab = TabManager.tabs.find((t) => t.id === sshTabId);
        if (foundTab) {
          foundTab.status = status;
          TabManager.notify();
        }
        // Show reconnect overlay when SSH session dies
        if ((status === 'ended' || status === 'disconnected' || status === 'notfound') && sshConfigMap.has(sessionId)) {
          // Clear any stale reclaim overlay (can appear when WebSocket reconnects with viewer role)
          reclaimSessionIds.delete(sessionId);
          hideReclaimButton();
          showReconnectOverlay(sessionId, sshTabId);
        }
      },
      (title) => {
        const foundTab = TabManager.tabs.find((t) => t.id === sshTabId);
        if (foundTab) {
          foundTab.title = title || foundTab.title;
          TabManager.notify();
        }
      },
    );

    TabManager.notify();
    DrawerManager.create(sessionId, 'ssh');
    // 必须在 activateTab 之前设置 serverConnectionInfo，
    // 否则 WebSocket onopen 触发 setWebSocket 时 serverConnectionInfo 还是 null，
    // 导致 SSH 会话错误地用 '/' 而非 '.' 作为初始路径
    DrawerManager.updateServerInfo(sessionId, {
      host: config.host,
      username: config.username,
      port: config.port
    });

    // Remove placeholder and activate real terminal
    removeSSHConnectingPlaceholder();
    await activateTab(sshTabId);
    StatusBar.setConnection('connected', `${config.username}@${config.host}`);
    renderTabs();
  } catch (err) {
    const errStr = String(err);
    const isAuthFailure = config.authMethod === 'password' && config.name &&
      /unable to authenticate|permission denied|auth/i.test(errStr);

    // Auth failure for saved connection — offer password re-entry
    if (isAuthFailure) {
      removeSSHConnectingPlaceholder();
      const newPassword = await showAuthFailedDialog(config);
      if (newPassword) {
        // Update saved password and retry
        await updateSavedPassword(config.name, newPassword);
        // Clean up the failed tab before retry
        if (sshTabId) {
          const failedTab = TabManager.tabs.find((t) => t.id === sshTabId);
          if (failedTab) {
            const idx = TabManager.tabs.indexOf(failedTab);
            if (idx >= 0) TabManager.tabs.splice(idx, 1);
          }
        }
        renderTabs();
        // Retry with new password
        return handleSSHConnect({ ...config, password: newPassword });
      }
    }

    // Remove placeholder and clean up failed tab
    removeSSHConnectingPlaceholder();
    if (sshTabId) {
      const failedTab = TabManager.tabs.find((t) => t.id === sshTabId);
      if (failedTab) {
        const idx = TabManager.tabs.indexOf(failedTab);
        if (idx >= 0) TabManager.tabs.splice(idx, 1);
        // Activate another tab or go home
        if (TabManager.tabs.length > 0) {
          TabManager.activeTabId = TabManager.tabs[TabManager.tabs.length - 1].id;
          await activateTab(TabManager.activeTabId);
        } else {
          TabManager.activeTabId = null;
          showHomeView();
        }
        TabManager.notify();
      }
    }
    renderTabs();
    StatusBar.setError(`${t('sshFailed')}: ${errStr}`);
  }
}
