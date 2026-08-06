//! Agent 会话**上行** dispatch(手机→桌面,P1-T4):发消息(`MSG_AGENT_INPUT` 0x51)
//! 与审批 / 打断(`MSG_AGENT_CONTROL` 0x52),转给对应 `AcpClient`。
//!
//! 分工:master 门控在 `dispatch.rs` 侧用 `is_master`/`deny_not_master` 完成(本模块
//! 的 handler 只在已通过门控后被调用);本模块负责**纯解析 + 取 client + 非阻塞驱动**。
//!
//! 两条关键约束:
//! - **非阻塞**:`send_prompt` 会 await 一整轮(可能几分钟),绝不能在 dispatch 的 WS
//!   读循环里直接 await(会卡住该 client 的读循环)。审批 / 打断虽快,为一致亦统一
//!   `tokio::spawn`,不阻塞读循环。
//! - **防重叠轮次**:ACP 一次一轮。上行发消息先经 [`AgentEntry::begin_turn`] 抢占 in-flight
//!   守卫(RAII,drop 自动 `end_turn`),已在进行中则回 `agent_busy`。
//!
//! 纯解析([`parse_agent_input`] / [`parse_agent_control`])抽出充分单测(见文件末尾)。
//! 错误一律回 `MSG_ERROR{code,message}` 帧,不 panic。

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use crate::server::agent::{AgentKind, PermissionDecision, PermissionReply};
use crate::server::protocol;
use crate::server::session::{access::DispatchAuthority, Session};
use crate::server::ServerState;

/// 上行控制帧(`MSG_AGENT_CONTROL`)解析结果。
///
/// `request_id` 原样保留为 `serde_json::Value`(JSON-RPC id 可能是数字 0 / 字符串),
/// 回 `answer_permission` 时原样回显。
#[derive(Debug, PartialEq)]
pub enum AgentControl {
    /// 批准某审批请求:选中 `option_id`(如 `"allow_once"`)。
    Approve {
        request_id: Value,
        option_id: String,
    },
    /// 拒绝某审批请求(agent 当作取消并中止该工具)。`message` = 用户给 Claude 的说明
    /// (fix12,仅镜像桥消费;ACP 路径忽略)。
    Reject {
        request_id: Value,
        message: Option<String>,
    },
    /// 回答选择题(fix11:AskUserQuestion,仅镜像桥)。`answers`:
    /// key = question 原文,value = 答案文本(选项 label / 多选 ", " join / 自定义输入)。
    Answer {
        request_id: Value,
        answers: std::collections::HashMap<String, String>,
    },
    /// 打断当前轮次(`session/cancel`)。
    Interrupt,
}

/// 解析 `MSG_AGENT_INPUT` payload:UTF-8 JSON `{"prompt": String}`,prompt 非空。
/// 缺 / 非字符串 / 空 → `Err`(带清晰 message)。
pub fn parse_agent_input(payload: &[u8]) -> Result<String, String> {
    let v: Value = serde_json::from_slice(payload).map_err(|e| format!("invalid JSON: {}", e))?;
    let prompt = v
        .get("prompt")
        .and_then(|p| p.as_str())
        .ok_or_else(|| "missing string field 'prompt'".to_string())?;
    if prompt.is_empty() {
        return Err("'prompt' must not be empty".to_string());
    }
    Ok(prompt.to_string())
}

