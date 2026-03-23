//! Session client — supports both WebSocket (mpsc) and local IPC (Tauri Channel) downstream.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use tokio::sync::mpsc;

use super::state::ClientRole;
use crate::server::protocol;

/// Channel capacity for the send buffer (matches Go's 256).
const SEND_CHANNEL_SIZE: usize = 256;

/// Downstream transport for sending data to a client.
enum DownStream {
    /// WebSocket client: push to mpsc channel, WS handler reads from receiver.
    Mpsc(mpsc::Sender<Vec<u8>>),
    /// Local IPC client: push directly to Tauri Channel (no intermediate buffer).
    IpcChannel(tauri::ipc::Channel<Vec<u8>>),
}

/// A connected (or recently-disconnected) client.
pub struct Client {
    pub id: String,
    pub role: ClientRole,
    pub connected: AtomicBool,
    pub remote_addr: String,
    pub last_seen: Mutex<Instant>,
    downstream: Mutex<Option<DownStream>>,
    /// Connection generation — incremented on each reconnect.
    conn_gen: AtomicU64,
}

/// Info returned by listing clients (serializable).
#[derive(Debug, Clone, serde::Serialize)]
pub struct ClientInfo {
    pub id: String,
    pub session_id: String,
    pub session_title: String,
    pub role: String,
    pub connected: bool,
    pub last_seen: String,
    pub remote_addr: String,
}

impl Client {
    /// Create a new WebSocket client with a fresh mpsc send channel.
    pub fn new(id: String, remote_addr: String, role: ClientRole) -> (Self, mpsc::Receiver<Vec<u8>>) {
        let (tx, rx) = mpsc::channel(SEND_CHANNEL_SIZE);
        let client = Self {
            id,
            role,
            connected: AtomicBool::new(true),
            remote_addr,
            last_seen: Mutex::new(Instant::now()),
            downstream: Mutex::new(Some(DownStream::Mpsc(tx))),
            conn_gen: AtomicU64::new(0),
        };
        (client, rx)
    }

    /// Create a new local IPC client backed by a Tauri Channel.
    pub fn new_ipc(
        id: String,
        remote_addr: String,
        role: ClientRole,
        channel: tauri::ipc::Channel<Vec<u8>>,
    ) -> Self {
        Self {
            id,
            role,
            connected: AtomicBool::new(true),
            remote_addr,
            last_seen: Mutex::new(Instant::now()),
            downstream: Mutex::new(Some(DownStream::IpcChannel(channel))),
            conn_gen: AtomicU64::new(0),
        }
    }

    /// Current connection generation.
    pub fn conn_gen(&self) -> u64 {
        self.conn_gen.load(Ordering::SeqCst)
    }

    /// Whether the client is currently connected.
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    /// Touch last_seen timestamp.
    pub fn touch(&self) {
        if let Ok(mut guard) = self.last_seen.lock() {
            *guard = Instant::now();
        }
    }

    /// Get elapsed time since last activity.
    pub fn idle_duration(&self) -> std::time::Duration {
        self.last_seen
            .lock()
            .map(|guard| guard.elapsed())
            .unwrap_or_default()
    }

    /// Non-blocking send. If the mpsc channel is full, the client is considered
    /// a slow consumer and will be disconnected. IPC Channel has no backpressure.
    pub fn send(&self, data: Vec<u8>) -> bool {
        if !self.is_connected() {
            return false;
        }
        let guard = self.downstream.lock().unwrap();
        match guard.as_ref() {
            Some(DownStream::Mpsc(tx)) => match tx.try_send(data) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    drop(guard);
                    self.disconnect();
                    false
                }
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            },
            Some(DownStream::IpcChannel(ch)) => {
                if ch.send(data).is_err() {
                    drop(guard);
                    self.disconnect();
                    return false;
                }
                true
            }
            None => false,
        }
    }

    /// Blocking send for bulk transfers (file download).
    /// Waits for mpsc channel capacity instead of disconnecting on full.
    /// IPC Channel send is always non-blocking (no capacity limit).
    pub async fn send_async(&self, data: Vec<u8>) -> bool {
        if !self.is_connected() {
            return false;
        }
        let downstream = {
            let guard = self.downstream.lock().unwrap();
            match guard.as_ref() {
                Some(DownStream::Mpsc(tx)) => Some(DownStream::Mpsc(tx.clone())),
                _ => None,
            }
        };
        match downstream {
            Some(DownStream::Mpsc(tx)) => tx.send(data).await.is_ok(),
            _ => self.send(data), // IPC: use non-blocking send
        }
    }

    /// Mark the client as disconnected.
    pub fn disconnect(&self) {
        self.connected.store(false, Ordering::SeqCst);
        let mut guard = self.downstream.lock().unwrap();
        *guard = None;
    }

    /// Reconnect with a new mpsc send channel. Returns the new receiver for the WS write pump.
    pub fn reconnect(&self, _remote_addr: String) -> mpsc::Receiver<Vec<u8>> {
        let (tx, rx) = mpsc::channel(SEND_CHANNEL_SIZE);
        {
            let mut guard = self.downstream.lock().unwrap();
            *guard = Some(DownStream::Mpsc(tx));
        }
        self.connected.store(true, Ordering::SeqCst);
        self.conn_gen.fetch_add(1, Ordering::SeqCst);
        self.touch();
        rx
    }

    /// Build a role-change protocol message for this client.
    pub fn role_message(&self) -> Vec<u8> {
        protocol::encode_role_change(self.role as u8)
    }
}
