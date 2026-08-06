//! HTTP API handlers — mirrors Go `api/handler.go`.
//!
//! All handlers receive `Arc<ServerState>` via axum Extension.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Extension, Path, Query};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};

use super::auth::AuthPrincipal;
use super::events::DesktopEvent;
use super::executor::Executor;
use super::ServerState;

mod master;
pub use master::request_master;

#[cfg(test)]
use super::relay_http::relay_metadata_allowed;

fn stale_owner_response() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({ "error": "owner credential revoked" })),
    )
}

/// Format SystemTime as ISO 8601 string (e.g. "2026-03-23T15:04:05Z").
fn format_system_time(t: &std::time::SystemTime) -> String {
    match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => {
            let secs = d.as_secs();
            let (days, rem) = (secs / 86400, secs % 86400);
            let (hours, rem) = (rem / 3600, rem % 3600);
            let (mins, s) = (rem / 60, rem % 60);

            // Days since epoch → year/month/day (simplified Gregorian)
            let mut y = 1970i64;
            let mut remaining_days = days as i64;
            loop {
                let days_in_year = if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
                    366
                } else {
                    365
                };
                if remaining_days < days_in_year {
                    break;
                }
                remaining_days -= days_in_year;
                y += 1;
            }
            let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
            let month_days = [
                31,
                if leap { 29 } else { 28 },
                31,
                30,
                31,
                30,
                31,
                31,
                30,
                31,
                30,
                31,
            ];
            let mut m = 0usize;
            while m < 12 && remaining_days >= month_days[m] {
                remaining_days -= month_days[m];
                m += 1;
            }
            format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
                y,
                m + 1,
                remaining_days + 1,
                hours,
                mins,
                s
            )
        }
        Err(_) => "1970-01-01T00:00:00Z".to_string(),
    }
}

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
    (
        status,
        Json(ErrorResponse {
            error: msg.to_string(),
        }),
    )
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
    /// 显式新建镜像会话(M7):置 true 则给 PTY 注入 METERM_AUTO_CLAUDE=1,
    /// rc 守卫在加载完成后自动跑 `claude`,新会话开箱即镜像。缺省 false(零行为变化)。
    /// serde 默认忽略未知字段,旧桌面收手机发的 auto_claude 只是忽略(退化普通终端),前后兼容。
    #[serde(default)]
    pub auto_claude: bool,
}

fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}

/// 在基础 hook envs 之上按 `auto_claude` 追加 `METERM_AUTO_CLAUDE=1` 标志(显式新建镜像会话用)。
///
/// 抽成纯函数便于单测——`create_session` 需真起 PTY 难以直接测。
/// `auto_claude=false` 时零行为变化(不追加任何 env),保证零 token / 前后兼容。
fn apply_auto_claude_env(
    mut envs: Vec<(String, String)>,
    auto_claude: bool,
) -> Vec<(String, String)> {
    if auto_claude {
        envs.push(("METERM_AUTO_CLAUDE".to_string(), "1".to_string()));
    }
    envs
}

pub async fn create_session(
    Extension(state): Extension<Arc<ServerState>>,
    body: Option<Json<CreateSessionRequest>>,
) -> impl IntoResponse {
    eprintln!("[handler] create_session called, body={:?}", body.is_some());
    let (shell, cwd, cols, rows, auto_claude) = if let Some(Json(req)) = body {
        (req.shell, req.cwd, req.cols, req.rows, req.auto_claude)
    } else {
        // 无 body 分支:auto_claude=false(退化普通终端)。
        (String::new(), String::new(), 80, 24, false)
    };

    let session = state.session_manager.create();

    // agent 终端镜像地基(M1):给 local-shell 注入 hook 环境变量。
    // 每会话生成随机 secret 登记注册表,组装 3 个 METERM_* env 透传给 PTY。
    // 所有 local-shell 会话都注入(零副作用:不起 claude 就没 hook 回报);SSH 不注入。
    let secret = super::generate_token();
    state
        .hook_secrets
        .register(session.id.clone(), secret.clone());
    let envs = super::hook_secret::hook_envs(&session.id, state.port, &secret);
    // 显式新建镜像会话(M7):auto_claude=true 时追加 METERM_AUTO_CLAUDE=1,
    // rc 守卫在加载完成后自动跑 claude;false 时零行为变化(不追加)。
    let envs = apply_auto_claude_env(envs, auto_claude);

    // Start the terminal via LocalShellExecutor
    let executor =
        super::executor::local::LocalShellExecutor::new(shell, cwd, cols, rows).with_envs(envs);
    match executor.start().await {
        Ok(terminal) => {
            // Start terminal I/O loop (read output → broadcast, receive input → write)
            super::session::Session::start_terminal(session.clone(), terminal).await;
        }
        Err(e) => {
            eprintln!("[meterm] terminal start failed: {}", e);
            // 终端未起来,原子回收临时可见的 session 与 hook secret。
            state.session_manager.discard_unstarted(&session.id);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("terminal start failed: {}", e) })),
            );
        }
    }

    // 会话创建成功,通知 presence 订阅者(手机端)实时刷新列表,替代轮询。
    state.event_bus.publish(DesktopEvent::SessionsChanged);

    (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "id": session.id,
            "created_at": format_system_time(&session.created_at_system),
            "state": session.state_string(),
        })),
    )
}

