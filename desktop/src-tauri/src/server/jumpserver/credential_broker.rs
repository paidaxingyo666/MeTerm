//! Authority-bound JumpServer credentials.
//!
//! The WebView may create, replace, or delete a credential after the user
//! entered it, but it never receives a stored password/token back.  Consumers
//! can only materialize a record inside Rust after presenting the exact
//! connection authority it was bound to.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(debug_assertions)]
const SERVICE: &str = "com.meterm.dev.jumpserver.v3";
#[cfg(not(debug_assertions))]
const SERVICE: &str = "com.meterm.app.jumpserver.v3";
#[cfg(debug_assertions)]
const LEGACY_SERVICES: &[&str] = &[];
#[cfg(not(debug_assertions))]
const LEGACY_SERVICES: &[&str] = &[
    "com.meterm.app.jumpserver.v2",
    "com.meterm.app.jumpserver",
    "com.meterm.dev.jumpserver",
];
const MAX_NAME_BYTES: usize = 256;
const MAX_SECRET_BYTES: usize = 64 * 1024;
const MAX_RECORD_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpServerCredentialBinding {
    pub name: String,
    pub base_url: String,
    pub ssh_host: String,
    pub ssh_port: u16,
    pub username: String,
    pub auth_method: String,
    #[serde(default)]
    pub org_id: String,
    #[serde(default)]
    pub proxy_type: String,
    #[serde(default)]
    pub proxy_host: String,
    #[serde(default)]
    pub proxy_port: u16,
    #[serde(default)]
    pub proxy_username: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpServerCredentials {
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub api_token: Option<String>,
    #[serde(default)]
    pub proxy_password: Option<String>,
}

impl std::fmt::Debug for JumpServerCredentials {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("JumpServerCredentials(redacted)")
    }
}

#[derive(Deserialize, Serialize)]
struct BoundCredentialRecord {
    version: u8,
    binding: JumpServerCredentialBinding,
    credentials: JumpServerCredentials,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyCredentials {
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    api_token: Option<String>,
    #[serde(default)]
    proxy_password: Option<String>,
}

struct LegacyRecord {
    service: String,
    account: String,
    raw: String,
    credentials: JumpServerCredentials,
}

pub(crate) struct LegacyMigrationSnapshot {
    binding: JumpServerCredentialBinding,
    source_service: String,
    source_account: String,
    consent_digest: [u8; 32],
}

impl LegacyMigrationSnapshot {
    pub(crate) fn binding(&self) -> &JumpServerCredentialBinding {
        &self.binding
    }
}

pub(crate) enum LegacyMigrationPreparation {
    NotRequired(JumpServerCredentialStatus),
    RequiresConfirmation(LegacyMigrationSnapshot),
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpServerCredentialStatus {
    pub exists: bool,
    pub binding_matches: bool,
    pub has_password: bool,
    pub has_api_token: bool,
    pub has_proxy_password: bool,
}

fn validate_text(value: &str, max_bytes: usize, allow_empty: bool) -> Result<(), String> {
    if (!allow_empty && value.is_empty())
        || value.len() > max_bytes
        || value.chars().any(char::is_control)
    {
        Err("invalid JumpServer credential binding".to_string())
    } else {
        Ok(())
    }
}

fn normalize_host(value: &str) -> Result<String, String> {
    let value = value.trim();
    validate_text(value, 512, false)?;
    if value.chars().any(char::is_whitespace)
        || value
            .bytes()
            .any(|byte| matches!(byte, b'/' | b'\\' | b'@' | b'?' | b'#'))
    {
        return Err("invalid JumpServer credential binding".to_string());
    }

    // URL parsing gives us canonical IP/domain casing without accepting
    // userinfo, paths, queries, or fragments as part of an SSH authority.
    let parsed = reqwest::Url::parse(&format!("ssh://{value}"))
        .map_err(|_| "invalid JumpServer credential binding".to_string())?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
        || parsed.path() != ""
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("invalid JumpServer credential binding".to_string());
    }
    parsed
        .host_str()
        .filter(|host| !host.is_empty())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "invalid JumpServer credential binding".to_string())
}

