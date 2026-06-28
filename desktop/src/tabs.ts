import { invoke } from '@tauri-apps/api/core';
import { TerminalRegistry, type SessionStatus } from './terminal';
import { t } from './i18n';
import { createSSHSession, type SSHConnectionConfig } from './ssh';
import {
  type SplitNode,
  type SplitDirection,
  type LeafNode,
  generatePaneId,
  countLeaves,
  splitLeaf,
  removeLeaf,
  getAllLeaves,
  getFirstLeaf,
  findLeafById,
  updateRatio,
  movePaneAdjacent,
  swapLeafSessions,
} from './split-pane';

type SessionCreateResponse = {
  id: string;
  created_at: string;
  state: string;
};

export interface Tab {
  id: string;                // unique tab ID (no longer equals sessionId)
  splitRoot: SplitNode;      // split tree root
  focusedPaneId: string;     // focused pane ID
  title: string;             // derived from focused pane's session
  status: SessionStatus;     // derived from focused pane's session
  /**
   * Monotonic counter used to allocate per-tab pane numbers.
   * The FIRST pane of a new tab is always #1; each subsequent split
   * consumes the next integer. Closed panes do NOT recycle their
   * number — if pane #2 closes, a later split mints #5, not #2.
   * The counter resets only when the whole tab closes.
   */
  paneCounterNext: number;
  /**
   * Map from paneId → human-facing pane number. Updated on split and
   * on close. The UI and the agent read pane numbers from this map
   * (not from the paneId string), so numbers survive pane creation
   * order changes in the binary tree.
   */
  paneNumbers: Map<string, number>;
}

let tabIdCounter = 0;

function generateTabId(): string {
  tabIdCounter += 1;
  return `tab-${Date.now().toString(36)}-${tabIdCounter}`;
}

