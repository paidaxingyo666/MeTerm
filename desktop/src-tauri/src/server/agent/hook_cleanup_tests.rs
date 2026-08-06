//! `hook.rs` 的镜像退出与清理专项测试。
//!
//! 经 `#[path]` 挂为 `hook` 的子模块；复用 `hook_tests` 的测试助手，保持主测试文件低于
//! 项目 1000 行上限，同时不改变原有测试语义。

use super::hook_tests::{
    attached_client, call_hook, event_body, hook_headers, loopback, mirrored_session,
    session_end_body, session_start_body, tailer_cancel_of, wait_for_agent_frame,
    wait_until_mirror_entry_gone, TempDir,
};
use super::*;
use crate::server::protocol;
use crate::server::session::client::WsReceivers;

/// cleanup_mirror 幂等全链路:已 attach 客户端收到 mirror_ended 0x50 帧(先发后清)、
/// tailer cancel 已 fire、registry 移除、entry 自回收(agents.get → None);
/// 再调一次 = registry miss → no-op,不 panic、不重发。
#[tokio::test]
async fn cleanup_mirror_ends_mirror_and_is_idempotent() {
    let (state, sid, _secret, _transcript, _tmp) = mirrored_session("").await;
    let entry = state.agents.get(&sid).unwrap();
    let session = state.session_manager.get(&sid).unwrap();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    entry.attach(&client).await;
    let cancel = tailer_cancel_of(&state, &sid);

    cleanup_mirror(&state, &sid, "claude-sid-a");

    // MirrorEnded 到达已 attach 客户端(冻结契约 {"type":"mirror_ended"})。
    let frame = wait_for_agent_frame(&mut priority_rx, "mirror_ended").await;
    let payload: serde_json::Value = serde_json::from_slice(&frame[1..]).unwrap();
    assert_eq!(
        payload,
        json!({"type": "mirror_ended"}),
        "wire 契约不可漂移"
    );

    assert!(cancel.is_cancelled(), "cleanup 应 cancel tailer");
    assert!(
        state.mirrors.inner.lock().unwrap().get(&sid).is_none(),
        "cleanup 应移除 registry 条目"
    );
    wait_until_mirror_entry_gone(&state, &sid).await;

    // 幂等:第二次调用 registry miss → no-op 不 panic,也不再有任何 mirror_ended 下发。
    cleanup_mirror(&state, &sid, "claude-sid-a");
    let extra = tokio::time::timeout(Duration::from_millis(200), async {
        loop {
            let frame = priority_rx.recv().await?;
            if frame[0] == protocol::MSG_AGENT_EVENT
                && String::from_utf8_lossy(&frame[1..]).contains("mirror_ended")
            {
                return Some(frame);
            }
        }
    })
    .await;
    assert!(
        !matches!(extra, Ok(Some(_))),
        "幂等:重复 cleanup 不得重发 mirror_ended"
    );
}

/// SessionEnd hook 端点分支:带双闸 headers 且 body 携带匹配 claude_sid 的 POST →
/// 触发 cleanup(registry 移除、tailer 取消、entry 自回收)。无镜像状态的会话再发一次
/// → 200 no-op(幂等)。(FIX-1 后 body 必须带匹配的 session_id 才清。)
#[tokio::test]
async fn session_end_hook_triggers_cleanup() {
    let (state, sid, secret, _transcript, _tmp) = mirrored_session("").await;
    let cancel = tailer_cancel_of(&state, &sid);

    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "SessionEnd"),
        session_end_body("claude-sid-a"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "SessionEnd 应 200(fire-and-forget)");

    assert!(cancel.is_cancelled(), "SessionEnd 应 cancel tailer");
    assert!(
        state.mirrors.inner.lock().unwrap().get(&sid).is_none(),
        "SessionEnd 应清除 registry 条目"
    );
    wait_until_mirror_entry_gone(&state, &sid).await;

    // 已清后重复 SessionEnd:200、no-op、不 panic。
    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, &secret, "SessionEnd"),
        session_end_body("claude-sid-a"),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "重复 SessionEnd 应 200 no-op");
}

/// 身份双闸在 cleanup 之前:错 secret 的 SessionEnd 401,且不得触发任何清理。
#[tokio::test]
async fn session_end_with_wrong_secret_does_not_cleanup() {
    let (state, sid, _secret, _transcript, _tmp) = mirrored_session("").await;
    let cancel = tailer_cancel_of(&state, &sid);

    let status = call_hook(
        &state,
        loopback(),
        hook_headers(&sid, "wrong-secret", "SessionEnd"),
        event_body("SessionEnd"),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "错 secret 的 SessionEnd 必须 401"
    );
    assert!(!cancel.is_cancelled(), "401 路径不得 cancel tailer");
    assert!(
        state.mirrors.inner.lock().unwrap().get(&sid).is_some(),
        "401 路径不得清 registry"
    );
}

