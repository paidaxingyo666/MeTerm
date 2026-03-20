//! Binary message protocol — byte-level compatible with the Go implementation.
//!
//! Frame format: `[MsgType: u8][Payload: N bytes]`
//!
//! All multi-byte integers in payloads use **Big Endian** unless noted otherwise.

// ---------------------------------------------------------------------------
// Message type constants (must match Go `protocol/protocol.go` exactly)
// ---------------------------------------------------------------------------

// Core terminal I/O
pub const MSG_OUTPUT: u8 = 0x01;
/// OSC events extracted by Rust-side OscFilter (JSON payload).
pub const MSG_OSC_EVENT: u8 = 0x40;
pub const MSG_INPUT: u8 = 0x02;
pub const MSG_RESIZE: u8 = 0x03;
pub const MSG_PING: u8 = 0x04;
pub const MSG_PONG: u8 = 0x05;
pub const MSG_SESSION_END: u8 = 0x06;
pub const MSG_ERROR: u8 = 0x07;
pub const MSG_ROLE_CHANGE: u8 = 0x08;
pub const MSG_HELLO: u8 = 0x09;

// File operations
pub const MSG_FILE_LIST: u8 = 0x0A;
pub const MSG_FILE_LIST_RESP: u8 = 0x0B;
pub const MSG_FILE_UPLOAD_START: u8 = 0x0C;
pub const MSG_FILE_UPLOAD_CHUNK: u8 = 0x0D;
pub const MSG_FILE_DOWNLOAD_START: u8 = 0x0E;
pub const MSG_FILE_DOWNLOAD_CHUNK: u8 = 0x0F;
pub const MSG_FILE_OPERATION: u8 = 0x10;
pub const MSG_FILE_OPERATION_RESP: u8 = 0x11;
pub const MSG_SERVER_INFO: u8 = 0x12;
pub const MSG_TRANSFER_PROGRESS: u8 = 0x13;
pub const MSG_FILE_UPLOAD_RESUME: u8 = 0x14;
pub const MSG_FILE_DOWNLOAD_RESUME: u8 = 0x15;
pub const MSG_FILE_LIST_PROGRESS: u8 = 0x16;
pub const MSG_SET_ENCODING: u8 = 0x17;

// Terminal control
pub const MSG_NUDGE: u8 = 0x18;

// Master role management
pub const MSG_MASTER_REQUEST: u8 = 0x19;
pub const MSG_MASTER_REQUEST_NOTIFY: u8 = 0x1A;
pub const MSG_MASTER_APPROVAL: u8 = 0x1B;
pub const MSG_MASTER_RECLAIM: u8 = 0x1C;

// Device pairing
pub const MSG_PAIR_NOTIFY: u8 = 0x1D;
pub const MSG_PAIR_APPROVAL: u8 = 0x1E;

// Download flow control
pub const MSG_FILE_DOWNLOAD_PAUSE: u8 = 0x20;
pub const MSG_FILE_DOWNLOAD_CONTINUE: u8 = 0x21;
pub const MSG_FILE_DOWNLOAD_CANCEL: u8 = 0x22;

// File editor (read/save)
pub const MSG_FILE_READ_REQUEST: u8 = 0x30;
pub const MSG_FILE_READ_RESPONSE: u8 = 0x31;
pub const MSG_FILE_SAVE_REQUEST: u8 = 0x32;

// ---------------------------------------------------------------------------
// Error codes (sent inside MsgError payload)
// ---------------------------------------------------------------------------
pub const ERR_NOT_MASTER: u8 = 0x01;
pub const ERR_SESSION_NOT_FOUND: u8 = 0x02;
pub const ERR_SESSION_PRIVATE: u8 = 0x03;
pub const ERR_KICKED: u8 = 0x04;
pub const ERR_INTERNAL: u8 = 0xFF;

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/// Encode a typed message: `[msg_type: u8][payload]`.
pub fn encode_message(msg_type: u8, payload: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + payload.len());
    buf.push(msg_type);
    buf.extend_from_slice(payload);
    buf
}

