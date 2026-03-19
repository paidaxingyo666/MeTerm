//! SSH terminal — russh implementation with channel-based I/O.
//!
//! Uses dedicated tasks for reading/writing to avoid Mutex deadlocks
//! and ensure cancel-safety in tokio::select!.

use std::io;
use std::sync::Arc;

use russh::keys::key;
use russh::{client, ChannelMsg, Disconnect};
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

use super::Terminal;

/// SSH connection configuration.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub private_key: String,
    #[serde(default)]
    pub passphrase: String,
    #[serde(default)]
    pub trusted_fingerprint: String,
    #[serde(default)]
    pub disable_hook: bool,
}

pub struct SshHandler {
    trusted_fingerprint: Option<String>,
    host: String,
    port: u16,
    /// Captured fingerprint when host key is unknown (for frontend confirmation).
    server_fingerprint: Arc<Mutex<Option<String>>>,
    server_key_type: Arc<Mutex<Option<String>>>,
}

#[async_trait::async_trait]
impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let key_type = server_public_key.name().to_string();
        // Use russh-keys fingerprint for display (matches SSH standard)
        let fingerprint = server_public_key.fingerprint();
        let host = self.host.clone();
        let port = self.port;

        // Store for error reporting
        *self.server_fingerprint.lock().await = Some(fingerprint.clone());
        *self.server_key_type.lock().await = Some(key_type);

        // Layer 1: Check ~/.ssh/known_hosts (matches Go knownhosts.New)
        match russh_keys::known_hosts::check_known_hosts(&host, port, server_public_key) {
            Ok(true) => return Ok(true),  // Known and matches
            Err(russh_keys::Error::KeyChanged { line }) => {
                // Host key changed — possible MITM (matches Go HostKeyMismatchError)
                eprintln!("[ssh] HOST KEY CHANGED for {}:{} at known_hosts line {}", host, port, line);
                return Ok(false);
            }
            _ => {} // Not found or other error — continue to layer 2
        }

        // Layer 2: Check TrustedFingerprint (user previously confirmed in UI)
        if let Some(ref trusted) = self.trusted_fingerprint {
            if !trusted.is_empty() && fingerprint == *trusted {
                // User confirmed — save to known_hosts for future connections
                if let Err(e) = russh_keys::known_hosts::learn_known_hosts(&host, port, server_public_key) {
                    eprintln!("[ssh] warning: could not write known_hosts: {}", e);
                }
                return Ok(true);
            }
        }

        // Layer 3: Unknown host — reject. connect() returns fingerprint for UI confirmation.
        Ok(false)
    }
}

/// SSH terminal — uses channel-based I/O (cancel-safe).
pub struct SshTerminal {
    /// Receiver for SSH output (from dedicated reader task).
    output_rx: Mutex<mpsc::Receiver<io::Result<Vec<u8>>>>,
    /// Sender for SSH input (to dedicated writer task).
    input_tx: mpsc::Sender<Vec<u8>>,
    /// Sender for resize commands.
    resize_tx: mpsc::Sender<(u16, u16)>,
    /// Session handle — shared Arc so Session can open exec channels for ServerInfo.
    pub session_handle: Arc<Mutex<Option<client::Handle<SshHandler>>>>,
    done_token: CancellationToken,
    /// SFTP client for file operations (if available).
    pub sftp: Option<Arc<russh_sftp::client::SftpSession>>,
}

/// Execute a command on the SSH server via a new exec channel.
/// Used for ServerInfo (sysinfo script) and process list.
pub async fn ssh_exec(
    session_handle: &Arc<Mutex<Option<client::Handle<SshHandler>>>>,
    command: &str,
    timeout_secs: u64,
) -> Result<String, String> {
    let mut guard = session_handle.lock().await;
    let session = guard.as_mut().ok_or("SSH session not available")?;

    let mut channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("exec channel: {}", e))?;

    channel
        .exec(true, command)
        .await
        .map_err(|e| format!("exec: {}", e))?;

    // Collect output with timeout
    let mut output = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }

        match tokio::time::timeout(remaining, channel.wait()).await {
            Ok(Some(ChannelMsg::Data { data })) => {
                output.extend_from_slice(&data);
            }
            Ok(Some(ChannelMsg::ExtendedData { data, .. })) => {
                output.extend_from_slice(&data);
            }
            Ok(Some(ChannelMsg::Eof)) | Ok(None) => break,
            Ok(_) => continue,
            Err(_) => break, // timeout
        }
    }

    String::from_utf8(output).map_err(|e| format!("utf8: {}", e))
}

