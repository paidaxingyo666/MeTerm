/**
 * cmd-completion-data.ts — Dual-source Trie index for command completion.
 * Supports history commands (with frequency) and tldr command names.
 */

interface TrieNode {
  children: Map<number, TrieNode>;
  entries: { text: string; frequency: number; source: 'history' | 'tldr' }[];
}

export interface CompletionCandidate {
  text: string;
  source: 'history' | 'tldr';
  frequency: number;
}

function newNode(): TrieNode {
  return { children: new Map(), entries: [] };
}

export class CompletionIndex {
  private root: TrieNode = newNode();
  private _ready = false;

  get ready(): boolean { return this._ready; }

  /** Load history commands into the index (with frequency dedup). */
  loadHistory(commands: string[]): void {
    const freq = new Map<string, number>();
    for (const cmd of commands) {
      const trimmed = cmd.trim();
      if (trimmed.length < 2) continue;
      freq.set(trimmed, (freq.get(trimmed) ?? 0) + 1);
    }
    for (const [text, count] of freq) {
      this.insert(text, count, 'history');
    }
    this._ready = true;
  }

  /** Load tldr command names into the index. */
  loadTldr(commands: string[]): void {
    for (const cmd of commands) {
      const trimmed = cmd.trim();
      if (trimmed.length < 1) continue;
      this.insert(trimmed, 0, 'tldr');
    }
    this._ready = true;
  }

  /** Add a single history entry (runtime incremental update). */
  addHistoryEntry(command: string): void {
    const trimmed = command.trim();
    if (trimmed.length < 2) return;

    // Update existing entry frequency or insert new
    const node = this.findNode(trimmed);
    if (node) {
      const existing = node.entries.find(e => e.text === trimmed && e.source === 'history');
      if (existing) {
        existing.frequency++;
        return;
      }
    }
    this.insert(trimmed, 1, 'history');
  }

  /** Get the best completion match for a prefix. */
  getBestMatch(prefix: string): string | null {
    const candidates = this.getMatches(prefix, 1);
    return candidates.length > 0 ? candidates[0].text : null;
  }

  /** Get all matching candidates sorted by priority. */
  getMatches(prefix: string, maxResults = 10): CompletionCandidate[] {
    const trimmed = prefix.trim();
    if (trimmed.length < 2) return [];

    const node = this.findNode(trimmed);
    if (!node) return [];

    // Collect all entries from this node and descendant nodes
    const results: CompletionCandidate[] = [];
    this.collectEntries(node, trimmed, results);

    // Sort: history (by frequency desc) > tldr
    results.sort((a, b) => {
      if (a.source !== b.source) return a.source === 'history' ? -1 : 1;
      return b.frequency - a.frequency;
    });

    // Deduplicate by text
    const seen = new Set<string>();
    const unique: CompletionCandidate[] = [];
    for (const c of results) {
      if (!seen.has(c.text) && c.text !== trimmed) {
        seen.add(c.text);
        unique.push(c);
        if (unique.length >= maxResults) break;
      }
    }
    return unique;
  }

  private insert(text: string, frequency: number, source: 'history' | 'tldr'): void {
    let node = this.root;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      let child = node.children.get(code);
      if (!child) {
        child = newNode();
        node.children.set(code, child);
      }
      node = child;
    }
    // Check for existing entry
    const existing = node.entries.find(e => e.text === text && e.source === source);
    if (existing) {
      existing.frequency = Math.max(existing.frequency, frequency);
    } else {
      node.entries.push({ text, frequency, source });
    }
  }

  private findNode(prefix: string): TrieNode | null {
    let node = this.root;
    for (let i = 0; i < prefix.length; i++) {
      const child = node.children.get(prefix.charCodeAt(i));
      if (!child) return null;
      node = child;
    }
    return node;
  }

  private collectEntries(node: TrieNode, _prefix: string, results: CompletionCandidate[]): void {
    // Add entries from this node
    for (const e of node.entries) {
      results.push({ text: e.text, source: e.source, frequency: e.frequency });
    }
    // Recurse into children (limit depth for performance)
    if (results.length >= 50) return;
    for (const child of node.children.values()) {
      this.collectEntries(child, _prefix, results);
      if (results.length >= 50) return;
    }
  }
}

export const globalCompletionIndex = new CompletionIndex();
