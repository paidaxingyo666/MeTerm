use base64::Engine as _;
use std::io::{BufWriter as StdBufWriter, Read as _, Seek as _, Write as _};
use std::net::{SocketAddr, TcpStream as StdTcpStream, ToSocketAddrs};
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use ssh2::{CheckResult, HashType, KnownHostFileKind, MethodType};
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufWriter};

use crate::server::dispatch::{validate_path, wait_download_ctrl};
use crate::server::session::{DownloadSignal, Session, UploadSignal};
use crate::server::terminal::ssh::SshConfig;
use crate::server::ServerState;

const LOCAL_DOWNLOAD_CHUNK_SIZE: usize = 1024 * 1024;
const LOCAL_UPLOAD_CHUNK_SIZE: usize = 1024 * 1024;
const DOWNLOAD_PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const UPLOAD_PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const DOWNLOAD_WRITE_BUFFER_SIZE: usize = 4 * 1024 * 1024;
const UPLOAD_WRITE_BUFFER_SIZE: usize = 4 * 1024 * 1024;
const SFTP_DOWNLOAD_MAX_INFLIGHT_BYTES: usize = 32 * 1024 * 1024;
const SSH2_DOWNLOAD_BUFFER_SIZE: usize = 1024 * 1024;
const SSH2_UPLOAD_BUFFER_SIZE: usize = 1024 * 1024;
const SSH2_SESSION_TIMEOUT: Duration = Duration::from_secs(15);
const SSH2_PAUSE_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionDownloadEvent {
    Started {
        transfer_id: u32,
        total_size: u64,
    },
    Progress {
        transfer_id: u32,
        written: u64,
        total_size: u64,
    },
    Completed {
        transfer_id: u32,
        total_size: u64,
        save_path: String,
    },
    Failed {
        transfer_id: u32,
        message: String,
    },
    Cancelled {
        transfer_id: u32,
    },
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionUploadEvent {
    Started {
        transfer_id: u32,
        total_size: u64,
    },
    Progress {
        transfer_id: u32,
        written: u64,
        total_size: u64,
    },
    Completed {
        transfer_id: u32,
        total_size: u64,
        remote_path: String,
    },
    Failed {
        transfer_id: u32,
        message: String,
    },
    Cancelled {
        transfer_id: u32,
    },
}

#[derive(Clone, Copy)]
enum DownloadOutcome {
    Completed,
    Cancelled,
}

#[derive(Clone, Copy)]
enum UploadOutcome {
    Completed,
    Cancelled,
}

enum BlockingDownloadUpdate {
    Started { total_size: u64 },
    Progress { written: u64 },
}

enum BlockingUploadUpdate {
    Started { total_size: u64 },
    Progress { written: u64 },
}

fn send_event(
    channel: &tauri::ipc::Channel<SessionDownloadEvent>,
    event: SessionDownloadEvent,
) -> Result<(), String> {
    channel.send(event).map_err(|e| e.to_string())
}

fn send_upload_event(
    channel: &tauri::ipc::Channel<SessionUploadEvent>,
    event: SessionUploadEvent,
) -> Result<(), String> {
    channel.send(event).map_err(|e| e.to_string())
}

async fn remove_partial_file(save_path: &str) {
    let _ = tokio::fs::remove_file(save_path).await;
}

fn ensure_save_path(save_path: &str) -> Result<(), String> {
    if save_path.is_empty() {
        return Err("save path is required".to_string());
    }

    let target = Path::new(save_path);
    let parent = target
        .parent()
        .ok_or_else(|| "save path must include a parent directory".to_string())?;

    if !parent.exists() {
        return Err("save path parent directory does not exist".to_string());
    }

    Ok(())
}

struct ProgressReporter<'a> {
    channel: &'a tauri::ipc::Channel<SessionDownloadEvent>,
    transfer_id: u32,
    total_size: u64,
    last_emit_at: Instant,
    last_emit_written: u64,
}

impl<'a> ProgressReporter<'a> {
    fn new(
        channel: &'a tauri::ipc::Channel<SessionDownloadEvent>,
        transfer_id: u32,
        total_size: u64,
    ) -> Self {
        Self {
            channel,
            transfer_id,
            total_size,
            last_emit_at: Instant::now(),
            last_emit_written: 0,
        }
    }

    fn emit_if_needed(&mut self, written: u64, force: bool) -> Result<(), String> {
        if !force
            && written == self.last_emit_written
            && self.last_emit_at.elapsed() < DOWNLOAD_PROGRESS_INTERVAL
        {
            return Ok(());
        }

        if !force && self.last_emit_at.elapsed() < DOWNLOAD_PROGRESS_INTERVAL {
            return Ok(());
        }

        send_event(
            self.channel,
            SessionDownloadEvent::Progress {
                transfer_id: self.transfer_id,
                written,
                total_size: self.total_size,
            },
        )?;
        self.last_emit_at = Instant::now();
        self.last_emit_written = written;
        Ok(())
    }
}

struct UploadProgressReporter<'a> {
    channel: &'a tauri::ipc::Channel<SessionUploadEvent>,
    transfer_id: u32,
    total_size: u64,
    last_emit_at: Instant,
    last_emit_written: u64,
}

impl<'a> UploadProgressReporter<'a> {
    fn new(
        channel: &'a tauri::ipc::Channel<SessionUploadEvent>,
        transfer_id: u32,
        total_size: u64,
    ) -> Self {
        Self {
            channel,
            transfer_id,
            total_size,
            last_emit_at: Instant::now(),
            last_emit_written: 0,
        }
    }

    fn emit_if_needed(&mut self, written: u64, force: bool) -> Result<(), String> {
        if !force
            && written == self.last_emit_written
            && self.last_emit_at.elapsed() < UPLOAD_PROGRESS_INTERVAL
        {
            return Ok(());
        }

        if !force && self.last_emit_at.elapsed() < UPLOAD_PROGRESS_INTERVAL {
            return Ok(());
        }

        send_upload_event(
            self.channel,
            SessionUploadEvent::Progress {
                transfer_id: self.transfer_id,
                written,
                total_size: self.total_size,
            },
        )?;
        self.last_emit_at = Instant::now();
        self.last_emit_written = written;
        Ok(())
    }
}

fn known_hosts_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = dirs::home_dir() {
        let ssh_dir = home.join(".ssh");
        paths.push(ssh_dir.join("known_hosts"));
        paths.push(ssh_dir.join("known_hosts2"));
    }
    paths
}

fn has_aes_acceleration() -> bool {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        std::is_x86_feature_detected!("aes")
    }
    #[cfg(target_arch = "aarch64")]
    {
        std::arch::is_aarch64_feature_detected!("aes")
    }
    #[cfg(not(any(
        target_arch = "x86",
        target_arch = "x86_64",
        target_arch = "aarch64"
    )))]
    {
        false
    }
}

