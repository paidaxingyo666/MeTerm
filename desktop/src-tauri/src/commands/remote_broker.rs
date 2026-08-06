//! Fixed-operation broker for credentials used to view another MeTerm desktop.
//!
//! The WebView may provide a new token, but a token already persisted in the OS
//! credential store is never returned over Tauri IPC. HTTP and WebSocket
//! authentication both happen here. A WebSocket handle is bound to one
//! canonical authority and one session at creation and cannot be retargeted.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::WebPkiSupportedAlgorithms;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, DigitallySignedStruct, Error as TlsError, SignatureScheme};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_rustls::TlsConnector;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{header, HeaderValue};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

#[cfg(debug_assertions)]
const REMOTE_SERVICE: &str = "com.meterm.dev.remote.v2";
#[cfg(not(debug_assertions))]
const REMOTE_SERVICE: &str = "com.meterm.app.remote.v2";
#[cfg(debug_assertions)]
const LEGACY_REMOTE_SERVICES: &[&str] = &[];
#[cfg(not(debug_assertions))]
const LEGACY_REMOTE_SERVICES: &[&str] = &["com.meterm.app.remote", "com.meterm.dev.remote"];
const MAX_TOKEN_BYTES: usize = 64 * 1024;
const MAX_BROKER_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MAX_HTTP_BODY_BYTES: u64 = 4 * 1024 * 1024;
const BROKER_OUTBOUND_QUEUE: usize = 32;

#[derive(Serialize, Deserialize)]
struct RemoteCredential {
    v: u8,
    authority: String,
    secure: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cert_fp: Option<String>,
    token: String,
}

#[derive(Clone, Debug)]
struct CanonicalTarget {
    host: String,
    port: u16,
    authority: String,
    account: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RemoteBrokerEvent {
    Message { data: Vec<u8> },
    Closed { reason: Option<String> },
}

enum BrokerOutbound {
    Binary(Vec<u8>),
    Close,
}

#[derive(Clone, Default)]
pub struct RemoteBrokerState {
    connections: Arc<Mutex<HashMap<String, mpsc::Sender<BrokerOutbound>>>>,
}

trait BrokerIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T> BrokerIo for T where T: AsyncRead + AsyncWrite + Unpin + Send {}
type BoxedBrokerIo = Box<dyn BrokerIo>;

fn require_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let label = window.label();
    if label == "main" || label.starts_with("window-") {
        Ok(())
    } else {
        Err("remote broker is restricted to terminal windows".to_string())
    }
}

fn canonical_target(host: &str, port: u16) -> Result<CanonicalTarget, String> {
    if port == 0 {
        return Err("invalid remote port".to_string());
    }
    let raw = host.trim().trim_end_matches('.');
    if raw.is_empty()
        || raw.len() > 253
        || raw.chars().any(char::is_control)
        || raw.chars().any(char::is_whitespace)
        || raw.contains('/')
        || raw.contains('@')
        || raw.contains('?')
        || raw.contains('#')
    {
        return Err("invalid remote host".to_string());
    }

    let unbracketed = raw
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(raw);
    let host = match unbracketed.parse::<IpAddr>() {
        Ok(ip) => ip.to_string(),
        Err(_) => {
            if unbracketed.contains(':')
                || !unbracketed
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
                || unbracketed
                    .split('.')
                    .any(|label| label.is_empty() || label.starts_with('-') || label.ends_with('-'))
            {
                return Err("invalid remote host".to_string());
            }
            unbracketed.to_ascii_lowercase()
        }
    };
    let display_host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.clone()
    };
    let authority = format!("{display_host}:{port}");
    Ok(CanonicalTarget {
        host,
        port,
        account: format!("{authority}:token"),
        authority,
    })
}

fn validate_transport(target: &CanonicalTarget, secure: bool) -> Result<(), String> {
    if secure {
        return Ok(());
    }
    let loopback = target.host.eq_ignore_ascii_case("localhost")
        || target
            .host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback());
    if loopback {
        Ok(())
    } else {
        Err("plaintext remote transport is restricted to loopback".to_string())
    }
}

