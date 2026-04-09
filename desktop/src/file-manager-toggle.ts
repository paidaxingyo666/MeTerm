/**
 * file-manager-toggle.ts — Shared toggle/switch logic for file manager modes
 */

import { DrawerManager } from './drawer';
import { SidebarManager } from './file-sidebar';
import { TerminalRegistry } from './terminal';
import { loadSettings, saveSettings } from './themes';

/**
 * Toggle file manager visibility for a session (show/hide).
 * Uses the current mode (drawer/sidebar) from settings.
 */
export function toggleFileManager(sessionId: string): void {
  const mode = loadSettings().fileManagerMode;
  if (mode === 'sidebar') {
    if (!SidebarManager.has(sessionId)) {
      SidebarManager.create(sessionId);
    }
    const mainContent = document.getElementById('main-content');
    if (mainContent) SidebarManager.mountTo(sessionId, mainContent);
    SidebarManager.toggle(sessionId);
  } else {
    // Ensure drawer is mounted before toggling
    const terminalPanel = document.getElementById('terminal-panel');
    if (terminalPanel) DrawerManager.mountTo(sessionId, terminalPanel);
    DrawerManager.toggle(sessionId);
  }
  // Re-render toolbar to update active state
  requestAnimationFrame(() => {
    import('./toolbar').then(({ renderToolbarActions }) => renderToolbarActions());
  });
}

/**
 * Switch file manager mode (drawer ↔ sidebar) for the active session.
 * Closes the old mode and opens the new one.
 */
export async function switchFileManagerMode(sessionId: string): Promise<void> {
  const s = loadSettings();
  const oldMode = s.fileManagerMode;
  const newMode = oldMode === 'sidebar' ? 'drawer' : 'sidebar';
  saveSettings({ ...s, fileManagerMode: newMode });

  // Hide old mode
  if (oldMode === 'sidebar') {
    if (SidebarManager.isOpen(sessionId)) {
      SidebarManager.toggle(sessionId); // close
    }
  } else {
    if (DrawerManager.isOpen(sessionId)) {
      DrawerManager.toggle(sessionId); // close
    }
  }

  // Open new mode
  if (newMode === 'sidebar') {
    if (!SidebarManager.has(sessionId)) {
      SidebarManager.create(sessionId);
      const mainContent = document.getElementById('main-content');
      if (mainContent) SidebarManager.mountTo(sessionId, mainContent);
    }
    SidebarManager.toggle(sessionId); // open
  } else {
    const terminalPanel = document.getElementById('terminal-panel');
    if (terminalPanel) DrawerManager.mountTo(sessionId, terminalPanel);
    DrawerManager.toggle(sessionId); // open
  }

  requestAnimationFrame(() => TerminalRegistry.resizeAll());

  // Re-render toolbar to reflect new state
  const { renderToolbarActions } = await import('./toolbar');
  renderToolbarActions();
}
