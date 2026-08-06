//! `AcpClient` —— 以子进程托管外部 agent CLI(先支持 Claude Code),
//! 走 ACP(Agent Client Protocol):JSON-RPC 2.0 over ndjson(每行一个
//! JSON 对象)/ 子进程 stdio。
//!
//! 职责边界(P1-T1):只做「拉起子进程 + ndjson 编解码 + initialize /
//! session/new / session/prompt + 收 session/update + 答
//! request_permission + 归一成 AgentEvent 推出」。不接 WS / 会话 /
//! 帧协议(那是 P1-T2 的 `AcpAgentManager`)。
//!
//! 实测依据:claude-code-acp v0.16(见 spike trace)。关键坑:反向请求
//! `session/request_permission` 的 JSON-RPC id 可能是数字 **0**,因此
//! 「是不是反向请求」必须判 `method` + `id` 是否存在,不能用 id 真值。

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex, Notify};
use tokio::task::JoinHandle;

use super::events::{acp_update_to_event, permission_request_to_event, AgentEvent};

/// 握手(initialize / session/new)最长等待。给足冷启动余量(npx 首次可能
/// 下依赖),但不可无限:子进程开着 stdout 却不产响应也不 EOF 时必须超时报错,
/// 否则 spawn() 既不 Ok 也不 Err、调用方永挂。send_prompt 不用此超时(见其注释)。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(60);

/// 拉起 agent 的命令(可配置)。默认 = `npx -y @zed-industries/claude-code-acp`。
#[derive(Debug, Clone)]
pub struct AcpCommand {
    pub program: String,
    pub args: Vec<String>,
    /// 传给 `initialize` 的 clientCapabilities。默认不声明 fs/terminal:
    /// 这样 agent 不会发 `fs/*` / `terminal/create` 反向请求(T1 未实现),
    /// 而是自己跑工具、仅用 `session/request_permission` 征求审批。
    pub client_capabilities: Value,
}

impl Default for AcpCommand {
    fn default() -> Self {
        Self::claude_code()
    }
}

impl AcpCommand {
    /// 默认:npx 拉起 zed 官方 claude-code-acp 适配器。
    pub fn claude_code() -> Self {
        AcpCommand {
            program: "npx".to_string(),
            args: vec![
                "-y".to_string(),
                "@zed-industries/claude-code-acp".to_string(),
            ],
            // T1 不实现 fs/terminal,声明 false 以避开对应反向请求。
            client_capabilities: json!({
                "fs": { "readTextFile": false, "writeTextFile": false }
            }),
        }
    }
}

/// 审批决策 —— 回 `session/request_permission` 的 result。
#[derive(Debug, Clone)]
pub enum PermissionDecision {
    /// 选中某个 option(用 optionId,如 "allow_once" / "reject")。
    Selected(String),
    /// 取消(agent 会当作拒绝并中止本次工具)。
    Cancelled,
}

/// 传输层对一行 JSON-RPC 消息的分类结果(纯逻辑,便于单测)。
#[derive(Debug)]
pub enum Incoming {
    /// 对我方请求的响应(有 id、有 result/error、无 method)。
    Response {
        id: i64,
        result: Result<Value, String>,
    },
    /// 通知(有 method、无 id)。
    Notification { method: String, params: Value },
    /// 反向请求(有 method、有 id)——如 session/request_permission。
    /// id 原样保留(可能是数字 0)。
    ReverseRequest {
        id: Value,
        method: String,
        params: Value,
    },
    /// 无法识别的行。
    Invalid,
}

/// 纯函数:把一行已解析的 JSON-RPC 消息分类。抽出来便于单测分派逻辑。
pub fn classify_message(msg: &Value) -> Incoming {
    let has_method = msg.get("method").is_some();
    let id = msg.get("id");
    if has_method {
        let method = msg
            .get("method")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        if let Some(id) = id {
            // 有 method + 有 id → 反向请求(id 可能为 0)。
            Incoming::ReverseRequest {
                id: id.clone(),
                method,
                params,
            }
        } else {
            Incoming::Notification { method, params }
        }
    } else if let Some(id) = id.and_then(|v| v.as_i64()) {
        // 无 method + 有 id → 响应。
        if let Some(err) = msg.get("error") {
            let m = err
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown JSON-RPC error")
                .to_string();
            Incoming::Response { id, result: Err(m) }
        } else if let Some(res) = msg.get("result") {
            Incoming::Response {
                id,
                result: Ok(res.clone()),
            }
        } else {
            Incoming::Invalid
        }
    } else {
        Incoming::Invalid
    }
}

