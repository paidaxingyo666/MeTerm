use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::extract::ConnectInfo;
use axum::http::{header, Method, Request, StatusCode};
use serde_json::Value;
use tower::ServiceExt;

use super::{ConnectionOrigin, TransportSecurity, TrustedIngress};
use crate::server::{build_router, create_dummy_state, device_auth, Authenticator, ServerState};

#[derive(Clone, Debug)]
struct ProtectedRoute {
    scope: &'static str,
    method: Method,
    uri: &'static str,
}

const PROTECTED_ROUTES: &[ProtectedRoute] = &[
    // desktop.control
    ProtectedRoute {
        scope: "desktop.control",
        method: Method::POST,
        uri: "/api/sessions",
    },
    ProtectedRoute {
        scope: "desktop.control",
        method: Method::POST,
        uri: "/api/agent-sessions",
    },
    ProtectedRoute {
        scope: "desktop.control",
        method: Method::GET,
        uri: "/api/agent-options",
    },
    ProtectedRoute {
        scope: "desktop.control",
        method: Method::GET,
        uri: "/api/sessions/not-a-session/git/status",
    },
    ProtectedRoute {
        scope: "desktop.control",
        method: Method::GET,
        uri: "/api/sessions/not-a-session/git/diff",
    },
    ProtectedRoute {
        scope: "desktop.control",
        method: Method::GET,
        uri: "/api/sessions/not-a-session/git/log",
    },
    ProtectedRoute {
        scope: "desktop.control",
        method: Method::POST,
        uri: "/api/sessions/not-a-session/git/commit",
    },
    ProtectedRoute {
        scope: "desktop.control",
        method: Method::POST,
        uri: "/api/sessions/not-a-session/git/sync",
    },
    ProtectedRoute {
        scope: "desktop.control",
        method: Method::GET,
        uri: "/api/sessions/not-a-session/git/branches",
    },
    ProtectedRoute {
        scope: "desktop.control",
        method: Method::GET,
        uri: "/api/sessions/not-a-session/git/show",
    },
    ProtectedRoute {
        scope: "desktop.control",
        method: Method::POST,
        uri: "/api/sessions/not-a-session/git/checkout",
    },
    ProtectedRoute {
        scope: "desktop.control",
        method: Method::POST,
        uri: "/api/sessions/not-a-session/git/stage",
    },
    ProtectedRoute {
        scope: "desktop.control",
        method: Method::POST,
        uri: "/api/sessions/not-a-session/git/discard",
    },
    ProtectedRoute {
        scope: "desktop.control",
        method: Method::POST,
        uri: "/api/sessions/not-a-session/git/stash",
    },
    ProtectedRoute {
        scope: "desktop.control",
        method: Method::GET,
        uri: "/api/files/list",
    },
    ProtectedRoute {
        scope: "desktop.control",
        method: Method::GET,
        uri: "/api/files/download",
    },
    ProtectedRoute {
        scope: "desktop.control",
        method: Method::POST,
        uri: "/api/files/upload",
    },
    ProtectedRoute {
        scope: "desktop.control",
        method: Method::POST,
        uri: "/api/files/op",
    },
    // ssh.desktop-connect
    ProtectedRoute {
        scope: "ssh.desktop-connect",
        method: Method::POST,
        uri: "/api/sessions/ssh",
    },
    ProtectedRoute {
        scope: "ssh.desktop-connect",
        method: Method::POST,
        uri: "/api/sessions/ssh/saved",
    },
    ProtectedRoute {
        scope: "ssh.desktop-connect",
        method: Method::POST,
        uri: "/api/sessions/ssh/test",
    },
    ProtectedRoute {
        scope: "ssh.desktop-connect",
        method: Method::GET,
        uri: "/api/ssh/connections",
    },
    ProtectedRoute {
        scope: "ssh.desktop-connect",
        method: Method::POST,
        uri: "/api/jumpserver/auth",
    },
    ProtectedRoute {
        scope: "ssh.desktop-connect",
        method: Method::POST,
        uri: "/api/jumpserver/mfa",
    },
    ProtectedRoute {
        scope: "ssh.desktop-connect",
        method: Method::POST,
        uri: "/api/jumpserver/token-auth",
    },
    ProtectedRoute {
        scope: "ssh.desktop-connect",
        method: Method::GET,
        uri: "/api/jumpserver/assets",
    },
    ProtectedRoute {
        scope: "ssh.desktop-connect",
        method: Method::GET,
        uri: "/api/jumpserver/nodes",
    },
    ProtectedRoute {
        scope: "ssh.desktop-connect",
        method: Method::GET,
        uri: "/api/jumpserver/accounts",
    },
    ProtectedRoute {
        scope: "ssh.desktop-connect",
        method: Method::POST,
        uri: "/api/jumpserver/test",
    },
    // ssh.connections-write
    ProtectedRoute {
        scope: "ssh.connections-write",
        method: Method::POST,
        uri: "/api/ssh/connections",
    },
    ProtectedRoute {
        scope: "ssh.connections-write",
        method: Method::PUT,
        uri: "/api/ssh/connections/not-a-connection",
    },
    ProtectedRoute {
        scope: "ssh.connections-write",
        method: Method::DELETE,
        uri: "/api/ssh/connections/not-a-connection",
    },
    // push.self
    ProtectedRoute {
        scope: "push.self",
        method: Method::POST,
        uri: "/api/push/register",
    },
    ProtectedRoute {
        scope: "push.self",
        method: Method::GET,
        uri: "/ws-events",
    },
];

