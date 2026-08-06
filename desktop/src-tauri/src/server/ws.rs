//! WebSocket handler — handles WS upgrade and message loop.
//!
//! Message dispatch logic lives in `dispatch.rs` (shared with IPC commands).

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Extension, Path, Query, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::{broadcast, oneshot};

use super::auth::{AuthPrincipal, TrustedIngress};
use super::events::PresenceRegistry;
use super::protocol;
use super::session::client::{Client, ClientSecurityContext, WsReceivers};
use super::session::state::ClientRole;
use super::ServerState;

/// Session messages include 1 MiB transfer chunks and, for the editor protocol, an
/// in-memory file plus a short path header. Full downloads remain chunked (0x0F).
const SESSION_WS_MAX_MESSAGE_SIZE: usize = 17 * 1024 * 1024;
const PRESENCE_WS_MAX_MESSAGE_SIZE: usize = 64 * 1024;

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
    Extension(principal): Extension<AuthPrincipal>,
    Extension(ingress): Extension<TrustedIngress>,
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Path(session_id): Path<String>,
    Query(query): Query<WsQuery>,
) -> axum::response::Response {
    let Some(session) = state.session_manager.get(&session_id) else {
        return axum::http::StatusCode::NOT_FOUND.into_response();
    };
    if !super::device_access::can_access_session(&state.authenticator, &principal, &session) {
        return axum::http::StatusCode::FORBIDDEN.into_response();
    }
    let remote_addr = addr.ip().to_string();
    let security = ClientSecurityContext { ingress, principal };
    ws.max_message_size(SESSION_WS_MAX_MESSAGE_SIZE)
        .max_frame_size(SESSION_WS_MAX_MESSAGE_SIZE)
        .protocols(["meterm.v1"])
        .on_upgrade(move |socket| {
            handle_ws(socket, state, session_id, query, remote_addr, security)
        })
        .into_response()
}

