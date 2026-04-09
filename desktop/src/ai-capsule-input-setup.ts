// ─── AI Capsule: Input Event Handling ───────────────────────
// Sets up the keyboard/button event handlers on the AI Bar input.
// Handles prompt vs command detection, streaming, aborting,
// history/chat-history search mode, etc.

import { t } from './i18n';
import { loadSettings, saveSettings } from './themes';
import { TerminalRegistry } from './terminal';
import { resolveActiveModel } from './ai-provider';
import type { AICapsuleInstance } from './ai-capsule-types';
import { fuzzyMatch } from './ai-capsule-history';
import { runAgentWithCallbacks } from './ai-agent-runner';
import { clearPendingImages } from './ai-capsule-image-attach';
import { clearPendingAttachments } from './ai-capsule-file-attach';
import { resolveFocusedPaneNumber } from './ai-capsule-tab-state';

export interface InputSetupHost {
  // Prompt detection
  looksLikePrompt(text: string): boolean;
  // Streaming state hooks
  injectUserMessage(instance: AICapsuleInstance, text: string): void;
  collapseActiveThinking(instance: AICapsuleInstance): void;
  finalizeMessage(instance: AICapsuleInstance, text: string): void;
  // Chat panel control
  openChat(instance: AICapsuleInstance): void;
  minimizeChat(instance: AICapsuleInstance): void;
  closeHistory(instance: AICapsuleInstance): void;
  closeChatHistory(instance: AICapsuleInstance): void;
  // UI feedback
  showNoConfigHint(instance: AICapsuleInstance): void;
  appendUserMessage(
    instance: AICapsuleInstance,
    text: string,
    images?: Array<{ mediaType: string; data: string; label?: string }>,
  ): void;
  beginAssistantMessage(instance: AICapsuleInstance): void;
  showAgentPulse(instance: AICapsuleInstance): void;
  hideAgentPulse(instance: AICapsuleInstance): void;
  updateButtonHighlight(instance: AICapsuleInstance): void;
  updateChatTitle(instance: AICapsuleInstance, title?: string): void;
  saveConversation(instance: AICapsuleInstance): Promise<void>;
  syncBarPlaceholder(instance: AICapsuleInstance): void;
  buildAgentCallbacks(instance: AICapsuleInstance): import('./ai-agent').AgentCallbacks;
  addHistory(instance: AICapsuleInstance, command: string, source: 'manual' | 'ai'): void;
  // Search-mode state refs
  savedInputValue: Map<string, string>;
}

