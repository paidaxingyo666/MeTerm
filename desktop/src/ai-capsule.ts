import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { t } from './i18n';
import { globalCompletionIndex } from './cmd-completion-data';
import { loadSettings } from './themes';
import { AgentCallbacks } from './ai-agent';
import type { HistoryEntry, AICapsuleInstance, ConvEntry, ChatConversation } from './ai-capsule-types';
import { wireTabStateDelegation } from './ai-capsule-types';
import { TabStateRegistry, resolveTabIdForSession } from './ai-capsule-tab-state';
import { setSessionMetaProvider } from './ai-agent-session-meta';
import {
  toggleChatHistory as toggleChatHistoryFn,
  openChatHistory as openChatHistoryFn,
  closeChatHistory as closeChatHistoryFn,
  renderChatHistoryList as renderChatHistoryListFn,
  handleDeleteConversation as handleDeleteConversationFn,
  reloadChatHistoryWithFilter as reloadChatHistoryWithFilterFn,
  type ChatHistoryPopupHost,
} from './ai-capsule-chat-history-popup';
import {
  hideSidePanel, showSidePanel,
  switchToSideMode,
} from './ai-capsule-layout';
import { isDangerousCommand, confirmDangerousCommand } from './ai-capsule-danger';
import { buildToolCard as buildToolCardFn, appendToolCallCard as appendToolCallCardFn, updateToolResultCard as updateToolResultCardFn, updateToolResultImages as updateToolResultImagesFn, showConfirmCard as showConfirmCardFn } from './ai-capsule-tool-ui';
import { bindChatContextMenu as bindChatContextMenuFn, resolveMessageIndex as resolveMessageIndexFn, showBubbleContextMenu as showBubbleContextMenuFn } from './ai-capsule-context-menu';
import { createTrustSwitcher as createTrustSwitcherFn } from './ai-capsule-trust';
import { createThinkingToggle as createThinkingToggleFn } from './ai-capsule-thinking-toggle';
import {
  getHistoryKey, loadHistory as loadHistoryFn,
  addHistory as addHistoryFn, enterSearchMode as enterSearchModeFn,
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
} from './ai-capsule-chat-ui';
import {
  PopupResizeState,
  adjustPopupMaxHeight as adjustPopupMaxHeightFn,
  observePopupResize as observePopupResizeFn,
  unobservePopupResize as unobservePopupResizeFn,
  ensurePopupResizeHandle as ensurePopupResizeHandleFn,
} from './ai-capsule-popup-resize';
import { updateModelLabel as updateModelLabelFn } from './ai-capsule-model-ui';
import {
  createBarElement as createBarElementFn,
  syncBarPlaceholder as syncBarPlaceholderFn,
} from './ai-capsule-bar-dom';
import {
  createChatPanel as createChatPanelFn,
  openChat as openChatFn,
  minimizeChat as minimizeChatFn,
  closeChatAndSave as closeChatAndSaveFn,
  sendToLLMFrom as sendToLLMFromFn,
  restoreConversation as restoreConversationFn,
  getSideInputCallbacks as getSideInputCallbacksFn,
  type ChatOpsHost,
} from './ai-capsule-chat-ops';
import {
  setupInput as setupInputFn,
  type InputSetupHost,
} from './ai-capsule-input-setup';
import { startTerminalCapture as startTerminalCaptureFn } from './ai-capsule-terminal-capture';
import { wireImageAttachmentHandlers, setActiveInstanceGetter } from './ai-capsule-image-attach';

export type { HistoryEntry, AICapsuleInstance, ConvEntry, ChatConversation } from './ai-capsule-types';
export { MAX_HISTORY, HISTORY_STORAGE_KEY } from './ai-capsule-types';

// ── Prompt vs Command detection ──

/** Path-like start patterns — always a command */
const PATH_START = /^(\.\/|\.\.\/|~\/|\/)/;