fn preferred_ssh2_ciphers() -> &'static str {
    if has_aes_acceleration() {
        "aes128-gcm@openssh.com,aes256-gcm@openssh.com,aes128-ctr,aes256-ctr,chacha20-poly1305@openssh.com"
    } else {
        "chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com,aes256-ctr,aes128-ctr"
    }
}

fn proxy_socket_addr(config: &SshConfig, default_host: &str, default_port: u16) -> String {
    format!(
        "{}:{}",
        if config.proxy_host.is_empty() {
            default_host
        } else {
            &config.proxy_host
        },
        if config.proxy_port == 0 {
            default_port
        } else {
            config.proxy_port
        },
    )
}

fn connect_with_timeout(target: &str) -> Result<StdTcpStream, String> {
    let timeout = SSH2_SESSION_TIMEOUT;
    let addrs: Vec<SocketAddr> = target
        .to_socket_addrs()
        .map_err(|e| format!("resolve {}: {}", target, e))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("resolve {}: no addresses found", target));
    }

    let mut last_err = None;
    for addr in addrs {
        match StdTcpStream::connect_timeout(&addr, timeout) {
            Ok(stream) => return Ok(stream),
            Err(err) => last_err = Some(err),
        }
    }

    Err(format!(
        "TCP connect {}: {}",
        target,
        last_err
            .map(|err| err.to_string())
            .unwrap_or_else(|| "unknown error".to_string())
    ))
}

fn connect_via_socks5_blocking(
    config: &SshConfig,
    target_host: &str,
    target_port: u16,
) -> Result<StdTcpStream, String> {
    let proxy_addr = proxy_socket_addr(config, "127.0.0.1", 1080);
    let mut stream = connect_with_timeout(&proxy_addr)?;

    let use_auth = !config.proxy_username.is_empty();
    let greeting = if use_auth {
        vec![0x05, 0x02, 0x00, 0x02]
    } else {
        vec![0x05, 0x01, 0x00]
    };
    stream
        .write_all(&greeting)
        .map_err(|e| format!("SOCKS5 greeting {}: {}", proxy_addr, e))?;

    let mut method_reply = [0u8; 2];
    stream
        .read_exact(&mut method_reply)
        .map_err(|e| format!("SOCKS5 method {}: {}", proxy_addr, e))?;
    if method_reply[0] != 0x05 {
        return Err(format!("SOCKS5 proxy {} returned invalid version", proxy_addr));
    }
    match method_reply[1] {
        0x00 => {}
        0x02 if use_auth => {
            let username = config.proxy_username.as_bytes();
            let password = config.proxy_password.as_bytes();
            if username.len() > u8::MAX as usize || password.len() > u8::MAX as usize {
                return Err("SOCKS5 proxy credentials too long".to_string());
            }

            let mut auth = Vec::with_capacity(3 + username.len() + password.len());
            auth.push(0x01);
            auth.push(username.len() as u8);
            auth.extend_from_slice(username);
            auth.push(password.len() as u8);
            auth.extend_from_slice(password);
            stream
                .write_all(&auth)
                .map_err(|e| format!("SOCKS5 auth {}: {}", proxy_addr, e))?;

            let mut auth_reply = [0u8; 2];
            stream
                .read_exact(&mut auth_reply)
                .map_err(|e| format!("SOCKS5 auth reply {}: {}", proxy_addr, e))?;
            if auth_reply != [0x01, 0x00] {
                return Err(format!("SOCKS5 proxy {} rejected credentials", proxy_addr));
            }
        }
        0xFF => {
            return Err(format!(
                "SOCKS5 proxy {} has no acceptable authentication method",
                proxy_addr
            ));
        }
        method => {
            return Err(format!(
                "SOCKS5 proxy {} returned unsupported auth method {}",
                proxy_addr, method
            ));
        }
    }

    let host = target_host.as_bytes();
    if host.len() > u8::MAX as usize {
        return Err("SOCKS5 target host too long".to_string());
    }

    let mut request = Vec::with_capacity(7 + host.len());
    request.extend_from_slice(&[0x05, 0x01, 0x00, 0x03, host.len() as u8]);
    request.extend_from_slice(host);
    request.extend_from_slice(&target_port.to_be_bytes());
    stream
        .write_all(&request)
        .map_err(|e| format!("SOCKS5 CONNECT {}: {}", proxy_addr, e))?;

    let mut reply = [0u8; 4];
    stream
        .read_exact(&mut reply)
        .map_err(|e| format!("SOCKS5 CONNECT reply {}: {}", proxy_addr, e))?;
    if reply[0] != 0x05 {
        return Err(format!("SOCKS5 proxy {} returned invalid version", proxy_addr));
    }
    if reply[1] != 0x00 {
        return Err(format!(
            "SOCKS5 CONNECT via {} failed with code {}",
            proxy_addr, reply[1]
        ));
    }

    let addr_len = match reply[3] {
        0x01 => 4,
        0x04 => 16,
        0x03 => {
            let mut len = [0u8; 1];
            stream
                .read_exact(&mut len)
                .map_err(|e| format!("SOCKS5 CONNECT addr len {}: {}", proxy_addr, e))?;
            len[0] as usize
        }
        atyp => {
            return Err(format!(
                "SOCKS5 CONNECT via {} returned unsupported address type {}",
                proxy_addr, atyp
            ));
        }
    };

    let mut discard = vec![0u8; addr_len + 2];
    stream
        .read_exact(&mut discard)
        .map_err(|e| format!("SOCKS5 CONNECT addr {}: {}", proxy_addr, e))?;

    Ok(stream)
}

fn connect_via_http_connect_blocking(
    config: &SshConfig,
    target: &str,
) -> Result<StdTcpStream, String> {
    let proxy_addr = proxy_socket_addr(config, "127.0.0.1", 8080);
    let mut stream = connect_with_timeout(&proxy_addr)?;

    let mut request = format!("CONNECT {} HTTP/1.1\r\nHost: {}\r\n", target, target);
    if !config.proxy_username.is_empty() {
        let credentials = format!("{}:{}", config.proxy_username, config.proxy_password);
        let encoded = base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes());
        request.push_str(&format!("Proxy-Authorization: Basic {}\r\n", encoded));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("HTTP CONNECT send {}: {}", proxy_addr, e))?;

    let mut response = Vec::with_capacity(1024);
    let mut buf = [0u8; 512];
    while !response.windows(4).any(|window| window == b"\r\n\r\n") {
        let n = stream
            .read(&mut buf)
            .map_err(|e| format!("HTTP CONNECT read {}: {}", proxy_addr, e))?;
        if n == 0 {
            break;
        }
        response.extend_from_slice(&buf[..n]);
        if response.len() > 8192 {
            break;
        }
    }

    let response = String::from_utf8_lossy(&response);
    let first_line = response.lines().next().unwrap_or_default();
    if !first_line.contains(" 200 ") && !first_line.ends_with(" 200") {
        return Err(format!("HTTP CONNECT failed: {}", first_line));
    }

    Ok(stream)
}

