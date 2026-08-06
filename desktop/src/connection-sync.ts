/**
 * connection-sync.ts — 桌面前端 → 服务端连接同步注册表 镜像层
 *
 * 背景:F1 已经在 Rust 侧(`desktop/src-tauri/src/commands/connection_sync.rs`)
 * 实现了 `ConnectionRegistry` + 钥匙串密钥库,并暴露三个 Tauri 命令
 * (`sync_upsert_connection` / `sync_delete_connection` / `sync_get_connections`)。
 * 本文件是 F2:把 `ssh.ts` 现有的 localStorage 元数据保存逻辑
 * **原样保留**,只在其之上叠加一层——每次增/删/改都顺带把连接推给服务端。
 * 旧凭据导入仅由显式用户操作触发；启动路径只读 localStorage 中的非秘密
 * pending 状态，绝不扫描 Keychain。
 *
 * 设计规格:docs/superpowers/specs/2026-07-05-ssh-connection-sync-design.md §5。
 * 本文件同时做 PUSH(导入 + 镜像)和 PULL(反向下拉):
 *   - PUSH:`syncUpsert` / `syncDelete` / `runExplicitSshCredentialMigration`(F2)。
 *   - PULL:`pullConnections`(F3b)——把手机/其他设备新建或删除的连接
 *     合并回本地。PULL 只同步元数据和稳定连接 id,**绝不**把 Rust vault
 *     中的密钥取回 WebView,也不覆盖前端已有的本地密钥。
 */

import { invoke } from '@tauri-apps/api/core';
import type { SSHConnectionConfig } from './ssh';

type RegistryBackedConnection = SSHConnectionConfig & { serverConnectionId?: string };

/** 服务端 `SavedConnection` 的 JSON 形状(snake_case,与 Rust 结构体字段对齐,见 F1)。 */
export interface SavedConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_method: 'password' | 'key';
  has_key_path: boolean;
  uses_desktop_key_ladder: boolean;
  updated_at: number;
  deleted_at: number | null;
  proxy_type?: string;
  proxy_host?: string;
  proxy_port?: number;
  proxy_username?: string;
  skip_shell_hook?: boolean;
  multiplex_sftp?: boolean;
}

/** 服务端 `SshSecrets` 的 JSON 形状(snake_case)。 */
interface SavedSecrets {
  password?: string;
  private_key_pem?: string;
  passphrase?: string;
  proxy_password?: string;
  private_key_path?: string;
}

const ID_MAP_KEY = 'meterm-connection-ids';
const SSH_CONNECTIONS_STORAGE_KEY = 'meterm-ssh-connections';
const SSH_RECENT_STORAGE_KEY = 'meterm-ssh-recent';
// v3 represents the native, identity-confirmed name-keyed migration. Do not
// trust the older v2 marker: older builds could set it after a best-effort
// import that did not complete the authority-bound vault transition.
const IMPORTED_FLAG_KEY = 'meterm-sync-imported-v3';
const IMPORTED_PROGRESS_KEY = 'meterm-sync-imported-v3-progress';
const UPDATED_MAP_KEY = 'meterm-connection-updated';
const MANUAL_MIGRATION_MARKER_KEY = 'meterm-ssh-migration-v4-manual-required';
const MANUAL_MIGRATION_VERSION = 4;

export type SshManualMigrationReason =
  | 'legacy_plaintext'
  | 'legacy_named_keychain'
  | 'previous_failure';

export interface SshManualMigrationState {
  version: 4;
  required: true;
  reasons: SshManualMigrationReason[];
}

function loadManualMigrationState(): SshManualMigrationState | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(MANUAL_MIGRATION_MARKER_KEY) ?? 'null');
    if (parsed?.version !== MANUAL_MIGRATION_VERSION
      || parsed?.required !== true
      || !Array.isArray(parsed.reasons)) return null;
    const candidates: unknown[] = parsed.reasons;
    const reasons = candidates.filter((reason): reason is SshManualMigrationReason => (
      reason === 'legacy_plaintext'
      || reason === 'legacy_named_keychain'
      || reason === 'previous_failure'
    ));
    return reasons.length > 0
      ? { version: MANUAL_MIGRATION_VERSION, required: true, reasons: [...new Set(reasons)] }
      : null;
  } catch {
    return null;
  }
}

