// ─── AI Tools: Command / Terminal Interaction Tools ─────────────
// run_command, read_terminal, type_text, press_keys, watch_terminal
// All tools that interact with the live terminal session.

import { TerminalRegistry } from './terminal';
import {
  ToolHandler,
  TOKEN_BUDGET,
  stripAnsi,
  truncateOutput,
  isDangerousCommand,
  isExtremelyDangerous,
  resolvePaneTarget,
  type PaneInfo,
  type ToolContext,
} from './ai-tools-core';
import { executeAgentCommand, withSessionPtyLock } from './ai-tools-shell';
import { detectInteractiveState } from './ai-tools-prompt-detect';
import { resolveSingleKey } from './ai-tools-keys';

/**
 * Shared pane-parameter schema fragment. Every terminal tool exposes
 * an optional `pane: <number>` that routes the call to a non-default
 * pane of the same tab.
 */
const PANE_PARAM_SCHEMA = {
  type: 'number',
  description: 'Optional target pane number (1-based). Omit to use the default target (the pane the user focused when they hit Send). Invalid numbers return an error.',
} as const;

/**
 * Resolve the pane target and return a `[pane: N]` prefix for tool
 * result messages, or an error string. When the pane equals the
 * default target, the prefix is omitted (cleaner results).
 */
function paneHeaderFor(ctx: ToolContext, pane: PaneInfo): string {
  if (pane.isDefaultTarget) return '';
  return `[pane: ${pane.paneNumber}]\n`;
}

