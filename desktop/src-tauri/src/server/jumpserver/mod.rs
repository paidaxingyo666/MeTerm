//! JumpServer API client — mirrors Go `jumpserver/client.go`.
//!
//! Supports JumpServer v2/v3/v4 with automatic version detection and fallback.
//! The client handles:
//! - Authentication (username/password, API token, MFA)
//! - Asset listing with pagination and search
//! - Node tree traversal (zTree format for v2/v3, standard for v4)
//! - Account listing per asset
//! - Connection token creation (v4/v3/v2 format differences)
//! - Health check

mod client_pool;
pub(crate) mod credential_broker;
pub mod handler;
mod parsers;
mod resources;
pub mod ssh_session;

pub use client_pool::clear_client_pool;
use client_pool::{get_or_create_client, reset_client};
pub(crate) use client_pool::{remove_device_generation, remove_owner_generation};
use parsers::*;

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

const MAX_JUMPSERVER_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_JUMPSERVER_ASSETS_PER_PAGE: usize = 100;
const MAX_JUMPSERVER_NODES: usize = 5_000;
const MAX_JUMPSERVER_NODE_DEPTH: usize = 32;
const MAX_JUMPSERVER_NODE_REQUESTS: usize = 256;
const MAX_JUMPSERVER_ACCOUNTS: usize = 1_000;

pub(crate) fn valid_resource_id(value: &str) -> bool {
    (1..=256).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

pub(crate) fn valid_display_text(value: &str, max_bytes: usize) -> bool {
    value.len() <= max_bytes && !value.chars().any(char::is_control)
}

pub(crate) fn valid_bearer_token(value: &str) -> bool {
    !value.is_empty()
        && valid_display_text(value, 64 * 1024)
        && !value.chars().any(char::is_whitespace)
}

fn valid_secret_value(value: &str) -> bool {
    value.len() <= 64 * 1024 && !value.contains('\0')
}

fn normalized_auth_keyword(value: Option<&str>) -> Option<&'static str> {
    match value {
        Some("Bearer") | Some("bearer") => Some("Bearer"),
        Some("Token") | Some("token") => Some("Token"),
        _ => None,
    }
}

/// Read an upstream JSON response without allowing a compromised/misconfigured
/// JumpServer to make reqwest aggregate an unbounded body first.
async fn read_json_response(mut response: reqwest::Response) -> Result<serde_json::Value, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_JUMPSERVER_JSON_BYTES as u64)
    {
        return Err("JumpServer response exceeded the size limit".to_string());
    }
    let mut body = Vec::with_capacity(
        response
            .content_length()
            .unwrap_or(0)
            .min(MAX_JUMPSERVER_JSON_BYTES as u64) as usize,
    );
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "failed to read JumpServer response".to_string())?
    {
        let next_len = body
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| "JumpServer response exceeded the size limit".to_string())?;
        if next_len > MAX_JUMPSERVER_JSON_BYTES {
            return Err("JumpServer response exceeded the size limit".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| "invalid JumpServer JSON response".to_string())
}

