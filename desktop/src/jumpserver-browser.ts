/**
 * jumpserver-browser.ts — Open JumpServer asset browser as a standalone window
 *
 * Creates a Tauri WebviewWindow for browsing JumpServer assets.
 * Communicates back to the main window via Tauri events.
 */

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { loadSettings, resolveIsDark } from './themes';
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
    transparent: true,
    theme: nativeTheme,
    // No backgroundColor — must be omitted for transparent window to work
    ...(isMac ? { titleBarStyle: 'overlay' as const, hiddenTitle: true } : {}),
  });

  // Window starts hidden (visible:false). Callers control when to show.
  // For direct open (not docked), show after a brief delay for rendering.
  win.once('tauri://created', () => {
    // Check if startDockedBrowser will manage visibility (it sets a flag in localStorage)
    const dockedMode = localStorage.getItem('meterm-js-browser-docked');
    if (dockedMode === 'true') {
      localStorage.removeItem('meterm-js-browser-docked');
      // startDockedBrowser will show the window after positioning
      return;
    }
    setTimeout(() => { void win.show().then(() => win.setFocus()); }, 150);
  });
  win.once('tauri://error', (e: unknown) => {
    console.error('[jumpserver-browser] Failed to create window:', e);
  });
}
