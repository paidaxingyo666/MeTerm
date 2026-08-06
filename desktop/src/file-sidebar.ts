/**
 * file-sidebar.ts — Left sidebar file manager (tree view)
 *
 * Manages creation, mounting, show/hide, resize of the sidebar.
 * Works alongside the existing bottom drawer — user can switch between modes.
 */

import type { DrawerInstance } from './drawer';
import { DrawerManager } from './drawer';
import { FileTreeRenderer } from './file-tree';
import { TerminalRegistry } from './terminal';
import { setupContextMenu } from './drawer-context-menu';
import { loadSettings, saveSettings } from './themes';
import { escapeHtml } from './status-bar';
import { formatSize, formatSpeed, formatElapsed, quotePosixShellArg } from './file-utils';
import { t } from './i18n';
import type { TransferRecord } from './file-transfer-history';
import { isEditableFile } from './icons';
import { openFileInEditor } from './file-editor-bridge';
import { isImageFile } from './file-editor-md';
import { invoke } from '@tauri-apps/api/core';
import { MsgInput } from './protocol';
import { SidebarSearchController } from './file-sidebar-search';

// ── Types ──

interface SidebarInstance {
  sessionId: string;
  element: HTMLDivElement;
  /** Resize handle — independent flex element between sidebar and terminal */
  resizeHandle: HTMLDivElement;
  tree: FileTreeRenderer;
  isOpen: boolean;
  width: number;
  /** Root directory is locked (true = don't follow terminal CWD) */
  locked: boolean;
  /** Unsubscribe from shell state listener */
  cwdUnsubscribe: (() => void) | null;
  /** Last known CWD from terminal */
  lastCwd: string;
  /** Whether tree root has been loaded at least once */
  rootLoaded: boolean;
  /** Whether loadTreeRoot is in progress (waiting for connection/SFTP) */
  rootLoading: boolean;
  /** Current root path for breadcrumb re-render on resize */
  currentRootPath: string;
  /**
   * Whether the tree root should auto-follow FileManager's currentPath.
   * Starts true so JumpServer auto-cd (root → asset dir) is picked up
   * even when the sidebar was opened mid-connection. Set to false once
   * the user manually navigates the tree (breadcrumb edit, lock toggle).
   */
  followingFm: boolean;
  /** Unsubscribe from FileManager's path-changed observers. */
  fmPathUnsub: (() => void) | null;
  /** Recursive-search controller for the sidebar search row. */
  search: SidebarSearchController | null;
}

// ── SidebarManagerClass ──

class SidebarManagerClass {
  private sidebars = new Map<string, SidebarInstance>();
  private readonly MIN_WIDTH = 120;   // shared with the connection sidebar
  private readonly MAX_WIDTH_RATIO = 0.5;
  private readonly DEFAULT_WIDTH = 280;

  constructor() {
    // Listen for FileManager connection ready events
    window.addEventListener('meterm-fm-connected', ((e: CustomEvent) => {
      this.onFmConnected(e.detail.sessionId);
    }) as EventListener);
    // Listen for drawer/session destroy events
    window.addEventListener('meterm-drawer-destroyed', ((e: CustomEvent) => {
      this.destroy(e.detail.sessionId);
    }) as EventListener);
    // Listen for file operations to refresh sidebar tree.
    // For "create" ops (mkdir/touch) we additionally reveal the parent so
    // the new item is visible even if the parent wasn't previously expanded.
    window.addEventListener('meterm-file-op-done', ((e: Event) => {
      const ce = e as CustomEvent<{ sessionId: string; operation?: string; path?: string }>;
      const inst = this.sidebars.get(ce.detail.sessionId);
      if (!inst?.isOpen) return;
      const { operation, path } = ce.detail || {};
      void (async () => {
        await inst.tree.refreshAll();
        if ((operation === 'mkdir' || operation === 'touch') && typeof path === 'string' && path) {
          const parentDir = path.substring(0, path.lastIndexOf('/')) || '/';
          try { await inst.tree.revealPath(parentDir); } catch { /* ignore */ }
        }
      })();
    }) as EventListener);
  }

