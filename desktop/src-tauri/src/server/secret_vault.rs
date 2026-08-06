//! SSH 连接密钥的钥匙串秘钥库 —— 设计稿 §2/§4/§7。
//!
//! 密钥(密码/私钥 PEM/私钥口令)不进 `ConnectionRegistry` 的 JSON 元数据,
//! 单独存服务端 OS 钥匙串。Debug 使用 `com.meterm.dev.ssh.v2`，Release 使用
//! `com.meterm.app.ssh.v3`；account 用 `sync:{connection_id}` 前缀区分，避免和
//! 其它 `com.meterm.*` 用途的钥匙串条目撞名。没有通用 WebView 取密命令；
//! 密钥只能由本模块及固定 SSH broker 在 Rust 内部装载和使用。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Mutex, OnceLock};
use zeroize::{Zeroize, Zeroizing};

use super::connections::DurableSideEffect;

#[path = "secret_vault_named_merge.rs"]
mod named_merge;
use named_merge::{
    merge_named_secrets, merge_secret_bundle, merge_secret_field, LegacyNamedSecrets,
};
#[path = "secret_vault_transaction.rs"]
mod transaction;
pub(crate) use transaction::SecretMutation;
use transaction::{CredentialCleanup, CredentialSnapshot};
#[path = "secret_vault_keychain.rs"]
mod keychain;
use keychain::{
    create_verified as kc_create_verified, delete as kc_delete, load as kc_load,
    store_verified as kc_store_verified,
};

/// 一条连接的密钥材料,整体 JSON 序列化后作为钥匙串 password 存入。
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct SshSecrets {
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub private_key_pem: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    /// 中转代理(SOCKS5/HTTP)认证密码,与 `password`/`passphrase` 一样整体随
    /// `SshSecrets` JSON 存入钥匙串,供手机端经 `/api/sessions/ssh/saved`
    /// 中转起会话时还原代理认证。
    #[serde(default)]
    pub proxy_password: Option<String>,
    /// Desktop-local private-key file selected for this saved connection.
    /// It is authority-bound vault metadata, never returned to paired devices.
    #[serde(default)]
    pub private_key_path: Option<String>,
    /// Exact non-secret SSH authority this bundle was committed for. This is
    /// overwritten inside Rust on every durable write; WebView/device input
    /// can never choose it.
    #[serde(
        default,
        rename = "_authority_binding_v1",
        skip_serializing_if = "Option::is_none"
    )]
    authority_binding: Option<String>,
}

impl std::fmt::Debug for SshSecrets {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SshSecrets(redacted)")
    }
}

impl SshSecrets {
    fn zeroize_sensitive(&mut self) {
        for value in [
            &mut self.password,
            &mut self.private_key_pem,
            &mut self.passphrase,
            &mut self.proxy_password,
            &mut self.private_key_path,
        ] {
            if let Some(value) = value.as_mut() {
                value.zeroize();
            }
        }
    }
}

/// Every channel uses a distinct service. Production v3 intentionally replaces
/// v2 as well: a development build was temporarily granted persistent access
/// to some v2 items during pre-release testing, so an in-place password update
/// would not restore their original access control list.
const DEVELOPMENT_SERVICE: &str = "com.meterm.dev.ssh.v2";
const PRODUCTION_SERVICE_V3: &str = "com.meterm.app.ssh.v3";
const PRODUCTION_SERVICE_V2: &str = "com.meterm.app.ssh.v2";
#[cfg(debug_assertions)]
const SERVICE: &str = DEVELOPMENT_SERVICE;
#[cfg(not(debug_assertions))]
const SERVICE: &str = PRODUCTION_SERVICE_V3;
/// Read only by the explicit, owner-confirmed, per-connection development
/// import operation. Normal debug runtime lookups never fall back to a
/// production vault. Development may only recover from the already
/// quarantined v2 namespace; it must never gain access to the clean v3 ACL.
#[cfg(all(
    debug_assertions,
    feature = "development-credential-recovery",
    target_os = "macos"
))]
const PRODUCTION_IMPORT_SERVICES: &[&str] = &[PRODUCTION_SERVICE_V2];
#[cfg(debug_assertions)]
const LEGACY_INSECURE_SERVICES: &[&str] = &[];
#[cfg(not(debug_assertions))]
const LEGACY_INSECURE_SERVICES: &[&str] = &[PRODUCTION_SERVICE_V2, "com.meterm.app.ssh"];
const MAX_CONNECTION_ID_BYTES: usize = 256;
const MAX_SECRET_JSON_BYTES: usize = 2 * 1024 * 1024;
const MAX_LEGACY_NAME_BYTES: usize = 256;

