use super::*;

fn connection() -> super::super::connections::SavedConnection {
    super::super::connections::SavedConnection {
        id: "connection-id".into(),
        name: "Production".into(),
        host: "ssh.example".into(),
        port: 22,
        username: "alice".into(),
        auth_method: "password".into(),
        has_key_path: false,
        uses_desktop_key_ladder: false,
        updated_at: 1,
        deleted_at: None,
        proxy_type: None,
        proxy_host: None,
        proxy_port: None,
        proxy_username: None,
        skip_shell_hook: None,
        multiplex_sftp: None,
    }
}

/// 只测 `SshSecrets` 的 JSON 编解码往返,不触碰真实钥匙串
/// (CI/沙箱环境里读写系统钥匙串可能弹权限对话框或不可用)。
#[test]
fn test_secrets_json_round_trip() {
    let secrets = SshSecrets {
        password: Some("hunter2".to_string()),
        private_key_pem: None,
        passphrase: Some("pp".to_string()),
        proxy_password: Some("proxpass".to_string()),
        private_key_path: Some("/home/me/.ssh/id_ed25519".to_string()),
        authority_binding: None,
    };
    let json = serde_json::to_string(&secrets).unwrap();
    let decoded: SshSecrets = serde_json::from_str(&json).unwrap();
    assert_eq!(decoded.password, secrets.password);
    assert_eq!(decoded.private_key_pem, secrets.private_key_pem);
    assert_eq!(decoded.passphrase, secrets.passphrase);
    assert_eq!(decoded.proxy_password, secrets.proxy_password);
    assert_eq!(decoded.private_key_path, secrets.private_key_path);
}

#[test]
fn test_empty_json_defaults_to_all_none() {
    let decoded: SshSecrets = serde_json::from_str("{}").unwrap();
    assert!(decoded.password.is_none());
    assert!(decoded.private_key_pem.is_none());
    assert!(decoded.passphrase.is_none());
    assert!(decoded.proxy_password.is_none());
}

#[test]
fn account_rejects_empty_oversized_and_control_character_ids() {
    assert!(account_for("").is_err());
    assert!(account_for(&"x".repeat(MAX_CONNECTION_ID_BYTES + 1)).is_err());
    assert!(account_for("bad\nid").is_err());
    assert_eq!(account_for("valid-id").unwrap(), "sync:valid-id");
}

#[test]
fn oversized_secret_json_is_rejected_before_keychain_access() {
    let oversized = format!("\"{}\"", "x".repeat(MAX_SECRET_JSON_BYTES));
    assert!(decode_secrets(&oversized).is_err());
}

#[test]
fn named_migration_rejects_target_account_alias_before_keychain_access() {
    let mut connection = connection();
    connection.id = "secrets".into();
    connection.name = "sync".into();
    let result = prepare_named_secret_migration(&connection, "sync", None, true);
    assert!(result.is_err());
}

#[test]
fn legacy_names_cannot_alias_any_id_keyed_account_namespace() {
    assert!(validate_legacy_name("sync").is_err());
    assert!(validate_legacy_name("sync:other-id").is_err());
    assert!(validate_legacy_name("sync-production").is_ok());
}

#[test]
fn named_migration_rejects_ids_that_alias_historical_name_accounts() {
    for suffix in [":secrets", ":password", ":passphrase"] {
        let mut connection = connection();
        connection.id = format!("historical{suffix}");
        assert!(prepare_named_secret_migration(&connection, "ordinary-name", None, true).is_err());
    }
}

#[test]
fn vault_namespace_matches_build_channel() {
    assert_eq!(DEVELOPMENT_SERVICE, "com.meterm.dev.ssh.v2");
    assert_eq!(PRODUCTION_SERVICE_V2, "com.meterm.app.ssh.v2");
    assert_eq!(PRODUCTION_SERVICE_V3, "com.meterm.app.ssh.v3");
    #[cfg(debug_assertions)]
    {
        assert_eq!(SERVICE, DEVELOPMENT_SERVICE);
        assert!(LEGACY_INSECURE_SERVICES.is_empty());
        #[cfg(all(feature = "development-credential-recovery", target_os = "macos"))]
        assert_eq!(PRODUCTION_IMPORT_SERVICES, &[PRODUCTION_SERVICE_V2]);
    }
    #[cfg(not(debug_assertions))]
    {
        assert_eq!(SERVICE, PRODUCTION_SERVICE_V3);
        assert_eq!(
            LEGACY_INSECURE_SERVICES,
            &[PRODUCTION_SERVICE_V2, "com.meterm.app.ssh"]
        );
    }
}

#[test]
fn existing_bundle_and_duplicate_checks_require_matching_authority_binding() {
    let connection = connection();
    let mut secrets = SshSecrets {
        password: Some("secret".into()),
        ..SshSecrets::default()
    };
    assert!(validate_bound_authority(&connection, &secrets).is_err());
    assert!(validate_existing_bound_bundle(&connection, &secrets).is_err());

    secrets.authority_binding = Some(authority_binding(&connection).unwrap());
    assert!(validate_bound_authority(&connection, &secrets).is_ok());
    assert!(validate_existing_bound_bundle(&connection, &secrets).is_ok());

    secrets.authority_binding = Some("v1:wrong".into());
    assert!(validate_existing_bound_bundle(&connection, &secrets).is_err());
}

