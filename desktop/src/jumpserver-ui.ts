/**
 * jumpserver-ui.ts — JumpServer visual UI components
 *
 * Provides:
 * - Configuration dialog (add/edit JumpServer connection)
 * - MFA input dialog
 * - Asset browser panel (tree + list + search)
 * - Account selection dialog
 */

import { t } from './i18n';
import { escapeHtml } from './status-bar';
import {
  type JumpServerConfig,
  type JumpServerAsset,
  type JumpServerNode,
  type JumpServerAccount,
  addJumpServerConfig,
  getAssets,
  getNodes,
  getAccounts,
  testConnection,
} from './jumpserver-api';
import {
  loadGroupOrder,
  getConnectionGroup,
  setConnectionGroup,
  removeConnectionGroup,
  jumpserverKey,
} from './connection-groups';

// ── Config Dialog ──

/**
 * Show a dialog for adding or editing a JumpServer configuration.
 * Returns the config if saved, null if cancelled.
 */
export function showJumpServerConfigDialog(
  prefill?: JumpServerConfig,
): Promise<{ config: JumpServerConfig; connect: boolean } | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ssh-modal-overlay';
    overlay.style.zIndex = '10001';

    const dialog = document.createElement('div');
    dialog.className = 'ssh-modal';
    dialog.style.width = '480px';

    // Header
    const header = document.createElement('div');
    header.className = 'ssh-modal-header';
    const title = document.createElement('h3');
    title.textContent = prefill ? t('jsEditServer') : t('jsAddServer');
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ssh-modal-close';
    closeBtn.textContent = '\u00d7';
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    const form = document.createElement('div');
    form.className = 'ssh-form';

    // Name
    const nameInput = createFormInput(form, t('jsName'), 'text', prefill?.name || '', 'My JumpServer');

    // Base URL
    const urlInput = createFormInput(form, t('jsBaseUrl'), 'text', prefill?.baseUrl || '', 'https://jumpserver.example.com');

    // SSH Host + Port row
    const sshRow = document.createElement('div');
    sshRow.className = 'ssh-form-row';

    const sshHostGroup = document.createElement('div');
    sshHostGroup.className = 'ssh-form-group ssh-form-group-flex';
    const sshHostLabel = document.createElement('label');
    sshHostLabel.textContent = t('jsSshHost');
    const sshHostInput = document.createElement('input');
    sshHostInput.type = 'text';
    sshHostInput.className = 'ssh-input';
    sshHostInput.value = prefill?.sshHost || '';
    sshHostInput.placeholder = t('jsSshHostPlaceholder');
    sshHostGroup.appendChild(sshHostLabel);
    sshHostGroup.appendChild(sshHostInput);

    const sshPortGroup = document.createElement('div');
    sshPortGroup.className = 'ssh-form-group ssh-form-group-port';
    const sshPortLabel = document.createElement('label');
    sshPortLabel.textContent = t('sshPort');
    const sshPortInput = document.createElement('input');
    sshPortInput.type = 'text';
    sshPortInput.inputMode = 'numeric';
    sshPortInput.pattern = '[0-9]*';
    sshPortInput.className = 'ssh-input';
    sshPortInput.value = String(prefill?.sshPort || 2222);
    sshPortInput.addEventListener('focus', () => sshPortInput.select());
    sshPortInput.addEventListener('input', () => {
      const digits = sshPortInput.value.replace(/\D/g, '');
      const num = parseInt(digits, 10);
      if (!digits || isNaN(num)) { sshPortInput.value = ''; }
      else if (num > 65535) { sshPortInput.value = '65535'; }
      else { sshPortInput.value = String(num); }
    });
    sshPortInput.addEventListener('blur', () => {
      const num = parseInt(sshPortInput.value, 10);
      if (!sshPortInput.value || isNaN(num) || num < 1) { sshPortInput.value = '2222'; }
    });
    sshPortGroup.appendChild(sshPortLabel);
    sshPortGroup.appendChild(sshPortInput);

    sshRow.appendChild(sshHostGroup);
    sshRow.appendChild(sshPortGroup);
    form.appendChild(sshRow);

    // Username
    const usernameInput = createFormInput(form, t('sshUsername'), 'text', prefill?.username || '', 'admin');

    // Auth method toggle
    const authGroup = document.createElement('div');
    authGroup.className = 'ssh-form-group';
    const authLabel = document.createElement('label');
    authLabel.textContent = t('jsAuthMethod');
    const authSelect = document.createElement('select');
    authSelect.className = 'ssh-input';
    authSelect.innerHTML = `
      <option value="password">${t('jsAuthPassword')}</option>
      <option value="token">${t('jsAuthToken')}</option>
    `;
    authSelect.value = prefill?.authMethod || 'password';
    authGroup.appendChild(authLabel);
    authGroup.appendChild(authSelect);
    form.appendChild(authGroup);

    // Password field
    const passwordInput = createFormInput(form, t('sshPassword'), 'password', '', '');
    const passwordGroup = passwordInput.parentElement as HTMLDivElement;

    // Token field
    const tokenInput = createFormInput(form, t('jsApiToken'), 'password', '', 'Bearer Token / Private Token');
    const tokenGroup = tokenInput.parentElement as HTMLDivElement;

    // Toggle visibility based on auth method
    const updateAuthFields = () => {
      const method = authSelect.value;
      passwordGroup.style.display = method === 'password' ? '' : 'none';
      tokenGroup.style.display = method === 'token' ? '' : 'none';
    };
    authSelect.addEventListener('change', updateAuthFields);
    updateAuthFields();

    // Org ID (optional, collapsed)
    const orgInput = createFormInput(form, t('jsOrgId'), 'text', prefill?.orgId || '', t('jsOrgIdPlaceholder'));

    // ── Proxy settings (collapsible) ──
    const proxyDetails = document.createElement('details');
    proxyDetails.className = 'ssh-proxy-section';
    const proxySummary = document.createElement('summary');
    proxySummary.className = 'ssh-proxy-summary';
    const proxyArrow = document.createElement('span');
    proxyArrow.className = 'ssh-proxy-arrow';
    proxyArrow.textContent = '▾';
    proxySummary.append(t('advancedOptions'), proxyArrow);
    proxyDetails.appendChild(proxySummary);

    // Bypass + Proxy type in one row
    const proxyTopRow = document.createElement('div');
    proxyTopRow.className = 'ssh-form-row';

    const bypassGroup = document.createElement('div');
    bypassGroup.className = 'ssh-form-group ssh-form-group-flex';
    const bypassLabel = document.createElement('label');
    bypassLabel.style.display = 'flex';
    bypassLabel.style.alignItems = 'center';
    bypassLabel.style.gap = '4px';
    bypassLabel.style.whiteSpace = 'nowrap';
    const bypassCheckbox = document.createElement('input');
    bypassCheckbox.type = 'checkbox';
    bypassCheckbox.checked = prefill?.bypassProxy !== false;
    bypassLabel.appendChild(bypassCheckbox);
    bypassLabel.appendChild(document.createTextNode(t('jsBypassProxy')));
    bypassGroup.appendChild(bypassLabel);

    const jsProxyTypeGroup = document.createElement('div');
    jsProxyTypeGroup.className = 'ssh-form-group ssh-form-group-flex';
    const jsProxyTypeLabel = document.createElement('label');
    jsProxyTypeLabel.textContent = t('sshProxyType');
    const jsProxyTypeSelect = document.createElement('select');
    jsProxyTypeSelect.className = 'ssh-input';
    for (const [val, label] of [['', t('sshProxyNone')], ['socks5', 'SOCKS5'], ['http', 'HTTP CONNECT']] as const) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      if (val === (prefill?.proxyType || '')) opt.selected = true;
      jsProxyTypeSelect.appendChild(opt);
    }
    jsProxyTypeGroup.appendChild(jsProxyTypeLabel);
    jsProxyTypeGroup.appendChild(jsProxyTypeSelect);

    proxyTopRow.appendChild(bypassGroup);
    proxyTopRow.appendChild(jsProxyTypeGroup);
    proxyDetails.appendChild(proxyTopRow);

    // Proxy host + port row
    const jsProxyHostRow = document.createElement('div');
    jsProxyHostRow.className = 'ssh-form-row';
    jsProxyHostRow.style.display = prefill?.proxyType ? '' : 'none';

    const jsProxyHostGroup = document.createElement('div');
    jsProxyHostGroup.className = 'ssh-form-group ssh-form-group-flex';
    const jsProxyHostLabel = document.createElement('label');
    jsProxyHostLabel.textContent = t('sshProxyHost');
    const jsProxyHostInput = document.createElement('input');
    jsProxyHostInput.type = 'text';
    jsProxyHostInput.className = 'ssh-input';
    jsProxyHostInput.value = prefill?.proxyHost || '';
    jsProxyHostInput.placeholder = '127.0.0.1';
    jsProxyHostInput.autocomplete = 'off';
    jsProxyHostGroup.appendChild(jsProxyHostLabel);
    jsProxyHostGroup.appendChild(jsProxyHostInput);

    const jsProxyPortGroup = document.createElement('div');
    jsProxyPortGroup.className = 'ssh-form-group ssh-form-group-port';
    const jsProxyPortLabel = document.createElement('label');
    jsProxyPortLabel.textContent = t('sshProxyPort');
    const jsProxyPortInput = document.createElement('input');
    jsProxyPortInput.type = 'text';
    jsProxyPortInput.inputMode = 'numeric';
    jsProxyPortInput.pattern = '[0-9]*';
    jsProxyPortInput.className = 'ssh-input';
    jsProxyPortInput.value = prefill?.proxyPort ? String(prefill.proxyPort) : '';
    jsProxyPortInput.placeholder = '1080';
    jsProxyPortGroup.appendChild(jsProxyPortLabel);
    jsProxyPortGroup.appendChild(jsProxyPortInput);

    jsProxyHostRow.appendChild(jsProxyHostGroup);
    jsProxyHostRow.appendChild(jsProxyPortGroup);
    proxyDetails.appendChild(jsProxyHostRow);

    // Proxy username + password row
    const jsProxyAuthRow = document.createElement('div');
    jsProxyAuthRow.className = 'ssh-form-row';
    jsProxyAuthRow.style.display = prefill?.proxyType ? '' : 'none';

    const jsProxyUserGroup = document.createElement('div');
    jsProxyUserGroup.className = 'ssh-form-group ssh-form-group-flex';
    const jsProxyUserLabel = document.createElement('label');
    jsProxyUserLabel.textContent = t('sshProxyUsername');
    const jsProxyUserInput = document.createElement('input');
    jsProxyUserInput.type = 'text';
    jsProxyUserInput.className = 'ssh-input';
    jsProxyUserInput.value = prefill?.proxyUsername || '';
    jsProxyUserInput.autocomplete = 'off';
    jsProxyUserGroup.appendChild(jsProxyUserLabel);
    jsProxyUserGroup.appendChild(jsProxyUserInput);

    const jsProxyPassGroup = document.createElement('div');
    jsProxyPassGroup.className = 'ssh-form-group ssh-form-group-flex';
    const jsProxyPassLabel = document.createElement('label');
    jsProxyPassLabel.textContent = t('sshProxyPassword');
    const jsProxyPassInput = document.createElement('input');
    jsProxyPassInput.type = 'password';
    jsProxyPassInput.className = 'ssh-input';
    jsProxyPassInput.value = prefill?.proxyPassword || '';
    jsProxyPassGroup.appendChild(jsProxyPassLabel);
    jsProxyPassGroup.appendChild(jsProxyPassInput);

    jsProxyAuthRow.appendChild(jsProxyUserGroup);
    jsProxyAuthRow.appendChild(jsProxyPassGroup);
    proxyDetails.appendChild(jsProxyAuthRow);

    jsProxyTypeSelect.addEventListener('change', () => {
      const show = jsProxyTypeSelect.value !== '';
      jsProxyHostRow.style.display = show ? '' : 'none';
      jsProxyAuthRow.style.display = show ? '' : 'none';
    });

    if (prefill?.proxyType) proxyDetails.open = true;
    form.appendChild(proxyDetails);

    // Group selector
    const groupRow = document.createElement('div');
    groupRow.className = 'ssh-form-row ssh-group-row';
    const groupLabel = document.createElement('label');
    groupLabel.className = 'ssh-form-label';
    groupLabel.textContent = t('homeGroupMoveToGroup');
    const groupSelect = document.createElement('select');
    groupSelect.className = 'ssh-select ssh-group-select';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = t('homeGroupUngrouped');
    groupSelect.appendChild(noneOpt);
    for (const g of loadGroupOrder()) {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      groupSelect.appendChild(opt);
    }
    if (prefill?.name) {
      const currentGroup = getConnectionGroup(jumpserverKey(prefill.name));
      if (currentGroup) groupSelect.value = currentGroup;
    }
    groupRow.appendChild(groupLabel);
    groupRow.appendChild(groupSelect);
    form.appendChild(groupRow);

    // Wrap form in modal body
    const body = document.createElement('div');
    body.className = 'ssh-modal-body';
    body.appendChild(form);

    // Status message area
    const statusMsg = document.createElement('div');
    statusMsg.className = 'ssh-form-status';
    body.appendChild(statusMsg);

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.className = 'ssh-form-actions';

    const setStatus = (msg: string, type: 'info' | 'success' | 'error') => {
      statusMsg.textContent = msg;
      statusMsg.className = `ssh-form-status ssh-status-${type}`;
    };

    const testBtn = document.createElement('button');
    testBtn.className = 'ssh-btn ssh-btn-test';
    testBtn.textContent = t('jsTestConnection');
    testBtn.onclick = async () => {
      const url = urlInput.value.trim();
      if (!url) return;
      setStatus(t('jsTesting'), 'info');
      try {
        const result = await testConnection(url);
        if (result.ok) {
          setStatus(t('jsTestSuccess'), 'success');
        } else {
          setStatus(`${t('jsTestFailed')}: ${result.error}`, 'error');
        }
      } catch (err) {
        setStatus(`${t('jsTestFailed')}: ${String(err)}`, 'error');
      }
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ssh-btn ssh-btn-secondary';
    cancelBtn.textContent = t('sshUnsavedCancel');
    cancelBtn.onclick = () => { overlay.remove(); resolve(null); };

    const buildConfig = (): JumpServerConfig | null => {
      const config: JumpServerConfig = {
        name: nameInput.value.trim(),
        baseUrl: urlInput.value.trim().replace(/\/+$/, ''),
        sshHost: sshHostInput.value.trim(),
        sshPort: parseInt(sshPortInput.value) || 2222,
        username: usernameInput.value.trim(),
        authMethod: authSelect.value as 'password' | 'token',
        password: passwordInput.value || undefined,
        apiToken: tokenInput.value || undefined,
        orgId: orgInput.value.trim() || undefined,
        bypassProxy: bypassCheckbox.checked,
        proxyType: jsProxyTypeSelect.value || undefined,
        proxyHost: jsProxyHostInput.value.trim() || undefined,
        proxyPort: parseInt(jsProxyPortInput.value) || undefined,
        proxyUsername: jsProxyUserInput.value.trim() || undefined,
        proxyPassword: jsProxyPassInput.value || undefined,
      };
      if (!config.name || !config.baseUrl || !config.username) {
        setStatus(t('jsFieldsRequired'), 'error');
        return null;
      }
      if (!config.sshHost) {
        try {
          config.sshHost = new URL(config.baseUrl).hostname;
        } catch {
          setStatus(t('jsInvalidUrl'), 'error');
          return null;
        }
      }
      return config;
    };

    const saveBtn = document.createElement('button');
    saveBtn.className = 'ssh-btn ssh-btn-secondary';
    saveBtn.textContent = t('jsSave');
    saveBtn.onclick = async () => {
      const config = buildConfig();
      if (!config) return;
      await addJumpServerConfig(config);
      const selGrp = groupSelect.value;
      if (selGrp) setConnectionGroup(jumpserverKey(config.name), selGrp);
      else removeConnectionGroup(jumpserverKey(config.name));
      overlay.remove();
      resolve({ config, connect: false });
    };

    const saveConnectBtn = document.createElement('button');
    saveConnectBtn.className = 'ssh-btn ssh-btn-primary';
    saveConnectBtn.textContent = t('jsSaveAndConnect');
    saveConnectBtn.onclick = async () => {
      const config = buildConfig();
      if (!config) return;

      // Test connection before saving and connecting
      saveConnectBtn.disabled = true;
      saveBtn.disabled = true;
      setStatus(t('jsTesting'), 'info');
      try {
        const result = await testConnection(config.baseUrl);
        if (!result.ok) {
          setStatus(`${t('jsTestFailed')}: ${result.error}`, 'error');
          return;
        }
      } catch (err) {
        setStatus(`${t('jsTestFailed')}: ${String(err)}`, 'error');
        return;
      } finally {
        saveConnectBtn.disabled = false;
        saveBtn.disabled = false;
      }

      await addJumpServerConfig(config);
      const selGrp2 = groupSelect.value;
      if (selGrp2) setConnectionGroup(jumpserverKey(config.name), selGrp2);
      else removeConnectionGroup(jumpserverKey(config.name));
      overlay.remove();
      resolve({ config, connect: true });
    };

    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    btnRow.appendChild(testBtn);
    btnRow.appendChild(spacer);
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(saveConnectBtn);
    body.appendChild(btnRow);
    dialog.appendChild(body);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Dirty check: any field has content → confirm before closing
    const isDirty = () =>
      !!(nameInput.value.trim() || urlInput.value.trim() || sshHostInput.value.trim() ||
        usernameInput.value.trim() || passwordInput.value || tokenInput.value || orgInput.value.trim());

    let confirmOpen = false;
    const guardedClose = () => {
      if (confirmOpen) return;
      if (!isDirty()) {
        overlay.remove();
        resolve(null);
        return;
      }
      confirmOpen = true;
      const confirmBar = document.createElement('div');
      confirmBar.className = 'ssh-confirm-bar';
      const msgSpan = document.createElement('span');
      msgSpan.className = 'ssh-confirm-msg';
      msgSpan.textContent = t('sshUnsavedConfirm');
      const keepBtn = document.createElement('button');
      keepBtn.className = 'ssh-btn ssh-btn-secondary ssh-btn-sm';
      keepBtn.textContent = t('sshUnsavedCancel');
      const discardBtn = document.createElement('button');
      discardBtn.className = 'ssh-btn ssh-btn-danger ssh-btn-sm';
      discardBtn.textContent = t('sshUnsavedDiscard');
      keepBtn.onclick = () => { confirmBar.remove(); confirmOpen = false; };
      discardBtn.onclick = () => { confirmBar.remove(); confirmOpen = false; overlay.remove(); resolve(null); };
      confirmBar.appendChild(msgSpan);
      confirmBar.appendChild(keepBtn);
      confirmBar.appendChild(discardBtn);
      dialog.appendChild(confirmBar);
    };

    closeBtn.onclick = guardedClose;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) guardedClose();
    });

    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        guardedClose();
        if (!document.body.contains(overlay)) {
          document.removeEventListener('keydown', escHandler);
        }
      }
    };
    document.addEventListener('keydown', escHandler);

    setTimeout(() => nameInput.focus(), 50);
  });
}

