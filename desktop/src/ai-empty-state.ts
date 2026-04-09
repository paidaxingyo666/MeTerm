// ─── AI Empty State ─────────────────────────────────────────
// Contextual welcome block rendered in the chat messages container
// when the conversation has no messages yet. Shows:
//
//   1) Context header — a single line with connection type,
//      working directory, (git branch), shell and hook status.
//   2) Quick-prompt pills — 2-4 buttons whose content depends on
//      the terminal state (error in recent output → "explain it",
//      git repo → "git status", package.json → "npm scripts", etc.).
//      Number of slots adapts to panel width.
//   3) A single-line rotating tip that teaches a keyboard shortcut
//      or hidden feature.
//
// On click, a quick prompt is sent directly via the caller-supplied
// onSend callback. The empty-state element is auto-removed when the
// first real message is appended (see removeEmptyState).

import { invoke } from '@tauri-apps/api/core';
import { getLanguage } from './i18n';
import { gatherContext } from './ai-agent-context';
import { TerminalRegistry } from './terminal';
import type { AICapsuleInstance } from './ai-capsule-types';

// ─── Project hint detection ─────────────────────────────────

interface ProjectHints {
  isGit: boolean;
  gitBranch?: string;
  hasPackageJson: boolean;
  hasCargoToml: boolean;
  hasDockerfile: boolean;
  hasCompose: boolean;
  hasGoMod: boolean;
  hasPyproject: boolean;
}

const EMPTY_HINTS: ProjectHints = {
  isGit: false,
  hasPackageJson: false,
  hasCargoToml: false,
  hasDockerfile: false,
  hasCompose: false,
  hasGoMod: false,
  hasPyproject: false,
};

interface AgentReadResult {
  content: string | null;
  size: number;
  is_binary: boolean;
  too_large: boolean;
}

/**
 * Best-effort probe of a handful of project-marker files in the CWD.
 * Runs entirely locally and only when the session is NOT an SSH
 * session (remote paths can't be read by the local Rust command).
 * Every probe is wrapped in a try/catch — missing files are normal.
 */
async function detectProjectHints(cwd: string, isSSH: boolean): Promise<ProjectHints> {
  if (!cwd || isSSH) return EMPTY_HINTS;

  const tryRead = async (rel: string): Promise<string | null> => {
    try {
      const path = cwd.endsWith('/') ? `${cwd}${rel}` : `${cwd}/${rel}`;
      const r = await invoke<AgentReadResult>('agent_read_file', {
        path,
        maxBytes: 1024,
      });
      return r.content ?? '';
    } catch {
      return null;
    }
  };

  const [gitHead, pkg, cargo, dockerfile, compose, gomod, pyproject] = await Promise.all([
    tryRead('.git/HEAD'),
    tryRead('package.json'),
    tryRead('Cargo.toml'),
    tryRead('Dockerfile'),
    tryRead('docker-compose.yml'),
    tryRead('go.mod'),
    tryRead('pyproject.toml'),
  ]);

  const hints: ProjectHints = { ...EMPTY_HINTS };
  if (gitHead !== null) {
    hints.isGit = true;
    const m = gitHead.match(/ref:\s+refs\/heads\/(.+)/);
    if (m) hints.gitBranch = m[1].trim();
  }
  hints.hasPackageJson = pkg !== null;
  hints.hasCargoToml = cargo !== null;
  hints.hasDockerfile = dockerfile !== null;
  hints.hasCompose = compose !== null;
  hints.hasGoMod = gomod !== null;
  hints.hasPyproject = pyproject !== null;
  return hints;
}

// ─── Error / activity classifier ────────────────────────────
//
// Walk the tail of the recent output and try to recognize a specific
// failure signature. When found, the empty-state renderer can offer a
// highly-targeted prompt (e.g. "did you mean `git`?" for a mistyped
// command) instead of the generic "explain the last error".

type ActivityKind =
  | 'error_command_not_found'
  | 'error_permission_denied'
  | 'error_no_such_file'
  | 'error_connection_refused'
  | 'error_syntax'
  | 'error_generic'
  | 'none';

interface ActivityClassification {
  kind: ActivityKind;
  /** Command name / file path / host — whatever the error is about. */
  subject?: string;
  /** The raw line that matched (trimmed). */
  line?: string;
}

