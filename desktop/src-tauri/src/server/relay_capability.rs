//! Desktop-side minting of scoped relay connect capabilities.
//!
//! Keep this wire algorithm byte-for-byte aligned with
//! `relay/src/capability.rs`. The relay registration secret never leaves the
//! desktop. Phones receive only a short capability bound to the authenticated
//! device identity, target desktop, and phone proof-of-possession key.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::time::{SystemTime, UNIX_EPOCH};

const TOKEN_VERSION: &str = "mrc2";
pub const MAX_CAPABILITY_TTL_SECS: u64 = 10 * 60;
const MINT_BUCKET_SECS: u64 = 60;
const MAX_ID_BYTES: usize = 128;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct RelayCapability {
    pub token: String,
    pub expires_at: u64,
}

impl std::fmt::Debug for RelayCapability {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RelayCapability")
            .field("token", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

pub(crate) fn mint(
    secret: &str,
    desktop_device_id: &str,
    phone_client_id: &str,
    key_thumbprint: &str,
) -> Result<RelayCapability, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is before unix epoch".to_string())?
        .as_secs();
    mint_at(
        secret,
        desktop_device_id,
        phone_client_id,
        key_thumbprint,
        now,
    )
}

fn mint_at(
    secret: &str,
    desktop_device_id: &str,
    phone_client_id: &str,
    key_thumbprint: &str,
    now: u64,
) -> Result<RelayCapability, String> {
    if secret.is_empty() {
        return Err("relay registration secret is missing".to_string());
    }
    if !is_valid_id(desktop_device_id) || !is_valid_id(phone_client_id) {
        return Err("invalid relay capability identity".to_string());
    }
    if !is_valid_key_thumbprint(key_thumbprint) {
        return Err("invalid relay proof key thumbprint".to_string());
    }
    // Stable within one UTC minute so reachability polling does not rewrite the
    // secure store on every request. A token is valid for strictly more than
    // nine minutes and at most ten minutes from the minting instant.
    let expires_at = now
        .checked_div(MINT_BUCKET_SECS)
        .and_then(|bucket| bucket.checked_mul(MINT_BUCKET_SECS))
        .and_then(|bucket_start| bucket_start.checked_add(MAX_CAPABILITY_TTL_SECS))
        .ok_or_else(|| "relay capability expiry overflow".to_string())?;
    let input = format!(
        "{TOKEN_VERSION}\n{desktop_device_id}\n{phone_client_id}\n{expires_at}\n{key_thumbprint}"
    );
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|_| "invalid relay registration secret".to_string())?;
    mac.update(input.as_bytes());
    let signature = mac.finalize().into_bytes();
    Ok(RelayCapability {
        token: format!(
            "{TOKEN_VERSION}.{expires_at}.{key_thumbprint}.{}",
            URL_SAFE_NO_PAD.encode(signature)
        ),
        expires_at,
    })
}

fn is_valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'@')
        })
}

fn is_valid_key_thumbprint(value: &str) -> bool {
    if value.len() != 43 {
        return false;
    }
    let Ok(decoded) = URL_SAFE_NO_PAD.decode(value) else {
        return false;
    };
    decoded.len() == 32 && URL_SAFE_NO_PAD.encode(decoded) == value
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_THUMBPRINT: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    #[test]
    fn capability_has_expected_wire_shape_and_binding() {
        let capability = mint_at(
            "test-register-secret-at-least-32-bytes",
            "desktop-123",
            "phone-456",
            KEY_THUMBPRINT,
            1_700_000_000,
        )
        .unwrap();
        assert_eq!(capability.expires_at, 1_700_000_580);
        assert!(capability
            .token
            .starts_with(&format!("mrc2.1700000580.{KEY_THUMBPRINT}.")));
        assert_eq!(
            capability.token,
            format!("mrc2.1700000580.{KEY_THUMBPRINT}.b8ytnpA7loQmKPkpr3XNP-Kgo3lrGLPYdCj7vqqSs20")
        );
        assert!(capability.expires_at - 1_700_000_000 <= MAX_CAPABILITY_TTL_SECS);
        assert!(capability.expires_at - 1_700_000_000 > 9 * 60);
        assert_eq!(capability.token.split('.').count(), 4);
        let debug = format!("{capability:?}");
        assert!(debug.contains("<redacted>"));
        assert!(!debug.contains(&capability.token));

        let other_phone = mint_at(
            "test-register-secret-at-least-32-bytes",
            "desktop-123",
            "phone-other",
            KEY_THUMBPRINT,
            1_700_000_000,
        )
        .unwrap();
        assert_ne!(capability.token, other_phone.token);

        let other_key = URL_SAFE_NO_PAD.encode([1u8; 32]);
        let other_key_capability = mint_at(
            "test-register-secret-at-least-32-bytes",
            "desktop-123",
            "phone-456",
            &other_key,
            1_700_000_000,
        )
        .unwrap();
        assert_ne!(capability.token, other_key_capability.token);
    }

    #[test]
    fn capability_rotates_each_minute_and_never_exceeds_ten_minutes() {
        let secret = "test-register-secret-at-least-32-bytes";
        let first = mint_at(
            secret,
            "desktop-123",
            "phone-456",
            KEY_THUMBPRINT,
            1_700_000_019,
        )
        .unwrap();
        let same_bucket = mint_at(
            secret,
            "desktop-123",
            "phone-456",
            KEY_THUMBPRINT,
            1_700_000_039,
        )
        .unwrap();
        let next_bucket = mint_at(
            secret,
            "desktop-123",
            "phone-456",
            KEY_THUMBPRINT,
            1_700_000_079,
        )
        .unwrap();

        assert_eq!(first, same_bucket);
        assert_ne!(first.token, next_bucket.token);
        assert!(first.expires_at > 1_700_000_019 + 9 * 60);
        assert!(first.expires_at <= 1_700_000_019 + MAX_CAPABILITY_TTL_SECS);
    }

    #[test]
    fn capability_rejects_invalid_ids_secret_or_thumbprint() {
        assert!(mint_at("", "desktop", "phone", KEY_THUMBPRINT, 1).is_err());
        assert!(mint_at("secret", "bad/id", "phone", KEY_THUMBPRINT, 1).is_err());
        assert!(mint_at("secret", "desktop", "bad\nphone", KEY_THUMBPRINT, 1,).is_err());
        assert!(mint_at("secret", "desktop", &"a".repeat(129), KEY_THUMBPRINT, 1,).is_err());
        assert!(mint_at("secret", "desktop", "phone", "not-a-thumbprint", 1).is_err());
    }
}