fn normalize_fingerprint(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else { return Ok(None) };
    let value = value.trim().to_ascii_lowercase();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(Some(value))
    } else {
        Err("remote certificate fingerprint must be 64 hexadecimal characters".to_string())
    }
}

fn entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, account).map_err(|e| format!("keyring init error: {e}"))
}

fn read_entry(service: &str, account: &str) -> Result<Option<String>, String> {
    match entry(service, account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("keyring get error: {error}")),
    }
}

fn delete_entry(service: &str, account: &str) -> Result<(), String> {
    match entry(service, account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("keyring delete error: {error}")),
    }
}

fn validate_token(token: &str) -> Result<(), String> {
    if token.is_empty() || token.len() > MAX_TOKEN_BYTES || token.chars().any(char::is_control) {
        Err("invalid remote token".to_string())
    } else {
        Ok(())
    }
}

fn decode_record(raw: &str, expected: &CanonicalTarget) -> Result<RemoteCredential, String> {
    let record: RemoteCredential = serde_json::from_str(raw)
        .map_err(|_| "remote credential requires one-time migration".to_string())?;
    if record.v != 1 || record.authority != expected.authority {
        return Err("remote credential binding is invalid".to_string());
    }
    validate_token(&record.token)?;
    validate_transport(expected, record.secure)?;
    if normalize_fingerprint(record.cert_fp.clone())? != record.cert_fp {
        return Err("remote credential binding is invalid".to_string());
    }
    Ok(record)
}

fn load_record(target: &CanonicalTarget) -> Result<RemoteCredential, String> {
    let raw = read_entry(REMOTE_SERVICE, &target.account)?
        .ok_or_else(|| "remote credential not found".to_string())?;
    decode_record(&raw, target)
}

fn serialize_record(record: &RemoteCredential) -> Result<String, String> {
    serde_json::to_string(record).map_err(|_| "failed to encode remote credential".to_string())
}

#[cfg(target_os = "macos")]
fn create_record_raw(service: &str, account: &str, encoded: &str) -> Result<(), String> {
    use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};

    let keychain = SecKeychain::default_for_domain(SecPreferencesDomain::User)
        .map_err(|_| "remote credential vault is unavailable".to_string())?;
    keychain
        .add_generic_password(service, account, encoded.as_bytes())
        .map_err(|_| "remote credential target already exists".to_string())
}

#[cfg(not(target_os = "macos"))]
fn create_record_raw(service: &str, account: &str, encoded: &str) -> Result<(), String> {
    if read_entry(service, account)?.is_some() {
        return Err("remote credential target already exists".to_string());
    }
    entry(service, account)?
        .set_password(encoded)
        .map_err(|error| format!("keyring store error: {error}"))
}

fn store_record(
    target: &CanonicalTarget,
    record: &RemoteCredential,
    create_only: bool,
) -> Result<(), String> {
    let encoded = serialize_record(record)?;
    if create_only {
        return create_record_raw(REMOTE_SERVICE, &target.account, &encoded);
    }
    entry(REMOTE_SERVICE, &target.account)?
        .set_password(&encoded)
        .map_err(|e| format!("keyring store error: {e}"))
}

fn legacy_account(host: &str, port: u16) -> Option<String> {
    let host = host.trim();
    (!host.is_empty() && !host.chars().any(char::is_control))
        .then(|| format!("{host}:{port}:token"))
}

fn credential_candidates(target: &CanonicalTarget, host: &str, port: u16) -> Vec<(String, String)> {
    let mut candidates = vec![(REMOTE_SERVICE.to_string(), target.account.clone())];
    if let Some(old_account) = legacy_account(host, port) {
        if old_account != target.account {
            candidates.push((REMOTE_SERVICE.to_string(), old_account.clone()));
        }
        candidates.extend(
            LEGACY_REMOTE_SERVICES
                .iter()
                .map(|service| ((*service).to_string(), old_account.clone())),
        );
    }
    candidates
}

