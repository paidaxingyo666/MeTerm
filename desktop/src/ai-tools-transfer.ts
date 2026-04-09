// ─── AI Tools: File Transfer via native SFTP ───────────────────
// Two tools — `upload_file` (local → remote) and `download_file`
// (remote → local) — that delegate to the app's existing SFTP
// pipeline (commands/transfer.rs / file-transfer-control.ts).
//
// IMPORTANT: this is a thin adapter, NOT a reimplementation.
//
// The previous version of this file rolled its own chunked-base64-
// over-PTY transfer protocol. That was wasted work: the app already
// has a production SFTP link with its own dedicated SSH connection
// (64 MB window, separate from the terminal PTY), progress events,
// pause/resume/cancel signals, 1 MB chunking, and no size cap. We
// now just invoke:
//
//   start_session_file_upload    (Rust tauri command)
//   start_session_file_download  (Rust tauri command)
//
// via the Tauri IPC Channel, wrap the lifecycle in a Promise the
// agent awaits, and surface progress as lines in the tool result.
// Because the transfer goes over SFTP — not the shell PTY — there
// is NO need to hold the per-session PTY lock, and the transfer
// does not fight with run_command / type_text for control of the
// terminal. It also works when the shell is running a TUI or waiting
// on a prompt.

import { invoke, Channel } from '@tauri-apps/api/core';
import {
  ToolHandler,
  ToolContext,
  resolvePaneTarget,
} from './ai-tools-core';
import { DrawerManager } from './drawer';

// ─── Event types (mirror the Rust enums) ────────────────────────

type SessionDownloadEvent =
  | { kind: 'started';   transferId: number; totalSize: number }
  | { kind: 'progress';  transferId: number; written: number; totalSize: number }
  | { kind: 'completed'; transferId: number; totalSize: number; savePath: string }
  | { kind: 'failed';    transferId: number; message: string }
  | { kind: 'cancelled'; transferId: number };

type SessionUploadEvent =
  | { kind: 'started';   transferId: number; totalSize: number }
  | { kind: 'progress';  transferId: number; written: number; totalSize: number }
  | { kind: 'completed'; transferId: number; totalSize: number; remotePath: string }
  | { kind: 'failed';    transferId: number; message: string }
  | { kind: 'cancelled'; transferId: number };

// ─── Helpers ────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m ${rem.toFixed(0)}s`;
}

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

/** Allocate a numeric transfer id. The SFTP layer requires a non-zero
 *  u32 distinct per in-flight transfer on a given session. We salt
 *  with Math.random so concurrent uploads/downloads (even from the
 *  same agent run) don't collide. */
function allocTransferId(): number {
  // 31-bit non-zero positive integer; the Rust side is a u32 but the
  // TS number type is safer when constrained to 31 bits.
  return 1 + Math.floor(Math.random() * 0x7fff_fffe);
}

// ─── Transfer drivers ──────────────────────────────────────────

interface TransferProgress {
  lastWritten: number;
  total: number;
  startedAt: number;
}

/**
 * Kick off an SFTP upload and resolve when it completes (or rejects
 * on failure/cancel). Progress events are collected but not streamed
 * anywhere — the agent wants a single "done" signal plus a final
 * summary line. The UI already has its own transfer progress panel
 * that will show live progress for any user-visible upload, but the
 * agent path currently runs "headless" from the chat capsule.
 */
function runSftpUpload(
  sessionId: string,
  localPath: string,
  remotePath: string,
): Promise<{ bytes: number; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const transferId = allocTransferId();
    const progress: TransferProgress = {
      lastWritten: 0,
      total: 0,
      startedAt: Date.now(),
    };
    let settled = false;

    const channel = new Channel<SessionUploadEvent>();
    channel.onmessage = (event) => {
      if (settled) return;
      switch (event.kind) {
        case 'started':
          progress.total = Number(event.totalSize ?? 0);
          progress.startedAt = Date.now();
          break;
        case 'progress':
          progress.lastWritten = Number(event.written ?? 0);
          progress.total = Number(event.totalSize ?? progress.total);
          break;
        case 'completed':
          settled = true;
          resolve({
            bytes: Number(event.totalSize ?? progress.lastWritten),
            durationMs: Date.now() - progress.startedAt,
          });
          break;
        case 'failed':
          settled = true;
          reject(new Error(event.message || 'upload failed'));
          break;
        case 'cancelled':
          settled = true;
          reject(new Error('upload cancelled'));
          break;
      }
    };

    invoke('start_session_file_upload', {
      sessionId,
      localPath,
      remotePath,
      transferId,
      onEvent: channel,
    }).catch((err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(fmtError(err)));
    });
  });
}

