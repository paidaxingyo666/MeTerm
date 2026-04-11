// ─── AI Agent: Terminal Context & System Prompt ────────────────
// Helpers to gather the current terminal context (output, CWD, SSH
// info) and build the agent's system prompt from it.
//
// Phase 2: the context is *tab-scoped*. It now describes EVERY pane
// in the tab the agent belongs to, with topology data that the
// system prompt surfaces as a numbered pane list, plus a one-shot
// list of closure notices for panes that were closed since the last
// iteration. The agent picks a target pane via the `pane` parameter
// on terminal tools; omit it to use the "default target" (the pane
// locked in when the user hit Send).

import { TerminalRegistry } from './terminal';
import { DrawerManager } from './drawer';
import { stripAnsi } from './ai-tools-core';
import { getLanguage } from './i18n';
import { TabManager, type Tab } from './tabs';
import { getAllLeaves } from './split-pane';

// ─── Terminal Context ───────────────────────────────────────────

/** Per-pane snapshot embedded in TerminalContext. */
export interface PaneSnapshot {
  /** 1-based number shown to the user and the agent. */
  paneNumber: number;
  sessionId: string;
  isSSH: boolean;
  serverInfo: string;
  cwd: string;
  /** Last ~N lines of terminal output for this pane, ANSI-stripped. */
  recentOutput: string;
  /** True when this pane is the DEFAULT target for the current run. */
  isTarget: boolean;
  /** True when this pane is the pane the user currently has focused. */
  isFocused: boolean;
}

export interface TerminalContext {
  // ── Legacy single-pane fields (kept for empty-state / compat) ──
  recentOutput: string;
  serverInfo: string;
  isSSH: boolean;
  cwd: string;
  // ── Phase 2: tab topology ──
  /** All active panes of the tab that owns the invoking session. */
  panes: PaneSnapshot[];
  /** pane_number of the run's locked target, or null when no run is
   *  active (in which case the focused pane is the effective default). */
  targetPaneNumber: number | null;
  /** pane_number of whichever pane currently has user focus. */
  focusedPaneNumber: number;
  /** One-shot "Pane N was closed" notices queued by TabManager. */
  closureNotices: number[];
}

/**
 * Read the last N non-empty lines of a session's terminal buffer.
 * Returns '' when the session is not registered.
 */
function recentOutputFor(sessionId: string, maxLines: number): string {
  const raw = TerminalRegistry.serializeBuffer(sessionId);
  if (!raw) return '';
  const stripped = stripAnsi(raw);
  const lines = stripped.split('\n');
  const recent = lines.slice(-maxLines);
  return recent.join('\n').trim();
}

/** Build a PaneSnapshot for one leaf of a tab's split tree. */
function snapshotPane(
  tab: Tab,
  paneId: string,
  sessionId: string,
  maxLines: number,
  targetPaneNumber: number | null,
): PaneSnapshot {
  const paneNumber = tab.paneNumbers.get(paneId) ?? 0;
  const info = DrawerManager.getServerInfo(sessionId);
  const isSSH = !!info;
  const serverInfo = info ? `${info.username}@${info.host}:${info.port}` : '';
  const mt = TerminalRegistry.get(sessionId);
  const cwd = mt?.shellState.cwd ?? '';
  return {
    paneNumber,
    sessionId,
    isSSH,
    serverInfo,
    cwd,
    recentOutput: recentOutputFor(sessionId, maxLines),
    isTarget: targetPaneNumber !== null && paneNumber === targetPaneNumber,
    isFocused: paneId === tab.focusedPaneId,
  };
}

/**
 * Gather the full tab-scoped context for a session. When `targetPaneNumber`
 * is null we treat the focused pane as the default target.
 *
 * `flushClosures` receives the notices we just consumed so the caller
 * (agent loop) can pass them into the system prompt and then the
 * state can be cleared — ensuring each closure is surfaced exactly
 * once. Pass a no-op to inspect without consuming.
 */
