/**
 * toolbar.ts — Toolbar rendering and Windows app menu
 *
 * Extracted from main.ts. Contains:
 * - renderToolbarActions()
 * - showWindowsToolbarMenu()
 * - setupToolbarDrag()
 * - WIN_ICON_* constants
 */

import { TabManager } from './tabs';
import { icon } from './icons';
import { t } from './i18n';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { save, open as openDialog } from '@tauri-apps/plugin-dialog';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import { confirmSystem, showInfoSystem, requestQuitWithConfirm } from './window-lifecycle';
import { hasRemoteTabs, showRemoteSessionListPopup } from './remote-list';
import { updateSSHHomeView, exportConnectionsToJSON, importConnectionsFromJSON } from './ssh';
import { showHomeView, showGalleryView, openSettings } from './view-manager';
import { createNewSession, createNewPrivateSession, closeAllSessions, createNewWindowNearCurrent } from './session-actions';
import { renderTabs } from './tab-renderer';
import { pendingUpdateVersion, openUpdaterWindow } from './updater';
import { settings, isHomeView, isGalleryView, isWindowsPlatform, isLinuxPlatform, activeJumpServers } from './app-state';
import { toggleJumpServerPanel, isJumpServerPanelOpen, showJsConnectionContextMenu } from './jumpserver-panel';
import { isPipActive, togglePip } from './pip';
import { DrawerManager } from './drawer';
import { AICapsuleManager } from './ai-capsule';
import { ConnectionSidebar } from './connection-sidebar';
import { toggleFileManager, closeFileManager, isFileManagerOpen } from './file-manager-toggle';
import appIconUrl from '../src-tauri/icons/icon.svg';

/** Platforms that need custom window controls (no native overlay titlebar). */
const needsCustomControls = isWindowsPlatform || isLinuxPlatform;

// ── Always-on-top state ──

let isAlwaysOnTop = false;

// Re-render the toolbar when the AI chat sidebar opens/closes from anywhere
// (sidebar close button, Ctrl+Enter, etc.) so the agent button's active state
// stays in sync. Registered once, lazily, from renderToolbarActions.
let _aiChatToggleHooked = false;

async function toggleAlwaysOnTop(): Promise<void> {
  const win = getCurrentWindow();
  isAlwaysOnTop = !isAlwaysOnTop;
  await win.setAlwaysOnTop(isAlwaysOnTop);
  renderToolbarActions();
}

/** Get current always-on-top state. */
export function getAlwaysOnTop(): boolean {
  return isAlwaysOnTop;
}

// ── DOM elements (lazily cached) ──

let _toolbarLeftEl: HTMLDivElement | null = null;
let _toolbarRightEl: HTMLDivElement | null = null;

function getToolbarLeftEl(): HTMLDivElement {
  if (!_toolbarLeftEl) _toolbarLeftEl = document.getElementById('window-toolbar-left') as HTMLDivElement;
  return _toolbarLeftEl;
}

function getToolbarRightEl(): HTMLDivElement {
  if (!_toolbarRightEl) _toolbarRightEl = document.getElementById('window-toolbar-right') as HTMLDivElement;
  return _toolbarRightEl;
}

// ── Late-bound callbacks ──

let _showShellContextMenu: (e: MouseEvent, anchor?: HTMLElement) => void = () => {};

export function setToolbarCallbacks(cbs: {
  showShellContextMenu: (e: MouseEvent, anchor?: HTMLElement) => void;
}): void {
  _showShellContextMenu = cbs.showShellContextMenu;
}

// ── SVG icons for Windows title-bar window controls ──

export const WIN_ICON_MINIMIZE = '<svg width="10" height="1" viewBox="0 0 10 1" aria-hidden="true"><rect width="10" height="1" fill="currentColor"/></svg>';
export const WIN_ICON_MAXIMIZE = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.6" y="0.6" width="8.8" height="8.8" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
export const WIN_ICON_RESTORE  = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="2.6" y="0.6" width="6.8" height="6.8" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M0.6 2.6v6.8h6.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
export const WIN_ICON_CLOSE    = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1 9 9M9 1 1 9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

// ── Windows toolbar menu ──

