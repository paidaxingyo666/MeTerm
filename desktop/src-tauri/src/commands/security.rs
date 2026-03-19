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
