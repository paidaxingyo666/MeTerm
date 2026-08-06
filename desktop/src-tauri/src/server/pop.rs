//! Hardware-key request proof for paired mobile devices.
//!
//! A device bearer remains an identifier/rotation handle, but it is not
//! sufficient to authorize a request.  Every device request (except the
//! challenge endpoint itself) must also prove possession of the P-256 key
//! bound during pairing.  Challenges are short-lived, generation-bound, and
//! consumed exactly once before signature verification.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use axum::extract::Extension;
use axum::extract::Request;
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use p256::ecdsa::signature::Verifier as _;
use p256::ecdsa::{Signature, VerifyingKey};
use rand::RngCore as _;
use sha2::{Digest, Sha256};

pub(crate) const ALGORITHM: &str = "ES256";
pub(crate) const NONCE_HEADER: &str = "x-meterm-pop-nonce";
pub(crate) const SIGNATURE_HEADER: &str = "x-meterm-pop-signature";
const CHALLENGE_TTL: Duration = Duration::from_secs(30);
const MAX_CHALLENGES: usize = 512;
const MAX_CHALLENGES_PER_DEVICE: usize = 8;
const MAX_REQUEST_TARGET_BYTES: usize = 4096;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Audience {
    Http = 1,
    WebSocket = 2,
}

impl Audience {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "desktop-http" => Some(Self::Http),
            "desktop-ws" => Some(Self::WebSocket),
            _ => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Http => "desktop-http",
            Self::WebSocket => "desktop-ws",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct IssuedChallenge {
    pub nonce: String,
    pub expires_in: u64,
}

#[derive(serde::Deserialize)]
pub(crate) struct ChallengeRequest {
    audience: String,
}

/// Bearer-authenticated bootstrap for one request proof. The common auth
/// middleware intentionally exempts only this exact path from PoP.
pub(crate) async fn issue_challenge(
    Extension(state): Extension<std::sync::Arc<super::ServerState>>,
    Extension(principal): Extension<super::auth::AuthPrincipal>,
    Json(body): Json<ChallengeRequest>,
) -> axum::response::Response {
    let Some(audience) = Audience::parse(&body.audience) else {
        return (
            StatusCode::BAD_REQUEST,
            [(header::CACHE_CONTROL, "no-store")],
            Json(serde_json::json!({ "error": "invalid proof audience" })),
        )
            .into_response();
    };
    let Some(challenge) = state
        .authenticator
        .issue_device_pop_challenge(&principal, audience)
    else {
        return (
            StatusCode::FORBIDDEN,
            [(header::CACHE_CONTROL, "no-store")],
            Json(serde_json::json!({ "error": "device proof key unavailable" })),
        )
            .into_response();
    };
    (
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({
            "version": 1,
            "audience": audience.as_str(),
            "nonce": challenge.nonce,
            "expires_in": challenge.expires_in,
        })),
    )
        .into_response()
}

struct Challenge {
    nonce: [u8; 32],
    device_id: String,
    generation: uuid::Uuid,
    audience: Audience,
    expires_at: Instant,
}

#[derive(Default)]
pub(crate) struct ChallengeStore {
    entries: VecDeque<Challenge>,
}

impl ChallengeStore {
    pub(crate) fn issue(
        &mut self,
        device_id: &str,
        generation: uuid::Uuid,
        audience: Audience,
    ) -> IssuedChallenge {
        self.prune(Instant::now());
        while self
            .entries
            .iter()
            .filter(|entry| entry.device_id == device_id)
            .count()
            >= MAX_CHALLENGES_PER_DEVICE
        {
            if let Some(index) = self
                .entries
                .iter()
                .position(|entry| entry.device_id == device_id)
            {
                self.entries.remove(index);
            } else {
                break;
            }
        }
        while self.entries.len() >= MAX_CHALLENGES {
            self.entries.pop_front();
        }

        let mut nonce = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        self.entries.push_back(Challenge {
            nonce,
            device_id: device_id.to_string(),
            generation,
            audience,
            expires_at: Instant::now() + CHALLENGE_TTL,
        });
        IssuedChallenge {
            nonce: URL_SAFE_NO_PAD.encode(nonce),
            expires_in: CHALLENGE_TTL.as_secs(),
        }
    }

