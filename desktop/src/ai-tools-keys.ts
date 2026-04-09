// ─── AI Agent: Terminal Key Sequence Parser ───────────────
//
// Translates human-friendly key tokens into the exact byte sequences
// a real physical keyboard emits on a VT-style terminal. The bytes
// produced here are BYTE-FOR-BYTE the same data the kernel would see
// if the user typed them themselves — xterm.js's onData handler
// emits these exact same sequences for real keystrokes (cross-checked
// against terminal.ts:586).
//
// This module powers the press_keys() agent tool. The type_text()
// tool sends raw text directly without going through any parser.
//
// Supported syntaxes in a key text value:
//
//   1. Named key tokens enclosed in <...>:
//        <Enter>, <Return>, <CR>, <LF>
//        <Tab>, <ShiftTab> / <Shift-Tab>
//        <Esc> / <Escape>
//        <Space>
//        <Backspace> / <BS>
//        <Delete> / <Del>
//        <Insert> / <Ins>
//        <Up>, <Down>, <Left>, <Right>
//        <Home>, <End>, <PageUp> / <PgUp>, <PageDown> / <PgDn>
//        <F1>..<F12>
//      With modifier prefixes (combinable):
//        <Ctrl-C>, <C-c>, <Control-C>
//        <Alt-F>, <M-f>, <Meta-f>
//        <Shift-Tab>            (only for keys that have a shifted form)
//
//   2. Backslash escapes (when the LLM uses C-style strings):
//        \n  → CR (Enter — same as <Enter>)
//        \r  → CR
//        \t  → Tab
//        \b  → Backspace (0x7f, matches xterm.js default)
//        \e  → Esc
//        \0  → NUL
//        \xNN, \uNNNN → arbitrary byte / unicode codepoint
//        \\  → literal backslash
//
//   3. Plain characters pass through unchanged ("hello", "$PATH").
//
// Everything is sent in a single ws/IPC frame (TerminalRegistry.sendInput
// does one TextEncoder.encode + one PTY write), so multi-key sequences
// like "<Down><Down><Enter>" or ":wq<Enter>" arrive as a contiguous
// burst — exactly what a real keypress flurry looks like to the PTY.

const NAMED_KEY_BYTES: Record<string, string> = {
  // Line editing — Enter is CR (0x0D), matching real keyboard onData.
  // The PTY's line discipline turns CR into LF for cooked-mode shells;
  // raw-mode programs (vim, ssh password prompt, ncurses) need CR.
  'enter':      '\r',
  'return':     '\r',
  'cr':         '\r',
  'lf':         '\n',           // Pure LF for the rare protocol that needs it.
  'tab':        '\t',
  'shifttab':   '\x1b[Z',       // CSI Z — back-tab (vim, fzf, less, htop)
  'esc':        '\x1b',
  'escape':     '\x1b',
  'space':      ' ',
  'backspace':  '\x7f',         // DEL, matches xterm.js + macOS Terminal.
  'bs':         '\x7f',
  'delete':     '\x1b[3~',
  'del':        '\x1b[3~',
  'insert':     '\x1b[2~',
  'ins':        '\x1b[2~',
  // Arrows (CSI, not SS3 — matches xterm.js default cursor mode)
  'up':         '\x1b[A',
  'down':       '\x1b[B',
  'right':      '\x1b[C',
  'left':       '\x1b[D',
  // Navigation
  'home':       '\x1b[H',
  'end':        '\x1b[F',
  'pageup':     '\x1b[5~',
  'pgup':       '\x1b[5~',
  'pagedown':   '\x1b[6~',
  'pgdn':       '\x1b[6~',
  // Function keys (xterm SS3 for F1–F4, CSI for F5+)
  'f1':  '\x1bOP',
  'f2':  '\x1bOQ',
  'f3':  '\x1bOR',
  'f4':  '\x1bOS',
  'f5':  '\x1b[15~',
  'f6':  '\x1b[17~',
  'f7':  '\x1b[18~',
  'f8':  '\x1b[19~',
  'f9':  '\x1b[20~',
  'f10': '\x1b[21~',
  'f11': '\x1b[23~',
  'f12': '\x1b[24~',
};

