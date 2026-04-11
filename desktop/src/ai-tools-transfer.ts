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

// Event types MUST match Rust's serde field names (snake_case).
// Rust: #[serde(tag = "kind", rename_all = "snake_case")] only
// affects the tag value; struct fields stay snake_case as-is.
type SessionDownloadEvent =
  | { kind: 'started';   transfer_id: number; total_size: number }
  | { kind: 'progress';  transfer_id: number; written: number; total_size: number }
  | { kind: 'completed'; transfer_id: number; total_size: number; save_path: string }
  | { kind: 'failed';    transfer_id: number; message: string }
  | { kind: 'cancelled'; transfer_id: number };

type SessionUploadEvent =
  | { kind: 'started';   transfer_id: number; total_size: number }
  | { kind: 'progress';  transfer_id: number; written: number; total_size: number }
  | { kind: 'completed'; transfer_id: number; total_size: number; remote_path: string }
  | { kind: 'failed';    transfer_id: number; message: string }
  | { kind: 'cancelled'; transfer_id: number };

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

/**
 * Fire a DOM event so the tool-card UI can update its progress bar.
 * The event carries the tool name + current bytes / total / percent.
 * Throttled to at most 5 Hz to avoid hammering the DOM on fast links.
 */
/** Per-transfer throttle so concurrent uploads/downloads each get
 *  their own 5 Hz progress updates instead of starving each other. */
const _progressThrottles = new Map<number, number>();
function emitTransferProgress(
  toolName: string,
  info: {
    written: number;
    total: number;
    pct: number;
    sessionId: string;
    transferId: number;
  },
): void {
  const now = Date.now();
  const last = _progressThrottles.get(info.transferId) ?? 0;
  if (now - last < 200) return; // 5 Hz per transfer
  _progressThrottles.set(info.transferId, now);
  document.dispatchEvent(new CustomEvent('ai-transfer-progress', {
    detail: { toolName, ...info },
  }));
  // Prevent unbounded growth: clean up entries older than 10s
  if (_progressThrottles.size > 20) {
    for (const [tid, ts] of _progressThrottles) {
      if (now - ts > 10_000) _progressThrottles.delete(tid);
    }
  }
}

/** Allocate a numeric transfer id. The SFTP layer requires a non-zero
 *  u32 distinct per in-flight transfer on a given session. We salt
 *  with Math.random so concurrent uploads/downloads (even from the
 *  same agent run) don't collide. */
function allocTransferId(): number {
  return 1 + Math.floor(Math.random() * 0x7fff_fffe);
}

// ─── Agent transfer registry ────────────────────────────────────
// Maps file-manager recordId → { sessionId, transferId, type } so that
// the file manager's cancel/pause buttons can reach agent-initiated
// transfers (which are NOT registered in FileManager's ctx.activeUploads).

const agentActiveTransfers = new Map<string, {
  sessionId: string;
  transferId: number;
  type: 'upload' | 'download';
}>();

/**
 * Cancel an agent-initiated transfer. Called by FileManager.cancelTransfer
 * as a fallback when the record is not found in ctx.activeUploads/Downloads.
 */
