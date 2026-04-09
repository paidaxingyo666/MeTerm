/**
 * Click-to-move-cursor + drag-select-to-edit in command area.
 *
 * Click: moves cursor to clicked position (Meta-digit + arrow key).
 * Drag in command area: creates editable selection with cursor-style highlight.
 *   - Cursor moves to drag-end, custom highlight overlay shown
 *   - Backspace/Delete: deletes selected text
 *   - Typing: replaces selected text
 *   - Cmd+X: cut
 *   - Other keys: clear selection, let through
 *
 * Drag outside command area: normal copy-only selection (xterm.js default).
 */

import { encodeMessage, MsgInput } from './protocol';
import { sendToTerminal } from './terminal-transport';
import type { ManagedTerminal } from './terminal-types';
import type { Terminal, IBufferLine } from '@xterm/xterm';
import { readText as clipboardReadText, writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';

// ---------------------------------------------------------------------------
// Editable selection state
// ---------------------------------------------------------------------------

interface EditableSelection {
  active: boolean;
  /** true = cursor at selection end (drag left→right), delete backward */
  forward: boolean;
  /** readline character count of the selection */
  charCount: number;
  /** selected text content (for copy/cut) */
  text: string;
  /** highlight overlay elements */
  overlays: HTMLElement[];
  /** Whether selection was created without shell hook (uses repeated arrows) */
  hookless: boolean;
}

// ---------------------------------------------------------------------------
// Main setup
// ---------------------------------------------------------------------------

export function setupClickToMoveCursor(mt: ManagedTerminal): void {
  const terminal = mt.terminal;
  const screenEl = mt.container.querySelector('.xterm-screen') as HTMLElement | null;
  if (!screenEl) return;

  let downX = 0;
  let downY = 0;
  let lastClickTime = 0;
  let mousedownFired = false; // guards against cross-pane mouseup in split-pane layouts
  const DEBOUNCE_MS = 150;

  const sel: EditableSelection = {
    active: false, forward: true, charCount: 0, text: '', overlays: [], hookless: false,
  };

  // ── Selection key handler: stored on mt, called by terminal-ime.ts ──
  (mt as any)._selectionKeyHandler = (ev: KeyboardEvent): boolean => {
    if (!sel.active) return true;
    if (ev.type !== 'keydown') return true;
    return handleSelectionKey(mt, terminal, sel, ev);
  };

  // ── Focus/blur: switch between solid inversion and hollow outline ──
  const onFocusChange = () => updateHighlightMode(sel, document.hasFocus());
  window.addEventListener('focus', onFocusChange);
  window.addEventListener('blur', onFocusChange);

  // ── Mouse handlers ──
  screenEl.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    downX = e.clientX;
    downY = e.clientY;
    mousedownFired = true;
    // Clear editable selection on any mousedown (new interaction starting)
    if (sel.active) clearSel(terminal, sel);
  }, { capture: false });

  screenEl.addEventListener('mouseup', (e: MouseEvent) => {
    if (e.button !== 0) return;
    // In split-pane layouts the user may mousedown on pane A and release on pane B.
    // Pane B's mouseup fires but its mousedown never did, so downX/downY are stale.
    // Guard: only process mouseup when this pane originated the current press.
    if (!mousedownFired) return;
    mousedownFired = false;

    const isDrag = Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4;

    if (isDrag) {
      handleDragSelect(mt, terminal, sel, screenEl, e, downX, downY);
      return;
    }

    // ── Click (not drag) ──
    if (terminal.hasSelection()) return; // native xterm selection from prior drag
    const hookless = !mt.shellState.hookInjected;
    if (!hookless && mt.shellState.phase !== 'ready') return;
    if (terminal.buffer.active.type !== 'normal') return;
    if (isMouseTrackingActive(terminal)) return;

    const now = Date.now();
    if (now - lastClickTime < DEBOUNCE_MS) return;
    lastClickTime = now;

    const { clickAbsRow, snappedClickCol, cursorAbsRow, cursorCol } =
      resolveClickPositions(terminal, screenEl, e);
    if (clickAbsRow < 0) return;

    let promptRow: number, promptCol: number;
    if (hookless) {
      // Heuristic: detect command area from cursor position
      const buf = terminal.buffer.active;
      const area = detectCommandArea(buf, cursorAbsRow);
      promptRow = area.startRow;
      const promptLine = buf.getLine(promptRow);
      promptCol = promptLine ? detectPromptCol(promptLine, terminal.cols) : 0;
      if (clickAbsRow > area.endRow) return;
    } else {
      ({ promptRow, promptCol } = mt.shellState);
    }
    if (promptRow < 0 || clickAbsRow < promptRow) return;
    // Clicked inside prompt text (before editable area) → ignore
    if (clickAbsRow === promptRow && snappedClickCol < promptCol) return;
    if (clickAbsRow === cursorAbsRow && snappedClickCol === cursorCol) return;

    const charCount = computeCharDistance(
      terminal.buffer.active, clickAbsRow, snappedClickCol, cursorAbsRow, cursorCol,
    );
    if (charCount === 0) return;

    const forward = clickAbsRow > cursorAbsRow
      || (clickAbsRow === cursorAbsRow && snappedClickCol > cursorCol);
    sendInput(mt, buildCursorMove(charCount, forward, hookless));
  }, { capture: false });
}