    /// Atomically remove a challenge before any expensive signature work.
    /// Invalid signatures therefore cannot be retried as an oracle.
    fn consume(
        &mut self,
        encoded_nonce: &str,
        device_id: &str,
        generation: uuid::Uuid,
        audience: Audience,
    ) -> Option<[u8; 32]> {
        self.prune(Instant::now());
        let decoded = decode_fixed::<32>(encoded_nonce)?;
        let index = self.entries.iter().position(|entry| {
            entry.nonce == decoded
                && entry.device_id == device_id
                && entry.generation == generation
                && entry.audience == audience
        })?;
        self.entries.remove(index).map(|entry| entry.nonce)
    }

    pub(crate) fn revoke_generation(&mut self, device_id: &str, generation: uuid::Uuid) {
        self.entries
            .retain(|entry| entry.device_id != device_id || entry.generation != generation);
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
    }

    #[cfg(test)]
    pub(crate) fn pending_count(&self) -> usize {
        self.entries.len()
    }

    fn prune(&mut self, now: Instant) {
        self.entries.retain(|entry| entry.expires_at > now);
    }
}

pub(crate) fn decode_public_key(value: &str) -> Result<Vec<u8>, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| "invalid proof public key".to_string())?;
    if bytes.len() != 65 || bytes.first() != Some(&0x04) {
        return Err("proof public key must be an uncompressed P-256 point".to_string());
    }
    VerifyingKey::from_sec1_bytes(&bytes)
        .map_err(|_| "invalid P-256 proof public key".to_string())?;
    if URL_SAFE_NO_PAD.encode(&bytes) != value {
        return Err("proof public key is not canonical base64url".to_string());
    }
    Ok(bytes)
}

pub(crate) fn encode_public_key(value: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(value)
}

pub(crate) fn key_thumbprint(value: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value))
}

pub(crate) fn verify_pairing_signature(
    public_key: &[u8],
    signature: &str,
    device_id: &str,
    device_name: &str,
    context: &str,
) -> Result<(), String> {
    if context.is_empty() || context.len() > 256 || context.chars().any(char::is_control) {
        return Err("invalid pairing proof context".to_string());
    }
    let message = pairing_input(device_id, device_name, context);
    verify_signature(public_key, &message, signature)
        .map_err(|_| "invalid pairing proof signature".to_string())
}

fn pairing_input(device_id: &str, device_name: &str, context: &str) -> Vec<u8> {
    format!("MeTerm-Pair-v1\n{device_id}\n{device_name}\n{context}").into_bytes()
}

pub(crate) fn verify_request(
    store: &mut ChallengeStore,
    request: &Request,
    token: &str,
    device_id: &str,
    generation: uuid::Uuid,
    public_key: &[u8],
) -> Result<(), ()> {
    let audience = request_audience(request);
    let nonce_text = single_header(request, NONCE_HEADER).ok_or(())?;
    let signature = single_header(request, SIGNATURE_HEADER).ok_or(())?;
    let nonce = store
        .consume(nonce_text, device_id, generation, audience)
        .ok_or(())?;
    let target = request
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or(request.uri().path());
    let canonical = canonical_request(audience, request.method().as_str(), token, &nonce, target)?;
    verify_signature(public_key, &canonical, signature)
}

