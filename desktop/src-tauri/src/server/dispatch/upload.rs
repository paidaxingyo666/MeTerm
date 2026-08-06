use std::io::{Seek, SeekFrom};
use std::sync::Arc;

use russh_sftp::protocol::OpenFlags;
use tokio::io::AsyncSeekExt;

use super::{parse_transfer_id, transfer_owner_key};
use crate::server::protocol;
use crate::server::session::access::DispatchAuthority;
use crate::server::session::transfer::{
    close_sftp_upload_file, drain_pending_upload_writes, finalize_local_upload,
    finalize_sftp_upload, normalize_upload_path, wait_pending_upload_write, UploadLeaseOwner,
    UploadPathLease, UploadPhase, UploadSettleError,
};
use crate::server::session::{Session, TransferOwnerKey, UploadState};

const MAX_WS_UPLOAD_SIZE: u64 = 1024 * 1024 * 1024 * 1024;
const MAX_WS_UPLOAD_CHUNK_SIZE: usize = 8 * 1024 * 1024;

struct UploadRequest {
    path: String,
    total_size: i64,
    transfer_id: u32,
}

fn send_upload_response(
    session: &Session,
    authority: &DispatchAuthority,
    response: Vec<u8>,
) -> bool {
    session.send_to_client_generation(authority.client_id(), authority.conn_gen(), response)
}

fn send_upload_sftp_error(
    session: &Session,
    authority: &DispatchAuthority,
    response: Vec<u8>,
) -> bool {
    crate::server::file_handler::send_sftp_error_for_generation(
        session,
        authority.client_id(),
        authority.conn_gen(),
        response,
    )
}

fn send_upload_error(
    session: &Session,
    authority: &DispatchAuthority,
    code: &str,
    message: impl Into<String>,
    transfer_id: Option<u32>,
) {
    let mut error = serde_json::json!({
        "code": code,
        "message": message.into(),
    });
    if let Some(transfer_id) = transfer_id {
        error["transferId"] = serde_json::json!(transfer_id);
    }
    send_upload_response(
        session,
        authority,
        protocol::encode_message(
            protocol::MSG_ERROR,
            serde_json::to_vec(&error).unwrap_or_default().as_slice(),
        ),
    );
}

fn parse_upload_request(payload: &[u8], allow_empty: bool) -> Result<UploadRequest, String> {
    let request: serde_json::Value =
        serde_json::from_slice(payload).map_err(|error| format!("invalid request: {error}"))?;
    let raw_path = request
        .get("path")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "path is required".to_string())?;
    normalize_upload_path(raw_path)?;
    let path = raw_path.to_string();
    let total_size = request
        .get("size")
        .and_then(|value| value.as_u64())
        .ok_or_else(|| "size must be a non-negative integer".to_string())?;
    if !allow_empty && total_size == 0 {
        return Err("resume size must be greater than zero".to_string());
    }
    if total_size > MAX_WS_UPLOAD_SIZE || total_size > i64::MAX as u64 {
        return Err(format!(
            "size exceeds the {} byte WebSocket upload limit",
            MAX_WS_UPLOAD_SIZE
        ));
    }
    let transfer_id =
        parse_transfer_id(&request).ok_or_else(|| "transferId must be non-zero".to_string())?;
    Ok(UploadRequest {
        path,
        total_size: total_size as i64,
        transfer_id,
    })
}

fn acquire_upload_lease(
    session: &Session,
    authority: &DispatchAuthority,
    key: &TransferOwnerKey,
    path: &str,
) -> Option<UploadPathLease> {
    match session
        .upload_path_leases
        .acquire(path, UploadLeaseOwner::WebSocket(key.clone()))
    {
        Ok(lease) => Some(lease),
        Err(error) => {
            let code = if error.contains("limit") {
                "TRANSFER_LIMIT"
            } else {
                "TRANSFER_PATH_BUSY"
            };
            send_upload_error(session, authority, code, error, Some(key.2));
            None
        }
    }
}

async fn insert_upload_state(
    session: &Session,
    key: TransferOwnerKey,
    state: UploadState,
) -> Result<(), UploadState> {
    let mut uploads = session.active_uploads.lock().await;
    match uploads.entry(key) {
        std::collections::hash_map::Entry::Vacant(entry) => {
            entry.insert(state);
            Ok(())
        }
        std::collections::hash_map::Entry::Occupied(_) => Err(state),
    }
}

