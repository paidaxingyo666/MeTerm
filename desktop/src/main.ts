import './style.css';
import '@xterm/xterm/css/xterm.css';

import { waitForMeTerm } from './connection';
import { TabManager, type Tab } from './tabs';
import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { AICapsuleManager } from './ai-capsule';
import { loadSettings, AppSettings, resolveIsDark, getEffectiveTheme, saveSettings } from './themes';
import { setHomeViewSettings } from './home';
import { createGalleryView, updateGalleryView, setGalleryViewSettings, setGalleryProgressGetter, startGalleryRefresh, stopGalleryRefresh } from './gallery';
import { initSettingsWindow } from './settings-window';
import { initUpdaterWindow } from './updater-window';
import { initLanguage, setLanguage, t } from './i18n';
import { icon } from './icons';
import { createSSHHomeView, updateSSHHomeView, setSSHConnectHandler, createSSHSession, addConnection, addRecentConnection, exportConnectionsToJSON, importConnectionsFromJSON, migrateSSHCredentials, showAuthFailedDialog, updateSavedPassword, type SSHConnectionConfig } from './ssh';
import { showRemoteConnectDialog, setRemoteConnectHandler, fetchRemoteSessions, addRecentRemoteConnection, loadRemoteToken, migrateRemoteCredentials, remoteWsBase, type RemoteServerInfo, type RemoteSession } from './remote';
import { initTabDrag, setupTabTransferListener, type TabTransferSessionInfo } from './tab-drag';
import { StatusBar, escapeHtml } from './status-bar';
import { SplitPaneManager, getAllLeaves, countLeaves, findLeafById, getAdjacentLeaf } from './split-pane';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { confirm, message, save, open as openDialog } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { readText as clipboardReadText, writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { createWindowAtPosition } from './window-utils';
import { notifyUser } from './notify';
import { initUpdater, checkUpdateNow, pendingUpdateVersion, openUpdaterWindow } from './updater';
import appIconUrl from '../src-tauri/icons/icon.svg';

// Prevent unhandled promise rejections from crashing the Tauri webview.
// On macOS, unhandled rejections in WKWebView can silently kill the window.
window.addEventListener('unhandledrejection', (event) => {
  console.error('[unhandledrejection]', event.reason);
  event.preventDefault();
});

let port = 0;
let authToken = '';
let metermReady = false;

// Pair request deduplication and polling
const handledPairIds = new Set<string>();
let pairPollTimer: ReturnType<typeof setInterval> | null = null;
let settings: AppSettings;
let isHomeView = true;
let isGalleryView = false;

type ViewMode = 'home' | 'gallery' | 'terminal';
let isQuitFlowRunning = false;
const sshConfigMap = new Map<string, SSHConnectionConfig>();
const remoteInfoMap = new Map<string, RemoteServerInfo>();
const sessionProgressMap = new Map<string, { state: number; percent: number }>();
const remoteTabNumbers = new Map<string, number>();
let nextRemoteTabNumber = 1;

const ua = navigator.userAgent.toLowerCase();
const isWindowsPlatform = ua.includes('windows');
const isMacPlatform = ua.includes('macintosh') || ua.includes('mac os');
document.documentElement.classList.toggle('platform-windows', isWindowsPlatform);
document.documentElement.classList.toggle('platform-macos', isMacPlatform);
document.documentElement.classList.toggle('platform-linux', !isWindowsPlatform && !isMacPlatform);

/**
 * Helper: split pane with SSH awareness.
 * Detects if focused pane is SSH and passes config accordingly.
 */
async function doSplitPane(
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

const statusEl = document.getElementById('status') as HTMLDivElement;
const tabBarEl = document.getElementById('tab-bar') as HTMLDivElement;
const terminalPanelEl = document.getElementById('terminal-panel') as HTMLDivElement;
const toolbarLeftEl = document.getElementById('window-toolbar-left') as HTMLDivElement;
const toolbarTabsEl = document.getElementById('window-toolbar-tabs') as HTMLDivElement;
const toolbarRightEl = document.getElementById('window-toolbar-right') as HTMLDivElement;

function applyWindowOpacity(opacityPercent: number): void {
  const value = Math.max(20, Math.min(100, opacityPercent)) / 100;
  document.documentElement.style.setProperty('--app-window-opacity', `${value}`);
  // Clear the anti-flash inline background set in index.html
  document.documentElement.style.removeProperty('background-color');
  document.body.style.backgroundColor = 'transparent';
}

function applyAiBarOpacity(opacityPercent: number): void {
  const value = Math.max(20, Math.min(100, opacityPercent)) / 100;
  document.documentElement.style.setProperty('--ai-bar-opacity', `${value}`);
}

function resolveThemeAttr(colorScheme: string): string {
  if (colorScheme === 'darker') return 'darker';
  if (colorScheme === 'navy') return 'navy';
  if (colorScheme === 'light') return 'light';
  if (colorScheme === 'auto') return resolveIsDark('auto') ? 'dark' : 'light';
  return 'dark';
}

function applyColorScheme(s: AppSettings): void {
  document.documentElement.dataset.theme = resolveThemeAttr(s.colorScheme);

  const effectiveTheme = getEffectiveTheme(s);
  if (effectiveTheme !== s.theme) {
    s.theme = effectiveTheme;
    saveSettings(s);
  }
  TerminalRegistry.setSettings(s);

  // Apply file manager font size
  document.documentElement.style.setProperty('--file-manager-font-size', `${s.fileManagerFontSize}px`);
}

function applyBackgroundImage(s: AppSettings): void {
  let bgEl = document.querySelector('.terminal-bg-image') as HTMLDivElement | null;
  let overlayEl = document.querySelector('.terminal-bg-overlay') as HTMLDivElement | null;
  if (s.backgroundImage) {
    if (!bgEl) {
      bgEl = document.createElement('div');
      bgEl.className = 'terminal-bg-image';
      terminalPanelEl.insertBefore(bgEl, terminalPanelEl.firstChild);
    }
    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.className = 'terminal-bg-overlay';
      terminalPanelEl.insertBefore(overlayEl, terminalPanelEl.firstChild);
    }
    const url = convertFileSrc(s.backgroundImage);
    bgEl.style.backgroundImage = `url("${url}")`;
    // Opacity slider controls the image visibility when a bg image is set
    bgEl.style.opacity = String(Math.max(20, Math.min(100, s.opacity)) / 100);
    overlayEl.style.display = '';
  } else {
    if (bgEl) bgEl.style.backgroundImage = '';
    if (overlayEl) overlayEl.style.display = 'none';
  }
}

function getOrCreateTerminalArea(): HTMLElement {
  let area = terminalPanelEl.querySelector(':scope > .terminal-area') as HTMLElement;
  if (!area) {
    area = document.createElement('div');
    area.className = 'terminal-area';
    terminalPanelEl.insertBefore(area, terminalPanelEl.firstChild);
  }
  return area;
}

function showSSHConnectingPlaceholder(config: SSHConnectionConfig): void {
  removeSSHConnectingPlaceholder();
  const placeholder = document.createElement('div');
  placeholder.id = 'ssh-connecting-placeholder';
  placeholder.className = 'ssh-connecting-placeholder';
  placeholder.innerHTML =
    `<div class="ssh-connecting-spinner"></div>` +
    `<div class="ssh-connecting-label">${escapeHtml(t('connecting'))} ${escapeHtml(config.username)}@${escapeHtml(config.host)}:${config.port}...</div>`;
  terminalPanelEl.appendChild(placeholder);
}

function removeSSHConnectingPlaceholder(): void {
  document.getElementById('ssh-connecting-placeholder')?.remove();
}

function removeReconnectOverlay(sessionId: string): void {
  document.querySelector(`.ssh-reconnect-overlay[data-session-id="${sessionId}"]`)?.remove();
}

function removeAllReconnectOverlays(): void {
  document.querySelectorAll('.ssh-reconnect-overlay').forEach((el) => el.remove());
}

function showKickedOverlay(sessionId: string, msg?: string): void {
  const mt = TerminalRegistry.get(sessionId);
  const parent = mt?.container?.parentElement ?? terminalPanelEl;
  if (parent.querySelector(`.kicked-overlay[data-session-id="${sessionId}"]`)) return;

  const overlay = document.createElement('div');
  overlay.className = 'kicked-overlay';
  overlay.dataset.sessionId = sessionId;

  const iconEl = document.createElement('div');
  iconEl.className = 'kicked-overlay-icon';
  iconEl.innerHTML = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>';

  const msgEl = document.createElement('div');
  msgEl.className = 'kicked-overlay-msg';
  msgEl.textContent = msg || t('kickedOverlayMsg');

  const closeBtn = document.createElement('button');
  closeBtn.className = 'kicked-overlay-close-btn';
  closeBtn.type = 'button';
  closeBtn.textContent = t('closeTab');
  closeBtn.onclick = async () => {
    const tab = TabManager.tabs.find((tb) => {
      const leaves = getAllLeaves(tb.splitRoot);
      return leaves.some((l) => l.sessionId === sessionId);
    });
    if (!tab) return;
    const closingLeaves = getAllLeaves(tab.splitRoot);
    for (const leaf of closingLeaves) {
      DrawerManager.destroy(leaf.sessionId);
      AICapsuleManager.destroy(leaf.sessionId);
      sshConfigMap.delete(leaf.sessionId);
      remoteInfoMap.delete(leaf.sessionId);
      remoteTabNumbers.delete(leaf.sessionId);
      viewerModeSessionIds.delete(leaf.sessionId);
      reclaimSessionIds.delete(leaf.sessionId);
      { const pr = pendingMasterRequests.get(leaf.sessionId); if (pr) { clearTimeout(pr.timerId); pendingMasterRequests.delete(leaf.sessionId); } }
      privateSessionIds.delete(leaf.sessionId);
      sessionProgressMap.delete(leaf.sessionId);
    }
    removeKickedOverlay(sessionId);
    removeReconnectOverlay(sessionId);
    await TabManager.closeTab(tab.id);
    if (TabManager.activeTabId) {
      await activateTab(TabManager.activeTabId);
    } else {
      showHomeView();
    }
    renderTabs();
  };

  overlay.appendChild(iconEl);
  overlay.appendChild(msgEl);
  overlay.appendChild(closeBtn);
  parent.appendChild(overlay);
}

function removeKickedOverlay(sessionId: string): void {
  document.querySelector(`.kicked-overlay[data-session-id="${sessionId}"]`)?.remove();
}

function showReconnectOverlay(sessionId: string, tabId: string): void {
  const config = sshConfigMap.get(sessionId);
  if (!config) return;

  // Find the terminal container to overlay on
  const mt = TerminalRegistry.get(sessionId);
  const parent = mt?.container?.parentElement ?? terminalPanelEl;

  // Don't duplicate
  if (parent.querySelector(`.ssh-reconnect-overlay[data-session-id="${sessionId}"]`)) return;

  const overlay = document.createElement('div');
  overlay.className = 'ssh-reconnect-overlay';
  overlay.dataset.sessionId = sessionId;

  const iconEl = document.createElement('div');
  iconEl.className = 'ssh-reconnect-icon';
  iconEl.innerHTML = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>';

  const msgEl = document.createElement('div');
  msgEl.className = 'ssh-reconnect-msg';
  msgEl.textContent = `${config.username}@${config.host} ${t('disconnected')}`;

  const btn = document.createElement('button');
  btn.className = 'ssh-reconnect-btn';
  btn.type = 'button';
  btn.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8a6 6 0 0 1 10-4.5L14 5.5"/><path d="M14 2v3.5h-3.5"/><path d="M14 8a6 6 0 0 1-10 4.5L2 10.5"/><path d="M2 14v-3.5h3.5"/></svg>' +
    `<span>${t('reconnect') || 'Reconnect'}</span>`;

  const errorEl = document.createElement('div');
  errorEl.className = 'ssh-reconnect-error';

  overlay.appendChild(iconEl);
  overlay.appendChild(msgEl);
  overlay.appendChild(btn);
  overlay.appendChild(errorEl);
  parent.appendChild(overlay);

  btn.onclick = async () => {
    btn.classList.add('is-reconnecting');
    btn.querySelector('span')!.textContent = t('connecting') || 'Connecting...';
    overlay.classList.add('reconnecting');
    errorEl.textContent = '';
    StatusBar.setConnection('connecting', `${config.username}@${config.host}`);

    try {
      const newSessionId = await createSSHSession(config);
      sshConfigMap.set(newSessionId, config);
      sshConfigMap.delete(sessionId);
      sessionProgressMap.delete(sessionId);

      // Find the tab and update split root
      const tab = TabManager.tabs.find((t) => t.id === tabId);
      if (!tab) {
        overlay.remove();
        return;
      }

      // Update leaf session ID
      const leaves = getAllLeaves(tab.splitRoot);
      const oldLeaf = leaves.find((l) => l.sessionId === sessionId);
      if (oldLeaf) {
        oldLeaf.sessionId = newSessionId;
      }

      // Serialize old terminal content before destroying
      const historyBuffer = TerminalRegistry.serializeBuffer(sessionId);

      // Destroy old terminal
      DrawerManager.destroy(sessionId);
      AICapsuleManager.destroy(sessionId);
      TerminalRegistry.destroy(sessionId);

      // Create new terminal
      const newMt = TerminalRegistry.create(
        newSessionId,
        port,
        authToken,
        (status) => {
          const t = TabManager.tabs.find((t) => t.id === tabId);
          if (t) {
            t.status = status;
            TabManager.notify();
          }
          // Show reconnect again if this new session also disconnects
          if ((status === 'ended' || status === 'disconnected' || status === 'notfound') && sshConfigMap.has(newSessionId)) {
            showReconnectOverlay(newSessionId, tabId);
          }
        },
        (title) => {
          const t = TabManager.tabs.find((t) => t.id === tabId);
          if (t) {
            t.title = title || t.title;
            TabManager.notify();
          }
        },
      );

      // Restore old terminal content into the new terminal
      if (historyBuffer) {
        newMt.terminal.write(historyBuffer);
      }

      DrawerManager.create(newSessionId, 'ssh');
      DrawerManager.updateServerInfo(newSessionId, {
        host: config.host,
        username: config.username,
        port: config.port,
      });

      // Fade out overlay and activate tab
      overlay.classList.remove('reconnecting');
      overlay.classList.add('fade-out');
      overlay.addEventListener('animationend', () => overlay.remove());
      setTimeout(() => overlay.remove(), 500); // safety net

      await activateTab(tabId);
      StatusBar.setConnection('connected', `${config.username}@${config.host}`);
      TabManager.notify();
      renderTabs();
    } catch (err) {
      btn.classList.remove('is-reconnecting');
      btn.querySelector('span')!.textContent = t('reconnect') || 'Reconnect';
      overlay.classList.remove('reconnecting');
      errorEl.textContent = String(err);
      StatusBar.setError(`${t('sshFailed')}: ${String(err)}`);
    }
  };
}

async function activateTab(tabId: string): Promise<void> {
  setViewMode('terminal');
  hideHomeView();
  hideGalleryView();

  // Clean up old split DOM
  SplitPaneManager.destroy(terminalPanelEl);
  TerminalRegistry.hideAll(terminalPanelEl);
  DrawerManager.hideAll();
  AICapsuleManager.hideAll();
  removeSSHConnectingPlaceholder();
  hideReclaimButton();
  hideViewerOverlayDom();
  hideMasterApprovalOverlay();

  const tab = TabManager.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  const leaves = getAllLeaves(tab.splitRoot);

  // If session is still pending (SSH connecting), show placeholder
  if (leaves.length === 1 && leaves[0].sessionId.startsWith('pending-')) {
    const sshCfg = sshConfigMap.get(leaves[0].sessionId);
    // Try to find config from sshConfigMap by any means
    if (tab.status === 'connecting') {
      const placeholder = document.createElement('div');
      placeholder.id = 'ssh-connecting-placeholder';
      placeholder.className = 'ssh-connecting-placeholder';
      placeholder.innerHTML =
        `<div class="ssh-connecting-spinner"></div>` +
        `<div class="ssh-connecting-label">${t('connecting')}...</div>`;
      terminalPanelEl.appendChild(placeholder);
      renderToolbarActions();
      return;
    }
  }

  const isSplit = leaves.length > 1;

  // Ensure terminal area exists as first flex item
  const area = getOrCreateTerminalArea();

  if (isSplit) {
    // Multi-pane: render split tree into terminal area
    SplitPaneManager.setFocusedPaneId(tab.focusedPaneId);
    SplitPaneManager.render(tab.splitRoot, area);

    // Mount each terminal into its pane
    for (const leaf of leaves) {
      const paneEl = area.querySelector(`.split-pane[data-pane-id="${leaf.id}"]`) as HTMLElement;
      if (paneEl) {
        TerminalRegistry.mountToPane(leaf.sessionId, paneEl);
      }
    }
  } else {
    // Single pane: mount terminal directly into terminal area
    const leaf = leaves[0];
    TerminalRegistry.mountTo(leaf.sessionId, area);
  }

  // Mount drawer and AI bar at panel level (shared across all panes)
  const focusedLeaf = findLeafById(tab.splitRoot, tab.focusedPaneId);
  const focusedSessionId = focusedLeaf?.sessionId || leaves[0].sessionId;

  if (DrawerManager.has(focusedSessionId)) {
    DrawerManager.mountTo(focusedSessionId, terminalPanelEl);
    DrawerManager.show(focusedSessionId);
  }
  AICapsuleManager.mountTo(focusedSessionId, terminalPanelEl);
  AICapsuleManager.show(focusedSessionId);

  if (isSplit && focusedLeaf) {
    TerminalRegistry.focusTerminal(focusedSessionId);
  }

  TerminalRegistry.resizeAll();
  syncViewerOverlayForActiveTab();
  syncReclaimOverlayForActiveTab();
  syncMasterApprovalForActiveTab();
  syncLockIconForActiveTab();
  renderToolbarActions();
  StatusBar.setProgress(getActiveSessionProgress());
}

function syncLockIconForActiveTab(): void {
  const activeSessionId = TabManager.getActiveSessionId();
  StatusBar.setLocked(activeSessionId ? privateSessionIds.has(activeSessionId) : false);
}

function statusLabel(status: string): string {
  if (status === 'connecting') return t('connecting');
  if (status === 'connected') return t('connected');
  if (status === 'reconnecting') return t('reconnecting');
  if (status === 'ended') return t('ended');
  if (status === 'notfound') return t('sessionNotFound');
  return t('disconnected');
}

function setViewMode(mode: ViewMode): void {
  isHomeView = mode === 'home';
  isGalleryView = mode === 'gallery';
}

function showHomeView(): void {
  setViewMode('home');
  SplitPaneManager.destroy(terminalPanelEl);
  TerminalRegistry.hideAll(terminalPanelEl);
  DrawerManager.hideAll();
  AICapsuleManager.hideAll();
  hideGalleryView();
  removeSSHConnectingPlaceholder();
  hideReclaimButton();
  hideViewerOverlayDom();
  const existingHome = document.getElementById('home-view');
  if (!existingHome) {
    const homeView = createSSHHomeView();
    terminalPanelEl.appendChild(homeView);
  }
  updateSSHHomeView();
  renderToolbarActions();

  // Reset status bar when no active connection is displayed
  StatusBar.setConnection('disconnected');
  StatusBar.setLocked(false);
  StatusBar.setLatency(null);
  StatusBar.setProgress(null);
}

function hideHomeView(): void {
  const homeView = document.getElementById('home-view');
  if (homeView) {
    homeView.remove();
  }
}

function showGalleryView(): void {
  setViewMode('gallery');
  SplitPaneManager.destroy(terminalPanelEl);
  TerminalRegistry.hideAll(terminalPanelEl);
  DrawerManager.hideAll();
  AICapsuleManager.hideAll();
  hideHomeView();
  removeSSHConnectingPlaceholder();
  hideReclaimButton();
  const existingGallery = document.getElementById('gallery-view');
  if (!existingGallery) {
    const galleryView = createGalleryView();
    terminalPanelEl.appendChild(galleryView);
  }
  updateGalleryView();
  startGalleryRefresh();
  renderToolbarActions();
  StatusBar.setProgress(null);
}

function hideGalleryView(): void {
  const galleryView = document.getElementById('gallery-view');
  if (galleryView) {
    galleryView.remove();
  }
  stopGalleryRefresh();
}

async function openSettings(tab?: string): Promise<void> {
  // Check if settings window already exists
  const existing = await WebviewWindow.getByLabel('settings');
  if (existing) {
    void existing.show();
    void existing.setFocus();
    return;
  }

  // Determine URL base
  const baseUrl = window.location.origin + window.location.pathname;
  let settingsUrl = baseUrl + '?window=settings';
  if (tab) settingsUrl += `&tab=${tab}`;

  const nativeTheme = resolveThemeAttr(settings.colorScheme) === 'light' ? 'light' as const : 'dark' as const;
  const settingsWindow = new WebviewWindow('settings', {
    url: settingsUrl,
    title: t('settings'),
    width: 480,
    height: 580,
    resizable: false,
    center: true,
    // On Windows: use custom title bar (decorations: false) for consistent look.
    // Other platforms: use native title bar.
    decorations: !isWindowsPlatform,
    transparent: false,
    theme: nativeTheme,
  });

  settingsWindow.once('tauri://created', () => {
    void settingsWindow.setFocus();
  });
  settingsWindow.once('tauri://error', (e: unknown) => {
    console.error('Failed to create settings window:', e);
  });
}

async function createNewSession(shell?: string): Promise<void> {
  const ready = await ensureMeTermReady();
  if (!ready) {
    return;
  }
  // Use configured default shell when no specific shell is requested
  const effectiveShell = shell || settings.defaultShell || undefined;
  await TabManager.addTab(port, authToken, effectiveShell);
  if (TabManager.activeTabId) {
    await activateTab(TabManager.activeTabId);
    StatusBar.setConnection('connected', 'Local');
  }
  renderTabs();
}

async function createNewPrivateSession(): Promise<void> {
  const ready = await ensureMeTermReady();
  if (!ready) return;
  await TabManager.addTab(port, authToken);
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
  renderTabs();
}

function getActiveSessionProgress(): { state: number; percent: number } | null {
  if (isHomeView || isGalleryView) return null;
  const sessionId = TabManager.getActiveSessionId();
  if (!sessionId) return null;
  return sessionProgressMap.get(sessionId) ?? null;
}

function applyProgressLayer(el: HTMLElement, progress: { state: number; percent: number } | null): void {
  let layer = el.querySelector('.osc-progress-layer') as HTMLDivElement | null;
  if (!progress || progress.state === 0) {
    if (layer) layer.remove();
    return;
  }
  let fill: HTMLDivElement;
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'osc-progress-layer';
    fill = document.createElement('div');
    fill.className = 'osc-progress-fill';
    layer.appendChild(fill);
    el.insertBefore(layer, el.firstChild);
  } else {
    fill = layer.querySelector('.osc-progress-fill') as HTMLDivElement;
  }
  fill.classList.remove('normal', 'error', 'indeterminate');
  if (progress.state === 1) {
    fill.classList.add('normal');
    fill.style.width = `${progress.percent}%`;
  } else if (progress.state === 2) {
    fill.classList.add('error');
    fill.style.width = `${progress.percent}%`;
  } else if (progress.state === 3) {
    fill.classList.add('indeterminate');
    fill.style.width = '100%';
  }
}