/// JumpServer client.
pub struct JumpServerClient {
    http: reqwest::Client,
    base_url: String,
    token: Option<String>,
    /// "Bearer" or "Token" — determines Authorization header format (default "Bearer")
    keyword: String,
    csrf_token: Option<String>,
    org_id: Option<String>,
    saved_username: Option<String>,
    saved_password: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AuthRequest {
    pub base_url: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub org_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct TokenAuthRequest {
    pub base_url: String,
    pub token: String,
    #[serde(default)]
    pub org_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct MfaRequest {
    pub base_url: String,
    #[serde(rename = "type")]
    pub mfa_type: String,
    pub code: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AuthResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mfa_required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mfa_choices: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Asset {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub platform: serde_json::Value, // v2: string "Linux", v4: {"id":1,"name":"Linux"} — pass through to frontend
    #[serde(default)]
    pub protocols: Vec<serde_json::Value>,
    #[serde(default)]
    pub is_active: bool,
    #[serde(default)]
    pub comment: String,
    // v2 fields: hostname → name, ip → address
    #[serde(default)]
    pub hostname: String,
    #[serde(default)]
    pub ip: String,
}

/// v2/v3: platform is a string "Linux". v4: platform is {"id":..., "name":"Linux"}.
fn deserialize_platform<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let val = serde_json::Value::deserialize(d)?;
    match val {
        serde_json::Value::String(s) => Ok(s),
        serde_json::Value::Object(map) => Ok(map
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()),
        serde_json::Value::Null => Ok(String::new()),
        _ => Ok(val.to_string()),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub value: String,
    #[serde(default, rename = "parent")]
    pub parent_id: String,
    #[serde(default)]
    pub assets_amount: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub name: String,
    pub username: String,
    #[serde(default, alias = "alias")]
    pub alias: String,
}

/// Short-lived Koko credential. This type is deliberately not serializable:
/// it may only be consumed by the fixed Rust SSH/SFTP broker.
#[derive(Clone)]
pub struct ConnectionToken {
    pub id: String,
    pub token: String,
    pub secret: String,
}

#[derive(Clone)]
pub struct ConnectionTokenRequest {
    pub base_url: String,
    pub asset_id: String,
    pub account: String,
    pub account_name: String,
    pub account_alias: String,
    pub account_id: String,
    pub protocol: String,
}

/// Global proxy bypass flag — when true, all JumpServer HTTP requests bypass system proxy.
pub static BYPASS_PROXY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Validate and canonicalize the JumpServer API base URL before any credential-bearing request.
/// Credentials must never be sent over plaintext HTTP or to a URL containing userinfo/query data.
fn normalize_base_url(base_url: &str) -> Result<String, String> {
    let value = base_url.trim();
    if value.is_empty()
        || value
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        return Err("JumpServer URL is invalid".to_string());
    }
    let mut url =
        reqwest::Url::parse(value).map_err(|_| "JumpServer URL is invalid".to_string())?;
    if url.scheme() != "https" {
        return Err("JumpServer URL must use HTTPS".to_string());
    }
    if url.host_str().is_none_or(str::is_empty)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("JumpServer URL must not contain credentials, query, or fragment".to_string());
    }
    // Preserve an optional deployment subpath, but remove only trailing slashes because all API
    // calls append an absolute-looking path fragment to this base.
    let trimmed_path = url.path().trim_end_matches('/').to_string();
    url.set_path(&trimmed_path);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

/// Build a reqwest Client respecting the global proxy bypass setting. Certificate validation is
/// deliberately left at reqwest/rustls system-root defaults; accepting invalid certificates here
/// would expose JumpServer passwords, API tokens, session cookies, and connection credentials.
fn build_http_client(timeout_secs: u64) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        // Credential-bearing POST bodies must never be replayed to a different
        // origin via a 307/308 redirect. JumpServer API paths are explicit, so
        // treat every redirect as an error and let the caller fix base_url.
        .redirect(reqwest::redirect::Policy::none());
    if BYPASS_PROXY.load(std::sync::atomic::Ordering::Relaxed) {
        builder = builder.no_proxy();
    }
    builder
        .build()
        .map_err(|_| "failed to initialize secure JumpServer HTTP client".to_string())
}

impl JumpServerClient {
    pub fn new(base_url: &str) -> Result<Self, String> {
        let base_url = normalize_base_url(base_url)?;
        let mut builder = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .cookie_store(true)
            // See build_http_client: do not let redirects replay credentials
            // or authenticated requests to another origin.
            .redirect(reqwest::redirect::Policy::none());
        if BYPASS_PROXY.load(std::sync::atomic::Ordering::Relaxed) {
            builder = builder.no_proxy();
        }
        let http = builder
            .build()
            .map_err(|_| "failed to initialize secure JumpServer HTTP client".to_string())?;
        Ok(Self {
            http,
            base_url,
            token: None,
            keyword: "Bearer".to_string(),
            csrf_token: None,
            org_id: None,
            saved_username: None,
            saved_password: None,
        })
    }

    /// Whether we're in session-cookie-only auth mode (no token).
    fn is_session_auth(&self) -> bool {
        self.token.as_deref() == Some("__session__")
    }

    /// GET with cookie-only auth (no Authorization header). Used for JumpServer v2 session auth.
    /// Cookies are sent automatically by reqwest cookie_store.
    async fn do_get_cookie_only(&self, path: &str) -> Result<reqwest::Response, String> {
        let url = format!("{}{}", self.base_url, path);
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert("Accept", HeaderValue::from_static("application/json"));
        if let Some(ref org_id) = self.org_id {
            if !org_id.is_empty() {
                if let Ok(val) = HeaderValue::from_str(org_id) {
                    headers.insert("X-JMS-ORG", val);
                }
            }
        }
        self.http
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(|e| e.to_string())
    }

    /// Try multiple API paths in order (matches Go doGetMulti).
    /// On 401/403, retries with cookie-only auth before trying next path.
    /// Returns SESSION_EXPIRED:<base_url> if every response was 401/403 (no network errors).
    async fn do_get_multi(&self, paths: &[&str]) -> Result<(String, serde_json::Value), String> {
        let session_auth = self.is_session_auth();
        eprintln!("[jumpserver] do_get_multi: session_auth={}", session_auth);

        let mut saw_any_request = false;
        let mut all_auth_failed = true;

        for path in paths {
            let url = format!("{}{}", self.base_url, path);
            eprintln!("[jumpserver] trying GET {}", url);

            let resp = if session_auth {
                self.do_get_cookie_only(path).await
            } else {
                self.http
                    .get(&url)
                    .headers(self.auth_headers())
                    .send()
                    .await
                    .map_err(|e| e.to_string())
            };

            let r = match resp {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("[jumpserver] GET error: {}", e);
                    all_auth_failed = false;
                    continue;
                }
            };

            saw_any_request = true;
            let status = r.status().as_u16();
            eprintln!("[jumpserver] GET {} → {}", path, status);

            if r.status().is_success() {
                if let Ok(data) = read_json_response(r).await {
                    return Ok((path.to_string(), data));
                }
                all_auth_failed = false;
                continue;
            }

            if status == 401 || status == 403 {
                if !session_auth {
                    eprintln!("[jumpserver] 401/403, retrying with cookie-only...");
                    if let Ok(r2) = self.do_get_cookie_only(path).await {
                        if r2.status().is_success() {
                            if let Ok(data) = read_json_response(r2).await {
                                return Ok((path.to_string(), data));
                            }
                        }
                    }
                }
                continue;
            }

            all_auth_failed = false;
            continue;
        }

        if saw_any_request && all_auth_failed {
            Err(format!("SESSION_EXPIRED: {}", self.base_url))
        } else {
            Err("all API paths failed".to_string())
        }
    }

    /// Build auth headers. Cookies are managed automatically by reqwest cookie_store.
    fn auth_headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert("Accept", HeaderValue::from_static("application/json"));

        if let Some(ref token) = self.token {
            // __session__ = cookie-only auth, skip Authorization header
            if token != "__session__" {
                let kw = if self.keyword.is_empty() {
                    "Bearer"
                } else {
                    &self.keyword
                };
                if let Ok(val) = HeaderValue::from_str(&format!("{} {}", kw, token)) {
                    headers.insert(AUTHORIZATION, val);
                }
            }
        }
        // Don't manually set Cookie — reqwest cookie_store handles it automatically
        if let Some(ref org_id) = self.org_id {
            if !org_id.is_empty() {
                if let Ok(val) = HeaderValue::from_str(org_id) {
                    headers.insert("X-JMS-ORG", val);
                }
            }
        }
        headers
    }

