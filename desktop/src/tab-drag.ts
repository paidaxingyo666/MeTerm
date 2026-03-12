import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { TabManager, type Tab } from './tabs';
import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { AICapsuleManager } from './ai-capsule';
import { type SplitNode, getAllLeaves, findLeafById, generatePaneId } from './split-pane';
import { jumpServerConfigMap } from './app-state';
import { createWindowAtPosition } from './window-utils';

interface WindowGeometry {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TabTransferSessionInfo {
  sessionId: string;
  clientId: string | null;
  title: string;
  status: string;
  isSSH: boolean;
  sshInfo?: { host: string; username: string; port: number };
  bufferContent?: string;
  isRemote?: boolean;
  remoteWsUrl?: string;
  remoteToken?: string;
  isJumpServer?: boolean;
  jumpServerInfo?: {
    config: import('./jumpserver-api').JumpServerConfig;
    asset: import('./jumpserver-api').JumpServerAsset;
    account: import('./jumpserver-api').JumpServerAccount;
  };
}

export interface TabTransferPayload {
  sourceWindow: string;
  targetWindow: string;
  tabId: string;
  splitRoot: SplitNode;
  focusedPaneId: string;
  tabTitle: string;
  tabStatus: string;
  sessions: TabTransferSessionInfo[];
  // Legacy fields for backward compat during transfer
  sessionId: string;
  clientId: string | null;
  title: string;
  status: string;
  isSSH: boolean;
  sshInfo?: { host: string; username: string; port: number };
  bufferContent?: string;
}

export interface TabTransferCompletePayload {
  sourceWindow: string;
  sessionId: string;
}

export interface SingleTabDragHoverPayload {
  sourceLabel: string;
  targetLabel: string;
  screenX: number;
  screenY: number;
  targetX: number; // target window screen X from cached geometry
  title: string;
}

export interface SingleTabDragLeavePayload {
  targetLabel: string;
}

interface DragState {
  sessionId: string;
  tabElement: HTMLElement;
  startX: number;
  startY: number;
  ghost: HTMLElement | null;
  isDragging: boolean;
  windowGeometries: WindowGeometry[];
  dropIndicator: HTMLElement | null;
  currentTarget: string | null;
  /** Track which window was last raised to front to avoid repeated setFocus calls */
  lastRaisedTarget: string | null;
}

const DRAG_THRESHOLD = 5;
const TAB_BAR_REGION_HEIGHT = 50; // screen px — only top strip of target counts as tab bar
let dragState: DragState | null = null;
let dragDidOccur = false;

// --- Single-tab window drag state (manual window movement + merge) ---
interface WindowDragState {
  sessionId: string;
  tabElement: HTMLElement;
  pointerId: number;
  startScreenX: number;
  startScreenY: number;
  startWinX: number;
  startWinY: number;
  positionReady: boolean;
  isDragging: boolean;
  windowGeometries: WindowGeometry[];
  currentTarget: string | null;
}

let windowDragState: WindowDragState | null = null;
let windowDragRafPending = false;
let windowDragTargetX = 0;
let windowDragTargetY = 0;

/** Label of the window that is being closed after a single-tab merge */
let singleTabMergeWindowLabel: string | null = null;

function onWindowDragMove(event: PointerEvent): void {
  if (!windowDragState) return;
  // Wait for async window position to be ready before moving
  if (!windowDragState.positionReady) return;

  const dx = event.screenX - windowDragState.startScreenX;
  const dy = event.screenY - windowDragState.startScreenY;

  if (!windowDragState.isDragging) {
    if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    windowDragState.isDragging = true;
  }

  // Move the window (throttled via rAF to prevent jitter).
  // Always update the target position so the rAF callback uses the latest values.
  windowDragTargetX = windowDragState.startWinX + dx;
  windowDragTargetY = windowDragState.startWinY + dy;
  if (!windowDragRafPending) {
    windowDragRafPending = true;
    requestAnimationFrame(() => {
      windowDragRafPending = false;
      if (windowDragState) {
        void getCurrentWindow().setPosition(new LogicalPosition(windowDragTargetX, windowDragTargetY));
      }
    });
  }

  // Check if cursor is over another window's tab bar region
  const target = findTargetWindow(event.screenX, event.screenY, windowDragState.windowGeometries, true);
  const prevTarget = windowDragState.currentTarget;

  if (target) {
    if (target.label !== prevTarget) {
      // Entering target tab bar: make source window semi-transparent
      document.documentElement.style.opacity = '0.4';
    }
    windowDragState.currentTarget = target.label;
    const tab = TabManager.tabs.find((t) => t.id === windowDragState!.sessionId);
    void emit('single-tab-drag-hover', {
      sourceLabel: getCurrentWindow().label,
      targetLabel: target.label,
      screenX: event.screenX,
      screenY: event.screenY,
      targetX: target.x,
      title: tab?.title || 'Terminal',
    } satisfies SingleTabDragHoverPayload);
  } else {
    if (prevTarget) {
      // Leaving target tab bar: restore source window opacity
      document.documentElement.style.opacity = '';
      void emit('single-tab-drag-leave', {
        targetLabel: prevTarget,
      } satisfies SingleTabDragLeavePayload);
    }
    windowDragState.currentTarget = null;
  }
}

async function onWindowDragUp(event: PointerEvent): Promise<void> {
  if (!windowDragState) return;

  const state = { ...windowDragState };
  const wasDragging = state.isDragging;
  const savedSessionId = state.sessionId;
  const savedGeometries = [...state.windowGeometries];

  // Cleanup
  windowDragState = null;
  document.removeEventListener('pointermove', onWindowDragMove);
  document.removeEventListener('pointerup', onWindowDragUp as unknown as EventListener);

  // Restore source window opacity
  document.documentElement.style.opacity = '';

  if (!wasDragging) return;

  // Clear hover indicator in target window
  if (state.currentTarget) {
    await emit('single-tab-drag-leave', {
      targetLabel: state.currentTarget,
    } satisfies SingleTabDragLeavePayload);
  }

  // Check if dropped on a target window's tab bar (not full window)
  const target = findTargetWindow(event.screenX, event.screenY, savedGeometries, true);
  if (!target) return; // Not on tab bar, window stays

  // Transfer tab to target window and close source window
  const payload = buildTransferPayload(savedSessionId, target.label);
  if (!payload) return;

  console.log('[TAB-DRAG] Single-tab merge: transferring to', target.label);

  // Mark this window for closure when the persistent tab-transfer-complete handler fires.
  // This avoids registering a second listener that races with the persistent one.
  singleTabMergeWindowLabel = getCurrentWindow().label;

  await emit('tab-transfer-request', payload);
}

function buildTransferPayload(tabId: string, targetLabel: string): TabTransferPayload | null {
  const tab = TabManager.tabs.find((t) => t.id === tabId);
  if (!tab) return null;

  const leaves = getAllLeaves(tab.splitRoot);
  const sessions: TabTransferSessionInfo[] = leaves.map((leaf) => {
    const mt = TerminalRegistry.get(leaf.sessionId);
    // Mark source terminal as transferring to suppress MsgRoleChange events
    // that may arrive when the target window connects with the same clientId.
    if (mt) mt._transferGrace = true;
    const isSSH = DrawerManager.has(leaf.sessionId);
    const sshInfo = isSSH ? DrawerManager.getServerInfo(leaf.sessionId) : undefined;
    const jsInfo = jumpServerConfigMap.get(leaf.sessionId);
    return {
      sessionId: leaf.sessionId,
      clientId: mt?.clientId || null,
      title: mt?.shellTitle || mt?.title || 'Terminal',
      status: mt?.ended ? 'ended' : mt?.ws ? 'connected' : 'disconnected',
      isSSH,
      sshInfo: sshInfo || undefined,
      bufferContent: TerminalRegistry.serializeBuffer(leaf.sessionId) || undefined,
      isRemote: mt?.isRemote || false,
      remoteWsUrl: mt?.remoteWsUrl,
      remoteToken: mt?.remoteToken,
      isJumpServer: !!jsInfo,
      jumpServerInfo: jsInfo || undefined,
    };
  });

  // Primary session = focused pane's session (for legacy compat)
  const primarySession = sessions[0];

  return {
    sourceWindow: getCurrentWindow().label,
    targetWindow: targetLabel,
    tabId: tab.id,
    splitRoot: tab.splitRoot,
    focusedPaneId: tab.focusedPaneId,
    tabTitle: tab.title,
    tabStatus: tab.status,
    sessions,
    // Legacy fields
    sessionId: primarySession?.sessionId || '',
    clientId: primarySession?.clientId || null,
    title: tab.title,
    status: tab.status,
    isSSH: primarySession?.isSSH || false,
    sshInfo: primarySession?.sshInfo,
    bufferContent: primarySession?.bufferContent,
  };
}

function getTabBarElement(): HTMLElement | null {
  return document.getElementById('window-toolbar-tabs');
}

function getTabScrollContainer(): HTMLElement | null {
  const tabBar = getTabBarElement();
  if (!tabBar) return null;
  return tabBar.querySelector('.tab-scroll-container') || tabBar;
}

function createGhost(tabElement: HTMLElement): HTMLElement {
  const ghost = document.createElement('div');
  ghost.className = 'tab-drag-ghost';
  ghost.textContent = tabElement.querySelector('.title-tab-text.primary')?.textContent || '';
  document.body.appendChild(ghost);
  return ghost;
}

function createDropIndicator(): HTMLElement {
  const indicator = document.createElement('div');
  indicator.className = 'tab-drop-indicator';
  return indicator;
}

function findTargetWindow(
  screenX: number,
  screenY: number,
  geometries: WindowGeometry[],
  tabBarOnly = false,
): WindowGeometry | null {
  const currentLabel = getCurrentWindow().label;
  for (const geo of geometries) {
    if (geo.label === currentLabel) continue;
    const maxY = tabBarOnly ? geo.y + TAB_BAR_REGION_HEIGHT : geo.y + geo.height;
    if (
      screenX >= geo.x &&
      screenX <= geo.x + geo.width &&
      screenY >= geo.y &&
      screenY <= maxY
    ) {
      return geo;
    }
  }
  return null;
}

function getTabIndexAtPosition(clientX: number): number {
  const container = getTabScrollContainer();
  if (!container) return -1;
  const tabs = Array.from(container.querySelectorAll('.title-tab')) as HTMLElement[];
  for (let i = 0; i < tabs.length; i++) {
    const rect = tabs[i].getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    if (clientX < midX) return i;
  }
  return tabs.length;
}

function isInsideCurrentWindow(clientX: number, clientY: number): boolean {
  return (
    clientX >= 0 &&
    clientY >= 0 &&
    clientX <= window.innerWidth &&
    clientY <= window.innerHeight
  );
}

function onPointerMove(event: PointerEvent): void {
  if (!dragState) return;

  const dx = event.clientX - dragState.startX;
  const dy = event.clientY - dragState.startY;

  if (!dragState.isDragging) {
    if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    dragState.isDragging = true;
    dragDidOccur = true;
    dragState.tabElement.classList.add('is-dragging');
    dragState.ghost = createGhost(dragState.tabElement);
    console.log('[TAB-DRAG] Drag started for session:', dragState.sessionId);
    // Cache window geometries at drag start
    invoke<WindowGeometry[]>('get_all_window_geometries').then((geos) => {
      if (dragState) {
        dragState.windowGeometries = geos;
        console.log('[TAB-DRAG] Got window geometries:', geos.length, geos);
      }
    }).catch((err) => {
      console.error('[TAB-DRAG] Failed to get window geometries:', err);
    });
  }

  // Update ghost position
  if (dragState.ghost) {
    dragState.ghost.style.left = `${event.clientX + 8}px`;
    dragState.ghost.style.top = `${event.clientY - 14}px`;
  }

  const inside = isInsideCurrentWindow(event.clientX, event.clientY);
  const tabBar = getTabBarElement();

  if (inside && tabBar) {
    // Clear any cross-window hover indicator
    if (dragState.currentTarget) {
      void emit('single-tab-drag-leave', {
        targetLabel: dragState.currentTarget,
      } satisfies SingleTabDragLeavePayload);
      dragState.currentTarget = null;
    }
    dragState.lastRaisedTarget = null;

    // Show drop indicator for same-window reorder
    const tabBarRect = tabBar.getBoundingClientRect();
    const inTabBar =
      event.clientY >= tabBarRect.top &&
      event.clientY <= tabBarRect.bottom &&
      event.clientX >= tabBarRect.left &&
      event.clientX <= tabBarRect.right;

    if (inTabBar) {
      const container = getTabScrollContainer() || tabBar;
      if (!dragState.dropIndicator) {
        dragState.dropIndicator = createDropIndicator();
        container.appendChild(dragState.dropIndicator);
      }
      // Use only visible (non-dragging) tabs for indicator positioning
      // so the indicator tracks the mouse smoothly without jumping over the dragged tab
      const visibleTabs = Array.from(container.querySelectorAll('.title-tab:not(.is-dragging)')) as HTMLElement[];
      let insertIdx = visibleTabs.length;
      for (let i = 0; i < visibleTabs.length; i++) {
        const rect = visibleTabs[i].getBoundingClientRect();
        if (event.clientX < rect.left + rect.width / 2) {
          insertIdx = i;
          break;
        }
      }
      const containerRect = container.getBoundingClientRect();
      if (insertIdx < visibleTabs.length) {
        const targetRect = visibleTabs[insertIdx].getBoundingClientRect();
        dragState.dropIndicator.style.left = `${targetRect.left - containerRect.left + container.scrollLeft}px`;
      } else if (visibleTabs.length > 0) {
        const lastRect = visibleTabs[visibleTabs.length - 1].getBoundingClientRect();
        dragState.dropIndicator.style.left = `${lastRect.right - containerRect.left + container.scrollLeft}px`;
      }
      dragState.dropIndicator.style.display = 'block';
    } else if (dragState.dropIndicator) {
      dragState.dropIndicator.remove();
      dragState.dropIndicator = null;
    }
  } else {
    // Cursor is outside current window
    if (dragState.dropIndicator) {
      dragState.dropIndicator.remove();
      dragState.dropIndicator = null;
    }

    // Raise overlapping windows: when cursor enters another window's full area,
    // bring it to front so its tab bar becomes accessible for drop targeting.
    // This handles the case where window B's tab bar is hidden behind window A.
    const fullTarget = findTargetWindow(event.screenX, event.screenY, dragState.windowGeometries, false);
    if (fullTarget && fullTarget.label !== dragState.lastRaisedTarget) {
      dragState.lastRaisedTarget = fullTarget.label;
      void WebviewWindow.getByLabel(fullTarget.label).then(w => { if (w) void w.setFocus(); });
    } else if (!fullTarget) {
      dragState.lastRaisedTarget = null;
    }

    // Check if cursor is over another window's tab bar for drop indicator
    const target = findTargetWindow(event.screenX, event.screenY, dragState.windowGeometries, true);
    const prevTarget = dragState.currentTarget;

    if (target) {
      dragState.currentTarget = target.label;
      const tab = TabManager.tabs.find((t) => t.id === dragState!.sessionId);
      void emit('single-tab-drag-hover', {
        sourceLabel: getCurrentWindow().label,
        targetLabel: target.label,
        screenX: event.screenX,
        screenY: event.screenY,
        targetX: target.x,
        title: tab?.title || 'Terminal',
      } satisfies SingleTabDragHoverPayload);
    } else {
      if (prevTarget) {
        void emit('single-tab-drag-leave', {
          targetLabel: prevTarget,
        } satisfies SingleTabDragLeavePayload);
      }
      dragState.currentTarget = null;
    }
  }
}

async function onPointerUp(event: PointerEvent): Promise<void> {
  if (!dragState) return;

  // Save all needed state BEFORE cleanup
  const state = { ...dragState };
  const wasDragging = state.isDragging;
  const savedGeometries = [...state.windowGeometries];
  const savedSessionId = state.sessionId;

  console.log('[TAB-DRAG] pointerup: isDragging=', wasDragging,
    'clientX=', event.clientX, 'clientY=', event.clientY,
    'screenX=', event.screenX, 'screenY=', event.screenY);

  // Cleanup drag visual state
  dragState.tabElement.classList.remove('is-dragging');
  try {
    dragState.tabElement.releasePointerCapture(event.pointerId);
  } catch { /* already released */ }
  if (dragState.ghost) {
    dragState.ghost.remove();
  }
  if (dragState.dropIndicator) {
    dragState.dropIndicator.remove();
  }

  // Clear cross-window hover indicator
  if (state.currentTarget) {
    void emit('single-tab-drag-leave', {
      targetLabel: state.currentTarget,
    } satisfies SingleTabDragLeavePayload);
  }

  dragState = null;
  document.removeEventListener('pointermove', onPointerMove);
  document.removeEventListener('pointerup', onPointerUp as unknown as EventListener);

  if (!wasDragging) return;

  const inside = isInsideCurrentWindow(event.clientX, event.clientY);
  console.log('[TAB-DRAG] inside current window:', inside);

  if (inside) {
    // Same-window reorder
    const tabBar = getTabBarElement();
    if (tabBar) {
      const tabBarRect = tabBar.getBoundingClientRect();
      const inTabBar =
        event.clientY >= tabBarRect.top &&
        event.clientY <= tabBarRect.bottom &&
        event.clientX >= tabBarRect.left &&
        event.clientX <= tabBarRect.right;

      if (inTabBar) {
        const fromIndex = TabManager.tabs.findIndex((t) => t.id === savedSessionId);
        let toIndex = getTabIndexAtPosition(event.clientX);
        if (fromIndex >= 0 && toIndex > fromIndex) toIndex--;
        if (fromIndex >= 0 && toIndex >= 0) {
          console.log('[TAB-DRAG] Reorder:', fromIndex, '->', toIndex);
          TabManager.reorderTab(fromIndex, toIndex);
        }
      }
    }
    return;
  }

  // Cross-window transfer
  const targetWindow = findTargetWindow(event.screenX, event.screenY, savedGeometries);
  if (!targetWindow) {
    console.log('[TAB-DRAG] No target window found, creating new window at', event.screenX, event.screenY);

    // Create new window at drop position and transfer tab to it
    void (async () => {
      try {
        const newLabel = await createWindowAtPosition(event.screenX, event.screenY);
        console.log('[TAB-DRAG] New window created:', newLabel);

        // Wait for the new window to signal readiness
        const ready = await new Promise<boolean>((resolve) => {
          let unlisten: (() => void) | null = null;
          const timeout = setTimeout(() => {
            if (unlisten) unlisten();
            console.warn('[TAB-DRAG] Timed out waiting for new window ready');
            resolve(false);
          }, 5000);

          listen<{ label: string }>('window-ready', (evt) => {
            if (evt.payload.label === newLabel) {
              clearTimeout(timeout);
              if (unlisten) unlisten();
              resolve(true);
            }
          }).then((fn) => {
            unlisten = fn;
          });
        });

        if (!ready) {
          console.warn('[TAB-DRAG] New window not ready, aborting transfer');
          return;
        }

        // Build and emit transfer payload
        const payload = buildTransferPayload(savedSessionId, newLabel);
        if (!payload) return;

        console.log('[TAB-DRAG] Emitting tab-transfer-request to new window:', payload);
        await emit('tab-transfer-request', payload);
      } catch (err) {
        console.error('[TAB-DRAG] Failed to create new window for tab:', err);
      }
    })();

    return;
  }

  const payload = buildTransferPayload(savedSessionId, targetWindow.label);
  if (!payload) return;

  console.log('[TAB-DRAG] Emitting tab-transfer-request:', payload);
  await emit('tab-transfer-request', payload);
}

export function initTabDrag(tabElement: HTMLElement, sessionId: string): void {
  tabElement.addEventListener('pointerdown', (event: PointerEvent) => {
    // Only left mouse button, ignore if clicking close button
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('.tab-close')) return;

    // Single-tab window: manual drag moves window + allows merge into other windows
    if (TabManager.tabs.length <= 1) {
      event.preventDefault();

      // Do NOT use setPointerCapture here. On macOS WebKit, calling
      // setPosition() to move the window causes pointer capture to be
      // implicitly released. Since the window follows the cursor, the cursor
      // always stays within the window viewport, so regular document events
      // keep firing without capture.
      windowDragState = {
        sessionId,
        tabElement,
        pointerId: event.pointerId,
        startScreenX: event.screenX,
        startScreenY: event.screenY,
        startWinX: 0,
        startWinY: 0,
        positionReady: false,
        isDragging: false,
        windowGeometries: [],
        currentTarget: null,
      };

      document.addEventListener('pointermove', onWindowDragMove);
      document.addEventListener('pointerup', onWindowDragUp as unknown as EventListener);

      // Fetch window position and geometries in parallel (async)
      Promise.all([
        invoke<[number, number]>('get_window_position'),
        invoke<WindowGeometry[]>('get_all_window_geometries'),
      ]).then(([[winX, winY], geos]) => {
        if (windowDragState) {
          windowDragState.startWinX = winX;
          windowDragState.startWinY = winY;
          windowDragState.windowGeometries = geos;
          windowDragState.positionReady = true;
        }
      }).catch((err) => {
        console.error('[WIN-DRAG] Failed to init window drag:', err);
        // Cleanup and fall back to native drag
        if (windowDragState) {
          windowDragState = null;
          document.removeEventListener('pointermove', onWindowDragMove);
          document.removeEventListener('pointerup', onWindowDragUp as unknown as EventListener);
        }
        void getCurrentWindow().startDragging();
      });

      return;
    }

    dragDidOccur = false;

    dragState = {
      sessionId,
      tabElement,
      startX: event.clientX,
      startY: event.clientY,
      ghost: null,
      isDragging: false,
      windowGeometries: [],
      dropIndicator: null,
      currentTarget: null,
      lastRaisedTarget: null,
    };

    tabElement.setPointerCapture(event.pointerId);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp as unknown as EventListener);
  });

  // Suppress click after drag
  tabElement.addEventListener('click', (event: MouseEvent) => {
    if (dragDidOccur) {
      event.stopImmediatePropagation();
      event.preventDefault();
      dragDidOccur = false;
    }
  }, true);
}

