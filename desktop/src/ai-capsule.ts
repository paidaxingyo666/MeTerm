import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { writeTextFile, readTextFile, mkdir, exists, readDir, remove, BaseDirectory } from '@tauri-apps/plugin-fs';
import { t } from './i18n';
import { loadSettings, saveSettings } from './themes';
import { AIAgent, AgentCallbacks } from './ai-agent';
import { escapeHtml } from './status-bar';
import { resolveActiveModel, resolveModel } from './ai-provider';
import { toolIcon, statusIcon, pulseIcon, spinnerIcon, thinkingIcon, shieldIcon, stopIcon, approveIcon, rejectIcon, editIcon, chevronIcon, TOOL_COLORS, STATUS_COLORS, TRUST_COLORS } from './ai-icons';

export interface HistoryEntry {
  command: string;
  timestamp: number;
  source: 'manual' | 'ai';
}

export interface AICapsuleInstance {
  sessionId: string;
  historyKey: string;
  element: HTMLDivElement;
  messages: ConvEntry[];
  selectedModel: string;
  history: HistoryEntry[];
  lineBuffer: string;
  unsubInput: (() => void) | null;
  historyOpen: boolean;
  // AI chat state
  agent: AIAgent;
  chatPanel: HTMLDivElement | null;
  chatOpen: boolean;
  chatMinimized: boolean;
  isStreaming: boolean;
  streamBuffer: string;
  streamMsgEl: HTMLDivElement | null;
  reasoningBuffer: string;
  // LLM chat history panel state
  chatHistoryOpen: boolean;
  chatHistoryPanel: HTMLDivElement | null;
  currentConversationId: string;
}

/** Discriminated-union entry stored per conversation turn */
export type ConvEntry =
  | { type: 'user';      content: string; timestamp: number }
  | { type: 'thinking';  content: string; reasoning?: string; timestamp: number }
  | { type: 'assistant'; content: string; timestamp: number }
  | { type: 'system';    content: string; timestamp: number }
  | { type: 'tool_call'; toolName: string; args: Record<string, unknown>;
      result: string | null; isError: boolean; timestamp: number };

export interface ChatConversation {
  id: string;
  title: string;
  messages: ConvEntry[];
  createdAt: number;
  updatedAt: number;
}

const MAX_HISTORY = 100;
const HISTORY_STORAGE_KEY = 'meterm-ai-history';

// ─── Simple Markdown Renderer ────────────────────────────────────

function renderMarkdown(text: string, sessionId: string, addHistoryFn: (cmd: string) => void): string {
  // Split into code blocks and text segments
  const segments: string[] = [];
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    // Text before code block
    if (match.index > lastIndex) {
      segments.push(renderInlineMarkdown(text.slice(lastIndex, match.index)));
    }

    const lang = match[1] || '';
    const code = match[2].trim();
    const isBash = /^(bash|sh|shell|zsh|fish|cmd|powershell)?$/.test(lang);

    // Single-line: no newlines and short enough to fit on one row
    const isInline = !code.includes('\n') && code.length <= 65;

    // Generate a unique id for command execution binding
    const blockId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    segments.push(
      `<div class="ai-cmd-block ${isInline ? 'ai-cmd-inline' : 'ai-cmd-stacked'}" data-block-id="${blockId}">` +
      `<div class="ai-cmd-screen">` +
      (!isInline ? `<div class="ai-cmd-lang">${escapeHtml(lang || 'code')}</div>` : '') +
      `<pre><code>${escapeHtml(code)}</code></pre>` +
      `</div>` +
      `<div class="ai-cmd-actions">` +
      (isBash
        ? `<button class="ai-cmd-run" data-cmd="${escapeHtml(code)}" data-session="${sessionId}">${t('aiRunCommand')}</button>`
        : '') +
      `<button class="ai-cmd-copy" data-code="${escapeHtml(code)}">${t('aiCopyCode')}</button>` +
      `</div></div>`
    );

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last code block
  if (lastIndex < text.length) {
    segments.push(renderInlineMarkdown(text.slice(lastIndex)));
  }

  return segments.join('');
}

function renderInlineMarkdown(text: string): string {
  // Escape HTML first
  let html = escapeHtml(text);

  // Bold: **text**
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

  // Inline code: `text`
  html = html.replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>');

  // Paragraphs: double newline
  html = html.split('\n\n').map((p) => `<p>${p.trim()}</p>`).join('');

  // Single newlines within paragraphs -> <br>
  html = html.replace(/\n/g, '<br>');

  return html;
}

// ─── AI Capsule Manager ──────────────────────────────────────────

class AICapsuleManagerClass {
  private capsules = new Map<string, AICapsuleInstance>();
  private _barHidden = false;
  private _floatingBtn: HTMLElement | null = null;
  private _lastShownSessionId: string | null = null;
  private _chatHistoryDir: string | null = null;
  private _deleteSkipUntil = 0; // timestamp: skip confirm until this time
  // 弹窗搜索筛选状态
  private _savedPlaceholder = new Map<string, string>();   // sessionId → 原始 placeholder
  private _savedInputValue = new Map<string, string>();    // sessionId → 原始输入值
  private _filterListener = new Map<string, () => void>(); // sessionId → input 监听器引用

  create(sessionId: string): AICapsuleInstance {
    if (this.capsules.has(sessionId)) {
      return this.capsules.get(sessionId)!;
    }

    const isSSH = DrawerManager.has(sessionId);
    const element = this.createBarElement(sessionId, isSSH);
    const historyKey = this.getHistoryKey(sessionId);
    const conversationId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const instance: AICapsuleInstance = {
      sessionId,
      historyKey,
      element,
      messages: [],
      selectedModel: '',
      history: this.loadHistory(historyKey),
      lineBuffer: '',
      unsubInput: null,
      historyOpen: false,
      agent: new AIAgent(),
      chatPanel: null,
      chatOpen: false,
      chatMinimized: false,
      isStreaming: false,
      streamBuffer: '',
      streamMsgEl: null,
      reasoningBuffer: '',
      chatHistoryOpen: false,
      chatHistoryPanel: null,
      currentConversationId: conversationId,
    };

    this.capsules.set(sessionId, instance);
    this.setupInput(instance);
    this.setupHistory(instance);
    this.setupChatHistory(instance);
    this.startTerminalCapture(instance);
    if (isSSH) {
      this.setupDrawerToggle(instance);
    }

    return instance;
  }

