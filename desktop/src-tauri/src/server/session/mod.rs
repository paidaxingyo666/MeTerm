//! Session management — mirrors Go `session/session.go`.
//!
//! A `Session` owns a terminal (PTY/SSH), a set of connected clients,
//! a ring buffer for output history, and an optional recorder.

pub mod client;
pub mod manager;
pub mod state;
pub mod transfer;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use client::Client;
use state::{ClientRole, SessionState};
use crate::server::protocol;

/// Configuration for sessions (passed from ServerConfig).
#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub session_ttl: std::time::Duration,
    pub reconnect_grace: std::time::Duration,
    pub ring_buffer_size: usize,
    pub log_dir: String,
}

/// Maximum number of automatic shell restarts after unexpected exit.
const MAX_RESTARTS: u32 = 3;

/// Download flow control signal.
#[derive(Debug, Clone, Copy)]
pub enum DownloadSignal {
    Pause,
    Continue,
    Cancel,
}

/// Active upload state — tracks an in-progress file upload.
/// Holds the remote SFTP file handle open for streaming writes (matches Go).
/// Uses pipelined SFTP writes: sends Write requests without waiting, collects
/// responses later — turns N sequential round-trips into ~1 round-trip latency.
pub struct UploadState {
    pub path: String,
    pub part_path: String,
    pub total_size: i64,
    pub received: i64,
    /// Open SFTP file handle for streaming writes. None for local uploads.
    pub sftp_file: Option<russh_sftp::client::fs::File>,
    /// Open local file handle for local uploads.
    pub local_file: Option<std::fs::File>,
    /// Queue of in-flight SFTP write requests (pipelined, not yet confirmed).
    pub pending_writes: Vec<russh_sftp::client::PendingWrite>,
    /// Adaptive pipeline depth (grows from 2 to MAX based on RTT).
    pub pipeline: AdaptivePipeline,
}

/// Adaptive pipeline depth for SFTP pipelined I/O.
/// Uses TCP-style slow start → linear increase, measures SFTP RTT to set ceiling.
pub struct AdaptivePipeline {
    /// Current pipeline window size.
    pub window: usize,
    /// Slow-start threshold.
    ssthresh: usize,
    /// ACK counter for linear increase phase.
    ack_count: usize,
    /// Timestamp when the oldest pending request was sent (for RTT measurement).
    send_time: Option<std::time::Instant>,
    /// Smoothed RTT in milliseconds.
    srtt_ms: f64,
}

impl AdaptivePipeline {
    const INITIAL_WINDOW: usize = 2;
    const MAX_WINDOW: usize = 64;
    const INITIAL_SSTHRESH: usize = 16;

    pub fn new() -> Self {
        Self {
            window: Self::INITIAL_WINDOW,
            ssthresh: Self::INITIAL_SSTHRESH,
            ack_count: 0,
            send_time: None,
            srtt_ms: 0.0,
        }
    }

    /// Call when sending a new SFTP request (to start RTT measurement).
    pub fn on_send(&mut self) {
        if self.send_time.is_none() {
            self.send_time = Some(std::time::Instant::now());
        }
    }

    /// Call when an SFTP response is confirmed. Grows the window.
    pub fn on_ack(&mut self) {
        // Measure RTT from the oldest in-flight request
        if let Some(t) = self.send_time.take() {
            let rtt_ms = t.elapsed().as_secs_f64() * 1000.0;
            // EWMA smoothing (α = 0.125, same as TCP)
            if self.srtt_ms == 0.0 {
                self.srtt_ms = rtt_ms;
            } else {
                self.srtt_ms = self.srtt_ms * 0.875 + rtt_ms * 0.125;
            }
        }

        // Grow window: slow start (exponential) → linear increase
        if self.window < self.ssthresh {
            self.window = (self.window + 1).min(Self::MAX_WINDOW);
        } else {
            self.ack_count += 1;
            if self.ack_count >= self.window {
                self.window = (self.window + 1).min(Self::MAX_WINDOW);
                self.ack_count = 0;
            }
        }
    }
}

