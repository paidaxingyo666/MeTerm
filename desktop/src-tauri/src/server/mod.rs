//! In-process HTTP/WebSocket server — replaces the Go sidecar.
//!
//! The server is started inside the Tauri process during `setup()`.
//! It exposes the same HTTP API and WebSocket endpoints that the Go
//! `meterm-server` binary did, so the TypeScript frontend keeps working
//! without any changes.

pub mod auth;
pub mod ban;
pub mod discover;
pub mod encoding;
pub mod executor;
pub mod file_handler;
pub mod handlers;
pub mod jumpserver;
pub mod pairing;
pub mod protocol;
pub mod proxy;
pub mod recording;
pub mod server_info;
pub mod session;
pub mod terminal;
pub mod web_embed;
pub mod dispatch;
pub mod osc_filter;
pub mod ws;

use std::future::IntoFuture;
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Arc;

use axum::routing::{any, delete, get, post};
use axum::{middleware, Router};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tokio_util::sync::CancellationToken;

use auth::Authenticator;
use ban::BanManager;
use discover::DiscoveryManager;
use pairing::PairingManager;
use session::manager::SessionManager;
use session::SessionConfig;

/// Configuration for the server, mirrors Go's CLI flags.
pub struct ServerConfig {
    pub session_ttl: std::time::Duration,
    pub reconnect_grace: std::time::Duration,
    pub ring_buffer_size: usize,
    pub log_dir: String,
    pub verbose: bool,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            session_ttl: std::time::Duration::from_secs(300),
            reconnect_grace: std::time::Duration::from_secs(60),
            ring_buffer_size: 256 * 1024,
            log_dir: String::new(),
            verbose: false,
        }
    }
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
    pub discovery_manager: Option<DiscoveryManager>,
    /// When true, all outgoing HTTP requests bypass system proxy (direct connection).
    pub bypass_proxy: AtomicBool,
    /// When true, accept connections from non-loopback addresses (LAN sharing).
    pub lan_sharing: AtomicBool,
    /// Custom device name for LAN sharing (empty = OS hostname).
    pub device_name: std::sync::Mutex<String>,
}

