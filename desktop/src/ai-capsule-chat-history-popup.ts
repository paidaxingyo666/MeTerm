// ─── AI Capsule: Chat history popup / side-inline history ──
// Extracted from ai-capsule.ts (which was bumping the 1000-line cap
// after phase 2). Handles opening, closing, rendering and deleting
// the LLM chat history drawer — both the AI Bar popup form and the
// side-panel inline form.
//
// The host interface abstracts everything these functions need from
// the manager without creating a circular import (manager → this →
// manager).

import { t } from './i18n';
import { createOverlayScrollbar } from './overlay-scrollbar';
import type { AICapsuleInstance, ChatConversation } from './ai-capsule-types';

export interface ChatHistoryPopupHost {
  /** Load all saved conversations from disk. */
  loadConversations(): Promise<ChatConversation[]>;
  /** Delete a specific conversation from disk. */
  deleteConversation(id: string): Promise<void>;
  /** Confirm dialog for deletion. Returns true if the user approved. */
  confirmDeleteConversation(): Promise<boolean>;
  /** Close the AI Bar command history popup (mutually exclusive). */
  closeHistory(instance: AICapsuleInstance): void;
  /** Enter / exit the AI Bar search-filter mode. */
  enterSearchMode(instance: AICapsuleInstance, placeholder: string, onInput: () => void): void;
  exitSearchMode(instance: AICapsuleInstance): void;
  /** Restore a saved conversation into the active chat panel. */
  restoreConversation(instance: AICapsuleInstance, conv: ChatConversation): void;
  /** Minimize the bottom-mode chat panel to make room for the popup. */
  minimizeChat(instance: AICapsuleInstance): void;
  /** Manage the resize handle on the popup panel. */
  ensurePopupResizeHandle(panel: HTMLElement, aiBar: HTMLElement): void;
  observePopupResize(panel: HTMLElement, aiBar: HTMLElement): void;
  unobservePopupResize(): void;
  resetPopupManualHeight(): void;
  adjustPopupMaxHeight(panel: HTMLElement, aiBar: HTMLElement): void;
  /** Conversation cache used by the search filter. */
  getCachedConversations(sessionId: string): ChatConversation[] | undefined;
  setCachedConversations(sessionId: string, convs: ChatConversation[]): void;
  deleteCachedConversations(sessionId: string): void;
  /** Render the list from cache (delegates to the persistence module). */
  renderListFromCache(
    instance: AICapsuleInstance,
    convs: ChatConversation[],
    filter?: string,
  ): void;
}

export function toggleChatHistory(
  instance: AICapsuleInstance,
  host: ChatHistoryPopupHost,
  fromSidePanel = false,
): void {
  if (instance.chatHistoryOpen) {
    closeChatHistory(instance, host);
  } else {
    openChatHistory(instance, host, fromSidePanel);
  }
}

export function openChatHistory(
  instance: AICapsuleInstance,
  host: ChatHistoryPopupHost,
  fromSidePanel = false,
): void {
  host.closeHistory(instance);
  // Bottom mode: minimize chat panel so popups don't overlap
  if (!fromSidePanel && instance.layoutMode !== 'side' && instance.chatOpen) {
    host.minimizeChat(instance);
  }
  instance.chatHistoryOpen = true;

  if (fromSidePanel && instance.chatPanel) {
    // Side panel: show chat history inline inside the chat messages area
    const btn = instance.sideInputArea?.querySelector('.ai-side-btn-chat-history') as HTMLButtonElement;
    if (btn) btn.classList.add('active');

    let panel = instance.chatPanel.querySelector('.ai-side-chat-history-view') as HTMLDivElement;
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'ai-side-chat-history-view';
      instance.chatPanel.appendChild(panel);
      createOverlayScrollbar({ viewport: panel, container: panel });
    }
    const msgs = instance.chatPanel.querySelector('.ai-chat-messages') as HTMLElement;
    if (msgs) msgs.style.display = 'none';
    panel.style.display = '';
    instance.chatHistoryPanel = panel;
    void renderChatHistoryList(instance, host);
  } else {
    // AI Bar popup mode (bottom mode, or side mode with chat not open)
    const btn = instance.element.querySelector('.ai-bar-btn-chat-history') as HTMLButtonElement;
    if (btn) btn.classList.add('active');

    let panel = instance.element.querySelector('.ai-bar-chat-history-panel') as HTMLDivElement;
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'ai-bar-chat-history-panel';
      instance.element.appendChild(panel);
    }
    panel.style.display = '';
    host.adjustPopupMaxHeight(panel, instance.element);
    host.observePopupResize(panel, instance.element);
    instance.chatHistoryPanel = panel;
    void renderChatHistoryList(instance, host);
    // 进入搜索模式
    host.enterSearchMode(instance, t('aiSearchChatHistory'), () => {
      const input = instance.element.querySelector('.ai-bar-input') as HTMLInputElement;
      const query = input?.value || '';
      const cached = host.getCachedConversations(instance.sessionId);
      if (cached) {
        host.renderListFromCache(instance, cached, query);
      }
    });
  }
}