// ---------------------------------------------------------------------------
// Drag-select → editable selection in command area
// ---------------------------------------------------------------------------

function handleDragSelect(
  mt: ManagedTerminal,
  terminal: Terminal,
  sel: EditableSelection,
  screenEl: HTMLElement,
  upEvent: MouseEvent,
  mouseDownX: number, mouseDownY: number,
): void {
  const hookless = !mt.shellState.hookInjected;
  if (!hookless && mt.shellState.phase !== 'ready') return;
  if (terminal.buffer.active.type !== 'normal') return;
  if (isMouseTrackingActive(terminal)) return;
  if (!terminal.hasSelection()) return;

  const buf = terminal.buffer.active;
  const rect = screenEl.getBoundingClientRect();
  const dims = getCellDims(terminal, screenEl);
  const cellW = dims.w;
  const cellH = dims.h;
  const viewportY = getViewportY(terminal, buf.baseY);
  const cursorAbsRow = buf.baseY + buf.cursorY;
  const cursorCol = buf.cursorX;

  // Convert mousedown/mouseup to cell coordinates
  const downCol = clamp(Math.floor((mouseDownX - rect.left) / cellW), 0, terminal.cols - 1);
  const downRow = clamp(Math.floor((mouseDownY - rect.top) / cellH), 0, terminal.rows - 1);
  const downAbsRow = viewportY + downRow;

  const upCol = clamp(Math.floor((upEvent.clientX - rect.left) / cellW), 0, terminal.cols - 1);
  const upRow = clamp(Math.floor((upEvent.clientY - rect.top) / cellH), 0, terminal.rows - 1);
  const upAbsRow = viewportY + upRow;

  // Only editable if both ends are within command area (at or after prompt row)
  let promptRow: number, promptCol: number;
  if (hookless) {
    const area = detectCommandArea(buf, cursorAbsRow);
    promptRow = area.startRow;
    const promptLine = buf.getLine(promptRow);
    promptCol = promptLine ? detectPromptCol(promptLine, terminal.cols) : 0;
    if (downAbsRow > area.endRow || upAbsRow > area.endRow) return;
  } else {
    ({ promptRow, promptCol } = mt.shellState);
  }
  if (promptRow < 0) return;
  if (downAbsRow < promptRow || upAbsRow < promptRow) return;

  // Snap to character boundaries
  const downLine = buf.getLine(downAbsRow);
  const upLine = buf.getLine(upAbsRow);
  if (!downLine || !upLine) return;
  let snappedDownCol = snapClickCol(downLine, downCol);
  let snappedUpCol = snapClickCol(upLine, upCol);

  // Clamp selection start to editable area (after prompt text)
  if (downAbsRow === promptRow && snappedDownCol < promptCol) snappedDownCol = promptCol;
  if (upAbsRow === promptRow && snappedUpCol < promptCol) snappedUpCol = promptCol;

  const selCharCount = computeCharDistance(buf, downAbsRow, snappedDownCol, upAbsRow, snappedUpCol);
  if (selCharCount === 0) return;

  const isForward = upAbsRow > downAbsRow
    || (upAbsRow === downAbsRow && snappedUpCol > snappedDownCol);

  // Save selected text — recompute from buffer to exclude prompt portion
  const selectedText = extractBufferText(buf, terminal.cols,
    isForward ? downAbsRow : upAbsRow, isForward ? snappedDownCol : snappedUpCol,
    isForward ? upAbsRow : downAbsRow, isForward ? snappedUpCol : snappedDownCol);

  // Empty or whitespace-only selection (blank area) → keep native xterm selection
  if (!selectedText.trim()) return;

  // Clear xterm.js native selection — we'll show our own highlight
  terminal.clearSelection();

  // Move cursor to the drag-end position
  const moveCount = computeCharDistance(buf, cursorAbsRow, cursorCol, upAbsRow, snappedUpCol);
  if (moveCount > 0) {
    const moveForward = upAbsRow > cursorAbsRow
      || (upAbsRow === cursorAbsRow && snappedUpCol > cursorCol);
    sendInput(mt, buildCursorMove(moveCount, moveForward, hookless));
  }

  // Record editable selection
  sel.active = true;
  sel.forward = isForward;
  sel.charCount = selCharCount;
  sel.text = selectedText;
  sel.hookless = hookless;

  // Show custom cursor-style highlight (uses clamped range)
  const startAbsRow = isForward ? downAbsRow : upAbsRow;
  const startCol = isForward ? snappedDownCol : snappedUpCol;
  const endAbsRow = isForward ? upAbsRow : downAbsRow;
  const endCol = isForward ? snappedUpCol : snappedDownCol;
  showHighlight(terminal, sel, screenEl, viewportY,
    startAbsRow, startCol, endAbsRow, endCol);
}

