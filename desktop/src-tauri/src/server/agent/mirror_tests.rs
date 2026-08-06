//! `mirror.rs` 的单元测试(经 `#[path]` 挂为 `mirror` 的子模块,`use super::*` 可访问其私有项:
//! `TailerState` / `transcript_line_to_events` / `truncate_display_text` / `parse_persisted_path` 等)。
//!
//! fixture 行为**合成但形状逼真**(照 mirror-r2 实证的信封 + message 结构手写),不含真实隐私内容。

use super::*;
use serde_json::json;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

// ── fixture 构造器(信封字段照实证形状,内容合成)──

/// 造一条 assistant 行:公共信封 + `.message`(content 恒单 block,块级落盘实证)。
fn assistant_line(
    uuid: &str,
    msg_id: &str,
    stop_reason: &str,
    block: serde_json::Value,
) -> serde_json::Value {
    json!({
        "uuid": uuid, "parentUuid": null, "timestamp": "2026-07-09T00:00:00.000Z",
        "sessionId": "sess-1", "cwd": "/tmp/proj", "gitBranch": "main", "version": "2.1.202",
        "isSidechain": false, "userType": "external", "type": "assistant", "requestId": "req_1",
        "message": {
            "id": msg_id, "model": "claude-opus-4-8", "stop_reason": stop_reason,
            "usage": {"input_tokens": 3, "output_tokens": 5},
            "content": [block]
        }
    })
}

/// 造一条用户原文行(content 为 string)。
fn user_string_line(uuid: &str, text: &str) -> serde_json::Value {
    json!({
        "uuid": uuid, "parentUuid": null, "timestamp": "2026-07-09T00:00:01.000Z",
        "sessionId": "sess-1", "cwd": "/tmp/proj", "version": "2.1.202",
        "isSidechain": false, "userType": "external", "type": "user",
        "promptId": "p1", "promptSource": "typed", "origin": {"kind": "human"},
        "message": {"role": "user", "content": text}
    })
}

/// 造一条 user 行(content 为 block 数组;可选行级 `.toolUseResult`)。
fn user_array_line(
    uuid: &str,
    blocks: serde_json::Value,
    tool_use_result: Option<serde_json::Value>,
) -> serde_json::Value {
    let mut line = json!({
        "uuid": uuid, "parentUuid": "u-prev", "timestamp": "2026-07-09T00:00:02.000Z",
        "sessionId": "sess-1", "cwd": "/tmp/proj", "version": "2.1.202",
        "isSidechain": false, "userType": "external", "type": "user",
        "message": {"role": "user", "content": blocks}
    });
    if let Some(tur) = tool_use_result {
        line["toolUseResult"] = tur;
    }
    line
}

/// 单 text block 的 ToolCallUpdate content 期望值。
fn text_content(text: &str) -> serde_json::Value {
    json!([{"type": "text", "text": text}])
}
#[path = "mirror_mapping_tests.rs"]
mod mapping_tests;
// ── tailer 集成(真实临时文件)──

static NEXT_TMP_ID: AtomicU64 = AtomicU64::new(0);

/// 唯一临时文件路径守卫(Drop 时删除,panic 也不残留)。
struct TempFile(PathBuf);
impl TempFile {
    fn new(tag: &str) -> Self {
        Self(std::env::temp_dir().join(format!(
            "meterm-mirror-m4-{}-{}-{}.jsonl",
            std::process::id(),
            tag,
            NEXT_TMP_ID.fetch_add(1, Ordering::Relaxed)
        )))
    }
}
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// 追加原始字节(create+append,模拟 claude 落盘)。
fn append_bytes(path: &Path, data: &[u8]) {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    f.write_all(data).unwrap();
    f.flush().unwrap();
}

fn append_line(path: &Path, line: &serde_json::Value) {
    let mut bytes = serde_json::to_vec(line).unwrap();
    bytes.push(b'\n');
    append_bytes(path, &bytes);
}

