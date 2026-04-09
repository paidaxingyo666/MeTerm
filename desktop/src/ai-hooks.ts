// ─── AI Agent: In-Process Hook System ──────────────────────
// A minimal lifecycle-hook registry inspired by Claude Code's
// 27-event hook system, trimmed to the 6 points we actually need:
//
//   SessionStart      — agent instance was created
//   UserPromptSubmit  — user sent a new prompt
//   PreToolUse        — about to execute a tool (can mutate / deny)
//   PostToolUse       — tool finished
//   PreCompact        — before context compression
//   SessionEnd        — conversation was cleared / agent destroyed
//
// Scope: these hooks run in-process only (no shell spawn, no sandbox).
// They are intended for internal subsystems (audit log, telemetry,
// permission overrides, test harnesses) — not user scripts.
//
// Each handler is async; returning a replacement value lets hooks
// modify the flow (e.g. mutate tool args or block execution).

import type { ToolCall } from './ai-provider';

// ─── Hook Payloads ─────────────────────────────────────────

export interface SessionStartPayload {
  sessionId: string;
}

export interface UserPromptSubmitPayload {
  sessionId: string;
  prompt: string;
}

export interface PreToolUsePayload {
  sessionId: string;
  toolCall: ToolCall;
  args: Record<string, unknown>;
}

export interface PreToolUseResult {
  /** If true, deny the tool call with the given reason. */
  deny?: { reason: string };
  /** If set, replace the args before execution. */
  replaceArgs?: Record<string, unknown>;
}

export interface PostToolUsePayload {
  sessionId: string;
  toolName: string;
  callId: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  durationMs: number;
}

export interface PreCompactPayload {
  sessionId: string;
  reason: 'auto' | 'overflow';
  beforeMessageCount: number;
}

export interface SessionEndPayload {
  sessionId: string;
  reason: 'cleared' | 'destroyed';
}

// ─── Hook Handler Types ────────────────────────────────────

export type SessionStartHandler = (p: SessionStartPayload) => void | Promise<void>;
export type UserPromptSubmitHandler = (p: UserPromptSubmitPayload) => void | Promise<void>;
export type PreToolUseHandler = (p: PreToolUsePayload) => PreToolUseResult | void | Promise<PreToolUseResult | void>;
export type PostToolUseHandler = (p: PostToolUsePayload) => void | Promise<void>;
export type PreCompactHandler = (p: PreCompactPayload) => void | Promise<void>;
export type SessionEndHandler = (p: SessionEndPayload) => void | Promise<void>;

// ─── Registry ──────────────────────────────────────────────

class HookRegistry {
  private sessionStartHandlers: SessionStartHandler[] = [];
  private userPromptSubmitHandlers: UserPromptSubmitHandler[] = [];
  private preToolUseHandlers: PreToolUseHandler[] = [];
  private postToolUseHandlers: PostToolUseHandler[] = [];
  private preCompactHandlers: PreCompactHandler[] = [];
  private sessionEndHandlers: SessionEndHandler[] = [];

  onSessionStart(h: SessionStartHandler): () => void {
    this.sessionStartHandlers.push(h);
    return () => { this.sessionStartHandlers = this.sessionStartHandlers.filter(x => x !== h); };
  }

  onUserPromptSubmit(h: UserPromptSubmitHandler): () => void {
    this.userPromptSubmitHandlers.push(h);
    return () => { this.userPromptSubmitHandlers = this.userPromptSubmitHandlers.filter(x => x !== h); };
  }

  onPreToolUse(h: PreToolUseHandler): () => void {
    this.preToolUseHandlers.push(h);
    return () => { this.preToolUseHandlers = this.preToolUseHandlers.filter(x => x !== h); };
  }

  onPostToolUse(h: PostToolUseHandler): () => void {
    this.postToolUseHandlers.push(h);
    return () => { this.postToolUseHandlers = this.postToolUseHandlers.filter(x => x !== h); };
  }

  onPreCompact(h: PreCompactHandler): () => void {
    this.preCompactHandlers.push(h);
    return () => { this.preCompactHandlers = this.preCompactHandlers.filter(x => x !== h); };
  }

  onSessionEnd(h: SessionEndHandler): () => void {
    this.sessionEndHandlers.push(h);
    return () => { this.sessionEndHandlers = this.sessionEndHandlers.filter(x => x !== h); };
  }

  // ─── Emit methods ─────────────────────────────────────

  async emitSessionStart(p: SessionStartPayload): Promise<void> {
    for (const h of this.sessionStartHandlers) {
      try { await h(p); } catch (e) { console.error('[hook] SessionStart:', e); }
    }
  }

  async emitUserPromptSubmit(p: UserPromptSubmitPayload): Promise<void> {
    for (const h of this.userPromptSubmitHandlers) {
      try { await h(p); } catch (e) { console.error('[hook] UserPromptSubmit:', e); }
    }
  }

  /**
   * Emit PreToolUse and collect a merged result.  If ANY handler
   * returns a deny, the tool call is blocked.  If ANY handler returns
   * replaceArgs, the last one wins (caller decides).
   */
  async emitPreToolUse(p: PreToolUsePayload): Promise<PreToolUseResult> {
    let merged: PreToolUseResult = {};
    for (const h of this.preToolUseHandlers) {
      try {
        const r = await h(p);
        if (r?.deny) merged = { deny: r.deny };
        if (r?.replaceArgs) merged = { ...merged, replaceArgs: r.replaceArgs };
        if (merged.deny) break; // short-circuit on deny
      } catch (e) {
        console.error('[hook] PreToolUse:', e);
      }
    }
    return merged;
  }

  async emitPostToolUse(p: PostToolUsePayload): Promise<void> {
    for (const h of this.postToolUseHandlers) {
      try { await h(p); } catch (e) { console.error('[hook] PostToolUse:', e); }
    }
  }

  async emitPreCompact(p: PreCompactPayload): Promise<void> {
    for (const h of this.preCompactHandlers) {
      try { await h(p); } catch (e) { console.error('[hook] PreCompact:', e); }
    }
  }

  async emitSessionEnd(p: SessionEndPayload): Promise<void> {
    for (const h of this.sessionEndHandlers) {
      try { await h(p); } catch (e) { console.error('[hook] SessionEnd:', e); }
    }
  }
}

/** Global in-process hook registry. Subsystems register on startup. */
export const hooks = new HookRegistry();