/// pending 请求表:请求 id → 等待响应的 oneshot。
type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

/// ACP 客户端。持子进程 + stdin 写端 + pending 表 + 事件出口。
pub struct AcpClient {
    /// ACP session/new 返回的 sessionId。
    pub session_id: String,
    /// session/new 返回的 models 对象(availableModels / currentModelId)原样保留。
    pub models: Value,
    /// session/new 返回的 modes 对象(availableModes / currentModeId)原样保留。
    pub modes: Value,
    /// initialize 返回的 agentInfo / agentCapabilities 原样保留。
    pub agent_info: Value,
    pub agent_capabilities: Value,

    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    next_id: Arc<AtomicI64>,
    /// 事件发送端(与 reader task 共用同一通道):send_prompt 用它补发
    /// TurnComplete / Error,使一轮的收尾也出现在事件流里。
    /// 用 **unbounded**:reader 处于 RPC 响应解复用的关键路径上,绝不可因事件
    /// 消费者(手机端经中继)背压而在 `send().await` 上阻塞——那会连带停掉
    /// stdout 读取,让 in-flight `call()` 的响应永远读不到而死锁(FIX-1)。
    /// unbounded 的 `send()` 是同步、不 await,只在 Receiver drop 时返 Err。
    /// 内存增长上界 = 单轮 turn 的事件量;丢弃/上限策略留给 T2 broadcast 层。
    event_tx: mpsc::UnboundedSender<AgentEvent>,
    // child kill 是 async,且需跨 .await 持锁 → 用 tokio Mutex。
    child: Arc<Mutex<Child>>,
    // 下面几个只做同步 take/abort,不跨 .await 持锁 → 用 std Mutex 更省心。
    reader_task: std::sync::Mutex<Option<JoinHandle<()>>>,
    stderr_task: std::sync::Mutex<Option<JoinHandle<()>>>,
    /// 事件出口:spawn 后由调用方 `take_event_rx()` 取走(仅一次)。
    event_rx: std::sync::Mutex<Option<mpsc::UnboundedReceiver<AgentEvent>>>,
    /// 是否已收尾(reader 退出 / shutdown)。置 true 后 `call()` 立即失败,
    /// 不再往 pending 塞注定无人唤醒的悬挂 tx(FIX-3)。
    closed: Arc<AtomicBool>,
    /// 「子进程已关闭」的异步唤醒信号:reader EOF / shutdown 时**先置 `closed` 再**
    /// `notify_waiters()`。配合 `closed` 供 fan-out 的 `wait_closed`(agent::manager)
    /// 感知子进程死亡并回收会话(避免手机仍连着而子进程已死留下的僵尸会话)。
    closed_notify: Arc<Notify>,
}

impl AcpClient {
    /// 拉起 agent 命令 + 完成 initialize + session/new。
    /// 成功后后台 reader task 已在跑,`take_event_rx()` 可取事件流。
    pub async fn spawn(cmd: AcpCommand, cwd: &str) -> Result<AcpClient, String> {
        let mut child = Command::new(&cmd.program)
            .args(&cmd.args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("acp: 启动 {} 失败: {}", cmd.program, e))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "acp: 无法获取子进程 stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "acp: 无法获取子进程 stdout".to_string())?;
        let stderr = child.stderr.take();

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let next_id = Arc::new(AtomicI64::new(1));
        let stdin = Arc::new(Mutex::new(stdin));
        let closed = Arc::new(AtomicBool::new(false));
        let closed_notify = Arc::new(Notify::new());
        // 事件通道:reader task → 调用方。unbounded,理由见 struct.event_tx 注释。
        let (event_tx, event_rx) = mpsc::unbounded_channel::<AgentEvent>();

        // 后台 reader:逐行读 stdout,分派响应/通知/反向请求。
        let reader_task = tokio::spawn(read_loop(
            stdout,
            pending.clone(),
            stdin.clone(),
            event_tx.clone(),
            closed.clone(),
            closed_notify.clone(),
        ));

        // 后台 stderr:排空,避免管道写满阻塞子进程(顺带落日志)。
        let stderr_task = stderr.map(|se| {
            tokio::spawn(async move {
                let mut lines = BufReader::new(se).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[acp-stderr] {}", line);
                }
            })
        });

