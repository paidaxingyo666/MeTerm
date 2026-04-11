import { type FileInfo } from './protocol';
import { getFileIcon, isEditableFile } from './icons';
import { isImageFile } from './file-editor-md';
import { escapeHtml } from './status-bar';
import { formatSize } from './file-utils';
import { openFileInEditor } from './file-editor-bridge';
import { sshConfigMap } from './app-state';

export interface FileListUIContext {
  files: FileInfo[];
  currentPath: string;
  sortColumn: string | null;
  sortDirection: 'asc' | 'desc' | null;
  listElement: HTMLElement;
  sessionId: string;
  ws: WebSocket | null;
  transport: import('./terminal-transport').TerminalTransport | null;
  isConnected: boolean;
  loadDirectory: (path: string) => Promise<void>;
  downloadFile: (filename: string) => Promise<void>;
  selectedFiles: Set<string>;
  getLastClickedFile: () => string | null;
  setLastClickedFile: (name: string | null) => void;
  statusBarElement?: HTMLElement;
}

// ── Virtual scrolling state ──
/**
 * 每个 tbody 持久化的虚拟滚动状态。文件列表渲染时会在这里缓存当前的
 * `sortedFiles` (已排序后的全量数组) 与最近的 `ctx` 引用,
 * 委托事件处理器和 scroll 监听器都从这里读取最新值。
 */
interface VirtualState {
  ctx: FileListUIContext;
  /** 排序后未过滤的全量数组(切换目录时更新) */
  unfilteredFiles: FileInfo[];
  /** 当前实际渲染用的数组(可能被搜索过滤) */
  sortedFiles: FileInfo[];
  /** 当前搜索关键字(空字符串=未过滤) */
  filterQuery: string;
  rowHeight: number;
  scrollHandler: () => void;
  rafPending: boolean;
  resizeObserver?: ResizeObserver;
}

const virtualStates = new WeakMap<HTMLElement, VirtualState>();
/** 已附加委托事件的 scroller 集合(避免重复绑定) */
const delegatedScrollers = new WeakSet<HTMLElement>();

const OVERSCAN = 10;

/** 通过插入临时行测量当前主题下的实际行高 */
function measureRowHeight(body: HTMLElement): number {
  const probe = document.createElement('tr');
  probe.style.visibility = 'hidden';
  probe.innerHTML = '<td>x</td><td>x</td><td>x</td><td>x</td><td>x</td>';
  body.appendChild(probe);
  const h = probe.offsetHeight || 24;
  probe.remove();
  return h;
}

/** 构建单行 HTML(供初次渲染与虚拟滚动复用) */
function buildRowHtml(file: FileInfo): string {
  const iconSvg = getFileIcon(file.name, file.is_dir, file.is_link);
  const size = file.is_dir ? '-' : formatSize(file.size);
  const mtime = new Date(file.mtime * 1000).toLocaleString();
  const ownerGroup = escapeHtml((file.owner || '-') + ':' + (file.group || '-'));
  const escapedName = escapeHtml(file.name);
  return `<tr data-path="${escapedName}" data-is-dir="${file.is_dir}">
      <td><span class="file-icon">${iconSvg}</span>${escapedName}</td>
      <td>${size}</td>
      <td>${mtime}</td>
      <td>${ownerGroup}</td>
      <td>${escapeHtml(file.mode)}</td>
    </tr>`;
}

/** 构建顶部/底部撑高占位行 */
function buildSpacerRow(height: number): string {
  if (height <= 0) return '';
  return `<tr class="vlist-spacer" aria-hidden="true"><td colspan="5" style="height:${height}px;padding:0;border:0;"></td></tr>`;
}

