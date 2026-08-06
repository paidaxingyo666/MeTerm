//! Desktop self-signed TLS identity.
//!
//! The certificate is public metadata persisted in the app data directory. The private key lives
//! only in the OS credential vault. Development-era `tls-key*.pem` files are never imported: after
//! validating that the old pair is coherent, the first upgraded launch rotates to a fresh identity
//! and removes the legacy key only after the new vault record and certificate are durable.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use rustls::pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;

use super::private_file::atomic_write_private;
use super::tls_key_vault::{OsTlsPrivateKeyVault, TlsKeyAuthority, TlsPrivateKeyVault};

const MAX_CERTIFICATE_PEM_BYTES: u64 = 1024 * 1024;
const MAX_PRIVATE_KEY_PEM_BYTES: u64 = 64 * 1024;
static TLS_IDENTITY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// Load or create the certificate and its authority-bound private key.
pub fn load_or_create_cert(
    state_dir: &str,
    device_id: &str,
) -> Result<(ServerConfig, String), String> {
    let _guard = TLS_IDENTITY_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "TLS identity lock is unavailable".to_string())?;
    load_or_create_cert_with_vault_for_build(
        state_dir,
        device_id,
        &OsTlsPrivateKeyVault,
        cfg!(debug_assertions),
    )
}

fn load_or_create_cert_with_vault(
    state_dir: &str,
    device_id: &str,
    vault: &impl TlsPrivateKeyVault,
) -> Result<(ServerConfig, String), String> {
    load_or_create_cert_with_vault_for_build(state_dir, device_id, vault, cfg!(debug_assertions))
}

fn load_or_create_cert_with_vault_for_build(
    state_dir: &str,
    device_id: &str,
    vault: &impl TlsPrivateKeyVault,
    debug_build: bool,
) -> Result<(ServerConfig, String), String> {
    let (cert_path, legacy_key_path) = cert_paths_for_build(state_dir, debug_build);
    let cert_exists = path_exists(&cert_path)?;
    let legacy_key_exists = path_exists(&legacy_key_path)?;

    match (cert_exists, legacy_key_exists) {
        (false, false) => create_new_identity(&cert_path, device_id, vault, debug_build),
        (false, true) => Err(
            "legacy TLS private key exists without its certificate; refusing TLS identity rotation"
                .to_string(),
        ),
        (true, false) => load_vault_identity(&cert_path, device_id, vault, debug_build),
        (true, true) => rotate_or_finish_legacy_identity(
            &cert_path,
            &legacy_key_path,
            device_id,
            vault,
            debug_build,
        ),
    }
}

fn create_new_identity(
    cert_path: &Path,
    device_id: &str,
    vault: &impl TlsPrivateKeyVault,
    debug_build: bool,
) -> Result<(ServerConfig, String), String> {
    let (cert_pem, private_key_pem) = generate_identity(device_id)?;
    let certs = parse_certs(cert_pem.as_bytes())?;
    let fingerprint = leaf_fingerprint(&certs)?;
    let authority = TlsKeyAuthority::for_build(debug_build, device_id, &fingerprint)?;

    // Validate the generated pair before any persistent mutation.
    let _ = build_server_config(&certs, &private_key_pem)?;
    let reloaded_key = vault.store_and_verify(&authority, &private_key_pem)?;
    let config = build_server_config(&certs, &reloaded_key)?;

    if let Err(write_error) = atomic_write_private(cert_path, cert_pem.as_bytes()) {
        let cleanup_failed = vault.delete_key(&authority).is_err();
        return Err(if cleanup_failed {
            format!(
                "failed to persist TLS certificate metadata and roll back its vault key: {write_error}"
            )
        } else {
            format!("failed to persist TLS certificate metadata: {write_error}")
        });
    }
    Ok((config, fingerprint))
}

