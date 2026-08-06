//! Authentication middleware — token validation and management.
//!
//! Mirrors Go `api/auth.go`. Supports two authentication methods:
//! 1. `Authorization: Bearer <token>` header
//! 2. `Sec-WebSocket-Protocol: bearer.<token>` (for WebSocket upgrades)

use axum::{
    extract::Request,
    http::{header, StatusCode},
    middleware::Next,
    response::Response,
};
use std::sync::{Arc, Mutex, RwLock, RwLockReadGuard};

use super::ban::BanManager;
use super::device_auth::{
    DeviceCredentialInfo, DeviceCredentialStore, DeviceIdentity, DeviceScope,
    IssuedDeviceCredential, RetiredDeviceCredential, UpdatedDeviceScopes,
};
use super::private_file::atomic_write_private;

/// Transport property established by the connection acceptor.
///
/// This must come from the socket/TLS handling path rather than request headers:
/// `Host`, `Forwarded`, and similar headers are controlled by the client.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TransportSecurity {
    Plaintext,
    Tls,
}

/// Trusted ingress identity set by the socket/tunnel acceptor.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConnectionOrigin {
    Direct,
    Relay,
    RelayRenewal,
}

/// Unforgeable ingress classification computed by the socket/tunnel acceptor.
/// Request headers and relay's synthetic peer address never influence it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TrustedIngress {
    DirectLoopback,
    DirectRemote,
    Relay,
    RelayRenewal,
}

impl TrustedIngress {
    pub(crate) fn from_connection(origin: ConnectionOrigin, peer: std::net::SocketAddr) -> Self {
        match origin {
            ConnectionOrigin::Relay => Self::Relay,
            ConnectionOrigin::RelayRenewal => Self::RelayRenewal,
            ConnectionOrigin::Direct if peer.ip().is_loopback() => Self::DirectLoopback,
            ConnectionOrigin::Direct => Self::DirectRemote,
        }
    }

    pub(crate) fn is_direct_loopback(self) -> bool {
        matches!(self, Self::DirectLoopback)
    }
}

/// Authenticated identity injected into every protected request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum AuthPrincipal {
    Owner {
        /// Process-local credential generation. It rotates with every owner
        /// token change so already-upgraded sockets can be invalidated without
        /// treating the long-lived token string as connection identity.
        generation: uuid::Uuid,
    },
    Device {
        device_id: String,
        device_name: String,
        generation: uuid::Uuid,
    },
}

impl AuthPrincipal {
    pub(crate) fn owner_generation(&self) -> Option<uuid::Uuid> {
        match self {
            Self::Owner { generation } => Some(*generation),
            Self::Device { .. } => None,
        }
    }
}

/// Token-based authenticator.
pub struct Authenticator {
    owner: RwLock<OwnerCredential>,
    device_credentials: DeviceCredentialStore,
    ban_manager: Option<Arc<BanManager>>,
    /// Owner token 落盘路径。它只供本机桌面前端和管理端点使用；手机
    /// 使用独立的 per-device token，哈希存储在 `device_credentials`。
    token_file: Option<String>,
    pop_challenges: Mutex<super::pop::ChallengeStore>,
}

#[derive(Clone)]
struct OwnerCredential {
    token: String,
    generation: uuid::Uuid,
}

/// Read guard proving that one owner generation is still current. Holding it
/// prevents token rotation until the guarded synchronous mutation completes.
pub(crate) struct OwnerGenerationGuard<'a> {
    _credential: RwLockReadGuard<'a, OwnerCredential>,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum OwnerMutationError {
    /// The request authenticated with an owner generation that has since
    /// been retired. It must not be allowed to mutate the replacement token.
    Stale,
    InvalidToken(String),
    Storage(String),
}

impl std::fmt::Display for OwnerMutationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Stale => formatter.write_str("owner credential revoked"),
            Self::InvalidToken(error) | Self::Storage(error) => formatter.write_str(error),
        }
    }
}

pub(crate) struct OwnerRevokeAllOutcome {
    pub retired_generation: uuid::Uuid,
    /// Exact device generations removed by the successful credential-store
    /// commit. Empty on storage failure so callers never clean live entries.
    pub retired_devices: Vec<RetiredDeviceCredential>,
    pub devices_revoked: bool,
    pub device_error: Option<String>,
}