// ---------------------------------------------------------------------------
// Custom cursor-style highlight overlay (matches cursor color + blink)
// ---------------------------------------------------------------------------

let _styleInjected = false;
function ensureSelectionStyle(): void {
  if (_styleInjected) return;
  const style = document.createElement('style');
  style.textContent = `
    @keyframes cmd-sel-blink {
      0%, 50% { visibility: visible; }
      50.01%, 100% { visibility: hidden; }
    }
    .cmd-sel-highlight {
      position: absolute;
      pointer-events: none;
      z-index: 5;
      box-sizing: border-box;
    }
    .cmd-sel-highlight.focused {
      opacity: 0.45;
      animation: cmd-sel-blink 1.2s step-end infinite;
    }
    .cmd-sel-highlight.blurred {
      background-color: transparent !important;
      opacity: 1;
      animation: none;
    }
  `;
  document.head.appendChild(style);
  _styleInjected = true;
}

/** Switch all overlays between focused (solid inversion) and blurred (outline). */
function updateHighlightMode(sel: EditableSelection, isFocused: boolean): void {
  for (const el of sel.overlays) {
    if (isFocused) {
      el.classList.add('focused');
      el.classList.remove('blurred');
      el.style.border = '';
    } else {
      el.classList.remove('focused');
      el.classList.add('blurred');
      el.style.border = `1px solid ${el.dataset.cursorColor || '#fff'}`;
    }
  }
}

function showHighlight(
  terminal: Terminal,
  sel: EditableSelection,
  screenEl: HTMLElement,
  viewportY: number,
  startAbsRow: number, startCol: number,
  endAbsRow: number, endCol: number,
): void {
  const dims = getCellDims(terminal, screenEl);
  const cellW = dims.w;
  const cellH = dims.h;
  ensureSelectionStyle();
  const cursorColor = terminal.options.theme?.cursor || '#ffffff';
  const isFocused = document.hasFocus();

  for (let absRow = startAbsRow; absRow <= endAbsRow; absRow++) {
    const viewportRow = absRow - viewportY;
    if (viewportRow < 0 || viewportRow >= terminal.rows) continue;

    const rowStartCol = (absRow === startAbsRow) ? startCol : 0;
    const rowEndCol = (absRow === endAbsRow) ? endCol : terminal.cols;
    if (rowEndCol <= rowStartCol) continue;

    const overlay = document.createElement('div');
    overlay.className = 'cmd-sel-highlight';
    overlay.dataset.cursorColor = cursorColor;
    overlay.style.top = `${viewportRow * cellH}px`;
    overlay.style.left = `${rowStartCol * cellW}px`;
    overlay.style.width = `${(rowEndCol - rowStartCol) * cellW}px`;
    overlay.style.height = `${cellH}px`;
    overlay.style.backgroundColor = cursorColor;

    if (isFocused) {
      overlay.classList.add('focused');
    } else {
      overlay.classList.add('blurred');
      overlay.style.backgroundColor = 'transparent';
      overlay.style.border = `1px solid ${cursorColor}`;
    }

    screenEl.appendChild(overlay);
    sel.overlays.push(overlay);
  }
}