pub fn normalize_binding(
    mut binding: JumpServerCredentialBinding,
) -> Result<JumpServerCredentialBinding, String> {
    binding.name = binding.name.trim().to_string();
    validate_text(&binding.name, MAX_NAME_BYTES, false)?;
    validate_text(binding.base_url.trim(), 2_048, false)?;
    binding.base_url = super::normalize_base_url(&binding.base_url)?;
    binding.ssh_host = normalize_host(&binding.ssh_host)?;
    if binding.ssh_port == 0 {
        return Err("invalid JumpServer credential binding".to_string());
    }
    binding.username = binding.username.trim().to_string();
    validate_text(&binding.username, 512, false)?;
    if !matches!(binding.auth_method.as_str(), "password" | "token") {
        return Err("invalid JumpServer credential binding".to_string());
    }
    binding.org_id = binding.org_id.trim().to_string();
    validate_text(&binding.org_id, 256, true)?;

    binding.proxy_type = binding.proxy_type.trim().to_ascii_lowercase();
    if binding.proxy_type.is_empty() {
        binding.proxy_host.clear();
        binding.proxy_port = 0;
        binding.proxy_username.clear();
    } else {
        if !matches!(binding.proxy_type.as_str(), "socks5" | "http") {
            return Err("invalid JumpServer credential binding".to_string());
        }
        binding.proxy_host = normalize_host(&binding.proxy_host)?;
        if binding.proxy_port == 0 {
            return Err("invalid JumpServer credential binding".to_string());
        }
        binding.proxy_username = binding.proxy_username.trim().to_string();
        validate_text(&binding.proxy_username, 512, true)?;
    }
    Ok(binding)
}

fn account(name: &str) -> Result<String, String> {
    let name = name.trim();
    validate_text(name, MAX_NAME_BYTES, false)?;
    Ok(format!("bound:{name}"))
}

fn entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, account).map_err(|error| format!("keyring init error: {error}"))
}

fn load_raw(service: &str, account: &str) -> Result<Option<String>, String> {
    match entry(service, account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("keyring get error: {error}")),
    }
}

fn store_raw(service: &str, account: &str, value: &str) -> Result<(), String> {
    entry(service, account)?
        .set_password(value)
        .map_err(|error| format!("keyring store error: {error}"))
}

#[cfg(target_os = "macos")]
fn create_raw(service: &str, account: &str, value: &str) -> Result<(), String> {
    use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};

    let keychain = SecKeychain::default_for_domain(SecPreferencesDomain::User)
        .map_err(|_| "JumpServer credential vault is unavailable".to_string())?;
    keychain
        .add_generic_password(service, account, value.as_bytes())
        .map_err(|_| "JumpServer credential target already exists".to_string())
}

#[cfg(not(target_os = "macos"))]
fn create_raw(service: &str, account: &str, value: &str) -> Result<(), String> {
    if load_raw(service, account)?.is_some() {
        return Err("JumpServer credential target already exists".to_string());
    }
    store_raw(service, account, value)
}

fn delete_raw(service: &str, account: &str) -> Result<(), String> {
    match entry(service, account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("keyring delete error: {error}")),
    }
}

fn validate_secret(value: &Option<String>) -> Result<(), String> {
    if value
        .as_ref()
        .is_some_and(|secret| secret.len() > MAX_SECRET_BYTES || secret.contains('\0'))
    {
        Err("invalid JumpServer credential".to_string())
    } else {
        Ok(())
    }
}

fn normalize_credentials(
    mut credentials: JumpServerCredentials,
) -> Result<JumpServerCredentials, String> {
    validate_secret(&credentials.password)?;
    validate_secret(&credentials.api_token)?;
    validate_secret(&credentials.proxy_password)?;
    if credentials.password.as_deref() == Some("") {
        credentials.password = None;
    }
    if credentials.api_token.as_deref() == Some("") {
        credentials.api_token = None;
    }
    if credentials.proxy_password.as_deref() == Some("") {
        credentials.proxy_password = None;
    }
    Ok(credentials)
}

