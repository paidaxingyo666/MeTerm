import { invoke } from '@tauri-apps/api/core';
import { getLanguage } from './i18n';

// ─── Types (mirror Rust structs) ─────────────────────────────────

export interface TldrPage {
  name: string;
  description: string;
  examples: TldrExample[];
  platform: string;
}

export interface TldrExample {
  description: string;
  command: string;
}

export interface TldrQueryResult {
  found: boolean;
  page: TldrPage | null;
  language: string;
}

export interface TldrStatus {
  initialized: boolean;
  page_count: number;
  last_updated: number | null;
}

// ─── Frontend LRU cache ─────────────────────────────────────────

const queryCache = new Map<string, TldrQueryResult>();
const CACHE_SIZE = 100;

function cacheSet(key: string, value: TldrQueryResult): void {
  if (queryCache.size >= CACHE_SIZE) {
    const oldest = queryCache.keys().next().value;
    if (oldest !== undefined) queryCache.delete(oldest);
  }
  queryCache.set(key, value);
}

// ─── Public API ─────────────────────────────────────────────────

/** Extract the main command name from a command line (strip sudo, pipes, etc.) */
export function extractCommand(input: string): string {
  let cmd = input.trim().replace(/^sudo\s+/, '').split(/[|;&]/, 1)[0].trim();
  return cmd.split(/\s+/)[0] || '';
}

/** Query tldr for a command (with frontend LRU cache) */
export async function queryTldr(command: string): Promise<TldrQueryResult> {
  const lang = getLanguage() === 'zh' ? 'zh' : 'en';
  const key = `${lang}:${command}`;

  const cached = queryCache.get(key);
  if (cached) return cached;

  try {
    const result = await invoke<TldrQueryResult>('tldr_query', { command, language: lang });
    cacheSet(key, result);
    return result;
  } catch {
    return { found: false, page: null, language: lang };
  }
}

/** Initialize tldr data (async, called at startup) */
export async function initTldr(forceUpdate = false): Promise<TldrStatus> {
  const lang = getLanguage() === 'zh' ? 'zh' : 'en';
  return invoke<TldrStatus>('tldr_init', { language: lang, forceUpdate });
}

/** Get current tldr status */
export async function getTldrStatus(): Promise<TldrStatus> {
  return invoke<TldrStatus>('tldr_status');
}

/** Get all command names (for completion index) */
export async function getTldrCommands(): Promise<string[]> {
  return invoke<string[]>('tldr_list_commands');
}

/** Format a tldr page as plain text for AI Agent context */
export function formatTldrForAgent(page: TldrPage): string {
  let text = `Command: ${page.name}\n${page.description}\n\nExamples:\n`;
  for (const ex of page.examples) {
    text += `  ${ex.description}\n  $ ${ex.command}\n\n`;
  }
  return text.trimEnd();
}
