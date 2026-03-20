use tauri::State;

use crate::sidecar::MeTermProcess;
use super::auth_client;

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
pub async fn list_banned_ips(state: State<'_, MeTermProcess>) -> Result<String, String> {
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/banned-ips", port);
    let client = auth_client(&state)?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ban_ip(
    state: State<'_, MeTermProcess>,
    ip: String,
    reason: Option<String>,
) -> Result<String, String> {
    super::validate_ip(&ip)?;
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/banned-ips", port);
    let client = auth_client(&state)?;

    let body = serde_json::json!({
        "ip": ip,
        "reason": reason.unwrap_or_default(),
    });

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unban_ip(
    state: State<'_, MeTermProcess>,
    ip: String,
) -> Result<String, String> {
    super::validate_ip(&ip)?;
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/banned-ips/{}", port, ip);
    let client = auth_client(&state)?;

    let resp = client
        .delete(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.text().await.map_err(|e| e.to_string())
}

// ─── Token management ───

#[tauri::command]
pub async fn refresh_token(state: State<'_, MeTermProcess>) -> Result<String, String> {
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/token/refresh", port);
    let client = auth_client(&state)?;

    let resp = client
        .post(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let text = resp.text().await.map_err(|e| e.to_string())?;

    // Update the local token store so subsequent requests use the new token
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(new_token) = parsed.get("token").and_then(|v| v.as_str()) {
            state.update_token(new_token.to_string());
        }
    }

    Ok(text)
}

#[tauri::command]
pub async fn set_custom_token(
    state: State<'_, MeTermProcess>,
    token: String,
) -> Result<String, String> {
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/token", port);
    let client = auth_client(&state)?;

    let body = serde_json::json!({ "token": token });

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(text);
    }

    // Backend returns {"ok": true} without echoing the token (security).
    // Use the token from our parameter directly.
    state.update_token(token);

    Ok(text)
}

#[tauri::command]
pub async fn revoke_all_clients(state: State<'_, MeTermProcess>) -> Result<String, String> {
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/token/revoke-all", port);
    let client = auth_client(&state)?;

    let resp = client
        .post(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let text = resp.text().await.map_err(|e| e.to_string())?;

    // Update local token store with the auto-refreshed token
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(new_token) = parsed.get("new_token").and_then(|v| v.as_str()) {
            state.update_token(new_token.to_string());
        }
    }

    Ok(text)
}
