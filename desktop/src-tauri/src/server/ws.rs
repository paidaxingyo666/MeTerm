//! WebSocket handler — mirrors Go `api/ws.go`.
//!
//! Handles WebSocket upgrade at `/ws/{session_id}`, then runs the
//! message dispatch loop for terminal I/O, file operations, etc.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Extension, Path, Query, WebSocketUpgrade};
use axum::response::IntoResponse;
use serde::Deserialize;

use super::protocol;
use super::session::client::Client;
use super::session::state::ClientRole;
use super::ServerState;

#[derive(Deserialize)]
pub struct WsQuery {
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
}

/// WebSocket upgrade handler.
pub async fn ws_upgrade(
    ws: WebSocketUpgrade,
    Extension(state): Extension<Arc<ServerState>>,
    Path(session_id): Path<String>,
    Query(query): Query<WsQuery>,
) -> impl IntoResponse {
    ws.protocols(["meterm.v1"])
        .on_upgrade(move |socket| handle_ws(socket, state, session_id, query))
}

/// Main WebSocket handler — runs after upgrade.
async fn handle_ws(
    mut socket: WebSocket,
    state: Arc<ServerState>,
    session_id: String,
    query: WsQuery,
) {
    eprintln!("[ws] new connection for session={}, client_id={:?}, mode={:?}", session_id, query.client_id, query.mode);

    // 1. Find session
    let session = match state.session_manager.get(&session_id) {
        Some(s) => s,
        None => {
            let err = protocol::encode_error(protocol::ERR_SESSION_NOT_FOUND, "session not found");
            let _ = socket.send(Message::Binary(err.into())).await;
            return;
        }
    };

    // 2. Handle reconnect or create new client
    let (client, mut rx) = if let Some(ref cid) = query.client_id {
        // Attempt reconnect
        match session.reconnect_client(
            cid,
            String::new(), // remote addr — will be populated from ConnectInfo
            state.config.reconnect_grace,
        ) {
            Ok(rx) => {
                let clients = session.clients.lock().unwrap();
                let client = clients.get(cid).cloned().unwrap();
                (client, rx)
            }
            Err(_) => {
                // Reconnect failed — create new client
                let (client, rx) = create_new_client(&session, &query);
                (client, rx)
            }
        }
    } else {
        create_new_client(&session, &query)
    };

    let client_id = client.id.clone();
    // Determine actual role: if this client is master, report "master" not "viewer"
    let actual_role = if session.master() == client_id {
        "master"
    } else {
        client.role.as_str()
    };
    eprintln!("[ws] client={} role={} master={}", client_id, actual_role, session.master());

    // 3. Send Hello
    let hello = protocol::encode_hello(
        &client_id,
        actual_role,
        1, // protocol_version
        *session.last_cols.lock().unwrap(),
        *session.last_rows.lock().unwrap(),
    );
    if socket.send(Message::Binary(hello.into())).await.is_err() {
        return;
    }

    // 4. Send role change (use actual role, not client.role which may be stale)
    let role_byte = if session.master() == client_id {
        super::session::state::ClientRole::Master as u8
    } else {
        client.role as u8
    };
    let role_msg = protocol::encode_role_change(role_byte);
    let _ = socket.send(Message::Binary(role_msg.into())).await;

    // 5. Flush ring buffer
    session.flush_ring_buffer(&client);

    // 6. Message loop — read from WebSocket, dispatch by message type
    let conn_gen = client.conn_gen();

    // Bidirectional message loop using tokio::select! for proper async I/O.
    // - rx: outgoing messages from session → WebSocket
    // - socket.recv(): incoming messages from WebSocket → dispatch
    loop {
        tokio::select! {
            // Outgoing: session → WebSocket client
            msg = rx.recv() => {
                match msg {
                    Some(data) => {
                        if socket.send(Message::Binary(data.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break, // channel closed (client disconnected from session side)
                }
            }
            // Incoming: WebSocket client → session
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        if data.is_empty() {
                            continue;
                        }
                        let msg_type = data[0];
                        let payload = &data[1..];
                        dispatch_message(&session, &client_id, msg_type, payload, &state).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {} // ignore text, ping, pong
                }
            }
        }
    }

    // Cleanup
    session.remove_client(&client_id, conn_gen);
}

fn create_new_client(
    session: &super::session::Session,
    query: &WsQuery,
) -> (Arc<Client>, tokio::sync::mpsc::Receiver<Vec<u8>>) {
    let id = uuid::Uuid::new_v4().to_string();
    let role = match query.mode.as_deref() {
        Some("readonly") => ClientRole::ReadOnly,
        _ => ClientRole::Viewer, // add_client promotes first Viewer to Master
    };
    let (client, rx) = Client::new(id, String::new(), role);
    let client = Arc::new(client);
    let _ = session.add_client(client.clone());
    (client, rx)
}

/// Check if the client is master for this session.
fn is_master(session: &super::session::Session, client_id: &str) -> bool {
    session.master() == client_id
}

/// Validate a file path (absolute, max 4096 chars). Matches Go validatePath.
fn validate_path(path: &str) -> Result<(), &'static str> {
    let cleaned = path.replace("\\", "/");
    if !cleaned.starts_with('/') {
        return Err("path must be absolute");
    }
    if cleaned.len() > 4096 {
        return Err("path too long");
    }
    Ok(())
}

