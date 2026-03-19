//! File operation handlers — mirrors Go `api/file_handler.go`.
//!
//! Handles file listing, upload, download, and operations (mkdir/rm/mv/touch/stat)
//! through the WebSocket binary protocol.

use serde::{Deserialize, Serialize};

use super::protocol;

// ---------------------------------------------------------------------------
// Data types (match Go protocol/file_messages.go)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub name: String,
    pub size: i64,
    pub mode: String,
    pub mtime: i64,
    pub is_dir: bool,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub is_link: bool,
}

#[derive(Debug, Deserialize)]
pub struct FileListRequest {
    pub path: String,
    #[serde(default)]
    pub show_hidden: bool,
}

#[derive(Debug, Serialize)]
pub struct FileListResponse {
    pub path: String,
    pub files: Vec<FileInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct FileListProgressResponse {
    pub path: String,
    pub count: usize,
    pub done: bool,
}

#[derive(Debug, Deserialize)]
pub struct FileOperationRequest {
    pub operation: String, // "delete", "rename", "mkdir", "touch"
    pub path: String,
    #[serde(default)]
    pub new_path: String, // for rename
}

#[derive(Debug, Serialize)]
pub struct FileOperationResponse {
    pub success: bool,  // Go uses "success" not "ok"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stat: Option<FileInfo>,
}

// ---------------------------------------------------------------------------
// Local file operations (for local PTY sessions)
// ---------------------------------------------------------------------------

/// Handle MsgFileList — list directory contents.
pub fn handle_file_list(payload: &[u8]) -> Vec<u8> {
    let req: FileListRequest = match serde_json::from_slice(payload) {
        Ok(r) => r,
        Err(e) => {
            let resp = FileListResponse {
                path: String::new(),
                files: Vec::new(),
                error: Some(e.to_string()),
            };
            let data = serde_json::to_vec(&resp).unwrap_or_default();
            return protocol::encode_message(protocol::MSG_FILE_LIST_RESP, &data);
        }
    };

    let path = std::path::Path::new(&req.path);
    let mut files = Vec::new();
    let mut error = None;

    match std::fs::read_dir(path) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();

                // Skip hidden files unless requested
                if !req.show_hidden && name.starts_with('.') {
                    continue;
                }

                if let Ok(meta) = entry.metadata() {
                    files.push(FileInfo {
                        name,
                        size: meta.len() as i64,
                        mode: format_mode(&meta),
                        mtime: meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() as i64)
                            .unwrap_or(0),
                        is_dir: meta.is_dir(),
                        owner: String::new(),
                        group: String::new(),
                        is_link: meta.file_type().is_symlink(),
                    });
                }
            }
        }
        Err(e) => {
            error = Some(e.to_string());
        }
    }

    let resp = FileListResponse {
        path: req.path,
        files,
        error,
    };
    let data = serde_json::to_vec(&resp).unwrap_or_default();
    protocol::encode_message(protocol::MSG_FILE_LIST_RESP, &data)
}

/// Handle MsgFileOperation — mkdir, rm, mv, touch, stat.
pub fn handle_file_operation(payload: &[u8]) -> Vec<u8> {
    let req: FileOperationRequest = match serde_json::from_slice(payload) {
        Ok(r) => r,
        Err(e) => {
            return encode_file_op_error(&e.to_string());
        }
    };

    let result = match req.operation.as_str() {
        "mkdir" => {
            std::fs::create_dir_all(&req.path).map(|_| None)
        }
        "delete" => {
            let path = std::path::Path::new(&req.path);
            if path.is_dir() {
                std::fs::remove_dir_all(&req.path).map(|_| None)
            } else {
                std::fs::remove_file(&req.path).map(|_| None)
            }
        }
        "rename" => std::fs::rename(&req.path, &req.new_path).map(|_| None),
        "touch" => {
            if std::path::Path::new(&req.path).exists() {
                let _ = filetime::set_file_mtime(
                    &req.path,
                    filetime::FileTime::now(),
                );
                Ok(None)
            } else {
                std::fs::File::create(&req.path).map(|_| None)
            }
        }
        "stat" => {
            // Go returns {success, operation, exists, is_dir, size} for stat
            return match std::fs::metadata(&req.path) {
                Ok(meta) => {
                    let resp = serde_json::json!({
                        "success": true, "operation": "stat",
                        "exists": true, "is_dir": meta.is_dir(), "size": meta.len(),
                    });
                    let data = serde_json::to_vec(&resp).unwrap_or_default();
                    protocol::encode_message(protocol::MSG_FILE_OPERATION_RESP, &data)
                }
                Err(_) => encode_msg_error("NOT_FOUND", "File not found"),
            };
        }
        _ => {
            return encode_file_op_error(&format!("unknown operation: {}", req.operation));
        }
    };

    match result {
        Ok(stat) => {
            let resp = FileOperationResponse {
                success: true,
                error: None,
                operation: Some(req.operation),
                stat,
            };
            let data = serde_json::to_vec(&resp).unwrap_or_default();
            protocol::encode_message(protocol::MSG_FILE_OPERATION_RESP, &data)
        }
        Err(e) => encode_file_op_error(&e.to_string()),
    }
}

