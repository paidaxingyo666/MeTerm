//! `mirror.rs` 的纯映射、截断、路径解析与批处理状态机测试。
//!
//! 作为 `mirror_tests` 的子模块挂载，共享其合成 fixture，并继续访问 `mirror` 私有实现。

use super::*;

// ── 纯映射:assistant 行 ──

#[test]
fn assistant_text_maps_to_assistant_delta() {
    let line = assistant_line(
        "u1",
        "msg_01",
        "tool_use",
        json!({"type": "text", "text": "你好,镜像"}),
    );
    let out = transcript_line_to_events(&line);
    assert_eq!(
        out.events,
        vec![AgentEvent::AssistantDelta {
            text: "你好,镜像".into()
        }]
    );
    // stop_reason=tool_use 不置 turn_end。
    assert_eq!(out.turn_end, None);
}

#[test]
fn assistant_thinking_maps_to_reasoning_delta() {
    let line = assistant_line(
        "u2",
        "msg_01",
        "tool_use",
        json!({"type": "thinking", "thinking": "先看文件", "signature": "sig=="}),
    );
    let out = transcript_line_to_events(&line);
    assert_eq!(
        out.events,
        vec![AgentEvent::ReasoningDelta {
            text: "先看文件".into()
        }]
    );
}

#[test]
fn empty_thinking_block_emits_no_reasoning_delta() {
    // 实证:claude 的 thinking block 常只落 signature、明文 thinking 为空串
    //(extended thinking 加密不写 transcript)。空 thinking 必须跳过,否则镜像
    // AI 页每轮冒一个空"思考过程"气泡。
    let line = assistant_line(
        "u2b",
        "msg_01b",
        "tool_use",
        json!({"type": "thinking", "thinking": "", "signature": "sig=="}),
    );
    let out = transcript_line_to_events(&line);
    assert!(out.events.is_empty(), "空 thinking 不应产生任何事件");
}

#[test]
fn assistant_tool_use_maps_to_tool_call_start() {
    let line = assistant_line(
        "u3",
        "msg_02",
        "tool_use",
        json!({
            "type": "tool_use", "id": "toolu_01", "name": "Bash",
            "input": {"command": "ls -la"}, "caller": "assistant"
        }),
    );
    let out = transcript_line_to_events(&line);
    assert_eq!(
        out.events,
        vec![AgentEvent::ToolCallStart {
            id: "toolu_01".into(),
            title: "Bash".into(),
            kind: None,
            raw_input: json!({"command": "ls -la"}),
        }]
    );
    assert_eq!(out.turn_end, None);
}

#[test]
fn assistant_end_turn_and_stop_sequence_set_turn_end() {
    let line = assistant_line(
        "u4",
        "msg_03",
        "end_turn",
        json!({"type": "text", "text": "完成了"}),
    );
    let out = transcript_line_to_events(&line);
    assert_eq!(out.events.len(), 1, "内容事件照发");
    assert_eq!(out.turn_end, Some(("msg_03".into(), "end_turn".into())));

    let line2 = assistant_line(
        "u5",
        "msg_04",
        "stop_sequence",
        json!({"type": "text", "text": "x"}),
    );
    assert_eq!(
        transcript_line_to_events(&line2).turn_end,
        Some(("msg_04".into(), "stop_sequence".into()))
    );
}

#[test]
fn assistant_empty_content_skipped_but_turn_end_recorded() {
    // content 数组为空:无内容事件,但行级 stop_reason 判定仍生效。
    let line = json!({
        "uuid": "u6", "isSidechain": false, "type": "assistant",
        "message": {"id": "msg_05", "stop_reason": "end_turn", "content": []}
    });
    let out = transcript_line_to_events(&line);
    assert!(out.events.is_empty());
    assert_eq!(out.turn_end, Some(("msg_05".into(), "end_turn".into())));
}

#[test]
fn assistant_unknown_block_type_skipped() {
    let line = assistant_line(
        "u7",
        "msg_06",
        "tool_use",
        json!({"type": "server_tool_use", "foo": 1}),
    );
    let out = transcript_line_to_events(&line);
    assert!(out.events.is_empty(), "未知 block 型静默跳过,不发 Ext");
}

// ── 纯映射:tool_result ──

