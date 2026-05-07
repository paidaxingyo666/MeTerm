//! File operation handlers — mirrors Go `api/file_handler.go`.
//!
//! Handles file listing, upload, download, and operations (mkdir/rm/mv/touch/stat)
//! through the WebSocket binary protocol.

use serde::{Deserialize, Serialize};

use super::protocol;

// ---------------------------------------------------------------------------
// SFTP auth-failure classification helpers
// ---------------------------------------------------------------------------

/// Classifies whether a russh-sftp / ssh error string indicates an authentication
/// failure. Uses specific multi-word phrases that russh/libssh2 emit to avoid
/// false positives on user-controlled paths (e.g., a file named "authentication
/// failed.txt" in an ENOENT error shouldn't trigger SFTP_AUTH_FAILED).
///
/// Known patterns:
/// - libssh2 "Session(-18): ..." (canonical auth-failure code)
/// - russh "all authentication methods failed" (NoAuthMethod)
/// - russh "no auth method available"
/// - "password authentication failed" / "keyboard-interactive authentication failed"
/// - libssh2 "authentication failed (publickey,password)" pattern
///
/// 注意：宽泛的 "authentication failed" / "auth failed" 已被移除，因为路径中包含这些
/// 词的 ENOENT 错误（如文件名含 "authentication failed"）会被误判为认证失败。
pub(crate) fn is_sftp_auth_error(err_msg: &str) -> bool {
    let lower = err_msg.to_ascii_lowercase();
    // libssh2 session 级认证错误（数字形式，极不可能出现在路径中）
    lower.contains("session(-18)")
        // russh: NoAuthMethod 的 Display 输出
        || lower.contains("all authentication methods failed")
        // russh: 另一种 NoAuthMethod 输出
        || lower.contains("no auth method available")
        // 精确组合短语——仅当 "authentication" 与具体机制词组合时才匹配
        || lower.contains("keyboard-interactive authentication failed")
        || lower.contains("password authentication failed")
        // libssh2 标准消息，括号内包含机制列表，不会是普通路径
        || lower.contains("authentication failed (publickey")
    // 注意：单独的 "permission denied"（文件级 EACCES）不是认证失败，不匹配
}

/// 若响应字节包含 SFTP 认证失败的错误信息，则将其替换为带有结构化
/// `SFTP_AUTH_FAILED` code 的 MSG_ERROR，以便前端透明刷新 JumpServer 凭据。
/// 对于格式异常或非认证错误的输入，直接原样返回。
///
/// 覆盖的 JSON 形状：
/// - `{ "error": "Authentication failed" }` — 文件列表/操作响应
/// - `{ "transferId": ..., "error": "..." }` — 上传/下载错误（MSG_ERROR）
/// - `{ "code": "...", "message": "...", "transferId": ... }` — SFTP 传输错误
pub(crate) fn maybe_upgrade_sftp_auth_error(resp: Vec<u8>) -> Vec<u8> {
    // 最短帧：1 字节 msg_type + 至少 1 字节 payload
    if resp.len() < 2 {
        return resp;
    }
    // protocol 帧格式：[msg_type: u8][payload...]
    let payload = &resp[1..];
    // 尝试解析 payload 为 JSON，递归查找 "error" 或 "message" 字符串字段
    let v: serde_json::Value = match serde_json::from_slice(payload) {
        Ok(v) => v,
        Err(_) => return resp,
    };
    let err_msg = match find_error_field(&v) {
        Some(s) => s,
        None => return resp,
    };
    if !is_sftp_auth_error(err_msg) {
        return resp;
    }
    // 替换为带结构化 code 的 MSG_ERROR
    let upgraded = serde_json::json!({
        "code": "SFTP_AUTH_FAILED",
        "message": err_msg,
    });
    protocol::encode_message(
        protocol::MSG_ERROR,
        serde_json::to_vec(&upgraded).unwrap_or_default().as_slice(),
    )
}

