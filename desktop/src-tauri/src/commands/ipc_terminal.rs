//! Local IPC terminal commands — replaces WebSocket for local frontend communication.
//!
//! Uses `tauri::ipc::Channel<Vec<u8>>` for downstream (server → frontend) and
//! `invoke` for upstream (frontend → server). Messages use the same binary
//! frame format `[MsgType: u8][Payload]` as WebSocket for protocol compatibility.

use std::sync::Arc;
use tauri::State;

use crate::server::protocol;
use crate::server::session::client::Client;
use crate::server::session::state::ClientRole;
use crate::server::ServerState;

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
    let actual_role = if session.master() == id {
        "master"
    } else {
        client.role.as_str()
    };
    let cols = *session.last_cols.lock().unwrap();
    let rows = *session.last_rows.lock().unwrap();

    // Send Hello via Channel
    let conn_gen = client.conn_gen();
    let hello = protocol::encode_hello(&id, actual_role, 1, cols, rows, conn_gen);
    if !session.send_to_client_generation(&id, conn_gen, hello) {
        session.remove_client(&id, conn_gen);
        return Err("IPC terminal output channel closed during hello".to_string());
    }

    // Send role change
    let role_byte = if session.master() == id {
        ClientRole::Master as u8
    } else {
        client.role as u8
    };
    if !session.send_to_client_generation(&id, conn_gen, protocol::encode_role_change(role_byte)) {
        session.remove_client(&id, conn_gen);
        return Err("IPC terminal output channel closed during role setup".to_string());
    }

    // 回放历史:agent 会话带背压回放 MSG_AGENT_EVENT 帧,终端会话回放 PTY 环形缓冲。
    // 与 ws.rs::handle_ws 同序同法:client 已在 add_client 时入 session.clients,attach 逐帧
    // `send_async` 回放后原子登记进 attached,fan-out 只投给 attached——不这样 agent 会话的 IPC
    // 观看端永不进 attached、收不到任何 live 帧。IPC 下行是 Tauri Channel(无背压容量限制),
    // `send_async` 即时返回,故无需像 WS 那样先起 writer 排空通道。
    if let Some(entry) = state.agents.get(&session_id) {
        entry.attach(&client).await;
        // Mirror 会话底层带 PTY:AI 历史(attach)之外再回放终端环形缓冲(见 ws.rs 同段说明)。
        // IPC 下行是 Tauri Channel(无背压容量限制),两类帧顺序不影响正确性。
        if entry.kind() == crate::server::agent::AgentKind::Mirror {
            session.flush_ring_buffer(&client, client.conn_gen());
        }
    } else {
        session.flush_ring_buffer(&client, client.conn_gen());
    }
    if session.current_client_connection(&id, conn_gen).is_none() {
        session.remove_client(&id, conn_gen);
        return Err("IPC terminal output channel closed during replay".to_string());
    }

    eprintln!(
        "[ipc] connected client={} session={} role={}",
        id, session_id, actual_role
    );

    Ok(serde_json::json!({
        "client_id": id,
        "role": actual_role,
        "cols": cols,
        "rows": rows,
        "conn_gen": client.conn_gen(),
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
    let conn_gen = session
        .client_connection_generation(&client_id)
        .ok_or("client not connected")?;
    if let Some(authority) = session.current_client_connection(&client_id, conn_gen) {
        session.handle_authorized_input(&authority, &data);
    }
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
    let conn_gen = session
        .client_connection_generation(&client_id)
        .ok_or("client not connected")?;
    if let Some(authority) = session.current_client_connection(&client_id, conn_gen) {
        session.handle_authorized_resize(&authority, cols, rows);
    }
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
    let conn_gen = session
        .client_connection_generation(&client_id)
        .ok_or("client not connected")?;
    // Reuse the ping handler from dispatch
    crate::server::dispatch::dispatch_message(
        &session,
        &client_id,
        conn_gen,
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
    let conn_gen = session
        .client_connection_generation(&client_id)
        .ok_or("client not connected")?;
    crate::server::dispatch::dispatch_message(
        &session, &client_id, conn_gen, msg_type, &payload, &state,
    )
    .await;
    Ok(())
}
