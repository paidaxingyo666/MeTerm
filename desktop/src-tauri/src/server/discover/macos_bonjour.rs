//! macOS-native Bonjour service publication.
//!
//! `mDNSResponder` owns the Mac's host records. Publishing through
//! `DNSServiceRegister` with a null host lets the system attach the service to
//! those records instead of starting a second responder that probes the same
//! hostname.

use std::collections::HashMap;
use std::ffi::{c_char, c_void, CString};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const REGISTRATION_TIMEOUT: Duration = Duration::from_secs(3);
const POLL_TIMEOUT_MS: i32 = 250;
const REGTYPE: &str = "_meterm._tcp";
const LOCAL_DOMAIN: &str = "local.";
const NO_ERROR: i32 = 0;
const CALLBACK_PENDING: i32 = i32::MIN;
const FLAG_ADD: u32 = 0x2;

type DNSServiceFlags = u32;
type DNSServiceErrorType = i32;

#[repr(C)]
struct DNSServiceRefOpaque {
    _private: [u8; 0],
}

type DNSServiceRef = *mut DNSServiceRefOpaque;

type DNSServiceRegisterReply = Option<
    unsafe extern "C" fn(
        DNSServiceRef,
        DNSServiceFlags,
        DNSServiceErrorType,
        *const c_char,
        *const c_char,
        *const c_char,
        *mut c_void,
    ),
>;

// These symbols are re-exported by libSystem on macOS. Linking a standalone
// `dns_sd` library is intentionally avoided because current SDKs do not ship
// one at the default linker search path.
#[link(name = "System")]
extern "C" {
    fn DNSServiceRegister(
        sd_ref: *mut DNSServiceRef,
        flags: DNSServiceFlags,
        interface_index: u32,
        name: *const c_char,
        regtype: *const c_char,
        domain: *const c_char,
        host: *const c_char,
        port: u16,
        txt_len: u16,
        txt_record: *const c_void,
        callback: DNSServiceRegisterReply,
        context: *mut c_void,
    ) -> DNSServiceErrorType;

    fn DNSServiceRefSockFD(sd_ref: DNSServiceRef) -> i32;
    fn DNSServiceProcessResult(sd_ref: DNSServiceRef) -> DNSServiceErrorType;
    fn DNSServiceRefDeallocate(sd_ref: DNSServiceRef);
}

/// A live registration. The worker thread is the sole owner of the native
/// `DNSServiceRef`; shutdown waits until that thread has deallocated it.
pub(super) struct BonjourRegistration {
    shutdown: Option<mpsc::Sender<()>>,
    worker: Option<JoinHandle<()>>,
    active: Arc<AtomicBool>,
}

impl BonjourRegistration {
    pub(super) fn register(
        display_name: &str,
        port: u16,
        properties: &HashMap<String, String>,
    ) -> Result<Self, String> {
        if display_name.is_empty() {
            return Err("Bonjour service name cannot be empty".to_string());
        }
        if port == 0 {
            return Err("Bonjour service port cannot be zero".to_string());
        }

        let display_name = CString::new(display_name)
            .map_err(|_| "Bonjour service name contains a NUL byte".to_string())?;
        let regtype = CString::new(REGTYPE).expect("static Bonjour regtype is valid");
        let domain = CString::new(LOCAL_DOMAIN).expect("static Bonjour domain is valid");
        let txt_record = encode_txt_record(properties)?;
        let active = Arc::new(AtomicBool::new(false));
        let worker_active = Arc::clone(&active);
        let (shutdown_tx, shutdown_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);

        let worker = thread::Builder::new()
            .name("meterm-bonjour-publisher".to_string())
            .spawn(move || {
                run_registration(
                    display_name,
                    regtype,
                    domain,
                    port,
                    txt_record,
                    shutdown_rx,
                    ready_tx,
                    worker_active,
                );
            })
            .map_err(|error| format!("start Bonjour publisher: {error}"))?;

        match ready_rx.recv_timeout(REGISTRATION_TIMEOUT) {
            Ok(Ok(())) => Ok(Self {
                shutdown: Some(shutdown_tx),
                worker: Some(worker),
                active,
            }),
            Ok(Err(error)) => {
                stop_worker(shutdown_tx, worker);
                Err(error)
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                stop_worker(shutdown_tx, worker);
                Err("Bonjour registration timed out before system confirmation".to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                stop_worker(shutdown_tx, worker);
                Err("Bonjour publisher exited before system confirmation".to_string())
            }
        }
    }

    pub(super) fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    pub(super) fn shutdown(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() {
                eprintln!("[mdns] Bonjour publisher thread panicked during shutdown");
            }
        }
        self.active.store(false, Ordering::Release);
    }
}

