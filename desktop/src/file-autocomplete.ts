// 路径自动补全模块

import { escapeHtml } from './status-bar';
import { encodeMessage } from './file-utils';
import { MsgFileList, type FileInfo } from './protocol';

/** 自动补全所需的 FileManager 上下文 */
export interface AutocompleteContext {
  ws: WebSocket | null;
  currentPath: string;
  files: FileInfo[];
  isLoadingDirectory: boolean;
  loadDirectory(path: string): Promise<void>;
}

/** 路径自动补全管理器 */
export class PathAutocomplete {
  private pathInput: HTMLInputElement;
  private ctx: AutocompleteContext;
  private autocompleteDropdown: HTMLDivElement | null = null;
  private autocompleteItems: FileInfo[] = [];
  private autocompleteParentDir: string = '/';
  private autocompleteSelectedIndex: number = -1;
  private autocompleteDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  autocompleteResolve: ((files: FileInfo[]) => void) | null = null;
  private dirCache: Map<string, { files: FileInfo[]; ts: number }> = new Map();
  private static readonly DIR_CACHE_SIZE = 20;
  private static readonly DIR_CACHE_TTL = 30000; // 30s

  constructor(pathInput: HTMLInputElement, ctx: AutocompleteContext) {
    this.pathInput = pathInput;
    this.ctx = ctx;
  }

  dirCachePut(path: string, files: FileInfo[]): void {
    if (this.dirCache.size >= PathAutocomplete.DIR_CACHE_SIZE) {
      const oldest = this.dirCache.keys().next().value!;
      this.dirCache.delete(oldest);
    }
    this.dirCache.set(path, { files, ts: Date.now() });
  }

  /** 静默查询目录内容（不影响 UI），供自动补全使用 */
  queryDirectory(path: string): Promise<FileInfo[]> {
    if (path === this.ctx.currentPath) return Promise.resolve(this.ctx.files);
    const cached = this.dirCache.get(path);
    if (cached && Date.now() - cached.ts < PathAutocomplete.DIR_CACHE_TTL) {
      return Promise.resolve(cached.files);
    }
    if (this.ctx.isLoadingDirectory || !this.ctx.ws || this.ctx.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve([]);
    }
    return new Promise((resolve) => {
      if (this.autocompleteResolve) this.autocompleteResolve([]);
      this.autocompleteResolve = resolve;
      const request = JSON.stringify({ path });
      const message = encodeMessage(MsgFileList, new TextEncoder().encode(request));
      this.ctx.ws!.send(message);
      setTimeout(() => {
        if (this.autocompleteResolve === resolve) {
          this.autocompleteResolve = null;
          resolve([]);
        }
      }, 3000);
    });
  }

  /** 初始化路径自动补全 */
  setup(): void {
    const wrapper = this.pathInput.parentElement;
    if (!wrapper || !wrapper.classList.contains('path-input-wrapper')) return;
    const dropdown = wrapper.querySelector('.path-autocomplete') as HTMLDivElement;
    if (!dropdown) return;
    this.autocompleteDropdown = dropdown;

    this.pathInput.addEventListener('input', () => {
      if (this.autocompleteDebounceTimer) clearTimeout(this.autocompleteDebounceTimer);
      this.autocompleteDebounceTimer = setTimeout(() => this.fetchAutocompleteItems(), 200);
    });

    this.pathInput.addEventListener('keydown', (e) => this.onAutocompleteKeydown(e));

    this.pathInput.addEventListener('blur', () => {
      setTimeout(() => this.hide(), 150);
    });
  }

  isOpen(): boolean {
    return !!this.autocompleteDropdown && this.autocompleteDropdown.style.display === 'block';
  }

  hide(): void {
    if (this.autocompleteDropdown) this.autocompleteDropdown.style.display = 'none';
    this.autocompleteItems = [];
    this.autocompleteSelectedIndex = -1;
  }

