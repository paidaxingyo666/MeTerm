//! HTTP boundary for saved SSH connection metadata and credentials.
//!
//! Paired devices may use saved connections without receiving their secrets.
//! A metadata update that changes the destination/authentication authority must
//! replace the secret bundle in the same transaction; otherwise a stolen
//! device bearer could redirect an existing password or desktop key to an
//! attacker-controlled SSH endpoint.

use std::sync::Arc;

use axum::extract::{Extension, Path};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use super::auth::AuthPrincipal;
use super::connections::{
    ssh_credential_replacement_required, DeleteOutcome, SavedConnection, UpsertOutcome,
};
use super::device_auth::DeviceScope;
use super::secret_vault::SshSecrets;
use super::ServerState;

#[derive(Deserialize)]
pub struct SshConnectionUpsertBody {
    connection: SavedConnection,
    #[serde(default)]
    secrets: Option<SshSecrets>,
}

#[derive(Debug)]
enum UpsertError {
    Policy(&'static str),
    Storage(String),
}

impl From<String> for UpsertError {
    fn from(error: String) -> Self {
        Self::Storage(error)
    }
}

fn validate_http_upsert(
    existing: Option<&SavedConnection>,
    next: &SavedConnection,
    replacement_secrets: Option<&SshSecrets>,
) -> Result<(), &'static str> {
    match next.auth_method.as_str() {
        "password" if next.has_key_path || next.uses_desktop_key_ladder => {
            return Err("invalid SSH credential source flags");
        }
        "key" if next.has_key_path && next.uses_desktop_key_ladder => {
            return Err("invalid SSH credential source flags");
        }
        "password" | "key" => {}
        _ => return Err("invalid SSH authentication method"),
    }
    if replacement_secrets.is_some_and(|secrets| secrets.private_key_path.is_some()) {
        return Err("HTTP clients cannot set desktop-local key paths");
    }
    if next.uses_desktop_key_ladder {
        return Err("HTTP clients cannot grant desktop default-key access");
    }

    let requires_replacement = ssh_credential_replacement_required(existing, next);
    if requires_replacement && next.has_key_path {
        return Err("HTTP clients cannot create or redirect desktop-key connections");
    }
    if replacement_secrets
        .is_some_and(|secrets| !super::secret_vault::credential_bundle_matches(next, secrets))
    {
        return Err("SSH credential material does not match its selected source");
    }
    if next.auth_method == "key"
        && replacement_secrets.is_some()
        && !replacement_secrets
            .and_then(|secrets| secrets.private_key_pem.as_deref())
            .map(str::trim)
            .is_some_and(|key| key.starts_with("-----BEGIN "))
    {
        return Err("HTTP key credentials must contain an inline private key");
    }
    if !requires_replacement {
        return Ok(());
    }
    let has_valid_auth_credential = match next.auth_method.as_str() {
        "password" => replacement_secrets
            .and_then(|secrets| secrets.password.as_deref())
            .is_some_and(|password| !password.is_empty()),
        "key" => replacement_secrets
            .and_then(|secrets| secrets.private_key_pem.as_deref())
            .map(str::trim)
            .is_some_and(|key| key.starts_with("-----BEGIN ")),
        _ => false,
    };
    if !has_valid_auth_credential {
        return Err("new or changed SSH authority requires a replacement credential");
    }
    Ok(())
}

fn policy_response(message: &'static str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({ "error": message })),
    )
        .into_response()
}

fn stale_credential_response() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "error": "credential revoked" })),
    )
        .into_response()
}

pub async fn list_ssh_connections(
    Extension(state): Extension<Arc<ServerState>>,
) -> impl IntoResponse {
    Json(serde_json::json!({ "connections": state.connections.all() }))
}

