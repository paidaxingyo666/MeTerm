// ─── AI Agent Tool System ────────────────────────────────────────
// Tool registry and built-in tool implementations for the Terminal Agent.
// Each tool encapsulates: definition (JSON Schema), execution logic,
// and permission policy (requiresConfirm / isDestructive).

import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { readTextFile, writeTextFile, stat, mkdir, exists } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { loadSettings } from './themes';

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

export interface ToolContext {
  sessionId: string;
  isSSH: boolean;
  serverInfo: string | null;
  /** Detected shell type (bash, zsh, fish, powershell). Cached per session. */
  shellType: string;
  /** Current working directory (tracked via shell integration OSC 7768) */
  cwd: string;
}

export interface ToolHandler {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
  /** Level 1: should this invocation require user confirmation? */
  requiresConfirm: (args: Record<string, unknown>) => boolean;
  /** Level 2: is this invocation extremely destructive (always confirm)? */
  isDestructive: (args: Record<string, unknown>) => boolean;
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
function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return (
    text.slice(0, half) +
    '\n\n... (truncated, showing first and last parts) ...\n\n' +
    text.slice(-half)
  );
}

/** Escape single quotes for shell string: ' → '\'' */
function escapeShellSingle(s: string): string {
  return s.replace(/'/g, "'\\''");
}

// ─── Shell State Machine ──────────────────────────────────────────
// The prompt hook (__meterm_precmd) sends OSC 7768 with exit code + CWD
// before each prompt. This drives the state machine:
//   unknown → ready (first OSC 7768) → agent_executing → ready (next OSC 7768)
//
// The hook is pure telemetry — it does NOT modify any terminal behavior
// (no stty, no ZLE manipulation, no PROMPT override). Agent commands are
// displayed normally in the terminal, as if typed by the user.

/**
 * Build the one-line precmd hook script for a given shell type.
 * Sole responsibility: emit OSC 7768;EXIT_CODE;CWD before each prompt.
 */
function buildShellHook(shellType: string): string {
  switch (shellType) {
    case 'zsh':
      return [
        `__meterm_precmd(){ local e=$?;`,
        `printf '\\033]7768;%d;%s\\007' "$e" "$PWD"; };`,
        `autoload -Uz add-zsh-hook 2>/dev/null&&add-zsh-hook precmd __meterm_precmd`,
      ].join('');
    case 'fish':
      return [
        `function __meterm_postcmd --on-event fish_postexec;`,
        `printf '\\033]7768;%d;%s\\007' $status "$PWD";`,
        `end`,
      ].join('');
    case 'powershell':
      return [
        `function prompt {`,
        `$e=$LASTEXITCODE;`,
        `[Console]::Write("$([char]0x1b)]7768;$e;$(Get-Location)$([char]7)");`,
        `return "PS> "`,
        `}`,
      ].join('');
    default: // bash
      return [
        `__meterm_precmd(){ local e=$?;`,
        `printf '\\033]7768;%d;%s\\007' "$e" "$PWD"; };`,
        `PROMPT_COMMAND="__meterm_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"`,
      ].join('');
  }
}

/**
 * Helper: wait for an OSC 7766 marker with timeout.
 * Returns the exit code (or -1 on timeout).
 */
function waitForOscMarker(
  sessionId: string,
  markerId: string,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { unsub(); resolve(-1); }, timeoutMs);
    const unsub = TerminalRegistry.onOscMarker(sessionId, markerId, (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/**
 * Inject the shell prompt hook into the terminal session.
 *
 * Two-phase approach for invisible injection:
 *   Phase 1: detect shell type via $0, emit OSC 7766 marker
 *   Phase 2: DEC restore cursor + erase Phase 1 echo + eval hook (pure telemetry)
 *
 * Auto-detects bash/zsh from $0. Fish/PowerShell fall through to marker fallback.
 * Agent commands display normally — hook only emits OSC 7768 for state tracking.
 */
export async function injectShellHook(
  sessionId: string,
): Promise<boolean> {
  const mt = TerminalRegistry.get(sessionId);
  if (!mt || mt.shellState.hookInjected) return mt?.shellState.hookInjected ?? false;

  // DEC save cursor — restored by Phase 2 printf to erase all injection echo
  mt.terminal.write('\x1b7');

  // ── Phase 1: detect shell type ──
  // Encode shell type as integer for OSC 7766: 0=bash, 1=zsh, 2=fish
  // This POSIX command works in bash/zsh; fish/powershell will timeout → fallback.
  const detectId = `det_${Date.now().toString(36)}`;
  const phase1 = ` case $(basename "\${0#-}") in zsh) __st=1;; fish) __st=2;; *) __st=0;; esac; printf '\\033]7766;${detectId};%d\\007' "$__st"; unset __st`;

  TerminalRegistry.sendAgentCommand(sessionId, phase1);
  const shellCode = await waitForOscMarker(sessionId, detectId, 3000);

  if (shellCode === -1) {
    // Detection timed out (likely fish/powershell) — bail, use marker fallback
    return false;
  }

  const shellType = shellCode === 1 ? 'zsh' : shellCode === 2 ? 'fish' : 'bash';
  setShellType(sessionId, shellType);

  // ── Phase 2: DEC restore cursor + erase + move to col 0 + eval hook ──
  // \0338         = ESC 8: DEC Restore Cursor (back to saved position)
  // \033[0J       = CSI 0J: Erase from cursor to end of screen (removes Phase 1 echo)
  // \r\033[2K     = CR + CSI 2K: move to column 0 and erase current line
  //                 This is critical: without it, zsh sees cursor at col N (after "$ ")
  //                 and prints PROMPT_EOL_MARK "%" before the next prompt.
  // IMPORTANT: eval uses single quotes so $e/$PWD expand at precmd runtime, not now.
  const hook = buildShellHook(shellType);
  // Erase sequence:
  //   \0338       = ESC 8: DEC restore cursor (back to after "$ ")
  //   \033[0J     = erase from cursor to end of screen (removes Phase 1 echo below)
  //   \r\033[2K   = CR + erase current line (second prompt line, e.g. "$ ")
  //   \033[A      = cursor up 1 (to first prompt line, e.g. oh-my-zsh header)
  //   \033[2K     = erase first prompt line
  //   \r          = col 0 — prevents zsh PROMPT_SP from printing "%" marker
  const phase2 = ` printf '\\0338\\033[0J\\r\\033[2K\\033[A\\033[2K\\r'; eval '${escapeShellSingle(hook)}'`;

  const idlePromise = waitForIdle(sessionId, 8);
  TerminalRegistry.sendAgentCommand(sessionId, phase2);
  const result = await idlePromise;

  if (result.exitCode !== -1 || result.cwd) {
    mt.shellState.hookInjected = true;
    return true;
  }

  return false;
}

/**
 * Wait for the shell to become idle (OSC 7768 fires).
 * Returns exit code + CWD from the shell state, plus captured output.
 */
async function waitForIdle(
  sessionId: string,
  timeoutSec: number,
  signal?: { aborted: boolean },
): Promise<{ output: string; exitCode: number; cwd: string }> {
  return new Promise((resolve) => {
    let outputBuffer = '';
    let resolved = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      unsubOutput();
      unsubIdle();
      clearTimeout(deadline);
    };

    const deadline = setTimeout(() => {
      cleanup();
      resolve({
        output: stripAnsi(outputBuffer) + '\n[Command timed out after ' + timeoutSec + 's — may still be running]',
        exitCode: -1,
        cwd: '',
      });
    }, timeoutSec * 1000);

    // Capture raw output text
    const unsubOutput = TerminalRegistry.onOutput(sessionId, (data) => {
      if (resolved) return;
      if (signal?.aborted) {
        cleanup();
        resolve({ output: stripAnsi(outputBuffer) + '\n[执行被用户中止]', exitCode: -1, cwd: '' });
        return;
      }
      outputBuffer += data;
    });

    // Wait for shell idle (OSC 7768)
    const unsubIdle = TerminalRegistry.onShellIdle(sessionId, () => {
      const mt = TerminalRegistry.get(sessionId);
      cleanup();
      resolve({
        output: stripAnsi(outputBuffer),
        exitCode: mt?.shellState.lastExitCode ?? -1,
        cwd: mt?.shellState.cwd ?? '',
      });
    });
  });
}

/**
 * Wait for OSC 7766 marker (fallback when shell integration is not available).
 * Used by PowerShell and as fallback for injection failure.
 */
async function waitForMarkerFallback(
  sessionId: string,
  markerId: string,
  timeoutSec: number,
  signal?: { aborted: boolean },
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve) => {
    let outputBuffer = '';
    let resolved = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      unsubOutput();
      unsubOsc();
      clearTimeout(deadline);
    };

    const deadline = setTimeout(() => {
      cleanup();
      resolve({
        output: stripAnsi(outputBuffer) + '\n[Command timed out after ' + timeoutSec + 's — may still be running]',
        exitCode: -1,
      });
    }, timeoutSec * 1000);

    const unsubOutput = TerminalRegistry.onOutput(sessionId, (data) => {
      if (resolved) return;
      if (signal?.aborted) {
        cleanup();
        resolve({ output: stripAnsi(outputBuffer) + '\n[执行被用户中止]', exitCode: -1 });
        return;
      }
      outputBuffer += data;
    });

    const unsubOsc = TerminalRegistry.onOscMarker(sessionId, markerId, (exitCode) => {
      cleanup();
      resolve({ output: stripAnsi(outputBuffer), exitCode });
    });
  });
}

