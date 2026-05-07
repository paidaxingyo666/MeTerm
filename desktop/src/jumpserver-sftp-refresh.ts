/**
 * jumpserver-sftp-refresh.ts — Silent SFTP credential refresh for expired JumpServer tokens.
 *
 * Called when the Rust backend returns { code: "SFTP_AUTH_FAILED" } for a file op.
 * Fetches a fresh JMS connection token and asks the Rust server to swap the
 * session's SFTP client. The pty terminal is unaffected (it's a separate SSH
 * connection). Concurrent failures are deduped to a single refresh per session.
 */

import { port, authToken, jumpServerConfigMap } from './app-state';
import { createConnectionToken } from './jumpserver-api';

const inflight = new Map<string, Promise<boolean>>();
const lastAttempt = new Map<string, number>(); // sessionId → ms timestamp
const RATE_LIMIT_MS = 30_000; // at most one refresh per 30s per session

/**
 * Attempt to refresh the SFTP client for a given session.
 * Returns true if successful, false otherwise. Safe to call concurrently
 * — only one network refresh happens per session until completion.
 *
 * Throttled to at most one attempt per 30 seconds per session to avoid
 * spamming JumpServer's token API when the backend is broken.
 *
 * Only JumpServer sessions can be refreshed; returns false immediately for
 * plain SSH sessions (their credentials don't change, so SFTP_AUTH_FAILED
 * would indicate something else — like server-side account disabled — that
 * manual intervention can't auto-recover).
 */
export function refreshJumpServerSftp(sessionId: string): Promise<boolean> {
  const existing = inflight.get(sessionId);
  if (existing) return existing;

  // Throttle: if we tried recently, don't spam JumpServer's token API.
  const prev = lastAttempt.get(sessionId);
  if (prev !== undefined && Date.now() - prev < RATE_LIMIT_MS) {
    console.warn(`[sftp-refresh] throttled for session ${sessionId} (last attempt ${Math.round((Date.now() - prev) / 1000)}s ago)`);
    return Promise.resolve(false);
  }

  const jsEntry = jumpServerConfigMap.get(sessionId);
  if (!jsEntry) return Promise.resolve(false);

  lastAttempt.set(sessionId, Date.now());

  const promise = (async () => {
    try {
      // Step 1: Fetch fresh connection token
      const tokenResult = await createConnectionToken(
        jsEntry.config.baseUrl,
        jsEntry.asset.id,
        jsEntry.account.name,
        jsEntry.account.username,
        jsEntry.account.alias || '',
        jsEntry.account.id,
        'ssh',
      );
      if (!tokenResult.ok || !tokenResult.token) {
        console.warn('[sftp-refresh] createConnectionToken failed:', tokenResult.error);
        return false;
      }
      const jmsToken = tokenResult.id || tokenResult.token;
      const newUsername = `JMS-${jmsToken}`;
      const newPassword = tokenResult.secret || tokenResult.token || '';

      // Step 2: Call refresh endpoint
      const resp = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(sessionId)}/refresh-sftp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          username: newUsername,
          password: newPassword,
        }),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        console.warn('[sftp-refresh] refresh endpoint failed:', resp.status, text);
        return false;
      }

      const body = await resp.json().catch(() => ({ ok: false }));
      return body.ok === true;
    } catch (err) {
      console.warn('[sftp-refresh] unexpected error:', err);
      return false;
    } finally {
      inflight.delete(sessionId);
    }
  })();

  inflight.set(sessionId, promise);
  return promise;
}
