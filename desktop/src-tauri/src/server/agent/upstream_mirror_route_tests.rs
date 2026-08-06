//! Mirror 上行路由测试(M6:PTY 注入)。

use super::*;
use crate::server::agent::AgentEvent;
use crate::server::create_dummy_state;
use crate::server::events::EventBus;
use crate::server::session::client::{Client, WsReceivers};
use crate::server::session::state::ClientRole;
use crate::server::session::SessionConfig;
use serde_json::json;
use std::time::Duration;
use tokio::sync::mpsc;

/// Mirror 路由测试全套:dummy state + Mirror entry 入表 + master client("phone")+
/// 可观察 input channel。`_event_tx` 必须保活——event_rx 关闭会触发镜像 fan-out 收尾移表。
async fn mirror_setup() -> (
    ServerState,
    Arc<Session>,
    mpsc::Receiver<Vec<u8>>, // master client 的 priority 接收端(错误帧观察)
    mpsc::Receiver<Vec<u8>>, // PTY input channel 接收端(注入字节观察)
    mpsc::UnboundedSender<AgentEvent>,
) {
    let state = create_dummy_state();
    let config = SessionConfig {
        session_ttl: Duration::from_secs(300),
        reconnect_grace: Duration::from_secs(60),
        ring_buffer_size: 4096,
        log_dir: String::new(),
    };
    let session = Arc::new(Session::new(
        "mirror-m6-session".into(),
        config,
        EventBus::new(),
    ));
    // 测试 seam:装上可观察的 input channel(替代 start_terminal 的真实 PTY)。
    let input_rx = session.install_input_channel_for_test().await;
    // 首个非只读 client 自动晋升 master("phone" 即 master)。
    let (client, rx) = Client::new(
        "phone".into(),
        "127.0.0.1".into(),
        ClientRole::Viewer,
        crate::server::session::client::ClientSecurityContext::direct_loopback_owner(),
    );
    session.add_client(Arc::new(client)).unwrap();
    let WsReceivers { priority_rx, .. } = rx;
    // 注册 Mirror entry(kind=Mirror、client=None),sender 保活防收尾移表。
    let (event_tx, event_rx) = mpsc::unbounded_channel::<AgentEvent>();
    state.agents.register_mirror(
        session.id.clone(),
        event_rx,
        session.clone(),
        EventBus::new(),
    );
    (state, session, priority_rx, input_rx, event_tx)
}

/// 排空一个接收端为帧序列(按到达顺序)。
fn drain(rx: &mut mpsc::Receiver<Vec<u8>>) -> Vec<Vec<u8>> {
    std::iter::from_fn(|| rx.try_recv().ok()).collect()
}

fn authority(
    session: &Session,
    client_id: &str,
) -> crate::server::session::access::DispatchAuthority {
    let conn_gen = session
        .client_connection_generation(client_id)
        .expect("test client must be connected");
    session
        .current_client_connection(client_id, conn_gen)
        .expect("test client generation must be current")
}

/// Mirror input(单行,聊天主场景):0x51 → **恰一次**注入 `text + \r`(裸文本,
/// 无 paste 包裹,等价手敲 Enter),延迟窗口过后无第二次注入;且**不**回错误帧、
/// **不**发确认帧。
#[tokio::test]
async fn mirror_input_single_line_injects_text_cr_exactly_once() {
    let (state, session, mut priority_rx, mut input_rx, _event_tx) = mirror_setup().await;
    let payload = json!({ "prompt": "修复这个 bug 🚀" }).to_string();

    handle_agent_input(
        &session,
        &authority(&session, "phone"),
        payload.as_bytes(),
        &state,
    );

    let got = tokio::time::timeout(Duration::from_secs(5), input_rx.recv())
        .await
        .expect("input channel 应收到注入字节(不应超时)")
        .expect("input channel 不应关闭");
    assert_eq!(
        got,
        "修复这个 bug 🚀\r".as_bytes().to_vec(),
        "单行必须裸注入 text+\\r(不包 paste)"
    );
    // 等超过延迟窗口再看:单行没有延迟提交,不得有第二次注入。
    tokio::time::sleep(MULTILINE_SUBMIT_DELAY * 3).await;
    assert!(
        input_rx.try_recv().is_err(),
        "单行不得有第二次注入(无延迟 \\r)"
    );
    // 不回错误帧、不发确认帧(成功反馈即镜像下行事件,与终端打字一致)。
    assert!(
        drain(&mut priority_rx).is_empty(),
        "Mirror input 成功路径不应回任何帧(无错误、无确认)"
    );
}

