//! 方案甲 M4:transcript JSONL tailer + 行 → `AgentEvent` 纯映射(镜像聊天内容主数据源)。
//!
//! Claude Code 把会话逐行落盘到 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
//! (append-only,content block 级,实证见 mirror-r2 调研)。本模块:
//! - [`spawn_transcript_tailer`] —— tokio task,byte-offset 轮询增量 tail 该文件,
//!   逐行解析 → [`transcript_line_to_events`] 纯映射 → 经 `event_tx` 喂给 M5 的镜像
//!   fan-out([`register_mirror`](super::manager::AcpAgentManager::register_mirror) 消费端)。
//! - [`TailerHandle`] —— 外部控制柄:M3 的 hook handler 在 Stop/UserPromptSubmit 到达时
//!   `poke_catch_up`(立即增量读,不等 tick);Stop hook 另用 `poke_turn_end` 兜底补发
//!   `TurnComplete`(覆盖 transcript 缺终止 stop_reason 的场景,如用户 Esc 打断)。
//!
//! 硬约束:对 transcript 与 tool-results 文件**只读**,绝不写/创建/改 claude 的任何目录
//! (零 token 硬约束的一部分:镜像绝不影响 claude 本体)。本模块不接线(接线是 M3)。

use std::collections::HashSet;
use std::io::SeekFrom;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::events::AgentEvent;

/// 默认轮询间隔(实证落盘 ≈ 一次 API 往返粒度,350ms 足够顺滑且开销可忽略)。
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(350);

/// tool_result 展示文本截断上限(8 KiB;assistant 正文/thinking 是真实对话内容,不截断)。
pub(crate) const TOOL_RESULT_DISPLAY_LIMIT: usize = 8192;

/// 截断提示后缀(追加在被截断文本之后)。
pub(crate) const TRUNCATION_NOTICE: &str = "\n…(内容过长已截断)";

/// 超大工具输出被外置时,transcript 内联指针文本的固定前缀。
const PERSISTED_OUTPUT_PREFIX: &str = "<persisted-output>";

/// 指针文本里路径前的固定引导词(`… Full output saved to: /abs/path`)。
const PERSISTED_SAVED_TO: &str = "saved to: ";

// ---------------------------------------------------------------------------
// 对外接口(冻结,M3 按此消费)
// ---------------------------------------------------------------------------

/// poke 通道消息:hook 驱动的三种「立即动作」。
enum Poke {
    /// 立即做一次增量 catch-up 读(不等下一个 interval tick)。
    CatchUp,
    /// catch-up 读之后,若轮仍开着 → 兜底补发 `TurnComplete{stop_reason:None}`。
    TurnEnd,
    /// fix4(对话实时展示):MessageDisplay hook 已把本轮 assistant 正文实时下行,
    /// 标记 tailer 跳过本轮 transcript 的 assistant text 块(去重;轮结束自动复位)。
    MarkLiveAssistant,
}

/// tailer 的外部控制柄(M3 的 hook handler 持有)。Clone 共享同一 poke 通道。
#[derive(Clone)]
pub struct TailerHandle {
    poke_tx: mpsc::UnboundedSender<Poke>,
}

impl TailerHandle {
    /// Stop/UserPromptSubmit 等 hook 到达时调用:立即做一次增量 catch-up 读
    /// (不等下一个 interval tick)。tailer 已退出时为 no-op。
    pub fn poke_catch_up(&self) {
        let _ = self.poke_tx.send(Poke::CatchUp);
    }

    /// Stop hook 专用:catch-up 读之后,若「轮仍开着」(自上次 TurnComplete 后
    /// 发过 assistant 内容事件),兜底补发 `TurnComplete{stop_reason:None}`。
    /// (覆盖 transcript 缺终止 stop_reason 的场景,如用户 Esc 打断。)
    pub fn poke_turn_end(&self) {
        let _ = self.poke_tx.send(Poke::TurnEnd);
    }