async fn remove_upload_state(session: &Session, key: &TransferOwnerKey) -> Option<UploadState> {
    let mut uploads = session.active_uploads.lock().await;
    if uploads
        .get(key)
        .is_some_and(|state| state.phase == UploadPhase::Active)
    {
        uploads.remove(key)
    } else {
        None
    }
}

fn settle_results(
    results: impl IntoIterator<Item = Result<(), UploadSettleError>>,
) -> (bool, Result<(), String>) {
    let mut timed_out = false;
    let mut errors = Vec::new();
    for result in results {
        if let Err(error) = result {
            timed_out |= error.is_timeout();
            errors.push(error.to_string());
        }
    }
    let result = if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    };
    (timed_out, result)
}

async fn remove_finalizing_placeholder(
    session: &Session,
    key: &TransferOwnerKey,
    lease: &UploadPathLease,
) {
    let mut uploads = session.active_uploads.lock().await;
    let is_same_finalization = uploads
        .get(key)
        .is_some_and(|state| state.phase == UploadPhase::Finalizing && state.lease == *lease);
    if is_same_finalization {
        uploads.remove(key);
    }
}

async fn complete_empty_upload(
    session: &Session,
    authority: &DispatchAuthority,
    sftp: Option<Arc<russh_sftp::client::SftpSession>>,
    lease: UploadPathLease,
    transfer_id: u32,
) {
    if !session.upload_path_leases.mark_finalizing(&lease) {
        send_upload_error(
            session,
            authority,
            "UPLOAD_OWNERSHIP_LOST",
            "upload path ownership was lost before finalization",
            Some(transfer_id),
        );
        return;
    }
    let (timed_out, result) = if let Some(sftp) = sftp {
        match sftp.create(lease.part_path.clone()).await {
            Ok(file) => {
                let close_result = close_sftp_upload_file(Some(file)).await;
                let (timed_out, settled) = settle_results([close_result]);
                let result = match settled {
                    Ok(()) => {
                        finalize_sftp_upload(&sftp, &lease.part_path, &lease.final_path).await
                    }
                    Err(error) => Err(error),
                };
                (timed_out, result)
            }
            Err(error) => (false, Err(format!("create empty remote file: {error}"))),
        }
    } else {
        match std::fs::File::create(&lease.part_path) {
            Ok(file) => {
                drop(file);
                (
                    false,
                    finalize_local_upload(&lease.part_path, &lease.final_path).await,
                )
            }
            Err(error) => (false, Err(format!("create empty file: {error}"))),
        }
    };
    if timed_out {
        session.upload_path_leases.poison(&lease);
    } else {
        session.upload_path_leases.release(&lease);
    }

    match result {
        Ok(()) => {
            let response = serde_json::json!({
                "success": true,
                "transferId": transfer_id,
            });
            send_upload_response(
                session,
                authority,
                protocol::encode_message(
                    protocol::MSG_FILE_OPERATION_RESP,
                    serde_json::to_vec(&response).unwrap_or_default().as_slice(),
                ),
            );
        }
        Err(error) => {
            send_upload_error(session, authority, "WRITE_FAILED", error, Some(transfer_id))
        }
    }
}