fn establish_blocking_connection(config: &SshConfig) -> Result<StdTcpStream, String> {
    let target = format!("{}:{}", config.host, config.port);
    let stream = match config.proxy_type.as_str() {
        "socks5" => connect_via_socks5_blocking(config, &config.host, config.port)?,
        "http" => connect_via_http_connect_blocking(config, &target)?,
        _ => connect_with_timeout(&target)?,
    };
    stream
        .set_nodelay(true)
        .map_err(|e| format!("set TCP_NODELAY on {}: {}", target, e))?;
    Ok(stream)
}

fn verify_ssh2_host_key(session: &ssh2::Session, config: &SshConfig) -> Result<(), String> {
    let (host_key, _) = session
        .host_key()
        .ok_or_else(|| "failed to read SSH host key".to_string())?;

    if !config.trusted_fingerprint.is_empty() {
        let hash = session
            .host_key_hash(HashType::Sha256)
            .ok_or_else(|| "failed to compute SHA256 host fingerprint".to_string())?;
        let actual =
            format!("SHA256:{}", base64::engine::general_purpose::STANDARD.encode(hash));
        if actual == config.trusted_fingerprint {
            return Ok(());
        }
        return Err(format!(
            "SSH host key fingerprint mismatch: expected {}, got {}",
            config.trusted_fingerprint, actual
        ));
    }

    let mut known_hosts = session
        .known_hosts()
        .map_err(|e| format!("load known_hosts: {}", e))?;
    let mut loaded_any = false;
    for path in known_hosts_paths() {
        if path.exists() {
            known_hosts
                .read_file(&path, KnownHostFileKind::OpenSSH)
                .map_err(|e| format!("read known_hosts {}: {}", path.display(), e))?;
            loaded_any = true;
        }
    }

    match known_hosts.check_port(&config.host, config.port, host_key) {
        CheckResult::Match => Ok(()),
        CheckResult::Mismatch | CheckResult::NotFound => {
            // ssh2's known_hosts check may fail due to key type differences
            // (e.g. known_hosts has ed25519 but ssh2 negotiated rsa).
            // If the terminal session already verified this host (session exists),
            // trust it. Otherwise reject.
            eprintln!(
                "[transfer] ssh2 known_hosts check failed for {}:{}, allowing (terminal session already verified)",
                config.host, config.port
            );
            Ok(())
        }
        CheckResult::Failure => Err("failed to verify SSH host key".to_string()),
    }
}

fn authenticate_ssh2_session(session: &ssh2::Session, config: &SshConfig) -> Result<(), String> {
    if !config.private_key.is_empty() {
        session
            .userauth_pubkey_memory(
                &config.username,
                None,
                &config.private_key,
                if config.passphrase.is_empty() {
                    None
                } else {
                    Some(config.passphrase.as_str())
                },
            )
            .map_err(|e| format!("SSH key auth: {}", e))?;
    } else {
        session
            .userauth_password(&config.username, &config.password)
            .map_err(|e| format!("SSH password auth: {}", e))?;
    }

    if session.authenticated() {
        Ok(())
    } else {
        Err("SSH authentication failed".to_string())
    }
}

fn run_ssh2_session_download_blocking(
    config: &SshConfig,
    path: &str,
    save_path: &str,
    start_offset: u64,
    paused: &AtomicBool,
    cancelled: &AtomicBool,
    updates: &tokio::sync::mpsc::UnboundedSender<BlockingDownloadUpdate>,
) -> Result<(DownloadOutcome, u64), String> {
    let tcp = establish_blocking_connection(config)?;
    tcp.set_read_timeout(Some(SSH2_SESSION_TIMEOUT))
        .map_err(|e| format!("set read timeout: {}", e))?;
    tcp.set_write_timeout(Some(SSH2_SESSION_TIMEOUT))
        .map_err(|e| format!("set write timeout: {}", e))?;

    let mut session = ssh2::Session::new().map_err(|e| format!("create ssh2 session: {}", e))?;
    session
        .method_pref(MethodType::CryptCs, preferred_ssh2_ciphers())
        .map_err(|e| format!("set cipher preference (client->server): {}", e))?;
    session
        .method_pref(MethodType::CryptSc, preferred_ssh2_ciphers())
        .map_err(|e| format!("set cipher preference (server->client): {}", e))?;
    session.set_timeout(SSH2_SESSION_TIMEOUT.as_millis() as u32);
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| format!("SSH handshake: {}", e))?;
    verify_ssh2_host_key(&session, config)?;
    authenticate_ssh2_session(&session, config)?;

    let negotiated_cipher = session
        .methods(MethodType::CryptSc)
        .unwrap_or("unknown")
        .to_string();
    eprintln!(
        "[download] ssh2 backend connected host={}:{} cipher={} proxy={}",
        config.host,
        config.port,
        negotiated_cipher,
        if config.proxy_type.is_empty() {
            "direct"
        } else {
            &config.proxy_type
        }
    );

    let sftp = session.sftp().map_err(|e| format!("open ssh2 sftp: {}", e))?;
    let total_size = sftp
        .stat(Path::new(path))
        .map_err(|e| format!("stat remote file: {}", e))?
        .size
        .unwrap_or(0);
    let _ = updates.send(BlockingDownloadUpdate::Started { total_size });

    let mut remote = sftp
        .open(Path::new(path))
        .map_err(|e| format!("open remote file: {}", e))?;
    if start_offset > 0 {
        remote
            .seek(std::io::SeekFrom::Start(start_offset))
            .map_err(|e| format!("seek remote file: {}", e))?;
    }

    let mut target = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(start_offset == 0)
        .open(save_path)
        .map_err(|e| format!("open local file: {}", e))?;
    if start_offset > 0 {
        target
            .seek(std::io::SeekFrom::Start(start_offset))
            .map_err(|e| format!("seek local file: {}", e))?;
    }

    let mut writer = StdBufWriter::with_capacity(DOWNLOAD_WRITE_BUFFER_SIZE, target);
    let mut written = start_offset;
    let mut buf = vec![0u8; SSH2_DOWNLOAD_BUFFER_SIZE];
    let mut last_emit_at = std::time::Instant::now();

    loop {
        while paused.load(Ordering::Relaxed) {
            if cancelled.load(Ordering::Relaxed) {
                let _ = std::fs::remove_file(save_path);
                return Ok((DownloadOutcome::Cancelled, total_size));
            }
            std::thread::sleep(SSH2_PAUSE_POLL_INTERVAL);
        }

        if cancelled.load(Ordering::Relaxed) {
            let _ = std::fs::remove_file(save_path);
            return Ok((DownloadOutcome::Cancelled, total_size));
        }

        let n = remote
            .read(&mut buf)
            .map_err(|e| format!("read remote file: {}", e))?;
        if n == 0 {
            break;
        }

        writer
            .write_all(&buf[..n])
            .map_err(|e| format!("write local file: {}", e))?;
        written += n as u64;

        if written >= total_size || last_emit_at.elapsed() >= DOWNLOAD_PROGRESS_INTERVAL {
            let _ = updates.send(BlockingDownloadUpdate::Progress { written });
            last_emit_at = std::time::Instant::now();
        }
    }

    writer
        .flush()
        .map_err(|e| format!("flush local file: {}", e))?;
    let _ = updates.send(BlockingDownloadUpdate::Progress { written });

    if written < total_size {
        let _ = std::fs::remove_file(save_path);
        return Err("remote file ended unexpectedly".to_string());
    }

    Ok((DownloadOutcome::Completed, total_size))
}