/// Encode a resize message: `[0x03][cols: u16 BE][rows: u16 BE]`.
pub fn encode_resize(cols: u16, rows: u16) -> Vec<u8> {
    let mut buf = Vec::with_capacity(5);
    buf.push(MSG_RESIZE);
    buf.extend_from_slice(&cols.to_be_bytes());
    buf.extend_from_slice(&rows.to_be_bytes());
    buf
}

/// Decode a resize payload (4 bytes) → (cols, rows).
pub fn decode_resize(payload: &[u8]) -> Option<(u16, u16)> {
    if payload.len() < 4 {
        return None;
    }
    let cols = u16::from_be_bytes([payload[0], payload[1]]);
    let rows = u16::from_be_bytes([payload[2], payload[3]]);
    Some((cols, rows))
}

/// Encode an error message: `[0x07][code: u8][message UTF-8]`.
pub fn encode_error(code: u8, message: &str) -> Vec<u8> {
    let msg_bytes = message.as_bytes();
    let mut buf = Vec::with_capacity(2 + msg_bytes.len());
    buf.push(MSG_ERROR);
    buf.push(code);
    buf.extend_from_slice(msg_bytes);
    buf
}

/// Encode a Hello message (JSON payload).
///
/// Matches Go: `{"client_id":"...","role":"...","protocol_version":1,"cols":80,"rows":24}`
pub fn encode_hello(client_id: &str, role: &str, protocol_version: u32, cols: u16, rows: u16) -> Vec<u8> {
    let json = serde_json::json!({
        "client_id": client_id,
        "role": role,
        "protocol_version": protocol_version,
        "cols": cols,
        "rows": rows,
    });
    encode_message(MSG_HELLO, json.to_string().as_bytes())
}

/// Encode a role-change message: `[0x08][role: u8]`.
pub fn encode_role_change(role: u8) -> Vec<u8> {
    vec![MSG_ROLE_CHANGE, role]
}

/// Encode a master-request notification (JSON).
pub fn encode_master_request_notify(requester_id: &str, session_id: &str) -> Vec<u8> {
    let json = serde_json::json!({
        "requester_id": requester_id,
        "session_id": session_id,
    });
    encode_message(MSG_MASTER_REQUEST_NOTIFY, json.to_string().as_bytes())
}

/// Encode a master-approval message: `[0x1B][approved: u8][requester_id UTF-8]`.
pub fn encode_master_approval(approved: bool, requester_id: &str) -> Vec<u8> {
    let mut buf = Vec::with_capacity(2 + requester_id.len());
    buf.push(MSG_MASTER_APPROVAL);
    buf.push(if approved { 1 } else { 0 });
    buf.extend_from_slice(requester_id.as_bytes());
    buf
}

/// Encode a pair notification (JSON).
pub fn encode_pair_notify(pair_id: &str, device_info: &str, remote_addr: &str) -> Vec<u8> {
    let json = serde_json::json!({
        "pair_id": pair_id,
        "device_info": device_info,
        "remote_addr": remote_addr,
    });
    encode_message(MSG_PAIR_NOTIFY, json.to_string().as_bytes())
}

/// Encode a pair-approval message: `[0x1E][approved: u8][pair_id UTF-8]`.
pub fn encode_pair_approval(approved: bool, pair_id: &str) -> Vec<u8> {
    let mut buf = Vec::with_capacity(2 + pair_id.len());
    buf.push(MSG_PAIR_APPROVAL);
    buf.push(if approved { 1 } else { 0 });
    buf.extend_from_slice(pair_id.as_bytes());
    buf
}

/// Encode a pong message. For SSH sessions includes RTT in ms as 4-byte BE.
pub fn encode_pong(rtt_ms: Option<u32>) -> Vec<u8> {
    match rtt_ms {
        Some(ms) => {
            let mut buf = Vec::with_capacity(5);
            buf.push(MSG_PONG);
            buf.extend_from_slice(&ms.to_be_bytes());
            buf
        }
        None => vec![MSG_PONG],
    }
}

/// Encode session-end message.
pub fn encode_session_end() -> Vec<u8> {
    vec![MSG_SESSION_END]
}

// ---------------------------------------------------------------------------
// File message helpers
// ---------------------------------------------------------------------------

