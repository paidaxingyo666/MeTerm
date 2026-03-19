//! HTTP API handlers — mirrors Go `api/handler.go`.
//!
//! All handlers receive `Arc<ServerState>` via axum Extension.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Extension, Path, Query};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};

use super::executor::Executor;
use super::ServerState;

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct OkResponse {
    ok: bool,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

fn ok_json() -> impl IntoResponse {
    Json(OkResponse { ok: true })
}

fn err_json(status: StatusCode, msg: &str) -> impl IntoResponse {
    (status, Json(ErrorResponse { error: msg.to_string() }))
}

// ---------------------------------------------------------------------------
// Ping (no auth)
// ---------------------------------------------------------------------------

pub async fn ping() -> impl IntoResponse {
    Json(serde_json::json!({ "service": "meterm" }))
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct CreateSessionRequest {
    #[serde(default)]
    pub shell: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

fn default_cols() -> u16 { 80 }
fn default_rows() -> u16 { 24 }

pub async fn create_session(
    Extension(state): Extension<Arc<ServerState>>,
    body: Option<Json<CreateSessionRequest>>,
) -> impl IntoResponse {
    eprintln!("[handler] create_session called, body={:?}", body.is_some());
    let (shell, cwd, cols, rows) = if let Some(Json(req)) = body {
        (req.shell, req.cwd, req.cols, req.rows)
    } else {
        (String::new(), String::new(), 80, 24)
    };

    let session = state.session_manager.create();

    // Start the terminal via LocalShellExecutor
    let executor = super::executor::local::LocalShellExecutor::new(
        shell, cwd, cols, rows,
    );
    match executor.start().await {
        Ok(terminal) => {
            // Start terminal I/O loop (read output → broadcast, receive input → write)
            super::session::Session::start_terminal(session.clone(), terminal).await;
        }
        Err(e) => {
            eprintln!("[meterm] terminal start failed: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("terminal start failed: {}", e) })),
            );
        }
    }

    (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "id": session.id,
            "created_at": format!("{:?}", session.created_at),
            "state": session.state_string(),
        })),
    )
}

pub async fn list_sessions(
    Extension(state): Extension<Arc<ServerState>>,
) -> impl IntoResponse {
    let sessions = state.session_manager.list();
    let list: Vec<serde_json::Value> = sessions
        .iter()
        .map(|s| {
            serde_json::json!({
                "id": s.id,
                "state": s.state_string(),
                "clients": s.connected_client_count(),
                "connected_clients": s.connected_client_count(),
                "master": s.master(),
                "created_at": format!("{:?}", s.created_at),
            })
        })
        .collect();
    Json(serde_json::json!({ "sessions": list }))
}

pub async fn get_session(
    Extension(state): Extension<Arc<ServerState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.session_manager.get(&id) {
        Some(s) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "id": s.id,
                "state": s.state_string(),
                "clients": s.connected_client_count(),
                "connected_clients": s.connected_client_count(),
                "master": s.master(),
                "owner": s.owner(),
                "private": *s.private.lock().unwrap(),
                "created_at": format!("{:?}", s.created_at),
            })),
        ),
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        ),
    }
}

pub async fn delete_session(
    Extension(state): Extension<Arc<ServerState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.session_manager.delete(&id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))),
        Err(e) => (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": e }))),
    }
}

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------

pub async fn create_ssh_session(
    Extension(state): Extension<Arc<ServerState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let config = match parse_ssh_config(&body) {
        Ok(c) => c,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": e }))),
    };

    let session = state.session_manager.create();
    *session.executor_type.lock().unwrap() = "ssh".to_string();

    // Start SSH terminal + SFTP
    let executor = super::executor::ssh::SshExecutor::new(config, 80, 24);
    match executor.start_with_sftp().await {
        Ok((terminal, sftp)) => {
            // Store SFTP client on session for file operations
            if let Some(sftp_client) = sftp {
                *session.sftp.lock().unwrap() = Some(sftp_client);
            }
            // Store SSH session handle for exec (ServerInfo, process list)
            let ssh_handle = terminal.session_handle.clone();
            *session.ssh_exec_handle.lock().await = Some(Box::new(ssh_handle));
            super::session::Session::start_terminal(session.clone(), Box::new(terminal)).await;
        }
        Err(e) => {
            // Check for host key errors (JSON-encoded in the error string)
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&e) {
                if parsed.get("error").and_then(|v| v.as_str()) == Some("host_key_unknown") {
                    return (StatusCode::CONFLICT, Json(parsed));
                }
            }
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("SSH failed: {}", e) })),
            );
        }
    }

    (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "id": session.id,
            "created_at": format!("{:?}", session.created_at),
            "state": session.state_string(),
            "executor_type": "ssh",
        })),
    )
}