pub(crate) fn validate_owner_token(token: &str) -> Result<(), String> {
    if token.len() < 32 || token.len() > 128 || !token.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(
            "owner token must be 32-128 visible ASCII characters without whitespace".to_string(),
        );
    }
    Ok(())
}

impl Authenticator {
    pub fn new(token: String) -> Self {
        Self {
            owner: RwLock::new(OwnerCredential {
                token,
                generation: uuid::Uuid::new_v4(),
            }),
            device_credentials: DeviceCredentialStore::memory(),
            ban_manager: None,
            token_file: None,
            pop_challenges: Mutex::new(super::pop::ChallengeStore::default()),
        }
    }

    /// 带持久化的构造:文件存在且非空则复用旧 token(跨重启保持配对),
    /// 否则用传入的新 token 并写盘。
    pub fn new_persistent(fresh_token: String, token_file: String) -> Self {
        let token = match std::fs::read_to_string(&token_file) {
            Ok(token) if validate_owner_token(&token).is_ok() => token,
            _ => {
                if let Err(error) = Self::write_token_file(&token_file, &fresh_token) {
                    eprintln!("[auth] persist initial token failed: {}", error);
                }
                fresh_token
            }
        };
        let device_file = std::path::PathBuf::from(format!("{}.devices.json", token_file));
        Self {
            owner: RwLock::new(OwnerCredential {
                token,
                generation: uuid::Uuid::new_v4(),
            }),
            device_credentials: DeviceCredentialStore::persistent(device_file),
            ban_manager: None,
            token_file: Some(token_file),
            pop_challenges: Mutex::new(super::pop::ChallengeStore::default()),
        }
    }

    fn write_token_file(path: &str, token: &str) -> Result<(), String> {
        atomic_write_private(std::path::Path::new(path), token.as_bytes())
    }

    pub fn set_ban_manager(&mut self, bm: Arc<BanManager>) {
        self.ban_manager = Some(bm);
    }

    pub fn get_token(&self) -> String {
        self.owner.read().unwrap().token.clone()
    }

    pub(crate) fn current_owner_generation(&self) -> uuid::Uuid {
        self.owner.read().unwrap().generation
    }

    /// Replace the owner token and rotate its process-local generation.
    ///
    /// Returns the retired generation so the caller can disconnect only
    /// sockets authenticated by the old owner credential. The write lock also
    /// serializes persistence with the in-memory swap, avoiding two concurrent
    /// rotations leaving disk and memory on different tokens.
    pub(crate) fn set_token(&self, t: String) -> Result<uuid::Uuid, String> {
        validate_owner_token(&t)?;
        let mut owner = self.owner.write().unwrap();
        self.replace_owner_locked(&mut owner, t)
            .map_err(|error| error.to_string())
    }

    /// Rotate the owner token only if the request still represents the exact
    /// generation that authenticated it. The comparison and replacement share
    /// one write lock, closing auth-before-body / slow-request races.
    pub(crate) fn set_token_if_generation(
        &self,
        expected_generation: uuid::Uuid,
        token: String,
    ) -> Result<uuid::Uuid, OwnerMutationError> {
        validate_owner_token(&token).map_err(OwnerMutationError::InvalidToken)?;
        let mut owner = self.owner.write().unwrap();
        if owner.generation != expected_generation {
            return Err(OwnerMutationError::Stale);
        }
        self.replace_owner_locked(&mut owner, token)
    }

    /// Atomically gate revoke-all on the authenticating owner generation.
    /// Commit the replacement owner before clearing the independent device
    /// store so every partial failure retires the old owner fail-closed.
    pub(crate) fn revoke_all_and_set_token_if_generation(
        &self,
        expected_generation: uuid::Uuid,
        token: String,
    ) -> Result<OwnerRevokeAllOutcome, OwnerMutationError> {
        validate_owner_token(&token).map_err(OwnerMutationError::InvalidToken)?;
        let mut owner = self.owner.write().unwrap();
        if owner.generation != expected_generation {
            return Err(OwnerMutationError::Stale);
        }
        let retired_generation = self.replace_owner_locked(&mut owner, token)?;
        match self.device_credentials.revoke_all() {
            Ok(retired_devices) => {
                self.pop_challenges.lock().unwrap().clear();
                Ok(OwnerRevokeAllOutcome {
                    retired_generation,
                    retired_devices,
                    devices_revoked: true,
                    device_error: None,
                })
            }
            Err(error) => Ok(OwnerRevokeAllOutcome {
                retired_generation,
                retired_devices: Vec::new(),
                devices_revoked: false,
                device_error: Some(error),
            }),
        }
    }

