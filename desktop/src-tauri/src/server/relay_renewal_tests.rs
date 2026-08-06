use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{header, Method, Request, StatusCode};
use tower::ServiceExt;

use super::auth::{ConnectionOrigin, TransportSecurity, TrustedIngress};
use super::relay_renewal_preface::RelayRenewalContext;
use super::{build_relay_renewal_router, create_dummy_state, Authenticator};

fn renewal_request(method: Method, uri: &str, bearer: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(token) = bearer {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    let mut request = builder.body(Body::empty()).unwrap();
    request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
        Ipv4Addr::LOCALHOST.into(),
        42424,
    )));
    request
        .extensions_mut()
        .insert(ConnectionOrigin::RelayRenewal);
    request
        .extensions_mut()
        .insert(TrustedIngress::RelayRenewal);
    request.extensions_mut().insert(TransportSecurity::Tls);
    request
        .extensions_mut()
        .insert(RelayRenewalContext::for_test(
            "desktop-placeholder",
            "phone-placeholder",
            "AAAAAAAAAAAAAAAAAAAAAA",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            [0u8; 32],
        ));
    request
}

#[tokio::test]
async fn renewal_router_exposes_only_challenge_and_renewal() {
    let app = build_relay_renewal_router(Arc::new(create_dummy_state()));

    for (method, uri) in [
        (Method::GET, "/api/info"),
        (Method::GET, "/api/ping"),
        (Method::POST, "/api/pair"),
        (Method::GET, "/api/sessions"),
        (Method::GET, "/api/device-credentials"),
        (Method::GET, "/ws-events"),
        (Method::GET, "/ws/not-a-session"),
    ] {
        let response = app
            .clone()
            .oneshot(renewal_request(method, uri, None))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
    }

    let challenge = app
        .clone()
        .oneshot(renewal_request(Method::POST, "/api/auth/challenge", None))
        .await
        .unwrap();
    assert_eq!(challenge.status(), StatusCode::UNAUTHORIZED);
    let renewal = app
        .oneshot(renewal_request(
            Method::POST,
            "/api/relay/capability/renew",
            None,
        ))
        .await
        .unwrap();
    assert_eq!(renewal.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn renewal_router_rejects_owner_and_nonrenewal_ingress() {
    let owner = "O".repeat(32);
    let mut state = create_dummy_state();
    state.authenticator = Arc::new(Authenticator::new(owner.clone()));
    let app = build_relay_renewal_router(Arc::new(state));

    let owner_response = app
        .clone()
        .oneshot(renewal_request(
            Method::POST,
            "/api/relay/capability/renew",
            Some(&owner),
        ))
        .await
        .unwrap();
    assert_eq!(owner_response.status(), StatusCode::FORBIDDEN);

    let mut wrong_ingress = renewal_request(Method::POST, "/api/auth/challenge", None);
    wrong_ingress
        .extensions_mut()
        .insert(ConnectionOrigin::Relay);
    wrong_ingress.extensions_mut().insert(TrustedIngress::Relay);
    let response = app.oneshot(wrong_ingress).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    let app = build_relay_renewal_router(Arc::new(create_dummy_state()));
    let mut missing_context = renewal_request(Method::POST, "/api/auth/challenge", None);
    missing_context
        .extensions_mut()
        .remove::<RelayRenewalContext>();
    let response = app.oneshot(missing_context).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn renewal_context_router_layer_reaches_ingress_guard_before_auth() {
    let mut request = renewal_request(Method::POST, "/api/auth/challenge", None);
    let context = request
        .extensions_mut()
        .remove::<RelayRenewalContext>()
        .unwrap();
    let app =
        build_relay_renewal_router(Arc::new(create_dummy_state())).layer(axum::Extension(context));

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn renewal_challenge_binds_outer_identity_before_allocating_nonce() {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    use p256::ecdsa::SigningKey;

    let key_a = SigningKey::from_bytes((&[29u8; 32]).into()).unwrap();
    let key_b = SigningKey::from_bytes((&[30u8; 32]).into()).unwrap();
    let authenticator = Arc::new(Authenticator::new("O".repeat(32)));
    let issued_a = authenticator
        .issue_device_credential_with_proof(
            "phone-a",
            "Phone A",
            &URL_SAFE_NO_PAD.encode(key_a.verifying_key().to_encoded_point(false).as_bytes()),
        )
        .unwrap();
    let issued_b = authenticator
        .issue_device_credential_with_proof(
            "phone-b",
            "Phone B",
            &URL_SAFE_NO_PAD.encode(key_b.verifying_key().to_encoded_point(false).as_bytes()),
        )
        .unwrap();

    let mut state = create_dummy_state();
    state.authenticator = authenticator.clone();
    state.device_id = "desktop-a".to_string();
    let state = Arc::new(state);
    let context = |desktop: &str, client: &str| {
        RelayRenewalContext::for_test(
            desktop,
            client,
            "AAAAAAAAAAAAAAAAAAAAAA",
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            [0u8; 32],
        )
    };
    let challenge_request = |token: &str| {
        let mut request = renewal_request(Method::POST, "/api/auth/challenge", Some(token));
        let _ = request.extensions_mut().remove::<RelayRenewalContext>();
        request
            .headers_mut()
            .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
        *request.body_mut() = Body::from(r#"{"audience":"desktop-http"}"#);
        request
    };

    let cross_client = build_relay_renewal_router(state.clone())
        .layer(axum::Extension(context("desktop-a", "phone-a")))
        .oneshot(challenge_request(&issued_b.token))
        .await
        .unwrap();
    assert_eq!(cross_client.status(), StatusCode::FORBIDDEN);
    assert_eq!(authenticator.pending_device_pop_challenge_count(), 0);

    let cross_desktop = build_relay_renewal_router(state.clone())
        .layer(axum::Extension(context("desktop-other", "phone-a")))
        .oneshot(challenge_request(&issued_a.token))
        .await
        .unwrap();
    assert_eq!(cross_desktop.status(), StatusCode::FORBIDDEN);
    assert_eq!(authenticator.pending_device_pop_challenge_count(), 0);

    let valid = build_relay_renewal_router(state)
        .layer(axum::Extension(context("desktop-a", "phone-a")))
        .oneshot(challenge_request(&issued_a.token))
        .await
        .unwrap();
    assert_eq!(valid.status(), StatusCode::OK);
    assert_eq!(authenticator.pending_device_pop_challenge_count(), 1);
}

#[cfg(feature = "development-mobile-control")]
#[tokio::test]
async fn renewal_endpoint_requires_pop_and_returns_only_recovery_fields() {
    use axum::body::to_bytes;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    use p256::ecdsa::signature::Signer as _;
    use p256::ecdsa::{Signature, SigningKey};
    use sha2::{Digest as _, Sha256};

    let signing = SigningKey::from_bytes((&[29u8; 32]).into()).unwrap();
    let public = signing.verifying_key().to_encoded_point(false);
    let authenticator = Arc::new(Authenticator::new("O".repeat(32)));
    let issued = authenticator
        .issue_device_credential_with_proof(
            "phone-renewal",
            "Renewal Phone",
            &URL_SAFE_NO_PAD.encode(public.as_bytes()),
        )
        .unwrap();
    let principal_request = renewal_request(
        Method::POST,
        "/api/relay/capability/renew",
        Some(&issued.token),
    );
    let principal = authenticator
        .authenticate_request(&principal_request)
        .unwrap();
    let (pairing_epoch, key_thumbprint) = authenticator
        .with_current_relay_binding(&principal, |epoch, _scopes, key| {
            (epoch.to_string(), super::pop::key_thumbprint(key))
        })
        .unwrap();
    let register_secret = "aa".repeat(32);
    let exact_grant = super::relay_renewal::mint(
        &register_secret,
        "desktop-renewal",
        "phone-renewal",
        &pairing_epoch,
        &key_thumbprint,
    )
    .unwrap();
    let context = RelayRenewalContext::for_test(
        "desktop-renewal",
        "phone-renewal",
        &pairing_epoch,
        &key_thumbprint,
        Sha256::digest(exact_grant.token.as_bytes()).into(),
    );

    let mut state = create_dummy_state();
    state.authenticator = authenticator;
    state.device_id = "desktop-renewal".to_string();
    state.relay_url = "wss://relay.example.com:8443".to_string();
    state.relay_cert_fp = "11".repeat(32);
    state.relay_register_token = register_secret;
    let app = build_relay_renewal_router(Arc::new(state));

    let mut challenge_request =
        renewal_request(Method::POST, "/api/auth/challenge", Some(&issued.token));
    challenge_request
        .headers_mut()
        .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    challenge_request.extensions_mut().insert(context.clone());
    *challenge_request.body_mut() = Body::from(r#"{"audience":"desktop-http"}"#);
    let challenge_response = app.clone().oneshot(challenge_request).await.unwrap();
    assert_eq!(challenge_response.status(), StatusCode::OK);
    let challenge: serde_json::Value = serde_json::from_slice(
        &to_bytes(challenge_response.into_body(), 8 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();
    let encoded_nonce = challenge["nonce"].as_str().unwrap();
    let nonce: [u8; 32] = URL_SAFE_NO_PAD
        .decode(encoded_nonce)
        .unwrap()
        .try_into()
        .unwrap();
    let canonical = super::pop::canonical_request(
        super::pop::Audience::Http,
        "POST",
        &issued.token,
        &nonce,
        "/api/relay/capability/renew",
    )
    .unwrap();
    let signature: Signature = signing.sign(&canonical);

    let mut renewal_request = renewal_request(
        Method::POST,
        "/api/relay/capability/renew",
        Some(&issued.token),
    );
    renewal_request
        .headers_mut()
        .insert(super::pop::NONCE_HEADER, encoded_nonce.parse().unwrap());
    renewal_request.headers_mut().insert(
        super::pop::SIGNATURE_HEADER,
        URL_SAFE_NO_PAD
            .encode(signature.to_bytes())
            .parse()
            .unwrap(),
    );
    renewal_request.extensions_mut().insert(context);
    let response = app.oneshot(renewal_request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "no-store"
    );
    let body: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 16 * 1024).await.unwrap()).unwrap();
    let mut keys: Vec<_> = body
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "device_id",
            "relay_access_expires_at",
            "relay_access_token",
            "relay_cert_fp",
            "relay_renewal_grant",
            "relay_url",
            "version",
        ]
    );
    assert_eq!(body["version"], 1);
    assert_eq!(body["device_id"], "desktop-renewal");
    assert!(body["relay_access_token"]
        .as_str()
        .unwrap()
        .starts_with("mrc2."));
    assert!(body["relay_renewal_grant"]
        .as_str()
        .unwrap()
        .starts_with("mrr1."));
}