/** 根据当前 scrollTop 与状态,重新渲染可视区行 */
function renderVirtualSlice(body: HTMLElement): void {
  const state = virtualStates.get(body);
  if (!state) return;
  const scroller = body.closest('.file-list') as HTMLElement | null;
  if (!scroller) return;

  const total = state.sortedFiles.length;
  const rowHeight = state.rowHeight;
  const viewportH = scroller.clientHeight;
  const scrollTop = scroller.scrollTop;

  let startIdx = Math.floor(scrollTop / rowHeight) - OVERSCAN;
  let endIdx = Math.ceil((scrollTop + viewportH) / rowHeight) + OVERSCAN;
  startIdx = Math.max(0, startIdx);
  endIdx = Math.min(total, Math.max(endIdx, 0));

  let html = buildSpacerRow(startIdx * rowHeight);
  for (let i = startIdx; i < endIdx; i++) {
    html += buildRowHtml(state.sortedFiles[i]);
  }
  html += buildSpacerRow((total - endIdx) * rowHeight);
  body.innerHTML = html;

  // 重新应用选中状态(行被销毁重建)
  const selected = state.ctx.selectedFiles;
  if (selected.size > 0) {
    body.querySelectorAll('tr[data-path]').forEach((tr) => {
      const name = (tr as HTMLElement).dataset.path;
      if (name && selected.has(name)) tr.classList.add('selected');
    });
  }
}

/** 处理行选中逻辑(共享于 click 与键盘场景) */
function handleRowSelection(
  ctx: FileListUIContext,
  sortedFiles: FileInfo[],
  fileName: string,
  e: MouseEvent,
  body: HTMLElement,
): void {
  if (e.ctrlKey || e.metaKey) {
    if (ctx.selectedFiles.has(fileName)) {
      ctx.selectedFiles.delete(fileName);
    } else {
      ctx.selectedFiles.add(fileName);
    }
    ctx.setLastClickedFile(fileName);
  } else if (e.shiftKey) {
    const anchor = ctx.getLastClickedFile();
    const lastIdx = anchor ? sortedFiles.findIndex((f) => f.name === anchor) : -1;
    const curIdx = sortedFiles.findIndex((f) => f.name === fileName);
    if (lastIdx >= 0 && curIdx >= 0) {
      const start = Math.min(lastIdx, curIdx);
      const end = Math.max(lastIdx, curIdx);
      ctx.selectedFiles.clear();
      for (let i = start; i <= end; i++) {
        ctx.selectedFiles.add(sortedFiles[i].name);
      }
    } else {
      ctx.selectedFiles.clear();
      ctx.selectedFiles.add(fileName);
      ctx.setLastClickedFile(fileName);
    }
  } else {
    ctx.selectedFiles.clear();
    ctx.selectedFiles.add(fileName);
    ctx.setLastClickedFile(fileName);
  }

  // 更新所有可见行的 selected 类
  body.querySelectorAll('tr[data-path]').forEach((tr) => {
    const name = (tr as HTMLElement).dataset.path;
    tr.classList.toggle('selected', !!name && ctx.selectedFiles.has(name));
  });
  updateStatusBar(ctx);
}

