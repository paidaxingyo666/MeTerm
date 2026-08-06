//! Device pairing manager — mirrors Go `api/pairing.go`.
//!
//! Manages pending pairing requests with TTL, rate limiting, and approval flow.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::auth::{constant_time_eq, Authenticator};
use super::ban::BanManager;
use super::protocol;
use super::session::manager::SessionManager;

const BOOTSTRAP_TICKET_TTL: Duration = Duration::from_secs(120);
const MAX_BOOTSTRAP_TICKETS: usize = 32;
const MAX_PAIR_REQUESTS: usize = 128;
const MAX_RATE_LIMIT_IPS: usize = 1024;
const MAX_CLAIMED_NONCES: usize = 128;

#[derive(Clone)]
struct BootstrapTicket {
    hash: [u8; 32],
    expires_at: Instant,
}

struct BootstrapTickets {
    entries: Mutex<Vec<BootstrapTicket>>,
    ttl: Duration,
}

impl BootstrapTickets {
    fn new(ttl: Duration) -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
            ttl,
        }
    }

    fn issue(&self) -> String {
        let ticket = super::generate_token();
        let now = Instant::now();
        let mut entries = self.entries.lock().unwrap();
        entries.retain(|entry| entry.expires_at > now);
        if entries.len() >= MAX_BOOTSTRAP_TICKETS {
            entries.remove(0);
        }
        entries.push(BootstrapTicket {
            hash: Sha256::digest(ticket.as_bytes()).into(),
            expires_at: now + self.ttl,
        });
        ticket
    }

    /// Hold the ticket lock through issuance and remove only after success.
    fn redeem<T>(
        &self,
        ticket: &str,
        issue: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        if !is_canonical_random_token(ticket) {
            return Err("invalid or expired pair_ticket".to_string());
        }

        let candidate: [u8; 32] = Sha256::digest(ticket.as_bytes()).into();
        let now = Instant::now();
        let mut entries = self.entries.lock().unwrap();
        entries.retain(|entry| entry.expires_at > now);
        let Some(index) = entries
            .iter()
            .position(|entry| constant_time_eq(&candidate, &entry.hash))
        else {
            return Err("invalid or expired pair_ticket".to_string());
        };

        let value = issue()?;
        entries.swap_remove(index);
        Ok(value)
    }

    fn clear(&self) {
        self.entries.lock().unwrap().clear();
    }
}

fn is_canonical_random_token(value: &str) -> bool {
    if value.len() != 43 {
        return false;
    }
    let Ok(bytes) = URL_SAFE_NO_PAD.decode(value) else {
        return false;
    };
    bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == value
}

/// A pending pairing request.
#[derive(Clone)]
pub struct PairRequest {
    pub id: String,
    pub device_id: String,
    pub device_info: String,
    pub remote_addr: String,
    pub status: String, // "pending" | "approved" | "denied" | "expired"
    pub created_at: Instant,
    pub creator_ip: String,
    pub secret: String,
    /// Canonical base64url uncompressed P-256 public key validated when the
    /// request was created. Never supplied by the approving WebView.
    proof_public_key: String,
    issued_token: Option<String>,
}

impl std::fmt::Debug for PairRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PairRequest")
            .field("id", &self.id)
            .field("status", &self.status)
            .field("created_at", &self.created_at)
            .finish_non_exhaustive()
    }
}

/// A device that has been approved for pairing.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PairedDevice {
    pub ip: String,
    pub device_info: String,
    pub paired_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ApprovedPair {
    pub device_id: String,
    pub retired_generation: Option<uuid::Uuid>,
}