/// Mirror input(多行):0x51 → **两次**注入——先 paste 正文(无提交 `\r`),
/// 延迟后单独注入提交 `\r`(修 #1:同批发送时 Ink TUI 吞回车 → 只进输入框不提交)。
#[tokio::test]
async fn mirror_input_multiline_injects_paste_body_then_deferred_cr() {
    let (state, session, mut priority_rx, mut input_rx, _event_tx) = mirror_setup().await;
    let text = "继续修\n第二行 🚀";
    let payload = json!({ "prompt": text }).to_string();

    handle_agent_input(
        &session,
        &authority(&session, "phone"),
        payload.as_bytes(),
        &state,
    );

    // 第一次注入:paste 正文,与 encode_prompt_body 完全一致(不含提交 \r)。
    let first = tokio::time::timeout(Duration::from_secs(5), input_rx.recv())
        .await
        .expect("input channel 应收到 paste 正文(不应超时)")
        .expect("input channel 不应关闭");
    let (expected_body, deferred) = encode_prompt_body(text);
    assert!(deferred, "多行应走延迟提交路径");
    assert_eq!(
        first, expected_body,
        "第一次注入必须是 paste 正文(无提交 \\r)"
    );
    // 提交 \r 不得与正文同批:正文刚到达时延迟任务还在 sleep,通道应为空。
    assert!(
        input_rx.try_recv().is_err(),
        "提交 \\r 不得与 paste 正文同批注入"
    );
    // 第二次注入:延迟后的单独 \r(先 body 后 \r 的顺序由两次 recv 顺序锁定)。
    let second = tokio::time::timeout(Duration::from_secs(5), input_rx.recv())
        .await
        .expect("应收到延迟注入的提交 \\r(不应超时)")
        .expect("input channel 不应关闭");
    assert_eq!(second, b"\r".to_vec(), "第二次注入必须是单独的提交 \\r");
    // 不回错误帧、不发确认帧(成功反馈即镜像下行事件,与终端打字一致)。
    assert!(
        drain(&mut priority_rx).is_empty(),
        "Mirror input 成功路径不应回任何帧(无错误、无确认)"
    );
}

/// Mirror interrupt:0x52 action=interrupt → 注入单字节 `\x03`(等价终端 Ctrl-C)。
#[tokio::test]
async fn mirror_interrupt_injects_ctrl_c() {
    let (state, session, mut priority_rx, mut input_rx, _event_tx) = mirror_setup().await;
    let payload = json!({ "action": "interrupt" }).to_string();

    handle_agent_control(
        &session,
        &authority(&session, "phone"),
        payload.as_bytes(),
        &state,
    );

    let got = tokio::time::timeout(Duration::from_secs(5), input_rx.recv())
        .await
        .expect("input channel 应收到 \\x03(不应超时)")
        .expect("input channel 不应关闭");
    assert_eq!(got, b"\x03".to_vec(), "interrupt 应注入单字节 \\x03");
    assert!(
        drain(&mut priority_rx).is_empty(),
        "Mirror interrupt 成功路径不应回任何帧"
    );
}

/// Mirror approve(P2 审批桥):桥中有 pending → 决策回投成功(rx 收 Allow),
/// 不回错误帧、不注入任何 PTY 字节;optionId="deny" 的 approve 映射为 Deny。
#[tokio::test]
async fn mirror_approve_resolves_pending_permission() {
    let (state, session, mut priority_rx, mut input_rx, _event_tx) = mirror_setup().await;
    // 挂两条 pending(桥自生成 uuid 形态的字符串 id)。
    let rx_allow = state.permission_bridge.register(&session.id, "mperm-a");
    let rx_deny = state.permission_bridge.register(&session.id, "mperm-b");

    let allow = json!({ "action": "approve", "requestId": "mperm-a", "optionId": "allow" });
    handle_agent_control(
        &session,
        &authority(&session, "phone"),
        allow.to_string().as_bytes(),
        &state,
    );
    assert_eq!(
        rx_allow.await.unwrap(),
        PermissionReply::Allow,
        "approve(allow) 应回投 Allow"
    );

    // optionId = "deny"(手机点了审批卡上的「拒绝」选项)→ Deny。
    let deny_opt = json!({ "action": "approve", "requestId": "mperm-b", "optionId": "deny" });
    handle_agent_control(
        &session,
        &authority(&session, "phone"),
        deny_opt.to_string().as_bytes(),
        &state,
    );
    assert_eq!(
        rx_deny.await.unwrap(),
        PermissionReply::Deny(None),
        "approve(deny 选项) 应回投 Deny"
    );

    assert!(drain(&mut priority_rx).is_empty(), "成功回投不回任何帧");
    assert!(
        input_rx.try_recv().is_err(),
        "approve 不得向 PTY 注入任何字节"
    );
}