pub async fn list_sessions(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
) -> impl IntoResponse {
    let mut sessions = state.session_manager.list();
    sessions.retain(|session| {
        super::device_access::can_access_session(&state.authenticator, &principal, session)
    });
    // 稳定排序(创建时间升序):HashMap 迭代无序,3s 轮询下手机列表会跳动
    sessions.sort_by_key(|s| s.created_at_system);
    let list: Vec<serde_json::Value> = sessions
        .iter()
        .map(|s| {
            // SSH 目标(host/user/port):供手机建的 SSH 会话在桌面侧回填 Drawer 连接信息
            //(书签主机名、初始路径等);非 SSH 会话为空串/0。
            let (ssh_host, ssh_username, ssh_port): (String, String, u16) = s
                .ssh_config
                .lock()
                .unwrap()
                .as_ref()
                .map(|c| (c.host.clone(), c.username.clone(), c.port))
                .unwrap_or_default();
            serde_json::json!({
                "id": s.id,
                "state": s.state_string(),
                "clients": s.connected_client_count(),
                "connected_clients": s.connected_client_count(),
                "master": s.master(),
                "executor_type": s.executor_type.lock().unwrap().clone(),
                "has_local_client": s.has_connected_loopback_client(),
                "created_at": format_system_time(&s.created_at_system),
                "title": s.title.lock().unwrap().clone(),
                "last_activity": format_system_time(&s.last_output_at.lock().unwrap()),
                "ssh_host": ssh_host,
                "ssh_username": ssh_username,
                "ssh_port": ssh_port,
                // agent 镜像标记(方案甲 M3,wire 契约冻结、M8 手机已按此解码):
                // agents 表有 entry 且 kind==Mirror 才 true(方案 B 的 Acp 会话为 false)。
                "agent_mirror": super::agent::hook::agent_mirror_flag(
                    state.agents.get(&s.id).map(|e| e.kind())
                ),
            })
        })
        .collect();
    Json(serde_json::json!({ "sessions": list }))
}