function syncTabProgressLayers(): void {
  const scrollContainer = toolbarTabsEl.querySelector('.tab-scroll-container');
  if (!scrollContainer) return;
  const tabNodes = Array.from(scrollContainer.querySelectorAll('.title-tab')) as HTMLButtonElement[];
  TabManager.tabs.forEach((tab, i) => {
    const node = tabNodes[i];
    if (!node) return;
    const leaves = getAllLeaves(tab.splitRoot);
    // Use the first leaf's progress for the tab indicator
    let tabProgress: { state: number; percent: number } | null = null;
    for (const leaf of leaves) {
      const p = sessionProgressMap.get(leaf.sessionId);
      if (p && p.state !== 0) { tabProgress = p; break; }
    }
    applyProgressLayer(node, tabProgress);
  });
}

function syncGalleryProgressBars(): void {
  const cards = document.querySelectorAll('.session-card[data-session-id]') as NodeListOf<HTMLDivElement>;
  cards.forEach((card) => {
    const sessionId = card.dataset.sessionId;
    if (!sessionId) return;
    const fill = card.querySelector('.gallery-progress-fill') as HTMLDivElement | null;
    if (!fill) return;
    const progress = sessionProgressMap.get(sessionId);
    fill.classList.remove('normal', 'error', 'indeterminate');
    if (!progress || progress.state === 0) {
      fill.style.width = '0%';
      return;
    }
    if (progress.state === 1) {
      fill.classList.add('normal');
      fill.style.width = `${progress.percent}%`;
    } else if (progress.state === 2) {
      fill.classList.add('error');
      fill.style.width = `${progress.percent}%`;
    } else if (progress.state === 3) {
      fill.classList.add('indeterminate');
      fill.style.width = '100%';
    }
  });
}

