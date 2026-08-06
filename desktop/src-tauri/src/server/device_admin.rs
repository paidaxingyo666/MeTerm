//! Owner-only administration for paired per-device credentials.

use std::sync::Arc;

use axum::extract::{Extension, Path};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;

use super::auth::{AuthPrincipal, OwnerMutationError};
use super::device_auth::DeviceScope;
use super::ServerState;

#[derive(Deserialize)]
pub(crate) struct UpdateDeviceScopesRequest {
    scopes: Vec<DeviceScope>,
}

fn no_store(status: StatusCode, body: serde_json::Value) -> Response {
    let mut response = (status, Json(body)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn owner_generation(principal: &AuthPrincipal) -> Result<uuid::Uuid, Response> {
    principal.owner_generation().ok_or_else(|| {
        no_store(
            StatusCode::FORBIDDEN,
            serde_json::json!({ "error": "owner credential required" }),
        )
    })
}

fn owner_mutation_error(error: OwnerMutationError, invalid_status: StatusCode) -> Response {
    let status = match error {
        OwnerMutationError::Stale => StatusCode::UNAUTHORIZED,
        OwnerMutationError::InvalidToken(_) => invalid_status,
        OwnerMutationError::Storage(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    no_store(status, serde_json::json!({ "error": error.to_string() }))
}

pub(crate) async fn list_credentials(Extension(state): Extension<Arc<ServerState>>) -> Response {
    no_store(
        StatusCode::OK,
        serde_json::json!({
            "devices": state.authenticator.list_device_credentials(),
            "supported_scopes": super::device_auth::supported_scopes(),
            "default_scopes": super::device_auth::default_scopes(),
        }),
    )
}

pub(crate) async fn update_credential_scopes(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(device_id): Path<String>,
    Json(body): Json<UpdateDeviceScopesRequest>,
) -> Response {
    if let Err(error) = super::device_auth::validate_supported_scopes(&body.scopes) {
        return no_store(
            StatusCode::BAD_REQUEST,
            serde_json::json!({ "error": error }),
        );
    }
    let generation = match owner_generation(&principal) {
        Ok(generation) => generation,
        Err(response) => return response,
    };
    let updated = {
        let _owner = match state.authenticator.guard_owner_generation(generation) {
            Ok(owner) => owner,
            Err(error) => return owner_mutation_error(error, StatusCode::BAD_REQUEST),
        };
        state
            .authenticator
            .update_device_scopes(&device_id, body.scopes)
    };

    match updated {
        Ok(Some(updated)) => {
            let cleanup =
                state.disconnect_device_generation(&updated.device_id, updated.retired_generation);
            no_store(
                StatusCode::OK,
                serde_json::json!({
                    "ok": true,
                    "device_id": updated.device_id,
                    "scopes": updated.scopes,
                    "disconnected": cleanup.disconnected,
                    "presence_disconnected": cleanup.presence_disconnected,
                    "push_removed": cleanup.push_removed != 0,
                }),
            )
        }
        Ok(None) => no_store(
            StatusCode::NOT_FOUND,
            serde_json::json!({ "error": "device credential not found" }),
        ),
        Err(error) => no_store(
            StatusCode::INTERNAL_SERVER_ERROR,
            serde_json::json!({ "error": error }),
        ),
    }
}

pub(crate) async fn revoke_credential(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(device_id): Path<String>,
) -> Response {
    let generation = match owner_generation(&principal) {
        Ok(generation) => generation,
        Err(response) => return response,
    };
    let revoked = {
        let _owner = match state.authenticator.guard_owner_generation(generation) {
            Ok(owner) => owner,
            Err(error) => return owner_mutation_error(error, StatusCode::BAD_REQUEST),
        };
        state.authenticator.revoke_device(&device_id)
    };
    match revoked {
        Ok(Some(retired)) => {
            let cleanup =
                state.disconnect_device_generation(&retired.device_id, retired.generation);
            no_store(
                StatusCode::OK,
                serde_json::json!({
                    "ok": true,
                    "disconnected": cleanup.disconnected,
                    "presence_disconnected": cleanup.presence_disconnected,
                    "push_removed": cleanup.push_removed != 0,
                }),
            )
        }
        Ok(None) => no_store(
            StatusCode::NOT_FOUND,
            serde_json::json!({ "error": "device credential not found" }),
        ),
        Err(error) => no_store(
            StatusCode::INTERNAL_SERVER_ERROR,
            serde_json::json!({ "error": error }),
        ),
    }
}

/// Device-authenticated best-effort unpair. Owner credentials are explicitly
/// forbidden so this route cannot rotate or revoke the local owner by mistake.
pub(crate) async fn revoke_self(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
) -> Response {
    let AuthPrincipal::Device {
        device_id,
        generation,
        ..
    } = principal
    else {
        return no_store(
            StatusCode::FORBIDDEN,
            serde_json::json!({ "error": "device credential required" }),
        );
    };

    match state
        .authenticator
        .revoke_device_generation(&device_id, generation)
    {
        Ok(revoked) => {
            let cleanup = if revoked {
                state.disconnect_device_generation(&device_id, generation)
            } else {
                Default::default()
            };
            no_store(
                StatusCode::OK,
                serde_json::json!({
                    "ok": true,
                    "revoked": revoked,
                    "disconnected": cleanup.disconnected,
                    "presence_disconnected": cleanup.presence_disconnected,
                    "push_removed": cleanup.push_removed != 0,
                }),
            )
        }
        Err(error) => no_store(
            StatusCode::INTERNAL_SERVER_ERROR,
            serde_json::json!({ "error": error }),
        ),
    }
}

pub(crate) async fn set_owner_token(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let generation = match owner_generation(&principal) {
        Ok(generation) => generation,
        Err(response) => return response,
    };
    let token = body
        .get("token")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    match state.update_token_for_owner(generation, token.to_string()) {
        Ok(()) => no_store(StatusCode::OK, serde_json::json!({ "ok": true })),
        Err(error) => owner_mutation_error(error, StatusCode::BAD_REQUEST),
    }
}

pub(crate) async fn refresh_owner_token(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
) -> Response {
    let generation = match owner_generation(&principal) {
        Ok(generation) => generation,
        Err(response) => return response,
    };
    let new_token = super::generate_token();
    match state.update_token_for_owner(generation, new_token.clone()) {
        Ok(()) => no_store(
            StatusCode::OK,
            serde_json::json!({ "ok": true, "token": new_token }),
        ),
        Err(error) => owner_mutation_error(error, StatusCode::BAD_REQUEST),
    }
}

pub(crate) async fn revoke_all(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
) -> Response {
    let generation = match owner_generation(&principal) {
        Ok(generation) => generation,
        Err(response) => return response,
    };
    let new_token = super::generate_token();
    let outcome = match state.revoke_all_for_owner(generation, new_token.clone()) {
        Ok(outcome) => outcome,
        Err(error) => return owner_mutation_error(error, StatusCode::BAD_REQUEST),
    };

    let cleanup = state.disconnect_device_generations(&outcome.retired_devices);

    match outcome.device_error {
        None => no_store(
            StatusCode::OK,
            serde_json::json!({
                "ok": true,
                "new_token": new_token,
                "disconnected": cleanup.disconnected,
                "presence_disconnected": cleanup.presence_disconnected,
                "push_removed": cleanup.push_removed,
            }),
        ),
        Some(error) => no_store(
            StatusCode::INTERNAL_SERVER_ERROR,
            serde_json::json!({
                "error": error,
                "owner_rotated": true,
                "new_token": new_token,
                "devices_revoked": false,
                "disconnected": cleanup.disconnected,
                "presence_disconnected": cleanup.presence_disconnected,
                "push_removed": cleanup.push_removed,
            }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_admin_responses_disable_caching() {
        let response = no_store(StatusCode::OK, serde_json::json!({ "token": "secret" }));
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
    }
}
