import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  detectSshMigrationPendingAtStartup,
  getSshCredentialMigrationManualState,
  toSavedConnection,
  toSSHConnectionConfig,
  type SavedConnection,
} from '../src/connection-sync.ts';

const metadata: SavedConnection = {
  id: 'registry-id-1',
  name: 'production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  auth_method: 'key',
  has_key_path: true,
  updated_at: 123,
  deleted_at: null,
  proxy_type: 'socks5',
  proxy_host: '127.0.0.1',
  proxy_port: 1080,
  proxy_username: 'proxy-user',
};

test('pulled connection mapping contains metadata and stable id but no copied secrets', () => {
  const mapped = toSSHConnectionConfig(metadata, {
    name: 'old-name',
    host: 'old.example.com',
    port: 2222,
    username: 'old-user',
    authMethod: 'key',
    password: 'local-password',
    privateKey: '~/.ssh/id_ed25519',
    passphrase: 'local-passphrase',
    proxyPassword: 'local-proxy-password',
  });

  assert.equal((mapped as typeof mapped & { serverConnectionId?: string }).serverConnectionId, metadata.id);
  assert.equal(mapped.privateKey, '~/.ssh/id_ed25519');
  assert.equal(mapped.password, undefined);
  assert.equal(mapped.passphrase, undefined);
  assert.equal(mapped.proxyPassword, undefined);
});

test('pulled connection never copies inline private key material into WebView state', () => {
  const mapped = toSSHConnectionConfig(metadata, {
    name: 'production',
    host: 'prod.example.com',
    port: 22,
    username: 'deploy',
    authMethod: 'key',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n',
  });

  assert.equal(mapped.privateKey, undefined);
});

test('registry-backed rename keeps the stable id and removes the stale name mapping', () => {
  const storage = new Map<string, string>([
    ['meterm-connection-ids', JSON.stringify({ 'old-name': 'registry-id-1' })],
  ]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });

  const saved = toSavedConnection({
    name: 'new-name',
    host: 'prod.example.com',
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    serverConnectionId: 'registry-id-1',
  } as Parameters<typeof toSavedConnection>[0] & { serverConnectionId: string });

  assert.equal(saved.id, 'registry-id-1');
  assert.deepEqual(JSON.parse(storage.get('meterm-connection-ids')!), {
    'new-name': 'registry-id-1',
  });
});

test('secret-returning sync command stays absent from Rust, ACL, and WebView pull code', async () => {
  const files = await Promise.all([
    readFile(new URL('../src/connection-sync.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/commands/connection_sync.rs', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/build.rs', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/permissions/app-commands.toml', import.meta.url), 'utf8'),
  ]);

  for (const source of files) assert.doesNotMatch(source, /sync_get_secrets/);
});

test('SSH export validates the vault authority before materializing secrets', async () => {
  const source = await readFile(
    new URL('../src-tauri/src/commands/connection_export.rs', import.meta.url),
    'utf8',
  );
  const validations = source.match(/validate_bound_authority/g) ?? [];
  assert.equal(validations.length, 2);
});

