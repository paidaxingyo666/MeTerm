//! In-process HTTP/WebSocket server — replaces the Go sidecar.
//!
//! The server is started inside the Tauri process during `setup()`.
//! It exposes the same HTTP API and WebSocket endpoints that the Go
//! `meterm-server` binary did, so the TypeScript frontend keeps working
//! without any changes.

pub mod agent;
pub mod auth;
mod auth_body;
pub mod ban;
pub mod connections;
#[cfg(all(
    debug_assertions,
    feature = "development-mobile-control",
    target_os = "macos"
))]
pub(crate) mod dev_relay_config;
mod device_access;
pub mod device_admin;
pub mod device_auth;
pub mod discover;
pub mod dispatch;
pub mod encoding;
pub mod events;
pub mod executor;
pub mod file_handler;
pub mod file_search;
pub mod files_http;
pub mod git_handlers;
pub mod handlers;
pub mod hook_secret;
pub mod jumpserver;
pub mod lan_access;
pub mod osc_filter;
pub mod pairing;
pub mod pairing_http;
pub mod pop;
pub(crate) mod private_file;
pub mod protocol;
pub mod proxy;
pub mod push_crypto;
pub mod push_dispatch;
pub mod push_registry;
pub mod recording;
pub mod relay_capability;
pub mod relay_client;
mod relay_credentials;
mod relay_http;
pub mod relay_renewal;
mod relay_renewal_preface;
pub mod secret_vault;
pub mod server_info;
pub mod session;
pub mod ssh_connections_http;
pub mod ssh_saved_session;
pub mod terminal;
pub mod tls;
mod tls_key_vault;
mod transport;
pub mod web_embed;
pub mod ws;

use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Arc;

use axum::routing::{any, delete, get, post, put};
use axum::{middleware, Router};
use tokio_util::sync::CancellationToken;
use tower_http::cors::{AllowOrigin, CorsLayer};

use auth::Authenticator;
use ban::BanManager;
use connections::ConnectionRegistry;
use discover::DiscoveryManager;
use events::{EventBus, PresenceRegistry};
use hook_secret::HookSecretRegistry;
use pairing::PairingManager;
use push_registry::PushRegistry;
use session::manager::SessionManager;
use session::SessionConfig;