/** Persist only redacted reason codes; native errors and account names never enter Web Storage. */
export function markSshCredentialMigrationManualRequired(
  ...reasons: SshManualMigrationReason[]
): SshManualMigrationState {
  const current = loadManualMigrationState();
  const state: SshManualMigrationState = {
    version: MANUAL_MIGRATION_VERSION,
    required: true,
    reasons: [...new Set([...(current?.reasons ?? []), ...reasons])],
  };
  localStorage.setItem(MANUAL_MIGRATION_MARKER_KEY, JSON.stringify(state));
  return state;
}

export function getSshCredentialMigrationManualState(): SshManualMigrationState | null {
  return loadManualMigrationState();
}

interface StoredSshMigrationInspection {
  hasEntries: boolean;
  hasLegacyPlaintext: boolean;
}

/**
 * Inspect legacy Web Storage without importing `ssh.ts`. Keeping this helper
 * self-contained is deliberate: startup must not load a module whose explicit
 * migration entry points can reach native commands or Keychain.
 */
function inspectStoredSshMigrationSource(storageKey: string): StoredSshMigrationInspection {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return { hasEntries: false, hasLegacyPlaintext: false };
  try {
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) {
      // Corrupt legacy data may still be the only credential copy. Require an
      // explicit recovery flow and leave the original bytes untouched.
      return { hasEntries: true, hasLegacyPlaintext: true };
    }
    const hasLegacyPlaintext = values.some((value) => {
      if (typeof value !== 'object' || value === null) return true;
      const connection = value as Record<string, unknown>;
      const privateKey = typeof connection.privateKey === 'string'
        ? connection.privateKey
        : '';
      const trimmedPrivateKey = privateKey.trimStart();
      const hasInlinePrivateKey = privateKey.includes('\n')
        || trimmedPrivateKey.startsWith('-----BEGIN ')
        || trimmedPrivateKey.startsWith('---- BEGIN SSH2 ')
        || trimmedPrivateKey.startsWith('PuTTY-User-Key-File-');
      return Boolean(
        connection.password
        || connection.passphrase
        || connection.proxyPassword
        || hasInlinePrivateKey
      );
    });
    return { hasEntries: values.length > 0, hasLegacyPlaintext };
  } catch {
    return { hasEntries: true, hasLegacyPlaintext: true };
  }
}

function loadImportProgress(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(IMPORTED_PROGRESS_KEY) ?? '[]');
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((value): value is string => typeof value === 'string'));
    }
  } catch { /* Corrupt progress is retried safely per connection. */ }
  return new Set();
}

function saveImportProgress(progress: Set<string>): void {
  localStorage.setItem(IMPORTED_PROGRESS_KEY, JSON.stringify([...progress]));
}

function importProgressKey(saved: SavedConnection, privateKeyPath: string | null): string {
  return JSON.stringify([
    saved.id,
    saved.name,
    saved.host,
    saved.port,
    saved.username,
    saved.auth_method,
    saved.has_key_path,
    saved.uses_desktop_key_ladder,
    saved.proxy_type ?? null,
    saved.proxy_host ?? null,
    saved.proxy_port ?? null,
    saved.proxy_username ?? null,
    saved.skip_shell_hook ?? null,
    saved.multiplex_sftp ?? null,
    privateKeyPath,
  ]);
}

/** 读取 name→uuid 映射表(localStorage,损坏/缺失时视为空表)。 */
function loadIdMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(ID_MAP_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* 损坏的 JSON —— 视为空表重新开始 */ }
  return {};
}