function renderTabs(): void {
  tabBarEl.innerHTML = '';
  tabBarEl.style.display = 'none';
  toolbarTabsEl.innerHTML = '';
  if (TabManager.tabs.length === 0) {
    void invoke('set_has_open_tabs', { hasOpenTabs: false });
    return;
  }

  // Create scroll container for tabs
  const scrollContainer = document.createElement('div');
  scrollContainer.className = 'tab-scroll-container';

  TabManager.tabs.forEach((tab) => {
    const node = document.createElement('button');
    const tabLeaves = getAllLeaves(tab.splitRoot);
    const hasPendingRequest = tabLeaves.some((l) => pendingMasterRequests.has(l.sessionId));
    const isActive = tab.id === TabManager.activeTabId && !isHomeView && !isGalleryView;
    node.className = `title-tab${isActive ? ' active' : ''}${hasPendingRequest && !isActive ? ' tab-breathing' : ''}`;
    node.type = 'button';
    const isSSH = tabLeaves.some((l) => sshConfigMap.has(l.sessionId));
    const isRemoteTab = tabLeaves.some((l) => TerminalRegistry.get(l.sessionId)?.isRemote);
    const remoteLeaf = isRemoteTab ? tabLeaves.find((l) => TerminalRegistry.get(l.sessionId)?.isRemote) : null;
    const remoteNum = remoteLeaf ? remoteTabNumbers.get(remoteLeaf.sessionId) : undefined;
    const cloudIconSvg = isSSH ? '<svg class="tab-ssh-icon" width="12" height="12" viewBox="0 0 24 24" fill="#3b82f6"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>' : '';
    const isKickedTab = isRemoteTab && tabLeaves.some((l) => TerminalRegistry.get(l.sessionId)?.kicked);
    const remoteIconSvg = isRemoteTab
      ? `<span class="tab-remote-icon-wrap${isKickedTab ? ' kicked' : ''}"><svg class="tab-remote-icon" width="12" height="12" viewBox="0 0 24 24" fill="#22c55e"><circle cx="12" cy="12" r="9" fill="none" stroke="#22c55e" stroke-width="2"/><ellipse cx="12" cy="12" rx="4" ry="9" fill="none" stroke="#22c55e" stroke-width="1.7"/><path d="M3.5 9h17M3.5 15h17" fill="none" stroke="#22c55e" stroke-width="1.5"/></svg>${isKickedTab ? '<svg class="tab-kicked-x" width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/><line x1="10" y1="2" x2="2" y2="10" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/></svg>' : ''}${remoteNum !== undefined ? `<span class="tab-remote-badge">${remoteNum}</span>` : ''}</span>`
      : '';
    const hasIcon = isSSH || isRemoteTab;
    const iconArea = hasIcon ? `<span class="tab-icon-area">${cloudIconSvg}${remoteIconSvg}</span>` : '';
    node.innerHTML = `${iconArea}<span class="title-tab-track"><span class="title-tab-track-inner"><span class="title-tab-text primary">${escapeHtml(tab.title)}</span><span class="title-tab-text duplicate" aria-hidden="true">${escapeHtml(tab.title)}</span></span></span>`;
    node.title = `${tab.title} · ${statusLabel(tab.status)}`;
    node.onclick = async () => {
      TabManager.activate(tab.id);
      await activateTab(tab.id);
      const activeSessionId = TabManager.getActiveSessionId();
      const sshCfg = activeSessionId ? sshConfigMap.get(activeSessionId) : undefined;
      StatusBar.setConnection(tab.status, sshCfg ? `${sshCfg.username}@${sshCfg.host}` : 'Local');
      renderTabs();
    };

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.onclick = async (e) => {
      e.stopPropagation();
      // Destroy drawers/AI for all sessions in this tab
      const closingLeaves = getAllLeaves(tab.splitRoot);
      for (const leaf of closingLeaves) {
        DrawerManager.destroy(leaf.sessionId);
        AICapsuleManager.destroy(leaf.sessionId);
        sshConfigMap.delete(leaf.sessionId);
        remoteInfoMap.delete(leaf.sessionId);
        remoteTabNumbers.delete(leaf.sessionId);
        viewerModeSessionIds.delete(leaf.sessionId);
        reclaimSessionIds.delete(leaf.sessionId);
        privateSessionIds.delete(leaf.sessionId);
        sessionProgressMap.delete(leaf.sessionId);
        removeKickedOverlay(leaf.sessionId);
        removeReconnectOverlay(leaf.sessionId);
      }
      await TabManager.closeTab(tab.id);
      if (TabManager.activeTabId) {
        await activateTab(TabManager.activeTabId);
        const newActiveTab = TabManager.tabs.find(t => t.id === TabManager.activeTabId);
        if (newActiveTab) {
          const activeSessionId = TabManager.getActiveSessionId();
          const sshCfg = activeSessionId ? sshConfigMap.get(activeSessionId) : undefined;
          StatusBar.setConnection(newActiveTab.status, sshCfg ? `${sshCfg.username}@${sshCfg.host}` : 'Local');
        }
      } else {
        showHomeView();
      }
      renderTabs();
    };

    node.addEventListener('contextmenu', (e) => {
      showTabContextMenu(e, tab, TabManager.tabs.indexOf(tab));
    });

    node.appendChild(close);

    // OSC 9;4 progress layer for this tab
    const tabLeavesList = getAllLeaves(tab.splitRoot);
    let tabProgress: { state: number; percent: number } | null = null;
    for (const leaf of tabLeavesList) {
      const p = sessionProgressMap.get(leaf.sessionId);
      if (p && p.state !== 0) { tabProgress = p; break; }
    }
    applyProgressLayer(node, tabProgress);

    scrollContainer.appendChild(node);
    initTabDrag(node, tab.id);
  });

  toolbarTabsEl.appendChild(scrollContainer);

  requestAnimationFrame(() => {
    syncTabMarqueeState();
    scrollActiveTabIntoView();
  });

  void invoke('set_has_open_tabs', { hasOpenTabs: TabManager.tabs.length > 0 });
}

function syncTabMarqueeState(): void {
  const scrollContainer = toolbarTabsEl.querySelector('.tab-scroll-container') as HTMLDivElement | null;
  if (!scrollContainer) return;

  const allNodes = Array.from(scrollContainer.querySelectorAll('.title-tab')) as HTMLButtonElement[];
  if (allNodes.length === 0) {
    toolbarTabsEl.classList.remove('overflow-mode');
    return;
  }

  const tabsGap = 6;
  const totalGap = tabsGap * Math.max(0, allNodes.length - 1);

  // Per-tab minimum width calculation:
  //   border(2) + padding(12) + gap-to-close(6) + close-margin(4) + close(16) = 40px chrome
  //   + text area: 44px (3 CJK chars or 6 Latin chars at 12px monospace ≈ 6 × 7.2px)
  //   + icon area ~24px extra for tabs with icons
  const MIN_TEXT_WIDTH = 44;
  const TAB_CHROME = 40; // border(2) + padding(12) + gap(6) + close-margin(4) + close(16)
  const ICON_EXTRA = 24; // icon-area width
  const perTabMinWidths = allNodes.map((node) => {
    const hasIcons = node.querySelector('.tab-icon-area') !== null;
    return TAB_CHROME + MIN_TEXT_WIDTH + (hasIcons ? ICON_EXTRA : 0);
  });

  // Calculate available width for tabs
  // In overflow mode, scroll buttons take 20px + 2px gap each = ~44px total
  const scrollBtnSpace = 44;
  const rawAvailable = Math.max(0, toolbarTabsEl.clientWidth);
  const largestMinWidth = Math.max(...perTabMinWidths);
  const maxWidth = Math.max(largestMinWidth, Math.floor(rawAvailable / 3));

  // Check if overflow would occur: tabs at their minimum can't fit
  const minTotal = perTabMinWidths.reduce((acc, w) => acc + w, 0) + totalGap;
  const isOverflow = minTotal > rawAvailable;

  // Calculate available width accounting for scroll buttons if in overflow mode
  const available = isOverflow ? Math.max(0, rawAvailable - scrollBtnSpace) : rawAvailable;

  // Calculate per-tab desired widths
  const desiredWidths = allNodes.map((node, index) => {
    const primaryEl = node.querySelector('.title-tab-text.primary') as HTMLSpanElement | null;
    const closeEl = node.querySelector('.tab-close') as HTMLSpanElement | null;
    if (!primaryEl || !closeEl) return perTabMinWidths[index];

    const style = getComputedStyle(node);
    const paddingX = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    const borderX = (Number.parseFloat(style.borderLeftWidth) || 0) + (Number.parseFloat(style.borderRightWidth) || 0);
    const innerGap = Number.parseFloat(style.columnGap || style.gap || '6') || 6;
    const chrome = closeEl.offsetWidth + paddingX + borderX + innerGap;
    const desired = Math.ceil(primaryEl.scrollWidth + chrome);

    return Math.min(maxWidth, Math.max(perTabMinWidths[index], desired));
  });

  if (isOverflow) {
    // Overflow mode: each tab uses its own minimum width, enable scrolling
    allNodes.forEach((node, index) => {
      node.style.width = `${perTabMinWidths[index]}px`;
    });

    toolbarTabsEl.classList.add('overflow-mode');
    ensureScrollButtons(scrollContainer);
  } else {
    // Normal mode: distribute widths
    const desiredTotal = desiredWidths.reduce((acc, w) => acc + w, 0) + totalGap;
    const useUniform = desiredTotal > available;
    const uniformWidth = Math.min(
      maxWidth,
      Math.max(largestMinWidth, Math.floor((available - totalGap) / Math.max(1, allNodes.length))),
    );

    allNodes.forEach((node, index) => {
      node.style.width = `${useUniform ? uniformWidth : desiredWidths[index]}px`;
    });

    toolbarTabsEl.classList.remove('overflow-mode');
    removeScrollButtons();
  }

  // Marquee animation for individual tabs (unchanged logic)
  allNodes.forEach((node) => {
    const primaryEl = node.querySelector('.title-tab-text.primary') as HTMLSpanElement | null;
    const trackEl = node.querySelector('.title-tab-track') as HTMLSpanElement | null;
    const trackInnerEl = node.querySelector('.title-tab-track-inner') as HTMLSpanElement | null;
    const closeEl = node.querySelector('.tab-close') as HTMLSpanElement | null;
    if (!primaryEl || !trackEl || !trackInnerEl || !closeEl) return;

    const shouldScroll = primaryEl.scrollWidth > trackEl.clientWidth + 2;
    if (shouldScroll) {
      const gap = 24;
      node.style.setProperty('--marquee-shift', `${primaryEl.scrollWidth + gap}px`);
      node.classList.add('is-overflowing');
    } else {
      node.style.removeProperty('--marquee-shift');
      node.classList.remove('is-overflowing');
      trackInnerEl.style.transform = 'translateX(0)';
    }
  });
}

function ensureScrollButtons(scrollContainer: HTMLDivElement): void {
  // Check if scroll buttons already exist
  if (toolbarTabsEl.querySelector('.tab-scroll-btn')) return;

  const leftBtn = document.createElement('button');
  leftBtn.className = 'tab-scroll-btn tab-scroll-left';
  leftBtn.type = 'button';
  leftBtn.innerHTML = `<span class="tab-icon">${icon('chevronLeft')}</span>`;

  const rightBtn = document.createElement('button');
  rightBtn.className = 'tab-scroll-btn tab-scroll-right';
  rightBtn.type = 'button';
  rightBtn.innerHTML = `<span class="tab-icon">${icon('chevronRight')}</span>`;

  // Insert: [leftBtn] [scrollContainer] [rightBtn]
  toolbarTabsEl.insertBefore(leftBtn, scrollContainer);
  toolbarTabsEl.appendChild(rightBtn);

  // Update arrow visibility based on scroll position
  const updateArrows = () => {
    const sl = scrollContainer.scrollLeft;
    const maxScroll = scrollContainer.scrollWidth - scrollContainer.clientWidth;
    leftBtn.classList.toggle('hidden', sl <= 0);
    rightBtn.classList.toggle('hidden', sl >= maxScroll - 1);
  };

  // Click: scroll one tab width
  leftBtn.addEventListener('click', () => {
    const tabWidth = scrollContainer.querySelector('.title-tab')?.getBoundingClientRect().width || 80;
    scrollContainer.scrollBy({ left: -tabWidth, behavior: 'smooth' });
  });
  rightBtn.addEventListener('click', () => {
    const tabWidth = scrollContainer.querySelector('.title-tab')?.getBoundingClientRect().width || 80;
    scrollContainer.scrollBy({ left: tabWidth, behavior: 'smooth' });
  });

  // Hold: continuous scroll after 300ms delay
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdInterval: ReturnType<typeof setInterval> | null = null;

  const startHold = (direction: number) => {
    holdTimer = setTimeout(() => {
      holdInterval = setInterval(() => {
        scrollContainer.scrollBy({ left: direction * 8 });
        updateArrows();
      }, 50);
    }, 300);
  };

  const stopHold = () => {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (holdInterval) { clearInterval(holdInterval); holdInterval = null; }
  };

  leftBtn.addEventListener('pointerdown', () => startHold(-1));
  rightBtn.addEventListener('pointerdown', () => startHold(1));
  leftBtn.addEventListener('pointerup', stopHold);
  rightBtn.addEventListener('pointerup', stopHold);
  leftBtn.addEventListener('pointerleave', stopHold);
  rightBtn.addEventListener('pointerleave', stopHold);

  // Right-click: jump to start/end
  leftBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    scrollContainer.scrollTo({ left: 0, behavior: 'smooth' });
  });
  rightBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    scrollContainer.scrollTo({ left: scrollContainer.scrollWidth, behavior: 'smooth' });
  });

  // Listen for scroll events to update arrow visibility
  scrollContainer.addEventListener('scroll', updateArrows);

  // Initial update
  requestAnimationFrame(updateArrows);
}

