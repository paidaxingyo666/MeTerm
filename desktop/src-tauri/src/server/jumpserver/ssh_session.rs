//! Fixed JumpServer Koko SSH/SFTP broker.
//!
//! The WebView supplies only non-secret JumpServer, asset, and account
//! metadata. Rust creates the short-lived Koko connection credential and
//! consumes it immediately while opening SSH/SFTP; neither token nor password
//! has a serializable response path. Successful sessions retain only a
//! metadata-only target binding for fixed SFTP refreshes.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use axum::extract::{Extension, Path};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;

use super::credential_broker::{self, JumpServerCredentialBinding};
use super::{
    get_or_create_client, valid_display_text, valid_resource_id, ConnectionToken,
    ConnectionTokenRequest,
};
use crate::server::auth::AuthPrincipal;
use crate::server::terminal::ssh::{SshAuthMethod, SshConfig, SshTerminal};
use crate::server::ServerState;

const JUMPSERVER_OPERATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);
const JUMPSERVER_LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JumpServerTarget {
    asset_id: String,
    account: String,
    #[serde(default)]
    account_name: String,
    #[serde(default)]
    account_alias: String,
    #[serde(default)]
    account_id: String,
    #[serde(default)]
    protocol: String,
}

impl JumpServerTarget {
    fn validate(&self) -> Result<(), String> {
        if !valid_resource_id(&self.asset_id)
            || !valid_display_text(&self.account, 512)
            || !valid_display_text(&self.account_name, 512)
            || !valid_display_text(&self.account_alias, 512)
            || (!self.account_id.is_empty() && !valid_resource_id(&self.account_id))
            || (!self.protocol.is_empty() && self.protocol != "ssh")
            || [
                &self.account,
                &self.account_name,
                &self.account_alias,
                &self.account_id,
            ]
            .iter()
            .all(|value| value.is_empty())
        {
            return Err("invalid JumpServer connection request".to_string());
        }
        Ok(())
    }

