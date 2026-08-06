//! SSH 连接同步 —— 桌面前端(`ssh.ts`)进程内桥接命令。
//!
//! 设计稿 §5:桌面前端把 `ConnectionRegistry`/`secret_vault` 当作服务端权威,
//! 但前端和服务端同在一个 Tauri 进程里,不必走 HTTP + token,直接用
//! `tauri::State<Arc<ServerState>>` 读写即可。命令只允许拉取元数据(含墓碑)、
//! 增改(元数据 + 可选密钥)、软删除(+ 清密钥)以及进程内迁移；任何命令都不能
//! 把 vault 中的 SSH 密钥返回给 WebView。

use std::sync::Arc;
use tauri::{State, WebviewWindow};

use crate::server::connections::{
    now_ms, ssh_authority_changed, ssh_credential_replacement_required, DeleteOutcome,
    SavedConnection, UpsertOutcome,
};
use crate::server::secret_vault::{self, SshSecrets};
use crate::server::ServerState;

#[cfg(all(
    debug_assertions,
    feature = "development-credential-recovery",
    target_os = "macos"
))]
static DEVELOPMENT_CREDENTIAL_IMPORT_LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> =
    std::sync::OnceLock::new();

const WEBVIEW_KEYCHAIN_MIGRATION_ENABLED: bool = !cfg!(target_os = "macos");

/// 拉取全量连接(含软删除墓碑),供前端与 localStorage 做增量对账。
#[tauri::command]
pub async fn sync_get_connections(
    window: WebviewWindow,
    state: State<'_, Arc<ServerState>>,
) -> Result<Vec<SavedConnection>, String> {
    require_ssh_window(&window)?;
    Ok(state.connections.all())
}

/// 新建/更新一条连接;`secrets` 非空时一并写入钥匙串。
///
/// `updated_at` 由调用方(前端)负责设置以支持 last-write-wins;
/// 若调用方未设置(传 0),这里补盖当前时间戳。
#[tauri::command]
pub async fn sync_upsert_connection(
    window: WebviewWindow,
    state: State<'_, Arc<ServerState>>,
    connection: SavedConnection,
    mut secrets: Option<SshSecrets>,
) -> Result<(), String> {
    require_ssh_window(&window)?;
    let mut conn = connection;
    if conn.updated_at == 0 {
        conn.updated_at = now_ms();
    }
    validate_credential_source_flags(&conn)?;
    if let Some(bundle) = secrets.as_mut() {
        bundle.private_key_path =
            secret_vault::normalize_private_key_path(bundle.private_key_path.as_deref())?;
        validate_incoming_secret_shape(&conn, bundle)?;
    }
    let id = conn.id.clone();
    let validation_copy = conn.clone();

    let expected_existing = state.connections.read_with(&id, |existing| existing);
    let authority_changes =
        ssh_credential_replacement_required(expected_existing.as_ref(), &validation_copy);
    let confirmation_reason = if let Some(private_key_path) = secrets
        .as_ref()
        .and_then(|bundle| bundle.private_key_path.as_deref())
    {
        Some(key_path_binding_reason(&validation_copy, private_key_path)?)
    } else if validation_copy.uses_desktop_key_ladder && authority_changes {
        Some(desktop_key_ladder_binding_reason(&validation_copy)?)
    } else {
        None
    };

    if let Some(reason) = confirmation_reason {
        super::user_presence::confirm_for_credential_binding(&window, reason).await?;
    }

    let outcome = state
        .connections
        .upsert_checked_transaction(conn, |existing| {
            if existing != expected_existing.as_ref() {
                return Err("SSH connection changed during identity confirmation".to_string());
            }
            commit_connection_secret_update(&id, &validation_copy, existing, secrets.as_ref())
        })?;
    match outcome {
        UpsertOutcome::Applied => Ok(()),
        UpsertOutcome::Stale => Err("stale SSH connection update".to_string()),
    }
}