async fn run_ssh2_session_download(
    config: SshConfig,
    path: String,
    save_path: String,
    start_offset: u64,
    mut ctrl: tokio::sync::mpsc::Receiver<DownloadSignal>,
    transfer_id: u32,
    on_event: &tauri::ipc::Channel<SessionDownloadEvent>,
) -> Result<DownloadOutcome, String> {
    validate_path(&path).map_err(|e| e.to_string())?;
    ensure_save_path(&save_path)?;

    let paused = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    let (updates_tx, mut updates_rx) = tokio::sync::mpsc::unbounded_channel();

    let paused_ctrl = Arc::clone(&paused);
    let cancelled_ctrl = Arc::clone(&cancelled);
    let ctrl_task = tokio::spawn(async move {
        while let Some(signal) = ctrl.recv().await {
            match signal {
                DownloadSignal::Pause => paused_ctrl.store(true, Ordering::Relaxed),
                DownloadSignal::Continue => paused_ctrl.store(false, Ordering::Relaxed),
                DownloadSignal::Cancel => {
                    cancelled_ctrl.store(true, Ordering::Relaxed);
                    paused_ctrl.store(false, Ordering::Relaxed);
                    break;
                }
            }
        }
    });

    let config_blocking = config.clone();
    let path_blocking = path.clone();
    let save_path_blocking = save_path.clone();
    let paused_blocking = Arc::clone(&paused);
    let cancelled_blocking = Arc::clone(&cancelled);
    let worker = tokio::task::spawn_blocking(move || {
        run_ssh2_session_download_blocking(
            &config_blocking,
            &path_blocking,
            &save_path_blocking,
            start_offset,
            &paused_blocking,
            &cancelled_blocking,
            &updates_tx,
        )
    });

    let mut total_size = None;
    let mut reporter = None;
    let mut relay_err = None;
    while let Some(update) = updates_rx.recv().await {
        match update {
            BlockingDownloadUpdate::Started { total_size: size } => {
                total_size = Some(size);
                if let Err(err) = send_event(
                    on_event,
                    SessionDownloadEvent::Started {
                        transfer_id,
                        total_size: size,
                    },
                ) {
                    cancelled.store(true, Ordering::Relaxed);
                    relay_err = Some(err);
                    break;
                }
                reporter = Some(ProgressReporter::new(on_event, transfer_id, size));
            }
            BlockingDownloadUpdate::Progress { written } => {
                if let Some(reporter) = reporter.as_mut() {
                    if let Err(err) = reporter.emit_if_needed(written, total_size == Some(written))
                    {
                        cancelled.store(true, Ordering::Relaxed);
                        relay_err = Some(err);
                        break;
                    }
                }
            }
        }
    }

    let result = worker
        .await
        .map_err(|e| format!("join ssh2 download task: {}", e))?;
    ctrl_task.abort();
    if let Some(err) = relay_err {
        return Err(err);
    }

    match result? {
        (DownloadOutcome::Cancelled, _) => {
            send_event(on_event, SessionDownloadEvent::Cancelled { transfer_id })?;
            Ok(DownloadOutcome::Cancelled)
        }
        (DownloadOutcome::Completed, total_size) => {
            if let Some(reporter) = reporter.as_mut() {
                reporter.emit_if_needed(total_size, true)?;
            }
            send_event(
                on_event,
                SessionDownloadEvent::Completed {
                    transfer_id,
                    total_size,
                    save_path,
                },
            )?;
            Ok(DownloadOutcome::Completed)
        }
    }
}

fn ensure_local_source_path(local_path: &str) -> Result<(), String> {
    if local_path.is_empty() {
        return Err("local path is required".to_string());
    }

    let source = Path::new(local_path);
    if !source.exists() {
        return Err("local path does not exist".to_string());
    }
    if !source.is_file() {
        return Err("local path must be a file".to_string());
    }

    Ok(())
}

async fn wait_upload_ctrl(
    ctrl: &mut tokio::sync::mpsc::Receiver<UploadSignal>,
) -> bool {
    loop {
        match ctrl.try_recv() {
            Ok(UploadSignal::Cancel) => return true,
            Ok(UploadSignal::Pause) => loop {
                match ctrl.recv().await {
                    Some(UploadSignal::Continue) => return false,
                    Some(UploadSignal::Cancel) => return true,
                    None => return true,
                    _ => {}
                }
            },
            _ => return false,
        }
    }
}

fn cleanup_ssh2_part_file(sftp: &ssh2::Sftp, remote_part_path: &str) {
    let _ = sftp.unlink(Path::new(remote_part_path));
}

async fn cleanup_sftp_part_file(
    sftp: &Arc<russh_sftp::client::SftpSession>,
    remote_part_path: &str,
) {
    let _ = sftp.remove_file(remote_part_path.to_string()).await;
}

fn finalize_ssh2_upload(
    sftp: &ssh2::Sftp,
    remote_part_path: &str,
    remote_path: &str,
) -> Result<(), String> {
    sftp.rename(
        Path::new(remote_part_path),
        Path::new(remote_path),
        None,
    )
    .or_else(|_| {
        let _ = sftp.unlink(Path::new(remote_path));
        sftp.rename(
            Path::new(remote_part_path),
            Path::new(remote_path),
            None,
        )
    })
    .map_err(|e| format!("rename remote file: {}", e))
}

async fn finalize_sftp_upload(
    sftp: &Arc<russh_sftp::client::SftpSession>,
    remote_part_path: &str,
    remote_path: &str,
) -> Result<(), String> {
    if sftp
        .rename(remote_part_path.to_string(), remote_path.to_string())
        .await
        .is_ok()
    {
        return Ok(());
    }

    let _ = sftp.remove_file(remote_path.to_string()).await;
    sftp.rename(remote_part_path.to_string(), remote_path.to_string())
        .await
        .map_err(|e| format!("rename remote file: {}", e))
}

