/**
 * jumpserver-browser.ts — Open JumpServer asset browser as a standalone window
 *
 * Creates a Tauri WebviewWindow for browsing JumpServer assets.
 * Communicates back to the main window via Tauri events.
 */

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { loadSettings, resolveIsDark, windowBgColor } from './themes';
import { t } from './i18n';
import { port, authToken } from './app-state';
import type { JumpServerConfig } from './jumpserver-api';

const isWindowsPlatform = navigator.userAgent.toLowerCase().includes('windows');
const isMac = !isWindowsPlatform && navigator.userAgent.includes('Mac');

/**
 * Open the JumpServer asset browser window (single-instance).
 * Stores connection context in localStorage for the child window to read.
 */
export async function openJumpServerBrowserWindow(config: JumpServerConfig): Promise<void> {
  // Store context for the child window
  localStorage.setItem('meterm-js-browser-port', String(port));
  localStorage.setItem('meterm-js-browser-token', authToken);
  localStorage.setItem('meterm-js-browser-config', JSON.stringify(config));

  const label = 'jumpserver-browser';
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    // Update config in case it changed, then focus
    void existing.show();
    void existing.setFocus();
    return;
  }

  const settings = loadSettings();
  const resolveTheme = (c: string) => {
    if (c === 'light') return 'light';
    if (c === 'auto') return resolveIsDark('auto') ? 'dark' : 'light';
    return 'dark';
  };
  const themeStr = resolveTheme(settings.colorScheme);
  const nativeTheme = themeStr === 'light' ? 'light' as const : 'dark' as const;
  const bgColor = windowBgColor(settings.colorScheme, themeStr);
  const baseUrl = window.location.origin + window.location.pathname;

  const win = new WebviewWindow(label, {
    url: `${baseUrl}?window=jumpserver-browser`,
    title: `${config.name} — ${t('jsAssetBrowser')}`,
    width: 720,
    height: 520,
    resizable: true,
    center: true,
    visible: false,
    decorations: !isWindowsPlatform,
    transparent: false,
    theme: nativeTheme,
    backgroundColor: bgColor,
    ...(isMac ? { titleBarStyle: 'overlay' as const, hiddenTitle: true } : {}),
  });

  win.once('tauri://created', () => {
    setTimeout(() => { void win.show().then(() => win.setFocus()); }, 150);
  });
  win.once('tauri://error', (e: unknown) => {
    console.error('[jumpserver-browser] Failed to create window:', e);
  });
}
