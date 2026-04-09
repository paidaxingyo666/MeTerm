// ─── AI Tools: Task Planning (todo_write) ───────────────────────
// Lets the agent maintain its own task list as a first-class object,
// modeled after Claude Code's TodoWrite. Critical for any task that
// spans more than ~3 steps, where the model otherwise loses track of
// what is left to do.
//
// State model: a single ordered list of TodoItem records. Each call
// to `todo_write` REPLACES the entire list (the model passes the new
// authoritative list in `todos`). This is intentionally simpler than
// patch-style updates: it forces the model to re-emit the whole plan
// each turn, which keeps the state self-consistent and visible to
// the agent every iteration via the system-prompt context block.
//
// Per-agent storage: ToolAgent owns a TodoStateRef and stuffs it
// into ToolContext.todoState before each tool batch. The tool reads
// /writes through that ref. An optional `onUpdate` callback fires
// after every successful write so the UI can re-render the list and
// the runLoop can also emit a typed AgentEvent.

import type { ToolHandler, ToolContext } from './ai-tools-core';

// ─── Types ───────────────────────────────────────────────────────

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  /** Stable id (the agent supplies one, or we generate). */
  id: string;
  /** Imperative form, what needs to be done — "Deploy backend service". */
  content: string;
  /** Present-continuous form shown while active — "Deploying backend service". */
  activeForm: string;
  /** Lifecycle state. */
  status: TodoStatus;
}

/** A small mutable handle the agent installs onto ToolContext. */
export interface TodoStateRef {
  get(): TodoItem[];
  set(items: TodoItem[]): void;
  /** Optional listener fired after each successful set(). */
  onUpdate?: (items: TodoItem[]) => void;
}

/** Concrete in-memory implementation owned by ToolAgent. */
export class TodoState implements TodoStateRef {
  private items: TodoItem[] = [];
  onUpdate?: (items: TodoItem[]) => void;

  get(): TodoItem[] {
    return this.items.map((it) => ({ ...it }));
  }

  set(items: TodoItem[]): void {
    this.items = items.map((it) => ({ ...it }));
    if (this.onUpdate) {
      try { this.onUpdate(this.get()); } catch { /* swallow */ }
    }
  }

  clear(): void {
    this.items = [];
    if (this.onUpdate) {
      try { this.onUpdate(this.get()); } catch { /* swallow */ }
    }
  }

  /** Render the current todo list as a compact text block for system prompt injection. */
  renderForSystemPrompt(): string {
    if (this.items.length === 0) return '';
    const lines: string[] = [];
    lines.push('Current task plan (maintained via the todo_write tool):');
    for (const it of this.items) {
      const marker =
        it.status === 'completed'  ? '[x]'
        : it.status === 'in_progress' ? '[~]'
        : '[ ]';
      const label = it.status === 'in_progress' ? it.activeForm : it.content;
      lines.push(`  ${marker} ${label}`);
    }
    const total = this.items.length;
    const done = this.items.filter((i) => i.status === 'completed').length;
    const active = this.items.filter((i) => i.status === 'in_progress').length;
    lines.push(`(progress: ${done}/${total} completed, ${active} in progress)`);
    return lines.join('\n');
  }
}

// ─── Validation helpers ──────────────────────────────────────────

function coerceItems(raw: unknown): { ok: true; items: TodoItem[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'todo_write requires "todos" to be an array.' };
  }
  const items: TodoItem[] = [];
  let inProgressCount = 0;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i] as Record<string, unknown> | null;
    if (!r || typeof r !== 'object') {
      return { ok: false, error: `todos[${i}] is not an object.` };
    }
    const content = typeof r.content === 'string' ? r.content.trim() : '';
    if (!content) {
      return { ok: false, error: `todos[${i}].content is required (non-empty string).` };
    }
    const activeForm = typeof r.activeForm === 'string' && r.activeForm.trim()
      ? r.activeForm.trim()
      : content; // sensible fallback
    const statusRaw = typeof r.status === 'string' ? r.status : 'pending';
    if (statusRaw !== 'pending' && statusRaw !== 'in_progress' && statusRaw !== 'completed') {
      return { ok: false, error: `todos[${i}].status must be one of pending|in_progress|completed (got "${statusRaw}").` };
    }
    if (statusRaw === 'in_progress') inProgressCount++;
    const id = typeof r.id === 'string' && r.id.trim()
      ? r.id.trim()
      : `t_${Date.now().toString(36)}_${i}`;
    items.push({ id, content, activeForm, status: statusRaw });
  }
  if (inProgressCount > 1) {
    return {
      ok: false,
      error: `Only one task may be in_progress at a time (got ${inProgressCount}). Mark others as pending or completed.`,
    };
  }
  return { ok: true, items };
}

// ─── Tool Factory ────────────────────────────────────────────────

export function createTodoWriteTool(): ToolHandler {
  return {
    definition: {
      name: 'todo_write',
      description:
        'Create or update the agent\'s persistent task plan. Use this BEFORE starting any task that takes more than ~3 distinct steps (deployments, multi-file refactors, environment setup, end-to-end debugging). Each call REPLACES the entire list with the new authoritative version — always pass the full plan, not a delta. ' +
        'Rules: ' +
        '(1) Exactly ONE item may be in_progress at a time — mark the next item in_progress only after marking the previous one completed. ' +
        '(2) Mark items completed IMMEDIATELY after they finish; do not batch completions. ' +
        '(3) Each item needs both `content` (imperative, e.g. "Deploy backend") and `activeForm` (present-continuous, e.g. "Deploying backend"). ' +
        '(4) When new sub-tasks appear mid-run, add them with status=pending and re-emit the whole list. ' +
        '(5) Items left over from a finished phase that no longer apply should be removed entirely. ' +
        'The current plan is automatically injected into your system context every iteration, so you can re-read it without calling read_terminal.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description:
              'The full ordered list of todo items. Each item: { id?: string, content: string (imperative), activeForm: string (present-continuous), status: "pending"|"in_progress"|"completed" }.',
          },
        },
        required: ['todos'],
      },
    },
    // Pure state mutation in the agent's own memory; safe to run alongside
    // read-only tools, but treat it as a single serial step so the system
    // prompt always reflects the latest authoritative list.
    isConcurrencySafe: false,
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx: ToolContext): Promise<string> {
      const ref = ctx.todoState;
      if (!ref) {
        return 'Error: todo_write is not available in this context (no TodoState attached).';
      }
      const parsed = coerceItems(args.todos);
      if (!parsed.ok) {
        return `Error: ${parsed.error}`;
      }
      ref.set(parsed.items);

      // Build a confirmation summary for the LLM (and the audit log).
      const total = parsed.items.length;
      const done = parsed.items.filter((i) => i.status === 'completed').length;
      const active = parsed.items.find((i) => i.status === 'in_progress');
      const lines: string[] = [];
      lines.push(`Task plan updated — ${done}/${total} completed.`);
      if (active) lines.push(`Currently working on: ${active.activeForm}`);
      lines.push('');
      for (let i = 0; i < parsed.items.length; i++) {
        const it = parsed.items[i];
        const marker =
          it.status === 'completed'  ? '[x]'
          : it.status === 'in_progress' ? '[~]'
          : '[ ]';
        const label = it.status === 'in_progress' ? it.activeForm : it.content;
        lines.push(`  ${i + 1}. ${marker} ${label}`);
      }
      return lines.join('\n');
    },
  };
}
