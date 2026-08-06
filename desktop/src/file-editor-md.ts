/**
 * file-editor-md.ts — Markdown renderer and image-type helpers for the built-in editor.
 */

// ── Image helpers ─────────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico',
  'tiff', 'tif', 'avif', 'heic', 'heif',
]);

const MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon', tiff: 'image/tiff', tif: 'image/tiff',
  avif: 'image/avif', heic: 'image/heic', heif: 'image/heif',
};

export function getFileExt(fileName: string): string {
  return (fileName.split('.').pop() || '').toLowerCase();
}

export function isImageFile(fileName: string): boolean {
  return IMAGE_EXTS.has(getFileExt(fileName));
}

export function getImageMimeType(fileName: string): string {
  return MIME_MAP[getFileExt(fileName)] || 'application/octet-stream';
}

/** Convert raw binary Uint8Array to base64 string (chunked to avoid stack overflow). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Decode exactly the one escaping pass applied before Markdown matching. */
function decodeEscapedMarkdownUrl(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function sanitizeMarkdownUrl(
  encodedValue: string,
  allowImageData = false,
  allowRemote = true,
): string | null {
  const value = decodeEscapedMarkdownUrl(encodedValue).trim();
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return null;

  if (allowImageData && /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif);base64,[A-Za-z0-9+/=]+$/i.test(value)) {
    return value;
  }
  if (!allowRemote) return null;

  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Render inline markdown (bold, italic, code, links, images). */
function renderInline(raw: string): string {
  // Escape HTML first, then re-apply markdown
  let s = escHtml(raw);
  // Inline code (process before bold/italic to avoid interference)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold + italic
  s = s.replace(/\*{3}(.+?)\*{3}/g, '<strong><em>$1</em></strong>');
  s = s.replace(/_{3}(.+?)_{3}/g, '<strong><em>$1</em></strong>');
  // Bold
  s = s.replace(/\*{2}(.+?)\*{2}/g, '<strong>$1</strong>');
  s = s.replace(/_{2}(.+?)_{2}/g, '<strong>$1</strong>');
  // Italic
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/_(.+?)_/g, '<em>$1</em>');
  // Strikethrough
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  // Images (must come before links)
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt: string, encodedUrl: string) => {
    // Remote images disclose the viewer's IP and can be used as tracking
    // beacons. Preview only first-party raster data URLs created in memory.
    const safeUrl = sanitizeMarkdownUrl(encodedUrl, true, false);
    return safeUrl ? `<img alt="${alt}" src="${escHtml(safeUrl)}">` : alt;
  });
  // Links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, encodedUrl: string) => {
    const safeUrl = sanitizeMarkdownUrl(encodedUrl);
    return safeUrl
      ? `<a href="${escHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : label;
  });
  // Auto-links (bare URLs not already inside an href/src)
  s = s.replace(/(?<![="'])https?:\/\/[^\s<>"]+/g, (encodedUrl) => {
    const safeUrl = sanitizeMarkdownUrl(encodedUrl);
    return safeUrl
      ? `<a href="${escHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">${encodedUrl}</a>`
      : encodedUrl;
  });
  return s;
}

/** Parse a GFM table row into cell strings. */
function parseTableRow(line: string): string[] {
  return line
    .replace(/^\|/, '').replace(/\|$/, '')
    .split('|')
    .map(c => c.trim());
}

/**
 * Render a Markdown string to an HTML string.
 * Supports: headings, bold/italic/strikethrough, inline code, fenced code blocks,
 * links, images, unordered/ordered/task lists, blockquotes, GFM tables, hr.
 */
export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];

  let i = 0;
  let inCode = false;
  let codeLines: string[] = [];
  let codeLang = '';
  let inList = false;
  let listTag = '';
  let inTable = false;
  let tableHasBody = false;
  let paraLines: string[] = [];

  const flushPara = () => {
    if (paraLines.length === 0) return;
    out.push(`<p>${renderInline(paraLines.join('<br>'))}</p>`);
    paraLines = [];
  };

  const flushList = () => {
    if (!inList) return;
    out.push(`</${listTag}>`);
    inList = false;
    listTag = '';
  };

  const flushTable = () => {
    if (!inTable) return;
    if (tableHasBody) out.push('</tbody>');
    out.push('</table>');
    inTable = false;
    tableHasBody = false;
  };

  while (i < lines.length) {
    const line = lines[i];

    // ── Fenced code block ──────────────────────────────────────────
    const fenceMatch = line.match(/^(`{3,}|~{3,})(.*)/);
    if (fenceMatch || inCode) {
      if (!inCode) {
        flushPara(); flushList(); flushTable();
        inCode = true;
        codeLang = fenceMatch![2].trim();
        i++;
        continue;
      }
      // End fence
      if (fenceMatch) {
        const langClass = codeLang ? ` class="language-${escHtml(codeLang)}"` : '';
        out.push(`<pre><code${langClass}>${codeLines.map(escHtml).join('\n')}</code></pre>`);
        inCode = false; codeLines = []; codeLang = '';
        i++;
        continue;
      }
      codeLines.push(line);
      i++;
      continue;
    }

    // ── Heading ────────────────────────────────────────────────────
    const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      flushPara(); flushList(); flushTable();
      const lvl = hMatch[1].length;
      out.push(`<h${lvl}>${renderInline(hMatch[2])}</h${lvl}>`);
      i++; continue;
    }

    // ── Horizontal rule ───────────────────────────────────────────
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      flushPara(); flushList(); flushTable();
      out.push('<hr>');
      i++; continue;
    }

    // ── Blockquote ────────────────────────────────────────────────
    if (line.startsWith('>')) {
      flushPara(); flushList(); flushTable();
      const content = line.replace(/^>\s?/, '');
      out.push(`<blockquote><p>${renderInline(content)}</p></blockquote>`);
      i++; continue;
    }

    // ── Unordered list ────────────────────────────────────────────
    const ulMatch = line.match(/^(\s*)[*\-+]\s+(.*)/);
    if (ulMatch) {
      flushPara(); flushTable();
      if (!inList || listTag !== 'ul') { flushList(); out.push('<ul>'); inList = true; listTag = 'ul'; }
      const taskMatch = ulMatch[2].match(/^\[([ xX])\]\s+(.*)/);
      if (taskMatch) {
        const checked = taskMatch[1].toLowerCase() === 'x' ? ' checked' : '';
        out.push(`<li class="task-item"><input type="checkbox"${checked} disabled> ${renderInline(taskMatch[2])}</li>`);
      } else {
        out.push(`<li>${renderInline(ulMatch[2])}</li>`);
      }
      i++; continue;
    }

    // ── Ordered list ──────────────────────────────────────────────
    const olMatch = line.match(/^\d+\.\s+(.*)/);
    if (olMatch) {
      flushPara(); flushTable();
      if (!inList || listTag !== 'ol') { flushList(); out.push('<ol>'); inList = true; listTag = 'ol'; }
      out.push(`<li>${renderInline(olMatch[1])}</li>`);
      i++; continue;
    }

    // ── GFM Table ─────────────────────────────────────────────────
    const isSep = /^[\|\-\s:]+$/.test(line) && line.includes('-');
    const isTableRow = line.includes('|');
    if (isTableRow && !isSep) {
      if (!inTable) {
        // Check next line is a separator
        const nextLine = lines[i + 1] || '';
        if (/^[\|\-\s:]+$/.test(nextLine) && nextLine.includes('-')) {
          flushPara(); flushList();
          inTable = true; tableHasBody = false;
          const headers = parseTableRow(line).map(h => `<th>${renderInline(h)}</th>`).join('');
          out.push(`<table><thead><tr>${headers}</tr></thead>`);
          i += 2; // skip header and separator
          continue;
        }
      } else {
        if (!tableHasBody) { out.push('<tbody>'); tableHasBody = true; }
        const cells = parseTableRow(line).map(c => `<td>${renderInline(c)}</td>`).join('');
        out.push(`<tr>${cells}</tr>`);
        i++; continue;
      }
    } else if (inTable && (isSep || !isTableRow)) {
      flushTable();
    }

    // ── Empty line ────────────────────────────────────────────────
    if (line.trim() === '') {
      flushPara(); flushList(); flushTable();
      i++; continue;
    }

    // ── List continuation ends non-list context ───────────────────
    if (inList) flushList();

    // ── Regular paragraph ─────────────────────────────────────────
    paraLines.push(line);
    i++;
  }

  flushPara();
  flushList();
  flushTable();
  if (inCode) {
    out.push(`<pre><code>${codeLines.map(escHtml).join('\n')}</code></pre>`);
  }

  return out.join('\n');
}
