// ─── AI Tools Core ─────────────────────────────────────────────
// Shared types, token budgets, danger detection, small utilities,
// ToolRegistry, and ToolContext builder.  Imported by all other
// ai-tools-* modules and re-exported from ai-tools.ts.

import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { TabManager } from './tabs';
import { getAllLeaves } from './split-pane';

// ─── Types ──────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; default?: unknown }>;
    required: string[];
  };
}

export interface ToolResult {
  toolName: string;
  result: string;
  isError: boolean;
}

/**
 * Structured tool return value for tools that need to include binary
 * attachments (e.g. read_screen capturing a PNG of the terminal).
 * A tool's execute() may return a plain string (legacy) OR an object
 * with text + images; the agent runLoop normalizes both shapes into
 * a ContentPart[]-backed tool message.
 */
export interface ToolOutputWithImages {
  /** Human-readable text summary. */
  text: string;
  /** Zero or more base64-encoded image attachments. */
  images: Array<{
    mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    data: string;
    label?: string;
  }>;
}

/** Descriptor for a pane inside the current tab (phase 2).
 *  Populated by buildToolContext from TabManager + TerminalRegistry. */
export interface PaneInfo {
  /** 1-based pane number as surfaced to the agent. */
  paneNumber: number;
  sessionId: string;
  isSSH: boolean;
  serverInfo: string | null;
  shellType: string;
  cwd: string;
  isDefaultTarget: boolean;
}

