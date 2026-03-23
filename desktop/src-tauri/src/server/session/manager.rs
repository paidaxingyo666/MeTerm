//! Session manager — mirrors Go `session/manager.go`.
//!
//! Maintains the set of active sessions and runs a periodic reaper
//! that cleans up expired clients and sessions.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use super::{Session, SessionConfig};
use super::client::ClientInfo;
use super::state::SessionState;

/// Aggregated device info (grouped by IP).
#[derive(Debug, Clone, serde::Serialize)]
pub struct DeviceInfo {
    pub ip: String,
    pub name: String,
    pub sessions: Vec<ClientInfo>,
    pub count: usize,
}

/// Manages all active sessions and runs the reaper.
pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    config: SessionConfig,
    cancel: CancellationToken,
}

impl SessionManager {
    pub fn new(config: SessionConfig) -> Arc<Self> {
        let mgr = Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            config,
            cancel: CancellationToken::new(),
        });

        // Start the reaper task
        let mgr_weak = Arc::downgrade(&mgr);
        let cancel = mgr.cancel.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(10));
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = interval.tick() => {
                        if let Some(mgr) = mgr_weak.upgrade() {
                            mgr.reap();
                        } else {
                            break;
                        }
                    }
                }
            }
        });

        mgr
    }

    /// Create a new session. Returns the session ID.
    pub fn create(&self) -> Arc<Session> {
        let id = uuid::Uuid::new_v4().to_string();
        let session = Arc::new(Session::new(id.clone(), self.config.clone()));
        self.sessions.lock().unwrap().insert(id, session.clone());
        session
    }

    /// Get a session by ID.
    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }

    /// List all sessions.
    pub fn list(&self) -> Vec<Arc<Session>> {
        self.sessions.lock().unwrap().values().cloned().collect()
    }

    /// Delete a session by ID.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| "session not found".to_string())?;
        session.cancel();
        Ok(())
    }

    /// List all clients across all sessions.
    /// List all remote clients across all sessions (excludes local IPC clients).
    pub fn list_all_clients(&self) -> Vec<ClientInfo> {
        let sessions = self.sessions.lock().unwrap();
        let mut all = Vec::new();
        for session in sessions.values() {
            all.extend(
                session.list_clients().into_iter()
                    .filter(|c| !c.remote_addr.starts_with("ipc://")),
            );
        }
        all
    }

    /// List devices grouped by IP (excluding loopback).
    pub fn list_devices(&self) -> Vec<DeviceInfo> {
        let all_clients = self.list_all_clients();
        let mut by_ip: HashMap<String, Vec<ClientInfo>> = HashMap::new();
        for client in all_clients {
            let ip = client.remote_addr.clone();
            if ip.is_empty() || ip == "127.0.0.1" || ip == "::1" || ip.starts_with("ipc://") {
                continue;
            }
            by_ip.entry(ip).or_default().push(client);
        }
        by_ip
            .into_iter()
            .map(|(ip, sessions)| DeviceInfo {
                count: sessions.len(),
                name: ip.clone(),
                ip,
                sessions,
            })
            .collect()
    }

    /// Kick all clients from a specific IP across all sessions.
    pub fn kick_by_ip(&self, ip: &str) -> usize {
        let sessions = self.sessions.lock().unwrap();
        let mut total = 0;
        for session in sessions.values() {
            total += session.kick_by_ip(ip);
        }
        total
    }

    /// Disconnect all remote (non-loopback) clients across all sessions.
    /// Sends ERR_KICKED and promotes next master if the master was kicked.
    pub fn disconnect_all_clients(&self) -> usize {
        let sessions = self.sessions.lock().unwrap();
        let mut total = 0;
        for session in sessions.values() {
            total += session.disconnect_remote_clients();
        }
        total
    }

    /// Stop the manager and close all sessions.
    pub fn stop(&self) {
        self.cancel.cancel();
        let sessions: Vec<Arc<Session>> = self.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
        for session in sessions {
            session.cancel();
        }
    }

    /// Periodic reaper — expire disconnected clients and close timed-out sessions.
    fn reap(&self) {
        let now = Instant::now();
        let grace = self.config.reconnect_grace;

        let session_list: Vec<Arc<Session>> = self.sessions.lock().unwrap().values().cloned().collect();

        let mut to_remove = Vec::new();

        for session in &session_list {
            // Expire disconnected clients past grace period
            let expired = session.expired_disconnected_clients(now, grace);
            for client_id in expired {
                session.expire_client(&client_id);
            }

            // Check if session should be closed by TTL
            if session.should_close_by_ttl(now) {
                session.cancel();
                to_remove.push(session.id.clone());
            }

            // Also remove fully closed sessions
            let state = *session.state.lock().unwrap();
            if state == SessionState::Closed {
                to_remove.push(session.id.clone());
            }
        }

        if !to_remove.is_empty() {
            let mut sessions = self.sessions.lock().unwrap();
            for id in to_remove {
                sessions.remove(&id);
            }
        }
    }

    /// Get session config.
    pub fn config(&self) -> &SessionConfig {
        &self.config
    }
}