pub struct PairingManager {
    requests: Mutex<HashMap<String, PairRequest>>,
    paired_devices: Mutex<HashMap<String, PairedDevice>>,
    rate_limits: Mutex<HashMap<String, Vec<Instant>>>,
    /// nonce 认领表:桌面弹窗每个 QR 带唯一 nonce,手机扫码配对成功后回传认领。
    /// nonce → (device_name, claimed_at_secs);查询时惰性清理超 600s 的旧项,防无界增长。
    claimed_nonces: Mutex<HashMap<String, (Option<String>, u64)>>,
    /// Serializes pairing capability creation/redemption, device issuance,
    /// and revoke-all so their final state has one linear order.
    credential_gate: Mutex<()>,
    /// Pairing capabilities exist only while direct LAN access is enabled.
    /// The flag is read while `credential_gate` is held so disabling, clearing,
    /// issuing and redeeming have one linear order.
    lan_pairing_enabled: AtomicBool,
    bootstrap_tickets: BootstrapTickets,
    auth: Arc<Authenticator>,
    session_manager: Arc<SessionManager>,
    ban_manager: Arc<BanManager>,
    cancel: CancellationToken,
}

impl PairingManager {
    pub fn new(
        auth: Arc<Authenticator>,
        session_manager: Arc<SessionManager>,
        ban_manager: Arc<BanManager>,
    ) -> Arc<Self> {
        let cancel = CancellationToken::new();
        let mgr = Arc::new(Self {
            requests: Mutex::new(HashMap::new()),
            paired_devices: Mutex::new(HashMap::new()),
            rate_limits: Mutex::new(HashMap::new()),
            claimed_nonces: Mutex::new(HashMap::new()),
            credential_gate: Mutex::new(()),
            lan_pairing_enabled: AtomicBool::new(false),
            bootstrap_tickets: BootstrapTickets::new(BOOTSTRAP_TICKET_TTL),
            auth,
            session_manager,
            ban_manager,
            cancel: cancel.clone(),
        });

        // Cleanup loop: remove expired requests every 10s
        let mgr_weak = Arc::downgrade(&mgr);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(10));
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = interval.tick() => {
                        if let Some(mgr) = mgr_weak.upgrade() {
                            mgr.cleanup_expired();
                        } else {
                            break;
                        }
                    }
                }
            }
        });

        mgr
    }

    /// Check rate limit: max 5 requests per minute per IP.
    fn check_rate_limit(&self, ip: &str) -> bool {
        let mut limits = self.rate_limits.lock().unwrap();
        let now = Instant::now();
        let cutoff = now - Duration::from_secs(60);

        limits.retain(|_, times| {
            times.retain(|time| *time > cutoff);
            !times.is_empty()
        });
        if !limits.contains_key(ip) && limits.len() >= MAX_RATE_LIMIT_IPS {
            return false;
        }

        let times = limits.entry(ip.to_string()).or_default();

        if times.len() >= 5 {
            return false;
        }
        times.push(now);
        true
    }

    pub fn create_bootstrap_ticket(&self) -> Result<String, String> {
        let _gate = self.credential_gate.lock().unwrap();
        if !self.lan_pairing_enabled.load(Ordering::SeqCst) {
            return Err("LAN access is disabled".to_string());
        }
        Ok(self.bootstrap_tickets.issue())
    }

    pub(crate) fn set_lan_pairing_enabled(&self, enabled: bool) {
        let _gate = self.credential_gate.lock().unwrap();
        self.lan_pairing_enabled.store(enabled, Ordering::SeqCst);
        if !enabled {
            self.bootstrap_tickets.clear();
            self.requests.lock().unwrap().clear();
            self.claimed_nonces.lock().unwrap().clear();
        }
    }

    pub fn redeem_bootstrap_ticket(
        &self,
        ticket: &str,
        device_id: &str,
        device_name: &str,
        proof_public_key: &str,
        proof_signature: &str,
    ) -> Result<super::device_auth::IssuedDeviceCredential, String> {
        let _gate = self.credential_gate.lock().unwrap();
        if !self.lan_pairing_enabled.load(Ordering::SeqCst) {
            return Err("LAN access is disabled".to_string());
        }
        self.bootstrap_tickets.redeem(ticket, || {
            let key = super::pop::decode_public_key(proof_public_key)?;
            super::pop::verify_pairing_signature(
                &key,
                proof_signature,
                device_id,
                device_name,
                ticket,
            )?;
            self.auth
                .issue_device_credential_with_proof(device_id, device_name, proof_public_key)
        })
    }

    /// Create a new pairing request and notify all masters.
    pub fn create_request(
        &self,
        device_info: &str,
        device_id: &str,
        remote_addr: &str,
        proof_public_key: &str,
        proof_signature: &str,
    ) -> Result<(String, String), String> {
        let _gate = self.credential_gate.lock().unwrap();
        if !self.lan_pairing_enabled.load(Ordering::SeqCst) {
            return Err("LAN access is disabled".to_string());
        }
        let identity = self.auth.validate_device_identity(device_id, device_info)?;
        if remote_addr.parse::<std::net::IpAddr>().is_err() {
            return Err("invalid remote address".to_string());
        }
        if !self.check_rate_limit(remote_addr) {
            return Err("rate limit exceeded".to_string());
        }
        let proof_public_key_bytes = super::pop::decode_public_key(proof_public_key)?;
        super::pop::verify_pairing_signature(
            &proof_public_key_bytes,
            proof_signature,
            &identity.device_id,
            &identity.device_name,
            "approval",
        )?;

        let id = uuid::Uuid::new_v4().to_string();
        let secret = super::generate_token();

        let req = PairRequest {
            id: id.clone(),
            device_id: identity.device_id,
            device_info: identity.device_name.clone(),
            remote_addr: remote_addr.to_string(),
            status: "pending".to_string(),
            created_at: Instant::now(),
            creator_ip: remote_addr.to_string(),
            secret: secret.clone(),
            proof_public_key: proof_public_key.to_string(),
            issued_token: None,
        };

        let mut requests = self.requests.lock().unwrap();
        retain_live_requests(&mut requests, Instant::now());
        if requests.len() >= MAX_PAIR_REQUESTS {
            return Err("pair request limit reached".to_string());
        }
        requests.insert(id.clone(), req);
        drop(requests);

        // Notify all master clients
        let notify_msg = protocol::encode_pair_notify(&id, &identity.device_name, remote_addr);
        for session in self.session_manager.list() {
            let master_id = session.master();
            if !master_id.is_empty() {
                session.send_to_client(&master_id, notify_msg.clone());
            }
        }

        Ok((id, secret))
    }

    /// Get request status (for polling by creator).
    pub fn get_request(&self, id: &str, secret: &str) -> Option<PairRequestStatus> {
        if uuid::Uuid::parse_str(id).is_err() || !is_canonical_random_token(secret) {
            return None;
        }
        let requests = self.requests.lock().unwrap();
        let req = requests.get(id)?;

        // Verify without leaking a matching prefix or length through normal lookup.
        if !constant_time_eq(req.secret.as_bytes(), secret.as_bytes()) {
            return None;
        }

        let mut result = PairRequestStatus {
            status: req.status.clone(),
            token: None,
        };

        // Keep the issued device token in-process with the short-lived result so
        // a lost poll response can be retried without rotating the credential.
        if req.status == "approved" {
            result.token = req.issued_token.clone();
        }

        Some(result)
    }

    /// Handle master's approval or denial.
    /// Returns the stable device ID only when this call newly approved and
    /// persisted a rotated credential. Callers use it to terminate sockets
    /// authenticated with the previous token.
    pub fn handle_approval(
        &self,
        approved: bool,
        pair_id: &str,
        owner_generation: uuid::Uuid,
    ) -> Result<Option<ApprovedPair>, String> {
        let _gate = self.credential_gate.lock().unwrap();
        let _owner = self
            .auth
            .guard_owner_generation(owner_generation)
            .map_err(|error| error.to_string())?;
        self.handle_approval_guarded(approved, pair_id)
    }

    pub(crate) fn handle_local_approval(
        &self,
        approved: bool,
        pair_id: &str,
    ) -> Result<Option<ApprovedPair>, String> {
        let _gate = self.credential_gate.lock().unwrap();
        let _owner = self.auth.guard_current_owner();
        self.handle_approval_guarded(approved, pair_id)
    }

    pub(crate) fn revoke_all_for_owner(
        &self,
        owner_generation: uuid::Uuid,
        new_token: String,
    ) -> Result<super::auth::OwnerRevokeAllOutcome, super::auth::OwnerMutationError> {
        let _gate = self.credential_gate.lock().unwrap();
        let outcome = self
            .auth
            .revoke_all_and_set_token_if_generation(owner_generation, new_token)?;
        self.bootstrap_tickets.clear();
        self.requests.lock().unwrap().clear();
        Ok(outcome)
    }

    pub(crate) fn revoke_all_for_local_owner(
        &self,
        new_token: String,
    ) -> Result<super::auth::OwnerRevokeAllOutcome, super::auth::OwnerMutationError> {
        let _gate = self.credential_gate.lock().unwrap();
        let owner_generation = self.auth.current_owner_generation();
        let outcome = self
            .auth
            .revoke_all_and_set_token_if_generation(owner_generation, new_token)?;
        self.bootstrap_tickets.clear();
        self.requests.lock().unwrap().clear();
        Ok(outcome)
    }

    fn handle_approval_guarded(
        &self,
        approved: bool,
        pair_id: &str,
    ) -> Result<Option<ApprovedPair>, String> {
        let mut requests = self.requests.lock().unwrap();
        let Some(req) = requests.get_mut(pair_id) else {
            return Err("pair request not found".to_string());
        };
        if req.status != "pending" {
            return Ok(None);
        }

        if approved {
            let issued = self.auth.issue_device_credential_with_proof(
                &req.device_id,
                &req.device_info,
                &req.proof_public_key,
            )?;
            let device_id = req.device_id.clone();
            req.status = "approved".to_string();
            req.issued_token = Some(issued.token);
            // Track paired device
            let device = PairedDevice {
                ip: req.remote_addr.clone(),
                device_info: req.device_info.clone(),
                paired_at: format!(
                    "{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs()
                ),
            };
            let ip = req.remote_addr.clone();
            drop(requests); // release lock before file I/O
            self.paired_devices
                .lock()
                .unwrap()
                .insert(ip.clone(), device);

            // Auto-unban if the IP was banned
            if self.ban_manager.is_banned(&ip) {
                self.ban_manager.unban(&ip);
            }
            return Ok(Some(ApprovedPair {
                device_id,
                retired_generation: issued.retired_generation,
            }));
        } else {
            req.status = "denied".to_string();
        }
        Ok(None)
    }

    /// List all paired devices.
    pub fn list_paired_devices(&self) -> Vec<PairedDevice> {
        self.paired_devices
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect()
    }

    /// Remove a paired device.
    pub fn remove_paired_device(&self, ip: &str) {
        self.paired_devices.lock().unwrap().remove(ip);
    }

    /// Clear all paired devices (called on revoke-all).
    pub fn clear_paired_devices(&self) {
        self.paired_devices.lock().unwrap().clear();
    }

    /// List pending requests (for master to see).
    pub fn list_pending(&self) -> Vec<PairRequestInfo> {
        self.requests
            .lock()
            .unwrap()
            .values()
            .filter(|r| r.status == "pending")
            .map(|r| PairRequestInfo {
                id: r.id.clone(),
                device_id: r.device_id.clone(),
                device_info: r.device_info.clone(),
                remote_addr: r.remote_addr.clone(),
            })
            .collect()
    }

    /// 标记某 nonce 已被认领(手机扫码配对成功后回传)。记录设备名(可选)+ 当前秒级时间戳。
    pub fn claim(&self, nonce: String, device_name: Option<String>) -> Result<(), String> {
        if nonce.len() < 16
            || nonce.len() > 128
            || !nonce
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("invalid nonce".to_string());
        }
        if let Some(name) = device_name.as_deref() {
            if name.len() > 128 || name.chars().any(char::is_control) {
                return Err("invalid device_name".to_string());
            }
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let mut claimed = self.claimed_nonces.lock().unwrap();
        claimed.retain(|_, (_, claimed_at)| now.saturating_sub(*claimed_at) <= 600);
        if !claimed.contains_key(&nonce) && claimed.len() >= MAX_CLAIMED_NONCES {
            if let Some(oldest) = claimed
                .iter()
                .min_by_key(|(_, (_, claimed_at))| *claimed_at)
                .map(|(nonce, _)| nonce.clone())
            {
                claimed.remove(&oldest);
            }
        }
        claimed.insert(nonce, (device_name, now));
        Ok(())
    }

    /// 查询某 nonce 是否已认领,返回 (claimed, device_name)。
    /// 顺带惰性清理超过 600s 的旧认领项,防无界增长。
    pub fn is_claimed(&self, nonce: &str) -> (bool, Option<String>) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let mut claimed = self.claimed_nonces.lock().unwrap();
        // 惰性清理:丢弃认领时间超过 600s 的项
        claimed.retain(|_, (_, claimed_at)| now.saturating_sub(*claimed_at) <= 600);
        match claimed.get(nonce) {
            Some((device_name, _)) => (true, device_name.clone()),
            None => (false, None),
        }
    }

    fn cleanup_expired(&self) {
        let mut requests = self.requests.lock().unwrap();
        retain_live_requests(&mut requests, Instant::now());
    }
}

