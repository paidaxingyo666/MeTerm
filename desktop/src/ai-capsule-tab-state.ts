// ─── AI Capsule: Tab-scoped agent state registry ─────────────
// Manages the shared TabState objects (one per tab) that back the
// per-pane AICapsuleInstance delegating accessors. Split out of
// ai-capsule.ts to keep that file under the 1000-line cap after
// the per-tab refactor.
//
// Contract: every AICapsuleInstance created by AICapsuleManager
// holds a reference to a TabState looked up here by tabId. All
// fields listed in TAB_STATE_FIELDS are forwarded to this object
// via Object.defineProperties (see wireTabStateDelegation in
// ai-capsule-types.ts).

import { AIAgent } from './ai-agent';
import { TabManager } from './tabs';
import type { TabState } from './ai-capsule-types';
import { getSavedLayoutMode } from './ai-capsule-layout';

/**
 * Resolve the pane number that a send action should lock in as the
 * agent run's target. Reads the CURRENT focused pane of the tab that
 * owns `sessionId`; returns 0 when the session is not in any tab.
 */
export function resolveFocusedPaneNumber(sessionId: string): number {
  const located = TabManager.locateSession(sessionId);
  if (!located) return 0;
  const focusedNum = located.tab.paneNumbers.get(located.tab.focusedPaneId);
  return focusedNum ?? located.paneNumber;
}

/**
 * Resolve the tabId that owns this session. Falls back to an
 * orphan bucket keyed by sessionId so TabState never accidentally
 * crosses between unrelated sessions in the pathological case
 * where a capsule is created before the session is attached to a
 * tab (shouldn't happen in normal flow).
 */
export function resolveTabIdForSession(sessionId: string): string {
  const tab = TabManager.findTabBySessionId(sessionId);
  return tab ? tab.id : `__orphan_${sessionId}`;
}

/**
 * Tab-state registry. All panes of the same tab share one TabState
 * instance stored here. The registry is held by AICapsuleManager as
 * a private field; this module exposes the factory helpers.
 */
export class TabStateRegistry {
  private states = new Map<string, TabState>();

  /** Return true iff a TabState already exists for `tabId`. */
  has(tabId: string): boolean {
    return this.states.has(tabId);
  }

  /** Return the TabState for `tabId`, or null if none exists. */
  get(tabId: string): TabState | null {
    return this.states.get(tabId) ?? null;
  }

  /** Get or lazily create the TabState for a given tabId. */
  getOrCreate(tabId: string): TabState {
    const existing = this.states.get(tabId);
    if (existing) return existing;
    const conversationId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const state: TabState = {
      tabId,
      agent: new AIAgent(),
      messages: [],
      currentConversationId: conversationId,
      agentAbort: null,
      draftText: '',
      activeRunTargetPaneNumber: null,
      pendingClosureNotices: [],
      chatPanel: null,
      chatOpen: false,
      chatMinimized: false,
      isStreaming: false,
      streamBuffer: '',
      streamMsgEl: null,
      reasoningBuffer: '',
      chatHistoryOpen: false,
      chatHistoryPanel: null,
      layoutMode: getSavedLayoutMode(),
      sidePanel: null,
      sideResizeHandle: null,
      sideInputArea: null,
      sideInput: null,
      pendingImages: [],
      pendingAttachments: [],
    };
    this.states.set(tabId, state);
    return state;
  }

  /**
   * Fully tear down a tab's shared state. The caller is expected to
   * have already detached / destroyed all per-pane capsules for this
   * tab; this only disposes the agent run and rips the tab-scoped
   * DOM (chatPanel, sidePanel) out of the document.
   */
  destroy(tabId: string): void {
    const state = this.states.get(tabId);
    if (!state) return;
    state.agentAbort?.();
    state.agent.abort();
    state.sidePanel?.remove();
    state.sideResizeHandle?.remove();
    state.chatPanel?.remove();
    this.states.delete(tabId);
  }

  /**
   * Record a "Pane N was closed" one-shot notice for a tab. FIFO
   * capped at 4; older notices are dropped when the cap is hit.
   * Only surfaces to the agent if the tab actually has an active
   * TabState (otherwise there's nobody to tell).
   */
  recordClosureNotice(tabId: string, paneNumber: number): void {
    const state = this.states.get(tabId);
    if (!state) return;
    state.pendingClosureNotices.push({ paneNumber, at: Date.now() });
    while (state.pendingClosureNotices.length > 4) {
      state.pendingClosureNotices.shift();
    }
  }
}