function runSftpDownload(
  sessionId: string,
  remotePath: string,
  savePath: string,
): Promise<{ bytes: number; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const transferId = allocTransferId();
    const progress: TransferProgress = {
      lastWritten: 0,
      total: 0,
      startedAt: Date.now(),
    };
    let settled = false;

    const channel = new Channel<SessionDownloadEvent>();
    channel.onmessage = (event) => {
      if (settled) return;
      switch (event.kind) {
        case 'started':
          progress.total = Number(event.totalSize ?? 0);
          progress.startedAt = Date.now();
          break;
        case 'progress':
          progress.lastWritten = Number(event.written ?? 0);
          progress.total = Number(event.totalSize ?? progress.total);
          break;
        case 'completed':
          settled = true;
          resolve({
            bytes: Number(event.totalSize ?? progress.lastWritten),
            durationMs: Date.now() - progress.startedAt,
          });
          break;
        case 'failed':
          settled = true;
          reject(new Error(event.message || 'download failed'));
          break;
        case 'cancelled':
          settled = true;
          reject(new Error('download cancelled'));
          break;
      }
    };

    invoke('start_session_file_download', {
      sessionId,
      remotePath,
      savePath,
      transferId,
      offset: 0,
      onEvent: channel,
    }).catch((err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(fmtError(err)));
    });
  });
}

// ─── Local → Local fallback (same box, no SFTP involved) ───────

async function localCopy(
  sourcePath: string,
  destPath: string,
): Promise<{ bytes: number; durationMs: number }> {
  const startedAt = Date.now();
  const bytes = await invoke<number>('agent_copy_local_file', {
    sourcePath,
    destPath,
  });
  return { bytes: Number(bytes ?? 0), durationMs: Date.now() - startedAt };
}

// ─── upload_file ────────────────────────────────────────────────

export function createUploadFileTool(): ToolHandler {
  return {
    definition: {
      name: 'upload_file',
      description:
        'Upload a file from the local machine to a remote SSH server (or to another local path) via the app\'s native SFTP pipeline. Binary-safe, streaming, no size cap — the transfer uses a dedicated SFTP connection with a 64 MB SSH window and goes through the exact same code path as the file manager UI, so it handles large files (gigabytes), resumable writes, and progress tracking. ' +
        'Use this whenever you need to ship source code, configuration, compiled binaries, or archives onto a server. ' +
        'For directory uploads, upload a .tar.gz / .zip archive and extract it on the remote side with run_command. ' +
        'The target SSH session is determined by the target pane: either the run\'s default target or whichever pane the user passed via `pane: <N>`.',
      parameters: {
        type: 'object',
        properties: {
          local_path: {
            type: 'string',
            description: 'Absolute or ~/-prefixed path on the LOCAL host machine.',
          },
          remote_path: {
            type: 'string',
            description: 'Destination path. Absolute path on the target SSH server, or a second local path when the target pane is a local shell.',
          },
          pane: {
            type: 'number',
            description: 'Optional 1-based pane number to target a non-default pane (useful when multiple SSH sessions are open in the same tab).',
          },
        },
        required: ['local_path', 'remote_path'],
      },
    },
    isConcurrencySafe: false,
    requiresConfirm: () => true,
    isDestructive: () => false,

    async execute(args, ctx: ToolContext): Promise<string> {
      const localPath = String(args.local_path ?? '').trim();
      const remotePath = String(args.remote_path ?? '').trim();
      if (!localPath || !remotePath) {
        return 'Error: upload_file requires non-empty "local_path" and "remote_path".';
      }
      const target = resolvePaneTarget(ctx, args.pane);
      if (!target.ok) return `Error: ${target.error}`;
      const pane = target.pane;

      // Local → Local: use the Rust bytes commands directly. No SFTP
      // involved because there is no remote endpoint.
      if (!pane.isSSH) {
        try {
          const { bytes, durationMs } = await localCopy(localPath, remotePath);
          return `Local copy: ${localPath} → ${remotePath} (${fmtBytes(bytes)} in ${fmtDuration(durationMs)}).`;
        } catch (e) {
          return `Error copying file: ${fmtError(e)}`;
        }
      }

      // SSH: delegate to the native SFTP pipeline. The pane's
      // sessionId is the SSH session id used by the file manager —
      // DrawerManager.getServerInfo confirms it's registered.
      const info = DrawerManager.getServerInfo(pane.sessionId);
      if (!info) {
        return `Error: pane ${pane.paneNumber} has no registered SSH session.`;
      }
      try {
        const { bytes, durationMs } = await runSftpUpload(pane.sessionId, localPath, remotePath);
        const speed = durationMs > 0
          ? `${fmtBytes(Math.round((bytes * 1000) / durationMs))}/s`
          : '—';
        return `Uploaded via SFTP: ${localPath} → ${pane.serverInfo}:${remotePath}\n` +
          `  size=${fmtBytes(bytes)}  time=${fmtDuration(durationMs)}  speed=${speed}`;
      } catch (e) {
        return `Upload failed: ${fmtError(e)}`;
      }
    },
  };
}

