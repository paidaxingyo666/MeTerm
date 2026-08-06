use super::{AuthPrincipal, Authenticator, OwnerMutationError};

fn owner_generation(authenticator: &Authenticator, token: &str) -> uuid::Uuid {
    match authenticator.authenticate_token(token).unwrap() {
        AuthPrincipal::Owner { generation } => generation,
        AuthPrincipal::Device { .. } => panic!("owner token authenticated as device"),
    }
}

#[test]
fn delayed_old_owner_cannot_reclaim_token_after_rotation() {
    let old_token = "A".repeat(32);
    let current_token = "B".repeat(32);
    let attacker_token = "C".repeat(32);
    let authenticator = Authenticator::new(old_token.clone());
    let old_generation = owner_generation(&authenticator, &old_token);

    authenticator.set_token(current_token.clone()).unwrap();
    assert_eq!(
        authenticator.set_token_if_generation(old_generation, attacker_token.clone()),
        Err(OwnerMutationError::Stale)
    );
    assert_eq!(authenticator.get_token(), current_token);
    assert!(authenticator.authenticate_token(&attacker_token).is_none());
}

#[test]
fn delayed_old_revoke_all_cannot_remove_new_devices_or_reclaim_owner() {
    let old_token = "A".repeat(32);
    let current_token = "B".repeat(32);
    let attacker_token = "C".repeat(32);
    let authenticator = Authenticator::new(old_token.clone());
    let old_generation = owner_generation(&authenticator, &old_token);

    authenticator.set_token(current_token.clone()).unwrap();
    let device_token = authenticator
        .issue_device_token("device-new", "New Phone")
        .unwrap();
    assert!(matches!(
        authenticator
            .revoke_all_and_set_token_if_generation(old_generation, attacker_token.clone()),
        Err(OwnerMutationError::Stale)
    ));

    assert_eq!(authenticator.get_token(), current_token);
    assert!(authenticator.authenticate_token(&device_token).is_some());
    assert!(authenticator.authenticate_token(&attacker_token).is_none());
}

#[test]
fn current_owner_revoke_all_rotates_owner_and_removes_devices() {
    let old_token = "A".repeat(32);
    let new_token = "B".repeat(32);
    let authenticator = Authenticator::new(old_token.clone());
    let generation = owner_generation(&authenticator, &old_token);
    let device_token = authenticator
        .issue_device_token("device-old", "Old Phone")
        .unwrap();

    let outcome = authenticator
        .revoke_all_and_set_token_if_generation(generation, new_token.clone())
        .unwrap();

    assert!(outcome.devices_revoked);
    assert_eq!(outcome.retired_devices.len(), 1);
    assert_eq!(outcome.retired_devices[0].device_id, "device-old");
    assert!(authenticator.authenticate_token(&old_token).is_none());
    assert!(authenticator.authenticate_token(&device_token).is_none());
    assert!(authenticator.authenticate_token(&new_token).is_some());
}

#[test]
fn device_store_failure_still_retires_old_and_persists_replacement_owner() {
    let directory = std::env::temp_dir().join(format!(
        "meterm-revoke-all-failure-test-{}",
        uuid::Uuid::new_v4()
    ));
    let owner_path = directory.join("owner-token");
    let device_path = directory.join("owner-token.devices.json");
    let old_token = "A".repeat(32);
    let new_token = "B".repeat(32);
    let authenticator =
        Authenticator::new_persistent(old_token.clone(), owner_path.to_string_lossy().to_string());
    let generation = owner_generation(&authenticator, &old_token);
    let device_token = authenticator
        .issue_device_token("device-old", "Old Phone")
        .unwrap();

    std::fs::remove_file(&device_path).unwrap();
    std::fs::create_dir(&device_path).unwrap();
    let outcome = authenticator
        .revoke_all_and_set_token_if_generation(generation, new_token.clone())
        .unwrap();

    assert!(!outcome.devices_revoked);
    assert!(outcome.retired_devices.is_empty());
    assert!(outcome.device_error.is_some());
    assert!(authenticator.authenticate_token(&old_token).is_none());
    assert!(authenticator.authenticate_token(&new_token).is_some());
    assert!(authenticator.authenticate_token(&device_token).is_some());
    assert_eq!(std::fs::read_to_string(&owner_path).unwrap(), new_token);

    std::fs::remove_dir(&device_path).unwrap();
    let retry_token = "C".repeat(32);
    let retry_generation = owner_generation(&authenticator, &new_token);
    let retry = authenticator
        .revoke_all_and_set_token_if_generation(retry_generation, retry_token.clone())
        .unwrap();
    assert!(retry.devices_revoked);
    assert_eq!(retry.retired_devices.len(), 1);
    assert_eq!(retry.retired_devices[0].device_id, "device-old");
    assert!(retry.device_error.is_none());
    assert!(authenticator.authenticate_token(&device_token).is_none());
    assert!(authenticator.authenticate_token(&new_token).is_none());
    assert!(authenticator.authenticate_token(&retry_token).is_some());

    let _ = std::fs::remove_dir_all(directory);
}
