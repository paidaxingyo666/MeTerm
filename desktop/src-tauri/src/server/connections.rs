//! SSH 连接注册表 —— 元数据存储 + JSON 持久化。
//!
//! 仿 `ban.rs` 的 `BanManager` 持久化模式:内存 `HashMap` + 落盘到
//! `app_data_dir` 下的 JSON 文件。这里只做本地元数据存储/CRUD,不含
//! 路由与密钥(密钥走系统钥匙串,见设计稿 §2/§4,后续任务接入)。
//!
//! 同步语义(设计稿 §3):
//! - last-write-wins:以 `updated_at` 比较,新的覆盖旧的。
//! - 软删除:`delete` 只打 `deleted_at` 墓碑标记,不物理移除,
//!   这样离线客户端下次同步时能感知到删除并清理本地缓存。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};

/// 一条已保存的 SSH 连接(元数据,可明文同步;密钥另存钥匙串)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// "password" | "key"
    pub auth_method: String,
    /// 桌面 `~/.ssh` 路径密钥认证时为 true;此类密钥不进同步 secrets。
    #[serde(default)]
    pub has_key_path: bool,
    /// The desktop owner explicitly selected the ssh-agent/default-key ladder.
    /// Missing legacy key material must never imply this capability.
    #[serde(default)]
    pub uses_desktop_key_ladder: bool,
    /// 毫秒时间戳;last-write-wins 冲突解决用。
    pub updated_at: i64,
    /// 软删除标记(墓碑);None = 未删除。
    #[serde(default)]
    pub deleted_at: Option<i64>,

    // 桌面独有字段(同步透传,手机端只读不编辑)。
    #[serde(default)]
    pub proxy_type: Option<String>,
    #[serde(default)]
    pub proxy_host: Option<String>,
    #[serde(default)]
    pub proxy_port: Option<u16>,
    #[serde(default)]
    pub proxy_username: Option<String>,
    #[serde(default)]
    pub skip_shell_hook: Option<bool>,
    #[serde(default)]
    pub multiplex_sftp: Option<bool>,
}

/// Fields that determine where a saved SSH credential can be exercised.
/// Display-only changes must not invalidate the binding; any authority change
/// requires a replacement credential or a separate owner-confirmed rebind.
pub fn ssh_authority_changed(existing: &SavedConnection, next: &SavedConnection) -> bool {
    existing.host != next.host
        || existing.port != next.port
        || existing.username != next.username
        || existing.auth_method != next.auth_method
        || existing.has_key_path != next.has_key_path
        || existing.uses_desktop_key_ladder != next.uses_desktop_key_ladder
        || existing.proxy_type != next.proxy_type
        || existing.proxy_host != next.proxy_host
        || existing.proxy_port != next.proxy_port
        || existing.proxy_username != next.proxy_username
}

/// A tombstone is a credential revocation boundary, not an ordinary previous
/// generation. Resurrecting its ID must provide or explicitly authorize a
/// fresh credential source even when every authority field is unchanged.
pub fn ssh_credential_replacement_required(
    existing: Option<&SavedConnection>,
    next: &SavedConnection,
) -> bool {
    existing
        .is_none_or(|current| current.deleted_at.is_some() || ssh_authority_changed(current, next))
}

