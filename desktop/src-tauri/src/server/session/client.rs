//! Session client — supports both WebSocket (mpsc) and local IPC (Tauri Channel) downstream.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use tokio::sync::mpsc;

use super::state::ClientRole;
use crate::server::auth::{AuthPrincipal, TrustedIngress};
use crate::server::protocol;

/// Capacity for terminal/control messages. This path must stay low-latency.
const PRIORITY_SEND_CHANNEL_SIZE: usize = 1024;
/// Capacity for bulk transfer messages such as file download chunks.
const BULK_SEND_CHANNEL_SIZE: usize = 64;

/// WebSocket downstream channels.
pub struct WsDownstream {
    priority_tx: mpsc::Sender<Vec<u8>>,
    bulk_tx: mpsc::Sender<Vec<u8>>,
}

/// WebSocket receivers returned to the WS write pump.
pub struct WsReceivers {
    pub priority_rx: mpsc::Receiver<Vec<u8>>,
    pub bulk_rx: mpsc::Receiver<Vec<u8>>,
}

/// Downstream transport for sending data to a client.
enum DownStream {
    /// WebSocket client: push to mpsc channel, WS handler reads from receiver.
    Mpsc(WsDownstream),
    /// Local IPC client: push directly to Tauri Channel (no intermediate buffer).
    IpcChannel(tauri::ipc::Channel<Vec<u8>>),
}

/// Security identity captured from trusted request extensions at WS upgrade.
/// `remote_addr` remains display metadata and is never consulted for privilege.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ClientSecurityContext {
    pub ingress: TrustedIngress,
    pub principal: AuthPrincipal,
}

impl ClientSecurityContext {
    pub(crate) fn direct_loopback_owner() -> Self {
        Self {
            ingress: TrustedIngress::DirectLoopback,
            // Local IPC does not authenticate with the HTTP owner token. A nil
            // generation keeps it distinct from every runtime owner-token
            // generation, so token rotation only tears down owner WebSockets.
            principal: AuthPrincipal::Owner {
                generation: uuid::Uuid::nil(),
            },
        }
    }

    #[cfg(test)]
    pub(crate) fn test_device(ingress: TrustedIngress, device_id: &str) -> Self {
        Self {
            ingress,
            principal: AuthPrincipal::Device {
                device_id: device_id.to_string(),
                device_name: "test phone".to_string(),
                generation: uuid::Uuid::new_v4(),
            },
        }
    }

    pub(crate) fn is_trusted_local_owner(&self) -> bool {
        self.ingress == TrustedIngress::DirectLoopback
            && matches!(self.principal, AuthPrincipal::Owner { .. })
    }

    /// Runtime bearer principals must still match their credential generation
    /// when a buffered frame is dispatched. The nil-generation local IPC owner
    /// is process-internal and intentionally independent of the HTTP token.
    pub(crate) fn is_current(&self, authenticator: &crate::server::auth::Authenticator) -> bool {
        matches!(
            &self.principal,
            AuthPrincipal::Owner { generation }
                if generation.is_nil() && self.ingress == TrustedIngress::DirectLoopback
        ) || authenticator.is_principal_current(&self.principal)
    }

    pub(crate) fn device_id(&self) -> Option<&str> {
        match &self.principal {
            AuthPrincipal::Device { device_id, .. } => Some(device_id),
            AuthPrincipal::Owner { .. } => None,
        }
    }

    pub(crate) fn is_device_or_relay(&self) -> bool {
        matches!(self.principal, AuthPrincipal::Device { .. })
            || matches!(
                self.ingress,
                TrustedIngress::Relay | TrustedIngress::RelayRenewal
            )
    }

    fn same_authenticated_identity(&self, other: &Self) -> bool {
        match (&self.principal, &other.principal) {
            (
                AuthPrincipal::Owner {
                    generation: left_generation,
                },
                AuthPrincipal::Owner {
                    generation: right_generation,
                },
            ) => left_generation == right_generation,
            (
                AuthPrincipal::Device {
                    device_id: left,
                    generation: left_generation,
                    ..
                },
                AuthPrincipal::Device {
                    device_id: right,
                    generation: right_generation,
                    ..
                },
            ) => left == right && left_generation == right_generation,
            _ => false,
        }
    }