function saveIdMap(map: Record<string, string>): void {
  localStorage.setItem(ID_MAP_KEY, JSON.stringify(map));
}

/**
 * 读取 id→updated_at(ms)映射表:记录本设备最后一次写入/导入某连接时的
 * `updated_at`。反向 pull 时用它区分"服务端更新(手机改的,时间戳更大)"
 * 与"本设备自己刚 push 的回声(时间戳相等)",避免自我更新死循环。
 * 损坏/缺失时视为空表。
 */
function loadUpdatedMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(UPDATED_MAP_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* 损坏的 JSON —— 视为空表重新开始 */ }
  return {};
}

function saveUpdatedMap(map: Record<string, number>): void {
  localStorage.setItem(UPDATED_MAP_KEY, JSON.stringify(map));
}

/**
 * 连接名 → 稳定 UUID。服务端注册表按 id 索引,桌面本地仍按 name 索引
 * (localStorage/钥匙串沿用现有习惯不改),这里维护一份持久化映射,
 * 首次访问某个名字时现铸一个 UUID 并落盘。
 */
export function connectionId(name: string): string {
  const map = loadIdMap();
  const existing = map[name];
  if (existing) return existing;
  const id = crypto.randomUUID();
  map[name] = id;
  saveIdMap(map);
  return id;
}

/** 只读查询现有 name→id 映射；不存在时绝不为临时连接创建注册表身份。 */
export function existingConnectionId(name: string): string | undefined {
  return loadIdMap()[name];
}

function connectionIdForConfig(cfg: SSHConnectionConfig): string {
  const registryId = (cfg as RegistryBackedConnection).serverConnectionId;
  if (!registryId) return connectionId(cfg.name);
  const map = loadIdMap();
  for (const [name, id] of Object.entries(map)) {
    if (id === registryId && name !== cfg.name) delete map[name];
  }
  if (map[cfg.name] !== registryId) {
    map[cfg.name] = registryId;
  }
  saveIdMap(map);
  return registryId;
}

/** 连接删除时把 name→id 映射里的旧条目清掉,避免占位残留。 */
function dropConnectionId(name: string): void {
  const map = loadIdMap();
  if (!(name in map)) return;
  delete map[name];
  saveIdMap(map);
}

/** `privateKey` 字段究竟是文件路径(`~/.ssh/xxx`、`/abs/path`)还是内联 PEM 内容。 */
function isKeyPath(privateKey: string): boolean {
  const trimmed = privateKey.trimStart();
  return !privateKey.includes('\n')
    && !trimmed.startsWith('-----BEGIN ')
    && !trimmed.startsWith('---- BEGIN SSH2 ')
    && !trimmed.startsWith('PuTTY-User-Key-File-');
}

/** camelCase 前端配置 → snake_case 服务端连接元数据(供 `sync_upsert_connection` 用)。 */
export function toSavedConnection(cfg: SSHConnectionConfig): SavedConnection {
  const hasKeyPath = cfg.authMethod === 'key' && !!cfg.privateKey && isKeyPath(cfg.privateKey);
  return {
    id: connectionIdForConfig(cfg),
    name: cfg.name,
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    auth_method: cfg.authMethod,
    has_key_path: hasKeyPath,
    uses_desktop_key_ladder: cfg.authMethod === 'key' && cfg.usesDesktopKeyLadder === true,
    updated_at: Date.now(),
    deleted_at: null,
    proxy_type: cfg.proxyType,
    proxy_host: cfg.proxyHost,
    proxy_port: cfg.proxyPort,
    proxy_username: cfg.proxyUsername,
    skip_shell_hook: cfg.skipShellHook,
    multiplex_sftp: cfg.multiplexSftp,
  };
}

/**
 * camelCase 前端密钥 → snake_case 服务端 secrets。
 * `hasKeyPath` 连接(`~/.ssh` 路径认证)不导出 PEM 内容——只在电脑端可用,
 * 与设计稿 §2/§5 一致。
 */
