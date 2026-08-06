//! Persistent per-device bearer credentials.
//!
//! Only SHA-256 token digests and non-secret device metadata are written to
//! disk. Plaintext tokens exist only at issuance and in the authenticating
//! client's request.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::RngCore;

use super::private_file::atomic_write_private;

#[cfg(all(not(debug_assertions), feature = "development-mobile-control"))]
compile_error!("development-mobile-control cannot be enabled in a distributable release build");

const FILE_VERSION: u8 = 4;
const LEGACY_FILE_VERSION: u8 = 1;
const LEGACY_FILE_VERSION_2: u8 = 2;
const LEGACY_FILE_VERSION_3: u8 = 3;
const MAX_DEVICE_CREDENTIALS: usize = 128;
const MAX_DEVICE_ID_BYTES: usize = 128;
const MAX_DEVICE_NAME_BYTES: usize = 128;

/// Independently revocable capabilities granted to one paired device.
///
/// Raw SSH credential export is deliberately separate and is never included
/// in the pairing default. A phone can still ask the desktop to open a saved
/// SSH connection without receiving the password or private key itself.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub(crate) enum DeviceScope {
    #[serde(rename = "desktop.control")]
    DesktopControl,
    #[serde(rename = "ssh.desktop-connect")]
    SshDesktopConnect,
    #[serde(rename = "ssh.connections-write")]
    SshConnectionsWrite,
    #[serde(rename = "push.self")]
    PushSelf,
    #[serde(rename = "ssh.secrets-export")]
    SshSecretsExport,
}

const DEVELOPMENT_SCOPES: [DeviceScope; 4] = [
    DeviceScope::DesktopControl,
    DeviceScope::SshDesktopConnect,
    DeviceScope::SshConnectionsWrite,
    DeviceScope::PushSelf,
];

// A distributed build must not allow a paired phone to become the desktop OS
// user while relay registration material and the desktop TLS key still live
// under that same OS identity. The paired-device API never grants raw secret
// export; the separate native export flow requires desktop OS identity
// confirmation and produces a user-selected portable bundle for mobile import.
const DISTRIBUTABLE_SCOPES: [DeviceScope; 0] = [];

// The documented development entrypoints are intentionally full-control test
// builds. A newly paired, PoP-bound device can exercise the complete terminal,
// desktop file/Git/Agent, SSH and push contract while the product is still in
// development. Raw SSH secret export remains a separate local-native operation
// and is never an assignable device scope.
const DEVELOPMENT_DEFAULT_SCOPES: [DeviceScope; 4] = [
    DeviceScope::DesktopControl,
    DeviceScope::SshDesktopConnect,
    DeviceScope::SshConnectionsWrite,
    DeviceScope::PushSelf,
];

// Credentials persisted by an older development build must not silently gain
// desktop.control merely because a newer binary is started. Re-pairing rotates
// the bearer + PoP identity and receives DEVELOPMENT_DEFAULT_SCOPES; otherwise
// the local owner must explicitly grant the new scope through the admin API.
const DEVELOPMENT_LEGACY_DEFAULT_SCOPES: [DeviceScope; 3] = [
    DeviceScope::SshDesktopConnect,
    DeviceScope::SshConnectionsWrite,
    DeviceScope::PushSelf,
];

// Request and relay proof-of-possession is implemented, but it does not turn a
// hooked/rooted phone into a trusted process: live code can still use the
// non-exportable key as a signing oracle. More importantly, the desktop control
// identity is not yet isolated from the main process. A distributable build
// therefore exposes no desktop-mediated mobile capability until the independent
// control Broker is implemented and reviewed on every supported platform.
const DISTRIBUTABLE_DEFAULT_SCOPES: [DeviceScope; 0] = [];

fn development_mobile_control_enabled() -> bool {
    cfg!(all(
        debug_assertions,
        feature = "development-mobile-control"
    ))
}

pub(crate) fn supported_scopes() -> &'static [DeviceScope] {
    scopes_for_build(development_mobile_control_enabled())
}

pub(crate) fn default_scopes() -> Vec<DeviceScope> {
    if development_mobile_control_enabled() {
        DEVELOPMENT_DEFAULT_SCOPES.to_vec()
    } else {
        DISTRIBUTABLE_DEFAULT_SCOPES.to_vec()
    }
}