impl Drop for BonjourRegistration {
    fn drop(&mut self) {
        self.stop();
    }
}

struct CallbackState {
    result: AtomicI32,
    flags: AtomicU32,
}

impl CallbackState {
    fn new() -> Self {
        Self {
            result: AtomicI32::new(CALLBACK_PENDING),
            flags: AtomicU32::new(0),
        }
    }
}

unsafe extern "C" fn register_reply(
    _sd_ref: DNSServiceRef,
    flags: DNSServiceFlags,
    error_code: DNSServiceErrorType,
    _name: *const c_char,
    _regtype: *const c_char,
    _domain: *const c_char,
    context: *mut c_void,
) {
    if context.is_null() {
        return;
    }
    // SAFETY: `context` points to the boxed `CallbackState` owned by
    // `run_registration`, which outlives the DNSServiceRef and all callbacks.
    let state = unsafe { &*(context.cast::<CallbackState>()) };
    state.flags.store(flags, Ordering::Relaxed);
    state.result.store(error_code, Ordering::Release);
}

#[allow(clippy::too_many_arguments)]
fn run_registration(
    display_name: CString,
    regtype: CString,
    domain: CString,
    port: u16,
    txt_record: Vec<u8>,
    shutdown_rx: mpsc::Receiver<()>,
    ready_tx: mpsc::SyncSender<Result<(), String>>,
    active: Arc<AtomicBool>,
) {
    let callback_state = Box::new(CallbackState::new());
    let context = (&*callback_state as *const CallbackState)
        .cast_mut()
        .cast::<c_void>();
    let mut service_ref: DNSServiceRef = ptr::null_mut();
    let txt_ptr = if txt_record.is_empty() {
        ptr::null()
    } else {
        txt_record.as_ptr().cast::<c_void>()
    };

    // SAFETY: all C strings and TXT bytes remain alive for this call, the
    // output pointer is valid, and `context` remains valid until after the
    // resulting service reference is deallocated below.
    let error = unsafe {
        DNSServiceRegister(
            &mut service_ref,
            0,
            0,
            display_name.as_ptr(),
            regtype.as_ptr(),
            domain.as_ptr(),
            ptr::null(),
            network_port(port),
            txt_record.len() as u16,
            txt_ptr,
            Some(register_reply),
            context,
        )
    };
    if error != NO_ERROR {
        let _ = ready_tx.send(Err(format!(
            "Bonjour registration failed immediately: error {error}"
        )));
        return;
    }
    if service_ref.is_null() {
        let _ = ready_tx.send(Err(
            "Bonjour registration returned an empty service reference".to_string(),
        ));
        return;
    }

    let service_ref = ServiceRefGuard(service_ref);
    // SAFETY: the guard contains a live DNSServiceRef returned above.
    let socket_fd = unsafe { DNSServiceRefSockFD(service_ref.0) };
    if socket_fd < 0 {
        let _ = ready_tx.send(Err(
            "Bonjour registration did not provide a valid socket".to_string()
        ));
        return;
    }

    let mut ready_tx = Some(ready_tx);
    loop {
        match shutdown_rx.try_recv() {
            Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }

        let mut poll_fd = libc::pollfd {
            fd: socket_fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: `poll_fd` points to one initialized poll descriptor.
        let poll_result = unsafe { libc::poll(&mut poll_fd, 1, POLL_TIMEOUT_MS) };
        if poll_result < 0 {
            let os_error = std::io::Error::last_os_error();
            if os_error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            notify_initial_failure(
                &mut ready_tx,
                format!("Bonjour publisher poll failed: {os_error}"),
            );
            break;
        }
        if poll_result == 0 {
            continue;
        }
        if poll_fd.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
            notify_initial_failure(
                &mut ready_tx,
                format!(
                    "Bonjour publisher socket closed unexpectedly: events=0x{:x}",
                    poll_fd.revents
                ),
            );
            break;
        }
        if poll_fd.revents & libc::POLLIN == 0 {
            continue;
        }

        // SAFETY: the socket is readable and the guard still owns the live
        // DNSServiceRef. This invokes `register_reply` synchronously.
        let process_error = unsafe { DNSServiceProcessResult(service_ref.0) };
        if process_error != NO_ERROR {
            notify_initial_failure(
                &mut ready_tx,
                format!("Bonjour callback processing failed: error {process_error}"),
            );
            break;
        }

        let callback_result = callback_state
            .result
            .swap(CALLBACK_PENDING, Ordering::AcqRel);
        if callback_result == CALLBACK_PENDING {
            continue;
        }
        if callback_result != NO_ERROR {
            notify_initial_failure(
                &mut ready_tx,
                format!("Bonjour registration was rejected: error {callback_result}"),
            );
            break;
        }
        let callback_flags = callback_state.flags.load(Ordering::Relaxed);
        if callback_flags & FLAG_ADD == 0 {
            if ready_tx.is_some() {
                notify_initial_failure(
                    &mut ready_tx,
                    "Bonjour registration was withdrawn before confirmation".to_string(),
                );
            } else {
                eprintln!("[mdns] system withdrew the Bonjour registration");
            }
            break;
        }
        if let Some(ready) = ready_tx.take() {
            active.store(true, Ordering::Release);
            if ready.send(Ok(())).is_err() {
                active.store(false, Ordering::Release);
                break;
            }
            eprintln!(
                "[mdns] system Bonjour registration confirmed: {}.{} port={}",
                display_name.to_string_lossy(),
                REGTYPE,
                port
            );
        }
    }

    active.store(false, Ordering::Release);
    // `service_ref` is deallocated here, on its owner thread, before
    // `callback_state` is dropped.
}

