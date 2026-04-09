import { AIAgent } from './ai-agent';

export interface HistoryEntry {
  command: string;
  timestamp: number;
  source: 'manual' | 'ai';
}

export type AIChatLayoutMode = 'bottom' | 'side';

/**
 * Tab-scoped agent state. ALL panes inside a single tab share one
 * instance of this object — the ToolAgent, the conversation, the chat
 * panel DOM, the side panel DOM, layout mode, streaming state, the
 * pending image strip, and the draft text in the AI Bar input.
 *
 * Rationale: a tab is "one work context"; its multiple panes are
 * views on the same work. Keeping agent state per-pane used to cause
 * (a) duplicate chat panels fighting for the bottom slot, (b) side
 * panel getting stuck on the old pane after switching focus, and
 * (c) separate conversations on each pane which had no meaning.
 *
 * Per-pane `AICapsuleInstance` objects DELEGATE their shared fields
 * to this object via `Object.defineProperties` so all existing
 * call-sites that read/write `instance.agent`, `instance.messages`,
 * etc. transparently hit the shared state.
 */
export interface TabState {
  tabId: string;
  // Agent + conversation
  agent: AIAgent;
  messages: ConvEntry[];
  currentConversationId: string;
  /** Abort function for the currently-running agent.run() generator. */
  agentAbort: (() => void) | null;
  /** Shared draft text across all AI Bars in this tab. */
  draftText: string;
  /**
   * Pane number locked in at the moment the user last hit Send. All
   * tool calls in the current agent run default to THIS pane, even
   * if the user clicks another pane mid-stream. Reset to null when
   * a run ends (complete/abort/error). Null means "no lock — the
   * system prompt just uses the currently-focused pane".
   *
   * Set by the send path in ai-capsule-input-setup / chat-ops.
   */
  activeRunTargetPaneNumber: number | null;
  /**
   * One-shot notices for panes that were closed since the last time
   * the system prompt was built. Each entry is surfaced to the agent
   * EXACTLY ONCE (as "Pane N was closed") and then flushed — the same
   * closure is never mentioned a second time.
   *
   * Capped at 4 entries (the max number of panes in a tab). If more
   * closures happen before the agent consumes them, the OLDEST are
   * dropped (FIFO) because by then the user clearly isn't interested
   * in a weeks-old pane's death.
   */
  pendingClosureNotices: Array<{ paneNumber: number; at: number }>;
  // Chat panel (bottom mode) — single DOM node, moves with the tab
  chatPanel: HTMLDivElement | null;
  chatOpen: boolean;
  chatMinimized: boolean;
  // Streaming / rendering state
  isStreaming: boolean;
  streamBuffer: string;
  streamMsgEl: HTMLDivElement | null;
  reasoningBuffer: string;
  // Chat history drawer
  chatHistoryOpen: boolean;
  chatHistoryPanel: HTMLDivElement | null;
  // Layout mode and side-panel DOM — single instance per tab
  layoutMode: AIChatLayoutMode;
  sidePanel: HTMLDivElement | null;
  sideResizeHandle: HTMLDivElement | null;
  sideInputArea: HTMLDivElement | null;
  sideInput: HTMLTextAreaElement | null;
  /** Images queued for attachment to the next user message. */
  pendingImages: AttachedImage[];
  /**
   * Generic files queued for attachment to the next user message.
   * Unlike pendingImages these are NOT inlined into the message
   * content — their absolute on-disk paths are injected into the
   * agent's system prompt so the model can feed them into upload_file
   * / read_file / run_command directly.
   */
  pendingAttachments: AttachedFile[];
}

export interface AICapsuleInstance {
  sessionId: string;
  /** Id of the owning tab. Filled in by create() via findTabBySessionId. */
  tabId: string;
  /** Shared tab-scoped state (see TabState). Non-enumerable so it
   *  doesn't pollute for/in or JSON.stringify(). The shared fields
   *  below are Object.defineProperty'd to forward to this object. */
  state: TabState;
  historyKey: string;
  element: HTMLDivElement;
  selectedModel: string;
  history: HistoryEntry[];
  lineBuffer: string;
  unsubInput: (() => void) | null;
  unsubShellIdle: (() => void) | null;
  historyOpen: boolean;

