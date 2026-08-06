//! Reversible Keychain side effects paired with durable connection metadata.

use std::sync::MutexGuard;
use zeroize::Zeroizing;

use super::super::connections::DurableSideEffect;
use super::{kc_delete, kc_load, kc_store_verified, raw_digest};

pub(super) struct CredentialSnapshot {
    pub(super) service: String,
    pub(super) account: String,
    pub(super) value: Option<Zeroizing<String>>,
}

pub(super) struct CredentialCleanup {
    pub(super) service: String,
    pub(super) account: String,
    pub(super) digest: Option<[u8; 32]>,
}

/// Exact before-image plus deferred cleanup for a small, fixed set of
/// credential items. The receipt stays provisional until registry persistence.
pub(crate) struct SecretMutation {
    pub(super) rollback_entries: Vec<CredentialSnapshot>,
    pub(super) cleanup_entries: Vec<CredentialCleanup>,
    /// Name-keyed accounts are shared by connection name rather than ID. Hold
    /// their lock through registry persistence, cleanup, and any rollback.
    pub(super) named_guard: Option<MutexGuard<'static, ()>>,
}

impl SecretMutation {
    pub(super) fn capture(
        items: impl IntoIterator<Item = (String, String)>,
    ) -> Result<Self, String> {
        let mut entries: Vec<CredentialSnapshot> = Vec::new();
        for (service, account) in items {
            if entries
                .iter()
                .any(|entry| entry.service == service && entry.account == account)
            {
                continue;
            }
            let value = kc_load(&service, &account)?.map(Zeroizing::new);
            entries.push(CredentialSnapshot {
                service,
                account,
                value,
            });
        }
        Ok(Self {
            rollback_entries: entries,
            cleanup_entries: Vec::new(),
            named_guard: None,
        })
    }

    pub(super) fn cleanup_items(
        items: impl IntoIterator<Item = (String, String)>,
    ) -> Result<Vec<CredentialCleanup>, String> {
        let mut entries: Vec<CredentialCleanup> = Vec::new();
        for (service, account) in items {
            if entries
                .iter()
                .any(|entry| entry.service == service && entry.account == account)
            {
                continue;
            }
            let value = kc_load(&service, &account)?.map(Zeroizing::new);
            entries.push(CredentialCleanup {
                service,
                account,
                digest: raw_digest(value.as_ref().map(|value| value.as_str())),
            });
        }
        Ok(entries)
    }

    pub(super) fn restore_entries(entries: Vec<CredentialSnapshot>) -> Result<(), String> {
        let mut failed = false;
        for entry in entries.into_iter().rev() {
            let result = match entry.value.as_ref() {
                Some(value) => kc_store_verified(&entry.service, &entry.account, value),
                None => kc_delete(&entry.service, &entry.account),
            };
            failed |= result.is_err();
        }
        if failed {
            Err("failed to restore SSH credential transaction".to_string())
        } else {
            Ok(())
        }
    }

    fn cleanup_entries(entries: Vec<CredentialCleanup>) -> Result<(), String> {
        let mut failed = false;
        for entry in entries {
            let current = match kc_load(&entry.service, &entry.account) {
                Ok(value) => value.map(Zeroizing::new),
                Err(_) => {
                    failed = true;
                    continue;
                }
            };
            if raw_digest(current.as_ref().map(|value| value.as_str())) != entry.digest {
                failed = true;
                continue;
            }
            if entry.digest.is_none() {
                continue;
            }
            if kc_delete(&entry.service, &entry.account).is_err()
                || !matches!(kc_load(&entry.service, &entry.account), Ok(None))
            {
                failed = true;
            }
        }
        if failed {
            Err("failed to remove committed legacy SSH credentials".to_string())
        } else {
            Ok(())
        }
    }
}

impl DurableSideEffect for SecretMutation {
    fn commit(self) -> Result<(), String> {
        let Self {
            rollback_entries,
            cleanup_entries,
            named_guard,
        } = self;
        let _guard = named_guard;
        drop(rollback_entries);
        Self::cleanup_entries(cleanup_entries)
    }

    fn rollback(self) -> Result<(), String> {
        let Self {
            rollback_entries,
            cleanup_entries,
            named_guard,
        } = self;
        let _guard = named_guard;
        drop(cleanup_entries);
        Self::restore_entries(rollback_entries)
    }
}
