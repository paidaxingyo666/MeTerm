/**
 * Home Dashboard — Left panel: connection buttons, recent activity,
 * connection groups, context menus, group modals, drag reorder.
 * Extracted from home-dashboard.ts for code size control.
 */
import { t } from './i18n';
import { icon } from './icons';
import { createOverlayScrollbar } from './overlay-scrollbar';
import {
  type SSHConnectionConfig,
  loadSavedConnections,
  loadRecentConnections,
  removeRecentConnection,
  showSSHModal,
  removeConnection as removeSSHConnection,
  getSSHConnectHandler,
} from './ssh';
import {
  type RemoteServerInfo,
  loadSavedRemoteConnections,
  loadRecentRemoteConnections,
  removeRecentRemoteConnection,
  showRemoteEditDialog,
  showRemoteCardSessionPopup,
  removeRemoteConnection,
} from './remote';
import {
  type JumpServerConfig,
  loadJumpServerConfigs,
  removeJumpServerConfig,
  loadJSSecrets,
} from './jumpserver-api';
import {
  loadGroupMap,
  loadGroupOrder,
  sshKey,
  remoteKey,
  jumpserverKey,
  createGroup,
  renameGroup,
  deleteGroup,
  setConnectionGroup,
  removeConnectionGroup,
  loadGroupColors,
  setGroupColor,
  removeGroupColor,
  loadGroupCollapsed,
  toggleGroupCollapsed,
  duplicateGroup,
  type ConnectionGroupMap,
  getJSAssetHistoryByFrequency,
  type JSAssetHistoryEntry,
} from './connection-groups';

// ─── Types ───

export interface ConnectionItem {
  type: 'ssh' | 'remote' | 'jumpserver';
  key: string;
  name: string;
  detail: string;
  raw: SSHConnectionConfig | RemoteServerInfo | JumpServerConfig;
}

