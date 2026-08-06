//! Session management — mirrors Go `session/session.go`.
//!
//! A `Session` owns a terminal (PTY/SSH), a set of connected clients,
//! a ring buffer for output history, and an optional recorder.

pub(crate) mod access;
pub mod client;
pub mod downloads;
mod lan_access;
pub mod manager;
pub mod modes;
pub mod state;
pub mod transfer;

#[cfg(test)]
mod security_tests;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::server::auth::AuthPrincipal;
use crate::server::events::{DesktopEvent, EventBus};
use crate::server::protocol;
use access::SessionCreator;
use client::{Client, ClientSecurityContext};
use state::{ClientRole, SessionState};

/// run loop 的终端控制消息(经原 resize channel 传递)。
pub enum TermCtrl {
    Resize(u16, u16),
    /// 无条件向前台进程组补发 SIGWINCH(同尺寸接管/attach 强制 TUI 重绘)。
    Nudge,
    /// 恢复到 last_cols/last_rows 的最新值(nudge 抖动的恢复段专用:
    /// 快照会与并发的客户端 resize 竞态,把 PTY 打回过期尺寸——
    /// 接管态"重绘后右侧/底部间隙"的根因)。
    RestoreLast,
}

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

/// Upload flow control signal.
#[derive(Debug, Clone, Copy)]
pub enum UploadSignal {
    Pause,
    Continue,
    Cancel,
}

pub type TransferOwnerKey = (String, u64, u32);

/// Active upload state — tracks an in-progress file upload.
/// Holds the remote SFTP file handle open for streaming writes (matches Go).
/// Uses pipelined SFTP writes: sends Write requests without waiting, collects
/// responses later — turns N sequential round-trips into ~1 round-trip latency.
pub struct UploadState {
    pub path: String,
    pub part_path: String,
    pub total_size: i64,
    pub received: i64,
    pub lease: transfer::UploadPathLease,
    pub phase: transfer::UploadPhase,
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
    /// Maximum pipeline window size for this workload.
    max_window: usize,
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
    const DOWNLOAD_INITIAL_WINDOW: usize = 8;
    const DOWNLOAD_SSTHRESH: usize = 16;
    const DOWNLOAD_MAX_WINDOW: usize = 24;
    const DIRECT_DOWNLOAD_INITIAL_WINDOW: usize = 16;
    const DIRECT_DOWNLOAD_SSTHRESH: usize = 48;
    const DIRECT_DOWNLOAD_MAX_WINDOW: usize = 96;

    pub fn new() -> Self {
        Self {
            window: Self::INITIAL_WINDOW,
            max_window: Self::MAX_WINDOW,
            ssthresh: Self::INITIAL_SSTHRESH,
            ack_count: 0,
            send_time: None,
            srtt_ms: 0.0,
        }
    }

    pub fn for_download() -> Self {
        Self {
            window: Self::DOWNLOAD_INITIAL_WINDOW,
            max_window: Self::DOWNLOAD_MAX_WINDOW,
            ssthresh: Self::DOWNLOAD_SSTHRESH,
            ack_count: 0,
            send_time: None,
            srtt_ms: 0.0,
        }
    }

    pub fn for_direct_download() -> Self {
        Self {
            window: Self::DIRECT_DOWNLOAD_INITIAL_WINDOW,
            max_window: Self::DIRECT_DOWNLOAD_MAX_WINDOW,
            ssthresh: Self::DIRECT_DOWNLOAD_SSTHRESH,
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
            self.window = (self.window + 1).min(self.max_window);
        } else {
            self.ack_count += 1;
            if self.ack_count >= self.window {
                self.window = (self.window + 1).min(self.max_window);
                self.ack_count = 0;
            }
        }
    }
}

/// A terminal session.
pub struct Session {
    pub id: String,
    /// Immutable authenticated creator. SSH sessions require an exact match
    /// for device access; owner requests remain administrative superusers.
    creator: Option<SessionCreator>,
    pub state: Mutex<SessionState>,
    pub clients: Mutex<HashMap<String, Arc<Client>>>,
    pub master_id: Mutex<String>,
    pub owner_id: Mutex<String>,
    pub private: Mutex<bool>,
    pub config: SessionConfig,

    // Ring buffer for output history replay
    ring_buf: Mutex<RingBuffer>,

    /// 私有模式跟踪:replay 时恢复 alt-screen/鼠标/DECCKM 等状态
    /// (模式序列可能已滚出环形缓冲,见 modes.rs 模块注释)。
    mode_tracker: Mutex<modes::ModeTracker>,

    /// Channel to send input data to the terminal.
    input_tx: Arc<tokio::sync::Mutex<Option<tokio::sync::mpsc::Sender<Vec<u8>>>>>,
    /// Channel to send resize commands to the terminal.
    resize_tx: Arc<tokio::sync::Mutex<Option<tokio::sync::mpsc::Sender<TermCtrl>>>>,
    /// Restart count for auto-restart logic.
    restart_count: std::sync::atomic::AtomicU32,

    pub created_at: Instant,
    /// Wall-clock creation time for API responses (Instant is not serializable).
    pub created_at_system: std::time::SystemTime,
    pub last_cols: Mutex<u16>,
    pub last_rows: Mutex<u16>,

    /// When the last client disconnected (for TTL tracking).
    pub drain_start: Mutex<Option<Instant>>,

    /// Encoding name (utf-8 by default, can be gbk/big5/etc.)
    pub encoding_name: Mutex<String>,

    /// Executor type: "local-shell", "ssh", "jumpserver"
    pub executor_type: Mutex<String>,

    /// 终端窗口标题(OSC 0/2,由 osc_filter 旁路记录)。空 = shell 未设置过。
    pub title: Mutex<String>,
    /// 当前工作目录(fix13 Git tab:OSC 7 / OSC 7768 precmd 旁路记录,随 shell cd 更新)。
    /// None = shell integration 未上报过。仅本机会话有意义(SSH 的 cwd 是远端路径)。
    pub current_cwd: Mutex<Option<String>>,
    /// 最近一次终端输出时间(会话列表展示"空闲时长")。
    pub last_output_at: Mutex<std::time::SystemTime>,

    /// SFTP client for SSH sessions (None for local sessions).
    pub sftp: Mutex<Option<std::sync::Arc<russh_sftp::client::SftpSession>>>,

    /// Last failure encountered while initializing SFTP, if any. Surfaced
    /// in the `SFTP_NOT_AVAILABLE` error so the frontend can show *why*
    /// it never became ready (e.g. "subsystem rejected by Koko") rather
    /// than the generic "not ready yet, please retry".
    pub sftp_init_error: Mutex<Option<String>>,

    /// Original SSH connection config for transfer backends that may need a
    /// dedicated connection with different transport characteristics.
    pub ssh_config: Mutex<Option<crate::server::terminal::ssh::SshConfig>>,

    /// SSH session handle for exec (ServerInfo, process list). Type-erased.
    pub ssh_exec_handle: tokio::sync::Mutex<Option<Box<dyn std::any::Any + Send + Sync>>>,

    /// Active uploads are owned by one exact connection generation.
    pub active_uploads: tokio::sync::Mutex<HashMap<TransferOwnerKey, UploadState>>,

    /// Destination-path ownership shared by WebSocket and desktop IPC uploads.
    pub upload_path_leases: transfer::UploadPathLeaseRegistry,

    /// Unified, bounded WS/IPC download ownership and cancellation.
    pub(crate) download_registry: Arc<downloads::DownloadRegistry>,

    /// Upload control channels keyed by transferId (supports parallel uploads).
    pub upload_ctrls: tokio::sync::Mutex<HashMap<u32, tokio::sync::mpsc::Sender<UploadSignal>>>,

    /// 7768 兜底回调槽(agent 镜像 Task D):镜像态下顶层 shell 回 prompt(OSC 7768)即
    /// claude 可能已退出,run loop 经 [`Self::dispatch_shell_prompt`] 把 7768 首字段的
    /// exit code(`$?`)传给本槽回调(FIX-4:挂起/退出的判别在回调侧,见 agent/hook.rs;
    /// agent/hook.rs 升格时设置、清理时置 None;Arc 便于 clone 后锁外调用,守卫忽略的
    /// 调用不消耗回调)。非镜像态恒 None。
    pub(crate) on_shell_prompt: Mutex<Option<Arc<dyn Fn(i32) + Send + Sync>>>,

    /// OSC filter — intercepts MeTerm OSC sequences from terminal output.
    osc_filter: Mutex<crate::server::osc_filter::OscFilter>,

    /// Cancellation token for the session's run loop.
    cancel: CancellationToken,