/**
 * Execute a command via the shell state machine (primary path).
 *
 * Flow:
 * 1. Send the bare command (visible to user, like normal terminal usage)
 * 2. Wait for idle → get exit code + CWD from OSC 7768
 *
 * Falls back to OSC 7766 marker when shell integration is unavailable.
 */
async function executeAgentCommand(
  sessionId: string,
  cmd: string,
  shellType: string,
  timeoutSec: number,
  signal?: { aborted: boolean },
): Promise<{ output: string; exitCode: number; cwd: string }> {
  const mt = TerminalRegistry.get(sessionId);

  // ── Fallback: shell hook not injected or PowerShell ──
  if (!mt?.shellState.hookInjected || shellType === 'powershell') {
    const markerId = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const resultPromise = waitForMarkerFallback(sessionId, markerId, timeoutSec, signal);
    if (shellType === 'powershell') {
      TerminalRegistry.sendAgentCommand(sessionId,
        `${cmd}; $__ec=$LASTEXITCODE; [Console]::Write("$([char]0x1b)]7766;${markerId};$__ec$([char]7)")`);
    } else if (shellType === 'fish') {
      TerminalRegistry.sendAgentCommand(sessionId,
        `${cmd}; set __ec $status; printf '\\033]7766;${markerId};%d\\007' $__ec`);
    } else {
      TerminalRegistry.sendAgentCommand(sessionId,
        `${cmd}; __ec=$?; printf '\\033]7766;${markerId};%d\\007' "$__ec"`);
    }
    const { output, exitCode } = await resultPromise;
    return { output: cleanOutput(output, cmd), exitCode, cwd: '' };
  }

  // ── Shell integration mode ──
  // Send bare command — it displays normally in the terminal (user can see it).
  // Space prefix: excluded from shell history (HIST_IGNORE_SPACE / ignorespace).
  const resultPromise = waitForIdle(sessionId, timeoutSec, signal);
  TerminalRegistry.sendAgentCommand(sessionId, ` ${cmd}`);
  const result = await resultPromise;
  return { ...result, output: cleanOutput(result.output, cmd) };
}