export function setupTabTransferListener(
  onActivateTab: (sessionId: string) => Promise<void>,
  onShowHomeView: () => void,
  port: number,
  authToken: string,
  renderTabs: () => void,
  onSessionTransferred?: (sess: TabTransferSessionInfo) => void,
): () => void {
  let unlisten: (() => void) | null = null;

  listen<TabTransferPayload>('tab-transfer-request', async (event) => {
    const payload = event.payload;
    const currentLabel = getCurrentWindow().label;

    // Only handle if this window is the target
    if (payload.targetWindow !== currentLabel) return;

    const sessions = payload.sessions || [{
      sessionId: payload.sessionId,
      clientId: payload.clientId,
      title: payload.title,
      status: payload.status,
      isSSH: payload.isSSH,
      sshInfo: payload.sshInfo,
      bufferContent: payload.bufferContent,
    }];

    console.log('[TAB-DRAG] Receiving tab transfer:', sessions.length, 'sessions from', payload.sourceWindow);

    // Bring this window to front
    try {
      await getCurrentWindow().setFocus();
    } catch (e) {
      console.warn('[TAB-DRAG] Failed to set window focus:', e);
    }

    // Create tab with split tree in target window
    const newTabId = payload.tabId || `tab-transfer-${Date.now().toString(36)}`;
    const tab: Tab = {
      id: newTabId,
      splitRoot: payload.splitRoot || { type: 'leaf', id: generatePaneId(), sessionId: sessions[0].sessionId },
      focusedPaneId: payload.focusedPaneId || (payload.splitRoot ? getAllLeaves(payload.splitRoot)[0]?.id : '') || generatePaneId(),
      title: payload.tabTitle || payload.title,
      status: 'connecting',
    };
    const idx = mergeInsertIndex;
    mergeInsertIndex = null;
    TabManager.insertTab(tab, idx ?? undefined);

    // Phase 1: Create all terminal structures (no open, no connect)
    for (const sess of sessions) {
      TerminalRegistry.attachFromTransfer(
        sess.sessionId,
        sess.clientId,
        (status) => {
          const existingTab = TabManager.tabs.find((t) => t.id === newTabId);
          if (existingTab) {
            // Only update tab status from focused session
            const focusedLeaf = findLeafById(existingTab.splitRoot, existingTab.focusedPaneId);
            if (focusedLeaf && focusedLeaf.sessionId === sess.sessionId) {
              existingTab.status = status;
              TabManager.notify();
            }
          }
        },
        sess.isJumpServer
          ? () => {
            // JumpServer sessions: keep asset name as tab title, ignore terminal title updates
          }
          : (title) => {
            const existingTab = TabManager.tabs.find((t) => t.id === newTabId);
            if (existingTab) {
              const focusedLeaf = findLeafById(existingTab.splitRoot, existingTab.focusedPaneId);
              if (focusedLeaf && focusedLeaf.sessionId === sess.sessionId) {
                existingTab.title = title || existingTab.title;
                TabManager.notify();
              }
            }
          },
      );

      // Restore JumpServer config map so the icon renders correctly
      if (sess.isJumpServer && sess.jumpServerInfo) {
        jumpServerConfigMap.set(sess.sessionId, sess.jumpServerInfo);
      }

      // Restore remote session state
      if (sess.isRemote) {
        const mt = TerminalRegistry.get(sess.sessionId);
        if (mt) {
          mt.isRemote = true;
          mt.remoteWsUrl = sess.remoteWsUrl;
          mt.remoteToken = sess.remoteToken;
        }
      }

      // Recreate drawer for SSH sessions
      if (sess.isSSH) {
        DrawerManager.create(sess.sessionId, 'ssh');
        if (sess.sshInfo) {
          DrawerManager.updateServerInfo(sess.sessionId, sess.sshInfo);
        }
      }

      // Notify main.ts to restore sshConfigMap / remoteInfoMap / etc.
      onSessionTransferred?.(sess);

      // Create AI capsule
      AICapsuleManager.create(sess.sessionId);
    }

    // Activate tab
    await onActivateTab(newTabId);
    renderTabs();

    // Phase 2: Open and connect all terminals
    for (const sess of sessions) {
      TerminalRegistry.openAndConnect(sess.sessionId, port, authToken);

      // Restore buffer content
      if (sess.bufferContent) {
        const transferred = TerminalRegistry.get(sess.sessionId);
        if (transferred) {
          transferred.terminal.write(sess.bufferContent);
        }
      }
    }
    console.log('[TAB-DRAG] All terminals opened and connections started');

    // Notify source window to clean up (use legacy sessionId for compat)
    const completePayload: TabTransferCompletePayload = {
      sourceWindow: payload.sourceWindow,
      sessionId: payload.tabId || payload.sessionId,
    };
    console.log('[TAB-DRAG] Emitting tab-transfer-complete:', completePayload);
    await emit('tab-transfer-complete', completePayload);
  }).then((fn) => {
    unlisten = fn;
  });

  // Listen for transfer completion (source window cleanup)
  let unlistenComplete: (() => void) | null = null;
  listen<TabTransferCompletePayload>('tab-transfer-complete', async (event) => {
    const payload = event.payload;
    const currentLabel = getCurrentWindow().label;

    // Only handle if this window is the source
    if (payload.sourceWindow !== currentLabel) return;

    console.log('[TAB-DRAG] Transfer complete, cleaning up tab:', payload.sessionId);

    // payload.sessionId is actually the tabId (set by completePayload)
    const tab = TabManager.tabs.find((t) => t.id === payload.sessionId);
    if (tab) {
      // Detach all terminals in the split tree
      const leaves = getAllLeaves(tab.splitRoot);
      for (const leaf of leaves) {
        TerminalRegistry.detach(leaf.sessionId);
        DrawerManager.destroy(leaf.sessionId);
        AICapsuleManager.destroy(leaf.sessionId);
      }
    }

    // Remove tab without destroying backend session
    TabManager.removeTabWithoutDestroy(payload.sessionId);

    // If this is a single-tab merge, close the window instead of showing home view
    if (singleTabMergeWindowLabel === currentLabel) {
      singleTabMergeWindowLabel = null;
      console.log('[TAB-DRAG] Single-tab merge complete, closing source window');
      await invoke('allow_window_close', { windowLabel: currentLabel });
      await getCurrentWindow().close();
      return;
    }

    // Activate next tab or show home
    if (TabManager.activeTabId) {
      await onActivateTab(TabManager.activeTabId);
    } else {
      onShowHomeView();
    }
    renderTabs();
  }).then((fn) => {
    unlistenComplete = fn;
  });

  // Listen for single-tab window drag hover (show merge indicator)
  let mergeIndicator: HTMLElement | null = null;
  let mergeInsertIndex: number | null = null;
  let unlistenHover: (() => void) | null = null;
  listen<SingleTabDragHoverPayload>('single-tab-drag-hover', (event) => {
    const payload = event.payload;
    const currentLabel = getCurrentWindow().label;
    if (payload.targetLabel !== currentLabel) return;

    const tabBar = getTabBarElement();
    if (!tabBar) return;
    const container = getTabScrollContainer() || tabBar;

    const containerRect = container.getBoundingClientRect();
    const tabs = Array.from(container.querySelectorAll('.title-tab')) as HTMLElement[];
    const indicatorWidth = tabs.length > 0 ? tabs[0].getBoundingClientRect().width : 80;

    // Convert screen X to position relative to scroll container
    const cursorRelX = payload.screenX - payload.targetX - containerRect.left;

    // Find insert index by comparing cursor position against tab midpoints
    let insertIdx = tabs.length;
    for (let i = 0; i < tabs.length; i++) {
      const tabRect = tabs[i].getBoundingClientRect();
      const tabMidX = (tabRect.left - containerRect.left) + tabRect.width / 2;
      if (cursorRelX < tabMidX) {
        insertIdx = i;
        break;
      }
    }

    if (!mergeIndicator) {
      mergeIndicator = document.createElement('div');
      mergeIndicator.className = 'tab-merge-indicator';
      container.appendChild(mergeIndicator);
      // Ensure indicator is visible even when tab bar is empty
      container.style.overflow = 'visible';
      container.style.minHeight = '22px';
    }

    // Position the indicator (accounting for scroll offset)
    let indicatorLeft: number;
    if (insertIdx < tabs.length) {
      const targetRect = tabs[insertIdx].getBoundingClientRect();
      indicatorLeft = targetRect.left - containerRect.left + container.scrollLeft;
    } else if (tabs.length > 0) {
      const lastRect = tabs[tabs.length - 1].getBoundingClientRect();
      indicatorLeft = lastRect.right - containerRect.left + container.scrollLeft + 4;
    } else {
      indicatorLeft = 0;
    }

    mergeIndicator.style.left = `${indicatorLeft}px`;
    mergeIndicator.style.width = `${indicatorWidth}px`;
    mergeIndicator.style.display = 'block';
    mergeInsertIndex = insertIdx;
  }).then((fn) => {
    unlistenHover = fn;
  });

  // Listen for single-tab window drag leave (hide merge indicator)
  let unlistenLeave: (() => void) | null = null;
  listen<SingleTabDragLeavePayload>('single-tab-drag-leave', (event) => {
    const currentLabel = getCurrentWindow().label;
    if (event.payload.targetLabel !== currentLabel) return;

    if (mergeIndicator) {
      const container = getTabScrollContainer() || getTabBarElement();
      mergeIndicator.remove();
      mergeIndicator = null;
      if (container) {
        container.style.overflow = '';
        container.style.minHeight = '';
      }
    }
  }).then((fn) => {
    unlistenLeave = fn;
  });

  return () => {
    if (unlisten) unlisten();
    if (unlistenComplete) unlistenComplete();
    if (unlistenHover) unlistenHover();
    if (unlistenLeave) unlistenLeave();
  };
}
