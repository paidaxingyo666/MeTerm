/**
 * tab-renderer.ts — Tab bar rendering and progress indicators
 *
 * Extracted from main.ts. Contains:
 * - renderTabs()
 * - syncTabMarqueeState()
 * - ensureScrollButtons() / removeScrollButtons()
 * - scrollActiveTabIntoView()
 * - applyProgressLayer()
 * - syncTabProgressLayers()
 * - syncGalleryProgressBars()
 */

import { TabManager } from './tabs';
import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { AICapsuleManager } from './ai-capsule';
import { getAllLeaves } from './split-pane';
import { StatusBar, escapeHtml } from './status-bar';
import { icon } from './icons';
import { t } from './i18n';
import { initTabDrag } from './tab-drag';
import { invoke } from '@tauri-apps/api/core';
import { activateTab, showHomeView, statusLabel } from './view-manager';
import {
  pendingMasterRequests,
  viewerModeSessionIds, privateSessionIds,
  reclaimSessionIds,
  removeKickedOverlay, removeReconnectOverlay,
} from './overlays';
import {
  isHomeView, isGalleryView,
  sshConfigMap, remoteInfoMap, sessionProgressMap,
  remoteTabNumbers, jumpServerConfigMap,
} from './app-state';

// ── DOM elements (lazily cached) ──

let _tabBarEl: HTMLDivElement | null = null;
let _toolbarTabsEl: HTMLDivElement | null = null;

function getTabBarEl(): HTMLDivElement {
  if (!_tabBarEl) _tabBarEl = document.getElementById('tab-bar') as HTMLDivElement;
  return _tabBarEl;
}

function getToolbarTabsEl(): HTMLDivElement {
  if (!_toolbarTabsEl) _toolbarTabsEl = document.getElementById('window-toolbar-tabs') as HTMLDivElement;
  return _toolbarTabsEl;
}

// ── Late-bound callbacks ──

let _showTabContextMenu: (e: MouseEvent, tab: any, index: number) => void = () => {};

export function setTabRendererCallbacks(cbs: {
  showTabContextMenu: (e: MouseEvent, tab: any, index: number) => void;
}): void {
  _showTabContextMenu = cbs.showTabContextMenu;
}

// ── Progress layer ──

export function applyProgressLayer(el: HTMLElement, progress: { state: number; percent: number } | null): void {
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

export function syncTabProgressLayers(): void {
  const toolbarTabsEl = getToolbarTabsEl();
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

export function syncGalleryProgressBars(): void {
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

// ── Main tab rendering ──

export function renderTabs(): void {
  const tabBarEl = getTabBarEl();
  const toolbarTabsEl = getToolbarTabsEl();

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
    const isJumpServer = tabLeaves.some((l) => jumpServerConfigMap.has(l.sessionId));
    const isSSH = !isJumpServer && tabLeaves.some((l) => sshConfigMap.has(l.sessionId));
    const isRemoteTab = tabLeaves.some((l) => TerminalRegistry.get(l.sessionId)?.isRemote);
    const remoteLeaf = isRemoteTab ? tabLeaves.find((l) => TerminalRegistry.get(l.sessionId)?.isRemote) : null;
    const remoteNum = remoteLeaf ? remoteTabNumbers.get(remoteLeaf.sessionId) : undefined;
    const jsIconSvg = isJumpServer ? '<svg class="tab-js-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="1.8" stroke-linejoin="round"><path d="M12 2L3 7v10l9 5 9-5V7l-9-5Z"/><path d="M12 12L3 7M12 12l9-5M12 12v10" stroke-width="1.5"/></svg>' : '';
    const cloudIconSvg = isSSH ? '<svg class="tab-ssh-icon" width="12" height="12" viewBox="0 0 24 24" fill="#3b82f6"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>' : '';
    const isKickedTab = isRemoteTab && tabLeaves.some((l) => TerminalRegistry.get(l.sessionId)?.kicked);
    const remoteIconSvg = isRemoteTab
      ? `<span class="tab-remote-icon-wrap${isKickedTab ? ' kicked' : ''}"><svg class="tab-remote-icon" width="12" height="12" viewBox="0 0 24 24" fill="#22c55e"><circle cx="12" cy="12" r="9" fill="none" stroke="#22c55e" stroke-width="2"/><ellipse cx="12" cy="12" rx="4" ry="9" fill="none" stroke="#22c55e" stroke-width="1.7"/><path d="M3.5 9h17M3.5 15h17" fill="none" stroke="#22c55e" stroke-width="1.5"/></svg>${isKickedTab ? '<svg class="tab-kicked-x" width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/><line x1="10" y1="2" x2="2" y2="10" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/></svg>' : ''}${remoteNum !== undefined ? `<span class="tab-remote-badge">${remoteNum}</span>` : ''}</span>`
      : '';
    const hasIcon = isSSH || isJumpServer || isRemoteTab;
    const iconArea = hasIcon ? `<span class="tab-icon-area">${jsIconSvg}${cloudIconSvg}${remoteIconSvg}</span>` : '';
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
        jumpServerConfigMap.delete(leaf.sessionId);
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
      _showTabContextMenu(e, tab, TabManager.tabs.indexOf(tab));
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

// ── Tab marquee / overflow ──

export function syncTabMarqueeState(): void {
  const toolbarTabsEl = getToolbarTabsEl();
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
  const toolbarTabsEl = getToolbarTabsEl();
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
  const toolbarTabsEl = getToolbarTabsEl();
  const buttons = toolbarTabsEl.querySelectorAll('.tab-scroll-btn');
  buttons.forEach((btn) => btn.remove());
}

function scrollActiveTabIntoView(): void {
  const toolbarTabsEl = getToolbarTabsEl();
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