fn load_vault_identity(
    cert_path: &Path,
    device_id: &str,
    vault: &impl TlsPrivateKeyVault,
    debug_build: bool,
) -> Result<(ServerConfig, String), String> {
    let certs = read_and_parse_certs(cert_path)?;
    let fingerprint = leaf_fingerprint(&certs)?;
    let authority = TlsKeyAuthority::for_build(debug_build, device_id, &fingerprint)?;
    match vault.load_key(&authority)? {
        Some(private_key_pem) => {
            let config = build_server_config(&certs, &private_key_pem)?;
            Ok((config, fingerprint))
        }
        None if debug_build => {
            if !certificate_is_bound_to_device(&certs, device_id)? {
                return Err("TLS certificate device identity mismatch".to_string());
            }
            rotate_debug_identity_with_missing_vault_key(cert_path, device_id, &fingerprint, vault)
        }
        None => Err("TLS certificate exists but its bound vault key is missing".to_string()),
    }
}

/// A debug certificate may have been created before the dev/release Keychain
/// namespaces were separated. If the new dev vault has no key for that exact
/// certificate, rotate to a fresh dev-only identity without reading or deleting
/// anything from the former shared service. The persisted certificate must
/// still be bound to the current device id; a changed/corrupt device id remains
/// a hard failure rather than silently rebinding an identity.
fn rotate_debug_identity_with_missing_vault_key(
    cert_path: &Path,
    device_id: &str,
    current_fingerprint: &str,
    vault: &impl TlsPrivateKeyVault,
) -> Result<(ServerConfig, String), String> {
    let (new_cert_pem, new_private_key_pem) = generate_identity(device_id)?;
    let new_certs = parse_certs(new_cert_pem.as_bytes())?;
    let new_fingerprint = leaf_fingerprint(&new_certs)?;
    if new_fingerprint == current_fingerprint {
        return Err("TLS identity rotation did not produce a fresh certificate".to_string());
    }
    let new_authority = TlsKeyAuthority::for_build(true, device_id, &new_fingerprint)?;
    let _ = build_server_config(&new_certs, &new_private_key_pem)?;
    let reloaded_key = match vault.store_and_verify(&new_authority, &new_private_key_pem) {
        Ok(key) => key,
        Err(store_error) => {
            let cleanup_failed = vault.delete_key(&new_authority).is_err();
            return Err(if cleanup_failed {
                format!(
                    "failed to verify the rotated debug TLS vault key and roll it back: {store_error}"
                )
            } else {
                store_error
            });
        }
    };
    let config = build_server_config(&new_certs, &reloaded_key)?;

    if let Err(write_error) = atomic_write_private(cert_path, new_cert_pem.as_bytes()) {
        let cleanup_failed = vault.delete_key(&new_authority).is_err();
        return Err(if cleanup_failed {
            format!(
                "failed to replace debug TLS certificate metadata and roll back its vault key: {write_error}"
            )
        } else {
            format!("failed to replace debug TLS certificate metadata: {write_error}")
        });
    }
    Ok((config, new_fingerprint))
}

