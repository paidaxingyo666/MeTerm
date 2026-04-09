// ─── AI Agent: Audit Log ───────────────────────────────────
// Subscribes to the in-process hook system and appends one JSON
// line per significant event to the app's data directory.
//
// Intended for post-hoc debugging and security review.  Keeps
// dependencies minimal: only Tauri fs plugin, no external libs.
// Call installAuditLog() once during app startup.
//
// We write into BaseDirectory.AppData (the directory already allowed
// by `fs:scope-appdata-recursive`) so we don't need extra Tauri
// capabilities.  On macOS this resolves to
//   ~/Library/Application Support/com.meterm.app/agent-audit.jsonl

import {
  BaseDirectory,
  writeTextFile,
  exists,
} from '@tauri-apps/plugin-fs';
import { appDataDir, join } from '@tauri-apps/api/path';
import { hooks } from './ai-hooks';

/** File name relative to AppData. */
const AUDIT_FILE = 'agent-audit.jsonl';

interface AuditEntry {
  ts: string;
  sessionId: string;
  kind: 'prompt' | 'tool' | 'session_start' | 'session_end' | 'compact';
  [k: string]: unknown;
}

async function append(entry: AuditEntry): Promise<void> {
  try {
    const line = JSON.stringify(entry) + '\n';
    // Tauri plugin-fs writeTextFile with append flag — AppData dir
    // is auto-created by the plugin on first write.
    await writeTextFile(AUDIT_FILE, line, {
      baseDir: BaseDirectory.AppData,
      append: true,
    });
  } catch {
    // Ignore filesystem failures — audit log is best effort.
  }
}

/**
 * Install the audit-log hook handlers. Idempotent:
 * calling twice is a no-op because the second call's unsubscribes
 * are never returned, but users shouldn't call this twice anyway.
 */
let installed = false;

export function installAuditLog(): void {
  if (installed) return;
  installed = true;

  hooks.onSessionStart(({ sessionId }) => {
    void append({
      ts: new Date().toISOString(),
      sessionId,
      kind: 'session_start',
    });
  });

  hooks.onUserPromptSubmit(({ sessionId, prompt }) => {
    void append({
      ts: new Date().toISOString(),
      sessionId,
      kind: 'prompt',
      // Clip very long prompts to keep the file readable.
      prompt: prompt.length > 2_000 ? prompt.slice(0, 2_000) + '...(truncated)' : prompt,
    });
  });

  hooks.onPostToolUse(({ sessionId, toolName, callId, args, isError, durationMs }) => {
    // type_text / press_keys may write secrets to the PTY (the
    // user's response to a prompt, even if not literally a
    // password). Redact the actual payload — we only log the
    // length / shape so an auditor can see "something was sent"
    // without exposing the contents.
    let safeArgs: Record<string, unknown>;
    if (toolName === 'type_text' && typeof args.text === 'string') {
      safeArgs = { text: `<redacted ${(args.text as string).length} chars>` };
    } else if (toolName === 'press_keys') {
      // Key tokens are not secrets, but we still pass through clipArgs
      // for size protection.
      safeArgs = clipArgs(args);
    } else {
      safeArgs = clipArgs(args);
    }
    void append({
      ts: new Date().toISOString(),
      sessionId,
      kind: 'tool',
      tool: toolName,
      callId,
      args: safeArgs,
      isError,
      durationMs,
    });
  });

  hooks.onPreCompact(({ sessionId, reason, beforeMessageCount }) => {
    void append({
      ts: new Date().toISOString(),
      sessionId,
      kind: 'compact',
      reason,
      beforeMessageCount,
    });
  });

  hooks.onSessionEnd(({ sessionId, reason }) => {
    void append({
      ts: new Date().toISOString(),
      sessionId,
      kind: 'session_end',
      reason,
    });
  });
}

function clipArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 500) {
      out[k] = v.slice(0, 500) + `...(${v.length} chars)`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─── External viewer helper ───────────────────────────────

/**
 * Return the absolute path to the audit log file, creating an empty
 * file first if it does not yet exist. Used by the settings UI to
 * hand the path off to the OS default text editor via plugin-opener.
 */
export async function getAuditLogPath(): Promise<string> {
  const present = await exists(AUDIT_FILE, { baseDir: BaseDirectory.AppData });
  if (!present) {
    await writeTextFile(AUDIT_FILE, '', { baseDir: BaseDirectory.AppData });
  }
  const dir = await appDataDir();
  return await join(dir, AUDIT_FILE);
}