    /// MessageDisplay hook 到达时调用(fix4):本轮 assistant 正文已由 hook 实时下行,
    /// tailer 对本轮 transcript 的 assistant text 块只记账不发事件(防双份正文);
    /// 轮结束(TurnComplete 发出)自动复位——下一轮若 hook 失联,transcript 全文兜底。
    pub fn mark_live_assistant(&self) {
        let _ = self.poke_tx.send(Poke::MarkLiveAssistant);
    }
}

/// 起一个 transcript tailer task。返回控制柄。
///
/// - `transcript_path`:SessionStart hook 给的绝对路径(文件可能尚不存在,须容忍)。
/// - `event_tx`:镜像事件通道(M3 创建,rx 交 `register_mirror`)。task 结束时 drop
///   → 镜像 fan-out 感知 event_rx 关闭而收尾。
/// - `cancel`:M3 传入(session token 的 child_token,claude 换会话/退出时 M3 取消)。
pub fn spawn_transcript_tailer(
    transcript_path: PathBuf,
    event_tx: mpsc::UnboundedSender<AgentEvent>,
    cancel: CancellationToken,
) -> TailerHandle {
    spawn_transcript_tailer_with_interval(transcript_path, event_tx, cancel, DEFAULT_POLL_INTERVAL)
}

/// [`spawn_transcript_tailer`] 的 interval 参数化版本(仅测试可见的注入点:
/// 缩短轮询以加速集成测,生产恒用 [`DEFAULT_POLL_INTERVAL`])。
fn spawn_transcript_tailer_with_interval(
    transcript_path: PathBuf,
    event_tx: mpsc::UnboundedSender<AgentEvent>,
    cancel: CancellationToken,
    poll_interval: Duration,
) -> TailerHandle {
    let (poke_tx, mut poke_rx) = mpsc::unbounded_channel::<Poke>();
    tokio::spawn(async move {
        let mut state = TailerState::new(transcript_path, event_tx);
        let mut ticker = tokio::time::interval(poll_interval);
        // 读批可能耗时(大文件冷启动 catch-up):错过的 tick 顺延,别突发补跑。
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // poke sender 全 drop 后停用该 select 分支(防 recv 持续返回 None 的忙轮询);
        // tailer 生命周期只由 `cancel` 管,不因 poke 通道关闭而退出。
        let mut poke_open = true;
        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = ticker.tick() => {
                    if !state.catch_up().await { break; }
                }
                poke = poke_rx.recv(), if poke_open => {
                    match poke {
                        Some(Poke::CatchUp) => {
                            if !state.catch_up().await { break; }
                        }
                        Some(Poke::MarkLiveAssistant) => {
                            // fix4:本轮正文已 live 流出,transcript 的 text 块只记账不发。
                            // 同时开轮:live 流不经 tailer,若本轮 transcript 全部 text 被
                            // 跳过且无工具事件,turn_open 不置位会让 Stop 的兜底 TurnComplete
                            // 失效(手机气泡永远 streaming)。hook 到达即证明本轮有内容。
                            state.live_assistant = true;
                            state.turn_open = true;
                        }
                        Some(Poke::TurnEnd) => {
                            // 先追平(同一批处理逻辑):transcript 正常给了 end_turn 时
                            // 会在批末发正常 TurnComplete 并关轮,下面的兜底自然不触发。
                            if !state.catch_up().await { break; }
                            if state.turn_open {
                                if state.event_tx.send(AgentEvent::TurnComplete { stop_reason: None }).is_err() {
                                    break;
                                }
                                state.turn_open = false;
                            }
                            // 轮结束复位 live 标记:下一轮 hook 失联时 transcript 全文兜底。
                            state.live_assistant = false;
                        }
                        None => poke_open = false,
                    }
                }
            }
        }
        // task 结束:隐式 drop event_tx → 镜像 fan-out 的 event_rx 关闭 → 收尾。
    });
    TailerHandle { poke_tx }
}

// ---------------------------------------------------------------------------
// tailer 状态机
// ---------------------------------------------------------------------------

