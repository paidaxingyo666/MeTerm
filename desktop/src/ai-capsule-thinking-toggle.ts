// ─── AI Capsule: Thinking-mode toggle ──────────────────────
// Quick on/off button for `aiEnableThinking`. Mirrors the trust
// switcher's wiring so it can be mounted in both the bottom-mode
// AI bar and the side panel.

import { loadSettings, saveSettings } from './themes';
import { t } from './i18n';
import type { AICapsuleInstance } from './ai-capsule-types';

/** Brain icon — outline when off, filled-ish when on. */
const ICON_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 2.5a2 2 0 0 0-2 2v.4a2 2 0 0 0-1 3.5 2 2 0 0 0 1 3.3v.3a2 2 0 0 0 2 2 1.5 1.5 0 0 0 2.5-1V4a1.5 1.5 0 0 0-2.5-1.5z"/><path d="M10.5 2.5a2 2 0 0 1 2 2v.4a2 2 0 0 1 1 3.5 2 2 0 0 1-1 3.3v.3a2 2 0 0 1-2 2 1.5 1.5 0 0 1-2.5-1V4a1.5 1.5 0 0 1 2.5-1.5z"/></svg>`;

/**
 * Build the thinking-mode quick-toggle button.
 *
 * Switching is per-request on the API side (DeepSeek / Qwen / GLM /
 * MiMo all treat `enable_thinking` / `thinking.type` as a per-call
 * flag), so flipping mid-conversation is safe — the next LLM call
 * picks up the new value.
 */
export function createThinkingToggle(
  capsules: Map<string, AICapsuleInstance>,
  appendSystemNotice: (inst: AICapsuleInstance, text: string) => void,
): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'ai-bar-thinking-toggle';

  const btn = document.createElement('button');
  btn.className = 'ai-bar-btn ai-bar-btn-thinking';
  btn.innerHTML = ICON_SVG;

  const sync = () => {
    const on = loadSettings().aiEnableThinking;
    btn.classList.toggle('active', on);
    const state = on ? t('aiThinkingOn') : t('aiThinkingOff');
    btn.title = `${t('aiEnableThinking')} · ${state}\n${t('aiEnableThinkingHint')}`;
    btn.dataset.state = on ? 'on' : 'off';
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = loadSettings();
    s.aiEnableThinking = !s.aiEnableThinking;
    saveSettings(s);
    sync();
    const label = s.aiEnableThinking ? t('aiThinkingOn') : t('aiThinkingOff');
    for (const [, inst] of capsules) {
      appendSystemNotice(inst, `── ${label} ──`);
    }
  });

  sync();
  wrapper.appendChild(btn);
  return wrapper;
}
