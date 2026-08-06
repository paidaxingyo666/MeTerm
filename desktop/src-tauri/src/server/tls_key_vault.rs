//! OS credential-vault storage for the desktop TLS private key.
//!
//! The public certificate remains in the app data directory. The private key is stored as an
//! authority-bound record in macOS Keychain, Windows Credential Manager, or Linux Secret Service
//! through `keyring`; no generic Tauri/WebView command exposes this service.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const RELEASE_SERVICE: &str = "com.meterm.app.tls.v1";
const DEV_SERVICE: &str = "com.meterm.dev.tls.v1";
const RECORD_VERSION: u8 = 1;
const MAX_DEVICE_ID_BYTES: usize = 256;
const MAX_PRIVATE_KEY_BYTES: usize = 64 * 1024;
const MAX_RECORD_BYTES: usize = MAX_PRIVATE_KEY_BYTES + 1_024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct TlsKeyAuthority {
    build_channel: String,
    device_id: String,
    cert_fingerprint: String,
}

impl TlsKeyAuthority {
    pub(super) fn for_build(
        debug_build: bool,
        device_id: &str,
        cert_fingerprint: &str,
    ) -> Result<Self, String> {
        Self::new(build_channel(debug_build), device_id, cert_fingerprint)
    }

    fn new(build_channel: &str, device_id: &str, cert_fingerprint: &str) -> Result<Self, String> {
        if !matches!(build_channel, "dev" | "release") {
            return Err("invalid TLS vault build channel".to_string());
        }
        if device_id.is_empty()
            || device_id.len() > MAX_DEVICE_ID_BYTES
            || !device_id.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'@')
            })
        {
            return Err("invalid TLS vault device identity".to_string());
        }
        if cert_fingerprint.len() != 64
            || !cert_fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err("invalid TLS certificate fingerprint".to_string());
        }
        Ok(Self {
            build_channel: build_channel.to_string(),
            device_id: device_id.to_string(),
            cert_fingerprint: cert_fingerprint.to_string(),
        })
    }

    fn account(&self) -> String {
        let mut digest = Sha256::new();
        digest.update(b"meterm-tls-key-authority-v1\0");
        digest.update(self.build_channel.as_bytes());
        digest.update(b"\0");
        digest.update(self.device_id.as_bytes());
        digest.update(b"\0");
        digest.update(self.cert_fingerprint.as_bytes());
        format!("identity:{}", hex_lower(&digest.finalize()))
    }
}

fn build_channel(debug_build: bool) -> &'static str {
    if debug_build {
        "dev"
    } else {
        "release"
    }
}

fn service_for_channel(build_channel: &str) -> Result<&'static str, String> {
    match build_channel {
        "dev" => Ok(DEV_SERVICE),
        "release" => Ok(RELEASE_SERVICE),
        _ => Err("invalid TLS vault build channel".to_string()),
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TlsKeyRecord {
    version: u8,
    build_channel: String,
    device_id: String,
    cert_fingerprint: String,
    private_key_pem: String,
}

impl std::fmt::Debug for TlsKeyRecord {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("TlsKeyRecord(redacted)")
    }
}

fn encode_record(authority: &TlsKeyAuthority, private_key_pem: &str) -> Result<String, String> {
    validate_private_key_size(private_key_pem)?;
    let record = TlsKeyRecord {
        version: RECORD_VERSION,
        build_channel: authority.build_channel.clone(),
        device_id: authority.device_id.clone(),
        cert_fingerprint: authority.cert_fingerprint.clone(),
        private_key_pem: private_key_pem.to_string(),
    };
    let encoded = serde_json::to_string(&record)
        .map_err(|_| "failed to encode TLS vault record".to_string())?;
    if encoded.len() > MAX_RECORD_BYTES {
        return Err("TLS vault record is too large".to_string());
    }
    Ok(encoded)
}

fn decode_record(encoded: &str, authority: &TlsKeyAuthority) -> Result<String, String> {
    if encoded.len() > MAX_RECORD_BYTES {
        return Err("TLS vault record is too large".to_string());
    }
    let record: TlsKeyRecord =
        serde_json::from_str(encoded).map_err(|_| "invalid TLS vault record".to_string())?;
    if record.version != RECORD_VERSION
        || record.build_channel != authority.build_channel
        || record.device_id != authority.device_id
        || record.cert_fingerprint != authority.cert_fingerprint
    {
        return Err("TLS vault authority mismatch".to_string());
    }
    validate_private_key_size(&record.private_key_pem)?;
    Ok(record.private_key_pem)
}

fn validate_private_key_size(private_key_pem: &str) -> Result<(), String> {
    if private_key_pem.is_empty() || private_key_pem.len() > MAX_PRIVATE_KEY_BYTES {
        Err("TLS private key is empty or too large".to_string())
    } else {
        Ok(())
    }
}