fn scope_less_device_state() -> (Arc<ServerState>, String) {
    assert!(device_auth::supported_scopes().is_empty());
    assert!(device_auth::default_scopes().is_empty());

    let mut state = create_dummy_state();
    state.port = 8022;
    state.relay_url = "wss://relay.must-not-leak.invalid".to_string();
    state.relay_cert_fp = "11".repeat(32);
    state.relay_register_token = "relay-register-token-must-not-leak".to_string();

    let token = state
        .authenticator
        .issue_device_token("release-route-device", "Release Route Test")
        .expect("issue scope-less device credential");
    let credentials = state.authenticator.list_device_credentials();
    assert_eq!(credentials.len(), 1);
    assert!(credentials[0].scopes.is_empty());

    (Arc::new(state), token)
}

fn relay_request(method: Method, uri: &str, token: &str) -> Request<Body> {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
        Ipv4Addr::LOCALHOST.into(),
        42424,
    )));
    request.extensions_mut().insert(ConnectionOrigin::Relay);
    request.extensions_mut().insert(TrustedIngress::Relay);
    request.extensions_mut().insert(TransportSecurity::Tls);
    request
}

fn direct_owner_request(method: Method, uri: &str, token: &str) -> Request<Body> {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(SocketAddr::new(
        Ipv4Addr::LOCALHOST.into(),
        42424,
    )));
    request.extensions_mut().insert(ConnectionOrigin::Direct);
    request
        .extensions_mut()
        .insert(TrustedIngress::DirectLoopback);
    request
        .extensions_mut()
        .insert(TransportSecurity::Plaintext);
    request
}

async fn json_body(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("read response body");
    serde_json::from_slice(&bytes).expect("response body is JSON")
}

