// ─── AI Capsule: Generic File Attachment Helpers ──────────────
// Companion to ai-capsule-image-attach.ts, for NON-IMAGE attachments
// (source archives, configs, binaries, any file type). Images still
// ride the multimodal content path via the existing image helper —
// generic files go through this module, are saved to disk, and are
// surfaced to the agent via their absolute path rather than their
// bytes.
//
// Flow:
//   1. User drops / picks a file
//   2. We read bytes into memory (for now, up to 500 MB — files
//      larger than that should really go straight to SFTP, not via
//      the capsule)
//   3. Invoke Rust `agent_save_attachment` which writes it into
//      `<app-data>/attachments/<ts-rand-name>` and returns the abs path
//   4. Push an AttachedFile record onto instance.pendingAttachments
//   5. Render a chip strip above the AI bar
//   6. On send: the agent's system prompt includes a "User attached
//      these files:" block listing each path so the model can feed
//      them into upload_file / read_file / run_command

import { invoke } from '@tauri-apps/api/core';
import type { AttachedFile, AICapsuleInstance } from './ai-capsule-types';
import { showToast } from './notify';

/** Hard upper bound for drag-dropped files. We need to hold the
 *  entire file in JS memory as a number[] for the Tauri IPC call,
 *  which costs ~8x the file size in heap. 50 MB → ~400 MB heap,
 *  which is acceptable. For larger files, tell the user to provide
 *  a local path and use upload_file directly. */
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB

/** Max number of attachments queued simultaneously. */
const MAX_ATTACHMENTS = 16;

// Image MIME types that are handled by ai-capsule-image-attach.ts —
// we deliberately DO NOT intercept these so the multimodal image
// path keeps working. Any non-image file falls through to here.
const IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export function isImageFile(f: File): boolean {
  return IMAGE_MIMES.has(f.type);
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

interface RustAttachmentInfo {
  path: string;
  size: number;
}

/**
 * Persist a File blob to the app's attachments directory via the
 * Rust command. Returns the absolute path + size. Propagates errors
 * to the caller.
 */
async function saveBlobAsAttachment(blob: Blob, name: string): Promise<RustAttachmentInfo> {
  if (blob.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`file is ${fmtBytes(blob.size)}, exceeds the ${fmtBytes(MAX_ATTACHMENT_BYTES)} attachment cap`);
  }
  const buf = await blob.arrayBuffer();
  // Tauri expects Vec<u8>; send as a regular number array (webview
  // encodes the typed array into JSON well enough).
  const bytes = Array.from(new Uint8Array(buf));
  return invoke<RustAttachmentInfo>('agent_save_attachment', {
    name,
    bytes,
  });
}

/**
 * Public entry: take a File, validate it, persist it, and queue it on
 * the capsule instance. Returns true on success. Every rejection path
 * shows a toast to the user so failures are never silent.
 */
export async function attachFileToInstance(
  instance: AICapsuleInstance,
  file: File,
): Promise<boolean> {
  // ── Route images to the dedicated multimodal path ──
  if (isImageFile(file)) return false;

  const name = file.name || 'attachment';

  // ── Pending count cap ──
  if (instance.pendingAttachments.length >= MAX_ATTACHMENTS) {
    showToast({
      title: 'Attachment limit',
      body: `Maximum ${MAX_ATTACHMENTS} files can be queued at once. Remove an existing attachment first.`,
    });
    return false;
  }

  // ── Empty file ──
  if (file.size === 0) {
    showToast({ title: 'Empty file', body: `"${name}" is empty (0 bytes) and cannot be attached.` });
    return false;
  }

  // ── Size cap ──
  if (file.size > MAX_ATTACHMENT_BYTES) {
    showToast({
      title: 'File too large',
      body: `"${name}" is ${fmtBytes(file.size)}, exceeds the ${fmtBytes(MAX_ATTACHMENT_BYTES)} cap.\nUse the file manager or scp to transfer large files directly.`,
    });
    return false;
  }

  // ── Duplicate detection (same name + same size already queued) ──
  const isDuplicate = instance.pendingAttachments.some(
    (a) => a.name === name && a.size === file.size,
  );
  if (isDuplicate) {
    showToast({ title: 'Duplicate file', body: `"${name}" (${fmtBytes(file.size)}) is already queued.` });
    return false;
  }

  // ── Persist ──
  try {
    const info = await saveBlobAsAttachment(file, name);
    const entry: AttachedFile = {
      name,
      path: info.path,
      size: Number(info.size ?? file.size ?? 0),
      mimeType: file.type || 'application/octet-stream',
      at: Date.now(),
    };
    instance.pendingAttachments.push(entry);
    renderAttachmentStrip(instance);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast({ title: 'Attachment failed', body: `Could not save "${name}": ${msg}` });
    return false;
  }
}

