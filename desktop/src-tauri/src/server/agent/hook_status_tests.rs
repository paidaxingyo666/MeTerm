//! fix2/fix3 专项测试:agent 页状态条(AgentStatus 旁路信号)+ PreToolUse 实时工具卡。
//! 经 `#[path]` 挂为 `hook` 的子模块(`use super::*` 可访问 hook.rs 私有项),
//! 复用 `hook_tests` 的 `pub(super)` 测试助手——同 `hook_exit_tests` 的拆法。

use super::hook_tests::{
    attached_client, call_hook, hook_headers, loopback, mirrored_session, wait_for_agent_frame,
};
use super::*;
use std::time::Duration;

use serde_json::json;

use crate::server::session::client::WsReceivers;

/// 建镜像会话 + attach 一个 client,返回可观察 0x50 帧的接收端。
async fn mirrored_with_client() -> (
    Arc<ServerState>,
    String,
    String,
    mpsc::Receiver<Vec<u8>>,
    super::hook_tests::TempDir,
) {
    let (state, sid, secret, _t, tmp) = mirrored_session("").await;
    let entry = state.agents.get(&sid).unwrap();
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry.attach(&client).await;
    wait_for_agent_frame(&mut priority_rx, "mirror_started").await;
    (state, sid, secret, priority_rx, tmp)
}

/// 无 body 内容事件的 hook stdin JSON(只带事件名 + claude 会话身份)。
fn bare_body(event: &str) -> Bytes {
    Bytes::from(json!({ "hook_event_name": event, "session_id": "claude-sid-a" }).to_string())
}

// ── fix2:hook 事件流 → AgentStatus 状态条 ──

/// UserPromptSubmit → `{"type":"agent_status","state":"thinking"}`(无 detail 字段)。
#[tokio::test]
async fn user_prompt_submit_sends_thinking_status() {
    let (state, sid, secret, mut rx, _tmp) = mirrored_with_client().await;

    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "UserPromptSubmit"),
        bare_body("UserPromptSubmit"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let frame = wait_for_agent_frame(&mut rx, "agent_status").await;
    let payload: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(
        payload,
        json!({"type": "agent_status", "state": "thinking"}),
        "wire 契约不可漂移;detail 为 None 时字段整个省略"
    );
}

/// Stop → idle 状态(轮结束)。
#[tokio::test]
async fn stop_sends_idle_status() {
    let (state, sid, secret, mut rx, _tmp) = mirrored_with_client().await;

    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "Stop"),
        bare_body("Stop"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let frame = wait_for_agent_frame(&mut rx, "agent_status").await;
    let payload: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(payload, json!({"type": "agent_status", "state": "idle"}));
}

// ── fix3:PreToolUse 实时工具卡 + running_tool 状态 ──

/// PreToolUse(带 tool_use_id/tool_name/tool_input)→ **先** tool_call_start
/// (id=tool_use_id、title=tool_name、rawInput=tool_input 原样)**后** agent_status
/// running_tool(detail=工具名)。工具卡实时出现,不等轮末 transcript 落盘。
#[tokio::test]
async fn pre_tool_use_emits_realtime_tool_card_then_running_status() {
    let (state, sid, secret, mut rx, _tmp) = mirrored_with_client().await;

    let body = Bytes::from(
        json!({
            "hook_event_name": "PreToolUse",
            "session_id": "claude-sid-a",
            "tool_name": "Bash",
            "tool_input": {"command": "ls -la", "timeout": 5000},
            "tool_use_id": "toolu_realtime_01"
        })
        .to_string(),
    );
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "PreToolUse"),
        body,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // 帧序:tool_call_start 先于 agent_status(卡先出现,状态条随后)。
    let card = wait_for_agent_frame(&mut rx, "tool_call_start").await;
    let card_payload: serde_json::Value = serde_json::from_slice(&card[1..]).unwrap();
    assert_eq!(
        card_payload["id"], "toolu_realtime_01",
        "id 必须 = tool_use_id(与 transcript 同体系)"
    );
    assert_eq!(card_payload["title"], "Bash", "title 必须 = tool_name");
    assert_eq!(
        card_payload["rawInput"],
        json!({"command": "ls -la", "timeout": 5000}),
        "rawInput 必须原样透传 tool_input"
    );

    let st = wait_for_agent_frame(&mut rx, "agent_status").await;
    let st_payload: serde_json::Value = serde_json::from_slice(&st[1..]).unwrap();
    assert_eq!(
        st_payload,
        json!({"type": "agent_status", "state": "running_tool", "detail": "Bash"}),
        "running_tool 状态须带工具名 detail"
    );
}

