//! Authority-bound relay configuration persistence.
//!
//! Relay URL/pin/enabled metadata remains in the private app-data file, while
//! registration and push secrets live in the OS credential vault. Because no
//! affected build has shipped, legacy plaintext secrets are never trusted or
//! rebound. Ordinary startup preserves legacy/malformed sources and returns a
//! disabled configuration without touching the vault; cleanup is reserved for
//! an explicit maintenance/reset operation that requires fresh secrets.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tokio_tungstenite::tungstenite::http::Uri;

use super::private_file::atomic_write_private;

#[cfg(debug_assertions)]
const VAULT_SERVICE: &str = "com.meterm.dev.relay.v2";
#[cfg(not(debug_assertions))]
const VAULT_SERVICE: &str = "com.meterm.app.relay.v2";
const METADATA_VERSION: u8 = 2;
const VAULT_VERSION: u8 = 1;
const MAX_CONFIG_BYTES: usize = 64 * 1024;
static RELAY_CONFIG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, PartialEq, Eq)]
pub struct RelayConfig {
    /// Relay root, for example `wss://relay.example.com:8443`.
    pub url: String,
    /// Per-desktop registration secret. Runtime-only; never serialized to the
    /// metadata file after migration.
    pub token: String,
    /// Dedicated per-desktop push secret. Runtime-only after migration.
    pub push_token: Option<String>,
    /// Pinned relay leaf-certificate SHA-256 fingerprint.
    pub cert_fp: String,
    pub enabled: bool,
}

impl std::fmt::Debug for RelayConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RelayConfig")
            .field(
                "configured",
                &(!self.url.is_empty() && !self.cert_fp.is_empty()),
            )
            .field("enabled", &self.enabled)
            .finish_non_exhaustive()
    }
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            token: String::new(),
            push_token: None,
            cert_fp: String::new(),
            enabled: false,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RelayMetadata {
    version: u8,
    url: String,
    cert_fp: String,
    enabled: bool,
}

/// Reads both the former plaintext shape and the v2 metadata-only shape.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredRelayConfig {
    #[serde(default)]
    version: u8,
    url: String,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    push_token: Option<String>,
    cert_fp: String,
    enabled: bool,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct BoundRelaySecrets {
    version: u8,
    url: String,
    cert_fp: String,
    registration_token: String,
    push_token: String,
}

struct StoredSnapshot {
    digest: [u8; 32],
    /// `None` means the bytes were readable and digestible but were not a
    /// valid bounded relay document. Startup leaves it for explicit reset.
    stored: Option<StoredRelayConfig>,
}

pub(super) fn relay_config_path(state_dir: &str) -> String {
    let name = if cfg!(debug_assertions) {
        "relay-config-dev.json"
    } else {
        "relay-config.json"
    };
    format!("{}/{}", state_dir, name)
}

fn vault_account(state_dir: &str) -> String {
    #[cfg(test)]
    {
        let digest = Sha256::digest(state_dir.as_bytes());
        return format!("relay:test:{}", hex::encode(&digest[..12]));
    }
    #[cfg(not(test))]
    {
        let _ = state_dir;
        if cfg!(debug_assertions) {
            "relay:development".to_string()
        } else {
            "relay:release".to_string()
        }
    }
}

