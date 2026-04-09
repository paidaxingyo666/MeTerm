// ─── AI Capsule: Model Selector UI ─────────────────────────
// Pure DOM builders for the AI Bar model dropdown and label.
// Extracted from ai-capsule.ts to keep the manager class lean.

import { t } from './i18n';
import { loadSettings, saveSettings } from './themes';
import { escapeHtml } from './status-bar';
import { resolveActiveModel, resolveModel } from './ai-provider';

export function updateModelLabel(label: HTMLSpanElement): void {
  const settings = loadSettings();
  const resolved = resolveActiveModel(settings.aiProviders, settings.aiActiveModel);
  if (settings.aiActiveModel === 'auto') {
    label.textContent = t('aiModelAuto');
    label.title = resolved ? `Auto → ${resolved.entry.label}: ${resolved.model}` : 'Auto';
  } else if (resolved) {
    label.textContent = resolved.model;
    label.title = `${resolved.entry.label} · ${resolved.model}`;
  } else {
    label.textContent = t('aiModelAuto');
    label.title = 'No model configured';
  }
}

export function buildModelDropdown(dropdown: HTMLDivElement, label: HTMLSpanElement): void {
  const settings = loadSettings();
  dropdown.innerHTML = '';

  const closeDropdown = () => {
    dropdown.style.display = 'none';
    dropdown.closest('.ai-bar-model-select')?.classList.remove('open');
  };

  // Auto option
  const autoOption = document.createElement('div');
  autoOption.className = 'ai-bar-model-option';
  if (settings.aiActiveModel === 'auto') autoOption.classList.add('active');
  autoOption.innerHTML = `<span class="ai-model-opt-name">${t('aiModelAuto')}</span><span class="ai-model-opt-desc">${t('aiModelAutoDesc')}</span>`;
  autoOption.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = loadSettings();
    s.aiActiveModel = 'auto';
    saveSettings(s);
    updateModelLabel(label);
    closeDropdown();
  });
  dropdown.appendChild(autoOption);

  // Models grouped by provider
  for (const provider of settings.aiProviders) {
    // Skip providers with no API key and no enabled models
    if (!provider.apiKey && provider.enabledModels.length === 0) continue;

    const models = provider.enabledModels.length > 0
      ? provider.enabledModels
      : [resolveModel(provider.type, 'auto')];  // fallback to default model

    // Provider group header
    const sep = document.createElement('div');
    sep.className = 'ai-bar-model-separator';
    dropdown.appendChild(sep);

    const groupHeader = document.createElement('div');
    groupHeader.className = 'ai-bar-model-group-header';
    groupHeader.textContent = provider.label;
    dropdown.appendChild(groupHeader);

    // Model options
    for (const model of models) {
      const modelKey = `${provider.id}:${model}`;
      const option = document.createElement('div');
      option.className = 'ai-bar-model-option';
      if (settings.aiActiveModel === modelKey) option.classList.add('active');
      option.innerHTML = `<span class="ai-model-opt-name">${escapeHtml(model)}</span>`;
      option.addEventListener('click', (e) => {
        e.stopPropagation();
        const s = loadSettings();
        s.aiActiveModel = modelKey;
        saveSettings(s);
        updateModelLabel(label);
        closeDropdown();
      });
      dropdown.appendChild(option);
    }
  }
}
