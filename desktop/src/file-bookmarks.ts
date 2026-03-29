// 文件管理器书签/收藏目录模块
import { createOverlayScrollbar } from './overlay-scrollbar';

export interface Bookmark {
  path: string;
  label?: string;
}

function getStorageKey(host: string, port: number): string {
  return `meterm-bookmarks-${host}:${port}`;
}

export function loadBookmarks(host: string, port: number): Bookmark[] {
  try {
    const data = localStorage.getItem(getStorageKey(host, port));
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export function saveBookmarks(host: string, port: number, bookmarks: Bookmark[]): void {
  try {
    localStorage.setItem(getStorageKey(host, port), JSON.stringify(bookmarks));
  } catch (err) {
    console.error('Failed to save bookmarks:', err);
  }
}

export function addBookmark(host: string, port: number, path: string, label?: string): boolean {
  const bookmarks = loadBookmarks(host, port);
  if (bookmarks.some(b => b.path === path)) return false;
  bookmarks.push({ path, label });
  saveBookmarks(host, port, bookmarks);
  return true;
}

export function removeBookmark(host: string, port: number, path: string): void {
  const bookmarks = loadBookmarks(host, port).filter(b => b.path !== path);
  saveBookmarks(host, port, bookmarks);
}

export function showBookmarkPopup(
  anchor: HTMLElement,
  host: string,
  port: number,
  onNavigate: (path: string) => void,
): void {
  // 第二次点击关闭已有弹窗
  const existing = document.querySelector('.bookmark-popup');
  if (existing) { existing.remove(); return; }

  const bookmarks = loadBookmarks(host, port);

  // wrapper 作为定位容器，内部 list 作为滚动 viewport
  const popup = document.createElement('div');
  popup.className = 'bookmark-popup';

  const list = document.createElement('div');
  list.className = 'bookmark-list';

  if (bookmarks.length === 0) {
    list.innerHTML = '<div class="bookmark-empty">暂无书签</div>';
  } else {
    list.innerHTML = bookmarks.map(b => `
      <div class="bookmark-item" data-path="${b.path.replace(/"/g, '&quot;')}">
        <span class="bookmark-path" title="${b.path.replace(/"/g, '&quot;')}">${b.label || b.path}</span>
        <button class="bookmark-delete" data-path="${b.path.replace(/"/g, '&quot;')}" title="删除书签">&times;</button>
      </div>
    `).join('');
  }
  popup.appendChild(list);

  // 定位到按钮下方，始终在下方显示
  const rect = anchor.getBoundingClientRect();
  popup.style.position = 'fixed';
  popup.style.left = `${rect.left}px`;
  popup.style.top = `${rect.bottom + 4}px`;
  // 限制最大高度为按钮到屏幕底部的剩余空间
  const maxH = window.innerHeight - rect.bottom - 8;
  list.style.maxHeight = `${Math.max(80, maxH)}px`;

  document.body.appendChild(popup);

  // 调整水平位置防止溢出
  const popupRect = popup.getBoundingClientRect();
  if (popupRect.right > window.innerWidth) {
    popup.style.left = `${Math.max(0, window.innerWidth - popupRect.width - 4)}px`;
  }

  // overlay scrollbar: list 滚动，popup 作为定位容器
  createOverlayScrollbar({ viewport: list, container: popup });

  popup.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const deleteBtn = target.closest('.bookmark-delete') as HTMLElement;
    if (deleteBtn?.dataset.path) {
      e.stopPropagation();
      removeBookmark(host, port, deleteBtn.dataset.path);
      const item = deleteBtn.closest('.bookmark-item');
      item?.remove();
      if (!list.querySelector('.bookmark-item')) {
        list.innerHTML = '<div class="bookmark-empty">暂无书签</div>';
      }
      return;
    }
    const item = target.closest('.bookmark-item') as HTMLElement;
    if (item?.dataset.path) {
      onNavigate(item.dataset.path);
      popup.remove();
    }
  });

  const onClickOutside = (e: MouseEvent) => {
    if (!popup.contains(e.target as Node) && e.target !== anchor) {
      popup.remove();
      document.removeEventListener('click', onClickOutside);
    }
  };
  setTimeout(() => document.addEventListener('click', onClickOutside), 0);
}
