use super::*;
use axum::body::Body;
use axum::extract::Request;

/// M7 显式新建镜像:auto_claude=true → envs 追加 ("METERM_AUTO_CLAUDE","1")。
#[test]
fn apply_auto_claude_env_true_appends_flag() {
    let base = super::super::hook_secret::hook_envs("sess-1", 51234, "sec");
    let out = apply_auto_claude_env(base.clone(), true);
    assert_eq!(
        out.len(),
        base.len() + 1,
        "auto_claude=true 须多追加一个 env"
    );
    let map: HashMap<_, _> = out.into_iter().collect();
    assert_eq!(
        map.get("METERM_AUTO_CLAUDE").map(String::as_str),
        Some("1"),
        "auto_claude=true 须注入 METERM_AUTO_CLAUDE=1"
    );
    assert_eq!(
        map.get("METERM_SESSION_ID").map(String::as_str),
        Some("sess-1")
    );
}

/// auto_claude=false → 零行为变化,envs 不含 METERM_AUTO_CLAUDE。
#[test]
fn apply_auto_claude_env_false_is_noop() {
    let base = super::super::hook_secret::hook_envs("sess-1", 51234, "sec");
    let out = apply_auto_claude_env(base.clone(), false);
    assert_eq!(out.len(), base.len(), "auto_claude=false 须零追加");
    let map: HashMap<_, _> = out.into_iter().collect();
    assert!(
        !map.contains_key("METERM_AUTO_CLAUDE"),
        "auto_claude=false 不得含 METERM_AUTO_CLAUDE(零行为变化)"
    );
}