/// Handle MsgFileReadRequest — read file content.
pub fn handle_file_read(payload: &[u8]) -> Vec<u8> {
    // payload: [pathLen:4B BE][path UTF-8]
    if payload.len() < 4 {
        return protocol::encode_error(protocol::ERR_INTERNAL, "invalid file read request");
    }
    let path_len = u32::from_be_bytes(payload[0..4].try_into().unwrap_or([0; 4])) as usize;
    if payload.len() < 4 + path_len {
        return protocol::encode_error(protocol::ERR_INTERNAL, "truncated path");
    }
    let path = String::from_utf8_lossy(&payload[4..4 + path_len]).to_string();

    match std::fs::read(&path) {
        Ok(content) => {
            let size = content.len() as u64;
            let mut resp = Vec::with_capacity(1 + 8 + content.len());
            resp.push(protocol::MSG_FILE_READ_RESPONSE);
            resp.extend_from_slice(&size.to_be_bytes());
            resp.extend_from_slice(&content);
            resp
        }
        Err(e) => protocol::encode_error(protocol::ERR_INTERNAL, &e.to_string()),
    }
}

/// Handle MsgFileSaveRequest — save file content.
pub fn handle_file_save(payload: &[u8]) -> Vec<u8> {
    // payload: [pathLen:4B BE][path UTF-8][content]
    if payload.len() < 4 {
        return protocol::encode_error(protocol::ERR_INTERNAL, "invalid file save request");
    }
    let path_len = u32::from_be_bytes(payload[0..4].try_into().unwrap_or([0; 4])) as usize;
    if payload.len() < 4 + path_len {
        return protocol::encode_error(protocol::ERR_INTERNAL, "truncated path");
    }
    let path = String::from_utf8_lossy(&payload[4..4 + path_len]).to_string();
    let content = &payload[4 + path_len..];

    match std::fs::write(&path, content) {
        Ok(()) => {
            let resp = FileOperationResponse {
                success: true,
                error: None,
                operation: Some("save".to_string()),
                stat: None,
            };
            let data = serde_json::to_vec(&resp).unwrap_or_default();
            protocol::encode_message(protocol::MSG_FILE_OPERATION_RESP, &data)
        }
        Err(e) => protocol::encode_error(protocol::ERR_INTERNAL, &e.to_string()),
    }
}

fn encode_file_op_error(msg: &str) -> Vec<u8> {
    let resp = FileOperationResponse {
        success: false,
        error: Some(msg.to_string()),
        operation: None,
        stat: None,
    };
    let data = serde_json::to_vec(&resp).unwrap_or_default();
    protocol::encode_message(protocol::MSG_FILE_OPERATION_RESP, &data)
}

#[cfg(unix)]
fn format_mode(meta: &std::fs::Metadata) -> String {
    use std::os::unix::fs::PermissionsExt;
    format!("{:o}", meta.permissions().mode() & 0o7777)
}

#[cfg(not(unix))]
fn format_mode(meta: &std::fs::Metadata) -> String {
    if meta.permissions().readonly() {
        "0444".to_string()
    } else {
        "0644".to_string()
    }
}

// ---------------------------------------------------------------------------
// SFTP file operations (for SSH sessions)
// ---------------------------------------------------------------------------

use russh_sftp::client::SftpSession;