export function gatherContext(
  sessionId: string,
  maxLines: number,
  opts?: {
    targetPaneNumber?: number | null;
    closureNotices?: number[];
  },
): TerminalContext {
  const located = TabManager.locateSession(sessionId);
  const targetPaneNumber = opts?.targetPaneNumber ?? null;
  const closureNotices = opts?.closureNotices ?? [];

  // Fallback path: the session isn't in any tab (shouldn't happen
  // in normal flow). Build a degenerate single-pane context so
  // callers don't crash.
  if (!located) {
    const info = DrawerManager.getServerInfo(sessionId);
    const isSSH = !!info;
    const serverInfo = info ? `${info.username}@${info.host}:${info.port}` : '';
    const mt = TerminalRegistry.get(sessionId);
    const cwd = mt?.shellState.cwd ?? '';
    const recent = recentOutputFor(sessionId, maxLines);
    const singlePane: PaneSnapshot = {
      paneNumber: 1,
      sessionId,
      isSSH,
      serverInfo,
      cwd,
      recentOutput: recent,
      isTarget: true,
      isFocused: true,
    };
    return {
      recentOutput: recent,
      serverInfo,
      isSSH,
      cwd,
      panes: [singlePane],
      targetPaneNumber: 1,
      focusedPaneNumber: 1,
      closureNotices,
    };
  }

  const { tab } = located;
  const leaves = getAllLeaves(tab.splitRoot);
  const panes = leaves.map((leaf) =>
    snapshotPane(tab, leaf.id, leaf.sessionId, maxLines, targetPaneNumber),
  );
  // Sort by paneNumber so the agent always sees them in stable
  // ascending order regardless of the binary tree's traversal.
  panes.sort((a, b) => a.paneNumber - b.paneNumber);

  const focusedPaneNumber = tab.paneNumbers.get(tab.focusedPaneId) ?? panes[0]?.paneNumber ?? 1;
  const effectiveTarget = targetPaneNumber ?? focusedPaneNumber;

  // The panes list was built with targetPaneNumber possibly null — if
  // the caller relied on the "focused = target" fallback, patch the
  // isTarget flag to match.
  if (targetPaneNumber === null) {
    for (const p of panes) p.isTarget = p.paneNumber === focusedPaneNumber;
  }

  // The invoking session's own pane drives the legacy single-pane
  // fields (empty-state / compat). If it can't be found in the list
  // (edge case), fall back to the first pane.
  const ownPane = panes.find((p) => p.sessionId === sessionId) ?? panes[0];

  return {
    recentOutput: ownPane.recentOutput,
    serverInfo: ownPane.serverInfo,
    isSSH: ownPane.isSSH,
    cwd: ownPane.cwd,
    panes,
    targetPaneNumber: effectiveTarget,
    focusedPaneNumber,
    closureNotices,
  };
}

// ─── System Prompt Builder ──────────────────────────────────────

/** Render a pane number as a circled digit (①-⑳) or `Pane N` fallback. */
export function paneNumberLabel(n: number): string {
  // ①..⑳ live at U+2460..U+2473.
  if (n >= 1 && n <= 20) return String.fromCodePoint(0x245F + n);
  return `Pane ${n}`;
}

/** Render an "isSSH @ cwd" one-liner for a PaneSnapshot. */
function renderPaneEnv(p: PaneSnapshot): string {
  const where = p.isSSH ? `SSH ${p.serverInfo || ''}`.trim() : 'Local';
  const loc = p.cwd ? `${where}: ${p.cwd}` : where;
  return loc;
}

/** Build the pane-topology section that replaces the old single-pane
 *  "Environment" block. Includes per-pane recent output + closure
 *  notices. */
