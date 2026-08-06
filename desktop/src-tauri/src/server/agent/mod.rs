//! Agent 聊天(方案 B / ACP Client)子模块。
//!
//! 通过 ACP(Agent Client Protocol)以子进程托管外部 agent CLI
//! (先支持 Claude Code = `@zed-industries/claude-code-acp`),拿到结构化
//! 对话流,并归一成内部 `AgentEvent`。这是「Agent 聊天视图」方案 B 的地基。
//!
//! - `acp_client` —— 子进程 + ndjson JSON-RPC 编解码 + 握手 + prompt + 审批。
//! - `events` —— 内部归一化事件 `AgentEvent` + 纯映射函数。
//! - `upstream` —— P1-T4 上行 dispatch(手机→桌面:发消息 / 审批 / 打断)。
//! - `mirror` —— 方案甲 M4:transcript JSONL tailer + 行→AgentEvent 纯映射(镜像内容主源)。
//! - `hook` —— 方案甲 M3:`POST /api/agent-hook` 端点 + SessionStart 升格镜像(接线层)。
//!
//! P1-T2 的 `AcpAgentManager`(会话生命周期 / WS 帧广播)会消费本模块。

pub mod acp_client;
pub mod events;
pub mod hook;
pub(crate) mod hook_guard;
pub mod http;
pub mod manager;
pub mod mirror;
pub mod options;
pub mod permission_bridge;
pub mod upstream;

pub use acp_client::{AcpClient, AcpCommand, PermissionDecision};
pub use events::{acp_update_to_event, AgentEvent, PermissionOption};
pub use hook::MirrorRegistry;
pub use manager::{
    validate_agent_req, AcpAgentManager, AgentEntry, AgentKind, AgentMeta, AgentReqError,
};
pub use mirror::{spawn_transcript_tailer, TailerHandle};
pub use permission_bridge::{PermissionBridge, PermissionReply};