/// Handle MsgFileList via SFTP.
pub async fn handle_sftp_file_list(payload: &[u8], sftp: &SftpSession) -> Vec<u8> {
    let req: FileListRequest = match serde_json::from_slice(payload) {
        Ok(r) => r,
        Err(e) => {
            let resp = FileListResponse { path: String::new(), files: Vec::new(), error: Some(e.to_string()) };
            let data = serde_json::to_vec(&resp).unwrap_or_default();
            return protocol::encode_message(protocol::MSG_FILE_LIST_RESP, &data);
        }
    };

    let mut files = Vec::new();
    let mut error = None;

    match sftp.read_dir(req.path.clone()).await {
        Ok(read_dir) => {
            for entry in read_dir {
                let name = entry.file_name();
                if !req.show_hidden && name.starts_with('.') {
                    continue;
                }
                let attrs = entry.metadata();
                files.push(FileInfo {
                    name,
                    size: attrs.size.unwrap_or(0) as i64,
                    mode: format!("{:o}", attrs.permissions.unwrap_or(0) & 0o7777),
                    mtime: attrs.mtime.unwrap_or(0) as i64,
                    is_dir: attrs.is_dir(),
                    owner: attrs.uid.map(|u| u.to_string()).unwrap_or_else(|| attrs.user.clone().unwrap_or_default()),
                    group: attrs.gid.map(|g| g.to_string()).unwrap_or_else(|| attrs.group.clone().unwrap_or_default()),
                    is_link: attrs.is_symlink(),
                });
            }
        }
        Err(e) => {
            error = Some(format!("{}", e));
        }
    }

    let resp = FileListResponse { path: req.path, files, error };
    let data = serde_json::to_vec(&resp).unwrap_or_default();
    protocol::encode_message(protocol::MSG_FILE_LIST_RESP, &data)
}

/// Handle MsgFileList via SFTP with progress notifications for large directories.
/// Matches Go handleFileListWithProgress: sends MsgFileListProgress every 200 entries.
pub async fn handle_sftp_file_list_with_progress(
    payload: &[u8],
    sftp: &SftpSession,
    session: &super::session::Session,
    client_id: &str,
) {
    let req: FileListRequest = match serde_json::from_slice(payload) {
        Ok(r) => r,
        Err(e) => {
            let resp = FileListResponse { path: String::new(), files: Vec::new(), error: Some(e.to_string()) };
            let data = serde_json::to_vec(&resp).unwrap_or_default();
            session.send_to_client(client_id, protocol::encode_message(protocol::MSG_FILE_LIST_RESP, &data));
            return;
        }
    };

    let mut files = Vec::new();
    let mut error = None;

    match sftp.read_dir(req.path.clone()).await {
        Ok(read_dir) => {
            let entries: Vec<_> = read_dir.into_iter().collect();
            let total = entries.len();
            const MAX_ENTRIES: usize = 50000;
            const LARGE_THRESHOLD: usize = 100;
            const BATCH_SIZE: usize = 200;

            if total > MAX_ENTRIES {
                let err = serde_json::json!({"code": "TOO_MANY_FILES", "message": format!("Directory has {} entries (limit {})", total, MAX_ENTRIES)});
                session.send_to_client(client_id, protocol::encode_message(protocol::MSG_ERROR, serde_json::to_vec(&err).unwrap_or_default().as_slice()));
                return;
            }

            let is_large = total >= LARGE_THRESHOLD;
            if is_large {
                // Send initial progress
                let progress = serde_json::json!({"loaded": 0, "total": total});
                session.send_to_client(client_id, protocol::encode_message(protocol::MSG_FILE_LIST_PROGRESS, serde_json::to_vec(&progress).unwrap_or_default().as_slice()));
            }

            for (i, entry) in entries.into_iter().enumerate() {
                let name = entry.file_name();
                if !req.show_hidden && name.starts_with('.') { continue; }
                let attrs = entry.metadata();
                files.push(FileInfo {
                    name,
                    size: attrs.size.unwrap_or(0) as i64,
                    mode: format!("{:o}", attrs.permissions.unwrap_or(0) & 0o7777),
                    mtime: attrs.mtime.unwrap_or(0) as i64,
                    is_dir: attrs.is_dir(),
                    owner: attrs.uid.map(|u| u.to_string()).unwrap_or_else(|| attrs.user.clone().unwrap_or_default()),
                    group: attrs.gid.map(|g| g.to_string()).unwrap_or_else(|| attrs.group.clone().unwrap_or_default()),
                    is_link: attrs.is_symlink(),
                });

                if is_large && ((i + 1) % BATCH_SIZE == 0 || i == total - 1) {
                    let progress = serde_json::json!({"loaded": i + 1, "total": total});
                    session.send_to_client(client_id, protocol::encode_message(protocol::MSG_FILE_LIST_PROGRESS, serde_json::to_vec(&progress).unwrap_or_default().as_slice()));
                }
            }
        }
        Err(e) => { error = Some(format!("{}", e)); }
    }

    let resp = FileListResponse { path: req.path, files, error };
    let data = serde_json::to_vec(&resp).unwrap_or_default();
    session.send_to_client(client_id, protocol::encode_message(protocol::MSG_FILE_LIST_RESP, &data));
}

