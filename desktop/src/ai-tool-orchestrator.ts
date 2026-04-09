// ─── AI Tool Orchestrator ──────────────────────────────────
// Partitions a batch of tool calls into sub-batches based on the
// `isConcurrencySafe` flag, then executes each batch either in
// parallel (safe) or serially (unsafe).
//
// The design mirrors Claude-Code's tool orchestration:
//   • A run of consecutive concurrency-safe tools is fanned out
//     via Promise.all (capped at MAX_CONCURRENCY).
//   • Any tool not marked safe runs alone in a sub-batch to guarantee
//     exclusive access to the terminal / filesystem.
//
// This file stays purely mechanical — it does NOT know about the
// agent's message history, trust levels, or confirmations. All of
// those concerns are handled by the caller (ToolAgent), which passes
// in a single `executeOne` callback per tool call.

import type { ToolCall } from './ai-provider';
import type { ToolHandler, ToolOutputWithImages } from './ai-tools';

/** Maximum number of concurrency-safe tools to execute in parallel. */
export const MAX_CONCURRENCY = 5;

/** A single tool invocation result, keyed by callId. */
export interface ToolExecResult {
  callId: string;
  toolName: string;
  /** Text-only legacy shape OR multimodal (text + images). */
  result: string | ToolOutputWithImages;
  isError: boolean;
}

/** Per-call resolver the caller provides to actually run a tool. */
export type ExecuteOneFn = (
  toolCall: ToolCall,
  handler: ToolHandler,
) => Promise<{ result: string | ToolOutputWithImages; isError: boolean }>;

/**
 * Group a sequence of tool calls into sub-batches:
 *   - Consecutive calls whose handler is `isConcurrencySafe` form one batch.
 *   - Any non-safe call forms a singleton batch on its own.
 *
 * Order is preserved — we never reorder tool calls, so models that
 * rely on sequence semantics (e.g. read → edit → run) still work.
 */
export function partitionToolCalls(
  toolCalls: ToolCall[],
  handlerOf: (name: string) => ToolHandler | undefined,
): ToolCall[][] {
  const batches: ToolCall[][] = [];
  let currentBatch: ToolCall[] = [];
  let currentSafe: boolean | null = null;

  const flush = () => {
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentSafe = null;
    }
  };

  for (const call of toolCalls) {
    const handler = handlerOf(call.function.name);
    const safe = !!handler?.isConcurrencySafe;

    if (currentSafe === null) {
      // First call — start a batch.
      currentBatch.push(call);
      currentSafe = safe;
      continue;
    }

    if (safe && currentSafe) {
      // Extend the current safe batch (up to MAX_CONCURRENCY).
      if (currentBatch.length < MAX_CONCURRENCY) {
        currentBatch.push(call);
        continue;
      }
      // Batch is full — flush and start a new one with this call.
      flush();
      currentBatch.push(call);
      currentSafe = safe;
      continue;
    }

    // Mixed safety: flush current, start fresh with this call.
    flush();
    currentBatch.push(call);
    currentSafe = safe;
  }

  flush();
  return batches;
}

/**
 * Execute one batch of tool calls.
 *
 * - If the batch has >1 call, they are assumed concurrency-safe and run
 *   via Promise.all.
 * - Otherwise (single call) it runs serially via `executeOne`.
 *
 * Errors are captured per-call via the result object (not thrown).
 * Abort is cooperatively handled by the caller's executeOne (which
 * should check `aborted` before each call).
 */
async function runBatch(
  batch: ToolCall[],
  handlerOf: (name: string) => ToolHandler | undefined,
  executeOne: ExecuteOneFn,
): Promise<ToolExecResult[]> {
  if (batch.length === 0) return [];

  if (batch.length === 1) {
    const call = batch[0];
    const handler = handlerOf(call.function.name);
    if (!handler) {
      return [
        {
          callId: call.id,
          toolName: call.function.name,
          result: `Unknown tool "${call.function.name}"`,
          isError: true,
        },
      ];
    }
    const out = await executeOne(call, handler);
    return [
      {
        callId: call.id,
        toolName: call.function.name,
        result: out.result,
        isError: out.isError,
      },
    ];
  }

  // Parallel batch.
  const promises = batch.map(async (call): Promise<ToolExecResult> => {
    const handler = handlerOf(call.function.name);
    if (!handler) {
      return {
        callId: call.id,
        toolName: call.function.name,
        result: `Unknown tool "${call.function.name}"`,
        isError: true,
      };
    }
    const out = await executeOne(call, handler);
    return {
      callId: call.id,
      toolName: call.function.name,
      result: out.result,
      isError: out.isError,
    };
  });
  return Promise.all(promises);
}

/**
 * Run all tool calls from one LLM turn, partitioned and executed.
 * Returns a flat, in-order array of results.
 *
 * `shouldAbort` is checked between batches so a user abort can stop
 * execution without tearing down an in-flight parallel batch.
 */
export async function runTools(
  toolCalls: ToolCall[],
  handlerOf: (name: string) => ToolHandler | undefined,
  executeOne: ExecuteOneFn,
  shouldAbort: () => boolean,
): Promise<ToolExecResult[]> {
  const batches = partitionToolCalls(toolCalls, handlerOf);
  const results: ToolExecResult[] = [];

  for (const batch of batches) {
    if (shouldAbort()) break;
    const batchResults = await runBatch(batch, handlerOf, executeOne);
    results.push(...batchResults);
  }

  return results;
}
