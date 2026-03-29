import type { DrawerInstance } from './drawer';
import { showDeleteConfirm, showBatchDeleteConfirm, showRenameDialog } from './drawer-context-menu';

export function setupBreadcrumb(
  instance: DrawerInstance,
  pathInput: HTMLInputElement,
): void {
  const breadcrumb = instance.element.querySelector('.breadcrumb') as HTMLElement;
  if (!breadcrumb) return;

  const updateBreadcrumb = (path: string) => {
    const parts = path === '/' ? [''] : path.split('/');
    breadcrumb.innerHTML = parts.map((part, i) => {
      const targetPath = i === 0 ? '/' : parts.slice(0, i + 1).join('/');
      const label = i === 0 ? '/' : part;
      const isLast = i === parts.length - 1;
      return `<span class="breadcrumb-item${isLast ? ' active' : ''}" data-path="${targetPath}">${label}</span>`;
    }).join('<span class="breadcrumb-sep">/</span>');
  };

  const showBreadcrumb = () => {
    breadcrumb.style.display = '';
    pathInput.style.display = 'none';
  };

  breadcrumb.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest('.breadcrumb-item') as HTMLElement;
    if (item?.dataset.path && instance.fileManager) {
      instance.fileManager.loadDirectory(item.dataset.path);
      return;
    }
    breadcrumb.style.display = 'none';
    pathInput.style.display = '';
    pathInput.focus();
    pathInput.select();
  });

  pathInput.addEventListener('blur', () => {
    setTimeout(() => {
      if (!instance.fileManager?.isAutocompleteOpen()) showBreadcrumb();
    }, 150);
  });

  if (instance.fileManager) {
    instance.fileManager.onPathChanged = (path: string) => {
      updateBreadcrumb(path);
      showBreadcrumb();
    };
  }
  showBreadcrumb();
  updateBreadcrumb('/');
}

export function setupKeyboardNav(
  instance: DrawerInstance,
  listElement: HTMLElement,
  fileListContainer: HTMLElement,
  backBtn: HTMLButtonElement,
  toggleSearchBar: (show: boolean) => void,
): void {
  const fileTable = instance.element.querySelector(`#file-table-${instance.sessionId}`) as HTMLElement;
  if (fileTable) fileTable.setAttribute('tabindex', '0');

  fileListContainer.addEventListener('keydown', (e: KeyboardEvent) => {
    const fm = instance.fileManager;
    if (!fm) return;

    // 搜索框聚焦时只拦截 Escape，其他按键交给搜索框处理
    const searchInput = instance.element.querySelector('.file-search-input') as HTMLInputElement | null;
    if (searchInput && document.activeElement === searchInput) {
      return;
    }

    const rows = Array.from(listElement.querySelectorAll('tr[data-path]')) as HTMLTableRowElement[];
    // 只取可见行（搜索过滤后）
    const visibleRows = rows.filter(r => r.style.display !== 'none');
    if (visibleRows.length === 0 && !['f', 'F5', 'Backspace'].includes(e.key)) return;
    const selectedIdx = visibleRows.findIndex(r => r.classList.contains('selected'));

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      let nextIdx: number;
      if (e.key === 'ArrowDown') {
        nextIdx = selectedIdx < visibleRows.length - 1 ? selectedIdx + 1 : 0;
      } else {
        nextIdx = selectedIdx > 0 ? selectedIdx - 1 : visibleRows.length - 1;
      }
      fm.selectedFiles.clear();
      rows.forEach(r => r.classList.remove('selected'));
      visibleRows[nextIdx].classList.add('selected');
      const name = visibleRows[nextIdx].dataset.path;
      if (name) { fm.selectedFiles.add(name); fm.lastClickedFile = name; }
      visibleRows[nextIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && selectedIdx >= 0) {
      e.preventDefault();
      visibleRows[selectedIdx].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      backBtn.click();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      const selected = fm.getSelectedFiles();
      if (selected.length > 1) {
        showBatchDeleteConfirm(instance, selected);
      } else if (selected.length === 1) {
        const name = selected[0];
        const fileInfo = fm.getFileInfo(name);
        showDeleteConfirm(instance, name, !!fileInfo?.is_dir);
      }
    } else if (e.key === 'F2' && selectedIdx >= 0) {
      e.preventDefault();
      const name = visibleRows[selectedIdx].dataset.path;
      if (name) showRenameDialog(instance, name);
    } else if (e.key === 'F5') {
      e.preventDefault();
      fm.loadDirectory(fm.getCurrentPath());
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      fm.selectedFiles.clear();
      rows.forEach(r => r.classList.remove('selected'));
      visibleRows.forEach(r => {
        r.classList.add('selected');
        const name = r.dataset.path;
        if (name) fm.selectedFiles.add(name);
      });
    } else if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      toggleSearchBar(true);
    }
  });
}