    /// Authenticate with username/password.
    pub async fn authenticate(&mut self, req: &AuthRequest) -> AuthResponse {
        let url = format!("{}/api/v1/authentication/auth/", self.base_url);
        let body = serde_json::json!({
            "username": req.username,
            "password": req.password,
        });

        eprintln!("[jumpserver] POST {}", url);
        match self.http.post(&url).json(&body).send().await {
            Ok(resp) => {
                let status = resp.status();
                eprintln!("[jumpserver] auth HTTP status: {}", status);
                // Extract cookies from response
                self.extract_cookies(&resp);

                match read_json_response(resp).await {
                    Ok(data) => {
                        eprintln!("[jumpserver] authentication response received");

                        // MFA required: {"error": "mfa_required", "data": {"choices": [...]}}
                        // Matches Go: rawResp["error"] == "mfa_required"
                        if data.get("error").and_then(|e| e.as_str()) == Some("mfa_required") {
                            self.org_id = (!req.org_id.is_empty()).then(|| req.org_id.clone());
                            // Retain only while the MFA flow needs a re-auth.
                            self.saved_username = Some(req.username.clone());
                            self.saved_password = Some(req.password.clone());
                            let choices = data
                                .get("data")
                                .and_then(|d| d.get("choices"))
                                .and_then(|c| c.as_array())
                                .map(|arr| {
                                    arr.iter()
                                        .filter_map(|v| v.as_str())
                                        .filter(|value| valid_display_text(value, 64))
                                        .take(16)
                                        .map(String::from)
                                        .collect()
                                });
                            return AuthResponse {
                                ok: true,
                                token: None,
                                mfa_required: Some(true),
                                mfa_choices: choices,
                                error: None,
                            };
                        }

                        // Success: {"token": "xxx"}
                        if let Some(token) = data.get("token").and_then(|t| t.as_str()) {
                            if valid_bearer_token(token) {
                                self.token = Some(token.to_string());
                                self.org_id = (!req.org_id.is_empty()).then(|| req.org_id.clone());
                                if let Some(keyword) = normalized_auth_keyword(
                                    data.get("keyword").and_then(|value| value.as_str()),
                                ) {
                                    self.keyword = keyword.to_string();
                                }
                                self.clear_saved_credentials();
                                eprintln!("[jumpserver] authentication credential stored");
                                return AuthResponse {
                                    ok: true,
                                    token: Some(token.to_string()),
                                    mfa_required: None,
                                    mfa_choices: None,
                                    error: None,
                                };
                            }
                        }

                        // Error
                        self.clear_saved_credentials();
                        AuthResponse {
                            ok: false,
                            token: None,
                            mfa_required: None,
                            mfa_choices: None,
                            // Upstream error bodies may echo submitted fields.
                            // Never reflect them into the browser or logs.
                            error: Some("authentication failed".to_string()),
                        }
                    }
                    Err(e) => AuthResponse {
                        ok: false,
                        token: None,
                        mfa_required: None,
                        mfa_choices: None,
                        error: Some(e.to_string()),
                    },
                }
            }
            Err(e) => AuthResponse {
                ok: false,
                token: None,
                mfa_required: None,
                mfa_choices: None,
                error: Some(e.to_string()),
            },
        }
    }