// ── MFA Dialog ──

/**
 * Show an MFA input dialog. Returns the verification code or null if cancelled.
 */
export function showMFADialog(
  mfaChoices: string[],
  errorMsg?: string,
): Promise<{ type: string; code: string } | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ssh-modal-overlay';
    overlay.style.zIndex = '10002';

    const dialog = document.createElement('div');
    dialog.className = 'ssh-modal';
    dialog.style.width = '380px';

    // Header
    const mfaHeader = document.createElement('div');
    mfaHeader.className = 'ssh-modal-header';
    const title = document.createElement('h3');
    title.textContent = t('jsMfaTitle');
    mfaHeader.appendChild(title);
    dialog.appendChild(mfaHeader);

    // Body
    const mfaBody = document.createElement('div');
    mfaBody.className = 'ssh-modal-body';

    const desc = document.createElement('p');
    desc.style.cssText = 'font-size:13px;color:var(--text-secondary);margin:0 0 16px;';
    desc.textContent = t('jsMfaDesc');
    mfaBody.appendChild(desc);

    // Error message area (shown on retry)
    if (errorMsg) {
      const errEl = document.createElement('div');
      errEl.className = 'ssh-form-status ssh-status-error';
      errEl.style.marginBottom = '12px';
      errEl.textContent = errorMsg;
      mfaBody.appendChild(errEl);
    }

    // MFA type selector (if multiple choices)
    let selectedType = mfaChoices[0] || 'otp';
    if (mfaChoices.length > 1) {
      const typeGroup = document.createElement('div');
      typeGroup.className = 'ssh-form-group';
      typeGroup.style.marginBottom = '12px';
      const typeSelect = document.createElement('select');
      typeSelect.className = 'ssh-input';
      mfaChoices.forEach(ch => {
        const opt = document.createElement('option');
        opt.value = ch;
        opt.textContent = ch === 'otp' ? 'TOTP (Authenticator)' : ch === 'sms' ? 'SMS' : ch;
        typeSelect.appendChild(opt);
      });
      typeSelect.addEventListener('change', () => { selectedType = typeSelect.value; });
      typeGroup.appendChild(typeSelect);
      mfaBody.appendChild(typeGroup);
    }

    const codeInput = document.createElement('input');
    codeInput.type = 'text';
    codeInput.className = 'ssh-input';
    codeInput.placeholder = t('jsMfaCodePlaceholder');
    codeInput.autocomplete = 'one-time-code';
    codeInput.inputMode = 'numeric';
    codeInput.maxLength = 6;
    codeInput.style.marginBottom = '16px';
    codeInput.style.letterSpacing = '4px';
    codeInput.style.fontSize = '18px';
    codeInput.style.textAlign = 'center';
    mfaBody.appendChild(codeInput);

    const btnRow = document.createElement('div');
    btnRow.className = 'ssh-form-actions';
    btnRow.style.justifyContent = 'flex-end';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ssh-btn ssh-btn-secondary';
    cancelBtn.textContent = t('sshUnsavedCancel');
    cancelBtn.onclick = () => { overlay.remove(); resolve(null); };

    const verifyBtn = document.createElement('button');
    verifyBtn.className = 'ssh-btn ssh-btn-primary';
    verifyBtn.textContent = t('jsMfaVerify');
    verifyBtn.onclick = () => {
      const code = codeInput.value.trim();
      if (!code) return;
      overlay.remove();
      resolve({ type: selectedType, code });
    };

    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') verifyBtn.click();
      if (e.key === 'Escape') cancelBtn.click();
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(verifyBtn);
    mfaBody.appendChild(btnRow);
    dialog.appendChild(mfaBody);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    setTimeout(() => codeInput.focus(), 50);
  });
}

