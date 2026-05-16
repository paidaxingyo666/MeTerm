use std::sync::Arc;
use tauri::State;

use crate::server::terminal::ssh::{
    default_ssh_key_path, probe_ssh_agent, SshAgentStatus, SshAuthMethod, SshAuthUsed, SshConfig,
    SshTerminal,
};
use crate::server::ServerState;

fn auth_used_str(used: SshAuthUsed) -> &'static str {
    match used {
        SshAuthUsed::Password => "password",
        SshAuthUsed::KeyExplicit => "key_explicit",
        SshAuthUsed::Agent => "agent",
        SshAuthUsed::KeyDefault => "key_default",
    }
}

#[tauri::command]
pub async fn create_ssh_session(
    state: State<'_, Arc<ServerState>>,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    trusted_fingerprint: Option<String>,
    skip_shell_hook: Option<bool>,
    multiplex_sftp: Option<bool>,
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
        auth_method: SshAuthMethod::from_str_lossy(&auth_method),
        password: password.unwrap_or_default(),
        private_key: private_key.unwrap_or_default(),
        passphrase: passphrase.unwrap_or_default(),
        trusted_fingerprint: trusted_fingerprint.unwrap_or_default(),
        disable_hook: skip_shell_hook.unwrap_or(false),
        multiplex_sftp: multiplex_sftp.unwrap_or(false),
        proxy_type: proxy_type.unwrap_or_default(),
        proxy_host: proxy_host.unwrap_or_default(),
        proxy_port: proxy_port.unwrap_or(0),
        proxy_username: proxy_username.unwrap_or_default(),
        proxy_password: proxy_password.unwrap_or_default(),
    };

    let session = state.session_manager.create();
    *session.executor_type.lock().unwrap() = "ssh".to_string();
    *session.ssh_config.lock().unwrap() = Some(config.clone());

    let auth_used = match SshTerminal::connect(&config, 80, 24).await {
        Ok(terminal) => {
            let ssh_handle = terminal.session_handle.clone();
            let sftp_config = config.clone();
            let auth_used = terminal.auth_used;
            *session.ssh_exec_handle.lock().await = Some(Box::new(ssh_handle.clone()));

            crate::server::session::Session::start_terminal(session.clone(), Box::new(terminal))
                .await;

            // Initialize SFTP in background. Two strategies:
            //   • multiplex_sftp = true (JumpServer, "JMS-{token}" sessions):
            //       sub-channel on the existing authenticated session.
            //       Required because Koko tokens are protocol-scoped and a
            //       second SSH auth with the same token is rejected.
            //   • multiplex_sftp = false (plain OpenSSH default):
            //       new dedicated SSH session with a wider window, so bulk
            //       SFTP does not stall the interactive terminal.
            //
            // On failure we stash the reason on the Session so the next
            // file-list request can surface it instead of a generic
            // "SFTP_NOT_AVAILABLE, please retry".
            let session_bg = session.clone();
            let multiplex = sftp_config.multiplex_sftp;
            let ssh_handle_for_sftp = ssh_handle.clone();
            tokio::spawn(async move {
                let result = if multiplex {
                    SshTerminal::init_sftp(&ssh_handle_for_sftp).await
                } else {
                    SshTerminal::connect_sftp(&sftp_config).await
                };
                match result {
                    Ok(sftp_client) => {
                        *session_bg.sftp.lock().unwrap() = Some(sftp_client);
                    }
                    Err(e) => {
                        eprintln!("[ssh] SFTP setup failed: {}", e);
                        *session_bg.sftp_init_error.lock().unwrap() = Some(e);
                    }
                }
            });
            auth_used
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
    };

    Ok(serde_json::json!({
        "id": session.id,
        "created_at": format!("{:?}", session.created_at),
        "state": session.state_string(),
        "executor_type": "ssh",
        "auth_method_used": auth_used_str(auth_used),
    })
    .to_string())
}

#[tauri::command]
pub async fn test_ssh_connection(
    host: String,
    port: u16,
    username: String,
    auth_method: String,
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
        return Ok(
            serde_json::json!({ "ok": false, "error": "host and username are required" })
                .to_string(),
        );
    }

    let config = SshConfig {
        host,
        port,
        username,
        auth_method: SshAuthMethod::from_str_lossy(&auth_method),
        password: password.unwrap_or_default(),
        private_key: private_key.unwrap_or_default(),
        passphrase: passphrase.unwrap_or_default(),
        trusted_fingerprint: trusted_fingerprint.unwrap_or_default(),
        disable_hook: false,
        multiplex_sftp: false,
        proxy_type: proxy_type.unwrap_or_default(),
        proxy_host: proxy_host.unwrap_or_default(),
        proxy_port: proxy_port.unwrap_or(0),
        proxy_username: proxy_username.unwrap_or_default(),
        proxy_password: proxy_password.unwrap_or_default(),
    };

    match crate::server::terminal::ssh::test_connection(&config).await {
        Ok(used) => Ok(serde_json::json!({
            "ok": true,
            "auth_method_used": auth_used_str(used),
        })
        .to_string()),
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

/// Probe the local OpenSSH `~/.ssh/` for a default identity file. Returns
/// the resolved absolute path of the first file the auth ladder would
/// pick, or `null` if none of the conventional names exist.
#[tauri::command]
pub fn detect_default_ssh_key() -> Option<String> {
    default_ssh_key_path().map(|p| p.to_string_lossy().to_string())
}

/// Probe the running ssh-agent (via `$SSH_AUTH_SOCK` on Unix / pageant on
/// Windows). Used by the connection dialog to surface an "agent: N keys"
/// badge so the user knows whether leaving the key path empty will work.
#[tauri::command]
pub async fn check_ssh_agent() -> SshAgentStatus {
    probe_ssh_agent().await
}
