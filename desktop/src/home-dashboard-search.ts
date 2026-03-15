/**
 * Home Dashboard — Unified search logic.
 * Debounces input and dispatches to three sources:
 *   1. Connection filter (synchronous)
 *   2. SearXNG web search (async, if enabled)
 *   3. tldr command docs (async, if enabled)
 */
import { invoke } from '@tauri-apps/api/core';
import { loadSettings } from './themes';
import { queryTldr, getTldrCommands, type TldrQueryResult } from './tldr-help';

// ─── Types ───

export interface SearXNGResult {
  title: string;
  url: string;
  content: string;
}

export interface SearchCallbacks {
  onLeftUpdate: (query: string) => void;
  onRightUpdate: (query: string) => void;
}

export interface UnifiedSearchHandle {
  search: (query: string) => void;
  destroy: () => void;
}

// ─── SearXNG search ───

export interface SearXNGPagedResult {
  results: SearXNGResult[];
  hasMore: boolean;
}

/**
 * Search SearXNG with pagination support.
 * @param query  Search query
 * @param page   SearXNG page number (1-based), default 1
 */
export async function searchSearXNG(query: string, page = 1): Promise<SearXNGPagedResult> {
  const settings = loadSettings();
  if (!settings.searxngEnabled || !settings.searxngUrl) return { results: [], hasMore: false };

  const baseUrl = settings.searxngUrl.replace(/\/+$/, '');
  const searchUrl = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&pageno=${page}`;

  const headers: [string, string][] = [];
  if (settings.searxngUsername && settings.searxngPassword) {
    headers.push(['Authorization', 'Basic ' + btoa(`${settings.searxngUsername}:${settings.searxngPassword}`)]);
  }

  try {
    const resp = await invoke<{ ok: boolean; status: number; body: string }>('fetch_ai_models', {
      request: { url: searchUrl, headers },
    });
    if (!resp.ok) return { results: [], hasMore: false };
    const data = JSON.parse(resp.body);
    const allResults: { title?: string; url?: string; content?: string }[] = data.results ?? [];
    const results = allResults.map(r => ({
      title: r.title ?? '',
      url: r.url ?? '',
      content: (r.content ?? '').slice(0, 200),
    }));
    // SearXNG returns empty results when no more pages
    return { results, hasMore: results.length > 0 };
  } catch {
    return { results: [], hasMore: false };
  }
}

// ─── tldr search (fuzzy match command names) ───

export interface TldrSearchResult {
  command: string;
  result: TldrQueryResult;
}

export async function searchTldr(query: string): Promise<TldrSearchResult[]> {
  try {
    const commands = await getTldrCommands();
    const q = query.toLowerCase();
    const matches = commands
      .filter(c => c.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStarts = a.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.toLowerCase().startsWith(q) ? 0 : 1;
        return aStarts - bStarts || a.length - b.length;
      })
      .slice(0, 3);

    if (matches.length === 0) return [];

    const results: TldrSearchResult[] = [];
    for (const cmd of matches) {
      const result = await queryTldr(cmd);
      if (result.found && result.page) {
        results.push({ command: cmd, result });
      }
    }
    return results;
  } catch {
    return [];
  }
}

// ─── Unified search controller ───

export function createUnifiedSearch(callbacks: SearchCallbacks): UnifiedSearchHandle {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let requestId = 0;

  function search(query: string): void {
    if (debounceTimer) clearTimeout(debounceTimer);

    // Immediate: update left panel filter (synchronous)
    callbacks.onLeftUpdate(query);

    if (!query) {
      // No query: show default right panel
      callbacks.onRightUpdate('');
      return;
    }

    // Debounce async searches
    debounceTimer = setTimeout(() => {
      requestId++;
      callbacks.onRightUpdate(query);
    }, 300);
  }

  function destroy(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
  }

  return { search, destroy };
}