fn delete_legacy_candidates(target: &CanonicalTarget, host: &str, port: u16) -> Result<(), String> {
    for (service, account) in credential_candidates(target, host, port) {
        if service != REMOTE_SERVICE || account != target.account {
            delete_entry(&service, &account)?;
        }
    }
    Ok(())
}

fn migration_digest(
    target: &CanonicalTarget,
    secure: bool,
    cert_fp: Option<&str>,
    source_service: &str,
    source_account: &str,
    raw: &str,
) -> [u8; 32] {
    let secure_byte = [u8::from(secure)];
    let cert_fp = cert_fp.unwrap_or_default();
    let mut digest = Sha256::new();
    for component in [
        target.authority.as_bytes(),
        secure_byte.as_slice(),
        cert_fp.as_bytes(),
        source_service.as_bytes(),
        source_account.as_bytes(),
        raw.as_bytes(),
    ] {
        digest.update((component.len() as u64).to_be_bytes());
        digest.update(component);
    }
    digest.finalize().into()
}

struct LegacyMigrationSnapshot {
    target: CanonicalTarget,
    source_host: String,
    secure: bool,
    cert_fp: Option<String>,
    source_service: String,
    source_account: String,
    consent_digest: [u8; 32],
}

impl LegacyMigrationSnapshot {
    fn confirmation_reason(&self) -> String {
        let transport = if !self.secure {
            "loopback plaintext".to_string()
        } else if let Some(fingerprint) = &self.cert_fp {
            format!(
                "TLS pinned certificate {}...",
                super::user_presence::safe_prompt_field(&fingerprint[..12])
            )
        } else {
            "TLS system trust".to_string()
        };
        format!(
            "Bind saved remote desktop credential. Remote authority: [{}]; transport: [{}]",
            super::user_presence::safe_prompt_field(&self.target.authority),
            transport
        )
    }
}

enum LegacyMigrationPreparation {
    NotRequired(bool),
    RequiresConfirmation(LegacyMigrationSnapshot),
}

fn prepare_legacy_migration(
    host: &str,
    port: u16,
    secure: bool,
    cert_fp: Option<String>,
) -> Result<LegacyMigrationPreparation, String> {
    let target = canonical_target(host, port)?;
    validate_transport(&target, secure)?;
    let cert_fp = normalize_fingerprint(cert_fp)?;
    let candidates = credential_candidates(&target, host, port);

    for (service, account) in candidates {
        let Some(raw) = read_entry(&service, &account)? else {
            continue;
        };
        if let Ok(record) = decode_record(&raw, &target) {
            // An already authority-bound record needs no new consent, even if
            // it still lives at an old exact account. Canonicalize its storage
            // and remove stale duplicates without exposing its token.
            if service != REMOTE_SERVICE || account != target.account {
                store_record(&target, &record, true)?;
            }
            delete_legacy_candidates(&target, host, port)?;
            return Ok(LegacyMigrationPreparation::NotRequired(true));
        }
        // A structured-but-invalid record is never reinterpreted as a token.
        if serde_json::from_str::<serde_json::Value>(&raw).is_ok() {
            return Err("remote credential binding is invalid".to_string());
        }
        validate_token(&raw)?;
        let consent_digest = migration_digest(
            &target,
            secure,
            cert_fp.as_deref(),
            &service,
            &account,
            &raw,
        );
        return Ok(LegacyMigrationPreparation::RequiresConfirmation(
            LegacyMigrationSnapshot {
                target,
                source_host: host.to_string(),
                secure,
                cert_fp,
                source_service: service,
                source_account: account,
                consent_digest,
            },
        ));
    }
    Ok(LegacyMigrationPreparation::NotRequired(false))
}

