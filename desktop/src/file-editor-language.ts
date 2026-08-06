import type { Extension } from '@codemirror/state';

/** Get language hint from filename. Returns extension or special identifier. */
function getExtFromName(name: string): string {
  const base = name.split('/').pop() || name;
  const nameMap: Record<string, string> = {
    'Dockerfile': 'dockerfile', 'Containerfile': 'dockerfile',
    'Makefile': 'sh', 'makefile': 'sh',
    '.bashrc': 'sh', '.zshrc': 'sh', '.profile': 'sh', '.bash_profile': 'sh',
    '.gitignore': 'properties', '.dockerignore': 'properties', '.editorconfig': 'properties',
    '.env': 'env', '.env.local': 'env', '.env.production': 'env',
  };
  if (nameMap[base]) return nameMap[base];
  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    const ext = base.substring(dot + 1).toLowerCase();
    if (ext !== 'txt' && ext !== 'log' && ext !== 'dat' && ext !== 'bak') return ext;
  }
  return '';
}

/** Detect language from file content when the extension is ambiguous. */
function detectLangFromContent(content: string): string {
  const first500 = content.substring(0, 500);
  const firstLine = first500.split('\n')[0].trim();

  if (firstLine.startsWith('#!')) {
    if (/python/.test(firstLine)) return 'py';
    if (/\b(bash|sh|zsh)\b/.test(firstLine)) return 'sh';
    if (/\bnode\b/.test(firstLine)) return 'js';
    if (/\bruby\b/.test(firstLine)) return 'rb';
    if (/\bperl\b/.test(firstLine)) return 'pl';
    if (/\blua\b/.test(firstLine)) return 'lua';
  }
  if (/^\s*[\[{]/.test(firstLine) && /[}\]]\s*$/.test(content.trimEnd())) return 'json';
  if (/^---\s*$/.test(firstLine) || /^\w[\w-]*:\s/.test(firstLine)) return 'yaml';
  if (/^\s*<\?xml/.test(firstLine) || /^\s*<!DOCTYPE\s+html/i.test(firstLine)) {
    return firstLine.includes('html') ? 'html' : 'xml';
  }
  if (/^\s*<[a-zA-Z]/.test(firstLine)) return 'html';
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\b/i.test(firstLine)) return 'sql';
  if (/^\s*(import\s+|export\s+|const\s+|let\s+|var\s+|function\s+|class\s+|async\s+)/.test(first500)) {
    if (/:\s*(string|number|boolean|any|void)\b/.test(first500) || /interface\s+\w+/.test(first500)) return 'ts';
    return 'js';
  }
  if (/^\s*(def\s+|class\s+|import\s+|from\s+\w+\s+import|if\s+__name__)/.test(first500)) return 'py';
  if (/^\s*(export\s+\w+=|if\s+\[|for\s+\w+\s+in\b|echo\s+)/.test(first500)) return 'sh';
  if (/^\s*package\s+\w+/.test(firstLine)) return 'go';
  if (/^\s*(fn\s+|use\s+|mod\s+|pub\s+|impl\s+|struct\s+|enum\s+)/.test(first500)) return 'rs';
  if (/^\s*(public\s+class|package\s+\w|import\s+java\.)/.test(first500)) return 'java';
  if (/^\s*<\?php/.test(firstLine)) return 'php';
  if (/^\s*#include\s+[<"]/.test(first500)) return 'cpp';
  if (/^#\s+/.test(firstLine) && /\n##?\s+/.test(first500)) return 'md';
  return '';
}

export function getEditorLanguage(fileName: string, content: string): string {
  return getExtFromName(fileName) || detectLangFromContent(content);
}

export async function getEditorLanguageExtension(ext: string): Promise<Extension> {
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return (await import('@codemirror/lang-javascript')).javascript();
    case 'jsx': return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'ts': case 'mts': case 'cts': return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case 'tsx': return (await import('@codemirror/lang-javascript')).javascript({ jsx: true, typescript: true });
    case 'py': case 'pyw': return (await import('@codemirror/lang-python')).python();
    case 'json': case 'jsonc': return (await import('@codemirror/lang-json')).json();
    case 'html': case 'htm': return (await import('@codemirror/lang-html')).html();
    case 'xml': case 'svg': case 'xsl': case 'xslt': return (await import('@codemirror/lang-xml')).xml();
    case 'css': return (await import('@codemirror/lang-css')).css();
    case 'scss': case 'sass': return (await import('@codemirror/lang-sass')).sass();
    case 'less': return (await import('@codemirror/lang-css')).css();
    case 'md': case 'markdown': case 'mdx': return (await import('@codemirror/lang-markdown')).markdown();
    case 'yaml': case 'yml': return (await import('@codemirror/lang-yaml')).yaml();
    case 'sql': return (await import('@codemirror/lang-sql')).sql();
    case 'java': return (await import('@codemirror/lang-java')).java();
    case 'kt': case 'kts': return (await import('@codemirror/lang-java')).java();
    case 'c': case 'h': return (await import('@codemirror/lang-cpp')).cpp();
    case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'hxx': return (await import('@codemirror/lang-cpp')).cpp();
    case 'php': return (await import('@codemirror/lang-php')).php();
    case 'go': return (await import('@codemirror/lang-go')).go();
    case 'rs': return (await import('@codemirror/lang-rust')).rust();
    case 'sh': case 'bash': case 'zsh': case 'fish': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { shell } = await import('@codemirror/legacy-modes/mode/shell');
      return StreamLanguage.define(shell);
    }
    case 'dockerfile': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { dockerFile } = await import('@codemirror/legacy-modes/mode/dockerfile');
      return StreamLanguage.define(dockerFile);
    }
    case 'toml': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { toml } = await import('@codemirror/legacy-modes/mode/toml');
      return StreamLanguage.define(toml);
    }
    case 'nginx': case 'conf': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { nginx } = await import('@codemirror/legacy-modes/mode/nginx');
      return StreamLanguage.define(nginx);
    }
    case 'properties': case 'ini': case 'cfg': case 'env': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { properties } = await import('@codemirror/legacy-modes/mode/properties');
      return StreamLanguage.define(properties);
    }
    case 'lua': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { lua } = await import('@codemirror/legacy-modes/mode/lua');
      return StreamLanguage.define(lua);
    }
    case 'rb': case 'ruby': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { ruby } = await import('@codemirror/legacy-modes/mode/ruby');
      return StreamLanguage.define(ruby);
    }
    case 'pl': case 'pm': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { perl } = await import('@codemirror/legacy-modes/mode/perl');
      return StreamLanguage.define(perl);
    }
    case 'r': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { r } = await import('@codemirror/legacy-modes/mode/r');
      return StreamLanguage.define(r);
    }
    case 'swift': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { swift } = await import('@codemirror/legacy-modes/mode/swift');
      return StreamLanguage.define(swift);
    }
    case 'ps1': case 'psm1': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { powerShell } = await import('@codemirror/legacy-modes/mode/powershell');
      return StreamLanguage.define(powerShell);
    }
    default: return [];
  }
}
