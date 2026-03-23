use std::sync::Arc;
use tauri::State;

use crate::server::ServerState;

// ─── Secure credential storage via OS keychain ───

/// Validate that the keychain service name is in the allowed namespace.
/// Only services with the "com.meterm." prefix are permitted to prevent
/// arbitrary access to other applications' keychain entries.
fn validate_keychain_service(service: &str) -> Result<(), String> {
    if service.starts_with("com.meterm.") && service.len() <= 128 {
        Ok(())
    } else {
        Err("invalid keychain service name".to_string())
    }
}

#[tauri::command]
pub async fn store_credential(service: String, account: String, secret: String) -> Result<(), String> {
    validate_keychain_service(&service)?;
    let entry = keyring::Entry::new(&service, &account)
        .map_err(|e| format!("keyring init error: {}", e))?;
    entry.set_password(&secret)
        .map_err(|e| format!("keyring store error: {}", e))
}

#[tauri::command]
pub async fn get_credential(service: String, account: String) -> Result<String, String> {
    validate_keychain_service(&service)?;
    let entry = keyring::Entry::new(&service, &account)
        .map_err(|e| format!("keyring init error: {}", e))?;
    entry.get_password()
        .map_err(|e| format!("keyring get error: {}", e))
}

#[tauri::command]
pub async fn delete_credential(service: String, account: String) -> Result<(), String> {
    validate_keychain_service(&service)?;
    let entry = keyring::Entry::new(&service, &account)
        .map_err(|e| format!("keyring init error: {}", e))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // already deleted, not an error
        Err(e) => Err(format!("keyring delete error: {}", e)),
    }
}

// ─── One-time localStorage migration from old bundle ID ───

/// Read all localStorage entries from the old `com.meterm.dev` WebKit data directory.
/// Returns a JSON object `{ key: value, ... }` of all entries with the "meterm-" prefix.
/// Returns `null` if no old data is found or migration is not needed.
#[tauri::command]
pub async fn read_old_localstorage() -> Result<Option<std::collections::HashMap<String, String>>, String> {
    let home = dirs::home_dir().ok_or("cannot determine home directory")?;
    let old_base = home.join("Library/WebKit/com.meterm.dev/WebsiteData/Default");
    if !old_base.exists() {
        return Ok(None);
    }

    // Find all localstorage.sqlite3 files under the old data directory
    let mut result = std::collections::HashMap::new();
    if let Ok(entries) = std::fs::read_dir(&old_base) {
        for entry in entries.flatten() {
            let ls_path = entry.path()
                .join(entry.file_name())
                .join("LocalStorage/localstorage.sqlite3");
            if ls_path.exists() {
                if let Ok(items) = read_sqlite_localstorage(&ls_path) {
                    for (k, v) in items {
                        if k.starts_with("meterm-") {
                            result.insert(k, v);
                        }
                    }
                }
            }
        }
    }

    if result.is_empty() {
        Ok(None)
    } else {
        Ok(Some(result))
    }
}

fn read_sqlite_localstorage(path: &std::path::Path) -> Result<Vec<(String, String)>, String> {
    let conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ).map_err(|e| format!("sqlite open: {}", e))?;

    let mut stmt = conn.prepare("SELECT key, value FROM ItemTable")
        .map_err(|e| format!("sqlite prepare: {}", e))?;

    let rows = stmt.query_map([], |row| {
        let key: String = row.get(0)?;
        // WKWebView stores values as UTF-16LE blobs
        let value: String = match row.get::<_, String>(1) {
            Ok(s) => s,
            Err(_) => {
                // Try reading as blob and decode UTF-16LE
                let blob: Vec<u8> = row.get(1)?;
                let utf16: Vec<u16> = blob.chunks_exact(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .collect();
                String::from_utf16_lossy(&utf16)
            }
        };
        Ok((key, value))
    }).map_err(|e| format!("sqlite query: {}", e))?;

    let mut items = Vec::new();
    for row in rows {
        if let Ok(item) = row {
            items.push(item);
        }
    }
    Ok(items)
}

// ─── IP ban management ───

#[tauri::command]
pub async fn list_banned_ips(state: State<'_, Arc<ServerState>>) -> Result<String, String> {
    let bans = state.ban_manager.list();
    Ok(serde_json::json!({ "banned_ips": bans }).to_string())
}

#[tauri::command]
pub async fn ban_ip(
    state: State<'_, Arc<ServerState>>,
    ip: String,
    reason: Option<String>,
) -> Result<String, String> {
    super::validate_ip(&ip)?;
    state
        .ban_manager
        .ban(&ip, &reason.unwrap_or_default())
        .map_err(|e| e)?;
    state.session_manager.kick_by_ip(&ip);
    Ok(serde_json::json!({ "ok": true }).to_string())
}

#[tauri::command]
pub async fn unban_ip(
    state: State<'_, Arc<ServerState>>,
    ip: String,
) -> Result<String, String> {
    super::validate_ip(&ip)?;
    let found = state.ban_manager.unban(&ip);
    Ok(serde_json::json!({ "ok": true, "found": found }).to_string())
}

// ─── Token management ───

#[tauri::command]
pub async fn refresh_token(state: State<'_, Arc<ServerState>>) -> Result<String, String> {
    let new_token = crate::server::generate_token();
    state.authenticator.set_token(new_token.clone());
    Ok(serde_json::json!({ "ok": true, "token": new_token }).to_string())
}

#[tauri::command]
pub async fn set_custom_token(
    state: State<'_, Arc<ServerState>>,
    token: String,
) -> Result<String, String> {
    if token.len() < 8 {
        return Err("token must be at least 8 characters".to_string());
    }
    state.authenticator.set_token(token);
    Ok(serde_json::json!({ "ok": true }).to_string())
}

#[tauri::command]
pub async fn revoke_all_clients(state: State<'_, Arc<ServerState>>) -> Result<String, String> {
    let new_token = crate::server::generate_token();
    state.authenticator.set_token(new_token.clone());
    let disconnected = state.session_manager.disconnect_all_clients();
    Ok(serde_json::json!({ "ok": true, "new_token": new_token, "disconnected": disconnected }).to_string())
}

// ─── Proxy settings ───

#[tauri::command]
pub fn set_proxy_mode(mode: String) {
    let bypass = mode != "system";
    crate::server::jumpserver::BYPASS_PROXY.store(bypass, std::sync::atomic::Ordering::Relaxed);
    // Clear cached JumpServer clients so they pick up the new proxy setting
    crate::server::jumpserver::clear_client_pool();
    eprintln!("[settings] proxy mode: {} (bypass={})", mode, bypass);
}
