// ─── AI Agent ─────────────────────────────────────────────────────
// Terminal-aware AI agent with Tool Use + Agentic Loop.
// Supports three trust levels (manual / semi-auto / full-auto) and
// degrades gracefully to chat-only mode for models without tool support.
//
// This file hosts the ToolAgent class itself.  Supporting logic lives
// in sibling modules:
//   - ai-agent-context.ts  : gatherContext / buildSystemPrompt / fixCodeBlocks
//   - ai-agent-errors.ts   : error classification + retry configs
//   - ai-agent-history.ts  : trimHistory / compressContext pure helpers

import {
  ChatMessage, StreamCallbacks, ToolCall, ToolSpec,
  createProvider, AIProviderConfig, AIProvider,
  resolveActiveModel,
} from './ai-provider';
import {
  ToolRegistry, buildToolContext, initializeTools, syncWebSearchTool,
  TOKEN_BUDGET, injectShellHook,
  TodoState,
} from './ai-tools';
import type { TodoItem } from './ai-tools-todo';
import { TerminalRegistry } from './terminal';
import { loadSettings } from './themes';
import {
  gatherContext, buildSystemPrompt, fixCodeBlocks,
} from './ai-agent-context';
import { getSessionMeta } from './ai-agent-session-meta';
import {
  classifyError, calculateRetryDelay, RETRY_CONFIGS,
} from './ai-agent-errors';
import {
  trimHistory, compressContext, microCompact, shouldAutoCompact,
} from './ai-agent-history';
import { type AgentEvent } from './ai-agent-events';
import { runAgentAsGenerator, type ImageAttachment } from './ai-agent-run';
import { runTools, type ToolExecResult } from './ai-tool-orchestrator';
import type { ToolHandler } from './ai-tools';
import { hooks } from './ai-hooks';
import { summarizeOlderMessages, COMPACT_MAX_OUTPUT } from './ai-agent-compact';
import { resetAgentNotificationThrottle } from './ai-notifications';
import {
  decidePermission,
  trustLevelToMode,
  DEFAULT_PERMISSION_RULES,
  type PermissionMode,
  type PermissionRule,
} from './ai-permission-rules';

// Re-exports for backward compatibility
export type { TerminalContext } from './ai-agent-context';
export { gatherContext } from './ai-agent-context';
export type { AgentEvent } from './ai-agent-events';

// ─── Agent Callbacks ────────────────────────────────────────────
// All fields except onToken/onComplete/onError are optional so that
// legacy callers (passing StreamCallbacks) still type-check.

export interface AgentCallbacks {
  /** Streaming text token from LLM. */
  onToken: (token: string) => void;
  /** Reasoning/thinking token — displayed in a distinct style (collapsible, dimmed). */
  onReasoning?: (token: string) => void;
  /** Agent completed (or reached max iterations). */
  onComplete: (fullText: string) => void;
  /** Unrecoverable error. */
  onError: (error: Error) => void;

  // ── Agent-specific (optional) ──

  /**
   * A thinking segment has ended (LLM returned text before tool calls).
   * UI should finalize the current message bubble so tool cards appear after it.
   */
  onThinkingComplete?: (text: string) => void;
  /**
   * A new agentic iteration is starting. UI should prepare a fresh
   * assistant message bubble to receive the next round of streamed tokens.
   */
  onIterationStart?: () => void;
  /** About to call a tool. */
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  /** Tool finished executing. */
  onToolResult?: (toolName: string, result: string, isError: boolean) => void;
  /** Tool returned image attachments (e.g. read_screen). Fires AFTER onToolResult. */
  onToolImages?: (
    toolName: string,
    images: Array<{
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
      data: string;
      label?: string;
    }>,
  ) => void;
  /**
   * Confirmation required — resolve with:
   *   true   → approve and execute
   *   false  → reject (tell LLM user refused)
   *   string → execute with edited command
   */
  onConfirmRequired?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<boolean | string>;
  /** Agent was aborted mid-execution. */
  onAborted?: (stepsCompleted: number) => void;
  /** Model degraded to chat mode (tools not supported). */
  onDegraded?: (reason: string) => void;

  // ── Error recovery (optional) ──

