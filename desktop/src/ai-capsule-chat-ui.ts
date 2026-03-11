import { t } from './i18n';
import { escapeHtml } from './status-bar';
import { pulseIcon, thinkingIcon, stopIcon } from './ai-icons';
import { renderMarkdown } from './ai-capsule-markdown';
import type { AICapsuleInstance } from './ai-capsule-types';
import type { AgentCallbacks } from './ai-agent';

export const LLM_SEND_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8L7 3.5 13.5 2.5 12.5 9 8 13.5z"/><path d="M2.5 8L6.5 6.5 9.5 9.5 8 13.5"/><circle cx="9.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>`;

export function updateButtonHighlight(instance: AICapsuleInstance): void {
  const termBtn = instance.element.querySelector('.ai-bar-btn-term') as HTMLButtonElement;
  const llmBtn = instance.element.querySelector('.ai-bar-btn-llm') as HTMLButtonElement;
  const chatActive = instance.chatOpen || instance.chatMinimized;
  if (termBtn) termBtn.classList.toggle('chat-active', chatActive);
  if (llmBtn) {
    llmBtn.classList.toggle('chat-active', chatActive);
    if (instance.isStreaming) {
      llmBtn.innerHTML = stopIcon(16);
      llmBtn.classList.add('streaming-active');
      llmBtn.title = t('aiStopGenerating');
    } else {
      llmBtn.innerHTML = LLM_SEND_SVG;
      llmBtn.classList.remove('streaming-active');
      llmBtn.title = `${t('aiSendPrompt')} (Ctrl+Enter)`;
    }
  }
}

export function updateChatTitle(instance: AICapsuleInstance, title?: string): void {
  if (!instance.chatPanel) return;
  const titleEl = instance.chatPanel.querySelector('.ai-chat-title');
  if (!titleEl) return;
  if (title) {
    titleEl.textContent = title.length > 40 ? title.slice(0, 40) + '...' : title;
    return;
  }
  const firstUser = instance.messages.find(m => m.type === 'user');
  if (firstUser) {
    const text = firstUser.content;
    titleEl.textContent = text.length > 40 ? text.slice(0, 40) + '...' : text;
  } else {
    titleEl.textContent = t('aiCapsule');
  }
}

export function appendUserMessage(instance: AICapsuleInstance, text: string): void {
  if (!instance.chatPanel) return;
  const container = instance.chatPanel.querySelector('.ai-chat-messages');
  if (!container) return;

  const msg = document.createElement('div');
  msg.className = 'ai-msg ai-msg-user';
  const content = document.createElement('div');
  content.className = 'ai-msg-content';
  content.textContent = text;
  msg.appendChild(content);
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

export function showAgentPulse(instance: AICapsuleInstance): void {
  const container = instance.chatPanel?.querySelector('.ai-chat-messages');
  if (!container || container.querySelector('.ai-agent-pulse')) return;
  const pulse = document.createElement('div');
  pulse.className = 'ai-agent-pulse';
  const dots = Array.from({ length: 6 }, (_, i) =>
    `<span class="ai-pulse-dot" style="animation-delay:${i * 0.25}s">·</span>`
  ).join('');
  pulse.innerHTML = `${pulseIcon('var(--accent, #6aa4ff)', 10)} <span class="ai-pulse-label">${t('aiWorking')}</span><span class="ai-pulse-dots">${dots}</span>`;
  container.appendChild(pulse);
  container.scrollTop = container.scrollHeight;
}

export function hideAgentPulse(instance: AICapsuleInstance): void {
  const container = instance.chatPanel?.querySelector('.ai-chat-messages');
  if (!container) return;
  container.querySelector('.ai-agent-pulse')?.remove();
}

export function sinkAgentPulse(instance: AICapsuleInstance): void {
  const container = instance.chatPanel?.querySelector('.ai-chat-messages');
  if (!container) return;
  const pulse = container.querySelector('.ai-agent-pulse');
  if (pulse) container.appendChild(pulse);
}

export function beginAssistantMessage(instance: AICapsuleInstance): void {
  collapseActiveThinking(instance);
  instance.streamMsgEl = null;
  instance.streamBuffer = '';
  instance.reasoningBuffer = '';
}

export function ensureStreamBubble(instance: AICapsuleInstance): HTMLDivElement | null {
  if (instance.streamMsgEl) return instance.streamMsgEl;
  if (!instance.chatPanel) return null;
  const container = instance.chatPanel.querySelector('.ai-chat-messages');
  if (!container) return null;

  collapseActiveThinking(instance);

  const msg = document.createElement('div');
  msg.className = 'ai-msg ai-msg-assistant streaming';
  const content = document.createElement('div');
  content.className = 'ai-msg-content';

  const cursor = document.createElement('span');
  cursor.className = 'ai-cursor';
  cursor.textContent = '\u258A';
  content.appendChild(cursor);

  msg.appendChild(content);
  container.appendChild(msg);
  sinkAgentPulse(instance);
  container.scrollTop = container.scrollHeight;

  instance.streamMsgEl = msg;
  return msg;
}

export function appendStreamToken(instance: AICapsuleInstance, token: string): void {
  instance.streamBuffer += token;

  ensureStreamBubble(instance);
  if (!instance.streamMsgEl) return;
  const content = instance.streamMsgEl.querySelector('.ai-msg-content');
  if (!content) return;

  const textNode = content.querySelector('.ai-stream-text');
  if (textNode) {
    textNode.textContent = instance.streamBuffer;
  } else {
    const span = document.createElement('span');
    span.className = 'ai-stream-text';
    span.textContent = instance.streamBuffer;
    const cursor = content.querySelector('.ai-cursor');
    content.insertBefore(span, cursor);
  }

  const container = instance.chatPanel?.querySelector('.ai-chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

export function collapseActiveThinking(instance: AICapsuleInstance): void {
  const container = instance.chatPanel?.querySelector('.ai-chat-messages');
  if (!container) return;
  const block = container.querySelector('.ai-thinking-block.active');
  if (block) {
    block.classList.remove('active');
    const details = block.querySelector('details');
    if (details) details.open = false;
  }
}

export function appendReasoningToken(instance: AICapsuleInstance, token: string): void {
  instance.reasoningBuffer += token;

  const container = instance.chatPanel?.querySelector('.ai-chat-messages');
  if (!container) return;

  let block = container.querySelector('.ai-thinking-block.active') as HTMLElement | null;
  if (!block) {
    block = document.createElement('div');
    block.className = 'ai-thinking-block active';

    const details = document.createElement('details');
    details.className = 'ai-reasoning';
    details.open = true;

    const summary = document.createElement('summary');
    summary.innerHTML = `${thinkingIcon(12)} <span>${t('aiThinking')}</span>`;
    details.appendChild(summary);

    const pre = document.createElement('div');
    pre.className = 'ai-reasoning-text';
    details.appendChild(pre);

    block.appendChild(details);
    container.appendChild(block);
    sinkAgentPulse(instance);
  }

  const textEl = block.querySelector('.ai-reasoning-text');
  if (textEl) textEl.textContent += token;

  container.scrollTop = container.scrollHeight;
}

export function finalizeMessage(
  instance: AICapsuleInstance,
  fullText: string,
  deps: {
    addHistory: (inst: AICapsuleInstance, cmd: string, source: 'manual' | 'ai') => void;
    bindCommandButtons: (inst: AICapsuleInstance, container: Element) => void;
    saveConversation: (inst: AICapsuleInstance) => void;
  },
): void {
  instance.isStreaming = false;
  document.dispatchEvent(new CustomEvent('status-bar-ai', { detail: { active: false } }));
  updateButtonHighlight(instance);
  hideAgentPulse(instance);

  collapseActiveThinking(instance);

  if (instance.reasoningBuffer) {
    instance.messages.push({ type: 'thinking', content: '', reasoning: instance.reasoningBuffer, timestamp: Date.now() });
    instance.reasoningBuffer = '';
  }

  if (!instance.streamMsgEl && fullText) {
    ensureStreamBubble(instance);
  }

  if (instance.streamMsgEl) {
    instance.streamMsgEl.classList.remove('streaming');
    const content = instance.streamMsgEl.querySelector('.ai-msg-content');
    if (content) {
      content.querySelector('.ai-stream-text')?.remove();
      content.querySelector('.ai-cursor')?.remove();
      if (fullText) {
        const mdWrapper = document.createElement('div');
        const addHistoryCb = (cmd: string) => deps.addHistory(instance, cmd, 'ai');
        mdWrapper.innerHTML = renderMarkdown(fullText, instance.sessionId, addHistoryCb);
        while (mdWrapper.firstChild) content.appendChild(mdWrapper.firstChild);
        deps.bindCommandButtons(instance, content);
      }
    }
  }

  instance.streamMsgEl = null;
  instance.streamBuffer = '';

  if (fullText) {
    instance.messages.push({ type: 'assistant', content: fullText, timestamp: Date.now() });
  }
  deps.saveConversation(instance);

  const container = instance.chatPanel?.querySelector('.ai-chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

export function finalizeThinking(
  instance: AICapsuleInstance,
  text: string,
  deps: {
    addHistory: (inst: AICapsuleInstance, cmd: string, source: 'manual' | 'ai') => void;
    bindCommandButtons: (inst: AICapsuleInstance, container: Element) => void;
  },
): void {
  collapseActiveThinking(instance);

  const reasoning = instance.reasoningBuffer || undefined;
  if (reasoning || text) {
    instance.messages.push({ type: 'thinking', content: text, reasoning, timestamp: Date.now() });
  }
  instance.reasoningBuffer = '';

  if (instance.streamMsgEl) {
    instance.streamMsgEl.classList.remove('streaming');
    const content = instance.streamMsgEl.querySelector('.ai-msg-content');
    if (content) {
      content.querySelector('.ai-stream-text')?.remove();
      content.querySelector('.ai-cursor')?.remove();
      if (text) {
        const mdWrapper = document.createElement('div');
        const addHistoryCb = (cmd: string) => deps.addHistory(instance, cmd, 'ai');
        mdWrapper.innerHTML = renderMarkdown(text, instance.sessionId, addHistoryCb);
        while (mdWrapper.firstChild) content.appendChild(mdWrapper.firstChild);
        deps.bindCommandButtons(instance, content);
      }
    }
  } else if (text) {
    const bubble = ensureStreamBubble(instance);
    if (bubble) {
      bubble.classList.remove('streaming');
      const content = bubble.querySelector('.ai-msg-content');
      if (content) {
        content.querySelector('.ai-cursor')?.remove();
        const mdWrapper = document.createElement('div');
        const addHistoryCb = (cmd: string) => deps.addHistory(instance, cmd, 'ai');
        mdWrapper.innerHTML = renderMarkdown(text, instance.sessionId, addHistoryCb);
        while (mdWrapper.firstChild) content.appendChild(mdWrapper.firstChild);
        deps.bindCommandButtons(instance, content);
      }
    }
  }

  instance.streamMsgEl = null;
  instance.streamBuffer = '';

  const container = instance.chatPanel?.querySelector('.ai-chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

export function showError(instance: AICapsuleInstance, message: string): void {
  instance.isStreaming = false;
  document.dispatchEvent(new CustomEvent('status-bar-ai', { detail: { active: false } }));
  updateButtonHighlight(instance);
  hideAgentPulse(instance);
  collapseActiveThinking(instance);

  if (!instance.streamMsgEl) {
    ensureStreamBubble(instance);
  }
  if (instance.streamMsgEl) {
    instance.streamMsgEl.classList.remove('streaming');
    const content = instance.streamMsgEl.querySelector('.ai-msg-content');
    if (content) {
      content.innerHTML = `<div class="ai-msg-error">${t('aiStreamError')}: ${escapeHtml(message)}</div>`;
    }
  }

  instance.streamMsgEl = null;
  instance.streamBuffer = '';
  instance.reasoningBuffer = '';
}

export function appendSystemNotice(instance: AICapsuleInstance, text: string): void {
  if (!instance.chatPanel) return;
  const container = instance.chatPanel.querySelector('.ai-chat-messages');
  if (!container) return;

  const notice = document.createElement('div');
  notice.className = 'ai-system-notice';
  notice.textContent = text;
  container.appendChild(notice);
  container.scrollTop = container.scrollHeight;

  instance.messages.push({ type: 'system', content: text, timestamp: Date.now() });
}

export function buildAgentCallbacks(
  instance: AICapsuleInstance,
  deps: {
    addHistory: (inst: AICapsuleInstance, cmd: string, source: 'manual' | 'ai') => void;
    bindCommandButtons: (inst: AICapsuleInstance, container: Element) => void;
    saveConversation: (inst: AICapsuleInstance) => void;
    appendToolCallCard: (inst: AICapsuleInstance, toolName: string, args: Record<string, unknown>) => void;
    updateToolResultCard: (inst: AICapsuleInstance, toolName: string, result: string, isError: boolean) => void;
    showConfirmCard: (inst: AICapsuleInstance, toolName: string, args: Record<string, unknown>) => Promise<boolean | string>;
  },
): AgentCallbacks {
  const finalizeDeps = {
    addHistory: deps.addHistory,
    bindCommandButtons: deps.bindCommandButtons,
    saveConversation: deps.saveConversation,
  };
  const thinkingDeps = {
    addHistory: deps.addHistory,
    bindCommandButtons: deps.bindCommandButtons,
  };

  return {
    onToken: (token) => appendStreamToken(instance, token),
    onReasoning: (token) => appendReasoningToken(instance, token),
    onComplete: (fullText) => finalizeMessage(instance, fullText, finalizeDeps),
    onError: (err) => showError(instance, err.message),
    onThinkingComplete: (text) => {
      finalizeThinking(instance, text, thinkingDeps);
    },
    onIterationStart: () => {
      instance.isStreaming = true;
      document.dispatchEvent(new CustomEvent('status-bar-ai', { detail: { active: true } }));
      updateButtonHighlight(instance);
      showAgentPulse(instance);
      instance.streamBuffer = '';
      beginAssistantMessage(instance);
    },
    onToolCall: (toolName, args) => deps.appendToolCallCard(instance, toolName, args),
    onToolResult: (toolName, result, isError) => deps.updateToolResultCard(instance, toolName, result, isError),
    onConfirmRequired: (toolName, args) => deps.showConfirmCard(instance, toolName, args),
    onAborted: (_steps) => {
      collapseActiveThinking(instance);
      instance.reasoningBuffer = '';
      if (instance.streamMsgEl && instance.streamBuffer) {
        finalizeMessage(instance, instance.streamBuffer, finalizeDeps);
      } else {
        instance.isStreaming = false;
        document.dispatchEvent(new CustomEvent('status-bar-ai', { detail: { active: false } }));
        updateButtonHighlight(instance);
        hideAgentPulse(instance);
        instance.streamMsgEl = null;
        instance.streamBuffer = '';
      }
    },
    onDegraded: (reason) => appendSystemNotice(instance, reason),

    onRetrying: (attempt, maxAttempts, _delayMs, reason) => {
      if (instance.streamMsgEl) {
        instance.streamMsgEl.remove();
        instance.streamMsgEl = null;
      }
      instance.streamBuffer = '';

      const reasonText = reason === 'rate_limit'
        ? t('aiRateLimitRetry')
        : t('aiServerErrorRetry');
      appendSystemNotice(instance, `${reasonText} (${attempt}/${maxAttempts})`);
    },
    onContextCompressed: () => {
      appendSystemNotice(instance, t('aiContextCompressed'));
    },
  };
}
