/**
 * Custom select component for Windows platform.
 * On Windows, native <select> dropdown popups are rendered by the OS and cannot
 * be styled with CSS. This module provides a div-based dropdown replacement.
 * On macOS/Linux, it returns a native <select> element.
 */

const isWindows = document.documentElement.classList.contains('platform-windows');

export interface SelectOption {
  value: string;
  label: string;
  selected?: boolean;
}

/**
 * Unified select element interface returned by createSettingsSelect.
 * Compatible with HTMLSelectElement's value/onchange API.
 */
export interface SettingsSelect {
  /** The root DOM element to insert into the page */
  el: HTMLElement;
  /** Get/set the current value */
  value: string;
  /** Change handler — called when the user picks an option */
  onchange: (() => void) | null;
  /** Dynamically add an option (e.g. for async-loaded shell list) */
  addOption(value: string, label: string, selected?: boolean): void;
}

/** Close any open custom dropdown */
function closeAllDropdowns(): void {
  document.querySelectorAll('.custom-select-dropdown.open').forEach((d) => {
    d.classList.remove('open');
    (d.parentElement as HTMLElement | null)?.classList.remove('open');
  });
}

// Global click-outside handler (registered once)
let _globalListenerAdded = false;
function ensureGlobalListener(): void {
  if (_globalListenerAdded) return;
  _globalListenerAdded = true;
  document.addEventListener('mousedown', (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.custom-select-wrap')) {
      closeAllDropdowns();
    }
  });
}

/**
 * Create a settings select element.
 * On Windows → custom div-based dropdown.
 * On other platforms → native <select>.
 */
export function createSettingsSelect(options: SelectOption[]): SettingsSelect {
  if (!isWindows) {
    return createNativeSelect(options);
  }
  return createCustomSelect(options);
}

/* ---------- Native <select> wrapper ---------- */
function createNativeSelect(options: SelectOption[]): SettingsSelect {
  const sel = document.createElement('select');
  sel.className = 'settings-select';
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.selected) o.selected = true;
    sel.appendChild(o);
  }

  const api: SettingsSelect = {
    el: sel,
    get value() { return sel.value; },
    set value(v: string) { sel.value = v; },
    onchange: null,
    addOption(value: string, label: string, selected?: boolean) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      if (selected) o.selected = true;
      sel.appendChild(o);
    },
  };

  sel.addEventListener('change', () => { api.onchange?.(); });
  return api;
}

/* ---------- Custom div-based select (Windows) ---------- */
function createCustomSelect(options: SelectOption[]): SettingsSelect {
  ensureGlobalListener();

  let currentValue = '';
  let _onchange: (() => void) | null = null;

  // Wrapper
  const wrap = document.createElement('div');
  wrap.className = 'custom-select-wrap settings-select';

  // Trigger button
  const trigger = document.createElement('div');
  trigger.className = 'custom-select-trigger';

  const triggerText = document.createElement('span');
  triggerText.className = 'custom-select-text';
  trigger.appendChild(triggerText);

  const arrow = document.createElement('span');
  arrow.className = 'custom-select-arrow';
  arrow.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5L5 6.5L7.5 3.5"/></svg>`;
  trigger.appendChild(arrow);

  wrap.appendChild(trigger);

  // Dropdown
  const dropdown = document.createElement('div');
  dropdown.className = 'custom-select-dropdown';
  wrap.appendChild(dropdown);

  function selectValue(value: string, label: string): void {
    currentValue = value;
    triggerText.textContent = label;
    // Update selected state
    dropdown.querySelectorAll('.custom-select-option').forEach((el) => {
      el.classList.toggle('selected', (el as HTMLElement).dataset.value === value);
    });
  }

  function addOptionElement(value: string, label: string, selected?: boolean): void {
    const optEl = document.createElement('div');
    optEl.className = 'custom-select-option';
    optEl.dataset.value = value;
    optEl.textContent = label;
    if (selected) optEl.classList.add('selected');

    optEl.addEventListener('click', (e) => {
      e.stopPropagation();
      selectValue(value, label);
      closeAllDropdowns();
      _onchange?.();
    });

    dropdown.appendChild(optEl);

    if (selected) {
      selectValue(value, label);
    }
  }

  // Populate initial options
  let hasSelected = false;
  for (const opt of options) {
    addOptionElement(opt.value, opt.label, opt.selected);
    if (opt.selected) hasSelected = true;
  }
  // Default to first option if none selected
  if (!hasSelected && options.length > 0) {
    selectValue(options[0].value, options[0].label);
    const first = dropdown.querySelector('.custom-select-option') as HTMLElement | null;
    first?.classList.add('selected');
  }

  // Toggle dropdown
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = dropdown.classList.contains('open');
    closeAllDropdowns();
    if (!isOpen) {
      dropdown.classList.add('open');
      wrap.classList.add('open');
      // Scroll selected into view
      const sel = dropdown.querySelector('.custom-select-option.selected') as HTMLElement | null;
      if (sel) sel.scrollIntoView({ block: 'nearest' });
    }
  });

  // Keyboard navigation
  wrap.tabIndex = 0;
  wrap.addEventListener('keydown', (e) => {
    const opts = Array.from(dropdown.querySelectorAll('.custom-select-option')) as HTMLElement[];
    if (!opts.length) return;
    const idx = opts.findIndex((o) => o.dataset.value === currentValue);

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!dropdown.classList.contains('open')) {
        dropdown.classList.add('open');
        wrap.classList.add('open');
        return;
      }
      const next = e.key === 'ArrowDown'
        ? Math.min(idx + 1, opts.length - 1)
        : Math.max(idx - 1, 0);
      selectValue(opts[next].dataset.value!, opts[next].textContent!);
      opts[next].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (dropdown.classList.contains('open')) {
        closeAllDropdowns();
        _onchange?.();
      } else {
        dropdown.classList.add('open');
        wrap.classList.add('open');
      }
    } else if (e.key === 'Escape') {
      closeAllDropdowns();
    }
  });

  const api: SettingsSelect = {
    el: wrap,
    get value() { return currentValue; },
    set value(v: string) {
      const optEl = dropdown.querySelector(`.custom-select-option[data-value="${CSS.escape(v)}"]`) as HTMLElement | null;
      if (optEl) {
        selectValue(v, optEl.textContent!);
      }
    },
    get onchange() { return _onchange; },
    set onchange(fn: (() => void) | null) { _onchange = fn; },
    addOption: addOptionElement,
  };

  return api;
}
