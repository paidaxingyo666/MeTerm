use std::collections::{BTreeMap, BTreeSet};
use std::net::IpAddr;
use std::sync::{Mutex, OnceLock};

use reqwest::Url;
use serde::{Deserialize, Serialize};

#[cfg(debug_assertions)]
const SERVICE_V3: &str = "com.meterm.dev.settings.v3";
#[cfg(not(debug_assertions))]
const SERVICE_V3: &str = "com.meterm.app.settings.v3";
const ACCOUNT: &str = "ai-search-secrets";
#[cfg(debug_assertions)]
const LEGACY_SERVICES: &[&str] = &[];
#[cfg(not(debug_assertions))]
const LEGACY_SERVICES: &[&str] = &[
    "com.meterm.app.settings.v2",
    "com.meterm.app.settings",
    "com.meterm.dev.settings",
];
const MAX_PROVIDER_ID_BYTES: usize = 256;
const MAX_URL_BYTES: usize = 2_048;
const MAX_USERNAME_BYTES: usize = 512;
const MAX_SECRET_BYTES: usize = 65_536;

static VAULT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(crate) fn require_ai_settings_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let label = window.label();
    if label == "main" || label == "settings" || label.starts_with("window-") {
        Ok(())
    } else {
        Err("credential broker is unavailable to this window".to_string())
    }
}

fn is_settings_initialization_window(label: &str) -> bool {
    label == "settings"
}

fn require_settings_initialization_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if is_settings_initialization_window(window.label()) {
        Ok(())
    } else {
        Err("settings credential initialization is unavailable to this window".to_string())
    }
}

