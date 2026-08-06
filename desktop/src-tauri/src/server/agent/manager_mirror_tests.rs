//! `manager.rs` 的镜像会话(方案甲 M5)单元测试。
//!
//! 与 `manager_tests.rs` 同为 `manager` 的子测试模块(`#[path]` 挂载),拆成独立文件是为把两个
//! 测试文件都控制在 1000 行以内(项目规范)。`use super::*` 令 `super` = `manager` 模块,可访问其
//! 私有项(`run_mirror_fan_out` / `finalize_mirror` / `register_mirror` / `FanState` / `attach_client` 等)。

use super::*;
use crate::server::hook_secret::HookSecretRegistry;
use crate::server::session::client::{Client, WsReceivers};
use crate::server::session::state::ClientRole;
use crate::server::session::{Session, SessionConfig};
use std::time::Duration;

// ── 测试助手(与 manager_tests.rs 局部助手同款,两文件各自持有以保持独立)──

fn test_session() -> Arc<Session> {
    let config = SessionConfig {
        session_ttl: Duration::from_secs(300),
        reconnect_grace: Duration::from_secs(60),
        ring_buffer_size: 4096,
        log_dir: String::new(),
    };
    Arc::new(Session::new(
        "mirror-test-session".into(),
        config,
        EventBus::new(),
    ))
}

fn test_session_manager() -> Arc<SessionManager> {
    SessionManager::new(
        SessionConfig {
            session_ttl: Duration::from_secs(300),
            reconnect_grace: Duration::from_secs(60),
            ring_buffer_size: 4096,
            log_dir: String::new(),
        },
        EventBus::new(),
        HookSecretRegistry::new(),
    )
}

