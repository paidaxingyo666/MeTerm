/**
 * appearance.ts — Theme, opacity, and background image management.
 * Extracted from main.ts.
 */
import { AppSettings, resolveIsDark, getEffectiveTheme, saveSettings } from './themes';
import { TerminalRegistry } from './terminal';
import { convertFileSrc } from '@tauri-apps/api/core';

export function applyWindowOpacity(opacityPercent: number): void {
  const value = Math.max(20, Math.min(100, opacityPercent)) / 100;
  document.documentElement.style.setProperty('--app-window-opacity', `${value}`);
  // Clear the anti-flash inline background set in index.html
  document.documentElement.style.removeProperty('background-color');
  document.body.style.backgroundColor = 'transparent';
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