/**
 * Execute a command via terminal and capture output (used by read_file/write_file on SSH).
 */
async function executeViaTerminal(
  sessionId: string,
  cmd: string,
  timeoutSec = 15,
  shellType = 'bash',
): Promise<string> {
  const { output } = await executeAgentCommand(sessionId, cmd, shellType, timeoutSec);
  return truncateOutput(output, TOKEN_BUDGET.perToolOutputChars);
}

/**
 * Clean captured output: strip command echo line and trailing prompt lines.
 */
function cleanOutput(raw: string, sentCommand?: string): string {
  const lines = stripAnsi(raw).split('\n');

  // Strip command echo (first occurrence within first 3 lines)
  let start = 0;
  if (sentCommand) {
    const cmdText = sentCommand.trim();
    for (let i = 0; i < Math.min(3, lines.length); i++) {
      if (lines[i].includes(cmdText)) { start = i + 1; break; }
    }
  }

  // Strip trailing blank/prompt lines
  let end = lines.length;
  for (let i = lines.length - 1; i >= start; i--) {
    const t = lines[i].trim();
    if (t === '' || /^.*[\$#%>]\s*$/.test(t)) end = i;
    else break;
  }

  return lines.slice(start, end).join('\n').replace(/\n{3,}/g, '\n\n').trim();
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

// ─── Tool Implementations ────────────────────────────────────────

function createRunCommandTool(): ToolHandler {
  return {
    definition: {
      name: 'run_command',
      description:
        'Execute a shell command and return its output directly. Output is captured automatically. The command runs visibly in the terminal.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute (single command)' },
          timeout: {
            type: 'number',
            description: 'Timeout in seconds to wait for output (default: 30)',
            default: 30,
          },
        },
        required: ['command'],
      },
    },

    requiresConfirm(args) {
      return isDangerousCommand(args.command as string);
    },

    isDestructive(args) {
      return isExtremelyDangerous(args.command as string);
    },

    async execute(args, ctx): Promise<string> {
      const cmd = args.command as string;
      const timeout = (args.timeout as number) || 30;

      const mt = TerminalRegistry.get(ctx.sessionId);
      if (!mt?.ws || mt.ws.readyState !== WebSocket.OPEN) {
        return 'Error: terminal connection lost';
      }

      const { output: raw, exitCode, cwd } = await executeAgentCommand(
        ctx.sessionId, cmd, ctx.shellType, timeout,
      );
      const output = truncateOutput(cleanOutput(raw), TOKEN_BUDGET.perToolOutputChars);

      // Update CWD in tool context for future reference
      if (cwd) ctx.cwd = cwd;

      if (exitCode > 0) {
        return `[Exit code: ${exitCode}]\n${output}`;
      }
      return output;
    },
  };
}

