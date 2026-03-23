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
    pub fn set_discoverable(&self, enabled: bool, port: Option<u16>, name: Option<&str>) -> Result<(), String> {
        eprintln!("[mdns] set_discoverable: enabled={} port={:?} name={:?}", enabled, port, name);
        if let Some(p) = port {
            *self.port.lock().unwrap() = p;
        }
        let current_port = *self.port.lock().unwrap();

        if enabled {
            if *self.registered.lock().unwrap() {
                eprintln!("[mdns] already registered, skipping");
                return Ok(());
            }

            let display_name = name.unwrap_or(&self.hostname);
            eprintln!("[mdns] registering service: name={} port={}", display_name, current_port);
            let service_info = ServiceInfo::new(
                SERVICE_TYPE,
                display_name,
                &format!("{}.local.", self.hostname),
                "",
                current_port,
                None,
            )
            .map_err(|e| {
                eprintln!("[mdns] ServiceInfo creation failed: {}", e);
                format!("service info: {}", e)
            })?
            .enable_addr_auto();

            self.daemon
                .register(service_info)
                .map_err(|e| {
                    eprintln!("[mdns] register failed: {}", e);
                    format!("register: {}", e)
                })?;

            *self.registered.lock().unwrap() = true;
            eprintln!("[mdns] Registered: {}.{} port={}", display_name, SERVICE_TYPE, current_port);
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
        eprintln!("[mdns] starting browse for {}", SERVICE_TYPE);
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
                    match &event {
                        ServiceEvent::ServiceFound(svc_type, name) => {
                            eprintln!("[mdns] found: {} {}", svc_type, name);
                        }
                        ServiceEvent::ServiceResolved(info) => {
                            let port = info.get_port();
                            let addrs = info.get_addresses();

                            // Prefer IPv4 over IPv6
                            let host = addrs.iter()
                                .find(|a| a.is_ipv4())
                                .or_else(|| addrs.iter().next())
                                .map(|a| a.to_string())
                                .unwrap_or_default();

                            eprintln!("[mdns] resolved: {} host={} port={} (addrs={:?})", info.get_fullname(), host, port, addrs);

                            // Filter out self: check if ANY address is local
                            let is_self = port == my_port && addrs.iter().any(|a| local_ips.contains(&a.to_string()));
                            if is_self {
                                eprintln!("[mdns] skipping self");
                                continue;
                            }

                            // Extract instance name from fullname (strip "._meterm._tcp.local.")
                            let fullname = info.get_fullname().to_string();
                            let instance_name = fullname
                                .strip_suffix(&format!(".{}", SERVICE_TYPE))
                                .unwrap_or(&fullname)
                                .to_string();

                            if services.iter().any(|s: &DiscoveredService| s.name == instance_name) {
                                continue;
                            }

                            if services.len() < 50 {
                                services.push(DiscoveredService {
                                    name: instance_name,
                                    host,
                                    port,
                                });
                            }
                        }
                        ServiceEvent::ServiceRemoved(svc_type, name) => {
                            eprintln!("[mdns] removed: {} {}", svc_type, name);
                        }
                        other => {
                            eprintln!("[mdns] event: {:?}", other);
                        }
                    }
                }
                Ok(Ok(Err(_))) => continue, // recv_timeout timed out
                Ok(Err(e)) => {
                    eprintln!("[mdns] spawn_blocking error: {}", e);
                    break;
                }
                Err(_) => break, // overall timeout
            }
        }

        // Stop browsing
        let _ = self.daemon.stop_browse(SERVICE_TYPE);
        eprintln!("[mdns] browse complete: {} services found", services.len());
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