#[test]
fn tool_result_string_content_maps_completed_update() {
    let line = user_array_line(
        "u10",
        json!([{"type": "tool_result", "tool_use_id": "toolu_01", "content": "total 8\n-rw-r--r-- 1", "is_error": false}]),
        Some(json!({"stdout": "total 8\n-rw-r--r-- 1", "stderr": ""})),
    );
    let out = transcript_line_to_events(&line);
    assert_eq!(
        out.events,
        vec![AgentEvent::ToolCallUpdate {
            id: "toolu_01".into(),
            status: Some("completed".into()),
            content: Some(text_content("total 8\n-rw-r--r-- 1")),
            diff: None,
        }]
    );
}

#[test]
fn tool_result_array_content_joins_text_blocks() {
    let line = user_array_line(
        "u11",
        json!([{"type": "tool_result", "tool_use_id": "toolu_02",
                "content": [{"type": "text", "text": "第一段"}, {"type": "text", "text": "第二段"}]}]),
        None,
    );
    let out = transcript_line_to_events(&line);
    match &out.events[0] {
        AgentEvent::ToolCallUpdate {
            status, content, ..
        } => {
            assert_eq!(content.as_ref().unwrap(), &text_content("第一段第二段"));
            // 锁定缺省语义:is_error 缺省(非显式 false)→ status 必须是 completed。
            assert_eq!(
                status.as_deref(),
                Some("completed"),
                "is_error 缺省应判 completed"
            );
        }
        other => panic!("期望 ToolCallUpdate,得到 {:?}", other),
    }
}

#[test]
fn tool_result_is_error_maps_failed() {
    let line = user_array_line(
        "u12",
        json!([{"type": "tool_result", "tool_use_id": "toolu_03", "content": "command not found", "is_error": true}]),
        None,
    );
    match &transcript_line_to_events(&line).events[0] {
        AgentEvent::ToolCallUpdate { status, .. } => assert_eq!(status.as_deref(), Some("failed")),
        other => panic!("期望 ToolCallUpdate,得到 {:?}", other),
    }
}

#[test]
fn tool_result_missing_content_falls_back_to_tool_use_result() {
    // ① toolUseResult 为 string → 直接用。
    let l1 = user_array_line(
        "u13",
        json!([{"type": "tool_result", "tool_use_id": "t1"}]),
        Some(json!("纯字符串结果")),
    );
    match &transcript_line_to_events(&l1).events[0] {
        AgentEvent::ToolCallUpdate { content, .. } => {
            assert_eq!(content.as_ref().unwrap(), &text_content("纯字符串结果"))
        }
        other => panic!("期望 ToolCallUpdate,得到 {:?}", other),
    }
    // ② content 为空串(视同缺失)、toolUseResult 为 object → 优先取 .stdout string。
    let l2 = user_array_line(
        "u14",
        json!([{"type": "tool_result", "tool_use_id": "t2", "content": ""}]),
        Some(json!({"stdout": "标准输出内容", "stderr": "", "interrupted": false})),
    );
    match &transcript_line_to_events(&l2).events[0] {
        AgentEvent::ToolCallUpdate { content, .. } => {
            assert_eq!(content.as_ref().unwrap(), &text_content("标准输出内容"))
        }
        other => panic!("期望 ToolCallUpdate,得到 {:?}", other),
    }
    // ③ object 无 stdout → 全对象 to_string。
    let obj = json!({"filenames": ["a.txt"], "durationMs": 12});
    let l3 = user_array_line(
        "u15",
        json!([{"type": "tool_result", "tool_use_id": "t3"}]),
        Some(obj.clone()),
    );
    match &transcript_line_to_events(&l3).events[0] {
        AgentEvent::ToolCallUpdate { content, .. } => assert_eq!(
            content.as_ref().unwrap(),
            &text_content(&serde_json::to_string(&obj).unwrap())
        ),
        other => panic!("期望 ToolCallUpdate,得到 {:?}", other),
    }
}

