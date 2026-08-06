//! P2 审批桥专项测试:PermissionRequest hook 同步阻塞桥到手机。
//! 经 `#[path]` 挂为 `hook` 的子模块(`use super::*` 可访问 hook.rs 私有项),
//! 复用 `hook_tests` 的 `pub(super)` 测试助手——同 `hook_exit_tests` 的拆法。

use super::hook_tests::{
    attached_client, call_hook_response, hook_headers, loopback, mirrored_session, response_body,
    response_json, wait_for_agent_frame,
};
use super::*;

use serde_json::json;

use crate::server::session::client::WsReceivers;

/// PermissionRequest 的 hook stdin JSON(字段形状实证自 claude 2.1.206:
/// `tool_name` + `tool_input`,无 tool_use_id)。
fn permission_body(tool_name: &str, tool_input: Value) -> Bytes {
    Bytes::from(
        json!({
            "hook_event_name": "PermissionRequest",
            "session_id": "claude-sid-a",
            "tool_name": tool_name,
            "tool_input": tool_input
        })
        .to_string(),
    )
}

/// 主链路(allow):hook 到达 → attached client 收到审批卡(permission_request 帧,
/// 固定两选项 allow/deny、title 带命令摘要)→ 手机决策 Allow 回投 → handler 返回
/// decision JSON(allow **零注入**:无 updatedInput/updatedPermissions/message)。
#[tokio::test]
async fn permission_request_bridges_to_phone_and_returns_allow() {
    let (state, sid, secret, _t, _tmp) = mirrored_session("").await;
    let entry = state.agents.get(&sid).unwrap();
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry.attach(&client).await;
    wait_for_agent_frame(&mut priority_rx, "mirror_started").await;

    // handler 会阻塞等决策:spawn 出去,主测试线程扮演手机。
    let handler = {
        let state = state.clone();
        let sid = sid.clone();
        let secret = secret.clone();
        tokio::spawn(async move {
            call_hook_response(
                &state,
                loopback(),
                hook_headers(&sid, &secret, "PermissionRequest"),
                permission_body("Bash", json!({"command": "rm -rf /tmp/x"})),
            )
            .await
        })
    };

    // 手机收到审批卡:title 带命令摘要,固定 allow/deny 两选项,requestId 为 mperm- uuid。
    let frame = wait_for_agent_frame(&mut priority_rx, "permission_request").await;
    let card: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(
        card["title"], "Bash: rm -rf /tmp/x",
        "title 须为 工具名: 入参摘要"
    );
    let rid = card["requestId"].as_str().expect("requestId 须为字符串");
    assert!(
        rid.starts_with("mperm-"),
        "requestId 须为桥自生成 uuid,得到 {}",
        rid
    );
    let options = card["options"].as_array().unwrap();
    assert_eq!(
        options.len(),
        1,
        "无 suggestions 时仅 allow 选项(拒绝是手机固定入口)"
    );
    assert_eq!(options[0]["optionId"], "allow");

    // 手机点「允许」(upstream 的 resolve 同源):handler 立即返回 allow decision。
    assert!(state.permission_bridge.resolve(rid, PermissionReply::Allow));
    let resp = handler.await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = response_json(resp).await;
    assert_eq!(
        v,
        json!({
            "hookSpecificOutput": {
                "hookEventName": "PermissionRequest",
                "decision": { "behavior": "allow" }
            }
        }),
        "allow 须零注入(无 updatedInput/updatedPermissions/message)"
    );
    assert!(
        !state.permission_bridge.has_pending(&sid),
        "决策后 pending 应清空"
    );
}

