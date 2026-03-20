/**
 * cmd-completion.ts — Inline ghost text completion engine.
 * Renders gray suggestion text after the cursor, accepted via Right Arrow.
 */

import type { Terminal } from '@xterm/xterm';
import { TerminalRegistry } from './terminal';
import { CompletionIndex, type CompletionCandidate } from './cmd-completion-data';

export class InlineCompletion {
  private sessionId: string;
  private terminal: Terminal;
  private container: HTMLDivElement;
  private index: CompletionIndex;

  private lineBuffer = '';
  private ghostEl: HTMLSpanElement | null = null;
  private currentSuggestion: string | null = null;
  private allMatches: CompletionCandidate[] = [];
  private matchIndex = 0;
  private unsubInput: (() => void) | null = null;
  private debounceTimer: number | null = null;

  constructor(sessionId: string, terminal: Terminal, container: HTMLDivElement, index: CompletionIndex) {
    this.sessionId = sessionId;
    this.terminal = terminal;
    this.container = container;
    this.index = index;
  }

  attach(): void {
    this.unsubInput = TerminalRegistry.onInput(this.sessionId, (data) => {
      let changed = false;
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          this.lineBuffer = '';
          this.hideGhost();
          return;
        } else if (ch === '\x7f' || ch === '\b') {
          this.lineBuffer = this.lineBuffer.slice(0, -1);
          changed = true;
        } else if (ch === '\x15' || ch === '\x03') {
          // Ctrl+U or Ctrl+C: clear line
          this.lineBuffer = '';
          this.hideGhost();
          return;
        } else if (ch === '\t') {
          // Tab: don't intercept, just clear ghost
          this.hideGhost();
          return;
        } else if (ch === '\x1b') {
          // Escape sequence start: clear ghost and stop processing
          this.hideGhost();
          return;
        } else if (ch.charCodeAt(0) >= 32) {
          this.lineBuffer += ch;
          changed = true;
        }
      }
      if (changed) this.debounceSuggest();
    });
  }

  detach(): void {
    if (this.unsubInput) {
      this.unsubInput();
      this.unsubInput = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.hideGhost();
  }

  /** Right Arrow handler. Returns true if completion was accepted. */
  handleRightArrow(): boolean {
    if (!this.currentSuggestion || !this.ghostEl) return false;

    // Only accept when cursor is at end of line
    const buf = this.terminal.buffer.active;
    const line = buf.getLine(buf.cursorY);
    if (!line) return false;
    const lineStr = line.translateToString(true);
    const afterCursor = lineStr.substring(buf.cursorX).trim();
    if (afterCursor.length > 0) return false;

    const suffix = this.currentSuggestion.slice(this.lineBuffer.length);
    if (!suffix) return false;

    this.terminal.paste(suffix);
    this.lineBuffer += suffix;
    this.hideGhost();
    return true;
  }

  /** Up/Down arrow to cycle through candidates. Returns true if handled. */
  handleUpDown(direction: 'up' | 'down'): boolean {
    if (!this.isActive() || this.allMatches.length <= 1) return false;

    if (direction === 'down') {
      this.matchIndex = (this.matchIndex + 1) % this.allMatches.length;
    } else {
      this.matchIndex = (this.matchIndex - 1 + this.allMatches.length) % this.allMatches.length;
    }

    this.showGhost(this.allMatches[this.matchIndex].text);
    return true;
  }

  /** Whether ghost text is currently visible. */
  isActive(): boolean {
    return this.ghostEl !== null && this.ghostEl.style.display !== 'none';
  }

  hideGhost(): void {
    if (this.ghostEl) {
      this.ghostEl.style.display = 'none';
    }
    this.currentSuggestion = null;
    this.allMatches = [];
    this.matchIndex = 0;
  }

  /** Reset lineBuffer (e.g. when shell reports command executed). */
  resetBuffer(): void {
    this.lineBuffer = '';
    this.hideGhost();
  }

  private debounceSuggest(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      const prefix = this.lineBuffer;
      if (prefix.trim().length < 2) { this.hideGhost(); return; }

      const best = this.index.getBestMatch(prefix);
      if (best) {
        this.allMatches = this.index.getMatches(prefix, 10);
        this.matchIndex = 0;
        this.showGhost(best);
      } else {
        this.hideGhost();
      }
    }, 50);
  }

  private showGhost(suggestion: string): void {
    const prefix = this.lineBuffer;
    const suffix = suggestion.slice(prefix.length);
    if (!suffix) { this.hideGhost(); return; }

    if (!this.ghostEl) {
      this.ghostEl = document.createElement('span');
      this.ghostEl.className = 'cmd-ghost-text';
      this.container.appendChild(this.ghostEl);
    }

    // Position based on xterm cursor
    const buf = this.terminal.buffer.active;
    const core = (this.terminal as any)._core;
    if (!core?._optionsService) { this.hideGhost(); return; }
    const dims = core?._renderService?.dimensions?.css?.cell;
    if (!dims) { this.hideGhost(); return; }

    const screen = this.container.querySelector('.xterm-screen');
    if (!screen) { this.hideGhost(); return; }

    const screenRect = screen.getBoundingClientRect();
    const containerRect = this.container.getBoundingClientRect();

    this.ghostEl.style.left = `${buf.cursorX * dims.width + screenRect.left - containerRect.left}px`;
    this.ghostEl.style.top = `${buf.cursorY * dims.height + screenRect.top - containerRect.top}px`;
    this.ghostEl.style.height = `${dims.height}px`;
    this.ghostEl.style.lineHeight = `${dims.height}px`;
    this.ghostEl.style.fontSize = `${core._optionsService.rawOptions.fontSize}px`;
    this.ghostEl.textContent = suffix;
    this.ghostEl.style.display = 'inline';

    this.currentSuggestion = suggestion;
  }
}