/// tailer 的内部状态:byte offset、半截行缓冲、去重/记账集、轮开合标记。
struct TailerState {
    /// transcript 绝对路径(SessionStart hook 提供)。
    path: PathBuf,
    /// 已消费的 byte offset(增量读起点)。
    offset: u64,
    /// 尾部无 `\n` 的残段缓冲,下次增量读拼上。
    partial: Vec<u8>,
    /// 已见行 uuid 去重集(防御性从头重读时保证不重复发事件)。
    seen_uuids: HashSet<String>,
    /// 已发过 TurnComplete 的 `message.id` 记账(同消息多行同 stop_reason → 只发一次)。
    completed_turns: HashSet<String>,
    /// 「轮开着」= 自上次 TurnComplete 后发过 AssistantDelta / ReasoningDelta /
    /// ToolCallStart / ToolCallUpdate 任一(用户 Ext 消息不算),或本轮已 live 流
    /// (MarkLiveAssistant)。poke_turn_end 兜底的依据。
    turn_open: bool,
    /// fix4(对话实时展示):本轮 assistant 正文已由 MessageDisplay hook 实时下行,
    /// transcript 的 assistant text 块跳过不发(防双份);轮结束复位。冷启动 catch-up
    /// (resume 历史)与 hook 失联轮均为 false → transcript 全文照发(兜底)。
    live_assistant: bool,
    /// fix7(statusline 元信息):最近一次从 transcript 行读到的 meta 值
    /// (model/context_tokens/git_branch/cwd)。任一变化时发对应字段的 `AgentMeta`
    /// (首次读到也算变化;/model 切换、上下文增长、cd 换目录均自动更新)。
    last_meta: TranscriptMeta,
    /// 文件缺失只 log 一次的标记(SessionStart 早于首次落盘属正常,别刷错误日志)。
    missing_logged: bool,
    /// 镜像事件通道(send 失败 = 镜像 fan-out 已收尾,tail 无意义 → task 退出)。
    event_tx: mpsc::UnboundedSender<AgentEvent>,
}

impl TailerState {
    fn new(path: PathBuf, event_tx: mpsc::UnboundedSender<AgentEvent>) -> Self {
        Self {
            path,
            offset: 0,
            partial: Vec::new(),
            seen_uuids: HashSet::new(),
            completed_turns: HashSet::new(),
            turn_open: false,
            live_assistant: false,
            last_meta: TranscriptMeta::default(),
            missing_logged: false,
            event_tx,
        }
    }

    /// 一次增量 catch-up 读:len 增长才读,按 `\n` 切完整行走批处理。
    /// 返回 `false` = event_tx 已断(接收端 drop),tailer 应退出。
    async fn catch_up(&mut self) -> bool {
        let len = match tokio::fs::metadata(&self.path).await {
            Ok(m) => m.len(),
            Err(_) => {
                // 文件尚不存在(SessionStart 早于首次落盘):静待下一 tick。
                if !self.missing_logged {
                    eprintln!(
                        "[mirror-tailer] transcript 尚不存在,等待: {}",
                        self.path.display()
                    );
                    self.missing_logged = true;
                }
                return true;
            }
        };
        if len < self.offset {
            // 防御:实证 append-only,此为异常收缩 → offset 归零、清残段重读;
            // 事件不重发由 seen_uuids 去重集保证。
            eprintln!(
                "[mirror-tailer] transcript 异常收缩({} < {}),从头重读: {}",
                len,
                self.offset,
                self.path.display()
            );
            self.offset = 0;
            self.partial.clear();
        }
        if len == self.offset {
            return true;
        }
        // 只读打开(硬约束:任何路径都不得写 claude 的目录)。
        let mut file = match tokio::fs::File::open(&self.path).await {
            Ok(f) => f,
            Err(_) => return true, // 打开失败(竞态删除等):下一 tick 再试
        };
        if file.seek(SeekFrom::Start(self.offset)).await.is_err() {
            return true;
        }
        let mut buf = Vec::new();
        let n = match file.read_to_end(&mut buf).await {
            Ok(n) => n,
            Err(_) => return true,
        };
        self.offset += n as u64;
        self.partial.extend_from_slice(&buf);

        // 按 \n 切出完整行;尾部残段留缓冲下次拼(claude 写行是原子 append,但读端可能撞半截)。
        let mut lines: Vec<Vec<u8>> = Vec::new();
        let mut start = 0usize;
        for (i, &b) in self.partial.iter().enumerate() {
            if b == b'\n' {
                lines.push(self.partial[start..i].to_vec());
                start = i + 1;
            }
        }
        self.partial.drain(..start);
        if lines.is_empty() {
            return true;
        }
        self.process_batch(lines).await
    }