  // ── Delegated to this.state (kept for compat with existing call-sites) ──
  messages: ConvEntry[];
  agent: AIAgent;
  agentAbort: (() => void) | null;
  chatPanel: HTMLDivElement | null;
  chatOpen: boolean;
  chatMinimized: boolean;
  isStreaming: boolean;
  streamBuffer: string;
  streamMsgEl: HTMLDivElement | null;
  reasoningBuffer: string;
  chatHistoryOpen: boolean;
  chatHistoryPanel: HTMLDivElement | null;
  currentConversationId: string;
  layoutMode: AIChatLayoutMode;
  sidePanel: HTMLDivElement | null;
  sideResizeHandle: HTMLDivElement | null;
  sideInputArea: HTMLDivElement | null;
  sideInput: HTMLTextAreaElement | null;
  pendingImages: AttachedImage[];
  pendingAttachments: AttachedFile[];
}

/** Attached image payload (base64, MIME).  Stored on user / tool_call
 *  entries so conversation history can replay multimodal turns. */
export interface AttachedImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** Base64 without the "data:..;base64," prefix. */
  data: string;
  /** Optional human label (e.g. "screenshot.png"). */
  label?: string;
}

/**
 * Generic user-attached file (zip, tar.gz, source tarball, binary, etc.)
 * Unlike AttachedImage — which rides inline inside the multimodal
 * message content — a generic attachment is stored as a file on
 * disk and the Agent is told its ABSOLUTE PATH via a system-prompt
 * note so it can feed that path straight into `upload_file` /
 * `read_file` / `run_command`.
 *
 * We do NOT inline these as base64 in the chat history because:
 *   (a) they may be huge (hundreds of MB for source archives);
 *   (b) the LLM never needs to "see" the bytes, it just needs to
 *       know the file exists and where to find it.
 *
 * The file is copied into `<app-data>/attachments/<ts>-<name>` by
 * the Rust `agent_save_attachment` command when the user drops/picks
 * it, and cleaned up when the conversation is cleared.
 */
export interface AttachedFile {
  /** Human-facing name (original filename). */
  name: string;
  /** Absolute path on disk where the attachment bytes live. */
  path: string;
  /** Size in bytes. */
  size: number;
  /** Best-effort MIME guess ("application/zip", "application/x-tar", "application/octet-stream"). */
  mimeType?: string;
  /** Timestamp at which the attachment was created (app clock). */
  at: number;
}

/** Discriminated-union entry stored per conversation turn.
 *  `paneNumber` (phase 2) records which pane the entry is bound to:
 *  for a `user` entry it's the pane the user sent the message from
 *  (= the run's locked target); for a `tool_call` entry it's the
 *  pane the tool actually operated on. Undefined for legacy / pre-
 *  phase-2 entries or for messages without a pane context. */
export type ConvEntry =
  | { type: 'user';      content: string; images?: AttachedImage[]; timestamp: number; paneNumber?: number }
  | { type: 'thinking';  content: string; reasoning?: string; timestamp: number }
  | { type: 'assistant'; content: string; timestamp: number }
  | { type: 'system';    content: string; timestamp: number }
  | { type: 'tool_call'; toolName: string; args: Record<string, unknown>;
      result: string | null; isError: boolean; images?: AttachedImage[];
      timestamp: number; paneNumber?: number };

export interface ChatConversation {
  id: string;
  title: string;
  messages: ConvEntry[];
  createdAt: number;
  updatedAt: number;
}

export const MAX_HISTORY = 100;
export const HISTORY_STORAGE_KEY = 'meterm-ai-history';

// ─── TabState helpers ──────────────────────────────────────
//
// The field list is the single source of truth for which properties
// on AICapsuleInstance delegate to the shared TabState. Keep in sync
// with the interface above.

export const TAB_STATE_FIELDS: Array<keyof TabState> = [
  'agent',
  'messages',
  'currentConversationId',
  'agentAbort',
  'chatPanel',
  'chatOpen',
  'chatMinimized',
  'isStreaming',
  'streamBuffer',
  'streamMsgEl',
  'reasoningBuffer',
  'chatHistoryOpen',
  'chatHistoryPanel',
  'layoutMode',
  'sidePanel',
  'sideResizeHandle',
  'sideInputArea',
  'sideInput',
  'pendingImages',
  'pendingAttachments',
];

/**
 * Install getters/setters on `target` that forward the TabState-owned
 * fields to `target.state`. Call this once, on a fresh instance. Any
 * pre-existing field values on target for these names are IGNORED
 * (the delegating accessor replaces them) — the caller is expected to
 * have already populated `target.state` with the correct initial
 * values before calling this.
 */
export function wireTabStateDelegation(target: AICapsuleInstance): void {
  for (const key of TAB_STATE_FIELDS) {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get(this: AICapsuleInstance) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (this.state as any)[key];
      },
      set(this: AICapsuleInstance, v: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.state as any)[key] = v;
      },
    });
  }
}
