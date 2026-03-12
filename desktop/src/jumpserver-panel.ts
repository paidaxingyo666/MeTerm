/**
 * jumpserver-panel.ts — Embedded JumpServer asset browser side panel
 *
 * Renders an asset browser as a right-side panel in the main window.
 * Supports toggle, resize, and pop-out to independent window with docking.
 */

import { t } from './i18n';
import { escapeHtml } from './status-bar';
import { createOverlayScrollbar } from './overlay-scrollbar';
import {
  type JumpServerConfig,
  type JumpServerAsset,
  type JumpServerNode,
  type JumpServerAccount,
  getAssets,
  getNodes,
  getAccounts,
} from './jumpserver-api';
import { connectToAsset } from './jumpserver-handler';
import { activeJumpServers } from './app-state';
import { openJumpServerBrowserWindow } from './jumpserver-browser';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { emit } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi';

// ── SVG icons ──

const SVG_FOLDER = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1.5 3.5h4.3l1.7 1.5h7v8h-13v-9.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/></svg>`;
const SVG_CHEVRON_RIGHT = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3.5 1.5L7 5L3.5 8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const SVG_CHEVRON_DOWN = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 3.5L5 7L8.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const SVG_LIST = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
const SVG_POPOUT = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M9 2h5v5M14 2L8 8M6 3H3a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1v-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const SVG_CLOSE = `<svg width="12" height="12" viewBox="0 0 10 10" fill="none"><path d="M1.5 1.5 8.5 8.5M8.5 1.5 1.5 8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
const SVG_FILTER = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 3h12L9.5 8.5V12l-3 1.5V8.5L2 3z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/></svg>`;

// ── Panel state ──

let panelEl: HTMLElement | null = null;
let resizeHandleEl: HTMLElement | null = null;
let currentConfig: JumpServerConfig | null = null;
let panelWidth = 320;
const PANEL_MIN_RATIO = 0.20;
const PANEL_MAX_RATIO = 0.40;
const LS_KEY = 'meterm-js-panel-width';

/** Get dynamic min/max based on main-content width */
function getPanelBounds(): { min: number; max: number } {
  const mainContent = document.getElementById('main-content');
  const totalW = mainContent ? mainContent.offsetWidth : 1200;
  return {
    min: Math.max(200, Math.round(totalW * PANEL_MIN_RATIO)),
    max: Math.round(totalW * PANEL_MAX_RATIO),
  };
}

// ── Public API ──

export function isJumpServerPanelOpen(): boolean {
  return panelEl !== null && panelEl.style.display !== 'none';
}

export function toggleJumpServerPanel(config?: JumpServerConfig): void {
  const cfg = config || (activeJumpServers.size === 1
    ? activeJumpServers.values().next().value
    : null);

  if (!cfg) return;

  if (isJumpServerPanelOpen() && currentConfig?.name === cfg.name) {
    closeJumpServerPanel();
  } else {
    openJumpServerPanel(cfg);
  }
}

export function openJumpServerPanel(config: JumpServerConfig): void {
  const mainContent = document.getElementById('main-content');
  if (!mainContent) return;

  // Restore saved width
  const saved = localStorage.getItem(LS_KEY);
  const bounds = getPanelBounds();
  if (saved) panelWidth = Math.max(bounds.min, Math.min(bounds.max, parseInt(saved) || 320));

  currentConfig = config;

  // Create resize handle if needed
  if (!resizeHandleEl) {
    resizeHandleEl = document.createElement('div');
    resizeHandleEl.className = 'js-panel-resize-handle';
    setupResizeHandle(resizeHandleEl, mainContent);
  }

  // Create or reuse panel element
  if (!panelEl) {
    panelEl = document.createElement('div');
    panelEl.id = 'jumpserver-panel';
  }

  panelEl.style.width = `${panelWidth}px`;
  panelEl.style.display = '';
  panelEl.innerHTML = '';

  // Render panel content
  renderPanelContent(panelEl, config);

  // Ensure elements are in DOM
  if (!resizeHandleEl.parentElement) mainContent.appendChild(resizeHandleEl);
  if (!panelEl.parentElement) mainContent.appendChild(panelEl);
  resizeHandleEl.style.display = '';
}

export function closeJumpServerPanel(): void {
  if (panelEl) panelEl.style.display = 'none';
  if (resizeHandleEl) resizeHandleEl.style.display = 'none';
  currentConfig = null;
}

export function destroyJumpServerPanel(): void {
  panelEl?.remove();
  resizeHandleEl?.remove();
  panelEl = null;
  resizeHandleEl = null;
  currentConfig = null;
  stopDocking();
}

// ── Window docking (pop-out mode) ──

let dockUnlistenMove: (() => void) | null = null;
let dockUnlistenResize: (() => void) | null = null;
let isDocked = false;
const DOCK_SNAP_DISTANCE = 30;

export async function startDockedBrowser(config: JumpServerConfig): Promise<void> {
  // Get main window geometry
  const [mainX, mainY] = await invoke<[number, number]>('get_window_position');
  const mainSize = await getCurrentWindow().innerSize();
  const factor = window.devicePixelRatio || 1;
  const mainW = mainSize.width / factor;
  const mainH = mainSize.height / factor;

  // Position browser window at right edge of main window
  const browserW = 240;
  const browserH = mainH;
  const browserX = mainX + mainW + 2;
  const browserY = mainY;

  // Store position for the browser window to use
  localStorage.setItem('meterm-js-browser-port', String((await import('./app-state')).port));
  localStorage.setItem('meterm-js-browser-token', (await import('./app-state')).authToken);
  localStorage.setItem('meterm-js-browser-config', JSON.stringify(config));

  const label = 'jumpserver-browser';
  let win = await WebviewWindow.getByLabel(label);

  if (win) {
    // Reuse existing window — emit target so browser window animates itself
    await emit('jumpserver-snap-target', { x: browserX, y: browserY, w: browserW, h: browserH });
    await win.show();
    await win.setFocus();
  } else {
    // Signal browser window not to auto-show (we control visibility after positioning)
    localStorage.setItem('meterm-js-browser-docked', 'true');
    await openJumpServerBrowserWindow(config);
    await new Promise<void>(resolve => setTimeout(resolve, 300));
    win = await WebviewWindow.getByLabel(label);
    if (win) {
      // Position at docked location directly (no animation for initial open)
      await win.setPosition(new LogicalPosition(browserX, browserY));
      await win.setSize(new LogicalSize(browserW, browserH));
      await win.show();
      await win.setFocus();
    }
  }

  isDocked = true;
  void emit('jumpserver-docked', {});

  const mainWin = getCurrentWindow();
  const f = factor;
  let cachedBrowserWin = win;

  // macOS: use native addChildWindow for zero-latency move following
  const isMacPlatform = !navigator.userAgent.toLowerCase().includes('windows');
  if (isMacPlatform) {
    await invoke('dock_child_window', { parentLabel: 'main', childLabel: 'jumpserver-browser' });
  }

  // Resize still needs JS handling (native child window doesn't auto-resize)
  dockUnlistenResize = await mainWin.listen('tauri://resize', async () => {
    if (!isDocked) return;
    if (!cachedBrowserWin) {
      cachedBrowserWin = await WebviewWindow.getByLabel('jumpserver-browser');
      if (!cachedBrowserWin) { stopDocking(); return; }
    }
    try {
      const size = await mainWin.innerSize();
      const h = size.height / f;
      await cachedBrowserWin.setSize(new LogicalSize(browserW, h));
    } catch { /* window may have closed */ }
  });

  // Non-macOS: JS-based move following (fallback)
  if (!isMacPlatform) {
    dockUnlistenMove = await mainWin.listen('tauri://move', async () => {
      if (!isDocked) return;
      if (!cachedBrowserWin) {
        cachedBrowserWin = await WebviewWindow.getByLabel('jumpserver-browser');
        if (!cachedBrowserWin) { stopDocking(); return; }
      }
      try {
        const [mx, my] = await invoke<[number, number]>('get_window_position');
        const size = await mainWin.innerSize();
        const w = size.width / f;
        await cachedBrowserWin.setPosition(new LogicalPosition(mx + w + 2, my));
      } catch { /* window may have closed */ }
    });
  }

  // Monitor browser window position to detect undocking (user dragged it away)
  const checkDockInterval = setInterval(async () => {
    if (!isDocked) { clearInterval(checkDockInterval); return; }
    const browserWin = await WebviewWindow.getByLabel('jumpserver-browser');
    if (!browserWin) { isDocked = false; clearInterval(checkDockInterval); stopDocking(); return; }
    try {
      const [mx] = await invoke<[number, number]>('get_window_position');
      const mainSz = await getCurrentWindow().innerSize();
      const f = window.devicePixelRatio || 1;
      const mainRight = mx + mainSz.width / f;
      const bPos = await browserWin.outerPosition();
      const bx = bPos.x / f;
      // If browser window is moved far from dock position, undock
      if (Math.abs(bx - mainRight - 2) > DOCK_SNAP_DISTANCE) {
        isDocked = false;
        clearInterval(checkDockInterval);
        stopDocking();
      }
    } catch { /* window may have closed */ }
  }, 1000);
}

function stopDocking(): void {
  isDocked = false;
  void emit('jumpserver-undocked', {});
  if (dockUnlistenMove) { dockUnlistenMove(); dockUnlistenMove = null; }
  if (dockUnlistenResize) { dockUnlistenResize(); dockUnlistenResize = null; }
  // macOS: detach native child window so it can move independently
  void invoke('undock_child_window', { parentLabel: 'main', childLabel: 'jumpserver-browser' }).catch(() => {});
}

// ── Resize handle ──

function setupResizeHandle(handle: HTMLElement, container: HTMLElement): void {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = panelWidth;
    container.classList.add('js-panel-resizing');

    const onMove = (ev: PointerEvent) => {
      // Dragging left increases panel width (panel is on the right)
      const delta = startX - ev.clientX;
      const { min, max } = getPanelBounds();
      panelWidth = Math.max(min, Math.min(max, startWidth + delta));
      if (panelEl) panelEl.style.width = `${panelWidth}px`;
    };
    const onUp = () => {
      container.classList.remove('js-panel-resizing');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      localStorage.setItem(LS_KEY, String(panelWidth));
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

// ── Panel content rendering ──

function renderPanelContent(container: HTMLElement, config: JumpServerConfig): void {
  // Header
  const header = document.createElement('div');
  header.className = 'js-panel-header';
  header.innerHTML = `
    <span class="js-panel-title" title="${escapeHtml(config.name)}">${escapeHtml(config.name)}</span>
    <div class="js-panel-header-actions">
      <button class="js-panel-header-btn" title="${t('jsAssetBrowser')}" data-action="popout">${SVG_POPOUT}</button>
      <button class="js-panel-header-btn" title="Close" data-action="close">${SVG_CLOSE}</button>
    </div>
  `;
  header.querySelector('[data-action="popout"]')!.addEventListener('click', () => {
    closeJumpServerPanel();
    void startDockedBrowser(config);
  });
  header.querySelector('[data-action="close"]')!.addEventListener('click', closeJumpServerPanel);
  container.appendChild(header);

  // Search bar with filter button (same as standalone narrow mode)
  const searchBar = document.createElement('div');
  searchBar.className = 'js-panel-search';

  const filterBtn = document.createElement('button');
  filterBtn.className = 'js-narrow-filter-btn';
  filterBtn.innerHTML = SVG_FILTER;
  filterBtn.title = t('jsAllAssets');
  searchBar.appendChild(filterBtn);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'js-panel-search-input';
  searchInput.placeholder = t('jsSearchAssets');
  searchBar.appendChild(searchInput);
  container.appendChild(searchBar);

  // Floating node dropdown (filter popup)
  const nodeDropdown = document.createElement('div');
  nodeDropdown.className = 'js-narrow-node-dropdown';
  container.appendChild(nodeDropdown);

  // Body: assets only (no sidebar)
  const body = document.createElement('div');
  body.className = 'js-panel-body';

  const assets = document.createElement('div');
  assets.className = 'js-panel-assets';
  assets.innerHTML = `<div class="js-loading">${t('jsLoading')}</div>`;

  body.appendChild(assets);
  container.appendChild(body);

  // Attach overlay scrollbar to assets list
  createOverlayScrollbar({ viewport: assets, container: assets });

  // Status
  const statusBar = document.createElement('div');
  statusBar.className = 'js-panel-status';
  container.appendChild(statusBar);

  // State
  let selectedNodeId = '';
  let selectedNodeName = t('jsAllAssets');
  let currentAssets: JumpServerAsset[] = [];
  let currentPage = 1;
  let totalAssets = 0;
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

  // Filter button toggles floating node dropdown
  let dropdownOpen = false;
  filterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdownOpen = !dropdownOpen;
    nodeDropdown.classList.toggle('js-dropdown-open', dropdownOpen);
    filterBtn.classList.toggle('active', dropdownOpen);
  });
  document.addEventListener('click', () => {
    if (dropdownOpen) {
      dropdownOpen = false;
      nodeDropdown.classList.remove('js-dropdown-open');
      filterBtn.classList.remove('active');
    }
  });
  nodeDropdown.addEventListener('click', (e) => e.stopPropagation());

  // Node selection handler
  const selectNode = (nodeId: string, nodeName: string) => {
    selectedNodeId = nodeId;
    selectedNodeName = nodeName;
    currentPage = 1;
    filterBtn.title = nodeName;
    loadAssetList();
    dropdownOpen = false;
    nodeDropdown.classList.remove('js-dropdown-open');
    filterBtn.classList.remove('active');
  };

  // Load nodes
  const loadNodeTree = async () => {
    try {
      const result = await getNodes(config.baseUrl);
      if (!result.ok || !result.nodes) {
        nodeDropdown.innerHTML = `<div class="js-error">${escapeHtml(result.error || 'Failed')}</div>`;
        return;
      }
      renderNodeDropdown(result.nodes);
    } catch (err) {
      nodeDropdown.innerHTML = `<div class="js-error">${escapeHtml(String(err))}</div>`;
    }
  };

  const renderNodeDropdown = (nodes: JumpServerNode[]) => {
    nodeDropdown.innerHTML = '';

    const sorted = [...nodes].sort((a, b) => {
      const aParts = (a.key || '').split(':').map(Number);
      const bParts = (b.key || '').split(':').map(Number);
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const av = aParts[i] ?? -1;
        const bv = bParts[i] ?? -1;
        if (av !== bv) return av - bv;
      }
      return 0;
    });

    const keySet = new Set(sorted.map(n => n.key || ''));
    const hasChildren = (key: string) => {
      for (const k of keySet) {
        if (k !== key && k.startsWith(key + ':')) return true;
      }
      return false;
    };
    const ddExpanded = new Set<string>();
    const ddElements = new Map<string, HTMLElement>();

    // "All" item
    const allItem = document.createElement('div');
    allItem.className = 'js-node-item js-node-selected';
    allItem.innerHTML = `<span class="js-node-icon">${SVG_LIST}</span><span class="js-node-name">${escapeHtml(t('jsAllAssets'))}</span>`;
    allItem.onclick = () => {
      nodeDropdown.querySelectorAll('.js-node-item').forEach(n => n.classList.remove('js-node-selected'));
      allItem.classList.add('js-node-selected');
      selectNode('', t('jsAllAssets'));
    };
    nodeDropdown.appendChild(allItem);

    sorted.forEach(node => {
      const key = node.key || '';
      const depth = key.split(':').length - 1;
      const isParent = hasChildren(key);

      const item = document.createElement('div');
      item.className = 'js-node-item';
      item.style.paddingLeft = `${8 + depth * 14}px`;

      const chevron = isParent
        ? `<span class="js-node-chevron">${SVG_CHEVRON_RIGHT}</span>`
        : `<span class="js-node-chevron-spacer"></span>`;

      item.innerHTML = `${chevron}<span class="js-node-icon">${SVG_FOLDER}</span><span class="js-node-name">${escapeHtml(node.name)}</span>${node.assets_amount ? `<span class="js-node-count">${node.assets_amount}</span>` : ''}`;

      if (depth > 0) item.style.display = 'none';

      if (isParent) {
        const chevronEl = item.querySelector('.js-node-chevron')!;
        chevronEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (ddExpanded.has(key)) {
            ddExpanded.delete(key);
            chevronEl.innerHTML = SVG_CHEVRON_RIGHT;
          } else {
            ddExpanded.add(key);
            chevronEl.innerHTML = SVG_CHEVRON_DOWN;
          }
          updateDdVisibility();
        });
      }

      item.addEventListener('click', () => {
        nodeDropdown.querySelectorAll('.js-node-item').forEach(n => n.classList.remove('js-node-selected'));
        item.classList.add('js-node-selected');
        selectNode(node.id, node.name);
        if (isParent && !ddExpanded.has(key)) {
          ddExpanded.add(key);
          const chevronEl = item.querySelector('.js-node-chevron');
          if (chevronEl) chevronEl.innerHTML = SVG_CHEVRON_DOWN;
          updateDdVisibility();
        }
      });

      ddElements.set(key, item);
      nodeDropdown.appendChild(item);
    });

    const updateDdVisibility = () => {
      for (const [key, el] of ddElements) {
        const depth = key.split(':').length - 1;
        if (depth === 0) { el.style.display = ''; continue; }
        const parts = key.split(':');
        let visible = true;
        for (let i = 1; i < parts.length; i++) {
          if (!ddExpanded.has(parts.slice(0, i).join(':'))) { visible = false; break; }
        }
        el.style.display = visible ? '' : 'none';
      }
    };
  };

  // Load assets
  const loadAssetList = async () => {
    assets.innerHTML = `<div class="js-loading">${t('jsLoading')}</div>`;
    try {
      const result = await getAssets(config.baseUrl, {
        search: searchInput.value.trim() || undefined,
        nodeId: selectedNodeId || undefined,
        page: currentPage,
        pageSize: 50,
      });
      if (!result.ok || !result.assets) {
        assets.innerHTML = `<div class="js-error">${escapeHtml(result.error || 'Failed')}</div>`;
        return;
      }
      currentAssets = result.assets;
      totalAssets = result.total || result.assets.length;
      renderAssetList();
    } catch (err) {
      assets.innerHTML = `<div class="js-error">${escapeHtml(String(err))}</div>`;
    }
  };

  const renderAssetList = () => {
    assets.innerHTML = '';
    if (currentAssets.length === 0) {
      assets.innerHTML = `<div class="js-empty">${t('jsNoAssets')}</div>`;
      statusBar.textContent = t('jsNoAssets');
      return;
    }

    const list = document.createElement('div');
    list.className = 'js-narrow-card-list';

    // Show selected node label
    if (selectedNodeName && selectedNodeName !== t('jsAllAssets')) {
      const nodeLabel = document.createElement('div');
      nodeLabel.className = 'js-narrow-node-label';
      nodeLabel.innerHTML = `${SVG_FOLDER} <span>${escapeHtml(selectedNodeName)}</span>`;
      list.appendChild(nodeLabel);
    }

    currentAssets.forEach(asset => {
      const card = document.createElement('div');
      card.className = 'js-narrow-card';
      const name = asset.name || asset.address;
      const platform = asset.platform?.name || '';
      const comment = asset.comment || '';

      const meta: string[] = [];
      if (asset.address) meta.push(escapeHtml(asset.address));
      if (platform) meta.push(escapeHtml(platform));

      card.innerHTML = `
        <div class="js-narrow-card-body">
          <div class="js-narrow-card-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
          <div class="js-narrow-card-meta">${meta.join(' · ')}</div>
          ${comment ? `<div class="js-narrow-card-comment" title="${escapeHtml(comment)}">${escapeHtml(comment)}</div>` : ''}
        </div>
      `;
      card.addEventListener('dblclick', () => handleAssetConnect(asset, statusBar));
      list.appendChild(card);
    });
    assets.appendChild(list);

    statusBar.textContent = `${totalAssets} ${t('jsAssetsTotal')}`;
    statusBar.style.color = '';

    // Pagination
    if (totalAssets > 50) {
      const totalPages = Math.ceil(totalAssets / 50);
      const pag = document.createElement('div');
      pag.className = 'js-pagination';
      if (currentPage > 1) {
        const prev = document.createElement('button');
        prev.className = 'js-panel-page-btn';
        prev.textContent = '‹';
        prev.onclick = () => { currentPage--; loadAssetList(); };
        pag.appendChild(prev);
      }
      const info = document.createElement('span');
      info.className = 'js-page-info';
      info.textContent = `${currentPage} / ${totalPages}`;
      pag.appendChild(info);
      if (currentPage < totalPages) {
        const next = document.createElement('button');
        next.className = 'js-panel-page-btn';
        next.textContent = '›';
        next.onclick = () => { currentPage++; loadAssetList(); };
        pag.appendChild(next);
      }
      assets.appendChild(pag);
    }
  };

  // Connect handler
  const handleAssetConnect = async (asset: JumpServerAsset, status: HTMLElement) => {
    status.textContent = t('jsLoadingAccounts');
    try {
      const result = await getAccounts(config.baseUrl, asset.id);
      if (!result.ok || !result.accounts || result.accounts.length === 0) {
        status.textContent = result.error || t('jsNoAccounts');
        status.style.color = 'var(--status-red)';
        return;
      }

      let account: JumpServerAccount | null;
      if (result.accounts.length === 1) {
        account = result.accounts[0];
      } else {
        account = await showAccountPicker(result.accounts, container);
      }
      if (!account) { status.textContent = ''; return; }

      status.style.color = '';
      status.textContent = `${asset.name || asset.address}...`;

      // Directly call connectToAsset (we're in the main window)
      await connectToAsset(config, asset, account);

      status.textContent = `✓ ${asset.name || asset.address}`;
      status.style.color = 'var(--status-green)';
    } catch (err) {
      status.textContent = `Error: ${String(err)}`;
      status.style.color = 'var(--status-red)';
    }
  };

  // Search
  searchInput.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => { currentPage = 1; loadAssetList(); }, 300);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) {
      searchInput.value = '';
      currentPage = 1;
      loadAssetList();
    }
  });

  // Initial load
  loadNodeTree();
  loadAssetList();
  setTimeout(() => searchInput.focus(), 100);
}

// ── Account picker inline ──

function showAccountPicker(accounts: JumpServerAccount[], panelContainer: HTMLElement): Promise<JumpServerAccount | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'js-panel-account-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'js-panel-account-dialog';

    const title = document.createElement('div');
    title.className = 'js-panel-account-title';
    title.textContent = t('jsSelectAccount');
    dialog.appendChild(title);

    const list = document.createElement('div');
    list.className = 'js-panel-account-list';

    accounts.forEach(acc => {
      const item = document.createElement('div');
      item.className = 'js-panel-account-item';
      item.innerHTML = `
        <span class="js-account-username">${escapeHtml(acc.username)}</span>
        <span class="js-account-name">${escapeHtml(acc.name)}</span>
        ${acc.privileged ? '<span class="js-account-badge">root</span>' : ''}
      `;
      item.onclick = () => { overlay.remove(); resolve(acc); };
      list.appendChild(item);
    });
    dialog.appendChild(list);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'js-panel-page-btn';
    cancelBtn.style.marginTop = '8px';
    cancelBtn.style.width = '100%';
    cancelBtn.textContent = t('sshUnsavedCancel');
    cancelBtn.onclick = () => { overlay.remove(); resolve(null); };
    dialog.appendChild(cancelBtn);

    overlay.appendChild(dialog);
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } };
    panelContainer.appendChild(overlay);
  });
}