    /// 桌面级事件总线(终端通知 Phase 1):run loop 抽出 `OscEvent::Notify` 时,
    /// 除会话内 `MSG_OSC_EVENT` 广播外,额外投一份 `DesktopEvent::Notify` 到这里,
    /// 供 presence WS(后续任务)订阅转发给手机。
    event_bus: EventBus,
}

impl Session {
    pub fn new(id: String, config: SessionConfig, event_bus: EventBus) -> Self {
        Self::new_with_creator(id, config, event_bus, None)
    }

    pub(crate) fn new_with_creator(
        id: String,
        config: SessionConfig,
        event_bus: EventBus,
        creator: Option<SessionCreator>,
    ) -> Self {
        let ring_size = config.ring_buffer_size;
        let cancel = CancellationToken::new();
        Self {
            id,
            creator,
            state: Mutex::new(SessionState::Created),
            clients: Mutex::new(HashMap::new()),
            master_id: Mutex::new(String::new()),
            owner_id: Mutex::new(String::new()),
            private: Mutex::new(false),
            config,
            ring_buf: Mutex::new(RingBuffer::new(ring_size)),
            mode_tracker: Mutex::new(modes::ModeTracker::new()),
            input_tx: Arc::new(tokio::sync::Mutex::new(None)),
            resize_tx: Arc::new(tokio::sync::Mutex::new(None)),
            restart_count: std::sync::atomic::AtomicU32::new(0),
            created_at: Instant::now(),
            created_at_system: std::time::SystemTime::now(),
            last_cols: Mutex::new(80),
            last_rows: Mutex::new(24),
            drain_start: Mutex::new(None),
            encoding_name: Mutex::new("utf-8".to_string()),
            executor_type: Mutex::new("local-shell".to_string()),
            title: Mutex::new(String::new()),
            last_output_at: Mutex::new(std::time::SystemTime::now()),
            sftp: Mutex::new(None),
            sftp_init_error: Mutex::new(None),
            ssh_config: Mutex::new(None),
            ssh_exec_handle: tokio::sync::Mutex::new(None),
            active_uploads: tokio::sync::Mutex::new(HashMap::new()),
            upload_path_leases: transfer::UploadPathLeaseRegistry::new(),
            download_registry: Arc::new(downloads::DownloadRegistry::new(&cancel)),
            upload_ctrls: tokio::sync::Mutex::new(HashMap::new()),
            on_shell_prompt: Mutex::new(None),
            current_cwd: Mutex::new(None),
            osc_filter: Mutex::new(crate::server::osc_filter::OscFilter::new()),
            cancel,
            event_bus,
        }
    }

    pub(crate) fn creator_allows_principal(&self, principal: &AuthPrincipal) -> bool {
        if matches!(principal, AuthPrincipal::Owner { .. }) {
            return true;
        }
        self.creator
            .as_ref()
            .is_some_and(|creator| creator.allows_principal(principal))
    }

    pub(crate) fn creator_allows_device(&self, device_id: &str, generation: uuid::Uuid) -> bool {
        self.creator
            .as_ref()
            .is_some_and(|creator| creator.allows_device(device_id, generation))
    }

    /// run loop 的 OSC 7768 → 回调槽接线(FIX-6:抽成方法便于单测,锁定「ShellState 事件
    /// 必须携带 exit code 调回调」的真实通路):每个 `ShellState` 事件把 7768 首字段的
    /// exit code(`$?`)传给 `on_shell_prompt` 回调,非 ShellState 事件不触发。
    /// clone 后**锁外**调用:回调内部要拿 mirrors registry 锁,不得与槽锁交叠
    /// (锁序论证见 agent/hook.rs `MirrorRegistry::cleanup`)。
    pub(crate) fn dispatch_shell_prompt(&self, events: &[crate::server::osc_filter::OscEvent]) {
        for e in events {
            match e {
                crate::server::osc_filter::OscEvent::ShellState { exit, cwd, .. } => {
                    // fix13:7768 precmd 携带 cwd,旁路记录(Git tab 的 repo 根定位)。
                    if !cwd.is_empty() {
                        *self.current_cwd.lock().unwrap() = Some(cwd.clone());
                    }
                    let cb = self.on_shell_prompt.lock().unwrap().clone();
                    if let Some(cb) = cb {
                        cb(*exit);
                    }
                }
                // OSC 7(file://host/path)同样上报 cwd(无 7768 集成的 shell 兜底)。
                crate::server::osc_filter::OscEvent::Cwd { cwd } => {
                    if !cwd.is_empty() {
                        *self.current_cwd.lock().unwrap() = Some(cwd.clone());
                    }
                }
                _ => {}
            }
        }
    }

    /// Add a new client to the session.
    pub fn add_client(&self, client: Arc<Client>) -> Result<(), String> {
        // Lock order for private transitions is always
        // private -> clients -> master -> owner.
        // Holding the private guard through insertion closes the gap where
        // set_private(true) could scan before this client appeared.
        let private_guard = self.private.lock().unwrap();
        if *private_guard {
            // Private mode is local-owner only. Relay's peer address is a
            // synthetic loopback and must not grant this privilege.
            if !client.is_trusted_local_owner() {
                return Err("session is private".to_string());
            }
        }

        let client_id = client.id.clone();
        let mut clients = self.clients.lock().unwrap();
        if *self.state.lock().unwrap() == SessionState::Closed {
            return Err("session is closed".to_string());
        }
        clients.insert(client_id, client);

        // Registration, implicit promotion, and immutable owner initialization
        // are one transaction. A concurrent takeover/private transition cannot
        // overwrite a newer decision with a stale `should_promote` snapshot.
        let mut master = self.master_id.lock().unwrap();
        Self::reconcile_master_locked(&clients, &mut master, false, false);
        let mut owner = self.owner_id.lock().unwrap();
        if owner.is_empty() && !master.is_empty() {
            *owner = master.clone();
        }
        drop(owner);
        drop(master);

        // Keep lifecycle state linearized with the same client registration.
        self.reconcile_state_locked(&clients);
        drop(clients);
        drop(private_guard);

        Ok(())
    }

    /// Remove (disconnect) a client. Returns the number of remaining connected clients.
    pub fn remove_client(&self, client_id: &str, conn_gen: u64) -> usize {
        let clients = self.clients.lock().unwrap();
        if let Some(client) = clients.get(client_id) {
            // conn_gen 不匹配 = 这是"被重连顶替的旧连接任务"的清理调用。
            if client.conn_gen() != conn_gen {
                return clients.values().filter(|c| c.is_connected()).count();
            }
            client.disconnect();
        }
        let remaining = clients.values().filter(|c| c.is_connected()).count();

        // Exact-generation disconnect and any resulting master transition are
        // one clients -> master transaction. Reconnect cannot install H1
        // between H0's disconnect and a stale stable-ID promotion.
        let mut master = self.master_id.lock().unwrap();
        // A normal transport loss keeps the stable master ID when nobody can
        // take over, allowing the same authenticated client to resume within
        // grace. If another eligible client is online, promote it atomically.
        Self::reconcile_master_locked(&clients, &mut master, false, true);
        drop(master);
        self.reconcile_state_locked(&clients);

        remaining
    }

    /// Reconcile `master_id` while the caller holds `clients`.
    ///
    /// `clear_if_none` is false for an ordinary network loss (the same
    /// authenticated client may resume its role during grace) and true for an
    /// explicit security teardown such as kick/revoke/private/LAN shutdown.
    pub(super) fn reconcile_master_locked(
        clients: &HashMap<String, Arc<Client>>,
        master: &mut String,
        clear_if_none: bool,
        notify: bool,
    ) {
        let current_is_eligible = clients
            .get(master.as_str())
            .is_some_and(|client| client.is_connected() && client.role != ClientRole::ReadOnly);
        if current_is_eligible {
            return;
        }

        let old_master = master.clone();
        let eligible =
            |client: &&Arc<Client>| client.is_connected() && client.role != ClientRole::ReadOnly;
        // Prefer the process-local owner on failover, then any eligible
        // viewer. This keeps desktop control recovery deterministic.
        let next = clients
            .values()
            .filter(eligible)
            .find(|client| client.is_trusted_local_owner())
            .or_else(|| clients.values().find(eligible));

        if let Some(next) = next {
            *master = next.id.clone();
            if notify {
                if old_master != next.id {
                    if let Some(old) = clients.get(&old_master) {
                        if old.is_connected() {
                            old.send(protocol::encode_role_change(ClientRole::Viewer as u8));
                        }
                    }
                }
                next.send(protocol::encode_role_change(ClientRole::Master as u8));
            }
        } else if clear_if_none {
            if notify {
                if let Some(old) = clients.get(&old_master) {
                    if old.is_connected() {
                        old.send(protocol::encode_role_change(ClientRole::Viewer as u8));
                    }
                }
            }
            master.clear();
        }
    }

