import { t } from './i18n';
import { loadSettings } from './themes';
import { extractCommand, queryTldr } from './tldr-help';
import { createTldrCard } from './tldr-card';

export const DANGER_PATTERNS = [
  /\brm\s+(-[^\s]*\s+)*-[^\s]*r/,   // rm -r, rm -rf, rm -fr, etc.
  /\brm\s+(-[^\s]*\s+)*\//, // rm /path (root-level deletes)
  /\bmkfs\b/,
  /\bdd\s+/,
  /\b(shutdown|reboot|poweroff|halt)\b/,
  /\bsystemctl\s+(stop|disable|mask)\b/,
  /\bkill\s+-9/,
  /\bkillall\b/,
  /\bpkill\b/,
  /\bchmod\s+(-[^\s]*\s+)*[0-7]*0{2}/,  // chmod 000, 700 etc wide perms
  /\bchown\s+-R/,
  /\bchmod\s+-R/,
  /\b>\s*\/dev\/sd/,
  /\bdrop\s+(database|table|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b/i,
  /\bformat\b/,
  /\bnewfs\b/,
  /\bdiskutil\s+erase/,
  /\bsudo\b/,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+-[^\s]*f/,
  /\biptables\s+-F/,
  /\b:(){ :\|:& };:/,  // fork bomb
];

export function isDangerousCommand(cmd: string): boolean {
  return DANGER_PATTERNS.some((p) => p.test(cmd));
}

export function confirmDangerousCommand(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ai-danger-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'ai-danger-dialog';

    const title = document.createElement('div');
    title.className = 'ai-danger-title';
    title.textContent = t('aiDangerConfirmTitle');

    const msg = document.createElement('div');
    msg.className = 'ai-danger-msg';
    msg.textContent = t('aiDangerConfirmMsg');

    const cmdPreview = document.createElement('pre');
    cmdPreview.className = 'ai-danger-cmd';
    cmdPreview.textContent = cmd;

    const actions = document.createElement('div');
    actions.className = 'ai-danger-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'ai-danger-btn ai-danger-btn-cancel';
    cancelBtn.textContent = t('aiDangerConfirmCancel');

    const runBtn = document.createElement('button');
    runBtn.className = 'ai-danger-btn ai-danger-btn-run';
    runBtn.textContent = t('aiDangerConfirmRun');

    const close = (result: boolean) => {
      overlay.remove();
      resolve(result);
    };

    cancelBtn.addEventListener('click', () => close(false));
    runBtn.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });

    actions.appendChild(cancelBtn);
    actions.appendChild(runBtn);
    dialog.appendChild(title);
    dialog.appendChild(msg);
    dialog.appendChild(cmdPreview);

    // Embed tldr help if available
    const settings = loadSettings();
    if (settings.tldrEnabled) {
      const cmdName = extractCommand(cmd);
      if (cmdName) {
        queryTldr(cmdName).then((result) => {
          if (result.found && result.page) {
            const card = createTldrCard(result.page, { compact: true });
            card.style.marginTop = '8px';
            dialog.insertBefore(card, actions);
          }
        }).catch(() => { /* ignore */ });
      }
    }

    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    cancelBtn.focus();
  });
}