/// deny 链路:决策 Deny → decision.behavior=deny + 固定拒绝原因 message(零 token
/// 白名单:与终端里拒绝完全一致的几个 token,设计 §4.7 明确豁免)。
#[tokio::test]
async fn permission_request_returns_deny_with_fixed_message() {
    let (state, sid, secret, _t, _tmp) = mirrored_session("").await;
    let entry = state.agents.get(&sid).unwrap();
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry.attach(&client).await;
    wait_for_agent_frame(&mut priority_rx, "mirror_started").await;

    let handler = {
        let state = state.clone();
        let sid = sid.clone();
        let secret = secret.clone();
        tokio::spawn(async move {
            call_hook_response(
                &state,
                loopback(),
                hook_headers(&sid, &secret, "PermissionRequest"),
                permission_body("Write", json!({"file_path": "/etc/hosts"})),
            )
            .await
        })
    };

    let frame = wait_for_agent_frame(&mut priority_rx, "permission_request").await;
    let card: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(card["title"], "Write: /etc/hosts");
    let rid = card["requestId"].as_str().unwrap();

    assert!(state
        .permission_bridge
        .resolve(rid, PermissionReply::Deny(None)));
    let v = response_json(handler.await.unwrap()).await;
    assert_eq!(v["hookSpecificOutput"]["decision"]["behavior"], "deny");
    assert_eq!(
        v["hookSpecificOutput"]["decision"]["message"], "用户在 MeTerm 手机端拒绝了本次操作",
        "deny 须带固定拒绝原因(喂给 claude)"
    );
}

/// 非镜像会话(从未升格)的 PermissionRequest → **空 body** 200(不干预,claude 回落
/// TUI 弹窗),不登记 pending。
#[tokio::test]
async fn permission_request_on_unmirrored_session_is_empty_200() {
    let state = Arc::new(crate::server::create_dummy_state());
    let session = state.session_manager.create();
    let sid = session.id.clone();
    let secret = format!("test-secret-{}", sid);
    state.hook_secrets.register(sid.clone(), secret.clone());

    let resp = call_hook_response(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "PermissionRequest"),
        permission_body("Bash", json!({"command": "ls"})),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert!(
        response_body(resp).await.is_empty(),
        "非镜像会话须空响应(claude 视为不干预,回落 TUI)"
    );
    assert!(!state.permission_bridge.has_pending(&sid));
}

/// 超时路径(短超时注入):无人决策 → 撤登记 + 空 body 200(回落 TUI 弹窗);
/// 超时后手机迟到的决策 resolve 返回 false(upstream 据此回 approval_expired)。
#[tokio::test]
async fn permission_wait_timeout_falls_back_to_empty_200() {
    let bridge = PermissionBridge::new();
    let rx = bridge.register("pty-x", "mperm-t");

    let resp = await_permission_decision(
        &bridge,
        "mperm-t",
        rx,
        Duration::from_millis(50),
        None,
        None,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert!(
        response_body(resp).await.is_empty(),
        "超时须空响应(回落 TUI)"
    );
    assert!(!bridge.has_pending("pty-x"), "超时须撤登记");
    assert!(
        !bridge.resolve("mperm-t", PermissionReply::Allow),
        "超时后迟到的决策应 resolve 失败(approval_expired)"
    );
}

/// claude 退出(cleanup_mirror)drain 在飞审批:sender drop → 阻塞中的 handler 立即
/// 收 Err → 空响应(不用等 80s 超时)。
#[tokio::test]
async fn cleanup_mirror_drains_pending_and_unblocks_handler() {
    let (state, sid, secret, _t, _tmp) = mirrored_session("").await;
    let entry = state.agents.get(&sid).unwrap();
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry.attach(&client).await;
    wait_for_agent_frame(&mut priority_rx, "mirror_started").await;

    let handler = {
        let state = state.clone();
        let sid = sid.clone();
        let secret = secret.clone();
        tokio::spawn(async move {
            call_hook_response(
                &state,
                loopback(),
                hook_headers(&sid, &secret, "PermissionRequest"),
                permission_body("Bash", json!({"command": "ls"})),
            )
            .await
        })
    };
    wait_for_agent_frame(&mut priority_rx, "permission_request").await;
    assert!(state.permission_bridge.has_pending(&sid));

    // claude 退出:cleanup 链路应 drain 该会话 pending,阻塞中的 handler 立即解锁。
    cleanup_mirror(&state, &sid, "claude-sid-a");
    let resp = handler.await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert!(
        response_body(resp).await.is_empty(),
        "claude 退出后审批须空响应回落(实际 claude 已死,响应无害)"
    );
    assert!(
        !state.permission_bridge.has_pending(&sid),
        "drain 后无残留 pending"
    );
}

/// 修 #5 延伸:审批桥有在飞卡时,权限类 Notification **抑制** notify 醒目卡
/// (审批卡已在手机上,「去终端确认」指引重复且过时),但 awaiting 状态照发。
#[tokio::test]
async fn permission_notification_suppresses_notify_when_bridge_pending() {
    let (state, sid, secret, _t, _tmp) = mirrored_session("").await;
    let entry = state.agents.get(&sid).unwrap();
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry.attach(&client).await;
    wait_for_agent_frame(&mut priority_rx, "mirror_started").await;

    // 在飞审批(不 resolve,模拟等待手机决策期间)。
    let _rx = state.permission_bridge.register(&sid, "mperm-live");

    let body = Bytes::from(
        json!({
            "hook_event_name": "Notification",
            "session_id": "claude-sid-a",
            "message": "Claude needs your permission to use Bash"
        })
        .to_string(),
    );
    let resp = call_hook_response(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "Notification"),
        body,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);

    // awaiting 状态照发。
    let frame = wait_for_agent_frame(&mut priority_rx, "agent_status").await;
    let payload: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(payload["state"], "awaiting");

    // notify 被抑制(等一拍 drain 断言,抓异步 fan-out 迟到帧)。
    tokio::time::sleep(Duration::from_millis(100)).await;
    while let Ok(f) = priority_rx.try_recv() {
        assert!(
            !String::from_utf8_lossy(&f[1..]).contains("\"notify\""),
            "审批桥在飞时权限类 Notification 不得再发 notify 卡"
        );
    }
}