export interface ToolContext {
  /** The DEFAULT-target session for this run (the pane the user
   *  locked in when they hit Send). Individual tool calls may
   *  override by passing `pane: <number>`. */
  sessionId: string;
  isSSH: boolean;
  serverInfo: string | null;
  /** Detected shell type (bash, zsh, fish, powershell). Cached per session. */
  shellType: string;
  /** Current working directory (tracked via shell integration OSC 7768) */
  cwd: string;
  /**
   * Every pane of the tab that owns `sessionId`. Tools use this to
   * resolve a `pane: <number>` argument to the right underlying
   * session. Sorted by paneNumber.
   */
  panes: PaneInfo[];
  /**
   * Optional abort signal from the owning ToolAgent. Long-running tools
   * (wait_for_user_input / watch_terminal) should subscribe to this so
   * they unblock cleanly when the user cancels the agent run. Short
   * tools may ignore it — the agent loop checks `aborted` between tool
   * calls as a coarse safety net.
   */
  abortSignal?: AbortSignal;
  /**
   * Mutable handle into the agent's persistent task plan. Owned by
   * ToolAgent and forwarded into each tool batch via runLoop. Tools
   * (currently `todo_write`) read/write this to surface a structured
   * task list to both the model (via the system prompt) and the UI
   * (via the onTodoUpdate callback). Undefined when the agent is
   * driven outside the standard runLoop (tests, headless, etc).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  todoState?: import('./ai-tools-todo').TodoStateRef;
}

/**
 * Resolve a `pane?: number` argument to the underlying target. Returns
 * either the matching PaneInfo (when the arg points at a valid pane of
 * the current tab) or an error string when the pane doesn't exist.
 * Omitting or passing a falsy value falls back to the default target.
 */
export function resolvePaneTarget(
  ctx: ToolContext,
  arg: unknown,
): { ok: true; pane: PaneInfo } | { ok: false; error: string } {
  // No argument → default target (the pane that owns ctx.sessionId).
  if (arg === undefined || arg === null || arg === '') {
    const def = ctx.panes.find((p) => p.sessionId === ctx.sessionId)
             ?? ctx.panes.find((p) => p.isDefaultTarget)
             ?? ctx.panes[0];
    if (!def) {
      return { ok: false, error: 'No panes available on the current tab.' };
    }
    return { ok: true, pane: def };
  }
  const num = typeof arg === 'number' ? arg : parseInt(String(arg), 10);
  if (!Number.isFinite(num) || num <= 0) {
    return { ok: false, error: `Invalid pane number: ${String(arg)}. Expected a positive integer.` };
  }
  const match = ctx.panes.find((p) => p.paneNumber === num);
  if (!match) {
    const available = ctx.panes.map((p) => p.paneNumber).join(', ');
    return {
      ok: false,
      error: `Pane ${num} does not exist on the current tab. Available panes: ${available || '(none)'}.`,
    };
  }
  return { ok: true, pane: match };
}

export interface ToolHandler {
  definition: ToolDefinition;
  /**
   * Execute the tool. May return either:
   *   • a plain string (classic text-only result), or
   *   • a `ToolOutputWithImages` for multimodal tools like read_screen.
   * The agent loop normalizes both into the same ContentPart[] shape.
   */
  execute: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<string | ToolOutputWithImages>;
  /** Level 1: should this invocation require user confirmation? */
  requiresConfirm: (args: Record<string, unknown>) => boolean;
  /** Level 2: is this invocation extremely destructive (always confirm)? */
  isDestructive: (args: Record<string, unknown>) => boolean;
  /**
   * Whether this tool is safe to run concurrently with other
   * concurrency-safe tools in the same batch.
   *
   * - true  : read-only / side-effect-free tools (read_file, read_terminal,
   *           web_search, command_help). Multiple of these can be fanned
   *           out in parallel.
   * - false : tools that mutate the terminal, filesystem, or external
   *           state (run_command, write_file, type_text, press_keys, watch_terminal).
   *           These run serially to avoid interleaving output / races.
   *
   * The orchestrator (ai-tool-orchestrator.ts) partitions tool calls into
   * batches based on this flag.  Default: false (safe fallback).
   */
  isConcurrencySafe?: boolean;
}

// ─── Token Budget Constants ──────────────────────────────────────

export const TOKEN_BUDGET = {
  /** Max characters for system prompt terminal context */
  systemContextChars: 6000,    // ~80 lines ≈ 2000 tokens
  /** Max characters per tool output */
  perToolOutputChars: 4000,
  /** Max total characters in message history */
  messageHistoryMaxChars: 60000,
  /** Default lines for read_terminal tool */
  defaultTerminalLines: 50,
  /** Lines included in system prompt context */
  systemContextLines: 80,
};

// ─── Danger Detection ────────────────────────────────────────────

const DANGER_PATTERNS = [
  /\brm\s+(-[^\s]*\s+)*-[^\s]*r/,
  /\brm\s+(-[^\s]*\s+)*\//,
  /\bmkfs\b/,
  /\bdd\s+/,
  /\b(shutdown|reboot|poweroff|halt)\b/,
  /\bsystemctl\s+(stop|disable|mask)\b/,
  /\bkill\s+-9/,
  /\bkillall\b/,
  /\bpkill\b/,
  /\bchmod\s+(-[^\s]*\s+)*[0-7]*0{2}/,
  /\bchown\s+-R/,
  /\bchmod\s+-R/,
  /\b>\s*\/dev\/sd/,
  /\bdrop\s+(database|table|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b/i,
  /\bformat\b/,
  /\bnewfs\b/,
  /\bdiskutil\s+erase/,
  /\bsudo\b/,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+-[^\s]*f/,
  /\biptables\s+-F/,
  /\b:(){ :\|:& };:/,
];

/** Subset of DANGER_PATTERNS that are truly catastrophic */
const EXTREME_DANGER_PATTERNS = [
  /\brm\s+(-[^\s]*\s+)*-[^\s]*r[^\s]*\s+\//,  // rm -rf /
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev/,
  /\b:(){ :\|:& };:/,
  /\b>\s*\/dev\/sd/,
  /\bdiskutil\s+erase/,
];

export function isDangerousCommand(cmd: string): boolean {
  return DANGER_PATTERNS.some((p) => p.test(cmd));
}

export function isExtremelyDangerous(cmd: string): boolean {
  return EXTREME_DANGER_PATTERNS.some((p) => p.test(cmd));
}

// ─── Utility Functions ───────────────────────────────────────────

/** Strip ANSI escape sequences from terminal output */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, '')   // CSI sequences (incl. private ?1h ?2004h etc.)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (BEL or ST terminated)
    .replace(/\x1b[()][A-Z0-9]/g, '')            // charset switch (e.g. \x1b(B)
    .replace(/\x1b[>=<]/g, '')                    // keypad / cursor mode switches
    .replace(/\x1b\x1b/g, '')                     // double escape
    .replace(/\r/g, '');                          // carriage return
}

/** Truncate long output, keeping head + tail */
export function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return (
    text.slice(0, half) +
    '\n\n... (truncated, showing first and last parts) ...\n\n' +
    text.slice(-half)
  );
}