async fn finalize_upload_state(
    session: &Arc<Session>,
    authority: &DispatchAuthority,
    key: TransferOwnerKey,
    mut state: UploadState,
    transfer_id: u32,
) {
    state.phase = UploadPhase::Finalizing;
    let lease = state.lease.clone();
    let pending = std::mem::take(&mut state.pending_writes);
    let sftp_file = state.sftp_file.take();
    let local_file = state.local_file.take();
    let was_sftp = sftp_file.is_some();

    if !session.upload_path_leases.mark_finalizing(&lease) {
        let pending_result = drain_pending_upload_writes(pending).await;
        let close_result = close_sftp_upload_file(sftp_file).await;
        drop(local_file);
        let (timed_out, _) = settle_results([pending_result, close_result]);
        if timed_out {
            session.upload_path_leases.poison(&lease);
        }
        send_upload_error(
            session,
            authority,
            "UPLOAD_OWNERSHIP_LOST",
            "upload path ownership was lost before finalization",
            Some(transfer_id),
        );
        return;
    }

    if let Err(mut conflicting) = insert_upload_state(session, key.clone(), state).await {
        let mut all_pending = pending;
        all_pending.append(&mut conflicting.pending_writes);
        let pending_result = drain_pending_upload_writes(all_pending).await;
        let close_result = close_sftp_upload_file(sftp_file).await;
        drop(local_file);
        let (timed_out, _) = settle_results([pending_result, close_result]);
        if timed_out {
            session.upload_path_leases.poison(&lease);
        } else {
            session.upload_path_leases.release(&lease);
        }
        send_upload_error(
            session,
            authority,
            "TRANSFER_ID_IN_USE",
            "upload transferId changed ownership during finalization",
            Some(transfer_id),
        );
        return;
    }

    let pending_result = drain_pending_upload_writes(pending).await;
    let close_result = close_sftp_upload_file(sftp_file).await;
    drop(local_file);
    let (timed_out, settled) = settle_results([pending_result, close_result]);
    if timed_out {
        // Keep both the exact-generation placeholder and the poisoned path
        // lease until Session teardown. Old remote writes may still arrive.
        session.upload_path_leases.poison(&lease);
        send_upload_error(
            session,
            authority,
            "WRITE_TIMEOUT",
            settled
                .err()
                .unwrap_or_else(|| "remote upload did not settle".to_string()),
            Some(transfer_id),
        );
        return;
    }

    let result = match settled {
        Err(error) => Err(format!("pending upload operation failed: {error}")),
        Ok(()) if was_sftp => {
            let sftp = session.sftp.lock().unwrap().clone();
            match sftp {
                Some(sftp) => {
                    finalize_sftp_upload(&sftp, &lease.part_path, &lease.final_path).await
                }
                None => Err("SFTP session disappeared before finalization".to_string()),
            }
        }
        Ok(()) => finalize_local_upload(&lease.part_path, &lease.final_path).await,
    };

    remove_finalizing_placeholder(session, &key, &lease).await;
    session.upload_path_leases.release(&lease);

    match result {
        Ok(()) => {
            let response = serde_json::json!({
                "success": true,
                "transferId": transfer_id,
            });
            send_upload_response(
                session,
                authority,
                protocol::encode_message(
                    protocol::MSG_FILE_OPERATION_RESP,
                    serde_json::to_vec(&response).unwrap_or_default().as_slice(),
                ),
            );
        }
        Err(error) => {
            send_upload_error(session, authority, "WRITE_FAILED", error, Some(transfer_id))
        }
    }
}

async fn register_active_state(
    session: &Arc<Session>,
    authority: &DispatchAuthority,
    key: TransferOwnerKey,
    state: UploadState,
) {
    if let Err(state) = insert_upload_state(session, key.clone(), state).await {
        let _ = session.retire_upload_state(state).await;
        send_upload_error(
            session,
            authority,
            "TRANSFER_ID_IN_USE",
            "upload transferId is already active",
            Some(key.2),
        );
        return;
    }

    // If reconnect won while the backend file was opening, ensure the just-
    // inserted H0 state is retired even if H0's normal WS cleanup already ran.
    if session
        .current_client_connection(authority.client_id(), authority.conn_gen())
        .is_none()
    {
        session
            .cleanup_ws_uploads_for_connection(authority.client_id(), authority.conn_gen())
            .await;
        return;
    }

    let mut acknowledgement = Vec::with_capacity(4);
    acknowledgement.extend_from_slice(&key.2.to_be_bytes());
    send_upload_response(
        session,
        authority,
        protocol::encode_message(protocol::MSG_FILE_UPLOAD_CHUNK, &acknowledgement),
    );
}

