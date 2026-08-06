//! Backend-authoritative LAN access and mDNS discovery policy.
//!
//! The renderer may display this state, but it is never a security authority.

use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::auth::TrustedIngress;
use super::ServerState;

const POLICY_VERSION: u32 = 1;
const POLICY_FILE: &str = "lan-access.json";

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct LanAccessPolicy {
    pub enabled: bool,
    pub discoverable: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct LanAccessStatus {
    pub enabled: bool,
    pub discoverable: bool,
    pub lan_port: u16,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PersistedPolicy {
    version: u32,
    enabled: bool,
    discoverable: bool,
}

/// Runtime gate plus one cancellation generation for accepted direct-remote
/// sockets. Taking a lease and closing the gate serialize on the same mutex, so
/// a connection can never escape onto the fresh post-disable generation.
pub(crate) struct LanAccessControl {
    enabled: AtomicBool,
    discoverable: AtomicBool,
    transition: Mutex<()>,
    direct_remote_cancel: Mutex<CancellationToken>,
    policy_path: Option<PathBuf>,
}

impl LanAccessControl {
    pub(crate) fn new(state_dir: &str) -> Self {
        Self {
            enabled: AtomicBool::new(false),
            discoverable: AtomicBool::new(false),
            transition: Mutex::new(()),
            direct_remote_cancel: Mutex::new(CancellationToken::new()),
            policy_path: policy_path(state_dir),
        }
    }

    fn enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    fn discoverable(&self) -> bool {
        self.discoverable.load(Ordering::SeqCst)
    }

    fn mark_discoverable(&self, value: bool) {
        self.discoverable.store(value, Ordering::SeqCst);
    }

    fn open_gate(&self) {
        let mut cancel = self.direct_remote_cancel.lock().unwrap();
        if cancel.is_cancelled() {
            *cancel = CancellationToken::new();
        }
        self.enabled.store(true, Ordering::SeqCst);
    }

    fn close_gate(&self) {
        let mut cancel = self.direct_remote_cancel.lock().unwrap();
        self.enabled.store(false, Ordering::SeqCst);
        cancel.cancel();
        *cancel = CancellationToken::new();
    }

    fn direct_remote_lease(&self) -> Option<CancellationToken> {
        let cancel = self.direct_remote_cancel.lock().unwrap();
        self.enabled().then(|| cancel.clone())
    }

    fn persist(&self, policy: LanAccessPolicy) -> Result<(), String> {
        let Some(path) = self.policy_path.as_deref() else {
            return Ok(());
        };
        persist_policy(path, policy)
    }

    /// Disabling is fail-closed across restart. If the atomic rewrite fails,
    /// first durably truncate the existing preference in place. A missing,
    /// empty, partial, or valid disabled file all load fail-closed. This handles
    /// the important case where the directory cannot create/rename entries but
    /// the existing private file is still writable. Removing the preference is
    /// the final fallback because missing state also loads as disabled.
    fn persist_disabled(&self) -> Result<(), String> {
        let policy = LanAccessPolicy::default();
        let Some(path) = self.policy_path.as_deref() else {
            return Ok(());
        };
        if let Err(write_error) = persist_policy(path, policy) {
            match overwrite_disabled_in_place(path, policy) {
                Ok(()) => {
                    eprintln!(
                        "[lan] atomic policy rewrite failed; invalidated it fail-closed in place: {write_error}"
                    );
                    Ok(())
                }
                Err(in_place_error) => match remove_policy_file(path) {
                    Ok(()) => {
                        eprintln!(
                            "[lan] policy rewrites failed; removed it fail-closed: {write_error}; {in_place_error}"
                        );
                        Ok(())
                    }
                    Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
                    Err(remove_error) => Err(format!(
                        "failed to persist disabled LAN policy ({write_error}); in-place invalidation failed ({in_place_error}); fail-closed removal failed: {remove_error}"
                    )),
                },
            }
        } else {
            Ok(())
        }
    }
}

impl ServerState {
    pub fn lan_access_status(&self) -> LanAccessStatus {
        let discovery_live = self
            .discovery_manager
            .as_ref()
            .is_some_and(|discovery| discovery.is_discoverable());
        LanAccessStatus {
            enabled: self.lan_access.enabled(),
            // The policy atomic tracks requested runtime state; the public
            // status must also reflect asynchronous publisher failure.
            discoverable: self.lan_access.discoverable() && discovery_live,
            lan_port: self.lan_port(),
        }
    }

    pub fn lan_access_enabled(&self) -> bool {
        self.lan_access.enabled()
    }

    /// Lease for one accepted direct-remote socket. `None` means reject before
    /// the global connection permit or TLS machinery is touched.
    pub(crate) fn direct_remote_lease(&self) -> Option<CancellationToken> {
        self.lan_access.direct_remote_lease()
    }

    /// Revalidate one HTTP-upgraded connection after it has entered its runtime
    /// registry. HTTP/1 hands the raw socket to the WebSocket task before the
    /// outer connection future completes, so the accept-loop cancellation token
    /// alone cannot close a registration that races LAN shutdown.
    ///
    /// Taking `transition` creates one total order with shutdown's gate close and
    /// registry scan: a registration validated first is found by the later scan;
    /// a scan that runs first leaves the gate closed for this check to reject.
    pub(crate) fn registered_ingress_allowed(&self, ingress: TrustedIngress) -> bool {
        match ingress {
            TrustedIngress::DirectLoopback | TrustedIngress::Relay => true,
            TrustedIngress::RelayRenewal => false,
            TrustedIngress::DirectRemote => {
                let _transition = self.lan_access.transition.lock().unwrap();
                self.lan_access.enabled()
            }
        }
    }

    pub fn set_lan_access(&self, enabled: bool) -> Result<LanAccessStatus, String> {
        let _transition = self.lan_access.transition.lock().unwrap();
        if enabled {
            if !self.lan_access.enabled() {
                self.lan_access.persist(LanAccessPolicy {
                    enabled: true,
                    discoverable: self.lan_access.discoverable(),
                })?;
                self.pairing_manager.set_lan_pairing_enabled(true);
                self.lan_access.open_gate();
            }
            return Ok(self.lan_access_status());
        }

        self.disable_lan_runtime_locked(true)?;
        Ok(self.lan_access_status())
    }

    pub fn set_lan_discovery(&self, enabled: bool) -> Result<LanAccessStatus, String> {
        let _transition = self.lan_access.transition.lock().unwrap();
        if enabled {
            if !self.lan_access.enabled() {
                return Err("LAN access must be enabled before discovery".to_string());
            }
            let discovery_live = self
                .discovery_manager
                .as_ref()
                .is_some_and(|discovery| discovery.is_discoverable());
            if !self.lan_access.discoverable() || !discovery_live {
                self.set_discovery_runtime(true)?;
                if let Err(error) = self.lan_access.persist(LanAccessPolicy {
                    enabled: true,
                    discoverable: true,
                }) {
                    let rollback = self.set_discovery_runtime(false);
                    return Err(match rollback {
                        Ok(()) => error,
                        Err(rollback_error) => {
                            format!("{error}; discovery rollback failed: {rollback_error}")
                        }
                    });
                }
            }
        } else if self.lan_access.discoverable() {
            // Persist the privacy-preserving target first. If unregister then
            // fails, the current truthful status remains discoverable=true but
            // the next launch will not advertise.
            self.lan_access.persist(LanAccessPolicy {
                enabled: self.lan_access.enabled(),
                discoverable: false,
            })?;
            self.set_discovery_runtime(false)?;
        }
        Ok(self.lan_access_status())
    }

    pub(crate) fn restore_lan_access(
        &self,
        policy: LanAccessPolicy,
    ) -> Result<LanAccessStatus, String> {
        let _transition = self.lan_access.transition.lock().unwrap();
        if !policy.enabled {
            return Ok(self.lan_access_status());
        }
        if policy.discoverable {
            // Discovery is optional once the two controls are split. A failed
            // mDNS restore must not undo an explicitly persisted access grant;
            // downgrade the effective and persisted policy to access-only.
            if let Err(error) = self.set_discovery_runtime(true) {
                eprintln!("[lan] discovery restore degraded to access-only: {error}");
                if let Err(persist_error) = self.lan_access.persist(LanAccessPolicy {
                    enabled: true,
                    discoverable: false,
                }) {
                    eprintln!("[lan] failed to persist discovery downgrade: {persist_error}");
                }
            }
        }
        self.pairing_manager.set_lan_pairing_enabled(true);
        self.lan_access.open_gate();
        Ok(self.lan_access_status())
    }

    /// Stop runtime access without changing the preference restored next time.
    pub fn shutdown_lan_access(&self) {
        let _transition = self.lan_access.transition.lock().unwrap();
        let _ = self.disable_lan_runtime_locked(false);
    }

    fn disable_lan_runtime_locked(&self, persist: bool) -> Result<(), String> {
        let was_enabled = self.lan_access.enabled();
        // The gate and raw socket generation close before any fallible cleanup.
        self.lan_access.close_gate();
        let session_count = self
            .session_manager
            .disconnect_ingress(TrustedIngress::DirectRemote);
        let presence_count = self
            .presence
            .disconnect_ingress(TrustedIngress::DirectRemote);
        self.pairing_manager.set_lan_pairing_enabled(false);

        let persist_result = if persist {
            self.lan_access.persist_disabled()
        } else {
            Ok(())
        };
        if let Err(error) = persist_result {
            // There is no honest way to promise a restart-safe disable when the
            // old enabled policy cannot be overwritten, invalidated, or removed.
            // Reject the transition and restore the previously enabled runtime
            // instead of publishing a temporary "off" state that silently turns
            // back on after restart. Already disconnected direct clients remain
            // disconnected and must explicitly reconnect.
            if was_enabled {
                self.pairing_manager.set_lan_pairing_enabled(true);
                self.lan_access.open_gate();
            }
            return Err(error);
        }
        let discovery_result = self.set_discovery_runtime(false);
        eprintln!(
            "[lan] access disabled; direct sessions={session_count} presence={presence_count}"
        );

        discovery_result
    }

    fn set_discovery_runtime(&self, enabled: bool) -> Result<(), String> {
        if enabled {
            let discovery = self
                .discovery_manager
                .as_ref()
                .ok_or_else(|| "LAN discovery is unavailable".to_string())?;
            let name = self.display_name();
            discovery.set_discoverable(true, Some(self.lan_port()), Some(&name))?;
            self.lan_access.mark_discoverable(true);
        } else {
            if let Some(discovery) = self.discovery_manager.as_ref() {
                discovery.set_discoverable(false, None, None)?;
            }
            self.lan_access.mark_discoverable(false);
        }
        Ok(())
    }
}

pub(crate) fn load_policy(state_dir: &str) -> LanAccessPolicy {
    let Some(path) = policy_path(state_dir) else {
        return LanAccessPolicy::default();
    };
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == ErrorKind::NotFound => return LanAccessPolicy::default(),
        Err(error) => {
            eprintln!("[lan] policy read failed; defaulting off: {error}");
            return LanAccessPolicy::default();
        }
    };
    let persisted: PersistedPolicy = match serde_json::from_slice(&bytes) {
        Ok(persisted) => persisted,
        Err(error) => {
            eprintln!("[lan] invalid policy; defaulting off: {error}");
            return LanAccessPolicy::default();
        }
    };
    if persisted.version != POLICY_VERSION || (persisted.discoverable && !persisted.enabled) {
        eprintln!("[lan] unsupported or inconsistent policy; defaulting off");
        return LanAccessPolicy::default();
    }
    LanAccessPolicy {
        enabled: persisted.enabled,
        discoverable: persisted.discoverable,
    }
}

fn persist_policy(path: &Path, policy: LanAccessPolicy) -> Result<(), String> {
    if take_injected_atomic_write_failure() {
        return Err("injected LAN policy atomic write failure".to_string());
    }
    let bytes = serde_json::to_vec_pretty(&PersistedPolicy {
        version: POLICY_VERSION,
        enabled: policy.enabled,
        discoverable: policy.discoverable,
    })
    .map_err(|error| format!("serialize LAN access policy: {error}"))?;
    super::private_file::atomic_write_private(path, &bytes)
}

/// Durably destroy an old enabled policy before attempting to write the valid
/// disabled replacement. Once the empty-file sync succeeds, every subsequent
/// state is fail-closed: a crash restores the durable empty tombstone, while a
/// short/partial replacement is rejected by strict JSON loading.
fn overwrite_disabled_in_place(path: &Path, policy: LanAccessPolicy) -> Result<(), String> {
    if take_injected_in_place_write_failure() {
        return Err("injected LAN policy in-place write failure".to_string());
    }

    let mut file = match std::fs::OpenOptions::new().write(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("open {} for invalidation: {error}", path.display())),
    };
    file.set_len(0)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("durably truncate {}: {error}", path.display()))?;

    let bytes = serde_json::to_vec_pretty(&PersistedPolicy {
        version: POLICY_VERSION,
        enabled: policy.enabled,
        discoverable: policy.discoverable,
    })
    .map_err(|error| format!("serialize disabled LAN policy: {error}"))?;
    if let Err(error) = file
        .write_all(&bytes)
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_all())
    {
        // The durable empty checkpoint above already guarantees fail-closed
        // restart behavior. The attempted replacement contains only a disabled
        // policy, so even a visible partial write cannot become enabled=true.
        eprintln!(
            "[lan] disabled policy replacement incomplete after durable invalidation: {error}"
        );
    }
    Ok(())
}

