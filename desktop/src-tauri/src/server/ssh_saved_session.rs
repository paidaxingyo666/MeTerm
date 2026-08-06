//! `POST /api/sessions/ssh/saved` —— 按已存连接 id 中转建 SSH 会话。
//!
//! 设计稿 §4:查 `ConnectionRegistry`(S1)元数据 + 服务端钥匙串
//! `secret_vault`(S2)密钥,组出 `SshConfig` 后复用 `handlers::create_ssh_session`
//! 同一套"连接 + 起会话 + 后台 SFTP"流程(`connect_and_start_ssh_session`),
//! 响应形状保持一致(201/409 host-key challenge/稳定失败码)。
//! `POST /api/sessions/ssh/saved/test` 走同一条 id→vault materialize 路径，
//! 只返回测试结果或 host-key challenge，绝不返回组装后的 `SshConfig`/密钥。
//!
//! 单独成文件是为了不把 `handlers.rs` 顶到项目 1000 行上限之上
//! (`CLAUDE.md` 代码规模规范),而不是这段逻辑本身有多独立。

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::extract::Extension;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;

use super::auth::AuthPrincipal;
use super::ServerState;

#[derive(Debug)]
enum MaterializeSavedConfigError {
    CredentialUnavailable,
    Timeout,
    Vault(String),
}

const SAVED_CREDENTIAL_LOAD_TIMEOUT: Duration = Duration::from_secs(10);
static SAVED_CREDENTIAL_MATERIALIZE_GATE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();

/// 请求体引用已存连接 id。`trusted_fingerprint` 只供本机 owner UI 确认；
/// 设备使用的是桌面 vault 凭据，不能替桌面作出信任决定。
#[derive(Deserialize)]
pub struct CreateSshSessionFromSavedRequest {
    id: String,
    #[serde(default)]
    trusted_fingerprint: Option<String>,
}

/// 从已存连接的元数据(`ConnectionRegistry`)+ 钥匙串密钥(`secret_vault`)
/// 组出 `SshConfig`。纯函数、不发起网络连接,便于单测覆盖字段映射逻辑。
fn build_ssh_config_from_saved(
    conn: super::connections::SavedConnection,
    secrets: super::secret_vault::SshSecrets,
    trusted_fingerprint: Option<String>,
) -> super::terminal::ssh::SshConfig {
    let auth_method = super::terminal::ssh::SshAuthMethod::from_str_lossy(&conn.auth_method);

    // Empty key material selects ssh-agent/default identities only when the
    // desktop owner explicitly stored that capability. A missing legacy PEM
    // must fail closed instead of silently changing the authentication identity.
    let private_key = if auth_method == super::terminal::ssh::SshAuthMethod::Key {
        if conn.uses_desktop_key_ladder {
            String::new()
        } else if conn.has_key_path {
            secrets.private_key_path.unwrap_or_default()
        } else {
            secrets.private_key_pem.unwrap_or_default()
        }
    } else {
        String::new()
    };

    super::terminal::ssh::SshConfig {
        host: conn.host,
        port: conn.port,
        username: conn.username,
        auth_method,
        password: secrets.password.unwrap_or_default(),
        private_key,
        passphrase: secrets.passphrase.unwrap_or_default(),
        trusted_fingerprint: trusted_fingerprint.unwrap_or_default(),
        disable_hook: conn.skip_shell_hook.unwrap_or(false),
        multiplex_sftp: conn.multiplex_sftp.unwrap_or(false),
        proxy_type: conn.proxy_type.unwrap_or_default(),
        proxy_host: conn.proxy_host.unwrap_or_default(),
        proxy_port: conn.proxy_port.unwrap_or(0),
        proxy_username: conn.proxy_username.unwrap_or_default(),
        // 代理密码随钥匙串 secrets 一起同步;手机端目前不下发该字段时,
        // 缺省为 None,还原成空字符串与既有行为一致。
        proxy_password: secrets.proxy_password.unwrap_or_default(),
    }
}

