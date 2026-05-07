// ─── AI Agent: Message History Management ─────────────────────
// Pure helpers for trimming and compressing the conversation
// history while preserving tool_call / tool_result pairs.
//
// Three layered strategies, modeled on Claude Code's compact.ts:
//   • trimHistory()    — hard cap by total characters (oldest first).
//   • microCompact()   — in-place truncation of long tool_result
//     messages before EVERY LLM call. Cheap, no model call.
//   • compressContext() — escalated compression on context overflow
//     (tool outputs + assistant text + oldest message drop).

import { ChatMessage, type ContentPart } from './ai-provider';
import { TOKEN_BUDGET } from './ai-tools-core';

/** Char length estimate for a ChatMessage.content. Image parts are
 *  scored at a flat 1500 chars to match the rough token cost of a
 *  small image (~ 300-500 tokens) so they participate in the budget. */
function contentCharLength(content: string | ContentPart[]): number {
  if (typeof content === 'string') return content.length;
  let total = 0;
  for (const p of content) {
    if (p.type === 'text') total += p.text.length;
    else total += 1500;
  }
  return total;
}

/** True iff the content is the simple-string form. */
function isStringContent(
  content: string | ContentPart[],
): content is string {
  return typeof content === 'string';
}

/** Rough character → token ratio; 4 chars ≈ 1 token for English + code. */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Estimate total token count of a message array. */
export function estimateMessageTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += contentCharLength(m.content);
  return estimateTokensFromChars(chars);
}

/**
 * Auto-compact decision: should we pre-emptively compress history
 * before the NEXT LLM call, based on estimated tokens?
 *
 * Threshold: 75% of (maxModelContext - maxTokens) so we still have
 * headroom for the LLM to generate the reply. Defaults assume a
 * mid-range model (128k context, 4k output); callers should pass
 * model-specific values when known.
 */
export function shouldAutoCompact(
  messages: ChatMessage[],
  modelContextTokens = 128_000,
  maxOutputTokens = 4_000,
): boolean {
  const headroom = 2_000;
  const budget = modelContextTokens - maxOutputTokens - headroom;
  const threshold = Math.floor(budget * 0.75);
  return estimateMessageTokens(messages) > threshold;
}

/**
 * MicroCompact: truncate long tool_result messages in-place so they
 * don't bloat every subsequent LLM request.
 *
 * Rationale: the most recent tool output already informs the next
 * turn — older tool outputs only need a summary / marker.  This is
 * cheap (no LLM call), idempotent, and preserves message structure.
 *
 * Keeps the most recent `keepRecent` tool messages untouched so the
 * model has the latest context in full.
 *
 * Returns true if any message was modified.
 */
export function microCompact(
  messages: ChatMessage[],
  maxOlderToolChars = 800,
  keepRecent = 2,
): boolean {
  let toolCount = 0;
  // Count tool messages to know which ones are "recent" (from the end).
  for (const m of messages) if (m.role === 'tool') toolCount++;
  if (toolCount <= keepRecent) return false;

  let modified = false;
  let seenTool = 0;
  const toKeepFrom = toolCount - keepRecent;

  for (const msg of messages) {
    if (msg.role !== 'tool') continue;
    seenTool++;
    if (seenTool > toKeepFrom) break; // reached "recent" region
    // Only text-only tool results can be truncated safely; multimodal
    // tool results (image from read_screen) are always preserved as-is
    // because their value is not reducible via character slicing.
    if (!isStringContent(msg.content)) continue;
    if (msg.content.length > maxOlderToolChars) {
      msg.content = safeTruncate(
        msg.content,
        maxOlderToolChars,
        `\n...(older tool output truncated; ${msg.content.length} chars)`,
      );
      modified = true;
    }
  }
  return modified;
}

/**
 * Trim message history by total character count, mutating in place.
 * Removes oldest messages first, preserving tool_call / tool pairs.
 */
export function trimHistory(messages: ChatMessage[]): void {
  const maxChars = TOKEN_BUDGET.messageHistoryMaxChars;
  let totalChars = messages.reduce((sum, m) => sum + contentCharLength(m.content), 0);

  while (totalChars > maxChars && messages.length > 2) {
    const removed = messages.shift()!;
    totalChars -= contentCharLength(removed.content);

    // If we removed an assistant message with tool_calls,
    // also remove the corresponding tool-result messages
    if (removed.role === 'assistant' && removed.tool_calls) {
      const tcIds = new Set(removed.tool_calls.map((tc) => tc.id));
      for (let i = messages.length - 1; i >= 0; i--) {
        if (
          messages[i].role === 'tool' &&
          tcIds.has(messages[i].tool_call_id!)
        ) {
          totalChars -= contentCharLength(messages[i].content);
          messages.splice(i, 1);
        }
      }
    }
  }
}

/**
 * Truncate at a clean boundary (last newline within a small lookback window)
 * so we don't leave half an XML/code-fence element dangling. Models
 * occasionally parrot dangling fragments like `</arg_value>` back into
 * the next turn's reasoning when we cut mid-structure.
 */
function safeTruncate(s: string, max: number, suffix: string): string {
  if (s.length <= max) return s;
  let cut = max;
  const newline = s.lastIndexOf('\n', max);
  if (newline > max - 200 && newline > 0) cut = newline;
  return s.slice(0, cut) + suffix;
}

/**
 * Aggressively compress history when the model reports context overflow.
 *   Phase 1: Truncate long tool outputs and assistant messages
 *   Phase 2: Remove oldest message turns (keeping tool pairs intact)
 *
 * Returns true if any compression was performed.
 */
export function compressContext(messages: ChatMessage[]): boolean {
  if (messages.length <= 4) return false;

  let compressed = false;
  const TOOL_MAX = 200;
  const ASSISTANT_MAX = 500;

  // Phase 1: Truncate long content (text-only messages)
  for (const msg of messages) {
    if (!isStringContent(msg.content)) continue;
    if (msg.role === 'tool' && msg.content.length > TOOL_MAX) {
      msg.content = safeTruncate(msg.content, TOOL_MAX, '\n...(output truncated)');
      compressed = true;
    }
    if (msg.role === 'assistant' && msg.content.length > ASSISTANT_MAX) {
      msg.content = safeTruncate(msg.content, ASSISTANT_MAX, '\n...(truncated)');
      compressed = true;
    }
  }

  // Phase 2: Remove oldest messages until count halved
  // Keeps tool_call/tool_result pairs together
  const targetCount = Math.max(4, Math.ceil(messages.length * 0.5));

  while (messages.length > targetCount) {
    const first = messages.shift()!;
    compressed = true;

    // If we removed an assistant with tool_calls, also remove its tool results
    if (first.role === 'assistant' && first.tool_calls) {
      const tcIds = new Set(first.tool_calls.map((tc) => tc.id));
      while (
        messages.length > 0 &&
        messages[0].role === 'tool' &&
        tcIds.has(messages[0].tool_call_id!)
      ) {
        messages.shift();
      }
    }

    // Clean up any orphaned tool results at the start
    while (messages.length > 0 && messages[0].role === 'tool') {
      messages.shift();
    }
  }

  return compressed;
}
