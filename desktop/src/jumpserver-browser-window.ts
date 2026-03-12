/**
 * jumpserver-browser-window.ts — Standalone JumpServer asset browser window
 *
 * Renders the asset browser UI in a dedicated Tauri window.
 * On asset selection, emits a Tauri event to the main window for SSH connection.
 */

import { loadSettings, resolveIsDark } from './themes';
import { initLanguage, setLanguage, t } from './i18n';
import { escapeHtml } from './status-bar';
import { createOverlayScrollbar } from './overlay-scrollbar';
import { getCurrentWindow, LogicalSize, LogicalPosition } from '@tauri-apps/api/window';
import { emit, listen } from '@tauri-apps/api/event';
import {
  type JumpServerConfig,
  type JumpServerAsset,
  type JumpServerNode,
  type JumpServerAccount,
} from './jumpserver-api';

const ua = navigator.userAgent.toLowerCase();
const isWindowsPlatform = ua.includes('windows');

// ── API helpers (use port/token from localStorage) ──

function getApiBase(): { port: number; token: string } {
  return {
    port: Number(localStorage.getItem('meterm-js-browser-port') || '0'),
    token: localStorage.getItem('meterm-js-browser-token') || '',
  };
}

async function fetchJSON<T>(path: string, options?: RequestInit): Promise<T> {
  const { port, token } = getApiBase();
  const url = `http://127.0.0.1:${port}${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...options?.headers,
    },
  });
  return resp.json() as Promise<T>;
}

interface AssetsResult {
  ok: boolean;
  assets?: JumpServerAsset[];
  total?: number;
  error?: string;
}
interface NodesResult {
  ok: boolean;
  nodes?: JumpServerNode[];
  error?: string;
}
interface AccountsResult {
  ok: boolean;
  accounts?: JumpServerAccount[];
  error?: string;
}

async function getAssets(baseUrl: string, options?: {
  search?: string; nodeId?: string; page?: number; pageSize?: number;
}): Promise<AssetsResult> {
  const params = new URLSearchParams({ base_url: baseUrl });
  if (options?.search) params.set('search', options.search);
  if (options?.nodeId) params.set('node_id', options.nodeId);
  if (options?.page) params.set('page', String(options.page));
  if (options?.pageSize) params.set('page_size', String(options.pageSize));
  return fetchJSON<AssetsResult>(`/api/jumpserver/assets?${params.toString()}`);
}

async function getNodes(baseUrl: string): Promise<NodesResult> {
  return fetchJSON<NodesResult>(`/api/jumpserver/nodes?base_url=${encodeURIComponent(baseUrl)}`);
}

async function getAccounts(baseUrl: string, assetId: string): Promise<AccountsResult> {
  const params = new URLSearchParams({ base_url: baseUrl, asset_id: assetId });
  return fetchJSON<AccountsResult>(`/api/jumpserver/accounts?${params.toString()}`);
}

// ── SVG icons ──

const SVG_FOLDER = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1.5 3.5h4.3l1.7 1.5h7v8h-13v-9.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/></svg>`;
const SVG_LIST = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
const SVG_CHEVRON_RIGHT = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3.5 1.5L7 5L3.5 8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const SVG_CHEVRON_DOWN = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 3.5L5 7L8.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const SVG_FILTER = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 3h12L9.5 8.5V12l-3 1.5V8.5L2 3z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/></svg>`;
const SVG_DOCK_IN = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M10 2H3a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 7l5-5M10 2h4v4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
// Snap/dock icon: a window snapping to the right edge
const SVG_SNAP_DOCK = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2" width="13" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2"/><line x1="10" y1="2" x2="10" y2="14" stroke="currentColor" stroke-width="1.2"/><path d="M6 7l2 1.5L6 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
// Expand icon: diagonal arrows pointing outward
const SVG_EXPAND = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M9.5 2H14v4.5M6.5 14H2v-4.5M14 2L9.5 6.5M2 14l4.5-4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
// Shrink icon: diagonal arrows pointing inward
const SVG_SHRINK = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M14 2l-4.5 4.5M10 2.5V6.5H14M2 14l4.5-4.5M6 13.5V9.5H2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 520;

const NARROW_BREAKPOINT = 500;

// Track whether the window is currently in docked mode
let isDocked = false;

// ── Shrink-and-close animation for custom buttons ──
let closeAnimating = false;
function animateShrinkAndClose(win: Awaited<ReturnType<typeof getCurrentWindow>>) {
  if (closeAnimating) return;
  closeAnimating = true;
  const factor = window.devicePixelRatio || 1;

  void (async () => {
    const size = await win.innerSize();
    const pos = await win.outerPosition();
    const fromW = Math.round(size.width / factor);
    const fromH = Math.round(size.height / factor);
    const fromX = pos.x / factor;
    const fromY = pos.y / factor;
    const minW = 100, minH = 60;
    const toX = fromX + (fromW - minW) / 2;
    const toY = fromY + (fromH - minH) / 2;

    const duration = 200;
    const start = performance.now();
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);

    const step = async (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const e = ease(progress);
      await win.setPosition(new LogicalPosition(
        Math.round(fromX + (toX - fromX) * e),
        Math.round(fromY + (toY - fromY) * e),
      ));
      await win.setSize(new LogicalSize(
        Math.round(fromW + (minW - fromW) * e),
        Math.round(fromH + (minH - fromH) * e),
      ));
      if (progress < 1) {
        requestAnimationFrame(t => { void step(t); });
      } else {
        // Hide immediately then close — no onCloseRequested intercept needed
        await win.hide();
        closeAnimating = false;
        void win.close();
      }
    };
    requestAnimationFrame(t => { void step(t); });
  })();
}

// ── Theme ──

function resolveThemeAttr(colorScheme: string): string {
  if (colorScheme === 'darker') return 'darker';
  if (colorScheme === 'navy') return 'navy';
  if (colorScheme === 'light') return 'light';
  if (colorScheme === 'auto') return resolveIsDark('auto') ? 'dark' : 'light';
  return 'dark';
}

// ── Custom title bar (Windows) ──

function createCustomTitleBar(titleText: string): HTMLElement {
  const titleBar = document.createElement('div');
  titleBar.className = 'settings-titlebar';

  const dragRegion = document.createElement('div');
  dragRegion.className = 'settings-titlebar-drag';
  dragRegion.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    void getCurrentWindow().startDragging();
  });

  const title = document.createElement('span');
  title.className = 'settings-titlebar-title';
  title.textContent = titleText;
  dragRegion.appendChild(title);
  titleBar.appendChild(dragRegion);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'settings-titlebar-close';
  closeBtn.type = 'button';
  closeBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1 9 9M9 1 1 9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  closeBtn.onclick = () => { void getCurrentWindow().close(); };
  titleBar.appendChild(closeBtn);

  return titleBar;
}

// ── Main initialization ──

export function initJumpServerBrowserWindow(): void {
  initLanguage();
  const settings = loadSettings();
  setLanguage(settings.language);
  document.documentElement.dataset.theme = resolveThemeAttr(settings.colorScheme);
  // Apply same opacity as main window
  const opacityVal = Math.max(20, Math.min(100, settings.opacity ?? 100)) / 100;
  document.documentElement.style.setProperty('--app-window-opacity', `${opacityVal}`);
  // Clear all anti-flash backgrounds set by index.html to allow true transparency
  document.documentElement.style.removeProperty('background-color');
  document.body.style.backgroundColor = 'transparent';
  // Remove the injected <style>body{background:...}</style> from index.html anti-flash script
  document.querySelectorAll('style').forEach(el => {
    if (el.textContent && /^body\s*\{background:/.test(el.textContent)) el.remove();
  });
  document.documentElement.classList.toggle('platform-windows', isWindowsPlatform);

  // Hide main app UI
  const app = document.getElementById('app');
  if (app) app.style.display = 'none';

  document.body.classList.add('js-browser-window-mode');

  // Title bar
  if (isWindowsPlatform) {
    document.body.appendChild(createCustomTitleBar('JumpServer'));
  } else {
    const dragRegion = document.createElement('div');
    dragRegion.className = 'overlay-drag-region';
    dragRegion.setAttribute('data-tauri-drag-region', '');
    document.body.appendChild(dragRegion);
  }

  // Read config from localStorage
  const configJson = localStorage.getItem('meterm-js-browser-config');
  if (!configJson) {
    document.body.innerHTML += '<p style="padding:20px;color:var(--text-secondary);">No JumpServer config found.</p>';
    return;
  }
  const config: JumpServerConfig = JSON.parse(configJson);

  renderAssetBrowser(config);

  // Listen for theme/opacity changes from settings window
  void listen('settings-changed', () => {
    const updated = loadSettings();
    setLanguage(updated.language);
    document.documentElement.dataset.theme = resolveThemeAttr(updated.colorScheme);
    const nativeTheme = resolveThemeAttr(updated.colorScheme) === 'light' ? 'light' as const : 'dark' as const;
    void getCurrentWindow().setTheme(nativeTheme);
    // Sync opacity
    const newOpacity = Math.max(20, Math.min(100, updated.opacity ?? 100)) / 100;
    document.documentElement.style.setProperty('--app-window-opacity', `${newOpacity}`);
  });
}

// ── Asset browser rendering ──

function renderAssetBrowser(config: JumpServerConfig): void {
  const container = document.createElement('div');
  container.className = 'js-browser-container';

  // Search bar (with filter button slot for narrow mode)
  const searchBar = document.createElement('div');
  searchBar.className = 'js-asset-search';

  const filterBtn = document.createElement('button');
  filterBtn.className = 'js-narrow-filter-btn';
  filterBtn.innerHTML = SVG_FILTER;
  filterBtn.title = t('jsAllAssets');
  searchBar.appendChild(filterBtn);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'ssh-input';
  searchInput.placeholder = t('jsSearchAssets');
  searchBar.appendChild(searchInput);

  // "Expand/Shrink" button — smart resize relative to default size
  const expandBtn = document.createElement('button');
  expandBtn.className = 'js-narrow-filter-btn';
  expandBtn.innerHTML = SVG_EXPAND;
  expandBtn.title = 'Expand';
  expandBtn.style.display = 'flex';

  let snapDockBtnRef: HTMLButtonElement | null = null;
  let dockInBtnRef: HTMLButtonElement | null = null;

  const updateButtonStates = async () => {
    const win = getCurrentWindow();
    const factor = window.devicePixelRatio || 1;
    const size = await win.innerSize();
    const w = Math.round(size.width / factor);
    const h = Math.round(size.height / factor);
    const isDefault = Math.abs(w - DEFAULT_WIDTH) <= 5 && Math.abs(h - DEFAULT_HEIGHT) <= 5;
    const isLarger = w > DEFAULT_WIDTH + 5 || h > DEFAULT_HEIGHT + 5;

    // Expand/shrink: hidden at default size or when docked
    expandBtn.style.display = (isDefault || isDocked) ? 'none' : 'flex';
    expandBtn.innerHTML = isLarger ? SVG_SHRINK : SVG_EXPAND;
    expandBtn.title = isLarger ? 'Shrink' : 'Expand';

    // Snap dock: hidden when docked
    if (snapDockBtnRef) snapDockBtnRef.style.display = isDocked ? 'none' : 'flex';

    // Dock-in (back to main): always visible
    if (dockInBtnRef) dockInBtnRef.style.display = 'flex';
  };

  // Animated window resize: easeOutCubic over ~250ms
  let animating = false;
  const animateResize = (
    fromX: number, fromY: number, fromW: number, fromH: number,
    toX: number, toY: number, toW: number, toH: number,
    onComplete?: () => void,
  ) => {
    if (animating) return;
    animating = true;
    const win = getCurrentWindow();
    const duration = 250;
    const start = performance.now();
    const ease = (t: number) => 1 - Math.pow(1 - t, 3); // easeOutCubic

    const step = async (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const e = ease(progress);

      const curW = Math.round(fromW + (toW - fromW) * e);
      const curH = Math.round(fromH + (toH - fromH) * e);
      const curX = Math.round(fromX + (toX - fromX) * e);
      const curY = Math.round(fromY + (toY - fromY) * e);

      await win.setPosition(new LogicalPosition(curX, curY));
      await win.setSize(new LogicalSize(curW, curH));

      if (progress < 1) {
        requestAnimationFrame(t => { void step(t); });
      } else {
        animating = false;
        void updateButtonStates();
        onComplete?.();
      }
    };
    requestAnimationFrame(t => { void step(t); });
  };

  expandBtn.addEventListener('click', async () => {
    if (animating) return;
    const win = getCurrentWindow();
    const factor = window.devicePixelRatio || 1;
    const size = await win.innerSize();
    const w = Math.round(size.width / factor);
    const h = Math.round(size.height / factor);

    // Already at default size (within tolerance) — do nothing
    if (Math.abs(w - DEFAULT_WIDTH) <= 5 && Math.abs(h - DEFAULT_HEIGHT) <= 5) return;

    const pos = await win.outerPosition();
    const px = pos.x / factor;
    const py = pos.y / factor;

    const toX = Math.max(0, Math.round(px - (DEFAULT_WIDTH - w) / 2));
    const toY = Math.max(0, Math.round(py - (DEFAULT_HEIGHT - h) / 2));

    void animateResize(px, py, w, h, toX, toY, DEFAULT_WIDTH, DEFAULT_HEIGHT);
  });

  // Update icon when window is resized
  void getCurrentWindow().listen('tauri://resize', () => { void updateButtonStates(); });
  void updateButtonStates();
  searchBar.appendChild(expandBtn);

  // "Snap dock" button — snap browser window to main window's right edge
  const snapDockBtn = document.createElement('button');
  snapDockBtnRef = snapDockBtn;
  snapDockBtn.className = 'js-narrow-filter-btn js-snap-dock-btn';
  snapDockBtn.innerHTML = SVG_SNAP_DOCK;
  snapDockBtn.title = 'Snap to main window';
  snapDockBtn.style.display = 'flex';
  snapDockBtn.addEventListener('click', () => {
    if (animating) return;
    void emit('jumpserver-snap-dock', { configName: config.name });
  });
  searchBar.appendChild(snapDockBtn);

  // Listen for snap target from main window — animate to docked position
  void listen<{ x: number; y: number; w: number; h: number }>('jumpserver-snap-target', async (event) => {
    if (animating) return;
    const { x: toX, y: toY, w: toW, h: toH } = event.payload;
    const win = getCurrentWindow();
    const factor = window.devicePixelRatio || 1;
    const size = await win.innerSize();
    const pos = await win.outerPosition();
    const fromW = Math.round(size.width / factor);
    const fromH = Math.round(size.height / factor);
    const fromX = pos.x / factor;
    const fromY = pos.y / factor;
    void animateResize(fromX, fromY, fromW, fromH, toX, toY, toW, toH);
  });

  // Listen for dock/undock state changes from main window
  void listen('jumpserver-docked', () => {
    isDocked = true;
    void updateButtonStates();
  });
  void listen('jumpserver-undocked', () => {
    isDocked = false;
    void updateButtonStates();
  });

  // "Back to main window" button — close popup, open side panel in main window
  const dockInBtn = document.createElement('button');
  dockInBtnRef = dockInBtn;
  dockInBtn.className = 'js-narrow-filter-btn js-dock-in-btn';
  dockInBtn.innerHTML = SVG_DOCK_IN;
  dockInBtn.title = 'Back to main window';
  dockInBtn.style.display = 'flex';
  dockInBtn.addEventListener('click', () => {
    if (animating || closeAnimating) return;
    void emit('jumpserver-dock-to-panel', { configName: config.name });
    animateShrinkAndClose(getCurrentWindow());
  });
  searchBar.appendChild(dockInBtn);

  container.appendChild(searchBar);

  // Floating node dropdown (narrow mode)
  const nodeDropdown = document.createElement('div');
  nodeDropdown.className = 'js-narrow-node-dropdown';
  container.appendChild(nodeDropdown);

  // Content: sidebar (nodes) + main (assets)
  const content = document.createElement('div');
  content.className = 'js-asset-content';

  const sidebarWrap = document.createElement('div');
  sidebarWrap.className = 'js-asset-sidebar-wrap';
  const sidebar = document.createElement('div');
  sidebar.className = 'js-asset-sidebar';
  sidebar.innerHTML = `<div class="js-loading">${t('jsLoading')}</div>`;
  sidebarWrap.appendChild(sidebar);

  const mainWrap = document.createElement('div');
  mainWrap.className = 'js-asset-main-wrap';
  const main = document.createElement('div');
  main.className = 'js-asset-main';
  main.innerHTML = `<div class="js-loading">${t('jsLoading')}</div>`;
  mainWrap.appendChild(main);

  // Resizable split handle
  const splitHandle = document.createElement('div');
  splitHandle.className = 'js-split-handle';
  let dragging = false;
  splitHandle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    splitHandle.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: PointerEvent) => {
      if (!dragging) return;
      const rect = content.getBoundingClientRect();
      const newWidth = Math.max(120, Math.min(ev.clientX - rect.left, rect.width - 200));
      sidebarWrap.style.width = `${newWidth}px`;
    };
    const onUp = () => {
      dragging = false;
      document.body.style.cursor = '';
      splitHandle.removeEventListener('pointermove', onMove);
      splitHandle.removeEventListener('pointerup', onUp);
    };
    splitHandle.addEventListener('pointermove', onMove);
    splitHandle.addEventListener('pointerup', onUp);
  });

  content.appendChild(sidebarWrap);
  content.appendChild(splitHandle);
  content.appendChild(mainWrap);
  container.appendChild(content);

  // Attach overlay scrollbars (container = wrapper, not viewport)
  createOverlayScrollbar({ viewport: sidebar, container: sidebarWrap });
  createOverlayScrollbar({ viewport: main, container: mainWrap });

  // Status bar
  const statusBar = document.createElement('div');
  statusBar.className = 'js-asset-status';
  container.appendChild(statusBar);

  document.body.appendChild(container);

  // State
  let selectedNodeId = '';
  let selectedNodeName = t('jsAllAssets');
  let currentAssets: JumpServerAsset[] = [];
  let currentPage = 1;
  let totalAssets = 0;
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  let isNarrow = false;

  // Responsive: detect narrow mode via ResizeObserver
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const w = entry.contentRect.width;
      const wasNarrow = isNarrow;
      isNarrow = w < NARROW_BREAKPOINT;
      if (wasNarrow !== isNarrow) {
        container.classList.toggle('js-narrow', isNarrow);
        // Re-render asset list to switch between table/cards
        renderAssetList();
      }
    }
  });
  ro.observe(container);

  // Filter button toggles floating node dropdown
  let dropdownOpen = false;
  filterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdownOpen = !dropdownOpen;
    nodeDropdown.classList.toggle('js-dropdown-open', dropdownOpen);
    filterBtn.classList.toggle('active', dropdownOpen);
  });
  // Close dropdown on outside click
  document.addEventListener('click', () => {
    if (dropdownOpen) {
      dropdownOpen = false;
      nodeDropdown.classList.remove('js-dropdown-open');
      filterBtn.classList.remove('active');
    }
  });
  nodeDropdown.addEventListener('click', (e) => e.stopPropagation());

  // Node selection handler (shared between sidebar and dropdown)
  const selectNode = (nodeId: string, nodeName: string) => {
    selectedNodeId = nodeId;
    selectedNodeName = nodeName;
    currentPage = 1;
    // Update filter button label in narrow mode
    filterBtn.title = nodeName;
    loadAssetList();
    // Close dropdown
    dropdownOpen = false;
    nodeDropdown.classList.remove('js-dropdown-open');
    filterBtn.classList.remove('active');
  };

  // Load nodes
  const loadNodeTree = async () => {
    try {
      const result = await getNodes(config.baseUrl);
      if (!result.ok || !result.nodes) {
        sidebar.innerHTML = `<div class="js-error">${escapeHtml(result.error || 'Failed')}</div>`;
        return;
      }
      renderNodes(result.nodes);
      renderNodeDropdown(result.nodes);
    } catch (err) {
      sidebar.innerHTML = `<div class="js-error">${escapeHtml(String(err))}</div>`;
    }
  };

  // Render sidebar node tree (wide mode)
  const renderNodes = (nodes: JumpServerNode[]) => {
    sidebar.innerHTML = '';

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
      if (!key) return false;
      for (const k of keySet) {
        if (k !== key && k.startsWith(key + ':')) return true;
      }
      return false;
    };

    const expanded = new Set<string>();

    // "All assets" item
    const allItem = document.createElement('div');
    allItem.className = 'js-node-item js-node-selected';
    allItem.style.paddingLeft = '8px';
    allItem.innerHTML = `<span class="js-node-icon">${SVG_LIST}</span><span class="js-node-name">${escapeHtml(t('jsAllAssets'))}</span>`;
    allItem.onclick = () => {
      sidebar.querySelectorAll('.js-node-item').forEach(n => n.classList.remove('js-node-selected'));
      allItem.classList.add('js-node-selected');
      selectNode('', t('jsAllAssets'));
    };
    sidebar.appendChild(allItem);

    const nodeElements = new Map<string, HTMLElement>();

    sorted.forEach(node => {
      const key = node.key || '';
      const depth = key.split(':').length - 1;
      const isParent = hasChildren(key);

      const item = document.createElement('div');
      item.className = 'js-node-item';
      item.style.paddingLeft = `${8 + depth * 16}px`;
      item.dataset.nodeKey = key;

      const chevron = isParent
        ? `<span class="js-node-chevron">${SVG_CHEVRON_RIGHT}</span>`
        : `<span class="js-node-chevron-spacer"></span>`;

      item.innerHTML = `
        ${chevron}
        <span class="js-node-icon">${SVG_FOLDER}</span>
        <span class="js-node-name">${escapeHtml(node.name)}</span>
        ${node.assets_amount ? `<span class="js-node-count">${node.assets_amount}</span>` : ''}
      `;

      if (depth > 0) item.style.display = 'none';

      if (isParent) {
        const chevronEl = item.querySelector('.js-node-chevron')!;
        chevronEl.addEventListener('click', (e) => {
          e.stopPropagation();
          if (expanded.has(key)) {
            expanded.delete(key);
            chevronEl.innerHTML = SVG_CHEVRON_RIGHT;
          } else {
            expanded.add(key);
            chevronEl.innerHTML = SVG_CHEVRON_DOWN;
          }
          updateNodeVisibility();
        });
      }

      item.addEventListener('click', () => {
        sidebar.querySelectorAll('.js-node-item').forEach(n => n.classList.remove('js-node-selected'));
        item.classList.add('js-node-selected');
        selectNode(node.id, node.name);
        if (isParent && !expanded.has(key)) {
          expanded.add(key);
          const chevronEl = item.querySelector('.js-node-chevron');
          if (chevronEl) chevronEl.innerHTML = SVG_CHEVRON_DOWN;
          updateNodeVisibility();
        }
      });

      nodeElements.set(key, item);
      sidebar.appendChild(item);
    });

    const updateNodeVisibility = () => {
      for (const [key, el] of nodeElements) {
        const depth = key.split(':').length - 1;
        if (depth === 0) { el.style.display = ''; continue; }
        const parts = key.split(':');
        let visible = true;
        for (let i = 1; i < parts.length; i++) {
          if (!expanded.has(parts.slice(0, i).join(':'))) { visible = false; break; }
        }
        el.style.display = visible ? '' : 'none';
      }
    };
  };

  // Render floating node dropdown (narrow mode)
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
    main.innerHTML = `<div class="js-loading">${t('jsLoading')}</div>`;
    try {
      const result = await getAssets(config.baseUrl, {
        search: searchInput.value.trim() || undefined,
        nodeId: selectedNodeId || undefined,
        page: currentPage,
        pageSize: 50,
      });
      if (!result.ok || !result.assets) {
        main.innerHTML = `<div class="js-error">${escapeHtml(result.error || 'Failed')}</div>`;
        return;
      }
      currentAssets = result.assets;
      totalAssets = result.total || result.assets.length;
      renderAssetList();
    } catch (err) {
      main.innerHTML = `<div class="js-error">${escapeHtml(String(err))}</div>`;
    }
  };

  const renderAssetList = () => {
    main.innerHTML = '';
    if (currentAssets.length === 0) {
      main.innerHTML = `<div class="js-empty">${t('jsNoAssets')}</div>`;
      statusBar.textContent = t('jsNoAssets');
      return;
    }

    if (isNarrow) {
      renderAssetCards();
    } else {
      renderAssetTable();
    }

    statusBar.textContent = `${totalAssets} ${t('jsAssetsTotal')}`;
    statusBar.style.color = '';
    renderPagination();
  };

  // Wide mode: table view
  const renderAssetTable = () => {
    const table = document.createElement('table');
    table.className = 'js-asset-table';
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const columns = [t('jsAssetName'), t('jsAssetAddress'), t('jsAssetPlatform'), t('jsAssetComment'), ''];
    columns.forEach((label, i) => {
      const th = document.createElement('th');
      th.textContent = label;
      if (i < columns.length - 1) {
        const handle = document.createElement('div');
        handle.className = 'js-col-resize';
        handle.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          handle.classList.add('active');
          handle.setPointerCapture(e.pointerId);
          const startX = e.clientX;
          const startWidth = th.offsetWidth;
          const onMove = (ev: PointerEvent) => {
            const delta = ev.clientX - startX;
            const newWidth = Math.max(40, startWidth + delta);
            th.style.width = `${newWidth}px`;
          };
          const onUp = () => {
            handle.classList.remove('active');
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
          };
          handle.addEventListener('pointermove', onMove);
          handle.addEventListener('pointerup', onUp);
        });
        th.appendChild(handle);
      }
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    currentAssets.forEach(asset => {
      const tr = document.createElement('tr');
      tr.className = 'js-asset-row';
      const assetName = asset.name || asset.address;
      const assetAddr = asset.address;
      const assetPlatform = asset.platform?.name || '-';
      const assetComment = asset.comment || '';
      tr.innerHTML = `
        <td title="${escapeHtml(assetName)}"><span class="js-cell-ellipsis">${escapeHtml(assetName)}</span></td>
        <td title="${escapeHtml(assetAddr)}"><span class="js-cell-ellipsis">${escapeHtml(assetAddr)}</span></td>
        <td title="${escapeHtml(assetPlatform)}"><span class="js-cell-ellipsis">${escapeHtml(assetPlatform)}</span></td>
        <td title="${escapeHtml(assetComment)}"><span class="js-cell-ellipsis">${escapeHtml(assetComment)}</span></td>
        <td class="js-connect-cell"><button class="ssh-btn ssh-btn-primary js-connect-btn">${t('jsConnect')}</button></td>
      `;
      tr.querySelector('.js-connect-btn')!.addEventListener('click', (e) => {
        e.stopPropagation();
        handleAssetConnect(asset);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    main.appendChild(table);
  };

  // Narrow mode: card view
  const renderAssetCards = () => {
    const cardList = document.createElement('div');
    cardList.className = 'js-narrow-card-list';

    // Show selected node label
    if (selectedNodeName && selectedNodeName !== t('jsAllAssets')) {
      const nodeLabel = document.createElement('div');
      nodeLabel.className = 'js-narrow-node-label';
      nodeLabel.innerHTML = `${SVG_FOLDER} <span>${escapeHtml(selectedNodeName)}</span>`;
      cardList.appendChild(nodeLabel);
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
      card.addEventListener('dblclick', () => handleAssetConnect(asset));
      cardList.appendChild(card);
    });
    main.appendChild(cardList);
  };

  // Pagination (shared)
  const renderPagination = () => {
    if (totalAssets <= 50) return;
    const totalPages = Math.ceil(totalAssets / 50);
    const pagination = document.createElement('div');
    pagination.className = 'js-pagination';
    if (currentPage > 1) {
      const prev = document.createElement('button');
      prev.className = 'ssh-btn ssh-btn-secondary';
      prev.textContent = '‹';
      prev.onclick = () => { currentPage--; loadAssetList(); };
      pagination.appendChild(prev);
    }
    const info = document.createElement('span');
    info.className = 'js-page-info';
    info.textContent = `${currentPage} / ${totalPages}`;
    pagination.appendChild(info);
    if (currentPage < totalPages) {
      const next = document.createElement('button');
      next.className = 'ssh-btn ssh-btn-secondary';
      next.textContent = '›';
      next.onclick = () => { currentPage++; loadAssetList(); };
      pagination.appendChild(next);
    }
    main.appendChild(pagination);
  };

  // Handle asset connect
  const handleAssetConnect = async (asset: JumpServerAsset) => {
    statusBar.textContent = t('jsLoadingAccounts');
    try {
      const result = await getAccounts(config.baseUrl, asset.id);
      if (!result.ok || !result.accounts || result.accounts.length === 0) {
        statusBar.textContent = result.error || t('jsNoAccounts');
        statusBar.style.color = 'var(--status-red)';
        return;
      }

      let account: JumpServerAccount | null;
      if (result.accounts.length === 1) {
        account = result.accounts[0];
      } else {
        account = await showAccountSelection(result.accounts);
      }
      if (!account) return;

      statusBar.style.color = '';
      statusBar.textContent = `Connecting to ${asset.name || asset.address}...`;

      // Emit event to main window for SSH connection
      await emit('jumpserver-connect-asset', {
        configName: config.name,
        asset: { id: asset.id, name: asset.name, address: asset.address, platform: asset.platform, protocols: asset.protocols },
        account: { id: account.id, name: account.name, username: account.username, privileged: account.privileged },
      });

      statusBar.textContent = `Connected: ${asset.name || asset.address}`;
      statusBar.style.color = 'var(--status-green)';
    } catch (err) {
      statusBar.textContent = `Error: ${String(err)}`;
      statusBar.style.color = 'var(--status-red)';
    }
  };

  // Account selection dialog — adaptive to window width
  function showAccountSelection(accounts: JumpServerAccount[]): Promise<JumpServerAccount | null> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'js-account-overlay';

      const dialog = document.createElement('div');
      dialog.className = 'js-account-dialog';

      const title = document.createElement('div');
      title.className = 'js-account-dialog-title';
      title.textContent = t('jsSelectAccount');
      dialog.appendChild(title);

      const list = document.createElement('div');
      list.className = 'js-account-list';

      accounts.forEach(acc => {
        const item = document.createElement('div');
        item.className = 'js-account-item';
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
      cancelBtn.className = 'js-account-cancel-btn';
      cancelBtn.textContent = t('sshUnsavedCancel');
      cancelBtn.onclick = () => { overlay.remove(); resolve(null); };
      dialog.appendChild(cancelBtn);

      overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } };
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
    });
  }

  // Search handler
  searchInput.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      currentPage = 1;
      loadAssetList();
    }, 300);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (searchInput.value) {
        searchInput.value = '';
        currentPage = 1;
        loadAssetList();
      }
    }
  });

  // Initial load
  loadNodeTree();
  loadAssetList();
  setTimeout(() => searchInput.focus(), 100);
}