/** Natural language patterns — strong signal for prompt */
const PROMPT_PATTERNS = /^(what|how|why|when|where|who|can|could|would|should|is|are|does|did|will|help|explain|describe|tell|write|create|generate|fix|debug|refactor|optimize|translate|summarize|review|analyze|compare|please|hey|hi|hello|I |I'm |I've |my |the |this |that |we |our |let me|怎么|什么|为什么|如何|请|帮我|帮忙|解释|告诉|写一个|能不能|可以|是不是|有没有|我想|我要|我需要|你能|你可以|给我|做一个|生成|创建|修复|优化|翻译|分析|比较|列出|总结|描述)/i;

/**
 * Detect if input looks like a natural-language prompt (not a command).
 */
function looksLikePrompt(text: string): boolean {
  if (!text) return false;

  // 1. Path-like → definitely a command
  if (PATH_START.test(text)) return false;

  // 2. Contains Chinese characters → almost certainly a prompt
  if (/[\u4e00-\u9fff]/.test(text)) return true;

  // 3. Too short for English detection (single-word like "ls", "cd")
  if (text.length < 3) return false;

  // 4. Natural language pattern → definitely a prompt
  if (PROMPT_PATTERNS.test(text)) return true;

  // 5. Check first token against completion index (Trie lookup, very fast)
  const firstToken = text.split(/\s/)[0];
  if (firstToken && globalCompletionIndex.ready) {
    const matches = globalCompletionIndex.getMatches(firstToken, 1);
    if (matches.length > 0) return false;
    if (text.includes(' ')) return true;
  }

  // 6. Fallback heuristics (index not ready or single-word input)
  if (text.includes(' ') && text.length > 20) return true;

  return false;
}

// ─── AI Capsule Manager ──────────────────────────────────────────

class AICapsuleManagerClass {
  private capsules = new Map<string, AICapsuleInstance>();
  /** Tab-scoped shared agent state (see ai-capsule-tab-state.ts). */
  private tabStates = new TabStateRegistry();
  private _barHidden = false;
  private _floatingBtn: HTMLElement | null = null;
  private _lastShownSessionId: string | null = null;
  private _deleteSkipUntil = 0; // timestamp: skip confirm until this time
  // 弹窗搜索筛选状态
  private _savedPlaceholder = new Map<string, string>();   // sessionId → 原始 placeholder
  private _savedInputValue = new Map<string, string>();    // sessionId → 原始输入值
  private _filterListener = new Map<string, () => void>(); // sessionId → input 监听器引用
  // Popup resize state (extracted into a holder object)
  private _popupState = new PopupResizeState();
  // 缓存已加载的对话列表，用于搜索筛选
  private _cachedConversations = new Map<string, ChatConversation[]>();

  constructor() {
    // Subscribe to pane closures so the tab-scoped agent can
    // surface a one-shot "Pane N was closed" notice on its next
    // iteration. The event is dispatched from TabManager.closePane.
    document.addEventListener('meterm-pane-closed', ((e: Event) => {
      const detail = (e as CustomEvent<{ tabId: string; paneNumber: number }>).detail;
      if (!detail) return;
      this.tabStates.recordClosureNotice(detail.tabId, detail.paneNumber);
    }) as EventListener);

    // Expose tab-scoped agent metadata (locked target pane +
    // pending closure notices) to the agent loop, which lives in
    // ai-agent.ts and can't import UI code directly.
    setSessionMetaProvider((sessionId) => {
      const tabId = resolveTabIdForSession(sessionId);
      const state = this.tabStates.get(tabId);
      if (!state) {
        return {
          targetPaneNumber: null,
          consumeClosureNotices: () => [],
        };
      }
      return {
        targetPaneNumber: state.activeRunTargetPaneNumber,
        consumeClosureNotices: () => {
          const notices = state.pendingClosureNotices.map((n) => n.paneNumber);
          state.pendingClosureNotices = [];
          return notices;
        },
      };
    });
  }

