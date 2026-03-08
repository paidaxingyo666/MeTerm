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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on assistant messages that invoke tools. */
  tool_calls?: ToolCall[];
  /** Present on tool-result messages — references the originating ToolCall.id. */
  tool_call_id?: string;
  /** Tool name on tool-result messages (used by Gemini's functionResponse). */
  name?: string;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  /** Reasoning/thinking token (e.g. GLM reasoning_content, DeepSeek thinking). Displayed differently from content. */
  onReasoning?: (token: string) => void;
  /** Fired each time a complete tool call is parsed from the stream. */
  onToolCall?: (toolCall: ToolCall) => void;
  /** Called when streaming finishes. toolCalls is defined when the LLM requested tool invocations. */
  onComplete: (fullText: string, toolCalls?: ToolCall[]) => void;
  onError: (error: Error) => void;
}

export type ProviderType = 'openai' | 'anthropic' | 'gemini';

export interface AIProviderConfig {
  type: ProviderType;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
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
  baseUrl: string;
  models: string[];         // cached fetched model list
  enabledModels: string[];  // user-selected models to show in AI bar
}

export const DEFAULT_AI_PROVIDERS: AIProviderEntry[] = [
  { id: 'openai',    type: 'openai',    label: 'OpenAI',    apiKey: '', baseUrl: 'https://api.openai.com',                    models: [], enabledModels: [] },
  { id: 'anthropic', type: 'anthropic', label: 'Anthropic', apiKey: '', baseUrl: 'https://api.anthropic.com',                 models: [], enabledModels: [] },
  { id: 'gemini',    type: 'gemini',    label: 'Gemini',    apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com', models: [], enabledModels: [] },
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

// ─── OpenAI-Compatible URL Helpers ──────────────────────────────

/**
 * 判断 baseUrl 是否已经包含 API 版本路径（如 /v1, /v4 等）。
 * 若已包含，拼接端点时不再追加 /v1 前缀。
 * 典型场景：
 *   - OpenAI:   https://api.openai.com          → 需追加 /v1
 *   - Groq:     https://api.groq.com/openai      → 需追加 /v1
 *   - Z.ai:     https://open.bigmodel.cn/api/paas/v4  → 已含版本，不追加
 *   - Ollama:   http://localhost:11434            → 需追加 /v1
 */
function hasVersionPrefix(baseUrl: string): boolean {
  const path = baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/.test(path);
}

/**
 * 构建 OpenAI 兼容端点的完整 URL。
 * 自动判断 baseUrl 是否已包含版本路径，避免重复拼接 /v1。
 */
function buildOpenAIUrl(baseUrl: string, endpoint: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const prefix = hasVersionPrefix(base) ? '' : '/v1';
  return `${base}${prefix}${endpoint}`;
}

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
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const resp = await invoke<{ ok: boolean; status: number; body: string }>('fetch_ai_models', {
    request: {
      url,
      headers: Object.entries(headers),
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
  url: string,
  headers: Record<string, string>,
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
      url,
      headers: Object.entries(headers),
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
  const url = buildOpenAIUrl(entry.baseUrl, '/models');
  const headers: Record<string, string> = {};
  if (entry.apiKey) headers['Authorization'] = `Bearer ${entry.apiKey}`;
  const res = await nativeFetch(url, headers);
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
    const url = `${entry.baseUrl.replace(/\/+$/, '')}/v1/models`;
    const res = await nativeFetch(url, {
      'x-api-key': entry.apiKey,
      'anthropic-version': '2023-06-01',
    });
    if (res.ok) {
      const data = res.data as { data?: { id: string }[] };
      const models = ((data.data || []) as { id: string }[]).map((m) => m.id).sort();
      if (models.length > 0) return models;
    }
  } catch { /* fallback to hardcoded */ }
  return [...ANTHROPIC_FALLBACK_MODELS];
}

async function fetchGeminiModels(entry: AIProviderEntry): Promise<string[]> {
  const baseUrl = entry.baseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/v1beta/models`;
  const res = await nativeFetch(url, { 'x-goog-api-key': entry.apiKey });
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
      if (p.apiKey && p.enabledModels.length > 0) {
        return { entry: p, model: p.enabledModels[0] };
      }
    }
    // Fallback: first provider with API key, use default model
    for (const p of providers) {
      if (p.apiKey) {
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
    const url = buildOpenAIUrl(this.config.baseUrl, '/chat/completions');

    // Convert universal ChatMessage format → OpenAI API format
    const apiMessages = messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool' as const, tool_call_id: m.tool_call_id, content: m.content };
      }
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        return { role: 'assistant' as const, content: m.content || null, tool_calls: m.tool_calls };
      }
      return { role: m.role, content: m.content };
    });

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: apiMessages,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    this.doStream(url, headers, body, callbacks, signal);
  }

  async validateConfig(): Promise<{ ok: boolean; error?: string }> {
    try {
      // 优先尝试 /models 端点；部分兼容提供商（如智谱 Z.ai）不支持此端点，
      // 则 fallback 到发送一条最小 chat 请求来验证配置
      const modelsUrl = buildOpenAIUrl(this.config.baseUrl, '/models');
      const headers: Record<string, string> = {};
      if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      const res = await nativeFetch(modelsUrl, headers);
      if (res.ok) return { ok: true };

      // /models 404 → 可能是不支持该端点的兼容提供商，尝试 chat 端点
      if (res.status === 404) {
        const chatUrl = buildOpenAIUrl(this.config.baseUrl, '/chat/completions');
        const chatRes = await nativeFetch(chatUrl, {
          ...headers,
          'Content-Type': 'application/json',
        });
        // 400 = 请求格式错误（说明端点存在），401 = 认证失败
        if (chatRes.status === 400 || chatRes.ok) return { ok: true };
        if (chatRes.status === 401) return { ok: false, error: 'Invalid API key' };
        return { ok: false, error: `HTTP ${chatRes.status}` };
      }
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
    url: string,
    headers: Record<string, string>,
    body: object,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    let fullText = '';
    // Accumulate streamed tool_calls keyed by their array index
    const tcMap = new Map<number, { id: string; name: string; arguments: string }>();

    try {
      await nativeStreamPost(url, headers, body, (data) => {
        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (!choice) return;

          // ── Reasoning / thinking content (GLM, DeepSeek, etc.) ──
          const reasoningDelta = choice.delta?.reasoning_content;
          if (reasoningDelta) {
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

      callbacks.onComplete(fullText, toolCalls.length > 0 ? toolCalls : undefined);
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
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/messages`;

    const systemMessages = messages.filter((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    // Convert universal ChatMessage format → Anthropic API format
    // Anthropic uses content-block arrays and requires alternating user/assistant turns.
    const anthropicMessages: Record<string, unknown>[] = [];

    for (let i = 0; i < conversationMessages.length; i++) {
      const m = conversationMessages[i];

      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        // Assistant message with tool_use content blocks
        const content: unknown[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const tc of m.tool_calls) {
          let input: unknown = {};
          try { input = JSON.parse(tc.function.arguments); } catch { /* empty */ }
          content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
        anthropicMessages.push({ role: 'assistant', content });
      } else if (m.role === 'tool') {
        // Merge consecutive tool-result messages into a single user message
        const toolResults: unknown[] = [];
        let j = i;
        while (j < conversationMessages.length && conversationMessages[j].role === 'tool') {
          const tm = conversationMessages[j];
          toolResults.push({ type: 'tool_result', tool_use_id: tm.tool_call_id, content: tm.content });
          j++;
        }
        i = j - 1; // advance loop index past grouped messages
        anthropicMessages.push({ role: 'user', content: toolResults });
      } else if (m.role === 'assistant') {
        anthropicMessages.push({ role: 'assistant', content: m.content });
      } else {
        anthropicMessages.push({ role: 'user', content: m.content });
      }
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: true,
      messages: anthropicMessages,
    };

    if (systemMessages.length > 0) {
      body.system = systemMessages.map((m) => m.content).join('\n\n');
    }

    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };

    this.doStream(url, headers, body, callbacks, signal);
  }

  async validateConfig(): Promise<{ ok: boolean; error?: string }> {
    try {
      const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/models`;
      const res = await nativeFetch(url, {
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      });
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
    url: string,
    headers: Record<string, string>,
    body: object,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    let fullText = '';
    const toolCalls: ToolCall[] = [];
    let currentTC: { id: string; name: string; arguments: string } | null = null;

    try {
      await nativeStreamPost(url, headers, body, (data) => {
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
    const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/v1beta/models/${this.config.model}:streamGenerateContent?alt=sse`;

    const systemMessages = messages.filter((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    // Convert universal ChatMessage format → Gemini API format
    const contents: Record<string, unknown>[] = [];
    for (let i = 0; i < conversationMessages.length; i++) {
      const m = conversationMessages[i];

      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        // Model message with functionCall parts
        const parts: unknown[] = [];
        if (m.content) parts.push({ text: m.content });
        for (const tc of m.tool_calls) {
          let args: unknown = {};
          try { args = JSON.parse(tc.function.arguments); } catch { /* empty */ }
          parts.push({ functionCall: { name: tc.function.name, args } });
        }
        contents.push({ role: 'model', parts });
      } else if (m.role === 'tool') {
        // Group consecutive tool results into one user message with functionResponse parts
        const parts: unknown[] = [];
        let j = i;
        while (j < conversationMessages.length && conversationMessages[j].role === 'tool') {
          const tm = conversationMessages[j];
          parts.push({
            functionResponse: {
              name: tm.name,
              response: { content: tm.content },
            },
          });
          j++;
        }
        i = j - 1;
        contents.push({ role: 'user', parts });
      } else {
        contents.push({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
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
        parts: [{ text: systemMessages.map((m) => m.content).join('\n\n') }],
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

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-goog-api-key': this.config.apiKey,
    };

    this.doStream(url, headers, body, callbacks, signal);
  }

  async validateConfig(): Promise<{ ok: boolean; error?: string }> {
    try {
      const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
      const url = `${baseUrl}/v1beta/models/${this.config.model}`;
      const res = await nativeFetch(url, { 'x-goog-api-key': this.config.apiKey });
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
    url: string,
    headers: Record<string, string>,
    body: object,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    let fullText = '';
    const toolCalls: ToolCall[] = [];

    try {
      await nativeStreamPost(url, headers, body, (data) => {
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
