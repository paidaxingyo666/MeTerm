//! WebSocket handler — handles WS upgrade and message loop.
//!
//! Message dispatch logic lives in `dispatch.rs` (shared with IPC commands).

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
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Path(session_id): Path<String>,
    Query(query): Query<WsQuery>,
) -> impl IntoResponse {
    let remote_addr = addr.ip().to_string();
    ws.protocols(["meterm.v1"])
        .on_upgrade(move |socket| handle_ws(socket, state, session_id, query, remote_addr))
}

/// Main WebSocket handler — runs after upgrade.
async fn handle_ws(
    mut socket: WebSocket,
    state: Arc<ServerState>,
    session_id: String,
    query: WsQuery,
    remote_addr: String,
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
            remote_addr.clone(),
            state.config.reconnect_grace,
        ) {
            Ok(rx) => {
                let clients = session.clients.lock().unwrap();
                let client = clients.get(cid).cloned().unwrap();
                (client, rx)
            }
            Err(_) => {
                let (client, rx) = create_new_client(&session, &query, &remote_addr);
                (client, rx)
            }
        }
    } else {
        create_new_client(&session, &query, &remote_addr)
    };

    let client_id = client.id.clone();
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
        1,
        *session.last_cols.lock().unwrap(),
        *session.last_rows.lock().unwrap(),
    );
    if socket.send(Message::Binary(hello.into())).await.is_err() {
        return;
    }

    // 4. Send role change
    let role_byte = if session.master() == client_id {
        super::session::state::ClientRole::Master as u8
    } else {
        client.role as u8
    };
    let role_msg = protocol::encode_role_change(role_byte);
    let _ = socket.send(Message::Binary(role_msg.into())).await;

    // 5. Flush ring buffer
    session.flush_ring_buffer(&client);

    // 6. Bidirectional message loop
    let conn_gen = client.conn_gen();
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
                    None => break,
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
                        super::dispatch::dispatch_message(&session, &client_id, msg_type, payload, &state).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
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
    remote_addr: &str,
) -> (Arc<Client>, tokio::sync::mpsc::Receiver<Vec<u8>>) {
    let id = uuid::Uuid::new_v4().to_string();
    let role = match query.mode.as_deref() {
        Some("readonly") => ClientRole::ReadOnly,
        _ => ClientRole::Viewer,
    };
    let (client, rx) = Client::new(id, remote_addr.to_string(), role);
    let client = Arc::new(client);
    let _ = session.add_client(client.clone());
    (client, rx)
}
