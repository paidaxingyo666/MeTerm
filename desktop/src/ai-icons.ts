// ─── AI Agent SVG Icons ──────────────────────────────────────────
// Centralized SVG icon management for the AI Agent UI.
// All icons are inline SVG strings — no emoji, no icon fonts, no PNGs.

// ─── Tool Color Palette ──────────────────────────────────────────

export const TOOL_COLORS: Record<string, string> = {
  run_command: '#F59E0B',    // amber
  read_terminal: '#3B82F6',  // blue
  read_file: '#06B6D4',      // cyan
  write_file: '#8B5CF6',     // purple
  list_files: '#10B981',     // emerald
  search_files: '#EC4899',   // pink
};

export const STATUS_COLORS = {
  thinking: '#6B7280',  // gray
  confirm: '#EF4444',   // red
  success: '#22C55E',   // green
  error: '#EF4444',     // red
  warning: '#F59E0B',   // amber
} as const;

export const TRUST_COLORS: Record<number, string> = {
  0: '#22C55E',  // green  — manual (safest)
  1: '#F59E0B',  // amber  — semi-auto
  2: '#EF4444',  // red    — full-auto
};

// ─── Tool Icons ──────────────────────────────────────────────────

export function toolIcon(toolName: string, size = 16): string {
  const color = TOOL_COLORS[toolName] ?? '#6B7280';
  switch (toolName) {
    case 'run_command':
      return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="${color}" stroke-width="1.4"/>
        <path d="M4.5 6.5L7 8.5L4.5 10.5" stroke="${color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="8.5" y1="10.5" x2="11.5" y2="10.5" stroke="${color}" stroke-width="1.4" stroke-linecap="round"/>
      </svg>`;

    case 'read_terminal':
      return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="${color}" stroke-width="1.4"/>
        <line x1="4" y1="6" x2="12" y2="6" stroke="${color}" stroke-width="1.2" stroke-linecap="round" opacity="0.5"/>
        <line x1="4" y1="8.5" x2="10" y2="8.5" stroke="${color}" stroke-width="1.2" stroke-linecap="round" opacity="0.5"/>
        <line x1="4" y1="11" x2="8" y2="11" stroke="${color}" stroke-width="1.2" stroke-linecap="round" opacity="0.5"/>
      </svg>`;

    case 'read_file':
      return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M4 1.5h5.5L13 5v9.5a1 1 0 01-1 1H4a1 1 0 01-1-1v-13a1 1 0 011-1z" stroke="${color}" stroke-width="1.4"/>
        <path d="M9.5 1.5V5H13" stroke="${color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        <line x1="5.5" y1="8" x2="10.5" y2="8" stroke="${color}" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="5.5" y1="10.5" x2="9" y2="10.5" stroke="${color}" stroke-width="1.2" stroke-linecap="round"/>
      </svg>`;

    case 'write_file':
      return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M4 1.5h5.5L13 5v9.5a1 1 0 01-1 1H4a1 1 0 01-1-1v-13a1 1 0 011-1z" stroke="${color}" stroke-width="1.4"/>
        <path d="M9.5 1.5V5H13" stroke="${color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M7 9l3.5-3.5 1.5 1.5L8.5 10.5H7V9z" stroke="${color}" stroke-width="1.2" stroke-linejoin="round" fill="${color}" fill-opacity="0.15"/>
      </svg>`;

    case 'list_files':
      return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 4a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="${color}" stroke-width="1.4"/>
        <line x1="5" y1="7.5" x2="11" y2="7.5" stroke="${color}" stroke-width="1" stroke-linecap="round" opacity="0.5"/>
        <line x1="5" y1="10" x2="9" y2="10" stroke="${color}" stroke-width="1" stroke-linecap="round" opacity="0.5"/>
      </svg>`;

    case 'search_files':
      return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="7" cy="7" r="4.5" stroke="${color}" stroke-width="1.4"/>
        <line x1="10.2" y1="10.2" x2="13.5" y2="13.5" stroke="${color}" stroke-width="1.4" stroke-linecap="round"/>
      </svg>`;

    default:
      return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="8" cy="8" r="6" stroke="${color}" stroke-width="1.4"/>
        <path d="M6 6.5a2 2 0 013.5 1.5c0 1-1.5 1.5-1.5 1.5" stroke="${color}" stroke-width="1.3" stroke-linecap="round"/>
        <circle cx="8" cy="11.5" r="0.5" fill="${color}"/>
      </svg>`;
  }
}

// ─── Status Icons ────────────────────────────────────────────────

export function statusIcon(status: 'success' | 'error' | 'warning', size = 14): string {
  switch (status) {
    case 'success':
      return `<svg width="${size}" height="${size}" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="7" cy="7" r="6" stroke="${STATUS_COLORS.success}" stroke-width="1.4"/>
        <path d="M4.5 7L6.5 9L9.5 5" stroke="${STATUS_COLORS.success}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;

    case 'error':
      return `<svg width="${size}" height="${size}" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="7" cy="7" r="6" stroke="${STATUS_COLORS.error}" stroke-width="1.4"/>
        <path d="M5 5L9 9M9 5L5 9" stroke="${STATUS_COLORS.error}" stroke-width="1.4" stroke-linecap="round"/>
      </svg>`;

    case 'warning':
      return `<svg width="${size}" height="${size}" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M7 1.5L13 12.5H1L7 1.5z" stroke="${STATUS_COLORS.warning}" stroke-width="1.3" stroke-linejoin="round"/>
        <line x1="7" y1="5.5" x2="7" y2="9" stroke="${STATUS_COLORS.warning}" stroke-width="1.3" stroke-linecap="round"/>
        <circle cx="7" cy="10.8" r="0.6" fill="${STATUS_COLORS.warning}"/>
      </svg>`;
  }
}

