//! HTTP surface for QR bootstrap, approval pairing, and LAN discovery.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Extension, Path, Query};
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;

use super::auth::AuthPrincipal;
use super::ServerState;

#[derive(Deserialize)]
pub struct BootstrapPairRequest {
    #[serde(alias = "pair_ticket")]
    ticket: String,
    device_id: String,
    device_name: String,
    pop_alg: String,
    pop_public_key: String,
    pop_signature: String,
}

#[derive(Deserialize)]
pub struct PairPollRequest {
    secret: String,
}

fn no_store_json(status: StatusCode, body: serde_json::Value) -> axum::response::Response {
    ([(header::CACHE_CONTROL, "no-store")], (status, Json(body))).into_response()
}

/// One-time QR bootstrap. The route is public but its router requires TLS for
/// every non-loopback connection before this body is parsed.
pub async fn bootstrap_pair(
    Extension(state): Extension<Arc<ServerState>>,
    Json(body): Json<BootstrapPairRequest>,
) -> axum::response::Response {
    let identity = match state
        .authenticator
        .validate_device_identity(&body.device_id, &body.device_name)
    {
        Ok(identity) => identity,
        Err(error) => {
            return no_store_json(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": error }),
            );
        }
    };
    if body.pop_alg != super::pop::ALGORITHM {
        return no_store_json(
            StatusCode::BAD_REQUEST,
            serde_json::json!({ "error": "unsupported proof algorithm" }),
        );
    }
    match state.pairing_manager.redeem_bootstrap_ticket(
        &body.ticket,
        &identity.device_id,
        &identity.device_name,
        &body.pop_public_key,
        &body.pop_signature,
    ) {
        Ok(issued) => {
            // Issuing for an existing stable device ID rotates its hash. Also
            // terminate already-authenticated sockets so a stolen old bearer
            // does not remain useful until its connection happens to close.
            if let Some(retired_generation) = issued.retired_generation {
                state.disconnect_device_generation(&identity.device_id, retired_generation);
            }
            no_store_json(StatusCode::OK, serde_json::json!({ "token": issued.token }))
        }
        Err(error) => {
            let status = if error == "LAN access is disabled" {
                StatusCode::FORBIDDEN
            } else if error == "invalid or expired pair_ticket" {
                StatusCode::UNAUTHORIZED
            } else if error.starts_with("invalid ") {
                StatusCode::BAD_REQUEST
            } else if error.contains("limit reached") {
                StatusCode::TOO_MANY_REQUESTS
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            no_store_json(status, serde_json::json!({ "error": error }))
        }
    }
}

pub async fn create_pair(
    Extension(state): Extension<Arc<ServerState>>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Json(body): Json<serde_json::Value>,
) -> axum::response::Response {
    let remote_addr = addr.ip().to_string();
    let device_name = body
        .get("device_info")
        .or_else(|| body.get("device_name"))
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let device_id = body
        .get("device_id")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let pop_alg = body
        .get("pop_alg")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let pop_public_key = body
        .get("pop_public_key")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let pop_signature = body
        .get("pop_signature")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    if pop_alg != super::pop::ALGORITHM {
        return no_store_json(
            StatusCode::BAD_REQUEST,
            serde_json::json!({ "error": "unsupported proof algorithm" }),
        );
    }
    match state.pairing_manager.create_request(
        device_name,
        device_id,
        &remote_addr,
        pop_public_key,
        pop_signature,
    ) {
        Ok((pair_id, secret)) => no_store_json(
            StatusCode::OK,
            serde_json::json!({ "pair_id": pair_id, "secret": secret }),
        ),
        Err(error) => {
            let status = if error == "LAN access is disabled" {
                StatusCode::FORBIDDEN
            } else if error == "rate limit exceeded" || error.contains("limit reached") {
                StatusCode::TOO_MANY_REQUESTS
            } else {
                StatusCode::BAD_REQUEST
            };
            no_store_json(status, serde_json::json!({ "error": error }))
        }
    }
}

/// v2 poll variant: keeps the short-lived pair secret out of URLs and logs.
pub async fn poll_pair_post(
    Extension(state): Extension<Arc<ServerState>>,
    Path(id): Path<String>,
    Json(body): Json<PairPollRequest>,
) -> axum::response::Response {
    pair_status_response(&state, &id, &body.secret)
}

fn pair_status_response(
    state: &Arc<ServerState>,
    id: &str,
    secret: &str,
) -> axum::response::Response {
    match state.pairing_manager.get_request(id, secret) {
        Some(status) => no_store_json(
            StatusCode::OK,
            serde_json::json!({
                "ok": status.status == "approved",
                "status": status.status,
                "token": status.token,
            }),
        ),
        None => no_store_json(
            StatusCode::NOT_FOUND,
            serde_json::json!({ "error": "not found" }),
        ),
    }
}

pub async fn list_pending_pairs(
    Extension(state): Extension<Arc<ServerState>>,
) -> impl IntoResponse {
    let pairs = state.pairing_manager.list_pending();
    Json(serde_json::json!({ "pairs": pairs }))
}

pub async fn respond_pair(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let Some(owner_generation) = principal.owner_generation() else {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "owner credential required" })),
        );
    };
    let approved = body
        .get("approved")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    match state
        .pairing_manager
        .handle_approval(approved, &id, owner_generation)
    {
        Ok(rotation) => {
            if let Some(rotation) = rotation {
                if let Some(retired_generation) = rotation.retired_generation {
                    state.disconnect_device_generation(&rotation.device_id, retired_generation);
                }
            }
            (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
        }
        Err(error) => {
            let status = if error == "owner credential revoked" {
                StatusCode::UNAUTHORIZED
            } else if error == "pair request not found" {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (status, Json(serde_json::json!({ "error": error })))
        }
    }
}

pub async fn claim_pair(
    Extension(state): Extension<Arc<ServerState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let nonce = body
        .get("nonce")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    if nonce.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "nonce is required" })),
        );
    }
    let device_name = body
        .get("device_name")
        .and_then(|value| value.as_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string);
    match state.pairing_manager.claim(nonce, device_name) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": error })),
        ),
    }
}