fn request_audience(request: &Request) -> Audience {
    let is_websocket = request
        .headers()
        .get(axum::http::header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    if is_websocket {
        Audience::WebSocket
    } else {
        Audience::Http
    }
}

pub(crate) fn canonical_request(
    audience: Audience,
    method: &str,
    token: &str,
    nonce: &[u8; 32],
    target: &str,
) -> Result<Vec<u8>, ()> {
    if method.is_empty()
        || method.len() > 16
        || !method.bytes().all(|byte| byte.is_ascii_uppercase())
        || target.is_empty()
        || !target.starts_with('/')
        || target.len() > MAX_REQUEST_TARGET_BYTES
        || !target
            .bytes()
            .all(|byte| byte.is_ascii() && !byte.is_ascii_control() && byte != b'#')
        || target.len() > u16::MAX as usize
    {
        return Err(());
    }
    let mut output = Vec::with_capacity(4 + 1 + 1 + method.len() + 32 + 32 + 2 + target.len());
    output.extend_from_slice(b"MTP1");
    output.push(audience as u8);
    output.push(method.len() as u8);
    output.extend_from_slice(method.as_bytes());
    output.extend_from_slice(&Sha256::digest(token.as_bytes()));
    output.extend_from_slice(nonce);
    output.extend_from_slice(&(target.len() as u16).to_be_bytes());
    output.extend_from_slice(target.as_bytes());
    Ok(output)
}

fn verify_signature(public_key: &[u8], message: &[u8], signature: &str) -> Result<(), ()> {
    let key = VerifyingKey::from_sec1_bytes(public_key).map_err(|_| ())?;
    let raw = decode_fixed::<64>(signature).ok_or(())?;
    let signature = Signature::from_slice(&raw).map_err(|_| ())?;
    key.verify(message, &signature).map_err(|_| ())
}

fn single_header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    let mut values = request.headers().get_all(name).iter();
    let value = values.next()?.to_str().ok()?;
    if values.next().is_some() || value.is_empty() {
        return None;
    }
    Some(value)
}

