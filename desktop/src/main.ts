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
import './styles/file-sidebar.css';
import './styles/ai-bar.css';
import './styles/split-pane.css';
import './styles/ai-chat.css';
import './styles/ai-settings.css';
import './styles/ai-todo-board.css';
import './styles/ai-attachments.css';
import './styles/neo-brutalism.css';
import './styles/pairing.css';
import './styles/sharing.css';
import './styles/remote.css';
import './styles/jumpserver.css';
import './styles/osc-progress.css';
import './styles/viewer-popup.css';
import './styles/toast.css';
import './styles/misc.css';
import './styles/pip.css';
import './styles/fullscreen-mac.css';
import '@xterm/xterm/css/xterm.css';

import { TabManager } from './tabs';
import { TerminalRegistry } from './terminal';
import { loadSettings } from './themes';
import {
  hydrateSettingsSecretPresenceFromStorage,
  initializeSettingsSecrets,
} from './settings-secrets';
import { applyWindowOpacity, applyAiBarOpacity, applyColorScheme, applyBackgroundImage, applyVibrancy } from './appearance';
import { applyUiFont } from './fonts';
import { applyNbPalette, listenForNbPaletteChanges } from './nb-palette';
import { setHomeViewSettings } from './home';
import { setGalleryViewSettings, setGalleryProgressGetter } from './gallery';
import { initSettingsWindow } from './settings-window';
import { initUpdaterWindow } from './updater-window';
import { initAboutWindow } from './about-window';
import { initJumpServerBrowserWindow } from './jumpserver-browser-window';
import { initEditorWindowShell } from './file-editor-init';
import { initPip } from './pip';
import { initMacFullscreen } from './fullscreen-mac';
import { initLanguage, setLanguage } from './i18n';
import { setSSHConnectHandler } from './ssh';
import { detectSshMigrationPendingAtStartup, pullConnections } from './connection-sync';
import { fetchRemoteSessions, setRemoteConnectHandler, detectRemoteCredentialMigrationPendingAtStartup, pruneUnreachableRecentRemotes } from './remote';
import { detectJumpServerCredentialMigrationPendingAtStartup } from './jumpserver-api';
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
    await initializeSettingsSecrets('settings');
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

  // Release may import and consume only 11 strictly validated, non-secret UI
  // preference keys from the old Dev database. Debug is always a no-op; all
  // credential/history rows remain untouched for explicit recovery/cleanup.
  if (getCurrentWindow().label === 'main') await consumeLegacyUiPreferences();
  // Only the primary window may perform the one-shot native migration. Normal
  // `window-*` launches consume non-sensitive cached presence flags and never
  // touch the settings Keychain during startup.
  if (getCurrentWindow().label === 'main') {
    await initializeSettingsSecrets('startup');
  } else {
    hydrateSettingsSecretPresenceFromStorage();
  }

  initLanguage();
  setSettings(loadSettings());

  // Install in-process agent audit log. Writes one JSON line per
  // significant event to {AppData}/agent-audit.jsonl
  // (macOS: ~/Library/Application Support/com.meterm.app/).
  // Lazy import keeps the main bundle lean.
  void import('./ai-audit-log').then(({ installAuditLog }) => installAuditLog());

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

  // Only the main window records whether an explicit SSH migration is pending.
  // This startup check is Web Storage-only and never scans Keychain accounts.
  if (currentWindowLabel === 'main') {
    try {
      await detectSshMigrationPendingAtStartup();
    } catch (error) {
      // Startup only records a redacted pending/manual state. Credential reads
      // and writes require the explicit migration UI or normal user edits.
      console.warn('[security] SSH credential migration requires explicit action:', error);
    }
    try {
      await detectRemoteCredentialMigrationPendingAtStartup();
    } catch (error) {
      // The durable manual marker prevents startup retries. Plaintext is kept
      // for an explicit connection attempt or re-save by the user.
      console.warn('[security] Remote credential migration incomplete:', error);
    }
    try {
      await detectJumpServerCredentialMigrationPendingAtStartup();
    } catch (error) {
      // The durable manual marker prevents startup retries. Explicit use of the
      // JumpServer UI retains the existing on-demand migration path.
      console.warn('[security] JumpServer credential migration incomplete:', error);
    }
  }

  // Fire-and-forget: reverse pull — merge connections created/deleted on the
  // phone (or another device) back into this desktop. Runs once at startup then
  // polls every 10s so cross-device changes surface. Fully try/caught inside;
  // a sync failure never breaks local SSH management. Credential migration is
  // manual-only; this pull contains metadata and never reads the desktop vault.
  void pullConnections();
  setInterval(() => { void pullConnections(); }, 10000);

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
  // setSettings is async (awaits loadFont). Chain NB palette after it.
  void TerminalRegistry.setSettings(settings).then(() => {
    applyNbPalette(settings.colorScheme);
  });
  setHomeViewSettings(settings);
  setGalleryViewSettings(settings);
  setGalleryProgressGetter((id) => sessionProgressMap.get(id));
  applyWindowOpacity(settings.opacity);
  applyAiBarOpacity(settings.aiBarOpacity);
  applyColorScheme(settings);
  applyBackgroundImage(settings, terminalPanelEl);
  void applyVibrancy(settings.enableVibrancy);
  applyUiFont(settings.uiFontFamily);
  // Listen for NB palette changes from the settings window (cross-window
  // localStorage events). This is more reliable than emit('settings-changed')
  // because it fires immediately when the other window writes to localStorage.
  listenForNbPaletteChanges(() => loadSettings().colorScheme);

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
  initMacFullscreen();

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
        if (remoteInfo) {
          const sessions = await fetchRemoteSessions(remoteInfo);
          const data = sessions.find((session) => session.id === sessionId) as (typeof sessions[number] & {
            connected_clients?: number;
            clients?: number;
          }) | undefined;
          if (!data) return 0;
          const totalClients = typeof data.connected_clients === 'number'
            ? data.connected_clients
            : (typeof data.clients === 'number' ? data.clients : 0);
          return Math.max(0, totalClients - 1);
        }
        const apiUrl = `http://127.0.0.1:${port}/api/sessions/${sessionId}`;
        const resp = await fetch(apiUrl, {
          headers: { Authorization: `Bearer ${authToken}` },
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
    // Terminal-first: always open a local terminal on startup (unless one was
    // already created from an initial path). The connection manager is now a
    // toggleable left sidebar rather than a landing page.
    if (!sessionCreated) {
      try {
        await createNewSession();
        sessionCreated = true;
      } catch { /* ignore */ }
    }
    if (sessionCreated) renderToolbarActions();
  }

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
    if (sess.isRemote && sess.remoteHost && sess.remotePort) {
      remoteInfoMap.set(sess.sessionId, {
        host: sess.remoteHost,
        port: sess.remotePort,
        token: '',
        secure: true,
      });
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
 * Consume the native migration's strict non-secret UI-preference allowlist.
 * The command cannot be used as a generic old localStorage reader.
 */
async function consumeLegacyUiPreferences(): Promise<void> {
  try {
    const data = await invoke<Record<string, string> | null>('consume_legacy_ui_preferences');
    if (!data) return;
    let count = 0;
    for (const [key, value] of Object.entries(data)) {
      if (localStorage.getItem(key) === null) {
        localStorage.setItem(key, value);
        count++;
      }
    }
    if (count > 0) {
      console.log(`[migration] Imported ${count} legacy UI preferences`);
    }
  } catch (e) {
    console.warn('[migration] Failed to consume legacy UI preferences:', e);
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