fn remove_policy_file(path: &Path) -> std::io::Result<()> {
    if take_injected_remove_failure() {
        return Err(std::io::Error::new(
            ErrorKind::PermissionDenied,
            "injected LAN policy removal failure",
        ));
    }
    std::fs::remove_file(path)
}

#[cfg(test)]
thread_local! {
    static FAIL_NEXT_ATOMIC_WRITE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static FAIL_NEXT_IN_PLACE_WRITE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static FAIL_NEXT_REMOVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
fn take_injected_atomic_write_failure() -> bool {
    FAIL_NEXT_ATOMIC_WRITE.with(|flag| flag.replace(false))
}

#[cfg(not(test))]
fn take_injected_atomic_write_failure() -> bool {
    false
}

#[cfg(test)]
fn take_injected_in_place_write_failure() -> bool {
    FAIL_NEXT_IN_PLACE_WRITE.with(|flag| flag.replace(false))
}

#[cfg(not(test))]
fn take_injected_in_place_write_failure() -> bool {
    false
}

#[cfg(test)]
fn take_injected_remove_failure() -> bool {
    FAIL_NEXT_REMOVE.with(|flag| flag.replace(false))
}

#[cfg(not(test))]
fn take_injected_remove_failure() -> bool {
    false
}

fn policy_path(state_dir: &str) -> Option<PathBuf> {
    (!state_dir.is_empty()).then(|| Path::new(state_dir).join(POLICY_FILE))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("meterm-lan-policy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn missing_corrupt_and_inconsistent_policy_fail_closed() {
        let dir = temp_dir();
        let dir_text = dir.to_string_lossy().to_string();
        assert_eq!(load_policy(&dir_text), LanAccessPolicy::default());

        std::fs::write(dir.join(POLICY_FILE), b"not-json").unwrap();
        assert_eq!(load_policy(&dir_text), LanAccessPolicy::default());

        std::fs::write(
            dir.join(POLICY_FILE),
            br#"{"version":1,"enabled":false,"discoverable":true}"#,
        )
        .unwrap();
        assert_eq!(load_policy(&dir_text), LanAccessPolicy::default());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn policy_round_trip_and_remote_generation_cancel() {
        let dir = temp_dir();
        let dir_text = dir.to_string_lossy().to_string();
        let control = LanAccessControl::new(&dir_text);
        let policy = LanAccessPolicy {
            enabled: true,
            discoverable: false,
        };
        control.persist(policy).unwrap();
        assert_eq!(load_policy(&dir_text), policy);

        assert!(control.direct_remote_lease().is_none());
        control.open_gate();
        let lease = control.direct_remote_lease().unwrap();
        assert!(!lease.is_cancelled());
        control.close_gate();
        assert!(lease.is_cancelled());
        assert!(control.direct_remote_lease().is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn atomic_disable_failure_overwrites_old_enabled_policy_fail_closed() {
        let dir = temp_dir();
        let dir_text = dir.to_string_lossy().to_string();
        let control = LanAccessControl::new(&dir_text);
        control
            .persist(LanAccessPolicy {
                enabled: true,
                discoverable: true,
            })
            .unwrap();

        FAIL_NEXT_ATOMIC_WRITE.with(|flag| flag.set(true));
        control.persist_disabled().unwrap();

        assert_eq!(load_policy(&dir_text), LanAccessPolicy::default());
        let bytes = std::fs::read(dir.join(POLICY_FILE)).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("\"enabled\": true"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn failed_rewrites_remove_old_enabled_policy_fail_closed() {
        let dir = temp_dir();
        let dir_text = dir.to_string_lossy().to_string();
        let control = LanAccessControl::new(&dir_text);
        control
            .persist(LanAccessPolicy {
                enabled: true,
                discoverable: false,
            })
            .unwrap();

        FAIL_NEXT_ATOMIC_WRITE.with(|flag| flag.set(true));
        FAIL_NEXT_IN_PLACE_WRITE.with(|flag| flag.set(true));
        control.persist_disabled().unwrap();

        assert!(!dir.join(POLICY_FILE).exists());
        assert_eq!(load_policy(&dir_text), LanAccessPolicy::default());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn unrecoverable_disable_persistence_failure_rejects_temporary_off_state() {
        let dir = temp_dir();
        let dir_text = dir.to_string_lossy().to_string();
        let mut state = crate::server::create_dummy_state();
        state.lan_access = LanAccessControl::new(&dir_text);
        state.set_lan_access(true).unwrap();

        FAIL_NEXT_ATOMIC_WRITE.with(|flag| flag.set(true));
        FAIL_NEXT_IN_PLACE_WRITE.with(|flag| flag.set(true));
        FAIL_NEXT_REMOVE.with(|flag| flag.set(true));
        assert!(state.set_lan_access(false).is_err());

        // No false "off" state may be published while a valid enabled policy
        // remains. The failed operation is rolled back and requires retry.
        assert!(state.lan_access_status().enabled);
        assert!(state.pairing_manager.create_bootstrap_ticket().is_ok());
        assert!(load_policy(&dir_text).enabled);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn registered_ingress_validation_rejects_only_closed_direct_remote() {
        let state = crate::server::create_dummy_state();
        assert!(!state.registered_ingress_allowed(TrustedIngress::DirectRemote));
        assert!(state.registered_ingress_allowed(TrustedIngress::DirectLoopback));
        assert!(state.registered_ingress_allowed(TrustedIngress::Relay));
        assert!(!state.registered_ingress_allowed(TrustedIngress::RelayRenewal));

        state.set_lan_access(true).unwrap();
        assert!(state.registered_ingress_allowed(TrustedIngress::DirectRemote));
        state.set_lan_access(false).unwrap();
        assert!(!state.registered_ingress_allowed(TrustedIngress::DirectRemote));
    }

    #[tokio::test]
    async fn public_discovery_status_requires_a_live_publisher() {
        let state = crate::server::create_dummy_state();
        state.lan_access.mark_discoverable(true);

        assert!(!state.lan_access_status().discoverable);
    }
}