fn commit_legacy_migration(snapshot: LegacyMigrationSnapshot) -> Result<bool, String> {
    validate_transport(&snapshot.target, snapshot.secure)?;
    normalize_fingerprint(snapshot.cert_fp.clone())?;

    let source_is_target = snapshot.source_service == REMOTE_SERVICE
        && snapshot.source_account == snapshot.target.account;
    if !source_is_target && read_entry(REMOTE_SERVICE, &snapshot.target.account)?.is_some() {
        return Err("remote credential changed during migration".to_string());
    }
    let raw = read_entry(&snapshot.source_service, &snapshot.source_account)?
        .ok_or_else(|| "remote credential changed during migration".to_string())?;
    let current_digest = migration_digest(
        &snapshot.target,
        snapshot.secure,
        snapshot.cert_fp.as_deref(),
        &snapshot.source_service,
        &snapshot.source_account,
        &raw,
    );
    if current_digest != snapshot.consent_digest {
        return Err("remote credential changed during migration".to_string());
    }
    if serde_json::from_str::<serde_json::Value>(&raw).is_ok() {
        return Err("remote credential changed during migration".to_string());
    }
    validate_token(&raw)?;
    let record = RemoteCredential {
        v: 1,
        authority: snapshot.target.authority.clone(),
        secure: snapshot.secure,
        cert_fp: snapshot.cert_fp,
        token: raw,
    };
    store_record(&snapshot.target, &record, !source_is_target)?;
    delete_legacy_candidates(
        &snapshot.target,
        &snapshot.source_host,
        snapshot.target.port,
    )?;
    Ok(true)
}

#[tauri::command]
pub async fn remote_store_token(
    window: tauri::WebviewWindow,
    host: String,
    port: u16,
    secure: bool,
    cert_fp: Option<String>,
    token: String,
) -> Result<(), String> {
    require_main_window(&window)?;
    validate_token(&token)?;
    let target = canonical_target(&host, port)?;
    validate_transport(&target, secure)?;
    let record = RemoteCredential {
        v: 1,
        authority: target.authority.clone(),
        secure,
        cert_fp: normalize_fingerprint(cert_fp)?,
        token,
    };
    let create_only = match read_entry(REMOTE_SERVICE, &target.account)? {
        None => true,
        Some(raw) => {
            decode_record(&raw, &target)?;
            false
        }
    };
    store_record(&target, &record, create_only)?;

    if let Some(old_account) = legacy_account(&host, port) {
        for service in LEGACY_REMOTE_SERVICES {
            delete_entry(service, &old_account)?;
        }
        if old_account != target.account {
            delete_entry(REMOTE_SERVICE, &old_account)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_has_token(
    window: tauri::WebviewWindow,
    host: String,
    port: u16,
    secure: bool,
    cert_fp: Option<String>,
) -> Result<bool, String> {
    require_main_window(&window)?;
    match prepare_legacy_migration(&host, port, secure, cert_fp)? {
        LegacyMigrationPreparation::NotRequired(exists) => Ok(exists),
        LegacyMigrationPreparation::RequiresConfirmation(snapshot) => {
            let reason = snapshot.confirmation_reason();
            super::user_presence::confirm_for_credential_binding(&window, reason).await?;
            commit_legacy_migration(snapshot)
        }
    }
}

#[tauri::command]
pub async fn remote_delete_token(
    window: tauri::WebviewWindow,
    host: String,
    port: u16,
) -> Result<(), String> {
    require_main_window(&window)?;
    let target = canonical_target(&host, port)?;
    delete_entry(REMOTE_SERVICE, &target.account)?;
    if let Some(old_account) = legacy_account(&host, port) {
        if old_account != target.account {
            delete_entry(REMOTE_SERVICE, &old_account)?;
        }
        for service in LEGACY_REMOTE_SERVICES {
            delete_entry(service, &old_account)?;
        }
    }
    Ok(())
}

#[derive(Debug)]
struct FingerprintVerifier {
    expected_fp: String,
    supported: WebPkiSupportedAlgorithms,
}

impl FingerprintVerifier {
    fn new(expected_fp: &str) -> Self {
        let provider = rustls::crypto::ring::default_provider();
        Self {
            expected_fp: expected_fp.to_ascii_lowercase(),
            supported: provider.signature_verification_algorithms,
        }
    }
}

impl ServerCertVerifier for FingerprintVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        let digest = Sha256::digest(end_entity.as_ref());
        let got = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if got.eq_ignore_ascii_case(&self.expected_fp) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(TlsError::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.supported)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.supported)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.supported.supported_schemes()
    }
}