const GROUP_COLORS = ['#3b82f6', '#22c55e', '#eab308', '#ef4444', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#78716c'];

// Card display order (includes both named groups and __type:* entries)
const CARD_ORDER_KEY = 'meterm-card-display-order';
function loadCardOrder(): string[] {
  try {
    const raw = localStorage.getItem(CARD_ORDER_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}
function saveCardOrder(order: string[]): void {
  localStorage.setItem(CARD_ORDER_KEY, JSON.stringify(order));
}

// ─── Collect & filter ───

export function collectAllConnections(): ConnectionItem[] {
  const items: ConnectionItem[] = [];
  for (const c of loadSavedConnections()) {
    items.push({ type: 'ssh', key: sshKey(c.name), name: c.name || c.host, detail: `${c.username}@${c.host}:${c.port}`, raw: c });
  }
  for (const r of loadSavedRemoteConnections()) {
    items.push({ type: 'remote', key: remoteKey(r.host, r.port), name: r.name || r.host, detail: `${r.host}:${r.port}`, raw: r });
  }
  for (const j of loadJumpServerConfigs()) {
    items.push({ type: 'jumpserver', key: jumpserverKey(j.name), name: j.name, detail: `${j.username}@${j.sshHost}:${j.sshPort}`, raw: j });
  }
  return items;
}

export function filterConnections(items: ConnectionItem[], query: string): ConnectionItem[] {
  if (!query) return items;
  const q = query.toLowerCase();
  return items.filter((i) => i.name.toLowerCase().includes(q) || i.detail.toLowerCase().includes(q));
}

// ─── Recent Activity (horizontal cards) ───

export function renderRecentActivity(query: string): void {
  const section = document.getElementById('home-recent-activity');
  if (!section) return;
  section.innerHTML = '';

  const recentSSH = loadRecentConnections();
  const recentRemote = loadRecentRemoteConnections();

  let recentItems: ConnectionItem[] = [];
  for (const c of recentSSH) {
    recentItems.push({ type: 'ssh', key: sshKey(c.name), name: c.name || c.host, detail: `${c.username}@${c.host}`, raw: c });
  }
  for (const r of recentRemote) {
    recentItems.push({ type: 'remote', key: remoteKey(r.host, r.port), name: r.name || r.host, detail: `${r.host}:${r.port}`, raw: r });
  }

  if (query) recentItems = filterConnections(recentItems, query);

  if (recentItems.length === 0) return;

  const title = document.createElement('div');
  title.className = 'home-dash-section-title';
  title.textContent = t('homeRecentActivity');
  section.appendChild(title);

  const track = document.createElement('div');
  track.className = 'home-dash-recent-track';

  for (const item of recentItems) {
    const card = document.createElement('div');
    card.className = `home-dash-recent-card home-dash-recent-${item.type}`;
    const iconName = item.type === 'ssh' ? 'ssh' : item.type === 'remote' ? 'remote' : item.type === 'jumpserver' ? 'jumpserver' : 'terminal';
    card.innerHTML = `<span class="home-dash-recent-icon">${icon(iconName)}</span><div class="home-dash-recent-info"><div class="home-dash-recent-name">${escapeHtml(item.name)}</div><div class="home-dash-recent-detail">${escapeHtml(item.detail)}</div></div>`;

    const delBtn = document.createElement('button');
    delBtn.className = 'home-dash-recent-del';
    delBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    delBtn.onclick = (e) => {
      e.stopPropagation();
      if (item.type === 'ssh') {
        const c = item.raw as SSHConnectionConfig;
        removeRecentConnection(c.host, c.port ?? 22, c.username);
      } else if (item.type === 'remote') {
        const r = item.raw as RemoteServerInfo;
        removeRecentRemoteConnection(r.host, r.port);
      }
      renderRecentActivity(query);
    };
    card.appendChild(delBtn);

    card.onclick = () => handleConnectionClick(item);
    track.appendChild(card);
  }
  section.appendChild(track);
  setupScrollFade(track);
}

/** Add/remove fade-left / fade-right / fade-both classes based on scroll position */
function setupScrollFade(el: HTMLElement): void {
  const update = () => {
    const canLeft = el.scrollLeft > 1;
    const canRight = el.scrollWidth - el.clientWidth - el.scrollLeft > 1;
    el.classList.remove('fade-left', 'fade-right', 'fade-both');
    if (canLeft && canRight) el.classList.add('fade-both');
    else if (canRight) el.classList.add('fade-right');
    else if (canLeft) el.classList.add('fade-left');
  };
  el.addEventListener('scroll', update, { passive: true });
  requestAnimationFrame(update);
}

// ─── Connection Groups Section ───

/** refreshView callback is injected to avoid circular imports */
export function renderGroupsSection(query: string, refreshView: () => void): void {
  const section = document.getElementById('home-groups-section');
  if (!section) return;
  section.innerHTML = '';

  const allItems = collectAllConnections();
  const filteredItems = filterConnections(allItems, query);
  const groupMap = loadGroupMap();
  const groupOrder = loadGroupOrder();
  const groupColors = loadGroupColors();
  const collapsedSet = loadGroupCollapsed();

  const grouped = new Map<string, ConnectionItem[]>();
  const ungrouped: ConnectionItem[] = [];

  for (const item of filteredItems) {
    const groupName = groupMap[item.key];
    if (groupName) {
      if (!grouped.has(groupName)) grouped.set(groupName, []);
      grouped.get(groupName)!.push(item);
    } else {
      ungrouped.push(item);
    }
  }

  // Title row with "New Group" button
  const titleRow = document.createElement('div');
  titleRow.className = 'home-dash-section-title-row';

  const titleText = document.createElement('div');
  titleText.className = 'home-dash-section-title';
  titleText.textContent = t('homeSavedConnections');
  titleRow.appendChild(titleText);

  const newGroupBtn = document.createElement('button');
  newGroupBtn.className = 'home-dash-new-group-btn';
  newGroupBtn.textContent = '+ ' + t('homeGroupNew');
  newGroupBtn.onclick = () => {
    showGroupModal('', '', (name, color) => {
      createGroup(name);
      if (color) setGroupColor(name, color);
      refreshView();
    });
  };
  titleRow.appendChild(newGroupBtn);
  section.appendChild(titleRow);

  if (filteredItems.length === 0 && !query) {
    const empty = document.createElement('div');
    empty.className = 'home-dash-empty';
    empty.textContent = t('homeNoConnections');
    section.appendChild(empty);
    return;
  }

  const groupsGrid = document.createElement('div');
  groupsGrid.className = 'home-dash-groups-grid';

  let dragSrc: HTMLElement | null = null;

  // Build all cards: named groups + type groups
  const namedCards = new Map<string, HTMLDivElement>();
  for (const groupName of groupOrder) {
    const items = grouped.get(groupName) || [];
    if (items.length === 0 && query) continue;
    namedCards.set(groupName, createGroupCard(groupName, items, groupMap, refreshView, groupColors[groupName], collapsedSet.has(groupName)));
  }

  const ungroupedSSH = ungrouped.filter((i) => i.type === 'ssh');
  const ungroupedRemote = ungrouped.filter((i) => i.type === 'remote');
  const ungroupedJumpserver = ungrouped.filter((i) => i.type === 'jumpserver');
  const typeCardMap = new Map<string, HTMLDivElement>();
  if (ungroupedSSH.length > 0) typeCardMap.set('__type:ssh', createTypeGroupCard('ssh', ungroupedSSH, groupMap, refreshView));
  if (ungroupedRemote.length > 0) typeCardMap.set('__type:remote', createTypeGroupCard('remote', ungroupedRemote, groupMap, refreshView));
  if (ungroupedJumpserver.length > 0) typeCardMap.set('__type:jumpserver', createTypeGroupCard('jumpserver', ungroupedJumpserver, groupMap, refreshView));

  // Determine render order using saved card order
  const savedCardOrder = loadCardOrder();
  const allCardKeys = new Set([...namedCards.keys(), ...typeCardMap.keys()]);
  const orderedKeys: string[] = [];

  // First: keys in saved order that still exist
  for (const key of savedCardOrder) {
    if (allCardKeys.has(key)) {
      orderedKeys.push(key);
      allCardKeys.delete(key);
    }
  }
  // Then: remaining keys not in saved order (named groups first, then type groups)
  for (const key of namedCards.keys()) {
    if (allCardKeys.has(key)) { orderedKeys.push(key); allCardKeys.delete(key); }
  }
  for (const key of typeCardMap.keys()) {
    if (allCardKeys.has(key)) { orderedKeys.push(key); }
  }

  // Render in order and bind drag reorder
  for (const key of orderedKeys) {
    const card = namedCards.get(key) || typeCardMap.get(key);
    if (!card) continue;
    setupDragReorder(card, key, groupsGrid, () => dragSrc, (v) => { dragSrc = v; }, refreshView);
    groupsGrid.appendChild(card);
  }

  section.appendChild(groupsGrid);
  setupScrollFade(groupsGrid);
}

// ─── Group card ───

function createGroupCard(
  groupName: string | null, items: ConnectionItem[],
  groupMap: ConnectionGroupMap, refreshView: () => void,
  color?: string, collapsed?: boolean,
): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'home-dash-group-card';
  card.dataset.groupName = groupName || '';

  if (color) {
    card.setAttribute('data-color', color);
    card.style.setProperty('--group-color', color);
  }
  if (collapsed) card.classList.add('collapsed');

  const header = document.createElement('div');
  header.className = 'home-dash-group-header';

  const chevron = document.createElement('span');
  chevron.className = 'home-dash-group-chevron';
  chevron.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  chevron.onclick = (e) => {
    e.stopPropagation();
    if (groupName) {
      toggleGroupCollapsed(groupName);
      card.classList.toggle('collapsed');
    }
  };
  header.appendChild(chevron);

  const iconSpan = document.createElement('span');
  iconSpan.className = 'home-dash-group-icon';
  if (color) iconSpan.style.color = color;
  iconSpan.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h4.5l1 1.5H14v8H2z"/></svg>';
  header.appendChild(iconSpan);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'home-dash-group-name';
  nameSpan.textContent = groupName ?? t('homeGroupUngrouped');

  if (groupName) {
    nameSpan.ondblclick = (e) => {
      e.stopPropagation();
      startInlineRename(nameSpan, groupName, refreshView);
    };
  }
  header.appendChild(nameSpan);

  const countSpan = document.createElement('span');
  countSpan.className = 'home-dash-group-count';
  countSpan.textContent = t('homeGroupNodeCount').replace('{count}', String(items.length));
  header.appendChild(countSpan);

  if (groupName) {
    header.oncontextmenu = (e) => {
      e.preventDefault();
      showGroupContextMenu(e, groupName, refreshView);
    };
  }

  card.appendChild(header);

  const list = document.createElement('div');
  list.className = 'home-dash-group-list';
  createOverlayScrollbar({ viewport: list, container: list });

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'home-dash-group-empty';
    empty.textContent = '—';
    list.appendChild(empty);
  } else {
    for (const item of items) {
      list.appendChild(createConnectionRow(item, groupName, groupMap, refreshView));
    }
  }

  card.appendChild(list);
  return card;
}

// ─── Type group card (ungrouped connections by type) ───

const TYPE_GROUP_ICONS: Record<string, string> = {
  ssh: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M12.9 6.69A5 5 0 0 0 8 2.67 4.99 4.99 0 0 0 3.57 5.36 4 4 0 0 0 0 9.33c0 2.21 1.79 4 4 4h8.67a3.33 3.33 0 0 0 .23-6.64z"/><path d="M5.5 7.5l1.5 1.5-1.5 1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 10.5h2" stroke-linecap="round"/></svg>',
  remote: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="2.5" width="14" height="9" rx="1.5"/><path d="M5.5 14h5"/><path d="M8 11.5V14"/></svg>',
  jumpserver: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="1.5" width="12" height="13" rx="1.5"/><path d="M5 5h6M5 8h6M5 11h3"/></svg>',
};

const TYPE_GROUP_LABELS: Record<string, string> = {
  ssh: 'SSH',
  remote: 'Remote',
  jumpserver: 'JumpServer',
};

function createTypeGroupCard(type: 'ssh' | 'remote' | 'jumpserver', items: ConnectionItem[], groupMap: ConnectionGroupMap, refreshView: () => void): HTMLDivElement {
  const card = document.createElement('div');
  card.className = `home-dash-group-card home-dash-group-type-${type}`;
  card.dataset.groupName = `__type:${type}`;

  const header = document.createElement('div');
  header.className = 'home-dash-group-header';

  const typeIcon = TYPE_GROUP_ICONS[type] || '';
  const displayName = TYPE_GROUP_LABELS[type] || t('homeGroupUngrouped');
  header.innerHTML = `<span class="home-dash-group-icon">${typeIcon}</span><span class="home-dash-group-name">${escapeHtml(displayName)}</span><span class="home-dash-group-count">${t('homeGroupNodeCount').replace('{count}', String(items.length))}</span>`;

  card.appendChild(header);

  const list = document.createElement('div');
  list.className = 'home-dash-group-list';
  createOverlayScrollbar({ viewport: list, container: list });

  for (const item of items) {
    const row = createConnectionRow(item, null, groupMap, refreshView);
    list.appendChild(row);

    if (type === 'jumpserver') {
      const config = item.raw as JumpServerConfig;
      const history = getJSAssetHistoryByFrequency(config.name).slice(0, 5);
      for (const entry of history) {
        const assetRow = createAssetHistoryRow(entry, config);
        list.appendChild(assetRow);
      }
    }
  }

  card.appendChild(list);
  return card;
}

// ─── Asset history row (JumpServer) ───

function createAssetHistoryRow(entry: JSAssetHistoryEntry, config: JumpServerConfig): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'home-dash-conn-row home-dash-conn-jumpserver home-dash-asset-row';
  row.innerHTML = `<span class="home-dash-asset-indent">↳</span><span class="home-dash-conn-name">${escapeHtml(entry.assetName)}</span><span class="home-dash-conn-detail">${escapeHtml(entry.accountUsername)}@${escapeHtml(entry.assetAddress)}</span><span class="home-dash-asset-count">${entry.count}×</span>`;
  row.title = `${entry.assetName} (${entry.accountUsername}@${entry.assetAddress}) — ${entry.count} connections`;
  row.onclick = () => {
    (async () => {
      const { connectToAsset } = await import('./jumpserver-handler');
      const secrets = await loadJSSecrets(config.name);
      const fullConfig: JumpServerConfig = { ...config, password: secrets.password, apiToken: secrets.apiToken };
      const asset = { id: entry.assetId, name: entry.assetName, address: entry.assetAddress, platform: { id: 0, name: '' }, is_active: true };
      const account = { id: entry.accountId, name: entry.accountUsername, username: entry.accountUsername, has_secret: true, privileged: false };
      connectToAsset(fullConfig, asset, account);
    })();
  };
  return row;
}

