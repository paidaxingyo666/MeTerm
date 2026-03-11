/**
 * view-manager.ts — View mode management and tab activation
 *
 * Extracted from main.ts. Contains:
 * - setViewMode(), showHomeView(), hideHomeView()
 * - showGalleryView(), hideGalleryView()
 * - activateTab() — core tab activation
 * - syncLockIconForActiveTab()
 * - statusLabel()
 * - openSettings()
 * - getActiveSessionProgress()
 */

import { TabManager } from './tabs';
import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { AICapsuleManager } from './ai-capsule';
import { SplitPaneManager, getAllLeaves, findLeafById } from './split-pane';
import { createSSHHomeView, updateSSHHomeView } from './ssh';
import { createGalleryView, updateGalleryView, startGalleryRefresh, stopGalleryRefresh } from './gallery';
import { resolveThemeAttr } from './appearance';
import { windowBgColor } from './themes';
import { t } from './i18n';
import { StatusBar } from './status-bar';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
  showSSHConnectingPlaceholder, removeSSHConnectingPlaceholder,
  hideReclaimButton, hideViewerOverlayDom, hideMasterApprovalOverlay,
  syncViewerOverlayForActiveTab, syncReclaimOverlayForActiveTab, syncMasterApprovalForActiveTab,
  privateSessionIds,
} from './overlays';
import {
  settings,
  isHomeView, isGalleryView, setIsHomeView, setIsGalleryView,
  type ViewMode,
  sshConfigMap, sessionProgressMap,
  isWindowsPlatform,
} from './app-state';

// ── DOM elements (lazily cached) ──

let _terminalPanelEl: HTMLDivElement | null = null;

function getTerminalPanelEl(): HTMLDivElement {
  if (!_terminalPanelEl) {
    _terminalPanelEl = document.getElementById('terminal-panel') as HTMLDivElement;
  }
  return _terminalPanelEl;
}

// ── Late-bound callbacks (set from main.ts to avoid circular deps) ──

let _renderTabs: () => void = () => {};
let _renderToolbarActions: () => void = () => {};

export function setViewManagerCallbacks(cbs: {
  renderTabs: () => void;
  renderToolbarActions: () => void;
}): void {
  _renderTabs = cbs.renderTabs;
  _renderToolbarActions = cbs.renderToolbarActions;
}

// ── Exported functions ──

export function setViewMode(mode: ViewMode): void {
  setIsHomeView(mode === 'home');
  setIsGalleryView(mode === 'gallery');
}

export function getOrCreateTerminalArea(): HTMLElement {
  const terminalPanelEl = getTerminalPanelEl();
  let area = terminalPanelEl.querySelector(':scope > .terminal-area') as HTMLElement;
  if (!area) {
    area = document.createElement('div');
    area.className = 'terminal-area';
    terminalPanelEl.insertBefore(area, terminalPanelEl.firstChild);
  }
  return area;
}

export async function activateTab(tabId: string): Promise<void> {
  const terminalPanelEl = getTerminalPanelEl();
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
      _renderToolbarActions();
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
  _renderToolbarActions();
  StatusBar.setProgress(getActiveSessionProgress());
}

export function syncLockIconForActiveTab(): void {
  const activeSessionId = TabManager.getActiveSessionId();
  StatusBar.setLocked(activeSessionId ? privateSessionIds.has(activeSessionId) : false);
}

export function statusLabel(status: string): string {
  if (status === 'connecting') return t('connecting');
  if (status === 'connected') return t('connected');
  if (status === 'reconnecting') return t('reconnecting');
  if (status === 'ended') return t('ended');
  if (status === 'notfound') return t('sessionNotFound');
  return t('disconnected');
}

export function showHomeView(): void {
  const terminalPanelEl = getTerminalPanelEl();
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
  _renderToolbarActions();

  // Reset status bar when no active connection is displayed
  StatusBar.setConnection('disconnected');
  StatusBar.setLocked(false);
  StatusBar.setLatency(null);
  StatusBar.setProgress(null);
}

export function hideHomeView(): void {
  const homeView = document.getElementById('home-view');
  if (homeView) {
    homeView.remove();
  }
}

export function showGalleryView(): void {
  const terminalPanelEl = getTerminalPanelEl();
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
  _renderToolbarActions();
  StatusBar.setProgress(null);
}

export function hideGalleryView(): void {
  const galleryView = document.getElementById('gallery-view');
  if (galleryView) {
    galleryView.remove();
  }
  stopGalleryRefresh();
}

export async function openSettings(tab?: string): Promise<void> {
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

  const themeStr = resolveThemeAttr(settings.colorScheme);
  const nativeTheme = themeStr === 'light' ? 'light' as const : 'dark' as const;
  const bgColor = windowBgColor(settings.colorScheme, themeStr);
  const isMac = !isWindowsPlatform && navigator.userAgent.includes('Mac');
  const settingsWindow = new WebviewWindow('settings', {
    url: settingsUrl,
    title: t('settings'),
    width: 480,
    height: 580,
    resizable: false,
    center: true,
    visible: false,
    decorations: !isWindowsPlatform,
    transparent: false,
    theme: nativeTheme,
    backgroundColor: bgColor,
    ...(isMac ? { titleBarStyle: 'overlay' as const, hiddenTitle: true } : {}),
  });

  // Fallback: ensure window shows even if webview JS hasn't loaded yet
  settingsWindow.once('tauri://created', () => {
    setTimeout(() => { void settingsWindow.show().then(() => settingsWindow.setFocus()); }, 150);
  });
  settingsWindow.once('tauri://error', (e: unknown) => {
    console.error('Failed to create settings window:', e);
  });
}

export function getActiveSessionProgress(): { state: number; percent: number } | null {
  if (isHomeView || isGalleryView) return null;
  const sessionId = TabManager.getActiveSessionId();
  if (!sessionId) return null;
  return sessionProgressMap.get(sessionId) ?? null;
}