/// 建一个真实 Client 并加入 session(模拟 handle_ws 步骤2:已在 session.clients、connected)。
fn attached_client(session: &Session, id: &str) -> (Arc<Client>, WsReceivers) {
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

/// 排空一个 client 的 priority 接收端为帧序列(按到达顺序)。
fn drain(rx: &mut mpsc::Receiver<Vec<u8>>) -> Vec<Vec<u8>> {
    std::iter::from_fn(|| rx.try_recv().ok()).collect()
}

/// 构造一个 Mirror 表条目(client=None、kind=Mirror),供 attach 双回放 / finalize 断言。
fn test_mirror_entry() -> Arc<AgentEntry> {
    Arc::new(AgentEntry {
        client: None,
        fan: Arc::new(Mutex::new(FanState::new())),
        meta: AgentMeta {
            agent: "claude".into(),
            cwd: String::new(),
            kind: AgentKind::Mirror,
        },
        task: Mutex::new(None),
        busy: AtomicBool::new(false),
        ever_attached: Arc::new(AtomicBool::new(true)),
    })
}

// ── register_mirror ──

/// register_mirror 建 Mirror entry:kind==Mirror、client==None、可查表;喂事件经 fan_out 广播;
/// event_rx 关闭后镜像 fan-out 收尾(finalize_mirror)→ 表条目移除。
#[tokio::test]
async fn register_mirror_creates_mirror_entry_and_fans_out() {
    let session = test_session();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;

    let mgr = AcpAgentManager::new();
    let (tx, event_rx) = mpsc::unbounded_channel::<AgentEvent>();
    let entry = mgr.register_mirror(
        session.id.clone(),
        event_rx,
        session.clone(),
        EventBus::new(),
    );

    // 建的是 Mirror entry:kind==Mirror、无 AcpClient、已入表。
    assert_eq!(
        entry.kind(),
        AgentKind::Mirror,
        "register_mirror 应建 Mirror 类型"
    );
    assert!(
        entry.client().is_none(),
        "镜像 entry 无 AcpClient(client=None)"
    );
    assert!(mgr.get(&session.id).is_some(), "register_mirror 后应可查表");

    // attach → 之后喂的 live 帧会投给它。
    entry.attach(&client).await;

    tx.send(AgentEvent::AssistantDelta {
        text: "镜像".into(),
    })
    .unwrap();
    // 关闭事件源 → run_mirror_fan_out break → finalize_mirror 移除表条目。
    drop(tx);

    // 等表条目被收尾移除(轮询,避免依赖具体调度时序)。
    for _ in 0..200 {
        if mgr.get(&session.id).is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(
        mgr.get(&session.id).is_none(),
        "event_rx 关闭后镜像 fan-out 应收尾移除表条目"
    );

    // 已 attach 的 client 收到那一帧镜像事件(0x50)。
    let got = drain(&mut priority_rx);
    assert!(
        got.iter().any(|f| f[0] == protocol::MSG_AGENT_EVENT),
        "已 attach 的 client 应收到镜像事件帧(0x50)"
    );
}

// ── run_mirror_fan_out 退出路径 ──

/// 结束路径①:喂几条事件后关闭 event_rx → 立即结束(不 hang),且事件都投递到已 attach 的 client。
/// 锁定「event_rx 关闭 = 结束」,且不因无子进程 / 无 idle-guard 而误退或漏发。
#[tokio::test]
async fn mirror_fan_out_delivers_then_ends_on_event_rx_close() {
    let session = test_session();
    let (client, rx) = attached_client(&session, "c1");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;

    let fan = Arc::new(Mutex::new(FanState::new()));
    attach_client(&fan, &client).await; // 空历史,登记进 attached

    let cancel = CancellationToken::new();
    let (tx, event_rx) = mpsc::unbounded_channel::<AgentEvent>();
    for t in ["m1", "m2", "m3"] {
        tx.send(AgentEvent::AssistantDelta { text: t.into() })
            .unwrap();
    }
    drop(tx); // 关闭 event_rx → run_mirror_fan_out 应结束

    tokio::time::timeout(
        Duration::from_secs(5),
        run_mirror_fan_out(fan.clone(), session, EventBus::new(), cancel, event_rx),
    )
    .await
    .expect("event_rx 关闭后镜像 fan-out 应结束,不应 hang");

    assert_eq!(
        fan.lock().unwrap().history.frames.len(),
        3,
        "3 条镜像事件应入历史"
    );
    let got = drain(&mut priority_rx);
    assert_eq!(got.len(), 3, "3 条事件应投递 3 帧");
    assert!(got.iter().all(|f| f[0] == protocol::MSG_AGENT_EVENT));
}

/// 结束路径②:cancel 触发(底层 PTY 会话被 delete/reap)→ 结束,即便 event_rx 的 sender 仍保活。
/// sender 保活确保结束原因只能是 cancel(排除路径①)。
#[tokio::test]
async fn mirror_fan_out_ends_on_cancel() {
    let session = test_session();
    let fan = Arc::new(Mutex::new(FanState::new()));
    let cancel = CancellationToken::new();
    let (_tx, event_rx) = mpsc::unbounded_channel::<AgentEvent>(); // sender 保活
    cancel.cancel();

    tokio::time::timeout(
        Duration::from_secs(5),
        run_mirror_fan_out(fan, session, EventBus::new(), cancel.clone(), event_rx),
    )
    .await
    .expect("cancel 后镜像 fan-out 应结束");
}

/// 不误退:sender 保活 + cancel 不触发时,即便无任何 deadline / 无子进程可等,run_mirror_fan_out
/// 也应一直阻塞在 select(不返回)。与 ACP 的 idle-guard 语义相反——镜像会话的存活不由 agent 层的
/// idle 计时决定。旧 ACP run_fan_out 有 idle-guard / wait_closed 分支,若误复用会在此处提前退出。
#[tokio::test]
async fn mirror_fan_out_does_not_end_without_close_or_cancel() {
    let session = test_session();
    let fan = Arc::new(Mutex::new(FanState::new()));
    let cancel = CancellationToken::new();
    let (_tx, event_rx) = mpsc::unbounded_channel::<AgentEvent>(); // 保活

    let task = tokio::spawn(run_mirror_fan_out(
        fan,
        session,
        EventBus::new(),
        cancel.clone(),
        event_rx,
    ));

    // 远超任何现实 idle deadline 都不应结束(镜像无 idle-guard、无子进程等待)。
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !task.is_finished(),
        "无 close / cancel 时镜像 fan-out 不应结束(无 idle-guard / wait_closed 误退)"
    );

    // 用 cancel 收尾,避免遗留后台任务。
    cancel.cancel();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("cancel 后应结束")
        .expect("run_mirror_fan_out 任务不应 panic");
}

// ── finalize_mirror(镜像不删会话)──

/// finalize_mirror 只从 AcpAgentManager 移除表条目,**绝不删 PTY 会话**——对比 ACP 的
/// finalize_fan_out 会 delete 会话(见 manager_tests::finalize_runs_shutdown_removes_entry_and_deletes_session)。
/// 锁定镜像结束(claude 退出)后底层 local-shell 会话仍在、终端页继续可用。
#[tokio::test]
async fn finalize_mirror_removes_entry_but_keeps_session() {
    let sm = test_session_manager();
    let session = sm.create(); // 底层是默认 local-shell 会话(非 agent)
    let sid = session.id.clone();

    let mgr = AcpAgentManager::new();
    let entry = test_mirror_entry();
    mgr.insert_for_test(&sid, entry.clone());
    assert!(mgr.get(&sid).is_some(), "前置:AgentEntry 在表中");
    assert!(
        sm.get(&sid).is_some(),
        "前置:PTY 会话在 SessionManager 表中"
    );

    finalize_mirror(&mgr, &sid, &entry);

    assert!(
        mgr.get(&sid).is_none(),
        "镜像 finalize 应移除 AgentEntry 表条目"
    );
    assert!(
        sm.get(&sid).is_some(),
        "镜像 finalize 绝不删 PTY 会话(claude 退出但 shell 仍在,终端页继续可用)"
    );
}

/// FIX-2:旧 fan-out 滞后收尾不误删新 entry。Task D 的 cleanup 打破了「entry 会话期内
/// 从不移除」旧不变式:cleanup 后新 SessionStart 可在旧 fan-out drain 完(毫秒级窗口)之前
/// register 新 entry——旧收尾若裸 remove 会把新 entry 误删(新镜像 agents.get→None,
/// 手机整段无法 attach)。收尾必须以 Arc::ptr_eq 比对身份:非自己的 entry 不删;
/// 正常路径(表中仍是自己)照删。
#[tokio::test]
async fn finalize_mirror_identity_guard_spares_new_entry() {
    let mgr = AcpAgentManager::new();
    let old_entry = test_mirror_entry();
    let new_entry = test_mirror_entry();
    // 模拟:cleanup 移除旧条目后,新 SessionStart 已 register 新 entry;
    // 旧 fan-out 才异步走到收尾(它持有的是 old_entry)。
    mgr.insert_for_test("s1", new_entry.clone());
    finalize_mirror(&mgr, "s1", &old_entry);
    let cur = mgr.get("s1").expect("旧 fan-out 滞后收尾不得误删新 entry");
    assert!(
        Arc::ptr_eq(&cur, &new_entry),
        "表中应仍是新 entry(Arc::ptr_eq)"
    );

    // 正常路径:表中是自己的 entry → 移除。
    finalize_mirror(&mgr, "s1", &new_entry);
    assert!(mgr.get("s1").is_none(), "正常收尾应移除自己的 entry");
}

/// FIX-5:MirrorEnded 是终结事件——广播完它 fan-out 立即收尾,即便 sender 仍保活
/// (旧代码只认「rx 关闭 / cancel」两条结束路径,会继续 drain 并**误广播尾随事件**,
/// 手机被拉回镜像态出孤儿气泡)。收尾后 rx drop,tailer 的滞留 send 直接失败
/// (其 send-fail 路径本就退出)——结构性保证 MirrorEnded 是 wire 上最后一条。
#[tokio::test]
async fn mirror_fan_out_ends_at_mirror_ended_and_drops_trailing_events() {
    let session = test_session();
    let (client, rx) = attached_client(&session, "c1");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    let fan = Arc::new(Mutex::new(FanState::new()));
    attach_client(&fan, &client).await;

    let cancel = CancellationToken::new();
    let (tx, event_rx) = mpsc::unbounded_channel::<AgentEvent>();
    tx.send(AgentEvent::AssistantDelta {
        text: "正文".into(),
    })
    .unwrap();
    tx.send(AgentEvent::MirrorEnded).unwrap();
    // 尾随事件:tailer 并发 send 排到 MirrorEnded 之后的时序。
    tx.send(AgentEvent::AssistantDelta {
        text: "孤儿气泡".into(),
    })
    .unwrap();

    // sender 保活:结束原因只能是 MirrorEnded 终结(排除 rx 关闭路径)。
    tokio::time::timeout(
        Duration::from_secs(5),
        run_mirror_fan_out(fan.clone(), session, EventBus::new(), cancel, event_rx),
    )
    .await
    .expect("MirrorEnded 广播后 fan-out 应立即收尾(即便 sender 仍保活)");

    // rx 已随收尾 drop:tailer 后续 send 必失败。
    assert!(tx.is_closed(), "收尾后 event_rx 应已 drop(滞留 send 失败)");

    // wire 序:正文 → mirror_ended 为最后一帧;尾随事件不广播;历史同样止步。
    let got = drain(&mut priority_rx);
    let texts: Vec<String> = got
        .iter()
        .map(|f| String::from_utf8_lossy(&f[1..]).to_string())
        .collect();
    assert!(
        texts.iter().any(|t| t.contains("正文")),
        "MirrorEnded 之前的事件应正常广播"
    );
    assert!(
        texts.last().is_some_and(|t| t.contains("mirror_ended")),
        "MirrorEnded 应是 wire 上最后一条,实际尾帧:{:?}",
        texts.last()
    );
    assert!(
        !texts.iter().any(|t| t.contains("孤儿气泡")),
        "MirrorEnded 之后的尾随事件不得广播"
    );
    assert_eq!(
        fan.lock().unwrap().history.frames.len(),
        2,
        "历史应止步于 MirrorEnded"
    );
}

// ── ws / ipc attach 的 Mirror 双回放 ──

/// ws.rs / ipc 步骤6 的 Mirror 双回放:Mirror 会话 attach 后,client 应**同时**收到终端环形缓冲帧
/// (MSG_OUTPUT)与 AI 历史帧(0x50)。这里复用 ws.rs 同款组合(attach + flush_ring_buffer)以锁定
/// 两类历史都回放——ACP 会话只 attach(无 flush),None 会话只 flush,对比见 kind 分支。
#[tokio::test]
async fn ws_attach_mirror_replays_both_terminal_and_agent_history() {
    let session = test_session();
    // 终端历史:写入环形缓冲(终端页回放源)。
    session.append_to_ring_buffer(b"terminal-scrollback\r\n");

    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;

    // Mirror entry:预置一帧 AI 历史。
    let entry = test_mirror_entry();
    let agent_frame = encode_agent_event(&AgentEvent::AssistantDelta { text: "hi".into() });
    entry.fan.lock().unwrap().history.push(agent_frame.clone());

    // 模拟 ws.rs 的 Mirror 分支:attach(AI 历史)+ flush_ring_buffer_async(终端历史,背压变体)。
    assert_eq!(entry.kind(), AgentKind::Mirror);
    entry.attach(&client).await;
    session
        .flush_ring_buffer_async(&client, client.conn_gen())
        .await;

    let got = drain(&mut priority_rx);
    assert!(
        got.iter().any(|f| f[0] == protocol::MSG_AGENT_EVENT),
        "Mirror 双回放应含 AI 历史帧(0x50)"
    );
    assert!(
        got.iter().any(|f| f[0] == protocol::MSG_OUTPUT),
        "Mirror 双回放应含终端环形缓冲帧(MSG_OUTPUT)"
    );
}

// ── attach 并发互斥(同 client 同 conn_gen 双路 attach)──

/// 【并发双 attach 互斥 · 先红后绿】同 client 同 conn_gen 的两路 attach 并发——真机时序:
/// 手机重连握手(ws 步骤2→6 窗口)横跨 SessionStart,升格补 attach(hook.rs)与连接时
/// attach(ws.rs 步骤6)对同一 client 各发起一次。先启动的 A 回放长 history 至背压挂起
/// (慢化:大历史 + 受控排空),后启动的 B 顶替 → A 必须在校验点 abort(中途停发),
/// B 独占完成回放。无互斥的旧实现两路各发整份 history → wire 收恰 2N 帧、前缀整段重复
/// (手机几十个重复气泡的根因)。
/// 断言:① 总帧数 < 2N(A 中途停发;旧实现恰为 2N → 红);② 尾部 N 帧 = 完整 history
/// 一份、按序(B 的独占回放,A 被顶替后不再插帧)。
#[tokio::test]
async fn concurrent_double_attach_same_conn_gen_later_wins_earlier_aborts() {
    let session = test_session();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;

    let fan = Arc::new(Mutex::new(FanState::new()));
    // 历史 > 1024(priority 通道容量)→ A 回放至背压挂起,给 B 的顶替留出确定性交错窗口。
    const N: usize = 1100;
    let mut expected = Vec::with_capacity(N);
    {
        let mut f = fan.lock().unwrap();
        for i in 0..N {
            let frame = encode_agent_event(&AgentEvent::AssistantDelta {
                text: format!("h{i}"),
            });
            expected.push(frame.clone());
            f.history.push(frame);
        }
    }

    // A 先启动:填满 1024 槽通道后在 send_async 背压挂起(current-thread 下 yield 驱动到位)。
    let (fan_a, client_a) = (fan.clone(), client.clone());
    let attach_a = tokio::spawn(async move { attach_client(&fan_a, &client_a).await });
    for _ in 0..64 {
        tokio::task::yield_now().await;
    }

    // B 随后启动(同 client 同 conn_gen,模拟 ws 步骤6 连接时 attach):登记更新代次顶替 A。
    let (fan_b, client_b) = (fan.clone(), client.clone());
    let attach_b = tokio::spawn(async move { attach_client(&fan_b, &client_b).await });
    for _ in 0..64 {
        tokio::task::yield_now().await;
    }

    // 受控排空:放行两路挂起的 send;A 在下一校验点发现被顶替 → abort,B 独占回放到完成。
    let drainer = tokio::spawn(async move {
        let mut got = Vec::new();
        while let Ok(Some(f)) =
            tokio::time::timeout(Duration::from_millis(200), priority_rx.recv()).await
        {
            got.push(f);
        }
        got
    });
    tokio::time::timeout(Duration::from_secs(5), attach_a)
        .await
        .expect("先启动的 A 应结束(被顶替 abort),不应 hang")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), attach_b)
        .await
        .expect("后启动的 B 应完成回放,不应 hang")
        .unwrap();
    let got = tokio::time::timeout(Duration::from_secs(5), drainer)
        .await
        .expect("drainer 不应 hang")
        .unwrap();

    // ① A 中途停发:总帧数必须 < 2N(无互斥的旧实现两路各发整份 → 恰 2N,整段前缀重复)。
    assert!(
        got.len() < 2 * N,
        "wire 不得出现两份完整 history(收 {} 帧,2N = {})",
        got.len(),
        2 * N
    );
    // ② 尾部 N 帧 = 独占那路(B)的完整有序回放:A 被顶替后不再插帧,重复范围止于其已发前缀。
    assert!(
        got.len() >= N,
        "至少应有一份完整 history({} < {})",
        got.len(),
        N
    );
    assert_eq!(
        &got[got.len() - N..],
        &expected[..],
        "尾部 N 帧应为独占 attach 的完整有序回放(旧实现两路交错,此断言失败)"
    );
    // ③ 收敛终态:B 以当前 conn_gen 登记 attached;in-flight 代次表无残留
    //   (B 完成时清自己的登记,A 被顶替 abort 时只清仍属自己的 → 互不误删)。
    {
        let f = fan.lock().unwrap();
        assert_eq!(
            f.attached.get("phone"),
            Some(&client.conn_gen()),
            "独占 attach 完成后应以当前 conn_gen 登记 attached"
        );
        assert!(
            f.attach_gen.is_empty(),
            "两路 attach 均已退出,attach_gen 不得残留条目"
        );
    }
}

