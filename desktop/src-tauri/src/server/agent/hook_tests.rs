//! `hook.rs` 的单元测试(经 `#[path]` 挂为 `hook` 的子模块,`use super::*` 可访问其私有项:
//! `MirrorState` 字段 / `MirrorRegistry::inner` / `agent_mirror_flag` 等)。
//!
//! 不起 HTTP:直接 `.await` 调 handler 函数并传 extractor 值(项目内无 HTTP 层测试先例,
//! 与 brief 约定一致)。完整 state 用 `create_dummy_state`;镜像通路断言(attach client /
//! drain 帧)抄 `manager_mirror_tests` 骨架。fixture 行形状抄 `mirror_tests`(信封逼真,内容合成)。

use super::*;
use std::net::SocketAddr;
use std::time::Duration;

use axum::response::IntoResponse;
use serde_json::json;

use crate::server::handlers;
use crate::server::protocol;
use crate::server::session::client::{Client, WsReceivers};
use crate::server::session::state::ClientRole;
use crate::server::{create_dummy_state, ServerState};

// ── 测试助手(标 pub(super) 的供兄弟测试模块复用)──

fn dummy_state() -> Arc<ServerState> {
    Arc::new(create_dummy_state())
}

fn owner_principal(state: &ServerState) -> Extension<crate::server::auth::AuthPrincipal> {
    Extension(crate::server::auth::AuthPrincipal::Owner {
        generation: state.authenticator.current_owner_generation(),
    })
}

/// loopback peer(合法来路)。
pub(super) fn loopback() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 45678))
}

/// 非 loopback peer(LAN 来路,必须被一闸拒之门外)。
fn lan_peer() -> SocketAddr {
    SocketAddr::from(([192, 168, 1, 50], 45678))
}

/// 建一个真实会话 + 登记 hook secret,返回 (pty_sid, secret)。
fn setup_session(state: &Arc<ServerState>) -> (String, String) {
    let session = state.session_manager.create();
    let sid = session.id.clone();
    let secret = format!("test-secret-{}", sid);
    state.hook_secrets.register(sid.clone(), secret.clone());
    (sid, secret)
}

/// 组装转发脚本同款的 3 个 header。
pub(super) fn hook_headers(sid: &str, secret: &str, event: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert("x-meterm-session", sid.parse().unwrap());
    h.insert("x-meterm-secret", secret.parse().unwrap());
    h.insert("x-meterm-hook-event", event.parse().unwrap());
    h
}

/// SessionStart 的 hook stdin JSON(字段形状照 claude 官方 payload)。
pub(super) fn session_start_body(claude_sid: &str, transcript: &std::path::Path) -> Bytes {
    Bytes::from(
        json!({
            "hook_event_name": "SessionStart",
            "session_id": claude_sid,
            "transcript_path": transcript.to_string_lossy(),
            "cwd": "/tmp/proj",
            "source": "startup",
        })
        .to_string(),
    )
}

/// 无 payload 字段的简单事件 body(Stop / Notification 等)。
pub(super) fn event_body(event: &str) -> Bytes {
    Bytes::from(json!({ "hook_event_name": event, "session_id": "whatever" }).to_string())
}

/// SessionEnd 的 hook stdin JSON(FIX-1:身份比对要求 body 携带该次退出的 claude 会话 uuid)。
pub(super) fn session_end_body(claude_sid: &str) -> Bytes {
    Bytes::from(
        json!({ "hook_event_name": "SessionEnd", "session_id": claude_sid, "reason": "exit" })
            .to_string(),
    )
}

/// 直调 handler(不起 HTTP),取状态码(绝大多数测试只看状态码)。
pub(super) async fn call_hook(
    state: &Arc<ServerState>,
    peer: SocketAddr,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    call_hook_response(state, peer, headers, body)
        .await
        .status()
}

/// 完整 Response 版(P2 审批桥测试要断言响应 body)。
pub(super) async fn call_hook_response(
    state: &Arc<ServerState>,
    peer: SocketAddr,
    headers: HeaderMap,
    body: Bytes,
) -> axum::response::Response {
    agent_hook(
        Extension(state.clone()),
        Extension(if peer.ip().is_loopback() {
            crate::server::auth::TrustedIngress::DirectLoopback
        } else {
            crate::server::auth::TrustedIngress::DirectRemote
        }),
        headers,
        body,
    )
    .await
}