/// Configuration for the server, mirrors Go's CLI flags.
pub struct ServerConfig {
    pub session_ttl: std::time::Duration,
    pub reconnect_grace: std::time::Duration,
    pub ring_buffer_size: usize,
    pub log_dir: String,
    pub verbose: bool,
    /// token 持久化文件(app 数据目录下);空 = 每次启动随机(旧行为)。
    /// 有值时跨重启复用 token,已配对手机不因电脑重启而失效。
    pub token_file: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            session_ttl: std::time::Duration::from_secs(300),
            reconnect_grace: std::time::Duration::from_secs(60),
            ring_buffer_size: 256 * 1024,
            log_dir: String::new(),
            verbose: false,
            token_file: String::new(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct DeviceGenerationCleanup {
    pub disconnected: usize,
    pub presence_disconnected: usize,
    pub push_removed: usize,
}

/// Core shared state — replaces the old `MeTermProcess` (sidecar manager).
pub struct ServerState {
    pub port: u16,
    pub lan_port: AtomicU16,
    pub ready: AtomicBool,
    pub proxy_handle: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub proxy_cancel: std::sync::Mutex<Option<CancellationToken>>,
    pub config: ServerConfig,
    pub session_manager: Arc<SessionManager>,
    pub authenticator: Arc<Authenticator>,
    pub ban_manager: Arc<BanManager>,
    pub pairing_manager: Arc<PairingManager>,
    /// Metadata-only bindings for sessions created by the fixed JumpServer
    /// broker. Koko connection credentials never enter this registry.
    pub(crate) jumpserver_sessions: jumpserver::ssh_session::JumpServerSessionRegistry,
    /// SSH 连接同步的元数据注册表(密钥另存钥匙串,见 `secret_vault`)。
    pub connections: Arc<ConnectionRegistry>,
    pub discovery_manager: Option<DiscoveryManager>,
    /// When true, all outgoing HTTP requests bypass system proxy (direct connection).
    pub bypass_proxy: AtomicBool,
    /// Backend-authoritative direct-LAN gate, discovery state, persistence and
    /// per-generation cancellation for accepted remote sockets.
    pub(crate) lan_access: lan_access::LanAccessControl,
    /// Custom device name for LAN sharing (empty = OS hostname).
    pub device_name: std::sync::Mutex<String>,
    /// 稳定设备 ID(UUID),跨重启/换端口/换 IP 不变——LAN 重发现与未来中继按此路由。
    pub device_id: String,
    /// 自签 TLS 证书指纹(SHA256 小写 hex);随 mDNS TXT(`fp`)/ 配对负载 /`/api/info` 下发,
    /// 供手机钉死信任(设计稿 §4)。无 TLS(如 dummy / 无 state_dir 且生成失败)时为空串。
    pub cert_fp: String,
    /// 中继基址(如 `wss://relay.example.com:8443`),随 `/api/info` 下发给已认证手机,
    /// 使手机零配置自动接入远程中继;手机只获得绑定设备身份的 scoped capability。
    /// 仅当中继已启用(`RelayConfig.enabled`)时非空;未启用/未配置时为空串。
    pub relay_url: String,
    /// 中继自签证书叶子指纹(SHA256 小写 hex),供手机钉死信任中继连接。逻辑同 `relay_url`。
    pub relay_cert_fp: String,
    /// 中继登记/HMAC 密钥。只保存于 OS 凭据库与桌面进程内存,
    /// 绝不经 API/IPC/二维码返回;手机拿到的是其派生 capability。
    pub(crate) relay_register_token: String,
    /// 桌面级事件总线(终端通知 Phase 1):各会话把通知性事件 / 会话增删事件投递到此,
    /// presence WS(`/ws-events`,后续任务接入)订阅后转发给手机。
    pub event_bus: EventBus,
    /// presence 客户端注册表:记录当前在线的 presence 连接,供后续 P3 推送判定用。
    pub presence: PresenceRegistry,
    /// 手机推送注册表(终端通知 Phase 3):`device_id -> APNs token + 通知加密公钥`,
    /// 经 `/api/push/register` 写入,供后续后台加密推送任务读取。
    pub push: PushRegistry,
    /// agent 会话注册表(agent 聊天 P1-T2):`session_id -> AgentEntry`(托管的
    /// AcpClient + 下行帧历史 + fan-out 任务)。也是「某会话是不是 agent 会话」的唯一真相。
    pub agents: agent::AcpAgentManager,
    /// hook secret 注册表(agent 终端镜像 M1):`session_id -> secret`。local-shell 会话
    /// 创建时随机生成 secret 注入 PTY env,并登记于此;M3 的 hook 回报端点凭此常量时间校验。
    pub hook_secrets: HookSecretRegistry,
    /// 镜像状态注册表(agent 终端镜像 M3):`PTY session_id -> 镜像状态`(claude 会话身份 +
    /// transcript tailer 柄)。每 PTY 会话至多一个镜像 entry;claude 换会话只换 tailer 不换 entry。
    pub mirrors: agent::MirrorRegistry,
    /// 审批桥 pending 注册表(P2):`request_id -> 在飞审批`。PermissionRequest hook 同步
    /// 阻塞挂此,手机 0x52 决策经 upstream 回投;超时/claude 退出自清,回落 TUI 弹窗。
    pub permission_bridge: agent::PermissionBridge,
}

impl ServerState {
    pub fn port(&self) -> u16 {
        self.port
    }

    /// 稳定设备 ID,见 `device_id` 字段注释。
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// 自签 TLS 证书指纹(SHA256 小写 hex),见 `cert_fp` 字段注释。空串表示未启用 TLS。
    pub fn cert_fp(&self) -> &str {
        &self.cert_fp
    }

    /// 中继基址,见 `relay_url` 字段注释。空串表示中继未启用。
    pub fn relay_url(&self) -> &str {
        &self.relay_url
    }

    /// 中继自签证书指纹,见 `relay_cert_fp` 字段注释。空串表示中继未启用。
    pub fn relay_cert_fp(&self) -> &str {
        &self.relay_cert_fp
    }

    pub fn lan_port(&self) -> u16 {
        self.lan_port.load(Ordering::Relaxed)
    }

    pub fn set_lan_port(&self, port: u16) {
        self.lan_port.store(port, Ordering::Relaxed);
    }

    pub fn is_running(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    pub fn token(&self) -> Option<String> {
        Some(self.authenticator.get_token())
    }

    pub fn update_token(&self, new_token: String) -> Result<(), String> {
        let retired_generation = self.authenticator.set_token(new_token)?;
        self.disconnect_owner_generation(retired_generation);
        Ok(())
    }

    pub(crate) fn update_token_for_owner(
        &self,
        expected_generation: uuid::Uuid,
        new_token: String,
    ) -> Result<(), auth::OwnerMutationError> {
        let retired_generation = self
            .authenticator
            .set_token_if_generation(expected_generation, new_token)?;
        self.disconnect_owner_generation(retired_generation);
        Ok(())
    }

    pub(crate) fn revoke_all_for_owner(
        &self,
        expected_generation: uuid::Uuid,
        new_token: String,
    ) -> Result<auth::OwnerRevokeAllOutcome, auth::OwnerMutationError> {
        let outcome = self
            .pairing_manager
            .revoke_all_for_owner(expected_generation, new_token)?;
        self.disconnect_owner_generation(outcome.retired_generation);
        Ok(outcome)
    }

    pub(crate) fn revoke_all_for_local_owner(
        &self,
        new_token: String,
    ) -> Result<auth::OwnerRevokeAllOutcome, auth::OwnerMutationError> {
        let outcome = self.pairing_manager.revoke_all_for_local_owner(new_token)?;
        self.disconnect_owner_generation(outcome.retired_generation);
        Ok(outcome)
    }

    fn disconnect_owner_generation(&self, retired_generation: uuid::Uuid) {
        self.session_manager
            .disconnect_owner_generation(retired_generation);
        self.presence
            .disconnect_owner_generation(retired_generation);
        jumpserver::remove_owner_generation(retired_generation);
    }

    pub(crate) fn disconnect_device_generation(
        &self,
        device_id: &str,
        retired_generation: uuid::Uuid,
    ) -> DeviceGenerationCleanup {
        let disconnected = self
            .session_manager
            .disconnect_device_generation(device_id, retired_generation);
        let presence_disconnected = self
            .presence
            .disconnect_device_generation(device_id, retired_generation);
        let push_removed = usize::from(self.push.remove_generation(device_id, retired_generation));
        jumpserver::remove_device_generation(device_id, retired_generation);
        DeviceGenerationCleanup {
            disconnected,
            presence_disconnected,
            push_removed,
        }
    }

    pub(crate) fn disconnect_device_generations(
        &self,
        retired: &[device_auth::RetiredDeviceCredential],
    ) -> DeviceGenerationCleanup {
        retired.iter().fold(
            DeviceGenerationCleanup::default(),
            |mut total, credential| {
                let cleanup =
                    self.disconnect_device_generation(&credential.device_id, credential.generation);
                total.disconnected += cleanup.disconnected;
                total.presence_disconnected += cleanup.presence_disconnected;
                total.push_removed += cleanup.push_removed;
                total
            },
        )
    }

    /// Get the display name for this device (custom name or OS hostname).
    pub fn display_name(&self) -> String {
        let custom = self.device_name.lock().unwrap().clone();
        if custom.is_empty() {
            hostname::get()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|_| "MeTerm".to_string())
        } else {
            custom
        }
    }
}

/// Generate a cryptographically random token (32 bytes, base64url, ~44 chars).
pub fn generate_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64_url_encode(&bytes)
}

fn base64_url_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut result = String::with_capacity((data.len() * 4 + 2) / 3);
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i] as u32;
        let b1 = if i + 1 < data.len() {
            data[i + 1] as u32
        } else {
            0
        };
        let b2 = if i + 2 < data.len() {
            data[i + 2] as u32
        } else {
            0
        };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if i + 1 < data.len() {
            result.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        }
        if i + 2 < data.len() {
            result.push(CHARS[(triple & 0x3F) as usize] as char);
        }
        i += 3;
    }
    result
}