    fn replace_owner_locked(
        &self,
        owner: &mut OwnerCredential,
        token: String,
    ) -> Result<uuid::Uuid, OwnerMutationError> {
        if let Some(ref f) = self.token_file {
            Self::write_token_file(f, &token).map_err(OwnerMutationError::Storage)?;
        }
        let retired_generation = owner.generation;
        *owner = OwnerCredential {
            token,
            generation: uuid::Uuid::new_v4(),
        };
        Ok(retired_generation)
    }

    pub(crate) fn validate_device_identity(
        &self,
        device_id: &str,
        device_name: &str,
    ) -> Result<DeviceIdentity, String> {
        DeviceCredentialStore::validate_identity(device_id, device_name)
    }

    pub(crate) fn issue_device_token(
        &self,
        device_id: &str,
        device_name: &str,
    ) -> Result<String, String> {
        self.device_credentials.issue(device_id, device_name)
    }

    pub(crate) fn issue_device_credential(
        &self,
        device_id: &str,
        device_name: &str,
    ) -> Result<IssuedDeviceCredential, String> {
        self.device_credentials
            .issue_with_rotation(device_id, device_name)
    }

    pub(crate) fn issue_device_credential_with_proof(
        &self,
        device_id: &str,
        device_name: &str,
        proof_public_key: &str,
    ) -> Result<IssuedDeviceCredential, String> {
        let issued = self.device_credentials.issue_with_proof_rotation(
            device_id,
            device_name,
            proof_public_key,
        )?;
        if let Some(generation) = issued.retired_generation {
            self.pop_challenges
                .lock()
                .unwrap()
                .revoke_generation(device_id, generation);
        }
        Ok(issued)
    }

    pub(crate) fn revoke_all_devices(&self) -> Result<Vec<RetiredDeviceCredential>, String> {
        let retired = self.device_credentials.revoke_all()?;
        self.pop_challenges.lock().unwrap().clear();
        Ok(retired)
    }

    pub(crate) fn list_device_credentials(&self) -> Vec<DeviceCredentialInfo> {
        self.device_credentials.list()
    }

    pub(crate) fn revoke_device(
        &self,
        device_id: &str,
    ) -> Result<Option<RetiredDeviceCredential>, String> {
        let retired = self.device_credentials.revoke_device(device_id)?;
        if let Some(retired) = &retired {
            self.pop_challenges
                .lock()
                .unwrap()
                .revoke_generation(&retired.device_id, retired.generation);
        }
        Ok(retired)
    }

    pub(crate) fn revoke_device_generation(
        &self,
        device_id: &str,
        generation: uuid::Uuid,
    ) -> Result<bool, String> {
        let revoked = self
            .device_credentials
            .revoke_generation(device_id, generation)?;
        if revoked {
            self.pop_challenges
                .lock()
                .unwrap()
                .revoke_generation(device_id, generation);
        }
        Ok(revoked)
    }

    pub(crate) fn update_device_scopes(
        &self,
        device_id: &str,
        scopes: Vec<DeviceScope>,
    ) -> Result<Option<UpdatedDeviceScopes>, String> {
        let updated = self.device_credentials.update_scopes(device_id, scopes)?;
        if let Some(updated) = &updated {
            self.pop_challenges
                .lock()
                .unwrap()
                .revoke_generation(device_id, updated.retired_generation);
        }
        Ok(updated)
    }

    /// Owner credentials have every device capability. Device credentials are
    /// checked against both their stable ID and exact runtime generation.
    pub(crate) fn principal_has_scope(
        &self,
        principal: &AuthPrincipal,
        scope: DeviceScope,
    ) -> bool {
        match principal {
            AuthPrincipal::Owner { .. } => true,
            AuthPrincipal::Device {
                device_id,
                generation,
                ..
            } => self
                .device_credentials
                .has_scope(device_id, *generation, scope),
        }
    }