export async function cancelAgentTransfer(recordId: string): Promise<boolean> {
  const entry = agentActiveTransfers.get(recordId);
  if (!entry) return false;
  try {
    const cmd = entry.type === 'upload'
      ? 'control_session_file_upload'
      : 'control_session_file_download';
    await invoke(cmd, {
      sessionId: entry.sessionId,
      transferId: entry.transferId,
      signal: 'cancel',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Cancel ALL active agent-initiated transfers. Called when the user
 * aborts the agent run (stop button) to ensure SFTP transfers don't
 * keep running in the background after the agent loop exits.
 */
export async function cancelAllAgentTransfers(): Promise<void> {
  const entries = [...agentActiveTransfers.entries()];
  for (const [rid, entry] of entries) {
    try {
      const cmd = entry.type === 'upload'
        ? 'control_session_file_upload'
        : 'control_session_file_download';
      await invoke(cmd, {
        sessionId: entry.sessionId,
        transferId: entry.transferId,
        signal: 'cancel',
      });
    } catch { /* best effort */ }
    agentActiveTransfers.delete(rid);
  }
}
// ─── Transfer drivers ──────────────────────────────────────────

/** Callback fired by the transfer drivers on every progress tick.
 *  The chat tool-card UI subscribes to this to render a live progress
 *  bar inside the tool card. */
export type TransferProgressCallback = (info: {
  written: number;
  total: number;
  /** 0-100 (capped at 99.9 during transfer, 100 on completion). */
  pct: number;
  sessionId: string;
  transferId: number;
}) => void;

/**
 * Stall-detection timeout: only trigger if ZERO bytes have been
 * received for 60 consecutive seconds. As long as data keeps
 * flowing (any speed), we wait indefinitely.
 */
const STALL_TIMEOUT_MS = 60_000;

class StallDetector {
  private lastWritten = 0;
  private lastActiveAt = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private _stalled = false;
  onStall?: () => void;

  start(): void {
    this.lastActiveAt = Date.now();
    this.timer = setInterval(() => {
      if (Date.now() - this.lastActiveAt >= STALL_TIMEOUT_MS) {
        this._stalled = true;
        this.stop();
        this.onStall?.();
      }
    }, 5_000); // check every 5s
  }

  /** Call on every progress event. Resets the stall clock if bytes moved. */
  tick(written: number): void {
    if (written > this.lastWritten) {
      this.lastWritten = written;
      this.lastActiveAt = Date.now();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get stalled(): boolean { return this._stalled; }
}

/**
 * Try to obtain a FileManager for the given session so we can register
 * the transfer in the file manager's transfer list. Returns null when
 * no drawer / file-manager has been opened for this session (local
 * shell, or the user hasn't opened the file drawer on this SSH session).
 * The caller treats null as "skip transfer-list sync" — not an error.
 */
function getFileManager(sessionId: string) {
  return DrawerManager.getFileManager(sessionId);
}

function runSftpUpload(
  sessionId: string,
  localPath: string,
  remotePath: string,
  onProgress?: TransferProgressCallback,
): Promise<{ bytes: number; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const transferId = allocTransferId();
    let total = 0;
    let written = 0;
    let startedAt = Date.now();
    let settled = false;

    const fm = getFileManager(sessionId);
    let recordId: string | null = null;
    const filename = localPath.split(/[/\\]/).pop() || 'upload';

    // Stall detection: reject only if 0 bytes flow for 60 consecutive seconds.
    const stall = new StallDetector();
    stall.onStall = () => {
      if (settled) return;
      settled = true;
      stall.stop();
      if (fm && recordId) fm.reportTransferProgress(recordId, 0, 'failed', 'Transfer stalled (no data for 60s)');
      reject(new Error('Upload stalled — zero bytes transferred for 60 consecutive seconds.'));
    };

    const settle = () => {
      settled = true;
      stall.stop();
      clearTimeout(initTimeout);
      if (recordId) agentActiveTransfers.delete(recordId);
      _progressThrottles.delete(transferId);
    };

    // Pre-register the transfer record BEFORE invoke() so that even
    // if the Rust command rejects synchronously (SFTP not ready,
    // session not found), the file-manager UI still shows the failure.
    if (fm) {
      recordId = fm.registerTransfer('upload', filename, remotePath, 0);
      agentActiveTransfers.set(recordId, { sessionId, transferId, type: 'upload' });
    }

    // Safety net: if we never receive a 'started' event (Rust side
    // panic, SFTP channel silently died), fail after 120s so the
    // record doesn't stay pending forever (H4 regression fix).
    const initTimeout = setTimeout(() => {
      if (settled) return;
      settle();
      if (fm && recordId) fm.reportTransferProgress(recordId, 0, 'failed', 'Transfer initialization timed out');
      reject(new Error('Upload initialization timed out — no response from SFTP backend within 120s.'));
    }, 120_000);

    const channel = new Channel<SessionUploadEvent>();
    channel.onmessage = (event) => {
      if (settled) return;
      switch (event.kind) {
        case 'started':
          total = Number(event.total_size ?? 0);
          startedAt = Date.now();
          stall.start();
          // Update the pre-registered record with actual size
          if (fm && recordId && total > 0) {
            fm.reportTransferSize(recordId, total);
          }
          break;
        case 'progress': {
          written = Number(event.written ?? 0);
          const newTotal = Number(event.total_size ?? total);
          // If the backend reports a more accurate total, update both
          // our local state and the file-manager record.
          if (newTotal > 0 && newTotal !== total) {
            total = newTotal;
            if (fm && recordId) fm.reportTransferSize(recordId, total);
          }
          total = newTotal || total;
          stall.tick(written);
          const pct = total > 0 ? Math.min((written / total) * 100, 99.9) : 0;
          onProgress?.({ written, total, pct, sessionId, transferId });
          if (fm && recordId) {
            fm.reportTransferProgress(recordId, pct, 'inprogress');
          }
          break;
        }
        case 'completed':
          settle();
          if (fm && recordId) fm.reportTransferProgress(recordId, 100, 'completed');
          // Refresh file manager / sidebar (same event the normal upload path uses)
          window.dispatchEvent(new CustomEvent('meterm-file-op-done', { detail: { sessionId } }));
          resolve({ bytes: Number(event.total_size ?? written), durationMs: Date.now() - startedAt });
          break;
        case 'failed':
          settle();
          if (fm && recordId) fm.reportTransferProgress(recordId, 0, 'failed', event.message);
          reject(new Error(event.message || 'upload failed'));
          break;
        case 'cancelled':
          settle();
          if (fm && recordId) fm.reportTransferProgress(recordId, 0, 'cancelled');
          reject(new Error('Upload cancelled by user. Do NOT retry — the user intentionally stopped this transfer. Ask the user what to do next.'));
          break;
      }
    };

    invoke('start_session_file_upload', {
      sessionId, localPath, remotePath, transferId, onEvent: channel,
    }).catch((err) => {
      if (settled) return;
      settle();
      if (fm && recordId) fm.reportTransferProgress(recordId, 0, 'failed', fmtError(err));
      reject(err instanceof Error ? err : new Error(fmtError(err)));
    });
  });
}

function runSftpDownload(
  sessionId: string,
  remotePath: string,
  savePath: string,
  onProgress?: TransferProgressCallback,
): Promise<{ bytes: number; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const transferId = allocTransferId();
    let total = 0;
    let written = 0;
    let startedAt = Date.now();
    let settled = false;

    const fm = getFileManager(sessionId);
    let recordId: string | null = null;
    const filename = remotePath.split(/[/\\]/).pop() || 'download';

    const stall = new StallDetector();
    stall.onStall = () => {
      if (settled) return;
      settled = true;
      stall.stop();
      if (fm && recordId) fm.reportTransferProgress(recordId, 0, 'failed', 'Transfer stalled (no data for 60s)');
      reject(new Error('Download stalled — zero bytes transferred for 60 consecutive seconds.'));
    };

    const settle = () => {
      settled = true;
      stall.stop();
      clearTimeout(initTimeout);
      if (recordId) agentActiveTransfers.delete(recordId);
      _progressThrottles.delete(transferId);
    };

    // Pre-register before invoke (same rationale as upload)
    if (fm) {
      recordId = fm.registerTransfer('download', filename, remotePath, 0, savePath);
      agentActiveTransfers.set(recordId, { sessionId, transferId, type: 'download' });
    }

    // Safety net for silent Rust-side failure (same as upload)
    const initTimeout = setTimeout(() => {
      if (settled) return;
      settle();
      if (fm && recordId) fm.reportTransferProgress(recordId, 0, 'failed', 'Transfer initialization timed out');
      reject(new Error('Download initialization timed out — no response from SFTP backend within 120s.'));
    }, 120_000);

    const channel = new Channel<SessionDownloadEvent>();
    channel.onmessage = (event) => {
      if (settled) return;
      switch (event.kind) {
        case 'started':
          total = Number(event.total_size ?? 0);
          startedAt = Date.now();
          stall.start();
          if (fm && recordId && total > 0) {
            fm.reportTransferSize(recordId, total);
          }
          break;
        case 'progress': {
          written = Number(event.written ?? 0);
          const newTotal = Number(event.total_size ?? total);
          if (newTotal > 0 && newTotal !== total) {
            total = newTotal;
            if (fm && recordId) fm.reportTransferSize(recordId, total);
          }
          total = newTotal || total;
          stall.tick(written);
          const pct = total > 0 ? Math.min((written / total) * 100, 99.9) : 0;
          onProgress?.({ written, total, pct, sessionId, transferId });
          if (fm && recordId) {
            fm.reportTransferProgress(recordId, pct, 'inprogress');
          }
          break;
        }
        case 'completed':
          settle();
          if (fm && recordId) fm.reportTransferProgress(recordId, 100, 'completed');
          resolve({ bytes: Number(event.total_size ?? written), durationMs: Date.now() - startedAt });
          break;
        case 'failed':
          settle();
          if (fm && recordId) fm.reportTransferProgress(recordId, 0, 'failed', event.message);
          reject(new Error(event.message || 'download failed'));
          break;
        case 'cancelled':
          settle();
          if (fm && recordId) fm.reportTransferProgress(recordId, 0, 'cancelled');
          reject(new Error('Download cancelled by user. Do NOT retry — the user intentionally stopped this transfer. Ask the user what to do next.'));
          break;
      }
    };

    invoke('start_session_file_download', {
      sessionId, remotePath, savePath, transferId, offset: 0, onEvent: channel,
    }).catch((err) => {
      if (settled) return;
      settle();
      if (fm && recordId) fm.reportTransferProgress(recordId, 0, 'failed', fmtError(err));
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
        'Upload a file from the local machine to a remote SSH server (or to another local path) via the app\'s native SFTP pipeline. Binary-safe, streaming, no size cap. ' +
        'CONFLICT HANDLING: if the remote file already exists, the tool returns a CONFLICT error instead of uploading. You must then either (a) call upload_file again with overwrite=true to replace it, or (b) change remote_path to a different name. Never silently overwrite — always let the user see the conflict first. ' +
        'For directory uploads, upload a .tar.gz / .zip archive and extract it on the remote side with run_command. ' +
        'The target SSH session is determined by the target pane.',
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
          overwrite: {
            type: 'boolean',
            description: 'Set to true to overwrite an existing remote file. When false (default), upload_file returns a CONFLICT error if the remote file already exists, so you can decide whether to overwrite or rename.',
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

      // SSH: delegate to the native SFTP pipeline.
      const info = DrawerManager.getServerInfo(pane.sessionId);
      if (!info) {
        return `Error: pane ${pane.paneNumber} has no registered SSH session.`;
      }

      // Pre-check: stat the remote path via SFTP. If the file already
      // exists, STOP and return a conflict report instead of uploading.
      // The LLM must explicitly pass overwrite=true to proceed.
      const overwrite = args.overwrite === true;
      try {
        const stat = await invoke<{ exists: boolean; size?: number; is_dir: boolean }>(
          'sftp_stat_remote',
          { sessionId: pane.sessionId, remotePath },
        );
        if (stat.exists && stat.is_dir) {
          return `Error: remote_path "${remotePath}" is a directory. Specify a file path, e.g. "${remotePath}/${localPath.split(/[/\\]/).pop() || 'file'}"`;
        }
        if (stat.exists && !overwrite) {
          const sizeInfo = stat.size != null ? ` (${fmtBytes(Number(stat.size))})` : '';
          return `CONFLICT: remote file "${remotePath}"${sizeInfo} already exists on ${pane.serverInfo}.\n` +
            'To overwrite, call upload_file again with overwrite=true.\n' +
            'To keep both, change remote_path to a different name.';
        }
      } catch {
        // stat failed (SFTP not ready, permission, etc.) — proceed anyway
      }

      try {
        const { bytes, durationMs } = await runSftpUpload(
          pane.sessionId, localPath, remotePath,
          (pi) => emitTransferProgress('upload_file', pi),
        );
        const speed = durationMs > 0
          ? `${fmtBytes(Math.round((bytes * 1000) / durationMs))}/s`
          : '—';
        const overwriteNote = overwrite
          ? '\n  Note: existing file was overwritten (overwrite=true).'
          : '';
        return `Uploaded via SFTP: ${localPath} → ${pane.serverInfo}:${remotePath}\n` +
          `  size=${fmtBytes(bytes)}  time=${fmtDuration(durationMs)}  speed=${speed}${overwriteNote}`;
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
        'Download a file from a remote SSH server (or another local path) to the LOCAL machine via the app\'s native SFTP pipeline. Binary-safe, streaming, no size cap. ' +
        'CONFLICT HANDLING: if the local file already exists, the tool returns a CONFLICT error instead of downloading. You must then either (a) call download_file again with overwrite=true to replace it, or (b) change local_path to a different name. ' +
        'For directories, have the remote side tar/zip them first with run_command, then download the archive.',
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
          overwrite: {
            type: 'boolean',
            description: 'Set to true to overwrite an existing local file. When false (default), download_file returns a CONFLICT error if the local file already exists.',
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
      const overwrite = args.overwrite === true;
      const target = resolvePaneTarget(ctx, args.pane);
      if (!target.ok) return `Error: ${target.error}`;
      const pane = target.pane;

      // Pre-check: local destination file conflict
      if (!overwrite) {
        try {
          const statResult = await invoke<string>('stat_path', { path: localPath });
          if (statResult === 'file') {
            return `CONFLICT: local file "${localPath}" already exists.\n` +
              'To overwrite, call download_file again with overwrite=true.\n' +
              'To keep both, change local_path to a different name.';
          }
          if (statResult === 'dir') {
            const filename = remotePath.split(/[/\\]/).pop() || 'download';
            return `Error: local_path "${localPath}" is a directory. Specify a file path, e.g. "${localPath}/${filename}"`;
          }
        } catch {
          // stat_path failed — proceed anyway
        }
      }

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
        const { bytes, durationMs } = await runSftpDownload(
          pane.sessionId, remotePath, localPath,
          (di) => emitTransferProgress('download_file', di),
        );
        const speed = durationMs > 0
          ? `${fmtBytes(Math.round((bytes * 1000) / durationMs))}/s`
          : '—';
        const overwriteNote = overwrite
          ? '\n  Note: existing local file was overwritten (overwrite=true).'
          : '';
        return `Downloaded via SFTP: ${pane.serverInfo}:${remotePath} → ${localPath}\n` +
          `  size=${fmtBytes(bytes)}  time=${fmtDuration(durationMs)}  speed=${speed}${overwriteNote}`;
      } catch (e) {
        return `Download failed: ${fmtError(e)}`;
      }
    },
  };
}