/// Log the reason the axum serve task exited.
fn log_serve_exit(result: Result<Result<(), std::io::Error>, tokio::task::JoinError>) {
    match result {
        Ok(Ok(())) => eprintln!("[meterm-server] serve returned Ok unexpectedly"),
        Ok(Err(e)) => eprintln!("[meterm-server] serve error: {}", e),
        Err(e) if e.is_panic() => {
            // Extract panic message for diagnostics
            let panic_val = e.into_panic();
            let msg = panic_val
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| panic_val.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| format!("{:?}", panic_val));
            eprintln!("[meterm-server] PANIC in serve task: {}", msg);
        }
        Err(e) => eprintln!("[meterm-server] serve task cancelled: {}", e),
    }
}

/// accept 循环:每条连接 spawn 一个 `serve_connection`(peek 后走 TLS 或明文,都喂同一 Router)。
/// 瞬时错误退避重试;致命错误返回 `Err`,交由上层监督者重建监听(保留原自动重启语义)。
async fn run_accept_loop(
    listener: tokio::net::TcpListener,
    app: Router,
    tls: Option<tokio_rustls::TlsAcceptor>,
    state: Arc<ServerState>,
) -> std::io::Result<()> {
    let connection_slots = transport::connection_slots();
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                // Reject disabled direct-LAN ingress before it can consume the
                // shared pre-auth permit, peek timeout, or TLS handshake work.
                let remote_lease = if peer.ip().is_loopback() {
                    None
                } else {
                    match state.direct_remote_lease() {
                        Some(lease) => Some(lease),
                        None => {
                            drop(stream);
                            continue;
                        }
                    }
                };
                let permit = match connection_slots.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        drop(stream);
                        continue;
                    }
                };
                let app = app.clone();
                let tls = tls.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    if let Some(cancel) = remote_lease {
                        tokio::select! {
                            _ = cancel.cancelled() => {}
                            _ = transport::serve_connection(stream, peer, app, tls) => {}
                        }
                    } else {
                        transport::serve_connection(stream, peer, app, tls).await;
                    }
                });
            }
            Err(e) => {
                if transport::is_transient_accept_error(&e) {
                    eprintln!("[meterm-server] transient accept error: {} — retrying", e);
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    continue;
                }
                eprintln!("[meterm-server] fatal accept error: {}", e);
                return Err(e);
            }
        }
    }
}