// ── Asset Browser Panel ──

/**
 * Show the asset browser in a modal. Returns the selected asset + account,
 * or null if cancelled.
 */
export async function showAssetBrowser(
  config: JumpServerConfig,
  onConnect?: (asset: JumpServerAsset, account: JumpServerAccount) => Promise<void>,
): Promise<{
  asset: JumpServerAsset;
  account: JumpServerAccount;
} | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ssh-modal-overlay js-asset-browser-overlay';
    overlay.style.zIndex = '10001';

    const browser = document.createElement('div');
    browser.className = 'js-asset-browser';

    // Header
    const header = document.createElement('div');
    header.className = 'js-asset-header';
    header.innerHTML = `
      <h3>${escapeHtml(config.name)} — ${t('jsAssetBrowser')}</h3>
      <button class="js-asset-close">&times;</button>
    `;
    header.querySelector('.js-asset-close')!.addEventListener('click', () => {
      overlay.remove();
      resolve(null);
    });
    browser.appendChild(header);

    // Search bar
    const searchBar = document.createElement('div');
    searchBar.className = 'js-asset-search';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'ssh-input';
    searchInput.placeholder = t('jsSearchAssets');
    searchBar.appendChild(searchInput);
    browser.appendChild(searchBar);

    // Content: sidebar (nodes) + main (assets)
    const content = document.createElement('div');
    content.className = 'js-asset-content';

    const sidebar = document.createElement('div');
    sidebar.className = 'js-asset-sidebar';
    sidebar.innerHTML = `<div class="js-loading">${t('jsLoading')}</div>`;

    const main = document.createElement('div');
    main.className = 'js-asset-main';
    main.innerHTML = `<div class="js-loading">${t('jsLoading')}</div>`;

    content.appendChild(sidebar);
    content.appendChild(main);
    browser.appendChild(content);

    // Status bar
    const statusBar = document.createElement('div');
    statusBar.className = 'js-asset-status';
    browser.appendChild(statusBar);

    overlay.appendChild(browser);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { overlay.remove(); resolve(null); }
    });

    // State
    let selectedNodeId = '';
    let currentAssets: JumpServerAsset[] = [];
    let currentPage = 1;
    let totalAssets = 0;
    let searchDebounce: ReturnType<typeof setTimeout> | null = null;

    // Load nodes
    const loadNodeTree = async () => {
      try {
        const result = await getNodes(config.baseUrl);
        if (!result.ok || !result.nodes) {
          sidebar.innerHTML = `<div class="js-error">${escapeHtml(result.error || 'Failed')}</div>`;
          return;
        }
        renderNodes(result.nodes);
      } catch (err) {
        sidebar.innerHTML = `<div class="js-error">${escapeHtml(String(err))}</div>`;
      }
    };

    const renderNodes = (nodes: JumpServerNode[]) => {
      sidebar.innerHTML = '';

      // Sort nodes by key to ensure proper tree ordering
      const sorted = [...nodes].sort((a, b) => {
        const aParts = (a.key || '').split(':').map(Number);
        const bParts = (b.key || '').split(':').map(Number);
        for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
          const av = aParts[i] ?? -1;
          const bv = bParts[i] ?? -1;
          if (av !== bv) return av - bv;
        }
        return 0;
      });

      // Build parent-child lookup
      const keySet = new Set(sorted.map(n => n.key || ''));
      const hasChildren = (key: string) => {
        if (!key) return false;
        for (const k of keySet) {
          if (k !== key && k.startsWith(key + ':')) return true;
        }
        return false;
      };

      const expanded = new Set<string>();

      // "All assets" root item
      const allItem = document.createElement('div');
      allItem.className = 'js-node-item js-node-selected';
      allItem.style.paddingLeft = '8px';
      allItem.innerHTML = `<span class="js-node-icon">${SVG_LIST}</span><span class="js-node-name">${escapeHtml(t('jsAllAssets'))}</span>`;
      allItem.onclick = () => {
        sidebar.querySelectorAll('.js-node-item').forEach(n => n.classList.remove('js-node-selected'));
        allItem.classList.add('js-node-selected');
        selectedNodeId = '';
        currentPage = 1;
        loadAssetList();
      };
      sidebar.appendChild(allItem);

      const nodeElements = new Map<string, HTMLElement>();

      sorted.forEach(node => {
        const key = node.key || '';
        const depth = key.split(':').length - 1;
        const isParent = hasChildren(key);

        const item = document.createElement('div');
        item.className = 'js-node-item';
        item.dataset.nodeId = node.id;
        item.style.paddingLeft = `${8 + depth * 16}px`;

        const chevron = isParent
          ? `<span class="js-node-chevron">${SVG_CHEVRON_RIGHT}</span>`
          : `<span class="js-node-chevron-spacer"></span>`;

        item.innerHTML = `
          ${chevron}
          <span class="js-node-icon">${SVG_FOLDER}</span>
          <span class="js-node-name">${escapeHtml(node.name)}</span>
          ${node.assets_amount ? `<span class="js-node-count">${node.assets_amount}</span>` : ''}
        `;

        if (depth > 0) item.style.display = 'none';

        if (isParent) {
          const chevronEl = item.querySelector('.js-node-chevron')!;
          chevronEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (expanded.has(key)) {
              expanded.delete(key);
              chevronEl.innerHTML = SVG_CHEVRON_RIGHT;
            } else {
              expanded.add(key);
              chevronEl.innerHTML = SVG_CHEVRON_DOWN;
            }
            updateVisibility();
          });
        }

        item.addEventListener('click', () => {
          sidebar.querySelectorAll('.js-node-item').forEach(n => n.classList.remove('js-node-selected'));
          item.classList.add('js-node-selected');
          selectedNodeId = node.id;
          currentPage = 1;
          loadAssetList();
          if (isParent && !expanded.has(key)) {
            expanded.add(key);
            const chevronEl = item.querySelector('.js-node-chevron');
            if (chevronEl) chevronEl.innerHTML = SVG_CHEVRON_DOWN;
            updateVisibility();
          }
        });

        nodeElements.set(key, item);
        sidebar.appendChild(item);
      });

      const updateVisibility = () => {
        for (const [key, el] of nodeElements) {
          const depth = key.split(':').length - 1;
          if (depth === 0) { el.style.display = ''; continue; }
          const parts = key.split(':');
          let visible = true;
          for (let i = 1; i < parts.length; i++) {
            if (!expanded.has(parts.slice(0, i).join(':'))) { visible = false; break; }
          }
          el.style.display = visible ? '' : 'none';
        }
      };
    };

    // Load assets
    const loadAssetList = async () => {
      main.innerHTML = `<div class="js-loading">${t('jsLoading')}</div>`;
      try {
        const search = searchInput.value.trim();
        const result = await getAssets(config.baseUrl, {
          search: search || undefined,
          nodeId: selectedNodeId || undefined,
          page: currentPage,
          pageSize: 50,
        });

        if (!result.ok || !result.assets) {
          main.innerHTML = `<div class="js-error">${escapeHtml(result.error || 'Failed')}</div>`;
          return;
        }

        currentAssets = result.assets;
        totalAssets = result.total || result.assets.length;
        renderAssets();
        statusBar.textContent = `${totalAssets} ${t('jsAssetsTotal')}`;
      } catch (err) {
        main.innerHTML = `<div class="js-error">${escapeHtml(String(err))}</div>`;
      }
    };

    const renderAssets = () => {
      if (currentAssets.length === 0) {
        main.innerHTML = `<div class="js-empty">${t('jsNoAssets')}</div>`;
        return;
      }

      const table = document.createElement('table');
      table.className = 'js-asset-table';
      table.innerHTML = `
        <thead>
          <tr>
            <th style="width:30%">${t('jsAssetName')}</th>
            <th style="width:25%">${t('jsAssetAddress')}</th>
            <th style="width:15%">${t('jsAssetPlatform')}</th>
            <th style="width:15%">${t('jsAssetProtocols')}</th>
            <th style="width:15%">${t('jsAssetActions')}</th>
          </tr>
        </thead>
      `;

      const tbody = document.createElement('tbody');
      currentAssets.forEach(asset => {
        const tr = document.createElement('tr');
        tr.className = 'js-asset-row';
        if (!asset.is_active) tr.classList.add('js-asset-inactive');

        const protocols = (asset.protocols || []).map(p => `${p.name}:${p.port}`).join(', ');

        tr.innerHTML = `
          <td>${escapeHtml(asset.name || '-')}</td>
          <td><code>${escapeHtml(asset.address || '-')}</code></td>
          <td>${escapeHtml(asset.platform?.name || '-')}</td>
          <td><span class="js-protocols">${escapeHtml(protocols || '-')}</span></td>
          <td></td>
        `;

        const actionCell = tr.querySelector('td:last-child')!;
        const connectBtn = document.createElement('button');
        connectBtn.className = 'ssh-btn ssh-btn-primary js-connect-btn';
        connectBtn.textContent = t('jsConnect');
        connectBtn.disabled = !asset.is_active;
        connectBtn.onclick = async (e) => {
          e.stopPropagation();
          await handleAssetConnect(asset);
        };
        actionCell.appendChild(connectBtn);

        tbody.appendChild(tr);
      });

      table.appendChild(tbody);
      main.innerHTML = '';
      main.appendChild(table);

      // Pagination
      if (totalAssets > 50) {
        const totalPages = Math.ceil(totalAssets / 50);
        const pagination = document.createElement('div');
        pagination.className = 'js-pagination';
        pagination.innerHTML = `
          <button class="ssh-btn ssh-btn-secondary" ${currentPage <= 1 ? 'disabled' : ''}>&laquo;</button>
          <span>${currentPage} / ${totalPages}</span>
          <button class="ssh-btn ssh-btn-secondary" ${currentPage >= totalPages ? 'disabled' : ''}>&raquo;</button>
        `;
        const [prevBtn, , nextBtn] = pagination.children;
        prevBtn.addEventListener('click', () => { if (currentPage > 1) { currentPage--; loadAssetList(); } });
        nextBtn.addEventListener('click', () => { if (currentPage < totalPages) { currentPage++; loadAssetList(); } });
        main.appendChild(pagination);
      }
    };

    // Handle asset connect — show account selection, then connect
    const handleAssetConnect = async (asset: JumpServerAsset) => {
      statusBar.textContent = t('jsLoadingAccounts');
      try {
        const result = await getAccounts(config.baseUrl, asset.id);
        if (!result.ok || !result.accounts || result.accounts.length === 0) {
          statusBar.textContent = result.error || t('jsNoAccounts');
          statusBar.style.color = 'var(--status-red)';
          return;
        }

        let account: JumpServerAccount | null;
        if (result.accounts.length === 1) {
          account = result.accounts[0];
        } else {
          account = await showAccountSelection(result.accounts);
        }
        if (!account) return;

        // If onConnect callback provided, call it and keep dialog open on failure
        if (onConnect) {
          statusBar.style.color = '';
          statusBar.textContent = `Connecting to ${asset.name || asset.address}...`;
          try {
            await onConnect(asset, account);
            overlay.remove();
            resolve({ asset, account });
          } catch (err) {
            statusBar.textContent = `Connection failed: ${String(err)}`;
            statusBar.style.color = 'var(--status-red)';
            // Don't close — user can retry or pick a different asset
          }
        } else {
          overlay.remove();
          resolve({ asset, account });
        }
      } catch (err) {
        statusBar.textContent = `Error: ${String(err)}`;
        statusBar.style.color = 'var(--status-red)';
      }
    };

    // Search handler with debounce
    searchInput.addEventListener('input', () => {
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        currentPage = 1;
        loadAssetList();
      }, 300);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (searchInput.value) {
          searchInput.value = '';
          currentPage = 1;
          loadAssetList();
        } else {
          overlay.remove();
          resolve(null);
        }
      }
    });

    // Initial load
    loadNodeTree();
    loadAssetList();
    setTimeout(() => searchInput.focus(), 100);
  });
}