pub async fn claim_status(
    Extension(state): Extension<Arc<ServerState>>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let nonce = params.get("nonce").map(String::as_str).unwrap_or("");
    let (claimed, device_name) = state.pairing_manager.is_claimed(nonce);
    Json(serde_json::json!({ "claimed": claimed, "device_name": device_name }))
}

pub async fn toggle_discoverable(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let enabled = body
        .get("enabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let Ok(_owner) = state.authenticator.guard_owner_principal(&principal) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "owner credential revoked" })),
        );
    };
    match state.set_lan_discovery(enabled) {
        Ok(status) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "ok": true,
                "enabled": status.enabled,
                "discoverable": status.discoverable,
                "lan_port": status.lan_port,
            })),
        ),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "ok": false, "error": error })),
        ),
    }
}

pub async fn discover(
    Extension(state): Extension<Arc<ServerState>>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let timeout = params
        .get("timeout")
        .and_then(|timeout| timeout.parse::<u64>().ok())
        .unwrap_or(5)
        .min(10);
    if let Some(ref discovery) = state.discovery_manager {
        let services = discovery.discover(timeout).await;
        return Json(serde_json::json!({ "services": services }));
    }
    Json(serde_json::json!({ "services": [] }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_request_uses_ticket_wire_key_and_accepts_legacy_alias() {
        let current: BootstrapPairRequest = serde_json::from_value(serde_json::json!({
            "ticket": "ticket-value",
            "device_id": "device-1",
            "device_name": "Phone",
            "pop_alg": "ES256",
            "pop_public_key": "public-key",
            "pop_signature": "signature"
        }))
        .unwrap();
        let alias: BootstrapPairRequest = serde_json::from_value(serde_json::json!({
            "pair_ticket": "ticket-value",
            "device_id": "device-1",
            "device_name": "Phone",
            "pop_alg": "ES256",
            "pop_public_key": "public-key",
            "pop_signature": "signature"
        }))
        .unwrap();

        assert_eq!(current.ticket, "ticket-value");
        assert_eq!(alias.ticket, "ticket-value");
    }

    #[test]
    fn pair_poll_post_body_keeps_secret_out_of_url() {
        let body: PairPollRequest =
            serde_json::from_value(serde_json::json!({ "secret": "pair-secret" })).unwrap();
        assert_eq!(body.secret, "pair-secret");
    }

    #[test]
    fn credential_responses_disable_caching() {
        let response = no_store_json(StatusCode::OK, serde_json::json!({ "token": "secret" }));
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
    }
}
