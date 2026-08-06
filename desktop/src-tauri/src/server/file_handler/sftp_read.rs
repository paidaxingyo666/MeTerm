//! SFTP read/save operations used by the remote editor.

use russh_sftp::client::SftpSession;

use super::encode_msg_error;
use super::read_limits::parse_file_read_request;
use crate::server::protocol;
use crate::server::terminal::ssh_limits::{
    read_bounded, BoundedReadError, SFTP_FILE_READ_LIMIT, SFTP_FILE_READ_TIMEOUT,
    SFTP_OPERATION_TIMEOUT,
};

/// Handle MsgFileReadRequest via SFTP.
/// Request: JSON `{ "path": "...", "max_bytes": 123 }` (`max_bytes` is optional).
/// Response: MsgFileReadResponse + `[8B size BE][content]`.
pub async fn handle_sftp_file_read(payload: &[u8], sftp: &SftpSession) -> Vec<u8> {
    let (path, read_limit) = match parse_file_read_request(payload, SFTP_FILE_READ_LIMIT) {
        Ok(request) => request,
        Err(error) => return encode_msg_error("INVALID_REQUEST", &error),
    };

    let attrs =
        match tokio::time::timeout(SFTP_OPERATION_TIMEOUT, sftp.metadata(path.clone())).await {
            Ok(Ok(attrs)) => attrs,
            Ok(Err(error)) => {
                return encode_msg_error("NOT_FOUND", &format!("File not found: {}", error))
            }
            Err(_) => return encode_msg_error("READ_TIMEOUT", "SFTP metadata request timed out"),
        };
    if attrs.is_dir() {
        return encode_msg_error("IS_DIRECTORY", "Cannot open a directory in editor");
    }
    if attrs.size.unwrap_or(0) > read_limit as u64 {
        return encode_msg_error(
            "FILE_TOO_LARGE",
            &format!("File exceeds {} byte limit", read_limit),
        );
    }

    let mut file = match tokio::time::timeout(SFTP_OPERATION_TIMEOUT, sftp.open(path)).await {
        Ok(Ok(file)) => file,
        Ok(Err(error)) => return encode_msg_error("READ_FAILED", &format!("open: {}", error)),
        Err(_) => return encode_msg_error("READ_TIMEOUT", "SFTP open request timed out"),
    };
    match read_bounded(&mut file, read_limit, SFTP_FILE_READ_TIMEOUT).await {
        Ok(content) => {
            let size = content.len() as u64;
            let mut response = Vec::with_capacity(8 + content.len());
            response.extend_from_slice(&size.to_be_bytes());
            response.extend_from_slice(&content);
            protocol::encode_message(protocol::MSG_FILE_READ_RESPONSE, &response)
        }
        Err(BoundedReadError::TooLarge { .. }) => encode_msg_error(
            "FILE_TOO_LARGE",
            &format!("File exceeds {} byte limit", read_limit),
        ),
        Err(BoundedReadError::TimedOut { .. }) => {
            encode_msg_error("READ_TIMEOUT", "SFTP file read timed out")
        }
        Err(BoundedReadError::Io(error)) => {
            encode_msg_error("READ_FAILED", &format!("read: {}", error))
        }
    }
}

/// Handle MsgFileSaveRequest via SFTP.
/// Request: binary `[4B pathLen BE][path UTF-8][content]`.
pub async fn handle_sftp_file_save(payload: &[u8], sftp: &SftpSession) -> Vec<u8> {
    use tokio::io::AsyncWriteExt;

    if payload.len() < 4 {
        return encode_msg_error("INVALID_REQUEST", "payload too short");
    }
    let path_len = u32::from_be_bytes(payload[0..4].try_into().unwrap_or([0; 4])) as usize;
    if path_len == 0 || payload.len() < 4 + path_len {
        return encode_msg_error("INVALID_REQUEST", "invalid path length");
    }
    let raw_path = String::from_utf8_lossy(&payload[4..4 + path_len]).to_string();
    let content = &payload[4 + path_len..];

    let path = match sftp.read_link(raw_path.clone()).await {
        Ok(target) if target.starts_with('/') => target,
        Ok(target) => {
            let parent = raw_path
                .rfind('/')
                .map(|index| &raw_path[..index])
                .unwrap_or(".");
            format!("{}/{}", parent, target)
        }
        Err(_) => raw_path,
    };
    let tmp_path = format!("{}.meterm.edit.tmp", path);
    match sftp.create(tmp_path.clone()).await {
        Ok(mut file) => {
            if let Err(error) = file.write_all(content).await {
                let _ = sftp.remove_file(tmp_path).await;
                return encode_msg_error("WRITE_FAILED", &format!("write: {}", error));
            }
            drop(file);
            if sftp.rename(tmp_path.clone(), path.clone()).await.is_err() {
                let _ = sftp.remove_file(path.clone()).await;
                if let Err(error) = sftp.rename(tmp_path, path).await {
                    return encode_msg_error("RENAME_FAILED", &format!("rename: {}", error));
                }
            }
            let response = serde_json::json!({"success": true, "operation": "save"});
            protocol::encode_message(
                protocol::MSG_FILE_OPERATION_RESP,
                serde_json::to_vec(&response).unwrap_or_default().as_slice(),
            )
        }
        Err(error) => encode_msg_error("WRITE_FAILED", &format!("create: {}", error)),
    }
}