/// 缺 tool_use_id(旧版 claude payload)→ 不合成工具卡(不发 tool_call_start),
/// 退化为只发 running_tool 状态;PostToolUse 回 thinking(工具完成,claude 处理结果)。
#[tokio::test]
async fn pre_tool_use_without_id_degrades_to_status_only() {
    let (state, sid, secret, mut rx, _tmp) = mirrored_with_client().await;

    let body = Bytes::from(
        json!({
            "hook_event_name": "PreToolUse",
            "session_id": "claude-sid-a",
            "tool_name": "Bash",
            "tool_input": {"command": "pwd"}
        })
        .to_string(),
    );
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "PreToolUse"),
        body,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // 首个到达的 0x50 帧就是 agent_status(没有 tool_call_start 插队)。
    let frame = wait_for_agent_frame(&mut rx, "agent_status").await;
    let payload: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(payload["state"], "running_tool");
    assert!(
        !String::from_utf8_lossy(&frame[1..]).contains("tool_call_start"),
        "缺 tool_use_id 不得合成工具卡"
    );

    // PostToolUse → thinking(处理工具结果)。
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "PostToolUse"),
        bare_body("PostToolUse"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let frame = wait_for_agent_frame(&mut rx, "thinking").await;
    let payload: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(
        payload,
        json!({"type": "agent_status", "state": "thinking"})
    );
}

// ── fix2(修 #5):Notification 分类——权限类 awaiting+notify;空闲类仅 idle ──

/// 权限类 Notification(message 含 "permission")→ **先** awaiting 状态 **后** notify
/// 醒目卡(状态条与 attention 卡都要)。
#[tokio::test]
async fn permission_notification_sends_awaiting_then_notify() {
    let (state, sid, secret, mut rx, _tmp) = mirrored_with_client().await;

    let body = Bytes::from(
        json!({
            "hook_event_name": "Notification",
            "session_id": "claude-sid-a",
            "message": "Claude needs your permission to use Bash"
        })
        .to_string(),
    );
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "Notification"),
        body,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let st = wait_for_agent_frame(&mut rx, "agent_status").await;
    let st_payload: serde_json::Value = serde_json::from_slice(&st[1..]).unwrap();
    assert_eq!(
        st_payload,
        json!({"type": "agent_status", "state": "awaiting"})
    );

    let notify = wait_for_agent_frame(&mut rx, "notify").await;
    let n_payload: serde_json::Value = serde_json::from_slice(&notify[1..]).unwrap();
    assert_eq!(
        n_payload["message"],
        "Claude needs your permission to use Bash"
    );
}

/// 空闲类 Notification("waiting for your input")→ 仅 idle 状态,**不发 notify**
/// (修 #5:任务完成后的空闲提醒不再误报成醒目卡)。
#[tokio::test]
async fn idle_notification_sends_idle_without_notify() {
    let (state, sid, secret, mut rx, _tmp) = mirrored_with_client().await;

    let body = Bytes::from(
        json!({
            "hook_event_name": "Notification",
            "session_id": "claude-sid-a",
            "message": "Claude is waiting for your input"
        })
        .to_string(),
    );
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "Notification"),
        body,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let frame = wait_for_agent_frame(&mut rx, "agent_status").await;
    let payload: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(payload, json!({"type": "agent_status", "state": "idle"}));

    // idle 帧之后不得跟 notify(等一拍再 drain 断言,抓异步 fan-out 的迟到帧)。
    tokio::time::sleep(Duration::from_millis(100)).await;
    while let Ok(f) = rx.try_recv() {
        assert!(
            !String::from_utf8_lossy(&f[1..]).contains("\"notify\""),
            "空闲类 Notification 不得发 notify 醒目卡"
        );
    }
}

