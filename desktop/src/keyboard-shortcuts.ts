/**
 * keyboard-shortcuts.ts — Keyboard shortcut handler
 *
 * Extracted from main.ts. Handles Cmd/Ctrl+T, W, K, comma, D, Shift+D, Alt+Arrow.
 */

import { TabManager } from './tabs';
import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { AICapsuleManager } from './ai-capsule';
import { SplitPaneManager, getAllLeaves, countLeaves, findLeafById, getAdjacentLeaf } from './split-pane';
import { StatusBar } from './status-bar';
import { activateTab, showHomeView, openSettings } from './view-manager';
import { createNewSession, doSplitPane } from './session-actions';
import { renderTabs } from './tab-renderer';
import {
  removeKickedOverlay, removeReconnectOverlay,
  viewerModeSessionIds, reclaimSessionIds,
} from './overlays';
import {
  sshConfigMap, remoteInfoMap, sessionProgressMap, remoteTabNumbers,
  jumpServerConfigMap,
  settings,
} from './app-state';
import { showQuickHelp } from './tldr-card';
import { togglePip, isPipActive } from './pip';

export function setupKeyboardShortcuts(): void {
  document.addEventListener('keydown', async (event) => {
    const isMac = navigator.userAgent.includes('Mac');

    // ── Tab switching: Ctrl+Tab / Ctrl+Shift+Tab (next/prev) ──
    // Must be before the mod check since Ctrl+Tab doesn't use Cmd on macOS
    if (event.ctrlKey && event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const tabs = TabManager.tabs;
      if (tabs.length > 1 && TabManager.activeTabId) {
        const currentIndex = tabs.findIndex(t => t.id === TabManager.activeTabId);
        const nextIndex = event.shiftKey
          ? (currentIndex - 1 + tabs.length) % tabs.length
          : (currentIndex + 1) % tabs.length;
        const targetTab = tabs[nextIndex];
        TabManager.activate(targetTab.id);
        void activateTab(targetTab.id);
        renderTabs();
      }
      return;
    }

    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (!mod) {
      return;
    }

    const key = event.key.toLowerCase();

    // PiP toggle (Cmd/Ctrl+Shift+P) — must be checked BEFORE the Windows
    // terminal-focus guard below, because Ctrl+Shift+P doesn't conflict
    // with any TUI app and must work even when the terminal is focused.
    if (key === 'p' && event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void togglePip();
      return;
    }

    // On Windows, skip app-level shortcuts when focus is inside the xterm terminal
    // to prevent conflicts with TUI keyboard shortcuts (e.g. Ctrl+W in vim/htop).
    // On macOS, the modifier is Cmd (metaKey) which xterm doesn't forward to the PTY,
    // so there is no conflict on macOS.
    if (!isMac) {
      const target = event.target as Element;
      const inTerminal =
        target.tagName === 'TEXTAREA' ||
        (typeof (target as HTMLElement).closest === 'function' &&
          (target as HTMLElement).closest('.xterm') !== null);
      if (inTerminal) return;
    }

    if (key === 't') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      await createNewSession();
      return;
    }

    if (key === 'w') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const activeTab = TabManager.getActiveTab();
      if (activeTab) {
        const leafCount = countLeaves(activeTab.splitRoot);
        if (leafCount > 1) {
          // Multi-pane: close focused pane only
          const closingLeaf = findLeafById(activeTab.splitRoot, activeTab.focusedPaneId);
          if (closingLeaf) {
            DrawerManager.destroy(closingLeaf.sessionId);
            AICapsuleManager.destroy(closingLeaf.sessionId);
            sshConfigMap.delete(closingLeaf.sessionId);
            jumpServerConfigMap.delete(closingLeaf.sessionId);
            sessionProgressMap.delete(closingLeaf.sessionId);
            removeKickedOverlay(closingLeaf.sessionId);
            removeReconnectOverlay(closingLeaf.sessionId);
          }
          await TabManager.closePane(activeTab.id, activeTab.focusedPaneId);
          if (TabManager.activeTabId) {
            await activateTab(TabManager.activeTabId);
          }
        } else {
          // Single pane: close the tab
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
          await TabManager.closeTab(activeTab.id);
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
        }
        renderTabs();
      }
      return;
    }

    if (key === 'k') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const focusedSessionId = TabManager.getActiveSessionId();
      if (focusedSessionId) {
        TerminalRegistry.clearSession(focusedSessionId);
      } else {
        TerminalRegistry.clearActive();
      }
      return;
    }

    if (key === ',') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      openSettings();
      return;
    }

    // Split pane shortcuts
    if (key === 'd' && !event.shiftKey) {
      // ⌘D: horizontal split
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const splitTab = TabManager.getActiveTab();
      if (splitTab && countLeaves(splitTab.splitRoot) < 4) {
        void (async () => {
          await doSplitPane(splitTab.id, splitTab.focusedPaneId, 'horizontal');
          await activateTab(splitTab.id);
          renderTabs();
        })();
      }
      return;
    }

    if (key === 'd' && event.shiftKey) {
      // ⌘⇧D: vertical split
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const splitTab = TabManager.getActiveTab();
      if (splitTab && countLeaves(splitTab.splitRoot) < 4) {
        void (async () => {
          await doSplitPane(splitTab.id, splitTab.focusedPaneId, 'vertical');
          await activateTab(splitTab.id);
          renderTabs();
        })();
      }
      return;
    }

    // ── Tab switching: Cmd/Ctrl+1~9 (Chrome-style) ──
    if (!event.shiftKey && !event.altKey && key >= '1' && key <= '9') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const tabs = TabManager.tabs;
      if (tabs.length > 0) {
        const num = parseInt(key, 10);
        // 9 = last tab (Chrome behavior), otherwise 1-indexed
        const index = key === '9' ? tabs.length - 1 : Math.min(num - 1, tabs.length - 1);
        const targetTab = tabs[index];
        if (targetTab && targetTab.id !== TabManager.activeTabId) {
          TabManager.activate(targetTab.id);
          void activateTab(targetTab.id);
          renderTabs();
        }
      }
      return;
    }

    // PiP mode: block all other shortcuts except Cmd+W (close) and
    // Cmd/Ctrl+Shift+P (PiP toggle, handled above the terminal-focus guard)
    if (isPipActive()) return;

    // ⌘⇧H or Ctrl+Shift+H: tldr quick help
    if (key === 'h' && event.shiftKey && settings.tldrEnabled) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      showQuickHelp();
      return;
    }

    // ⌘⌥ Arrow keys: navigate between panes
    if (event.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const navTab = TabManager.getActiveTab();
      if (navTab && countLeaves(navTab.splitRoot) > 1) {
        const directionMap: Record<string, 'left' | 'right' | 'up' | 'down'> = {
          ArrowLeft: 'left',
          ArrowRight: 'right',
          ArrowUp: 'up',
          ArrowDown: 'down',
        };
        const adjacent = getAdjacentLeaf(navTab.splitRoot, navTab.focusedPaneId, directionMap[event.key]);
        if (adjacent) {
          SplitPaneManager.focusPane(adjacent.id);
        }
      }
      return;
    }
  }, true);
}