/// Main WebSocket handler — runs after upgrade.
async fn handle_ws(
    socket: WebSocket,
    state: Arc<ServerState>,
    session_id: String,
    query: WsQuery,
    remote_addr: String,
    security: ClientSecurityContext,
) {
    eprintln!(
        "[ws] new connection for session={}, client_id={:?}, mode={:?}",
        session_id, query.client_id, query.mode
    );

    // 1. Find session
    let session = match state.session_manager.get(&session_id) {
        Some(s) => s,
        None => {
            let err = protocol::encode_error(protocol::ERR_SESSION_NOT_FOUND, "session not found");
            let (mut sender, _) = socket.split();
            let _ = sender.send(Message::Binary(err.into())).await;
            return;
        }
    };

    // 2. Handle reconnect or create new client
    let (client, receivers) = if let Some(ref cid) = query.client_id {
        // Attempt reconnect
        match session.reconnect_client(
            cid,
            remote_addr.clone(),
            security.clone(),
            state.config.reconnect_grace,
        ) {
            Ok(rx) => {
                let clients = session.clients.lock().unwrap();
                let client = clients.get(cid).cloned().unwrap();
                (client, rx)
            }
            Err(_) => match create_new_client(&session, &query, &remote_addr, security.clone()) {
                Ok(created) => created,
                Err(error) => {
                    let err = protocol::encode_error(protocol::ERR_SESSION_PRIVATE, &error);
                    let (mut sender, _) = socket.split();
                    let _ = sender.send(Message::Binary(err.into())).await;
                    return;
                }
            },
        }
    } else {
        match create_new_client(&session, &query, &remote_addr, security) {
            Ok(created) => created,
            Err(error) => {
                let err = protocol::encode_error(protocol::ERR_SESSION_PRIVATE, &error);
                let (mut sender, _) = socket.split();
                let _ = sender.send(Message::Binary(err.into())).await;
                return;
            }
        }
    };

    let client_id = client.id.clone();
    // conn_gen 捕获点必须在此(step2 client 建立/reconnect 完成之后、长回放之前),记住**本 handler
    // H0 自己建立时的代次 G0**。若像旧代码那样放到 step6 长回放(attach + flush_ring_buffer_async)
    // 之后再读,则回放窗口内同 client_id 重连(H1)会把 conn_gen bump 到 G1,H0 读到的就是 G1;cleanup
    // 时 `remove_client(client_id, G1)` 与当前 gen 相等 → 不跳过 → 误 disconnect 刚重连的 H1 + 触发
    // master 误让(手机抖动重连后被自己的旧 handler 杀掉、master 易主的根因)。捕获前移到 G0 后,H1
    // bump 到 G1 使 `conn_gen()==G1≠G0` → remove_client 整体跳过,不误拆 H1(见 remove_client 语义)。
    let conn_gen = client.conn_gen();
    // Both authentication and the direct-LAN accept lease happened before the
    // WebSocket upgrade. Revalidate after registration so neither credential
    // revocation nor LAN shutdown can leave a late, unscanned socket alive.
    if !keep_session_registration(&state, &session, &client, conn_gen) {
        return;
    }
    let registered_security = client.security_context();
    let registered_principal = registered_security.principal;
    if !state
        .authenticator
        .is_principal_current(&registered_principal)
    {
        session.remove_client(&client_id, conn_gen);
        return;
    }
    // A reconnect may arrive before H0's writer notices its replaced channel.
    // Retire only H0 Active uploads before H1 can resume; Finalizing uploads
    // retain their path lease until their commit finishes.
    session.cleanup_stale_ws_uploads(&client_id, conn_gen).await;
    session
        .download_registry
        .cancel_stale_ws_generations(&client_id, conn_gen);
    let actual_role = if session.master() == client_id {
        "master"
    } else {
        client.role.as_str()
    };
    eprintln!(
        "[ws] client={} role={} master={}",
        client_id,
        actual_role,
        session.master()
    );

    let (mut sender, mut receiver) = socket.split();

    // 3. Send Hello
    let hello = protocol::encode_hello(
        &client_id,
        actual_role,
        1,
        *session.last_cols.lock().unwrap(),
        *session.last_rows.lock().unwrap(),
        conn_gen,
    );
    if sender.send(Message::Binary(hello.into())).await.is_err() {
        session.remove_client(&client_id, conn_gen);
        return;
    }

    // 4. Send role change
    let role_byte = if session.master() == client_id {
        super::session::state::ClientRole::Master as u8
    } else {
        client.role as u8
    };
    let role_msg = protocol::encode_role_change(role_byte);
    if sender.send(Message::Binary(role_msg.into())).await.is_err() {
        session.remove_client(&client_id, conn_gen);
        return;
    }

    // 5. 先 spawn writer(**writer-before-attach**),使下面步骤6的 agent 历史回放期间
    //    priority 通道被并发排空。这是背压回放的前提:attach 的 `send_async` 在通道满时
    //    等待,writer 排空后才继续——若 writer 尚未起,回放会一直阻塞。hello / role
    //    (步骤3/4)已直接经 sender 发出,writer 接管 sender 后先排 priority 再排 bulk,
    //    故手机收到序:hello → role → 历史帧 → live 帧,顺序正确。
    let WsReceivers {
        mut priority_rx,
        mut bulk_rx,
    } = receivers;
    let (writer_done_tx, mut writer_done_rx) = oneshot::channel::<()>();
    let writer = tokio::spawn(async move {
        let mut priority_open = true;
        let mut bulk_open = true;

        while priority_open || bulk_open {
            tokio::select! {
                biased;
                msg = priority_rx.recv(), if priority_open => {
                    match msg {
                        Some(data) => {
                            if sender.send(Message::Binary(data.into())).await.is_err() {
                                break;
                            }
                            while let Ok(data) = priority_rx.try_recv() {
                                if sender.send(Message::Binary(data.into())).await.is_err() {
                                    let _ = writer_done_tx.send(());
                                    return;
                                }
                            }
                        }
                        None => priority_open = false,
                    }
                }
                msg = bulk_rx.recv(), if bulk_open => {
                    match msg {
                        Some(data) => {
                            if sender.send(Message::Binary(data.into())).await.is_err() {
                                break;
                            }
                        }
                        None => bulk_open = false,
                    }
                }
            }
        }

        let _ = writer_done_tx.send(());
    });

    // 6. 回放历史(在 writer 之后):agent 会话带背压回放 MSG_AGENT_EVENT 帧——attach 逐帧
    //    `send_async`(通道满则等 writer 排空,不丢不断连),回放全部完成后原子把本 client 登记进
    //    attached 集合;fan-out 只投递给 attached、不走 broadcast——由此对晚 attach 的 client
    //    精确一次、有序(见 agent::manager 模块说明)。终端会话回放 PTY 环形缓冲(原逻辑)。
    if let Some(entry) = state.agents.get(&session_id) {
        // agent 会话:回放 AI 历史(attach 背压逐帧,writer 已在步骤5 spawn 并发排空)。
        entry.attach(&client).await;
        // Mirror 会话(方案甲)底层是带 PTY 的 local-shell:除 AI 历史外,再回放终端环形缓冲,
        // 使终端页与 AI 页在同一连接上都拿到历史。两类帧走同一 priority 通道,手机端按 opcode
        // (MSG_OUTPUT / 0x50)分流,先后顺序不影响正确性。**必须用背压变体**
        // `flush_ring_buffer_async`:attach 的背压回放可能把 priority 通道填到正好满,若这里再用
        // 非阻塞 `flush_ring_buffer` 首块就撞 Full → disconnect + 截断 → 大历史/慢 sink 下永久重连环
        // (attach 背压化消灭的 Critical bug 的终端缓冲镜像版)。背压 flush 满则等 writer 排空、绝不断连;
        // flush 同样在 writer 之后(步骤5),故背压前提成立。Acp 会话无 PTY,跳过 flush(现状不变)。
        if entry.kind() == super::agent::AgentKind::Mirror {
            session.flush_ring_buffer_async(&client, conn_gen).await;
        }
    } else {
        session.flush_ring_buffer(&client, conn_gen);
    }

    // 7. Bidirectional message loop
    // (conn_gen 已在 step2 之后捕获 H0 自己的代次 G0——见上方说明,cleanup 用它精确一次清理。)
    loop {
        tokio::select! {
            _ = &mut writer_done_rx => break,
            // Incoming: WebSocket client → session
            msg = receiver.next() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        if data.is_empty() {
                            continue;
                        }
                        let msg_type = data[0];
                        let payload = &data[1..];
                        super::dispatch::dispatch_message(
                            &session,
                            &client_id,
                            conn_gen,
                            msg_type,
                            payload,
                            &state,
                        ).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }

    // Cleanup
    session
        .cleanup_ws_uploads_for_connection(&client_id, conn_gen)
        .await;
    session
        .download_registry
        .cancel_ws_generation(&client_id, conn_gen);
    session.remove_client(&client_id, conn_gen);
    writer.abort();
}

/// `/ws-events` 的查询参数。`device_id` 为终端通知 Phase 3 新增:手机携带自己的
/// `device_id` 上线,使 presence 登记带上设备身份,供离线推送判定
/// (`PresenceRegistry::online_devices`)区分"这台手机当前是否在线"。
///
/// 兼容旧行为:不带 `device_id`(如旧版手机 / 未升级客户端)时为 `None`,
/// 仍按 P1 阶段的匿名 presence 处理,不影响 `has_any` 语义。
#[derive(Deserialize)]
pub struct EventsQuery {
    #[serde(default)]
    pub device_id: Option<String>,
}

/// presence 事件 WS 升级 handler(终端通知 Phase 1)——`/ws-events`。
///
/// 与会话级 `/ws/{session_id}` 不同,这条连接不绑定任何会话:客户端(手机端)
/// 连上后即订阅桌面事件总线(`EventBus`),桌面侧任意会话产生的通知性事件 /
/// 会话增删事件都会经这条连接转发过去。
pub async fn events_upgrade(
    ws: WebSocketUpgrade,
    Extension(state): Extension<Arc<ServerState>>,
    Extension(principal): Extension<AuthPrincipal>,
    Extension(ingress): Extension<TrustedIngress>,
    Query(query): Query<EventsQuery>,
) -> impl IntoResponse {
    let device_id = match &principal {
        AuthPrincipal::Device { device_id, .. }
            if query.device_id.as_deref() == Some(device_id.as_str()) =>
        {
            Some(device_id.clone())
        }
        AuthPrincipal::Device { .. } => return axum::http::StatusCode::FORBIDDEN.into_response(),
        AuthPrincipal::Owner { .. } => query
            .device_id
            .filter(|id| !id.is_empty() && id.len() <= 128),
    };
    let revocable_device =
        matches!(&principal, AuthPrincipal::Device { .. }) || ingress == TrustedIngress::Relay;
    let credential_generation = match &principal {
        AuthPrincipal::Device { generation, .. } => Some(*generation),
        AuthPrincipal::Owner { generation } => Some(*generation),
    };
    // echo 子协议,与 `ws_upgrade` 对齐(客户端以 `meterm.v1` 子协议连接,握手需回显)。
    ws.max_message_size(PRESENCE_WS_MAX_MESSAGE_SIZE)
        .max_frame_size(PRESENCE_WS_MAX_MESSAGE_SIZE)
        .protocols(["meterm.v1"])
        .on_upgrade(move |socket| {
            handle_events_ws(
                socket,
                state,
                device_id,
                credential_generation,
                revocable_device,
                principal,
                ingress,
            )
        })
        .into_response()
}

/// RAII guard——离开作用域(任何退出路径:正常收尾、错误、提前 return)时
/// 自动从 `PresenceRegistry` 注销该 client_id,避免遗漏 remove 导致的“幽灵在线”。
struct PresenceGuard {
    registry: PresenceRegistry,
    client_id: String,
}

impl Drop for PresenceGuard {
    fn drop(&mut self) {
        self.registry.remove(&self.client_id);
    }
}

/// presence 事件 WS 主循环——订阅 `EventBus`,把事件编码为二进制帧转发给对端,
/// 同时监听对端的关闭/错误以便及时退出并注销 presence。
///
/// `device_id`:见 `EventsQuery` 注释,`None` 时按旧行为登记(不带设备身份)。
async fn handle_events_ws(
    socket: WebSocket,
    state: Arc<ServerState>,
    device_id: Option<String>,
    credential_generation: Option<uuid::Uuid>,
    revocable_device: bool,
    principal: AuthPrincipal,
    ingress: TrustedIngress,
) {
    let client_id = uuid::Uuid::new_v4().to_string();
    eprintln!("[ws-events] new presence connection client_id={client_id}");

    // 登记上线;guard 确保无论下面循环怎么退出,都会在 drop 时 remove。
    let revoked = state.presence.insert_with_ingress(
        client_id.clone(),
        device_id,
        credential_generation,
        revocable_device,
        ingress,
    );
    let _presence_guard = PresenceGuard {
        registry: state.presence.clone(),
        client_id: client_id.clone(),
    };

    // Close both pre-upgrade races. If LAN shutdown scanned before this entry
    // appeared, the transition-serialized check rejects it; if credential
    // revocation scanned first, the generation check rejects it. The guard
    // immediately unregisters either rejected entry.
    if !keep_presence_registration(&state, &client_id, ingress) {
        return;
    }
    if !state.authenticator.is_principal_current(&principal) {
        return;
    }

    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.event_bus.subscribe();

    loop {
        tokio::select! {
            _ = revoked.cancelled() => break,
            // 桌面事件总线 → 编码为 `[MSG_NOTIFY_EVENT][JSON]` 二进制帧发给对端。
            ev = rx.recv() => {
                match ev {
                    Ok(event) => {
                        if !super::device_access::can_receive_event(&state, &principal, &event) {
                            continue;
                        }
                        let json = match serde_json::to_vec(&event) {
                            Ok(j) => j,
                            Err(err) => {
                                eprintln!("[ws-events] failed to serialize event: {}", err);
                                continue;
                            }
                        };
                        let frame = protocol::encode_message(protocol::MSG_NOTIFY_EVENT, &json);
                        if sender.send(Message::Binary(frame.into())).await.is_err() {
                            break;
                        }
                    }
                    // 订阅者太慢被 broadcast 丢弃了一部分历史事件——跳过,继续订阅后续事件。
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    // 所有 Sender 都已 drop(理论上不会发生,EventBus 由 ServerState 常驻持有)。
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            // 感知对端断开:收到 Close 帧、流结束或读错误都视为断开。
            msg = receiver.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }

    eprintln!(
        "[ws-events] presence connection closed client_id={}",
        client_id
    );
    // presence 注销由 `_presence_guard` 的 Drop 负责,这里无需手动调用。
}

fn create_new_client(
    session: &super::session::Session,
    query: &WsQuery,
    remote_addr: &str,
    security: ClientSecurityContext,
) -> Result<(Arc<Client>, WsReceivers), String> {
    let id = uuid::Uuid::new_v4().to_string();
    let role = match query.mode.as_deref() {
        Some("readonly") => ClientRole::ReadOnly,
        _ => ClientRole::Viewer,
    };
    let (client, rx) = Client::new(id, remote_addr.to_string(), role, security);
    let client = Arc::new(client);
    session.add_client(client.clone())?;
    Ok((client, rx))
}

fn keep_session_registration(
    state: &ServerState,
    session: &super::session::Session,
    client: &Client,
    conn_gen: u64,
) -> bool {
    if state.registered_ingress_allowed(client.security_context().ingress) {
        return true;
    }
    session.remove_client(&client.id, conn_gen);
    false
}

fn keep_presence_registration(
    state: &ServerState,
    client_id: &str,
    ingress: TrustedIngress,
) -> bool {
    if state.registered_ingress_allowed(ingress) {
        return true;
    }
    state.presence.remove(client_id);
    false
}

#[cfg(test)]
mod lan_registration_tests {
    use super::*;

    #[tokio::test]
    async fn late_direct_registrations_are_removed_but_relay_registrations_survive() {
        let state = Arc::new(crate::server::create_dummy_state());
        state.set_lan_access(true).unwrap();
        state.set_lan_access(false).unwrap();

        let session = state.session_manager.create();
        let (direct, _direct_receivers) = Client::new(
            "late-direct".to_string(),
            "192.0.2.10".to_string(),
            ClientRole::Viewer,
            ClientSecurityContext::test_device(TrustedIngress::DirectRemote, "phone-direct"),
        );
        let direct = Arc::new(direct);
        session.add_client(direct.clone()).unwrap();
        let direct_generation = direct.conn_gen();
        assert!(!keep_session_registration(
            &state,
            &session,
            &direct,
            direct_generation
        ));
        assert!(!direct.is_connected());

        let (relay, _relay_receivers) = Client::new(
            "late-relay".to_string(),
            "127.0.0.1".to_string(),
            ClientRole::Viewer,
            ClientSecurityContext::test_device(TrustedIngress::Relay, "phone-relay"),
        );
        let relay = Arc::new(relay);
        session.add_client(relay.clone()).unwrap();
        assert!(keep_session_registration(
            &state,
            &session,
            &relay,
            relay.conn_gen()
        ));
        assert!(relay.is_connected());

        let direct_presence = "presence-direct".to_string();
        state.presence.insert_with_ingress(
            direct_presence.clone(),
            Some("phone-direct".to_string()),
            Some(uuid::Uuid::new_v4()),
            true,
            TrustedIngress::DirectRemote,
        );
        assert!(!keep_presence_registration(
            &state,
            &direct_presence,
            TrustedIngress::DirectRemote
        ));
        assert!(!state.presence.has_any());

        let relay_presence = "presence-relay".to_string();
        state.presence.insert_with_ingress(
            relay_presence.clone(),
            Some("phone-relay".to_string()),
            Some(uuid::Uuid::new_v4()),
            true,
            TrustedIngress::Relay,
        );
        assert!(keep_presence_registration(
            &state,
            &relay_presence,
            TrustedIngress::Relay
        ));
        assert!(state.presence.has_any());
        state.presence.remove(&relay_presence);
    }
}
