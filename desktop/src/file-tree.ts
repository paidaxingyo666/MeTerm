/**
 * file-tree.ts — File tree component for the sidebar file manager
 *
 * Renders files/directories in a tree structure with lazy-loading.
 * Supports multi-selection (Ctrl/Shift+click) and drag-to-move with confirm dialog.
 */

import type { FileInfo } from './protocol';
import { getFileIcon } from './icons';
import { escapeHtml } from './status-bar';
import { t } from './i18n';

// ── Batch rendering ──
/** 每个目录首次展开时渲染的最大子节点数;超过则追加"加载更多"节点 */
const TREE_PAGE_SIZE = 200;
/** "加载更多"节点的特殊父路径标识:代表根目录 */
const ROOT_MORE_MARKER = '__root__';

// ── Data model ──

export interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  mode: string;
  mtime: number;
  children: FileTreeNode[] | null;
  expanded: boolean;
  loading: boolean;
  depth: number;
  /** 当前已渲染的子节点数量(分批);undefined 表示使用默认 TREE_PAGE_SIZE */
  renderedCount?: number;
}

export interface FileTreeCallbacks {
  /**
   * Fetch children of a directory.
   * `forceRefresh` is set on explicit refresh paths (right-click refresh,
   * post-mutation rerender, manual breadcrumb navigation) so the
   * implementation can bypass any directory cache it maintains.
   */
  onLoadChildren: (path: string, forceRefresh?: boolean) => Promise<FileInfo[]>;
  onSelect: (node: FileTreeNode) => void;
  onOpen: (node: FileTreeNode) => void;
  onContextMenu: (node: FileTreeNode, event: MouseEvent) => void;
  /** Move files to a destination directory. Returns true if move succeeded. */
  onMove?: (sourcePaths: string[], destDir: string) => Promise<boolean>;
  /** A directory was dropped onto an external zone (breadcrumb area). Path of first dir dragged. */
  onDropToRoot?: (dirPath: string) => void;
  /** A directory was dropped onto the terminal area */
  onDropToTerminal?: (dirPath: string) => void;
}

// ── FileTreeRenderer ──

export class FileTreeRenderer {
  private rootNodes: FileTreeNode[] = [];
  private rootPath = '/';
  private container: HTMLElement;
  private callbacks: FileTreeCallbacks;
  /** Set of selected paths (multi-select) */
  private selectedPaths = new Set<string>();
  /** Last clicked path for Shift-range selection */
  private lastClickedPath: string | null = null;
  private nodeMap = new Map<string, FileTreeNode>();
  /** Flat ordering of visible paths for Shift-range selection */
  private visibleOrder: string[] = [];
  /** Suppress next click after drag ends */
  private suppressClick = false;
  /** Bound event handlers for cleanup */
  private boundHandlers: { type: string; handler: EventListener }[] = [];
  /** Active drag ghost element (for cleanup on destroy) */
  private activeDragGhost: HTMLElement | null = null;
  /** Currently dragged paths (exposed for external drop zones) */
  activeDragPaths: string[] = [];
  /** 根节点当前已渲染数量(分批) */
  private rootRenderedCount = TREE_PAGE_SIZE;

  constructor(container: HTMLElement, callbacks: FileTreeCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.bindEvents();
  }

  /** Set root directory and its children, then render */
  setRoot(path: string, files: FileInfo[]): void {
    // Canonicalize to '/' so the root, node-map keys, and reveal targets share a
    // single separator. Windows local paths arrive with '\'; no-op on mac/Linux.
    const root = path.replace(/\\/g, '/');
    this.rootPath = root;
    this.nodeMap.clear();
    this.rootNodes = this.filesToNodes(files, root, 0);
    this.rootRenderedCount = TREE_PAGE_SIZE;
    this.render();
  }

  getRootPath(): string { return this.rootPath; }

  getSelectedPaths(): string[] { return [...this.selectedPaths]; }

  getNode(path: string): FileTreeNode | undefined { return this.nodeMap.get(path); }

  selectPath(path: string): void {
    this.selectedPaths.clear();
    this.selectedPaths.add(path);
    this.lastClickedPath = path;
    this.updateSelection();
  }

  async expandNode(path: string): Promise<void> {
    const node = this.nodeMap.get(path);
    if (!node || !node.isDir || node.expanded) return;
    await this.expandOnly(node);
  }

  collapseNode(path: string): void {
    const node = this.nodeMap.get(path);
    if (!node || !node.isDir || !node.expanded) return;
    node.expanded = false;
    this.render();
  }

