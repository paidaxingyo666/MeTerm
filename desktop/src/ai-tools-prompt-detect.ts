// ─── AI Agent: Interactive Prompt Detector ─────────────────
// When run_command's subject is a process that blocks the PTY
// (interactive password prompt, Y/n confirmation, TUI editor…),
// the shell integration OSC 7768 "idle" signal will NEVER fire
// because the shell is still in the middle of the foreground job.
//
// This module classifies the current terminal state so the
// wait loop in ai-tools-shell.ts can break out with the right
// reason instead of hanging or faking an exit code.
//
// Classifications:
//   • 'active'           — still streaming output, keep waiting
//   • 'waiting_password' — last lines look like a password prompt
//   • 'waiting_confirm'  — last lines look like a Y/n / yes-no prompt
//   • 'waiting_input'    — generic "prompt-ish" tail (colon/arrow)
//   • 'tui'              — terminal is in alternate-screen mode
//
// The detector is intentionally conservative: false positives here
// cause run_command to return early with a hint to use type_text/press_keys,
// which is recoverable.  False negatives leave the caller blocked
// until its deadline, which is merely slow.

import { stripAnsi } from './ai-tools-core';

export type InteractiveState =
  | 'active'
  | 'waiting_password'
  | 'waiting_confirm'
  | 'waiting_input'
  | 'tui';

/**
 * Structured view of a recognized prompt. When populated the agent
 * can act directly without re-parsing the screen — it knows the
 * question, the options, and the currently-highlighted choice.
 *
 * Populated best-effort by library-specific parsers (inquirer.js,
 * @clack/prompts, enquirer, numeric menus, bare `[Y/n]`). When no
 * parser matches this field is omitted and the agent falls back to
 * read_screen / read_terminal.
 */
export interface PromptInfo {
  kind: 'free_text' | 'confirm' | 'select' | 'press_any_key';
  /** Cleaned question text, if extractable. */
  question?: string;
  /** Default value for a free-text prompt (e.g. "(my-app)"). */
  defaultValue?: string;
  /** [Y/n] → true, [y/N] → false, [y/n] → undefined. */
  defaultYes?: boolean;
  /** List of option labels for select prompts. */
  options?: string[];
  /** Index of the currently-highlighted option. */
  cursorIndex?: number;
  /** Which library fingerprint matched (for debugging). */
  source?: string;
}

export interface DetectResult {
  state: InteractiveState;
  /** Line that matched the heuristic (for logging / LLM hints). */
  matchedLine?: string;
  /** Structured prompt info, when a library-specific parser matched. */
  promptInfo?: PromptInfo;
}

// ─── Regex set ────────────────────────────────────────────
// These are tuned against real-world output.  All match only the
// TAIL of the buffer (last ~3 non-empty lines) so old history doesn't
// trigger false positives.

const PASSWORD_PATTERNS: RegExp[] = [
  // openssh, sudo, mysql, postgres etc.
  /(?:^|\s)(?:password|passphrase|密码)\s*[:：][^\n]*$/i,
  // common prompt variants
  /^\s*Enter\s+passphrase\s+for\s+/i,
  /^\s*\[sudo\]\s+password\s+for\s+/i,
  /^\s*Password\s+for\s+/i,
  /\bUnlock\b.*[:：]\s*$/i,
];

const CONFIRM_PATTERNS: RegExp[] = [
  /\[y(?:es)?\/n(?:o)?\]\s*[?？:：]?\s*$/i,
  /\(y(?:es)?\/n(?:o)?\)\s*[?？:：]?\s*$/i,
  /\(yes\/no(?:\/\[fingerprint\])?\)[^\n]*$/i,
  /\bare you sure\b[^\n]*[?？]?\s*$/i,
  /\bcontinue\s*[?？]\s*$/i,
  /\bproceed\s*[?？]\s*$/i,
  /\boverwrite\b[^\n]*[?？]\s*$/i,
  /\bretry\s*[?？]/i,
  /\[Y(?:es)?\/n(?:o)?\/a(?:ll)?\/[^\]]*\]/,
];

// A generic tail that looks like "some text: " where the cursor is
// clearly waiting for input. Very loose — only applied when other
// heuristics didn't match and the terminal has been silent.
const INPUT_TAIL_PATTERN = /(?:^|\s)([A-Za-z][^:：\n]{0,40})\s*[:：]\s*$/;