    pub(crate) fn device_scopes(&self, principal: &AuthPrincipal) -> Option<Vec<DeviceScope>> {
        let AuthPrincipal::Device {
            device_id,
            generation,
            ..
        } = principal
        else {
            return None;
        };
        self.device_credentials.scopes(device_id, *generation)
    }

    pub(crate) fn device_pop_public_key(&self, principal: &AuthPrincipal) -> Option<Vec<u8>> {
        let AuthPrincipal::Device {
            device_id,
            generation,
            ..
        } = principal
        else {
            return None;
        };
        self.device_credentials
            .proof_public_key(device_id, *generation)
    }

    pub(crate) fn device_pop_thumbprint(&self, principal: &AuthPrincipal) -> Option<String> {
        self.device_pop_public_key(principal)
            .as_deref()
            .map(super::pop::key_thumbprint)
    }

    pub(crate) fn issue_device_pop_challenge(
        &self,
        principal: &AuthPrincipal,
        audience: super::pop::Audience,
    ) -> Option<super::pop::IssuedChallenge> {
        let AuthPrincipal::Device {
            device_id,
            generation,
            ..
        } = principal
        else {
            return None;
        };
        // Revalidate and require a bound key while issuing so a credential
        // rotation cannot create a challenge for the replacement generation.
        self.device_credentials
            .proof_public_key(device_id, *generation)?;
        Some(
            self.pop_challenges
                .lock()
                .unwrap()
                .issue(device_id, *generation, audience),
        )
    }

    #[cfg(test)]
    pub(crate) fn pending_device_pop_challenge_count(&self) -> usize {
        self.pop_challenges.lock().unwrap().pending_count()
    }

    fn verify_device_pop(
        &self,
        principal: &AuthPrincipal,
        request: &Request,
        token: &str,
    ) -> Result<(), ()> {
        let AuthPrincipal::Device {
            device_id,
            generation,
            ..
        } = principal
        else {
            return Ok(());
        };
        let Some(public_key) = self
            .device_credentials
            .proof_public_key(device_id, *generation)
        else {
            // Old unit-test fixtures intentionally have no phone key. Real
            // builds fail closed; this bypass cannot be compiled into a
            // distributable non-test binary.
            return if cfg!(test) { Ok(()) } else { Err(()) };
        };
        super::pop::verify_request(
            &mut self.pop_challenges.lock().unwrap(),
            request,
            token,
            device_id,
            *generation,
            &public_key,
        )
    }

    pub(crate) fn with_current_device_scope<T>(
        &self,
        principal: &AuthPrincipal,
        scope: DeviceScope,
        operation: impl FnOnce() -> T,
    ) -> Option<T> {
        match principal {
            AuthPrincipal::Owner { generation } => {
                let owner = self.owner.read().unwrap();
                if owner.generation != *generation {
                    return None;
                }
                Some(operation())
            }
            AuthPrincipal::Device {
                device_id,
                generation,
                ..
            } => {
                self.device_credentials
                    .with_current_scope(device_id, *generation, scope, operation)
            }
        }
    }

    /// Revalidate the exact credential generation used for a prior auth
    /// decision. Both device and owner generations are process-local, so a
    /// token rotation immediately makes an earlier auth decision stale.
    pub(crate) fn is_principal_current(&self, principal: &AuthPrincipal) -> bool {
        match principal {
            AuthPrincipal::Owner { generation } => {
                self.owner.read().unwrap().generation == *generation
            }
            AuthPrincipal::Device {
                device_id,
                generation,
                ..
            } => self.device_credentials.is_current(device_id, *generation),
        }
    }