/// 带超时收一条**内容**事件(5s 足够覆盖轮询间隔抖动)。
/// fix7:AgentMeta 是旁路元信息(首个 assistant 行会先发一条 model),与内容测试
/// 无关 → 静默跳过;meta 行为由专项测试 `agent_meta_emitted_on_model_change` 锁定。
async fn recv_ev(rx: &mut mpsc::UnboundedReceiver<AgentEvent>) -> AgentEvent {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let ev = rx.recv().await.expect("事件通道不应关闭");
            if matches!(ev, AgentEvent::AgentMeta { .. }) {
                continue;
            }
            return ev;
        }
    })
    .await
    .expect("等事件超时")
}

/// 断言一段时间内不来**内容**事件(通道也不许关闭;旁路 AgentMeta 忽略)。
async fn assert_no_event(rx: &mut mpsc::UnboundedReceiver<AgentEvent>, ms: u64) {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(ms);
    loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Err(_) => return,                                   // 超时 = 没内容事件,符合预期
            Ok(Some(AgentEvent::AgentMeta { .. })) => continue, // 旁路元信息,不算
            Ok(Some(ev)) => panic!("不应有事件,却收到 {:?}", ev),
            Ok(None) => panic!("事件通道不应关闭"),
        }
    }
}

#[tokio::test]
async fn tailer_tails_appends_and_handles_partial_lines() {
    let tmp = TempFile::new("partial");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let _handle = spawn_transcript_tailer_with_interval(
        tmp.0.clone(),
        tx,
        cancel.clone(),
        Duration::from_millis(25),
    );

    // 第一次追加:完整 line1 + line2 的前半(故意切在行中,不带 \n)。
    let line1 = user_string_line("t1", "第一条");
    let line2 = assistant_line(
        "t2",
        "msg_40",
        "tool_use",
        json!({"type": "text", "text": "镜像文本OK"}),
    );
    let mut bytes1 = serde_json::to_vec(&line1).unwrap();
    bytes1.push(b'\n');
    let bytes2 = {
        let mut b = serde_json::to_vec(&line2).unwrap();
        b.push(b'\n');
        b
    };
    let split_at = bytes2.len() / 2;
    let mut first_write = bytes1;
    first_write.extend_from_slice(&bytes2[..split_at]);
    append_bytes(&tmp.0, &first_write);

    // line1 事件到达;半截 line2 不裂不丢(暂无第二事件)。
    assert_eq!(
        recv_ev(&mut rx).await,
        AgentEvent::Ext {
            raw: json!({"kind": "user", "text": "第一条"})
        }
    );
    assert_no_event(&mut rx, 120).await;

    // 第二次追加:补全 line2 → 完整解析。
    append_bytes(&tmp.0, &bytes2[split_at..]);
    assert_eq!(
        recv_ev(&mut rx).await,
        AgentEvent::AssistantDelta {
            text: "镜像文本OK".into()
        }
    );

    cancel.cancel();
}

#[tokio::test]
async fn tailer_tolerates_missing_file_until_created() {
    let tmp = TempFile::new("missing");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let _handle = spawn_transcript_tailer_with_interval(
        tmp.0.clone(),
        tx,
        cancel.clone(),
        Duration::from_millis(25),
    );

    // 文件尚不存在:静静等待,不出事件、不关通道。
    assert_no_event(&mut rx, 100).await;

    // 稍后创建写入 → 事件到达。
    append_line(&tmp.0, &user_string_line("m1", "迟到的文件"));
    assert_eq!(
        recv_ev(&mut rx).await,
        AgentEvent::Ext {
            raw: json!({"kind": "user", "text": "迟到的文件"})
        }
    );

    cancel.cancel();
}

#[tokio::test]
async fn tailer_cancel_exits_and_closes_event_channel() {
    let tmp = TempFile::new("cancel");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let _handle = spawn_transcript_tailer_with_interval(
        tmp.0.clone(),
        tx,
        cancel.clone(),
        Duration::from_millis(25),
    );

    cancel.cancel();
    // task 退出 → drop event_tx → event_rx 关闭(recv 返回 None)。
    let closed = tokio::time::timeout(Duration::from_secs(2), rx.recv())
        .await
        .expect("cancel 后应尽快关闭");
    assert_eq!(closed, None);
}