pub async fn test_ssh_connection(
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let config = match parse_ssh_config(&body) {
        Ok(c) => c,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
    };

    match super::terminal::ssh::test_connection(&config).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => {
            // Check for host key errors (JSON-encoded)
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&e) {
                if parsed.get("error").and_then(|v| v.as_str()) == Some("host_key_unknown") {
                    return Json(parsed);
                }
            }
            Json(serde_json::json!({ "ok": false, "error": e }))
        }
    }
}

fn parse_ssh_config(body: &serde_json::Value) -> Result<super::terminal::ssh::SshConfig, String> {
    let host = body.get("host").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let username = body.get("username").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if host.is_empty() || username.is_empty() {
        return Err("host and username are required".to_string());
    }
    Ok(super::terminal::ssh::SshConfig {
        host,
        port: body.get("port").and_then(|v| v.as_u64()).unwrap_or(22) as u16,
        username,
        password: body.get("password").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        private_key: body.get("private_key").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        passphrase: body.get("passphrase").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        trusted_fingerprint: body.get("trusted_fingerprint").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        disable_hook: body.get("skip_shell_hook").and_then(|v| v.as_bool()).unwrap_or(false),
    })
}

// ---------------------------------------------------------------------------
// Master role
// ---------------------------------------------------------------------------

pub async fn request_master(
    Extension(state): Extension<Arc<ServerState>>,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let requester_id = body.get("client_id").and_then(|v| v.as_str()).unwrap_or("");
    match state.session_manager.get(&id) {
        Some(session) => {
            session.forward_master_request(requester_id);
            (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
        }
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "session not found" }))),
    }
}

pub async fn set_private(
    Extension(state): Extension<Arc<ServerState>>,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let private = body.get("private").and_then(|v| v.as_bool()).unwrap_or(false);
    match state.session_manager.get(&id) {
        Some(session) => {
            let kicked = session.set_private(private);
            (StatusCode::OK, Json(serde_json::json!({ "ok": true, "kicked": kicked })))
        }
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "session not found" }))),
    }
}

// ---------------------------------------------------------------------------
// Clients / devices
// ---------------------------------------------------------------------------

pub async fn list_clients(
    Extension(state): Extension<Arc<ServerState>>,
) -> impl IntoResponse {
    let clients = state.session_manager.list_all_clients();
    Json(serde_json::json!({ "clients": clients }))
}

pub async fn kick_client(
    Extension(state): Extension<Arc<ServerState>>,
    Path((session_id, client_id)): Path<(String, String)>,
) -> impl IntoResponse {
    match state.session_manager.get(&session_id) {
        Some(session) => {
            let (addr, found) = session.kick_client(&client_id);
            if found {
                // Check if ban=true in query params (simplified)
                (StatusCode::OK, Json(serde_json::json!({ "ok": true, "remote_addr": addr })))
            } else {
                (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "client not found" })))
            }
        }
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "session not found" }))),
    }
}

pub async fn list_devices(
    Extension(state): Extension<Arc<ServerState>>,
) -> impl IntoResponse {
    let devices = state.session_manager.list_devices();
    Json(serde_json::json!({ "devices": devices }))
}

pub async fn kick_device(
    Extension(state): Extension<Arc<ServerState>>,
    Path(ip): Path<String>,
) -> impl IntoResponse {
    let count = state.session_manager.kick_by_ip(&ip);
    Json(serde_json::json!({ "ok": true, "kicked": count }))
}

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

pub async fn set_token(
    Extension(state): Extension<Arc<ServerState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let token = body.get("token").and_then(|v| v.as_str()).unwrap_or("");
    if token.len() < 8 {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "token must be at least 8 characters" })));
    }
    state.authenticator.set_token(token.to_string());
    (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
}

pub async fn refresh_token(
    Extension(state): Extension<Arc<ServerState>>,
) -> impl IntoResponse {
    let new_token = super::generate_token();
    state.authenticator.set_token(new_token.clone());
    Json(serde_json::json!({ "ok": true, "token": new_token }))
}

