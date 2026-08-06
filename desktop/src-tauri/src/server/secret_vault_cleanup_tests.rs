use super::*;

fn connection() -> super::super::connections::SavedConnection {
    super::super::connections::SavedConnection {
        id: "cleanup-id".into(),
        name: "Cleanup".into(),
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

fn bound_secrets(connection: &super::super::connections::SavedConnection) -> SshSecrets {
    SshSecrets {
        password: Some("secret".into()),
        proxy_password: Some("proxy-secret".into()),
        authority_binding: Some(authority_binding(connection).unwrap()),
        ..SshSecrets::default()
    }
}

#[test]
fn identical_bound_duplicate_is_safe_to_delete() {
    let connection = connection();
    let current = bound_secrets(&connection);
    let legacy = bound_secrets(&connection);
    assert!(validate_matching_legacy_duplicate(&connection, &current, &legacy).is_ok());
}

#[test]
fn unbound_or_conflicting_duplicate_is_never_silently_deleted() {
    let connection = connection();
    let current = bound_secrets(&connection);
    let mut legacy = bound_secrets(&connection);
    legacy.authority_binding = None;
    assert!(validate_matching_legacy_duplicate(&connection, &current, &legacy).is_err());

    legacy = bound_secrets(&connection);
    legacy.password = Some("different".into());
    assert!(validate_matching_legacy_duplicate(&connection, &current, &legacy).is_err());
}