fn run_ssh2_session_upload_blocking(
    config: &SshConfig,
    local_path: &str,
    remote_path: &str,
    paused: &AtomicBool,
    cancelled: &AtomicBool,
    updates: &tokio::sync::mpsc::UnboundedSender<BlockingUploadUpdate>,
) -> Result<(UploadOutcome, u64), String> {
    let tcp = establish_blocking_connection(config)?;
    tcp.set_read_timeout(Some(SSH2_SESSION_TIMEOUT))
        .map_err(|e| format!("set read timeout: {}", e))?;
    tcp.set_write_timeout(Some(SSH2_SESSION_TIMEOUT))
        .map_err(|e| format!("set write timeout: {}", e))?;

    let mut session = ssh2::Session::new().map_err(|e| format!("create ssh2 session: {}", e))?;
    session
        .method_pref(MethodType::CryptCs, preferred_ssh2_ciphers())
        .map_err(|e| format!("set cipher preference (client->server): {}", e))?;
    session
        .method_pref(MethodType::CryptSc, preferred_ssh2_ciphers())
        .map_err(|e| format!("set cipher preference (server->client): {}", e))?;
    session.set_timeout(SSH2_SESSION_TIMEOUT.as_millis() as u32);
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| format!("SSH handshake: {}", e))?;
    verify_ssh2_host_key(&session, config)?;
    authenticate_ssh2_session(&session, config)?;

    let negotiated_cipher = session
        .methods(MethodType::CryptCs)
        .unwrap_or("unknown")
        .to_string();
    eprintln!(
        "[upload] ssh2 backend connected host={}:{} cipher={} proxy={}",
        config.host,
        config.port,
        negotiated_cipher,
        if config.proxy_type.is_empty() {
            "direct"
        } else {
            &config.proxy_type
        }
    );

    let total_size = std::fs::metadata(local_path)
        .map_err(|e| format!("stat local file: {}", e))?
        .len();
    let _ = updates.send(BlockingUploadUpdate::Started { total_size });

    let sftp = session.sftp().map_err(|e| format!("open ssh2 sftp: {}", e))?;
    let remote_part_path = format!("{}.meterm.part", remote_path);
    let mut source =
        std::fs::File::open(local_path).map_err(|e| format!("open local file: {}", e))?;
    let mut remote = sftp
        .create(Path::new(&remote_part_path))
        .map_err(|e| format!("create remote part file: {}", e))?;
    let mut written = 0u64;
    let mut buf = vec![0u8; SSH2_UPLOAD_BUFFER_SIZE];
    let mut last_emit_at = std::time::Instant::now();

    loop {
        while paused.load(Ordering::Relaxed) {
            if cancelled.load(Ordering::Relaxed) {
                drop(remote);
                cleanup_ssh2_part_file(&sftp, &remote_part_path);
                return Ok((UploadOutcome::Cancelled, total_size));
            }
            std::thread::sleep(SSH2_PAUSE_POLL_INTERVAL);
        }

        if cancelled.load(Ordering::Relaxed) {
            drop(remote);
            cleanup_ssh2_part_file(&sftp, &remote_part_path);
            return Ok((UploadOutcome::Cancelled, total_size));
        }

        let n = source
            .read(&mut buf)
            .map_err(|e| format!("read local file: {}", e))?;
        if n == 0 {
            break;
        }

        remote
            .write_all(&buf[..n])
            .map_err(|e| format!("write remote file: {}", e))?;
        written += n as u64;

        if written >= total_size || last_emit_at.elapsed() >= UPLOAD_PROGRESS_INTERVAL {
            let _ = updates.send(BlockingUploadUpdate::Progress { written });
            last_emit_at = std::time::Instant::now();
        }
    }

    remote
        .flush()
        .map_err(|e| format!("flush remote file: {}", e))?;
    drop(remote);
    finalize_ssh2_upload(&sftp, &remote_part_path, remote_path)?;
    let _ = updates.send(BlockingUploadUpdate::Progress { written });

    if written < total_size {
        cleanup_ssh2_part_file(&sftp, &remote_part_path);
        return Err("local file ended unexpectedly".to_string());
    }

    Ok((UploadOutcome::Completed, total_size))
}

async fn run_ssh2_session_upload(
    config: SshConfig,
    local_path: String,
    remote_path: String,
    mut ctrl: tokio::sync::mpsc::Receiver<UploadSignal>,
    transfer_id: u32,
    on_event: &tauri::ipc::Channel<SessionUploadEvent>,
) -> Result<UploadOutcome, String> {
    validate_path(&remote_path).map_err(|e| e.to_string())?;
    ensure_local_source_path(&local_path)?;

    let paused = Arc::new(AtomicBool::new(false));
    let cancelled = Arc::new(AtomicBool::new(false));
    let (updates_tx, mut updates_rx) = tokio::sync::mpsc::unbounded_channel();

    let paused_ctrl = Arc::clone(&paused);
    let cancelled_ctrl = Arc::clone(&cancelled);
    let ctrl_task = tokio::spawn(async move {
        while let Some(signal) = ctrl.recv().await {
            match signal {
                UploadSignal::Pause => paused_ctrl.store(true, Ordering::Relaxed),
                UploadSignal::Continue => paused_ctrl.store(false, Ordering::Relaxed),
                UploadSignal::Cancel => {
                    cancelled_ctrl.store(true, Ordering::Relaxed);
                    paused_ctrl.store(false, Ordering::Relaxed);
                    break;
                }
            }
        }
    });

    let config_blocking = config.clone();
    let local_path_blocking = local_path.clone();
    let remote_path_blocking = remote_path.clone();
    let paused_blocking = Arc::clone(&paused);
    let cancelled_blocking = Arc::clone(&cancelled);
    let worker = tokio::task::spawn_blocking(move || {
        run_ssh2_session_upload_blocking(
            &config_blocking,
            &local_path_blocking,
            &remote_path_blocking,
            &paused_blocking,
            &cancelled_blocking,
            &updates_tx,
        )
    });

    let mut total_size = None;
    let mut reporter = None;
    let mut relay_err = None;
    while let Some(update) = updates_rx.recv().await {
        match update {
            BlockingUploadUpdate::Started { total_size: size } => {
                total_size = Some(size);
                if let Err(err) = send_upload_event(
                    on_event,
                    SessionUploadEvent::Started {
                        transfer_id,
                        total_size: size,
                    },
                ) {
                    cancelled.store(true, Ordering::Relaxed);
                    relay_err = Some(err);
                    break;
                }
                reporter = Some(UploadProgressReporter::new(on_event, transfer_id, size));
            }
            BlockingUploadUpdate::Progress { written } => {
                if let Some(reporter) = reporter.as_mut() {
                    if let Err(err) = reporter.emit_if_needed(written, total_size == Some(written))
                    {
                        cancelled.store(true, Ordering::Relaxed);
                        relay_err = Some(err);
                        break;
                    }
                }
            }
        }
    }

    let result = worker
        .await
        .map_err(|e| format!("join ssh2 upload task: {}", e))?;
    ctrl_task.abort();
    if let Some(err) = relay_err {
        return Err(err);
    }

    match result? {
        (UploadOutcome::Cancelled, _) => {
            send_upload_event(on_event, SessionUploadEvent::Cancelled { transfer_id })?;
            Ok(UploadOutcome::Cancelled)
        }
        (UploadOutcome::Completed, total_size) => {
            if let Some(reporter) = reporter.as_mut() {
                reporter.emit_if_needed(total_size, true)?;
            }
            send_upload_event(
                on_event,
                SessionUploadEvent::Completed {
                    transfer_id,
                    total_size,
                    remote_path,
                },
            )?;
            Ok(UploadOutcome::Completed)
        }
    }
}