/// 唯一临时目录守卫(Drop 时整树删除,panic 也不残留;抄 mirror_tests::TempDir 范式)。
/// 测试各自隔离,勿互踩。**tailer 异步持有 transcript 路径**:守卫须绑定具名变量
/// (`_tmp` 这类下划线前缀仍存活)活到测试末尾,不得用裸 `_` 立即丢弃。
pub(super) struct TempDir(std::path::PathBuf);
impl TempDir {
    pub(super) fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "meterm-hook-m3-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    /// 目录内某文件的路径(transcript 用)。
    pub(super) fn file(&self, name: &str) -> std::path::PathBuf {
        self.0.join(name)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 造一条 assistant 行(形状抄 mirror_tests fixture:公共信封 + 单 block message)。
pub(super) fn assistant_line(uuid: &str, msg_id: &str, stop_reason: &str, text: &str) -> String {
    json!({
        "uuid": uuid, "parentUuid": null, "timestamp": "2026-07-09T00:00:00.000Z",
        "sessionId": "sess-1", "cwd": "/tmp/proj", "gitBranch": "main", "version": "2.1.202",
        "isSidechain": false, "userType": "external", "type": "assistant", "requestId": "req_1",
        "message": {
            "id": msg_id, "model": "claude-opus-4-8", "stop_reason": stop_reason,
            "usage": {"input_tokens": 3, "output_tokens": 5},
            "content": [{"type": "text", "text": text}]
        }
    })
    .to_string()
}

/// 建一个真实 Client 并加入 session(抄 manager_mirror_tests::attached_client)。
pub(super) fn attached_client(session: &Session, id: &str) -> (Arc<Client>, WsReceivers) {
    let (client, rx) = Client::new(
        id.into(),
        "127.0.0.1".into(),
        ClientRole::Viewer,
        crate::server::session::client::ClientSecurityContext::direct_loopback_owner(),
    );
    let client = Arc::new(client);
    session.add_client(client.clone()).unwrap();
    (client, rx)
}

/// 等待 priority 通道出现「payload 含 `needle` 的 0x50 帧」(5s 超时,轮询 tailer 落地)。
pub(super) async fn wait_for_agent_frame(
    rx: &mut mpsc::Receiver<Vec<u8>>,
    needle: &str,
) -> Vec<u8> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let frame = rx.recv().await.expect("通道关闭,镜像事件帧未到达");
            if frame[0] == protocol::MSG_AGENT_EVENT
                && String::from_utf8_lossy(&frame[1..]).contains(needle)
            {
                return frame;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("等待含「{}」的镜像事件帧超时", needle))
}

/// 读出 IntoResponse 的 body 字节(零 token 断言用)。
pub(super) async fn response_body(resp: axum::response::Response) -> Vec<u8> {
    axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec()
}

/// 读出 IntoResponse 的 body 并解析 JSON(/api/sessions 断言用)。
pub(super) async fn response_json(resp: axum::response::Response) -> serde_json::Value {
    serde_json::from_slice(&response_body(resp).await).unwrap()
}

/// 完整跑一遍「建会话 + SessionStart 升格」,返回 (state, pty_sid, secret, transcript, 目录守卫)。
/// 守卫必须由调用方持有到测试末尾(tailer 异步读 transcript),见 [`TempDir`] 注释。
pub(super) async fn mirrored_session(
    transcript_content: &str,
) -> (
    Arc<ServerState>,
    String,
    String,
    std::path::PathBuf,
    TempDir,
) {
    let state = dummy_state();
    let (sid, secret) = setup_session(&state);
    let tmp = TempDir::new();
    let transcript = tmp.file("claude-a.jsonl");
    std::fs::write(&transcript, transcript_content).unwrap();
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "SessionStart"),
        session_start_body("claude-sid-a", &transcript),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "SessionStart 应 200");
    (state, sid, secret, transcript, tmp)
}

// ── 决策 3:安全双闸(fail-closed)──
// Trusted-ingress boundary tests live in `hook_trusted_ingress_tests.rs`.