// ── fix9:effort 即时显示(SessionStart / UserPromptSubmit 的 X-Meterm-Effort header)──

/// SessionStart 携带 X-Meterm-Effort header → 升格完成后立即下行
/// `agent_meta{effort}`(claude 一启动 statusline 就有思考等级,不等第一轮 prompt)。
#[tokio::test]
async fn session_start_with_effort_header_emits_meta() {
    let state = Arc::new(crate::server::create_dummy_state());
    let session = state.session_manager.create();
    let sid = session.id.clone();
    let secret = format!("test-secret-{}", sid);
    state.hook_secrets.register(sid.clone(), secret.clone());
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    let _ = client; // attach 在升格补挂时由桌面侧完成

    let tmp = super::hook_tests::TempDir::new();
    let transcript = tmp.file("claude-e.jsonl");
    std::fs::write(&transcript, "").unwrap();
    let mut headers = hook_headers(&sid, &secret, "SessionStart");
    headers.insert("x-meterm-effort", "xhigh".parse().unwrap());
    let status = call_hook(
        &state,
        loopback(),
        headers,
        super::hook_tests::session_start_body("claude-sid-e", &transcript),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // 升格补 attach 会给已连接 client 发 mirror_started,随后应收到 effort meta。
    wait_for_agent_frame(&mut priority_rx, "mirror_started").await;
    let frame = wait_for_agent_frame(&mut priority_rx, "agent_meta").await;
    let payload: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(
        payload,
        json!({"type": "agent_meta", "effort": "xhigh"}),
        "SessionStart 的 effort 须即时下行(仅 effort 字段)"
    );
}

/// UserPromptSubmit 携带 X-Meterm-Effort header → agent_meta{effort}(每轮回报)。
#[tokio::test]
async fn user_prompt_submit_with_effort_header_emits_meta() {
    let (state, sid, secret, mut rx, _tmp) = mirrored_with_client().await;
    let mut headers = hook_headers(&sid, &secret, "UserPromptSubmit");
    headers.insert("x-meterm-effort", "max".parse().unwrap());
    let status = call_hook(&state, loopback(), headers, bare_body("UserPromptSubmit")).await;
    assert_eq!(status, StatusCode::OK);

    let frame = wait_for_agent_frame(&mut rx, "agent_meta").await;
    let payload: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(payload, json!({"type": "agent_meta", "effort": "max"}));
}

// ── fix4:MessageDisplay → 轮内实时正文 ──

/// MessageDisplay(index=0)→ delta 原文直接下行 assistant_delta;index>0 的后续批
/// 前置 "\n"(行批之间补行分隔)。
#[tokio::test]
async fn message_display_streams_assistant_delta_realtime() {
    let (state, sid, secret, mut rx, _tmp) = mirrored_with_client().await;

    let batch = |index: u64, delta: &str| {
        Bytes::from(
            json!({
                "hook_event_name": "MessageDisplay",
                "session_id": "claude-sid-a",
                "turn_id": "turn-1",
                "message_id": "mm-1",
                "index": index,
                "final": false,
                "delta": delta
            })
            .to_string(),
        )
    };

    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "MessageDisplay"),
        batch(0, "## 标题"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let frame = wait_for_agent_frame(&mut rx, "assistant_delta").await;
    let payload: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(payload["text"], "## 标题", "首批 delta 原文透传,不加前缀");

    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "MessageDisplay"),
        batch(1, "- 第二批行"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let frame = wait_for_agent_frame(&mut rx, "assistant_delta").await;
    let payload: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(
        payload["text"], "\n- 第二批行",
        "后续批须前置换行(行批间分隔)"
    );
}

/// 空 delta / 非镜像会话:no-op 200,不发帧、不 panic。
#[tokio::test]
async fn message_display_empty_delta_and_unmirrored_are_noop() {
    let (state, sid, secret, mut rx, _tmp) = mirrored_with_client().await;
    let body = Bytes::from(
        json!({
            "hook_event_name": "MessageDisplay",
            "session_id": "claude-sid-a",
            "index": 0, "final": true, "delta": ""
        })
        .to_string(),
    );
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "MessageDisplay"),
        body,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(rx.try_recv().is_err(), "空 delta 不得下行任何帧");
}