function renderTopologySection(ctx: TerminalContext): string {
  const lines: string[] = [];
  lines.push(`This tab contains ${ctx.panes.length} active pane(s).`);
  lines.push('Pane topology (you can operate on any of them):');
  for (const p of ctx.panes) {
    const tags: string[] = [];
    if (p.isTarget) tags.push('DEFAULT TARGET');
    if (p.isFocused && !p.isTarget) tags.push('user focus');
    const tag = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
    lines.push(`  • ${paneNumberLabel(p.paneNumber)} (pane: ${p.paneNumber})${tag} — ${renderPaneEnv(p)}`);
    if (p.recentOutput) {
      const excerpt = p.recentOutput
        .split('\n')
        .slice(-3)
        .join('\n')
        .slice(0, 250);
      if (excerpt.trim()) {
        lines.push('    recent output (tail):');
        for (const line of excerpt.split('\n')) lines.push(`      ${line}`);
      }
    }
  }

  if (ctx.closureNotices.length > 0) {
    lines.push('');
    lines.push('System notice — panes closed since the last iteration (shown ONCE; do not reference these panes again):');
    for (const n of ctx.closureNotices) {
      lines.push(`  • ${paneNumberLabel(n)} (pane: ${n}) was closed.`);
    }
  }

  return lines.join('\n');
}