fn tls_config(record: &RemoteCredential) -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("tls protocol versions: {e}"))?;

    if let Some(cert_fp) = &record.cert_fp {
        Ok(builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(FingerprintVerifier::new(cert_fp)))
            .with_no_client_auth())
    } else {
        let loaded = rustls_native_certs::load_native_certs();
        let mut roots = rustls::RootCertStore::empty();
        for cert in loaded.certs {
            let _ = roots.add(cert);
        }
        if roots.is_empty() {
            return Err("no native TLS trust anchors are available".to_string());
        }
        Ok(builder.with_root_certificates(roots).with_no_client_auth())
    }
}

fn target_url(target: &CanonicalTarget, secure: bool, path: &str) -> String {
    let scheme = if secure { "https" } else { "http" };
    format!("{scheme}://{}{path}", target.authority)
}

#[tauri::command]
pub async fn remote_list_sessions(
    window: tauri::WebviewWindow,
    host: String,
    port: u16,
) -> Result<String, String> {
    require_main_window(&window)?;
    let target = canonical_target(&host, port)?;
    let record = load_record(&target)?;
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none());
    if record.secure {
        builder = builder.use_preconfigured_tls(tls_config(&record)?);
    }
    let client = builder
        .build()
        .map_err(|e| format!("failed to initialize remote HTTP client: {e}"))?;
    let response = client
        .get(target_url(&target, record.secure, "/api/sessions"))
        .bearer_auth(&record.token)
        .send()
        .await
        .map_err(|e| format!("remote request failed: {e}"))?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("REMOTE_AUTH_EXPIRED".to_string());
    }
    if !response.status().is_success() {
        return Err(format!("remote server returned HTTP {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_HTTP_BODY_BYTES)
    {
        return Err("remote response is too large".to_string());
    }
    let body = response
        .bytes()
        .await
        .map_err(|e| format!("failed to read remote response: {e}"))?;
    if body.len() as u64 > MAX_HTTP_BODY_BYTES {
        return Err("remote response is too large".to_string());
    }
    let value: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|_| "remote server returned invalid JSON".to_string())?;
    serde_json::to_string(&value).map_err(|_| "failed to encode remote response".to_string())
}

async fn connect_stream(
    target: &CanonicalTarget,
    record: &RemoteCredential,
) -> Result<BoxedBrokerIo, String> {
    let tcp = tokio::time::timeout(
        Duration::from_secs(5),
        TcpStream::connect((target.host.as_str(), target.port)),
    )
    .await
    .map_err(|_| "remote connection timed out".to_string())?
    .map_err(|e| format!("remote TCP connection failed: {e}"))?;
    if !record.secure {
        return Ok(Box::new(tcp));
    }

    let server_name = ServerName::try_from(target.host.clone())
        .map_err(|_| "invalid TLS server name".to_string())?;
    let connector = TlsConnector::from(Arc::new(tls_config(record)?));
    let tls = tokio::time::timeout(Duration::from_secs(8), connector.connect(server_name, tcp))
        .await
        .map_err(|_| "remote TLS handshake timed out".to_string())?
        .map_err(|e| format!("remote TLS handshake failed: {e}"))?;
    Ok(Box::new(tls))
}

#[tauri::command]
pub async fn remote_connect_session(
    window: tauri::WebviewWindow,
    broker: State<'_, RemoteBrokerState>,
    host: String,
    port: u16,
    session_id: String,
    client_id: Option<String>,
    on_event: tauri::ipc::Channel<RemoteBrokerEvent>,
) -> Result<String, String> {
    require_main_window(&window)?;
    super::validate_id(&session_id)?;
    if let Some(client_id) = &client_id {
        super::validate_id(client_id)?;
    }
    let target = canonical_target(&host, port)?;
    let record = load_record(&target)?;
    let stream = connect_stream(&target, &record).await?;

    let scheme = if record.secure { "wss" } else { "ws" };
    let mut url = format!(
        "{scheme}://{}/ws/{}",
        target.authority,
        urlencoding::encode(&session_id)
    );
    if let Some(client_id) = &client_id {
        url.push_str("?client_id=");
        url.push_str(&urlencoding::encode(client_id));
    }
    let mut request = url
        .into_client_request()
        .map_err(|_| "failed to build remote WebSocket request".to_string())?;
    request.headers_mut().insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", record.token))
            .map_err(|_| "invalid remote authorization token".to_string())?,
    );
    request.headers_mut().insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static("meterm.v1"),
    );
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_BROKER_FRAME_BYTES))
        .max_frame_size(Some(MAX_BROKER_FRAME_BYTES));
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::client_async_with_config(request, stream, Some(config)),
    )
    .await
    .map_err(|_| "remote WebSocket handshake timed out".to_string())?
    .map_err(|e| format!("remote WebSocket handshake failed: {e}"))?;

    let handle = uuid::Uuid::new_v4().to_string();
    let (sender, mut receiver) = mpsc::channel(BROKER_OUTBOUND_QUEUE);
    broker
        .connections
        .lock()
        .map_err(|_| "remote broker state is unavailable".to_string())?
        .insert(handle.clone(), sender);

    let connections = broker.connections.clone();
    let task_handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let mut close_reason: Option<String> = None;
        loop {
            tokio::select! {
                outgoing = receiver.recv() => {
                    match outgoing {
                        Some(BrokerOutbound::Binary(data)) => {
                            if socket.send(Message::Binary(data.into())).await.is_err() {
                                close_reason = Some("remote WebSocket send failed".to_string());
                                break;
                            }
                        }
                        Some(BrokerOutbound::Close) | None => {
                            let _ = socket.close(None).await;
                            break;
                        }
                    }
                }
                incoming = socket.next() => {
                    match incoming {
                        Some(Ok(Message::Binary(data))) => {
                            if data.len() > MAX_BROKER_FRAME_BYTES {
                                close_reason = Some("remote WebSocket frame is too large".to_string());
                                break;
                            }
                            if on_event.send(RemoteBrokerEvent::Message { data: data.to_vec() }).is_err() {
                                break;
                            }
                        }
                        Some(Ok(Message::Ping(data))) => {
                            if socket.send(Message::Pong(data)).await.is_err() {
                                break;
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => break,
                        Some(Ok(_)) => {}
                        Some(Err(_)) => {
                            close_reason = Some("remote WebSocket receive failed".to_string());
                            break;
                        }
                    }
                }
            }
        }
        if let Ok(mut active) = connections.lock() {
            active.remove(&task_handle);
        }
        let _ = on_event.send(RemoteBrokerEvent::Closed {
            reason: close_reason,
        });
    });
    Ok(handle)
}