        let mut client = AcpClient {
            session_id: String::new(),
            models: Value::Null,
            modes: Value::Null,
            agent_info: Value::Null,
            agent_capabilities: Value::Null,
            stdin,
            pending,
            next_id,
            event_tx: event_tx.clone(),
            child: Arc::new(Mutex::new(child)),
            reader_task: std::sync::Mutex::new(Some(reader_task)),
            stderr_task: std::sync::Mutex::new(stderr_task),
            event_rx: std::sync::Mutex::new(Some(event_rx)),
            closed,
            closed_notify,
        };

        // 握手用有限超时:任一步超时/失败都 shutdown 收尾(杀子进程 + 唤醒
        // 一切 pending),再把错误上抛;绝不留下半死的子进程或悬挂的 call。
        // 1) initialize
        let init = match client
            .call_with_timeout(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientCapabilities": cmd.client_capabilities,
                }),
                Some(HANDSHAKE_TIMEOUT),
            )
            .await
        {
            Ok(v) => v,
            Err(e) => {
                client.shutdown().await;
                return Err(e);
            }
        };
        client.agent_info = init.get("agentInfo").cloned().unwrap_or(Value::Null);
        client.agent_capabilities = init
            .get("agentCapabilities")
            .cloned()
            .unwrap_or(Value::Null);

        // 2) session/new
        let sess = match client
            .call_with_timeout(
                "session/new",
                json!({ "cwd": cwd, "mcpServers": [] }),
                Some(HANDSHAKE_TIMEOUT),
            )
            .await
        {
            Ok(v) => v,
            Err(e) => {
                client.shutdown().await;
                return Err(e);
            }
        };
        client.session_id = sess
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "acp: session/new 未返回 sessionId".to_string())?
            .to_string();
        client.models = sess.get("models").cloned().unwrap_or(Value::Null);
        client.modes = sess.get("modes").cloned().unwrap_or(Value::Null);

        Ok(client)
    }

    /// 取走事件流 Receiver(仅第一次返回 Some,之后 None)。
    pub fn take_event_rx(&self) -> Option<mpsc::UnboundedReceiver<AgentEvent>> {
        self.event_rx.lock().ok().and_then(|mut g| g.take())
    }

    /// 「子进程已关闭」信号:返回 (`closed` 标志, 关闭通知) 的克隆。reader EOF /
    /// shutdown 会**先置 `closed` 再** `notify_waiters()`,故 `wait_closed`
    /// (agent::manager)唤醒后 `closed` 必为 true。供 fan-out 感知子进程死亡并回收会话。
    pub fn closed_signal(&self) -> (Arc<AtomicBool>, Arc<Notify>) {
        (self.closed.clone(), self.closed_notify.clone())
    }

    /// 发一轮 prompt。返回 stopReason(如有),并向事件流补发 `TurnComplete`
    /// (成功)或 `Error`(失败)。轮次中的 session/update 由 reader task 推流。
    ///
    /// 刻意 **不加 wall-clock 超时**:一轮 agent 对话可能跑几分钟(长工具链、
    /// 等审批)。它靠子进程正常返 session/prompt 响应、或子进程 EOF/退出时
    /// reader drain pending(FIX-3)来唤醒,不靠计时器。这与握手(有限超时)
    /// 的取舍不同——握手无产出即视为卡死,prompt 长耗时属正常。
    pub async fn send_prompt(&self, text: String) -> Result<Option<String>, String> {
        let res = match self
            .call(
                "session/prompt",
                json!({
                    "sessionId": self.session_id,
                    "prompt": [{ "type": "text", "text": text }],
                }),
            )
            .await
        {
            Ok(v) => v,
            Err(e) => {
                // unbounded send:同步、不 await(见 struct.event_tx)。
                let _ = self.event_tx.send(AgentEvent::Error { message: e.clone() });
                return Err(e);
            }
        };
        let stop_reason = res
            .get("stopReason")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let _ = self.event_tx.send(AgentEvent::TurnComplete {
            stop_reason: stop_reason.clone(),
        });
        Ok(stop_reason)
    }

    /// 回复审批反向请求。`request_id` 为 `PermissionRequest.request_id`
    /// 原样回显的 JSON-RPC id;`decision` 决定 outcome。
    pub async fn answer_permission(
        &self,
        request_id: Value,
        decision: PermissionDecision,
    ) -> Result<(), String> {
        let resp = build_permission_response(&request_id, &decision);
        self.write_line(&resp).await
    }

    /// 打断当前轮次(ACP `session/cancel` 通知,无需响应)。
    /// 消费方为 P1-T4 的 `MSG_AGENT_CONTROL{action:"interrupt"}`;T1 暂未接线,
    /// 仅提供 AcpClient 自然 API 面,留待 T4 复用。
    pub async fn interrupt(&self) -> Result<(), String> {
        let notif = json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": self.session_id },
        });
        self.write_line(&notif).await
    }

    /// 关停:唤醒所有 in-flight call + 杀子进程 + 中止后台 task。
    ///
    /// 顺序至关重要(FIX-3):**先 drain pending,再 kill,最后 abort reader**。
    /// 若先 abort reader,它是唯一 drain pending 的地方,被 abort 后 in-flight
    /// `call()` 的 oneshot tx 永远无人唤醒 → 该 call 的 rx.await 永挂。这里在
    /// abort 之前主动把 pending 全部发 Err,保证任何收尾路径下 call() 都会返回。
    pub async fn shutdown(&self) {
        // 先置 closed:此刻及之后发起的 call() 立即失败,不再塞悬挂 tx。
        self.closed.store(true, Ordering::SeqCst);
        // 唤醒等在 wait_closed 上的 fan-out(先 store 再 notify,唤醒方见到的 closed 必为 true)。
        self.closed_notify.notify_waiters();
        // 1) drain pending —— 唤醒一切在等响应的 call()。
        drain_pending(&self.pending, "acp: 客户端已关闭").await;
        // 2) kill 子进程。
        let _ = self.child.lock().await.kill().await;
        // 3) abort 后台 task(此时 pending 已清空,abort 不会遗留悬挂 tx)。
        if let Some(h) = self.reader_task.lock().ok().and_then(|mut g| g.take()) {
            h.abort();
        }
        if let Some(h) = self.stderr_task.lock().ok().and_then(|mut g| g.take()) {
            h.abort();
        }
    }

    // ── 内部:JSON-RPC 请求(注册 pending + 写行 + 等响应)──

    /// 无 wall-clock 超时的 call(靠子进程响应或 EOF/shutdown drain 唤醒)。
    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.call_with_timeout(method, params, None).await
    }

    /// 发一次 JSON-RPC 请求并等响应。`timeout=Some(dur)` 时超时即清 pending
    /// 并返回 Err(握手用);`None` 时无限等(prompt 用,见 send_prompt 注释)。
    async fn call_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, String> {
        // reader 已退出 / 已 shutdown:直接失败,别再塞注定无人唤醒的 tx。
        if self.closed.load(Ordering::SeqCst) {
            return Err(format!("acp: {} 失败:客户端已关闭", method));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        // 双检:注册后再确认未关闭,关掉「检查通过→reader 刚退出并 drain→我才
        // 插入」这个竞态窗口,避免我的 tx 成为漏网悬挂项。
        if self.closed.load(Ordering::SeqCst) {
            self.pending.lock().await.remove(&id);
            return Err(format!("acp: {} 失败:客户端已关闭", method));
        }
        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(e) = self.write_line(&req).await {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }
        match timeout {
            Some(dur) => match tokio::time::timeout(dur, rx).await {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err(format!("acp: {} 响应通道关闭(子进程退出?)", method)),
                Err(_) => {
                    // 超时:清 pending 里该 id,返回 Err。收尾(shutdown)由调用方负责。
                    self.pending.lock().await.remove(&id);
                    Err(format!("acp: {} 超时(timed out)", method))
                }
            },
            None => match rx.await {
                Ok(result) => result,
                Err(_) => Err(format!("acp: {} 响应通道关闭(子进程退出?)", method)),
            },
        }
    }

    /// 写一行 ndjson(JSON + '\n')到子进程 stdin。
    async fn write_line(&self, obj: &Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(obj).map_err(|e| format!("acp: 序列化失败: {}", e))?;
        line.push(b'\n');
        let mut w = self.stdin.lock().await;
        w.write_all(&line)
            .await
            .map_err(|e| format!("acp: 写 stdin 失败: {}", e))?;
        w.flush()
            .await
            .map_err(|e| format!("acp: flush stdin 失败: {}", e))?;
        Ok(())
    }
}