fn legacy_default_scopes() -> Vec<DeviceScope> {
    if development_mobile_control_enabled() {
        DEVELOPMENT_LEGACY_DEFAULT_SCOPES.to_vec()
    } else {
        DISTRIBUTABLE_DEFAULT_SCOPES.to_vec()
    }
}

pub(crate) fn validate_supported_scopes(scopes: &[DeviceScope]) -> Result<(), String> {
    validate_assignable_scopes(scopes, development_mobile_control_enabled())
}

fn normalize_scopes(mut scopes: Vec<DeviceScope>) -> Vec<DeviceScope> {
    scopes.sort_unstable();
    scopes.dedup();
    scopes
}

fn scopes_for_build(allow_unsafe_development_scopes: bool) -> &'static [DeviceScope] {
    if allow_unsafe_development_scopes {
        &DEVELOPMENT_SCOPES
    } else {
        &DISTRIBUTABLE_SCOPES
    }
}

fn validate_assignable_scopes(
    scopes: &[DeviceScope],
    allow_unsafe_development_scopes: bool,
) -> Result<(), String> {
    let allowed = scopes_for_build(allow_unsafe_development_scopes);
    if let Some(scope) = scopes.iter().find(|scope| !allowed.contains(scope)) {
        return Err(format!(
            "device scope {scope:?} is unavailable in this build"
        ));
    }
    Ok(())
}