/** 在 scroller 上一次性绑定所有委托事件(click / dblclick / mouseover) */
function attachDelegatedHandlers(scroller: HTMLElement, body: HTMLElement): void {
  if (delegatedScrollers.has(scroller)) return;
  delegatedScrollers.add(scroller);

  scroller.addEventListener('click', (e: MouseEvent) => {
    const tr = (e.target as HTMLElement).closest('tr') as HTMLTableRowElement | null;
    if (!tr || tr.classList.contains('vlist-spacer')) return;
    const state = virtualStates.get(body);
    if (!state) return;
    const fileName = tr.dataset.path;
    if (!fileName) return;
    handleRowSelection(state.ctx, state.sortedFiles, fileName, e, body);
  });

  scroller.addEventListener('dblclick', async (e: MouseEvent) => {
    const tr = (e.target as HTMLElement).closest('tr') as HTMLTableRowElement | null;
    if (!tr || tr.classList.contains('vlist-spacer')) return;
    const state = virtualStates.get(body);
    if (!state) return;
    const ctx = state.ctx;
    const path = tr.dataset.path;
    const isDir = tr.dataset.isDir === 'true';
    if (!path) return;
    if (isDir) {
      const newPath = ctx.currentPath === '/' ? `/${path}` : `${ctx.currentPath}/${path}`;
      await ctx.loadDirectory(newPath);
    } else {
      const conn = ctx.transport || ctx.ws;
      if ((isEditableFile(path) || isImageFile(path)) && conn && ctx.isConnected) {
        const fileInfo = state.sortedFiles.find((f) => f.name === path);
        const fileSize = fileInfo?.size || 0;
        const fullPath = ctx.currentPath === '/' ? `/${path}` : `${ctx.currentPath}/${path}`;
        const sshCfg = sshConfigMap.get(ctx.sessionId);
        const host = sshCfg ? sshCfg.name || sshCfg.host : ctx.sessionId;
        void openFileInEditor(ctx.sessionId, fullPath, path, fileSize, conn, host);
      } else {
        await ctx.downloadFile(path);
      }
    }
  });

  // 委托式 tooltip:鼠标悬停时按需添加 title 属性
  scroller.addEventListener('mouseover', (e: MouseEvent) => {
    const td = (e.target as HTMLElement).closest('td');
    if (!td || !body.contains(td)) return;
    if (td.scrollWidth > td.clientWidth) {
      td.title = td.textContent || '';
    } else if (td.hasAttribute('title')) {
      td.removeAttribute('title');
    }
  });
}

/**
 * 返回当前显示的(已排序+已过滤)文件数组。供键盘导航等需要按"显示顺序"
 * 操作的模块使用——不能直接读 DOM,因为虚拟滚动只渲染可视窗口。
 */
export function getVirtualFileList(listElement: HTMLElement): FileInfo[] | null {
  const state = virtualStates.get(listElement);
  return state ? state.sortedFiles : null;
}

/**
 * 滚动到指定索引,使该行进入可视区。若已可见则不滚动。
 * 滚动后立即重渲一次切片,保证目标行在 DOM 中存在(用于后续 scrollIntoView 等)。
 */
export function scrollVirtualListToIndex(listElement: HTMLElement, idx: number): void {
  const state = virtualStates.get(listElement);
  if (!state) return;
  const scroller = listElement.closest('.file-list') as HTMLElement | null;
  if (!scroller) return;
  const targetTop = idx * state.rowHeight;
  const targetBottom = targetTop + state.rowHeight;
  const viewportTop = scroller.scrollTop;
  const viewportBottom = viewportTop + scroller.clientHeight;
  if (targetTop < viewportTop) {
    scroller.scrollTop = targetTop;
  } else if (targetBottom > viewportBottom) {
    scroller.scrollTop = targetBottom - scroller.clientHeight;
  }
  renderVirtualSlice(listElement);
}

/** 强制重渲虚拟切片(选中状态变化后调用) */
export function refreshVirtualList(listElement: HTMLElement): void {
  renderVirtualSlice(listElement);
}

/**
 * 应用文件名子串过滤(供搜索框调用)。query 为空字符串时清除过滤。
 * 与虚拟滚动协同:更新 state.sortedFiles 后重新渲染可视切片。
 */
export function applyFileListFilter(listElement: HTMLElement, query: string): void {
  const state = virtualStates.get(listElement);
  if (!state) return;
  const trimmed = query.trim().toLowerCase();
  state.filterQuery = trimmed;
  if (!trimmed) {
    state.sortedFiles = state.unfilteredFiles;
  } else {
    state.sortedFiles = state.unfilteredFiles.filter((f) =>
      f.name.toLowerCase().includes(trimmed),
    );
  }
  const scroller = listElement.closest('.file-list') as HTMLElement | null;
  if (scroller) scroller.scrollTop = 0;
  renderVirtualSlice(listElement);
  updateStatusBar(state.ctx);
}