    /// Authenticate with API token.
    pub async fn token_auth(&mut self, req: &TokenAuthRequest) -> AuthResponse {
        // Verify the token by calling a simple endpoint
        let url = format!("{}/api/v1/users/profile/", self.base_url);
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert("Accept", HeaderValue::from_static("application/json"));
        let keyword = if self.keyword == "Token" {
            "Token"
        } else {
            "Bearer"
        };
        let Ok(authorization) = HeaderValue::from_str(&format!("{} {}", keyword, req.token)) else {
            return AuthResponse {
                ok: false,
                token: None,
                mfa_required: None,
                mfa_choices: None,
                error: Some("invalid JumpServer token".to_string()),
            };
        };
        headers.insert(AUTHORIZATION, authorization);
        if !req.org_id.is_empty() {
            if let Ok(org_id) = HeaderValue::from_str(&req.org_id) {
                headers.insert("X-JMS-ORG", org_id);
            }
        }

        match self.http.get(&url).headers(headers).send().await {
            Ok(resp) if resp.status().is_success() => {
                self.token = Some(req.token.clone());
                self.org_id = (!req.org_id.is_empty()).then(|| req.org_id.clone());
                AuthResponse {
                    ok: true,
                    token: Some(req.token.clone()),
                    mfa_required: None,
                    mfa_choices: None,
                    error: None,
                }
            }
            Ok(resp) => {
                let status = resp.status();
                AuthResponse {
                    ok: false,
                    token: None,
                    mfa_required: None,
                    mfa_choices: None,
                    error: Some(format!("token auth failed: {}", status)),
                }
            }
            Err(e) => AuthResponse {
                ok: false,
                token: None,
                mfa_required: None,
                mfa_choices: None,
                error: Some(e.to_string()),
            },
        }
    }

