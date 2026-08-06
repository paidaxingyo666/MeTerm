//! SSH terminal — russh implementation with channel-based I/O.
//!
//! Uses dedicated tasks for reading/writing to avoid Mutex deadlocks
//! and ensure cancel-safety in tokio::select!.

use std::collections::VecDeque;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use russh::keys::{self, PublicKey};
use russh::{client, ChannelMsg, Disconnect};
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

use super::ssh_algorithms::preferred_algorithms;
use super::ssh_auth;
pub use super::ssh_limits::ssh_exec;
use super::ssh_limits::{
    operation_with_timeout, SSH_AUTH_TIMEOUT, SSH_CHANNEL_TIMEOUT, SSH_CLOSE_TIMEOUT,
    SSH_HANDSHAKE_TIMEOUT,
};
use super::ssh_transport::establish_connection;
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
#[derive(Clone, serde::Deserialize, serde::Serialize)]
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

// Authentication material must not become printable merely because a caller
// adds `{:?}` to an error or tracing statement. Keep the complete structure
// serializable for its bounded protocol boundary, but make Debug fail safe.
impl std::fmt::Debug for SshConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("SshConfig(redacted)")
    }
}

impl Drop for SshConfig {
    fn drop(&mut self) {
        use zeroize::Zeroize;

        self.password.zeroize();
        self.private_key.zeroize();
        self.passphrase.zeroize();
        self.proxy_password.zeroize();
    }
}

pub struct SshHandler {
    trusted_fingerprint: Option<String>,
    host: String,
    port: u16,
    /// Captured fingerprint when host key is unknown (for frontend confirmation).
    server_fingerprint: Arc<Mutex<Option<String>>>,
    server_key_type: Arc<Mutex<Option<String>>>,
    host_key_rejected: Arc<AtomicBool>,
    host_key_changed: Arc<AtomicBool>,
}

