// Styles - modular CSS imports (order matters for cascade)
import './styles/themes.css';
import './styles/base.css';
import './styles/toolbar.css';
import './styles/status-bar.css';
import './styles/terminal.css';
import './styles/update.css';
import './styles/home.css';
import './styles/settings.css';
import './styles/ssh-modal.css';
import './styles/drawer.css';
import './styles/drawer-sidebar.css';
import './styles/ai-bar.css';
import './styles/split-pane.css';
import './styles/ai-chat.css';
import './styles/ai-settings.css';
import './styles/pairing.css';
import './styles/sharing.css';
import './styles/remote.css';
import './styles/jumpserver.css';
import './styles/osc-progress.css';
import './styles/viewer-popup.css';
import './styles/toast.css';
import './styles/misc.css';
import '@xterm/xterm/css/xterm.css';

import { TabManager } from './tabs';
import { TerminalRegistry } from './terminal';
import { loadSettings } from './themes';
import { applyWindowOpacity, applyAiBarOpacity, applyColorScheme, applyBackgroundImage } from './appearance';
import { setHomeViewSettings } from './home';
import { setGalleryViewSettings, setGalleryProgressGetter } from './gallery';
import { initSettingsWindow } from './settings-window';
import { initUpdaterWindow } from './updater-window';
import { initAboutWindow } from './about-window';
import { initJumpServerBrowserWindow } from './jumpserver-browser-window';
import { initLanguage, setLanguage } from './i18n';
import { setSSHConnectHandler, migrateSSHCredentials } from './ssh';
import { setRemoteConnectHandler, migrateRemoteCredentials } from './remote';
import { setupTabTransferListener, type TabTransferSessionInfo } from './tab-drag';
import { escapeHtml } from './status-bar';
import { StatusBar } from './status-bar';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { syncTrayLanguage, setCloseAllSessionsHandler } from './window-lifecycle';
import { LogicalSize } from '@tauri-apps/api/dpi';
import {
  setViewManagerCallbacks,
  activateTab,
  showHomeView,
} from './view-manager';
import {
  setSessionActionsCallbacks,
  closeAllSessions, ensureMeTermReady,
} from './session-actions';
import {
  setTabRendererCallbacks,
  renderTabs,
} from './tab-renderer';
import {
  setToolbarCallbacks,
  renderToolbarActions, setupToolbarDrag,
} from './toolbar';
import { showTabContextMenu, showShellContextMenu } from './context-menu';
import { handleSSHConnect } from './ssh-handler';
import { handleRemoteConnect } from './remote-handler';
import { setupKeyboardShortcuts } from './keyboard-shortcuts';
import {
  setOverlayCallbacks,
} from './overlays';
import {
  port, authToken,
  settings, setSettings,
  sshConfigMap, remoteInfoMap, sessionProgressMap,
  remoteTabNumbers, incrementNextRemoteTabNumber,
  isWindowsPlatform,
} from './app-state';
import { setupDomEventListeners, setupTauriEventListeners, setupPostReadyEventListeners } from './event-listeners';

// Prevent unhandled promise rejections from crashing the Tauri webview.
// On macOS, unhandled rejections in WKWebView can silently kill the window.
window.addEventListener('unhandledrejection', (event) => {
  console.error('[unhandledrejection]', event.reason);
  event.preventDefault();
});

const terminalPanelEl = document.getElementById('terminal-panel') as HTMLDivElement;

