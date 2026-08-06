//! Relay metadata and capability-renewal HTTP handlers.

use std::sync::Arc;

use axum::extract::Extension;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use sha2::{Digest, Sha256};

use super::auth::AuthPrincipal;
use super::relay_renewal_preface::RelayRenewalContext;
use super::ServerState;

type RelayAuthorityTokens = (
    super::relay_capability::RelayCapability,
    super::relay_renewal::RelayRenewalGrant,
);

pub async fn server_info(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
) -> impl IntoResponse {
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_default();
    let session_count = state
        .session_manager
        .list()
        .into_iter()
        .filter(|session| {
            super::device_access::can_access_session(&state.authenticator, &principal, session)
        })
        .count();
    let mut info = serde_json::json!({
        "name": hostname,
        "version": env!("CARGO_PKG_VERSION"),
        "sessions": session_count,
        "device_id": state.device_id(),
        // 自签 TLS 证书指纹(SHA256 hex),供手机钉死信任(设计稿 §4)。未启用 TLS 时为空串。
        "cert_fp": state.cert_fp(),
    });
    let device_scopes = state.authenticator.device_scopes(&principal);
    if let Some(scopes) = device_scopes.as_ref() {
        info["device_scopes"] = serde_json::to_value(scopes).unwrap_or_default();
    }
    let may_use_relay = relay_metadata_allowed(&principal, device_scopes.as_deref());
    if may_use_relay {
        // Relay metadata is configuration, not a secret, but a fail-closed
        // Release device with no scopes has no reason to receive or probe it.
        info["relay_url"] = serde_json::Value::String(state.relay_url().to_string());
        info["relay_cert_fp"] = serde_json::Value::String(state.relay_cert_fp().to_string());
    }
    if may_use_relay && relay_material_configured(&state) {
        if let Some(result) = mint_relay_authority(&state, &principal) {
            match result {
                Ok((capability, renewal_grant)) => {
                    info["relay_access_token"] = serde_json::Value::String(capability.token);
                    info["relay_access_expires_at"] = capability.expires_at.into();
                    info["relay_renewal_grant"] = serde_json::Value::String(renewal_grant.token);
                }
                Err(()) => eprintln!("[relay-capability] mint failed"),
            }
        }
    }
    let mut headers = HeaderMap::new();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    (headers, Json(info))
}

fn relay_material_configured(state: &ServerState) -> bool {
    !state.relay_url().is_empty()
        && !state.relay_cert_fp().is_empty()
        && !state.relay_register_token.is_empty()
}

/// Mint both relay tokens while the device credential store proves that the
/// exact runtime generation is current, has at least one capability, and is
/// bound to a PoP key. The read lock remains held through both HMAC commits.
fn mint_relay_authority(
    state: &ServerState,
    principal: &AuthPrincipal,
) -> Option<Result<RelayAuthorityTokens, ()>> {
    let AuthPrincipal::Device { device_id, .. } = principal else {
        return None;
    };
    state.authenticator.with_current_relay_binding(
        principal,
        |pairing_epoch, _scopes, proof_public_key| {
            let key_thumbprint = super::pop::key_thumbprint(proof_public_key);
            let capability = super::relay_capability::mint(
                &state.relay_register_token,
                state.device_id(),
                device_id,
                &key_thumbprint,
            )
            .map_err(|_| ())?;
            let renewal_grant = super::relay_renewal::mint(
                &state.relay_register_token,
                state.device_id(),
                device_id,
                pairing_epoch,
                &key_thumbprint,
            )
            .map_err(|_| ())?;
            Ok((capability, renewal_grant))
        },
    )
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RenewalAuthorityError {
    Binding,
    Mint,
}

/// Revalidate both layers of renewal authority in one credential-store read
/// transaction: the inner bearer generation and the relay-authenticated outer
/// route/grant binding must describe the same current pairing and PoP key.
fn mint_relay_authority_for_context(
    state: &ServerState,
    principal: &AuthPrincipal,
    context: &RelayRenewalContext,
) -> Result<RelayAuthorityTokens, RenewalAuthorityError> {
    let AuthPrincipal::Device { device_id, .. } = principal else {
        return Err(RenewalAuthorityError::Binding);
    };
    if context.desktop_device_id() != state.device_id() || context.client_id() != device_id {
        return Err(RenewalAuthorityError::Binding);
    }

    state
        .authenticator
        .with_current_relay_binding(principal, |pairing_epoch, _scopes, proof_public_key| {
            let key_thumbprint = super::pop::key_thumbprint(proof_public_key);
            if !constant_time_eq(pairing_epoch.as_bytes(), context.pair_epoch().as_bytes())
                || !constant_time_eq(
                    key_thumbprint.as_bytes(),
                    context.key_thumbprint().as_bytes(),
                )
            {
                return Err(RenewalAuthorityError::Binding);
            }

            let renewal_grant = super::relay_renewal::mint(
                &state.relay_register_token,
                state.device_id(),
                device_id,
                pairing_epoch,
                &key_thumbprint,
            )
            .map_err(|_| RenewalAuthorityError::Mint)?;
            let exact_digest: [u8; 32] = Sha256::digest(renewal_grant.token.as_bytes()).into();
            if !constant_time_eq(&exact_digest, context.exact_grant_digest()) {
                return Err(RenewalAuthorityError::Binding);
            }

            let capability = super::relay_capability::mint(
                &state.relay_register_token,
                state.device_id(),
                device_id,
                &key_thumbprint,
            )
            .map_err(|_| RenewalAuthorityError::Mint)?;
            Ok((capability, renewal_grant))
        })
        .ok_or(RenewalAuthorityError::Binding)?
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let length = left.len().max(right.len());
    for index in 0..length {
        difference |= usize::from(
            left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}

/// Recover a fresh short relay connect capability over the dedicated renewal
/// yamux ingress. Authentication middleware has already required the paired
/// device bearer plus HTTP PoP; this final store-locked mint closes revocation
/// and scope-update races.
pub async fn renew_relay_capability(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Extension(context): Extension<RelayRenewalContext>,
) -> axum::response::Response {
    let mut headers = HeaderMap::new();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));

    if !matches!(principal, AuthPrincipal::Device { .. }) {
        return (
            StatusCode::FORBIDDEN,
            headers,
            Json(serde_json::json!({ "error": "device credential required" })),
        )
            .into_response();
    }
    if !relay_material_configured(&state) {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            headers,
            Json(serde_json::json!({ "error": "relay unavailable" })),
        )
            .into_response();
    }

    let (capability, renewal_grant) =
        match mint_relay_authority_for_context(&state, &principal, &context) {
            Ok(tokens) => tokens,
            Err(RenewalAuthorityError::Binding) => {
                return (
                    StatusCode::FORBIDDEN,
                    headers,
                    Json(serde_json::json!({ "error": "relay authority revoked" })),
                )
                    .into_response();
            }
            Err(RenewalAuthorityError::Mint) => {
                eprintln!("[relay-capability] renewal mint failed");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    headers,
                    Json(serde_json::json!({ "error": "relay renewal failed" })),
                )
                    .into_response();
            }
        };

    (
        headers,
        Json(serde_json::json!({
            "version": 1,
            "device_id": state.device_id(),
            "relay_url": state.relay_url(),
            "relay_cert_fp": state.relay_cert_fp(),
            "relay_access_token": capability.token,
            "relay_access_expires_at": capability.expires_at,
            "relay_renewal_grant": renewal_grant.token,
        })),
    )
        .into_response()
}