fn require_settings_mutation_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if is_settings_initialization_window(window.label()) {
        Ok(())
    } else {
        Err("settings credential mutation is unavailable to this window".to_string())
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSecretInput {
    pub id: String,
    pub provider_type: String,
    pub base_url: String,
    #[serde(default)]
    pub replacement: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearxngSecretInput {
    pub base_url: String,
    pub username: String,
    #[serde(default)]
    pub replacement: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSecretsRequest {
    pub providers: Vec<ProviderSecretInput>,
    pub searxng: SearxngSecretInput,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSecretPresence {
    pub provider_ids: Vec<String>,
    pub has_searxng_password: bool,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProviderRecord {
    provider_type: String,
    base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    secret: Option<String>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SearxngRecord {
    base_url: String,
    username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SettingsVault {
    version: u8,
    #[serde(default)]
    providers: BTreeMap<String, ProviderRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    searxng: Option<SearxngRecord>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySettingsVault {
    #[serde(default)]
    ai_provider_keys: BTreeMap<String, String>,
    #[serde(default)]
    searxng_password: String,
}

struct LegacySource {
    service: String,
    raw: String,
    vault: LegacySettingsVault,
}

struct LegacyMigrationSnapshot {
    request: SettingsSecretsRequest,
    source_service: String,
    source_digest: [u8; 32],
    current_digest: [u8; 32],
}

enum InitializationPreparation {
    Ready(SettingsSecretPresence),
    LegacyMigration(LegacyMigrationSnapshot, String),
}

fn lock_vault() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    VAULT_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "settings credential vault is unavailable".to_string())
}

fn validate_text(value: &str, max_bytes: usize, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > max_bytes || value.chars().any(char::is_control) {
        return Err(format!("invalid {label}"));
    }
    Ok(())
}

fn validate_provider_type(value: &str) -> Result<(), String> {
    match value {
        "openai" | "anthropic" | "gemini" => Ok(()),
        _ => Err("invalid AI provider type".to_string()),
    }
}

fn is_loopback_host(url: &Url) -> bool {
    match url.host_str() {
        Some(host) if host.eq_ignore_ascii_case("localhost") => true,
        Some(host) => host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback()),
        None => false,
    }
}

/// Canonicalize service metadata without silently changing its authority.
/// Callers that transmit secrets or user content must additionally require a
/// confidential transport with `confidential_service_base`.
pub(crate) fn canonical_service_base(raw: &str) -> Result<String, String> {
    if raw.len() > MAX_URL_BYTES {
        return Err("service URL is too long".to_string());
    }
    let mut url = Url::parse(raw).map_err(|_| "invalid service URL".to_string())?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("service URL must not contain credentials or a fragment".to_string());
    }
    if url.query().is_some() {
        return Err("service base URL must not contain a query".to_string());
    }
    match url.scheme() {
        "https" | "http" => {}
        _ => return Err("only HTTP and HTTPS service URLs are allowed".to_string()),
    }
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(if path.is_empty() { "/" } else { &path });
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

pub(crate) fn confidential_service_base(raw: &str) -> Result<String, String> {
    let base = canonical_service_base(raw)?;
    let url = Url::parse(&base).map_err(|_| "invalid service URL".to_string())?;
    if url.scheme() == "https" || (url.scheme() == "http" && is_loopback_host(&url)) {
        Ok(base)
    } else {
        Err("plaintext HTTP is allowed only for loopback services".to_string())
    }
}

fn normalize_provider(input: &ProviderSecretInput) -> Result<ProviderSecretInput, String> {
    validate_text(&input.id, MAX_PROVIDER_ID_BYTES, "provider id")?;
    validate_provider_type(&input.provider_type)?;
    let replacement = match input.replacement.as_deref() {
        Some(secret) if secret.len() > MAX_SECRET_BYTES => {
            return Err("AI provider credential is too large".to_string())
        }
        Some(secret) => Some(secret.to_string()),
        None => None,
    };
    Ok(ProviderSecretInput {
        id: input.id.clone(),
        provider_type: input.provider_type.clone(),
        base_url: canonical_service_base(&input.base_url)?,
        replacement,
    })
}

fn normalize_searxng(input: &SearxngSecretInput) -> Result<Option<SearxngSecretInput>, String> {
    if input.base_url.trim().is_empty() {
        return Ok(None);
    }
    if input.username.len() > MAX_USERNAME_BYTES || input.username.chars().any(char::is_control) {
        return Err("invalid SearXNG username".to_string());
    }
    let replacement = match input.replacement.as_deref() {
        Some(secret) if secret.len() > MAX_SECRET_BYTES => {
            return Err("SearXNG credential is too large".to_string())
        }
        Some(secret) => Some(secret.to_string()),
        None => None,
    };
    Ok(Some(SearxngSecretInput {
        base_url: canonical_service_base(&input.base_url)?,
        username: input.username.clone(),
        replacement,
    }))
}

fn entry(service: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, ACCOUNT).map_err(|_| "credential store is unavailable".to_string())
}

fn load_raw(service: &str) -> Result<Option<String>, String> {
    match entry(service)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("failed to read settings credentials".to_string()),
    }
}

fn delete_raw(service: &str) -> Result<(), String> {
    match entry(service)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("failed to remove legacy settings credentials".to_string()),
    }
}

fn parse_vault(raw: Option<&str>) -> Result<SettingsVault, String> {
    let Some(raw) = raw else {
        return Ok(SettingsVault {
            version: 3,
            ..SettingsVault::default()
        });
    };
    let vault: SettingsVault =
        serde_json::from_str(&raw).map_err(|_| "invalid settings credential record".to_string())?;
    if vault.version != 3 {
        return Err("unsupported settings credential record".to_string());
    }
    Ok(vault)
}

fn load_vault() -> Result<SettingsVault, String> {
    let raw = load_raw(SERVICE_V3)?;
    parse_vault(raw.as_deref())
}

fn encode_vault(vault: &SettingsVault) -> Result<String, String> {
    serde_json::to_string(vault).map_err(|_| "failed to encode settings credentials".to_string())
}

fn save_vault(vault: &SettingsVault) -> Result<(), String> {
    let raw = encode_vault(vault)?;
    entry(SERVICE_V3)?
        .set_password(&raw)
        .map_err(|_| "failed to store settings credentials".to_string())
}

#[cfg(target_os = "macos")]
fn create_vault(vault: &SettingsVault) -> Result<(), String> {
    use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};

    let raw = encode_vault(vault)?;
    let keychain = SecKeychain::default_for_domain(SecPreferencesDomain::User)
        .map_err(|_| "failed to create settings credentials".to_string())?;
    // Add-only is deliberate: a pre-created deterministic item has unknown
    // provenance/ACL and must never be silently adopted by this process.
    keychain
        .add_generic_password(SERVICE_V3, ACCOUNT, raw.as_bytes())
        .map_err(|_| "failed to create settings credentials".to_string())
}

#[cfg(not(target_os = "macos"))]
fn create_vault(vault: &SettingsVault) -> Result<(), String> {
    if load_raw(SERVICE_V3)?.is_some() {
        return Err("settings credential target already exists".to_string());
    }
    save_vault(vault)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VaultPersistenceAction {
    None,
    Create,
    Update,
}

fn vault_persistence_action(
    current_raw: Option<&str>,
    previous: &SettingsVault,
    next: &SettingsVault,
) -> VaultPersistenceAction {
    if previous == next {
        VaultPersistenceAction::None
    } else if current_raw.is_none() {
        VaultPersistenceAction::Create
    } else {
        VaultPersistenceAction::Update
    }
}

fn persist_vault_if_changed(
    current_raw: Option<&str>,
    previous: &SettingsVault,
    next: &SettingsVault,
) -> Result<(), String> {
    match vault_persistence_action(current_raw, previous, next) {
        VaultPersistenceAction::None => Ok(()),
        VaultPersistenceAction::Create => create_vault(next),
        VaultPersistenceAction::Update => save_vault(next),
    }
}

fn parse_legacy_vault(raw: &str) -> Result<LegacySettingsVault, String> {
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|_| "invalid legacy settings credential record".to_string())?;
    if value.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
        return Err("unsupported legacy settings credential record".to_string());
    }
    serde_json::from_value(value)
        .map_err(|_| "invalid legacy settings credential record".to_string())
}

