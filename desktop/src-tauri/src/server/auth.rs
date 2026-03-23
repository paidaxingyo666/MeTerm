//! Authentication middleware — token validation and management.
//!
//! Mirrors Go `api/auth.go`. Supports two authentication methods:
//! 1. `Authorization: Bearer <token>` header
//! 2. `Sec-WebSocket-Protocol: bearer.<token>` (for WebSocket upgrades)

use axum::{
    extract::Request,
    http::{header, StatusCode},
    middleware::Next,
    response::Response,
};
use std::sync::{Arc, RwLock};

use super::ban::BanManager;

/// Token-based authenticator.
pub struct Authenticator {
    token: RwLock<String>,
    ban_manager: Option<Arc<BanManager>>,
}

impl Authenticator {
    pub fn new(token: String) -> Self {
        Self {
            token: RwLock::new(token),
            ban_manager: None,
        }
    }

    pub fn set_ban_manager(&mut self, bm: Arc<BanManager>) {
        self.ban_manager = Some(bm);
    }

    pub fn get_token(&self) -> String {
        self.token.read().unwrap().clone()
    }

    pub fn set_token(&self, t: String) {
        *self.token.write().unwrap() = t;
    }

    /// Validate a request against the stored token.
    ///
    /// Checks (in order):
    /// 1. `Authorization: Bearer <token>`
    /// 2. `Sec-WebSocket-Protocol` containing `bearer.<token>`
    pub fn validate_request(&self, req: &Request) -> bool {
        let expected = self.token.read().unwrap().clone();
        if expected.is_empty() {
            return false;
        }

        // Method 1: Authorization header
        if let Some(auth) = req.headers().get(header::AUTHORIZATION) {
            if let Ok(auth_str) = auth.to_str() {
                if let Some(token) = auth_str.strip_prefix("Bearer ") {
                    return constant_time_eq(token.as_bytes(), expected.as_bytes());
                }
            }
        }

        // Method 2: WebSocket sub-protocol
        if let Some(proto) = req.headers().get(header::SEC_WEBSOCKET_PROTOCOL) {
            if let Ok(proto_str) = proto.to_str() {
                for part in proto_str.split(',') {
                    let trimmed = part.trim();
                    if let Some(token) = trimmed.strip_prefix("bearer.") {
                        return constant_time_eq(token.as_bytes(), expected.as_bytes());
                    }
                }
            }
        }

        false
    }
}

/// Extract the real client IP from a request.
///
/// Uses axum ConnectInfo (set via into_make_service_with_connect_info).
/// Falls back to X-Forwarded-For header.
pub fn client_ip(req: &Request) -> String {
    // ConnectInfo from axum — the actual TCP peer address
    if let Some(connect_info) = req.extensions().get::<axum::extract::ConnectInfo<std::net::SocketAddr>>() {
        return connect_info.0.ip().to_string();
    }

    // Fallback: X-Forwarded-For header
    if let Some(xff) = req.headers().get("x-forwarded-for") {
        if let Ok(xff_str) = xff.to_str() {
            if let Some(first) = xff_str.split(',').next() {
                let ip = first.trim();
                if !ip.is_empty() {
                    return ip.to_string();
                }
            }
        }
    }

    String::new()
}

/// Axum middleware that checks authentication.
///
/// Endpoints that don't require auth (e.g., /api/ping, /api/pair) should
/// be registered outside the auth layer.
pub async fn auth_middleware(
    axum::extract::Extension(auth): axum::extract::Extension<Arc<Authenticator>>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    // Check IP ban first
    if let Some(ref bm) = auth.ban_manager {
        let ip = client_ip(&req);
        if !ip.is_empty() && bm.is_banned(&ip) {
            return Err(StatusCode::FORBIDDEN);
        }
    }

    if !auth.validate_request(&req) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(next.run(req).await)
}

/// Constant-time byte comparison to prevent timing attacks on token validation.
/// Mirrors Go's `subtle.ConstantTimeCompare`.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut result: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        result |= x ^ y;
    }
    result == 0
}
