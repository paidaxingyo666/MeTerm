//! Message dispatch — shared by WebSocket handler and local IPC commands.
//!
//! Processes incoming binary frames `[MsgType: u8][Payload]` and routes
//! them to the appropriate session/file handler.

use std::sync::Arc;

use super::protocol;
use super::session::access::DispatchAuthority;
use super::session::downloads::{DownloadOwner, DownloadRegistration, DownloadRegistryError};
use super::session::Session;
use super::ServerState;

#[path = "dispatch/download.rs"]
mod download;
#[path = "dispatch/file_policy.rs"]
mod file_policy;
#[path = "dispatch/master.rs"]
mod master;
#[path = "dispatch/upload.rs"]
mod upload;

pub use download::wait_download_ctrl;
use download::{handle_local_file_download, handle_sftp_file_download};

/// Check if the client is master for this session.
/// 非 master 的文件操作被拒时回错误帧(此前静默丢弃,客户端只能干等)。
fn deny_not_master(session: &Session, authority: &DispatchAuthority) {
    let err = serde_json::json!({
        "code": "NOT_MASTER",
        "message": "需要接管会话后才能操作文件",
    });
    session.send_to_client_generation(
        authority.client_id(),
        authority.conn_gen(),
        protocol::encode_message(
            protocol::MSG_ERROR,
            serde_json::to_vec(&err).unwrap_or_default().as_slice(),
        ),
    );
}

fn deny_owner_only(session: &Session, authority: &DispatchAuthority) {
    let err = serde_json::json!({
        "code": "OWNER_ONLY",
        "message": "该管理操作仅允许本机桌面端执行",
    });
    session.send_to_client_generation(
        authority.client_id(),
        authority.conn_gen(),
        protocol::encode_message(
            protocol::MSG_ERROR,
            serde_json::to_vec(&err).unwrap_or_default().as_slice(),
        ),
    );
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

pub fn validate_download_offset(start_offset: u64, total_size: u64) -> Result<(), &'static str> {
    if start_offset > total_size {
        Err("resume offset exceeds file size")
    } else {
        Ok(())
    }
}

fn transfer_owner_key(
    authority: &DispatchAuthority,
    transfer_id: u32,
) -> super::session::TransferOwnerKey {
    (
        authority.client_id().to_string(),
        authority.conn_gen(),
        transfer_id,
    )
}

fn parse_transfer_id(value: &serde_json::Value) -> Option<u32> {
    let raw = value.get("transferId")?.as_u64()?;
    u32::try_from(raw).ok().filter(|id| *id != 0)
}

fn ws_download_owner(authority: &DispatchAuthority, transfer_id: u32) -> DownloadOwner {
    DownloadOwner::ws(authority.client_id(), authority.conn_gen(), transfer_id)
}

fn register_ws_download(
    session: &Session,
    authority: &DispatchAuthority,
    transfer_id: u32,
    control: tokio::sync::mpsc::Sender<super::session::DownloadSignal>,
) -> Option<DownloadRegistration> {
    match session
        .download_registry
        .register(ws_download_owner(authority, transfer_id), control)
    {
        Ok(registration) => Some(registration),
        Err(error) => {
            let (code, message) = match error {
                DownloadRegistryError::AlreadyRegistered => (
                    "TRANSFER_ID_IN_USE",
                    "download transferId is already active",
                ),
                DownloadRegistryError::ClientLimitReached
                | DownloadRegistryError::SessionLimitReached => (
                    "TRANSFER_LIMIT_REACHED",
                    "too many downloads are active or still cancelling",
                ),
                DownloadRegistryError::Closed => ("SESSION_CLOSED", "session is closed"),
                DownloadRegistryError::EmptyClientId | DownloadRegistryError::InvalidTransferId => {
                    ("INVALID_REQUEST", "invalid download owner")
                }
            };
            let response = serde_json::json!({
                "code": code,
                "message": message,
                "transferId": transfer_id,
            });
            session.send_to_client_generation(
                authority.client_id(),
                authority.conn_gen(),
                protocol::encode_message(
                    protocol::MSG_ERROR,
                    serde_json::to_vec(&response).unwrap_or_default().as_slice(),
                ),
            );
            None
        }
    }
}