/// 二闸:错 secret / 未登记会话 → 401,且不处理 body。
#[tokio::test]
async fn wrong_or_unregistered_secret_rejected_401() {
    let state = dummy_state();
    let (sid, _secret) = setup_session(&state);
    let tmp = TempDir::new();
    let transcript = tmp.file("claude-a.jsonl");
    std::fs::write(&transcript, "").unwrap();

    // 错 secret。
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, "wrong-secret", "SessionStart"),
        session_start_body("claude-sid-a", &transcript),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "错 secret 必须 401");

    // 未登记会话(header 指向不存在的会话 id)。
    let status = call_hook(
        &state,
        loopback(),
        hook_headers("no-such-session", "whatever", "SessionStart"),
        session_start_body("claude-sid-a", &transcript),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "未登记会话必须 401");

    assert!(state.agents.get(&sid).is_none(), "401 路径不得建镜像 entry");
    assert!(
        state.mirrors.inner.lock().unwrap().is_empty(),
        "401 路径不得写 registry"
    );
}

/// SessionStart 缺 `transcript_path` / `session_id`(或 body 非 JSON)→ 400,不建镜像。
#[tokio::test]
async fn session_start_missing_fields_rejected_400() {
    let state = dummy_state();
    let (sid, secret) = setup_session(&state);

    // 缺 transcript_path。
    let body =
        Bytes::from(json!({"hook_event_name": "SessionStart", "session_id": "x"}).to_string());
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "SessionStart"),
        body,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "缺 transcript_path 应 400");

    // body 非 JSON(header 事件名 fallback 判为 SessionStart)。
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "SessionStart"),
        Bytes::from_static(b"not-json"),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "坏 JSON 的 SessionStart 应 400"
    );

    assert!(state.agents.get(&sid).is_none(), "400 路径不得建镜像 entry");
    assert!(
        state.mirrors.inner.lock().unwrap().is_empty(),
        "400 路径不得写 registry"
    );
}

/// 零 token 硬验收:各状态码路径响应 body 恒空(不含任何 hook 输出字段)。
#[tokio::test]
async fn all_responses_have_empty_body_zero_token() {
    let state = dummy_state();
    let (sid, secret) = setup_session(&state);
    let tmp = TempDir::new();
    let transcript = tmp.file("claude-a.jsonl");
    std::fs::write(&transcript, "").unwrap();

    // 403 / 401 / 400 / 200(SessionStart)/ 200(未知事件)逐一断言空 body。
    let cases: Vec<(SocketAddr, HeaderMap, Bytes, StatusCode)> = vec![
        (
            lan_peer(),
            hook_headers(&sid, &secret, "SessionStart"),
            session_start_body("c1", &transcript),
            StatusCode::FORBIDDEN,
        ),
        (
            loopback(),
            hook_headers(&sid, "bad", "SessionStart"),
            session_start_body("c1", &transcript),
            StatusCode::UNAUTHORIZED,
        ),
        (
            loopback(),
            hook_headers(&sid, &secret, "SessionStart"),
            Bytes::from_static(b"{}"),
            StatusCode::BAD_REQUEST,
        ),
        (
            loopback(),
            hook_headers(&sid, &secret, "SessionStart"),
            session_start_body("c1", &transcript),
            StatusCode::OK,
        ),
        (
            loopback(),
            hook_headers(&sid, &secret, "SomeFutureEvent"),
            event_body("SomeFutureEvent"),
            StatusCode::OK,
        ),
    ];
    for (peer, headers, body, expected) in cases {
        let resp = agent_hook(
            Extension(state.clone()),
            Extension(if peer.ip().is_loopback() {
                crate::server::auth::TrustedIngress::DirectLoopback
            } else {
                crate::server::auth::TrustedIngress::DirectRemote
            }),
            headers,
            body,
        )
        .await
        .into_response();
        assert_eq!(resp.status(), expected);
        let body = response_body(resp).await;
        assert!(
            body.is_empty(),
            "零 token 硬验收:{} 响应 body 必须为空,实际 {:?}",
            expected,
            String::from_utf8_lossy(&body)
        );
    }
}

// ── 决策 1:SessionStart 升格 / 换 tailer / 幂等 ──