  /**
   * Rename a node in place without re-fetching from the server.
   * Used by the rename dialog so the user gets an instant visual update
   * — otherwise the tree stays at the old name for ~500ms-1s while the
   * post-rename refresh round-trip completes, which feels like nothing
   * happened. The follow-up `refreshAll()` reconciles whatever we did
   * here with the server's truth.
   *
   * Returns false if `oldPath` isn't in this tree (e.g. user renamed a
   * file via drawer in a directory the tree doesn't cover).
   */
  renameNodeInPlace(oldPath: string, newName: string): boolean {
    const node = this.nodeMap.get(oldPath);
    if (!node) return false;
    const parentDir = oldPath.substring(0, oldPath.lastIndexOf('/')) || '/';
    const newPath = parentDir === '/' ? `/${newName}` : `${parentDir}/${newName}`;
    if (this.nodeMap.has(newPath) && newPath !== oldPath) {
      // Name collision — let the server be the source of truth.
      return false;
    }

    // Rewrite this node + every descendant's path. nodeMap is keyed by
    // path, so each old key must be removed and a new one added.
    const rewrite = (n: FileTreeNode, oldAncestor: string, newAncestor: string) => {
      this.nodeMap.delete(n.path);
      if (n.path === oldAncestor) {
        n.name = newName;
        n.path = newAncestor;
      } else {
        // descendant: replace path prefix
        n.path = newAncestor + n.path.substring(oldAncestor.length);
      }
      this.nodeMap.set(n.path, n);
      if (n.children) {
        for (const c of n.children) rewrite(c, oldAncestor, newAncestor);
      }
    };
    rewrite(node, oldPath, newPath);

    // Move the selection marker so the renamed node stays selected.
    if (this.selectedPaths.has(oldPath)) {
      this.selectedPaths.delete(oldPath);
      this.selectedPaths.add(newPath);
    }

    // Re-sort the sibling list — alphabetical order may shift.
    const siblingList = parentDir === this.rootPath
      ? this.rootNodes
      : this.nodeMap.get(parentDir)?.children;
    if (siblingList) {
      siblingList.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }

    this.render();
    return true;
  }

  async refreshNode(path: string): Promise<void> {
    const node = this.nodeMap.get(path);
    if (!node || !node.isDir) return;
    node.loading = true;
    try {
      // Force-refresh bypasses any directory cache — the user explicitly
      // asked for fresh content (right-click refresh).
      const files = await this.callbacks.onLoadChildren(path, true);
      node.children = this.filesToNodes(files, path, node.depth + 1);
      node.expanded = true;
      node.loading = false;
    } catch {
      node.loading = false;
    }
    this.render();
  }

  async refreshAll(): Promise<void> {
    // Snapshot expansion state BEFORE any await. If we read it after the
    // first await (root listdir round-trip), a concurrent refreshAll
    // racing this one will have already nodeMap.clear()'d the structure
    // and our `forEach` reads an empty / half-rebuilt map — every
    // expanded node silently collapses on the next render. This is
    // exactly what happened after sidebar drag-drop move: meterm-file-op-done
    // fires one refresh, the move handler's setTimeout(500) fires
    // another, the two await on root concurrently, and whichever
    // captures expandedPaths second sees an empty set.
    const expandedPaths = new Set<string>();
    this.nodeMap.forEach((node, p) => { if (node.expanded) expandedPaths.add(p); });

    try {
      const files = await this.callbacks.onLoadChildren(this.rootPath, true);
      this.nodeMap.clear();
      this.rootNodes = this.filesToNodes(files, this.rootPath, 0);

      for (const p of expandedPaths) {
        const node = this.nodeMap.get(p);
        if (node && node.isDir) {
          try {
            const childFiles = await this.callbacks.onLoadChildren(p, true);
            node.children = this.filesToNodes(childFiles, p, node.depth + 1);
            node.expanded = true;
          } catch { /* skip */ }
        }
      }
    } catch { /* ignore */ }
    this.render();
  }

  async revealPath(targetPath: string): Promise<void> {
    // Canonicalize separators so Windows search hits ('\') match node-map keys ('/').
    const normalized = targetPath.replace(/\\/g, '/');
    const target = normalized.endsWith('/') && normalized.length > 1
      ? normalized.slice(0, -1) : normalized;

    if (!target.startsWith(this.rootPath) && this.rootPath !== '/') return;

    const relativePart = this.rootPath === '/'
      ? target
      : target.slice(this.rootPath.length + (this.rootPath.endsWith('/') ? 0 : 1));
    const segments = relativePart.split('/').filter(Boolean);

    let currentPath = this.rootPath;
    for (const seg of segments) {
      currentPath = currentPath.endsWith('/')
        ? `${currentPath}${seg}` : `${currentPath}/${seg}`;
      const node = this.nodeMap.get(currentPath);
      if (node && node.isDir && !node.expanded) {
        await this.expandOnly(node);
      } else if (!node) {
        break;
      }
    }

    const targetNode = this.nodeMap.get(target);
    if (targetNode && targetNode.isDir && !targetNode.expanded) {
      await this.expandOnly(targetNode);
    }

    this.selectPath(target);
    this.scrollToSelected();
  }