function createReadTerminalTool(): ToolHandler {
  return {
    definition: {
      name: 'read_terminal',
      description:
        'Read the most recent N lines from the terminal screen buffer. Use ONLY to check terminal state before acting — NEVER after run_command (which already returns output).',
      parameters: {
        type: 'object',
        properties: {
          lines: {
            type: 'number',
            description: 'Number of lines to read (default: 50)',
            default: 50,
          },
        },
        required: [],
      },
    },
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx): Promise<string> {
      const maxLines = (args.lines as number) || TOKEN_BUDGET.defaultTerminalLines;
      const buffer = TerminalRegistry.serializeBuffer(ctx.sessionId);
      if (!buffer) return '(Terminal buffer is empty)';

      const stripped = stripAnsi(buffer);
      const lines = stripped.split('\n');
      const recent = lines.slice(-maxLines);
      const content = recent.join('\n').trim();
      return content || '(No output)';
    },
  };
}

function createReadFileTool(): ToolHandler {
  return {
    definition: {
      name: 'read_file',
      description: 'Read the content of a file at the given path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or relative file path' },
          maxLines: {
            type: 'number',
            description: 'Maximum number of lines to read (default: 200)',
            default: 200,
          },
        },
        required: ['path'],
      },
    },
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx): Promise<string> {
      const path = args.path as string;
      const maxLines = (args.maxLines as number) || 200;

      if (ctx.isSSH) {
        // SSH: read via terminal command
        const cmd = `head -n ${maxLines} "${path}" 2>&1`;
        return await executeViaTerminal(ctx.sessionId, cmd, 15, ctx.shellType);
      }

      // Local: use Tauri fs API
      try {
        // Size guard
        try {
          const fileStat = await stat(path);
          if (fileStat.size > 10 * 1024 * 1024) {
            return `File too large (${(fileStat.size / 1024 / 1024).toFixed(1)} MB). Use run_command with head/tail/grep to read specific parts.`;
          }
        } catch {
          // stat may fail on some paths; proceed to readTextFile which gives better errors
        }

        const content = await readTextFile(path);

        // Binary detection
        if (content.includes('\x00')) {
          return `This appears to be a binary file. Cannot display content. Use run_command with xxd or file to inspect.`;
        }

        // Line limit
        const lines = content.split('\n');
        if (lines.length > maxLines) {
          return (
            lines.slice(0, maxLines).join('\n') +
            `\n\n--- Showing first ${maxLines} of ${lines.length} lines. Use maxLines parameter or run_command with sed/awk to read specific ranges. ---`
          );
        }
        return content;
      } catch (e) {
        return `Error reading file: ${(e as Error).message}`;
      }
    },
  };
}

