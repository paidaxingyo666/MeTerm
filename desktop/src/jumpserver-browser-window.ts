/**
 * jumpserver-browser-window.ts — Standalone JumpServer asset browser window
 *
 * Renders the asset browser UI in a dedicated Tauri window.
 * On asset selection, emits a Tauri event to the main window for SSH connection.
 */

import { loadSettings, resolveIsDark } from './themes';
import { initLanguage, setLanguage, t } from './i18n';
import { escapeHtml } from './status-bar';
import { getCurrentWindow } from '@tauri-apps/api/window';
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
  document.documentElement.style.setProperty('--app-window-opacity', '1');
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

  // Listen for theme changes from settings window
  void listen('settings-changed', () => {
    const updated = loadSettings();
    setLanguage(updated.language);
    document.documentElement.dataset.theme = resolveThemeAttr(updated.colorScheme);
    const nativeTheme = resolveThemeAttr(updated.colorScheme) === 'light' ? 'light' as const : 'dark' as const;
    void getCurrentWindow().setTheme(nativeTheme);
  });
}

// ── Asset browser rendering ──

function renderAssetBrowser(config: JumpServerConfig): void {
  const container = document.createElement('div');
  container.className = 'js-browser-container';

  // Search bar
  const searchBar = document.createElement('div');
  searchBar.className = 'js-asset-search';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'ssh-input';
  searchInput.placeholder = t('jsSearchAssets');
  searchBar.appendChild(searchInput);
  container.appendChild(searchBar);

  // Content: sidebar (nodes) + main (assets)
  const content = document.createElement('div');
  content.className = 'js-asset-content';

  const sidebar = document.createElement('div');
  sidebar.className = 'js-asset-sidebar';
  sidebar.innerHTML = `<div class="js-loading">${t('jsLoading')}</div>`;

  const main = document.createElement('div');
  main.className = 'js-asset-main';
  main.innerHTML = `<div class="js-loading">${t('jsLoading')}</div>`;

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
      sidebar.style.width = `${newWidth}px`;
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

  content.appendChild(sidebar);
  content.appendChild(splitHandle);
  content.appendChild(main);
  container.appendChild(content);

  // Status bar
  const statusBar = document.createElement('div');
  statusBar.className = 'js-asset-status';
  container.appendChild(statusBar);

  document.body.appendChild(container);

  // State
  let selectedNodeId = '';
  let currentAssets: JumpServerAsset[] = [];
  let currentPage = 1;
  let totalAssets = 0;
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;

  // Load nodes
  const loadNodeTree = async () => {
    try {
      const result = await getNodes(config.baseUrl);
      if (!result.ok || !result.nodes) {
        sidebar.innerHTML = `<div class="js-error">${escapeHtml(result.error || 'Failed')}</div>`;
        return;
      }
      renderNodes(result.nodes);
    } catch (err) {
      sidebar.innerHTML = `<div class="js-error">${escapeHtml(String(err))}</div>`;
    }
  };

  const renderNodes = (nodes: JumpServerNode[]) => {
    sidebar.innerHTML = '';

    // Sort nodes by key to ensure proper tree ordering ("0" < "0:1" < "0:1:2" < "0:2")
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

    // Build parent-child lookup: key → has children?
    const keySet = new Set(sorted.map(n => n.key || ''));
    const hasChildren = (key: string) => {
      if (!key) return false;
      for (const k of keySet) {
        if (k !== key && k.startsWith(key + ':')) return true;
      }
      return false;
    };

    // Track expanded state (default: collapsed)
    const expanded = new Set<string>();

    // "All assets" item
    const allItem = document.createElement('div');
    allItem.className = 'js-node-item js-node-selected';
    allItem.style.paddingLeft = '8px';
    allItem.innerHTML = `<span class="js-node-icon">${SVG_LIST}</span><span class="js-node-name">${escapeHtml(t('jsAllAssets'))}</span>`;
    allItem.onclick = () => {
      sidebar.querySelectorAll('.js-node-item').forEach(n => n.classList.remove('js-node-selected'));
      allItem.classList.add('js-node-selected');
      selectedNodeId = '';
      currentPage = 1;
      loadAssetList();
    };
    sidebar.appendChild(allItem);

    // Map of key → DOM element for visibility toggling
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

      // Hide child nodes by default (depth > 0 means it's a child)
      if (depth > 0) {
        item.style.display = 'none';
      }

      // Click on chevron toggles expand/collapse
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

      // Click on node selects it (and expands if parent)
      item.addEventListener('click', () => {
        sidebar.querySelectorAll('.js-node-item').forEach(n => n.classList.remove('js-node-selected'));
        item.classList.add('js-node-selected');
        selectedNodeId = node.id;
        currentPage = 1;
        loadAssetList();
        // Also expand if it's a parent
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

    // Update visibility of child nodes based on expanded state
    const updateNodeVisibility = () => {
      for (const [key, el] of nodeElements) {
        const depth = key.split(':').length - 1;
        if (depth === 0) {
          el.style.display = '';
          continue;
        }
        // Check if all ancestor keys are expanded
        const parts = key.split(':');
        let visible = true;
        for (let i = 1; i < parts.length; i++) {
          const ancestorKey = parts.slice(0, i).join(':');
          if (!expanded.has(ancestorKey)) {
            visible = false;
            break;
          }
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

    const table = document.createElement('table');
    table.className = 'js-asset-table';
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const columns = [t('jsAssetName'), t('jsAssetAddress'), t('jsAssetPlatform'), t('jsAssetComment'), ''];
    columns.forEach((label, i) => {
      const th = document.createElement('th');
      th.textContent = label;
      // Add resize handle on resizable columns (not the last "actions" column)
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

    statusBar.textContent = `${totalAssets} ${t('jsAssetsTotal')}`;
    statusBar.style.color = '';

    // Pagination
    if (totalAssets > 50) {
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
    }
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

  // Account selection dialog
  function showAccountSelection(accounts: JumpServerAccount[]): Promise<JumpServerAccount | null> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'ssh-modal-overlay';
      overlay.style.zIndex = '10003';

      const dialog = document.createElement('div');
      dialog.className = 'ssh-modal';
      dialog.style.maxWidth = '400px';

      const title = document.createElement('h3');
      title.textContent = t('jsSelectAccount');
      title.style.margin = '0 0 12px';
      dialog.appendChild(title);

      const list = document.createElement('div');
      list.className = 'js-account-list';

      accounts.forEach(acc => {
        const item = document.createElement('div');
        item.className = 'js-account-item';
        item.innerHTML = `
          <div class="js-account-info">
            <span class="js-account-username">${escapeHtml(acc.username)}</span>
            <span class="js-account-name">${escapeHtml(acc.name)}</span>
            ${acc.privileged ? '<span class="js-account-badge">root</span>' : ''}
          </div>
        `;
        item.onclick = () => { overlay.remove(); resolve(acc); };
        list.appendChild(item);
      });

      dialog.appendChild(list);

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ssh-btn ssh-btn-secondary';
      cancelBtn.style.marginTop = '12px';
      cancelBtn.textContent = t('sshUnsavedCancel');
      cancelBtn.onclick = () => { overlay.remove(); resolve(null); };
      dialog.appendChild(cancelBtn);

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