// ─── Connection row ───

function createConnectionRow(item: ConnectionItem, currentGroup: string | null, _groupMap: ConnectionGroupMap, refreshView: () => void): HTMLDivElement {
  const row = document.createElement('div');
  row.className = `home-dash-conn-row home-dash-conn-${item.type}`;
  row.innerHTML = `<span class="home-dash-conn-name">${escapeHtml(item.name)}</span><span class="home-dash-conn-detail">${escapeHtml(item.detail)}</span>`;

  row.onclick = () => handleConnectionClick(item);
  row.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    showConnectionContextMenu(e, item, currentGroup, refreshView);
  };

  return row;
}

// ─── Connection click handler ───

export function handleConnectionClick(item: ConnectionItem): void {
  if (item.type === 'ssh') {
    const handler = getSSHConnectHandler();
    if (handler) handler(item.raw as SSHConnectionConfig);
  } else if (item.type === 'remote') {
    const info = item.raw as RemoteServerInfo;
    showRemoteCardSessionPopup(document.body, info);
  } else if (item.type === 'jumpserver') {
    const config = item.raw as JumpServerConfig;
    (async () => {
      const secrets = await loadJSSecrets(config.name);
      const fullConfig: JumpServerConfig = { ...config, password: secrets.password, apiToken: secrets.apiToken };
      const { handleJumpServerConnect } = await import('./jumpserver-handler');
      handleJumpServerConnect(fullConfig);
    })();
  }
}