/// 【顺序双 attach 幂等 · 先红后绿】升格补 attach 先完成、连接时 attach(ws 步骤6)后到的
/// **典型**时序(补 attach 在通道有容量时几乎瞬时完成,步骤6 晚几十 ms 才跑):同 client 同
/// conn_gen 已完成过一次完整 attach——历史已精确一次送达、live 帧由 fan-out 无缝接续——第二路
/// attach 必须 no-op。旧实现 BUG-1 起始 remove + 从头回放会把已送达前缀(MirrorStarted +
/// catch-up 几十帧)整段重发 → 手机重复气泡(assistantDelta 不幂等)。
#[tokio::test]
async fn second_attach_same_conn_gen_after_completion_is_noop() {
    let session = test_session();
    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    let fan = Arc::new(Mutex::new(FanState::new()));

    // 升格瞬间:history 仅 MirrorStarted 一帧;升格补 attach 完成(回放 1 帧 + 登记 attached)。
    let started = encode_agent_event(&AgentEvent::MirrorStarted);
    fan.lock().unwrap().history.push(started.clone());
    attach_client(&fan, &client).await;

    // claude --resume 的 catch-up 首批经 fan-out live 送达(client 已 attached)。
    let mut expected = vec![started];
    for i in 0..5 {
        let e = AgentEvent::AssistantDelta {
            text: format!("catchup{i}"),
        };
        expected.push(encode_agent_event(&e));
        fan_out_one(&fan, &session, &EventBus::new(), &e);
    }

    // 连接时 attach 后到(同 client 同 conn_gen):同一下行通道上历史已送达 → 必须 no-op。
    attach_client(&fan, &client).await;

    // no-op 不得把 client 从 attached 摘掉:之后的 live 帧仍应恰好一次送达。
    let e = AgentEvent::AssistantDelta {
        text: "live-after".into(),
    };
    expected.push(encode_agent_event(&e));
    fan_out_one(&fan, &session, &EventBus::new(), &e);

    let got = drain(&mut priority_rx);
    assert_eq!(
        got, expected,
        "第二路同代 attach 应 no-op:每帧恰一次,无整段前缀重放(旧实现重发 6 帧前缀)"
    );
    // no-op 路径不动任何状态:attached 仍是首次完成的登记,attach_gen 无残留。
    {
        let f = fan.lock().unwrap();
        assert_eq!(
            f.attached.get("phone"),
            Some(&client.conn_gen()),
            "no-op 不得摘除/改写首次 attach 的 attached 登记"
        );
        assert!(
            f.attach_gen.is_empty(),
            "no-op 路径不登记 in-flight 代次,不得残留"
        );
    }
}

