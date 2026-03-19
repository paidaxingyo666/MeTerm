//! WebSocket client — mirrors Go `session/client.go`.
//!
//! Each client has a background "write pump" task that drains `send_tx`
//! and writes to the WebSocket.  The `connGen` counter prevents stale
//! write-pump tasks from operating on a reconnected socket.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use tokio::sync::mpsc;

use super::state::ClientRole;
use crate::server::protocol;

/// Channel capacity for the send buffer (matches Go's 256).
const SEND_CHANNEL_SIZE: usize = 256;

/// A connected (or recently-disconnected) WebSocket client.
pub struct Client {
    pub id: String,
    pub role: ClientRole,
    pub connected: AtomicBool,
    pub remote_addr: String,
    pub last_seen: Mutex<Instant>,
    /// Sender half — write pump reads from the corresponding receiver.
    send_tx: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
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
    /// Create a new client with a fresh send channel.
    pub fn new(id: String, remote_addr: String, role: ClientRole) -> (Self, mpsc::Receiver<Vec<u8>>) {
        let (tx, rx) = mpsc::channel(SEND_CHANNEL_SIZE);
        let client = Self {
            id,
            role,
            connected: AtomicBool::new(true),
            remote_addr,
            last_seen: Mutex::new(Instant::now()),
            send_tx: Mutex::new(Some(tx)),
            conn_gen: AtomicU64::new(0),
        };
        (client, rx)
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

    /// Non-blocking send. If the channel is full, the client is considered
    /// a slow consumer and will be disconnected.
    pub fn send(&self, data: Vec<u8>) -> bool {
        if !self.is_connected() {
            return false;
        }
        let guard = self.send_tx.lock().unwrap();
        if let Some(tx) = guard.as_ref() {
            match tx.try_send(data) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    // Slow consumer — close the channel so write pump exits.
                    drop(guard);
                    self.disconnect();
                    false
                }
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            }
        } else {
            false
        }
    }

    /// Mark the client as disconnected but keep identity for potential reconnect.
    pub fn disconnect(&self) {
        self.connected.store(false, Ordering::SeqCst);
        // Drop the sender so the write pump exits.
        let mut guard = self.send_tx.lock().unwrap();
        *guard = None;
    }

    /// Reconnect with a new send channel. Returns the new receiver for the write pump.
    pub fn reconnect(&self, _remote_addr: String) -> mpsc::Receiver<Vec<u8>> {
        let (tx, rx) = mpsc::channel(SEND_CHANNEL_SIZE);
        {
            let mut guard = self.send_tx.lock().unwrap();
            *guard = Some(tx);
        }
        self.connected.store(true, Ordering::SeqCst);
        self.conn_gen.fetch_add(1, Ordering::SeqCst);
        self.touch();
        // Note: remote_addr is not re-assignable through &self since it's not interior-mutable.
        // In Go, RemoteAddr is updated on reconnect. We'd need Mutex<String> for that.
        // For now, the original remote_addr is preserved.
        rx
    }

    /// Build a role-change protocol message for this client.
    pub fn role_message(&self) -> Vec<u8> {
        protocol::encode_role_change(self.role as u8)
    }
}
