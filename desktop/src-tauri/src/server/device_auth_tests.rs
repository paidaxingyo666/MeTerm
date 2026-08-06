use super::{
    default_scopes, legacy_default_scopes, sanitize_loaded_scopes, validate_assignable_scopes,
    DeviceCredentialStore, DeviceScope, DEVELOPMENT_DEFAULT_SCOPES,
    DEVELOPMENT_LEGACY_DEFAULT_SCOPES, DISTRIBUTABLE_DEFAULT_SCOPES, MAX_DEVICE_CREDENTIALS,
};

#[test]
fn persistent_store_contains_hash_not_plaintext_and_reloads() {
    let directory =
        std::env::temp_dir().join(format!("meterm-device-auth-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("device-credentials.json");
    let store = DeviceCredentialStore::persistent(path.clone());

    let token = store.issue("device-1", "Alice Phone").unwrap();
    // A second persist exercises atomic replacement of an existing file
    // (not just first-file creation), including the Windows code path.
    let second_token = store.issue("device-2", "Bob Tablet").unwrap();
    let contents = std::fs::read_to_string(&path).unwrap();
    assert!(!contents.contains(&token));
    assert!(!contents.contains(&second_token));
    assert!(contents.contains("token_sha256"));
    assert!(contents.contains("device-1"));
    assert!(contents.contains("\"version\": 4"));
    assert!(contents.contains("pairing_epoch"));
    assert!(!contents.contains("ssh.secrets-export"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    let reloaded = DeviceCredentialStore::persistent(path);
    let authenticated = reloaded.authenticate(&token).unwrap();
    assert_eq!(authenticated.identity.device_id, "device-1");
    assert_eq!(authenticated.identity.device_name, "Alice Phone");
    assert_eq!(
        reloaded
            .authenticate(&second_token)
            .unwrap()
            .identity
            .device_id,
        "device-2"
    );

    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn issuing_again_rotates_one_device_token() {
    let store = DeviceCredentialStore::memory();
    let first = store.issue("device-1", "Phone").unwrap();
    let first_auth = store.authenticate(&first).unwrap();
    let first_epoch = store
        .pairing_epoch("device-1", first_auth.generation)
        .unwrap();
    let second = store.issue("device-1", "Renamed Phone").unwrap();

    assert!(store.authenticate(&first).is_none());
    let second_auth = store.authenticate(&second).unwrap();
    assert_eq!(second_auth.identity.device_name, "Renamed Phone");
    assert_ne!(
        first_epoch,
        store
            .pairing_epoch("device-1", second_auth.generation)
            .unwrap()
    );
}

#[test]
fn pairing_defaults_match_the_active_security_profile() {
    let store = DeviceCredentialStore::memory();
    let token = store.issue("device-1", "Phone").unwrap();
    let authenticated = store.authenticate(&token).unwrap();

    for scope in default_scopes() {
        assert!(store.has_scope(
            &authenticated.identity.device_id,
            authenticated.generation,
            scope,
        ));
    }
    assert_eq!(
        store.has_scope(
            &authenticated.identity.device_id,
            authenticated.generation,
            DeviceScope::DesktopControl,
        ),
        super::development_mobile_control_enabled()
    );
    assert!(!store.has_scope(
        &authenticated.identity.device_id,
        authenticated.generation,
        DeviceScope::SshSecretsExport,
    ));
}

#[test]
fn distributable_build_denies_all_scopes_and_secret_export_is_never_assignable() {
    assert!(validate_assignable_scopes(&[], false).is_ok());
    assert!(validate_assignable_scopes(&[DeviceScope::SshDesktopConnect], false).is_err());
    assert!(validate_assignable_scopes(&[DeviceScope::SshConnectionsWrite], false).is_err());
    assert!(validate_assignable_scopes(&[DeviceScope::PushSelf], false).is_err());
    assert!(validate_assignable_scopes(&[DeviceScope::DesktopControl], false).is_err());
    assert!(validate_assignable_scopes(&[DeviceScope::SshSecretsExport], false).is_err());
    assert!(validate_assignable_scopes(&[DeviceScope::SshSecretsExport], true).is_err());
}

#[test]
fn distributable_pairing_does_not_grant_connection_mutation() {
    assert!(DISTRIBUTABLE_DEFAULT_SCOPES.is_empty());
    assert!(!DISTRIBUTABLE_DEFAULT_SCOPES.contains(&DeviceScope::SshConnectionsWrite));
    assert!(DEVELOPMENT_DEFAULT_SCOPES.contains(&DeviceScope::DesktopControl));
    assert!(DEVELOPMENT_DEFAULT_SCOPES.contains(&DeviceScope::SshConnectionsWrite));
    assert!(!DEVELOPMENT_LEGACY_DEFAULT_SCOPES.contains(&DeviceScope::DesktopControl));
}

#[cfg(feature = "development-mobile-control")]
#[test]
fn persisted_v3_scopes_are_sanitized_without_adding_new_defaults() {
    let old = vec![DeviceScope::SshDesktopConnect, DeviceScope::PushSelf];
    assert_eq!(sanitize_loaded_scopes(old.clone()), old);
    assert!(!sanitize_loaded_scopes(old).contains(&DeviceScope::DesktopControl));
}

#[test]
fn release_load_sanitizer_uses_the_current_build_policy() {
    let scopes = sanitize_loaded_scopes(vec![
        DeviceScope::DesktopControl,
        DeviceScope::SshDesktopConnect,
        DeviceScope::SshSecretsExport,
    ]);
    if super::development_mobile_control_enabled() {
        assert!(scopes.contains(&DeviceScope::SshDesktopConnect));
        assert!(scopes.contains(&DeviceScope::DesktopControl));
    } else {
        assert!(!scopes.contains(&DeviceScope::SshDesktopConnect));
        assert!(!scopes.contains(&DeviceScope::DesktopControl));
    }
    // Raw secret export is never a remotely assignable scope. The enum is
    // retained only so old persisted files can be parsed and scrubbed;
    // identity-confirmed export is a local native operation.
    assert!(!scopes.contains(&DeviceScope::SshSecretsExport));
}

#[test]
fn scope_update_preserves_token_and_invalidates_old_generation() {
    let store = DeviceCredentialStore::memory();
    let token = store.issue("device-1", "Phone").unwrap();
    let old = store.authenticate(&token).unwrap();
    let pairing_epoch = store.pairing_epoch("device-1", old.generation).unwrap();

    let next_scopes = default_scopes();
    let updated = store
        .update_scopes("device-1", next_scopes.clone())
        .unwrap()
        .unwrap();
    assert_eq!(updated.retired_generation, old.generation);
    assert!(!store.is_current("device-1", old.generation));

    let current = store.authenticate(&token).unwrap();
    assert_eq!(current.generation, updated.generation);
    assert_eq!(
        store.scopes("device-1", current.generation).unwrap(),
        next_scopes
    );
    assert_eq!(
        store.pairing_epoch("device-1", current.generation).unwrap(),
        pairing_epoch
    );
}

#[test]
fn legacy_v1_file_migrates_to_safe_defaults() {
    let directory = std::env::temp_dir().join(format!(
        "meterm-device-auth-v1-test-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("device-credentials.json");
    let store = DeviceCredentialStore::persistent(path.clone());
    let token = store.issue("device-1", "Phone").unwrap();
    drop(store);

    let mut persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    persisted["version"] = 1.into();
    persisted["devices"][0]
        .as_object_mut()
        .unwrap()
        .remove("scopes");
    std::fs::write(&path, serde_json::to_vec_pretty(&persisted).unwrap()).unwrap();

    let reloaded = DeviceCredentialStore::persistent(path.clone());
    let authenticated = reloaded.authenticate(&token).unwrap();
    assert_eq!(
        reloaded
            .scopes("device-1", authenticated.generation)
            .unwrap(),
        legacy_default_scopes()
    );
    assert!(!reloaded.has_scope(
        "device-1",
        authenticated.generation,
        DeviceScope::DesktopControl,
    ));
    assert!(!reloaded.has_scope(
        "device-1",
        authenticated.generation,
        DeviceScope::SshSecretsExport,
    ));

    let migrated: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(migrated["version"], 4);
    assert!(migrated["devices"][0]["scopes"].is_array());
    assert!(migrated["devices"][0]["pairing_epoch"].is_string());

    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn pairing_epoch_survives_persistent_reload() {
    let directory = std::env::temp_dir().join(format!(
        "meterm-device-auth-v4-epoch-test-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("device-credentials.json");
    let store = DeviceCredentialStore::persistent(path.clone());
    let token = store.issue("device-1", "Phone").unwrap();
    let first = store.authenticate(&token).unwrap();
    let epoch = store.pairing_epoch("device-1", first.generation).unwrap();
    drop(store);

    let reloaded = DeviceCredentialStore::persistent(path);
    let current = reloaded.authenticate(&token).unwrap();
    assert_ne!(first.generation, current.generation);
    assert_eq!(
        reloaded
            .pairing_epoch("device-1", current.generation)
            .unwrap(),
        epoch
    );

    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn v3_migration_preserves_supported_explicit_scopes_and_adds_pairing_epoch() {
    let directory = std::env::temp_dir().join(format!(
        "meterm-device-auth-v3-test-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("device-credentials.json");
    let store = DeviceCredentialStore::persistent(path.clone());
    let token = store.issue("device-1", "Phone").unwrap();
    let explicit_scopes = if super::development_mobile_control_enabled() {
        vec![DeviceScope::PushSelf]
    } else {
        Vec::new()
    };
    store
        .update_scopes("device-1", explicit_scopes.clone())
        .unwrap();
    drop(store);

    let mut persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    persisted["version"] = 3.into();
    persisted["devices"][0]
        .as_object_mut()
        .unwrap()
        .remove("pairing_epoch");
    std::fs::write(&path, serde_json::to_vec_pretty(&persisted).unwrap()).unwrap();

    let reloaded = DeviceCredentialStore::persistent(path.clone());
    let current = reloaded.authenticate(&token).unwrap();
    assert_eq!(
        reloaded.scopes("device-1", current.generation).unwrap(),
        explicit_scopes
    );
    assert!(reloaded
        .pairing_epoch("device-1", current.generation)
        .is_some());
    let migrated: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(migrated["version"], 4);
    assert!(migrated["devices"][0]["pairing_epoch"].is_string());

    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn runtime_generation_invalidates_stale_upgrade_decisions() {
    let store = DeviceCredentialStore::memory();
    let first = store.issue("device-1", "Phone").unwrap();
    let old = store.authenticate(&first).unwrap();
    assert!(store.is_current(&old.identity.device_id, old.generation));

    let second = store.issue("device-1", "Phone").unwrap();
    let current = store.authenticate(&second).unwrap();
    assert_ne!(old.generation, current.generation);
    assert!(!store.is_current(&old.identity.device_id, old.generation));
    assert!(store.is_current(&current.identity.device_id, current.generation));

    let retired = store.revoke_device("device-1").unwrap().unwrap();
    assert_eq!(retired.device_id, "device-1");
    assert_eq!(retired.generation, current.generation);
    assert!(!store.is_current(&current.identity.device_id, current.generation));
}

#[test]
fn stale_generation_cannot_self_revoke_rotated_credential() {
    let store = DeviceCredentialStore::memory();
    let first = store.issue("device-1", "Phone").unwrap();
    let stale = store.authenticate(&first).unwrap();
    let second = store.issue("device-1", "Phone").unwrap();
    let current = store.authenticate(&second).unwrap();

    assert!(!store
        .revoke_generation(&stale.identity.device_id, stale.generation)
        .unwrap());
    assert!(store.is_current(&current.identity.device_id, current.generation));
    assert!(store
        .revoke_generation(&current.identity.device_id, current.generation)
        .unwrap());
    assert!(!store.is_current(&current.identity.device_id, current.generation));
}

#[test]
fn credential_count_is_bounded() {
    let store = DeviceCredentialStore::memory();
    for index in 0..MAX_DEVICE_CREDENTIALS {
        store.issue(&format!("device-{}", index), "Phone").unwrap();
    }
    assert!(store.issue("one-too-many", "Phone").is_err());
}

#[test]
fn revoke_all_invalidates_every_device() {
    let store = DeviceCredentialStore::memory();
    let first = store.issue("device-1", "Phone").unwrap();
    let second = store.issue("device-2", "Tablet").unwrap();
    let retired = store.revoke_all().unwrap();

    assert!(store.authenticate(&first).is_none());
    assert!(store.authenticate(&second).is_none());
    assert_eq!(retired.len(), 2);
    assert!(retired.iter().any(|entry| entry.device_id == "device-1"));
    assert!(retired.iter().any(|entry| entry.device_id == "device-2"));
}

#[test]
fn relay_binding_is_revocation_and_scope_aware() {
    let store = DeviceCredentialStore::memory();
    let generation = uuid::Uuid::new_v4();
    store
        .credentials
        .write()
        .unwrap()
        .push(super::DeviceCredential {
            identity: super::DeviceIdentity {
                device_id: "device-relay".to_string(),
                device_name: "Relay Phone".to_string(),
            },
            created_at: 1,
            token_hash: super::hash_token("mtd_test"),
            generation,
            pairing_epoch: "AAAAAAAAAAAAAAAAAAAAAA".to_string(),
            scopes: vec![DeviceScope::PushSelf],
            proof_public_key: Some(vec![4; 65]),
        });

    assert!(store
        .with_current_relay_binding("device-relay", generation, |epoch, scopes, key| {
            assert_eq!(epoch, "AAAAAAAAAAAAAAAAAAAAAA");
            assert_eq!(scopes, &[DeviceScope::PushSelf]);
            assert_eq!(key, &[4; 65]);
        },)
        .is_some());

    assert!(store.revoke_generation("device-relay", generation).unwrap());
    assert!(store
        .with_current_relay_binding("device-relay", generation, |_, _, _| ())
        .is_none());

    let empty_generation = uuid::Uuid::new_v4();
    store
        .credentials
        .write()
        .unwrap()
        .push(super::DeviceCredential {
            identity: super::DeviceIdentity {
                device_id: "device-empty".to_string(),
                device_name: "Empty Scope Phone".to_string(),
            },
            created_at: 1,
            token_hash: super::hash_token("mtd_empty"),
            generation: empty_generation,
            pairing_epoch: "AAAAAAAAAAAAAAAAAAAAAA".to_string(),
            scopes: Vec::new(),
            proof_public_key: Some(vec![4; 65]),
        });
    assert!(store
        .with_current_relay_binding("device-empty", empty_generation, |_, _, _| ())
        .is_none());
}