/// 递归搜索 JSON 中第一个字符串值的 `"error"` 字段。
/// 若未找到 `"error"` 字段，则回退查找 `"message"` 字段，以覆盖
/// `{ "code": "...", "message": "Authentication failed", "transferId": ... }`
/// 形状的 SFTP 传输错误。
fn find_error_field(v: &serde_json::Value) -> Option<&str> {
    match v {
        serde_json::Value::Object(map) => {
            // 优先检查本层的 "error" 字段
            if let Some(serde_json::Value::String(s)) = map.get("error") {
                return Some(s.as_str());
            }
            // 递归子节点
            for (_, child) in map {
                if let Some(s) = find_error_field(child) {
                    return Some(s);
                }
            }
            // 回退：检查本层 "message" 字段（用于 SFTP 传输错误形状）
            if let Some(serde_json::Value::String(s)) = map.get("message") {
                return Some(s.as_str());
            }
            None
        }
        serde_json::Value::Array(arr) => {
            for child in arr {
                if let Some(s) = find_error_field(child) {
                    return Some(s);
                }
            }
            None
        }
        _ => None,
    }
}

/// 向客户端发送 SFTP 错误响应，若错误内容表明认证失败则自动升级为
/// `SFTP_AUTH_FAILED` MSG_ERROR，以便前端透明刷新 JumpServer 凭据。
pub(crate) fn send_sftp_error(
    session: &super::session::Session,
    client_id: &str,
    resp: Vec<u8>,
) {
    let resp = maybe_upgrade_sftp_auth_error(resp);
    session.send_to_client(client_id, resp);
}

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
    /// 符号链接的目标路径(仅 is_link=true 时填充)。
    /// 注意:对于符号链接,is_dir 字段填的是 *解引用后* 的类型,以便上层
    /// (双击/列表/树)无需特殊处理就能正确把"指向目录的符号链接"当作目录访问。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_target: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct FileListRequest {
    pub path: String,
    #[serde(default)]
    pub show_hidden: bool,
    #[serde(default)]
    pub request_id: Option<String>,
    /// 软上限:返回的文件数超过该值时截断,并在响应里标记 truncated/total。
    /// 0 或缺省 = 不限制。前端默认传 5000,点"全部加载"时传 0。
    #[serde(default)]
    pub soft_limit: usize,
}

#[derive(Debug, Serialize)]
pub struct FileListResponse {
    pub path: String,
    pub files: Vec<FileInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// 是否被 soft_limit 截断
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated: bool,
    /// 截断前的总文件数(仅当 truncated=true 时有意义)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
}

fn is_false(b: &bool) -> bool { !*b }

#[derive(Debug, Serialize)]
pub struct FileListProgressResponse {
    pub path: String,
    pub count: usize,
    pub done: bool,
}

