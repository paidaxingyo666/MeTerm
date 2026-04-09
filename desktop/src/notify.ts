import { getCurrentWindow } from '@tauri-apps/api/window';
import { sendNotification, isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { escapeHtml } from './status-bar';

// Notification types — extensible for future use
export type NotificationType =
  | 'pair-request'
  | 'master-request'
  | 'terminal-osc'
  /** Agent needs user action (tool confirmation / stuck on interactive prompt). */
  | 'agent-waiting'
  /** Agent finished or errored out. */
  | 'agent-complete';

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * Request window attention via dock bounce (macOS) / taskbar flash (Windows).
 * Uses AttentionType.Critical (2) for persistent notification.
 */
export async function requestWindowAttention(): Promise<void> {
  try {
    await getCurrentWindow().requestUserAttention(2); // Critical
  } catch {
    // Not supported or window already focused
  }
}

/**
 * Comprehensive user notification. Behavior matrix:
 *
 *   pair-request / master-request (connection approvals):
 *     not focused → attention + show + setFocus (force foreground)
 *     focused     → caller already handles the UI
 *
 *   terminal-osc (OSC 9 / iTerm notifications from shell):
 *     not focused → attention + system notification
 *     focused     → in-app toast
 *
 *   agent-waiting (AI agent needs user action while idle in background):
 *     not focused → attention + system notification
 *     focused     → no-op (the confirm card in the chat panel IS the UI)
 *
 *   agent-complete (AI agent finished its turn):
 *     not focused → attention + system notification
 *     focused     → no-op (UI already shows the completion in chat)
 */
export async function notifyUser(notification: AppNotification): Promise<void> {
  const win = getCurrentWindow();
  try {
    const focused = await win.isFocused();
    if (!focused) {
      if (notification.type === 'terminal-osc') {
        await requestWindowAttention();
        await sendSystemNotification(notification.title, notification.body);
      } else if (notification.type === 'agent-waiting' || notification.type === 'agent-complete') {
        // Dock bounce + system notification.  We intentionally do NOT
        // force-focus the window for agent events: the agent may run
        // in the background for long stretches, and stealing focus
        // every few seconds would be hostile to the user.
        await requestWindowAttention();
        await sendSystemNotification(notification.title, notification.body);
      } else {
        await requestWindowAttention();
        await win.show();
        await win.setFocus();
      }
    } else if (notification.type === 'terminal-osc') {
      // Window focused → show in-app toast
      showToast({
        title: notification.title,
        body: notification.body,
        source: notification.data?.source as string | undefined,
      });
    }
    // agent-waiting / agent-complete when focused: intentionally silent.
  } catch {
    // Window API not available — try toast as fallback
    if (notification.type === 'terminal-osc') {
      showToast({
        title: notification.title,
        body: notification.body,
        source: notification.data?.source as string | undefined,
      });
    }
  }
}

/**
 * Send a system notification via Tauri plugin.
 */
async function sendSystemNotification(title: string, body: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      const permission = await requestPermission();
      granted = permission === 'granted';
    }
    if (granted) {
      sendNotification({ title, body, sound: 'default' });
    }
  } catch {
    // Notification not available
  }
}

/**
 * Show an in-app toast notification.
 */
export function showToast(opts: { title: string; body: string; source?: string; onClick?: () => void; duration?: number }): void {
  let container = document.querySelector('.toast-container') as HTMLDivElement;
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  // Limit to 3 toasts — remove oldest
  while (container.children.length >= 3) {
    const oldest = container.firstElementChild as HTMLElement;
    oldest.remove();
  }

  const toast = document.createElement('div');
  toast.className = 'toast-notification toast-enter';
  if (opts.onClick) toast.classList.add('toast-clickable');

  const header = document.createElement('div');
  header.className = 'toast-header';

  const titleEl = document.createElement('span');
  titleEl.className = 'toast-title';
  titleEl.textContent = escapeHtml(opts.title);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'toast-close';
  closeBtn.innerHTML = '&times;';
  closeBtn.onclick = (e) => { e.stopPropagation(); dismissToast(toast); };

  header.appendChild(titleEl);
  header.appendChild(closeBtn);
  toast.appendChild(header);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'toast-body';
  bodyEl.textContent = escapeHtml(opts.body);
  toast.appendChild(bodyEl);

  if (opts.source) {
    const sourceEl = document.createElement('div');
    sourceEl.className = 'toast-source';
    sourceEl.textContent = escapeHtml(opts.source);
    toast.appendChild(sourceEl);
  }

  if (opts.onClick) {
    toast.addEventListener('click', () => { dismissToast(toast); opts.onClick!(); });
  }

  container.appendChild(toast);

  // Trigger slide-in animation
  requestAnimationFrame(() => {
    toast.classList.remove('toast-enter');
  });

  // Auto-dismiss (default 8s for update toasts, 4s otherwise)
  const duration = opts.duration ?? 4000;
  const timer = setTimeout(() => dismissToast(toast), duration);
  (toast as any)._dismissTimer = timer;
}

function dismissToast(toast: HTMLElement): void {
  if ((toast as any)._dismissed) return;
  (toast as any)._dismissed = true;
  clearTimeout((toast as any)._dismissTimer);
  toast.classList.add('toast-exit');
  toast.addEventListener('animationend', () => toast.remove(), { once: true });
  // Fallback removal if animation doesn't fire
  setTimeout(() => toast.remove(), 400);
}