pub async fn revoke_all(
    Extension(state): Extension<Arc<ServerState>>,
) -> impl IntoResponse {
    let new_token = super::generate_token();
    state.authenticator.set_token(new_token.clone());
    let disconnected = state.session_manager.disconnect_all_clients();
    Json(serde_json::json!({ "ok": true, "new_token": new_token, "disconnected": disconnected }))
}

// ---------------------------------------------------------------------------
// IP ban management
// ---------------------------------------------------------------------------

pub async fn list_bans(
    Extension(state): Extension<Arc<ServerState>>,
) -> impl IntoResponse {
    let bans = state.ban_manager.list();
    Json(serde_json::json!({ "banned_ips": bans }))
}

pub async fn ban_ip(
    Extension(state): Extension<Arc<ServerState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let ip = body.get("ip").and_then(|v| v.as_str()).unwrap_or("");
    let reason = body.get("reason").and_then(|v| v.as_str()).unwrap_or("");
    match state.ban_manager.ban(ip, reason) {
        Ok(()) => {
            // Also kick the banned IP
            state.session_manager.kick_by_ip(ip);
            (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": e }))),
    }
}

pub async fn unban_ip(
    Extension(state): Extension<Arc<ServerState>>,
    Path(ip): Path<String>,
) -> impl IntoResponse {
    let found = state.ban_manager.unban(&ip);
    Json(serde_json::json!({ "ok": true, "found": found }))
}

// ---------------------------------------------------------------------------
// Pairing (stub — full implementation needs PairingManager)
// ---------------------------------------------------------------------------

pub async fn create_pair(
    Extension(state): Extension<Arc<ServerState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let device_name = body.get("device_name").and_then(|v| v.as_str()).unwrap_or("unknown");
    let remote_addr = body.get("remote_addr").and_then(|v| v.as_str()).unwrap_or("");
    match state.pairing_manager.create_request(device_name, remote_addr) {
        Ok((pair_id, secret)) => (
            StatusCode::OK,
            Json(serde_json::json!({ "pair_id": pair_id, "secret": secret })),
        ),
        Err(e) => (StatusCode::TOO_MANY_REQUESTS, Json(serde_json::json!({ "error": e }))),
    }
}

pub async fn poll_pair(
    Extension(state): Extension<Arc<ServerState>>,
    Path(id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let secret = params.get("secret").map(|s| s.as_str()).unwrap_or("");
    match state.pairing_manager.get_request(&id, secret) {
        Some(status) => (StatusCode::OK, Json(serde_json::json!({
            "ok": status.status == "approved",
            "status": status.status,
            "token": status.token,
        }))),
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "not found" }))),
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
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let approved = body.get("approved").and_then(|v| v.as_bool()).unwrap_or(false);
    state.pairing_manager.handle_approval(approved, &id);
    Json(serde_json::json!({ "ok": true }))
}

// ---------------------------------------------------------------------------
// Discovery (stub — needs DiscoveryManager with mdns-sd)
// ---------------------------------------------------------------------------

pub async fn toggle_discoverable(
    Extension(state): Extension<Arc<ServerState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let enabled = body.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    let port = body.get("port").and_then(|v| v.as_u64()).map(|p| p as u16);
    if let Some(ref dm) = state.discovery_manager {
        if let Err(e) = dm.set_discoverable(enabled, port) {
            return Json(serde_json::json!({ "ok": false, "error": e }));
        }
        return Json(serde_json::json!({ "ok": true, "discoverable": dm.is_discoverable() }));
    }
    Json(serde_json::json!({ "ok": true, "discoverable": false }))
}

pub async fn discover(
    Extension(state): Extension<Arc<ServerState>>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let timeout = params.get("timeout")
        .and_then(|t| t.parse::<u64>().ok())
        .unwrap_or(5)
        .min(10);
    if let Some(ref dm) = state.discovery_manager {
        let services = dm.discover(timeout).await;
        return Json(serde_json::json!({ "services": services }));
    }
    Json(serde_json::json!({ "services": [] }))
}

// ---------------------------------------------------------------------------
// System info
// ---------------------------------------------------------------------------

pub async fn server_info(
    Extension(state): Extension<Arc<ServerState>>,
) -> impl IntoResponse {
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_default();
    let session_count = state.session_manager.list().len();
    Json(serde_json::json!({
        "name": hostname,
        "version": env!("CARGO_PKG_VERSION"),
        "sessions": session_count,
    }))
}

