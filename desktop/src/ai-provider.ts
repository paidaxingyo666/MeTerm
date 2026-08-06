// ─── AI Provider Abstraction Layer ────────────────────────────────
// Unified interface for OpenAI-compatible, Anthropic, and Google Gemini APIs
// with SSE streaming support.

import { invoke, Channel } from '@tauri-apps/api/core';

// ─── Types ──────────────────────────────────────────────────────

/** A single tool call emitted by the LLM (OpenAI-style structure). */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Minimal tool specification passed to the provider for the API request. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

/**
 * A single content part inside a multimodal message.
 *
 * Legacy messages still use `content: string`. New multimodal messages
 * use `content: ContentPart[]`. Each provider's chat() implementation
 * is responsible for converting this into its own wire format.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      /** MIME type of the image data. */
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
      /** Base64-encoded image bytes (no data: prefix). */
      data: string;
    };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Plain text (legacy) or an array of content parts (multimodal). */
  content: string | ContentPart[];
  /** Present on assistant messages that invoke tools. */
  tool_calls?: ToolCall[];
  /** Present on tool-result messages — references the originating ToolCall.id. */
  tool_call_id?: string;
  /** Tool name on tool-result messages (used by Gemini's functionResponse). */
  name?: string;
  /**
   * Reasoning/thinking text emitted by the model on an assistant turn
   * (Qwen3, DeepSeek-R1, GLM, etc.). Some thinking-mode providers REQUIRE
   * this field to be echoed back on subsequent requests — otherwise the
   * API rejects with 400 "reasoning_content must be passed back". We keep
   * it on the message object so the provider's serializer can attach it.
   */
  reasoning_content?: string;
}

/** Convenience: turn a ChatMessage's content into a plain-text view. */
export function contentToText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .map(p => (p.type === 'text' ? p.text : `[image ${p.mediaType}]`))
    .join('\n');
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  /** Reasoning/thinking token (e.g. GLM reasoning_content, DeepSeek thinking). Displayed differently from content. */
  onReasoning?: (token: string) => void;
  /** Fired each time a complete tool call is parsed from the stream. */
  onToolCall?: (toolCall: ToolCall) => void;
  /**
   * Called when streaming finishes.
   * - toolCalls is defined when the LLM requested tool invocations.
   * - reasoning is the accumulated thinking-mode text (Qwen3 / DeepSeek /
   *   GLM); the agent must echo it back on the assistant message in
   *   subsequent requests for those providers.
   */
  onComplete: (fullText: string, toolCalls?: ToolCall[], reasoning?: string) => void;
  onError: (error: Error) => void;
}

export type ProviderType = 'openai' | 'anthropic' | 'gemini';

export interface AIProviderConfig {
  providerId: string;
  type: ProviderType;
  hasApiKey: boolean;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  /**
   * Whether to enable thinking / reasoning_content output on
   * thinking-mode providers (DeepSeek V4, Qwen3, GLM, MiMo). Plain
   * OpenAI / Anthropic / Gemini ignore the flag. Defaults to true on
   * the call site (settings.aiEnableThinking).
   */
  enableThinking?: boolean;
}

export interface AIProvider {
  chat(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    tools?: ToolSpec[],
  ): void;
  validateConfig(): Promise<{ ok: boolean; error?: string }>;
}

// ─── Multi-Provider Entry ───────────────────────────────────────

export interface AIProviderEntry {
  id: string;
  type: ProviderType;
  label: string;
  apiKey: string;
  /** Native broker presence flag; no saved key bytes are materialized here. */
  hasApiKey: boolean;
  /** Transient UI request to remove the native credential. */
  clearApiKey?: boolean;
  baseUrl: string;
  models: string[];         // cached fetched model list
  enabledModels: string[];  // user-selected models to show in AI bar
}

export const DEFAULT_AI_PROVIDERS: AIProviderEntry[] = [
  { id: 'openai',    type: 'openai',    label: 'OpenAI',    apiKey: '', hasApiKey: false, baseUrl: 'https://api.openai.com',                    models: [], enabledModels: [] },
  { id: 'anthropic', type: 'anthropic', label: 'Anthropic', apiKey: '', hasApiKey: false, baseUrl: 'https://api.anthropic.com',                 models: [], enabledModels: [] },
  { id: 'gemini',    type: 'gemini',    label: 'Gemini',    apiKey: '', hasApiKey: false, baseUrl: 'https://generativelanguage.googleapis.com', models: [], enabledModels: [] },
];