function removeHighlight(sel: EditableSelection): void {
  for (const el of sel.overlays) el.remove();
  sel.overlays = [];
}

function clearSel(terminal: Terminal, sel: EditableSelection): void {
  sel.active = false;
  sel.charCount = 0;
  sel.text = '';
  sel.hookless = false;
  removeHighlight(sel);
  terminal.clearSelection();
}

// ---------------------------------------------------------------------------
// Key handler for active selection
// ---------------------------------------------------------------------------

function handleSelectionKey(
  mt: ManagedTerminal,
  terminal: Terminal,
  sel: EditableSelection,
  ev: KeyboardEvent,
): boolean {
  const { key, ctrlKey, metaKey, altKey } = ev;

  // Ignore modifier-only keys (Meta, Control, Shift, Alt pressed alone).
  // These precede the actual key combo (e.g. Meta fires before Meta+X).
  if (key === 'Meta' || key === 'Control' || key === 'Shift' || key === 'Alt') {
    return true; // let through without clearing selection
  }

  // Cmd+C / Ctrl+C → copy
  if ((ctrlKey || metaKey) && key === 'c') {
    if (sel.text) void clipboardWriteText(sel.text);
    clearSel(terminal, sel);
    ev.preventDefault();
    return false;
  }

  // Cmd+V / Ctrl+V → paste replaces selection
  if ((ctrlKey || metaKey) && key === 'v') {
    ev.preventDefault();
    void clipboardReadText().then((text) => {
      if (!text) { clearSel(terminal, sel); return; }
      sendInput(mt, buildSelectionDelete(sel) + text);
      clearSel(terminal, sel);
    });
    return false;
  }

  // Cmd+X / Ctrl+X → cut
  if ((ctrlKey || metaKey) && key === 'x') {
    if (sel.text) void clipboardWriteText(sel.text);
    ev.preventDefault();
    sendInput(mt, buildSelectionDelete(sel));
    clearSel(terminal, sel);
    return false;
  }

  // Any other modifier combo → clear and let through
  if (ctrlKey || metaKey || altKey) {
    clearSel(terminal, sel);
    return true;
  }

  // Backspace / Delete → delete selection
  if (key === 'Backspace' || key === 'Delete') {
    ev.preventDefault();
    sendInput(mt, buildSelectionDelete(sel));
    clearSel(terminal, sel);
    return false;
  }

  // Printable character → replace selection
  if (key.length === 1) {
    ev.preventDefault();
    sendInput(mt, buildSelectionDelete(sel) + key);
    clearSel(terminal, sel);
    return false;
  }

  // Arrow keys, Home, End → clear selection, let key through
  if (key.startsWith('Arrow') || key === 'Home' || key === 'End') {
    clearSel(terminal, sel);
    return true;
  }

  // Escape → clear selection
  if (key === 'Escape') {
    ev.preventDefault();
    clearSel(terminal, sel);
    return false;
  }

  // Anything else → clear selection, let through
  clearSel(terminal, sel);
  return true;
}

// ---------------------------------------------------------------------------
// Selection delete
// ---------------------------------------------------------------------------

function buildSelectionDelete(sel: EditableSelection): string {
  if (sel.charCount === 0) return '';
  const deleteKey = sel.forward ? '\x7f' : '\x1b[3~';
  // Hookless mode: repeated individual delete keys (universal compatibility)
  if (sel.hookless) return deleteKey.repeat(sel.charCount);
  if (sel.charCount === 1) return deleteKey;
  return buildMetaDigitPrefix(sel.charCount) + deleteKey;
}

// ---------------------------------------------------------------------------
// Position resolution
// ---------------------------------------------------------------------------

function resolveClickPositions(terminal: Terminal, screenEl: HTMLElement, e: MouseEvent) {
  const rect = screenEl.getBoundingClientRect();
  const dims = getCellDims(terminal, screenEl);
  const clickCol = clamp(Math.floor((e.clientX - rect.left) / dims.w), 0, terminal.cols - 1);
  const clickRow = clamp(Math.floor((e.clientY - rect.top) / dims.h), 0, terminal.rows - 1);

  const buf = terminal.buffer.active;
  const viewportY = getViewportY(terminal, buf.baseY);
  const clickAbsRow = viewportY + clickRow;
  const cursorAbsRow = buf.baseY + buf.cursorY;
  const cursorCol = buf.cursorX;

  const clickLine = buf.getLine(clickAbsRow);
  if (!clickLine) return { clickAbsRow: -1, snappedClickCol: 0, cursorAbsRow, cursorCol };
  const snappedClickCol = snapClickCol(clickLine, clickCol);

  return { clickAbsRow, snappedClickCol, cursorAbsRow, cursorCol };
}