fn rotate_or_finish_legacy_identity(
    cert_path: &Path,
    legacy_key_path: &Path,
    device_id: &str,
    vault: &impl TlsPrivateKeyVault,
    debug_build: bool,
) -> Result<(ServerConfig, String), String> {
    let current_certs = read_and_parse_certs(cert_path)?;
    let current_fingerprint = leaf_fingerprint(&current_certs)?;
    let current_authority =
        TlsKeyAuthority::for_build(debug_build, device_id, &current_fingerprint)?;

    // A valid current vault entry means a previous rotation reached the certificate replacement
    // and only legacy-file cleanup was interrupted. Verify the vault pair, then finish deletion.
    if let Some(private_key_pem) = vault.load_key(&current_authority)? {
        let config = build_server_config(&current_certs, &private_key_pem)?;
        remove_legacy_key(legacy_key_path)?;
        return Ok((config, current_fingerprint));
    }

    // First upgraded launch: validate the old pair so an unrelated/corrupt file is never silently
    // deleted, but do not preserve a key that has already lived inside the remotely readable file
    // boundary. A fresh certificate intentionally invalidates existing development-device pins.
    ensure_private_permissions(legacy_key_path)?;
    let legacy_key_pem = read_utf8_regular_file(
        legacy_key_path,
        MAX_PRIVATE_KEY_PEM_BYTES,
        "legacy TLS private key",
    )?;
    let _ = build_server_config(&current_certs, &legacy_key_pem)?;

    let (new_cert_pem, new_private_key_pem) = generate_identity(device_id)?;
    let new_certs = parse_certs(new_cert_pem.as_bytes())?;
    let new_fingerprint = leaf_fingerprint(&new_certs)?;
    if new_fingerprint == current_fingerprint {
        return Err("TLS identity rotation did not produce a fresh certificate".to_string());
    }
    let new_authority = TlsKeyAuthority::for_build(debug_build, device_id, &new_fingerprint)?;
    let _ = build_server_config(&new_certs, &new_private_key_pem)?;
    let reloaded_key = vault.store_and_verify(&new_authority, &new_private_key_pem)?;
    let config = build_server_config(&new_certs, &reloaded_key)?;

    if let Err(write_error) = atomic_write_private(cert_path, new_cert_pem.as_bytes()) {
        let cleanup_failed = vault.delete_key(&new_authority).is_err();
        return Err(if cleanup_failed {
            format!(
                "failed to replace TLS certificate metadata and roll back its vault key: {write_error}"
            )
        } else {
            format!("failed to replace TLS certificate metadata: {write_error}")
        });
    }
    remove_legacy_key(legacy_key_path)?;
    Ok((config, new_fingerprint))
}

fn cert_paths(state_dir: &str) -> (PathBuf, PathBuf) {
    cert_paths_for_build(state_dir, cfg!(debug_assertions))
}

fn cert_paths_for_build(state_dir: &str, debug_build: bool) -> (PathBuf, PathBuf) {
    let (cert_name, key_name) = if debug_build {
        ("tls-cert-dev.pem", "tls-key-dev.pem")
    } else {
        ("tls-cert.pem", "tls-key.pem")
    };
    (
        Path::new(state_dir).join(cert_name),
        Path::new(state_dir).join(key_name),
    )
}

fn generate_identity(device_id: &str) -> Result<(String, String), String> {
    use rcgen::{date_time_ymd, CertificateParams, DistinguishedName, DnType, KeyPair, SanType};

    let hostname = hostname::get()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|_| "meterm".to_string());
    let mut sans = vec![
        hostname.clone(),
        format!("{hostname}.local"),
        "localhost".to_string(),
    ];
    sans.retain(|value| !value.is_empty());
    let mut params = CertificateParams::new(sans).map_err(|_| "invalid TLS SAN".to_string())?;
    let uri = rcgen::string::Ia5String::try_from(format!("urn:meterm:device:{device_id}"))
        .map_err(|_| "invalid TLS device identity".to_string())?;
    params.subject_alt_names.push(SanType::URI(uri));

    let mut distinguished_name = DistinguishedName::new();
    distinguished_name.push(DnType::CommonName, device_id);
    distinguished_name.push(DnType::OrganizationName, "MeTerm");
    params.distinguished_name = distinguished_name;
    params.not_before = date_time_ymd(2024, 1, 1);
    params.not_after = date_time_ymd(2124, 1, 1);

    let key_pair = KeyPair::generate().map_err(|_| "TLS key generation failed".to_string())?;
    let certificate = params
        .self_signed(&key_pair)
        .map_err(|_| "TLS certificate generation failed".to_string())?;
    Ok((certificate.pem(), key_pair.serialize_pem()))
}

fn read_and_parse_certs(path: &Path) -> Result<Vec<CertificateDer<'static>>, String> {
    let pem = read_regular_file(path, MAX_CERTIFICATE_PEM_BYTES, "TLS certificate")?;
    parse_certs(&pem)
}

fn read_regular_file(path: &Path, max_bytes: u64, label: &str) -> Result<Vec<u8>, String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|_| format!("cannot inspect {label}"))?;
    if !metadata.file_type().is_file() || metadata.len() == 0 || metadata.len() > max_bytes {
        return Err(format!("{label} is not a bounded regular file"));
    }
    std::fs::read(path).map_err(|_| format!("cannot read {label}"))
}