fn allocate_port() -> Result<u16, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("port allocation failed: {}", e))?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| e.to_string())
}

/// 优先复用上次端口(state_dir/preferred-port):token 已跨重启持久,
/// 端口再漂移的话手机存的 host:port 依旧失效,持久化才算闭环。
/// 上次端口被占(如双实例)则回退随机分配,并把新端口写回。
fn allocate_port_persistent(state_dir: &str) -> Result<u16, String> {
    // 标准开发入口使用独立 bundle id/app_data_dir；文件名仍按构建类型区分，
    // 防止绕过标准入口直接启动 Debug 时覆盖正式版持久端口。
    let name = if cfg!(debug_assertions) {
        "preferred-port-dev"
    } else {
        "preferred-port"
    };
    let port_file = format!("{}/{}", state_dir, name);
    if let Ok(saved) = std::fs::read_to_string(&port_file) {
        if let Ok(p) = saved.trim().parse::<u16>() {
            if p >= 1024 && TcpListener::bind(("127.0.0.1", p)).is_ok() {
                return Ok(p);
            }
        }
    }
    let port = allocate_port()?;
    let _ = std::fs::write(&port_file, port.to_string());
    Ok(port)
}

/// 持久化设备 ID(state_dir/device-id):是 LAN 重发现 + 未来公网中继按 ID 路由的身份基石,
/// 必须跨重启/换端口/换 IP 保持不变。文件不存在或内容为空则生成新 UUID 并写回。
/// 标准开发入口的数据目录独立；文件名仍按构建类型区分（与 preferred-port-dev 同理）。
fn load_or_create_device_id(state_dir: &str) -> String {
    let name = if cfg!(debug_assertions) {
        "device-id-dev"
    } else {
        "device-id"
    };
    let id_file = format!("{}/{}", state_dir, name);
    if let Ok(saved) = std::fs::read_to_string(&id_file) {
        let trimmed = saved.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::write(&id_file, &id);
    id
}

/// Build the complete axum router with all 24 API endpoints + WebSocket.
fn build_router(state: Arc<ServerState>) -> Router {
    let auth_layer = middleware::from_fn({
        let auth = state.authenticator.clone();
        move |req, next| {
            let auth = auth.clone();
            async move { auth::auth_middleware(axum::extract::Extension(auth), req, next).await }
        }
    });

    let device_scope_layer = |required: device_auth::DeviceScope| {
        middleware::from_fn({
            let auth = state.authenticator.clone();
            move |request, next| {
                let auth = auth.clone();
                async move { auth::device_scope_middleware(auth, required, request, next).await }
            }
        })
    };

    let hook_guard = middleware::from_fn({
        let state = state.clone();
        move |request, next| {
            let state = state.clone();
            async move { agent::hook_guard::authorize_before_body(state, request, next).await }
        }
    });

    // Pairing exchanges a short-lived secret and may return the long-lived
    // bearer, so remote callers must enter through the connection-proven TLS path.
    let pairing_routes = Router::new()
        .route("/api/pair/bootstrap", post(pairing_http::bootstrap_pair))
        .route("/api/pair", post(pairing_http::create_pair))
        .route("/api/pair/{id}", post(pairing_http::poll_pair_post))
        .layer(middleware::from_fn(auth::secure_remote_middleware));

    // Routes that DON'T require authentication
    let public_routes = Router::new()
        .route("/api/ping", get(handlers::ping))
        // agent 镜像 hook 上报(方案甲 M3):public——M2 转发脚本无 Bearer;
        // 端点自带 loopback + per-session secret 双闸(fail-closed,不受 lan_sharing 影响)。
        .route(
            "/api/agent-hook",
            post(agent::hook::agent_hook)
                .layer(axum::extract::DefaultBodyLimit::max(
                    agent::hook::AGENT_HOOK_BODY_LIMIT,
                ))
                .layer(hook_guard),
        )
        .merge(pairing_routes);

    // Resource-specific routes are split before the common authentication
    // layer so every device capability has one auditable boundary.
    let device_base_routes = Router::new()
        .route("/api/auth/challenge", post(pop::issue_challenge))
        .route("/api/sessions", get(handlers::list_sessions))
        .route(
            "/api/sessions/{id}",
            get(handlers::get_session).delete(handlers::delete_session),
        )
        .route("/api/sessions/{id}/master", post(handlers::request_master))
        .route("/ws/{session_id}", get(ws::ws_upgrade))
        .route("/api/pair/claim", post(pairing_http::claim_pair))
        .route("/api/info", get(relay_http::server_info))
        .route(
            "/api/device-credential/self",
            delete(device_admin::revoke_self),
        );

    let desktop_control_routes = Router::new()
        .route("/api/sessions", post(handlers::create_session))
        .route(
            "/api/agent-sessions",
            post(agent::http::create_agent_session),
        )
        .route("/api/agent-options", get(agent::http::get_agent_options))
        .route(
            "/api/sessions/{id}/git/status",
            get(git_handlers::git_status),
        )
        .route("/api/sessions/{id}/git/diff", get(git_handlers::git_diff))
        .route("/api/sessions/{id}/git/log", get(git_handlers::git_log))
        .route(
            "/api/sessions/{id}/git/commit",
            post(git_handlers::git_commit),
        )
        .route("/api/sessions/{id}/git/sync", post(git_handlers::git_sync))
        .route(
            "/api/sessions/{id}/git/branches",
            get(git_handlers::git_branches),
        )
        .route("/api/sessions/{id}/git/show", get(git_handlers::git_show))
        .route(
            "/api/sessions/{id}/git/checkout",
            post(git_handlers::git_checkout),
        )
        .route(
            "/api/sessions/{id}/git/stage",
            post(git_handlers::git_stage),
        )
        .route(
            "/api/sessions/{id}/git/discard",
            post(git_handlers::git_discard),
        )
        .route(
            "/api/sessions/{id}/git/stash",
            post(git_handlers::git_stash),
        )
        .route("/api/files/list", get(files_http::files_list))
        .route("/api/files/download", get(files_http::files_download))
        .route(
            "/api/files/upload",
            post(files_http::files_upload).layer(axum::extract::DefaultBodyLimit::disable()),
        )
        .route("/api/files/op", post(files_http::files_op))
        .layer(device_scope_layer(device_auth::DeviceScope::DesktopControl));

    let ssh_connect_routes = Router::new()
        .route("/api/sessions/ssh", post(handlers::create_ssh_session))
        .route(
            "/api/sessions/ssh/saved",
            post(ssh_saved_session::create_ssh_session_from_saved),
        )
        .route(
            "/api/sessions/ssh/saved/test",
            post(ssh_saved_session::test_ssh_session_from_saved),
        )
        .route(
            "/api/sessions/ssh/test",
            post(handlers::test_ssh_connection),
        )
        .route(
            "/api/ssh/connections",
            get(ssh_connections_http::list_ssh_connections),
        )
        .route("/api/jumpserver/auth", post(jumpserver::handler::auth))
        .route("/api/jumpserver/mfa", post(jumpserver::handler::mfa))
        .route(
            "/api/jumpserver/token-auth",
            post(jumpserver::handler::token_auth),
        )
        .route(
            "/api/jumpserver/assets",
            get(jumpserver::handler::get_assets),
        )
        .route("/api/jumpserver/nodes", get(jumpserver::handler::get_nodes))
        .route(
            "/api/jumpserver/accounts",
            get(jumpserver::handler::get_accounts),
        )
        .route(
            "/api/jumpserver/test",
            post(jumpserver::handler::test_connection),
        )
        .layer(device_scope_layer(
            device_auth::DeviceScope::SshDesktopConnect,
        ));

    let ssh_write_routes = Router::new()
        .route(
            "/api/ssh/connections",
            post(ssh_connections_http::create_ssh_connection),
        )
        .route(
            "/api/ssh/connections/{id}",
            put(ssh_connections_http::update_ssh_connection)
                .delete(ssh_connections_http::delete_ssh_connection),
        )
        .layer(device_scope_layer(
            device_auth::DeviceScope::SshConnectionsWrite,
        ));

    let push_routes = Router::new()
        .route("/api/push/register", post(handlers::register_push))
        .route("/ws-events", get(ws::events_upgrade))
        .layer(device_scope_layer(device_auth::DeviceScope::PushSelf));

    let device_routes = device_base_routes
        .merge(desktop_control_routes)
        .merge(ssh_connect_routes)
        .merge(ssh_write_routes)
        .merge(push_routes)
        .layer(auth_layer.clone());

    // Desktop administration is owner-only. The auth layer runs first and
    // injects AuthPrincipal; the inner owner layer then enforces the boundary.
    let owner_routes = Router::new()
        .route(
            "/api/sessions/{id}/clients/{cid}",
            delete(handlers::kick_client),
        )
        // Credential refresh is only used by the local JumpServer frontend.
        // Keep it owner-only because the handler reuses the session's existing
        // SSH secret while allowing the username/password fields to change.
        .route(
            "/api/sessions/{id}/refresh-sftp",
            post(jumpserver::ssh_session::refresh_jumpserver_sftp_session),
        )
        .route(
            "/api/jumpserver/ssh-session",
            post(jumpserver::ssh_session::create_jumpserver_ssh_session),
        )
        .route("/api/clients", get(handlers::list_clients))
        .route("/api/devices", get(handlers::list_devices))
        .route("/api/devices/{ip}", delete(handlers::kick_device))
        .route(
            "/api/device-credentials",
            get(device_admin::list_credentials),
        )
        .route(
            "/api/device-credentials/{device_id}",
            put(device_admin::update_credential_scopes).delete(device_admin::revoke_credential),
        )
        .route("/api/sessions/{id}/private", post(handlers::set_private))
        .route("/api/pair/pending", get(pairing_http::list_pending_pairs))
        .route("/api/pair/{id}/respond", post(pairing_http::respond_pair))
        .route("/api/pair/claim-status", get(pairing_http::claim_status))
        .route("/api/discoverable", post(pairing_http::toggle_discoverable))
        .route("/api/discover", get(pairing_http::discover))
        .route("/api/token", post(device_admin::set_owner_token))
        .route(
            "/api/token/refresh",
            post(device_admin::refresh_owner_token),
        )
        .route("/api/token/revoke-all", post(device_admin::revoke_all))
        .route(
            "/api/banned-ips",
            get(handlers::list_bans).post(handlers::ban_ip),
        )
        .route("/api/banned-ips/{ip}", delete(handlers::unban_ip))
        .layer(middleware::from_fn(auth::owner_only_middleware))
        .layer(auth_layer);

    let trusted_origin_guard = middleware::from_fn({
        let server_port = state.port;
        move |request, next| async move {
            auth::trusted_origin_middleware(server_port, request, next).await
        }
    });
    let authed_routes = device_routes
        .merge(owner_routes)
        .layer(trusted_origin_guard);

    let allowed_origins = [
        "tauri://localhost".parse().unwrap(),
        "http://tauri.localhost".parse().unwrap(),
        "https://tauri.localhost".parse().unwrap(),
        "http://localhost:5175".parse().unwrap(),
        "http://127.0.0.1:5175".parse().unwrap(),
        format!("http://127.0.0.1:{}", state.port).parse().unwrap(),
        format!("https://127.0.0.1:{}", state.port).parse().unwrap(),
        format!("http://localhost:{}", state.port).parse().unwrap(),
        format!("https://localhost:{}", state.port).parse().unwrap(),
    ];
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(allowed_origins))
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::PUT,
            axum::http::Method::DELETE,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers([
            axum::http::header::AUTHORIZATION,
            axum::http::header::CONTENT_TYPE,
            axum::http::header::CACHE_CONTROL,
            axum::http::header::PRAGMA,
        ])
        .max_age(std::time::Duration::from_secs(600));

    let mut router = Router::new().merge(public_routes).merge(authed_routes);

    // Serve embedded web frontend if dist/ has content
    if web_embed::has_content() {
        router = router.fallback(web_embed::serve_static);
    }

    // LAN access guard: direct remote sockets require LAN sharing. Relay is a
    // separately configured authenticated ingress and must never inherit its
    // synthetic loopback peer's privileges.
    let lan_guard = middleware::from_fn({
        let state = state.clone();
        move |req: axum::extract::Request, next: middleware::Next| {
            let state = state.clone();
            async move {
                if !state.lan_access_enabled() {
                    let allowed = matches!(
                        req.extensions().get::<auth::TrustedIngress>(),
                        Some(auth::TrustedIngress::DirectLoopback | auth::TrustedIngress::Relay)
                    );
                    if !allowed {
                        return Err(axum::http::StatusCode::FORBIDDEN);
                    }
                }
                Ok(next.run(req).await)
            }
        }
    });

    router
        .layer(cors)
        .layer(lan_guard)
        .layer(axum::Extension(state))
        .layer(middleware::from_fn(auth_body::idle_timeout_middleware))
}

