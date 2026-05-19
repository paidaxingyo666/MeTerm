// ─── AI Agent: Error Classification & Retry Config ────────────
// Categorizes LLM/provider errors so the agentic loop can decide
// whether to retry, compress context, degrade tools, or bubble up.

export type ErrorCategory =
  | 'rate_limit'
  | 'server_error'
  | 'context_overflow'
  | 'auth'
  | 'tool_unsupported'
  /**
   * Transport-level transient failures: DNS, TCP reset, TLS handshake,
   * connection closed mid-stream, socket timeout — i.e. the kind of
   * blip where retrying after a short backoff usually succeeds.
   * Carries no HTTP status code (the request never made it round-trip).
   */
  | 'network'
  | 'abort'
  | 'unknown';

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

export const RETRY_CONFIGS: Record<string, RetryConfig> = {
  rate_limit:       { maxAttempts: 10, baseDelayMs: 2000,  maxDelayMs: 30000, backoffFactor: 2 },
  server_error:     { maxAttempts: 10, baseDelayMs: 5000,  maxDelayMs: 60000, backoffFactor: 2 },
  context_overflow: { maxAttempts: 2,  baseDelayMs: 500,   maxDelayMs: 500,   backoffFactor: 1 },
  // Network blips usually clear quickly; back off fast and try a few
  // times before giving up. 5 attempts ≈ 1s + 2s + 4s + 8s + 10s = 25s
  // worst-case wait, which is well under the user's patience window
  // but enough to ride out a WiFi flap or a brief carrier hiccup.
  network:          { maxAttempts: 5,  baseDelayMs: 1000,  maxDelayMs: 10000, backoffFactor: 2 },
};

export function classifyError(err: Error): { category: ErrorCategory; statusCode: number } {
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

  // Transient transport-level failures — these never reach the
  // server, so they have no HTTP status. reqwest's default message is
  // "error sending request for url (...)"; OkHttp / Go / etc. produce
  // variants matched below. Putting this BEFORE the HTTP-status checks
  // makes sure a "connection reset by peer" doesn't get mis-bucketed.
  if (statusCode === 0) {
    if (
      lowerMsg.includes('error sending request') ||  // reqwest
      lowerMsg.includes('connection reset') ||
      lowerMsg.includes('connection refused') ||
      lowerMsg.includes('connection closed') ||
      lowerMsg.includes('connection aborted') ||
      lowerMsg.includes('connection error') ||
      lowerMsg.includes('broken pipe') ||
      lowerMsg.includes('eof') ||
      lowerMsg.includes('tls') ||
      lowerMsg.includes('ssl') ||
      lowerMsg.includes('handshake') ||
      lowerMsg.includes('dns') ||
      lowerMsg.includes('lookup') ||
      lowerMsg.includes('resolve') ||
      lowerMsg.includes('dial tcp') ||
      lowerMsg.includes('network is unreachable') ||
      lowerMsg.includes('no route to host') ||
      lowerMsg.includes('temporary failure') ||
      lowerMsg.includes('timeout') ||
      lowerMsg.includes('timed out') ||
      lowerMsg.includes('failed to fetch')
    ) {
      return { category: 'network', statusCode };
    }
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

  // Tool unsupported — must mention tool/function/tool_use AND a
  // "not supported / unsupported / unrecognized" verb. Just matching
  // "not supported" alone was overreaching: a 400 like
  //   "Not supported model claude-sonnet-4-5-20250929"
  // (model identity, nothing to do with tools) would flip
  // toolsSupported=false for the rest of the session, and after the
  // user switched to a working model the agent kept sending
  // tools=undefined, forcing Qwen-family models (MiMo / Qwen / GLM)
  // to emit inline `<tool_call>` text instead of native tool calls.
  const mentionsTooling =
    lowerMsg.includes('tool') ||
    lowerMsg.includes('function');
  const looksUnsupported =
    lowerMsg.includes('not supported') ||
    lowerMsg.includes('unsupported') ||
    lowerMsg.includes("doesn't support") ||
    lowerMsg.includes('does not support') ||
    lowerMsg.includes('not available') ||
    lowerMsg.includes('unrecognized request argument');
  if (
    (mentionsTooling && looksUnsupported) ||
    lowerMsg.includes('tool_use')
  ) {
    return { category: 'tool_unsupported', statusCode };
  }

  return { category: 'unknown', statusCode };
}

export function calculateRetryDelay(config: RetryConfig, attempt: number): number {
  return Math.min(config.baseDelayMs * Math.pow(config.backoffFactor, attempt), config.maxDelayMs);
}
