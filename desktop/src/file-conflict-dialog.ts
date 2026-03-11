// 文件/文件夹冲突对话框（纯 UI，无状态依赖）

import { escapeHtml } from './status-bar';

/** 显示上传冲突对话框：覆盖 / 重命名 / 跳过 */
export function showUploadConflictDialog(
  filename: string,
  container: HTMLElement
): Promise<{ action: 'overwrite' | 'rename' | 'skip'; newName?: string }> {
  return new Promise((resolve) => {
    container.querySelector('.drawer-modal-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'drawer-modal-overlay';
    overlay.innerHTML = `
      <div class="drawer-modal">
        <div class="drawer-modal-title">文件 "${escapeHtml(filename)}" 已存在</div>
        <div style="margin-bottom:clamp(6px,2%,10px);font-size:clamp(11px,1.4vw,12px);color:var(--text-secondary);">请选择操作：</div>
        <div class="drawer-modal-buttons" style="flex-direction:column;gap:6px;">
          <button class="drawer-modal-btn confirm" data-action="overwrite" style="width:100%">覆盖</button>
          <button class="drawer-modal-btn" data-action="rename" style="width:100%">重命名</button>
          <button class="drawer-modal-btn cancel" data-action="skip" style="width:100%">跳过</button>
        </div>
      </div>
    `;

    container.appendChild(overlay);

    const close = (result: { action: 'overwrite' | 'rename' | 'skip'; newName?: string }) => {
      overlay.remove();
      resolve(result);
    };

    overlay.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const action = target.dataset.action;
      if (action === 'overwrite') {
        close({ action: 'overwrite' });
      } else if (action === 'skip') {
        close({ action: 'skip' });
      } else if (action === 'rename') {
        // 切换到重命名输入模式
        const modal = overlay.querySelector('.drawer-modal') as HTMLElement;
        const ext = filename.includes('.') ? '.' + filename.split('.').pop() : '';
        const base = ext ? filename.slice(0, -ext.length) : filename;
        const suggestName = `${base}_copy${ext}`;
        modal.innerHTML = `
          <div class="drawer-modal-title">重命名上传文件</div>
          <input class="drawer-modal-input" type="text" value="${escapeHtml(suggestName)}" spellcheck="false" />
          <div class="drawer-modal-buttons">
            <button class="drawer-modal-btn cancel">取消</button>
            <button class="drawer-modal-btn confirm">确定</button>
          </div>
        `;
        const input = modal.querySelector('.drawer-modal-input') as HTMLInputElement;
        const confirmBtn = modal.querySelector('.drawer-modal-btn.confirm') as HTMLButtonElement;
        const cancelBtn = modal.querySelector('.drawer-modal-btn.cancel') as HTMLButtonElement;
        input.focus();
        input.select();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && input.value.trim()) close({ action: 'rename', newName: input.value.trim() });
          if (e.key === 'Escape') close({ action: 'skip' });
        });
        confirmBtn.addEventListener('click', () => {
          if (input.value.trim()) close({ action: 'rename', newName: input.value.trim() });
        });
        cancelBtn.addEventListener('click', () => close({ action: 'skip' }));
      }
    });
  });
}

/** 显示文件夹冲突对话框：合并 / 重命名 / 跳过 */
export function showDirConflictDialog(
  dirName: string,
  container: HTMLElement
): Promise<{ action: 'merge' | 'rename' | 'skip'; newName?: string }> {
  return new Promise((resolve) => {
    container.querySelector('.drawer-modal-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'drawer-modal-overlay';
    overlay.innerHTML = `
      <div class="drawer-modal">
        <div class="drawer-modal-title">文件夹 "${escapeHtml(dirName)}" 已存在</div>
        <div style="margin-bottom:clamp(6px,2%,10px);font-size:clamp(11px,1.4vw,12px);color:var(--text-secondary);">请选择操作：</div>
        <div class="drawer-modal-buttons" style="flex-direction:column;gap:6px;">
          <button class="drawer-modal-btn confirm" data-action="merge" style="width:100%">合并</button>
          <button class="drawer-modal-btn" data-action="rename" style="width:100%">重命名</button>
          <button class="drawer-modal-btn cancel" data-action="skip" style="width:100%">跳过</button>
        </div>
      </div>
    `;

    container.appendChild(overlay);

    const close = (result: { action: 'merge' | 'rename' | 'skip'; newName?: string }) => {
      overlay.remove();
      resolve(result);
    };

    overlay.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const action = target.dataset.action;
      if (action === 'merge') {
        close({ action: 'merge' });
      } else if (action === 'skip') {
        close({ action: 'skip' });
      } else if (action === 'rename') {
        const modal = overlay.querySelector('.drawer-modal') as HTMLElement;
        modal.innerHTML = `
          <div class="drawer-modal-title">重命名上传文件夹</div>
          <input class="drawer-modal-input" type="text" value="${escapeHtml(dirName)}_copy" spellcheck="false" />
          <div class="drawer-modal-buttons">
            <button class="drawer-modal-btn cancel">取消</button>
            <button class="drawer-modal-btn confirm">确定</button>
          </div>
        `;
        const input = modal.querySelector('.drawer-modal-input') as HTMLInputElement;
        const confirmBtn = modal.querySelector('.drawer-modal-btn.confirm') as HTMLButtonElement;
        const cancelBtn = modal.querySelector('.drawer-modal-btn.cancel') as HTMLButtonElement;
        input.focus();
        input.select();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && input.value.trim()) close({ action: 'rename', newName: input.value.trim() });
          if (e.key === 'Escape') close({ action: 'skip' });
        });
        confirmBtn.addEventListener('click', () => {
          if (input.value.trim()) close({ action: 'rename', newName: input.value.trim() });
        });
        cancelBtn.addEventListener('click', () => close({ action: 'skip' }));
      }
    });
  });
}