/** Real UTF-8 byte length of a JS string (not UTF-16 code units). */
function utf8ByteLen(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Read xterm.js's alternate-screen flag for a session. */
function isAlternateScreen(sessionId: string): boolean {
  const mt = TerminalRegistry.get(sessionId);
  try {
    return mt?.terminal.buffer.active.type === 'alternate';
  } catch {
    return false;
  }
}

/**
 * Build a structured `[Terminal: ...]` line describing the TUI lifecycle
 * transition that just happened. Used by type_text / press_keys / run_command
 * so the LLM has an authoritative, machine-readable signal for whether it
 * is currently inside a TUI — instead of guessing from output bytes.
 *
 * Caller passes in the alt-screen state captured BEFORE the action; this
 * helper reads the CURRENT state and emits one of four labels.
 */
function formatTerminalStateLine(sessionId: string, wasAlt: boolean): string {
  const nowAlt = isAlternateScreen(sessionId);
  if (wasAlt && nowAlt) {
    return '[Terminal: TUI active — use read_screen to see what is on screen. Do NOT use read_terminal or watch_terminal for TUI inspection — they return raw cursor-positioning escapes that do NOT match what the user sees.]';
  }
  if (wasAlt && !nowAlt) {
    return '[Terminal: TUI just exited — you are back at the shell prompt. STOP sending TUI exit keys (q / :q / Ctrl-C). Resume normal shell commands via run_command.]';
  }
  if (!wasAlt && nowAlt) {
    return '[Terminal: TUI just started — call read_screen to see what is displayed before issuing more keys.]';
  }
  return '[Terminal: shell prompt — no TUI active.]';
}

/** Sleep helper for the post-action settle window. */
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Reusable security gate: refuse to write the PTY when the screen
 * is showing a password prompt.  Returns an error string when the
 * call should be refused, or null to proceed. */
function checkPasswordGate(sessionId: string): string | null {
  const buf = TerminalRegistry.serializeBuffer(sessionId) ?? '';
  const det = detectInteractiveState(buf, false);
  if (det.state === 'waiting_password') {
    return 'Error: REFUSED — the terminal is showing a password prompt. '
      + 'Agents MUST NOT send passwords through this tool under any circumstances, '
      + 'and MUST NOT ask the user for a password in the chat. '
      + 'Call wait_for_user_input with a clear `reason` instead.';
  }
  return null;
}
import { captureTerminalScreen } from './ai-tools-screen';
import type { ToolOutputWithImages } from './ai-tools-core';

// ─── run_command ─────────────────────────────────────────────────

export function createRunCommandTool(): ToolHandler {
  return {
    definition: {
      name: 'run_command',
      description:
        'Execute a shell command and wait for it to complete. Returns a status header so you can see whether the command finished, is waiting for input, or entered a full-screen TUI.\n' +
        '\n' +
        'Status values you may see at the top of the result (detailed next-step hint is appended to every non-completed status):\n' +
        '  [status: completed]         — command finished, exit code included\n' +
        '  [status: waiting_password]  — a password/passphrase prompt was detected — you MUST call wait_for_user_input (type_text / press_keys are refused on password prompts)\n' +
        '  [status: waiting_confirm]   — a Y/n prompt was detected — respond with type_text("y") + press_keys("Enter")\n' +
        '  [status: waiting_input]     — a generic prompt was detected — inspect context with watch_terminal, then type_text the value + press_keys("Enter") (or wait_for_user_input if sensitive)\n' +
        '  [status: tui]               — the command entered a full-screen TUI (vim, top, less…) — exit it with press_keys("q") / press_keys("Ctrl-C") / etc. before running anything else\n' +
        '  [status: idle_no_signal]    — the command is still running but silent — use watch_terminal to observe further output\n' +
        '  [status: timeout]           — hit the timeout — the command may still be running; use watch_terminal to check\n' +
        '\n' +
        'When status is anything other than "completed", do NOT issue another run_command until you have resolved the current state.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute (single command)' },
          timeout: {
            type: 'number',
            description: 'Timeout in seconds to wait for output (default: 30)',
            default: 30,
          },
          pane: PANE_PARAM_SCHEMA,
        },
        required: ['command'],
      },
    },

    // run_command mutates terminal state → never concurrent.
    isConcurrencySafe: false,

    requiresConfirm(args) {
      return isDangerousCommand(args.command as string);
    },

    isDestructive(args) {
      return isExtremelyDangerous(args.command as string);
    },

    async execute(args, ctx): Promise<string> {
      const cmd = args.command as string;
      const timeout = (args.timeout as number) || 30;

      const resolved = resolvePaneTarget(ctx, args.pane);
      if (!resolved.ok) return `Error: ${resolved.error}`;
      const pane = resolved.pane;

      const mt = TerminalRegistry.get(pane.sessionId);
      const connected = (mt?.transport && mt.transport.connected) || (mt?.ws && mt.ws.readyState === WebSocket.OPEN);
      if (!connected) {
        return `${paneHeaderFor(ctx, pane)}Error: terminal connection lost`;
      }

      const {
        output: raw, exitCode, cwd, status, detectorLine, promptInfo,
      } = await executeAgentCommand(
        pane.sessionId, cmd, pane.shellType, timeout,
      );
      // executeAgentCommand already stripped ANSI + command echo + trailing
      // prompt lines via cleanOutput() — we only need size-limit truncation.
      const output = truncateOutput(raw, TOKEN_BUDGET.perToolOutputChars);

      // Update CWD in tool context for the default target only.
      if (cwd && pane.isDefaultTarget) ctx.cwd = cwd;

      // ── Build a structured header so the LLM can distinguish
      //    "done" from "stuck on a prompt".  We always surface the
      //    status — even for 'completed' — so the contract is
      //    consistent from the model's point of view.
      let header = `[status: ${status}`;
      if (status === 'completed') {
        header += `, exit: ${exitCode}`;
      } else if (detectorLine) {
        // Include the matched prompt line verbatim so the LLM can
        // quote it back when explaining what it's doing.
        header += `, prompt: ${JSON.stringify(detectorLine)}`;
      }
      header += ']';

      // Structured prompt info, when a library-specific parser matched.
      // Emitted on its own line so the LLM can parse it as JSON without
      // worrying about the surrounding status header format.
      const promptInfoLine = promptInfo
        ? `\n[prompt_info: ${JSON.stringify(promptInfo)}]`
        : '';

      // Terse next-step hints only for non-completed states.  Kept
      // short because the system prompt already explains semantics.
      const hint = buildNextStepHint(status);
      const body = output || '(no output captured)';
      const panePrefix = paneHeaderFor(ctx, pane);

      if (status === 'completed' && exitCode > 0) {
        return `${panePrefix}${header}${promptInfoLine}\n${body}`;
      }
      if (hint) {
        return `${panePrefix}${header}${promptInfoLine}\n${body}\n${hint}`;
      }
      return `${panePrefix}${header}${promptInfoLine}\n${body}`;
    },
  };
}

/** Terse next-step hint appended to run_command results for non-completed states. */
function buildNextStepHint(status: string): string {
  switch (status) {
    case 'waiting_password':
      return '[hint] The command is blocked on a PASSWORD prompt. '
        + 'You MUST call wait_for_user_input with a clear `reason` (e.g. "sudo password for apt install"). '
        + 'NEVER ask the user for the password in chat, and NEVER call type_text / press_keys here — both are refused on password prompts. '
        + 'wait_for_user_input will pause the agent, show a card prompting the user to type the password directly into the terminal, and auto-resume once the command completes.';
    case 'waiting_confirm':
      return '[hint] The command is waiting for a Y/n confirmation. If your intent is clear (install, proceed, overwrite, …), call type_text("y") followed by press_keys("Enter") (or "n"). If you are unsure, call wait_for_user_input so the user can decide in-terminal.';
    case 'waiting_input':
      return '[hint] The command is waiting for input. Call watch_terminal to see more context first. If the input is sensitive (API key, passphrase, token), use wait_for_user_input so the user types it directly — otherwise type_text the value and press_keys("Enter").';
    case 'tui':
      return '[hint] The terminal is in a full-screen TUI. To SEE what is on the screen, call read_screen — NEVER use read_terminal or watch_terminal for TUI inspection (they return cursor-positioning escapes that do not match what the user sees). To exit, use press_keys with the program-specific quit sequence (press_keys("q") for less/man/top/htop, press_keys("Esc") then type_text(":q") + press_keys("Enter") for vim, press_keys("Ctrl-C") to interrupt). After each exit attempt, INSPECT the [Terminal: ...] state line in the press_keys result — if it says "TUI just exited", STOP sending more exit keys. If you have made 2 exit attempts without success, call read_screen to verify the state, and consider web_search "how to quit <program>" for unfamiliar programs. Do NOT use wait_for_user_input here.';
    case 'idle_no_signal':
      return '[hint] The process is silent but may still be running. Call watch_terminal to observe, or read_terminal for a snapshot.';
    case 'timeout':
      return '[hint] The command exceeded its timeout. It may still be running. Use watch_terminal to observe, press_keys("Ctrl-C") to interrupt, or re-run with a longer timeout.';
    case 'aborted':
      return '[hint] Execution was aborted by the user.';
    default:
      return '';
  }
}