/// 解析 `MSG_AGENT_CONTROL` payload。
/// - `approve`:要求 `requestId`(取原始 `Value`,可为数字 0)+ 非空 `optionId`。
/// - `reject`:要求 `requestId`。
/// - `interrupt`:无额外字段。
/// - 未知 action / 缺字段 → `Err`(带清晰 message)。
pub fn parse_agent_control(payload: &[u8]) -> Result<AgentControl, String> {
    let v: Value = serde_json::from_slice(payload).map_err(|e| format!("invalid JSON: {}", e))?;
    let action = v
        .get("action")
        .and_then(|a| a.as_str())
        .ok_or_else(|| "missing string field 'action'".to_string())?;
    match action {
        "approve" => {
            let request_id = take_request_id(&v, "approve")?;
            let option_id = v
                .get("optionId")
                .and_then(|o| o.as_str())
                .ok_or_else(|| "'approve' requires string 'optionId'".to_string())?;
            if option_id.is_empty() {
                return Err("'optionId' must not be empty".to_string());
            }
            Ok(AgentControl::Approve {
                request_id,
                option_id: option_id.to_string(),
            })
        }
        "reject" => Ok(AgentControl::Reject {
            request_id: take_request_id(&v, "reject")?,
            // fix12:可选反馈文本(对齐终端 "No, and tell Claude what to do differently")。
            message: v
                .get("message")
                .and_then(|m| m.as_str())
                .filter(|m| !m.is_empty())
                .map(String::from),
        }),
        "answer" => {
            let request_id = take_request_id(&v, "answer")?;
            // answers 必须是非空的 string→string 对象(选择题至少答一题)。
            let obj = v
                .get("answers")
                .and_then(|a| a.as_object())
                .ok_or_else(|| "'answer' requires object 'answers'".to_string())?;
            let mut answers = std::collections::HashMap::new();
            for (k, val) in obj {
                let s = val
                    .as_str()
                    .ok_or_else(|| "'answers' values must be strings".to_string())?;
                answers.insert(k.clone(), s.to_string());
            }
            if answers.is_empty() {
                return Err("'answers' must not be empty".to_string());
            }
            Ok(AgentControl::Answer {
                request_id,
                answers,
            })
        }
        "interrupt" => Ok(AgentControl::Interrupt),
        other => Err(format!("unknown action: {}", other)),
    }
}

/// 取原始 `requestId` Value(必须存在且非 null;数字 0 合法)。缺 / null → `Err`。
fn take_request_id(v: &Value, action: &str) -> Result<Value, String> {
    match v.get("requestId") {
        Some(id) if !id.is_null() => Ok(id.clone()),
        _ => Err(format!("'{}' requires 'requestId'", action)),
    }
}

/// [`AgentControl`] 映射后的**决策动作**:要对 `AcpClient` 实际执行的操作。
///
/// 抽出来是为了把「approve/reject/interrupt → ACP 决策语义」这段**安全相关**
/// 的映射从 spawn 体里拎出成纯函数、可单测锁定(换错也能编译),见 [`control_to_action`]。
#[derive(Debug)]
pub enum ControlAction {
    /// 回 `answer_permission(request_id, decision)`。`request_id` 原样透传(可为数字 0)。
    Answer(Value, PermissionDecision),
    /// 打断当前轮次(`interrupt()` → `session/cancel`)。
    Interrupt,
}

/// 纯函数:把上行控制帧映射为对 `AcpClient` 的决策动作。无副作用、无 IO,便于单测。
///
/// **安全相关映射**(测试锁定,勿改语义):
/// - `Approve{request_id, option_id}` → `Answer(request_id, Selected(option_id))`
/// - `Reject{request_id}` → `Answer(request_id, Cancelled)`
/// - `Interrupt` → `Interrupt`
/// - `Answer{..}`(fix11 选择题)→ `None`:仅镜像桥支持,ACP 无此语义,调用方回错误帧。
///
/// `request_id` 原样透传(含数字 0 的 JSON-RPC id),回显语义靠 `answer_permission`。
pub fn control_to_action(ctrl: AgentControl) -> Option<ControlAction> {
    match ctrl {
        AgentControl::Approve {
            request_id,
            option_id,
        } => Some(ControlAction::Answer(
            request_id,
            PermissionDecision::Selected(option_id),
        )),
        AgentControl::Reject { request_id, .. } => Some(ControlAction::Answer(
            request_id,
            PermissionDecision::Cancelled,
        )),
        AgentControl::Answer { .. } => None,
        AgentControl::Interrupt => Some(ControlAction::Interrupt),
    }
}

