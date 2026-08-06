//! Unified download ownership, control, and cancellation registry.
//!
//! WebSocket and desktop IPC downloads share one registry and one session-wide
//! limit. WebSocket limits are counted by stable client ID across reconnect
//! generations. Cancellation only moves a record to [`DownloadPhase::Cancelling`]:
//! capacity is released exclusively by the task's nonce-bound [`DownloadRegistry::release`]
//! call from its `finally` path.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, Weak};

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::DownloadSignal;

pub const MAX_DOWNLOADS_PER_WS_CLIENT: usize = 4;
pub const MAX_DOWNLOADS_PER_SESSION: usize = 16;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum DownloadOwner {
    Ws {
        client_id: String,
        conn_gen: u64,
        transfer_id: u32,
    },
    Ipc {
        transfer_id: u32,
    },
}

impl DownloadOwner {
    pub fn ws(client_id: impl Into<String>, conn_gen: u64, transfer_id: u32) -> Self {
        Self::Ws {
            client_id: client_id.into(),
            conn_gen,
            transfer_id,
        }
    }

    pub fn ipc(transfer_id: u32) -> Self {
        Self::Ipc { transfer_id }
    }

    fn validate(&self) -> Result<(), DownloadRegistryError> {
        match self {
            Self::Ws {
                client_id,
                transfer_id,
                ..
            } => {
                if client_id.is_empty() {
                    return Err(DownloadRegistryError::EmptyClientId);
                }
                if *transfer_id == 0 {
                    return Err(DownloadRegistryError::InvalidTransferId);
                }
            }
            Self::Ipc { transfer_id } if *transfer_id == 0 => {
                return Err(DownloadRegistryError::InvalidTransferId);
            }
            Self::Ipc { .. } => {}
        }
        Ok(())
    }