function removeScrollButtons(): void {
  const buttons = toolbarTabsEl.querySelectorAll('.tab-scroll-btn');
  buttons.forEach((btn) => btn.remove());
}

function scrollActiveTabIntoView(): void {
  const scrollContainer = toolbarTabsEl.querySelector('.tab-scroll-container') as HTMLDivElement | null;
  if (!scrollContainer) return;
  const activeTab = scrollContainer.querySelector('.title-tab.active') as HTMLElement | null;
  if (!activeTab) return;
  // Only scroll if in overflow mode
  if (scrollContainer.scrollWidth <= scrollContainer.clientWidth) return;

  const containerRect = scrollContainer.getBoundingClientRect();
  const tabRect = activeTab.getBoundingClientRect();

  if (tabRect.left < containerRect.left) {
    scrollContainer.scrollBy({ left: tabRect.left - containerRect.left - 4, behavior: 'smooth' });
  } else if (tabRect.right > containerRect.right) {
    scrollContainer.scrollBy({ left: tabRect.right - containerRect.right + 4, behavior: 'smooth' });
  }
}

// ---------------------------------------------------------------------------
// Master request approval dialog + reclaim button
// ---------------------------------------------------------------------------
// Pending master control requests: sessionId → { requesterId, timerId }
const pendingMasterRequests = new Map<string, { requesterId: string; timerId: ReturnType<typeof setTimeout> }>();
let masterApprovalOverlayEl: HTMLDivElement | null = null;
let masterApprovalSessionId: string | null = null;

function createMasterApprovalOverlayEl(sessionId: string, requesterId: string): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.className = 'master-approval-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'master-approval-dialog';

  const shortId = requesterId.length > 12 ? requesterId.slice(0, 8) + '...' : requesterId;
  dialog.innerHTML = `
    <div class="master-approval-icon">
      <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="8.5" cy="7" r="4"/>
        <path d="M20 8v6"/>
        <path d="M23 11h-6"/>
      </svg>
    </div>
    <h3>${t('masterRequestTitle') || 'Control Request'}</h3>
    <p>${t('masterRequestMessage') || 'A remote viewer wants to take control of the terminal.'}</p>
    <p class="master-approval-requester">${escapeHtml(shortId)}</p>
  `;

  const buttons = document.createElement('div');
  buttons.className = 'master-approval-buttons';

  const denyBtn = document.createElement('button');
  denyBtn.className = 'master-approval-btn deny';
  denyBtn.textContent = t('masterRequestDeny') || 'Deny';
  denyBtn.onclick = () => respondMasterRequest(sessionId, false);

  const approveBtn = document.createElement('button');
  approveBtn.className = 'master-approval-btn approve';
  approveBtn.textContent = t('masterRequestApprove') || 'Approve';
  approveBtn.onclick = () => respondMasterRequest(sessionId, true);

  buttons.appendChild(denyBtn);
  buttons.appendChild(approveBtn);
  dialog.appendChild(buttons);
  overlay.appendChild(dialog);
  return overlay;
}

function respondMasterRequest(sessionId: string, approved: boolean): void {
  const pending = pendingMasterRequests.get(sessionId);
  if (!pending) return;
  clearTimeout(pending.timerId);
  TerminalRegistry.sendMasterApproval(sessionId, approved, pending.requesterId);
  pendingMasterRequests.delete(sessionId);
  hideMasterApprovalOverlay();
  renderTabs(); // remove breathing animation
}

function showMasterApprovalOverlay(sessionId: string): void {
  hideMasterApprovalOverlay();
  const pending = pendingMasterRequests.get(sessionId);
  if (!pending) return;
  masterApprovalSessionId = sessionId;
  const overlay = createMasterApprovalOverlayEl(sessionId, pending.requesterId);
  terminalPanelEl.appendChild(overlay);
  masterApprovalOverlayEl = overlay;
}

function hideMasterApprovalOverlay(): void {
  if (masterApprovalOverlayEl) {
    masterApprovalOverlayEl.remove();
    masterApprovalOverlayEl = null;
  }
  masterApprovalSessionId = null;
}

/** Sync master approval overlay visibility when switching tabs */
function syncMasterApprovalForActiveTab(): void {
  // Never show overlay on top of home/gallery view — tab breathing animation alerts the user.
  if (isHomeView || isGalleryView) { hideMasterApprovalOverlay(); return; }
  const activeTab = TabManager.getActiveTab();
  if (!activeTab) { hideMasterApprovalOverlay(); return; }

  const leaves = getAllLeaves(activeTab.splitRoot);
  const pendingLeaf = leaves.find((l) => pendingMasterRequests.has(l.sessionId));

  if (pendingLeaf) {
    if (masterApprovalSessionId !== pendingLeaf.sessionId) {
      showMasterApprovalOverlay(pendingLeaf.sessionId);
    }
  } else {
    hideMasterApprovalOverlay();
  }
}

function showMasterApprovalDialog(sessionId: string, requesterId: string): void {
  // Remove any previous request for this session
  const prev = pendingMasterRequests.get(sessionId);
  if (prev) clearTimeout(prev.timerId);

  // Auto-deny after 30 seconds
  const timerId = setTimeout(() => {
    if (pendingMasterRequests.has(sessionId)) {
      respondMasterRequest(sessionId, false);
    }
  }, 30000);

  pendingMasterRequests.set(sessionId, { requesterId, timerId });

  // System notification (dock bounce / taskbar flash)
  void notifyUser({
    id: `master-${requesterId}`,
    type: 'master-request',
    title: t('masterRequestTitle') || 'Control Request',
    body: t('masterRequestMessage') || 'A remote viewer wants to take control.',
  });

  // Show overlay if the session is on the active tab and not in home/gallery view.
  // syncMasterApprovalForActiveTab contains the home/gallery guard.
  syncMasterApprovalForActiveTab();
  renderTabs(); // trigger breathing animation on the target tab
}

// ---------------------------------------------------------------------------
// Pair request approval dialog
// ---------------------------------------------------------------------------
/** Send pair approval via WebSocket (preferred) or HTTP fallback. */
function respondPairApproval(approved: boolean, pairId: string): void {
  const sent = TerminalRegistry.sendPairApproval(approved, pairId);
  if (!sent && port > 0 && authToken) {
    // HTTP fallback when no active WebSocket connection
    void fetch(`http://127.0.0.1:${port}/api/pair/${pairId}/respond`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ approved }),
    }).catch(() => { /* ignore network errors */ });
  }
}

function showPairApprovalDialog(pairId: string, deviceInfo: string, remoteAddr: string): void {
  const existing = document.getElementById('pair-approval-dialog');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'pair-approval-dialog';
  overlay.className = 'master-approval-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'master-approval-dialog';

  dialog.innerHTML = `
    <div class="master-approval-icon">
      <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
        <line x1="12" y1="18" x2="12.01" y2="18"/>
      </svg>
    </div>
    <h3>${t('pairApprovalTitle')}</h3>
    <p>${t('pairApprovalMessage')}</p>
    <div class="pair-approval-info">
      <div class="pair-approval-row"><span class="pair-approval-label">${t('pairApprovalDevice')}:</span> ${escapeHtml(deviceInfo)}</div>
      <div class="pair-approval-row"><span class="pair-approval-label">${t('pairApprovalAddress')}:</span> ${escapeHtml(remoteAddr)}</div>
    </div>
  `;

  const buttons = document.createElement('div');
  buttons.className = 'master-approval-buttons';

  const denyBtn = document.createElement('button');
  denyBtn.className = 'master-approval-btn deny';
  denyBtn.textContent = t('pairApprovalDeny');
  denyBtn.onclick = () => {
    respondPairApproval(false, pairId);
    overlay.remove();
    clearTimeout(timer);
  };

  const approveBtn = document.createElement('button');
  approveBtn.className = 'master-approval-btn approve';
  approveBtn.textContent = t('pairApprovalApprove');
  approveBtn.onclick = () => {
    respondPairApproval(true, pairId);
    overlay.remove();
    clearTimeout(timer);
  };

  buttons.appendChild(denyBtn);
  buttons.appendChild(approveBtn);
  dialog.appendChild(buttons);
  overlay.appendChild(dialog);

  // Auto-deny after 30 seconds
  const timer = setTimeout(() => {
    if (document.body.contains(overlay)) {
      respondPairApproval(false, pairId);
      overlay.remove();
    }
  }, 30000);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      clearTimeout(timer);
      respondPairApproval(false, pairId);
      overlay.remove();
    }
  });

  // System notification (dock bounce / taskbar flash)
  void notifyUser({
    id: pairId,
    type: 'pair-request',
    title: t('pairApprovalTitle'),
    body: `${deviceInfo} (${remoteAddr})`,
  });

  document.body.appendChild(overlay);
}

/** Start polling for pending pair requests — covers no-session scenario. */
function startPairPoller(pollPort: number, pollToken: string): void {
  if (pairPollTimer) return;
  // Periodically clear stale dedup entries (pair requests expire after 90s on backend)
  setInterval(() => handledPairIds.clear(), 5 * 60 * 1000);
  pairPollTimer = setInterval(async () => {
    try {
      const resp = await fetch(`http://127.0.0.1:${pollPort}/api/pair/pending`, {
        headers: { 'Authorization': `Bearer ${pollToken}` },
      });
      if (!resp.ok) return;
      const data = await resp.json();
      for (const req of data.requests || []) {
        if (!handledPairIds.has(req.pair_id)) {
          handledPairIds.add(req.pair_id);
          showPairApprovalDialog(req.pair_id, req.device_info, req.remote_addr);
        }
      }
    } catch { /* ignore network errors */ }
  }, 3000);
}

let reclaimOverlayEl: HTMLDivElement | null = null;
let reclaimKeyHandler: ((e: KeyboardEvent) => void) | null = null;
// Track which sessions are being remotely controlled (need reclaim overlay)
const reclaimSessionIds = new Set<string>();

function showReclaimButton(sessionId: string): void {
  hideReclaimButton();

  const overlay = document.createElement('div');
  overlay.className = 'reclaim-overlay';
  overlay.innerHTML = `
    <div class="reclaim-overlay-content">
      <div class="reclaim-overlay-text">${t('reclaimClickHint') || '点击取消远控'}</div>
      <div class="reclaim-overlay-subtext">${t('reclaimSpaceHint') || '(空格取消远控)'}</div>
    </div>
  `;

  const doReclaim = () => {
    reclaimSessionIds.delete(sessionId);
    TerminalRegistry.sendMasterReclaim(sessionId);
    hideReclaimButton();
  };

  overlay.onclick = doReclaim;

  reclaimKeyHandler = (e: KeyboardEvent) => {
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      doReclaim();
    }
  };
  document.addEventListener('keydown', reclaimKeyHandler);

  terminalPanelEl.appendChild(overlay);
  reclaimOverlayEl = overlay;
}

function hideReclaimButton(): void {
  if (reclaimOverlayEl) {
    reclaimOverlayEl.remove();
    reclaimOverlayEl = null;
  }
  if (reclaimKeyHandler) {
    document.removeEventListener('keydown', reclaimKeyHandler);
    reclaimKeyHandler = null;
  }
}

// Viewer overlay — transparent overlay preventing input for remote viewer sessions
// Track which sessions are in viewer mode (need overlay)
const viewerModeSessionIds = new Set<string>();
const privateSessionIds = new Set<string>();
let viewerOverlayEl: HTMLDivElement | null = null;
let viewerOverlaySessionId: string | null = null;

function createViewerOverlayEl(sessionId: string): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.className = 'viewer-overlay';

  const content = document.createElement('div');
  content.className = 'viewer-overlay-content';

  const badge = document.createElement('div');
  badge.className = 'viewer-overlay-badge';
  badge.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3.5 9h17M3.5 15h17"/></svg><span>${t('viewerObserving')}</span>`;

  const requestBtn = document.createElement('button');
  requestBtn.className = 'viewer-request-btn';
  requestBtn.type = 'button';
  requestBtn.textContent = t('viewerRequestControl');
  requestBtn.onclick = () => {
    TerminalRegistry.sendMasterRequest(sessionId);
    requestBtn.textContent = t('viewerRequesting');
    requestBtn.disabled = true;
    requestBtn.classList.add('requesting');
    setTimeout(() => {
      if (requestBtn.disabled && document.body.contains(requestBtn)) {
        requestBtn.textContent = t('viewerRequestControl');
        requestBtn.disabled = false;
        requestBtn.classList.remove('requesting');
      }
    }, 10000);
  };

  content.appendChild(badge);
  content.appendChild(requestBtn);
  overlay.appendChild(content);
  return overlay;
}

function showViewerOverlay(sessionId: string): void {
  hideViewerOverlayDom();
  viewerOverlaySessionId = sessionId;
  const overlay = createViewerOverlayEl(sessionId);
  terminalPanelEl.appendChild(overlay);
  viewerOverlayEl = overlay;
}

function hideViewerOverlayDom(): void {
  if (viewerOverlayEl) {
    viewerOverlayEl.remove();
    viewerOverlayEl = null;
  }
  viewerOverlaySessionId = null;
}