/// 多行 prompt 的「paste 正文 → 提交 `\r`」两次注入之间的间隔(修 #1)。
///
/// claude 的 Ink/React TUI 若在**同一次** write 里收到 `\x1b[201~` 紧跟 `\r`,
/// 还没渲染完 paste 就消费了 `\r`——回车被吞,消息只进输入框不提交(真机 bug)。
/// 分两次注入、中间 ~80ms,给 TUI 时间消化完 paste 再收 Enter。
const MULTILINE_SUBMIT_DELAY: Duration = Duration::from_millis(80);

/// 纯函数(M6 / 修 #1):聊天 prompt → PTY 注入**正文字节** + 是否需延迟提交回车。
///
/// - 换行归一为 `\r`:**先** `\r\n` → `\r`,**再**孤立 `\n` → `\r`(顺序反了 `\r\n`
///   会变 `\r\r`,claude TUI 会多收一次回车)。
/// - **单行**(归一后不含 `\r`,聊天主场景):直接 `text + \r`,**不包 bracketed
///   paste**——等价手敲文字 + Enter,claude TUI 必提交,返回 `false`(无需延迟)。
///   修 #1 根因:单行也包 paste 时 `\x1b[201~` 与 `\r` 同批到达,Ink 吞掉回车。
/// - **多行**:包 bracketed paste(`\x1b[200~ … \x1b[201~`,与手机端终端打字的
///   KeySequenceEncoder 同源语义,括号内 `\r` 是字面换行不当提交),**不含**提交
///   `\r`,返回 `true`——提交回车由调用方按 [`MULTILINE_SUBMIT_DELAY`] 延迟单独注入。
/// - UTF-8 原样透传(中文 / emoji 不动);零 token 纪律:除包裹与提交外
///   **不拼接任何 MeTerm 自己的文本**(注入的是用户自己的 prompt)。
pub(crate) fn encode_prompt_body(text: &str) -> (Vec<u8>, bool) {
    // 归一顺序:先 \r\n → \r,再孤立 \n → \r(防 \r\r)。
    let normalized = text.replace("\r\n", "\r").replace('\n', "\r");
    if !normalized.contains('\r') {
        // 单行:裸 text + 提交 \r,等价手敲 Enter,无需 paste 包裹与延迟。
        let mut out = Vec::with_capacity(normalized.len() + 1);
        out.extend_from_slice(normalized.as_bytes());
        out.push(b'\r');
        (out, false)
    } else {
        // 多行:只发 paste 正文;提交 \r 由调用方延迟单独注入(见常量注释)。
        let mut out = Vec::with_capacity(normalized.len() + 12);
        out.extend_from_slice(b"\x1b[200~");
        out.extend_from_slice(normalized.as_bytes());
        out.extend_from_slice(b"\x1b[201~");
        (out, true)
    }
}

// ---------------------------------------------------------------------------
// dispatch handler(master 门控已在 dispatch.rs 侧完成)
// ---------------------------------------------------------------------------

