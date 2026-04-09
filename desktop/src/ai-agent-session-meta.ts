// ─── AI Agent: per-session metadata registry ───────────────
// The agent loop lives in ai-agent.ts and should not import the
// capsule/UI layer directly. This module is a tiny registration
// seam through which the UI layer can expose tab-scoped data
// (locked target pane, one-shot closure notices) to the agent
// loop without a circular dependency.
//
// AICapsuleManager registers a provider function with
// `setSessionMetaProvider(...)` during its constructor; the agent
// loop calls `getSessionMeta(sessionId)` on every iteration to
// read current metadata. If no provider is registered (tests,
// headless use), a no-op default is returned.

export interface SessionMeta {
  /** pane_number to default all tool calls to. null = "use focus". */
  targetPaneNumber: number | null;
  /**
   * Consume + return any pending "Pane N closed" notices for this
   * session's tab. Calling this is expected to CLEAR the underlying
   * queue so the same notice is never surfaced twice.
   */
  consumeClosureNotices: () => number[];
}

type Provider = (sessionId: string) => SessionMeta;

let _provider: Provider = () => ({
  targetPaneNumber: null,
  consumeClosureNotices: () => [],
});

export function setSessionMetaProvider(p: Provider): void {
  _provider = p;
}

export function getSessionMeta(sessionId: string): SessionMeta {
  return _provider(sessionId);
}