export function buildSystemPrompt(
  ctx: TerminalContext,
  hasTools: boolean,
  opts?: { todoBlock?: string; attachmentsBlock?: string },
): string {
  const lang = getLanguage();
  const langInstr = lang === 'zh'
    ? '请使用中文回复用户。'
    : 'Reply in the same language the user uses.';

  const topology = renderTopologySection(ctx);

  // Phase 3: persistent task plan injected by ToolAgent. When the
  // todo list has at least one item we render it as its own block so
  // the model can re-read its plan every iteration without spending
  // a tool call.
  const todoBlock = opts?.todoBlock ?? '';
  // Phase 3: user-attached files for the current turn. Also rendered
  // as its own block so the model sees explicit local paths it can
  // feed into upload_file / read_file / run_command.
  const attachmentsBlock = opts?.attachmentsBlock ?? '';

  const toolInstructions = hasTools
    ? `Instructions:
1. MINIMIZE TOOL CALLS. Before calling any tool, check if the answer is already visible in the terminal context above. If it is, answer directly — do not re-run commands to get information you already have.
2. run_command already returns the command output. Avoid unnecessary read_terminal calls — use read_terminal only when you need to check terminal state before acting or read output from user-initiated commands. For full-screen TUI programs (vim, htop, less, tmux, ncurses dialogs) where the text buffer is ambiguous, use read_screen to capture a PNG of what's actually displayed.
   • TUI INSPECTION RULE — when the terminal is in a TUI (alternate screen — vim, less, htop, top, btop, k9s, lazygit, fzf, mc, nano, man, tig, ncurses dialogs, …), you MUST use read_screen to inspect it. NEVER use watch_terminal or read_terminal for TUI inspection — those return the raw byte stream, which for TUIs is mostly cursor-positioning escape sequences and does NOT match what the user actually sees on screen. watch_terminal is for non-TUI processes that stream text.
   • TUI LIFECYCLE RULE — every type_text / press_keys / run_command result ends with a \`[Terminal: ...]\` line that authoritatively reports the current TUI state ("TUI active", "TUI just exited", "TUI just started", "shell prompt"). TRUST THIS LINE. After sending an exit key (q, :q+Enter, Ctrl-C), if the line says "TUI just exited", STOP — you are back at the shell. Do NOT keep firing more exit keys just because the program printed something on its way out.
3. COMMAND STYLE — prefer non-interactive invocations when you choose commands. You work step-by-step with explicit state; interactive modes hide state from you and waste turns.
   • PREFER FLAGS OVER PROMPTS (soft preference): when a CLI offers both, put everything on the command line instead of letting it ask.
     - gh repo create NAME --public --description "..."       (not: bare \`gh repo create\`, which opens a wizard)
     - git commit -m "msg"                                    (not: bare \`git commit\`, which opens $EDITOR)
     - npm create vite@latest app -- --template react-ts      (not: the interactive framework/variant menu)
     - terraform apply -auto-approve  /  -var-file=…          (not: the confirmation prompt)
     - psql -c "SELECT…"  /  sqlite3 db "SELECT…"             (not: dropping into the REPL)
     - kubectl apply -f  /  kubectl patch                     (not: \`kubectl edit\`, which opens $EDITOR)
     Override: if the USER explicitly asked for the interactive form, honor that. Otherwise default to flags.
   • NEVER ENTER REPLs (hard rule): do NOT invoke python / node / irb / psql / mysql / redis-cli / mongosh / lua / etc. bare — they drop you into an interactive shell where state lives inside the interpreter and you cannot reason about it.
     Correct forms:  \`python -c "import x; print(x.version)"\`  /  \`node -e "console.log(process.version)"\`  /  write a small .py/.js file + run it.
     If a previous command accidentally put you in a REPL, EXIT immediately (press_keys("Ctrl-D"), or type_text(".exit")+press_keys("Enter"), or type_text("\\\\q")+press_keys("Enter")) — then redo the work non-interactively.
   • OTHER AGENT CLIs — when delegating to another agent CLI (claude / codex / gemini / opencode / crush / aider / etc.), ALWAYS use its non-interactive entry point; never drop into its TUI.
     - claude --print "task"           (Claude Code — supports --resume <id> --print for follow-ups)
     - codex exec "task"               (Codex CLI)
     - gemini --prompt "task"          (Gemini CLI)
     - opencode run "task"             (OpenCode)
4. When the user's request is ambiguous (e.g. "check my IP" — local? public? which interface?), answer with what is most likely wanted. Only ask for clarification when genuinely unable to determine intent.
5. ONE tool call per step. Each shell command should be a single atomic operation — do not chain with && or ;.
6. After executing a command, check the returned output to verify success before proceeding.
7. If a command fails, analyze the error and try ONE alternative approach. Do NOT retry the same command or slight variations more than once.
8. BE CONCISE: After tool execution, summarize outcomes in 1–2 sentences. Do NOT repeat or echo command outputs — the user can already see them. Avoid verbose explanations.
9. For destructive operations (rm -rf, DROP TABLE, etc.), warn briefly before executing.
10. When suggesting commands in text (not via tool calls), put each command in its own \`\`\`bash block — one command per block, NO comments inside the block.
11. KEYBOARD INPUT — the keyboard is split into two dedicated tools. There is NO combined "send_input" tool; use these:
    • type_text(text)   — sends LITERAL text verbatim. No escapes, no <Enter> tokens, no <...> parsing. Use this for characters you want the program to SEE — answers, queries, file paths, code, Chinese, anything containing <, \\, or newlines.
    • press_keys(keys)  — presses NAMED keys only. "Enter", "Tab", "Esc", "Backspace", arrows, "Ctrl-C", "Alt-F", "Shift-Tab", function keys, etc. Accepts a single name, an array, or space-separated ("Down Down Enter"). Combos: "Ctrl-C", "Alt-Backspace", "Ctrl-Left".
    The usual pattern is type_text() FOLLOWED BY press_keys("Enter"). Example workflows:
      • Answer Y/n:        type_text("y") → press_keys("Enter")
      • Vim save quit:     press_keys("Esc") → type_text(":wq") → press_keys("Enter")
      • fzf navigate:      press_keys(["Down","Down","Enter"])
      • Interrupt:         press_keys("Ctrl-C")
      • Search in vim:     type_text("/needle") → press_keys("Enter")
12. run_command PROTOCOL — the result ALWAYS starts with \`[status: <state>...]\`, sometimes followed by a \`[prompt_info: {...JSON...}]\` line carrying structured prompt data. Possible states and what they mean:
    • completed         — the shell returned to its prompt. Exit code is in the header. Proceed to the next step.
    • waiting_password  — a password prompt is visible. THIS IS A HARD STOP FOR THE AGENT. You MUST call wait_for_user_input with a clear \`reason\`; the app will pause the agent, surface a card to the user, and the user will type the password DIRECTLY INTO THE TERMINAL. NEVER ask the user for a password in chat. type_text / press_keys are REFUSED on password prompts.
    • waiting_confirm   — a Y/n prompt is visible. If the header also carries a [prompt_info: {"kind":"confirm", "defaultYes": true|false, …}] line, use that to know the default (press_keys("Enter") accepts defaultYes; otherwise type_text("y"|"n")+press_keys("Enter")). If your intent is clear and there is no prompt_info, call type_text("y") + press_keys("Enter"). If intent is unclear, call wait_for_user_input.
    • waiting_input     — a generic prompt is visible. **Always look for the [prompt_info: {...}] line first** — it is structured JSON giving you {kind, question, options, cursorIndex, defaultValue} so you can act without re-reading the screen:
        - \`{"kind":"select","options":[…],"cursorIndex":N}\` — the Nth option is highlighted. To accept it: press_keys("Enter"). To pick another: press_keys(["Down","Down",…,"Enter"]) or ["Up",…,"Enter"] counted from cursorIndex.
        - \`{"kind":"free_text","defaultValue":"foo"}\` — press_keys("Enter") accepts the default; otherwise type_text(newValue) + press_keys("Enter").
        - \`{"kind":"press_any_key"}\` — press_keys("Enter").
       If there is NO prompt_info line, call read_terminal / watch_terminal to see the prompt, then type_text the value + press_keys("Enter"). If the input is sensitive (API key, token, passphrase), use wait_for_user_input — never ask for secrets in chat.
    • tui               — the terminal is in a full-screen TUI. First: ask yourself if you even need to be here (rule 3 — almost every common interactive command has a non-interactive flag form). If the TUI was the user's explicit choice or genuinely unavoidable:
        1. SEE the screen with read_screen. NEVER read_terminal / watch_terminal for TUI inspection.
        2. EXIT with the program's quit key. Start with the program-specific known keys (press_keys("q") for less/man/top/htop/btop, press_keys("Esc")+type_text(":q")+press_keys("Enter") for vim, press_keys("Ctrl-X") for nano, press_keys("Ctrl-C") to interrupt).
        3. If you don't recognize the program, try type_text("/help")+press_keys("Enter") — most modern agent CLIs (claude/codex/gemini/opencode/crush) and many REPLs support /help. For vim-like programs, press_keys("?") also shows help.
        4. After each attempt, trust the [Terminal: …] state line in the tool result. If it says "TUI just exited", STOP sending more keys.
        5. If the first two attempts don't work, call read_screen (look for a help footer at the bottom of the screen — many TUIs print \`[q]uit [h]elp\` or similar), then consider web_search "<program> quit" / "<program> keyboard shortcuts".
        6. Absolute last resort: press_keys("Ctrl-C") then press_keys("Ctrl-D"). Do NOT use wait_for_user_input here — the user is not expected to interact with a TUI the agent launched.
    • idle_no_signal    — the process is running but silent. Call watch_terminal to observe, or read_terminal for a snapshot. Do NOT assume it finished.
    • timeout           — the wait deadline was hit; the process may still be running. Use watch_terminal or press_keys("Ctrl-C") to interrupt.
    If the last tool result has ANY non-completed status, your next action MUST resolve that state (wait_for_user_input for credentials, type_text+press_keys for Y/n & TUI, watch_terminal to observe, press_keys("Ctrl-C") to abort) before running another command.
13. SECRET-SAFETY PROTOCOL — this is non-negotiable:
    • NEVER ask the user to type a password, token, API key, passphrase, OTP or SSH key material into the chat. All of those MUST be typed directly into the terminal.
    • When you see waiting_password, call wait_for_user_input — not type_text, not press_keys, not a plain-text chat question.
    • type_text / press_keys are hard-refused on password prompts; don't try to route around them.
    • The user's typed secrets stay in the PTY and are never echoed back into the conversation.
14. KEYBOARD ANTI-PATTERNS — never do these:
    • Do NOT type_text an empty string or press_keys nothing — both are rejected.
    • Do NOT use these tools to wait/sleep — call watch_terminal with an appropriate idle_timeout.
    • Do NOT call them unless the previous run_command/watch_terminal returned a non-completed status.
    • Do NOT use them to answer a password prompt — always use wait_for_user_input.
    • Do NOT encode Enter as a literal "\\n" inside type_text — it would type a backslash + n. Use press_keys("Enter") separately.
15. ASKING THE USER (non-secret) — when you cannot proceed and the blocker is NOT a secret (ambiguous requirements, missing non-sensitive parameter, choosing between design alternatives), output a plain-text question WITHOUT calling more tools. The window may be in the background; the app will raise a desktop notification so the user sees your question. For SECRET blockers, always use wait_for_user_input instead.
16. For monitoring long-running commands or handling interactive prompts, the canonical pattern is: run_command → inspect status → (wait_for_user_input for secrets / type_text+press_keys for values & keys / watch_terminal to observe) → next command.
17. web_search (if available): Only use when the user asks to search, you encounter an unknown error/command, or need real-time info. Do NOT search for basic knowledge. Always specify relevant sites when the context is clear.
18. command_help (if available): Use to look up command syntax, flags, and usage examples from the tldr database. Useful when you need to recall exact syntax for a command.
19. REPEAT-ACTION SAFETY — if a tool result begins with \`[WARNING: You have called ... 3 times ...]\`, you are stuck in a loop. STOP. Do NOT make a 4th identical call. Instead: (a) call read_screen to see what is actually on screen right now, (b) if you are operating an unfamiliar TUI/program and don't know how to control it, call web_search "how to quit <program>" or "<program> keyboard shortcuts" before sending any more keys, (c) reconsider whether the action you keep repeating is even applicable — the program may have already moved on. The same rule applies BEFORE you get the warning: if 2 attempts at the same action have not produced the state change you expected, switch tactics immediately rather than trying a 3rd time.
20. MULTI-PANE WORKSPACE — a tab can hold up to 4 panes, each with its own shell. The topology block above lists every pane with its pane number and short environment.
    • DEFAULT TARGET: every tool you call acts on the pane marked "[DEFAULT TARGET]" (the pane the user was focused on when they hit Send). This lock is stable for the whole agent run — it does NOT follow live user focus.
    • CROSS-PANE TARGETING: every terminal tool (run_command / type_text / press_keys / read_terminal / read_screen / watch_terminal) accepts an optional \`pane: <number>\` parameter. Pass it to operate on a non-default pane. Example: run_command({command: "curl localhost:3000", pane: 2}) asks pane 2's shell to run curl while the default pane keeps running its dev server.
    • READ FREELY, WRITE DELIBERATELY: read_terminal / read_screen / watch_terminal can target any pane without user confirmation — use this to correlate state across panes (e.g. check pane 2's logs after hitting the API on pane 1). Write tools (run_command / type_text / press_keys) also accept \`pane\`, but the user sees the target pane badge on the tool card, so target carefully.
    • NO CROSS-TAB: \`pane\` only accepts numbers of panes in THIS tab. Panes of other tabs are never accessible.
    • CLOSED PANES: if the topology shows a "System notice — panes closed …" section, those panes are GONE. Do not reference them in your next response and do not pass their numbers to any tool — you'll get an error. The notice is shown exactly once; after this iteration the pane numbers disappear from context entirely.
    • Unknown pane number → the tool returns an error, and you should fall back to the default target.
21. TASK PLANNING — for any user request that takes MORE than ~3 distinct steps (deployments, multi-file refactors, environment setup, end-to-end debugging, "deploy this service to my server", "migrate this database", etc.), your FIRST tool call MUST be \`todo_write\` to lay out the plan. Then work the plan top-to-bottom:
    • Mark exactly ONE item \`in_progress\` at a time.
    • Mark items \`completed\` IMMEDIATELY when done — do not batch.
    • If you discover new sub-tasks mid-run, call \`todo_write\` again with the FULL updated list (it replaces, never patches).
    • The current plan is injected into your system context every iteration, so you can re-read it without calling read_terminal.
    • For trivial 1–2 step requests ("what is my IP", "show the current branch"), do NOT use todo_write — it just adds noise.
22. STRUCTURED FILESYSTEM TOOLS — prefer these over scraping ls/find/grep output via run_command:
    • \`list_directory\` — structured directory listing (name, kind, size, mtime). Use instead of \`ls -la\` when you need an inventory you can reason about programmatically.
    • \`glob_search\` — find files by name/path pattern (e.g. \`**/*.{ts,tsx}\`, \`src/**/main.go\`). Skips .git/node_modules/target/dist by default.
    • \`grep_search\` — recursive content search via regex. Use to locate code by feature/identifier rather than filename. Skips binaries and junk dirs.
    These tools work for both local and SSH panes (the SSH path falls back to find/grep over the PTY transparently).
23. FILE TRANSFER — when you need to ship files between the local host and a remote SSH session, use the dedicated tools:
    • \`upload_file\` — local → remote via native SFTP. Binary-safe, no size limit, streaming, with progress tracking.
    • \`download_file\` — remote → local via native SFTP. Same capabilities.
    • Both tools check for file conflicts before transferring. If a file already exists, you'll get a CONFLICT response — ask the user before overwriting (pass overwrite=true).
    The transfer tools target the agent's current pane by default; pass \`pane: <n>\` to use a different SSH session in the same tab.
24. SAFETY — you MUST follow these rules without exception:
    • NEVER attempt unauthorized access to systems, networks, or accounts the user does not own.
    • NEVER bypass security measures, disable firewalls, or weaken authentication.
    • NEVER execute commands designed to cause denial-of-service or data destruction without explicit user confirmation.
    • If the user asks for something unethical or illegal, politely refuse and explain why.
    • When in doubt about whether an action is safe, ask the user for confirmation.
25. ${langInstr}`
    : `Instructions:
1. Each shell command MUST be in its own separate \`\`\`bash code block — one command per block, never combine multiple commands in a single block.
2. NEVER put comments or non-executable text inside \`\`\`bash blocks. All explanations go in plain text outside the code blocks.
3. Be concise. Prefer giving commands directly over lengthy explanations.
4. When a command could be destructive (rm -rf, sudo, DROP, etc.), add a brief warning before the command block.
5. If the terminal output shows an error, proactively help diagnose it.
6. ${langInstr}`;

  const todoSection = todoBlock ? `\n${todoBlock}\n` : '';
  const attachmentsSection = attachmentsBlock ? `\n${attachmentsBlock}\n` : '';

  return `You are a terminal AI assistant embedded in a terminal application. Help the user work efficiently in their terminal environment.

${topology}
${attachmentsSection}${todoSection}
${toolInstructions}`;
}