fn legacy_source() -> Result<Option<LegacySource>, String> {
    for service in LEGACY_SERVICES {
        let Some(raw) = load_raw(service)? else {
            continue;
        };
        let vault = parse_legacy_vault(&raw)?;
        return Ok(Some(LegacySource {
            service: (*service).to_string(),
            raw,
            vault,
        }));
    }
    Ok(None)
}

fn snapshot_digest(service: &str, raw: Option<&str>) -> [u8; 32] {
    use sha2::{Digest, Sha256};

    let mut digest = Sha256::new();
    digest.update(service.as_bytes());
    digest.update([0]);
    if let Some(raw) = raw {
        digest.update(raw.as_bytes());
    }
    digest.finalize().into()
}

fn consent_summary(value: &str) -> String {
    use sha2::{Digest, Sha256};

    let summary = if value.chars().count() <= 240 {
        value.to_string()
    } else {
        let prefix: String = value.chars().take(200).collect();
        let digest = Sha256::digest(value.as_bytes());
        let suffix = digest[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        format!("{prefix}...#{suffix}")
    };
    super::user_presence::safe_prompt_field(&summary)
}

fn presence(vault: &SettingsVault) -> SettingsSecretPresence {
    SettingsSecretPresence {
        provider_ids: vault
            .providers
            .iter()
            .filter_map(|(id, record)| record.secret.as_ref().map(|_| id.clone()))
            .collect(),
        has_searxng_password: vault
            .searxng
            .as_ref()
            .and_then(|record| record.password.as_ref())
            .is_some(),
    }
}

fn apply_request(
    vault: &mut SettingsVault,
    request: &SettingsSecretsRequest,
    legacy: &LegacySettingsVault,
) -> Result<(), String> {
    if request.providers.len() > 128 {
        return Err("too many AI providers".to_string());
    }
    let mut seen = BTreeSet::new();
    let mut next = BTreeMap::new();
    for raw in &request.providers {
        let provider = normalize_provider(raw)?;
        if !seen.insert(provider.id.clone()) {
            return Err("duplicate AI provider id".to_string());
        }
        let matching = vault.providers.get(&provider.id).filter(|record| {
            record.provider_type == provider.provider_type && record.base_url == provider.base_url
        });
        let mut secret = matching.and_then(|record| record.secret.clone());
        if let Some(replacement) = provider.replacement {
            secret = (!replacement.is_empty()).then_some(replacement);
        } else if secret.is_none() {
            secret = legacy
                .ai_provider_keys
                .get(&provider.id)
                .filter(|value| !value.is_empty() && value.len() <= MAX_SECRET_BYTES)
                .cloned();
        }
        next.insert(
            provider.id,
            ProviderRecord {
                provider_type: provider.provider_type,
                base_url: provider.base_url,
                secret,
            },
        );
    }
    vault.providers = next;

    vault.searxng = match normalize_searxng(&request.searxng)? {
        None => None,
        Some(searxng) => {
            let matching = vault.searxng.as_ref().filter(|record| {
                record.base_url == searxng.base_url && record.username == searxng.username
            });
            let mut password = matching.and_then(|record| record.password.clone());
            if let Some(replacement) = searxng.replacement {
                password = (!replacement.is_empty()).then_some(replacement);
            } else if password.is_none()
                && !legacy.searxng_password.is_empty()
                && legacy.searxng_password.len() <= MAX_SECRET_BYTES
            {
                password = Some(legacy.searxng_password.clone());
            }
            Some(SearxngRecord {
                base_url: searxng.base_url,
                username: searxng.username,
                password,
            })
        }
    };
    Ok(())
}

fn update_locked(request: SettingsSecretsRequest) -> Result<SettingsSecretPresence, String> {
    let _guard = lock_vault()?;
    let current_raw = load_raw(SERVICE_V3)?;
    let mut vault = parse_vault(current_raw.as_deref())?;
    let previous = vault.clone();
    apply_request(&mut vault, &request, &LegacySettingsVault::default())?;
    if current_raw.is_none() && !request_has_replacement(&request) {
        return Ok(presence(&previous));
    }
    persist_vault_if_changed(current_raw.as_deref(), &previous, &vault)?;
    Ok(presence(&vault))
}

fn request_has_replacement(request: &SettingsSecretsRequest) -> bool {
    request
        .providers
        .iter()
        .any(|provider| provider.replacement.is_some())
        || request.searxng.replacement.is_some()
}

fn finish_initialization_without_legacy(
    current_raw: Option<&str>,
    current: &SettingsVault,
    validated: &SettingsVault,
    request: &SettingsSecretsRequest,
) -> Result<InitializationPreparation, String> {
    // Merely opening Settings is read-only for the current vault. LocalStorage
    // may be stale, incomplete, or corrupt; without an explicit replacement it
    // must not delete or rebind an existing Keychain secret. The projected
    // presence still reflects only authorities matching the request.
    if !request_has_replacement(request) {
        return Ok(InitializationPreparation::Ready(presence(validated)));
    }
    persist_vault_if_changed(current_raw, current, validated)?;
    Ok(InitializationPreparation::Ready(presence(validated)))
}

fn prepare_legacy_migration(
    request: SettingsSecretsRequest,
) -> Result<InitializationPreparation, String> {
    let _guard = lock_vault()?;
    let current_raw = load_raw(SERVICE_V3)?;
    let current = parse_vault(current_raw.as_deref())?;
    // Validate every caller-controlled authority before deciding whether a
    // native identity prompt is required.
    let mut validated = current.clone();
    apply_request(&mut validated, &request, &LegacySettingsVault::default())?;

    let Some(source) = legacy_source()? else {
        return finish_initialization_without_legacy(
            current_raw.as_deref(),
            &current,
            &validated,
            &request,
        );
    };
    let normalized_providers = request
        .providers
        .iter()
        .map(normalize_provider)
        .map(|result| result.map(|provider| (provider.id.clone(), provider)))
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    let mut targets = Vec::new();
    for (id, secret) in &source.vault.ai_provider_keys {
        if secret.is_empty() {
            continue;
        }
        if let Some(provider) = normalized_providers.get(id) {
            let already_bound = current.providers.get(id).is_some_and(|record| {
                record.provider_type == provider.provider_type
                    && record.base_url == provider.base_url
                    && record.secret.is_some()
            });
            let action = if provider.replacement.is_none() && !already_bound {
                "bind"
            } else {
                "remove duplicate"
            };
            targets.push(format!(
                "{action} provider [{}] -> authority [{}]",
                consent_summary(id),
                consent_summary(&provider.base_url)
            ));
        } else {
            targets.push(format!("remove unused provider [{}]", consent_summary(id)));
        }
    }
    if !source.vault.searxng_password.is_empty() {
        if let Some(searxng) = normalize_searxng(&request.searxng)? {
            let already_bound = current.searxng.as_ref().is_some_and(|record| {
                record.base_url == searxng.base_url
                    && record.username == searxng.username
                    && record.password.is_some()
            });
            let action = if searxng.replacement.is_none() && !already_bound {
                "bind"
            } else {
                "remove duplicate"
            };
            targets.push(format!(
                "{action} SearXNG -> authority [{}]",
                consent_summary(&searxng.base_url)
            ));
        } else {
            targets.push("remove unused SearXNG password".to_string());
        }
    }
    if targets.is_empty() {
        return finish_initialization_without_legacy(
            current_raw.as_deref(),
            &current,
            &validated,
            &request,
        );
    }
    let preview = targets
        .iter()
        .take(4)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let suffix = if targets.len() > 4 { ", ..." } else { "" };
    let reason = format!(
        "Migrate or remove {} legacy AI/search credential(s): {}{}",
        targets.len(),
        preview,
        suffix
    );
    Ok(InitializationPreparation::LegacyMigration(
        LegacyMigrationSnapshot {
            request,
            source_service: source.service.clone(),
            source_digest: snapshot_digest(&source.service, Some(&source.raw)),
            current_digest: snapshot_digest(SERVICE_V3, current_raw.as_deref()),
        },
        reason,
    ))
}

fn commit_legacy_migration(
    snapshot: LegacyMigrationSnapshot,
) -> Result<SettingsSecretPresence, String> {
    let _guard = lock_vault()?;
    let source_raw = load_raw(&snapshot.source_service)?
        .ok_or_else(|| "legacy settings credential changed during confirmation".to_string())?;
    let current_raw = load_raw(SERVICE_V3)?;
    if snapshot_digest(&snapshot.source_service, Some(&source_raw)) != snapshot.source_digest
        || snapshot_digest(SERVICE_V3, current_raw.as_deref()) != snapshot.current_digest
    {
        return Err("settings credentials changed during confirmation".to_string());
    }
    let legacy = parse_legacy_vault(&source_raw)?;
    let mut vault = parse_vault(current_raw.as_deref())?;
    let previous = vault.clone();
    apply_request(&mut vault, &snapshot.request, &legacy)?;
    persist_vault_if_changed(current_raw.as_deref(), &previous, &vault)?;
    for service in LEGACY_SERVICES {
        delete_raw(service)?;
    }
    Ok(presence(&vault))
}

/// Migrate legacy Keychain/local-storage inputs without returning any saved
/// credential bytes to the WebView.
#[tauri::command]
pub async fn initialize_settings_secrets(
    window: tauri::WebviewWindow,
    request: SettingsSecretsRequest,
) -> Result<SettingsSecretPresence, String> {
    require_settings_initialization_window(&window)?;
    match prepare_legacy_migration(request)? {
        InitializationPreparation::LegacyMigration(snapshot, reason) => {
            super::user_presence::confirm_for_credential_binding(&window, reason).await?;
            commit_legacy_migration(snapshot)
        }
        InitializationPreparation::Ready(result) => Ok(result),
    }
}

/// Store only replacement values explicitly typed by the user. A metadata-only
/// authority change drops the old credential instead of silently rebinding it.
#[tauri::command]
pub async fn update_settings_secrets(
    window: tauri::WebviewWindow,
    request: SettingsSecretsRequest,
) -> Result<SettingsSecretPresence, String> {
    require_settings_mutation_window(&window)?;
    update_locked(request)
}

pub(crate) fn provider_secret(
    id: &str,
    provider_type: &str,
    base_url: &str,
) -> Result<Option<String>, String> {
    let _guard = lock_vault()?;
    validate_text(id, MAX_PROVIDER_ID_BYTES, "provider id")?;
    validate_provider_type(provider_type)?;
    let base_url = canonical_service_base(base_url)?;
    let vault = load_vault()?;
    let record = vault
        .providers
        .get(id)
        .ok_or_else(|| "AI provider is not registered".to_string())?;
    if record.provider_type != provider_type || record.base_url != base_url {
        return Err("AI provider authority does not match its saved credential".to_string());
    }
    if record.secret.is_some() {
        confidential_service_base(&record.base_url)?;
    }
    Ok(record.secret.clone())
}

pub(crate) fn searxng_password(base_url: &str, username: &str) -> Result<Option<String>, String> {
    let _guard = lock_vault()?;
    let base_url = canonical_service_base(base_url)?;
    let vault = load_vault()?;
    let record = vault
        .searxng
        .as_ref()
        .ok_or_else(|| "SearXNG service is not registered".to_string())?;
    if record.base_url != base_url || record.username != username {
        return Err("SearXNG authority does not match its saved credential".to_string());
    }
    if record.password.is_some() {
        confidential_service_base(&record.base_url)?;
    }
    Ok(record.password.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_base_rejects_remote_plaintext_and_url_credentials() {
        assert!(confidential_service_base("http://example.com").is_err());
        assert!(canonical_service_base("https://user:pass@example.com").is_err());
        assert_eq!(
            canonical_service_base("http://127.0.0.1:11434/").unwrap(),
            "http://127.0.0.1:11434"
        );
    }

    #[test]
    fn authority_change_drops_secret_without_replacement() {
        let mut vault = SettingsVault {
            version: 3,
            providers: BTreeMap::from([(
                "openai".to_string(),
                ProviderRecord {
                    provider_type: "openai".to_string(),
                    base_url: "https://api.openai.com".to_string(),
                    secret: Some("secret".to_string()),
                },
            )]),
            searxng: None,
        };
        let request = SettingsSecretsRequest {
            providers: vec![ProviderSecretInput {
                id: "openai".to_string(),
                provider_type: "openai".to_string(),
                base_url: "https://attacker.example".to_string(),
                replacement: None,
            }],
            searxng: SearxngSecretInput {
                base_url: String::new(),
                username: String::new(),
                replacement: None,
            },
        };
        apply_request(&mut vault, &request, &LegacySettingsVault::default()).unwrap();
        assert!(vault.providers["openai"].secret.is_none());
    }

    #[test]
    fn unchanged_request_does_not_require_a_keychain_write() {
        let mut vault = SettingsVault {
            version: 3,
            providers: BTreeMap::from([(
                "openai".to_string(),
                ProviderRecord {
                    provider_type: "openai".to_string(),
                    base_url: "https://api.openai.com".to_string(),
                    secret: Some("secret".to_string()),
                },
            )]),
            searxng: None,
        };
        let previous = vault.clone();
        let request = SettingsSecretsRequest {
            providers: vec![ProviderSecretInput {
                id: "openai".to_string(),
                provider_type: "openai".to_string(),
                base_url: "https://api.openai.com/".to_string(),
                replacement: None,
            }],
            searxng: SearxngSecretInput {
                base_url: String::new(),
                username: String::new(),
                replacement: None,
            },
        };

        apply_request(&mut vault, &request, &LegacySettingsVault::default()).unwrap();
        assert_eq!(
            vault_persistence_action(Some("existing"), &previous, &vault),
            VaultPersistenceAction::None
        );
    }

    #[test]
    fn clean_startup_does_not_create_a_metadata_only_vault() {
        let current = SettingsVault {
            version: 3,
            ..SettingsVault::default()
        };
        let mut validated = current.clone();
        let request = SettingsSecretsRequest {
            providers: vec![ProviderSecretInput {
                id: "openai".to_string(),
                provider_type: "openai".to_string(),
                base_url: "https://api.openai.com".to_string(),
                replacement: None,
            }],
            searxng: SearxngSecretInput {
                base_url: String::new(),
                username: String::new(),
                replacement: None,
            },
        };
        apply_request(&mut validated, &request, &LegacySettingsVault::default()).unwrap();

        let result =
            finish_initialization_without_legacy(None, &current, &validated, &request).unwrap();
        let InitializationPreparation::Ready(result) = result else {
            panic!("clean initialization must not request migration");
        };
        assert!(result.provider_ids.is_empty());
        assert!(!result.has_searxng_password);
    }

    #[test]
    fn first_secret_write_uses_create_and_existing_item_uses_update() {
        let previous = SettingsVault {
            version: 3,
            ..SettingsVault::default()
        };
        let next = SettingsVault {
            version: 3,
            providers: BTreeMap::from([(
                "openai".to_string(),
                ProviderRecord {
                    provider_type: "openai".to_string(),
                    base_url: "https://api.openai.com".to_string(),
                    secret: Some("secret".to_string()),
                },
            )]),
            searxng: None,
        };

        assert_eq!(
            vault_persistence_action(None, &previous, &next),
            VaultPersistenceAction::Create
        );
        assert_eq!(
            vault_persistence_action(Some("preexisting"), &previous, &next),
            VaultPersistenceAction::Update
        );
    }

    #[test]
    fn opening_settings_does_not_persist_an_authority_mismatch() {
        let current = SettingsVault {
            version: 3,
            providers: BTreeMap::from([(
                "openai".to_string(),
                ProviderRecord {
                    provider_type: "openai".to_string(),
                    base_url: "https://original.example".to_string(),
                    secret: Some("must-not-be-deleted".to_string()),
                },
            )]),
            searxng: None,
        };
        let request = SettingsSecretsRequest {
            providers: vec![ProviderSecretInput {
                id: "openai".to_string(),
                provider_type: "openai".to_string(),
                base_url: "https://changed.example".to_string(),
                replacement: None,
            }],
            searxng: SearxngSecretInput {
                base_url: String::new(),
                username: String::new(),
                replacement: None,
            },
        };
        let mut projected = current.clone();
        apply_request(&mut projected, &request, &LegacySettingsVault::default()).unwrap();
        assert!(projected.providers["openai"].secret.is_none());

        let result =
            finish_initialization_without_legacy(Some("existing"), &current, &projected, &request)
                .unwrap();
        let InitializationPreparation::Ready(result) = result else {
            panic!("current-vault projection must not request migration");
        };
        assert!(result.provider_ids.is_empty());
        assert_eq!(
            current.providers["openai"].secret.as_deref(),
            Some("must-not-be-deleted")
        );
    }

    #[test]
    fn secondary_windows_cannot_initialize_settings_credentials() {
        assert!(is_settings_initialization_window("settings"));
        assert!(!is_settings_initialization_window("main"));
        assert!(!is_settings_initialization_window("window-123_main"));
        assert!(!is_settings_initialization_window("editor"));
    }

    #[test]
    fn consent_summary_escapes_prompt_delimiters_and_bidi_controls() {
        let summary = consent_summary("provider]\u{202e} authority: [evil\n");
        assert_eq!(
            summary,
            "provider\\u{5D}\\u{202E} authority: \\u{5B}evil\\u{A}"
        );
        assert!(!summary.contains('['));
        assert!(!summary.contains(']'));
        assert!(!summary.contains('\u{202e}'));
        assert!(!summary.contains('\n'));
    }

    #[test]
    fn vault_namespace_matches_build_channel() {
        #[cfg(debug_assertions)]
        {
            assert_eq!(SERVICE_V3, "com.meterm.dev.settings.v3");
            assert!(LEGACY_SERVICES.is_empty());
        }
        #[cfg(not(debug_assertions))]
        {
            assert_eq!(SERVICE_V3, "com.meterm.app.settings.v3");
            assert_eq!(
                LEGACY_SERVICES,
                &[
                    "com.meterm.app.settings.v2",
                    "com.meterm.app.settings",
                    "com.meterm.dev.settings",
                ]
            );
        }
    }
}