// ---------------------------------------------------------------------------
// Hookless mode helpers — fallback when shell hook (OSC 7768) is unavailable
// (Windows SSH, WSL, JumpServer, etc.)
// ---------------------------------------------------------------------------

/**
 * Detect the command area heuristically by walking through wrapped lines
 * from the cursor position. Returns the logical line boundaries.
 */
function detectCommandArea(
  buf: Terminal['buffer']['active'], cursorAbsRow: number,
): { startRow: number; endRow: number } {
  // Walk up through wrapped lines to find the prompt start row
  let startRow = cursorAbsRow;
  while (startRow > 0) {
    const line = buf.getLine(startRow);
    if (!line || !line.isWrapped) break;
    startRow--;
  }
  // Walk down through wrapped lines to find the command end row
  let endRow = cursorAbsRow;
  while (true) {
    const nextLine = buf.getLine(endRow + 1);
    if (!nextLine || !nextLine.isWrapped) break;
    endRow++;
  }
  return { startRow, endRow };
}

/**
 * Detect promptCol heuristically by scanning the prompt row for common
 * prompt-ending patterns: `$ `, `# `, `% `, `> `, `❯ `, `» `, `→ `.
 * Returns the column after the prompt ending (where command input begins).
 */
function detectPromptCol(line: IBufferLine, cols: number): number {
  const scanLimit = Math.min(line.length, cols, 120);
  let promptEnd = 0;
  for (let col = 0; col < scanLimit - 1; col++) {
    const cell = line.getCell(col);
    if (!cell) break;
    const ch = cell.getChars();
    if (ch === '$' || ch === '#' || ch === '%' || ch === '>'
      || ch === '❯' || ch === '»' || ch === '→') {
      const next = line.getCell(col + 1);
      if (next && next.getChars() === ' ') {
        promptEnd = col + 2;
      }
    }
  }
  return promptEnd;
}

/**
 * Build cursor move sequence — uses Meta-digit prefix with shell hook,
 * repeated individual arrow keys without (universal compatibility).
 */
function buildCursorMove(charCount: number, forward: boolean, hookless: boolean): string {
  if (hookless) {
    const arrow = forward ? '\x1b[C' : '\x1b[D';
    return arrow.repeat(charCount);
  }
  return buildReadlineMove(charCount, forward);
}

// ---------------------------------------------------------------------------
// Readline sequence builders
// ---------------------------------------------------------------------------

function buildReadlineMove(charCount: number, forward: boolean): string {
  const arrow = forward ? '\x1b[C' : '\x1b[D';
  if (charCount === 1) return arrow;
  return buildMetaDigitPrefix(charCount) + arrow;
}

function buildMetaDigitPrefix(n: number): string {
  const digits = n.toString();
  let prefix = '';
  for (let i = 0; i < digits.length; i++) {
    prefix += '\x1b' + digits[i];
  }
  return prefix;
}