pub(super) trait TlsPrivateKeyVault {
    fn load_key(&self, authority: &TlsKeyAuthority) -> Result<Option<String>, String>;
    fn store_and_verify(
        &self,
        authority: &TlsKeyAuthority,
        private_key_pem: &str,
    ) -> Result<String, String>;
    fn delete_key(&self, authority: &TlsKeyAuthority) -> Result<(), String>;
}

pub(super) struct OsTlsPrivateKeyVault;

#[cfg(target_os = "macos")]
fn create_keychain_record(service: &str, account: &str, encoded: &str) -> Result<(), String> {
    use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};

    let keychain = SecKeychain::default_for_domain(SecPreferencesDomain::User)
        .map_err(|_| "TLS credential vault is unavailable".to_string())?;
    // TLS identities always use a fresh certificate-derived account. Add-only
    // creation prevents a pre-created item with an unrelated ACL from being
    // overwritten with the new private key.
    keychain
        .add_generic_password(service, account, encoded.as_bytes())
        .map_err(|_| "failed to create TLS private key in credential vault".to_string())
}

#[cfg(not(target_os = "macos"))]
fn create_keychain_record(service: &str, account: &str, encoded: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(service, account)
        .map_err(|_| "TLS credential vault is unavailable".to_string())?;
    match entry.get_password() {
        Err(keyring::Error::NoEntry) => {}
        Ok(_) => return Err("TLS credential target already exists".to_string()),
        Err(_) => return Err("failed to inspect TLS credential target".to_string()),
    }
    entry
        .set_password(encoded)
        .map_err(|_| "failed to store TLS private key in credential vault".to_string())
}

impl TlsPrivateKeyVault for OsTlsPrivateKeyVault {
    fn load_key(&self, authority: &TlsKeyAuthority) -> Result<Option<String>, String> {
        let service = service_for_channel(&authority.build_channel)?;
        let entry = keyring::Entry::new(service, &authority.account())
            .map_err(|_| "TLS credential vault is unavailable".to_string())?;
        match entry.get_password() {
            Ok(encoded) => decode_record(&encoded, authority).map(Some),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("failed to read TLS private key from credential vault".to_string()),
        }
    }

    fn store_and_verify(
        &self,
        authority: &TlsKeyAuthority,
        private_key_pem: &str,
    ) -> Result<String, String> {
        let encoded = encode_record(authority, private_key_pem)?;
        let service = service_for_channel(&authority.build_channel)?;
        create_keychain_record(service, &authority.account(), &encoded)?;
        let reloaded = self
            .load_key(authority)?
            .ok_or_else(|| "TLS credential vault verification failed".to_string())?;
        if reloaded.as_bytes() != private_key_pem.as_bytes() {
            return Err("TLS credential vault verification failed".to_string());
        }
        Ok(reloaded)
    }

    fn delete_key(&self, authority: &TlsKeyAuthority) -> Result<(), String> {
        let service = service_for_channel(&authority.build_channel)?;
        let entry = keyring::Entry::new(service, &authority.account())
            .map_err(|_| "TLS credential vault is unavailable".to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("failed to remove TLS private key from credential vault".to_string()),
        }
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authority(channel: &str, device: &str, fill: char) -> TlsKeyAuthority {
        TlsKeyAuthority::new(channel, device, &fill.to_string().repeat(64)).unwrap()
    }

    #[test]
    fn record_is_bound_to_channel_device_and_certificate() {
        let expected = authority("dev", "device-1", 'a');
        let encoded = encode_record(
            &expected,
            "-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----",
        )
        .unwrap();
        assert!(decode_record(&encoded, &expected).is_ok());
        assert!(decode_record(&encoded, &authority("release", "device-1", 'a')).is_err());
        assert!(decode_record(&encoded, &authority("dev", "device-2", 'a')).is_err());
        assert!(decode_record(&encoded, &authority("dev", "device-1", 'b')).is_err());
    }

    #[test]
    fn authority_account_is_stable_and_separated() {
        let first = authority("dev", "device-1", 'a');
        let same = authority("dev", "device-1", 'a');
        let other = authority("release", "device-1", 'a');
        assert_eq!(first.account(), same.account());
        assert_ne!(first.account(), other.account());
        assert_eq!(first.account().len(), "identity:".len() + 64);
    }

    #[test]
    fn vault_service_is_separated_by_build_channel() {
        assert_eq!(service_for_channel("dev").unwrap(), "com.meterm.dev.tls.v1");
        assert_eq!(
            service_for_channel("release").unwrap(),
            "com.meterm.app.tls.v1"
        );
        assert!(service_for_channel("unknown").is_err());
    }
}