fn sanitize_loaded_scopes(scopes: Vec<DeviceScope>) -> Vec<DeviceScope> {
    let allowed = supported_scopes();
    normalize_scopes(
        scopes
            .into_iter()
            .filter(|scope| allowed.contains(scope))
            .collect(),
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DeviceIdentity {
    pub device_id: String,
    pub device_name: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AuthenticatedDevice {
    pub identity: DeviceIdentity,
    /// Runtime-only credential generation. It changes on issue/rotation and
    /// process reload, so an auth decision can be revalidated after upgrade.
    pub generation: uuid::Uuid,
}

pub(crate) struct IssuedDeviceCredential {
    pub token: String,
    /// Generation replaced for this stable device ID, if it was already paired.
    pub retired_generation: Option<uuid::Uuid>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RetiredDeviceCredential {
    /// Stable identity plus the exact process-local generation removed by the
    /// committed mutation. Delayed runtime cleanup must match both fields.
    pub device_id: String,
    pub generation: uuid::Uuid,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct DeviceCredentialInfo {
    pub device_id: String,
    pub device_name: String,
    pub created_at: u64,
    pub scopes: Vec<DeviceScope>,
    pub proof_key_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct UpdatedDeviceScopes {
    pub device_id: String,
    pub retired_generation: uuid::Uuid,
    pub generation: uuid::Uuid,
    pub scopes: Vec<DeviceScope>,
}

#[derive(Clone)]
struct DeviceCredential {
    identity: DeviceIdentity,
    created_at: u64,
    token_hash: [u8; 32],
    generation: uuid::Uuid,
    /// Stable random epoch binding relay renewal authority to this exact
    /// pairing. Scope changes retain it; re-pairing replaces it.
    pairing_epoch: String,
    scopes: Vec<DeviceScope>,
    /// Uncompressed SEC1 P-256 point. The corresponding private key never
    /// leaves the phone's Secure Enclave / AndroidKeyStore.
    proof_public_key: Option<Vec<u8>>,
}

#[derive(Serialize, Deserialize)]
struct PersistedCredentials {
    version: u8,
    devices: Vec<PersistedDeviceCredential>,
}

#[derive(Serialize, Deserialize)]
struct PersistedDeviceCredential {
    device_id: String,
    device_name: String,
    created_at: u64,
    token_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pairing_epoch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scopes: Option<Vec<DeviceScope>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    proof_public_key: Option<String>,
}

pub(crate) struct DeviceCredentialStore {
    path: Option<PathBuf>,
    credentials: RwLock<Vec<DeviceCredential>>,
}

impl DeviceCredentialStore {
    pub(crate) fn memory() -> Self {
        Self {
            path: None,
            credentials: RwLock::new(Vec::new()),
        }
    }

    pub(crate) fn persistent(path: PathBuf) -> Self {
        let (credentials, rewrite_loaded_file) = match load_credentials(&path) {
            Ok(credentials) => (credentials, path.exists()),
            Err(error) => {
                eprintln!("[device-auth] ignoring invalid credential file: {}", error);
                (Vec::new(), false)
            }
        };
        let store = Self {
            path: Some(path),
            credentials: RwLock::new(credentials),
        };
        // Loading may migrate v1 or strip capabilities unavailable in this
        // build. Persist the sanitized snapshot immediately so a later debug
        // run cannot resurrect stale development grants from disk.
        if rewrite_loaded_file {
            let snapshot = store.credentials.read().unwrap().clone();
            if let Err(error) = store.persist(&snapshot) {
                panic!(
                    "[device-auth] refusing startup because sanitized credentials could not be persisted: {error}"
                );
            }
        }
        store
    }

    pub(crate) fn validate_identity(
        device_id: &str,
        device_name: &str,
    ) -> Result<DeviceIdentity, String> {
        let device_id = device_id.trim();
        if device_id.is_empty()
            || device_id.len() > MAX_DEVICE_ID_BYTES
            || !device_id.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'@')
            })
        {
            return Err("invalid device_id".to_string());
        }

        let device_name = device_name.trim();
        if device_name.is_empty()
            || device_name.len() > MAX_DEVICE_NAME_BYTES
            || device_name.chars().any(char::is_control)
        {
            return Err("invalid device_name".to_string());
        }

        Ok(DeviceIdentity {
            device_id: device_id.to_string(),
            device_name: device_name.to_string(),
        })
    }

    /// Issue or rotate the credential for one stable device ID.
    pub(crate) fn issue(&self, device_id: &str, device_name: &str) -> Result<String, String> {
        self.issue_with_rotation(device_id, device_name)
            .map(|issued| issued.token)
    }

    pub(crate) fn issue_with_rotation(
        &self,
        device_id: &str,
        device_name: &str,
    ) -> Result<IssuedDeviceCredential, String> {
        self.issue_internal(device_id, device_name, None)
    }

    /// Issue a credential bound to a validated P-256 proof key.
    pub(crate) fn issue_with_proof_rotation(
        &self,
        device_id: &str,
        device_name: &str,
        proof_public_key: &str,
    ) -> Result<IssuedDeviceCredential, String> {
        let proof_public_key = super::pop::decode_public_key(proof_public_key)?;
        self.issue_internal(device_id, device_name, Some(proof_public_key))
    }

    fn issue_internal(
        &self,
        device_id: &str,
        device_name: &str,
        proof_public_key: Option<Vec<u8>>,
    ) -> Result<IssuedDeviceCredential, String> {
        let identity = Self::validate_identity(device_id, device_name)?;
        let token = format!("mtd_{}", super::generate_token());
        // The proof-less path exists only for legacy unit-test fixtures. A
        // production credential without a bound key must never receive a
        // sensitive scope, even in a development build.
        let scopes = if proof_public_key.is_some() || cfg!(test) {
            default_scopes()
        } else {
            Vec::new()
        };
        let credential = DeviceCredential {
            identity: identity.clone(),
            created_at: now_secs(),
            token_hash: hash_token(&token),
            generation: uuid::Uuid::new_v4(),
            pairing_epoch: generate_pairing_epoch(),
            scopes,
            proof_public_key,
        };

        let mut current = self.credentials.write().unwrap();
        let mut next = current.clone();
        let mut retired_generation = None;
        if let Some(existing) = next
            .iter_mut()
            .find(|entry| entry.identity.device_id == identity.device_id)
        {
            retired_generation = Some(existing.generation);
            *existing = credential;
        } else {
            if next.len() >= MAX_DEVICE_CREDENTIALS {
                return Err("device credential limit reached".to_string());
            }
            next.push(credential);
        }

        self.persist(&next)?;
        *current = next;
        Ok(IssuedDeviceCredential {
            token,
            retired_generation,
        })
    }

    /// Scan the bounded credential set without an early return.
    pub(crate) fn authenticate(&self, token: &str) -> Option<AuthenticatedDevice> {
        let candidate = hash_token(token);
        let credentials = self.credentials.read().unwrap();
        let mut matched = None;
        for credential in credentials.iter() {
            if constant_time_eq(&candidate, &credential.token_hash) {
                matched = Some(AuthenticatedDevice {
                    identity: credential.identity.clone(),
                    generation: credential.generation,
                });
            }
        }
        matched
    }

    /// Revalidate a prior authentication decision after a long-lived socket
    /// has registered itself. Rotation/revocation changes or removes the UUID.
    pub(crate) fn is_current(&self, device_id: &str, generation: uuid::Uuid) -> bool {
        self.credentials.read().unwrap().iter().any(|credential| {
            credential.identity.device_id == device_id && credential.generation == generation
        })
    }

    pub(crate) fn has_scope(
        &self,
        device_id: &str,
        generation: uuid::Uuid,
        scope: DeviceScope,
    ) -> bool {
        self.credentials.read().unwrap().iter().any(|credential| {
            credential.identity.device_id == device_id
                && credential.generation == generation
                && credential.scopes.contains(&scope)
        })
    }

    pub(crate) fn scopes(
        &self,
        device_id: &str,
        generation: uuid::Uuid,
    ) -> Option<Vec<DeviceScope>> {
        self.credentials
            .read()
            .unwrap()
            .iter()
            .find(|credential| {
                credential.identity.device_id == device_id && credential.generation == generation
            })
            .map(|credential| credential.scopes.clone())
    }

    pub(crate) fn proof_public_key(
        &self,
        device_id: &str,
        generation: uuid::Uuid,
    ) -> Option<Vec<u8>> {
        self.credentials
            .read()
            .unwrap()
            .iter()
            .find(|credential| {
                credential.identity.device_id == device_id && credential.generation == generation
            })
            .and_then(|credential| credential.proof_public_key.clone())
    }

    /// Replace one device's capabilities without changing its bearer token.
    /// The runtime generation is always rotated so in-flight WebSockets and
    /// previously authenticated requests immediately become stale.
    pub(crate) fn update_scopes(
        &self,
        device_id: &str,
        scopes: Vec<DeviceScope>,
    ) -> Result<Option<UpdatedDeviceScopes>, String> {
        let scopes = normalize_scopes(scopes);
        validate_supported_scopes(&scopes)?;
        let mut current = self.credentials.write().unwrap();
        let Some(index) = current
            .iter()
            .position(|entry| entry.identity.device_id == device_id)
        else {
            return Ok(None);
        };
        if !scopes.is_empty() && current[index].proof_public_key.is_none() && !cfg!(test) {
            return Err("device has no proof-of-possession key; re-pair it first".to_string());
        }

        let mut next = current.clone();
        let retired_generation = next[index].generation;
        let generation = uuid::Uuid::new_v4();
        next[index].generation = generation;
        next[index].scopes = scopes.clone();
        self.persist(&next)?;
        *current = next;
        Ok(Some(UpdatedDeviceScopes {
            device_id: device_id.to_string(),
            retired_generation,
            generation,
            scopes,
        }))
    }

    /// Execute a short synchronous operation while proving both the exact
    /// device generation and a sensitive scope. Scope updates need the write
    /// lock, so they cannot race the protected read/export operation.
    pub(crate) fn with_current_scope<T>(
        &self,
        device_id: &str,
        generation: uuid::Uuid,
        scope: DeviceScope,
        operation: impl FnOnce() -> T,
    ) -> Option<T> {
        let credentials = self.credentials.read().unwrap();
        credentials
            .iter()
            .any(|credential| {
                credential.identity.device_id == device_id
                    && credential.generation == generation
                    && credential.scopes.contains(&scope)
            })
            .then(operation)
    }

    /// Execute a synchronous commit while a read lock proves that this exact
    /// credential generation is still current. Credential rotation/revocation
    /// takes the write lock, so it is ordered either wholly before or wholly
    /// after the commit instead of racing a check-then-insert sequence.
    pub(crate) fn with_current_generation<T>(
        &self,
        device_id: &str,
        generation: uuid::Uuid,
        commit: impl FnOnce() -> T,
    ) -> Option<T> {
        let credentials = self.credentials.read().unwrap();
        credentials
            .iter()
            .any(|credential| {
                credential.identity.device_id == device_id && credential.generation == generation
            })
            .then(commit)
    }

    /// Run a relay capability mint while holding the credential-store read
    /// lock. This makes the generation, non-empty scopes, pairing epoch and
    /// PoP key one atomic authorization snapshot with respect to scope update,
    /// credential rotation and revocation.
    pub(crate) fn with_current_relay_binding<T>(
        &self,
        device_id: &str,
        generation: uuid::Uuid,
        operation: impl FnOnce(&str, &[DeviceScope], &[u8]) -> T,
    ) -> Option<T> {
        let credentials = self.credentials.read().unwrap();
        let credential = credentials.iter().find(|credential| {
            credential.identity.device_id == device_id && credential.generation == generation
        })?;
        if credential.scopes.is_empty() {
            return None;
        }
        let proof_public_key = credential.proof_public_key.as_deref()?;
        Some(operation(
            &credential.pairing_epoch,
            &credential.scopes,
            proof_public_key,
        ))
    }

    #[cfg(test)]
    fn pairing_epoch(&self, device_id: &str, generation: uuid::Uuid) -> Option<String> {
        self.credentials
            .read()
            .unwrap()
            .iter()
            .find(|credential| {
                credential.identity.device_id == device_id && credential.generation == generation
            })
            .map(|credential| credential.pairing_epoch.clone())
    }

    pub(crate) fn revoke_all(&self) -> Result<Vec<RetiredDeviceCredential>, String> {
        let mut current = self.credentials.write().unwrap();
        let retired = current
            .iter()
            .map(|credential| RetiredDeviceCredential {
                device_id: credential.identity.device_id.clone(),
                generation: credential.generation,
            })
            .collect();
        self.persist(&[])?;
        current.clear();
        Ok(retired)
    }

    pub(crate) fn list(&self) -> Vec<DeviceCredentialInfo> {
        self.credentials
            .read()
            .unwrap()
            .iter()
            .map(|credential| DeviceCredentialInfo {
                device_id: credential.identity.device_id.clone(),
                device_name: credential.identity.device_name.clone(),
                created_at: credential.created_at,
                scopes: credential.scopes.clone(),
                proof_key_id: credential
                    .proof_public_key
                    .as_deref()
                    .map(super::pop::key_thumbprint),
            })
            .collect()
    }

    pub(crate) fn revoke_device(
        &self,
        device_id: &str,
    ) -> Result<Option<RetiredDeviceCredential>, String> {
        let mut current = self.credentials.write().unwrap();
        let Some(index) = current
            .iter()
            .position(|entry| entry.identity.device_id == device_id)
        else {
            return Ok(None);
        };
        let retired = RetiredDeviceCredential {
            device_id: current[index].identity.device_id.clone(),
            generation: current[index].generation,
        };
        let mut next = current.clone();
        next.remove(index);
        self.persist(&next)?;
        *current = next;
        Ok(Some(retired))
    }

    /// Revoke only if the request still represents the currently stored
    /// credential generation. This makes self-unpair safe against rotation
    /// racing an already-authenticated REST request.
    pub(crate) fn revoke_generation(
        &self,
        device_id: &str,
        generation: uuid::Uuid,
    ) -> Result<bool, String> {
        let mut current = self.credentials.write().unwrap();
        let Some(index) = current.iter().position(|entry| {
            entry.identity.device_id == device_id && entry.generation == generation
        }) else {
            return Ok(false);
        };
        let mut next = current.clone();
        next.remove(index);
        self.persist(&next)?;
        *current = next;
        Ok(true)
    }

    fn persist(&self, credentials: &[DeviceCredential]) -> Result<(), String> {
        let Some(path) = self.path.as_deref() else {
            return Ok(());
        };

        let persisted = PersistedCredentials {
            version: FILE_VERSION,
            devices: credentials
                .iter()
                .map(|credential| PersistedDeviceCredential {
                    device_id: credential.identity.device_id.clone(),
                    device_name: credential.identity.device_name.clone(),
                    created_at: credential.created_at,
                    token_sha256: hex_encode(&credential.token_hash),
                    pairing_epoch: Some(credential.pairing_epoch.clone()),
                    scopes: Some(credential.scopes.clone()),
                    proof_public_key: credential
                        .proof_public_key
                        .as_deref()
                        .map(super::pop::encode_public_key),
                })
                .collect(),
        };
        let bytes = serde_json::to_vec_pretty(&persisted)
            .map_err(|error| format!("serialize device credentials: {}", error))?;
        atomic_write_private(path, &bytes)
    }
}

fn load_credentials(path: &Path) -> Result<Vec<DeviceCredential>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("read {}: {}", path.display(), error)),
    };
    let persisted: PersistedCredentials = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse {}: {}", path.display(), error))?;
    if !matches!(
        persisted.version,
        LEGACY_FILE_VERSION | LEGACY_FILE_VERSION_2 | LEGACY_FILE_VERSION_3 | FILE_VERSION
    ) {
        return Err(format!(
            "unsupported credential version {}",
            persisted.version
        ));
    }
    let uses_legacy_scope_defaults = matches!(
        persisted.version,
        LEGACY_FILE_VERSION | LEGACY_FILE_VERSION_2
    );
    let has_persisted_pairing_epoch = persisted.version == FILE_VERSION;
    if persisted.devices.len() > MAX_DEVICE_CREDENTIALS {
        return Err("too many persisted device credentials".to_string());
    }

    let mut credentials = Vec::with_capacity(persisted.devices.len());
    for device in persisted.devices {
        let identity =
            DeviceCredentialStore::validate_identity(&device.device_id, &device.device_name)?;
        if credentials
            .iter()
            .any(|entry: &DeviceCredential| entry.identity.device_id == identity.device_id)
        {
            return Err("duplicate persisted device_id".to_string());
        }
        let proof_public_key = match device.proof_public_key.as_deref() {
            Some(value) => Some(super::pop::decode_public_key(value)?),
            None => None,
        };
        let loaded_scopes = if proof_public_key.is_none() && !cfg!(test) {
            // Builds before v3 issued copyable bearer-only credentials. They
            // remain revocable/listable but can no longer carry capabilities.
            Vec::new()
        } else if uses_legacy_scope_defaults {
            legacy_default_scopes()
        } else {
            sanitize_loaded_scopes(
                device
                    .scopes
                    .ok_or_else(|| "missing persisted device scopes".to_string())?,
            )
        };
        credentials.push(DeviceCredential {
            identity,
            created_at: device.created_at,
            token_hash: hex_decode_32(&device.token_sha256)?,
            generation: uuid::Uuid::new_v4(),
            pairing_epoch: if has_persisted_pairing_epoch {
                canonical_pairing_epoch(
                    device
                        .pairing_epoch
                        .as_deref()
                        .ok_or_else(|| "missing persisted pairing epoch".to_string())?,
                )?
            } else {
                generate_pairing_epoch()
            },
            scopes: loaded_scopes,
            proof_public_key,
        });
    }
    Ok(credentials)
}

fn generate_pairing_epoch() -> String {
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn canonical_pairing_epoch(value: &str) -> Result<String, String> {
    if value.len() != 22 {
        return Err("invalid persisted pairing epoch".to_string());
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| "invalid persisted pairing epoch".to_string())?;
    if decoded.len() != 16 || URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err("invalid persisted pairing epoch".to_string());
    }
    Ok(value.to_string())
}

fn hash_token(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn constant_time_eq(left: &[u8; 32], right: &[u8; 32]) -> bool {
    let mut difference = 0u8;
    for (left, right) in left.iter().zip(right.iter()) {
        difference |= left ^ right;
    }
    difference == 0
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn hex_decode_32(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid persisted token hash".to_string());
    }
    let mut output = [0u8; 32];
    for (index, byte) in output.iter_mut().enumerate() {
        let offset = index * 2;
        *byte = u8::from_str_radix(&value[offset..offset + 2], 16)
            .map_err(|_| "invalid persisted token hash".to_string())?;
    }
    Ok(output)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
#[path = "device_auth_tests.rs"]
mod tests;
