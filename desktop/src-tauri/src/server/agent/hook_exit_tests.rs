//! Task D Fix 轮的退出检测专项测试(FIX-1/2/4/5/6),经 `#[path]` 挂为 `hook` 的子模块
//! (`use super::*` 可访问 hook.rs 私有项)。与 `hook_tests`(逼近 1000 行上限)拆开,
//! 复用其 `pub(super)` 测试助手——同 `mirror_tests` 的拆法。

use super::hook_tests::{
    assistant_line, attached_client, call_hook, hook_headers, loopback, mirrored_session,
    session_end_body, session_start_body, tailer_cancel_of, wait_for_agent_frame,
    wait_until_mirror_entry_gone, TempDir,
};
use super::*;
use std::time::Duration;

use serde_json::json;

use crate::server::create_dummy_state;
use crate::server::protocol;
use crate::server::session::client::WsReceivers;

// ── FIX-1(Critical):SessionEnd 身份比对,陈旧信号不误清 ──

/// FIX-1:/clear 竞态——claude 同发 SessionEnd(旧 claude_sid)+ SessionStart(新 sid),
/// async 的 SessionEnd 经转发脚本可滞后数秒。SessionStart 先处理(换会话,entry 保留)后,
/// 携带旧 sid 的 SessionEnd 是**陈旧信号**,不得误清换会话后的活镜像(误清 = 发 MirrorEnded
/// + cancel 新 tailer,镜像死到下次 claude 启动)。匹配 sid 的 SessionEnd 则正常清(对照)。
#[tokio::test]
async fn stale_session_end_with_old_sid_spares_switched_mirror() {
    let (state, sid, secret, _t1, _tmp1) = mirrored_session("").await;

    // 换会话:新 claude_sid + 新 transcript(SessionStart 先到、已处理)。
    let tmp2 = TempDir::new();
    let t2 = tmp2.file("claude-b.jsonl");
    std::fs::write(&t2, "").unwrap();
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "SessionStart"),
        session_start_body("claude-sid-b", &t2),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let new_cancel = tailer_cancel_of(&state, &sid);

    // 滞后到达的旧会话 SessionEnd(body 带旧 claude sid)→ 必须 no-op。
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "SessionEnd"),
        session_end_body("claude-sid-a"),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "陈旧 SessionEnd 应 200(fire-and-forget)"
    );

    {
        let map = state.mirrors.inner.lock().unwrap();
        let st = map
            .get(&sid)
            .expect("陈旧 SessionEnd 不得清活镜像的 registry 条目");
        assert_eq!(
            st.claude_session_id, "claude-sid-b",
            "registry 应保持新身份"
        );
    }
    assert!(
        !new_cancel.is_cancelled(),
        "陈旧 SessionEnd 不得 cancel 新 tailer"
    );
    assert!(
        state.agents.get(&sid).is_some(),
        "陈旧 SessionEnd 不得回收镜像 entry"
    );
    let session = state.session_manager.get(&sid).unwrap();
    assert!(
        session.on_shell_prompt.lock().unwrap().is_some(),
        "陈旧 SessionEnd 不得清 7768 兜底回调槽"
    );

    // 对照:匹配新身份的 SessionEnd 正常清理全套。
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "SessionEnd"),
        session_end_body("claude-sid-b"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        new_cancel.is_cancelled(),
        "匹配 sid 的 SessionEnd 应 cancel tailer"
    );
    assert!(
        state.mirrors.inner.lock().unwrap().get(&sid).is_none(),
        "匹配 sid 的 SessionEnd 应清除 registry 条目"
    );
    wait_until_mirror_entry_gone(&state, &sid).await;
}

/// FIX-1:SessionEnd 缺 `session_id` → 身份不可证,保守 no-op(不赌「大概率是当前会话」;
/// 真硬退出由 7768 兜底负责,不会漏清)。
#[tokio::test]
async fn session_end_without_session_id_is_noop() {
    let (state, sid, secret, _t, _tmp) = mirrored_session("").await;
    let cancel = tailer_cancel_of(&state, &sid);

    let body = Bytes::from(json!({ "hook_event_name": "SessionEnd" }).to_string());
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "SessionEnd"),
        body,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    assert!(
        state.mirrors.inner.lock().unwrap().get(&sid).is_some(),
        "缺身份的 SessionEnd 不得清镜像"
    );
    assert!(
        !cancel.is_cancelled(),
        "缺身份的 SessionEnd 不得 cancel tailer"
    );
}