static NAMED_MIGRATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// 钥匙串 account:用 `sync:` 前缀标记"来自同步连接集",与其它用途区分。
fn account_for(id: &str) -> Result<String, String> {
    if id.is_empty() || id.len() > MAX_CONNECTION_ID_BYTES || id.chars().any(char::is_control) {
        return Err("invalid SSH connection id".to_string());
    }
    Ok(format!("sync:{}", id))
}

fn decode_secrets(json: &str) -> Result<SshSecrets, String> {
    if json.len() > MAX_SECRET_JSON_BYTES {
        return Err("SSH secret bundle is too large".to_string());
    }
    serde_json::from_str(json).map_err(|e| format!("invalid SSH secret bundle: {}", e))
}

/// 存入/覆盖某连接的密钥。
fn persist_secrets(id: &str, secrets: &SshSecrets, create_only: bool) -> Result<(), String> {
    let account = account_for(id)?;
    let mut normalized = secrets.clone();
    normalized.private_key_path = normalize_private_key_path(secrets.private_key_path.as_deref())?;
    let result = match serde_json::to_string(&normalized) {
        Ok(json) => {
            let json = Zeroizing::new(json);
            if json.len() > MAX_SECRET_JSON_BYTES {
                Err("SSH secret bundle is too large".to_string())
            } else {
                if create_only {
                    kc_create_verified(SERVICE, &account, &json)
                } else {
                    kc_store_verified(SERVICE, &account, &json)
                }
            }
        }
        Err(error) => Err(format!("serialize error: {}", error)),
    };
    normalized.zeroize_sensitive();
    result
}

fn authority_binding(connection: &super::connections::SavedConnection) -> Result<String, String> {
    let canonical = serde_json::to_vec(&serde_json::json!({
        "version": 1,
        "host": connection.host,
        "port": connection.port,
        "username": connection.username,
        "auth_method": connection.auth_method,
        "has_key_path": connection.has_key_path,
        "uses_desktop_key_ladder": connection.uses_desktop_key_ladder,
        "proxy_type": connection.proxy_type,
        "proxy_host": connection.proxy_host,
        "proxy_port": connection.proxy_port,
        "proxy_username": connection.proxy_username,
    }))
    .map_err(|_| "failed to bind SSH credential authority".to_string())?;
    let digest = Sha256::digest(canonical);
    let digest_hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("v1:{digest_hex}"))
}

/// Persist a bundle only after binding it to the exact saved SSH authority.
/// Callers may supply credential fields, but never the binding digest itself.
pub fn store_bound_secrets(
    id: &str,
    connection: &super::connections::SavedConnection,
    secrets: &SshSecrets,
) -> Result<(), String> {
    let mutation = begin_store_bound_secrets(id, connection, Some(connection), secrets)?;
    mutation.commit()
}

fn store_new_bound_secrets(
    id: &str,
    connection: &super::connections::SavedConnection,
    secrets: &SshSecrets,
) -> Result<(), String> {
    let mutation = begin_store_bound_secrets(id, connection, None, secrets)?;
    mutation.commit()
}

fn store_bound_secrets_inner(
    id: &str,
    connection: &super::connections::SavedConnection,
    secrets: &SshSecrets,
    create_only: bool,
) -> Result<(), String> {
    if id != connection.id {
        return Err("SSH credential id does not match its authority".to_string());
    }
    let mut bound = secrets.clone();
    bound.authority_binding = Some(authority_binding(connection)?);
    let result = persist_secrets(id, &bound, create_only);
    bound.zeroize_sensitive();
    result
}

