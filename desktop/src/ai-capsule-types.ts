import { AIAgent } from './ai-agent';

export interface HistoryEntry {
  command: string;
  timestamp: number;
  source: 'manual' | 'ai';
}

export interface AICapsuleInstance {
  sessionId: string;
  historyKey: string;
  element: HTMLDivElement;
  messages: ConvEntry[];
  selectedModel: string;
  history: HistoryEntry[];
  lineBuffer: string;
  unsubInput: (() => void) | null;
  unsubShellIdle: (() => void) | null;
  historyOpen: boolean;
  // AI chat state
  agent: AIAgent;
  chatPanel: HTMLDivElement | null;
  chatOpen: boolean;
  chatMinimized: boolean;
  isStreaming: boolean;
  streamBuffer: string;
  streamMsgEl: HTMLDivElement | null;
  reasoningBuffer: string;
  // LLM chat history panel state
  chatHistoryOpen: boolean;
  chatHistoryPanel: HTMLDivElement | null;
  currentConversationId: string;
}

/** Discriminated-union entry stored per conversation turn */
export type ConvEntry =
  | { type: 'user';      content: string; timestamp: number }
  | { type: 'thinking';  content: string; reasoning?: string; timestamp: number }
  | { type: 'assistant'; content: string; timestamp: number }
  | { type: 'system';    content: string; timestamp: number }
  | { type: 'tool_call'; toolName: string; args: Record<string, unknown>;
      result: string | null; isError: boolean; timestamp: number };

export interface ChatConversation {
  id: string;
  title: string;
  messages: ConvEntry[];
  createdAt: number;
  updatedAt: number;
}

export const MAX_HISTORY = 100;
export const HISTORY_STORAGE_KEY = 'meterm-ai-history';