export function closeChatHistory(
  instance: AICapsuleInstance,
  host: ChatHistoryPopupHost,
): void {
  if (!instance.chatHistoryOpen) return;
  instance.chatHistoryOpen = false;

  const sideHistView = instance.chatPanel?.querySelector('.ai-side-chat-history-view') as HTMLElement;
  const isSideInline = sideHistView && sideHistView.style.display !== 'none';

  if (isSideInline) {
    const msgs = instance.chatPanel?.querySelector('.ai-chat-messages') as HTMLElement;
    const btn = instance.sideInputArea?.querySelector('.ai-side-btn-chat-history') as HTMLButtonElement;
    sideHistView.style.display = 'none';
    if (msgs) msgs.style.display = '';
    if (btn) btn.classList.remove('active');
  } else {
    const panel = instance.element.querySelector('.ai-bar-chat-history-panel') as HTMLDivElement;
    const btn = instance.element.querySelector('.ai-bar-btn-chat-history') as HTMLButtonElement;
    if (panel) panel.style.display = 'none';
    if (btn) btn.classList.remove('active');
    host.unobservePopupResize();
    host.resetPopupManualHeight();
    host.exitSearchMode(instance);
  }
  instance.chatHistoryPanel = null;
  host.deleteCachedConversations(instance.sessionId);
}

export async function renderChatHistoryList(
  instance: AICapsuleInstance,
  host: ChatHistoryPopupHost,
): Promise<void> {
  const panel = instance.chatHistoryPanel;
  if (!panel) return;

  const isSideInline = panel.classList.contains('ai-side-chat-history-view');
  if (isSideInline) {
    panel.innerHTML = `<div class="ai-chat-hist-header"><span class="ai-chat-hist-title">${t('aiChatHistoryTitle')}</span></div><div class="ai-chat-hist-loading" style="padding:12px;text-align:center;color:var(--text-muted);font-size:12px;">...</div>`;
  } else {
    const { getPopupScrollViewport } = await import('./overlay-scrollbar');
    const vp = getPopupScrollViewport(panel);
    vp.innerHTML = `<div class="ai-chat-hist-header"><span class="ai-chat-hist-title">${t('aiChatHistoryTitle')}</span></div><div class="ai-chat-hist-loading" style="padding:12px;text-align:center;color:var(--text-muted);font-size:12px;">...</div>`;
  }

  const convs = await host.loadConversations();
  host.setCachedConversations(instance.sessionId, convs);
  host.renderListFromCache(instance, convs);
}

export async function handleDeleteConversation(
  instance: AICapsuleInstance,
  convId: string,
  host: ChatHistoryPopupHost,
  isDeleteSkipWindow: () => boolean,
): Promise<void> {
  if (isDeleteSkipWindow()) {
    await host.deleteConversation(convId);
    await reloadChatHistoryWithFilter(instance, host);
    return;
  }
  const confirmed = await host.confirmDeleteConversation();
  if (confirmed) {
    await host.deleteConversation(convId);
    await reloadChatHistoryWithFilter(instance, host);
  }
}

export async function reloadChatHistoryWithFilter(
  instance: AICapsuleInstance,
  host: ChatHistoryPopupHost,
): Promise<void> {
  const convs = await host.loadConversations();
  host.setCachedConversations(instance.sessionId, convs);
  let query = '';
  if (instance.layoutMode !== 'side' && instance.chatHistoryOpen) {
    const input = instance.element.querySelector('.ai-bar-input') as HTMLInputElement;
    query = input?.value || '';
  }
  host.renderListFromCache(instance, convs, query || undefined);
}
