// ─── AI Agent ─────────────────────────────────────────────────────
// Terminal-aware AI agent with Tool Use + Agentic Loop.
// Supports three trust levels (manual / semi-auto / full-auto) and
// degrades gracefully to chat-only mode for models without tool support.

import {
  ChatMessage, StreamCallbacks, ToolCall, ToolSpec,
  createProvider, AIProviderConfig, AIProvider,
  resolveActiveModel, resolveModel,
} from './ai-provider';
import {
  ToolRegistry, buildToolContext, initializeTools, syncWebSearchTool,
  TOKEN_BUDGET, stripAnsi, injectShellHook,
} from './ai-tools';
import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { loadSettings } from './themes';
import { getLanguage } from './i18n';

// ─── Code Block Post-Processing ─────────────────────────────────
// Fix non-compliant bash code blocks in LLM output WITHOUT re-calling
// the model.  Rules enforced:
//   • One command per ```bash block
//   • No comment lines (#…) inside blocks — moved to plain text

function fixCodeBlocks(text: string): string {
  return text.replace(
    /```(bash|sh|shell|zsh|fish)\n([\s\S]*?)```/g,
    (_match, lang: string, body: string) => {
      const lines = body.trimEnd().split('\n');
      const cmds: { comments: string[]; cmd: string }[] = [];
      let commentBuf: string[] = [];

      for (const line of lines) {
        if (/^\s*#/.test(line) && line.trim().length > 0) {
          // Comment line — buffer it
          commentBuf.push(line.trim().replace(/^#\s*/, ''));
        } else if (line.trim().length > 0) {
          // Executable line
          cmds.push({ comments: commentBuf, cmd: line });
          commentBuf = [];
        }
      }

      // Nothing to fix
      if (cmds.length <= 1 && cmds.every(c => c.comments.length === 0) && commentBuf.length === 0) {
        return _match;
      }

      const parts: string[] = [];
      for (const { comments, cmd } of cmds) {
        if (comments.length > 0) parts.push(comments.join('\n'));
        parts.push(`\`\`\`${lang}\n${cmd}\n\`\`\``);
      }
      // Trailing comments (no command after them)
      if (commentBuf.length > 0) parts.push(commentBuf.join('\n'));

      return parts.join('\n\n');
    },
  );
}

// ─── Terminal Context ───────────────────────────────────────────

export interface TerminalContext {
  recentOutput: string;
  serverInfo: string;
  isSSH: boolean;
  cwd: string;
}

export function gatherContext(sessionId: string, maxLines: number): TerminalContext {
  let recentOutput = '';
  const raw = TerminalRegistry.serializeBuffer(sessionId);
  if (raw) {
    const stripped = stripAnsi(raw);
    const lines = stripped.split('\n');
    const recent = lines.slice(-maxLines);
    recentOutput = recent.join('\n').trim();
  }

  const info = DrawerManager.getServerInfo(sessionId);
  let serverInfo = '';
  let isSSH = false;
  if (info) {
    isSSH = true;
    serverInfo = `${info.username}@${info.host}:${info.port}`;
  }

  const mt = TerminalRegistry.get(sessionId);
  const cwd = mt?.shellState.cwd ?? '';

  return { recentOutput, serverInfo, isSSH, cwd };
}

// ─── System Prompt Builder ──────────────────────────────────────

function buildSystemPrompt(ctx: TerminalContext, hasTools: boolean): string {
  const lang = getLanguage();
  const langInstr = lang === 'zh'
    ? '请使用中文回复用户。'
    : 'Reply in the same language the user uses.';

  const envSection = ctx.isSSH
    ? `Connection: SSH (${ctx.serverInfo})`
    : `Connection: Local terminal`;

  const cwdSection = ctx.cwd
    ? `\nWorking directory: ${ctx.cwd}`
    : '';

  const infoSection = ctx.serverInfo
    ? `\nSystem: ${ctx.serverInfo}`
    : '';

  const terminalSection = ctx.recentOutput
    ? `\nRecent terminal output (last lines):\n\`\`\`\n${ctx.recentOutput}\n\`\`\``
    : '\n(No recent terminal output available)';

  const toolInstructions = hasTools
    ? `Instructions:
1. MINIMIZE TOOL CALLS. Before calling any tool, check if the answer is already visible in the terminal context above. If it is, answer directly — do not re-run commands to get information you already have.
2. run_command already returns the command output. Avoid unnecessary read_terminal calls — use read_terminal only when you need to check terminal state before acting or read output from user-initiated commands.
3. When the user's request is ambiguous (e.g. "check my IP" — local? public? which interface?), answer with what is most likely wanted. Only ask for clarification when genuinely unable to determine intent.
4. ONE tool call per step. Each shell command should be a single atomic operation — do not chain with && or ;.
5. After executing a command, check the returned output to verify success before proceeding.
6. If a command fails, analyze the error and try ONE alternative approach. Do NOT retry the same command or slight variations more than once.
7. BE CONCISE: After tool execution, summarize outcomes in 1–2 sentences. Do NOT repeat or echo command outputs — the user can already see them. Avoid verbose explanations.
8. For destructive operations (rm -rf, DROP TABLE, etc.), warn briefly before executing.
9. When suggesting commands in text (not via tool calls), put each command in its own \`\`\`bash block — one command per block, NO comments inside the block.
10. For monitoring running commands or handling interactive prompts (Y/n, password, etc.), use watch_terminal to observe output and send_input to respond. This enables auto-interaction with installers, package managers, and other interactive programs.
11. web_search (if available): Only use when the user asks to search, you encounter an unknown error/command, or need real-time info. Do NOT search for basic knowledge. Always specify relevant sites when the context is clear.
12. command_help (if available): Use to look up command syntax, flags, and usage examples from the tldr database. Useful when you need to recall exact syntax for a command.
13. ${langInstr}`
    : `Instructions:
1. Each shell command MUST be in its own separate \`\`\`bash code block — one command per block, never combine multiple commands in a single block.
2. NEVER put comments or non-executable text inside \`\`\`bash blocks. All explanations go in plain text outside the code blocks.
3. Be concise. Prefer giving commands directly over lengthy explanations.
4. When a command could be destructive (rm -rf, sudo, DROP, etc.), add a brief warning before the command block.
5. If the terminal output shows an error, proactively help diagnose it.
6. ${langInstr}`;

  return `You are a terminal AI assistant embedded in a terminal application. Help the user work efficiently in their terminal environment.

Environment:
- ${envSection}${cwdSection}${infoSection}
${terminalSection}

${toolInstructions}`;
}

// ─── Error Classification ───────────────────────────────────────

type ErrorCategory =
  | 'rate_limit'
  | 'server_error'
  | 'context_overflow'
  | 'auth'
  | 'tool_unsupported'
  | 'abort'
  | 'unknown';

interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

const RETRY_CONFIGS: Record<string, RetryConfig> = {
  rate_limit:       { maxAttempts: 10, baseDelayMs: 2000,  maxDelayMs: 30000, backoffFactor: 2 },
  server_error:     { maxAttempts: 10, baseDelayMs: 5000,  maxDelayMs: 60000, backoffFactor: 2 },
  context_overflow: { maxAttempts: 2,  baseDelayMs: 500,   maxDelayMs: 500,   backoffFactor: 1 },
};

function classifyError(err: Error): { category: ErrorCategory; statusCode: number } {
  const msg = err.message;
  const lowerMsg = msg.toLowerCase();

  if (err.name === 'AbortError') {
    return { category: 'abort', statusCode: 0 };
  }

  // Parse HTTP status from Rust error format: "HTTP 429: ..."
  const httpMatch = msg.match(/HTTP (\d{3})/);
  const statusCode = httpMatch ? parseInt(httpMatch[1]) : 0;

  // Context overflow — various provider error formats
  if (
    lowerMsg.includes('context_length') ||
    lowerMsg.includes('context length') ||
    lowerMsg.includes('maximum context') ||
    lowerMsg.includes('too many tokens') ||
    lowerMsg.includes('token limit') ||
    lowerMsg.includes('prompt is too long') ||
    lowerMsg.includes('payload size exceeds') ||
    lowerMsg.includes('request too large') ||
    (lowerMsg.includes('max_tokens') && lowerMsg.includes('exceed')) ||
    (statusCode === 400 && (
      lowerMsg.includes('length') ||
      lowerMsg.includes('tokens') ||
      lowerMsg.includes('too long') ||
      lowerMsg.includes('too large')
    ))
  ) {
    return { category: 'context_overflow', statusCode };
  }

  // Rate limit
  if (statusCode === 429 || lowerMsg.includes('rate limit') || lowerMsg.includes('too many requests')) {
    return { category: 'rate_limit', statusCode: 429 };
  }

  // Auth errors (non-retryable)
  if (statusCode === 401 || statusCode === 403) {
    return { category: 'auth', statusCode };
  }

  // Server errors (5xx)
  if (statusCode >= 500 && statusCode < 600) {
    return { category: 'server_error', statusCode };
  }

  // Tool unsupported
  if (
    lowerMsg.includes('tools') ||
    lowerMsg.includes('function') ||
    lowerMsg.includes('tool_use') ||
    lowerMsg.includes('not supported') ||
    lowerMsg.includes('unrecognized request argument')
  ) {
    return { category: 'tool_unsupported', statusCode };
  }

  return { category: 'unknown', statusCode };
}

function calculateRetryDelay(config: RetryConfig, attempt: number): number {
  return Math.min(config.baseDelayMs * Math.pow(config.backoffFactor, attempt), config.maxDelayMs);
}

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
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_MAX_ITERATIONS = 15;
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

  constructor() {
    this.toolRegistry = initializeTools();
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Send a user message and run the agentic loop.
   * Accepts the extended AgentCallbacks or the legacy StreamCallbacks
   * (the extra fields are all optional).
   */
  send(
    userMessage: string,
    sessionId: string,
    callbacks: AgentCallbacks,
  ): void {
    this.abort();
    this.aborted = false;

    // Flush any pending injected messages to history first
    this.flushPendingMessages();

    // Remove all trailing orphaned user messages (from failed requests / injections)
    while (this.messages.length > 0 && this.messages[this.messages.length - 1].role === 'user') {
      this.messages.pop();
    }

    this.messages.push({ role: 'user', content: userMessage });
    this.trimHistory();

    this.runLoop(sessionId, callbacks).catch((e) => {
      callbacks.onError(e instanceof Error ? e : new Error(String(e)));
    });
  }

  /**
   * Inject a user message while the agent is actively working.
   * The message will be seen by the LLM at the next iteration checkpoint,
   * allowing the model to decide whether to incorporate it into the
   * current workflow or defer it.
   */
  injectMessage(message: string): void {
    this.pendingUserMessages.push(message);
  }

  /**
   * Resume the agent after an error or interruption.
   * Re-enters the agentic loop without adding a new user message,
   * picking up from the current conversation state.
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

  /** Cancel the current request / tool execution. */
  abort(): void {
    this.aborted = true;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /** Clear conversation history and reset state. */
  clear(): void {
    this.abort();
    this.messages = [];
    this.pendingUserMessages = [];
    this.toolsSupported = true;
  }

  /** Get current conversation messages (excluding system prompt). */
  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /** Whether a request is currently in progress. */
  get isStreaming(): boolean {
    return this.abortController !== null;
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
    };

    const maxIterations: number = settings.aiAgentMaxIterations ?? DEFAULT_MAX_ITERATIONS;

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

      // Refresh terminal context each iteration (captures latest output)
      const ctx = gatherContext(sessionId, TOKEN_BUDGET.systemContextLines);
      const hasTools = useTools && toolSpecs.length > 0;
      const systemPrompt = buildSystemPrompt(ctx, hasTools);

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
          this.messages.push({ role: 'assistant', content: fixed });

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
        this.messages.push({
          role: 'assistant',
          content: response.text || '',
          tool_calls: response.toolCalls,
        });

        // ── Execute each tool call ──
        const toolCtx = buildToolContext(sessionId);

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

          const result = await this.executeSingleTool(
            toolCall,
            toolCtx,
            callbacks,
          );

          // Store tool result in history
          this.messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: result.isError ? `Error: ${result.result}` : result.result,
          });

          callbacks.onToolResult?.(
            toolCall.function.name,
            result.result,
            result.isError,
          );

          // Consecutive error tracking
          if (result.isError) {
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
            const compressed = this.compressContext();
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
      // No agent mode teardown needed — terminal was never modified
    }
  }

  // ─── Execute a single tool call ────────────────────────────

  private async executeSingleTool(
    toolCall: ToolCall,
    toolCtx: ReturnType<typeof buildToolContext>,
    callbacks: AgentCallbacks,
  ): Promise<{ result: string; isError: boolean }> {
    const toolName = toolCall.function.name;
    const handler = this.toolRegistry.get(toolName);

    if (!handler) {
      return { result: `Unknown tool "${toolName}"`, isError: true };
    }

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      args = {};
    }

    // ── Trust level check (read real-time value) ──
    const currentTrustLevel: number = loadSettings().aiAgentTrustLevel ?? 0;
    const needsConfirm = this.toolRegistry.shouldConfirm(toolName, args, currentTrustLevel);

    // Notify UI that a tool call is about to happen
    callbacks.onToolCall?.(toolName, args);

    // ── Confirmation gate ──
    if (needsConfirm) {
      if (!callbacks.onConfirmRequired) {
        // No confirmation handler → reject for safety
        return { result: 'User confirmation required but no handler available.', isError: false };
      }

      const approved = await callbacks.onConfirmRequired(toolName, args);

      if (approved === false) {
        return { result: 'User rejected this action.', isError: false };
      }

      if (typeof approved === 'string') {
        // User edited the command
        const editedArgs = { ...args, command: approved };
        return this.safeExecute(handler, editedArgs, toolCtx);
      }

      // approved === true → fall through to execute
    }

    return this.safeExecute(handler, args, toolCtx);
  }

  /** Execute a tool handler with error boundary + 60s timeout. */
  private async safeExecute(
    handler: { execute: (args: Record<string, unknown>, ctx: ReturnType<typeof buildToolContext>) => Promise<string> },
    args: Record<string, unknown>,
    ctx: ReturnType<typeof buildToolContext>,
  ): Promise<{ result: string; isError: boolean }> {
    try {
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
  ): Promise<{ text: string; toolCalls?: ToolCall[] }> {
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
        onComplete: (fullText, toolCalls) => {
          if (settled) return;
          settled = true;
          resolve({ text: fullText, toolCalls: toolCalls ?? undefined });
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
    // consecutive user messages (which break Anthropic).
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'user') {
      last.content += `\n\n${combined}`;
    } else {
      this.messages.push({ role: 'user', content: combined });
    }
  }

  // ─── Context Compression ─────────────────────────────────
  //
  // When the model reports context overflow, aggressively compress
  // old messages to fit within limits:
  //   Phase 1: Truncate long tool outputs and assistant messages
  //   Phase 2: Remove oldest message turns (keeping tool pairs intact)

  private compressContext(): boolean {
    if (this.messages.length <= 4) return false;

    let compressed = false;
    const TOOL_MAX = 200;
    const ASSISTANT_MAX = 500;

    // Phase 1: Truncate long content
    for (const msg of this.messages) {
      if (msg.role === 'tool' && msg.content.length > TOOL_MAX) {
        msg.content = msg.content.slice(0, TOOL_MAX) + '\n...(output truncated)';
        compressed = true;
      }
      if (msg.role === 'assistant' && msg.content.length > ASSISTANT_MAX) {
        msg.content = msg.content.slice(0, ASSISTANT_MAX) + '...(truncated)';
        compressed = true;
      }
    }

    // Phase 2: Remove oldest messages until count halved
    // Keeps tool_call/tool_result pairs together
    const targetCount = Math.max(4, Math.ceil(this.messages.length * 0.5));

    while (this.messages.length > targetCount) {
      const first = this.messages.shift()!;
      compressed = true;

      // If we removed an assistant with tool_calls, also remove its tool results
      if (first.role === 'assistant' && first.tool_calls) {
        const tcIds = new Set(first.tool_calls.map((tc) => tc.id));
        while (
          this.messages.length > 0 &&
          this.messages[0].role === 'tool' &&
          tcIds.has(this.messages[0].tool_call_id!)
        ) {
          this.messages.shift();
        }
      }

      // Clean up any orphaned tool results at the start
      while (this.messages.length > 0 && this.messages[0].role === 'tool') {
        this.messages.shift();
      }
    }

    return compressed;
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

  // ─── History Management ───────────────────────────────────

  /**
   * Trim message history by total character count.
   * Removes oldest messages first, preserving tool_call / tool pairs.
   */
  private trimHistory(): void {
    const maxChars = TOKEN_BUDGET.messageHistoryMaxChars;
    let totalChars = this.messages.reduce((sum, m) => sum + m.content.length, 0);

    while (totalChars > maxChars && this.messages.length > 2) {
      const removed = this.messages.shift()!;
      totalChars -= removed.content.length;

      // If we removed an assistant message with tool_calls,
      // also remove the corresponding tool-result messages
      if (removed.role === 'assistant' && removed.tool_calls) {
        const tcIds = new Set(removed.tool_calls.map((tc) => tc.id));
        for (let i = this.messages.length - 1; i >= 0; i--) {
          if (
            this.messages[i].role === 'tool' &&
            tcIds.has(this.messages[i].tool_call_id!)
          ) {
            totalChars -= this.messages[i].content.length;
            this.messages.splice(i, 1);
          }
        }
      }
    }
  }
}

// ─── Legacy Alias ────────────────────────────────────────────────
// ai-capsule.ts imports `AIAgent` — keep backward-compatible export.
export { ToolAgent as AIAgent };