// ── Account Selection Dialog ──

function showAccountSelection(accounts: JumpServerAccount[]): Promise<JumpServerAccount | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ssh-modal-overlay';
    overlay.style.zIndex = '10003';

    const dialog = document.createElement('div');
    dialog.className = 'ssh-modal';
    dialog.style.maxWidth = '400px';

    const title = document.createElement('h3');
    title.textContent = t('jsSelectAccount');
    title.style.margin = '0 0 12px';
    dialog.appendChild(title);

    const list = document.createElement('div');
    list.className = 'js-account-list';

    accounts.forEach(acc => {
      const item = document.createElement('div');
      item.className = 'js-account-item';
      item.innerHTML = `
        <div class="js-account-info">
          <span class="js-account-username">${escapeHtml(acc.username)}</span>
          <span class="js-account-name">${escapeHtml(acc.name)}</span>
          ${acc.privileged ? '<span class="js-account-badge">root</span>' : ''}
        </div>
      `;
      item.onclick = () => { overlay.remove(); resolve(acc); };
      list.appendChild(item);
    });

    dialog.appendChild(list);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ssh-btn ssh-btn-secondary';
    cancelBtn.style.marginTop = '12px';
    cancelBtn.textContent = t('sshUnsavedCancel');
    cancelBtn.onclick = () => { overlay.remove(); resolve(null); };
    dialog.appendChild(cancelBtn);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  });
}

// ── Helpers ──

function createFormInput(
  parent: HTMLElement,
  label: string,
  type: string,
  value: string,
  placeholder: string,
): HTMLInputElement {
  const group = document.createElement('div');
  group.className = 'ssh-form-group';
  const lbl = document.createElement('label');
  lbl.textContent = label;
  const input = document.createElement('input');
  input.type = type;
  input.className = 'ssh-input';
  input.value = value;
  input.placeholder = placeholder;
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.setAttribute('autocorrect', 'off');
  input.spellcheck = false;
  group.appendChild(lbl);
  group.appendChild(input);
  parent.appendChild(group);
  return input;
}

// SVG icons for the asset browser sidebar
const SVG_FOLDER = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 3.5h4.3l1.7 1.5h7v8h-13v-9.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/></svg>`;
const SVG_LIST = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
const SVG_CHEVRON_RIGHT = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3.5 1.5L7 5L3.5 8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const SVG_CHEVRON_DOWN = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.5 3.5L5 7L8.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