/// 处理上行发消息帧(`MSG_AGENT_INPUT` 0x51):解析 → 取 `AcpClient` → 防重叠 →
/// `tokio::spawn` 非阻塞驱动一轮。同步函数(内部 spawn),不阻塞 dispatch 的 WS 读循环。
pub fn handle_agent_input(
    session: &Arc<Session>,
    authority: &DispatchAuthority,
    payload: &[u8],
    state: &ServerState,
) {
    let text = match parse_agent_input(payload) {
        Ok(t) => t,
        Err(e) => {
            send_agent_error(session, authority, "bad_agent_input", &e);
            return;
        }
    };
    let Some(entry) = state.agents.get(&session.id) else {
        send_agent_error(
            session,
            authority,
            "not_agent_session",
            "no agent for this session",
        );
        return;
    };
    // Mirror 会话(方案甲,M6):无 AcpClient,上行输入注入底层 PTY——等价在终端里打字,
    // claude TUI 原生消费。单行裸注入 text+\r(等价手敲 Enter);多行 bracketed paste
    // 包裹(防中间换行被当多次提交),提交 \r 延迟单独注入——同批发送时 Ink TUI 会吞
    // 回车,消息只进输入框不提交(修 #1,见 encode_prompt_body / MULTILINE_SUBMIT_DELAY)。
    // 不设 begin_turn 守卫(PTY 随时可打字,busy 概念对镜像无意义)、不发确认帧
    // (成功反馈即镜像下行事件本身,与终端打字一致)。master 门控由 handle_input
    // 内部自查兜底(dispatch.rs 对 0x51 另有 is_master 前置门控,双保险)。
    if entry.kind() == AgentKind::Mirror {
        let (body, deferred_submit) = encode_prompt_body(&text);
        session.handle_authorized_input(authority, &body);
        if deferred_submit {
            // 多行:延迟后单独注入提交 \r(两次 write)。它与正文属于同一条已在
            // exact generation + master 快照处合法接收的业务帧，因此共享该不可变
            // admission；后续易主或重连不会让它借用新角色，也不拆断已接收操作。
            let session = session.clone();
            let authority = authority.clone();
            tokio::spawn(async move {
                tokio::time::sleep(MULTILINE_SUBMIT_DELAY).await;
                session.handle_authorized_input(&authority, b"\r");
            });
        }
        return;
    }
    let Some(client) = entry.client().cloned() else {
        send_agent_error(
            session,
            authority,
            "not_agent_session",
            "no agent for this session",
        );
        return;
    };
    // 防重叠轮次:begin_turn 成功即拿到 RAII 守卫(drop 自动 end_turn,任务 panic 亦清)。
    let Some(guard) = entry.begin_turn() else {
        send_agent_error(
            session,
            authority,
            "agent_busy",
            "a turn is already in progress",
        );
        return;
    };
    // send_prompt 可能耗时数分钟:spawn 出去,让 WS 读循环立即返回。
    tokio::spawn(async move {
        // guard 移入任务;send_prompt 返回(成功 / Err / panic 展开)后 drop → end_turn。
        let _guard = guard;
        let _ = client.send_prompt(text).await;
    });
}