fn retain_live_requests(requests: &mut HashMap<String, PairRequest>, now: Instant) {
    requests.retain(|_, request| {
        let age = now.duration_since(request.created_at);
        if age > Duration::from_secs(60) && request.status == "pending" {
            return false;
        }
        age <= Duration::from_secs(90)
    });
}

#[derive(serde::Serialize)]
pub struct PairRequestStatus {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

impl std::fmt::Debug for PairRequestStatus {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PairRequestStatus")
            .field("status", &self.status)
            .field("token", &self.token.as_ref().map(|_| "redacted"))
            .finish()
    }
}

#[derive(Debug, serde::Serialize)]
pub struct PairRequestInfo {
    pub id: String,
    pub device_id: String,
    pub device_info: String,
    pub remote_addr: String,
}

#[cfg(test)]
mod tests {
    use super::{ApprovedPair, BootstrapTickets, PairingManager};
    use crate::server::auth::Authenticator;
    use crate::server::ban::BanManager;
    use crate::server::events::EventBus;
    use crate::server::hook_secret::HookSecretRegistry;
    use crate::server::session::manager::SessionManager;
    use crate::server::session::SessionConfig;
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{header, HeaderValue};
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    use p256::ecdsa::signature::Signer as _;
    use p256::ecdsa::{Signature, SigningKey};
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn bootstrap_ticket_is_single_use() {
        let tickets = BootstrapTickets::new(Duration::from_secs(120));
        let ticket = tickets.issue();

        assert_eq!(ticket.len(), 43);
        assert_eq!(tickets.redeem(&ticket, || Ok("issued")).unwrap(), "issued");
        assert!(tickets.redeem(&ticket, || Ok("again")).is_err());
    }

