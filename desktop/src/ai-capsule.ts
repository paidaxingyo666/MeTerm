import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { t } from './i18n';
import { globalCompletionIndex } from './cmd-completion-data';
import { loadSettings, saveSettings } from './themes';
import { injectShellHook } from './ai-tools';
import { createOverlayScrollbar } from './overlay-scrollbar';
import { jumpServerConfigMap, sshConfigMap, remoteInfoMap } from './app-state';
import { AIAgent, AgentCallbacks } from './ai-agent';
import { escapeHtml } from './status-bar';
import { resolveActiveModel, resolveModel } from './ai-provider';
import { thinkingIcon } from './ai-icons';
import type { HistoryEntry, AICapsuleInstance, ConvEntry, ChatConversation } from './ai-capsule-types';
import { renderMarkdown } from './ai-capsule-markdown';
import { isDangerousCommand, confirmDangerousCommand } from './ai-capsule-danger';
import { buildToolCard as buildToolCardFn, appendToolCallCard as appendToolCallCardFn, updateToolResultCard as updateToolResultCardFn, showConfirmCard as showConfirmCardFn } from './ai-capsule-tool-ui';
import { bindChatContextMenu as bindChatContextMenuFn, resolveMessageIndex as resolveMessageIndexFn, showBubbleContextMenu as showBubbleContextMenuFn } from './ai-capsule-context-menu';
import { createTrustSwitcher as createTrustSwitcherFn } from './ai-capsule-trust';
import {
  getHistoryKey, loadHistory as loadHistoryFn,
  addHistory as addHistoryFn, fuzzyMatch, enterSearchMode as enterSearchModeFn,
  exitSearchMode as exitSearchModeFn,
  renderHistoryPanel as renderHistoryPanelFn, removeHistoryEntry as removeHistoryEntryFn,
} from './ai-capsule-history';
import {
  saveConversation as saveConversationFn, loadConversations as loadConversationsFn,
  deleteConversation as deleteConversationFn, confirmDeleteConversation as confirmDeleteConversationFn,
  renderChatHistoryListFromCache as renderChatHistoryListFromCacheFn,
  renderChatHistoryDetail as renderChatHistoryDetailFn,
} from './ai-capsule-chat-persistence';
import {
  updateButtonHighlight as updateButtonHighlightFn, updateChatTitle as updateChatTitleFn,
  appendUserMessage as appendUserMessageFn, showAgentPulse as showAgentPulseFn,
  hideAgentPulse as hideAgentPulseFn, sinkAgentPulse as sinkAgentPulseFn,
  beginAssistantMessage as beginAssistantMessageFn, ensureStreamBubble as ensureStreamBubbleFn,
  appendStreamToken as appendStreamTokenFn, collapseActiveThinking as collapseActiveThinkingFn,
  appendReasoningToken as appendReasoningTokenFn, finalizeMessage as finalizeMessageFn,
  finalizeThinking as finalizeThinkingFn, showError as showErrorFn,
  appendSystemNotice as appendSystemNoticeFn, buildAgentCallbacks as buildAgentCallbacksFn,
  LLM_SEND_SVG,
} from './ai-capsule-chat-ui';