/// Handle MsgFileOperation via SFTP.
pub async fn handle_sftp_file_operation(payload: &[u8], sftp: &SftpSession) -> Vec<u8> {
    let req: FileOperationRequest = match serde_json::from_slice(payload) {
        Ok(r) => r,
        Err(e) => return encode_file_op_error(&e.to_string()),
    };

    let result: Result<Option<FileInfo>, String> = match req.operation.as_str() {
        "mkdir" => {
            sftp.create_dir(req.path.clone()).await.map(|_| None).map_err(|e| format!("{}", e))
        }
        "delete" => {
            match sftp.remove_file(req.path.clone()).await {
                Ok(()) => Ok(None),
                Err(_) => sftp.remove_dir(req.path.clone()).await.map(|_| None).map_err(|e| format!("{}", e)),
            }
        }
        "rename" => {
            sftp.rename(req.path.clone(), req.new_path.clone()).await.map(|_| None).map_err(|e| format!("{}", e))
        }
        "stat" => {
            return match sftp.metadata(req.path.clone()).await {
                Ok(attrs) => {
                    let resp = serde_json::json!({
                        "success": true, "operation": "stat",
                        "exists": true, "is_dir": attrs.is_dir(),
                        "size": attrs.size.unwrap_or(0),
                    });
                    let data = serde_json::to_vec(&resp).unwrap_or_default();
                    protocol::encode_message(protocol::MSG_FILE_OPERATION_RESP, &data)
                }
                Err(_) => encode_msg_error("NOT_FOUND", "File not found"),
            };
        }
        _ => Err(format!("unsupported operation: {}", req.operation)),
    };

    match result {
        Ok(stat) => {
            let resp = FileOperationResponse { success: true, error: None, operation: None, stat };
            let data = serde_json::to_vec(&resp).unwrap_or_default();
            protocol::encode_message(protocol::MSG_FILE_OPERATION_RESP, &data)
        }
        Err(e) => encode_file_op_error(&e),
    }
}

/// Encode an error response as MsgError + JSON {code, message} (matches Go writeErr pattern).
fn encode_msg_error(code: &str, message: &str) -> Vec<u8> {
    let err = serde_json::json!({"code": code, "message": message});
    protocol::encode_message(protocol::MSG_ERROR, serde_json::to_vec(&err).unwrap_or_default().as_slice())
}

