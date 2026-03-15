import { check } from '@tauri-apps/plugin-updater';
import { invoke } from '@tauri-apps/api/core';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { createUtilityWindow } from './window-utils';
import { t } from './i18n';
import { showToast } from './notify';

// ── Update state (module-level) ───────────────────────────────────────────────
// Exposed so main.ts can read it for the title bar icon.
export let pendingUpdateVersion: string | null = null;
export let pendingUpdateBody: string | null = null;

// Notify Rust to update the tray/menu-bar "Check for Updates" badge.
async function notifyMenuBadge(version: string | null): Promise<void> {
  try {
    await invoke('set_update_badge', { version });
  } catch {
    // Non-critical — ignore silently.
  }
}

// Open the dedicated updater window (single-instance).
export async function openUpdaterWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel('updater');
  if (existing) {
    void existing.show();
    void existing.setFocus();
    return;
  }

  try {
    await createUtilityWindow({
      label: 'updater',
      url: '?window=updater',
      title: t('checkUpdates'),
      width: 500,
      height: 300,
      resizable: false,
    });
    const win = await WebviewWindow.getByLabel('updater');
    if (win) {
      setTimeout(async () => {
        const w = await WebviewWindow.getByLabel('updater');
        if (w) void w.show().then(() => w.setFocus());
      }, 150);
    }
  } catch (e) {
    console.error('Failed to create updater window:', e);
  }
}

// Check for updates silently on startup (after a short delay to not block app load).
// If an update is found, shows an in-app toast and dispatches 'update-available'.
export async function initUpdater(): Promise<void> {
  // Small delay so the main app UI is fully ready before we talk to the network.
  await new Promise((r) => setTimeout(r, 8000));
  try {
    const update = await check();
    if (update) {
      pendingUpdateVersion = update.version;
      pendingUpdateBody = update.body ?? null;
      void notifyMenuBadge(update.version);
      showUpdateToast(update.version, update.body ?? null);
      document.dispatchEvent(new CustomEvent('update-available', {
        detail: { version: update.version, body: update.body ?? null },
      }));
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

// ── In-app toast notification ─────────────────────────────────────────────────

function showUpdateToast(version: string, body: string | null): void {
  const title = t('updateAvailable').replace('{version}', version);
  // Truncate changelog body to ~120 chars for the toast
  let bodyText = '';
  if (body) {
    // Strip markdown symbols for plain-text preview
    const plain = body.replace(/^#{1,3}\s+/gm, '').replace(/\*\*/g, '').replace(/`/g, '').trim();
    bodyText = plain.length > 120 ? plain.slice(0, 117) + '...' : plain;
  }
  showToast({
    title,
    body: bodyText || t('updateNow'),
    duration: 10000,
    onClick: () => { void openUpdaterWindow(); },
  });
}
