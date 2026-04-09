// ─── AI Agent: User Notifications ──────────────────────────
// Fires desktop notifications + dock bounces when the agent needs
// user attention while the window is in the background.
//
// Two categories:
//
//   • Waiting — the agent needs user action to progress:
//       - a confirm card is showing (permission gate)
//       - a tool returned status=waiting_password / waiting_confirm /
//         waiting_input / tui and the LLM decided to stop instead
//         of auto-resolving
//       - the agent hit max iterations and surfaced a summary
//
//   • Complete — the agent finished its turn (success OR failure):
//       - onComplete fired (normal end_turn)
//       - onError fired (non-retryable error)
//       - onAborted fired from a timeout, NOT from user cancel
//
// Throttling: at most one waiting notification per 8 seconds per
// category to avoid spamming the user when the agent yo-yos between
// "thinking" and "waiting" states.

import { notifyUser, type AppNotification } from './notify';
import { t } from './i18n';

type Kind = 'waiting' | 'complete';

const THROTTLE_MS = 8_000;
const lastFiredAt: Record<Kind, number> = { waiting: 0, complete: 0 };

function throttled(kind: Kind): boolean {
  const now = Date.now();
  if (now - lastFiredAt[kind] < THROTTLE_MS) return true;
  lastFiredAt[kind] = now;
  return false;
}

/**
 * Reset the throttle — called when a new user prompt is submitted
 * so the first waiting/complete event of each turn always fires.
 */
export function resetAgentNotificationThrottle(): void {
  lastFiredAt.waiting = 0;
  lastFiredAt.complete = 0;
}

// ─── Public triggers ──────────────────────────────────────

/**
 * Fire when the agent needs a confirmation from the user (permission
 * gate card opened while the agent was paused).  Uses `agent-waiting`
 * which only fires a system notification if the window is NOT focused.
 */
export function notifyAgentWaiting(reason: string, preview?: string): void {
  if (throttled('waiting')) return;
  const body = preview ? `${reason}\n${trimForNotification(preview)}` : reason;
  const n: AppNotification = {
    id: `agent-waiting-${Date.now()}`,
    type: 'agent-waiting',
    title: t('aiNotifyWaitingTitle'),
    body,
  };
  void notifyUser(n);
}

/**
 * Fire when the agent reaches end_turn successfully.  Passes the
 * final message text so the system notification shows a preview.
 */
export function notifyAgentComplete(finalText: string): void {
  if (throttled('complete')) return;
  const preview = trimForNotification(finalText);
  const n: AppNotification = {
    id: `agent-complete-${Date.now()}`,
    type: 'agent-complete',
    title: t('aiNotifyCompleteTitle'),
    body: preview || t('aiNotifyCompleteBody'),
  };
  void notifyUser(n);
}

/**
 * Fire when the agent errors out and cannot continue.
 */
export function notifyAgentError(errorMessage: string): void {
  if (throttled('complete')) return;
  const n: AppNotification = {
    id: `agent-error-${Date.now()}`,
    type: 'agent-complete',
    title: t('aiNotifyErrorTitle'),
    body: trimForNotification(errorMessage) || t('aiNotifyErrorBody'),
  };
  void notifyUser(n);
}

/**
 * Trim a string for inclusion in a system notification.
 * Most OS notification surfaces cut off after ~200 chars anyway.
 */
function trimForNotification(text: string, max = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max).trimEnd() + '…';
}