  create(sessionId: string): AICapsuleInstance {
    if (this.capsules.has(sessionId)) {
      return this.capsules.get(sessionId)!;
    }

    const isSSH = DrawerManager.has(sessionId);
    const element = createBarElementFn(sessionId, isSSH, this._popupState, {
      createTrustSwitcher: () => this.createTrustSwitcher(),
      createThinkingToggle: () => this.createThinkingToggle(),
      hideBar: () => this.hideBar(),
    });
    const historyKey = getHistoryKey(sessionId);
    const tabId = resolveTabIdForSession(sessionId);
    const state = this.tabStates.getOrCreate(tabId);

    // Per-pane fields only; the shared (TabState) fields get installed
    // as delegating accessors right after, via wireTabStateDelegation.
    const instance = {
      sessionId,
      tabId,
      state,
      historyKey,
      element,
      selectedModel: '',
      history: this.loadHistory(historyKey),
      lineBuffer: '',
      unsubInput: null,
      unsubShellIdle: null,
      historyOpen: false,
    } as AICapsuleInstance;
    wireTabStateDelegation(instance);

    this.capsules.set(sessionId, instance);
    this.setupInput(instance);
    this.setupHistory(instance);
    this.setupChatHistory(instance);
    this.startTerminalCapture(instance);
    wireImageAttachmentHandlers(instance);
    this.syncBarPlaceholder(instance);

    return instance;
  }

  // ─── Host interface (used by extracted chat-ops + input-setup) ──

  private getChatOpsHost(): ChatOpsHost {
    return {
      capsules: this.capsules,
      bindChatContextMenu: (inst, c) => this.bindChatContextMenu(inst, c),
      buildToolCard: (msg) => this.buildToolCard(msg),
      bindCommandButtons: (inst, c) => this.bindCommandButtons(inst, c),
      addHistory: (inst, cmd, src) => this.addHistory(inst, cmd, src),
      saveConversation: (inst, snap) => this.saveConversation(inst, snap),
      deleteConversation: (id) => this.deleteConversation(id),
      closeHistory: (inst) => this.closeHistory(inst),
      closeChatHistory: (inst) => this.closeChatHistory(inst),
      updateButtonHighlight: (inst) => this.updateButtonHighlight(inst),
      updateChatTitle: (inst, title) => this.updateChatTitle(inst, title),
      appendUserMessage: (inst, text, images) => this.appendUserMessage(inst, text, images),
      showAgentPulse: (inst) => this.showAgentPulse(inst),
      beginAssistantMessage: (inst) => this.beginAssistantMessage(inst),
      buildAgentCallbacks: (inst) => this.buildAgentCallbacks(inst),
      showNoConfigHint: (inst) => this.showNoConfigHint(inst),
      createTrustSwitcher: () => this.createTrustSwitcher(),
      createThinkingToggle: () => this.createThinkingToggle(),
      toggleChatHistory: (inst, fromSide) => this.toggleChatHistory(inst, fromSide ?? false),
      injectUserMessage: (inst, text) => this.injectUserMessage(inst, text),
      getActiveInstance: () => this.getActiveInstance(),
    };
  }

  private getInputSetupHost(): InputSetupHost {
    return {
      looksLikePrompt: (text) => looksLikePrompt(text),
      injectUserMessage: (inst, text) => this.injectUserMessage(inst, text),
      collapseActiveThinking: (inst) => this.collapseActiveThinking(inst),
      finalizeMessage: (inst, text) => this.finalizeMessage(inst, text),
      openChat: (inst) => this.openChat(inst),
      minimizeChat: (inst) => this.minimizeChat(inst),
      closeHistory: (inst) => this.closeHistory(inst),
      closeChatHistory: (inst) => this.closeChatHistory(inst),
      showNoConfigHint: (inst) => this.showNoConfigHint(inst),
      appendUserMessage: (inst, text, images) => this.appendUserMessage(inst, text, images),
      beginAssistantMessage: (inst) => this.beginAssistantMessage(inst),
      showAgentPulse: (inst) => this.showAgentPulse(inst),
      hideAgentPulse: (inst) => this.hideAgentPulse(inst),
      updateButtonHighlight: (inst) => this.updateButtonHighlight(inst),
      updateChatTitle: (inst, title) => this.updateChatTitle(inst, title),
      saveConversation: (inst) => this.saveConversation(inst),
      syncBarPlaceholder: (inst) => this.syncBarPlaceholder(inst),
      buildAgentCallbacks: (inst) => this.buildAgentCallbacks(inst),
      addHistory: (inst, cmd, src) => this.addHistory(inst, cmd, src),
      savedInputValue: this._savedInputValue,
    };
  }