/// Encode a file-download-start message:
/// `[0x0E][offset: u64 BE][path_len: u32 BE][path UTF-8]`
pub fn encode_file_download_start(path: &str, offset: u64) -> Vec<u8> {
    let path_bytes = path.as_bytes();
    let mut buf = Vec::with_capacity(1 + 8 + 4 + path_bytes.len());
    buf.push(MSG_FILE_DOWNLOAD_START);
    buf.extend_from_slice(&offset.to_be_bytes());
    buf.extend_from_slice(&(path_bytes.len() as u32).to_be_bytes());
    buf.extend_from_slice(path_bytes);
    buf
}

/// Encode a file-upload-start message:
/// `[0x0C][total_size: u64 BE][path_len: u32 BE][path UTF-8]`
pub fn encode_file_upload_start(path: &str, total_size: u64) -> Vec<u8> {
    let path_bytes = path.as_bytes();
    let mut buf = Vec::with_capacity(1 + 8 + 4 + path_bytes.len());
    buf.push(MSG_FILE_UPLOAD_START);
    buf.extend_from_slice(&total_size.to_be_bytes());
    buf.extend_from_slice(&(path_bytes.len() as u32).to_be_bytes());
    buf.extend_from_slice(path_bytes);
    buf
}

/// Encode a file-download-chunk:
/// `[0x0F][chunk_id: u64 BE][data]`
pub fn encode_file_download_chunk(chunk_id: u64, data: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + 8 + data.len());
    buf.push(MSG_FILE_DOWNLOAD_CHUNK);
    buf.extend_from_slice(&chunk_id.to_be_bytes());
    buf.extend_from_slice(data);
    buf
}

/// Decode a file-download-start payload → (offset, path).
pub fn decode_file_download_start(payload: &[u8]) -> Option<(u64, String)> {
    if payload.len() < 12 {
        return None;
    }
    let offset = u64::from_be_bytes(payload[0..8].try_into().ok()?);
    let path_len = u32::from_be_bytes(payload[8..12].try_into().ok()?) as usize;
    if payload.len() < 12 + path_len {
        return None;
    }
    let path = String::from_utf8(payload[12..12 + path_len].to_vec()).ok()?;
    Some((offset, path))
}

/// Decode a file-upload-start payload → (total_size, path).
pub fn decode_file_upload_start(payload: &[u8]) -> Option<(u64, String)> {
    if payload.len() < 12 {
        return None;
    }
    let total_size = u64::from_be_bytes(payload[0..8].try_into().ok()?);
    let path_len = u32::from_be_bytes(payload[8..12].try_into().ok()?) as usize;
    if payload.len() < 12 + path_len {
        return None;
    }
    let path = String::from_utf8(payload[12..12 + path_len].to_vec()).ok()?;
    Some((total_size, path))
}

/// Decode a file-upload-chunk payload → (chunk_id, data).
pub fn decode_file_upload_chunk(payload: &[u8]) -> Option<(u64, &[u8])> {
    if payload.len() < 8 {
        return None;
    }
    let chunk_id = u64::from_be_bytes(payload[0..8].try_into().ok()?);
    Some((chunk_id, &payload[8..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_decode_resize() {
        let msg = encode_resize(120, 40);
        assert_eq!(msg[0], MSG_RESIZE);
        let (cols, rows) = decode_resize(&msg[1..]).unwrap();
        assert_eq!(cols, 120);
        assert_eq!(rows, 40);
    }

    #[test]
    fn test_encode_error() {
        let msg = encode_error(ERR_NOT_MASTER, "not master");
        assert_eq!(msg[0], MSG_ERROR);
        assert_eq!(msg[1], ERR_NOT_MASTER);
        assert_eq!(&msg[2..], b"not master");
    }

    #[test]
    fn test_encode_decode_file_download_start() {
        let msg = encode_file_download_start("/home/user/test.txt", 1024);
        let (offset, path) = decode_file_download_start(&msg[1..]).unwrap();
        assert_eq!(offset, 1024);
        assert_eq!(path, "/home/user/test.txt");
    }

    #[test]
    fn test_encode_decode_file_upload_chunk() {
        let data = b"hello world";
        let msg = encode_file_download_chunk(42, data);
        let (chunk_id, decoded_data) = decode_file_upload_chunk(&msg[1..]).unwrap();
        assert_eq!(chunk_id, 42);
        assert_eq!(decoded_data, data);
    }
}