// ── FIX-4 + FIX-6:7768 exit code 判挂起/退出,经真实接线(dispatch_shell_prompt)──

/// 构造一条 7768 ShellState 事件(exit code 可指定,其余字段形状照 precmd 实发)。
fn shell_state(exit: i32) -> crate::server::osc_filter::OscEvent {
    crate::server::osc_filter::OscEvent::ShellState {
        exit,
        cwd: "/tmp/proj".into(),
        cmd: "claude".into(),
        duration_ms: Some(1234),
    }
}

/// 把 upgraded_at 拨老(60s 前),越过 PROMPT_GUARD 存续守卫,只测 exit code 判据。
fn age_out_guard(state: &Arc<ServerState>, sid: &str) {
    let mut map = state.mirrors.inner.lock().unwrap();
    map.get_mut(sid).unwrap().upgraded_at = std::time::Instant::now() - Duration::from_secs(60);
}

/// FIX-4:Ctrl+Z 挂起(SIGTSTP)/ SIGSTOP 也会让顶层 shell 回 prompt,但 claude 并未退出
/// (fg 可恢复)——precmd 的 `$?` 为 128+信号值:SIGSTOP macOS=145 / SIGTSTP macOS=146 /
/// SIGSTOP Linux=147 / SIGTSTP Linux=148,四个码一律不得清镜像(否则 fg 恢复后镜像已死,
/// 无 SessionStart 重建)。经 run loop 真实接线 dispatch_shell_prompt 驱动(FIX-6:同时
/// 锁定「ShellState → 携带 exit code 调回调」的通路,杀掉整块删除接线的变异)。
#[tokio::test]
async fn suspend_exit_codes_do_not_cleanup_mirror() {
    let (state, sid, _secret, _t, _tmp) = mirrored_session("").await;
    let session = state.session_manager.get(&sid).unwrap();

    for code in [145, 146, 147, 148] {
        age_out_guard(&state, &sid);
        session.dispatch_shell_prompt(&[shell_state(code)]);
        assert!(
            state.mirrors.inner.lock().unwrap().get(&sid).is_some(),
            "挂起码 {code}(128+SIGSTOP/SIGTSTP)不得清镜像"
        );
        assert!(
            session.on_shell_prompt.lock().unwrap().is_some(),
            "挂起码 {code} 不得清回调槽"
        );
    }
}

/// FIX-4 + FIX-6:正常退出码(0)经真实接线越过守卫后正常清理(fg 后 claude 真退出的路径);
/// 非 ShellState 事件不触发回调(接线只认 7768)。
#[tokio::test]
async fn normal_exit_code_cleans_up_via_dispatch() {
    let (state, sid, _secret, _t, _tmp) = mirrored_session("").await;
    let session = state.session_manager.get(&sid).unwrap();

    // 非 ShellState 事件(OSC 7 cwd)不触发回调——镜像不动。
    age_out_guard(&state, &sid);
    session
        .dispatch_shell_prompt(&[crate::server::osc_filter::OscEvent::Cwd { cwd: "/tmp".into() }]);
    assert!(
        state.mirrors.inner.lock().unwrap().get(&sid).is_some(),
        "非 ShellState 事件不得触发清理"
    );

    // exit=0(正常退出)→ 清理生效,槽置 None,entry 自回收。
    session.dispatch_shell_prompt(&[shell_state(0)]);
    assert!(
        state.mirrors.inner.lock().unwrap().get(&sid).is_none(),
        "exit=0 越过守卫后应清镜像(claude 正常退出)"
    );
    assert!(
        session.on_shell_prompt.lock().unwrap().is_none(),
        "清理后回调槽应置 None"
    );
    wait_until_mirror_entry_gone(&state, &sid).await;
}

/// FIX-4:信号退出码 137(128+SIGKILL,硬退出)不属挂起码,应正常清理——
/// 这正是 7768 兜底要接住的场景(SessionEnd hook 发不出来)。
#[tokio::test]
async fn sigkill_exit_code_cleans_up_via_dispatch() {
    let (state, sid, _secret, _t, _tmp) = mirrored_session("").await;
    let session = state.session_manager.get(&sid).unwrap();

    age_out_guard(&state, &sid);
    session.dispatch_shell_prompt(&[shell_state(137)]);
    assert!(
        state.mirrors.inner.lock().unwrap().get(&sid).is_none(),
        "exit=137(SIGKILL)应清镜像(硬退出兜底)"
    );
    wait_until_mirror_entry_gone(&state, &sid).await;
}