  // ─── Delegated chat panel ops ──

  private syncBarPlaceholder(instance: AICapsuleInstance): void {
    syncBarPlaceholderFn(instance);
  }

  private openChat(instance: AICapsuleInstance): void {
    openChatFn(instance, this.getChatOpsHost());
  }

  private minimizeChat(instance: AICapsuleInstance): void {
    minimizeChatFn(instance, this.getChatOpsHost());
  }

  private closeChatAndSave(instance: AICapsuleInstance): void {
    closeChatAndSaveFn(instance, this.getChatOpsHost());
  }

  private sendToLLMFrom(instance: AICapsuleInstance, text: string): void {
    sendToLLMFromFn(instance, text, this.getChatOpsHost());
  }

  private restoreConversation(instance: AICapsuleInstance, conv: ChatConversation): void {
    restoreConversationFn(instance, conv, this.getChatOpsHost());
  }

  // ─── Chat UI (delegated to ai-capsule-chat-ui.ts) ──

  private updateButtonHighlight(instance: AICapsuleInstance): void {
    updateButtonHighlightFn(instance);
  }

  private updateChatTitle(instance: AICapsuleInstance, title?: string): void {
    updateChatTitleFn(instance, title);
  }

  private appendUserMessage(
    instance: AICapsuleInstance,
    text: string,
    images?: Array<{ mediaType: string; data: string; label?: string }>,
  ): void {
    appendUserMessageFn(instance, text, images);
  }

  private showAgentPulse(instance: AICapsuleInstance): void {
    showAgentPulseFn(instance);
  }