fn notify_initial_failure(
    ready_tx: &mut Option<mpsc::SyncSender<Result<(), String>>>,
    error: String,
) {
    if let Some(ready) = ready_tx.take() {
        let _ = ready.send(Err(error));
    } else {
        eprintln!("[mdns] {error}");
    }
}

fn stop_worker(shutdown: mpsc::Sender<()>, worker: JoinHandle<()>) {
    let _ = shutdown.send(());
    if worker.join().is_err() {
        eprintln!("[mdns] Bonjour publisher thread panicked while stopping");
    }
}

struct ServiceRefGuard(DNSServiceRef);

impl Drop for ServiceRefGuard {
    fn drop(&mut self) {
        // SAFETY: this guard is constructed only from a non-null, live
        // DNSServiceRef and is the sole owner responsible for deallocation.
        unsafe { DNSServiceRefDeallocate(self.0) };
    }
}

fn encode_txt_record(properties: &HashMap<String, String>) -> Result<Vec<u8>, String> {
    let mut entries = properties.iter().collect::<Vec<_>>();
    entries.sort_unstable_by(|left, right| left.0.cmp(right.0));

    let mut record = Vec::new();
    for (key, value) in entries {
        if key.is_empty()
            || key
                .bytes()
                .any(|byte| !(0x20..=0x7e).contains(&byte) || byte == b'=')
        {
            return Err(format!("invalid Bonjour TXT key: {key:?}"));
        }
        let entry = format!("{key}={value}");
        if entry.len() > u8::MAX as usize {
            return Err(format!("Bonjour TXT entry is too long: {key}"));
        }
        record.push(entry.len() as u8);
        record.extend_from_slice(entry.as_bytes());
    }
    if record.len() > u16::MAX as usize {
        return Err("Bonjour TXT record is too large".to_string());
    }
    Ok(record)
}

fn network_port(port: u16) -> u16 {
    port.to_be()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn txt_record_is_deterministic_and_keeps_identity_fields() {
        let properties = HashMap::from([
            ("id".to_string(), "device-1".to_string()),
            ("fp".to_string(), "abcdef".to_string()),
        ]);

        assert_eq!(
            encode_txt_record(&properties).unwrap(),
            b"\x09fp=abcdef\x0bid=device-1"
        );
    }

    #[test]
    fn txt_record_rejects_invalid_keys_and_oversized_entries() {
        assert!(encode_txt_record(&HashMap::from([(
            "bad=key".to_string(),
            "value".to_string()
        )]))
        .is_err());
        assert!(encode_txt_record(&HashMap::from([("id".to_string(), "x".repeat(254))])).is_err());
    }

    #[test]
    fn service_port_is_passed_in_network_byte_order() {
        assert_eq!(network_port(0x1234).to_ne_bytes(), [0x12, 0x34]);
    }
}
