//! Local IPC terminal commands — replaces WebSocket for local frontend communication.
//!
//! Uses `tauri::ipc::Channel<Vec<u8>>` for downstream (server → frontend) and
//! `invoke` for upstream (frontend → server). Messages use the same binary
//! frame format `[MsgType: u8][Payload]` as WebSocket for protocol compatibility.

use std::sync::Arc;
use tauri::State;

use crate::server::ServerState;
use crate::server::protocol;
use crate::server::session::client::Client;
use crate::server::session::state::ClientRole;

/// Connect to a session via local IPC. Creates an IPC client backed by a
/// Tauri Channel for downstream output. Returns hello info JSON.
#[tauri::command]
pub async fn ipc_connect_session(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    on_output: tauri::ipc::Channel<Vec<u8>>,
) -> Result<String, String> {
    let session = state
        .session_manager
        .get(&session_id)
        .ok_or_else(|| "session not found".to_string())?;

    let id = uuid::Uuid::new_v4().to_string();
    let client = Arc::new(Client::new_ipc(
        id.clone(),
        "ipc://local".to_string(),
        ClientRole::Viewer,
        on_output,
    ));
    session
        .add_client(client.clone())
        .map_err(|e| e.to_string())?;

    // Determine actual role after add_client (may have been promoted to Master)
    let actual_role = if session.master() == id { "master" } else { client.role.as_str() };
    let cols = *session.last_cols.lock().unwrap();
    let rows = *session.last_rows.lock().unwrap();

    // Send Hello via Channel
    let hello = protocol::encode_hello(&id, actual_role, 1, cols, rows);
    client.send(hello);

    // Send role change
    let role_byte = if session.master() == id {
        ClientRole::Master as u8
    } else {
        client.role as u8
    };
    client.send(protocol::encode_role_change(role_byte));

    // Flush ring buffer (historical terminal output)
    session.flush_ring_buffer(&client);

    eprintln!("[ipc] connected client={} session={} role={}", id, session_id, actual_role);

    Ok(serde_json::json!({
        "client_id": id,
        "role": actual_role,
        "cols": cols,
        "rows": rows,
    })
    .to_string())
}

/// Disconnect a local IPC client from a session.
#[tauri::command]
pub async fn ipc_disconnect_session(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    client_id: String,
) -> Result<(), String> {
    if let Some(session) = state.session_manager.get(&session_id) {
        session.remove_client(&client_id, 0); // conn_gen=0: IPC has no reconnect
    }
    Ok(())
}

/// Send terminal input data to a session.
#[tauri::command]
pub async fn ipc_session_input(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    client_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let session = state
        .session_manager
        .get(&session_id)
        .ok_or("session not found")?;
    session.handle_input(&client_id, &data);
    Ok(())
}

/// Resize the terminal for a session.
#[tauri::command]
pub async fn ipc_session_resize(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    client_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = state
        .session_manager
        .get(&session_id)
        .ok_or("session not found")?;
    session.handle_resize(&client_id, cols, rows);
    Ok(())
}

/// Ping a session (measures SSH RTT if applicable).
#[tauri::command]
pub async fn ipc_session_ping(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    client_id: String,
) -> Result<(), String> {
    let session = state
        .session_manager
        .get(&session_id)
        .ok_or("session not found")?;
    // Reuse the ping handler from dispatch
    crate::server::dispatch::dispatch_message(
        &session,
        &client_id,
        protocol::MSG_PING,
        &[],
        &state,
    )
    .await;
    Ok(())
}

/// Send a control/file message to a session.
/// Used for low-frequency messages: encoding, nudge, master control, file ops, etc.
#[tauri::command]
pub async fn ipc_session_control(
    state: State<'_, Arc<ServerState>>,
    session_id: String,
    client_id: String,
    msg_type: u8,
    payload: Vec<u8>,
) -> Result<(), String> {
    let session = state
        .session_manager
        .get(&session_id)
        .ok_or("session not found")?;
    crate::server::dispatch::dispatch_message(
        &session,
        &client_id,
        msg_type,
        &payload,
        &state,
    )
    .await;
    Ok(())
}