export function toSecrets(cfg: SSHConnectionConfig): SavedSecrets {
  const secrets: SavedSecrets = {};
  if (cfg.authMethod === 'password' && cfg.password) secrets.password = cfg.password;
  if (cfg.authMethod === 'key' && cfg.passphrase) secrets.passphrase = cfg.passphrase;
  if (cfg.proxyType && cfg.proxyPassword) secrets.proxy_password = cfg.proxyPassword;
  if (cfg.authMethod === 'key' && cfg.privateKey && !isKeyPath(cfg.privateKey)) {
    secrets.private_key_pem = cfg.privateKey;
  }
  if (cfg.authMethod === 'key' && cfg.privateKey && isKeyPath(cfg.privateKey)) {
    secrets.private_key_path = cfg.privateKey;
  }
  return secrets;
}

/**
 * 把一个连接推给服务端同步注册表(建/改)。
 *
 * `cfg` 只包含用户刚输入的秘密。metadata-only 编辑传 `null`，Rust vault
 * 保留原值；本函数绝不从 Keychain 把秘密读回 WebView。
 */
export async function syncUpsert(cfg: SSHConnectionConfig): Promise<void> {
  const secrets = toSecrets(cfg);
  const hasSecrets = !!(
    secrets.password
    || secrets.private_key_pem
    || secrets.passphrase
    || secrets.proxy_password
    || secrets.private_key_path
  );
  const saved = toSavedConnection(cfg);
  await invoke('sync_upsert_connection', {
    connection: saved,
    secrets: hasSecrets ? secrets : null,
  });
  const updated = loadUpdatedMap();
  updated[saved.id] = saved.updated_at;
  saveUpdatedMap(updated);
}

/**
 * 告知服务端软删除某连接,并清理本地 name→id 映射。
 * 失败只告警,不影响本地既有的删除流程。
 */
export async function syncDelete(name: string): Promise<void> {
  await invoke('sync_delete_connection', { id: connectionId(name) });
  dropConnectionId(name);
}

/**
 * Explicit, owner-triggered import of former name-keyed Keychain accounts.
 * The success/progress markers make retries idempotent, but startup must never
 * call this function.
 */
export async function importConnectionsOnce(): Promise<void> {
  if (localStorage.getItem(IMPORTED_FLAG_KEY)) return;
  try {
    const { loadSavedConnections } = await import('./ssh');
    const local = loadSavedConnections();
    const importProgress = loadImportProgress();
    for (const conn of local) {
      const saved = toSavedConnection(conn);
      const privateKeyPath = conn.authMethod === 'key'
        && conn.privateKey
        && isKeyPath(conn.privateKey)
        ? conn.privateKey
        : null;
      const progressKey = importProgressKey(saved, privateKeyPath);
      if (!importProgress.has(progressKey)) {
        await invoke('sync_import_named_connection', {
          connection: saved,
          privateKeyPath,
        });
        importProgress.add(progressKey);
        saveImportProgress(importProgress);
        const updated = loadUpdatedMap();
        updated[saved.id] = saved.updated_at;
        saveUpdatedMap(updated);
      }
    }
    // The name→id map is already durable. Do not call saveConnections here:
    // a caller that invokes only this explicit phase must not accidentally
    // scrub a plaintext value before its separate vault write succeeds.
    localStorage.setItem(IMPORTED_FLAG_KEY, '1');
    localStorage.removeItem(IMPORTED_PROGRESS_KEY);
  } catch (error) {
    markSshCredentialMigrationManualRequired('legacy_named_keychain', 'previous_failure');
    throw error;
  }
}

/**
 * Startup-safe inspection. It reads only Web Storage and writes a redacted
 * pending marker; it never invokes a native command or touches Keychain.
 */