/**
 * Open a system file picker that accepts ANY file type. For each
 * chosen file we inspect its extension and route it to the proper
 * pipeline:
 *   • Image extensions → pendingImages (multimodal content)
 *   • Anything else    → pendingAttachments (saved on disk, surfaced
 *                        to the agent by absolute path)
 *
 * This gives users a single "attach" entry point that handles both
 * screenshots and source archives without a separate button.
 *
 * Returns the total count of successfully attached items (images +
 * files combined).
 */
export async function pickAttachmentFiles(
  instance: AICapsuleInstance,
): Promise<number> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    // Use the same pattern as file-manager.ts — `directory: false` +
    // NO `filters` field at all. This reliably shows "All Files" on
    // every platform Tauri supports. Passing `filters: undefined` or
    // `filters: []` can cause the dialog to inherit the previous
    // call's filter on some Tauri versions.
    const selection = await open({ multiple: true, directory: false });
    if (!selection) return 0;
    const paths = Array.isArray(selection) ? selection : [selection];

    // Lazy-import the image helper to avoid a circular import cycle.
    const { blobToAttachedImage, addPendingImage } = await import('./ai-capsule-image-attach');

    const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
    let attached = 0;
    for (const p of paths) {
      const fileName = String(p).split(/[/\\]/).pop() || 'attachment';
      const ext = fileName.toLowerCase().split('.').pop() || '';
      const isImage = IMAGE_EXTS.has(ext);

      // ── Pre-flight: stat via Rust to catch dirs / missing / 0-byte
      // files BEFORE we read bytes into memory. agent_read_file_bytes
      // does its own stat, but by calling a cheap stat first we can
      // show a specific toast instead of a generic "read failed".
      try {
        const statResult = await invoke<string>('stat_path', { path: String(p) });
        if (statResult === 'dir') {
          showToast({ title: 'Cannot attach directory', body: `"${fileName}" is a directory. Compress it first (zip/tar.gz) then attach the archive.` });
          continue;
        }
        if (statResult === 'none') {
          showToast({ title: 'File not found', body: `"${fileName}" does not exist or is inaccessible.` });
          continue;
        }
      } catch { /* stat_path unavailable — proceed, let read fail */ }

      try {
        const cap = isImage ? 5 * 1024 * 1024 : MAX_ATTACHMENT_BYTES;
        const bytes = await invoke<number[]>('agent_read_file_bytes', {
          path: String(p),
          maxBytes: cap,
        });
        const u8 = new Uint8Array(bytes);

        // ── Empty file guard ──
        if (u8.length === 0) {
          showToast({ title: 'Empty file', body: `"${fileName}" is empty (0 bytes) and cannot be attached.` });
          continue;
        }

        // ── Duplicate guard ──
        if (!isImage) {
          const isDup = instance.pendingAttachments.some(
            (a) => a.name === fileName && a.size === u8.length,
          );
          if (isDup) {
            showToast({ title: 'Duplicate file', body: `"${fileName}" (${fmtBytes(u8.length)}) is already queued.` });
            continue;
          }
        }

        if (isImage) {
          const mediaType = (
            ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
            ext === 'webp' ? 'image/webp' :
            ext === 'gif' ? 'image/gif' :
            'image/png'
          ) as ('image/png' | 'image/jpeg' | 'image/webp' | 'image/gif');
          const blob = new Blob([u8], { type: mediaType });
          const img = await blobToAttachedImage(blob, fileName);
          if (img) {
            addPendingImage(instance, img);
            attached++;
          }
          continue;
        }

        // ── Non-image: save to disk and queue as generic attachment ──
        const blob = new Blob([u8]);
        const info = await saveBlobAsAttachment(blob, fileName);
        const entry: AttachedFile = {
          name: fileName,
          path: info.path,
          size: Number(info.size ?? blob.size ?? 0),
          mimeType: 'application/octet-stream',
          at: Date.now(),
        };
        instance.pendingAttachments.push(entry);
        attached++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        showToast({ title: 'Attachment failed', body: `"${fileName}": ${msg}` });
      }
    }
    if (attached > 0) renderAttachmentStrip(instance);
    return attached;
  } catch {
    return 0;
  }
}

/** Remove a pending attachment by index, also deleting the on-disk copy. */
export function removePendingAttachment(
  instance: AICapsuleInstance,
  index: number,
): void {
  const entry = instance.pendingAttachments[index];
  if (!entry) return;
  instance.pendingAttachments.splice(index, 1);
  // Best-effort on-disk cleanup.
  void invoke('agent_delete_attachment', { path: entry.path }).catch(() => {/* ignore */});
  renderAttachmentStrip(instance);
}