// ─── read_terminal ───────────────────────────────────────────────

export function createReadTerminalTool(): ToolHandler {
  return {
    definition: {
      name: 'read_terminal',
      description:
        'Read the most recent N lines from a pane\'s terminal screen buffer. Use ONLY to check terminal state before acting — NEVER after run_command (which already returns output). Pass `pane: <N>` to read a non-default pane (useful for correlating state across panes — e.g. check pane 2\'s logs while operating pane 1).',
      parameters: {
        type: 'object',
        properties: {
          lines: {
            type: 'number',
            description: 'Number of lines to read (default: 50)',
            default: 50,
          },
          pane: PANE_PARAM_SCHEMA,
        },
        required: [],
      },
    },
    // Read-only snapshot of the terminal buffer → safe to run in parallel.
    isConcurrencySafe: true,
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx): Promise<string> {
      const resolved = resolvePaneTarget(ctx, args.pane);
      if (!resolved.ok) return `Error: ${resolved.error}`;
      const pane = resolved.pane;
      const maxLines = (args.lines as number) || TOKEN_BUDGET.defaultTerminalLines;
      const buffer = TerminalRegistry.serializeBuffer(pane.sessionId);
      const prefix = paneHeaderFor(ctx, pane);
      if (!buffer) return `${prefix}(Terminal buffer is empty)`;

      const stripped = stripAnsi(buffer);
      const lines = stripped.split('\n');
      const recent = lines.slice(-maxLines);
      const content = recent.join('\n').trim();
      return `${prefix}${content || '(No output)'}`;
    },
  };
}

// ─── type_text ───────────────────────────────────────────────────
//
// Literal-text input. Sends `text` verbatim as UTF-8 bytes — no
// <Enter> parsing, no \n translation, no <...> token interpretation.
// Use whenever the LLM wants the program to "see exactly these
// characters" — answers, paths, code, Chinese, emoji, or anything
// containing literal `<` / `\` that a key-token parser would
// otherwise misinterpret.
//
// Pair with press_keys() when you also need a control key:
//   type_text("y") → press_keys("Enter")

export function createTypeTextTool(): ToolHandler {
  return {
    definition: {
      name: 'type_text',
      description:
        'Type literal text into the terminal. Sends the `text` argument verbatim as UTF-8 bytes — NO escape parsing, NO <Enter>/<Tab> tokens, NO backslash translation.\n' +
        '\n' +
        'Use this whenever you want the user/program to "see exactly these characters". Use press_keys() right after if you also need to press Enter or other keys.\n' +
        '\n' +
        'Common patterns:\n' +
        '  • Answer a prompt:        type_text("y") + press_keys("Enter")\n' +
        '  • Type Chinese:           type_text("你好,你是谁") + press_keys("Enter")\n' +
        '  • Search in vim:          type_text("/needle") + press_keys("Enter")\n' +
        '  • Type a file path:       type_text("/etc/hosts")\n' +
        '  • Snippet with angle:     type_text("if (x < 3) {")     ← angle brackets stay literal\n' +
        '  • Type a regex:           type_text("\\\\d+")              ← backslash stays literal\n' +
        '\n' +
        'Rules:\n' +
        '  • REFUSED on password prompts: use wait_for_user_input.\n' +
        '  • Empty string is rejected — pass a real value.\n' +
        '  • For Enter / Tab / arrows / Ctrl-C / etc., call press_keys() — type_text("\\n") types a literal backslash + n.\n' +
        '  • The send is one contiguous PTY write.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Literal text to type. Sent verbatim — no escape parsing.',
          },
          pane: PANE_PARAM_SCHEMA,
        },
        required: ['text'],
      },
    },
    isConcurrencySafe: false,
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx): Promise<string> {
      const text = args.text;
      if (typeof text !== 'string') {
        return 'Error: type_text requires a string "text" argument.';
      }
      if (text.length === 0) {
        return 'Error: type_text received an empty string. Pass a real value.';
      }

      const resolved = resolvePaneTarget(ctx, args.pane);
      if (!resolved.ok) return `Error: ${resolved.error}`;
      const pane = resolved.pane;

      const mt = TerminalRegistry.get(pane.sessionId);
      const connected = (mt?.transport && mt.transport.connected) || (mt?.ws && mt.ws.readyState === WebSocket.OPEN);
      if (!connected) {
        return `${paneHeaderFor(ctx, pane)}Error: terminal connection lost`;
      }

      const refusal = checkPasswordGate(pane.sessionId);
      if (refusal) return `${paneHeaderFor(ctx, pane)}${refusal}`;

      // Acquire the per-session PTY lock so we never interleave bytes
      // with another in-flight tool (run_command waiting for completion,
      // an SSH-routed read_file, etc.) targeting the same session.
      return await withSessionPtyLock(pane.sessionId, async () => {
        const wasAlt = isAlternateScreen(pane.sessionId);
        TerminalRegistry.sendInput(pane.sessionId, text);
        // Brief settle so the program can react (e.g. exit alt-screen
        // after `:q<Enter>` or enter alt-screen after `vim foo<Enter>`).
        // Without this we'd snapshot the BEFORE state.
        await sleep(80);
        const stateLine = formatTerminalStateLine(pane.sessionId, wasAlt);
        return `${paneHeaderFor(ctx, pane)}Typed: ${JSON.stringify(text)} → ${utf8ByteLen(text)} bytes\n${stateLine}`;
      });
    },
  };
}