// ─── download_file ──────────────────────────────────────────────

export function createDownloadFileTool(): ToolHandler {
  return {
    definition: {
      name: 'download_file',
      description:
        'Download a file from a remote SSH server (or another local path) to the LOCAL machine via the app\'s native SFTP pipeline. Binary-safe, streaming, no size cap — uses the same dedicated SFTP connection the file manager UI uses. ' +
        'Use this to pull logs, build artifacts, generated configs, or database dumps back to the host for inspection. For directories, have the remote side tar/zip them first with run_command, then download the archive.',
      parameters: {
        type: 'object',
        properties: {
          remote_path: {
            type: 'string',
            description: 'Source path on the target pane. Absolute path on the SSH server when the pane is an SSH session; otherwise treated as a second local path.',
          },
          local_path: {
            type: 'string',
            description: 'Destination path on the LOCAL host machine. Parent directories are created as needed.',
          },
          pane: {
            type: 'number',
            description: 'Optional 1-based pane number to target a non-default pane.',
          },
        },
        required: ['remote_path', 'local_path'],
      },
    },
    isConcurrencySafe: false,
    requiresConfirm: () => true,
    isDestructive: () => false,

    async execute(args, ctx: ToolContext): Promise<string> {
      const remotePath = String(args.remote_path ?? '').trim();
      const localPath = String(args.local_path ?? '').trim();
      if (!remotePath || !localPath) {
        return 'Error: download_file requires non-empty "remote_path" and "local_path".';
      }
      const target = resolvePaneTarget(ctx, args.pane);
      if (!target.ok) return `Error: ${target.error}`;
      const pane = target.pane;

      if (!pane.isSSH) {
        try {
          const { bytes, durationMs } = await localCopy(remotePath, localPath);
          return `Local copy: ${remotePath} → ${localPath} (${fmtBytes(bytes)} in ${fmtDuration(durationMs)}).`;
        } catch (e) {
          return `Error copying file: ${fmtError(e)}`;
        }
      }

      const info = DrawerManager.getServerInfo(pane.sessionId);
      if (!info) {
        return `Error: pane ${pane.paneNumber} has no registered SSH session.`;
      }
      try {
        const { bytes, durationMs } = await runSftpDownload(pane.sessionId, remotePath, localPath);
        const speed = durationMs > 0
          ? `${fmtBytes(Math.round((bytes * 1000) / durationMs))}/s`
          : '—';
        return `Downloaded via SFTP: ${pane.serverInfo}:${remotePath} → ${localPath}\n` +
          `  size=${fmtBytes(bytes)}  time=${fmtDuration(durationMs)}  speed=${speed}`;
      } catch (e) {
        return `Download failed: ${fmtError(e)}`;
      }
    },
  };
}