async function init(): Promise<void> {
  // Route to utility windows if URL parameter is set
  const params = new URLSearchParams(window.location.search);
  if (params.get('window') === 'settings') {
    initSettingsWindow();
    return;
  }
  if (params.get('window') === 'updater') {
    initUpdaterWindow();
    return;
  }
  if (params.get('window') === 'about') {
    initAboutWindow();
    return;
  }
  if (params.get('window') === 'jumpserver-browser') {
    initJumpServerBrowserWindow();
    return;
  }

  initLanguage();
  setSettings(loadSettings());
  setLanguage(settings.language);
  setCloseAllSessionsHandler(closeAllSessions);
  setOverlayCallbacks({ activateTab, renderTabs, showHomeView, terminalPanelEl });
  setViewManagerCallbacks({ renderTabs, renderToolbarActions });
  setSessionActionsCallbacks({ renderTabs, renderToolbarActions });
  setTabRendererCallbacks({ showTabContextMenu });
  setToolbarCallbacks({ showShellContextMenu });
  const currentWindow = getCurrentWindow();
  const currentWindowLabel = currentWindow.label;
  // Fire-and-forget: tray language sync must NOT block init,
  // otherwise new windows never render their toolbar.
  void syncTrayLanguage();

  // Fire-and-forget: migrate plaintext credentials from localStorage to OS keychain
  void migrateSSHCredentials();
  void migrateRemoteCredentials();

  // Setup JumpServer browser window event listener
  import('./jumpserver-handler').then(({ setupJumpServerEventListener }) => {
    setupJumpServerEventListener();
  });
  TerminalRegistry.setSettings(settings);
  setHomeViewSettings(settings);
  setGalleryViewSettings(settings);
  setGalleryProgressGetter((id) => sessionProgressMap.get(id));
  applyWindowOpacity(settings.opacity);
  applyAiBarOpacity(settings.aiBarOpacity);
  applyColorScheme(settings);
  applyBackgroundImage(settings, terminalPanelEl);

  if (settings.rememberWindowSize && settings.windowWidth > 0 && settings.windowHeight > 0) {
    // Windows-only guard: dynamically created secondary windows can stall on
    // setSize during early init, causing a blank/non-interactive window.
    // Keep restore-size behavior for main window on Windows, and unchanged on
    // macOS/Linux to avoid behavior regressions there.
    if (!isWindowsPlatform || currentWindowLabel === 'main') {
      await currentWindow.setSize(new LogicalSize(settings.windowWidth, settings.windowHeight));
    }
  }

  setSSHConnectHandler(handleSSHConnect);
  setRemoteConnectHandler((info, sessionId) => { void handleRemoteConnect(info, sessionId); });

  // Register all DOM and Tauri event listeners
  setupDomEventListeners();
  setupTauriEventListeners(currentWindowLabel);
  setupKeyboardShortcuts();
  setupToolbarDrag();

  // StatusBar initialization
  const statusEl = document.getElementById('status') as HTMLDivElement;
  StatusBar.init(statusEl);
  StatusBar.startLatencyMonitor(
    () => TabManager.getActiveSessionId(),
    (sessionId) => TerminalRegistry.sendPing(sessionId),
  );
  StatusBar.startViewerMonitor(
    () => TabManager.getActiveSessionId(),
    async (sessionId) => {
      // Skip placeholder session IDs (tab still connecting)
      if (sessionId.startsWith('pending-')) return 0;
      try {
        // For remote sessions, query the remote server; for local, query localhost
        const remoteInfo = remoteInfoMap.get(sessionId);
        let apiUrl: string;
        let apiToken: string;
        if (remoteInfo) {
          const proto = remoteInfo.secure ? 'https' : 'http';
          apiUrl = `${proto}://${remoteInfo.host}:${remoteInfo.port}/api/sessions/${sessionId}`;
          apiToken = remoteInfo.token;
        } else {
          apiUrl = `http://127.0.0.1:${port}/api/sessions/${sessionId}`;
          apiToken = authToken;
        }
        const resp = await fetch(apiUrl, {
          headers: { Authorization: `Bearer ${apiToken}` },
        });
        if (!resp.ok) return 0;
        const data = await resp.json();
        // Prefer connected_clients (active only), fall back to clients (total)
        const totalClients = typeof data.connected_clients === 'number'
          ? data.connected_clients
          : (typeof data.clients === 'number' ? data.clients : 0);
        // Subtract 1 for self to get other viewer count
        const otherCount = Math.max(0, totalClients - 1);
        return otherCount;
      } catch {
        return 0;
      }
    },
  );

  showHomeView();
  renderTabs();
  renderToolbarActions();

  // Mark this window as initialized AFTER close handler is registered.
  // Rust allows uninitialised windows to close immediately (blank/failed windows).
  await invoke('mark_window_initialized', { windowLabel: currentWindowLabel });

  await ensureMeTermReady();

  // Sync discoverable (LAN discovery) state from localStorage to tray menu
  const savedDiscoverable = localStorage.getItem('meterm-discoverable') === '1';
  try {
    await invoke('set_discoverable_state', { checked: savedDiscoverable });
    if (savedDiscoverable) {
      await invoke('toggle_lan_sharing', { enabled: true });
    }
  } catch { /* ignore startup discoverable errors */ }

  // Setup cross-window tab drag-and-drop (needs meterm connection info)
  setupTabTransferListener(activateTab, showHomeView, port, authToken, renderTabs, (sess: TabTransferSessionInfo) => {
    // Restore SSH config map so the cloud icon appears in renderTabs
    if (sess.isSSH && sess.sshInfo) {
      sshConfigMap.set(sess.sessionId, {
        name: sess.sshInfo.host,
        host: sess.sshInfo.host,
        port: sess.sshInfo.port,
        username: sess.sshInfo.username,
        authMethod: 'password',
      });
    }
    // Restore remote info map so the globe icon and remote list button appear
    if (sess.isRemote && sess.remoteWsUrl) {
      try {
        const url = new URL(sess.remoteWsUrl);
        remoteInfoMap.set(sess.sessionId, {
          host: url.hostname,
          port: parseInt(url.port) || 8080,
          token: sess.remoteToken || '',
          secure: url.protocol === 'wss:',
        });
      } catch { /* ignore parse errors */ }
      remoteTabNumbers.set(sess.sessionId, incrementNextRemoteTabNumber());
    }
  });

  // Signal that this window is ready to receive tab transfers
  await emit('window-ready', { label: getCurrentWindow().label });

  // Post-ready event listeners (updater, etc.)
  setupPostReadyEventListeners(currentWindowLabel);
}

init().catch((err) => {
  console.error('[init] Fatal error:', err);
  // Show error in the UI so blank windows are debuggable
  const app = document.getElementById('app');
  if (app) {
    app.innerHTML = `<div style="padding:24px;color:#ff7b7b;font-family:monospace;white-space:pre-wrap">[init] ${escapeHtml(String(err))}</div>`;
  }
});