/// Dispatch a single incoming message to the appropriate handler.
pub async fn dispatch_message(
    session: &Arc<Session>,
    client_id: &str,
    conn_gen: u64,
    msg_type: u8,
    payload: &[u8],
    state: &ServerState,
) {
    let Some(authority) = session.current_client_connection(client_id, conn_gen) else {
        return;
    };
    let security = authority.security();
    // A revoke may race frames already buffered by the WebSocket reader. Check
    // both connection state and the exact credential generation immediately
    // before executing any frame, not only when the socket was upgraded.
    if !security.is_current(&state.authenticator) {
        session.remove_client(client_id, conn_gen);
        return;
    }
    if !super::device_access::can_access_session(&state.authenticator, &security.principal, session)
    {
        session.remove_client(client_id, conn_gen);
        return;
    }
    if file_policy::reject_unavailable_sftp(session, &authority, msg_type) {
        return;
    }

    // 任何客户端消息都刷新活性(IPC 通道无断开事件,判活靠这个 + 周期 ping)
    session.touch_client_generation(client_id, conn_gen);
    match msg_type {
        protocol::MSG_INPUT => {
            session.handle_authorized_input(&authority, payload);
        }
        protocol::MSG_RESIZE => {
            if let Some((cols, rows)) = protocol::decode_resize(payload) {
                session.handle_authorized_resize(&authority, cols, rows);
            }
        }
        protocol::MSG_PING => {
            handle_ping(session, &authority).await;
        }
        protocol::MSG_NUDGE => {
            if !authority.can_control() {
                deny_not_master(session, &authority);
                return;
            }
            session.nudge_resize();
        }
        protocol::MSG_MASTER_RELEASE => {
            session.release_master_for_connection(client_id, conn_gen);
        }
        protocol::MSG_SET_ENCODING => {
            if !authority.can_control() {
                deny_not_master(session, &authority);
                return;
            }
            if let Ok(name) = std::str::from_utf8(payload) {
                session.set_encoding(name);
            }
        }
        protocol::MSG_MASTER_REQUEST => {
            master::request(session, client_id, conn_gen);
        }
        protocol::MSG_MASTER_APPROVAL => {
            master::approval(session, client_id, conn_gen, payload);
        }
        protocol::MSG_MASTER_RECLAIM => {
            session.reclaim_master_for_connection(client_id, conn_gen);
        }
        protocol::MSG_FILE_LIST => {
            if !authority.can_control() {
                deny_not_master(session, &authority);
                return;
            }
            let sftp = session.sftp.lock().unwrap().clone();
            if let Some(sftp) = sftp {
                let client_id = client_id.to_string();
                let expected_conn_gen = conn_gen;
                let session = session.clone();
                let payload = payload.to_vec();
                tokio::spawn(async move {
                    super::file_handler::handle_sftp_file_list_with_progress(
                        &payload,
                        &sftp,
                        &session,
                        &client_id,
                        expected_conn_gen,
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
                    session.send_to_client_generation(
                        client_id,
                        conn_gen,
                        super::protocol::encode_message(
                            super::protocol::MSG_ERROR,
                            serde_json::to_vec(&err).unwrap_or_default().as_slice(),
                        ),
                    );
                } else {
                    let resp = super::file_handler::handle_file_list(payload);
                    session.send_to_client_generation(client_id, conn_gen, resp);
                }
            }
        }
        protocol::MSG_FILE_SEARCH => {
            if !authority.can_control() {
                deny_not_master(session, &authority);
                return;
            }
            let sftp = session.sftp.lock().unwrap().clone();
            let client_id = client_id.to_string();
            let expected_conn_gen = conn_gen;
            let session = session.clone();
            let payload = payload.to_vec();
            if let Some(sftp) = sftp {
                // SFTP (SSH / JumpServer): async recursive read_dir walk.
                tokio::spawn(async move {
                    super::file_search::handle_sftp_file_search(
                        &payload,
                        &sftp,
                        &session,
                        &client_id,
                        expected_conn_gen,
                    )
                    .await;
                });
            } else {
                // Local filesystem: blocking walkdir on a blocking thread.
                tokio::task::spawn_blocking(move || {
                    super::file_search::handle_local_file_search(
                        &payload,
                        &session,
                        &client_id,
                        expected_conn_gen,
                    );
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
            if !is_stat && !authority.can_control() {
                deny_not_master(session, &authority);
                return;
            }
            let sftp = session.sftp.lock().unwrap().clone();
            if let Some(sftp) = sftp {
                let client_id = client_id.to_string();
                let expected_conn_gen = conn_gen;
                let session = session.clone();
                let payload = payload.to_vec();
                tokio::spawn(async move {
                    let resp =
                        super::file_handler::handle_sftp_file_operation(&payload, &sftp).await;
                    let resp = super::file_handler::maybe_upgrade_sftp_auth_error(resp);
                    session.send_to_client_generation(&client_id, expected_conn_gen, resp);
                });
            } else {
                let resp = super::file_handler::handle_file_operation(payload);
                session.send_to_client_generation(client_id, conn_gen, resp);
            }
        }
        protocol::MSG_FILE_READ_REQUEST => {
            if !authority.can_control() {
                deny_not_master(session, &authority);
                return;
            }
            let sftp = session.sftp.lock().unwrap().clone();
            if let Some(sftp) = sftp {
                let payload = payload.to_vec();
                let client_id = client_id.to_string();
                let expected_conn_gen = conn_gen;
                let session = session.clone();
                tokio::spawn(async move {
                    let resp = super::file_handler::handle_sftp_file_read(&payload, &sftp).await;
                    let resp = super::file_handler::maybe_upgrade_sftp_auth_error(resp);
                    session.send_to_client_generation(&client_id, expected_conn_gen, resp);
                });
            } else {
                let resp = super::file_handler::handle_file_read_json(payload);
                session.send_to_client_generation(client_id, conn_gen, resp);
            }
        }
        protocol::MSG_FILE_SAVE_REQUEST => {
            if !authority.can_control() {
                deny_not_master(session, &authority);
                return;
            }
            let sftp = session.sftp.lock().unwrap().clone();
            if let Some(sftp) = sftp {
                let payload = payload.to_vec();
                let client_id = client_id.to_string();
                let expected_conn_gen = conn_gen;
                let session = session.clone();
                tokio::spawn(async move {
                    let resp = super::file_handler::handle_sftp_file_save(&payload, &sftp).await;
                    let resp = super::file_handler::maybe_upgrade_sftp_auth_error(resp);
                    session.send_to_client_generation(&client_id, expected_conn_gen, resp);
                });
            } else {
                let resp = super::file_handler::handle_file_save(payload);
                session.send_to_client_generation(client_id, conn_gen, resp);
            }
        }
        protocol::MSG_SERVER_INFO => {
            let payload = payload.to_vec();
            let client_id = client_id.to_string();
            let expected_conn_gen = conn_gen;
            let session = session.clone();
            tokio::spawn(async move {
                let resp = super::server_info::handle_server_info(&session, &payload).await;
                session.send_to_client_generation(&client_id, expected_conn_gen, resp);
            });
        }
        protocol::MSG_FILE_DOWNLOAD_START => {
            if !authority.can_control() {
                deny_not_master(session, &authority);
                return;
            }
            if let Ok(req) = serde_json::from_slice::<serde_json::Value>(payload) {
                let path = req
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let Some(transfer_id) = parse_transfer_id(&req) else {
                    return;
                };
                if !path.is_empty() {
                    eprintln!(
                        "[download] start path={:?} transfer_id={}",
                        path, transfer_id
                    );
                    let (ctrl_tx, ctrl_rx) =
                        tokio::sync::mpsc::channel::<super::session::DownloadSignal>(4);
                    let Some(registration) =
                        register_ws_download(session, &authority, transfer_id, ctrl_tx)
                    else {
                        return;
                    };
                    let cancellation = registration.cancellation_token();
                    let client_id_clone = client_id.to_string();
                    let expected_conn_gen = conn_gen;
                    let session_clone = session.clone();
                    let sftp = session.sftp.lock().unwrap().clone();
                    tokio::spawn(async move {
                        let _download_guard =
                            session_clone.download_registry.task_guard(registration);
                        if let Some(sftp) = sftp {
                            handle_sftp_file_download(
                                &session_clone,
                                &client_id_clone,
                                expected_conn_gen,
                                &path,
                                0,
                                &sftp,
                                ctrl_rx,
                                transfer_id,
                                cancellation,
                            )
                            .await;
                        } else {
                            handle_local_file_download(
                                &session_clone,
                                &client_id_clone,
                                expected_conn_gen,
                                &path,
                                0,
                                ctrl_rx,
                                transfer_id,
                                cancellation,
                            )
                            .await;
                        }
                    });
                }
            }
        }
        protocol::MSG_FILE_UPLOAD_START => {
            if !authority.can_control() {
                deny_not_master(session, &authority);
                return;
            }
            upload::handle_upload_start(session, &authority, payload).await;
        }
        protocol::MSG_FILE_UPLOAD_CHUNK => {
            if !authority.can_control() {
                deny_not_master(session, &authority);
                return;
            }
            upload::handle_upload_chunk(session, &authority, payload).await;
        }
        protocol::MSG_FILE_UPLOAD_RESUME => {
            if !authority.can_control() {
                deny_not_master(session, &authority);
                return;
            }
            upload::handle_upload_resume(session, &authority, payload).await;
        }
        protocol::MSG_FILE_DOWNLOAD_PAUSE => {
            if !authority.can_control() {
                deny_not_master(session, &authority);
                return;
            }
            let Some(transfer_id) = serde_json::from_slice::<serde_json::Value>(payload)
                .ok()
                .as_ref()
                .and_then(parse_transfer_id)
            else {
                return;
            };
            session
                .download_registry
                .pause_owner(&ws_download_owner(&authority, transfer_id));
        }
        protocol::MSG_FILE_DOWNLOAD_CONTINUE => {
            if !authority.can_control() {
                deny_not_master(session, &authority);
                return;
            }
            let Some(transfer_id) = serde_json::from_slice::<serde_json::Value>(payload)
                .ok()
                .as_ref()
                .and_then(parse_transfer_id)
            else {
                return;
            };
            session
                .download_registry
                .continue_owner(&ws_download_owner(&authority, transfer_id));
        }
        protocol::MSG_FILE_DOWNLOAD_CANCEL => {
            if !authority.can_control() {
                deny_not_master(session, &authority);
                return;
            }
            let Some(transfer_id) = serde_json::from_slice::<serde_json::Value>(payload)
                .ok()
                .as_ref()
                .and_then(parse_transfer_id)
            else {
                return;
            };
            session
                .download_registry
                .cancel_owner(&ws_download_owner(&authority, transfer_id));
        }
        protocol::MSG_FILE_DOWNLOAD_RESUME => {
            if !authority.can_control() {
                deny_not_master(session, &authority);
                return;
            }
            if let Ok(req) = serde_json::from_slice::<serde_json::Value>(payload) {
                let path = req
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let offset = req.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
                let Some(transfer_id) = parse_transfer_id(&req) else {
                    return;
                };
                if !path.is_empty() {
                    let (ctrl_tx, ctrl_rx) =
                        tokio::sync::mpsc::channel::<super::session::DownloadSignal>(4);
                    let Some(registration) =
                        register_ws_download(session, &authority, transfer_id, ctrl_tx)
                    else {
                        return;
                    };
                    let cancellation = registration.cancellation_token();
                    let client_id = client_id.to_string();
                    let expected_conn_gen = conn_gen;
                    let session = session.clone();
                    let sftp = session.sftp.lock().unwrap().clone();
                    tokio::spawn(async move {
                        let _download_guard = session.download_registry.task_guard(registration);
                        if let Some(sftp) = sftp {
                            handle_sftp_file_download(
                                &session,
                                &client_id,
                                expected_conn_gen,
                                &path,
                                offset,
                                &sftp,
                                ctrl_rx,
                                transfer_id,
                                cancellation,
                            )
                            .await;
                        } else {
                            handle_local_file_download(
                                &session,
                                &client_id,
                                expected_conn_gen,
                                &path,
                                offset,
                                ctrl_rx,
                                transfer_id,
                                cancellation,
                            )
                            .await;
                        }
                    });
                }
            }
        }
        protocol::MSG_PAIR_APPROVAL => {
            if !security.is_trusted_local_owner() {
                deny_owner_only(session, &authority);
                return;
            }
            if !authority.can_control() {
                deny_not_master(session, &authority);
                return;
            }
            if payload.len() >= 2 {
                let approved = payload[0] == 1;
                if let Ok(pair_id) = std::str::from_utf8(&payload[1..]) {
                    let result = match security.principal.owner_generation() {
                        Some(generation) if generation.is_nil() => state
                            .pairing_manager
                            .handle_local_approval(approved, pair_id),
                        Some(generation) => state
                            .pairing_manager
                            .handle_approval(approved, pair_id, generation),
                        None => Err("owner credential required".to_string()),
                    };
                    match result {
                        Ok(Some(rotation)) => {
                            if let Some(retired_generation) = rotation.retired_generation {
                                state.disconnect_device_generation(
                                    &rotation.device_id,
                                    retired_generation,
                                );
                            }
                        }
                        Ok(None) => {}
                        Err(error) => eprintln!("[pairing] approval failed: {}", error),
                    }
                }
            }
        }
        // agent 会话上行:发消息(0x51)。master-gated;解析 + 防重叠 + 非阻塞驱动一轮
        // 都在 upstream::handle_agent_input 内(内部 tokio::spawn,不在此 await)。
        protocol::MSG_AGENT_INPUT => {
            if !authority.can_control() {
                deny_not_master(session, &authority);
                return;
            }
            super::agent::upstream::handle_agent_input(session, &authority, payload, state);
        }
        // agent 会话上行:审批 / 打断(0x52)。master-gated;解析 + 转对应 AcpClient
        // (统一 spawn,不阻塞 WS 读循环)都在 upstream::handle_agent_control 内。
        protocol::MSG_AGENT_CONTROL => {
            if !authority.can_control() {
                deny_not_master(session, &authority);
                return;
            }
            super::agent::upstream::handle_agent_control(session, &authority, payload, state);
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Ping handler
// ---------------------------------------------------------------------------

async fn handle_ping(session: &Arc<Session>, authority: &DispatchAuthority) {
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
                            session.send_to_client_generation(
                                authority.client_id(),
                                authority.conn_gen(),
                                protocol::encode_pong(Some(rtt_ms)),
                            );
                            return;
                        }
                        _ => {
                            session.close_with_frame(protocol::encode_session_end());
                            return;
                        }
                    }
                }
            }
        }
    }
    session.send_to_client_generation(
        authority.client_id(),
        authority.conn_gen(),
        protocol::encode_pong(None),
    );
}
