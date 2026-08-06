//! Narrow Tauri surface for JumpServer credential lifecycle.
//!
//! No command in this module returns credential bytes. Stored material can be
//! consumed only by fixed Rust JumpServer authentication/SSH operations.

use crate::server::jumpserver::credential_broker::{
    self, JumpServerCredentialBinding, JumpServerCredentialStatus, JumpServerCredentials,
};

#[tauri::command]
pub async fn jumpserver_migrate_credentials(
    window: tauri::WebviewWindow,
    binding: JumpServerCredentialBinding,
) -> Result<JumpServerCredentialStatus, String> {
    require_jumpserver_window(&window)?;
    match credential_broker::prepare_legacy_migration(binding)? {
        credential_broker::LegacyMigrationPreparation::NotRequired(status) => Ok(status),
        credential_broker::LegacyMigrationPreparation::RequiresConfirmation(snapshot) => {
            let reason = legacy_binding_reason(snapshot.binding());
            super::user_presence::confirm_for_credential_binding(&window, reason).await?;
            credential_broker::commit_legacy_migration(snapshot)
        }
    }
}

fn legacy_binding_reason(binding: &JumpServerCredentialBinding) -> String {
    let proxy = if binding.proxy_type.is_empty() {
        "direct".to_string()
    } else {
        format!(
            "{}://{}:{} (username: [{}])",
            super::user_presence::safe_prompt_field(&binding.proxy_type),
            super::user_presence::safe_prompt_field(&binding.proxy_host),
            binding.proxy_port,
            super::user_presence::safe_prompt_field(&binding.proxy_username)
        )
    };
    let org = if binding.org_id.is_empty() {
        "default"
    } else {
        &binding.org_id
    };
    format!(
        "Bind saved JumpServer credential. Connection name: [{}]; API authority: [{}]; SSH authority: [{}:{}]; login username: [{}]; auth: [{}]; org: [{}]; proxy authority: [{}]",
        super::user_presence::safe_prompt_field(&binding.name),
        super::user_presence::safe_prompt_field(&binding.base_url),
        super::user_presence::safe_prompt_field(&binding.ssh_host),
        binding.ssh_port,
        super::user_presence::safe_prompt_field(&binding.username),
        super::user_presence::safe_prompt_field(&binding.auth_method),
        super::user_presence::safe_prompt_field(org),
        proxy,
    )
}

#[tauri::command]
pub async fn jumpserver_store_credentials(
    window: tauri::WebviewWindow,
    binding: JumpServerCredentialBinding,
    credentials: JumpServerCredentials,
) -> Result<JumpServerCredentialStatus, String> {
    require_jumpserver_window(&window)?;
    credential_broker::store_credentials(binding, credentials)
}

#[tauri::command]
pub async fn jumpserver_credential_status(
    window: tauri::WebviewWindow,
    binding: JumpServerCredentialBinding,
) -> Result<JumpServerCredentialStatus, String> {
    require_jumpserver_window(&window)?;
    credential_broker::status(binding)
}

#[tauri::command]
pub async fn jumpserver_delete_credentials(
    window: tauri::WebviewWindow,
    name: String,
) -> Result<(), String> {
    require_jumpserver_window(&window)?;
    credential_broker::delete(&name)
}

fn require_jumpserver_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let label = window.label();
    if label == "main" || label == "settings" || label.starts_with("window-") {
        Ok(())
    } else {
        Err("JumpServer credentials are unavailable to this window".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_prompt_discloses_every_authority_without_secrets() {
        let reason = legacy_binding_reason(&JumpServerCredentialBinding {
            name: "prod".to_string(),
            base_url: "https://jump.example.com".to_string(),
            ssh_host: "koko.example.com".to_string(),
            ssh_port: 2222,
            username: "alice".to_string(),
            auth_method: "password".to_string(),
            org_id: "org-1".to_string(),
            proxy_type: "socks5".to_string(),
            proxy_host: "proxy.example.com".to_string(),
            proxy_port: 1080,
            proxy_username: "proxy-user".to_string(),
        });
        for expected in [
            "https://jump.example.com",
            "SSH authority: [koko.example.com:2222]",
            "login username: [alice]",
            "org-1",
            "socks5://proxy.example.com:1080 (username: [proxy-user])",
        ] {
            assert!(reason.contains(expected));
        }
        assert!(!reason.contains("secret"));
    }

    #[test]
    fn legacy_prompt_escapes_unicode_prompt_injection() {
        let reason = legacy_binding_reason(&JumpServerCredentialBinding {
            name: "prod]\u{202e} SSH authority: [evil".to_string(),
            base_url: "https://jump.example.com\u{2028}cancelled".to_string(),
            ssh_host: "koko.example.com\u{2066}".to_string(),
            ssh_port: 2222,
            username: "alice\nadmin".to_string(),
            auth_method: "password".to_string(),
            org_id: "org-1".to_string(),
            proxy_type: String::new(),
            proxy_host: String::new(),
            proxy_port: 0,
            proxy_username: String::new(),
        });
        assert!(!reason.contains('\u{202e}'));
        assert!(!reason.contains('\u{2028}'));
        assert!(!reason.contains('\u{2066}'));
        assert!(!reason.contains('\n'));
        assert!(reason.contains("\\u{202E}"));
        assert!(reason.contains("prod\\u{5D}\\u{202E} SSH authority: \\u{5B}evil"));
        assert!(reason.starts_with("Bind saved JumpServer credential."));
    }
}
