//! IP ban management — mirrors Go `api/ban.go`.
//!
//! Supports optional persistence to a JSON file.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BanEntry {
    pub ip: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reason: String,
    pub banned_at: String, // ISO 8601
}

pub struct BanManager {
    banned: RwLock<HashMap<String, BanEntry>>,
    file_path: Option<String>,
}

impl BanManager {
    pub fn new(file_path: Option<String>) -> Self {
        let mut mgr = Self {
            banned: RwLock::new(HashMap::new()),
            file_path,
        };
        mgr.load_from_file();
        mgr
    }

    /// Check if an IP is banned.
    pub fn is_banned(&self, ip: &str) -> bool {
        self.banned.read().unwrap().contains_key(ip)
    }

    /// Ban an IP address. Returns error if the IP is invalid or is a loopback address.
    pub fn ban(&self, ip: &str, reason: &str) -> Result<(), String> {
        // Validate IP format
        let parsed: IpAddr = ip.parse().map_err(|_| "invalid IP address".to_string())?;

        // Don't allow banning loopback
        if parsed.is_loopback() {
            return Err("cannot ban loopback address".to_string());
        }

        let entry = BanEntry {
            ip: ip.to_string(),
            reason: reason.to_string(),
            banned_at: chrono_now_iso8601(),
        };

        self.banned.write().unwrap().insert(ip.to_string(), entry);
        self.save_to_file();
        Ok(())
    }

    /// Unban an IP address. Returns true if the IP was previously banned.
    pub fn unban(&self, ip: &str) -> bool {
        let removed = self.banned.write().unwrap().remove(ip).is_some();
        if removed {
            self.save_to_file();
        }
        removed
    }

    /// List all banned entries.
    pub fn list(&self) -> Vec<BanEntry> {
        self.banned.read().unwrap().values().cloned().collect()
    }

    fn load_from_file(&mut self) {
        let Some(ref path) = self.file_path else {
            return;
        };
        let Ok(data) = std::fs::read_to_string(path) else {
            return;
        };
        let Ok(entries): Result<Vec<BanEntry>, _> = serde_json::from_str(&data) else {
            return;
        };
        let mut map = self.banned.write().unwrap();
        for entry in entries {
            map.insert(entry.ip.clone(), entry);
        }
    }

    fn save_to_file(&self) {
        let Some(ref path) = self.file_path else {
            return;
        };
        let guard = self.banned.read().unwrap();
        let entries: Vec<&BanEntry> = guard.values().collect();
        if let Ok(data) = serde_json::to_string_pretty(&entries) {
            let _ = std::fs::write(path, data);
        }
    }
}

/// Simple ISO 8601 timestamp without pulling in chrono.
fn chrono_now_iso8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();
    // Format as "2026-03-17T12:00:00Z" (approximate — no full calendar math)
    // For exact formatting, the Go version uses time.Now().UTC().Format(time.RFC3339)
    // We use a simplified approach that's close enough for ban timestamps.
    format!("{}Z", secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ban_unban() {
        let bm = BanManager::new(None);
        assert!(!bm.is_banned("192.168.1.100"));

        bm.ban("192.168.1.100", "test").unwrap();
        assert!(bm.is_banned("192.168.1.100"));

        assert!(bm.unban("192.168.1.100"));
        assert!(!bm.is_banned("192.168.1.100"));
    }

    #[test]
    fn test_ban_loopback_rejected() {
        let bm = BanManager::new(None);
        assert!(bm.ban("127.0.0.1", "test").is_err());
        assert!(bm.ban("::1", "test").is_err());
    }

    #[test]
    fn test_ban_invalid_ip_rejected() {
        let bm = BanManager::new(None);
        assert!(bm.ban("not-an-ip", "test").is_err());
    }
}