/// One-time migration of the former name-keyed WebView credential into the
/// id-bound Rust vault. No credential bytes are returned through IPC.
#[tauri::command]
pub async fn sync_import_named_connection(
    window: WebviewWindow,
    state: State<'_, Arc<ServerState>>,
    connection: SavedConnection,
    private_key_path: Option<String>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("legacy SSH credential migration is main-window only".to_string());
    }
    let mut conn = connection;
    if conn.updated_at == 0 {
        conn.updated_at = now_ms();
    }
    validate_credential_source_flags(&conn)?;
    let id = conn.id.clone();
    let name = conn.name.clone();
    let validation_copy = conn.clone();
    let (expected_existing, snapshot) = state.connections.read_with(&id, |existing| {
        let active_existing = existing
            .as_ref()
            .filter(|current| current.deleted_at.is_none());
        if active_existing.is_some_and(|current| ssh_authority_changed(current, &validation_copy)) {
            return Err("legacy credential migration cannot change SSH authority".to_string());
        }
        let snapshot = secret_vault::prepare_named_secret_migration(
            &validation_copy,
            &name,
            private_key_path.as_deref(),
            active_existing.is_none(),
        )?;
        Ok((existing, snapshot))
    })?;
    let owner_confirmed = snapshot.requires_confirmation();
    if owner_confirmed {
        let reason = if let Some(path) = snapshot.private_key_path() {
            key_path_binding_reason(&validation_copy, path)?
        } else if validation_copy.uses_desktop_key_ladder {
            desktop_key_ladder_binding_reason(&validation_copy)?
        } else {
            legacy_binding_reason(&validation_copy)?
        };
        super::user_presence::confirm_for_credential_binding(&window, reason).await?;
    }
    let outcome = state
        .connections
        .upsert_checked_transaction(conn, |existing| {
            if existing != expected_existing.as_ref() {
                return Err("SSH connection changed during identity confirmation".to_string());
            }
            secret_vault::begin_commit_named_secret_migration(snapshot, owner_confirmed)
        })?;
    match outcome {
        UpsertOutcome::Applied => Ok(()),
        UpsertOutcome::Stale => Err("stale SSH connection migration".to_string()),
    }
}

fn require_ssh_window(window: &WebviewWindow) -> Result<(), String> {
    let label = window.label();
    if label == "main" || label == "settings" || label.starts_with("window-") {
        Ok(())
    } else {
        Err("SSH credential operation is unavailable to this window".to_string())
    }
}

fn validate_credential_source_flags(connection: &SavedConnection) -> Result<(), String> {
    match connection.auth_method.as_str() {
        "password" if !connection.has_key_path && !connection.uses_desktop_key_ladder => Ok(()),
        "key" if !(connection.has_key_path && connection.uses_desktop_key_ladder) => Ok(()),
        "password" | "key" => Err("invalid SSH credential source flags".to_string()),
        _ => Err("invalid SSH authentication method".to_string()),
    }
}

fn present(value: Option<&str>) -> bool {
    value.is_some_and(|value| !value.trim().is_empty())
}

fn validate_incoming_secret_shape(
    connection: &SavedConnection,
    secrets: &SshSecrets,
) -> Result<(), String> {
    let invalid = match connection.auth_method.as_str() {
        "password" => {
            present(secrets.private_key_pem.as_deref())
                || present(secrets.private_key_path.as_deref())
                || present(secrets.passphrase.as_deref())
        }
        "key" if connection.has_key_path => {
            present(secrets.password.as_deref()) || present(secrets.private_key_pem.as_deref())
        }
        "key" if connection.uses_desktop_key_ladder => {
            present(secrets.password.as_deref())
                || present(secrets.private_key_pem.as_deref())
                || present(secrets.private_key_path.as_deref())
                || present(secrets.passphrase.as_deref())
        }
        "key" => {
            present(secrets.password.as_deref()) || present(secrets.private_key_path.as_deref())
        }
        _ => true,
    };
    if invalid {
        Err("SSH credential material does not match its selected source".to_string())
    } else {
        Ok(())
    }
}

