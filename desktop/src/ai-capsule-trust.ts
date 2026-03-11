import { escapeHtml } from './status-bar';
import { loadSettings, saveSettings } from './themes';
import { t } from './i18n';
import { shieldIcon, TRUST_COLORS } from './ai-icons';
import type { AICapsuleInstance } from './ai-capsule-types';

/** Create the trust-level quick switcher button for the AI bar. */
export function createTrustSwitcher(
  capsules: Map<string, AICapsuleInstance>,
  appendSystemNotice: (inst: AICapsuleInstance, text: string) => void,
): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'ai-bar-trust-switcher';

  const settings = loadSettings();
  const level = settings.aiAgentTrustLevel ?? 0;

  const btn = document.createElement('button');
  btn.className = 'ai-bar-btn ai-bar-btn-trust';
  btn.title = `Trust Level ${level}`;
  btn.innerHTML = shieldIcon(level, 16);
  btn.dataset.level = String(level);

  const dropdown = document.createElement('div');
  dropdown.className = 'ai-trust-dropdown';
  dropdown.style.display = 'none';

  const labels = [
    { value: 0, label: t('aiAgentTrustManual'), color: TRUST_COLORS[0] },
    { value: 1, label: t('aiAgentTrustSemiAuto'), color: TRUST_COLORS[1] },
    { value: 2, label: t('aiAgentTrustFullAuto'), color: TRUST_COLORS[2] },
  ];

  const buildDropdown = () => {
    const currentLevel = loadSettings().aiAgentTrustLevel ?? 0;
    dropdown.innerHTML = '';
    for (const l of labels) {
      const item = document.createElement('div');
      item.className = `ai-trust-item ${l.value === currentLevel ? 'active' : ''}`;
      item.innerHTML = `${shieldIcon(l.value, 14)} <span>${escapeHtml(l.label)}</span>`;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const s = loadSettings();
        s.aiAgentTrustLevel = l.value;
        saveSettings(s);
        btn.innerHTML = shieldIcon(l.value, 16);
        btn.dataset.level = String(l.value);
        btn.title = `Trust Level ${l.value}`;
        dropdown.style.display = 'none';
        wrapper.classList.remove('open');
        // Notify all open capsules
        for (const [, inst] of capsules) {
          appendSystemNotice(inst,
            `── Trust level changed to Level ${l.value} ──`);
        }
      });
      dropdown.appendChild(item);
    }
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = dropdown.style.display !== 'none';
    if (isOpen) {
      dropdown.style.display = 'none';
      wrapper.classList.remove('open');
    } else {
      buildDropdown();
      dropdown.style.display = '';
      wrapper.classList.add('open');
    }
  });

  document.addEventListener('click', () => {
    dropdown.style.display = 'none';
    wrapper.classList.remove('open');
  });

  wrapper.appendChild(btn);
  wrapper.appendChild(dropdown);
  return wrapper;
}
