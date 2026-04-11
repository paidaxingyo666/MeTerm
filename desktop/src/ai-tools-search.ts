// ─── AI Tools: Filesystem Search & Listing ─────────────────────
// Three structured tools the agent uses to discover code without
// shelling out to ls/find/grep:
//
//   • list_directory  — entries in a single directory (name, kind, size)
//   • glob_search     — files matching a glob pattern (e.g. "**/*.ts")
//   • grep_search     — content search across many files (line + match)
//
// Each tool routes to a Rust command for LOCAL paths and falls back
// to the equivalent shell pipeline for SSH paths. The shell fallback
// is dumber but it lets the agent operate on a remote box without
// needing the host's filesystem cache. Output sizes are bounded so
// the LLM context stays sane.

import { invoke } from '@tauri-apps/api/core';
import {
  ToolHandler,
  ToolContext,
  resolvePaneTarget,
  escapeShellSingle,
  truncateOutput,
  TOKEN_BUDGET,
} from './ai-tools-core';
import { executeViaTerminal } from './ai-tools-shell';

// ─── Shared helpers ─────────────────────────────────────────────

function fmtError(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string') return m;
    try { return JSON.stringify(e); } catch { return String(e); }
  }
  return String(e);
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ─── list_directory ─────────────────────────────────────────────

interface AgentDirEntry {
  name: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
  /** Modification time as a unix epoch in seconds. */
  mtime: number;
}

interface AgentDirListing {
  path: string;
  entries: AgentDirEntry[];
  truncated: boolean;
}

export function createListDirectoryTool(): ToolHandler {
  return {
    definition: {
      name: 'list_directory',
      description:
        'List the immediate contents of a directory as a structured table (name, kind, size, mtime). Use this instead of run_command("ls …") whenever you need an inventory — the parsed output is more reliable than scraping ls. Supports both local and SSH paths via the target pane.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or ~/-prefixed directory path.' },
          show_hidden: { type: 'boolean', description: 'Include dotfiles. Default: false.' },
          max_entries: { type: 'number', description: 'Cap on the number of entries returned. Default: 200.' },
          pane: { type: 'number', description: 'Optional pane override (defaults to the run\'s target pane).' },
        },
        required: ['path'],
      },
    },
    isConcurrencySafe: true,
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx: ToolContext): Promise<string> {
      const path = String(args.path ?? '').trim();
      if (!path) return 'Error: list_directory requires a "path" argument.';
      const showHidden = args.show_hidden === true;
      const maxEntries = Math.min(Math.max(Number(args.max_entries) || 200, 1), 2000);
      const target = resolvePaneTarget(ctx, args.pane);
      if (!target.ok) return `Error: ${target.error}`;
      const pane = target.pane;

      if (!pane.isSSH) {
        // Local: structured listing via Rust.
        try {
          const result = await invoke<AgentDirListing>('agent_list_directory', {
            path,
            showHidden,
            maxEntries,
          });
          return formatListing(result);
        } catch (e) {
          return `Error listing directory: ${fmtError(e)}`;
        }
      }

      // SSH: best-effort `ls` fallback. We use a parseable -1A printf
      // form so the output is unambiguous regardless of locale.
      const safe = escapeShellSingle(path);
      const flagA = showHidden ? '-A' : '';
      // Format: %y kind char | %s size | %Y mtime | %f name
      // GNU stat. macOS stat uses different flags so we fall back to
      // a portable awk pipeline if the GNU form fails.
      const cmd = `if command -v stat >/dev/null 2>&1 && stat --version >/dev/null 2>&1; then \
find '${safe}' -mindepth 1 -maxdepth 1 ${flagA ? '' : '! -name ".*"'} -printf '%y\\t%s\\t%T@\\t%f\\n' 2>/dev/null | head -n ${maxEntries}; \
else \
ls -l1 ${showHidden ? '-A' : ''} '${safe}' 2>/dev/null | awk 'NR>1 && $0!="" {kind="-"; if (substr($1,1,1)=="d") kind="d"; else if (substr($1,1,1)=="l") kind="l"; print kind"\\t"$5"\\t0\\t"$NF}' | head -n ${maxEntries}; \
fi`;
      try {
        const out = await executeViaTerminal(pane.sessionId, cmd, 20, pane.shellType);
        const entries: AgentDirEntry[] = [];
        for (const line of out.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const parts = trimmed.split('\t');
          if (parts.length < 4) continue;
          const k = parts[0];
          const kind: AgentDirEntry['kind'] =
            k === 'd' ? 'dir' : k === 'l' ? 'symlink' : k === 'f' || k === '-' ? 'file' : 'other';
          entries.push({
            kind,
            size: parseInt(parts[1], 10) || 0,
            mtime: Math.floor(parseFloat(parts[2]) || 0),
            name: parts.slice(3).join('\t'),
          });
        }
        return formatListing({
          path,
          entries,
          truncated: entries.length >= maxEntries,
        });
      } catch (e) {
        return `Error listing directory (SSH): ${fmtError(e)}`;
      }
    },
  };
}