#[tokio::test]
async fn poke_catch_up_triggers_immediate_read() {
    let tmp = TempFile::new("poke");
    append_bytes(&tmp.0, b""); // 先建空文件,避免首 tick 的 missing 分支干扰
    let (tx, mut rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    // interval 长到测试期内不可能 tick(首 tick 立即触发,先让它消化掉)。
    let handle = spawn_transcript_tailer_with_interval(
        tmp.0.clone(),
        tx,
        cancel.clone(),
        Duration::from_secs(3600),
    );
    tokio::time::sleep(Duration::from_millis(150)).await;

    append_line(&tmp.0, &user_string_line("k1", "不等 tick"));
    // 不 poke:长 interval 下不会自己读到。
    assert_no_event(&mut rx, 150).await;
    // poke:立即 catch-up。
    handle.poke_catch_up();
    assert_eq!(
        recv_ev(&mut rx).await,
        AgentEvent::Ext {
            raw: json!({"kind": "user", "text": "不等 tick"})
        }
    );

    cancel.cancel();
}

#[tokio::test]
async fn poke_turn_end_fallback_emits_once() {
    let tmp = TempFile::new("turnend");
    append_bytes(&tmp.0, b"");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let handle = spawn_transcript_tailer_with_interval(
        tmp.0.clone(),
        tx,
        cancel.clone(),
        Duration::from_secs(3600),
    );
    tokio::time::sleep(Duration::from_millis(150)).await;

    // assistant 内容行 stop_reason=tool_use:不触发正常 TurnComplete,轮保持 open。
    append_line(
        &tmp.0,
        &assistant_line(
            "n1",
            "msg_50",
            "tool_use",
            json!({"type": "text", "text": "被打断的回复"}),
        ),
    );
    // poke_turn_end 自带 catch-up:先收内容事件,再收兜底 TurnComplete{None}。
    handle.poke_turn_end();
    assert_eq!(
        recv_ev(&mut rx).await,
        AgentEvent::AssistantDelta {
            text: "被打断的回复".into()
        }
    );
    assert_eq!(
        recv_ev(&mut rx).await,
        AgentEvent::TurnComplete { stop_reason: None }
    );

    // 紧接着再 poke 一次:轮已关,不再多发。
    handle.poke_turn_end();
    assert_no_event(&mut rx, 200).await;

    cancel.cancel();
}

/// fix7(statusline 元信息,tailer 集成):首个 assistant 行发全字段 AgentMeta
/// (model/context/branch/cwd 首见);同值后续行不重发;model 变化只带 model 再发。
/// 直收原始事件流(不经 recv_ev 的 meta 过滤)。
#[tokio::test]
async fn agent_meta_emitted_on_model_change() {
    let tmp = TempFile::new("meta-model");
    append_bytes(&tmp.0, b"");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let handle = spawn_transcript_tailer_with_interval(
        tmp.0.clone(),
        tx,
        cancel.clone(),
        Duration::from_secs(3600),
    );
    tokio::time::sleep(Duration::from_millis(150)).await;

    // 首个 assistant 行(助手固定 model=claude-opus-4-8 / usage 3+5 / main / /tmp/proj)
    // → 先 AgentMeta(全首见字段;context=input 3,fixture 无 cache 字段)后内容。
    append_line(
        &tmp.0,
        &assistant_line(
            "mm1",
            "msg_a",
            "end_turn",
            json!({"type": "text", "text": "一"}),
        ),
    );
    handle.poke_catch_up();
    let raw = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        raw,
        AgentEvent::AgentMeta {
            model: Some("claude-opus-4-8".into()),
            effort: None,
            context_tokens: Some(3),
            git_branch: Some("main".into()),
            cwd: Some("/tmp/proj".into()),
        },
        "首个 assistant 行须先发全首见字段的 AgentMeta"
    );
    assert_eq!(
        recv_ev(&mut rx).await,
        AgentEvent::AssistantDelta { text: "一".into() }
    );
    assert_eq!(
        recv_ev(&mut rx).await,
        AgentEvent::TurnComplete {
            stop_reason: Some("end_turn".into())
        }
    );

    // 全同值第二行:不重发 meta(直收验证第一个就是内容)。
    append_line(
        &tmp.0,
        &assistant_line(
            "mm2",
            "msg_b",
            "end_turn",
            json!({"type": "text", "text": "二"}),
        ),
    );
    handle.poke_catch_up();
    let raw = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        raw,
        AgentEvent::AssistantDelta { text: "二".into() },
        "全字段同值不得重发 AgentMeta"
    );
    assert_eq!(
        recv_ev(&mut rx).await,
        AgentEvent::TurnComplete {
            stop_reason: Some("end_turn".into())
        }
    );

    // model 变化(/model 切换后的新行)→ 只带 model 再发一次(其余字段未变 → None)。
    let mut switched = assistant_line(
        "mm3",
        "msg_c",
        "end_turn",
        json!({"type": "text", "text": "三"}),
    );
    switched["message"]["model"] = json!("claude-sonnet-5");
    append_line(&tmp.0, &switched);
    handle.poke_catch_up();
    let raw = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        raw,
        AgentEvent::AgentMeta {
            model: Some("claude-sonnet-5".into()),
            effort: None,
            context_tokens: None,
            git_branch: None,
            cwd: None,
        },
        "model 变化须只带 model 再发 AgentMeta"
    );

    cancel.cancel();
}