pub async fn get_session(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.session_manager.get(&id) {
        Some(s)
            if !super::device_access::can_access_session(&state.authenticator, &principal, &s) =>
        {
            (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({ "error": "device scope required" })),
            )
        }
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
                "executor_type": s.executor_type.lock().unwrap().clone(),
                "has_local_client": s.has_connected_loopback_client(),
                "created_at": format_system_time(&s.created_at_system),
                // agent 镜像标记(方案甲 M3):与 list_sessions 同一映射。
                "agent_mirror": super::agent::hook::agent_mirror_flag(
                    state.agents.get(&s.id).map(|e| e.kind())
                ),
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
    Extension(principal): Extension<AuthPrincipal>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(session) = state.session_manager.get(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        );
    };
    if !super::device_access::can_access_session(&state.authenticator, &principal, &session) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "device scope required" })),
        );
    }
    match state.session_manager.delete(&id) {
        Ok(()) => {
            // 会话销毁,清除其 hook secret(agent 镜像 M1);非 local-shell 会话无登记则 no-op。
            state.hook_secrets.remove(&id);
            // 清除镜像状态并取消 tailer(agent 镜像 M3);无镜像则 no-op。
            state.mirrors.remove_and_cancel(&id);
            // 作废该会话在飞审批(P2 审批桥):sender drop → hook handler 空响应回落 TUI。
            state.permission_bridge.drain_session(&id);
            // 会话删除成功,通知 presence 订阅者(手机端)实时刷新列表。
            state.event_bus.publish(DesktopEvent::SessionsChanged);
            (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
        }
        Err(e) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------

/// Return only the host-key fields that are part of the public SSH API.
///
/// The SSH transport serializes a host-key challenge into its error string so
/// it can cross the executor boundary.  Never forward the parsed object as-is:
/// keeping an explicit allow-list prevents a future transport field (for
/// example a path or proxy diagnostic) from becoming remotely observable.
pub(super) fn sanitized_host_key_challenge(error: &str) -> Option<serde_json::Value> {
    let parsed = serde_json::from_str::<serde_json::Value>(error).ok()?;
    let error = parsed.get("error")?.as_str()?;
    if !matches!(error, "host_key_unknown" | "host_key_mismatch") {
        return None;
    }
    let hostname = parsed.get("hostname")?.as_str()?;
    let fingerprint = parsed.get("fingerprint")?.as_str()?;
    let key_type = parsed.get("key_type")?.as_str()?;
    Some(serde_json::json!({
        "error": error,
        "hostname": hostname,
        "fingerprint": fingerprint,
        "key_type": key_type,
    }))
}

/// Collapse transport/authentication diagnostics into a small public error
/// vocabulary.  The caller may log `error` locally, but must send only the
/// returned static code to HTTP clients.
pub(super) fn classify_ssh_connect_error(error: &str) -> (StatusCode, &'static str) {
    let normalized = error.to_ascii_lowercase();

    // Check this first: authentication and channel timeouts also contain auth
    // or credential keywords, but callers need one consistent timeout result.
    if normalized.contains("timed out") || normalized.contains("timeout") {
        return (StatusCode::GATEWAY_TIMEOUT, "ssh_connect_timeout");
    }

    if normalized.contains("cannot determine home directory")
        || normalized.contains("private key path ")
        || normalized.contains("read private key ")
        || normalized.contains("invalid key:")
        || normalized.contains("no usable ssh identity found")
    {
        return (StatusCode::UNPROCESSABLE_ENTITY, "credential_unavailable");
    }

    if normalized.contains("authentication failed")
        || normalized.contains("password auth:")
        || normalized.contains("key auth:")
        || normalized.contains("permission denied")
    {
        // The desktop API credential remains valid; it is the upstream SSH
        // authentication that failed, so do not return HTTP 401 here.
        return (StatusCode::BAD_GATEWAY, "ssh_auth_failed");
    }

    (StatusCode::BAD_GATEWAY, "ssh_connect_failed")
}

pub async fn create_ssh_session(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let config = match parse_ssh_config(&body) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[ssh] rejected invalid request: {}", e);
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "invalid_ssh_config" })),
            );
        }
    };
    if let Err(error) = validate_direct_ssh_config(&principal, &config) {
        eprintln!("[ssh] rejected direct credential source: {}", error);
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "credential_source_forbidden" })),
        );
    }
    connect_and_start_ssh_session(state, principal, config).await
}

