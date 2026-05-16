//! SSH terminal — russh implementation with channel-based I/O.
//!
//! Uses dedicated tasks for reading/writing to avoid Mutex deadlocks
//! and ensure cancel-safety in tokio::select!.

use std::collections::VecDeque;
use std::io;
use std::sync::Arc;

use russh::keys::key;
use russh::{client, ChannelMsg, Disconnect};
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

use super::Terminal;

/// Auth method explicitly selected by the user in the connection dialog.
/// Mirrors the frontend dropdown ("password" / "key"). Stored on the
/// `SshConfig` because we no longer infer the method from `private_key`
/// being empty — empty + `Key` now means "use ssh-agent / default keys"
/// (the OpenSSH ladder) rather than silently falling back to password.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SshAuthMethod {
    Password,
    Key,
}

impl Default for SshAuthMethod {
    fn default() -> Self {
        SshAuthMethod::Password
    }
}

impl SshAuthMethod {
    pub fn from_str_lossy(s: &str) -> Self {
        match s {
            "key" | "Key" => SshAuthMethod::Key,
            _ => SshAuthMethod::Password,
        }
    }
}

/// Which authentication path actually succeeded. Returned from `connect`
/// so the frontend can surface a one-line toast like "已通过 ssh-agent 连接"
/// when the user left the path empty and we auto-detected something.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SshAuthUsed {
    Password,
    /// User-supplied key path / PEM.
    KeyExplicit,
    /// ssh-agent identity matched.
    Agent,
    /// Fell back to one of the OpenSSH default identity files.
    KeyDefault,
}