/// drain pending:把 pending 表清空,给每个等待中的 call() 发 Err 唤醒。
/// reader 自然 EOF 退出、以及 shutdown() 都调它 —— 保证任何收尾路径下没有
/// call() 会永久挂起(FIX-3)。
async fn drain_pending(pending: &Pending, msg: &str) {
    let mut map = pending.lock().await;
    for (_, tx) in map.drain() {
        let _ = tx.send(Err(msg.to_string()));
    }
}

/// 纯函数:构造回 `session/request_permission` 的 JSON-RPC 响应。
/// 注意 ACP 回包是 **双层 outcome**:`result.outcome.{outcome, optionId?}`
/// (外层 result 里的 outcome 对象再包一层 outcome 字段)——这是最易写错处,
/// 故抽成纯函数并有单测锁定(FIX-6)。`request_id` 原样回显(可能是数字 0)。
fn build_permission_response(request_id: &Value, decision: &PermissionDecision) -> Value {
    let outcome = match decision {
        PermissionDecision::Selected(opt) => {
            json!({ "outcome": "selected", "optionId": opt })
        }
        PermissionDecision::Cancelled => json!({ "outcome": "cancelled" }),
    };
    json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": { "outcome": outcome },
    })
}

/// 后台读循环:逐行解析 stdout → 分派。泛型化 `R`/`W` 便于用内存管道单测。
/// - 响应 → 唤醒对应 pending oneshot。
/// - 通知 `session/update` → 归一成 AgentEvent 推事件流。
/// - 反向请求 `session/request_permission` → 推 PermissionRequest 事件
///   (调用方决策后经 answer_permission 回;此处不阻塞、不自动回)。
/// - 其它反向请求(fs/terminal 等 T1 未实现)→ 自动回 JSON-RPC error,
///   防止 agent 无限等待。
///
/// 读行用 `read_until(b'\n')` + `from_utf8_lossy` 而非 `lines()`:后者遇非法
/// UTF-8 会返回 `io::Error(InvalidData)`,旧实现据此 break + drain,一个坏
/// 字节就杀死整个会话;改为 lossy 解码后,坏行只会 JSON 解析失败被当日志跳过,
/// 而真正的 IO 断流仍走 Err 分支 break + drain(FIX-5)。
async fn read_loop<R, W>(
    stdout: R,
    pending: Pending,
    stdin: Arc<Mutex<W>>,
    event_tx: mpsc::UnboundedSender<AgentEvent>,
    closed: Arc<AtomicBool>,
    closed_notify: Arc<Notify>,
) where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut reader = BufReader::new(stdout);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break, // EOF:子进程关闭 stdout。
            Ok(_) => {}
            Err(e) => {
                // 真正的 IO 断流(非编码问题):送错误事件后退出并 drain。
                let _ = event_tx.send(AgentEvent::Error {
                    message: format!("acp: 读 stdout 失败: {}", e),
                });
                break;
            }
        }
        // 坏 UTF-8 字节 → replacement char,后续 JSON 解析自然失败被当日志跳过,
        // 绝不因此杀死会话。
        let line = String::from_utf8_lossy(&buf);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue, // 非 JSON 行(适配器偶发日志 / 坏字节行)跳过。
        };

        match classify_message(&msg) {
            Incoming::Response { id, result } => {
                if let Some(tx) = pending.lock().await.remove(&id) {
                    let _ = tx.send(result);
                }
            }
            Incoming::Notification { method, params } => {
                if method == "session/update" {
                    if let Some(update) = params.get("update") {
                        if let Some(ev) = acp_update_to_event(update) {
                            // unbounded send:同步、不 await,绝不阻塞 stdout 读取。
                            let _ = event_tx.send(ev);
                        }
                    }
                }
                // 其它通知(暂无)忽略。
            }
            Incoming::ReverseRequest { id, method, params } => {
                if method == "session/request_permission" {
                    let ev = permission_request_to_event(id, &params);
                    let _ = event_tx.send(ev);
                } else {
                    // T1 未实现的能力(fs/terminal 等):回 method-not-found,
                    // 让 agent 走内建路径 / 不至于卡死。
                    let resp = json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {
                            "code": -32601,
                            "message": format!("method not supported by client: {}", method),
                        },
                    });
                    let mut line = match serde_json::to_vec(&resp) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    line.push(b'\n');
                    let mut w = stdin.lock().await;
                    let _ = w.write_all(&line).await;
                    let _ = w.flush().await;
                }
            }
            Incoming::Invalid => {}
        }
    }

    // stdout EOF / 断流:子进程结束。置 closed(挡住新 call)并 drain 所有
    // pending(否则 in-flight call 永久 hang)。
    closed.store(true, Ordering::SeqCst);
    drain_pending(&pending, "acp: 子进程 stdout 关闭").await;
    // 唤醒等在 wait_closed 上的 fan-out(先 store 再 notify),使其 break → finalize
    // 回收会话(子进程死亡回收路径,FIX-L2)。
    closed_notify.notify_waiters();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classify_response_ok() {
        let m = json!({"jsonrpc":"2.0","id":2,"result":{"sessionId":"abc"}});
        match classify_message(&m) {
            Incoming::Response { id, result } => {
                assert_eq!(id, 2);
                assert_eq!(result.unwrap().get("sessionId").unwrap(), "abc");
            }
            other => panic!("期望 Response,得到 {:?}", other),
        }
    }

    #[test]
    fn classify_response_error() {
        let m = json!({"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"boom"}});
        match classify_message(&m) {
            Incoming::Response { id, result } => {
                assert_eq!(id, 3);
                assert_eq!(result.unwrap_err(), "boom");
            }
            other => panic!("期望 Response(error),得到 {:?}", other),
        }
    }

    #[test]
    fn classify_notification() {
        // session/update 通知:无 id。
        let m = json!({"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"plan"}}});
        match classify_message(&m) {
            Incoming::Notification { method, params } => {
                assert_eq!(method, "session/update");
                assert!(params.get("update").is_some());
            }
            other => panic!("期望 Notification,得到 {:?}", other),
        }
    }

    #[test]
    fn classify_reverse_request_with_zero_id() {
        // 关键坑:反向请求 id 为数字 0,不能当成「无 id」。
        let m = json!({
            "jsonrpc":"2.0","id":0,"method":"session/request_permission",
            "params":{"options":[],"toolCall":{"title":"x"}}
        });
        match classify_message(&m) {
            Incoming::ReverseRequest { id, method, .. } => {
                assert_eq!(id, json!(0));
                assert_eq!(method, "session/request_permission");
            }
            other => panic!("期望 ReverseRequest,得到 {:?}", other),
        }
    }

    #[test]
    fn classify_reverse_request_terminal_create() {
        let m = json!({
            "jsonrpc":"2.0","id":1,"method":"terminal/create",
            "params":{"command":"ls -la","sessionId":"s"}
        });
        assert!(matches!(
            classify_message(&m),
            Incoming::ReverseRequest { method, .. } if method == "terminal/create"
        ));
    }

    #[test]
    fn classify_invalid_when_no_id_no_method() {
        assert!(matches!(
            classify_message(&json!({"jsonrpc":"2.0"})),
            Incoming::Invalid
        ));
        // 有 id 但既无 result 也无 error → Invalid。
        assert!(matches!(
            classify_message(&json!({"jsonrpc":"2.0","id":5})),
            Incoming::Invalid
        ));
    }

    // FIX-6:直测 answer_permission 真正调用的纯函数,锁定「双层 outcome」回包
    // 形状 + request_id 原样回显(特测数字 0)。旧测试只对手搓字面量自证,零覆盖。
    #[test]
    fn build_permission_response_shapes_double_outcome() {
        // Selected → result.outcome.{outcome:"selected", optionId},id 回显数字 0。
        let resp = build_permission_response(
            &json!(0),
            &PermissionDecision::Selected("allow_always".into()),
        );
        assert_eq!(resp["id"], json!(0), "request_id 必须原样回显(数字 0)");
        assert_eq!(resp["result"]["outcome"]["outcome"], "selected");
        assert_eq!(resp["result"]["outcome"]["optionId"], "allow_always");

        // Cancelled → result.outcome.outcome=="cancelled",无 optionId。
        let resp2 = build_permission_response(&json!("req-1"), &PermissionDecision::Cancelled);
        assert_eq!(resp2["id"], json!("req-1"));
        assert_eq!(resp2["result"]["outcome"]["outcome"], "cancelled");
        assert!(resp2["result"]["outcome"].get("optionId").is_none());
    }

    // ── 以下几条 liveness 测试用内存管道 / dummy 子进程,不需真 agent ──

    /// 构造一个仅持 stdin/child 的最小 AcpClient(不起 reader),用于直测
    /// call_with_timeout / shutdown 的收尾语义。子进程用 `sleep`:开着管道、
    /// 从不产响应也不 EOF。
    async fn dummy_client(secs: &str) -> AcpClient {
        let mut child = Command::new("sleep")
            .arg(secs)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn sleep 应成功");
        let stdin = child.stdin.take().unwrap();
        let (event_tx, event_rx) = mpsc::unbounded_channel::<AgentEvent>();
        AcpClient {
            session_id: String::new(),
            models: Value::Null,
            modes: Value::Null,
            agent_info: Value::Null,
            agent_capabilities: Value::Null,
            stdin: Arc::new(Mutex::new(stdin)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(AtomicI64::new(1)),
            event_tx,
            child: Arc::new(Mutex::new(child)),
            reader_task: std::sync::Mutex::new(None),
            stderr_task: std::sync::Mutex::new(None),
            event_rx: std::sync::Mutex::new(Some(event_rx)),
            closed: Arc::new(AtomicBool::new(false)),
            closed_notify: Arc::new(Notify::new()),
        }
    }

    /// FIX-1:事件 Receiver 全程不 drain,喂 300 条 notification + 末尾 1 条
    /// response;断言那条 response 的 pending oneshot 仍被 resolve。若通道回退
    /// 成 bounded(256),reader 会卡在 send().await → 5s 超时判定失败。
    #[tokio::test]
    async fn reader_not_blocked_by_undrained_events() {
        let mut data: Vec<u8> = Vec::new();
        for _ in 0..300 {
            data.extend_from_slice(br#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x"}}}}"#);
            data.push(b'\n');
        }
        data.extend_from_slice(br#"{"jsonrpc":"2.0","id":99,"result":{"done":true}}"#);
        data.push(b'\n');

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        pending.lock().await.insert(99, tx);
        // Receiver 保活但绝不 drain —— bounded 会在此背压下卡死 reader。
        let (event_tx, _event_rx) = mpsc::unbounded_channel::<AgentEvent>();
        let stdin = Arc::new(Mutex::new(tokio::io::sink()));
        let closed = Arc::new(AtomicBool::new(false));

        tokio::time::timeout(
            Duration::from_secs(5),
            read_loop(
                std::io::Cursor::new(data),
                pending.clone(),
                stdin,
                event_tx,
                closed,
                Arc::new(Notify::new()),
            ),
        )
        .await
        .expect("unbounded 下 reader 不应因事件背压阻塞");

        let got = rx.await.expect("response oneshot 应被 resolve");
        assert_eq!(got.unwrap().get("done").unwrap(), &json!(true));
    }

    /// FIX-5:合法通知行 + 含非法 UTF-8 字节的行 + 合法响应行 → 坏行被跳过、
    /// 之后的响应仍被分派、会话未被杀死。
    #[tokio::test]
    async fn reader_skips_bad_utf8_line_and_keeps_going() {
        let mut data: Vec<u8> = Vec::new();
        data.extend_from_slice(br#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}"#);
        data.push(b'\n');
        // 非法 UTF-8:孤立的 0xFF/0xFE 字节,lines() 下会致命,lossy 下被跳过。
        data.extend_from_slice(b"\xff\xfe not valid utf8 here\n");
        data.extend_from_slice(br#"{"jsonrpc":"2.0","id":7,"result":{"ok":true}}"#);
        data.push(b'\n');

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        pending.lock().await.insert(7, tx);
        let (event_tx, mut event_rx) = mpsc::unbounded_channel::<AgentEvent>();
        let stdin = Arc::new(Mutex::new(tokio::io::sink()));
        let closed = Arc::new(AtomicBool::new(false));

        tokio::time::timeout(
            Duration::from_secs(5),
            read_loop(
                std::io::Cursor::new(data),
                pending.clone(),
                stdin,
                event_tx,
                closed.clone(),
                Arc::new(Notify::new()),
            ),
        )
        .await
        .expect("reader 不应 hang");

        // 坏行未杀会话:首行事件到达 + id=7 的响应仍被分派。
        let ev = event_rx
            .recv()
            .await
            .expect("首个 assistant_delta 事件应到达");
        assert!(matches!(ev, AgentEvent::AssistantDelta { .. }));
        let got = rx.await.expect("坏行之后的响应仍应到达");
        assert_eq!(got.unwrap().get("ok").unwrap(), &json!(true));
        assert!(closed.load(Ordering::SeqCst), "EOF 后应置 closed");
    }

    /// FIX-2:握手超时路径——子进程从不回响应,call_with_timeout 极短 dur 应
    /// 返回 Err 且把该 id 从 pending 清掉(不遗留悬挂 tx)。
    #[tokio::test]
    async fn handshake_timeout_errs_and_clears_pending() {
        let client = dummy_client("30").await;
        let res = client
            .call_with_timeout("initialize", json!({}), Some(Duration::from_millis(50)))
            .await;
        assert!(res.is_err(), "超时应返回 Err");
        assert!(
            res.unwrap_err().contains("timed out"),
            "错误信息应含 timed out"
        );
        assert!(
            client.pending.lock().await.is_empty(),
            "超时后 pending 里该 id 应被清空"
        );
        client.shutdown().await;
    }

    /// FIX-3:pending 里挂着一个 in-flight call,调用 shutdown → 该 call 的 rx
    /// 应得到 Err(被 drain),不 hang;且 closed 置位。
    #[tokio::test]
    async fn shutdown_drains_pending_and_wakes_call() {
        let client = dummy_client("30").await;
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        client.pending.lock().await.insert(42, tx);

        client.shutdown().await;

        let got = tokio::time::timeout(Duration::from_secs(2), rx)
            .await
            .expect("shutdown 后 rx 不应 hang");
        assert!(
            got.expect("oneshot 不应被静默 drop").is_err(),
            "应被 drain 成 Err"
        );
        assert!(client.pending.lock().await.is_empty(), "pending 应被清空");
        assert!(
            client.closed.load(Ordering::SeqCst),
            "shutdown 后应置 closed"
        );
    }

    /// FIX-3:closed 置位后 call() 立即失败,不再往 pending 塞悬挂 tx。
    #[tokio::test]
    async fn call_after_closed_fails_fast() {
        let client = dummy_client("30").await;
        client.closed.store(true, Ordering::SeqCst);
        let res = client.call("initialize", json!({})).await;
        assert!(res.is_err(), "closed 后 call 应立即失败");
        assert!(
            client.pending.lock().await.is_empty(),
            "不应留下悬挂 pending"
        );
        client.shutdown().await;
    }

    // ── 集成冒烟:需要 npx + 已登录 Claude,默认忽略,不进 CI ──
    // 运行:cargo test agent::acp_client::tests::smoke_spawn_real_claude_code -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn smoke_spawn_real_claude_code() {
        let client = AcpClient::spawn(AcpCommand::claude_code(), "/tmp")
            .await
            .expect("spawn claude-code-acp 应成功");
        assert!(!client.session_id.is_empty(), "sessionId 不应为空");
        // agentInfo.name 应为适配器名。
        let name = client
            .agent_info
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        assert!(
            name.contains("claude-code-acp"),
            "agentInfo.name = {}",
            name
        );
        client.shutdown().await;
    }
}