// ─── press_keys ──────────────────────────────────────────────────
//
// Named-key keyboard input. Accepts ONLY named key tokens (and
// modifier combinations). Will NOT accept long literal strings —
// pass those through type_text instead.

export function createPressKeysTool(): ToolHandler {
  return {
    definition: {
      name: 'press_keys',
      description:
        'Press keyboard keys on the terminal. The bytes written are BYTE-FOR-BYTE the same data the kernel sees from a real keyboard — Enter is CR (0x0D), arrows are CSI sequences, Ctrl-C is 0x03, etc.\n' +
        '\n' +
        'This tool accepts ONLY named key tokens. To type literal characters call type_text() instead.\n' +
        '\n' +
        'Argument forms:\n' +
        '  • Single key:    press_keys({keys: "Enter"})\n' +
        '  • Array:         press_keys({keys: ["Down", "Down", "Enter"]})\n' +
        '  • Space-separated string: press_keys({keys: "Down Down Enter"})\n' +
        '\n' +
        'Known keys (case-insensitive):\n' +
        '  Enter Return CR LF Tab ShiftTab Esc Escape Space Backspace BS\n' +
        '  Delete Del Insert Ins\n' +
        '  Up Down Left Right Home End PageUp PgUp PageDown PgDn\n' +
        '  F1..F12\n' +
        '\n' +
        'Modifiers (combinable, any order):\n' +
        '  Ctrl-X / Control-X / C-x   — Ctrl + letter (0x01..0x1A)\n' +
        '  Alt-X / Meta-X / M-x       — Alt prepends ESC\n' +
        '  Shift-Tab                  — back-tab (CSI Z)\n' +
        '  Ctrl-Left / Ctrl-Right     — bash word-jump\n' +
        '  Alt-Backspace              — bash word-delete\n' +
        '\n' +
        'Examples:\n' +
        '  • Submit:               press_keys("Enter")\n' +
        '  • Cancel:               press_keys("Ctrl-C")\n' +
        '  • Quit less / man:      press_keys("q")\n' +
        '  • Vim quit:             type_text(":q") + press_keys("Enter")\n' +
        '  • Menu navigate:        press_keys(["Down", "Down", "Enter"])\n' +
        '  • fzf select 3rd:       press_keys("Down Down Enter")\n' +
        '  • Word back:            press_keys("Alt-B")\n' +
        '  • Tab complete:         press_keys("Tab")\n' +
        '  • Clear screen:         press_keys("Ctrl-L")\n' +
        '\n' +
        'Rules:\n' +
        '  • REFUSED on password prompts: use wait_for_user_input.\n' +
        '  • Unknown key tokens (e.g. "FooBar") return an error — use type_text for literal characters.\n' +
        '  • A single non-alphanumeric character (".", ",", "/", "q") is accepted as itself.\n' +
        '  • All keys in one call are sent as a contiguous burst.',
      parameters: {
        type: 'object',
        properties: {
          keys: {
            type: 'string',
            description: 'One or more key tokens. Accepts a single name ("Enter"), a space-separated list ("Down Down Enter"), or a JSON array ("[\\"Down\\",\\"Down\\",\\"Enter\\"]"). Case-insensitive. Modifiers: Ctrl-, Alt-, Shift-.',
          },
          pane: PANE_PARAM_SCHEMA,
        },
        required: ['keys'],
      },
    },
    isConcurrencySafe: false,
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx): Promise<string> {
      const raw = args.keys;
      // Normalize input into a list of token strings.
      let tokens: string[];
      if (typeof raw === 'string') {
        tokens = raw.split(/\s+/).filter(Boolean);
      } else if (Array.isArray(raw)) {
        tokens = (raw as unknown[])
          .map((t) => (typeof t === 'string' ? t.trim() : ''))
          .filter(Boolean);
      } else {
        return 'Error: press_keys requires a "keys" argument (string or array of strings).';
      }
      if (tokens.length === 0) {
        return 'Error: press_keys received no key tokens. Pass at least one named key.';
      }

      const paneResolved = resolvePaneTarget(ctx, args.pane);
      if (!paneResolved.ok) return `Error: ${paneResolved.error}`;
      const pane = paneResolved.pane;

      const mt = TerminalRegistry.get(pane.sessionId);
      const connected = (mt?.transport && mt.transport.connected) || (mt?.ws && mt.ws.readyState === WebSocket.OPEN);
      if (!connected) {
        return `${paneHeaderFor(ctx, pane)}Error: terminal connection lost`;
      }

      const refusal = checkPasswordGate(pane.sessionId);
      if (refusal) return `${paneHeaderFor(ctx, pane)}${refusal}`;

      // Resolve every token. Unknown ones become an error so the
      // LLM knows to switch to type_text for literal characters.
      let bytes = '';
      const labels: string[] = [];
      for (const token of tokens) {
        const keyBytes = resolveSingleKey(token);
        if (keyBytes !== null) {
          bytes += keyBytes;
          labels.push(token);
          continue;
        }
        // Single non-angle-bracket character is allowed as a literal
        // convenience — useful for `press_keys("/")` when opening
        // vim search, or `press_keys("q")` to quit less.
        if (token.length === 1 && token !== '<' && token !== '>') {
          bytes += token;
          labels.push(token);
          continue;
        }
        return `${paneHeaderFor(ctx, pane)}Error: unknown key token "${token}". Known keys: Enter/Tab/Esc/Space/Backspace/Delete/Up/Down/Left/Right/Home/End/PageUp/PageDown/F1-F12 with optional Ctrl-/Alt-/Shift- modifiers. For literal characters use type_text() instead.`;
      }

      // Acquire the per-session PTY lock — see the type_text wrapper
      // for the rationale. Press_keys is just as racy as type_text
      // because both ultimately call TerminalRegistry.sendInput.
      return await withSessionPtyLock(pane.sessionId, async () => {
        const wasAlt = isAlternateScreen(pane.sessionId);
        TerminalRegistry.sendInput(pane.sessionId, bytes);
        // Brief settle so the program can react to the keys. Critical
        // for the "TUI just exited" case — vim writes \x1b[?1049l within
        // a few ms of receiving :q<Enter> and we want to catch the post
        // state.
        await sleep(80);
        const byteLen = utf8ByteLen(bytes);
        const ctrlCount = Array.from(bytes).filter(c => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f).length;
        const stateLine = formatTerminalStateLine(pane.sessionId, wasAlt);
        return `${paneHeaderFor(ctx, pane)}Pressed: [${labels.join(' ')}] → ${byteLen} bytes (${ctrlCount} control)\n${stateLine}`;
      });
    },
  };
}