  /** LLM request failed, retrying after delay. */
  onRetrying?: (attempt: number, maxAttempts: number, delayMs: number, reason: string) => void;
  /** Context was compressed to fit within model limits. */
  onContextCompressed?: () => void;
  // NOTE: task-plan changes (todo_write) are delivered via the
  // persistent listener installed with `setTodoUpdateListener`, not
  // through this callbacks surface. That way `agent.clear()` and
  // other out-of-run mutations also refresh the UI consistently.
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_MAX_ITERATIONS = 15;
/** Hard ceiling for `unlimited` mode (maxIterations === 0). Prevents
 *  runaway loops if the LLM falls into a degenerate tool-call cycle
 *  that the repeat-action detector doesn't catch. */
const ABSOLUTE_MAX_ITERATIONS = 200;
const MAX_CONSECUTIVE_ERRORS = 3;
const MAX_CONTEXT_COMPRESSIONS = 2;

// ─── ToolAgent (exported as AIAgent for backward compat) ────────

export class ToolAgent {
  private messages: ChatMessage[] = [];
  private abortController: AbortController | null = null;
  private aborted = false;
  private toolRegistry: ToolRegistry;
  /** Once set to false (e.g. after a 400 from a non-tool model),
   *  all subsequent turns use chat-only mode. */
  private toolsSupported = true;
  /** Messages injected by the user while the agent is working.
   *  Flushed into this.messages at the next iteration checkpoint. */
  private pendingUserMessages: string[] = [];
  /** Set of sessionIds for which we've already fired SessionStart. */
  private sessionStartEmitted = new Set<string>();
  /** Most recent sessionId this agent was driven with — used so clear()
   *  can emit SessionEnd with the right session. */
  private lastSessionId = '';
  /**
   * Sliding window of the most recent tool-call hashes (toolName + JSON
   * args). Used by the repeat-action detector to spot the LLM looping on
   * the same identical call (e.g. spamming press_keys(":q","Enter") at
   * a vim that already exited). When a hash appears 3+ times in the
   * last 5 calls, a warning is injected into the result so the LLM
   * realizes it should switch tactics — call read_screen, web_search,
   * or stop the loop.
   */
  private recentToolHashes: string[] = [];
  /**
   * Persistent task plan maintained by the LLM via the `todo_write`
   * tool. The list is stored on the agent (not on individual tool
   * calls) so it survives across iterations and can be injected into
   * every system prompt without burning tool-call round-trips. The
   * agent installs an `onUpdate` listener that fans state changes
   * out to the active AgentCallbacks.
   */
  private todoState = new TodoState();

  constructor() {
    this.toolRegistry = initializeTools();
  }

  /** Read the current task plan (immutable copy). */
  getTodos(): TodoItem[] {
    return this.todoState.get();
  }

  /**
   * Persistent listener for task plan changes. Set by the UI once at
   * agent creation time so events fire even outside an active run
   * (e.g. when `clear()` empties the plan between turns).
   */
  setTodoUpdateListener(fn: ((todos: TodoItem[]) => void) | undefined): void {
    this.todoState.onUpdate = fn;
  }

  /**
   * User-attached files queued for the NEXT turn. These are files the
   * user dropped / picked in the chat capsule before hitting Send.
   * They live on disk at absolute paths (saved by
   * `agent_save_attachment`) and we surface them to the model via a
   * system-prompt block so it can read_file / upload_file them. The
   * list is injected on EVERY iteration of the current turn so the
   * model can re-check the attachments at any step, and then cleared
   * automatically once the turn finishes (see runLoop finally).
   */
  private pendingAttachments: Array<{ name: string; path: string; size: number; mimeType?: string }> = [];

  /** Set the attachments for the upcoming turn. Call before `send()`. */
  setPendingAttachments(
    atts: Array<{ name: string; path: string; size: number; mimeType?: string }>,
  ): void {
    this.pendingAttachments = atts.map((a) => ({ ...a }));
  }

  /** Read the current pending attachment list (immutable copy). */
  getPendingAttachments(): Array<{ name: string; path: string; size: number; mimeType?: string }> {
    return this.pendingAttachments.map((a) => ({ ...a }));
  }

  /** Render the pending-attachments block for the system prompt. Empty
   *  when no attachments are queued. */
  private renderAttachmentsBlock(): string {
    if (this.pendingAttachments.length === 0) return '';
    const fmtSize = (n: number) => {
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
      return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
    };
    const lines: string[] = [];
    lines.push('User attached the following local files for this turn:');
    for (let i = 0; i < this.pendingAttachments.length; i++) {
      const a = this.pendingAttachments[i];
      lines.push(`  ${i + 1}. ${a.name}  (${fmtSize(a.size)})  path=${a.path}`);
    }
    lines.push('');
    lines.push('You can feed these paths directly into upload_file (to ship them to a remote server), read_file (to inspect them), or run_command (e.g. `tar tzf <path>` to list an archive, `unzip -l <path>` to list a zip). The path is the canonical way to reference each attachment — do NOT ask the user to re-paste the file.');
    return lines.join('\n');
  }