pub(super) async fn handle_upload_start(
    session: &Arc<Session>,
    authority: &DispatchAuthority,
    payload: &[u8],
) {
    let request = match parse_upload_request(payload, true) {
        Ok(request) => request,
        Err(error) => {
            send_upload_error(session, authority, "INVALID_REQUEST", error, None);
            return;
        }
    };
    session
        .cleanup_stale_ws_uploads(authority.client_id(), authority.conn_gen())
        .await;

    let key = transfer_owner_key(authority, request.transfer_id);
    let Some(lease) = acquire_upload_lease(session, authority, &key, &request.path) else {
        return;
    };
    let sftp = session.sftp.lock().unwrap().clone();

    if request.total_size == 0 {
        complete_empty_upload(session, authority, sftp, lease, request.transfer_id).await;
        return;
    }

    let state = if let Some(sftp) = sftp {
        match sftp.create(lease.part_path.clone()).await {
            Ok(file) => UploadState {
                path: lease.final_path.clone(),
                part_path: lease.part_path.clone(),
                total_size: request.total_size,
                received: 0,
                lease,
                phase: UploadPhase::Active,
                sftp_file: Some(file),
                local_file: None,
                pending_writes: Vec::new(),
                pipeline: crate::server::session::AdaptivePipeline::new(),
            },
            Err(error) => {
                session.upload_path_leases.release(&lease);
                let response = serde_json::json!({
                    "code": "WRITE_FAILED",
                    "message": format!("create part: {error}"),
                    "transferId": request.transfer_id,
                });
                send_upload_sftp_error(
                    session,
                    authority,
                    protocol::encode_message(
                        protocol::MSG_ERROR,
                        serde_json::to_vec(&response).unwrap_or_default().as_slice(),
                    ),
                );
                return;
            }
        }
    } else {
        match std::fs::File::create(&lease.part_path) {
            Ok(file) => UploadState {
                path: lease.final_path.clone(),
                part_path: lease.part_path.clone(),
                total_size: request.total_size,
                received: 0,
                lease,
                phase: UploadPhase::Active,
                sftp_file: None,
                local_file: Some(file),
                pending_writes: Vec::new(),
                pipeline: crate::server::session::AdaptivePipeline::new(),
            },
            Err(error) => {
                session.upload_path_leases.release(&lease);
                send_upload_error(
                    session,
                    authority,
                    "WRITE_FAILED",
                    error.to_string(),
                    Some(request.transfer_id),
                );
                return;
            }
        }
    };

    register_active_state(session, authority, key, state).await;
}