    /// Submit MFA verification — matches Go SubmitMFA.
    /// After MFA, tries to extract token from response. If no token, re-authenticates
    /// with saved credentials (session should now skip MFA). Falls back to session auth.
    pub async fn submit_mfa(&mut self, req: &MfaRequest) -> AuthResponse {
        let url = format!("{}/api/v1/authentication/mfa/challenge/", self.base_url);
        let body = serde_json::json!({
            "type": req.mfa_type,
            "code": req.code,
        });

        let mut headers = self.auth_headers();
        if let Some(ref csrf) = self.csrf_token {
            if let Ok(val) = HeaderValue::from_str(csrf) {
                headers.insert("X-CSRFToken", val);
            }
        }

        match self
            .http
            .post(&url)
            .headers(headers)
            .json(&body)
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status();
                self.extract_cookies(&resp);

                if status.as_u16() >= 400 {
                    // 上游错误 body 可能回显认证字段，不写日志也不透传。
                    eprintln!("[jumpserver] MFA failed: HTTP {}", status);
                    return AuthResponse {
                        ok: false,
                        token: None,
                        mfa_required: None,
                        mfa_choices: None,
                        error: Some(format!("MFA verification failed (HTTP {})", status)),
                    };
                }

                match read_json_response(resp).await {
                    Ok(data) => {
                        eprintln!("[jumpserver] MFA response received");
                        let mut token = data
                            .get("token")
                            .and_then(|t| t.as_str())
                            .unwrap_or("")
                            .to_string();

                        // Try nested data.token (matches Go)
                        if token.is_empty() {
                            if let Some(nested) = data
                                .get("data")
                                .and_then(|d| d.get("token"))
                                .and_then(|t| t.as_str())
                            {
                                token = nested.to_string();
                            }
                        }

                        if valid_bearer_token(&token) {
                            self.token = Some(token.clone());
                            // Extract keyword from MFA response too
                            let kw = data.get("keyword").and_then(|k| k.as_str()).or_else(|| {
                                data.get("data")
                                    .and_then(|d| d.get("keyword"))
                                    .and_then(|k| k.as_str())
                            });
                            if let Some(keyword) = normalized_auth_keyword(kw) {
                                self.keyword = keyword.to_string();
                            }
                            self.clear_saved_credentials();
                            eprintln!("[jumpserver] MFA credential stored");
                            return AuthResponse {
                                ok: true,
                                token: Some(token),
                                mfa_required: None,
                                mfa_choices: None,
                                error: None,
                            };
                        }

                        // No token in MFA response — re-auth with saved credentials
                        // After MFA confirmation, the session should now return a token
                        eprintln!("[jumpserver] no token in MFA response, re-authenticating...");
                        if let (Some(user), Some(pass)) =
                            (self.saved_username.clone(), self.saved_password.clone())
                        {
                            match self.re_authenticate(&user, &pass).await {
                                Ok(re_token) if valid_bearer_token(&re_token) => {
                                    self.token = Some(re_token.clone());
                                    self.clear_saved_credentials();
                                    return AuthResponse {
                                        ok: true,
                                        token: Some(re_token),
                                        mfa_required: None,
                                        mfa_choices: None,
                                        error: None,
                                    };
                                }
                                _ => {
                                    eprintln!(
                                        "[jumpserver] re-auth failed, falling back to session auth"
                                    );
                                    self.activate_session_auth("MFA-fallback");
                                    self.clear_saved_credentials();
                                    return AuthResponse {
                                        ok: true,
                                        token: None,
                                        mfa_required: None,
                                        mfa_choices: None,
                                        error: None,
                                    };
                                }
                            }
                        } else {
                            self.activate_session_auth("MFA-fallback");
                            self.clear_saved_credentials();
                            return AuthResponse {
                                ok: true,
                                token: None,
                                mfa_required: None,
                                mfa_choices: None,
                                error: None,
                            };
                        }
                    }
                    Err(e) => AuthResponse {
                        ok: false,
                        token: None,
                        mfa_required: None,
                        mfa_choices: None,
                        error: Some(e.to_string()),
                    },
                }
            }
            Err(e) => AuthResponse {
                ok: false,
                token: None,
                mfa_required: None,
                mfa_choices: None,
                error: Some(e.to_string()),
            },
        }
    }

    /// Activate session-cookie-only auth (matches Go activateSessionAuth).
    fn activate_session_auth(&mut self, source: &str) {
        eprintln!("[jumpserver] activating session auth (source: {})", source);
        self.token = Some("__session__".to_string());
    }

    fn clear_saved_credentials(&mut self) {
        self.saved_username = None;
        self.saved_password = None;
    }

    /// Re-authenticate using existing session cookies (matches Go ReAuthenticate).
    /// After MFA, JumpServer should return a token on re-auth.
    async fn re_authenticate(&mut self, username: &str, password: &str) -> Result<String, String> {
        let url = format!("{}/api/v1/authentication/auth/", self.base_url);
        let body = serde_json::json!({
            "username": username,
            "password": password,
        });

        // Use existing cookies (session should now have MFA satisfied)
        let resp = self
            .http
            .post(&url)
            .headers(self.auth_headers())
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let data = read_json_response(resp).await?;
        eprintln!("[jumpserver] re-authentication response received");

        // Extract token and keyword from various formats
        let token = data
            .get("token")
            .and_then(|t| t.as_str())
            .filter(|token| valid_bearer_token(token))
            .or_else(|| {
                data.get("data")
                    .and_then(|d| d.get("token"))
                    .and_then(|t| t.as_str())
                    .filter(|token| valid_bearer_token(token))
            });
        let keyword = data
            .get("keyword")
            .and_then(|k| k.as_str())
            .and_then(|keyword| normalized_auth_keyword(Some(keyword)))
            .or_else(|| {
                data.get("data")
                    .and_then(|d| d.get("keyword"))
                    .and_then(|k| k.as_str())
                    .and_then(|keyword| normalized_auth_keyword(Some(keyword)))
            });

        if let Some(token) = token {
            if let Some(keyword) = keyword {
                self.keyword = keyword.to_string();
            }
            eprintln!("[jumpserver] re-authentication credential stored");
            return Ok(token.to_string());
        }
        Err("no token in re-auth response".to_string())
    }
}