#[tauri::command]
pub async fn remote_send_frame(
    window: tauri::WebviewWindow,
    broker: State<'_, RemoteBrokerState>,
    handle: String,
    data: Vec<u8>,
) -> Result<(), String> {
    require_main_window(&window)?;
    if data.is_empty() || data.len() > MAX_BROKER_FRAME_BYTES {
        return Err("invalid remote broker frame".to_string());
    }
    let active = broker
        .connections
        .lock()
        .map_err(|_| "remote broker state is unavailable".to_string())?;
    let sender = active
        .get(&handle)
        .ok_or_else(|| "remote broker handle is closed".to_string())?;
    sender
        .try_send(BrokerOutbound::Binary(data))
        .map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => {
                "remote broker backpressure limit reached".to_string()
            }
            mpsc::error::TrySendError::Closed(_) => "remote broker handle is closed".to_string(),
        })
}

#[tauri::command]
pub async fn remote_close_session(
    window: tauri::WebviewWindow,
    broker: State<'_, RemoteBrokerState>,
    handle: String,
) -> Result<(), String> {
    require_main_window(&window)?;
    let sender = broker
        .connections
        .lock()
        .map_err(|_| "remote broker state is unavailable".to_string())?
        .remove(&handle);
    if let Some(sender) = sender {
        let _ = sender.try_send(BrokerOutbound::Close);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_authority_normalizes_domain_and_ipv6() {
        assert_eq!(
            canonical_target(" Example.COM. ", 443).unwrap().authority,
            "example.com:443"
        );
        assert_eq!(
            canonical_target("[2001:db8::1]", 8080).unwrap().authority,
            "[2001:db8::1]:8080"
        );
    }

    #[test]
    fn plaintext_transport_is_loopback_only() {
        let loopback = canonical_target("127.0.0.1", 8080).unwrap();
        assert!(validate_transport(&loopback, false).is_ok());
        let remote = canonical_target("192.168.1.10", 8080).unwrap();
        assert!(validate_transport(&remote, false).is_err());
    }

    #[test]
    fn record_is_bound_to_exact_authority() {
        let first = canonical_target("server.example", 443).unwrap();
        let second = canonical_target("other.example", 443).unwrap();
        let record = RemoteCredential {
            v: 1,
            authority: first.authority.clone(),
            secure: true,
            cert_fp: None,
            token: "secret".to_string(),
        };
        let encoded = serialize_record(&record).unwrap();
        assert!(decode_record(&encoded, &first).is_ok());
        assert!(decode_record(&encoded, &second).is_err());
    }

    #[test]
    fn legacy_consent_digest_covers_source_and_tls_binding() {
        let target = canonical_target("server.example", 443).unwrap();
        let original = migration_digest(
            &target,
            true,
            Some(&"ab".repeat(32)),
            "legacy.service",
            "server.example:443:token",
            "secret",
        );
        assert_ne!(
            original,
            migration_digest(
                &target,
                true,
                Some(&"cd".repeat(32)),
                "legacy.service",
                "server.example:443:token",
                "secret",
            )
        );
        assert_ne!(
            original,
            migration_digest(
                &target,
                true,
                Some(&"ab".repeat(32)),
                "legacy.service",
                "server.example:443:token",
                "changed",
            )
        );
        assert_ne!(
            original,
            migration_digest(
                &target,
                false,
                Some(&"ab".repeat(32)),
                "legacy.service",
                "server.example:443:token",
                "secret",
            )
        );
    }

    #[test]
    fn legacy_confirmation_reason_discloses_binding_but_not_secret() {
        let target = canonical_target("server.example", 443).unwrap();
        let snapshot = LegacyMigrationSnapshot {
            target,
            source_host: "server.example".to_string(),
            secure: true,
            cert_fp: Some("ab".repeat(32)),
            source_service: "legacy.service".to_string(),
            source_account: "server.example:443:token".to_string(),
            consent_digest: [0; 32],
        };
        let reason = snapshot.confirmation_reason();
        assert!(reason.contains("server.example:443"));
        assert!(reason.contains("abababababab"));
        assert!(!reason.contains("token"));
        assert!(!reason.contains("secret"));
    }

    #[test]
    fn vault_namespace_matches_build_channel() {
        #[cfg(debug_assertions)]
        {
            assert_eq!(REMOTE_SERVICE, "com.meterm.dev.remote.v2");
            assert!(LEGACY_REMOTE_SERVICES.is_empty());
        }
        #[cfg(not(debug_assertions))]
        {
            assert_eq!(REMOTE_SERVICE, "com.meterm.app.remote.v2");
            assert_eq!(
                LEGACY_REMOTE_SERVICES,
                &["com.meterm.app.remote", "com.meterm.dev.remote"]
            );
        }
    }
}