/// Write one authority-bound bundle and retain its exact previous Keychain
/// value until the caller durably commits the matching registry metadata.
pub(crate) fn begin_store_bound_secrets(
    id: &str,
    connection: &super::connections::SavedConnection,
    previous_authority: Option<&super::connections::SavedConnection>,
    secrets: &SshSecrets,
) -> Result<SecretMutation, String> {
    let account = account_for(id)?;
    let mutation = SecretMutation::capture([(SERVICE.to_string(), account)])?;
    let mut current = mutation
        .rollback_entries
        .first()
        .and_then(|entry| entry.value.as_ref())
        .map(|raw| decode_secrets(raw))
        .transpose()?;
    let destination = validate_store_destination(previous_authority, current.as_ref());
    if let Some(current) = current.as_mut() {
        current.zeroize_sensitive();
    }
    let create_only = destination?;
    if let Err(error) = store_bound_secrets_inner(id, connection, secrets, create_only) {
        if create_only {
            // Add-only failure may mean another process won the account race.
            // Never delete that item as though this call had created it.
            return Err(error);
        }
        return match mutation.rollback() {
            Ok(()) => Err(error),
            Err(_) => Err("failed to store and restore SSH credential transaction".to_string()),
        };
    }
    Ok(mutation)
}

/// Return true only when the destination must be created atomically. Existing
/// current-service items may be updated solely for an active registry owner
/// whose exact prior authority binding is already present.
fn validate_store_destination(
    previous_authority: Option<&super::connections::SavedConnection>,
    current: Option<&SshSecrets>,
) -> Result<bool, String> {
    let Some(current) = current else {
        return Ok(true);
    };
    let previous = previous_authority
        .filter(|connection| connection.deleted_at.is_none())
        .ok_or_else(|| {
            "SSH credential target already exists without an active owner".to_string()
        })?;
    match current.authority_binding.as_deref() {
        Some(binding) if binding == authority_binding(previous)? => Ok(false),
        _ => Err("existing SSH credential target is not bound to its active owner".to_string()),
    }
}