// Shell PS1 prompt endings. This pattern is conservative on purpose
// — "$ " / "# " / "% " / "> " / "» " are the canonical bash/zsh/fish
// prompts that mean "the shell is idle, waiting for a command".
// We intentionally do NOT include bare ">" (python REPL) or similar
// because we only want to match real shell prompts.
const SHELL_PROMPT_TAIL = /[$#%>»]\s*$/;

/**
 * Does the tail of the buffer look like the shell is back at its
 * PS1 prompt? Used by runWaitLoop as a LAST-RESORT completion signal
 * when OSC 7768 shell integration isn't available (e.g. SSH into a
 * host where the hook couldn't be injected).
 *
 * Only the final non-empty line is considered, and it must look like
 * a typical shell prompt without any of the "waiting for input"
 * keywords (password/passphrase/yes or no).
 */
export function endsWithShellPrompt(outputBuffer: string): boolean {
  const plain = stripAnsi(outputBuffer).replace(/\r/g, '');
  const lines = plain.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return false;
  const last = lines[lines.length - 1];
  if (!SHELL_PROMPT_TAIL.test(last)) return false;
  // Reject if the same line carries a prompt-like keyword — a real
  // shell prompt would not say "password: $".
  if (/password|passphrase|密码|yes\/no|y\/n/i.test(last)) return false;
  return true;
}

// ─── Structured prompt parsers ─────────────────────────────
//
// Each parser tries to recognize a specific interactive-prompt library
// by its visible fingerprint and return a populated PromptInfo. All
// parsers take the list of stripped, non-empty trailing lines and
// return null when the fingerprint doesn't match.
//
// Intentional design choices:
//   • Parsers work on the ANSI-stripped text because every library
//     we care about uses unicode glyphs (❯ ◆ ● ○) as indicators,
//     which survive stripping.
//   • Parsers never mutate their input.
//   • When multiple parsers could match, the MORE SPECIFIC one runs
//     first (clack > inquirer > enquirer > numeric menu > y/n variants
//     > free-text default > press any key).

/** Scan the tail of the buffer for `❯` cursor marker (inquirer / enquirer). */
function parseInquirerSelect(lines: string[]): PromptInfo | null {
  const CURSOR = '❯';
  // Find the LAST cursor line within the tail window.
  let cursorLineIdx = -1;
  const start = Math.max(0, lines.length - 25);
  for (let i = lines.length - 1; i >= start; i--) {
    if (lines[i].trimStart().startsWith(CURSOR)) {
      cursorLineIdx = i;
      break;
    }
  }
  if (cursorLineIdx < 0) return null;

  // Walk up to find the start of the contiguous option block — lines
  // that begin with >=2 spaces (continuation of the choice list) and
  // aren't themselves the question line.
  let firstOptIdx = cursorLineIdx;
  for (let i = cursorLineIdx - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim().startsWith('?')) break;
    if (/^\s{2,}\S/.test(line) || line.trimStart().startsWith(CURSOR)) {
      firstOptIdx = i;
    } else {
      break;
    }
  }
  // And walk down to include options after the cursor.
  let lastOptIdx = cursorLineIdx;
  for (let i = cursorLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s{2,}\S/.test(line) || line.trimStart().startsWith(CURSOR)) {
      lastOptIdx = i;
    } else {
      break;
    }
  }

  const options: string[] = [];
  let cursorIndex = -1;
  for (let i = firstOptIdx; i <= lastOptIdx; i++) {
    const raw = lines[i];
    const isCursor = raw.trimStart().startsWith(CURSOR);
    if (isCursor) cursorIndex = options.length;
    // Strip leading whitespace, the cursor glyph, and any bullet
    // markers used by enquirer's layered display (❯ ● Vanilla).
    const cleaned = raw
      .trim()
      .replace(/^❯\s*/, '')
      .replace(/^[●○◉◯☑☐]\s*/, '')
      .trim();
    if (cleaned) options.push(cleaned);
  }
  if (options.length === 0 || cursorIndex < 0) return null;

  // Question line: the nearest `?`-prefixed line above the options.
  let question: string | undefined;
  for (let i = firstOptIdx - 1; i >= Math.max(0, firstOptIdx - 5); i--) {
    const t = lines[i].trim();
    if (t.startsWith('?')) {
      question = t.replace(/^\?\s*/, '').replace(/[:?：？]\s*$/, '').trim();
      break;
    }
  }

  return {
    kind: 'select',
    question,
    options,
    cursorIndex,
    source: 'inquirer',
  };
}