// ─── watch_terminal ──────────────────────────────────────────────

export function createWatchTerminalTool(): ToolHandler {
  return {
    definition: {
      name: 'watch_terminal',
      description:
        'Observe terminal output live for a running command/process. Returns a structured [status: ...] header identical to run_command, plus the collected output.\n' +
        '\n' +
        'Returns when ANY of the following happens:\n' +
        '  1. Shell returns to idle (command finished) → status: completed\n' +
        '  2. A password / Y-n / generic input prompt is detected → status: waiting_password / waiting_confirm / waiting_input\n' +
        '  3. The terminal enters a full-screen TUI → status: tui\n' +
        '  4. A caller-supplied regex pattern matches → status: pattern_matched\n' +
        '  5. No output for idle_timeout seconds → status: idle_no_signal\n' +
        '\n' +
        'Typical use: after a run_command that returned idle_no_signal / timeout, or after you typed input via type_text / press_keys and want to observe the reaction.',
      parameters: {
        type: 'object',
        properties: {
          idle_timeout: {
            type: 'number',
            description: 'Seconds of silence (no output) before returning idle_no_signal. Resets on each new output. Default: 15',
          },
          pattern: {
            type: 'string',
            description: 'Optional regex pattern to match. Returns immediately when matched. Useful for waiting on specific prompts beyond the built-in detector.',
          },
          pane: PANE_PARAM_SCHEMA,
        },
        required: [],
      },
    },
    // watch_terminal blocks the session on live output → not concurrent.
    isConcurrencySafe: false,
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx): Promise<string> {
      const paneResolved = resolvePaneTarget(ctx, args.pane);
      if (!paneResolved.ok) return `Error: ${paneResolved.error}`;
      const pane = paneResolved.pane;
      const panePrefix = paneHeaderFor(ctx, pane);

      const mt = TerminalRegistry.get(pane.sessionId);
      const connected = (mt?.transport && mt.transport.connected) || (mt?.ws && mt.ws.readyState === WebSocket.OPEN);
      if (!connected) {
        return `${panePrefix}Error: terminal connection lost`;
      }

      const idleTimeout = Math.max((args.idle_timeout as number) || 15, 3);
      const patternStr = args.pattern as string | undefined;
      let regex: RegExp | null = null;
      if (patternStr) {
        try {
          regex = new RegExp(patternStr, 'i');
        } catch {
          return `${panePrefix}Error: invalid regex pattern "${patternStr}"`;
        }
      }

      type FinishReason =
        | 'pattern_matched'
        | 'completed'
        | 'idle_no_signal'
        | 'waiting_password'
        | 'waiting_confirm'
        | 'waiting_input'
        | 'tui';

      // Baseline alt-screen state — treat a transition false→true
      // as "a TUI just started". If the session is already inside
      // tmux/screen, baselineAlt === true and we never report 'tui'.
      let baselineAlt = false;
      try {
        baselineAlt = mt.terminal.buffer.active.type === 'alternate';
      } catch { /* ignore */ }

      // Acquire the per-session PTY lock for the entire watch window.
      // While we're observing this session, no other tool may inject
      // input or kick off another command on the same PTY — that would
      // race with the running command we're waiting on and corrupt
      // both its output and our view of it. Different sessions remain
      // free to run in parallel.
      return withSessionPtyLock(pane.sessionId, () => new Promise<string>((resolve) => {
        let outputBuffer = '';
        let resolved = false;
        let matchedLine = '';
        let idleTimer: ReturnType<typeof setTimeout>;
        let detectorTimer: ReturnType<typeof setInterval>;
        const startTime = Date.now();

        const cleanup = () => {
          resolved = true;
          unsubOutput();
          unsubIdle();
          clearTimeout(idleTimer);
          clearInterval(detectorTimer);
        };

        const finalize = (
          reason: FinishReason,
          extra?: string,
          promptInfo?: import('./ai-tools-prompt-detect').PromptInfo,
        ) => {
          if (resolved) return;
          cleanup();
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const stripped = stripAnsi(outputBuffer).trim();
          const truncated = truncateOutput(stripped, TOKEN_BUDGET.perToolOutputChars);

          let header = `[status: ${reason}, elapsed: ${elapsed}s`;
          if (reason === 'completed') {
            header += `, exit: ${mt.shellState.lastExitCode}`;
          } else if (reason === 'pattern_matched' && matchedLine) {
            header += `, match: ${JSON.stringify(matchedLine)}`;
          } else if (extra) {
            header += `, prompt: ${JSON.stringify(extra)}`;
          }
          header += ']';
          const promptInfoLine = promptInfo
            ? `\n[prompt_info: ${JSON.stringify(promptInfo)}]`
            : '';
          resolve(`${panePrefix}${header}${promptInfoLine}\n${truncated || '(no output)'}`);
        };

        // Reset idle timer — called on each new output
        const resetIdleTimer = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => finalize('idle_no_signal'), idleTimeout * 1000);
        };

        // Start initial idle timer
        resetIdleTimer();

        // Periodic detector check: alt-screen transition + prompt patterns
        detectorTimer = setInterval(() => {
          if (resolved) return;
          // Only report 'tui' if alt-screen flipped on *during* this
          // watch. Sessions already in tmux have baselineAlt=true.
          try {
            const nowAlt = mt.terminal.buffer.active.type === 'alternate';
            if (!baselineAlt && nowAlt) {
              finalize('tui');
              return;
            }
          } catch { /* ignore */ }
          const det = detectInteractiveState(outputBuffer, false);
          if (det.state === 'waiting_password' || det.state === 'waiting_confirm' || det.state === 'waiting_input') {
            finalize(det.state, det.matchedLine, det.promptInfo);
          }
        }, 400);

        // Subscribe to output stream
        const unsubOutput = TerminalRegistry.onOutput(pane.sessionId, (data) => {
          if (resolved) return;
          outputBuffer += data;
          resetIdleTimer(); // output received → reset idle countdown

          // Check caller-supplied pattern first — it wins over detector.
          if (regex) {
            const lines = stripAnsi(outputBuffer).split('\n');
            for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
              if (regex.test(lines[i])) {
                matchedLine = lines[i].trim();
                finalize('pattern_matched');
                return;
              }
            }
          }
        });

        // Subscribe to shell idle (command finished)
        const unsubIdle = TerminalRegistry.onShellIdle(pane.sessionId, () => {
          finalize('completed');
        });
      }));
    },
  };
}

