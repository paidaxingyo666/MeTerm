//! Principal-partitioned JumpServer HTTP client cache.
//!
//! JumpServer clients contain session cookies, bearer tokens, CSRF state, and
//! cached credentials. A normalized base URL alone is therefore not a safe
//! cache key: every authenticated owner/device credential generation gets an
//! independent client.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use crate::server::auth::AuthPrincipal;

use super::{normalize_base_url, JumpServerClient};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum PoolPrincipal {
    Owner {
        generation: uuid::Uuid,
    },
    Device {
        device_id: String,
        generation: uuid::Uuid,
    },
}

impl From<&AuthPrincipal> for PoolPrincipal {
    fn from(principal: &AuthPrincipal) -> Self {
        match principal {
            AuthPrincipal::Owner { generation } => Self::Owner {
                generation: *generation,
            },
            AuthPrincipal::Device {
                device_id,
                generation,
                ..
            } => Self::Device {
                device_id: device_id.clone(),
                generation: *generation,
            },
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ClientPoolKey {
    base_url: String,
    principal: PoolPrincipal,
}

fn pool_key(base_url: &str, principal: &AuthPrincipal) -> Result<ClientPoolKey, String> {
    Ok(ClientPoolKey {
        base_url: normalize_base_url(base_url)?,
        principal: PoolPrincipal::from(principal),
    })
}

static CLIENT_POOL: LazyLock<
    Mutex<HashMap<ClientPoolKey, Arc<tokio::sync::Mutex<JumpServerClient>>>>,
> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Clear all cached clients (called when proxy mode changes).
pub fn clear_client_pool() {
    CLIENT_POOL.lock().unwrap().clear();
}

/// Remove the current principal's cached login for one JumpServer origin.
pub(super) fn reset_client(base_url: &str, principal: &AuthPrincipal) -> Result<(), String> {
    let key = pool_key(base_url, principal)?;
    CLIENT_POOL.lock().unwrap().remove(&key);
    Ok(())
}

/// Get or create a cached client for exactly one authenticated generation.
pub(super) fn get_or_create_client(
    base_url: &str,
    principal: &AuthPrincipal,
) -> Result<Arc<tokio::sync::Mutex<JumpServerClient>>, String> {
    let key = pool_key(base_url, principal)?;
    let mut pool = CLIENT_POOL.lock().unwrap();
    if let Some(client) = pool.get(&key) {
        return Ok(client.clone());
    }
    let client = Arc::new(tokio::sync::Mutex::new(JumpServerClient::new(
        &key.base_url,
    )?));
    pool.insert(key, client.clone());
    Ok(client)
}

pub(crate) fn remove_owner_generation(generation: uuid::Uuid) {
    CLIENT_POOL.lock().unwrap().retain(|key, _| {
        !matches!(
            &key.principal,
            PoolPrincipal::Owner {
                generation: cached
            } if *cached == generation
        )
    });
}

pub(crate) fn remove_device_generation(device_id: &str, generation: uuid::Uuid) {
    CLIENT_POOL.lock().unwrap().retain(|key, _| {
        !matches!(
            &key.principal,
            PoolPrincipal::Device {
                device_id: cached_id,
                generation: cached_generation,
            } if cached_id == device_id && *cached_generation == generation
        )
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    fn owner(generation: uuid::Uuid) -> AuthPrincipal {
        AuthPrincipal::Owner { generation }
    }

    fn device(device_id: &str, generation: uuid::Uuid) -> AuthPrincipal {
        AuthPrincipal::Device {
            device_id: device_id.to_string(),
            device_name: "Phone".to_string(),
            generation,
        }
    }

    #[test]
    fn cache_reuse_requires_same_principal_and_exact_generation() {
        let _test = TEST_LOCK.lock().unwrap();
        clear_client_pool();
        let generation = uuid::Uuid::new_v4();
        let first =
            get_or_create_client("https://jump.example.com/", &device("device-a", generation))
                .unwrap();
        let same =
            get_or_create_client("https://jump.example.com", &device("device-a", generation))
                .unwrap();
        let other_device =
            get_or_create_client("https://jump.example.com", &device("device-b", generation))
                .unwrap();
        let next_generation = get_or_create_client(
            "https://jump.example.com",
            &device("device-a", uuid::Uuid::new_v4()),
        )
        .unwrap();
        let owner_client =
            get_or_create_client("https://jump.example.com", &owner(generation)).unwrap();
        let next_owner_client =
            get_or_create_client("https://jump.example.com", &owner(uuid::Uuid::new_v4())).unwrap();

        assert!(Arc::ptr_eq(&first, &same));
        assert!(!Arc::ptr_eq(&first, &other_device));
        assert!(!Arc::ptr_eq(&first, &next_generation));
        assert!(!Arc::ptr_eq(&first, &owner_client));
        assert!(!Arc::ptr_eq(&owner_client, &next_owner_client));
        clear_client_pool();
    }

    #[test]
    fn retired_generation_cleanup_does_not_remove_other_principals() {
        let _test = TEST_LOCK.lock().unwrap();
        clear_client_pool();
        let old = uuid::Uuid::new_v4();
        let current = uuid::Uuid::new_v4();
        let old_client =
            get_or_create_client("https://jump.example.com", &device("device-a", old)).unwrap();
        let current_client =
            get_or_create_client("https://jump.example.com", &device("device-a", current)).unwrap();
        let other =
            get_or_create_client("https://jump.example.com", &device("device-b", old)).unwrap();
        let old_owner = get_or_create_client("https://jump.example.com", &owner(old)).unwrap();
        let current_owner =
            get_or_create_client("https://jump.example.com", &owner(current)).unwrap();

        remove_device_generation("device-a", old);
        remove_owner_generation(old);

        let recreated =
            get_or_create_client("https://jump.example.com", &device("device-a", old)).unwrap();
        let current_again =
            get_or_create_client("https://jump.example.com", &device("device-a", current)).unwrap();
        let other_again =
            get_or_create_client("https://jump.example.com", &device("device-b", old)).unwrap();
        let recreated_owner =
            get_or_create_client("https://jump.example.com", &owner(old)).unwrap();
        let current_owner_again =
            get_or_create_client("https://jump.example.com", &owner(current)).unwrap();
        assert!(!Arc::ptr_eq(&old_client, &recreated));
        assert!(Arc::ptr_eq(&current_client, &current_again));
        assert!(Arc::ptr_eq(&other, &other_again));
        assert!(!Arc::ptr_eq(&old_owner, &recreated_owner));
        assert!(Arc::ptr_eq(&current_owner, &current_owner_again));
        clear_client_pool();
    }

    #[test]
    fn fresh_auth_reset_is_scoped_to_the_request_principal() {
        let _test = TEST_LOCK.lock().unwrap();
        clear_client_pool();
        let generation = uuid::Uuid::new_v4();
        let device_a = device("device-a", generation);
        let device_b = device("device-b", generation);
        let first = get_or_create_client("https://jump.example.com", &device_a).unwrap();
        let other = get_or_create_client("https://jump.example.com", &device_b).unwrap();

        reset_client("https://jump.example.com", &device_a).unwrap();

        let recreated = get_or_create_client("https://jump.example.com", &device_a).unwrap();
        let other_again = get_or_create_client("https://jump.example.com", &device_b).unwrap();
        assert!(!Arc::ptr_eq(&first, &recreated));
        assert!(Arc::ptr_eq(&other, &other_again));
        clear_client_pool();
    }
}