    /// Reconcile Running/Draining while the caller holds `clients`, so a
    /// concurrent add/reconnect cannot be overwritten by a stale disconnect.
    fn reconcile_state_locked(&self, clients: &HashMap<String, Arc<Client>>) {
        let has_connected = clients.values().any(|client| client.is_connected());
        let mut state = self.state.lock().unwrap();
        if has_connected {
            if *state == SessionState::Created || *state == SessionState::Draining {
                *state = SessionState::Running;
                *self.drain_start.lock().unwrap() = None;
            }
        } else if *state == SessionState::Running {
            *state = SessionState::Draining;
            *self.drain_start.lock().unwrap() = Some(Instant::now());
        }
    }

    /// Reconnect a previously-disconnected client.
    pub fn reconnect_client(
        &self,
        client_id: &str,
        remote_addr: String,
        security: ClientSecurityContext,
        grace: std::time::Duration,
    ) -> Result<client::WsReceivers, String> {
        // Match add_client/set_private lock order. A reconnect either finishes
        // registration before set_private scans, or observes private=true and
        // is rejected; it can never slip into the post-scan gap.
        let private_guard = self.private.lock().unwrap();
        if *private_guard && !security.is_trusted_local_owner() {
            return Err("session is private".to_string());
        }
        let clients = self.clients.lock().unwrap();
        if *self.state.lock().unwrap() == SessionState::Closed {
            return Err("session is closed".to_string());
        }
        let client = clients
            .get(client_id)
            .ok_or_else(|| "client not found".to_string())?;

        // Authenticate the reconnect before touching the existing connection;
        // otherwise a different paired phone could disconnect a master merely
        // by guessing its public client_id.
        if !client.matches_authenticated_identity(&security) {
            return Err("client identity mismatch".to_string());
        }

        let was_connected = client.is_connected();
        if was_connected {
            // Force-disconnect the stale connection. If a client reconnects with the
            // same client_id, the old TCP connection must be dead (e.g., after system
            // sleep/wake). Disconnecting drops the old send channel so the previous
            // WebSocket handler exits cleanly via its rx.recv() returning None.
            eprintln!(
                "[ws] force-disconnecting stale client={} for reconnect",
                client_id
            );
            client.disconnect();
        }

        // Check grace period — skip if the client was still "connected" (stale),
        // since last_seen isn't updated during an active connection and would be
        // stale itself (e.g., after system sleep).
        if !was_connected && client.idle_duration() > grace {
            return Err("reconnect grace period expired".to_string());
        }

        let rx = client.reconnect(remote_addr, security)?;
        self.reconcile_state_locked(&clients);
        drop(clients);
        drop(private_guard);

        Ok(rx)
    }

