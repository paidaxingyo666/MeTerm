use std::sync::Arc;

use axum::extract::{Extension, Path};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;

use crate::server::auth::AuthPrincipal;
use crate::server::ServerState;

pub async fn request_master(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let requester_id = body.get("client_id").and_then(|v| v.as_str()).unwrap_or("");
    let takeover = body
        .get("takeover")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let Some(session) = state.session_manager.get(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        );
    };
    if !crate::server::device_access::can_access_session(&state.authenticator, &principal, &session)
    {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "device scope required" })),
        );
    }
    if !session.client_matches_principal(requester_id, &principal) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "client identity mismatch" })),
        );
    }
    let Some(conn_gen) = body.get("conn_gen").and_then(|v| v.as_u64()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "conn_gen is required" })),
        );
    };

    if takeover {
        return match session.set_master_for_connection(requester_id, conn_gen, &principal) {
            Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))),
            Err(_) => (
                StatusCode::CONFLICT,
                Json(serde_json::json!({ "error": "stale client connection" })),
            ),
        };
    }

    match session.forward_master_request_for_connection(requester_id, conn_gen, &principal) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))),
        Err(_) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({ "error": "stale client connection" })),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::session::client::{Client, ClientSecurityContext};
    use crate::server::session::state::ClientRole;

    fn state_with_client() -> (Arc<ServerState>, String, String, u64) {
        state_with_client_role(ClientRole::Viewer)
    }

    fn state_with_client_role(role: ClientRole) -> (Arc<ServerState>, String, String, u64) {
        let state = Arc::new(crate::server::create_dummy_state());
        let session = state.session_manager.create();
        let client_id = uuid::Uuid::new_v4().to_string();
        let (client, _receivers) = Client::new(
            client_id.clone(),
            "127.0.0.1".to_string(),
            role,
            ClientSecurityContext::direct_loopback_owner(),
        );
        let client = Arc::new(client);
        let conn_gen = client.conn_gen();
        session.add_client(client).unwrap();
        (state, session.id.clone(), client_id, conn_gen)
    }

    fn owner() -> AuthPrincipal {
        AuthPrincipal::Owner {
            generation: uuid::Uuid::new_v4(),
        }
    }

    #[tokio::test]
    async fn takeover_requires_connection_generation() {
        let (state, session_id, client_id, _) = state_with_client();
        let response = request_master(
            Extension(state),
            Extension(owner()),
            Path(session_id),
            Json(serde_json::json!({
                "client_id": client_id,
                "takeover": true,
            })),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn takeover_rejects_disconnected_generation() {
        let (state, session_id, client_id, conn_gen) = state_with_client();
        let session = state.session_manager.get(&session_id).unwrap();
        session.remove_client(&client_id, conn_gen);

        let response = request_master(
            Extension(state),
            Extension(owner()),
            Path(session_id),
            Json(serde_json::json!({
                "client_id": client_id,
                "conn_gen": conn_gen,
                "takeover": true,
            })),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn takeover_rejects_wrong_principal() {
        let (state, session_id, client_id, conn_gen) = state_with_client();
        let wrong_principal = AuthPrincipal::Device {
            device_id: "other-device".to_string(),
            device_name: "other phone".to_string(),
            generation: uuid::Uuid::new_v4(),
        };
        let response = request_master(
            Extension(state),
            Extension(wrong_principal),
            Path(session_id),
            Json(serde_json::json!({
                "client_id": client_id,
                "conn_gen": conn_gen,
                "takeover": true,
            })),
        )
        .await
        .into_response();

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn readonly_connection_cannot_take_over_or_request_master() {
        for takeover in [true, false] {
            let (state, session_id, client_id, conn_gen) =
                state_with_client_role(ClientRole::ReadOnly);
            let response = request_master(
                Extension(state),
                Extension(owner()),
                Path(session_id),
                Json(serde_json::json!({
                    "client_id": client_id,
                    "conn_gen": conn_gen,
                    "takeover": takeover,
                })),
            )
            .await
            .into_response();

            assert_eq!(response.status(), StatusCode::CONFLICT);
        }
    }
}