    #[test]
    fn bootstrap_ticket_rejects_malformed_and_noncanonical_values() {
        let tickets = BootstrapTickets::new(Duration::from_secs(120));
        let ticket = tickets.issue();
        let padded = format!("{ticket}=");
        let mut noncanonical = ticket.clone().into_bytes();
        noncanonical[42] = b'B';
        let noncanonical = String::from_utf8(noncanonical).unwrap();

        assert!(tickets.redeem(&padded, || Ok("padded")).is_err());
        assert!(tickets.redeem(&ticket[..42], || Ok("truncated")).is_err());
        assert!(tickets
            .redeem(&noncanonical, || Ok("noncanonical"))
            .is_err());

        // Invalid attempts must not consume the valid one-time ticket.
        assert_eq!(tickets.redeem(&ticket, || Ok("issued")).unwrap(), "issued");
    }

    #[test]
    fn bootstrap_ticket_expires() {
        let tickets = BootstrapTickets::new(Duration::from_millis(1));
        let ticket = tickets.issue();
        std::thread::sleep(Duration::from_millis(5));

        assert!(tickets.redeem(&ticket, || Ok("too late")).is_err());
    }

    fn manager(auth: Arc<Authenticator>) -> Arc<PairingManager> {
        let sessions = SessionManager::new(
            SessionConfig {
                session_ttl: Duration::from_secs(300),
                reconnect_grace: Duration::from_secs(60),
                ring_buffer_size: 256 * 1024,
                log_dir: String::new(),
            },
            EventBus::new(),
            HookSecretRegistry::new(),
        );
        let manager = PairingManager::new(auth, sessions, Arc::new(BanManager::new(None)));
        manager.set_lan_pairing_enabled(true);
        manager
    }