function createWriteFileTool(): ToolHandler {
  return {
    definition: {
      name: 'write_file',
      description:
        'Write content to a file at the given path. If the file exists it will be overwritten. Parent directories are created automatically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write to' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
    // Level 1: write_file always needs confirmation
    requiresConfirm: () => true,
    // Level 2: write_file does NOT need confirmation (user chose full-auto)
    isDestructive: () => false,

    async execute(args, ctx): Promise<string> {
      const filePath = args.path as string;
      const content = args.content as string;

      // Size guard
      if (content.length > 100 * 1024) {
        return `Content too large (${(content.length / 1024).toFixed(1)} KB). Break into smaller files or use run_command to write.`;
      }

      if (ctx.isSSH) {
        // SSH: write via heredoc
        const eofMarker = `METERM_EOF_${Math.random().toString(36).slice(2, 6)}`;
        // Ensure parent directory exists
        const dirCmd = `mkdir -p "$(dirname "${filePath}")"`;
        const writeCmd = `${dirCmd} && cat > "${filePath}" << '${eofMarker}'\n${content}\n${eofMarker}`;
        const result = await executeViaTerminal(ctx.sessionId, writeCmd, 15, ctx.shellType);
        if (result.toLowerCase().includes('error') || result.toLowerCase().includes('permission denied')) {
          return `Error writing file: ${result}`;
        }
        return `File written successfully: ${filePath} (${content.length} bytes)`;
      }

      // Local: Tauri fs API
      try {
        // Ensure parent directory exists
        const dirPath = filePath.replace(/[/\\][^/\\]*$/, '');
        if (dirPath && !(await exists(dirPath))) {
          await mkdir(dirPath, { recursive: true });
        }

        await writeTextFile(filePath, content);
        return `File written successfully: ${filePath} (${content.length} bytes)`;
      } catch (e) {
        return `Error writing file: ${(e as Error).message}`;
      }
    },
  };
}

// ─── Build Tool Context ──────────────────────────────────────────

/** Cached shell type per session */
const shellTypeCache = new Map<string, string>();

export function buildToolContext(sessionId: string): ToolContext {
  const info = DrawerManager.getServerInfo(sessionId);
  const isSSH = !!info;
  const mt = TerminalRegistry.get(sessionId);

  return {
    sessionId,
    isSSH,
    serverInfo: info ? `${info.username}@${info.host}:${info.port}` : null,
    shellType: shellTypeCache.get(sessionId) ?? 'bash',
    cwd: mt?.shellState.cwd ?? '',
  };
}

export function setShellType(sessionId: string, shellType: string): void {
  shellTypeCache.set(sessionId, shellType);
}

// ─── send_input Tool ─────────────────────────────────────────────

function createSendInputTool(): ToolHandler {
  return {
    definition: {
      name: 'send_input',
      description:
        'Send text or keystrokes to the terminal. Use for responding to interactive prompts (Y/n, passwords, confirmations). ' +
        'The text is sent as-is — include \\n for Enter key. Special keys: \\x03 for Ctrl+C, \\x04 for Ctrl+D.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Text to send. Use "y\\n" for confirming Y/n prompts, "\\n" for Enter, "\\x03" for Ctrl+C.',
          },
        },
        required: ['text'],
      },
    },
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx): Promise<string> {
      const raw = args.text as string;
      const mt = TerminalRegistry.get(ctx.sessionId);
      if (!mt?.ws || mt.ws.readyState !== WebSocket.OPEN) {
        return 'Error: terminal connection lost';
      }

      // Interpret escape sequences: \n, \x03, \x04, \t, etc.
      const text = raw.replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

      TerminalRegistry.sendInput(ctx.sessionId, text);
      return `Input sent: ${JSON.stringify(raw)}`;
    },
  };
}

