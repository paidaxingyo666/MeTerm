//! Low-level Keychain/keyring operations for the SSH credential vault.

use zeroize::Zeroizing;

fn store(service: &str, account: &str, json: &str) -> Result<(), String> {
    let entry =
        keyring::Entry::new(service, account).map_err(|e| format!("keyring init error: {e}"))?;
    entry
        .set_password(json)
        .map_err(|e| format!("keyring store error: {e}"))
}

pub(super) fn store_verified(service: &str, account: &str, json: &str) -> Result<(), String> {
    store(service, account, json)?;
    verify(service, account, json, "write")
}

#[cfg(target_os = "macos")]
pub(super) fn create_verified(service: &str, account: &str, json: &str) -> Result<(), String> {
    use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};

    let keychain = SecKeychain::default_for_domain(SecPreferencesDomain::User)
        .map_err(|_| "keyring create error".to_string())?;
    // Add-only is deliberate. Updating a pre-created generic password would
    // retain the creator's ACL and could disclose every later secret update.
    keychain
        .add_generic_password(service, account, json.as_bytes())
        .map_err(|_| "keyring create error".to_string())?;
    verify(service, account, json, "create")
}

#[cfg(not(target_os = "macos"))]
pub(super) fn create_verified(service: &str, account: &str, json: &str) -> Result<(), String> {
    if load(service, account)?.is_some() {
        return Err("SSH credential target already exists".to_string());
    }
    store_verified(service, account, json)
}

fn verify(service: &str, account: &str, json: &str, operation: &str) -> Result<(), String> {
    let persisted = load(service, account)?
        .ok_or_else(|| format!("SSH credential {operation} verification failed"))?;
    let persisted = Zeroizing::new(persisted);
    if persisted.as_bytes() == json.as_bytes() {
        Ok(())
    } else {
        Err(format!("SSH credential {operation} verification failed"))
    }
}

pub(super) fn load(service: &str, account: &str) -> Result<Option<String>, String> {
    let entry =
        keyring::Entry::new(service, account).map_err(|e| format!("keyring init error: {e}"))?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring get error: {e}")),
    }
}

pub(super) fn delete(service: &str, account: &str) -> Result<(), String> {
    let entry =
        keyring::Entry::new(service, account).map_err(|e| format!("keyring init error: {e}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete error: {e}")),
    }
}