/// A terminal session.
pub struct Session {
    pub id: String,
    pub state: Mutex<SessionState>,
    pub clients: Mutex<HashMap<String, Arc<Client>>>,
    pub master_id: Mutex<String>,
    pub owner_id: Mutex<String>,
    pub private: Mutex<bool>,
    pub config: SessionConfig,

    // Ring buffer for output history replay
    ring_buf: Mutex<RingBuffer>,

    /// Channel to send input data to the terminal.
    input_tx: Arc<tokio::sync::Mutex<Option<tokio::sync::mpsc::Sender<Vec<u8>>>>>,
    /// Channel to send resize commands to the terminal.
    resize_tx: Arc<tokio::sync::Mutex<Option<tokio::sync::mpsc::Sender<(u16, u16)>>>>,
    /// Restart count for auto-restart logic.
    restart_count: std::sync::atomic::AtomicU32,

    pub created_at: Instant,
    pub last_cols: Mutex<u16>,
    pub last_rows: Mutex<u16>,

    /// When the last client disconnected (for TTL tracking).
    pub drain_start: Mutex<Option<Instant>>,

    /// Encoding name (utf-8 by default, can be gbk/big5/etc.)
    pub encoding_name: Mutex<String>,

    /// Executor type: "local-shell", "ssh", "jumpserver"
    pub executor_type: Mutex<String>,

    /// SFTP client for SSH sessions (None for local sessions).
    pub sftp: Mutex<Option<std::sync::Arc<russh_sftp::client::SftpSession>>>,

    /// SSH session handle for exec (ServerInfo, process list). Type-erased.
    pub ssh_exec_handle: tokio::sync::Mutex<Option<Box<dyn std::any::Any + Send + Sync>>>,

    /// Active upload state (path, part_path, total_size, received bytes).
    pub active_upload: tokio::sync::Mutex<Option<UploadState>>,

    /// Download control channel (pause/resume/cancel signals).
    pub download_ctrl: tokio::sync::Mutex<Option<tokio::sync::mpsc::Sender<DownloadSignal>>>,

    /// Cancellation token for the session's run loop.
    cancel: CancellationToken,
}

impl Session {
    pub fn new(id: String, config: SessionConfig) -> Self {
        let ring_size = config.ring_buffer_size;
        Self {
            id,
            state: Mutex::new(SessionState::Created),
            clients: Mutex::new(HashMap::new()),
            master_id: Mutex::new(String::new()),
            owner_id: Mutex::new(String::new()),
            private: Mutex::new(false),
            config,
            ring_buf: Mutex::new(RingBuffer::new(ring_size)),
            input_tx: Arc::new(tokio::sync::Mutex::new(None)),
            resize_tx: Arc::new(tokio::sync::Mutex::new(None)),
            restart_count: std::sync::atomic::AtomicU32::new(0),
            created_at: Instant::now(),
            last_cols: Mutex::new(80),
            last_rows: Mutex::new(24),
            drain_start: Mutex::new(None),
            encoding_name: Mutex::new("utf-8".to_string()),
            executor_type: Mutex::new("local-shell".to_string()),
            sftp: Mutex::new(None),
            ssh_exec_handle: tokio::sync::Mutex::new(None),
            active_upload: tokio::sync::Mutex::new(None),
            download_ctrl: tokio::sync::Mutex::new(None),
            cancel: CancellationToken::new(),
        }
    }

    /// Add a new client to the session.
    pub fn add_client(&self, client: Arc<Client>) -> Result<(), String> {
        // Check private mode
        if *self.private.lock().unwrap() {
            // In private mode, only loopback clients can join
            let addr = &client.remote_addr;
            if !addr.is_empty() && !is_loopback(addr) {
                return Err("session is private".to_string());
            }
        }

        let client_id = client.id.clone();
        let is_first;
        {
            let mut clients = self.clients.lock().unwrap();
            is_first = clients.is_empty();
            clients.insert(client_id.clone(), client.clone());
        }

        // First non-readonly client becomes master and owner
        if is_first && client.role != ClientRole::ReadOnly {
            *self.master_id.lock().unwrap() = client_id.clone();
            *self.owner_id.lock().unwrap() = client_id;
        }

        // Transition to Running
        let mut state = self.state.lock().unwrap();
        if *state == SessionState::Created || *state == SessionState::Draining {
            *state = SessionState::Running;
            *self.drain_start.lock().unwrap() = None;
        }

        Ok(())
    }