impl SshTerminal {
    pub async fn connect(config: &SshConfig, cols: u16, rows: u16) -> Result<Self, String> {
        let ssh_config = client::Config::default();
        let server_fingerprint = Arc::new(Mutex::new(None));
        let server_key_type = Arc::new(Mutex::new(None));
        let handler = SshHandler {
            trusted_fingerprint: if config.trusted_fingerprint.is_empty() {
                None
            } else {
                Some(config.trusted_fingerprint.clone())
            },
            host: config.host.clone(),
            port: config.port,
            server_fingerprint: server_fingerprint.clone(),
            server_key_type: server_key_type.clone(),
        };

        let addr = format!("{}:{}", config.host, config.port);
        let mut session = match client::connect(Arc::new(ssh_config), &addr, handler).await {
            Ok(s) => s,
            Err(e) => {
                // Check if we captured a fingerprint — return structured error for frontend
                let fp = server_fingerprint.lock().await.clone();
                let kt = server_key_type.lock().await.clone();
                if let (Some(fingerprint), Some(key_type)) = (fp, kt) {
                    let err = serde_json::json!({
                        "error": "host_key_unknown",
                        "hostname": format!("{}:{}", config.host, config.port),
                        "fingerprint": fingerprint,
                        "key_type": key_type,
                        "message": format!("The authenticity of host '{}:{}' can't be established.\n{} key fingerprint is {}.", config.host, config.port, key_type, fingerprint),
                    });
                    return Err(err.to_string());
                }
                return Err(format!("SSH connect: {}", e));
            }
        };

        // Authenticate
        let auth_ok = if !config.private_key.is_empty() {
            let passphrase = if config.passphrase.is_empty() {
                None
            } else {
                Some(config.passphrase.as_str())
            };
            let key_pair = russh_keys::decode_secret_key(&config.private_key, passphrase)
                .map_err(|e| format!("invalid key: {}", e))?;
            session
                .authenticate_publickey(&config.username, Arc::new(key_pair))
                .await
                .map_err(|e| format!("key auth: {}", e))?
        } else {
            session
                .authenticate_password(&config.username, &config.password)
                .await
                .map_err(|e| format!("password auth: {}", e))?
        };

        if !auth_ok {
            return Err("authentication failed".to_string());
        }

        // Open channel
        let mut channel = session
            .channel_open_session()
            .await
            .map_err(|e| format!("channel open: {}", e))?;

        // Request PTY with ECHO off so hook injection is invisible.
        // The hook ends with `stty echo` to re-enable echo before first prompt.
        // Matches Go ssh.go behavior.
        let terminal_modes = if config.disable_hook {
            // JumpServer: keep echo on, no hook
            vec![(russh::Pty::ECHO, 1), (russh::Pty::TTY_OP_ISPEED, 14400), (russh::Pty::TTY_OP_OSPEED, 14400)]
        } else {
            // Normal: echo off for invisible hook injection
            vec![(russh::Pty::ECHO, 0), (russh::Pty::TTY_OP_ISPEED, 14400), (russh::Pty::TTY_OP_OSPEED, 14400)]
        };
        channel
            .request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &terminal_modes)
            .await
            .map_err(|e| format!("request pty: {}", e))?;

        channel
            .request_shell(false)
            .await
            .map_err(|e| format!("request shell: {}", e))?;

        // Inject shell hook invisibly (ECHO is off).
        // Sends OSC 7 (CWD), OSC 7766 (shell type), OSC 7768 (shell state) before each prompt.
        // Leading space prevents shell history. `stty echo` at the end restores echo.
        if !config.disable_hook {
            let hook = " __meterm_precmd(){ \
                local e=$?; local c; \
                if [ -z \"$__meterm_hook_ready\" ]; then \
                export __meterm_hook_ready=1; \
                if [ -n \"$ZSH_VERSION\" ]; then printf '\\033]7766;meterm_init;1\\007'; \
                elif [ -n \"$BASH_VERSION\" ]; then printf '\\033]7766;meterm_init;0\\007'; fi; \
                c=''; \
                else c=$(fc -ln -1 2>/dev/null); fi; \
                printf '\\033]7;file://%s%s\\007' \"$(hostname)\" \"$PWD\"; \
                printf '\\033]7768;%d;%s;%s\\007' \"$e\" \"$PWD\" \"$c\"; \
                }; \
                if [ -n \"$ZSH_VERSION\" ]; then \
                autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __meterm_precmd; \
                elif [ -n \"$BASH_VERSION\" ]; then \
                PROMPT_COMMAND=\"__meterm_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"; fi; \
                printf '\\033[A\\033[2K\\r'; stty echo\n";
            let _ = channel.data(hook.as_bytes()).await;
        }

