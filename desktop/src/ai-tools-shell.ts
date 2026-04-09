// ─── AI Tools Shell Integration & Command Executor ────────────
// Handles shell hook injection (OSC 7768), command execution via
// shell integration or OSC 7766 markers, output capture & cleanup.

import { TerminalRegistry } from './terminal';
// NOTE: The previous implementation used `invoke('inject_osc_marker')`
// to fake a completion marker after 1.5s of silence.  That hack caused
// false positives for interactive commands (ssh/sudo password prompts,
// vim/top TUIs) — the wait would resolve while the process was still
// blocking the PTY.  We now detect interactive state via prompt
// patterns and alt-screen flags instead.  See ai-tools-prompt-detect.ts.
import { loadSettings } from './themes';
import {
  escapeShellSingle,
  setShellType,
  stripAnsi,
  truncateOutput,
  TOKEN_BUDGET,
} from './ai-tools-core';
import {
  detectInteractiveState,
  describeState,
  endsWithShellPrompt,
  type InteractiveState,
  type PromptInfo,
} from './ai-tools-prompt-detect';

// ─── Per-session PTY lock ─────────────────────────────────────────
// The orchestrator parallelizes any tools whose handler is marked
// `isConcurrencySafe: true` (read_file, list_directory, glob_search,
// grep_search, …). That parallelism is fine when the work is local
// (the Rust commands are independent) but it would CORRUPT a shared
// PTY if two of those tools targeted the same SSH session — both
// would push commands into the same pty stream and the captured
// outputs would interleave.
//
// We solve this with a session-keyed promise queue: any caller that
// touches a session's PTY (sends input, observes output, captures
// command results) wraps its critical section in `withSessionPtyLock`,
// and the lock guarantees those critical sections execute serially
// PER SESSION while still allowing different sessions to run in
// parallel and allowing pure buffer reads (read_terminal, read_screen)
// to bypass entirely.
//
// The lock is intentionally cooperative — it only protects callers
// that opt in. The runLoop's orchestrator stays unchanged: tools are
// still grouped by `isConcurrencySafe`, and parallel batches still
// race on the JS event loop. The lock just ensures that when two
// "concurrency-safe" tools happen to land on the same session, the
// second one waits for the first to finish its PTY round-trip.

const sessionPtyTails = new Map<string, Promise<unknown>>();

/**
 * Serialize PTY interactions per session. Wrap any function that
 * sends input to or observes output from a specific session's PTY
 * in this helper. Calls on different sessions never block each
 * other; calls on the same session execute strictly in arrival
 * order.
 *
 * Errors from `fn` propagate to the caller normally — they do NOT
 * poison the queue, so a failed read_file does not block subsequent
 * tools on the same session.
 */
export function withSessionPtyLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = sessionPtyTails.get(sessionId) ?? Promise.resolve();
  // Chain regardless of prev outcome (success → fn, failure → fn).
  // The shared tail is .catch'd before being stored so unhandled
  // rejections from earlier critical sections don't bubble out of
  // the queue. Map size is bounded by the number of live sessions,
  // not the number of calls — each session keeps exactly one tail
  // entry that is overwritten on every new acquire.
  const next = prev.then(fn, fn);
  sessionPtyTails.set(sessionId, next.catch(() => undefined));
  return next;
}

// ─── Shell State Machine ──────────────────────────────────────────
// The prompt hook (__meterm_precmd) sends OSC 7768 with exit code + CWD
// before each prompt. This drives the state machine:
//   unknown → ready (first OSC 7768) → agent_executing → ready (next OSC 7768)

/**
 * Build the one-line precmd hook script for a given shell type.
 * Emits OSC 7768;EXIT_CODE;CWD;LAST_CMD before each prompt.
 */