async fn dispatch_message(
    session: &std::sync::Arc<super::session::Session>,
    client_id: &str,
    msg_type: u8,
    payload: &[u8],
    _state: &ServerState,
) {
    match msg_type {
        protocol::MSG_INPUT => {
            session.handle_input(client_id, payload);
        }
        protocol::MSG_RESIZE => {
            if let Some((cols, rows)) = protocol::decode_resize(payload) {
                session.handle_resize(client_id, cols, rows);
            }
        }
        protocol::MSG_PING => {
            // For SSH sessions: measure RTT via keepalive (matches Go handlePing)
            let exec_type = session.executor_type.lock().unwrap().clone();
            if exec_type == "ssh" {
                if let Some(handle) = session.ssh_exec_handle.lock().await.as_ref() {
                    if let Some(ssh_handle) = handle.downcast_ref::<std::sync::Arc<tokio::sync::Mutex<Option<russh::client::Handle<super::terminal::ssh::SshHandler>>>>>() {
                        let start = std::time::Instant::now();
                        // Try to open a quick exec channel as keepalive test
                        let mut guard = ssh_handle.lock().await;
                        if let Some(ref mut sess) = *guard {
                            match tokio::time::timeout(
                                std::time::Duration::from_secs(10),
                                sess.channel_open_session(),
                            ).await {
                                Ok(Ok(ch)) => {
                                    let _ = ch.close().await;
                                    let rtt_ms = start.elapsed().as_millis() as u32;
                                    session.send_to_client(client_id, protocol::encode_pong(Some(rtt_ms)));
                                    return;
                                }
                                _ => {
                                    // SSH dead — notify and close
                                    session.broadcast(protocol::encode_session_end());
                                    return;
                                }
                            }
                        }
                    }
                }
            }
            session.send_to_client(client_id, protocol::encode_pong(None));
        }
        protocol::MSG_NUDGE => {
            // Debounce 200ms then nudge resize (matches Go)
            session.nudge_resize();
        }
        protocol::MSG_SET_ENCODING => {
            if let Ok(name) = std::str::from_utf8(payload) {
                session.set_encoding(name);
            }
        }
        protocol::MSG_MASTER_REQUEST => {
            session.forward_master_request(client_id);
        }
        protocol::MSG_MASTER_APPROVAL => {
            if payload.len() >= 2 {
                let approved = payload[0] != 0;
                if let Ok(requester_id) = std::str::from_utf8(&payload[1..]) {
                    session.handle_master_approval(client_id, approved, requester_id);
                }
            }
        }
        protocol::MSG_MASTER_RECLAIM => {
            if client_id == session.owner() {
                let _ = session.set_master(client_id);
            }
        }
        protocol::MSG_FILE_LIST => {
            if !is_master(session, client_id) { return; }
            let sftp = session.sftp.lock().unwrap().clone();
            if let Some(sftp) = sftp {
                let client_id = client_id.to_string();
                let session = session.clone();
                let payload = payload.to_vec();
                tokio::spawn(async move {
                    super::file_handler::handle_sftp_file_list_with_progress(&payload, &sftp, &session, &client_id).await;
                });
            } else {
                let resp = super::file_handler::handle_file_list(payload);
                session.send_to_client(client_id, resp);
            }
        }
        protocol::MSG_FILE_OPERATION => {
            // stat is read-only, allowed for all. Others need master.
            let is_stat = serde_json::from_slice::<serde_json::Value>(payload)
                .ok()
                .and_then(|v| v.get("operation").and_then(|o| o.as_str()).map(|s| s == "stat"))
                .unwrap_or(false);
            if !is_stat && !is_master(session, client_id) { return; }
            let sftp = session.sftp.lock().unwrap().clone();
            if let Some(sftp) = sftp {
                let client_id = client_id.to_string();
                let session = session.clone();
                let payload = payload.to_vec();
                tokio::spawn(async move {
                    let resp = super::file_handler::handle_sftp_file_operation(&payload, &sftp).await;
                    session.send_to_client(&client_id, resp);
                });
            } else {
                let resp = super::file_handler::handle_file_operation(payload);
                session.send_to_client(client_id, resp);
            }
        }
        protocol::MSG_FILE_READ_REQUEST => {
            if !is_master(session, client_id) { return; }
            let sftp = session.sftp.lock().unwrap().clone();
            if let Some(sftp) = sftp {
                let payload = payload.to_vec();
                let client_id = client_id.to_string();
                let session = session.clone();
                tokio::spawn(async move {
                    let resp = super::file_handler::handle_sftp_file_read(&payload, &sftp).await;
                    session.send_to_client(&client_id, resp);
                });
            } else {
                // Local: also JSON format
                let resp = super::file_handler::handle_file_read_json(payload);
                session.send_to_client(client_id, resp);
            }
        }
        protocol::MSG_FILE_SAVE_REQUEST => {
            if !is_master(session, client_id) { return; }
            let sftp = session.sftp.lock().unwrap().clone();
            if let Some(sftp) = sftp {
                let payload = payload.to_vec();
                let client_id = client_id.to_string();
                let session = session.clone();
                tokio::spawn(async move {
                    let resp = super::file_handler::handle_sftp_file_save(&payload, &sftp).await;
                    session.send_to_client(&client_id, resp);
                });
            } else {
                let resp = super::file_handler::handle_file_save(payload);
                session.send_to_client(client_id, resp);
            }
        }
        protocol::MSG_SERVER_INFO => {
            let payload = payload.to_vec();
            let client_id = client_id.to_string();
            let session = session.clone();
            tokio::spawn(async move {
                let resp = super::server_info::handle_server_info(&session, &payload).await;
                session.send_to_client(&client_id, resp);
            });
        }
        protocol::MSG_FILE_DOWNLOAD_START => {
            if !is_master(session, client_id) { return; }
            if let Ok(req) = serde_json::from_slice::<serde_json::Value>(payload) {
                let path = req.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if !path.is_empty() {
                    // Create download control channel (matches Go downloadCtrl)
                    let (ctrl_tx, ctrl_rx) = tokio::sync::mpsc::channel::<super::session::DownloadSignal>(4);
                    *session.download_ctrl.lock().await = Some(ctrl_tx);

                    let client_id_clone = client_id.to_string();
                    let session_clone = session.clone();
                    let sftp = session.sftp.lock().unwrap().clone();
                    tokio::spawn(async move {
                        if let Some(sftp) = sftp {
                            handle_sftp_file_download(&session_clone, &client_id_clone, &path, 0, &sftp, ctrl_rx).await;
                        } else {
                            handle_local_file_download(&session_clone, &client_id_clone, &path, 0, ctrl_rx).await;
                        }
                        // Clear control channel when done
                        *session_clone.download_ctrl.lock().await = None;
                    });
                }
            }
        }
        protocol::MSG_FILE_UPLOAD_START => {
            if !is_master(session, client_id) { return; }
            if let Ok(req) = serde_json::from_slice::<serde_json::Value>(payload) {
                let path = req.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let total_size = req.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
                let client_id = client_id.to_string();
                let session = session.clone();
                tokio::spawn(async move {
                    let sftp = session.sftp.lock().unwrap().clone();

                    // Empty file: create directly, no chunk phase
                    if total_size == 0 {
                        let ok = if let Some(ref sftp) = sftp {
                            sftp.create(path.clone()).await.is_ok()
                        } else {
                            std::fs::File::create(&path).is_ok()
                        };
                        let resp = if ok {
                            serde_json::json!({"success": true})
                        } else {
                            serde_json::json!({"ok": false, "error": "Failed to create file"})
                        };
                        session.send_to_client(&client_id, protocol::encode_message(
                            protocol::MSG_FILE_OPERATION_RESP,
                            serde_json::to_vec(&resp).unwrap_or_default().as_slice(),
                        ));
                        return;
                    }

                    // Open .meterm.part file for streaming write (matches Go)
                    let part_path = format!("{}.meterm.part", path);
                    if let Some(ref sftp) = sftp {
                        match sftp.create(part_path.clone()).await {
                            Ok(file) => {
                                *session.active_upload.lock().await = Some(super::session::UploadState {
                                    path,
                                    part_path,
                                    total_size,
                                    received: 0,
                                    sftp_file: Some(file),
                                    local_file: None,
                                    pending_writes: Vec::new(),
                                    pipeline: super::session::AdaptivePipeline::new(),
                                });
                                // ACK: start sending chunks
                                session.send_to_client(&client_id, protocol::encode_message(protocol::MSG_FILE_UPLOAD_CHUNK, &[]));
                            }
                            Err(e) => {
                                let err = serde_json::json!({"code": "WRITE_FAILED", "message": format!("create part: {}", e)});
                                session.send_to_client(&client_id, protocol::encode_message(protocol::MSG_ERROR, serde_json::to_vec(&err).unwrap_or_default().as_slice()));
                            }
                        }
                    } else {
                        // Local: open .part file
                        match std::fs::File::create(&part_path) {
                            Ok(file) => {
                                *session.active_upload.lock().await = Some(super::session::UploadState {
                                    path,
                                    part_path,
                                    total_size,
                                    received: 0,
                                    sftp_file: None,
                                    local_file: Some(file),
                                    pending_writes: Vec::new(),
                                    pipeline: super::session::AdaptivePipeline::new(),
                                });
                                session.send_to_client(&client_id, protocol::encode_message(protocol::MSG_FILE_UPLOAD_CHUNK, &[]));
                            }
                            Err(e) => {
                                let err = serde_json::json!({"code": "WRITE_FAILED", "message": format!("{}", e)});
                                session.send_to_client(&client_id, protocol::encode_message(protocol::MSG_ERROR, serde_json::to_vec(&err).unwrap_or_default().as_slice()));
                            }
                        }
                    }
                });
            }
        }
        protocol::MSG_FILE_UPLOAD_CHUNK => {
            if !is_master(session, client_id) { return; }
            // [8B totalSize BE][8B offset BE][chunk_data]
            // Processed INLINE (not spawned) to maintain chunk ordering — matches Go.
            //
            // SFTP writes use pipelining: send Write request without waiting for
            // Status response, then drain completed responses on the next chunk.
            // This turns sequential round-trips into overlapped I/O.
            if payload.len() >= 16 {
                let total_size = i64::from_be_bytes(payload[0..8].try_into().unwrap_or([0; 8]));
                let offset = i64::from_be_bytes(payload[8..16].try_into().unwrap_or([0; 8]));
                let chunk_data = &payload[16..];

                let mut guard = session.active_upload.lock().await;
                if let Some(ref mut state) = *guard {
                    // Validate offset and totalSize
                    if offset != state.received || total_size != state.total_size {
                        *guard = None;
                    } else {
                        // --- Drain completed pending writes (non-blocking) ---
                        let mut write_err = false;
                        state.pending_writes.retain_mut(|pw| {
                            match pw.try_wait() {
                                Some(Ok(_)) => { state.pipeline.on_ack(); false }
                                Some(Err(_)) => { write_err = true; false }
                                None => true,
                            }
                        });
                        if write_err {
                            *guard = None;
                            session.send_to_client(client_id, protocol::encode_message(protocol::MSG_FILE_UPLOAD_CHUNK, &[]));
                            return;
                        }

                        // --- Adaptive flow control ---
                        // Pipeline window grows from 2 → 64 via slow-start then linear,
                        // auto-adapting to link latency. Low latency = large window = high throughput.
                        while state.pending_writes.len() >= state.pipeline.window {
                            let pw = state.pending_writes.remove(0);
                            match pw.wait().await {
                                Ok(_) => { state.pipeline.on_ack(); }
                                Err(_) => {
                                    *guard = None;
                                    session.send_to_client(client_id, protocol::encode_message(protocol::MSG_FILE_UPLOAD_CHUNK, &[]));
                                    return;
                                }
                            }
                        }

                        // --- Write chunk ---
                        let write_ok = if let Some(ref mut file) = state.sftp_file {
                            // Pipelined SFTP write: loop to cover data > max_write_len
                            let mut ok = true;
                            let mut pos = 0;
                            while pos < chunk_data.len() {
                                match file.write_no_wait(&chunk_data[pos..]) {
                                    Ok((pw, n)) => {
                                        state.pipeline.on_send();
                                        state.pending_writes.push(pw);
                                        pos += n;
                                    }
                                    Err(_) => { ok = false; break; }
                                }
                            }
                            ok
                        } else if let Some(ref mut file) = state.local_file {
                            // Local write: synchronous (no latency concern)
                            use std::io::Write;
                            file.write_all(chunk_data).is_ok()
                        } else {
                            false
                        };

                        if write_ok {
                            state.received += chunk_data.len() as i64;

                            if state.received >= state.total_size {
                                // Upload complete: flush all pending writes, close, rename
                                let pending = std::mem::take(&mut state.pending_writes);
                                let final_path = state.path.clone();
                                let part_path = state.part_path.clone();
                                state.sftp_file = None;
                                state.local_file = None;
                                drop(guard);

                                // Wait for all in-flight SFTP writes to confirm
                                let mut flush_ok = true;
                                for pw in pending {
                                    if pw.wait().await.is_err() {
                                        flush_ok = false;
                                        break;
                                    }
                                }

                                if flush_ok {
                                    let sftp = session.sftp.lock().unwrap().clone();
                                    if let Some(ref sftp) = sftp {
                                        if sftp.rename(part_path.clone(), final_path.clone()).await.is_err() {
                                            let _ = sftp.remove_file(final_path.clone()).await;
                                            let _ = sftp.rename(part_path.clone(), final_path).await;
                                        }
                                    } else {
                                        let _ = std::fs::remove_file(&final_path);
                                        let _ = std::fs::rename(&part_path, &final_path);
                                    }
                                }
                                *session.active_upload.lock().await = None;

                                // Go sends MsgFileOperationResp on completion, NOT chunk ACK
                                let resp = serde_json::json!({"success": flush_ok});
                                session.send_to_client(client_id, protocol::encode_message(
                                    protocol::MSG_FILE_OPERATION_RESP,
                                    serde_json::to_vec(&resp).unwrap_or_default().as_slice(),
                                ));
                            } else {
                                // More chunks expected — send chunk ACK
                                session.send_to_client(client_id, protocol::encode_message(protocol::MSG_FILE_UPLOAD_CHUNK, &[]));
                            }
                        } else {
                            *guard = None;
                            session.send_to_client(client_id, protocol::encode_message(protocol::MSG_FILE_UPLOAD_CHUNK, &[]));
                        }
                    }
                } else {
                    session.send_to_client(client_id, protocol::encode_message(protocol::MSG_FILE_UPLOAD_CHUNK, &[]));
                }
            }
        }
        protocol::MSG_FILE_UPLOAD_RESUME => {
            if !is_master(session, client_id) { return; }
            // JSON: { "path": "...", "size": N } — check for .meterm.part, return offset
            if let Ok(req) = serde_json::from_slice::<serde_json::Value>(payload) {
                let path = req.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let total_size = req.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
                let client_id = client_id.to_string();
                let session = session.clone();
                tokio::spawn(async move {
                    let sftp = session.sftp.lock().unwrap().clone();
                    let part_path = format!("{}.meterm.part", path);

                    let part_size = if let Some(ref sftp) = sftp {
                        sftp.metadata(part_path.clone()).await.ok().and_then(|m| m.size).map(|s| s as i64)
                    } else {
                        std::fs::metadata(&part_path).ok().map(|m| m.len() as i64)
                    };

                    let Some(part_size) = part_size else {
                        let err = serde_json::json!({"code": "NO_PARTIAL_UPLOAD", "message": "No partial upload found"});
                        session.send_to_client(&client_id, protocol::encode_message(protocol::MSG_ERROR, serde_json::to_vec(&err).unwrap_or_default().as_slice()));
                        return;
                    };

                    if part_size >= total_size {
                        // Stale — remove
                        if let Some(ref sftp) = sftp {
                            let _ = sftp.remove_file(part_path).await;
                        } else {
                            let _ = std::fs::remove_file(&part_path);
                        }
                        let err = serde_json::json!({"code": "NO_PARTIAL_UPLOAD", "message": "Partial file already complete"});
                        session.send_to_client(&client_id, protocol::encode_message(protocol::MSG_ERROR, serde_json::to_vec(&err).unwrap_or_default().as_slice()));
                        return;
                    }

                    // Open for append
                    let (sftp_file, local_file) = if let Some(ref sftp) = sftp {
                        match sftp.open(part_path.clone()).await {
                            Ok(f) => (Some(f), None),
                            Err(e) => {
                                let err = serde_json::json!({"code": "WRITE_FAILED", "message": format!("{}", e)});
                                session.send_to_client(&client_id, protocol::encode_message(protocol::MSG_ERROR, serde_json::to_vec(&err).unwrap_or_default().as_slice()));
                                return;
                            }
                        }
                    } else {
                        match std::fs::OpenOptions::new().append(true).open(&part_path) {
                            Ok(f) => (None, Some(f)),
                            Err(e) => {
                                let err = serde_json::json!({"code": "WRITE_FAILED", "message": format!("{}", e)});
                                session.send_to_client(&client_id, protocol::encode_message(protocol::MSG_ERROR, serde_json::to_vec(&err).unwrap_or_default().as_slice()));
                                return;
                            }
                        }
                    };

                    *session.active_upload.lock().await = Some(super::session::UploadState {
                        path,
                        part_path,
                        total_size,
                        received: part_size,
                        sftp_file,
                        local_file,
                        pending_writes: Vec::new(),
                                    pipeline: super::session::AdaptivePipeline::new(),
                    });

                    // Resume ACK: 8-byte offset (matches Go)
                    let offset_payload = (part_size as u64).to_be_bytes();
                    session.send_to_client(&client_id, protocol::encode_message(protocol::MSG_FILE_UPLOAD_CHUNK, &offset_payload));
                });
            }
        }
        protocol::MSG_FILE_DOWNLOAD_PAUSE => {
            if !is_master(session, client_id) { return; }
            if let Some(ref tx) = *session.download_ctrl.lock().await {
                let _ = tx.try_send(super::session::DownloadSignal::Pause);
            }
        }
        protocol::MSG_FILE_DOWNLOAD_CONTINUE => {
            if !is_master(session, client_id) { return; }
            if let Some(ref tx) = *session.download_ctrl.lock().await {
                let _ = tx.try_send(super::session::DownloadSignal::Continue);
            }
        }
        protocol::MSG_FILE_DOWNLOAD_CANCEL => {
            if !is_master(session, client_id) { return; }
            if let Some(ref tx) = *session.download_ctrl.lock().await {
                let _ = tx.try_send(super::session::DownloadSignal::Cancel);
            }
        }
        protocol::MSG_FILE_DOWNLOAD_RESUME => {
            if !is_master(session, client_id) { return; }
            // JSON: { "path": "...", "offset": N } — seek to offset and resume
            if let Ok(req) = serde_json::from_slice::<serde_json::Value>(payload) {
                let path = req.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let offset = req.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
                if !path.is_empty() {
                    let (ctrl_tx, ctrl_rx) = tokio::sync::mpsc::channel::<super::session::DownloadSignal>(4);
                    *session.download_ctrl.lock().await = Some(ctrl_tx);
                    let client_id = client_id.to_string();
                    let session = session.clone();
                    let sftp = session.sftp.lock().unwrap().clone();
                    tokio::spawn(async move {
                        if let Some(sftp) = sftp {
                            handle_sftp_file_download(&session, &client_id, &path, offset, &sftp, ctrl_rx).await;
                        } else {
                            handle_local_file_download(&session, &client_id, &path, offset, ctrl_rx).await;
                        }
                        *session.download_ctrl.lock().await = None;
                    });
                }
            }
        }
        protocol::MSG_PAIR_APPROVAL => {
            // Only master can approve pairing (matches Go)
            if !is_master(session, client_id) { return; }
            if payload.len() >= 2 {
                let approved = payload[0] == 1;
                if let Ok(pair_id) = std::str::from_utf8(&payload[1..]) {
                    _state.pairing_manager.handle_approval(approved, pair_id);
                }
            }
        }
        _ => {
            // Unknown message type — ignore
        }
    }
}