    fn proof(device_id: &str, device_name: &str, context: &str) -> (String, String) {
        let signing = SigningKey::from_bytes((&[13u8; 32]).into()).unwrap();
        let public = signing.verifying_key().to_encoded_point(false);
        let message = format!("MeTerm-Pair-v1\n{device_id}\n{device_name}\n{context}");
        let signature: Signature = signing.sign(message.as_bytes());
        (
            URL_SAFE_NO_PAD.encode(public.as_bytes()),
            URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        )
    }

    fn create_request(
        manager: &PairingManager,
        device_name: &str,
        device_id: &str,
        remote_addr: &str,
    ) -> Result<(String, String), String> {
        let (public_key, signature) = proof(device_id, device_name, "approval");
        manager.create_request(device_name, device_id, remote_addr, &public_key, &signature)
    }

    fn redeem_bootstrap(
        manager: &PairingManager,
        ticket: &str,
        device_id: &str,
        device_name: &str,
    ) -> Result<crate::server::device_auth::IssuedDeviceCredential, String> {
        let (public_key, signature) = proof(device_id, device_name, ticket);
        manager.redeem_bootstrap_ticket(ticket, device_id, device_name, &public_key, &signature)
    }

    fn owner_generation(auth: &Authenticator, token: &str) -> uuid::Uuid {
        let mut request = Request::new(Body::empty());
        request.headers_mut().insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        auth.authenticate_request(&request)
            .unwrap()
            .owner_generation()
            .unwrap()
    }