// ─── Animated Icons ──────────────────────────────────────────────

/** Pulsing dot — used for "thinking" / "executing" states */
export function pulseIcon(color: string, size = 12): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg">
    <circle cx="6" cy="6" r="3" fill="${color}">
      <animate attributeName="opacity" values="1;0.3;1" dur="1.4s" repeatCount="indefinite"/>
      <animate attributeName="r" values="3;4.5;3" dur="1.4s" repeatCount="indefinite"/>
    </circle>
  </svg>`;
}

/** Spinning loader — used for in-progress tool execution */
export function spinnerIcon(color: string, size = 14): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 14 14" xmlns="http://www.w3.org/2000/svg">
    <circle cx="7" cy="7" r="5" stroke="${color}" stroke-width="1.8" fill="none"
      stroke-dasharray="20 12" stroke-linecap="round">
      <animateTransform attributeName="transform" type="rotate"
        values="0 7 7;360 7 7" dur="0.75s" repeatCount="indefinite"/>
    </circle>
  </svg>`;
}

/** Thinking brain icon with pulse */
export function thinkingIcon(size = 16): string {
  const c = STATUS_COLORS.thinking;
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 12V11C3.5 10.5 2.5 9 2.5 7.5A4.5 4.5 0 017 3h2a4.5 4.5 0 014.5 4.5c0 1.5-1 3-2.5 3.5V12" stroke="${c}" stroke-width="1.3" stroke-linecap="round"/>
    <line x1="5.5" y1="14" x2="10.5" y2="14" stroke="${c}" stroke-width="1.3" stroke-linecap="round"/>
    <circle cx="8" cy="7" r="1" fill="${c}">
      <animate attributeName="opacity" values="1;0.3;1" dur="1.4s" repeatCount="indefinite"/>
    </circle>
  </svg>`;
}

// ─── Trust Level Shield Icons ────────────────────────────────────

export function shieldIcon(level: number, size = 16): string {
  const color = TRUST_COLORS[level] ?? TRUST_COLORS[0];
  const fillOpacity = level === 0 ? '0.2' : level === 1 ? '0.1' : '0';
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M8 1.5L2.5 4v4c0 3.5 2.5 5.5 5.5 6.5 3-1 5.5-3 5.5-6.5V4L8 1.5z"
      stroke="${color}" stroke-width="1.4" fill="${color}" fill-opacity="${fillOpacity}"/>
    <text x="8" y="10.5" text-anchor="middle" font-size="7" font-weight="600" fill="${color}">${level}</text>
  </svg>`;
}

// ─── Action Button Icons ─────────────────────────────────────────

/** Stop button (square) */
export function stopIcon(size = 14): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="3" y="3" width="8" height="8" rx="1" fill="currentColor" opacity="0.8"/>
  </svg>`;
}

/** Approve (checkmark) */
export function approveIcon(size = 14): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 7.5L5.5 10L11 4" stroke="${STATUS_COLORS.success}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/** Reject (cross) */
export function rejectIcon(size = 14): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 4L10 10M10 4L4 10" stroke="${STATUS_COLORS.error}" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}

/** Edit (pencil) */
export function editIcon(size = 14): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2 10.5V12h1.5L10 5.5 8.5 4 2 10.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
    <path d="M8.5 4L10 2.5 11.5 4 10 5.5 8.5 4z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
  </svg>`;
}

/** Collapse/Expand chevron */
export function chevronIcon(direction: 'right' | 'down', size = 12): string {
  const d = direction === 'right' ? 'M4 2L9 6L4 10' : 'M2 4L6 9L10 4';
  return `<svg width="${size}" height="${size}" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="${d}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}