  /** Create sidebar for a session (reuses FileManager from DrawerManager) */
  create(sessionId: string): SidebarInstance | null {
    if (this.sidebars.has(sessionId)) {
      return this.sidebars.get(sessionId)!;
    }

    const drawerInst = this.getDrawerInstance(sessionId);
    if (!drawerInst?.fileManager) return null;

    const settings = loadSettings();
    const savedWidth = settings.sidebarWidth > 0
      ? Math.max(this.MIN_WIDTH, Math.min(560, settings.sidebarWidth))
      : this.DEFAULT_WIDTH;

    const element = this.createSidebarElement(sessionId);
    const treeContainer = element.querySelector('.sidebar-tree-container') as HTMLElement;
    const fileManager = drawerInst.fileManager;

    const tree = new FileTreeRenderer(treeContainer, {
      onLoadChildren: (path, forceRefresh) =>
        fileManager.loadDirectoryRaw(path, { bypassCache: forceRefresh }).then(r => r.files),
      onSelect: (_node) => {
        // Sync full multi-selection from tree to FileManager
        fileManager.selectedFiles.clear();
        for (const p of tree.getSelectedPaths()) {
          fileManager.selectedFiles.add(p);
        }
        fileManager.lastClickedFile = _node.name;
        // Update status bar with selection info
        this.updateSelectionInfo(instance, tree);
      },
      onOpen: (node) => {
        if (node.isDir) return;
        const pref = loadSettings().fileOpenPreference;
        const editable = isEditableFile(node.name) || isImageFile(node.name);
        const isLocal = drawerInst.executorType === 'local';

        if (editable && pref === 'builtin') {
          // Open in built-in editor
          const ws = fileManager.getWebSocket();
          const transport = (fileManager as any).transport as import('./terminal-transport').TerminalTransport | null;
          const conn = transport?.connected ? transport : ws;
          if (conn) {
            openFileInEditor(sessionId, node.path, node.name, node.size, conn,
              drawerInst.serverConnectionInfo?.host);
          }
        } else if (isLocal) {
          // Local: open with system default
          invoke('open_path', { path: node.path }).catch(() => {});
        } else {
          // Remote non-editable: download
          fileManager.downloadFilePublic(node.name, false);
        }
      },
      onContextMenu: (_node, event) => { void event; },
      onDropToRoot: (dirPath) => {
        this.setTreeRootAndLock(instance, dirPath);
      },
      onDropToTerminal: (dirPath) => {
        // Send cd command to terminal
        const shellPath = quotePosixShellArg(dirPath);
        if (shellPath === null) {
          import('./notify').then(({ showToast }) => {
            showToast({
              title: t('ctxMenuTerminalOps'),
              body: '路径包含终端控制字符，无法安全地填入命令。',
            });
          }).catch(() => {});
          return;
        }
        const cmd = `cd ${shellPath}\n`;
        const ws = fileManager.getWebSocket();
        if (ws && ws.readyState === WebSocket.OPEN) {
          const payload = new TextEncoder().encode('\x15' + cmd);
          const msg = new Uint8Array(1 + payload.length);
          msg[0] = MsgInput;
          msg.set(payload, 1);
          ws.send(msg);
        } else {
          // IPC transport
          const transport = (fileManager as any).transport as import('./terminal-transport').TerminalTransport | null;
          if (transport?.connected) {
            const payload = new TextEncoder().encode('\x15' + cmd);
            const msg = new Uint8Array(1 + payload.length);
            msg[0] = MsgInput;
            msg.set(payload, 1);
            transport.send(msg);
          }
        }
      },
      onMove: async (sourcePaths, destDir) => {
        for (const srcPath of sourcePaths) {
          const fileName = srcPath.split('/').pop() || '';
          const destPath = destDir.endsWith('/')
            ? `${destDir}${fileName}` : `${destDir}/${fileName}`;
          await fileManager.moveFileByPath(srcPath, destPath);
        }
        // No explicit refreshAll here — the rename response fires
        // `meterm-file-op-done` which already triggers refreshAll on
        // the sidebar. Calling refreshAll again here used to race the
        // event-driven refresh and collapsed every expanded node.
        return true;
      },
    });

    // Create independent resize handle (between sidebar and terminal, like AI panel)
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'sidebar-resize-handle';
    resizeHandle.style.display = 'none';

    const instance: SidebarInstance = {
      sessionId,
      element,
      resizeHandle,
      tree,
      isOpen: false,
      width: savedWidth,
      locked: false,  // Default: unlocked (follow terminal CWD)
      cwdUnsubscribe: null,
      lastCwd: '',
      rootLoaded: false,
      rootLoading: false,
      currentRootPath: '/',
      followingFm: true,
      fmPathUnsub: null,
      search: null,
    };

    this.sidebars.set(sessionId, instance);

    // Recursive search row (server-side: walkdir local / read_dir SFTP+JumpServer).
    const searchRow = element.querySelector('.sidebar-search-row') as HTMLElement;
    const searchInput = element.querySelector('.sidebar-search-input') as HTMLInputElement;
    const searchClear = element.querySelector('.sidebar-search-clear') as HTMLButtonElement;
    const searchResults = element.querySelector('.sidebar-search-results') as HTMLElement;
    const searchBtn = element.querySelector('.btn-sidebar-search') as HTMLButtonElement | null;
    if (searchRow && searchInput && searchClear && searchResults) {
      instance.search = new SidebarSearchController({
        rowEl: searchRow,
        input: searchInput,
        clearBtn: searchClear,
        resultsContainer: searchResults,
        treeContainer,
        getFileManager: () => fileManager,
        getRootPath: () => instance.currentRootPath,
        revealPath: (p) => instance.tree.revealPath(p),
      });
      // Toolbar search button (right of the lock button) toggles the row.
      searchBtn?.addEventListener('click', () => {
        const open = instance.search!.toggle();
        searchBtn.classList.toggle('active', open);
      });
    }

    this.setupResizeHandle(instance);
    this.setupToolbar(instance, drawerInst);
    this.setupDragDrop(instance, drawerInst);
    this.setupCwdTracking(instance);

    // Overlay scrollbars for tree and transfer list
    import('./overlay-scrollbar').then(({ createOverlayScrollbar }) => {
      const transferList = element.querySelector('.sidebar-transfer-list') as HTMLElement;
      createOverlayScrollbar({ viewport: treeContainer, container: treeContainer });
      if (transferList) createOverlayScrollbar({ viewport: transferList, container: transferList });
    });
    setupContextMenu(drawerInst, treeContainer, undefined, {
      getCurrentDir: () => instance.currentRootPath,
      // 文件夹右键 → "设为根目录"，等同拖入面包屑设根
      onSetAsRoot: (path) => this.setTreeRootAndLock(instance, path),
    });

    // Scroll-edge feather for the tree (like the connection sidebar list): top/bottom
    // fade only when it overflows — no top fade at the very top (first item stays
    // crisp), no bottom fade at the very bottom. Recompute on scroll, resize, and tree
    // content changes (expand/collapse/navigate mutate the DOM).
    const updateTreeFade = (): void => {
      const overflow = treeContainer.clientHeight > 0 && treeContainer.scrollHeight > treeContainer.clientHeight + 1;
      treeContainer.classList.toggle('is-faded', overflow);
      treeContainer.classList.toggle('at-top', treeContainer.scrollTop <= 0);
      treeContainer.classList.toggle('at-bottom', treeContainer.scrollTop + treeContainer.clientHeight >= treeContainer.scrollHeight - 1);
    };
    treeContainer.addEventListener('scroll', updateTreeFade, { passive: true });
    new ResizeObserver(updateTreeFade).observe(treeContainer);
    new MutationObserver(() => requestAnimationFrame(updateTreeFade)).observe(treeContainer, { childList: true, subtree: true });
    requestAnimationFrame(updateTreeFade);

    element.style.setProperty('--sidebar-width', `${savedWidth}px`);

    return instance;
  }