/// 首次 SessionStart:agents 表出现 kind==Mirror 的 entry、registry 有 MirrorState;
/// 端到端:真实临时 transcript 的 fixture 行经 hook→tailer→fan-out 到达已 attach 的 client(0x50)。
#[tokio::test]
async fn first_session_start_registers_mirror_and_streams_transcript() {
    let line = format!(
        "{}\n",
        assistant_line("u1", "msg_01", "tool_use", "你好,镜像")
    );
    let (state, sid, _secret, _transcript, _tmp) = mirrored_session(&line).await;

    // agents 表:Mirror entry。
    let entry = state
        .agents
        .get(&sid)
        .expect("SessionStart 后 agents 表应有 entry");
    assert_eq!(entry.kind(), AgentKind::Mirror, "entry 应为 Mirror 类型");

    // registry:MirrorState 已登记且身份正确。
    {
        let map = state.mirrors.inner.lock().unwrap();
        let st = map.get(&sid).expect("registry 应有 MirrorState");
        assert_eq!(st.claude_session_id, "claude-sid-a");
        assert!(!st.tailer_cancel.is_cancelled(), "tailer 不应被取消");
    }

    // attach client → transcript fixture 行的事件帧应到达(hook→tailer→fan-out 全链路)。
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry.attach(&client).await;

    let frame = wait_for_agent_frame(&mut priority_rx, "你好,镜像").await;
    let payload: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(payload["type"], "assistant_delta");
}

/// SessionStart 重复(同 claude_sid + 同 transcript_path,compact 等同会话重入):
/// 不新建 entry(同一个 Arc)、tailer 未被取消(只 poke)。
#[tokio::test]
async fn repeated_session_start_same_identity_is_idempotent() {
    let (state, sid, secret, transcript, _tmp) = mirrored_session("").await;
    let entry1 = state.agents.get(&sid).unwrap();
    let cancel1 = {
        let map = state.mirrors.inner.lock().unwrap();
        map.get(&sid).unwrap().tailer_cancel.clone()
    };

    // 同身份再来一次 SessionStart。
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "SessionStart"),
        session_start_body("claude-sid-a", &transcript),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let entry2 = state.agents.get(&sid).unwrap();
    assert!(
        Arc::ptr_eq(&entry1, &entry2),
        "同身份重入不得新建 entry(应为同一个 Arc)"
    );
    assert!(
        !cancel1.is_cancelled(),
        "同身份重入不得取消 tailer(只 poke_catch_up)"
    );
    let map = state.mirrors.inner.lock().unwrap();
    assert_eq!(map.len(), 1, "registry 仍只有一个 MirrorState");
}

/// SessionStart 换 claude 会话(同 PTY 重跑 / 嵌套 / resume):旧 tailer 取消、entry 不换
/// (Arc::ptr_eq)、新 transcript 的事件仍能到达已 attach 的 client(换 tailer 不断流)。
#[tokio::test]
async fn session_start_with_new_claude_session_swaps_tailer_not_entry() {
    let line1 = format!(
        "{}\n",
        assistant_line("u1", "msg_01", "tool_use", "第一会话")
    );
    let (state, sid, secret, _t1, _tmp1) = mirrored_session(&line1).await;
    let entry1 = state.agents.get(&sid).unwrap();

    // attach client,先收到第一会话内容(确认在流)。
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry1.attach(&client).await;
    wait_for_agent_frame(&mut priority_rx, "第一会话").await;

    let old_cancel = {
        let map = state.mirrors.inner.lock().unwrap();
        map.get(&sid).unwrap().tailer_cancel.clone()
    };

    // claude 换会话:新 claude_sid + 新 transcript 文件。
    let tmp2 = TempDir::new();
    let t2 = tmp2.file("claude-b.jsonl");
    std::fs::write(
        &t2,
        format!(
            "{}\n",
            assistant_line("u2", "msg_02", "tool_use", "第二会话")
        ),
    )
    .unwrap();
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "SessionStart"),
        session_start_body("claude-sid-b", &t2),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // 旧 tailer 已取消;entry 仍是同一个(不重 register,绕开覆盖+泄漏坑)。
    assert!(old_cancel.is_cancelled(), "换会话必须取消旧 tailer");
    let entry2 = state.agents.get(&sid).unwrap();
    assert!(
        Arc::ptr_eq(&entry1, &entry2),
        "换会话不得换 entry(同一个 Arc)"
    );
    {
        let map = state.mirrors.inner.lock().unwrap();
        let st = map.get(&sid).unwrap();
        assert_eq!(
            st.claude_session_id, "claude-sid-b",
            "registry 应更新为新 claude 会话"
        );
        assert!(!st.tailer_cancel.is_cancelled(), "新 tailer 不应被取消");
    }

    // 新 transcript 的事件仍到达同一个已 attach client——换 tailer 不断流。
    wait_for_agent_frame(&mut priority_rx, "第二会话").await;
}

