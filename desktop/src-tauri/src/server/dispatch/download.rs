//! Local and SFTP download implementations used by WebSocket dispatch and IPC.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::server::protocol;
use crate::server::session::{DownloadSignal, Session};
use tokio_util::sync::CancellationToken;

fn download_authorized(session: &Session, client_id: &str, expected_conn_gen: u64) -> bool {
    session
        .current_client_connection(client_id, expected_conn_gen)
        .is_some_and(|authority| authority.can_control())
}

/// Check download control channel — returns true if cancelled.
pub async fn wait_download_ctrl<ShouldCancel>(
    ctrl: &mut tokio::sync::mpsc::Receiver<DownloadSignal>,
    cancellation: &CancellationToken,
    should_cancel: ShouldCancel,
) -> bool
where
    ShouldCancel: Fn() -> bool,
{
    loop {
        if cancellation.is_cancelled() || should_cancel() {
            return true;
        }
        match ctrl.try_recv() {
            Ok(DownloadSignal::Cancel) => return true,
            Ok(DownloadSignal::Pause) => loop {
                tokio::select! {
                    _ = cancellation.cancelled() => return true,
                    _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                        if should_cancel() {
                            return true;
                        }
                    }
                    signal = ctrl.recv() => match signal {
                        Some(DownloadSignal::Continue) => return false,
                        Some(DownloadSignal::Cancel) | None => return true,
                        _ => {}
                    }
                }
            },
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => return true,
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => return false,
            Ok(DownloadSignal::Continue) => return false,
        }
    }
}

