// ─── Settings UI: Agent Permission & Audit ────────────────
// Small helpers that build the permission-mode selector, the
// permission-rules editor, and the audit-log open button.
// Kept in a separate file so settings-ai.ts stays under 1000 lines.

import { AppSettings } from './themes';
import { t } from './i18n';
import { createSettingsSelect } from './custom-select';
import {
  DEFAULT_PERMISSION_RULES,
  type PermissionMode,
  type PermissionRule,
} from './ai-permission-rules';
import { getAuditLogPath } from './ai-audit-log';
import { invoke } from '@tauri-apps/api/core';

// ─── Permission Mode Selector ──────────────────────────────

export function createPermissionModeRow(
  current: AppSettings,
  update: (patch: Partial<AppSettings>) => void,
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'ai-provider-row ai-row-inline';
  row.innerHTML = `<label>${t('aiPermissionMode')}</label>`;

  const modeOptions: { value: PermissionMode | ''; label: string }[] = [
    { value: '',           label: `(${t('aiAgentTrustLevel')})` },
    { value: 'ask',        label: t('aiPermissionModeAsk') },
    { value: 'acceptSafe', label: t('aiPermissionModeAcceptSafe') },
    { value: 'acceptAll',  label: t('aiPermissionModeAcceptAll') },
    { value: 'plan',       label: t('aiPermissionModePlan') },
    { value: 'bypass',     label: t('aiPermissionModeBypass') },
  ];
  const currentMode = current.aiPermissionMode ?? '';
  const select = createSettingsSelect(
    modeOptions.map(opt => ({
      value: opt.value,
      label: opt.label,
      selected: currentMode === opt.value,
    })),
  );
  select.el.style.flex = '1';
  select.onchange = () => {
    const v = select.value as PermissionMode | '';
    update({ aiPermissionMode: v === '' ? undefined : v });
  };
  row.appendChild(select.el);

  const hint = document.createElement('div');
  hint.className = 'settings-hint';
  hint.style.cssText = 'font-size:11px;opacity:0.7;margin-top:4px;grid-column:1/-1;';
  hint.textContent = t('aiPermissionModeHint');

  const wrapper = document.createElement('div');
  wrapper.className = 'ai-permission-mode-wrapper';
  wrapper.appendChild(row);
  wrapper.appendChild(hint);
  return wrapper;
}

// ─── Permission Rules Editor ───────────────────────────────