fn decode_record(raw: &str) -> Result<BoundCredentialRecord, String> {
    if raw.len() > MAX_RECORD_BYTES {
        return Err("JumpServer credential record is too large".to_string());
    }
    let record: BoundCredentialRecord = serde_json::from_str(raw)
        .map_err(|_| "invalid JumpServer credential record".to_string())?;
    if record.version != 1 || normalize_binding(record.binding.clone())? != record.binding {
        return Err("invalid JumpServer credential record".to_string());
    }
    Ok(record)
}

fn store_record(
    account: &str,
    record: &BoundCredentialRecord,
    create_only: bool,
) -> Result<(), String> {
    let raw = serde_json::to_string(record)
        .map_err(|_| "failed to serialize JumpServer credential record".to_string())?;
    if raw.len() > MAX_RECORD_BYTES {
        return Err("JumpServer credential record is too large".to_string());
    }
    if create_only {
        create_raw(SERVICE, account, &raw)
    } else {
        store_raw(SERVICE, account, &raw)
    }
}

fn load_record(name: &str) -> Result<Option<BoundCredentialRecord>, String> {
    let account = account(name)?;
    load_raw(SERVICE, &account)?
        .map(|raw| decode_record(&raw))
        .transpose()
}

fn legacy_account_candidates(name: &str) -> Result<[String; 2], String> {
    Ok([name.trim().to_string(), account(name)?])
}

fn decode_legacy(raw: &str) -> Result<JumpServerCredentials, String> {
    if raw.len() > MAX_RECORD_BYTES {
        return Err("JumpServer credential record is too large".to_string());
    }
    let legacy: LegacyCredentials = serde_json::from_str(raw)
        .map_err(|_| "invalid legacy JumpServer credential record".to_string())?;
    normalize_credentials(JumpServerCredentials {
        password: legacy.password,
        api_token: legacy.api_token,
        proxy_password: legacy.proxy_password,
    })
}

fn load_legacy(name: &str) -> Result<Option<LegacyRecord>, String> {
    for service in LEGACY_SERVICES {
        for legacy_account in legacy_account_candidates(name)? {
            let Some(raw) = load_raw(service, &legacy_account)? else {
                continue;
            };
            let credentials = decode_legacy(&raw)?;
            return Ok(Some(LegacyRecord {
                service: (*service).to_string(),
                account: legacy_account,
                raw,
                credentials,
            }));
        }
    }
    Ok(None)
}

fn migration_digest(
    binding: &JumpServerCredentialBinding,
    service: &str,
    account: &str,
    raw: &str,
) -> Result<[u8; 32], String> {
    let binding = serde_json::to_vec(binding)
        .map_err(|_| "failed to snapshot JumpServer credential binding".to_string())?;
    let mut digest = Sha256::new();
    for component in [
        binding.as_slice(),
        service.as_bytes(),
        account.as_bytes(),
        raw.as_bytes(),
    ] {
        digest.update((component.len() as u64).to_be_bytes());
        digest.update(component);
    }
    Ok(digest.finalize().into())
}