        let done_token = CancellationToken::new();

        // Split channel into reader task and writer task via channels.
        let (output_tx, output_rx) = mpsc::channel::<io::Result<Vec<u8>>>(64);
        let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(256);
        let (resize_tx, mut resize_rx) = mpsc::channel::<(u16, u16)>(16);

        let done_clone = done_token.clone();

        // Single task that owns the channel and handles read/write/resize
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = done_clone.cancelled() => break,

                    // Read from SSH channel
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => {
                                let chunk = data.to_vec();
                                if output_tx.send(Ok(chunk)).await.is_err() {
                                    break;
                                }
                            }
                            Some(ChannelMsg::ExtendedData { data, ext: 1 }) => {
                                // stderr
                                let chunk = data.to_vec();
                                if output_tx.send(Ok(chunk)).await.is_err() {
                                    break;
                                }
                            }
                            Some(ChannelMsg::Eof) | None => {
                                let _ = output_tx.send(Ok(Vec::new())).await; // EOF
                                break;
                            }
                            _ => continue,
                        }
                    }

                    // Write input to SSH channel
                    Some(data) = input_rx.recv() => {
                        if let Err(e) = channel.data(&data[..]).await {
                            eprintln!("[ssh] write error: {}", e);
                        }
                    }

                    // Resize
                    Some((cols, rows)) = resize_rx.recv() => {
                        let _ = channel.window_change(cols as u32, rows as u32, 0, 0).await;
                    }
                }
            }
            let _ = channel.close().await;
        });

        // Open a second channel for SFTP file operations
        let sftp = match session.channel_open_session().await {
            Ok(sftp_channel) => {
                match sftp_channel.request_subsystem(true, "sftp").await {
                    Ok(()) => {
                        match russh_sftp::client::SftpSession::new(sftp_channel.into_stream()).await {
                            Ok(s) => {
                                eprintln!("[ssh] SFTP subsystem initialized");
                                Some(Arc::new(s))
                            }
                            Err(e) => {
                                eprintln!("[ssh] SFTP session failed: {}", e);
                                None
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[ssh] SFTP subsystem request failed: {}", e);
                        None
                    }
                }
            }
            Err(e) => {
                eprintln!("[ssh] SFTP channel open failed: {}", e);
                None
            }
        };

        Ok(Self {
            output_rx: Mutex::new(output_rx),
            input_tx,
            resize_tx,
            session_handle: Arc::new(Mutex::new(Some(session))),
            done_token,
            sftp,
        })
    }
}

#[async_trait::async_trait]
impl Terminal for SshTerminal {
    async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        let mut rx = self.output_rx.lock().await;
        match rx.recv().await {
            Some(Ok(data)) => {
                if data.is_empty() {
                    return Ok(0); // EOF
                }
                let n = data.len().min(buf.len());
                buf[..n].copy_from_slice(&data[..n]);
                Ok(n)
            }
            Some(Err(e)) => Err(e),
            None => Ok(0),
        }
    }

    async fn write(&self, data: &[u8]) -> io::Result<usize> {
        self.input_tx
            .send(data.to_vec())
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "input channel closed"))?;
        Ok(data.len())
    }

    fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let _ = self.resize_tx.try_send((cols, rows));
        Ok(())
    }

    fn done(&self) -> CancellationToken {
        self.done_token.clone()
    }

    async fn close(&self) -> io::Result<()> {
        if let Some(session) = self.session_handle.lock().await.take() {
            let _ = session.disconnect(Disconnect::ByApplication, "", "en").await;
        }
        self.done_token.cancel();
        Ok(())
    }
}

/// Test SSH connection.
pub async fn test_connection(config: &SshConfig) -> Result<(), String> {
    let term = SshTerminal::connect(config, 80, 24).await?;
    term.close().await.map_err(|e| e.to_string())?;
    Ok(())
}
