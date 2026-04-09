// ─── AI Tools: Meta / Information Tools ─────────────────────────
// web_search (SearXNG) and command_help (tldr)
// Non-terminal-interactive tools that fetch information.

import { invoke } from '@tauri-apps/api/core';
import { loadSettings } from './themes';
import { queryTldr, formatTldrForAgent } from './tldr-help';
import { ToolHandler } from './ai-tools-core';

// ─── web_search (SearXNG) ───────────────────────────────────────

export function createWebSearchTool(): ToolHandler {
  return {
    definition: {
      name: 'web_search',
      description:
        'Search the web via SearXNG. Use ONLY when: (a) user explicitly asks to search, ' +
        '(b) you encounter an unknown command or error, or (c) you need current/real-time information. ' +
        'IMPORTANT: Always narrow scope with the `sites` parameter when context implies specific sources. Examples:\n' +
        '- Open-source tool / GitHub repo → sites: ["github.com"]\n' +
        '- Python package → sites: ["pypi.org","github.com","stackoverflow.com"]\n' +
        '- npm/node → sites: ["npmjs.com","github.com","stackoverflow.com"]\n' +
        '- Docker → sites: ["hub.docker.com","github.com"]\n' +
        '- Command help → sites: ["man7.org","ss64.com","stackoverflow.com"]\n' +
        '- General/unclear → omit sites',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords (concise)' },
          sites: { type: 'string', description: 'Comma-separated domains to restrict results (e.g. "github.com,stackoverflow.com"). Omit for unrestricted.' },
          language: { type: 'string', description: 'Result language code (en, zh, etc.). Default: auto' },
        },
        required: ['query'],
      },
    },
    execute: async (args) => {
      const settings = loadSettings();
      if (!settings.searxngEnabled || !settings.searxngUrl) {
        return 'Web search is not configured. Ask the user to set up SearXNG in Settings > AI.';
      }

      const query = String(args.query ?? '').trim();
      if (!query) return 'Empty search query.';

      // Build query with site filters
      const sitesRaw = String(args.sites ?? '').trim();
      const sites = sitesRaw ? sitesRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
      let finalQuery = query;
      if (sites.length > 0) {
        finalQuery += ' ' + sites.map(s => `site:${s}`).join(' OR ');
      }

      const baseUrl = settings.searxngUrl.replace(/\/+$/, '');
      const searchUrl = `${baseUrl}/search?q=${encodeURIComponent(finalQuery)}&format=json` +
        (args.language ? `&language=${encodeURIComponent(String(args.language))}` : '');

      const headers: [string, string][] = [];
      if (settings.searxngUsername && settings.searxngPassword) {
        headers.push(['Authorization', 'Basic ' + btoa(`${settings.searxngUsername}:${settings.searxngPassword}`)]);
      }

      try {
        const fetchPromise = invoke<{ ok: boolean; status: number; body: string }>('fetch_ai_models', {
          request: { url: searchUrl, headers },
        });
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Search request timed out (10s)')), 10_000),
        );
        const resp = await Promise.race([fetchPromise, timeoutPromise]);

        if (!resp.ok) return `Search request failed (HTTP ${resp.status}).`;

        const data = JSON.parse(resp.body);
        let results: { title?: string; url?: string; content?: string }[] = data.results ?? [];

        // Post-filter by domain if sites specified
        if (sites.length > 0) {
          const domains = sites.map(s => s.toLowerCase());
          results = results.filter(r => {
            try {
              const host = new URL(String(r.url)).hostname.toLowerCase();
              return domains.some(d => host === d || host.endsWith('.' + d));
            } catch { return false; }
          });
        }

        results = results.slice(0, 8);
        if (results.length === 0) return 'No results found.';

        return results.map((r, i) => {
          const snippet = (r.content ?? '').slice(0, 200);
          return `[${i + 1}] ${r.title ?? '(no title)'}\n    ${r.url}\n    ${snippet}`;
        }).join('\n\n');
      } catch (e) {
        return `Search error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    // web_search is a network read → safe to parallelize.
    isConcurrencySafe: true,
    requiresConfirm: () => false,
    isDestructive: () => false,
  };
}

// ─── command_help (tldr) ────────────────────────────────────────

export function createCommandHelpTool(): ToolHandler {
  return {
    definition: {
      name: 'command_help',
      description: 'Look up usage examples and documentation for a CLI command using the tldr database. Returns a concise help page with common usage patterns. Use this when you need to recall command syntax or flags.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command name to look up (e.g. "tar", "docker", "ffmpeg")' },
        },
        required: ['command'],
      },
    },
    async execute(args): Promise<string> {
      const cmd = String(args.command ?? '').trim();
      if (!cmd) return 'Error: command name is required.';
      const result = await queryTldr(cmd);
      if (!result.found || !result.page) return `No tldr page found for "${cmd}".`;
      return formatTldrForAgent(result.page);
    },
    // command_help is a pure lookup → safe to parallelize.
    isConcurrencySafe: true,
    requiresConfirm: () => false,
    isDestructive: () => false,
  };
}