function buildShellHook(shellType: string): string {
  switch (shellType) {
    case 'zsh':
      return [
        `__meterm_precmd(){ local e=$?;`,
        `local c;if [ -z "$__meterm_hook_ready" ];then export __meterm_hook_ready=1;c='';`,
        `else c=$(fc -ln -1 2>/dev/null);fi;`,
        `printf '\\033]7768;%d;%s;%s\\007' "$e" "$PWD" "$c"; };`,
        `autoload -Uz add-zsh-hook 2>/dev/null&&add-zsh-hook precmd __meterm_precmd`,
      ].join('');
    case 'fish':
      return [
        `function __meterm_postcmd --on-event fish_postexec;`,
        `if not set -q __meterm_hook_ready;set -gx __meterm_hook_ready 1;`,
        `printf '\\033]7768;%d;%s;\\007' $status "$PWD";`,
        `else;`,
        `printf '\\033]7768;%d;%s;%s\\007' $status "$PWD" "$argv";`,
        `end;`,
        `end`,
      ].join('');
    case 'powershell':
      return [
        `function prompt {`,
        `$e=$LASTEXITCODE;`,
        `if (-not $env:__meterm_hook_ready){$env:__meterm_hook_ready='1';$c=''}`,
        `else{$c=(Get-History -Count 1).CommandLine};`,
        `[Console]::Write("$([char]0x1b)]7768;$e;$(Get-Location);$c$([char]7)");`,
        `return "PS> "`,
        `}`,
      ].join('');
    default: // bash
      return [
        `__meterm_precmd(){ local e=$?;`,
        `local c;if [ -z "$__meterm_hook_ready" ];then export __meterm_hook_ready=1;c='';`,
        `else c=$(fc -ln -1 2>/dev/null);fi;`,
        `printf '\\033]7768;%d;%s;%s\\007' "$e" "$PWD" "$c"; };`,
        `PROMPT_COMMAND="__meterm_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"`,
      ].join('');
  }
}

// ─── Shell Hook Injection ───────────────────────────────────────

// Tracks sessions where injection has been attempted (success or failure).
// Ensures injection is tried at most ONCE per session — prevents repeated
// alt-screen switches that freeze the window on every AI message.
const _injectionAttempted = new Set<string>();

/**
 * Inject the shell prompt hook into the terminal session (SSH/remote fallback).
 *
 * For local shells, the Go sidecar pre-installs the hook via ZDOTDIR (zsh) or
 * --rcfile (bash), making this function a no-op (hookInjected is already true
 * from the first OSC 7768 received).
 *
 * For SSH/remote shells, uses the xterm.js **alternate screen buffer**:
 *   1. Switch to alt screen (main screen with MOTD/prompt is preserved)
 *   2. Send injection command (all echo goes to alt screen)
 *   3. Wait for completion
 *   4. Switch back to main screen (alt screen discarded)
 */
export function injectShellHook(sessionId: string): boolean {
  const mt = TerminalRegistry.get(sessionId);
  if (!mt || mt.shellState.hookInjected) return mt?.shellState.hookInjected ?? false;
  if (_injectionAttempted.has(sessionId)) return false; // already tried
  // Check settings — user can disable SSH hook injection
  if (!loadSettings().shellHookInjection) return false;
  _injectionAttempted.add(sessionId);
  return _injectShellHookImpl(sessionId, mt);
}

function _injectShellHookImpl(
  sessionId: string,
  mt: ReturnType<typeof TerminalRegistry.get> & {},
): boolean {
  const zshHook = buildShellHook('zsh');
  const bashHook = buildShellHook('bash');
  const fishHook = buildShellHook('fish');
  const detectId = `det_${Date.now().toString(36)}`;

  // Single-line polyglot: `test -n` guards ensure only the matching branch runs.
  // __meterm_hook_ready guard: skip if Go sidecar already installed the hook.
  const cmd = [
    ` test -n "$ZSH_VERSION" && test -z "$__meterm_hook_ready" &&`,
    `printf '\\033]7766;${detectId};1\\007' &&`,
    `eval '${escapeShellSingle(zshHook)}' &&`,
    `setopt HIST_IGNORE_SPACE 2>/dev/null;`,
    `test -n "$BASH_VERSION" && test -z "$__meterm_hook_ready" &&`,
    `printf '\\033]7766;${detectId};0\\007' &&`,
    `eval '${escapeShellSingle(bashHook)}' &&`,
    `history -d $HISTCMD 2>/dev/null;`,
    `export HISTCONTROL="\${HISTCONTROL:+\$HISTCONTROL:}ignorespace";`,
    `test -n "$FISH_VERSION" && test -z "$__meterm_hook_ready" &&`,
    `printf '\\033]7766;${detectId};2\\007' &&`,
    `eval '${escapeShellSingle(fishHook)}';`,
    `printf '\\0338\\033[0J\\033[0m\\r\\033[2K'`,
  ].join(' ');

  // Switch to alternate screen buffer BEFORE sending.
  mt.terminal.write('\x1b[?1049h');

  TerminalRegistry.sendInput(sessionId, '\x15' + cmd + '\n');

  const restoreScreen = () => {
    mt.terminal.write('\x1b[?1049l');
    mt.terminal.scrollToBottom();
  };

  const timeout = setTimeout(() => {
    unsub();
    restoreScreen();
  }, 3000);
  const unsub = TerminalRegistry.onOscMarker(sessionId, detectId, (code) => {
    clearTimeout(timeout);
    restoreScreen();
    if (code !== -1) {
      setShellType(sessionId, code === 1 ? 'zsh' : code === 2 ? 'fish' : 'bash');
      mt.shellState.hookInjected = true;
    }
  });

  return false; // hookInjected will be set asynchronously via callback
}