export function renderFileList(ctx: FileListUIContext): void {
  // 1. 排序(全量,与是否虚拟无关)
  let sortedFiles = [...ctx.files];
  if (ctx.sortColumn && ctx.sortDirection) {
    sortedFiles.sort((a, b) => {
      let compareResult = 0;
      switch (ctx.sortColumn) {
        case 'name': compareResult = a.name.localeCompare(b.name); break;
        case 'size': compareResult = a.size - b.size; break;
        case 'mtime': compareResult = a.mtime - b.mtime; break;
        case 'owner': compareResult = (a.owner + ':' + a.group).localeCompare(b.owner + ':' + b.group); break;
        default: compareResult = 0;
      }
      return ctx.sortDirection === 'asc' ? compareResult : -compareResult;
    });
  } else {
    sortedFiles.sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  updateSortArrows(ctx);
  ctx.selectedFiles.clear();

  // 2. 初始化或更新虚拟滚动状态
  const body = ctx.listElement;
  const scroller = body.closest('.file-list') as HTMLElement | null;
  if (!scroller) {
    // 兜底:无 scroller 容器时退回全量渲染
    body.innerHTML = sortedFiles.map(buildRowHtml).join('');
    updateStatusBar(ctx);
    return;
  }

  let state = virtualStates.get(body);
  if (!state) {
    // 首次:测量行高,绑定 scroll / resize / 委托事件
    const rowHeight = measureRowHeight(body);
    const newState: VirtualState = {
      ctx,
      unfilteredFiles: sortedFiles,
      sortedFiles,
      filterQuery: '',
      rowHeight,
      rafPending: false,
      scrollHandler: () => {
        const s = virtualStates.get(body);
        if (!s || s.rafPending) return;
        s.rafPending = true;
        requestAnimationFrame(() => {
          s.rafPending = false;
          renderVirtualSlice(body);
        });
      },
    };
    virtualStates.set(body, newState);
    scroller.addEventListener('scroll', newState.scrollHandler, { passive: true });
    attachDelegatedHandlers(scroller, body);

    // 监听容器尺寸变化(抽屉拖动 / 标签切换可见时重新计算可视区)
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => renderVirtualSlice(body));
      ro.observe(scroller);
      newState.resizeObserver = ro;
    }
    state = newState;
  } else {
    state.ctx = ctx;
    state.unfilteredFiles = sortedFiles;
    // 切换目录时清空搜索过滤,重置滚动位置
    state.filterQuery = '';
    state.sortedFiles = sortedFiles;
    scroller.scrollTop = 0;
  }

  // 3. 渲染当前可视切片
  renderVirtualSlice(body);
  updateStatusBar(ctx);
}

export interface ColumnResizeContext {
  listElement: HTMLElement;
}

export function initializeColumnResize(ctx: ColumnResizeContext): void {
  const table = ctx.listElement.closest('table');
  if (!table) return;

  const thead = table.querySelector('thead');
  if (!thead) return;

  const ths = thead.querySelectorAll('th');

  ths.forEach((th, index) => {
    const resizer = th.querySelector('.column-resizer');
    if (!resizer) return;

    const nextTh = ths[index + 1] as HTMLElement | undefined;
    if (!nextTh) return;

    let startX = 0;
    let startWidth = 0;
    let startNextWidth = 0;

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const widths = Array.from(ths).map(t => (t as HTMLElement).offsetWidth);
      startX = e.pageX;
      startWidth = widths[index];
      startNextWidth = widths[index + 1];
      ths.forEach((t, i) => {
        (t as HTMLElement).style.width = `${widths[i]}px`;
      });

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);

      document.body.style.cursor = 'col-resize';
      resizer.classList.add('resizing');
    };

    const MIN_COL = 40;

    const onMouseMove = (e: MouseEvent) => {
      const diff = e.pageX - startX;
      const maxGrow = startNextWidth - MIN_COL;
      const maxShrink = startWidth - MIN_COL;
      const clampedDiff = Math.max(-maxShrink, Math.min(maxGrow, diff));
      (th as HTMLElement).style.width = `${startWidth + clampedDiff}px`;
      nextTh.style.width = `${startNextWidth - clampedDiff}px`;
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      resizer.classList.remove('resizing');

      const tableWidth = (table as HTMLElement).offsetWidth;
      if (tableWidth > 0) {
        ths.forEach((t) => {
          const pct = ((t as HTMLElement).offsetWidth / tableWidth) * 100;
          (t as HTMLElement).style.width = `${pct}%`;
        });
      }
    };

    resizer.addEventListener('mousedown', onMouseDown as EventListener);
  });
}