/** Mark session as viewer mode and show overlay if it's the active tab */
function enterViewerMode(sessionId: string): void {
  viewerModeSessionIds.add(sessionId);
  syncViewerOverlayForActiveTab();
}

/** Remove session from viewer mode and hide overlay if needed */
function exitViewerMode(sessionId: string): void {
  viewerModeSessionIds.delete(sessionId);
  syncViewerOverlayForActiveTab();
}

/** Show or hide viewer overlay based on whether the active tab has a viewer session */
function syncViewerOverlayForActiveTab(): void {
  if (isHomeView || isGalleryView) { hideViewerOverlayDom(); return; }
  const activeTab = TabManager.getActiveTab();
  if (!activeTab) { hideViewerOverlayDom(); return; }

  const leaves = getAllLeaves(activeTab.splitRoot);
  const viewerLeaf = leaves.find((l) => viewerModeSessionIds.has(l.sessionId));

  if (viewerLeaf) {
    // Active tab has a viewer session — show overlay if not already for this session
    if (viewerOverlaySessionId !== viewerLeaf.sessionId) {
      showViewerOverlay(viewerLeaf.sessionId);
    }
  } else {
    hideViewerOverlayDom();
  }
}

/** Show or hide reclaim overlay based on whether the active tab has a reclaim session */
function syncReclaimOverlayForActiveTab(): void {
  // Never show overlay on top of home/gallery view.
  if (isHomeView || isGalleryView) { hideReclaimButton(); return; }
  const activeTab = TabManager.getActiveTab();
  if (!activeTab) { hideReclaimButton(); return; }

  const leaves = getAllLeaves(activeTab.splitRoot);
  const reclaimLeaf = leaves.find((l) => reclaimSessionIds.has(l.sessionId));

  if (reclaimLeaf) {
    // Active tab has a session being remotely controlled — show reclaim overlay
    if (!reclaimOverlayEl) {
      showReclaimButton(reclaimLeaf.sessionId);
    }
  } else {
    hideReclaimButton();
  }
}

function showViewerRequestDenied(): void {
  if (!viewerOverlayEl) return;
  const btn = viewerOverlayEl.querySelector('.viewer-request-btn') as HTMLButtonElement | null;
  if (btn) {
    btn.textContent = t('viewerRequestDenied');
    btn.classList.remove('requesting');
    btn.classList.add('denied');
    setTimeout(() => {
      if (document.body.contains(btn)) {
        btn.textContent = t('viewerRequestControl');
        btn.disabled = false;
        btn.classList.remove('denied');
      }
    }, 3000);
  }
}

async function createNewWindowNearCurrent(): Promise<void> {
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

function showWindowsToolbarMenu(anchor: HTMLElement): void {
  const existing = document.getElementById('app-toolbar-menu');
  if (existing) {
    existing.remove();
  }

  const menu = document.createElement('div');
  menu.id = 'app-toolbar-menu';
  menu.className = 'custom-context-menu app-toolbar-menu';

  const addItem = (label: string, onClick: () => void | Promise<void>, disabled = false): void => {
    const item = document.createElement('button');
    item.className = 'custom-context-menu-item';
    item.type = 'button';
    item.textContent = label;
    item.disabled = disabled;
    item.onclick = () => {
      cleanup();
      void onClick();
    };
    menu.appendChild(item);
  };

  const addDivider = (): void => {
    menu.appendChild(document.createElement('div')).className = 'custom-context-menu-divider';
  };

  const zh = settings?.language === 'zh';

  const addCheckItem = (label: string, checked: boolean, onClick: () => void | Promise<void>): void => {
    const item = document.createElement('button');
    item.className = 'custom-context-menu-item';
    item.type = 'button';
    item.textContent = checked ? `✓ ${label}` : `    ${label}`;
    item.onclick = () => {
      cleanup();
      void onClick();
    };
    menu.appendChild(item);
  };

  addItem(zh ? '新窗口' : 'New Window', async () => {
    await createNewWindowNearCurrent();
  });
  addItem(t('contextMenuHome'), () => {
    showHomeView();
    renderTabs();
  });
  addItem(t('newTerminal'), async () => {
    await createNewSession();
  });
  addItem(t('newPrivateTerminal'), async () => {
    await createNewPrivateSession();
  });
  addItem(t('settings'), () => {
    openSettings();
  });
  addDivider();
  const isDiscoverable = localStorage.getItem('meterm-discoverable') === '1';
  addCheckItem(
    zh ? '局域网发现' : 'LAN Discovery',
    isDiscoverable,
    async () => {
      const newState = !isDiscoverable;
      try {
        await invoke('toggle_lan_sharing', { enabled: newState });
        localStorage.setItem('meterm-discoverable', newState ? '1' : '0');
        await invoke('set_discoverable_state', { checked: newState });
      } catch (err) {
        console.error('toggle_lan_sharing failed:', err);
      }
    },
  );
  addDivider();
  addItem(
    zh ? '导入连接' : 'Import Connections',
    async () => {
      const filePath = await openDialog({
        multiple: false,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (filePath) {
        try {
          const json = await readTextFile(filePath as string);
          const result = importConnectionsFromJSON(json);
          updateSSHHomeView();
          await showInfoSystem(`${result.count} ${t('sshImportCount')}`, t('sshImportSuccess'));
        } catch {
          await showInfoSystem(t('sshImportInvalidFormat'), t('sshImportFailed'));
        }
      }
    },
  );
  addItem(
    zh ? '导出连接' : 'Export Connections',
    async () => {
      const result = await exportConnectionsToJSON();
      if (!result) {
        await showInfoSystem(t('sshNoConnectionsToExport'), t('appName'));
        return;
      }
      const filePath = await save({
        defaultPath: 'meterm-connections.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (filePath) {
        await writeTextFile(filePath, result.json);
        await showInfoSystem(`${result.count} ${t('sshExportCount')}`, t('sshExportSuccess'));
      }
    },
  );
  addItem(
    zh ? '关闭所有会话' : 'Close All Sessions',
    async () => {
      if (TabManager.tabs.length === 0) return;
      const confirmed = await confirmSystem(t('confirmCloseAllSessions'));
      if (!confirmed) return;
      await closeAllSessions();
    },
    TabManager.tabs.length === 0,
  );
  addDivider();
  addItem(zh ? '关闭窗口' : 'Close Window', async () => {
    // Trigger window close request (will go through hide-to-tray logic)
    await emit('window-close-requested', { target_window: getCurrentWindow().label });
  });
  addItem(zh ? '退出应用' : 'Quit Application', async () => {
    await requestQuitWithConfirm();
  });

  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(6, rect.left)}px`;
  menu.style.top = `${rect.bottom + 6}px`;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const menuRect = menu.getBoundingClientRect();
  if (menuRect.right > viewportWidth - 6) {
    menu.style.left = `${Math.max(6, viewportWidth - menuRect.width - 6)}px`;
  }
  if (menuRect.bottom > viewportHeight - 6) {
    menu.style.top = `${Math.max(6, rect.top - menuRect.height - 6)}px`;
  }

  const onPointerDown = (event: MouseEvent): void => {
    const target = event.target as Node | null;
    if (!target) return;
    if (menu.contains(target) || anchor.contains(target)) return;
    cleanup();
  };

  const cleanup = (): void => {
    menu.remove();
    document.removeEventListener('mousedown', onPointerDown, true);
    window.removeEventListener('blur', cleanup);
  };

  window.addEventListener('blur', cleanup);
  requestAnimationFrame(() => {
    document.addEventListener('mousedown', onPointerDown, true);
  });
}

// SVG icons for Windows title-bar window controls
const WIN_ICON_MINIMIZE = '<svg width="10" height="1" viewBox="0 0 10 1" aria-hidden="true"><rect width="10" height="1" fill="currentColor"/></svg>';
const WIN_ICON_MAXIMIZE = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.6" y="0.6" width="8.8" height="8.8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
const WIN_ICON_RESTORE  = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="2.6" y="0.6" width="6.8" height="6.8" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M0.6 2.6v6.8h6.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const WIN_ICON_CLOSE    = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1 9 9M9 1 1 9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

// Remote session list popup state
let remoteListAutoRefreshTimer: ReturnType<typeof setInterval> | null = null;

function hasRemoteTabs(): boolean {
  for (const tab of TabManager.tabs) {
    const leaves = getAllLeaves(tab.splitRoot);
    if (leaves.some((l) => TerminalRegistry.get(l.sessionId)?.isRemote)) return true;
  }
  return false;
}

function getUniqueRemoteServers(): RemoteServerInfo[] {
  const seen = new Set<string>();
  const servers: RemoteServerInfo[] = [];
  for (const [, info] of remoteInfoMap) {
    const key = `${info.host}:${info.port}`;
    if (!seen.has(key)) {
      seen.add(key);
      servers.push(info);
    }
  }
  return servers;
}

function showRemoteSessionListPopup(anchor: HTMLElement): void {
  const existing = document.querySelector('.remote-list-popup');
  if (existing) { existing.remove(); cleanupRemoteListPopup(); return; }

  const popup = document.createElement('div');
  popup.className = 'remote-list-popup';

  const header = document.createElement('div');
  header.className = 'remote-list-popup-header';
  header.innerHTML = `<span class="remote-list-popup-title">${t('remoteSessionList')}</span>`;

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'remote-list-refresh-btn';
  refreshBtn.type = 'button';
  refreshBtn.title = t('remoteSessionRefresh');
  refreshBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>';
  refreshBtn.onclick = () => { void loadRemoteSessions(); };
  header.appendChild(refreshBtn);
  popup.appendChild(header);

  const content = document.createElement('div');
  content.className = 'remote-list-popup-content';
  popup.appendChild(content);

  async function loadRemoteSessions(): Promise<void> {
    const servers = getUniqueRemoteServers();
    if (servers.length === 0) {
      content.innerHTML = `<div class="remote-list-empty">${t('remoteSessionNoRemote')}</div>`;
      return;
    }
    content.innerHTML = '<div class="remote-list-loading">...</div>';
    // Build set of locally opened session IDs for "opened" indicator
    const openedSessionIds = new Set<string>(remoteInfoMap.keys());
    const fragments: string[] = [];
    // Store server info in a map keyed by index to avoid exposing token in DOM
    const serverInfoMap = new Map<string, RemoteServerInfo>();
    let seqNum = 0;
    for (const info of servers) {
      const serverIdx = String(servers.indexOf(info));
      try {
        const sessions = await fetchRemoteSessions(info);
        const serverLabel = escapeHtml(info.name || `${info.host}:${info.port}`);
        fragments.push(`<div class="remote-list-server-label">${t('remoteSessionServer')}: ${serverLabel}</div>`);
        if (sessions.length === 0) {
          fragments.push(`<div class="remote-list-empty-server">${t('remoteNoSessions')}</div>`);
        } else {
          for (const s of sessions) {
            seqNum++;
            const stateClass = s.state === 'running' ? 'running' : 'other';
            const isOpened = openedSessionIds.has(s.id);
            const tabNum = remoteTabNumbers.get(s.id);
            const openedBadge = isOpened
              ? `<span class="remote-list-opened-badge" title="${t('remoteSessionOpened') || 'Opened'}">#${tabNum ?? '?'}</span>`
              : '';
            serverInfoMap.set(`${serverIdx}:${s.id}`, info);
            const label = s.title || s.id.slice(0, 12);
            const privateCls = s.private ? ' remote-list-item-private' : '';
            const lockIcon = s.private ? `<span class="remote-list-lock"><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg></span>` : '';
            fragments.push(`<div class="remote-list-item ${isOpened ? 'opened' : ''}${privateCls}" data-server-idx="${escapeHtml(serverIdx)}" data-sid="${escapeHtml(s.id)}" data-private="${s.private ? '1' : ''}"><span class="remote-list-item-num">${seqNum}</span>${lockIcon}<span class="remote-list-item-id" title="${escapeHtml(label)}">${escapeHtml(label)}</span>${openedBadge}<span class="remote-list-item-meta">${escapeHtml(s.executor_type || 'local')} · <span class="remote-list-state-${stateClass}">${escapeHtml(s.state)}</span></span></div>`);
          }
        }
      } catch (err) {
        const serverLabel = escapeHtml(info.name || `${info.host}:${info.port}`);
        fragments.push(`<div class="remote-list-server-label">${serverLabel}</div><div class="remote-list-error">${escapeHtml(String(err))}</div>`);
      }
    }
    content.innerHTML = fragments.join('');
    // Attach click handlers for session items
    content.querySelectorAll('.remote-list-item').forEach((el) => {
      (el as HTMLElement).onclick = async () => {
        const ds = (el as HTMLElement).dataset;
        if (ds.private === '1') {
          await message(t('sessionPrivateCannotConnect'), { kind: 'warning' });
          return;
        }
        const sessionId = ds.sid!;
        const serverIdx = ds.serverIdx!;
        const info = serverInfoMap.get(`${serverIdx}:${sessionId}`);
        if (!info) return;
        document.dispatchEvent(new CustomEvent('remote-session-selected', { detail: { info, sessionId } }));
        popup.remove();
        cleanupRemoteListPopup();
      };
    });
  }

  // Position popup below anchor
  const rect = anchor.getBoundingClientRect();
  popup.style.top = `${rect.bottom + 4}px`;
  popup.style.right = `${window.innerWidth - rect.right}px`;
  document.body.appendChild(popup);

  // Initial load
  void loadRemoteSessions();

  // Auto refresh every 5s
  remoteListAutoRefreshTimer = setInterval(() => {
    if (document.querySelector('.remote-list-popup')) {
      void loadRemoteSessions();
    } else {
      cleanupRemoteListPopup();
    }
  }, 5000);

  // Close on outside click
  const onPointerDown = (e: MouseEvent): void => {
    const target = e.target as Node;
    if (!popup.contains(target) && !anchor.contains(target)) {
      popup.remove();
      cleanupRemoteListPopup();
      document.removeEventListener('mousedown', onPointerDown, true);
    }
  };
  requestAnimationFrame(() => {
    document.addEventListener('mousedown', onPointerDown, true);
  });
}

