//! mDNS service discovery — mirrors Go `api/discover.go`.
//!
//! Uses mdns-sd crate for _meterm._tcp service registration and scanning.

use std::sync::Mutex;
use std::time::Duration;

use mdns_sd::{ServiceDaemon, ServiceInfo, ServiceEvent};

const SERVICE_TYPE: &str = "_meterm._tcp.local.";

/// Manages mDNS service registration and LAN discovery.
pub struct DiscoveryManager {
    daemon: ServiceDaemon,
    port: Mutex<u16>,
    hostname: String,
    registered: Mutex<bool>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DiscoveredService {
    pub name: String,
    pub host: String,
    pub port: u16,
}

impl DiscoveryManager {
    pub fn new(port: u16) -> Result<Self, String> {
        let daemon = ServiceDaemon::new().map_err(|e| format!("mdns daemon: {}", e))?;
        let hostname = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "meterm".to_string());
        Ok(Self {
            daemon,
            port: Mutex::new(port),
            hostname,
            registered: Mutex::new(false),
        })
    }

    /// Enable or disable mDNS service registration.
    pub fn set_discoverable(&self, enabled: bool, port: Option<u16>) -> Result<(), String> {
        if let Some(p) = port {
            *self.port.lock().unwrap() = p;
        }
        let current_port = *self.port.lock().unwrap();

        if enabled {
            if *self.registered.lock().unwrap() {
                return Ok(()); // already registered
            }

            let service_info = ServiceInfo::new(
                SERVICE_TYPE,
                &self.hostname,
                &format!("{}.", self.hostname),
                "",
                current_port,
                None,
            )
            .map_err(|e| format!("service info: {}", e))?;

            self.daemon
                .register(service_info)
                .map_err(|e| format!("register: {}", e))?;

            *self.registered.lock().unwrap() = true;
            eprintln!("[mdns] Registered: {}.{} port={}", self.hostname, SERVICE_TYPE, current_port);
        } else {
            if !*self.registered.lock().unwrap() {
                return Ok(());
            }
            let fullname = format!("{}.{}", self.hostname, SERVICE_TYPE);
            let _ = self.daemon.unregister(&fullname);
            *self.registered.lock().unwrap() = false;
            eprintln!("[mdns] Unregistered");
        }
        Ok(())
    }

    pub fn is_discoverable(&self) -> bool {
        *self.registered.lock().unwrap()
    }

    /// Scan for MeTerm services on the LAN.
    pub async fn discover(&self, timeout_secs: u64) -> Vec<DiscoveredService> {
        let receiver = match self.daemon.browse(SERVICE_TYPE) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[mdns] browse failed: {}", e);
                return Vec::new();
            }
        };

        let my_port = *self.port.lock().unwrap();
        let local_ips = get_local_ips();
        let mut services = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);

        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }

            match tokio::time::timeout(remaining, tokio::task::spawn_blocking({
                let receiver = receiver.clone();
                move || receiver.recv_timeout(Duration::from_millis(500))
            })).await {
                Ok(Ok(Ok(event))) => {
                    if let ServiceEvent::ServiceResolved(info) = event {
                        let port = info.get_port();
                        let host = info.get_addresses()
                            .iter()
                            .next()
                            .map(|a| a.to_string())
                            .unwrap_or_default();

                        // Filter out self
                        if port == my_port && local_ips.contains(&host) {
                            continue;
                        }

                        if services.len() < 50 {
                            services.push(DiscoveredService {
                                name: info.get_fullname().to_string(),
                                host,
                                port,
                            });
                        }
                    }
                }
                _ => continue,
            }
        }

        // Stop browsing
        let _ = self.daemon.stop_browse(SERVICE_TYPE);
        services
    }
}

fn get_local_ips() -> Vec<String> {
    local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .map(|(_, ip)| ip.to_string())
        .collect()
}