pub(super) async fn handle_local_file_download(
    session: &Session,
    client_id: &str,
    expected_conn_gen: u64,
    path: &str,
    start_offset: u64,
    mut ctrl: tokio::sync::mpsc::Receiver<DownloadSignal>,
    transfer_id: u32,
    cancellation: CancellationToken,
) {
    const CHUNK_SIZE: usize = 4 * 1024 * 1024;
    if !download_authorized(session, client_id, expected_conn_gen) {
        return;
    }

    let meta = match tokio::select! {
        _ = cancellation.cancelled() => return,
        result = tokio::fs::metadata(path) => result,
    } {
        Ok(m) => m,
        Err(e) => {
            let err = serde_json::json!({"code": "READ_FAILED", "message": format!("stat: {}", e), "transferId": transfer_id});
            session.send_to_client_generation(
                client_id,
                expected_conn_gen,
                protocol::encode_message(
                    protocol::MSG_ERROR,
                    serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                ),
            );
            return;
        }
    };

    let total_size = meta.len();
    if let Err(message) = super::validate_download_offset(start_offset, total_size) {
        let err = serde_json::json!({
            "code": "READ_FAILED",
            "message": message,
            "transferId": transfer_id,
        });
        session.send_to_client_generation(
            client_id,
            expected_conn_gen,
            protocol::encode_message(
                protocol::MSG_ERROR,
                serde_json::to_vec(&err).unwrap_or_default().as_slice(),
            ),
        );
        return;
    }
    let mut file = match tokio::select! {
        _ = cancellation.cancelled() => return,
        result = tokio::fs::File::open(path) => result,
    } {
        Ok(f) => f,
        Err(e) => {
            let err = serde_json::json!({"code": "READ_FAILED", "message": format!("open: {}", e), "transferId": transfer_id});
            session.send_to_client_generation(
                client_id,
                expected_conn_gen,
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
        let seek = tokio::select! {
            _ = cancellation.cancelled() => return,
            result = file.seek(std::io::SeekFrom::Start(start_offset)) => result,
        };
        if let Err(error) = seek {
            let err = serde_json::json!({
                "code": "READ_FAILED",
                "message": format!("seek: {error}"),
                "transferId": transfer_id,
            });
            session.send_to_client_generation(
                client_id,
                expected_conn_gen,
                protocol::encode_message(
                    protocol::MSG_ERROR,
                    serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                ),
            );
            return;
        }
    }
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut offset: u64 = start_offset;

    if total_size == 0 {
        if cancellation.is_cancelled()
            || !download_authorized(session, client_id, expected_conn_gen)
        {
            return;
        }
        // Empty file: send a single chunk with [4B transferId][8B totalSize=0][8B offset=0]
        let mut chunk_payload = Vec::with_capacity(20);
        chunk_payload.extend_from_slice(&transfer_id.to_be_bytes());
        chunk_payload.extend_from_slice(&0u64.to_be_bytes());
        chunk_payload.extend_from_slice(&0u64.to_be_bytes());
        session.send_to_client_generation(
            client_id,
            expected_conn_gen,
            protocol::encode_message(protocol::MSG_FILE_DOWNLOAD_CHUNK, &chunk_payload),
        );
        return;
    }

    while offset < total_size {
        if wait_download_ctrl(&mut ctrl, &cancellation, || {
            !download_authorized(session, client_id, expected_conn_gen)
        })
        .await
            || !download_authorized(session, client_id, expected_conn_gen)
        {
            return;
        }

        let n = match tokio::select! {
            _ = cancellation.cancelled() => return,
            result = file.read(&mut buf) => result,
        } {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                let err = serde_json::json!({"code": "READ_FAILED", "message": format!("read: {}", e), "transferId": transfer_id});
                session.send_to_client_generation(
                    client_id,
                    expected_conn_gen,
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

        if !download_authorized(session, client_id, expected_conn_gen) {
            return;
        }
        let sent = tokio::select! {
            _ = cancellation.cancelled() => return,
            sent = session.send_bulk_to_client_generation_async(
                client_id,
                expected_conn_gen,
                protocol::encode_message(protocol::MSG_FILE_DOWNLOAD_CHUNK, &chunk_payload),
            ) => sent,
        };
        if !sent {
            return;
        }

        offset += n as u64;
    }
}

pub(super) async fn handle_sftp_file_download(
    session: &Arc<Session>,
    client_id: &str,
    expected_conn_gen: u64,
    path: &str,
    start_offset: u64,
    sftp: &russh_sftp::client::SftpSession,
    ctrl: tokio::sync::mpsc::Receiver<DownloadSignal>,
    transfer_id: u32,
    cancellation: CancellationToken,
) {
    const DOWNLOAD_MAX_INFLIGHT_BYTES: usize = 8 * 1024 * 1024;
    const SFTP_OPERATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
    if !download_authorized(session, client_id, expected_conn_gen) {
        return;
    }
    let meta = match tokio::select! {
        _ = cancellation.cancelled() => return,
        result = tokio::time::timeout(
            SFTP_OPERATION_TIMEOUT,
            sftp.metadata(path.to_string()),
        ) => result,
    } {
        Ok(Ok(meta)) => meta,
        result => {
            let message = match result {
                Ok(Err(error)) => format!("stat: {error}"),
                Err(_) => "stat timed out".to_string(),
                Ok(Ok(_)) => unreachable!(),
            };
            let err = serde_json::json!({"code": "READ_FAILED", "message": message, "transferId": transfer_id});
            let response = crate::server::file_handler::maybe_upgrade_sftp_auth_error(
                protocol::encode_message(
                    protocol::MSG_ERROR,
                    serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                ),
            );
            session.send_to_client_generation(client_id, expected_conn_gen, response);
            return;
        }
    };
    let total_size = meta.size.unwrap_or(0);

    if !download_authorized(session, client_id, expected_conn_gen) {
        return;
    }
    let mut file = match tokio::select! {
        _ = cancellation.cancelled() => return,
        result = tokio::time::timeout(
            SFTP_OPERATION_TIMEOUT,
            sftp.open(path.to_string()),
        ) => result,
    } {
        Ok(Ok(file)) => file,
        result => {
            let message = match result {
                Ok(Err(error)) => format!("open: {error}"),
                Err(_) => "open timed out".to_string(),
                Ok(Ok(_)) => unreachable!(),
            };
            let err = serde_json::json!({"code": "READ_FAILED", "message": message, "transferId": transfer_id});
            let response = crate::server::file_handler::maybe_upgrade_sftp_auth_error(
                protocol::encode_message(
                    protocol::MSG_ERROR,
                    serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                ),
            );
            session.send_to_client_generation(client_id, expected_conn_gen, response);
            return;
        }
    };
    if start_offset > total_size {
        let err = serde_json::json!({
            "code": "READ_FAILED",
            "message": "resume offset exceeds file size",
            "transferId": transfer_id,
        });
        session.send_to_client_generation(
            client_id,
            expected_conn_gen,
            protocol::encode_message(
                protocol::MSG_ERROR,
                serde_json::to_vec(&err).unwrap_or_default().as_slice(),
            ),
        );
        return;
    }
    if start_offset > 0 {
        use tokio::io::AsyncSeekExt;
        let seek = tokio::select! {
            _ = cancellation.cancelled() => return,
            result = tokio::time::timeout(
                SFTP_OPERATION_TIMEOUT,
                file.seek(std::io::SeekFrom::Start(start_offset)),
            ) => result,
        };
        if let Err(message) = match seek {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => Err(format!("seek: {error}")),
            Err(_) => Err("seek timed out".to_string()),
        } {
            let err = serde_json::json!({
                "code": "READ_FAILED",
                "message": message,
                "transferId": transfer_id,
            });
            session.send_to_client_generation(
                client_id,
                expected_conn_gen,
                protocol::encode_message(
                    protocol::MSG_ERROR,
                    serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                ),
            );
            return;
        }
    }

    if total_size == 0 {
        if cancellation.is_cancelled()
            || !download_authorized(session, client_id, expected_conn_gen)
        {
            return;
        }
        // Empty file: send a single chunk with [4B transferId][8B totalSize=0][8B offset=0]
        let mut chunk_payload = Vec::with_capacity(20);
        chunk_payload.extend_from_slice(&transfer_id.to_be_bytes());
        chunk_payload.extend_from_slice(&0u64.to_be_bytes());
        chunk_payload.extend_from_slice(&0u64.to_be_bytes());
        session.send_to_client_generation(
            client_id,
            expected_conn_gen,
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
    let expected_conn_gen_send = expected_conn_gen;
    let sender_cancellation = cancellation.clone();
    const MERGE_TARGET: usize = 512 * 1024;
    let mut send_task = tokio::spawn(async move {
        let mut send_offset: u64 = start_offset;
        let mut merge_buf: Vec<u8> = Vec::with_capacity(MERGE_TARGET + 262144);
        loop {
            let chunk = tokio::select! {
                _ = sender_cancellation.cancelled() => return false,
                chunk = send_rx.recv() => chunk,
            };
            match chunk {
                Some(data) => {
                    if !download_authorized(&session_send, &client_id_send, expected_conn_gen_send)
                    {
                        return false;
                    }
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
                    if !download_authorized(&session_send, &client_id_send, expected_conn_gen_send)
                    {
                        return false;
                    }
                    let sent = tokio::select! {
                        _ = sender_cancellation.cancelled() => return false,
                        sent = session_send.send_bulk_to_client_generation_async(
                            &client_id_send,
                            expected_conn_gen_send,
                            protocol::encode_message(protocol::MSG_FILE_DOWNLOAD_CHUNK, &payload),
                        ) => sent,
                    };
                    if !sent {
                        return false;
                    }
                }
                None => {
                    if !merge_buf.is_empty() {
                        if !download_authorized(
                            &session_send,
                            &client_id_send,
                            expected_conn_gen_send,
                        ) {
                            return false;
                        }
                        let mut payload = Vec::with_capacity(4 + 16 + merge_buf.len());
                        payload.extend_from_slice(&transfer_id.to_be_bytes());
                        payload.extend_from_slice(&total_size.to_be_bytes());
                        payload.extend_from_slice(&send_offset.to_be_bytes());
                        payload.extend_from_slice(&merge_buf);
                        let sent = tokio::select! {
                            _ = sender_cancellation.cancelled() => return false,
                            sent = session_send.send_bulk_to_client_generation_async(
                                &client_id_send,
                                expected_conn_gen_send,
                                protocol::encode_message(
                                    protocol::MSG_FILE_DOWNLOAD_CHUNK,
                                    &payload,
                                ),
                            ) => sent,
                        };
                        if !sent {
                            return false;
                        }
                    }
                    return true;
                }
            }
        }
    });

    let remaining_size = total_size.saturating_sub(start_offset) as usize;
    let max_inflight_bytes = remaining_size
        .min(DOWNLOAD_MAX_INFLIGHT_BYTES)
        .max(MERGE_TARGET);
    let tx_read = tx.clone();

    let read = file.read_pipelined_streaming_each(max_inflight_bytes, {
        let ctrl = Arc::clone(&ctrl);
        let cancelled = Arc::clone(&cancelled);
        let cancellation = cancellation.clone();
        let session_authority = Arc::clone(session);
        let client_id_authority = client_id.to_string();
        move |chunk_data| {
            let ctrl = Arc::clone(&ctrl);
            let cancelled = Arc::clone(&cancelled);
            let tx = tx_read.clone();
            let cancellation = cancellation.clone();
            let session_authority = Arc::clone(&session_authority);
            let client_id_authority = client_id_authority.clone();
            async move {
                if !download_authorized(&session_authority, &client_id_authority, expected_conn_gen)
                {
                    cancelled.store(true, Ordering::Relaxed);
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Interrupted,
                        "download authority revoked",
                    ));
                }
                let mut ctrl = ctrl.lock().await;
                if wait_download_ctrl(&mut ctrl, &cancellation, || {
                    !download_authorized(
                        &session_authority,
                        &client_id_authority,
                        expected_conn_gen,
                    )
                })
                .await
                {
                    cancelled.store(true, Ordering::Relaxed);
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Interrupted,
                        "download cancelled",
                    ));
                }
                drop(ctrl);

                tokio::select! {
                    _ = cancellation.cancelled() => {
                        cancelled.store(true, Ordering::Relaxed);
                        Err(std::io::Error::new(
                            std::io::ErrorKind::Interrupted,
                            "download cancelled",
                        ))
                    }
                    result = tx.send(chunk_data) => result.map_err(|_| {
                        std::io::Error::new(
                            std::io::ErrorKind::BrokenPipe,
                            "download queue closed",
                        )
                    })
                }
            }
        }
    });
    tokio::pin!(read);
    let read_result = tokio::select! {
        _ = cancellation.cancelled() => {
            cancelled.store(true, Ordering::Relaxed);
            Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "download cancelled",
            ))
        }
        result = &mut read => result,
    };

    if let Err(e) = read_result {
        if !cancelled.load(Ordering::Relaxed) || e.kind() != std::io::ErrorKind::Interrupted {
            let err = serde_json::json!({"code": "READ_FAILED", "message": format!("read: {}", e), "transferId": transfer_id});
            session.send_to_client_generation(
                client_id,
                expected_conn_gen,
                protocol::encode_message(
                    protocol::MSG_ERROR,
                    serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                ),
            );
        }
        drop(tx);
        send_task.abort();
        let _ = send_task.await;
        return;
    }

    // Signal sender we're done reading, then wait for queued sends.
    drop(tx);
    let send_completed = tokio::select! {
        _ = cancellation.cancelled() => {
            send_task.abort();
            false
        }
        result = &mut send_task => result.unwrap_or(false),
    };
    if !send_completed {
        return;
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn paused_download_stops_when_external_authority_is_revoked() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(4);
        tx.send(DownloadSignal::Pause).await.unwrap();
        let revoked = Arc::new(AtomicBool::new(false));
        let revoked_for_wait = Arc::clone(&revoked);
        let wait = tokio::spawn(async move {
            wait_download_ctrl(&mut rx, &CancellationToken::new(), || {
                revoked_for_wait.load(Ordering::SeqCst)
            })
            .await
        });

        tokio::task::yield_now().await;
        revoked.store(true, Ordering::SeqCst);
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), wait)
                .await
                .unwrap()
                .unwrap()
        );
    }

    #[test]
    fn resume_offset_must_not_exceed_current_file_size() {
        assert!(super::super::validate_download_offset(0, 0).is_ok());
        assert!(super::super::validate_download_offset(8, 8).is_ok());
        assert_eq!(
            super::super::validate_download_offset(9, 8),
            Err("resume offset exceeds file size")
        );
    }
}