    pub(crate) fn ingress_name(&self) -> &'static str {
        match self.ingress {
            TrustedIngress::DirectLoopback => "direct_loopback",
            TrustedIngress::DirectRemote => "direct_remote",
            TrustedIngress::Relay => "relay",
            TrustedIngress::RelayRenewal => "relay_renewal",
        }
    }
}

/// A connected (or recently-disconnected) client.
pub struct Client {
    pub id: String,
    pub role: ClientRole,
    pub connected: AtomicBool,
    security: std::sync::RwLock<ClientSecurityContext>,
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
    pub ingress: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
}

impl Client {
    /// Create a new WebSocket client with a fresh mpsc send channel.
    pub(crate) fn new(
        id: String,
        remote_addr: String,
        role: ClientRole,
        security: ClientSecurityContext,
    ) -> (Self, WsReceivers) {
        let (priority_tx, priority_rx) = mpsc::channel(PRIORITY_SEND_CHANNEL_SIZE);
        let (bulk_tx, bulk_rx) = mpsc::channel(BULK_SEND_CHANNEL_SIZE);
        let client = Self {
            id,
            role,
            connected: AtomicBool::new(true),
            security: std::sync::RwLock::new(security),
            remote_addr,
            last_seen: Mutex::new(Instant::now()),
            downstream: Mutex::new(Some(DownStream::Mpsc(WsDownstream {
                priority_tx,
                bulk_tx,
            }))),
            conn_gen: AtomicU64::new(0),
        };
        (
            client,
            WsReceivers {
                priority_rx,
                bulk_rx,
            },
        )
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
            security: std::sync::RwLock::new(ClientSecurityContext::direct_loopback_owner()),
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

    /// Bind a handler/request to the exact live WebSocket generation that created it.
    pub fn is_current_connection(&self, expected_conn_gen: u64) -> bool {
        self.is_connected() && self.conn_gen() == expected_conn_gen
    }

    pub(crate) fn security_context(&self) -> ClientSecurityContext {
        self.security.read().unwrap().clone()
    }

    pub(crate) fn is_trusted_local_owner(&self) -> bool {
        self.security.read().unwrap().is_trusted_local_owner()
    }

    pub(crate) fn authenticated_device_id(&self) -> Option<String> {
        self.security
            .read()
            .unwrap()
            .device_id()
            .map(str::to_string)
    }

    pub(crate) fn matches_request_principal(&self, principal: &AuthPrincipal) -> bool {
        match principal {
            AuthPrincipal::Owner { .. } => true,
            AuthPrincipal::Device {
                device_id,
                generation,
                ..
            } => matches!(
                &self.security.read().unwrap().principal,
                AuthPrincipal::Device {
                    device_id: authenticated,
                    generation: authenticated_generation,
                    ..
                } if authenticated == device_id && authenticated_generation == generation
            ),
        }
    }

    pub(crate) fn matches_device_generation(
        &self,
        device_id: &str,
        generation: uuid::Uuid,
    ) -> bool {
        matches!(
            &self.security.read().unwrap().principal,
            AuthPrincipal::Device {
                device_id: authenticated,
                generation: authenticated_generation,
                ..
            } if authenticated == device_id && *authenticated_generation == generation
        )
    }

    pub(crate) fn matches_owner_generation(&self, generation: uuid::Uuid) -> bool {
        matches!(
            &self.security.read().unwrap().principal,
            AuthPrincipal::Owner {
                generation: current
            } if *current == generation
        )
    }

    pub(crate) fn is_device_or_relay(&self) -> bool {
        self.security.read().unwrap().is_device_or_relay()
    }

    pub(crate) fn matches_authenticated_identity(&self, other: &ClientSecurityContext) -> bool {
        self.security
            .read()
            .unwrap()
            .same_authenticated_identity(other)
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
            Some(DownStream::Mpsc(ws)) => match ws.priority_tx.try_send(data) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    drop(guard);
                    self.disconnect();
                    false
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    drop(guard);
                    self.disconnect();
                    false
                }
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
        let priority_tx = {
            let guard = self.downstream.lock().unwrap();
            match guard.as_ref() {
                Some(DownStream::Mpsc(ws)) => Some(ws.priority_tx.clone()),
                _ => None,
            }
        };
        match priority_tx {
            Some(tx) => tx.send(data).await.is_ok(),
            None => self.send(data), // IPC: use non-blocking send
        }
    }

