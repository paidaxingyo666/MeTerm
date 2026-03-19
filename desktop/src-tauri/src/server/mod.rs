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
pub mod ws;

use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Arc;

use axum::routing::{any, delete, get, post};
use axum::{middleware, Router};
use tokio::sync::Mutex;
use tower_http::cors::{AllowOrigin, CorsLayer};

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
    pub proxy_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    pub config: ServerConfig,
    pub session_manager: Arc<SessionManager>,
    pub authenticator: Arc<Authenticator>,
    pub ban_manager: Arc<BanManager>,
    pub pairing_manager: Arc<PairingManager>,
    pub discovery_manager: Option<DiscoveryManager>,
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

    router
        .layer(cors)
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
        proxy_handle: Mutex::new(None),
        config: ServerConfig::default(),
        session_manager: sm,
        authenticator: auth,
        ban_manager: bm,
        pairing_manager: pm,
        discovery_manager: None,
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

    let discovery_manager = DiscoveryManager::new(port).ok();

    let state = Arc::new(ServerState {
        port,
        lan_port: AtomicU16::new(port),
        ready: AtomicBool::new(false),
        proxy_handle: Mutex::new(None),
        config,
        session_manager,
        authenticator,
        ban_manager,
        pairing_manager,
        discovery_manager,
    });

    let app = build_router(state.clone());

    let addr = format!("127.0.0.1:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("bind {}: {}", addr, e))?;

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("[meterm-server] axum serve error: {}", e);
        }
    });

    state.ready.store(true, Ordering::SeqCst);
    eprintln!("[meterm-server] ready on 127.0.0.1:{}", port);

    Ok(state)
}
