//! Agent 子模块的内部归一化事件(与 `server/events.rs` 的 DesktopEvent 无关)。
//!
//! ACP(Agent Client Protocol)的 `session/update` 通知 + 反向请求
//! `session/request_permission` 会被归一成这里的 `AgentEvent`,由 T2 的
//! `AcpAgentManager` 通过 `MSG_AGENT_EVENT` 帧广播给手机端。
//!
//! 目标 schema 对齐桌面前端已有的 `desktop/src/ai-agent-events.ts`,
//! 但字段更贴近 ACP 原语。序列化:外层 `type` 作为 serde tag(snake_case),
//! 结构体字段用 camelCase(方便手机 Swift `Decodable` / JS 消费)。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 一条审批选项(ACP `session/request_permission` 的 options 元素)。
/// 例:`{optionId:"allow_always", name:"Always Allow", kind:"allow_always"}`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PermissionOption {
    #[serde(rename = "optionId")]
    pub option_id: String,
    pub name: String,
    /// ACP `kind`:allow_always / allow_once / reject_once …(可能缺省)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// 内部归一化的 agent 对话事件。`#[serde(tag="type")]` → JSON 形如
/// `{"type":"assistant_delta","text":"..."}`。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// assistant 正文流式增量(ACP `agent_message_chunk`)。
    AssistantDelta { text: String },
    /// 思考/推理流式增量(ACP `agent_thought_chunk`)。
    ReasoningDelta { text: String },
    /// 工具调用开始(ACP `tool_call`)。
    #[serde(rename_all = "camelCase")]
    ToolCallStart {
        id: String,
        title: String,
        /// ACP `kind`:execute / read / edit / …(可能缺省)。
        #[serde(skip_serializing_if = "Option::is_none")]
        kind: Option<String>,
        /// 工具原始入参(ACP `rawInput`,透传原样 JSON)。
        raw_input: Value,
    },
    /// 工具调用状态更新(ACP `tool_call_update`)。
    #[serde(rename_all = "camelCase")]
    ToolCallUpdate {
        id: String,
        /// pending / in_progress / completed / failed …
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        /// ACP `content` 数组原样透传(文本块 / diff 块等)。
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<Value>,
        /// 从 content 里抽出的 diff 块(便于手机直接渲染代码变更)。
        #[serde(skip_serializing_if = "Option::is_none")]
        diff: Option<Value>,
    },
    /// 审批请求(ACP 反向请求 `session/request_permission`)。
    /// `request_id` 原样回显 JSON-RPC id(可能是数字 0),手机决策后经
    /// `answer_permission` 回传。
    #[serde(rename_all = "camelCase")]
    PermissionRequest {
        request_id: Value,
        title: String,
        options: Vec<PermissionOption>,
    },
    /// 选择题(fix11:claude 的 AskUserQuestion 工具经 PermissionRequest hook 桥接,
    /// masko-code 同款机制)。`questions` 为工具入参的 questions 数组**原样透传**
    /// (每题 `{question, header?, multiSelect?, options:[{label, description?}]}`,
    /// 手机宽松解析渐进增强);手机以 0x52 `{"action":"answer","requestId":…,
    /// "answers":{"<question 原文>":"<答案文本>"}}` 回传,桌面经 hook 响应
    /// `decision.updatedInput.answers` 预填答案(behavior=allow)。
    /// **冻结契约**:wire `{"type":"ask_question","requestId":…,"questions":[…]}`。
    #[serde(rename_all = "camelCase")]
    AskQuestion { request_id: Value, questions: Value },
    /// 一轮 prompt 完成(ACP `session/prompt` 结果里的 stopReason)。
    #[serde(rename_all = "camelCase")]
    TurnComplete {
        #[serde(skip_serializing_if = "Option::is_none")]
        stop_reason: Option<String>,
    },
    /// 镜像开始(与 MirrorEnded 对称):claude 启动、镜像编排已建(register_mirror 完成)
    /// 时下行的信号事件,手机据此从欢迎态切镜像态。覆盖「claude 刚起、用户还没输 prompt →
    /// transcript 零事件」的窗口——hook 零内容事件、内容全走 transcript,该窗口内没有任何
    /// 0x50 事件可驱动手机 welcome→mirror 翻转(真机现象:点「选择目录启动」后 Agent 页
    /// 仍显示「Agent 未运行」)。fan-out 会入 history:晚 attach 的客户端回放也能收到,
    /// 同时闭环「进会话时 claude 在跑但零对话」的初判。
    /// **冻结契约**:wire 形态 `{"type":"mirror_started"}`(unit 变体,无字段,不可漂移)。
    MirrorStarted,
    /// 镜像结束(Task D):claude 退出(SessionEnd hook / OSC 7768 顶层 prompt 兜底),
    /// 桌面清理镜像时作为最后一条事件广播。手机端收到后清空对话、回欢迎态。
    /// **冻结契约**:wire 形态 `{"type":"mirror_ended"}`(unit 变体,无字段,不可漂移)。
    MirrorEnded,
    /// 感知通知(修 #2,Notification hook 桥):claude 需要用户确认/输入(审批弹窗、
    /// idle 提醒等)时,hook payload 的 `message` 原样转发下行,手机据此提示用户处理。
    /// 仅镜像态会话发送;零 token(观察者只读,不注入任何东西回 claude)。
    /// **冻结契约**:wire 形态 `{"type":"notify","message":"…"}`(手机并行任务按此
    /// 解码,不可漂移)。
    Notify { message: String },
    /// agent 运行状态(fix2:agent 页状态跟踪)。claude 当前在做什么——由 hook 事件流驱动:
    /// UserPromptSubmit→`thinking`、PreToolUse→`running_tool`(detail=工具名)、
    /// PostToolUse→`thinking`(处理结果)、Stop/StopFailure→`idle`、
    /// Notification(权限类)→`awaiting`。手机据此在 Agent 页顶部显示状态条。
    /// 旁路信号,不进对话流;仅镜像态发送;零 token(观察者只读,不注入回 claude)。
    /// **冻结契约**:wire `{"type":"agent_status","state":"…","detail":"…"}`(detail 为 None 省略)。
    #[serde(rename_all = "camelCase")]
    AgentStatus {
        state: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    /// 会话元信息(fix7:Agent 页 statusline——模型/思考等级/上下文用量/git 分支/cwd,
    /// 显示项对齐 ccstatusline 的核心 widget)。旁路信号,不进对话流:
    /// - `model`/`git_branch`/`cwd` 来自 transcript assistant 行(变化时由 tailer 发);
    /// - `context_tokens` = 最近 assistant 消息 usage 的 input + cache_read + cache_creation
    ///   (= 本轮请求 prompt 大小,ccstatusline/ccusage 同款口径;窗口大小由手机按模型判定);
    /// - `effort` 来自 hook 子进程继承的 `CLAUDE_EFFORT` env(经转发脚本 header 回报)。
    /// 多源异步,字段独立可选,手机侧按非空字段合并归约。
    /// **冻结契约**:wire `{"type":"agent_meta","model":…,"effort":…,"contextTokens":…,
    /// "gitBranch":…,"cwd":…}`(None 字段省略)。
    #[serde(rename_all = "camelCase")]
    AgentMeta {
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        effort: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        context_tokens: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        git_branch: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// 错误(JSON-RPC error / 传输层异常 / 子进程退出)。
    Error { message: String },
    /// 未识别的 `session/update` 透传(保 raw JSON 不丢,手机渐进增强)。
    Ext { raw: Value },
}

/// 从 ACP ContentBlock 里抽纯文本。
/// content 可能是单个块对象 `{type:"text",text}`,也可能是块数组。
fn content_text(content: Option<&Value>) -> String {
    match content {
        // 单块对象:{type:"text", text:"..."}
        Some(Value::Object(_)) => content
            .and_then(|c| c.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string(),
        // 块数组:拼接所有 text 字段。
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// 从 tool_call_update 的 content 数组里抽出 diff 块(type=="diff")。
/// 没有则返回 None。
fn extract_diff(content: Option<&Value>) -> Option<Value> {
    let arr = content?.as_array()?;
    let diffs: Vec<Value> = arr
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("diff"))
        .cloned()
        .collect();
    if diffs.is_empty() {
        None
    } else {
        Some(Value::Array(diffs))
    }
}

/// 纯映射:把一条 ACP `session/update` 的 `update` 对象转成 `AgentEvent`。
/// 未识别的 `sessionUpdate` 类型 → `Ext`(保 raw)。抽成独立函数便于单测。
pub fn acp_update_to_event(update: &Value) -> Option<AgentEvent> {
    let kind = update.get("sessionUpdate").and_then(|v| v.as_str())?;
    let ev = match kind {
        "agent_message_chunk" => AgentEvent::AssistantDelta {
            text: content_text(update.get("content")),
        },
        "agent_thought_chunk" => AgentEvent::ReasoningDelta {
            text: content_text(update.get("content")),
        },
        "tool_call" => AgentEvent::ToolCallStart {
            id: update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            title: update
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            kind: update
                .get("kind")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            raw_input: update.get("rawInput").cloned().unwrap_or(Value::Null),
        },
        "tool_call_update" => AgentEvent::ToolCallUpdate {
            id: update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            status: update
                .get("status")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            content: update.get("content").cloned(),
            diff: extract_diff(update.get("content")),
        },
        // plan / available_commands_update / 其它 → 透传保 raw。
        _ => AgentEvent::Ext {
            raw: update.clone(),
        },
    };
    Some(ev)
}

/// 纯映射:把反向请求 `session/request_permission` 的 params 转成
/// `PermissionRequest` 事件。`request_id` 为该反向请求的 JSON-RPC id。
pub fn permission_request_to_event(request_id: Value, params: &Value) -> AgentEvent {
    // 标题优先取 params.toolCall.title,退回 params.title。
    let title = params
        .get("toolCall")
        .and_then(|tc| tc.get("title"))
        .and_then(|t| t.as_str())
        .or_else(|| params.get("title").and_then(|t| t.as_str()))
        .unwrap_or("")
        .to_string();
    let options: Vec<PermissionOption> = params
        .get("options")
        .and_then(|o| o.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|o| serde_json::from_value::<PermissionOption>(o.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    AgentEvent::PermissionRequest {
        request_id,
        title,
        options,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn assistant_chunk_maps_to_assistant_delta() {
        let u =
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"你好"}});
        assert_eq!(
            acp_update_to_event(&u),
            Some(AgentEvent::AssistantDelta {
                text: "你好".into()
            })
        );
    }

    #[test]
    fn thought_chunk_maps_to_reasoning_delta() {
        let u = json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"思考中"}});
        assert_eq!(
            acp_update_to_event(&u),
            Some(AgentEvent::ReasoningDelta {
                text: "思考中".into()
            })
        );
    }

    #[test]
    fn chunk_content_can_be_array() {
        let u = json!({"sessionUpdate":"agent_message_chunk","content":[
            {"type":"text","text":"a"},{"type":"text","text":"b"}]});
        assert_eq!(
            acp_update_to_event(&u),
            Some(AgentEvent::AssistantDelta { text: "ab".into() })
        );
    }

    #[test]
    fn tool_call_maps_to_tool_call_start() {
        // 取自真实 claude-code-acp trace(mcp__acp__Bash)。
        let u = json!({
            "toolCallId":"toolu_01K9tm4mVyQpgg2BJWUcYrNV",
            "sessionUpdate":"tool_call",
            "rawInput":{"command":"ls -la","timeout":15000},
            "status":"pending","title":"`ls -la`","kind":"execute",
            "content":[{"type":"content","content":{"type":"text","text":"列出当前目录文件"}}]
        });
        let ev = acp_update_to_event(&u).unwrap();
        match ev {
            AgentEvent::ToolCallStart {
                id,
                title,
                kind,
                raw_input,
            } => {
                assert_eq!(id, "toolu_01K9tm4mVyQpgg2BJWUcYrNV");
                assert_eq!(title, "`ls -la`");
                assert_eq!(kind.as_deref(), Some("execute"));
                assert_eq!(raw_input.get("command").unwrap(), "ls -la");
            }
            other => panic!("期望 ToolCallStart,得到 {:?}", other),
        }
    }

    #[test]
    fn tool_call_update_extracts_status_and_diff() {
        let u = json!({
            "sessionUpdate":"tool_call_update",
            "toolCallId":"t1",
            "status":"completed",
            "content":[
                {"type":"text","text":"ok"},
                {"type":"diff","path":"a.txt","oldText":"x","newText":"y"}
            ]
        });
        let ev = acp_update_to_event(&u).unwrap();
        match ev {
            AgentEvent::ToolCallUpdate {
                id,
                status,
                content,
                diff,
            } => {
                assert_eq!(id, "t1");
                assert_eq!(status.as_deref(), Some("completed"));
                assert!(content.is_some());
                let d = diff.expect("应抽出 diff 块");
                assert_eq!(d.as_array().unwrap().len(), 1);
                assert_eq!(d[0].get("path").unwrap(), "a.txt");
            }
            other => panic!("期望 ToolCallUpdate,得到 {:?}", other),
        }
    }

    #[test]
    fn tool_call_update_without_diff_is_none() {
        let u = json!({
            "sessionUpdate":"tool_call_update","toolCallId":"t2","status":"in_progress",
            "content":[{"type":"text","text":"working"}]
        });
        match acp_update_to_event(&u).unwrap() {
            AgentEvent::ToolCallUpdate { diff, .. } => assert!(diff.is_none()),
            other => panic!("期望 ToolCallUpdate,得到 {:?}", other),
        }
    }

    #[test]
    fn unknown_update_falls_back_to_ext_keeping_raw() {
        let u = json!({"sessionUpdate":"available_commands_update","availableCommands":[{"name":"debug"}]});
        match acp_update_to_event(&u).unwrap() {
            AgentEvent::Ext { raw } => {
                // raw 完整保留,不丢字段。
                assert_eq!(
                    raw.get("sessionUpdate").unwrap(),
                    "available_commands_update"
                );
                assert!(raw.get("availableCommands").is_some());
            }
            other => panic!("期望 Ext,得到 {:?}", other),
        }
    }

    #[test]
    fn plan_update_falls_back_to_ext() {
        let u = json!({"sessionUpdate":"plan","entries":[{"content":"step1","status":"pending"}]});
        assert!(matches!(
            acp_update_to_event(&u),
            Some(AgentEvent::Ext { .. })
        ));
    }

    #[test]
    fn missing_session_update_returns_none() {
        assert_eq!(acp_update_to_event(&json!({"foo":"bar"})), None);
    }

    #[test]
    fn permission_request_maps_options_and_title() {
        // 取自真实 trace:注意 id 为数字 0。
        let params = json!({
            "options":[
                {"kind":"allow_always","name":"Always Allow","optionId":"allow_always"},
                {"kind":"allow_once","name":"Allow","optionId":"allow"},
                {"kind":"reject_once","name":"Reject","optionId":"reject"}
            ],
            "sessionId":"s1",
            "toolCall":{"toolCallId":"toolu_x","title":"`ls -la`"}
        });
        let ev = permission_request_to_event(json!(0), &params);
        match ev {
            AgentEvent::PermissionRequest {
                request_id,
                title,
                options,
            } => {
                assert_eq!(request_id, json!(0));
                assert_eq!(title, "`ls -la`");
                assert_eq!(options.len(), 3);
                assert_eq!(options[0].option_id, "allow_always");
                assert_eq!(options[2].kind.as_deref(), Some("reject_once"));
            }
            other => panic!("期望 PermissionRequest,得到 {:?}", other),
        }
    }

    // FIX-7:补 permission_request_to_event 的未覆盖分支。
    #[test]
    fn permission_title_falls_back_to_params_title() {
        // 无 toolCall.title 时,title 退回 params.title。
        let params = json!({ "title": "顶层标题", "options": [] });
        match permission_request_to_event(json!(1), &params) {
            AgentEvent::PermissionRequest { title, options, .. } => {
                assert_eq!(title, "顶层标题");
                assert!(options.is_empty());
            }
            other => panic!("期望 PermissionRequest,得到 {:?}", other),
        }
    }

    #[test]
    fn permission_options_missing_and_dirty_elements() {
        // ① options 字段缺失 → 空 Vec。
        let p1 = json!({ "toolCall": { "title": "x" } });
        match permission_request_to_event(json!(2), &p1) {
            AgentEvent::PermissionRequest { options, .. } => assert!(options.is_empty()),
            other => panic!("期望 PermissionRequest,得到 {:?}", other),
        }
        // ② 脏元素(缺 optionId,反序列化失败)被 filter_map 静默丢弃,合法元素保留。
        let p2 = json!({
            "toolCall": { "title": "x" },
            "options": [
                { "name": "缺 optionId 的脏元素" },
                { "optionId": "allow", "name": "Allow", "kind": "allow_once" }
            ]
        });
        match permission_request_to_event(json!(3), &p2) {
            AgentEvent::PermissionRequest { options, .. } => {
                assert_eq!(options.len(), 1, "脏元素应被丢弃,只保留合法元素");
                assert_eq!(options[0].option_id, "allow");
                assert_eq!(options[0].kind.as_deref(), Some("allow_once"));
            }
            other => panic!("期望 PermissionRequest,得到 {:?}", other),
        }
    }

    /// 冻结契约(与手机端并行消费,不可漂移):
    /// MirrorStarted 的 wire 形态必须精确为 `{"type":"mirror_started"}`(无其它字段)。
    #[test]
    fn mirror_started_serializes_to_exact_frozen_wire_json() {
        let v = serde_json::to_value(&AgentEvent::MirrorStarted).unwrap();
        assert_eq!(v, json!({"type": "mirror_started"}), "wire 契约不可漂移");
        // 字符串级双保险:序列化产物就是这 26 个字节,无多余字段/空白差异。
        let s = serde_json::to_string(&AgentEvent::MirrorStarted).unwrap();
        assert_eq!(s, r#"{"type":"mirror_started"}"#);
    }

    /// 冻结契约(修 #2,手机并行任务按此解码,不可漂移):
    /// Notify 的 wire 形态必须精确为 `{"type":"notify","message":"…"}`(仅这两个字段)。
    #[test]
    fn notify_serializes_to_exact_frozen_wire_json() {
        let ev = AgentEvent::Notify {
            message: "Claude needs your permission to use Bash".into(),
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(
            v,
            json!({"type": "notify", "message": "Claude needs your permission to use Bash"}),
            "wire 契约不可漂移"
        );
        // 字符串级双保险:tag 在前、message 在后,无多余字段/空白差异。
        let s = serde_json::to_string(&AgentEvent::Notify {
            message: "m".into(),
        })
        .unwrap();
        assert_eq!(s, r#"{"type":"notify","message":"m"}"#);
    }

    /// 冻结契约(fix2:agent 页状态条,手机按此解码,不可漂移):
    /// AgentStatus 的 wire 形态必须精确为 `{"type":"agent_status","state":"…","detail":"…"}`,
    /// detail 为 None 时字段整个省略(不序列化 null)。
    #[test]
    fn agent_status_serializes_to_exact_frozen_wire_json() {
        // detail = Some:三字段齐全。
        let ev = AgentEvent::AgentStatus {
            state: "running_tool".into(),
            detail: Some("Bash".into()),
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(
            v,
            json!({"type": "agent_status", "state": "running_tool", "detail": "Bash"}),
            "wire 契约不可漂移"
        );
        // detail = None:字段必须整个省略(不得序列化成 null)。
        let idle = AgentEvent::AgentStatus {
            state: "idle".into(),
            detail: None,
        };
        let s = serde_json::to_string(&idle).unwrap();
        assert_eq!(s, r#"{"type":"agent_status","state":"idle"}"#);
    }

    /// 冻结契约(fix7:Agent 页 statusline,手机按此解码,不可漂移):
    /// AgentMeta 的 wire 形态为 `{"type":"agent_meta","model":…,"effort":…,
    /// "contextTokens":…,"gitBranch":…,"cwd":…}`,None 字段整个省略(不序列化 null)。
    #[test]
    fn agent_meta_serializes_to_exact_frozen_wire_json() {
        let full = AgentEvent::AgentMeta {
            model: Some("claude-opus-4-8".into()),
            effort: Some("high".into()),
            context_tokens: Some(53000),
            git_branch: Some("dev-0.2.12".into()),
            cwd: Some("/Users/me/proj".into()),
        };
        assert_eq!(
            serde_json::to_value(&full).unwrap(),
            json!({
                "type": "agent_meta",
                "model": "claude-opus-4-8",
                "effort": "high",
                "contextTokens": 53000,
                "gitBranch": "dev-0.2.12",
                "cwd": "/Users/me/proj"
            }),
            "wire 契约不可漂移(字段名 camelCase)"
        );
        // 单字段:其余字段必须整个省略。
        let model_only = AgentEvent::AgentMeta {
            model: Some("claude-sonnet-5".into()),
            effort: None,
            context_tokens: None,
            git_branch: None,
            cwd: None,
        };
        assert_eq!(
            serde_json::to_string(&model_only).unwrap(),
            r#"{"type":"agent_meta","model":"claude-sonnet-5"}"#
        );
        let effort_only = AgentEvent::AgentMeta {
            model: None,
            effort: Some("max".into()),
            context_tokens: None,
            git_branch: None,
            cwd: None,
        };
        assert_eq!(
            serde_json::to_string(&effort_only).unwrap(),
            r#"{"type":"agent_meta","effort":"max"}"#
        );
    }

    /// 冻结契约(fix11:AskUserQuestion 选择题,手机按此解码,不可漂移):
    /// AskQuestion 的 wire 形态为 `{"type":"ask_question","requestId":…,"questions":[…]}`,
    /// questions 原样透传(不改写、不过滤)。
    #[test]
    fn ask_question_serializes_to_exact_frozen_wire_json() {
        let ev = AgentEvent::AskQuestion {
            request_id: json!("mperm-q1"),
            questions: json!([{
                "question": "用哪种方案?",
                "header": "方案",
                "multiSelect": false,
                "options": [{"label": "A", "description": "方案 A"}, {"label": "B"}]
            }]),
        };
        assert_eq!(
            serde_json::to_value(&ev).unwrap(),
            json!({
                "type": "ask_question",
                "requestId": "mperm-q1",
                "questions": [{
                    "question": "用哪种方案?",
                    "header": "方案",
                    "multiSelect": false,
                    "options": [{"label": "A", "description": "方案 A"}, {"label": "B"}]
                }]
            }),
            "wire 契约不可漂移;questions 原样透传"
        );
    }

    /// 冻结契约(Task D / 手机端 Task P 并行消费,不可漂移):
    /// MirrorEnded 的 wire 形态必须精确为 `{"type":"mirror_ended"}`(无其它字段)。
    #[test]
    fn mirror_ended_serializes_to_exact_frozen_wire_json() {
        let v = serde_json::to_value(&AgentEvent::MirrorEnded).unwrap();
        assert_eq!(v, json!({"type": "mirror_ended"}), "wire 契约不可漂移");
        // 字符串级双保险:序列化产物就是这 24 个字节,无多余字段/空白差异。
        let s = serde_json::to_string(&AgentEvent::MirrorEnded).unwrap();
        assert_eq!(s, r#"{"type":"mirror_ended"}"#);
    }

    #[test]
    fn agent_event_serializes_with_type_tag_and_camelcase() {
        let ev = AgentEvent::ToolCallStart {
            id: "t1".into(),
            title: "Bash".into(),
            kind: Some("execute".into()),
            raw_input: json!({"command":"ls"}),
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v.get("type").unwrap(), "tool_call_start");
        // raw_input → rawInput(camelCase)。
        assert_eq!(v.get("rawInput").unwrap(), &json!({"command":"ls"}));

        let done = AgentEvent::TurnComplete {
            stop_reason: Some("end_turn".into()),
        };
        let dv = serde_json::to_value(&done).unwrap();
        assert_eq!(dv.get("type").unwrap(), "turn_complete");
        assert_eq!(dv.get("stopReason").unwrap(), "end_turn");
    }
}