function sendInput(mt: ManagedTerminal, data: string): void {
  mt._hasUserInput = true;
  mt.shellState.lastUserInputAt = Date.now();
  sendToTerminal(mt, encodeMessage(MsgInput, new TextEncoder().encode(data)));
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

// ---------------------------------------------------------------------------
// Viewport offset
// ---------------------------------------------------------------------------

function getViewportY(terminal: Terminal, fallback: number): number {
  try {
    const core = (terminal as any)._core;
    const ydisp = core?.buffer?.ydisp
      ?? core?._bufferService?.buffer?.ydisp
      ?? core?._bufferService?.buffers?.active?.ydisp;
    if (typeof ydisp === 'number') return ydisp;
  } catch { /* ignore */ }
  return fallback;
}

// ---------------------------------------------------------------------------
// Accurate cell dimensions from xterm.js renderer
// ---------------------------------------------------------------------------

function getCellDims(terminal: Terminal, screenEl: HTMLElement): { w: number; h: number } {
  try {
    const core = (terminal as any)._core;
    const cell = core?._renderService?.dimensions?.css?.cell;
    if (cell?.width > 0 && cell?.height > 0) return { w: cell.width, h: cell.height };
  } catch { /* ignore */ }
  // Fallback: derive from screen rect (less accurate when min-height: 100% is set)
  const rect = screenEl.getBoundingClientRect();
  return { w: rect.width / terminal.cols, h: rect.height / terminal.rows };
}

// ---------------------------------------------------------------------------
// Character distance between two buffer positions
// ---------------------------------------------------------------------------

function computeCharDistance(
  buf: Terminal['buffer']['active'],
  row1: number, col1: number,
  row2: number, col2: number,
): number {
  let fromRow: number, fromCol: number, toRow: number, toCol: number;
  if (row1 < row2 || (row1 === row2 && col1 <= col2)) {
    fromRow = row1; fromCol = col1; toRow = row2; toCol = col2;
  } else {
    fromRow = row2; fromCol = col2; toRow = row1; toCol = col1;
  }

  if (fromRow === toRow) {
    const line = buf.getLine(fromRow);
    return line ? countCharsInRange(line, fromCol, toCol) : 0;
  }

  let total = 0;
  const fromLine = buf.getLine(fromRow);
  if (fromLine) total += countCharsInRange(fromLine, fromCol, fromLine.length);

  for (let r = fromRow + 1; r <= toRow; r++) {
    const line = buf.getLine(r);
    if (!line) break;
    if (!line.isWrapped) total += 1;
    if (r < toRow) {
      total += countAllCharsOnLine(line);
    } else {
      total += countCharsInRange(line, 0, toCol);
    }
  }

  return total;
}

// ---------------------------------------------------------------------------
// Character counting
// ---------------------------------------------------------------------------

function countAllCharsOnLine(line: IBufferLine): number {
  return countCharsInRange(line, 0, line.length);
}

function countCharsInRange(line: IBufferLine, fromCol: number, toCol: number): number {
  let chars = 0;
  for (let col = fromCol; col < toCol;) {
    const cell = line.getCell(col);
    if (!cell) break;
    const ch = cell.getChars();
    const w = cell.getWidth();
    if (ch === '' || w === 0) {
      col++;
    } else if (w >= 2) {
      chars++;
      col += w;
    } else {
      chars++;
      col++;
    }
  }
  return chars;
}

// ---------------------------------------------------------------------------
// Extract text from buffer range (for clamped selections)
// ---------------------------------------------------------------------------

function extractBufferText(
  buf: Terminal['buffer']['active'], cols: number,
  startRow: number, startCol: number,
  endRow: number, endCol: number,
): string {
  const parts: string[] = [];
  for (let r = startRow; r <= endRow; r++) {
    const line = buf.getLine(r);
    if (!line) break;
    const from = (r === startRow) ? startCol : 0;
    const to = (r === endRow) ? endCol : cols;
    let rowText = '';
    for (let c = from; c < to;) {
      const cell = line.getCell(c);
      if (!cell) break;
      const ch = cell.getChars();
      const w = cell.getWidth();
      if (ch && w > 0) { rowText += ch; c += w; }
      else { c++; }
    }
    parts.push(rowText);
    // Add newline between non-wrapped rows
    if (r < endRow) {
      const nextLine = buf.getLine(r + 1);
      if (nextLine && !nextLine.isWrapped) parts.push('\n');
    }
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Click position snapping
// ---------------------------------------------------------------------------

function snapClickCol(line: IBufferLine, col: number): number {
  const cell = line.getCell(col);
  if (!cell) return findContentEnd(line);
  if (cell.getChars() !== '') return col;
  if (cell.getWidth() === 0 && col > 0) return col - 1;
  return findContentEnd(line);
}

function findContentEnd(line: IBufferLine): number {
  for (let col = line.length - 1; col >= 0; col--) {
    const cell = line.getCell(col);
    if (cell && cell.getChars() !== '') {
      const w = cell.getWidth();
      return col + (w >= 2 ? w : 1);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// xterm.js internal state
// ---------------------------------------------------------------------------

function isMouseTrackingActive(terminal: Terminal): boolean {
  try {
    const core = (terminal as any)._core;
    const modes = core?.coreService?.decPrivateModes;
    if (modes) return !!modes.mouseTrackingMode;
    return !!core?.coreMouseService?.areMouseEventsActive;
  } catch {
    return false;
  }
}
