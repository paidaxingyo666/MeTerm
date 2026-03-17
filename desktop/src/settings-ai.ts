import { AppSettings } from './themes';
import { t } from './i18n';
import { invoke } from '@tauri-apps/api/core';
import { PROVIDER_PRESETS, fetchModels, type ProviderType, type AIProviderEntry } from './ai-provider';
import { createSettingsSelect } from './custom-select';

export function createAITab(
  current: AppSettings,
  update: (patch: Partial<AppSettings>) => void,
): HTMLDivElement {
  const tabAI = document.createElement('div');

  // Provider cards container
  const providerList = document.createElement('div');
  providerList.className = 'ai-provider-list';
  tabAI.appendChild(providerList);

  function syncProviderInput(el: HTMLInputElement | HTMLSelectElement): void {
    el.addEventListener('keydown', (e) => e.stopPropagation());
    el.addEventListener('keyup', (e) => e.stopPropagation());
    el.addEventListener('keypress', (e) => e.stopPropagation());
  }

  function renderProviderCards(): void {
    providerList.innerHTML = '';
    const providers = current.aiProviders;

    for (let idx = 0; idx < providers.length; idx++) {
      const entry = providers[idx];
      const card = document.createElement('div');
      card.className = 'ai-provider-card';

      // Card header
      const header = document.createElement('div');
      header.className = 'ai-provider-card-header';

      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.className = 'ai-provider-label-input';
      labelInput.value = entry.label;
      syncProviderInput(labelInput);
      labelInput.onchange = () => {
        entry.label = labelInput.value.trim() || entry.label;
        update({ aiProviders: [...providers] });
      };

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'ai-provider-delete-btn';
      deleteBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`;
      deleteBtn.title = t('aiDeleteProvider');
      deleteBtn.onclick = () => {
        providers.splice(idx, 1);
        update({ aiProviders: [...providers] });
        renderProviderCards();
      };

      header.appendChild(labelInput);
      if (providers.length > 1) header.appendChild(deleteBtn);

      // Card body
      const body = document.createElement('div');
      body.className = 'ai-provider-card-body';

      // Protocol + Base URL (two-column row)
      const protoUrlRow = document.createElement('div');
      protoUrlRow.className = 'ai-provider-row ai-row-inline';
      const protoSelect = createSettingsSelect([
        { value: 'openai', label: 'OpenAI', selected: entry.type === 'openai' },
        { value: 'anthropic', label: 'Anthropic', selected: entry.type === 'anthropic' },
        { value: 'gemini', label: 'Gemini', selected: entry.type === 'gemini' },
      ]);
      protoSelect.el.style.width = 'auto';
      protoSelect.el.style.flex = 'none';
      protoSelect.onchange = () => {
        entry.type = protoSelect.value as ProviderType;
        entry.models = [];
        entry.enabledModels = [];
        update({ aiProviders: [...providers] });
        renderProviderCards();
      };
      const urlInput = document.createElement('input');
      urlInput.type = 'text';
      urlInput.className = 'settings-input';
      urlInput.style.flex = '1';
      urlInput.value = entry.baseUrl;
      urlInput.placeholder = 'https://api.openai.com';
      syncProviderInput(urlInput);
      urlInput.onchange = () => {
        entry.baseUrl = urlInput.value.trim();
        update({ aiProviders: [...providers] });
      };
      protoUrlRow.appendChild(protoSelect.el);
      protoUrlRow.appendChild(urlInput);
      body.appendChild(protoUrlRow);

      // API Key + Fetch Models (single row: key input + eye + fetch btn + status)
      const keyFetchRow = document.createElement('div');
      keyFetchRow.className = 'ai-provider-row ai-row-inline';
      const keyGroup = document.createElement('div');
      keyGroup.className = 'settings-input-group';
      keyGroup.style.flex = '1';
      const keyInput = document.createElement('input');
      keyInput.type = 'password';
      keyInput.className = 'settings-input';
      keyInput.style.flex = '1';
      keyInput.value = entry.apiKey;
      keyInput.placeholder = 'API Key';
      syncProviderInput(keyInput);
      keyInput.onchange = () => {
        entry.apiKey = keyInput.value.trim();
        update({ aiProviders: [...providers] });
      };
      const keyToggle = document.createElement('button');
      keyToggle.className = 'settings-toggle-btn';
      keyToggle.title = 'Show/Hide';
      keyToggle.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2.5"/></svg>`;
      keyToggle.onclick = () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; };
      keyGroup.appendChild(keyInput);
      keyGroup.appendChild(keyToggle);
      const fetchBtn = document.createElement('button');
      fetchBtn.className = 'settings-select settings-test-btn';
      fetchBtn.textContent = t('aiFetchModels');
      const fetchStatus = document.createElement('span');
      fetchStatus.className = 'settings-test-result';
      if (entry.models.length > 0) {
        fetchStatus.textContent = `${entry.models.length} ${t('aiModelsCount')}`;
        fetchStatus.className = 'settings-test-result test-success';
      }
      fetchBtn.onclick = async () => {
        entry.apiKey = keyInput.value.trim();
        entry.baseUrl = urlInput.value.trim();
        fetchBtn.disabled = true;
        fetchStatus.textContent = t('aiFetching');
        fetchStatus.className = 'settings-test-result';
        try {
          const models = await fetchModels(entry);
          entry.models = models;
          entry.enabledModels = entry.enabledModels.filter((m) => models.includes(m));
          update({ aiProviders: [...providers] });
          fetchStatus.textContent = `${models.length} ${t('aiFetchSuccess')}`;
          fetchStatus.className = 'settings-test-result test-success';
          renderModelCheckboxes();
        } catch (e) {
          fetchStatus.textContent = `${t('aiFetchFailed')}: ${(e as Error).message}`;
          fetchStatus.className = 'settings-test-result test-failed';
        }
        fetchBtn.disabled = false;
      };
      keyFetchRow.appendChild(keyGroup);
      keyFetchRow.appendChild(fetchBtn);
      keyFetchRow.appendChild(fetchStatus);
      body.appendChild(keyFetchRow);

      // Model checkboxes
      const modelArea = document.createElement('div');
      modelArea.className = 'ai-provider-models';

      function renderModelCheckboxes(): void {
        modelArea.innerHTML = '';
        if (entry.models.length === 0) {
          const hint = document.createElement('div');
          hint.className = 'ai-provider-models-hint';
          hint.textContent = t('aiNoModels');
          modelArea.appendChild(hint);
          return;
        }

        const modelsLabel = document.createElement('label');
        modelsLabel.className = 'ai-provider-models-label';
        modelsLabel.textContent = t('aiSelectModels');
        modelArea.appendChild(modelsLabel);

        const grid = document.createElement('div');
        grid.className = 'ai-provider-models-grid';
        for (const model of entry.models) {
          const label = document.createElement('label');
          label.className = 'ai-model-checkbox';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = entry.enabledModels.includes(model);
          cb.onchange = () => {
            if (cb.checked) {
              if (!entry.enabledModels.includes(model)) entry.enabledModels.push(model);
            } else {
              entry.enabledModels = entry.enabledModels.filter((m) => m !== model);
            }
            update({ aiProviders: [...providers] });
          };
          const span = document.createElement('span');
          span.textContent = model;
          span.title = model;
          label.appendChild(cb);
          label.appendChild(span);
          grid.appendChild(label);
        }
        modelArea.appendChild(grid);
      }
      renderModelCheckboxes();
      body.appendChild(modelArea);

      card.appendChild(header);
      card.appendChild(body);
      providerList.appendChild(card);
    }
  }

  renderProviderCards();

  // Add provider button
  const addProviderSection = document.createElement('div');
  addProviderSection.className = 'settings-section ai-add-provider-section';
  const addBtnContainer = document.createElement('div');
  addBtnContainer.className = 'settings-preset-buttons';

  // Presets for adding (only show ones not already added by default id)
  const addPresets = [...PROVIDER_PRESETS, { id: 'custom', label: t('aiCustomProvider'), type: 'openai' as ProviderType, baseUrl: '', model: '' }];
  for (const preset of addPresets) {
    const btn = document.createElement('button');
    btn.className = 'settings-preset-btn';
    btn.textContent = `+ ${preset.label}`;
    btn.addEventListener('click', () => {
      const newId = `${preset.id}-${Date.now().toString(36)}`;
      const newEntry: AIProviderEntry = {
        id: newId,
        type: preset.type,
        label: preset.label,
        apiKey: '',
        baseUrl: preset.baseUrl,
        models: [],
        enabledModels: [],
      };
      current.aiProviders.push(newEntry);
      update({ aiProviders: [...current.aiProviders] });
      renderProviderCards();
    });
    addBtnContainer.appendChild(btn);
  }
  addProviderSection.innerHTML = `<label>${t('aiAddProvider')}</label>`;
  addProviderSection.appendChild(addBtnContainer);
  tabAI.appendChild(addProviderSection);

  // --- Common AI Settings (compact inline layout) ---
  const aiSettingsWrap = document.createElement('div');
  aiSettingsWrap.className = 'ai-settings-compact';

  // Helper: create an inline slider row
  const mkSliderRow = (label: string, id: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, onChange: (v: number) => void) => {
    const row = document.createElement('div');
    row.className = 'ai-slider-row';
    row.innerHTML = `
      <label>${label}</label>
      <input type="range" class="settings-slider" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}">
      <span class="ai-slider-value">${fmt(value)}</span>
    `;
    const slider = row.querySelector(`#${id}`) as HTMLInputElement;
    const valSpan = row.querySelector('.ai-slider-value') as HTMLSpanElement;
    slider.oninput = () => {
      const v = parseFloat(slider.value);
      valSpan.textContent = fmt(v);
      onChange(v);
    };
    return row;
  };

  aiSettingsWrap.appendChild(mkSliderRow(t('aiTemperature'), 'ai-temp-slider', 0, 20, 1, Math.round(current.aiTemperature * 10),
    (v) => (v / 10).toFixed(1), (v) => update({ aiTemperature: v / 10 })));
  aiSettingsWrap.appendChild(mkSliderRow(t('aiMaxTokens'), 'ai-tokens-slider', 256, 16384, 256, current.aiMaxTokens,
    (v) => `${v}`, (v) => update({ aiMaxTokens: v })));
  aiSettingsWrap.appendChild(mkSliderRow(t('aiContextLines'), 'ai-context-slider', 10, 200, 10, current.aiContextLines,
    (v) => `${v}`, (v) => update({ aiContextLines: v })));

  // Agent divider
  const agentDivider = document.createElement('hr');
  agentDivider.className = 'settings-divider';
  aiSettingsWrap.appendChild(agentDivider);

  // Agent Trust Level (icon buttons) — inline
  const trustSection = document.createElement('div');
  trustSection.className = 'ai-slider-row';
  const trustLevels = [
    { value: 0, label: t('aiAgentTrustManual'), icon: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5L2.5 4v4c0 3.5 2.3 5.5 5.5 7 3.2-1.5 5.5-3.5 5.5-7V4L8 1.5z"/><rect x="6" y="6.5" width="4" height="3.5" rx="0.5"/><path d="M7 6.5V5.5a1 1 0 0 1 2 0v1"/></svg>` },
    { value: 1, label: t('aiAgentTrustSemiAuto'), icon: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5L2.5 4v4c0 3.5 2.3 5.5 5.5 7 3.2-1.5 5.5-3.5 5.5-7V4L8 1.5z"/><path d="M5.5 8.5l2 2 3-3.5"/></svg>` },
    { value: 2, label: t('aiAgentTrustFullAuto'), icon: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5L2.5 4v4c0 3.5 2.3 5.5 5.5 7 3.2-1.5 5.5-3.5 5.5-7V4L8 1.5z"/><path d="M9 5L6.5 9H9l-.5 3"/></svg>` },
  ];
  trustSection.innerHTML = `<label>${t('aiAgentTrustLevel')}</label>`;
  const trustGroup = document.createElement('div');
  trustGroup.className = 'ai-trust-group';
  for (const lvl of trustLevels) {
    const btn = document.createElement('button');
    btn.className = 'ai-trust-btn' + (current.aiAgentTrustLevel === lvl.value ? ' active' : '');
    btn.title = lvl.label;
    btn.innerHTML = lvl.icon;
    btn.dataset.value = String(lvl.value);
    btn.addEventListener('click', () => {
      trustGroup.querySelectorAll('.ai-trust-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      update({ aiAgentTrustLevel: lvl.value });
    });
    trustGroup.appendChild(btn);
  }
  trustSection.appendChild(trustGroup);
  aiSettingsWrap.appendChild(trustSection);

  // Agent Max Iterations slider + Unlimited checkbox
  const isUnlimited = current.aiAgentMaxIterations === 0;
  const iterRow = mkSliderRow(t('aiAgentMaxIterations'), 'ai-iter-slider', 1, 30, 1,
    isUnlimited ? 15 : current.aiAgentMaxIterations,
    (v) => `${v}`, (v) => update({ aiAgentMaxIterations: v }));
  const iterSlider = iterRow.querySelector('#ai-iter-slider') as HTMLInputElement;
  const iterValSpan = iterRow.querySelector('.ai-slider-value') as HTMLSpanElement;

  const unlimitedLabel = document.createElement('label');
  unlimitedLabel.className = 'ai-unlimited-label';
  unlimitedLabel.innerHTML = `<input type="checkbox" id="ai-iter-unlimited" ${isUnlimited ? 'checked' : ''}> ${t('aiAgentUnlimited')}`;
  iterRow.appendChild(unlimitedLabel);

  const unlimitedCb = unlimitedLabel.querySelector('#ai-iter-unlimited') as HTMLInputElement;
  if (isUnlimited) {
    iterSlider.disabled = true;
    iterValSpan.textContent = '∞';
  }
  unlimitedCb.onchange = () => {
    if (unlimitedCb.checked) {
      iterSlider.disabled = true;
      iterValSpan.textContent = '∞';
      update({ aiAgentMaxIterations: 0 });
    } else {
      iterSlider.disabled = false;
      const v = parseFloat(iterSlider.value);
      iterValSpan.textContent = `${v}`;
      update({ aiAgentMaxIterations: v });
    }
  };
  aiSettingsWrap.appendChild(iterRow);

  tabAI.appendChild(aiSettingsWrap);

  // --- SearXNG Web Search ---
  const searxDivider = document.createElement('hr');
  searxDivider.className = 'settings-divider';
  tabAI.appendChild(searxDivider);

  const searxngSection = document.createElement('div');
  searxngSection.className = 'ai-settings-compact';
  searxngSection.innerHTML = `<label class="settings-section-title">${t('aiSearxng')}</label>`;

  // URL — inline
  const searxUrlRow = document.createElement('div');
  searxUrlRow.className = 'ai-provider-row ai-row-inline';
  searxUrlRow.innerHTML = `<label>${t('aiSearxngUrl')}</label>`;
  const searxUrlInput = document.createElement('input');
  searxUrlInput.type = 'text';
  searxUrlInput.className = 'settings-input';
  searxUrlInput.value = current.searxngUrl;
  searxUrlInput.placeholder = t('aiSearxngUrlPlaceholder');
  searxUrlInput.addEventListener('change', () => {
    let val = searxUrlInput.value.trim();
    if (val.endsWith('/')) val = val.slice(0, -1);
    searxUrlInput.value = val;
    update({ searxngUrl: val });
  });
  searxUrlRow.appendChild(searxUrlInput);
  searxngSection.appendChild(searxUrlRow);

  // Auth — inline (label + user + pass + eye)
  const searxAuthRow = document.createElement('div');
  searxAuthRow.className = 'ai-provider-row ai-row-inline';
  searxAuthRow.innerHTML = `<label>Auth</label>`;
  const searxAuthGroup = document.createElement('div');
  searxAuthGroup.className = 'settings-input-group';
  searxAuthGroup.style.cssText = 'flex:1;min-width:0';
  const searxUserInput = document.createElement('input');
  searxUserInput.type = 'text';
  searxUserInput.className = 'settings-input';
  searxUserInput.style.flex = '1';
  searxUserInput.value = current.searxngUsername;
  searxUserInput.placeholder = t('aiSearxngUsername');
  searxUserInput.autocomplete = 'off';
  searxUserInput.addEventListener('change', () => update({ searxngUsername: searxUserInput.value.trim() }));
  const searxPassInput = document.createElement('input');
  searxPassInput.type = 'password';
  searxPassInput.className = 'settings-input';
  searxPassInput.style.flex = '1';
  searxPassInput.value = current.searxngPassword;
  searxPassInput.placeholder = t('aiSearxngPassword');
  searxPassInput.autocomplete = 'off';
  searxPassInput.addEventListener('change', () => update({ searxngPassword: searxPassInput.value }));
  const searxPassToggle = document.createElement('button');
  searxPassToggle.className = 'settings-toggle-btn';
  searxPassToggle.title = 'Show/Hide';
  searxPassToggle.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2.5"/></svg>`;
  searxPassToggle.onclick = () => { searxPassInput.type = searxPassInput.type === 'password' ? 'text' : 'password'; };
  searxAuthGroup.appendChild(searxUserInput);
  searxAuthGroup.appendChild(searxPassInput);
  searxAuthGroup.appendChild(searxPassToggle);
  searxAuthRow.appendChild(searxAuthGroup);
  searxngSection.appendChild(searxAuthRow);

  // Test + Enable — single row
  const searxActionRow = document.createElement('div');
  searxActionRow.className = 'ai-provider-row ai-row-inline';
  searxActionRow.style.justifyContent = 'space-between';
  const searxTestBtn = document.createElement('button');
  searxTestBtn.className = 'settings-select settings-test-btn';
  searxTestBtn.textContent = t('aiSearxngTest');
  const searxTestStatus = document.createElement('span');
  searxTestStatus.className = 'settings-test-result';
  searxTestBtn.addEventListener('click', async () => {
    let url = searxUrlInput.value.trim().replace(/\/+$/, '');
    if (!url) return;
    searxTestBtn.disabled = true;
    searxTestStatus.textContent = t('aiTesting');
    searxTestStatus.className = 'settings-test-result';
    try {
      const headers: [string, string][] = [];
      const user = searxUserInput.value.trim();
      const pass = searxPassInput.value;
      if (user && pass) {
        headers.push(['Authorization', 'Basic ' + btoa(`${user}:${pass}`)]);
      }
      const resp = await invoke<{ ok: boolean; status: number; body: string }>('fetch_ai_models', {
        request: { url: `${url}/search?q=test&format=json`, headers },
      });
      if (!resp.ok) {
        searxTestStatus.textContent = `${t('aiSearxngTestFail')} (HTTP ${resp.status})`;
        searxTestStatus.className = 'settings-test-result test-fail';
        searxTestBtn.disabled = false;
        return;
      }
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(resp.body);
      } catch {
        // Response is not JSON — SearXNG may not have JSON format enabled
        const isHtml = resp.body.trimStart().startsWith('<');
        searxTestStatus.textContent = isHtml
          ? `${t('aiSearxngTestFail')}: JSON API not enabled in SearXNG settings.yml (search.formats)`
          : `${t('aiSearxngTestFail')}: invalid JSON response`;
        searxTestStatus.className = 'settings-test-result test-fail';
        searxTestBtn.disabled = false;
        return;
      }
      if (data.results !== undefined) {
        searxTestStatus.textContent = t('aiSearxngTestOk');
        searxTestStatus.className = 'settings-test-result test-success';
      } else {
        searxTestStatus.textContent = `${t('aiSearxngTestFail')}: response missing "results" field`;
        searxTestStatus.className = 'settings-test-result test-fail';
      }
    } catch (e) {
      searxTestStatus.textContent = `${t('aiSearxngTestFail')}: ${e instanceof Error ? e.message : String(e)}`;
      searxTestStatus.className = 'settings-test-result test-fail';
    }
    searxTestBtn.disabled = false;
  });
  const searxTestGroup = document.createElement('div');
  searxTestGroup.className = 'settings-input-group';
  searxTestGroup.appendChild(searxTestBtn);
  searxTestGroup.appendChild(searxTestStatus);
  searxActionRow.appendChild(searxTestGroup);

  // Enable checkbox (right side of same row)
  const searxEnableLabel = document.createElement('label');
  searxEnableLabel.className = 'settings-radio-label';
  searxEnableLabel.innerHTML = `<input type="checkbox" id="searxng-enable" ${current.searxngEnabled ? 'checked' : ''}> ${t('aiSearxngEnable')}`;
  searxActionRow.appendChild(searxEnableLabel);

  const searxEnableCheck = searxEnableLabel.querySelector('#searxng-enable') as HTMLInputElement;
  searxEnableCheck.addEventListener('change', () => update({ searxngEnabled: searxEnableCheck.checked }));

  searxngSection.appendChild(searxActionRow);
  tabAI.appendChild(searxngSection);

  // --- tldr & Command Completion ---
  const tldrDivider = document.createElement('hr');
  tldrDivider.className = 'settings-divider';
  tabAI.appendChild(tldrDivider);

  const tldrSection = document.createElement('div');
  tldrSection.className = 'ai-settings-compact';
  tldrSection.innerHTML = `<label class="settings-section-title">${t('tldrHelp')}</label>`;

  // Enable tldr checkbox + status
  const tldrEnableRow = document.createElement('div');
  tldrEnableRow.className = 'ai-provider-row ai-row-inline';
  const tldrEnableLabel = document.createElement('label');
  tldrEnableLabel.className = 'settings-radio-label';
  tldrEnableLabel.innerHTML = `<input type="checkbox" id="tldr-enable" ${current.tldrEnabled ? 'checked' : ''}> ${t('tldrEnable')}`;
  tldrEnableRow.appendChild(tldrEnableLabel);

  const tldrStatusSpan = document.createElement('span');
  tldrStatusSpan.className = 'settings-test-result';
  tldrEnableRow.appendChild(tldrStatusSpan);

  const tldrUpdateBtn = document.createElement('button');
  tldrUpdateBtn.className = 'settings-select settings-test-btn';
  tldrUpdateBtn.textContent = t('tldrUpdateNow');
  tldrUpdateBtn.addEventListener('click', async () => {
    tldrUpdateBtn.disabled = true;
    tldrStatusSpan.textContent = t('tldrUpdating');
    tldrStatusSpan.className = 'settings-test-result';
    try {
      const status = await invoke<{ initialized: boolean; page_count: number; last_updated: number | null }>('tldr_init', { language: 'en', forceUpdate: true });
      tldrStatusSpan.textContent = t('tldrPageCount').replace('{count}', String(status.page_count));
      tldrStatusSpan.className = 'settings-test-result test-success';
    } catch (e) {
      tldrStatusSpan.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
      tldrStatusSpan.className = 'settings-test-result test-fail';
    }
    tldrUpdateBtn.disabled = false;
  });
  tldrEnableRow.appendChild(tldrUpdateBtn);
  tldrSection.appendChild(tldrEnableRow);

  const tldrEnableCheck = tldrEnableLabel.querySelector('#tldr-enable') as HTMLInputElement;
  tldrEnableCheck.addEventListener('change', () => update({ tldrEnabled: tldrEnableCheck.checked }));

  // Fetch current tldr status
  invoke<{ initialized: boolean; page_count: number; last_updated: number | null }>('tldr_status').then((status) => {
    if (status.initialized && status.page_count > 0) {
      tldrStatusSpan.textContent = t('tldrPageCount').replace('{count}', String(status.page_count));
      tldrStatusSpan.className = 'settings-test-result test-success';
    } else {
      tldrStatusSpan.textContent = t('tldrNoData');
      tldrStatusSpan.className = 'settings-test-result';
    }
  }).catch(() => { /* ignore */ });

  // Enable command completion checkbox
  const completionRow = document.createElement('div');
  completionRow.className = 'ai-provider-row ai-row-inline';
  const completionLabel = document.createElement('label');
  completionLabel.className = 'settings-radio-label';
  completionLabel.innerHTML = `<input type="checkbox" id="cmd-completion-enable" ${current.cmdCompletionEnabled ? 'checked' : ''}> ${t('cmdCompletionEnable')}`;
  completionRow.appendChild(completionLabel);
  tldrSection.appendChild(completionRow);

  const completionHintRow = document.createElement('div');
  completionHintRow.className = 'ai-provider-row';
  completionHintRow.innerHTML = `<span class="settings-hint">${t('cmdCompletionHint')}<br>${t('cmdCompletionHistoryHint')}</span>`;
  tldrSection.appendChild(completionHintRow);

  const completionCheck = completionLabel.querySelector('#cmd-completion-enable') as HTMLInputElement;
  completionCheck.addEventListener('change', () => update({ cmdCompletionEnabled: completionCheck.checked }));

  tabAI.appendChild(tldrSection);

  // ── Shell Hook Injection ── (same compact style as tldr section)
  const hookDivider = document.createElement('hr');
  hookDivider.className = 'settings-divider';
  tabAI.appendChild(hookDivider);

  const hookSection = document.createElement('div');
  hookSection.className = 'ai-settings-compact';
  hookSection.innerHTML = `<label class="settings-section-title">${t('shellHookInjection')}</label>`;

  const hookRow = document.createElement('div');
  hookRow.className = 'ai-provider-row ai-row-inline';
  const hookLabel = document.createElement('label');
  hookLabel.className = 'settings-radio-label';
  hookLabel.innerHTML = `<input type="checkbox" id="shell-hook-enable" ${current.shellHookInjection ? 'checked' : ''}> ${t('shellHookEnable')}`;
  hookRow.appendChild(hookLabel);
  hookSection.appendChild(hookRow);

  const hookHintRow = document.createElement('div');
  hookHintRow.className = 'ai-provider-row';
  hookHintRow.innerHTML = `<span class="settings-hint">${t('shellHookHint').replace(/\n/g, '<br>')}</span>`;
  hookSection.appendChild(hookHintRow);

  const hookCheck = hookLabel.querySelector('#shell-hook-enable') as HTMLInputElement;
  hookCheck.addEventListener('change', () => update({ shellHookInjection: hookCheck.checked }));

  tabAI.appendChild(hookSection);

  return tabAI;
}