  private createBarElement(sessionId: string, isSSH: boolean): HTMLDivElement {
    const bar = document.createElement('div');
    bar.className = 'ai-bar';
    bar.dataset.sessionId = sessionId;

    // Model selector (clickable dropdown)
    const modelSelect = document.createElement('div');
    modelSelect.className = 'ai-bar-model-select';

    const modelLabel = document.createElement('span');
    modelLabel.className = 'ai-bar-model-label';
    this.updateModelLabel(modelLabel);

    const modelArrow = document.createElement('span');
    modelArrow.className = 'ai-bar-model-arrow';
    modelArrow.innerHTML = `<svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><polyline points="2 3 4 5 6 3"/></svg>`;

    const modelDropdown = document.createElement('div');
    modelDropdown.className = 'ai-bar-model-dropdown';
    modelDropdown.style.display = 'none';
    this.buildModelDropdown(modelDropdown, modelLabel);

    modelSelect.appendChild(modelLabel);
    modelSelect.appendChild(modelArrow);
    modelSelect.appendChild(modelDropdown);

    // Toggle dropdown on click
    modelSelect.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = modelDropdown.style.display !== 'none';
      if (isOpen) {
        modelDropdown.style.display = 'none';
        modelSelect.classList.remove('open');
      } else {
        this.buildModelDropdown(modelDropdown, modelLabel);
        modelDropdown.style.display = '';
        modelSelect.classList.add('open');
      }
    });

    // Close dropdown on outside click
    document.addEventListener('click', () => {
      modelDropdown.style.display = 'none';
      modelSelect.classList.remove('open');
    });

    // Input
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ai-bar-input';
    input.placeholder = t('aiPlaceholderInput');
    input.autocapitalize = 'off';
    input.setAttribute('autocorrect', 'off');
    input.spellcheck = false;

    // Send to terminal button (Enter)
    const termBtn = document.createElement('button');
    termBtn.className = 'ai-bar-btn ai-bar-btn-term';
    termBtn.title = `${t('aiSendCommand')} (Enter)`;
    termBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="4 6 8 2 12 6"/><line x1="8" y1="2" x2="8" y2="14"/></svg>`;

    // Send to LLM button (Ctrl+Enter)
    const llmBtn = document.createElement('button');
    llmBtn.className = 'ai-bar-btn ai-bar-btn-llm';
    llmBtn.title = `${t('aiSendPrompt')} (Ctrl+Enter)`;
    llmBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8L7 3.5 13.5 2.5 12.5 9 8 13.5z"/><path d="M2.5 8L6.5 6.5 9.5 9.5 8 13.5"/><circle cx="9.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>`;

    // LLM chat history button
    const chatHistBtn = document.createElement('button');
    chatHistBtn.className = 'ai-bar-btn ai-bar-btn-chat-history';
    chatHistBtn.title = t('aiChatHistory');
    chatHistBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12v8a1 1 0 01-1 1H5l-3 2.5V4a1 1 0 011-1z"/><line x1="5" y1="6.5" x2="11" y2="6.5"/><line x1="5" y1="9" x2="9" y2="9"/></svg>`;

    // LLM chat history panel (hidden by default)
    const chatHistPanel = document.createElement('div');
    chatHistPanel.className = 'ai-bar-chat-history-panel';
    chatHistPanel.style.display = 'none';

    // History button
    const histBtn = document.createElement('button');
    histBtn.className = 'ai-bar-btn ai-bar-btn-history';
    histBtn.title = t('aiHistory');
    histBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><polyline points="8 4.5 8 8 10.5 9.5"/></svg>`;

    // History panel (hidden by default)
    const histPanel = document.createElement('div');
    histPanel.className = 'ai-bar-history-panel';
    histPanel.style.display = 'none';

    bar.appendChild(modelSelect);
    bar.appendChild(input);
    bar.appendChild(termBtn);
    bar.appendChild(llmBtn);
    bar.appendChild(chatHistBtn);
    bar.appendChild(chatHistPanel);
    bar.appendChild(histBtn);
    bar.appendChild(histPanel);

    // Drawer toggle button (SSH only)
    if (isSSH) {
      const drawerBtn = document.createElement('button');
      drawerBtn.className = 'ai-bar-btn ai-bar-btn-drawer';
      drawerBtn.title = t('drawerTabFiles');
      drawerBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 13V4a1 1 0 011-1h3.5l2 2H13a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1z"/></svg>`;
      bar.appendChild(drawerBtn);
    }

    // Trust level switcher
    const trustSwitcher = this.createTrustSwitcher();
    bar.appendChild(trustSwitcher);

    // Hide AI bar button (always last)
    const hideBtn = document.createElement('button');
    hideBtn.className = 'ai-bar-btn ai-bar-btn-hide';
    hideBtn.title = 'Hide';
    hideBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
    hideBtn.addEventListener('click', () => this.hideBar());
    bar.appendChild(hideBtn);

    return bar;
  }

  private updateModelLabel(label: HTMLSpanElement): void {
    const settings = loadSettings();
    const resolved = resolveActiveModel(settings.aiProviders, settings.aiActiveModel);
    if (settings.aiActiveModel === 'auto') {
      label.textContent = t('aiModelAuto');
      label.title = resolved ? `Auto → ${resolved.entry.label}: ${resolved.model}` : 'Auto';
    } else if (resolved) {
      label.textContent = resolved.model;
      label.title = `${resolved.entry.label} · ${resolved.model}`;
    } else {
      label.textContent = t('aiModelAuto');
      label.title = 'No model configured';
    }
  }

  private buildModelDropdown(dropdown: HTMLDivElement, label: HTMLSpanElement): void {
    const settings = loadSettings();
    dropdown.innerHTML = '';

    const closeDropdown = () => {
      dropdown.style.display = 'none';
      dropdown.closest('.ai-bar-model-select')?.classList.remove('open');
    };

    // Auto option
    const autoOption = document.createElement('div');
    autoOption.className = 'ai-bar-model-option';
    if (settings.aiActiveModel === 'auto') autoOption.classList.add('active');
    autoOption.innerHTML = `<span class="ai-model-opt-name">${t('aiModelAuto')}</span><span class="ai-model-opt-desc">${t('aiModelAutoDesc')}</span>`;
    autoOption.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = loadSettings();
      s.aiActiveModel = 'auto';
      saveSettings(s);
      this.updateModelLabel(label);
      closeDropdown();
    });
    dropdown.appendChild(autoOption);

    // Models grouped by provider
    for (const provider of settings.aiProviders) {
      // Skip providers with no API key and no enabled models
      if (!provider.apiKey && provider.enabledModels.length === 0) continue;

      const models = provider.enabledModels.length > 0
        ? provider.enabledModels
        : [resolveModel(provider.type, 'auto')];  // fallback to default model

      // Provider group header
      const sep = document.createElement('div');
      sep.className = 'ai-bar-model-separator';
      dropdown.appendChild(sep);

      const groupHeader = document.createElement('div');
      groupHeader.className = 'ai-bar-model-group-header';
      groupHeader.textContent = provider.label;
      dropdown.appendChild(groupHeader);

      // Model options
      for (const model of models) {
        const modelKey = `${provider.id}:${model}`;
        const option = document.createElement('div');
        option.className = 'ai-bar-model-option';
        if (settings.aiActiveModel === modelKey) option.classList.add('active');
        option.innerHTML = `<span class="ai-model-opt-name">${escapeHtml(model)}</span>`;
        option.addEventListener('click', (e) => {
          e.stopPropagation();
          const s = loadSettings();
          s.aiActiveModel = modelKey;
          saveSettings(s);
          this.updateModelLabel(label);
          closeDropdown();
        });
        dropdown.appendChild(option);
      }
    }
  }

  // ─── Chat Panel ────────────────────────────────────────────────

  private createChatPanel(instance: AICapsuleInstance): HTMLDivElement {
    const panel = document.createElement('div');
    panel.className = 'ai-chat-panel';

    // Resize handle at the top edge
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'ai-chat-resize-handle';
    this.setupChatResize(panel, resizeHandle);

    // Header
    const header = document.createElement('div');
    header.className = 'ai-chat-header';

    const title = document.createElement('span');
    title.className = 'ai-chat-title';
    title.textContent = t('aiCapsule');

    // New chat button — save current conversation to history, then start fresh
    const newChatBtn = document.createElement('button');
    newChatBtn.className = 'ai-chat-clear';
    newChatBtn.textContent = t('aiNewChat');
    newChatBtn.addEventListener('click', () => {
      if (instance.isStreaming) return;
      // Save current conversation to history if it has messages
      if (instance.messages.length > 0) {
        const snapshot = { id: instance.currentConversationId, messages: [...instance.messages] };
        void this.saveConversation(instance, snapshot);
      }
      // Reset to a fresh conversation
      instance.agent.clear();
      instance.messages = [];
      instance.currentConversationId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      instance.streamMsgEl = null;
      instance.streamBuffer = '';
      instance.reasoningBuffer = '';
      const msgContainer = panel.querySelector('.ai-chat-messages');
      if (msgContainer) msgContainer.innerHTML = '';
      this.updateChatTitle(instance);
    });

    const clearBtn = document.createElement('button');
    clearBtn.className = 'ai-chat-clear';
    clearBtn.textContent = t('aiClearChat');
    clearBtn.addEventListener('click', () => {
      if (instance.isStreaming) return;
      // Clear without saving to history — user explicitly discards
      // Delete persisted file for current conversation
      void this.deleteConversation(instance.currentConversationId);
      instance.agent.clear();
      instance.messages = [];
      instance.currentConversationId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const msgContainer = panel.querySelector('.ai-chat-messages');
      if (msgContainer) msgContainer.innerHTML = '';
      this.updateChatTitle(instance);
    });

    // Minimize button — hides panel but keeps conversation alive
    const minimizeBtn = document.createElement('button');
    minimizeBtn.className = 'ai-chat-minimize';
    minimizeBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="8" x2="13" y2="8"/></svg>`;
    minimizeBtn.title = t('aiCollapse');
    minimizeBtn.addEventListener('click', () => this.minimizeChat(instance));

    // Close button — save conversation to history then reset
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ai-chat-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => this.closeChatAndSave(instance));

    header.appendChild(title);
    header.appendChild(newChatBtn);
    header.appendChild(clearBtn);
    header.appendChild(minimizeBtn);
    header.appendChild(closeBtn);

    // Messages container
    const messages = document.createElement('div');
    messages.className = 'ai-chat-messages';

    panel.appendChild(resizeHandle);
    panel.appendChild(header);
    panel.appendChild(messages);

    // Bind context menu on the messages container (event delegation)
    this.bindChatContextMenu(instance, messages);

    return panel;
  }

  /** Wire up drag-to-resize on the chat panel's top handle. */
  private setupChatResize(panel: HTMLDivElement, handle: HTMLDivElement): void {
    let startY = 0;
    let startH = 0;

    const onMouseMove = (e: MouseEvent) => {
      // Dragging up → larger panel (startY - e.clientY is positive)
      const delta = startY - e.clientY;
      const header = panel.querySelector('.ai-chat-header') as HTMLElement | null;
      const minH = header ? header.offsetHeight + 6 : 36; // header + resize handle
      const maxH = window.innerHeight * 0.8;
      const newH = Math.min(maxH, Math.max(minH, startH + delta));
      panel.style.height = `${newH}px`;
      panel.style.flex = 'none'; // override flex sizing during manual resize
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

  private openChat(instance: AICapsuleInstance): void {
    if (instance.chatOpen) return;

    if (!instance.chatPanel) {
      instance.chatPanel = this.createChatPanel(instance);
      // Insert chat panel into #terminal-panel (before .ai-bar) so it
      // participates in the flex layout and pushes the terminal area up.
      const terminalPanel = instance.element.parentElement;
      if (terminalPanel) {
        terminalPanel.insertBefore(instance.chatPanel, instance.element);
      }
    }

    instance.chatPanel.style.display = '';
    instance.chatOpen = true;
    instance.chatMinimized = false;
    this.closeHistory(instance);
    this.updateButtonHighlight(instance);
    // Refit terminal to new available height
    TerminalRegistry.resizeAll();
  }

  /** Minimize: hide panel but keep conversation alive */
  private minimizeChat(instance: AICapsuleInstance): void {
    if (!instance.chatOpen) return;
    if (instance.chatPanel) {
      instance.chatPanel.style.display = 'none';
    }
    instance.chatOpen = false;
    instance.chatMinimized = true;
    this.updateButtonHighlight(instance);
    TerminalRegistry.resizeAll();
  }

  /** Close: save to history then reset conversation */
  private closeChatAndSave(instance: AICapsuleInstance): void {
    // Abort streaming if active
    if (instance.isStreaming) {
      instance.agent.abort();
      instance.isStreaming = false;
      document.dispatchEvent(new CustomEvent('status-bar-ai', { detail: { active: false } }));
      this.updateButtonHighlight(instance);
    }

    // Snapshot messages before clearing, then save asynchronously
    if (instance.messages.length > 0) {
      const snapshot = { id: instance.currentConversationId, messages: [...instance.messages] };
      void this.saveConversation(instance, snapshot);
    }

    // Reset conversation immediately
    instance.agent.clear();
    instance.messages = [];
    instance.currentConversationId = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (instance.chatPanel) {
      const msgContainer = instance.chatPanel.querySelector('.ai-chat-messages');
      if (msgContainer) msgContainer.innerHTML = '';
      instance.chatPanel.style.display = 'none';
    }
    instance.chatOpen = false;
    instance.chatMinimized = false;
    instance.streamMsgEl = null;
    instance.streamBuffer = '';
    instance.reasoningBuffer = '';
    this.updateChatTitle(instance);
    this.updateButtonHighlight(instance);
    TerminalRegistry.resizeAll();
  }

  /** Restore a saved conversation into the main chat panel */
  private restoreConversation(instance: AICapsuleInstance, conv: ChatConversation): void {
    // debug: console.log('[chat-history] restore:', conv.id, conv.messages.length);
    // Save current conversation if it has messages
    if (instance.messages.length > 0) {
      const snapshot = { id: instance.currentConversationId, messages: [...instance.messages] };
      void this.saveConversation(instance, snapshot);
    }

    // Close chat history panel
    this.closeChatHistory(instance);

    // Reset agent context
    instance.agent.clear();

    // Restore conversation state
    instance.currentConversationId = conv.id;
    instance.messages = conv.messages.map(m => ({ ...m }));
    instance.reasoningBuffer = '';

    // Ensure chat panel exists
    if (!instance.chatPanel) {
      instance.chatPanel = this.createChatPanel(instance);
      const terminalPanel = instance.element.parentElement;
      if (terminalPanel) {
        terminalPanel.insertBefore(instance.chatPanel, instance.element);
      }
    }

    // Clear and rebuild message UI
    const msgContainer = instance.chatPanel.querySelector('.ai-chat-messages');
    if (msgContainer) {
      msgContainer.innerHTML = '';
      const addHistory = (cmd: string) => this.addHistory(instance, cmd, 'ai');

      for (const msg of instance.messages) {
        if (msg.type === 'user') {
          const el = document.createElement('div');
          el.className = 'ai-msg ai-msg-user';
          const c = document.createElement('div');
          c.className = 'ai-msg-content';
          c.textContent = msg.content;
          el.appendChild(c);
          msgContainer.appendChild(el);

        } else if (msg.type === 'thinking') {
          // Reasoning block — standalone, no bubble
          if (msg.reasoning) {
            const block = document.createElement('div');
            block.className = 'ai-thinking-block';
            const details = document.createElement('details');
            details.className = 'ai-reasoning';
            const summary = document.createElement('summary');
            summary.innerHTML = `${thinkingIcon(12)} <span>${t('aiThinking')}</span>`;
            const textEl = document.createElement('div');
            textEl.className = 'ai-reasoning-text';
            textEl.textContent = msg.reasoning;
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
          msgContainer.appendChild(this.buildToolCard(msg));

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

      this.bindCommandButtons(instance, msgContainer);
      msgContainer.scrollTop = msgContainer.scrollHeight;
    }

    // Show chat panel
    instance.chatPanel.style.display = '';
    instance.chatOpen = true;
    instance.chatMinimized = false;
    instance.isStreaming = false;
    instance.streamMsgEl = null;
    instance.streamBuffer = '';
    this.updateChatTitle(instance, conv.title);
    this.updateButtonHighlight(instance);
    TerminalRegistry.resizeAll();
  }

  private static readonly LLM_SEND_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8L7 3.5 13.5 2.5 12.5 9 8 13.5z"/><path d="M2.5 8L6.5 6.5 9.5 9.5 8 13.5"/><circle cx="9.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>`;

  /** Update term/llm button highlight + streaming stop state */
  private updateButtonHighlight(instance: AICapsuleInstance): void {
    const termBtn = instance.element.querySelector('.ai-bar-btn-term') as HTMLButtonElement;
    const llmBtn = instance.element.querySelector('.ai-bar-btn-llm') as HTMLButtonElement;
    const chatActive = instance.chatOpen || instance.chatMinimized;
    if (termBtn) termBtn.classList.toggle('chat-active', chatActive);
    if (llmBtn) {
      llmBtn.classList.toggle('chat-active', chatActive);
      // Toggle between send and stop icon based on streaming state
      if (instance.isStreaming) {
        llmBtn.innerHTML = stopIcon(16);
        llmBtn.classList.add('streaming-active');
        llmBtn.title = t('aiStopGenerating');
      } else {
        llmBtn.innerHTML = AICapsuleManagerClass.LLM_SEND_SVG;
        llmBtn.classList.remove('streaming-active');
        llmBtn.title = `${t('aiSendPrompt')} (Ctrl+Enter)`;
      }
    }
  }

  /** Update chat panel title bar. If no explicit title given, derives from first user message. */
  private updateChatTitle(instance: AICapsuleInstance, title?: string): void {
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

  private appendUserMessage(instance: AICapsuleInstance, text: string): void {
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

  /** Show a pulsing indicator at the bottom of the chat to signal agent is running. */
  private showAgentPulse(instance: AICapsuleInstance): void {
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

  /** Remove the pulsing agent indicator. */
  private hideAgentPulse(instance: AICapsuleInstance): void {
    const container = instance.chatPanel?.querySelector('.ai-chat-messages');
    if (!container) return;
    container.querySelector('.ai-agent-pulse')?.remove();
  }

  /** Re-position the pulse to the bottom of the messages container. */
  private sinkAgentPulse(instance: AICapsuleInstance): void {
    const container = instance.chatPanel?.querySelector('.ai-chat-messages');
    if (!container) return;
    const pulse = container.querySelector('.ai-agent-pulse');
    if (pulse) container.appendChild(pulse); // moves to end
  }

  /** Prepare for a new assistant response. Doesn't create the bubble yet —
   *  it will be created lazily when the first content token arrives. */
  private beginAssistantMessage(instance: AICapsuleInstance): void {
    // Collapse any previous thinking block
    this.collapseActiveThinking(instance);
    instance.streamMsgEl = null;
    instance.streamBuffer = '';
    instance.reasoningBuffer = '';
  }

  /** Create the assistant bubble on demand (first content token). */
  private ensureStreamBubble(instance: AICapsuleInstance): HTMLDivElement | null {
    if (instance.streamMsgEl) return instance.streamMsgEl;
    if (!instance.chatPanel) return null;
    const container = instance.chatPanel.querySelector('.ai-chat-messages');
    if (!container) return null;

    // Collapse thinking block before starting content bubble
    this.collapseActiveThinking(instance);

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
    this.sinkAgentPulse(instance);
    container.scrollTop = container.scrollHeight;

    instance.streamMsgEl = msg;
    return msg;
  }

  private appendStreamToken(instance: AICapsuleInstance, token: string): void {
    instance.streamBuffer += token;

    this.ensureStreamBubble(instance);
    if (!instance.streamMsgEl) return;
    const content = instance.streamMsgEl.querySelector('.ai-msg-content');
    if (!content) return;

    // Render the raw text for now (we'll finalize with markdown on complete)
    const textNode = content.querySelector('.ai-stream-text');
    if (textNode) {
      textNode.textContent = instance.streamBuffer;
    } else {
      const span = document.createElement('span');
      span.className = 'ai-stream-text';
      span.textContent = instance.streamBuffer;
      // Insert before cursor
      const cursor = content.querySelector('.ai-cursor');
      content.insertBefore(span, cursor);
    }

    // Auto-scroll
    const container = instance.chatPanel?.querySelector('.ai-chat-messages');
    if (container) container.scrollTop = container.scrollHeight;
  }

  /** Collapse any active standalone thinking block. */
  private collapseActiveThinking(instance: AICapsuleInstance): void {
    const container = instance.chatPanel?.querySelector('.ai-chat-messages');
    if (!container) return;
    const block = container.querySelector('.ai-thinking-block.active');
    if (block) {
      block.classList.remove('active');
      const details = block.querySelector('details');
      if (details) details.open = false;
    }
  }

  /**
   * Append a reasoning/thinking token to a standalone thinking block
   * (outside any bubble) in the chat messages container.
   */
  private appendReasoningToken(instance: AICapsuleInstance, token: string): void {
    instance.reasoningBuffer += token;

    const container = instance.chatPanel?.querySelector('.ai-chat-messages');
    if (!container) return;

    // Find or create the standalone thinking block
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
      this.sinkAgentPulse(instance);
    }

    const textEl = block.querySelector('.ai-reasoning-text');
    if (textEl) textEl.textContent += token;

    container.scrollTop = container.scrollHeight;
  }

  private finalizeMessage(instance: AICapsuleInstance, fullText: string): void {
    instance.isStreaming = false;
    document.dispatchEvent(new CustomEvent('status-bar-ai', { detail: { active: false } }));
    this.updateButtonHighlight(instance);
    this.hideAgentPulse(instance);

    // Collapse standalone thinking block
    this.collapseActiveThinking(instance);

    // Save reasoning if present
    if (instance.reasoningBuffer) {
      instance.messages.push({ type: 'thinking', content: '', reasoning: instance.reasoningBuffer, timestamp: Date.now() });
      instance.reasoningBuffer = '';
    }

    // Create bubble if content exists but no bubble was created yet
    if (!instance.streamMsgEl && fullText) {
      this.ensureStreamBubble(instance);
    }

    if (instance.streamMsgEl) {
      instance.streamMsgEl.classList.remove('streaming');
      const content = instance.streamMsgEl.querySelector('.ai-msg-content');
      if (content) {
        content.querySelector('.ai-stream-text')?.remove();
        content.querySelector('.ai-cursor')?.remove();
        if (fullText) {
          const mdWrapper = document.createElement('div');
          const addHistory = (cmd: string) => this.addHistory(instance, cmd, 'ai');
          mdWrapper.innerHTML = renderMarkdown(fullText, instance.sessionId, addHistory);
          while (mdWrapper.firstChild) content.appendChild(mdWrapper.firstChild);
          this.bindCommandButtons(instance, content);
        }
      }
    }

    instance.streamMsgEl = null;
    instance.streamBuffer = '';

    // Store assistant message
    if (fullText) {
      instance.messages.push({ type: 'assistant', content: fullText, timestamp: Date.now() });
    }
    void this.saveConversation(instance);

    const container = instance.chatPanel?.querySelector('.ai-chat-messages');
    if (container) container.scrollTop = container.scrollHeight;
  }

  /**
   * Finalize the current thinking text *without* ending the streaming state.
   * Called when LLM returns text + tool_calls — the text is rendered into a
   * finished markdown bubble so tool cards appear below it cleanly.
   */
  private finalizeThinking(instance: AICapsuleInstance, text: string): void {
    // Collapse standalone thinking block
    this.collapseActiveThinking(instance);

    // Save reasoning + assistant text as a thinking entry
    const reasoning = instance.reasoningBuffer || undefined;
    if (reasoning || text) {
      instance.messages.push({ type: 'thinking', content: text, reasoning, timestamp: Date.now() });
    }
    instance.reasoningBuffer = '';

    // Finalize the bubble if it has content
    if (instance.streamMsgEl) {
      instance.streamMsgEl.classList.remove('streaming');
      const content = instance.streamMsgEl.querySelector('.ai-msg-content');
      if (content) {
        content.querySelector('.ai-stream-text')?.remove();
        content.querySelector('.ai-cursor')?.remove();
        if (text) {
          const mdWrapper = document.createElement('div');
          const addHistory = (cmd: string) => this.addHistory(instance, cmd, 'ai');
          mdWrapper.innerHTML = renderMarkdown(text, instance.sessionId, addHistory);
          while (mdWrapper.firstChild) content.appendChild(mdWrapper.firstChild);
          this.bindCommandButtons(instance, content);
        }
      }
    } else if (text) {
      // No bubble was created yet (reasoning-only phase), create one for the text
      const bubble = this.ensureStreamBubble(instance);
      if (bubble) {
        bubble.classList.remove('streaming');
        const content = bubble.querySelector('.ai-msg-content');
        if (content) {
          content.querySelector('.ai-cursor')?.remove();
          const mdWrapper = document.createElement('div');
          const addHistory = (cmd: string) => this.addHistory(instance, cmd, 'ai');
          mdWrapper.innerHTML = renderMarkdown(text, instance.sessionId, addHistory);
          while (mdWrapper.firstChild) content.appendChild(mdWrapper.firstChild);
          this.bindCommandButtons(instance, content);
        }
      }
    }

    instance.streamMsgEl = null;
    instance.streamBuffer = '';

    const container = instance.chatPanel?.querySelector('.ai-chat-messages');
    if (container) container.scrollTop = container.scrollHeight;
  }

  private showError(instance: AICapsuleInstance, message: string): void {
    instance.isStreaming = false;
    document.dispatchEvent(new CustomEvent('status-bar-ai', { detail: { active: false } }));
    this.updateButtonHighlight(instance);
    this.hideAgentPulse(instance);
    this.collapseActiveThinking(instance);

    if (!instance.streamMsgEl) {
      this.ensureStreamBubble(instance);
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

  // ─── Agent Tool Call UI ───────────────────────────────────────

  /** Build inline args HTML for a tool card header. */
  private static toolArgsInline(toolName: string, args: Record<string, unknown>): string {
    if (toolName === 'run_command' && args.command) {
      return `<span class="ai-tool-args-inline"><code>$ ${escapeHtml(String(args.command))}</code></span>`;
    } else if ((toolName === 'read_file' || toolName === 'write_file') && args.path) {
      return `<span class="ai-tool-args-inline"><code>${escapeHtml(String(args.path))}</code></span>`;
    } else if (toolName === 'read_terminal') {
      return `<span class="ai-tool-args-inline"><code>${args.lines ?? 50} lines</code></span>`;
    }
    return '';
  }

  /** Build a completed tool card element (for history rendering). */
  private buildToolCard(msg: Extract<ConvEntry, { type: 'tool_call' }>): HTMLDivElement {
    const card = document.createElement('div');
    card.className = 'ai-tool-card completed';
    card.dataset.tool = msg.toolName;
    const status = msg.result !== null
      ? (msg.isError ? statusIcon('error', 12) : statusIcon('success', 12))
      : statusIcon('error', 12);
    const header = document.createElement('div');
    header.className = 'ai-tool-card-header clickable';
    header.innerHTML = `
      <span class="ai-tool-icon">${toolIcon(msg.toolName, 14)}</span>
      <span class="ai-tool-name">${escapeHtml(msg.toolName)}</span>
      ${AICapsuleManagerClass.toolArgsInline(msg.toolName, msg.args)}
      <span class="ai-tool-status">${status}</span>`;
    const resultEl = document.createElement('div');
    resultEl.className = `ai-tool-result${msg.isError ? ' ai-tool-result-error' : ''}`;
    resultEl.style.display = 'none';
    const raw = msg.result ?? '';
    const truncated = raw.length > 500 ? raw.slice(0, 500) + '...' : raw;
    resultEl.innerHTML = `<pre>${escapeHtml(truncated)}</pre>`;
    header.addEventListener('click', () => {
      resultEl.style.display = resultEl.style.display === 'none' ? '' : 'none';
    });
    card.appendChild(header);
    card.appendChild(resultEl);
    return card;
  }

  /** Render an inline tool-call card in the chat panel. */
  private appendToolCallCard(
    instance: AICapsuleInstance,
    toolName: string,
    args: Record<string, unknown>,
  ): void {
    if (!instance.chatPanel) return;
    const container = instance.chatPanel.querySelector('.ai-chat-messages');
    if (!container) return;

    const card = document.createElement('div');
    card.className = 'ai-tool-card';
    card.dataset.tool = toolName;
    card.dataset.toolId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const color = TOOL_COLORS[toolName] ?? '#6B7280';

    // Header row: icon + tool name + inline args + spinner
    const header = document.createElement('div');
    header.className = 'ai-tool-card-header';
    header.innerHTML = `
      <span class="ai-tool-icon">${toolIcon(toolName, 14)}</span>
      <span class="ai-tool-name">${escapeHtml(toolName)}</span>
      ${AICapsuleManagerClass.toolArgsInline(toolName, args)}
      <span class="ai-tool-status">${spinnerIcon(color, 12)}</span>
    `;

    card.appendChild(header);
    container.appendChild(card);
    this.sinkAgentPulse(instance);
    container.scrollTop = container.scrollHeight;

    // Add run_command commands to history so they appear in the history panel
    if (toolName === 'run_command' && typeof args.command === 'string' && args.command.trim()) {
      this.addHistory(instance, args.command.trim(), 'ai');
    }

    // Persist tool call (result filled in by updateToolResultCard)
    instance.messages.push({ type: 'tool_call', toolName, args, result: null, isError: false, timestamp: Date.now() });
  }

  /** Update the most recent tool card with execution result. */
  private updateToolResultCard(
    instance: AICapsuleInstance,
    toolName: string,
    result: string,
    isError: boolean,
  ): void {
    if (!instance.chatPanel) return;
    const container = instance.chatPanel.querySelector('.ai-chat-messages');
    if (!container) return;

    // Find the last tool card matching this tool
    const cards = container.querySelectorAll<HTMLDivElement>(`.ai-tool-card[data-tool="${toolName}"]`);
    const card = cards[cards.length - 1];
    if (!card) return;

    // Update status icon
    const statusEl = card.querySelector('.ai-tool-status');
    if (statusEl) {
      statusEl.innerHTML = isError ? statusIcon('error', 12) : statusIcon('success', 12);
    }

    // Add collapsible result
    const resultEl = document.createElement('div');
    resultEl.className = `ai-tool-result ${isError ? 'ai-tool-result-error' : ''}`;
    resultEl.style.display = 'none'; // collapsed by default

    const truncated = result.length > 500 ? result.slice(0, 500) + '...' : result;
    resultEl.innerHTML = `<pre>${escapeHtml(truncated)}</pre>`;
    card.appendChild(resultEl);

    // Make header clickable to toggle result
    const header = card.querySelector('.ai-tool-card-header');
    if (header) {
      header.classList.add('clickable');
      header.addEventListener('click', () => {
        resultEl.style.display = resultEl.style.display === 'none' ? '' : 'none';
      });
    }

    card.classList.add('completed');
    container.scrollTop = container.scrollHeight;

    // Back-fill result into the last pending tool_call entry for this tool
    for (let i = instance.messages.length - 1; i >= 0; i--) {
      const e = instance.messages[i];
      if (e.type === 'tool_call' && e.toolName === toolName && e.result === null) {
        e.result = result;
        e.isError = isError;
        break;
      }
    }
  }

  /**
   * Show inline confirmation card and return a Promise.
   * Resolves with: true (approve), false (reject), or string (edited command).
   */
  private showConfirmCard(
    instance: AICapsuleInstance,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<boolean | string> {
    return new Promise((resolve) => {
      if (!instance.chatPanel) { resolve(false); return; }
      const container = instance.chatPanel.querySelector('.ai-chat-messages');
      if (!container) { resolve(false); return; }

      const card = document.createElement('div');
      card.className = 'ai-confirm-card';
      card.dataset.tool = toolName;

      const color = TOOL_COLORS[toolName] ?? '#6B7280';

      // Header
      const header = document.createElement('div');
      header.className = 'ai-confirm-header';
      header.innerHTML = `
        <span class="ai-tool-icon">${toolIcon(toolName, 14)}</span>
        <span class="ai-tool-name">${escapeHtml(toolName)}</span>
      `;

      // Command preview
      const preview = document.createElement('div');
      preview.className = 'ai-confirm-preview';
      if (toolName === 'run_command' && args.command) {
        preview.innerHTML = `<code>$ ${escapeHtml(String(args.command))}</code>`;
      } else if (toolName === 'write_file' && args.path) {
        preview.innerHTML = `<code>${escapeHtml(String(args.path))}</code>`;
      } else {
        preview.innerHTML = `<code>${escapeHtml(JSON.stringify(args, null, 2).slice(0, 200))}</code>`;
      }

      // Buttons
      const buttons = document.createElement('div');
      buttons.className = 'ai-confirm-buttons';

      const approveBtn = document.createElement('button');
      approveBtn.className = 'ai-confirm-btn ai-confirm-approve';
      approveBtn.innerHTML = `${approveIcon(12)} <span>Allow</span>`;

      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'ai-confirm-btn ai-confirm-reject';
      rejectBtn.innerHTML = `${rejectIcon(12)} <span>Reject</span>`;

      const editBtn = document.createElement('button');
      editBtn.className = 'ai-confirm-btn ai-confirm-edit';
      editBtn.innerHTML = `${editIcon(12)} <span>Edit</span>`;

      buttons.appendChild(approveBtn);
      buttons.appendChild(rejectBtn);
      if (toolName === 'run_command') {
        buttons.appendChild(editBtn);
      }

      card.appendChild(header);
      card.appendChild(preview);
      card.appendChild(buttons);
      container.appendChild(card);
      container.scrollTop = container.scrollHeight;

      // Button handlers
      const cleanup = () => {
        card.classList.add('resolved');
        approveBtn.disabled = true;
        rejectBtn.disabled = true;
        editBtn.disabled = true;
      };

      approveBtn.addEventListener('click', () => {
        cleanup();
        card.querySelector('.ai-confirm-header')!.innerHTML += ` <span class="ai-confirm-resolved">${statusIcon('success', 10)} Approved</span>`;
        resolve(true);
      });

      rejectBtn.addEventListener('click', () => {
        cleanup();
        card.querySelector('.ai-confirm-header')!.innerHTML += ` <span class="ai-confirm-resolved">${statusIcon('error', 10)} Rejected</span>`;
        resolve(false);
      });

      editBtn.addEventListener('click', () => {
        // Show inline editor
        const cmd = String(args.command || '');
        const editorDiv = document.createElement('div');
        editorDiv.className = 'ai-confirm-editor';
        const editInput = document.createElement('input');
        editInput.type = 'text';
        editInput.className = 'ai-confirm-edit-input';
        editInput.value = cmd;
        const confirmEditBtn = document.createElement('button');
        confirmEditBtn.className = 'ai-confirm-btn ai-confirm-approve';
        confirmEditBtn.innerHTML = `${approveIcon(12)} <span>Run</span>`;
        editorDiv.appendChild(editInput);
        editorDiv.appendChild(confirmEditBtn);
        preview.replaceWith(editorDiv);
        editInput.focus();

        const runEdited = () => {
          cleanup();
          card.querySelector('.ai-confirm-header')!.innerHTML += ` <span class="ai-confirm-resolved">${statusIcon('success', 10)} Edited</span>`;
          resolve(editInput.value);
        };

        confirmEditBtn.addEventListener('click', runEdited);
        editInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') runEdited();
          e.stopPropagation();
        });
      });
    });
  }

  /** Insert a system notice (e.g. trust level change, degradation). */
  private appendSystemNotice(instance: AICapsuleInstance, text: string): void {
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

  /** Create the trust-level quick switcher button for the AI bar. */
  private createTrustSwitcher(): HTMLDivElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-bar-trust-switcher';

    const settings = loadSettings();
    const level = settings.aiAgentTrustLevel ?? 0;

    const btn = document.createElement('button');
    btn.className = 'ai-bar-btn ai-bar-btn-trust';
    btn.title = `Trust Level ${level}`;
    btn.innerHTML = shieldIcon(level, 16);
    btn.dataset.level = String(level);

    const dropdown = document.createElement('div');
    dropdown.className = 'ai-trust-dropdown';
    dropdown.style.display = 'none';

    const labels = [
      { value: 0, label: t('aiAgentTrustManual'), color: TRUST_COLORS[0] },
      { value: 1, label: t('aiAgentTrustSemiAuto'), color: TRUST_COLORS[1] },
      { value: 2, label: t('aiAgentTrustFullAuto'), color: TRUST_COLORS[2] },
    ];

    const buildDropdown = () => {
      const currentLevel = loadSettings().aiAgentTrustLevel ?? 0;
      dropdown.innerHTML = '';
      for (const l of labels) {
        const item = document.createElement('div');
        item.className = `ai-trust-item ${l.value === currentLevel ? 'active' : ''}`;
        item.innerHTML = `${shieldIcon(l.value, 14)} <span>${escapeHtml(l.label)}</span>`;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const s = loadSettings();
          s.aiAgentTrustLevel = l.value;
          saveSettings(s);
          btn.innerHTML = shieldIcon(l.value, 16);
          btn.dataset.level = String(l.value);
          btn.title = `Trust Level ${l.value}`;
          dropdown.style.display = 'none';
          wrapper.classList.remove('open');
          // Notify all open capsules
          for (const [, inst] of this.capsules) {
            this.appendSystemNotice(inst,
              `── Trust level changed to Level ${l.value} ──`);
          }
        });
        dropdown.appendChild(item);
      }
    };

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dropdown.style.display !== 'none';
      if (isOpen) {
        dropdown.style.display = 'none';
        wrapper.classList.remove('open');
      } else {
        buildDropdown();
        dropdown.style.display = '';
        wrapper.classList.add('open');
      }
    });

    document.addEventListener('click', () => {
      dropdown.style.display = 'none';
      wrapper.classList.remove('open');
    });

    wrapper.appendChild(btn);
    wrapper.appendChild(dropdown);
    return wrapper;
  }

  private static readonly DANGER_PATTERNS = [
    /\brm\s+(-[^\s]*\s+)*-[^\s]*r/,   // rm -r, rm -rf, rm -fr, etc.
    /\brm\s+(-[^\s]*\s+)*\//, // rm /path (root-level deletes)
    /\bmkfs\b/,
    /\bdd\s+/,
    /\b(shutdown|reboot|poweroff|halt)\b/,
    /\bsystemctl\s+(stop|disable|mask)\b/,
    /\bkill\s+-9/,
    /\bkillall\b/,
    /\bpkill\b/,
    /\bchmod\s+(-[^\s]*\s+)*[0-7]*0{2}/,  // chmod 000, 700 etc wide perms
    /\bchown\s+-R/,
    /\bchmod\s+-R/,
    /\b>\s*\/dev\/sd/,
    /\bdrop\s+(database|table|schema)\b/i,
    /\btruncate\s+table\b/i,
    /\bdelete\s+from\b/i,
    /\bformat\b/,
    /\bnewfs\b/,
    /\bdiskutil\s+erase/,
    /\bsudo\b/,
    /\bgit\s+push\s+.*--force/,
    /\bgit\s+reset\s+--hard/,
    /\bgit\s+clean\s+-[^\s]*f/,
    /\biptables\s+-F/,
    /\b:(){ :\|:& };:/,  // fork bomb
  ];

  private isDangerousCommand(cmd: string): boolean {
    return AICapsuleManagerClass.DANGER_PATTERNS.some((p) => p.test(cmd));
  }

  private confirmDangerousCommand(cmd: string): Promise<boolean> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'ai-danger-overlay';

      const dialog = document.createElement('div');
      dialog.className = 'ai-danger-dialog';

      const title = document.createElement('div');
      title.className = 'ai-danger-title';
      title.textContent = t('aiDangerConfirmTitle');

      const msg = document.createElement('div');
      msg.className = 'ai-danger-msg';
      msg.textContent = t('aiDangerConfirmMsg');

      const cmdPreview = document.createElement('pre');
      cmdPreview.className = 'ai-danger-cmd';
      cmdPreview.textContent = cmd;

      const actions = document.createElement('div');
      actions.className = 'ai-danger-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ai-danger-btn ai-danger-btn-cancel';
      cancelBtn.textContent = t('aiDangerConfirmCancel');

      const runBtn = document.createElement('button');
      runBtn.className = 'ai-danger-btn ai-danger-btn-run';
      runBtn.textContent = t('aiDangerConfirmRun');

      const close = (result: boolean) => {
        overlay.remove();
        resolve(result);
      };

      cancelBtn.addEventListener('click', () => close(false));
      runBtn.addEventListener('click', () => close(true));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });

      actions.appendChild(cancelBtn);
      actions.appendChild(runBtn);
      dialog.appendChild(title);
      dialog.appendChild(msg);
      dialog.appendChild(cmdPreview);
      dialog.appendChild(actions);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      cancelBtn.focus();
    });
  }

  private bindCommandButtons(instance: AICapsuleInstance, container: Element): void {
    // Run buttons
    container.querySelectorAll<HTMLButtonElement>('.ai-cmd-run').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cmd = btn.dataset.cmd ?? '';
        const sid = btn.dataset.session ?? instance.sessionId;

        const executeCmd = () => {
          TerminalRegistry.sendCommand(sid, cmd);
          this.addHistory(instance, cmd, 'ai');
          btn.textContent = '\u2713';
          btn.classList.add('cmd-executed');
          setTimeout(() => {
            btn.textContent = t('aiRunCommand');
            btn.classList.remove('cmd-executed');
          }, 1500);
        };

        if (this.isDangerousCommand(cmd)) {
          void this.confirmDangerousCommand(cmd).then((confirmed) => {
            if (confirmed) executeCmd();
          });
        } else {
          executeCmd();
        }
      });
    });

    // Copy buttons
    container.querySelectorAll<HTMLButtonElement>('.ai-cmd-copy').forEach((btn) => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.code ?? '';
        void clipboardWriteText(code);
        btn.textContent = '\u2713';
        btn.classList.add('cmd-copied');
        setTimeout(() => {
          btn.textContent = t('aiCopyCode');
          btn.classList.remove('cmd-copied');
        }, 1200);
      });
    });
  }

  // ─── Chat Bubble Context Menu ─────────────────────────────────

  /** Attach context-menu handler to the messages container (event delegation). */
  private bindChatContextMenu(instance: AICapsuleInstance, container?: Element): void {
    const el = container ?? instance.chatPanel?.querySelector('.ai-chat-messages');
    if (!el) return;
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation(); // Prevent global handler from interfering
      const target = e.target as HTMLElement;

      // Find closest message bubble or tool card
      const bubble = target.closest('.ai-msg') as HTMLElement | null;
      const toolCard = target.closest('.ai-tool-card') as HTMLElement | null;
      const thinkingBlock = target.closest('.ai-thinking-block') as HTMLElement | null;

      if (!bubble && !toolCard && !thinkingBlock) return;

      // Determine raw text for copying
      let rawText = '';
      let msgIndex = -1;
      let isUser = false;

      if (bubble) {
        const content = bubble.querySelector('.ai-msg-content');
        rawText = content?.textContent ?? '';
        isUser = bubble.classList.contains('ai-msg-user');
        // Find matching message index
        const allMsgs = Array.from(el.querySelectorAll('.ai-msg, .ai-tool-card, .ai-thinking-block'));
        const pos = allMsgs.indexOf(bubble);
        msgIndex = this.resolveMessageIndex(instance, allMsgs, pos);
      } else if (toolCard) {
        const resultEl = toolCard.querySelector('.ai-tool-result pre');
        const argsEl = toolCard.querySelector('.ai-tool-args-inline code');
        rawText = resultEl?.textContent ?? argsEl?.textContent ?? '';
        const allMsgs = Array.from(el.querySelectorAll('.ai-msg, .ai-tool-card, .ai-thinking-block'));
        const pos = allMsgs.indexOf(toolCard);
        msgIndex = this.resolveMessageIndex(instance, allMsgs, pos);
      } else if (thinkingBlock) {
        const textEl = thinkingBlock.querySelector('.ai-reasoning-text');
        rawText = textEl?.textContent ?? '';
        const allMsgs = Array.from(el.querySelectorAll('.ai-msg, .ai-tool-card, .ai-thinking-block'));
        const pos = allMsgs.indexOf(thinkingBlock);
        msgIndex = this.resolveMessageIndex(instance, allMsgs, pos);
      }

      // Build menu items
      type MenuItem = { label: string; action: () => void; disabled?: boolean } | 'divider';
      const items: MenuItem[] = [];

      // Copy selected text (if any text is selected within the bubble)
      const selection = window.getSelection();
      const hasSelection = selection && selection.toString().trim().length > 0;

      if (hasSelection) {
        items.push({ label: t('aiCtxCopy'), action: () => void clipboardWriteText(selection!.toString()) });
      } else if (toolCard) {
        // Tool card: copy result if available
        const resultEl = toolCard.querySelector('.ai-tool-result pre');
        if (resultEl?.textContent) {
          items.push({ label: t('aiCtxCopyResult'), action: () => void clipboardWriteText(resultEl.textContent ?? '') });
        }
        const argsEl = toolCard.querySelector('.ai-tool-args-inline code');
        if (argsEl?.textContent) {
          items.push({ label: t('aiCtxCopy'), action: () => void clipboardWriteText(argsEl.textContent ?? '') });
        }
      } else if (rawText) {
        items.push({ label: t('aiCtxCopy'), action: () => void clipboardWriteText(rawText) });
      }

      // Resend (user messages only)
      if (isUser && rawText && !instance.isStreaming) {
        if (items.length > 0) items.push('divider');
        items.push({
          label: t('aiCtxResend'),
          action: () => {
            const input = instance.element.querySelector('.ai-bar-input') as HTMLInputElement | null;
            if (input) {
              input.value = rawText;
              input.focus();
            }
          },
        });
      }

      // Delete message
      if (msgIndex >= 0 && !instance.isStreaming) {
        if (items.length > 0) items.push('divider');
        items.push({
          label: t('aiCtxDelete'),
          action: () => {
            instance.messages.splice(msgIndex, 1);
            // Remove DOM element
            if (bubble) bubble.remove();
            else if (toolCard) toolCard.remove();
            else if (thinkingBlock) thinkingBlock.remove();
            void this.saveConversation(instance);
          },
        });
      }

      if (items.length === 0) return;
      this.showBubbleContextMenu(e as MouseEvent, items);
    });
  }

  /** Map a DOM position index to the corresponding messages[] index. */
  private resolveMessageIndex(instance: AICapsuleInstance, domNodes: Element[], domPos: number): number {
    // Walk the messages array, counting rendered elements to match domPos.
    let rendered = 0;
    for (let i = 0; i < instance.messages.length; i++) {
      const msg = instance.messages[i];
      if (msg.type === 'thinking') {
        // A thinking entry can produce 1-2 DOM elements (reasoning block + content bubble)
        if (msg.reasoning) { if (rendered === domPos) return i; rendered++; }
        if (msg.content) { if (rendered === domPos) return i; rendered++; }
        if (!msg.reasoning && !msg.content) { rendered++; }
      } else {
        if (rendered === domPos) return i;
        rendered++;
      }
    }
    return -1;
  }

  /** Show a context menu at mouse position with given items. */
  private showBubbleContextMenu(e: MouseEvent, items: ({ label: string; action: () => void; disabled?: boolean } | 'divider')[]): void {
    // Remove any existing menu
    document.querySelector('.ai-bubble-ctx-menu')?.remove();

    const menu = document.createElement('div');
    menu.className = 'custom-context-menu ai-bubble-ctx-menu';

    for (const item of items) {
      if (item === 'divider') {
        const div = document.createElement('div');
        div.className = 'custom-context-menu-divider';
        menu.appendChild(div);
        continue;
      }
      const btn = document.createElement('button');
      btn.className = 'custom-context-menu-item';
      btn.textContent = item.label;
      if (item.disabled) btn.disabled = true;
      btn.addEventListener('click', () => {
        menu.remove();
        item.action();
      });
      menu.appendChild(btn);
    }

    // Position
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    document.body.appendChild(menu);

    // Adjust if menu overflows viewport
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
      if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;
    });

    // Close on outside click / Escape
    const close = (ev: Event) => {
      if (ev.type === 'keydown' && (ev as KeyboardEvent).key !== 'Escape') return;
      menu.remove();
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', close);
    };
    // Delay to prevent immediate close from the contextmenu event
    setTimeout(() => {
      document.addEventListener('click', close);
      document.addEventListener('keydown', close);
    }, 0);
  }

  // ─── Terminal command capture ──────────────────────────────────

  private startTerminalCapture(instance: AICapsuleInstance): void {
    instance.lineBuffer = '';
    let escState: 'none' | 'esc' | 'csi' | 'ss3' | 'str_seq' | 'str_esc' = 'none';

    instance.unsubInput = TerminalRegistry.onInput(instance.sessionId, (data) => {
      for (const ch of data) {
        const code = ch.charCodeAt(0);

        // Inside a string-type sequence (OSC/DCS/APC/PM/SOS): wait for ST or BEL
        if (escState === 'str_seq') {
          if (ch === '\x07') { escState = 'none'; }          // BEL terminates
          else if (ch === '\x1b') { escState = 'str_esc'; }  // possible ST (ESC \)
          continue;
        }
        if (escState === 'str_esc') {
          escState = ch === '\\' ? 'none' : 'str_seq';       // ST complete or continue
          continue;
        }
        if (escState === 'esc') {
          if (ch === '[') { escState = 'csi'; }
          else if (ch === 'O') { escState = 'ss3'; }
          else if (ch === ']' || ch === 'P' || ch === 'X' || ch === '^' || ch === '_') { escState = 'str_seq'; } // OSC ] / DCS P / SOS X / PM ^ / APC _
          else { escState = 'none'; }
          continue;
        }
        if (escState === 'csi') {
          if (code >= 0x40 && code <= 0x7E) escState = 'none';
          continue;
        }
        if (escState === 'ss3') { escState = 'none'; continue; }

        if (ch === '\x1b') { escState = 'esc'; continue; }

        if (ch === '\r' || ch === '\n') {
          const cmd = instance.lineBuffer.trim();
          if (cmd) this.addHistory(instance, cmd, 'manual');
          instance.lineBuffer = '';
        } else if (ch === '\x7f' || ch === '\b') {
          instance.lineBuffer = instance.lineBuffer.slice(0, -1);
        } else if (ch === '\x15') {
          instance.lineBuffer = '';
        } else if (ch === '\x03') {
          instance.lineBuffer = '';
        } else if (code >= 32) {
          instance.lineBuffer += ch;
        }
      }
    });
  }

  // ─── History management ────────────────────────────────────────

  private getHistoryKey(sessionId: string): string {
    const info = DrawerManager.getServerInfo(sessionId);
    if (info) return `${info.username}@${info.host}:${info.port}`;
    return 'local';
  }

  private storageKey(historyKey: string): string {
    return `${HISTORY_STORAGE_KEY}:${historyKey}`;
  }

  private loadHistory(historyKey: string): HistoryEntry[] {
    try {
      const stored = localStorage.getItem(this.storageKey(historyKey));
      if (stored) return JSON.parse(stored) as HistoryEntry[];
    } catch { /* ignore */ }
    return [];
  }

  private saveHistory(historyKey: string, history: HistoryEntry[]): void {
    try {
      localStorage.setItem(this.storageKey(historyKey), JSON.stringify(history));
    } catch { /* ignore */ }
  }

  private addHistory(instance: AICapsuleInstance, command: string, source: 'manual' | 'ai'): void {
    instance.history = instance.history.filter((h) => h.command !== command);
    instance.history.unshift({ command, timestamp: Date.now(), source });
    if (instance.history.length > MAX_HISTORY) instance.history.length = MAX_HISTORY;
    this.saveHistory(instance.historyKey, instance.history);
    this.capsules.forEach((other) => {
      if (other !== instance && other.historyKey === instance.historyKey) {
        other.history = instance.history;
      }
    });
    if (instance.historyOpen) this.renderHistoryPanel(instance);
  }

  // 模糊匹配：query 中的每个空格分隔的关键词都须在 text 中出现（不区分大小写）
  private fuzzyMatch(text: string, query: string): boolean {
    const lower = text.toLowerCase();
    return query.toLowerCase().split(/\s+/).filter(Boolean).every(kw => lower.includes(kw));
  }

  // 切换输入框到搜索模式
  private enterSearchMode(instance: AICapsuleInstance, placeholder: string, onInput: () => void): void {
    const input = instance.element.querySelector('.ai-bar-input') as HTMLInputElement;
    if (!input) return;
    const sid = instance.sessionId;
    this._savedPlaceholder.set(sid, input.placeholder);
    this._savedInputValue.set(sid, input.value);
    input.value = '';
    input.placeholder = placeholder;
    input.classList.add('searching');
    input.addEventListener('input', onInput);
    this._filterListener.set(sid, onInput);
  }

  // 退出搜索模式，恢复输入框
  private exitSearchMode(instance: AICapsuleInstance): void {
    const input = instance.element.querySelector('.ai-bar-input') as HTMLInputElement;
    if (!input) return;
    const sid = instance.sessionId;
    const listener = this._filterListener.get(sid);
    if (listener) {
      input.removeEventListener('input', listener);
      this._filterListener.delete(sid);
    }
    input.value = this._savedInputValue.get(sid) ?? '';
    input.placeholder = this._savedPlaceholder.get(sid) ?? t('aiPlaceholderInput');
    input.classList.remove('searching');
    this._savedPlaceholder.delete(sid);
    this._savedInputValue.delete(sid);
  }

  private formatRelativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 5) return t('aiTimeJustNow');
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d`;
    const months = Math.floor(days / 30);
    return `${months}mo`;
  }

  private renderHistoryPanel(instance: AICapsuleInstance, filter?: string): void {
    const panel = instance.element.querySelector('.ai-bar-history-panel') as HTMLDivElement;
    if (!panel) return;

    panel.innerHTML = '';

    const filtered = filter
      ? instance.history.filter(e => this.fuzzyMatch(e.command, filter))
      : instance.history;

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ai-history-empty';
      empty.textContent = filter ? t('aiHistoryEmpty') : t('aiHistoryEmpty');
      panel.appendChild(empty);
      return;
    }

    filtered.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'ai-history-row';
      row.title = entry.command;

      const cmdSpan = document.createElement('span');
      cmdSpan.className = 'ai-history-cmd';
      cmdSpan.textContent = entry.command;

      const meta = document.createElement('span');
      meta.className = 'ai-history-meta';
      const relTime = this.formatRelativeTime(entry.timestamp);
      const sourceLabel = entry.source === 'ai' ? 'AI' : t('aiSourceManual');
      meta.textContent = `${relTime} \u00B7 ${sourceLabel}`;

      const copyBtn = document.createElement('button');
      copyBtn.className = 'ai-history-copy';
      copyBtn.title = t('aiCopyCommand');
      copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M5 11H3.5A1.5 1.5 0 012 9.5v-7A1.5 1.5 0 013.5 1h7A1.5 1.5 0 0112 2.5V5"/></svg>`;
      copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void clipboardWriteText(entry.command);
        copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 8.5 6.5 12 13 4"/></svg>`;
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M5 11H3.5A1.5 1.5 0 012 9.5v-7A1.5 1.5 0 013.5 1h7A1.5 1.5 0 0112 2.5V5"/></svg>`;
          copyBtn.classList.remove('copied');
        }, 1200);
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'ai-history-delete';
      delBtn.title = t('aiChatDeleteConfirmOk');
      delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`;
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.handleDeleteHistoryEntry(instance, entry);
      });

      row.appendChild(cmdSpan);
      row.appendChild(meta);
      row.appendChild(copyBtn);
      row.appendChild(delBtn);

      row.addEventListener('click', () => {
        // 将选中的命令设为"恢复值"，关闭弹窗时会写入输入框
        this._savedInputValue.set(instance.sessionId, entry.command);
        this.closeHistory(instance);
        const input = instance.element.querySelector('.ai-bar-input') as HTMLInputElement;
        if (input) input.focus();
      });

      panel.appendChild(row);
    });
  }

  private async handleDeleteHistoryEntry(instance: AICapsuleInstance, entry: HistoryEntry): Promise<void> {
    const now = Date.now();
    if (now < this._deleteSkipUntil) {
      this.removeHistoryEntry(instance, entry);
      return;
    }
    const confirmed = await this.confirmDeleteConversation();
    if (confirmed) {
      this.removeHistoryEntry(instance, entry);
    }
  }

  private removeHistoryEntry(instance: AICapsuleInstance, entry: HistoryEntry): void {
    instance.history = instance.history.filter((h) => h !== entry);
    this.saveHistory(instance.historyKey, instance.history);
    // Sync to other instances with same historyKey
    this.capsules.forEach((other) => {
      if (other !== instance && other.historyKey === instance.historyKey) {
        other.history = instance.history;
      }
    });
    if (instance.historyOpen) this.renderHistoryPanel(instance);
  }

  private toggleHistory(instance: AICapsuleInstance): void {
    if (instance.historyOpen) {
      this.closeHistory(instance);
    } else {
      this.openHistory(instance);
    }
  }

  private openHistory(instance: AICapsuleInstance): void {
    this.closeChatHistory(instance); // 互斥
    instance.historyOpen = true;
    const panel = instance.element.querySelector('.ai-bar-history-panel') as HTMLDivElement;
    const btn = instance.element.querySelector('.ai-bar-btn-history') as HTMLButtonElement;
    if (panel) {
      this.renderHistoryPanel(instance);
      panel.style.display = '';
    }
    if (btn) btn.classList.add('active');
    // 进入搜索模式
    this.enterSearchMode(instance, t('aiSearchHistory'), () => {
      const input = instance.element.querySelector('.ai-bar-input') as HTMLInputElement;
      this.renderHistoryPanel(instance, input?.value || '');
    });
  }

  private closeHistory(instance: AICapsuleInstance): void {
    if (!instance.historyOpen) return;
    instance.historyOpen = false;
    const panel = instance.element.querySelector('.ai-bar-history-panel') as HTMLDivElement;
    const btn = instance.element.querySelector('.ai-bar-btn-history') as HTMLButtonElement;
    if (panel) panel.style.display = 'none';
    if (btn) btn.classList.remove('active');
    this.exitSearchMode(instance);
  }

  // ─── Input handling ────────────────────────────────────────────

  private setupInput(instance: AICapsuleInstance): void {
    const input = instance.element.querySelector('.ai-bar-input') as HTMLInputElement;
    const termBtn = instance.element.querySelector('.ai-bar-btn-term') as HTMLButtonElement;
    const llmBtn = instance.element.querySelector('.ai-bar-btn-llm') as HTMLButtonElement;

    const sendToTerminal = () => {
      const text = input.value.trim();
      if (!text) return;
      TerminalRegistry.sendCommand(instance.sessionId, text);
      this.addHistory(instance, text, 'manual');
      input.value = '';
    };

    const sendToLLM = () => {
      const text = input.value.trim();
      if (!text) return;

      // Check if AI is configured
      const settings = loadSettings();
      const resolved = resolveActiveModel(settings.aiProviders, settings.aiActiveModel);
      if (!resolved) {
        this.openChat(instance);
        this.showNoConfigHint(instance);
        return;
      }

      // Open chat panel and send
      this.openChat(instance);
      this.appendUserMessage(instance, text);
      instance.messages.push({ type: 'user', content: text, timestamp: Date.now() });
      this.updateChatTitle(instance);
      void this.saveConversation(instance);
      input.value = '';

      // Start streaming
      instance.isStreaming = true;
      instance.streamBuffer = '';
      document.dispatchEvent(new CustomEvent('status-bar-ai', { detail: { active: true } }));
      this.updateButtonHighlight(instance);
      this.beginAssistantMessage(instance);
      this.showAgentPulse(instance);

      const agentCallbacks: AgentCallbacks = {
        onToken: (token) => this.appendStreamToken(instance, token),
        onReasoning: (token) => this.appendReasoningToken(instance, token),
        onComplete: (fullText) => this.finalizeMessage(instance, fullText),
        onError: (err) => this.showError(instance, err.message),
        onThinkingComplete: (text) => {
          // Finalize thinking block + bubble before tool call cards appear.
          this.finalizeThinking(instance, text);
        },
        onIterationStart: () => {
          // New agentic iteration — create a fresh assistant message bubble
          instance.streamBuffer = '';
          this.beginAssistantMessage(instance);
        },
        onToolCall: (toolName, args) => this.appendToolCallCard(instance, toolName, args),
        onToolResult: (toolName, result, isError) => this.updateToolResultCard(instance, toolName, result, isError),
        onConfirmRequired: (toolName, args) => this.showConfirmCard(instance, toolName, args),
        onAborted: (_steps) => {
          this.collapseActiveThinking(instance);
          instance.reasoningBuffer = '';
          if (instance.streamMsgEl && instance.streamBuffer) {
            this.finalizeMessage(instance, instance.streamBuffer);
          } else {
            instance.isStreaming = false;
            document.dispatchEvent(new CustomEvent('status-bar-ai', { detail: { active: false } }));
            this.updateButtonHighlight(instance);
            this.hideAgentPulse(instance);
            instance.streamMsgEl = null;
            instance.streamBuffer = '';
          }
        },
        onDegraded: (reason) => this.appendSystemNotice(instance, reason),
      };
      instance.agent.send(text, instance.sessionId, agentCallbacks);
    };

    termBtn.addEventListener('click', sendToTerminal);
    llmBtn.addEventListener('click', () => {
      if (instance.isStreaming) {
        // Streaming active → abort
        instance.agent.abort();
        this.collapseActiveThinking(instance);
        instance.reasoningBuffer = '';
        if (instance.streamMsgEl && instance.streamBuffer) {
          this.finalizeMessage(instance, instance.streamBuffer);
        } else {
          instance.isStreaming = false;
          instance.streamMsgEl = null;
          instance.streamBuffer = '';
          this.updateButtonHighlight(instance);
          this.hideAgentPulse(instance);
          document.dispatchEvent(new CustomEvent('status-bar-ai', { detail: { active: false } }));
        }
      } else {
        sendToLLM();
      }
    });

    // Right-click on LLM button: restore minimized chat
    llmBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (instance.chatMinimized) {
        this.openChat(instance);
      }
    });

    input.addEventListener('keydown', (e) => {
      // IME guard: keyCode 229 means the key event is being handled by the
      // input method editor (composition in progress). Ignore it entirely so
      // that Enter confirms the IME candidate instead of sending the message.
      if (e.keyCode === 229) return;

      // 弹窗搜索模式下拦截 Enter/Escape
      if (instance.historyOpen || instance.chatHistoryOpen) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (instance.historyOpen) {
            // 选中筛选后的第一条
            const query = input.value.trim();
            const match = query
              ? instance.history.find(h => this.fuzzyMatch(h.command, query))
              : instance.history[0];
            if (match) {
              this._savedInputValue.set(instance.sessionId, match.command);
            }
            this.closeHistory(instance);
          } else if (instance.chatHistoryOpen) {
            this.closeChatHistory(instance);
          }
          input.focus();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          if (instance.historyOpen) this.closeHistory(instance);
          if (instance.chatHistoryOpen) this.closeChatHistory(instance);
          input.focus();
          e.stopPropagation();
          return;
        }
        e.stopPropagation();
        return;
      }

      if (e.key === 'Enter') {
        if (e.ctrlKey || e.metaKey) {
          sendToLLM();
        } else if (instance.chatOpen || instance.chatMinimized) {
          // When chat is open or minimized, Enter sends to LLM
          sendToLLM();
        } else {
          sendToTerminal();
        }
        e.preventDefault();
      }
      if (e.key === 'Escape') {
        if (instance.isStreaming) {
          instance.agent.abort();
          instance.isStreaming = false;
          this.updateButtonHighlight(instance);
          if (instance.streamMsgEl) {
            instance.streamMsgEl.classList.remove('streaming');
            // Finalize whatever we have so far
            if (instance.streamBuffer) {
              this.finalizeMessage(instance, instance.streamBuffer);
            }
          }
          document.dispatchEvent(new CustomEvent('status-bar-ai', { detail: { active: false } }));
        } else if (instance.chatOpen) {
          this.minimizeChat(instance);
        }
        this.closeHistory(instance);
      }
      e.stopPropagation();
    });

    input.addEventListener('keyup', (e) => e.stopPropagation());
    input.addEventListener('keypress', (e) => e.stopPropagation());
  }

  private showNoConfigHint(instance: AICapsuleInstance): void {
    if (!instance.chatPanel) return;
    const container = instance.chatPanel.querySelector('.ai-chat-messages');
    if (!container) return;

    const msg = document.createElement('div');
    msg.className = 'ai-msg ai-msg-system';
    const content = document.createElement('div');
    content.className = 'ai-msg-content ai-msg-hint';
    content.textContent = t('aiNoConfig');
    msg.appendChild(content);
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
  }

  private setupHistory(instance: AICapsuleInstance): void {
    const histBtn = instance.element.querySelector('.ai-bar-btn-history') as HTMLButtonElement;
    histBtn.addEventListener('click', () => this.toggleHistory(instance));

    document.addEventListener('click', (e) => {
      if (!instance.historyOpen) return;
      const target = e.target as HTMLElement;
      if (!instance.element.contains(target)) {
        this.closeHistory(instance);
      }
    });
  }

  private setupDrawerToggle(instance: AICapsuleInstance): void {
    const btn = instance.element.querySelector('.ai-bar-btn-drawer');
    if (!btn) return;
    btn.addEventListener('click', () => {
      this.closeHistory(instance);
      DrawerManager.toggle(instance.sessionId);
    });
  }

  // ─── Chat Persistence ─────────────────────────────────────────

  private static readonly CHAT_DIR = 'chat-history';
  private static readonly FS_OPTS = { baseDir: BaseDirectory.AppData };

  private async ensureChatDir(): Promise<void> {
    if (this._chatHistoryDir) return;
    if (!(await exists(AICapsuleManagerClass.CHAT_DIR, AICapsuleManagerClass.FS_OPTS))) {
      await mkdir(AICapsuleManagerClass.CHAT_DIR, { recursive: true, ...AICapsuleManagerClass.FS_OPTS });
    }
    this._chatHistoryDir = AICapsuleManagerClass.CHAT_DIR;
  }

  private async saveConversation(instance: AICapsuleInstance, snapshot?: { id: string; messages: ConvEntry[] }): Promise<void> {
    const id = snapshot?.id ?? instance.currentConversationId;
    const msgs = snapshot?.messages ?? instance.messages;
    if (msgs.length === 0) return;
    try {
      await this.ensureChatDir();
      const firstUser = msgs.find(m => m.type === 'user');
      const conv: ChatConversation = {
        id,
        title: firstUser ? firstUser.content.slice(0, 80) : 'Untitled',
        messages: msgs,
        createdAt: msgs[0]?.timestamp || Date.now(),
        updatedAt: Date.now(),
      };
      const safeId = conv.id.replace(/[^a-zA-Z0-9_-]/g, '');
      if (!safeId) return;
      const filePath = `${AICapsuleManagerClass.CHAT_DIR}/${safeId}.json`;
      await writeTextFile(filePath, JSON.stringify(conv), AICapsuleManagerClass.FS_OPTS);
      // debug: console.log('[chat-history] saved:', filePath, conv.messages.length);
    } catch (e) {
      console.error('[chat-history] save failed:', e);
    }
  }

  private async loadConversations(): Promise<ChatConversation[]> {
    try {
      await this.ensureChatDir();
      const entries = await readDir(AICapsuleManagerClass.CHAT_DIR, AICapsuleManagerClass.FS_OPTS);
      // debug: console.log('[chat-history] entries:', entries.length);
      const convs: ChatConversation[] = [];
      for (const entry of entries) {
        if (!entry.name?.endsWith('.json')) continue;
        // Only allow safe filenames (no path separators)
        if (/[/\\]/.test(entry.name)) continue;
        try {
          const content = await readTextFile(`${AICapsuleManagerClass.CHAT_DIR}/${entry.name}`, AICapsuleManagerClass.FS_OPTS);
          const raw = JSON.parse(content) as ChatConversation;
          // Migrate old format: { role, content } → { type, content }
          if (raw.messages?.length && 'role' in raw.messages[0]) {
            raw.messages = (raw.messages as unknown as { role: string; content: string; timestamp: number }[])
              .map(m => ({ type: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant', content: m.content, timestamp: m.timestamp }));
          }
          convs.push(raw);
        } catch (e) { console.error('[chat-history] read failed:', entry.name, e); }
      }
      convs.sort((a, b) => b.updatedAt - a.updatedAt);
      return convs;
    } catch (e) { console.error('[chat-history] load failed:', e); return []; }
  }

  private async deleteConversation(id: string): Promise<void> {
    // Sanitize id to prevent path traversal
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe) return;
    try {
      await this.ensureChatDir();
      await remove(`${AICapsuleManagerClass.CHAT_DIR}/${safe}.json`, AICapsuleManagerClass.FS_OPTS);
    } catch { /* ignore */ }
  }

  // ─── Chat History Panel ──────────────────────────────────────

  private setupChatHistory(instance: AICapsuleInstance): void {
    const btn = instance.element.querySelector('.ai-bar-btn-chat-history') as HTMLButtonElement;
    if (!btn) return;
    btn.addEventListener('click', () => this.toggleChatHistory(instance));

    document.addEventListener('click', (e) => {
      if (!instance.chatHistoryOpen) return;
      const target = e.target as HTMLElement;
      if (!instance.element.contains(target)) {
        this.closeChatHistory(instance);
      }
    });
  }

  private toggleChatHistory(instance: AICapsuleInstance): void {
    if (instance.chatHistoryOpen) {
      this.closeChatHistory(instance);
    } else {
      this.openChatHistory(instance);
    }
  }

  // 缓存已加载的对话列表，用于搜索筛选
  private _cachedConversations = new Map<string, ChatConversation[]>();

  private openChatHistory(instance: AICapsuleInstance): void {
    this.closeHistory(instance);
    instance.chatHistoryOpen = true;
    const btn = instance.element.querySelector('.ai-bar-btn-chat-history') as HTMLButtonElement;
    if (btn) btn.classList.add('active');

    let panel = instance.element.querySelector('.ai-bar-chat-history-panel') as HTMLDivElement;
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'ai-bar-chat-history-panel';
      instance.element.appendChild(panel);
    }
    panel.style.display = '';
    instance.chatHistoryPanel = panel;
    this.renderChatHistoryList(instance);
    // 进入搜索模式
    this.enterSearchMode(instance, t('aiSearchChatHistory'), () => {
      const input = instance.element.querySelector('.ai-bar-input') as HTMLInputElement;
      const query = input?.value || '';
      const cached = this._cachedConversations.get(instance.sessionId);
      if (cached) {
        this.renderChatHistoryListFromCache(instance, cached, query);
      }
    });
  }

  private closeChatHistory(instance: AICapsuleInstance): void {
    if (!instance.chatHistoryOpen) return;
    instance.chatHistoryOpen = false;
    const panel = instance.element.querySelector('.ai-bar-chat-history-panel') as HTMLDivElement;
    const btn = instance.element.querySelector('.ai-bar-btn-chat-history') as HTMLButtonElement;
    if (panel) panel.style.display = 'none';
    if (btn) btn.classList.remove('active');
    this._cachedConversations.delete(instance.sessionId);
    this.exitSearchMode(instance);
  }

  private async renderChatHistoryList(instance: AICapsuleInstance): Promise<void> {
    const panel = instance.element.querySelector('.ai-bar-chat-history-panel') as HTMLDivElement;
    if (!panel) return;

    panel.innerHTML = `<div class="ai-chat-hist-header"><span class="ai-chat-hist-title">${t('aiChatHistoryTitle')}</span></div><div class="ai-chat-hist-loading" style="padding:12px;text-align:center;color:var(--text-muted);font-size:12px;">...</div>`;

    const convs = await this.loadConversations();
    // 缓存用于搜索筛选
    this._cachedConversations.set(instance.sessionId, convs);
    this.renderChatHistoryListFromCache(instance, convs);
  }

  private renderChatHistoryListFromCache(instance: AICapsuleInstance, convs: ChatConversation[], filter?: string): void {
    const panel = instance.element.querySelector('.ai-bar-chat-history-panel') as HTMLDivElement;
    if (!panel) return;

    panel.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'ai-chat-hist-header';
    const title = document.createElement('span');
    title.className = 'ai-chat-hist-title';
    title.textContent = t('aiChatHistoryTitle');
    header.appendChild(title);
    panel.appendChild(header);

    const filtered = filter
      ? convs.filter(c => this.fuzzyMatch(c.title, filter) ||
          c.messages.some(m => m.type !== 'tool_call' && this.fuzzyMatch(m.content, filter)))
      : convs;

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ai-chat-hist-empty';
      empty.textContent = t('aiChatHistoryEmpty');
      panel.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'ai-chat-hist-list';

    for (const conv of filtered) {
      const row = document.createElement('div');
      row.className = 'ai-chat-hist-row';

      const info = document.createElement('div');
      info.className = 'ai-chat-hist-info';
      info.addEventListener('click', () => this.restoreConversation(instance, conv));

      const rowTitle = document.createElement('div');
      rowTitle.className = 'ai-chat-hist-row-title';
      rowTitle.textContent = conv.title;

      const rowMeta = document.createElement('div');
      rowMeta.className = 'ai-chat-hist-row-meta';
      rowMeta.textContent = `${conv.messages.length} msgs · ${this.formatRelativeTime(conv.updatedAt)}`;

      info.appendChild(rowTitle);
      info.appendChild(rowMeta);

      const delBtn = document.createElement('button');
      delBtn.className = 'ai-chat-hist-delete';
      delBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`;
      delBtn.title = t('aiChatDeleteConfirmOk');
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.handleDeleteConversation(instance, conv.id);
      });

      row.appendChild(info);
      row.appendChild(delBtn);
      list.appendChild(row);
    }

    panel.appendChild(list);
  }

  private renderChatHistoryDetail(instance: AICapsuleInstance, conv: ChatConversation): void {
    const panel = instance.element.querySelector('.ai-bar-chat-history-panel') as HTMLDivElement;
    if (!panel) return;
    panel.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'ai-chat-hist-header';

    const backBtn = document.createElement('button');
    backBtn.className = 'ai-chat-hist-back';
    backBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="10 3 5 8 10 13"/></svg>`;
    backBtn.title = t('aiChatHistoryBack');
    backBtn.addEventListener('click', () => this.renderChatHistoryList(instance));

    const title = document.createElement('span');
    title.className = 'ai-chat-hist-title';
    title.textContent = conv.title;

    header.appendChild(backBtn);
    header.appendChild(title);
    panel.appendChild(header);

    const msgContainer = document.createElement('div');
    msgContainer.className = 'ai-chat-hist-messages';

    for (const msg of conv.messages) {
      const msgEl = document.createElement('div');
      const content = document.createElement('div');
      content.className = 'ai-msg-content';

      if (msg.type === 'tool_call') {
        msgContainer.appendChild(this.buildToolCard(msg));
        continue;
      } else if (msg.type === 'assistant') {
        msgEl.className = 'ai-msg ai-msg-assistant';
        const addHistory = (cmd: string) => this.addHistory(instance, cmd, 'ai');
        content.innerHTML = renderMarkdown(msg.content, instance.sessionId, addHistory);
      } else if (msg.type === 'thinking') {
        // Reasoning — standalone block (no bubble)
        if (msg.reasoning) {
          const block = document.createElement('div');
          block.className = 'ai-thinking-block';
          const details = document.createElement('details');
          details.className = 'ai-reasoning';
          const summary = document.createElement('summary');
          summary.innerHTML = `${thinkingIcon(12)} <span>${t('aiThinking')}</span>`;
          const textEl = document.createElement('div');
          textEl.className = 'ai-reasoning-text';
          textEl.textContent = msg.reasoning;
          details.appendChild(summary);
          details.appendChild(textEl);
          block.appendChild(details);
          msgContainer.appendChild(block);
        }
        // Assistant text — render as regular bubble
        if (msg.content) {
          msgEl.className = 'ai-msg ai-msg-assistant';
          const addHistory = (cmd: string) => this.addHistory(instance, cmd, 'ai');
          content.innerHTML = renderMarkdown(msg.content, instance.sessionId, addHistory);
        } else {
          continue; // No content to render as a bubble
        }
      } else if (msg.type === 'system') {
        msgEl.className = 'ai-msg ai-msg-system';
        content.textContent = msg.content;
      } else {
        // user
        msgEl.className = 'ai-msg ai-msg-user';
        content.textContent = msg.content;
      }

      msgEl.appendChild(content);
      msgContainer.appendChild(msgEl);
    }

    panel.appendChild(msgContainer);

    // Bind command buttons in rendered markdown
    this.bindCommandButtons(instance, msgContainer);
  }

  private async handleDeleteConversation(instance: AICapsuleInstance, convId: string): Promise<void> {
    const now = Date.now();
    if (now < this._deleteSkipUntil) {
      // Skip confirm, delete directly
      await this.deleteConversation(convId);
      await this.reloadChatHistoryWithFilter(instance);
      return;
    }

    const confirmed = await this.confirmDeleteConversation();
    if (confirmed) {
      await this.deleteConversation(convId);
      await this.reloadChatHistoryWithFilter(instance);
    }
  }

  // 重新加载对话列表并保持当前搜索筛选
  private async reloadChatHistoryWithFilter(instance: AICapsuleInstance): Promise<void> {
    const convs = await this.loadConversations();
    this._cachedConversations.set(instance.sessionId, convs);
    const input = instance.element.querySelector('.ai-bar-input') as HTMLInputElement;
    const query = (instance.chatHistoryOpen && input) ? input.value : '';
    this.renderChatHistoryListFromCache(instance, convs, query || undefined);
  }

  private confirmDeleteConversation(): Promise<boolean> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'ai-danger-overlay';

      const dialog = document.createElement('div');
      dialog.className = 'ai-danger-dialog';

      const title = document.createElement('div');
      title.className = 'ai-danger-title';
      title.textContent = t('aiChatDeleteConfirmTitle');

      const msg = document.createElement('div');
      msg.className = 'ai-danger-msg';
      msg.textContent = t('aiChatDeleteConfirmMsg');

      const checkboxRow = document.createElement('label');
      checkboxRow.className = 'ai-delete-checkbox-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'ai-delete-checkbox';
      const checkLabel = document.createElement('span');
      checkLabel.textContent = t('aiChatDeleteNoAskMinutes');
      checkboxRow.appendChild(checkbox);
      checkboxRow.appendChild(checkLabel);

      const actions = document.createElement('div');
      actions.className = 'ai-danger-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ai-danger-btn ai-danger-btn-cancel';
      cancelBtn.textContent = t('aiChatDeleteConfirmCancel');

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'ai-danger-btn ai-danger-btn-run';
      deleteBtn.textContent = t('aiChatDeleteConfirmOk');

      const close = (result: boolean) => {
        if (result && checkbox.checked) {
          this._deleteSkipUntil = Date.now() + 5 * 60 * 1000;
        }
        overlay.remove();
        resolve(result);
      };

      cancelBtn.addEventListener('click', () => close(false));
      deleteBtn.addEventListener('click', () => close(true));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });

      actions.appendChild(cancelBtn);
      actions.appendChild(deleteBtn);
      dialog.appendChild(title);
      dialog.appendChild(msg);
      dialog.appendChild(checkboxRow);
      dialog.appendChild(actions);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      cancelBtn.focus();
    });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  mountTo(sessionId: string, container: HTMLElement): void {
    if (!this.capsules.has(sessionId)) {
      this.create(sessionId);
    }
    const instance = this.capsules.get(sessionId)!;
    if (instance.element.parentElement !== container) {
      container.appendChild(instance.element);
    }
    // Mount chat panel before the AI bar so it appears above
    if (instance.chatPanel && instance.chatPanel.parentElement !== container) {
      container.insertBefore(instance.chatPanel, instance.element);
    }
  }

  hideAll(): void {
    this.capsules.forEach((inst) => {
      inst.element.style.display = 'none';
      if (inst.chatPanel) inst.chatPanel.style.display = 'none';
    });
  }

  show(sessionId: string): void {
    const inst = this.capsules.get(sessionId);
    if (inst) {
      if (this._barHidden) {
        inst.element.style.display = 'none';
        if (inst.chatPanel) inst.chatPanel.style.display = 'none';
        this.ensureFloatingBtn();
        if (this._floatingBtn) this._floatingBtn.style.display = 'flex';
        return;
      }
      this._lastShownSessionId = sessionId;
      inst.element.style.display = '';
      // Restore chat panel visibility if it was open
      if (inst.chatPanel && inst.chatOpen) {
        inst.chatPanel.style.display = '';
      }
      // Update model label whenever shown
      const label = inst.element.querySelector('.ai-bar-model-label') as HTMLSpanElement;
      if (label) this.updateModelLabel(label);
      // Sync AI bar position with current drawer state
      const drawerHeight = DrawerManager.getDrawerHeight(sessionId);
      this.setDrawerOffset(sessionId, drawerHeight);
    }
  }

  setDrawerOffset(sessionId: string, drawerHeight: number): void {
    const inst = this.capsules.get(sessionId);
    if (!inst) return;
    const btn = inst.element.querySelector('.ai-bar-btn-drawer');
    if (btn) {
      btn.classList.toggle('active', drawerHeight > 0);
    }
  }

  has(sessionId: string): boolean {
    return this.capsules.has(sessionId);
  }

  destroy(sessionId: string): void {
    const inst = this.capsules.get(sessionId);
    if (!inst) return;
    if (inst.unsubInput) inst.unsubInput();
    inst.agent.abort();
    inst.element.remove();
    this.capsules.delete(sessionId);
  }

  // ─── Hide / Show bar ──────────────────────────────────────────

  get barHidden(): boolean {
    return this._barHidden;
  }

  hideBar(): void {
    this._barHidden = true;
    this.capsules.forEach((inst) => {
      inst.element.style.display = 'none';
    });
    const panel = document.getElementById('terminal-panel');
    if (panel) panel.classList.add('ai-bar-hidden');
    this.ensureFloatingBtn();
    if (this._floatingBtn) this._floatingBtn.style.display = 'flex';
    TerminalRegistry.resizeAll();
  }

  showBar(): void {
    this._barHidden = false;
    const panel = document.getElementById('terminal-panel');
    if (panel) panel.classList.remove('ai-bar-hidden');
    if (this._floatingBtn) this._floatingBtn.style.display = 'none';
    if (this._lastShownSessionId) {
      const inst = this.capsules.get(this._lastShownSessionId);
      if (inst) inst.element.style.display = '';
    }
    TerminalRegistry.resizeAll();
  }

  private ensureFloatingBtn(): void {
    if (this._floatingBtn) return;
    const btn = document.createElement('button');
    btn.className = 'ai-bar-floating-show';
    btn.title = 'Show AI Bar';
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 15 12 9 18 15"/></svg>`;
    btn.style.display = 'none';
    btn.addEventListener('click', () => this.showBar());
    // Mount on .terminal-area so it doesn't overlap file drawer
    const panel = document.getElementById('terminal-panel');
    const area = panel?.querySelector(':scope > .terminal-area') as HTMLElement | null;
    const parent = area || panel;
    if (parent) parent.appendChild(btn);
    this._floatingBtn = btn;
  }
}

export const AICapsuleManager = new AICapsuleManagerClass();
