/**
 * appearance.ts — Theme, opacity, and background image management.
 * Extracted from main.ts.
 */
import { AppSettings, resolveIsDark, getEffectiveTheme, saveSettings } from './themes';
import { TerminalRegistry } from './terminal';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

export function applyWindowOpacity(opacityPercent: number): void {
  const value = Math.max(20, Math.min(100, opacityPercent)) / 100;
  document.documentElement.style.setProperty('--app-window-opacity', `${value}`);
  // Clear the anti-flash inline background set in index.html
  document.documentElement.style.removeProperty('background-color');
  document.body.style.backgroundColor = 'transparent';
}

export async function applyVibrancy(enabled: boolean): Promise<void> {
  // Apply CSS changes synchronously FIRST so the UI adapts immediately
  document.documentElement.classList.toggle('vibrancy-active', enabled);
  if (enabled) {
    // Clear anti-flash inline backgrounds so native blur shows through
    document.documentElement.style.removeProperty('background-color');
    document.body.style.backgroundColor = 'transparent';
    document.querySelectorAll('style').forEach(el => {
      if (el.textContent && /^body\s*\{background:/.test(el.textContent)) el.remove();
    });
  }
  // Read theme's --bg-primary (format: "r, g, b") for vibrancy fallback color.
  // This solid color is shown when vibrancy briefly disengages (Stage Manager, etc.)
  const bgPrimary = getComputedStyle(document.documentElement)
    .getPropertyValue('--bg-primary').trim();
  const [fr, fg, fb] = bgPrimary.split(',').map(s => parseInt(s.trim(), 10) / 255);

  const label = getCurrentWindow().label;
  try {
    await invoke('set_window_vibrancy', {
      label,
      enabled,
      fallbackR: isNaN(fr) ? undefined : fr,
      fallbackG: isNaN(fg) ? undefined : fg,
      fallbackB: isNaN(fb) ? undefined : fb,
    });
  } catch (e) {
    console.warn('Failed to set vibrancy:', e);
  }
}

export function applyAiBarOpacity(opacityPercent: number): void {
  const value = Math.max(20, Math.min(100, opacityPercent)) / 100;
  document.documentElement.style.setProperty('--ai-bar-opacity', `${value}`);
}

export function resolveThemeAttr(colorScheme: string): string {
  if (colorScheme === 'darker') return 'darker';
  if (colorScheme === 'navy') return 'navy';
  if (colorScheme === 'light') return 'light';
  if (colorScheme === 'auto') return resolveIsDark('auto') ? 'dark' : 'light';
  return 'dark';
}

export function applyColorScheme(s: AppSettings): void {
  document.documentElement.dataset.theme = resolveThemeAttr(s.colorScheme);

  const effectiveTheme = getEffectiveTheme(s);
  if (effectiveTheme !== s.theme) {
    s.theme = effectiveTheme;
    saveSettings(s);
  }
  TerminalRegistry.setSettings(s);

  // Apply file manager font size
  document.documentElement.style.setProperty('--file-manager-font-size', `${s.fileManagerFontSize}px`);
}

export function applyBackgroundImage(s: AppSettings, terminalPanelEl: HTMLElement): void {
  let bgEl = document.querySelector('.terminal-bg-image') as HTMLDivElement | null;
  let overlayEl = document.querySelector('.terminal-bg-overlay') as HTMLDivElement | null;
  if (s.backgroundImage) {
    if (!bgEl) {
      bgEl = document.createElement('div');
      bgEl.className = 'terminal-bg-image';
      terminalPanelEl.insertBefore(bgEl, terminalPanelEl.firstChild);
    }
    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.className = 'terminal-bg-overlay';
      terminalPanelEl.insertBefore(overlayEl, terminalPanelEl.firstChild);
    }
    // Normalize backslashes to forward slashes for Windows paths — convertFileSrc
    // percent-encodes backslashes which some WebView2 builds fail to resolve.
    const imgPath = s.backgroundImage.replace(/\\/g, '/');
    const url = convertFileSrc(imgPath);
    bgEl.style.backgroundImage = `url("${url}")`;
    // Opacity slider controls the image visibility when a bg image is set
    bgEl.style.opacity = String(Math.max(20, Math.min(100, s.opacity)) / 100);
    overlayEl.style.display = '';
  } else {
    if (bgEl) bgEl.style.backgroundImage = '';
    if (overlayEl) overlayEl.style.display = 'none';
  }
}