// ─── Context menus ───

function showGroupContextMenu(event: MouseEvent, groupName: string, refreshView: () => void): void {
  removeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'home-card-menu';
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  const collapsedSet = loadGroupCollapsed();
  const isCollapsed = collapsedSet.has(groupName);

  const collapseItem = document.createElement('button');
  collapseItem.className = 'home-card-menu-item';
  collapseItem.textContent = isCollapsed ? t('homeGroupExpand') : t('homeGroupCollapse');
  collapseItem.onclick = () => {
    menu.remove();
    toggleGroupCollapsed(groupName);
    refreshView();
  };
  menu.appendChild(collapseItem);

  const renameItem = document.createElement('button');
  renameItem.className = 'home-card-menu-item';
  renameItem.textContent = t('homeGroupRename');
  renameItem.onclick = () => {
    menu.remove();
    showGroupModal(groupName, loadGroupColors()[groupName] || '', (newName, newColor) => {
      if (newName !== groupName) renameGroup(groupName, newName);
      if (newColor) setGroupColor(newName, newColor);
      else removeGroupColor(newName);
      refreshView();
    });
  };
  menu.appendChild(renameItem);

  const divColor = document.createElement('div');
  divColor.className = 'custom-context-menu-divider';
  menu.appendChild(divColor);

  const colorRow = document.createElement('div');
  colorRow.className = 'home-card-menu-colors';
  const currentColor = loadGroupColors()[groupName] || '';

  const noneColor = document.createElement('div');
  noneColor.className = `home-card-menu-color${!currentColor ? ' active' : ''}`;
  noneColor.style.border = '2px dashed var(--text-muted)';
  noneColor.title = t('homeGroupColorClear');
  noneColor.onclick = (e) => {
    e.stopPropagation();
    menu.remove();
    removeGroupColor(groupName);
    refreshView();
  };
  colorRow.appendChild(noneColor);

  for (const c of GROUP_COLORS) {
    const swatch = document.createElement('div');
    swatch.className = `home-card-menu-color${c === currentColor ? ' active' : ''}`;
    swatch.style.background = c;
    swatch.onclick = (e) => {
      e.stopPropagation();
      menu.remove();
      setGroupColor(groupName, c);
      refreshView();
    };
    colorRow.appendChild(swatch);
  }
  menu.appendChild(colorRow);

  const div2 = document.createElement('div');
  div2.className = 'custom-context-menu-divider';
  menu.appendChild(div2);

  const dupItem = document.createElement('button');
  dupItem.className = 'home-card-menu-item';
  dupItem.textContent = t('homeGroupDuplicate');
  dupItem.onclick = () => {
    menu.remove();
    duplicateGroup(groupName);
    refreshView();
  };
  menu.appendChild(dupItem);

  const deleteItem = document.createElement('button');
  deleteItem.className = 'home-card-menu-item danger';
  deleteItem.textContent = t('homeGroupDelete');
  deleteItem.onclick = async () => {
    menu.remove();
    const { confirm: tauriConfirm } = await import('@tauri-apps/plugin-dialog');
    const confirmed = await tauriConfirm(t('homeGroupDeleteConfirm'), { title: t('homeGroupDelete'), kind: 'warning' });
    if (confirmed) {
      deleteGroup(groupName);
      refreshView();
    }
  };
  menu.appendChild(deleteItem);

  document.body.appendChild(menu);
  clampMenu(menu);
  autoCloseMenu(menu);
}