/// 事件名真相来源 = body 的 `hook_event_name`;body 缺失时回退 header。
/// 用 SessionStart 的可观察副作用(建镜像)验证 header fallback 生效。
#[tokio::test]
async fn event_name_falls_back_to_header_when_body_lacks_it() {
    let state = dummy_state();
    let (sid, secret) = setup_session(&state);
    let tmp = TempDir::new();
    let transcript = tmp.file("claude-a.jsonl");
    std::fs::write(&transcript, "").unwrap();

    // body 无 hook_event_name,header 判为 SessionStart。
    let body = Bytes::from(
        json!({"session_id": "claude-sid-a", "transcript_path": transcript.to_string_lossy()})
            .to_string(),
    );
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "SessionStart"),
        body,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        state.agents.get(&sid).is_some(),
        "header fallback 的 SessionStart 应建镜像"
    );
}

// ── 懒清扫(死会话 registry 残条目)──

/// registry 里指向不存在会话的残条目,在下一次 SessionStart 时被清除且其 cancel 已 fire。
#[tokio::test]
async fn dead_session_entry_swept_on_next_session_start() {
    let state = dummy_state();

    // 手工塞一个指向不存在会话的条目(模拟 reap 后的残留)。
    let ghost_cancel = {
        let (tx, _rx) = mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let tailer = spawn_transcript_tailer(
            std::path::PathBuf::from("/nonexistent/ghost.jsonl"),
            tx.clone(),
            cancel.clone(),
        );
        state.mirrors.inner.lock().unwrap().insert(
            "ghost-sid".to_string(),
            MirrorState {
                claude_session_id: "ghost-claude".to_string(),
                transcript_path: std::path::PathBuf::from("/nonexistent/ghost.jsonl"),
                tailer,
                tailer_cancel: cancel.clone(),
                event_tx: tx,
                upgraded_at: std::time::Instant::now(),
                last_effort: None,
            },
        );
        cancel
    };

    // 一次正常 SessionStart(活会话)触发懒清扫。
    let (sid, secret) = setup_session(&state);
    let tmp = TempDir::new();
    let transcript = tmp.file("claude-a.jsonl");
    std::fs::write(&transcript, "").unwrap();
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "SessionStart"),
        session_start_body("claude-sid-a", &transcript),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let map = state.mirrors.inner.lock().unwrap();
    assert!(!map.contains_key("ghost-sid"), "死会话残条目应被懒清扫移除");
    assert!(map.contains_key(&sid), "活会话的新条目应保留");
    assert!(
        ghost_cancel.is_cancelled(),
        "被清扫条目的 tailer cancel 应已 fire(防御性)"
    );
}

// ── 决策 2:hook 事件 → 动作映射 ──

/// Stop 触发轮兜底:喂「无 end_turn 的 assistant 行」开轮 → Stop hook →
/// 已 attach 的 client 收到 `TurnComplete{stop_reason:None}`(`{"type":"turn_complete"}`)。
#[tokio::test]
async fn stop_hook_triggers_turn_end_fallback() {
    // stop_reason=tool_use → 不产生 turn_end,轮保持开着。
    let line = format!("{}\n", assistant_line("u1", "msg_01", "tool_use", "干活中"));
    let (state, sid, secret, _transcript, _tmp) = mirrored_session(&line).await;

    let entry = state.agents.get(&sid).unwrap();
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry.attach(&client).await;
    // 先等 assistant 内容到达(确保 tailer 已读入、轮已开)。
    wait_for_agent_frame(&mut priority_rx, "干活中").await;

    // Stop hook → poke_turn_end → 兜底 TurnComplete{None}。
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "Stop"),
        event_body("Stop"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let frame = wait_for_agent_frame(&mut priority_rx, "turn_complete").await;
    let payload: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(payload["type"], "turn_complete");
    assert!(
        payload.get("stopReason").is_none(),
        "兜底 TurnComplete 的 stop_reason 应为 None(字段省略)"
    );
}