/// Check download control channel — returns true if cancelled.
/// If paused, blocks until continue or cancel. Matches Go waitDownloadCtrl.
async fn wait_download_ctrl(ctrl: &mut tokio::sync::mpsc::Receiver<super::session::DownloadSignal>) -> bool {
    use super::session::DownloadSignal;
    loop {
        match ctrl.try_recv() {
            Ok(DownloadSignal::Cancel) => return true,
            Ok(DownloadSignal::Pause) => {
                // Block until continue or cancel
                loop {
                    match ctrl.recv().await {
                        Some(DownloadSignal::Continue) => return false,
                        Some(DownloadSignal::Cancel) => return true,
                        None => return true,
                        _ => {}
                    }
                }
            }
            _ => return false, // No signal or Continue
        }
    }
}

async fn handle_local_file_download(
    session: &super::session::Session,
    client_id: &str,
    path: &str,
    start_offset: u64,
    mut ctrl: tokio::sync::mpsc::Receiver<super::session::DownloadSignal>,
) {
    const CHUNK_SIZE: usize = 1024 * 1024;

    let meta = match tokio::fs::metadata(path).await {
        Ok(m) => m,
        Err(e) => {
            session.send_to_client(
                client_id,
                protocol::encode_error(protocol::ERR_INTERNAL, &format!("stat: {}", e)),
            );
            return;
        }
    };

    let total_size = meta.len();
    let mut file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(e) => {
            session.send_to_client(
                client_id,
                protocol::encode_error(protocol::ERR_INTERNAL, &format!("open: {}", e)),
            );
            return;
        }
    };

    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    if start_offset > 0 {
        let _ = file.seek(std::io::SeekFrom::Start(start_offset)).await;
    }
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut offset: u64 = start_offset;

    while offset < total_size {
        if wait_download_ctrl(&mut ctrl).await { return; }

        let n = match file.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                session.send_to_client(
                    client_id,
                    protocol::encode_error(protocol::ERR_INTERNAL, &format!("read: {}", e)),
                );
                return;
            }
        };

        // Build chunk: [8B total][8B offset][data]
        let mut chunk_payload = Vec::with_capacity(16 + n);
        chunk_payload.extend_from_slice(&total_size.to_be_bytes());
        chunk_payload.extend_from_slice(&offset.to_be_bytes());
        chunk_payload.extend_from_slice(&buf[..n]);

        session.send_to_client(
            client_id,
            protocol::encode_message(protocol::MSG_FILE_DOWNLOAD_CHUNK, &chunk_payload),
        );

        offset += n as u64;
    }
}