const SHELL_PROMPT_TAIL_RE = /[$#%>»]\s*$/;

function classifyRecentActivity(recentOutput: string): ActivityClassification {
  if (!recentOutput) return { kind: 'none' };
  const rawLines = recentOutput.split('\n').filter((l) => l.trim().length > 0);
  // Scan the LAST ~15 lines in reverse — the freshest error wins.
  const tail = rawLines.slice(-15).reverse();
  for (const raw of tail) {
    const line = raw.trim();
    // Skip bare shell prompts ($, %, #, > tails).
    if (SHELL_PROMPT_TAIL_RE.test(line) && line.length < 40) continue;

    // ── command not found (bash / zsh / fish / powershell) ──
    let m: RegExpMatchArray | null;
    if (
      (m = line.match(/command not found:\s*([A-Za-z0-9_.\-/]+)/i)) ||
      (m = line.match(/([A-Za-z0-9_.\-/]+):\s*command not found/i)) ||
      (m = line.match(/Unknown command[:\s]+['"]?([A-Za-z0-9_.\-/]+)['"]?/i))
    ) {
      return { kind: 'error_command_not_found', subject: m[1], line };
    }
    // PowerShell: "foo: The term 'foo' is not recognized"
    if ((m = line.match(/The term '([^']+)' is not recognized/i))) {
      return { kind: 'error_command_not_found', subject: m[1], line };
    }

    // ── permission denied ──
    if (/permission denied/i.test(line)) {
      return { kind: 'error_permission_denied', line };
    }

    // ── no such file ──
    if (
      (m = line.match(/no such file or directory[:\s]*['"]?([^'"\n]*?)['"]?$/i))
    ) {
      const subj = m[1]?.trim();
      return {
        kind: 'error_no_such_file',
        subject: subj && subj.length > 0 ? subj : undefined,
        line,
      };
    }

    // ── network / connection issues ──
    if (
      /connection (?:refused|timed out)|couldn['']t connect|unable to connect|could not resolve host/i.test(line)
    ) {
      return { kind: 'error_connection_refused', line };
    }

    // ── syntax errors ──
    if (/syntax error|unexpected token|parse error/i.test(line)) {
      return { kind: 'error_syntax', line };
    }

    // ── fallback generic error ──
    if (/\b(error|failed|fatal|panic|traceback)\b/i.test(line)) {
      return { kind: 'error_generic', line };
    }
  }
  return { kind: 'none' };
}

/** Format a template string with `{0}` / `{1}` placeholders. */
function fmt(tpl: string, ...args: string[]): string {
  return tpl.replace(/\{(\d+)\}/g, (_, i) => args[Number(i)] ?? '');
}

// ─── Inline bilingual strings ───────────────────────────────
//
// We keep these in-module (rather than i18n.ts) because there are a
// lot of them and they're only referenced here. Flipping language
// lives behind the `pick()` helper below.

interface Strings {
  greeting: string;
  tipLabel: string;
  hookOk: string;
  hookMissing: string;
  // Quick-prompt labels
  explainError: string;
  summarizeRecent: string;
  serverHealth: string;
  gitStatus: string;
  npmScripts: string;
  cargoCheck: string;
  goBuild: string;
  pyDeps: string;
  dockerStatus: string;
  listDir: string;
  diskUsage: string;
  processes: string;
  // Quick-prompt actual prompts (sent to LLM)
  explainErrorPrompt: string;
  summarizeRecentPrompt: string;
  serverHealthPrompt: string;
  gitStatusPrompt: string;
  npmScriptsPrompt: string;
  cargoCheckPrompt: string;
  goBuildPrompt: string;
  pyDepsPrompt: string;
  dockerStatusPrompt: string;
  listDirPrompt: string;
  diskUsagePrompt: string;
  processesPrompt: string;
  // Error-specific (tailored) labels / prompts — `{0}` = subject.
  errCmdNotFoundLabel: string;
  errCmdNotFoundPrompt: string;
  errCmdNotFoundUnknownLabel: string;
  errCmdNotFoundUnknownPrompt: string;
  errPermDeniedLabel: string;
  errPermDeniedPrompt: string;
  errNoFileLabel: string;
  errNoFilePrompt: string;
  errNoFileUnknownPrompt: string;
  errConnLabel: string;
  errConnPrompt: string;
  errSyntaxLabel: string;
  errSyntaxPrompt: string;
}

const STRINGS_EN: Strings = {
  greeting: 'How can I help with this terminal?',
  tipLabel: 'Tip',
  hookOk: 'shell hook active',
  hookMissing: 'no shell hook',
  explainError: 'Explain the last error',
  summarizeRecent: 'Summarize what I just did',
  serverHealth: 'Check server health',
  gitStatus: 'Git status',
  npmScripts: 'Show npm scripts',
  cargoCheck: 'Run cargo check',
  goBuild: 'Build the Go project',
  pyDeps: 'Show Python dependencies',
  dockerStatus: 'Docker status',
  listDir: 'List this directory',
  diskUsage: 'Disk usage',
  processes: 'Top processes',
  explainErrorPrompt: 'Look at my recent terminal output and explain what went wrong, then suggest how to fix it.',
  summarizeRecentPrompt: 'Summarize what I just did in this terminal in 2-3 sentences.',
  serverHealthPrompt: 'Check this server\'s load, memory, disk usage and any recent errors in the system logs.',
  gitStatusPrompt: 'Run git status and summarize the state of the repository.',
  npmScriptsPrompt: 'Show me the scripts defined in package.json and briefly explain what each one does.',
  cargoCheckPrompt: 'Run cargo check and report any warnings or errors.',
  goBuildPrompt: 'Run go build ./... and report any errors.',
  pyDepsPrompt: 'Show me the Python dependencies in pyproject.toml and their purposes briefly.',
  dockerStatusPrompt: 'Show me which Docker containers are running and their status.',
  listDirPrompt: 'List the contents of the current directory and briefly describe what this project looks like.',
  diskUsagePrompt: 'Check disk usage — which filesystems are most full, and what\'s taking up space in the home directory?',
  processesPrompt: 'Show me the top processes by CPU and memory usage.',
  errCmdNotFoundLabel: 'Fix "{0}"',
  errCmdNotFoundPrompt: 'I tried to run `{0}` and the shell says "command not found". Figure out what I probably meant: check PATH, common typos, and whether the tool is installed (and how to install it if not). Suggest the corrected command.',
  errCmdNotFoundUnknownLabel: 'Fix missing command',
  errCmdNotFoundUnknownPrompt: 'A command I just tried is reported as "not found". Look at my recent terminal output, figure out what I was trying to run, and tell me what the correct command / package is.',
  errPermDeniedLabel: 'Fix permission denied',
  errPermDeniedPrompt: 'I got a "permission denied" error. Look at my recent terminal output, figure out what path / operation was blocked, and tell me how to resolve it (sudo, chmod, chown, or switching to a writable location).',
  errNoFileLabel: 'Find missing file',
  errNoFilePrompt: 'The command says "{0}" does not exist. Help me find the correct path — search nearby directories, check for typos, and verify whether I need to create it.',
  errNoFileUnknownPrompt: 'The last command reported "no such file or directory". Figure out which file was missing and suggest how to fix it.',
  errConnLabel: 'Diagnose connection',
  errConnPrompt: 'I got a connection failure. Check whether the target service is running locally (ports, processes), whether the network can reach it, and suggest the most likely fix.',
  errSyntaxLabel: 'Fix syntax error',
  errSyntaxPrompt: 'I got a syntax error. Look at the recent output, show me the failing line, and tell me exactly what to fix.',
};

const STRINGS_ZH: Strings = {
  greeting: '有什么可以帮你处理的？',
  tipLabel: '小提示',
  hookOk: 'Shell hook 已生效',
  hookMissing: 'Shell hook 未注入',
  explainError: '解释刚才的错误',
  summarizeRecent: '总结我刚才做了什么',
  serverHealth: '检查服务器健康',
  gitStatus: 'Git 状态',
  npmScripts: '查看 npm 脚本',
  cargoCheck: '运行 cargo check',
  goBuild: '编译 Go 项目',
  pyDeps: '查看 Python 依赖',
  dockerStatus: 'Docker 状态',
  listDir: '看看这个目录',
  diskUsage: '磁盘占用',
  processes: '进程占用',
  explainErrorPrompt: '看一下我终端最近的输出，解释一下出了什么错，然后建议怎么修。',
  summarizeRecentPrompt: '用两三句话总结一下我刚才在这个终端里做了什么。',
  serverHealthPrompt: '检查一下这台服务器的负载、内存、磁盘使用情况以及系统日志里最近的错误。',
  gitStatusPrompt: '跑一下 git status 总结一下这个仓库的状态。',
  npmScriptsPrompt: '列出 package.json 里定义的 scripts 并简单说明每个脚本的用途。',
  cargoCheckPrompt: '运行 cargo check 报告任何警告或错误。',
  goBuildPrompt: '运行 go build ./... 报告任何错误。',
  pyDepsPrompt: '列出 pyproject.toml 里的 Python 依赖并简要说明它们的用途。',
  dockerStatusPrompt: '列一下当前正在运行的 Docker 容器和它们的状态。',
  listDirPrompt: '列出当前目录的内容，简要描述一下这个项目的结构。',
  diskUsagePrompt: '检查磁盘占用——哪个文件系统最满？家目录里哪些目录占得最多？',
  processesPrompt: '展示 CPU 和内存占用最高的几个进程。',
  errCmdNotFoundLabel: '修正 "{0}"',
  errCmdNotFoundPrompt: '我刚才输入的 `{0}` 命令报 "command not found"。帮我看看我可能想输入什么：检查 PATH、常见拼写错误、以及这个工具是否装了（没装的话怎么装），然后给我一个正确的命令。',
  errCmdNotFoundUnknownLabel: '修正找不到的命令',
  errCmdNotFoundUnknownPrompt: '我刚才运行的一个命令报 "not found"。看一下我的终端最近输出，推测我想跑什么，告诉我正确的命令或需要安装的包。',
  errPermDeniedLabel: '处理权限问题',
  errPermDeniedPrompt: '我遇到了 "permission denied" 错误。看一下终端最近的输出，搞清楚是哪个路径或操作被拒，然后告诉我应该怎么处理（sudo、chmod、chown，或者换到可写的位置）。',
  errNoFileLabel: '查找不存在的文件',
  errNoFilePrompt: '命令说 "{0}" 不存在。帮我找一下正确的路径——在附近的目录找找、看看是不是拼错了，或者判断我是不是需要新建它。',
  errNoFileUnknownPrompt: '最近一条命令报 "no such file or directory"。搞清楚是哪个文件找不到，然后告诉我怎么处理。',
  errConnLabel: '排查网络连接',
  errConnPrompt: '我遇到了连接失败。帮我检查：目标服务是否在本地运行（端口、进程）、网络能否到达、以及最可能的修复方式。',
  errSyntaxLabel: '修正语法错误',
  errSyntaxPrompt: '我遇到了语法错误。看一下最近的输出，指出出错那一行，然后告诉我具体怎么改。',
};

function pick(): Strings {
  return getLanguage() === 'zh' ? STRINGS_ZH : STRINGS_EN;
}

// ─── Quick-prompt selection ─────────────────────────────────

interface QuickPrompt {
  icon: string;
  label: string;
  prompt: string;
  priority: number;
}

function buildQuickPromptPool(
  recentOutput: string,
  isSSH: boolean,
  hints: ProjectHints,
): QuickPrompt[] {
  const S = pick();
  const pool: QuickPrompt[] = [];

  // ── Targeted error handling (highest priority) ──
  // The classifier recognizes a specific failure signature and we
  // generate a prompt that mentions the exact subject (the bad
  // command, the missing file, the refused host). A generic pool
  // prompt would force the agent to re-parse the screen to figure
  // out what to fix — pointless when we already know.
  const activity = classifyRecentActivity(recentOutput);
  switch (activity.kind) {
    case 'error_command_not_found': {
      if (activity.subject) {
        pool.push({
          icon: '✏️',
          label: fmt(S.errCmdNotFoundLabel, activity.subject),
          prompt: fmt(S.errCmdNotFoundPrompt, activity.subject),
          priority: 110,
        });
      } else {
        pool.push({
          icon: '✏️',
          label: S.errCmdNotFoundUnknownLabel,
          prompt: S.errCmdNotFoundUnknownPrompt,
          priority: 108,
        });
      }
      break;
    }
    case 'error_permission_denied': {
      pool.push({
        icon: '🔒',
        label: S.errPermDeniedLabel,
        prompt: S.errPermDeniedPrompt,
        priority: 107,
      });
      break;
    }
    case 'error_no_such_file': {
      pool.push({
        icon: '📁',
        label: S.errNoFileLabel,
        prompt: activity.subject
          ? fmt(S.errNoFilePrompt, activity.subject)
          : S.errNoFileUnknownPrompt,
        priority: 106,
      });
      break;
    }
    case 'error_connection_refused': {
      pool.push({
        icon: '🌐',
        label: S.errConnLabel,
        prompt: S.errConnPrompt,
        priority: 105,
      });
      break;
    }
    case 'error_syntax': {
      pool.push({
        icon: '⚠️',
        label: S.errSyntaxLabel,
        prompt: S.errSyntaxPrompt,
        priority: 104,
      });
      break;
    }
    case 'error_generic': {
      pool.push({
        icon: '💡',
        label: S.explainError,
        prompt: S.explainErrorPrompt,
        priority: 100,
      });
      break;
    }
    case 'none': {
      // No detected failure — fall back to recent-output summarization
      // if there's actually something to summarize.
      if (recentOutput && recentOutput.trim().length > 50) {
        pool.push({
          icon: '📋',
          label: S.summarizeRecent,
          prompt: S.summarizeRecentPrompt,
          priority: 85,
        });
      }
      break;
    }
  }

  if (isSSH) {
    pool.push({ icon: '🖥️', label: S.serverHealth, prompt: S.serverHealthPrompt, priority: 80 });
  }

  if (hints.isGit) {
    pool.push({ icon: '🔀', label: S.gitStatus, prompt: S.gitStatusPrompt, priority: 70 });
  }
  if (hints.hasPackageJson) {
    pool.push({ icon: '📦', label: S.npmScripts, prompt: S.npmScriptsPrompt, priority: 65 });
  }
  if (hints.hasCargoToml) {
    pool.push({ icon: '🦀', label: S.cargoCheck, prompt: S.cargoCheckPrompt, priority: 65 });
  }
  if (hints.hasGoMod) {
    pool.push({ icon: '🐹', label: S.goBuild, prompt: S.goBuildPrompt, priority: 65 });
  }
  if (hints.hasPyproject) {
    pool.push({ icon: '🐍', label: S.pyDeps, prompt: S.pyDepsPrompt, priority: 65 });
  }
  if (hints.hasDockerfile || hints.hasCompose) {
    pool.push({ icon: '🐳', label: S.dockerStatus, prompt: S.dockerStatusPrompt, priority: 60 });
  }

  // Low-priority generic fallbacks — always present so there's
  // always something to click even in a pristine empty directory.
  pool.push({ icon: '🔍', label: S.listDir, prompt: S.listDirPrompt, priority: 30 });
  pool.push({ icon: '💾', label: S.diskUsage, prompt: S.diskUsagePrompt, priority: 25 });
  pool.push({ icon: '📊', label: S.processes, prompt: S.processesPrompt, priority: 20 });

  pool.sort((a, b) => b.priority - a.priority);
  return pool;
}

/** Decide how many quick-prompt slots to show based on the panel
 * width. Wider panel → more pills; tiny panel → bare minimum. */
function slotCountForWidth(panelWidth: number): number {
  if (panelWidth >= 560) return 4;
  if (panelWidth >= 400) return 3;
  return 2;
}

// ─── DOM builders ───────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortenPath(cwd: string): string {
  if (!cwd) return '';
  // Collapse $HOME prefix to ~ for readability. We can't read $HOME
  // from the browser directly — use a heuristic: any path starting
  // with /Users/<name>/ on macOS or /home/<name>/ on Linux.
  const m = cwd.match(/^(?:\/Users|\/home)\/[^/]+(\/.*)?$/);
  if (m) return '~' + (m[1] ?? '');
  return cwd;
}

function buildContextHeader(
  sessionId: string,
  hints: ProjectHints,
): HTMLElement {
  const S = pick();
  const row = document.createElement('div');
  row.className = 'ai-empty-context';

  const mt = TerminalRegistry.get(sessionId);
  const ctx = gatherContext(sessionId, 0);

  const parts: string[] = [];

  // Connection indicator
  if (ctx.isSSH) {
    parts.push(`<span class="ai-empty-ctx-ico" aria-hidden="true">🌐</span><span>${escapeHtml(ctx.serverInfo || 'ssh')}</span>`);
  } else {
    parts.push(`<span class="ai-empty-ctx-ico" aria-hidden="true">📍</span><span>Local</span>`);
  }

  // CWD
  if (ctx.cwd) {
    parts.push(`<span class="ai-empty-ctx-sep">·</span><span class="ai-empty-ctx-cwd" title="${escapeHtml(ctx.cwd)}">${escapeHtml(shortenPath(ctx.cwd))}</span>`);
  }

  // Git branch
  if (hints.isGit && hints.gitBranch) {
    parts.push(`<span class="ai-empty-ctx-sep">·</span><span class="ai-empty-ctx-git">⎇ ${escapeHtml(hints.gitBranch)}</span>`);
  }

  // Shell name — default to 'shell' if not known
  const shellName = mt?.shellState.phase && mt.shellState.hookInjected
    ? (detectShellName() || 'shell')
    : 'shell';
  parts.push(`<span class="ai-empty-ctx-sep">·</span><span>${escapeHtml(shellName)}</span>`);

  // Shell hook badge (✓ / ✗)
  const hookOk = !!mt?.shellState.hookInjected;
  const badge = hookOk
    ? `<span class="ai-empty-ctx-hook ok" title="${escapeHtml(S.hookOk)}">✓</span>`
    : `<span class="ai-empty-ctx-hook warn" title="${escapeHtml(S.hookMissing)}">!</span>`;
  parts.push(`<span class="ai-empty-ctx-sep">·</span>${badge}`);

  row.innerHTML = parts.join('');
  return row;
}

/**
 * Try to read the shell name from the Tauri settings. This is a best
 * effort — if we can't determine it, the caller falls back to 'shell'.
 */
function detectShellName(): string {
  try {
    // Pull from settings if available (shell configured in user settings).
    const raw = localStorage.getItem('meterm-settings');
    if (raw) {
      const s = JSON.parse(raw);
      if (typeof s.shell === 'string') {
        // Extract just the basename (e.g. /bin/zsh → zsh)
        const m = s.shell.match(/([^/\\]+)$/);
        return m ? m[1] : s.shell;
      }
    }
  } catch { /* ignore */ }
  return '';
}

function buildGreeting(): HTMLElement {
  const S = pick();
  const el = document.createElement('div');
  el.className = 'ai-empty-greeting';
  el.textContent = S.greeting;
  return el;
}

function buildQuickPromptsRow(
  prompts: QuickPrompt[],
  onSend: (text: string) => void,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ai-empty-prompts';
  for (const p of prompts) {
    const btn = document.createElement('button');
    btn.className = 'ai-empty-prompt-btn';
    btn.type = 'button';
    btn.title = p.prompt;
    btn.innerHTML = `<span class="ai-empty-prompt-ico" aria-hidden="true">${p.icon}</span><span class="ai-empty-prompt-label">${escapeHtml(p.label)}</span>`;
    btn.addEventListener('click', () => onSend(p.prompt));
    row.appendChild(btn);
  }
  return row;
}

// ─── Smart tip system ───────────────────────────────────────
//
// Tips are condition-driven, weighted, and deduplicated via a small
// localStorage ring buffer so the same tip doesn't appear twice in
// quick succession. A tip whose `when(ctx)` returns false is filtered
// out before the weighted pick — so e.g. the "enable shell hook"
// tip only shows up when the hook is actually missing.

interface TipContext {
  isSSH: boolean;
  hookInjected: boolean;
  layoutMode: 'bottom' | 'side';
  hasRecentError: boolean;
  hasGit: boolean;
  hasRecentOutput: boolean;
  hasProject: boolean;
}

interface SmartTip {
  id: string;
  en: string;
  zh: string;
  /** Filter: tip is eligible only when this returns true. */
  when?: (c: TipContext) => boolean;
  /** Random selection weight (default 1). Higher = more likely. */
  weight?: number;
}

const SMART_TIPS: SmartTip[] = [
  // ── Feature discovery ─────────────────────────
  {
    id: 'paste-image',
    en: 'Paste a screenshot into the input box to ask the agent about it.',
    zh: '把截图直接粘贴到输入框，agent 能直接看图回答。',
    weight: 3,
  },
  {
    id: 'attach-file',
    en: 'The paperclip button attaches files — the agent can read them directly without scoping issues.',
    zh: '回形针按钮可以附加文件——agent 能直接读，不受 Tauri scope 限制。',
    weight: 2,
  },
  {
    id: 'ctrl-enter-opposite',
    en: 'In the AI Bar, Ctrl/Cmd+Enter always sends to the "other side" — if Enter goes to the terminal, Ctrl+Enter sends to the agent (and vice versa). Swap the default in Settings → AI.',
    zh: '在 AI Bar 输入框里，Ctrl/Cmd+Enter 永远发送到"另一侧"——Enter 发到终端时它就发给 agent，反之亦然。默认方向在 设置 → AI 里改。',
    // Side mode: AI Bar's Ctrl+Enter focuses the side textarea instead
    // of sending, so this tip doesn't apply there.
    when: (c) => c.layoutMode === 'bottom',
    weight: 2,
  },
  {
    id: 'esc-clear',
    en: 'Press Esc to clear the input box instantly.',
    zh: '按 Esc 可以秒清空输入框。',
    weight: 1,
  },
  {
    id: 'ime-safe-enter',
    en: 'While typing with an IME, Enter picks the candidate — it won\'t accidentally send.',
    zh: '使用输入法打字时，Enter 只是选候选词，不会误发送消息。',
    weight: 1,
  },
  {
    id: 'inject-while-running',
    en: 'You can type another message while the agent is working — it\'ll be picked up on the next iteration.',
    zh: 'Agent 工作中你可以继续发消息，下一轮迭代时会被处理。',
    weight: 2,
  },

  // ── Layout / workflow ─────────────────────────
  {
    id: 'dock-side',
    en: 'Click the layout icon in the chat header to dock the panel on the side.',
    zh: '点击聊天面板标题栏的布局图标可以把面板贴到侧边栏。',
    when: (c) => c.layoutMode === 'bottom',
    weight: 2,
  },
  {
    id: 'dock-bottom',
    en: 'Click the layout icon again to move the chat panel back to the bottom.',
    zh: '再点一次布局图标可以把面板挪回底部。',
    when: (c) => c.layoutMode === 'side',
    weight: 2,
  },
  {
    id: 'new-chat-btn',
    en: 'The "New chat" button starts a fresh conversation and saves the current one to history.',
    zh: '"新对话" 按钮开一个新会话，当前会话会自动存到历史里。',
    weight: 1,
  },
  {
    id: 'chat-history',
    en: 'Open the chat history drawer to jump back into any previous conversation.',
    zh: '打开聊天历史抽屉可以回到之前任何一次对话继续聊。',
    weight: 1,
  },
  {
    id: 'minimize-chat',
    en: 'Clicking the send button with an empty input minimizes the chat — the conversation stays alive.',
    zh: '输入框为空时点发送按钮会最小化聊天窗口，对话本身还在。',
    weight: 1,
  },

  // ── Configuration / settings ──────────────────
  {
    id: 'permission-rules',
    en: 'Permission rules in Settings let the agent auto-approve safe commands without asking every time.',
    zh: '设置里的权限规则能让 agent 对安全命令自动放行，不用每次确认。',
    weight: 2,
  },
  {
    id: 'trust-level',
    en: 'Adjust the trust level to switch between "confirm each" and "full autonomy".',
    zh: '信任级别可以调——从每步确认到完全自主一键切换。',
    weight: 1,
  },
  {
    id: 'model-switch',
    en: 'Click the model name at the bottom of the chat to switch between configured LLMs.',
    zh: '点击聊天底部的模型名字可以快速切换已配置的 LLM。',
    weight: 1,
  },
  {
    id: 'enable-hook',
    en: 'Shell hook isn\'t injected. Enable it in Settings → AI to get accurate command-completion detection.',
    zh: '当前未注入 shell hook。在 设置 → AI 里打开它，agent 能更准确判断命令何时完成。',
    when: (c) => !c.hookInjected,
    weight: 4,
  },

  // ── Agent capabilities ────────────────────────
  {
    id: 'read-screen',
    en: 'Ask the agent to look at a TUI — it\'ll use read_screen to capture what\'s actually displayed.',
    zh: '让 agent 看 TUI 界面时，它会用 read_screen 抓取真实屏幕内容。',
    weight: 1,
  },
  {
    id: 'wait-for-password',
    en: 'When the agent hits a password prompt, it pauses and lets you type directly into the terminal.',
    zh: 'Agent 遇到密码提示会暂停，让你直接在终端里输密码——不会进对话历史。',
    weight: 2,
  },
  {
    id: 'non-interactive-default',
    en: 'The agent prefers flag-driven commands (gh --json, git commit -m) over interactive wizards.',
    zh: 'Agent 默认倾向 flag 形式的命令（gh --json, git commit -m），避免进交互向导。',
    weight: 1,
  },
  {
    id: 'no-repl',
    en: 'The agent never enters python/node/psql REPLs — it uses `-c` / `-e` one-liners instead.',
    zh: 'Agent 永远不进 python/node/psql 这些 REPL，改用 -c / -e 单次执行。',
    weight: 1,
  },

  // ── Context-specific ──────────────────────────
  {
    id: 'git-context',
    en: 'You\'re in a git repo — try asking about recent commits, the diff, or who last touched a file.',
    zh: '你现在在一个 git 仓库里——可以问问最近的提交、diff、或者某个文件是谁改的。',
    when: (c) => c.hasGit,
    weight: 2,
  },
  {
    id: 'ssh-context',
    en: 'Running over SSH — the agent can read remote files via the terminal. Local shortcuts are disabled.',
    zh: '当前是 SSH 会话——agent 会通过终端读远程文件，本地文件快捷方式在这会禁用。',
    when: (c) => c.isSSH,
    weight: 2,
  },
  {
    id: 'error-autosuggest',
    en: 'When you hit an error, reopen this panel — the empty state suggests a fix tailored to that specific error.',
    zh: '命令出错后再打开本面板，空状态会自动给出针对那个错误的修复建议。',
    when: (c) => c.hasRecentError,
    weight: 3,
  },
  {
    id: 'project-aware',
    en: 'The panel detects your project type (git/npm/cargo/go/python/docker) and tailors the quick prompts.',
    zh: '面板会自动识别项目类型（git/npm/cargo/go/python/docker）并给出对应的快捷操作。',
    when: (c) => c.hasProject,
    weight: 1,
  },
  {
    id: 'delegate-agent-cli',
    en: 'To delegate to claude/codex/gemini/opencode CLIs, the agent uses their non-interactive modes (--print, exec, run).',
    zh: '让 agent 去问 claude/codex/gemini/opencode CLI 时，它会自动用非交互模式（--print, exec, run）。',
    weight: 1,
  },
];

// Ring buffer of recently-shown tip IDs, persisted so tips don't
// repeat across successive panel opens within the same session.
const SHOWN_TIPS_KEY = 'meterm-empty-state-shown-tips';
const SHOWN_TIPS_WINDOW = 6;

function getShownTipIds(): string[] {
  try {
    const raw = localStorage.getItem(SHOWN_TIPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function recordShownTip(id: string): void {
  const shown = getShownTipIds();
  // Remove any existing entry so re-shown tips move to the front.
  const idx = shown.indexOf(id);
  if (idx >= 0) shown.splice(idx, 1);
  shown.unshift(id);
  while (shown.length > SHOWN_TIPS_WINDOW) shown.pop();
  try {
    localStorage.setItem(SHOWN_TIPS_KEY, JSON.stringify(shown));
  } catch { /* quota, private mode, etc — not worth handling */ }
}

/**
 * Weighted-random pick of a smart tip eligible in the given context.
 * Recently-shown tips are excluded. If that filter leaves nothing
 * (e.g. we have 3 tips and all were recently shown), the exclusion
 * is dropped and we pick from the unfiltered pool.
 */
function pickSmartTip(context: TipContext): SmartTip | null {
  const eligible = SMART_TIPS.filter((t) => (t.when ? t.when(context) : true));
  if (eligible.length === 0) return null;

  const recentlyShown = new Set(getShownTipIds());
  let candidates = eligible.filter((t) => !recentlyShown.has(t.id));
  if (candidates.length === 0) candidates = eligible;

  const total = candidates.reduce((s, t) => s + (t.weight ?? 1), 0);
  let r = Math.random() * total;
  for (const c of candidates) {
    r -= c.weight ?? 1;
    if (r <= 0) return c;
  }
  return candidates[candidates.length - 1];
}

function buildTipContext(
  ctx: { recentOutput: string; isSSH: boolean },
  hints: ProjectHints,
  layoutMode: 'bottom' | 'side',
  hookInjected: boolean,
): TipContext {
  const recent = ctx.recentOutput ?? '';
  return {
    isSSH: ctx.isSSH,
    hookInjected,
    layoutMode,
    hasRecentError: classifyRecentActivity(recent).kind !== 'none',
    hasGit: hints.isGit,
    hasRecentOutput: recent.trim().length > 0,
    hasProject:
      hints.isGit ||
      hints.hasPackageJson ||
      hints.hasCargoToml ||
      hints.hasGoMod ||
      hints.hasPyproject ||
      hints.hasDockerfile ||
      hints.hasCompose,
  };
}

function buildTipRow(context: TipContext): HTMLElement {
  const S = pick();
  const row = document.createElement('div');
  row.className = 'ai-empty-tip';

  const tip = pickSmartTip(context);
  if (!tip) {
    row.style.display = 'none';
    return row;
  }

  recordShownTip(tip.id);
  const text = getLanguage() === 'zh' ? tip.zh : tip.en;
  row.innerHTML = `<span class="ai-empty-tip-label">${escapeHtml(S.tipLabel)}</span><span class="ai-empty-tip-text">${escapeHtml(text)}</span>`;
  return row;
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Render the empty-state block into the chat messages container if
 * (and only if) the container is empty. Safe to call repeatedly —
 * a previous empty-state element is removed before re-rendering.
 *
 * The onSend callback fires when the user clicks a quick-prompt
 * pill; it should dispatch the prompt text to the agent. The empty
 * state does NOT clear itself on click — the caller is responsible
 * for appending the user message and then calling removeEmptyState.
 */
export async function renderEmptyState(
  instance: AICapsuleInstance,
  onSend: (text: string) => void,
): Promise<void> {
  const panel = instance.chatPanel;
  if (!panel) return;
  const container = panel.querySelector('.ai-chat-messages') as HTMLElement | null;
  if (!container) return;

  // Remove any stale empty-state first.
  removeEmptyState(container);

  // Guard: only render when the container has no actual conversation.
  // We check for any child that ISN'T an empty-state element (already
  // removed above) — so any remaining children are real messages.
  if (container.children.length > 0) return;

  // Gather context synchronously; project-hint detection runs async
  // so the render is two-phase: placeholder first, pills filled in
  // when the probes return.
  const ctx = gatherContext(instance.sessionId, 5);

  const wrapper = document.createElement('div');
  wrapper.className = 'ai-empty-state';

  // Initial render with empty hints — the context header doesn't
  // need project detection, so it can show immediately.
  const headerHost = document.createElement('div');
  headerHost.className = 'ai-empty-header-host';
  headerHost.appendChild(buildContextHeader(instance.sessionId, EMPTY_HINTS));
  wrapper.appendChild(headerHost);

  wrapper.appendChild(buildGreeting());

  const promptsHost = document.createElement('div');
  promptsHost.className = 'ai-empty-prompts-host';
  wrapper.appendChild(promptsHost);

  // Tip row placeholder — filled in after project hints resolve so
  // the tip context has accurate hasGit / hasProject flags.
  const tipHost = document.createElement('div');
  tipHost.className = 'ai-empty-tip-host';
  wrapper.appendChild(tipHost);

  container.appendChild(wrapper);

  // Phase 2: async project hint detection + pills + tip.
  detectProjectHints(ctx.cwd, ctx.isSSH)
    .then((hints) => {
      // If the empty state was removed while we were probing
      // (user sent a message), bail out silently.
      if (!wrapper.isConnected) return;

      // Refresh the context header now that we know the git branch.
      headerHost.innerHTML = '';
      headerHost.appendChild(buildContextHeader(instance.sessionId, hints));

      // Populate quick prompts.
      const panelW = panel.offsetWidth || window.innerWidth * 0.5;
      const slots = slotCountForWidth(panelW);
      const pool = buildQuickPromptPool(ctx.recentOutput, ctx.isSSH, hints);
      const picked = pool.slice(0, slots);

      promptsHost.innerHTML = '';
      promptsHost.appendChild(buildQuickPromptsRow(picked, (text) => {
        // Remove ourselves immediately so the click feels instant —
        // the caller's onSend will append a user message right after.
        removeEmptyState(container);
        onSend(text);
      }));

      // Now that we know the project shape, pick a smart tip that
      // matches the actual environment (hook status, layout, git, etc.).
      const mt = TerminalRegistry.get(instance.sessionId);
      const tipCtx = buildTipContext(
        ctx,
        hints,
        instance.layoutMode,
        !!mt?.shellState.hookInjected,
      );
      tipHost.innerHTML = '';
      tipHost.appendChild(buildTipRow(tipCtx));
    })
    .catch(() => { /* ignore — empty prompts is a fine fallback */ });
}

/** Remove any empty-state block from the given messages container. */
export function removeEmptyState(container: HTMLElement): void {
  container.querySelector('.ai-empty-state')?.remove();
}