/// 处理上行控制帧(`MSG_AGENT_CONTROL` 0x52):审批 / 打断。解析 → 取 `AcpClient` →
/// 映射为 [`ControlAction`] → `tokio::spawn`(不阻塞 WS 读循环)执行。
///
/// **控制写失败不再静默**(FIX-1):审批 / 打断成功时,agent 收到决策后继续产出的
/// 事件经下行 fan-out 即是反馈,无需额外 ack;但**写失败**(如子进程 stdin 管道断)
/// 时,若吞掉错误则手机 UI 无反馈、轮次看似永远卡在等决策。故把 `session`(Arc)+
/// `client_id` clone 进任务,写失败回 `MSG_ERROR{code:"agent_control_failed"}`,与
/// input 路径(经 `send_prompt` 发 `AgentEvent::Error`)的错误可见性对齐。
pub fn handle_agent_control(
    session: &Arc<Session>,
    authority: &DispatchAuthority,
    payload: &[u8],
    state: &ServerState,
) {
    let control = match parse_agent_control(payload) {
        Ok(c) => c,
        Err(e) => {
            send_agent_error(session, authority, "bad_agent_control", &e);
            return;
        }
    };
    let Some(entry) = state.agents.get(&session.id) else {
        send_agent_error(
            session,
            authority,
            "not_agent_session",
            "no agent for this session",
        );
        return;
    };
    // Mirror 会话(方案甲):打断注入 `\x03`(等价终端 Ctrl-C,claude TUI 原生消费);
    // approve / reject 走 P2 审批桥——requestId 是桥自生成的字符串 uuid("mperm-…"),
    // 凭它把决策回投给阻塞中的 PermissionRequest hook handler。allow/deny 语义由
    // optionId 决定(桥下行的固定两选项 "allow"/"deny");整卡驳回(Reject)= deny。
    // 无此 pending(已超时回落 TUI / 已决 / claude 已退出)→ 回 `approval_expired`,
    // 手机据此渲染错误气泡(卡已本地锁定,用户知道该去终端处理)。
    if entry.kind() == AgentKind::Mirror {
        match control {
            AgentControl::Interrupt => {
                session.handle_authorized_input(authority, b"\x03");
            }
            AgentControl::Approve {
                request_id,
                option_id,
            } => {
                // fix12 选项语义:allow(一次)/ allow_always(claude 建议的
                // updatedPermissions,终端第二项)/ 兼容旧 deny optionId。
                let reply = match option_id.as_str() {
                    "deny" => PermissionReply::Deny(None),
                    "allow_always" => PermissionReply::AllowAlways,
                    _ => PermissionReply::Allow,
                };
                resolve_mirror_permission(session, authority, state, &request_id, reply);
            }
            AgentControl::Reject {
                request_id,
                message,
            } => {
                resolve_mirror_permission(
                    session,
                    authority,
                    state,
                    &request_id,
                    PermissionReply::Deny(message),
                );
            }
            // fix11:选择题答案 → behavior=allow + updatedInput.answers(桥 handler 合并)。
            AgentControl::Answer {
                request_id,
                answers,
            } => {
                resolve_mirror_permission(
                    session,
                    authority,
                    state,
                    &request_id,
                    PermissionReply::AllowWithAnswers(answers),
                );
            }
        }
        return;
    }
    let Some(client) = entry.client().cloned() else {
        send_agent_error(
            session,
            authority,
            "not_agent_session",
            "no agent for this session",
        );
        return;
    };
    // 把控制帧映射为决策动作(安全相关映射见 control_to_action + 其单测)。
    // None = 仅镜像桥支持的动作(answer)落到了 ACP 会话 → 明确报错。
    let Some(action) = control_to_action(control) else {
        send_agent_error(
            session,
            authority,
            "bad_agent_control",
            "'answer' is only supported for mirror sessions",
        );
        return;
    };
    // clone 进任务,便于写失败时回错误帧给发起的 client。
    let session = session.clone();
    let authority = authority.clone();
    tokio::spawn(async move {
        let res = match action {
            ControlAction::Answer(request_id, decision) => {
                client.answer_permission(request_id, decision).await
            }
            ControlAction::Interrupt => client.interrupt().await,
        };
        if let Err(e) = res {
            send_agent_error(&session, &authority, "agent_control_failed", &e);
        }
    });
}

/// 镜像审批决策回投(P2):requestId 必须是字符串(桥自生成 uuid;数字 id 只属于 ACP
/// 路径,镜像下必为解码错误)→ 非字符串回 `bad_agent_control`;桥中无此 pending →
/// 回 `approval_expired`。成功无 ack(决策后 claude 继续产出,镜像下行事件即反馈)。
fn resolve_mirror_permission(
    session: &Arc<Session>,
    authority: &DispatchAuthority,
    state: &ServerState,
    request_id: &Value,
    reply: PermissionReply,
) {
    let Some(rid) = request_id.as_str() else {
        send_agent_error(
            session,
            authority,
            "bad_agent_control",
            "mirror approval requestId must be a string",
        );
        return;
    };
    if !state.permission_bridge.resolve(rid, reply) {
        send_agent_error(
            session,
            authority,
            "approval_expired",
            "permission request expired or already decided",
        );
    }
}

/// 回一帧 `MSG_ERROR{code,message}` 给指定 client(参照 dispatch.rs 现有错误帧用法)。
fn send_agent_error(session: &Session, authority: &DispatchAuthority, code: &str, message: &str) {
    let err = serde_json::json!({ "code": code, "message": message });
    session.send_to_client_generation(
        authority.client_id(),
        authority.conn_gen(),
        protocol::encode_message(
            protocol::MSG_ERROR,
            serde_json::to_vec(&err).unwrap_or_default().as_slice(),
        ),
    );
}