    /// 处理一个读批(一次增量读切出的所有完整行):逐行解析 → 映射 → 发送;
    /// TurnComplete 精确一次:行产出的 `turn_end` 只记 pending,在消息边界 / 批末统一发。
    /// 返回 `false` = event_tx 已断。
    async fn process_batch(&mut self, lines: Vec<Vec<u8>>) -> bool {
        // 指针解引用的目录约束根:transcript 父目录(实证 tool-results 位于
        // `<同目录>/<sessionId>/tool-results/`,子树覆盖)。无父目录 → 一律不读。
        let allowed_root = self.path.parent().map(Path::to_path_buf);
        // 批内 pending 的轮终止 (message_id, stop_reason)。
        let mut pending: Option<(String, String)> = None;
        for raw in lines {
            // 完整行 parse 失败 → 容错跳过(勿 panic 勿重试;半截行已被上游缓冲挡住)。
            let line: Value = match serde_json::from_slice(&raw) {
                Ok(v) => v,
                Err(_) => continue,
            };
            // uuid 去重:凡带 .uuid 的行入集,已见即跳(覆盖防御性从头重读)。
            if let Some(u) = line.get("uuid").and_then(|v| v.as_str()) {
                if !self.seen_uuids.insert(u.to_string()) {
                    continue;
                }
            }
            // fix7(statusline 元信息):transcript 行自带 model/usage/gitBranch/cwd,
            // 任一变化(含首见)即发携带变化字段的 AgentMeta 旁路信号(/model 切换、
            // 上下文增长、cd 换目录后自动更新)。纯 diff 逻辑抽 [`TranscriptMeta`] 单测。
            if let Some(ev) = self.last_meta.diff_line(&line) {
                if self.event_tx.send(ev).is_err() {
                    return false;
                }
            }
            let outcome = transcript_line_to_events(&line);
            // 消息边界 flush:pending 存在、且本行是「有实际产出的另一消息」→ 先发 pending 的
            // TurnComplete。这样同消息多行(thinking+text 都带 end_turn)时 TurnComplete 必然
            // 排在该消息全部内容事件之后;冷启动一批含多轮时,中间轮的 TurnComplete 也不会被吞。
            // 纯跳过行(events 空且无 turn_end,如 ai-title)不触发 flush,避免夹缝错序。
            if let Some((pending_mid, _)) = &pending {
                let same_message = line.get("type").and_then(|t| t.as_str()) == Some("assistant")
                    && line
                        .get("message")
                        .and_then(|m| m.get("id"))
                        .and_then(|v| v.as_str())
                        == Some(pending_mid.as_str());
                let has_output = !outcome.events.is_empty() || outcome.turn_end.is_some();
                if !same_message && has_output && !self.flush_turn_end(&mut pending) {
                    return false;
                }
            }
            for ev in outcome.events {
                // fix4:本轮正文已由 MessageDisplay hook 实时下行 → transcript 的
                // assistant text 块跳过(防双份正文)。thinking/tool 事件不受影响
                // (hook 不覆盖它们);轮结束(flush_turn_end / poke_turn_end)复位,
                // hook 失联的下一轮回落 transcript 全文。已知取舍:同轮内 hook 只送达
                // 部分批次时,漏掉的批次不再由 transcript 补(概率极低,curl 本机回环)。
                if self.live_assistant && matches!(ev, AgentEvent::AssistantDelta { .. }) {
                    continue;
                }
                // 超大工具输出指针解引用(只影响 ToolCallUpdate,其余原样)。
                let ev = resolve_persisted_output(ev, allowed_root.as_deref()).await;
                // 内容事件开轮(用户 Ext 消息不算——轮的主体是 assistant 的响应)。
                if matches!(
                    ev,
                    AgentEvent::AssistantDelta { .. }
                        | AgentEvent::ReasoningDelta { .. }
                        | AgentEvent::ToolCallStart { .. }
                        | AgentEvent::ToolCallUpdate { .. }
                ) {
                    self.turn_open = true;
                }
                if self.event_tx.send(ev).is_err() {
                    return false;
                }
            }
            if outcome.turn_end.is_some() {
                // 同消息多行覆盖 pending(同 id 同 reason,幂等)。
                pending = outcome.turn_end;
            }
        }
        // 批末:pending 的轮终止统一发(必然在该批全部内容事件之后)。
        self.flush_turn_end(&mut pending)
    }