/// Validate only the credential shape that is inherent to the saved binding.
/// A saved desktop key path/agent operation is intentionally allowed here: the
/// paired device supplies only an immutable connection id and cannot choose a
/// path or redirect the SSH authority. Raw `/api/sessions/ssh` requests still
/// pass through `validate_direct_ssh_config` and may use only inline PEM.
fn validate_saved_credentials(
    conn: &super::connections::SavedConnection,
    secrets: &super::secret_vault::SshSecrets,
) -> Result<(), MaterializeSavedConfigError> {
    let present = |value: Option<&str>| value.is_some_and(|value| !value.trim().is_empty());
    let has_password = present(secrets.password.as_deref());
    let has_pem = present(secrets.private_key_pem.as_deref());
    let has_path = present(secrets.private_key_path.as_deref());
    let has_passphrase = present(secrets.passphrase.as_deref());

    let valid = match conn.auth_method.as_str() {
        "password" => {
            !conn.has_key_path
                && !conn.uses_desktop_key_ladder
                && has_password
                && !has_pem
                && !has_path
                && !has_passphrase
        }
        "key" if conn.has_key_path => {
            !conn.uses_desktop_key_ladder && has_path && !has_password && !has_pem
        }
        "key" if conn.uses_desktop_key_ladder => {
            !has_password && !has_pem && !has_path && !has_passphrase
        }
        "key" => has_pem && !has_password && !has_path,
        _ => false,
    };
    valid
        .then_some(())
        .ok_or(MaterializeSavedConfigError::CredentialUnavailable)
}

/// 在 Rust 进程内把注册表元数据与 vault 密钥组合成一次性配置。
/// 返回值只能继续交给固定 SSH 操作；不得序列化或跨 IPC 返回。
fn materialize_saved_ssh_config(
    state: &ServerState,
    id: &str,
    trusted_fingerprint: Option<String>,
) -> Result<Option<super::terminal::ssh::SshConfig>, MaterializeSavedConfigError> {
    state.connections.read_with(id, |connection| {
        let Some(conn) = connection.filter(|conn| conn.deleted_at.is_none()) else {
            return Ok(None);
        };
        let secrets = super::secret_vault::try_load_secrets(id)
            .map_err(MaterializeSavedConfigError::Vault)?;
        super::secret_vault::validate_bound_authority(&conn, &secrets)
            .map_err(|_| MaterializeSavedConfigError::CredentialUnavailable)?;
        validate_saved_credentials(&conn, &secrets)?;
        Ok(Some(build_ssh_config_from_saved(
            conn,
            secrets,
            trusted_fingerprint,
        )))
    })
}

/// Keychain APIs are synchronous and may wait for desktop unlock/authorization.
/// Bound the wait below the mobile request timeout and keep the semaphore permit
/// inside the blocking closure: a timed-out, still-blocked Keychain call cannot
/// cause retries to fill Tokio's blocking pool or continue into SSH/session setup.
async fn run_bounded_blocking_materializer<T, F>(
    gate: Arc<tokio::sync::Semaphore>,
    timeout: Duration,
    loader: F,
) -> Result<T, MaterializeSavedConfigError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, MaterializeSavedConfigError> + Send + 'static,
{
    let operation = async move {
        let permit = gate.acquire_owned().await.map_err(|_| {
            MaterializeSavedConfigError::Vault("credential loader unavailable".into())
        })?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            loader()
        })
        .await
        .map_err(|_| MaterializeSavedConfigError::Vault("credential loader interrupted".into()))?
    };

    match tokio::time::timeout(timeout, operation).await {
        Ok(result) => result,
        Err(_) => Err(MaterializeSavedConfigError::Timeout),
    }
}