    fn token_request(&self, base_url: String) -> ConnectionTokenRequest {
        ConnectionTokenRequest {
            base_url,
            asset_id: self.asset_id.clone(),
            account: self.account.clone(),
            account_name: self.account_name.clone(),
            account_alias: self.account_alias.clone(),
            account_id: self.account_id.clone(),
            protocol: self.protocol.clone(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateJumpServerSshSessionRequest {
    binding: JumpServerCredentialBinding,
    #[serde(flatten)]
    target: JumpServerTarget,
    #[serde(default)]
    trusted_fingerprint: Option<String>,
}

#[derive(Clone)]
struct JumpServerSessionContext {
    binding: JumpServerCredentialBinding,
    target: JumpServerTarget,
}

/// Metadata-only registry for fixed refresh operations. Dead entries are
/// pruned whenever a new JumpServer session is bound.
pub(crate) struct JumpServerSessionRegistry {
    entries: Mutex<HashMap<String, JumpServerSessionContext>>,
}

impl JumpServerSessionRegistry {
    pub(crate) fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn bind(
        &self,
        session_id: String,
        context: JumpServerSessionContext,
        active_sessions: &HashSet<String>,
    ) {
        let mut entries = self.entries.lock().unwrap();
        entries.retain(|id, _| active_sessions.contains(id));
        entries.insert(session_id, context);
    }

    fn get(&self, session_id: &str) -> Option<JumpServerSessionContext> {
        self.entries.lock().unwrap().get(session_id).cloned()
    }
}

fn owner_required(principal: &AuthPrincipal) -> Result<(), String> {
    if matches!(principal, AuthPrincipal::Owner { .. }) {
        Ok(())
    } else {
        Err("desktop owner required".to_string())
    }
}

fn valid_transient_credential(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes && !value.contains('\0')
}

fn valid_jms_username(value: &str) -> bool {
    value.starts_with("JMS-")
        && value.len() <= 1_024
        && value
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && !byte.is_ascii_whitespace())
}

fn valid_fingerprint(value: Option<&str>) -> bool {
    value.is_none_or(|fingerprint| {
        !fingerprint.is_empty()
            && fingerprint.len() <= 512
            && !fingerprint.chars().any(char::is_control)
    })
}

fn context_from_request(
    request: &CreateJumpServerSshSessionRequest,
) -> Result<JumpServerSessionContext, String> {
    request.target.validate()?;
    if !valid_fingerprint(request.trusted_fingerprint.as_deref()) {
        return Err("invalid JumpServer SSH request".to_string());
    }
    Ok(JumpServerSessionContext {
        binding: credential_broker::normalize_binding(request.binding.clone())?,
        target: request.target.clone(),
    })
}

async fn issue_connection_credential(
    context: &JumpServerSessionContext,
    principal: &AuthPrincipal,
) -> Result<ConnectionToken, String> {
    let client = get_or_create_client(&context.binding.base_url, principal)?;
    let client = tokio::time::timeout(JUMPSERVER_LOCK_TIMEOUT, client.lock())
        .await
        .map_err(|_| "JumpServer client is busy".to_string())?;
    tokio::time::timeout(
        JUMPSERVER_OPERATION_TIMEOUT,
        client.create_connection_token(
            &context
                .target
                .token_request(context.binding.base_url.clone()),
        ),
    )
    .await
    .map_err(|_| "JumpServer connection request timed out".to_string())?
}

fn build_ssh_config(
    context: &JumpServerSessionContext,
    credential: ConnectionToken,
    proxy_password: String,
    trusted_fingerprint: Option<String>,
) -> Result<SshConfig, String> {
    let jms_token = if credential.id.is_empty() {
        credential.token.clone()
    } else {
        credential.id
    };
    let username = format!("JMS-{jms_token}");
    let password = if credential.secret.is_empty() {
        credential.token
    } else {
        credential.secret
    };
    if !valid_jms_username(&username)
        || !valid_transient_credential(&password, 64 * 1024)
        || !valid_fingerprint(trusted_fingerprint.as_deref())
    {
        return Err("invalid JumpServer connection credential".to_string());
    }

    Ok(SshConfig {
        host: context.binding.ssh_host.clone(),
        port: context.binding.ssh_port,
        username,
        auth_method: SshAuthMethod::Password,
        password,
        private_key: String::new(),
        passphrase: String::new(),
        trusted_fingerprint: trusted_fingerprint.unwrap_or_default(),
        disable_hook: true,
        multiplex_sftp: true,
        proxy_type: context.binding.proxy_type.clone(),
        proxy_host: context.binding.proxy_host.clone(),
        proxy_port: context.binding.proxy_port,
        proxy_username: context.binding.proxy_username.clone(),
        proxy_password,
    })
}

fn operation_error(error: String) -> (StatusCode, Json<serde_json::Value>) {
    let status = if error.starts_with("SESSION_EXPIRED:") {
        StatusCode::UNAUTHORIZED
    } else {
        StatusCode::BAD_GATEWAY
    };
    (status, Json(serde_json::json!({ "error": error })))
}

fn binding_matches_config(binding: &JumpServerCredentialBinding, config: &SshConfig) -> bool {
    config.host == binding.ssh_host
        && config.port == binding.ssh_port
        && config.proxy_type == binding.proxy_type
        && config.proxy_host == binding.proxy_host
        && config.proxy_port == binding.proxy_port
        && config.proxy_username == binding.proxy_username
        && config.disable_hook
        && config.multiplex_sftp
}

/// Create a Koko connection token and consume it directly in Rust while
/// opening the SSH session. The response contains only normal session status.
pub async fn create_jumpserver_ssh_session(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Json(request): Json<CreateJumpServerSshSessionRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(error) = owner_required(&principal) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": error })),
        );
    }
    let context = match context_from_request(&request) {
        Ok(context) => context,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": error })),
            )
        }
    };
    let proxy_password =
        match credential_broker::materialize_proxy_password(context.binding.clone()) {
            Ok(password) => password.unwrap_or_default(),
            Err(error) => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({ "error": error })),
                )
            }
        };
    let credential = match issue_connection_credential(&context, &principal).await {
        Ok(credential) => credential,
        Err(error) => return operation_error(error),
    };
    let config = match build_ssh_config(
        &context,
        credential,
        proxy_password,
        request.trusted_fingerprint,
    ) {
        Ok(config) => config,
        Err(error) => return operation_error(error),
    };

    let response =
        super::super::handlers::connect_and_start_ssh_session(state.clone(), principal, config)
            .await;
    if response.0 == StatusCode::CREATED {
        if let Some(session_id) = response.1 .0.get("id").and_then(|value| value.as_str()) {
            if let Some(session) = state.session_manager.get(session_id) {
                *session.executor_type.lock().unwrap() = "jumpserver".to_string();
                if let Some(config) = session.ssh_config.lock().unwrap().as_mut() {
                    // The authenticated channel owns the credential now. Do
                    // not retain the short-lived Koko password in session
                    // metadata after connect returns.
                    config.password.clear();
                }
            }
            let active_sessions = state
                .session_manager
                .list()
                .into_iter()
                .map(|session| session.id.clone())
                .collect();
            state
                .jumpserver_sessions
                .bind(session_id.to_string(), context, &active_sessions);
        }
    }
    response
}

