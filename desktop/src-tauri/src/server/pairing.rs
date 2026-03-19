//! Device pairing manager — mirrors Go `api/pairing.go`.
//!
//! Manages pending pairing requests with TTL, rate limiting, and approval flow.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use super::auth::Authenticator;
use super::ban::BanManager;
use super::protocol;
use super::session::manager::SessionManager;

/// A pending pairing request.
#[derive(Debug, Clone)]
pub struct PairRequest {
    pub id: String,
    pub device_info: String,
    pub remote_addr: String,
    pub status: String, // "pending" | "approved" | "denied" | "expired"
    pub created_at: Instant,
    pub creator_ip: String,
    pub secret: String,
}

/// A device that has been approved for pairing.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PairedDevice {
    pub ip: String,
    pub device_info: String,
    pub paired_at: String,
}

pub struct PairingManager {
    requests: Mutex<HashMap<String, PairRequest>>,
    paired_devices: Mutex<HashMap<String, PairedDevice>>,
    rate_limits: Mutex<HashMap<String, Vec<Instant>>>,
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

        let times = limits.entry(ip.to_string()).or_default();
        times.retain(|t| *t > cutoff);

        if times.len() >= 5 {
            return false;
        }
        times.push(now);
        true
    }

    /// Create a new pairing request and notify all masters.
    pub fn create_request(&self, device_info: &str, remote_addr: &str) -> Result<(String, String), String> {
        if !self.check_rate_limit(remote_addr) {
            return Err("rate limit exceeded".to_string());
        }

        let id = uuid::Uuid::new_v4().to_string();
        let secret = super::generate_token();

        let req = PairRequest {
            id: id.clone(),
            device_info: device_info.to_string(),
            remote_addr: remote_addr.to_string(),
            status: "pending".to_string(),
            created_at: Instant::now(),
            creator_ip: remote_addr.to_string(),
            secret: secret.clone(),
        };

        self.requests.lock().unwrap().insert(id.clone(), req);

        // Notify all master clients
        let notify_msg = protocol::encode_pair_notify(&id, device_info, remote_addr);
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
        let requests = self.requests.lock().unwrap();
        let req = requests.get(id)?;

        // Verify secret
        if req.secret != secret {
            return None;
        }

        let mut result = PairRequestStatus {
            status: req.status.clone(),
            token: None,
        };

        // If approved, return the auth token
        if req.status == "approved" {
            result.token = Some(self.auth.get_token());
        }

        Some(result)
    }

    /// Handle master's approval or denial.
    pub fn handle_approval(&self, approved: bool, pair_id: &str) {
        let mut requests = self.requests.lock().unwrap();
        let Some(req) = requests.get_mut(pair_id) else {
            return;
        };
        if req.status != "pending" {
            return;
        }

        if approved {
            req.status = "approved".to_string();
            // Track paired device
            let device = PairedDevice {
                ip: req.remote_addr.clone(),
                device_info: req.device_info.clone(),
                paired_at: format!("{}", std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()),
            };
            let ip = req.remote_addr.clone();
            drop(requests); // release lock before file I/O
            self.paired_devices.lock().unwrap().insert(ip.clone(), device);

            // Auto-unban if the IP was banned
            if self.ban_manager.is_banned(&ip) {
                self.ban_manager.unban(&ip);
            }
        } else {
            req.status = "denied".to_string();
        }
    }

    /// List all paired devices.
    pub fn list_paired_devices(&self) -> Vec<PairedDevice> {
        self.paired_devices.lock().unwrap().values().cloned().collect()
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
                device_info: r.device_info.clone(),
                remote_addr: r.remote_addr.clone(),
            })
            .collect()
    }

    fn cleanup_expired(&self) {
        let mut requests = self.requests.lock().unwrap();
        let now = Instant::now();
        requests.retain(|_, req| {
            let age = now.duration_since(req.created_at);
            if age > Duration::from_secs(60) && req.status == "pending" {
                return false; // expired pending
            }
            age <= Duration::from_secs(90) // keep approved/denied for 90s
        });
    }
}

#[derive(Debug, serde::Serialize)]
pub struct PairRequestStatus {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct PairRequestInfo {
    pub id: String,
    pub device_info: String,
    pub remote_addr: String,
}