/// 共享的"建会话 + connect(含未知主机密钥判定)+ 起 I/O + 后台 SFTP"流程。
/// `create_ssh_session`(临时连接)与 `ssh_saved_session::create_ssh_session_from_saved`
/// (已存连接中转,见同名兄弟模块)复用同一套逻辑,保证两者的成功、主机密钥挑战
/// 与稳定失败码完全一致。`pub(super)`——只在 `server` 模块内跨文件复用,不对外暴露。
pub(super) async fn connect_and_start_ssh_session(
    state: Arc<ServerState>,
    principal: AuthPrincipal,
    config: super::terminal::ssh::SshConfig,
) -> (StatusCode, Json<serde_json::Value>) {
    // Do not publish a Session until the complete SSH handshake/auth/channel
    // setup has succeeded.  A pre-registered `created` session is observable by
    // the desktop remote-session poller; on any failure it used to become a
    // ghost tab and retain a clone of the credential bundle indefinitely.
    let terminal = match tokio::time::timeout(
        super::terminal::ssh_limits::SSH_SESSION_CONNECT_TIMEOUT,
        super::terminal::ssh::SshTerminal::connect(&config, 80, 24),
    )
    .await
    {
        Ok(Ok(terminal)) => terminal,
        Ok(Err(e)) => {
            if let Some(challenge) = sanitized_host_key_challenge(&e) {
                return (StatusCode::CONFLICT, Json(challenge));
            }
            eprintln!("[ssh] connect failed: {}", e);
            let (status, code) = classify_ssh_connect_error(&e);
            return (status, Json(serde_json::json!({ "error": code })));
        }
        Err(_) => {
            return (
                StatusCode::GATEWAY_TIMEOUT,
                Json(serde_json::json!({ "error": "ssh_connect_timeout" })),
            );
        }
    };

    // Commit the now-usable terminal to the session registry in one short,
    // infallible sequence. Creator/type/config are installed before any client
    // can discover the id.
    let pending_session = state
        .session_manager
        .prepare_connected_ssh_for_principal(&principal, config.clone());
    let session = pending_session.session();

    {
        let ssh_handle = terminal.session_handle.clone();
        let sftp_config = config.clone();
        *session.ssh_exec_handle.lock().await = Some(Box::new(ssh_handle.clone()));

        // Start terminal I/O immediately (fast path — no SFTP blocking)
        super::session::Session::start_terminal(session.clone(), Box::new(terminal)).await;

        // No async cancellation point is allowed between publishing the
        // session and returning its id. Until this line PendingSession::drop
        // cancels the private session and no list/poller can observe it.
        let session = pending_session.commit();

        // Initialize SFTP in background — does not block terminal usability.
        // Same dual-strategy + fallback as the Tauri create_ssh_session path:
        // multiplex on the existing channel for JumpServer; otherwise prefer a
        // dedicated session but fall back to multiplex when the server refuses
        // a second auth (e.g. private-key rate limiting, MaxAuthTries=1).
        let session_bg = session.clone();
        let multiplex = sftp_config.multiplex_sftp;
        let ssh_handle_for_sftp = ssh_handle.clone();
        tokio::spawn(async move {
            let result = if multiplex {
                super::terminal::ssh::SshTerminal::init_sftp(&ssh_handle_for_sftp).await
            } else {
                match super::terminal::ssh::SshTerminal::connect_sftp(&sftp_config).await {
                    Ok(sftp) => Ok(sftp),
                    Err(dedicated_err) => {
                        eprintln!(
                            "[ssh] dedicated SFTP failed ({}), falling back to multiplexed channel",
                            dedicated_err
                        );
                        eprintln!(
                                "[ssh] sftp diag: auth_method={:?} has_private_key={} has_password={} has_passphrase={} trusted_fp={} proxy={}",
                                sftp_config.auth_method,
                                !sftp_config.private_key.is_empty(),
                                !sftp_config.password.is_empty(),
                                !sftp_config.passphrase.is_empty(),
                                !sftp_config.trusted_fingerprint.is_empty(),
                                if sftp_config.proxy_type.is_empty() { "none" } else { &sftp_config.proxy_type },
                            );
                        match super::terminal::ssh::SshTerminal::init_sftp(&ssh_handle_for_sftp)
                            .await
                        {
                            Ok(sftp) => {
                                eprintln!("[ssh] multiplexed SFTP fallback succeeded");
                                Ok(sftp)
                            }
                            Err(mux_err) => Err(format!(
                                "dedicated SFTP failed: {}; multiplex fallback also failed: {}",
                                dedicated_err, mux_err
                            )),
                        }
                    }
                }
            };
            match result {
                Ok(sftp_client) => {
                    *session_bg.sftp.lock().unwrap() = Some(sftp_client);
                }
                Err(e) => {
                    eprintln!("[ssh] SFTP setup failed: {}", e);
                    // This value is later sent over the session WebSocket by
                    // the file-policy guard. Keep the raw diagnostic in the
                    // local log only; paths/proxy details must not cross WS.
                    *session_bg.sftp_init_error.lock().unwrap() =
                        Some("sftp_init_failed".to_string());
                }
            }
        });
    }

    // SSH 会话创建成功 —— 该函数是 create_ssh_session(临时连接)与
    // ssh_saved_session::create_ssh_session_from_saved(已存连接)共享的
    // 成功出口,这里发一次即覆盖两条入口,避免重复发布。
    state.event_bus.publish(DesktopEvent::SessionsChanged);

    (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "id": session.id,
            "created_at": format_system_time(&session.created_at_system),
            "state": session.state_string(),
            "executor_type": "ssh",
        })),
    )
}