/**
 * Resolve a single `<Name>` token to its byte string, or return
 * null if the name is unknown.
 *
 * Case-insensitive. Hyphens between segments are optional ("CtrlC"
 * == "Ctrl-C" == "ctrl-c" == "c-c"). Supports stacked modifiers:
 *   Ctrl|Control|C
 *   Alt|Meta|M|A
 *   Shift|S         (only for keys with a shifted form: Tab → ShiftTab)
 *
 * The order of modifiers does not matter — "Shift-Ctrl-A" is parsed
 * the same as "Ctrl-Shift-A".
 */
function resolveNamedKey(name: string): string | null {
  // Normalize: lowercase + collapse hyphens.
  const raw = name.trim().toLowerCase();

  // ── FAST PATH: try the literal name first ──
  // This avoids any modifier-stripping ambiguity for plain key names
  // like "enter", "space", "escape", "shifttab", "cr". Without this
  // step, a name like "space" would be misread as Shift + "pace"
  // because the modifier regex's single-letter `s` alternation eats
  // the leading character. Always check the table BEFORE we try to
  // peel off modifier prefixes.
  if (NAMED_KEY_BYTES[raw]) return NAMED_KEY_BYTES[raw];

  // Pull off modifier prefixes (one or more, in any order).
  //
  // Two acceptable forms for a modifier:
  //   • Full word (ctrl|control|alt|meta|shift) followed by an
  //     optional hyphen.
  //   • Single-letter abbreviation (c|m|a|s) followed by a REQUIRED
  //     hyphen — this prevents "space" from being misread as
  //     Shift + "pace" or "alt" being misread as Alt + "lt".
  let rest = raw;
  let isCtrl = false;
  let isAlt = false;
  let isShift = false;
  while (true) {
    const m = rest.match(
      /^(?:(ctrl|control|alt|meta|shift)-?|([cmas])-)(.+)$/,
    );
    if (!m) break;
    const mod = (m[1] || m[2])!;
    const tail = m[3]!;
    if (mod === 'ctrl' || mod === 'control' || mod === 'c') isCtrl = true;
    else if (mod === 'alt' || mod === 'meta' || mod === 'm' || mod === 'a') isAlt = true;
    else if (mod === 'shift' || mod === 's') isShift = true;
    else break;
    if (tail === rest) break; // no progress
    rest = tail;
    // Don't keep stripping once `rest` is itself a complete known
    // key (e.g. "shift-tab" → tail "tab" — don't try to peel a
    // second modifier off "tab" because "t" might match a future
    // single-letter modifier alias).
    if (NAMED_KEY_BYTES[rest]) break;
  }

  if (!isCtrl && !isAlt && !isShift) {
    // Plain named key.
    return NAMED_KEY_BYTES[rest] ?? null;
  }

  // ── Shift handling for keys that have a shifted form ──
  if (isShift && rest === 'tab') {
    // Shift-Tab is back-tab. Apply Alt/Ctrl on top if needed.
    let bytes = '\x1b[Z';
    if (isAlt) bytes = '\x1b' + bytes; // Alt prepends ESC
    return bytes;
  }

  // ── Ctrl handling ──
  if (isCtrl) {
    // Single letter: Ctrl-A..Ctrl-Z → 0x01..0x1A. Capitalization
    // doesn't matter (Ctrl-A and Ctrl-a are identical at the byte level).
    if (rest.length === 1 && rest >= 'a' && rest <= 'z') {
      let bytes = String.fromCharCode(rest.charCodeAt(0) - 96);
      if (isAlt) bytes = '\x1b' + bytes;
      return bytes;
    }
    // Special control codes that don't fit the A-Z mapping.
    const ctrlMap: Record<string, string> = {
      '[': '\x1b',
      '\\': '\x1c',
      ']': '\x1d',
      '^': '\x1e',
      '_': '\x1f',
      '?': '\x7f',
      ' ': '\x00',
      'space': '\x00',
    };
    if (rest in ctrlMap) {
      let bytes = ctrlMap[rest];
      if (isAlt) bytes = '\x1b' + bytes;
      return bytes;
    }
    // Ctrl + arrow / Ctrl + named key — xterm modify-other-keys
    // encoding: CSI <key>;5<terminator>. The "5" parameter is the
    // standard "Ctrl modifier" code from DECSET 1036.
    const ctrlNamed: Record<string, string> = {
      'left':  '\x1b[1;5D',
      'right': '\x1b[1;5C',
      'up':    '\x1b[1;5A',
      'down':  '\x1b[1;5B',
      'home':  '\x1b[1;5H',
      'end':   '\x1b[1;5F',
    };
    if (rest in ctrlNamed) {
      let bytes = ctrlNamed[rest];
      if (isAlt) bytes = '\x1b' + bytes;
      return bytes;
    }
    return null;
  }

  // ── Alt only (no Ctrl) ──
  if (isAlt) {
    // Alt + key = ESC + key (xterm default convention).
    // Recursively resolve the inner key (handles named keys too:
    // "Alt-Backspace" → ESC + 0x7f).
    const inner = NAMED_KEY_BYTES[rest] ?? (rest.length === 1 ? rest : null);
    if (inner !== null) return '\x1b' + inner;
    return null;
  }

  return null;
}

