//! Authenticated relay-to-desktop renewal stream classification.
//!
//! Ordinary relay substreams contain phone-controlled TLS bytes. A one-byte
//! marker therefore cannot grant access to the renewal-only router. The relay
//! prefixes a bounded, HMAC-authenticated binding made with the desktop's
//! registration secret; only this module may turn it into trusted request
//! context.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, BufReader};

pub(crate) const STREAM_MARKER: u8 = 0xF1;
pub(crate) const TLS_HANDSHAKE_RECORD: u8 = 0x16;

const MAGIC: &[u8; 4] = b"MTRR";
const VERSION: u8 = 1;
const DOMAIN: &[u8] = b"MeTerm-Relay-Renew-Preface-v1\0";
const MAX_PREFACE_BYTES: usize = 408;
const HEADER_BYTES: usize = 8;
const PAIR_EPOCH_BYTES: usize = 16;
const KEY_THUMBPRINT_BYTES: usize = 32;
const GRANT_DIGEST_BYTES: usize = 32;
const NONCE_BYTES: usize = 32;
const TAG_BYTES: usize = 32;
const TRAILER_BYTES: usize =
    PAIR_EPOCH_BYTES + KEY_THUMBPRINT_BYTES + GRANT_DIGEST_BYTES + NONCE_BYTES + TAG_BYTES;
const STREAM_CLASSIFY_TIMEOUT: Duration = Duration::from_secs(10);

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct RelayRenewalContext {
    desktop_device_id: String,
    client_id: String,
    pair_epoch: String,
    key_thumbprint: String,
    exact_grant_digest: [u8; GRANT_DIGEST_BYTES],
}

impl std::fmt::Debug for RelayRenewalContext {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("RelayRenewalContext(redacted)")
    }
}

impl RelayRenewalContext {
    pub(crate) fn desktop_device_id(&self) -> &str {
        &self.desktop_device_id
    }

    pub(crate) fn client_id(&self) -> &str {
        &self.client_id
    }

    pub(crate) fn pair_epoch(&self) -> &str {
        &self.pair_epoch
    }

    pub(crate) fn key_thumbprint(&self) -> &str {
        &self.key_thumbprint
    }

    pub(crate) fn exact_grant_digest(&self) -> &[u8; GRANT_DIGEST_BYTES] {
        &self.exact_grant_digest
    }