/// Reject credential material that is unbound or durably bound to a different
/// SSH authority. Desktop key-ladder grants always require a persistent marker;
/// deleting that marker revokes use even though the bundle has no key bytes.
pub fn validate_bound_authority(
    connection: &super::connections::SavedConnection,
    secrets: &SshSecrets,
) -> Result<(), String> {
    match secrets.authority_binding.as_deref() {
        Some(stored) if stored == authority_binding(connection)? => Ok(()),
        Some(_) => Err("SSH credential authority binding mismatch".to_string()),
        None if connection.uses_desktop_key_ladder => {
            Err("SSH desktop key-ladder authority marker is missing".to_string())
        }
        None if has_material(secrets) => Err(
            "unbound SSH credential requires explicit owner confirmation or re-entry".to_string(),
        ),
        None => Ok(()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NamedTargetBinding {
    Matching,
    Unbound,
}

/// ID-keyed target accounts are never ordinary legacy name sources. A bound
/// target must already match exactly; an unbound target consumes explicit
/// owner presence even when it represents a credential-less key-ladder choice.
fn classify_named_target_binding(
    connection: &super::connections::SavedConnection,
    secrets: &SshSecrets,
) -> Result<NamedTargetBinding, String> {
    match secrets.authority_binding.as_deref() {
        Some(stored) if stored == authority_binding(connection)? => {
            Ok(NamedTargetBinding::Matching)
        }
        Some(_) => Err("SSH credential authority binding mismatch".to_string()),
        None => Ok(NamedTargetBinding::Unbound),
    }
}

fn validate_existing_bound_bundle(
    connection: &super::connections::SavedConnection,
    secrets: &SshSecrets,
) -> Result<(), String> {
    if secrets.authority_binding.is_none() {
        return Err(
            "unbound SSH credential requires explicit owner confirmation or re-entry".to_string(),
        );
    }
    validate_bound_authority(connection, secrets)
}

fn validate_matching_legacy_duplicate(
    connection: &super::connections::SavedConnection,
    current: &SshSecrets,
    legacy: &SshSecrets,
) -> Result<(), String> {
    validate_existing_bound_bundle(connection, current)?;
    validate_existing_bound_bundle(connection, legacy)?;
    let current_path = Zeroizing::new(normalize_private_key_path(
        current.private_key_path.as_deref(),
    )?);
    let legacy_path = Zeroizing::new(normalize_private_key_path(
        legacy.private_key_path.as_deref(),
    )?);
    let matches = current.password.as_deref() == legacy.password.as_deref()
        && current.private_key_pem.as_deref() == legacy.private_key_pem.as_deref()
        && current.passphrase.as_deref() == legacy.passphrase.as_deref()
        && current.proxy_password.as_deref() == legacy.proxy_password.as_deref()
        && current_path.as_deref() == legacy_path.as_deref()
        && current.authority_binding.as_deref() == legacy.authority_binding.as_deref();
    if matches {
        Ok(())
    } else {
        Err("conflicting legacy SSH credential duplicate".to_string())
    }
}

fn cleanup_legacy_duplicates(
    connection: &super::connections::SavedConnection,
    account: &str,
    current: &SshSecrets,
    already_deleted_service: Option<&str>,
) -> Result<(), String> {
    for legacy_service in LEGACY_INSECURE_SERVICES {
        if already_deleted_service == Some(*legacy_service) {
            continue;
        }
        let Some(json) = kc_load(legacy_service, account)? else {
            continue;
        };
        let json = Zeroizing::new(json);
        let mut legacy = decode_secrets(&json)?;
        let result = validate_matching_legacy_duplicate(connection, current, &legacy)
            .and_then(|()| kc_delete(legacy_service, account));
        legacy.zeroize_sensitive();
        result?;
    }
    Ok(())
}

fn require_current_service_bundle(bundle: Option<String>) -> Result<String, String> {
    bundle.ok_or_else(|| {
        "current SSH credential requires owner-confirmed recovery or re-entry".to_string()
    })
}

/// Validate the current registry-owned bundle and remove only byte-identical,
/// bound legacy duplicates. A missing current v3 fails before any legacy
/// password data is queried; public authority hashes cannot authenticate data
/// writable through an ACL previously granted to a development build.
pub fn ensure_bound_secrets(
    connection: &super::connections::SavedConnection,
) -> Result<(), String> {
    let account = account_for(&connection.id)?;
    let json = Zeroizing::new(require_current_service_bundle(kc_load(SERVICE, &account)?)?);
    let mut secrets = decode_secrets(&json)?;
    let result = validate_existing_bound_bundle(connection, &secrets)
        .and_then(|()| cleanup_legacy_duplicates(connection, &account, &secrets, None));
    secrets.zeroize_sensitive();
    result
}

/// Read one credential bundle from the current build channel only. Legacy
/// namespaces are never consulted from a generic id-only lookup because the
/// content cannot be validated against an SSH authority there.
pub fn try_load_secrets(id: &str) -> Result<SshSecrets, String> {
    let account = account_for(id)?;
    if let Some(json) = kc_load(SERVICE, &account)? {
        let json = Zeroizing::new(json);
        return decode_secrets(&json);
    }
    Ok(SshSecrets::default())
}

fn project_secrets_for_authority(
    connection: &super::connections::SavedConnection,
    source: &SshSecrets,
) -> Result<SshSecrets, String> {
    let present = |value: Option<&str>| value.is_some_and(|value| !value.trim().is_empty());
    if connection.auth_method == "password"
        && (connection.has_key_path || connection.uses_desktop_key_ladder)
    {
        return Err("invalid SSH credential source flags".to_string());
    }
    if connection.auth_method == "key"
        && connection.has_key_path
        && connection.uses_desktop_key_ladder
    {
        return Err("invalid SSH credential source flags".to_string());
    }

    let mut projected = SshSecrets::default();
    match connection.auth_method.as_str() {
        "password" => {
            projected.password = source.password.clone();
            if !present(projected.password.as_deref()) {
                return Err("production SSH password is unavailable".to_string());
            }
        }
        "key" if connection.has_key_path => {
            projected.private_key_path =
                normalize_private_key_path(source.private_key_path.as_deref())?;
            projected.passphrase = source.passphrase.clone();
            if !present(projected.private_key_path.as_deref()) {
                return Err("production SSH key path is unavailable".to_string());
            }
        }
        "key" if connection.uses_desktop_key_ladder => {}
        "key" => {
            projected.private_key_pem = source.private_key_pem.clone();
            projected.passphrase = source.passphrase.clone();
            if !present(projected.private_key_pem.as_deref()) {
                return Err("production SSH private key is unavailable".to_string());
            }
        }
        _ => return Err("invalid SSH authentication method".to_string()),
    }
    if connection
        .proxy_type
        .as_deref()
        .is_some_and(|value| matches!(value, "socks5" | "http"))
        && present(connection.proxy_username.as_deref())
    {
        projected.proxy_password = source.proxy_password.clone();
    }
    Ok(projected)
}

/// Check only the isolated development vault so an already completed import
/// does not trigger any production-Keychain prompt on a later launch.
#[cfg(all(
    debug_assertions,
    feature = "development-credential-recovery",
    target_os = "macos"
))]
pub(crate) fn development_secret_missing(id: &str) -> Result<bool, String> {
    let account = account_for(id)?;
    Ok(kc_load(SERVICE, &account)?.is_none())
}

