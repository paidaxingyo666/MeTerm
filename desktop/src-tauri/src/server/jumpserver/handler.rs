//! JumpServer HTTP proxy handler — mirrors Go `api/jumpserver_handler.go`.
//!
//! Uses client pool (get_or_create_client) to maintain session cookies across
//! auth → MFA → API call flow.

use axum::extract::{Extension, Json};
use axum::response::IntoResponse;
use serde::Deserialize;

use crate::server::auth::AuthPrincipal;

use super::credential_broker::{self, JumpServerCredentialBinding};
use super::*;

const JUMPSERVER_OPERATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);
const JUMPSERVER_LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

fn auth_error(error: String) -> Json<AuthResponse> {
    Json(AuthResponse {
        ok: false,
        token: None,
        mfa_required: None,
        mfa_choices: None,
        error: Some(error),
    })
}

fn valid_secret_input(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes && !value.contains('\0')
}

fn valid_auth_identity(value: &str) -> bool {
    !value.is_empty() && valid_display_text(value, 256)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerAuthRequest {
    pub binding: JumpServerCredentialBinding,
    /// A credential the user entered for this one attempt. Stored credentials
    /// are never copied into this field or returned to the caller.
    #[serde(default)]
    pub credential_override: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerMfaRequest {
    pub binding: JumpServerCredentialBinding,
    #[serde(rename = "type")]
    pub mfa_type: String,
    pub code: String,
}

fn redact_auth_credential(mut response: AuthResponse) -> AuthResponse {
    // Password auth may issue a reusable access token; token auth returns the
    // submitted API token itself. Both stay inside the Rust client pool.
    response.token = None;
    response
}

fn owner_may_materialize(principal: &AuthPrincipal) -> bool {
    matches!(principal, AuthPrincipal::Owner { .. })
}

fn credential_for_auth(
    principal: &AuthPrincipal,
    binding: &JumpServerCredentialBinding,
    credential_override: Option<String>,
) -> Result<String, String> {
    if let Some(credential) = credential_override {
        if valid_secret_input(&credential, 64 * 1024) {
            return Ok(credential);
        }
        return Err("invalid JumpServer authentication request".to_string());
    }
    if !owner_may_materialize(principal) {
        return Err("stored JumpServer credentials are desktop-owner only".to_string());
    }
    let credentials = credential_broker::materialize(binding.clone())?;
    let credential = match binding.auth_method.as_str() {
        "password" => credentials.password,
        "token" => credentials.api_token,
        _ => None,
    }
    .ok_or_else(|| "jumpserver_credential_missing".to_string())?;
    if !valid_secret_input(&credential, 64 * 1024) {
        return Err("invalid JumpServer credential".to_string());
    }
    Ok(credential)
}

/// Auth endpoint: POST /api/jumpserver/auth
pub async fn auth(
    Extension(principal): Extension<AuthPrincipal>,
    Json(req): Json<BrokerAuthRequest>,
) -> impl IntoResponse {
    // 用户名、Token 和认证响应都不应进程序日志；只记录流程状态。
    eprintln!("[jumpserver] authentication started");
    let binding = match credential_broker::normalize_binding(req.binding) {
        Ok(binding) if binding.auth_method == "password" => binding,
        Ok(_) => return auth_error("invalid JumpServer authentication method".to_string()),
        Err(error) => return auth_error(error),
    };
    if !valid_auth_identity(&binding.username) || !valid_display_text(&binding.org_id, 256) {
        return auth_error("invalid JumpServer authentication request".to_string());
    }
    let password = match credential_for_auth(&principal, &binding, req.credential_override) {
        Ok(password) => password,
        Err(error) => return auth_error(error),
    };
    let auth_request = AuthRequest {
        base_url: binding.base_url.clone(),
        username: binding.username.clone(),
        password,
        org_id: binding.org_id.clone(),
    };
    let normalized_base_url = binding.base_url;
    // Reset only this authenticated generation's client. Another paired
    // device using the same JumpServer origin owns an independent login.
    if let Err(error) = reset_client(&normalized_base_url, &principal) {
        return auth_error(error);
    }
    let client_arc = match get_or_create_client(&normalized_base_url, &principal) {
        Ok(client) => client,
        Err(error) => return auth_error(error),
    };
    let mut client = match tokio::time::timeout(JUMPSERVER_LOCK_TIMEOUT, client_arc.lock()).await {
        Ok(client) => client,
        Err(_) => return auth_error("JumpServer client is busy".to_string()),
    };
    let result = match tokio::time::timeout(
        JUMPSERVER_OPERATION_TIMEOUT,
        client.authenticate(&auth_request),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => AuthResponse {
            ok: false,
            token: None,
            mfa_required: None,
            mfa_choices: None,
            error: Some("JumpServer authentication timed out".to_string()),
        },
    };
    eprintln!(
        "[jumpserver] authentication finished: ok={} mfa_required={} credential_issued={} error={}",
        result.ok,
        result.mfa_required.unwrap_or(false),
        result.token.is_some(),
        result.error.is_some(),
    );
    Json(redact_auth_credential(result))
}

/// Token auth endpoint: POST /api/jumpserver/token-auth
pub async fn token_auth(
    Extension(principal): Extension<AuthPrincipal>,
    Json(req): Json<BrokerAuthRequest>,
) -> impl IntoResponse {
    let binding = match credential_broker::normalize_binding(req.binding) {
        Ok(binding) if binding.auth_method == "token" => binding,
        Ok(_) => return auth_error("invalid JumpServer authentication method".to_string()),
        Err(error) => return auth_error(error),
    };
    let token = match credential_for_auth(&principal, &binding, req.credential_override) {
        Ok(token) if valid_bearer_token(&token) => token,
        Ok(_) => return auth_error("invalid JumpServer authentication request".to_string()),
        Err(error) => return auth_error(error),
    };
    let token_request = TokenAuthRequest {
        base_url: binding.base_url.clone(),
        token,
        org_id: binding.org_id.clone(),
    };
    let client_arc = match get_or_create_client(&binding.base_url, &principal) {
        Ok(client) => client,
        Err(error) => return auth_error(error),
    };
    let mut client = match tokio::time::timeout(JUMPSERVER_LOCK_TIMEOUT, client_arc.lock()).await {
        Ok(client) => client,
        Err(_) => return auth_error("JumpServer client is busy".to_string()),
    };
    let result = match tokio::time::timeout(
        JUMPSERVER_OPERATION_TIMEOUT,
        client.token_auth(&token_request),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => AuthResponse {
            ok: false,
            token: None,
            mfa_required: None,
            mfa_choices: None,
            error: Some("JumpServer authentication timed out".to_string()),
        },
    };
    Json(redact_auth_credential(result))
}

/// MFA endpoint: POST /api/jumpserver/mfa
pub async fn mfa(
    Extension(principal): Extension<AuthPrincipal>,
    Json(req): Json<BrokerMfaRequest>,
) -> impl IntoResponse {
    if !valid_resource_id(&req.mfa_type) || !valid_secret_input(&req.code, 1_024) {
        return auth_error("invalid JumpServer MFA request".to_string());
    }
    let binding = match credential_broker::normalize_binding(req.binding) {
        Ok(binding) => binding,
        Err(error) => return auth_error(error),
    };
    let client_arc = match get_or_create_client(&binding.base_url, &principal) {
        Ok(client) => client,
        Err(error) => return auth_error(error),
    };
    let mut client = match tokio::time::timeout(JUMPSERVER_LOCK_TIMEOUT, client_arc.lock()).await {
        Ok(client) => client,
        Err(_) => return auth_error("JumpServer client is busy".to_string()),
    };
    let result = match tokio::time::timeout(
        JUMPSERVER_OPERATION_TIMEOUT,
        client.submit_mfa(&MfaRequest {
            base_url: binding.base_url,
            mfa_type: req.mfa_type,
            code: req.code,
        }),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => AuthResponse {
            ok: false,
            token: None,
            mfa_required: None,
            mfa_choices: None,
            error: Some("JumpServer MFA request timed out".to_string()),
        },
    };
    Json(redact_auth_credential(result))
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

fn default_page() -> u32 {
    1
}
fn default_page_size() -> u32 {
    50
}

pub async fn get_assets(
    Extension(principal): Extension<AuthPrincipal>,
    axum::extract::Query(query): axum::extract::Query<GetAssetsQuery>,
) -> impl IntoResponse {
    if !(1..=10_000).contains(&query.page)
        || !(1..=MAX_JUMPSERVER_ASSETS_PER_PAGE as u32).contains(&query.page_size)
        || !valid_display_text(&query.search, 256)
        || (!query.node_id.is_empty() && !valid_resource_id(&query.node_id))
    {
        return Json(serde_json::json!({
            "ok": false,
            "error": "invalid JumpServer asset query"
        }));
    }
    let client_arc = match get_or_create_client(&query.base_url, &principal) {
        Ok(client) => client,
        Err(error) => return Json(serde_json::json!({ "ok": false, "error": error })),
    };
    let client = match tokio::time::timeout(JUMPSERVER_LOCK_TIMEOUT, client_arc.lock()).await {
        Ok(client) => client,
        Err(_) => {
            return Json(serde_json::json!({ "ok": false, "error": "JumpServer client is busy" }))
        }
    };
    match tokio::time::timeout(
        JUMPSERVER_OPERATION_TIMEOUT,
        client.get_assets(&query.search, &query.node_id, query.page, query.page_size),
    )
    .await
    {
        Ok(Ok((assets, total))) => Json(serde_json::json!({
            "ok": true, "assets": assets, "total": total, "page": query.page,
        })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e })),
        Err(_) => {
            Json(serde_json::json!({ "ok": false, "error": "JumpServer asset request timed out" }))
        }
    }
}

/// Get nodes: GET /api/jumpserver/nodes?base_url=...
#[derive(Deserialize)]
pub struct GetNodesQuery {
    pub base_url: String,
}

pub async fn get_nodes(
    Extension(principal): Extension<AuthPrincipal>,
    axum::extract::Query(query): axum::extract::Query<GetNodesQuery>,
) -> impl IntoResponse {
    let client_arc = match get_or_create_client(&query.base_url, &principal) {
        Ok(client) => client,
        Err(error) => return Json(serde_json::json!({ "ok": false, "error": error })),
    };
    let client = match tokio::time::timeout(JUMPSERVER_LOCK_TIMEOUT, client_arc.lock()).await {
        Ok(client) => client,
        Err(_) => {
            return Json(serde_json::json!({ "ok": false, "error": "JumpServer client is busy" }))
        }
    };
    match tokio::time::timeout(JUMPSERVER_OPERATION_TIMEOUT, client.get_nodes()).await {
        Ok(Ok(nodes)) => Json(serde_json::json!({ "ok": true, "nodes": nodes })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e })),
        Err(_) => {
            Json(serde_json::json!({ "ok": false, "error": "JumpServer node request timed out" }))
        }
    }
}