    /// 发 pending 的 `TurnComplete{stop_reason:Some(..)}`(若该 message_id 未发过),并关轮。
    /// 返回 `false` = event_tx 已断。
    fn flush_turn_end(&mut self, pending: &mut Option<(String, String)>) -> bool {
        if let Some((message_id, reason)) = pending.take() {
            if self.completed_turns.insert(message_id) {
                if self
                    .event_tx
                    .send(AgentEvent::TurnComplete {
                        stop_reason: Some(reason),
                    })
                    .is_err()
                {
                    return false;
                }
            }
            // 无论 insert 成败都关轮:去重命中 = 该轮的 TurnComplete 已发过(同消息的行
            // 被切进两批的实证场景),迟到的同消息内容行不应重新开轮——否则 Stop hook 的
            // poke_turn_end 兜底会对同一轮补发虚假 TurnComplete{stop_reason:None}。
            // 后续真正新消息的内容事件会重新置 turn_open=true,不影响兜底正确性。
            self.turn_open = false;
            // fix4:轮结束复位 live 标记(下一轮 hook 失联时 transcript 全文兜底)。
            self.live_assistant = false;
        }
        true
    }
}

/// 若 ToolCallUpdate 的展示文本是 `<persisted-output>` 指针 → 解析 `saved to: ` 后的
/// 绝对路径,**只读**读入文件内容替换(再走同一截断上限);读失败 → 保留指针原文。
/// 非 ToolCallUpdate / 非指针文本 → 原样返回。
///
/// 安全约束:指针文本可被外部内容影响(工具 stdout 可伪造 `saved to:` 行),故只允许
/// 读 `allowed_root`(transcript 父目录)子树内的文件;越界 / 含 `..` / `None` → 不读,
/// 保留指针原文([`persisted_path_allowed`])。
async fn resolve_persisted_output(ev: AgentEvent, allowed_root: Option<&Path>) -> AgentEvent {
    let AgentEvent::ToolCallUpdate {
        id,
        status,
        content,
        diff,
    } = ev
    else {
        return ev;
    };
    // content 是本模块构造的单 text block 数组,抽其文本判断指针前缀。
    let pointer_path: Option<String> = content
        .as_ref()
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str())
        .filter(|text| text.starts_with(PERSISTED_OUTPUT_PREFIX))
        .and_then(parse_persisted_path)
        .map(str::to_string);
    if let Some(path) = pointer_path {
        let candidate = Path::new(&path);
        // 越界路径不读(保留指针原文);读失败(文件被清理等)同样保留原文,
        // 好歹告诉用户输出去哪了。
        if allowed_root.is_some_and(|root| persisted_path_allowed(candidate, root)) {
            if let Ok(bytes) = tokio::fs::read(candidate).await {
                let full = String::from_utf8_lossy(&bytes);
                let replaced = truncate_display_text(&full, TOOL_RESULT_DISPLAY_LIMIT);
                return AgentEvent::ToolCallUpdate {
                    id,
                    status,
                    content: Some(json!([{"type": "text", "text": replaced}])),
                    diff,
                };
            }
        }
    }
    AgentEvent::ToolCallUpdate {
        id,
        status,
        content,
        diff,
    }
}