#[cfg(test)]
mod hex {
    pub(super) fn encode(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}

#[cfg(test)]
fn test_vault() -> &'static Mutex<std::collections::HashMap<String, String>> {
    static VAULT: OnceLock<Mutex<std::collections::HashMap<String, String>>> = OnceLock::new();
    VAULT.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn load_vault_raw(state_dir: &str) -> Result<Option<String>, String> {
    let account = vault_account(state_dir);
    #[cfg(test)]
    {
        return test_vault()
            .lock()
            .map_err(|_| "relay test vault is unavailable".to_string())
            .map(|vault| vault.get(&account).cloned());
    }
    #[cfg(not(test))]
    {
        let entry = keyring::Entry::new(VAULT_SERVICE, &account)
            .map_err(|_| "relay credential vault is unavailable".to_string())?;
        match entry.get_password() {
            Ok(raw) => Ok(Some(raw)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("failed to read relay credential vault".to_string()),
        }
    }
}

fn store_vault_raw(state_dir: &str, raw: &str) -> Result<(), String> {
    let account = vault_account(state_dir);
    #[cfg(test)]
    {
        test_vault()
            .lock()
            .map_err(|_| "relay test vault is unavailable".to_string())?
            .insert(account, raw.to_string());
        return Ok(());
    }
    #[cfg(not(test))]
    {
        keyring::Entry::new(VAULT_SERVICE, &account)
            .map_err(|_| "relay credential vault is unavailable".to_string())?
            .set_password(raw)
            .map_err(|_| "failed to write relay credential vault".to_string())
    }
}

fn create_vault_raw(state_dir: &str, raw: &str) -> Result<(), String> {
    let account = vault_account(state_dir);
    #[cfg(test)]
    {
        let mut vault = test_vault()
            .lock()
            .map_err(|_| "relay test vault is unavailable".to_string())?;
        if vault.contains_key(&account) {
            return Err("relay credential target already exists".to_string());
        }
        vault.insert(account, raw.to_string());
        return Ok(());
    }
    #[cfg(all(not(test), target_os = "macos"))]
    {
        use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};

        let keychain = SecKeychain::default_for_domain(SecPreferencesDomain::User)
            .map_err(|_| "relay credential vault is unavailable".to_string())?;
        // The relay account is deterministic. Add-only creation prevents a
        // pre-created item with an unrelated ACL from being overwritten with
        // the desktop's relay secrets.
        return keychain
            .add_generic_password(VAULT_SERVICE, &account, raw.as_bytes())
            .map_err(|_| "failed to create relay credential vault".to_string());
    }
    #[cfg(all(not(test), not(target_os = "macos")))]
    {
        let entry = keyring::Entry::new(VAULT_SERVICE, &account)
            .map_err(|_| "relay credential vault is unavailable".to_string())?;
        match entry.get_password() {
            Err(keyring::Error::NoEntry) => {}
            Ok(_) => return Err("relay credential target already exists".to_string()),
            Err(_) => return Err("failed to inspect relay credential target".to_string()),
        }
        entry
            .set_password(raw)
            .map_err(|_| "failed to create relay credential vault".to_string())
    }
}

fn delete_vault_raw(state_dir: &str) -> Result<(), String> {
    let account = vault_account(state_dir);
    #[cfg(test)]
    {
        test_vault()
            .lock()
            .map_err(|_| "relay test vault is unavailable".to_string())?
            .remove(&account);
        return Ok(());
    }
    #[cfg(not(test))]
    {
        let entry = keyring::Entry::new(VAULT_SERVICE, &account)
            .map_err(|_| "relay credential vault is unavailable".to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("failed to delete relay credential vault".to_string()),
        }
    }
}

fn restore_vault_raw(state_dir: &str, previous: Option<&str>) -> Result<(), String> {
    match previous {
        Some(raw) => store_vault_raw(state_dir, raw),
        None => delete_vault_raw(state_dir),
    }
}

pub(super) fn validate_relay_endpoint(url: &str, cert_fp: &str) -> Result<Uri, String> {
    let uri: Uri = url.parse().map_err(|_| "invalid relay URL".to_string())?;
    if uri.scheme_str() != Some("wss")
        || uri.host().is_none_or(str::is_empty)
        || uri
            .authority()
            .is_some_and(|authority| authority.as_str().contains('@'))
        || !matches!(uri.path(), "" | "/")
        || uri.query().is_some()
    {
        return Err("relay URL must be a root wss:// endpoint without credentials or query".into());
    }
    if cert_fp.len() != 64 || !cert_fp.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("relay certificate fingerprint must be 64 hexadecimal characters".into());
    }
    Ok(uri)
}

pub(super) fn validate_secret(secret: &str) -> Result<(), String> {
    if secret.len() != 64 || !secret.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("relay secret must be exactly 64 hexadecimal characters".into());
    }
    Ok(())
}

pub(super) fn validate_relay_config(config: &RelayConfig) -> Result<(), String> {
    if *config == RelayConfig::default() {
        return Ok(());
    }
    validate_relay_endpoint(&config.url, &config.cert_fp)?;
    validate_secret(&config.token)?;
    let push_token = config
        .push_token
        .as_deref()
        .filter(|token| !token.is_empty())
        .ok_or_else(|| "dedicated per-desktop relay push secret is required".to_string())?;
    validate_secret(push_token)?;
    if push_token == config.token {
        return Err("dedicated relay registration and push secrets must differ".into());
    }
    Ok(())
}

fn metadata_for(config: &RelayConfig) -> RelayMetadata {
    RelayMetadata {
        version: METADATA_VERSION,
        url: config.url.clone(),
        cert_fp: config.cert_fp.to_lowercase(),
        enabled: config.enabled,
    }
}

