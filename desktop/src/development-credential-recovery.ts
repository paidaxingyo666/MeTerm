/**
 * Explicit development-only bridge for one-way SSH credential recovery.
 *
 * This module is deliberately not imported by the startup path. Availability
 * is a side-effect-free native feature/signature probe; production Keychain
 * access can happen only after a local user clicks a per-connection action.
 */

import { invoke } from '@tauri-apps/api/core';

let availability: Promise<boolean> | null = null;
const importsInFlight = new Set<string>();

export function isDevelopmentCredentialRecoveryAvailable(): Promise<boolean> {
  availability ??= invoke<boolean>('sync_development_credential_recovery_available')
    .catch((error) => {
      console.warn('[security] Development credential recovery is unavailable:', error);
      return false;
    });
  return availability;
}

export async function importProductionCredentialForDevelopment(
  connectionId: string,
): Promise<'imported' | 'unchanged' | 'unavailable'> {
  if (!connectionId || importsInFlight.has(connectionId)) return 'unavailable';
  importsInFlight.add(connectionId);
  try {
    const imported = await invoke<boolean | null>(
      'sync_import_production_credential_for_development',
      { id: connectionId },
    );
    if (imported === null) return 'unavailable';
    return imported ? 'imported' : 'unchanged';
  } finally {
    importsInFlight.delete(connectionId);
  }
}