  /**
   * Rehydrate the task plan from persisted conversation history.
   * Called by the UI during chat restore so the next system prompt
   * immediately reflects the plan that was in flight when the user
   * last closed the conversation. Bypasses the onUpdate listener
   * to avoid firing a redundant UI re-render (the caller already
   * rendered the board from the same source).
   */
  restoreTodos(items: TodoItem[]): void {
    const listener = this.todoState.onUpdate;
    this.todoState.onUpdate = undefined;
    try {
      this.todoState.set(items);
    } finally {
      this.todoState.onUpdate = listener;
    }
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Send a user message and run the agentic loop.
   *
   * @param userMessage Plain-text user prompt.
   * @param sessionId   Session id for terminal context.
   * @param callbacks   UI callbacks.
   * @param images      Optional attached images (paste / drop). If
   *                    provided, the user message is stored as a
   *                    ContentPart[] with text + image blocks so the
   *                    multimodal provider path kicks in.
   */
  send(
    userMessage: string,
    sessionId: string,
    callbacks: AgentCallbacks,
    images?: Array<{
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
      data: string;
      label?: string;
    }>,
  ): void {
    this.abort();
    this.aborted = false;
    // Reset the repeat-action sliding window each new turn — loops only
    // make sense within the scope of a single agentic run.
    this.recentToolHashes = [];

    // Flush any pending injected messages to history first
    this.flushPendingMessages();

    // Remove all trailing orphaned user messages (from failed requests / injections)
    while (this.messages.length > 0 && this.messages[this.messages.length - 1].role === 'user') {
      this.messages.pop();
    }

    if (images && images.length > 0) {
      const parts: import('./ai-provider').ContentPart[] = [];
      if (userMessage) parts.push({ type: 'text', text: userMessage });
      for (const img of images) {
        parts.push({ type: 'image', mediaType: img.mediaType, data: img.data });
      }
      this.messages.push({ role: 'user', content: parts });
    } else {
      this.messages.push({ role: 'user', content: userMessage });
    }
    trimHistory(this.messages);

    // Reset per-turn notification throttle so the first waiting /
    // complete event of this new turn will always fire.
    resetAgentNotificationThrottle();

    // Track the current sessionId so clear() can emit SessionEnd
    // with the right value.
    this.lastSessionId = sessionId;

    // Fire SessionStart once per sessionId, then UserPromptSubmit.
    if (!this.sessionStartEmitted.has(sessionId)) {
      this.sessionStartEmitted.add(sessionId);
      void hooks.emitSessionStart({ sessionId });
    }
    void hooks.emitUserPromptSubmit({ sessionId, prompt: userMessage });

    this.runLoop(sessionId, callbacks).catch((e) => {
      callbacks.onError(e instanceof Error ? e : new Error(String(e)));
    });
  }

  /**
   * Inject a user message while the agent is actively working.
   */
  injectMessage(message: string): void {
    this.pendingUserMessages.push(message);
  }

  /**
   * Resume the agent after an error or interruption.
   */
  resume(
    sessionId: string,
    callbacks: AgentCallbacks,
  ): void {
    if (this.messages.length === 0) return;
    this.abort();
    this.aborted = false;

    this.runLoop(sessionId, callbacks).catch((e) => {
      callbacks.onError(e instanceof Error ? e : new Error(String(e)));
    });
  }

  /** Whether the agent has conversation state that can be resumed. */
  get canResume(): boolean {
    return this.messages.length > 0 && !this.isStreaming;
  }

  /** Cancel the current request / tool execution. Also cancels any
   *  in-flight SFTP transfers started by upload_file / download_file
   *  so they don't keep running in the background after the agent stops. */
  abort(): void {
    this.aborted = true;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    // Best-effort cancel of any agent-initiated SFTP transfers that
    // are still in progress. Import is dynamic to avoid a circular dep.
    void import('./ai-tools-transfer').then(({ cancelAllAgentTransfers }) => {
      void cancelAllAgentTransfers();
    }).catch(() => {/* swallow */});
  }

  /** Clear conversation history and reset state. */
  clear(): void {
    this.abort();
    this.messages = [];
    this.pendingUserMessages = [];
    this.toolsSupported = true;
    this.recentToolHashes = [];
    // Reset the persistent task plan — a fresh conversation should
    // never inherit todos from the previous one.
    this.todoState.clear();
    // Drop any queued attachments from the previous turn. We do NOT
    // unlink the underlying files here — that's the UI's job (via
    // `clearPendingAttachments(inst, deleteFiles=true)`) because only
    // the UI knows whether the user might want to re-upload them.
    this.pendingAttachments = [];
    const sid = this.lastSessionId;
    // Allow SessionStart to fire again on next send() for this session.
    if (sid) this.sessionStartEmitted.delete(sid);
    void hooks.emitSessionEnd({ sessionId: sid, reason: 'cleared' });
  }

  /** Get current conversation messages (excluding system prompt). */
  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /** Whether a request is currently in progress. */
  get isStreaming(): boolean {
    return this.abortController !== null;
  }

  // ─── Pull-based async generator API ───────────────────────
  //
  // `run()` wraps the existing `runLoop()` and yields a typed stream
  // of AgentEvent values.  This is the preferred API for new callers —
  // it plays nicely with AbortSignal, allows structured consumption,
  // and matches the Claude-Code-style `query()` pattern.
  //
  // Implementation note: we convert the callback-driven runLoop into
  // a generator by routing callbacks into an AsyncEventQueue that the
  // generator drains. The queue is closed when runLoop resolves.

  /**
   * Run the agentic loop as a pull-based async generator.
   * Implementation lives in ai-agent-run.ts to keep this file
   * under the 1000-line cap. This method is a thin forwarder.
   */
  run(
    userMessage: string,
    sessionId: string,
    signal?: AbortSignal,
    images?: ImageAttachment[],
  ): AsyncGenerator<AgentEvent, void, void> {
    return runAgentAsGenerator(this, userMessage, sessionId, signal, images);
  }

  // ─── Core Agentic Loop ─────────────────────────────────────

  private async runLoop(
    sessionId: string,
    callbacks: AgentCallbacks,
  ): Promise<void> {
    const settings = loadSettings();
    const resolved = resolveActiveModel(settings.aiProviders, settings.aiActiveModel);
    if (!resolved) {
      callbacks.onError(new Error('No AI provider configured'));
      return;
    }

    const providerConfig: AIProviderConfig = {
      type: resolved.entry.type,
      apiKey: resolved.entry.apiKey,
      baseUrl: resolved.entry.baseUrl,
      model: resolved.model,
      maxTokens: settings.aiMaxTokens,
      temperature: settings.aiTemperature,
      enableThinking: settings.aiEnableThinking,
    };

    const configuredMax: number = settings.aiAgentMaxIterations ?? DEFAULT_MAX_ITERATIONS;
    const maxIterations = configuredMax === 0 ? ABSOLUTE_MAX_ITERATIONS : configuredMax;

    // Sync web_search tool with current settings (user may have toggled SearXNG)
    syncWebSearchTool(this.toolRegistry);

    // Build tool specs only when tools are supported
    const useTools = this.toolsSupported;
    const toolSpecs: ToolSpec[] = useTools
      ? this.toolRegistry.getDefinitions().map((d) => ({
          name: d.name,
          description: d.description,
          parameters: d.parameters as Record<string, unknown>,
        }))
      : [];

    // Inject shell integration hook on first tool-enabled interaction (synchronous, non-blocking).
    if (useTools) {
      const mt = TerminalRegistry.get(sessionId);
      if (mt && !mt.shellState.hookInjected) {
        injectShellHook(sessionId);
      }
    }

    let iteration = 0;
    let consecutiveErrors = 0;
    let llmRetryCount = 0;
    let contextCompressions = 0;

    // The persistent todo listener (installed via setTodoUpdateListener
    // by the UI) is the canonical sink for plan changes. We don't
    // touch it here — both in-run updates AND clear() updates flow
    // through the same listener so the UI stays consistent across
    // runs.

    // ── Loop (wrapped in try/finally to ensure agent mode cleanup) ──
    try {
    while (iteration < maxIterations) {
      if (this.aborted) {
        this.abortController = null;
        callbacks.onAborted?.(iteration);
        return;
      }
      iteration++;

      // Flush any user messages injected during previous iteration
      this.flushPendingMessages();

      // Signal UI: new iteration → prepare a fresh message bubble
      if (iteration > 1) {
        callbacks.onIterationStart?.();
      }

      // MicroCompact: truncate older tool outputs before every call.
      // Cheap, no model call, keeps the most recent 2 tool results intact.
      microCompact(this.messages);

      // AutoCompact (preventive): if estimated tokens are over the
      // threshold, proactively shrink history before we hit a hard
      // context_overflow error.
      //
      // Strategy: try LLM-based summarization first (preserves more
      // signal), fall back to purely-local compressContext() on any
      // failure.  We only attempt LLM compaction at most twice per
      // run to avoid runaway retries.
      if (
        contextCompressions < MAX_CONTEXT_COMPRESSIONS &&
        shouldAutoCompact(this.messages, /* default model context */)
      ) {
        await hooks.emitPreCompact({
          sessionId,
          reason: 'auto',
          beforeMessageCount: this.messages.length,
        });

        let didLlmCompact = false;
        // Use a dedicated AbortController so the compact call is
        // cancellable even on iteration #1 where the main
        // this.abortController has not been created yet.  Wire it to
        // this.abort() via a short-lived listener.
        const compactCtl = new AbortController();
        const abortCompact = () => compactCtl.abort();
        if (this.abortController) {
          this.abortController.signal.addEventListener('abort', abortCompact, { once: true });
        }
        try {
          const compactConfig: AIProviderConfig = {
            ...providerConfig,
            maxTokens: Math.min(providerConfig.maxTokens, COMPACT_MAX_OUTPUT),
          };
          const compactProvider = createProvider(compactConfig);
          const summarized = await summarizeOlderMessages(
            this.messages,
            compactProvider,
            compactCtl.signal,
          );
          if (summarized) {
            this.messages = summarized;
            didLlmCompact = true;
            contextCompressions++;
            callbacks.onContextCompressed?.();
          }
        } catch {
          // Swallow — fall through to local compression below.
        } finally {
          this.abortController?.signal.removeEventListener('abort', abortCompact);
        }

        // If the external signal (or this.aborted) fired during
        // summarization, bail out of the loop cleanly.
        if (this.aborted) {
          this.abortController = null;
          callbacks.onAborted?.(iteration);
          return;
        }

        if (!didLlmCompact) {
          const compressed = compressContext(this.messages);
          if (compressed) {
            contextCompressions++;
            callbacks.onContextCompressed?.();
          }
        }
      }

      // Refresh terminal context each iteration (captures latest
      // output + current pane topology). Pane closure notices are
      // consumed (flushed) here so each notice surfaces EXACTLY ONCE
      // — the next iteration will see an empty list for them.
      const meta = getSessionMeta(sessionId);
      const closureNotices = meta.consumeClosureNotices();
      const ctx = gatherContext(sessionId, TOKEN_BUDGET.systemContextLines, {
        targetPaneNumber: meta.targetPaneNumber,
        closureNotices,
      });
      const hasTools = useTools && toolSpecs.length > 0;
      const systemPrompt = buildSystemPrompt(ctx, hasTools, {
        todoBlock: this.todoState.renderForSystemPrompt(),
        attachmentsBlock: this.renderAttachmentsBlock(),
      });

      const fullMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...this.messages,
      ];

      const provider = createProvider(providerConfig);
      this.abortController = new AbortController();

      try {
        // ── Call LLM ──
        const response = await this.callLLM(
          provider,
          fullMessages,
          hasTools ? toolSpecs : undefined,
          callbacks,
          this.abortController.signal,
        );

        // Reset retry counter on success
        llmRetryCount = 0;

        if (this.aborted) {
          this.abortController = null;
          callbacks.onAborted?.(iteration);
          return;
        }

        // ── No tool calls → fix code blocks, then done ──
        if (!response.toolCalls || response.toolCalls.length === 0) {
          const fixed = fixCodeBlocks(response.text);
          this.messages.push({
            role: 'assistant',
            content: fixed,
            ...(response.reasoning ? { reasoning_content: response.reasoning } : {}),
          });

          // If user injected messages while we were streaming,
          // finalize this response and continue the loop so the LLM
          // can perceive and react to the new messages.
          if (this.pendingUserMessages.length > 0) {
            callbacks.onComplete(fixed);
            continue;
          }

          this.abortController = null;
          callbacks.onComplete(fixed);
          return;
        }

        // ── Finalize the thinking text before showing tool cards ──
        // Always call even when text is empty — this removes the blinking
        // cursor from the streaming message bubble.
        callbacks.onThinkingComplete?.(response.text);

        // ── Store assistant message with tool calls ──
        // reasoning_content MUST be preserved for thinking-mode providers
        // (Qwen3, DeepSeek-R1) — the next turn echoes it back to the API.
        this.messages.push({
          role: 'assistant',
          content: response.text || '',
          tool_calls: response.toolCalls,
          ...(response.reasoning ? { reasoning_content: response.reasoning } : {}),
        });

        // ── Execute tool calls (orchestrated: concurrent-safe run in
        //    parallel, unsafe run serially; confirmations are resolved
        //    up-front, serially, because the UI can only prompt once at
        //    a time) ──
        const toolCtx = buildToolContext(sessionId);
        // Attach the current abort signal so long-wait tools
        // (wait_for_user_input / watch_terminal) can unblock when
        // the user cancels the run.
        toolCtx.abortSignal = this.abortController?.signal;
        // Forward the agent's persistent todo state into every tool
        // call. The `todo_write` tool reads/writes through this ref;
        // any successful write fires the onUpdate listener installed
        // above, which forwards into callbacks.onTodoUpdate.
        toolCtx.todoState = this.todoState;
        const settingsForTools = loadSettings();
        const currentTrustLevel: number = settingsForTools.aiAgentTrustLevel ?? 0;
        // Explicit permission mode takes precedence over the legacy
        // trust level; both are read live each iteration so the user
        // can toggle the mode mid-run.
        const permMode: PermissionMode =
          (settingsForTools.aiPermissionMode as PermissionMode | undefined)
          ?? trustLevelToMode(currentTrustLevel);
        const permRules: PermissionRule[] =
          (settingsForTools.aiPermissionRules as PermissionRule[] | undefined)
          ?? DEFAULT_PERMISSION_RULES;

        // Pass 1 (serial): notify UI + resolve confirmations + emit
        // PreToolUse hook + consult permission rules. Builds a map from
        // call id → decision.
        type Decision =
          | { kind: 'run'; args: Record<string, unknown> }
          | { kind: 'reject'; message: string };
        const decisions = new Map<string, Decision>();

        for (const toolCall of response.toolCalls) {
          if (this.aborted) {
            this.messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: '[Execution aborted by user]',
            });
            this.abortController = null;
            callbacks.onAborted?.(iteration);
            return;
          }

          const handler = this.toolRegistry.get(toolCall.function.name);
          if (!handler) {
            decisions.set(toolCall.id, {
              kind: 'reject',
              message: `Unknown tool "${toolCall.function.name}"`,
            });
            continue;
          }

          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            args = {};
          }

          // PreToolUse hook (in-process) — may deny or mutate args.
          const hookResult = await hooks.emitPreToolUse({
            sessionId,
            toolCall,
            args,
          });
          if (hookResult.deny) {
            decisions.set(toolCall.id, {
              kind: 'reject',
              message: hookResult.deny.reason,
            });
            callbacks.onToolCall?.(toolCall.function.name, args);
            continue;
          }
          if (hookResult.replaceArgs) args = hookResult.replaceArgs;

          // Notify UI about this tool call (for card rendering).
          callbacks.onToolCall?.(toolCall.function.name, args);

          // Permission decision via mode + rules + handler heuristic.
          const perm = decidePermission(
            toolCall.function.name,
            args,
            handler,
            permMode,
            permRules,
          );
          if (perm.kind === 'deny') {
            decisions.set(toolCall.id, { kind: 'reject', message: perm.reason });
            continue;
          }
          if (perm.kind === 'allow') {
            decisions.set(toolCall.id, { kind: 'run', args });
            continue;
          }

          // perm.kind === 'ask' → prompt the user.
          if (!callbacks.onConfirmRequired) {
            decisions.set(toolCall.id, {
              kind: 'reject',
              message: 'User confirmation required but no handler available.',
            });
            continue;
          }
          const approved = await callbacks.onConfirmRequired(toolCall.function.name, args);
          if (approved === false) {
            decisions.set(toolCall.id, {
              kind: 'reject',
              message: 'User rejected this action.',
            });
            continue;
          }
          if (typeof approved === 'string') {
            decisions.set(toolCall.id, {
              kind: 'run',
              args: { ...args, command: approved },
            });
            continue;
          }
          // approved === true
          decisions.set(toolCall.id, { kind: 'run', args });
        }

        if (this.aborted) {
          this.abortController = null;
          callbacks.onAborted?.(iteration);
          return;
        }

        // Pass 2: run the approved tool calls through the orchestrator.
        // Rejected calls get a synthetic result without touching any handler.
        const results: ToolExecResult[] = await runTools(
          response.toolCalls,
          (name) => this.toolRegistry.get(name),
          async (toolCall, handler) => {
            const decision = decisions.get(toolCall.id);
            if (!decision || decision.kind === 'reject') {
              return {
                result: decision?.kind === 'reject' ? decision.message : 'No decision',
                isError: true,  // Rejected tools should be flagged as errors so the LLM doesn't misinterpret the denial as a success
              };
            }
            const started = Date.now();
            const out = await this.safeExecute(handler as ToolHandler, decision.args, toolCtx, toolCall.function.name);

            // ── Repeat-action loop detection ──
            // Track this call in a sliding window of size 5; if the
            // exact same (toolName, args) hash has appeared 3+ times,
            // prepend a warning to the result so the LLM realizes it
            // is looping and switches tactics (read_screen, web_search,
            // or just stop). The warning is injected even on success
            // because the problem is BEHAVIORAL, not result-based.
            const argsHash = (() => {
              try { return JSON.stringify(decision.args); } catch { return '?'; }
            })();
            const hash = `${toolCall.function.name}:${argsHash}`;
            this.recentToolHashes.push(hash);
            if (this.recentToolHashes.length > 5) this.recentToolHashes.shift();
            const repeatCount = this.recentToolHashes.filter(h => h === hash).length;
            if (repeatCount >= 3) {
              const warning =
                `[WARNING: You have called ${toolCall.function.name} with the EXACT same arguments ${repeatCount} times in a row. The terminal state is NOT changing the way you expected — you are stuck in a loop. STOP. Do NOT make a 4th identical call. Instead: (a) call read_screen to see what is actually on the screen right now (the text-based tools may be misleading you), (b) if you are trying to exit a TUI you don't recognize, call web_search "how to quit <program-name>" before sending any more keys, (c) reconsider whether the action you keep repeating even applies — the program may have already moved on.]\n\n`;
              if (typeof out.result === 'string') {
                out.result = warning + out.result;
              } else {
                out.result = { ...out.result, text: warning + out.result.text };
              }
            }

            // PostToolUse hook — fire-and-forget. Flatten multimodal
            // results to text for the audit log (image bytes never go
            // into the hook payload).
            const resultForHook = typeof out.result === 'string'
              ? out.result
              : `${out.result.text} [+${out.result.images.length} image(s)]`;
            void hooks.emitPostToolUse({
              sessionId,
              toolName: toolCall.function.name,
              callId: toolCall.id,
              args: decision.args,
              result: resultForHook,
              isError: out.isError,
              durationMs: Date.now() - started,
            });
            return out;
          },
          () => this.aborted,
        );

        // Pass 3: drain results in order — update message history + UI.
        for (const r of results) {
          // Normalize the tool result into the ChatMessage.content shape.
          // Text-only: store as string (classic path).
          // Multimodal: store as ContentPart[] so the provider can
          // translate it to the native image format when serializing.
          let normalizedContent: ChatMessage['content'];
          let uiText: string;
          let uiImages: Array<{ mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; label?: string }> | undefined;
          if (typeof r.result === 'string') {
            normalizedContent = r.isError ? `Error: ${r.result}` : r.result;
            uiText = r.result;
          } else {
            // Multimodal: build a ContentPart[] with text + image blocks.
            const parts: import('./ai-provider').ContentPart[] = [];
            if (r.result.text) parts.push({ type: 'text', text: r.result.text });
            for (const img of r.result.images) {
              parts.push({ type: 'image', mediaType: img.mediaType, data: img.data });
            }
            normalizedContent = parts.length > 0 ? parts : (r.isError ? 'Error' : 'OK');
            uiText = r.result.text;
            uiImages = r.result.images;
          }

          this.messages.push({
            role: 'tool',
            tool_call_id: r.callId,
            name: r.toolName,
            content: normalizedContent,
          });
          // UI callback: text + optional images attached via onToolImages.
          callbacks.onToolResult?.(r.toolName, uiText, r.isError);
          if (uiImages && uiImages.length > 0) {
            callbacks.onToolImages?.(r.toolName, uiImages);
          }

          if (r.isError) {
            consecutiveErrors++;
            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              this.abortController = null;
              callbacks.onError(
                new Error('Too many consecutive tool errors. Please check and retry.'),
              );
              return;
            }
          } else {
            consecutiveErrors = 0;
          }
        }

