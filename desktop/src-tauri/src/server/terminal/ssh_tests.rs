use super::ssh::{trusted_fingerprint_matches, SshAuthMethod, SshConfig};

#[test]
fn trusted_host_key_requires_an_exact_fingerprint_match() {
    let confirmed = "SHA256:confirmed";

    assert!(trusted_fingerprint_matches(Some(confirmed), confirmed));
    assert!(!trusted_fingerprint_matches(
        Some(confirmed),
        "SHA256:attacker"
    ));
    assert!(!trusted_fingerprint_matches(Some(""), confirmed));
    assert!(!trusted_fingerprint_matches(None, confirmed));
}

#[test]
fn ssh_config_debug_never_prints_credentials() {
    let config = SshConfig {
        host: "server.example".into(),
        port: 22,
        username: "user".into(),
        auth_method: SshAuthMethod::Key,
        password: "password-must-not-print".into(),
        private_key: "private-key-must-not-print".into(),
        passphrase: "passphrase-must-not-print".into(),
        trusted_fingerprint: "SHA256:test".into(),
        disable_hook: false,
        multiplex_sftp: false,
        proxy_type: "socks5".into(),
        proxy_host: "proxy.example".into(),
        proxy_port: 1080,
        proxy_username: "proxy-user".into(),
        proxy_password: "proxy-password-must-not-print".into(),
    };
    assert_eq!(format!("{config:?}"), "SshConfig(redacted)");
}