    /// Send through only the downstream that belongs to `expected_conn_gen`.
    ///
    /// The sender is cloned while holding the same downstream lock used by
    /// reconnect. If reconnect wins first, the generation check fails; if this
    /// method wins first, any later await retains only H0's old sender and can
    /// never leak the frame into H1's replacement queue.
    pub(crate) async fn send_async_for_generation(
        &self,
        expected_conn_gen: u64,
        data: Vec<u8>,
    ) -> bool {
        let priority_tx = {
            let guard = self.downstream.lock().unwrap();
            if !self.is_current_connection(expected_conn_gen) {
                return false;
            }
            match guard.as_ref() {
                Some(DownStream::Mpsc(ws)) => Some(ws.priority_tx.clone()),
                Some(DownStream::IpcChannel(ch)) => return ch.send(data).is_ok(),
                None => return false,
            }
        };
        match priority_tx {
            Some(tx) => tx.send(data).await.is_ok(),
            None => false,
        }
    }

    /// Blocking send for bulk transfers on the low-priority queue.
    pub async fn send_bulk_async(&self, data: Vec<u8>) -> bool {
        if !self.is_connected() {
            return false;
        }
        let bulk_tx = {
            let guard = self.downstream.lock().unwrap();
            match guard.as_ref() {
                Some(DownStream::Mpsc(ws)) => Some(ws.bulk_tx.clone()),
                _ => None,
            }
        };
        match bulk_tx {
            Some(tx) => tx.send(data).await.is_ok(),
            _ => self.send(data), // IPC: use non-blocking send
        }
    }

    pub(crate) async fn send_bulk_async_for_generation(
        &self,
        expected_conn_gen: u64,
        data: Vec<u8>,
    ) -> bool {
        let bulk_tx = {
            let guard = self.downstream.lock().unwrap();
            if !self.is_current_connection(expected_conn_gen) {
                return false;
            }
            match guard.as_ref() {
                Some(DownStream::Mpsc(ws)) => Some(ws.bulk_tx.clone()),
                Some(DownStream::IpcChannel(ch)) => return ch.send(data).is_ok(),
                None => return false,
            }
        };
        match bulk_tx {
            Some(tx) => tx.send(data).await.is_ok(),
            None => false,
        }
    }

    /// Mark the client as disconnected.
    pub fn disconnect(&self) {
        self.connected.store(false, Ordering::SeqCst);
        let mut guard = self.downstream.lock().unwrap();
        *guard = None;
    }

    /// Reconnect with fresh WS queues. Returns new receivers for the WS write pump.
    pub(crate) fn reconnect(
        &self,
        _remote_addr: String,
        security: ClientSecurityContext,
    ) -> Result<WsReceivers, String> {
        {
            let current = self.security.read().unwrap();
            if !current.same_authenticated_identity(&security) {
                return Err("client identity mismatch".to_string());
            }
        }
        self.connected.store(false, Ordering::SeqCst);
        let (priority_tx, priority_rx) = mpsc::channel(PRIORITY_SEND_CHANNEL_SIZE);
        let (bulk_tx, bulk_rx) = mpsc::channel(BULK_SEND_CHANNEL_SIZE);
        {
            let mut guard = self.downstream.lock().unwrap();
            *guard = Some(DownStream::Mpsc(WsDownstream {
                priority_tx,
                bulk_tx,
            }));
        }
        *self.security.write().unwrap() = security;
        self.conn_gen.fetch_add(1, Ordering::SeqCst);
        self.connected.store(true, Ordering::SeqCst);
        self.touch();
        Ok(WsReceivers {
            priority_rx,
            bulk_rx,
        })
    }

    /// Build a role-change protocol message for this client.
    pub fn role_message(&self) -> Vec<u8> {
        protocol::encode_role_change(self.role as u8)
    }
}