fn commit_connection_secret_update(
    id: &str,
    connection: &SavedConnection,
    existing: Option<&SavedConnection>,
    incoming: Option<&SshSecrets>,
) -> Result<Option<secret_vault::SecretMutation>, String> {
    let authority_changes = ssh_credential_replacement_required(existing, connection);
    if !authority_changes && incoming.is_none() {
        return Ok(None);
    }

    let mut target = if authority_changes {
        SshSecrets::default()
    } else {
        let current = secret_vault::try_load_secrets(id)?;
        if let Some(existing) = existing {
            secret_vault::validate_bound_authority(existing, &current)?;
        }
        current
    };

    if let Some(incoming) = incoming {
        if incoming.proxy_password.is_some() {
            target.proxy_password = incoming.proxy_password.clone();
        }
    }
    match connection.auth_method.as_str() {
        "password" => {
            target.private_key_pem = None;
            target.private_key_path = None;
            target.passphrase = None;
            if let Some(password) = incoming.and_then(|value| value.password.clone()) {
                target.password = Some(password);
            }
        }
        "key" if connection.has_key_path => {
            target.password = None;
            target.private_key_pem = None;
            if let Some(path) = incoming.and_then(|value| value.private_key_path.clone()) {
                target.private_key_path = Some(path);
            }
            if let Some(passphrase) = incoming.and_then(|value| value.passphrase.clone()) {
                target.passphrase = Some(passphrase);
            }
        }
        "key" if connection.uses_desktop_key_ladder => {
            target.password = None;
            target.private_key_pem = None;
            target.private_key_path = None;
            target.passphrase = None;
        }
        "key" => {
            target.password = None;
            target.private_key_path = None;
            if let Some(pem) = incoming.and_then(|value| value.private_key_pem.clone()) {
                target.private_key_pem = Some(pem);
            }
            if let Some(passphrase) = incoming.and_then(|value| value.passphrase.clone()) {
                target.passphrase = Some(passphrase);
            }
        }
        _ => return Err("invalid SSH authentication method".to_string()),
    }

    if !secret_vault::credential_bundle_matches(connection, &target) {
        return Err("SSH authority changes require matching credential material".to_string());
    }
    secret_vault::begin_store_bound_secrets(
        id,
        connection,
        existing.filter(|current| current.deleted_at.is_none()),
        &target,
    )
    .map(Some)
}

fn binding_target_summary(connection: &SavedConnection) -> Result<String, String> {
    fn validate(value: &str, max: usize, label: &str) -> Result<(), String> {
        if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
            Err(format!("invalid SSH {}", label))
        } else {
            Ok(())
        }
    }

    validate(&connection.name, 256, "connection name")?;
    validate(&connection.host, 512, "host")?;
    validate(&connection.username, 256, "username")?;
    if connection.port == 0 || !matches!(connection.auth_method.as_str(), "password" | "key") {
        return Err("invalid SSH authentication authority".to_string());
    }
    let host = if connection.host.contains(':') {
        format!(
            "[{}]",
            super::user_presence::safe_prompt_field(&connection.host)
        )
    } else {
        super::user_presence::safe_prompt_field(&connection.host)
    };
    let mut summary = format!(
        "{}@{}:{}",
        super::user_presence::safe_prompt_field(&connection.username),
        host,
        connection.port
    );
    let credential_source = match connection.auth_method.as_str() {
        "password" => "password",
        "key" if connection.has_key_path => "desktop-key-path",
        "key" if connection.uses_desktop_key_ladder => "desktop-agent-or-default-key",
        "key" => "stored-private-key",
        _ => return Err("invalid SSH authentication authority".to_string()),
    };
    summary.push_str(&format!("; auth={credential_source}"));
    if let Some(proxy_type) = connection
        .proxy_type
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        if !matches!(proxy_type, "socks5" | "http") {
            return Err("invalid SSH proxy type".to_string());
        }
        let proxy_host = connection
            .proxy_host
            .as_deref()
            .ok_or_else(|| "invalid SSH proxy host".to_string())?;
        validate(proxy_host, 512, "proxy host")?;
        let proxy_port = connection
            .proxy_port
            .filter(|port| *port != 0)
            .ok_or_else(|| "invalid SSH proxy port".to_string())?;
        summary.push_str(&format!(
            " through {}://{}:{}",
            proxy_type,
            super::user_presence::safe_prompt_field(proxy_host),
            proxy_port
        ));
        if let Some(proxy_username) = connection
            .proxy_username
            .as_deref()
            .filter(|value| !value.is_empty())
        {
            validate(proxy_username, 256, "proxy username")?;
            summary.push_str(&format!(
                " as {}",
                super::user_presence::safe_prompt_field(proxy_username)
            ));
        }
    }
    Ok(summary)
}

