//! mDNS service discovery.
//!
//! macOS publishes through the system Bonjour daemon so MeTerm never competes
//! with `mDNSResponder` for the Mac's hostname. Other platforms publish with
//! `mdns-sd`; browsing remains portable on every platform.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

#[cfg(any(not(target_os = "macos"), test))]
use mdns_sd::ServiceInfo;
#[cfg(not(target_os = "macos"))]
use mdns_sd::UnregisterStatus;
use mdns_sd::{ServiceDaemon, ServiceEvent};

#[cfg(target_os = "macos")]
mod macos_bonjour;

const SERVICE_TYPE: &str = "_meterm._tcp.local.";

/// Manages mDNS service registration and LAN discovery.
pub struct DiscoveryManager {
    #[cfg(not(target_os = "macos"))]
    daemon: ServiceDaemon,
    port: Mutex<u16>,
    hostname: String,
    registered: Mutex<Option<ActiveRegistration>>,
    /// 稳定设备 ID,写入 TXT 记录(`id=<uuid>`),供手机按 ID(而非 host:port)重发现同一台桌面。
    device_id: String,
    /// 自签 TLS 证书指纹(SHA256 hex),写入 TXT 记录(`fp=<sha256>`),供手机钉死信任(设计稿 §4)。
    /// 空串(未启用 TLS)时不写该 TXT 键。
    cert_fp: String,
}

enum ActiveRegistration {
    #[cfg(target_os = "macos")]
    SystemBonjour(macos_bonjour::BonjourRegistration),
    #[cfg(not(target_os = "macos"))]
    Portable(String),
}

