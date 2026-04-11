/**
 * nb-palette.ts — Neo-Brutalism custom palette apply/clear.
 *
 * Custom colors are stored in AppSettings.nbCustomColors (shared
 * across all windows via saveSettings/loadSettings), NOT in
 * localStorage (which may not be shared between WebviewWindows).
 */

import { TerminalRegistry } from './terminal';
import { loadSettings } from './themes';

const hexToRgb = (h: string) =>
  `${parseInt(h.slice(1, 3), 16)}, ${parseInt(h.slice(3, 5), 16)}, ${parseInt(h.slice(5, 7), 16)}`;

interface VarMapping {
  css: string;
  rgb?: boolean;
  extra?: string[];
}

const VAR_MAP: Record<string, VarMapping> = {
  '--nb-bg':     { css: '--bg-primary', rgb: true, extra: ['--bg-toolbar', '--bg-status', '--bg-settings', '--bg-card', '--bg-input', '--bg-tab', '--bg-context-menu'] },
  '--nb-text':   { css: '--text-primary', extra: ['--text-heading', '--text-secondary', '--text-button', '--text-card-title', '--text-muted'] },
  '--nb-border': { css: '--nb-border', extra: ['--border-primary', '--border-subtle', '--border-toolbar'] },
  '--nb-shadow': { css: '--nb-shadow' },
  '--nb-accent': { css: '--nb-accent', extra: ['--accent', '--accent-primary'] },
};

const ALL_NB_KEYS = [
  '--nb-bg', '--nb-text', '--nb-border', '--nb-shadow', '--nb-accent',
  '--nb-highlight', '--nb-success', '--nb-info', '--nb-danger-light',
  '--nb-surface-alt', '--nb-card-bg', '--text-muted',
];

/**
 * Apply a custom NB palette from the given colors map.
 * Sets both --nb-* tokens (CSS reads these) and native project vars.
 */
function applyColors(colors: Record<string, string>): void {
  let customBg: string | null = null;
  let customFg: string | null = null;
  let surfaceAlt: string | null = null;

  for (const [k, v] of Object.entries(colors)) {
    if (typeof v !== 'string') continue;
    if (k === '--nb-bg') customBg = v;
    if (k === '--nb-text') customFg = v;
    if (k === '--nb-surface-alt') surfaceAlt = v;

    // Always set the --nb-* key itself (CSS reads var(--nb-text) etc.)
    document.documentElement.style.setProperty(k, v);
    // Also map to project-native vars
    const m = VAR_MAP[k];
    if (m) {
      const val = m.rgb ? hexToRgb(v) : v;
      document.documentElement.style.setProperty(m.css, val);
      m.extra?.forEach(e => document.documentElement.style.setProperty(e, val));
    }
  }

  // Card bg = surface-alt (slightly different from main bg for contrast)
  if (surfaceAlt) {
    document.documentElement.style.setProperty('--nb-card-bg', surfaceAlt);
  } else if (customBg) {
    document.documentElement.style.setProperty('--nb-card-bg', customBg);
  }

  // Patch xterm terminals
  if (customBg || customFg) {
    patchTerminals(customBg, customFg);
  }
}

function patchTerminals(bg: string | null, fg: string | null): void {
  try {
    for (const s of TerminalRegistry.getAllSessions()) {
      const mt = TerminalRegistry.get(s.id);
      if (!mt) continue;
      mt.terminal.options.theme = {
        ...mt.terminal.options.theme,
        ...(bg ? { background: bg } : {}),
        ...(fg ? { foreground: fg } : {}),
      };
      if (bg) mt.container.style.backgroundColor = bg;
    }
  } catch (e) {
    console.error('[nb-palette] Failed to patch terminals:', e);
  }
}

/**
 * Read NB palette from AppSettings and apply. Call after setSettings().
 */
export function applyNbPalette(colorScheme: string): void {
  if (colorScheme !== 'neo-brutalism' && colorScheme !== 'neo-brutalism-rounded') {
    clearNbPalette();
    return;
  }
  const settings = loadSettings();
  const colors = settings.nbCustomColors;
  if (!colors || Object.keys(colors).length === 0) return;
  applyColors(colors);
}

/** Remove all NB palette inline styles. */
export function clearNbPalette(): void {
  for (const m of Object.values(VAR_MAP)) {
    document.documentElement.style.removeProperty(m.css);
    m.extra?.forEach(e => document.documentElement.style.removeProperty(e));
  }
  for (const k of ALL_NB_KEYS) {
    document.documentElement.style.removeProperty(k);
  }
}

/**
 * Listen for NB palette changes from the settings window.
 * No longer needed — settings-changed event already triggers
 * applyNbPalette via the normal settings sync path. Kept as
 * a no-op for backward compatibility.
 */
export function listenForNbPaletteChanges(_getColorScheme: () => string): void {
  // No-op: palette now syncs through AppSettings + settings-changed event
}
