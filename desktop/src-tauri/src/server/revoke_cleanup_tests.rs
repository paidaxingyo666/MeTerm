use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderValue};

use super::auth::AuthPrincipal;
use super::create_dummy_state;

fn device_generation(state: &super::ServerState, token: &str) -> uuid::Uuid {
    let mut request = Request::new(Body::empty());
    request.headers_mut().insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    match state.authenticator.authenticate_request(&request).unwrap() {
        AuthPrincipal::Device { generation, .. } => generation,
        AuthPrincipal::Owner { .. } => panic!("device token authenticated as owner"),
    }
}

fn register_push(state: &super::ServerState, device_id: &str, generation: uuid::Uuid, fill: u8) {
    assert_eq!(
        state.push.register_if_current_generation(
            &state.authenticator,
            device_id,
            &format!("push-{fill}"),
            [fill; 32],
            "sandbox",
            generation,
        ),
        super::push_registry::PushRegistrationOutcome::Registered
    );
}

#[tokio::test]
async fn delayed_single_revoke_cleanup_spares_same_device_new_generation() {
    let state = create_dummy_state();
    let old_token = state
        .authenticator
        .issue_device_token("device-a", "Old Phone")
        .unwrap();
    let old_generation = device_generation(&state, &old_token);
    register_push(&state, "device-a", old_generation, 1);

    let retired = state
        .authenticator
        .revoke_device("device-a")
        .unwrap()
        .unwrap();
    assert_eq!(retired.generation, old_generation);

    let new_token = state
        .authenticator
        .issue_device_token("device-a", "New Phone")
        .unwrap();
    let new_generation = device_generation(&state, &new_token);
    assert_ne!(new_generation, retired.generation);
    register_push(&state, "device-a", new_generation, 2);

    let cleanup = state.disconnect_device_generation(&retired.device_id, retired.generation);
    assert_eq!(cleanup.push_removed, 0);
    assert_eq!(
        state.push.get("device-a").unwrap().credential_generation,
        Some(new_generation)
    );
    assert!(state
        .authenticator
        .is_device_generation_current("device-a", new_generation));
}

#[tokio::test]
async fn delayed_revoke_all_cleanup_spares_repaired_generation_only() {
    let state = create_dummy_state();
    for (device_id, fill) in [("device-a", 1), ("device-b", 2)] {
        let token = state
            .authenticator
            .issue_device_token(device_id, "Old Phone")
            .unwrap();
        register_push(&state, device_id, device_generation(&state, &token), fill);
    }

    let outcome = state.revoke_all_for_local_owner("N".repeat(32)).unwrap();
    assert!(outcome.devices_revoked);
    assert_eq!(outcome.retired_devices.len(), 2);

    let new_token = state
        .authenticator
        .issue_device_token("device-a", "New Phone")
        .unwrap();
    let new_generation = device_generation(&state, &new_token);
    register_push(&state, "device-a", new_generation, 3);

    let cleanup = state.disconnect_device_generations(&outcome.retired_devices);
    assert_eq!(cleanup.push_removed, 1);
    assert_eq!(
        state.push.get("device-a").unwrap().credential_generation,
        Some(new_generation)
    );
    assert!(state.push.get("device-b").is_none());
    assert!(state
        .authenticator
        .is_device_generation_current("device-a", new_generation));
}