async fn materialize_saved_ssh_config_bounded(
    state: Arc<ServerState>,
    id: String,
    trusted_fingerprint: Option<String>,
) -> Result<Option<super::terminal::ssh::SshConfig>, MaterializeSavedConfigError> {
    let gate = SAVED_CREDENTIAL_MATERIALIZE_GATE
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)))
        .clone();
    run_bounded_blocking_materializer(gate, SAVED_CREDENTIAL_LOAD_TIMEOUT, move || {
        materialize_saved_ssh_config(&state, &id, trusted_fingerprint)
    })
    .await
}

/// 中转建会话:查 `ConnectionRegistry` 元数据 + 服务端钥匙串密钥,组
/// `SshConfig` 后复用与 `create_ssh_session` 相同的连接/起会话流程 ——
/// 响应形状一致(201/409 host-key challenge/稳定失败码)。
pub async fn create_ssh_session_from_saved(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Json(body): Json<CreateSshSessionFromSavedRequest>,
) -> impl IntoResponse {
    if let Err(error) =
        validate_saved_host_confirmation(&principal, body.trusted_fingerprint.as_deref())
    {
        eprintln!("[ssh-saved] rejected host-key confirmation: {}", error);
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "host_key_confirmation_forbidden" })),
        );
    }
    let config = match materialize_saved_ssh_config_bounded(
        state.clone(),
        body.id.clone(),
        body.trusted_fingerprint,
    )
    .await
    {
        Ok(Some(config)) => config,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "connection_not_found" })),
            )
        }
        Err(MaterializeSavedConfigError::CredentialUnavailable) => {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({ "error": "credential_unavailable" })),
            );
        }
        Err(MaterializeSavedConfigError::Timeout) => {
            return (
                StatusCode::GATEWAY_TIMEOUT,
                Json(serde_json::json!({ "error": "credential_load_timeout" })),
            );
        }
        Err(MaterializeSavedConfigError::Vault(error)) => {
            eprintln!(
                "[ssh-saved] load secrets failed for {:?}: {}",
                body.id, error
            );
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "credential_load_failed" })),
            );
        }
    };

    super::handlers::connect_and_start_ssh_session(state, principal, config).await
}

/// Test a saved connection without exposing its credential bundle to WebView.
/// The response intentionally mirrors `/api/sessions/ssh/test`: `{ok}` for a
/// normal result, or the existing host-key challenge object for TOFU handling.
pub async fn test_ssh_session_from_saved(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Json(body): Json<CreateSshSessionFromSavedRequest>,
) -> impl IntoResponse {
    if let Err(error) =
        validate_saved_host_confirmation(&principal, body.trusted_fingerprint.as_deref())
    {
        eprintln!("[ssh-saved] rejected host-key test confirmation: {}", error);
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "ok": false,
                "error": "host_key_confirmation_forbidden"
            })),
        );
    }
    let config = match materialize_saved_ssh_config_bounded(
        state.clone(),
        body.id.clone(),
        body.trusted_fingerprint,
    )
    .await
    {
        Ok(Some(config)) => config,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({
                    "ok": false,
                    "error": "connection_not_found"
                })),
            )
        }
        Err(MaterializeSavedConfigError::CredentialUnavailable) => {
            return (
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({
                    "ok": false,
                    "error": "credential_unavailable"
                })),
            );
        }
        Err(MaterializeSavedConfigError::Timeout) => {
            return (
                StatusCode::GATEWAY_TIMEOUT,
                Json(serde_json::json!({
                    "ok": false,
                    "error": "credential_load_timeout"
                })),
            );
        }
        Err(MaterializeSavedConfigError::Vault(error)) => {
            eprintln!(
                "[ssh-saved] load secrets failed for {:?}: {}",
                body.id, error
            );
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "ok": false,
                    "error": "credential_load_failed"
                })),
            );
        }
    };

    match super::terminal::ssh::test_connection(&config).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))),
        Err(error) => {
            if let Some(challenge) = super::handlers::sanitized_host_key_challenge(&error) {
                return (StatusCode::OK, Json(challenge));
            }
            eprintln!("[ssh-saved] connection test failed: {}", error);
            let (status, code) = super::handlers::classify_ssh_connect_error(&error);
            (
                status,
                Json(serde_json::json!({ "ok": false, "error": code })),
            )
        }
    }
}