/// Mint and consume a fresh Koko credential for the exact target already
/// bound to this session. The WebView cannot supply replacement credentials or
/// redirect the refresh to another asset/account/authority.
pub async fn refresh_jumpserver_sftp_session(
    Path(session_id): Path<String>,
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(error) = owner_required(&principal) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": error })),
        );
    }
    let Some(session) = state.session_manager.get(&session_id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        );
    };
    let Some(context) = state.jumpserver_sessions.get(&session_id) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "not a JumpServer session" })),
        );
    };
    let existing = match session.ssh_config.lock().unwrap().clone() {
        Some(config) if binding_matches_config(&context.binding, &config) => config,
        _ => {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": "JumpServer session binding mismatch" })),
            )
        }
    };
    let proxy_password =
        match credential_broker::materialize_proxy_password(context.binding.clone()) {
            Ok(password) => password.unwrap_or_default(),
            Err(error) => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(serde_json::json!({ "error": error })),
                )
            }
        };
    let credential = match issue_connection_credential(&context, &principal).await {
        Ok(credential) => credential,
        Err(error) => return operation_error(error),
    };
    let config = match build_ssh_config(
        &context,
        credential,
        proxy_password,
        (!existing.trusted_fingerprint.is_empty()).then_some(existing.trusted_fingerprint.clone()),
    ) {
        Ok(config) => config,
        Err(error) => return operation_error(error),
    };

    match SshTerminal::connect_sftp(&config).await {
        Ok(sftp) => {
            *session.sftp.lock().unwrap() = Some(sftp);
            (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
        }
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "ok": false, "error": "JumpServer SFTP refresh failed" })),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> JumpServerTarget {
        JumpServerTarget {
            asset_id: "asset-1".to_string(),
            account: "root".to_string(),
            account_name: String::new(),
            account_alias: String::new(),
            account_id: String::new(),
            protocol: "ssh".to_string(),
        }
    }

    #[test]
    fn only_fixed_jms_usernames_are_accepted() {
        assert!(valid_jms_username("JMS-01234567-89ab-cdef"));
        assert!(!valid_jms_username("root"));
        assert!(!valid_jms_username("JMS-token with space"));
    }

    #[test]
    fn target_requires_asset_and_account_identity() {
        assert!(target().validate().is_ok());
        let mut invalid = target();
        invalid.account.clear();
        assert!(invalid.validate().is_err());
    }
}
