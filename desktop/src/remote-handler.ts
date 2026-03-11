/**
 * remote-handler.ts — Remote session connection handler
 *
 * Extracted from main.ts init() closure.
 */

import { TabManager, type Tab } from './tabs';
import { TerminalRegistry } from './terminal';
import { StatusBar } from './status-bar';
import { t } from './i18n';
import {
  exitViewerMode, showKickedOverlay,
} from './overlays';
import { activateTab, setViewMode, hideHomeView, hideGalleryView } from './view-manager';
import { renderTabs } from './tab-renderer';
import { addRecentRemoteConnection, loadRemoteToken, remoteWsBase, type RemoteServerInfo } from './remote';
import {
  remoteInfoMap, remoteTabNumbers, incrementNextRemoteTabNumber,
} from './app-state';

export async function handleRemoteConnect(info: RemoteServerInfo, sessionId: string): Promise<void> {
  // If this session is already open, switch to its tab instead of creating a new one
  if (remoteInfoMap.has(sessionId)) {
    const existingTab = TabManager.findTabBySessionId(sessionId);
    if (existingTab) {
      TabManager.activate(existingTab.id);
      await activateTab(existingTab.id);
      renderTabs();
      return;
    }
  }

  // Load token from keychain if not present in info (e.g., from saved/recent card)
  let token = info.token;
  if (!token) {
    token = await loadRemoteToken(info.host, info.port) || '';
  }

  const wsUrl = `${remoteWsBase(info)}/ws/${sessionId}`;
  const remoteTabId = `tab-remote-${Date.now().toString(36)}`;
  const { generatePaneId: genPaneId } = await import('./split-pane');
  const remotePaneId = genPaneId();
  const remoteTitle = `${info.name || info.host} (${t('remoteViewerMode')})`;

  const tab: Tab = {
    id: remoteTabId,
    splitRoot: { type: 'leaf', id: remotePaneId, sessionId },
    focusedPaneId: remotePaneId,
    title: remoteTitle,
    status: 'connecting' as const,
  };
  TabManager.tabs.push(tab);
  TabManager.activeTabId = remoteTabId;
  remoteInfoMap.set(sessionId, { ...info, token });
  remoteTabNumbers.set(sessionId, incrementNextRemoteTabNumber());
  addRecentRemoteConnection(info);
  document.dispatchEvent(new CustomEvent('remote-connections-changed'));
  TabManager.notify();
  renderTabs();

  setViewMode('terminal');
  hideHomeView();
  hideGalleryView();

  const mt = TerminalRegistry.createRemote(
    sessionId,
    wsUrl,
    token,
    (status) => {
      const foundTab = TabManager.tabs.find((t) => t.id === remoteTabId);
      if (foundTab) {
        foundTab.status = status;
        TabManager.notify();
      }
      if (status === 'ended') {
        exitViewerMode(sessionId);
        showKickedOverlay(sessionId, t('remoteSessionClosed'));
        renderTabs();
      }
    },
    (title) => {
      const foundTab = TabManager.tabs.find((t) => t.id === remoteTabId);
      if (foundTab) {
        foundTab.title = title || foundTab.title;
        TabManager.notify();
      }
    },
  );

  StatusBar.setConnection('connected', `${info.host}:${info.port}`);
  await activateTab(remoteTabId);
  renderTabs();
}
