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

pub mod handler;

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE, COOKIE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

/// JumpServer client.
pub struct JumpServerClient {
    http: reqwest::Client,
    base_url: String,
    token: Option<String>,
    /// "Bearer" or "Token" — determines Authorization header format (default "Bearer")
    keyword: String,
    cookies: Option<String>,
    csrf_token: Option<String>,
    org_id: Option<String>,
    saved_username: Option<String>,
    saved_password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthRequest {
    pub base_url: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub org_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenAuthRequest {
    pub base_url: String,
    pub token: String,
    #[serde(default)]
    pub org_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MfaRequest {
    pub base_url: String,
    #[serde(rename = "type")]
    pub mfa_type: String,
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub platform: serde_json::Value,  // v2: string "Linux", v4: {"id":1,"name":"Linux"} — pass through to frontend
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
        serde_json::Value::Object(map) => Ok(
            map.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string()
        ),
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionToken {
    pub id: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionTokenRequest {
    pub base_url: String,
    pub asset_id: String,
    pub account: String,
    #[serde(default)]
    pub account_name: String,
    #[serde(default)]
    pub account_alias: String,
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub protocol: String,
}

/// Client pool — caches JumpServerClient instances by base_url.
static CLIENT_POOL: std::sync::LazyLock<std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<JumpServerClient>>>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// Get or create a cached JumpServer client for the given base URL.
pub fn get_or_create_client(base_url: &str) -> Arc<tokio::sync::Mutex<JumpServerClient>> {
    let key = base_url.trim_end_matches('/').to_string();
    let mut pool = CLIENT_POOL.lock().unwrap();
    pool.entry(key.clone())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(JumpServerClient::new(&key))))
        .clone()
}

impl JumpServerClient {
    pub fn new(base_url: &str) -> Self {
        let http = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .timeout(std::time::Duration::from_secs(30))
            .cookie_store(true)
            .build()
            .unwrap_or_default();
        Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            token: None,
            keyword: "Bearer".to_string(),
            cookies: None,
            csrf_token: None,
            org_id: None,
            saved_username: None,
            saved_password: None,
        }
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
        self.http.get(&url).headers(headers).send().await.map_err(|e| e.to_string())
    }

    /// Try multiple API paths in order (matches Go doGetMulti).
    /// On 401/403, retries with cookie-only auth before trying next path.
    async fn do_get_multi(&self, paths: &[&str]) -> Result<(String, serde_json::Value), String> {
        let session_auth = self.is_session_auth();
        eprintln!("[jumpserver] do_get_multi: session_auth={} token={:?}", session_auth, self.token.as_deref().map(|t| &t[..t.len().min(20)]));

        for path in paths {
            let url = format!("{}{}", self.base_url, path);
            eprintln!("[jumpserver] trying GET {}", url);

            let resp = if session_auth {
                self.do_get_cookie_only(path).await
            } else {
                self.http.get(&url).headers(self.auth_headers()).send().await.map_err(|e| e.to_string())
            };

            let r = match resp {
                Ok(r) => r,
                Err(e) => { eprintln!("[jumpserver] GET error: {}", e); continue; }
            };

            let status = r.status().as_u16();
            eprintln!("[jumpserver] GET {} → {}", path, status);

            if r.status().is_success() {
                if let Ok(data) = r.json::<serde_json::Value>().await {
                    return Ok((path.to_string(), data));
                }
                continue;
            }

            if status == 401 || status == 403 {
                if !session_auth {
                    eprintln!("[jumpserver] 401/403, retrying with cookie-only...");
                    if let Ok(r2) = self.do_get_cookie_only(path).await {
                        if r2.status().is_success() {
                            if let Ok(data) = r2.json::<serde_json::Value>().await {
                                return Ok((path.to_string(), data));
                            }
                        }
                    }
                }
                continue;
            }

            // 404/500 → try next path
            continue;
        }
        Err("all API paths failed".to_string())
    }

    /// Build auth headers. Cookies are managed automatically by reqwest cookie_store.
    fn auth_headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert("Accept", HeaderValue::from_static("application/json"));

        if let Some(ref token) = self.token {
            // __session__ = cookie-only auth, skip Authorization header
            if token != "__session__" {
                let kw = if self.keyword.is_empty() { "Bearer" } else { &self.keyword };
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
        self.base_url = req.base_url.trim_end_matches('/').to_string();
        if !req.org_id.is_empty() {
            self.org_id = Some(req.org_id.clone());
        }
        // Save credentials for re-auth after MFA (matches Go)
        self.saved_username = Some(req.username.clone());
        self.saved_password = Some(req.password.clone());

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

                match resp.json::<serde_json::Value>().await {
                    Ok(data) => {
                        eprintln!("[jumpserver] auth response body: {}", data);

                        // MFA required: {"error": "mfa_required", "data": {"choices": [...]}}
                        // Matches Go: rawResp["error"] == "mfa_required"
                        if data.get("error").and_then(|e| e.as_str()) == Some("mfa_required") {
                            let choices = data.get("data")
                                .and_then(|d| d.get("choices"))
                                .and_then(|c| c.as_array())
                                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect());
                            return AuthResponse { ok: true, token: None, mfa_required: Some(true), mfa_choices: choices, error: None };
                        }

                        // Success: {"token": "xxx"}
                        if let Some(token) = data.get("token").and_then(|t| t.as_str()) {
                            if !token.is_empty() {
                                self.token = Some(token.to_string());
                                if let Some(kw) = data.get("keyword").and_then(|k| k.as_str()) {
                                    if !kw.is_empty() { self.keyword = kw.to_string(); }
                                }
                                eprintln!("[jumpserver] auth token set: keyword={} token={}...", self.keyword, &token[..token.len().min(16)]);
                                return AuthResponse { ok: true, token: Some(token.to_string()), mfa_required: None, mfa_choices: None, error: None };
                            }
                        }

                        // Error
                        let error = data.get("msg")
                            .or(data.get("detail"))
                            .or(data.get("error"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("authentication failed");
                        AuthResponse { ok: false, token: None, mfa_required: None, mfa_choices: None, error: Some(error.to_string()) }
                    }
                    Err(e) => AuthResponse { ok: false, token: None, mfa_required: None, mfa_choices: None, error: Some(e.to_string()) },
                }
            }
            Err(e) => AuthResponse { ok: false, token: None, mfa_required: None, mfa_choices: None, error: Some(e.to_string()) },
        }
    }

    /// Authenticate with API token.
    pub async fn token_auth(&mut self, req: &TokenAuthRequest) -> AuthResponse {
        self.base_url = req.base_url.trim_end_matches('/').to_string();
        self.token = Some(req.token.clone());
        if !req.org_id.is_empty() {
            self.org_id = Some(req.org_id.clone());
        }

        // Verify the token by calling a simple endpoint
        let url = format!("{}/api/v1/users/profile/", self.base_url);
        let headers = self.auth_headers();

        match self.http.get(&url).headers(headers).send().await {
            Ok(resp) if resp.status().is_success() => {
                AuthResponse { ok: true, token: Some(req.token.clone()), mfa_required: None, mfa_choices: None, error: None }
            }
            Ok(resp) => {
                let status = resp.status();
                AuthResponse { ok: false, token: None, mfa_required: None, mfa_choices: None, error: Some(format!("token auth failed: {}", status)) }
            }
            Err(e) => AuthResponse { ok: false, token: None, mfa_required: None, mfa_choices: None, error: Some(e.to_string()) },
        }
    }

    /// Submit MFA verification — matches Go SubmitMFA.
    /// After MFA, tries to extract token from response. If no token, re-authenticates
    /// with saved credentials (session should now skip MFA). Falls back to session auth.
    pub async fn submit_mfa(&mut self, req: &MfaRequest) -> AuthResponse {
        self.base_url = req.base_url.trim_end_matches('/').to_string();

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

        match self.http.post(&url).headers(headers).json(&body).send().await {
            Ok(resp) => {
                let status = resp.status();
                self.extract_cookies(&resp);

                if status.as_u16() >= 400 {
                    let text = resp.text().await.unwrap_or_default();
                    eprintln!("[jumpserver] MFA failed HTTP {}: {}", status, text);
                    return AuthResponse { ok: false, token: None, mfa_required: None, mfa_choices: None, error: Some(format!("MFA verification failed (HTTP {}): {}", status, text)) };
                }

                match resp.json::<serde_json::Value>().await {
                    Ok(data) => {
                        eprintln!("[jumpserver] MFA response: {}", data);
                        let mut token = data.get("token").and_then(|t| t.as_str()).unwrap_or("").to_string();

                        // Try nested data.token (matches Go)
                        if token.is_empty() {
                            if let Some(nested) = data.get("data").and_then(|d| d.get("token")).and_then(|t| t.as_str()) {
                                token = nested.to_string();
                            }
                        }

                        if !token.is_empty() {
                            self.token = Some(token.clone());
                            // Extract keyword from MFA response too
                            let kw = data.get("keyword").and_then(|k| k.as_str())
                                .or_else(|| data.get("data").and_then(|d| d.get("keyword")).and_then(|k| k.as_str()));
                            if let Some(kw) = kw { if !kw.is_empty() { self.keyword = kw.to_string(); } }
                            eprintln!("[jumpserver] MFA token set: keyword={} token={}...", self.keyword, &token[..token.len().min(16)]);
                            return AuthResponse { ok: true, token: Some(token), mfa_required: None, mfa_choices: None, error: None };
                        }

                        // No token in MFA response — re-auth with saved credentials
                        // After MFA confirmation, the session should now return a token
                        eprintln!("[jumpserver] no token in MFA response, re-authenticating...");
                        if let (Some(user), Some(pass)) = (self.saved_username.clone(), self.saved_password.clone()) {
                            match self.re_authenticate(&user, &pass).await {
                                Ok(re_token) if !re_token.is_empty() => {
                                    self.token = Some(re_token.clone());
                                    return AuthResponse { ok: true, token: Some(re_token), mfa_required: None, mfa_choices: None, error: None };
                                }
                                _ => {
                                    eprintln!("[jumpserver] re-auth failed, falling back to session auth");
                                    self.activate_session_auth("MFA-fallback");
                                    return AuthResponse { ok: true, token: None, mfa_required: None, mfa_choices: None, error: None };
                                }
                            }
                        } else {
                            self.activate_session_auth("MFA-fallback");
                            return AuthResponse { ok: true, token: None, mfa_required: None, mfa_choices: None, error: None };
                        }
                    }
                    Err(e) => AuthResponse { ok: false, token: None, mfa_required: None, mfa_choices: None, error: Some(e.to_string()) },
                }
            }
            Err(e) => AuthResponse { ok: false, token: None, mfa_required: None, mfa_choices: None, error: Some(e.to_string()) },
        }
    }

    /// Activate session-cookie-only auth (matches Go activateSessionAuth).
    fn activate_session_auth(&mut self, source: &str) {
        eprintln!("[jumpserver] activating session auth (source: {})", source);
        self.token = Some("__session__".to_string());
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
        let resp = self.http.post(&url)
            .headers(self.auth_headers())
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let data = resp.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
        eprintln!("[jumpserver] re-auth response: {}", data);

        // Extract token and keyword from various formats
        let token = data.get("token").and_then(|t| t.as_str()).filter(|t| !t.is_empty())
            .or_else(|| data.get("data").and_then(|d| d.get("token")).and_then(|t| t.as_str()).filter(|t| !t.is_empty()));
        let keyword = data.get("keyword").and_then(|k| k.as_str()).filter(|k| !k.is_empty())
            .or_else(|| data.get("data").and_then(|d| d.get("keyword")).and_then(|k| k.as_str()).filter(|k| !k.is_empty()));

        if let Some(token) = token {
            if let Some(kw) = keyword {
                self.keyword = kw.to_string();
            }
            eprintln!("[jumpserver] re-auth token set: keyword={} token={}...", self.keyword, &token[..token.len().min(16)]);
            return Ok(token.to_string());
        }
        Err("no token in re-auth response".to_string())
    }

    /// Get user assets with pagination and search. Matches Go GetUserAssets/GetNodeAssets.
    pub async fn get_assets(
        &self,
        search: &str,
        node_id: &str,
        page: u32,
        page_size: u32,
    ) -> Result<(Vec<Asset>, u32), String> {
        let offset = if page > 0 { (page - 1) * page_size } else { 0 };
        let mut query = format!("?offset={}&limit={}", offset, page_size);
        if !search.is_empty() {
            query.push_str(&format!("&search={}", urlencoding::encode(search)));
        }

        // Favorite is a virtual node — fetch favorite IDs then filter (matches Go getFavoriteAssets)
        if node_id == "favorite" {
            return self.get_favorite_assets(search, page, page_size).await;
        }

        let paths = if !node_id.is_empty() {
            // Node-specific: ALL paths get node_id in query (matches Go: q.Set("node_id", nodeID))
            let q = format!("{}&node_id={}", query, urlencoding::encode(node_id));
            vec![
                format!("/api/v1/perms/users/self/nodes/{}/assets/{}", node_id, q),
                format!("/api/v1/perms/users/nodes/{}/assets/{}", node_id, q),
                format!("/api/v1/perms/users/self/assets/{}", q),
            ]
        } else {
            // All assets
            vec![
                format!("/api/v1/perms/users/self/assets/{}", query),
                format!("/api/v1/perms/users/assets/{}", query),
            ]
        };
        let path_refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();

        match self.do_get_multi(&path_refs).await {
            Ok((path, data)) => {
                eprintln!("[jumpserver] get_assets response from {}: keys={:?} is_array={}",
                    path,
                    data.as_object().map(|o| o.keys().collect::<Vec<_>>()),
                    data.is_array());
                if let Some(results) = data.get("results") {
                    if let Some(first) = results.as_array().and_then(|a| a.first()) {
                        eprintln!("[jumpserver] first asset keys: {:?}", first.as_object().map(|o| o.keys().collect::<Vec<_>>()));
                        eprintln!("[jumpserver] first asset platform: {:?}", first.get("platform"));
                    }
                }
                parse_asset_response(data)
            }
            Err(e) => Err(e),
        }
    }

    /// Get node tree. Matches Go GetNodes — fetches /children/tree/ then recursively loads children.
    pub async fn get_nodes(&self) -> Result<Vec<Node>, String> {
        let paths = [
            "/api/v1/perms/users/self/nodes/children/tree/?limit=1000",
            "/api/v1/perms/users/nodes/children/tree/?limit=1000",
            "/api/v1/perms/users/self/nodes/?limit=1000",
            "/api/v1/perms/users/nodes/?limit=1000",
        ];

        match self.do_get_multi(&paths).await {
            Ok((_, data)) => {
                if let Some(arr) = data.as_array() {
                    if !arr.is_empty() {
                        let is_ztree = arr[0].get("pId").is_some()
                            || arr[0].get("title").is_some()
                            || arr[0].get("isParent").is_some();
                        if is_ztree {
                            // Recursive fetch children (matches Go fetchTreeNodesRecursive)
                            let mut all_nodes = parse_ztree_nodes(arr);
                            let mut seen: std::collections::HashSet<String> = arr.iter()
                                .filter_map(|n| n.get("id").and_then(|v| v.as_str()).map(String::from))
                                .collect();

                            for item in arr {
                                let is_parent = item.get("isParent").and_then(|v| v.as_bool()).unwrap_or(false);
                                let tree_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                if is_parent && !tree_id.is_empty() {
                                    let children = self.fetch_child_nodes(tree_id, &mut seen).await;
                                    all_nodes.extend(children);
                                }
                            }
                            return Ok(all_nodes);
                        }
                    }
                }
                parse_node_response(data)
            }
            Err(e) => Err(e),
        }
    }

    /// Fetch favorite assets. Matches Go getFavoriteAssets.
    async fn get_favorite_assets(&self, search: &str, _page: u32, _page_size: u32) -> Result<(Vec<Asset>, u32), String> {
        // Get favorite asset IDs
        let fav_paths = ["/api/v1/assets/favorite-assets/", "/api/v1/assets/favorites/"];
        let fav_ids: Vec<String> = match self.do_get_multi(&fav_paths).await {
            Ok((_, data)) => {
                if let Some(arr) = data.as_array() {
                    arr.iter().filter_map(|v| v.get("asset").and_then(|a| a.as_str()).map(String::from)).collect()
                } else { Vec::new() }
            }
            Err(_) => Vec::new(),
        };
        if fav_ids.is_empty() { return Ok((Vec::new(), 0)); }

        // Fetch all assets and filter by favorite IDs (avoid recursion by calling do_get_multi directly)
        let query = format!("?offset=0&limit=1000{}", if !search.is_empty() { format!("&search={}", urlencoding::encode(search)) } else { String::new() });
        let asset_paths = [
            format!("/api/v1/perms/users/self/assets/{}", query),
            format!("/api/v1/perms/users/assets/{}", query),
        ];
        let ap: Vec<&str> = asset_paths.iter().map(|s| s.as_str()).collect();
        let (all_assets, _) = match self.do_get_multi(&ap).await {
            Ok((_, data)) => parse_asset_response(data)?,
            Err(e) => return Err(e),
        };
        let fav_set: std::collections::HashSet<&str> = fav_ids.iter().map(|s| s.as_str()).collect();
        let matched: Vec<Asset> = all_assets.into_iter().filter(|a| fav_set.contains(a.id.as_str())).collect();
        let total = matched.len() as u32;
        Ok((matched, total))
    }

    /// Recursively fetch child nodes. Matches Go fetchChildNodes.
    async fn fetch_child_nodes(&self, tree_id: &str, seen: &mut std::collections::HashSet<String>) -> Vec<Node> {
        let paths = [
            format!("/api/v1/perms/users/self/nodes/children/tree/?key={}", urlencoding::encode(tree_id)),
            format!("/api/v1/perms/users/nodes/children/tree/?key={}", urlencoding::encode(tree_id)),
        ];
        let path_refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();

        let data = match self.do_get_multi(&path_refs).await {
            Ok((_, d)) => d,
            Err(_) => return Vec::new(),
        };

        let arr = match data.as_array() {
            Some(a) => a,
            None => return Vec::new(),
        };

        // Filter already-seen nodes
        let new_items: Vec<&serde_json::Value> = arr.iter().filter(|item| {
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
            !id.is_empty() && seen.insert(id.to_string())
        }).collect();

        if new_items.is_empty() { return Vec::new(); }

        let new_arr: Vec<serde_json::Value> = new_items.iter().map(|v| (*v).clone()).collect();
        let mut result = parse_ztree_nodes(&new_arr);

        // Recurse for children with isParent=true
        for item in &new_items {
            let is_parent = item.get("isParent").and_then(|v| v.as_bool()).unwrap_or(false);
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if is_parent && !id.is_empty() {
                let grandchildren = Box::pin(self.fetch_child_nodes(id, seen)).await;
                result.extend(grandchildren);
            }
        }

        result
    }

    /// Get accounts for an asset. Matches Go GetAssetAccounts:
    /// Strategy 1: dedicated accounts endpoints (v2/v3)
    /// Strategy 2: v4 asset detail → permed_accounts field
    pub async fn get_accounts(&self, asset_id: &str) -> Result<Vec<Account>, String> {
        // Strategy 1: accounts sub-endpoints
        let paths = [
            format!("/api/v1/perms/users/self/assets/{}/accounts/", asset_id),
            format!("/api/v1/perms/users/assets/{}/system-users/", asset_id),
            format!("/api/v1/perms/users/assets/{}/accounts/", asset_id),
        ];
        let path_refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();

        if let Ok((_, data)) = self.do_get_multi(&path_refs).await {
            // Direct array
            if let Ok(accounts) = serde_json::from_value::<Vec<Account>>(data.clone()) {
                if !accounts.is_empty() { return Ok(accounts); }
            }
            // Paginated {results: [...]}
            if let Some(results) = data.get("results") {
                if let Ok(accounts) = serde_json::from_value::<Vec<Account>>(results.clone()) {
                    if !accounts.is_empty() { return Ok(accounts); }
                }
            }
        }

        // Strategy 2: v4 asset detail → permed_accounts (matches Go getAccountsFromAssetDetail)
        eprintln!("[jumpserver] accounts sub-endpoint failed, trying v4 asset detail for {}", asset_id);
        let detail_paths = [
            format!("/api/v1/perms/users/self/assets/{}/", asset_id),
            format!("/api/v1/perms/users/my/assets/{}/", asset_id),
        ];
        let dp: Vec<&str> = detail_paths.iter().map(|s| s.as_str()).collect();

        match self.do_get_multi(&dp).await {
            Ok((_, data)) => {
                eprintln!("[jumpserver] asset detail keys: {:?}", data.as_object().map(|o| o.keys().collect::<Vec<_>>()));
                // Extract permed_accounts
                if let Some(permed) = data.get("permed_accounts").and_then(|v| v.as_array()) {
                    let accounts: Vec<Account> = permed.iter().filter_map(|v| {
                        serde_json::from_value::<Account>(v.clone()).ok()
                    }).collect();
                    if !accounts.is_empty() { return Ok(accounts); }
                }
                // Try accounts field
                if let Some(accts) = data.get("accounts").and_then(|v| v.as_array()) {
                    let accounts: Vec<Account> = accts.iter().filter_map(|v| {
                        serde_json::from_value::<Account>(v.clone()).ok()
                    }).collect();
                    if !accounts.is_empty() { return Ok(accounts); }
                }
                Err("no accounts found in asset detail".to_string())
            }
            Err(e) => Err(format!("asset detail failed: {}", e)),
        }
    }

    /// Create a connection token. Matches Go CreateConnectionToken exactly:
    /// tries multiple account identifiers × multiple body formats.
    pub async fn create_connection_token(&self, req: &ConnectionTokenRequest) -> Result<ConnectionToken, String> {
        let protocol = if req.protocol.is_empty() { "ssh" } else { &req.protocol };

        // Collect unique account identifiers (matches Go priority order)
        let mut seen = std::collections::HashSet::new();
        let mut account_names = Vec::new();
        for name in [&req.account_alias, &req.account_name, &req.account, &req.account_id] {
            if !name.is_empty() && seen.insert(name.clone()) {
                account_names.push(name.clone());
            }
        }

        // Build request bodies: v4 (with connect_method), v3 (without), v2 (system_user)
        let mut bodies = Vec::new();
        for acct in &account_names {
            bodies.push(serde_json::json!({"asset": req.asset_id, "account": acct, "protocol": protocol, "connect_method": "web_cli"}));
        }
        for acct in &account_names {
            bodies.push(serde_json::json!({"asset": req.asset_id, "account": acct, "protocol": protocol}));
        }
        if !req.account_id.is_empty() {
            bodies.push(serde_json::json!({"asset": req.asset_id, "system_user": req.account_id, "protocol": protocol}));
        }

        let url = format!("{}/api/v1/authentication/connection-token/", self.base_url);
        let mut last_err = String::from("no account identifiers");

        for body in &bodies {
            eprintln!("[jumpserver] creating connection token: {}", body);
            match self.http.post(&url).headers(self.auth_headers()).json(body).send().await {
                Ok(resp) if resp.status().is_success() => {
                    match resp.json::<serde_json::Value>().await {
                        Ok(data) => {
                            eprintln!("[jumpserver] connection token response: {}", data);
                            // Extract token from various field names (v2/v3/v4)
                            let id = data.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let mut token = data.get("token").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            if token.is_empty() {
                                token = data.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            }
                            if token.is_empty() && !id.is_empty() {
                                token = id.clone();
                            }
                            let secret = data.get("secret").and_then(|v| v.as_str()).unwrap_or("").to_string();

                            if !token.is_empty() {
                                return Ok(ConnectionToken { id, token, secret });
                            }
                            last_err = "empty connection token".to_string();
                        }
                        Err(e) => { last_err = e.to_string(); }
                    }
                }
                Ok(resp) => {
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    eprintln!("[jumpserver] connection token {} {}: {}", status, url, &text[..text.len().min(200)]);
                    last_err = format!("HTTP {}: {}", status, &text[..text.len().min(100)]);
                }
                Err(e) => { last_err = e.to_string(); }
            }
        }

        Err(format!("Failed to create connection token: {}", last_err))
    }

    /// Health check.
    pub async fn test_connection(base_url: &str) -> Result<(), String> {
        let url = format!("{}/api/health/", base_url.trim_end_matches('/'));
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;

        let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            Ok(())
        } else {
            Err(format!("health check failed: {}", resp.status()))
        }
    }

    fn extract_cookies(&mut self, resp: &reqwest::Response) {
        let mut cookies = Vec::new();
        for cookie in resp.cookies() {
            cookies.push(format!("{}={}", cookie.name(), cookie.value()));
            if cookie.name() == "csrftoken" {
                self.csrf_token = Some(cookie.value().to_string());
            }
        }
        if !cookies.is_empty() {
            self.cookies = Some(cookies.join("; "));
        }
    }
}

// ---------------------------------------------------------------------------
// Response parsers (handle v2/v3/v4 format differences)
// ---------------------------------------------------------------------------

fn parse_asset_response(data: serde_json::Value) -> Result<(Vec<Asset>, u32), String> {
    eprintln!("[jumpserver] parse_asset_response: keys={:?}", data.as_object().map(|o| o.keys().collect::<Vec<_>>()));

    // Paginated: { results: [...], count: N }
    if let Some(results) = data.get("results") {
        let total = data.get("count").and_then(|c| c.as_u64()).unwrap_or(0) as u32;
        match serde_json::from_value::<Vec<Asset>>(results.clone()) {
            Ok(assets) => return Ok((normalize_assets(assets), total)),
            Err(e) => {
                eprintln!("[jumpserver] parse results array failed: {}", e);
                // Try parsing first element to see what fields exist
                if let Some(first) = results.as_array().and_then(|a| a.first()) {
                    eprintln!("[jumpserver] first asset keys: {:?}", first.as_object().map(|o| o.keys().collect::<Vec<_>>()));
                }
                // Fallback: return empty with total
                return Ok((Vec::new(), total));
            }
        }
    }
    // Direct array
    if data.is_array() {
        match serde_json::from_value::<Vec<Asset>>(data.clone()) {
            Ok(assets) => {
                let total = assets.len() as u32;
                return Ok((normalize_assets(assets), total));
            }
            Err(e) => eprintln!("[jumpserver] parse direct array failed: {}", e),
        }
    }
    // Nested { data: [...] }
    if let Some(data_inner) = data.get("data") {
        let assets: Vec<Asset> = serde_json::from_value(data_inner.clone()).unwrap_or_default();
        let total = assets.len() as u32;
        return Ok((normalize_assets(assets), total));
    }
    eprintln!("[jumpserver] unexpected format, raw: {}", &data.to_string()[..data.to_string().len().min(500)]);
    Err("unexpected asset response format".to_string())
}

/// Parse zTree format nodes. Matches Go parseZTreeNodes exactly:
/// - meta.data.id (UUID) → Node.id (for asset queries)
/// - pId → Node.parent_id (for tree building by frontend)
/// - title "(N)" → assets_amount
fn parse_ztree_nodes(arr: &[serde_json::Value]) -> Vec<Node> {
    arr.iter().filter_map(|item| {
        let tree_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let pid = item.get("pId").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let mut name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if name.is_empty() { name = title.clone(); }

        let mut assets_amount = 0u32;
        if let Some(idx) = title.rfind(" (") {
            if let Some(end) = title[idx+2..].find(')') {
                if let Ok(n) = title[idx+2..idx+2+end].parse::<u32>() {
                    assets_amount = n;
                    if name == title { name = title[..idx].to_string(); }
                }
            }
        }

        // meta.data.id = UUID for asset queries, meta.data.key/value for tree
        let meta_data = item.get("meta").and_then(|m| m.get("data"));
        let node_id = meta_data.and_then(|d| d.get("id")).and_then(|v| v.as_str())
            .filter(|s| !s.is_empty()).unwrap_or(&tree_id).to_string();
        let key = meta_data.and_then(|d| d.get("key")).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let value = meta_data.and_then(|d| d.get("value")).and_then(|v| v.as_str()).unwrap_or("").to_string();

        if node_id.is_empty() && name.is_empty() { return None; }

        Some(Node { id: node_id, name, key, value, parent_id: pid, assets_amount })
    }).collect()
}

fn normalize_assets(mut assets: Vec<Asset>) -> Vec<Asset> {
    for asset in &mut assets {
        // v2 compatibility: hostname → name, ip → address
        if asset.name.is_empty() && !asset.hostname.is_empty() {
            asset.name = asset.hostname.clone();
        }
        if asset.address.is_empty() && !asset.ip.is_empty() {
            asset.address = asset.ip.clone();
        }
    }
    assets
}

/// Parse standard node response. Returns flat list with parent_id (frontend builds tree).
fn parse_node_response(data: serde_json::Value) -> Result<Vec<Node>, String> {
    // Standard array
    if let Ok(nodes) = serde_json::from_value::<Vec<Node>>(data.clone()) {
        if !nodes.is_empty() { return Ok(nodes); }
    }
    // Paginated { results: [...] }
    if let Some(results) = data.get("results") {
        if let Ok(nodes) = serde_json::from_value::<Vec<Node>>(results.clone()) {
            return Ok(nodes);
        }
    }
    // zTree fallback
    if let Some(arr) = data.as_array() {
        return Ok(parse_ztree_nodes(arr));
    }
    Err("unexpected node response format".to_string())
}