  destroy(): void {
    // Remove all registered event listeners
    for (const { type, handler } of this.boundHandlers) {
      this.container.removeEventListener(type, handler);
    }
    this.boundHandlers = [];
    // Clean up drag ghost if active
    if (this.activeDragGhost) {
      this.activeDragGhost.remove();
      this.activeDragGhost = null;
    }
    this.container.innerHTML = '';
    this.nodeMap.clear();
    this.rootNodes = [];
    this.selectedPaths.clear();
    this.visibleOrder = [];
  }

  // ── Private ──

  private filesToNodes(files: FileInfo[], parentPath: string, depth: number): FileTreeNode[] {
    const nodes = files.map(f => {
      const nodePath = parentPath.endsWith('/')
        ? `${parentPath}${f.name}` : `${parentPath}/${f.name}`;
      const node: FileTreeNode = {
        name: f.name, path: nodePath, isDir: f.is_dir, isLink: f.is_link ?? false,
        size: f.size, mode: f.mode, mtime: f.mtime,
        children: null, expanded: false, loading: false, depth,
      };
      this.nodeMap.set(nodePath, node);
      return node;
    });
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return nodes;
  }

  /** Nodes currently being toggled (prevent re-entrant expand/collapse) */
  private toggleBusy = new Set<string>();

  private async toggleExpand(node: FileTreeNode): Promise<void> {
    if (!node.isDir) return;
    if (this.toggleBusy.has(node.path)) {
      // Mid-animation or loading — force immediate collapse
      this.toggleBusy.delete(node.path);
      if (node.expanded) {
        node.expanded = false;
        node.loading = false;
        // Remove wrapper immediately (skip animation)
        const parentEl = this.container.querySelector(`[data-path="${CSS.escape(node.path)}"]`);
        const wrapper = parentEl?.nextElementSibling;
        if (wrapper?.classList.contains('tree-children')) wrapper.remove();
        const chevron = parentEl?.querySelector('.tree-chevron');
        if (chevron) chevron.className = 'tree-chevron';
        this.rebuildVisibleOrder();
      }
      return;
    }
    if (node.expanded) {
      this.collapseAnimated(node);
      return;
    }
    this.toggleBusy.add(node.path);
    await this.expandOnly(node);
    this.toggleBusy.delete(node.path);
  }

  private async expandOnly(node: FileTreeNode): Promise<void> {
    if (!node.isDir || node.expanded) return;
    if (node.children === null) {
      // Expand immediately with a loading placeholder
      node.expanded = true;
      node.loading = true;
      this.expandWithLoading(node);

      try {
        const files = await this.callbacks.onLoadChildren(node.path);
        node.children = this.filesToNodes(files, node.path, node.depth + 1);
      } catch { node.children = []; }
      node.loading = false;

      // Replace loading placeholder with actual children
      this.replaceLoadingWithChildren(node);
      return;
    }
    node.expanded = true;
    this.expandAnimated(node);
  }

  /** Expand a folder immediately with a loading spinner as placeholder child */
  private expandWithLoading(node: FileTreeNode): void {
    const parentEl = this.container.querySelector(`[data-path="${CSS.escape(node.path)}"]`);
    if (!parentEl) return;

    // Update chevron to expanded
    const chevron = parentEl.querySelector('.tree-chevron');
    if (chevron) chevron.className = 'tree-chevron expanded';

    // Insert loading placeholder
    const indent = (node.depth + 1) * 16 + 4;
    const guides = this.renderGuides(node.depth + 1);
    const wrapper = document.createElement('div');
    wrapper.className = 'tree-children';
    wrapper.dataset.parentPath = node.path;
    wrapper.innerHTML = `<li class="tree-node tree-loading-placeholder" style="padding-left:${indent}px">
      ${guides}<svg class="tree-loading-spin" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 2a6 6 0 1 1-5.2 3"/></svg>
    </li>`;
    parentEl.after(wrapper);
  }

  /** Replace loading placeholder with actual loaded children (with animation) */
  private replaceLoadingWithChildren(node: FileTreeNode): void {
    const wrapper = this.container.querySelector(`[data-parent-path="${CSS.escape(node.path)}"]`) as HTMLElement | null;
    if (!wrapper) { this.render(); return; }

    // Build children HTML (respecting batch limit)
    wrapper.innerHTML = this.renderDirectChildren(node);
    this.rebuildVisibleOrder();
  }