pub async fn create_ssh_connection(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Json(body): Json<SshConnectionUpsertBody>,
) -> Response {
    let SshConnectionUpsertBody {
        mut connection,
        secrets,
    } = body;
    if connection.id.is_empty() {
        connection.id = uuid::Uuid::new_v4().to_string();
    }
    connection.updated_at = super::connections::now_ms();
    let id = connection.id.clone();
    let validation_copy = connection.clone();

    let guarded = state.authenticator.with_current_device_scope(
        &principal,
        DeviceScope::SshConnectionsWrite,
        || {
            state
                .connections
                .upsert_checked_transaction(connection, |existing| {
                    validate_http_upsert(existing, &validation_copy, secrets.as_ref())
                        .map_err(UpsertError::Policy)?;
                    secrets
                        .as_ref()
                        .map(|secrets| {
                            super::secret_vault::begin_store_bound_secrets(
                                &id,
                                &validation_copy,
                                existing.filter(|current| current.deleted_at.is_none()),
                                secrets,
                            )
                            .map_err(UpsertError::Storage)
                        })
                        .transpose()
                })
        },
    );
    upsert_response(guarded, StatusCode::CREATED, &id)
}

pub async fn update_ssh_connection(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(id): Path<String>,
    Json(body): Json<SshConnectionUpsertBody>,
) -> Response {
    let SshConnectionUpsertBody {
        mut connection,
        secrets,
    } = body;
    connection.id = id.clone();
    connection.updated_at = super::connections::now_ms();
    let validation_copy = connection.clone();

    let guarded = state.authenticator.with_current_device_scope(
        &principal,
        DeviceScope::SshConnectionsWrite,
        || {
            state
                .connections
                .upsert_checked_transaction(connection, |existing| {
                    validate_http_upsert(existing, &validation_copy, secrets.as_ref())
                        .map_err(UpsertError::Policy)?;
                    secrets
                        .as_ref()
                        .map(|secrets| {
                            super::secret_vault::begin_store_bound_secrets(
                                &id,
                                &validation_copy,
                                existing.filter(|current| current.deleted_at.is_none()),
                                secrets,
                            )
                            .map_err(UpsertError::Storage)
                        })
                        .transpose()
                })
        },
    );
    upsert_response(guarded, StatusCode::OK, &id)
}

fn upsert_response(
    guarded: Option<Result<UpsertOutcome, UpsertError>>,
    success_status: StatusCode,
    id: &str,
) -> Response {
    match guarded {
        None => stale_credential_response(),
        Some(Ok(UpsertOutcome::Applied)) => {
            (success_status, Json(serde_json::json!({ "id": id }))).into_response()
        }
        Some(Ok(UpsertOutcome::Stale)) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "stale_connection_update" })),
        )
            .into_response(),
        Some(Err(UpsertError::Policy(message))) => policy_response(message),
        Some(Err(UpsertError::Storage(error))) => {
            eprintln!(
                "[ssh-connections] store secrets failed for {}: {}",
                id, error
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "credential_store_failed" })),
            )
                .into_response()
        }
    }
}