fn read_utf8_regular_file(path: &Path, max_bytes: u64, label: &str) -> Result<String, String> {
    String::from_utf8(read_regular_file(path, max_bytes, label)?)
        .map_err(|_| format!("{label} is not valid UTF-8"))
}

fn path_exists(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("cannot inspect TLS identity state".to_string()),
    }
}

fn ensure_private_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = std::fs::symlink_metadata(path)
            .map_err(|_| "cannot inspect legacy TLS private key".to_string())?;
        if !metadata.file_type().is_file() {
            return Err("legacy TLS private key is not a regular file".to_string());
        }
        if metadata.permissions().mode() & 0o077 != 0 {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| "cannot restrict legacy TLS private key permissions".to_string())?;
        }
    }
    Ok(())
}

fn remove_legacy_key(path: &Path) -> Result<(), String> {
    std::fs::remove_file(path)
        .map_err(|_| "new TLS identity is ready but legacy private-key cleanup failed".to_string())
}

fn parse_certs(pem: &[u8]) -> Result<Vec<CertificateDer<'static>>, String> {
    let certs = CertificateDer::pem_slice_iter(pem)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "invalid TLS certificate PEM".to_string())?;
    if certs.is_empty() {
        return Err("no TLS certificate found".to_string());
    }
    Ok(certs)
}

fn certificate_is_bound_to_device(
    certs: &[CertificateDer<'static>],
    device_id: &str,
) -> Result<bool, String> {
    use x509_parser::extensions::GeneralName;

    let leaf = certs
        .first()
        .ok_or_else(|| "no TLS certificate found".to_string())?;
    let (remaining, parsed) = x509_parser::parse_x509_certificate(leaf.as_ref())
        .map_err(|_| "invalid TLS certificate DER".to_string())?;
    if !remaining.is_empty() {
        return Err("invalid TLS certificate DER".to_string());
    }
    let expected = format!("urn:meterm:device:{device_id}");
    let subject_alt_name = parsed
        .subject_alternative_name()
        .map_err(|_| "invalid TLS certificate subject alternative name".to_string())?;
    Ok(subject_alt_name.is_some_and(|extension| {
        extension
            .value
            .general_names
            .iter()
            .any(|name| matches!(name, GeneralName::URI(uri) if *uri == expected))
    }))
}

fn parse_key(pem: &[u8]) -> Result<PrivateKeyDer<'static>, String> {
    PrivateKeyDer::from_pem_slice(pem).map_err(|_| "invalid TLS private key PEM".to_string())
}

/// `with_single_cert` checks the leaf SubjectPublicKeyInfo against the private key. Every load,
/// rotation and vault read-back passes through this function before the legacy key can be deleted.
fn build_server_config(
    certs: &[CertificateDer<'static>],
    private_key_pem: &str,
) -> Result<ServerConfig, String> {
    let key = parse_key(private_key_pem.as_bytes())?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| "invalid TLS protocol configuration".to_string())?
        .with_no_client_auth()
        .with_single_cert(certs.to_vec(), key)
        .map_err(|_| "TLS certificate/private-key mismatch".to_string())
}