/** Escape-char translation table for backslash escapes. */
const BACKSLASH_ESCAPES: Record<string, string> = {
  'n':  '\r',  // "\n" → Enter (CR) to match real keyboard semantics
  'r':  '\r',
  't':  '\t',
  'b':  '\x7f', // Backspace
  'e':  '\x1b',
  '0':  '\x00',
  '\\': '\\',
};

/**
 * Parse a mixed text/key string into raw bytes that xterm.js / the
 * PTY accepts as a keyboard stream. Used internally for conversion
 * helpers; the public agent surface goes through resolveSingleKey()
 * (called by press_keys) and raw text passthrough (type_text).
 *
 * @param text Mixed string containing literal characters, `<Token>`
 *             named keys, and `\n / \xNN` C-style escapes.
 * @returns The decoded byte string, or { error } on malformed input.
 */
export function parseKeySequence(text: string): { bytes: string } | { error: string } {
  let out = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    // Backslash escape
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      if (next in BACKSLASH_ESCAPES) {
        out += BACKSLASH_ESCAPES[next];
        i += 2;
        continue;
      }
      if (next === 'x' && i + 3 < text.length) {
        const hex = text.slice(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          continue;
        }
      }
      if (next === 'u' && i + 5 < text.length) {
        const hex = text.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
      }
      // Unknown escape — pass through literally
      out += ch;
      i += 1;
      continue;
    }

    // Named key token <Name>
    //
    // We try to parse `<...>` as a key token, but only when it
    // looks like one (single short identifier, no whitespace, with
    // optional modifier prefixes). Anything else — `<filename>`,
    // `<a href="...">`, `<3` (less-than three) — is left as
    // literal characters so we don't accidentally swallow user
    // text the LLM is trying to send through.
    if (ch === '<') {
      const close = text.indexOf('>', i + 1);
      if (close > i + 1 && close - i <= 30) {
        const name = text.slice(i + 1, close);
        // Token shape: starts with a letter, only [A-Za-z0-9-] inside.
        if (/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) {
          const resolved = resolveNamedKey(name);
          if (resolved !== null) {
            out += resolved;
            i = close + 1;
            continue;
          }
          // Looked like a key token but isn't one we recognize.
          // Instead of erroring out (which would force the LLM to
          // retry the whole call), pass it through literally so the
          // user at least sees what was attempted, and append a
          // hint. The hint is consumed by the caller as part of
          // the result text.
          //
          // (If the LLM really meant a key, it'll see the literal
          // `<Foo>` echo on screen and retry with a known token.)
          out += text.slice(i, close + 1);
          i = close + 1;
          continue;
        }
      }
    }

    // Regular character
    out += ch;
    i += 1;
  }

  return { bytes: out };
}

/** Raw ASCII bytes that look like a plain newline. */
export const CR = '\r';

/**
 * Resolve a single key token (without surrounding `<` `>`) into the
 * byte string a real keyboard would emit. Returns null if the token
 * is unknown.
 *
 * Used by press_keys() to validate caller-supplied key lists.
 * Accepts the same syntax as parseKeySequence's `<...>` tokens, e.g.
 * "Enter", "Tab", "Ctrl-C", "Alt-F", "Shift-Tab", "Ctrl-Left", "F5".
 */
export function resolveSingleKey(token: string): string | null {
  return resolveNamedKey(token);
}