/// Copy one production credential only after the owner approved the exact
/// saved authority list. The production item is read once and never modified;
/// plaintext is projected, authority-bound, written to the isolated Dev vault,
/// and zeroized without crossing another async/user-interaction boundary.
#[cfg(all(
    debug_assertions,
    feature = "development-credential-recovery",
    target_os = "macos"
))]
pub(crate) fn import_production_secret_after_confirmation(
    connection: &super::connections::SavedConnection,
) -> Result<bool, String> {
    let account = account_for(&connection.id)?;
    if kc_load(SERVICE, &account)?.is_some() {
        return Ok(false);
    }
    if connection.has_key_path {
        return Err("development recovery cannot import a desktop private-key path".to_string());
    }
    if connection.uses_desktop_key_ladder {
        return store_new_bound_secrets(&connection.id, connection, &SshSecrets::default())
            .map(|()| true);
    }
    let mut source_json = None;
    for service in PRODUCTION_IMPORT_SERVICES {
        if let Some(candidate) = kc_load(service, &account)? {
            source_json = Some(candidate);
            break;
        }
    }
    let Some(source_json) = source_json else {
        return Ok(false);
    };
    let source_json = Zeroizing::new(source_json);
    let mut source = decode_secrets(&source_json)?;
    if let Some(binding) = source.authority_binding.as_deref() {
        if binding != authority_binding(connection)? {
            source.zeroize_sensitive();
            return Err(
                "production SSH credential authority does not match development metadata"
                    .to_string(),
            );
        }
    }
    let mut projected = match project_secrets_for_authority(connection, &source) {
        Ok(projected) => projected,
        Err(error) => {
            source.zeroize_sensitive();
            return Err(error);
        }
    };
    let result = if has_material(&projected) || connection.uses_desktop_key_ladder {
        store_new_bound_secrets(&connection.id, connection, &projected).map(|()| true)
    } else {
        Ok(false)
    };
    projected.zeroize_sensitive();
    source.zeroize_sensitive();
    result
}

/// 删除某连接的密钥。未知 id / 本来就没有条目都是 no-op。
pub fn delete_secrets(id: &str) -> Result<(), String> {
    let mutation = begin_delete_secrets(id)?;
    mutation.commit()
}

/// Prepare exact, digest-bound cleanup without deleting anything. The caller
/// first persists the tombstone, then `commit` removes each still-matching item.
pub(crate) fn begin_delete_secrets(id: &str) -> Result<SecretMutation, String> {
    let account = account_for(id)?;
    let items = std::iter::once(SERVICE)
        .chain(LEGACY_INSECURE_SERVICES.iter().copied())
        .map(|service| (service.to_string(), account.clone()))
        .collect::<Vec<_>>();
    Ok(SecretMutation {
        rollback_entries: Vec::new(),
        cleanup_entries: SecretMutation::cleanup_items(items)?,
        named_guard: None,
    })
}

fn validate_legacy_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > MAX_LEGACY_NAME_BYTES
        || name.chars().any(char::is_control)
        || name == "sync"
        || name.starts_with("sync:")
    {
        Err("invalid legacy SSH connection name".to_string())
    } else {
        Ok(())
    }
}

pub(crate) fn normalize_private_key_path(path: Option<&str>) -> Result<Option<String>, String> {
    let Some(path) = path.filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    if path.len() > 4_096 || path.chars().any(char::is_control) || path.contains('\0') {
        return Err("invalid private-key path".to_string());
    }
    if let Some(relative) = path.strip_prefix("~/") {
        let home = dirs::home_dir().ok_or_else(|| "home directory is unavailable".to_string())?;
        return Ok(Some(home.join(relative).to_string_lossy().to_string()));
    }
    let path = std::path::Path::new(path);
    if !path.is_absolute() {
        return Err("private-key path must be absolute".to_string());
    }
    Ok(Some(path.to_string_lossy().to_string()))
}

fn has_material(secrets: &SshSecrets) -> bool {
    secrets
        .password
        .as_deref()
        .is_some_and(|value| !value.is_empty())
        || secrets
            .private_key_pem
            .as_deref()
            .is_some_and(|value| !value.is_empty())
        || secrets
            .passphrase
            .as_deref()
            .is_some_and(|value| !value.is_empty())
        || secrets
            .proxy_password
            .as_deref()
            .is_some_and(|value| !value.is_empty())
        || secrets
            .private_key_path
            .as_deref()
            .is_some_and(|value| !value.is_empty())
}