    /// Remove (disconnect) a client. Returns the number of remaining connected clients.
    pub fn remove_client(&self, client_id: &str, conn_gen: u64) -> usize {
        let remaining;
        {
            let clients = self.clients.lock().unwrap();
            if let Some(client) = clients.get(client_id) {
                // Only disconnect if conn_gen matches (prevent stale goroutine from disconnecting new connection)
                if client.conn_gen() == conn_gen {
                    client.disconnect();
                }
            }
            remaining = clients.values().filter(|c| c.is_connected()).count();
        }

        if remaining == 0 {
            let mut state = self.state.lock().unwrap();
            if *state == SessionState::Running {
                *state = SessionState::Draining;
                *self.drain_start.lock().unwrap() = Some(Instant::now());
            }

            // If master disconnected, try to promote next connected viewer
            let master_id = self.master_id.lock().unwrap().clone();
            if master_id == client_id {
                self.try_promote_next_master();
            }
        } else {
            // If the disconnected client was master, promote next
            let master_id = self.master_id.lock().unwrap().clone();
            if master_id == client_id {
                self.try_promote_next_master();
            }
        }

        remaining
    }

    /// Try to promote the next connected non-readonly client to master.
    fn try_promote_next_master(&self) {
        let clients = self.clients.lock().unwrap();
        for client in clients.values() {
            if client.is_connected() && client.role != ClientRole::ReadOnly {
                *self.master_id.lock().unwrap() = client.id.clone();
                // Notify the promoted client
                client.send(protocol::encode_role_change(ClientRole::Master as u8));
                return;
            }
        }
    }

    /// Reconnect a previously-disconnected client.
    pub fn reconnect_client(
        &self,
        client_id: &str,
        remote_addr: String,
        grace: std::time::Duration,
    ) -> Result<mpsc::Receiver<Vec<u8>>, String> {
        let clients = self.clients.lock().unwrap();
        let client = clients
            .get(client_id)
            .ok_or_else(|| "client not found".to_string())?;

        if client.is_connected() {
            return Err("client already connected".to_string());
        }

        // Check grace period
        if client.idle_duration() > grace {
            return Err("reconnect grace period expired".to_string());
        }

        let rx = client.reconnect(remote_addr);

        // Transition back to Running if we were Draining
        let mut state = self.state.lock().unwrap();
        if *state == SessionState::Draining {
            *state = SessionState::Running;
            *self.drain_start.lock().unwrap() = None;
        }

        Ok(rx)
    }