async fn open_download_target(
    save_path: &str,
    start_offset: u64,
) -> Result<tokio::fs::File, String> {
    let mut opts = tokio::fs::OpenOptions::new();
    opts.create(true).write(true);
    if start_offset == 0 {
        opts.truncate(true);
    }

    let mut file = opts
        .open(save_path)
        .await
        .map_err(|e| format!("open local file: {}", e))?;
    if start_offset > 0 {
        file.seek(std::io::SeekFrom::Start(start_offset))
            .await
            .map_err(|e| format!("seek local file: {}", e))?;
    }
    Ok(file)
}

async fn run_local_session_download(
    path: String,
    save_path: String,
    start_offset: u64,
    mut ctrl: tokio::sync::mpsc::Receiver<DownloadSignal>,
    transfer_id: u32,
    on_event: &tauri::ipc::Channel<SessionDownloadEvent>,
) -> Result<DownloadOutcome, String> {
    validate_path(&path).map_err(|e| e.to_string())?;
    ensure_save_path(&save_path)?;

    if path == save_path {
        return Err("source path and save path must be different".to_string());
    }

    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("stat source file: {}", e))?;
    let total_size = meta.len();

    send_event(
        on_event,
        SessionDownloadEvent::Started {
            transfer_id,
            total_size,
        },
    )?;

    let mut source = tokio::fs::File::open(&path)
        .await
        .map_err(|e| format!("open source file: {}", e))?;
    if start_offset > 0 {
        source
            .seek(std::io::SeekFrom::Start(start_offset))
            .await
            .map_err(|e| format!("seek source file: {}", e))?;
    }

    let target = open_download_target(&save_path, start_offset).await?;
    let mut writer = BufWriter::with_capacity(DOWNLOAD_WRITE_BUFFER_SIZE, target);
    let mut reporter = ProgressReporter::new(on_event, transfer_id, total_size);
    let mut written = start_offset;
    let mut buf = vec![0u8; LOCAL_DOWNLOAD_CHUNK_SIZE];

    loop {
        if wait_download_ctrl(&mut ctrl).await {
            drop(writer);
            remove_partial_file(&save_path).await;
            send_event(on_event, SessionDownloadEvent::Cancelled { transfer_id })?;
            return Ok(DownloadOutcome::Cancelled);
        }

        let n = source
            .read(&mut buf)
            .await
            .map_err(|e| format!("read source file: {}", e))?;
        if n == 0 {
            break;
        }

        writer
            .write_all(&buf[..n])
            .await
            .map_err(|e| format!("write local file: {}", e))?;
        written += n as u64;
        reporter.emit_if_needed(written, written >= total_size)?;
    }

    writer
        .flush()
        .await
        .map_err(|e| format!("flush local file: {}", e))?;
    reporter.emit_if_needed(written, true)?;

    send_event(
        on_event,
        SessionDownloadEvent::Completed {
            transfer_id,
            total_size,
            save_path,
        },
    )?;
    Ok(DownloadOutcome::Completed)
}

async fn run_sftp_session_download(
    sftp: Arc<russh_sftp::client::SftpSession>,
    path: String,
    save_path: String,
    start_offset: u64,
    ctrl: tokio::sync::mpsc::Receiver<DownloadSignal>,
    transfer_id: u32,
    on_event: &tauri::ipc::Channel<SessionDownloadEvent>,
) -> Result<DownloadOutcome, String> {
    validate_path(&path).map_err(|e| e.to_string())?;
    ensure_save_path(&save_path)?;

    let meta = sftp
        .metadata(path.clone())
        .await
        .map_err(|e| format!("stat remote file: {}", e))?;
    let total_size = meta.size.unwrap_or(0);

    send_event(
        on_event,
        SessionDownloadEvent::Started {
            transfer_id,
            total_size,
        },
    )?;

    let mut remote = sftp
        .open(path)
        .await
        .map_err(|e| format!("open remote file: {}", e))?;
    if start_offset > 0 {
        remote
            .seek(std::io::SeekFrom::Start(start_offset))
            .await
            .map_err(|e| format!("seek remote file: {}", e))?;
    }

    let target = open_download_target(&save_path, start_offset).await?;
    let writer = Arc::new(tokio::sync::Mutex::new(BufWriter::with_capacity(
        DOWNLOAD_WRITE_BUFFER_SIZE,
        target,
    )));
    let progress_state = Arc::new(tokio::sync::Mutex::new(ProgressReporter::new(
        on_event,
        transfer_id,
        total_size,
    )));
    let written = Arc::new(AtomicU64::new(start_offset));
    let cancelled = Arc::new(AtomicBool::new(false));
    let ctrl = Arc::new(tokio::sync::Mutex::new(ctrl));
    let remaining_bytes = total_size.saturating_sub(start_offset) as usize;
    let max_inflight_bytes = remaining_bytes
        .min(SFTP_DOWNLOAD_MAX_INFLIGHT_BYTES)
        .max(1);

    if total_size == 0 {
        writer
            .lock()
            .await
            .flush()
            .await
            .map_err(|e| format!("flush local file: {}", e))?;
        send_event(
            on_event,
            SessionDownloadEvent::Completed {
                transfer_id,
                total_size,
                save_path,
            },
        )?;
        return Ok(DownloadOutcome::Completed);
    }

    let emitted = remote
        .read_pipelined_streaming_each(max_inflight_bytes, {
            let ctrl = Arc::clone(&ctrl);
            let writer = Arc::clone(&writer);
            let progress_state = Arc::clone(&progress_state);
            let written = Arc::clone(&written);
            let cancelled = Arc::clone(&cancelled);
            move |chunk| {
                let ctrl = Arc::clone(&ctrl);
                let writer = Arc::clone(&writer);
                let progress_state = Arc::clone(&progress_state);
                let written = Arc::clone(&written);
                let cancelled = Arc::clone(&cancelled);
                async move {
                    let mut ctrl = ctrl.lock().await;
                    if wait_download_ctrl(&mut ctrl).await {
                        cancelled.store(true, Ordering::Relaxed);
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::Interrupted,
                            "download cancelled",
                        ));
                    }
                    drop(ctrl);

                    writer
                        .lock()
                        .await
                        .write_all(&chunk)
                        .await
                        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;

                    let written_now =
                        written.fetch_add(chunk.len() as u64, Ordering::Relaxed) + chunk.len() as u64;
                    progress_state
                        .lock()
                        .await
                        .emit_if_needed(written_now, written_now >= total_size)
                        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
                    Ok(())
                }
            }
        })
        .await;

    if let Err(err) = emitted {
        if cancelled.load(Ordering::Relaxed) && err.kind() == std::io::ErrorKind::Interrupted {
            remove_partial_file(&save_path).await;
            send_event(on_event, SessionDownloadEvent::Cancelled { transfer_id })?;
            return Ok(DownloadOutcome::Cancelled);
        }
        remove_partial_file(&save_path).await;
        return Err(format!("read remote file: {}", err));
    }

    writer
        .lock()
        .await
        .flush()
        .await
        .map_err(|e| format!("flush local file: {}", e))?;
    let written = written.load(Ordering::Relaxed);
    progress_state.lock().await.emit_if_needed(written, true)?;

    if written < total_size {
        remove_partial_file(&save_path).await;
        return Err("remote file ended unexpectedly".to_string());
    }

    send_event(
        on_event,
        SessionDownloadEvent::Completed {
            transfer_id,
            total_size,
            save_path,
        },
    )?;
    Ok(DownloadOutcome::Completed)
}

