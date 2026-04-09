// ─── AI Agent: Runner (run() consumer) ─────────────────────
// Thin helper that consumes `ToolAgent.run()` (AsyncGenerator) and
// dispatches AgentEvent values into an existing AgentCallbacks shape.
//
// Why this helper?
//   • Lets the existing UI code (buildAgentCallbacks in
//     ai-capsule-chat-ui.ts) keep its callback-based contract.
//   • Routes everything through the new generator API so Ctrl+C /
//     Escape becomes a single `controller.abort()` call — no more
//     manually calling `agent.abort()` + cleaning state.
//   • Gives us a clean place to add tracing / telemetry later.

import type { ToolAgent, AgentCallbacks } from './ai-agent';
import type { AgentEvent } from './ai-agent-events';

/**
 * Run the agent via its AsyncGenerator API and dispatch each event
 * into the supplied callbacks.  Returns a cleanup function plus the
 * completion promise.
 */
export function runAgentWithCallbacks(
  agent: ToolAgent,
  userMessage: string,
  sessionId: string,
  callbacks: AgentCallbacks,
  images?: Array<{
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    data: string;
    label?: string;
  }>,
): { abort: () => void; done: Promise<void> } {
  const controller = new AbortController();

  const done = (async () => {
    try {
      for await (const ev of agent.run(userMessage, sessionId, controller.signal, images)) {
        dispatchEvent(ev, callbacks);
      }
    } catch (e) {
      callbacks.onError(e instanceof Error ? e : new Error(String(e)));
    }
  })();

  return { abort: () => controller.abort(), done };
}

/** Bridge one AgentEvent → the legacy AgentCallbacks surface. */
function dispatchEvent(ev: AgentEvent, cb: AgentCallbacks): void {
  switch (ev.type) {
    case 'stream_token':
      cb.onToken(ev.token);
      break;
    case 'reasoning_token':
      cb.onReasoning?.(ev.token);
      break;
    case 'iteration_start':
      cb.onIterationStart?.();
      break;
    case 'thinking_complete':
      cb.onThinkingComplete?.(ev.text);
      break;
    case 'tool_call_start':
      cb.onToolCall?.(ev.toolName, ev.args);
      break;
    case 'tool_call_result':
      cb.onToolResult?.(ev.toolName, ev.result, ev.isError);
      break;
    case 'tool_call_images':
      cb.onToolImages?.(ev.toolName, ev.images);
      break;
    case 'tool_confirm_required': {
      // The run() generator emits a promise-resolver style confirm
      // event.  Bridge it through the legacy onConfirmRequired callback.
      if (!cb.onConfirmRequired) {
        ev.resolve(false);
        return;
      }
      void cb.onConfirmRequired(ev.toolName, ev.args).then((decision) => {
        ev.resolve(decision);
      });
      break;
    }
    case 'assistant_message':
      // No legacy callback for this — we rely on onComplete below.
      break;
    case 'complete':
      cb.onComplete(ev.text);
      break;
    case 'aborted':
      cb.onAborted?.(ev.stepsCompleted);
      break;
    case 'degraded':
      cb.onDegraded?.(ev.reason);
      break;
    case 'retrying':
      cb.onRetrying?.(ev.attempt, ev.maxAttempts, ev.delayMs, ev.reason);
      break;
    case 'context_compressed':
      cb.onContextCompressed?.();
      break;
    case 'error':
      cb.onError(ev.error);
      break;
  }
}
