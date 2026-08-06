use super::{
    auth_middleware, device_scope_middleware, has_bearer_credentials, is_remote_plaintext,
    owner_only_middleware, secure_remote_middleware, trusted_embedded_origin, validate_owner_token,
    Authenticator, ConnectionOrigin, TransportSecurity, TrustedIngress,
};
use crate::server::device_auth::DeviceScope;
use axum::{
    body::Body,
    extract::{ConnectInfo, Request},
    http::{header, HeaderValue, StatusCode},
    middleware,
    routing::get,
    Router,
};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use tower::ServiceExt;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::{Signature, SigningKey};

#[test]
fn owner_token_policy_requires_long_visible_ascii() {
    assert!(validate_owner_token(&"a".repeat(32)).is_ok());
    assert!(validate_owner_token(&"A".repeat(128)).is_ok());
    assert!(validate_owner_token(&"a".repeat(31)).is_err());
    assert!(validate_owner_token(&"a".repeat(129)).is_err());
    assert!(validate_owner_token(&format!("{} ", "a".repeat(31))).is_err());
    assert!(validate_owner_token(&format!("{}\n", "a".repeat(31))).is_err());
    assert!(validate_owner_token(&format!("{}é", "a".repeat(31))).is_err());
}

#[test]
fn persistent_owner_token_replaces_and_reloads_privately() {
    let directory =
        std::env::temp_dir().join(format!("meterm-owner-token-test-{}", uuid::Uuid::new_v4()));
    let path = directory.join("owner-token");
    let path_string = path.to_string_lossy().to_string();
    let first = "A".repeat(43);
    let second = "B".repeat(32);

    let authenticator = Authenticator::new_persistent(first, path_string.clone());
    authenticator.set_token(second.clone()).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), second);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    let reloaded = Authenticator::new_persistent("C".repeat(43), path_string);
    assert_eq!(reloaded.get_token(), second);
    assert!(reloaded.set_token("too-short".to_string()).is_err());
    assert_eq!(reloaded.get_token(), "B".repeat(32));

    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn owner_rotation_invalidates_only_retired_owner_generation() {
    let first = "A".repeat(32);
    let second = "B".repeat(32);
    let authenticator = Authenticator::new(first.clone());
    let device_token = authenticator
        .issue_device_token("device-1", "Alice Phone")
        .unwrap();
    let old_owner = authenticator.authenticate_token(&first).unwrap();
    let device = authenticator.authenticate_token(&device_token).unwrap();

    let retired = authenticator.set_token(second.clone()).unwrap();
    assert!(matches!(
        &old_owner,
        super::AuthPrincipal::Owner { generation } if *generation == retired
    ));
    assert!(!authenticator.is_principal_current(&old_owner));
    assert!(authenticator.is_principal_current(&device));

    let new_owner = authenticator.authenticate_token(&second).unwrap();
    assert!(authenticator.is_principal_current(&new_owner));
    assert_ne!(old_owner, new_owner);
    assert!(authenticator.authenticate_token(&first).is_none());
}

fn request(
    peer: Option<IpAddr>,
    transport: Option<TransportSecurity>,
    authorization: Option<&str>,
    websocket_protocol: Option<&str>,
) -> Request {
    let mut request = Request::new(Body::empty());
    if let Some(peer) = peer {
        request
            .extensions_mut()
            .insert(ConnectInfo(SocketAddr::new(peer, 12345)));
        request.extensions_mut().insert(ConnectionOrigin::Direct);
        request.extensions_mut().insert(if peer.is_loopback() {
            TrustedIngress::DirectLoopback
        } else {
            TrustedIngress::DirectRemote
        });
    }
    if let Some(transport) = transport {
        request.extensions_mut().insert(transport);
    }
    if let Some(value) = authorization {
        request
            .headers_mut()
            .insert(header::AUTHORIZATION, HeaderValue::from_str(value).unwrap());
    }
    if let Some(value) = websocket_protocol {
        request.headers_mut().insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_str(value).unwrap(),
        );
    }
    request
}

#[test]
fn remote_plaintext_is_untrusted() {
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))),
        Some(TransportSecurity::Plaintext),
        None,
        None,
    );

    assert!(is_remote_plaintext(&request));
}

#[test]
fn loopback_plaintext_remains_allowed() {
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        Some(TransportSecurity::Plaintext),
        Some("Bearer secret"),
        None,
    );

    assert!(!is_remote_plaintext(&request));
}

#[test]
fn remote_tls_remains_allowed() {
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))),
        Some(TransportSecurity::Tls),
        Some("Bearer secret"),
        None,
    );

    assert!(!is_remote_plaintext(&request));
}

#[test]
fn missing_transport_marker_fails_closed_for_remote_peer() {
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))),
        None,
        Some("Bearer secret"),
        None,
    );

    assert!(is_remote_plaintext(&request));
}