pub async fn test_ssh_connection(
    Extension(principal): Extension<AuthPrincipal>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let config = match parse_ssh_config(&body) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[ssh] rejected invalid test request: {}", e);
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "ok": false,
                    "error": "invalid_ssh_config"
                })),
            );
        }
    };
    if let Err(error) = validate_direct_ssh_config(&principal, &config) {
        eprintln!("[ssh] rejected direct test credential source: {}", error);
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "ok": false,
                "error": "credential_source_forbidden"
            })),
        );
    }

    match super::terminal::ssh::test_connection(&config).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))),
        Err(e) => {
            if let Some(challenge) = sanitized_host_key_challenge(&e) {
                return (StatusCode::OK, Json(challenge));
            }
            eprintln!("[ssh] connection test failed: {}", e);
            let (status, code) = classify_ssh_connect_error(&e);
            (
                status,
                Json(serde_json::json!({ "ok": false, "error": code })),
            )
        }
    }
}

pub(super) fn validate_direct_ssh_config(
    principal: &AuthPrincipal,
    config: &super::terminal::ssh::SshConfig,
) -> Result<(), &'static str> {
    if matches!(principal, AuthPrincipal::Device { .. })
        && config.auth_method == super::terminal::ssh::SshAuthMethod::Key
        && !config.private_key.trim().starts_with("-----BEGIN ")
    {
        return Err(
            "paired devices must provide an inline private key; desktop key paths and automatic keys are unavailable",
        );
    }
    Ok(())
}

fn parse_ssh_config(body: &serde_json::Value) -> Result<super::terminal::ssh::SshConfig, String> {
    let host = body
        .get("host")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let username = body
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if host.is_empty() || username.is_empty() {
        return Err("host and username are required".to_string());
    }
    Ok(super::terminal::ssh::SshConfig {
        host,
        port: body.get("port").and_then(|v| v.as_u64()).unwrap_or(22) as u16,
        username,
        auth_method: super::terminal::ssh::SshAuthMethod::from_str_lossy(
            body.get("auth_method")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
        ),
        password: body
            .get("password")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        private_key: body
            .get("private_key")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        passphrase: body
            .get("passphrase")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        trusted_fingerprint: body
            .get("trusted_fingerprint")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        disable_hook: body
            .get("skip_shell_hook")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        multiplex_sftp: body
            .get("multiplex_sftp")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        proxy_type: body
            .get("proxy_type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        proxy_host: body
            .get("proxy_host")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        proxy_port: body.get("proxy_port").and_then(|v| v.as_u64()).unwrap_or(0) as u16,
        proxy_username: body
            .get("proxy_username")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        proxy_password: body
            .get("proxy_password")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

pub async fn set_private(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let private = body
        .get("private")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let Ok(_owner) = state.authenticator.guard_owner_principal(&principal) else {
        return stale_owner_response();
    };
    match state.session_manager.get(&id) {
        Some(session) => {
            let kicked = session.set_private(private);
            (
                StatusCode::OK,
                Json(serde_json::json!({ "ok": true, "kicked": kicked })),
            )
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        ),
    }
}

// ---------------------------------------------------------------------------
// Clients / devices
// ---------------------------------------------------------------------------

pub async fn list_clients(Extension(state): Extension<Arc<ServerState>>) -> impl IntoResponse {
    let clients = state.session_manager.list_all_clients();
    Json(serde_json::json!({ "clients": clients }))
}

pub async fn kick_client(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Path((session_id, client_id)): Path<(String, String)>,
) -> impl IntoResponse {
    let Ok(_owner) = state.authenticator.guard_owner_principal(&principal) else {
        return stale_owner_response();
    };
    match state.session_manager.get(&session_id) {
        Some(session) => {
            let (addr, found) = session.kick_client(&client_id);
            if found {
                // Check if ban=true in query params (simplified)
                (
                    StatusCode::OK,
                    Json(serde_json::json!({ "ok": true, "remote_addr": addr })),
                )
            } else {
                (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({ "error": "client not found" })),
                )
            }
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "session not found" })),
        ),
    }
}

pub async fn list_devices(Extension(state): Extension<Arc<ServerState>>) -> impl IntoResponse {
    let devices = state.session_manager.list_devices();
    Json(serde_json::json!({ "devices": devices }))
}