/// permission_title 纯函数:command/file_path 摘要、无入参回退裸工具名、超长 char 截断。
#[test]
fn permission_title_summarizes_and_truncates() {
    assert_eq!(
        permission_title("Bash", Some(&json!({"command": "ls -la"}))),
        "Bash: ls -la"
    );
    assert_eq!(
        permission_title("Read", Some(&json!({"file_path": "/tmp/a.txt"}))),
        "Read: /tmp/a.txt"
    );
    assert_eq!(
        permission_title("Task", Some(&json!({"prompt": 42}))),
        "Task"
    );
    assert_eq!(permission_title("Task", None), "Task");
    // 超长入参:char 边界截断 + 省略号(中文 3 字节/char,不得截半)。
    let long = "很".repeat(200);
    let t = permission_title("Bash", Some(&json!({ "command": long })));
    assert!(t.starts_with("Bash: "), "前缀不变");
    assert!(t.ends_with('…'), "截断须带省略号");
    assert!(t.chars().count() < 200, "须被截断");
}

/// fix11 端到端:AskUserQuestion → 手机收到 ask_question 帧(questions 原样透传)→
/// 手机回 AllowWithAnswers → handler 返回 behavior=allow + updatedInput
/// (原 tool_input 全量字段 + answers,masko-code 同款 wire)。
#[tokio::test]
async fn ask_user_question_bridges_answers_via_updated_input() {
    let (state, sid, secret, _t, _tmp) = mirrored_session("").await;
    let entry = state.agents.get(&sid).unwrap();
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry.attach(&client).await;
    wait_for_agent_frame(&mut priority_rx, "mirror_started").await;

    let tool_input = json!({
        "questions": [{
            "question": "选哪个?",
            "header": "选择",
            "multiSelect": false,
            "options": [{"label": "甲"}, {"label": "乙"}]
        }]
    });
    let handler = {
        let state = state.clone();
        let sid = sid.clone();
        let secret = secret.clone();
        let body = permission_body("AskUserQuestion", tool_input.clone());
        tokio::spawn(async move {
            call_hook_response(
                &state,
                loopback(),
                hook_headers(&sid, &secret, "PermissionRequest"),
                body,
            )
            .await
        })
    };

    // 手机收到 ask_question 帧(不是 permission_request):questions 原样透传。
    let frame = wait_for_agent_frame(&mut priority_rx, "ask_question").await;
    let card: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(card["type"], "ask_question");
    assert_eq!(
        card["questions"], tool_input["questions"],
        "questions 须原样透传"
    );
    let rid = card["requestId"].as_str().expect("requestId 须为字符串");

    // 手机回答(upstream answer 同源):AllowWithAnswers。
    let mut answers = std::collections::HashMap::new();
    answers.insert("选哪个?".to_string(), "甲".to_string());
    assert!(state
        .permission_bridge
        .resolve(rid, PermissionReply::AllowWithAnswers(answers)));

    let v = response_json(handler.await.unwrap()).await;
    let decision = &v["hookSpecificOutput"]["decision"];
    assert_eq!(decision["behavior"], "allow");
    assert_eq!(
        decision["updatedInput"]["questions"], tool_input["questions"],
        "updatedInput 须保留原 tool_input 全量字段"
    );
    assert_eq!(
        decision["updatedInput"]["answers"],
        json!({"选哪个?": "甲"}),
        "answers 须以 question 原文为 key 注入"
    );
}