#[test]
fn tool_result_multiple_blocks_emit_one_update_each() {
    // 并行工具:一行两个 tool_result block → 两条 ToolCallUpdate,顺序与 block 序一致。
    let line = user_array_line(
        "u16",
        json!([
            {"type": "tool_result", "tool_use_id": "ta", "content": "A"},
            {"type": "tool_result", "tool_use_id": "tb", "content": "B"}
        ]),
        None,
    );
    let out = transcript_line_to_events(&line);
    assert_eq!(out.events.len(), 2);
    match (&out.events[0], &out.events[1]) {
        (AgentEvent::ToolCallUpdate { id: a, .. }, AgentEvent::ToolCallUpdate { id: b, .. }) => {
            assert_eq!(a, "ta");
            assert_eq!(b, "tb");
        }
        other => panic!("期望两条 ToolCallUpdate,得到 {:?}", other),
    }
}

// ── 纯映射:用户原文 ──

#[test]
fn user_string_maps_to_ext_frozen_contract() {
    let line = user_string_line("u20", "帮我看看这个文件");
    let out = transcript_line_to_events(&line);
    // 冻结契约:{"kind":"user","text":…},M8 手机端按此渲染 user 气泡。
    assert_eq!(
        out.events,
        vec![AgentEvent::Ext {
            raw: json!({"kind": "user", "text": "帮我看看这个文件"})
        }]
    );
    assert_eq!(out.turn_end, None);
}

#[test]
fn user_array_joins_text_blocks_ignores_image() {
    let line = user_array_line(
        "u21",
        json!([
            {"type": "text", "text": "看这张图"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}},
            {"type": "text", "text": ",帮我分析"}
        ]),
        None,
    );
    let out = transcript_line_to_events(&line);
    assert_eq!(
        out.events,
        vec![AgentEvent::Ext {
            raw: json!({"kind": "user", "text": "看这张图,帮我分析"})
        }]
    );
}

#[test]
fn user_array_without_text_skipped() {
    // 只有 image、无 text block → 拼接为空串 → 跳过。
    let line = user_array_line(
        "u22",
        json!([{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}]),
        None,
    );
    assert!(transcript_line_to_events(&line).events.is_empty());
}

#[test]
fn command_echo_lines_skipped() {
    // 斜杠命令回显(<command-*> / <local-command-*> 包裹)→ 整行跳过。
    let l1 = user_string_line(
        "u23",
        "<command-name>/model</command-name>\n<command-message>model</command-message>",
    );
    assert!(transcript_line_to_events(&l1).events.is_empty());
    let l2 = user_string_line(
        "u24",
        "<local-command-stdout>Set model to opus</local-command-stdout>",
    );
    assert!(transcript_line_to_events(&l2).events.is_empty());
}

#[test]
fn meta_user_line_skipped() {
    let mut line = user_string_line("u25", "Caveat: the messages below were generated…");
    line["isMeta"] = json!(true);
    assert!(transcript_line_to_events(&line).events.is_empty());
}

// ── 纯映射:信封级跳过 ──

#[test]
fn sidechain_line_skipped() {
    let mut line = assistant_line(
        "u26",
        "msg_07",
        "end_turn",
        json!({"type": "text", "text": "子代理输出"}),
    );
    line["isSidechain"] = json!(true);
    let out = transcript_line_to_events(&line);
    assert!(out.events.is_empty());
    assert_eq!(out.turn_end, None, "sidechain 行连 turn_end 也不产出");
}

#[test]
fn non_message_line_types_skipped() {
    let cases = vec![
        json!({"uuid": "s1", "type": "system", "subtype": "turn_duration", "durationMs": 1234, "isSidechain": false}),
        json!({"type": "ai-title", "aiTitle": "某个标题", "sessionId": "sess-1"}),
        json!({"uuid": "s2", "type": "file-history-snapshot", "messageId": "m", "snapshot": {}}),
        json!({"uuid": "s3", "type": "attachment", "attachment": {"type": "diagnostics"}, "isSidechain": false}),
        json!({"uuid": "s4", "type": "queue-operation", "operation": "enqueue", "content": "排队消息"}),
        json!({"uuid": "s5", "type": "totally-unknown-type", "foo": "bar"}),
        json!({"uuid": "s6", "no_type_field": true}),
    ];
    for line in &cases {
        let out = transcript_line_to_events(line);
        assert!(out.events.is_empty(), "应静默跳过: {}", line);
        assert_eq!(out.turn_end, None);
    }
}

// ── 截断纯函数 ──

#[test]
fn truncate_exact_limit_untouched() {
    let s = "12345678";
    assert_eq!(truncate_display_text(s, 8), "12345678", "恰好边界不截断");
    assert_eq!(truncate_display_text("短", 8), "短");
}