/// 7768 兜底回调槽:升格后 Session.on_shell_prompt 有值;存续 < PROMPT_GUARD 的调用被守卫
/// 忽略(防升格前滞后的 prompt 7768 帧误清刚建的镜像);构造老 upgraded_at 越过守卫后调用
/// → cleanup 生效且回调槽清空。
/// FIX-7:守卫断言去墙钟化——不依赖「mirrored_session 到 cb 调用耗时 <1s」的真实墙钟
/// (重负载 CI 下可能假红),直接把 upgraded_at 拨到远未来(elapsed 饱和为 0 < PROMPT_GUARD),
/// 守卫判定确定性生效。
#[tokio::test]
async fn shell_prompt_callback_guarded_then_cleans_up() {
    let (state, sid, _secret, _transcript, _tmp) = mirrored_session("").await;
    let session = state.session_manager.get(&sid).unwrap();

    // 升格后回调槽应有值。
    let cb = session
        .on_shell_prompt
        .lock()
        .unwrap()
        .clone()
        .expect("升格后 on_shell_prompt 回调槽应已设置");

    // 守卫路径:upgraded_at 拨远未来(确定性「存续不足」),调用应被忽略——registry 与槽都不动。
    {
        let mut map = state.mirrors.inner.lock().unwrap();
        map.get_mut(&sid).unwrap().upgraded_at =
            std::time::Instant::now() + Duration::from_secs(3600);
    }
    cb(0);
    assert!(
        state.mirrors.inner.lock().unwrap().get(&sid).is_some(),
        "存续 < PROMPT_GUARD 的 7768 应被守卫忽略(启动瞬间残留帧)"
    );
    assert!(
        session.on_shell_prompt.lock().unwrap().is_some(),
        "守卫忽略时回调槽不得清空"
    );

    // 构造老 upgraded_at(60s 前,越过守卫)→ 视为真退出,清理生效。
    {
        let mut map = state.mirrors.inner.lock().unwrap();
        map.get_mut(&sid).unwrap().upgraded_at =
            std::time::Instant::now() - Duration::from_secs(60);
    }
    cb(0);
    assert!(
        state.mirrors.inner.lock().unwrap().get(&sid).is_none(),
        "越过守卫的 7768 应清除 registry(claude 真退出)"
    );
    assert!(
        session.on_shell_prompt.lock().unwrap().is_none(),
        "cleanup 后回调槽应置回 None"
    );
    wait_until_mirror_entry_gone(&state, &sid).await;

    // 幂等:cleanup 后再调旧回调(手里还持有 clone)→ registry miss,no-op 不 panic。
    cb(0);
}

/// 换会话不误清:SessionStart(新 claude_sid)后 registry 仍有(新身份)MirrorState、
/// 回调槽仍在;且换会话刷新 upgraded_at——紧随其后的滞后 7768 帧被守卫忽略,
/// 不误清刚换上的新镜像(新 claude 秒起竞态防御)。
#[tokio::test]
async fn session_switch_refreshes_guard_and_survives_stale_prompt() {
    let (state, sid, secret, _t1, _tmp1) = mirrored_session("").await;
    let session = state.session_manager.get(&sid).unwrap();

    // 模拟第一段 claude 已跑了很久(upgraded_at 很老)。
    {
        let mut map = state.mirrors.inner.lock().unwrap();
        map.get_mut(&sid).unwrap().upgraded_at =
            std::time::Instant::now() - Duration::from_secs(60);
    }

    // claude 换会话(重跑/resume):新 claude_sid + 新 transcript。
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

    // registry 仍有(新)MirrorState;换会话不走 cleanup。
    {
        let map = state.mirrors.inner.lock().unwrap();
        let st = map.get(&sid).expect("换会话后 registry 应仍有 MirrorState");
        assert_eq!(
            st.claude_session_id, "claude-sid-b",
            "身份应更新为新 claude 会话"
        );
    }
    assert!(state.agents.get(&sid).is_some(), "换会话不得回收镜像 entry");

    // 换会话已刷新 upgraded_at:原基准 60s 前 → 现在(30s 余量断言「已刷新」,
    // 不依赖 <1s 墙钟,FIX-7)。
    {
        let map = state.mirrors.inner.lock().unwrap();
        assert!(
            map.get(&sid).unwrap().upgraded_at.elapsed() < Duration::from_secs(30),
            "换会话应刷新 upgraded_at(滞后 7768 的守卫基准)"
        );
    }
    // 确定性守卫断言(FIX-7):upgraded_at 拨远未来(elapsed 饱和为 0),滞后 7768
    // (换会话前顶层 prompt 残留)必被守卫忽略。
    {
        let mut map = state.mirrors.inner.lock().unwrap();
        map.get_mut(&sid).unwrap().upgraded_at =
            std::time::Instant::now() + Duration::from_secs(3600);
    }
    let cb = session
        .on_shell_prompt
        .lock()
        .unwrap()
        .clone()
        .expect("换会话后回调槽应仍在");
    cb(0);
    assert!(
        state.mirrors.inner.lock().unwrap().get(&sid).is_some(),
        "换会话瞬间的滞后 7768 不得误清新镜像(upgraded_at 应已刷新)"
    );
}

/// FIX-1:Tauri IPC delete_session 路径(commands/session.rs,桌面 UI 关标签走这条)的
/// 清理序列等价物——`tauri::State` 无法在单测中构造(未启用 tauri `test` feature,
/// commands 层亦无测试先例),故按该命令的同一语句序列锁定行为:
/// session_manager.delete → hook_secrets.remove → mirrors.remove_and_cancel。
#[tokio::test]
async fn ipc_delete_sequence_clears_registry_and_secret() {
    let (state, sid, secret, _transcript, _tmp) = mirrored_session("").await;
    let cancel = {
        let map = state.mirrors.inner.lock().unwrap();
        map.get(&sid).unwrap().tailer_cancel.clone()
    };

    // 与 commands/session.rs::delete_session 成功分支逐句对齐。
    state.session_manager.delete(&sid).unwrap();
    state.hook_secrets.remove(&sid);
    state.mirrors.remove_and_cancel(&sid);

    assert!(
        state.mirrors.inner.lock().unwrap().get(&sid).is_none(),
        "IPC delete 序列应清除 registry 条目(不再滞留到下次 sweep)"
    );
    assert!(
        cancel.is_cancelled(),
        "IPC delete 序列后 tailer cancel 应已 fire"
    );
    assert!(
        !state.hook_secrets.verify(&sid, &secret),
        "IPC delete 序列后 hook secret 应已注销"
    );
}
