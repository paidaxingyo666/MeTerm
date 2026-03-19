use tauri::State;

use crate::sidecar::MeTermProcess;
use super::auth_client;

#[tauri::command]
pub async fn create_ssh_session(
    state: State<'_, MeTermProcess>,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    trusted_fingerprint: Option<String>,
    skip_shell_hook: Option<bool>,
) -> Result<String, String> {
    let meterm_port = state.port();
    let url = format!("http://127.0.0.1:{}/api/sessions/ssh", meterm_port);
    let client = auth_client(&state)?;

    let body = serde_json::json!({
        "host": host,
        "port": port,
        "username": username,
        "auth_method": auth_method,
        "password": password.unwrap_or_default(),
        "private_key": private_key.unwrap_or_default(),
        "passphrase": passphrase.unwrap_or_default(),
        "trusted_fingerprint": trusted_fingerprint.unwrap_or_default(),
        "skip_shell_hook": skip_shell_hook.unwrap_or(false),
    });

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;

    // Return host key errors as structured JSON (409 Conflict) instead of generic error
    if status.as_u16() == 409 {
        return Ok(text);
    }

    if !status.is_success() {
        return Err(text);
    }

    Ok(text)
}

#[tauri::command]
pub async fn test_ssh_connection(
    state: State<'_, MeTermProcess>,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    trusted_fingerprint: Option<String>,
) -> Result<String, String> {
    let meterm_port = state.port();
    let url = format!("http://127.0.0.1:{}/api/sessions/ssh/test", meterm_port);
    let client = auth_client(&state)?;

    let body = serde_json::json!({
        "host": host,
        "port": port,
        "username": username,
        "auth_method": auth_method,
        "password": password.unwrap_or_default(),
        "private_key": private_key.unwrap_or_default(),
        "passphrase": passphrase.unwrap_or_default(),
        "trusted_fingerprint": trusted_fingerprint.unwrap_or_default(),
    });

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;

    // Return host key errors as structured JSON (409 Conflict)
    if status.as_u16() == 409 {
        return Ok(text);
    }

    if !status.is_success() {
        // Return a valid JSON error so frontend can parse it
        return Ok(serde_json::json!({"ok": false, "error": text}).to_string());
    }

    Ok(text)
}