fn legacy_binding_reason(connection: &SavedConnection) -> Result<String, String> {
    let reason = format!(
        "Bind saved legacy SSH credential. Connection name: [{}]; SSH authority: [{}]",
        super::user_presence::safe_prompt_field(&connection.name),
        binding_target_summary(connection)?
    );
    if reason.len() > 4_096 {
        Err("SSH credential binding description is too long".to_string())
    } else {
        Ok(reason)
    }
}

fn key_path_binding_reason(
    connection: &SavedConnection,
    private_key_path: &str,
) -> Result<String, String> {
    let reason = format!(
        "Allow this SSH connection to use a desktop private-key file. Connection name: [{}]; SSH authority: [{}]; key path: [{}]",
        super::user_presence::safe_prompt_field(&connection.name),
        binding_target_summary(connection)?,
        super::user_presence::safe_prompt_field(private_key_path)
    );
    if reason.len() > 4_096 {
        Err("SSH key binding description is too long".to_string())
    } else {
        Ok(reason)
    }
}

fn desktop_key_ladder_binding_reason(connection: &SavedConnection) -> Result<String, String> {
    let reason = format!(
        "Allow phones using this saved connection to ask MeTerm to authenticate with the desktop ssh-agent or default private keys. Connection name: [{}]; SSH authority: [{}]",
        super::user_presence::safe_prompt_field(&connection.name),
        binding_target_summary(connection)?,
    );
    if reason.len() > 4_096 {
        Err("SSH key-ladder binding description is too long".to_string())
    } else {
        Ok(reason)
    }
}

#[cfg(any(
    test,
    all(
        debug_assertions,
        feature = "development-credential-recovery",
        target_os = "macos"
    )
))]
fn validate_development_recovery_connection(connection: &SavedConnection) -> Result<(), String> {
    if connection.has_key_path {
        Err(
            "development recovery cannot import a desktop private-key path; reselect the path locally"
                .to_string(),
        )
    } else {
        Ok(())
    }
}

#[cfg(any(
    test,
    all(
        debug_assertions,
        feature = "development-credential-recovery",
        target_os = "macos"
    )
))]
fn development_authority_reason<'a>(
    prefix: &str,
    entries: impl IntoIterator<Item = &'a SavedConnection>,
) -> Result<String, String> {
    let mut reason = String::from(prefix);
    let mut count = 0usize;
    for connection in entries {
        if count == 0 {
            reason.push(' ');
        } else {
            reason.push_str(" | ");
        }
        reason.push_str("Connection [");
        reason.push_str(&super::user_presence::safe_prompt_field(&connection.name));
        reason.push_str("] => [");
        reason.push_str(&binding_target_summary(connection)?);
        reason.push(']');
        count += 1;
    }

    if count == 0 {
        return Err("development SSH credential list is empty".to_string());
    }
    if reason.len() > 4_096 {
        return Err(
            "development SSH credential list is too long for informed confirmation".to_string(),
        );
    }
    super::user_presence::validate_reason(&reason)?;
    Ok(reason)
}