pub(super) fn relay_metadata_allowed(
    principal: &AuthPrincipal,
    device_scopes: Option<&[super::device_auth::DeviceScope]>,
) -> bool {
    matches!(principal, AuthPrincipal::Owner { .. })
        || device_scopes.is_some_and(|scopes| !scopes.is_empty())
}

#[cfg(all(test, feature = "development-mobile-control"))]
mod tests {
    use super::*;
    use axum::body::Body;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    use p256::ecdsa::SigningKey;

    #[tokio::test]
    async fn renewal_context_is_exactly_bound_to_current_client_epoch_key_and_grant() {
        let signing = SigningKey::from_bytes((&[31u8; 32]).into()).unwrap();
        let public = signing.verifying_key().to_encoded_point(false);
        let authenticator = Arc::new(super::super::Authenticator::new("O".repeat(32)));
        let issued = authenticator
            .issue_device_credential_with_proof(
                "phone-a",
                "Phone A",
                &URL_SAFE_NO_PAD.encode(public.as_bytes()),
            )
            .unwrap();
        let request = axum::http::Request::builder()
            .header(header::AUTHORIZATION, format!("Bearer {}", issued.token))
            .body(Body::empty())
            .unwrap();
        let principal = authenticator.authenticate_request(&request).unwrap();
        let (pairing_epoch, key_thumbprint) = authenticator
            .with_current_relay_binding(&principal, |epoch, _scopes, key| {
                (epoch.to_string(), super::super::pop::key_thumbprint(key))
            })
            .unwrap();

        let mut state = super::super::create_dummy_state();
        state.authenticator = authenticator.clone();
        state.device_id = "desktop-a".to_string();
        state.relay_register_token = "aa".repeat(32);
        let grant = super::super::relay_renewal::mint(
            &state.relay_register_token,
            state.device_id(),
            "phone-a",
            &pairing_epoch,
            &key_thumbprint,
        )
        .unwrap();
        let digest: [u8; 32] = Sha256::digest(grant.token.as_bytes()).into();
        let valid = RelayRenewalContext::for_test(
            "desktop-a",
            "phone-a",
            &pairing_epoch,
            &key_thumbprint,
            digest,
        );
        assert!(mint_relay_authority_for_context(&state, &principal, &valid).is_ok());

        let cases = [
            RelayRenewalContext::for_test(
                "desktop-a",
                "phone-b",
                &pairing_epoch,
                &key_thumbprint,
                digest,
            ),
            RelayRenewalContext::for_test(
                "desktop-a",
                "phone-a",
                "AAAAAAAAAAAAAAAAAAAAAA",
                &key_thumbprint,
                digest,
            ),
            RelayRenewalContext::for_test(
                "desktop-a",
                "phone-a",
                &pairing_epoch,
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                digest,
            ),
            RelayRenewalContext::for_test(
                "desktop-a",
                "phone-a",
                &pairing_epoch,
                &key_thumbprint,
                [9u8; 32],
            ),
        ];
        for context in cases {
            assert_eq!(
                mint_relay_authority_for_context(&state, &principal, &context),
                Err(RenewalAuthorityError::Binding)
            );
        }

        authenticator
            .issue_device_credential_with_proof(
                "phone-a",
                "Phone A rotated",
                &URL_SAFE_NO_PAD.encode(public.as_bytes()),
            )
            .unwrap();
        assert_eq!(
            mint_relay_authority_for_context(&state, &principal, &valid),
            Err(RenewalAuthorityError::Binding),
            "captured outer context and inner principal must not survive generation rotation"
        );
    }
}