#[test]
fn truncate_over_limit_cuts_and_appends_notice() {
    let s = "123456789";
    assert_eq!(
        truncate_display_text(s, 8),
        format!("12345678{}", TRUNCATION_NOTICE)
    );
}

#[test]
fn truncate_respects_multibyte_char_boundary() {
    // "abc" (3B) + "汉汉汉汉" (各 3B) = 15B;limit=7 落在第二个"汉"中间 → 退到 6。
    let s = "abc汉汉汉汉";
    let out = truncate_display_text(s, 7);
    assert_eq!(out, format!("abc汉{}", TRUNCATION_NOTICE));
    // 结果必须是合法 UTF-8(String 本身保证,再显式确认前缀)。
    assert!(out.starts_with("abc汉"));
}

// ── persisted-output 指针路径解析 ──

#[test]
fn parse_persisted_pointer_path_extracts_abs_path() {
    let text = "<persisted-output>\nOutput too large (283.4KB). Full output saved to: /abs/tool-results/x.txt";
    assert_eq!(parse_persisted_path(text), Some("/abs/tool-results/x.txt"));
    // 尾随换行也能取净。
    let text2 = "<persisted-output>\nOutput too large (1KB). Full output saved to: /a/b.txt\n";
    assert_eq!(parse_persisted_path(text2), Some("/a/b.txt"));
    // 无 "saved to: " → None。
    assert_eq!(
        parse_persisted_path("<persisted-output>\nsomething else"),
        None
    );
}

// ── TurnComplete 状态机(process_batch 级)──

/// 把 json 行序列序列化成 process_batch 输入(模拟一次增量读切出的完整行)。
fn to_batch(lines: &[serde_json::Value]) -> Vec<Vec<u8>> {
    lines
        .iter()
        .map(|v| serde_json::to_vec(v).unwrap())
        .collect()
}

/// 排空 event_rx 的**内容**事件(按到达顺序;旁路 AgentMeta 过滤掉——首个 assistant 行
/// 会先发一条 model 元信息,与这些状态机测试无关,meta 行为见专项测试)。
fn drain_events(rx: &mut mpsc::UnboundedReceiver<AgentEvent>) -> Vec<AgentEvent> {
    std::iter::from_fn(|| rx.try_recv().ok())
        .filter(|ev| !matches!(ev, AgentEvent::AgentMeta { .. }))
        .collect()
}

fn test_state() -> (TailerState, mpsc::UnboundedReceiver<AgentEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (
        TailerState::new(
            PathBuf::from("/nonexistent/meterm-mirror-m4-test.jsonl"),
            tx,
        ),
        rx,
    )
}

#[tokio::test]
async fn turn_complete_exactly_once_per_message_after_all_content() {
    let (mut state, mut rx) = test_state();
    // 同一 message.id 的 thinking + text 行都带 end_turn(实证形状)→ 恰一条 TurnComplete,居批末。
    let batch = to_batch(&[
        assistant_line(
            "b1",
            "msg_10",
            "end_turn",
            json!({"type": "thinking", "thinking": "想一想"}),
        ),
        assistant_line(
            "b2",
            "msg_10",
            "end_turn",
            json!({"type": "text", "text": "答案"}),
        ),
    ]);
    assert!(state.process_batch(batch).await);
    let events = drain_events(&mut rx);
    assert_eq!(
        events,
        vec![
            AgentEvent::ReasoningDelta {
                text: "想一想".into()
            },
            AgentEvent::AssistantDelta {
                text: "答案".into()
            },
            AgentEvent::TurnComplete {
                stop_reason: Some("end_turn".into())
            },
        ]
    );
    assert!(!state.turn_open, "TurnComplete 后轮已关");
}