export type { HistoryEntry, AICapsuleInstance, ConvEntry, ChatConversation } from './ai-capsule-types';
export { MAX_HISTORY, HISTORY_STORAGE_KEY } from './ai-capsule-types';

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
  private _popupResizeObserver: ResizeObserver | null = null;
  private _popupResizeHandler: (() => void) | null = null;
  private _activePopup: { panel: HTMLElement; aiBar: HTMLElement } | null = null;
  private _popupManualHeight = false; // 手动调整后锁定，不再自适应

  create(sessionId: string): AICapsuleInstance {
    if (this.capsules.has(sessionId)) {
      return this.capsules.get(sessionId)!;
    }

    const isSSH = DrawerManager.has(sessionId);
    const element = this.createBarElement(sessionId, isSSH);
    const historyKey = getHistoryKey(sessionId);
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
      unsubShellIdle: null,
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
        this.unobservePopupResize();
        this._popupManualHeight = false;
      } else {
        this.buildModelDropdown(modelDropdown, modelLabel);
        modelDropdown.style.display = '';
        modelSelect.classList.add('open');
        const aiBar = modelSelect.closest('.ai-bar') as HTMLElement;
        if (aiBar) {
          this.adjustPopupMaxHeight(modelDropdown, aiBar);
          this.observePopupResize(modelDropdown, aiBar);
        }
      }
    });

    // Close dropdown on outside click
    document.addEventListener('click', () => {
      modelDropdown.style.display = 'none';
      modelSelect.classList.remove('open');
      this.unobservePopupResize();
      this._popupManualHeight = false;
    });

    // Input wrapper (for custom placeholder overlay)
    const inputWrap = document.createElement('div');
    inputWrap.className = 'ai-bar-input-wrap';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ai-bar-input';
    input.placeholder = ' '; // non-empty so :placeholder-shown works
    input.autocapitalize = 'off';
    input.setAttribute('autocorrect', 'off');
    input.spellcheck = false;

    // Custom placeholder with SVG key icons
    const isMac = navigator.userAgent.includes('Mac');
    const phOverlay = document.createElement('div');
    phOverlay.className = 'ai-bar-placeholder';
    const enterKey = `<svg class="key-icon" viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 3v4.5a1.5 1.5 0 01-1.5 1.5H4"/><polyline points="6 6 3.5 9 6 12"/></svg>`;
    const modKey = isMac
      ? `<svg class="key-icon" viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><text x="7" y="11" text-anchor="middle" font-size="12" font-family="system-ui, -apple-system, sans-serif" fill="currentColor" stroke="none">⌘</text></svg>`
      : `<svg class="key-icon key-icon-wide" viewBox="0 0 24 14" width="24" height="14"><text x="12" y="11" text-anchor="middle" font-size="10" font-family="system-ui, -apple-system, sans-serif" fill="currentColor">Ctrl</text></svg>`;
    const cmdIcon = `<svg class="key-icon" viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 3 6 7 2 11"/><line x1="7" y1="11" x2="12" y2="11"/></svg>`;
    const botIcon = `<svg class="key-icon" viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="10" height="7" rx="2"/><line x1="5" y1="11" x2="5" y2="13"/><line x1="9" y1="11" x2="9" y2="13"/><circle cx="5.5" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="8.5" cy="7.5" r="1" fill="currentColor" stroke="none"/><line x1="7" y1="1" x2="7" y2="4"/><circle cx="7" cy="1" r="1" fill="currentColor" stroke="none"/></svg>`;
    phOverlay.innerHTML = `<span class="ai-ph-seg">${cmdIcon}${enterKey}</span><span class="ai-ph-sep">/</span><span class="ai-ph-seg">${botIcon}${modKey}<span class="ai-ph-plus">+</span>${enterKey}</span>`;

    inputWrap.appendChild(input);
    inputWrap.appendChild(phOverlay);

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
    createOverlayScrollbar({ viewport: chatHistPanel, container: chatHistPanel });

    // History button
    const histBtn = document.createElement('button');
    histBtn.className = 'ai-bar-btn ai-bar-btn-history';
    histBtn.title = t('aiHistory');
    histBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><polyline points="8 4.5 8 8 10.5 9.5"/></svg>`;

    // History panel (hidden by default)
    const histPanel = document.createElement('div');
    histPanel.className = 'ai-bar-history-panel';
    histPanel.style.display = 'none';
    createOverlayScrollbar({ viewport: histPanel, container: histPanel });

    bar.appendChild(modelSelect);
    bar.appendChild(inputWrap);
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

    panel.style.position = 'relative';
    panel.appendChild(resizeHandle);
    panel.appendChild(header);
    panel.appendChild(messages);
    createOverlayScrollbar({ viewport: messages, container: panel });

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

  // ─── Chat UI (delegated to ai-capsule-chat-ui.ts) ──

  private updateButtonHighlight(instance: AICapsuleInstance): void {
    updateButtonHighlightFn(instance);
  }

  private updateChatTitle(instance: AICapsuleInstance, title?: string): void {
    updateChatTitleFn(instance, title);
  }

  private appendUserMessage(instance: AICapsuleInstance, text: string): void {
    appendUserMessageFn(instance, text);
  }

  private showAgentPulse(instance: AICapsuleInstance): void {
    showAgentPulseFn(instance);
  }

  private hideAgentPulse(instance: AICapsuleInstance): void {
    hideAgentPulseFn(instance);
  }

  private sinkAgentPulse(instance: AICapsuleInstance): void {
    sinkAgentPulseFn(instance);
  }

  private beginAssistantMessage(instance: AICapsuleInstance): void {
    beginAssistantMessageFn(instance);
  }

  private ensureStreamBubble(instance: AICapsuleInstance): HTMLDivElement | null {
    return ensureStreamBubbleFn(instance);
  }

  private appendStreamToken(instance: AICapsuleInstance, token: string): void {
    appendStreamTokenFn(instance, token);
  }

  private collapseActiveThinking(instance: AICapsuleInstance): void {
    collapseActiveThinkingFn(instance);
  }

  private appendReasoningToken(instance: AICapsuleInstance, token: string): void {
    appendReasoningTokenFn(instance, token);
  }

  private finalizeMessage(instance: AICapsuleInstance, fullText: string): void {
    finalizeMessageFn(instance, fullText, this._chatUiDeps());
  }

  private finalizeThinking(instance: AICapsuleInstance, text: string): void {
    finalizeThinkingFn(instance, text, {
      addHistory: (i, cmd, src) => this.addHistory(i, cmd, src),
      bindCommandButtons: (i, c) => this.bindCommandButtons(i, c),
    });
  }

  private showError(instance: AICapsuleInstance, message: string): void {
    showErrorFn(instance, message);
  }

  private injectUserMessage(instance: AICapsuleInstance, text: string): void {
    appendUserMessageFn(instance, text);
    instance.messages.push({ type: 'user', content: text, timestamp: Date.now() });
    void this.saveConversation(instance);
    instance.agent.injectMessage(text);
  }

  /** Shared deps object for chat-ui callbacks. */
  private _chatUiDeps() {
    return {
      addHistory: (i: AICapsuleInstance, cmd: string, src: 'manual' | 'ai') => this.addHistory(i, cmd, src),
      bindCommandButtons: (i: AICapsuleInstance, c: Element) => this.bindCommandButtons(i, c),
      saveConversation: (i: AICapsuleInstance) => { void this.saveConversation(i); },
    };
  }

  private buildAgentCallbacks(instance: AICapsuleInstance): AgentCallbacks {
    return buildAgentCallbacksFn(instance, {
      ...this._chatUiDeps(),
      appendToolCallCard: (i, tn, a) => this.appendToolCallCard(i, tn, a),
      updateToolResultCard: (i, tn, r, e) => this.updateToolResultCard(i, tn, r, e),
      showConfirmCard: (i, tn, a) => this.showConfirmCard(i, tn, a),
    });
  }

  // ─── Agent Tool Call UI (delegated to ai-capsule-tool-ui.ts) ──

  private buildToolCard(msg: Extract<ConvEntry, { type: 'tool_call' }>): HTMLDivElement {
    return buildToolCardFn(msg);
  }

  private appendToolCallCard(instance: AICapsuleInstance, toolName: string, args: Record<string, unknown>): void {
    appendToolCallCardFn(instance, toolName, args, (i) => sinkAgentPulseFn(i), (i, cmd, src) => this.addHistory(i, cmd, src));
  }

  private updateToolResultCard(instance: AICapsuleInstance, toolName: string, result: string, isError: boolean): void {
    updateToolResultCardFn(instance, toolName, result, isError);
  }

  private showConfirmCard(instance: AICapsuleInstance, toolName: string, args: Record<string, unknown>): Promise<boolean | string> {
    return showConfirmCardFn(instance, toolName, args);
  }

  private appendSystemNotice(instance: AICapsuleInstance, text: string): void {
    appendSystemNoticeFn(instance, text);
  }

  /** Create the trust-level quick switcher button for the AI bar (delegated). */
  private createTrustSwitcher(): HTMLDivElement {
    return createTrustSwitcherFn(this.capsules, (inst, text) => this.appendSystemNotice(inst, text));
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

        if (isDangerousCommand(cmd)) {
          void confirmDangerousCommand(cmd).then((confirmed) => {
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

  // ─── Chat Bubble Context Menu (delegated to ai-capsule-context-menu.ts) ──

  private bindChatContextMenu(instance: AICapsuleInstance, container?: Element): void {
    bindChatContextMenuFn(instance, container, {
      resolveMessageIndex: (inst, nodes, pos) => resolveMessageIndexFn(inst, nodes, pos),
      showBubbleContextMenu: (e, items) => showBubbleContextMenuFn(e, items),
      saveConversation: (inst) => { void this.saveConversation(inst); },
    });
  }

  // ─── Terminal command capture ──────────────────────────────────

  private startTerminalCapture(instance: AICapsuleInstance): void {
    instance.lineBuffer = '';
    let escState: 'none' | 'esc' | 'csi' | 'ss3' | 'str_seq' | 'str_esc' = 'none';

    // Track user input for lineBuffer (used by completion), but NOT for history recording.
    // History is now recorded via shell hook (OSC 7768 lastCommand) which captures the
    // actual executed command including shell completions.
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
          // Fallback history: when hook is not installed (SSH without injection),
          // record from lineBuffer. Won't capture Tab completions but works everywhere.
          const mt = TerminalRegistry.get(instance.sessionId);
          if (!mt?.shellState.hookInjected && instance.lineBuffer.trim()) {
            this.addHistory(instance, instance.lineBuffer.trim(), 'manual');
            globalCompletionIndex.addHistoryEntry(instance.lineBuffer.trim());
          }
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

    // Record history from shell hook — captures the actual executed command
    // (including shell completions, unlike the lineBuffer approach).
    instance.unsubShellIdle = TerminalRegistry.onShellIdle(instance.sessionId, () => {
      const mt = TerminalRegistry.get(instance.sessionId);
      const lastCmd = mt?.shellState.lastCommand?.trim();
      if (lastCmd) {
        this.addHistory(instance, lastCmd, 'manual');
        globalCompletionIndex.addHistoryEntry(lastCmd);
      }
    });

    // Shell hook injection:
    // - Local shells: backend pre-installs hooks natively (ZDOTDIR/--rcfile on Unix,
    //   -NoExit -Command on Windows PowerShell, PROMPT env on cmd.exe) — skip here.
    // - SSH/remote: ONLY if user explicitly enabled in Settings > AI (default OFF)
    // - JumpServer: never inject (Koko proxy incompatible)
    const sid = instance.sessionId;
    const isRemoteSession = sshConfigMap.has(sid) || remoteInfoMap.has(sid);
    if (isRemoteSession && !jumpServerConfigMap.has(sid) && loadSettings().shellHookInjection) {
      // User opted in — inject after shell settles (2s of output silence)
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const tryInject = () => {
        unsubOutput();
        const mt = TerminalRegistry.get(sid);
        if (mt && !mt.shellState.hookInjected) injectShellHook(sid);
      };
      const resetTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(tryInject, 2000);
      };
      const unsubOutput = TerminalRegistry.onOutput(sid, () => {
        const mt = TerminalRegistry.get(sid);
        if (mt?.shellState.hookInjected) { unsubOutput(); return; }
        resetTimer();
      });
      resetTimer();
    }
  }

  // ─── History management (delegated to ai-capsule-history.ts) ──

  private loadHistory(historyKey: string): HistoryEntry[] {
    return loadHistoryFn(historyKey);
  }

  private addHistory(instance: AICapsuleInstance, command: string, source: 'manual' | 'ai'): void {
    addHistoryFn(instance, command, source, this.capsules, (inst) => this.renderHistoryPanel(inst));
  }

  private enterSearchMode(instance: AICapsuleInstance, placeholder: string, onInput: () => void): void {
    enterSearchModeFn(instance, placeholder, onInput, this._savedPlaceholder, this._savedInputValue, this._filterListener);
  }

  private exitSearchMode(instance: AICapsuleInstance): void {
    exitSearchModeFn(instance, this._savedPlaceholder, this._savedInputValue, this._filterListener);
  }

  private renderHistoryPanel(instance: AICapsuleInstance, filter?: string): void {
    renderHistoryPanelFn(instance, {
      ensurePopupResizeHandle: (p, b) => this.ensurePopupResizeHandle(p, b),
      handleDeleteHistoryEntry: (inst, entry) => { void this.handleDeleteHistoryEntry(inst, entry); },
      savedInputValue: this._savedInputValue,
      closeHistory: (inst) => this.closeHistory(inst),
    }, filter);
  }

  private async handleDeleteHistoryEntry(instance: AICapsuleInstance, entry: HistoryEntry): Promise<void> {
    const now = Date.now();
    if (now < this._deleteSkipUntil) {
      removeHistoryEntryFn(instance, entry, this.capsules, (inst) => this.renderHistoryPanel(inst));
      return;
    }
    const confirmed = await this.confirmDeleteConversation();
    if (confirmed) {
      removeHistoryEntryFn(instance, entry, this.capsules, (inst) => this.renderHistoryPanel(inst));
    }
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
      this.adjustPopupMaxHeight(panel, instance.element);
      this.observePopupResize(panel, instance.element);
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
    this.unobservePopupResize();
    this._popupManualHeight = false;
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

      const agentCallbacks = this.buildAgentCallbacks(instance);
      instance.agent.send(text, instance.sessionId, agentCallbacks);
    };

    termBtn.addEventListener('click', sendToTerminal);
    llmBtn.addEventListener('click', () => {
      if (instance.isStreaming) {
        const text = input.value.trim();
        if (text) {
          // Has text → inject message into running agent
          this.injectUserMessage(instance, text);
          input.value = '';
        } else {
          // Empty → abort
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
              ? instance.history.find(h => fuzzyMatch(h.command, query))
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
        if (instance.isStreaming && (instance.chatOpen || instance.chatMinimized)) {
          // Streaming with chat open → inject message into running agent
          const text = input.value.trim();
          if (text) {
            this.injectUserMessage(instance, text);
            input.value = '';
          }
          e.preventDefault();
        } else if (e.ctrlKey || e.metaKey) {
          sendToLLM();
          e.preventDefault();
        } else if (instance.chatOpen || instance.chatMinimized) {
          sendToLLM();
          e.preventDefault();
        } else {
          sendToTerminal();
          e.preventDefault();
        }
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

  // ─── Chat Persistence (delegated to ai-capsule-chat-persistence.ts) ──

  private async saveConversation(instance: AICapsuleInstance, snapshot?: { id: string; messages: ConvEntry[] }): Promise<void> {
    return saveConversationFn(instance, snapshot);
  }

  private async loadConversations(): Promise<ChatConversation[]> {
    return loadConversationsFn();
  }

  private async deleteConversation(id: string): Promise<void> {
    return deleteConversationFn(id);
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
    this.adjustPopupMaxHeight(panel, instance.element);
    this.observePopupResize(panel, instance.element);
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
    this.unobservePopupResize();
    this._popupManualHeight = false;
    this._cachedConversations.delete(instance.sessionId);
    this.exitSearchMode(instance);
  }

  private async renderChatHistoryList(instance: AICapsuleInstance): Promise<void> {
    const panel = instance.element.querySelector('.ai-bar-chat-history-panel') as HTMLDivElement;
    if (!panel) return;

    panel.innerHTML = `<div class="ai-chat-hist-header"><span class="ai-chat-hist-title">${t('aiChatHistoryTitle')}</span></div><div class="ai-chat-hist-loading" style="padding:12px;text-align:center;color:var(--text-muted);font-size:12px;">...</div>`;

    const convs = await this.loadConversations();
    this._cachedConversations.set(instance.sessionId, convs);
    this.renderChatHistoryListFromCache(instance, convs);
  }

  private renderChatHistoryListFromCache(instance: AICapsuleInstance, convs: ChatConversation[], filter?: string): void {
    renderChatHistoryListFromCacheFn(instance, convs, {
      ensurePopupResizeHandle: (p, b) => this.ensurePopupResizeHandle(p, b),
      restoreConversation: (inst, conv) => this.restoreConversation(inst, conv),
      handleDeleteConversation: (inst, convId) => { void this.handleDeleteConversation(inst, convId); },
    }, filter);
  }

  private renderChatHistoryDetail(instance: AICapsuleInstance, conv: ChatConversation): void {
    renderChatHistoryDetailFn(instance, conv, {
      ensurePopupResizeHandle: (p, b) => this.ensurePopupResizeHandle(p, b),
      renderChatHistoryList: (inst) => { void this.renderChatHistoryList(inst); },
      addHistory: (inst, cmd, src) => this.addHistory(inst, cmd, src),
      bindCommandButtons: (inst, container) => this.bindCommandButtons(inst, container),
    });
  }

  private async handleDeleteConversation(instance: AICapsuleInstance, convId: string): Promise<void> {
    const now = Date.now();
    if (now < this._deleteSkipUntil) {
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
    return confirmDeleteConversationFn((ts) => { this._deleteSkipUntil = ts; });
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

  /** 计算弹窗可用最大高度：保留至少 4 行终端内容，不超过终端面积 30% */
  private calcPopupMaxHeight(aiBar: HTMLElement): number {
    const container = aiBar.closest('#terminal-panel') || aiBar.parentElement;
    if (!container) return 0;
    const containerRect = container.getBoundingClientRect();
    const barRect = aiBar.getBoundingClientRect();
    const row = container.querySelector('.xterm-rows > div');
    const lineHeight = row ? row.getBoundingClientRect().height : 18;
    const reserved = lineHeight * 4 + 8;
    const available = barRect.top - containerRect.top - reserved;
    const maxByPercent = containerRect.height * 0.3;
    return Math.max(Math.min(available, maxByPercent), 0);
  }

  /** 设置弹窗 max-height（自适应模式） */
  private adjustPopupMaxHeight(panel: HTMLElement, aiBar: HTMLElement): void {
    if (this._popupManualHeight) return; // 手动锁定后不再自动调整
    panel.style.maxHeight = this.calcPopupMaxHeight(aiBar) + 'px';
  }

  /** 绑定响应式监听：ResizeObserver + window resize */
  private observePopupResize(panel: HTMLElement, aiBar: HTMLElement): void {
    this.unobservePopupResize();
    this._activePopup = { panel, aiBar };

    const onResize = () => {
      if (this._activePopup && !this._popupManualHeight) {
        this.adjustPopupMaxHeight(this._activePopup.panel, this._activePopup.aiBar);
      }
    };

    // ResizeObserver 监听容器
    const container = aiBar.closest('#terminal-panel') || aiBar.parentElement;
    if (container) {
      this._popupResizeObserver = new ResizeObserver(onResize);
      this._popupResizeObserver.observe(container);
    }

    // window resize 兜底
    this._popupResizeHandler = onResize;
    window.addEventListener('resize', onResize);

    // 添加拖拽 handle
    this.ensurePopupResizeHandle(panel, aiBar);
  }

  /** 解绑弹窗 resize 监听 */
  private unobservePopupResize(): void {
    if (this._popupResizeObserver) {
      this._popupResizeObserver.disconnect();
      this._popupResizeObserver = null;
    }
    if (this._popupResizeHandler) {
      window.removeEventListener('resize', this._popupResizeHandler);
      this._popupResizeHandler = null;
    }
    this._activePopup = null;
  }

  /** 为弹窗添加顶部拖拽 handle，手动调整高度后锁定自适应 */
  private ensurePopupResizeHandle(panel: HTMLElement, aiBar: HTMLElement): void {
    // render 会清空 innerHTML，每次需要重建
    let handle = panel.querySelector('.ai-popup-resize-handle') as HTMLElement | null;
    if (handle) return; // 已存在（未被清空）
    handle = document.createElement('div');
    handle.className = 'ai-popup-resize-handle';
    panel.insertBefore(handle, panel.firstChild);

    let startY = 0;
    let startH = 0;

    const onMove = (e: MouseEvent) => {
      const delta = startY - e.clientY;
      // 手动拖拽允许超过 30% 但保留至少 2 行终端内容
      const container = aiBar.closest('#terminal-panel') || aiBar.parentElement;
      let maxH = 0;
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const barRect = aiBar.getBoundingClientRect();
        const row = container.querySelector('.xterm-rows > div');
        const lineHeight = row ? row.getBoundingClientRect().height : 18;
        const reserved = lineHeight * 2 + 8;
        maxH = barRect.top - containerRect.top - reserved;
      }
      const newH = Math.max(Math.min(startH + delta, maxH), 40);
      panel.style.maxHeight = newH + 'px';
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      handle.classList.remove('dragging');
    };

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this._popupManualHeight = true; // 锁定自适应
      startY = e.clientY;
      startH = panel.getBoundingClientRect().height;
      document.body.style.userSelect = 'none';
      handle.classList.add('dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
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
    if (inst.unsubShellIdle) inst.unsubShellIdle();
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
