// Styles - modular CSS imports (order matters for cascade)
import './styles/themes.css';
import './styles/base.css';
import './styles/toolbar.css';
import './styles/status-bar.css';
import './styles/overlay-scrollbar.css';
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
import './styles/pip.css';
import '@xterm/xterm/css/xterm.css';

import { TabManager } from './tabs';
import { TerminalRegistry } from './terminal';
import { loadSettings } from './themes';
import { applyWindowOpacity, applyAiBarOpacity, applyColorScheme, applyBackgroundImage, applyVibrancy } from './appearance';
import { setHomeViewSettings } from './home';
import { setGalleryViewSettings, setGalleryProgressGetter } from './gallery';
import { initSettingsWindow } from './settings-window';
import { initUpdaterWindow } from './updater-window';
import { initAboutWindow } from './about-window';
import { initJumpServerBrowserWindow } from './jumpserver-browser-window';
import { initEditorWindowShell } from './file-editor-init';
import { initPip } from './pip';
import { initLanguage, setLanguage } from './i18n';
import { setSSHConnectHandler, migrateSSHCredentials } from './ssh';
import { setRemoteConnectHandler, migrateRemoteCredentials, pruneUnreachableRecentRemotes } from './remote';
import { setupTabTransferListener, type TabTransferSessionInfo } from './tab-drag';
import { escapeHtml } from './status-bar';
import { StatusBar } from './status-bar';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { syncTrayLanguage, setCloseAllSessionsHandler } from './window-lifecycle';
import { revealAfterPaint } from './window-utils';
import { LogicalSize } from '@tauri-apps/api/dpi';
import {
  setViewManagerCallbacks,
  activateTab,
  showHomeView,
} from './view-manager';
import {
  setSessionActionsCallbacks,
  closeAllSessions, ensureMeTermReady,
  createNewSession,
} from './session-actions';
import {
  setTabRendererCallbacks,
  renderTabs,
} from './tab-renderer';
import {
  setToolbarCallbacks,
  renderToolbarActions, setupToolbarDrag,
} from './toolbar';
import { showTabContextMenu, showShellContextMenu, preloadShells } from './context-menu';
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
import { initTldr, getTldrCommands } from './tldr-help';
import { globalCompletionIndex } from './cmd-completion-data';

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
  if (params.get('window') === 'editor') {
    // Shell setup MUST be synchronous — WKWebView only registers drag regions during initial load
    initEditorWindowShell();
    // Load CodeMirror + editor content async
    import('./file-editor').then(m => m.initEditorContent());
    return;
  }

    // One-time migration: import localStorage data from old bundle ID (com.meterm.dev → com.meterm.app)
  await migrateOldLocalStorage();

  initLanguage();
  setSettings(loadSettings());
  if (settings.deviceName) void invoke('set_device_name', { name: settings.deviceName });
  setLanguage(settings.language);
  setCloseAllSessionsHandler(closeAllSessions);
  setOverlayCallbacks({ activateTab, renderTabs, showHomeView, terminalPanelEl });
  setViewManagerCallbacks({ renderTabs, renderToolbarActions });
  setSessionActionsCallbacks({ renderTabs, renderToolbarActions });
  setTabRendererCallbacks({ showTabContextMenu });
  setToolbarCallbacks({ showShellContextMenu });
  preloadShells(); // fire-and-forget: cache shell list so context menu opens instantly
  const currentWindow = getCurrentWindow();
  const currentWindowLabel = currentWindow.label;
  // Fire-and-forget: tray language sync must NOT block init,
  // otherwise new windows never render their toolbar.
  void syncTrayLanguage();

  // Fire-and-forget: migrate plaintext credentials from localStorage to OS keychain
  void migrateSSHCredentials();
  void migrateRemoteCredentials();

  // Setup JumpServer: restore state from localStorage (only for secondary windows, not on app restart)
  import('./jumpserver-handler').then(({ setupJumpServerEventListener, restoreActiveJumpServersFromStorage, clearActiveJumpServersStorage }) => {
    if (currentWindowLabel === 'main') {
      // First window on app launch — clear stale JumpServer state from previous session
      clearActiveJumpServersStorage();
    } else {
      // Secondary window — restore state from localStorage (main process still alive)
      restoreActiveJumpServersFromStorage();
    }
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
  void applyVibrancy(settings.enableVibrancy);

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
  initPip();

  // Mark initialized early — right after close handler is registered, BEFORE
  // heavy async work (StatusBar, ensureMeTermReady, tldr).  This prevents
  // the Rust side from auto-closing a window that is still loading.
  await invoke('mark_window_initialized', { windowLabel: currentWindowLabel });

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
      // Skip ended sessions to avoid 404 polling
      if (!TerminalRegistry.isSessionActive(sessionId)) return 0;
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

  await ensureMeTermReady();

  // Prune unreachable remote connections from recent list (async, non-blocking)
  pruneUnreachableRecentRemotes()
    .then(async () => {
      // Refresh home view if still showing, so pruned items disappear
      if (document.getElementById('home-view')) {
        const { updateSSHHomeView } = await import('./ssh');
        updateSSHHomeView();
      }
    })
    .catch(() => {});

  // Initialize tldr help data + completion index (async, non-blocking)
  if (settings.tldrEnabled) {
    initTldr().then(async () => {
      if (settings.cmdCompletionEnabled) {
        try {
          const cmds = await getTldrCommands();
          globalCompletionIndex.loadTldr(cmds);
        } catch { /* ignore */ }
      }
    }).catch(() => { /* ignore tldr init errors */ });
  }
  // Load history into completion index
  if (settings.cmdCompletionEnabled) {
    try {
      const raw = localStorage.getItem('meterm-ai-history');
      if (raw) {
        const allHistory: Record<string, { command: string }[]> = JSON.parse(raw);
        const commands: string[] = [];
        for (const entries of Object.values(allHistory)) {
          for (const e of entries) {
            if (e.command) commands.push(e.command);
          }
        }
        globalCompletionIndex.loadHistory(commands);
      }
    } catch { /* ignore */ }
  }

  // Check if app was launched with a directory path (e.g., from Finder/Explorer context menu)
  // or auto-create a local session based on user settings.
  if (currentWindowLabel === 'main') {
    let sessionCreated = false;
    try {
      const initialPath = await invoke<string | null>('take_initial_open_path');
      if (initialPath) {
        await createNewSession(undefined, initialPath);
        sessionCreated = true;
      }
    } catch { /* ignore */ }
    // Auto-create local session on startup (if enabled and no session was created above)
    if (!sessionCreated && settings.autoNewSession) {
      try {
        await createNewSession();
        sessionCreated = true;
      } catch { /* ignore */ }
    }
    if (sessionCreated) renderToolbarActions();
  }

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

  // Reveal window after first paint + GPU compositor commit
  await revealAfterPaint(getCurrentWindow().label);

  // Post-ready event listeners (updater, etc.)
  setupPostReadyEventListeners(currentWindowLabel);
}

/**
 * One-time migration: read localStorage from the old `com.meterm.dev` WebKit data
 * and write entries into the current (new) localStorage under `com.meterm.app`.
 * Skips keys that already exist in the new localStorage to avoid overwriting.
 */
async function migrateOldLocalStorage(): Promise<void> {
  const MIGRATION_KEY = 'meterm-migrated-from-dev';
  if (localStorage.getItem(MIGRATION_KEY)) return; // already migrated

  try {
    const data = await invoke<Record<string, string> | null>('read_old_localstorage');
    if (!data) {
      localStorage.setItem(MIGRATION_KEY, '1');
      return;
    }
    let count = 0;
    for (const [key, value] of Object.entries(data)) {
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, value);
        count++;
      }
    }
    localStorage.setItem(MIGRATION_KEY, '1');
    if (count > 0) {
      console.log(`[migration] Imported ${count} localStorage entries from com.meterm.dev`);
    }
  } catch (e) {
    console.warn('[migration] Failed to read old localStorage:', e);
    // Don't set the flag so it can retry next launch
  }
}

init().catch((err) => {
  console.error('[init] Fatal error:', err);
  // Show error in the UI so blank windows are debuggable
  const app = document.getElementById('app');
  if (app) {
    app.innerHTML = `<div style="padding:24px;color:#ff7b7b;font-family:monospace;white-space:pre-wrap">[init] ${escapeHtml(String(err))}</div>`;
  }
});