    /// Set the terminal and start the I/O run loop.
    /// `self_arc` must be the same `Arc<Session>` from the SessionManager.
    pub async fn start_terminal(
        self_arc: Arc<Session>,
        term: Box<dyn crate::server::terminal::Terminal>,
    ) {
        let (input_tx, input_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(256);
        let (resize_tx, resize_rx) = tokio::sync::mpsc::channel::<TermCtrl>(16);
        *self_arc.input_tx.lock().await = Some(input_tx);
        *self_arc.resize_tx.lock().await = Some(resize_tx);
        Session::spawn_run_loop(self_arc, term, input_rx, resize_rx);
    }

    fn spawn_run_loop(
        session: Arc<Session>,
        term: Box<dyn crate::server::terminal::Terminal>,
        mut input_rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
        mut resize_rx: tokio::sync::mpsc::Receiver<TermCtrl>,
    ) {
        let cancel = session.cancel.clone();

        tokio::spawn(async move {
            let mut buf = vec![0u8; 32768];

            loop {
                tokio::select! {
                    _ = cancel.cancelled() => return,

                    // Handle resize/nudge → call terminal
                    Some(ctrl) = resize_rx.recv() => {
                        match ctrl {
                            TermCtrl::Resize(cols, rows) => {
                                if let Err(e) = term.resize(cols, rows) {
                                    eprintln!("[session {}] resize error: {}", session.id, e);
                                }
                            }
                            TermCtrl::Nudge => term.nudge(),
                            TermCtrl::RestoreLast => {
                                // 读处理时刻的最新尺寸(客户端 resize 已即时更新 last_*)
                                let c = *session.last_cols.lock().unwrap();
                                let r = *session.last_rows.lock().unwrap();
                                if let Err(e) = term.resize(c, r) {
                                    eprintln!("[session {}] restore resize failed: {}", session.id, e);
                                }
                            }
                        }
                    }

                    // Read terminal output → broadcast to clients
                    result = term.read(&mut buf) => {
                        match result {
                            Ok(0) => {
                                eprintln!("[session {}] terminal read returned 0 (EOF)", session.id);
                                session.close_with_frame(protocol::encode_session_end());
                                return;
                            }
                            Err(e) => {
                                eprintln!("[session {}] terminal read error: {}", session.id, e);
                                session.close_with_frame(protocol::encode_session_end());
                                return;
                            }
                            Ok(n) => {
                                // Filter OSC sequences in Rust — clean output goes to
                                // xterm.js, events go as MSG_OSC_EVENT to frontend.
                                let (clean, events, new_title) = {
                                    let mut filter = session.osc_filter.lock().unwrap();
                                    let (c, e) = filter.feed(&buf[..n]);
                                    (c, e, filter.take_title())
                                };
                                *session.last_output_at.lock().unwrap() = std::time::SystemTime::now();
                                if let Some(t) = new_title {
                                    // 标题截尾 70 字符,与桌面前端 onTitleChange 口径一致;空 = 清除
                                    let t: String = t.chars().rev().take(70).collect::<Vec<_>>().into_iter().rev().collect();
                                    *session.title.lock().unwrap() = t;
                                }
                                if !clean.is_empty() {
                                    session.append_to_ring_buffer(&clean);
                                    let msg = protocol::encode_message(protocol::MSG_OUTPUT, &clean);
                                    session.broadcast(msg);
                                }
                                if !events.is_empty() {
                                    if let Ok(json) = serde_json::to_vec(&events) {
                                        let msg = protocol::encode_message(protocol::MSG_OSC_EVENT, &json);
                                        session.broadcast(msg);
                                    }
                                    // 额外一路:通知性 OscEvent 投到桌面事件总线,供 presence WS
                                    // (后续任务)转发给手机。不影响上面的会话内 MSG_OSC_EVENT 广播。
                                    // 先 clone 出标题、显式释放锁,避免在持有 title 锁的同时
                                    // 又去 publish(publish 内部不持锁,但保持"取值后立即放锁"的习惯,
                                    // 防止未来在 publish 路径里引入回读 title 造成死锁)。
                                    let session_title = session.title.lock().unwrap().clone();
                                    for desktop_event in
                                        notify_events_to_publish(&events, &session.id, &session_title)
                                    {
                                        session.event_bus.publish(desktop_event);
                                    }
                                    // Task D:镜像态下顶层 shell 回 prompt(OSC 7768)= claude
                                    // 可能已退出,接线抽在 dispatch_shell_prompt(FIX-6 可单测)。
                                    session.dispatch_shell_prompt(&events);
                                }
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

    /// M6 测试 seam:直接装上 input channel(绕过 `start_terminal` 的真实 PTY),
    /// 返回接收端供测试观察「注入 PTY 的字节」。仅测试编译,生产代码零改动。
    #[cfg(test)]
    pub(crate) async fn install_input_channel_for_test(
        &self,
    ) -> tokio::sync::mpsc::Receiver<Vec<u8>> {
        let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(256);
        *self.input_tx.lock().await = Some(tx);
        rx
    }

    /// 断开"心跳停跳"的 IPC 客户端:前端 reload 后旧 Tauri Channel 发送
    /// 不报错(消息静默丢弃),僵尸客户端让会话永远"有人连着"——不进
    /// draining、不被回收、poller 也不接管(真机反馈:手机列表 4 个会话
    /// 电脑只有 1 个标签)。WS 客户端有 TCP 断开事件,不在此列。
    pub fn disconnect_stale_ipc_clients(&self, stale_after: std::time::Duration) -> usize {
        let stale: Vec<(String, u64)> = {
            let clients = self.clients.lock().unwrap();
            clients
                .values()
                .filter(|c| {
                    c.is_connected()
                        && c.remote_addr.starts_with("ipc://")
                        && c.idle_duration() > stale_after
                })
                .map(|client| (client.id.clone(), client.conn_gen()))
                .collect()
        };

        // Rebind every scan result to its exact live generation and recheck
        // idleness at commit. A heartbeat/reconnect between scan and commit
        // must not be disconnected.
        let clients = self.clients.lock().unwrap();
        let mut count = 0;
        for (client_id, conn_gen) in stale {
            let Some(client) = clients.get(&client_id) else {
                continue;
            };
            if !client.is_current_connection(conn_gen)
                || !client.remote_addr.starts_with("ipc://")
                || client.idle_duration() <= stale_after
            {
                continue;
            }
            eprintln!(
                "[session {}] disconnect stale ipc client {}",
                self.id, client.id
            );
            client.disconnect();
            count += 1;
        }
        let mut master = self.master_id.lock().unwrap();
        Self::reconcile_master_locked(&clients, &mut master, true, true);
        drop(master);
        self.reconcile_state_locked(&clients);
        count
    }

    /// Broadcast data to all connected clients.
    pub fn broadcast(&self, data: Vec<u8>) {
        let clients = self.clients.lock().unwrap();
        for client in clients.values() {
            if client.is_connected() {
                client.send(data.clone());
            }
        }
        // Client::send marks a failed downstream disconnected. Reconcile while
        // the same client snapshot is locked so an IPC/WS send failure cannot
        // leave a ghost Running/master state until the periodic reaper.
        let mut master = self.master_id.lock().unwrap();
        Self::reconcile_master_locked(&clients, &mut master, false, true);
        drop(master);
        self.reconcile_state_locked(&clients);
    }

    /// Send data to a specific client. 返回投递是否成功。
    ///
    /// `true` = client 在会话表内且 `Client::send` 成功(通道未满/未关闭);
    /// `false` = client 不在表中,或已断开 / 通道关闭。agent fan-out 据此惰性剔除
    /// 失联的 attached id(见 `agent::manager::fan_out_one`)。
    pub fn send_to_client(&self, client_id: &str, data: Vec<u8>) -> bool {
        let clients = self.clients.lock().unwrap();
        let sent = if let Some(client) = clients.get(client_id) {
            client.send(data)
        } else {
            false
        };
        if !sent {
            let mut master = self.master_id.lock().unwrap();
            Self::reconcile_master_locked(&clients, &mut master, false, true);
            drop(master);
            self.reconcile_state_locked(&clients);
        }
        sent
    }

    /// Blocking send to a specific client (for bulk transfers like file download).
    /// Waits for channel capacity instead of disconnecting on full.
    pub async fn send_to_client_async(&self, client_id: &str, data: Vec<u8>) -> bool {
        let client_and_generation = {
            let clients = self.clients.lock().unwrap();
            clients
                .get(client_id)
                .map(|client| (client.clone(), client.conn_gen()))
        };
        if let Some((client, generation)) = client_and_generation {
            let sent = client.send_async(data).await;
            if !sent {
                self.remove_client(client_id, generation);
            }
            sent
        } else {
            false
        }
    }

    pub async fn send_to_client_generation_async(
        &self,
        client_id: &str,
        expected_conn_gen: u64,
        data: Vec<u8>,
    ) -> bool {
        let client = {
            let clients = self.clients.lock().unwrap();
            clients.get(client_id).cloned()
        };
        let sent = match client {
            Some(client) => {
                client
                    .send_async_for_generation(expected_conn_gen, data)
                    .await
            }
            None => false,
        };
        if !sent {
            self.remove_client(client_id, expected_conn_gen);
        }
        sent
    }

    /// Blocking send for bulk transfers on the client's low-priority queue.
    pub async fn send_bulk_to_client_async(&self, client_id: &str, data: Vec<u8>) -> bool {
        let client_and_generation = {
            let clients = self.clients.lock().unwrap();
            clients
                .get(client_id)
                .map(|client| (client.clone(), client.conn_gen()))
        };
        if let Some((client, generation)) = client_and_generation {
            let sent = client.send_bulk_async(data).await;
            if !sent {
                self.remove_client(client_id, generation);
            }
            sent
        } else {
            false
        }
    }

    pub async fn send_bulk_to_client_generation_async(
        &self,
        client_id: &str,
        expected_conn_gen: u64,
        data: Vec<u8>,
    ) -> bool {
        let client = {
            let clients = self.clients.lock().unwrap();
            clients.get(client_id).cloned()
        };
        let sent = match client {
            Some(client) => {
                client
                    .send_bulk_async_for_generation(expected_conn_gen, data)
                    .await
            }
            None => false,
        };
        if !sent {
            self.remove_client(client_id, expected_conn_gen);
        }
        sent
    }

    /// Flush the ring buffer history to a client (for replay on connect).
    /// Sends in 4096-byte chunks to avoid overwhelming the WebSocket buffer.
    /// Prepends RIS (Reset Initial State) `\x1bc` to avoid TUI corruption.
    ///
    /// RIS 会复位所有终端模式;紧随其后重放 ModeTracker 记录的当前私有模式
    /// (alt-screen/鼠标/DECCKM 等),再回放缓冲内容——这样内容落进正确的
    /// 缓冲区(alt-screen),新 attach 的手机端也能得到正确的鼠标/粘贴模式。
    /// 模式重放必须在内容之前:1049h 先切 alt,回放内容才与原绘制环境一致。
    pub fn flush_ring_buffer(&self, client: &Client, expected_conn_gen: u64) {
        let ring = self.ring_buf.lock().unwrap();
        let data = ring.read_all();
        let mode_seq = self.mode_tracker.lock().unwrap().replay_seq();
        if data.is_empty() && mode_seq.is_empty() {
            return;
        }

        const CHUNK_SIZE: usize = 4096;

        // First chunk: RIS + 模式重放 + 内容头部
        let ris = b"\x1bc";
        let first_end = CHUNK_SIZE.min(data.len());
        let mut msg = Vec::with_capacity(1 + ris.len() + mode_seq.len() + first_end);
        msg.push(protocol::MSG_OUTPUT);
        msg.extend_from_slice(ris);
        msg.extend_from_slice(&mode_seq);
        msg.extend_from_slice(&data[..first_end]);
        if !self.send_to_client_generation(&client.id, expected_conn_gen, msg) {
            return;
        }

        // Remaining chunks
        let mut offset = first_end;
        while offset < data.len() {
            let end = (offset + CHUNK_SIZE).min(data.len());
            let mut chunk = Vec::with_capacity(1 + (end - offset));
            chunk.push(protocol::MSG_OUTPUT);
            chunk.extend_from_slice(&data[offset..end]);
            if !self.send_to_client_generation(&client.id, expected_conn_gen, chunk) {
                return;
            }
            offset = end;
        }
    }

    /// [`flush_ring_buffer`] 的**背压变体**:内容/语义与其完全一致(RIS 复位 + 模式重放 +
    /// MSG_OUTPUT 分片),唯一区别是逐块用 [`Client::send_async`](client::Client::send_async)
    /// 发送——priority 通道满时**等待 writer 排空**,而非 [`Client::send`](client::Client::send)
    /// 的 `Full → disconnect() + 截断`。
    ///
    /// 为什么镜像 WS attach 路径必须用它:Mirror 分支先 `entry.attach()`(背压回放 agent 历史),
    /// 可能把 1024 槽 priority 通道填到**正好满**;紧接着若再用非阻塞 `flush_ring_buffer` 回放终端
    /// 环形缓冲,首块就撞 `TrySendError::Full → disconnect()`,丢弃 client + 截断回放 → 手机大历史 +
    /// 慢 sink 下**永久重连环**(正是 attach 背压化消灭的 Critical bug 的终端缓冲镜像版)。改用背压
    /// 发送后,通道满则挂起等 writer 排空,绝不 disconnect、绝不截断。
    ///
    /// **不持锁跨 await**:先在锁内只做快照(读环形缓冲全量 + 当前模式重放序列),释放锁后再 await
    /// 发送(仿 [`attach_client`](crate::server::agent::manager) 的做法),避免持 std Mutex 跨 `.await`
    /// 阻塞 run loop 的 `append_to_ring_buffer`。**前提**:调用方须已 spawn writer 并发排空 priority
    /// 通道(WS 侧 writer-before-attach),否则背压 await 会死等;IPC 下行无背压容量限制,不适用此路径。
    pub async fn flush_ring_buffer_async(&self, client: &Client, expected_conn_gen: u64) {
        // BUG-2 守卫(终端回放镜像版,对照 `attach_client` agent/manager.rs:326/358):捕获本次连接
        // 代次。背压化让本 flush 成了跨多个 `.await` 的长任务;被同 client_id 的 reconnect 顶替后
        // `send_async` 会重读已换成新通道的 downstream(reconnect 后 connected=true),把陈旧终端回放帧
        // (首块 RIS 复位 + 后续 MSG_OUTPUT)灌进新连接 → 与新 handler 自己的 attach+flush 回放交错、
        // 终端页乱码。故起始捕获 gen,各发送前比对 `conn_gen() == gen`,不等(被 reconnect bump)即 abort。
        // 锁内只做快照:读环形缓冲全量 + 当前模式重放序列,随即释放锁(绝不持锁跨 await)。
        let (data, mode_seq) = {
            let data = self.ring_buf.lock().unwrap().read_all();
            let mode_seq = self.mode_tracker.lock().unwrap().replay_seq();
            (data, mode_seq)
        };
        if data.is_empty() && mode_seq.is_empty() {
            return;
        }

        const CHUNK_SIZE: usize = 4096;

        // First chunk: RIS + 模式重放 + 内容头部(背压发送,满则等 writer 排空)。
        let ris = b"\x1bc";
        let first_end = CHUNK_SIZE.min(data.len());
        let mut msg = Vec::with_capacity(1 + ris.len() + mode_seq.len() + first_end);
        msg.push(protocol::MSG_OUTPUT);
        msg.extend_from_slice(ris);
        msg.extend_from_slice(&mode_seq);
        msg.extend_from_slice(&data[..first_end]);
        // BUG-2:首块发送前校验代次,被 reconnect 顶替则放弃回放(不发首块,尤其不发含 RIS 的复位帧)。
        if !client
            .send_async_for_generation(expected_conn_gen, msg)
            .await
        {
            return; // client 已掉线(通道关闭)——停止回放,不再徒劳发送
        }

        // Remaining chunks
        let mut offset = first_end;
        while offset < data.len() {
            let end = (offset + CHUNK_SIZE).min(data.len());
            let mut chunk = Vec::with_capacity(1 + (end - offset));
            chunk.push(protocol::MSG_OUTPUT);
            chunk.extend_from_slice(&data[offset..end]);
            // BUG-2:每块发送前校验代次,被 reconnect 顶替则立即 abort,把陈旧帧污染新通道的窗口
            // 收敛到最多一块(前一块 send_async 期间才可能发生 bump)。
            if !client
                .send_async_for_generation(expected_conn_gen, chunk)
                .await
            {
                return;
            }
            offset = end;
        }
    }

    /// 无条件促使前台 TUI 全量重绘(MSG_NUDGE / 接管后补发 / 观看 attach)。
    /// 同尺寸 SIGWINCH 对增量渲染 TUI(Ink 系如 claude-code)是 no-op——
    /// "尺寸没变"直接跳过重绘(真机取证:观看切换后背景色仍丢失)。
    /// 改用桌面端 forceFullRefresh 同款"尺寸抖动":缩 1 列→80ms→恢复,
    /// 两次真实 SIGWINCH 强制任何 TUI 完整重画。PTY 抖动不下行广播
    /// (广播只在 handle_resize),客户端只看到内容重刷。
    pub fn nudge_resize(&self) {
        let cols = *self.last_cols.lock().unwrap();
        let rows = *self.last_rows.lock().unwrap();
        let resize_tx = self.resize_tx.clone();
        tokio::spawn(async move {
            let guard = resize_tx.lock().await;
            if let Some(ref tx) = *guard {
                if cols > 2 {
                    // 间隔必须充分:POSIX 信号不排队,第二个 SIGWINCH 在第一个
                    // handler 运行前到达会被丢(80ms 偶发失败,桌面端同款坑用 100ms)
                    let _ = tx.send(TermCtrl::Resize(cols - 1, rows)).await;
                    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                    // 恢复段不用快照:抖动窗口内客户端可能又 resize(键盘弹收等),
                    // 快照会把 PTY 打回过期尺寸(接管态重绘后右/下间隙的根因)。
                    // RestoreLast 在 run loop 处理时读最新 last_cols/rows。
                    let _ = tx.send(TermCtrl::RestoreLast).await;
                    // 兜底:恢复信号若仍被合并/丢弃,补发手动 SIGWINCH
                    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                    let _ = tx.send(TermCtrl::Nudge).await;
                } else {
                    let _ = tx.send(TermCtrl::Nudge).await;
                }
            }
        });
    }

    /// Append output to the ring buffer.
    pub fn append_to_ring_buffer(&self, data: &[u8]) {
        self.ring_buf.lock().unwrap().write(data);
        // 与环形缓冲同源同序喂模式跟踪器(增量解析,容忍序列跨 chunk)
        self.mode_tracker.lock().unwrap().feed(data);
    }

    /// Set encoding for the session.
    pub fn set_encoding(&self, name: &str) {
        *self.encoding_name.lock().unwrap() = name.to_string();
    }

    /// Set private mode. Returns count of kicked non-local-owner clients.
    pub fn set_private(&self, private: bool) -> usize {
        // Keep the private guard while scanning clients. add/reconnect use
        // private -> clients -> master, making admission, disconnect, and
        // failover one transaction.
        let mut private_guard = self.private.lock().unwrap();
        *private_guard = private;
        if !private {
            return 0;
        }
        // Keep only clients proven to be the direct local owner.
        let clients = self.clients.lock().unwrap();
        let mut kicked = 0;
        for client in clients.values() {
            if client.is_connected() && !client.is_trusted_local_owner() {
                client.disconnect();
                kicked += 1;
            }
        }
        let mut master = self.master_id.lock().unwrap();
        Self::reconcile_master_locked(&clients, &mut master, true, true);
        drop(master);
        self.reconcile_state_locked(&clients);
        drop(private_guard);
        kicked
    }

    /// 是否为 agent 会话(executor_type=="agent")。reaper 据此豁免 agent 会话的
    /// 「手机断连 → Draining → client-TTL 回收」——agent 会话随其 AcpClient 子进程存活,
    /// 回收改由子进程死亡 / idle-guard / 显式 delete 三路兜住(见 agent::manager)。
    pub fn is_agent(&self) -> bool {
        *self.executor_type.lock().unwrap() == "agent"
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

    /// Atomically claim a disconnected terminal session whose TTL expired.
    ///
    /// Holding `clients` through the state transition serializes this with
    /// add/reconnect. Once this returns true, a late WebSocket holding an old
    /// `Arc<Session>` observes Closed and cannot resurrect the session.
    pub fn try_close_by_ttl(&self, now: Instant) -> bool {
        let clients = self.clients.lock().unwrap();
        if clients.values().any(|client| client.is_connected()) {
            return false;
        }
        let mut state = self.state.lock().unwrap();
        if *state != SessionState::Draining || self.config.session_ttl.is_zero() {
            return false;
        }
        let mut drain_start = self.drain_start.lock().unwrap();
        let expired = drain_start.is_some_and(|started| {
            now.checked_duration_since(started)
                .is_some_and(|elapsed| elapsed > self.config.session_ttl)
        });
        if !expired {
            return false;
        }
        *state = SessionState::Closed;
        *drain_start = None;
        drop(drain_start);
        drop(state);
        drop(clients);
        self.download_registry.cancel_all();
        self.cancel.cancel();
        true
    }

    /// Close one session exactly once and terminate every registered client.
    ///
    /// The close linearization point is `state = Closed` while `clients` is
    /// held. The end frame is queued before each downstream is disconnected,
    /// allowing the WebSocket writer to drain it while all later dispatch,
    /// add, and reconnect attempts fail closed.
    pub fn close_with_frame(&self, frame: Vec<u8>) -> bool {
        let clients = self.clients.lock().unwrap();
        let mut state = self.state.lock().unwrap();
        if *state == SessionState::Closed {
            return false;
        }
        *state = SessionState::Closed;
        *self.drain_start.lock().unwrap() = None;
        for client in clients.values() {
            if client.is_connected() {
                client.send(frame.clone());
                client.disconnect();
            }
        }
        drop(state);
        drop(clients);
        self.download_registry.cancel_all();
        self.cancel.cancel();
        true
    }

    pub fn is_closed(&self) -> bool {
        *self.state.lock().unwrap() == SessionState::Closed
    }

    /// Find disconnected clients whose grace period has expired.
    /// Trusted local-owner clients are exempt — they are local (same machine) and will
    /// reconnect after system wake, so expiring them only causes unnecessary
    /// master-role loss and "remote control" overlay flashes.
    pub fn expired_disconnected_clients(
        &self,
        _now: Instant,
        grace: std::time::Duration,
    ) -> Vec<(String, u64)> {
        let clients = self.clients.lock().unwrap();
        clients
            .values()
            .filter(|c| {
                !c.is_connected() && c.idle_duration() > grace && !c.is_trusted_local_owner()
            })
            .map(|c| (c.id.clone(), c.conn_gen()))
            .collect()
    }

    /// Permanently remove only the disconnected generation observed by reaper.
    ///
    /// The scan and commit are intentionally separate, so reconnect may happen
    /// between them. Rechecking generation/connection/age under `clients`
    /// prevents an H0 candidate from deleting its live H1 replacement.
    pub fn expire_client_for_generation(
        &self,
        client_id: &str,
        expected_conn_gen: u64,
        grace: std::time::Duration,
    ) -> bool {
        let mut clients = self.clients.lock().unwrap();
        let Some(client) = clients.get(client_id) else {
            return false;
        };
        if client.conn_gen() != expected_conn_gen
            || client.is_connected()
            || client.idle_duration() <= grace
            || client.is_trusted_local_owner()
        {
            return false;
        }

        clients.remove(client_id);
        let mut master = self.master_id.lock().unwrap();
        Self::reconcile_master_locked(&clients, &mut master, true, true);
        drop(master);
        self.reconcile_state_locked(&clients);
        true
    }

    /// Cancel the session's run loop.
    pub fn cancel(&self) {
        self.download_registry.cancel_all();
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

    /// 是否已有可信本机 owner 客户端连接——桌面各窗口的"远端会话自动开标签"
    /// poller 用它避免重复 attach(某窗口已持有则其他窗口跳过)。
    pub fn has_connected_loopback_client(&self) -> bool {
        let clients = self.clients.lock().unwrap();
        clients
            .values()
            .any(|c| c.is_connected() && c.is_trusted_local_owner())
    }

    /// List connected client info for API responses.
    pub fn list_clients(&self) -> Vec<client::ClientInfo> {
        let clients = self.clients.lock().unwrap();
        clients
            .values()
            .map(|c| {
                let security = c.security_context();
                client::ClientInfo {
                    id: c.id.clone(),
                    session_id: self.id.clone(),
                    session_title: String::new(),
                    role: c.role.as_str().to_string(),
                    connected: c.is_connected(),
                    last_seen: format!("{:?}", c.idle_duration()),
                    remote_addr: c.remote_addr.clone(),
                    ingress: security.ingress_name().to_string(),
                    device_id: security.device_id().map(str::to_string),
                }
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

    /// Verify that a client ID belongs to the authenticated request principal.
    /// The local owner may administer any client; a device may name only its
    /// own WS clients.
    pub(crate) fn client_matches_principal(
        &self,
        client_id: &str,
        principal: &AuthPrincipal,
    ) -> bool {
        let clients = self.clients.lock().unwrap();
        let Some(client) = clients.get(client_id) else {
            return false;
        };
        client.matches_request_principal(principal)
    }

    /// Disconnect device-authenticated clients, optionally scoped to one
    /// stable device ID. Relay clients are fail-closed even if malformed state
    /// somehow lacks a Device principal.
    pub(crate) fn disconnect_device_principals(&self, device_id: Option<&str>) -> usize {
        let clients = self.clients.lock().unwrap();
        let mut count = 0;
        for client in clients.values() {
            if !client.is_connected() || !client.is_device_or_relay() {
                continue;
            }
            if let Some(expected) = device_id {
                if client.authenticated_device_id().as_deref() != Some(expected) {
                    continue;
                }
            }
            client.send(protocol::encode_error(
                protocol::ERR_KICKED,
                "credential revoked",
            ));
            client.disconnect();
            count += 1;
        }
        let mut master = self.master_id.lock().unwrap();
        Self::reconcile_master_locked(&clients, &mut master, true, true);
        drop(master);
        self.reconcile_state_locked(&clients);
        count
    }

    /// Disconnect only sockets authenticated with one exact runtime
    /// credential generation. A newly re-paired generation with the same
    /// stable device ID is not affected by stale self-unpair cleanup.
    pub(crate) fn disconnect_device_generation(
        &self,
        device_id: &str,
        generation: uuid::Uuid,
    ) -> usize {
        let clients = self.clients.lock().unwrap();
        let mut count = 0;
        for client in clients.values() {
            if !client.is_connected() || !client.matches_device_generation(device_id, generation) {
                continue;
            }
            client.send(protocol::encode_error(
                protocol::ERR_KICKED,
                "credential revoked",
            ));
            client.disconnect();
            count += 1;
        }
        let mut master = self.master_id.lock().unwrap();
        Self::reconcile_master_locked(&clients, &mut master, true, true);
        drop(master);
        self.reconcile_state_locked(&clients);
        count
    }

    /// Disconnect only WebSockets authenticated by one retired owner-token
    /// generation. Device clients and local IPC owners use different identity
    /// generations and are intentionally left untouched.
    pub(crate) fn disconnect_owner_generation(&self, generation: uuid::Uuid) -> usize {
        let clients = self.clients.lock().unwrap();
        let mut count = 0;
        for client in clients.values() {
            if !client.is_connected() || !client.matches_owner_generation(generation) {
                continue;
            }
            client.send(protocol::encode_error(
                protocol::ERR_KICKED,
                "credential revoked",
            ));
            client.disconnect();
            count += 1;
        }
        let mut master = self.master_id.lock().unwrap();
        Self::reconcile_master_locked(&clients, &mut master, true, true);
        drop(master);
        self.reconcile_state_locked(&clients);
        count
    }

    /// Kick a client by ID. Returns (remote_addr, found).
    pub fn kick_client(&self, client_id: &str) -> (String, bool) {
        let clients = self.clients.lock().unwrap();
        if let Some(client) = clients.get(client_id) {
            let addr = client.remote_addr.clone();
            client.send(protocol::encode_error(protocol::ERR_KICKED, "kicked"));
            client.disconnect();
            let mut master = self.master_id.lock().unwrap();
            Self::reconcile_master_locked(&clients, &mut master, true, true);
            drop(master);
            self.reconcile_state_locked(&clients);
            (addr, true)
        } else {
            (String::new(), false)
        }
    }

    /// Disconnect all device-authenticated or relay clients.
    /// Sends ERR_KICKED and promotes next master if needed.
    pub fn disconnect_remote_clients(&self) -> usize {
        let clients = self.clients.lock().unwrap();
        let mut count = 0;
        for client in clients.values() {
            if client.is_connected() && client.is_device_or_relay() {
                client.send(protocol::encode_error(protocol::ERR_KICKED, "kicked"));
                client.disconnect();
                count += 1;
            }
        }
        let mut master = self.master_id.lock().unwrap();
        Self::reconcile_master_locked(&clients, &mut master, true, true);
        drop(master);
        self.reconcile_state_locked(&clients);
        count
    }

    /// Kick all clients from a specific IP. Returns count of kicked.
    pub fn kick_by_ip(&self, ip: &str) -> usize {
        let clients = self.clients.lock().unwrap();
        let mut count = 0;
        for client in clients.values() {
            if client.is_connected() && client.is_device_or_relay() && client.remote_addr == ip {
                client.send(protocol::encode_error(protocol::ERR_KICKED, "kicked"));
                client.disconnect();
                count += 1;
            }
        }
        let mut master = self.master_id.lock().unwrap();
        Self::reconcile_master_locked(&clients, &mut master, true, true);
        drop(master);
        self.reconcile_state_locked(&clients);
        count
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

/// 长命令完成的耗时阈值(毫秒)——命令耗时达到/超过此值才合成一条 `CmdDone`
/// 通知事件。当前写死 30 秒,后续可做成用户可配置项(见通知设计文档 Phase 2)。
const CMD_DONE_THRESHOLD_MS: u64 = 30_000;

/// 从一批 `OscEvent` 中挑出「值得通知」的事件,转换为待发布到桌面事件总线的 `DesktopEvent`。
///
/// 纯函数,便于单测(不依赖 run loop / EventBus 实例)。`id` 用
/// `uuid::Uuid::new_v4()`——与项目里生成会话 id / client id / pairing nonce id
/// 的既有随机源一致,不引入新依赖。
///
/// 覆盖两类事件:
/// - `OscEvent::Notify`(程序显式通知,OSC 9/777)→ 原样转发。
/// - `OscEvent::ShellState`(OSC 7768,precmd 携带的命令耗时)→ 耗时达到
///   `CMD_DONE_THRESHOLD_MS` 且命令非空(排除空回车)才合成 `CmdDone`;
///   `duration_ms` 缺失(旧格式/未启用 preexec 计时)或耗时不足阈值均不产出。
fn notify_events_to_publish(
    events: &[crate::server::osc_filter::OscEvent],
    session_id: &str,
    session_title: &str,
) -> Vec<DesktopEvent> {
    events
        .iter()
        .filter_map(|e| match e {
            crate::server::osc_filter::OscEvent::Notify { title, body } => {
                Some(DesktopEvent::Notify {
                    id: uuid::Uuid::new_v4().to_string(),
                    session_id: session_id.to_string(),
                    session_title: session_title.to_string(),
                    title: title.clone(),
                    body: body.clone(),
                })
            }
            crate::server::osc_filter::OscEvent::ShellState {
                exit,
                cmd,
                duration_ms: Some(ms),
                ..
            } if *ms >= CMD_DONE_THRESHOLD_MS && !cmd.trim().is_empty() => {
                Some(DesktopEvent::CmdDone {
                    id: uuid::Uuid::new_v4().to_string(),
                    session_id: session_id.to_string(),
                    session_title: session_title.to_string(),
                    cmd: cmd.clone(),
                    exit: *exit,
                    duration_ms: *ms,
                })
            }
            _ => None,
        })
        .collect()
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

    /// `notify_events_to_publish` 只挑出 Notify,忽略其它 OscEvent 变体,
    /// 且 session_id/title/body 原样带过去。
    #[test]
    fn notify_events_to_publish_filters_notify_only() {
        use crate::server::osc_filter::OscEvent;

        let events = vec![
            OscEvent::Cwd {
                cwd: "/tmp".to_string(),
            },
            OscEvent::Notify {
                title: "标题".to_string(),
                body: "正文".to_string(),
            },
            OscEvent::Progress {
                state: 1,
                percent: 50,
            },
        ];

        let published = notify_events_to_publish(&events, "sess-1", "会话A");
        assert_eq!(published.len(), 1, "只应挑出 Notify 这一条");
        match &published[0] {
            DesktopEvent::Notify {
                session_id,
                session_title,
                title,
                body,
                id,
            } => {
                assert_eq!(session_id, "sess-1");
                assert_eq!(session_title, "会话A");
                assert_eq!(title, "标题");
                assert_eq!(body, "正文");
                assert!(!id.is_empty(), "id 应非空");
            }
            other => panic!("expected Notify, got {:?}", other),
        }
    }

    /// 多个 Notify 应各自生成一条 DesktopEvent,且 id 互不相同。
    #[test]
    fn notify_events_to_publish_multiple_notify_get_distinct_ids() {
        use crate::server::osc_filter::OscEvent;

        let events = vec![
            OscEvent::Notify {
                title: "A".to_string(),
                body: "a".to_string(),
            },
            OscEvent::Notify {
                title: "B".to_string(),
                body: "b".to_string(),
            },
        ];

        let published = notify_events_to_publish(&events, "sess-2", "会话B");
        assert_eq!(published.len(), 2);
        let ids: Vec<&str> = published
            .iter()
            .map(|e| match e {
                DesktopEvent::Notify { id, .. } => id.as_str(),
                _ => unreachable!(),
            })
            .collect();
        assert_ne!(ids[0], ids[1], "两条 Notify 的 id 应不同");
    }

    /// 空/无 Notify 的事件批应返回空 Vec。
    #[test]
    fn notify_events_to_publish_empty_when_no_notify() {
        use crate::server::osc_filter::OscEvent;

        let events = vec![OscEvent::Cwd {
            cwd: "/".to_string(),
        }];
        assert!(notify_events_to_publish(&events, "sess-3", "会话C").is_empty());
        assert!(notify_events_to_publish(&[], "sess-3", "会话C").is_empty());
    }

    /// ShellState 耗时达到/超过阈值(30s)且命令非空 → 应产出一条 CmdDone,字段正确。
    #[test]
    fn notify_events_to_publish_shell_state_over_threshold_emits_cmd_done() {
        use crate::server::osc_filter::OscEvent;

        let events = vec![OscEvent::ShellState {
            exit: 0,
            cwd: "/tmp".to_string(),
            cmd: "make build".to_string(),
            duration_ms: Some(CMD_DONE_THRESHOLD_MS),
        }];

        let published = notify_events_to_publish(&events, "sess-4", "会话D");
        assert_eq!(published.len(), 1, "耗时达到阈值应产出一条 CmdDone");
        match &published[0] {
            DesktopEvent::CmdDone {
                id,
                session_id,
                session_title,
                cmd,
                exit,
                duration_ms,
            } => {
                assert!(!id.is_empty(), "id 应非空");
                assert_eq!(session_id, "sess-4");
                assert_eq!(session_title, "会话D");
                assert_eq!(cmd, "make build");
                assert_eq!(*exit, 0);
                assert_eq!(*duration_ms, CMD_DONE_THRESHOLD_MS);
            }
            other => panic!("expected CmdDone, got {:?}", other),
        }
    }

    /// ShellState 耗时低于阈值 → 不产出 CmdDone。
    #[test]
    fn notify_events_to_publish_shell_state_under_threshold_emits_nothing() {
        use crate::server::osc_filter::OscEvent;

        let events = vec![OscEvent::ShellState {
            exit: 0,
            cwd: "/tmp".to_string(),
            cmd: "ls".to_string(),
            duration_ms: Some(CMD_DONE_THRESHOLD_MS - 1),
        }];

        assert!(
            notify_events_to_publish(&events, "sess-5", "会话E").is_empty(),
            "耗时不足阈值不应产出通知"
        );
    }

    /// ShellState 无 duration_ms(旧格式/未计时)→ 不产出 CmdDone。
    #[test]
    fn notify_events_to_publish_shell_state_without_duration_emits_nothing() {
        use crate::server::osc_filter::OscEvent;

        let events = vec![OscEvent::ShellState {
            exit: 0,
            cwd: "/tmp".to_string(),
            cmd: "make build".to_string(),
            duration_ms: None,
        }];

        assert!(
            notify_events_to_publish(&events, "sess-6", "会话F").is_empty(),
            "duration_ms 缺失不应产出通知"
        );
    }

    /// ShellState 命令为空(空回车)即使耗时够也不应产出 CmdDone。
    #[test]
    fn notify_events_to_publish_shell_state_empty_cmd_emits_nothing() {
        use crate::server::osc_filter::OscEvent;

        let events = vec![OscEvent::ShellState {
            exit: 0,
            cwd: "/tmp".to_string(),
            cmd: "".to_string(),
            duration_ms: Some(CMD_DONE_THRESHOLD_MS * 2),
        }];

        assert!(
            notify_events_to_publish(&events, "sess-7", "会话G").is_empty(),
            "空命令(空回车)不应产出通知"
        );

        // 纯空白命令同样应被视为空。
        let events_whitespace = vec![OscEvent::ShellState {
            exit: 0,
            cwd: "/tmp".to_string(),
            cmd: "   ".to_string(),
            duration_ms: Some(CMD_DONE_THRESHOLD_MS * 2),
        }];
        assert!(notify_events_to_publish(&events_whitespace, "sess-7", "会话G").is_empty());
    }

    // ── conn_gen 守卫 / 跨代次清理(镜像回放终审 merge-blocker 回归)──
    //
    // 两处根因同属一个 conn_gen 奇偶性问题:方案 B 已给 agent 历史回放(attach_client)
    // 补了精确一次守卫(BUG-1/BUG-2),但 M5 背压回放把同款破口放大到镜像**终端页**回放:
    // ①flush_ring_buffer_async 缺 conn_gen 守卫(与 attach_client 的 BUG-2 对偶);
    // ②ws.rs 在长回放**之后**才捕获 conn_gen,cleanup 用到被 bump 的代次误拆重连连接。
    use super::client::WsReceivers;
    use std::time::Duration;

    /// 建一个真实 WS Client 并加入 session(模拟 handle_ws 步骤2:已入 session.clients、connected)。
    fn ws_client(session: &Session, id: &str) -> (Arc<Client>, WsReceivers) {
        let (client, rx) = Client::new(
            id.into(),
            "127.0.0.1".into(),
            ClientRole::Viewer,
            ClientSecurityContext::direct_loopback_owner(),
        );
        let client = Arc::new(client);
        session.add_client(client.clone()).unwrap();
        (client, rx)
    }

    fn ring_session(id: &str, ring_buffer_size: usize) -> Arc<Session> {
        Arc::new(Session::new(
            id.into(),
            SessionConfig {
                session_ttl: Duration::from_secs(300),
                reconnect_grace: Duration::from_secs(60),
                ring_buffer_size,
                log_dir: String::new(),
            },
            EventBus::new(),
        ))
    }

    #[test]
    fn relay_synthetic_loopback_cannot_enter_private_session() {
        let session = ring_session("private-relay", 4096);
        session.set_private(true);
        let (relay, _rx) = Client::new(
            "relay-client".into(),
            "127.0.0.1".into(),
            ClientRole::Viewer,
            ClientSecurityContext::test_device(
                crate::server::auth::TrustedIngress::Relay,
                "phone-a",
            ),
        );
        assert_eq!(
            session.add_client(Arc::new(relay)),
            Err("session is private".to_string())
        );
    }

    #[test]
    fn targeted_revoke_disconnects_only_matching_device_and_keeps_local_owner() {
        let session = ring_session("revoke-device", 4096);
        let (owner, _) = ws_client(&session, "owner");
        for (client_id, device_id) in [("phone-a", "device-a"), ("phone-b", "device-b")] {
            let (client, _) = Client::new(
                client_id.into(),
                "127.0.0.1".into(),
                ClientRole::Viewer,
                ClientSecurityContext::test_device(
                    crate::server::auth::TrustedIngress::Relay,
                    device_id,
                ),
            );
            session.add_client(Arc::new(client)).unwrap();
        }

        assert_eq!(session.disconnect_device_principals(Some("device-a")), 1);
        let clients = session.clients.lock().unwrap();
        assert!(owner.is_connected());
        assert!(!clients.get("phone-a").unwrap().is_connected());
        assert!(clients.get("phone-b").unwrap().is_connected());
    }

    #[test]
    fn reconnect_identity_mismatch_cannot_disconnect_existing_client() {
        let session = ring_session("reconnect-identity", 4096);
        let security_a = ClientSecurityContext::test_device(
            crate::server::auth::TrustedIngress::Relay,
            "device-a",
        );
        let (client, _) = Client::new(
            "phone".into(),
            "127.0.0.1".into(),
            ClientRole::Viewer,
            security_a,
        );
        let client = Arc::new(client);
        session.add_client(client.clone()).unwrap();
        let security_b = ClientSecurityContext::test_device(
            crate::server::auth::TrustedIngress::Relay,
            "device-b",
        );
        assert!(session
            .reconnect_client(
                "phone",
                "127.0.0.1".into(),
                security_b,
                Duration::from_secs(60)
            )
            .is_err());
        assert!(client.is_connected());
        assert_eq!(client.conn_gen(), 0);
    }

    /// 【缺陷 A 回归 · flush_ring_buffer_async 缺 conn_gen 守卫】
    /// 场景:镜像终端页大环形缓冲背压回放中,同 client_id 重连(reconnect bump conn_gen + 换新通道)。
    /// 被顶替的旧 flush 必须在下一个 conn_gen 校验点 abort:停止发送——否则次块 `send_async` 重读已换成
    /// 新通道的 downstream,把陈旧终端回放帧(RIS 复位 + MSG_OUTPUT)灌进重连后的新连接 → 终端页乱码。
    /// 对照 `attach_client` 的 BUG-2 守卫(agent/manager.rs:326/358)——本测试是其终端回放路径镜像版。
    #[tokio::test]
    async fn flush_ring_buffer_async_aborts_when_conn_gen_bumps_midway() {
        // ring 需装下 > 4096 字节 → flush 产 ≥2 个 MSG_OUTPUT 分片,给「首块发出后、次块发出前」留校验点。
        let session = ring_session("flush-gen-guard", 16384);
        // 8192 字节纯 'X'(无转义序列 → 模式重放序列为空)→ flush 产 2 个 4096 分片。
        session.append_to_ring_buffer(&vec![b'X'; 8192]);

        let (client, rx) = ws_client(&session, "phone");
        let WsReceivers { priority_rx, .. } = rx; // 旧通道 rx(H0)
        let gen0 = client.conn_gen();

        // 预填旧 priority 通道到满(1024 槽 = PRIORITY_SEND_CHANNEL_SIZE),使 flush 首块 send_async 背压挂起。
        const CH_CAP: usize = 1024;
        for _ in 0..CH_CAP {
            assert!(
                client.send_async(vec![0xEE]).await,
                "预填应成功(容量内不阻塞)"
            );
        }

        // spawn flush:捕获 gen0 → 快照 → 首块 send_async 撞满通道 → 挂起(生产上等 writer 排空)。
        let session2 = session.clone();
        let client2 = client.clone();
        let flush_task = tokio::spawn(async move {
            session2.flush_ring_buffer_async(&client2, gen0).await;
        });

        // 让 flush 跑到首块背压挂起(仿 attach_aborts_when_conn_gen_bumps_midway)。
        for _ in 0..64 {
            tokio::task::yield_now().await;
        }

        // 回放中途同 client_id reconnect:换新通道 + connected=true + conn_gen bump。旧 flush 被顶替。
        let new_rx = client
            .reconnect(
                "127.0.0.1:9999".into(),
                ClientSecurityContext::direct_loopback_owner(),
            )
            .unwrap();
        let WsReceivers {
            priority_rx: mut new_prx,
            ..
        } = new_rx; // 新通道 rx(H1)
        assert_ne!(client.conn_gen(), gen0, "reconnect 应 bump conn_gen");

        // 排空旧通道:放行预填帧 + flush 挂起的首块 send 完成 → flush 进入次块前的 conn_gen 校验 → abort。
        let drainer = tokio::spawn(async move {
            let mut prx = priority_rx;
            while let Ok(Some(_)) =
                tokio::time::timeout(Duration::from_millis(200), prx.recv()).await
            {}
        });

        // flush 应很快 abort 返回,不 hang。
        tokio::time::timeout(Duration::from_secs(5), flush_task)
            .await
            .expect("flush 应在 conn_gen 变化后 abort,不应 hang")
            .unwrap();

        // 关键断言:被顶替的旧 flush 绝不把陈旧终端回放帧灌进重连后的新通道。
        // 无守卫时次块 send_async 重读新通道 downstream → 新通道收到 MSG_OUTPUT(leaked==1),断言失败。
        let mut leaked = 0;
        while new_prx.try_recv().is_ok() {
            leaked += 1;
        }
        assert_eq!(
            leaked, 0,
            "conn_gen 守卫应拦下次块——陈旧终端回放帧绝不灌进 reconnect 后的新通道"
        );

        drainer.abort();
    }

    /// 【缺陷 B 回归 · remove_client 跨代次不误拆】
    /// handle_ws cleanup 传入的 conn_gen 必须是 H0 建立时捕获的 G0(修后 ws.rs 前移捕获点),不能是
    /// 长回放后读到的、已被 H1 reconnect bump 的 G1。此测试锁定:client reconnect bump 后,用**旧代次 G0**
    /// 调 remove_client → 与当前 gen 不等 → 整体跳过:client 不被 disconnect、master 不易主。
    #[test]
    fn remove_client_with_stale_gen_after_reconnect_is_noop() {
        let session = ring_session("remove-stale-gen", 4096);
        let (client_a, _rx_a) = ws_client(&session, "a"); // 首个非只读连接 → master
        let (client_b, _rx_b) = ws_client(&session, "b");
        assert_eq!(session.master(), "a", "首个连接应为 master");

        let g0 = client_a.conn_gen(); // H0 建立时代次(修后 ws.rs 捕获此值)
        let _new_rx = client_a
            .reconnect(
                "127.0.0.1:9999".into(),
                ClientSecurityContext::direct_loopback_owner(),
            )
            .unwrap(); // H1 重连 → bump G0→G1、仍 connected
        assert_ne!(client_a.conn_gen(), g0, "reconnect 应 bump conn_gen");

        // 用旧代次 G0 调 remove_client(= 修后 H0 cleanup 的行为):gen 不等 → 整体跳过。
        session.remove_client("a", g0);

        assert!(
            client_a.is_connected(),
            "跨代次 remove_client 不得 disconnect 刚重连的连接"
        );
        assert_eq!(
            session.master(),
            "a",
            "跨代次 remove_client 不得触发 master 易主"
        );
        assert!(client_b.is_connected());
    }

    /// 【缺陷 B 因果反证 · 传 bump 后的代次会误拆】
    /// 修前 ws.rs 在长回放**之后**才捕获 conn_gen——此时已被 H1 reconnect bump 成 G1。以 G1 调 remove_client
    /// → 与当前 gen 相等 → 不跳过 → disconnect 刚重连的连接 + 触发 master 误让。此测试固化该因果:证明
    /// remove_client 的正确性依赖调用方传对代次,故 ws.rs 捕获点必须前移到建立时(捕获 G0)。
    #[test]
    fn remove_client_with_bumped_gen_wrongly_disconnects_reconnected() {
        let session = ring_session("remove-bumped-gen", 4096);
        let (client_a, _rx_a) = ws_client(&session, "a");
        let (_client_b, _rx_b) = ws_client(&session, "b");

        let _new_rx = client_a
            .reconnect(
                "127.0.0.1:9999".into(),
                ClientSecurityContext::direct_loopback_owner(),
            )
            .unwrap(); // bump G0→G1
        let g1 = client_a.conn_gen(); // 修前 ws.rs 在回放后读到的就是这个(已 bump)

        session.remove_client("a", g1); // 传 bump 后的 gen(= 修前 ws.rs 行为)

        assert!(
            !client_a.is_connected(),
            "传 bump 后的代次(修前 ws.rs 行为)会误拆刚重连的连接——正是缺陷 B"
        );
        assert_eq!(
            session.master(),
            "b",
            "误拆后 master 被误让给 b(缺陷 B 的次生 master 易主)"
        );
    }
}