/// Get accounts: GET /api/jumpserver/accounts?base_url=...&asset_id=...
#[derive(Deserialize)]
pub struct GetAccountsQuery {
    pub base_url: String,
    pub asset_id: String,
}

pub async fn get_accounts(
    Extension(principal): Extension<AuthPrincipal>,
    axum::extract::Query(query): axum::extract::Query<GetAccountsQuery>,
) -> impl IntoResponse {
    if !valid_resource_id(&query.asset_id) {
        return Json(serde_json::json!({
            "ok": false,
            "error": "invalid JumpServer asset id"
        }));
    }
    let client_arc = match get_or_create_client(&query.base_url, &principal) {
        Ok(client) => client,
        Err(error) => return Json(serde_json::json!({ "ok": false, "error": error })),
    };
    let client = match tokio::time::timeout(JUMPSERVER_LOCK_TIMEOUT, client_arc.lock()).await {
        Ok(client) => client,
        Err(_) => {
            return Json(serde_json::json!({ "ok": false, "error": "JumpServer client is busy" }))
        }
    };
    match tokio::time::timeout(
        JUMPSERVER_OPERATION_TIMEOUT,
        client.get_accounts(&query.asset_id),
    )
    .await
    {
        Ok(Ok(accounts)) => Json(serde_json::json!({ "ok": true, "accounts": accounts })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e })),
        Err(_) => Json(
            serde_json::json!({ "ok": false, "error": "JumpServer account request timed out" }),
        ),
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

#[cfg(test)]
mod broker_tests {
    use super::*;

    #[test]
    fn authentication_responses_never_return_upstream_credentials() {
        let response = redact_auth_credential(AuthResponse {
            ok: true,
            token: Some("reusable-upstream-token".to_string()),
            mfa_required: None,
            mfa_choices: None,
            error: None,
        });
        assert!(response.ok);
        assert!(response.token.is_none());
    }
}