  private async fetchAutocompleteItems(): Promise<void> {
    const value = this.pathInput.value;
    if (!value.startsWith('/')) { this.hide(); return; }

    const lastSlash = value.lastIndexOf('/');
    const parentDir = lastSlash === 0 ? '/' : value.substring(0, lastSlash);
    const prefix = value.substring(lastSlash + 1).toLowerCase();

    try {
      const files = await this.queryDirectory(parentDir);
      const matches = files.filter(f =>
        f.is_dir && f.name !== '.' && f.name !== '..' &&
        f.name.toLowerCase().startsWith(prefix)
      );
      if (matches.length === 0 ||
          (matches.length === 1 && matches[0].name.toLowerCase() === prefix)) {
        this.hide();
        return;
      }
      this.showAutocomplete(matches, parentDir);
    } catch {
      this.hide();
    }
  }

  private showAutocomplete(items: FileInfo[], parentDir: string): void {
    if (!this.autocompleteDropdown) return;
    this.autocompleteItems = items;
    this.autocompleteParentDir = parentDir;
    this.autocompleteSelectedIndex = -1;

    const folderIcon = '<svg width="12" height="12" viewBox="0 0 16 16" fill="var(--accent)" stroke="none">'
      + '<path d="M1.5 2h4.3l1.4 1.5H14.5a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/></svg>';

    this.autocompleteDropdown.innerHTML = items.map((item, i) =>
      `<div class="path-ac-item" data-index="${i}">${folderIcon}<span>${escapeHtml(item.name)}</span></div>`
    ).join('');
    this.autocompleteDropdown.style.display = 'block';

    this.autocompleteDropdown.querySelectorAll('.path-ac-item').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.selectAutocompleteItem(parseInt((el as HTMLElement).dataset.index!), true);
      });
    });
  }

  private selectAutocompleteItem(index: number, navigate = false): void {
    const item = this.autocompleteItems[index];
    if (!item) return;
    const dir = this.autocompleteParentDir;
    const newPath = dir === '/' ? `/${item.name}` : `${dir}/${item.name}`;
    this.pathInput.value = navigate ? newPath : newPath + '/';
    this.hide();
    if (navigate) {
      // 鼠标点击：直接进入该目录
      this.ctx.loadDirectory(newPath);
    } else {
      // 键盘选择：填充路径并补全下一级
      this.pathInput.focus();
      if (this.autocompleteDebounceTimer) clearTimeout(this.autocompleteDebounceTimer);
      this.autocompleteDebounceTimer = setTimeout(() => this.fetchAutocompleteItems(), 100);
    }
  }

  private onAutocompleteKeydown(e: KeyboardEvent): void {
    if (!this.isOpen()) return;
    const len = this.autocompleteItems.length;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.autocompleteSelectedIndex = (this.autocompleteSelectedIndex + 1) % len;
        this.updateAutocompleteSelection();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.autocompleteSelectedIndex = (this.autocompleteSelectedIndex - 1 + len) % len;
        this.updateAutocompleteSelection();
        break;
      case 'Tab':
        e.preventDefault();
        if (this.autocompleteSelectedIndex >= 0) {
          this.selectAutocompleteItem(this.autocompleteSelectedIndex);
        } else if (len > 0) {
          this.selectAutocompleteItem(0);
        }
        break;
      case 'Enter':
        if (this.autocompleteSelectedIndex >= 0) {
          e.preventDefault();
          e.stopPropagation();
          this.selectAutocompleteItem(this.autocompleteSelectedIndex);
        }
        break;
      case 'Escape':
        e.preventDefault();
        this.hide();
        break;
    }
  }

  private updateAutocompleteSelection(): void {
    if (!this.autocompleteDropdown) return;
    this.autocompleteDropdown.querySelectorAll('.path-ac-item').forEach((el, i) => {
      el.classList.toggle('selected', i === this.autocompleteSelectedIndex);
      if (i === this.autocompleteSelectedIndex) {
        (el as HTMLElement).scrollIntoView({ block: 'nearest' });
      }
    });
  }
}