fn leaf_fingerprint(certs: &[CertificateDer<'static>]) -> Result<String, String> {
    certs
        .first()
        .map(|certificate| fingerprint_sha256_hex(certificate.as_ref()))
        .ok_or_else(|| "no TLS certificate found".to_string())
}

fn fingerprint_sha256_hex(cert_der: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex_lower(&Sha256::digest(cert_der))
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Default)]
    struct MemoryVault {
        entry: Mutex<Option<(TlsKeyAuthority, String)>>,
        fail_store_verification: AtomicBool,
    }

    impl TlsPrivateKeyVault for MemoryVault {
        fn load_key(&self, authority: &TlsKeyAuthority) -> Result<Option<String>, String> {
            Ok(self
                .entry
                .lock()
                .unwrap()
                .as_ref()
                .filter(|(stored, _)| stored == authority)
                .map(|(_, key)| key.clone()))
        }

        fn store_and_verify(
            &self,
            authority: &TlsKeyAuthority,
            private_key_pem: &str,
        ) -> Result<String, String> {
            *self.entry.lock().unwrap() = Some((authority.clone(), private_key_pem.to_string()));
            if self.fail_store_verification.load(Ordering::SeqCst) {
                Err("injected TLS vault verification failure".to_string())
            } else {
                Ok(private_key_pem.to_string())
            }
        }

        fn delete_key(&self, authority: &TlsKeyAuthority) -> Result<(), String> {
            let mut entry = self.entry.lock().unwrap();
            if entry
                .as_ref()
                .is_some_and(|(stored, _)| stored == authority)
            {
                *entry = None;
            }
            Ok(())
        }
    }

    fn test_dir(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("meterm-tls-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn new_identity_persists_only_certificate_and_vault_key() {
        let directory = test_dir("new");
        let state_dir = directory.to_string_lossy().to_string();
        let device_id = uuid::Uuid::new_v4().to_string();
        let vault = MemoryVault::default();

        let (_, first_fingerprint) =
            load_or_create_cert_with_vault(&state_dir, &device_id, &vault).unwrap();
        let (cert_path, legacy_key_path) = cert_paths(&state_dir);
        assert!(cert_path.is_file());
        assert!(!legacy_key_path.exists());
        let (_, second_fingerprint) =
            load_or_create_cert_with_vault(&state_dir, &device_id, &vault).unwrap();
        assert_eq!(first_fingerprint, second_fingerprint);

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn legacy_pair_rotates_instead_of_reusing_exposed_key() {
        let directory = test_dir("rotate");
        let state_dir = directory.to_string_lossy().to_string();
        let device_id = uuid::Uuid::new_v4().to_string();
        let vault = MemoryVault::default();
        let (old_cert, old_key) = generate_identity(&device_id).unwrap();
        let old_fingerprint = leaf_fingerprint(&parse_certs(old_cert.as_bytes()).unwrap()).unwrap();
        let (cert_path, legacy_key_path) = cert_paths(&state_dir);
        atomic_write_private(&cert_path, old_cert.as_bytes()).unwrap();
        atomic_write_private(&legacy_key_path, old_key.as_bytes()).unwrap();

        let (_, new_fingerprint) =
            load_or_create_cert_with_vault(&state_dir, &device_id, &vault).unwrap();
        assert_ne!(old_fingerprint, new_fingerprint);
        assert!(!legacy_key_path.exists());
        let stored_key = vault.entry.lock().unwrap().as_ref().unwrap().1.clone();
        assert_ne!(stored_key, old_key);

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn debug_missing_channel_vault_key_rotates_to_fresh_identity() {
        let directory = test_dir("debug-channel-rotation");
        let state_dir = directory.to_string_lossy().to_string();
        let device_id = uuid::Uuid::new_v4().to_string();
        let vault = MemoryVault::default();
        let (old_cert, _) = generate_identity(&device_id).unwrap();
        let old_fingerprint = leaf_fingerprint(&parse_certs(old_cert.as_bytes()).unwrap()).unwrap();
        let (cert_path, legacy_key_path) = cert_paths_for_build(&state_dir, true);
        atomic_write_private(&cert_path, old_cert.as_bytes()).unwrap();
        assert!(!legacy_key_path.exists());

        let (_, new_fingerprint) =
            load_or_create_cert_with_vault_for_build(&state_dir, &device_id, &vault, true).unwrap();
        assert_ne!(new_fingerprint, old_fingerprint);
        let stored_authority = vault.entry.lock().unwrap().as_ref().unwrap().0.clone();
        assert_eq!(
            stored_authority,
            TlsKeyAuthority::for_build(true, &device_id, &new_fingerprint).unwrap()
        );

        let (_, stable_fingerprint) =
            load_or_create_cert_with_vault_for_build(&state_dir, &device_id, &vault, true).unwrap();
        assert_eq!(stable_fingerprint, new_fingerprint);

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn release_missing_vault_key_remains_fail_closed() {
        let directory = test_dir("release-missing-vault");
        let state_dir = directory.to_string_lossy().to_string();
        let device_id = uuid::Uuid::new_v4().to_string();
        let vault = MemoryVault::default();
        let (certificate, _) = generate_identity(&device_id).unwrap();
        let (cert_path, _) = cert_paths_for_build(&state_dir, false);
        atomic_write_private(&cert_path, certificate.as_bytes()).unwrap();

        let error = load_or_create_cert_with_vault_for_build(&state_dir, &device_id, &vault, false)
            .unwrap_err();
        assert_eq!(
            error,
            "TLS certificate exists but its bound vault key is missing"
        );
        assert_eq!(std::fs::read_to_string(&cert_path).unwrap(), certificate);
        assert!(vault.entry.lock().unwrap().is_none());

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn failed_debug_rotation_verification_preserves_old_certificate() {
        let directory = test_dir("debug-channel-verify");
        let state_dir = directory.to_string_lossy().to_string();
        let device_id = uuid::Uuid::new_v4().to_string();
        let vault = MemoryVault::default();
        vault.fail_store_verification.store(true, Ordering::SeqCst);
        let (certificate, _) = generate_identity(&device_id).unwrap();
        let (cert_path, _) = cert_paths_for_build(&state_dir, true);
        atomic_write_private(&cert_path, certificate.as_bytes()).unwrap();

        assert!(
            load_or_create_cert_with_vault_for_build(&state_dir, &device_id, &vault, true).is_err()
        );
        assert_eq!(std::fs::read_to_string(&cert_path).unwrap(), certificate);
        assert!(vault.entry.lock().unwrap().is_none());

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn mismatched_legacy_pair_fails_without_deletion_or_vault_write() {
        let directory = test_dir("mismatch");
        let state_dir = directory.to_string_lossy().to_string();
        let device_id = uuid::Uuid::new_v4().to_string();
        let vault = MemoryVault::default();
        let (certificate, _) = generate_identity(&device_id).unwrap();
        let (_, unrelated_key) = generate_identity(&device_id).unwrap();
        let (cert_path, legacy_key_path) = cert_paths(&state_dir);
        atomic_write_private(&cert_path, certificate.as_bytes()).unwrap();
        atomic_write_private(&legacy_key_path, unrelated_key.as_bytes()).unwrap();

        assert!(load_or_create_cert_with_vault(&state_dir, &device_id, &vault).is_err());
        assert!(legacy_key_path.exists());
        assert!(vault.entry.lock().unwrap().is_none());

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn failed_vault_verification_never_deletes_legacy_key() {
        let directory = test_dir("verify");
        let state_dir = directory.to_string_lossy().to_string();
        let device_id = uuid::Uuid::new_v4().to_string();
        let vault = MemoryVault::default();
        vault.fail_store_verification.store(true, Ordering::SeqCst);
        let (certificate, key) = generate_identity(&device_id).unwrap();
        let (cert_path, legacy_key_path) = cert_paths(&state_dir);
        atomic_write_private(&cert_path, certificate.as_bytes()).unwrap();
        atomic_write_private(&legacy_key_path, key.as_bytes()).unwrap();

        assert!(load_or_create_cert_with_vault(&state_dir, &device_id, &vault).is_err());
        assert!(legacy_key_path.exists());

        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn certificate_cannot_be_rebound_to_another_device_id() {
        let directory = test_dir("authority");
        let state_dir = directory.to_string_lossy().to_string();
        let vault = MemoryVault::default();
        let first_device = uuid::Uuid::new_v4().to_string();
        let second_device = uuid::Uuid::new_v4().to_string();
        load_or_create_cert_with_vault(&state_dir, &first_device, &vault).unwrap();

        assert!(load_or_create_cert_with_vault(&state_dir, &second_device, &vault).is_err());

        let _ = std::fs::remove_dir_all(directory);
    }
}