  private hideAgentPulse(instance: AICapsuleInstance): void {
    hideAgentPulseFn(instance);
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
      updateToolResultImages: (i, tn, imgs) => this.updateToolResultImages(i, tn, imgs),
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

  private updateToolResultImages(
    instance: AICapsuleInstance,
    toolName: string,
    images: Array<{ mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; label?: string }>,
  ): void {
    updateToolResultImagesFn(instance, toolName, images);
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

  /** Create the thinking-mode quick-toggle button (delegated). */
  private createThinkingToggle(): HTMLDivElement {
    return createThinkingToggleFn(this.capsules, (inst, text) => this.appendSystemNotice(inst, text));
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

  // ─── Terminal command capture (delegated) ──

  private startTerminalCapture(instance: AICapsuleInstance): void {
    startTerminalCaptureFn(instance, (inst, cmd, src) => this.addHistory(inst, cmd, src));
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
    // Bottom mode: minimize chat panel so popups don't overlap
    if (instance.layoutMode !== 'side' && instance.chatOpen) {
      this.minimizeChat(instance);
    }
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
    this._popupState.manualHeight = false;
    this.exitSearchMode(instance);
  }

  // ─── Input handling (delegated) ─────────────────────────────

  private setupInput(instance: AICapsuleInstance): void {
    setupInputFn(instance, this.getInputSetupHost());
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
      // Don't close if click is inside AI Bar, side panel, or side input area
      if (instance.element.contains(target)) return;
      if (instance.sidePanel?.contains(target)) return;
      if (instance.sideInputArea?.contains(target)) return;
      this.closeChatHistory(instance);
    });
  }

  /** Build the host contract used by the extracted chat-history popup helpers. */
  private getChatHistoryPopupHost(): ChatHistoryPopupHost {
    return {
      loadConversations: () => this.loadConversations(),
      deleteConversation: (id) => this.deleteConversation(id),
      confirmDeleteConversation: () => this.confirmDeleteConversation(),
      closeHistory: (inst) => this.closeHistory(inst),
      enterSearchMode: (inst, placeholder, onInput) => this.enterSearchMode(inst, placeholder, onInput),
      exitSearchMode: (inst) => this.exitSearchMode(inst),
      restoreConversation: (inst, conv) => this.restoreConversation(inst, conv),
      minimizeChat: (inst) => this.minimizeChat(inst),
      ensurePopupResizeHandle: (p, b) => this.ensurePopupResizeHandle(p, b),
      observePopupResize: (p, b) => this.observePopupResize(p, b),
      unobservePopupResize: () => this.unobservePopupResize(),
      resetPopupManualHeight: () => { this._popupState.manualHeight = false; },
      adjustPopupMaxHeight: (p, b) => this.adjustPopupMaxHeight(p, b),
      getCachedConversations: (sid) => this._cachedConversations.get(sid),
      setCachedConversations: (sid, convs) => { this._cachedConversations.set(sid, convs); },
      deleteCachedConversations: (sid) => { this._cachedConversations.delete(sid); },
      renderListFromCache: (inst, convs, filter) => this.renderChatHistoryListFromCache(inst, convs, filter),
    };
  }

  private toggleChatHistory(instance: AICapsuleInstance, fromSidePanel = false): void {
    toggleChatHistoryFn(instance, this.getChatHistoryPopupHost(), fromSidePanel);
  }

  private openChatHistory(instance: AICapsuleInstance, fromSidePanel = false): void {
    openChatHistoryFn(instance, this.getChatHistoryPopupHost(), fromSidePanel);
  }

  private closeChatHistory(instance: AICapsuleInstance): void {
    closeChatHistoryFn(instance, this.getChatHistoryPopupHost());
  }

  private async renderChatHistoryList(instance: AICapsuleInstance): Promise<void> {
    await renderChatHistoryListFn(instance, this.getChatHistoryPopupHost());
  }

  private renderChatHistoryListFromCache(instance: AICapsuleInstance, convs: ChatConversation[], filter?: string): void {
    // Skip popup resize handle in side panel mode (inline view doesn't need it)
    const noopResize = () => {};
    const isSideInline = instance.chatHistoryPanel?.classList.contains('ai-side-chat-history-view');
    renderChatHistoryListFromCacheFn(instance, convs, {
      ensurePopupResizeHandle: isSideInline ? noopResize : (p, b) => this.ensurePopupResizeHandle(p, b),
      restoreConversation: (inst, conv) => this.restoreConversation(inst, conv),
      handleDeleteConversation: (inst, convId) => { void this.handleDeleteConversation(inst, convId); },
    }, filter);
  }

  private renderChatHistoryDetail(instance: AICapsuleInstance, conv: ChatConversation): void {
    const isSideInline = instance.chatHistoryPanel?.classList.contains('ai-side-chat-history-view');
    const noopResize = () => {};
    renderChatHistoryDetailFn(instance, conv, {
      ensurePopupResizeHandle: isSideInline ? noopResize : (p, b) => this.ensurePopupResizeHandle(p, b),
      renderChatHistoryList: (inst) => { void this.renderChatHistoryList(inst); },
      addHistory: (inst, cmd, src) => this.addHistory(inst, cmd, src),
      bindCommandButtons: (inst, container) => this.bindCommandButtons(inst, container),
    });
  }

  private async handleDeleteConversation(instance: AICapsuleInstance, convId: string): Promise<void> {
    await handleDeleteConversationFn(
      instance,
      convId,
      this.getChatHistoryPopupHost(),
      () => Date.now() < this._deleteSkipUntil,
    );
  }

  // 重新加载对话列表并保持当前搜索筛选
  private async reloadChatHistoryWithFilter(instance: AICapsuleInstance): Promise<void> {
    await reloadChatHistoryWithFilterFn(instance, this.getChatHistoryPopupHost());
  }

  private confirmDeleteConversation(): Promise<boolean> {
    return confirmDeleteConversationFn((ts) => { this._deleteSkipUntil = ts; });
  }

  // ─── Popup resize (delegated to ai-capsule-popup-resize.ts) ──

  private adjustPopupMaxHeight(panel: HTMLElement, aiBar: HTMLElement): void {
    adjustPopupMaxHeightFn(this._popupState, panel, aiBar);
  }

  private observePopupResize(panel: HTMLElement, aiBar: HTMLElement): void {
    observePopupResizeFn(this._popupState, panel, aiBar);
  }

  private unobservePopupResize(): void {
    unobservePopupResizeFn(this._popupState);
  }

  private ensurePopupResizeHandle(panel: HTMLElement, aiBar: HTMLElement): void {
    ensurePopupResizeHandleFn(this._popupState, panel, aiBar);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  mountTo(sessionId: string, container: HTMLElement): void {
    if (!this.capsules.has(sessionId)) {
      this.create(sessionId);
    }
    const instance = this.capsules.get(sessionId)!;

    // AI Bar always mounts in the container (terminal-panel)
    if (instance.element.parentElement !== container) {
      container.appendChild(instance.element);
    }

    if (instance.layoutMode === 'side' && instance.chatOpen) {
      // Side mode: ensure side panel is set up in #main-content
      if (instance.sidePanel && !instance.sidePanel.parentElement) {
        switchToSideMode(instance, getSideInputCallbacksFn(this.getChatOpsHost()));
      }
      instance.element.classList.add('ai-bar--side-active');
    } else {
      // Bottom mode: mount chat panel before the AI bar
      if (instance.chatPanel && instance.chatPanel.parentElement !== container) {
        container.insertBefore(instance.chatPanel, instance.element);
      }
    }
  }

  /**
   * Switch AI Bar to a different session within the same tab (split pane focus).
   */
  switchBarOnly(sessionId: string, container: HTMLElement): void {
    if (!this.capsules.has(sessionId)) {
      this.create(sessionId);
    }

    // Check if ANY session in this tab has side panel chat open
    let sideActive = false;
    this.capsules.forEach((inst) => {
      if (inst.layoutMode === 'side' && inst.chatOpen) sideActive = true;
    });

    // Hide all AI bars
    this.capsules.forEach((inst) => {
      inst.element.style.display = 'none';
    });

    // Mount and show the target session's bar
    const inst = this.capsules.get(sessionId)!;
    if (inst.element.parentElement !== container) {
      container.appendChild(inst.element);
    }
    if (this._barHidden) {
      inst.element.style.display = 'none';
      return;
    }
    inst.element.style.display = '';
    this._lastShownSessionId = sessionId;

    // If any session in the tab has side panel open, keep bar in side-active mode
    inst.element.classList.toggle('ai-bar--side-active', sideActive);
    this.syncBarPlaceholder(inst);
    const label = inst.element.querySelector('.ai-bar-model-label') as HTMLSpanElement;
    if (label) updateModelLabelFn(label);

    // Bottom mode: chat panel is tab-scoped and shared across all
    // panes of the tab. After swapping which AI Bar is visible, the
    // chat panel must be re-anchored to sit immediately above the
    // new (visible) AI Bar — otherwise it floats above the now-
    // hidden previous pane's bar and the layout looks broken.
    if (inst.chatPanel && inst.layoutMode === 'bottom' && inst.chatOpen) {
      const parent = inst.element.parentElement;
      if (parent) {
        parent.insertBefore(inst.chatPanel, inst.element);
        inst.chatPanel.style.display = '';
      }
    }

    // Restore the tab's shared draft text into the newly-visible
    // AI Bar input so a half-typed message carries over when the
    // user switches between panes of the same tab.
    const barInput = inst.element.querySelector('.ai-bar-input') as HTMLInputElement | null;
    if (barInput) barInput.value = inst.state.draftText || '';

    // Re-render the pending-image strip on the newly-visible surface
    // (AI Bar / side input area). The strip is tab-scoped via
    // state.pendingImages but its DOM lives on per-pane elements,
    // so switching panes needs to move the rendered strip.
    if (inst.state.pendingImages.length > 0) {
      void import('./ai-capsule-image-attach').then(({ renderPendingStrip }) => {
        renderPendingStrip(inst);
      });
    }
  }

  hideAll(): void {
    this.capsules.forEach((inst) => {
      inst.element.style.display = 'none';
      if (inst.layoutMode === 'side') {
        // Side mode: hide the side panel (it's a separate DOM element)
        if (inst.sidePanel) inst.sidePanel.style.display = 'none';
      } else {
        // Bottom mode: hide chat panel with the bar
        if (inst.chatPanel) inst.chatPanel.style.display = 'none';
      }
    });
  }

  show(sessionId: string): void {
    const inst = this.capsules.get(sessionId);
    if (inst) {
      if (this._barHidden) {
        inst.element.style.display = 'none';
        if (inst.layoutMode === 'side') {
          if (inst.sidePanel) inst.sidePanel.style.display = 'none';
        } else {
          if (inst.chatPanel) inst.chatPanel.style.display = 'none';
        }
        this.ensureFloatingBtn();
        if (this._floatingBtn) this._floatingBtn.style.display = 'flex';
        return;
      }
      this._lastShownSessionId = sessionId;
      inst.element.style.display = '';

      // Hide other sessions' side panels, show this session's
      this.capsules.forEach((other, otherId) => {
        if (otherId !== sessionId && other.layoutMode === 'side' && other.sidePanel) {
          hideSidePanel(other);
        }
      });

      if (inst.layoutMode === 'side' && inst.chatOpen) {
        // Side mode with chat open: ensure side panel is in DOM and visible
        inst.element.classList.add('ai-bar--side-active');
        if (inst.chatPanel) inst.chatPanel.style.display = '';
        if (inst.sidePanel && !inst.sidePanel.parentElement) {
          switchToSideMode(inst, getSideInputCallbacksFn(this.getChatOpsHost()));
        }
        showSidePanel(inst);
      } else {
        inst.element.classList.remove('ai-bar--side-active');
        // Bottom mode: restore chat panel if it was open
        if (inst.chatPanel && inst.chatOpen) {
          inst.chatPanel.style.display = '';
        }
        // Side mode but chat not open: keep side panel hidden
        if (inst.layoutMode === 'side' && inst.sidePanel) {
          hideSidePanel(inst);
        }
      }
      // Update model label whenever shown
      const label = inst.element.querySelector('.ai-bar-model-label') as HTMLSpanElement;
      if (label) updateModelLabelFn(label);
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
    if (inst.unsubShellIdle) inst.unsubShellIdle();

    // Always remove the pane-local AI Bar element.
    inst.element.remove();
    this.capsules.delete(sessionId);

    // Tab-scoped teardown: only when the LAST pane of this tab is
    // being destroyed. Other panes of the same tab still share the
    // agent / chat panel / side panel, so we must not abort the run
    // or rip the DOM out from under them.
    const tabId = inst.tabId;
    const stillHasSiblings = Array.from(this.capsules.values())
      .some((other) => other.tabId === tabId);
    if (stillHasSiblings) {
      return;
    }

    this.tabStates.destroy(tabId);
  }

  // ─── Active instance accessor ─────────────────────────────────

  /**
   * Return the currently-visible capsule instance, used by paste
   * routing as a fallback when the keystroke target is outside any
   * registered DOM root (e.g. focus is on document.body).
   */
  getActiveInstance(): AICapsuleInstance | null {
    if (this._lastShownSessionId) {
      return this.capsules.get(this._lastShownSessionId) ?? null;
    }
    // Fall back to the first capsule we have, if any.
    const first = this.capsules.values().next().value;
    return first ?? null;
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
      if (inst) {
        inst.element.style.display = '';
        // Sync side-active class based on current state
        inst.element.classList.toggle('ai-bar--side-active', inst.layoutMode === 'side' && inst.chatOpen);
      }
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

// Tell the image-attach module how to find the currently-active
// capsule when a paste event arrives outside any registered DOM
// root (e.g. focus is on document.body). Without this, Cmd+V on
// the side panel would silently route nowhere.
setActiveInstanceGetter(() => {
  // Reach into the manager via the public switchBarOnly state.
  // We expose lastShownSessionId via a small accessor.
  return AICapsuleManager.getActiveInstance();
});