// ── MirrorStarted(镜像已开始下行信号):首次升格/换会话发,同 sid 重入不发 ──

/// 等待 priority 通道的**下一条** 0x50 帧(不跳帧,顺序断言用;5s 超时)。
async fn next_agent_frame(rx: &mut mpsc::Receiver<Vec<u8>>) -> Vec<u8> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let frame = rx.recv().await.expect("通道关闭,镜像事件帧未到达");
            if frame[0] == protocol::MSG_AGENT_EVENT {
                return frame;
            }
        }
    })
    .await
    .expect("等待下一条 0x50 帧超时")
}

/// 首次升格:attached 客户端收到的**第一条** 0x50 帧必须是 mirror_started(冻结契约
/// `{"type":"mirror_started"}`),且先于任何内容事件——覆盖真机 bug:claude 刚起、用户
/// 还没输 prompt → transcript 空 → tailer 零发射,手机 welcome→mirror 翻转无事件可驱动。
/// 本例故意用**非空** transcript(resume 场景):mirror_started 仍必须排在内容之前
/// (发射点在 tailer spawn 之前入队,FIFO 结构性保证)。
#[tokio::test]
async fn first_session_start_emits_mirror_started_before_content() {
    let line = format!(
        "{}\n",
        assistant_line("u1", "msg_01", "tool_use", "已有内容")
    );
    let (state, sid, _secret, _t, _tmp) = mirrored_session(&line).await;
    let entry = state.agents.get(&sid).unwrap();
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry.attach(&client).await;

    // 首帧即 mirror_started(经 history 回放到达——晚 attach 也能收到,闭环进会话初判)。
    let first = next_agent_frame(&mut priority_rx).await;
    let payload: serde_json::Value = serde_json::from_slice(&first[1..]).unwrap();
    assert_eq!(
        payload,
        json!({"type": "mirror_started"}),
        "首条 0x50 帧必须是 mirror_started(在任何内容事件之前,wire 契约不可漂移)"
    );
    // 内容事件随后照常到达(mirror_started 不挤掉正常流)。
    wait_for_agent_frame(&mut priority_rx, "已有内容").await;
}

/// 换会话(新 claude_sid 换 tailer):再发一次 mirror_started——手机若已被 mirror_ended
/// 或宽限自愈落回 welcome,可被拉回 mirror;若仍在 mirror 则 no-op 语义(不产生气泡)。
#[tokio::test]
async fn session_switch_emits_mirror_started_again() {
    let (state, sid, secret, _t1, _tmp1) = mirrored_session("").await;
    let entry = state.agents.get(&sid).unwrap();
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry.attach(&client).await;
    // 先消费首次升格的 mirror_started。
    wait_for_agent_frame(&mut priority_rx, "mirror_started").await;

    // claude 换会话:新 claude_sid + 新 transcript。
    let tmp2 = TempDir::new();
    let t2 = tmp2.file("claude-b.jsonl");
    std::fs::write(&t2, "").unwrap();
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "SessionStart"),
        session_start_body("claude-sid-b", &t2),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // 换会话应再收到一次 mirror_started(live fan-out,同一连接不断流)。
    wait_for_agent_frame(&mut priority_rx, "mirror_started").await;
}

/// 同 sid 重入(compact,claude_sid 与 transcript 都没变):**不发** mirror_started——
/// 该分支只 poke_catch_up,镜像身份未变,重复信号徒增下行噪音。
#[tokio::test]
async fn same_sid_reentry_does_not_emit_mirror_started() {
    let (state, sid, secret, transcript, _tmp) = mirrored_session("").await;
    let entry = state.agents.get(&sid).unwrap();
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry.attach(&client).await;
    // 先消费首次升格的 mirror_started。
    wait_for_agent_frame(&mut priority_rx, "mirror_started").await;

    // 同身份重入(compact 等)。
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "SessionStart"),
        session_start_body("claude-sid-a", &transcript),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // 200ms 窗口内不得再出现 mirror_started(同 no_broadcast_after_mirror_ended 的否定断言范式)。
    let extra = tokio::time::timeout(Duration::from_millis(200), async {
        loop {
            let frame = priority_rx.recv().await?;
            if frame[0] == protocol::MSG_AGENT_EVENT
                && String::from_utf8_lossy(&frame[1..]).contains("mirror_started")
            {
                return Some(frame);
            }
        }
    })
    .await;
    assert!(
        !matches!(extra, Ok(Some(_))),
        "同 sid 重入(compact)不得重发 mirror_started"
    );
}