#[test]
fn missing_current_bundle_fails_before_legacy_recovery() {
    let error = require_current_service_bundle(None).unwrap_err();
    assert!(error.contains("owner-confirmed recovery or re-entry"));
}

#[test]
fn named_target_binding_rejects_mismatch_and_classifies_unbound() {
    let connection = connection();
    let unbound = SshSecrets::default();
    assert_eq!(
        classify_named_target_binding(&connection, &unbound).unwrap(),
        NamedTargetBinding::Unbound
    );

    let matching = SshSecrets {
        authority_binding: Some(authority_binding(&connection).unwrap()),
        ..SshSecrets::default()
    };
    assert_eq!(
        classify_named_target_binding(&connection, &matching).unwrap(),
        NamedTargetBinding::Matching
    );

    let mismatched = SshSecrets {
        authority_binding: Some("v1:wrong".into()),
        ..SshSecrets::default()
    };
    assert!(classify_named_target_binding(&connection, &mismatched).is_err());
}

#[test]
fn authority_binding_changes_only_with_ssh_authority() {
    let mut connection = connection();
    connection.auth_method = "key".into();
    let original = authority_binding(&connection).unwrap();

    connection.name = "Renamed".into();
    connection.updated_at = 2;
    assert_eq!(authority_binding(&connection).unwrap(), original);

    connection.host = "other.example".into();
    assert_ne!(authority_binding(&connection).unwrap(), original);
    connection.host = "ssh.example".into();
    connection.uses_desktop_key_ladder = true;
    assert_ne!(authority_binding(&connection).unwrap(), original);
}

#[test]
fn secret_projection_keeps_only_material_for_selected_authority() {
    let mut connection = connection();
    connection.auth_method = "key".into();
    let source = SshSecrets {
        password: Some("must-not-copy".into()),
        private_key_pem: Some("-----BEGIN PRIVATE KEY-----\ntest".into()),
        passphrase: Some("key-passphrase".into()),
        proxy_password: Some("must-not-copy".into()),
        private_key_path: Some("/must/not/copy".into()),
        authority_binding: None,
    };

    let projected = project_secrets_for_authority(&connection, &source).unwrap();
    assert!(projected.password.is_none());
    assert!(projected.private_key_pem.is_some());
    assert_eq!(projected.passphrase.as_deref(), Some("key-passphrase"));
    assert!(projected.proxy_password.is_none());
    assert!(projected.private_key_path.is_none());
    assert!(projected.authority_binding.is_none());
}

#[test]
fn credential_shape_must_match_selected_source() {
    let password = connection();
    assert!(!credential_bundle_matches(
        &password,
        &SshSecrets::default()
    ));
    assert!(credential_bundle_matches(
        &password,
        &SshSecrets {
            password: Some("secret".into()),
            ..SshSecrets::default()
        }
    ));

    let mut ladder = connection();
    ladder.auth_method = "key".into();
    ladder.uses_desktop_key_ladder = true;
    assert!(credential_bundle_matches(&ladder, &SshSecrets::default()));
    assert!(!credential_bundle_matches(
        &ladder,
        &SshSecrets {
            private_key_pem: Some("unexpected".into()),
            ..SshSecrets::default()
        }
    ));
}

#[test]
fn desktop_key_ladder_requires_a_matching_persistent_authority_marker() {
    let mut ladder = connection();
    ladder.auth_method = "key".into();
    ladder.uses_desktop_key_ladder = true;

    let missing = SshSecrets::default();
    assert!(validate_bound_authority(&ladder, &missing).is_err());

    let bound = SshSecrets {
        authority_binding: Some(authority_binding(&ladder).unwrap()),
        ..SshSecrets::default()
    };
    assert!(validate_bound_authority(&ladder, &bound).is_ok());

    ladder.host = "redirected.example".into();
    assert!(validate_bound_authority(&ladder, &bound).is_err());
}

#[test]
fn current_service_destination_rejects_orphan_unbound_and_tombstoned_items() {
    let connection = connection();
    let unbound = SshSecrets {
        password: Some("squatted".into()),
        ..SshSecrets::default()
    };
    assert!(validate_store_destination(None, Some(&unbound)).is_err());
    assert!(validate_store_destination(Some(&connection), Some(&unbound)).is_err());
    assert_eq!(validate_store_destination(None, None).unwrap(), true);

    let bound = SshSecrets {
        authority_binding: Some(authority_binding(&connection).unwrap()),
        ..SshSecrets::default()
    };
    assert_eq!(
        validate_store_destination(Some(&connection), Some(&bound)).unwrap(),
        false
    );

    let mut tombstone = connection.clone();
    tombstone.deleted_at = Some(2);
    assert!(validate_store_destination(Some(&tombstone), Some(&bound)).is_err());
}
