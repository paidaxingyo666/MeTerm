/**
 * jumpserver-browser.ts — Open JumpServer asset browser as a standalone window
 *
 * Creates a Tauri WebviewWindow for browsing JumpServer assets.
 * Communicates back to the main window via Tauri events.
 */

import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { createUtilityWindow } from './window-utils';
import { t } from './i18n';
import { port, authToken } from './app-state';
import type { JumpServerConfig } from './jumpserver-api';

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

  try {
    await createUtilityWindow({
      label,
      url: '?window=jumpserver-browser',
      title: `${config.name} — ${t('jsAssetBrowser')}`,
      width: 720,
      height: 520,
      resizable: true,
    });
    const win = await WebviewWindow.getByLabel(label);
    if (win) {
      // Check if startDockedBrowser will manage visibility (it sets a flag in localStorage)
      const dockedMode = localStorage.getItem('meterm-js-browser-docked');
      if (dockedMode === 'true') {
        localStorage.removeItem('meterm-js-browser-docked');
        // startDockedBrowser will show the window after positioning
        return;
      }
      setTimeout(async () => {
        const w = await WebviewWindow.getByLabel(label);
        if (w) void w.show().then(() => w.setFocus());
      }, 150);
    }
  } catch (e) {
    console.error('Failed to create jumpserver-browser window:', e);
  }
}
