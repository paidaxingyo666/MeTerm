use tauri::{AppHandle, Manager, State};

use crate::sidecar::MeTermProcess;
use super::auth_client;

#[tauri::command]
pub async fn toggle_lan_sharing(
    state: State<'_, MeTermProcess>,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    let port = state.port();

    if enabled {
        let lan_port = state.start_lan_proxy()?;
        let client = auth_client(&state)?;
        let url = format!("http://127.0.0.1:{}/api/discoverable", port);
        let resp = client
            .post(&url)
            .json(&serde_json::json!({ "enabled": true, "port": lan_port }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            state.stop_lan_proxy();
            return Err("Failed to enable discoverability".into());
        }
        Ok(serde_json::json!({ "ok": true, "lan_port": lan_port }))
    } else {
        let client = auth_client(&state)?;
        let url = format!("http://127.0.0.1:{}/api/discoverable", port);
        let _ = client
            .post(&url)
            .json(&serde_json::json!({ "enabled": false }))
            .send()
            .await;
        state.stop_lan_proxy();
        Ok(serde_json::json!({ "ok": true }))
    }
}

#[tauri::command]
pub fn set_discoverable_state(app: AppHandle, checked: bool) -> Result<(), String> {
    let lifecycle = app.state::<crate::AppLifecycleState>();
    lifecycle.set_discoverable(checked);

    // Rebuild tray menu with updated CheckMenuItem state
    let language = lifecycle.current_language();
    super::menu::set_tray_language(app, language)
}

#[tauri::command]
pub async fn list_clients(state: State<'_, MeTermProcess>) -> Result<String, String> {
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/clients", port);
    let client = auth_client(&state)?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn kick_client(
    state: State<'_, MeTermProcess>,
    session_id: String,
    client_id: String,
    ban: Option<bool>,
) -> Result<String, String> {
    super::validate_id(&session_id)?;
    super::validate_id(&client_id)?;
    let port = state.port();
    let ban_param = if ban.unwrap_or(false) { "?ban=true" } else { "" };
    let url = format!(
        "http://127.0.0.1:{}/api/sessions/{}/clients/{}{}",
        port, session_id, client_id, ban_param
    );
    let client = auth_client(&state)?;

    let resp = client
        .delete(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_devices(state: State<'_, MeTermProcess>) -> Result<String, String> {
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/devices", port);
    let client = auth_client(&state)?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn kick_device(
    state: State<'_, MeTermProcess>,
    ip: String,
    ban: Option<bool>,
) -> Result<String, String> {
    super::validate_ip(&ip)?;
    let port = state.port();
    let ban_param = if ban.unwrap_or(false) { "?ban=true" } else { "" };
    let url = format!("http://127.0.0.1:{}/api/devices/{}{}", port, ip, ban_param);
    let client = auth_client(&state)?;

    let resp = client
        .delete(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_session_private(
    state: State<'_, MeTermProcess>,
    session_id: String,
    private: bool,
) -> Result<String, String> {
    super::validate_id(&session_id)?;
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/sessions/{}/private", port, session_id);
    let client = auth_client(&state)?;

    let body = serde_json::json!({ "private": private });

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.text().await.map_err(|e| e.to_string())
}