export function createPermissionRulesEditor(
  current: AppSettings,
  update: (patch: Partial<AppSettings>) => void,
): HTMLDivElement {
  const container = document.createElement('div');
  container.className = 'ai-permission-rules';

  const header = document.createElement('div');
  header.className = 'ai-provider-row ai-row-inline';
  header.style.justifyContent = 'space-between';
  header.innerHTML = `<label class="settings-section-title" style="margin:0">${t('aiPermissionRules')}</label>`;

  const addBtn = document.createElement('button');
  addBtn.className = 'settings-select';
  addBtn.style.cssText = 'padding:4px 10px;font-size:12px;';
  addBtn.textContent = `+ ${t('aiPermissionRulesAdd')}`;
  header.appendChild(addBtn);
  container.appendChild(header);

  // List container — rebuilt on every mutation (simpler than diffing).
  const list = document.createElement('div');
  list.className = 'ai-permission-rules-list';
  list.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:8px;';
  container.appendChild(list);

  function getRules(): PermissionRule[] {
    return (current.aiPermissionRules as PermissionRule[] | undefined) ?? [];
  }

  function commitRules(rules: PermissionRule[]): void {
    update({ aiPermissionRules: rules });
    current.aiPermissionRules = rules;
    render();
  }

  function render(): void {
    list.innerHTML = '';
    const rules = getRules();
    if (rules.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'settings-hint';
      empty.style.cssText = 'font-size:11px;opacity:0.7;padding:6px 0;';
      empty.textContent = t('aiPermissionRulesNone');
      list.appendChild(empty);
      return;
    }

    for (let i = 0; i < rules.length; i++) {
      list.appendChild(buildRuleRow(rules, i));
    }
  }

  function buildRuleRow(rules: PermissionRule[], index: number): HTMLDivElement {
    const rule = rules[index];
    const row = document.createElement('div');
    row.className = 'ai-permission-rule-row';
    row.style.cssText =
      'display:grid;grid-template-columns:1fr 1fr 1fr 110px auto;gap:6px;align-items:center;';

    // Tool name input
    const toolInput = document.createElement('input');
    toolInput.type = 'text';
    toolInput.className = 'settings-input';
    toolInput.placeholder = t('aiPermissionRuleTool');
    toolInput.value = rule.tool;
    toolInput.addEventListener('keydown', (e) => e.stopPropagation());
    toolInput.onchange = () => {
      rule.tool = toolInput.value.trim() || '*';
      commitRules(rules);
    };
    row.appendChild(toolInput);

    // Command regex input
    const cmdInput = document.createElement('input');
    cmdInput.type = 'text';
    cmdInput.className = 'settings-input';
    cmdInput.placeholder = t('aiPermissionRuleCmdMatch');
    cmdInput.value = rule.match?.command ?? '';
    cmdInput.addEventListener('keydown', (e) => e.stopPropagation());
    cmdInput.onchange = () => {
      const v = cmdInput.value.trim();
      rule.match = { ...(rule.match ?? {}), command: v || undefined };
      if (!rule.match.command && !rule.match.path) delete rule.match;
      commitRules(rules);
    };
    row.appendChild(cmdInput);

    // Path regex input
    const pathInput = document.createElement('input');
    pathInput.type = 'text';
    pathInput.className = 'settings-input';
    pathInput.placeholder = t('aiPermissionRulePathMatch');
    pathInput.value = rule.match?.path ?? '';
    pathInput.addEventListener('keydown', (e) => e.stopPropagation());
    pathInput.onchange = () => {
      const v = pathInput.value.trim();
      rule.match = { ...(rule.match ?? {}), path: v || undefined };
      if (!rule.match.command && !rule.match.path) delete rule.match;
      commitRules(rules);
    };
    row.appendChild(pathInput);

    // Action select
    const actionSel = createSettingsSelect([
      { value: 'allow', label: t('aiPermissionActionAllow'), selected: rule.action === 'allow' },
      { value: 'deny',  label: t('aiPermissionActionDeny'),  selected: rule.action === 'deny' },
      { value: 'ask',   label: t('aiPermissionActionAsk'),   selected: rule.action === 'ask' },
    ]);
    actionSel.onchange = () => {
      rule.action = actionSel.value as PermissionRule['action'];
      commitRules(rules);
    };
    row.appendChild(actionSel.el);

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'ai-provider-delete-btn';
    delBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>`;
    delBtn.onclick = () => {
      rules.splice(index, 1);
      commitRules(rules);
    };
    row.appendChild(delBtn);

    return row;
  }

  addBtn.onclick = () => {
    const rules = getRules().slice();
    // If the list is empty and user adds the first rule, seed it with
    // the defaults so they have something to edit from.
    if (rules.length === 0) {
      for (const r of DEFAULT_PERMISSION_RULES) rules.push(structuredClone(r));
    }
    rules.push({ tool: 'run_command', action: 'ask' });
    commitRules(rules);
  };

  render();
  return container;
}

// ─── Audit Log Viewer ──────────────────────────────────────

export function createAuditLogRow(): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'ai-provider-row ai-row-inline';
  row.style.justifyContent = 'space-between';
  row.innerHTML = `<label class="settings-section-title" style="margin:0">${t('aiAuditLog')}</label>`;

  const openBtn = document.createElement('button');
  openBtn.className = 'settings-select settings-test-btn';
  openBtn.textContent = t('aiAuditLogOpen');
  openBtn.onclick = () => { void openAuditLogInSystemEditor(); };
  row.appendChild(openBtn);

  return row;
}

/** Hand the audit log file to the OS default text editor. */
async function openAuditLogInSystemEditor(): Promise<void> {
  try {
    const path = await getAuditLogPath();
    await invoke('open_text_file', { path });
  } catch (err) {
    console.error('Failed to open audit log:', err);
  }
}