  /**
   * 渲染单个目录的直接子节点(非递归),受 `renderedCount` 分批限制。
   * 用于动画路径(expandAnimated / replaceLoadingWithChildren)中只渲染一层子节点的场景。
   */
  private renderDirectChildren(node: FileTreeNode): string {
    if (!node.children || node.children.length === 0) {
      return `<li class="tree-node tree-empty" style="padding-left:${(node.depth + 1) * 16 + 4}px">
        ${this.renderGuides(node.depth + 1)}<span class="tree-empty-label">${escapeHtml(t('sidebarEmptyDir') || 'Empty')}</span>
      </li>`;
    }
    const limit = node.renderedCount ?? TREE_PAGE_SIZE;
    const sliceCount = Math.min(limit, node.children.length);
    let html = '';
    for (let i = 0; i < sliceCount; i++) {
      const child = node.children[i];
      this.visibleOrder.push(child.path);
      html += this.renderSingleNode(child);
    }
    if (node.children.length > sliceCount) {
      html += this.renderMoreNode(node.children.length - sliceCount, node.depth + 1, node.path);
    }
    return html;
  }

  /** Insert children with slide-down animation */
  private expandAnimated(node: FileTreeNode): void {
    const parentEl = this.container.querySelector(`[data-path="${CSS.escape(node.path)}"]`);
    if (!parentEl) { this.render(); return; }

    // Remove any existing wrapper (e.g. stale animation from rapid toggle)
    const oldWrapper = parentEl.nextElementSibling;
    if (oldWrapper?.classList.contains('tree-children')) {
      oldWrapper.remove();
    }

    // Update chevron
    const chevron = parentEl.querySelector('.tree-chevron');
    if (chevron) { chevron.className = 'tree-chevron expanded'; }

    // Build children HTML (respecting batch limit)
    const childrenHtml = this.renderDirectChildren(node);

    // Create animated wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'tree-children tree-children-enter';
    wrapper.dataset.parentPath = node.path;
    wrapper.innerHTML = childrenHtml;

    // Insert after parent node
    parentEl.after(wrapper);

    // Trigger animation: measure height, then animate
    const fullHeight = wrapper.scrollHeight;
    wrapper.style.maxHeight = '0px';
    // Force reflow
    void wrapper.offsetHeight;
    wrapper.style.maxHeight = `${fullHeight}px`;

    wrapper.addEventListener('transitionend', () => {
      wrapper.classList.remove('tree-children-enter');
      wrapper.style.maxHeight = '';
      // Rebuild visibleOrder
      this.rebuildVisibleOrder();
    }, { once: true });
  }

  /** Remove children with slide-up animation */
  private collapseAnimated(node: FileTreeNode): void {
    node.expanded = false;
    const parentEl = this.container.querySelector(`[data-path="${CSS.escape(node.path)}"]`);
    if (!parentEl) { this.render(); return; }

    // Update chevron
    const chevron = parentEl.querySelector('.tree-chevron');
    if (chevron) { chevron.className = 'tree-chevron'; }
    parentEl.classList.remove('selected');

    // Find children wrapper
    const wrapper = parentEl.nextElementSibling as HTMLElement | null;
    if (!wrapper || !wrapper.classList.contains('tree-children')) {
      this.render();
      return;
    }

    // If wrapper is mid-animation (expand or previous collapse), skip animation
    // and remove immediately to avoid stuck state
    if (wrapper.classList.contains('tree-children-enter') || wrapper.classList.contains('tree-children-leave')) {
      wrapper.remove();
      this.collapseDescendants(node);
      this.rebuildVisibleOrder();
      return;
    }

    // Animate collapse
    const currentHeight = wrapper.scrollHeight;
    wrapper.style.maxHeight = `${currentHeight}px`;
    void wrapper.offsetHeight;
    wrapper.classList.add('tree-children-leave');
    wrapper.style.maxHeight = '0px';

    wrapper.addEventListener('transitionend', () => {
      wrapper.remove();
      this.collapseDescendants(node);
      this.rebuildVisibleOrder();
    }, { once: true });
  }

  /** Recursively collapse all descendants in data model */
  private collapseDescendants(node: FileTreeNode): void {
    if (!node.children) return;
    for (const child of node.children) {
      if (child.expanded) {
        child.expanded = false;
        this.collapseDescendants(child);
      }
    }
  }

  /** Rebuild visibleOrder from current DOM */
  private rebuildVisibleOrder(): void {
    this.visibleOrder = [];
    this.container.querySelectorAll('.tree-node[data-path]').forEach(el => {
      const path = (el as HTMLElement).dataset.path;
      if (path && !el.classList.contains('tree-empty')) {
        this.visibleOrder.push(path);
      }
    });
  }

  private render(): void {
    this.visibleOrder = [];
    const html = this.renderNodes(this.rootNodes, null);
    this.container.innerHTML = `<ul class="file-tree-root">${html}</ul>`;
    this.updateSelection();
  }