#[tokio::test]
async fn two_turns_in_one_batch_each_get_turn_complete() {
    let (mut state, mut rx) = test_state();
    // 一批含两轮(冷启动 catch-up 场景):各得一条 TurnComplete,且都在各自内容事件之后。
    let batch = to_batch(&[
        assistant_line(
            "c1",
            "msg_20",
            "end_turn",
            json!({"type": "text", "text": "第一轮"}),
        ),
        user_string_line("c2", "继续"),
        assistant_line(
            "c3",
            "msg_21",
            "end_turn",
            json!({"type": "text", "text": "第二轮"}),
        ),
    ]);
    assert!(state.process_batch(batch).await);
    let events = drain_events(&mut rx);
    assert_eq!(
        events,
        vec![
            AgentEvent::AssistantDelta {
                text: "第一轮".into()
            },
            AgentEvent::TurnComplete {
                stop_reason: Some("end_turn".into())
            },
            AgentEvent::Ext {
                raw: json!({"kind": "user", "text": "继续"})
            },
            AgentEvent::AssistantDelta {
                text: "第二轮".into()
            },
            AgentEvent::TurnComplete {
                stop_reason: Some("end_turn".into())
            },
        ]
    );
}

#[tokio::test]
async fn turn_complete_deduped_across_batches() {
    let (mut state, mut rx) = test_state();
    // 同一消息的行罕见地被切进两批:第二批不重发 TurnComplete(completed_turns 记账)。
    assert!(
        state
            .process_batch(to_batch(&[assistant_line(
                "d1",
                "msg_30",
                "end_turn",
                json!({"type": "thinking", "thinking": "t"})
            ),]))
            .await
    );
    assert!(
        state
            .process_batch(to_batch(&[assistant_line(
                "d2",
                "msg_30",
                "end_turn",
                json!({"type": "text", "text": "x"})
            ),]))
            .await
    );
    let events = drain_events(&mut rx);
    let tc_count = events
        .iter()
        .filter(|e| matches!(e, AgentEvent::TurnComplete { .. }))
        .count();
    assert_eq!(tc_count, 1, "同 message.id 跨批只发一条 TurnComplete");
    // 去重命中分支同样必须关轮:该轮已终结,迟到的同消息内容行不得把轮重新打开
    // (否则 Stop hook 的 poke_turn_end 兜底会补发虚假 TurnComplete)。
    assert!(!state.turn_open, "去重命中后轮也必须是关闭状态");
}

#[tokio::test]
async fn late_same_message_content_does_not_retrigger_fallback_turn_complete() {
    // 回归:同一 message.id 的 thinking+text 被 350ms tick 切进两个读批的实证场景——
    // 批1 thinking(end_turn)发正常 TurnComplete 并记账;批2 同消息 text 行(uuid 不同,
    // 不被 seen_uuids 去重)发 AssistantDelta 后,flush 因 completed_turns 命中不再发 TC,
    // 但**必须复位 turn_open**,否则随后 Stop hook 的 poke_turn_end 兜底会对同一轮
    // 补发第二条 TurnComplete{stop_reason:None}(重复触发 AgentTurnDone 通知)。
    let (mut state, mut rx) = test_state();
    assert!(
        state
            .process_batch(to_batch(&[assistant_line(
                "f1",
                "msg_60",
                "end_turn",
                json!({"type": "thinking", "thinking": "想"})
            ),]))
            .await
    );
    assert!(
        state
            .process_batch(to_batch(&[assistant_line(
                "f2",
                "msg_60",
                "end_turn",
                json!({"type": "text", "text": "迟到正文"})
            ),]))
            .await
    );
    // 模拟 Stop hook poke_turn_end 的兜底判定(与 tailer select 分支同逻辑:轮开着才补发)。
    if state.turn_open {
        state
            .event_tx
            .send(AgentEvent::TurnComplete { stop_reason: None })
            .unwrap();
        state.turn_open = false;
    }
    let events = drain_events(&mut rx);
    let tc_count = events
        .iter()
        .filter(|e| matches!(e, AgentEvent::TurnComplete { .. }))
        .count();
    assert_eq!(
        tc_count, 1,
        "同一轮只允许一条 TurnComplete,兜底不得重复补发"
    );
}

#[tokio::test]
async fn invalid_json_and_duplicate_uuid_lines_skipped() {
    let (mut state, mut rx) = test_state();
    let line = user_string_line("e1", "只该出现一次");
    let mut batch = vec![b"{ not valid json".to_vec()];
    batch.extend(to_batch(&[line.clone()]));
    assert!(state.process_batch(batch).await);
    // 同 uuid 行再喂一批(模拟防御性从头重读)→ 去重集拦截。
    assert!(state.process_batch(to_batch(&[line])).await);
    assert_eq!(drain_events(&mut rx).len(), 1, "坏行跳过 + uuid 去重恰一次");
}
