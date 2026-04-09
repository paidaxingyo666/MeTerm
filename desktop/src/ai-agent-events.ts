// ─── AI Agent: Event Types & Async Queue ──────────────────
// Typed union of events emitted by the agent's AsyncGenerator
// main loop, plus a small queue helper that lets callback-style
// producers drive a pull-based async iterator.
//
// The existing `ToolAgent.send()` (callback-based) stays in place
// as a compatibility path.  New callers can use `ToolAgent.run()`
// which yields these events — enabling structured consumption,
// easier cancellation (AbortSignal cleanup), and a smoother path
// toward Claude-Code-style streaming UI.

import type { ToolCall } from './ai-provider';

// ─── AgentEvent Union ───────────────────────────────────────

export type AgentEvent =
  /** A new agentic iteration is starting (iteration >= 1). */
  | { type: 'iteration_start'; iteration: number }
  /** Streaming text token from LLM. */
  | { type: 'stream_token'; token: string }
  /** Reasoning/thinking token (for models that emit thought tokens). */
  | { type: 'reasoning_token'; token: string }
  /** A thinking segment has ended — LLM emitted text before tool calls. */
  | { type: 'thinking_complete'; text: string }
  /** A tool is about to be executed. */
  | { type: 'tool_call_start'; toolName: string; args: Record<string, unknown>; callId: string }
  /** Tool execution finished. */
  | {
      type: 'tool_call_result';
      toolName: string;
      callId: string;
      result: string;
      isError: boolean;
    }
  /** Tool returned image attachments (e.g. read_screen). Fires AFTER tool_call_result. */
  | {
      type: 'tool_call_images';
      toolName: string;
      images: Array<{
        mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
        data: string;
        label?: string;
      }>;
    }
  /**
   * The agent needs user confirmation to run a tool.
   * The consumer MUST call `resolve(decision)` exactly once:
   *   - true   → approve
   *   - false  → reject
   *   - string → approve with edited command
   * Until resolved, the agent is paused.
   */
  | {
      type: 'tool_confirm_required';
      toolName: string;
      args: Record<string, unknown>;
      resolve: (decision: boolean | string) => void;
    }
  /** The agent finalized an assistant message (no more tool calls this turn). */
  | { type: 'assistant_message'; content: string }
  /** The entire run has completed successfully. */
  | { type: 'complete'; text: string }
  /** The run was aborted (user / abort signal). */
  | { type: 'aborted'; stepsCompleted: number }
  /** Tools were disabled because the model doesn't support them. */
  | { type: 'degraded'; reason: string }
  /** A transient error is being retried with backoff. */
  | { type: 'retrying'; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  /** The context window was compressed to fit within model limits. */
  | { type: 'context_compressed' }
  /** Unrecoverable error — the run will stop after this event. */
  | { type: 'error'; error: Error };

// Silence unused-import warning — ToolCall is used by consumers importing
// from this module. Keep the import so future callId/ToolCall references
// stay in this file's re-export surface.
export type _ExportedForDocs = ToolCall;

// ─── AsyncEventQueue ────────────────────────────────────────
// Producer pushes events synchronously, consumer pulls them via
// async iteration. Supports graceful close + abort-by-error.

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;
  private error: Error | null = null;

  /** Enqueue an item. No-op if already closed. */
  push(item: T): void {
    if (this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  /** Mark the queue as finished. Pending pulls will receive { done: true }. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length > 0) {
      const r = this.resolvers.shift()!;
      r({ value: undefined as unknown as T, done: true });
    }
  }

  /** Fail the queue with an error — pending + future pulls throw. */
  fail(err: Error): void {
    if (this.closed) return;
    this.error = err;
    this.closed = true;
    while (this.resolvers.length > 0) {
      const r = this.resolvers.shift()!;
      // Signal error via throwing on next call; here we just resolve done.
      r({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.error) return Promise.reject(this.error);
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ value: undefined as unknown as T, done: true });
      },
    };
  }
}