    fn token_authenticates(auth: &Authenticator, token: &str) -> bool {
        let mut request = Request::new(Body::empty());
        request.headers_mut().insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        auth.authenticate_request(&request).is_some()
    }

    fn device_generation(auth: &Authenticator, token: &str) -> uuid::Uuid {
        let mut request = Request::new(Body::empty());
        request.headers_mut().insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        match auth.authenticate_request(&request).unwrap() {
            crate::server::auth::AuthPrincipal::Device { generation, .. } => generation,
            crate::server::auth::AuthPrincipal::Owner { .. } => {
                panic!("device token authenticated as owner")
            }
        }
    }

    #[tokio::test]
    async fn approved_pair_returns_same_device_token_on_retry() {
        let auth = Arc::new(Authenticator::new("owner-secret".to_string()));
        let manager = manager(auth.clone());
        let generation = owner_generation(&auth, "owner-secret");
        let (pair_id, secret) =
            create_request(&manager, "Alice Phone", "device-1", "192.0.2.10").unwrap();
        assert_eq!(
            manager.handle_approval(true, &pair_id, generation).unwrap(),
            Some(ApprovedPair {
                device_id: "device-1".to_string(),
                retired_generation: None,
            })
        );
        assert_eq!(
            manager.handle_approval(true, &pair_id, generation).unwrap(),
            None
        );

        let first = manager.get_request(&pair_id, &secret).unwrap();
        let second = manager.get_request(&pair_id, &secret).unwrap();
        assert_eq!(first.status, "approved");
        assert_eq!(first.token, second.token);
        assert_ne!(first.token.as_deref(), Some(auth.get_token().as_str()));
        assert!(first.token.unwrap().starts_with("mtd_"));
    }