    pub(crate) fn guard_owner_generation(
        &self,
        expected_generation: uuid::Uuid,
    ) -> Result<OwnerGenerationGuard<'_>, OwnerMutationError> {
        let owner = self.owner.read().unwrap();
        if owner.generation != expected_generation {
            return Err(OwnerMutationError::Stale);
        }
        Ok(OwnerGenerationGuard { _credential: owner })
    }

    pub(crate) fn guard_owner_principal(
        &self,
        principal: &AuthPrincipal,
    ) -> Result<OwnerGenerationGuard<'_>, OwnerMutationError> {
        let generation = principal
            .owner_generation()
            .ok_or(OwnerMutationError::Stale)?;
        self.guard_owner_generation(generation)
    }

    /// Serialize a process-internal local IPC owner mutation with bearer-token
    /// rotations. Callers must establish the trusted IPC origin themselves.
    pub(crate) fn guard_current_owner(&self) -> OwnerGenerationGuard<'_> {
        OwnerGenerationGuard {
            _credential: self.owner.read().unwrap(),
        }
    }

    /// Run a short synchronous commit while the exact device credential
    /// generation is protected from rotation/revocation.
    pub(crate) fn with_current_device_generation<T>(
        &self,
        device_id: &str,
        generation: uuid::Uuid,
        commit: impl FnOnce() -> T,
    ) -> Option<T> {
        self.device_credentials
            .with_current_generation(device_id, generation, commit)
    }

    /// Atomically revalidate the paired device generation and return only the
    /// material needed to mint relay capability/renewal tokens. Owner
    /// credentials deliberately have no relay-renewal binding.
    pub(crate) fn with_current_relay_binding<T>(
        &self,
        principal: &AuthPrincipal,
        operation: impl FnOnce(&str, &[DeviceScope], &[u8]) -> T,
    ) -> Option<T> {
        let AuthPrincipal::Device {
            device_id,
            generation,
            ..
        } = principal
        else {
            return None;
        };
        self.device_credentials
            .with_current_relay_binding(device_id, *generation, operation)
    }

    pub(crate) fn is_device_generation_current(
        &self,
        device_id: &str,
        generation: uuid::Uuid,
    ) -> bool {
        self.device_credentials.is_current(device_id, generation)
    }

    pub(crate) fn device_generation_has_scope(
        &self,
        device_id: &str,
        generation: uuid::Uuid,
        scope: DeviceScope,
    ) -> bool {
        self.device_credentials
            .has_scope(device_id, generation, scope)
    }

    fn authenticate_token(&self, candidate: &str) -> Option<AuthPrincipal> {
        // Always scan device hashes too, even when the owner token matches, so
        // lookup timing does not disclose which credential class was used.
        let device = self.device_credentials.authenticate(candidate);
        let owner = self.owner.read().unwrap();
        let owner_matches = !owner.token.is_empty()
            && constant_time_eq(candidate.as_bytes(), owner.token.as_bytes());
        if owner_matches {
            return Some(AuthPrincipal::Owner {
                generation: owner.generation,
            });
        }
        drop(owner);
        device.map(|device| AuthPrincipal::Device {
            device_id: device.identity.device_id,
            device_name: device.identity.device_name,
            generation: device.generation,
        })
    }

    /// Validate a request against the stored token.
    ///
    /// Checks (in order):
    /// 1. `Authorization: Bearer <token>`
    /// 2. `Sec-WebSocket-Protocol` containing `bearer.<token>`
    fn authenticate_request_with_token(&self, req: &Request) -> Option<(AuthPrincipal, String)> {
        // Method 1: Authorization header. Its presence is authoritative: an
        // invalid or duplicated value must not fall through to a second
        // credential carried in the WebSocket protocol list.
        let mut authorization = req.headers().get_all(header::AUTHORIZATION).iter();
        if let Some(auth) = authorization.next() {
            if authorization.next().is_some() {
                return None;
            }
            let auth_str = auth.to_str().ok()?;
            let token = auth_str.strip_prefix("Bearer ")?;
            if token.is_empty() || token.bytes().any(|byte| byte.is_ascii_whitespace()) {
                return None;
            }
            let principal = self.authenticate_token(token)?;
            return Some((principal, token.to_string()));
        }

        // Method 2: WebSocket sub-protocol. Require exactly one header field
        // and exactly one bearer entry so intermediaries cannot create a
        // client/server disagreement by appending another credential.
        let mut protocols = req.headers().get_all(header::SEC_WEBSOCKET_PROTOCOL).iter();
        let proto = protocols.next()?;
        if protocols.next().is_some() {
            return None;
        }
        let mut bearer = None;
        for part in proto.to_str().ok()?.split(',') {
            let trimmed = part.trim();
            if let Some(token) = trimmed.strip_prefix("bearer.") {
                if bearer.is_some()
                    || token.is_empty()
                    || token.bytes().any(|byte| byte.is_ascii_whitespace())
                {
                    return None;
                }
                bearer = Some(token);
            }
        }
        let token = bearer?;
        let principal = self.authenticate_token(token)?;
        Some((principal, token.to_string()))
    }

    pub(crate) fn authenticate_request(&self, req: &Request) -> Option<AuthPrincipal> {
        self.authenticate_request_with_token(req)
            .map(|(principal, _)| principal)
    }

    /// Compatibility helper for callers that only need a boolean result.
    pub fn validate_request(&self, req: &Request) -> bool {
        self.authenticate_request(req).is_some()
    }
}

