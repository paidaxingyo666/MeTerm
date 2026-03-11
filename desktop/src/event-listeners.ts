/**
 * event-listeners.ts — Event listener registrations
 *
 * Extracted from main.ts init() closure. Contains all listen() and
 * document.addEventListener() registrations.
 */

import { TabManager } from './tabs';
import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { AICapsuleManager } from './ai-capsule';
import { loadSettings, saveSettings } from './themes';
import { applyWindowOpacity, applyAiBarOpacity, resolveThemeAttr, applyColorScheme, applyBackgroundImage } from './appearance';
import { setHomeViewSettings } from './home';
import { updateGalleryView, setGalleryViewSettings } from './gallery';
import { t } from './i18n';
import { setLanguage } from './i18n';
import { updateSSHHomeView, exportConnectionsToJSON, importConnectionsFromJSON, type SSHConnectionConfig } from './ssh';
import { showRemoteConnectDialog, type RemoteServerInfo } from './remote';
import { StatusBar } from './status-bar';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { save, open as openDialog } from '@tauri-apps/plugin-dialog';
import { confirmSystem, showInfoSystem, showAboutDialog, showHideToTrayDialog, requestQuitWithConfirm, syncTrayLanguage } from './window-lifecycle';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import { performCopy, performPaste, performSelectAll } from './clipboard-actions';
import { notifyUser } from './notify';
import { showPairApprovalDialog } from './pairing';
import { waitForMeTerm } from './connection';
import { startPairPoller } from './pairing';
import {
  activateTab,
  showHomeView, hideHomeView, showGalleryView, hideGalleryView,
  openSettings, getActiveSessionProgress,
} from './view-manager';
import {
  createNewSession, createNewPrivateSession,
  closeAllSessions, createNewWindowNearCurrent,
} from './session-actions';
import {
  renderTabs, syncTabMarqueeState,
  syncTabProgressLayers, syncGalleryProgressBars,
} from './tab-renderer';
import {
  renderToolbarActions,
  WIN_ICON_MAXIMIZE, WIN_ICON_RESTORE,
} from './toolbar';
import { showShellContextMenu, showCustomContextMenu } from './context-menu';
import { handleSSHConnect } from './ssh-handler';
import { handleRemoteConnect } from './remote-handler';
import { initUpdater, checkUpdateNow } from './updater';
import {
  showReconnectOverlay,
  showKickedOverlay,
  showMasterApprovalDialog,
  reclaimSessionIds, hideReclaimButton, syncReclaimOverlayForActiveTab,
  enterViewerMode, exitViewerMode, showViewerRequestDenied,
} from './overlays';
import {
  port, authToken, metermReady, setPort, setAuthToken, setMetermReady,
  handledPairIds,
  settings, setSettings,
  isHomeView, isGalleryView,
  sshConfigMap, remoteInfoMap, sessionProgressMap,
  isWindowsPlatform,
} from './app-state';

// ── Lazy-cached DOM elements ──────────────────────────────────────

let _terminalPanelEl: HTMLDivElement | null = null;
function getTerminalPanelEl(): HTMLDivElement {
  if (!_terminalPanelEl) {
    _terminalPanelEl = document.getElementById('terminal-panel') as HTMLDivElement;
  }
  return _terminalPanelEl;
}

let _toolbarTabsEl: HTMLDivElement | null = null;
function getToolbarTabsEl(): HTMLDivElement {
  if (!_toolbarTabsEl) {
    _toolbarTabsEl = document.getElementById('window-toolbar-tabs') as HTMLDivElement;
  }
  return _toolbarTabsEl;
}

let _toolbarRightEl: HTMLDivElement | null = null;
function getToolbarRightEl(): HTMLDivElement {
  if (!_toolbarRightEl) {
    _toolbarRightEl = document.getElementById('window-toolbar-right') as HTMLDivElement;
  }
  return _toolbarRightEl;
}

// ── DOM event listeners ───────────────────────────────────────────