    #[tokio::test]
    async fn retired_owner_generation_cannot_approve_pair() {
        let old_token = "A".repeat(32);
        let auth = Arc::new(Authenticator::new(old_token.clone()));
        let manager = manager(auth.clone());
        let old_generation = owner_generation(&auth, &old_token);
        let (pair_id, secret) =
            create_request(&manager, "Alice Phone", "device-1", "192.0.2.10").unwrap();

        auth.set_token("B".repeat(32)).unwrap();
        assert_eq!(
            manager
                .handle_approval(true, &pair_id, old_generation)
                .unwrap_err(),
            "owner credential revoked"
        );
        let status = manager.get_request(&pair_id, &secret).unwrap();
        assert_eq!(status.status, "pending");
        assert!(status.token.is_none());
    }

    #[tokio::test]
    async fn repairing_reports_only_the_retired_device_generation() {
        let owner_token = "A".repeat(32);
        let auth = Arc::new(Authenticator::new(owner_token.clone()));
        let manager = manager(auth.clone());
        let owner_generation = owner_generation(&auth, &owner_token);
        let (first_id, first_secret) =
            create_request(&manager, "Alice Phone", "device-1", "192.0.2.10").unwrap();
        manager
            .handle_approval(true, &first_id, owner_generation)
            .unwrap();
        let first_token = manager
            .get_request(&first_id, &first_secret)
            .unwrap()
            .token
            .unwrap();
        let retired_generation = device_generation(&auth, &first_token);

        let (second_id, _) =
            create_request(&manager, "Alice Phone", "device-1", "192.0.2.11").unwrap();
        let rotation = manager
            .handle_approval(true, &second_id, owner_generation)
            .unwrap()
            .unwrap();

        assert_eq!(rotation.device_id, "device-1");
        assert_eq!(rotation.retired_generation, Some(retired_generation));
        assert!(auth
            .authenticate_request(&{
                let mut request = Request::new(Body::empty());
                request.headers_mut().insert(
                    header::AUTHORIZATION,
                    HeaderValue::from_str(&format!("Bearer {first_token}")).unwrap(),
                );
                request
            })
            .is_none());
    }

    #[tokio::test]
    async fn pair_poll_rejects_malformed_id_and_secret_without_consuming_request() {
        let auth = Arc::new(Authenticator::new("owner-secret".to_string()));
        let manager = manager(auth);
        let (pair_id, secret) =
            create_request(&manager, "Alice Phone", "device-1", "192.0.2.10").unwrap();

        assert!(manager.get_request("not-a-uuid", &secret).is_none());
        assert!(manager.get_request(&pair_id, &secret[..42]).is_none());
        assert_eq!(
            manager.get_request(&pair_id, &secret).unwrap().status,
            "pending"
        );
    }

    #[tokio::test]
    async fn qr_bootstrap_redeems_once_to_device_token() {
        let auth = Arc::new(Authenticator::new("owner-secret".to_string()));
        let manager = manager(auth);
        let ticket = manager.create_bootstrap_ticket().unwrap();

        let issued = redeem_bootstrap(&manager, &ticket, "device-1", "Alice Phone").unwrap();
        assert!(issued.token.starts_with("mtd_"));
        assert_eq!(issued.retired_generation, None);
        assert!(redeem_bootstrap(&manager, &ticket, "device-1", "Alice Phone").is_err());
    }

