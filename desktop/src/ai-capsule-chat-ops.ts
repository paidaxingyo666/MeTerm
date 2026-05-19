// ─── AI Capsule: Chat Panel Operations ──────────────────────
// Create / open / minimize / close the chat panel, plus conversation
// restoration and "send to LLM" logic. Extracted from ai-capsule.ts.

import { t } from './i18n';
import { loadSettings } from './themes';
import { TerminalRegistry } from './terminal';
import { createOverlayScrollbar } from './overlay-scrollbar';
import { renderMarkdown } from './ai-capsule-markdown';
import { resolveActiveModel } from './ai-provider';
import { thinkingIcon } from './ai-icons';
import {
  SVG_LAYOUT_SIDE, SVG_LAYOUT_BOTTOM,
  switchToSideMode, switchToBottomMode,
  hideSidePanel, showSidePanel,
  updateSideSendButton, getSideSendButton,
  type SideInputCallbacks,
} from './ai-capsule-layout';
import type { AICapsuleInstance, ConvEntry, ChatConversation } from './ai-capsule-types';
import { syncBarPlaceholder } from './ai-capsule-bar-dom';
import { buildModelDropdown, updateModelLabel } from './ai-capsule-model-ui';
import { runAgentWithCallbacks } from './ai-agent-runner';
import { clearPendingImages } from './ai-capsule-image-attach';
import { clearPendingAttachments } from './ai-capsule-file-attach';
import { attachLightboxClick } from './ai-image-lightbox';
import { renderEmptyState } from './ai-empty-state';
import { resolveFocusedPaneNumber } from './ai-capsule-tab-state';
import { attachPersistentTodoListener } from './ai-capsule-chat-ui';
import { renderTodoBoard as renderTodoBoardImport, restoreTodoBoardFromHistory } from './ai-capsule-tool-ui';

/** Host interface: methods the extracted functions need from the manager. */
export interface ChatOpsHost {
  capsules: Map<string, AICapsuleInstance>;
  bindChatContextMenu(instance: AICapsuleInstance, container: Element): void;
  buildToolCard(msg: Extract<ConvEntry, { type: 'tool_call' }>): HTMLDivElement;
  bindCommandButtons(instance: AICapsuleInstance, container: Element): void;
  addHistory(instance: AICapsuleInstance, command: string, source: 'manual' | 'ai'): void;
  saveConversation(instance: AICapsuleInstance, snapshot?: { id: string; messages: ConvEntry[] }): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  closeHistory(instance: AICapsuleInstance): void;
  closeChatHistory(instance: AICapsuleInstance): void;
  updateButtonHighlight(instance: AICapsuleInstance): void;
  updateChatTitle(instance: AICapsuleInstance, title?: string): void;
  appendUserMessage(
    instance: AICapsuleInstance,
    text: string,
    images?: Array<{ mediaType: string; data: string; label?: string }>,
  ): void;
  showAgentPulse(instance: AICapsuleInstance): void;
  beginAssistantMessage(instance: AICapsuleInstance): void;
  buildAgentCallbacks(instance: AICapsuleInstance): import('./ai-agent').AgentCallbacks;
  showNoConfigHint(instance: AICapsuleInstance): void;
  createTrustSwitcher(): HTMLDivElement;
  createThinkingToggle(): HTMLDivElement;
  toggleChatHistory(instance: AICapsuleInstance, fromSidePanel?: boolean): void;
  /** Inject a user message into an active agent run (without starting
   *  a new run). Used when the user sends text while agent is streaming. */
  injectUserMessage(instance: AICapsuleInstance, text: string): void;
  /** Return the AICapsuleInstance that currently has user focus.
   *  Used by tab-scoped UI (like the side panel) to route actions
   *  to the currently-focused pane within the tab. */
  getActiveInstance?(): AICapsuleInstance | null;
}

// ─── Create Chat Panel ──────────────────────────────────────