  mountTo(sessionId: string, container: HTMLElement): void {
    const instance = this.sidebars.get(sessionId);
    if (!instance) return;
    const terminalPanel = container.querySelector('#terminal-panel');
    if (instance.element.parentElement !== container) {
      if (terminalPanel) {
        container.insertBefore(instance.resizeHandle, terminalPanel);
        container.insertBefore(instance.element, instance.resizeHandle);
      } else {
        container.appendChild(instance.element);
        container.appendChild(instance.resizeHandle);
      }
    }
  }

  show(sessionId: string): void {
    const instance = this.sidebars.get(sessionId);
    if (!instance) return;
    instance.element.style.display = '';
    instance.resizeHandle.style.display = '';
    // Trigger open animation next frame
    requestAnimationFrame(() => {
      instance.element.classList.add('open');
    });
    instance.isOpen = true;

    if (!instance.rootLoaded && !instance.rootLoading) {
      this.loadTreeRoot(instance);
    }
  }

  /** Called when FileManager connection is ready (from drawer _afterConnect event) */
  private onFmConnected(sessionId: string): void {
    const instance = this.sidebars.get(sessionId);
    if (!instance || instance.rootLoaded || !instance.isOpen) return;
    if (!instance.rootLoading) {
      this.loadTreeRoot(instance);
    }
  }

  hideAll(): void {
    this.sidebars.forEach(inst => {
      inst.element.classList.remove('open');
      inst.element.style.display = 'none';
      inst.resizeHandle.style.display = 'none';
    });
  }

  toggle(sessionId: string): void {
    const instance = this.sidebars.get(sessionId);
    if (!instance) return;
    const willOpen = !instance.isOpen;
    instance.isOpen = willOpen;
    if (willOpen) {
      // Re-read the SHARED width (the connection sidebar may have changed it).
      const sw = loadSettings().sidebarWidth;
      if (sw > 0) {
        instance.width = Math.max(this.MIN_WIDTH, Math.min(560, sw));
        instance.element.style.setProperty('--sidebar-width', `${instance.width}px`);
      }
      instance.element.style.display = '';
      instance.resizeHandle.style.display = '';
      instance.element.classList.add('open');
      if (!instance.rootLoaded) this.loadTreeRoot(instance);
    } else {
      instance.element.classList.remove('open');
      instance.element.style.display = 'none';
      instance.resizeHandle.style.display = 'none';
    }
    TerminalRegistry.resizeAll();
  }

  /** Hide instantly — used when switching to the connection sidebar. */
  closeImmediate(sessionId: string): void {
    const instance = this.sidebars.get(sessionId);
    if (!instance) return;
    instance.element.classList.remove('open');
    instance.element.style.display = 'none';
    instance.resizeHandle.style.display = 'none';
    instance.isOpen = false;
    TerminalRegistry.resizeAll();
  }

  has(sessionId: string): boolean {
    return this.sidebars.has(sessionId);
  }

  isOpen(sessionId: string): boolean {
    return this.sidebars.get(sessionId)?.isOpen ?? false;
  }

  /** 返回当前处于打开状态的侧边栏 session id 列表（用于 PiP 进入/退出时保存与恢复） */
  getOpenSessionIds(): string[] {
    const ids: string[] = [];
    this.sidebars.forEach((inst, sid) => {
      if (inst.isOpen) ids.push(sid);
    });
    return ids;
  }

  /**
   * 仅修改 isOpen 标记，不触碰 DOM。用于非活跃 tab 的侧边栏：
   * 切换回那个 tab 时 view-manager 会基于 isOpen 自动 show，
   * 这样不会让多个 tab 的侧边栏元素同时出现在主内容区。
   */
  markOpen(sessionId: string, open: boolean): void {
    const instance = this.sidebars.get(sessionId);
    if (!instance) return;
    instance.isOpen = open;
  }

  destroy(sessionId: string): void {
    const instance = this.sidebars.get(sessionId);
    if (!instance) return;
    instance.cwdUnsubscribe?.();
    instance.fmPathUnsub?.();
    instance.fmPathUnsub = null;
    instance.search?.destroy();
    instance.tree.destroy();
    instance.resizeHandle.remove();
    instance.element.remove();
    this.sidebars.delete(sessionId);
  }

  async refreshTree(sessionId: string): Promise<void> {
    const instance = this.sidebars.get(sessionId);
    if (!instance) return;
    await instance.tree.refreshAll();
  }

  /** Rename a tree node optimistically — see FileTreeRenderer.renameNodeInPlace.
   *  The drawer-context-menu's rename dialog calls this *before* sending the
   *  rename to the server so the user gets instant visual feedback. The
   *  refreshAll that fires on the server response then reconciles. */
  optimisticRename(sessionId: string, oldPath: string, newName: string): void {
    const instance = this.sidebars.get(sessionId);
    if (!instance || !instance.isOpen) return;
    instance.tree.renameNodeInPlace(oldPath, newName);
  }

  // ── Private ──

  private getDrawerInstance(sessionId: string): DrawerInstance | null {
    return DrawerManager._getInstanceForSidebar(sessionId);
  }

  // ── DOM ──