// ─── watch_terminal Tool ─────────────────────────────────────────

function createWatchTerminalTool(): ToolHandler {
  return {
    definition: {
      name: 'watch_terminal',
      description:
        'Monitor terminal output in real-time. Uses idle-based timeout: keeps watching as long as output is flowing. ' +
        'Returns when: (1) a pattern is matched, (2) the shell returns to idle (command finished), ' +
        'or (3) no output for idle_timeout seconds. Suitable for long-running operations (downloads, installations, builds).',
      parameters: {
        type: 'object',
        properties: {
          idle_timeout: {
            type: 'number',
            description: 'Seconds of silence (no output) before returning. Resets on each new output. Default: 15',
          },
          pattern: {
            type: 'string',
            description: 'Optional regex pattern to match. Returns immediately when matched. Useful for detecting prompts like "[Y/n]", "password:", "Continue?"',
          },
        },
        required: [],
      },
    },
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx): Promise<string> {
      const mt = TerminalRegistry.get(ctx.sessionId);
      if (!mt?.ws || mt.ws.readyState !== WebSocket.OPEN) {
        return 'Error: terminal connection lost';
      }

      const idleTimeout = Math.max((args.idle_timeout as number) || 15, 3);
      const patternStr = args.pattern as string | undefined;
      let regex: RegExp | null = null;
      if (patternStr) {
        try {
          regex = new RegExp(patternStr, 'i');
        } catch {
          return `Error: invalid regex pattern "${patternStr}"`;
        }
      }

      return new Promise<string>((resolve) => {
        let outputBuffer = '';
        let resolved = false;
        let matchedLine = '';
        let idleTimer: ReturnType<typeof setTimeout>;
        const startTime = Date.now();

        const cleanup = () => {
          resolved = true;
          unsubOutput();
          unsubIdle();
          clearTimeout(idleTimer);
        };

        const finalize = (reason: string) => {
          if (resolved) return;
          cleanup();
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const stripped = stripAnsi(outputBuffer).trim();
          const truncated = truncateOutput(stripped, TOKEN_BUDGET.perToolOutputChars);
          if (reason === 'pattern') {
            resolve(`[Pattern matched after ${elapsed}s: "${matchedLine}"]\n${truncated}`);
          } else if (reason === 'idle') {
            const exitCode = mt.shellState.lastExitCode;
            resolve(`[Command finished after ${elapsed}s, exit code: ${exitCode}]\n${truncated}`);
          } else {
            resolve(`[No output for ${idleTimeout}s (total ${elapsed}s) — command may be waiting for input or still running]\n${truncated}`);
          }
        };

        // Reset idle timer — called on each new output
        const resetIdleTimer = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => finalize('silence'), idleTimeout * 1000);
        };

        // Start initial idle timer
        resetIdleTimer();

        // Subscribe to output stream
        const unsubOutput = TerminalRegistry.onOutput(ctx.sessionId, (data) => {
          if (resolved) return;
          outputBuffer += data;
          resetIdleTimer(); // output received → reset idle countdown

          // Check pattern match against recent lines
          if (regex) {
            const lines = stripAnsi(outputBuffer).split('\n');
            for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
              if (regex.test(lines[i])) {
                matchedLine = lines[i].trim();
                finalize('pattern');
                return;
              }
            }
          }
        });

        // Subscribe to shell idle (command finished)
        const unsubIdle = TerminalRegistry.onShellIdle(ctx.sessionId, () => {
          finalize('idle');
        });
      });
    },
  };
}

// ─── Web Search (SearXNG) ────────────────────────────────────────