/// A user-confirmed host key is an exact pin, not a blanket approval for the
/// hostname.  In particular, a different key algorithm still needs its own
/// confirmation instead of silently bypassing a changed-key warning.
pub(super) fn trusted_fingerprint_matches(trusted: Option<&str>, actual: &str) -> bool {
    trusted.is_some_and(|value| !value.is_empty() && value == actual)
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let key_type = ssh_auth::key_type(server_public_key);
        let fingerprint = ssh_auth::fingerprint(server_public_key);
        let host = self.host.clone();
        let port = self.port;

        // Store for error reporting
        *self.server_fingerprint.lock().await = Some(fingerprint.clone());
        *self.server_key_type.lock().await = Some(key_type);

        // An explicit fingerprint supplied by the client is authoritative.  It
        // must not be bypassed merely because a separately mutable known_hosts
        // file happens to accept a different key.
        if self
            .trusted_fingerprint
            .as_deref()
            .is_some_and(|v| !v.is_empty())
        {
            if trusted_fingerprint_matches(self.trusted_fingerprint.as_deref(), &fingerprint) {
                if let Err(e) = keys::known_hosts::learn_known_hosts(&host, port, server_public_key)
                {
                    eprintln!("[ssh] warning: could not write known_hosts: {}", e);
                }
                return Ok(true);
            }
            self.host_key_changed.store(true, Ordering::SeqCst);
            self.host_key_rejected.store(true, Ordering::SeqCst);
            return Ok(false);
        }

        // With no explicit pin, fall back to the local OpenSSH trust store.
        match keys::known_hosts::check_known_hosts(&host, port, server_public_key) {
            Ok(true) => Ok(true),
            Err(keys::Error::KeyChanged { line }) => {
                eprintln!(
                    "[ssh] HOST KEY CHANGED for {}:{} at known_hosts line {}",
                    host, port, line
                );
                self.host_key_changed.store(true, Ordering::SeqCst);
                self.host_key_rejected.store(true, Ordering::SeqCst);
                Ok(false)
            }
            _ => {
                self.host_key_rejected.store(true, Ordering::SeqCst);
                Ok(false)
            }
        }
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

fn terminal_client_config() -> client::Config {
    client::Config {
        // A larger channel window improves SFTP throughput, but we keep the
        // default packet size to avoid terminal packet truncation and server
        // compatibility issues.
        window_size: 16 * 1024 * 1024,
        preferred: preferred_algorithms(),
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
        // Must stay in step with `terminal_client_config`: a bastion the
        // terminal can reach must not become unreachable for file transfer.
        preferred: preferred_algorithms(),
        ..client::Config::default()
    }
}

/// Turn the frontend's `private_key` field into a PEM blob suitable for
/// `russh::keys::decode_secret_key`.
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
    // russh's AgentClient::connect_env only exists on Unix — it
    // reads $SSH_AUTH_SOCK. Windows has no equivalent in this crate
    // (pageant would need its own implementation), so we report "not
    // available" and the auth ladder falls through to default key
    // files. Same approach used in try_default_key_ladder below.
    #[cfg(unix)]
    {
        match keys::agent::client::AgentClient::connect_env().await {
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
    #[cfg(not(unix))]
    {
        SshAgentStatus {
            available: false,
            key_count: 0,
            reason: "ssh-agent not supported on this platform".to_string(),
        }
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

    // 1) ssh-agent (Unix only — see probe_ssh_agent for the rationale)
    #[cfg(unix)]
    {
        match keys::agent::client::AgentClient::connect_env().await {
            Ok(mut agent) => match agent.request_identities().await {
                Ok(identities) if !identities.is_empty() => {
                    let id_count = identities.len();
                    let mut signer = agent;
                    for identity in identities {
                        match ssh_auth::authenticate_agent_identity(
                            session,
                            username,
                            identity,
                            &mut signer,
                        )
                        .await
                        {
                            Ok(result) if result.success() => return Ok(SshAuthUsed::Agent),
                            Ok(_) => {} // try next identity
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
    }
    #[cfg(not(unix))]
    {
        let _ = session;
        diagnostics.push("ssh-agent: not supported on this platform".to_string());
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
            let key_pair = match keys::decode_secret_key(&pem, None) {
                Ok(k) => k,
                Err(e) => {
                    diagnostics.push(format!("{}: decode failed: {}", name, e));
                    continue;
                }
            };
            match ssh_auth::authenticate_private_key(session, username, key_pair).await {
                Ok(result) if result.success() => return Ok(SshAuthUsed::KeyDefault),
                Ok(_) => diagnostics.push(format!("{}: server rejected", name)),
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
    let host_key_rejected = Arc::new(AtomicBool::new(false));
    let host_key_changed = Arc::new(AtomicBool::new(false));
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
        host_key_rejected: host_key_rejected.clone(),
        host_key_changed: host_key_changed.clone(),
    };

    let stream = establish_connection(config).await?;
    let connect_result = tokio::time::timeout(
        SSH_HANDSHAKE_TIMEOUT,
        client::connect_stream(Arc::new(client_config), stream, handler),
    )
    .await
    .map_err(|_| {
        format!(
            "SSH handshake timed out after {}s",
            SSH_HANDSHAKE_TIMEOUT.as_secs()
        )
    })?;
    let mut session = match connect_result {
        Ok(s) => s,
        Err(e) => {
            let fp = server_fingerprint.lock().await.clone();
            let kt = server_key_type.lock().await.clone();
            if host_key_rejected.load(Ordering::SeqCst) {
                if let (Some(fingerprint), Some(key_type)) = (fp, kt) {
                    let changed = host_key_changed.load(Ordering::SeqCst);
                    let err = serde_json::json!({
                        "error": if changed { "host_key_mismatch" } else { "host_key_unknown" },
                        "hostname": format!("{}:{}", config.host, config.port),
                        "fingerprint": fingerprint,
                        "key_type": key_type,
                        "message": if changed {
                            format!("The host key for '{}:{}' differs from the previously trusted key. The new {} fingerprint is {}.", config.host, config.port, key_type, fingerprint)
                        } else {
                            format!("The authenticity of host '{}:{}' can't be established.\n{} key fingerprint is {}.", config.host, config.port, key_type, fingerprint)
                        },
                    });
                    return Err(err.to_string());
                }
            }
            return Err(format!("SSH connect: {}", e));
        }
    };

    let auth_attempt = async {
        Ok::<_, String>(match config.auth_method {
            SshAuthMethod::Password => {
                let ok = session
                    .authenticate_password(&config.username, &config.password)
                    .await
                    .map_err(|e| format!("password auth: {}", e))?
                    .success();
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
                let key_pair = keys::decode_secret_key(&pem, passphrase)
                    .map_err(|e| format!("invalid key: {}", e))?;
                let ok =
                    ssh_auth::authenticate_private_key(&mut session, &config.username, key_pair)
                        .await
                        .map_err(|e| format!("key auth: {}", e))?
                        .success();
                (ok, SshAuthUsed::KeyExplicit)
            }
        })
    };
    let (auth_ok, auth_used) = match tokio::time::timeout(SSH_AUTH_TIMEOUT, auth_attempt).await {
        Ok(result) => result?,
        Err(_) => {
            let _ = tokio::time::timeout(
                SSH_CLOSE_TIMEOUT,
                session.disconnect(Disconnect::ByApplication, "authentication timeout", "en"),
            )
            .await;
            return Err(format!(
                "SSH authentication timed out after {}s",
                SSH_AUTH_TIMEOUT.as_secs()
            ));
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

        let mut channel = operation_with_timeout(
            "terminal channel open",
            SSH_CHANNEL_TIMEOUT,
            session.channel_open_session(),
        )
        .await?;

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
        operation_with_timeout(
            "terminal PTY request",
            SSH_CHANNEL_TIMEOUT,
            channel.request_pty(
                false,
                "xterm-256color",
                cols as u32,
                rows as u32,
                0,
                0,
                &terminal_modes,
            ),
        )
        .await?;

        operation_with_timeout(
            "terminal shell request",
            SSH_CHANNEL_TIMEOUT,
            channel.request_shell(false),
        )
        .await?;

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
            operation_with_timeout(
                "terminal hook write",
                SSH_CHANNEL_TIMEOUT,
                channel.data(hook.as_bytes()),
            )
            .await?;
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
                        match tokio::time::timeout(SSH_CHANNEL_TIMEOUT, channel.data(&data[..])).await {
                            Ok(Ok(())) => {}
                            Ok(Err(error)) => {
                                eprintln!("[ssh] write error: {}", error);
                                break;
                            }
                            Err(_) => {
                                eprintln!("[ssh] write timed out");
                                break;
                            }
                        }
                    }

                    // Resize
                    Some((cols, rows)) = resize_rx.recv() => {
                        if tokio::time::timeout(
                            SSH_CHANNEL_TIMEOUT,
                            channel.window_change(cols as u32, rows as u32, 0, 0),
                        ).await.is_err() {
                            eprintln!("[ssh] resize timed out");
                            break;
                        }
                    }
                }
            }
            let _ = tokio::time::timeout(SSH_CLOSE_TIMEOUT, channel.close()).await;
            done_clone.cancel();
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
        let session = guard
            .as_mut()
            .ok_or_else(|| "SFTP init: terminal session is no longer available".to_string())?;

        let sftp_channel = operation_with_timeout(
            "SFTP channel open",
            SSH_CHANNEL_TIMEOUT,
            session.channel_open_session(),
        )
        .await?;

        operation_with_timeout(
            "SFTP subsystem request",
            SSH_CHANNEL_TIMEOUT,
            sftp_channel.request_subsystem(true, "sftp"),
        )
        .await?;

        let sftp = operation_with_timeout(
            "SFTP session init",
            SSH_CHANNEL_TIMEOUT,
            russh_sftp::client::SftpSession::new(sftp_channel.into_stream()),
        )
        .await?;
        eprintln!("[ssh] SFTP subsystem initialized (multiplexed on terminal session)");
        Ok(Arc::new(sftp))
    }

    /// Initialize SFTP on a **dedicated** SSH connection so bulk file
    /// transfers do not compete with the interactive terminal channel.
    /// Returns either the SFTP client or a human-readable failure reason.
    pub async fn connect_sftp(
        config: &SshConfig,
    ) -> Result<Arc<russh_sftp::client::SftpSession>, String> {
        let (session, _auth_used) = connect_authenticated_session(config, sftp_client_config())
            .await
            .map_err(|e| format!("dedicated SFTP connect: {}", e))?;

        let sftp_channel = operation_with_timeout(
            "dedicated SFTP channel open",
            SSH_CHANNEL_TIMEOUT,
            session.channel_open_session(),
        )
        .await?;

        operation_with_timeout(
            "dedicated SFTP subsystem request",
            SSH_CHANNEL_TIMEOUT,
            sftp_channel.request_subsystem(true, "sftp"),
        )
        .await?;

        let sftp = operation_with_timeout(
            "dedicated SFTP session init",
            SSH_CHANNEL_TIMEOUT,
            russh_sftp::client::SftpSession::new(sftp_channel.into_stream()),
        )
        .await?;
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
            let _ = tokio::time::timeout(
                SSH_CLOSE_TIMEOUT,
                session.disconnect(Disconnect::ByApplication, "", "en"),
            )
            .await;
        }
        self.done_token.cancel();
        Ok(())
    }
}

impl Drop for SshTerminal {
    fn drop(&mut self) {
        // Pending/aborted session setup may drop the terminal before the async
        // Terminal::close path owns it. Wake the channel task synchronously;
        // that task performs its existing bounded channel close.
        self.done_token.cancel();
    }
}

/// Test SSH connection.
pub async fn test_connection(config: &SshConfig) -> Result<SshAuthUsed, String> {
    let term = SshTerminal::connect(config, 80, 24).await?;
    let auth_used = term.auth_used;
    term.close().await.map_err(|e| e.to_string())?;
    Ok(auth_used)
}

#[cfg(test)]
mod drop_tests {
    use super::*;
    use std::time::Duration;

    fn disconnected_terminal(done_token: CancellationToken) -> SshTerminal {
        let (_output_tx, output_rx) = mpsc::channel(1);
        let (input_tx, _input_rx) = mpsc::channel(1);
        let (resize_tx, _resize_rx) = mpsc::channel(1);
        SshTerminal {
            output_rx: Mutex::new(output_rx),
            pending_output: Mutex::new(VecDeque::new()),
            input_tx,
            resize_tx,
            session_handle: Arc::new(Mutex::new(None)),
            done_token,
            sftp: None,
            auth_used: SshAuthUsed::Password,
        }
    }

    #[tokio::test]
    async fn drop_cancels_done_token_and_wakes_waiters() {
        let token = CancellationToken::new();
        let observer = token.clone();
        let waiter = tokio::spawn(async move { observer.cancelled().await });

        drop(disconnected_terminal(token.clone()));

        assert!(token.is_cancelled());
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("drop did not wake cancellation waiter")
            .expect("cancellation waiter task failed");
    }
}