  private createSidebarElement(sessionId: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'file-sidebar';
    el.dataset.sessionId = sessionId;
    el.style.display = 'none';

    el.innerHTML = `
      <div class="sidebar-header">
        <div class="sidebar-breadcrumb"></div>
        <div class="sidebar-actions">
          <button class="btn-sidebar-switch-mode" title="${t('sidebarSwitchView')}">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="2" width="14" height="12" rx="2"/><line x1="1" y1="10.5" x2="15" y2="10.5"/></svg>
          </button>
          <button class="btn-sidebar-transfers" title="传输列表">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 12V4M1.5 6.5L4 4l2.5 2.5"/><path d="M12 4v8M9.5 9.5L12 12l2.5-2.5"/>
            </svg>
          </button>
          <button class="btn-sidebar-lock" title="${t('sidebarUnlockRoot')}">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="7" width="10" height="7" rx="1.5"/>
              <path d="M5 7V5a3 3 0 0 1 6 0" />
            </svg>
          </button>
          <button class="btn-sidebar-search" title="搜索文件">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14" y2="14"/></svg>
          </button>
        </div>
      </div>
      <div class="sidebar-search-row" style="display:none">
        <span class="sidebar-search-icon"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14" y2="14"/></svg></span>
        <input class="sidebar-search-input" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" />
        <button class="sidebar-search-clear" type="button" tabindex="-1" style="display:none">&times;</button>
      </div>
      <div class="sidebar-tree-container"></div>
      <div class="sidebar-search-results styled-scrollbar" style="display:none"></div>
      <div class="sidebar-transfer-panel" style="display:none">
        <div class="sidebar-transfer-toolbar">
          <div class="sidebar-transfer-filters">
            <button class="stf-btn" data-filter="upload" title="上传">↑</button>
            <button class="stf-btn" data-filter="download" title="下载">↓</button>
            <button class="stf-btn" data-filter="active" title="进行中">●</button>
          </div>
          <button class="stf-clear" title="清空历史">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M5 2V1h6v1h4v1H1V2h4zm1 3v8h1V5H6zm3 0v8h1V5H9zM2 4l1 11h10l1-11H2z" fill="currentColor"/></svg>
          </button>
        </div>
        <div class="sidebar-transfer-list"></div>
      </div>
      <div class="sidebar-status">
        <span class="sidebar-file-count"></span>
        <span class="sidebar-selection-info"></span>
      </div>
    `;

    return el;
  }

  // ── Breadcrumb ──

  private updateBreadcrumb(instance: SidebarInstance, path: string): void {
    const bc = instance.element.querySelector('.sidebar-breadcrumb') as HTMLElement;
    if (!bc) return;
    instance.currentRootPath = path;
    bc.title = path;

    const parts = path.split('/').filter(Boolean);

    // Render full breadcrumb, then progressively truncate from left if overflowing
    const renderCrumbs = (skipCount: number): string => {
      let html = '';
      if (path.startsWith('/')) {
        html += `<span class="sb-crumb" data-path="/">/</span>`;
      }
      if (skipCount > 0) {
        // Each ".." is a separate clickable crumb pointing to its parent directory
        for (let s = 0; s < skipCount; s++) {
          const dotTargetPath = '/' + parts.slice(0, s + 1).join('/');
          html += `<span class="sb-crumb-sep">/</span>`;
          html += `<span class="sb-crumb" data-path="${escapeHtml(dotTargetPath)}">..</span>`;
        }
      }
      for (let i = skipCount; i < parts.length; i++) {
        const targetPath = '/' + parts.slice(0, i + 1).join('/');
        const isLast = i === parts.length - 1;
        html += `<span class="sb-crumb-sep">/</span>`;
        html += `<span class="sb-crumb${isLast ? ' active' : ''}" data-path="${escapeHtml(targetPath)}">${escapeHtml(parts[i])}</span>`;
      }
      return html;
    };

    // Start with full path, then skip more segments from left until it fits
    bc.innerHTML = renderCrumbs(0);
    // If not visible or fits, done
    if (bc.clientWidth === 0 || bc.scrollWidth <= bc.clientWidth) return;

    for (let skip = 1; skip < parts.length; skip++) {
      bc.innerHTML = renderCrumbs(skip);
      if (bc.scrollWidth <= bc.clientWidth || skip === parts.length - 1) {
        return;
      }
    }
  }

