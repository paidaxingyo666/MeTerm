//! File transfer session management — mirrors Go `session/transfers.go`.
//!
//! Tracks active upload and download sessions per terminal session.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use super::{Session, TransferOwnerKey, UploadState};

pub const MAX_UPLOAD_LEASES_PER_CLIENT: usize = 4;
pub const MAX_UPLOAD_LEASES_PER_SESSION: usize = 16;
const UPLOAD_DRAIN_TIMEOUT: Duration = Duration::from_secs(30);
const UPLOAD_CLOSE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UploadPhase {
    Active,
    Finalizing,
    /// One or more remote requests timed out and may still complete later.
    /// Keep the path unavailable until the containing Session is dropped.
    Poisoned,
}

#[derive(Debug, Eq, PartialEq)]
pub enum UploadSettleError {
    Failed(String),
    TimedOut(&'static str),
}

impl UploadSettleError {
    pub fn is_timeout(&self) -> bool {
        matches!(self, Self::TimedOut(_))
    }
}

impl std::fmt::Display for UploadSettleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Failed(message) => formatter.write_str(message),
            Self::TimedOut(operation) => write!(formatter, "timed out {operation}"),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UploadLeaseOwner {
    WebSocket(TransferOwnerKey),
    Ipc(u32),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UploadPathLease {
    key: String,
    pub final_path: String,
    pub part_path: String,
    owner: UploadLeaseOwner,
    nonce: uuid::Uuid,
}

#[derive(Clone, Debug)]
struct UploadLeaseRecord {
    lease: UploadPathLease,
    phase: UploadPhase,
}

/// One destination path may have only one writer across the WebSocket and
/// desktop IPC transfer planes. The random nonce makes release compare-and-
/// remove safe even when a transfer ID is reused after an old task finishes.
pub struct UploadPathLeaseRegistry {
    leases: Mutex<HashMap<String, UploadLeaseRecord>>,
}

impl UploadPathLeaseRegistry {
    pub fn new() -> Self {
        Self {
            leases: Mutex::new(HashMap::new()),
        }
    }

    pub fn acquire(&self, path: &str, owner: UploadLeaseOwner) -> Result<UploadPathLease, String> {
        let key = normalize_upload_path(path)?;
        let final_path = path.to_string();
        let part_path = format!("{path}.meterm.part");
        let mut leases = self.leases.lock().unwrap();
        if leases.len() >= MAX_UPLOAD_LEASES_PER_SESSION {
            return Err("session upload limit reached".to_string());
        }
        if let UploadLeaseOwner::WebSocket(owner_key) = &owner {
            let owned = leases
                .values()
                .filter(|record| {
                    matches!(
                        &record.lease.owner,
                        UploadLeaseOwner::WebSocket(existing) if existing.0 == owner_key.0
                    )
                })
                .count();
            if owned >= MAX_UPLOAD_LEASES_PER_CLIENT {
                return Err("client upload limit reached".to_string());
            }
        }
        if leases.contains_key(&key) {
            return Err("upload destination is already active".to_string());
        }
        let lease = UploadPathLease {
            key: key.clone(),
            final_path,
            part_path,
            owner,
            nonce: uuid::Uuid::new_v4(),
        };
        leases.insert(
            key,
            UploadLeaseRecord {
                lease: lease.clone(),
                phase: UploadPhase::Active,
            },
        );
        Ok(lease)
    }

    pub fn mark_finalizing(&self, lease: &UploadPathLease) -> bool {
        let mut leases = self.leases.lock().unwrap();
        let Some(record) = leases.get_mut(&lease.key) else {
            return false;
        };
        if record.lease.nonce != lease.nonce
            || record.lease.owner != lease.owner
            || record.phase == UploadPhase::Poisoned
        {
            return false;
        }
        record.phase = UploadPhase::Finalizing;
        true
    }

    pub fn poison(&self, lease: &UploadPathLease) -> bool {
        let mut leases = self.leases.lock().unwrap();
        let Some(record) = leases.get_mut(&lease.key) else {
            return false;
        };
        if record.lease.nonce != lease.nonce || record.lease.owner != lease.owner {
            return false;
        }
        record.phase = UploadPhase::Poisoned;
        true
    }

    pub fn release(&self, lease: &UploadPathLease) -> bool {
        let mut leases = self.leases.lock().unwrap();
        let releasable = leases.get(&lease.key).is_some_and(|record| {
            record.phase != UploadPhase::Poisoned
                && record.lease.nonce == lease.nonce
                && record.lease.owner == lease.owner
        });
        if releasable {
            leases.remove(&lease.key);
        }
        releasable
    }

    #[cfg(test)]
    fn phase(&self, lease: &UploadPathLease) -> Option<UploadPhase> {
        self.leases
            .lock()
            .unwrap()
            .get(&lease.key)
            .filter(|record| record.lease.nonce == lease.nonce)
            .map(|record| record.phase)
    }
}

impl Default for UploadPathLeaseRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// Build a lexical lease key without changing the path used for filesystem I/O.
/// Unix absolute, Windows drive/UNC, and relative SFTP paths are all accepted.
pub fn normalize_upload_path(path: &str) -> Result<String, String> {
    if path.is_empty() {
        return Err("path is required".to_string());
    }
    if path.len() > 4096 {
        return Err("path is too long".to_string());
    }
    if path.as_bytes().contains(&0) {
        return Err("path contains NUL".to_string());
    }
    let slash_path = path.replace('\\', "/");
    let windows_drive = slash_path.len() >= 2
        && slash_path.as_bytes()[0].is_ascii_alphabetic()
        && slash_path.as_bytes()[1] == b':';
    let unc = slash_path.starts_with("//");
    let absolute = slash_path.starts_with('/') || windows_drive && slash_path[2..].starts_with('/');
    let (prefix, component_source) = if windows_drive {
        (
            format!("win:{}:", slash_path[..1].to_ascii_lowercase()),
            slash_path[2..].trim_start_matches('/'),
        )
    } else if unc {
        ("unc:".to_string(), slash_path.trim_start_matches('/'))
    } else if absolute {
        ("unix:/".to_string(), slash_path.trim_start_matches('/'))
    } else {
        ("relative:".to_string(), slash_path.as_str())
    };
    let mut components = Vec::new();
    for component in component_source.split('/') {
        match component {
            "" | "." => {}
            // A lexical key cannot safely prove what `..` means when an
            // ancestor is a symlink on a remote SFTP filesystem. Reject it
            // instead of allowing two spellings to lease the same target.
            ".." => return Err("parent path components are not allowed".to_string()),
            value => components.push(value),
        }
    }
    if components.is_empty() {
        return Err("path must name a file".to_string());
    }
    let mut key = format!("{prefix}{}", components.join("/"));
    if windows_drive || unc {
        key.make_ascii_lowercase();
    }
    Ok(key)
}

fn backup_path(final_path: &str) -> String {
    format!("{final_path}.meterm.backup-{}", uuid::Uuid::new_v4())
}

/// Replace a local destination without deleting the old file on a generic
/// rename failure. Unix normally succeeds on the first atomic rename; the
/// backup transaction provides equivalent no-delete behavior on platforms
/// where replacing an existing destination is not supported directly.
pub async fn finalize_local_upload(part_path: &str, final_path: &str) -> Result<(), String> {
    match tokio::fs::rename(part_path, final_path).await {
        Ok(()) => return Ok(()),
        Err(first_error) => {
            match tokio::fs::symlink_metadata(final_path).await {
                Ok(metadata)
                    if metadata.file_type().is_file() || metadata.file_type().is_symlink() => {}
                Ok(_) => return Err("existing upload target is not a file".to_string()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(format!("rename target file: {first_error}"));
                }
                Err(error) => return Err(format!("inspect target file: {error}")),
            }

            let backup = backup_path(final_path);
            tokio::fs::rename(final_path, &backup)
                .await
                .map_err(|error| format!("preserve existing target: {error}"))?;
            match tokio::fs::rename(part_path, final_path).await {
                Ok(()) => {
                    if let Err(error) = tokio::fs::remove_file(&backup).await {
                        eprintln!(
                            "[upload] committed target but could not remove backup {}: {}",
                            backup, error
                        );
                    }
                    Ok(())
                }
                Err(error) => {
                    let restore = tokio::fs::rename(&backup, final_path).await;
                    Err(match restore {
                        Ok(()) => format!("rename target file: {error}"),
                        Err(restore_error) => format!(
                            "rename target file: {error}; original preserved at {backup}, restore failed: {restore_error}"
                        ),
                    })
                }
            }
        }
    }
}

pub async fn finalize_sftp_upload(
    sftp: &std::sync::Arc<russh_sftp::client::SftpSession>,
    part_path: &str,
    final_path: &str,
) -> Result<(), String> {
    if sftp
        .rename(part_path.to_string(), final_path.to_string())
        .await
        .is_ok()
    {
        return Ok(());
    }
    let metadata = sftp
        .symlink_metadata(final_path.to_string())
        .await
        .map_err(|error| format!("rename remote file: {error}"))?;
    if !metadata.is_regular() && !metadata.is_symlink() {
        return Err("existing remote upload target is not a file".to_string());
    }

    let backup = backup_path(final_path);
    sftp.rename(final_path.to_string(), backup.clone())
        .await
        .map_err(|error| format!("preserve existing remote target: {error}"))?;
    match sftp
        .rename(part_path.to_string(), final_path.to_string())
        .await
    {
        Ok(()) => {
            if let Err(error) = sftp.remove_file(backup.clone()).await {
                eprintln!(
                    "[upload] committed remote target but could not remove backup {}: {}",
                    backup, error
                );
            }
            Ok(())
        }
        Err(error) => {
            let restore = sftp.rename(backup.clone(), final_path.to_string()).await;
            Err(match restore {
                Ok(()) => format!("rename remote file: {error}"),
                Err(restore_error) => format!(
                    "rename remote file: {error}; original preserved at {backup}, restore failed: {restore_error}"
                ),
            })
        }
    }
}

pub fn finalize_ssh2_upload(
    sftp: &ssh2::Sftp,
    part_path: &str,
    final_path: &str,
) -> Result<(), String> {
    if sftp
        .rename(Path::new(part_path), Path::new(final_path), None)
        .is_ok()
    {
        return Ok(());
    }
    let metadata = sftp
        .lstat(Path::new(final_path))
        .map_err(|error| format!("rename remote file: {error}"))?;
    if !metadata.file_type().is_file() && !metadata.file_type().is_symlink() {
        return Err("existing remote upload target is not a file".to_string());
    }

    let backup = backup_path(final_path);
    sftp.rename(Path::new(final_path), Path::new(&backup), None)
        .map_err(|error| format!("preserve existing remote target: {error}"))?;
    match sftp.rename(Path::new(part_path), Path::new(final_path), None) {
        Ok(()) => {
            if let Err(error) = sftp.unlink(Path::new(&backup)) {
                eprintln!(
                    "[upload] committed remote target but could not remove backup {}: {}",
                    backup, error
                );
            }
            Ok(())
        }
        Err(error) => {
            let restore = sftp.rename(Path::new(&backup), Path::new(final_path), None);
            Err(match restore {
                Ok(()) => format!("rename remote file: {error}"),
                Err(restore_error) => format!(
                    "rename remote file: {error}; original preserved at {backup}, restore failed: {restore_error}"
                ),
            })
        }
    }
}

pub async fn drain_pending_upload_writes(
    pending: Vec<russh_sftp::client::PendingWrite>,
) -> Result<(), UploadSettleError> {
    tokio::time::timeout(UPLOAD_DRAIN_TIMEOUT, async move {
        let mut first_error = None;
        for write in pending {
            if let Err(error) = write.wait().await {
                if first_error.is_none() {
                    first_error = Some(error.to_string());
                }
            }
        }
        first_error.map_or(Ok(()), |message| Err(UploadSettleError::Failed(message)))
    })
    .await
    .map_err(|_| UploadSettleError::TimedOut("draining pending upload writes"))?
}

pub async fn wait_pending_upload_write(
    write: russh_sftp::client::PendingWrite,
) -> Result<(), UploadSettleError> {
    tokio::time::timeout(UPLOAD_DRAIN_TIMEOUT, write.wait())
        .await
        .map_err(|_| UploadSettleError::TimedOut("waiting for an upload write"))?
        .map(|_| ())
        .map_err(|error| UploadSettleError::Failed(error.to_string()))
}

pub async fn close_sftp_upload_file(
    file: Option<russh_sftp::client::fs::File>,
) -> Result<(), UploadSettleError> {
    if let Some(mut file) = file {
        tokio::time::timeout(UPLOAD_CLOSE_TIMEOUT, file.shutdown())
            .await
            .map_err(|_| UploadSettleError::TimedOut("closing remote upload file"))?
            .map_err(|error| UploadSettleError::Failed(error.to_string()))?;
    }
    Ok(())
}

impl Session {
    pub(crate) async fn retire_upload_state(&self, mut state: UploadState) -> Result<(), String> {
        let pending_result =
            drain_pending_upload_writes(std::mem::take(&mut state.pending_writes)).await;
        let close_result = close_sftp_upload_file(state.sftp_file.take()).await;
        drop(state.local_file.take());
        let timed_out = pending_result
            .as_ref()
            .err()
            .is_some_and(UploadSettleError::is_timeout)
            || close_result
                .as_ref()
                .err()
                .is_some_and(UploadSettleError::is_timeout);
        if timed_out {
            // Dropping a timed-out SFTP request future does not prove that the
            // server stopped processing it. A later completion could corrupt a
            // new transfer using the fixed `.meterm.part` path.
            self.upload_path_leases.poison(&state.lease);
        } else {
            self.upload_path_leases.release(&state.lease);
        }

        let errors = [pending_result.err(), close_result.err()]
            .into_iter()
            .flatten()
            .map(|error| error.to_string())
            .collect::<Vec<_>>();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    async fn cleanup_ws_uploads_matching(
        &self,
        predicate: impl Fn(&TransferOwnerKey) -> bool,
    ) -> usize {
        let retired = {
            let mut uploads = self.active_uploads.lock().await;
            let keys: Vec<_> = uploads
                .iter()
                .filter(|(key, state)| predicate(key) && state.phase == UploadPhase::Active)
                .map(|(key, _)| key.clone())
                .collect();
            keys.into_iter()
                .filter_map(|key| uploads.remove(&key))
                .collect::<Vec<_>>()
        };
        let count = retired.len();
        for state in retired {
            let _ = self.retire_upload_state(state).await;
        }
        count
    }

    pub(crate) async fn cleanup_ws_uploads_for_connection(
        &self,
        client_id: &str,
        conn_gen: u64,
    ) -> usize {
        self.cleanup_ws_uploads_matching(|key| key.0 == client_id && key.1 == conn_gen)
            .await
    }

    pub(crate) async fn cleanup_stale_ws_uploads(
        &self,
        client_id: &str,
        current_conn_gen: u64,
    ) -> usize {
        self.cleanup_ws_uploads_matching(|key| key.0 == client_id && key.1 != current_conn_gen)
            .await
    }
}

/// An active upload session.
pub struct UploadSession {
    pub id: u64,
    pub path: String,
    pub total_size: u64,
    pub received: u64,
    pub temp_path: String,
}

/// An active download session.
pub struct DownloadSession {
    pub id: u64,
    pub path: String,
    pub offset: u64,
    pub cancel: CancellationToken,
}

/// Manages active file transfers for a session.
pub struct TransferManager {
    uploads: Mutex<HashMap<u64, UploadSession>>,
    downloads: Mutex<HashMap<u64, DownloadSession>>,
    next_id: Mutex<u64>,
}

impl TransferManager {
    pub fn new() -> Self {
        Self {
            uploads: Mutex::new(HashMap::new()),
            downloads: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }

    fn next_id(&self) -> u64 {
        let mut id = self.next_id.lock().unwrap();
        let current = *id;
        *id += 1;
        current
    }

    /// Create a new upload session.
    pub fn create_upload(&self, path: String, total_size: u64, temp_path: String) -> u64 {
        let id = self.next_id();
        let session = UploadSession {
            id,
            path,
            total_size,
            received: 0,
            temp_path,
        };
        self.uploads.lock().unwrap().insert(id, session);
        id
    }

    /// Get a mutable reference to an upload session.
    pub fn get_upload(&self, id: u64) -> Option<u64> {
        self.uploads.lock().unwrap().get(&id).map(|s| s.received)
    }

    /// Update upload progress.
    pub fn update_upload(&self, id: u64, received: u64) {
        if let Some(session) = self.uploads.lock().unwrap().get_mut(&id) {
            session.received = received;
        }
    }

    /// Complete and remove an upload session.
    pub fn complete_upload(&self, id: u64) -> Option<UploadSession> {
        self.uploads.lock().unwrap().remove(&id)
    }

    /// Create a new download session.
    pub fn create_download(&self, path: String, offset: u64) -> (u64, CancellationToken) {
        let id = self.next_id();
        let cancel = CancellationToken::new();
        let session = DownloadSession {
            id,
            path,
            offset,
            cancel: cancel.clone(),
        };
        self.downloads.lock().unwrap().insert(id, session);
        (id, cancel)
    }

    /// Cancel a download.
    pub fn cancel_download(&self, id: u64) {
        if let Some(session) = self.downloads.lock().unwrap().remove(&id) {
            session.cancel.cancel();
        }
    }

    /// Cancel all active transfers.
    pub fn cancel_all(&self) {
        self.uploads.lock().unwrap().clear();
        let downloads: Vec<_> = self.downloads.lock().unwrap().drain().collect();
        for (_, session) in downloads {
            session.cancel.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::events::EventBus;
    use crate::server::session::{AdaptivePipeline, SessionConfig};
    use std::path::PathBuf;
    use std::sync::Arc;

    fn owner(client: &str, generation: u64, transfer_id: u32) -> UploadLeaseOwner {
        UploadLeaseOwner::WebSocket((client.to_string(), generation, transfer_id))
    }

    fn test_session(id: &str) -> Arc<Session> {
        Arc::new(Session::new(
            id.to_string(),
            SessionConfig {
                session_ttl: Duration::from_secs(300),
                reconnect_grace: Duration::from_secs(60),
                ring_buffer_size: 4096,
                log_dir: String::new(),
            },
            EventBus::new(),
        ))
    }

    fn empty_state(lease: UploadPathLease, phase: UploadPhase) -> UploadState {
        UploadState {
            path: lease.final_path.clone(),
            part_path: lease.part_path.clone(),
            total_size: 10,
            received: 0,
            lease,
            phase,
            sftp_file: None,
            local_file: None,
            pending_writes: Vec::new(),
            pipeline: AdaptivePipeline::new(),
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("meterm-upload-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn upload_path_keys_cover_unix_windows_unc_and_relative_paths() {
        assert_eq!(
            normalize_upload_path("/srv/a/./b").unwrap(),
            "unix:/srv/a/b"
        );
        assert_eq!(
            normalize_upload_path(r"C:\Users\A\file").unwrap(),
            "win:c:users/a/file"
        );
        assert_eq!(
            normalize_upload_path("c:/users/a/file").unwrap(),
            "win:c:users/a/file"
        );
        assert_eq!(
            normalize_upload_path(r"\\Server\Share\Folder\File").unwrap(),
            "unc:server/share/folder/file"
        );
        assert_eq!(
            normalize_upload_path("folder/./child/file").unwrap(),
            "relative:folder/child/file"
        );
        assert!(normalize_upload_path("../folder/file").is_err());
        assert!(normalize_upload_path("/srv/../file").is_err());

        let registry = UploadPathLeaseRegistry::new();
        let raw = r"C:\Users\A\File";
        let lease = registry.acquire(raw, owner("phone", 1, 1)).unwrap();
        assert_eq!(lease.final_path, raw);
        assert_eq!(lease.part_path, format!("{raw}.meterm.part"));
    }

    #[test]
    fn leases_are_generation_safe_limited_and_poisonable() {
        let registry = UploadPathLeaseRegistry::new();
        let first = registry
            .acquire("/tmp/target", owner("phone", 1, 7))
            .unwrap();
        assert!(registry
            .acquire("/tmp/./target", owner("phone", 2, 8))
            .is_err());
        assert!(registry.release(&first));

        let replacement = registry
            .acquire("/tmp/target", owner("phone", 2, 8))
            .unwrap();
        assert!(!registry.release(&first));
        assert_eq!(registry.phase(&replacement), Some(UploadPhase::Active));
        assert!(registry.poison(&replacement));
        assert_eq!(registry.phase(&replacement), Some(UploadPhase::Poisoned));
        assert!(!registry.release(&replacement));
        assert!(registry
            .acquire("/tmp/target", owner("other", 1, 1))
            .is_err());

        let limited = UploadPathLeaseRegistry::new();
        let mut leases = Vec::new();
        for id in 1..=MAX_UPLOAD_LEASES_PER_CLIENT as u32 {
            leases.push(
                limited
                    .acquire(&format!("/tmp/client-{id}"), owner("phone", 1, id))
                    .unwrap(),
            );
        }
        assert!(limited
            .acquire("/tmp/client-over-limit", owner("phone", 2, 99))
            .unwrap_err()
            .contains("client upload limit"));
        assert!(limited
            .acquire("/tmp/other-client", owner("other", 1, 1))
            .is_ok());
    }

    #[tokio::test]
    async fn exact_generation_cleanup_retires_only_active_owner_states() {
        let session = test_session("upload-generation-cleanup");
        let h0_key = ("phone".to_string(), 10, 1);
        let h1_key = ("phone".to_string(), 11, 1);
        let finalizing_key = ("phone".to_string(), 10, 2);
        let h0_lease = session
            .upload_path_leases
            .acquire("/tmp/h0", UploadLeaseOwner::WebSocket(h0_key.clone()))
            .unwrap();
        let h1_lease = session
            .upload_path_leases
            .acquire("/tmp/h1", UploadLeaseOwner::WebSocket(h1_key.clone()))
            .unwrap();
        let finalizing_lease = session
            .upload_path_leases
            .acquire(
                "/tmp/finalizing",
                UploadLeaseOwner::WebSocket(finalizing_key.clone()),
            )
            .unwrap();
        assert!(session
            .upload_path_leases
            .mark_finalizing(&finalizing_lease));

        {
            let mut uploads = session.active_uploads.lock().await;
            uploads.insert(h0_key, empty_state(h0_lease.clone(), UploadPhase::Active));
            uploads.insert(h1_key, empty_state(h1_lease.clone(), UploadPhase::Active));
            uploads.insert(
                finalizing_key,
                empty_state(finalizing_lease.clone(), UploadPhase::Finalizing),
            );
        }

        assert_eq!(
            session.cleanup_ws_uploads_for_connection("phone", 10).await,
            1
        );
        let uploads = session.active_uploads.lock().await;
        assert_eq!(uploads.len(), 2);
        assert!(uploads.keys().any(|key| key.1 == 11));
        assert!(uploads
            .values()
            .any(|state| state.phase == UploadPhase::Finalizing));
        drop(uploads);

        let reacquired = session
            .upload_path_leases
            .acquire("/tmp/h0", owner("phone", 12, 3))
            .unwrap();
        assert!(session
            .upload_path_leases
            .acquire("/tmp/h1", owner("phone", 12, 4))
            .is_err());
        assert!(session
            .upload_path_leases
            .acquire("/tmp/finalizing", owner("phone", 12, 5))
            .is_err());
        assert!(session.upload_path_leases.release(&reacquired));
        assert!(session.upload_path_leases.release(&h1_lease));
        assert!(session.upload_path_leases.release(&finalizing_lease));
    }

    #[tokio::test]
    async fn local_finalize_preserves_old_target_on_failure() {
        let directory = temp_dir("preserve");
        let final_path = directory.join("target");
        let missing_part = directory.join("missing.part");
        tokio::fs::write(&final_path, b"old").await.unwrap();

        let error =
            finalize_local_upload(missing_part.to_str().unwrap(), final_path.to_str().unwrap())
                .await
                .unwrap_err();
        assert!(error.contains("rename target file"));
        assert_eq!(tokio::fs::read(&final_path).await.unwrap(), b"old");

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn local_finalize_replaces_files_but_rejects_directories() {
        let directory = temp_dir("replace");
        let final_path = directory.join("target");
        let part_path = directory.join("target.part");
        tokio::fs::write(&final_path, b"old").await.unwrap();
        tokio::fs::write(&part_path, b"new").await.unwrap();
        finalize_local_upload(part_path.to_str().unwrap(), final_path.to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(tokio::fs::read(&final_path).await.unwrap(), b"new");

        let directory_target = directory.join("existing-directory");
        let directory_part = directory.join("directory.part");
        tokio::fs::create_dir(&directory_target).await.unwrap();
        tokio::fs::write(&directory_part, b"payload").await.unwrap();
        let error = finalize_local_upload(
            directory_part.to_str().unwrap(),
            directory_target.to_str().unwrap(),
        )
        .await
        .unwrap_err();
        assert!(error.contains("not a file"));
        assert!(tokio::fs::metadata(&directory_target)
            .await
            .unwrap()
            .is_dir());
        assert_eq!(tokio::fs::read(&directory_part).await.unwrap(), b"payload");

        let _ = tokio::fs::remove_dir_all(directory).await;
    }
}