export function detectSshMigrationPendingAtStartup(): SshManualMigrationState | null {
  const saved = inspectStoredSshMigrationSource(SSH_CONNECTIONS_STORAGE_KEY);
  const recent = inspectStoredSshMigrationSource(SSH_RECENT_STORAGE_KEY);
  const reasons: SshManualMigrationReason[] = [];
  if (saved.hasLegacyPlaintext || recent.hasLegacyPlaintext) reasons.push('legacy_plaintext');
  if (!localStorage.getItem(IMPORTED_FLAG_KEY) && saved.hasEntries) {
    reasons.push('legacy_named_keychain');
  }

  if (reasons.length === 0) {
    localStorage.removeItem(MANUAL_MIGRATION_MARKER_KEY);
    return null;
  }
  return markSshCredentialMigrationManualRequired(...reasons);
}

let explicitMigrationPromise: Promise<void> | null = null;

/**
 * Minimal UI hook for the owner-triggered migration. Calls are single-flight;
 * a failure retains every not-yet-committed source and remains manual-only.
 */
export function runExplicitSshCredentialMigration(): Promise<void> {
  if (explicitMigrationPromise) return explicitMigrationPromise;
  explicitMigrationPromise = (async () => {
    try {
      const { migrateSSHCredentials } = await import('./ssh');
      await migrateSSHCredentials();
      await importConnectionsOnce();
      await detectSshMigrationPendingAtStartup();
    } catch (error) {
      markSshCredentialMigrationManualRequired('previous_failure');
      throw error;
    } finally {
      explicitMigrationPromise = null;
    }
  })();
  return explicitMigrationPromise;
}

export function connectionIdsForConfigs(configs: readonly SSHConnectionConfig[]): string[] {
  return configs.map(connectionIdForConfig);
}

/**
 * `toSavedConnection` 的逆向:只把 snake_case 服务端元数据转换成 camelCase
 * 前端配置，并携带稳定 id 供 saved-session Broker 使用。vault secrets 永不经过
 * 本函数或 WebView IPC。
 *
 * 注:`has_key_path` 连接的路径不可跨设备同步；仅当本机原有同 id 配置确实已有
 * 路径时才保留它。密码、内联私钥、passphrase、代理密码一律不复制。
 */
export function toSSHConnectionConfig(
  saved: SavedConnection,
  existing?: SSHConnectionConfig,
): SSHConnectionConfig {
  const cfg: SSHConnectionConfig & { serverConnectionId: string } = {
    name: saved.name,
    host: saved.host,
    port: saved.port,
    username: saved.username,
    authMethod: saved.auth_method,
    usesDesktopKeyLadder: saved.uses_desktop_key_ladder,
    serverConnectionId: saved.id,
  };
  if (saved.has_key_path && existing?.privateKey && isKeyPath(existing.privateKey)) {
    cfg.privateKey = existing.privateKey;
  }
  if (saved.proxy_type) cfg.proxyType = saved.proxy_type;
  if (saved.proxy_host) cfg.proxyHost = saved.proxy_host;
  if (saved.proxy_port) cfg.proxyPort = saved.proxy_port;
  if (saved.proxy_username) cfg.proxyUsername = saved.proxy_username;
  if (saved.skip_shell_hook) cfg.skipShellHook = saved.skip_shell_hook;
  if (saved.multiplex_sftp) cfg.multiplexSftp = saved.multiplex_sftp;
  return cfg;
}

/**
 * 反向拉取:把服务端同步注册表里、本机尚未持有的连接(手机/其他设备新建)
 * 合并到本地;把别处**改过**的已知连接(时间戳更新)就地更新(改名/主机/端口等,I2);
 * 把别处删除的连接(墓碑)在本地一并清除。
 *
 * 循环安全:拉进来的连接会登记进 name→id 映射,之后用户再编辑复用同一 id
 * (更新而非重复);且本函数**直接** `saveConnections` 落盘 + dispatch 刷新事件,
 * **绝不**调用 `addConnection`/`removeConnection` 这些会再次 push 的镜像路径,
 * 因此不会 push↔pull 死循环。已知连接的就地更新靠 id→updated_at 映射比对时间戳:
 * 本设备自己 push 的回声(时间戳相等)不触发更新,仅服务端确有更新时才更新。
 *
 * 整个函数体裹在 try/catch 里,任何失败只告警,绝不抛出、绝不影响本地既有的
 * SSH 连接管理。应当以 fire-and-forget 方式调用(启动一次 + 轻量轮询)。
 */