/// 软删除一条连接(打墓碑)并清掉钥匙串里对应的密钥。
#[tauri::command]
pub async fn sync_delete_connection(
    window: WebviewWindow,
    state: State<'_, Arc<ServerState>>,
    id: String,
) -> Result<(), String> {
    require_ssh_window(&window)?;
    let deleted_at = now_ms();
    let outcome = state
        .connections
        .delete_transaction(&id, deleted_at, || secret_vault::begin_delete_secrets(&id))?;
    match outcome {
        DeleteOutcome::Deleted | DeleteOutcome::Missing => Ok(()),
        DeleteOutcome::Stale => Err("stale SSH connection delete".to_string()),
    }
}

/// Replace only the password of an existing password-auth connection. The
/// current bundle is merged inside Rust and is never returned to the WebView.
#[tauri::command]
pub async fn sync_update_connection_password(
    window: WebviewWindow,
    state: State<'_, Arc<ServerState>>,
    id: String,
    password: String,
) -> Result<(), String> {
    require_ssh_window(&window)?;
    if password.is_empty() || password.len() > 65_536 {
        return Err("invalid SSH password".to_string());
    }
    state.connections.read_with(&id, |connection| {
        let connection = connection
            .filter(|entry| entry.deleted_at.is_none())
            .ok_or_else(|| "SSH connection not found".to_string())?;
        if connection.auth_method != "password" {
            return Err("SSH connection does not use password authentication".to_string());
        }
        let mut secrets = secret_vault::try_load_secrets(&id)?;
        secret_vault::validate_bound_authority(&connection, &secrets)?;
        secrets.password = Some(password);
        secret_vault::store_bound_secrets(&id, &connection, &secrets)
    })
}

/// Explicit native credential maintenance without returning secret material
/// through WebView IPC. macOS WebView startup is a no-op; this helper is not a
/// Release pre-server check and ordinary startup never invokes it.
#[tauri::command]
pub async fn sync_migrate_known_secrets(
    window: WebviewWindow,
    state: State<'_, Arc<ServerState>>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("SSH credential maintenance is restricted to the main window".to_string());
    }

    // macOS performs no automatic legacy migration. Debug keeps production
    // recovery as an explicit single-connection action; Release requires an
    // explicit signed maintenance/recovery path. Neither build may scan the
    // Keychain merely because the WebView finished loading.
    if !WEBVIEW_KEYCHAIN_MIGRATION_ENABLED {
        let _ = state;
        return Ok(());
    }

    {
        let mut failures = 0;
        for connection in state.connections.all() {
            let id = connection.id.clone();
            let result = state.connections.read_with(&id, |current| {
                if current
                    .as_ref()
                    .is_some_and(|entry| entry.deleted_at.is_some())
                {
                    secret_vault::delete_secrets(&id)
                } else {
                    current
                        .as_ref()
                        .ok_or_else(|| "SSH connection disappeared during migration".to_string())
                        .and_then(secret_vault::ensure_bound_secrets)
                }
            });
            if result.is_err() {
                failures += 1;
            }
        }
        if failures == 0 {
            Ok(())
        } else {
            Err(format!(
                "failed to migrate {} saved SSH credential entries",
                failures
            ))
        }
    }
}

/// Side-effect-free feature probe used only to decide whether the signed Dev
/// UI may render its explicit, per-connection recovery action.
#[tauri::command]
pub fn sync_development_credential_recovery_available(
    window: WebviewWindow,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Ok(false);
    }

    #[cfg(not(all(
        debug_assertions,
        feature = "development-credential-recovery",
        target_os = "macos"
    )))]
    {
        Ok(false)
    }

    #[cfg(all(
        debug_assertions,
        feature = "development-credential-recovery",
        target_os = "macos"
    ))]
    {
        crate::server::dev_relay_config::validate_development_app_identity()?;
        Ok(true)
    }
}

