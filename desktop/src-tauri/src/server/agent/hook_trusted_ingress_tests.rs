//! Trusted-ingress boundary tests for the local-only agent hook endpoint.

use super::*;
use crate::server::agent::hook::hook_tests::{
    call_hook, hook_headers, session_start_body, TempDir,
};
use crate::server::auth::TrustedIngress;
use crate::server::create_dummy_state;
use axum::body::Body;
use axum::body::Bytes as AxumBytes;
use axum::http::Request;
use futures_util::stream;
use std::sync::atomic::{AtomicBool, Ordering};
use tower::ServiceExt;

fn never_ready_body(polled: Arc<AtomicBool>) -> Body {
    Body::from_stream(stream::poll_fn(move |_| {
        polled.store(true, Ordering::SeqCst);
        std::task::Poll::<Option<Result<AxumBytes, std::io::Error>>>::Pending
    }))
}

/// A direct LAN peer must be rejected before a valid hook payload is processed.
#[tokio::test]
async fn non_loopback_peer_rejected_403_without_processing() {
    let state = Arc::new(create_dummy_state());
    let session = state.session_manager.create();
    let sid = session.id.clone();
    let secret = format!("test-secret-{sid}");
    state.hook_secrets.register(sid.clone(), secret.clone());
    let tmp = TempDir::new();
    let transcript = tmp.file("claude-a.jsonl");
    std::fs::write(&transcript, "").unwrap();

    let status = call_hook(
        &state,
        std::net::SocketAddr::from(([192, 168, 1, 50], 45678)),
        hook_headers(&sid, &secret, "SessionStart"),
        session_start_body("claude-sid-a", &transcript),
    )
    .await;

    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(state.agents.get(&sid).is_none());
    assert!(state.mirrors.inner.lock().unwrap().is_empty());
}

/// Relay streams use a synthetic loopback socket address, but that must never
/// grant access to a local-shell-only endpoint.
#[tokio::test]
async fn relay_with_loopback_placeholder_is_rejected_by_trusted_ingress() {
    let state = Arc::new(create_dummy_state());
    let response = agent_hook(
        Extension(state),
        Extension(TrustedIngress::Relay),
        HeaderMap::new(),
        Bytes::new(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn oversized_hook_body_is_rejected_before_handler_parsing() {
    let state = Arc::new(create_dummy_state());
    state
        .hook_secrets
        .register("hook-session".into(), "hook-secret".into());
    let app = crate::server::build_router(state);
    let mut request = Request::post("/api/agent-hook")
        .body(Body::from(vec![b'x'; AGENT_HOOK_BODY_LIMIT + 1]))
        .unwrap();
    request
        .extensions_mut()
        .insert(TrustedIngress::DirectLoopback);
    *request.headers_mut() = hook_headers("hook-session", "hook-secret", "Notification");

    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn relay_ingress_is_rejected_without_polling_request_body() {
    let state = Arc::new(create_dummy_state());
    state
        .hook_secrets
        .register("hook-session".into(), "hook-secret".into());
    let app = crate::server::build_router(state);
    let polled = Arc::new(AtomicBool::new(false));
    let mut request = Request::post("/api/agent-hook")
        .body(never_ready_body(polled.clone()))
        .unwrap();
    request.extensions_mut().insert(TrustedIngress::Relay);
    *request.headers_mut() = hook_headers("hook-session", "hook-secret", "Notification");

    let response = tokio::time::timeout(std::time::Duration::from_secs(1), app.oneshot(request))
        .await
        .expect("trusted-ingress guard must reject before reading the body")
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(!polled.load(Ordering::SeqCst));
}

#[tokio::test]
async fn invalid_hook_secret_is_rejected_without_polling_request_body() {
    let state = Arc::new(create_dummy_state());
    state
        .hook_secrets
        .register("hook-session".into(), "hook-secret".into());
    let app = crate::server::build_router(state);
    let polled = Arc::new(AtomicBool::new(false));
    let mut request = Request::post("/api/agent-hook")
        .body(never_ready_body(polled.clone()))
        .unwrap();
    request
        .extensions_mut()
        .insert(TrustedIngress::DirectLoopback);
    *request.headers_mut() = hook_headers("hook-session", "wrong-secret", "Notification");

    let response = tokio::time::timeout(std::time::Duration::from_secs(1), app.oneshot(request))
        .await
        .expect("secret guard must reject before reading the body")
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(!polled.load(Ordering::SeqCst));
}