    #[tokio::test]
    async fn bootstrap_redeem_racing_revoke_all_leaves_no_device_credential() {
        let old_token = "A".repeat(32);
        let new_token = "B".repeat(32);
        let auth = Arc::new(Authenticator::new(old_token.clone()));
        let manager = manager(auth.clone());
        let generation = owner_generation(&auth, &old_token);
        let ticket = manager.create_bootstrap_ticket().unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(2));

        let redeem_manager = manager.clone();
        let redeem_barrier = barrier.clone();
        let redeem = std::thread::spawn(move || {
            redeem_barrier.wait();
            redeem_bootstrap(&redeem_manager, &ticket, "device-1", "Alice Phone")
        });
        barrier.wait();
        let outcome = manager
            .revoke_all_for_owner(generation, new_token.clone())
            .unwrap();
        let issued = redeem.join().unwrap();

        assert!(outcome.devices_revoked);
        if let Ok(issued) = issued {
            assert!(!token_authenticates(&auth, &issued.token));
        }
        assert!(!token_authenticates(&auth, &old_token));
        assert!(token_authenticates(&auth, &new_token));
    }

    #[tokio::test]
    async fn revoke_all_invalidates_existing_ticket_and_pending_request() {
        let old_token = "A".repeat(32);
        let auth = Arc::new(Authenticator::new(old_token.clone()));
        let manager = manager(auth.clone());
        let generation = owner_generation(&auth, &old_token);
        let ticket = manager.create_bootstrap_ticket().unwrap();
        let (pair_id, secret) =
            create_request(&manager, "Alice Phone", "device-1", "192.0.2.10").unwrap();

        manager
            .revoke_all_for_owner(generation, "B".repeat(32))
            .unwrap();

        assert!(redeem_bootstrap(&manager, &ticket, "device-1", "Alice Phone").is_err());
        assert!(manager.get_request(&pair_id, &secret).is_none());
    }

    #[tokio::test]
    async fn local_revoke_all_uses_same_gate_and_invalidates_pairing_state() {
        let old_token = "A".repeat(32);
        let new_token = "B".repeat(32);
        let auth = Arc::new(Authenticator::new(old_token.clone()));
        let manager = manager(auth.clone());
        let ticket = manager.create_bootstrap_ticket().unwrap();
        let (pair_id, secret) =
            create_request(&manager, "Alice Phone", "device-1", "192.0.2.10").unwrap();
        let device_token = auth
            .issue_device_token("existing-device", "Existing Phone")
            .unwrap();

        let outcome = manager
            .revoke_all_for_local_owner(new_token.clone())
            .unwrap();

        assert!(outcome.devices_revoked);
        assert!(!token_authenticates(&auth, &old_token));
        assert!(token_authenticates(&auth, &new_token));
        assert!(!token_authenticates(&auth, &device_token));
        assert!(redeem_bootstrap(&manager, &ticket, "new-device", "New Phone").is_err());
        assert!(manager.get_request(&pair_id, &secret).is_none());
    }

    #[tokio::test]
    async fn lan_disable_stops_issuance_and_clears_all_pending_pairing_state() {
        let auth = Arc::new(Authenticator::new("owner-secret".to_string()));
        let manager = manager(auth);
        let ticket = manager.create_bootstrap_ticket().unwrap();
        let (pair_id, secret) =
            create_request(&manager, "Alice Phone", "device-1", "192.0.2.10").unwrap();

        manager.set_lan_pairing_enabled(false);

        assert!(manager.create_bootstrap_ticket().is_err());
        assert!(redeem_bootstrap(&manager, &ticket, "device-1", "Alice Phone").is_err());
        assert!(manager.get_request(&pair_id, &secret).is_none());
        assert!(create_request(&manager, "Bob Phone", "device-2", "192.0.2.11").is_err());

        manager.set_lan_pairing_enabled(true);
        assert!(manager.create_bootstrap_ticket().is_ok());
    }
}