pub async fn delete_ssh_connection(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(id): Path<String>,
) -> Response {
    let deleted_at = super::connections::now_ms();
    let guarded = state.authenticator.with_current_device_scope(
        &principal,
        DeviceScope::SshConnectionsWrite,
        || {
            state.connections.delete_transaction(&id, deleted_at, || {
                super::secret_vault::begin_delete_secrets(&id)
            })
        },
    );
    match guarded {
        None => stale_credential_response(),
        Some(Ok(DeleteOutcome::Deleted | DeleteOutcome::Missing)) => {
            (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
        }
        Some(Ok(DeleteOutcome::Stale)) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "stale_connection_delete" })),
        )
            .into_response(),
        Some(Err(error)) => {
            eprintln!(
                "[ssh-connections] delete secrets failed for {}: {}",
                id, error
            );
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "credential_delete_failed" })),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> SavedConnection {
        SavedConnection {
            id: "connection-1".into(),
            name: "Production".into(),
            host: "server.example".into(),
            port: 22,
            username: "alice".into(),
            auth_method: "password".into(),
            has_key_path: false,
            uses_desktop_key_ladder: false,
            updated_at: 1,
            deleted_at: None,
            proxy_type: None,
            proxy_host: None,
            proxy_port: None,
            proxy_username: None,
            skip_shell_hook: None,
            multiplex_sftp: None,
        }
    }

    #[test]
    fn metadata_only_rename_can_preserve_existing_secrets() {
        let existing = connection();
        let mut renamed = existing.clone();
        renamed.name = "Renamed".into();
        assert!(validate_http_upsert(Some(&existing), &renamed, None).is_ok());
    }

    #[test]
    fn endpoint_change_requires_replacement_secret_bundle() {
        let existing = connection();
        let mut redirected = existing.clone();
        redirected.host = "attacker.example".into();
        assert!(validate_http_upsert(Some(&existing), &redirected, None).is_err());
        assert!(
            validate_http_upsert(Some(&existing), &redirected, Some(&SshSecrets::default()),)
                .is_err()
        );
        let mut replacement = SshSecrets::default();
        replacement.password = Some("new-password".into());
        assert!(validate_http_upsert(Some(&existing), &redirected, Some(&replacement)).is_ok());
    }

    #[test]
    fn tombstone_cannot_be_resurrected_without_replacement_secret() {
        let mut tombstone = connection();
        tombstone.deleted_at = Some(5);
        let mut resurrected = tombstone.clone();
        resurrected.deleted_at = None;
        resurrected.updated_at = 6;

        assert!(validate_http_upsert(Some(&tombstone), &resurrected, None).is_err());
        let mut replacement = SshSecrets::default();
        replacement.password = Some("new-password".into());
        assert!(validate_http_upsert(Some(&tombstone), &resurrected, Some(&replacement)).is_ok());
    }

    #[test]
    fn http_rejects_mixed_secret_shape_even_for_unchanged_authority() {
        let existing = connection();
        let mut mixed = SshSecrets::default();
        mixed.password = Some("password".into());
        mixed.private_key_pem = Some("malformed-private-key-placeholder".into());
        assert!(validate_http_upsert(Some(&existing), &existing, Some(&mixed)).is_err());
    }

    #[test]
    fn http_rejects_malformed_inline_key_on_unchanged_authority() {
        let mut existing = connection();
        existing.auth_method = "key".into();
        let mut malformed = SshSecrets::default();
        malformed.private_key_pem = Some("not-a-private-key".into());
        assert!(validate_http_upsert(Some(&existing), &existing, Some(&malformed)).is_err());
    }

    #[test]
    fn device_cannot_redirect_or_create_desktop_key_connection() {
        let mut existing = connection();
        existing.has_key_path = true;
        let mut redirected = existing.clone();
        redirected.host = "attacker.example".into();
        assert!(
            validate_http_upsert(Some(&existing), &redirected, Some(&SshSecrets::default()),)
                .is_err()
        );
        assert!(validate_http_upsert(None, &existing, Some(&SshSecrets::default())).is_err());
    }

    #[test]
    fn device_key_authority_changes_require_inline_private_key() {
        let mut existing = connection();
        existing.auth_method = "key".into();
        let mut redirected = existing.clone();
        redirected.host = "new.example".into();

        let mut path_secrets = SshSecrets::default();
        path_secrets.private_key_pem = Some("~/.ssh/id_ed25519".into());
        assert!(validate_http_upsert(Some(&existing), &redirected, Some(&path_secrets),).is_err());

        let mut inline_secrets = SshSecrets::default();
        inline_secrets.private_key_pem = Some(format!(
            "-----BEGIN {kind} PRIVATE KEY-----\nplaceholder\n-----END {kind} PRIVATE KEY-----",
            kind = "OPENSSH"
        ));
        assert!(validate_http_upsert(Some(&existing), &redirected, Some(&inline_secrets),).is_ok());
    }

    #[test]
    fn owner_http_token_cannot_bind_a_desktop_key_path() {
        let mut connection = connection();
        connection.auth_method = "key".into();
        connection.has_key_path = true;
        let mut path = SshSecrets::default();
        path.private_key_path = Some("/home/me/.ssh/id_ed25519".into());
        assert!(validate_http_upsert(None, &connection, Some(&path)).is_err());
    }
}