/// 当前时间的毫秒时间戳,用作 `updated_at`/`deleted_at`(路由层调用)。
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpsertOutcome {
    Applied,
    Stale,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteOutcome {
    Deleted,
    Missing,
    Stale,
}

/// External state changed alongside the registry (currently an OS credential
/// item). The mutation is finalized only after the registry snapshot is
/// durable; a persistence failure must restore the exact pre-mutation state.
pub(crate) trait DurableSideEffect {
    fn commit(self) -> Result<(), String>;
    fn rollback(self) -> Result<(), String>;
}

impl DurableSideEffect for () {
    fn commit(self) -> Result<(), String> {
        Ok(())
    }

    fn rollback(self) -> Result<(), String> {
        Ok(())
    }
}

impl<M: DurableSideEffect> DurableSideEffect for Option<M> {
    fn commit(self) -> Result<(), String> {
        match self {
            Some(mutation) => mutation.commit(),
            None => Ok(()),
        }
    }

    fn rollback(self) -> Result<(), String> {
        match self {
            Some(mutation) => mutation.rollback(),
            None => Ok(()),
        }
    }
}

/// 连接注册表:内存 `HashMap` + JSON 持久化到 `app_data_dir` 下的文件。
pub struct ConnectionRegistry {
    connections: Mutex<HashMap<String, SavedConnection>>,
    /// Serialize metadata + Keychain work for one connection without blocking
    /// unrelated connection ids. Weak values avoid an attacker growing this
    /// map forever by requesting arbitrary ids.
    transaction_locks: Mutex<HashMap<String, Weak<Mutex<()>>>>,
    /// Serialize whole-registry snapshots so two different IDs cannot race
    /// atomic renames and persist an older snapshot after a newer one.
    persistence_lock: Mutex<()>,
    file_path: PathBuf,
}

impl ConnectionRegistry {
    /// 从指定路径加载。文件不存在或内部测试使用空路径时从空表开始；
    /// 已存在文件的读取/解析/重复 ID 错误必须失败关闭，不能伪装成空 registry。
    pub fn new(path: PathBuf) -> Result<Self, String> {
        let mut map = HashMap::new();
        if !path.as_os_str().is_empty() {
            match std::fs::read_to_string(&path) {
                Ok(data) => {
                    let entries = serde_json::from_str::<Vec<SavedConnection>>(&data)
                        .map_err(|_| "SSH connection registry is invalid".to_string())?;
                    for entry in entries {
                        if entry.id.is_empty()
                            || entry.id.len() > 256
                            || entry.id.chars().any(char::is_control)
                            || map.insert(entry.id.clone(), entry).is_some()
                        {
                            return Err("SSH connection registry is invalid".to_string());
                        }
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("SSH connection registry is unavailable".to_string()),
            }
        }
        Ok(Self {
            connections: Mutex::new(map),
            transaction_locks: Mutex::new(HashMap::new()),
            persistence_lock: Mutex::new(()),
            file_path: path,
        })
    }

    fn with_id_lock<T>(&self, id: &str, operation: impl FnOnce() -> T) -> T {
        let lock = {
            let mut locks = self
                .transaction_locks
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            locks.retain(|_, weak| weak.strong_count() > 0);
            match locks.get(id).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(Mutex::new(()));
                    locks.insert(id.to_string(), Arc::downgrade(&lock));
                    lock
                }
            }
        };
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        operation()
    }

    /// 所有条目,含墓碑(客户端同步删除需要墓碑)。
    pub fn all(&self) -> Vec<SavedConnection> {
        self.connections.lock().unwrap().values().cloned().collect()
    }

    /// 未删除的条目。
    pub fn active(&self) -> Vec<SavedConnection> {
        self.connections
            .lock()
            .unwrap()
            .values()
            .filter(|c| c.deleted_at.is_none())
            .cloned()
            .collect()
    }

    /// 按 id 查单条(含墓碑)。
    pub fn get(&self, id: &str) -> Option<SavedConnection> {
        self.connections.lock().unwrap().get(id).cloned()
    }

    /// Read metadata and related external state (for example Keychain secrets)
    /// under the same per-id transaction lock used by mutations.
    pub fn read_with<T>(&self, id: &str, reader: impl FnOnce(Option<SavedConnection>) -> T) -> T {
        self.with_id_lock(id, || reader(self.get(id)))
    }

    /// Conditionally insert/update one connection and run its Keychain write
    /// inside the same per-id transaction. A stale LWW request never executes
    /// `before_commit`, so it cannot overwrite a newer credential bundle.
    pub fn upsert_with<E: From<String>>(
        &self,
        conn: SavedConnection,
        before_commit: impl FnOnce() -> Result<(), E>,
    ) -> Result<UpsertOutcome, E> {
        self.upsert_checked_with(conn, |_| before_commit())
    }

    /// Variant of `upsert_with` that exposes the existing metadata while the
    /// per-connection transaction lock is held. Security checks can therefore
    /// compare destination/auth fields with the committed generation without a
    /// check-then-write race.
    pub fn upsert_checked_with<E: From<String>>(
        &self,
        conn: SavedConnection,
        before_commit: impl FnOnce(Option<&SavedConnection>) -> Result<(), E>,
    ) -> Result<UpsertOutcome, E> {
        self.upsert_checked_transaction(conn, |existing| {
            before_commit(existing)?;
            Ok(())
        })
    }

    /// Reversible variant used when an accepted metadata update also mutates
    /// Keychain. The side effect stays provisional until the registry has been
    /// atomically persisted.
    pub(crate) fn upsert_checked_transaction<E: From<String>, M: DurableSideEffect>(
        &self,
        conn: SavedConnection,
        before_commit: impl FnOnce(Option<&SavedConnection>) -> Result<M, E>,
    ) -> Result<UpsertOutcome, E> {
        let id = conn.id.clone();
        self.with_id_lock(&id, || {
            let existing = {
                let map = self.connections.lock().unwrap();
                map.get(&id).cloned()
            };
            let should_write = existing
                .as_ref()
                .is_none_or(|existing| conn.updated_at >= existing.updated_at);
            if !should_write {
                return Ok(UpsertOutcome::Stale);
            }

            let mutation = before_commit(existing.as_ref())?;
            let _persistence = self
                .persistence_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.connections
                .lock()
                .unwrap()
                .insert(conn.id.clone(), conn);
            if let Err(error) = self.save() {
                if error.replacement_visible() {
                    return match mutation.commit() {
                        Ok(()) => Err(E::from(
                            "SSH connection registry committed but directory durability sync failed"
                                .to_string(),
                        )),
                        Err(_) => Err(E::from(
                            "SSH connection registry committed but credential cleanup failed"
                                .to_string(),
                        )),
                    };
                }
                let mut map = self.connections.lock().unwrap();
                if let Some(previous) = existing {
                    map.insert(id.clone(), previous);
                } else {
                    map.remove(&id);
                }
                if mutation.rollback().is_err() {
                    return Err(E::from(
                        "failed to persist SSH connection registry and restore credential state"
                            .to_string(),
                    ));
                }
                return Err(E::from(
                    "failed to persist SSH connection registry".to_string(),
                ));
            }
            mutation.commit().map_err(E::from)?;
            Ok(UpsertOutcome::Applied)
        })
    }

    /// Metadata-only convenience wrapper. Returns whether LWW accepted the
    /// update, which lets callers avoid treating a stale request as committed.
    pub fn upsert(&self, conn: SavedConnection) -> Result<UpsertOutcome, String> {
        self.upsert_with(conn, || Ok(()))
    }

    /// Delete one credential bundle and tombstone its metadata under the same
    /// per-id lock. A timestamp older than the current generation is ignored
    /// before `before_commit` runs. Missing metadata still runs the callback so
    /// callers can remove an orphaned Keychain entry.
    pub fn delete_with<E: From<String>>(
        &self,
        id: &str,
        deleted_at: i64,
        before_commit: impl FnOnce() -> Result<(), E>,
    ) -> Result<DeleteOutcome, E> {
        self.delete_transaction(id, deleted_at, || {
            before_commit()?;
            Ok(())
        })
    }

    /// Reversible variant used when deleting a credential and persisting its
    /// tombstone must succeed or fail as one logical transaction.
    pub(crate) fn delete_transaction<E: From<String>, M: DurableSideEffect>(
        &self,
        id: &str,
        deleted_at: i64,
        before_commit: impl FnOnce() -> Result<M, E>,
    ) -> Result<DeleteOutcome, E> {
        self.with_id_lock(id, || {
            let current = self.get(id);
            if current
                .as_ref()
                .is_some_and(|entry| deleted_at < entry.updated_at)
            {
                return Ok(DeleteOutcome::Stale);
            }

            let mutation = before_commit()?;
            let Some(_) = current else {
                mutation.commit().map_err(E::from)?;
                return Ok(DeleteOutcome::Missing);
            };
            let _persistence = self
                .persistence_lock
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(entry) = self.connections.lock().unwrap().get_mut(id) {
                entry.deleted_at = Some(deleted_at);
                entry.updated_at = deleted_at;
            }
            if let Err(error) = self.save() {
                if error.replacement_visible() {
                    return match mutation.commit() {
                        Ok(()) => Err(E::from(
                            "SSH connection tombstone committed but directory durability sync failed"
                                .to_string(),
                        )),
                        Err(_) => Err(E::from(
                            "SSH connection tombstone committed but credential cleanup failed"
                                .to_string(),
                        )),
                    };
                }
                if let Some(previous) = current {
                    self.connections
                        .lock()
                        .unwrap()
                        .insert(id.to_string(), previous);
                }
                if mutation.rollback().is_err() {
                    return Err(E::from(
                        "failed to persist SSH connection registry and restore credential state"
                            .to_string(),
                    ));
                }
                return Err(E::from(
                    "failed to persist SSH connection registry".to_string(),
                ));
            }
            mutation.commit().map_err(E::from)?;
            Ok(DeleteOutcome::Deleted)
        })
    }

    /// Metadata-only convenience wrapper.
    pub fn delete(&self, id: &str, deleted_at: i64) -> Result<DeleteOutcome, String> {
        self.delete_with(id, deleted_at, || Ok(()))
    }

    /// Atomically persist the complete registry. A failure is part of the
    /// credential transaction result and must never be reported as Applied.
    fn save(&self) -> Result<(), super::private_file::AtomicWriteError> {
        if self.file_path.as_os_str().is_empty() {
            return Ok(());
        }
        let guard = self.connections.lock().unwrap();
        let entries: Vec<&SavedConnection> = guard.values().collect();
        let data = serde_json::to_vec_pretty(&entries).map_err(|_| {
            super::private_file::AtomicWriteError::before_replace(
                "failed to encode SSH connection registry",
            )
        })?;
        super::private_file::atomic_write_private_staged(&self.file_path, &data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("meterm-test-connections-{}-{}.json", name, nanos))
    }

    fn make_conn(id: &str, name: &str, updated_at: i64) -> SavedConnection {
        SavedConnection {
            id: id.to_string(),
            name: name.to_string(),
            host: "example.com".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_method: "password".to_string(),
            has_key_path: false,
            uses_desktop_key_ladder: false,
            updated_at,
            deleted_at: None,
            proxy_type: None,
            proxy_host: None,
            proxy_port: None,
            proxy_username: None,
            skip_shell_hook: None,
            multiplex_sftp: None,
        }
    }

    struct TrackedMutation {
        committed: Arc<AtomicBool>,
        rolled_back: Arc<AtomicBool>,
    }

    impl DurableSideEffect for TrackedMutation {
        fn commit(self) -> Result<(), String> {
            self.committed.store(true, Ordering::SeqCst);
            Ok(())
        }

        fn rollback(self) -> Result<(), String> {
            self.rolled_back.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    #[test]
    fn test_upsert_new_appears_in_active() {
        let path = temp_path("upsert-new");
        let registry = ConnectionRegistry::new(path.clone()).unwrap();

        registry.upsert(make_conn("c1", "server-a", 1000)).unwrap();

        let active = registry.active();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "c1");
        assert_eq!(active[0].name, "server-a");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_upsert_older_update_is_ignored() {
        let path = temp_path("upsert-lww");
        let registry = ConnectionRegistry::new(path.clone()).unwrap();

        registry
            .upsert(make_conn("c1", "newer-name", 2000))
            .unwrap();
        // 携带更旧 updated_at 的重复写入应被丢弃,保留原有的更新条目。
        registry
            .upsert(make_conn("c1", "older-name", 1000))
            .unwrap();

        let entry = registry.get("c1").expect("entry should exist");
        assert_eq!(entry.name, "newer-name");
        assert_eq!(entry.updated_at, 2000);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn stale_upsert_does_not_run_secret_side_effect() {
        let path = temp_path("upsert-stale-secret");
        let registry = ConnectionRegistry::new(path.clone()).unwrap();
        registry
            .upsert(make_conn("c1", "newer-name", 2000))
            .unwrap();

        let mut secret_write_ran = false;
        let outcome = registry
            .upsert_with(make_conn("c1", "older-name", 1000), || {
                secret_write_ran = true;
                Ok::<(), String>(())
            })
            .unwrap();

        assert_eq!(outcome, UpsertOutcome::Stale);
        assert!(!secret_write_ran);
        assert_eq!(registry.get("c1").unwrap().name, "newer-name");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn stale_delete_does_not_run_secret_side_effect() {
        let path = temp_path("delete-stale-secret");
        let registry = ConnectionRegistry::new(path.clone()).unwrap();
        registry
            .upsert(make_conn("c1", "newer-name", 2000))
            .unwrap();

        let mut secret_delete_ran = false;
        let outcome = registry
            .delete_with("c1", 1000, || {
                secret_delete_ran = true;
                Ok::<(), String>(())
            })
            .unwrap();

        assert_eq!(outcome, DeleteOutcome::Stale);
        assert!(!secret_delete_ran);
        assert!(registry.get("c1").unwrap().deleted_at.is_none());

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn same_id_transactions_serialize_secret_and_metadata_commits() {
        let path = temp_path("same-id-serialization");
        let registry = Arc::new(ConnectionRegistry::new(path.clone()).unwrap());
        registry.upsert(make_conn("c1", "initial", 1000)).unwrap();

        let (first_entered_tx, first_entered_rx) = mpsc::channel();
        let (release_first_tx, release_first_rx) = mpsc::channel();
        let first_registry = Arc::clone(&registry);
        let first = thread::spawn(move || {
            first_registry
                .upsert_with(make_conn("c1", "first", 2000), || {
                    first_entered_tx.send(()).unwrap();
                    release_first_rx.recv().unwrap();
                    Ok::<(), String>(())
                })
                .unwrap()
        });
        first_entered_rx.recv().unwrap();

        let (second_entered_tx, second_entered_rx) = mpsc::channel();
        let second_registry = Arc::clone(&registry);
        let second = thread::spawn(move || {
            second_registry
                .upsert_with(make_conn("c1", "second", 3000), || {
                    second_entered_tx.send(()).unwrap();
                    Ok::<(), String>(())
                })
                .unwrap()
        });

        assert!(second_entered_rx
            .recv_timeout(Duration::from_millis(100))
            .is_err());
        release_first_tx.send(()).unwrap();
        assert_eq!(first.join().unwrap(), UpsertOutcome::Applied);
        second_entered_rx.recv().unwrap();
        assert_eq!(second.join().unwrap(), UpsertOutcome::Applied);
        assert_eq!(registry.get("c1").unwrap().name, "second");

        drop(registry);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn test_delete_creates_tombstone() {
        let path = temp_path("delete");
        let registry = ConnectionRegistry::new(path.clone()).unwrap();

        registry.upsert(make_conn("c1", "server-a", 1000)).unwrap();
        registry.delete("c1", 5000).unwrap();

        // 从 active() 消失
        assert!(registry.active().is_empty());

        // 但在 all() 里仍存在,且带 deleted_at 墓碑
        let all = registry.all();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "c1");
        assert_eq!(all[0].deleted_at, Some(5000));
        assert_eq!(all[0].updated_at, 5000);

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tombstone_requires_fresh_credentials_before_resurrection() {
        let mut tombstone = make_conn("c1", "server-a", 5_000);
        tombstone.deleted_at = Some(5_000);
        let mut replacement = tombstone.clone();
        replacement.deleted_at = None;
        replacement.updated_at = 6_000;

        assert!(ssh_credential_replacement_required(
            Some(&tombstone),
            &replacement
        ));
    }

    #[test]
    fn test_delete_unknown_id_is_noop() {
        let path = temp_path("delete-unknown");
        let registry = ConnectionRegistry::new(path.clone()).unwrap();

        registry.delete("does-not-exist", 5000).unwrap();

        assert!(registry.all().is_empty());
        // 不应因为 no-op 而落盘生成文件
        assert!(!path.exists());
    }

    #[test]
    fn test_persistence_round_trip() {
        let path = temp_path("roundtrip");
        {
            let registry = ConnectionRegistry::new(path.clone()).unwrap();
            registry.upsert(make_conn("c1", "server-a", 1000)).unwrap();
            registry.upsert(make_conn("c2", "server-b", 2000)).unwrap();
            registry.delete("c2", 3000).unwrap();
        }

        // 重新从同一路径加载,应恢复原有数据(含墓碑)。
        let reloaded = ConnectionRegistry::new(path.clone()).unwrap();
        let all = reloaded.all();
        assert_eq!(all.len(), 2);

        let c1 = reloaded.get("c1").expect("c1 should persist");
        assert_eq!(c1.name, "server-a");
        assert_eq!(c1.deleted_at, None);

        let c2 = reloaded.get("c2").expect("c2 should persist");
        assert_eq!(c2.deleted_at, Some(3000));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn corrupt_existing_registry_fails_closed() {
        let path = temp_path("corrupt-load");
        std::fs::write(&path, b"{").unwrap();
        assert!(ConnectionRegistry::new(path.clone()).is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn persistence_failure_is_reported_and_rolls_back_memory() {
        let path = temp_path("persist-failure");
        let registry = ConnectionRegistry::new(path.clone()).unwrap();
        std::fs::create_dir(&path).unwrap();

        assert!(registry.upsert(make_conn("c1", "server-a", 1000)).is_err());
        assert!(registry.all().is_empty());

        let _ = std::fs::remove_dir(&path);
    }

    #[test]
    fn upsert_persistence_failure_rolls_back_external_mutation() {
        let path = temp_path("upsert-external-rollback");
        let registry = ConnectionRegistry::new(path.clone()).unwrap();
        registry.upsert(make_conn("c1", "before", 1000)).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();

        let committed = Arc::new(AtomicBool::new(false));
        let rolled_back = Arc::new(AtomicBool::new(false));
        let result = registry.upsert_checked_transaction(make_conn("c1", "after", 2000), |_| {
            Ok::<_, String>(TrackedMutation {
                committed: Arc::clone(&committed),
                rolled_back: Arc::clone(&rolled_back),
            })
        });

        assert!(result.is_err());
        assert!(!committed.load(Ordering::SeqCst));
        assert!(rolled_back.load(Ordering::SeqCst));
        assert_eq!(registry.get("c1").unwrap().name, "before");
        let _ = std::fs::remove_dir(&path);
    }

    #[test]
    fn delete_persistence_failure_rolls_back_external_mutation() {
        let path = temp_path("delete-external-rollback");
        let registry = ConnectionRegistry::new(path.clone()).unwrap();
        registry.upsert(make_conn("c1", "before", 1000)).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();

        let committed = Arc::new(AtomicBool::new(false));
        let rolled_back = Arc::new(AtomicBool::new(false));
        let result = registry.delete_transaction("c1", 2000, || {
            Ok::<_, String>(TrackedMutation {
                committed: Arc::clone(&committed),
                rolled_back: Arc::clone(&rolled_back),
            })
        });

        assert!(result.is_err());
        assert!(!committed.load(Ordering::SeqCst));
        assert!(rolled_back.load(Ordering::SeqCst));
        assert!(registry.get("c1").unwrap().deleted_at.is_none());
        let _ = std::fs::remove_dir(&path);
    }

    #[test]
    fn post_replace_sync_failure_keeps_upsert_and_commits_side_effect() {
        let path = temp_path("upsert-post-replace");
        let registry = ConnectionRegistry::new(path.clone()).unwrap();
        registry.upsert(make_conn("c1", "before", 1000)).unwrap();

        let committed = Arc::new(AtomicBool::new(false));
        let rolled_back = Arc::new(AtomicBool::new(false));
        super::super::private_file::fail_next_parent_sync_for_test();
        let result = registry.upsert_checked_transaction(make_conn("c1", "after", 2000), |_| {
            Ok::<_, String>(TrackedMutation {
                committed: Arc::clone(&committed),
                rolled_back: Arc::clone(&rolled_back),
            })
        });

        assert!(result.is_err());
        assert!(committed.load(Ordering::SeqCst));
        assert!(!rolled_back.load(Ordering::SeqCst));
        assert_eq!(registry.get("c1").unwrap().name, "after");
        drop(registry);
        assert_eq!(
            ConnectionRegistry::new(path.clone())
                .unwrap()
                .get("c1")
                .unwrap()
                .name,
            "after"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn post_replace_sync_failure_keeps_tombstone_and_commits_cleanup() {
        let path = temp_path("delete-post-replace");
        let registry = ConnectionRegistry::new(path.clone()).unwrap();
        registry.upsert(make_conn("c1", "before", 1000)).unwrap();

        let committed = Arc::new(AtomicBool::new(false));
        let rolled_back = Arc::new(AtomicBool::new(false));
        super::super::private_file::fail_next_parent_sync_for_test();
        let result = registry.delete_transaction("c1", 2000, || {
            Ok::<_, String>(TrackedMutation {
                committed: Arc::clone(&committed),
                rolled_back: Arc::clone(&rolled_back),
            })
        });

        assert!(result.is_err());
        assert!(committed.load(Ordering::SeqCst));
        assert!(!rolled_back.load(Ordering::SeqCst));
        assert_eq!(registry.get("c1").unwrap().deleted_at, Some(2000));
        drop(registry);
        assert_eq!(
            ConnectionRegistry::new(path.clone())
                .unwrap()
                .get("c1")
                .unwrap()
                .deleted_at,
            Some(2000)
        );
        let _ = std::fs::remove_file(&path);
    }
}