pub async fn kick_device(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(ip): Path<String>,
) -> impl IntoResponse {
    let Ok(_owner) = state.authenticator.guard_owner_principal(&principal) else {
        return stale_owner_response();
    };
    // IP kick is session-only; credential revocation is keyed by device_id elsewhere.
    let count = state.session_manager.kick_by_ip(&ip);
    (
        StatusCode::OK,
        Json(serde_json::json!({ "ok": true, "kicked": count })),
    )
}

// IP ban management

pub async fn list_bans(Extension(state): Extension<Arc<ServerState>>) -> impl IntoResponse {
    let bans = state.ban_manager.list();
    Json(serde_json::json!({ "banned_ips": bans }))
}

pub async fn ban_ip(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let ip = body.get("ip").and_then(|v| v.as_str()).unwrap_or("");
    let reason = body.get("reason").and_then(|v| v.as_str()).unwrap_or("");
    let Ok(_owner) = state.authenticator.guard_owner_principal(&principal) else {
        return stale_owner_response();
    };
    match state.ban_manager.ban(ip, reason) {
        Ok(()) => {
            // Also kick the banned IP
            state.session_manager.kick_by_ip(ip);
            (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

pub async fn unban_ip(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(ip): Path<String>,
) -> impl IntoResponse {
    let Ok(_owner) = state.authenticator.guard_owner_principal(&principal) else {
        return stale_owner_response();
    };
    let found = state.ban_manager.unban(&ip);
    (
        StatusCode::OK,
        Json(serde_json::json!({ "ok": true, "found": found })),
    )
}

// ---------------------------------------------------------------------------
// 手机推送注册(终端通知 Phase 3 地基):登记 APNs token + 通知加密公钥。
// ---------------------------------------------------------------------------

/// `POST /api/push/register` —— 手机上报 APNs device token + 通知加密公钥(`notif_pub`,
/// hex 或 base64,见 `push_crypto::parse_pub_hex_or_b64`)。
///
/// 请求体 `{ device_id, apns_token, notif_pub, env }`,四个字段均为必填字符串;
/// `notif_pub` 解析失败或任意字段缺失/为空 → 400。`apns_token` 非纯十六进制/长度不符,
/// 或 `env` 不是 `sandbox`/`production` 之一 → 400。只允许与 `device_id` 一致的
/// Device principal；Owner 即使来自本机也返回 403。成功写入 `state.push` 后返回 200。
fn push_device_generation(
    principal: &AuthPrincipal,
    requested_device_id: &str,
) -> Result<uuid::Uuid, &'static str> {
    match principal {
        AuthPrincipal::Device {
            device_id,
            generation,
            ..
        } if device_id == requested_device_id => Ok(*generation),
        AuthPrincipal::Device { .. } => Err("device identity mismatch"),
        AuthPrincipal::Owner { .. } => Err("device credential required"),
    }
}

pub async fn register_push(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let device_id = body.get("device_id").and_then(|v| v.as_str()).unwrap_or("");
    let apns_token = body
        .get("apns_token")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let notif_pub_raw = body.get("notif_pub").and_then(|v| v.as_str()).unwrap_or("");
    let env = body.get("env").and_then(|v| v.as_str()).unwrap_or("");

    let principal_generation = match push_device_generation(&principal, device_id) {
        Ok(generation) => generation,
        Err(error) => {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({ "error": error })),
            )
        }
    };

    if device_id.is_empty() || apns_token.is_empty() || notif_pub_raw.is_empty() || env.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": "device_id, apns_token, notif_pub, env are all required"
            })),
        );
    }

    if !super::push_crypto::is_valid_apns_token(apns_token) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "invalid apns_token" })),
        );
    }
    if !super::push_crypto::is_valid_env(env) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "invalid env" })),
        );
    }

    let Some(notif_pub) = super::push_crypto::parse_pub_hex_or_b64(notif_pub_raw) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                serde_json::json!({ "error": "notif_pub must be 32 bytes, hex or base64 encoded" }),
            ),
        );
    };

    match state.push.register_if_current_generation(
        &state.authenticator,
        device_id,
        apns_token,
        notif_pub,
        env,
        principal_generation,
    ) {
        super::push_registry::PushRegistrationOutcome::Registered => {}
        super::push_registry::PushRegistrationOutcome::CredentialRevoked => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "credential revoked" })),
            )
        }
        super::push_registry::PushRegistrationOutcome::NotificationKeyMismatch => {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({
                    "error": "notification key changed; remove and pair this device again"
                })),
            )
        }
    }

    (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
#[path = "handlers_tests.rs"]
mod tests;
