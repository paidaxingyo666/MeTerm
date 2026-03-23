//! Message dispatch — shared by WebSocket handler and local IPC commands.
//!
//! Processes incoming binary frames `[MsgType: u8][Payload]` and routes
//! them to the appropriate session/file handler.

use std::sync::Arc;

use super::protocol;
use super::session::Session;
use super::ServerState;

/// Check if the client is master for this session.
pub fn is_master(session: &Session, client_id: &str) -> bool {
    session.master() == client_id
}

/// Validate a file path (absolute, max 4096 chars).
pub fn validate_path(path: &str) -> Result<(), &'static str> {
    let cleaned = path.replace("\\", "/");
    if !cleaned.starts_with('/') {
        return Err("path must be absolute");
    }
    if cleaned.len() > 4096 {
        return Err("path too long");
    }
    Ok(())
}

/// Dispatch a single incoming message to the appropriate handler.
pub async fn dispatch_message(
    session: &Arc<Session>,
    client_id: &str,
    msg_type: u8,
    payload: &[u8],
    state: &ServerState,
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
            handle_ping(session, client_id).await;
        }
        protocol::MSG_NUDGE => {
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
                        *session_clone.download_ctrl.lock().await = None;
                    });
                }
            }
        }
        protocol::MSG_FILE_UPLOAD_START => {
            if !is_master(session, client_id) { return; }
            handle_upload_start(session, client_id, payload).await;
        }
        protocol::MSG_FILE_UPLOAD_CHUNK => {
            if !is_master(session, client_id) { return; }
            handle_upload_chunk(session, client_id, payload).await;
        }
        protocol::MSG_FILE_UPLOAD_RESUME => {
            if !is_master(session, client_id) { return; }
            handle_upload_resume(session, client_id, payload).await;
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
            if !is_master(session, client_id) { return; }
            if payload.len() >= 2 {
                let approved = payload[0] == 1;
                if let Ok(pair_id) = std::str::from_utf8(&payload[1..]) {
                    state.pairing_manager.handle_approval(approved, pair_id);
                }
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Ping handler
// ---------------------------------------------------------------------------

async fn handle_ping(session: &Arc<Session>, client_id: &str) {
    let exec_type = session.executor_type.lock().unwrap().clone();
    if exec_type == "ssh" {
        if let Some(handle) = session.ssh_exec_handle.lock().await.as_ref() {
            if let Some(ssh_handle) = handle.downcast_ref::<std::sync::Arc<tokio::sync::Mutex<Option<russh::client::Handle<super::terminal::ssh::SshHandler>>>>>() {
                let start = std::time::Instant::now();
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

// ---------------------------------------------------------------------------
// Upload handlers
// ---------------------------------------------------------------------------

async fn handle_upload_start(session: &Arc<Session>, client_id: &str, payload: &[u8]) {
    if let Ok(req) = serde_json::from_slice::<serde_json::Value>(payload) {
        let path = req.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let total_size = req.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
        let client_id = client_id.to_string();
        let session = session.clone();
        tokio::spawn(async move {
            let sftp = session.sftp.lock().unwrap().clone();

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

            let part_path = format!("{}.meterm.part", path);
            if let Some(ref sftp) = sftp {
                match sftp.create(part_path.clone()).await {
                    Ok(file) => {
                        *session.active_upload.lock().await = Some(super::session::UploadState {
                            path, part_path, total_size, received: 0,
                            sftp_file: Some(file), local_file: None,
                            pending_writes: Vec::new(),
                            pipeline: super::session::AdaptivePipeline::new(),
                        });
                        session.send_to_client(&client_id, protocol::encode_message(protocol::MSG_FILE_UPLOAD_CHUNK, &[]));
                    }
                    Err(e) => {
                        let err = serde_json::json!({"code": "WRITE_FAILED", "message": format!("create part: {}", e)});
                        session.send_to_client(&client_id, protocol::encode_message(protocol::MSG_ERROR, serde_json::to_vec(&err).unwrap_or_default().as_slice()));
                    }
                }
            } else {
                match std::fs::File::create(&part_path) {
                    Ok(file) => {
                        *session.active_upload.lock().await = Some(super::session::UploadState {
                            path, part_path, total_size, received: 0,
                            sftp_file: None, local_file: Some(file),
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

async fn handle_upload_chunk(session: &Arc<Session>, client_id: &str, payload: &[u8]) {
    if payload.len() < 16 { return; }
    let total_size = i64::from_be_bytes(payload[0..8].try_into().unwrap_or([0; 8]));
    let offset = i64::from_be_bytes(payload[8..16].try_into().unwrap_or([0; 8]));
    let chunk_data = &payload[16..];

    let mut guard = session.active_upload.lock().await;
    if let Some(ref mut state) = *guard {
        if offset != state.received || total_size != state.total_size {
            *guard = None;
        } else {
            // Drain completed pending writes
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

            // Adaptive flow control
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

            // Write chunk
            let write_ok = if let Some(ref mut file) = state.sftp_file {
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
                use std::io::Write;
                file.write_all(chunk_data).is_ok()
            } else {
                false
            };

            if write_ok {
                state.received += chunk_data.len() as i64;
                if state.received >= state.total_size {
                    let pending = std::mem::take(&mut state.pending_writes);
                    let final_path = state.path.clone();
                    let part_path = state.part_path.clone();
                    state.sftp_file = None;
                    state.local_file = None;
                    drop(guard);

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

                    let resp = serde_json::json!({"success": flush_ok});
                    session.send_to_client(client_id, protocol::encode_message(
                        protocol::MSG_FILE_OPERATION_RESP,
                        serde_json::to_vec(&resp).unwrap_or_default().as_slice(),
                    ));
                } else {
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

async fn handle_upload_resume(session: &Arc<Session>, client_id: &str, payload: &[u8]) {
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
                if let Some(ref sftp) = sftp {
                    let _ = sftp.remove_file(part_path).await;
                } else {
                    let _ = std::fs::remove_file(&part_path);
                }
                let err = serde_json::json!({"code": "NO_PARTIAL_UPLOAD", "message": "Partial file already complete"});
                session.send_to_client(&client_id, protocol::encode_message(protocol::MSG_ERROR, serde_json::to_vec(&err).unwrap_or_default().as_slice()));
                return;
            }

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
                path, part_path, total_size, received: part_size,
                sftp_file, local_file, pending_writes: Vec::new(),
                pipeline: super::session::AdaptivePipeline::new(),
            });

            let offset_payload = (part_size as u64).to_be_bytes();
            session.send_to_client(&client_id, protocol::encode_message(protocol::MSG_FILE_UPLOAD_CHUNK, &offset_payload));
        });
    }
}

// ---------------------------------------------------------------------------
// Download handlers
// ---------------------------------------------------------------------------

/// Check download control channel — returns true if cancelled.
pub async fn wait_download_ctrl(ctrl: &mut tokio::sync::mpsc::Receiver<super::session::DownloadSignal>) -> bool {
    use super::session::DownloadSignal;
    loop {
        match ctrl.try_recv() {
            Ok(DownloadSignal::Cancel) => return true,
            Ok(DownloadSignal::Pause) => {
                loop {
                    match ctrl.recv().await {
                        Some(DownloadSignal::Continue) => return false,
                        Some(DownloadSignal::Cancel) => return true,
                        None => return true,
                        _ => {}
                    }
                }
            }
            _ => return false,
        }
    }
}

pub async fn handle_local_file_download(
    session: &Session,
    client_id: &str,
    path: &str,
    start_offset: u64,
    mut ctrl: tokio::sync::mpsc::Receiver<super::session::DownloadSignal>,
) {
    const CHUNK_SIZE: usize = 1024 * 1024;

    let meta = match tokio::fs::metadata(path).await {
        Ok(m) => m,
        Err(e) => {
            session.send_to_client(client_id, protocol::encode_error(protocol::ERR_INTERNAL, &format!("stat: {}", e)));
            return;
        }
    };

    let total_size = meta.len();
    let mut file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(e) => {
            session.send_to_client(client_id, protocol::encode_error(protocol::ERR_INTERNAL, &format!("open: {}", e)));
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
                session.send_to_client(client_id, protocol::encode_error(protocol::ERR_INTERNAL, &format!("read: {}", e)));
                return;
            }
        };

        let mut chunk_payload = Vec::with_capacity(16 + n);
        chunk_payload.extend_from_slice(&total_size.to_be_bytes());
        chunk_payload.extend_from_slice(&offset.to_be_bytes());
        chunk_payload.extend_from_slice(&buf[..n]);

        if !session.send_to_client_async(
            client_id,
            protocol::encode_message(protocol::MSG_FILE_DOWNLOAD_CHUNK, &chunk_payload),
        ).await {
            return;
        }

        offset += n as u64;
    }
}

pub async fn handle_sftp_file_download(
    session: &Session,
    client_id: &str,
    path: &str,
    _start_offset: u64,
    sftp: &russh_sftp::client::SftpSession,
    mut ctrl: tokio::sync::mpsc::Receiver<super::session::DownloadSignal>,
) {
    let meta = match sftp.metadata(path.to_string()).await {
        Ok(m) => m,
        Err(e) => {
            session.send_to_client(client_id, protocol::encode_error(protocol::ERR_INTERNAL, &format!("stat: {}", e)));
            return;
        }
    };
    let total_size = meta.size.unwrap_or(0);

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
        let _batch_rtt = start.elapsed();
        for _ in 0..chunks.len() {
            pipeline.on_ack();
        }

        if chunks.is_empty() { break; }

        for chunk_data in chunks {
            let mut chunk_payload = Vec::with_capacity(16 + chunk_data.len());
            chunk_payload.extend_from_slice(&total_size.to_be_bytes());
            chunk_payload.extend_from_slice(&offset.to_be_bytes());
            chunk_payload.extend_from_slice(&chunk_data);
            if !session.send_to_client_async(client_id, protocol::encode_message(protocol::MSG_FILE_DOWNLOAD_CHUNK, &chunk_payload)).await {
                return;
            }
            offset += chunk_data.len() as u64;
        }
    }
}