// ── FIX-5(hook 层集成):MirrorEnded 之后无事件上 wire ──

/// FIX-5:cleanup 发出 MirrorEnded 后,tailer 并发滞留的 send 不得再广播——fan-out 在
/// MirrorEnded 处终结、rx drop,尾随 send 失败(结构性保证 MirrorEnded 是 wire 上最后
/// 一条,手机端不被尾随事件拉回镜像态、冒孤儿气泡)。
#[tokio::test]
async fn no_broadcast_after_mirror_ended_on_wire() {
    let (state, sid, _secret, _t, _tmp) = mirrored_session("").await;
    let entry = state.agents.get(&sid).unwrap();
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry.attach(&client).await;

    // 模拟 tailer 的并发 send 时序:cleanup 前先攥一份 event_tx clone(保 rx 侧通道打开)。
    let tx = state
        .mirrors
        .inner
        .lock()
        .unwrap()
        .get(&sid)
        .unwrap()
        .event_tx
        .clone();

    cleanup_mirror(&state, &sid, "claude-sid-a");
    wait_for_agent_frame(&mut priority_rx, "mirror_ended").await;

    // 尾随事件:FIFO 上必然排在 MirrorEnded 之后(无论 fan-out 是否已 break,都不得广播)。
    let _ = tx.send(AgentEvent::AssistantDelta {
        text: "孤儿气泡".into(),
    });
    let extra = tokio::time::timeout(Duration::from_millis(200), async {
        loop {
            let frame = priority_rx.recv().await?;
            if frame[0] == protocol::MSG_AGENT_EVENT
                && String::from_utf8_lossy(&frame[1..]).contains("孤儿气泡")
            {
                return Some(frame);
            }
        }
    })
    .await;
    assert!(
        !matches!(extra, Ok(Some(_))),
        "MirrorEnded 之后的尾随事件不得广播(wire 上最后一条必须是 mirror_ended)"
    );
    wait_until_mirror_entry_gone(&state, &sid).await;
}

// ── 升格补 attach(re-review 缺口①):升格前已连接的 client 必须收到镜像 live 帧 ──

