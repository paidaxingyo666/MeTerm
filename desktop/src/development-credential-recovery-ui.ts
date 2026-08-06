import { message } from '@tauri-apps/plugin-dialog';
import type { SSHConnectionConfig } from './ssh';
import { loadSettings } from './themes';
import {
  importProductionCredentialForDevelopment,
  isDevelopmentCredentialRecoveryAvailable,
} from './development-credential-recovery';

const l = (zh: string, en: string): string => (loadSettings().language === 'zh' ? zh : en);

/** Add the normal edit action and, only in the signed Dev build, one explicit
 * per-connection credential recovery action. */
export function appendSshConnectionMenuItems(
  menu: HTMLElement,
  config: SSHConnectionConfig,
  editLabel: string,
  onEdit: () => void,
): void {
  const editItem = document.createElement('button');
  editItem.className = 'home-card-menu-item';
  editItem.textContent = editLabel;
  editItem.onclick = onEdit;
  menu.appendChild(editItem);

  if (!config.serverConnectionId) return;
  const recoveryItem = document.createElement('button');
  recoveryItem.className = 'home-card-menu-item';
  recoveryItem.textContent = l(
    '从隔离的旧正式库导入此凭据（开发）',
    'Import this quarantined legacy credential (Dev)',
  );
  recoveryItem.title = l(
    '仅用于开发测试。macOS 钥匙串弹窗只选“允许”，绝不要选“始终允许”。',
    'Explicit development-only operation. In a macOS Keychain dialog choose Allow, never Always Allow.',
  );
  recoveryItem.style.display = 'none';
  recoveryItem.onclick = async () => {
    menu.remove();
    try {
      const result = await importProductionCredentialForDevelopment(config.serverConnectionId!);
      const body = result === 'imported'
        ? l(
          '匹配的旧 v2 凭据已复制到隔离的开发凭据库，正式版条目未被修改。',
          'The matching legacy v2 credential was copied into the isolated development vault. The production item was not changed.',
        )
        : l(
          '未找到可导入的匹配旧 v2 凭据，或开发凭据库已存在该凭据。',
          'No matching legacy v2 credential was imported, or the development vault already has this credential.',
        );
      await message(body, { title: recoveryItem.textContent, kind: 'info' });
    } catch (error) {
      console.warn('[security] Explicit development credential import failed:', error);
      await message(l(
        '导入未完成，后续启动不会自动重试。钥匙串弹窗只选“允许”，绝不要选“始终允许”。',
        'Import was not completed. It will not retry automatically. In Keychain dialogs choose Allow, never Always Allow.',
      ), { title: recoveryItem.textContent, kind: 'error' });
    }
  };
  menu.appendChild(recoveryItem);
  void isDevelopmentCredentialRecoveryAvailable().then((available) => {
    if (available && menu.isConnected) recoveryItem.style.display = '';
  });
}