fn validate_metadata(metadata: &RelayMetadata) -> Result<(), String> {
    if metadata.version != METADATA_VERSION {
        return Err("unsupported relay metadata version".to_string());
    }
    if metadata.url.is_empty() && metadata.cert_fp.is_empty() && !metadata.enabled {
        return Ok(());
    }
    validate_relay_endpoint(&metadata.url, &metadata.cert_fp).map(|_| ())
}

fn record_for(config: &RelayConfig) -> Result<BoundRelaySecrets, String> {
    validate_relay_config(config)?;
    if *config == RelayConfig::default() {
        return Err("empty relay configuration has no credential record".to_string());
    }
    Ok(BoundRelaySecrets {
        version: VAULT_VERSION,
        url: config.url.clone(),
        cert_fp: config.cert_fp.to_lowercase(),
        registration_token: config.token.clone(),
        push_token: config.push_token.clone().unwrap_or_default(),
    })
}

fn decode_record(raw: &str) -> Result<BoundRelaySecrets, String> {
    if raw.len() > MAX_CONFIG_BYTES {
        return Err("relay credential record is too large".to_string());
    }
    let mut record: BoundRelaySecrets =
        serde_json::from_str(raw).map_err(|_| "invalid relay credential record".to_string())?;
    record.cert_fp.make_ascii_lowercase();
    if record.version != VAULT_VERSION {
        return Err("unsupported relay credential version".to_string());
    }
    let config = RelayConfig {
        url: record.url.clone(),
        token: record.registration_token.clone(),
        push_token: Some(record.push_token.clone()),
        cert_fp: record.cert_fp.clone(),
        enabled: false,
    };
    validate_relay_config(&config)?;
    Ok(record)
}

fn write_record(
    state_dir: &str,
    record: &BoundRelaySecrets,
    create_only: bool,
) -> Result<(), String> {
    let raw = serde_json::to_string(record)
        .map_err(|_| "failed to encode relay credential record".to_string())?;
    if create_only {
        create_vault_raw(state_dir, &raw)
    } else {
        store_vault_raw(state_dir, &raw)
    }
}

fn validate_existing_vault_provenance(path: &Path, raw: &str) -> Result<BoundRelaySecrets, String> {
    let snapshot = read_snapshot(path)?
        .ok_or_else(|| "relay credential target requires explicit reset".to_string())?;
    let stored = snapshot
        .stored
        .ok_or_else(|| "relay credential target requires explicit reset".to_string())?;
    if stored.version != METADATA_VERSION || stored.token.is_some() || stored.push_token.is_some() {
        return Err("relay credential target requires explicit reset".to_string());
    }
    let metadata = metadata_from_stored(&stored)?;
    if metadata.url.is_empty() {
        return Err("relay credential target requires explicit reset".to_string());
    }
    let record = decode_record(raw)?;
    if record.url != metadata.url || !record.cert_fp.eq_ignore_ascii_case(&metadata.cert_fp) {
        return Err("relay credential authority mismatch".to_string());
    }
    Ok(record)
}

fn write_metadata(path: &Path, metadata: &RelayMetadata) -> Result<(), String> {
    validate_metadata(metadata)?;
    let bytes = serde_json::to_vec_pretty(metadata)
        .map_err(|_| "failed to encode relay metadata".to_string())?;
    atomic_write_private(path, &bytes)
}

fn read_snapshot(path: &Path) -> Result<Option<StoredSnapshot>, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("failed to read relay metadata".to_string()),
    };
    let stored = (bytes.len() <= MAX_CONFIG_BYTES)
        .then(|| serde_json::from_slice::<StoredRelayConfig>(&bytes).ok())
        .flatten();
    Ok(Some(StoredSnapshot {
        digest: Sha256::digest(&bytes).into(),
        stored,
    }))
}

fn verify_snapshot(path: &Path, expected: &[u8; 32]) -> Result<(), String> {
    let bytes = std::fs::read(path)
        .map_err(|_| "relay metadata changed during credential migration".to_string())?;
    let current: [u8; 32] = Sha256::digest(bytes).into();
    if &current == expected {
        Ok(())
    } else {
        Err("relay metadata changed during credential migration".to_string())
    }
}

fn metadata_from_stored(stored: &StoredRelayConfig) -> Result<RelayMetadata, String> {
    let metadata = RelayMetadata {
        version: METADATA_VERSION,
        url: stored.url.clone(),
        cert_fp: stored.cert_fp.to_lowercase(),
        enabled: stored.enabled,
    };
    validate_metadata(&metadata)?;
    Ok(metadata)
}