/**
 * Clear all pending attachments (called on send or conversation reset).
 * Note: on SEND we keep the attachments on disk so upload_file can
 * still read them; cleanup happens via agent.clear() which wipes the
 * conversation.
 *
 * `deleteFiles=true` will also unlink the on-disk copies.
 */
export function clearPendingAttachments(
  instance: AICapsuleInstance,
  deleteFiles: boolean = false,
): void {
  // Don't delete on-disk files while the agent is actively running —
  // it may be reading/uploading them right now. The files will be
  // cleaned up on the next clear() when the agent is idle.
  if (deleteFiles && !instance.isStreaming) {
    for (const entry of instance.pendingAttachments) {
      void invoke('agent_delete_attachment', { path: entry.path }).catch(() => {/* ignore */});
    }
  }
  instance.pendingAttachments = [];
  renderAttachmentStrip(instance);
}

// ─── Rendering ──────────────────────────────────────────────────

/**
 * Where to render the attachment strip. We piggyback on the same
 * container strategy as the image strip but use a distinct DOM class
 * so both can coexist (images + files can be attached together).
 */
function pickStripContainer(instance: AICapsuleInstance): HTMLElement | null {
  const sideActive = instance.layoutMode === 'side'
    && !!instance.sideInputArea
    && !!instance.sideInputArea.parentElement;
  if (sideActive) return instance.sideInputArea;
  return instance.element;
}

function removeAllAttachmentStrips(instance: AICapsuleInstance): void {
  const surfaces: Array<HTMLElement | null> = [instance.element, instance.sideInputArea];
  for (const s of surfaces) {
    if (!s) continue;
    const old = s.querySelector(':scope > .ai-pending-attachments');
    if (old) old.remove();
  }
}

export function renderAttachmentStrip(instance: AICapsuleInstance): void {
  removeAllAttachmentStrips(instance);
  if (instance.pendingAttachments.length === 0) return;
  const container = pickStripContainer(instance);
  if (!container) return;

  const strip = document.createElement('div');
  strip.className = 'ai-pending-attachments';
  // Anchor above the input row, but below the image strip if any.
  const imageStrip = container.querySelector(':scope > .ai-pending-images');
  if (imageStrip && imageStrip.nextSibling) {
    container.insertBefore(strip, imageStrip.nextSibling);
  } else if (imageStrip) {
    container.appendChild(strip);
  } else {
    container.insertBefore(strip, container.firstChild);
  }

  instance.pendingAttachments.forEach((att, idx) => {
    const chip = document.createElement('div');
    chip.className = 'ai-pending-attachment-chip';
    chip.title = `${att.name} (${fmtBytes(att.size)})\n${att.path}`;

    const icon = document.createElement('span');
    icon.className = 'ai-pending-attachment-icon';
    icon.innerHTML = paperclipSvg();
    chip.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'ai-pending-attachment-label';
    label.textContent = att.name;
    chip.appendChild(label);

    const size = document.createElement('span');
    size.className = 'ai-pending-attachment-size';
    size.textContent = fmtBytes(att.size);
    chip.appendChild(size);

    const close = document.createElement('button');
    close.className = 'ai-pending-attachment-remove';
    close.type = 'button';
    close.innerHTML = '&times;';
    close.title = 'Remove attachment';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      removePendingAttachment(instance, idx);
    });
    chip.appendChild(close);

    strip.appendChild(chip);
  });
}

function paperclipSvg(): string {
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M10.5 4.5L5.5 9.5a2 2 0 002.83 2.83L13.5 7.16a3.5 3.5 0 00-4.95-4.95L3 7.76a5 5 0 007.07 7.07L14 10.9"
      stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

// ─── Drop-handler integration ──────────────────────────────────
//
// The existing image drop handler in ai-capsule-image-attach.ts only
// accepts image MIME types. We expose a helper that accepts any file
// so the caller (capsule wiring) can route non-image drops here.

export async function handleFileDrop(
  instance: AICapsuleInstance,
  files: File[],
): Promise<{ imagesDropped: File[]; attachmentsAttached: number }> {
  const imagesDropped: File[] = [];
  let attachmentsAttached = 0;
  for (const f of files) {
    if (isImageFile(f)) {
      imagesDropped.push(f);
      continue;
    }
    if (await attachFileToInstance(instance, f)) {
      attachmentsAttached++;
    }
  }
  return { imagesDropped, attachmentsAttached };
}