// ─── Command Execution Waiters ──────────────────────────────────
//
// These two waiters now share a single detection strategy:
//
//   1. Shell-hook idle (OSC 7768) — the BEST signal. Means the shell
//      is back at its prompt and the command truly finished. Resolves
//      as status='completed' with the real exit code + cwd.
//
//   2. Interactive-state detector — after ~1.5 seconds of silence
//      following actual output, we inspect the tail of the buffer
//      for password/confirm/TUI patterns (ai-tools-prompt-detect.ts).
//      If we find one, we RESOLVE EARLY with a specific status so the
//      LLM knows to use type_text / press_keys / watch_terminal. We do NOT fake
//      an exit code.
//
//   3. xterm.js alternate-screen buffer — checked alongside (2).
//      If the terminal switched to alt-screen, the foreground process
//      has taken over the display (vim/top/htop/less/etc). We resolve
//      as 'tui'.
//
//   4. Hard deadline — if none of the above fire within timeoutSec,
//      we resolve as 'timeout' (command may still be running).
//
// Critically, we NEVER fake an OSC 7766 marker via `inject_osc_marker`
// anymore. That hack caused run_command to lie about completion
// whenever a process blocked the PTY waiting for input.

/** Status of a terminal wait, reflecting WHY we stopped waiting. */
export type WaitStatus =
  | 'completed'          // shell hook fired — command truly finished
  | 'waiting_password'   // detector saw a password prompt
  | 'waiting_confirm'    // detector saw a Y/n prompt
  | 'waiting_input'      // detector saw a generic "xxx:" prompt tail
  | 'tui'                // xterm alt-screen flipped on
  | 'idle_no_signal'     // silent for a long time, no shell hook
  | 'timeout'            // hit the hard deadline
  | 'aborted';           // external abort signal

export interface WaitResult {
  output: string;
  exitCode: number;
  cwd: string;
  status: WaitStatus;
  /** Optional prompt line that triggered the detector (for LLM hints). */
  detectorLine?: string;
  /** Structured prompt info when a library-specific parser matched. */
  promptInfo?: PromptInfo;
}

/** Configuration for the hybrid wait loop. */
interface WaitOptions {
  /** Hard deadline in seconds. */
  timeoutSec: number;
  /** Silence threshold before the detector fires (ms). */
  detectAfterSilenceMs: number;
  /** Silence threshold before we give up with idle_no_signal (ms). */
  giveUpAfterSilenceMs: number;
}

/**
 * Read the current xterm buffer type. Returns true iff the terminal is
 * in alternate-screen mode (TUI program has taken over).
 */
function isAlternateScreen(sessionId: string): boolean {
  const mt = TerminalRegistry.get(sessionId);
  try {
    return mt?.terminal.buffer.active.type === 'alternate';
  } catch {
    return false;
  }
}

/**
 * Map a detector state → wait status (1:1 except 'active').
 */
function detectorToStatus(state: InteractiveState): WaitStatus | null {
  switch (state) {
    case 'waiting_password': return 'waiting_password';
    case 'waiting_confirm':  return 'waiting_confirm';
    case 'waiting_input':    return 'waiting_input';
    case 'tui':              return 'tui';
    case 'active':           return null;
  }
}

/**
 * Core wait loop — listens for output, shell-idle, and periodically
 * runs the interactive-state detector.  Used by BOTH the hook-enabled
 * path and the hookless fallback; the only difference is whether
 * onShellIdle will ever fire.
 */