fn config_from_metadata(state_dir: &str, metadata: RelayMetadata) -> Result<RelayConfig, String> {
    validate_metadata(&metadata)?;
    if metadata.url.is_empty() {
        // Startup is read-only for disabled relay state. Orphan cleanup is an
        // explicit save/reset operation so a stale ACL cannot trigger an OS
        // credential prompt merely because MeTerm launched.
        return Ok(RelayConfig::default());
    }
    if !metadata.enabled {
        return Ok(RelayConfig {
            url: metadata.url,
            token: String::new(),
            push_token: None,
            cert_fp: metadata.cert_fp,
            enabled: false,
        });
    }
    let Some(raw) = load_vault_raw(state_dir)? else {
        return Err("relay credential is missing".to_string());
    };
    let record = decode_record(&raw)?;
    if record.url != metadata.url || !record.cert_fp.eq_ignore_ascii_case(&metadata.cert_fp) {
        return Err("relay credential authority mismatch".to_string());
    }
    let config = RelayConfig {
        url: metadata.url,
        token: record.registration_token,
        push_token: Some(record.push_token),
        cert_fp: metadata.cert_fp,
        enabled: metadata.enabled,
    };
    validate_relay_config(&config)?;
    Ok(config)
}

#[allow(dead_code)]
fn migrate_legacy_for_explicit_maintenance_locked(
    state_dir: &str,
    path: &Path,
    snapshot: StoredSnapshot,
) -> Result<RelayConfig, String> {
    // The legacy file held authority and secrets in one WebView/shell-writable
    // record. Rebinding either its plaintext or an existing vault record would
    // let a tampered file turn the desktop into a confused deputy. Preserve a
    // syntactically valid URL/pin only as disabled display metadata; otherwise
    // clear the metadata too.
    let stored = snapshot
        .stored
        .as_ref()
        .ok_or_else(|| "invalid relay migration snapshot".to_string())?;
    let mut metadata = RelayMetadata {
        version: METADATA_VERSION,
        url: stored.url.clone(),
        cert_fp: stored.cert_fp.to_lowercase(),
        enabled: false,
    };
    if validate_metadata(&metadata).is_err() {
        metadata = metadata_for(&RelayConfig::default());
    }

    verify_snapshot(path, &snapshot.digest)?;
    delete_vault_raw(state_dir)?;
    verify_snapshot(path, &snapshot.digest)?;
    write_metadata(path, &metadata)?;

    Ok(RelayConfig {
        url: metadata.url,
        token: String::new(),
        push_token: None,
        cert_fp: metadata.cert_fp,
        enabled: false,
    })
}

#[allow(dead_code)]
fn scrub_invalid_for_explicit_maintenance_locked(
    state_dir: &str,
    path: &Path,
    digest: &[u8; 32],
) -> Result<RelayConfig, String> {
    // A malformed readable file may still contain legacy plaintext. Verify
    // the exact source twice around vault deletion, then atomically replace it
    // with a disabled/default metadata document. Any I/O/vault failure remains
    // an error and is retried; it is never reported as a successful scrub.
    verify_snapshot(path, digest)?;
    delete_vault_raw(state_dir)?;
    verify_snapshot(path, digest)?;
    let config = RelayConfig::default();
    write_metadata(path, &metadata_for(&config))?;
    Ok(config)
}

fn try_load_locked(state_dir: &str) -> Result<RelayConfig, String> {
    let path = PathBuf::from(relay_config_path(state_dir));
    let Some(mut snapshot) = read_snapshot(&path)? else {
        return Ok(RelayConfig::default());
    };
    let Some(stored) = snapshot.stored.take() else {
        return Err("relay configuration requires explicit reset".to_string());
    };
    let needs_migration =
        stored.version != METADATA_VERSION || stored.token.is_some() || stored.push_token.is_some();
    snapshot.stored = Some(stored);
    if needs_migration {
        return Err("legacy relay configuration requires explicit reset".to_string());
    }
    let metadata = metadata_from_stored(
        snapshot
            .stored
            .as_ref()
            .ok_or_else(|| "invalid relay metadata".to_string())?,
    )?;
    config_from_metadata(state_dir, metadata)
}