class TabManagerClass {
  tabs: Tab[] = [];
  activeTabId: string | null = null;
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    this.listeners.forEach((listener) => listener());
  }

  private updateStatus(tabId: string, sessionId: string, status: SessionStatus): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    // Only update tab-level status if this is the focused session
    const focusedLeaf = findLeafById(tab.splitRoot, tab.focusedPaneId);
    if (focusedLeaf && focusedLeaf.sessionId === sessionId) {
      tab.status = status;
      this.notify();
    }
  }

  private updateTitle(tabId: string, sessionId: string, title: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const focusedLeaf = findLeafById(tab.splitRoot, tab.focusedPaneId);
    if (focusedLeaf && focusedLeaf.sessionId === sessionId) {
      tab.title = title || tab.title;
      this.notify();
    }
  }

  async addTab(port: number, token: string, shell?: string, cwd?: string): Promise<void> {
    const raw = await invoke<string>('create_session', { shell: shell || null, cwd: cwd || null });
    let parsed: SessionCreateResponse;
    try {
      parsed = JSON.parse(raw) as SessionCreateResponse;
    } catch {
      throw new Error(`Failed to parse session response: ${raw}`);
    }
    const sessionId = parsed.id;
    const paneId = generatePaneId();
    const tabId = generateTabId();

    // Use shell name as initial tab title when a specific shell is provided
    const shellName = shell ? shell.split('/').pop() || shell : '';
    const initialTitle = shellName || `${t('responseSession')} ${this.tabs.length + 1}`;

    const tab: Tab = {
      id: tabId,
      splitRoot: { type: 'leaf', id: paneId, sessionId },
      focusedPaneId: paneId,
      title: initialTitle,
      status: 'connecting',
      paneCounterNext: 2,
      paneNumbers: new Map([[paneId, 1]]),
    };

    this.tabs.push(tab);
    this.activeTabId = tabId;

    TerminalRegistry.create(
      sessionId,
      port,
      token,
      (status) => {
        this.updateStatus(tabId, sessionId, status);
      },
      (title) => {
        this.updateTitle(tabId, sessionId, title);
      },
    );

    this.notify();
  }

  activate(tabId: string): void {
    this.activeTabId = tabId;
    this.notify();
  }

  insertTab(tab: Tab, index?: number): void {
    if (index !== undefined && index >= 0 && index <= this.tabs.length) {
      this.tabs.splice(index, 0, tab);
    } else {
      this.tabs.push(tab);
    }
    this.activeTabId = tab.id;
    this.notify();
  }

  removeTabWithoutDestroy(tabId: string): Tab | null {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return null;
    this.tabs = this.tabs.filter((t) => t.id !== tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabs.length > 0 ? this.tabs[this.tabs.length - 1].id : null;
    }
    this.notify();
    return tab;
  }

  reorderTab(fromIndex: number, toIndex: number): void {
    if (fromIndex < 0 || fromIndex >= this.tabs.length) return;
    if (toIndex < 0 || toIndex >= this.tabs.length) return;
    if (fromIndex === toIndex) return;
    const [tab] = this.tabs.splice(fromIndex, 1);
    this.tabs.splice(toIndex, 0, tab);
    this.notify();
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // Destroy all sessions in the split tree
    const leaves = getAllLeaves(tab.splitRoot);
    for (const leaf of leaves) {
      TerminalRegistry.destroy(leaf.sessionId);
      invoke('delete_session', { sessionId: leaf.sessionId }).catch(() => {});
    }

    this.tabs = this.tabs.filter((t) => t.id !== tabId);

    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabs.length > 0 ? this.tabs[this.tabs.length - 1].id : null;
    }

    this.notify();
  }

  /**
   * Get the focused session ID for the active tab.
   */
  getActiveSessionId(): string | null {
    if (!this.activeTabId) return null;
    const tab = this.tabs.find((t) => t.id === this.activeTabId);
    if (!tab) return null;
    const leaf = findLeafById(tab.splitRoot, tab.focusedPaneId);
    return leaf?.sessionId || null;
  }

  /**
   * Get the active tab object.
   */
  getActiveTab(): Tab | null {
    if (!this.activeTabId) return null;
    return this.tabs.find((t) => t.id === this.activeTabId) || null;
  }

  /**
   * Split a pane in the active tab. Returns the new pane ID, or null if split failed.
   */
  async splitPane(
    tabId: string,
    paneId: string,
    direction: SplitDirection,
    port: number,
    authToken: string,
    sshConfig?: SSHConnectionConfig,
    shell?: string,
  ): Promise<{ paneId: string; sessionId: string } | null> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return null;

    // Create new session — SSH or local
    let newSessionId: string;
    if (sshConfig) {
      newSessionId = await createSSHSession(sshConfig);
    } else {
      const raw = await invoke<string>('create_session', { shell: shell || null });
      const parsed = JSON.parse(raw) as SessionCreateResponse;
      newSessionId = parsed.id;
    }

    // Split the tree
    const newRoot = splitLeaf(tab.splitRoot, paneId, direction, newSessionId);
    tab.splitRoot = newRoot;

    // Find the new leaf (it will be the second child of the new branch)
    const allLeaves = getAllLeaves(newRoot);
    const newLeaf = allLeaves.find((l) => l.sessionId === newSessionId);
    if (!newLeaf) return null;

    // Allocate a fresh pane number for the newly-split pane.
    // Numbers are monotonic per-tab and never recycled.
    tab.paneNumbers.set(newLeaf.id, tab.paneCounterNext);
    tab.paneCounterNext += 1;

    // Create terminal for new session
    TerminalRegistry.create(
      newSessionId,
      port,
      authToken,
      (status) => {
        this.updateStatus(tabId, newSessionId, status);
      },
      (title) => {
        this.updateTitle(tabId, newSessionId, title);
      },
    );

    this.notify();
    return { paneId: newLeaf.id, sessionId: newSessionId };
  }

  /**
   * Close a single pane. If it's the last pane, closes the tab.
   */
  async closePane(tabId: string, paneId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;

    const leaf = findLeafById(tab.splitRoot, paneId);
    if (!leaf) return;

    // Remember the number before we delete it — the agent needs to
    // be told "Pane N was closed" exactly once on the next iteration.
    const closedNumber = tab.paneNumbers.get(paneId);

    // Destroy the session
    TerminalRegistry.destroy(leaf.sessionId);
    invoke('delete_session', { sessionId: leaf.sessionId }).catch(() => {});

    // Remove from tree
    const newRoot = removeLeaf(tab.splitRoot, paneId);
    if (!newRoot) {
      // Last pane — close the tab
      tab.paneNumbers.delete(paneId);
      this.tabs = this.tabs.filter((t) => t.id !== tabId);
      if (this.activeTabId === tabId) {
        this.activeTabId = this.tabs.length > 0 ? this.tabs[this.tabs.length - 1].id : null;
      }
      this.notify();
      return;
    }

    tab.splitRoot = newRoot;
    tab.paneNumbers.delete(paneId);

    // Notify any tab-scoped agent listeners so they can surface a
    // one-shot "Pane N closed" system notice on the next iteration.
    if (closedNumber !== undefined) {
      document.dispatchEvent(new CustomEvent('meterm-pane-closed', {
        detail: { tabId, paneNumber: closedNumber },
      }));
    }

    // Update focused pane if the closed one was focused
    if (tab.focusedPaneId === paneId) {
      const firstLeaf = getFirstLeaf(newRoot);
      tab.focusedPaneId = firstLeaf.id;
      // Update title/status from new focused pane
      const mt = TerminalRegistry.get(firstLeaf.sessionId);
      if (mt) {
        tab.title = mt.shellTitle || mt.title;
        tab.status = mt.ended ? 'ended' : mt.ws ? 'connected' : 'disconnected';
      }
    }

    this.notify();
  }

  /**
   * Extract a pane out of its tab into a brand-new standalone tab, keeping the
   * session alive. No-op when the tab has only one pane. Returns the new tab id.
   */
  extractPaneToNewTab(tabId: string, paneId: string): string | null {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return null;
    const leaf = findLeafById(tab.splitRoot, paneId);
    if (!leaf) return null;
    if (countLeaves(tab.splitRoot) <= 1) return null; // already standalone

    const sessionId = leaf.sessionId;

    // Detach from the source tab (do NOT destroy the session).
    const newRoot = removeLeaf(tab.splitRoot, paneId);
    if (!newRoot) return null;
    tab.splitRoot = newRoot;
    tab.paneNumbers.delete(paneId);
    if (tab.focusedPaneId === paneId) {
      const fl = getFirstLeaf(newRoot);
      tab.focusedPaneId = fl.id;
      const mt = TerminalRegistry.get(fl.sessionId);
      if (mt) {
        tab.title = mt.shellTitle || mt.title;
        tab.status = mt.ended ? 'ended' : (mt.ws || mt.transport?.connected) ? 'connected' : 'disconnected';
      }
    }

    // Build the standalone tab carrying the extracted session.
    const newPaneId = generatePaneId();
    const newTabId = generateTabId();
    const mt = TerminalRegistry.get(sessionId);
    const newTab: Tab = {
      id: newTabId,
      splitRoot: { type: 'leaf', id: newPaneId, sessionId },
      focusedPaneId: newPaneId,
      title: mt?.shellTitle || mt?.title || 'Terminal',
      status: mt?.ended ? 'ended' : (mt?.ws || mt?.transport?.connected) ? 'connected' : 'disconnected',
      paneCounterNext: 2,
      paneNumbers: new Map([[newPaneId, 1]]),
    };

    const srcIdx = this.tabs.findIndex((t) => t.id === tabId);
    this.tabs.splice(srcIdx >= 0 ? srcIdx + 1 : this.tabs.length, 0, newTab);
    this.activeTabId = newTabId;
    this.notify();
    return newTabId;
  }

  /** Move a pane next to a target (drag-to-rearrange / insert-reorder). */
  movePane(tabId: string, sourcePaneId: string, targetPaneId: string, direction: SplitDirection, before: boolean): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab || sourcePaneId === targetPaneId) return;
    tab.splitRoot = movePaneAdjacent(tab.splitRoot, sourcePaneId, targetPaneId, direction, before);
    this.notify();
  }

  /** Swap two panes' sessions (drop on a pane's CENTER → replace). */
  swapPanes(tabId: string, paneA: string, paneB: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab || paneA === paneB) return;
    tab.splitRoot = swapLeafSessions(tab.splitRoot, paneA, paneB);
    this.notify();
  }

  /**
   * Update the split ratio for a branch node.
   */
  updateSplitRatio(tabId: string, branchId: string, ratio: number): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    tab.splitRoot = updateRatio(tab.splitRoot, branchId, ratio);
    // No need to notify — DOM is already updated during drag
  }

  /**
   * Find tab by session ID (searches all leaves).
   */
  findTabBySessionId(sessionId: string): Tab | null {
    for (const tab of this.tabs) {
      const leaves = getAllLeaves(tab.splitRoot);
      if (leaves.some((l) => l.sessionId === sessionId)) {
        return tab;
      }
    }
    return null;
  }

  /**
   * Return the (tab, paneId, paneNumber) triple for a sessionId, or
   * null when the session is not in any tab's split tree.
   */
  locateSession(sessionId: string): { tab: Tab; paneId: string; paneNumber: number } | null {
    for (const tab of this.tabs) {
      const leaves = getAllLeaves(tab.splitRoot);
      const leaf = leaves.find((l) => l.sessionId === sessionId);
      if (leaf) {
        const n = tab.paneNumbers.get(leaf.id) ?? 0;
        return { tab, paneId: leaf.id, paneNumber: n };
      }
    }
    return null;
  }

  /**
   * Resolve a pane number to its sessionId within a given tab.
   * Returns null when the number doesn't exist in that tab.
   */
  resolvePaneNumber(tabId: string, paneNumber: number): { paneId: string; sessionId: string } | null {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return null;
    for (const [paneId, num] of tab.paneNumbers.entries()) {
      if (num === paneNumber) {
        const leaf = findLeafById(tab.splitRoot, paneId);
        if (leaf) return { paneId, sessionId: leaf.sessionId };
      }
    }
    return null;
  }
}

export const TabManager = new TabManagerClass();