export function setupDomEventListeners(): void {
  const terminalPanelEl = getTerminalPanelEl();

  // Color scheme auto-switch
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (settings.colorScheme === 'auto') {
      applyColorScheme(settings);
      setHomeViewSettings(settings);
      if (isHomeView) {
        hideHomeView();
        showHomeView();
      }
    }
  });

  // New local session from home page
  document.addEventListener('new-local-session', () => {
    void createNewSession();
  });

  // Shell selection context menu from home page local button
  document.addEventListener('new-local-session-menu', ((e: CustomEvent<{ mouseEvent: MouseEvent; anchor: HTMLElement }>) => {
    showShellContextMenu(e.detail.mouseEvent, e.detail.anchor);
  }) as EventListener);

  // Clone SSH session from tab context menu
  document.addEventListener('ssh-clone-session', ((e: CustomEvent<SSHConnectionConfig>) => {
    void handleSSHConnect(e.detail);
  }) as EventListener);

  // SSH connections changed
  document.addEventListener('ssh-connections-changed', () => {
    if (isHomeView) {
      updateSSHHomeView();
    }
  });

  // Remote connections changed
  document.addEventListener('remote-connections-changed', () => {
    if (isHomeView) {
      updateSSHHomeView();
    }
  });

  // Remote connect from home page button
  document.addEventListener('remote-connect-request', () => showRemoteConnectDialog());

  // Remote session selected from session list popup
  document.addEventListener('remote-session-selected', ((e: CustomEvent<{ info: RemoteServerInfo; sessionId: string }>) => {
    const { info, sessionId } = e.detail;
    void handleRemoteConnect(info, sessionId);
  }) as EventListener);

  // TabManager subscription
  TabManager.subscribe(() => {
    StatusBar.setSessionCount(TabManager.tabs.length);
    renderTabs();
    renderToolbarActions();
    if (isHomeView) {
      updateSSHHomeView();
    }
    if (isGalleryView) {
      updateGalleryView();
    }
  });

  // Split pane focus change: update drawer/AI to follow focused pane
  document.addEventListener('split-pane-focus-changed', ((e: CustomEvent<{ paneId: string; sessionId: string }>) => {
    const { paneId, sessionId } = e.detail;
    const activeTab = TabManager.getActiveTab();
    if (!activeTab) return;

    activeTab.focusedPaneId = paneId;

    // Update tab title/status from newly focused session
    const mt = TerminalRegistry.get(sessionId);
    if (mt) {
      activeTab.title = mt.shellTitle || mt.title;
      activeTab.status = mt.ended ? 'ended' : mt.ws ? 'connected' : 'disconnected';
    }

    // Switch drawer/AI to focused session (panel level, shared)
    DrawerManager.hideAll();
    AICapsuleManager.hideAll();
    if (DrawerManager.has(sessionId)) {
      DrawerManager.mountTo(sessionId, terminalPanelEl);
      DrawerManager.show(sessionId);
    }
    AICapsuleManager.mountTo(sessionId, terminalPanelEl);
    AICapsuleManager.show(sessionId);
    TerminalRegistry.focusTerminal(sessionId);

    TabManager.notify();
  }) as EventListener);

  // Split ratio change: persist to tab data
  document.addEventListener('split-ratio-changed', ((e: CustomEvent<{ branchId: string; ratio: number }>) => {
    const activeTab = TabManager.getActiveTab();
    if (!activeTab) return;
    TabManager.updateSplitRatio(activeTab.id, e.detail.branchId, e.detail.ratio);
  }) as EventListener);

  // Window aspect ratio helper
  function updateWindowAspectRatio(): void {
    const w = terminalPanelEl.clientWidth;
    const h = terminalPanelEl.clientHeight;
    if (w > 0 && h > 0) {
      document.documentElement.style.setProperty('--window-aspect-ratio', `${w} / ${h}`);
    }
  }
  updateWindowAspectRatio();

  // Window resize handler
  let resizeSaveTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    updateWindowAspectRatio();
    TerminalRegistry.resizeAll();
    syncTabMarqueeState();
    if (isHomeView) {
      updateSSHHomeView();
    }
    if (isGalleryView) {
      updateGalleryView();
    }
    if (settings.rememberWindowSize) {
      if (resizeSaveTimer) clearTimeout(resizeSaveTimer);
      resizeSaveTimer = setTimeout(async () => {
        const size = await getCurrentWindow().innerSize();
        const factor = window.devicePixelRatio || 1;
        settings.windowWidth = Math.round(size.width / factor);
        settings.windowHeight = Math.round(size.height / factor);
        saveSettings(settings);
      }, 500);
    }
  });

  // On Windows: keep the maximize/restore button icon in sync with actual window state.
  if (isWindowsPlatform) {
    const toolbarRightEl = getToolbarRightEl();
    window.addEventListener('resize', () => {
      void getCurrentWindow().isMaximized().then((isMax) => {
        const maxBtn = toolbarRightEl.querySelector('.win-maximize-btn') as HTMLButtonElement | null;
        if (!maxBtn) return;
        maxBtn.innerHTML = isMax ? WIN_ICON_RESTORE : WIN_ICON_MAXIMIZE;
        maxBtn.title = isMax
          ? (settings?.language === 'zh' ? '还原' : 'Restore')
          : (settings?.language === 'zh' ? '最大化' : 'Maximize');
      });
    });
  }

  // Mouse wheel on tab bar → horizontal scroll
  const toolbarTabsEl = getToolbarTabsEl();
  toolbarTabsEl.addEventListener('wheel', (e) => {
    const scrollContainer = toolbarTabsEl.querySelector('.tab-scroll-container') as HTMLDivElement | null;
    if (!scrollContainer) return;
    if (scrollContainer.scrollWidth <= scrollContainer.clientWidth) return;
    e.preventDefault();
    scrollContainer.scrollBy({ left: e.deltaY });
  }, { passive: false });

  // OSC 9;4 progress indicator
  document.addEventListener('osc-progress', ((e: CustomEvent) => {
    const { sessionId, state, percent } = e.detail;
    if (state === 0) {
      sessionProgressMap.delete(sessionId);
    } else {
      sessionProgressMap.set(sessionId, { state, percent });
    }
    StatusBar.setProgress(getActiveSessionProgress());
    syncTabProgressLayers();
    syncGalleryProgressBars();
  }) as EventListener);

  // OSC 9 / OSC 777 terminal notification
  const oscNotifyCooldown = new Map<string, number>();
  document.addEventListener('osc-notify', ((e: CustomEvent) => {
    const { sessionId, title, body } = e.detail;
    if (!settings.enableTerminalNotifications) return;
    // Per-session 3-second cooldown
    const now = Date.now();
    const last = oscNotifyCooldown.get(sessionId) || 0;
    if (now - last < 3000) return;
    oscNotifyCooldown.set(sessionId, now);
    // Get session title for source label
    const mt = TerminalRegistry.get(sessionId);
    const source = mt?.shellTitle || mt?.title || sessionId.substring(0, 8);
    notifyUser({
      id: `osc-${sessionId}-${now}`,
      type: 'terminal-osc',
      title,
      body,
      data: { source },
    });
  }) as EventListener);

  // Session select from drawer/gallery
  document.addEventListener('session-select', async (e: Event) => {
    const customEvent = e as CustomEvent<string>;
    const sessionId = customEvent.detail;
    const matchedTab = TabManager.findTabBySessionId(sessionId);
    if (matchedTab) {
      TabManager.activate(matchedTab.id);
      await activateTab(matchedTab.id);
      const selSessionId = customEvent.detail;
      const selSshCfg = sshConfigMap.get(selSessionId);
      StatusBar.setConnection('connected', selSshCfg ? `${selSshCfg.username}@${selSshCfg.host}` : 'Local');
      renderTabs();
      renderToolbarActions();
    }
  });

  // Right-click context menu
  document.addEventListener('contextmenu', showCustomContextMenu);

  // Manual reconnect: clicking the connection capsule in status bar
  document.addEventListener('status-bar-reconnect', () => {
    const sessionId = TabManager.getActiveSessionId();
    if (!sessionId || !sshConfigMap.has(sessionId)) return;
    const tab = TabManager.tabs.find((t) => t.id === TabManager.activeTabId);
    if (!tab) return;
    showReconnectOverlay(sessionId, tab.id);
  });

  // Viewer popup: list connected clients when clicking viewer capsule
  document.addEventListener('status-bar-viewers-clicked', async () => {
    try {
      const raw = await invoke<string>('list_clients');
      const { clients } = JSON.parse(raw);
      const connected = (clients || []).filter((c: any) => c.connected);
      StatusBar.showViewerPopup(connected);
    } catch (e) {
      console.error('list_clients failed:', e);
    }
  });

  // Handle kick from viewer popup
  document.addEventListener('status-bar-kick-client', ((e: Event) => {
    const { sessionId, clientId } = (e as CustomEvent).detail;
    invoke('kick_client', { sessionId, clientId }).catch((err) => {
      console.error('kick_client failed:', err);
    });
  }) as EventListener);

  // Master request approval dialog
  document.addEventListener('master-request', ((e: CustomEvent) => {
    const { sessionId, requesterId } = e.detail;
    showMasterApprovalDialog(sessionId, requesterId);
  }) as EventListener);

  // Pairing request approval dialog (with dedup against poller)
  document.addEventListener('pair-request', ((e: CustomEvent) => {
    const { pairId, deviceInfo, remoteAddr } = e.detail;
    if (handledPairIds.has(pairId)) return;
    handledPairIds.add(pairId);
    showPairApprovalDialog(pairId, deviceInfo, remoteAddr);
  }) as EventListener);

  // Master lost — show appropriate overlay based on session type
  document.addEventListener('master-lost', ((e: CustomEvent) => {
    const { sessionId } = e.detail;
    const mt = TerminalRegistry.get(sessionId);
    if (mt?.isRemote) {
      enterViewerMode(sessionId);
    } else {
      reclaimSessionIds.add(sessionId);
      syncReclaimOverlayForActiveTab();
    }
  }) as EventListener);

  // Master gained — exit viewer mode and hide all overlays
  document.addEventListener('master-gained', ((e: CustomEvent) => {
    const { sessionId } = e.detail;
    reclaimSessionIds.delete(sessionId);
    exitViewerMode(sessionId);
    hideReclaimButton();
  }) as EventListener);

  // Master request denied — update viewer overlay
  document.addEventListener('master-request-denied', (() => {
    showViewerRequestDenied();
  }) as EventListener);

  document.addEventListener('client-kicked', ((e: CustomEvent<{ sessionId: string }>) => {
    const { sessionId } = e.detail;
    exitViewerMode(sessionId);
    showKickedOverlay(sessionId);
    renderTabs();
  }) as EventListener);

  // Detect system wake from sleep/hibernate
  let lastVisibleAt = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const elapsed = Date.now() - lastVisibleAt;
      if (elapsed > 30_000 && metermReady) {
        console.log(`[meterm] system wake detected (gap=${Math.round(elapsed / 1000)}s), reconnecting sessions`);
        TerminalRegistry.reconnectAll(port, authToken);
      }
      lastVisibleAt = Date.now();
    } else {
      lastVisibleAt = Date.now();
    }
  });
}