/** @clack/prompts — vertical `│` bar layout with `◆` question and `●/○`. */
function parseClackPrompt(lines: string[]): PromptInfo | null {
  let questionLineIdx = -1;
  let question: string | undefined;
  const start = Math.max(0, lines.length - 20);
  for (let i = lines.length - 1; i >= start; i--) {
    const t = lines[i].trimStart();
    if (t.startsWith('◆') || t.startsWith('◇') || t.startsWith('▲')) {
      question = t.replace(/^[◆◇▲]\s*/, '').trim();
      questionLineIdx = i;
      break;
    }
  }
  if (questionLineIdx < 0) return null;

  const options: string[] = [];
  let cursorIndex = -1;
  for (let i = questionLineIdx + 1; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (!t.startsWith('│')) break;
    const afterBar = t.slice(1).trimStart();
    if (afterBar.length === 0) continue;
    const filled = /^[●◉]/.test(afterBar);
    const empty = /^[○◯]/.test(afterBar);
    if (!filled && !empty) continue;
    if (filled) cursorIndex = options.length;
    const name = afterBar.replace(/^[●◉○◯]\s*/, '').trim();
    if (name) options.push(name);
  }
  if (options.length === 0) return null;

  return {
    kind: 'select',
    question,
    options,
    cursorIndex: cursorIndex < 0 ? 0 : cursorIndex,
    source: 'clack',
  };
}

/** Classic numeric menu: `1) Foo  2) Bar` followed by a `choice [N]:` tail. */
function parseNumericMenu(lines: string[]): PromptInfo | null {
  const last = lines[lines.length - 1];
  // Match a variety of trailing choice prompts. The (\d+) capture
  // inside square brackets is an optional default choice.
  const trailRe = /(?:choice|选择|pick|enter\s+(?:a\s+)?number|#\?|selection)\s*(?:\[(\d+)\])?\s*[:：]?\s*$/i;
  const m = last.match(trailRe);
  const bareHash = /^\s*#\?\s*$/.test(last);
  if (!m && !bareHash) return null;

  const options: string[] = [];
  for (let i = lines.length - 2; i >= Math.max(0, lines.length - 40); i--) {
    const om = lines[i].match(/^\s*(\d+)[)\.]\s*(.+)$/);
    if (om) {
      const num = parseInt(om[1], 10);
      if (num > 0 && num < 100) options[num - 1] = om[2].trim();
    } else if (options.length > 0) {
      break;
    }
  }
  const clean = options.filter(Boolean);
  if (clean.length < 2) return null;
  const defaultIdx = m && m[1] ? Math.max(0, parseInt(m[1], 10) - 1) : 0;

  return {
    kind: 'select',
    question: 'Numeric choice menu',
    options: clean,
    cursorIndex: Math.min(defaultIdx, clean.length - 1),
    source: 'numeric-menu',
  };
}

/** `[Y/n]` / `[y/N]` / `(Y/n)` / `(y/n)` confirmation with optional default. */
function parseConfirmWithDefault(lines: string[]): PromptInfo | null {
  const last = lines[lines.length - 1];
  const stripQ = (s: string) =>
    s.replace(/\s*[\(\[]y(?:es)?\/n(?:o)?[\)\]][^]*$/i, '')
     .replace(/[?？:：]\s*$/, '')
     .trim();

  if (/\[Y\/n\]/.test(last)) {
    return {
      kind: 'confirm',
      question: stripQ(last),
      defaultYes: true,
      source: 'y-n-default',
    };
  }
  if (/\[y\/N\]/.test(last)) {
    return {
      kind: 'confirm',
      question: stripQ(last),
      defaultYes: false,
      source: 'y-n-default',
    };
  }
  if (/[\(\[]y(?:es)?\/n(?:o)?[\)\]]/i.test(last)) {
    return {
      kind: 'confirm',
      question: stripQ(last),
      source: 'y-n-plain',
    };
  }
  return null;
}

/** `Name: (default)` or `Name [default]:` free-text with default value. */
function parseFreeTextWithDefault(lines: string[]): PromptInfo | null {
  const last = lines[lines.length - 1];
  // inquirer form: "? Project name: (my-app) "
  const m1 = last.match(/^\?\s*([^:?]{1,80})[:?？：]\s*\(([^)]{1,80})\)\s*$/);
  if (m1) {
    return {
      kind: 'free_text',
      question: m1[1].trim(),
      defaultValue: m1[2].trim(),
      source: 'free-text-paren-default',
    };
  }
  // classic: "Enter name [my-app]: "
  const m2 = last.match(/^([A-Za-z][^\[:]{0,60})\s*\[([^\]]{1,80})\]\s*[:：]\s*$/);
  if (m2) {
    return {
      kind: 'free_text',
      question: m2[1].trim(),
      defaultValue: m2[2].trim(),
      source: 'free-text-bracket-default',
    };
  }
  return null;
}

