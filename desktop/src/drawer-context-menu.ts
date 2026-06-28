import type { DrawerInstance } from './drawer';
import { MsgInput } from './protocol';
import { escapeHtml } from './status-bar';
import { formatSize } from './file-utils';
import { addBookmark } from './file-bookmarks';
import { isEditableFile } from './icons';
import { openFileInEditor } from './file-editor-bridge';
import { isImageFile } from './file-editor-md';
import { loadSettings, saveSettings } from './themes';
import { invoke } from '@tauri-apps/api/core';
import { isMacPlatform } from './app-state';
import { t } from './i18n';
import { showFileDetailsDialog } from './file-details-dialog';

export interface DrawerContextMenuDelegate {
  sendTerminalCommand(instance: DrawerInstance, command: string): void;
}

function createDefaultDelegate(): DrawerContextMenuDelegate {
  return {
    sendTerminalCommand(instance: DrawerInstance, command: string): void {
      const ws = instance.fileManager?.getWebSocket();
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const payload = new TextEncoder().encode('\x15' + command + '\n');
      const msg = new Uint8Array(1 + payload.length);
      msg[0] = MsgInput;
      msg.set(payload, 1);
      ws.send(msg);
    },
  };
}

type MenuItem = {
  label: string;
  action?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  children?: MenuItem[];
  checked?: boolean;
  /** Radio-style selection (● / ○) instead of checkbox (✓) */
  radio?: boolean;
};

function buildMenu(items: MenuItem[], parent: HTMLElement, closeMenu: () => void): void {
  items.forEach(item => {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      parent.appendChild(sep);
      return;
    }

    const menuItem = document.createElement('div');
    menuItem.className = 'context-menu-item';
    if (item.danger) menuItem.classList.add('danger');
    if (item.disabled) menuItem.classList.add('disabled');

    if (item.children) {
      menuItem.classList.add('has-submenu');
      menuItem.innerHTML = `<span>${item.label}</span><span class="submenu-arrow">›</span>`;

      const submenu = document.createElement('div');
      submenu.className = 'context-menu context-submenu';
      buildMenu(item.children, submenu, closeMenu);
      menuItem.appendChild(submenu);

      menuItem.addEventListener('mouseenter', () => {
        const itemRect = menuItem.getBoundingClientRect();
        const subRect = submenu.getBoundingClientRect();
        const viewW = window.innerWidth;
        const viewH = window.innerHeight;

        if (itemRect.right + subRect.width > viewW) {
          submenu.style.left = 'auto';
          submenu.style.right = '100%';
        } else {
          submenu.style.left = '100%';
          submenu.style.right = 'auto';
        }

        if (itemRect.top + subRect.height > viewH) {
          submenu.style.top = 'auto';
          submenu.style.bottom = '0';
        }
      });
    } else {
      const prefix = item.checked !== undefined
        ? (item.radio
          ? (item.checked ? '● ' : '○ ')
          : (item.checked ? '✓ ' : '   '))
        : '';
      menuItem.textContent = prefix + item.label;
      if (!item.disabled) {
        menuItem.addEventListener('click', () => {
          item.action?.();
          closeMenu();
        });
      }
    }

    parent.appendChild(menuItem);
  });
}

export interface ContextMenuOptions {
  /** Provide the "current directory" for the context (e.g. sidebar tree root) */
  getCurrentDir?: () => string;
  /** Re-root the file tree at the right-clicked folder (sidebar only). When
   *  provided, a "Set as Root" item appears on a folder's context menu —
   *  same effect as dragging the folder onto the breadcrumb. */
  onSetAsRoot?: (path: string) => void;
}