/// Minimal router exposed only after a relay substream carries a verified,
/// route-bound Relay renewal preface. It intentionally has no pairing, owner,
/// session, WebSocket, static frontend, CORS or fallback routes.
fn build_relay_renewal_router(state: Arc<ServerState>) -> Router {
    let auth_layer = middleware::from_fn({
        let auth = state.authenticator.clone();
        move |request, next| {
            let auth = auth.clone();
            async move { auth::auth_middleware(axum::extract::Extension(auth), request, next).await }
        }
    });

    Router::new()
        .route("/api/auth/challenge", post(pop::issue_challenge))
        .route(
            "/api/relay/capability/renew",
            post(relay_http::renew_relay_capability),
        )
        .route_layer(middleware::from_fn(
            relay_renewal_preface::renewal_principal_binding_middleware,
        ))
        .route_layer(auth_layer)
        .layer(middleware::from_fn(auth::renewal_ingress_middleware))
        .layer(axum::extract::DefaultBodyLimit::max(8 * 1024))
        .layer(axum::Extension(state))
        .layer(middleware::from_fn(auth_body::idle_timeout_middleware))
}

/// Create a dummy ServerState (used when in-process server fails to start).
pub fn create_dummy_state() -> ServerState {
    let auth = Arc::new(Authenticator::new(String::new()));
    let bm = Arc::new(BanManager::new(None));
    let event_bus = EventBus::new();
    // hook secret 注册表:先建好注入 SessionManager(reap 时据此清理会话 secret),再原样存进
    // ServerState(同源 clone,仿 event_bus 注入模式)——修 M1 的 reap secret 泄漏。
    let hook_secrets = HookSecretRegistry::new();
    let sm = SessionManager::new(
        SessionConfig {
            session_ttl: std::time::Duration::from_secs(300),
            reconnect_grace: std::time::Duration::from_secs(60),
            ring_buffer_size: 256 * 1024,
            log_dir: String::new(),
        },
        event_bus.clone(),
        hook_secrets.clone(),
    );
    let pm = PairingManager::new(auth.clone(), sm.clone(), bm.clone());
    ServerState {
        port: 0,
        lan_port: AtomicU16::new(0),
        ready: AtomicBool::new(false),
        proxy_handle: std::sync::Mutex::new(None),
        proxy_cancel: std::sync::Mutex::new(None),
        config: ServerConfig::default(),
        session_manager: sm,
        authenticator: auth,
        ban_manager: bm,
        pairing_manager: pm,
        jumpserver_sessions: jumpserver::ssh_session::JumpServerSessionRegistry::new(),
        // dummy state 无 app_data_dir,空路径即可(读写静默失败,与 BanManager 的 None 等价)。
        connections: Arc::new(
            ConnectionRegistry::new(std::path::PathBuf::new())
                .expect("empty in-memory connection registry"),
        ),
        discovery_manager: None,
        bypass_proxy: AtomicBool::new(true),
        lan_access: lan_access::LanAccessControl::new(""),
        device_name: std::sync::Mutex::new(String::new()),
        // dummy state 无 app_data_dir,生成一个临时性 UUID(不落盘,进程重启即变),
        // 与其他字段的降级行为一致。
        device_id: uuid::Uuid::new_v4().to_string(),
        // dummy state 不起真实服务,无 TLS,指纹留空。
        cert_fp: String::new(),
        // dummy state 无中继连接,留空。
        relay_url: String::new(),
        relay_cert_fp: String::new(),
        relay_register_token: String::new(),
        event_bus,
        presence: PresenceRegistry::new(),
        push: PushRegistry::new(),
        agents: agent::AcpAgentManager::new(),
        hook_secrets,
        mirrors: agent::MirrorRegistry::new(),
        permission_bridge: agent::PermissionBridge::new(),
    }
}

mod startup;
pub use startup::start;

#[cfg(test)]
#[path = "revoke_cleanup_tests.rs"]
mod revoke_cleanup_tests;

#[cfg(test)]
#[path = "device_id_tests.rs"]
mod device_id_tests;

#[cfg(test)]
#[path = "lan_access_route_tests.rs"]
mod lan_access_route_tests;

#[cfg(test)]
#[path = "relay_renewal_tests.rs"]
mod relay_renewal_tests;