#[test]
fn missing_peer_metadata_fails_closed_for_plaintext() {
    let request = request(
        None,
        Some(TransportSecurity::Plaintext),
        Some("Bearer secret"),
        None,
    );

    assert!(is_remote_plaintext(&request));
}

#[test]
fn both_supported_bearer_forms_are_detected() {
    let authorization = request(None, None, Some("Bearer secret"), None);
    let websocket = request(None, None, None, Some("meterm.v1, bearer.secret"));

    assert!(has_bearer_credentials(&authorization));
    assert!(has_bearer_credentials(&websocket));
}

#[test]
fn unrelated_credentials_are_not_misclassified() {
    let request = request(None, None, Some("Basic credentials"), Some("meterm.v1"));

    assert!(!has_bearer_credentials(&request));
}

#[test]
fn ambiguous_bearer_headers_do_not_authenticate_or_fall_through() {
    let authenticator = Authenticator::new("owner-secret".to_string());

    let mut duplicate_authorization = request(
        None,
        None,
        Some("Bearer owner-secret"),
        Some("meterm.v1, bearer.owner-secret"),
    );
    duplicate_authorization.headers_mut().append(
        header::AUTHORIZATION,
        HeaderValue::from_static("Bearer owner-secret"),
    );
    assert!(authenticator
        .authenticate_request(&duplicate_authorization)
        .is_none());

    let conflicting_protocols = request(
        None,
        None,
        None,
        Some("meterm.v1, bearer.owner-secret, bearer.other"),
    );
    assert!(authenticator
        .authenticate_request(&conflicting_protocols)
        .is_none());

    let mut duplicate_protocol_headers =
        request(None, None, None, Some("meterm.v1, bearer.owner-secret"));
    duplicate_protocol_headers.headers_mut().append(
        header::SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static("bearer.owner-secret"),
    );
    assert!(authenticator
        .authenticate_request(&duplicate_protocol_headers)
        .is_none());
}

#[test]
fn browser_origins_are_exact_and_loopback_bound() {
    let mut tauri = request(
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        Some(TransportSecurity::Plaintext),
        None,
        None,
    );
    tauri.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_static("tauri://localhost"),
    );
    assert!(trusted_embedded_origin(&tauri, 8022));

    let mut same_server = request(
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        Some(TransportSecurity::Plaintext),
        None,
        None,
    );
    same_server.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_static("https://127.0.0.1:8022"),
    );
    assert!(trusted_embedded_origin(&same_server, 8022));

    let mut attacker = request(
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        Some(TransportSecurity::Plaintext),
        None,
        None,
    );
    attacker.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_static("https://attacker.example"),
    );
    assert!(!trusted_embedded_origin(&attacker, 8022));

    let mut forged_remote = request(
        Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))),
        Some(TransportSecurity::Tls),
        None,
        None,
    );
    forged_remote.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_static("tauri://localhost"),
    );
    assert!(!trusted_embedded_origin(&forged_remote, 8022));
}

fn protected_app_with(authenticator: Arc<Authenticator>) -> Router {
    let auth_layer = middleware::from_fn(move |request, next| {
        let authenticator = authenticator.clone();
        async move { auth_middleware(axum::extract::Extension(authenticator), request, next).await }
    });

    Router::new()
        .route("/", get(|| async { StatusCode::NO_CONTENT }))
        .layer(auth_layer)
}

fn protected_app() -> Router {
    protected_app_with(Arc::new(Authenticator::new("secret".to_string())))
}

fn owner_app(authenticator: Arc<Authenticator>) -> Router {
    let auth_layer = middleware::from_fn(move |request, next| {
        let authenticator = authenticator.clone();
        async move { auth_middleware(axum::extract::Extension(authenticator), request, next).await }
    });

    Router::new()
        .route("/", get(|| async { StatusCode::NO_CONTENT }))
        .layer(middleware::from_fn(owner_only_middleware))
        .layer(auth_layer)
}

fn scoped_app(authenticator: Arc<Authenticator>, required: DeviceScope) -> Router {
    let auth_layer = middleware::from_fn({
        let authenticator = authenticator.clone();
        move |request, next| {
            let authenticator = authenticator.clone();
            async move { auth_middleware(axum::extract::Extension(authenticator), request, next).await }
        }
    });
    let scope_layer = middleware::from_fn(move |request, next| {
        let authenticator = authenticator.clone();
        async move { device_scope_middleware(authenticator, required, request, next).await }
    });

    Router::new()
        .route("/", get(|| async { StatusCode::NO_CONTENT }))
        .layer(scope_layer)
        .layer(auth_layer)
}