/// 指针路径安全判定:必须是绝对路径、**组件级**不含 `..`(`..` 在 `Path::starts_with`
/// 的组件比较下仍可字面命中前缀,故须先拒),且以 `allowed_root` 为前缀
/// (`Path::starts_with` 组件语义,非字符串前缀——防 `/a/bc` 命中 `/a/b`)。
fn persisted_path_allowed(path: &Path, allowed_root: &Path) -> bool {
    path.is_absolute()
        && !path.components().any(|c| matches!(c, Component::ParentDir))
        && path.starts_with(allowed_root)
}

/// 从指针文本解析外置文件绝对路径(`… Full output saved to: /abs/path` 的 path 部分,
/// 取到行尾并 trim)。无 `saved to: ` 引导词 → None。
pub(crate) fn parse_persisted_path(text: &str) -> Option<&str> {
    let idx = text.find(PERSISTED_SAVED_TO)?;
    let rest = &text[idx + PERSISTED_SAVED_TO.len()..];
    let end = rest.find('\n').unwrap_or(rest.len());
    let path = rest[..end].trim();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

// ---------------------------------------------------------------------------
// fix7:transcript 行 → statusline 元信息 diff(纯逻辑,单测对象)
// ---------------------------------------------------------------------------

/// transcript 行携带的 statusline 元信息(model / context tokens / git branch / cwd)
/// 的最近值缓存 + 行级 diff。任一字段变化(含首见)→ 产出只带**变化字段**的 AgentMeta
/// (未变化字段为 None,手机侧按非空合并;effort 不经 transcript,恒 None)。
#[derive(Default)]
pub(crate) struct TranscriptMeta {
    model: Option<String>,
    context_tokens: Option<u64>,
    git_branch: Option<String>,
    cwd: Option<String>,
}

impl TranscriptMeta {
    /// 对一条 transcript 行做 meta diff(无变化 → None):
    /// - `gitBranch`/`cwd` 是行级信封字段(user/assistant 行都带);
    /// - `model` 与 usage 仅 assistant 行有(`message.model` / `message.usage`);
    /// - context_tokens = usage 的 input + cache_read + cache_creation
    ///   (= 本轮请求 prompt 大小,ccstatusline/ccusage 同款口径;窗口大小手机按模型判定);
    /// - sidechain 行(子代理)整行跳过——其 usage/cwd 不属于主会话。
    pub(crate) fn diff_line(&mut self, line: &Value) -> Option<AgentEvent> {
        if line.get("isSidechain").and_then(|v| v.as_bool()) == Some(true) {
            return None;
        }
        let mut model = None;
        let mut context_tokens = None;
        let mut git_branch = None;
        let mut cwd = None;

        // 信封字段:任何主线行都可能带。gitBranch 的 "HEAD" 是无信息量哨兵值
        // (无 git 仓库 / detached HEAD 时 claude 落的),按缺失处理不下发(真机反馈:
        // 非 git 目录 statusline 显示 "⎇ HEAD" 纯属误导)。
        if let Some(b) = line
            .get("gitBranch")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty() && *s != "HEAD")
        {
            if self.git_branch.as_deref() != Some(b) {
                self.git_branch = Some(b.to_string());
                git_branch = Some(b.to_string());
            }
        }
        if let Some(c) = line
            .get("cwd")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            if self.cwd.as_deref() != Some(c) {
                self.cwd = Some(c.to_string());
                cwd = Some(c.to_string());
            }
        }
        // assistant 行独有:model + usage。
        if line.get("type").and_then(|v| v.as_str()) == Some("assistant") {
            let msg = line.get("message");
            if let Some(m) = msg
                .and_then(|m| m.get("model"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                if self.model.as_deref() != Some(m) {
                    self.model = Some(m.to_string());
                    model = Some(m.to_string());
                }
            }
            if let Some(u) = msg.and_then(|m| m.get("usage")) {
                let total: u64 = [
                    "input_tokens",
                    "cache_read_input_tokens",
                    "cache_creation_input_tokens",
                ]
                .iter()
                .filter_map(|k| u.get(k).and_then(|v| v.as_u64()))
                .sum();
                // total==0(usage 缺失/全零)不更新:半截 usage 不如上一个真值。
                if total > 0 && self.context_tokens != Some(total) {
                    self.context_tokens = Some(total);
                    context_tokens = Some(total);
                }
            }
        }
        if model.is_none() && context_tokens.is_none() && git_branch.is_none() && cwd.is_none() {
            return None;
        }
        Some(AgentEvent::AgentMeta {
            model,
            effort: None,
            context_tokens,
            git_branch,
            cwd,
        })
    }
}