/// Notification / 未知事件:200 且不动镜像状态(registry / agents / tailer / 身份)。
/// 修 #2 后 Notification 在镜像态会发 notify 下行(见 hook_exit_tests 的感知桥测试),
/// 但仍**只读转发**——本测锁定它绝不碰镜像编排状态;未知事件则完全无副作用。
/// 会话无镜像状态时的非 SessionStart 事件(Stop 等):同样 200、不 panic。
#[tokio::test]
async fn notification_unknown_and_unmirrored_events_are_noops() {
    let state = dummy_state();
    let (sid, secret) = setup_session(&state);

    // 无镜像状态时的 Stop / Notification / 未知事件:全部 200,无副作用。
    for ev in ["Stop", "Notification", "SomeFutureEvent"] {
        let status = call_hook(
            &state,
            loopback(),
            hook_headers(&sid, &secret, ev),
            event_body(ev),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{} 应 200(fire-and-forget)", ev);
    }
    assert!(
        state.agents.get(&sid).is_none(),
        "非 SessionStart 事件不得建镜像"
    );
    assert!(
        state.mirrors.inner.lock().unwrap().is_empty(),
        "非 SessionStart 事件不得写 registry"
    );

    // 有镜像状态后,Notification / 未知事件仍无副作用(身份不变、tailer 不动)。
    let tmp = TempDir::new();
    let transcript = tmp.file("claude-a.jsonl");
    std::fs::write(&transcript, "").unwrap();
    call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "SessionStart"),
        session_start_body("claude-sid-a", &transcript),
    )
    .await;
    let cancel = {
        let map = state.mirrors.inner.lock().unwrap();
        map.get(&sid).unwrap().tailer_cancel.clone()
    };
    for ev in ["Notification", "SomeFutureEvent"] {
        let status = call_hook(
            &state,
            loopback(),
            hook_headers(&sid, &secret, ev),
            event_body(ev),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
    assert!(!cancel.is_cancelled(), "Notification/未知事件不得动 tailer");
    assert_eq!(
        state
            .mirrors
            .inner
            .lock()
            .unwrap()
            .get(&sid)
            .unwrap()
            .claude_session_id,
        "claude-sid-a",
        "Notification/未知事件不得改镜像身份"
    );
}

/// 坏 JSON 的非 SessionStart 事件(身份已由 header 确认)容忍:200、不 panic。
#[tokio::test]
async fn malformed_body_tolerated_for_non_session_start_events() {
    let (state, sid, secret, _transcript, _tmp) = mirrored_session("").await;
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "Stop"),
        Bytes::from_static(b"not-json"),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "坏 JSON 的 Stop(header fallback)应容忍并 200"
    );
}

// ── 决策 4:/api/sessions 的 agent_mirror 字段 ──

/// 纯映射:None(无 entry)/ Some(Acp)(方案 B)→ false;Some(Mirror) → true。
/// (Acp entry 需真实子进程才能入表,故 Acp=false 在纯函数级锁定,与 handler 共用同一表达式。)
#[test]
fn agent_mirror_flag_maps_kind_correctly() {
    assert!(
        !agent_mirror_flag(None),
        "无 agents entry(普通会话)应为 false"
    );
    assert!(
        !agent_mirror_flag(Some(AgentKind::Acp)),
        "方案 B(Acp)会话应为 false"
    );
    assert!(
        agent_mirror_flag(Some(AgentKind::Mirror)),
        "镜像会话应为 true"
    );
}

/// list_sessions / get_session:镜像会话 agent_mirror==true,普通会话 ==false。
#[tokio::test]
async fn sessions_api_reports_agent_mirror_field() {
    let (state, mirror_sid, _secret, _transcript, _tmp) = mirrored_session("").await;
    // 再建一个普通会话(无镜像)。
    let plain_sid = state.session_manager.create().id.clone();

    // list_sessions。
    let resp = handlers::list_sessions(Extension(state.clone()), owner_principal(&state))
        .await
        .into_response();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = response_json(resp).await;
    let sessions = v["sessions"].as_array().unwrap();
    let find = |sid: &str| {
        sessions
            .iter()
            .find(|s| s["id"] == *sid)
            .unwrap_or_else(|| panic!("列表应含会话 {}", sid))
    };
    assert_eq!(
        find(&mirror_sid)["agent_mirror"],
        true,
        "镜像会话应 agent_mirror=true"
    );
    assert_eq!(
        find(&plain_sid)["agent_mirror"],
        false,
        "普通会话应 agent_mirror=false"
    );

    // get_session(两个会话各查一次)。
    let resp = handlers::get_session(
        Extension(state.clone()),
        owner_principal(&state),
        axum::extract::Path(mirror_sid.clone()),
    )
    .await
    .into_response();
    assert_eq!(response_json(resp).await["agent_mirror"], true);
    let resp = handlers::get_session(
        Extension(state.clone()),
        owner_principal(&state),
        axum::extract::Path(plain_sid.clone()),
    )
    .await
    .into_response();
    assert_eq!(response_json(resp).await["agent_mirror"], false);
}