pub(super) async fn handle_upload_chunk(
    session: &Arc<Session>,
    authority: &DispatchAuthority,
    payload: &[u8],
) {
    if payload.len() < 20 {
        send_upload_error(
            session,
            authority,
            "INVALID_REQUEST",
            "upload chunk header is truncated",
            None,
        );
        return;
    }
    let transfer_id = u32::from_be_bytes(payload[0..4].try_into().unwrap());
    if transfer_id == 0 {
        send_upload_error(
            session,
            authority,
            "INVALID_REQUEST",
            "transferId must be non-zero",
            None,
        );
        return;
    }
    let declared_total = u64::from_be_bytes(payload[4..12].try_into().unwrap());
    let declared_offset = u64::from_be_bytes(payload[12..20].try_into().unwrap());
    let chunk_data = &payload[20..];
    let key = transfer_owner_key(authority, transfer_id);
    if declared_total == 0
        || declared_total > MAX_WS_UPLOAD_SIZE
        || declared_total > i64::MAX as u64
        || declared_offset > i64::MAX as u64
        || chunk_data.is_empty()
        || chunk_data.len() > MAX_WS_UPLOAD_CHUNK_SIZE
        || declared_offset
            .checked_add(chunk_data.len() as u64)
            .is_none_or(|end| end > declared_total)
    {
        send_upload_error(
            session,
            authority,
            "INVALID_REQUEST",
            "upload chunk exceeds declared size or server limits",
            Some(transfer_id),
        );
        if let Some(state) = remove_upload_state(session, &key).await {
            let _ = session.retire_upload_state(state).await;
        }
        return;
    }

    let Some(mut state) = remove_upload_state(session, &key).await else {
        eprintln!(
            "Upload chunk received but no active upload for transferId={}, ignoring",
            transfer_id
        );
        return;
    };
    if state.phase != UploadPhase::Active
        || declared_offset as i64 != state.received
        || declared_total as i64 != state.total_size
    {
        let _ = session.retire_upload_state(state).await;
        send_upload_error(
            session,
            authority,
            "UPLOAD_OFFSET_MISMATCH",
            "upload offset or total size does not match active transfer",
            Some(transfer_id),
        );
        return;
    }

    let mut write_error = None;
    state
        .pending_writes
        .retain_mut(|write| match write.try_wait() {
            Some(Ok(_)) => {
                state.pipeline.on_ack();
                false
            }
            Some(Err(error)) => {
                if write_error.is_none() {
                    write_error = Some(error.to_string());
                }
                false
            }
            None => true,
        });
    if let Some(error) = write_error {
        let _ = session.retire_upload_state(state).await;
        send_upload_error(
            session,
            authority,
            "WRITE_FAILED",
            format!("pending upload write failed: {error}"),
            Some(transfer_id),
        );
        return;
    }

    while state.pending_writes.len() >= state.pipeline.window {
        let write = state.pending_writes.remove(0);
        match wait_pending_upload_write(write).await {
            Ok(()) => state.pipeline.on_ack(),
            Err(error) => {
                if error.is_timeout() {
                    session.upload_path_leases.poison(&state.lease);
                }
                let _ = session.retire_upload_state(state).await;
                send_upload_error(
                    session,
                    authority,
                    "WRITE_FAILED",
                    format!("upload flow-control write failed: {error}"),
                    Some(transfer_id),
                );
                return;
            }
        }
    }

    let write_ok = if let Some(file) = state.sftp_file.as_mut() {
        let mut position = 0;
        let mut ok = true;
        while position < chunk_data.len() {
            match file.write_no_wait(&chunk_data[position..]) {
                Ok((pending, written)) if written > 0 => {
                    state.pipeline.on_send();
                    state.pending_writes.push(pending);
                    position += written;
                }
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        ok
    } else if let Some(file) = state.local_file.as_mut() {
        use std::io::Write;
        file.write_all(chunk_data).is_ok()
    } else {
        false
    };
    if !write_ok {
        let _ = session.retire_upload_state(state).await;
        send_upload_error(
            session,
            authority,
            "WRITE_FAILED",
            "write failed during upload chunk",
            Some(transfer_id),
        );
        return;
    }

    state.received = match state.received.checked_add(chunk_data.len() as i64) {
        Some(received) if received <= state.total_size => received,
        _ => {
            let _ = session.retire_upload_state(state).await;
            send_upload_error(
                session,
                authority,
                "INVALID_REQUEST",
                "upload chunk exceeds declared total size",
                Some(transfer_id),
            );
            return;
        }
    };

    if state.received == state.total_size {
        finalize_upload_state(session, authority, key, state, transfer_id).await;
        return;
    }

    if let Err(state) = insert_upload_state(session, key.clone(), state).await {
        let _ = session.retire_upload_state(state).await;
        send_upload_error(
            session,
            authority,
            "TRANSFER_ID_IN_USE",
            "upload transferId changed ownership",
            Some(transfer_id),
        );
        return;
    }
    if session
        .current_client_connection(authority.client_id(), authority.conn_gen())
        .is_none()
    {
        session
            .cleanup_ws_uploads_for_connection(authority.client_id(), authority.conn_gen())
            .await;
        return;
    }

    let mut acknowledgement = Vec::with_capacity(4);
    acknowledgement.extend_from_slice(&transfer_id.to_be_bytes());
    send_upload_response(
        session,
        authority,
        protocol::encode_message(protocol::MSG_FILE_UPLOAD_CHUNK, &acknowledgement),
    );
}

pub(super) async fn handle_upload_resume(
    session: &Arc<Session>,
    authority: &DispatchAuthority,
    payload: &[u8],
) {
    let request = match parse_upload_request(payload, false) {
        Ok(request) => request,
        Err(error) => {
            send_upload_error(session, authority, "INVALID_REQUEST", error, None);
            return;
        }
    };
    session
        .cleanup_stale_ws_uploads(authority.client_id(), authority.conn_gen())
        .await;

    let key = transfer_owner_key(authority, request.transfer_id);
    let Some(lease) = acquire_upload_lease(session, authority, &key, &request.path) else {
        return;
    };
    let sftp = session.sftp.lock().unwrap().clone();
    let part_size = if let Some(sftp) = sftp.as_ref() {
        match sftp.metadata(lease.part_path.clone()).await {
            Ok(metadata) => metadata.size.unwrap_or(0),
            Err(error) => {
                session.upload_path_leases.release(&lease);
                let message = error.to_string();
                if crate::server::file_handler::is_sftp_auth_error(&message) {
                    let response = serde_json::json!({
                        "code": "WRITE_FAILED",
                        "message": message,
                        "transferId": request.transfer_id,
                    });
                    send_upload_sftp_error(
                        session,
                        authority,
                        protocol::encode_message(
                            protocol::MSG_ERROR,
                            serde_json::to_vec(&response).unwrap_or_default().as_slice(),
                        ),
                    );
                } else {
                    send_upload_error(
                        session,
                        authority,
                        "NO_PARTIAL_UPLOAD",
                        "no partial upload was found",
                        Some(request.transfer_id),
                    );
                }
                return;
            }
        }
    } else {
        match std::fs::metadata(&lease.part_path) {
            Ok(metadata) => metadata.len(),
            Err(error) => {
                session.upload_path_leases.release(&lease);
                send_upload_error(
                    session,
                    authority,
                    "NO_PARTIAL_UPLOAD",
                    error.to_string(),
                    Some(request.transfer_id),
                );
                return;
            }
        }
    };
    if part_size > request.total_size as u64 {
        session.upload_path_leases.release(&lease);
        send_upload_error(
            session,
            authority,
            "PARTIAL_SIZE_INVALID",
            "partial upload is larger than the declared total",
            Some(request.transfer_id),
        );
        return;
    }
    if part_size == request.total_size as u64 {
        session.upload_path_leases.mark_finalizing(&lease);
        let result = match sftp {
            Some(sftp) => finalize_sftp_upload(&sftp, &lease.part_path, &lease.final_path).await,
            None => finalize_local_upload(&lease.part_path, &lease.final_path).await,
        };
        session.upload_path_leases.release(&lease);
        match result {
            Ok(()) => {
                let response = serde_json::json!({
                    "success": true,
                    "transferId": request.transfer_id,
                });
                send_upload_response(
                    session,
                    authority,
                    protocol::encode_message(
                        protocol::MSG_FILE_OPERATION_RESP,
                        serde_json::to_vec(&response).unwrap_or_default().as_slice(),
                    ),
                );
            }
            Err(error) => send_upload_error(
                session,
                authority,
                "WRITE_FAILED",
                error,
                Some(request.transfer_id),
            ),
        }
        return;
    }

    let state = if let Some(sftp) = sftp {
        let mut file = match sftp
            .open_with_flags(lease.part_path.clone(), OpenFlags::WRITE)
            .await
        {
            Ok(file) => file,
            Err(error) => {
                session.upload_path_leases.release(&lease);
                send_upload_error(
                    session,
                    authority,
                    "WRITE_FAILED",
                    error.to_string(),
                    Some(request.transfer_id),
                );
                return;
            }
        };
        if let Err(error) = file.seek(SeekFrom::Start(part_size)).await {
            let close_result = close_sftp_upload_file(Some(file)).await;
            if close_result
                .as_ref()
                .err()
                .is_some_and(UploadSettleError::is_timeout)
            {
                session.upload_path_leases.poison(&lease);
            } else {
                session.upload_path_leases.release(&lease);
            }
            send_upload_error(
                session,
                authority,
                "WRITE_FAILED",
                format!("seek partial upload: {error}"),
                Some(request.transfer_id),
            );
            return;
        }
        UploadState {
            path: lease.final_path.clone(),
            part_path: lease.part_path.clone(),
            total_size: request.total_size,
            received: part_size as i64,
            lease,
            phase: UploadPhase::Active,
            sftp_file: Some(file),
            local_file: None,
            pending_writes: Vec::new(),
            pipeline: crate::server::session::AdaptivePipeline::new(),
        }
    } else {
        let mut file = match std::fs::OpenOptions::new()
            .write(true)
            .open(&lease.part_path)
        {
            Ok(file) => file,
            Err(error) => {
                session.upload_path_leases.release(&lease);
                send_upload_error(
                    session,
                    authority,
                    "WRITE_FAILED",
                    error.to_string(),
                    Some(request.transfer_id),
                );
                return;
            }
        };
        if let Err(error) = file.seek(SeekFrom::Start(part_size)) {
            session.upload_path_leases.release(&lease);
            send_upload_error(
                session,
                authority,
                "WRITE_FAILED",
                format!("seek partial upload: {error}"),
                Some(request.transfer_id),
            );
            return;
        }
        UploadState {
            path: lease.final_path.clone(),
            part_path: lease.part_path.clone(),
            total_size: request.total_size,
            received: part_size as i64,
            lease,
            phase: UploadPhase::Active,
            sftp_file: None,
            local_file: Some(file),
            pending_writes: Vec::new(),
            pipeline: crate::server::session::AdaptivePipeline::new(),
        }
    };

    if let Err(state) = insert_upload_state(session, key, state).await {
        let _ = session.retire_upload_state(state).await;
        send_upload_error(
            session,
            authority,
            "TRANSFER_ID_IN_USE",
            "upload transferId is already active",
            Some(request.transfer_id),
        );
        return;
    }
    if session
        .current_client_connection(authority.client_id(), authority.conn_gen())
        .is_none()
    {
        session
            .cleanup_ws_uploads_for_connection(authority.client_id(), authority.conn_gen())
            .await;
        return;
    }

    let mut acknowledgement = Vec::with_capacity(12);
    acknowledgement.extend_from_slice(&request.transfer_id.to_be_bytes());
    acknowledgement.extend_from_slice(&part_size.to_be_bytes());
    send_upload_response(
        session,
        authority,
        protocol::encode_message(protocol::MSG_FILE_UPLOAD_CHUNK, &acknowledgement),
    );
}