impl ActiveRegistration {
    fn is_active(&self) -> bool {
        match self {
            #[cfg(target_os = "macos")]
            Self::SystemBonjour(registration) => registration.is_active(),
            #[cfg(not(target_os = "macos"))]
            Self::Portable(_) => true,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DiscoveredService {
    pub name: String,
    pub host: String,
    pub port: u16,
}

impl DiscoveryManager {
    pub fn new(port: u16, device_id: String, cert_fp: String) -> Result<Self, String> {
        #[cfg(not(target_os = "macos"))]
        let daemon = ServiceDaemon::new().map_err(|e| format!("mdns daemon: {}", e))?;
        let hostname = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "meterm".to_string());
        Ok(Self {
            #[cfg(not(target_os = "macos"))]
            daemon,
            port: Mutex::new(port),
            hostname,
            registered: Mutex::new(None),
            device_id,
            cert_fp,
        })
    }

    /// Enable or disable mDNS service registration.
    pub fn set_discoverable(
        &self,
        enabled: bool,
        port: Option<u16>,
        name: Option<&str>,
    ) -> Result<(), String> {
        eprintln!(
            "[mdns] set_discoverable: enabled={} port={:?} name={:?}",
            enabled, port, name
        );
        if let Some(p) = port {
            *self.port.lock().unwrap() = p;
        }
        let current_port = *self.port.lock().unwrap();

        if enabled {
            let mut registered = self.registered.lock().unwrap();
            if registered
                .as_ref()
                .is_some_and(ActiveRegistration::is_active)
            {
                eprintln!("[mdns] already registered, skipping");
                return Ok(());
            }
            if registered.take().is_some() {
                eprintln!("[mdns] replacing inactive registration");
            }

            let display_name = name.unwrap_or(&self.hostname);
            validate_service_instance_name(display_name)?;
            eprintln!(
                "[mdns] registering service: name={} port={} id={} fp={}",
                display_name, current_port, self.device_id, self.cert_fp
            );
            // TXT 记录带稳定设备 ID:手机重发现时按 id 匹配同一台桌面,而非依赖会漂移的 host:port。
            let mut properties = HashMap::new();
            properties.insert("id".to_string(), self.device_id.clone());
            // TLS 证书指纹:供手机钉死信任(设计稿 §4)。未启用 TLS(空串)时不写此键。
            if !self.cert_fp.is_empty() {
                properties.insert("fp".to_string(), self.cert_fp.clone());
            }

            #[cfg(target_os = "macos")]
            {
                let registration = macos_bonjour::BonjourRegistration::register(
                    display_name,
                    current_port,
                    &properties,
                )
                .map_err(|error| {
                    eprintln!("[mdns] system Bonjour register failed: {error}");
                    error
                })?;
                *registered = Some(ActiveRegistration::SystemBonjour(registration));
            }

            #[cfg(not(target_os = "macos"))]
            {
                let service_info =
                    build_service_info(display_name, &self.hostname, current_port, properties)?;
                let fullname = service_info.get_fullname().to_string();
                self.daemon.register(service_info).map_err(|e| {
                    eprintln!("[mdns] register failed: {}", e);
                    format!("register: {}", e)
                })?;
                *registered = Some(ActiveRegistration::Portable(fullname));
            }
            eprintln!(
                "[mdns] Registered: {}.{} port={}",
                display_name, SERVICE_TYPE, current_port
            );
        } else {
            let mut registered = self.registered.lock().unwrap();

            #[cfg(target_os = "macos")]
            {
                let Some(active_registration) = registered.take() else {
                    return Ok(());
                };
                let ActiveRegistration::SystemBonjour(registration) = active_registration;
                registration.shutdown();
            }

            #[cfg(not(target_os = "macos"))]
            {
                let Some(ActiveRegistration::Portable(fullname)) = registered.as_ref() else {
                    return Ok(());
                };
                let fullname = fullname.clone();
                let status = self
                    .daemon
                    .unregister(&fullname)
                    .map_err(|e| format!("unregister {fullname}: {e}"))?
                    .recv_timeout(Duration::from_secs(2))
                    .map_err(|e| format!("unregister {fullname} status: {e}"))?;
                match status {
                    UnregisterStatus::OK => {}
                    UnregisterStatus::NotFound => {
                        // The daemon confirms there is no such live registration,
                        // which is already the desired non-discoverable state.
                        eprintln!("[mdns] unregister converged: service was already absent");
                    }
                }
                *registered = None;
            }
            eprintln!("[mdns] Unregistered");
        }
        Ok(())
    }

    pub fn is_discoverable(&self) -> bool {
        self.registered
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(ActiveRegistration::is_active)
    }

    /// Scan for MeTerm services on the LAN.
    pub async fn discover(&self, timeout_secs: u64) -> Vec<DiscoveredService> {
        eprintln!("[mdns] starting browse for {}", SERVICE_TYPE);

        // On macOS the portable daemon is deliberately short-lived and used
        // only while an explicit scan is running. Service publication always
        // stays with the system Bonjour daemon.
        #[cfg(target_os = "macos")]
        let mut owned_daemon = match BrowseDaemonGuard::new() {
            Ok(daemon) => daemon,
            Err(error) => {
                eprintln!("[mdns] browse daemon failed: {error}");
                return Vec::new();
            }
        };
        #[cfg(target_os = "macos")]
        let daemon = owned_daemon.daemon();
        #[cfg(not(target_os = "macos"))]
        let daemon = &self.daemon;

        let receiver = match daemon.browse(SERVICE_TYPE) {
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

            match tokio::time::timeout(
                remaining,
                tokio::task::spawn_blocking({
                    let receiver = receiver.clone();
                    move || receiver.recv_timeout(Duration::from_millis(500))
                }),
            )
            .await
            {
                Ok(Ok(Ok(event))) => {
                    match &event {
                        ServiceEvent::ServiceFound(svc_type, name) => {
                            eprintln!("[mdns] found: {} {}", svc_type, name);
                        }
                        ServiceEvent::ServiceResolved(info) => {
                            let port = info.get_port();
                            let addrs = info.get_addresses();

                            // Prefer IPv4 over IPv6
                            let host = addrs
                                .iter()
                                .find(|a| a.is_ipv4())
                                .or_else(|| addrs.iter().next())
                                .map(|a| a.to_string())
                                .unwrap_or_default();

                            eprintln!(
                                "[mdns] resolved: {} host={} port={} (addrs={:?})",
                                info.get_fullname(),
                                host,
                                port,
                                addrs
                            );

                            // Filter out self: check if ANY address is local
                            let is_self = port == my_port
                                && addrs.iter().any(|a| local_ips.contains(&a.to_string()));
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

                            if services
                                .iter()
                                .any(|s: &DiscoveredService| s.name == instance_name)
                            {
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
        let _ = daemon.stop_browse(SERVICE_TYPE);
        #[cfg(target_os = "macos")]
        owned_daemon.shutdown_and_wait();
        eprintln!("[mdns] browse complete: {} services found", services.len());
        services
    }
}

#[cfg(not(target_os = "macos"))]
impl Drop for DiscoveryManager {
    fn drop(&mut self) {
        // Dropping a ServiceDaemon handle alone does not stop its thread.
        // A best-effort shutdown also withdraws any portable registration.
        let _ = self.daemon.shutdown();
    }
}

fn validate_service_instance_name(display_name: &str) -> Result<(), String> {
    let byte_len = display_name.len();
    if !(1..=63).contains(&byte_len) {
        return Err(format!(
            "mDNS service name must contain 1 to 63 UTF-8 bytes (got {byte_len})"
        ));
    }
    if display_name.chars().any(char::is_control) {
        return Err("mDNS service name cannot contain control characters".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
struct BrowseDaemonGuard {
    daemon: ServiceDaemon,
    shutdown_requested: bool,
}

#[cfg(target_os = "macos")]
impl BrowseDaemonGuard {
    fn new() -> Result<Self, String> {
        Ok(Self {
            daemon: ServiceDaemon::new().map_err(|error| error.to_string())?,
            shutdown_requested: false,
        })
    }

    fn daemon(&self) -> &ServiceDaemon {
        &self.daemon
    }

    fn shutdown_and_wait(&mut self) {
        self.shutdown_requested = true;
        match self.daemon.shutdown() {
            Ok(status) => {
                if let Err(error) = status.recv_timeout(Duration::from_secs(2)) {
                    eprintln!("[mdns] browse daemon shutdown status failed: {error}");
                }
            }
            Err(error) => eprintln!("[mdns] browse daemon shutdown failed: {error}"),
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for BrowseDaemonGuard {
    fn drop(&mut self) {
        if !self.shutdown_requested {
            // Async cancellation and early returns still tell the user-space
            // browse daemon to release UDP 5353. Do not block in Drop.
            let _ = self.daemon.shutdown();
        }
    }
}

#[cfg(any(not(target_os = "macos"), test))]
fn build_service_info(
    display_name: &str,
    hostname: &str,
    port: u16,
    properties: HashMap<String, String>,
) -> Result<ServiceInfo, String> {
    ServiceInfo::new(
        SERVICE_TYPE,
        display_name,
        &format!("{hostname}.local."),
        "",
        port,
        properties,
    )
    .map(ServiceInfo::enable_addr_auto)
    .map_err(|error| {
        eprintln!("[mdns] ServiceInfo creation failed: {error}");
        format!("service info: {error}")
    })
}

fn get_local_ips() -> Vec<String> {
    local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .map(|(_, ip)| ip.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_display_name_produces_the_fullname_that_must_be_unregistered() {
        let info =
            build_service_info("Friendly Desktop", "os-hostname", 8022, HashMap::new()).unwrap();
        assert!(info.get_fullname().starts_with("Friendly Desktop."));
        assert!(!info.get_fullname().starts_with("os-hostname."));
        assert!(info.get_fullname().ends_with(SERVICE_TYPE));
    }

    #[test]
    fn service_instance_name_enforces_dns_sd_utf8_label_boundary() {
        assert!(validate_service_instance_name(&"a".repeat(63)).is_ok());
        assert!(validate_service_instance_name(&"终".repeat(21)).is_ok());
        assert!(validate_service_instance_name("").is_err());
        assert!(validate_service_instance_name(&"a".repeat(64)).is_err());
        assert!(validate_service_instance_name(&"终".repeat(22)).is_err());
        assert!(validate_service_instance_name("line\nbreak").is_err());
    }
}