// ─── wait_for_user_input ─────────────────────────────────────────
//
// This is the SAFE path for handling interactive credential prompts
// (sudo password, ssh passphrase, GPG, mysql, dpkg etc.). The agent
// pauses itself here; a UI card tells the user to type into the
// terminal; the tool returns when the shell goes idle again.
//
// Security contract:
//   • We never read what the user typed — bytes go directly from
//     xterm.js to the backend PTY via the normal input path.
//   • The tool's return value never contains the user's keystrokes;
//     it reports only "completed" / "timeout" / "cancelled".
//   • The conversation history is never polluted with secrets.

export function createWaitForUserInputTool(): ToolHandler {
  return {
    definition: {
      name: 'wait_for_user_input',
      description:
        'Pause the agent and wait for the USER to type something directly in the terminal (sudo/SSH/GPG password, host-key confirmation, TUI input, etc.).\n' +
        '\n' +
        '== CRITICAL SECURITY RULE ==\n' +
        'Whenever a command is blocked on a password prompt, YOU MUST call this tool. NEVER ask the user for a password in the chat — passwords must go directly from the user\'s keyboard to the terminal so they stay out of the conversation history and model context.\n' +
        '\n' +
        'What this tool does:\n' +
        '  • Shows a highlighted "Agent paused — waiting for you" card in the UI\n' +
        '  • Sends a desktop notification if the window is in the background\n' +
        '  • Blocks until the shell returns to its prompt (command finished) OR the caller-specified timeout elapses OR the user cancels\n' +
        '  • Does NOT read what the user typed\n' +
        '\n' +
        'Returns a [status: ...] header:\n' +
        '  [status: completed, exit: N]   — shell is back at its prompt, the agent should inspect terminal state and continue\n' +
        '  [status: timeout]              — user did not respond within the timeout, agent should stop and ask for help in plain text\n' +
        '  [status: aborted]              — the user cancelled the wait',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Short human-readable reason shown to the user in the waiting card. E.g. "sudo password for apt install", "SSH host key confirmation for new server", "GPG passphrase for signing".',
          },
          timeout: {
            type: 'number',
            description: 'Maximum seconds to wait before giving up. Default: 300 (5 minutes). Clamped to [30, 1800].',
            default: 300,
          },
        },
        required: ['reason'],
      },
    },
    // Serializes the agent loop by design — never concurrent.
    isConcurrencySafe: false,
    // Already safe (read-only wait); never needs confirmation or is destructive.
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx): Promise<string> {
      const reason = String(args.reason || 'User input required').slice(0, 200);
      const timeoutSec = Math.min(
        Math.max((args.timeout as number) || 300, 30),
        1800,
      );

      const mt = TerminalRegistry.get(ctx.sessionId);
      if (!mt) return 'Error: terminal session not found';
      const connected = (mt.transport && mt.transport.connected) || (mt.ws && mt.ws.readyState === WebSocket.OPEN);
      if (!connected) {
        return 'Error: terminal connection lost';
      }

      // Tell the UI to open a "paused for user input" card. This goes
      // through a DOM CustomEvent so we don't need to thread another
      // dep into ToolContext — ai-capsule-tool-ui subscribes to it.
      const cardId = `wait-${Date.now().toString(36)}`;
      document.dispatchEvent(new CustomEvent('ai-wait-for-user-input-start', {
        detail: { sessionId: ctx.sessionId, cardId, reason, timeoutSec },
      }));

      const startedAt = Date.now();

      return new Promise<string>((resolve) => {
        let resolved = false;
        let unsubIdle: (() => void) | null = null;
        let unsubCancel: (() => void) | null = null;
        let onAbort: (() => void) | null = null;
        let deadline: ReturnType<typeof setTimeout> | null = null;

        const dispatchEnd = (status: string) => {
          try {
            document.dispatchEvent(new CustomEvent('ai-wait-for-user-input-end', {
              detail: { cardId, status },
            }));
          } catch { /* ignore */ }
        };

        const cleanup = () => {
          if (resolved) return;
          resolved = true;
          if (unsubIdle) unsubIdle();
          if (unsubCancel) unsubCancel();
          if (deadline) clearTimeout(deadline);
          if (onAbort && ctx.abortSignal) {
            ctx.abortSignal.removeEventListener('abort', onAbort);
          }
        };

        // User clicks "Cancel" in the waiting card — this is the
        // intended escape hatch if they decide to stop the task.
        const onCancel = (e: Event) => {
          const ev = e as CustomEvent<{ cardId: string }>;
          if (ev.detail?.cardId !== cardId) return;
          cleanup();
          dispatchEnd('aborted');
          resolve(`[status: aborted, elapsed: ${Math.round((Date.now() - startedAt) / 1000)}s]\nUser cancelled the wait. Stop and ask the user in plain text what to do next.`);
        };
        document.addEventListener('ai-wait-for-user-input-cancel', onCancel);
        unsubCancel = () => document.removeEventListener('ai-wait-for-user-input-cancel', onCancel);

        // External abort signal from the owning ToolAgent — e.g. the
        // user pressed Escape / clicked the stop button at the top
        // level, or closed the chat panel. Unblock immediately.
        if (ctx.abortSignal) {
          if (ctx.abortSignal.aborted) {
            // Already aborted before we even started listening.
            cleanup();
            dispatchEnd('aborted');
            resolve(`[status: aborted, elapsed: 0s]\nRun aborted before user could respond.`);
            return;
          }
          onAbort = () => {
            if (resolved) return;
            cleanup();
            dispatchEnd('aborted');
            resolve(`[status: aborted, elapsed: ${Math.round((Date.now() - startedAt) / 1000)}s]\nRun aborted by the user.`);
          };
          ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
        }

        // Hard timeout.
        deadline = setTimeout(() => {
          if (resolved) return;
          cleanup();
          dispatchEnd('timeout');
          resolve(`[status: timeout, elapsed: ${timeoutSec}s]\nUser did not complete the input within the timeout. Stop and ask the user in plain text whether they need more time or want to abort the operation.`);
        }, timeoutSec * 1000);

        // Primary signal: shell returned to its prompt (OSC 7768).
        // This fires ONCE the user has typed the credential + Enter
        // and the underlying command (sudo/ssh/gpg) finished.
        unsubIdle = TerminalRegistry.onShellIdle(ctx.sessionId, () => {
          if (resolved) return;
          cleanup();
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          const exit = mt.shellState.lastExitCode;
          dispatchEnd('completed');
          resolve(
            `[status: completed, elapsed: ${elapsed}s, exit: ${exit}]\n`
            + `User input complete; the shell has returned to its prompt. `
            + `Inspect the terminal (read_terminal) if you need to see the result of the command that was waiting.`,
          );
        });
      });
    },
  };
}