export function showWindowsToolbarMenu(anchor: HTMLElement): void {
  const existing = document.getElementById('app-toolbar-menu');
  if (existing) {
    existing.remove();
  }

  const menu = document.createElement('div');
  menu.id = 'app-toolbar-menu';
  menu.className = 'custom-context-menu app-toolbar-menu';

  const addItem = (label: string, onClick: () => void | Promise<void>, disabled = false): void => {
    const item = document.createElement('button');
    item.className = 'custom-context-menu-item';
    item.type = 'button';
    item.textContent = label;
    item.disabled = disabled;
    item.onclick = () => {
      cleanup();
      void onClick();
    };
    menu.appendChild(item);
  };

  const addDivider = (): void => {
    menu.appendChild(document.createElement('div')).className = 'custom-context-menu-divider';
  };

  const zh = settings?.language === 'zh';

  const addCheckItem = (label: string, checked: boolean, onClick: () => void | Promise<void>): void => {
    const item = document.createElement('button');
    item.className = 'custom-context-menu-item';
    item.type = 'button';
    item.textContent = checked ? `✓ ${label}` : `    ${label}`;
    item.onclick = () => {
      cleanup();
      void onClick();
    };
    menu.appendChild(item);
  };

  addItem(zh ? '新窗口' : 'New Window', async () => {
    await createNewWindowNearCurrent();
  });
  addItem(t('contextMenuHome'), () => {
    showHomeView();
    renderTabs();
  });
  addItem(t('newTerminal'), async () => {
    await createNewSession();
  });
  addItem(t('newPrivateTerminal'), async () => {
    await createNewPrivateSession();
  });
  addItem(t('settings'), () => {
    openSettings();
  });
  addItem(
    isPipActive()
      ? (zh ? '退出画中画' : 'Exit Picture-in-Picture')
      : (zh ? '画中画' : 'Picture-in-Picture'),
    async () => { await togglePip(); },
  );
  addDivider();
  const isDiscoverable = localStorage.getItem('meterm-discoverable') === '1';
  addCheckItem(
    zh ? '局域网发现' : 'LAN Discovery',
    isDiscoverable,
    async () => {
      const newState = !isDiscoverable;
      try {
        await invoke('toggle_lan_sharing', { enabled: newState });
        localStorage.setItem('meterm-discoverable', newState ? '1' : '0');
        await invoke('set_discoverable_state', { checked: newState });
      } catch (err) {
        console.error('toggle_lan_sharing failed:', err);
      }
    },
  );
  addDivider();
  addItem(
    zh ? '导入连接' : 'Import Connections',
    async () => {
      const filePath = await openDialog({
        multiple: false,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (filePath) {
        try {
          const json = await readTextFile(filePath as string);
          const result = importConnectionsFromJSON(json);
          updateSSHHomeView();
          await showInfoSystem(`${result.count} ${t('sshImportCount')}`, t('sshImportSuccess'));
        } catch {
          await showInfoSystem(t('sshImportInvalidFormat'), t('sshImportFailed'));
        }
      }
    },
  );
  addItem(
    zh ? '导出连接' : 'Export Connections',
    async () => {
      const result = await exportConnectionsToJSON();
      if (!result) {
        await showInfoSystem(t('sshNoConnectionsToExport'), t('appName'));
        return;
      }
      const filePath = await save({
        defaultPath: 'meterm-connections.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (filePath) {
        await writeTextFile(filePath, result.json);
        await showInfoSystem(`${result.count} ${t('sshExportCount')}`, t('sshExportSuccess'));
      }
    },
  );
  addItem(
    zh ? '关闭所有会话' : 'Close All Sessions',
    async () => {
      if (TabManager.tabs.length === 0) return;
      const confirmed = await confirmSystem(t('confirmCloseAllSessions'));
      if (!confirmed) return;
      await closeAllSessions();
    },
    TabManager.tabs.length === 0,
  );
  addDivider();
  addItem(zh ? '关闭窗口' : 'Close Window', async () => {
    // Trigger window close request (will go through hide-to-tray logic)
    await emit('window-close-requested', { target_window: getCurrentWindow().label });
  });
  addItem(zh ? '退出应用' : 'Quit Application', async () => {
    await requestQuitWithConfirm();
  });

  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(6, rect.left)}px`;
  menu.style.top = `${rect.bottom + 6}px`;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const menuRect = menu.getBoundingClientRect();
  if (menuRect.right > viewportWidth - 6) {
    menu.style.left = `${Math.max(6, viewportWidth - menuRect.width - 6)}px`;
  }
  if (menuRect.bottom > viewportHeight - 6) {
    menu.style.top = `${Math.max(6, rect.top - menuRect.height - 6)}px`;
  }

  const onPointerDown = (event: MouseEvent): void => {
    const target = event.target as Node | null;
    if (!target) return;
    if (menu.contains(target) || anchor.contains(target)) return;
    cleanup();
  };

  const cleanup = (): void => {
    menu.remove();
    document.removeEventListener('mousedown', onPointerDown, true);
    window.removeEventListener('blur', cleanup);
  };

  window.addEventListener('blur', cleanup);
  requestAnimationFrame(() => {
    document.addEventListener('mousedown', onPointerDown, true);
  });
}

// ── Main toolbar rendering ──

export function renderToolbarActions(): void {
  if (!_aiChatToggleHooked) {
    _aiChatToggleHooked = true;
    document.addEventListener('ai-chat-toggled', () => renderToolbarActions());
  }

  const toolbarLeftEl = getToolbarLeftEl();
  const toolbarRightEl = getToolbarRightEl();

  toolbarLeftEl.innerHTML = '';
  toolbarRightEl.innerHTML = '';

  // On Windows/Linux: show app icon as the leftmost element in the toolbar.
  // Clicking it opens the app menu (same as the ≡ button).
  if (needsCustomControls) {
    const appIconBtn = document.createElement('button');
    appIconBtn.className = 'toolbar-app-icon-btn';
    appIconBtn.type = 'button';
    appIconBtn.title = settings?.language === 'zh' ? '应用菜单' : 'App Menu';
    appIconBtn.innerHTML = `<img class="toolbar-app-icon-img" src="${appIconUrl}" alt="App" />`;
    appIconBtn.onclick = (event) => {
      event.stopPropagation();
      showWindowsToolbarMenu(appIconBtn);
    };
    toolbarLeftEl.appendChild(appIconBtn);
  }

  const homeBtn = document.createElement('button');
  homeBtn.className = `toolbar-action-btn conn-toggle-btn ${ConnectionSidebar.isOpen() ? 'active' : ''}`;
  homeBtn.type = 'button';
  homeBtn.title = settings?.language === 'zh' ? '连接' : 'Connections';
  // Sidebar-style icon (panel with a left column) — toggles the docked
  // connection sidebar (which pushes the terminal aside, never covers it).
  homeBtn.innerHTML = `<span class="tab-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/></svg></span>`;
  homeBtn.onclick = () => {
    ConnectionSidebar.toggle();
    const open = ConnectionSidebar.isOpen();
    homeBtn.classList.toggle('active', open);
    // Mutually exclusive with the file manager — opening the sidebar closes it.
    if (open) {
      const sid = TabManager.getActiveSessionId();
      if (sid) closeFileManager(sid);
    }
  };
  // Hover → float the sidebar out as a dropdown menu; click pins it docked.
  homeBtn.addEventListener('mouseenter', () => ConnectionSidebar.showFlyout(homeBtn));
  homeBtn.addEventListener('mouseleave', () => ConnectionSidebar.scheduleHideFlyout());
  toolbarLeftEl.appendChild(homeBtn);

  // File manager toggle button — only when tabs exist and not in home/gallery view
  if (TabManager.tabs.length > 0 && !isHomeView && !isGalleryView) {
    const activeSessionId = TabManager.getActiveSessionId();
    const hasFm = activeSessionId && DrawerManager.has(activeSessionId);
    if (hasFm) {
      const fmBtn = document.createElement('button');
      fmBtn.className = `toolbar-action-btn ${isFileManagerOpen(activeSessionId) ? 'active' : ''}`;
      fmBtn.type = 'button';
      fmBtn.title = t('fileManager');
      fmBtn.innerHTML = `<span class="tab-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/><line x1="12.2" y1="9" x2="17.8" y2="9"/><line x1="12.2" y1="12.5" x2="17.8" y2="12.5"/><line x1="12.2" y1="16" x2="17.8" y2="16"/></svg></span>`;
      fmBtn.onclick = () => {
        toggleFileManager(activeSessionId);
      };
      toolbarLeftEl.appendChild(fmBtn);
    }
  }

  if (settings?.enableThumbnail !== false) {
    const galleryBtn = document.createElement('button');
    galleryBtn.className = `toolbar-action-btn ${isGalleryView ? 'active' : ''}`;
    galleryBtn.type = 'button';
    galleryBtn.title = t('sessionsGallery');
    galleryBtn.innerHTML = `<span class="tab-icon">${icon('gallery')}</span>`;
    galleryBtn.onclick = () => {
      showGalleryView();
      renderTabs();
    };
    toolbarLeftEl.appendChild(galleryBtn);
  }

  const newBtn = document.createElement('button');
  newBtn.className = 'toolbar-action-btn';
  newBtn.type = 'button';
  newBtn.title = t('newTerminal');
  newBtn.innerHTML = `<span class="tab-icon">${icon('plus')}</span>`;
  newBtn.onclick = async () => {
    await createNewSession();
  };
  newBtn.addEventListener('contextmenu', (e) => {
    _showShellContextMenu(e, newBtn);
  });
  toolbarLeftEl.appendChild(newBtn);

  // Remote session list button — only visible when remote tabs exist
  if (hasRemoteTabs()) {
    const remoteListBtn = document.createElement('button');
    remoteListBtn.className = 'toolbar-icon-btn remote-list-btn';
    remoteListBtn.type = 'button';
    remoteListBtn.title = t('remoteSessionList');
    remoteListBtn.innerHTML = `<span class="tab-icon">${icon('remoteList')}</span>`;
    remoteListBtn.onclick = () => showRemoteSessionListPopup(remoteListBtn);
    toolbarRightEl.appendChild(remoteListBtn);
  }

  // JumpServer asset browser button — only visible when authenticated JS connections exist
  if (activeJumpServers.size > 0) {
    const jsBtn = document.createElement('button');
    jsBtn.className = `toolbar-icon-btn${isJumpServerPanelOpen() ? ' active' : ''}`;
    jsBtn.type = 'button';
    jsBtn.title = 'JumpServer';
    jsBtn.innerHTML = `<span class="tab-icon">${icon('jumpserver')}</span>`;
    // 统一交互：左键永远弹 dropdown（即使只有一个连接），让"退出登录"
    // 入口在每项末尾的 ⋯ 按钮稳定可见。
    jsBtn.onclick = () => showJumpServerDropdown(jsBtn);
    toolbarRightEl.appendChild(jsBtn);
  }

  // AI agent button — toggles the AI chat side panel for the active session.
  // Placed to the LEFT of the share button. Only shown when a terminal tab is
  // active (the AI capsule is session-scoped).
  if (TabManager.tabs.length > 0 && !isHomeView && !isGalleryView) {
    const agentSessionId = TabManager.getActiveSessionId();
    if (agentSessionId) {
      const chatOpen = AICapsuleManager.isChatSidebarOpen(agentSessionId);
      const agentBtn = document.createElement('button');
      agentBtn.className = `toolbar-icon-btn ai-agent-btn${chatOpen ? ' active' : ''}`;
      agentBtn.type = 'button';
      agentBtn.title = settings?.language === 'zh' ? 'AI 助手' : 'AI Agent';
      agentBtn.innerHTML = `<span class="ai-agent-text">AI</span>`;
      agentBtn.onclick = () => {
        AICapsuleManager.toggleChatSidebar(agentSessionId);
        renderToolbarActions();
      };
      toolbarRightEl.appendChild(agentBtn);
    }
  }

  const shareBtn = document.createElement('button');
  shareBtn.className = 'toolbar-icon-btn';
  shareBtn.type = 'button';
  shareBtn.title = t('shareLink');
  shareBtn.innerHTML = `<span class="tab-icon">${icon('share')}</span>`;
  shareBtn.onclick = () => openSettings('sharing');
  toolbarRightEl.appendChild(shareBtn);

  // Update available icon (shown only when update is pending and user hasn't hidden it)
  if (pendingUpdateVersion && !localStorage.getItem('meterm-hide-update-icon')) {
    const updateBtn = document.createElement('button');
    updateBtn.className = 'toolbar-icon-btn toolbar-update-btn';
    updateBtn.type = 'button';
    updateBtn.title = t('updateAvailable').replace('{version}', pendingUpdateVersion);
    updateBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v10m0 0 3.5-3.5M12 12l-3.5-3.5"/><path d="M4.93 15A8 8 0 1 0 12 4"/></svg>`;
    updateBtn.onclick = () => { void openUpdaterWindow(); };
    toolbarRightEl.appendChild(updateBtn);
  }

  // Always-on-top (pin) button: only show when there are terminal tabs and NOT in PiP
  if (TabManager.tabs.length > 0 && !isPipActive()) {
    const aotBtn = document.createElement('button');
    aotBtn.className = `toolbar-icon-btn always-on-top-btn${isAlwaysOnTop ? ' active' : ''}`;
    aotBtn.type = 'button';
    aotBtn.title = isAlwaysOnTop
      ? (settings?.language === 'zh' ? '取消置顶' : 'Unpin from top')
      : (settings?.language === 'zh' ? '窗口置顶' : 'Always on top');
    aotBtn.innerHTML = `<span class="tab-icon">${icon('pin')}</span>`;
    aotBtn.onclick = () => { void toggleAlwaysOnTop(); };
    toolbarRightEl.appendChild(aotBtn);
  }

  // PiP button: only show when there are terminal tabs
  if (TabManager.tabs.length > 0 || isPipActive()) {
    const pipBtn = document.createElement('button');
    pipBtn.className = `toolbar-icon-btn pip-pin-btn${isPipActive() ? ' active' : ''}`;
    pipBtn.type = 'button';
    pipBtn.title = isPipActive()
      ? (settings?.language === 'zh' ? '退出画中画' : 'Exit Picture-in-Picture')
      : (settings?.language === 'zh' ? '画中画' : 'Picture-in-Picture');
    pipBtn.innerHTML = `<span class="tab-icon">${icon('pip')}</span>`;
    pipBtn.onclick = () => { void togglePip(); };
    toolbarRightEl.appendChild(pipBtn);
  }

  // Settings is reachable from the connection sidebar footer, the macOS menu
  // bar, and ⌘, — the toolbar gear was removed per request.

  if (needsCustomControls) {
    // Visual separator between app buttons and OS window controls
    const sep = document.createElement('div');
    sep.className = 'win-controls-separator';
    toolbarRightEl.appendChild(sep);

    // Minimize
    const minBtn = document.createElement('button');
    minBtn.className = 'win-control-btn win-minimize-btn';
    minBtn.type = 'button';
    minBtn.title = settings?.language === 'zh' ? '最小化' : 'Minimize';
    minBtn.innerHTML = WIN_ICON_MINIMIZE;
    minBtn.onclick = () => { void getCurrentWindow().minimize(); };
    toolbarRightEl.appendChild(minBtn);

    // Maximize / Restore — icon is updated by the resize listener
    const maxBtn = document.createElement('button');
    maxBtn.className = 'win-control-btn win-maximize-btn';
    maxBtn.type = 'button';
    maxBtn.innerHTML = WIN_ICON_MAXIMIZE;
    maxBtn.onclick = async () => {
      const isMax = await getCurrentWindow().isMaximized();
      if (isMax) {
        void getCurrentWindow().unmaximize();
      } else {
        void getCurrentWindow().maximize();
      }
    };
    toolbarRightEl.appendChild(maxBtn);
    // Sync icon to current maximize state immediately
    void getCurrentWindow().isMaximized().then((isMax) => {
      maxBtn.innerHTML = isMax ? WIN_ICON_RESTORE : WIN_ICON_MAXIMIZE;
      maxBtn.title = isMax
        ? (settings?.language === 'zh' ? '还原' : 'Restore')
        : (settings?.language === 'zh' ? '最大化' : 'Maximize');
    });

    // Close — goes through the existing confirmation-dialog flow
    const closeBtn = document.createElement('button');
    closeBtn.className = 'win-control-btn win-close-btn';
    closeBtn.type = 'button';
    closeBtn.title = settings?.language === 'zh' ? '关闭' : 'Close';
    closeBtn.innerHTML = WIN_ICON_CLOSE;
    closeBtn.onclick = () => { void getCurrentWindow().close(); };
    toolbarRightEl.appendChild(closeBtn);
  }
}

// ── JumpServer dropdown (multiple connections) ──

function showJumpServerDropdown(anchor: HTMLElement): void {
  const existing = document.getElementById('js-dropdown-menu');
  if (existing) { existing.remove(); return; }

  const menu = document.createElement('div');
  menu.id = 'js-dropdown-menu';
  menu.className = 'custom-context-menu';

  for (const [name, config] of activeJumpServers) {
    const row = document.createElement('div');
    row.className = 'js-dropdown-item';

    const mainBtn = document.createElement('button');
    mainBtn.className = 'js-dropdown-item-main';
    mainBtn.type = 'button';
    mainBtn.textContent = name;
    mainBtn.onclick = () => {
      cleanup();
      toggleJumpServerPanel(config);
    };

    const actionsBtn = document.createElement('button');
    actionsBtn.className = 'js-dropdown-item-actions';
    actionsBtn.type = 'button';
    actionsBtn.title = t('jsItemActionsTitle');
    actionsBtn.setAttribute('aria-label', t('jsItemActionsTitle'));
    actionsBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg>';
    actionsBtn.onclick = (e) => {
      e.stopPropagation();
      const r = actionsBtn.getBoundingClientRect();
      // 不 cleanup dropdown：子菜单作为浮层叠在 dropdown 上方，
      // 保留服务列表作为操作上下文（标准父-子菜单交互）。
      showJsConnectionContextMenu(r.left, r.bottom + 4, config);
    };

    row.appendChild(mainBtn);
    row.appendChild(actionsBtn);

    // 右键作为高级快捷方式保留：行任意位置右键都能唤起菜单
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showJsConnectionContextMenu(e.clientX, e.clientY, config);
    });

    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(6, rect.left)}px`;
  menu.style.top = `${rect.bottom + 6}px`;

  const menuRect = menu.getBoundingClientRect();
  if (menuRect.right > window.innerWidth - 6) {
    menu.style.left = `${Math.max(6, window.innerWidth - menuRect.width - 6)}px`;
  }
  if (menuRect.bottom > window.innerHeight - 6) {
    menu.style.top = `${Math.max(6, rect.top - menuRect.height - 6)}px`;
  }

  const onPointerDown = (event: MouseEvent): void => {
    const target = event.target as Node | null;
    if (!target) return;
    if (menu.contains(target) || anchor.contains(target)) return;
    // 子菜单（点 ⋯ 弹出）的点击不算 dropdown 外部 — 否则 dropdown 会
    // 在用户操作子菜单的瞬间消失，破坏父-子菜单层级。
    const subMenu = document.getElementById('js-connection-context-menu');
    if (subMenu && subMenu.contains(target)) return;
    cleanup();
  };

  const cleanup = (): void => {
    menu.remove();
    // dropdown 关闭时同步关闭可能残留的子菜单，避免悬空
    document.getElementById('js-connection-context-menu')?.remove();
    document.removeEventListener('mousedown', onPointerDown, true);
    document.removeEventListener('jumpserver-auth-changed', onAuthChanged);
    window.removeEventListener('blur', cleanup);
  };

  // 登出/认证状态变化 → dropdown 显示的列表已过期，关闭它（避免点击残留项）
  const onAuthChanged = (): void => cleanup();

  window.addEventListener('blur', cleanup);
  document.addEventListener('jumpserver-auth-changed', onAuthChanged);
  requestAnimationFrame(() => {
    document.addEventListener('mousedown', onPointerDown, true);
  });
}

// ── Toolbar drag ──

export function setupToolbarDrag(): void {
  const dragLayer = document.getElementById('window-toolbar-drag-layer');
  if (!dragLayer) return;
  // On Linux CSD, remove data-tauri-drag-region to avoid conflict with
  // the manual startDragging() handler (double drag attempt causes issues).
  if (isLinuxPlatform) {
    dragLayer.removeAttribute('data-tauri-drag-region');
  }
  dragLayer.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow().startDragging();
  });
}
