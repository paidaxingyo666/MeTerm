/**
 * window-lifecycle.ts — Window lifecycle dialogs and tray interactions.
 * Extracted from main.ts.
 */
import { confirm, message } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { t } from './i18n';
import { loadSettings, resolveIsDark, windowBgColor } from './themes';
import { isQuitFlowRunning, setIsQuitFlowRunning, settings } from './app-state';
import { TabManager } from './tabs';

// closeAllSessions is injected via callback to avoid circular dependency
let _closeAllSessions: (() => Promise<void>) | null = null;
export function setCloseAllSessionsHandler(fn: () => Promise<void>): void {
  _closeAllSessions = fn;
}

export async function confirmSystem(messageText: string): Promise<boolean> {
  try {
    return await confirm(messageText, { title: t('appName'), kind: 'warning' });
  } catch {
    return window.confirm(messageText);
  }
}

export async function showInfoSystem(messageText: string, titleText: string): Promise<void> {
  try {
    await message(messageText, { title: titleText, kind: 'info' });
  } catch {
    window.alert(`${titleText}\n\n${messageText}`);
  }
}

export async function showAboutDialog(): Promise<void> {
  const existing = await WebviewWindow.getByLabel('about');
  if (existing) {
    void existing.show();
    void existing.setFocus();
    return;
  }

  const s = loadSettings();
  const resolveTheme = (c: string) => {
    if (c === 'light') return 'light';
    if (c === 'auto') return resolveIsDark('auto') ? 'dark' : 'light';
    return 'dark';
  };
  const themeStr = resolveTheme(s.colorScheme);
  const nativeTheme = themeStr === 'light' ? 'light' as const : 'dark' as const;
  const bgColor = windowBgColor(s.colorScheme, themeStr);
  const baseUrl = window.location.origin + window.location.pathname;

  const isMac = !navigator.userAgent.toLowerCase().includes('windows') && navigator.userAgent.includes('Mac');
  const win = new WebviewWindow('about', {
    url: `${baseUrl}?window=about`,
    title: t('aboutDialogTitle'),
    width: 280,
    height: 200,
    resizable: false,
    center: true,
    visible: false,
    decorations: !navigator.userAgent.toLowerCase().includes('windows'),
    transparent: false,
    theme: nativeTheme,
    backgroundColor: bgColor,
    ...(isMac ? { titleBarStyle: 'overlay' as const, hiddenTitle: true } : {}),
  });

  // Fallback: ensure window shows even if webview JS hasn't loaded yet
  win.once('tauri://created', () => {
    setTimeout(() => { void win.show().then(() => win.setFocus()); }, 150);
  });
}

export async function showHideToTrayDialog(): Promise<'hide' | 'close'> {
  try {
    const shouldHide = await confirm(t('hideToTrayTipBody'), { title: t('hideToTrayTipTitle'), kind: 'info', okLabel: t('hideToTrayTipHideNow'), cancelLabel: t('hideToTrayTipCancel') });
    if (shouldHide) {
      // Ask if user wants to remember this choice
      const shouldRemember = await confirm(t('hideToTrayTipRemember'), { title: t('hideToTrayTipTitle'), kind: 'info', okLabel: t('hideToTrayTipDontShow'), cancelLabel: t('hideToTrayTipCancel') });
      if (shouldRemember) {
        localStorage.setItem('meterm-hide-to-tray-pref', 'always_hide');
      }
      return 'hide';
    }
    return 'close';
  } catch {
    // Fallback if native dialog fails
    return window.confirm(t('hideToTrayTipBody')) ? 'hide' : 'close';
  }
}

export async function requestQuitWithConfirm(): Promise<void> {
  if (isQuitFlowRunning) {
    return;
  }
  setIsQuitFlowRunning(true);
  try {
    if (TabManager.tabs.length > 0) {
      const confirmed = await confirmSystem(t('confirmQuitWithSessions'));
      if (!confirmed) {
        return;
      }
      if (_closeAllSessions) await _closeAllSessions();
    }
    await invoke('request_app_quit');
  } finally {
    setIsQuitFlowRunning(false);
  }
}

export async function syncTrayLanguage(): Promise<void> {
  try {
    await invoke('set_tray_language', { language: settings.language });
  } catch {
  }
}