/// 主场景(真机 bug 复现):client **先**连接(此时 agents 表无 entry,ws.rs 步骤6 /
/// ipc_terminal 的连接时 attach 走 else 分支,不 attach)→ SessionStart 首次升格
/// (register_mirror 新建 FanState,attached 为**空**)。fan_out_one 只投 attached 集合,
/// 若升格不补 attach,该 client 收不到 MirrorStarted 与其后全部镜像事件,只有断线重连才
/// 靠 history 回放看到——用户坐在会话里点「启动」,claude 起来但 Agent 页永远「未运行」。
/// 断言:**不经重连**,已连接 client 直接收到 0x50 mirror_started;随后经 event_tx 发
/// 内容事件也到达(证明不止 history 回放,live fan-out 链路已通)。
#[tokio::test]
async fn pre_connected_client_gets_mirror_started_without_reconnect() {
    // 建会话 + 登记 secret,但**不**升格(不能用 mirrored_session——它先 SessionStart)。
    let state = Arc::new(create_dummy_state());
    let session = state.session_manager.create();
    let sid = session.id.clone();
    let secret = format!("test-secret-{}", sid);
    state.hook_secrets.register(sid.clone(), secret.clone());

    // client 先连接:入 session.clients、connected,但无 entry 可 attach(连接时序在升格前)。
    let (_client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;

    // SessionStart 首次升格。
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

    // 不经重连:升格补 attach 后,已连接 client 直接收到 mirror_started。
    wait_for_agent_frame(&mut priority_rx, "mirror_started").await;

    // live 链路:经常驻 event_tx 发内容事件 → 同一连接收到(client 已进 attached,
    // fan_out_one 投递可达)。
    let tx = state
        .mirrors
        .inner
        .lock()
        .unwrap()
        .get(&sid)
        .unwrap()
        .event_tx
        .clone();
    let _ = tx.send(AgentEvent::AssistantDelta {
        text: "升格后的live帧".into(),
    });
    wait_for_agent_frame(&mut priority_rx, "升格后的live帧").await;
}

/// 同缺口第二个洞:mirror_ended 后**秒起新 claude**——cleanup 回收旧 entry 后,新
/// SessionStart 走首次升格分支建**新 entry**(attached 又是空),已连接未重连的 client
/// 若不补 attach 会永远停在 welcome。断言:同一 client(同一连接,不重连)收到新 entry
/// 的 mirror_started。
#[tokio::test]
async fn client_gets_mirror_started_from_new_entry_after_cleanup() {
    let (state, sid, secret, _t1, _tmp1) = mirrored_session("").await;
    let entry = state.agents.get(&sid).unwrap();
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry.attach(&client).await;
    wait_for_agent_frame(&mut priority_rx, "mirror_started").await;

    // claude 退出:cleanup → mirror_ended 下行,旧 entry 自回收。
    cleanup_mirror(&state, &sid, "claude-sid-a");
    wait_for_agent_frame(&mut priority_rx, "mirror_ended").await;
    wait_until_mirror_entry_gone(&state, &sid).await;

    // 秒起新 claude:新 SessionStart → 首次升格分支 → 新 entry(attached 原本为空)。
    let tmp2 = TempDir::new();
    let t2 = tmp2.file("claude-b.jsonl");
    std::fs::write(&t2, "").unwrap();
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "SessionStart"),
        session_start_body("claude-sid-b", &t2),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // 同一连接不重连,收到新 entry 的 mirror_started(升格补 attach 闭环第二个洞)。
    wait_for_agent_frame(&mut priority_rx, "mirror_started").await;
}

// ── 修 #2:Notification 感知桥(claude 弹审批 → 镜像态下行 notify)──

/// Notification 的 hook stdin JSON(字段形状照 claude 官方 payload:`message` 携带
/// 提示文案,如 "Claude needs your permission to use Bash";`None` = 缺 message 字段)。
fn notification_body(message: Option<&str>) -> Bytes {
    let mut v = json!({ "hook_event_name": "Notification", "session_id": "claude-sid-a" });
    if let Some(m) = message {
        v["message"] = json!(m);
    }
    Bytes::from(v.to_string())
}

/// 主场景(真机 bug 复现):镜像态会话收到带 message 的 Notification hook →
/// attached client 收到 0x50 notify 帧,message **原样透传**(冻结契约
/// `{"type":"notify","message":"…"}`)。零 token 由 handler 返回类型(裸 StatusCode,
/// 空 body)结构性保证——只读观察、不注入任何东西回 claude。
#[tokio::test]
async fn notification_forwards_message_to_attached_client() {
    let (state, sid, secret, _t, _tmp) = mirrored_session("").await;
    let entry = state.agents.get(&sid).unwrap();
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry.attach(&client).await;
    wait_for_agent_frame(&mut priority_rx, "mirror_started").await;

    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "Notification"),
        notification_body(Some("Claude needs your permission to use Bash")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let frame = wait_for_agent_frame(&mut priority_rx, "notify").await;
    let payload: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(
        payload,
        json!({"type": "notify", "message": "Claude needs your permission to use Bash"}),
        "notify 帧 wire 契约不可漂移,message 必须原样透传"
    );
}

/// 缺 `message`(字段缺失/非字符串)→ 兜底文案「Claude 需要你的确认」,
/// 保证手机侧总有可展示内容(不发空 message 的哑帧)。
#[tokio::test]
async fn notification_without_message_uses_fallback_text() {
    let (state, sid, secret, _t, _tmp) = mirrored_session("").await;
    let entry = state.agents.get(&sid).unwrap();
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry.attach(&client).await;
    wait_for_agent_frame(&mut priority_rx, "mirror_started").await;

    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "Notification"),
        notification_body(None),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let frame = wait_for_agent_frame(&mut priority_rx, "notify").await;
    let payload: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(
        payload,
        json!({"type": "notify", "message": "Claude 需要你的确认"}),
        "缺 message 必须落兜底文案"
    );
}

