// ─── AI Agent: AsyncGenerator wrapper for runLoop ──────────
// Extracted from ai-agent.ts to keep ToolAgent itself under 1000
// lines. This module glues the callback-driven `ToolAgent.send()`
// into a pull-based AsyncGenerator<AgentEvent> so the UI can
// consume the run with a `for await` loop + a single AbortController.

import { AsyncEventQueue, type AgentEvent } from './ai-agent-events';
import type { AgentCallbacks, ToolAgent } from './ai-agent';

export interface ImageAttachment {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
  label?: string;
}

/**
 * Drive a ToolAgent via its callback API and yield AgentEvent values
 * as a pull-based stream. See ToolAgent.run() for the public entry.
 */
export async function* runAgentAsGenerator(
  agent: ToolAgent,
  userMessage: string,
  sessionId: string,
  signal?: AbortSignal,
  images?: ImageAttachment[],
): AsyncGenerator<AgentEvent, void, void> {
  // Hook the external abort signal into the agent's internal abort.
  const onExternalAbort = () => agent.abort();
  if (signal) {
    if (signal.aborted) {
      yield { type: 'aborted', stepsCompleted: 0 };
      return;
    }
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const queue = new AsyncEventQueue<AgentEvent>();

  // Build AgentCallbacks that push each notification into the queue.
  let assistantIterationCount = 0;
  const callbacks: AgentCallbacks = {
    onToken: (token) => queue.push({ type: 'stream_token', token }),
    onReasoning: (token) => queue.push({ type: 'reasoning_token', token }),
    onIterationStart: () => {
      assistantIterationCount++;
      queue.push({ type: 'iteration_start', iteration: assistantIterationCount + 1 });
    },
    onThinkingComplete: (text) => queue.push({ type: 'thinking_complete', text }),
    onToolCall: (toolName, args) =>
      queue.push({
        type: 'tool_call_start',
        toolName,
        args,
        callId: `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      }),
    onToolResult: (toolName, result, isError) =>
      queue.push({
        type: 'tool_call_result',
        toolName,
        callId: '',
        result,
        isError,
      }),
    onToolImages: (toolName, images) =>
      queue.push({
        type: 'tool_call_images',
        toolName,
        images,
      }),
    onConfirmRequired: (toolName, args) =>
      new Promise<boolean | string>((resolve) => {
        queue.push({ type: 'tool_confirm_required', toolName, args, resolve });
      }),
    onComplete: (fullText) => {
      queue.push({ type: 'assistant_message', content: fullText });
      queue.push({ type: 'complete', text: fullText });
    },
    onError: (error) => {
      queue.push({ type: 'error', error });
    },
    onAborted: (steps) => {
      queue.push({ type: 'aborted', stepsCompleted: steps });
    },
    onDegraded: (reason) => {
      queue.push({ type: 'degraded', reason });
    },
    onRetrying: (attempt, maxAttempts, delayMs, reason) =>
      queue.push({ type: 'retrying', attempt, maxAttempts, delayMs, reason }),
    onContextCompressed: () => queue.push({ type: 'context_compressed' }),
  };

  // Kick off the agent in the background.
  if (userMessage || (images && images.length > 0)) {
    agent.send(userMessage, sessionId, callbacks, images);
  } else {
    agent.resume(sessionId, callbacks);
  }

  // Drain the queue until we see a terminal event.
  try {
    for await (const event of queue) {
      yield event;
      if (
        event.type === 'complete' ||
        event.type === 'aborted' ||
        event.type === 'error'
      ) {
        queue.close();
        return;
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onExternalAbort);
    queue.close();
  }
}
