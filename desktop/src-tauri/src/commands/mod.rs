pub mod ai;
pub mod context_menu;
pub mod fs;
pub mod ipc_terminal;
pub mod lan;
pub mod lifecycle;
pub mod menu;
pub mod security;
pub mod session;
pub mod ssh;
pub mod transfer;
pub mod window;

use serde::Serialize;

/// Validates that an ID string (session_id, client_id) contains only safe characters.
fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("invalid id length".to_string());
    }
    if id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
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

// Re-export functions used directly (not via generate_handler!) in lib.rs
pub use menu::{set_app_menu_language, set_tray_language};
