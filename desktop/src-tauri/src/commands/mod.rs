pub mod menu;
pub mod session;
pub mod ssh;
pub mod lan;
pub mod security;
pub mod ai;
pub mod window;
pub mod fs;
pub mod lifecycle;
pub mod context_menu;

use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde::Serialize;

use crate::sidecar::MeTermProcess;

/// Validates that an ID string (session_id, client_id) contains only safe characters.
fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("invalid id length".to_string());
    }
    if id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        Ok(())
    } else {
        Err("invalid id format".to_string())
    }
}

/// Validates that a string is a valid IP address.
fn validate_ip(ip: &str) -> Result<(), String> {
    ip.parse::<std::net::IpAddr>()
        .map(|_| ())
        .map_err(|_| "invalid IP address".to_string())
}

#[derive(Serialize)]
pub struct MeTermConnectionInfo {
    pub port: u16,
    pub token: String,
}

fn make_auth_headers(token: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    let value = HeaderValue::from_str(&format!("Bearer {}", token)).map_err(|e| e.to_string())?;
    headers.insert(AUTHORIZATION, value);
    Ok(headers)
}

fn auth_client(state: &MeTermProcess) -> Result<reqwest::Client, String> {
    let token = state
        .token()
        .ok_or_else(|| "meterm token not ready".to_string())?;
    let headers = make_auth_headers(&token)?;
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| e.to_string())
}

// Re-export functions used directly (not via generate_handler!) in lib.rs
pub use menu::{set_tray_language, set_app_menu_language};