fn save_locked(state_dir: &str, config: &RelayConfig) -> Result<(), String> {
    validate_relay_config(config)?;
    let path = PathBuf::from(relay_config_path(state_dir));
    let metadata = metadata_for(config);

    if *config == RelayConfig::default() {
        // Make the file non-authoritative before deleting an orphaned secret.
        write_metadata(&path, &metadata)?;
        return delete_vault_raw(state_dir);
    }

    let previous_raw = load_vault_raw(state_dir)?;
    if let Some(raw) = previous_raw.as_deref() {
        // Existing deterministic accounts may only be updated when a valid
        // current metadata document and the existing record agree on the old
        // authority. Orphans and legacy records require an explicit reset.
        validate_existing_vault_provenance(&path, raw)?;
    }
    let record = record_for(config)?;
    write_record(state_dir, &record, previous_raw.is_none())?;
    if let Err(error) = write_metadata(&path, &metadata) {
        let _ = restore_vault_raw(state_dir, previous_raw.as_deref());
        return Err(error);
    }
    Ok(())
}

pub(crate) fn load_relay_config(state_dir: &str) -> RelayConfig {
    let lock = RELAY_CONFIG_LOCK.get_or_init(|| Mutex::new(()));
    let Ok(_guard) = lock.lock() else {
        eprintln!("[relay-client] credential store lock unavailable");
        return RelayConfig::default();
    };
    match try_load_locked(state_dir) {
        Ok(config) => config,
        Err(_) => {
            eprintln!("[relay-client] stored configuration rejected");
            RelayConfig::default()
        }
    }
}

pub(super) fn save_relay_config(state_dir: &str, config: &RelayConfig) -> Result<(), String> {
    let _guard = RELAY_CONFIG_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "relay credential store is unavailable".to_string())?;
    save_locked(state_dir, config)
}

/// Empty secret fields preserve the existing bundle only for the exact same
/// URL and certificate pin. A changed authority must submit both replacements.
pub(super) fn updated_relay_config(
    previous: RelayConfig,
    url: String,
    token: String,
    push_token: Option<String>,
    cert_fp: String,
    enabled: bool,
) -> RelayConfig {
    let cert_fp = cert_fp.to_lowercase();
    let authority_changed = previous.url != url || !previous.cert_fp.eq_ignore_ascii_case(&cert_fp);
    let submitted_push_token = push_token.filter(|secret| !secret.is_empty());
    RelayConfig {
        url,
        token: if authority_changed || !token.is_empty() {
            token
        } else {
            previous.token
        },
        push_token: if authority_changed {
            submitted_push_token
        } else {
            submitted_push_token.or(previous.push_token)
        },
        cert_fp,
        enabled,
    }
}