  private setupBreadcrumbClick(instance: SidebarInstance): void {
    const bc = instance.element.querySelector('.sidebar-breadcrumb') as HTMLElement;
    if (!bc) return;

    // Click: navigate to clicked crumb (but not the last/active one)
    bc.addEventListener('click', (e) => {
      const crumb = (e.target as HTMLElement).closest('.sb-crumb') as HTMLElement;
      if (!crumb?.dataset.path) return;
      if (crumb.classList.contains('active')) return; // Last segment: no click nav
      this.changeTreeRoot(instance, crumb.dataset.path);
    });

    // Double-click on breadcrumb: enter path editing mode
    bc.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const currentPath = instance.currentRootPath;

      // Replace breadcrumb with input
      const input = document.createElement('input');
      input.className = 'sidebar-path-input';
      input.value = currentPath;
      bc.innerHTML = '';
      bc.appendChild(input);
      input.focus();
      input.select();

      const restore = () => {
        this.updateBreadcrumb(instance, instance.currentRootPath);
      };

      const commit = () => {
        const newPath = input.value.trim();
        if (!newPath || newPath === currentPath) {
          restore();
          return;
        }
        // User explicitly chose a path — stop auto-following FileManager
        // so subsequent drawer / terminal cd events don't yank the tree
        // out from under them.
        instance.followingFm = false;
        // Try navigating to the entered path
        const drawerInst = this.getDrawerInstance(instance.sessionId);
        if (!drawerInst?.fileManager) { restore(); return; }

        // User explicitly typed a path — bypass cache so they see what's
        // actually there right now (cache could be up to 30s stale).
        drawerInst.fileManager.loadDirectoryRaw(newPath, { bypassCache: true }).then((result) => {
          instance.tree.setRoot(result.path, result.files);
          instance.currentRootPath = result.path;
          this.updateBreadcrumb(instance, result.path);
          this.updateStatusCount(instance, result.files.length);
        }).catch(() => {
          // Invalid path: restore previous breadcrumb
          restore();
        });
      };

      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        if (ev.key === 'Escape') { ev.preventDefault(); restore(); }
      });
      input.addEventListener('blur', () => {
        // Small delay to allow Enter keydown to fire first
        setTimeout(commit, 100);
      });
    });
  }

  // ── CWD tracking ──

  private setupCwdTracking(instance: SidebarInstance): void {
    const unsub = TerminalRegistry.onShellIdle(instance.sessionId, () => {
      const mt = TerminalRegistry.get(instance.sessionId);
      if (!mt) return;
      const cwd = mt.shellState.cwd;
      if (!cwd || cwd === instance.lastCwd) return;
      instance.lastCwd = cwd;

      if (!instance.isOpen) return;

      if (instance.locked) {
        // Locked: don't follow CWD, stay on current root
        return;
      }
      // Unlocked: follow terminal CWD, change tree root (fresh listing —
      // user just `cd`'d so they probably modified state).
      this.changeTreeRoot(instance, cwd, { bypassCache: true });
    });
    instance.cwdUnsubscribe = unsub;
  }

  /**
   * Re-root the tree at `path`. `bypassCache` controls whether the
   * underlying SFTP listing is forced fresh:
   *   - terminal CWD tracking / breadcrumb edit / drag-to-breadcrumb /
   *     lock toggle → true (user did something, give fresh data)
   *   - FileManager auto-follow (e.g. JumpServer auto-cd) → false
   *     (drawer just populated the cache, hit it for a near-instant render)
   */
  private async changeTreeRoot(
    instance: SidebarInstance,
    path: string,
    opts?: { bypassCache?: boolean },
  ): Promise<void> {
    const drawerInst = this.getDrawerInstance(instance.sessionId);
    if (!drawerInst?.fileManager) return;
    try {
      const result = await drawerInst.fileManager.loadDirectoryRaw(path, {
        bypassCache: opts?.bypassCache ?? false,
      });
      instance.tree.setRoot(result.path, result.files);
      instance.currentRootPath = result.path;
      this.updateBreadcrumb(instance, result.path);
      this.updateStatusCount(instance, result.files.length);
    } catch (err) {
      console.error('Failed to change sidebar root:', err);
    }
  }

  /**
   * Re-root the tree at `path` and auto-lock so terminal CWD changes don't
   * switch the user's chosen root away. Shared by drag-to-breadcrumb
   * (onDropToRoot) and the folder context menu ("Set as Root").
   */
  private setTreeRootAndLock(instance: SidebarInstance, path: string): void {
    this.changeTreeRoot(instance, path);
    if (!instance.locked) {
      instance.locked = true;
      this.syncLockButton(instance);
    }
  }

  private updateStatusCount(instance: SidebarInstance, count: number): void {
    const countEl = instance.element.querySelector('.sidebar-file-count');
    if (countEl) countEl.textContent = `${count} ${t('sidebarItems')}`;
    // Clear selection info when directory changes
    const selEl = instance.element.querySelector('.sidebar-selection-info');
    if (selEl) selEl.textContent = '';
  }

  private updateSelectionInfo(instance: SidebarInstance, tree: FileTreeRenderer): void {
    const selEl = instance.element.querySelector('.sidebar-selection-info');
    if (!selEl) return;
    const paths = tree.getSelectedPaths();
    if (paths.length === 0) {
      selEl.textContent = '';
      return;
    }
    if (paths.length > 1) {
      // Multi-select: show count summary
      let dirs = 0, files = 0, totalSize = 0;
      for (const p of paths) {
        const node = tree.getNode(p);
        if (!node) continue;
        if (node.isDir) dirs++; else { files++; totalSize += node.size; }
      }
      const parts: string[] = [];
      if (dirs > 0) parts.push(`${dirs} ${t('sidebarInfoDirs')}`);
      if (files > 0) parts.push(`${files} ${t('sidebarInfoFiles')}`);
      if (totalSize > 0) parts.push(formatSize(totalSize));
      selEl.textContent = parts.join('  ');
      return;
    }
    // Single selection
    const node = tree.getNode(paths[0]);
    if (!node) { selEl.textContent = ''; return; }
    if (node.isDir) {
      const childCount = node.children?.length;
      const parts: string[] = [];
      if (childCount != null) parts.push(`${childCount} ${t('sidebarItems')}`);
      parts.push(node.mode);
      selEl.textContent = parts.join('  ');
    } else {
      const mtime = new Date(node.mtime * 1000).toLocaleString();
      selEl.textContent = `${formatSize(node.size)}  ${mtime}  ${node.mode}`;
    }
  }

  // ── Resize ──

  private setupResizeHandle(instance: SidebarInstance): void {
    const handle = instance.resizeHandle;

    let startX = 0;
    let startWidth = 0;
    let isResizing = false;

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const delta = e.clientX - startX;
      const maxWidth = Math.min(560, window.innerWidth * this.MAX_WIDTH_RATIO);
      const newWidth = Math.min(maxWidth, Math.max(this.MIN_WIDTH, startWidth + delta));
      instance.width = newWidth;
      instance.element.style.setProperty('--sidebar-width', `${newWidth}px`);
    };

    const onMouseUp = () => {
      if (!isResizing) return;
      isResizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      instance.element.classList.remove('resizing');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      const s = loadSettings();
      saveSettings({ ...s, sidebarWidth: instance.width });
      TerminalRegistry.resizeAll();
      this.updateBreadcrumb(instance, instance.currentRootPath);
    };

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isResizing = true;
      startX = e.clientX;
      startWidth = instance.width;
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
      instance.element.classList.add('resizing');
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    const presets = [240, 320, 400];
    handle.addEventListener('dblclick', () => {
      const currentIdx = presets.findIndex(p => Math.abs(instance.width - p) < 20);
      const nextIdx = (currentIdx + 1) % presets.length;
      instance.width = presets[nextIdx];
      instance.element.style.setProperty('--sidebar-width', `${instance.width}px`);
      const s = loadSettings();
      saveSettings({ ...s, sidebarWidth: instance.width });
      TerminalRegistry.resizeAll();
      this.updateBreadcrumb(instance, instance.currentRootPath);
    });
  }

  // ── Toolbar ──

  private setupToolbar(instance: SidebarInstance, drawerInst: DrawerInstance): void {
    const fm = drawerInst.fileManager;
    if (!fm) return;

    // Breadcrumb click navigation
    this.setupBreadcrumbClick(instance);

    // Switch mode button (sidebar → drawer)
    instance.element.querySelector('.btn-sidebar-switch-mode')?.addEventListener('click', () => {
      import('./file-manager-toggle').then(({ switchFileManagerMode }) => {
        switchFileManagerMode(instance.sessionId);
      });
    });

    // Transfer list toggle（本地会话隐藏）
    const transferBtn = instance.element.querySelector('.btn-sidebar-transfers') as HTMLElement;
    const isLocal = drawerInst.executorType === 'local';
    if (isLocal) {
      transferBtn.style.display = 'none';
    } else {
      const treeContainer = instance.element.querySelector('.sidebar-tree-container') as HTMLElement;
      const transferPanel = instance.element.querySelector('.sidebar-transfer-panel') as HTMLElement;
      const statusBar = instance.element.querySelector('.sidebar-status') as HTMLElement;
      let transferPanelOpen = false;

      const showTransferPanel = () => {
        transferPanelOpen = true;
        treeContainer.style.display = 'none';
        transferPanel.style.display = '';
        if (statusBar) statusBar.style.display = 'none';
        transferBtn.classList.add('active');
        this.renderSidebarTransfers(instance);
      };

      const hideTransferPanel = () => {
        transferPanelOpen = false;
        treeContainer.style.display = '';
        transferPanel.style.display = 'none';
        if (statusBar) statusBar.style.display = '';
        transferBtn.classList.remove('active');
        // Refresh tree when switching back (uploads may have changed files)
        instance.tree.refreshAll();
      };

      transferBtn.addEventListener('click', () => {
        if (transferPanelOpen) hideTransferPanel();
        else showTransferPanel();
      });

      // Transfer panel filter buttons
      const filterContainer = instance.element.querySelector('.sidebar-transfer-filters');
      let activeTypeFilter: 'upload' | 'download' | null = null;
      let activeStatusFilter: 'active' | null = null;

      filterContainer?.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('.stf-btn') as HTMLElement | null;
        if (!btn) return;
        const filter = btn.dataset.filter;
        const wasActive = btn.classList.contains('active');
        // Deactivate all in same group
        if (filter === 'upload' || filter === 'download') {
          filterContainer.querySelectorAll('.stf-btn[data-filter="upload"], .stf-btn[data-filter="download"]')
            .forEach(b => b.classList.remove('active'));
          if (wasActive) { activeTypeFilter = null; }
          else { btn.classList.add('active'); activeTypeFilter = filter as 'upload' | 'download'; }
        } else if (filter === 'active') {
          if (wasActive) { btn.classList.remove('active'); activeStatusFilter = null; }
          else { btn.classList.add('active'); activeStatusFilter = 'active'; }
        }
        this.renderSidebarTransfers(instance, activeTypeFilter, activeStatusFilter);
      });

      // Clear button
      instance.element.querySelector('.stf-clear')?.addEventListener('click', () => {
        fm.clearTransferHistory();
        this.renderSidebarTransfers(instance, activeTypeFilter, activeStatusFilter);
      });

      // Listen for transfer progress updates — in-place update for smooth animation
      document.addEventListener('status-bar-transfer', ((e: CustomEvent) => {
        if (e.detail.sessionId !== instance.sessionId || !transferPanelOpen) return;
        const { id, progress, status } = e.detail;
        const listEl = instance.element.querySelector('.sidebar-transfer-list') as HTMLElement;
        if (!listEl) return;
        const item = listEl.querySelector(`[data-transfer-id="${id}"]`) as HTMLElement | null;
        if (!item || !item.classList.contains(status)) {
          // New item or status changed — full re-render
          this.renderSidebarTransfers(instance, activeTypeFilter, activeStatusFilter);
          return;
        }
        // In-place update: CSS transition 处理动画
        const fill = item.querySelector('.st-progress-fill') as HTMLElement | null;
        if (fill) fill.style.width = `${progress}%`;
        const pctEl = item.querySelector('.st-pct') as HTMLElement | null;
        if (pctEl) pctEl.textContent = `${Math.round(progress)}%`;
        const fm = drawerInst.fileManager;
        if (fm && status === 'inprogress') {
          const speedEl = item.querySelector('.st-speed') as HTMLElement | null;
          const speed = fm.getTransferSpeed(id);
          if (speedEl) speedEl.textContent = speed > 0 ? formatSpeed(speed) : '';
          // Update elapsed time
          const elapsedEl = item.querySelector('.st-elapsed') as HTMLElement | null;
          const record = fm.getTransferRecords(null, null).find((r: any) => r.id === id);
          if (elapsedEl && record?.startTime) elapsedEl.textContent = formatElapsed(Date.now() - record.startTime);
          // Update size (may have been 0 initially, now known from first chunk)
          const sizeEl = item.querySelector('.st-size') as HTMLElement | null;
          if (sizeEl && record && record.size > 0) sizeEl.textContent = formatSize(record.size);
        }
      }) as EventListener);
    }

    // Lock/unlock button
    const lockBtn = instance.element.querySelector('.btn-sidebar-lock') as HTMLElement;
    if (lockBtn) {
      lockBtn.addEventListener('click', () => {
        instance.locked = !instance.locked;
        this.syncLockButton(instance);
        if (!instance.locked) {
          // 解锁 = 重新跟随：恢复 FileManager 路径同步 + 立即同步一次
          instance.followingFm = true;
          const drawerInst = this.getDrawerInstance(instance.sessionId);
          const fmPath = drawerInst?.fileManager?.getCurrentPath();
          if (fmPath && fmPath !== instance.currentRootPath) {
            this.changeTreeRoot(instance, fmPath);
          } else if (instance.lastCwd && instance.lastCwd !== instance.currentRootPath) {
            this.changeTreeRoot(instance, instance.lastCwd);
          }
        }
      });
    }
  }

  /** 同步锁定按钮的视觉状态（class / title / svg） */
  private syncLockButton(instance: SidebarInstance): void {
    const lockBtn = instance.element.querySelector('.btn-sidebar-lock') as HTMLElement | null;
    if (!lockBtn) return;
    lockBtn.classList.toggle('active', instance.locked);
    lockBtn.title = instance.locked ? t('sidebarLockRoot') : t('sidebarUnlockRoot');
    if (instance.locked) {
      lockBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="7" width="10" height="7" rx="1.5"/>
        <path d="M5 7V5a3 3 0 0 1 6 0v2"/>
      </svg>`;
    } else {
      lockBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="7" width="10" height="7" rx="1.5"/>
        <path d="M5 7V5a3 3 0 0 1 6 0" />
      </svg>`;
    }
  }

  // ── Drag & drop ──
  // Sidebar drag-drop is handled by the global Tauri onDragDropEvent in FileManager.
  // The handler detects sidebar by checking elementFromPoint against .file-sidebar,
  // determines target directory from the tree node under cursor, and uploads there.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private setupDragDrop(_instance: SidebarInstance, _drawerInst: DrawerInstance): void {
    // Intentionally empty — handled globally in FileManager.initializeDragAndDrop
  }

  // ── Transfer panel rendering ──

  private renderSidebarTransfers(
    instance: SidebarInstance,
    typeFilter?: 'upload' | 'download' | null,
    statusFilter?: 'active' | null,
  ): void {
    const listEl = instance.element.querySelector('.sidebar-transfer-list') as HTMLElement;
    if (!listEl) return;
    const drawerInst = this.getDrawerInstance(instance.sessionId);
    const fm = drawerInst?.fileManager;
    if (!fm) { listEl.innerHTML = '<div class="st-empty">未连接</div>'; return; }

    const records = fm.getTransferRecords(typeFilter, statusFilter);
    if (records.length === 0) {
      listEl.innerHTML = '<div class="st-empty">暂无传输记录</div>';
      return;
    }

    listEl.innerHTML = records.map(r => this.renderTransferItem(r, fm)).join('');

    // Event delegation
    listEl.onclick = (e) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('[data-action]') as HTMLElement | null;
      if (!btn) return;
      const id = btn.dataset.id!;
      const action = btn.dataset.action!;
      if (action === 'pause') fm.pauseTransfer(id);
      else if (action === 'resume') fm.resumeTransfer(id);
      else if (action === 'cancel') fm.cancelTransfer(id);
      else if (action === 'delete') {
        fm.deleteTransferRecord(id);
        this.renderSidebarTransfers(instance, typeFilter, statusFilter);
      }
      else if (action === 'reveal') {
        const savePath = btn.dataset.savePath;
        if (savePath) {
          import('@tauri-apps/plugin-opener').then(({ revealItemInDir }) => {
            revealItemInDir(savePath).catch(() => {});
          });
        }
      }
    };
  }

  private renderTransferItem(r: TransferRecord, fm: import('./file-manager').FileManager): string {
    const icon = r.type === 'upload' ? '↑' : '↓';
    const statusMap: Record<string, string> = {
      pending: '等待中', inprogress: '传输中', completed: '已完成',
      failed: '失败', paused: '已暂停', cancelled: '已取消',
    };

    let actions = '';
    if (r.status === 'inprogress') {
      actions = `<button class="st-action" data-action="pause" data-id="${r.id}" title="暂停">⏸</button>`
        + `<button class="st-action" data-action="cancel" data-id="${r.id}" title="取消">✕</button>`;
    } else if (r.status === 'paused') {
      actions = `<button class="st-action" data-action="resume" data-id="${r.id}" title="继续">▶</button>`
        + `<button class="st-action" data-action="cancel" data-id="${r.id}" title="取消">✕</button>`;
    } else if (r.status === 'pending') {
      actions = `<button class="st-action" data-action="cancel" data-id="${r.id}" title="取消">✕</button>`;
    } else {
      actions = `<button class="st-action" data-action="delete" data-id="${r.id}" title="删除记录">✕</button>`;
    }

    const isActive = r.status === 'inprogress' || r.status === 'paused';
    let progressHtml = '';
    if (isActive) {
      progressHtml = `<div class="st-progress${r.status === 'paused' ? ' paused' : ''}"><div class="st-progress-fill${r.status === 'paused' ? ' paused' : ''}" style="width:${r.progress}%"></div></div>`;
    }

    let meta = '';
    if (r.status === 'inprogress') {
      const speed = fm.getTransferSpeed(r.id);
      // 始终创建 speed/elapsed 元素（即使初始为空），供 in-place 更新填充
      meta += `<span class="st-speed">${speed > 0 ? formatSpeed(speed) : ''}</span>`;
      meta += `<span class="st-elapsed">${r.startTime ? formatElapsed(Date.now() - r.startTime) : ''}</span>`;
    } else if ((r.status === 'completed' || r.status === 'failed' || r.status === 'paused' || r.status === 'cancelled') && r.startTime) {
      const end = r.endTime || Date.now();
      meta += `<span class="st-elapsed">${formatElapsed(end - r.startTime)}</span>`;
    }

    let revealHtml = '';
    if (r.type === 'download' && r.status === 'completed' && r.savePath) {
      revealHtml = `<button class="st-action st-reveal" data-action="reveal" data-id="${r.id}" data-save-path="${escapeHtml(r.savePath)}" title="${escapeHtml(r.savePath)}"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44L8.562 3.5H13.5A1.5 1.5 0 0 1 15 5v7.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9z" fill="currentColor"/></svg></button>`;
    }

    const date = new Date(r.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

    return `<div class="st-item ${r.status}" data-transfer-id="${r.id}">
      <div class="st-row">
        <span class="st-icon">${icon}</span>
        <span class="st-name" title="${escapeHtml(r.path)}">${escapeHtml(r.filename)}</span>
        <span class="st-size">${formatSize(r.size)}</span>
        <span class="st-actions">${revealHtml}${actions}</span>
      </div>
      ${progressHtml}
      <div class="st-row st-footer">
        <span class="st-status ${r.status}">${statusMap[r.status] || r.status}</span>
        ${isActive ? `<span class="st-pct">${Math.round(r.progress)}%</span>` : ''}
        ${meta}
        ${r.serverLabel && r.serverLabel !== 'local' ? `<span class="st-server" title="${escapeHtml(r.serverLabel)}">${escapeHtml(r.serverLabel.replace(/^[^@]*@/, '').replace(/:\d+$/, ''))}</span>` : ''}
        <span class="st-date">${date}</span>
      </div>
      ${r.error ? `<div class="st-error">${escapeHtml(r.error)}</div>` : ''}
    </div>`;
  }

  // ── Tree root loading ──

  private async loadTreeRoot(instance: SidebarInstance): Promise<void> {
    const drawerInst = this.getDrawerInstance(instance.sessionId);
    if (!drawerInst?.fileManager) return;
    instance.rootLoading = true;

    const fm = drawerInst.fileManager;

    // Show loading spinner
    const treeContainer = instance.element.querySelector('.sidebar-tree-container') as HTMLElement;
    if (treeContainer) {
      treeContainer.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:60px;gap:8px;color:var(--text-muted);font-size:12px;"><span class="tree-spinner-inline"></span>加载中...</div>';
    }

    // Long-term follower: re-mirror FileManager's currentPath whenever it
    // changes, until the user explicitly navigates the sidebar tree
    // (breadcrumb edit → followingFm=false) or locks it. This is what
    // makes the JumpServer auto-cd (load `/`, then load `/asset-name`)
    // reach the tree root.
    if (!instance.fmPathUnsub) {
      instance.fmPathUnsub = fm.addPathListener((path: string) => {
        if (!instance.isOpen) return;
        if (!instance.followingFm) return;
        if (instance.locked) return;
        if (instance.rootLoaded && path === instance.currentRootPath) return;
        if (!instance.rootLoaded) {
          fm.loadDirectoryRaw(path).then(result => {
            this.doLoadTreeRoot(instance, fm, result.path, result.files);
          }).catch(() => {
            if (treeContainer) treeContainer.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:60px;color:var(--text-muted);font-size:12px;">加载失败，请右键刷新</div>';
          });
        } else {
          this.changeTreeRoot(instance, path);
        }
      });
    }

    // Use the FM's last-loaded state if it ever loaded a directory.
    // The earlier check `currentPath !== '/'` was wrong for JumpServer
    // assets whose home IS the root (no auto-cd into a single subdir):
    // we'd treat "FM idle at /" as "FM hasn't loaded yet" and wait
    // forever for a path event that never came. `hasLoaded()` makes the
    // distinction explicit.
    if (fm.hasLoaded()) {
      const currentPath = fm.getCurrentPath();
      try {
        const result = await fm.loadDirectoryRaw(currentPath);
        await this.doLoadTreeRoot(instance, fm, result.path, result.files);
      } catch {
        if (treeContainer) treeContainer.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:60px;color:var(--text-muted);font-size:12px;">加载失败，请右键刷新</div>';
      }
      return;
    }
    // Otherwise the path-listener installed above will fire once
    // _afterConnect → loadDirectory completes (and again on auto-cd).
  }

  private async doLoadTreeRoot(
    instance: SidebarInstance,
    fm: import('./file-manager').FileManager,
    path: string,
    files?: import('./protocol').FileInfo[],
  ): Promise<void> {
    if (instance.rootLoaded) return;
    try {
      if (!files) {
        const result = await fm.loadDirectoryRaw(path);
        files = result.files;
        path = result.path;
      }
      instance.tree.setRoot(path, files);
      instance.rootLoaded = true;
      instance.lastCwd = path;
      instance.currentRootPath = path;
      this.updateBreadcrumb(instance, path);
      this.updateStatusCount(instance, files.length);
    } catch (err) {
      console.error('Failed to load sidebar tree root:', err);
      const treeContainer = instance.element.querySelector('.sidebar-tree-container') as HTMLElement;
      if (treeContainer) {
        treeContainer.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:60px;color:var(--text-muted);font-size:12px;">加载失败，请右键刷新</div>';
      }
    }
  }
}

export const SidebarManager = new SidebarManagerClass();

/** Public helper: change sidebar tree root for a session (used by navigateToPath) */
export function changeTreeRootPublic(sessionId: string, path: string): void {
  const instance = (SidebarManager as any).sidebars.get(sessionId);
  if (instance) {
    (SidebarManager as any).changeTreeRoot(instance, path);
  }
}