pub(crate) fn credential_bundle_matches(
    connection: &super::connections::SavedConnection,
    secrets: &SshSecrets,
) -> bool {
    let present = |value: Option<&str>| value.is_some_and(|value| !value.trim().is_empty());
    let has_password = present(secrets.password.as_deref());
    let has_pem = present(secrets.private_key_pem.as_deref());
    let has_path = present(secrets.private_key_path.as_deref());
    let has_passphrase = present(secrets.passphrase.as_deref());
    match connection.auth_method.as_str() {
        "password" => has_password && !has_pem && !has_path && !has_passphrase,
        "key" if connection.has_key_path => {
            has_path && !has_password && !has_pem && !connection.uses_desktop_key_ladder
        }
        "key" if connection.uses_desktop_key_ladder => {
            !has_password && !has_pem && !has_path && !has_passphrase
        }
        "key" => has_pem && !has_password && !has_path,
        _ => false,
    }
}

#[derive(Debug)]
struct NamedMigrationEntry {
    service: &'static str,
    account: String,
    digest: Option<[u8; 32]>,
}

/// Opaque, digest-only snapshot used to consume one identity confirmation.
/// It intentionally contains no credential bytes and cannot be serialized.
#[derive(Debug)]
pub struct NamedSecretMigrationSnapshot {
    id: String,
    connection: super::connections::SavedConnection,
    private_key_path: Option<String>,
    target_account: String,
    unified_account: String,
    password_account: String,
    passphrase_account: String,
    entries: Vec<NamedMigrationEntry>,
    requires_confirmation: bool,
    target_must_be_absent: bool,
}

impl NamedSecretMigrationSnapshot {
    pub fn requires_confirmation(&self) -> bool {
        self.requires_confirmation
    }

    pub fn private_key_path(&self) -> Option<&str> {
        self.private_key_path.as_deref()
    }
}

fn raw_digest(value: Option<&str>) -> Option<[u8; 32]> {
    value.map(|value| Sha256::digest(value.as_bytes()).into())
}

/// Snapshot every source and destination account before a legacy name-keyed
/// credential is rebound. A current-service target without an active registry
/// owner is rejected as an orphan/squatting candidate; legacy-service sources
/// may be rebound only after owner confirmation. The snapshot is revalidated.
pub fn prepare_named_secret_migration(
    connection: &super::connections::SavedConnection,
    name: &str,
    private_key_path: Option<&str>,
    include_orphan_target: bool,
) -> Result<NamedSecretMigrationSnapshot, String> {
    let id = connection.id.as_str();
    if [":secrets", ":password", ":passphrase"]
        .iter()
        .any(|suffix| id.ends_with(suffix))
    {
        return Err("SSH connection id aliases a legacy credential account".to_string());
    }
    validate_legacy_name(name)?;
    let target_account = account_for(id)?;
    let unified_account = format!("{}:secrets", name);
    let password_account = format!("{}:password", name);
    let passphrase_account = format!("{}:passphrase", name);
    if [&unified_account, &password_account, &passphrase_account].contains(&&target_account) {
        return Err("legacy SSH credential account collision".to_string());
    }
    let mut private_key_path = normalize_private_key_path(private_key_path)?;
    let _guard = NAMED_MIGRATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "SSH credential migration lock is unavailable".to_string())?;

    let mut entries = Vec::new();
    let mut named_source_present = false;
    let mut orphan_target_present = false;
    let mut unbound_target_present = false;
    let mut current_target_present = false;
    for service in std::iter::once(SERVICE).chain(LEGACY_INSECURE_SERVICES.iter().copied()) {
        for account in [
            &target_account,
            &unified_account,
            &password_account,
            &passphrase_account,
        ] {
            let raw = kc_load(service, account)?.map(Zeroizing::new);
            if raw.is_some() {
                if account == &target_account {
                    current_target_present |= service == SERVICE;
                    orphan_target_present |= include_orphan_target;
                    let mut source = decode_secrets(
                        raw.as_ref()
                            .map(|value| value.as_str())
                            .expect("checked above"),
                    )?;
                    let validation = match classify_named_target_binding(connection, &source) {
                        Ok(NamedTargetBinding::Matching)
                            if service == SERVICE && include_orphan_target =>
                        {
                            Err("orphaned current SSH credential target requires recovery"
                                .to_string())
                        }
                        Ok(NamedTargetBinding::Unbound) if service == SERVICE => {
                            Err("unbound current SSH credential target requires recovery"
                                .to_string())
                        }
                        Ok(NamedTargetBinding::Unbound) => {
                            unbound_target_present = true;
                            Ok(())
                        }
                        Ok(NamedTargetBinding::Matching) => Ok(()),
                        Err(error) => Err(error),
                    };
                    let source_path =
                        normalize_private_key_path(source.private_key_path.as_deref());
                    source.zeroize_sensitive();
                    validation?;
                    let source_path = Zeroizing::new(source_path?);
                    merge_secret_field(&mut private_key_path, source_path.as_deref())?;
                } else {
                    named_source_present = true;
                }
            }
            entries.push(NamedMigrationEntry {
                service,
                account: account.clone(),
                digest: raw_digest(raw.as_ref().map(|value| value.as_str())),
            });
        }
    }

    let requires_confirmation = named_source_present
        || orphan_target_present
        || unbound_target_present
        || private_key_path.is_some()
        || (connection.uses_desktop_key_ladder && !current_target_present);
    Ok(NamedSecretMigrationSnapshot {
        id: id.to_string(),
        connection: connection.clone(),
        private_key_path,
        target_account,
        unified_account,
        password_account,
        passphrase_account,
        entries,
        requires_confirmation,
        target_must_be_absent: include_orphan_target,
    })
}