/// Development-only recovery path for one credential in the quarantined
/// production v2 vault. It runs only after an explicit local UI action. A
/// native owner-presence check authorizes the fixed same-id, one-way copy;
/// production v3 is never read and normal debug runtime never falls back to a
/// production vault.
#[tauri::command]
pub async fn sync_import_production_credential_for_development(
    window: WebviewWindow,
    state: State<'_, Arc<ServerState>>,
    id: String,
) -> Result<Option<bool>, String> {
    if window.label() != "main" {
        return Err("development SSH credential import is main-window only".to_string());
    }

    #[cfg(not(all(
        debug_assertions,
        feature = "development-credential-recovery",
        target_os = "macos"
    )))]
    {
        let _ = (state, id);
        return Ok(None);
    }

    #[cfg(all(
        debug_assertions,
        feature = "development-credential-recovery",
        target_os = "macos"
    ))]
    {
        let _import_guard = DEVELOPMENT_CREDENTIAL_IMPORT_LOCK
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .try_lock()
            .map_err(|_| "development SSH credential import already in progress".to_string())?;
        crate::server::dev_relay_config::validate_development_app_identity()?;
        let snapshot = state.connections.read_with(&id, |current| {
            current
                .filter(|connection| connection.deleted_at.is_none())
                .ok_or_else(|| "saved SSH connection is unavailable".to_string())
        })?;
        validate_development_recovery_connection(&snapshot)?;
        if !secret_vault::development_secret_missing(&snapshot.id)? {
            return Ok(Some(false));
        }

        // Ask before touching the quarantined production v2 service. The prompt also tells
        // the owner not to grant persistent ACL access to this Dev build.
        let prompt = if snapshot.uses_desktop_key_ladder {
            "Allow phones using this saved connection to ask signed MeTerm Dev to authenticate with the desktop ssh-agent or default private keys. No production credential bytes are needed. Production v3 is never accessed. The grant is bound only to this displayed authority:"
        } else {
            "Allow signed MeTerm Dev to copy this matching quarantined production v2 SSH credential into the isolated development vault for one-time same-id recovery. In any macOS Keychain dialog choose Allow, not Always Allow. Production entries remain unchanged and production v3 is never accessed. A matching legacy unbound credential will be bound only to this displayed authority:"
        };
        let inspection_reason = development_authority_reason(prompt, [&snapshot])?;
        super::user_presence::confirm_for_credential_binding(&window, inspection_reason).await?;

        let copied = state.connections.read_with(&id, |current| {
            if current.as_ref() != Some(&snapshot) {
                return Err(
                    "SSH connection changed during development credential import".to_string(),
                );
            }
            secret_vault::import_production_secret_after_confirmation(&snapshot)
        })?;
        Ok(Some(copied))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> SavedConnection {
        SavedConnection {
            id: "connection-id".to_string(),
            name: "production".to_string(),
            host: "2001:db8::1".to_string(),
            port: 22,
            username: "deploy".to_string(),
            auth_method: "key".to_string(),
            has_key_path: true,
            uses_desktop_key_ladder: false,
            updated_at: 1,
            deleted_at: None,
            proxy_type: Some("socks5".to_string()),
            proxy_host: Some("proxy.example".to_string()),
            proxy_port: Some(1080),
            proxy_username: Some("proxy-user".to_string()),
            skip_shell_hook: None,
            multiplex_sftp: None,
        }
    }

    #[test]
    fn owner_prompt_describes_target_and_proxy_authority() {
        let reason = key_path_binding_reason(&connection(), "/home/me/.ssh/id_ed25519").unwrap();
        assert!(reason.contains("deploy@[2001:db8::1]:22"));
        assert!(reason.contains("socks5://proxy.example:1080"));
        assert!(reason.contains("/home/me/.ssh/id_ed25519"));
    }

    #[test]
    fn owner_prompt_rejects_control_character_authority() {
        let mut invalid = connection();
        invalid.host = "safe.example\nattacker.example".to_string();
        assert!(legacy_binding_reason(&invalid).is_err());
    }

    #[test]
    fn key_ladder_prompt_discloses_phone_access_to_desktop_keys() {
        let mut ladder = connection();
        ladder.has_key_path = false;
        ladder.uses_desktop_key_ladder = true;
        let reason = desktop_key_ladder_binding_reason(&ladder).unwrap();
        assert!(reason.contains("phones using this saved connection"));
        assert!(reason.contains("desktop ssh-agent or default private keys"));
        assert!(reason.contains("deploy@[2001:db8::1]:22"));
    }

    #[test]
    fn development_recovery_prompts_are_single_line_valid_and_explicit() {
        let first = connection();

        let inspection = development_authority_reason(
            "Allow signed MeTerm Dev to copy this matching production SSH credential into the isolated development vault for one-time same-id recovery. In any macOS Keychain dialog choose Allow, not Always Allow. Production entries remain unchanged. A matching legacy unbound credential will be bound only to this displayed authority:",
            [&first],
        )
        .unwrap();

        assert!(inspection.contains("choose Allow, not Always Allow"));
        assert!(inspection.contains("legacy unbound credential"));
        assert!(!inspection.contains('\n'));
        assert!(crate::commands::user_presence::validate_reason(&inspection).is_ok());
        assert!(inspection.len() <= 4_096);
    }

    #[test]
    fn macos_webview_startup_never_scans_keychain() {
        assert_eq!(
            WEBVIEW_KEYCHAIN_MIGRATION_ENABLED,
            !cfg!(target_os = "macos")
        );
    }

    #[test]
    fn desktop_key_ladder_requires_explicit_exclusive_source_flag() {
        let mut ladder = connection();
        ladder.has_key_path = false;
        ladder.uses_desktop_key_ladder = true;
        assert!(validate_credential_source_flags(&ladder).is_ok());
        assert!(secret_vault::credential_bundle_matches(
            &ladder,
            &SshSecrets::default()
        ));

        ladder.has_key_path = true;
        assert!(validate_credential_source_flags(&ladder).is_err());

        ladder.auth_method = "password".to_string();
        ladder.has_key_path = false;
        assert!(validate_credential_source_flags(&ladder).is_err());
    }

    #[test]
    fn development_recovery_requires_local_reselection_for_private_key_paths() {
        let path = connection();
        assert!(validate_development_recovery_connection(&path).is_err());

        let mut inline = path.clone();
        inline.has_key_path = false;
        assert!(validate_development_recovery_connection(&inline).is_ok());
    }

    #[test]
    fn missing_inline_private_key_fails_closed() {
        let mut inline = connection();
        inline.has_key_path = false;
        inline.uses_desktop_key_ladder = false;
        assert!(!secret_vault::credential_bundle_matches(
            &inline,
            &SshSecrets::default()
        ));

        let mut secrets = SshSecrets::default();
        secrets.private_key_pem = Some("-----BEGIN PRIVATE KEY-----\ntest".to_string());
        assert!(secret_vault::credential_bundle_matches(&inline, &secrets));
    }

    #[test]
    fn tombstone_password_cannot_reuse_residual_vault_secret() {
        let mut tombstone = connection();
        tombstone.auth_method = "password".into();
        tombstone.has_key_path = false;
        tombstone.deleted_at = Some(5);
        let mut resurrected = tombstone.clone();
        resurrected.deleted_at = None;
        resurrected.updated_at = 6;

        assert!(commit_connection_secret_update(
            &resurrected.id,
            &resurrected,
            Some(&tombstone),
            None,
        )
        .is_err());
    }
}