// ─── read_screen ─────────────────────────────────────────────────
//
// Captures a PNG snapshot of the live terminal and attaches it to
// the tool result as an image. Useful when the text buffer alone
// isn't enough (TUI programs, mouse menus, ncurses dialogs, etc.).

export function createReadScreenTool(): ToolHandler {
  return {
    definition: {
      name: 'read_screen',
      description:
        'Capture a PNG screenshot of the current terminal display and attach it to the tool result as an image part — YOU will receive the actual image and should look at it directly.\n' +
        '\n' +
        'WHY THIS TOOL EXISTS:\n' +
        'TUI programs (vim, htop, less, tmux, ncurses dialogs, top, btop, k9s, lazygit, fzf …) draw their UI using cursor positioning, box-drawing characters, color attributes, and the alternate screen buffer. The plain text serialization that read_terminal returns is often INCOMPLETE or AMBIGUOUS for these programs:\n' +
        '  • Box-drawing characters look like garbage\n' +
        '  • Selected/highlighted rows are indistinguishable from normal rows (color is lost)\n' +
        '  • Status bars / mode indicators may be missing\n' +
        '  • Cursor position cannot be inferred\n' +
        '\n' +
        'WHEN TO CALL THIS TOOL:\n' +
        '  • The previous run_command returned [status: tui]\n' +
        '  • You need to know what is highlighted / selected / focused in a TUI menu\n' +
        '  • read_terminal returned text that does not match what the user is asking about\n' +
        '  • You launched a full-screen program (vim, less, htop, fzf …) and need to react to it\n' +
        '\n' +
        'HOW THE RESULT IS DELIVERED:\n' +
        'You will receive a multimodal tool result containing (a) a short text header noting size + capture method, and (b) the actual PNG bytes as an image part. Look at the image directly — do NOT ask the user to OCR it for you, do NOT try to decode it from text, and do NOT call run_command to "see" it. The text header is informational only; the visual content is in the image part.\n' +
        '\n' +
        'PREFER read_terminal when you only need plain text — it is much cheaper. Use read_screen specifically when visual rendering matters.',
      parameters: {
        type: 'object',
        properties: {
          pane: PANE_PARAM_SCHEMA,
        },
        required: [],
      },
    },
    // Read-only snapshot → safe for parallel execution.
    isConcurrencySafe: true,
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx): Promise<ToolOutputWithImages> {
      const paneResolved = resolvePaneTarget(ctx, args.pane);
      if (!paneResolved.ok) {
        return { text: `Error: ${paneResolved.error}`, images: [] };
      }
      const pane = paneResolved.pane;
      const panePrefix = paneHeaderFor(ctx, pane);
      const shot = await captureTerminalScreen(pane.sessionId);
      if (!shot) {
        return {
          text: `${panePrefix}[read_screen: failed to capture terminal — session not found or empty buffer]`,
          images: [],
        };
      }
      return {
        text: `${panePrefix}[read_screen: ${shot.width}x${shot.height} PNG, method=${shot.method}]`,
        images: [
          {
            mediaType: 'image/png',
            data: shot.data,
            label: `pane${pane.paneNumber}-${Date.now()}.png`,
          },
        ],
      };
    },
  };
}