#[tokio::test]
async fn raw_ssh_secret_route_does_not_exist_even_for_local_owner() {
    let owner = "O".repeat(32);
    let mut state = create_dummy_state();
    state.authenticator = Arc::new(Authenticator::new(owner.clone()));
    let response = build_router(Arc::new(state))
        .oneshot(direct_owner_request(
            Method::GET,
            "/api/ssh/connections/connection-id/secrets",
            &owner,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn scope_less_release_device_is_denied_by_every_sensitive_route_layer() {
    let (state, token) = scope_less_device_state();
    let app = build_router(state.clone());

    for route in PROTECTED_ROUTES {
        let response = app
            .clone()
            .oneshot(relay_request(route.method.clone(), route.uri, &token))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::FORBIDDEN,
            "{} {} must be denied for missing {} before its handler",
            route.method,
            route.uri,
            route.scope,
        );
    }

    assert!(
        state.session_manager.list().is_empty(),
        "POST /api/sessions must not have reached its handler"
    );
    assert!(state.connections.all().is_empty());
}

#[tokio::test]
async fn scope_less_release_device_keeps_only_base_self_service_routes() {
    let (state, token) = scope_less_device_state();
    let app = build_router(state.clone());

    let sessions = app
        .clone()
        .oneshot(relay_request(Method::GET, "/api/sessions", &token))
        .await
        .unwrap();
    assert_eq!(sessions.status(), StatusCode::OK);
    assert_eq!(json_body(sessions).await["sessions"], serde_json::json!([]));

    let info = app
        .clone()
        .oneshot(relay_request(Method::GET, "/api/info", &token))
        .await
        .unwrap();
    assert_eq!(info.status(), StatusCode::OK);
    let info = json_body(info).await;
    assert_eq!(info["device_scopes"], serde_json::json!([]));
    for hidden in [
        "relay_url",
        "relay_cert_fp",
        "relay_access_token",
        "relay_access_expires_at",
    ] {
        assert!(
            info.get(hidden).is_none(),
            "/api/info leaked {hidden}: {info}"
        );
    }

    let revoke = app
        .clone()
        .oneshot(relay_request(
            Method::DELETE,
            "/api/device-credential/self",
            &token,
        ))
        .await
        .unwrap();
    assert_eq!(revoke.status(), StatusCode::OK);
    let revoke = json_body(revoke).await;
    assert_eq!(revoke["ok"], true);
    assert_eq!(revoke["revoked"], true);

    let after_revoke = app
        .oneshot(relay_request(Method::GET, "/api/info", &token))
        .await
        .unwrap();
    assert_eq!(after_revoke.status(), StatusCode::UNAUTHORIZED);
}

#[test]
fn control_broker_contract_keeps_all_mobile_network_scopes_fail_closed() {
    let contract: Value = serde_json::from_str(include_str!(
        "../../../../docs/control-broker-contract-v1.json"
    ))
    .expect("control broker contract must be valid JSON");

    assert_eq!(contract["schema_version"], 1);
    assert_eq!(contract["contract_id"], "com.meterm.control-broker.v1");
    assert_eq!(contract["implementation_state"], "blocked");
    assert_eq!(
        contract["release_gate"]["blocked_scopes"],
        serde_json::json!([
            "desktop.control",
            "ssh.desktop-connect",
            "ssh.connections-write",
            "push.self"
        ])
    );
    assert_eq!(contract["release_gate"]["desktop_control_enabled"], false);
    assert_eq!(
        contract["release_gate"]["offline_mobile_ssh_requires_device_scope"],
        false
    );
    assert_eq!(contract["release_gate"]["appimage_enabled"], false);

    let required_platforms = contract["release_gate"]["required_platforms"]
        .as_array()
        .expect("required_platforms must be an array");
    for platform in ["macos", "windows", "linux"] {
        assert!(
            required_platforms.iter().any(|value| value == platform),
            "control broker contract is missing {platform}"
        );
        assert!(
            contract["platforms"].get(platform).is_some(),
            "control broker platform contract is missing {platform}"
        );
    }

    let operations = contract["fixed_operations"]
        .as_array()
        .expect("fixed_operations must be an array");
    let mut operation_ids = std::collections::HashSet::new();
    for operation in operations {
        let id = operation["id"]
            .as_str()
            .expect("every fixed operation needs an id");
        assert!(operation_ids.insert(id), "duplicate broker operation {id}");
        assert_eq!(
            operation["may_return_long_lived_secret"], false,
            "broker operation {id} must not return a long-lived secret"
        );
    }
    for required in [
        "status.get",
        "application.attach",
        "pairing.request.decide",
        "device.scopes.set",
        "control_identity.rotate",
        "authorized_channel.deliver",
    ] {
        assert!(
            operation_ids.contains(required),
            "control broker contract is missing fixed operation {required}"
        );
    }

    let forbidden = contract["forbidden_operations"]
        .as_array()
        .expect("forbidden_operations must be an array");
    for required in [
        "secret.read",
        "secret.export",
        "key.sign_arbitrary",
        "network.connect_arbitrary",
        "http.request_arbitrary",
        "process.spawn",
        "shell.execute",
    ] {
        assert!(
            forbidden.iter().any(|value| value == required),
            "control broker contract must forbid {required}"
        );
    }

    for secret in contract["broker_owned_secrets"]
        .as_array()
        .expect("broker_owned_secrets must be an array")
    {
        assert_eq!(secret["exportable"], false);
        assert_eq!(secret["app_visible"], false);
    }

    assert!(device_auth::supported_scopes().is_empty());
    assert!(device_auth::default_scopes().is_empty());
}