export async function pullConnections(): Promise<void> {
  try {
    const server = (await invoke('sync_get_connections')) as SavedConnection[];
    if (!Array.isArray(server)) return;

    // 惰性 import 避免 ssh.ts ↔ connection-sync.ts 的静态循环依赖
    const { loadSavedConnections, saveConnections } = await import('./ssh');

    const map = loadIdMap();
    const updated = loadUpdatedMap();             // id → 本设备最后写入的 updated_at(ms)
    const knownIds = new Set(Object.values(map)); // 本机已拥有(自己 push 过)的 id
    const idToName: Record<string, string> = {};  // map 的反向:id → name
    for (const [name, id] of Object.entries(map)) idToName[id] = name;

    let local = loadSavedConnections();
    let changed = false;

    for (const s of server) {
      // ① 墓碑:别处已删除。本机若持有(靠 id→name 反查)则一并清除。
      if (s.deleted_at != null) {
        const name = idToName[s.id];
        if (name && local.some((c) => c.name === name)) {
          local = local.filter((c) => c.name !== name);
          dropConnectionId(name);
          changed = true;
        }
        continue;
      }
      // ② 活跃且本机已拥有。服务端时间戳比本设备记录的更新(手机等别处改过)→ 就地更新;
      //    否则(与本设备自己 push 记下的时间戳相等,即回声)跳过,避免 push↔pull 自我更新死循环。
      if (knownIds.has(s.id)) {
        if (s.updated_at > (updated[s.id] ?? 0)) {
          const name = idToName[s.id]; // 本地当前名(服务端可能已改名,与 s.name 不同)
          const existing = name ? local.find((c) => c.name === name) : undefined;
          const cfg = toSSHConnectionConfig(s, existing);
          // 按本地当前名定位并移除旧条目,再以重建后的 cfg(cfg.name 已是服务端新名)加入。
          if (name) local = local.filter((c) => c.name !== name);
          // 服务端改了名:清掉旧名的 id 映射,新名沿用同一稳定 id。
          if (name && name !== s.name) {
            delete map[name];
            delete idToName[name];
          }
          local.push(cfg);
          map[s.name] = s.id;
          idToName[s.id] = s.name;
          saveIdMap(map);
          updated[s.id] = s.updated_at;
          saveUpdatedMap(updated);
          changed = true;
        }
        continue;
      }
      // ③ 活跃且陌生(别的设备新建)。
      // 名称冲突:本地已有同名连接(必属另一个 id)——不覆盖,仅告警跳过。
      if (local.some((c) => c.name === s.name)) {
        console.warn(`[connection-sync] pull: name collision for "${s.name}", skipping foreign id ${s.id}`);
        continue;
      }
      const cfg = toSSHConnectionConfig(s);
      local.push(cfg);
      map[s.name] = s.id;
      knownIds.add(s.id);
      saveIdMap(map);
      // 记下导入时的时间戳:下次 pull 见到同一时间戳视作已处理跳过,只有更大才再 in-place 更新。
      updated[s.id] = s.updated_at;
      saveUpdatedMap(updated);
      changed = true;
    }

    if (changed) {
      // 直接落盘(不走镜像路径,避免 push↔pull 死循环)。这里的下拉配置从未
      // 包含 vault secret，saveConnections 因而不会覆盖任何本地 Keychain 项。
      await saveConnections(local);
      // 触发首页连接列表刷新(与 ssh.ts 保存路径用的同一个自定义事件)。
      document.dispatchEvent(new CustomEvent('ssh-connections-changed'));
    }
  } catch (e) {
    console.warn('[connection-sync] pullConnections failed:', e);
  }
}