#[derive(Debug, Deserialize)]
pub struct FileOperationRequest {
    pub operation: String, // "delete", "rename", "mkdir", "touch", "chmod"
    pub path: String,
    #[serde(default)]
    pub new_path: String, // for rename
    #[serde(default)]
    pub mode: u32, // for chmod (octal permission bits)
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
                request_id: None,
                truncated: false,
                total: None,
            };
            let data = serde_json::to_vec(&resp).unwrap_or_default();
            return protocol::encode_message(protocol::MSG_FILE_LIST_RESP, &data);
        }
    };

    // Expand ~ to home directory for local file listing
    let resolved = if req.path == "~" || req.path.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
            if req.path == "~" {
                home.display().to_string()
            } else {
                format!("{}{}", home.display(), &req.path[1..])
            }
        } else {
            req.path.clone()
        }
    } else {
        req.path.clone()
    };
    let path = std::path::Path::new(&resolved);
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

                // entry.metadata() = symlink_metadata 语义,不解引用符号链接。
                // 用它判断 is_link 与符号链接本身的属性。
                if let Ok(meta) = entry.metadata() {
                    let is_link = meta.file_type().is_symlink();
                    let mut is_dir = meta.is_dir();
                    let mut size = meta.len() as i64;
                    let mut link_target: Option<String> = None;

                    // 符号链接:解引用一次拿到目标的 is_dir/size,并读取链接目标路径。
                    // 解引用失败(悬空链接)时保留 is_dir=false 但仍记录 link_target。
                    if is_link {
                        if let Ok(target_meta) = std::fs::metadata(entry.path()) {
                            is_dir = target_meta.is_dir();
                            size = target_meta.len() as i64;
                        }
                        if let Ok(tp) = std::fs::read_link(entry.path()) {
                            link_target = Some(tp.display().to_string());
                        }
                    }

                    files.push(FileInfo {
                        name,
                        size,
                        mode: format_mode(&meta),
                        mtime: meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs() as i64)
                            .unwrap_or(0),
                        is_dir,
                        owner: String::new(),
                        group: String::new(),
                        is_link,
                        link_target,
                    });
                }
            }
        }
        Err(e) => {
            error = Some(e.to_string());
        }
    }

    // 应用 soft_limit 截断:0 = 不限制
    let total_count = files.len();
    let truncated = req.soft_limit > 0 && total_count > req.soft_limit;
    if truncated {
        files.truncate(req.soft_limit);
    }

    let resp = FileListResponse {
        path: resolved,
        files,
        error,
        request_id: req.request_id,
        truncated,
        total: if truncated { Some(total_count) } else { None },
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
        "copy" => {
            std::fs::copy(&req.path, &req.new_path).map(|_| None)
        }
        "symlink" => {
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&req.path, &req.new_path).map(|_| None)
            }
            #[cfg(not(unix))]
            {
                Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "symlink not supported on this platform"))
            }
        }
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
        "chmod" => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&req.path, std::fs::Permissions::from_mode(req.mode)).map(|_| None)
            }
            #[cfg(not(unix))]
            {
                Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "chmod not supported on this platform"))
            }
        }
        "stat" => {
            // Go returns {success, operation, exists, is_dir, size} for stat
            let resp = match std::fs::metadata(&req.path) {
                Ok(meta) => serde_json::json!({
                    "success": true, "operation": "stat",
                    "exists": true, "is_dir": meta.is_dir(), "size": meta.len(),
                }),
                Err(_) => serde_json::json!({
                    "success": true, "operation": "stat", "exists": false,
                }),
            };
            let data = serde_json::to_vec(&resp).unwrap_or_default();
            return protocol::encode_message(protocol::MSG_FILE_OPERATION_RESP, &data);
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

fn encode_file_op_error_with_op(msg: &str, operation: &str) -> Vec<u8> {
    let resp = FileOperationResponse {
        success: false,
        error: Some(msg.to_string()),
        operation: Some(operation.to_string()),
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
            let resp = FileListResponse { path: String::new(), files: Vec::new(), error: Some(e.to_string()), request_id: None, truncated: false, total: None };
            let data = serde_json::to_vec(&resp).unwrap_or_default();
            return protocol::encode_message(protocol::MSG_FILE_LIST_RESP, &data);
        }
    };

    // 相对路径（如 "."）解析为绝对路径
    let resolved_path = if !req.path.starts_with('/') {
        match sftp.canonicalize(&req.path).await {
            Ok(p) => { eprintln!("[sftp] canonicalize '{}' -> '{}'", req.path, p); p }
            Err(e) => { eprintln!("[sftp] canonicalize '{}' FAILED: {}", req.path, e); req.path.clone() }
        }
    } else {
        req.path.clone()
    };

    let mut files = Vec::new();
    let mut error = None;

    match sftp.read_dir(resolved_path.clone()).await {
        Ok(read_dir) => {
            for entry in read_dir {
                let name = entry.file_name();
                if !req.show_hidden && name.starts_with('.') {
                    continue;
                }
                let attrs = entry.metadata();
                let is_link = attrs.is_symlink();
                let mut is_dir = attrs.is_dir();
                let mut size = attrs.size.unwrap_or(0) as i64;
                let mut link_target: Option<String> = None;

                // 符号链接:对目标做一次 stat 拿到真实 is_dir/size,并 readlink 拿到目标路径。
                // 失败(悬空链接)时 fallback:保留原始 is_dir 与 size,但不解引用。
                if is_link {
                    let entry_path = if resolved_path.ends_with('/') {
                        format!("{}{}", resolved_path, name)
                    } else {
                        format!("{}/{}", resolved_path, name)
                    };
                    if let Ok(target_attrs) = sftp.metadata(entry_path.clone()).await {
                        is_dir = target_attrs.is_dir();
                        size = target_attrs.size.unwrap_or(0) as i64;
                    }
                    if let Ok(tp) = sftp.read_link(entry_path).await {
                        link_target = Some(tp);
                    }
                }

                files.push(FileInfo {
                    name,
                    size,
                    mode: format!("{:o}", attrs.permissions.unwrap_or(0) & 0o7777),
                    mtime: attrs.mtime.unwrap_or(0) as i64,
                    is_dir,
                    owner: attrs.uid.map(|u| u.to_string()).unwrap_or_else(|| attrs.user.clone().unwrap_or_default()),
                    group: attrs.gid.map(|g| g.to_string()).unwrap_or_else(|| attrs.group.clone().unwrap_or_default()),
                    is_link,
                    link_target,
                });
            }
        }
        Err(e) => {
            error = Some(format!("{}", e));
        }
    }

    let total_count = files.len();
    let truncated = req.soft_limit > 0 && total_count > req.soft_limit;
    if truncated {
        files.truncate(req.soft_limit);
    }

    let resp = FileListResponse {
        path: resolved_path,
        files,
        error,
        request_id: req.request_id,
        truncated,
        total: if truncated { Some(total_count) } else { None },
    };
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
            let resp = FileListResponse { path: String::new(), files: Vec::new(), error: Some(e.to_string()), request_id: None, truncated: false, total: None };
            let data = serde_json::to_vec(&resp).unwrap_or_default();
            session.send_to_client(client_id, protocol::encode_message(protocol::MSG_FILE_LIST_RESP, &data));
            return;
        }
    };

    // 相对路径（如 "."）解析为绝对路径
    let resolved_path = if !req.path.starts_with('/') {
        match sftp.canonicalize(&req.path).await {
            Ok(p) => { eprintln!("[sftp] canonicalize '{}' -> '{}'", req.path, p); p }
            Err(e) => { eprintln!("[sftp] canonicalize '{}' FAILED: {}", req.path, e); req.path.clone() }
        }
    } else {
        req.path.clone()
    };

    let mut files = Vec::new();
    let mut error = None;

    match sftp.read_dir(resolved_path.clone()).await {
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
                let is_link = attrs.is_symlink();
                let mut is_dir = attrs.is_dir();
                let mut size = attrs.size.unwrap_or(0) as i64;
                let mut link_target: Option<String> = None;

                // 符号链接:解引用一次拿目标 is_dir/size + 链接路径(失败则保留原值)
                if is_link {
                    let entry_path = if resolved_path.ends_with('/') {
                        format!("{}{}", resolved_path, name)
                    } else {
                        format!("{}/{}", resolved_path, name)
                    };
                    if let Ok(target_attrs) = sftp.metadata(entry_path.clone()).await {
                        is_dir = target_attrs.is_dir();
                        size = target_attrs.size.unwrap_or(0) as i64;
                    }
                    if let Ok(tp) = sftp.read_link(entry_path).await {
                        link_target = Some(tp);
                    }
                }

                files.push(FileInfo {
                    name,
                    size,
                    mode: format!("{:o}", attrs.permissions.unwrap_or(0) & 0o7777),
                    mtime: attrs.mtime.unwrap_or(0) as i64,
                    is_dir,
                    owner: attrs.uid.map(|u| u.to_string()).unwrap_or_else(|| attrs.user.clone().unwrap_or_default()),
                    group: attrs.gid.map(|g| g.to_string()).unwrap_or_else(|| attrs.group.clone().unwrap_or_default()),
                    is_link,
                    link_target,
                });

                if is_large && ((i + 1) % BATCH_SIZE == 0 || i == total - 1) {
                    let progress = serde_json::json!({"loaded": i + 1, "total": total});
                    session.send_to_client(client_id, protocol::encode_message(protocol::MSG_FILE_LIST_PROGRESS, serde_json::to_vec(&progress).unwrap_or_default().as_slice()));
                }
            }
        }
        Err(e) => { error = Some(format!("{}", e)); }
    }

    let total_count = files.len();
    let truncated = req.soft_limit > 0 && total_count > req.soft_limit;
    if truncated {
        files.truncate(req.soft_limit);
    }

    let resp = FileListResponse {
        path: resolved_path,
        files,
        error,
        request_id: req.request_id,
        truncated,
        total: if truncated { Some(total_count) } else { None },
    };
    let data = serde_json::to_vec(&resp).unwrap_or_default();
    // send_sftp_error 会检查响应中的 error 字段是否为认证失败，若是则升级为 SFTP_AUTH_FAILED
    send_sftp_error(session, client_id, protocol::encode_message(protocol::MSG_FILE_LIST_RESP, &data));
}

