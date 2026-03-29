import { type FileInfo } from './protocol';
import { getFileIcon, isEditableFile } from './icons';
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

export function renderFileList(ctx: FileListUIContext): void {
  console.log('开始渲染文件列表，当前文件数:', ctx.files.length);

  let sortedFiles = [...ctx.files];

  if (ctx.sortColumn && ctx.sortDirection) {
    sortedFiles.sort((a, b) => {
      let compareResult = 0;

      switch (ctx.sortColumn) {
        case 'name':
          compareResult = a.name.localeCompare(b.name);
          break;
        case 'size':
          compareResult = a.size - b.size;
          break;
        case 'mtime':
          compareResult = a.mtime - b.mtime;
          break;
        case 'owner':
          compareResult = (a.owner + ':' + a.group).localeCompare(b.owner + ':' + b.group);
          break;
        default:
          compareResult = 0;
      }

      return ctx.sortDirection === 'asc' ? compareResult : -compareResult;
    });
  } else {
    sortedFiles.sort((a, b) => {
      if (a.is_dir !== b.is_dir) {
        return a.is_dir ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }

  updateSortArrows(ctx);

  ctx.listElement.innerHTML = sortedFiles.map((file) => {
    const iconSvg = getFileIcon(file.name, file.is_dir, file.is_link);
    const size = file.is_dir ? '-' : formatSize(file.size);
    const mtime = new Date(file.mtime * 1000).toLocaleString();
    const ownerGroup = escapeHtml((file.owner || '-') + ':' + (file.group || '-'));
    const escapedName = escapeHtml(file.name);

    return `
      <tr data-path="${escapedName}" data-is-dir="${file.is_dir}">
        <td><span class="file-icon">${iconSvg}</span>${escapedName}</td>
        <td>${size}</td>
        <td>${mtime}</td>
        <td>${ownerGroup}</td>
        <td>${escapeHtml(file.mode)}</td>
      </tr>
    `;
  }).join('');

  ctx.listElement.querySelectorAll('td').forEach((td) => {
    td.addEventListener('mouseenter', () => {
      if (td.scrollWidth > td.clientWidth) {
        td.title = td.textContent || '';
      } else {
        td.removeAttribute('title');
      }
    });
  });

  const allRows = Array.from(ctx.listElement.querySelectorAll('tr'));
  ctx.selectedFiles.clear();

  allRows.forEach((row) => {
    row.addEventListener('click', (e: MouseEvent) => {
      const fileName = row.dataset.path;
      if (!fileName) return;

      if (e.ctrlKey || e.metaKey) {
        if (ctx.selectedFiles.has(fileName)) {
          ctx.selectedFiles.delete(fileName);
          row.classList.remove('selected');
        } else {
          ctx.selectedFiles.add(fileName);
          row.classList.add('selected');
        }
        ctx.setLastClickedFile(fileName);
      } else if (e.shiftKey) {
        const anchorFile = ctx.getLastClickedFile();
        const lastIdx = anchorFile ? allRows.findIndex(r => r.dataset.path === anchorFile) : -1;
        const curIdx = allRows.indexOf(row);
        if (lastIdx >= 0 && curIdx >= 0) {
          const start = Math.min(lastIdx, curIdx);
          const end = Math.max(lastIdx, curIdx);
          ctx.selectedFiles.clear();
          allRows.forEach(r => r.classList.remove('selected'));
          for (let i = start; i <= end; i++) {
            const name = allRows[i].dataset.path;
            if (name) {
              ctx.selectedFiles.add(name);
              allRows[i].classList.add('selected');
            }
          }
        } else {
          // 没有锚点时，当普通点击处理
          ctx.selectedFiles.clear();
          allRows.forEach(r => r.classList.remove('selected'));
          ctx.selectedFiles.add(fileName);
          row.classList.add('selected');
          ctx.setLastClickedFile(fileName);
        }
      } else {
        ctx.selectedFiles.clear();
        allRows.forEach(r => r.classList.remove('selected'));
        ctx.selectedFiles.add(fileName);
        row.classList.add('selected');
        ctx.setLastClickedFile(fileName);
      }
      updateStatusBar(ctx);
    });

    row.addEventListener('dblclick', async () => {
      const path = row.dataset.path;
      const isDir = row.dataset.isDir === 'true';

      if (isDir && path) {
        const newPath = ctx.currentPath === '/'
          ? `/${path}`
          : `${ctx.currentPath}/${path}`;
        await ctx.loadDirectory(newPath);
      } else if (!isDir && path) {
        const conn = ctx.transport || ctx.ws;
        if (isEditableFile(path) && conn && ctx.isConnected) {
          const fileInfo = ctx.files.find(f => f.name === path);
          const fileSize = fileInfo?.size || 0;
          const fullPath = ctx.currentPath === '/'
            ? `/${path}`
            : `${ctx.currentPath}/${path}`;
          const sshCfg = sshConfigMap.get(ctx.sessionId);
          const host = sshCfg ? (sshCfg.name || sshCfg.host) : ctx.sessionId;
          void openFileInEditor(ctx.sessionId, fullPath, path, fileSize, conn, host);
        } else {
          await ctx.downloadFile(path);
        }
      }
    });
  });

  updateStatusBar(ctx);

  console.log('文件列表渲染完成，已添加', ctx.listElement.querySelectorAll('tr').length, '个事件监听器');
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