function cleanupRemoteListPopup(): void {
  if (remoteListAutoRefreshTimer) {
    clearInterval(remoteListAutoRefreshTimer);
    remoteListAutoRefreshTimer = null;
  }
}

function renderToolbarActions(): void {
  toolbarLeftEl.innerHTML = '';
  toolbarRightEl.innerHTML = '';

  // On Windows: show app icon as the leftmost element in the toolbar.
  // Clicking it opens the app menu (same as the ≡ button).
  if (isWindowsPlatform) {
    const appIconBtn = document.createElement('button');
    appIconBtn.className = 'toolbar-app-icon-btn';
    appIconBtn.type = 'button';
    appIconBtn.title = settings?.language === 'zh' ? '应用菜单' : 'App Menu';
    appIconBtn.innerHTML = `<img class="toolbar-app-icon-img" src="${appIconUrl}" alt="App" />`;
    appIconBtn.onclick = (event) => {
      event.stopPropagation();
      showWindowsToolbarMenu(appIconBtn);
    };
    toolbarLeftEl.appendChild(appIconBtn);
  }

  const homeBtn = document.createElement('button');
  homeBtn.className = `toolbar-action-btn ${isHomeView ? 'active' : ''}`;
  homeBtn.type = 'button';
  homeBtn.title = t('contextMenuHome');
  homeBtn.innerHTML = `<span class="tab-icon">${icon('home')}</span>`;
  homeBtn.onclick = () => {
    showHomeView();
    renderTabs();
  };
  toolbarLeftEl.appendChild(homeBtn);

  const galleryBtn = document.createElement('button');
  galleryBtn.className = `toolbar-action-btn ${isGalleryView ? 'active' : ''}`;
  galleryBtn.type = 'button';
  galleryBtn.title = t('sessionsGallery');
  galleryBtn.innerHTML = `<span class="tab-icon">${icon('gallery')}</span>`;
  galleryBtn.onclick = () => {
    showGalleryView();
    renderTabs();
  };
  toolbarLeftEl.appendChild(galleryBtn);

  const newBtn = document.createElement('button');
  newBtn.className = 'toolbar-action-btn';
  newBtn.type = 'button';
  newBtn.title = t('newTerminal');
  newBtn.innerHTML = `<span class="tab-icon">${icon('plus')}</span>`;
  newBtn.onclick = async () => {
    await createNewSession();
  };
  newBtn.addEventListener('contextmenu', (e) => {
    showShellContextMenu(e, newBtn);
  });
  toolbarLeftEl.appendChild(newBtn);

  // Remote session list button — only visible when remote tabs exist
  if (hasRemoteTabs()) {
    const remoteListBtn = document.createElement('button');
    remoteListBtn.className = 'toolbar-icon-btn remote-list-btn';
    remoteListBtn.type = 'button';
    remoteListBtn.title = t('remoteSessionList');
    remoteListBtn.innerHTML = `<span class="tab-icon">${icon('remoteList')}</span>`;
    remoteListBtn.onclick = () => showRemoteSessionListPopup(remoteListBtn);
    toolbarRightEl.appendChild(remoteListBtn);
  }

  const shareBtn = document.createElement('button');
  shareBtn.className = 'toolbar-icon-btn';
  shareBtn.type = 'button';
  shareBtn.title = t('shareLink');
  shareBtn.innerHTML = `<span class="tab-icon">${icon('share')}</span>`;
  shareBtn.onclick = () => openSettings('sharing');
  toolbarRightEl.appendChild(shareBtn);

  // Update available icon (shown only when update is pending and user hasn't hidden it)
  if (pendingUpdateVersion && !localStorage.getItem('meterm-hide-update-icon')) {
    const updateBtn = document.createElement('button');
    updateBtn.className = 'toolbar-icon-btn toolbar-update-btn';
    updateBtn.type = 'button';
    updateBtn.title = t('updateAvailable').replace('{version}', pendingUpdateVersion);
    updateBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v10m0 0 3.5-3.5M12 12l-3.5-3.5"/><path d="M4.93 15A8 8 0 1 0 12 4"/></svg>`;
    updateBtn.onclick = () => { void openUpdaterWindow(); };
    toolbarRightEl.appendChild(updateBtn);
  }

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'toolbar-icon-btn';
  settingsBtn.type = 'button';
  settingsBtn.title = t('settings');
  settingsBtn.innerHTML = `<span class="tab-icon">${icon('settings')}</span>`;
  settingsBtn.onclick = () => openSettings();
  toolbarRightEl.appendChild(settingsBtn);

  if (isWindowsPlatform) {
    // Visual separator between app buttons and OS window controls
    const sep = document.createElement('div');
    sep.className = 'win-controls-separator';
    toolbarRightEl.appendChild(sep);

    // Minimize
    const minBtn = document.createElement('button');
    minBtn.className = 'win-control-btn win-minimize-btn';
    minBtn.type = 'button';
    minBtn.title = settings?.language === 'zh' ? '最小化' : 'Minimize';
    minBtn.innerHTML = WIN_ICON_MINIMIZE;
    minBtn.onclick = () => { void getCurrentWindow().minimize(); };
    toolbarRightEl.appendChild(minBtn);

    // Maximize / Restore — icon is updated by the resize listener
    const maxBtn = document.createElement('button');
    maxBtn.className = 'win-control-btn win-maximize-btn';
    maxBtn.type = 'button';
    maxBtn.innerHTML = WIN_ICON_MAXIMIZE;
    maxBtn.onclick = async () => {
      const isMax = await getCurrentWindow().isMaximized();
      if (isMax) {
        void getCurrentWindow().unmaximize();
      } else {
        void getCurrentWindow().maximize();
      }
    };
    toolbarRightEl.appendChild(maxBtn);
    // Sync icon to current maximize state immediately
    void getCurrentWindow().isMaximized().then((isMax) => {
      maxBtn.innerHTML = isMax ? WIN_ICON_RESTORE : WIN_ICON_MAXIMIZE;
      maxBtn.title = isMax
        ? (settings?.language === 'zh' ? '还原' : 'Restore')
        : (settings?.language === 'zh' ? '最大化' : 'Maximize');
    });

    // Close — goes through the existing confirmation-dialog flow
    const closeBtn = document.createElement('button');
    closeBtn.className = 'win-control-btn win-close-btn';
    closeBtn.type = 'button';
    closeBtn.title = settings?.language === 'zh' ? '关闭' : 'Close';
    closeBtn.innerHTML = WIN_ICON_CLOSE;
    closeBtn.onclick = () => { void getCurrentWindow().close(); };
    toolbarRightEl.appendChild(closeBtn);
  }
}