/// fix7:TranscriptMeta 纯 diff 逻辑——usage 求和口径(input+cache_read+cache_creation)、
/// 单字段变化只带该字段、cwd/branch 在 user 行也生效、sidechain 跳过、全零 usage 不更新。
#[test]
fn transcript_meta_diff_fields_independently() {
    let mut meta = TranscriptMeta::default();

    // 首个 assistant 行:全字段首见(usage 含 cache 字段 → 求和口径)。
    let mut a1 = assistant_line(
        "d1",
        "msg_1",
        "end_turn",
        json!({"type": "text", "text": "x"}),
    );
    a1["message"]["usage"] = json!({
        "input_tokens": 10, "cache_read_input_tokens": 40000,
        "cache_creation_input_tokens": 3000, "output_tokens": 500
    });
    assert_eq!(
        meta.diff_line(&a1),
        Some(AgentEvent::AgentMeta {
            model: Some("claude-opus-4-8".into()),
            effort: None,
            context_tokens: Some(43010),
            git_branch: Some("main".into()),
            cwd: Some("/tmp/proj".into()),
        }),
        "context = input + cache_read + cache_creation(不含 output)"
    );

    // 同值重复行 → None。
    assert_eq!(meta.diff_line(&a1), None, "全字段同值不得产出");

    // user 行换 cwd(cd 后):只带 cwd。
    let mut u1 = user_string_line("d2", "继续");
    u1["cwd"] = json!("/tmp/proj/sub");
    assert_eq!(
        meta.diff_line(&u1),
        Some(AgentEvent::AgentMeta {
            model: None,
            effort: None,
            context_tokens: None,
            git_branch: None,
            cwd: Some("/tmp/proj/sub".into()),
        }),
        "user 行的 cwd 变化也须生效(信封字段)"
    );

    // sidechain 行(子代理):整行跳过,即使字段有变化。
    let mut side = assistant_line(
        "d3",
        "msg_2",
        "end_turn",
        json!({"type": "text", "text": "y"}),
    );
    side["isSidechain"] = json!(true);
    side["message"]["model"] = json!("claude-haiku-4-5");
    assert_eq!(
        meta.diff_line(&side),
        None,
        "sidechain 行不得影响主会话 meta"
    );

    // 全零/缺失 usage:context 不更新(半截 usage 不如上一个真值)。
    let mut a2 = assistant_line(
        "d4",
        "msg_3",
        "end_turn",
        json!({"type": "text", "text": "z"}),
    );
    a2["message"]["usage"] = json!({"input_tokens": 0, "output_tokens": 0});
    a2["cwd"] = json!("/tmp/proj/sub"); // 与当前值相同,不触发
    assert_eq!(
        meta.diff_line(&a2),
        None,
        "全零 usage 不得把 context 打回 0"
    );
}