/// 非镜像会话(从未升格)的内容 hook:AgentStatus 全程 no-op(不 panic、200)。
#[tokio::test]
async fn status_hooks_on_unmirrored_session_are_noop() {
    let state = Arc::new(crate::server::create_dummy_state());
    let session = state.session_manager.create();
    let sid = session.id.clone();
    let secret = format!("test-secret-{}", sid);
    state.hook_secrets.register(sid.clone(), secret.clone());

    for ev in ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"] {
        let status = call_hook(
            &state,
            loopback(),
            hook_headers(&sid, &secret, ev),
            bare_body(ev),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{} 在非镜像会话应 200 no-op", ev);
    }
    assert!(
        state.agents.get(&sid).is_none(),
        "非镜像会话不得因状态 hook 建 entry"
    );
}

// ── fix10:effort 统一回报(任何 hook 事件,值变才发)──

/// PostToolUse 携带**新值**的 X-Meterm-Effort → agent_meta{effort};同值重复事件
/// 不再发(diff 记账);/effort 切换后任一后续事件即刷新,不等下一条真 prompt。
#[tokio::test]
async fn effort_reported_on_any_event_and_deduped() {
    let (state, sid, secret, mut rx, _tmp) = mirrored_with_client().await;

    // 第一次:PostToolUse 带 effort=high → 首见,下发。
    let mut h = hook_headers(&sid, &secret, "PostToolUse");
    h.insert("x-meterm-effort", "high".parse().unwrap());
    let status = call_hook(&state, loopback(), h, bare_body("PostToolUse")).await;
    assert_eq!(status, StatusCode::OK);
    let frame = wait_for_agent_frame(&mut rx, "agent_meta").await;
    let payload: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(payload, json!({"type": "agent_meta", "effort": "high"}));

    // 第二次:同值 Stop → 不重发(下一个 0x50 帧应是 agent_status,不是 meta)。
    let mut h = hook_headers(&sid, &secret, "Stop");
    h.insert("x-meterm-effort", "high".parse().unwrap());
    let status = call_hook(&state, loopback(), h, bare_body("Stop")).await;
    assert_eq!(status, StatusCode::OK);
    let frame = wait_for_agent_frame(&mut rx, "agent_status").await;
    assert!(
        !String::from_utf8_lossy(&frame[1..]).contains("agent_meta"),
        "同值 effort 不得重发 meta"
    );

    // 第三次:/effort 切换后(值变 xhigh)的 Notification → 立即刷新。
    let mut h = hook_headers(&sid, &secret, "Notification");
    h.insert("x-meterm-effort", "xhigh".parse().unwrap());
    let body = Bytes::from(
        json!({"hook_event_name": "Notification", "session_id": "claude-sid-a",
               "message": "Claude is waiting for your input"})
        .to_string(),
    );
    let status = call_hook(&state, loopback(), h, body).await;
    assert_eq!(status, StatusCode::OK);
    let frame = wait_for_agent_frame(&mut rx, "agent_meta").await;
    let payload: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(
        payload,
        json!({"type": "agent_meta", "effort": "xhigh"}),
        "值变后任一事件须立即刷新 effort"
    );
}