impl ServerState {
    pub fn port(&self) -> u16 {
        self.port
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

    pub fn update_token(&self, new_token: String) {
        self.authenticator.set_token(new_token);
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

    /// Enable LAN sharing. Since the server already binds on 0.0.0.0,
    /// no separate proxy is needed — just return the server port for mDNS registration.
    /// Non-loopback connections are gated by the lan_access_guard middleware.
    pub fn start_lan_proxy(&self) -> Result<u16, String> {
        self.lan_sharing.store(true, Ordering::SeqCst);
        self.lan_port.store(self.port, Ordering::Relaxed);
        eprintln!("[lan] LAN sharing enabled on server port {}", self.port);
        Ok(self.port)
    }

    /// Disable LAN sharing. Non-loopback connections will be rejected.
    pub fn stop_lan_proxy(&self) {
        self.lan_sharing.store(false, Ordering::SeqCst);
        self.lan_port.store(self.port, Ordering::Relaxed);
        eprintln!("[lan] LAN sharing disabled");
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
        let b1 = if i + 1 < data.len() { data[i + 1] as u32 } else { 0 };
        let b2 = if i + 2 < data.len() { data[i + 2] as u32 } else { 0 };
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

fn allocate_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("port allocation failed: {}", e))?;
    listener.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
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

    // Routes that DON'T require authentication
    let public_routes = Router::new()
        .route("/api/ping", get(handlers::ping))
        .route("/api/pair", post(handlers::create_pair))
        .route("/api/pair/{id}", get(handlers::poll_pair));

    // Routes that DO require authentication
    let authed_routes = Router::new()
        // Session management
        .route("/api/sessions", get(handlers::list_sessions).post(handlers::create_session))
        .route("/api/sessions/ssh", post(handlers::create_ssh_session))
        .route("/api/sessions/ssh/test", post(handlers::test_ssh_connection))
        .route("/api/sessions/{id}", get(handlers::get_session).delete(handlers::delete_session))
        .route("/api/sessions/{id}/master", post(handlers::request_master))
        .route("/api/sessions/{id}/private", post(handlers::set_private))
        .route("/api/sessions/{id}/clients/{cid}", delete(handlers::kick_client))
        // Clients / devices
        .route("/api/clients", get(handlers::list_clients))
        .route("/api/devices", get(handlers::list_devices))
        .route("/api/devices/{ip}", delete(handlers::kick_device))
        // Pairing / discovery
        .route("/api/pair/pending", get(handlers::list_pending_pairs))
        .route("/api/pair/{id}/respond", post(handlers::respond_pair))
        .route("/api/discoverable", post(handlers::toggle_discoverable))
        .route("/api/discover", get(handlers::discover))
        // Token management
        .route("/api/token", post(handlers::set_token))
        .route("/api/token/refresh", post(handlers::refresh_token))
        .route("/api/token/revoke-all", post(handlers::revoke_all))
        // IP ban management
        .route("/api/banned-ips", get(handlers::list_bans).post(handlers::ban_ip))
        .route("/api/banned-ips/{ip}", delete(handlers::unban_ip))
        // System info
        .route("/api/info", get(handlers::server_info))
        // JumpServer API (8 specific routes, matching Go RegisterJumpServerRoutes)
        .route("/api/jumpserver/auth", post(jumpserver::handler::auth))
        .route("/api/jumpserver/mfa", post(jumpserver::handler::mfa))
        .route("/api/jumpserver/token-auth", post(jumpserver::handler::token_auth))
        .route("/api/jumpserver/assets", get(jumpserver::handler::get_assets))
        .route("/api/jumpserver/nodes", get(jumpserver::handler::get_nodes))
        .route("/api/jumpserver/accounts", get(jumpserver::handler::get_accounts))
        .route("/api/jumpserver/connection-token", post(jumpserver::handler::create_connection_token))
        .route("/api/jumpserver/test", post(jumpserver::handler::test_connection))
        // WebSocket
        .route("/ws/{session_id}", get(ws::ws_upgrade))
        .layer(auth_layer);

    // CORS: allow all origins. Security is via Bearer token auth, not CORS.
    // Go also allows requests without Origin header (empty Origin = pass).
    let cors = CorsLayer::very_permissive();

    let mut router = Router::new()
        .merge(public_routes)
        .merge(authed_routes);

    // Serve embedded web frontend if dist/ has content
    if web_embed::has_content() {
        router = router.fallback(web_embed::serve_static);
    }

    // LAN access guard: reject non-loopback connections when sharing is disabled.
    let lan_guard = middleware::from_fn({
        let state = state.clone();
        move |req: axum::extract::Request, next: middleware::Next| {
            let state = state.clone();
            async move {
                if !state.lan_sharing.load(Ordering::SeqCst) {
                    // Check if connection is from loopback
                    let is_local = req.extensions()
                        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
                        .map(|ci| ci.0.ip().is_loopback())
                        .unwrap_or(true); // no ConnectInfo = assume local
                    if !is_local {
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
}

/// Create a dummy ServerState (used when in-process server fails to start).
pub fn create_dummy_state() -> ServerState {
    let auth = Arc::new(Authenticator::new(String::new()));
    let bm = Arc::new(BanManager::new(None));
    let sm = SessionManager::new(SessionConfig {
        session_ttl: std::time::Duration::from_secs(300),
        reconnect_grace: std::time::Duration::from_secs(60),
        ring_buffer_size: 256 * 1024,
        log_dir: String::new(),
    });
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
        discovery_manager: None,
        bypass_proxy: AtomicBool::new(true),
        lan_sharing: AtomicBool::new(false),
        device_name: std::sync::Mutex::new(String::new()),
    }
}

/// Start the in-process HTTP/WebSocket server.
pub async fn start(config: ServerConfig) -> Result<Arc<ServerState>, String> {
    let port = allocate_port()?;
    let token = generate_token();

    let ban_file = if config.log_dir.is_empty() {
        None
    } else {
        Some(format!("{}/banned-ips.json", config.log_dir))
    };

    let session_config = SessionConfig {
        session_ttl: config.session_ttl,
        reconnect_grace: config.reconnect_grace,
        ring_buffer_size: config.ring_buffer_size,
        log_dir: config.log_dir.clone(),
    };

    let ban_manager = Arc::new(BanManager::new(ban_file));
    let authenticator = Arc::new(Authenticator::new(token));
    let session_manager = SessionManager::new(session_config);
    let pairing_manager = PairingManager::new(
        authenticator.clone(),
        session_manager.clone(),
        ban_manager.clone(),
    );

    let discovery_manager = match DiscoveryManager::new(port) {
        Ok(dm) => {
            eprintln!("[meterm] mDNS discovery manager initialized");
            Some(dm)
        }
        Err(e) => {
            eprintln!("[meterm] mDNS discovery manager failed: {} — LAN scanning disabled", e);
            None
        }
    };

    let state = Arc::new(ServerState {
        port,
        lan_port: AtomicU16::new(port),
        ready: AtomicBool::new(false),
        proxy_handle: std::sync::Mutex::new(None),
        proxy_cancel: std::sync::Mutex::new(None),
        config,
        session_manager,
        authenticator,
        ban_manager,
        pairing_manager,
        discovery_manager,
        bypass_proxy: AtomicBool::new(true),
        lan_sharing: AtomicBool::new(false),
        device_name: std::sync::Mutex::new(String::new()),
    });

    let app = build_router(state.clone());

    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("bind {}: {}", addr, e))?;

    // Spawn the axum server inside a supervisor that auto-restarts on
    // panic, error, or unexpected exit. Without this, a single panic in
    // the serve loop silently kills the server and ALL WebSocket sessions
    // fail with "Socket is not connected".
    let state_for_serve = state.clone();
    let addr_for_restart = addr.clone();
    tokio::spawn(async move {
        // First run uses the already-bound listener.
        log_serve_exit(
            tokio::spawn(axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).into_future()).await
        );

        // Auto-restart loop: rebind to the same port and rebuild the router.
        loop {
            eprintln!("[meterm-server] restarting in 500ms...");
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

            let listener = match tokio::net::TcpListener::bind(&addr_for_restart).await {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[meterm-server] rebind {} failed: {} — retrying", addr_for_restart, e);
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    continue;
                }
            };

            let app = build_router(state_for_serve.clone());
            eprintln!("[meterm-server] restarted on {}", addr_for_restart);

            log_serve_exit(
                tokio::spawn(axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).into_future()).await
            );
        }
    });

    state.ready.store(true, Ordering::SeqCst);
    eprintln!("[meterm-server] ready on 0.0.0.0:{}", port);

    Ok(state)
}
