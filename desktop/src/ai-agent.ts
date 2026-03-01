// ─── AI Agent ─────────────────────────────────────────────────────
// Terminal-aware AI agent that gathers context from the active terminal
// session and manages multi-turn conversations with streaming responses.

import { ChatMessage, StreamCallbacks, createProvider, AIProviderConfig, resolveActiveModel, resolveModel } from './ai-provider';
import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { loadSettings } from './themes';
import { getLanguage } from './i18n';

// ─── Terminal Context ───────────────────────────────────────────

export interface TerminalContext {
  recentOutput: string;
  serverInfo: string;
  isSSH: boolean;
}

export function gatherContext(sessionId: string, maxLines: number): TerminalContext {
  // Serialize the terminal buffer and extract recent lines
  let recentOutput = '';
  const raw = TerminalRegistry.serializeBuffer(sessionId);
  if (raw) {
    // Strip ANSI escape codes for a cleaner context
    const stripped = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    const lines = stripped.split('\n');
    const recent = lines.slice(-maxLines);
    recentOutput = recent.join('\n').trim();
  }

  // Gather server/system info from DrawerManager (SSH sessions)
  const info = DrawerManager.getServerInfo(sessionId);
  let serverInfo = '';
  let isSSH = false;
  if (info) {
    isSSH = true;
    serverInfo = `${info.username}@${info.host}:${info.port}`;
  }

  return { recentOutput, serverInfo, isSSH };
}

// ─── System Prompt Builder ──────────────────────────────────────

function buildSystemPrompt(ctx: TerminalContext): string {
  const lang = getLanguage();
  const langInstr = lang === 'zh'
    ? '请使用中文回复用户。'
    : 'Reply in the same language the user uses.';

  const envSection = ctx.isSSH
    ? `Connection: SSH (${ctx.serverInfo})`
    : `Connection: Local terminal`;

  const infoSection = ctx.serverInfo
    ? `\nSystem: ${ctx.serverInfo}`
    : '';

  const terminalSection = ctx.recentOutput
    ? `\nRecent terminal output (last lines):\n\`\`\`\n${ctx.recentOutput}\n\`\`\``
    : '\n(No recent terminal output available)';

  return `You are a terminal AI assistant embedded in a terminal application. Help the user work efficiently in their terminal environment.

Environment:
- ${envSection}${infoSection}
${terminalSection}

Instructions:
1. Each shell command MUST be in its own separate \`\`\`bash code block — one command per block, never combine multiple commands in a single block. This allows the user to run each command individually with one click.
2. NEVER put comments, explanations, or non-executable text inside \`\`\`bash blocks. All explanations go in plain text outside the code blocks.
3. Be concise. Prefer giving commands directly over lengthy explanations.
4. When a command could be destructive (rm -rf, sudo, DROP, etc.), add a brief warning before the command block.
5. If the terminal output shows an error, proactively help diagnose it.
6. ${langInstr}`;
}

// ─── AI Agent Class ─────────────────────────────────────────────

const MAX_HISTORY_PAIRS = 20;

export class AIAgent {
  private messages: ChatMessage[] = [];
  private abortController: AbortController | null = null;

  /** Send a user message and get a streaming response. */
  send(userMessage: string, sessionId: string, callbacks: StreamCallbacks): void {
    // Abort any in-flight request
    this.abort();

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

    // Gather fresh terminal context
    const ctx = gatherContext(sessionId, settings.aiContextLines);
    const systemPrompt = buildSystemPrompt(ctx);

    // Add user message to history
    this.messages.push({ role: 'user', content: userMessage });

    // Trim history if too long (keep recent pairs)
    this.trimHistory();

    // Build full message list: system + conversation
    const fullMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...this.messages,
    ];

    // Create provider and stream
    const provider = createProvider(providerConfig);
    this.abortController = new AbortController();

    provider.chat(fullMessages, {
      onToken: callbacks.onToken,
      onComplete: (fullText) => {
        // Store assistant response in history
        this.messages.push({ role: 'assistant', content: fullText });
        this.abortController = null;
        callbacks.onComplete(fullText);
      },
      onError: (error) => {
        // Remove the user message if the request failed
        if (this.messages.length > 0 && this.messages[this.messages.length - 1].role === 'user') {
          this.messages.pop();
        }
        this.abortController = null;
        callbacks.onError(error);
      },
    }, this.abortController.signal);
  }

  /** Cancel the current streaming request. */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /** Clear conversation history. */
  clear(): void {
    this.abort();
    this.messages = [];
  }

  /** Get current conversation messages (excluding system prompt). */
  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /** Whether a request is currently in progress. */
  get isStreaming(): boolean {
    return this.abortController !== null;
  }

  /** Keep only the most recent conversation pairs. */
  private trimHistory(): void {
    // Each pair is 2 messages (user + assistant), keep the last N pairs + trailing user
    const maxMessages = MAX_HISTORY_PAIRS * 2 + 1; // +1 for potential trailing user message
    if (this.messages.length > maxMessages) {
      // Remove from the front, keeping the most recent messages
      const excess = this.messages.length - maxMessages;
      // Ensure we remove complete pairs (multiples of 2)
      const removeCount = excess % 2 === 0 ? excess : excess + 1;
      this.messages.splice(0, removeCount);
    }
  }
}
