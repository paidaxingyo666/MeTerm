//! File-backend authorization for session WebSocket messages.
//!
//! An SSH session must never fall back to the desktop's local filesystem while
//! its SFTP subsystem is unavailable. The session's executor type is the
//! security boundary; the presence of an SFTP handle is only backend state.

use crate::server::{
    protocol,
    session::{access::DispatchAuthority, Session},
};

const FILE_BACKEND_REQUESTS: [u8; 10] = [
    protocol::MSG_FILE_LIST,
    protocol::MSG_FILE_SEARCH,
    protocol::MSG_FILE_OPERATION,
    protocol::MSG_FILE_READ_REQUEST,
    protocol::MSG_FILE_SAVE_REQUEST,
    protocol::MSG_FILE_DOWNLOAD_START,
    protocol::MSG_FILE_DOWNLOAD_RESUME,
    protocol::MSG_FILE_UPLOAD_START,
    protocol::MSG_FILE_UPLOAD_CHUNK,
    protocol::MSG_FILE_UPLOAD_RESUME,
];

fn is_file_backend_request(message_type: u8) -> bool {
    FILE_BACKEND_REQUESTS.contains(&message_type)
}

fn must_reject(executor_type: &str, sftp_available: bool, message_type: u8) -> bool {
    executor_type == "ssh" && !sftp_available && is_file_backend_request(message_type)
}

/// Reject file requests for an SSH session until SFTP is available.
///
/// Returns `true` when the caller must stop dispatching this frame. Local
/// sessions retain their existing local-filesystem behavior.
pub(super) fn reject_unavailable_sftp(
    session: &Session,
    authority: &DispatchAuthority,
    message_type: u8,
) -> bool {
    let executor_type = session.executor_type.lock().unwrap().clone();
    let sftp_available = session.sftp.lock().unwrap().is_some();
    if !must_reject(&executor_type, sftp_available, message_type) {
        return false;
    }

    let detail = session
        .sftp_init_error
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| "SFTP subsystem not ready yet, please retry".to_string());
    let error = serde_json::json!({
        "code": "SFTP_NOT_AVAILABLE",
        "message": detail,
    });
    session.send_to_client_generation(
        authority.client_id(),
        authority.conn_gen(),
        protocol::encode_message(
            protocol::MSG_ERROR,
            serde_json::to_vec(&error).unwrap_or_default().as_slice(),
        ),
    );
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::auth::{AuthPrincipal, TrustedIngress};
    use crate::server::session::client::{Client, ClientSecurityContext};
    use crate::server::session::state::ClientRole;
    use std::sync::Arc;

    #[test]
    fn every_file_backend_request_fails_closed_for_ssh_without_sftp() {
        for message_type in FILE_BACKEND_REQUESTS {
            assert!(
                must_reject("ssh", false, message_type),
                "message 0x{message_type:02x} must not reach local filesystem fallback"
            );
            assert!(!must_reject("ssh", true, message_type));
            assert!(!must_reject("local", false, message_type));
        }
    }

    #[test]
    fn response_and_transfer_control_frames_are_not_backend_open_requests() {
        for message_type in [
            protocol::MSG_FILE_LIST_RESP,
            protocol::MSG_FILE_DOWNLOAD_CHUNK,
            protocol::MSG_FILE_OPERATION_RESP,
            protocol::MSG_TRANSFER_PROGRESS,
            protocol::MSG_FILE_LIST_PROGRESS,
            protocol::MSG_FILE_READ_RESPONSE,
            protocol::MSG_FILE_SEARCH_RESP,
            protocol::MSG_FILE_DOWNLOAD_PAUSE,
            protocol::MSG_FILE_DOWNLOAD_CONTINUE,
            protocol::MSG_FILE_DOWNLOAD_CANCEL,
        ] {
            assert!(!is_file_backend_request(message_type));
            assert!(!must_reject("ssh", false, message_type));
        }
    }

    #[tokio::test]
    async fn dispatch_matrix_never_reaches_local_filesystem_for_ssh_without_sftp() {
        let state = crate::server::create_dummy_state();
        let principal = AuthPrincipal::Owner {
            generation: state.authenticator.current_owner_generation(),
        };
        let session = state.session_manager.create_for_principal(&principal);
        let security = ClientSecurityContext {
            ingress: TrustedIngress::DirectLoopback,
            principal,
        };
        let (client, mut receivers) = Client::new(
            "security-test-client".to_string(),
            "127.0.0.1".to_string(),
            ClientRole::Viewer,
            security,
        );
        session.add_client(Arc::new(client)).unwrap();

        let directory = std::env::temp_dir().join(format!(
            "meterm-ssh-file-policy-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let marker = directory.join("must-not-be-created");
        let payload = serde_json::to_vec(&serde_json::json!({
            "path": marker,
            "size": 0,
            "transferId": 1,
            "operation": "stat",
        }))
        .unwrap();

        for message_type in FILE_BACKEND_REQUESTS {
            super::super::dispatch_message(
                &session,
                "security-test-client",
                0,
                message_type,
                &payload,
                &state,
            )
            .await;
            let frame = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                receivers.priority_rx.recv(),
            )
            .await
            .expect("policy response timed out")
            .expect("policy response channel closed");
            assert_eq!(frame.first().copied(), Some(protocol::MSG_ERROR));
            let error: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
            assert_eq!(error["code"], "SFTP_NOT_AVAILABLE");
        }

        assert!(!marker.exists());
        let _ = std::fs::remove_dir_all(directory);
    }
}