test('startup never scans or retries production SSH credential recovery', async () => {
  const [main, syncFrontend, nativeStartup, explicitRecovery, recoveryMenu] = await Promise.all([
    readFile(new URL('../src/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/connection-sync.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/server/startup.rs', import.meta.url), 'utf8'),
    readFile(new URL('../src/development-credential-recovery.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/development-credential-recovery-ui.ts', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(main, /sync_import_production_credential/);
  assert.doesNotMatch(main, /development-credential-recovery/);
  assert.doesNotMatch(main, /meterm-dev-production-ssh-import/);
  assert.doesNotMatch(main, /migrateSSHCredentials|importConnectionsOnce|sync_migrate_known_secrets/);
  assert.match(main, /detectSshMigrationPendingAtStartup/);
  assert.doesNotMatch(nativeStartup, /migrate_known_secrets|scrub_insecure_legacy_keychain/);
  assert.match(syncFrontend, /runExplicitSshCredentialMigration/);
  assert.doesNotMatch(explicitRecovery, /localStorage|sessionStorage|setTimeout|setInterval/);
  assert.match(explicitRecovery, /sync_import_production_credential_for_development/);
  assert.match(recoveryMenu, /importProductionCredentialForDevelopment/);
  assert.match(recoveryMenu, /appendSshConnectionMenuItems/);
});

test('legacy named SSH migration is single-window and tracks authority snapshot progress', async () => {
  const [frontend, native] = await Promise.all([
    readFile(new URL('../src/connection-sync.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/commands/connection_sync.rs', import.meta.url), 'utf8'),
  ]);

  assert.match(frontend, /meterm-sync-imported-v3-progress/);
  assert.match(frontend, /meterm-ssh-migration-v4-manual-required/);
  assert.match(frontend, /saveImportProgress\(importProgress\)/);
  assert.match(frontend, /runExplicitSshCredentialMigration/);
  assert.match(native, /legacy SSH credential migration is main-window only/);
});

test('startup SSH migration detector is local-only and preserves plaintext pending sources', async () => {
  const storage = new Map<string, string>([
    ['meterm-ssh-connections', JSON.stringify([{
      name: 'legacy-prod',
      host: 'prod.example.com',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      password: 'only-plaintext-copy',
    }])],
  ]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });

  const state = await detectSshMigrationPendingAtStartup();
  assert.deepEqual(state, {
    version: 4,
    required: true,
    reasons: ['legacy_plaintext', 'legacy_named_keychain'],
  });
  assert.deepEqual(getSshCredentialMigrationManualState(), state);
  assert.equal(
    JSON.parse(storage.get('meterm-ssh-connections')!)[0].password,
    'only-plaintext-copy',
  );

  const source = await readFile(new URL('../src/connection-sync.ts', import.meta.url), 'utf8');
  const storageInspector = source.slice(
    source.indexOf('function inspectStoredSshMigrationSource'),
    source.indexOf('function loadImportProgress'),
  );
  const detector = source.slice(
    source.indexOf('export function detectSshMigrationPendingAtStartup'),
    source.indexOf('let explicitMigrationPromise'),
  );
  for (const startupOnlySource of [storageInspector, detector]) {
    assert.doesNotMatch(startupOnlySource, /invoke\(/);
    assert.doesNotMatch(startupOnlySource, /import\(/);
  }
});

test('explicit plaintext migration scrubs each item only after its native write', async () => {
  const source = await readFile(new URL('../src/ssh.ts', import.meta.url), 'utf8');
  const migration = source.slice(
    source.indexOf('export async function migrateSSHCredentials'),
    source.indexOf('// ─── Connection storage'),
  );
  assert.ok(migration.indexOf('await syncUpsert(connection)') >= 0);
  assert.ok(
    migration.indexOf('await syncUpsert(connection)')
      < migration.indexOf('connections[index] = stripSecrets(connection)'),
  );
  assert.match(migration, /markSshCredentialMigrationManualRequired\('legacy_plaintext', 'previous_failure'\)/);
});

test('Remote and JumpServer startup migration is main-window-only and never probes metadata-only Keychain entries', async () => {
  const [main, remote, jumpServer] = await Promise.all([
    readFile(new URL('../src/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/remote-storage.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/jumpserver-api.ts', import.meta.url), 'utf8'),
  ]);

  const startupMigration = main.slice(
    main.indexOf("if (currentWindowLabel === 'main')"),
    main.indexOf('// Fire-and-forget: reverse pull'),
  );
  assert.match(startupMigration, /detectRemoteCredentialMigrationPendingAtStartup\(\)/);
  assert.match(startupMigration, /detectJumpServerCredentialMigrationPendingAtStartup\(\)/);

  const remoteMigration = remote.slice(
    remote.indexOf('export async function detectRemoteCredentialMigrationPendingAtStartup'),
    remote.indexOf('export function loadSavedRemoteConnections'),
  );
  assert.match(remote, /meterm-remote-credential-migration-v1/);
  assert.match(remoteMigration, /CREDENTIAL_MIGRATION_MANUAL/);
  assert.match(remoteMigration, /!hasPlaintext[\s\S]*CREDENTIAL_MIGRATION_COMPLETE/);
  assert.doesNotMatch(remoteMigration, /invoke\(|storeRemoteToken|hasRemoteToken/);

  const jumpServerMigration = jumpServer.slice(
    jumpServer.indexOf('export async function detectJumpServerCredentialMigrationPendingAtStartup'),
    jumpServer.indexOf('// ── API Calls'),
  );
  assert.match(jumpServer, /meterm-jumpserver-credential-migration-v1/);
  assert.match(jumpServerMigration, /CREDENTIAL_MIGRATION_MANUAL/);
  assert.match(jumpServerMigration, /plaintextConfigs\.length === 0[\s\S]*CREDENTIAL_MIGRATION_COMPLETE/);
  assert.doesNotMatch(jumpServerMigration, /invoke\(|jumpserver_store_credentials|jumpserver_migrate_credentials/);
  assert.match(jumpServer, /addJumpServerConfig[\s\S]*jumpserver_migrate_credentials/);
});

test('saved-session Broker is used for connect, reconnect, split, and test routes', async () => {
  const [handler, overlays, tabs, server] = await Promise.all([
    readFile(new URL('../src/ssh-handler.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/overlays.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/tabs.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/server/mod.rs', import.meta.url), 'utf8'),
  ]);

  assert.match(handler, /createSSHSessionForConfig/);
  assert.match(overlays, /createSSHSessionForConfig/);
  assert.match(tabs, /createSSHSessionForConfig/);
  assert.match(server, /\/api\/sessions\/ssh\/saved\/test/);
});