/// SSH connection configuration.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub auth_method: SshAuthMethod,
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
    /// When true, run SFTP on a sub-channel of the **existing** terminal
    /// SSH session instead of opening a separate authenticated session.
    /// Required for JumpServer Koko, whose connection tokens are
    /// protocol-scoped (and often single-use): a second SSH connection
    /// authenticated with the same `JMS-{token}` credential either
    /// re-auth fails or the `sftp` subsystem is refused on a token that
    /// was minted with `protocol=ssh`. Plain OpenSSH servers don't need
    /// this — leaving it false keeps the bulk-transfer perf optimization
    /// (dedicated connection with a 64MB window).
    #[serde(default)]
    pub multiplex_sftp: bool,
    /// Proxy type: "socks5", "http", or empty for direct connection.
    #[serde(default)]
    pub proxy_type: String,
    #[serde(default)]
    pub proxy_host: String,
    #[serde(default)]
    pub proxy_port: u16,
    #[serde(default)]
    pub proxy_username: String,
    #[serde(default)]
    pub proxy_password: String,
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
            Ok(true) => return Ok(true),
            Err(russh_keys::Error::KeyChanged { line }) => {
                // Host key changed — possible MITM, but allow if user has a
                // trusted fingerprint (e.g. dedicated SFTP connection may
                // negotiate a different key algorithm than the terminal session).
                eprintln!(
                    "[ssh] HOST KEY CHANGED for {}:{} at known_hosts line {}",
                    host, port, line
                );
                // Fall through to Layer 2 (trusted fingerprint check) instead
                // of rejecting immediately. If no trusted fingerprint, Layer 3
                // will reject.
            }
            _ => {} // Not found or other error — continue to layer 2
        }

        // Layer 2: Check TrustedFingerprint (user previously confirmed in UI)
        // Accept if a non-empty trusted fingerprint exists — the user has already
        // confirmed trust for this host. The fingerprint may differ because the
        // terminal and SFTP connections can negotiate different key algorithms.
        if let Some(ref trusted) = self.trusted_fingerprint {
            if !trusted.is_empty() {
                if fingerprint == *trusted {
                    // Exact match — also update known_hosts for this key type
                    if let Err(e) =
                        russh_keys::known_hosts::learn_known_hosts(&host, port, server_public_key)
                    {
                        eprintln!("[ssh] warning: could not write known_hosts: {}", e);
                    }
                }
                // Trust is established for this host (user confirmed via UI)
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
    /// Buffered tail from an oversized SSH packet that did not fit in the
    /// caller-provided read buffer.
    pending_output: Mutex<VecDeque<u8>>,
    /// Sender for SSH input (to dedicated writer task).
    input_tx: mpsc::Sender<Vec<u8>>,
    /// Sender for resize commands.
    resize_tx: mpsc::Sender<(u16, u16)>,
    /// Session handle — shared Arc so Session can open exec channels for ServerInfo.
    pub session_handle: Arc<Mutex<Option<client::Handle<SshHandler>>>>,
    done_token: CancellationToken,
    /// SFTP client for file operations (if available).
    pub sftp: Option<Arc<russh_sftp::client::SftpSession>>,
    /// Which auth path actually succeeded. Surfaces "auto" outcomes
    /// (agent / default key) so the UI can confirm what happened when
    /// the user left the key path empty.
    pub auth_used: SshAuthUsed,
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

fn terminal_client_config() -> client::Config {
    client::Config {
        // A larger channel window improves SFTP throughput, but we keep the
        // default packet size to avoid terminal packet truncation and server
        // compatibility issues.
        window_size: 16 * 1024 * 1024,
        ..client::Config::default()
    }
}

fn sftp_client_config() -> client::Config {
    client::Config {
        // Dedicated SFTP sessions do not feed the terminal read buffer, so we
        // can safely use a wider SSH packet and window to reduce framing
        // overhead on large transfers.
        window_size: 64 * 1024 * 1024,
        maximum_packet_size: 65535,
        ..client::Config::default()
    }
}

/// Turn the frontend's `private_key` field into a PEM blob suitable for
/// `russh_keys::decode_secret_key`.
///
/// The UI surfaces a single-line text input with placeholder
/// `~/.ssh/id_rsa`, so the value is virtually always a path. We also
/// accept a literal PEM (detected via the `-----BEGIN ` header) so a
/// future textarea / file-loader path keeps working without another
/// backend change.
///
/// Security model carried over from the old Go executor:
///   - `~` and `~/foo` expand to the user's home directory.
///   - The resolved path must be absolute and contain no `..` segments.
///   - The resolved path must live under the user's home directory.
///     This prevents an attacker who controls the frontend payload from
///     coaxing the backend into reading `/etc/passwd`, AWS creds, etc.
///
/// Sync rather than async because the read is a single small file and
/// both call sites (russh terminal auth + ssh2 SFTP auth in
/// `commands/transfer.rs`) live on the same one-shot connect path.
pub fn resolve_private_key_pem(input: &str) -> Result<String, String> {
    let trimmed = input.trim();

    // Already a PEM blob — pass through.
    if trimmed.starts_with("-----BEGIN ") {
        return Ok(trimmed.to_string());
    }

    let raw_path = if trimmed.is_empty() {
        "~/.ssh/id_rsa"
    } else {
        trimmed
    };

    let home = dirs::home_dir().ok_or_else(|| "cannot determine home directory".to_string())?;
    let expanded: std::path::PathBuf = if raw_path == "~" {
        home.clone()
    } else if let Some(rest) = raw_path.strip_prefix("~/") {
        home.join(rest)
    } else {
        std::path::PathBuf::from(raw_path)
    };

    for comp in expanded.components() {
        if comp == std::path::Component::ParentDir {
            return Err(format!(
                "private key path must not contain '..': {}",
                expanded.display()
            ));
        }
    }

    if !expanded.is_absolute() {
        return Err(format!(
            "private key path must be absolute: {}",
            expanded.display()
        ));
    }

    if !expanded.starts_with(&home) {
        return Err(format!(
            "private key path must be within home directory: {}",
            expanded.display()
        ));
    }

    std::fs::read_to_string(&expanded)
        .map_err(|e| format!("read private key {}: {}", expanded.display(), e))
}

/// OpenSSH client default identity filenames, in the order the upstream
/// client tries them. Same list is hard-coded in `ssh-keygen` and OpenSSH
/// internals — keep them aligned so "leave key path empty" behaves like
/// the user running plain `ssh user@host` from a terminal.
pub const DEFAULT_KEY_FILES: &[&str] = &["id_ed25519", "id_ecdsa", "id_rsa", "id_dsa"];

/// Return the first existing default SSH identity under `~/.ssh/`, or
/// `None` if no conventional key is present. Used by the frontend to
/// populate a dynamic placeholder ("leave empty to use ~/.ssh/id_ed25519")
/// and by the auth ladder as the file fallback after ssh-agent.
pub fn default_ssh_key_path() -> Option<std::path::PathBuf> {
    let ssh_dir = dirs::home_dir()?.join(".ssh");
    for name in DEFAULT_KEY_FILES {
        let p = ssh_dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Snapshot of the local ssh-agent — used by the frontend to decide
/// whether to surface an "agent: N keys" badge next to the auth method
/// toggle. `available=false` means we couldn't open `$SSH_AUTH_SOCK`
/// (or pageant on Windows); a frontend should fall back to the static
/// "no agent" hint without erroring out.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SshAgentStatus {
    pub available: bool,
    pub key_count: usize,
    /// Short reason when unavailable (e.g. "SSH_AUTH_SOCK not set"). Empty on success.
    pub reason: String,
}

pub async fn probe_ssh_agent() -> SshAgentStatus {
    match russh_keys::agent::client::AgentClient::connect_env().await {
        Ok(mut agent) => match agent.request_identities().await {
            Ok(ids) => SshAgentStatus {
                available: true,
                key_count: ids.len(),
                reason: String::new(),
            },
            Err(e) => SshAgentStatus {
                available: false,
                key_count: 0,
                reason: format!("agent reachable but request_identities failed: {}", e),
            },
        },
        Err(e) => SshAgentStatus {
            available: false,
            key_count: 0,
            reason: format!("{}", e),
        },
    }
}

/// Walk the OpenSSH-style identity ladder when the user opted for key
/// auth but left the path empty:
///   1. ssh-agent (if `$SSH_AUTH_SOCK` is set and lists identities)
///   2. `~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa`, `id_dsa` in that order
///
/// Returns the auth method that succeeded, or an `Err` aggregating what
/// was tried so the user can debug their key setup. **Does not** fall
/// back to password — the user explicitly chose key auth.
async fn try_default_key_ladder(
    session: &mut client::Handle<SshHandler>,
    username: &str,
) -> Result<SshAuthUsed, String> {
    let mut diagnostics: Vec<String> = Vec::new();

    // 1) ssh-agent
    match russh_keys::agent::client::AgentClient::connect_env().await {
        Ok(mut agent) => match agent.request_identities().await {
            Ok(identities) if !identities.is_empty() => {
                let id_count = identities.len();
                let mut signer = agent;
                for identity in identities {
                    let (returned, result) = session
                        .authenticate_future(username, identity, signer)
                        .await;
                    signer = returned;
                    match result {
                        Ok(true) => return Ok(SshAuthUsed::Agent),
                        Ok(false) => {} // try next identity
                        Err(e) => diagnostics.push(format!("agent signer: {}", e)),
                    }
                }
                diagnostics.push(format!(
                    "ssh-agent: server rejected all {} identities",
                    id_count
                ));
            }
            Ok(_) => diagnostics.push("ssh-agent: no identities loaded".to_string()),
            Err(e) => diagnostics.push(format!("ssh-agent identities: {}", e)),
        },
        Err(e) => diagnostics.push(format!("ssh-agent: {}", e)),
    }

    // 2) Default identity files. Skip non-existent without complaining;
    //    only report parse / auth errors so the diagnostic stays focused
    //    on real problems.
    if let Some(ssh_dir) = dirs::home_dir().map(|h| h.join(".ssh")) {
        for name in DEFAULT_KEY_FILES {
            let path = ssh_dir.join(name);
            if !path.is_file() {
                continue;
            }
            let pem = match std::fs::read_to_string(&path) {
                Ok(s) => s,
                Err(e) => {
                    diagnostics.push(format!("{}: read failed: {}", name, e));
                    continue;
                }
            };
            // Encrypted default keys without a passphrase can't be unlocked
            // here — surface a hint and move on so other defaults still
            // get a chance.
            let key_pair = match russh_keys::decode_secret_key(&pem, None) {
                Ok(k) => k,
                Err(e) => {
                    diagnostics.push(format!("{}: decode failed: {}", name, e));
                    continue;
                }
            };
            match session
                .authenticate_publickey(username, Arc::new(key_pair))
                .await
            {
                Ok(true) => return Ok(SshAuthUsed::KeyDefault),
                Ok(false) => diagnostics.push(format!("{}: server rejected", name)),
                Err(e) => diagnostics.push(format!("{}: auth error: {}", name, e)),
            }
        }
    }

    Err(format!(
        "no usable SSH identity found (tried: {})",
        if diagnostics.is_empty() {
            "ssh-agent + ~/.ssh defaults".to_string()
        } else {
            diagnostics.join("; ")
        }
    ))
}

async fn connect_authenticated_session(
    config: &SshConfig,
    client_config: client::Config,
) -> Result<(client::Handle<SshHandler>, SshAuthUsed), String> {
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

    let stream = establish_connection(config).await?;
    let mut session = match client::connect_stream(Arc::new(client_config), stream, handler).await {
        Ok(s) => s,
        Err(e) => {
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

    let (auth_ok, auth_used) = match config.auth_method {
        SshAuthMethod::Password => {
            let ok = session
                .authenticate_password(&config.username, &config.password)
                .await
                .map_err(|e| format!("password auth: {}", e))?;
            (ok, SshAuthUsed::Password)
        }
        SshAuthMethod::Key if config.private_key.trim().is_empty() => {
            // Empty path + key mode = OpenSSH-style "auto": ssh-agent then
            // default identity files. We do NOT fall back to password —
            // the user explicitly picked key auth.
            let used = try_default_key_ladder(&mut session, &config.username).await?;
            (true, used)
        }
        SshAuthMethod::Key => {
            let passphrase = if config.passphrase.is_empty() {
                None
            } else {
                Some(config.passphrase.as_str())
            };
            // Frontend sends a path (placeholder hints `~/.ssh/id_rsa`); the
            // single-line <input> can't hold a real PEM. resolve_private_key_pem
            // accepts either a path (preferred) or an inline PEM string for
            // forward-compat, and mirrors the old Go backend's home-dir sandbox.
            let pem = resolve_private_key_pem(&config.private_key)?;
            let key_pair = russh_keys::decode_secret_key(&pem, passphrase)
                .map_err(|e| format!("invalid key: {}", e))?;
            let ok = session
                .authenticate_publickey(&config.username, Arc::new(key_pair))
                .await
                .map_err(|e| format!("key auth: {}", e))?;
            (ok, SshAuthUsed::KeyExplicit)
        }
    };

    if !auth_ok {
        return Err("authentication failed".to_string());
    }

    Ok((session, auth_used))
}

impl SshTerminal {
    pub async fn connect(config: &SshConfig, cols: u16, rows: u16) -> Result<Self, String> {
        let (session, auth_used) =
            connect_authenticated_session(config, terminal_client_config()).await?;

        // Open channel
        let mut channel = session
            .channel_open_session()
            .await
            .map_err(|e| format!("channel open: {}", e))?;

        // ECHO OFF for invisible hook injection. The hook ends with `stty echo`
        // to restore echo before the first prompt. OSC sequences produced by the
        // hook are intercepted by Rust OscFilter, so this is safe on all platforms.
        let terminal_modes = if config.disable_hook {
            vec![
                (russh::Pty::ECHO, 1),
                (russh::Pty::TTY_OP_ISPEED, 14400),
                (russh::Pty::TTY_OP_OSPEED, 14400),
            ]
        } else {
            vec![
                (russh::Pty::ECHO, 0),
                (russh::Pty::TTY_OP_ISPEED, 14400),
                (russh::Pty::TTY_OP_OSPEED, 14400),
            ]
        };
        channel
            .request_pty(
                false,
                "xterm-256color",
                cols as u32,
                rows as u32,
                0,
                0,
                &terminal_modes,
            )
            .await
            .map_err(|e| format!("request pty: {}", e))?;

        channel
            .request_shell(false)
            .await
            .map_err(|e| format!("request shell: {}", e))?;

        // Inject shell hook immediately (ECHO is off, so it's invisible).
        // The hook sends OSC 7/7766/7768 before each prompt for CWD tracking
        // and command history. `stty echo` at the end restores echo.
        // OSC sequences are intercepted by Rust OscFilter — safe on all platforms.
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
                                if output_tx.send(Ok(data.to_vec())).await.is_err() {
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

        Ok(Self {
            output_rx: Mutex::new(output_rx),
            pending_output: Mutex::new(VecDeque::new()),
            input_tx,
            resize_tx,
            session_handle: Arc::new(Mutex::new(Some(session))),
            done_token,
            sftp: None,
            auth_used,
        })
    }

    /// Initialize SFTP on a sub-channel of the **existing** authenticated
    /// SSH session. Returns either the SFTP client or a human-readable
    /// failure reason that the dispatch layer can surface to the UI.
    pub async fn init_sftp(
        session_handle: &Arc<Mutex<Option<client::Handle<SshHandler>>>>,
    ) -> Result<Arc<russh_sftp::client::SftpSession>, String> {
        let mut guard = session_handle.lock().await;
        let session = guard.as_mut().ok_or_else(|| {
            "SFTP init: terminal session is no longer available".to_string()
        })?;

        let sftp_channel = session
            .channel_open_session()
            .await
            .map_err(|e| format!("SFTP channel open: {}", e))?;

        sftp_channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("SFTP subsystem request: {}", e))?;

        let sftp = russh_sftp::client::SftpSession::new(sftp_channel.into_stream())
            .await
            .map_err(|e| format!("SFTP session init: {}", e))?;
        eprintln!("[ssh] SFTP subsystem initialized (multiplexed on terminal session)");
        Ok(Arc::new(sftp))
    }

    /// Initialize SFTP on a **dedicated** SSH connection so bulk file
    /// transfers do not compete with the interactive terminal channel.
    /// Returns either the SFTP client or a human-readable failure reason.
    pub async fn connect_sftp(
        config: &SshConfig,
    ) -> Result<Arc<russh_sftp::client::SftpSession>, String> {
        let (session, _auth_used) =
            connect_authenticated_session(config, sftp_client_config())
                .await
                .map_err(|e| format!("dedicated SFTP connect: {}", e))?;

        let sftp_channel = session
            .channel_open_session()
            .await
            .map_err(|e| format!("dedicated SFTP channel open: {}", e))?;

        sftp_channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("dedicated SFTP subsystem request: {}", e))?;

        let sftp = russh_sftp::client::SftpSession::new(sftp_channel.into_stream())
            .await
            .map_err(|e| format!("dedicated SFTP session init: {}", e))?;
        eprintln!("[ssh] dedicated SFTP subsystem initialized");
        Ok(Arc::new(sftp))
    }
}

#[async_trait::async_trait]
impl Terminal for SshTerminal {
    async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        {
            let mut pending = self.pending_output.lock().await;
            if !pending.is_empty() {
                let n = buf.len().min(pending.len());
                for (dst, byte) in buf[..n].iter_mut().zip(pending.drain(..n)) {
                    *dst = byte;
                }
                return Ok(n);
            }
        }

        let msg = {
            let mut rx = self.output_rx.lock().await;
            rx.recv().await
        };

        match msg {
            Some(Ok(data)) => {
                if data.is_empty() {
                    return Ok(0); // EOF
                }
                let n = data.len().min(buf.len());
                buf[..n].copy_from_slice(&data[..n]);
                if data.len() > n {
                    let mut pending = self.pending_output.lock().await;
                    pending.extend(&data[n..]);
                }
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
            let _ = session
                .disconnect(Disconnect::ByApplication, "", "en")
                .await;
        }
        self.done_token.cancel();
        Ok(())
    }
}

/// Test SSH connection.
pub async fn test_connection(config: &SshConfig) -> Result<SshAuthUsed, String> {
    let term = SshTerminal::connect(config, 80, 24).await?;
    let auth_used = term.auth_used;
    term.close().await.map_err(|e| e.to_string())?;
    Ok(auth_used)
}

// ---------------------------------------------------------------------------
// Proxy connection helpers
// ---------------------------------------------------------------------------

/// TCP connect timeout in seconds.
const TCP_CONNECT_TIMEOUT_SECS: u64 = 8;

/// Establish a TCP connection to the SSH target, optionally through a proxy.
async fn establish_connection(config: &SshConfig) -> Result<tokio::net::TcpStream, String> {
    let target = format!("{}:{}", config.host, config.port);
    let timeout = std::time::Duration::from_secs(TCP_CONNECT_TIMEOUT_SECS);

    let fut: std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<tokio::net::TcpStream, String>> + Send>,
    > = match config.proxy_type.as_str() {
        "socks5" => Box::pin(connect_via_socks5(config, &target)),
        "http" => Box::pin(connect_via_http_connect(config, &target)),
        _ => Box::pin(connect_direct(&target)),
    };

    match tokio::time::timeout(timeout, fut).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "connection timed out ({}s): host {} unreachable",
            TCP_CONNECT_TIMEOUT_SECS, target
        )),
    }
}

/// Direct TCP connection (no proxy).
async fn connect_direct(target: &str) -> Result<tokio::net::TcpStream, String> {
    tokio::net::TcpStream::connect(target)
        .await
        .map_err(|e| format!("TCP connect {}: {}", target, e))
}

/// Connect through a SOCKS5 proxy.
async fn connect_via_socks5(
    config: &SshConfig,
    target: &str,
) -> Result<tokio::net::TcpStream, String> {
    let proxy_addr = format!(
        "{}:{}",
        if config.proxy_host.is_empty() {
            "127.0.0.1"
        } else {
            &config.proxy_host
        },
        if config.proxy_port == 0 {
            1080
        } else {
            config.proxy_port
        },
    );

    let stream = if !config.proxy_username.is_empty() {
        tokio_socks::tcp::Socks5Stream::connect_with_password(
            proxy_addr.as_str(),
            target,
            &config.proxy_username,
            &config.proxy_password,
        )
        .await
        .map_err(|e| format!("SOCKS5 proxy {}: {}", proxy_addr, e))?
    } else {
        tokio_socks::tcp::Socks5Stream::connect(proxy_addr.as_str(), target)
            .await
            .map_err(|e| format!("SOCKS5 proxy {}: {}", proxy_addr, e))?
    };

    Ok(stream.into_inner())
}

/// Connect through an HTTP CONNECT proxy.
async fn connect_via_http_connect(
    config: &SshConfig,
    target: &str,
) -> Result<tokio::net::TcpStream, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let proxy_addr = format!(
        "{}:{}",
        if config.proxy_host.is_empty() {
            "127.0.0.1"
        } else {
            &config.proxy_host
        },
        if config.proxy_port == 0 {
            8080
        } else {
            config.proxy_port
        },
    );

    let mut stream = tokio::net::TcpStream::connect(&proxy_addr)
        .await
        .map_err(|e| format!("HTTP proxy connect {}: {}", proxy_addr, e))?;

    // Build CONNECT request
    let mut request = format!("CONNECT {} HTTP/1.1\r\nHost: {}\r\n", target, target);
    if !config.proxy_username.is_empty() {
        use base64::Engine;
        let credentials = format!("{}:{}", config.proxy_username, config.proxy_password);
        let encoded = base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes());
        request.push_str(&format!("Proxy-Authorization: Basic {}\r\n", encoded));
    }
    request.push_str("\r\n");

    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("HTTP CONNECT send: {}", e))?;

    // Read response (just need "HTTP/1.x 200")
    let mut buf = [0u8; 1024];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("HTTP CONNECT read: {}", e))?;

    let response = String::from_utf8_lossy(&buf[..n]);
    if !response.contains("200") {
        let first_line = response.lines().next().unwrap_or(&response);
        return Err(format!("HTTP CONNECT failed: {}", first_line));
    }

    Ok(stream)
}