        // Tool calls handled — loop back to call LLM again with results

      } catch (e) {
        const err = e as Error;
        const errorInfo = classifyError(err);

        // ── AbortError ──
        if (errorInfo.category === 'abort') {
          this.abortController = null;
          callbacks.onAborted?.(iteration);
          return;
        }

        // ── Tool-use unsupported → degrade to chat mode ──
        if (errorInfo.category === 'tool_unsupported' && toolSpecs.length > 0) {
          this.toolsSupported = false;
          callbacks.onDegraded?.(
            'Current model does not support tool use. Falling back to chat mode.',
          );
          this.abortController = null;
          // Restart loop — user message is still in this.messages
          return this.runLoop(sessionId, callbacks);
        }

        // ── Context overflow → compress and retry ──
        if (errorInfo.category === 'context_overflow') {
          if (contextCompressions < MAX_CONTEXT_COMPRESSIONS) {
            const compressed = compressContext(this.messages);
            if (compressed) {
              contextCompressions++;
              callbacks.onContextCompressed?.();
              iteration--; // Retry same iteration
              continue;
            }
          }
          // Compression exhausted or nothing to compress
          this.abortController = null;
          callbacks.onError(err);
          return;
        }

        // ── Rate limit (4xx) → exponential backoff retry ──
        if (errorInfo.category === 'rate_limit') {
          const config = RETRY_CONFIGS.rate_limit;
          if (llmRetryCount < config.maxAttempts) {
            const delay = calculateRetryDelay(config, llmRetryCount);
            callbacks.onRetrying?.(llmRetryCount + 1, config.maxAttempts, delay, 'rate_limit');
            const ok = await this.sleepWithAbortCheck(delay);
            if (!ok) {
              this.abortController = null;
              callbacks.onAborted?.(iteration);
              return;
            }
            llmRetryCount++;
            iteration--; // Retry same iteration
            continue;
          }
          // Max retries exceeded
          this.abortController = null;
          callbacks.onError(err);
          return;
        }

        // ── Server error (5xx) → pause + auto-retry with longer intervals ──
        if (errorInfo.category === 'server_error') {
          const config = RETRY_CONFIGS.server_error;
          if (llmRetryCount < config.maxAttempts) {
            const delay = calculateRetryDelay(config, llmRetryCount);
            callbacks.onRetrying?.(llmRetryCount + 1, config.maxAttempts, delay, 'server_error');
            const ok = await this.sleepWithAbortCheck(delay);
            if (!ok) {
              this.abortController = null;
              callbacks.onAborted?.(iteration);
              return;
            }
            llmRetryCount++;
            iteration--; // Retry same iteration
            continue;
          }
          // Max retries exceeded — keep conversation state for manual resume
          this.abortController = null;
          callbacks.onError(err);
          return;
        }

        // ── Non-retryable errors (auth, unknown) ──
        // Keep user message in history for potential resume
        this.abortController = null;
        callbacks.onError(err);
        return;
      }
    }

    // ── Max iterations reached ──
    this.abortController = null;
    callbacks.onComplete(
      'Maximum execution steps reached. Please provide new instructions to continue.',
    );
    } finally {
      // No teardown needed for the persistent todo listener — it is
      // owned by the UI and lives across runs.
      //
      // Drop the pending attachments list so a follow-up turn in the
      // same conversation doesn't re-inject stale "user attached:"
      // blocks into the system prompt. The on-disk files are kept
      // (the UI manages their lifecycle) so the agent can still
      // reference them by path if the user explicitly mentions them
      // again in a later turn.
      this.pendingAttachments = [];
    }
  }

  // ─── safeExecute: single tool handler wrapper ─────────────

  /**
   * Execute a tool handler with an error boundary + soft timeout.
   *
   * Most tools are capped at 60s to guard against a hung promise in a
   * buggy provider. A small set of "long wait" tools manage their
   * OWN deadline (wait_for_user_input can wait up to 30 minutes; the
   * run_command/watch_terminal paths accept a caller-supplied timeout
   * and enforce it internally). For those we skip the 60s cap —
   * otherwise the outer timeout would race the tool's own deadline
   * and report "Tool execution timed out (60s)" in the middle of a
   * legitimate password entry.
   */
  private async safeExecute(
    handler: ToolHandler,
    args: Record<string, unknown>,
    ctx: ReturnType<typeof buildToolContext>,
    toolName?: string,
  ): Promise<{ result: string | import('./ai-tools-core').ToolOutputWithImages; isError: boolean }> {
    try {
      // Tools that manage their own (longer) timeouts internally.
      const selfManagedTimeout = toolName === 'wait_for_user_input'
        || toolName === 'watch_terminal'
        || toolName === 'run_command'
        || toolName === 'upload_file'
        || toolName === 'download_file';
      if (selfManagedTimeout) {
        const result = await handler.execute(args, ctx);
        return { result, isError: false };
      }
      const toolTimeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Tool execution timed out (60s)')), 60_000),
      );
      const result = await Promise.race([handler.execute(args, ctx), toolTimeout]);
      return { result, isError: false };
    } catch (e) {
      return { result: (e as Error).message, isError: true };
    }
  }

  // ─── LLM Call (Promise wrapper around streaming) ───────────

  private callLLM(
    provider: AIProvider,
    messages: ChatMessage[],
    tools: ToolSpec[] | undefined,
    callbacks: AgentCallbacks,
    signal: AbortSignal,
  ): Promise<{ text: string; toolCalls?: ToolCall[]; reasoning?: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const streamCallbacks: StreamCallbacks = {
        onToken: (token) => {
          if (!signal.aborted) callbacks.onToken(token);
        },
        onReasoning: (token) => {
          if (!signal.aborted) callbacks.onReasoning?.(token);
        },
        onToolCall: () => {
          // Individual tool-call notifications are handled after onComplete
        },
        onComplete: (fullText, toolCalls, reasoning) => {
          if (settled) return;
          settled = true;
          resolve({ text: fullText, toolCalls: toolCalls ?? undefined, reasoning });
        },
        onError: (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        },
      };

      provider.chat(messages, streamCallbacks, signal, tools);
    });
  }

  // ─── Pending Message Flush ──────────────────────────────

  /**
   * Move user-injected messages from the pending queue into the
   * conversation history. Called at the start of each iteration so
   * the LLM can perceive messages sent while the agent was working.
   */
  private flushPendingMessages(): void {
    if (this.pendingUserMessages.length === 0) return;
    const combined = this.pendingUserMessages.join('\n\n');
    this.pendingUserMessages = [];

    // If the last message is already a user message, merge to avoid
    // consecutive user messages (which break Anthropic). Handles both
    // string and multimodal ContentPart[] shapes.
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'user') {
      if (typeof last.content === 'string') {
        last.content += `\n\n${combined}`;
      } else {
        last.content.push({ type: 'text', text: `\n\n${combined}` });
      }
    } else {
      this.messages.push({ role: 'user', content: combined });
    }
  }

  // ─── Sleep with Abort Check ────────────────────────────────

  /** Sleep for the given duration. Returns false if aborted during sleep. */
  private async sleepWithAbortCheck(ms: number): Promise<boolean> {
    const step = 500;
    let remaining = ms;
    while (remaining > 0 && !this.aborted) {
      await new Promise((r) => setTimeout(r, Math.min(step, remaining)));
      remaining -= step;
    }
    return !this.aborted;
  }
}

// ─── Legacy Alias ────────────────────────────────────────────────
// ai-capsule.ts imports `AIAgent` — keep backward-compatible export.
export { ToolAgent as AIAgent };
