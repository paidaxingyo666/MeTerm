/**
 * pip.ts — Picture-in-Picture mode for main windows
 *
 * Provides always-on-top mini terminal monitoring with CSS transform scaling.
 * The terminal pty dimensions (cols/rows) are frozen during PiP — only the
 * visual representation is scaled down.
 */

import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { LogicalSize, LogicalPosition } from '@tauri-apps/api/dpi';
import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { TabManager } from './tabs';
import { DrawerManager } from './drawer';
import { isJumpServerPanelOpen, closeJumpServerPanel } from './jumpserver-panel';
import { setIsPipMode, isHomeView, isGalleryView, isMacPlatform, settings } from './app-state';
import { activateTab } from './view-manager';
import { renderToolbarActions, getAlwaysOnTop } from './toolbar';
import { icon } from './icons';
import { TerminalRegistry } from './terminal';

// ── Constants ──

const PIP_GAP = 12;
const PIP_MARGIN = 20;

// ── State ──

interface BrowserWindowState {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PipState {
  originalWidth: number;
  originalHeight: number;
  originalX: number;
  originalY: number;
  /** Session IDs whose drawers were open before PiP (to restore on exit) */
  openDrawerSessionIds: string[];
  /** Saved JumpServer browser window geometry (null if not present) */
  browserWindowState: BrowserWindowState | null;
}

let pipState: PipState | null = null;

/** Tracks all PiP windows across the app — label → slot index */
const pipWindows = new Map<string, number>();

// ── Public API ──

export function isPipActive(): boolean {
  return pipState !== null;
}

export async function togglePip(): Promise<void> {
  if (isPipActive()) {
    await exitPip();
  } else {
    await enterPip();
  }
}

export async function enterPip(): Promise<void> {
  if (pipState) return;

  const win = getCurrentWindow();
  const label = win.label;

  // Only allow PiP on main windows (label "main" or "window-*")
  if (label !== 'main' && !label.startsWith('window-')) return;

  // Must have terminal tabs
  if (TabManager.tabs.length === 0) return;

  // Determine which tab to show in PiP
  let targetTabId = TabManager.activeTabId;

  if (!targetTabId || isHomeView || isGalleryView) {
    if (TabManager.tabs.length === 1) {
      // Single tab — use it directly
      targetTabId = TabManager.tabs[0].id;
    } else {
      // Multiple tabs, none selected — show selection popup
      targetTabId = await showTabSelectionPopup();
      if (!targetTabId) return; // user cancelled
    }
  }

  await activateTab(targetTabId);

  // Close all open drawers before capturing dimensions.
  const openDrawerSessionIds = DrawerManager.getOpenSessionIds();
  for (const sid of openDrawerSessionIds) {
    DrawerManager.toggle(sid);
  }

  // Save JumpServer browser window state, then close/undock/hide it
  let browserWindowState: BrowserWindowState | null = null;
  const jsBrowser = await WebviewWindow.getByLabel('jumpserver-browser');
  if (jsBrowser) {
    try {
      const bSize = await jsBrowser.innerSize();
      const bPos = await jsBrowser.outerPosition();
      const f = window.devicePixelRatio || 1;
      browserWindowState = {
        x: Math.round(bPos.x / f),
        y: Math.round(bPos.y / f),
        width: Math.round(bSize.width / f),
        height: Math.round(bSize.height / f),
      };
    } catch { /* window may have closed */ }
  }
  if (isJumpServerPanelOpen()) {
    closeJumpServerPanel();
  }
  try { await invoke('undock_child_window', { parentLabel: win.label, childLabel: 'jumpserver-browser' }); } catch { /* not docked */ }
  if (jsBrowser) await jsBrowser.hide().catch(() => {});

  // Save current window geometry
  const size = await win.innerSize();
  const pos = await win.outerPosition();
  const factor = window.devicePixelRatio || 1;

  pipState = {
    originalWidth: Math.round(size.width / factor),
    originalHeight: Math.round(size.height / factor),
    originalX: Math.round(pos.x / factor),
    originalY: Math.round(pos.y / factor),
    openDrawerSessionIds,
    browserWindowState,
  };

  // Capture terminal panel pixel dimensions before any layout changes
  const panel = document.getElementById('terminal-panel');
  const originalW = panel ? panel.clientWidth : pipState.originalWidth;
  const originalH = panel ? panel.clientHeight : pipState.originalHeight;

  // Scale from settings
  const scalePct = Math.max(10, Math.min(50, settings?.pipScale ?? 30));
  const scaleByScreen = settings?.pipScaleByScreen ?? false;

  let pipWidth: number;
  let pipHeight: number;
  let scale: number;

  if (scaleByScreen) {
    // Scale relative to screen size, maintaining the window's aspect ratio.
    // Use screen width × percentage as target PiP width, then derive height
    // from the original window's aspect ratio so the content isn't distorted.
    const screenW = window.screen.availWidth;
    pipWidth = Math.round(screenW * scalePct / 100);
    pipHeight = Math.round(pipWidth * (originalH / originalW));
    scale = pipWidth / originalW;
  } else {
    // Scale relative to the current window size
    scale = scalePct / 100;
    pipWidth = Math.round(originalW * scale);
    pipHeight = Math.round(originalH * scale);
  }

  // Apply inline styles FIRST to lock pixel dimensions and add transform,
  // THEN add pip-mode class. Order matters — pip-mode CSS changes grid layout,
  // which would collapse terminal-area to 0 height if panel size isn't locked.
  if (panel) {
    panel.style.transformOrigin = '0 0';
    panel.style.transform = `scale(${scale})`;
    panel.style.width = `${originalW}px`;
    panel.style.height = `${originalH}px`;
    panel.style.flex = 'none';
    panel.style.overflow = 'hidden';
  }

  // Add mode class (hides non-terminal UI via CSS)
  document.documentElement.classList.add('pip-mode');

  // Create floating pin button (separate from toolbar's pin button)
  createFloatingPinButton();

  // Freeze terminal resize
  setIsPipMode(true);

  // Add read-only overlay
  addReadonlyOverlay();

  // Hide traffic light buttons on macOS (keeps decorations/rounded corners)
  if (isMacPlatform) {
    await invoke('set_traffic_lights_visible', { visible: false });
  }

  // Disable resizing in PiP (terminal dimensions are frozen)
  await win.setResizable(false);

  // Apply window properties
  await win.setAlwaysOnTop(true);
  await win.setSize(new LogicalSize(pipWidth, pipHeight));

  // Position at top-right corner, offset by slot index
  const slot = pipWindows.size;
  pipWindows.set(label, slot);

  const screenW = window.screen.availWidth;
  const x = screenW - PIP_MARGIN - pipWidth - slot * (pipWidth + PIP_GAP);
  const y = PIP_MARGIN;
  await win.setPosition(new LogicalPosition(Math.max(PIP_MARGIN, x), y));

  // Broadcast to other windows
  await emit('pip-state-changed', { label, active: true, slot });
}

export async function exitPip(): Promise<void> {
  if (!pipState) return;

  const win = getCurrentWindow();
  const label = win.label;

  // Remove CSS mode
  document.documentElement.classList.remove('pip-mode');

  // Remove floating pin button
  removeFloatingPinButton();

  // Remove inline styles from terminal-panel
  const panel = document.getElementById('terminal-panel');
  if (panel) {
    panel.style.transformOrigin = '';
    panel.style.transform = '';
    panel.style.width = '';
    panel.style.height = '';
    panel.style.flex = '';
    panel.style.overflow = '';
  }

  // Unfreeze terminal resize
  setIsPipMode(false);

  // Remove read-only overlay
  removeReadonlyOverlay();

  // Restore traffic light buttons on macOS
  if (isMacPlatform) {
    await invoke('set_traffic_lights_visible', { visible: true });
  }

  // Restore resizability
  await win.setResizable(true);

  // Restore always-on-top: keep pin state if it was on before PiP
  await win.setAlwaysOnTop(getAlwaysOnTop());
  await win.setPosition(new LogicalPosition(pipState.originalX, pipState.originalY));

  const origW = pipState.originalWidth;
  const origH = pipState.originalHeight;
  const drawerSessionIds = pipState.openDrawerSessionIds;
  const savedBrowserState = pipState.browserWindowState;
  pipState = null;

  // Hide terminal panel during the resize transition to avoid showing
  // the TUI in a broken/bunched-up state before SIGWINCH triggers redraw.
  const termPanel = document.getElementById('terminal-panel');
  if (termPanel) termPanel.style.opacity = '0';

  // Restore original window size
  await win.setSize(new LogicalSize(origW, origH));

  // Wait for layout to settle (CSS reflow + window resize propagation),
  // then cancel all pending debounce/settle timers so they don't interfere
  // with the two-step force refresh below.
  await new Promise(resolve => setTimeout(resolve, 80));
  TerminalRegistry.cancelPendingResizeTimers();
  await TerminalRegistry.forceFullRefresh();

  // Reveal terminal with correct TUI rendering
  if (termPanel) termPanel.style.opacity = '';

  // Update slot tracking
  pipWindows.delete(label);

  // Broadcast to other windows
  await emit('pip-state-changed', { label, active: false });

  // Restore JumpServer browser window: size, position, visibility, and re-dock
  if (savedBrowserState) {
    const jsBrowser = await WebviewWindow.getByLabel('jumpserver-browser');
    if (jsBrowser) {
      await jsBrowser.setSize(new LogicalSize(savedBrowserState.width, savedBrowserState.height));
      await jsBrowser.setPosition(new LogicalPosition(savedBrowserState.x, savedBrowserState.y));
      await jsBrowser.show();
      // Re-dock to main window and notify browser window to update button states
      try { await invoke('dock_child_window', { parentLabel: win.label, childLabel: 'jumpserver-browser' }); } catch { /* */ }
      await emit('jumpserver-docked', {});
    }
  }

  // Restore drawers that were open before PiP
  for (const sid of drawerSessionIds) {
    if (DrawerManager.has(sid)) {
      DrawerManager.toggle(sid);
    }
  }

  // Update toolbar to reflect inactive pin state
  renderToolbarActions();
}

// ── Initialization ──

export function initPip(): void {
  // Listen for PiP state changes from other windows
  void listen<{ label: string; active: boolean; slot?: number }>('pip-state-changed', (event) => {
    const { label, active, slot } = event.payload;
    // Ignore events from our own window
    if (label === getCurrentWindow().label) return;

    if (active && slot !== undefined) {
      pipWindows.set(label, slot);
    } else {
      pipWindows.delete(label);
    }
  });

  // Clean up PiP state before window closes (uses existing close event flow)
  void listen<{ target_window: string }>('window-close-requested', (event) => {
    if (event.payload.target_window !== getCurrentWindow().label) return;
    if (isPipActive()) {
      const label = getCurrentWindow().label;
      pipWindows.delete(label);
      void emit('pip-state-changed', { label, active: false });
      setIsPipMode(false);
      pipState = null;
    }
  });
}

// ── Helpers ──

/** Show a popup for the user to select which tab to use for PiP. */
function showTabSelectionPopup(): Promise<string | null> {
  return new Promise((resolve) => {
    const existing = document.getElementById('pip-tab-select-popup');
    if (existing) { existing.remove(); resolve(null); return; }

    const backdrop = document.createElement('div');
    backdrop.id = 'pip-tab-select-popup';
    backdrop.className = 'pip-tab-select-backdrop';

    const dialog = document.createElement('div');
    dialog.className = 'pip-tab-select-dialog';

    const zh = settings?.language === 'zh';
    const title = document.createElement('div');
    title.className = 'pip-tab-select-title';
    title.textContent = zh ? '选择一个窗口用于画中画' : 'Select a session for Picture-in-Picture';
    dialog.appendChild(title);

    const list = document.createElement('div');
    list.className = 'pip-tab-select-list';

    for (const tab of TabManager.tabs) {
      const item = document.createElement('button');
      item.className = 'pip-tab-select-item';
      item.type = 'button';
      item.textContent = tab.title || tab.id;
      item.onclick = () => {
        cleanup();
        resolve(tab.id);
      };
      list.appendChild(item);
    }
    dialog.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'pip-tab-select-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'pip-tab-select-cancel';
    cancelBtn.type = 'button';
    cancelBtn.textContent = zh ? '取消' : 'Cancel';
    cancelBtn.onclick = () => { cleanup(); resolve(null); };
    actions.appendChild(cancelBtn);
    dialog.appendChild(actions);

    backdrop.appendChild(dialog);
    backdrop.onclick = (e) => {
      if (e.target === backdrop) { cleanup(); resolve(null); }
    };

    function cleanup(): void { backdrop.remove(); }

    document.body.appendChild(backdrop);
  });
}

/** Create a floating PiP button that hovers over the PiP terminal. */
function createFloatingPinButton(): void {
  removeFloatingPinButton();
  const btn = document.createElement('button');
  btn.className = 'pip-floating-pin-btn';
  btn.type = 'button';
  btn.innerHTML = `<span class="tab-icon">${icon('pip')}</span>`;
  btn.onclick = () => { void togglePip(); };
  document.getElementById('app')?.appendChild(btn);
}

function removeFloatingPinButton(): void {
  document.querySelector('.pip-floating-pin-btn')?.remove();
}

function addReadonlyOverlay(): void {
  removeReadonlyOverlay();
  const overlay = document.createElement('div');
  overlay.className = 'pip-readonly-overlay';

  // Drag the PiP window by clicking anywhere on the overlay
  overlay.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    void getCurrentWindow().startDragging();
  });

  const mainContent = document.getElementById('main-content');
  if (mainContent) {
    mainContent.style.position = 'relative';
    mainContent.appendChild(overlay);
  }
}

function removeReadonlyOverlay(): void {
  const overlay = document.querySelector('.pip-readonly-overlay');
  if (overlay) overlay.remove();
}