function runWaitLoop(
  sessionId: string,
  options: WaitOptions,
  signal?: { aborted: boolean },
): Promise<WaitResult> {
  const { timeoutSec, detectAfterSilenceMs, giveUpAfterSilenceMs } = options;
  // Baseline alt-screen state captured BEFORE the command is sent.
  // This lets us distinguish "the command just entered a TUI" from
  // "we were already inside tmux/screen/vim from a previous command".
  // We only report status='tui' when the flag flips false → true.
  const baselineAltScreen = isAlternateScreen(sessionId);

  return new Promise((resolve) => {
    let outputBuffer = '';
    let resolved = false;
    let lastOutputTime = Date.now();
    let hadAnyOutput = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      unsubOutput();
      unsubIdle();
      clearTimeout(deadline);
      clearInterval(checkTimer);
    };

    const finish = (result: WaitResult) => {
      if (resolved) return;
      cleanup();
      resolve(result);
    };

    // ── Hard deadline ──
    const deadline = setTimeout(() => {
      const mt = TerminalRegistry.get(sessionId);
      finish({
        output: stripAnsi(outputBuffer)
          + `\n[Command timed out after ${timeoutSec}s — may still be running]`,
        exitCode: -1,
        cwd: mt?.shellState.cwd ?? '',
        status: 'timeout',
      });
    }, timeoutSec * 1000);

    // ── Periodic detector check ──
    // Runs every 300ms and checks, in order:
    //   (a) External abort signal was set — stop immediately even
    //       if no output has arrived (silent process case).
    //   (b) Did alt-screen flip on? → status='tui' (baseline-aware).
    //   (c) Been silent for detectAfterSilenceMs? → run the
    //       interactive-state detector on the buffer tail.
    //   (d) Been silent for giveUpAfterSilenceMs? → 'idle_no_signal'.
    const checkTimer = setInterval(() => {
      if (resolved) return;

      // (a) Abort check runs every tick so Ctrl+C works even when
      // the child process is dead silent (no output events arrive).
      if (signal?.aborted) {
        finish({
          output: stripAnsi(outputBuffer) + '\n[执行被用户中止]',
          exitCode: -1,
          cwd: '',
          status: 'aborted',
        });
        return;
      }

      const silentMs = Date.now() - lastOutputTime;

      // (a) alt-screen transition (only if we didn't already start
      // inside an alt-screen session like tmux — otherwise we'd
      // always trigger 'tui' and never listen to the real signals).
      if (!baselineAltScreen && isAlternateScreen(sessionId)) {
        const mt = TerminalRegistry.get(sessionId);
        finish({
          output: stripAnsi(outputBuffer),
          exitCode: 0,
          cwd: mt?.shellState.cwd ?? '',
          status: 'tui',
        });
        return;
      }

      // (b) Prompt detector only makes sense once we've actually seen
      // some output AND the stream has been silent for a beat — a
      // command that's still streaming output is clearly not waiting.
      if (hadAnyOutput && silentMs >= detectAfterSilenceMs) {
        const detect = detectInteractiveState(outputBuffer, false);
        // When we're already inside a tmux alt-screen we must NOT
        // report 'tui' from the detector (detectInteractiveState
        // also honors the altScreen flag, so pass false here to
        // skip that shortcut — we handled alt-screen above).
        const status = detectorToStatus(detect.state);
        if (status && status !== 'tui') {
          const mt = TerminalRegistry.get(sessionId);
          finish({
            output: stripAnsi(outputBuffer),
            exitCode: 0,
            cwd: mt?.shellState.cwd ?? '',
            status,
            detectorLine: detect.matchedLine,
            promptInfo: detect.promptInfo,
          });
          return;
        }

        // (b') Hookless shell prompt completion fallback:
        // When OSC 7768 isn't available, the buffer tail being a
        // shell prompt ("$ "/"# "/"% "/"> ") after silence is the
        // best "command finished" signal we have. We still prefer
        // the real hook when present, so this only fires if the
        // OSC 7768 path didn't beat us to it within the silence
        // window (the onShellIdle listener is still active).
        if (endsWithShellPrompt(outputBuffer)) {
          const mt = TerminalRegistry.get(sessionId);
          finish({
            output: stripAnsi(outputBuffer),
            // Exit code is unknown when we're relying on visual
            // detection — signal that clearly by returning -1 so the
            // LLM knows it can't trust a numeric exit.
            exitCode: mt?.shellState.lastExitCode ?? -1,
            cwd: mt?.shellState.cwd ?? '',
            status: 'completed',
          });
          return;
        }
      }

      // (c) Give-up path: silent for a long time AND still no shell
      // hook AND no detector match AND no prompt tail. Return what
      // we have so the caller can decide.
      if (hadAnyOutput && silentMs >= giveUpAfterSilenceMs) {
        const mt = TerminalRegistry.get(sessionId);
        finish({
          output: stripAnsi(outputBuffer)
            + `\n[No shell-idle signal for ${Math.round(silentMs/1000)}s; the process may still be running or waiting]`,
          exitCode: mt?.shellState.lastExitCode ?? -1,
          cwd: mt?.shellState.cwd ?? '',
          status: 'idle_no_signal',
        });
      }
    }, 300);

    // ── Output listener ──
    const unsubOutput = TerminalRegistry.onOutput(sessionId, (data) => {
      if (resolved) return;
      if (signal?.aborted) {
        finish({
          output: stripAnsi(outputBuffer) + '\n[执行被用户中止]',
          exitCode: -1,
          cwd: '',
          status: 'aborted',
        });
        return;
      }
      outputBuffer += data;
      hadAnyOutput = true;
      lastOutputTime = Date.now();
    });

    // ── Shell hook idle (OSC 7768) — authoritative "command done". ──
    const unsubIdle = TerminalRegistry.onShellIdle(sessionId, () => {
      const mt = TerminalRegistry.get(sessionId);
      finish({
        output: stripAnsi(outputBuffer),
        exitCode: mt?.shellState.lastExitCode ?? -1,
        cwd: mt?.shellState.cwd ?? '',
        status: 'completed',
      });
    });
  });
}