// ── Tauri event listeners ─────────────────────────────────────────

export function setupTauriEventListeners(currentWindowLabel: string): void {
  const isForThisWindow = (event: { target_window: string }) => {
    return event.target_window === currentWindowLabel || event.target_window === 'all';
  };

  // Handle individual window close (red X button)
  // Must be registered BEFORE ensureMeTermReady() so windows can always be closed
  void listen<{ target_window: string }>('window-close-requested', async (event) => {
    if (!isForThisWindow(event.payload)) return;

    const mainWindowCount = await invoke<number>('get_main_window_count');

    // Last window: check hide-to-tray preference
    if (mainWindowCount <= 1) {
      const pref = localStorage.getItem('meterm-hide-to-tray-pref');

      if (pref === 'always_hide') {
        await invoke('hide_main_window');
        return;
      }

      if (pref !== 'always_close') {
        const choice = await showHideToTrayDialog();
        if (choice === 'hide') {
          await invoke('hide_main_window');
          return;
        }
      }
    }

    // Original close logic
    if (TabManager.tabs.length > 0) {
      const shouldClose = await confirmSystem(t('confirmCloseWindowWithSessions'));
      if (shouldClose) {
        await closeAllSessions();
        await invoke('allow_window_close', { windowLabel: currentWindowLabel });
        await getCurrentWindow().close();
      }
    } else {
      await invoke('allow_window_close', { windowLabel: currentWindowLabel });
      await getCurrentWindow().close();
    }
  });

  void listen<{ target_window: string }>('menu-show-home', (event) => {
    if (!isForThisWindow(event.payload)) return;
    void getCurrentWindow().show();
    void getCurrentWindow().setFocus();
    showHomeView();
    renderTabs();
    renderToolbarActions();
  });

  void listen<{ target_window: string }>('menu-new-terminal', async (event) => {
    if (!isForThisWindow(event.payload)) return;
    await getCurrentWindow().show();
    await getCurrentWindow().setFocus();
    await createNewSession();
    renderToolbarActions();
  });

  void listen<{ target_window: string }>('menu-new-private-terminal', async (event) => {
    if (!isForThisWindow(event.payload)) return;
    await getCurrentWindow().show();
    await getCurrentWindow().setFocus();
    await createNewPrivateSession();
    renderToolbarActions();
  });

  void listen<{ target_window: string }>('menu-new-window', async (event) => {
    if (!isForThisWindow(event.payload)) return;
    await getCurrentWindow().show();
    await getCurrentWindow().setFocus();
    await createNewWindowNearCurrent();
  });

  void listen<{ target_window: string }>('menu-open-settings', (event) => {
    if (!isForThisWindow(event.payload)) return;
    void getCurrentWindow().show();
    void getCurrentWindow().setFocus();
    openSettings();
  });

  void listen<{ target_window: string }>('menu-close-all-sessions', async (event) => {
    if (!isForThisWindow(event.payload)) return;
    if (TabManager.tabs.length === 0) return;

    await getCurrentWindow().show();
    await getCurrentWindow().setFocus();

    const confirmed = await confirmSystem(t('confirmCloseAllSessions'));
    if (!confirmed) return;
    await closeAllSessions();
  });

  void listen<{ target_window: string }>('menu-request-quit', async (event) => {
    if (!isForThisWindow(event.payload)) return;
    await requestQuitWithConfirm();
  });

  void listen<{ target_window: string }>('menu-quit-all-requested', async (event) => {
    if (!isForThisWindow(event.payload)) return;
    const confirmed = await confirmSystem(t('confirmQuitAllWindows'));
    if (confirmed) {
      await invoke('request_app_quit');
    }
  });

  // LAN Discovery toggle from tray menu
  void listen<{ enabled: boolean }>('menu-toggle-lan-discover', async (event) => {
    const enabled = event.payload.enabled;
    try {
      await invoke('toggle_lan_sharing', { enabled });
      localStorage.setItem('meterm-discoverable', enabled ? '1' : '0');
    } catch (err) {
      console.error('toggle_lan_sharing failed:', err);
      try {
        await invoke('set_discoverable_state', { checked: !enabled });
      } catch { /* ignore rollback errors */ }
    }
  });

  void listen<{ target_window: string }>('menu-undo', (event) => {
    if (!isForThisWindow(event.payload)) return;
    document.execCommand('undo');
  });

  void listen<{ target_window: string }>('menu-redo', (event) => {
    if (!isForThisWindow(event.payload)) return;
    document.execCommand('redo');
  });

  void listen<{ target_window: string }>('menu-cut', (event) => {
    if (!isForThisWindow(event.payload)) return;
    document.execCommand('cut');
  });

  void listen<{ target_window: string }>('menu-copy', (event) => {
    if (!isForThisWindow(event.payload)) return;
    performCopy();
  });

  void listen<{ target_window: string }>('menu-paste', (event) => {
    if (!isForThisWindow(event.payload)) return;
    performPaste();
  });

  void listen<{ target_window: string }>('menu-select-all', (event) => {
    if (!isForThisWindow(event.payload)) return;
    performSelectAll();
  });

  void listen<{ target_window: string }>('menu-reload', (event) => {
    if (!isForThisWindow(event.payload)) return;
    window.location.reload();
  });

  void listen<{ target_window: string }>('menu-show-about', (event) => {
    if (!isForThisWindow(event.payload)) return;
    void showAboutDialog();
  });

  void listen<{ target_window: string }>('menu-show-shortcuts', (event) => {
    if (!isForThisWindow(event.payload)) return;
    const isMac = navigator.userAgent.includes('Mac');
    const mod = isMac ? '⌘' : 'Ctrl+';
    const shift = isMac ? '⇧' : 'Shift+';
    const alt = isMac ? '⌥' : 'Alt+';
    const del = isMac ? '⌫' : 'Backspace';
    const sep = isMac ? '：' : ': ';
    const body = [
      `${mod}T${sep}${t('shortcutNewTerminal')}`,
      `${mod}W${sep}${t('shortcutCloseSession')}`,
      `${mod}K${sep}${t('shortcutClearTerminal')}`,
      `${mod}${del}${sep}${t('shortcutClearInput')}`,
      `${mod},${sep}${t('shortcutOpenSettings')}`,
      `${mod}D${sep}${t('shortcutSplitHorizontal')}`,
      `${mod}${shift}D${sep}${t('shortcutSplitVertical')}`,
      `${mod}${alt}←→↑↓${sep}${t('shortcutNavigatePanes')}`,
    ].join('\n');
    void showInfoSystem(body, t('shortcutsDialogTitle'));
  });

  void listen<{ target_window: string }>('menu-import-connections', async (event) => {
    if (!isForThisWindow(event.payload)) return;
    const filePath = await openDialog({
      multiple: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (filePath) {
      try {
        const content = await readTextFile(filePath as string);
        const result = importConnectionsFromJSON(content);
        await showInfoSystem(`${result.count} ${t('sshImportCount')}`, t('sshImportSuccess'));
        if (isHomeView) updateSSHHomeView();
      } catch {
        await showInfoSystem(t('sshImportInvalidFormat'), t('sshImportFailed'));
      }
    }
  });

  void listen<{ target_window: string }>('menu-export-connections', async (event) => {
    if (!isForThisWindow(event.payload)) return;
    const result = await exportConnectionsToJSON();
    if (!result) {
      await showInfoSystem(t('sshNoConnectionsToExport'), t('appName'));
      return;
    }
    const filePath = await save({
      filters: [{ name: 'JSON', extensions: ['json'] }],
      defaultPath: 'meterm-connections.json',
    });
    if (filePath) {
      try {
        await writeTextFile(filePath, result.json);
        await showInfoSystem(`${result.count} ${t('sshExportCount')}`, t('sshExportSuccess'));
      } catch (err) {
        await showInfoSystem(String(err), t('appName'));
      }
    }
  });

  void listen<{ target_window: string }>('menu-check-updates', (event) => {
    if (!isForThisWindow(event.payload)) return;
    void checkUpdateNow();
  });

  void listen('meterm-exited', async () => {
    setMetermReady(false);
    setAuthToken('');
    setPort(0);
    StatusBar.setConnection('connecting', 'Restarting...');

    // Try to auto-restart the backend before giving up and quitting.
    try {
      await invoke('restart_meterm');
      const info = await waitForMeTerm(20, 300); // up to 6 s
      setPort(info.port);
      setAuthToken(info.token);
      setMetermReady(true);
      StatusBar.setConnection('connected', 'Local');
      startPairPoller(port, authToken);
      TerminalRegistry.reconnectAll(port, authToken);
      console.log('[meterm] backend restarted successfully');
      return;
    } catch (restartErr) {
      console.error('[meterm] backend restart failed:', restartErr);
    }

    // Restart failed — quit the app gracefully.
    StatusBar.setError('Backend failed to restart');
    await invoke('request_app_quit');
  });

  // Listen for settings changes from the settings window
  void listen('settings-changed', () => {
    const terminalPanelEl = getTerminalPanelEl();
    setSettings(loadSettings());
    setLanguage(settings.language);
    applyColorScheme(settings);
    setHomeViewSettings(settings);
    setGalleryViewSettings(settings);
    applyWindowOpacity(settings.opacity);
    applyAiBarOpacity(settings.aiBarOpacity);
    applyBackgroundImage(settings, terminalPanelEl);
    TerminalRegistry.setSettings(settings);
    void syncTrayLanguage();
    renderTabs();
    renderToolbarActions();

    // Update native window title bar theme
    const nativeTheme = resolveThemeAttr(settings.colorScheme) === 'light' ? 'light' as const : 'dark' as const;
    void getCurrentWindow().setTheme(nativeTheme);

    if (isHomeView) {
      hideHomeView();
      showHomeView();
    }
    if (isGalleryView) {
      hideGalleryView();
      showGalleryView();
    }
  });
}

// ── Post-ready event listeners (after ensureMeTermReady) ──────────

export function setupPostReadyEventListeners(currentWindowLabel: string): void {
  // Check for app updates in the background (8-second delay built in).
  // Only run in the main window to avoid duplicate update checks.
  if (currentWindowLabel === 'main') {
    document.addEventListener('update-available', () => { renderToolbarActions(); });
    void listen('update-icon-pref-changed', () => { renderToolbarActions(); });
    void initUpdater();
  }
}