    #[cfg(test)]
    pub(crate) fn for_test(
        desktop_device_id: &str,
        client_id: &str,
        pair_epoch: &str,
        key_thumbprint: &str,
        exact_grant_digest: [u8; GRANT_DIGEST_BYTES],
    ) -> Self {
        assert!(is_valid_id(desktop_device_id));
        assert!(is_valid_id(client_id));
        assert_canonical_fixed::<PAIR_EPOCH_BYTES>(pair_epoch);
        assert_canonical_fixed::<KEY_THUMBPRINT_BYTES>(key_thumbprint);
        Self {
            desktop_device_id: desktop_device_id.to_string(),
            client_id: client_id.to_string(),
            pair_epoch: pair_epoch.to_string(),
            key_thumbprint: key_thumbprint.to_string(),
            exact_grant_digest,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RenewalPrefaceError {
    Malformed,
    Authentication,
    WrongDesktop,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RelayStreamKind {
    Full,
    Renewal(RelayRenewalContext),
}

/// Classify one relay substream without consuming the first TLS record byte.
/// Renewal is selected only after the complete relay-authenticated preface is
/// verified. Unknown, incomplete, or bare-marker streams are dropped before
/// they reach either HTTP router.
pub(crate) async fn classify_relay_stream<S>(
    stream: S,
    register_secret: &[u8],
    expected_desktop_device_id: &str,
) -> Option<(RelayStreamKind, BufReader<S>)>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    tokio::time::timeout(
        STREAM_CLASSIFY_TIMEOUT,
        classify_relay_stream_inner(stream, register_secret, expected_desktop_device_id),
    )
    .await
    .ok()?
}

/// Bind the authenticated inner device to the relay-authenticated outer route
/// before the renewal challenge handler can allocate a nonce. This layer is
/// installed only on the renewal router and must run inside auth_middleware.
pub(crate) async fn renewal_principal_binding_middleware(
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let state = req
        .extensions()
        .get::<Arc<super::ServerState>>()
        .ok_or(StatusCode::FORBIDDEN)?;
    let context = req
        .extensions()
        .get::<RelayRenewalContext>()
        .ok_or(StatusCode::FORBIDDEN)?;
    let principal = req
        .extensions()
        .get::<super::auth::AuthPrincipal>()
        .ok_or(StatusCode::FORBIDDEN)?;
    let super::auth::AuthPrincipal::Device { device_id, .. } = principal else {
        return Err(StatusCode::FORBIDDEN);
    };
    if context.desktop_device_id() != state.device_id() || context.client_id() != device_id {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(next.run(req).await)
}

async fn classify_relay_stream_inner<S>(
    stream: S,
    register_secret: &[u8],
    expected_desktop_device_id: &str,
) -> Option<(RelayStreamKind, BufReader<S>)>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut stream = BufReader::new(stream);
    let first = stream.fill_buf().await.ok()?.first().copied()?;
    match first {
        STREAM_MARKER => {
            let context = read_authenticated_preface(
                &mut stream,
                register_secret,
                expected_desktop_device_id,
            )
            .await
            .ok()?;
            if stream.fill_buf().await.ok()?.first().copied()? != TLS_HANDSHAKE_RECORD {
                return None;
            }
            Some((RelayStreamKind::Renewal(context), stream))
        }
        TLS_HANDSHAKE_RECORD => Some((RelayStreamKind::Full, stream)),
        _ => None,
    }
}

/// Read and authenticate exactly one bounded preface. The caller owns the
/// total classification timeout and must verify that TLS follows immediately.
async fn read_authenticated_preface<S>(
    stream: &mut S,
    register_secret: &[u8],
    expected_desktop_device_id: &str,
) -> Result<RelayRenewalContext, RenewalPrefaceError>
where
    S: AsyncRead + Unpin,
{
    if register_secret.is_empty() || !is_valid_id(expected_desktop_device_id) {
        return Err(RenewalPrefaceError::Authentication);
    }

    let mut header = [0u8; HEADER_BYTES];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|_| RenewalPrefaceError::Malformed)?;
    if header[0] != STREAM_MARKER || &header[1..5] != MAGIC || header[5] != VERSION {
        return Err(RenewalPrefaceError::Malformed);
    }
    let desktop_len = usize::from(header[6]);
    let client_len = usize::from(header[7]);
    if desktop_len == 0 || desktop_len > 128 || client_len == 0 || client_len > 128 {
        return Err(RenewalPrefaceError::Malformed);
    }
    let total_len = HEADER_BYTES + desktop_len + client_len + TRAILER_BYTES;
    if total_len > MAX_PREFACE_BYTES {
        return Err(RenewalPrefaceError::Malformed);
    }

    let mut wire = Vec::with_capacity(total_len);
    wire.extend_from_slice(&header);
    wire.resize(total_len, 0);
    stream
        .read_exact(&mut wire[HEADER_BYTES..])
        .await
        .map_err(|_| RenewalPrefaceError::Malformed)?;

    let unsigned_len = total_len - TAG_BYTES;
    let mut mac = HmacSha256::new_from_slice(register_secret)
        .map_err(|_| RenewalPrefaceError::Authentication)?;
    mac.update(DOMAIN);
    mac.update(&wire[..unsigned_len]);
    mac.verify_slice(&wire[unsigned_len..])
        .map_err(|_| RenewalPrefaceError::Authentication)?;

    let mut offset = HEADER_BYTES;
    let desktop_device_id = parse_id(&wire[offset..offset + desktop_len])?;
    offset += desktop_len;
    let client_id = parse_id(&wire[offset..offset + client_len])?;
    offset += client_len;
    if desktop_device_id != expected_desktop_device_id {
        return Err(RenewalPrefaceError::WrongDesktop);
    }

    let pair_epoch = URL_SAFE_NO_PAD.encode(&wire[offset..offset + PAIR_EPOCH_BYTES]);
    offset += PAIR_EPOCH_BYTES;
    let key_thumbprint = URL_SAFE_NO_PAD.encode(&wire[offset..offset + KEY_THUMBPRINT_BYTES]);
    offset += KEY_THUMBPRINT_BYTES;
    let exact_grant_digest = wire[offset..offset + GRANT_DIGEST_BYTES]
        .try_into()
        .map_err(|_| RenewalPrefaceError::Malformed)?;

    Ok(RelayRenewalContext {
        desktop_device_id,
        client_id,
        pair_epoch,
        key_thumbprint,
        exact_grant_digest,
    })
}

fn parse_id(bytes: &[u8]) -> Result<String, RenewalPrefaceError> {
    let value = std::str::from_utf8(bytes).map_err(|_| RenewalPrefaceError::Malformed)?;
    if !is_valid_id(value) {
        return Err(RenewalPrefaceError::Malformed);
    }
    Ok(value.to_string())
}

fn is_valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'@')
        })
}

#[cfg(test)]
fn assert_canonical_fixed<const N: usize>(value: &str) {
    let decoded = URL_SAFE_NO_PAD.decode(value).unwrap();
    let fixed: [u8; N] = decoded.try_into().unwrap();
    assert_eq!(URL_SAFE_NO_PAD.encode(fixed), value);
}