function showConnectionContextMenu(event: MouseEvent, item: ConnectionItem, currentGroup: string | null, refreshView: () => void): void {
  removeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'home-card-menu';
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  if (item.type === 'ssh') {
    const editItem = document.createElement('button');
    editItem.className = 'home-card-menu-item';
    editItem.textContent = t('homeEditConnection');
    editItem.onclick = () => { menu.remove(); showSSHModal(item.raw as SSHConnectionConfig); };
    menu.appendChild(editItem);
  } else if (item.type === 'remote') {
    const editItem = document.createElement('button');
    editItem.className = 'home-card-menu-item';
    editItem.textContent = t('homeEditConnection');
    editItem.onclick = () => { menu.remove(); showRemoteEditDialog(item.raw as RemoteServerInfo); };
    menu.appendChild(editItem);
  } else if (item.type === 'jumpserver') {
    const editItem = document.createElement('button');
    editItem.className = 'home-card-menu-item';
    editItem.textContent = t('homeEditConnection');
    editItem.onclick = async () => {
      menu.remove();
      const config = item.raw as JumpServerConfig;
      const secrets = await loadJSSecrets(config.name);
      const prefill: JumpServerConfig = { ...config, password: secrets.password, apiToken: secrets.apiToken };
      const { showJumpServerConfigDialog } = await import('./jumpserver-ui');
      const result = await showJumpServerConfigDialog(prefill);
      if (result) {
        refreshView();
        if (result.connect) {
          const { handleJumpServerConnect } = await import('./jumpserver-handler');
          handleJumpServerConnect(result.config);
        }
      }
    };
    menu.appendChild(editItem);
  }

  const groups = loadGroupOrder();
  if (groups.length > 0 || currentGroup) {
    const divider = document.createElement('div');
    divider.className = 'custom-context-menu-divider';
    menu.appendChild(divider);

    for (const g of groups) {
      if (g === currentGroup) continue;
      const moveItem = document.createElement('button');
      moveItem.className = 'home-card-menu-item';
      moveItem.textContent = `→ ${g}`;
      moveItem.onclick = () => {
        menu.remove();
        setConnectionGroup(item.key, g);
        refreshView();
      };
      menu.appendChild(moveItem);
    }

    if (currentGroup) {
      const ungroup = document.createElement('button');
      ungroup.className = 'home-card-menu-item';
      ungroup.textContent = `→ ${t('homeGroupUngrouped')}`;
      ungroup.onclick = () => {
        menu.remove();
        removeConnectionGroup(item.key);
        refreshView();
      };
      menu.appendChild(ungroup);
    }
  }

  const divider2 = document.createElement('div');
  divider2.className = 'custom-context-menu-divider';
  menu.appendChild(divider2);

  const deleteItem = document.createElement('button');
  deleteItem.className = 'home-card-menu-item danger';
  deleteItem.textContent = t('sshDeleteConnection');
  deleteItem.onclick = () => {
    menu.remove();
    handleDeleteConnection(item, refreshView);
  };
  menu.appendChild(deleteItem);

  document.body.appendChild(menu);
  clampMenu(menu);
  autoCloseMenu(menu);
}