/// fix9:gitBranch 的 "HEAD" 哨兵值(无 git 仓库 / detached)按缺失处理——
/// 不下发、不覆盖已有真分支值。
#[test]
fn transcript_meta_ignores_head_branch_sentinel() {
    let mut meta = TranscriptMeta::default();
    // 无 git 仓库的行:gitBranch="HEAD" → 只应产出 cwd,branch 不下发。
    let mut u1 = user_string_line("h1", "hi");
    u1["gitBranch"] = json!("HEAD");
    u1["cwd"] = json!("/tmp/nogit");
    assert_eq!(
        meta.diff_line(&u1),
        Some(AgentEvent::AgentMeta {
            model: None,
            effort: None,
            context_tokens: None,
            git_branch: None,
            cwd: Some("/tmp/nogit".into()),
        }),
        "HEAD 哨兵不得下发为分支"
    );
    // 真分支出现后,后续 HEAD 行也不得覆盖它。
    let mut u2 = user_string_line("h2", "hi2");
    u2["gitBranch"] = json!("main");
    u2["cwd"] = json!("/tmp/nogit");
    assert!(matches!(
        meta.diff_line(&u2),
        Some(AgentEvent::AgentMeta { git_branch: Some(ref b), .. }) if b == "main"
    ));
    let mut u3 = user_string_line("h3", "hi3");
    u3["gitBranch"] = json!("HEAD");
    u3["cwd"] = json!("/tmp/nogit");
    assert_eq!(
        meta.diff_line(&u3),
        None,
        "HEAD 不得覆盖真分支(也不触发变化)"
    );
}

/// fix4(对话实时展示):mark_live_assistant 后,本轮 transcript 的 assistant text 块
/// **跳过不发**(正文已由 MessageDisplay hook 实时下行,防双份);thinking 不受影响;
/// 正常 end_turn 的 TurnComplete 照发并**复位**标记——下一轮(hook 失联)text 照发兜底。
#[tokio::test]
async fn live_assistant_skips_transcript_text_until_turn_end() {
    let tmp = TempFile::new("live");
    append_bytes(&tmp.0, b"");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let handle = spawn_transcript_tailer_with_interval(
        tmp.0.clone(),
        tx,
        cancel.clone(),
        Duration::from_secs(3600),
    );
    tokio::time::sleep(Duration::from_millis(150)).await;

    // MessageDisplay hook 已把本轮正文实时下行(经 event_tx 直投,不走 tailer)。
    handle.mark_live_assistant();
    // 轮末 transcript 落盘:thinking + text(同 msg end_turn)。
    append_line(
        &tmp.0,
        &assistant_line(
            "lv1",
            "msg_90",
            "tool_use",
            json!({"type": "thinking", "thinking": "推理内容", "signature": "s"}),
        ),
    );
    append_line(
        &tmp.0,
        &assistant_line(
            "lv2",
            "msg_90",
            "end_turn",
            json!({"type": "text", "text": "已由 hook 流出的正文"}),
        ),
    );
    handle.poke_catch_up();

    // thinking 照发;text 被跳过;TurnComplete(end_turn)照发。
    assert_eq!(
        recv_ev(&mut rx).await,
        AgentEvent::ReasoningDelta {
            text: "推理内容".into()
        }
    );
    assert_eq!(
        recv_ev(&mut rx).await,
        AgentEvent::TurnComplete {
            stop_reason: Some("end_turn".into())
        },
        "text 块须被跳过,下一事件应直接是 TurnComplete"
    );

    // 轮结束已复位:下一轮 hook 失联(无 mark),transcript 全文照发(兜底)。
    append_line(
        &tmp.0,
        &assistant_line(
            "lv3",
            "msg_91",
            "end_turn",
            json!({"type": "text", "text": "hook 失联轮的正文"}),
        ),
    );
    handle.poke_catch_up();
    assert_eq!(
        recv_ev(&mut rx).await,
        AgentEvent::AssistantDelta {
            text: "hook 失联轮的正文".into()
        }
    );
    assert_eq!(
        recv_ev(&mut rx).await,
        AgentEvent::TurnComplete {
            stop_reason: Some("end_turn".into())
        }
    );

    cancel.cancel();
}