/// 【in-flight 代次清理】attach 各退出路径后 `attach_gen` 无残留条目(防 map 泄漏):
/// ① 正常完成(插入 attached);② 掉线 abort(send_async 返回 false,不插 attached)。
/// 被顶替 abort / conn_gen abort 的清理分别由并发互斥用例与 manager_tests 的 BUG-2 用例锁定。
#[tokio::test]
async fn attach_gen_cleaned_on_completion_and_disconnect_abort() {
    let session = test_session();
    let fan = Arc::new(Mutex::new(FanState::new()));
    // 历史非空,使两条路径都真正走到回放/发送。
    fan.lock()
        .unwrap()
        .history
        .push(encode_agent_event(&AgentEvent::MirrorStarted));

    // ① 正常完成:回放 1 帧 + 登记 attached → attach_gen 清空。
    let (alive, rx) = attached_client(&session, "alive");
    let WsReceivers {
        mut priority_rx, ..
    } = rx;
    attach_client(&fan, &alive).await;
    {
        let f = fan.lock().unwrap();
        assert!(f.attached.contains_key("alive"), "完成路径应登记 attached");
        assert!(f.attach_gen.is_empty(), "完成路径退出后 attach_gen 应清空");
    }
    assert_eq!(drain(&mut priority_rx).len(), 1, "完成路径应回放 1 帧历史");

    // ② 掉线 abort:client 已断开 → 首帧 send_async 失败 → 不插 attached,attach_gen 同样清空。
    let (dead, _rx) = attached_client(&session, "dead");
    dead.disconnect();
    attach_client(&fan, &dead).await;
    {
        let f = fan.lock().unwrap();
        assert!(
            !f.attached.contains_key("dead"),
            "掉线 abort 不得登记 attached"
        );
        assert!(
            f.attach_gen.is_empty(),
            "掉线 abort 退出后 attach_gen 应清空"
        );
    }
}