export function createChatPanel(
  instance: AICapsuleInstance,
  host: ChatOpsHost,
): HTMLDivElement {
  const panel = document.createElement('div');
  panel.className = 'ai-chat-panel';
  // Tag with the owning session so cross-cutting code (e.g. the
  // pre-wait card mounter in ai-capsule-tool-ui.ts) can locate the
  // right chat panel via DOM query without taking a circular import
  // on AICapsuleManager.
  panel.dataset.sessionId = instance.sessionId;

  // Resize handle at the top edge
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'ai-chat-resize-handle';
  setupChatResize(panel, resizeHandle);

  // Header
  const header = document.createElement('div');
  header.className = 'ai-chat-header';

  const title = document.createElement('span');
  title.className = 'ai-chat-title';
  title.textContent = t('aiCapsule');

  // Helper: resolve to the currently-focused pane's instance at the
  // moment a header button is clicked. The chat panel is tab-scoped
  // and may have been created by a pane that has since lost focus
  // (or been closed). We still prefer the captured reference if the
  // host can't tell us the current active instance.
  const currentInstance = (): AICapsuleInstance => {
    const active = host.getActiveInstance?.();
    if (active && active.tabId === instance.tabId) return active;
    return instance;
  };

  // New chat button — save current conversation to history, then start fresh
  const newChatBtn = document.createElement('button');
  newChatBtn.className = 'ai-chat-clear';
  newChatBtn.textContent = t('aiNewChat');
  newChatBtn.addEventListener('click', () => {
    const inst = currentInstance();
    if (inst.isStreaming) return;
    // Save current conversation to history if it has messages
    if (inst.messages.length > 0) {
      const snapshot = { id: inst.currentConversationId, messages: [...inst.messages] };
      void host.saveConversation(inst, snapshot);
    }
    // Reset to a fresh conversation
    inst.agent.clear();
    // Unlink any attachment files still lingering (the old conversation
    // is archived — user won't reference those paths again).
    clearPendingAttachments(inst, /* deleteFiles */ true);
    inst.messages = [];
    inst.currentConversationId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    inst.streamMsgEl = null;
    inst.streamBuffer = '';
    inst.reasoningBuffer = '';
    const msgContainer = panel.querySelector('.ai-chat-messages');
    if (msgContainer) msgContainer.innerHTML = '';
    host.updateChatTitle(inst);
    maybeRenderEmptyState(inst, host);
  });

  const clearBtn = document.createElement('button');
  clearBtn.className = 'ai-chat-clear';
  clearBtn.textContent = t('aiClearChat');
  clearBtn.addEventListener('click', () => {
    const inst = currentInstance();
    if (inst.isStreaming) return;
    // Clear without saving — user explicitly discards
    void host.deleteConversation(inst.currentConversationId);
    inst.agent.clear();
    clearPendingAttachments(inst, /* deleteFiles */ true);
    inst.messages = [];
    inst.currentConversationId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const msgContainer = panel.querySelector('.ai-chat-messages');
    if (msgContainer) msgContainer.innerHTML = '';
    host.updateChatTitle(inst);
    maybeRenderEmptyState(inst, host);
  });

  // Layout toggle button
  const layoutBtn = document.createElement('button');
  layoutBtn.className = 'ai-chat-layout-toggle';
  layoutBtn.innerHTML = instance.layoutMode === 'bottom' ? SVG_LAYOUT_SIDE : SVG_LAYOUT_BOTTOM;
  layoutBtn.title = instance.layoutMode === 'bottom' ? t('aiLayoutSide') : t('aiLayoutBottom');
  layoutBtn.addEventListener('click', () => toggleLayout(currentInstance(), layoutBtn, host));

  // Minimize button
  const minimizeBtn = document.createElement('button');
  minimizeBtn.className = 'ai-chat-minimize';
  minimizeBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="8" x2="13" y2="8"/></svg>`;
  minimizeBtn.title = t('aiCollapse');
  minimizeBtn.addEventListener('click', () => minimizeChat(currentInstance(), host));

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'ai-chat-close';
  closeBtn.innerHTML = '&times;';
  closeBtn.addEventListener('click', () => closeChatAndSave(currentInstance(), host));

  header.appendChild(title);
  header.appendChild(newChatBtn);
  header.appendChild(clearBtn);
  header.appendChild(layoutBtn);
  header.appendChild(minimizeBtn);
  header.appendChild(closeBtn);

  // Messages container
  const messages = document.createElement('div');
  messages.className = 'ai-chat-messages';

  panel.style.position = 'relative';
  panel.appendChild(resizeHandle);
  panel.appendChild(header);
  panel.appendChild(messages);
  createOverlayScrollbar({ viewport: messages, container: messages });

  // Bind context menu on the messages container (event delegation)
  host.bindChatContextMenu(instance, messages);

  return panel;
}

function setupChatResize(panel: HTMLDivElement, handle: HTMLDivElement): void {
  let startY = 0;
  let startH = 0;

  const onMouseMove = (e: MouseEvent) => {
    const delta = startY - e.clientY;
    const header = panel.querySelector('.ai-chat-header') as HTMLElement | null;
    const minH = header ? header.offsetHeight + 6 : 36;
    const maxH = window.innerHeight * 0.8;
    const newH = Math.min(maxH, Math.max(minH, startH + delta));
    panel.style.height = `${newH}px`;
    panel.style.flex = 'none';
    TerminalRegistry.resizeAll();
  };

  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.classList.remove('ai-chat-resizing');
  };

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startH = panel.offsetHeight;
    document.body.classList.add('ai-chat-resizing');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// ─── Open / Minimize / Close ────────────────────────────────

export function openChat(instance: AICapsuleInstance, host: ChatOpsHost): void {
  // Ensure the chat panel DOM exists (tab-scoped — one per tab).
  if (!instance.chatPanel) {
    instance.chatPanel = createChatPanel(instance, host);
    // Wire the persistent todo board listener once the chat panel
    // exists, so plan changes from clear() (between turns) refresh
    // the UI even outside an active run.
    attachPersistentTodoListener(instance, renderTodoBoardImport);
  }

  if (instance.layoutMode === 'side') {
    switchToSideMode(instance, getSideInputCallbacks(host));
    instance.chatPanel!.style.display = '';
  } else {
    // Bottom mode: re-anchor the chat panel directly above THIS
    // pane's AI Bar. The chat panel may have been mounted above a
    // different pane's bar the last time it was shown — moving it
    // here is idempotent when we're already in the right spot.
    const terminalPanel = instance.element.parentElement;
    if (terminalPanel) {
      terminalPanel.insertBefore(instance.chatPanel, instance.element);
    }
    instance.chatPanel.style.display = '';
  }

  // Short-circuit the rest of the open bookkeeping when the chat
  // was already marked open — we only needed to re-anchor the DOM.
  if (instance.chatOpen) {
    TerminalRegistry.resizeAll();
    return;
  }

  instance.chatOpen = true;
  instance.chatMinimized = false;
  host.closeHistory(instance);
  host.closeChatHistory(instance);
  host.updateButtonHighlight(instance);
  syncBarPlaceholder(instance);
  // Refit terminal to new available height
  TerminalRegistry.resizeAll();
  // If the conversation is empty, show the context-aware welcome block.
  maybeRenderEmptyState(instance, host);
}

/**
 * Render the empty-state card into the messages container if there
 * are no messages yet. Safe to call on every open / clear — the
 * renderer is idempotent and self-guards against non-empty
 * containers. Clicking a quick-prompt pill sends it directly to
 * the LLM via sendToLLMFrom.
 */
function maybeRenderEmptyState(instance: AICapsuleInstance, host: ChatOpsHost): void {
  if (instance.messages.length > 0) return;
  void renderEmptyState(instance, (text) => {
    sendToLLMFrom(instance, text, host);
  });
}

/** Minimize: hide panel but keep conversation alive */
export function minimizeChat(instance: AICapsuleInstance, host: ChatOpsHost): void {
  if (!instance.chatOpen) return;
  if (instance.chatPanel) {
    instance.chatPanel.style.display = 'none';
  }
  // In side mode, hide side panel and restore AI Bar buttons
  if (instance.layoutMode === 'side') {
    hideSidePanel(instance);
    instance.element.classList.remove('ai-bar--side-active');
  }
  instance.chatOpen = false;
  instance.chatMinimized = true;
  host.updateButtonHighlight(instance);
  syncBarPlaceholder(instance);
  TerminalRegistry.resizeAll();
}

/** Close: save to history then reset conversation */
export function closeChatAndSave(instance: AICapsuleInstance, host: ChatOpsHost): void {
  // Abort streaming if active — prefer the AbortController from the
  // current run(), fall back to agent.abort() for safety.
  if (instance.isStreaming) {
    instance.agentAbort?.();
    instance.agentAbort = null;
    instance.agent.abort();
    instance.isStreaming = false;
    document.dispatchEvent(new CustomEvent('status-bar-ai', { detail: { active: false } }));
    host.updateButtonHighlight(instance);
  }

  // Snapshot messages before clearing, then save asynchronously
  if (instance.messages.length > 0) {
    const snapshot = { id: instance.currentConversationId, messages: [...instance.messages] };
    void host.saveConversation(instance, snapshot);
  }

  // Close any open history panels
  host.closeChatHistory(instance);
  host.closeHistory(instance);

  // Reset conversation immediately
  instance.agent.clear();
  instance.messages = [];
  instance.currentConversationId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (instance.chatPanel) {
    const msgContainer = instance.chatPanel.querySelector('.ai-chat-messages');
    if (msgContainer) msgContainer.innerHTML = '';
    instance.chatPanel.style.display = 'none';
  }
  // In side mode, hide side panel and restore AI Bar buttons
  if (instance.layoutMode === 'side') {
    hideSidePanel(instance);
    instance.element.classList.remove('ai-bar--side-active');
  }
  instance.chatOpen = false;
  instance.chatMinimized = false;
  instance.streamMsgEl = null;
  instance.streamBuffer = '';
  instance.reasoningBuffer = '';
  host.updateChatTitle(instance);
  host.updateButtonHighlight(instance);
  syncBarPlaceholder(instance);
  TerminalRegistry.resizeAll();
}

/** Toggle between bottom and side panel layout */
export function toggleLayout(
  instance: AICapsuleInstance,
  layoutBtn: HTMLButtonElement,
  host: ChatOpsHost,
): void {
  if (instance.layoutMode === 'bottom') {
    switchToSideMode(instance, getSideInputCallbacks(host));
    layoutBtn.innerHTML = SVG_LAYOUT_BOTTOM;
    layoutBtn.title = t('aiLayoutBottom');
  } else {
    switchToBottomMode(instance);
    layoutBtn.innerHTML = SVG_LAYOUT_SIDE;
    layoutBtn.title = t('aiLayoutSide');
  }
  // layoutMode is tab-scoped via the delegating accessors, so
  // changing it on `instance` already propagates to every other
  // capsule in the same tab. No per-instance sync loop needed.
  syncBarPlaceholder(instance);
}

/**
 * Build callbacks for the side panel input area.
 * Exported so ai-capsule.ts can reuse it (mountTo / show need to wire
 * side-mode without constructing a fresh host every time).
 */
export function getSideInputCallbacks(host: ChatOpsHost): SideInputCallbacks {
  return {
    sendToLLM: (instance, text) => sendToLLMFrom(instance, text, host),
    buildModelDropdown: (dropdown, label) => buildModelDropdown(dropdown, label),
    updateModelLabel: (label) => updateModelLabel(label),
    createTrustSwitcher: () => host.createTrustSwitcher(),
    createThinkingToggle: () => host.createThinkingToggle(),
    toggleSideChatHistory: (instance) => host.toggleChatHistory(instance, true),
    toggleLayout: (instance) => {
      const layoutBtn = instance.chatPanel?.querySelector('.ai-chat-layout-toggle') as HTMLButtonElement;
      if (layoutBtn) toggleLayout(instance, layoutBtn, host);
    },
    // Side panel is tab-scoped and outlives individual panes within
    // the tab. When its buttons fire, route the action to whichever
    // pane currently has user focus (tracked by the manager's
    // _lastShownSessionId), and only fall back to the captured
    // reference if for some reason that resolution misses.
    resolveCurrentInstance: (fallback) => {
      const current = host.getActiveInstance?.();
      if (current && current.tabId === fallback.tabId) return current;
      return fallback;
    },
  };
}

/** Send text to LLM from any input source (AI Bar or side panel textarea) */
export function sendToLLMFrom(
  instance: AICapsuleInstance,
  text: string,
  host: ChatOpsHost,
): void {
  // Guard: if the agent is already streaming, inject the message into
  // the running conversation instead of starting a new run. This
  // prevents the race condition where a quick-prompt click or side-panel
  // Enter fires a second concurrent runLoop — the old loop gets an
  // implicit abort via agent.send() and the UI sees duplicated replies.
  if (instance.isStreaming) {
    if (text) {
      host.injectUserMessage(instance, text);
    }
    return;
  }

  // Snapshot pending images before we clear them — they'll be attached
  // to this user turn.  Allow empty text if at least one image or file
  // attachment is queued.
  const attached = instance.pendingImages.slice();
  const attachedFiles = instance.pendingAttachments.slice();
  if (!text && attached.length === 0 && attachedFiles.length === 0) return;

  const settings = loadSettings();
  const resolved = resolveActiveModel(settings.aiProviders, settings.aiActiveModel);
  if (!resolved) {
    openChat(instance, host);
    host.showNoConfigHint(instance);
    return;
  }

  // Lock the target pane for this run: whichever pane has current
  // focus at Send time is the one the agent commands operate on
  // for the entire run, even if the user switches focus mid-stream.
  const lockedPaneNumber = resolveFocusedPaneNumber(instance.sessionId);
  instance.state.activeRunTargetPaneNumber = lockedPaneNumber || null;

  openChat(instance, host);
  host.appendUserMessage(instance, text, attached.length > 0 ? attached : undefined);
  instance.messages.push({
    type: 'user',
    content: text,
    images: attached.length > 0 ? attached : undefined,
    timestamp: Date.now(),
    paneNumber: lockedPaneNumber || undefined,
  });
  clearPendingImages(instance);
  // Clear the strip UI but keep the on-disk files — the agent is
  // about to consume their paths via its system prompt. Files are
  // removed only when the conversation is cleared.
  clearPendingAttachments(instance, /* deleteFiles */ false);
  // Push the snapshot into the agent so the runLoop's system prompt
  // injects the attachment list on every iteration of THIS turn.
  instance.agent.setPendingAttachments(attachedFiles);
  host.updateChatTitle(instance);
  void host.saveConversation(instance);

  instance.isStreaming = true;
  instance.streamBuffer = '';
  document.dispatchEvent(new CustomEvent('status-bar-ai', { detail: { active: true } }));
  host.updateButtonHighlight(instance);
  // Update side panel send button to stop icon
  updateSideSendButton(getSideSendButton(instance), true);
  host.beginAssistantMessage(instance);
  host.showAgentPulse(instance);

  const agentCallbacks = host.buildAgentCallbacks(instance);
  // Dispatch via run() generator so Ctrl+C / Escape can cancel via
  // a single AbortController.  The abort handle is stashed on the
  // instance so all cancellation sites route through the same path.
  const handle = runAgentWithCallbacks(
    instance.agent, text, instance.sessionId, agentCallbacks,
    attached.length > 0 ? attached : undefined,
  );
  instance.agentAbort = handle.abort;
  void handle.done.finally(() => {
    if (instance.agentAbort === handle.abort) {
      instance.agentAbort = null;
    }
    instance.state.activeRunTargetPaneNumber = null;
  });
}

// ─── Restore Conversation ───────────────────────────────────

/** Restore a saved conversation into the main chat panel */
export function restoreConversation(
  instance: AICapsuleInstance,
  conv: ChatConversation,
  host: ChatOpsHost,
): void {
  // Save current conversation if it has messages
  if (instance.messages.length > 0) {
    const snapshot = { id: instance.currentConversationId, messages: [...instance.messages] };
    void host.saveConversation(instance, snapshot);
  }

  // Close chat history panel
  host.closeChatHistory(instance);

  // Reset agent context — abort any in-flight run first.
  instance.agentAbort?.();
  instance.agentAbort = null;
  instance.agent.clear();

  // Restore conversation state
  instance.currentConversationId = conv.id;
  instance.messages = conv.messages.map(m => ({ ...m }));
  instance.reasoningBuffer = '';

  // Ensure chat panel exists and is in the correct layout
  if (!instance.chatPanel) {
    instance.chatPanel = createChatPanel(instance, host);
    attachPersistentTodoListener(instance, renderTodoBoardImport);
  }
  if (instance.layoutMode === 'side') {
    switchToSideMode(instance, getSideInputCallbacks(host));
  } else {
    const terminalPanel = instance.element.parentElement;
    if (terminalPanel && instance.chatPanel.parentElement !== terminalPanel) {
      terminalPanel.insertBefore(instance.chatPanel, instance.element);
    }
  }

  // Clear and rebuild message UI
  const msgContainer = instance.chatPanel.querySelector('.ai-chat-messages');
  if (msgContainer) {
    msgContainer.innerHTML = '';
    const addHistory = (cmd: string) => host.addHistory(instance, cmd, 'ai');

    for (const msg of instance.messages) {
      if (msg.type === 'user') {
        const el = document.createElement('div');
        el.className = 'ai-msg ai-msg-user';
        // Phase 2 pane badge, if this restored message was tagged.
        if (msg.paneNumber && msg.paneNumber > 0) {
          const badge = document.createElement('span');
          badge.className = 'ai-msg-pane-badge';
          badge.textContent = `Pane ${msg.paneNumber}`;
          badge.title = `Sent from Pane ${msg.paneNumber}`;
          el.appendChild(badge);
        }
        const c = document.createElement('div');
        c.className = 'ai-msg-content';
        c.textContent = msg.content;
        el.appendChild(c);
        // Re-render any attached images (multimodal user messages).
        if (msg.images && msg.images.length > 0) {
          const row = document.createElement('div');
          row.className = 'ai-user-images';
          for (const img of msg.images) {
            const thumb = document.createElement('div');
            thumb.className = 'ai-user-image-thumb';
            if (img.label) thumb.title = img.label;
            const imgEl = document.createElement('img');
            imgEl.className = 'ai-user-image';
            imgEl.src = `data:${img.mediaType};base64,${img.data}`;
            if (img.label) imgEl.alt = img.label;
            imgEl.loading = 'lazy';
            imgEl.decoding = 'async';
            attachLightboxClick(imgEl);
            thumb.appendChild(imgEl);
            row.appendChild(thumb);
          }
          el.appendChild(row);
        }
        msgContainer.appendChild(el);

      } else if (msg.type === 'thinking') {
        // Reasoning block — standalone, no bubble.
        // Strip stray think/tool-XML fragments that may have been persisted
        // before sanitization was added.
        const cleanedReasoning = msg.reasoning
          ? msg.reasoning
              .replace(/<\/?think(?:ing)?>/gi, '')
              .replace(/<\/(?:arg_value|tool_call|args|tool_use)>/gi, '')
          : '';
        if (cleanedReasoning) {
          const block = document.createElement('div');
          block.className = 'ai-thinking-block';
          const details = document.createElement('details');
          details.className = 'ai-reasoning';
          const summary = document.createElement('summary');
          summary.innerHTML = `${thinkingIcon(12)} <span>${t('aiThinking')}</span>`;
          const textEl = document.createElement('div');
          textEl.className = 'ai-reasoning-text';
          textEl.textContent = cleanedReasoning;
          details.appendChild(summary);
          details.appendChild(textEl);
          block.appendChild(details);
          msgContainer.appendChild(block);
        }
        // Assistant text — render as regular bubble
        if (msg.content) {
          const el = document.createElement('div');
          el.className = 'ai-msg ai-msg-assistant';
          const c = document.createElement('div');
          c.className = 'ai-msg-content';
          c.innerHTML = renderMarkdown(msg.content, instance.sessionId, addHistory);
          el.appendChild(c);
          msgContainer.appendChild(el);
        }

      } else if (msg.type === 'tool_call') {
        msgContainer.appendChild(host.buildToolCard(msg));

      } else if (msg.type === 'assistant') {
        const el = document.createElement('div');
        el.className = 'ai-msg ai-msg-assistant';
        const c = document.createElement('div');
        c.className = 'ai-msg-content';
        c.innerHTML = renderMarkdown(msg.content, instance.sessionId, addHistory);
        el.appendChild(c);
        msgContainer.appendChild(el);

      } else if (msg.type === 'system') {
        const notice = document.createElement('div');
        notice.className = 'ai-system-notice';
        notice.textContent = msg.content;
        msgContainer.appendChild(notice);
      }
    }

    // Restore the persistent TodoBoard from the last `todo_write` in
    // the conversation, if any. The individual tool_call entries for
    // todo_write render as hidden placeholders (buildToolCard above),
    // so the board is the canonical view of the plan — we need to
    // rehydrate it after a reload.
    restoreTodoBoardFromHistory(instance);

    host.bindCommandButtons(instance, msgContainer);
    msgContainer.scrollTop = msgContainer.scrollHeight;
  }

  // Show chat panel
  instance.chatPanel.style.display = '';
  if (instance.layoutMode === 'side') showSidePanel(instance);
  instance.chatOpen = true;
  instance.chatMinimized = false;
  instance.isStreaming = false;
  instance.streamMsgEl = null;
  instance.streamBuffer = '';
  host.updateChatTitle(instance, conv.title);
  host.updateButtonHighlight(instance);
  TerminalRegistry.resizeAll();
}