export function setupFileSearch(
  instance: DrawerInstance,
  listElement: HTMLElement,
): (show: boolean) => void {
  const searchBar = instance.element.querySelector('.file-search-bar') as HTMLElement;
  const searchInput = instance.element.querySelector('.file-search-input') as HTMLInputElement;

  const toggleSearchBar = (show: boolean) => {
    if (!searchBar || !searchInput) return;
    if (show) {
      searchBar.style.display = '';
      searchInput.focus();
    } else {
      searchBar.style.display = 'none';
      searchInput.value = '';
      listElement.querySelectorAll('tr').forEach(r => (r as HTMLElement).style.display = '');
    }
  };

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const query = searchInput.value.toLowerCase();
      listElement.querySelectorAll('tr').forEach(r => {
        const name = r.getAttribute('data-path') || '';
        (r as HTMLElement).style.display = name.toLowerCase().includes(query) ? '' : 'none';
      });
    });
    searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        toggleSearchBar(false);
        // 焦点回到文件表格
        const table = instance.element.querySelector(`#file-table-${instance.sessionId}`) as HTMLElement;
        table?.focus();
      }
      // 阻止冒泡到 fileListContainer 的 keydown（避免 Backspace 触发返回上层等）
      e.stopPropagation();
    });
  }

  return toggleSearchBar;
}

export function showSpeedLimitPicker(anchor: HTMLElement, instance: DrawerInstance): void {
  document.querySelector('.speed-limit-popup')?.remove();
  const fm = instance.fileManager;
  if (!fm) return;

  const current = fm.getSpeedLimit();
  const options = [
    { label: '不限速', value: 0 },
    { label: '1 MB/s', value: 1 * 1024 * 1024 },
    { label: '5 MB/s', value: 5 * 1024 * 1024 },
    { label: '10 MB/s', value: 10 * 1024 * 1024 },
    { label: '50 MB/s', value: 50 * 1024 * 1024 },
  ];

  const popup = document.createElement('div');
  popup.className = 'speed-limit-popup';
  popup.innerHTML = options.map(o =>
    `<div class="speed-limit-item${o.value === current ? ' active' : ''}" data-value="${o.value}">${o.label}</div>`
  ).join('');

  const rect = anchor.getBoundingClientRect();
  popup.style.position = 'fixed';
  popup.style.left = `${rect.left}px`;
  popup.style.bottom = `${window.innerHeight - rect.top + 4}px`;
  document.body.appendChild(popup);

  popup.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest('.speed-limit-item') as HTMLElement;
    if (item?.dataset.value !== undefined) {
      fm.setSpeedLimit(parseInt(item.dataset.value, 10));
      const label = options.find(o => o.value === parseInt(item.dataset.value!, 10))?.label || '不限速';
      anchor.title = `限速: ${label}`;
      popup.remove();
    }
  });

  const close = (e: MouseEvent) => {
    if (!popup.contains(e.target as Node) && e.target !== anchor) {
      popup.remove();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}