/// 【M5 CRITICAL 镜像回归锁定】镜像 WS attach 路径的 attach + `flush_ring_buffer_async` 组合在
/// **priority 通道正好满**时不 disconnect、不截断。attach 背压回放 agent 历史可能把 1024 槽通道
/// 填到正好满,紧接着回放终端环形缓冲若退回非阻塞 `send`,首块就撞 `Full → disconnect()` + 截断 →
/// 大历史 / 慢 sink 下永久重连环(attach 背压化消灭的 Critical bug 的终端缓冲镜像版)。
///
/// 精确复现该时序:①预置 1024 帧 agent 历史(= PRIORITY_SEND_CHANNEL_SIZE),`attach` 无需 drainer
/// 即把通道灌到**恰好满**、client 仍 connected;②随后才起 drainer(生产序里 writer 先行,这里刻意
/// 延后以保证 flush 首块发送时通道仍满);③`flush_ring_buffer_async` 首块 `send_async` 撞满 → 背压
/// 挂起等 drainer 排空 → 全部送达。若 flush 退回非阻塞 `send`,②的满通道会让首块 Full → disconnect,
/// `client.is_connected()` 断言即失败(故非永真自证)。
/// 断言:attach+flush 后 ①client 仍 connected;②收全 1024 agent 帧(有序);③终端环形缓冲完整回放
/// (RIS + 全部内容,跨多个 4096 分片)、无截断。
#[tokio::test]
async fn mirror_attach_then_flush_async_backpressures_on_full_channel_no_disconnect_or_truncation()
{
    // 大环形缓冲(16384)以产生多个 4096 分片,验证跨片无截断(test_session 的 4096 只出 1 片)。
    let session = {
        let config = SessionConfig {
            session_ttl: Duration::from_secs(300),
            reconnect_grace: Duration::from_secs(60),
            ring_buffer_size: 16384,
            log_dir: String::new(),
        };
        Arc::new(Session::new(
            "mirror-bp-session".into(),
            config,
            EventBus::new(),
        ))
    };
    // 终端历史:12000 字节(纯 'X',无转义序列 → 模式重放序列为空),flush 产出 3 个 MSG_OUTPUT 片。
    let term_content = vec![b'X'; 12000];
    session.append_to_ring_buffer(&term_content);

    let (client, rx) = attached_client(&session, "phone");
    let WsReceivers { priority_rx, .. } = rx;

    // Mirror entry:预置 1024 帧 agent 历史(= priority 通道容量),attach 后通道恰好满。
    const CH_CAP: usize = 1024; // = PRIORITY_SEND_CHANNEL_SIZE
    let entry = test_mirror_entry();
    let mut agent_expected = Vec::with_capacity(CH_CAP);
    {
        let mut f = entry.fan.lock().unwrap();
        for i in 0..CH_CAP {
            let frame = encode_agent_event(&AgentEvent::AssistantDelta {
                text: format!("a{i}"),
            });
            agent_expected.push(frame.clone());
            f.history.push(frame);
        }
    }

    // ① attach:1024 帧 send_async 恰好灌满通道(容量 1024,无 drainer 也不阻塞),client 仍连。
    entry.attach(&client).await;
    assert!(
        client.is_connected(),
        "attach 恰好灌满通道后 client 应仍 connected"
    );

    // ② 延后起 drainer:保证 flush 首块发送时通道仍满,背压挂起后由它排空(生产上是 writer)。
    let drainer = tokio::spawn(async move {
        let mut prx = priority_rx;
        let mut got = Vec::new();
        while let Some(frame) = prx.recv().await {
            got.push(frame);
        }
        got
    });

    // ③ 背压 flush 终端环形缓冲:满则等 drainer 排空,绝不 disconnect。
    session
        .flush_ring_buffer_async(&client, client.conn_gen())
        .await;

    // ① 未被 disconnect(非阻塞 flush 会在满通道首块 Full → disconnect)。
    assert!(
        client.is_connected(),
        "背压 flush 不应 disconnect client(非阻塞 flush 在满通道首块 Full → disconnect)"
    );

    // 收尾:disconnect 丢弃唯一 priority_tx → drainer recv 到 None 结束。
    client.disconnect();
    let got = tokio::time::timeout(Duration::from_secs(5), drainer)
        .await
        .expect("drainer 应在通道关闭后结束")
        .expect("drainer 任务不应 panic");

    // ② 收全 1024 agent 帧(0x50)且顺序一致。
    let agent_got: Vec<Vec<u8>> = got
        .iter()
        .filter(|f| f[0] == protocol::MSG_AGENT_EVENT)
        .cloned()
        .collect();
    assert_eq!(
        agent_got, agent_expected,
        "应完整收到全部 1024 agent 历史帧,无截断"
    );

    // ③ 终端环形缓冲完整回放、无截断:拼接所有 MSG_OUTPUT 片的 payload = RIS + 全部终端内容。
    let mut term_reassembled = Vec::new();
    for f in got.iter().filter(|f| f[0] == protocol::MSG_OUTPUT) {
        term_reassembled.extend_from_slice(&f[1..]);
    }
    let mut expected_term = Vec::new();
    expected_term.extend_from_slice(b"\x1bc"); // RIS(模式重放序列为空)
    expected_term.extend_from_slice(&term_content);
    assert_eq!(
        term_reassembled, expected_term,
        "终端环形缓冲应完整回放(RIS + 全部内容),不截断"
    );
}