function formatListing(r: AgentDirListing): string {
  if (r.entries.length === 0) {
    return `(empty) ${r.path}`;
  }
  const lines: string[] = [];
  lines.push(`Directory: ${r.path}  (${r.entries.length} entries${r.truncated ? ', truncated' : ''})`);
  // Sort: dirs first, then files, alphabetical inside each.
  const sorted = [...r.entries].sort((a, b) => {
    if (a.kind === 'dir' && b.kind !== 'dir') return -1;
    if (a.kind !== 'dir' && b.kind === 'dir') return 1;
    return a.name.localeCompare(b.name);
  });
  for (const e of sorted) {
    const tag =
      e.kind === 'dir' ? 'dir '
      : e.kind === 'symlink' ? 'link'
      : e.kind === 'file' ? 'file'
      : 'misc';
    const sizeCol = e.kind === 'dir' ? '       ' : fmtSize(e.size).padStart(8);
    lines.push(`  ${tag}  ${sizeCol}  ${e.name}`);
  }
  return truncateOutput(lines.join('\n'), TOKEN_BUDGET.perToolOutputChars);
}

// ─── glob_search ────────────────────────────────────────────────

interface GlobMatch {
  path: string;
  is_dir: boolean;
}

export function createGlobSearchTool(): ToolHandler {
  return {
    definition: {
      name: 'glob_search',
      description:
        'Find files (and directories) whose path matches a glob pattern. Supports `*`, `**`, `?` and brace expansion ({a,b}). The pattern is rooted at `cwd` (defaults to the agent\'s working directory). Use this when you need to locate files by name across a project tree without scanning the whole filesystem.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob expression, e.g. "**/*.{ts,tsx}" or "src/**/main.go".' },
          cwd: { type: 'string', description: 'Optional starting directory. Defaults to the pane\'s current cwd.' },
          max_results: { type: 'number', description: 'Cap on the number of paths returned. Default: 200.' },
          pane: { type: 'number', description: 'Optional pane override.' },
        },
        required: ['pattern'],
      },
    },
    isConcurrencySafe: true,
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx: ToolContext): Promise<string> {
      const pattern = String(args.pattern ?? '').trim();
      if (!pattern) return 'Error: glob_search requires a "pattern" argument.';
      const maxResults = Math.min(Math.max(Number(args.max_results) || 200, 1), 2000);
      const target = resolvePaneTarget(ctx, args.pane);
      if (!target.ok) return `Error: ${target.error}`;
      const pane = target.pane;
      const cwd = String(args.cwd ?? '').trim() || pane.cwd || '.';

      if (!pane.isSSH) {
        try {
          const matches = await invoke<GlobMatch[]>('agent_glob_search', {
            pattern,
            cwd,
            maxResults,
          });
          return formatGlobMatches(matches, pattern, cwd, matches.length >= maxResults);
        } catch (e) {
          return `Error during glob search: ${fmtError(e)}`;
        }
      }

      // SSH fallback: shellcheck-friendly find with -path. We rewrite
      // the user-supplied glob to a `-name` / `-path` argument.
      const safeCwd = escapeShellSingle(cwd);
      // For ** patterns we drop the leading ** and let -path do the work.
      const findExpr = pattern.includes('/')
        ? `-path '${escapeShellSingle('*' + pattern)}'`
        : `-name '${escapeShellSingle(pattern)}'`;
      const cmd = `find '${safeCwd}' ${findExpr} -print 2>/dev/null | head -n ${maxResults}`;
      try {
        const out = await executeViaTerminal(pane.sessionId, cmd, 30, pane.shellType);
        const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
        const matches: GlobMatch[] = lines.map((p) => ({ path: p, is_dir: false }));
        return formatGlobMatches(matches, pattern, cwd, matches.length >= maxResults);
      } catch (e) {
        return `Error during glob search (SSH): ${fmtError(e)}`;
      }
    },
  };
}

function formatGlobMatches(
  matches: GlobMatch[],
  pattern: string,
  cwd: string,
  truncated: boolean,
): string {
  if (matches.length === 0) {
    return `No matches for "${pattern}" under ${cwd}.`;
  }
  const lines: string[] = [];
  lines.push(`Glob matches for "${pattern}" under ${cwd}: ${matches.length}${truncated ? ' (truncated)' : ''}`);
  for (const m of matches) {
    lines.push(`  ${m.is_dir ? 'D' : 'F'}  ${m.path}`);
  }
  return truncateOutput(lines.join('\n'), TOKEN_BUDGET.perToolOutputChars);
}

