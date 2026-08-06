//! Long-lived, pairing-bound authority for renewing short relay capabilities.
//!
//! This token is deliberately a separate version and canonical message from
//! `mrc2`: a renewal grant must never be accepted as a relay connect token (or
//! vice versa). The relay registration secret remains desktop-only.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;

const TOKEN_VERSION: &str = "mrr1";
const CANONICAL_VERSION: &str = "MeTerm-Relay-Renew-Grant-v1";
const MAX_ID_BYTES: usize = 128;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct RelayRenewalGrant {
    pub token: String,
}

impl std::fmt::Debug for RelayRenewalGrant {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RelayRenewalGrant")
            .field("token", &"<redacted>")
            .finish()
    }
}

pub(crate) fn mint(
    secret: &str,
    desktop_device_id: &str,
    phone_device_id: &str,
    pairing_epoch: &str,
    key_thumbprint: &str,
) -> Result<RelayRenewalGrant, String> {
    if secret.is_empty() {
        return Err("relay registration secret is missing".to_string());
    }
    if !is_valid_id(desktop_device_id) || !is_valid_id(phone_device_id) {
        return Err("invalid relay renewal identity".to_string());
    }
    if !is_canonical_fixed_bytes(pairing_epoch, 16, 22) {
        return Err("invalid relay pairing epoch".to_string());
    }
    if !is_canonical_fixed_bytes(key_thumbprint, 32, 43) {
        return Err("invalid relay proof key thumbprint".to_string());
    }

    let canonical = format!(
        "{CANONICAL_VERSION}\n{desktop_device_id}\n{phone_device_id}\n{pairing_epoch}\n{key_thumbprint}"
    );
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|_| "invalid relay registration secret".to_string())?;
    mac.update(canonical.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Ok(RelayRenewalGrant {
        token: format!("{TOKEN_VERSION}.{pairing_epoch}.{key_thumbprint}.{signature}"),
    })
}

fn is_valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'@')
        })
}

fn is_canonical_fixed_bytes(value: &str, byte_len: usize, encoded_len: usize) -> bool {
    if value.len() != encoded_len {
        return false;
    }
    let Ok(decoded) = URL_SAFE_NO_PAD.decode(value) else {
        return false;
    };
    decoded.len() == byte_len && URL_SAFE_NO_PAD.encode(decoded) == value
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shared cross-runtime vector: raw pairing epoch bytes are 00..0f.
    const PAIRING_EPOCH: &str = "AAECAwQFBgcICQoLDA0ODw";
    const KEY_THUMBPRINT: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    #[test]
    fn renewal_grant_matches_golden_vector_and_all_bindings() {
        let grant = mint(
            "test-register-secret-at-least-32-bytes",
            "desktop-123",
            "phone-456",
            PAIRING_EPOCH,
            KEY_THUMBPRINT,
        )
        .unwrap();
        assert_eq!(
            grant.token,
            "mrr1.AAECAwQFBgcICQoLDA0ODw.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.nIwwa1xDpqTYSL4KNl_hqwbEjsHvQQYOFZjPR2dvBdM"
        );
        assert_eq!(grant.token.split('.').count(), 4);
        let debug = format!("{grant:?}");
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains(&grant.token));

        let other_phone = mint(
            "test-register-secret-at-least-32-bytes",
            "desktop-123",
            "phone-other",
            PAIRING_EPOCH,
            KEY_THUMBPRINT,
        )
        .unwrap();
        assert_ne!(grant, other_phone);
        let other_epoch = URL_SAFE_NO_PAD.encode([1u8; 16]);
        assert_ne!(
            grant,
            mint(
                "test-register-secret-at-least-32-bytes",
                "desktop-123",
                "phone-456",
                &other_epoch,
                KEY_THUMBPRINT,
            )
            .unwrap()
        );
    }

    #[test]
    fn renewal_grant_rejects_noncanonical_or_invalid_inputs() {
        assert!(mint("", "desktop", "phone", PAIRING_EPOCH, KEY_THUMBPRINT).is_err());
        assert!(mint("secret", "bad/id", "phone", PAIRING_EPOCH, KEY_THUMBPRINT).is_err());
        assert!(mint(
            "secret",
            "desktop",
            "bad\nphone",
            PAIRING_EPOCH,
            KEY_THUMBPRINT
        )
        .is_err());
        assert!(mint("secret", "desktop", "phone", "not-an-epoch", KEY_THUMBPRINT).is_err());
        assert!(mint("secret", "desktop", "phone", PAIRING_EPOCH, "not-a-key").is_err());
    }
}