export function setupInput(instance: AICapsuleInstance, host: InputSetupHost): void {
  const input = instance.element.querySelector('.ai-bar-input') as HTMLInputElement;
  const termBtn = instance.element.querySelector('.ai-bar-btn-term') as HTMLButtonElement;
  const llmBtn = instance.element.querySelector('.ai-bar-btn-llm') as HTMLButtonElement;

  // ── Prompt detection inline hint state ──
  let pendingPromptConfirm = false;

  const showPromptHint = (bar: HTMLElement) => {
    let hint = bar.querySelector('.ai-prompt-hint') as HTMLElement;
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'ai-prompt-hint';
      hint.innerHTML = `<span class="ai-prompt-hint-text">${t('aiSendToAgentConfirm')}</span>`
        + `<span class="ai-prompt-hint-keys">Enter → Agent &nbsp;/&nbsp; Esc → ${t('aiSendToAgentNo')}</span>`
        + `<label class="ai-prompt-hint-check"><input type="checkbox"><span>${t('aiSendToAgentDontAsk')}</span></label>`;
      bar.appendChild(hint);
    }
    hint.style.display = '';
    bar.classList.add('ai-bar--prompt-pending');
  };

  const dismissPromptHint = () => {
    const hint = instance.element.querySelector('.ai-prompt-hint') as HTMLElement;
    if (hint) hint.style.display = 'none';
    instance.element.classList.remove('ai-bar--prompt-pending');
  };

  // Initial draft text from tab-scoped shared state. When the user
  // switched from a different pane of the same tab, this restores
  // whatever they were typing there.
  if (instance.state.draftText && !input.value) {
    input.value = instance.state.draftText;
  }

  // Dismiss hint when input changes + sync draft back to tab state
  // so other panes in the same tab show the same text when focused.
  input.addEventListener('input', () => {
    if (pendingPromptConfirm) {
      pendingPromptConfirm = false;
      dismissPromptHint();
    }
    instance.state.draftText = input.value;
  });

  const sendToTerminal = () => {
    const text = input.value.trim();
    if (!text) return;
    pendingPromptConfirm = false;
    dismissPromptHint();
    TerminalRegistry.sendCommand(instance.sessionId, text);
    host.addHistory(instance, text, 'manual');
    input.value = '';
    instance.state.draftText = '';
  };

  const sendToLLM = () => {
    const text = input.value.trim();
    // Snapshot pending images + file attachments before we clear them —
    // they ride this turn.
    const attached = instance.pendingImages.slice();
    const attachedFiles = instance.pendingAttachments.slice();
    if (!text && attached.length === 0 && attachedFiles.length === 0) return;

    // Check if AI is configured
    const settings = loadSettings();
    const resolved = resolveActiveModel(settings.aiProviders, settings.aiActiveModel);
    if (!resolved) {
      host.openChat(instance);
      host.showNoConfigHint(instance);
      return;
    }

    // Lock the target pane for this run: whichever pane the user
    // currently has focused is the one the agent will operate on
    // for the whole run, even if the user switches focus mid-stream.
    // Reset in the finally() handler below.
    const lockedPaneNumber = resolveFocusedPaneNumber(instance.sessionId);
    instance.state.activeRunTargetPaneNumber = lockedPaneNumber || null;

    // Open chat panel and send
    host.openChat(instance);
    host.appendUserMessage(instance, text, attached.length > 0 ? attached : undefined);
    instance.messages.push({
      type: 'user',
      content: text,
      images: attached.length > 0 ? attached : undefined,
      timestamp: Date.now(),
      paneNumber: lockedPaneNumber || undefined,
    });
    clearPendingImages(instance);
    clearPendingAttachments(instance, /* deleteFiles */ false);
    instance.agent.setPendingAttachments(attachedFiles);
    host.updateChatTitle(instance);
    void host.saveConversation(instance);
    input.value = '';
    instance.state.draftText = '';

    // Start streaming
    instance.isStreaming = true;
    instance.streamBuffer = '';
    document.dispatchEvent(new CustomEvent('status-bar-ai', { detail: { active: true } }));
    host.updateButtonHighlight(instance);
    host.beginAssistantMessage(instance);
    host.showAgentPulse(instance);

    const agentCallbacks = host.buildAgentCallbacks(instance);
    const handle = runAgentWithCallbacks(
      instance.agent, text, instance.sessionId, agentCallbacks,
      attached.length > 0 ? attached : undefined,
    );
    instance.agentAbort = handle.abort;
    void handle.done.finally(() => {
      if (instance.agentAbort === handle.abort) {
        instance.agentAbort = null;
      }
      // Release the target-pane lock once the run is done. The next
      // send snapshots a fresh lock from the user's current focus.
      instance.state.activeRunTargetPaneNumber = null;
    });
  };

  // ── IME composition tracking ──
  // WKWebView (and some other engines) is inconsistent about the
  // Enter that CONFIRMS an IME candidate:
  //   • Sometimes keyCode === 229 + isComposing === true  → easy to detect
  //   • Sometimes keyCode === 13  + isComposing === true  → also detectable
  //   • Sometimes compositionend fires JUST BEFORE the keydown(13),
  //     so isComposing is already false but the user's intent is
  //     still "pick this candidate, don't submit".
  //
  // We track composition state ourselves and add a small grace
  // window after compositionend so the trailing Enter never leaks
  // through as a "send" action.
  let imeActive = false;
  let imeJustEndedAt = 0;
  const IME_GRACE_MS = 80;

  input.addEventListener('compositionstart', () => {
    imeActive = true;
  });
  // Some browsers fire compositionupdate without compositionstart
  // when switching IMEs mid-stream.
  input.addEventListener('compositionupdate', () => {
    imeActive = true;
  });
  input.addEventListener('compositionend', () => {
    imeActive = false;
    imeJustEndedAt = Date.now();
  });

  /** True if a keydown should be ignored because IME owns this Enter. */
  const isImeKeydown = (e: KeyboardEvent): boolean => {
    if (imeActive) return true;
    if (e.isComposing) return true;
    if (e.keyCode === 229) return true;
    // Trailing-Enter grace period after compositionend.
    if (e.key === 'Enter' && (Date.now() - imeJustEndedAt) < IME_GRACE_MS) return true;
    return false;
  };

  termBtn.addEventListener('click', sendToTerminal);
  llmBtn.addEventListener('click', () => {
    if (instance.isStreaming) {
      const text = input.value.trim();
      if (text) {
        host.injectUserMessage(instance, text);
        input.value = '';
        instance.state.draftText = '';
      } else {
        instance.agentAbort?.();
        instance.agent.abort();
        host.collapseActiveThinking(instance);
        instance.reasoningBuffer = '';
        if (instance.streamMsgEl && instance.streamBuffer) {
          host.finalizeMessage(instance, instance.streamBuffer);
        } else {
          instance.isStreaming = false;
          instance.streamMsgEl = null;
          instance.streamBuffer = '';
          host.updateButtonHighlight(instance);
          host.hideAgentPulse(instance);
          document.dispatchEvent(new CustomEvent('status-bar-ai', { detail: { active: false } }));
        }
      }
    } else if (instance.chatOpen) {
      // Chat is open: if text → send, if empty → minimize (toggle close)
      const text = input.value.trim();
      if (text) {
        sendToLLM();
      } else {
        host.minimizeChat(instance);
      }
    } else if (instance.chatMinimized) {
      // Restore minimized chat, send if there's text
      host.openChat(instance);
      const text = input.value.trim();
      if (text) sendToLLM();
    } else {
      // Chat not open: if text → send (opens chat), if empty → just open chat
      const text = input.value.trim();
      if (text) {
        sendToLLM();
      } else {
        host.openChat(instance);
      }
    }
  });

  input.addEventListener('keydown', (e) => {
    // IME guard: when the input method editor owns this keydown,
    // pressing Enter is "pick the candidate", NOT "submit". Let the
    // browser deliver the candidate to the input box and bail out.
    // The trailing-Enter grace period (above) catches the case where
    // compositionend fires fractionally before the keydown.
    if (isImeKeydown(e)) return;

    // 弹窗搜索模式下拦截 Enter/Escape
    if (instance.historyOpen || instance.chatHistoryOpen) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (instance.historyOpen) {
          // 选中筛选后的第一条
          const query = input.value.trim();
          const match = query
            ? instance.history.find(h => fuzzyMatch(h.command, query))
            : instance.history[0];
          if (match) {
            host.savedInputValue.set(instance.sessionId, match.command);
          }
          host.closeHistory(instance);
        } else if (instance.chatHistoryOpen) {
          host.closeChatHistory(instance);
        }
        input.focus();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (instance.historyOpen) host.closeHistory(instance);
        if (instance.chatHistoryOpen) host.closeChatHistory(instance);
        input.focus();
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      return;
    }

    if (e.key === 'Enter') {
      if (instance.layoutMode === 'side') {
        // Side mode: AI Bar input always sends to terminal
        // Ctrl+Enter focuses side panel input instead
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (instance.sideInput) {
            host.openChat(instance);
            instance.sideInput.focus();
          }
        } else {
          sendToTerminal();
          e.preventDefault();
        }
      } else if (instance.isStreaming && (instance.chatOpen || instance.chatMinimized)) {
        // Streaming with chat open → inject message into running agent
        const text = input.value.trim();
        if (text) {
          host.injectUserMessage(instance, text);
          input.value = '';
          instance.state.draftText = '';
        }
        e.preventDefault();
      } else if (e.ctrlKey || e.metaKey) {
        // Ctrl+Enter: swapped in agent mode
        if (loadSettings().aiEnterSendsToAgent) {
          sendToTerminal(); // agent mode: Ctrl+Enter → terminal
        } else {
          sendToLLM();      // default: Ctrl+Enter → LLM
        }
        e.preventDefault();
      } else if (instance.chatOpen || instance.chatMinimized) {
        sendToLLM();
        e.preventDefault();
      } else {
        // Enter (no modifier, chat not open):
        if (loadSettings().aiEnterSendsToAgent) {
          sendToLLM();      // agent mode: Enter → LLM
        } else if (pendingPromptConfirm) {
          // Second Enter → confirm send to Agent
          pendingPromptConfirm = false;
          dismissPromptHint();
          const dontAsk = instance.element.querySelector('.ai-prompt-hint-check input') as HTMLInputElement;
          if (dontAsk?.checked) {
            const s = loadSettings();
            s.aiEnterSendsToAgent = true;
            saveSettings(s);
            host.syncBarPlaceholder(instance);
          }
          sendToLLM();
        } else {
          // default: Enter → terminal, but detect prompts
          const text = input.value.trim();
          if (text && host.looksLikePrompt(text)) {
            e.preventDefault();
            pendingPromptConfirm = true;
            showPromptHint(instance.element);
            return;
          }
          sendToTerminal();
        }
        e.preventDefault();
      }
    }
    if (e.key === 'Escape') {
      if (pendingPromptConfirm) {
        // Esc during prompt confirm → send to terminal
        pendingPromptConfirm = false;
        dismissPromptHint();
        sendToTerminal();
        e.preventDefault();
        return;
      }
      if (instance.isStreaming) {
        instance.agentAbort?.();
        instance.agent.abort();
        instance.isStreaming = false;
        host.updateButtonHighlight(instance);
        if (instance.streamMsgEl) {
          instance.streamMsgEl.classList.remove('streaming');
          // Finalize whatever we have so far
          if (instance.streamBuffer) {
            host.finalizeMessage(instance, instance.streamBuffer);
          }
        }
        document.dispatchEvent(new CustomEvent('status-bar-ai', { detail: { active: false } }));
      } else if (instance.chatOpen) {
        host.minimizeChat(instance);
      }
      host.closeHistory(instance);
    }
    e.stopPropagation();
  });

  input.addEventListener('keyup', (e) => e.stopPropagation());
  input.addEventListener('keypress', (e) => e.stopPropagation());
}