// ─── grep_search ────────────────────────────────────────────────

interface GrepHit {
  path: string;
  line: number;
  text: string;
}

interface GrepResult {
  hits: GrepHit[];
  files_scanned: number;
  truncated: boolean;
}

export function createGrepSearchTool(): ToolHandler {
  return {
    definition: {
      name: 'grep_search',
      description:
        'Search file contents for a regular expression across a directory tree. Returns up to `max_hits` matching lines as `path:line:text`. Use this to locate code by feature/identifier rather than by filename. Skips binary files and the usual junk dirs (.git, node_modules, target, dist, build, .next).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for. Use POSIX-style ERE on SSH and Rust regex syntax locally.' },
          path: { type: 'string', description: 'Root directory to search. Defaults to the pane\'s cwd.' },
          glob: { type: 'string', description: 'Optional glob filter restricting which files are scanned (e.g. "*.ts").' },
          case_insensitive: { type: 'boolean', description: 'Default: false.' },
          max_hits: { type: 'number', description: 'Cap on the number of match lines returned. Default: 100.' },
          pane: { type: 'number', description: 'Optional pane override.' },
        },
        required: ['pattern'],
      },
    },
    isConcurrencySafe: true,
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx: ToolContext): Promise<string> {
      const pattern = String(args.pattern ?? '').trim();
      if (!pattern) return 'Error: grep_search requires a "pattern" argument.';
      const target = resolvePaneTarget(ctx, args.pane);
      if (!target.ok) return `Error: ${target.error}`;
      const pane = target.pane;
      const root = String(args.path ?? '').trim() || pane.cwd || '.';
      const glob = typeof args.glob === 'string' ? args.glob.trim() : '';
      const caseInsensitive = args.case_insensitive === true;
      const maxHits = Math.min(Math.max(Number(args.max_hits) || 100, 1), 1000);

      if (!pane.isSSH) {
        try {
          const result = await invoke<GrepResult>('agent_grep_search', {
            pattern,
            path: root,
            glob: glob || null,
            caseInsensitive,
            maxHits,
          });
          return formatGrepResult(result, pattern, root);
        } catch (e) {
          return `Error during grep search: ${fmtError(e)}`;
        }
      }

      // SSH fallback: grep -RnE with --include and prune dirs.
      const safeRoot = escapeShellSingle(root);
      const safePat = escapeShellSingle(pattern);
      const ci = caseInsensitive ? '-i' : '';
      const includeArg = glob ? `--include='${escapeShellSingle(glob)}'` : '';
      const excludeDirs = `--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=target --exclude-dir=dist --exclude-dir=build --exclude-dir=.next`;
      const cmd = `grep -RnE ${ci} ${includeArg} ${excludeDirs} '${safePat}' '${safeRoot}' 2>/dev/null | head -n ${maxHits}`;
      try {
        const out = await executeViaTerminal(pane.sessionId, cmd, 60, pane.shellType);
        const hits: GrepHit[] = [];
        for (const raw of out.split('\n')) {
          const line = raw.trimEnd();
          if (!line) continue;
          // Format from grep: <path>:<line>:<text>
          const m = line.match(/^([^:]+):(\d+):(.*)$/);
          if (!m) continue;
          hits.push({ path: m[1], line: parseInt(m[2], 10) || 0, text: m[3] });
        }
        return formatGrepResult({ hits, files_scanned: -1, truncated: hits.length >= maxHits }, pattern, root);
      } catch (e) {
        return `Error during grep search (SSH): ${fmtError(e)}`;
      }
    },
  };
}

function formatGrepResult(r: GrepResult, pattern: string, root: string): string {
  if (r.hits.length === 0) {
    return `No matches for /${pattern}/ under ${root}.`;
  }
  const lines: string[] = [];
  const scannedNote = r.files_scanned >= 0 ? ` (scanned ${r.files_scanned} files)` : '';
  lines.push(`Grep matches for /${pattern}/ under ${root}: ${r.hits.length}${r.truncated ? ' (truncated)' : ''}${scannedNote}`);
  for (const h of r.hits) {
    const text = h.text.length > 200 ? h.text.slice(0, 200) + '…' : h.text;
    lines.push(`  ${h.path}:${h.line}: ${text}`);
  }
  return truncateOutput(lines.join('\n'), TOKEN_BUDGET.perToolOutputChars);
}