/// Load-current + authority comparison + vault/file commit occur under one
/// lock, so concurrent WebView updates cannot preserve a stale secret bundle.
pub(super) fn update_relay_config(
    state_dir: &str,
    url: String,
    token: String,
    push_token: Option<String>,
    cert_fp: String,
    enabled: bool,
) -> Result<(), String> {
    let _guard = RELAY_CONFIG_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "relay credential store is unavailable".to_string())?;
    let previous = try_load_locked(state_dir)?;
    let next = updated_relay_config(previous, url, token, push_token, cert_fp, enabled);
    save_locked(state_dir, &next)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REGISTER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const PUSH: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn temp_state_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "meterm-relay-credential-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn legacy_plaintext_is_preserved_for_explicit_reset_without_startup_vault_access() {
        let dir = temp_state_dir("migration");
        let state_dir = dir.to_string_lossy().to_string();
        let path = PathBuf::from(relay_config_path(&state_dir));
        let legacy = serde_json::json!({
            "url": "wss://relay.example.com:8443",
            "token": REGISTER,
            "push_token": PUSH,
            "cert_fp": "ab".repeat(32),
            "enabled": true
        });
        std::fs::write(&path, serde_json::to_vec_pretty(&legacy).unwrap()).unwrap();

        write_record(
            &state_dir,
            &BoundRelaySecrets {
                version: VAULT_VERSION,
                url: "wss://relay.example.com:8443".to_string(),
                cert_fp: "ab".repeat(32),
                registration_token: "c".repeat(64),
                push_token: "d".repeat(64),
            },
            false,
        )
        .unwrap();

        let loaded = load_relay_config(&state_dir);
        assert_eq!(loaded, RelayConfig::default());
        assert!(load_vault_raw(&state_dir).unwrap().is_some());
        let preserved = std::fs::read_to_string(&path).unwrap();
        assert!(preserved.contains(REGISTER));
        assert!(preserved.contains(PUSH));
        assert_eq!(load_relay_config(&state_dir), RelayConfig::default());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn malformed_readable_config_is_preserved_for_explicit_reset() {
        let dir = temp_state_dir("malformed");
        let state_dir = dir.to_string_lossy().to_string();
        let path = PathBuf::from(relay_config_path(&state_dir));
        std::fs::write(
            &path,
            format!(r#"{{"token":"{REGISTER}","push_token":"{PUSH}""#),
        )
        .unwrap();
        write_record(
            &state_dir,
            &BoundRelaySecrets {
                version: VAULT_VERSION,
                url: "wss://relay.example.com:8443".to_string(),
                cert_fp: "ab".repeat(32),
                registration_token: "c".repeat(64),
                push_token: "d".repeat(64),
            },
            false,
        )
        .unwrap();

        assert_eq!(load_relay_config(&state_dir), RelayConfig::default());
        assert!(load_vault_raw(&state_dir).unwrap().is_some());
        let preserved = std::fs::read_to_string(&path).unwrap();
        assert!(preserved.contains(REGISTER));
        assert!(preserved.contains(PUSH));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn disabled_metadata_does_not_touch_relay_vault_on_startup() {
        let dir = temp_state_dir("disabled-no-vault-read");
        let state_dir = dir.to_string_lossy().to_string();
        let path = PathBuf::from(relay_config_path(&state_dir));
        let record = BoundRelaySecrets {
            version: VAULT_VERSION,
            url: "wss://relay.example.com:8443".to_string(),
            cert_fp: "ab".repeat(32),
            registration_token: REGISTER.to_string(),
            push_token: PUSH.to_string(),
        };
        write_record(&state_dir, &record, false).unwrap();
        write_metadata(
            &path,
            &RelayMetadata {
                version: METADATA_VERSION,
                url: record.url.clone(),
                cert_fp: record.cert_fp.clone(),
                enabled: false,
            },
        )
        .unwrap();

        let loaded = load_relay_config(&state_dir);
        assert!(!loaded.enabled);
        assert!(loaded.token.is_empty());
        assert_eq!(loaded.push_token, None);
        assert!(load_vault_raw(&state_dir).unwrap().is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_digest_detects_external_change_before_scrub() {
        let dir = temp_state_dir("digest");
        let state_dir = dir.to_string_lossy().to_string();
        let path = PathBuf::from(relay_config_path(&state_dir));
        let first = br#"{"url":"wss://relay.example.com","token":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","push_token":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","cert_fp":"abababababababababababababababababababababababababababababababab","enabled":true}"#;
        std::fs::write(&path, first).unwrap();
        let snapshot = read_snapshot(&path).unwrap().unwrap();
        std::fs::write(&path, b"{}").unwrap();
        assert!(verify_snapshot(&path, &snapshot.digest).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn relay_vault_namespace_matches_build_channel() {
        #[cfg(debug_assertions)]
        assert_eq!(VAULT_SERVICE, "com.meterm.dev.relay.v2");
        #[cfg(not(debug_assertions))]
        assert_eq!(VAULT_SERVICE, "com.meterm.app.relay.v2");
    }

    #[test]
    fn relay_vault_first_creation_is_add_only() {
        let dir = temp_state_dir("add-only");
        let state_dir = dir.to_string_lossy().to_string();
        create_vault_raw(&state_dir, "first").unwrap();
        assert!(create_vault_raw(&state_dir, "replacement").is_err());
        assert_eq!(
            load_vault_raw(&state_dir).unwrap().as_deref(),
            Some("first")
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn orphaned_relay_vault_record_is_not_overwritten() {
        let dir = temp_state_dir("orphan");
        let state_dir = dir.to_string_lossy().to_string();
        let orphan = BoundRelaySecrets {
            version: VAULT_VERSION,
            url: "wss://attacker.example.com:8443".to_string(),
            cert_fp: "cd".repeat(32),
            registration_token: "c".repeat(64),
            push_token: "d".repeat(64),
        };
        write_record(&state_dir, &orphan, false).unwrap();

        let config = RelayConfig {
            url: "wss://relay.example.com:8443".to_string(),
            token: REGISTER.to_string(),
            push_token: Some(PUSH.to_string()),
            cert_fp: "ab".repeat(32),
            enabled: true,
        };
        assert!(save_relay_config(&state_dir, &config).is_err());
        assert!(decode_record(&load_vault_raw(&state_dir).unwrap().unwrap()).unwrap() == orphan);
        assert!(!PathBuf::from(relay_config_path(&state_dir)).exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