/// Extract the real client IP from a request.
///
/// Uses axum ConnectInfo (set via into_make_service_with_connect_info).
/// Falls back to X-Forwarded-For header.
pub fn client_ip(req: &Request) -> String {
    // ConnectInfo from axum — the actual TCP peer address
    if let Some(connect_info) = req
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
    {
        return connect_info.0.ip().to_string();
    }

    // Fallback: X-Forwarded-For header
    if let Some(xff) = req.headers().get("x-forwarded-for") {
        if let Ok(xff_str) = xff.to_str() {
            if let Some(first) = xff_str.split(',').next() {
                let ip = first.trim();
                if !ip.is_empty() {
                    return ip.to_string();
                }
            }
        }
    }

    String::new()
}

/// Treat a request as remote cleartext unless the connection layer proves that
/// it arrived over TLS or from a loopback peer. Missing metadata fails closed.
fn is_remote_plaintext(req: &Request) -> bool {
    if matches!(
        req.extensions().get::<TransportSecurity>(),
        Some(TransportSecurity::Tls)
    ) {
        return false;
    }

    !req.extensions()
        .get::<TrustedIngress>()
        .is_some_and(|ingress| ingress.is_direct_loopback())
}

fn is_direct_loopback(req: &Request) -> bool {
    req.extensions()
        .get::<TrustedIngress>()
        .is_some_and(|ingress| ingress.is_direct_loopback())
}

/// Whether this request carries either credential form accepted by [`Authenticator`].
fn has_bearer_credentials(req: &Request) -> bool {
    let has_authorization_bearer = req
        .headers()
        .get_all(header::AUTHORIZATION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|value| value.split_ascii_whitespace().next())
        .any(|scheme| scheme.eq_ignore_ascii_case("bearer"));

    if has_authorization_bearer {
        return true;
    }

    req.headers()
        .get_all(header::SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .any(|protocols| {
            protocols.split(',').any(|protocol| {
                protocol
                    .trim()
                    .get(..7)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("bearer."))
            })
        })
}

/// Middleware for public endpoints that exchange pairing credentials.
/// Remote callers must use the TLS path; the embedded localhost client keeps
/// its existing cleartext behavior. Pairing is intentionally direct/native:
/// relay ingress is already reachable only after a device has paired and must
/// never become a second bootstrap path. Rejecting every browser `Origin` also
/// closes DNS-rebinding/CORS paths that could otherwise create approval prompts.
pub(crate) async fn secure_remote_middleware(
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if matches!(
        req.extensions().get::<ConnectionOrigin>(),
        Some(ConnectionOrigin::Relay | ConnectionOrigin::RelayRenewal)
    ) {
        return Err(StatusCode::FORBIDDEN);
    }
    if req.headers().contains_key(header::ORIGIN) {
        return Err(StatusCode::FORBIDDEN);
    }
    if is_remote_plaintext(&req) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(next.run(req).await)
}

/// Isolation guard for the relay renewal-only router. Connection metadata and
/// the authenticated preface context are set by the yamux/TLS acceptor and
/// cannot be forged through HTTP headers. Browser origins are rejected because
/// this is a native device recovery channel.
pub(crate) async fn renewal_ingress_middleware(
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if req.extensions().get::<ConnectionOrigin>() != Some(&ConnectionOrigin::RelayRenewal)
        || req.extensions().get::<TrustedIngress>() != Some(&TrustedIngress::RelayRenewal)
        || req.extensions().get::<TransportSecurity>() != Some(&TransportSecurity::Tls)
        || req
            .extensions()
            .get::<super::relay_renewal_preface::RelayRenewalContext>()
            .is_none()
        || req.headers().contains_key(header::ORIGIN)
    {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(next.run(req).await)
}

fn trusted_embedded_origin(req: &Request, server_port: u16) -> bool {
    if !is_direct_loopback(req) {
        return false;
    }
    let Some(origin) = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return true;
    };
    matches!(
        origin,
        "tauri://localhost"
            | "http://tauri.localhost"
            | "https://tauri.localhost"
            | "http://localhost:5175"
            | "http://127.0.0.1:5175"
    ) || origin == format!("http://127.0.0.1:{server_port}")
        || origin == format!("https://127.0.0.1:{server_port}")
        || origin == format!("http://localhost:{server_port}")
        || origin == format!("https://localhost:{server_port}")
}