// ---------------------------------------------------------------------------
// 纯映射:transcript 行 → AgentEvent(不做 I/O,单测主对象)
// ---------------------------------------------------------------------------

/// 单行 transcript JSON 的映射产物:0..n 个事件 + 可选轮终止信号。
pub(crate) struct LineOutcome {
    pub events: Vec<AgentEvent>,
    /// `Some((message_id, stop_reason))` 当 assistant 行 stop_reason ∈ {end_turn, stop_sequence}。
    /// TurnComplete 不在此直接产出,由 tailer 状态机在消息边界/批末统一发(精确一次)。
    pub turn_end: Option<(String, String)>,
}

impl LineOutcome {
    fn empty() -> Self {
        Self {
            events: Vec::new(),
            turn_end: None,
        }
    }
}

/// 单行 transcript JSON → `LineOutcome`。纯函数,字段路径以 mirror-r2 实证为准。
///
/// 信封过滤:`.isSidechain == true`(子代理内容)全跳过;无 `.type` 跳过。
/// system / attachment / file-history-snapshot / ai-title / 未知 type 等一律**静默跳过**
/// (不发 Ext——别把 transcript 原始行灌给手机)。
pub(crate) fn transcript_line_to_events(line: &Value) -> LineOutcome {
    if line.get("isSidechain").and_then(|v| v.as_bool()) == Some(true) {
        return LineOutcome::empty();
    }
    match line.get("type").and_then(|v| v.as_str()) {
        Some("assistant") => map_assistant_line(line),
        Some("user") => map_user_line(line),
        _ => LineOutcome::empty(),
    }
}

/// assistant 行:content 实测恒单 block(块级落盘),按 `content[0]` 取并容忍空数组。
/// 轮终止判定是**行级**属性(每行都带完整 stop_reason),与 block 型无关。
fn map_assistant_line(line: &Value) -> LineOutcome {
    let msg = line.get("message");
    let mut events = Vec::new();
    if let Some(block) = msg
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
    {
        match block.get("type").and_then(|t| t.as_str()) {
            Some("text") => events.push(AgentEvent::AssistantDelta {
                text: block
                    .get("text")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string(),
            }),
            // claude 的 thinking block 常只落 signature、明文 thinking 为空串
            //(extended thinking 内容加密不写 transcript)。空 thinking 跳过,不发空
            // ReasoningDelta——否则镜像 AI 页每轮冒一个空"思考过程"气泡。
            Some("thinking") => {
                let t = block.get("thinking").and_then(|t| t.as_str()).unwrap_or("");
                if !t.is_empty() {
                    events.push(AgentEvent::ReasoningDelta {
                        text: t.to_string(),
                    });
                }
            }
            Some("tool_use") => events.push(AgentEvent::ToolCallStart {
                id: block
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                title: block
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                // transcript 无 ACP kind 语义,留空由手机端按 title 渐进增强。
                kind: None,
                raw_input: block.get("input").cloned().unwrap_or(Value::Null),
            }),
            // 未知 block 型(server_tool_use 等新增型)→ 静默跳过。
            _ => {}
        }
    }
    let turn_end = match msg
        .and_then(|m| m.get("stop_reason"))
        .and_then(|v| v.as_str())
    {
        Some(reason @ ("end_turn" | "stop_sequence")) => msg
            .and_then(|m| m.get("id"))
            .and_then(|v| v.as_str())
            .map(|id| (id.to_string(), reason.to_string())),
        _ => None,
    };
    LineOutcome { events, turn_end }
}