  /**
   * 递归渲染节点列表。`parent` 为 null 表示根级,使用 `rootRenderedCount`;
   * 否则使用 `parent.renderedCount ?? TREE_PAGE_SIZE`。超出部分追加"加载更多"节点。
   */
  private renderNodes(nodes: FileTreeNode[], parent: FileTreeNode | null): string {
    const limit = parent
      ? (parent.renderedCount ?? TREE_PAGE_SIZE)
      : this.rootRenderedCount;
    const sliceCount = Math.min(limit, nodes.length);

    let html = '';
    for (let i = 0; i < sliceCount; i++) {
      const node = nodes[i];
      this.visibleOrder.push(node.path);
      html += this.renderSingleNode(node);
      if (node.expanded && node.children) {
        let childHtml = '';
        if (node.children.length === 0) {
          childHtml = `<li class="tree-node tree-empty" style="padding-left:${(node.depth + 1) * 16 + 4}px">
            ${this.renderGuides(node.depth + 1)}<span class="tree-empty-label">${escapeHtml(t('sidebarEmptyDir') || 'Empty')}</span>
          </li>`;
        } else {
          childHtml = this.renderNodes(node.children, node);
        }
        html += `<div class="tree-children" data-parent-path="${escapeHtml(node.path)}">${childHtml}</div>`;
      }
    }

    if (nodes.length > sliceCount) {
      const remaining = nodes.length - sliceCount;
      const depth = parent ? parent.depth + 1 : 0;
      const parentMarker = parent ? parent.path : ROOT_MORE_MARKER;
      html += this.renderMoreNode(remaining, depth, parentMarker);
    }

    return html;
  }

  /** 渲染"还有 N 项,加载更多"占位节点 */
  private renderMoreNode(remaining: number, depth: number, parentMarker: string): string {
    const indent = depth * 16 + 4;
    const guides = this.renderGuides(depth);
    const label = (t('sidebarTreeMore') || '还有 {n} 项,加载更多').replace('{n}', String(remaining));
    return `<li class="tree-node tree-more" data-more-parent="${escapeHtml(parentMarker)}" style="padding-left:${indent}px">
      ${guides}<span class="tree-chevron"></span><span class="tree-more-label">${escapeHtml(label)}</span>
    </li>`;
  }

  /** Render vertical indent guide lines for the given depth */
  private renderGuides(depth: number): string {
    let guides = '';
    for (let i = 0; i < depth; i++) {
      guides += `<span class="tree-indent-guide" style="left:${i * 16 + 11}px"></span>`;
    }
    return guides;
  }

  private renderSingleNode(node: FileTreeNode): string {
    const indent = node.depth * 16;
    const icon = getFileIcon(node.name, node.isDir, node.isLink);
    const selected = this.selectedPaths.has(node.path) ? ' selected' : '';

    let chevron: string;
    if (node.isDir) {
      const chevronSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5l4.5 4.5L6 12.5"/></svg>';
      chevron = node.expanded
          ? `<span class="tree-chevron expanded">${chevronSvg}</span>`
          : `<span class="tree-chevron">${chevronSvg}</span>`;
    } else {
      chevron = '<span class="tree-chevron"></span>';
    }

    const guides = this.renderGuides(node.depth);

    return `<li class="tree-node${node.isDir ? ' dir' : ' file'}${selected}"
      data-path="${escapeHtml(node.path)}" data-is-dir="${node.isDir}"
      style="padding-left:${indent + 4}px">
      ${guides}${chevron}<span class="tree-icon">${icon}</span><span class="tree-name" title="${escapeHtml(node.path)}">${escapeHtml(node.name)}</span>
    </li>`;
  }


  private updateSelection(): void {
    this.container.querySelectorAll('.tree-node').forEach(el => {
      const path = (el as HTMLElement).dataset.path;
      el.classList.toggle('selected', !!path && this.selectedPaths.has(path));
    });
  }