    /// Set the terminal and start the I/O run loop.
    /// `self_arc` must be the same `Arc<Session>` from the SessionManager.
    pub async fn start_terminal(
        self_arc: Arc<Session>,
        term: Box<dyn crate::server::terminal::Terminal>,
    ) {
        let (input_tx, input_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(256);
        let (resize_tx, resize_rx) = tokio::sync::mpsc::channel::<(u16, u16)>(16);
        *self_arc.input_tx.lock().await = Some(input_tx);
        *self_arc.resize_tx.lock().await = Some(resize_tx);
        Session::spawn_run_loop(self_arc, term, input_rx, resize_rx);
    }

    fn spawn_run_loop(
        session: Arc<Session>,
        term: Box<dyn crate::server::terminal::Terminal>,
        mut input_rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
        mut resize_rx: tokio::sync::mpsc::Receiver<(u16, u16)>,
    ) {
        let cancel = session.cancel.clone();

        tokio::spawn(async move {
            let mut buf = vec![0u8; 32768];

            loop {
                tokio::select! {
                    _ = cancel.cancelled() => return,

                    // Handle resize → call terminal.resize()
                    Some((cols, rows)) = resize_rx.recv() => {
                        if let Err(e) = term.resize(cols, rows) {
                            eprintln!("[session {}] resize error: {}", session.id, e);
                        }
                    }

                    // Read terminal output → broadcast to clients
                    result = term.read(&mut buf) => {
                        match result {
                            Ok(0) => {
                                eprintln!("[session {}] terminal read returned 0 (EOF)", session.id);
                                session.broadcast(protocol::encode_session_end());
                                *session.state.lock().unwrap() = SessionState::Closed;
                                cancel.cancel();
                                return;
                            }
                            Err(e) => {
                                eprintln!("[session {}] terminal read error: {}", session.id, e);
                                session.broadcast(protocol::encode_session_end());
                                *session.state.lock().unwrap() = SessionState::Closed;
                                cancel.cancel();
                                return;
                            }
                            Ok(n) => {
                                session.append_to_ring_buffer(&buf[..n]);
                                let msg = protocol::encode_message(protocol::MSG_OUTPUT, &buf[..n]);
                                session.broadcast(msg);
                            }
                        }
                    }

                    // Receive input → write to terminal
                    input = input_rx.recv() => {
                        match input {
                            Some(data) => {
                                let _ = term.write(&data).await;
                            }
                            None => return,
                        }
                    }
                }
            }
        });
    }

    /// Handle input from a client (only master can write).
    pub fn handle_input(&self, client_id: &str, data: &[u8]) {
        let master_id = self.master_id.lock().unwrap().clone();
        if client_id != master_id {
            if let Some(client) = self.clients.lock().unwrap().get(client_id) {
                client.send(protocol::encode_error(
                    protocol::ERR_NOT_MASTER,
                    "not master",
                ));
            }
            return;
        }
        // Send input via channel to the run loop (which writes to terminal)
        let data = data.to_vec();
        let input_tx = self.input_tx.clone();
        tokio::spawn(async move {
            let guard = input_tx.lock().await;
            if let Some(ref tx) = *guard {
                let _ = tx.send(data).await;
            }
        });
    }

    /// Handle resize from a client (only master can resize).
    pub fn handle_resize(&self, client_id: &str, cols: u16, rows: u16) {
        let master_id = self.master_id.lock().unwrap().clone();
        if client_id != master_id {
            return;
        }
        *self.last_cols.lock().unwrap() = cols;
        *self.last_rows.lock().unwrap() = rows;
        let resize_tx = self.resize_tx.clone();
        tokio::spawn(async move {
            let guard = resize_tx.lock().await;
            if let Some(ref tx) = *guard {
                let _ = tx.send((cols, rows)).await;
            }
        });
    }

    /// Broadcast data to all connected clients.
    pub fn broadcast(&self, data: Vec<u8>) {
        let clients = self.clients.lock().unwrap();
        for client in clients.values() {
            if client.is_connected() {
                client.send(data.clone());
            }
        }
    }

    /// Send data to a specific client.
    pub fn send_to_client(&self, client_id: &str, data: Vec<u8>) {
        let clients = self.clients.lock().unwrap();
        if let Some(client) = clients.get(client_id) {
            client.send(data);
        }
    }

    /// Flush the ring buffer history to a client (for replay on connect).
    /// Sends in 4096-byte chunks to avoid overwhelming the WebSocket buffer.
    /// Prepends RIS (Reset Initial State) `\x1bc` to avoid TUI corruption.
    pub fn flush_ring_buffer(&self, client: &Client) {
        let ring = self.ring_buf.lock().unwrap();
        let data = ring.read_all();
        if data.is_empty() {
            return;
        }

        const CHUNK_SIZE: usize = 4096;

        // First chunk includes RIS prefix
        let ris = b"\x1bc";
        let first_end = CHUNK_SIZE.min(data.len());
        let mut msg = Vec::with_capacity(1 + ris.len() + first_end);
        msg.push(protocol::MSG_OUTPUT);
        msg.extend_from_slice(ris);
        msg.extend_from_slice(&data[..first_end]);
        client.send(msg);

        // Remaining chunks
        let mut offset = first_end;
        while offset < data.len() {
            let end = (offset + CHUNK_SIZE).min(data.len());
            let mut chunk = Vec::with_capacity(1 + (end - offset));
            chunk.push(protocol::MSG_OUTPUT);
            chunk.extend_from_slice(&data[offset..end]);
            client.send(chunk);
            offset = end;
        }
    }

    /// Nudge resize — shrink by 1 row then restore to force TUI redraw.
    pub fn nudge_resize(&self) {
        // TODO: implement when resize channel is added
    }

    /// Append output to the ring buffer.
    pub fn append_to_ring_buffer(&self, data: &[u8]) {
        self.ring_buf.lock().unwrap().write(data);
    }

    /// Set encoding for the session.
    pub fn set_encoding(&self, name: &str) {
        *self.encoding_name.lock().unwrap() = name.to_string();
    }

    /// Set private mode. Returns count of kicked non-loopback clients.
    pub fn set_private(&self, private: bool) -> usize {
        *self.private.lock().unwrap() = private;
        if !private {
            return 0;
        }
        // Kick non-loopback clients
        let clients = self.clients.lock().unwrap();
        let mut kicked = 0;
        for client in clients.values() {
            if client.is_connected() && !client.remote_addr.is_empty() && !is_loopback(&client.remote_addr) {
                client.disconnect();
                kicked += 1;
            }
        }
        kicked
    }

    /// Check if the session should be closed by TTL.
    pub fn should_close_by_ttl(&self, now: Instant) -> bool {
        let state = *self.state.lock().unwrap();
        if state != SessionState::Draining {
            return false;
        }
        let ttl = self.config.session_ttl;
        if ttl.is_zero() {
            return false; // infinite TTL
        }
        if let Some(drain_start) = *self.drain_start.lock().unwrap() {
            now.duration_since(drain_start) > ttl
        } else {
            false
        }
    }

    /// Find disconnected clients whose grace period has expired.
    pub fn expired_disconnected_clients(&self, _now: Instant, grace: std::time::Duration) -> Vec<String> {
        let clients = self.clients.lock().unwrap();
        clients
            .values()
            .filter(|c| !c.is_connected() && c.idle_duration() > grace)
            .map(|c| c.id.clone())
            .collect()
    }

    /// Permanently remove a client (after grace period expired).
    pub fn expire_client(&self, client_id: &str) {
        self.clients.lock().unwrap().remove(client_id);
    }

    /// Cancel the session's run loop.
    pub fn cancel(&self) {
        self.cancel.cancel();
    }

    /// Get the cancellation token.
    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancel.clone()
    }