/// CreateSessionRequest 缺省 auto_claude=false(空 body 前后兼容),
/// 且 serde 忽略未知字段(旧桌面收手机新字段退化普通终端)。
#[test]
fn create_session_request_defaults_and_ignores_unknown() {
    let req: CreateSessionRequest = serde_json::from_str("{}").unwrap();
    assert!(!req.auto_claude, "缺省 auto_claude 须为 false");
    let req2: CreateSessionRequest =
        serde_json::from_str(r#"{"auto_claude": true, "future_field": 42}"#).unwrap();
    assert!(req2.auto_claude, "auto_claude=true 须解析");
}

#[test]
fn paired_device_direct_key_auth_never_uses_desktop_key_paths_or_agent() {
    let device = AuthPrincipal::Device {
        device_id: "phone".into(),
        device_name: "Phone".into(),
        generation: uuid::Uuid::new_v4(),
    };
    let owner = AuthPrincipal::Owner {
        generation: uuid::Uuid::new_v4(),
    };
    for private_key in ["", "~/.ssh/id_ed25519", "/Users/alice/.ssh/id_rsa"] {
        let config = parse_ssh_config(&serde_json::json!({
            "host": "server.example",
            "username": "alice",
            "auth_method": "key",
            "private_key": private_key,
        }))
        .unwrap();
        assert!(validate_direct_ssh_config(&device, &config).is_err());
        assert!(validate_direct_ssh_config(&owner, &config).is_ok());
    }

    let inline = parse_ssh_config(&serde_json::json!({
        "host": "server.example",
        "username": "alice",
        "auth_method": "key",
        "private_key": "-----BEGIN OPENSSH PRIVATE KEY-----\nplaceholder\n-----END OPENSSH PRIVATE KEY-----",
    }))
    .unwrap();
    assert!(validate_direct_ssh_config(&device, &inline).is_ok());
}

#[test]
fn ssh_transport_errors_are_reduced_to_stable_public_codes() {
    let cases = [
        (
            "SSH authentication timed out after 20s",
            StatusCode::GATEWAY_TIMEOUT,
            "ssh_connect_timeout",
        ),
        (
            "read private key /Users/alice/.ssh/id_ed25519: permission denied",
            StatusCode::UNPROCESSABLE_ENTITY,
            "credential_unavailable",
        ),
        (
            "invalid key: encrypted material could not be decoded",
            StatusCode::UNPROCESSABLE_ENTITY,
            "credential_unavailable",
        ),
        (
            "password auth: server rejected credentials",
            StatusCode::BAD_GATEWAY,
            "ssh_auth_failed",
        ),
        (
            "SOCKS5 proxy proxy.internal:1080: connection refused",
            StatusCode::BAD_GATEWAY,
            "ssh_connect_failed",
        ),
    ];

    for (raw, expected_status, expected_code) in cases {
        let (status, code) = classify_ssh_connect_error(raw);
        assert_eq!(status, expected_status);
        assert_eq!(code, expected_code);
        let response = serde_json::json!({ "error": code }).to_string();
        assert!(!response.contains("/Users/alice/.ssh"));
        assert!(!response.contains("proxy.internal"));
        assert!(!response.contains("encrypted material"));
    }
}

#[test]
fn host_key_challenge_uses_an_explicit_field_allow_list() {
    let raw = serde_json::json!({
        "error": "host_key_unknown",
        "hostname": "db.example:22",
        "fingerprint": "SHA256:abc",
        "key_type": "ssh-ed25519",
        "message": "must not be forwarded",
        "private_key_path": "/Users/alice/.ssh/id_ed25519",
        "proxy": "proxy.internal:1080",
    })
    .to_string();

    let challenge = sanitized_host_key_challenge(&raw).expect("valid host-key challenge");
    assert_eq!(challenge["error"], "host_key_unknown");
    assert_eq!(challenge["hostname"], "db.example:22");
    assert_eq!(challenge["fingerprint"], "SHA256:abc");
    assert_eq!(challenge["key_type"], "ssh-ed25519");
    let response = challenge.to_string();
    assert!(!response.contains("private_key_path"));
    assert!(!response.contains("/Users/alice/.ssh"));
    assert!(!response.contains("proxy.internal"));
    assert!(!response.contains("must not be forwarded"));

    assert!(sanitized_host_key_challenge(
        r#"{"error":"host_key_unknown","fingerprint":"SHA256:abc"}"#
    )
    .is_none());
    assert!(sanitized_host_key_challenge(
        r#"{"error":"unrelated","hostname":"h","fingerprint":"f","key_type":"k"}"#
    )
    .is_none());
}

#[tokio::test]
async fn failed_ssh_connect_never_registers_a_discoverable_session() {
    let state = Arc::new(super::super::create_dummy_state());
    let principal = AuthPrincipal::Owner {
        generation: state.authenticator.current_owner_generation(),
    };
    let before = state.session_manager.list().len();
    let config = super::super::terminal::ssh::SshConfig {
        host: "127.0.0.1".into(),
        port: 0,
        username: "nobody".into(),
        auth_method: super::super::terminal::ssh::SshAuthMethod::Password,
        password: "not-a-real-password".into(),
        private_key: String::new(),
        passphrase: String::new(),
        trusted_fingerprint: String::new(),
        disable_hook: true,
        multiplex_sftp: false,
        proxy_type: String::new(),
        proxy_host: String::new(),
        proxy_port: 0,
        proxy_username: String::new(),
        proxy_password: String::new(),
    };

    let (status, _) = connect_and_start_ssh_session(state.clone(), principal, config).await;

    assert_ne!(status, StatusCode::CREATED);
    assert_eq!(state.session_manager.list().len(), before);
}

#[test]
fn relay_metadata_is_hidden_from_scope_less_release_devices() {
    let device = AuthPrincipal::Device {
        device_id: "phone".into(),
        device_name: "Phone".into(),
        generation: uuid::Uuid::new_v4(),
    };
    let owner = AuthPrincipal::Owner {
        generation: uuid::Uuid::new_v4(),
    };
    assert!(!relay_metadata_allowed(&device, Some(&[])));
    assert!(relay_metadata_allowed(
        &device,
        Some(&[super::super::device_auth::DeviceScope::SshDesktopConnect])
    ));
    assert!(relay_metadata_allowed(&owner, None));
}

#[test]
fn push_registration_requires_matching_device_principal() {
    let generation = uuid::Uuid::new_v4();
    let device = AuthPrincipal::Device {
        device_id: "device-a".into(),
        device_name: "phone".into(),
        generation,
    };
    let owner = AuthPrincipal::Owner {
        generation: uuid::Uuid::new_v4(),
    };

    assert_eq!(push_device_generation(&device, "device-a"), Ok(generation));
    assert_eq!(
        push_device_generation(&device, "device-b"),
        Err("device identity mismatch")
    );
    assert_eq!(
        push_device_generation(&owner, "device-a"),
        Err("device credential required")
    );
}

fn device_principal(
    authenticator: &super::super::auth::Authenticator,
    token: &str,
) -> AuthPrincipal {
    let mut request = Request::new(Body::empty());
    request.headers_mut().insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    authenticator.authenticate_request(&request).unwrap()
}

#[test]
fn revoked_before_push_commit_never_inserts() {
    let authenticator = super::super::auth::Authenticator::new("O".repeat(32));
    let token = authenticator
        .issue_device_token("device-a", "phone")
        .unwrap();
    let principal = device_principal(&authenticator, &token);
    let AuthPrincipal::Device { generation, .. } = &principal else {
        panic!("issued device token must authenticate as Device");
    };
    let generation = *generation;
    authenticator
        .revoke_device_generation("device-a", generation)
        .unwrap();

    let push = super::super::push_registry::PushRegistry::new();
    assert_eq!(
        push.register_if_current_generation(
            &authenticator,
            "device-a",
            "token",
            [7; 32],
            "sandbox",
            generation,
        ),
        super::super::push_registry::PushRegistrationOutcome::CredentialRevoked
    );
    assert!(push.get("device-a").is_none());
}

#[test]
fn stale_push_commit_cannot_overwrite_new_generation() {
    let authenticator = super::super::auth::Authenticator::new("O".repeat(32));
    let old_token = authenticator
        .issue_device_token("device-a", "phone")
        .unwrap();
    let old_principal = device_principal(&authenticator, &old_token);
    let AuthPrincipal::Device {
        generation: old_generation,
        ..
    } = old_principal
    else {
        panic!("issued device token must authenticate as Device");
    };

    let new_token = authenticator
        .issue_device_token("device-a", "phone")
        .unwrap();
    let new_principal = device_principal(&authenticator, &new_token);
    let AuthPrincipal::Device {
        generation: new_generation,
        ..
    } = new_principal
    else {
        panic!("rotated device token must authenticate as Device");
    };

    let push = super::super::push_registry::PushRegistry::new();
    assert_eq!(
        push.register_if_current_generation(
            &authenticator,
            "device-a",
            "new-token",
            [9; 32],
            "production",
            new_generation,
        ),
        super::super::push_registry::PushRegistrationOutcome::Registered
    );
    assert_eq!(
        push.register_if_current_generation(
            &authenticator,
            "device-a",
            "old-token",
            [7; 32],
            "sandbox",
            old_generation,
        ),
        super::super::push_registry::PushRegistrationOutcome::CredentialRevoked
    );

    let registration = push.get("device-a").unwrap();
    assert_eq!(registration.apns_token, "new-token");
    assert_eq!(registration.notif_pub, [9; 32]);
    assert_eq!(registration.credential_generation, Some(new_generation));

    authenticator
        .issue_device_token("device-a", "phone")
        .unwrap();
    assert!(push.all_current(&authenticator).is_empty());
}
