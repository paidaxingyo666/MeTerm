// ─── AI Tools: File Operations ──────────────────────────────────
// read_file, write_file — supports both local and SSH remote paths.
//
// Local files go through dedicated Rust commands (`agent_read_file`,
// `agent_write_file`) that use std::fs directly. We DO NOT use the
// `@tauri-apps/plugin-fs` API for the agent because that plugin is
// scoped to AppData via `fs:scope-appdata-recursive`, which would
// reject any path outside the app data directory with a confusing
// "path not allowed in scope" error (which manifested as "undefined"
// when the TS catch block tried to read `.message` off the rejection
// value, since Tauri's plugin sometimes throws strings instead of
// Error objects).
//
// Remote (SSH) files go through the existing `executeViaTerminal`
// path which runs `head` / `cat <<EOF` over the live PTY.

import { invoke } from '@tauri-apps/api/core';
import { ToolHandler } from './ai-tools-core';
import { executeViaTerminal } from './ai-tools-shell';

interface AgentReadResult {
  content: string | null;
  size: number;
  is_binary: boolean;
  too_large: boolean;
}

/** Format any thrown value into a human-readable error message. */
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

// ─── read_file ──────────────────────────────────────────────────

export function createReadFileTool(): ToolHandler {
  return {
    definition: {
      name: 'read_file',
      description:
        'Read the content of a file at the given path. Supports absolute paths, ~/-prefixed paths, and (on local sessions) Windows drive paths. For SSH sessions the read goes through the remote shell via `head`.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or ~/-prefixed file path' },
          maxLines: {
            type: 'number',
            description: 'Maximum number of lines to read (default: 200)',
            default: 200,
          },
        },
        required: ['path'],
      },
    },
    // read_file only reads → safe to parallelize across multiple files.
    isConcurrencySafe: true,
    requiresConfirm: () => false,
    isDestructive: () => false,

    async execute(args, ctx): Promise<string> {
      const path = String(args.path ?? '').trim();
      if (!path) {
        return 'Error: read_file requires a non-empty "path" argument.';
      }
      const maxLines = (args.maxLines as number) || 200;

      if (ctx.isSSH) {
        // SSH: read via terminal command. Single-quote the path to
        // prevent shell expansion of $ / `, but escape embedded
        // single quotes correctly.
        const safePath = path.replace(/'/g, `'\\''`);
        const cmd = `head -n ${maxLines} '${safePath}' 2>&1`;
        try {
          return await executeViaTerminal(ctx.sessionId, cmd, 15, ctx.shellType);
        } catch (e) {
          return `Error reading file: ${fmtError(e)}`;
        }
      }

      // Local: invoke the Rust command (bypasses Tauri fs scope).
      try {
        const result = await invoke<AgentReadResult>('agent_read_file', {
          path,
          // 10 MB cap matches the previous behavior.
          maxBytes: 10 * 1024 * 1024,
        });

        if (result.too_large) {
          return `File too large (${(result.size / 1024 / 1024).toFixed(1)} MB). Use run_command with head/tail/grep to read specific parts.`;
        }
        if (result.is_binary) {
          return `This appears to be a binary file (${result.size} bytes). Cannot display content. Use run_command with xxd / file / strings to inspect.`;
        }
        const content = result.content ?? '';
        const lines = content.split('\n');
        if (lines.length > maxLines) {
          return (
            lines.slice(0, maxLines).join('\n') +
            `\n\n--- Showing first ${maxLines} of ${lines.length} lines (${result.size} bytes total). ` +
            `Use the maxLines parameter, or run_command with sed/awk, to read other ranges. ---`
          );
        }
        return content;
      } catch (e) {
        return `Error reading file: ${fmtError(e)}`;
      }
    },
  };
}

// ─── write_file ─────────────────────────────────────────────────

export function createWriteFileTool(): ToolHandler {
  return {
    definition: {
      name: 'write_file',
      description:
        'Write content to a file at the given path. If the file exists it will be overwritten. Parent directories are created automatically. Supports absolute paths and ~/-prefixed paths. For SSH sessions the write goes through the remote shell via a heredoc.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or ~/-prefixed file path' },
          content: { type: 'string', description: 'Content to write (UTF-8)' },
        },
        required: ['path', 'content'],
      },
    },
    // write_file mutates filesystem → never concurrent.
    isConcurrencySafe: false,
    // Level 1: write_file always needs confirmation
    requiresConfirm: () => true,
    // Level 2: write_file does NOT need confirmation (user chose full-auto)
    isDestructive: () => false,

    async execute(args, ctx): Promise<string> {
      const filePath = String(args.path ?? '').trim();
      if (!filePath) {
        return 'Error: write_file requires a non-empty "path" argument.';
      }
      const content = typeof args.content === 'string' ? args.content : '';

      // Size guard
      if (content.length > 100 * 1024) {
        return `Content too large (${(content.length / 1024).toFixed(1)} KB). Break into smaller files or use run_command to write.`;
      }

      if (ctx.isSSH) {
        // SSH: write via heredoc. Single-quote the EOF marker to
        // disable expansion inside the body, and single-quote the
        // path to handle $ / spaces / etc.
        const eofMarker = `METERM_EOF_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
        const safePath = filePath.replace(/'/g, `'\\''`);
        const dirCmd = `mkdir -p "$(dirname '${safePath}')"`;
        const writeCmd = `${dirCmd} && cat > '${safePath}' << '${eofMarker}'\n${content}\n${eofMarker}`;
        try {
          const result = await executeViaTerminal(ctx.sessionId, writeCmd, 15, ctx.shellType);
          // Heuristic error sniff — anything containing the word
          // "denied" or matching common error keywords on the LAST
          // non-empty line is treated as failure (avoids false
          // positives from filenames that contain "error").
          const lastLine = result.trim().split('\n').filter(Boolean).pop() ?? '';
          if (/permission denied|no such file|cannot create|read-only file system|operation not permitted/i.test(lastLine)) {
            return `Error writing file: ${lastLine}`;
          }
          return `File written successfully: ${filePath} (${content.length} bytes)`;
        } catch (e) {
          return `Error writing file: ${fmtError(e)}`;
        }
      }

      // Local: invoke the Rust command (bypasses Tauri fs scope).
      try {
        const written = await invoke<number>('agent_write_file', {
          path: filePath,
          content,
        });
        return `File written successfully: ${filePath} (${written} bytes)`;
      } catch (e) {
        return `Error writing file: ${fmtError(e)}`;
      }
    },
  };
}