/** Escape single quotes for shell string: ' → '\'' */
export function escapeShellSingle(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Monitor user keyboard input during agent execution.
 * Returns an object with `aborted` flag and `cleanup` unsubscribe function.
 * When the user types (non-mouse) while agent is executing, sets aborted=true.
 */
export function watchForUserInput(sessionId: string): { readonly aborted: boolean; cleanup: () => void } {
  const state = { aborted: false };
  const unsub = TerminalRegistry.onInput(sessionId, (data) => {
    // Ignore mouse escape sequences
    if (data.startsWith('\x1b[<') || data.startsWith('\x1b[M')) return;
    const mt = TerminalRegistry.get(sessionId);
    if (mt?.shellState.phase === 'agent_executing') {
      state.aborted = true;
    }
  });
  return {
    get aborted() { return state.aborted; },
    cleanup: unsub,
  };
}

// ─── Shell Type Cache ────────────────────────────────────────────

/** Cached shell type per session */
const shellTypeCache = new Map<string, string>();

export function setShellType(sessionId: string, shellType: string): void {
  shellTypeCache.set(sessionId, shellType);
}

export function getShellType(sessionId: string): string {
  return shellTypeCache.get(sessionId) ?? 'bash';
}

// ─── Build Tool Context ──────────────────────────────────────────

/**
 * Build the per-tool-call context. `sessionId` is the LOCKED default
 * target for this run (set by the UI layer when the user hit Send).
 * The returned `panes` list contains every pane of the tab that owns
 * this session, letting tools resolve `pane: <n>` arguments without
 * caring about TabManager directly.
 */
export function buildToolContext(sessionId: string): ToolContext {
  const located = TabManager.locateSession(sessionId);
  const tab = located?.tab ?? null;

  const panes: PaneInfo[] = [];
  if (tab) {
    const leaves = getAllLeaves(tab.splitRoot);
    for (const leaf of leaves) {
      const info = DrawerManager.getServerInfo(leaf.sessionId);
      const mt = TerminalRegistry.get(leaf.sessionId);
      const paneNumber = tab.paneNumbers.get(leaf.id) ?? 0;
      panes.push({
        paneNumber,
        sessionId: leaf.sessionId,
        isSSH: !!info,
        serverInfo: info ? `${info.username}@${info.host}:${info.port}` : null,
        shellType: getShellType(leaf.sessionId),
        cwd: mt?.shellState.cwd ?? '',
        isDefaultTarget: leaf.sessionId === sessionId,
      });
    }
    panes.sort((a, b) => a.paneNumber - b.paneNumber);
  }

  // Degenerate fallback when the session isn't in any tab (tests,
  // headless, edge cases).
  if (panes.length === 0) {
    const info = DrawerManager.getServerInfo(sessionId);
    const mt = TerminalRegistry.get(sessionId);
    panes.push({
      paneNumber: 1,
      sessionId,
      isSSH: !!info,
      serverInfo: info ? `${info.username}@${info.host}:${info.port}` : null,
      shellType: getShellType(sessionId),
      cwd: mt?.shellState.cwd ?? '',
      isDefaultTarget: true,
    });
  }

  const defaultPane = panes.find((p) => p.isDefaultTarget) ?? panes[0];

  return {
    sessionId: defaultPane.sessionId,
    isSSH: defaultPane.isSSH,
    serverInfo: defaultPane.serverInfo,
    shellType: defaultPane.shellType,
    cwd: defaultPane.cwd,
    panes,
  };
}

// ─── Tool Registry ───────────────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, ToolHandler>();

  register(handler: ToolHandler): void {
    this.tools.set(handler.definition.name, handler);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolHandler | undefined {
    return this.tools.get(name);
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((h) => h.definition);
  }

  /**
   * Determine whether a tool invocation needs user confirmation
   * based on the CURRENT trust level (read at call time).
   */
  shouldConfirm(toolName: string, args: Record<string, unknown>, trustLevel: number): boolean {
    const handler = this.tools.get(toolName);
    if (!handler) return true; // unknown tool → always confirm

    switch (trustLevel) {
      case 0:
        return true; // Level 0: ALL operations need confirmation
      case 1:
        return handler.requiresConfirm(args); // Level 1: dangerous ops only
      case 2:
        return handler.isDestructive(args); // Level 2: only catastrophic
      default:
        return true;
    }
  }
}