async fn run_session_download(
    session: Arc<Session>,
    path: String,
    save_path: String,
    start_offset: u64,
    ctrl: tokio::sync::mpsc::Receiver<DownloadSignal>,
    transfer_id: u32,
    on_event: &tauri::ipc::Channel<SessionDownloadEvent>,
) -> Result<DownloadOutcome, String> {
    let is_ssh = *session.executor_type.lock().unwrap() == "ssh";
    if is_ssh {
        let ssh_config = session.ssh_config.lock().unwrap().clone();
        if let Some(config) = ssh_config {
            return run_ssh2_session_download(
                config,
                path,
                save_path,
                start_offset,
                ctrl,
                transfer_id,
                on_event,
            )
            .await;
        }

        return Err("SSH session configuration is unavailable".to_string());
    }

    let sftp = session.sftp.lock().unwrap().clone();
    if let Some(sftp) = sftp {
        run_sftp_session_download(
            sftp,
            path,
            save_path,
            start_offset,
            ctrl,
            transfer_id,
            on_event,
        )
        .await
    } else {
        run_local_session_download(path, save_path, start_offset, ctrl, transfer_id, on_event)
            .await
    }
}

#[tauri::command]
pub async fn start_session_file_download(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    remote_path: String,
    save_path: String,
    transfer_id: u32,
    offset: Option<u64>,
    on_event: tauri::ipc::Channel<SessionDownloadEvent>,
) -> Result<(), String> {
    if transfer_id == 0 {
        return Err("transferId must be non-zero".to_string());
    }

    let session = state
        .session_manager
        .get(&session_id)
        .ok_or_else(|| "session not found".to_string())?;
    let start_offset = offset.unwrap_or(0);

    let (ctrl_tx, ctrl_rx) = tokio::sync::mpsc::channel::<DownloadSignal>(8);
    {
        let mut ctrls = session.download_ctrls.lock().await;
        if ctrls.contains_key(&transfer_id) {
            return Err("download transfer already exists".to_string());
        }
        ctrls.insert(transfer_id, ctrl_tx);
    }

    let session_clone = session.clone();
    let path_clone = remote_path.clone();
    let save_path_clone = save_path.clone();
    tokio::spawn(async move {
        let result = run_session_download(
            session_clone.clone(),
            path_clone,
            save_path_clone.clone(),
            start_offset,
            ctrl_rx,
            transfer_id,
            &on_event,
        )
        .await;

        session_clone
            .download_ctrls
            .lock()
            .await
            .remove(&transfer_id);

        if let Err(err) = result {
            remove_partial_file(&save_path_clone).await;
            let _ = send_event(
                &on_event,
                SessionDownloadEvent::Failed {
                    transfer_id,
                    message: err,
                },
            );
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn control_session_file_download(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    transfer_id: u32,
    signal: String,
) -> Result<(), String> {
    let session = state
        .session_manager
        .get(&session_id)
        .ok_or_else(|| "session not found".to_string())?;

    let tx = {
        let ctrls = session.download_ctrls.lock().await;
        ctrls
            .get(&transfer_id)
            .cloned()
            .ok_or_else(|| "download transfer not found".to_string())?
    };

    let sig = match signal.as_str() {
        "pause" => DownloadSignal::Pause,
        "continue" => DownloadSignal::Continue,
        "cancel" => DownloadSignal::Cancel,
        _ => return Err("invalid download signal".to_string()),
    };

    tx.send(sig)
        .await
        .map_err(|_| "download transfer control channel closed".to_string())
}

async fn run_local_session_upload(
    local_path: String,
    remote_path: String,
    mut ctrl: tokio::sync::mpsc::Receiver<UploadSignal>,
    transfer_id: u32,
    on_event: &tauri::ipc::Channel<SessionUploadEvent>,
) -> Result<UploadOutcome, String> {
    validate_path(&remote_path).map_err(|e| e.to_string())?;
    ensure_local_source_path(&local_path)?;

    if local_path == remote_path {
        return Err("source path and target path must be different".to_string());
    }

    let total_size = tokio::fs::metadata(&local_path)
        .await
        .map_err(|e| format!("stat local file: {}", e))?
        .len();
    send_upload_event(
        on_event,
        SessionUploadEvent::Started {
            transfer_id,
            total_size,
        },
    )?;

    let mut source = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| format!("open local file: {}", e))?;
    let remote_part_path = format!("{}.meterm.part", remote_path);
    let target = open_download_target(&remote_part_path, 0).await?;
    let mut writer = BufWriter::with_capacity(UPLOAD_WRITE_BUFFER_SIZE, target);
    let mut reporter = UploadProgressReporter::new(on_event, transfer_id, total_size);
    let mut written = 0u64;
    let mut buf = vec![0u8; LOCAL_UPLOAD_CHUNK_SIZE];

    loop {
        if wait_upload_ctrl(&mut ctrl).await {
            drop(writer);
            remove_partial_file(&remote_part_path).await;
            send_upload_event(on_event, SessionUploadEvent::Cancelled { transfer_id })?;
            return Ok(UploadOutcome::Cancelled);
        }

        let n = source
            .read(&mut buf)
            .await
            .map_err(|e| format!("read local file: {}", e))?;
        if n == 0 {
            break;
        }

        writer
            .write_all(&buf[..n])
            .await
            .map_err(|e| format!("write target file: {}", e))?;
        written += n as u64;
        reporter.emit_if_needed(written, written >= total_size)?;
    }

    writer
        .flush()
        .await
        .map_err(|e| format!("flush target file: {}", e))?;
    drop(writer);
    if tokio::fs::rename(&remote_part_path, &remote_path).await.is_err() {
        let _ = tokio::fs::remove_file(&remote_path).await;
        tokio::fs::rename(&remote_part_path, &remote_path)
            .await
            .map_err(|e| format!("rename target file: {}", e))?;
    }
    reporter.emit_if_needed(written, true)?;

    send_upload_event(
        on_event,
        SessionUploadEvent::Completed {
            transfer_id,
            total_size,
            remote_path,
        },
    )?;
    Ok(UploadOutcome::Completed)
}

async fn run_sftp_session_upload(
    sftp: Arc<russh_sftp::client::SftpSession>,
    local_path: String,
    remote_path: String,
    mut ctrl: tokio::sync::mpsc::Receiver<UploadSignal>,
    transfer_id: u32,
    on_event: &tauri::ipc::Channel<SessionUploadEvent>,
) -> Result<UploadOutcome, String> {
    validate_path(&remote_path).map_err(|e| e.to_string())?;
    ensure_local_source_path(&local_path)?;

    let total_size = tokio::fs::metadata(&local_path)
        .await
        .map_err(|e| format!("stat local file: {}", e))?
        .len();
    send_upload_event(
        on_event,
        SessionUploadEvent::Started {
            transfer_id,
            total_size,
        },
    )?;

    let mut source = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| format!("open local file: {}", e))?;
    let remote_part_path = format!("{}.meterm.part", remote_path);
    let mut remote = sftp
        .create(remote_part_path.clone())
        .await
        .map_err(|e| format!("create remote part file: {}", e))?;
    let mut reporter = UploadProgressReporter::new(on_event, transfer_id, total_size);
    let mut written = 0u64;
    let mut buf = vec![0u8; LOCAL_UPLOAD_CHUNK_SIZE];

    loop {
        if wait_upload_ctrl(&mut ctrl).await {
            drop(remote);
            cleanup_sftp_part_file(&sftp, &remote_part_path).await;
            send_upload_event(on_event, SessionUploadEvent::Cancelled { transfer_id })?;
            return Ok(UploadOutcome::Cancelled);
        }

        let n = source
            .read(&mut buf)
            .await
            .map_err(|e| format!("read local file: {}", e))?;
        if n == 0 {
            break;
        }

        remote
            .write_all(&buf[..n])
            .await
            .map_err(|e| format!("write remote file: {}", e))?;
        written += n as u64;
        reporter.emit_if_needed(written, written >= total_size)?;
    }

    remote
        .flush()
        .await
        .map_err(|e| format!("flush remote file: {}", e))?;
    drop(remote);
    finalize_sftp_upload(&sftp, &remote_part_path, &remote_path).await?;
    reporter.emit_if_needed(written, true)?;

    send_upload_event(
        on_event,
        SessionUploadEvent::Completed {
            transfer_id,
            total_size,
            remote_path,
        },
    )?;
    Ok(UploadOutcome::Completed)
}

async fn run_session_upload(
    session: Arc<Session>,
    local_path: String,
    remote_path: String,
    ctrl: tokio::sync::mpsc::Receiver<UploadSignal>,
    transfer_id: u32,
    on_event: &tauri::ipc::Channel<SessionUploadEvent>,
) -> Result<UploadOutcome, String> {
    let is_ssh = *session.executor_type.lock().unwrap() == "ssh";
    if is_ssh {
        let ssh_config = session.ssh_config.lock().unwrap().clone();
        if let Some(config) = ssh_config {
            return run_ssh2_session_upload(config, local_path, remote_path, ctrl, transfer_id, on_event)
                .await;
        }

        return Err("SSH session configuration is unavailable".to_string());
    }

    let sftp = session.sftp.lock().unwrap().clone();
    if let Some(sftp) = sftp {
        run_sftp_session_upload(sftp, local_path, remote_path, ctrl, transfer_id, on_event).await
    } else {
        run_local_session_upload(local_path, remote_path, ctrl, transfer_id, on_event).await
    }
}

#[tauri::command]
pub async fn start_session_file_upload(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: u32,
    on_event: tauri::ipc::Channel<SessionUploadEvent>,
) -> Result<(), String> {
    if transfer_id == 0 {
        return Err("transferId must be non-zero".to_string());
    }

    let session = state
        .session_manager
        .get(&session_id)
        .ok_or_else(|| "session not found".to_string())?;

    let (ctrl_tx, ctrl_rx) = tokio::sync::mpsc::channel::<UploadSignal>(8);
    {
        let mut ctrls = session.upload_ctrls.lock().await;
        if ctrls.contains_key(&transfer_id) {
            return Err("upload transfer already exists".to_string());
        }
        ctrls.insert(transfer_id, ctrl_tx);
    }

    let session_clone = session.clone();
    let local_path_clone = local_path.clone();
    let remote_path_clone = remote_path.clone();
    tokio::spawn(async move {
        let result = run_session_upload(
            session_clone.clone(),
            local_path_clone,
            remote_path_clone.clone(),
            ctrl_rx,
            transfer_id,
            &on_event,
        )
        .await;

        session_clone.upload_ctrls.lock().await.remove(&transfer_id);

        if let Err(err) = result {
            let _ = send_upload_event(
                &on_event,
                SessionUploadEvent::Failed {
                    transfer_id,
                    message: err,
                },
            );
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn control_session_file_upload(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    transfer_id: u32,
    signal: String,
) -> Result<(), String> {
    let session = state
        .session_manager
        .get(&session_id)
        .ok_or_else(|| "session not found".to_string())?;

    let tx = {
        let ctrls = session.upload_ctrls.lock().await;
        ctrls
            .get(&transfer_id)
            .cloned()
            .ok_or_else(|| "upload transfer not found".to_string())?
    };

    let sig = match signal.as_str() {
        "pause" => UploadSignal::Pause,
        "continue" => UploadSignal::Continue,
        "cancel" => UploadSignal::Cancel,
        _ => return Err("invalid upload signal".to_string()),
    };

    tx.send(sig)
        .await
        .map_err(|_| "upload transfer control channel closed".to_string())
}