// ─── Presets (templates for adding new providers) ───────────────

export interface ProviderPreset {
  id: string;
  label: string;
  type: ProviderType;
  baseUrl: string;
  model: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openai',    label: 'OpenAI',    type: 'openai',    baseUrl: 'https://api.openai.com',                      model: 'gpt-4o' },
  { id: 'anthropic', label: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com',                   model: 'claude-sonnet-4-5-20250929' },
  { id: 'gemini',    label: 'Gemini',    type: 'gemini',    baseUrl: 'https://generativelanguage.googleapis.com',   model: 'gemini-2.0-flash' },
  { id: 'zhipu',     label: 'Z.ai',      type: 'openai',    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',       model: 'glm-4.5' },
  { id: 'ollama',    label: 'Ollama',    type: 'openai',    baseUrl: 'http://localhost:11434',                      model: 'llama3.1' },
  { id: 'groq',      label: 'Groq',      type: 'openai',    baseUrl: 'https://api.groq.com/openai',                model: 'llama-3.1-70b-versatile' },
];

// ─── Model Fetching ─────────────────────────────────────────────

const ANTHROPIC_FALLBACK_MODELS = [
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
];


/**
 * 通过 Tauri Rust 后端发起 HTTP GET 请求，完全绕过浏览器 CORS 限制。
 * 在 Windows WebView2 环境中，直接 fetch() 外部 API 可能因 CORS 策略失败；
 * 改由 reqwest（Rust）在系统层发起请求可解决此问题。
 */
async function nativeFetch(
  provider: Pick<AIProviderEntry, 'id' | 'type' | 'baseUrl'> | AIProviderConfig,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const resp = await invoke<{ ok: boolean; status: number; body: string }>('fetch_ai_models', {
    request: {
      providerId: 'id' in provider ? provider.id : provider.providerId,
      providerType: provider.type,
      baseUrl: provider.baseUrl,
      ...('model' in provider ? { model: provider.model } : {}),
    },
  });
  const data = resp.ok ? JSON.parse(resp.body) : null;
  return { ok: resp.ok, status: resp.status, data };
}

/**
 * 通过 Tauri Rust 后端发起 HTTP POST 请求并以流式方式读取 SSE 响应。
 * 解决 Windows WebView2 的 CORS 限制，替代浏览器 fetch() 用于 AI 流式聊天。
 */
async function nativeStreamPost(
  provider: AIProviderConfig,
  body: object,
  onData: (data: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw Object.assign(new Error('AbortError'), { name: 'AbortError' });

  return new Promise<void>((resolve, reject) => {
    const channel = new Channel<string>();
    let buffer = '';

    const onAbort = () => {
      reject(Object.assign(new Error('AbortError'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    channel.onmessage = (text: string) => {
      if (signal?.aborted) return;
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (data !== '[DONE]') onData(data);
        }
      }
    };

    invoke<void>('fetch_ai_stream', {
      request: {
        providerId: provider.providerId,
        providerType: provider.type,
        baseUrl: provider.baseUrl,
        model: provider.model,
      },
      body: JSON.stringify(body),
      onEvent: channel,
    }).then(() => {
      signal?.removeEventListener('abort', onAbort);
      if (!signal?.aborted) {
        // 处理流末尾可能残留的不完整行
        if (buffer.trim().startsWith('data: ')) {
          const data = buffer.trim().slice(6);
          if (data !== '[DONE]') onData(data);
        }
        resolve();
      }
    }).catch((e: unknown) => {
      signal?.removeEventListener('abort', onAbort);
      if (!signal?.aborted) reject(new Error(String(e)));
    });
  });
}

export async function fetchModels(entry: AIProviderEntry): Promise<string[]> {
  switch (entry.type) {
    case 'openai':    return fetchOpenAIModels(entry);
    case 'anthropic': return fetchAnthropicModels(entry);
    case 'gemini':    return fetchGeminiModels(entry);
    default:          return [];
  }
}

async function fetchOpenAIModels(entry: AIProviderEntry): Promise<string[]> {
  const res = await nativeFetch(entry);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = res.data as { data?: { id: string }[] };
  const skipPatterns = ['embedding', 'tts', 'whisper', 'dall-e', 'moderation', 'search', 'similarity', 'edit', 'insert', 'audio', 'realtime'];
  return ((data.data || []) as { id: string }[])
    .map((m) => m.id)
    .filter((id) => !skipPatterns.some((p) => id.includes(p)))
    .sort();
}

async function fetchAnthropicModels(entry: AIProviderEntry): Promise<string[]> {
  try {
    const res = await nativeFetch(entry);
    if (res.ok) {
      const data = res.data as { data?: { id: string }[] };
      const models = ((data.data || []) as { id: string }[]).map((m) => m.id).sort();
      if (models.length > 0) return models;
    }
  } catch { /* fallback to hardcoded */ }
  return [...ANTHROPIC_FALLBACK_MODELS];
}

async function fetchGeminiModels(entry: AIProviderEntry): Promise<string[]> {
  const res = await nativeFetch(entry);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = res.data as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
  return ((data.models || []) as { name: string; supportedGenerationMethods?: string[] }[])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .sort();
}

// ─── Active Model Resolution ────────────────────────────────────

export interface ResolvedModel {
  entry: AIProviderEntry;
  model: string;
}

/** Resolve active model string to a specific provider entry + model name. */
export function resolveActiveModel(
  providers: AIProviderEntry[],
  activeModel: string,
): ResolvedModel | null {
  if (activeModel === 'auto') {
    // First: provider with API key and enabled models
    for (const p of providers) {
      if (p.hasApiKey && p.enabledModels.length > 0) {
        return { entry: p, model: p.enabledModels[0] };
      }
    }
    // Fallback: first provider with API key, use default model
    for (const p of providers) {
      if (p.hasApiKey) {
        return { entry: p, model: resolveModel(p.type, 'auto') };
      }
    }
    return null;
  }

  // Format: "providerId:modelName"
  const sep = activeModel.indexOf(':');
  if (sep === -1) return null;
  const providerId = activeModel.slice(0, sep);
  const modelName = activeModel.slice(sep + 1);
  const entry = providers.find((p) => p.id === providerId);
  if (!entry) return null;
  return { entry, model: modelName };
}

// ─── OpenAI Compatible Provider ─────────────────────────────────

class OpenAIProvider implements AIProvider {
  constructor(private config: AIProviderConfig) {}

  chat(messages: ChatMessage[], callbacks: StreamCallbacks, signal?: AbortSignal, tools?: ToolSpec[]): void {
    // Convert a ContentPart[] (multimodal) payload into OpenAI's
    // content-parts shape. OpenAI uses `image_url` with data URIs.
    const toOpenAIParts = (parts: ContentPart[]): unknown[] => parts.map((p) => {
      if (p.type === 'text') return { type: 'text', text: p.text };
      return {
        type: 'image_url',
        image_url: { url: `data:${p.mediaType};base64,${p.data}` },
      };
    });

    // Convert universal ChatMessage format → OpenAI API format
    const apiMessages = messages.map((m) => {
      // Tool-result messages: OpenAI accepts either a string or a
      // content-parts array (vision-capable models only). We stringify
      // multimodal tool results since older models reject arrays here.
      if (m.role === 'tool') {
        const flat = typeof m.content === 'string'
          ? m.content
          : contentToText(m.content);
        return { role: 'tool' as const, tool_call_id: m.tool_call_id, content: flat };
      }
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        const c = typeof m.content === 'string'
          ? (m.content || null)
          : (contentToText(m.content) || null);
        const out: Record<string, unknown> = {
          role: 'assistant' as const,
          content: c,
          tool_calls: m.tool_calls,
        };
        // Echo back reasoning_content for thinking-mode providers.
        // DeepSeek V4 (and similar Qwen3/GLM/MiMo) MUST receive this
        // field on every assistant turn that carries tool_calls — even
        // as an empty string. Otherwise the API rejects with HTTP 400:
        // "The reasoning_content in the thinking mode must be passed
        // back to the API." Plain OpenAI silently ignores the extra.
        out.reasoning_content = m.reasoning_content ?? '';
        return out;
      }
      // Regular user / assistant / system messages: pass arrays through
      // as OpenAI content-parts so images reach the model.
      if (typeof m.content !== 'string') {
        const out: Record<string, unknown> = {
          role: m.role,
          content: toOpenAIParts(m.content),
        };
        if (m.role === 'assistant' && m.reasoning_content) {
          out.reasoning_content = m.reasoning_content;
        }
        return out;
      }
      const out: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.role === 'assistant' && m.reasoning_content) {
        out.reasoning_content = m.reasoning_content;
      }
      return out;
    });

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: apiMessages,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: true,
    };

    // Thinking-mode toggle. Different providers use different field
    // names; we send all of them and let each provider read the one
    // it knows. Unknown extras are ignored by OpenAI, Anthropic,
    // Gemini and Z.AI (verified per their docs).
    //   - DeepSeek V4 / Z.AI GLM: `thinking: { type: enabled|disabled }`
    //   - Qwen3 / DashScope:      `enable_thinking: true|false`
    //   - vLLM-served Qwen3:      `chat_template_kwargs.enable_thinking`
    if (typeof this.config.enableThinking === 'boolean') {
      const on = this.config.enableThinking;
      body.thinking = { type: on ? 'enabled' : 'disabled' };
      body.enable_thinking = on;
      body.chat_template_kwargs = { enable_thinking: on };
    }

    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    this.doStream(body, callbacks, signal);
  }

  async validateConfig(): Promise<{ ok: boolean; error?: string }> {
    try {
      // 优先尝试 /models 端点；部分兼容提供商（如智谱 Z.ai）不支持此端点，
      // 则 fallback 到发送一条最小 chat 请求来验证配置
      const res = await nativeFetch(this.config);
      if (res.ok) return { ok: true };
      // Some OpenAI-compatible services intentionally omit /models. A 404
      // still proves the bound authority is reachable without broadening the
      // native broker to an arbitrary endpoint probe.
      if (res.status === 404) return { ok: true };
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * Stream OpenAI chat completions.
   * Tool calls arrive incrementally via delta.tool_calls[].
   * Each tool_call chunk carries an index; the first chunk for an index
   * provides id + function.name, subsequent chunks append to function.arguments.
   */
  private async doStream(
    body: object,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    let fullText = '';
    let fullReasoning = '';
    // Accumulate streamed tool_calls keyed by their array index
    const tcMap = new Map<number, { id: string; name: string; arguments: string }>();

    try {
      await nativeStreamPost(this.config, body, (data) => {
        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (!choice) return;

          // ── Reasoning / thinking content (GLM, DeepSeek, Qwen3, etc.) ──
          // Accumulate so the agent can echo it back on the assistant
          // message — some providers (Qwen3) require this on every turn.
          const reasoningDelta = choice.delta?.reasoning_content;
          if (reasoningDelta) {
            fullReasoning += reasoningDelta;
            if (callbacks.onReasoning) {
              callbacks.onReasoning(reasoningDelta);
            } else {
              // Fallback: show reasoning as regular token if no dedicated handler
              callbacks.onToken(reasoningDelta);
            }
          }

          // ── Text content ──
          const textDelta = choice.delta?.content;
          if (textDelta) {
            fullText += textDelta;
            callbacks.onToken(textDelta);
          }

          // ── Streamed tool_calls ──
          const deltaTCs = choice.delta?.tool_calls;
          if (deltaTCs) {
            for (const dtc of deltaTCs) {
              const idx: number = dtc.index ?? 0;
              if (!tcMap.has(idx)) {
                tcMap.set(idx, { id: dtc.id || '', name: dtc.function?.name || '', arguments: '' });
              }
              const entry = tcMap.get(idx)!;
              if (dtc.id) entry.id = dtc.id;
              if (dtc.function?.name) entry.name = dtc.function.name;
              if (dtc.function?.arguments) entry.arguments += dtc.function.arguments;
            }
          }
        } catch { /* skip malformed chunks */ }
      }, signal);

      // Build final ToolCall array and notify
      const toolCalls: ToolCall[] = [];
      for (const [, tc] of tcMap) {
        const toolCall: ToolCall = {
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        };
        toolCalls.push(toolCall);
        callbacks.onToolCall?.(toolCall);
      }

      callbacks.onComplete(
        fullText,
        toolCalls.length > 0 ? toolCalls : undefined,
        fullReasoning || undefined,
      );
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      callbacks.onError(e as Error);
    }
  }
}

// ─── Anthropic Provider ─────────────────────────────────────────

class AnthropicProvider implements AIProvider {
  constructor(private config: AIProviderConfig) {}

  chat(messages: ChatMessage[], callbacks: StreamCallbacks, signal?: AbortSignal, tools?: ToolSpec[]): void {
    const systemMessages = messages.filter((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    // Turn a ContentPart[] into Anthropic content blocks.
    const toAnthropicBlocks = (parts: ContentPart[]): unknown[] => parts.map((p) => {
      if (p.type === 'text') return { type: 'text', text: p.text };
      return {
        type: 'image',
        source: { type: 'base64', media_type: p.mediaType, data: p.data },
      };
    });
    // Convert a string or ContentPart[] into an Anthropic text or block array.
    const contentToAnthropic = (c: string | ContentPart[]): unknown =>
      typeof c === 'string' ? c : toAnthropicBlocks(c);

    // Convert universal ChatMessage format → Anthropic API format
    // Anthropic uses content-block arrays and requires alternating user/assistant turns.
    const anthropicMessages: Record<string, unknown>[] = [];

    for (let i = 0; i < conversationMessages.length; i++) {
      const m = conversationMessages[i];

      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        // Assistant message with tool_use content blocks
        const content: unknown[] = [];
        if (typeof m.content === 'string') {
          if (m.content) content.push({ type: 'text', text: m.content });
        } else {
          content.push(...toAnthropicBlocks(m.content));
        }
        for (const tc of m.tool_calls) {
          let input: unknown = {};
          try { input = JSON.parse(tc.function.arguments); } catch { /* empty */ }
          content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
        anthropicMessages.push({ role: 'assistant', content });
      } else if (m.role === 'tool') {
        // Merge consecutive tool-result messages into a single user message.
        // tool_result.content can itself be a string OR an array of blocks
        // (Anthropic supports images inside tool_result).
        const toolResults: unknown[] = [];
        let j = i;
        while (j < conversationMessages.length && conversationMessages[j].role === 'tool') {
          const tm = conversationMessages[j];
          const tmContent = typeof tm.content === 'string'
            ? tm.content
            : toAnthropicBlocks(tm.content);
          toolResults.push({ type: 'tool_result', tool_use_id: tm.tool_call_id, content: tmContent });
          j++;
        }
        i = j - 1; // advance loop index past grouped messages
        anthropicMessages.push({ role: 'user', content: toolResults });
      } else if (m.role === 'assistant') {
        anthropicMessages.push({ role: 'assistant', content: contentToAnthropic(m.content) });
      } else {
        anthropicMessages.push({ role: 'user', content: contentToAnthropic(m.content) });
      }
    }

    // Merge consecutive same-role messages (Anthropic requires alternating roles).
    // This can happen when user messages are injected during an agent tool-call cycle.
    const mergedMessages: Record<string, unknown>[] = [];
    for (const msg of anthropicMessages) {
      const last = mergedMessages[mergedMessages.length - 1];
      if (last && last.role === msg.role) {
        // Normalize both to content-block arrays and concatenate
        const toBlocks = (c: unknown): unknown[] =>
          Array.isArray(c) ? c : [{ type: 'text', text: String(c) }];
        last.content = [...toBlocks(last.content), ...toBlocks(msg.content)];
      } else {
        mergedMessages.push({ ...msg });
      }
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: true,
      messages: mergedMessages,
    };

    if (systemMessages.length > 0) {
      // Prompt Cache beta: mark the system prompt as cacheable.
      // The system field accepts an array of content blocks; the last
      // block with cache_control becomes a cache breakpoint.  We pack
      // all system messages into a single cached text block.
      //
      // Cost impact: first call still pays full input tokens, but
      // subsequent calls within ~5 minutes with an identical prefix
      // only pay 10% for the cached portion.
      // System prompt is always text in MeTerm; flatten any accidental
      // multimodal content to plain text for the API.
      const combinedSystem = systemMessages
        .map((m) => (typeof m.content === 'string' ? m.content : contentToText(m.content)))
        .join('\n\n');
      body.system = [
        {
          type: 'text',
          text: combinedSystem,
          cache_control: { type: 'ephemeral' },
        },
      ];
    }

    if (tools && tools.length > 0) {
      const toolsArr = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
      // Cache the tool definitions too — they rarely change within a session.
      if (toolsArr.length > 0) {
        const last = toolsArr[toolsArr.length - 1] as Record<string, unknown>;
        last.cache_control = { type: 'ephemeral' };
      }
      body.tools = toolsArr;
    }

    this.doStream(body, callbacks, signal);
  }

  async validateConfig(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await nativeFetch(this.config);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * Stream Anthropic messages.
   * Tool calls arrive as: content_block_start (type=tool_use) → content_block_delta
   * (type=input_json_delta) → content_block_stop.
   */
  private async doStream(
    body: object,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    let fullText = '';
    const toolCalls: ToolCall[] = [];
    let currentTC: { id: string; name: string; arguments: string } | null = null;

    try {
      await nativeStreamPost(this.config, body, (data) => {
        try {
          const parsed = JSON.parse(data);

          if (parsed.type === 'content_block_start') {
            const block = parsed.content_block;
            if (block?.type === 'tool_use') {
              currentTC = { id: block.id, name: block.name, arguments: '' };
            }
          } else if (parsed.type === 'content_block_delta') {
            if (parsed.delta?.type === 'text_delta') {
              const text = parsed.delta.text;
              if (text) {
                fullText += text;
                callbacks.onToken(text);
              }
            } else if (parsed.delta?.type === 'input_json_delta' && currentTC) {
              currentTC.arguments += parsed.delta.partial_json || '';
            }
          } else if (parsed.type === 'content_block_stop') {
            if (currentTC) {
              const tc: ToolCall = {
                id: currentTC.id,
                type: 'function',
                function: { name: currentTC.name, arguments: currentTC.arguments },
              };
              toolCalls.push(tc);
              callbacks.onToolCall?.(tc);
              currentTC = null;
            }
          }
        } catch { /* skip malformed chunks */ }
      }, signal);

      callbacks.onComplete(fullText, toolCalls.length > 0 ? toolCalls : undefined);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      callbacks.onError(e as Error);
    }
  }
}

// ─── Google Gemini Provider ─────────────────────────────────────

class GeminiProvider implements AIProvider {
  constructor(private config: AIProviderConfig) {}

  chat(messages: ChatMessage[], callbacks: StreamCallbacks, signal?: AbortSignal, tools?: ToolSpec[]): void {
    const systemMessages = messages.filter((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    // Turn a ContentPart[] into Gemini parts.
    const toGeminiParts = (parts: ContentPart[]): unknown[] => parts.map((p) => {
      if (p.type === 'text') return { text: p.text };
      return { inlineData: { mimeType: p.mediaType, data: p.data } };
    });
    const contentToGeminiParts = (c: string | ContentPart[]): unknown[] =>
      typeof c === 'string' ? [{ text: c }] : toGeminiParts(c);

    // Convert universal ChatMessage format → Gemini API format
    const contents: Record<string, unknown>[] = [];
    for (let i = 0; i < conversationMessages.length; i++) {
      const m = conversationMessages[i];

      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        // Model message with functionCall parts
        const parts: unknown[] = [];
        if (typeof m.content === 'string') {
          if (m.content) parts.push({ text: m.content });
        } else {
          parts.push(...toGeminiParts(m.content));
        }
        for (const tc of m.tool_calls) {
          let args: unknown = {};
          try { args = JSON.parse(tc.function.arguments); } catch { /* empty */ }
          parts.push({ functionCall: { name: tc.function.name, args } });
        }
        contents.push({ role: 'model', parts });
      } else if (m.role === 'tool') {
        // Group consecutive tool results into one user message with functionResponse parts.
        // Gemini's functionResponse doesn't accept images; if a tool result
        // is multimodal, we also append a follow-up user message with the image.
        const parts: unknown[] = [];
        const trailingImages: unknown[] = [];
        let j = i;
        while (j < conversationMessages.length && conversationMessages[j].role === 'tool') {
          const tm = conversationMessages[j];
          if (typeof tm.content === 'string') {
            parts.push({ functionResponse: { name: tm.name, response: { content: tm.content } } });
          } else {
            // Text parts stay inside functionResponse; image parts go
            // into a trailing user turn so the model actually sees them.
            const texts = tm.content.filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text').map(p => p.text).join('\n');
            parts.push({ functionResponse: { name: tm.name, response: { content: texts || '[see attached screenshot]' } } });
            for (const p of tm.content) {
              if (p.type === 'image') {
                trailingImages.push({ inlineData: { mimeType: p.mediaType, data: p.data } });
              }
            }
          }
          j++;
        }
        i = j - 1;
        contents.push({ role: 'user', parts });
        if (trailingImages.length > 0) {
          contents.push({
            role: 'user',
            parts: [{ text: '[attached screenshots from the previous tool call]' }, ...trailingImages],
          });
        }
      } else {
        contents.push({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: contentToGeminiParts(m.content),
        });
      }
    }

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: this.config.maxTokens,
        temperature: this.config.temperature,
      },
    };

    if (systemMessages.length > 0) {
      body.systemInstruction = {
        parts: [{
          text: systemMessages
            .map((m) => (typeof m.content === 'string' ? m.content : contentToText(m.content)))
            .join('\n\n'),
        }],
      };
    }

    if (tools && tools.length > 0) {
      body.tools = [{
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      }];
    }

    this.doStream(body, callbacks, signal);
  }

  async validateConfig(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await nativeFetch(this.config);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * Stream Gemini generateContent.
   * Function calls arrive as functionCall parts (not streamed incrementally).
   * Gemini does not provide tool-call IDs so we synthesize one.
   */
  private async doStream(
    body: object,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    let fullText = '';
    const toolCalls: ToolCall[] = [];

    try {
      await nativeStreamPost(this.config, body, (data) => {
        try {
          const parsed = JSON.parse(data);
          const parts = parsed.candidates?.[0]?.content?.parts;
          if (!parts) return;

          for (const part of parts) {
            if (part.text) {
              fullText += part.text;
              callbacks.onToken(part.text);
            }
            if (part.functionCall) {
              const tc: ToolCall = {
                id: `gemini_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                type: 'function',
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args ?? {}),
                },
              };
              toolCalls.push(tc);
              callbacks.onToolCall?.(tc);
            }
          }
        } catch { /* skip malformed chunks */ }
      }, signal);

      callbacks.onComplete(fullText, toolCalls.length > 0 ? toolCalls : undefined);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      callbacks.onError(e as Error);
    }
  }
}

// ─── Auto Model Resolution ──────────────────────────────────────

const AUTO_MODEL_DEFAULTS: Record<ProviderType, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-5-20250929',
  gemini: 'gemini-2.0-flash',
};

/** Resolve 'auto' model to the default model for the given provider type. */
export function resolveModel(providerType: ProviderType, model: string): string {
  if (model !== 'auto') return model;
  return AUTO_MODEL_DEFAULTS[providerType] || 'gpt-4o';
}

/** Get the default base URL for a provider type. */
export function getDefaultBaseUrl(providerType: ProviderType): string {
  const defaults: Record<ProviderType, string> = {
    openai: 'https://api.openai.com',
    anthropic: 'https://api.anthropic.com',
    gemini: 'https://generativelanguage.googleapis.com',
  };
  return defaults[providerType] || 'https://api.openai.com';
}

// ─── Factory ────────────────────────────────────────────────────

export function createProvider(config: AIProviderConfig): AIProvider {
  switch (config.type) {
    case 'openai':
      return new OpenAIProvider(config);
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'gemini':
      return new GeminiProvider(config);
    default:
      throw new Error(`Unknown provider type: ${config.type}`);
  }
}