impl JumpServerClient {
    /// Health check.
    pub async fn test_connection(base_url: &str) -> Result<(), String> {
        let base_url = normalize_base_url(base_url)?;
        let url = format!("{base_url}/api/health/");
        let client = build_http_client(10)?;

        let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(format!("health check failed: {}", resp.status()))
        }
    }

    fn extract_cookies(&mut self, resp: &reqwest::Response) {
        for cookie in resp.cookies() {
            if cookie.name() == "csrftoken"
                && !cookie.value().is_empty()
                && cookie.value().len() <= 4_096
                && HeaderValue::from_str(cookie.value()).is_ok()
            {
                self.csrf_token = Some(cookie.value().to_string());
            }
        }
    }
}

#[cfg(test)]
mod security_tests {
    use super::{
        normalize_assets, normalize_base_url, valid_bearer_token, valid_resource_id,
        validate_accounts, validate_ztree_input, Account, Asset,
    };

    #[test]
    fn jumpserver_base_url_requires_clean_https() {
        assert_eq!(
            normalize_base_url(" https://jump.example.com/root/ ").unwrap(),
            "https://jump.example.com/root"
        );
        for value in [
            "http://jump.example.com",
            "https://user:pass@jump.example.com",
            "https://jump.example.com/?token=secret",
            "https://jump.example.com/#fragment",
            "https://jump.example.com/ bad",
            "file:///etc/passwd",
            "",
        ] {
            assert!(normalize_base_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn resource_ids_and_bearer_tokens_are_bounded() {
        for value in ["asset-1", "node.example:22", "abc_DEF"] {
            assert!(valid_resource_id(value));
        }
        for value in ["", "../asset", "asset/id", "asset?id", "line\nbreak"] {
            assert!(!valid_resource_id(value), "{value:?}");
        }
        assert!(!valid_resource_id(&"a".repeat(257)));

        assert!(valid_bearer_token("opaque-token_value.1"));
        for value in ["", "two words", "line\nbreak", "tab\tvalue"] {
            assert!(!valid_bearer_token(value), "{value:?}");
        }
        assert!(!valid_bearer_token(&"x".repeat(64 * 1024 + 1)));
    }

    #[test]
    fn upstream_asset_and_account_fields_are_validated() {
        let asset = Asset {
            id: "asset-1".to_string(),
            name: "server".to_string(),
            address: "10.0.0.1".to_string(),
            platform: serde_json::json!("Linux"),
            protocols: vec![serde_json::json!({"name": "ssh"})],
            is_active: true,
            comment: String::new(),
            hostname: String::new(),
            ip: String::new(),
        };
        assert!(normalize_assets(vec![asset.clone()]).is_ok());
        let mut invalid_asset = asset;
        invalid_asset.id = "../../etc/passwd".to_string();
        assert!(normalize_assets(vec![invalid_asset]).is_err());

        let account = Account {
            id: "account-1".to_string(),
            name: "root".to_string(),
            username: "root".to_string(),
            alias: String::new(),
        };
        assert!(validate_accounts(vec![account.clone()]).is_ok());
        let mut invalid_account = account;
        invalid_account.username = "root\nforged".to_string();
        assert!(validate_accounts(vec![invalid_account]).is_err());
    }

    #[test]
    fn ztree_input_is_bounded_before_recursive_fetches() {
        let valid = serde_json::json!([{
            "id": "node-1",
            "name": "Production",
            "title": "Production (2)",
            "pId": "",
            "isParent": true,
            "meta": {"data": {"id": "node-1", "key": "prod", "value": "prod"}}
        }]);
        assert!(validate_ztree_input(valid.as_array().unwrap()).is_ok());

        let invalid = serde_json::json!([{
            "id": "../../internal",
            "isParent": true
        }]);
        assert!(validate_ztree_input(invalid.as_array().unwrap()).is_err());
    }
}