function createWebSearchTool(): ToolHandler {
  return {
    definition: {
      name: 'web_search',
      description:
        'Search the web via SearXNG. Use ONLY when: (a) user explicitly asks to search, ' +
        '(b) you encounter an unknown command or error, or (c) you need current/real-time information. ' +
        'IMPORTANT: Always narrow scope with the `sites` parameter when context implies specific sources. Examples:\n' +
        '- Open-source tool / GitHub repo → sites: ["github.com"]\n' +
        '- Python package → sites: ["pypi.org","github.com","stackoverflow.com"]\n' +
        '- npm/node → sites: ["npmjs.com","github.com","stackoverflow.com"]\n' +
        '- Docker → sites: ["hub.docker.com","github.com"]\n' +
        '- Command help → sites: ["man7.org","ss64.com","stackoverflow.com"]\n' +
        '- General/unclear → omit sites',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords (concise)' },
          sites: { type: 'string', description: 'Comma-separated domains to restrict results (e.g. "github.com,stackoverflow.com"). Omit for unrestricted.' },
          language: { type: 'string', description: 'Result language code (en, zh, etc.). Default: auto' },
        },
        required: ['query'],
      },
    },
    execute: async (args) => {
      const settings = loadSettings();
      if (!settings.searxngEnabled || !settings.searxngUrl) {
        return 'Web search is not configured. Ask the user to set up SearXNG in Settings > AI.';
      }

      const query = String(args.query ?? '').trim();
      if (!query) return 'Empty search query.';

      // Build query with site filters
      const sitesRaw = String(args.sites ?? '').trim();
      const sites = sitesRaw ? sitesRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
      let finalQuery = query;
      if (sites.length > 0) {
        finalQuery += ' ' + sites.map(s => `site:${s}`).join(' OR ');
      }

      const baseUrl = settings.searxngUrl.replace(/\/+$/, '');
      const searchUrl = `${baseUrl}/search?q=${encodeURIComponent(finalQuery)}&format=json` +
        (args.language ? `&language=${encodeURIComponent(String(args.language))}` : '');

      const headers: [string, string][] = [];
      if (settings.searxngUsername && settings.searxngPassword) {
        headers.push(['Authorization', 'Basic ' + btoa(`${settings.searxngUsername}:${settings.searxngPassword}`)]);
      }

      try {
        const resp = await invoke<{ ok: boolean; status: number; body: string }>('fetch_ai_models', {
          request: { url: searchUrl, headers },
        });

        if (!resp.ok) return `Search request failed (HTTP ${resp.status}).`;

        const data = JSON.parse(resp.body);
        let results: { title?: string; url?: string; content?: string }[] = data.results ?? [];

        // Post-filter by domain if sites specified
        if (sites.length > 0) {
          const domains = sites.map(s => s.toLowerCase());
          results = results.filter(r => {
            try {
              const host = new URL(String(r.url)).hostname.toLowerCase();
              return domains.some(d => host === d || host.endsWith('.' + d));
            } catch { return false; }
          });
        }

        results = results.slice(0, 8);
        if (results.length === 0) return 'No results found.';

        return results.map((r, i) => {
          const snippet = (r.content ?? '').slice(0, 200);
          return `[${i + 1}] ${r.title ?? '(no title)'}\n    ${r.url}\n    ${snippet}`;
        }).join('\n\n');
      } catch (e) {
        return `Search error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    requiresConfirm: () => false,
    isDestructive: () => false,
  };
}

// ─── Initialize ──────────────────────────────────────────────────

export function initializeTools(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createRunCommandTool());
  registry.register(createReadTerminalTool());
  registry.register(createSendInputTool());
  registry.register(createWatchTerminalTool());
  registry.register(createReadFileTool());
  registry.register(createWriteFileTool());

  // Conditionally register web search if SearXNG is configured
  syncWebSearchTool(registry);

  return registry;
}

/** Sync web_search tool registration with current settings. */
export function syncWebSearchTool(registry: ToolRegistry): void {
  const settings = loadSettings();
  if (settings.searxngEnabled && settings.searxngUrl) {
    if (!registry.has('web_search')) {
      registry.register(createWebSearchTool());
    }
  } else {
    registry.unregister('web_search');
  }
}