/// Recursively remove a file or directory via SFTP.
async fn sftp_remove_recursive(sftp: &SftpSession, path: &str) -> Result<Option<FileInfo>, String> {
    // Try remove_file first (works for files and symlinks)
    if sftp.remove_file(path.to_string()).await.is_ok() {
        return Ok(None);
    }
    // If it's a directory, recurse into children
    let entries = sftp.read_dir(path.to_string()).await.map_err(|e| format!("read_dir {}: {}", path, e))?;
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." { continue; }
        let child = if path.ends_with('/') { format!("{}{}", path, name) } else { format!("{}/{}", path, name) };
        // Box::pin to allow recursive async
        Box::pin(sftp_remove_recursive(sftp, &child)).await?;
    }
    sftp.remove_dir(path.to_string()).await.map(|_| None).map_err(|e| format!("rmdir {}: {}", path, e))
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
            sftp_remove_recursive(sftp, &req.path).await
        }
        "rename" => {
            sftp.rename(req.path.clone(), req.new_path.clone()).await.map(|_| None).map_err(|e| format!("{}", e))
        }
        "copy" => {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            match sftp.open(req.path.clone()).await {
                Ok(mut src) => {
                    match sftp.create(req.new_path.clone()).await {
                        Ok(mut dst) => {
                            let mut buf = vec![0u8; 1024 * 1024];
                            loop {
                                match src.read(&mut buf).await {
                                    Ok(0) => break,
                                    Ok(n) => {
                                        if let Err(e) = dst.write_all(&buf[..n]).await {
                                            return encode_file_op_error_with_op(&format!("write: {}", e), "copy");
                                        }
                                    }
                                    Err(e) => return encode_file_op_error_with_op(&format!("read: {}", e), "copy"),
                                }
                            }
                            Ok(None)
                        }
                        Err(e) => Err(format!("create dest: {}", e)),
                    }
                }
                Err(e) => Err(format!("open source: {}", e)),
            }
        }
        "symlink" => {
            // OpenSSH reverses SSH_FXP_SYMLINK args vs RFC:
            // RFC: (linkpath, targetpath), OpenSSH: (targetpath, linkpath)
            // russh-sftp follows RFC, so swap args for OpenSSH compatibility
            sftp.symlink(req.path.clone(), req.new_path.clone()).await
                .map(|_| None)
                .map_err(|e| format!("{}", e))
        }
        "touch" => {
            match sftp.create(req.path.clone()).await {
                Ok(file) => { drop(file); Ok(None) }
                Err(e) => Err(format!("{}", e))
            }
        }
        "chmod" => {
            use russh_sftp::client::fs::Metadata as SftpMetadata;
            let metadata = SftpMetadata {
                permissions: Some(req.mode),
                ..SftpMetadata::empty()
            };
            sftp.set_metadata(req.path.clone(), metadata).await
                .map(|_| None)
                .map_err(|e| format!("{}", e))
        }
        "stat" => {
            let resp = match sftp.metadata(req.path.clone()).await {
                Ok(attrs) => serde_json::json!({
                    "success": true, "operation": "stat",
                    "exists": true, "is_dir": attrs.is_dir(),
                    "size": attrs.size.unwrap_or(0),
                }),
                Err(_) => serde_json::json!({
                    "success": true, "operation": "stat", "exists": false,
                }),
            };
            let data = serde_json::to_vec(&resp).unwrap_or_default();
            return protocol::encode_message(protocol::MSG_FILE_OPERATION_RESP, &data);
        }
        _ => Err(format!("unsupported operation: {}", req.operation)),
    };

    match result {
        Ok(stat) => {
            let resp = FileOperationResponse { success: true, error: None, operation: Some(req.operation), stat };
            let data = serde_json::to_vec(&resp).unwrap_or_default();
            protocol::encode_message(protocol::MSG_FILE_OPERATION_RESP, &data)
        }
        Err(e) => encode_file_op_error_with_op(&e, &req.operation),
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
    let raw_path = String::from_utf8_lossy(&payload[4..4 + path_len]).to_string();
    let content = &payload[4 + path_len..];

    // If path is a symlink, resolve to real target so we don't replace the link.
    // Try read_link directly — if it succeeds, the path is a symlink.
    // This is more reliable than lstat (which some SFTP proxies like JumpServer may not support).
    let path = match sftp.read_link(raw_path.clone()).await {
        Ok(target) => {
            // read_link may return a relative path — resolve against parent dir
            if target.starts_with('/') {
                target
            } else {
                let parent = raw_path.rfind('/').map(|i| &raw_path[..i]).unwrap_or(".");
                format!("{}/{}", parent, target)
            }
        }
        Err(_) => raw_path, // not a symlink or read_link unsupported
    };

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