fn decode_fixed<const N: usize>(value: &str) -> Option<[u8; N]> {
    let decoded = URL_SAFE_NO_PAD.decode(value).ok()?;
    let fixed: [u8; N] = decoded.try_into().ok()?;
    (URL_SAFE_NO_PAD.encode(fixed) == value).then_some(fixed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::ecdsa::signature::Signer as _;
    use p256::ecdsa::SigningKey;

    #[test]
    fn canonical_vector_is_stable() {
        let nonce: [u8; 32] = std::array::from_fn(|index| index as u8);
        let encoded = canonical_request(
            Audience::Http,
            "POST",
            "mtd_test-token",
            &nonce,
            "/api/sessions?z=1&x=%E9%9B%AA",
        )
        .unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.encode(encoded),
            "TVRQMQEEUE9TVGdPkAMeXRSdu3y8SQl93CVEhTEso7LjlCYHms4MRLtxAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8AHS9hcGkvc2Vzc2lvbnM_ej0xJng9JUU5JTlCJUFB"
        );
        assert_eq!(
            URL_SAFE_NO_PAD.encode(pairing_input("device-01", "Alice iPhone", "approval")),
            "TWVUZXJtLVBhaXItdjEKZGV2aWNlLTAxCkFsaWNlIGlQaG9uZQphcHByb3ZhbA"
        );
    }

    #[test]
    fn challenge_is_one_time_and_signature_is_bound_to_target() {
        let signing = SigningKey::from_bytes((&[7u8; 32]).into()).unwrap();
        let public = signing.verifying_key().to_encoded_point(false);
        let mut store = ChallengeStore::default();
        let generation = uuid::Uuid::new_v4();
        let issued = store.issue("phone", generation, Audience::Http);
        let nonce = decode_fixed::<32>(&issued.nonce).unwrap();
        let message =
            canonical_request(Audience::Http, "GET", "mtd_token", &nonce, "/api/info").unwrap();
        let signature: Signature = signing.sign(&message);
        let signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
        let request = Request::builder()
            .uri("/api/info")
            .header(NONCE_HEADER, &issued.nonce)
            .header(SIGNATURE_HEADER, signature)
            .body(axum::body::Body::empty())
            .unwrap();
        assert!(verify_request(
            &mut store,
            &request,
            "mtd_token",
            "phone",
            generation,
            public.as_bytes(),
        )
        .is_ok());
        assert!(verify_request(
            &mut store,
            &request,
            "mtd_token",
            "phone",
            generation,
            public.as_bytes(),
        )
        .is_err());
    }

    #[test]
    fn ambiguous_headers_are_rejected_and_invalid_signature_consumes_nonce() {
        let signing = SigningKey::from_bytes((&[7u8; 32]).into()).unwrap();
        let public = signing.verifying_key().to_encoded_point(false);
        let generation = uuid::Uuid::new_v4();
        let mut store = ChallengeStore::default();

        let issued = store.issue("phone", generation, Audience::Http);
        let nonce = decode_fixed::<32>(&issued.nonce).unwrap();
        let message =
            canonical_request(Audience::Http, "GET", "mtd_token", &nonce, "/api/info").unwrap();
        let signature: Signature = signing.sign(&message);
        let signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
        let mut duplicate = Request::builder()
            .uri("/api/info")
            .header(NONCE_HEADER, &issued.nonce)
            .header(SIGNATURE_HEADER, &signature)
            .body(axum::body::Body::empty())
            .unwrap();
        duplicate.headers_mut().append(
            NONCE_HEADER,
            axum::http::HeaderValue::from_str(&issued.nonce).unwrap(),
        );
        assert!(verify_request(
            &mut store,
            &duplicate,
            "mtd_token",
            "phone",
            generation,
            public.as_bytes(),
        )
        .is_err());

        // Header ambiguity is rejected before consumption; the canonical
        // single-header form may still use the challenge once.
        let valid = Request::builder()
            .uri("/api/info")
            .header(NONCE_HEADER, &issued.nonce)
            .header(SIGNATURE_HEADER, &signature)
            .body(axum::body::Body::empty())
            .unwrap();
        assert!(verify_request(
            &mut store,
            &valid,
            "mtd_token",
            "phone",
            generation,
            public.as_bytes(),
        )
        .is_ok());

        let issued = store.issue("phone", generation, Audience::Http);
        let invalid = Request::builder()
            .uri("/api/info")
            .header(NONCE_HEADER, &issued.nonce)
            .header(SIGNATURE_HEADER, URL_SAFE_NO_PAD.encode([0u8; 64]))
            .body(axum::body::Body::empty())
            .unwrap();
        assert!(verify_request(
            &mut store,
            &invalid,
            "mtd_token",
            "phone",
            generation,
            public.as_bytes(),
        )
        .is_err());

        let nonce = decode_fixed::<32>(&issued.nonce).unwrap();
        let message =
            canonical_request(Audience::Http, "GET", "mtd_token", &nonce, "/api/info").unwrap();
        let signature: Signature = signing.sign(&message);
        let retry = Request::builder()
            .uri("/api/info")
            .header(NONCE_HEADER, &issued.nonce)
            .header(
                SIGNATURE_HEADER,
                URL_SAFE_NO_PAD.encode(signature.to_bytes()),
            )
            .body(axum::body::Body::empty())
            .unwrap();
        assert!(verify_request(
            &mut store,
            &retry,
            "mtd_token",
            "phone",
            generation,
            public.as_bytes(),
        )
        .is_err());
    }

    #[test]
    fn public_key_and_pairing_signature_are_strict() {
        let signing = SigningKey::from_bytes((&[9u8; 32]).into()).unwrap();
        let public = signing.verifying_key().to_encoded_point(false);
        let encoded = encode_public_key(public.as_bytes());
        assert_eq!(decode_public_key(&encoded).unwrap(), public.as_bytes());
        assert_eq!(key_thumbprint(public.as_bytes()).len(), 43);

        let message = b"MeTerm-Pair-v1\nphone-1\nPhone\napproval";
        let signature: Signature = signing.sign(message);
        let signature = URL_SAFE_NO_PAD.encode(signature.to_bytes());
        assert!(verify_pairing_signature(
            public.as_bytes(),
            &signature,
            "phone-1",
            "Phone",
            "approval"
        )
        .is_ok());
        assert!(verify_pairing_signature(
            public.as_bytes(),
            &signature,
            "phone-2",
            "Phone",
            "approval"
        )
        .is_err());
    }
}