    /// Current master client ID.
    pub fn master(&self) -> String {
        self.master_id.lock().unwrap().clone()
    }

    /// Session owner (first master, can reclaim).
    pub fn owner(&self) -> String {
        self.owner_id.lock().unwrap().clone()
    }

    /// Current state as string.
    pub fn state_string(&self) -> String {
        self.state.lock().unwrap().to_string()
    }

    /// List connected client info for API responses.
    pub fn list_clients(&self) -> Vec<client::ClientInfo> {
        let clients = self.clients.lock().unwrap();
        clients
            .values()
            .map(|c| client::ClientInfo {
                id: c.id.clone(),
                session_id: self.id.clone(),
                session_title: String::new(),
                role: c.role.as_str().to_string(),
                connected: c.is_connected(),
                last_seen: format!("{:?}", c.idle_duration()),
                remote_addr: c.remote_addr.clone(),
            })
            .collect()
    }

    /// Count connected clients.
    pub fn connected_client_count(&self) -> usize {
        self.clients
            .lock()
            .unwrap()
            .values()
            .filter(|c| c.is_connected())
            .count()
    }

    /// Kick a client by ID. Returns (remote_addr, found).
    pub fn kick_client(&self, client_id: &str) -> (String, bool) {
        let clients = self.clients.lock().unwrap();
        if let Some(client) = clients.get(client_id) {
            let addr = client.remote_addr.clone();
            client.disconnect();
            client.send(protocol::encode_error(protocol::ERR_KICKED, "kicked"));
            (addr, true)
        } else {
            (String::new(), false)
        }
    }

