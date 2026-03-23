use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

use crate::server::ServerState;

#[tauri::command]
pub async fn toggle_lan_sharing(
    state: State<'_, Arc<ServerState>>,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    if enabled {
        let lan_port = state.start_lan_proxy()?;
        if let Some(ref dm) = state.discovery_manager {
            let name = state.display_name();
            if let Err(e) = dm.set_discoverable(true, Some(lan_port), Some(&name)) {
                state.stop_lan_proxy();
                return Err(format!("failed to enable discoverability: {}", e));
            }
        } else {
            eprintln!("[lan] warning: discovery_manager is None, mDNS registration skipped");
        }
        eprintln!("[lan] sharing enabled on port {}", lan_port);
        Ok(serde_json::json!({ "ok": true, "lan_port": lan_port }))
    } else {
        if let Some(ref dm) = state.discovery_manager {
            let _ = dm.set_discoverable(false, None, None);
        }
        state.stop_lan_proxy();
        eprintln!("[lan] sharing disabled");
        Ok(serde_json::json!({ "ok": true }))
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
pub fn set_discoverable_state(app: AppHandle, checked: bool) -> Result<(), String> {
    let lifecycle = app.state::<crate::AppLifecycleState>();
    lifecycle.set_discoverable(checked);

    let language = lifecycle.current_language();
    super::menu::set_tray_language(app, language)
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

#[tauri::command]
pub async fn kick_device(
    state: State<'_, Arc<ServerState>>,
    ip: String,
    ban: Option<bool>,
) -> Result<String, String> {
    super::validate_ip(&ip)?;
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
