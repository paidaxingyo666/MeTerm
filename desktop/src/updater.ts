import { check } from '@tauri-apps/plugin-updater';
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { t } from './i18n';
import { loadSettings, resolveIsDark } from './themes';

// Notify Rust to update the tray/menu-bar "Check for Updates" badge.
async function notifyMenuBadge(version: string | null): Promise<void> {
  try {
    await invoke('set_update_badge', { version });
  } catch {
    // Non-critical — ignore silently.
  }
}

// Open the dedicated updater window (single-instance).
async function openUpdaterWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel('updater');
  if (existing) {
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
  const nativeTheme = resolveTheme(settings.colorScheme) === 'light' ? 'light' as const : 'dark' as const;
  const baseUrl = window.location.origin + window.location.pathname;

  const win = new WebviewWindow('updater', {
    url: `${baseUrl}?window=updater`,
    title: t('checkUpdates'),
    width: 500,
    height: 300,
    resizable: false,
    center: true,
    decorations: !navigator.userAgent.toLowerCase().includes('windows'),
    transparent: false,
    theme: nativeTheme,
  });

  win.once('tauri://created', () => { void win.setFocus(); });
  win.once('tauri://error', (e: unknown) => {
    console.error('[updater] Failed to create updater window:', e);
  });
}

// Check for updates silently on startup (after a short delay to not block app load).
// If an update is found, a non-blocking notification bar is shown at the top.
export async function initUpdater(): Promise<void> {
  // Small delay so the main app UI is fully ready before we talk to the network.
  await new Promise((r) => setTimeout(r, 8000));
  try {
    const update = await check();
    if (update) {
      void notifyMenuBadge(update.version);
      showBanner(update.version);
    }
  } catch {
    // Silent — update check failures should never surface to the user.
  }
}

// Immediately open the updater window (triggered by "Check for Updates" menu item).
// The window itself handles checking, result display, download, and restart.
export function checkUpdateNow(): void {
  void openUpdaterWindow();
}

// ── Banner (startup notification) ────────────────────────────────────────────
// Shown as a non-intrusive bar at the top; clicking "Update Now" opens the window.

let bannerEl: HTMLElement | null = null;

function showBanner(version: string): void {
  if (bannerEl) return;

  const el = document.createElement('div');
  el.className = 'update-banner';
  el.innerHTML = `
    <span class="update-banner-text">${t('updateAvailable').replace('{version}', version)}</span>
    <div class="update-banner-actions">
      <button class="update-banner-btn primary" data-action="now">${t('updateNow')}</button>
      <button class="update-banner-btn" data-action="later">${t('updateLater')}</button>
    </div>
  `;

  el.addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).dataset.action;
    if (action === 'now') {
      hideBanner();
      void openUpdaterWindow();
    } else if (action === 'later') {
      hideBanner();
    }
  });

  document.body.appendChild(el);
  bannerEl = el;
  requestAnimationFrame(() => el.classList.add('visible'));
}

function hideBanner(): void {
  if (!bannerEl) return;
  bannerEl.classList.remove('visible');
  const el = bannerEl;
  bannerEl = null;
  setTimeout(() => el.remove(), 250);
}
