import type { DrawerInstance } from './drawer';
import { MsgInput } from './protocol';
import { escapeHtml } from './status-bar';
import { formatSize } from './file-utils';
import { addBookmark } from './file-bookmarks';

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
      menuItem.textContent = (item.checked !== undefined ? (item.checked ? '✓ ' : '   ') : '') + item.label;
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

export function setupContextMenu(
  instance: DrawerInstance,
  listElement: HTMLElement,
  delegate?: DrawerContextMenuDelegate,
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

    const items: MenuItem[] = [];

    if (multiSelect) {
      items.push({
        label: `下载 ${selected.length} 个文件`,
        action: () => { for (const f of selected) (fm as any).downloadFile(f); },
      });
    } else {
      items.push({
        label: hasFile && isDir ? '下载文件夹' : '下载',
        action: hasFile ? () => (fm as any).downloadFile(fileName, isDir) : undefined,
        disabled: !hasFile
      });
    }

    if (hasFile && isDir) {
      items.push({
        label: '上传',
        children: [
          {
            label: '上传到此文件夹',
            action: () => fm.triggerUpload(fullPath)
          },
          {
            label: '上传到当前路径',
            action: () => fm.triggerUpload()
          }
        ]
      });
    } else {
      items.push({
        label: '上传',
        action: () => fm.triggerUpload()
      });
    }

    items.push({ separator: true, label: '' });

    items.push({
      label: '新建文件',
      action: () => showCreateFileDialog(instance)
    });
    items.push({
      label: '新建文件夹',
      action: () => showMkdirDialog(instance)
    });

    items.push({ separator: true, label: '' });

    items.push({
      label: '复制路径',
      disabled: !hasFile,
      children: hasFile ? [
        {
          label: '复制绝对路径',
          action: () => navigator.clipboard.writeText(fullPath)
        },
        { separator: true, label: '' },
        {
          label: `cd ${isDir ? '' : '..'}`,
          action: () => {
            const dir = isDir ? escapedPath : escapedPath.substring(0, escapedPath.lastIndexOf('/')) || '/';
            del.sendTerminalCommand(instance, `cd ${dir}`);
          }
        },
        {
          label: isDir ? 'ls' : 'cat',
          action: () => {
            const cmd = isDir ? `ls -la ${escapedPath}` : `cat ${escapedPath}`;
            del.sendTerminalCommand(instance, cmd);
          }
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
          }
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
          danger: true
        }
      ] : undefined
    });

    items.push({ separator: true, label: '' });

    items.push({
      label: '复制到...',
      action: hasFile ? () => showCopyDialog(instance, fileName) : undefined,
      disabled: !hasFile
    });
    items.push({
      label: '移动到...',
      action: hasFile ? () => showMoveDialog(instance, fileName) : undefined,
      disabled: !hasFile
    });
    items.push({
      label: '创建符号链接',
      action: hasFile ? () => showSymlinkDialog(instance, fileName) : undefined,
      disabled: !hasFile
    });

    items.push({ separator: true, label: '' });

    items.push({
      label: '修改权限',
      action: hasFile ? () => showChmodDialog(instance, fileName) : undefined,
      disabled: !hasFile
    });
    items.push({
      label: '重命名',
      action: hasFile ? () => showRenameDialog(instance, fileName) : undefined,
      disabled: !hasFile
    });
    if (multiSelect) {
      items.push({
        label: `删除 ${selected.length} 个文件`,
        action: () => showBatchDeleteConfirm(instance, selected),
        danger: true,
      });
    } else {
      items.push({
        label: '删除',
        action: hasFile ? () => showDeleteConfirm(instance, fileName, isDir) : undefined,
        danger: true,
        disabled: !hasFile
      });
    }

    items.push({ separator: true, label: '' });

    // 收藏当前目录
    items.push({
      label: '收藏当前目录',
      action: () => {
        const info = instance.serverConnectionInfo || { host: 'local', port: 0 };
        const curPath = fm.getCurrentPath();
        if (addBookmark(info.host, info.port, curPath)) {
          console.log('Bookmark added:', curPath);
        }
      }
    });

    items.push({
      label: '显示隐藏文件',
      checked: fm.getShowHiddenFiles(),
      action: () => fm.toggleShowHiddenFiles()
    });

    contextMenu = document.createElement('div');
    contextMenu.className = 'context-menu';
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;

    buildMenu(items, contextMenu, closeMenu);
    document.body.appendChild(contextMenu);

    // 边界检测
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
    const target = (e.target as HTMLElement).closest('tr') as HTMLTableRowElement;

    if (target && target.dataset.path) {
      const fileName = target.dataset.path;
      const isDir = target.dataset.isDir === 'true';
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

async function showCreateFileDialog(instance: DrawerInstance): Promise<void> {
  const container = instance.element.querySelector('.drawer-content') as HTMLElement || instance.element;
  const fileName = await showModal({
    title: '新建文件',
    input: { placeholder: '文件名称' },
    confirmText: '创建',
    container,
  });
  if (fileName && instance.fileManager) {
    await instance.fileManager.createFile(fileName);
  }
}

export async function showDeleteConfirm(instance: DrawerInstance, fileName: string, isDir: boolean): Promise<void> {
  const type = isDir ? '文件夹' : '文件';
  const container = instance.element.querySelector('.drawer-content') as HTMLElement || instance.element;
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
    await instance.fileManager.deleteFile(fileName);
  }
}