fn snapshotted_value<'a>(
    values: &'a [CredentialSnapshot],
    service: &str,
    account: &str,
) -> Option<&'a str> {
    values
        .iter()
        .find(|entry| entry.service == service && entry.account == account)
        .and_then(|entry| entry.value.as_ref().map(|value| value.as_str()))
}

/// Commit a prepared name-keyed migration without returning its plaintext.
/// All digests are checked under the migration lock, the target is written
/// before any source is deleted, and the supplied snapshot is single-use.
pub fn commit_named_secret_migration(
    snapshot: NamedSecretMigrationSnapshot,
    owner_confirmed: bool,
) -> Result<(), String> {
    let mutation = begin_commit_named_secret_migration(snapshot, owner_confirmed)?;
    mutation.commit()
}

pub(crate) fn begin_commit_named_secret_migration(
    snapshot: NamedSecretMigrationSnapshot,
    owner_confirmed: bool,
) -> Result<SecretMutation, String> {
    if snapshot.requires_confirmation && !owner_confirmed {
        return Err("SSH credential migration requires owner confirmation".to_string());
    }
    let named_guard = NAMED_MIGRATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "SSH credential migration lock is unavailable".to_string())?;

    let mut values = Vec::with_capacity(snapshot.entries.len());
    for entry in &snapshot.entries {
        let raw = kc_load(entry.service, &entry.account)?.map(Zeroizing::new);
        if raw_digest(raw.as_ref().map(|value| value.as_str())) != entry.digest {
            return Err("SSH credentials changed during identity confirmation".to_string());
        }
        values.push(CredentialSnapshot {
            service: entry.service.to_string(),
            account: entry.account.clone(),
            value: raw,
        });
    }

    let rollback_entries = values
        .iter()
        .filter(|entry| entry.service == SERVICE && entry.account == snapshot.target_account)
        .map(|entry| CredentialSnapshot {
            service: entry.service.clone(),
            account: entry.account.clone(),
            value: entry
                .value
                .as_ref()
                .map(|value| Zeroizing::new(value.to_string())),
        })
        .collect::<Vec<_>>();
    let cleanup_entries = values
        .iter()
        .filter(|entry| {
            entry.value.is_some()
                && ((entry.account == snapshot.target_account && entry.service != SERVICE)
                    || entry.account == snapshot.unified_account
                    || entry.account == snapshot.password_account
                    || entry.account == snapshot.passphrase_account)
        })
        .map(|entry| CredentialCleanup {
            service: entry.service.clone(),
            account: entry.account.clone(),
            digest: raw_digest(entry.value.as_ref().map(|value| value.as_str())),
        })
        .collect::<Vec<_>>();

    let mut target = SshSecrets::default();
    let mut mutated = false;
    let result = (|| {
        for service in std::iter::once(SERVICE).chain(LEGACY_INSECURE_SERVICES.iter().copied()) {
            if let Some(raw) = snapshotted_value(&values, service, &snapshot.target_account) {
                let mut source = decode_secrets(raw)?;
                let binding = classify_named_target_binding(&snapshot.connection, &source);
                match binding {
                    Ok(NamedTargetBinding::Matching)
                        if service == SERVICE && snapshot.target_must_be_absent =>
                    {
                        source.zeroize_sensitive();
                        return Err(
                            "orphaned current SSH credential target requires recovery".to_string()
                        );
                    }
                    Ok(NamedTargetBinding::Matching) => {}
                    Ok(NamedTargetBinding::Unbound) if service == SERVICE => {
                        source.zeroize_sensitive();
                        return Err(
                            "unbound current SSH credential target requires recovery".to_string()
                        );
                    }
                    Ok(NamedTargetBinding::Unbound) if owner_confirmed => {}
                    Ok(NamedTargetBinding::Unbound) => {
                        source.zeroize_sensitive();
                        return Err(
                            "unbound SSH credential requires owner confirmation".to_string()
                        );
                    }
                    Err(error) => {
                        source.zeroize_sensitive();
                        return Err(error);
                    }
                }
                match normalize_private_key_path(source.private_key_path.as_deref()) {
                    Ok(path) => source.private_key_path = path,
                    Err(error) => {
                        source.zeroize_sensitive();
                        return Err(error);
                    }
                }
                let merged = merge_secret_bundle(&mut target, &source);
                source.zeroize_sensitive();
                merged?;
            }
        }
        merge_secret_field(
            &mut target.private_key_path,
            snapshot.private_key_path.as_deref(),
        )?;

        for service in std::iter::once(SERVICE).chain(LEGACY_INSECURE_SERVICES.iter().copied()) {
            if let Some(json) = snapshotted_value(&values, service, &snapshot.unified_account) {
                let mut source: LegacyNamedSecrets = serde_json::from_str(json)
                    .map_err(|_| "invalid legacy SSH credential bundle".to_string())?;
                let merged = merge_named_secrets(&mut target, &source);
                source.zeroize_sensitive();
                merged?;
            }
            merge_secret_field(
                &mut target.password,
                snapshotted_value(&values, service, &snapshot.password_account),
            )?;
            merge_secret_field(
                &mut target.passphrase,
                snapshotted_value(&values, service, &snapshot.passphrase_account),
            )?;
        }

        if !credential_bundle_matches(&snapshot.connection, &target) {
            return Err("legacy SSH credential material does not match its authority".to_string());
        }
        let current_target_was_present =
            snapshotted_value(&values, SERVICE, &snapshot.target_account).is_some();
        mutated = current_target_was_present;
        store_bound_secrets_inner(
            &snapshot.id,
            &snapshot.connection,
            &target,
            !current_target_was_present,
        )?;
        Ok(())
    })();
    target.zeroize_sensitive();
    drop(values);
    match result {
        Ok(()) => Ok(SecretMutation {
            rollback_entries,
            cleanup_entries,
            named_guard: Some(named_guard),
        }),
        Err(error) if mutated => {
            let restored = SecretMutation::restore_entries(rollback_entries);
            drop(cleanup_entries);
            drop(named_guard);
            match restored {
                Ok(()) => Err(error),
                Err(_) => {
                    Err("failed to migrate and restore SSH credential transaction".to_string())
                }
            }
        }
        Err(error) => Err(error),
    }
}

/// Explicit-maintenance helper for every account derivable from the persisted
/// registry. Normal server startup must never call it. Active records validate
/// the current service and tombstones scrub known services; unknown accounts
/// are deliberately not enumerated or deleted.
#[cfg(target_os = "macos")]
#[allow(dead_code)]
pub fn migrate_known_secrets(
    connections: &[super::connections::SavedConnection],
) -> Result<(), String> {
    for connection in connections {
        let result = if connection.deleted_at.is_some() {
            delete_secrets(&connection.id)
        } else {
            ensure_bound_secrets(connection)
        };
        if result.is_err() {
            // Do not include account ids or Keychain backend detail in the
            // startup error. The caller must not start remote sync while a
            // known insecure duplicate may still be readable.
            return Err("failed to migrate known SSH Keychain entries".to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "secret_vault_cleanup_tests.rs"]
mod cleanup_tests;

#[cfg(test)]
#[path = "secret_vault_tests.rs"]
mod tests;