// ─── Execute Agent Command ──────────────────────────────────────

/**
 * Execute a command in the terminal and wait for it to complete, block,
 * or enter an interactive state.  Returns a structured result the
 * caller can surface to the LLM.
 *
 * Strategy differences vs. the old implementation:
 *
 *   • No more synthetic OSC 7766 marker injection. That caused
 *     run_command to return success while the process was still
 *     blocking on a password prompt.
 *
 *   • No more `; printf '...7766...'` suffix on the command. That
 *     never fires for interactive/TUI programs anyway and caused
 *     confusing echoes in the terminal.
 *
 *   • A single `runWaitLoop` handles both hook-enabled and hookless
 *     paths. The only difference is that without the shell hook,
 *     'completed' status will never fire — the loop resolves via
 *     detector / alt-screen / idle_no_signal / timeout instead.
 */
export async function executeAgentCommand(
  sessionId: string,
  cmd: string,
  shellType: string,
  timeoutSec: number,
  signal?: { aborted: boolean },
): Promise<{
  output: string;
  exitCode: number;
  cwd: string;
  status: WaitStatus;
  detectorLine?: string;
  promptInfo?: PromptInfo;
}> {
  // Acquire the per-session PTY lock so that any other tool currently
  // touching this session's PTY (run_command, type_text, press_keys,
  // watch_terminal, or any SSH-routed read_file / write_file /
  // list_directory / glob_search / grep_search) finishes before we
  // send our command. Without this, the orchestrator would happily
  // fan out 5 read_files / list_directories / grep_searches in
  // parallel on the same SSH session and the captured outputs would
  // interleave on the wire, corrupting all of them.
  return withSessionPtyLock(sessionId, async () => {
    const mt = TerminalRegistry.get(sessionId);
    const hookReady = !!mt?.shellState.hookInjected && shellType !== 'powershell';

    const waitOpts = hookReady
      ? { timeoutSec, detectAfterSilenceMs: 1_500, giveUpAfterSilenceMs: 30_000 }
      : { timeoutSec, detectAfterSilenceMs: 1_500, giveUpAfterSilenceMs: 5_000 };

    const resultPromise = runWaitLoop(sessionId, waitOpts, signal);
    TerminalRegistry.sendAgentCommand(sessionId, ` ${cmd}`, shellType);
    const result = await resultPromise;

    return {
      output: cleanOutput(result.output, cmd),
      exitCode: result.exitCode,
      cwd: result.cwd,
      status: result.status,
      detectorLine: result.detectorLine,
      promptInfo: result.promptInfo,
    };
  });
}

/**
 * Execute a command via terminal and capture output (used by read_file/write_file on SSH).
 * Returns only the text portion — interactive status is discarded,
 * which is fine because these helpers wrap simple, non-interactive
 * commands (head, cat > heredoc, etc.).
 */
export async function executeViaTerminal(
  sessionId: string,
  cmd: string,
  timeoutSec = 15,
  shellType = 'bash',
): Promise<string> {
  const { output } = await executeAgentCommand(sessionId, cmd, shellType, timeoutSec);
  return truncateOutput(output, TOKEN_BUDGET.perToolOutputChars);
}

/** Re-export for external consumers (run_command) that need the state label. */
export { describeState };

/**
 * Clean captured output: strip command echo line and trailing prompt lines.
 */
export function cleanOutput(raw: string, sentCommand?: string): string {
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
