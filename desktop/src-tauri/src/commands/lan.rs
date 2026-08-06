use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::server::lan_access::LanAccessStatus;
use crate::server::ServerState;

#[tauri::command]
pub fn get_lan_access_state(state: State<'_, Arc<ServerState>>) -> LanAccessStatus {
    state.lan_access_status()
}

#[tauri::command]
pub fn set_lan_access(
    app: AppHandle,
    state: State<'_, Arc<ServerState>>,
    enabled: bool,
) -> Result<LanAccessStatus, String> {
    finish_lan_transition(&app, &state, state.set_lan_access(enabled))
}

#[tauri::command]
pub fn set_lan_discovery(
    app: AppHandle,
    state: State<'_, Arc<ServerState>>,
    enabled: bool,
) -> Result<LanAccessStatus, String> {
    finish_lan_transition(&app, &state, state.set_lan_discovery(enabled))
}

/// Native tray action. It performs the Rust transition itself; renderer events
/// are notification-only and are never required to enforce the security gate.
pub(crate) fn toggle_tray_lan_access(
    app: &AppHandle,
    state: &ServerState,
) -> Result<LanAccessStatus, String> {
    let current = state.lan_access_status();
    let result = state.set_lan_access(!current.enabled);
    finish_lan_transition(app, state, result)
}

fn finish_lan_transition(
    app: &AppHandle,
    state: &ServerState,
    result: Result<LanAccessStatus, String>,
) -> Result<LanAccessStatus, String> {
    match result {
        Ok(status) => {
            publish_lan_state(app, &status);
            Ok(status)
        }
        Err(error) => {
            publish_lan_state(app, &state.lan_access_status());
            Err(error)
        }
    }
}

fn publish_lan_state(app: &AppHandle, status: &LanAccessStatus) {
    if let Some(lifecycle) = app.try_state::<crate::AppLifecycleState>() {
        // The single native check item is the LAN access kill switch. mDNS has
        // its own settings control and must never share this visual state.
        lifecycle.set_lan_access_menu_checked(status.enabled);
        let language = lifecycle.current_language();
        if let Err(error) = super::menu::set_tray_language(app.clone(), language) {
            eprintln!("[lan] tray state refresh failed: {error}");
        }
    }
    if let Err(error) = app.emit("lan-access-state-changed", status.clone()) {
        eprintln!("[lan] state event failed: {error}");
    }
}

#[tauri::command]
pub async fn discover_lan(state: State<'_, Arc<ServerState>>) -> Result<String, String> {
    if let Some(ref dm) = state.discovery_manager {
        let services = dm.discover(5).await;
        eprintln!("[lan] discover found {} services", services.len());
        Ok(serde_json::json!({ "services": services }).to_string())
    } else {
        eprintln!("[lan] discover skipped: discovery_manager is None");
        Ok(serde_json::json!({ "services": [] }).to_string())
    }
}

#[tauri::command]
pub async fn ping_remote(host: String, port: u16) -> Result<String, String> {
    let addr = format!("{}:{}", host, port);
    // TCP connect test — LAN proxy injects PROXY Protocol headers that break HTTP,
    // so we just verify TCP reachability instead of sending an HTTP request.
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tokio::net::TcpStream::connect(&addr),
    )
    .await
    {
        Ok(Ok(_)) => Ok(r#"{"service":"meterm"}"#.to_string()),
        Ok(Err(e)) => Err(format!("connect {}: {}", addr, e)),
        Err(_) => Err(format!("connect {}: timeout", addr)),
    }
}

#[tauri::command]
pub fn get_device_name(state: State<'_, Arc<ServerState>>) -> String {
    state.display_name()
}

#[tauri::command]
pub fn set_device_name(state: State<'_, Arc<ServerState>>, name: String) {
    *state.device_name.lock().unwrap() = name;
}

#[tauri::command]
pub async fn list_clients(state: State<'_, Arc<ServerState>>) -> Result<String, String> {
    let clients = state.session_manager.list_all_clients();
    Ok(serde_json::json!({ "clients": clients }).to_string())
}

#[tauri::command]
pub async fn kick_client(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    client_id: String,
    ban: Option<bool>,
) -> Result<String, String> {
    super::validate_id(&session_id)?;
    super::validate_id(&client_id)?;
    match state.session_manager.get(&session_id) {
        Some(session) => {
            let (addr, found) = session.kick_client(&client_id);
            if found {
                if ban.unwrap_or(false) && !addr.is_empty() {
                    let _ = state.ban_manager.ban(&addr, "kicked and banned");
                }
                Ok(serde_json::json!({ "ok": true, "remote_addr": addr }).to_string())
            } else {
                Err("client not found".into())
            }
        }
        None => Err("session not found".into()),
    }
}

#[tauri::command]
pub async fn list_devices(state: State<'_, Arc<ServerState>>) -> Result<String, String> {
    let devices = state.session_manager.list_devices();
    Ok(serde_json::json!({ "devices": devices }).to_string())
}

/// List persistent per-device credentials, including offline paired devices.
/// This is local Tauri IPC only; remote callers use the owner-only HTTP route.
#[tauri::command]
pub async fn list_paired_credentials(state: State<'_, Arc<ServerState>>) -> Result<String, String> {
    let devices = state.authenticator.list_device_credentials();
    Ok(serde_json::json!({ "devices": devices }).to_string())
}

/// Revoke one stable device identity and immediately tear down every related
/// terminal/presence connection and push destination.
#[tauri::command]
pub async fn revoke_paired_credential(
    state: State<'_, Arc<ServerState>>,
    device_id: String,
) -> Result<String, String> {
    state
        .authenticator
        .validate_device_identity(&device_id, "Paired device")?;
    let Some(retired) = state.authenticator.revoke_device(&device_id)? else {
        return Err("device credential not found".to_string());
    };
    let cleanup = state.disconnect_device_generation(&retired.device_id, retired.generation);
    Ok(serde_json::json!({
        "ok": true,
        "disconnected": cleanup.disconnected,
        "presence_disconnected": cleanup.presence_disconnected,
        "push_removed": cleanup.push_removed != 0,
    })
    .to_string())
}

#[tauri::command]
pub async fn kick_device(
    state: State<'_, Arc<ServerState>>,
    ip: String,
    ban: Option<bool>,
) -> Result<String, String> {
    super::validate_ip(&ip)?;
    // TODO(device-auth): revoke credentials only through a future stable
    // device_id route. IP-based session kicks are not a safe identity mapping.
    let count = state.session_manager.kick_by_ip(&ip);
    if ban.unwrap_or(false) {
        let _ = state.ban_manager.ban(&ip, "kicked and banned");
    }
    Ok(serde_json::json!({ "ok": true, "kicked": count }).to_string())
}

#[tauri::command]
pub async fn set_session_private(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    private: bool,
) -> Result<String, String> {
    super::validate_id(&session_id)?;
    match state.session_manager.get(&session_id) {
        Some(session) => {
            let kicked = session.set_private(private);
            Ok(serde_json::json!({ "ok": true, "kicked": kicked }).to_string())
        }
        None => Err("session not found".into()),
    }
}