    fn ws_client_id(&self) -> Option<&str> {
        match self {
            Self::Ws { client_id, .. } => Some(client_id),
            Self::Ipc { .. } => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DownloadPhase {
    Active,
    Paused,
    Cancelling,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DownloadRegistryError {
    Closed,
    EmptyClientId,
    InvalidTransferId,
    AlreadyRegistered,
    ClientLimitReached,
    SessionLimitReached,
}

impl fmt::Display for DownloadRegistryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Closed => "download registry is closed",
            Self::EmptyClientId => "download client ID is required",
            Self::InvalidTransferId => "download transfer ID must be non-zero",
            Self::AlreadyRegistered => "download owner is already registered",
            Self::ClientLimitReached => "client download limit reached",
            Self::SessionLimitReached => "session download limit reached",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for DownloadRegistryError {}

/// Non-authoritative task handle. The registry remains the only owner of the
/// control sender; this handle carries only identity and cancellation state.
#[derive(Clone, Debug)]
pub struct DownloadRegistration {
    owner: DownloadOwner,
    nonce: uuid::Uuid,
    cancellation: CancellationToken,
}

impl DownloadRegistration {
    pub fn owner(&self) -> &DownloadOwner {
        &self.owner
    }

    pub fn cancellation_token(&self) -> CancellationToken {
        self.cancellation.clone()
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }
}

/// Releases a nonce-bound registration when its task returns, is aborted, or
/// unwinds after a panic. A weak registry reference avoids extending the
/// Session lifetime merely for cleanup.
pub struct DownloadTaskGuard {
    registry: Weak<DownloadRegistry>,
    registration: Option<DownloadRegistration>,
}

impl Drop for DownloadTaskGuard {
    fn drop(&mut self) {
        let Some(registration) = self.registration.take() else {
            return;
        };
        if let Some(registry) = self.registry.upgrade() {
            registry.release(&registration);
        }
    }
}

#[derive(Debug)]
struct DownloadRecord {
    registration: DownloadRegistration,
    control: mpsc::Sender<DownloadSignal>,
    phase: DownloadPhase,
}

/// Session-scoped registry shared by WebSocket and desktop IPC downloads.
pub struct DownloadRegistry {
    records: Mutex<HashMap<DownloadOwner, DownloadRecord>>,
    root_cancellation: CancellationToken,
}

impl DownloadRegistry {
    /// Create a registry rooted in the Session cancellation tree.
    ///
    /// Cancelling `session_root` closes this registry's root token and all
    /// registration child tokens. Calling [`Self::cancel_all`] also closes this
    /// registry permanently without cancelling its parent Session token.
    pub fn new(session_root: &CancellationToken) -> Self {
        Self {
            records: Mutex::new(HashMap::new()),
            root_cancellation: session_root.child_token(),
        }
    }

    pub fn register(
        &self,
        owner: DownloadOwner,
        control: mpsc::Sender<DownloadSignal>,
    ) -> Result<DownloadRegistration, DownloadRegistryError> {
        owner.validate()?;
        if self.root_cancellation.is_cancelled() {
            return Err(DownloadRegistryError::Closed);
        }

        let mut records = self.records.lock().unwrap();
        // Recheck after acquiring the registry lock. A registration racing
        // Session close receives an already-cancelled child at worst; it can
        // never continue without observing cancellation.
        if self.root_cancellation.is_cancelled() {
            return Err(DownloadRegistryError::Closed);
        }
        if records.contains_key(&owner) {
            return Err(DownloadRegistryError::AlreadyRegistered);
        }
        if records.len() >= MAX_DOWNLOADS_PER_SESSION {
            return Err(DownloadRegistryError::SessionLimitReached);
        }
        if let Some(client_id) = owner.ws_client_id() {
            let owned = records
                .keys()
                .filter(|existing| existing.ws_client_id() == Some(client_id))
                .count();
            if owned >= MAX_DOWNLOADS_PER_WS_CLIENT {
                return Err(DownloadRegistryError::ClientLimitReached);
            }
        }

        let cancellation = self.root_cancellation.child_token();
        if cancellation.is_cancelled() {
            return Err(DownloadRegistryError::Closed);
        }
        let registration = DownloadRegistration {
            owner: owner.clone(),
            nonce: uuid::Uuid::new_v4(),
            cancellation,
        };
        records.insert(
            owner,
            DownloadRecord {
                registration: registration.clone(),
                control,
                phase: DownloadPhase::Active,
            },
        );
        Ok(registration)
    }

    /// Look up the current nonce-bound task handle for an exact logical owner.
    ///
    /// The control sender remains private to the registry.
    pub fn lookup(&self, owner: &DownloadOwner) -> Option<DownloadRegistration> {
        self.records
            .lock()
            .unwrap()
            .get(owner)
            .map(|record| record.registration.clone())
    }

    pub fn task_guard(self: &Arc<Self>, registration: DownloadRegistration) -> DownloadTaskGuard {
        DownloadTaskGuard {
            registry: Arc::downgrade(self),
            registration: Some(registration),
        }
    }

    /// Task-finally operation. This is the only API that releases capacity.
    pub fn release(&self, registration: &DownloadRegistration) -> bool {
        let mut records = self.records.lock().unwrap();
        let is_current = records
            .get(&registration.owner)
            .is_some_and(|record| record.registration.nonce == registration.nonce);
        if is_current {
            records.remove(&registration.owner);
        }
        is_current
    }

    /// Send a nonce-bound control signal without exposing the sender.
    pub fn signal(&self, registration: &DownloadRegistration, signal: DownloadSignal) -> bool {
        match signal {
            DownloadSignal::Pause => {
                self.transition(registration, DownloadPhase::Paused, DownloadSignal::Pause)
            }
            DownloadSignal::Continue => self.transition(
                registration,
                DownloadPhase::Active,
                DownloadSignal::Continue,
            ),
            DownloadSignal::Cancel => self.cancel(registration),
        }
    }

    /// Look up and signal the current registration for an exact owner.
    pub fn signal_owner(&self, owner: &DownloadOwner, signal: DownloadSignal) -> bool {
        self.lookup(owner)
            .is_some_and(|registration| self.signal(&registration, signal))
    }

    pub fn pause(&self, registration: &DownloadRegistration) -> bool {
        self.signal(registration, DownloadSignal::Pause)
    }

    pub fn pause_owner(&self, owner: &DownloadOwner) -> bool {
        self.signal_owner(owner, DownloadSignal::Pause)
    }

    pub fn continue_download(&self, registration: &DownloadRegistration) -> bool {
        self.signal(registration, DownloadSignal::Continue)
    }

    pub fn continue_owner(&self, owner: &DownloadOwner) -> bool {
        self.signal_owner(owner, DownloadSignal::Continue)
    }

    /// Request cancellation but retain the record and its capacity.
    ///
    /// The task must observe either the token or `DownloadSignal::Cancel`, stop
    /// its I/O, and then call [`Self::release`] from `finally`.
    pub fn cancel(&self, registration: &DownloadRegistration) -> bool {
        let control = {
            let mut records = self.records.lock().unwrap();
            let Some(record) = records.get_mut(&registration.owner) else {
                return false;
            };
            if record.registration.nonce != registration.nonce {
                return false;
            }
            if record.phase == DownloadPhase::Cancelling {
                return true;
            }
            record.phase = DownloadPhase::Cancelling;
            record.registration.cancellation.cancel();
            record.control.clone()
        };
        Self::send_cancel(control);
        true
    }

    pub fn cancel_owner(&self, owner: &DownloadOwner) -> bool {
        self.lookup(owner)
            .is_some_and(|registration| self.cancel(&registration))
    }

    pub fn phase(&self, registration: &DownloadRegistration) -> Option<DownloadPhase> {
        self.records
            .lock()
            .unwrap()
            .get(&registration.owner)
            .filter(|record| record.registration.nonce == registration.nonce)
            .map(|record| record.phase)
    }

    /// Request cancellation for one exact WS connection generation.
    pub fn cancel_ws_generation(&self, client_id: &str, conn_gen: u64) -> usize {
        self.cancel_where(|owner| {
            matches!(
                owner,
                DownloadOwner::Ws {
                    client_id: owner_client,
                    conn_gen: owner_generation,
                    ..
                } if owner_client == client_id && *owner_generation == conn_gen
            )
        })
    }

    /// Request cancellation for superseded generations of one stable client.
    pub fn cancel_stale_ws_generations(&self, client_id: &str, current_conn_gen: u64) -> usize {
        self.cancel_where(|owner| {
            matches!(
                owner,
                DownloadOwner::Ws {
                    client_id: owner_client,
                    conn_gen: owner_generation,
                    ..
                } if owner_client == client_id && *owner_generation != current_conn_gen
            )
        })
    }

    /// Permanently close the registry and request cancellation for all records.
    ///
    /// Records intentionally remain until each task calls [`Self::release`].
    pub fn cancel_all(&self) -> usize {
        self.root_cancellation.cancel();
        self.cancel_where(|_| true)
    }

    pub fn is_closed(&self) -> bool {
        self.root_cancellation.is_cancelled()
    }

    pub fn len(&self) -> usize {
        self.records.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn transition(
        &self,
        registration: &DownloadRegistration,
        next: DownloadPhase,
        signal: DownloadSignal,
    ) -> bool {
        let (control, previous) = {
            let mut records = self.records.lock().unwrap();
            let Some(record) = records.get_mut(&registration.owner) else {
                return false;
            };
            if record.registration.nonce != registration.nonce
                || record.phase == DownloadPhase::Cancelling
            {
                return false;
            }
            if record.phase == next {
                return true;
            }
            let previous = record.phase;
            record.phase = next;
            (record.control.clone(), previous)
        };

        if control.try_send(signal).is_ok() {
            return true;
        }

        // Roll back only if no concurrent cancellation or newer transition won.
        let mut records = self.records.lock().unwrap();
        if let Some(record) = records.get_mut(&registration.owner) {
            if record.registration.nonce == registration.nonce && record.phase == next {
                record.phase = previous;
            }
        }
        false
    }

    fn cancel_where(&self, predicate: impl Fn(&DownloadOwner) -> bool) -> usize {
        let controls = {
            let mut records = self.records.lock().unwrap();
            records
                .iter_mut()
                .filter(|(owner, record)| {
                    predicate(owner) && record.phase != DownloadPhase::Cancelling
                })
                .map(|(_, record)| {
                    record.phase = DownloadPhase::Cancelling;
                    record.registration.cancellation.cancel();
                    record.control.clone()
                })
                .collect::<Vec<_>>()
        };
        for control in controls.iter().cloned() {
            Self::send_cancel(control);
        }
        controls.len()
    }

    fn send_cancel(control: mpsc::Sender<DownloadSignal>) {
        match control.try_send(DownloadSignal::Cancel) {
            Ok(()) | Err(mpsc::error::TrySendError::Closed(_)) => {}
            Err(mpsc::error::TrySendError::Full(signal)) => {
                // CancellationToken is already cancelled, so token-aware tasks
                // stop immediately. Keep a best-effort queued Cancel for paused
                // legacy receivers without blocking cleanup/reconnect.
                if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                    runtime.spawn(async move {
                        let _ = control.send(signal).await;
                    });
                }
            }
        }
    }
}

impl Drop for DownloadRegistry {
    fn drop(&mut self) {
        self.root_cancellation.cancel();
        if let Ok(records) = self.records.get_mut() {
            for record in records.values() {
                record.registration.cancellation.cancel();
                let _ = record.control.try_send(DownloadSignal::Cancel);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_registry() -> (CancellationToken, DownloadRegistry) {
        let root = CancellationToken::new();
        let registry = DownloadRegistry::new(&root);
        (root, registry)
    }

    fn control() -> (mpsc::Sender<DownloadSignal>, mpsc::Receiver<DownloadSignal>) {
        mpsc::channel(8)
    }

    #[test]
    fn fifth_ws_download_remains_blocked_after_cancel_until_release() {
        let (_root, registry) = test_registry();
        let mut registrations = Vec::new();
        let mut receivers = Vec::new();
        for id in 1..=MAX_DOWNLOADS_PER_WS_CLIENT as u32 {
            let (sender, receiver) = control();
            receivers.push(receiver);
            registrations.push(
                registry
                    .register(DownloadOwner::ws("phone", id as u64, id), sender)
                    .unwrap(),
            );
        }

        assert!(registry.cancel(&registrations[0]));
        assert_eq!(
            registry.phase(&registrations[0]),
            Some(DownloadPhase::Cancelling)
        );
        let (fifth_sender, _fifth_receiver) = control();
        assert_eq!(
            registry
                .register(DownloadOwner::ws("phone", 99, 99), fifth_sender.clone())
                .unwrap_err(),
            DownloadRegistryError::ClientLimitReached
        );

        assert!(registry.release(&registrations[0]));
        assert!(registry
            .register(DownloadOwner::ws("phone", 99, 99), fifth_sender)
            .is_ok());
        drop(receivers);
    }

    #[test]
    fn seventeenth_download_is_rejected_sessionwide() {
        let (_root, registry) = test_registry();
        let mut receivers = Vec::new();
        for id in 1..=MAX_DOWNLOADS_PER_SESSION as u32 {
            let (sender, receiver) = control();
            receivers.push(receiver);
            registry.register(DownloadOwner::ipc(id), sender).unwrap();
        }

        let (sender, _receiver) = control();
        assert_eq!(
            registry
                .register(DownloadOwner::ipc(17), sender)
                .unwrap_err(),
            DownloadRegistryError::SessionLimitReached
        );
    }

    #[test]
    fn closed_root_and_cancel_all_reject_registration() {
        let root = CancellationToken::new();
        let registry = DownloadRegistry::new(&root);
        root.cancel();
        let (sender, _receiver) = control();
        assert_eq!(
            registry
                .register(DownloadOwner::ipc(1), sender)
                .unwrap_err(),
            DownloadRegistryError::Closed
        );

        let (_root, registry) = test_registry();
        assert_eq!(registry.cancel_all(), 0);
        assert!(registry.is_closed());
        let (sender, _receiver) = control();
        assert_eq!(
            registry
                .register(DownloadOwner::ipc(1), sender)
                .unwrap_err(),
            DownloadRegistryError::Closed
        );
    }

    #[test]
    fn stale_nonce_cannot_delete_or_cancel_replacement() {
        let (_root, registry) = test_registry();
        let owner = DownloadOwner::ws("phone", 7, 42);
        let (old_sender, _old_receiver) = control();
        let old = registry.register(owner.clone(), old_sender).unwrap();
        assert!(registry.release(&old));

        let (replacement_sender, _replacement_receiver) = control();
        let replacement = registry
            .register(owner.clone(), replacement_sender)
            .unwrap();
        assert!(!registry.release(&old));
        assert!(!registry.cancel(&old));
        assert_eq!(registry.phase(&replacement), Some(DownloadPhase::Active));
        assert!(!replacement.is_cancelled());
        assert_eq!(registry.lookup(&owner).unwrap().nonce, replacement.nonce);
    }

    #[test]
    fn paused_download_receives_cancel_but_keeps_capacity_until_release() {
        let (_root, registry) = test_registry();
        let owner = DownloadOwner::ws("phone", 8, 1);
        let (sender, mut receiver) = control();
        let registration = registry.register(owner.clone(), sender).unwrap();
        assert!(registry.pause_owner(&owner));
        assert!(matches!(receiver.try_recv(), Ok(DownloadSignal::Pause)));
        assert_eq!(registry.phase(&registration), Some(DownloadPhase::Paused));

        assert_eq!(registry.cancel_ws_generation("phone", 8), 1);
        assert!(registration.is_cancelled());
        assert!(matches!(receiver.try_recv(), Ok(DownloadSignal::Cancel)));
        assert_eq!(
            registry.phase(&registration),
            Some(DownloadPhase::Cancelling)
        );
        assert_eq!(registry.len(), 1);
        assert!(registry.release(&registration));
        assert!(registry.is_empty());
    }

    #[test]
    fn exact_owner_control_api_needs_no_external_sender_map() {
        let (_root, registry) = test_registry();
        let owner = DownloadOwner::ipc(7);
        let (sender, mut receiver) = control();
        let registration = registry.register(owner.clone(), sender).unwrap();
        let token = registration.cancellation_token();
        assert_eq!(registration.owner(), &owner);
        assert_eq!(registry.lookup(&owner).unwrap().nonce, registration.nonce);

        assert!(registry.pause_owner(&owner));
        assert!(matches!(receiver.try_recv(), Ok(DownloadSignal::Pause)));
        assert!(registry.continue_owner(&owner));
        assert!(matches!(receiver.try_recv(), Ok(DownloadSignal::Continue)));
        assert!(registry.pause(&registration));
        assert!(matches!(receiver.try_recv(), Ok(DownloadSignal::Pause)));
        assert!(registry.continue_download(&registration));
        assert!(matches!(receiver.try_recv(), Ok(DownloadSignal::Continue)));
        assert!(registry.cancel_owner(&owner));
        assert!(matches!(receiver.try_recv(), Ok(DownloadSignal::Cancel)));
        assert!(token.is_cancelled());
        assert_eq!(
            registry.phase(&registration),
            Some(DownloadPhase::Cancelling)
        );
        assert!(registry.release(&registration));
    }

    #[test]
    fn stale_exact_and_all_cancellation_mark_without_removing() {
        let (_root, registry) = test_registry();
        let mut receivers = Vec::new();
        let mut register = |owner| {
            let (sender, receiver) = control();
            receivers.push(receiver);
            registry.register(owner, sender).unwrap()
        };
        let h0 = register(DownloadOwner::ws("phone", 10, 1));
        let h1 = register(DownloadOwner::ws("phone", 11, 1));
        let other = register(DownloadOwner::ws("other", 10, 1));
        let ipc = register(DownloadOwner::ipc(1));

        assert_eq!(registry.cancel_stale_ws_generations("phone", 11), 1);
        assert_eq!(registry.phase(&h0), Some(DownloadPhase::Cancelling));
        assert_eq!(registry.phase(&h1), Some(DownloadPhase::Active));
        assert_eq!(registry.len(), 4);

        assert_eq!(registry.cancel_ws_generation("phone", 11), 1);
        assert_eq!(registry.phase(&h1), Some(DownloadPhase::Cancelling));
        assert_eq!(registry.cancel_all(), 2);
        assert_eq!(registry.phase(&other), Some(DownloadPhase::Cancelling));
        assert_eq!(registry.phase(&ipc), Some(DownloadPhase::Cancelling));
        assert_eq!(registry.len(), 4);

        assert!(registry.release(&h0));
        assert!(registry.release(&h1));
        assert!(registry.release(&other));
        assert!(registry.release(&ipc));
        assert!(registry.is_empty());
    }

    #[test]
    fn task_guard_releases_capacity_during_panic_unwind() {
        let root = CancellationToken::new();
        let registry = Arc::new(DownloadRegistry::new(&root));
        let (sender, _receiver) = control();
        let registration = registry.register(DownloadOwner::ipc(1), sender).unwrap();

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe({
            let registry = Arc::clone(&registry);
            move || {
                let _guard = registry.task_guard(registration);
                panic!("test panic");
            }
        }));
        assert!(result.is_err());
        assert!(registry.is_empty());
    }
}
