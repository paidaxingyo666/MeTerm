//! Agent 会话的 REST 创建端点(P1-T2)——`POST /api/agent-sessions`。
//!
//! 放在 agent 模块而非 `handlers.rs`:T2 正是把 agent 接进服务端传输层的一层
//! (且 `handlers.rs` 已达 1000 行上限)。校验逻辑在 [`super::validate_agent_req`]
//! (纯函数,单测),本文件只做 spawn → create Session → register(起 fan-out)→
//! publish → 201 的编排。
//!
//! **model/mode**:请求接收但**本任务不应用**(真正切换需 ACP `session/set_mode`/
//! `set_model`,与 T4 的控制帧一起做)。为 API 形状稳定保留字段;若为 `Some`,
//! 记一次 warn 且响应带 `note`,不静默假装已应用。

use std::sync::Arc;

use axum::extract::Extension;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;

use super::{validate_agent_req, AcpClient, AgentKind, AgentMeta};
use crate::server::events::DesktopEvent;
use crate::server::ServerState;

/// `POST /api/agent-sessions` 请求体。
#[derive(Deserialize)]
pub struct CreateAgentSessionRequest {
    /// agent 标识(目前只支持 `"claude"`)。
    pub agent: String,
    /// 工作目录(绝对路径,须存在且是目录)。
    pub cwd: String,
    /// 期望模型(本任务接收但不应用,留待 T4)。
    #[serde(default)]
    pub model: Option<String>,
    /// 期望模式(本任务接收但不应用,留待 T4)。
    #[serde(default)]
    pub mode: Option<String>,
}

/// 创建一个 agent 会话:拉起 `AcpClient` 子进程 → 建不启动 PTY 的 `Session` →
/// 注册进 `AcpAgentManager`(起 fan-out 下行链路)→ 通知手机刷新列表 → 201。
pub async fn create_agent_session(
    Extension(state): Extension<Arc<ServerState>>,
    Json(req): Json<CreateAgentSessionRequest>,
) -> impl IntoResponse {
    // 1. 校验(unknown agent / 非法 cwd → 400)。
    let cmd = match validate_agent_req(&req.agent, &req.cwd) {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "code": e.code() })),
            )
                .into_response();
        }
    };

    // model/mode 本任务不应用:记一次 warn(不静默假装应用)。
    let deferred = req.model.is_some() || req.mode.is_some();
    if deferred {
        eprintln!(
            "[agent] create_agent_session: model/mode 选择本任务暂不应用(model={:?}, mode={:?})",
            req.model, req.mode
        );
    }

    // 2. spawn AcpClient(拉起子进程 + 握手);失败 → 500。
    let client = match AcpClient::spawn(cmd, &req.cwd).await {
        Ok(c) => Arc::new(c),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "code": "spawn_failed", "message": e })),
            )
                .into_response();
        }
    };

    // 3. 取事件流(仅第一次 Some)。取不到即刻 shutdown,避免子进程泄漏。
    let event_rx = match client.take_event_rx() {
        Some(rx) => rx,
        None => {
            client.shutdown().await;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "code": "spawn_failed",
                    "message": "event stream already taken"
                })),
            )
                .into_response();
        }
    };

    // 4. 建 Session(不启动 PTY),标注 executor_type 供会话列表区分。
    let session = state.session_manager.create();
    *session.executor_type.lock().unwrap() = "agent".to_string();

    // agent 会话无 PTY、无 OSC 标题;用 cwd 末段目录名做兜底会话名,供通知/列表显示。
    let title = std::path::Path::new(&req.cwd)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Agent")
        .to_string();
    *session.title.lock().unwrap() = title;

    // 5. 注册 + 起 fan-out(会话 cancel token 驱动收尾 → 无子进程泄漏)。
    let meta = AgentMeta {
        agent: req.agent.clone(),
        cwd: req.cwd.clone(),
        // 方案 B(ACP):事件来自托管的 AcpClient 子进程,会话无 PTY、结束删会话。
        kind: AgentKind::Acp,
    };
    state.agents.register(
        session.id.clone(),
        client,
        event_rx,
        session.clone(),
        state.session_manager.clone(),
        state.event_bus.clone(),
        session.cancellation_token(),
        meta,
    );

    // 6. 通知 presence 订阅者(手机端)刷新会话列表。
    state.event_bus.publish(DesktopEvent::SessionsChanged);

    // 7. 201。
    let mut body = serde_json::json!({
        "id": session.id,
        "type": "agent",
        "agent": req.agent,
        "cwd": req.cwd,
    });
    if deferred {
        body["note"] = serde_json::json!("model/mode selection deferred to a later task");
    }
    (StatusCode::CREATED, Json(body)).into_response()
}

/// `GET /api/agent-options`(fix8):`/model` 别名全集 + `/effort` 档位全集,
/// 运行时从本机 claude 二进制提取(进程级缓存,claude 升级自动重扫);提取失败
/// 落内置快照(`source:"builtin"`)。手机 Agent 页据此渲染切换菜单,消除硬编码漂移。
pub async fn get_agent_options() -> impl IntoResponse {
    // 提取含一次全量文件读(~240MB,冷启动 0.3s 量级):放 blocking 池,别占 async 线程。
    let options = tokio::task::spawn_blocking(super::options::agent_options)
        .await
        .unwrap_or_else(|_| super::options::builtin_fallback());
    Json(options)
}