/// fix4 × 兜底轮末:live 轮 transcript 缺 end_turn(Esc 打断),Stop hook 的
/// poke_turn_end 仍须补 TurnComplete(mark 置 turn_open,即使全部 text 被跳过),
/// 并同样复位 live 标记。
#[tokio::test]
async fn live_assistant_turn_end_fallback_still_fires() {
    let tmp = TempFile::new("live-fallback");
    append_bytes(&tmp.0, b"");
    let (tx, mut rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let handle = spawn_transcript_tailer_with_interval(
        tmp.0.clone(),
        tx,
        cancel.clone(),
        Duration::from_secs(3600),
    );
    tokio::time::sleep(Duration::from_millis(150)).await;

    handle.mark_live_assistant();
    // 本轮 transcript 只有被跳过的 text(stop_reason=tool_use,无轮终止信号)。
    append_line(
        &tmp.0,
        &assistant_line(
            "lf1",
            "msg_92",
            "tool_use",
            json!({"type": "text", "text": "被打断的正文"}),
        ),
    );
    handle.poke_turn_end();
    // text 被跳过,但 mark 已开轮 → 兜底 TurnComplete{None} 必须到(否则手机气泡永远 streaming)。
    assert_eq!(
        recv_ev(&mut rx).await,
        AgentEvent::TurnComplete { stop_reason: None }
    );

    // 复位验证:下一轮无 mark,text 照发。
    append_line(
        &tmp.0,
        &assistant_line(
            "lf2",
            "msg_93",
            "end_turn",
            json!({"type": "text", "text": "下一轮正文"}),
        ),
    );
    handle.poke_catch_up();
    assert_eq!(
        recv_ev(&mut rx).await,
        AgentEvent::AssistantDelta {
            text: "下一轮正文".into()
        }
    );

    cancel.cancel();
}

#[tokio::test]
async fn persisted_output_pointer_read_truncated_and_missing_kept() {
    let tmp = TempFile::new("pointer");
    // 指针目标文件:9000 字节,超 8192 上限 → 读入后须截断。
    let target = TempFile::new("pointer-target");
    std::fs::write(&target.0, "x".repeat(9000)).unwrap();
    let pointer_text = format!(
        "<persisted-output>\nOutput too large (8.8KB). Full output saved to: {}",
        target.0.display()
    );
    // 指向不存在路径的指针:保留原文。
    let missing_path = std::env::temp_dir().join("meterm-mirror-m4-definitely-missing.txt");
    let missing_text = format!(
        "<persisted-output>\nOutput too large (1KB). Full output saved to: {}",
        missing_path.display()
    );
    append_line(
        &tmp.0,
        &user_array_line(
            "p1",
            json!([{"type": "tool_result", "tool_use_id": "tp1", "content": pointer_text}]),
            None,
        ),
    );
    append_line(
        &tmp.0,
        &user_array_line(
            "p2",
            json!([{"type": "tool_result", "tool_use_id": "tp2", "content": missing_text}]),
            None,
        ),
    );

    let (tx, mut rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let _handle = spawn_transcript_tailer_with_interval(
        tmp.0.clone(),
        tx,
        cancel.clone(),
        Duration::from_millis(25),
    );

    // 第一条:指针被解引用,文件内容读入并截断。
    match recv_ev(&mut rx).await {
        AgentEvent::ToolCallUpdate { id, content, .. } => {
            assert_eq!(id, "tp1");
            let expect = format!("{}{}", "x".repeat(8192), TRUNCATION_NOTICE);
            assert_eq!(content.unwrap(), text_content(&expect));
        }
        other => panic!("期望 ToolCallUpdate,得到 {:?}", other),
    }
    // 第二条:目标不存在 → 保留指针原文。
    match recv_ev(&mut rx).await {
        AgentEvent::ToolCallUpdate { id, content, .. } => {
            assert_eq!(id, "tp2");
            assert_eq!(content.unwrap(), text_content(&missing_text));
        }
        other => panic!("期望 ToolCallUpdate,得到 {:?}", other),
    }

    cancel.cancel();
}

/// 唯一临时目录守卫(Drop 时整树删除,panic 也不残留)。
struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "meterm-mirror-m4-{}-{}-{}",
            std::process::id(),
            tag,
            NEXT_TMP_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 构造一条内容为 persisted-output 指针的 tool_result 行。
fn pointer_line(uuid: &str, tool_id: &str, target: &str) -> (serde_json::Value, String) {
    let text = format!(
        "<persisted-output>\nOutput too large (100KB). Full output saved to: {}",
        target
    );
    let line = user_array_line(
        uuid,
        json!([{"type": "tool_result", "tool_use_id": tool_id, "content": text}]),
        None,
    );
    (line, text)
}

#[tokio::test]
async fn persisted_pointer_confined_to_transcript_dir_subtree() {
    // 安全收紧回归:指针路径可被外部内容影响(恶意脚本 stdout 伪造 saved to: 行),
    // 只允许读 transcript 父目录子树内的文件;目录外 / 含 `..` 的路径一律不读,保留指针原文。
    // 目录形状照实证:transcript 在 <root>/session.jsonl,合法外置输出在
    // <root>/<sessionId>/tool-results/*.txt。
    let root = TempDir::new("confine");
    let transcript = root.0.join("session.jsonl");
    // ① 合法:tool-results 子树内 → 正常读入替换。
    let tool_results = root.0.join("sess-1").join("tool-results");
    std::fs::create_dir_all(&tool_results).unwrap();
    let ok_target = tool_results.join("ok.txt");
    std::fs::write(&ok_target, "合法外置输出").unwrap();
    // ② 越界:root 之外的既存敏感文件(模拟诱导读 ~/.ssh/id_rsa 型攻击)→ 不读。
    let outside = TempDir::new("confine-outside");
    let secret = outside.0.join("secret.txt");
    std::fs::write(&secret, "机密内容绝不该进镜像流").unwrap();
    // ③ 含 `..`:字面前缀在 root 内但组件级穿越到 ② 的目录 → 组件检查拒绝,不读。
    let dotdot = format!(
        "{}/sess-1/tool-results/../../../{}/secret.txt",
        root.0.display(),
        outside.0.file_name().unwrap().to_string_lossy()
    );
    let (l1, _) = pointer_line("cf1", "tc1", &ok_target.display().to_string());
    let (l2, outside_text) = pointer_line("cf2", "tc2", &secret.display().to_string());
    let (l3, dotdot_text) = pointer_line("cf3", "tc3", &dotdot);
    for l in [&l1, &l2, &l3] {
        append_line(&transcript, l);
    }

    let (tx, mut rx) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let _handle = spawn_transcript_tailer_with_interval(
        transcript.clone(),
        tx,
        cancel.clone(),
        Duration::from_millis(25),
    );

    // ① 子树内合法路径:照常解引用。
    match recv_ev(&mut rx).await {
        AgentEvent::ToolCallUpdate { id, content, .. } => {
            assert_eq!(id, "tc1");
            assert_eq!(content.unwrap(), text_content("合法外置输出"));
        }
        other => panic!("期望 ToolCallUpdate,得到 {:?}", other),
    }
    // ② 目录外绝对路径:不读,保留指针原文(文件内容绝不外泄进事件流)。
    match recv_ev(&mut rx).await {
        AgentEvent::ToolCallUpdate { id, content, .. } => {
            assert_eq!(id, "tc2");
            assert_eq!(
                content.unwrap(),
                text_content(&outside_text),
                "越界路径不得被读入"
            );
        }
        other => panic!("期望 ToolCallUpdate,得到 {:?}", other),
    }
    // ③ 含 .. 的路径:即使 Path::starts_with 字面命中也拒绝。
    match recv_ev(&mut rx).await {
        AgentEvent::ToolCallUpdate { id, content, .. } => {
            assert_eq!(id, "tc3");
            assert_eq!(
                content.unwrap(),
                text_content(&dotdot_text),
                "含 .. 的路径不得被读入"
            );
        }
        other => panic!("期望 ToolCallUpdate,得到 {:?}", other),
    }

    cancel.cancel();
}