function showTabContextMenu(event: MouseEvent, tab: Tab, tabIndex: number): void {
  event.preventDefault();
  event.stopPropagation();

  const existing = document.getElementById('custom-context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.id = 'custom-context-menu';
  menu.className = 'custom-context-menu';
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  const totalTabs = TabManager.tabs.length;

  const addItem = (label: string, onClick: () => void, disabled = false) => {
    const item = document.createElement('button');
    item.className = 'custom-context-menu-item';
    item.type = 'button';
    item.textContent = label;
    item.disabled = disabled;
    item.onclick = () => {
      menu.remove();
      onClick();
    };
    menu.appendChild(item);
  };

  const addDivider = () => {
    menu.appendChild(document.createElement('div')).className = 'custom-context-menu-divider';
  };

  const closeTab = async (tabId: string) => {
    const closingTab = TabManager.tabs.find((t) => t.id === tabId);
    if (closingTab) {
      const closingLeaves = getAllLeaves(closingTab.splitRoot);
      for (const leaf of closingLeaves) {
        DrawerManager.destroy(leaf.sessionId);
        AICapsuleManager.destroy(leaf.sessionId);
        sshConfigMap.delete(leaf.sessionId);
        remoteInfoMap.delete(leaf.sessionId);
        remoteTabNumbers.delete(leaf.sessionId);
        viewerModeSessionIds.delete(leaf.sessionId);
        reclaimSessionIds.delete(leaf.sessionId);
        privateSessionIds.delete(leaf.sessionId);
        sessionProgressMap.delete(leaf.sessionId);
        removeKickedOverlay(leaf.sessionId);
        removeReconnectOverlay(leaf.sessionId);
      }
    }
    await TabManager.closeTab(tabId);
  };

  addItem(t('tabMenuCloseTab'), () => {
    void closeTab(tab.id).then(async () => {
      if (TabManager.activeTabId) {
        await activateTab(TabManager.activeTabId);
        const newActiveTab = TabManager.tabs.find(t => t.id === TabManager.activeTabId);
        if (newActiveTab) {
          const activeSessionId = TabManager.getActiveSessionId();
          const sshCfg = activeSessionId ? sshConfigMap.get(activeSessionId) : undefined;
          StatusBar.setConnection(newActiveTab.status, sshCfg ? `${sshCfg.username}@${sshCfg.host}` : 'Local');
        }
      } else {
        showHomeView();
      }
      renderTabs();
    });
  });

  addItem(t('tabMenuCloseOthers'), () => {
    const others = TabManager.tabs.filter((t) => t.id !== tab.id).map((t) => t.id);
    void (async () => {
      for (const id of others) await closeTab(id);
      TabManager.activate(tab.id);
      await activateTab(tab.id);
      renderTabs();
    })();
  }, totalTabs <= 1);

  addItem(t('tabMenuCloseLeft'), () => {
    const leftIds = TabManager.tabs.slice(0, tabIndex).map((t) => t.id);
    void (async () => {
      for (const id of leftIds) await closeTab(id);
      TabManager.activate(tab.id);
      await activateTab(tab.id);
      renderTabs();
    })();
  }, tabIndex === 0);

  addItem(t('tabMenuCloseRight'), () => {
    const rightIds = TabManager.tabs.slice(tabIndex + 1).map((t) => t.id);
    void (async () => {
      for (const id of rightIds) await closeTab(id);
      TabManager.activate(tab.id);
      await activateTab(tab.id);
      renderTabs();
    })();
  }, tabIndex === totalTabs - 1);

  addDivider();

  addItem(t('tabMenuCloseAll'), () => {
    void closeAllSessions();
  });

  addDivider();

  addItem(t('tabMenuCopyTitle'), () => {
    void clipboardWriteText(tab.title);
  });

  addItem(t('tabMenuCloneTab'), () => {
    // Check if any session in the tab is SSH
    const cloneLeaves = getAllLeaves(tab.splitRoot);
    let sshConfig: SSHConnectionConfig | undefined;
    for (const leaf of cloneLeaves) {
      const cfg = sshConfigMap.get(leaf.sessionId);
      if (cfg) { sshConfig = cfg; break; }
    }
    if (sshConfig) {
      document.dispatchEvent(new CustomEvent('ssh-clone-session', { detail: sshConfig }));
    } else {
      void createNewSession();
    }
  });

  // Lock/Unlock session (for local and SSH sessions, not remote viewer)
  const tabLeaves = getAllLeaves(tab.splitRoot);
  const isOwnedTab = tabLeaves.every((l) => !viewerModeSessionIds.has(l.sessionId) && !remoteInfoMap.has(l.sessionId));
  if (isOwnedTab) {
    const activeLeaf = tabLeaves[0];
    if (activeLeaf) {
      const isPrivate = privateSessionIds.has(activeLeaf.sessionId);
      addItem(isPrivate ? t('tabMenuUnlockSession') : t('tabMenuLockSession'), () => {
        const newPrivate = !isPrivate;
        void (async () => {
          if (newPrivate) {
            const confirmed = await confirm(t('lockSessionConfirm'), {
              title: t('tabMenuLockSession'),
              kind: 'warning',
              okLabel: t('tabMenuLockSession'),
              cancelLabel: t('hideToTrayTipCancel'),
            });
            if (!confirmed) return;
          }
          try {
            await invoke('set_session_private', { sessionId: activeLeaf.sessionId, private: newPrivate });
            if (newPrivate) {
              privateSessionIds.add(activeLeaf.sessionId);
            } else {
              privateSessionIds.delete(activeLeaf.sessionId);
            }
            syncLockIconForActiveTab();
            renderTabs();
          } catch (err) {
            console.error('set_session_private failed:', err);
          }
        })();
      });
    }
  }

  addDivider();

  const splitDisabled = countLeaves(tab.splitRoot) >= 4;
  addItem(t('splitHorizontal'), () => {
    void (async () => {
      TabManager.activate(tab.id);
      await doSplitPane(tab.id, tab.focusedPaneId, 'horizontal');
      await activateTab(tab.id);
      renderTabs();
    })();
  }, splitDisabled);

  addItem(t('splitVertical'), () => {
    void (async () => {
      TabManager.activate(tab.id);
      await doSplitPane(tab.id, tab.focusedPaneId, 'vertical');
      await activateTab(tab.id);
      renderTabs();
    })();
  }, splitDisabled);

  document.body.appendChild(menu);

  // Boundary detection
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  if (rect.right > viewportWidth) {
    menu.style.left = `${Math.max(6, viewportWidth - rect.width - 6)}px`;
  }
  if (rect.bottom > viewportHeight) {
    menu.style.top = `${Math.max(6, viewportHeight - rect.height - 6)}px`;
  }

  const cleanup = () => {
    menu.remove();
    document.removeEventListener('click', cleanup, true);
    window.removeEventListener('blur', cleanup);
  };
  document.addEventListener('click', cleanup, true);
  window.addEventListener('blur', cleanup);
}

// ── Shell selection context menu ──

interface ShellInfo {
  path: string;
  name: string;
  is_default: boolean;
}

let cachedShells: ShellInfo[] | null = null;

async function getAvailableShells(): Promise<ShellInfo[]> {
  if (cachedShells) return cachedShells;
  try {
    cachedShells = await invoke<ShellInfo[]>('list_available_shells');
  } catch {
    cachedShells = [];
  }
  return cachedShells;
}

function showShellContextMenu(event: MouseEvent, anchor?: HTMLElement): void {
  event.preventDefault();
  event.stopPropagation();

  const existing = document.getElementById('shell-context-menu');
  if (existing) { existing.remove(); return; }

  const menu = document.createElement('div');
  menu.id = 'shell-context-menu';
  menu.className = 'custom-context-menu';

  // Position near anchor or mouse
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 4}px`;
  } else {
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
  }

  const cleanup = () => {
    menu.remove();
    document.removeEventListener('click', onClickOutside, true);
    window.removeEventListener('blur', cleanup);
  };
  const onClickOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) cleanup();
  };

  // Loading placeholder
  const loading = document.createElement('div');
  loading.className = 'custom-context-menu-item';
  loading.textContent = '...';
  loading.style.opacity = '0.5';
  menu.appendChild(loading);

  document.body.appendChild(menu);

  // Ensure menu doesn't go off-screen
  requestAnimationFrame(() => {
    const mr = menu.getBoundingClientRect();
    if (mr.right > window.innerWidth) menu.style.left = `${window.innerWidth - mr.width - 8}px`;
    if (mr.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - mr.height - 8}px`;
  });

  setTimeout(() => {
    document.addEventListener('click', onClickOutside, true);
    window.addEventListener('blur', cleanup);
  }, 0);

  // Load shells and populate
  void getAvailableShells().then((shells) => {
    menu.innerHTML = '';
    if (shells.length === 0) {
      const item = document.createElement('div');
      item.className = 'custom-context-menu-item';
      item.textContent = t('noShellsFound');
      item.style.opacity = '0.5';
      menu.appendChild(item);
      return;
    }

    // Determine effective default: user setting overrides system default
    const userDefault = settings.defaultShell;
    const isDefault = (s: ShellInfo) => userDefault ? s.path === userDefault : s.is_default;
    const defaultShells = shells.filter(isDefault);
    const otherShells = shells.filter((s) => !isDefault(s));

    const addShellItem = (shell: ShellInfo, showBadge: boolean) => {
      const item = document.createElement('button');
      item.className = 'custom-context-menu-item';
      item.type = 'button';
      item.textContent = shell.name;
      if (showBadge) {
        const badge = document.createElement('span');
        badge.className = 'shell-default-badge';
        badge.textContent = t('defaultShell');
        item.appendChild(badge);
      }
      item.onclick = () => {
        cleanup();
        void createNewSession(shell.path);
      };
      menu.appendChild(item);
    };

    for (const shell of defaultShells) addShellItem(shell, true);
    if (defaultShells.length > 0 && otherShells.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'custom-context-menu-divider';
      menu.appendChild(sep);
    }
    for (const shell of otherShells) addShellItem(shell, false);

    // Re-check position after content loaded
    requestAnimationFrame(() => {
      const mr = menu.getBoundingClientRect();
      if (mr.right > window.innerWidth) menu.style.left = `${window.innerWidth - mr.width - 8}px`;
      if (mr.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - mr.height - 8}px`;
    });
  });
}

function showCustomContextMenu(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  // Allow native context menu for input fields (copy/paste/cut/select all)
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return;
  }
  // Let AI chat panel handle its own context menu (suppress system menu but don't show terminal menu)
  if (target?.closest('.ai-chat-messages')) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  // Only show terminal context menu when right-clicking inside the terminal area
  // (.xterm or .terminal-container), not on AI bar, drawers, home, toolbars, etc.
  const inTerminal = target?.closest('.xterm') || target?.closest('.terminal-container');
  if (!inTerminal) {
    return;
  }
  const existing = document.getElementById('custom-context-menu');
  if (existing) {
    existing.remove();
  }

  const menu = document.createElement('div');
  menu.id = 'custom-context-menu';
  menu.className = 'custom-context-menu';
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  const addItem = (label: string, onClick: () => void, disabled = false) => {
    const item = document.createElement('button');
    item.className = 'custom-context-menu-item';
    item.type = 'button';
    item.textContent = label;
    item.disabled = disabled;
    item.onclick = () => {
      menu.remove();
      onClick();
    };
    menu.appendChild(item);
  };

  addItem(t('contextMenuNewTerminal'), () => {
    void createNewSession();
  });
  addItem(t('contextMenuHome'), () => {
    showHomeView();
    renderTabs();
  });
  addItem(t('contextMenuSettings'), () => {
    openSettings();
  });
  addItem(t('contextMenuCloseSession'), () => {
    if (TabManager.activeTabId) {
      const activeTab = TabManager.getActiveTab();
      if (activeTab) {
        const closingLeaves = getAllLeaves(activeTab.splitRoot);
        for (const leaf of closingLeaves) {
          DrawerManager.destroy(leaf.sessionId);
          AICapsuleManager.destroy(leaf.sessionId);
          sshConfigMap.delete(leaf.sessionId);
          remoteInfoMap.delete(leaf.sessionId);
          remoteTabNumbers.delete(leaf.sessionId);
          viewerModeSessionIds.delete(leaf.sessionId);
          reclaimSessionIds.delete(leaf.sessionId);
          sessionProgressMap.delete(leaf.sessionId);
          removeKickedOverlay(leaf.sessionId);
          removeReconnectOverlay(leaf.sessionId);
        }
      }
      void TabManager.closeTab(TabManager.activeTabId).then(async () => {
        if (TabManager.activeTabId) {
          await activateTab(TabManager.activeTabId);
          const newActiveTab = TabManager.tabs.find(t => t.id === TabManager.activeTabId);
          if (newActiveTab) {
            const activeSessionId = TabManager.getActiveSessionId();
            const sshCfg = activeSessionId ? sshConfigMap.get(activeSessionId) : undefined;
            StatusBar.setConnection(newActiveTab.status, sshCfg ? `${sshCfg.username}@${sshCfg.host}` : 'Local');
          }
        } else {
          showHomeView();
        }
        renderTabs();
      });
    }
  }, !TabManager.activeTabId);

  menu.appendChild(document.createElement('div')).className = 'custom-context-menu-divider';

  const hasSelection = !!getSelection();
  addItem(t('contextMenuCopy'), () => {
    performCopy();
  }, !hasSelection);
  addItem(t('contextMenuPaste'), () => {
    performPaste();
  });

  // Split pane items
  const activeTabForCtx = TabManager.getActiveTab();
  if (activeTabForCtx) {
    menu.appendChild(document.createElement('div')).className = 'custom-context-menu-divider';
    const splitCtxDisabled = countLeaves(activeTabForCtx.splitRoot) >= 4;
    addItem(t('splitHorizontal'), () => {
      void (async () => {
        await doSplitPane(activeTabForCtx.id, activeTabForCtx.focusedPaneId, 'horizontal');
        await activateTab(activeTabForCtx.id);
        renderTabs();
      })();
    }, splitCtxDisabled);
    addItem(t('splitVertical'), () => {
      void (async () => {
        await doSplitPane(activeTabForCtx.id, activeTabForCtx.focusedPaneId, 'vertical');
        await activateTab(activeTabForCtx.id);
        renderTabs();
      })();
    }, splitCtxDisabled);

    if (countLeaves(activeTabForCtx.splitRoot) > 1) {
      addItem(t('closePane'), () => {
        const closingLeaf = findLeafById(activeTabForCtx.splitRoot, activeTabForCtx.focusedPaneId);
        if (closingLeaf) {
          DrawerManager.destroy(closingLeaf.sessionId);
          AICapsuleManager.destroy(closingLeaf.sessionId);
          sshConfigMap.delete(closingLeaf.sessionId);
          remoteInfoMap.delete(closingLeaf.sessionId);
          remoteTabNumbers.delete(closingLeaf.sessionId);
          viewerModeSessionIds.delete(closingLeaf.sessionId);
          reclaimSessionIds.delete(closingLeaf.sessionId);
          { const pr = pendingMasterRequests.get(closingLeaf.sessionId); if (pr) { clearTimeout(pr.timerId); pendingMasterRequests.delete(closingLeaf.sessionId); } }
          sessionProgressMap.delete(closingLeaf.sessionId);
          removeKickedOverlay(closingLeaf.sessionId);
          removeReconnectOverlay(closingLeaf.sessionId);
        }
        void TabManager.closePane(activeTabForCtx.id, activeTabForCtx.focusedPaneId).then(async () => {
          if (TabManager.activeTabId) {
            await activateTab(TabManager.activeTabId);
          }
          renderTabs();
        });
      });
    }
  }

  document.body.appendChild(menu);

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  if (rect.right > viewportWidth) {
    menu.style.left = `${Math.max(6, viewportWidth - rect.width - 6)}px`;
  }
  if (rect.bottom > viewportHeight) {
    menu.style.top = `${Math.max(6, viewportHeight - rect.height - 6)}px`;
  }

  const cleanup = () => {
    menu.remove();
    document.removeEventListener('click', cleanup, true);
    window.removeEventListener('blur', cleanup);
  };
  document.addEventListener('click', cleanup, true);
  window.addEventListener('blur', cleanup);
}

function setupToolbarDrag(): void {
  const dragLayer = document.getElementById('window-toolbar-drag-layer');
  if (!dragLayer) return;
  dragLayer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow().startDragging();
  });
}

async function confirmSystem(messageText: string): Promise<boolean> {
  try {
    return await confirm(messageText, { title: t('appName'), kind: 'warning' });
  } catch {
    return window.confirm(messageText);
  }
}

async function showInfoSystem(messageText: string, titleText: string): Promise<void> {
  try {
    await message(messageText, { title: titleText, kind: 'info' });
  } catch {
    window.alert(`${titleText}\n\n${messageText}`);
  }
}

async function ensureMeTermReady(): Promise<boolean> {
  if (metermReady && port > 0 && authToken) {
    return true;
  }
  StatusBar.setConnection('connecting', 'Starting...');
  try {
    const info = await waitForMeTerm(40, 300);
    port = info.port;
    authToken = info.token;
    metermReady = true;
    StatusBar.setConnection('connected', 'Local');
    startPairPoller(port, authToken);
    return true;
  } catch (err) {
    metermReady = false;
    StatusBar.setError(`Failed to start meterm: ${String(err)}`);
    return false;
  }
}

function getSelection(): string {
  // In split mode, get selection from focused terminal
  const focusedSessionId = TabManager.getActiveSessionId();
  if (focusedSessionId) {
    const sel = TerminalRegistry.getSessionSelection(focusedSessionId);
    if (sel) return sel;
  }
  return TerminalRegistry.getActiveSelection() || window.getSelection()?.toString() || '';
}

function performCopy(): void {
  const selection = getSelection();
  if (selection) {
    void clipboardWriteText(selection);
  }
}

function performPaste(): void {
  void clipboardReadText().then((text) => {
    if (!text) return;
    const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
      const start = active.selectionStart ?? active.value.length;
      const end = active.selectionEnd ?? active.value.length;
      const nextValue = active.value.slice(0, start) + text + active.value.slice(end);
      active.value = nextValue;
      active.selectionStart = start + text.length;
      active.selectionEnd = start + text.length;
      active.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const focusedSessionId = TabManager.getActiveSessionId();
    if (focusedSessionId) {
      TerminalRegistry.pasteToSession(focusedSessionId, text);
    } else if (TabManager.activeTabId) {
      TerminalRegistry.pasteToActive(text);
    }
  });
}

function performSelectAll(): void {
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    active.select();
    return;
  }
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(document.body);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function closeAllSessions(): Promise<void> {
  // Destroy drawers/AI for all sessions across all tabs
  for (const tab of TabManager.tabs) {
    const leaves = getAllLeaves(tab.splitRoot);
    for (const leaf of leaves) {
      DrawerManager.destroy(leaf.sessionId);
      AICapsuleManager.destroy(leaf.sessionId);
      sshConfigMap.delete(leaf.sessionId);
      remoteInfoMap.delete(leaf.sessionId);
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
  renderTabs();
  renderToolbarActions();
}

async function showHideToTrayDialog(): Promise<'hide' | 'close'> {
  try {
    const shouldHide = await confirm(t('hideToTrayTipBody'), { title: t('hideToTrayTipTitle'), kind: 'info', okLabel: t('hideToTrayTipHideNow'), cancelLabel: t('hideToTrayTipCancel') });
    if (shouldHide) {
      // Ask if user wants to remember this choice
      const shouldRemember = await confirm(t('hideToTrayTipRemember'), { title: t('hideToTrayTipTitle'), kind: 'info', okLabel: t('hideToTrayTipDontShow'), cancelLabel: t('hideToTrayTipCancel') });
      if (shouldRemember) {
        localStorage.setItem('meterm-hide-to-tray-pref', 'always_hide');
      }
      return 'hide';
    }
    return 'close';
  } catch {
    // Fallback if native dialog fails
    return window.confirm(t('hideToTrayTipBody')) ? 'hide' : 'close';
  }
}

async function requestQuitWithConfirm(): Promise<void> {
  if (isQuitFlowRunning) {
    return;
  }
  isQuitFlowRunning = true;
  try {
    if (TabManager.tabs.length > 0) {
      const confirmed = await confirmSystem(t('confirmQuitWithSessions'));
      if (!confirmed) {
        return;
      }
      await closeAllSessions();
    }
    await invoke('request_app_quit');
  } finally {
    isQuitFlowRunning = false;
  }
}

async function syncTrayLanguage(): Promise<void> {
  try {
    await invoke('set_tray_language', { language: settings.language });
  } catch {
  }
}

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

  initLanguage();
  settings = loadSettings();
  setLanguage(settings.language);
  const currentWindow = getCurrentWindow();
  const currentWindowLabel = currentWindow.label;
  // Fire-and-forget: tray language sync must NOT block init,
  // otherwise new windows never render their toolbar.
  void syncTrayLanguage();

  // Fire-and-forget: migrate plaintext credentials from localStorage to OS keychain
  void migrateSSHCredentials();
  void migrateRemoteCredentials();
  TerminalRegistry.setSettings(settings);
  setHomeViewSettings(settings);
  setGalleryViewSettings(settings);
  setGalleryProgressGetter((id) => sessionProgressMap.get(id));
  applyWindowOpacity(settings.opacity);
  applyAiBarOpacity(settings.aiBarOpacity);
  applyColorScheme(settings);
  applyBackgroundImage(settings);

  if (settings.rememberWindowSize && settings.windowWidth > 0 && settings.windowHeight > 0) {
    // Windows-only guard: dynamically created secondary windows can stall on
    // setSize during early init, causing a blank/non-interactive window.
    // Keep restore-size behavior for main window on Windows, and unchanged on
    // macOS/Linux to avoid behavior regressions there.
    if (!isWindowsPlatform || currentWindowLabel === 'main') {
      await currentWindow.setSize(new LogicalSize(settings.windowWidth, settings.windowHeight));
    }
  }

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

  // SSH connect handler
  async function handleSSHConnect(config: SSHConnectionConfig): Promise<void> {
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

      // Remove placeholder and activate real terminal
      removeSSHConnectingPlaceholder();
      await activateTab(sshTabId);
      DrawerManager.updateServerInfo(sessionId, {
        host: config.host,
        username: config.username,
        port: config.port
      });
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
  setSSHConnectHandler(handleSSHConnect);

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

  // Shared remote connection handler
  async function handleRemoteConnect(info: RemoteServerInfo, sessionId: string): Promise<void> {
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
    remoteTabNumbers.set(sessionId, nextRemoteTabNumber++);
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

  // Remote session selected from session list popup
  document.addEventListener('remote-session-selected', ((e: CustomEvent<{ info: RemoteServerInfo; sessionId: string }>) => {
    const { info, sessionId } = e.detail;
    void handleRemoteConnect(info, sessionId);
  }) as EventListener);

  // Handle remote connection (user selected a specific session from dialog)
  setRemoteConnectHandler((info, sessionId) => { void handleRemoteConnect(info, sessionId); });

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

  // Listen for settings changes from the settings window
  void listen('settings-changed', () => {
    settings = loadSettings();
    setLanguage(settings.language);
    applyColorScheme(settings);
    setHomeViewSettings(settings);
    setGalleryViewSettings(settings);
    applyWindowOpacity(settings.opacity);
    applyAiBarOpacity(settings.aiBarOpacity);
    applyBackgroundImage(settings);
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

  function updateWindowAspectRatio(): void {
    const w = terminalPanelEl.clientWidth;
    const h = terminalPanelEl.clientHeight;
    if (w > 0 && h > 0) {
      document.documentElement.style.setProperty('--window-aspect-ratio', `${w} / ${h}`);
    }
  }

  showHomeView();
  renderTabs();
  renderToolbarActions();
  updateWindowAspectRatio();

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
  // renderToolbarActions() syncs the icon on render, but the user can also maximize via
  // double-clicking the drag region or the system task bar, so we listen for resize events.
  if (isWindowsPlatform) {
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
  toolbarTabsEl.addEventListener('wheel', (e) => {
    const scrollContainer = toolbarTabsEl.querySelector('.tab-scroll-container') as HTMLDivElement | null;
    if (!scrollContainer) return;
    if (scrollContainer.scrollWidth <= scrollContainer.clientWidth) return; // Not overflowing
    e.preventDefault();
    scrollContainer.scrollBy({ left: e.deltaY });
  }, { passive: false });

  document.addEventListener('keydown', async (event) => {
    const isMac = navigator.userAgent.includes('Mac');
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (!mod) {
      return;
    }

    // On Windows, skip app-level shortcuts when focus is inside the xterm terminal
    // to prevent conflicts with TUI keyboard shortcuts (e.g. Ctrl+W in vim/htop).
    // On macOS, the modifier is Cmd (metaKey) which xterm doesn't forward to the PTY,
    // so there is no conflict on macOS.
    if (!isMac) {
      const target = event.target as Element;
      const inTerminal =
        target.tagName === 'TEXTAREA' ||
        (typeof (target as HTMLElement).closest === 'function' &&
          (target as HTMLElement).closest('.xterm') !== null);
      if (inTerminal) return;
    }

    const key = event.key.toLowerCase();

    if (key === 't') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      await createNewSession();
      return;
    }

    if (key === 'w') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const activeTab = TabManager.getActiveTab();
      if (activeTab) {
        const leafCount = countLeaves(activeTab.splitRoot);
        if (leafCount > 1) {
          // Multi-pane: close focused pane only
          const closingLeaf = findLeafById(activeTab.splitRoot, activeTab.focusedPaneId);
          if (closingLeaf) {
            DrawerManager.destroy(closingLeaf.sessionId);
            AICapsuleManager.destroy(closingLeaf.sessionId);
            sshConfigMap.delete(closingLeaf.sessionId);
            sessionProgressMap.delete(closingLeaf.sessionId);
            removeKickedOverlay(closingLeaf.sessionId);
            removeReconnectOverlay(closingLeaf.sessionId);
          }
          await TabManager.closePane(activeTab.id, activeTab.focusedPaneId);
          if (TabManager.activeTabId) {
            await activateTab(TabManager.activeTabId);
          }
        } else {
          // Single pane: close the tab
          const closingLeaves = getAllLeaves(activeTab.splitRoot);
          for (const leaf of closingLeaves) {
            DrawerManager.destroy(leaf.sessionId);
            AICapsuleManager.destroy(leaf.sessionId);
            sshConfigMap.delete(leaf.sessionId);
            remoteInfoMap.delete(leaf.sessionId);
            remoteTabNumbers.delete(leaf.sessionId);
            viewerModeSessionIds.delete(leaf.sessionId);
            reclaimSessionIds.delete(leaf.sessionId);
            sessionProgressMap.delete(leaf.sessionId);
            removeKickedOverlay(leaf.sessionId);
            removeReconnectOverlay(leaf.sessionId);
          }
          await TabManager.closeTab(activeTab.id);
          if (TabManager.activeTabId) {
            await activateTab(TabManager.activeTabId);
            const newActiveTab = TabManager.tabs.find(t => t.id === TabManager.activeTabId);
            if (newActiveTab) {
              const activeSessionId = TabManager.getActiveSessionId();
              const sshCfg = activeSessionId ? sshConfigMap.get(activeSessionId) : undefined;
              StatusBar.setConnection(newActiveTab.status, sshCfg ? `${sshCfg.username}@${sshCfg.host}` : 'Local');
            }
          } else {
            showHomeView();
          }
        }
        renderTabs();
      }
      return;
    }

    if (key === 'k') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const focusedSessionId = TabManager.getActiveSessionId();
      if (focusedSessionId) {
        TerminalRegistry.clearSession(focusedSessionId);
      } else {
        TerminalRegistry.clearActive();
      }
      return;
    }

    if (key === ',') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      openSettings();
      return;
    }

    // Split pane shortcuts
    if (key === 'd' && !event.shiftKey) {
      // ⌘D: horizontal split
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const splitTab = TabManager.getActiveTab();
      if (splitTab && countLeaves(splitTab.splitRoot) < 4) {
        void (async () => {
          await doSplitPane(splitTab.id, splitTab.focusedPaneId, 'horizontal');
          await activateTab(splitTab.id);
          renderTabs();
        })();
      }
      return;
    }

    if (key === 'd' && event.shiftKey) {
      // ⌘⇧D: vertical split
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const splitTab = TabManager.getActiveTab();
      if (splitTab && countLeaves(splitTab.splitRoot) < 4) {
        void (async () => {
          await doSplitPane(splitTab.id, splitTab.focusedPaneId, 'vertical');
          await activateTab(splitTab.id);
          renderTabs();
        })();
      }
      return;
    }

    // ⌘⌥ Arrow keys: navigate between panes
    if (event.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const navTab = TabManager.getActiveTab();
      if (navTab && countLeaves(navTab.splitRoot) > 1) {
        const directionMap: Record<string, 'left' | 'right' | 'up' | 'down'> = {
          ArrowLeft: 'left',
          ArrowRight: 'right',
          ArrowUp: 'up',
          ArrowDown: 'down',
        };
        const adjacent = getAdjacentLeaf(navTab.splitRoot, navTab.focusedPaneId, directionMap[event.key]);
        if (adjacent) {
          SplitPaneManager.focusPane(adjacent.id);
        }
      }
      return;
    }
  }, true);

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

  document.addEventListener('session-select', async (e: Event) => {
    const customEvent = e as CustomEvent<string>;
    const sessionId = customEvent.detail;
    // Find the tab containing this session
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

  document.addEventListener('contextmenu', showCustomContextMenu);
  setupToolbarDrag();

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
      // Only show connected clients
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
    if (handledPairIds.has(pairId)) return; // Already handled by poller
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
      // Route through sync so home/gallery view guard is respected.
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

  // Helper to check if event is for this window
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
        // Show hide-to-tray dialog
        const choice = await showHideToTrayDialog();
        if (choice === 'hide') {
          await invoke('hide_main_window');
          return;
        }
        // choice === 'close': fall through to original close logic
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
      // Rollback tray checked state
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
    void showInfoSystem(t('aboutDialogBody'), t('aboutDialogTitle'));
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
    metermReady = false;
    authToken = '';
    port = 0;
    StatusBar.setConnection('connecting', 'Restarting...');

    // Try to auto-restart the backend before giving up and quitting.
    // This handles transient crashes (e.g. during first SSH connection).
    try {
      await invoke('restart_meterm');
      const info = await waitForMeTerm(20, 300); // up to 6 s
      port = info.port;
      authToken = info.token;
      metermReady = true;
      StatusBar.setConnection('connected', 'Local');
      startPairPoller(port, authToken);
      console.log('[meterm] backend restarted successfully');
      return;
    } catch (restartErr) {
      console.error('[meterm] backend restart failed:', restartErr);
    }

    // Restart failed — quit the app gracefully.
    StatusBar.setError('Backend failed to restart');
    await invoke('request_app_quit');
  });

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
      remoteTabNumbers.set(sess.sessionId, nextRemoteTabNumber++);
    }
  });

  // Signal that this window is ready to receive tab transfers
  await emit('window-ready', { label: getCurrentWindow().label });

  // Check for app updates in the background (8-second delay built in).
  // Only run in the main window to avoid duplicate update checks.
  if (currentWindowLabel === 'main') {
    // Re-render toolbar when update is found (to show the update icon).
    document.addEventListener('update-available', () => { renderToolbarActions(); });
    // Re-render toolbar when user changes the hide-icon preference from updater window.
    void listen('update-icon-pref-changed', () => { renderToolbarActions(); });
    void initUpdater();
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