/// Chunked SFTP file download with pipelined reads.
///
/// Sends multiple SSH_FXP_READ requests at once (PIPELINE_DEPTH), then
/// collects responses in order and forwards to WebSocket. This turns
/// N sequential round-trips into ~1 round-trip per batch, dramatically
/// improving throughput on high-latency links.
async fn handle_sftp_file_download(
    session: &super::session::Session,
    client_id: &str,
    path: &str,
    _start_offset: u64,
    sftp: &russh_sftp::client::SftpSession,
    mut ctrl: tokio::sync::mpsc::Receiver<super::session::DownloadSignal>,
) {
    // Get file size
    let meta = match sftp.metadata(path.to_string()).await {
        Ok(m) => m,
        Err(e) => {
            session.send_to_client(client_id, protocol::encode_error(protocol::ERR_INTERNAL, &format!("stat: {}", e)));
            return;
        }
    };
    let total_size = meta.size.unwrap_or(0);

    // Open file
    let mut file = match sftp.open(path.to_string()).await {
        Ok(f) => f,
        Err(e) => {
            session.send_to_client(client_id, protocol::encode_error(protocol::ERR_INTERNAL, &format!("open: {}", e)));
            return;
        }
    };

    let mut offset: u64 = 0;
    let mut pipeline = super::session::AdaptivePipeline::new();

    while offset < total_size {
        if wait_download_ctrl(&mut ctrl).await { return; }

        // Read a batch using adaptive pipeline depth (grows 2 → 64)
        let remaining_chunks = ((total_size - offset + 261119) / 261120) as usize;
        let batch_size = pipeline.window.min(remaining_chunks).max(1);

        let start = std::time::Instant::now();
        let chunks = match file.read_pipelined(batch_size).await {
            Ok(c) => c,
            Err(e) => {
                session.send_to_client(client_id, protocol::encode_error(protocol::ERR_INTERNAL, &format!("read: {}", e)));
                return;
            }
        };
        // Measure batch RTT and grow window
        let _batch_rtt = start.elapsed();
        for _ in 0..chunks.len() {
            pipeline.on_ack();
        }

        if chunks.is_empty() {
            break;
        }

        for chunk_data in chunks {
            let mut chunk_payload = Vec::with_capacity(16 + chunk_data.len());
            chunk_payload.extend_from_slice(&total_size.to_be_bytes());
            chunk_payload.extend_from_slice(&offset.to_be_bytes());
            chunk_payload.extend_from_slice(&chunk_data);
            session.send_to_client(client_id, protocol::encode_message(protocol::MSG_FILE_DOWNLOAD_CHUNK, &chunk_payload));
            offset += chunk_data.len() as u64;
        }
    }
}