/** "Press any key to continue" sentinel. */
function parsePressAnyKey(lines: string[]): PromptInfo | null {
  const last = lines[lines.length - 1];
  if (/press\s+(?:any\s+key|enter|return|space)\s+to\s+(?:continue|proceed|exit)/i.test(last)) {
    return { kind: 'press_any_key', source: 'press-any-key' };
  }
  return null;
}

/**
 * Try every parser in order of specificity. The first match wins.
 * Returns null when the tail doesn't look like any known prompt —
 * in that case the caller falls back to generic text-tail matching
 * or read_screen.
 */
function extractPromptInfo(lines: string[]): PromptInfo | null {
  return (
    parseClackPrompt(lines)
    || parseInquirerSelect(lines)
    || parseNumericMenu(lines)
    || parseConfirmWithDefault(lines)
    || parseFreeTextWithDefault(lines)
    || parsePressAnyKey(lines)
  );
}

// ─── Public API ───────────────────────────────────────────

/**
 * Classify the current terminal state based on the most recent
 * output buffer plus a hint about the xterm.js alternate-screen flag.
 *
 * @param outputBuffer   Raw output (with ANSI) seen since command start.
 * @param altScreenActive Whether the xterm buffer is in alternate mode.
 */
export function detectInteractiveState(
  outputBuffer: string,
  altScreenActive: boolean,
): DetectResult {
  // TUI always wins — once the buffer switches to alt-screen we
  // know the foreground process has taken over the whole display.
  if (altScreenActive) return { state: 'tui' };

  const plain = stripAnsi(outputBuffer).replace(/\r/g, '');
  // Take the last ~3 non-empty lines: prompts usually live right
  // next to the cursor.  We join them to cope with 2-line prompts
  // like "Enter passphrase for key\n'.../id_rsa': ".
  const lines = plain.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 0) return { state: 'active' };
  const tail = lines.slice(-3).join('\n');
  const lastLine = lines[lines.length - 1];

  // Run the structured-prompt parsers ONCE and reuse the result.
  // We do this before the generic heuristics so an inquirer `❯`
  // marker can upgrade an otherwise-'active' classification.
  const promptInfo = extractPromptInfo(lines) ?? undefined;

  // If the tail ends on a normal shell prompt, we are IDLE not
  // waiting — return active so the caller keeps listening for
  // the shell's OSC 7768 idle marker.
  if (SHELL_PROMPT_TAIL.test(lastLine) && !/password|passphrase/i.test(tail)) {
    return { state: 'active' };
  }

  for (const re of PASSWORD_PATTERNS) {
    if (re.test(tail) || re.test(lastLine)) {
      return { state: 'waiting_password', matchedLine: lastLine };
    }
  }

  // Structured confirm wins over the regex-based confirm patterns
  // because it also carries the defaultYes flag.
  if (promptInfo?.kind === 'confirm') {
    return { state: 'waiting_confirm', matchedLine: lastLine, promptInfo };
  }

  for (const re of CONFIRM_PATTERNS) {
    if (re.test(tail) || re.test(lastLine)) {
      return { state: 'waiting_confirm', matchedLine: lastLine, promptInfo };
    }
  }

  // Structured select / free_text / press_any_key always imply a
  // waiting_input state even if the generic tail regex doesn't match.
  if (promptInfo) {
    return { state: 'waiting_input', matchedLine: lastLine, promptInfo };
  }

  // Loose "xxx:" / "xxx>" tail — only trust it when the last line
  // is short (real prompts are typically < 80 chars on one line) and
  // doesn't look like a URL / code.
  if (
    lastLine.length < 120 &&
    INPUT_TAIL_PATTERN.test(lastLine) &&
    !/https?:/.test(lastLine)
  ) {
    return { state: 'waiting_input', matchedLine: lastLine };
  }

  return { state: 'active' };
}

/**
 * Short human-readable label for a detector state, used in
 * the result string returned to the LLM.
 */
export function describeState(state: InteractiveState): string {
  switch (state) {
    case 'waiting_password': return 'waiting for password';
    case 'waiting_confirm':  return 'waiting for confirmation (Y/n)';
    case 'waiting_input':    return 'waiting for input';
    case 'tui':              return 'running a full-screen TUI';
    case 'active':           return 'actively producing output';
  }
}