fn validate_saved_host_confirmation(
    principal: &AuthPrincipal,
    trusted_fingerprint: Option<&str>,
) -> Result<(), &'static str> {
    if matches!(principal, AuthPrincipal::Device { .. })
        && trusted_fingerprint.is_some_and(|fingerprint| !fingerprint.is_empty())
    {
        return Err("host_key_confirmation_forbidden");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::connections::SavedConnection;
    use crate::server::secret_vault::SshSecrets;
    use crate::server::terminal::ssh::SshAuthMethod;

    fn make_conn(auth_method: &str, has_key_path: bool) -> SavedConnection {
        SavedConnection {
            id: "c1".to_string(),
            name: "test-conn".to_string(),
            host: "example.com".to_string(),
            port: 2222,
            username: "root".to_string(),
            auth_method: auth_method.to_string(),
            has_key_path,
            uses_desktop_key_ladder: false,
            updated_at: 0,
            deleted_at: None,
            proxy_type: Some("socks5".to_string()),
            proxy_host: Some("127.0.0.1".to_string()),
            proxy_port: Some(1080),
            proxy_username: Some("proxyuser".to_string()),
            skip_shell_hook: Some(true),
            multiplex_sftp: Some(true),
        }
    }

    #[test]
    fn test_password_auth_uses_vault_password_and_leaves_key_empty() {
        let conn = make_conn("password", false);
        let mut secrets = SshSecrets::default();
        secrets.password = Some("hunter2".to_string());
        let config = build_ssh_config_from_saved(conn, secrets, None);
        assert_eq!(config.auth_method, SshAuthMethod::Password);
        assert_eq!(config.password, "hunter2");
        assert!(config.private_key.is_empty());
    }

    #[test]
    fn test_key_auth_uses_vault_pem_when_present() {
        let conn = make_conn("key", false);
        let mut secrets = SshSecrets::default();
        secrets.private_key_pem = Some("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n".to_string());
        secrets.passphrase = Some("pp".to_string());
        let config = build_ssh_config_from_saved(conn, secrets, None);
        assert_eq!(config.auth_method, SshAuthMethod::Key);
        assert!(config.private_key.starts_with("-----BEGIN"));
        assert_eq!(config.passphrase, "pp");
    }

    /// Owner-created key mode without explicit material is the deliberate
    /// ssh-agent/default-identity ladder. It is distinct from a `has_key_path`
    /// binding whose path has gone missing.
    #[test]
    fn test_key_auth_without_explicit_material_uses_auto_ladder() {
        let mut conn = make_conn("key", false);
        conn.uses_desktop_key_ladder = true;
        let secrets = SshSecrets::default();
        assert!(validate_saved_credentials(&conn, &secrets).is_ok());
        let config = build_ssh_config_from_saved(conn, secrets, None);
        assert_eq!(config.auth_method, SshAuthMethod::Key);
        assert!(config.private_key.is_empty());
    }

    #[test]
    fn device_cannot_confirm_saved_host_key_but_saved_broker_may_use_bound_path() {
        let device = AuthPrincipal::Device {
            device_id: "phone".into(),
            device_name: "Phone".into(),
            generation: uuid::Uuid::new_v4(),
        };
        let owner = AuthPrincipal::Owner {
            generation: uuid::Uuid::new_v4(),
        };
        assert!(validate_saved_host_confirmation(&device, None).is_ok());
        assert_eq!(
            validate_saved_host_confirmation(&device, Some("SHA256:abc")),
            Err("host_key_confirmation_forbidden")
        );
        assert!(validate_saved_host_confirmation(&owner, Some("SHA256:abc")).is_ok());

        let conn = make_conn("key", true);
        let mut secrets = SshSecrets::default();
        secrets.private_key_path = Some("/Users/alice/.ssh/id_ed25519".into());
        assert!(validate_saved_credentials(&conn, &secrets).is_ok());
        let config = build_ssh_config_from_saved(conn, secrets, None);
        // The raw device route must still reject a caller-supplied desktop path.
        assert!(super::super::handlers::validate_direct_ssh_config(&device, &config).is_err());
        assert!(super::super::handlers::validate_direct_ssh_config(&owner, &config).is_ok());
    }

    #[test]
    fn missing_saved_password_or_bound_key_path_fails_before_network_io() {
        assert!(matches!(
            validate_saved_credentials(&make_conn("password", false), &SshSecrets::default()),
            Err(MaterializeSavedConfigError::CredentialUnavailable)
        ));
        assert!(matches!(
            validate_saved_credentials(&make_conn("key", true), &SshSecrets::default()),
            Err(MaterializeSavedConfigError::CredentialUnavailable)
        ));
        assert!(matches!(
            validate_saved_credentials(&make_conn("key", false), &SshSecrets::default()),
            Err(MaterializeSavedConfigError::CredentialUnavailable)
        ));
    }

    #[test]
    fn test_carries_proxy_fields_and_trusted_fingerprint_override() {
        let conn = make_conn("password", false);
        let secrets = SshSecrets::default();
        let config = build_ssh_config_from_saved(conn, secrets, Some("SHA256:abc123".to_string()));
        assert_eq!(config.proxy_type, "socks5");
        assert_eq!(config.proxy_host, "127.0.0.1");
        assert_eq!(config.proxy_port, 1080);
        assert_eq!(config.proxy_username, "proxyuser");
        assert!(config.disable_hook);
        assert!(config.multiplex_sftp);
        assert_eq!(config.trusted_fingerprint, "SHA256:abc123");
        // 未存代理密码(如手机端未下发)时,组出的 config 里应为空。
        assert!(config.proxy_password.is_empty());
    }

    /// 钥匙串里存了代理密码时,应原样流入 `SshConfig.proxy_password`,
    /// 使中转场景下经认证代理(SOCKS5/HTTP)也能完成代理握手。
    #[test]
    fn test_proxy_password_flows_from_secrets_into_config() {
        let conn = make_conn("password", false);
        let mut secrets = SshSecrets::default();
        secrets.password = Some("hunter2".to_string());
        secrets.proxy_password = Some("proxysecret".to_string());
        let config = build_ssh_config_from_saved(conn, secrets, None);
        assert_eq!(config.proxy_password, "proxysecret");
    }

    #[tokio::test]
    async fn timed_out_keychain_loader_keeps_gate_and_cannot_continue_to_ssh() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let gate = Arc::new(tokio::sync::Semaphore::new(1));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let first =
            run_bounded_blocking_materializer(gate.clone(), Duration::from_millis(30), move || {
                let _ = started_tx.send(());
                let _ = release_rx.recv();
                Ok::<_, MaterializeSavedConfigError>(7usize)
            })
            .await;

        assert!(matches!(first, Err(MaterializeSavedConfigError::Timeout)));
        assert!(started_rx.await.is_ok());
        assert_eq!(gate.available_permits(), 0);

        let second_started = Arc::new(AtomicBool::new(false));
        let second_started_in_loader = second_started.clone();
        let second =
            run_bounded_blocking_materializer(gate.clone(), Duration::from_millis(30), move || {
                second_started_in_loader.store(true, Ordering::SeqCst);
                Ok::<_, MaterializeSavedConfigError>(9usize)
            })
            .await;
        assert!(matches!(second, Err(MaterializeSavedConfigError::Timeout)));
        assert!(!second_started.load(Ordering::SeqCst));

        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), async {
            while gate.available_permits() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}