// ---------------------------------------------------------------------------
// Tests —— 纯解析函数充分单测
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── parse_agent_input ──

    #[test]
    fn parse_input_ok() {
        let p = json!({ "prompt": "你好 agent" }).to_string();
        assert_eq!(parse_agent_input(p.as_bytes()).unwrap(), "你好 agent");
    }

    #[test]
    fn parse_input_rejects_empty_prompt() {
        let p = json!({ "prompt": "" }).to_string();
        let e = parse_agent_input(p.as_bytes()).unwrap_err();
        assert!(e.contains("empty"), "空 prompt 应报错,得到: {}", e);
    }

    #[test]
    fn parse_input_rejects_missing_prompt() {
        let p = json!({ "foo": "bar" }).to_string();
        assert!(parse_agent_input(p.as_bytes()).is_err(), "缺 prompt 应报错");
    }

    #[test]
    fn parse_input_rejects_non_string_prompt() {
        let p = json!({ "prompt": 123 }).to_string();
        assert!(
            parse_agent_input(p.as_bytes()).is_err(),
            "prompt 非字符串应报错"
        );
    }

    #[test]
    fn parse_input_rejects_bad_json() {
        assert!(parse_agent_input(b"not json").is_err(), "坏 JSON 应报错");
    }

    // ── parse_agent_control ──

    #[test]
    fn parse_control_approve_ok() {
        let p = json!({ "action": "approve", "requestId": "req-7", "optionId": "allow_once" })
            .to_string();
        assert_eq!(
            parse_agent_control(p.as_bytes()).unwrap(),
            AgentControl::Approve {
                request_id: json!("req-7"),
                option_id: "allow_once".into(),
            }
        );
    }

    /// 关键坑:requestId 为数字 **0** 也必须原样取到(JSON-RPC id 可能是 0)。
    #[test]
    fn parse_control_approve_request_id_number_zero() {
        let p =
            json!({ "action": "approve", "requestId": 0, "optionId": "allow_always" }).to_string();
        match parse_agent_control(p.as_bytes()).unwrap() {
            AgentControl::Approve {
                request_id,
                option_id,
            } => {
                assert_eq!(request_id, json!(0), "数字 0 的 requestId 应原样取到");
                assert_eq!(option_id, "allow_always");
            }
            other => panic!("期望 Approve,得到 {:?}", other),
        }
    }

    #[test]
    fn parse_control_approve_missing_option_id() {
        let p = json!({ "action": "approve", "requestId": 1 }).to_string();
        let e = parse_agent_control(p.as_bytes()).unwrap_err();
        assert!(e.contains("optionId"), "缺 optionId 应报错,得到: {}", e);
    }

    #[test]
    fn parse_control_approve_empty_option_id() {
        let p = json!({ "action": "approve", "requestId": 1, "optionId": "" }).to_string();
        let e = parse_agent_control(p.as_bytes()).unwrap_err();
        assert!(e.contains("empty"), "空 optionId 应报错,得到: {}", e);
    }

    #[test]
    fn parse_control_approve_missing_request_id() {
        let p = json!({ "action": "approve", "optionId": "allow_once" }).to_string();
        let e = parse_agent_control(p.as_bytes()).unwrap_err();
        assert!(e.contains("requestId"), "缺 requestId 应报错,得到: {}", e);
    }

    #[test]
    fn parse_control_reject_ok() {
        let p = json!({ "action": "reject", "requestId": 42 }).to_string();
        assert_eq!(
            parse_agent_control(p.as_bytes()).unwrap(),
            AgentControl::Reject {
                request_id: json!(42),
                message: None,
            }
        );
        // fix12:reject 可带反馈文本(对齐终端第三项);空串按缺失处理。
        let p = json!({ "action": "reject", "requestId": 42, "message": "改用 pnpm" }).to_string();
        assert_eq!(
            parse_agent_control(p.as_bytes()).unwrap(),
            AgentControl::Reject {
                request_id: json!(42),
                message: Some("改用 pnpm".into()),
            }
        );
        let p = json!({ "action": "reject", "requestId": 42, "message": "" }).to_string();
        assert_eq!(
            parse_agent_control(p.as_bytes()).unwrap(),
            AgentControl::Reject {
                request_id: json!(42),
                message: None
            }
        );
    }

    #[test]
    fn parse_control_reject_missing_request_id() {
        let p = json!({ "action": "reject" }).to_string();
        assert!(
            parse_agent_control(p.as_bytes()).is_err(),
            "reject 缺 requestId 应报错"
        );
    }

    #[test]
    fn parse_control_interrupt_ok() {
        let p = json!({ "action": "interrupt" }).to_string();
        assert_eq!(
            parse_agent_control(p.as_bytes()).unwrap(),
            AgentControl::Interrupt
        );
    }

    #[test]
    fn parse_control_rejects_unknown_action() {
        let p = json!({ "action": "frobnicate", "requestId": 1 }).to_string();
        let e = parse_agent_control(p.as_bytes()).unwrap_err();
        assert!(
            e.contains("unknown action"),
            "未知 action 应报错,得到: {}",
            e
        );
    }

    #[test]
    fn parse_control_rejects_missing_action() {
        let p = json!({ "requestId": 1 }).to_string();
        assert!(
            parse_agent_control(p.as_bytes()).is_err(),
            "缺 action 应报错"
        );
    }

    #[test]
    fn parse_control_rejects_null_request_id() {
        // requestId 存在但为 null → 视为缺(非可用的 JSON-RPC id)。
        let p = json!({ "action": "reject", "requestId": null }).to_string();
        assert!(
            parse_agent_control(p.as_bytes()).is_err(),
            "requestId 为 null 应报错"
        );
    }

    #[test]
    fn parse_control_rejects_bad_json() {
        assert!(parse_agent_control(b"{oops").is_err(), "坏 JSON 应报错");
    }

    // ── control_to_action(FIX-2:锁定安全相关审批映射)──

    #[test]
    fn control_to_action_approve_maps_to_selected() {
        match control_to_action(AgentControl::Approve {
            request_id: json!("req-7"),
            option_id: "allow_once".into(),
        }) {
            Some(ControlAction::Answer(req, PermissionDecision::Selected(opt))) => {
                assert_eq!(req, json!("req-7"), "requestId 应原样透传");
                assert_eq!(opt, "allow_once", "approve 必须映射到选中的 optionId");
            }
            other => panic!("approve 应映射为 Answer(Selected),得到 {:?}", other),
        }
    }

    #[test]
    fn control_to_action_reject_maps_to_cancelled() {
        match control_to_action(AgentControl::Reject {
            request_id: json!(42),
            message: None,
        }) {
            Some(ControlAction::Answer(req, PermissionDecision::Cancelled)) => {
                assert_eq!(req, json!(42), "requestId 应原样透传");
            }
            other => panic!("reject 应映射为 Answer(Cancelled),得到 {:?}", other),
        }
    }

    #[test]
    fn control_to_action_interrupt_maps_to_interrupt() {
        match control_to_action(AgentControl::Interrupt) {
            Some(ControlAction::Interrupt) => {}
            other => panic!("interrupt 应映射为 Interrupt,得到 {:?}", other),
        }
    }

    /// 关键坑:JSON-RPC id 可能是数字 **0**,映射时必须原样透传(approve 与 reject 都测)。
    #[test]
    fn control_to_action_preserves_numeric_zero_request_id() {
        match control_to_action(AgentControl::Approve {
            request_id: json!(0),
            option_id: "allow_always".into(),
        }) {
            Some(ControlAction::Answer(req, PermissionDecision::Selected(opt))) => {
                assert_eq!(req, json!(0), "approve:数字 0 的 requestId 应原样透传");
                assert_eq!(opt, "allow_always");
            }
            other => panic!("期望 Answer(Selected),得到 {:?}", other),
        }
        match control_to_action(AgentControl::Reject {
            request_id: json!(0),
            message: None,
        }) {
            Some(ControlAction::Answer(req, PermissionDecision::Cancelled)) => {
                assert_eq!(req, json!(0), "reject:数字 0 的 requestId 应原样透传");
            }
            other => panic!("期望 Answer(Cancelled),得到 {:?}", other),
        }
    }

    // ── encode_prompt_body(M6 / 修 #1:聊天 prompt → PTY 注入正文 + 是否延迟提交)──

    /// 单行(聊天主场景,99%):精确字节锁定——**不包 bracketed paste**,直接
    /// `text + \r`,等价手敲文字 + Enter,claude TUI 必提交。修 #1 根因:单行也包
    /// paste 时 `\x1b[201~` 与 `\r` 同批到达,Ink TUI 还没消化完 paste 就吞了 `\r`
    /// → 消息只进输入框不提交。单行无需延迟提交(false)。
    #[test]
    fn encode_prompt_single_line_plain_text_with_submit() {
        let (body, deferred) = encode_prompt_body("hi");
        assert_eq!(body, b"hi\r".to_vec(), "单行必须是裸 text+\\r,不包 paste");
        assert!(!deferred, "单行无需延迟提交");
        assert!(
            !body.contains(&0x1b),
            "单行不得含任何转义序列(无 paste 包裹)"
        );
    }

    /// 多行归一:`\n` 与 `\r\n` 混合 → 全部归一为 `\r`,无 `\n` 残留、无 `\r\r`
    /// (顺序错了 `\r\n` 会先变 `\r\r`);包 bracketed paste(括号内 `\r` 是字面换行,
    /// 不被当多次提交)但**不含**末尾提交 `\r`——提交回车由调用方延迟单独注入(true)。
    #[test]
    fn encode_prompt_multiline_paste_body_without_trailing_cr() {
        let (body, deferred) = encode_prompt_body("a\nb\r\nc");
        assert_eq!(body, b"\x1b[200~a\rb\rc\x1b[201~".to_vec());
        assert!(deferred, "多行必须标记需延迟提交");
        assert!(!body.contains(&b'\n'), "归一后不得残留 \\n");
        assert!(
            !body.windows(2).any(|w| w == b"\r\r"),
            "\\r\\n 归一不得产生 \\r\\r"
        );
        assert!(
            !body.ends_with(b"\r"),
            "paste 正文不得携带提交 \\r(须延迟单独注入)"
        );
    }

    /// 空串(生产解析层已拒绝空 prompt,此处只锁定行为定义):归一后不含 `\r` →
    /// 单行路径,输出裸提交 `\r`(等价空敲 Enter),无需延迟。
    #[test]
    fn encode_prompt_empty_is_bare_submit() {
        let (body, deferred) = encode_prompt_body("");
        assert_eq!(body, b"\r".to_vec());
        assert!(!deferred);
    }

    /// UTF-8 原样透传:中文 / emoji 字节不动——单行裸注入、多行 paste 正文两条路径都测。
    #[test]
    fn encode_prompt_passes_utf8_through() {
        let (body, deferred) = encode_prompt_body("你好🌟世界");
        assert_eq!(body, "你好🌟世界\r".as_bytes().to_vec());
        assert!(!deferred);

        let (body, deferred) = encode_prompt_body("你好\n🌟世界");
        assert_eq!(body, "\x1b[200~你好\r🌟世界\x1b[201~".as_bytes().to_vec());
        assert!(deferred);
    }
}

// ---------------------------------------------------------------------------
// Tests —— Mirror 上行路由(M6:PTY 注入)
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "upstream_mirror_route_tests.rs"]
mod mirror_route_tests;
