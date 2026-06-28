//! Message dispatch — shared by WebSocket handler and local IPC commands.
//!
//! Processes incoming binary frames `[MsgType: u8][Payload]` and routes
//! them to the appropriate session/file handler.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

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
            if !is_master(session, client_id) {
                return;
            }
            let sftp = session.sftp.lock().unwrap().clone();
            if let Some(sftp) = sftp {
                let client_id = client_id.to_string();
                let session = session.clone();
                let payload = payload.to_vec();
                tokio::spawn(async move {
                    super::file_handler::handle_sftp_file_list_with_progress(
                        &payload, &sftp, &session, &client_id,
                    )
                    .await;
                });
            } else {
                let is_ssh = *session.executor_type.lock().unwrap() == "ssh";
                if is_ssh {
                    // SSH 会话 SFTP 未就绪，返回错误而非回退到本地文件系统。
                    // 如果初始化阶段失败过，把具体原因带回前端而不是只说 "retry"。
                    let detail = session
                        .sftp_init_error
                        .lock()
                        .unwrap()
                        .clone()
                        .unwrap_or_else(|| {
                            "SFTP subsystem not ready yet, please retry".to_string()
                        });
                    let err = serde_json::json!({
                        "code": "SFTP_NOT_AVAILABLE",
                        "message": detail,
                    });
                    session.send_to_client(
                        client_id,
                        super::protocol::encode_message(
                            super::protocol::MSG_ERROR,
                            serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                        ),
                    );
                } else {
                    let resp = super::file_handler::handle_file_list(payload);
                    session.send_to_client(client_id, resp);
                }
            }
        }
        protocol::MSG_FILE_SEARCH => {
            if !is_master(session, client_id) {
                return;
            }
            let sftp = session.sftp.lock().unwrap().clone();
            let client_id = client_id.to_string();
            let session = session.clone();
            let payload = payload.to_vec();
            if let Some(sftp) = sftp {
                // SFTP (SSH / JumpServer): async recursive read_dir walk.
                tokio::spawn(async move {
                    super::file_search::handle_sftp_file_search(&payload, &sftp, &session, &client_id).await;
                });
            } else {
                // Local filesystem: blocking walkdir on a blocking thread.
                tokio::task::spawn_blocking(move || {
                    super::file_search::handle_local_file_search(&payload, &session, &client_id);
                });
            }
        }
        protocol::MSG_FILE_OPERATION => {
            let is_stat = serde_json::from_slice::<serde_json::Value>(payload)
                .ok()
                .and_then(|v| {
                    v.get("operation")
                        .and_then(|o| o.as_str())
                        .map(|s| s == "stat")
                })
                .unwrap_or(false);
            if !is_stat && !is_master(session, client_id) {
                return;
            }
            let sftp = session.sftp.lock().unwrap().clone();
            if let Some(sftp) = sftp {
                let client_id = client_id.to_string();
                let session = session.clone();
                let payload = payload.to_vec();
                tokio::spawn(async move {
                    let resp =
                        super::file_handler::handle_sftp_file_operation(&payload, &sftp).await;
                    let resp = super::file_handler::maybe_upgrade_sftp_auth_error(resp);
                    session.send_to_client(&client_id, resp);
                });
            } else {
                let resp = super::file_handler::handle_file_operation(payload);
                session.send_to_client(client_id, resp);
            }
        }
        protocol::MSG_FILE_READ_REQUEST => {
            if !is_master(session, client_id) {
                return;
            }
            let sftp = session.sftp.lock().unwrap().clone();
            if let Some(sftp) = sftp {
                let payload = payload.to_vec();
                let client_id = client_id.to_string();
                let session = session.clone();
                tokio::spawn(async move {
                    let resp = super::file_handler::handle_sftp_file_read(&payload, &sftp).await;
                    let resp = super::file_handler::maybe_upgrade_sftp_auth_error(resp);
                    session.send_to_client(&client_id, resp);
                });
            } else {
                let resp = super::file_handler::handle_file_read_json(payload);
                session.send_to_client(client_id, resp);
            }
        }
        protocol::MSG_FILE_SAVE_REQUEST => {
            if !is_master(session, client_id) {
                return;
            }
            let sftp = session.sftp.lock().unwrap().clone();
            if let Some(sftp) = sftp {
                let payload = payload.to_vec();
                let client_id = client_id.to_string();
                let session = session.clone();
                tokio::spawn(async move {
                    let resp = super::file_handler::handle_sftp_file_save(&payload, &sftp).await;
                    let resp = super::file_handler::maybe_upgrade_sftp_auth_error(resp);
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
            if !is_master(session, client_id) {
                return;
            }
            if let Ok(req) = serde_json::from_slice::<serde_json::Value>(payload) {
                let path = req
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let transfer_id =
                    req.get("transferId").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                if !path.is_empty() {
                    eprintln!(
                        "[download] start path={:?} transfer_id={}",
                        path, transfer_id
                    );
                    let (ctrl_tx, ctrl_rx) =
                        tokio::sync::mpsc::channel::<super::session::DownloadSignal>(4);
                    session
                        .download_ctrls
                        .lock()
                        .await
                        .insert(transfer_id, ctrl_tx);
                    let client_id_clone = client_id.to_string();
                    let session_clone = session.clone();
                    let sftp = session.sftp.lock().unwrap().clone();
                    tokio::spawn(async move {
                        if let Some(sftp) = sftp {
                            handle_sftp_file_download(
                                &session_clone,
                                &client_id_clone,
                                &path,
                                0,
                                &sftp,
                                ctrl_rx,
                                transfer_id,
                            )
                            .await;
                        } else {
                            handle_local_file_download(
                                &session_clone,
                                &client_id_clone,
                                &path,
                                0,
                                ctrl_rx,
                                transfer_id,
                            )
                            .await;
                        }
                        session_clone
                            .download_ctrls
                            .lock()
                            .await
                            .remove(&transfer_id);
                    });
                }
            }
        }
        protocol::MSG_FILE_UPLOAD_START => {
            if !is_master(session, client_id) {
                return;
            }
            handle_upload_start(session, client_id, payload).await;
        }
        protocol::MSG_FILE_UPLOAD_CHUNK => {
            if !is_master(session, client_id) {
                return;
            }
            handle_upload_chunk(session, client_id, payload).await;
        }
        protocol::MSG_FILE_UPLOAD_RESUME => {
            if !is_master(session, client_id) {
                return;
            }
            handle_upload_resume(session, client_id, payload).await;
        }
        protocol::MSG_FILE_DOWNLOAD_PAUSE => {
            if !is_master(session, client_id) {
                return;
            }
            let transfer_id = serde_json::from_slice::<serde_json::Value>(payload)
                .ok()
                .and_then(|v| v.get("transferId").and_then(|t| t.as_u64()))
                .unwrap_or(0) as u32;
            if let Some(tx) = session.download_ctrls.lock().await.get(&transfer_id) {
                let _ = tx.try_send(super::session::DownloadSignal::Pause);
            }
        }
        protocol::MSG_FILE_DOWNLOAD_CONTINUE => {
            if !is_master(session, client_id) {
                return;
            }
            let transfer_id = serde_json::from_slice::<serde_json::Value>(payload)
                .ok()
                .and_then(|v| v.get("transferId").and_then(|t| t.as_u64()))
                .unwrap_or(0) as u32;
            if let Some(tx) = session.download_ctrls.lock().await.get(&transfer_id) {
                let _ = tx.try_send(super::session::DownloadSignal::Continue);
            }
        }
        protocol::MSG_FILE_DOWNLOAD_CANCEL => {
            if !is_master(session, client_id) {
                return;
            }
            let transfer_id = serde_json::from_slice::<serde_json::Value>(payload)
                .ok()
                .and_then(|v| v.get("transferId").and_then(|t| t.as_u64()))
                .unwrap_or(0) as u32;
            if let Some(tx) = session.download_ctrls.lock().await.get(&transfer_id) {
                let _ = tx.try_send(super::session::DownloadSignal::Cancel);
            }
        }
        protocol::MSG_FILE_DOWNLOAD_RESUME => {
            if !is_master(session, client_id) {
                return;
            }
            if let Ok(req) = serde_json::from_slice::<serde_json::Value>(payload) {
                let path = req
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let offset = req.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
                let transfer_id =
                    req.get("transferId").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                if !path.is_empty() {
                    let (ctrl_tx, ctrl_rx) =
                        tokio::sync::mpsc::channel::<super::session::DownloadSignal>(4);
                    session
                        .download_ctrls
                        .lock()
                        .await
                        .insert(transfer_id, ctrl_tx);
                    let client_id = client_id.to_string();
                    let session = session.clone();
                    let sftp = session.sftp.lock().unwrap().clone();
                    tokio::spawn(async move {
                        if let Some(sftp) = sftp {
                            handle_sftp_file_download(
                                &session,
                                &client_id,
                                &path,
                                offset,
                                &sftp,
                                ctrl_rx,
                                transfer_id,
                            )
                            .await;
                        } else {
                            handle_local_file_download(
                                &session,
                                &client_id,
                                &path,
                                offset,
                                ctrl_rx,
                                transfer_id,
                            )
                            .await;
                        }
                        session.download_ctrls.lock().await.remove(&transfer_id);
                    });
                }
            }
        }
        protocol::MSG_PAIR_APPROVAL => {
            if !is_master(session, client_id) {
                return;
            }
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
            if let Some(ssh_handle) = handle.downcast_ref::<std::sync::Arc<
                tokio::sync::Mutex<Option<russh::client::Handle<super::terminal::ssh::SshHandler>>>,
            >>() {
                let start = std::time::Instant::now();
                let mut guard = ssh_handle.lock().await;
                if let Some(ref mut sess) = *guard {
                    match tokio::time::timeout(
                        std::time::Duration::from_secs(10),
                        sess.channel_open_session(),
                    )
                    .await
                    {
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
        let path = req
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let total_size = req.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
        let transfer_id = req.get("transferId").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let sftp = session.sftp.lock().unwrap().clone();

        if total_size == 0 {
            if let Some(ref sftp) = sftp {
                match sftp.create(path.clone()).await {
                    Ok(_) => {
                        let resp = serde_json::json!({"success": true, "transferId": transfer_id});
                        session.send_to_client(
                            client_id,
                            protocol::encode_message(
                                protocol::MSG_FILE_OPERATION_RESP,
                                serde_json::to_vec(&resp).unwrap_or_default().as_slice(),
                            ),
                        );
                    }
                    Err(e) => {
                        let err = serde_json::json!({"code": "WRITE_FAILED", "message": format!("Failed to create file: {}", e), "transferId": transfer_id});
                        super::file_handler::send_sftp_error(
                            &session,
                            client_id,
                            protocol::encode_message(
                                protocol::MSG_ERROR,
                                serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                            ),
                        );
                    }
                }
            } else {
                let ok = std::fs::File::create(&path).is_ok();
                let resp = if ok {
                    serde_json::json!({"success": true, "transferId": transfer_id})
                } else {
                    serde_json::json!({"ok": false, "error": "Failed to create file", "transferId": transfer_id})
                };
                session.send_to_client(
                    client_id,
                    protocol::encode_message(
                        protocol::MSG_FILE_OPERATION_RESP,
                        serde_json::to_vec(&resp).unwrap_or_default().as_slice(),
                    ),
                );
            }
            return;
        }

        let part_path = format!("{}.meterm.part", path);
        if let Some(ref sftp) = sftp {
            match sftp.create(part_path.clone()).await {
                Ok(file) => {
                    session.active_uploads.lock().await.insert(
                        transfer_id,
                        super::session::UploadState {
                            path,
                            part_path,
                            total_size,
                            received: 0,
                            sftp_file: Some(file),
                            local_file: None,
                            pending_writes: Vec::new(),
                            pipeline: super::session::AdaptivePipeline::new(),
                        },
                    );
                    let mut ack = Vec::with_capacity(4);
                    ack.extend_from_slice(&transfer_id.to_be_bytes());
                    session.send_to_client(
                        client_id,
                        protocol::encode_message(protocol::MSG_FILE_UPLOAD_CHUNK, &ack),
                    );
                }
                Err(e) => {
                    let err = serde_json::json!({"code": "WRITE_FAILED", "message": format!("create part: {}", e), "transferId": transfer_id});
                    super::file_handler::send_sftp_error(
                        &session,
                        client_id,
                        protocol::encode_message(
                            protocol::MSG_ERROR,
                            serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                        ),
                    );
                }
            }
        } else {
            match std::fs::File::create(&part_path) {
                Ok(file) => {
                    session.active_uploads.lock().await.insert(
                        transfer_id,
                        super::session::UploadState {
                            path,
                            part_path,
                            total_size,
                            received: 0,
                            sftp_file: None,
                            local_file: Some(file),
                            pending_writes: Vec::new(),
                            pipeline: super::session::AdaptivePipeline::new(),
                        },
                    );
                    let mut ack = Vec::with_capacity(4);
                    ack.extend_from_slice(&transfer_id.to_be_bytes());
                    session.send_to_client(
                        client_id,
                        protocol::encode_message(protocol::MSG_FILE_UPLOAD_CHUNK, &ack),
                    );
                }
                Err(e) => {
                    let err = serde_json::json!({"code": "WRITE_FAILED", "message": format!("{}", e), "transferId": transfer_id});
                    session.send_to_client(
                        client_id,
                        protocol::encode_message(
                            protocol::MSG_ERROR,
                            serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                        ),
                    );
                }
            }
        }
    }
}

async fn handle_upload_chunk(session: &Arc<Session>, client_id: &str, payload: &[u8]) {
    // New format: [4B transferId][8B totalSize][8B offset][data]
    if payload.len() < 20 {
        return;
    }
    let transfer_id = u32::from_be_bytes(payload[0..4].try_into().unwrap());
    let total_size = i64::from_be_bytes(payload[4..12].try_into().unwrap_or([0; 8]));
    let offset = i64::from_be_bytes(payload[12..20].try_into().unwrap_or([0; 8]));
    let chunk_data = &payload[20..];

    let mut guard = session.active_uploads.lock().await;
    if let Some(state) = guard.get_mut(&transfer_id) {
        if offset != state.received || total_size != state.total_size {
            eprintln!(
                "Upload offset mismatch: expected offset={} size={}, got offset={} size={}",
                state.received, state.total_size, offset, total_size
            );
            guard.remove(&transfer_id);
            drop(guard);
            let resp = serde_json::json!({"success": false, "message": "Upload offset mismatch, upload aborted", "transferId": transfer_id});
            session.send_to_client(
                client_id,
                protocol::encode_message(
                    protocol::MSG_FILE_OPERATION_RESP,
                    serde_json::to_vec(&resp).unwrap_or_default().as_slice(),
                ),
            );
            return;
        } else {
            // Drain completed pending writes
            let mut write_err = false;
            state.pending_writes.retain_mut(|pw| match pw.try_wait() {
                Some(Ok(_)) => {
                    state.pipeline.on_ack();
                    false
                }
                Some(Err(_)) => {
                    write_err = true;
                    false
                }
                None => true,
            });
            if write_err {
                guard.remove(&transfer_id);
                drop(guard);
                let err = serde_json::json!({"code": "WRITE_FAILED", "message": "Write error during upload (pending flush)", "transferId": transfer_id});
                super::file_handler::send_sftp_error(
                    &session,
                    client_id,
                    protocol::encode_message(
                        protocol::MSG_ERROR,
                        serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                    ),
                );
                return;
            }

            // Adaptive flow control
            while state.pending_writes.len() >= state.pipeline.window {
                let pw = state.pending_writes.remove(0);
                match pw.wait().await {
                    Ok(_) => {
                        state.pipeline.on_ack();
                    }
                    Err(_) => {
                        guard.remove(&transfer_id);
                        drop(guard);
                        let err = serde_json::json!({"code": "WRITE_FAILED", "message": "Write error during upload (flow control)", "transferId": transfer_id});
                        super::file_handler::send_sftp_error(
                            &session,
                            client_id,
                            protocol::encode_message(
                                protocol::MSG_ERROR,
                                serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                            ),
                        );
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
                        Err(_) => {
                            ok = false;
                            break;
                        }
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
                    guard.remove(&transfer_id);
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
                            if sftp
                                .rename(part_path.clone(), final_path.clone())
                                .await
                                .is_err()
                            {
                                let _ = sftp.remove_file(final_path.clone()).await;
                                let _ = sftp.rename(part_path.clone(), final_path).await;
                            }
                        } else {
                            let _ = std::fs::remove_file(&final_path);
                            let _ = std::fs::rename(&part_path, &final_path);
                        }
                    }

                    let resp = serde_json::json!({"success": flush_ok, "transferId": transfer_id});
                    session.send_to_client(
                        client_id,
                        protocol::encode_message(
                            protocol::MSG_FILE_OPERATION_RESP,
                            serde_json::to_vec(&resp).unwrap_or_default().as_slice(),
                        ),
                    );
                } else {
                    let mut ack = Vec::with_capacity(4);
                    ack.extend_from_slice(&transfer_id.to_be_bytes());
                    session.send_to_client(
                        client_id,
                        protocol::encode_message(protocol::MSG_FILE_UPLOAD_CHUNK, &ack),
                    );
                }
            } else {
                guard.remove(&transfer_id);
                drop(guard);
                let err = serde_json::json!({"code": "WRITE_FAILED", "message": "Write failed during upload chunk", "transferId": transfer_id});
                super::file_handler::send_sftp_error(
                    &session,
                    client_id,
                    protocol::encode_message(
                        protocol::MSG_ERROR,
                        serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                    ),
                );
            }
        }
    } else {
        // No active upload for this transferId — silently discard stale in-flight chunk
        eprintln!(
            "Upload chunk received but no active upload for transferId={}, ignoring",
            transfer_id
        );
    }
}

async fn handle_upload_resume(session: &Arc<Session>, client_id: &str, payload: &[u8]) {
    if let Ok(req) = serde_json::from_slice::<serde_json::Value>(payload) {
        let path = req
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let total_size = req.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
        let transfer_id = req.get("transferId").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
        let sftp = session.sftp.lock().unwrap().clone();
        let part_path = format!("{}.meterm.part", path);

        let part_size = if let Some(ref sftp) = sftp {
            match sftp.metadata(part_path.clone()).await {
                Ok(m) => m.size.map(|s| s as i64),
                Err(e) => {
                    let err_str = format!("{}", e);
                    // Auth failure → surface as SFTP auth error, not "no partial upload"
                    if super::file_handler::is_sftp_auth_error(&err_str) {
                        let err = serde_json::json!({"code": "WRITE_FAILED", "message": err_str, "transferId": transfer_id});
                        super::file_handler::send_sftp_error(
                            &session,
                            client_id,
                            protocol::encode_message(
                                protocol::MSG_ERROR,
                                serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                            ),
                        );
                        return;
                    }
                    // Legitimate "no partial upload" (ENOENT etc.)
                    None
                }
            }
        } else {
            std::fs::metadata(&part_path).ok().map(|m| m.len() as i64)
        };

        let Some(part_size) = part_size else {
            let err = serde_json::json!({"code": "NO_PARTIAL_UPLOAD", "message": "No partial upload found", "transferId": transfer_id});
            session.send_to_client(
                client_id,
                protocol::encode_message(
                    protocol::MSG_ERROR,
                    serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                ),
            );
            return;
        };

        if part_size >= total_size {
            if let Some(ref sftp) = sftp {
                let _ = sftp.remove_file(part_path).await;
            } else {
                let _ = std::fs::remove_file(&part_path);
            }
            let err = serde_json::json!({"code": "NO_PARTIAL_UPLOAD", "message": "Partial file already complete", "transferId": transfer_id});
            session.send_to_client(
                client_id,
                protocol::encode_message(
                    protocol::MSG_ERROR,
                    serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                ),
            );
            return;
        }

        let (sftp_file, local_file) = if let Some(ref sftp) = sftp {
            match sftp.open(part_path.clone()).await {
                Ok(f) => (Some(f), None),
                Err(e) => {
                    let err = serde_json::json!({"code": "WRITE_FAILED", "message": format!("{}", e), "transferId": transfer_id});
                    super::file_handler::send_sftp_error(
                        &session,
                        client_id,
                        protocol::encode_message(
                            protocol::MSG_ERROR,
                            serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                        ),
                    );
                    return;
                }
            }
        } else {
            match std::fs::OpenOptions::new().append(true).open(&part_path) {
                Ok(f) => (None, Some(f)),
                Err(e) => {
                    let err = serde_json::json!({"code": "WRITE_FAILED", "message": format!("{}", e), "transferId": transfer_id});
                    session.send_to_client(
                        client_id,
                        protocol::encode_message(
                            protocol::MSG_ERROR,
                            serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                        ),
                    );
                    return;
                }
            }
        };

        session.active_uploads.lock().await.insert(
            transfer_id,
            super::session::UploadState {
                path,
                part_path,
                total_size,
                received: part_size,
                sftp_file,
                local_file,
                pending_writes: Vec::new(),
                pipeline: super::session::AdaptivePipeline::new(),
            },
        );

        // Resume ACK: [4B transferId][8B resumeOffset]
        let mut ack = Vec::with_capacity(12);
        ack.extend_from_slice(&transfer_id.to_be_bytes());
        ack.extend_from_slice(&(part_size as u64).to_be_bytes());
        session.send_to_client(
            client_id,
            protocol::encode_message(protocol::MSG_FILE_UPLOAD_CHUNK, &ack),
        );
    }
}

// ---------------------------------------------------------------------------
// Download handlers
// ---------------------------------------------------------------------------

/// Check download control channel — returns true if cancelled.
pub async fn wait_download_ctrl(
    ctrl: &mut tokio::sync::mpsc::Receiver<super::session::DownloadSignal>,
) -> bool {
    use super::session::DownloadSignal;
    loop {
        match ctrl.try_recv() {
            Ok(DownloadSignal::Cancel) => return true,
            Ok(DownloadSignal::Pause) => loop {
                match ctrl.recv().await {
                    Some(DownloadSignal::Continue) => return false,
                    Some(DownloadSignal::Cancel) => return true,
                    None => return true,
                    _ => {}
                }
            },
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
    transfer_id: u32,
) {
    const CHUNK_SIZE: usize = 4 * 1024 * 1024;

    let meta = match tokio::fs::metadata(path).await {
        Ok(m) => m,
        Err(e) => {
            let err = serde_json::json!({"code": "READ_FAILED", "message": format!("stat: {}", e), "transferId": transfer_id});
            session.send_to_client(
                client_id,
                protocol::encode_message(
                    protocol::MSG_ERROR,
                    serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                ),
            );
            return;
        }
    };

    let total_size = meta.len();
    let mut file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(e) => {
            let err = serde_json::json!({"code": "READ_FAILED", "message": format!("open: {}", e), "transferId": transfer_id});
            session.send_to_client(
                client_id,
                protocol::encode_message(
                    protocol::MSG_ERROR,
                    serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                ),
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

    if total_size == 0 {
        // Empty file: send a single chunk with [4B transferId][8B totalSize=0][8B offset=0]
        let mut chunk_payload = Vec::with_capacity(20);
        chunk_payload.extend_from_slice(&transfer_id.to_be_bytes());
        chunk_payload.extend_from_slice(&0u64.to_be_bytes());
        chunk_payload.extend_from_slice(&0u64.to_be_bytes());
        session.send_to_client(
            client_id,
            protocol::encode_message(protocol::MSG_FILE_DOWNLOAD_CHUNK, &chunk_payload),
        );
        return;
    }

    while offset < total_size {
        if wait_download_ctrl(&mut ctrl).await {
            return;
        }

        let n = match file.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                let err = serde_json::json!({"code": "READ_FAILED", "message": format!("read: {}", e), "transferId": transfer_id});
                session.send_to_client(
                    client_id,
                    protocol::encode_message(
                        protocol::MSG_ERROR,
                        serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                    ),
                );
                return;
            }
        };

        let mut chunk_payload = Vec::with_capacity(4 + 16 + n);
        chunk_payload.extend_from_slice(&transfer_id.to_be_bytes());
        chunk_payload.extend_from_slice(&total_size.to_be_bytes());
        chunk_payload.extend_from_slice(&offset.to_be_bytes());
        chunk_payload.extend_from_slice(&buf[..n]);

        if !session
            .send_bulk_to_client_async(
                client_id,
                protocol::encode_message(protocol::MSG_FILE_DOWNLOAD_CHUNK, &chunk_payload),
            )
            .await
        {
            return;
        }

        offset += n as u64;
    }
}

pub async fn handle_sftp_file_download(
    session: &Arc<Session>,
    client_id: &str,
    path: &str,
    _start_offset: u64,
    sftp: &russh_sftp::client::SftpSession,
    ctrl: tokio::sync::mpsc::Receiver<super::session::DownloadSignal>,
    transfer_id: u32,
) {
    const DOWNLOAD_MAX_INFLIGHT_BYTES: usize = 8 * 1024 * 1024;
    let meta = match sftp.metadata(path.to_string()).await {
        Ok(m) => m,
        Err(e) => {
            let err = serde_json::json!({"code": "READ_FAILED", "message": format!("stat: {}", e), "transferId": transfer_id});
            super::file_handler::send_sftp_error(
                session,
                client_id,
                protocol::encode_message(
                    protocol::MSG_ERROR,
                    serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                ),
            );
            return;
        }
    };
    let total_size = meta.size.unwrap_or(0);

    let mut file = match sftp.open(path.to_string()).await {
        Ok(f) => f,
        Err(e) => {
            let err = serde_json::json!({"code": "READ_FAILED", "message": format!("open: {}", e), "transferId": transfer_id});
            super::file_handler::send_sftp_error(
                session,
                client_id,
                protocol::encode_message(
                    protocol::MSG_ERROR,
                    serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                ),
            );
            return;
        }
    };

    if total_size == 0 {
        // Empty file: send a single chunk with [4B transferId][8B totalSize=0][8B offset=0]
        let mut chunk_payload = Vec::with_capacity(20);
        chunk_payload.extend_from_slice(&transfer_id.to_be_bytes());
        chunk_payload.extend_from_slice(&0u64.to_be_bytes());
        chunk_payload.extend_from_slice(&0u64.to_be_bytes());
        session.send_to_client(
            client_id,
            protocol::encode_message(protocol::MSG_FILE_DOWNLOAD_CHUNK, &chunk_payload),
        );
        return;
    }

    let dl_start = std::time::Instant::now();

    // Use a channel to overlap SFTP reading and WS sending.
    // Producer: keeps a continuous SFTP read pipeline full.
    // Consumer: sends each chunk to the WS client.
    // Sender task: merges small SFTP chunks (~255KB each) into ~512KB WS
    // messages to reduce per-message overhead without making progress too bursty.
    let (tx, mut send_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);
    let ctrl = Arc::new(tokio::sync::Mutex::new(ctrl));
    let cancelled = Arc::new(AtomicBool::new(false));
    let session_send = Arc::clone(session);
    let client_id_send = client_id.to_string();
    const MERGE_TARGET: usize = 512 * 1024; // ~512KB per WS message for smoother progress updates
    let send_task = tokio::spawn(async move {
        let mut send_offset: u64 = 0;
        let mut merge_buf: Vec<u8> = Vec::with_capacity(MERGE_TARGET + 262144);
        loop {
            let chunk = send_rx.recv().await;
            match chunk {
                Some(data) => {
                    merge_buf.extend_from_slice(&data);
                    while merge_buf.len() < MERGE_TARGET {
                        match send_rx.try_recv() {
                            Ok(more) => merge_buf.extend_from_slice(&more),
                            Err(_) => break,
                        }
                    }

                    let mut payload = Vec::with_capacity(4 + 16 + merge_buf.len());
                    payload.extend_from_slice(&transfer_id.to_be_bytes());
                    payload.extend_from_slice(&total_size.to_be_bytes());
                    payload.extend_from_slice(&send_offset.to_be_bytes());
                    payload.extend_from_slice(&merge_buf);
                    send_offset += merge_buf.len() as u64;
                    merge_buf.clear();
                    if !session_send
                        .send_bulk_to_client_async(
                            &client_id_send,
                            protocol::encode_message(protocol::MSG_FILE_DOWNLOAD_CHUNK, &payload),
                        )
                        .await
                    {
                        return false;
                    }
                }
                None => {
                    if !merge_buf.is_empty() {
                        let mut payload = Vec::with_capacity(4 + 16 + merge_buf.len());
                        payload.extend_from_slice(&transfer_id.to_be_bytes());
                        payload.extend_from_slice(&total_size.to_be_bytes());
                        payload.extend_from_slice(&send_offset.to_be_bytes());
                        payload.extend_from_slice(&merge_buf);
                        if !session_send
                            .send_bulk_to_client_async(
                                &client_id_send,
                                protocol::encode_message(
                                    protocol::MSG_FILE_DOWNLOAD_CHUNK,
                                    &payload,
                                ),
                            )
                            .await
                        {
                            return false;
                        }
                    }
                    return true;
                }
            }
        }
    });

    let max_inflight_bytes = (total_size as usize)
        .min(DOWNLOAD_MAX_INFLIGHT_BYTES)
        .max(MERGE_TARGET);
    let tx_read = tx.clone();

    let read_result = file
        .read_pipelined_streaming_each(max_inflight_bytes, {
            let ctrl = Arc::clone(&ctrl);
            let cancelled = Arc::clone(&cancelled);
            move |chunk_data| {
                let ctrl = Arc::clone(&ctrl);
                let cancelled = Arc::clone(&cancelled);
                let tx = tx_read.clone();
                async move {
                    let mut ctrl = ctrl.lock().await;
                    if wait_download_ctrl(&mut ctrl).await {
                        cancelled.store(true, Ordering::Relaxed);
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::Interrupted,
                            "download cancelled",
                        ));
                    }
                    drop(ctrl);

                    tx.send(chunk_data).await.map_err(|_| {
                        std::io::Error::new(std::io::ErrorKind::BrokenPipe, "download queue closed")
                    })
                }
            }
        })
        .await;

    if let Err(e) = read_result {
        if !cancelled.load(Ordering::Relaxed) || e.kind() != std::io::ErrorKind::Interrupted {
            let err = serde_json::json!({"code": "READ_FAILED", "message": format!("read: {}", e), "transferId": transfer_id});
            session.send_to_client(
                client_id,
                protocol::encode_message(
                    protocol::MSG_ERROR,
                    serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                ),
            );
        }
    }

    // Signal sender we're done reading
    drop(tx);
    // Wait for all sends to complete
    let _ = send_task.await;

    let total_ms = dl_start.elapsed().as_millis();
    let size_mb = total_size as f64 / 1024.0 / 1024.0;
    let speed = if total_ms > 0 {
        size_mb / (total_ms as f64 / 1000.0)
    } else {
        0.0
    };
    eprintln!(
        "[download] SFTP done: {:.1}MB in {}ms ({:.1}MB/s) inflight={}KB cancelled={}",
        size_mb,
        total_ms,
        speed,
        max_inflight_bytes / 1024,
        cancelled.load(Ordering::Relaxed)
    );
}