// ── delete_session 清 registry ──

/// 竞态回归(FIX-2):handler 里 `session_manager.get` 返回 Some 之后、
/// `handle_session_start` 插表之前,并发 delete_session 可完整跑完(全 token 已 cancel、
/// 两表已清)。锁内零 await 复查 cancellation token 必须放弃插表——不留 stale MirrorState,
/// 也不建 agents 镜像 entry。
#[tokio::test]
async fn session_start_after_concurrent_delete_does_not_insert_stale_state() {
    let state = dummy_state();
    let (sid, _secret) = setup_session(&state);
    let tmp = TempDir::new();
    let transcript = tmp.file("claude-a.jsonl");
    std::fs::write(&transcript, "").unwrap();

    // 复现竞态右侧:先按 handler 流程拿到 session Arc(get 返回 Some)……
    let session = state.session_manager.get(&sid).unwrap();
    // ……随后并发 delete 完整跑完(manager.delete 先 cancel 全 token,再清两表)。
    state.session_manager.delete(&sid).unwrap();
    state.hook_secrets.remove(&sid);
    state.mirrors.remove_and_cancel(&sid);

    // 再拿手里的 stale Arc 走 handle_session_start——锁内复查应直接返回。
    state.mirrors.handle_session_start(
        &sid,
        "claude-sid-a",
        transcript.clone(),
        session,
        &state.agents,
        state.event_bus.clone(),
        &state.permission_bridge,
    );

    assert!(
        state.mirrors.inner.lock().unwrap().is_empty(),
        "已删会话的 SessionStart 不得插入 stale MirrorState"
    );
    assert!(
        state.agents.get(&sid).is_none(),
        "已删会话的 SessionStart 不得建 agents 镜像 entry"
    );
}

/// delete_session:registry 条目移除 + 其 tailer cancel 已 fire(会话 token 级联 + 防御性显式取消)。
#[tokio::test]
async fn delete_session_clears_mirror_registry() {
    let (state, sid, _secret, _transcript, _tmp) = mirrored_session("").await;
    let cancel = {
        let map = state.mirrors.inner.lock().unwrap();
        map.get(&sid).unwrap().tailer_cancel.clone()
    };

    let resp = handlers::delete_session(
        Extension(state.clone()),
        owner_principal(&state),
        axum::extract::Path(sid.clone()),
    )
    .await
    .into_response();
    assert_eq!(resp.status(), StatusCode::OK);

    assert!(
        state.mirrors.inner.lock().unwrap().get(&sid).is_none(),
        "delete_session 应清除 registry 条目"
    );
    assert!(
        cancel.is_cancelled(),
        "delete_session 后 tailer cancel 应已 fire"
    );
}

// ── Task D 退出/清理测试的共享助手(用例见 hook_cleanup_tests / hook_exit_tests)──

/// 轮询等待镜像 entry 自回收(cleanup 后 event_rx 关闭 → fan-out drain → finalize_mirror
/// remove_entry → `agents.get → None`,`agent_mirror` 随之回 false)。5s 超时。
pub(super) async fn wait_until_mirror_entry_gone(state: &Arc<ServerState>, sid: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while state.agents.get(sid).is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("镜像 entry 应自回收(agents.get → None)");
}

/// 取某会话 MirrorState 的 tailer_cancel clone(断言 cancel 已 fire 用)。
pub(super) fn tailer_cancel_of(state: &Arc<ServerState>, sid: &str) -> CancellationToken {
    state
        .mirrors
        .inner
        .lock()
        .unwrap()
        .get(sid)
        .expect("registry 应有 MirrorState")
        .tailer_cancel
        .clone()
}