/// Mirror reject(整卡驳回)→ Deny 回投;无 pending(过期/已决)→ `approval_expired`
/// 错误帧;requestId 非字符串(镜像桥必为字符串 uuid)→ `bad_agent_control`。
#[tokio::test]
async fn mirror_reject_and_expired_and_bad_request_id() {
    let (state, session, mut priority_rx, mut input_rx, _event_tx) = mirror_setup().await;
    let rx = state.permission_bridge.register(&session.id, "mperm-r");

    let reject = json!({ "action": "reject", "requestId": "mperm-r" });
    handle_agent_control(
        &session,
        &authority(&session, "phone"),
        reject.to_string().as_bytes(),
        &state,
    );
    assert_eq!(
        rx.await.unwrap(),
        PermissionReply::Deny(None),
        "reject 应回投 Deny"
    );
    assert!(drain(&mut priority_rx).is_empty(), "成功回投不回任何帧");

    // 无 pending:回 approval_expired。
    let expired = json!({ "action": "reject", "requestId": "mperm-ghost" });
    handle_agent_control(
        &session,
        &authority(&session, "phone"),
        expired.to_string().as_bytes(),
        &state,
    );
    let frames = drain(&mut priority_rx);
    assert_eq!(frames.len(), 1, "过期审批应回一帧错误");
    assert_eq!(frames[0][0], protocol::MSG_ERROR);
    let v: Value = serde_json::from_slice(&frames[0][1..]).unwrap();
    assert_eq!(v["code"], "approval_expired");

    // 数字 requestId(镜像桥不可能发):bad_agent_control。
    let bad = json!({ "action": "approve", "requestId": 1, "optionId": "allow" });
    handle_agent_control(
        &session,
        &authority(&session, "phone"),
        bad.to_string().as_bytes(),
        &state,
    );
    let frames = drain(&mut priority_rx);
    assert_eq!(frames.len(), 1);
    let v: Value = serde_json::from_slice(&frames[0][1..]).unwrap();
    assert_eq!(v["code"], "bad_agent_control");

    assert!(
        input_rx.try_recv().is_err(),
        "审批控制不得向 PTY 注入任何字节"
    );
}

/// 非 master client 发 Mirror input:`handle_input` 内部拒绝——回字节变体
/// ERR_NOT_MASTER 错误帧,input channel 保持空(绝不注入)。
#[tokio::test]
async fn mirror_input_from_non_master_rejected_not_injected() {
    let (state, session, _master_rx, mut input_rx, _event_tx) = mirror_setup().await;
    // 第二个 client:master 已是 "phone",viewer2 不晋升。
    let (viewer, rx2) = Client::new(
        "viewer2".into(),
        "127.0.0.1".into(),
        ClientRole::Viewer,
        crate::server::session::client::ClientSecurityContext::direct_loopback_owner(),
    );
    session.add_client(Arc::new(viewer)).unwrap();
    let WsReceivers {
        mut priority_rx, ..
    } = rx2;

    let payload = json!({ "prompt": "sneaky" }).to_string();
    handle_agent_input(
        &session,
        &authority(&session, "viewer2"),
        payload.as_bytes(),
        &state,
    );

    // handle_input 同步拒绝:字节变体错误帧(frame[1] = ERR_NOT_MASTER)。
    let frames = drain(&mut priority_rx);
    assert!(
        frames
            .iter()
            .any(|f| f[0] == protocol::MSG_ERROR && f[1] == protocol::ERR_NOT_MASTER),
        "非 master 应收到 ERR_NOT_MASTER 错误帧"
    );
    // 等一拍再断言空:若实现误 spawn 注入,此处能抓到。
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        input_rx.try_recv().is_err(),
        "非 master 的输入绝不注入 PTY input channel"
    );
}
