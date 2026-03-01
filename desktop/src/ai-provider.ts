// ─── AI Provider Abstraction Layer ────────────────────────────────
// Unified interface for OpenAI-compatible, Anthropic, and Google Gemini APIs
// with SSE streaming support.

import { invoke } from '@tauri-apps/api/core';

// ─── Types ──────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onComplete: (fullText: string) => void;
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
  chat(messages: ChatMessage[], callbacks: StreamCallbacks, signal?: AbortSignal): void;
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

export async function fetchModels(entry: AIProviderEntry): Promise<string[]> {
  switch (entry.type) {
    case 'openai':    return fetchOpenAIModels(entry);
    case 'anthropic': return fetchAnthropicModels(entry);
    case 'gemini':    return fetchGeminiModels(entry);
    default:          return [];
  }
}

async function fetchOpenAIModels(entry: AIProviderEntry): Promise<string[]> {
  const url = `${entry.baseUrl.replace(/\/+$/, '')}/v1/models`;
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

// ─── SSE Parser ─────────────────────────────────────────────────

async function parseSSEStream(
  response: Response,
  onData: (data: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) {
        reader.cancel();
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;
          onData(data);
        }
      }
    }

    // Process remaining buffer
    if (buffer.trim().startsWith('data: ')) {
      const data = buffer.trim().slice(6);
      if (data !== '[DONE]') onData(data);
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── OpenAI Compatible Provider ─────────────────────────────────

class OpenAIProvider implements AIProvider {
  constructor(private config: AIProviderConfig) {}

  chat(messages: ChatMessage[], callbacks: StreamCallbacks, signal?: AbortSignal): void {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;

    const body = {
      model: this.config.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: true,
    };

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
      const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/models`;
      const headers: Record<string, string> = {};
      if (this.config.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private async doStream(
    url: string,
    headers: Record<string, string>,
    body: object,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    let fullText = '';
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        callbacks.onError(new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`));
        return;
      }

      await parseSSEStream(res, (data) => {
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            callbacks.onToken(delta);
          }
        } catch { /* skip malformed chunks */ }
      }, signal);

      callbacks.onComplete(fullText);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      callbacks.onError(e as Error);
    }
  }
}

// ─── Anthropic Provider ─────────────────────────────────────────

class AnthropicProvider implements AIProvider {
  constructor(private config: AIProviderConfig) {}

  chat(messages: ChatMessage[], callbacks: StreamCallbacks, signal?: AbortSignal): void {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/messages`;

    // Separate system message from conversation messages
    const systemMessages = messages.filter((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      stream: true,
      messages: conversationMessages.map((m) => ({ role: m.role, content: m.content })),
    };

    if (systemMessages.length > 0) {
      body.system = systemMessages.map((m) => m.content).join('\n\n');
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
      const url = `${this.config.baseUrl.replace(/\/+$/, '')}/v1/messages`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private async doStream(
    url: string,
    headers: Record<string, string>,
    body: object,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    let fullText = '';
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        callbacks.onError(new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`));
        return;
      }

      await parseSSEStream(res, (data) => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta') {
            const text = parsed.delta?.text;
            if (text) {
              fullText += text;
              callbacks.onToken(text);
            }
          }
        } catch { /* skip malformed chunks */ }
      }, signal);

      callbacks.onComplete(fullText);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      callbacks.onError(e as Error);
    }
  }
}

// ─── Google Gemini Provider ─────────────────────────────────────

class GeminiProvider implements AIProvider {
  constructor(private config: AIProviderConfig) {}

  chat(messages: ChatMessage[], callbacks: StreamCallbacks, signal?: AbortSignal): void {
    const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/v1beta/models/${this.config.model}:streamGenerateContent?alt=sse`;

    // Convert messages to Gemini format
    const systemMessages = messages.filter((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    const contents = conversationMessages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

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
      const res = await fetch(url, {
        headers: { 'x-goog-api-key': this.config.apiKey },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  private async doStream(
    url: string,
    headers: Record<string, string>,
    body: object,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    let fullText = '';
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        callbacks.onError(new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`));
        return;
      }

      await parseSSEStream(res, (data) => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            fullText += text;
            callbacks.onToken(text);
          }
        } catch { /* skip malformed chunks */ }
      }, signal);

      callbacks.onComplete(fullText);
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