/// Browser requests are accepted only from the embedded Tauri/Vite origins on
/// a connection-proven loopback socket. Native mobile clients do not send an
/// Origin header and remain unaffected. This is an explicit DNS-rebinding/CORS
/// boundary; it never treats Host or forwarding headers as transport proof.
pub(crate) async fn trusted_origin_middleware(
    server_port: u16,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if req.headers().contains_key(header::ORIGIN) && !trusted_embedded_origin(&req, server_port) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(next.run(req).await)
}

/// Axum middleware that checks authentication.
///
/// Endpoints that don't require auth (e.g., /api/ping, /api/pair) should
/// be registered outside the auth layer.
pub async fn auth_middleware(
    axum::extract::Extension(auth): axum::extract::Extension<Arc<Authenticator>>,
    mut req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    // A remote cleartext client must never be allowed to exercise a bearer
    // credential. Loopback HTTP remains supported for the embedded frontend.
    if has_bearer_credentials(&req) && is_remote_plaintext(&req) {
        return Err(StatusCode::FORBIDDEN);
    }

    // Check IP ban first
    if let Some(ref bm) = auth.ban_manager {
        let ip = client_ip(&req);
        if !ip.is_empty() && bm.is_banned(&ip) {
            return Err(StatusCode::FORBIDDEN);
        }
    }

    let (principal, authenticating_token) = auth
        .authenticate_request_with_token(&req)
        .ok_or(StatusCode::UNAUTHORIZED)?;
    // The owner token is a local desktop capability, not a remote credential.
    // In particular, relay streams use a loopback placeholder peer address, so
    // ConnectionOrigin must also prove that this is a direct local socket.
    if matches!(principal, AuthPrincipal::Owner { .. }) && !is_direct_loopback(&req) {
        return Err(StatusCode::FORBIDDEN);
    }
    // The challenge route is authenticated by the bearer but is the sole
    // device route that cannot itself carry a proof yet. Every other device
    // HTTP/WebSocket request consumes one generation-bound challenge.
    if matches!(principal, AuthPrincipal::Device { .. })
        && req.uri().path() != "/api/auth/challenge"
        && auth
            .verify_device_pop(&principal, &req, &authenticating_token)
            .is_err()
    {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let body = std::mem::take(req.body_mut());
    *req.body_mut() = super::auth_body::revocation_aware(body, auth, principal.clone());
    req.extensions_mut().insert(principal);

    Ok(next.run(req).await)
}

/// Authorization boundary for desktop-administration routes.
pub(crate) async fn owner_only_middleware(
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if !matches!(
        req.extensions().get::<AuthPrincipal>(),
        Some(AuthPrincipal::Owner { .. })
    ) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(next.run(req).await)
}

/// Authorization layer for one per-device capability. It must run inside
/// `auth_middleware`, which inserts the trusted `AuthPrincipal` extension.
/// Local owner requests retain full access.
pub(crate) async fn device_scope_middleware(
    auth: Arc<Authenticator>,
    required: DeviceScope,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let principal = req
        .extensions()
        .get::<AuthPrincipal>()
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !auth.principal_has_scope(principal, required) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(next.run(req).await)
}

/// Constant-time byte comparison to prevent timing attacks on token validation.
/// Mirrors Go's `subtle.ConstantTimeCompare`.
/// `pub(crate)` 供 hook secret 注册表复用同一套常量时间比较(见 `hook_secret`)。
pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut result: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        result |= x ^ y;
    }
    result == 0
}

#[cfg(test)]
#[path = "auth_generation_tests.rs"]
mod generation_tests;

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;

#[cfg(all(test, not(feature = "development-mobile-control")))]
#[path = "release_route_security_tests.rs"]
mod release_route_security_tests;