/// user 行:两种形态——content 为 string(真实用户输入)/ 为数组(text·image·tool_result)。
/// `.isMeta == true`(注入的非用户消息)与斜杠命令回显整行跳过。
fn map_user_line(line: &Value) -> LineOutcome {
    let mut out = LineOutcome::empty();
    if line.get("isMeta").and_then(|v| v.as_bool()) == Some(true) {
        return out;
    }
    match line.get("message").and_then(|m| m.get("content")) {
        // 用户原文(string)。
        Some(Value::String(text)) => {
            if !text.is_empty() && !is_command_echo(text) {
                out.events.push(user_text_event(text));
            }
        }
        Some(Value::Array(blocks)) => {
            let results: Vec<&Value> = blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
                .collect();
            if !results.is_empty() {
                // 工具结果:每个 tool_result block 一条 ToolCallUpdate(并行工具一行多果)。
                for block in results {
                    out.events.push(tool_result_event(block, line));
                }
            } else {
                // 用户原文(array):拼接全部 text block(image 等忽略),空串跳过。
                let joined: String = blocks
                    .iter()
                    .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect();
                if !joined.is_empty() && !is_command_echo(&joined) {
                    out.events.push(user_text_event(&joined));
                }
            }
        }
        _ => {}
    }
    out
}

/// 斜杠命令回显判定:含 `<command-…>` / `<local-command-…>` 包裹 → 非真人对话,整行跳过。
fn is_command_echo(text: &str) -> bool {
    text.contains("<command-") || text.contains("<local-command-")
}

/// 用户消息 → Ext 事件。**冻结契约**:`{"kind":"user","text":…}`,M8 手机端按此渲染 user 气泡。
fn user_text_event(text: &str) -> AgentEvent {
    AgentEvent::Ext {
        raw: json!({"kind": "user", "text": text}),
    }
}

/// 单个 tool_result block → `ToolCallUpdate`(content 归一成单 text block 数组并截断)。
fn tool_result_event(block: &Value, line: &Value) -> AgentEvent {
    let id = block
        .get("tool_use_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // is_error 缺省 → completed。
    let status = if block.get("is_error").and_then(|v| v.as_bool()) == Some(true) {
        "failed"
    } else {
        "completed"
    };
    let text = truncate_display_text(&tool_result_text(block, line), TOOL_RESULT_DISPLAY_LIMIT);
    AgentEvent::ToolCallUpdate {
        id,
        status: Some(status.to_string()),
        content: Some(json!([{"type": "text", "text": text}])),
        diff: None,
    }
}

/// tool_result 的展示文本归一化(未截断):
/// content 为 string → 直接用;为数组 → 抽 text block 拼接;
/// 缺失/空 → 回退行级 `.toolUseResult`(string 直接用;object 优先取 `.stdout` string,
/// 否则整对象 `to_string`)。
fn tool_result_text(block: &Value, line: &Value) -> String {
    match block.get("content") {
        Some(Value::String(s)) if !s.is_empty() => return s.clone(),
        Some(Value::Array(arr)) => {
            let joined: String = arr
                .iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect();
            if !joined.is_empty() {
                return joined;
            }
        }
        _ => {}
    }
    // 回退:行级 .toolUseResult(结构化结果,比 content 更全)。
    match line.get("toolUseResult") {
        Some(Value::String(s)) => s.clone(),
        Some(v @ Value::Object(map)) => match map.get("stdout").and_then(|s| s.as_str()) {
            Some(stdout) => stdout.to_string(),
            None => serde_json::to_string(v).unwrap_or_default(),
        },
        _ => String::new(),
    }
}

/// 展示文本截断:超过 `limit` 字节则在 **char 边界**截断并追加 [`TRUNCATION_NOTICE`]。
/// 恰好等于上限不截断。纯函数,便于单测边界。
pub(crate) fn truncate_display_text(s: &str, limit: usize) -> String {
    if s.len() <= limit {
        return s.to_string();
    }
    let mut end = limit;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{}", &s[..end], TRUNCATION_NOTICE)
}

// ---------------------------------------------------------------------------
// Tests(拆独立文件,保持两文件都 <1000 行,同 manager.rs 拆法)
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "mirror_tests.rs"]
mod mirror_tests;
