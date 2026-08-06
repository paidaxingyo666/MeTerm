use serde::Deserialize;
use zeroize::Zeroize;

use super::SshSecrets;

#[derive(Default, Deserialize)]
pub(super) struct LegacyNamedSecrets {
    #[serde(default)]
    pub(super) password: Option<String>,
    #[serde(default, alias = "privateKeyPem", alias = "privateKey")]
    pub(super) private_key_pem: Option<String>,
    #[serde(default)]
    pub(super) passphrase: Option<String>,
    #[serde(default, alias = "proxyPassword")]
    pub(super) proxy_password: Option<String>,
}

impl LegacyNamedSecrets {
    pub(super) fn zeroize_sensitive(&mut self) {
        for value in [
            &mut self.password,
            &mut self.private_key_pem,
            &mut self.passphrase,
            &mut self.proxy_password,
        ] {
            if let Some(value) = value.as_mut() {
                value.zeroize();
            }
        }
    }
}

pub(super) fn merge_secret_field(
    target: &mut Option<String>,
    incoming: Option<&str>,
) -> Result<(), String> {
    let incoming = incoming.filter(|value| !value.is_empty());
    if target.as_deref().is_some_and(str::is_empty) {
        if let Some(mut empty) = target.take() {
            empty.zeroize();
        }
    }
    match (target.as_deref(), incoming) {
        (Some(existing), Some(candidate)) if existing != candidate => {
            Err("conflicting legacy SSH credential sources".to_string())
        }
        (None, Some(candidate)) => {
            *target = Some(candidate.to_string());
            Ok(())
        }
        _ => Ok(()),
    }
}

pub(super) fn merge_secret_bundle(
    target: &mut SshSecrets,
    source: &SshSecrets,
) -> Result<(), String> {
    merge_secret_field(&mut target.password, source.password.as_deref())?;
    merge_secret_field(
        &mut target.private_key_pem,
        source.private_key_pem.as_deref(),
    )?;
    merge_secret_field(&mut target.passphrase, source.passphrase.as_deref())?;
    merge_secret_field(&mut target.proxy_password, source.proxy_password.as_deref())?;
    merge_secret_field(
        &mut target.private_key_path,
        source.private_key_path.as_deref(),
    )
}

pub(super) fn merge_named_secrets(
    target: &mut SshSecrets,
    source: &LegacyNamedSecrets,
) -> Result<(), String> {
    merge_secret_field(&mut target.password, source.password.as_deref())?;
    merge_secret_field(
        &mut target.private_key_pem,
        source.private_key_pem.as_deref(),
    )?;
    merge_secret_field(&mut target.passphrase, source.passphrase.as_deref())?;
    merge_secret_field(&mut target.proxy_password, source.proxy_password.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflicting_non_empty_sources_fail_without_overwrite() {
        let mut target = Some("first".to_string());
        assert!(merge_secret_field(&mut target, Some("second")).is_err());
        assert_eq!(target.as_deref(), Some("first"));
    }

    #[test]
    fn identical_or_missing_sources_merge_without_conflict() {
        let mut target = None;
        merge_secret_field(&mut target, Some("secret")).unwrap();
        merge_secret_field(&mut target, Some("secret")).unwrap();
        merge_secret_field(&mut target, None).unwrap();
        assert_eq!(target.as_deref(), Some("secret"));
    }
}