/// fix12:hook 携带 permission_suggestions → 选项含「总是允许」(allow_always);
/// 手机选它 → decision = allow + updatedPermissions(suggestions 原样,与终端选
/// "Yes, don't ask again…" 完全一致)。
#[tokio::test]
async fn permission_suggestions_yield_allow_always_option_and_updated_permissions() {
    let (state, sid, secret, _t, _tmp) = mirrored_session("").await;
    let entry = state.agents.get(&sid).unwrap();
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry.attach(&client).await;
    wait_for_agent_frame(&mut priority_rx, "mirror_started").await;

    let suggestions = json!([{
        "type": "addRules",
        "rules": [{"toolName": "Bash", "ruleContent": "npm test:*"}],
        "behavior": "allow",
        "destination": "session"
    }]);
    let body = Bytes::from(
        json!({
            "hook_event_name": "PermissionRequest",
            "session_id": "claude-sid-a",
            "tool_name": "Bash",
            "tool_input": {"command": "npm test"},
            "permission_suggestions": suggestions
        })
        .to_string(),
    );
    let handler = {
        let state = state.clone();
        let sid = sid.clone();
        let secret = secret.clone();
        tokio::spawn(async move {
            call_hook_response(
                &state,
                loopback(),
                hook_headers(&sid, &secret, "PermissionRequest"),
                body,
            )
            .await
        })
    };

    let frame = wait_for_agent_frame(&mut priority_rx, "permission_request").await;
    let card: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    let options = card["options"].as_array().unwrap();
    assert_eq!(
        options.len(),
        2,
        "有 suggestions 时 allow + allow_always 两选项"
    );
    assert_eq!(options[1]["optionId"], "allow_always");
    assert_eq!(options[1]["kind"], "allow_always");
    assert_eq!(
        options[1]["name"], "总是允许此类 Bash 操作",
        "addRules 建议须生成带工具名的文案"
    );
    let rid = card["requestId"].as_str().unwrap();

    assert!(state
        .permission_bridge
        .resolve(rid, PermissionReply::AllowAlways));
    let v = response_json(handler.await.unwrap()).await;
    let decision = &v["hookSpecificOutput"]["decision"];
    assert_eq!(decision["behavior"], "allow");
    assert_eq!(
        decision["updatedPermissions"], suggestions,
        "updatedPermissions 须为 suggestions 原样(与终端选第二项一致)"
    );
}

/// fix12:deny 携带用户反馈(对齐终端 "No, and tell Claude what to do differently")
/// → message = 用户文本;无反馈 → 固定默认文案。allow_always_label 兜底形态。
#[tokio::test]
async fn deny_with_feedback_and_label_fallbacks() {
    // deny 反馈直接测 decision 构造(bridge 层语义已有端到端覆盖)。
    let resp = permission_decision_response(
        PermissionReply::Deny(Some("改用 uv 别用 pip".into())),
        None,
        None,
    );
    let v: serde_json::Value =
        serde_json::from_slice(&super::hook_tests::response_body(resp).await).unwrap();
    assert_eq!(
        v["hookSpecificOutput"]["decision"]["message"],
        "改用 uv 别用 pip"
    );

    // setMode/acceptEdits 建议 → 会话级编辑文案;未知形态 → 通用兜底。
    assert_eq!(
        allow_always_label(&json!([{"type": "setMode", "mode": "acceptEdits"}])),
        "允许本会话所有编辑"
    );
    assert_eq!(
        allow_always_label(&json!([{"type": "unknown-future"}])),
        "总是允许,不再询问"
    );
    // AllowAlways 但无 suggestions(防御)→ 纯 allow,不带 updatedPermissions。
    let resp = permission_decision_response(PermissionReply::AllowAlways, None, None);
    let v: serde_json::Value =
        serde_json::from_slice(&super::hook_tests::response_body(resp).await).unwrap();
    assert_eq!(
        v["hookSpecificOutput"]["decision"],
        json!({"behavior": "allow"})
    );
}
