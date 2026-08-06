use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use tower::ServiceExt;

use super::auth::{Authenticator, ConnectionOrigin, TransportSecurity, TrustedIngress};
use super::lan_access::LanAccessPolicy;
use super::{build_router, create_dummy_state};

fn ping(ingress: TrustedIngress) -> Request<Body> {
    let mut request = Request::builder()
        .uri("/api/ping")
        .body(Body::empty())
        .unwrap();
    request.extensions_mut().insert(ingress);
    request
}

fn owner_discovery_request(owner_token: &str) -> Request<Body> {
    let mut request = Request::builder()
        .method(Method::POST)
        .uri("/api/discoverable")
        .header(header::AUTHORIZATION, format!("Bearer {owner_token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"enabled":true}"#))
        .unwrap();
    request
        .extensions_mut()
        .insert(TrustedIngress::DirectLoopback);
    request.extensions_mut().insert(ConnectionOrigin::Direct);
    request
        .extensions_mut()
        .insert(TransportSecurity::Plaintext);
    request
}

#[tokio::test]
async fn disabled_gate_blocks_direct_remote_but_keeps_loopback_and_relay() {
    let state = Arc::new(create_dummy_state());
    let app = build_router(state);

    assert_eq!(
        app.clone()
            .oneshot(ping(TrustedIngress::DirectRemote))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.clone()
            .oneshot(ping(TrustedIngress::DirectLoopback))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        app.oneshot(ping(TrustedIngress::Relay))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn direct_remote_route_follows_backend_access_state_without_discovery() {
    let state = Arc::new(create_dummy_state());
    state.set_lan_access(true).unwrap();
    let app = build_router(state.clone());

    assert_eq!(
        app.clone()
            .oneshot(ping(TrustedIngress::DirectRemote))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let status = state.lan_access_status();
    assert!(status.enabled);
    assert!(!status.discoverable);

    state.set_lan_access(false).unwrap();
    assert_eq!(
        app.oneshot(ping(TrustedIngress::DirectRemote))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn discovery_restore_failure_degrades_to_access_only() {
    let state = create_dummy_state();
    let status = state
        .restore_lan_access(LanAccessPolicy {
            enabled: true,
            discoverable: true,
        })
        .unwrap();

    assert!(status.enabled);
    assert!(!status.discoverable);
    assert!(state.pairing_manager.create_bootstrap_ticket().is_ok());
}

#[tokio::test]
async fn owner_discovery_route_cannot_bypass_backend_access_policy() {
    let owner_token = "O".repeat(32);
    let mut state = create_dummy_state();
    state.authenticator = Arc::new(Authenticator::new(owner_token.clone()));
    let app = build_router(Arc::new(state));

    assert_eq!(
        app.oneshot(owner_discovery_request(&owner_token))
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
}