export function setupContextMenu(
  instance: DrawerInstance,
  listElement: HTMLElement,
  delegate?: DrawerContextMenuDelegate,
  options?: ContextMenuOptions,
): void {
  const del = delegate || createDefaultDelegate();
  let contextMenu: HTMLDivElement | null = null;

  const closeMenu = () => {
    if (contextMenu) {
      contextMenu.remove();
      contextMenu = null;
    }
  };

  const createContextMenu = (x: number, y: number, fileName: string | null, isDir: boolean) => {
    closeMenu();

    const fm = instance.fileManager;
    if (!fm) return;

    const selected = fm.getSelectedFiles();
    const multiSelect = selected.length > 1;
    const hasFile = fileName !== null;
    const fullPath = hasFile ? fm.getFullPath(fileName) : '';
    const escapedPath = fullPath.replace(/([ '"\\$`!#&|;(){}])/g, '\\$1');

    // Resolve selected items to full paths and detect which are dirs
    const resolveSelectedInfo = (): { path: string; isDir: boolean }[] => {
      return selected.map(f => {
        const p = f.startsWith('/') ? f : fm.getFullPath(f);
        const info = fm.getFileInfo(f.startsWith('/') ? (f.split('/').pop() || f) : f);
        return { path: p, isDir: info?.is_dir ?? false };
      });
    };

    // Directory for "new file/folder" operations:
    // - Right-clicked a directory → create inside it
    // - Right-clicked a file → its parent directory
    // - Blank area → sidebar root or drawer current path
    const newFileDir = hasFile && isDir
      ? fullPath
      : (options?.getCurrentDir?.() ?? fm.getCurrentPath());

    const items: MenuItem[] = [];
    const isLocal = instance.executorType === 'local';
    const settings = loadSettings();

    // ── 顶级"刷新"项（从子菜单提升上来） ──
    const refreshItem: MenuItem = {
      label: t('ctxMenuRefresh'),
      action: () => {
        fm.loadDirectory(fm.getCurrentPath());
        import('./file-sidebar').then(({ SidebarManager }) => {
          SidebarManager.refreshTree(instance.sessionId);
        });
      }
    };

    // ── 复用的"视图 ▶"子菜单(隐藏文件 / 收藏) ──
    const viewSubmenu: MenuItem = {
      label: t('ctxMenuView'),
      children: [
        {
          label: t('ctxMenuShowHidden'),
          checked: fm.getShowHiddenFiles(),
          action: () => {
            fm.toggleShowHiddenFiles();
            fm.loadDirectory(fm.getCurrentPath());
            import('./file-sidebar').then(({ SidebarManager }) => {
              SidebarManager.refreshTree(instance.sessionId);
            });
          }
        },
        { separator: true, label: '' },
        {
          label: t('ctxMenuBookmark'),
          action: () => {
            const info = instance.serverConnectionInfo || { host: 'local', port: 0 };
            const curPath = options?.getCurrentDir?.() ?? fm.getCurrentPath();
            addBookmark(info.host, info.port, curPath);
          }
        },
      ],
    };

    // ── 复用的"新建"项(文件/文件夹) ──
    // 把父目录路径作为参数传给对话框,避免依赖 setCurrentPathForContext 的 5s 超时;
    // 否则用户在对话框停留过久后,getFullPath 会回退到 currentPath,在树视图模式下
    // 会把新建项创建到错误的目录(报错或创建到抽屉根)。
    const newFileItem: MenuItem = {
      label: t('ctxMenuNewFile'),
      action: () => {
        showCreateFileDialog(instance, newFileDir);
      },
    };
    const newFolderItem: MenuItem = {
      label: t('ctxMenuNewFolder'),
      action: () => {
        showMkdirDialog(instance, newFileDir);
      },
    };

    // ──────────────────────────────────────────────────────
    // 分支 1:多选
    // ──────────────────────────────────────────────────────
    if (multiSelect) {
      const fullPaths = selected.map(f => f.startsWith('/') ? f : fm.getFullPath(f));

      items.push({
        label: t('ctxMenuDownloadN').replace('{count}', String(selected.length)),
        disabled: isLocal,
        action: isLocal ? undefined : async () => {
          const infos = resolveSelectedInfo();
          for (const info of infos) {
            await (fm as any).downloadFile(info.path, info.isDir);
          }
        },
      });
      items.push({ separator: true, label: '' });
      items.push({
        label: t('ctxMenuCopyToN').replace('{count}', String(selected.length)),
        action: () => showBatchCopyToDialog(instance, fullPaths),
      });
      items.push({
        label: t('ctxMenuMoveToN').replace('{count}', String(selected.length)),
        action: () => showBatchMoveToDialog(instance, fullPaths),
      });
      items.push({ separator: true, label: '' });
      items.push({
        label: t('ctxMenuDeleteN').replace('{count}', String(selected.length)),
        action: () => {
          const displayNames = selected.map(f => f.includes('/') ? (f.split('/').pop() || f) : f);
          showBatchDeleteConfirmByPaths(instance, displayNames, fullPaths);
        },
        danger: true,
      });
      items.push({ separator: true, label: '' });
      items.push(refreshItem);
      items.push(viewSubmenu);
    }
    // ──────────────────────────────────────────────────────
    // 分支 2:空白区域(无选中项)
    // ──────────────────────────────────────────────────────
    else if (!hasFile) {
      items.push({
        label: t('ctxMenuUpload'),
        disabled: isLocal,
        action: isLocal ? undefined : () => fm.triggerUpload(),
      });
      items.push({ separator: true, label: '' });
      items.push(newFileItem);
      items.push(newFolderItem);
      items.push({ separator: true, label: '' });
      items.push(refreshItem);
      items.push(viewSubmenu);
    }
    // ──────────────────────────────────────────────────────
    // 分支 3:单选(文件或文件夹)
    // ──────────────────────────────────────────────────────
    else {
      const editable = !isDir && (isEditableFile(fileName) || isImageFile(fileName));

      // 文件夹：设为文件树根目录（仅文件侧栏提供该回调；等同于把文件夹拖到面包屑）
      if (isDir && options?.onSetAsRoot) {
        const setRoot = options.onSetAsRoot;
        const rootPath = fullPath;
        items.push({
          label: t('ctxMenuSetAsRoot'),
          action: () => setRoot(rootPath),
        });
        items.push({ separator: true, label: '' });
      }

      // 打开 / 用...打开:仅文件
      if (!isDir) {
        items.push({
          label: t('ctxMenuOpen'),
          action: () => {
            const pref = settings.fileOpenPreference;
            if (editable && pref === 'builtin') {
              const ws = fm.getWebSocket();
              const transport = (fm as any).transport as import('./terminal-transport').TerminalTransport | null;
              const conn = transport?.connected ? transport : ws;
              if (conn) {
                const fileInfo = fm.getFileInfo(fileName);
                openFileInEditor(instance.sessionId, fullPath, fileName, fileInfo?.size ?? 0, conn,
                  instance.serverConnectionInfo?.host);
              }
            } else if (isLocal) {
              invoke('open_path', { path: fullPath }).catch(() => {});
            } else {
              (fm as any).downloadFile(fullPath, false);
            }
          },
        });

        if (editable) {
          items.push({
            label: t('ctxMenuOpenWith'),
            children: [
              {
                label: t('ctxMenuBuiltinEditor'),
                radio: true,
                checked: settings.fileOpenPreference === 'builtin',
                action: () => {
                  saveSettings({ ...loadSettings(), fileOpenPreference: 'builtin' });
                  const ws = fm.getWebSocket();
                  const transport = (fm as any).transport as import('./terminal-transport').TerminalTransport | null;
                  const conn = transport?.connected ? transport : ws;
                  if (conn) {
                    const fileInfo = fm.getFileInfo(fileName);
                    openFileInEditor(instance.sessionId, fullPath, fileName, fileInfo?.size ?? 0, conn,
                      instance.serverConnectionInfo?.host);
                  }
                }
              },
              {
                label: t('ctxMenuSystemDefault'),
                radio: true,
                checked: settings.fileOpenPreference === 'system',
                action: () => {
                  saveSettings({ ...loadSettings(), fileOpenPreference: 'system' });
                  if (isLocal) {
                    invoke('open_path', { path: fullPath }).catch(() => {});
                  } else {
                    (fm as any).downloadFile(fullPath, false);
                  }
                }
              },
            ],
          });
        } else if (isLocal) {
          items.push({
            label: t('ctxMenuOpenWith'),
            children: [
              { label: t('ctxMenuSystemDefault'), radio: true, checked: true, action: () => {
                invoke('open_path', { path: fullPath }).catch(() => {});
              }},
            ],
          });
        }
        items.push({ separator: true, label: '' });
      }

      // 在系统文件管理器中打开（仅本地会话——远程文件不在本机）。
      // 目录 → 打开该文件夹；文件 → 在其所在目录中定位/选中。
      if (isLocal) {
        items.push({
          label: isMacPlatform
            ? (settings.language === 'zh' ? '在访达中打开' : 'Open in Finder')
            : (settings.language === 'zh' ? '在资源管理器中打开' : 'Open in File Explorer'),
          action: () => {
            if (isDir) {
              invoke('open_path', { path: fullPath }).catch(() => {});
            } else {
              import('@tauri-apps/plugin-opener')
                .then(({ revealItemInDir }) => revealItemInDir(fullPath).catch(() => {}))
                .catch(() => {});
            }
          },
        });
        items.push({ separator: true, label: '' });
      }

      // 下载 / 上传
      items.push({
        label: isDir ? t('ctxMenuDownloadFolder') : t('ctxMenuDownload'),
        action: isLocal ? undefined : () => (fm as any).downloadFile(fullPath, isDir),
        disabled: isLocal,
      });
      if (isDir) {
        items.push({
          label: t('ctxMenuUpload'),
          disabled: isLocal,
          children: isLocal ? undefined : [
            { label: t('ctxMenuUploadToFolder'), action: () => fm.triggerUpload(fullPath) },
            { label: t('ctxMenuUploadToCurrent'), action: () => fm.triggerUpload() },
          ],
        });
      } else {
        items.push({
          label: t('ctxMenuUpload'),
          disabled: isLocal,
          action: isLocal ? undefined : () => fm.triggerUpload(),
        });
      }
      items.push({ separator: true, label: '' });

      // 复制路径 / 重命名 / 删除(高频)
      items.push({
        label: t('ctxMenuCopyAbsPath'),
        action: () => navigator.clipboard.writeText(fullPath),
      });
      items.push({
        label: t('ctxMenuRename'),
        action: () => showRenameDialog(instance, fileName),
      });
      items.push({
        label: t('ctxMenuDelete'),
        action: () => showDeleteConfirm(instance, fileName, isDir),
        danger: true,
      });
      items.push({ separator: true, label: '' });

      // 更多 ▶:新建 / 复制移动 / 权限 / 链接 / 终端
      items.push({
        label: t('ctxMenuMore'),
        children: [
          newFileItem,
          newFolderItem,
          { separator: true, label: '' },
          {
            label: t('ctxMenuCopyTo'),
            action: () => showCopyDialog(instance, fileName),
          },
          {
            label: t('ctxMenuMoveTo'),
            action: () => showMoveDialog(instance, fileName),
          },
          {
            label: t('ctxMenuSymlink'),
            action: () => showSymlinkDialog(instance, fileName),
          },
          {
            label: t('ctxMenuChmod'),
            action: () => showChmodDialog(instance, fileName),
          },
          { separator: true, label: '' },
          {
            label: t('ctxMenuTerminalOps'),
            children: [
              {
                label: `cd ${isDir ? '' : '..'}`,
                action: () => {
                  const dir = isDir ? escapedPath : escapedPath.substring(0, escapedPath.lastIndexOf('/')) || '/';
                  del.sendTerminalCommand(instance, `cd ${dir}`);
                },
              },
              {
                label: isDir ? 'ls' : 'cat',
                action: () => {
                  const cmd = isDir ? `ls -la ${escapedPath}` : `cat ${escapedPath}`;
                  del.sendTerminalCommand(instance, cmd);
                },
              },
              {
                label: 'cp',
                action: () => {
                  const ws = instance.fileManager?.getWebSocket();
                  if (!ws || ws.readyState !== WebSocket.OPEN) return;
                  const cmd = isDir ? `cp -r ${escapedPath} ` : `cp ${escapedPath} `;
                  const payload = new TextEncoder().encode('\x15' + cmd);
                  const msg = new Uint8Array(1 + payload.length);
                  msg[0] = MsgInput;
                  msg.set(payload, 1);
                  ws.send(msg);
                },
              },
              {
                label: 'rm',
                action: () => {
                  const ws = instance.fileManager?.getWebSocket();
                  if (!ws || ws.readyState !== WebSocket.OPEN) return;
                  const cmd = isDir ? `rm -r ${escapedPath}` : `rm ${escapedPath}`;
                  const payload = new TextEncoder().encode('\x15' + cmd);
                  const msg = new Uint8Array(1 + payload.length);
                  msg[0] = MsgInput;
                  msg.set(payload, 1);
                  ws.send(msg);
                },
                danger: true,
              },
            ],
          },
        ],
      });

      // 详情
      items.push({
        label: t('ctxMenuProperties'),
        action: () => {
          // Try current dir first, then fall back to cached directories
          // (sidebar tree nodes can be in any directory, not just currentPath)
          const info = fm.getFileInfo(fileName) || fm.getFileInfoByPath(fullPath);
          if (info) {
            showFileDetailsDialog(instance, info, fullPath);
          } else {
            import('./notify').then(({ showToast }) => {
              showToast({ title: t('ctxMenuProperties'), body: 'File info not available. Please wait for the directory to load and try again.' });
            }).catch(() => {});
          }
        },
      });

      items.push({ separator: true, label: '' });
      items.push(refreshItem);
      items.push(viewSubmenu);
    }

    contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu';
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;

    buildMenu(items, contextMenu, closeMenu);
    document.body.appendChild(contextMenu);

    const menuRect = contextMenu.getBoundingClientRect();
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;

    if (x + menuRect.width > viewW) {
      contextMenu.style.left = `${Math.max(0, viewW - menuRect.width - 4)}px`;
    }
    if (y + menuRect.height > viewH) {
      contextMenu.style.top = `${Math.max(0, viewH - menuRect.height - 4)}px`;
    }

    const onClickOutside = (e: MouseEvent) => {
      if (contextMenu && !contextMenu.contains(e.target as Node)) {
        closeMenu();
        document.removeEventListener('click', onClickOutside);
      }
    };
    setTimeout(() => document.addEventListener('click', onClickOutside), 0);
  };

  const fileListContainer = listElement.closest('.file-list') || listElement.closest('table') || listElement;
  fileListContainer.addEventListener('contextmenu', (ev) => {
    const e = ev as MouseEvent;
    e.preventDefault();
    e.stopPropagation();
    const target = (e.target as HTMLElement).closest('tr, .tree-node') as HTMLElement;

    if (target && target.dataset.path) {
      const rawPath = target.dataset.path;
      const isTreeNode = target.classList.contains('tree-node');
      const fileName = isTreeNode ? (rawPath.split('/').pop() || rawPath) : rawPath;
      const isDir = target.dataset.isDir === 'true';
      if (isTreeNode && instance.fileManager) {
        const parentDir = rawPath.substring(0, rawPath.lastIndexOf('/')) || '/';
        instance.fileManager.setCurrentPathForContext(parentDir);
      }
      createContextMenu(e.clientX, e.clientY, fileName, isDir);
    } else {
      createContextMenu(e.clientX, e.clientY, null, false);
    }
  });
}

export function showModal(options: {
  title: string;
  description?: string;
  copyCommand?: string;
  input?: { placeholder?: string; value?: string };
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  container?: HTMLElement;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const container = options.container || document.body;
    container.querySelector('.drawer-modal-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'drawer-modal-overlay';
    // Use fixed positioning when mounted on document.body
    if (container === document.body) {
      overlay.style.position = 'fixed';
      overlay.style.zIndex = '10000';
    }

    const hasInput = !!options.input;
    const copyCommandHtml = options.copyCommand
      ? `<div class="drawer-modal-copy-cmd">
          <code>${escapeHtml(options.copyCommand)}</code>
          <button class="drawer-modal-copy-btn" title="复制命令">复制</button>
        </div>`
      : '';
    overlay.innerHTML = `
      <div class="drawer-modal">
        <div class="drawer-modal-title">${options.title}</div>
        ${options.description ? `<div class="drawer-modal-desc" style="font-size:12px;color:#999;margin:4px 0 8px;line-height:1.5;white-space:pre-wrap;">${options.description}</div>` : ''}
        ${copyCommandHtml}
        ${hasInput ? `<input class="drawer-modal-input" type="text" value="${(options.input!.value || '').replace(/"/g, '&quot;')}" placeholder="${options.input!.placeholder || ''}" spellcheck="false" />` : ''}
        <div class="drawer-modal-buttons">
          <button class="drawer-modal-btn cancel">${options.cancelText || '取消'}</button>
          <button class="drawer-modal-btn confirm${options.danger ? ' danger' : ''}">${options.confirmText || '确定'}</button>
        </div>
      </div>
    `;

    container.appendChild(overlay);

    if (options.copyCommand) {
      const copyBtn = overlay.querySelector('.drawer-modal-copy-btn') as HTMLButtonElement;
      copyBtn?.addEventListener('click', () => {
        navigator.clipboard.writeText(options.copyCommand!);
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
      });
    }

    const input = overlay.querySelector('.drawer-modal-input') as HTMLInputElement | null;
    const confirmBtn = overlay.querySelector('.drawer-modal-btn.confirm') as HTMLButtonElement;
    const cancelBtn = overlay.querySelector('.drawer-modal-btn.cancel') as HTMLButtonElement;

    const close = (value: string | null) => {
      overlay.remove();
      resolve(value);
    };

    if (input) {
      input.focus();
      input.select();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') close(input.value);
        if (e.key === 'Escape') close(null);
      });
    }

    confirmBtn.addEventListener('click', () => close(hasInput ? input!.value : ''));
    cancelBtn.addEventListener('click', () => close(null));
  });
}

async function showCreateFileDialog(instance: DrawerInstance, parentDir?: string): Promise<void> {
  const drawerContent = instance.element.querySelector('.drawer-content') as HTMLElement | null;
  const container = (drawerContent && drawerContent.offsetParent !== null) ? drawerContent : document.body;
  // Capture parent dir BEFORE the async modal so it can't drift if the
  // context-path timeout fires while the user is typing.
  const targetParent = parentDir ?? instance.fileManager?.getCurrentPath() ?? '/';
  const fileName = await showModal({
    title: '新建文件',
    input: { placeholder: '文件名称' },
    confirmText: '创建',
    container,
  });
  if (fileName && instance.fileManager) {
    const absPath = targetParent === '/' ? `/${fileName}` : `${targetParent}/${fileName}`;
    await instance.fileManager.createFileAt(absPath);
  }
}

export async function showDeleteConfirm(instance: DrawerInstance, fileName: string, isDir: boolean): Promise<void> {
  const type = isDir ? '文件夹' : '文件';
  const drawerContent = instance.element.querySelector('.drawer-content') as HTMLElement | null;
  const container = (drawerContent && drawerContent.offsetParent !== null) ? drawerContent : document.body;
  // Capture full path immediately (before any async delay)
  const fullPath = instance.fileManager?.getFullPath(fileName) || fileName;
  const escapedPath = fullPath.replace(/([ '"\\$`!#&|;(){}])/g, '\\$1');
  const rmCmd = isDir ? `rm -rf ${escapedPath}` : `rm ${escapedPath}`;

  let description: string | undefined;
  let copyCommand: string | undefined;
  if (instance.fileManager) {
    const fileInfo = instance.fileManager.getFileInfo(fileName);
    const isLargeFile = fileInfo && !isDir && fileInfo.size > 100 * 1024 * 1024;
    if (isDir || isLargeFile) {
      description = isDir
        ? `删除文件夹可能耗时较长，如超时请在终端中使用 rm -rf 命令删除。`
        : `文件较大 (${formatSize(fileInfo!.size)})，删除可能耗时较长。`;
      copyCommand = rmCmd;
    }
  }

  const result = await showModal({
    title: `确定要删除${type} "${fileName}" 吗？`,
    description,
    copyCommand,
    confirmText: '删除',
    danger: true,
    container,
  });
  if (result !== null && instance.fileManager) {
    // Use captured full path directly (avoids _contextPath timeout)
    await instance.fileManager.deleteFile(fullPath);
  }
}

export async function showRenameDialog(instance: DrawerInstance, oldName: string): Promise<void> {
  const drawerContent = instance.element.querySelector('.drawer-content') as HTMLElement | null;
  const container = (drawerContent && drawerContent.offsetParent !== null) ? drawerContent : document.body;
  // Capture full path before async dialog
  const fullOldPath = instance.fileManager?.getFullPath(oldName) || oldName;
  const parentDir = fullOldPath.substring(0, fullOldPath.lastIndexOf('/')) || '/';
  const newName = await showModal({
    title: '重命名',
    input: { value: oldName },
    confirmText: '重命名',
    container,
  });
  if (newName && newName !== oldName && instance.fileManager) {
    const fullNewPath = `${parentDir}/${newName}`;
    // Optimistic UI: in sidebar mode the drawer's "重命名中..." overlay is
    // hidden, so without this the tree shows the old name for ~500ms-1s
    // (until the post-rename refreshAll completes) — looks like nothing
    // happened. Apply the rename to the visible tree right now; the
    // refresh that fires on the server response reconciles automatically.
    void import('./file-sidebar').then(({ SidebarManager }) => {
      SidebarManager.optimisticRename(instance.sessionId, fullOldPath, newName);
    });
    await instance.fileManager.renameFile(fullOldPath, fullNewPath);
  }
}

async function showMkdirDialog(instance: DrawerInstance, parentDir?: string): Promise<void> {
  const drawerContent = instance.element.querySelector('.drawer-content') as HTMLElement | null;
  const container = (drawerContent && drawerContent.offsetParent !== null) ? drawerContent : document.body;
  // Capture parent dir BEFORE the async modal so it can't drift if the
  // context-path timeout fires while the user is typing.
  const targetParent = parentDir ?? instance.fileManager?.getCurrentPath() ?? '/';
  const dirName = await showModal({
    title: '新建文件夹',
    input: { placeholder: '文件夹名称' },
    confirmText: '创建',
    container,
  });
  if (dirName && instance.fileManager) {
    const absPath = targetParent === '/' ? `/${dirName}` : `${targetParent}/${dirName}`;
    await instance.fileManager.createDirectoryAt(absPath);
  }
}

const CHMOD_PRESETS = [
  { mode: '777', desc: 'rwxrwxrwx — 所有人可读写执行' },
  { mode: '775', desc: 'rwxrwxr-x — 拥有者和同组读写执行，其他人读和执行' },
  { mode: '755', desc: 'rwxr-xr-x — 拥有者读写执行，其他人读和执行' },
  { mode: '750', desc: 'rwxr-x--- — 拥有者读写执行，同组读和执行' },
  { mode: '700', desc: 'rwx------ — 仅拥有者可读写执行' },
  { mode: '666', desc: 'rw-rw-rw- — 所有人可读写' },
  { mode: '664', desc: 'rw-rw-r-- — 拥有者和同组读写，其他人只读' },
  { mode: '660', desc: 'rw-rw---- — 拥有者和同组读写' },
  { mode: '644', desc: 'rw-r--r-- — 拥有者读写，其他人只读' },
  { mode: '640', desc: 'rw-r----- — 拥有者读写，同组只读' },
  { mode: '600', desc: 'rw------- — 仅拥有者可读写' },
  { mode: '555', desc: 'r-xr-xr-x — 所有人可读和执行' },
  { mode: '544', desc: 'r-xr--r-- — 拥有者读和执行，其他人只读' },
  { mode: '500', desc: 'r-x------ — 仅拥有者可读和执行' },
  { mode: '444', desc: 'r--r--r-- — 所有人只读' },
  { mode: '440', desc: 'r--r----- — 拥有者和同组只读' },
  { mode: '400', desc: 'r-------- — 仅拥有者只读' },
];

async function showChmodDialog(instance: DrawerInstance, fileName: string): Promise<void> {
  const drawerContent = instance.element.querySelector('.drawer-content') as HTMLElement | null;
  const container = (drawerContent && drawerContent.offsetParent !== null) ? drawerContent : document.body;
  const fm = instance.fileManager;
  if (!fm) return;
  const fullPath = fm.getFullPath(fileName);
  const fileInfo = fm.getFileInfo(fileName);
  const currentMode = fileInfo?.mode || '644';

  container.querySelector('.drawer-modal-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'drawer-modal-overlay';
  if (container === document.body) {
    overlay.style.position = 'fixed';
    overlay.style.zIndex = '10000';
  }

  const presetsHtml = CHMOD_PRESETS.map(p =>
    `<button class="chmod-preset${p.mode === currentMode ? ' active' : ''}" data-mode="${p.mode}" title="${p.desc}">` +
    `${p.mode}<svg class="chmod-info-icon" viewBox="0 0 16 16" width="12" height="12"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v4M8 5v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>` +
    `</button>`
  ).join('');

  overlay.innerHTML = `
    <div class="drawer-modal chmod-modal">
      <div class="drawer-modal-title">修改权限</div>
      <div class="drawer-modal-desc" style="font-size:12px;color:#999;margin:4px 0 8px;line-height:1.5;">文件: ${escapeHtml(fileName)}　当前权限: ${escapeHtml(currentMode)}</div>
      <div class="chmod-presets">${presetsHtml}</div>
      <div class="drawer-modal-buttons">
        <button class="drawer-modal-btn cancel">取消</button>
      </div>
    </div>
  `;
  container.appendChild(overlay);

  const close = () => overlay.remove();

  // 点击预设直接修改权限
  overlay.querySelectorAll('.chmod-preset').forEach(btn => {
    btn.addEventListener('click', async () => {
      const modeStr = (btn as HTMLElement).dataset.mode || '';
      const mode = parseInt(modeStr, 8);
      if (!isNaN(mode)) {
        close();
        await fm.chmodFile(fullPath, mode);
      }
    });
  });

  overlay.querySelector('.drawer-modal-btn.cancel')!.addEventListener('click', close);
}

async function showCopyDialog(instance: DrawerInstance, fileName: string): Promise<void> {
  const drawerContent = instance.element.querySelector('.drawer-content') as HTMLElement | null;
  const container = (drawerContent && drawerContent.offsetParent !== null) ? drawerContent : document.body;
  const fm = instance.fileManager;
  if (!fm) return;
  const fullPath = fm.getFullPath(fileName);
  const defaultDest = fullPath + '.copy';
  const destPath = await showModal({
    title: '复制到...',
    description: `源文件: ${fullPath}`,
    input: { value: defaultDest, placeholder: '目标路径' },
    confirmText: '复制',
    container,
  });
  if (destPath) {
    await fm.copyFile(fullPath, destPath);
  }
}

async function showMoveDialog(instance: DrawerInstance, fileName: string): Promise<void> {
  const drawerContent = instance.element.querySelector('.drawer-content') as HTMLElement | null;
  const container = (drawerContent && drawerContent.offsetParent !== null) ? drawerContent : document.body;
  const fm = instance.fileManager;
  if (!fm) return;
  const fullPath = fm.getFullPath(fileName);
  const destPath = await showModal({
    title: '移动到...',
    description: `源文件: ${fullPath}`,
    input: { value: fullPath, placeholder: '目标路径' },
    confirmText: '移动',
    container,
  });
  if (destPath && destPath !== fullPath) {
    await fm.moveFile(fullPath, destPath);
  }
}

async function showSymlinkDialog(instance: DrawerInstance, fileName: string): Promise<void> {
  const drawerContent = instance.element.querySelector('.drawer-content') as HTMLElement | null;
  const container = (drawerContent && drawerContent.offsetParent !== null) ? drawerContent : document.body;
  const fm = instance.fileManager;
  if (!fm) return;
  const target = fm.getFullPath(fileName);
  const linkName = await showModal({
    title: '创建符号链接',
    description: `目标: ${target}`,
    input: { value: fileName + '.link', placeholder: '链接名称' },
    confirmText: '创建',
    container,
  });
  if (linkName) {
    await fm.createSymlink(target, linkName);
  }
}

async function showBatchCopyToDialog(instance: DrawerInstance, sourcePaths: string[]): Promise<void> {
  const drawerContent = instance.element.querySelector('.drawer-content') as HTMLElement | null;
  const container = (drawerContent && drawerContent.offsetParent !== null) ? drawerContent : document.body;
  const fm = instance.fileManager;
  if (!fm) return;
  const names = sourcePaths.map(p => p.split('/').pop() || p);
  const destDir = await showModal({
    title: t('ctxMenuCopyToN').replace('{count}', String(sourcePaths.length)),
    description: names.slice(0, 10).join('\n') + (names.length > 10 ? `\n...${names.length} items` : ''),
    input: { value: fm.getCurrentPath(), placeholder: '/' },
    confirmText: t('ctxMenuCopyTo').replace('...', ''),
    container,
  });
  if (destDir) {
    for (const src of sourcePaths) {
      const name = src.split('/').pop() || '';
      const dest = destDir.endsWith('/') ? `${destDir}${name}` : `${destDir}/${name}`;
      await fm.copyFile(src, dest);
    }
  }
}

async function showBatchMoveToDialog(instance: DrawerInstance, sourcePaths: string[]): Promise<void> {
  const drawerContent = instance.element.querySelector('.drawer-content') as HTMLElement | null;
  const container = (drawerContent && drawerContent.offsetParent !== null) ? drawerContent : document.body;
  const fm = instance.fileManager;
  if (!fm) return;
  const names = sourcePaths.map(p => p.split('/').pop() || p);
  const destDir = await showModal({
    title: t('ctxMenuMoveToN').replace('{count}', String(sourcePaths.length)),
    description: names.slice(0, 10).join('\n') + (names.length > 10 ? `\n...${names.length} items` : ''),
    input: { value: fm.getCurrentPath(), placeholder: '/' },
    confirmText: t('ctxMenuMoveTo').replace('...', ''),
    container,
  });
  if (destDir) {
    for (const src of sourcePaths) {
      const name = src.split('/').pop() || '';
      const dest = destDir.endsWith('/') ? `${destDir}${name}` : `${destDir}/${name}`;
      await fm.moveFile(src, dest);
    }
  }
}

export async function showBatchDeleteConfirm(instance: DrawerInstance, fileNames: string[]): Promise<void> {
  const drawerContent = instance.element.querySelector('.drawer-content') as HTMLElement | null;
  const container = (drawerContent && drawerContent.offsetParent !== null) ? drawerContent : document.body;
  // Capture full paths before async dialog
  const fullPaths = instance.fileManager
    ? fileNames.map(n => instance.fileManager!.getFullPath(n))
    : fileNames;
  const result = await showModal({
    title: `确定要删除 ${fileNames.length} 个文件/文件夹吗？`,
    description: fileNames.slice(0, 10).join('\n') + (fileNames.length > 10 ? `\n...等 ${fileNames.length} 项` : ''),
    confirmText: '删除',
    danger: true,
    container,
  });
  if (result !== null && instance.fileManager) {
    for (const p of fullPaths) {
      await instance.fileManager.deleteFile(p);
    }
  }
}

/** Batch delete with pre-resolved full paths (for sidebar cross-directory multi-select) */
async function showBatchDeleteConfirmByPaths(instance: DrawerInstance, displayNames: string[], fullPaths: string[]): Promise<void> {
  const drawerContent = instance.element.querySelector('.drawer-content') as HTMLElement | null;
  const container = (drawerContent && drawerContent.offsetParent !== null) ? drawerContent : document.body;
  const result = await showModal({
    title: `确定要删除 ${displayNames.length} 个文件/文件夹吗？`,
    description: displayNames.slice(0, 10).join('\n') + (displayNames.length > 10 ? `\n...等 ${displayNames.length} 项` : ''),
    confirmText: '删除',
    danger: true,
    container,
  });
  if (result !== null && instance.fileManager) {
    for (const p of fullPaths) {
      await instance.fileManager.deleteFile(p);
    }
  }
}