    /// Kick all clients from a specific IP. Returns count of kicked.
    pub fn kick_by_ip(&self, ip: &str) -> usize {
        let clients = self.clients.lock().unwrap();
        let mut count = 0;
        for client in clients.values() {
            if client.is_connected() && client.remote_addr == ip {
                client.disconnect();
                client.send(protocol::encode_error(protocol::ERR_KICKED, "kicked"));
                count += 1;
            }
        }
        count
    }

    /// Set a specific client as master.
    pub fn set_master(&self, client_id: &str) -> Result<(), String> {
        let clients = self.clients.lock().unwrap();
        if !clients.contains_key(client_id) {
            return Err("client not found".to_string());
        }
        // Notify old master of demotion
        let old_master = self.master_id.lock().unwrap().clone();
        if let Some(old) = clients.get(&old_master) {
            old.send(protocol::encode_role_change(ClientRole::Viewer as u8));
        }
        // Set new master
        *self.master_id.lock().unwrap() = client_id.to_string();
        if let Some(new) = clients.get(client_id) {
            new.send(protocol::encode_role_change(ClientRole::Master as u8));
        }
        Ok(())
    }

    /// Forward a master request to the current master.
    pub fn forward_master_request(&self, requester_id: &str) {
        let master_id = self.master_id.lock().unwrap().clone();
        let msg = protocol::encode_master_request_notify(requester_id, &self.id);
        self.send_to_client(&master_id, msg);
    }

    /// Handle master approval/rejection.
    pub fn handle_master_approval(&self, approver_id: &str, approved: bool, requester_id: &str) {
        let master_id = self.master_id.lock().unwrap().clone();
        if approver_id != master_id {
            return; // only current master can approve
        }
        if approved {
            let _ = self.set_master(requester_id);
        }
        // Notify requester of the result
        let msg = protocol::encode_master_approval(approved, requester_id);
        self.send_to_client(requester_id, msg);
    }
}

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

struct RingBuffer {
    buf: Vec<u8>,
    start: usize,
    len: usize,
    cap: usize,
}

impl RingBuffer {
    fn new(cap: usize) -> Self {
        Self {
            buf: vec![0u8; cap],
            start: 0,
            len: 0,
            cap,
        }
    }

    fn write(&mut self, data: &[u8]) {
        if self.cap == 0 {
            return;
        }
        for &byte in data {
            let pos = (self.start + self.len) % self.cap;
            self.buf[pos] = byte;
            if self.len == self.cap {
                // Buffer full — advance start (overwrite oldest)
                self.start = (self.start + 1) % self.cap;
            } else {
                self.len += 1;
            }
        }
    }

    fn read_all(&self) -> Vec<u8> {
        if self.len == 0 {
            return Vec::new();
        }
        let mut result = Vec::with_capacity(self.len);
        for i in 0..self.len {
            result.push(self.buf[(self.start + i) % self.cap]);
        }
        result
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn is_loopback(addr: &str) -> bool {
    // Strip port if present
    let ip_str = if let Some(bracket_end) = addr.find(']') {
        // IPv6 with brackets: [::1]:port
        &addr[1..bracket_end]
    } else if let Some(colon_pos) = addr.rfind(':') {
        // Could be IPv4:port or plain IPv6
        let potential_ip = &addr[..colon_pos];
        if potential_ip.parse::<std::net::IpAddr>().is_ok() {
            potential_ip
        } else {
            addr
        }
    } else {
        addr
    };

    ip_str
        .parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ring_buffer() {
        let mut rb = RingBuffer::new(4);
        rb.write(b"ab");
        assert_eq!(rb.read_all(), b"ab");
        rb.write(b"cde");
        assert_eq!(rb.read_all(), b"bcde"); // 'a' overwritten
    }

    #[test]
    fn test_is_loopback() {
        assert!(is_loopback("127.0.0.1"));
        assert!(is_loopback("127.0.0.1:8080"));
        assert!(is_loopback("::1"));
        assert!(is_loopback("[::1]:8080"));
        assert!(!is_loopback("192.168.1.1"));
        assert!(!is_loopback("192.168.1.1:8080"));
    }
}
