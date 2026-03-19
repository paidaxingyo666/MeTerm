//! JumpServer HTTP proxy handler — mirrors Go `api/jumpserver_handler.go`.
//!
//! Uses client pool (get_or_create_client) to maintain session cookies across
//! auth → MFA → API call flow.

use axum::extract::Json;
use axum::response::IntoResponse;
use serde::Deserialize;

use super::*;

/// Auth endpoint: POST /api/jumpserver/auth
pub async fn auth(Json(req): Json<AuthRequest>) -> impl IntoResponse {
    eprintln!("[jumpserver] auth: base_url={} username={}", req.base_url, req.username);
    // Reset client for fresh session (matches Go resetJSClient)
    {
        let mut pool = CLIENT_POOL.lock().unwrap();
        pool.remove(req.base_url.trim_end_matches('/'));
    }
    let client_arc = get_or_create_client(&req.base_url);
    let mut client = client_arc.lock().await;
    let result = client.authenticate(&req).await;
    eprintln!("[jumpserver] auth result: ok={} mfa_required={:?} token={:?} error={:?}",
        result.ok, result.mfa_required, result.token.is_some(), result.error);
    Json(result)
}

/// Token auth endpoint: POST /api/jumpserver/token-auth
pub async fn token_auth(Json(req): Json<TokenAuthRequest>) -> impl IntoResponse {
    let client_arc = get_or_create_client(&req.base_url);
    let mut client = client_arc.lock().await;
    let result = client.token_auth(&req).await;
    Json(result)
}

/// MFA endpoint: POST /api/jumpserver/mfa
pub async fn mfa(Json(req): Json<MfaRequest>) -> impl IntoResponse {
    let client_arc = get_or_create_client(&req.base_url);
    let mut client = client_arc.lock().await;
    let result = client.submit_mfa(&req).await;
    Json(result)
}

/// Get assets: GET /api/jumpserver/assets?base_url=...&search=...&node_id=...&page=...&page_size=...
#[derive(Deserialize)]
pub struct GetAssetsQuery {
    pub base_url: String,
    #[serde(default)]
    pub search: String,
    #[serde(default)]
    pub node_id: String,
    #[serde(default = "default_page")]
    pub page: u32,
    #[serde(default = "default_page_size")]
    pub page_size: u32,
}

fn default_page() -> u32 { 1 }
fn default_page_size() -> u32 { 50 }

pub async fn get_assets(
    axum::extract::Query(query): axum::extract::Query<GetAssetsQuery>,
) -> impl IntoResponse {
    let client_arc = get_or_create_client(&query.base_url);
    let client = client_arc.lock().await;
    match client.get_assets(&query.search, &query.node_id, query.page, query.page_size).await {
        Ok((assets, total)) => Json(serde_json::json!({
            "ok": true, "assets": assets, "total": total, "page": query.page,
        })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

/// Get nodes: GET /api/jumpserver/nodes?base_url=...
#[derive(Deserialize)]
pub struct GetNodesQuery {
    pub base_url: String,
}

pub async fn get_nodes(
    axum::extract::Query(query): axum::extract::Query<GetNodesQuery>,
) -> impl IntoResponse {
    let client_arc = get_or_create_client(&query.base_url);
    let client = client_arc.lock().await;
    match client.get_nodes().await {
        Ok(nodes) => Json(serde_json::json!({ "ok": true, "nodes": nodes })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

/// Get accounts: GET /api/jumpserver/accounts?base_url=...&asset_id=...
#[derive(Deserialize)]
pub struct GetAccountsQuery {
    pub base_url: String,
    pub asset_id: String,
}

pub async fn get_accounts(
    axum::extract::Query(query): axum::extract::Query<GetAccountsQuery>,
) -> impl IntoResponse {
    let client_arc = get_or_create_client(&query.base_url);
    let client = client_arc.lock().await;
    match client.get_accounts(&query.asset_id).await {
        Ok(accounts) => Json(serde_json::json!({ "ok": true, "accounts": accounts })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

/// Create connection token: POST /api/jumpserver/connection-token
pub async fn create_connection_token(
    Json(req): Json<ConnectionTokenRequest>,
) -> impl IntoResponse {
    let client_arc = get_or_create_client(&req.base_url);
    let client = client_arc.lock().await;
    match client.create_connection_token(&req).await {
        Ok(token) => Json(serde_json::json!({
            "ok": true, "id": token.id, "token": token.token, "secret": token.secret,
        })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

/// Test connection: POST /api/jumpserver/test
#[derive(Deserialize)]
pub struct TestConnectionRequest {
    pub base_url: String,
}

pub async fn test_connection(Json(req): Json<TestConnectionRequest>) -> impl IntoResponse {
    match JumpServerClient::test_connection(&req.base_url).await {
        Ok(()) => Json(serde_json::json!({ "ok": true })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}