export async function showRenameDialog(instance: DrawerInstance, oldName: string): Promise<void> {
  const container = instance.element.querySelector('.drawer-content') as HTMLElement || instance.element;
  const newName = await showModal({
    title: '重命名',
    input: { value: oldName },
    confirmText: '重命名',
    container,
  });
  if (newName && newName !== oldName && instance.fileManager) {
    await instance.fileManager.renameFile(oldName, newName);
  }
}

async function showMkdirDialog(instance: DrawerInstance): Promise<void> {
  const container = instance.element.querySelector('.drawer-content') as HTMLElement || instance.element;
  const dirName = await showModal({
    title: '新建文件夹',
    input: { placeholder: '文件夹名称' },
    confirmText: '创建',
    container,
  });
  if (dirName && instance.fileManager) {
    await instance.fileManager.createDirectory(dirName);
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
  const container = instance.element.querySelector('.drawer-content') as HTMLElement || instance.element;
  const fm = instance.fileManager;
  if (!fm) return;
  const fileInfo = fm.getFileInfo(fileName);
  const currentMode = fileInfo?.mode || '644';

  container.querySelector('.drawer-modal-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'drawer-modal-overlay';

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
        await fm.chmodFile(fileName, mode);
      }
    });
  });

  overlay.querySelector('.drawer-modal-btn.cancel')!.addEventListener('click', close);
}

async function showCopyDialog(instance: DrawerInstance, fileName: string): Promise<void> {
  const container = instance.element.querySelector('.drawer-content') as HTMLElement || instance.element;
  const fm = instance.fileManager;
  if (!fm) return;
  const currentPath = fm.getCurrentPath();
  const defaultDest = (currentPath === '/' ? '/' : currentPath + '/') + fileName + '.copy';
  const destPath = await showModal({
    title: '复制到...',
    description: `源文件: ${fm.getFullPath(fileName)}`,
    input: { value: defaultDest, placeholder: '目标路径' },
    confirmText: '复制',
    container,
  });
  if (destPath) {
    await fm.copyFile(fileName, destPath);
  }
}

async function showMoveDialog(instance: DrawerInstance, fileName: string): Promise<void> {
  const container = instance.element.querySelector('.drawer-content') as HTMLElement || instance.element;
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
    await fm.moveFile(fileName, destPath);
  }
}

async function showSymlinkDialog(instance: DrawerInstance, fileName: string): Promise<void> {
  const container = instance.element.querySelector('.drawer-content') as HTMLElement || instance.element;
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

export async function showBatchDeleteConfirm(instance: DrawerInstance, fileNames: string[]): Promise<void> {
  const container = instance.element.querySelector('.drawer-content') as HTMLElement || instance.element;
  const result = await showModal({
    title: `确定要删除 ${fileNames.length} 个文件/文件夹吗？`,
    description: fileNames.slice(0, 10).join('\n') + (fileNames.length > 10 ? `\n...等 ${fileNames.length} 项` : ''),
    confirmText: '删除',
    danger: true,
    container,
  });
  if (result !== null && instance.fileManager) {
    for (const name of fileNames) {
      await instance.fileManager.deleteFile(name);
    }
  }
}
