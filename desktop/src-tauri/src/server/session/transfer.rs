//! File transfer session management — mirrors Go `session/transfers.go`.
//!
//! Tracks active upload and download sessions per terminal session.

use std::collections::HashMap;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

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