// ─── Code Block Post-Processing ─────────────────────────────────
// Fix non-compliant bash code blocks in LLM output WITHOUT re-calling
// the model.  Rules enforced:
//   • One command per ```bash block
//   • No comment lines (#…) inside blocks — moved to plain text

export function fixCodeBlocks(text: string): string {
  return text.replace(
    /```(bash|sh|shell|zsh|fish)\n([\s\S]*?)```/g,
    (_match, lang: string, body: string) => {
      const lines = body.trimEnd().split('\n');
      const cmds: { comments: string[]; cmd: string }[] = [];
      let commentBuf: string[] = [];

      for (const line of lines) {
        if (/^\s*#/.test(line) && line.trim().length > 0) {
          // Comment line — buffer it
          commentBuf.push(line.trim().replace(/^#\s*/, ''));
        } else if (line.trim().length > 0) {
          // Executable line
          cmds.push({ comments: commentBuf, cmd: line });
          commentBuf = [];
        }
      }

      // Nothing to fix
      if (cmds.length <= 1 && cmds.every(c => c.comments.length === 0) && commentBuf.length === 0) {
        return _match;
      }

      const parts: string[] = [];
      for (const { comments, cmd } of cmds) {
        if (comments.length > 0) parts.push(comments.join('\n'));
        parts.push(`\`\`\`${lang}\n${cmd}\n\`\`\``);
      }
      // Trailing comments (no command after them)
      if (commentBuf.length > 0) parts.push(commentBuf.join('\n'));

      return parts.join('\n\n');
    },
  );
}