#[tokio::test]
#[cfg(not(feature = "development-mobile-control"))]
async fn standard_build_device_defaults_deny_every_sensitive_scope() {
    let authenticator = Arc::new(Authenticator::new("O".repeat(32)));
    let token = authenticator
        .issue_device_token("device-1", "Phone")
        .unwrap();

    for scope in [
        DeviceScope::DesktopControl,
        DeviceScope::SshDesktopConnect,
        DeviceScope::SshConnectionsWrite,
        DeviceScope::SshSecretsExport,
        DeviceScope::PushSelf,
    ] {
        let response = scoped_app(authenticator.clone(), scope)
            .oneshot(request(
                Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
                Some(TransportSecurity::Plaintext),
                Some(&format!("Bearer {token}")),
                None,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "scope={scope:?}");
    }
}

#[tokio::test]
#[cfg(feature = "development-mobile-control")]
async fn development_build_device_defaults_allow_only_documented_scopes() {
    let authenticator = Arc::new(Authenticator::new("O".repeat(32)));
    let token = authenticator
        .issue_device_token("device-1", "Phone")
        .unwrap();

    for (scope, expected) in [
        (DeviceScope::DesktopControl, StatusCode::NO_CONTENT),
        (DeviceScope::SshDesktopConnect, StatusCode::NO_CONTENT),
        (DeviceScope::SshConnectionsWrite, StatusCode::NO_CONTENT),
        (DeviceScope::SshSecretsExport, StatusCode::FORBIDDEN),
        (DeviceScope::PushSelf, StatusCode::NO_CONTENT),
    ] {
        let response = scoped_app(authenticator.clone(), scope)
            .oneshot(request(
                Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
                Some(TransportSecurity::Plaintext),
                Some(&format!("Bearer {token}")),
                None,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), expected, "scope={scope:?}");
    }
}

#[tokio::test]
async fn local_owner_retains_every_device_scope() {
    let owner = "O".repeat(32);
    let authenticator = Arc::new(Authenticator::new(owner.clone()));
    let response = scoped_app(authenticator, DeviceScope::SshSecretsExport)
        .oneshot(request(
            Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
            Some(TransportSecurity::Plaintext),
            Some(&format!("Bearer {owner}")),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn auth_middleware_blocks_remote_plaintext_bearer() {
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))),
        Some(TransportSecurity::Plaintext),
        Some("Bearer secret"),
        None,
    );

    let response = protected_app().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn auth_middleware_allows_loopback_plaintext_bearer() {
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        Some(TransportSecurity::Plaintext),
        Some("Bearer secret"),
        None,
    );

    let response = protected_app().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn owner_token_is_rejected_on_lan_tls() {
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))),
        Some(TransportSecurity::Tls),
        Some("Bearer secret"),
        None,
    );

    let response = protected_app().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn pairing_middleware_blocks_remote_plaintext_without_headers() {
    let app = Router::new()
        .route("/", get(|| async { StatusCode::NO_CONTENT }))
        .layer(middleware::from_fn(secure_remote_middleware));
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))),
        Some(TransportSecurity::Plaintext),
        None,
        None,
    );

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn pairing_middleware_rejects_browser_origin_even_on_loopback_tls() {
    let app = Router::new()
        .route("/", get(|| async { StatusCode::NO_CONTENT }))
        .layer(middleware::from_fn(secure_remote_middleware));
    let mut request = request(
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        Some(TransportSecurity::Tls),
        None,
        None,
    );
    request.headers_mut().insert(
        header::ORIGIN,
        HeaderValue::from_static("https://attacker.example"),
    );

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn pairing_middleware_allows_native_client_without_origin_over_tls() {
    let app = Router::new()
        .route("/", get(|| async { StatusCode::NO_CONTENT }))
        .layer(middleware::from_fn(secure_remote_middleware));
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))),
        Some(TransportSecurity::Tls),
        None,
        None,
    );

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn pairing_middleware_rejects_relay_ingress_before_bootstrap() {
    let app = Router::new()
        .route("/", get(|| async { StatusCode::NO_CONTENT }))
        .layer(middleware::from_fn(secure_remote_middleware));
    let mut request = request(
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        Some(TransportSecurity::Tls),
        None,
        None,
    );
    request.extensions_mut().insert(ConnectionOrigin::Relay);
    request.extensions_mut().insert(TrustedIngress::Relay);

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn device_token_authenticates_on_business_route() {
    let authenticator = Arc::new(Authenticator::new("owner-secret".to_string()));
    let device_token = authenticator
        .issue_device_token("device-1", "Alice Phone")
        .unwrap();
    let authorization = format!("Bearer {}", device_token);
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        Some(TransportSecurity::Plaintext),
        Some(&authorization),
        None,
    );

    let response = protected_app_with(authenticator)
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn proof_bound_device_rejects_copied_bearer_and_replayed_signature() {
    let authenticator = Arc::new(Authenticator::new("owner-secret".to_string()));
    let signing = SigningKey::from_bytes((&[23u8; 32]).into()).unwrap();
    let public = signing.verifying_key().to_encoded_point(false);
    let issued = authenticator
        .issue_device_credential_with_proof(
            "device-pop",
            "Proof Phone",
            &URL_SAFE_NO_PAD.encode(public.as_bytes()),
        )
        .unwrap();
    let principal = authenticator.authenticate_token(&issued.token).unwrap();
    let challenge = authenticator
        .issue_device_pop_challenge(&principal, crate::server::pop::Audience::Http)
        .unwrap();
    let nonce: [u8; 32] = URL_SAFE_NO_PAD
        .decode(&challenge.nonce)
        .unwrap()
        .try_into()
        .unwrap();
    let canonical = crate::server::pop::canonical_request(
        crate::server::pop::Audience::Http,
        "GET",
        &issued.token,
        &nonce,
        "/api/info?probe=1",
    )
    .unwrap();
    let signature: Signature = signing.sign(&canonical);

    let app = {
        let auth_layer = middleware::from_fn({
            let authenticator = authenticator.clone();
            move |request, next| {
                let authenticator = authenticator.clone();
                async move {
                    auth_middleware(axum::extract::Extension(authenticator), request, next).await
                }
            }
        });
        Router::new()
            .route("/api/info", get(|| async { StatusCode::NO_CONTENT }))
            .layer(auth_layer)
    };

    let signed_request = || {
        let mut request = request(
            Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))),
            Some(TransportSecurity::Tls),
            Some(&format!("Bearer {}", issued.token)),
            None,
        );
        *request.uri_mut() = "/api/info?probe=1".parse().unwrap();
        request.headers_mut().insert(
            crate::server::pop::NONCE_HEADER,
            HeaderValue::from_str(&challenge.nonce).unwrap(),
        );
        request.headers_mut().insert(
            crate::server::pop::SIGNATURE_HEADER,
            HeaderValue::from_str(&URL_SAFE_NO_PAD.encode(signature.to_bytes())).unwrap(),
        );
        request
    };

    assert_eq!(
        app.clone()
            .oneshot(signed_request())
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        app.clone()
            .oneshot(signed_request())
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let copied_bearer = request(
        Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))),
        Some(TransportSecurity::Tls),
        Some(&format!("Bearer {}", issued.token)),
        None,
    );
    let mut copied_bearer = copied_bearer;
    *copied_bearer.uri_mut() = "/api/info".parse().unwrap();
    assert_eq!(
        app.oneshot(copied_bearer).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn owner_only_route_rejects_device_token() {
    let authenticator = Arc::new(Authenticator::new("owner-secret".to_string()));
    let device_token = authenticator
        .issue_device_token("device-1", "Alice Phone")
        .unwrap();
    let authorization = format!("Bearer {}", device_token);
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        Some(TransportSecurity::Plaintext),
        Some(&authorization),
        None,
    );

    let response = owner_app(authenticator).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn legacy_owner_token_still_reaches_owner_route() {
    let authenticator = Arc::new(Authenticator::new("owner-secret".to_string()));
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        Some(TransportSecurity::Plaintext),
        Some("Bearer owner-secret"),
        None,
    );

    let response = owner_app(authenticator).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn owner_token_is_rejected_on_relay_even_with_loopback_placeholder() {
    let authenticator = Arc::new(Authenticator::new("owner-secret".to_string()));
    let mut request = request(
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        Some(TransportSecurity::Tls),
        Some("Bearer owner-secret"),
        None,
    );
    request.extensions_mut().insert(ConnectionOrigin::Relay);
    request.extensions_mut().insert(TrustedIngress::Relay);

    let response = protected_app_with(authenticator)
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn device_token_is_allowed_on_lan_tls() {
    let authenticator = Arc::new(Authenticator::new("owner-secret".to_string()));
    let device_token = authenticator
        .issue_device_token("device-1", "Alice Phone")
        .unwrap();
    let authorization = format!("Bearer {}", device_token);
    let request = request(
        Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 10))),
        Some(TransportSecurity::Tls),
        Some(&authorization),
        None,
    );

    let response = protected_app_with(authenticator)
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn device_token_is_allowed_on_relay() {
    let authenticator = Arc::new(Authenticator::new("owner-secret".to_string()));
    let device_token = authenticator
        .issue_device_token("device-1", "Alice Phone")
        .unwrap();
    let authorization = format!("Bearer {}", device_token);
    let mut request = request(
        Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        Some(TransportSecurity::Tls),
        Some(&authorization),
        None,
    );
    request.extensions_mut().insert(ConnectionOrigin::Relay);

    let response = protected_app_with(authenticator)
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}
