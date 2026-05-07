/**
 * jumpserver-errors.ts — Typed errors for JumpServer API failures.
 *
 * Rust backend prefixes error strings with `SESSION_EXPIRED:` when all API
 * paths returned 401/403 (see do_get_multi in server/jumpserver/mod.rs).
 * This module detects that prefix and converts it into a typed Error.
 */

const SESSION_EXPIRED_PREFIX = 'SESSION_EXPIRED:';

export class JumpServerSessionExpiredError extends Error {
  readonly baseUrl: string;
  constructor(baseUrl: string) {
    super(`JumpServer session expired: ${baseUrl}`);
    this.name = 'JumpServerSessionExpiredError';
    this.baseUrl = baseUrl;
  }
}

/** Returns a typed error if the raw string matches the SESSION_EXPIRED prefix, else null. */
export function parseJumpServerError(raw: string): JumpServerSessionExpiredError | null {
  const idx = raw.indexOf(SESSION_EXPIRED_PREFIX);
  if (idx < 0) return null;
  const tail = raw.slice(idx + SESSION_EXPIRED_PREFIX.length).trim();
  return new JumpServerSessionExpiredError(tail);
}

export function isJumpServerSessionExpired(err: unknown): err is JumpServerSessionExpiredError {
  return err instanceof JumpServerSessionExpiredError;
}