/// Handle MsgFileReadRequest via SFTP.
/// Request: JSON { "path": "..." }
/// Response: MsgFileReadResponse + [8B size BE][content]
pub async fn handle_sftp_file_read(payload: &[u8], sftp: &SftpSession) -> Vec<u8> {
    // Parse JSON request
    let path = match serde_json::from_slice::<serde_json::Value>(payload) {
        Ok(v) => v.get("path").and_then(|p| p.as_str()).unwrap_or("").to_string(),
        Err(e) => return encode_msg_error("INVALID_REQUEST", &format!("parse: {}", e)),
    };
    if path.is_empty() {
        return encode_msg_error("INVALID_REQUEST", "path is required");
    }

    // Check file info (size limit, not directory)
    match sftp.metadata(path.clone()).await {
        Ok(attrs) => {
            if attrs.is_dir() {
                return encode_msg_error("IS_DIRECTORY", "Cannot open a directory in editor");
            }
            let size = attrs.size.unwrap_or(0);
            if size > 50 * 1024 * 1024 {
                return encode_msg_error("FILE_TOO_LARGE", &format!("File size {} exceeds 50MB limit", size));
            }
        }
        Err(e) => return encode_msg_error("NOT_FOUND", &format!("File not found: {}", e)),
    }

    // Read file content
    match sftp.open(path).await {
        Ok(mut file) => {
            use tokio::io::AsyncReadExt;
            let mut content = Vec::new();
            match file.read_to_end(&mut content).await {
                Ok(_) => {
                    // Response: MsgFileReadResponse + [8B size BE][content]
                    let size = content.len() as u64;
                    let mut resp = Vec::with_capacity(8 + content.len());
                    resp.extend_from_slice(&size.to_be_bytes());
                    resp.extend_from_slice(&content);
                    protocol::encode_message(protocol::MSG_FILE_READ_RESPONSE, &resp)
                }
                Err(e) => encode_msg_error("READ_FAILED", &format!("read: {}", e)),
            }
        }
        Err(e) => encode_msg_error("READ_FAILED", &format!("open: {}", e)),
    }
}

/// Handle MsgFileSaveRequest via SFTP.
/// Request: binary [4B pathLen BE][path UTF-8][content]
/// Response: MsgFileOperationResp JSON
pub async fn handle_sftp_file_save(payload: &[u8], sftp: &SftpSession) -> Vec<u8> {
    if payload.len() < 4 {
        return encode_msg_error("INVALID_REQUEST", "payload too short");
    }
    let path_len = u32::from_be_bytes(payload[0..4].try_into().unwrap_or([0; 4])) as usize;
    if path_len == 0 || payload.len() < 4 + path_len {
        return encode_msg_error("INVALID_REQUEST", "invalid path length");
    }
    let path = String::from_utf8_lossy(&payload[4..4 + path_len]).to_string();
    let content = &payload[4 + path_len..];

    // Atomic write: write to .meterm.edit.tmp, then rename
    let tmp_path = format!("{}.meterm.edit.tmp", path);
    match sftp.create(tmp_path.clone()).await {
        Ok(mut file) => {
            use tokio::io::AsyncWriteExt;
            if let Err(e) = file.write_all(content).await {
                let _ = sftp.remove_file(tmp_path).await;
                return encode_msg_error("WRITE_FAILED", &format!("write: {}", e));
            }
            drop(file);
            // Rename tmp → target (atomic)
            if let Err(_) = sftp.rename(tmp_path.clone(), path.clone()).await {
                // Fallback: remove target, then rename
                let _ = sftp.remove_file(path.clone()).await;
                if let Err(e) = sftp.rename(tmp_path.clone(), path).await {
                    return encode_msg_error("RENAME_FAILED", &format!("rename: {}", e));
                }
            }
            let resp = serde_json::json!({"success": true, "operation": "save"});
            protocol::encode_message(protocol::MSG_FILE_OPERATION_RESP, serde_json::to_vec(&resp).unwrap_or_default().as_slice())
        }
        Err(e) => encode_msg_error("WRITE_FAILED", &format!("create: {}", e)),
    }
}

/// Handle local MsgFileReadRequest (JSON format).
pub fn handle_file_read_json(payload: &[u8]) -> Vec<u8> {
    let path = match serde_json::from_slice::<serde_json::Value>(payload) {
        Ok(v) => v.get("path").and_then(|p| p.as_str()).unwrap_or("").to_string(),
        Err(e) => return encode_msg_error("INVALID_REQUEST", &format!("parse: {}", e)),
    };
    if path.is_empty() {
        return encode_msg_error("INVALID_REQUEST", "path is required");
    }

    match std::fs::read(&path) {
        Ok(content) => {
            let size = content.len() as u64;
            let mut resp = Vec::with_capacity(8 + content.len());
            resp.extend_from_slice(&size.to_be_bytes());
            resp.extend_from_slice(&content);
            protocol::encode_message(protocol::MSG_FILE_READ_RESPONSE, &resp)
        }
        Err(e) => encode_msg_error("READ_FAILED", &format!("{}", e)),
    }
}