/// 非镜像会话(从未升格)的 Notification:no-op——200、不建 entry、不写 registry
/// (转发只属于镜像态;方案 B / 普通会话不受影响)。
#[tokio::test]
async fn notification_on_unmirrored_session_is_noop() {
    let state = Arc::new(create_dummy_state());
    let session = state.session_manager.create();
    let sid = session.id.clone();
    let secret = format!("test-secret-{}", sid);
    state.hook_secrets.register(sid.clone(), secret.clone());

    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "Notification"),
        notification_body(Some("orphan")),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "非镜像会话的 Notification 应 200(fire-and-forget)"
    );
    assert!(
        state.agents.get(&sid).is_none(),
        "非镜像会话的 Notification 不得建 entry"
    );
    assert!(
        state.mirrors.inner.lock().unwrap().is_empty(),
        "非镜像会话的 Notification 不得写 registry"
    );
}

/// 镜像清理后(mirror_ended 已发、registry 已清)滞后到达的 Notification:不得再有
/// notify 上 wire(mirror_ended 必须保持 wire 上最后一条;否定断言范式同
/// no_broadcast_after_mirror_ended_on_wire)。
#[tokio::test]
async fn notification_after_cleanup_emits_no_notify() {
    let (state, sid, secret, _t, _tmp) = mirrored_session("").await;
    let entry = state.agents.get(&sid).unwrap();
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry.attach(&client).await;
    wait_for_agent_frame(&mut priority_rx, "mirror_started").await;

    // claude 退出:cleanup → mirror_ended 下行,registry 条目已清。
    cleanup_mirror(&state, &sid, "claude-sid-a");
    wait_for_agent_frame(&mut priority_rx, "mirror_ended").await;

    // 滞后的 Notification(退出竞态)→ 200,但无 notify 帧上 wire。
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "Notification"),
        notification_body(Some("late")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let extra = tokio::time::timeout(Duration::from_millis(200), async {
        loop {
            let frame = priority_rx.recv().await?;
            if frame[0] == protocol::MSG_AGENT_EVENT
                && String::from_utf8_lossy(&frame[1..]).contains("notify")
            {
                return Some(frame);
            }
        }
    })
    .await;
    assert!(
        !matches!(extra, Ok(Some(_))),
        "清理后的滞后 Notification 不得再发 notify(mirror_ended 必须是最后一条)"
    );
    wait_until_mirror_entry_gone(&state, &sid).await;
}

/// 换会话分支回归:同 entry、attached 保留——补 attach **只属于首次升格分支**。若换会话
/// 也误补 attach,attach_client 会重放全部 history(此时含两条 mirror_started)→ 已在流的
/// client 收到重复帧。断言:换会话后 mirror_started 恰到达一次(live fan-out),200ms 内
/// 无第二条(否定断言范式同 same_sid_reentry_does_not_emit_mirror_started)。
#[tokio::test]
async fn session_switch_keeps_attached_without_replaying_history() {
    let (state, sid, secret, _t1, _tmp1) = mirrored_session("").await;
    let entry = state.agents.get(&sid).unwrap();
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry.attach(&client).await;
    wait_for_agent_frame(&mut priority_rx, "mirror_started").await;

    // claude 换会话:新 claude_sid + 新 transcript(同 entry,只换 tailer)。
    let tmp2 = TempDir::new();
    let t2 = tmp2.file("claude-b.jsonl");
    std::fs::write(&t2, "").unwrap();
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "SessionStart"),
        session_start_body("claude-sid-b", &t2),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // attached 保留:换会话的 mirror_started 经 live fan-out 继续到达……
    wait_for_agent_frame(&mut priority_rx, "mirror_started").await;
    // ……且恰一次:200ms 内不得再出现(误补 attach 会重放 history 里两条 mirror_started)。
    let extra = tokio::time::timeout(Duration::from_millis(200), async {
        loop {
            let frame = priority_rx.recv().await?;
            if frame[0] == protocol::MSG_AGENT_EVENT
                && String::from_utf8_lossy(&frame[1..]).contains("mirror_started")
            {
                return Some(frame);
            }
        }
    })
    .await;
    assert!(
        !matches!(extra, Ok(Some(_))),
        "换会话分支不得补 attach(会重放 history 造成重复帧)"
    );
}
