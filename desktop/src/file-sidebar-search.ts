// Sidebar recursive search controller.
//
// Owns the sidebar's search row: debounces input, issues a recursive search via
// FileManager.searchFiles (server-side walkdir for local / read_dir for SFTP +
// JumpServer), streams results into a flat list, and restores the tree when the
// query is cleared. Stale streams are dropped by generation/request-id.

import type { FileManager } from './file-manager';
import type { FileSearchResponse, FileSearchHit } from './protocol';
import { settings } from './app-state';
import { escapeHtml } from './status-bar';

const FOLDER_SVG = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.2 1.4H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1z"/></svg>`;
const FILE_SVG = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M4 1.5h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1z"/><path d="M9 1.5V4.5h3"/></svg>`;

export interface SidebarSearchDeps {
  /** The whole search row (toggled open/closed by the toolbar search button). */
  rowEl: HTMLElement;
  input: HTMLInputElement;
  clearBtn: HTMLButtonElement;
  resultsContainer: HTMLElement;
  treeContainer: HTMLElement;
  getFileManager: () => FileManager | null;
  getRootPath: () => string;
  /** Navigate the tree to a result path (expand + select). */
  revealPath: (path: string) => void | Promise<void>;
}

const zh = (): boolean => settings?.language === 'zh';

function relativeOf(path: string, root: string): string {
  // Windows local hits/roots arrive with '\'; canonicalize so the relative-dir
  // column computes correctly. No-op on mac/Linux ('/'-native).
  path = path.replace(/\\/g, '/');
  root = root.replace(/\\/g, '/');
  if (root && root !== '/' && path.startsWith(root)) {
    const r = path.slice(root.length);
    return r.startsWith('/') ? r.slice(1) : r;
  }
  return root === '/' && path.startsWith('/') ? path.slice(1) : path;
}

export class SidebarSearchController {
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private gen = 0;
  private currentReqId: string | null = null;
  private hits: FileSearchHit[] = [];
  private listEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private renderedCount = 0;

  constructor(private deps: SidebarSearchDeps) {
    deps.input.placeholder = zh() ? '搜索文件…' : 'Search files…';
    deps.input.addEventListener('input', () => this.onInput());
    deps.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.clear();
        deps.input.blur();
      }
    });
    deps.clearBtn.addEventListener('click', () => {
      this.clear();
      deps.input.focus();
    });
  }

  private onInput(): void {
    const q = this.deps.input.value;
    this.deps.clearBtn.style.display = q ? '' : 'none';
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (!q.trim()) {
      this.clear();
      return;
    }
    this.debounceTimer = setTimeout(() => this.runSearch(q.trim()), 250);
  }

  private runSearch(query: string): void {
    const fm = this.deps.getFileManager();
    if (!fm) return;
    const root = this.deps.getRootPath();
    if (this.currentReqId) fm.cancelSearch(this.currentReqId);
    this.gen += 1;
    const myGen = this.gen;
    const reqId = `sidebar-search-${myGen}`;
    this.currentReqId = reqId;
    this.hits = [];
    this.listEl = null;
    this.countEl = null;
    this.renderedCount = 0;
    this.showResultsMode();
    this.renderStatus(zh() ? '搜索中…' : 'Searching…');

    fm.searchFiles(root, query, reqId, (resp: FileSearchResponse) => {
      if (myGen !== this.gen) return; // stale stream — dropped
      if (resp.error) {
        this.renderStatus(`${zh() ? '搜索失败' : 'Search failed'}: ${escapeHtml(resp.error)}`);
        return;
      }
      if (resp.hits && resp.hits.length) this.hits.push(...resp.hits);
      this.renderResults(resp.done, resp.truncated);
    });
  }

  private showResultsMode(): void {
    this.deps.treeContainer.style.display = 'none';
    this.deps.resultsContainer.style.display = '';
  }

  private showTreeMode(): void {
    this.deps.resultsContainer.style.display = 'none';
    this.deps.resultsContainer.innerHTML = '';
    this.deps.treeContainer.style.display = '';
  }

  private renderStatus(text: string): void {
    this.listEl = null;
    this.countEl = null;
    this.deps.resultsContainer.innerHTML = `<div class="sidebar-search-status">${text}</div>`;
  }

  private renderResults(done: boolean, truncated: boolean): void {
    if (this.hits.length === 0) {
      this.renderStatus(done ? (zh() ? '无匹配结果' : 'No results') : (zh() ? '搜索中…' : 'Searching…'));
      return;
    }
    const root = this.deps.getRootPath();

    // Build the list shell once, then append only new rows per batch.
    if (!this.listEl) {
      this.deps.resultsContainer.innerHTML = '';
      this.countEl = document.createElement('div');
      this.countEl.className = 'sidebar-search-count';
      this.listEl = document.createElement('div');
      this.listEl.className = 'sidebar-search-list';
      this.deps.resultsContainer.appendChild(this.countEl);
      this.deps.resultsContainer.appendChild(this.listEl);
      this.renderedCount = 0;
    }

    for (let i = this.renderedCount; i < this.hits.length; i++) {
      const hit = this.hits[i];
      const row = document.createElement('div');
      row.className = 'sidebar-search-item' + (hit.is_dir ? ' is-dir' : '');
      row.title = hit.path;
      const rel = relativeOf(hit.path, root);
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      row.innerHTML = `<span class="ssi-icon">${hit.is_dir ? FOLDER_SVG : FILE_SVG}</span>`
        + `<span class="ssi-name">${escapeHtml(hit.name)}</span>`
        + `<span class="ssi-path">${escapeHtml(dir)}</span>`;
      row.addEventListener('click', () => {
        this.clear();
        void this.deps.revealPath(hit.path);
      });
      this.listEl.appendChild(row);
    }
    this.renderedCount = this.hits.length;

    if (this.countEl) {
      const n = this.hits.length;
      this.countEl.textContent = done
        ? (truncated
            ? (zh() ? `${n}+ 个结果（已截断）` : `${n}+ results (truncated)`)
            : (zh() ? `${n} 个结果` : `${n} result${n === 1 ? '' : 's'}`))
        : (zh() ? `${n} 个结果（搜索中…）` : `${n} results (searching…)`);
    }
  }

  /** Clear the query and restore the tree view. */
  clear(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    const fm = this.deps.getFileManager();
    if (fm && this.currentReqId) fm.cancelSearch(this.currentReqId);
    this.currentReqId = null;
    this.gen += 1; // invalidate any in-flight stream
    this.hits = [];
    this.listEl = null;
    this.countEl = null;
    this.renderedCount = 0;
    this.deps.input.value = '';
    this.deps.clearBtn.style.display = 'none';
    this.showTreeMode();
  }

  // ── Open / close the search row (driven by the toolbar search button) ──

  isOpen(): boolean {
    return this.deps.rowEl.style.display !== 'none';
  }

  open(): void {
    this.deps.rowEl.style.display = '';
    this.deps.input.focus();
  }

  /** Close the row and restore the tree (clears the query). */
  close(): void {
    this.clear();
    this.deps.rowEl.style.display = 'none';
  }

  /** Toggle the row; returns the new open state. */
  toggle(): boolean {
    if (this.isOpen()) {
      this.close();
      return false;
    }
    this.open();
    return true;
  }

  destroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const fm = this.deps.getFileManager();
    if (fm && this.currentReqId) fm.cancelSearch(this.currentReqId);
  }
}
