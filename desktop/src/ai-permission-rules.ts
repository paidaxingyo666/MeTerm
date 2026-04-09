// ─── AI Agent: Permission Modes & Rule Engine ──────────────
// Modeled on Claude Code's permission system but simplified to fit
// MeTerm's 3-level trust model.
//
//   PermissionMode: coarse-grained default behavior
//   PermissionRule: fine-grained allow/deny overrides with regex
//
// Evaluation order: user rules → mode default → handler heuristic
// (requiresConfirm / isDestructive).  First match wins.

import type { ToolHandler } from './ai-tools-core';

// ─── Permission Modes ──────────────────────────────────────

export type PermissionMode =
  /** Ask for confirmation on EVERY tool call (corresponds to trust level 0). */
  | 'ask'
  /** Auto-approve read-only tools; ask for destructive ones (trust level 1). */
  | 'acceptSafe'
  /** Auto-approve unless the call is catastrophic (trust level 2). */
  | 'acceptAll'
  /**
   * Plan mode: only read-only tools (isConcurrencySafe === true) are allowed;
   * all write/mutating tools are silently denied.  Use when you want the
   * model to investigate and plan without actually doing anything.
   */
  | 'plan'
  /**
   * Bypass mode: no confirmation, no rule check, no denial. Intended for
   * CI / automation.  Must be opt-in via an explicit setting flag.
   */
  | 'bypass';

/** Map the legacy trust-level number to a PermissionMode. */
export function trustLevelToMode(level: number): PermissionMode {
  switch (level) {
    case 0: return 'ask';
    case 1: return 'acceptSafe';
    case 2: return 'acceptAll';
    default: return 'ask';
  }
}

// ─── Permission Rules ──────────────────────────────────────

export interface PermissionRuleMatch {
  /** Regex applied to args.command (for run_command). */
  command?: string;
  /** Regex applied to args.path (for read_file / write_file). */
  path?: string;
}

export interface PermissionRule {
  /** Tool name this rule applies to. '*' matches any. */
  tool: string;
  /** Optional argument matchers — if omitted, rule applies to all args. */
  match?: PermissionRuleMatch;
  /** Decision when the rule matches. */
  action: 'allow' | 'deny' | 'ask';
}

export type PermissionDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask' };

/** Compile regex once per rule for re-use. */
interface CompiledRule {
  rule: PermissionRule;
  commandRe: RegExp | null;
  pathRe: RegExp | null;
}

function compileRule(rule: PermissionRule): CompiledRule {
  return {
    rule,
    commandRe: rule.match?.command ? safeCompile(rule.match.command) : null,
    pathRe: rule.match?.path ? safeCompile(rule.match.path) : null,
  };
}

function safeCompile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function ruleMatches(
  compiled: CompiledRule,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  const { rule, commandRe, pathRe } = compiled;
  if (rule.tool !== '*' && rule.tool !== toolName) return false;

  if (commandRe) {
    const cmd = typeof args.command === 'string' ? args.command : '';
    if (!commandRe.test(cmd)) return false;
  }
  if (pathRe) {
    const p = typeof args.path === 'string' ? args.path : '';
    if (!pathRe.test(p)) return false;
  }
  return true;
}

// ─── Default Rule Set ──────────────────────────────────────
// Ships with conservative defaults that users can override via
// settings (aiPermissionRules, to be wired into settings UI later).

export const DEFAULT_PERMISSION_RULES: PermissionRule[] = [
  // Deny: anything that writes to sensitive files.
  { tool: 'write_file', match: { path: '\\.ssh/|\\.env$|\\.env\\.|/etc/' }, action: 'deny' },
  // Deny: destructive git operations even in acceptAll mode.
  { tool: 'run_command', match: { command: '^\\s*git\\s+push\\s+.*--force' }, action: 'deny' },
  { tool: 'run_command', match: { command: '^\\s*git\\s+reset\\s+--hard' }, action: 'deny' },
  // Allow common read-only commands without prompting.
  { tool: 'run_command', match: { command: '^(ls|pwd|cat|head|tail|file|stat|du|df|ps|top|uname|hostname|whoami|id|date|uptime|git\\s+(status|log|diff|branch|show))\\b' }, action: 'allow' },
];

// ─── Rule Evaluator ────────────────────────────────────────

/**
 * Decide whether a tool call is allowed, denied, or needs confirmation.
 *
 * @param toolName  The tool being invoked.
 * @param args      Parsed tool arguments.
 * @param handler   The registered handler (for fallback heuristics).
 * @param mode      Current PermissionMode.
 * @param rules     User + default rules (first match wins).
 */
export function decidePermission(
  toolName: string,
  args: Record<string, unknown>,
  handler: ToolHandler | undefined,
  mode: PermissionMode,
  rules: PermissionRule[],
): PermissionDecision {
  // Bypass: short-circuit everything.
  if (mode === 'bypass') return { kind: 'allow' };

  // Plan mode: only read-only tools allowed, everything else silently denied.
  if (mode === 'plan') {
    if (handler?.isConcurrencySafe) return { kind: 'allow' };
    return {
      kind: 'deny',
      reason: 'Plan mode is active — only read-only tools are allowed. The agent cannot modify anything.',
    };
  }

  // Walk user rules first (first match wins).
  for (const rule of rules) {
    const compiled = compileRule(rule);
    if (ruleMatches(compiled, toolName, args)) {
      if (rule.action === 'allow') return { kind: 'allow' };
      if (rule.action === 'deny') {
        return { kind: 'deny', reason: `Denied by permission rule (tool=${rule.tool}).` };
      }
      return { kind: 'ask' };
    }
  }

  // Mode defaults (equivalent to legacy trust levels).
  if (!handler) return { kind: 'ask' }; // unknown tool → always ask

  switch (mode) {
    case 'ask':
      return { kind: 'ask' };
    case 'acceptSafe':
      return handler.requiresConfirm(args) ? { kind: 'ask' } : { kind: 'allow' };
    case 'acceptAll':
      return handler.isDestructive(args) ? { kind: 'ask' } : { kind: 'allow' };
  }
}
