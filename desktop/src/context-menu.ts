/**
 * context-menu.ts — Context menus (tab, shell, terminal)
 *
 * Extracted from main.ts. Contains:
 * - showTabContextMenu()
 * - showShellContextMenu()
 * - showCustomContextMenu()
 * - getAvailableShells() / cachedShells
 */

import { TabManager, type Tab } from './tabs';
import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { AICapsuleManager } from './ai-capsule';
import { getAllLeaves, countLeaves, findLeafById } from './split-pane';
import { StatusBar } from './status-bar';
import { t } from './i18n';
import { invoke } from '@tauri-apps/api/core';
import { confirm } from '@tauri-apps/plugin-dialog';
import { writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { getSelection, performCopy, performPaste } from './clipboard-actions';
import { activateTab, showHomeView, openSettings, syncLockIconForActiveTab } from './view-manager';
import { doSplitPane, createNewSession, closeAllSessions } from './session-actions';
import { renderTabs } from './tab-renderer';
import {
  pendingMasterRequests,
  viewerModeSessionIds, privateSessionIds,
  reclaimSessionIds,
  removeKickedOverlay, removeReconnectOverlay,
} from './overlays';
import {
  settings,
  sshConfigMap, remoteInfoMap, sessionProgressMap,
  remoteTabNumbers, jumpServerConfigMap,
} from './app-state';
import type { SSHConnectionConfig } from './ssh';

// ── Shell info cache ──

interface ShellInfo {
  path: string;
  name: string;
  is_default: boolean;
}

let cachedShells: ShellInfo[] | null = null;

async function getAvailableShells(): Promise<ShellInfo[]> {
  if (cachedShells) return cachedShells;
  try {
    cachedShells = await invoke<ShellInfo[]>('list_available_shells');
  } catch {
    cachedShells = [];
  }
  return cachedShells;
}

/** Pre-cache shell list in background so context menu opens instantly. */
export function preloadShells(): void {
  void getAvailableShells();
}

/** Return the resolved default shell path from cached data (sync, best-effort). */
export function getDefaultShellPath(): string | undefined {
  if (!cachedShells) return undefined;
  const userDefault = settings.defaultShell;
  if (userDefault) return userDefault;
  return cachedShells.find((s) => s.is_default)?.path;
}

// ── Tab context menu ──

export function showTabContextMenu(event: MouseEvent, tab: Tab, tabIndex: number): void {
  event.preventDefault();
  event.stopPropagation();

  const existing = document.getElementById('custom-context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.id = 'custom-context-menu';
  menu.className = 'custom-context-menu';
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  const totalTabs = TabManager.tabs.length;

  const addItem = (label: string, onClick: () => void, disabled = false) => {
    const item = document.createElement('button');
    item.className = 'custom-context-menu-item';
    item.type = 'button';
    item.textContent = label;
    item.disabled = disabled;
    item.onclick = () => {
      menu.remove();
      onClick();
    };
    menu.appendChild(item);
  };

  const addDivider = () => {
    menu.appendChild(document.createElement('div')).className = 'custom-context-menu-divider';
  };

  const closeTab = async (tabId: string) => {
    const closingTab = TabManager.tabs.find((t) => t.id === tabId);
    if (closingTab) {
      const closingLeaves = getAllLeaves(closingTab.splitRoot);
      for (const leaf of closingLeaves) {
        DrawerManager.destroy(leaf.sessionId);
        AICapsuleManager.destroy(leaf.sessionId);
        sshConfigMap.delete(leaf.sessionId);
        jumpServerConfigMap.delete(leaf.sessionId);
        remoteInfoMap.delete(leaf.sessionId);
        remoteTabNumbers.delete(leaf.sessionId);
        viewerModeSessionIds.delete(leaf.sessionId);
        reclaimSessionIds.delete(leaf.sessionId);
        privateSessionIds.delete(leaf.sessionId);
        sessionProgressMap.delete(leaf.sessionId);
        removeKickedOverlay(leaf.sessionId);
        removeReconnectOverlay(leaf.sessionId);
      }
    }
    await TabManager.closeTab(tabId);
  };

  addItem(t('tabMenuCloseTab'), () => {
    void closeTab(tab.id).then(async () => {
      if (TabManager.activeTabId) {
        await activateTab(TabManager.activeTabId);
        const newActiveTab = TabManager.tabs.find(t => t.id === TabManager.activeTabId);
        if (newActiveTab) {
          const activeSessionId = TabManager.getActiveSessionId();
          const sshCfg = activeSessionId ? sshConfigMap.get(activeSessionId) : undefined;
          StatusBar.setConnection(newActiveTab.status, sshCfg ? `${sshCfg.username}@${sshCfg.host}` : 'Local');
        }
      } else {
        showHomeView();
      }
      renderTabs();
    });
  });

  addItem(t('tabMenuCloseOthers'), () => {
    const others = TabManager.tabs.filter((t) => t.id !== tab.id).map((t) => t.id);
    void (async () => {
      for (const id of others) await closeTab(id);
      TabManager.activate(tab.id);
      await activateTab(tab.id);
      renderTabs();
    })();
  }, totalTabs <= 1);

  addItem(t('tabMenuCloseLeft'), () => {
    const leftIds = TabManager.tabs.slice(0, tabIndex).map((t) => t.id);
    void (async () => {
      for (const id of leftIds) await closeTab(id);
      TabManager.activate(tab.id);
      await activateTab(tab.id);
      renderTabs();
    })();
  }, tabIndex === 0);

  addItem(t('tabMenuCloseRight'), () => {
    const rightIds = TabManager.tabs.slice(tabIndex + 1).map((t) => t.id);
    void (async () => {
      for (const id of rightIds) await closeTab(id);
      TabManager.activate(tab.id);
      await activateTab(tab.id);
      renderTabs();
    })();
  }, tabIndex === totalTabs - 1);

  addDivider();

  addItem(t('tabMenuCloseAll'), () => {
    void closeAllSessions();
  });

  addDivider();

  addItem(t('tabMenuCopyTitle'), () => {
    void clipboardWriteText(tab.title);
  });

  addItem(t('tabMenuCloneTab'), () => {
    // Check if any session in the tab is SSH
    const cloneLeaves = getAllLeaves(tab.splitRoot);
    let sshConfig: SSHConnectionConfig | undefined;
    for (const leaf of cloneLeaves) {
      const cfg = sshConfigMap.get(leaf.sessionId);
      if (cfg) { sshConfig = cfg; break; }
    }
    if (sshConfig) {
      document.dispatchEvent(new CustomEvent('ssh-clone-session', { detail: sshConfig }));
    } else {
      void createNewSession();
    }
  });

  // Lock/Unlock session (for local and SSH sessions, not remote viewer)
  const tabLeaves = getAllLeaves(tab.splitRoot);
  const isOwnedTab = tabLeaves.every((l) => !viewerModeSessionIds.has(l.sessionId) && !remoteInfoMap.has(l.sessionId));
  if (isOwnedTab) {
    const activeLeaf = tabLeaves[0];
    if (activeLeaf) {
      const isPrivate = privateSessionIds.has(activeLeaf.sessionId);
      addItem(isPrivate ? t('tabMenuUnlockSession') : t('tabMenuLockSession'), () => {
        const newPrivate = !isPrivate;
        void (async () => {
          if (newPrivate) {
            const confirmed = await confirm(t('lockSessionConfirm'), {
              title: t('tabMenuLockSession'),
              kind: 'warning',
              okLabel: t('tabMenuLockSession'),
              cancelLabel: t('hideToTrayTipCancel'),
            });
            if (!confirmed) return;
          }
          try {
            await invoke('set_session_private', { sessionId: activeLeaf.sessionId, private: newPrivate });
            if (newPrivate) {
              privateSessionIds.add(activeLeaf.sessionId);
            } else {
              privateSessionIds.delete(activeLeaf.sessionId);
            }
            syncLockIconForActiveTab();
            renderTabs();
          } catch (err) {
            console.error('set_session_private failed:', err);
          }
        })();
      });
    }
  }

  addDivider();

  const splitDisabled = countLeaves(tab.splitRoot) >= 4;
  addItem(t('splitHorizontal'), () => {
    void (async () => {
      TabManager.activate(tab.id);
      await doSplitPane(tab.id, tab.focusedPaneId, 'horizontal');
      await activateTab(tab.id);
      renderTabs();
    })();
  }, splitDisabled);

  addItem(t('splitVertical'), () => {
    void (async () => {
      TabManager.activate(tab.id);
      await doSplitPane(tab.id, tab.focusedPaneId, 'vertical');
      await activateTab(tab.id);
      renderTabs();
    })();
  }, splitDisabled);

  document.body.appendChild(menu);

  // Boundary detection
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  if (rect.right > viewportWidth) {
    menu.style.left = `${Math.max(6, viewportWidth - rect.width - 6)}px`;
  }
  if (rect.bottom > viewportHeight) {
    menu.style.top = `${Math.max(6, viewportHeight - rect.height - 6)}px`;
  }

  const cleanup = () => {
    menu.remove();
    document.removeEventListener('click', cleanup, true);
    window.removeEventListener('blur', cleanup);
  };
  document.addEventListener('click', cleanup, true);
  window.addEventListener('blur', cleanup);
}

// ── Shell selection context menu ──

export function showShellContextMenu(event: MouseEvent, anchor?: HTMLElement): void {
  event.preventDefault();
  event.stopPropagation();

  const existing = document.getElementById('shell-context-menu');
  if (existing) { existing.remove(); return; }

  const menu = document.createElement('div');
  menu.id = 'shell-context-menu';
  menu.className = 'custom-context-menu';

  // Position near anchor or mouse
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 4}px`;
  } else {
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
  }

  const cleanup = () => {
    menu.remove();
    document.removeEventListener('click', onClickOutside, true);
    window.removeEventListener('blur', cleanup);
  };
  const onClickOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) cleanup();
  };

  // Loading placeholder
  const loading = document.createElement('div');
  loading.className = 'custom-context-menu-item';
  loading.textContent = '...';
  loading.style.opacity = '0.5';
  menu.appendChild(loading);

  document.body.appendChild(menu);

  // Ensure menu doesn't go off-screen
  requestAnimationFrame(() => {
    const mr = menu.getBoundingClientRect();
    if (mr.right > window.innerWidth) menu.style.left = `${window.innerWidth - mr.width - 8}px`;
    if (mr.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - mr.height - 8}px`;
  });

  setTimeout(() => {
    document.addEventListener('click', onClickOutside, true);
    window.addEventListener('blur', cleanup);
  }, 0);

  // Load shells and populate
  void getAvailableShells().then((shells) => {
    menu.innerHTML = '';
    if (shells.length === 0) {
      const item = document.createElement('div');
      item.className = 'custom-context-menu-item';
      item.textContent = t('noShellsFound');
      item.style.opacity = '0.5';
      menu.appendChild(item);
      return;
    }

    // Determine effective default: user setting overrides system default
    const userDefault = settings.defaultShell;
    const isDefault = (s: ShellInfo) => userDefault ? s.path === userDefault : s.is_default;
    const defaultShells = shells.filter(isDefault);
    const otherShells = shells.filter((s) => !isDefault(s));

    const addShellItem = (shell: ShellInfo, showBadge: boolean) => {
      const item = document.createElement('button');
      item.className = 'custom-context-menu-item';
      item.type = 'button';
      item.textContent = shell.name;
      if (showBadge) {
        const badge = document.createElement('span');
        badge.className = 'shell-default-badge';
        badge.textContent = t('defaultShell');
        item.appendChild(badge);
      }
      item.onclick = () => {
        cleanup();
        void createNewSession(shell.path);
      };
      menu.appendChild(item);
    };

    for (const shell of defaultShells) addShellItem(shell, true);
    if (defaultShells.length > 0 && otherShells.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'custom-context-menu-divider';
      menu.appendChild(sep);
    }
    for (const shell of otherShells) addShellItem(shell, false);

    // Re-check position after content loaded
    requestAnimationFrame(() => {
      const mr = menu.getBoundingClientRect();
      if (mr.right > window.innerWidth) menu.style.left = `${window.innerWidth - mr.width - 8}px`;
      if (mr.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - mr.height - 8}px`;
    });
  });
}

// ── Terminal context menu ──

export function showCustomContextMenu(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  // Allow native context menu for input fields (copy/paste/cut/select all)
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    return;
  }
  // Let AI chat panel handle its own context menu (suppress system menu but don't show terminal menu)
  if (target?.closest('.ai-chat-messages')) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  // Only show terminal context menu when right-clicking inside the terminal area
  // (.xterm or .terminal-container), not on AI bar, drawers, home, toolbars, etc.
  const inTerminal = target?.closest('.xterm') || target?.closest('.terminal-container');
  if (!inTerminal) {
    return;
  }
  const existing = document.getElementById('custom-context-menu');
  if (existing) {
    existing.remove();
  }

  const menu = document.createElement('div');
  menu.id = 'custom-context-menu';
  menu.className = 'custom-context-menu';
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  const addItem = (label: string, onClick: () => void, disabled = false) => {
    const item = document.createElement('button');
    item.className = 'custom-context-menu-item';
    item.type = 'button';
    item.textContent = label;
    item.disabled = disabled;
    item.onclick = () => {
      menu.remove();
      onClick();
    };
    menu.appendChild(item);
  };

  addItem(t('contextMenuNewTerminal'), () => {
    void createNewSession();
  });
  addItem(t('contextMenuHome'), () => {
    showHomeView();
    renderTabs();
  });
  addItem(t('contextMenuSettings'), () => {
    openSettings();
  });
  addItem(t('contextMenuCloseSession'), () => {
    if (TabManager.activeTabId) {
      const activeTab = TabManager.getActiveTab();
      if (activeTab) {
        const closingLeaves = getAllLeaves(activeTab.splitRoot);
        for (const leaf of closingLeaves) {
          DrawerManager.destroy(leaf.sessionId);
          AICapsuleManager.destroy(leaf.sessionId);
          sshConfigMap.delete(leaf.sessionId);
          jumpServerConfigMap.delete(leaf.sessionId);
          remoteInfoMap.delete(leaf.sessionId);
          remoteTabNumbers.delete(leaf.sessionId);
          viewerModeSessionIds.delete(leaf.sessionId);
          reclaimSessionIds.delete(leaf.sessionId);
          sessionProgressMap.delete(leaf.sessionId);
          removeKickedOverlay(leaf.sessionId);
          removeReconnectOverlay(leaf.sessionId);
        }
      }
      void TabManager.closeTab(TabManager.activeTabId).then(async () => {
        if (TabManager.activeTabId) {
          await activateTab(TabManager.activeTabId);
          const newActiveTab = TabManager.tabs.find(t => t.id === TabManager.activeTabId);
          if (newActiveTab) {
            const activeSessionId = TabManager.getActiveSessionId();
            const sshCfg = activeSessionId ? sshConfigMap.get(activeSessionId) : undefined;
            StatusBar.setConnection(newActiveTab.status, sshCfg ? `${sshCfg.username}@${sshCfg.host}` : 'Local');
          }
        } else {
          showHomeView();
        }
        renderTabs();
      });
    }
  }, !TabManager.activeTabId);

  menu.appendChild(document.createElement('div')).className = 'custom-context-menu-divider';

  const hasSelection = !!getSelection();
  addItem(t('contextMenuCopy'), () => {
    performCopy();
  }, !hasSelection);
  addItem(t('contextMenuPaste'), () => {
    performPaste();
  });

  // Split pane items
  const activeTabForCtx = TabManager.getActiveTab();
  if (activeTabForCtx) {
    menu.appendChild(document.createElement('div')).className = 'custom-context-menu-divider';
    const splitCtxDisabled = countLeaves(activeTabForCtx.splitRoot) >= 4;
    addItem(t('splitHorizontal'), () => {
      void (async () => {
        await doSplitPane(activeTabForCtx.id, activeTabForCtx.focusedPaneId, 'horizontal');
        await activateTab(activeTabForCtx.id);
        renderTabs();
      })();
    }, splitCtxDisabled);
    addItem(t('splitVertical'), () => {
      void (async () => {
        await doSplitPane(activeTabForCtx.id, activeTabForCtx.focusedPaneId, 'vertical');
        await activateTab(activeTabForCtx.id);
        renderTabs();
      })();
    }, splitCtxDisabled);

    if (countLeaves(activeTabForCtx.splitRoot) > 1) {
      addItem(t('closePane'), () => {
        const closingLeaf = findLeafById(activeTabForCtx.splitRoot, activeTabForCtx.focusedPaneId);
        if (closingLeaf) {
          DrawerManager.destroy(closingLeaf.sessionId);
          AICapsuleManager.destroy(closingLeaf.sessionId);
          sshConfigMap.delete(closingLeaf.sessionId);
          jumpServerConfigMap.delete(closingLeaf.sessionId);
          remoteInfoMap.delete(closingLeaf.sessionId);
          remoteTabNumbers.delete(closingLeaf.sessionId);
          viewerModeSessionIds.delete(closingLeaf.sessionId);
          reclaimSessionIds.delete(closingLeaf.sessionId);
          { const pr = pendingMasterRequests.get(closingLeaf.sessionId); if (pr) { clearTimeout(pr.timerId); pendingMasterRequests.delete(closingLeaf.sessionId); } }
          sessionProgressMap.delete(closingLeaf.sessionId);
          removeKickedOverlay(closingLeaf.sessionId);
          removeReconnectOverlay(closingLeaf.sessionId);
        }
        void TabManager.closePane(activeTabForCtx.id, activeTabForCtx.focusedPaneId).then(async () => {
          if (TabManager.activeTabId) {
            await activateTab(TabManager.activeTabId);
          }
          renderTabs();
        });
      });
    }
  }

  document.body.appendChild(menu);

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const rect = menu.getBoundingClientRect();
  if (rect.right > viewportWidth) {
    menu.style.left = `${Math.max(6, viewportWidth - rect.width - 6)}px`;
  }
  if (rect.bottom > viewportHeight) {
    menu.style.top = `${Math.max(6, viewportHeight - rect.height - 6)}px`;
  }

  const cleanup = () => {
    menu.remove();
    document.removeEventListener('click', cleanup, true);
    window.removeEventListener('blur', cleanup);
  };
  document.addEventListener('click', cleanup, true);
  window.addEventListener('blur', cleanup);
}