export interface SortingContext {
  listElement: HTMLElement;
  getSortColumn: () => string | null;
  setSortColumn: (col: string | null) => void;
  getSortDirection: () => 'asc' | 'desc' | null;
  setSortDirection: (dir: 'asc' | 'desc' | null) => void;
  renderFileList: () => void;
  updateSortArrows: () => void;
}

export function initializeSorting(ctx: SortingContext): void {
  const table = ctx.listElement.closest('table');
  if (!table) return;

  const thead = table.querySelector('thead');
  if (!thead) return;

  const sortableHeaders = thead.querySelectorAll('th.sortable');

  sortableHeaders.forEach((th) => {
    th.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('column-resizer') || target.closest('.column-resizer')) {
        return;
      }

      const column = th.getAttribute('data-column');
      if (!column) return;

      if (ctx.getSortColumn() === column) {
        if (ctx.getSortDirection() === 'asc') {
          ctx.setSortDirection('desc');
        } else if (ctx.getSortDirection() === 'desc') {
          ctx.setSortColumn(null);
          ctx.setSortDirection(null);
        }
      } else {
        ctx.setSortColumn(column);
        ctx.setSortDirection('asc');
      }

      ctx.updateSortArrows();
      ctx.renderFileList();
    });
  });
}

export function updateStatusBar(ctx: { files: FileInfo[]; selectedFiles: Set<string>; statusBarElement?: HTMLElement }): void {
  if (!ctx.statusBarElement) return;
  if (ctx.selectedFiles.size > 0) {
    let totalSize = 0;
    for (const name of ctx.selectedFiles) {
      const file = ctx.files.find(f => f.name === name);
      if (file && !file.is_dir) totalSize += file.size;
    }
    ctx.statusBarElement.textContent = `已选 ${ctx.selectedFiles.size} 个, 共 ${formatSize(totalSize)}`;
  } else {
    const dirCount = ctx.files.filter(f => f.is_dir).length;
    const fileCount = ctx.files.length - dirCount;
    ctx.statusBarElement.textContent = `${fileCount} 个文件, ${dirCount} 个文件夹`;
  }
}

export function updateSortArrows(ctx: { listElement: HTMLElement; sortColumn: string | null; sortDirection: 'asc' | 'desc' | null }): void {
  const table = ctx.listElement.closest('table');
  if (!table) return;

  const thead = table.querySelector('thead');
  if (!thead) return;

  const sortableHeaders = thead.querySelectorAll('th.sortable');

  sortableHeaders.forEach((th) => {
    const column = th.getAttribute('data-column');
    const arrows = th.querySelector('.sort-arrows');
    if (!arrows) return;

    const ascArrow = arrows.querySelector('.sort-asc');
    const descArrow = arrows.querySelector('.sort-desc');

    if (column === ctx.sortColumn) {
      th.classList.add('sorting');
      if (ctx.sortDirection === 'asc') {
        ascArrow?.classList.add('active');
        descArrow?.classList.remove('active');
      } else if (ctx.sortDirection === 'desc') {
        ascArrow?.classList.remove('active');
        descArrow?.classList.add('active');
      }
    } else {
      th.classList.remove('sorting');
      ascArrow?.classList.remove('active');
      descArrow?.classList.remove('active');
    }
  });
}