  private scrollToSelected(): void {
    if (this.selectedPaths.size === 0) return;
    const first = this.selectedPaths.values().next().value;
    if (!first) return;
    const el = this.container.querySelector(`[data-path="${CSS.escape(first)}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  private parentPath(path: string): string {
    const idx = path.lastIndexOf('/');
    if (idx <= 0) return '/';
    return path.substring(0, idx);
  }

  // ── Events ──

  private bindEvents(): void {
    const on = (type: string, handler: EventListener) => {
      this.container.addEventListener(type, handler);
      this.boundHandlers.push({ type, handler });
    };

    // Click: select (with Ctrl/Shift multi-select)
    on('click', ((e: MouseEvent) => {
      if (this.suppressClick) { this.suppressClick = false; return; }

      // 拦截"加载更多"节点:扩大对应父节点的 renderedCount 并重渲染
      const moreEl = (e.target as HTMLElement).closest('.tree-more') as HTMLElement | null;
      if (moreEl) {
        const parentMarker = moreEl.dataset.moreParent || '';
        if (parentMarker === ROOT_MORE_MARKER) {
          this.rootRenderedCount += TREE_PAGE_SIZE;
        } else {
          const parentNode = this.nodeMap.get(parentMarker);
          if (parentNode) {
            parentNode.renderedCount = (parentNode.renderedCount ?? TREE_PAGE_SIZE) + TREE_PAGE_SIZE;
          }
        }
        this.render();
        return;
      }

      const target = (e.target as HTMLElement).closest('.tree-node') as HTMLElement | null;
      if (!target) return;
      const path = target.dataset.path!;
      const node = this.nodeMap.get(path);
      if (!node) return;

      // Chevron click → toggle expand only
      if ((e.target as HTMLElement).closest('.tree-chevron') && node.isDir) {
        this.toggleExpand(node);
        return;
      }

      const isMeta = e.ctrlKey || e.metaKey;
      const isShift = e.shiftKey;

      if (isShift && this.lastClickedPath) {
        // Range select
        const startIdx = this.visibleOrder.indexOf(this.lastClickedPath);
        const endIdx = this.visibleOrder.indexOf(path);
        if (startIdx >= 0 && endIdx >= 0) {
          const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
          if (!isMeta) this.selectedPaths.clear();
          for (let i = lo; i <= hi; i++) {
            this.selectedPaths.add(this.visibleOrder[i]);
          }
        }
      } else if (isMeta) {
        // Toggle single
        if (this.selectedPaths.has(path)) {
          this.selectedPaths.delete(path);
        } else {
          this.selectedPaths.add(path);
        }
        this.lastClickedPath = path;
      } else {
        // Normal click
        this.selectedPaths.clear();
        this.selectedPaths.add(path);
        this.lastClickedPath = path;
      }

      this.updateSelection();
      this.callbacks.onSelect(node);
    }) as EventListener);

    // Double-click
    on('dblclick', ((e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('.tree-node') as HTMLElement | null;
      if (!target || target.classList.contains('tree-more')) return;
      const path = target.dataset.path!;
      const node = this.nodeMap.get(path);
      if (!node) return;
      if (node.isDir) {
        this.toggleExpand(node);
      } else {
        this.callbacks.onOpen(node);
      }
    }) as EventListener);

    // Context menu
    on('contextmenu', ((e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('.tree-node') as HTMLElement | null;
      if (!target || target.classList.contains('tree-more')) return;
      e.preventDefault();
      const path = target.dataset.path!;
      const node = this.nodeMap.get(path);
      if (!node) return;
      if (!this.selectedPaths.has(path)) {
        this.selectedPaths.clear();
        this.selectedPaths.add(path);
        this.lastClickedPath = path;
        this.updateSelection();
      }
      this.callbacks.onContextMenu(node, e);
    }) as EventListener);

    // ── Custom drag & drop (mouse-event based for full animation control) ──
    this.setupDragMove();
  }

  // ── Drag & drop system (mousedown/mousemove/mouseup) ──

  private setupDragMove(): void {
    let dragState: {
      paths: string[];
      startX: number;
      startY: number;
      ghost: HTMLElement | null;
      active: boolean;           // true after threshold exceeded
      currentDropTarget: string | null;
      hoverTimer: ReturnType<typeof setTimeout> | null;
    } | null = null;

    const DRAG_THRESHOLD = 5; // px before drag activates
    const HOVER_EXPAND_DELAY = 600; // ms before auto-expand directory

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // left click only
      const nodeEl = (e.target as HTMLElement).closest('.tree-node') as HTMLElement | null;
      if (!nodeEl || nodeEl.classList.contains('tree-more')) return;
      // Don't start drag from chevron
      if ((e.target as HTMLElement).closest('.tree-chevron')) return;

      const path = nodeEl.dataset.path!;
      let paths: string[];
      if (this.selectedPaths.has(path) && this.selectedPaths.size > 1) {
        paths = [...this.selectedPaths];
      } else {
        paths = [path];
      }

      dragState = {
        paths,
        startX: e.clientX,
        startY: e.clientY,
        ghost: null,
        active: false,
        currentDropTarget: null,
        hoverTimer: null,
      };
      this.activeDragPaths = paths;

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    const createGhost = (paths: string[], x: number, y: number): HTMLElement => {
      const ghost = document.createElement('div');
      ghost.className = 'tree-drag-ghost';

      const firstName = paths[0].split('/').pop() || '';
      const node = this.nodeMap.get(paths[0]);
      const iconHtml = node ? getFileIcon(node.name, node.isDir, node.isLink) : '';

      ghost.innerHTML = `
        <span class="tree-drag-ghost-icon">${iconHtml}</span>
        <span class="tree-drag-ghost-name">${escapeHtml(firstName)}</span>
        ${paths.length > 1 ? `<span class="tree-drag-ghost-badge">+${paths.length - 1}</span>` : ''}
      `;
      ghost.style.left = `${x + 12}px`;
      ghost.style.top = `${y - 10}px`;
      document.body.appendChild(ghost);
      this.activeDragGhost = ghost;
      return ghost;
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!dragState) return;

      if (!dragState.active) {
        const dx = e.clientX - dragState.startX;
        const dy = e.clientY - dragState.startY;
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;

        // Activate drag
        dragState.active = true;
        dragState.ghost = createGhost(dragState.paths, e.clientX, e.clientY);
        document.body.style.userSelect = 'none';
        (document.body.style as any).webkitUserSelect = 'none';

        // Mark source nodes
        for (const p of dragState.paths) {
          const el = this.container.querySelector(`[data-path="${CSS.escape(p)}"]`);
          if (el) el.classList.add('drag-source');
        }
        document.body.style.cursor = 'grabbing';
      }

      // Update ghost position
      if (dragState.ghost) {
        dragState.ghost.style.left = `${e.clientX + 12}px`;
        dragState.ghost.style.top = `${e.clientY - 10}px`;
      }

      // Find drop target under cursor
      // Temporarily hide ghost to hit-test below it
      if (dragState.ghost) dragState.ghost.style.pointerEvents = 'none';
      const elemUnder = document.elementFromPoint(e.clientX, e.clientY);
      if (dragState.ghost) dragState.ghost.style.pointerEvents = '';

      const nodeUnder = elemUnder?.closest('.tree-node') as HTMLElement | null;
      const prevTarget = dragState.currentDropTarget;

      // Clear old highlight
      if (prevTarget) {
        const prevEl = this.container.querySelector(`[data-path="${CSS.escape(prevTarget)}"]`);
        if (prevEl) prevEl.classList.remove('drop-target');
      }

      if (nodeUnder && this.container.contains(nodeUnder)) {
        const targetPath = nodeUnder.dataset.path!;
        const isDir = nodeUnder.dataset.isDir === 'true';
        const isValidDrop = isDir
          && !dragState.paths.includes(targetPath)
          && !dragState.paths.some(p => targetPath.startsWith(p + '/'));

        if (isValidDrop) {
          nodeUnder.classList.add('drop-target');
          dragState.currentDropTarget = targetPath;

          // Auto-expand directory on hover
          if (targetPath !== prevTarget) {
            if (dragState.hoverTimer) clearTimeout(dragState.hoverTimer);
            dragState.hoverTimer = setTimeout(() => {
              const node = this.nodeMap.get(targetPath);
              if (node && node.isDir && !node.expanded) {
                this.expandOnly(node);
              }
            }, HOVER_EXPAND_DELAY);
          }
        } else {
          dragState.currentDropTarget = null;
          if (dragState.hoverTimer) { clearTimeout(dragState.hoverTimer); dragState.hoverTimer = null; }
        }
      } else {
        dragState.currentDropTarget = null;
        if (dragState.hoverTimer) { clearTimeout(dragState.hoverTimer); dragState.hoverTimer = null; }
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      if (!dragState) return;
      const state = dragState;
      dragState = null;

      if (state.hoverTimer) clearTimeout(state.hoverTimer);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      (document.body.style as any).webkitUserSelect = '';

      if (!state.active) return; // drag threshold not reached, let click handle it

      // Suppress the next click event (from mouseup)
      this.suppressClick = true;
      setTimeout(() => { this.suppressClick = false; }, 50);

      const destDir = state.currentDropTarget;

      // Clean up source styling
      this.container.querySelectorAll('.drag-source, .drop-target').forEach(el => {
        el.classList.remove('drag-source', 'drop-target');
      });

      if (destDir && state.ghost) {
        // Drop animation: ghost slides toward target
        const targetEl = this.container.querySelector(`[data-path="${CSS.escape(destDir)}"]`);
        if (targetEl) {
          const targetRect = targetEl.getBoundingClientRect();
          state.ghost.style.transition = 'all 0.2s ease-in';
          state.ghost.style.left = `${targetRect.left + 20}px`;
          state.ghost.style.top = `${targetRect.top}px`;
          state.ghost.style.opacity = '0.3';
          state.ghost.style.transform = 'scale(0.7)';
          setTimeout(() => {
            state.ghost?.remove();
            const validPaths = state.paths.filter(p =>
              p !== destDir && !destDir.startsWith(p + '/')
            );
            if (validPaths.length > 0) {
              this.showMoveConfirm(validPaths, destDir);
            }
          }, 200);
          this.activeDragPaths = [];
          return;
        }
      }

      // Check if dropped onto breadcrumb area
      if (state.ghost) state.ghost.style.pointerEvents = 'none';
      const elemUnder = document.elementFromPoint(e.clientX, e.clientY);
      if (state.ghost) state.ghost.style.pointerEvents = '';

      const breadcrumbEl = elemUnder?.closest('.sidebar-breadcrumb, .sidebar-header');
      if (breadcrumbEl && this.callbacks.onDropToRoot) {
        // Find first directory in dragged paths
        const dirPath = state.paths.find(p => this.nodeMap.get(p)?.isDir);
        if (dirPath) {
          // Animate ghost toward breadcrumb
          if (state.ghost) {
            const bcRect = breadcrumbEl.getBoundingClientRect();
            state.ghost.style.transition = 'all 0.2s ease-in';
            state.ghost.style.left = `${bcRect.left + 10}px`;
            state.ghost.style.top = `${bcRect.top}px`;
            state.ghost.style.opacity = '0.3';
            state.ghost.style.transform = 'scale(0.7)';
            setTimeout(() => {
              state.ghost?.remove();
              this.callbacks.onDropToRoot!(dirPath);
            }, 200);
          } else {
            this.callbacks.onDropToRoot(dirPath);
          }
          this.activeDragPaths = [];
          return;
        }
      }

      // Check if dropped onto terminal area
      const terminalEl = elemUnder?.closest('#terminal-panel, .xterm, .terminal-area');
      if (terminalEl && this.callbacks.onDropToTerminal) {
        const dirPath = state.paths.find(p => this.nodeMap.get(p)?.isDir);
        if (dirPath) {
          if (state.ghost) {
            state.ghost.style.transition = 'all 0.15s ease-in';
            state.ghost.style.opacity = '0';
            state.ghost.style.transform = 'scale(0.8)';
            setTimeout(() => state.ghost?.remove(), 150);
          }
          this.callbacks.onDropToTerminal(dirPath);
          this.activeDragPaths = [];
          return;
        }
      }

      // Cancel / invalid drop: ghost fades out and returns
      if (state.ghost) {
        state.ghost.style.transition = 'all 0.2s ease-out';
        state.ghost.style.left = `${state.startX}px`;
        state.ghost.style.top = `${state.startY}px`;
        state.ghost.style.opacity = '0';
        setTimeout(() => state.ghost?.remove(), 200);
      }
      this.activeDragPaths = [];
    };

    this.container.addEventListener('mousedown', onMouseDown);
    this.boundHandlers.push({ type: 'mousedown', handler: onMouseDown as EventListener });
  }

  // ── Move confirmation dialog ──

  private showMoveConfirm(sourcePaths: string[], destDir: string): void {
    // Prevent duplicate dialogs
    if (document.querySelector('.drawer-modal-overlay[data-tree-move]')) return;

    const overlay = document.createElement('div');
    overlay.className = 'drawer-modal-overlay';
    // Override absolute → fixed for full-screen overlay (class has display:flex + centering)
    overlay.dataset.treeMove = '';
    overlay.style.position = 'fixed';
    overlay.style.zIndex = '10000';
    overlay.style.backdropFilter = 'blur(4px)';
    (overlay.style as any).webkitBackdropFilter = 'blur(4px)';

    const names = sourcePaths.map(p => p.split('/').pop() || p);
    const titleText = t('sidebarMoveTitle').replace('{count}', String(names.length));

    overlay.innerHTML = `
      <div class="drawer-modal" style="width:clamp(280px,50vw,420px)">
        <div class="drawer-modal-title">${escapeHtml(titleText)}</div>
        <div class="drawer-modal-desc" style="font-size:11px;color:var(--text-muted);margin-bottom:8px;max-height:120px;overflow-y:auto">
          ${names.map(n => `<div style="padding:1px 0">• ${escapeHtml(n)}</div>`).join('')}
        </div>
        <div style="font-size:11px;margin-bottom:10px">
          → <span style="color:var(--accent,#6aa4ff);word-break:break-all">${escapeHtml(destDir)}</span>
        </div>
        <div class="drawer-modal-buttons">
          <button class="drawer-modal-btn btn-cancel">${escapeHtml(t('sidebarMoveCancel'))}</button>
          <button class="drawer-modal-btn confirm btn-confirm">${escapeHtml(t('sidebarMoveConfirm'))}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();

    overlay.querySelector('.btn-cancel')!.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    overlay.querySelector('.btn-confirm')!.addEventListener('click', async () => {
      close();
      if (this.callbacks.onMove) {
        await this.callbacks.onMove(sourcePaths, destDir);
      }
    });
  }
}
