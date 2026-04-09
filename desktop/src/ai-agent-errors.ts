// ─── AI Agent: Error Classification & Retry Config ────────────
// Categorizes LLM/provider errors so the agentic loop can decide
// whether to retry, compress context, degrade tools, or bubble up.

export type ErrorCategory =
  | 'rate_limit'
  | 'server_error'
  | 'context_overflow'
  | 'auth'
  | 'tool_unsupported'
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

export function calculateRetryDelay(config: RetryConfig, attempt: number): number {
  return Math.min(config.baseDelayMs * Math.pow(config.backoffFactor, attempt), config.maxDelayMs);
}
