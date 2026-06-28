// Home left sidebar — compact grouped connection list (search-filtered).
// Reuses the connection data + context menu from home-dashboard-left.

import { t } from './i18n';
import { icon } from './icons';
import { settings } from './app-state';
import {
  type ConnectionItem,
  collectAllConnections,
  filterConnections,
  escapeHtml,
  showConnectionContextMenu,
} from './home-dashboard-left';
import {
  loadGroupMap,
  loadGroupOrder,
  loadGroupCollapsed,
  toggleGroupCollapsed,
} from './connection-groups';

const UNGROUPED = '__ungrouped__';
const L = (zh: string, en: string): string => (settings?.language === 'zh' ? zh : en);

const STAR_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 3.2l2.7 5.5 6 .9-4.35 4.2 1.03 6L12 17l-5.38 2.8 1.03-6L3.3 9.6l6-.9z"/></svg>`;

// ── Pin (favorites) persistence ──
const PIN_KEY = 'meterm-pinned-connections';
export function loadPinned(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(PIN_KEY) || '[]') as string[]);
  } catch {
    return new Set();
  }
}
export function isPinned(key: string): boolean {
  return loadPinned().has(key);
}
export function togglePin(key: string): void {
  const s = loadPinned();
  if (s.has(key)) s.delete(key);
  else s.add(key);
  localStorage.setItem(PIN_KEY, JSON.stringify([...s]));
}

export const connTypeIcon = (type: ConnectionItem['type']): 'ssh' | 'remote' | 'jumpserver' =>
  type === 'remote' ? 'remote' : type === 'jumpserver' ? 'jumpserver' : 'ssh';

export interface SidebarListDeps {
  onSelect: (item: ConnectionItem) => void;
  refresh: () => void;
  getSelectedKey: () => string | null;
}

/** Render the grouped, filtered connection list into `listEl`. */
export function renderSidebarList(listEl: HTMLElement, headerSlot: HTMLElement | null, query: string, deps: SidebarListDeps): void {
  listEl.innerHTML = '';
  listEl.classList.remove('is-faded', 'at-top', 'at-bottom');
  if (headerSlot) headerSlot.innerHTML = '';
  const all = filterConnections(collectAllConnections(), query);

  if (all.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'home-side-empty';
    empty.textContent = query ? L('无匹配连接', 'No matching connections') : L('暂无连接，点上方按钮新建', 'No connections yet — add one above');
    listEl.appendChild(empty);
    return;
  }

  const groupMap = loadGroupMap();
  const order = loadGroupOrder();
  const collapsed = loadGroupCollapsed();
  const selectedKey = deps.getSelectedKey();

  const buckets = new Map<string, ConnectionItem[]>();
  for (const item of all) {
    const g = groupMap[item.key] || UNGROUPED;
    if (!buckets.has(g)) buckets.set(g, []);
    buckets.get(g)!.push(item);
  }

  const groupNames: string[] = [];
  for (const g of order) if (buckets.has(g)) groupNames.push(g);
  for (const g of buckets.keys()) if (g !== UNGROUPED && !groupNames.includes(g)) groupNames.push(g);
  if (buckets.has(UNGROUPED)) groupNames.push(UNGROUPED);

  // Single group → pull its header into the crisp fixed slot above the list, and put
  // only its rows in the (featherable) scroll area. Multiple groups → keep everything
  // in the scroll with no feather (the group names structure the list).
  const singleGroup = !!headerSlot && groupNames.length === 1;

  for (const g of groupNames) {
    const items = buckets.get(g)!;
    const isUngrouped = g === UNGROUPED;
    const isCollapsed = !query && collapsed.has(g);

    const header = document.createElement('div');
    header.className = 'home-side-group' + (isCollapsed ? ' collapsed' : '');
    header.innerHTML = `<span class="hsg-chevron">${icon('chevronRight')}</span>`
      + `<span class="hsg-name">${isUngrouped ? t('homeGroupUngrouped') : escapeHtml(g)}</span>`
      + `<span class="hsg-count">${items.length}</span>`;
    header.onclick = () => {
      if (query) return; // can't collapse while filtering
      toggleGroupCollapsed(g);
      deps.refresh();
    };
    (singleGroup ? headerSlot! : listEl).appendChild(header);

    if (isCollapsed) continue;

    for (const item of items) {
      const row = document.createElement('div');
      row.className = `home-side-row home-side-row-${item.type}` + (item.key === selectedKey ? ' selected' : '');
      const pinned = isPinned(item.key);
      row.innerHTML = `<span class="hsr-icon">${icon(connTypeIcon(item.type))}</span>`
        + `<span class="hsr-name" title="${escapeHtml(item.detail)}">${escapeHtml(item.name)}</span>`
        + `<button class="hsr-pin${pinned ? ' pinned' : ''}" type="button" tabindex="-1" title="${L('收藏', 'Pin')}">${STAR_SVG}</button>`;
      row.onclick = () => deps.onSelect(item);
      row.oncontextmenu = (e) => {
        e.preventDefault();
        showConnectionContextMenu(e, item, isUngrouped ? null : g, deps.refresh);
      };
      const pinBtn = row.querySelector('.hsr-pin') as HTMLButtonElement;
      pinBtn.onclick = (e) => {
        e.stopPropagation();
        togglePin(item.key);
        deps.refresh();
      };
      listEl.appendChild(row);
    }
  }

  // Feather the rows' top/bottom only when the single group's list overflows. The lone
  // header sits crisp in the slot above; with multiple groups we never feather.
  if (singleGroup) {
    const overflow = listEl.clientHeight > 0 && listEl.scrollHeight > listEl.clientHeight + 1;
    listEl.classList.toggle('is-faded', overflow);
    // Fresh render is scrolled to top → keep the first row crisp (no top fade yet).
    listEl.classList.toggle('at-top', listEl.scrollTop <= 0);
    listEl.classList.toggle('at-bottom', listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 1);
  }
}