function handleDeleteConnection(item: ConnectionItem, refreshView: () => void): void {
  if (item.type === 'ssh') {
    removeSSHConnection((item.raw as SSHConnectionConfig).name);
  } else if (item.type === 'remote') {
    const info = item.raw as RemoteServerInfo;
    removeRemoteConnection(info.host, info.port);
  } else if (item.type === 'jumpserver') {
    removeJumpServerConfig((item.raw as JumpServerConfig).name);
  }
  removeConnectionGroup(item.key);
  refreshView();
}

// ─── Helpers ───

function removeContextMenu(): void {
  document.querySelector('.home-card-menu')?.remove();
}

function clampMenu(menu: HTMLElement): void {
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 4)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 4)}px`;
}

function autoCloseMenu(menu: HTMLElement): void {
  const cleanup = () => { menu.remove(); document.removeEventListener('click', cleanup, true); };
  document.addEventListener('click', cleanup, true);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Group modal (new / rename) ───

export function showGroupModal(
  currentName: string,
  currentColor: string,
  onConfirm: (name: string, color: string) => void,
): void {
  const overlay = document.createElement('div');
  overlay.className = 'group-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'group-modal';

  const header = document.createElement('div');
  header.className = 'group-modal-header';
  header.textContent = currentName ? t('homeGroupRename') : t('homeGroupNew');
  modal.appendChild(header);

  const body = document.createElement('div');
  body.className = 'group-modal-body';

  const nameInput = document.createElement('input');
  nameInput.className = 'group-modal-input';
  nameInput.type = 'text';
  nameInput.placeholder = t('homeGroupNewName');
  nameInput.value = currentName;
  body.appendChild(nameInput);

  let selectedColor = currentColor;
  const colorPicker = document.createElement('div');
  colorPicker.className = 'group-color-picker';

  const noneSwatch = document.createElement('div');
  noneSwatch.className = `group-color-swatch-none${!selectedColor ? ' selected' : ''}`;
  noneSwatch.textContent = '×';
  noneSwatch.onclick = () => {
    selectedColor = '';
    colorPicker.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
    noneSwatch.classList.add('selected');
  };
  colorPicker.appendChild(noneSwatch);

  for (const c of GROUP_COLORS) {
    const swatch = document.createElement('div');
    swatch.className = `group-color-swatch${c === selectedColor ? ' selected' : ''}`;
    swatch.style.background = c;
    swatch.onclick = () => {
      selectedColor = c;
      colorPicker.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
      swatch.classList.add('selected');
    };
    colorPicker.appendChild(swatch);
  }
  body.appendChild(colorPicker);

  const actions = document.createElement('div');
  actions.className = 'group-modal-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'group-modal-btn';
  cancelBtn.textContent = t('sshUnsavedCancel');
  cancelBtn.onclick = () => overlay.remove();
  actions.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'group-modal-btn group-modal-btn-primary';
  confirmBtn.textContent = currentName ? t('homeGroupRename') : t('homeGroupNew');
  confirmBtn.onclick = () => {
    const name = nameInput.value.trim();
    if (!name) return;
    overlay.remove();
    onConfirm(name, selectedColor);
  };
  actions.appendChild(confirmBtn);

  body.appendChild(actions);
  modal.appendChild(body);
  overlay.appendChild(modal);

  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  nameInput.onkeydown = (e) => {
    if (e.key === 'Enter') confirmBtn.click();
    if (e.key === 'Escape') overlay.remove();
  };

  document.body.appendChild(overlay);
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 50);
}

// ─── Inline rename ───

function startInlineRename(nameSpan: HTMLElement, groupName: string, refreshView: () => void): void {
  const input = document.createElement('input');
  input.className = 'home-dash-group-name-input';
  input.value = groupName;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const newName = input.value.trim();
    if (newName && newName !== groupName) {
      renameGroup(groupName, newName);
    }
    refreshView();
  };

  input.onblur = commit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = groupName; input.blur(); }
  };
}

// ─── Drag reorder (mouse-based for horizontal scroll) ───

function setupDragReorder(
  card: HTMLDivElement,
  _groupName: string,
  grid: HTMLElement,
  _getDragSrc: () => HTMLElement | null,
  _setDragSrc: (v: HTMLElement | null) => void,
  refreshView: () => void,
): void {
  const header = card.querySelector('.home-dash-group-header') as HTMLElement | null;
  if (!header) return;

  let dragging = false;
  let armed = false;  // mousedown happened, waiting for drag threshold
  let startX = 0;
  let startY = 0;
  let cardRect: DOMRect;
  let placeholder: HTMLElement | null = null;
  let clone: HTMLElement | null = null;
  let scrollRAF = 0;

  header.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, a, .home-dash-group-chevron')) return;

    e.preventDefault();
    e.stopPropagation();

    console.log('[DRAG] mousedown armed, startX:', e.clientX);
    armed = true;
    dragging = false;
    startX = e.clientX;
    startY = e.clientY;
    cardRect = card.getBoundingClientRect();

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  });

  function startEdgeScroll(mouseX: number) {
    cancelAnimationFrame(scrollRAF);
    const gridRect = grid.getBoundingClientRect();
    const edgeZone = 60; // px from edge to start scrolling
    const maxSpeed = 12; // px per frame

    const distLeft = mouseX - gridRect.left;
    const distRight = gridRect.right - mouseX;

    let speed = 0;
    if (distLeft < edgeZone && grid.scrollLeft > 0) {
      speed = -maxSpeed * (1 - distLeft / edgeZone);
    } else if (distRight < edgeZone && grid.scrollLeft < grid.scrollWidth - grid.clientWidth) {
      speed = maxSpeed * (1 - distRight / edgeZone);
    }

    if (Math.abs(speed) < 0.5) return;

    function tick() {
      if (!dragging) return;
      grid.scrollLeft += speed;
      scrollRAF = requestAnimationFrame(tick);
    }
    scrollRAF = requestAnimationFrame(tick);
  }

  function onMove(e: MouseEvent) {
    if (!armed) return;
    e.preventDefault();

    const dx = e.clientX - startX;

    if (!dragging) {
      if (Math.abs(dx) < 5 && Math.abs(e.clientY - startY) < 5) return;
      dragging = true;

      // Create a visual clone that floats with cursor
      clone = card.cloneNode(true) as HTMLElement;
      clone.classList.add('dragging');
      clone.style.cssText = `
        position: fixed;
        top: ${cardRect.top}px;
        left: ${cardRect.left}px;
        width: ${cardRect.width}px;
        height: ${cardRect.height}px;
        z-index: 9999;
        pointer-events: none;
        margin: 0;
        opacity: 0.85;
        box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        transition: none;
      `;
      document.body.appendChild(clone);

      // Replace original card with placeholder in the grid
      placeholder = document.createElement('div');
      placeholder.className = 'home-dash-group-card-placeholder';
      placeholder.style.flex = `0 0 ${cardRect.width}px`;
      placeholder.style.height = `${cardRect.height}px`;
      card.style.display = 'none';
      card.parentElement!.insertBefore(placeholder, card);

      document.body.classList.add('home-dragging');
    }

    // Move clone
    clone!.style.left = `${cardRect.left + dx}px`;

    // Edge auto-scroll when near container boundaries
    startEdgeScroll(e.clientX);

    // Find drop target
    const siblings = Array.from(grid.querySelectorAll('.home-dash-group-card:not([style*="display: none"])'));
    grid.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));

    for (const other of siblings) {
      const r = other.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right) {
        (other as HTMLElement).classList.add('drag-over');
        const mid = r.left + r.width / 2;
        if (placeholder) {
          if (e.clientX < mid) {
            grid.insertBefore(placeholder, other);
          } else if (other.nextSibling !== placeholder) {
            grid.insertBefore(placeholder, other.nextSibling);
          }
        }
        break;
      }
    }
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', onUp, true);
    cancelAnimationFrame(scrollRAF);

    const wasDragging = dragging;
    armed = false;
    dragging = false;

    // Remove clone
    if (clone) {
      clone.remove();
      clone = null;
    }

    // Show original card at placeholder position
    card.style.display = '';
    if (placeholder && placeholder.parentElement) {
      placeholder.parentElement.insertBefore(card, placeholder);
      placeholder.remove();
    }
    placeholder = null;

    document.body.classList.remove('home-dragging');
    grid.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));

    if (!wasDragging) return;

    // Persist card display order from DOM
    const allCards = grid.querySelectorAll('.home-dash-group-card');
    const newOrder: string[] = [];
    allCards.forEach(c => {
      const name = c.getAttribute('data-group-name');
      if (name) newOrder.push(name);
    });
    if (newOrder.length > 0) {
      const savedScroll = grid.scrollLeft;
      saveCardOrder(newOrder);
      refreshView();
      // Restore scroll position after re-render
      requestAnimationFrame(() => {
        const newGrid = document.querySelector('.home-dash-groups-grid') as HTMLElement | null;
        if (newGrid) newGrid.scrollLeft = savedScroll;
      });
    }
  }
}