fn delete_all_legacy(name: &str) -> Result<(), String> {
    let mut errors = Vec::new();
    for service in LEGACY_SERVICES {
        for legacy_account in legacy_account_candidates(name)? {
            if let Err(error) = delete_raw(service, &legacy_account) {
                errors.push(error);
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// Snapshot a legacy name-only record before native user-presence consent.
/// Neither the credential nor its digest crosses WebView IPC.
pub(crate) fn prepare_legacy_migration(
    binding: JumpServerCredentialBinding,
) -> Result<LegacyMigrationPreparation, String> {
    let binding = normalize_binding(binding)?;
    if let Some(existing) = load_record(&binding.name)? {
        let status = status_for(Some(existing), &binding);
        if status.binding_matches {
            // A successfully bound v3 record is authoritative. Removing a
            // stale legacy duplicate does not establish a new authority.
            delete_all_legacy(&binding.name)?;
        }
        return Ok(LegacyMigrationPreparation::NotRequired(status));
    }

    let Some(legacy) = load_legacy(&binding.name)? else {
        return Ok(LegacyMigrationPreparation::NotRequired(status_for(
            None, &binding,
        )));
    };
    let consent_digest = migration_digest(&binding, &legacy.service, &legacy.account, &legacy.raw)?;
    Ok(LegacyMigrationPreparation::RequiresConfirmation(
        LegacyMigrationSnapshot {
            binding,
            source_service: legacy.service,
            source_account: legacy.account,
            consent_digest,
        },
    ))
}

/// Commit exactly the authority and credential bytes shown at the native
/// confirmation boundary. Any change while the prompt is open fails closed.
pub(crate) fn commit_legacy_migration(
    snapshot: LegacyMigrationSnapshot,
) -> Result<JumpServerCredentialStatus, String> {
    let binding = normalize_binding(snapshot.binding.clone())?;
    if binding != snapshot.binding || load_record(&binding.name)?.is_some() {
        return Err("JumpServer credential changed during migration".to_string());
    }
    let raw = load_raw(&snapshot.source_service, &snapshot.source_account)?
        .ok_or_else(|| "JumpServer credential changed during migration".to_string())?;
    let current_digest = migration_digest(
        &binding,
        &snapshot.source_service,
        &snapshot.source_account,
        &raw,
    )?;
    if current_digest != snapshot.consent_digest {
        return Err("JumpServer credential changed during migration".to_string());
    }
    let credentials = decode_legacy(&raw)?;
    let account = account(&binding.name)?;
    let record = BoundCredentialRecord {
        version: 1,
        binding: binding.clone(),
        credentials,
    };
    store_record(&account, &record, true)?;
    delete_all_legacy(&binding.name)?;
    Ok(status_for(Some(record), &binding))
}

/// Store only credentials the user just entered. Missing fields are preserved
/// only when the exact authority is unchanged. An authority change requires a
/// replacement primary credential and never carries old secrets forward.
pub fn store_credentials(
    binding: JumpServerCredentialBinding,
    submitted: JumpServerCredentials,
) -> Result<JumpServerCredentialStatus, String> {
    let binding = normalize_binding(binding)?;
    let submitted = normalize_credentials(submitted)?;
    let account = account(&binding.name)?;
    let existing = load_record(&binding.name)?;
    let create_only = existing.is_none();
    let same_binding = existing
        .as_ref()
        .is_some_and(|record| record.binding == binding);

    let credentials = if same_binding {
        let mut credentials = existing.unwrap().credentials;
        if submitted.password.is_some() {
            credentials.password = submitted.password;
        }
        if submitted.api_token.is_some() {
            credentials.api_token = submitted.api_token;
        }
        if submitted.proxy_password.is_some() {
            credentials.proxy_password = submitted.proxy_password;
        }
        match binding.auth_method.as_str() {
            "password" => credentials.api_token = None,
            "token" => credentials.password = None,
            _ => {}
        }
        credentials
    } else {
        let has_primary = match binding.auth_method.as_str() {
            "password" => submitted.password.is_some(),
            "token" => submitted.api_token.is_some(),
            _ => false,
        };
        if !has_primary {
            return Err("jumpserver_credential_authority_changed".to_string());
        }
        submitted
    };

    let record = BoundCredentialRecord {
        version: 1,
        binding: binding.clone(),
        credentials,
    };
    store_record(&account, &record, create_only)?;
    delete_all_legacy(&binding.name)?;
    Ok(status_for(Some(record), &binding))
}

fn status_for(
    record: Option<BoundCredentialRecord>,
    binding: &JumpServerCredentialBinding,
) -> JumpServerCredentialStatus {
    let exists = record.is_some();
    let binding_matches = record
        .as_ref()
        .is_some_and(|record| &record.binding == binding);
    let credentials = record
        .filter(|record| &record.binding == binding)
        .map(|record| record.credentials)
        .unwrap_or_default();
    JumpServerCredentialStatus {
        exists,
        binding_matches,
        has_password: credentials.password.is_some(),
        has_api_token: credentials.api_token.is_some(),
        has_proxy_password: credentials.proxy_password.is_some(),
    }
}

pub fn status(binding: JumpServerCredentialBinding) -> Result<JumpServerCredentialStatus, String> {
    let binding = normalize_binding(binding)?;
    Ok(status_for(load_record(&binding.name)?, &binding))
}

pub fn materialize(binding: JumpServerCredentialBinding) -> Result<JumpServerCredentials, String> {
    let binding = normalize_binding(binding)?;
    let Some(record) = load_record(&binding.name)? else {
        return Err("jumpserver_credential_missing".to_string());
    };
    if record.binding != binding {
        return Err("jumpserver_credential_authority_mismatch".to_string());
    }
    Ok(record.credentials)
}

/// Fixed Koko SSH operations need only the optional proxy credential. Keep the
/// primary JumpServer password/API token out of that consumer's return type.
pub fn materialize_proxy_password(
    binding: JumpServerCredentialBinding,
) -> Result<Option<String>, String> {
    Ok(materialize(binding)?.proxy_password)
}

pub fn delete(name: &str) -> Result<(), String> {
    let account = account(name)?;
    let mut errors = Vec::new();
    if let Err(error) = delete_raw(SERVICE, &account) {
        errors.push(error);
    }
    if let Err(error) = delete_all_legacy(name) {
        errors.push(error);
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding() -> JumpServerCredentialBinding {
        JumpServerCredentialBinding {
            name: "Production".to_string(),
            base_url: "https://JS.EXAMPLE.com/".to_string(),
            ssh_host: "KOKO.EXAMPLE.com".to_string(),
            ssh_port: 2222,
            username: "admin".to_string(),
            auth_method: "password".to_string(),
            org_id: String::new(),
            proxy_type: String::new(),
            proxy_host: String::new(),
            proxy_port: 0,
            proxy_username: String::new(),
        }
    }

    #[test]
    fn binding_is_canonical_and_rejects_credentialed_urls() {
        let normalized = normalize_binding(binding()).unwrap();
        assert_eq!(normalized.base_url, "https://js.example.com");
        assert_eq!(normalized.ssh_host, "koko.example.com");

        let mut invalid = binding();
        invalid.base_url = "https://user:pass@js.example.com".to_string();
        assert!(normalize_binding(invalid).is_err());
    }

    #[test]
    fn proxy_authority_is_part_of_exact_binding() {
        let direct = normalize_binding(binding()).unwrap();
        let mut proxied = binding();
        proxied.proxy_type = "SOCKS5".to_string();
        proxied.proxy_host = "Proxy.Example.com".to_string();
        proxied.proxy_port = 1080;
        let proxied = normalize_binding(proxied).unwrap();
        assert_ne!(direct, proxied);
        assert_eq!(proxied.proxy_host, "proxy.example.com");
    }

    #[test]
    fn secret_debug_output_is_redacted() {
        let credentials = JumpServerCredentials {
            password: Some("never-print-me".to_string()),
            ..Default::default()
        };
        assert_eq!(
            format!("{credentials:?}"),
            "JumpServerCredentials(redacted)"
        );
    }

    #[test]
    fn migration_consent_digest_binds_authority_and_credential_bytes() {
        let first = normalize_binding(binding()).unwrap();
        let first_digest = migration_digest(&first, "legacy", "Production", "secret-a").unwrap();
        let changed_secret = migration_digest(&first, "legacy", "Production", "secret-b").unwrap();
        let mut changed_authority = first.clone();
        changed_authority.base_url = "https://other.example.com".to_string();
        let changed_authority =
            migration_digest(&changed_authority, "legacy", "Production", "secret-a").unwrap();
        assert_ne!(first_digest, changed_secret);
        assert_ne!(first_digest, changed_authority);
    }

    #[test]
    fn vault_namespace_matches_build_channel() {
        #[cfg(debug_assertions)]
        {
            assert_eq!(SERVICE, "com.meterm.dev.jumpserver.v3");
            assert!(LEGACY_SERVICES.is_empty());
        }
        #[cfg(not(debug_assertions))]
        {
            assert_eq!(SERVICE, "com.meterm.app.jumpserver.v3");
            assert_eq!(
                LEGACY_SERVICES,
                &[
                    "com.meterm.app.jumpserver.v2",
                    "com.meterm.app.jumpserver",
                    "com.meterm.dev.jumpserver",
                ]
            );
        }
    }
}
