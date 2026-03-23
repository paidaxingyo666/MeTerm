use std::sync::Arc;
use tauri::State;

use crate::server::ServerState;
use crate::server::terminal::ssh::{SshConfig, SshTerminal};

#[tauri::command]
pub async fn create_ssh_session(
    state: State<'_, Arc<ServerState>>,
    host: String,
    port: u16,
    username: String,
    #[allow(unused)] auth_method: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    trusted_fingerprint: Option<String>,
    skip_shell_hook: Option<bool>,
    proxy_type: Option<String>,
    proxy_host: Option<String>,
    proxy_port: Option<u16>,
    proxy_username: Option<String>,
    proxy_password: Option<String>,
) -> Result<String, String> {
    if host.is_empty() || username.is_empty() {
        return Err("host and username are required".to_string());
    }

    let config = SshConfig {
        host,
        port,
        username,
        password: password.unwrap_or_default(),
        private_key: private_key.unwrap_or_default(),
        passphrase: passphrase.unwrap_or_default(),
        trusted_fingerprint: trusted_fingerprint.unwrap_or_default(),
        disable_hook: skip_shell_hook.unwrap_or(false),
        proxy_type: proxy_type.unwrap_or_default(),
        proxy_host: proxy_host.unwrap_or_default(),
        proxy_port: proxy_port.unwrap_or(0),
        proxy_username: proxy_username.unwrap_or_default(),
        proxy_password: proxy_password.unwrap_or_default(),
    };

    let session = state.session_manager.create();
    *session.executor_type.lock().unwrap() = "ssh".to_string();

    match SshTerminal::connect(&config, 80, 24).await {
        Ok(terminal) => {
            let ssh_handle = terminal.session_handle.clone();
            *session.ssh_exec_handle.lock().await = Some(Box::new(ssh_handle.clone()));

            crate::server::session::Session::start_terminal(
                session.clone(),
                Box::new(terminal),
            )
            .await;

            // Initialize SFTP in background
            let session_bg = session.clone();
            tokio::spawn(async move {
                if let Some(sftp_client) = SshTerminal::init_sftp(&ssh_handle).await {
                    *session_bg.sftp.lock().unwrap() = Some(sftp_client);
                }
            });
        }
        Err(e) => {
            // Host key errors are JSON-encoded — return as Ok so frontend can parse them
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&e) {
                if parsed.get("error").and_then(|v| v.as_str()) == Some("host_key_unknown") {
                    return Ok(parsed.to_string());
                }
            }
            return Err(format!("SSH failed: {}", e));
        }
    }

    Ok(serde_json::json!({
        "id": session.id,
        "created_at": format!("{:?}", session.created_at),
        "state": session.state_string(),
        "executor_type": "ssh",
    })
    .to_string())
}

#[tauri::command]
pub async fn test_ssh_connection(
    host: String,
    port: u16,
    username: String,
    #[allow(unused)] auth_method: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    trusted_fingerprint: Option<String>,
    proxy_type: Option<String>,
    proxy_host: Option<String>,
    proxy_port: Option<u16>,
    proxy_username: Option<String>,
    proxy_password: Option<String>,
) -> Result<String, String> {
    if host.is_empty() || username.is_empty() {
        return Ok(serde_json::json!({ "ok": false, "error": "host and username are required" }).to_string());
    }

    let config = SshConfig {
        host,
        port,
        username,
        password: password.unwrap_or_default(),
        private_key: private_key.unwrap_or_default(),
        passphrase: passphrase.unwrap_or_default(),
        trusted_fingerprint: trusted_fingerprint.unwrap_or_default(),
        disable_hook: false,
        proxy_type: proxy_type.unwrap_or_default(),
        proxy_host: proxy_host.unwrap_or_default(),
        proxy_port: proxy_port.unwrap_or(0),
        proxy_username: proxy_username.unwrap_or_default(),
        proxy_password: proxy_password.unwrap_or_default(),
    };

    match crate::server::terminal::ssh::test_connection(&config).await {
        Ok(()) => Ok(serde_json::json!({ "ok": true }).to_string()),
        Err(e) => {
            // Host key errors are JSON-encoded
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&e) {
                if parsed.get("error").and_then(|v| v.as_str()) == Some("host_key_unknown") {
                    return Ok(parsed.to_string());
                }
            }
            Ok(serde_json::json!({ "ok": false, "error": e }).to_string())
        }
    }
}
