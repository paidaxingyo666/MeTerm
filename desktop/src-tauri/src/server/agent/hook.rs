//! 方案甲 M3:`POST /api/agent-hook` 端点 + SessionStart 升格镜像(接线层)。
//!
//! M2 注入的转发脚本把 claude hooks(8 个观察者事件,含 Task D 的 SessionEnd)POST 到本端点
//! (loopback、无 Bearer,header 带 `X-Meterm-Session`/`X-Meterm-Secret`/`X-Meterm-Hook-Event`,
//! body = hook stdin JSON 原样)。本模块做五件事(**hook 零内容事件**——聊天内容 100% 走
//! M4 transcript tailer):
//!
//! 1. **升格**:SessionStart 时把 PTY 会话升格为镜像会话——起 M4 tailer + 调 M5
//!    `register_mirror`。**每 PTY 会话至多一个镜像 entry**:claude 换会话(同 PTY 重跑/嵌套/
//!    resume)只换 tailer 不换 entry([`MirrorRegistry`] 常驻一份 event_tx clone,fan-out 的
//!    rx 不关闭、已 attach 客户端不断流)——从设计上绕开 `register_mirror` 重复注册的
//!    「HashMap 覆盖 + 旧 fan-out 收尾误删新 entry」坑。
//! 2. **催读**:UserPromptSubmit / PreToolUse / PostToolUse → [`TailerHandle::poke_catch_up`];
//!    Stop / StopFailure → [`TailerHandle::poke_turn_end`](内部先 catch-up 再兜底补
//!    `TurnComplete{None}`)。
//! 3. **退出清理(Task D)**:SessionEnd(claude 正常退出)+ OSC 7768 顶层 prompt 兜底
//!    (硬退出:SIGKILL/崩溃)→ [`MirrorRegistry::cleanup`] 幂等清理:先发
//!    [`AgentEvent::MirrorEnded`] 再停 tailer、清 registry 与回调槽,镜像 entry 自回收——
//!    根治「claude 退出后镜像不回收、重进回放旧对话」。
//! 4. **感知通知(修 #2)**:Notification(claude 需要用户确认/输入)→ **仅镜像态**会话
//!    把 body 的 `message` 经常驻 event_tx 下行 [`AgentEvent::Notify`](冻结契约
//!    `{"type":"notify","message":"…"}`);非镜像 no-op,只读转发不注入(零 token)。
//! 5. **安全双闸(fail-closed)**:①acceptor 标记必须是可信的本机直连入口
//!    `DirectLoopback`(**不管 lan_sharing 开关**);LAN 和中继子流即使伪装/占位地址为
//!    loopback 也会被拒绝;②`X-Meterm-Session`+`X-Meterm-Secret` 经
//!    [`HookSecretRegistry::verify`](crate::server::hook_secret::HookSecretRegistry::verify)
//!    常量时间校验(只有 local-shell 会话登记过 secret,SSH/WSL 天然被拒)。二闸都过才解析 body。
//!
//! **零 token(硬约束)**:除 PermissionRequest 审批桥外,handler 响应恒为**空 body**
//! (不含任何 hook 输出字段——additionalContext / updatedInput / systemMessage 等一概
//! 不存在);不写 claude 任何文件。SessionStart 是同步 hook(async:false,claude 阻塞
//! 等响应,curl 2s 封顶),该分支只做 spawn/insert,**秒回**。
//! **唯一 body 白名单 = PermissionRequest**(P2 审批桥,设计 §4.7 明确豁免):手机决策后
//! 返回 decision JSON(allow 零注入 / deny 带固定拒绝原因);超时/异常一律空响应回落
//! 原生 TUI 弹窗。见 [`handle_permission_request`]。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::Extension;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use super::events::{AgentEvent, PermissionOption};
use super::manager::{AcpAgentManager, AgentKind};
use super::mirror::{spawn_transcript_tailer, TailerHandle};
use super::permission_bridge::{PermissionBridge, PermissionReply};
use crate::server::events::EventBus;
use crate::server::session::manager::SessionManager;
use crate::server::session::Session;
use crate::server::ServerState;

// ---------------------------------------------------------------------------
// MirrorRegistry —— PTY 会话 → 镜像状态(每 PTY 至多一个)
// ---------------------------------------------------------------------------

/// 单个 PTY 会话的镜像状态:当前 claude 会话身份 + 在跑的 tailer 柄。
///
/// `event_tx` 是镜像事件通道的**常驻 clone**(entry 生命周期锚):claude 换会话时旧 tailer
/// 被 cancel、drop 它那份 tx,但本 clone 让 fan-out 的 `event_rx` 保持打开——entry 不收尾、
/// 已 attach 客户端不断流,聊天时间线跨 claude 会话延续(同一 PTY 的镜像心智模型)。
struct MirrorState {
    /// 当前 claude 会话 uuid(hook body 的 `session_id`)。
    claude_session_id: String,
    /// 当前 transcript 绝对路径(hook body 的 `transcript_path`)。
    transcript_path: PathBuf,
    /// 在跑 tailer 的控制柄(poke 催读用)。
    tailer: TailerHandle,
    /// 在跑 tailer 的取消令牌(session 全 token 的 child_token;换会话/清扫时 cancel)。
    tailer_cancel: CancellationToken,
    /// 镜像事件通道的常驻 clone(见 struct 注释)。
    event_tx: mpsc::UnboundedSender<AgentEvent>,
    /// 本段镜像的落位时刻(首次升格 / 换会话时刷新)。7768 兜底路径的 1s 守卫据此判定:
    /// 升格瞬间的滞后 prompt 帧(<1s)忽略,存续 ≥1s 后的顶层 prompt 才视为 claude 真退出。
    upgraded_at: Instant,
    /// fix10:最近一次下发的 effort(任何 hook 事件的 X-Meterm-Effort header 统一 diff,
    /// 值变才下发——/effort 切换后任一后续 hook 事件即刷新,不再等下一条真 prompt)。
    last_effort: Option<String>,
}

/// 7768 兜底的忽略窗口:升格后 1s 内到达的 ShellState 视为「敲 `claude` 前那个 prompt 的
/// 滞后残留帧」,不触发清理。依据:SessionStart hook 由 claude 启动后发出,此前 prompt 的
/// 7768 与 claude 启动输出在同一 PTY 字节流上 FIFO 先行,但 hook 走 HTTP 异步到达,与
/// run loop 的字节流处理是两条时间线,残留帧可能在升格之后才被消费——实测该滞后 <100ms,
/// 1s 余量充足;而正常 claude 会话远长于 1s,不会误吞真退出信号。
const PROMPT_GUARD: Duration = Duration::from_secs(1);

/// cleanup 的触发路径守卫(FIX-1):两条退出信号路径的「陈旧信号」判据不同,枚举显式表达,
/// 杜绝「SessionEnd 无守卫直清」的误清面。
enum CleanupGuard<'a> {
    /// SessionEnd 路径:hook body 携带的 claude 会话 uuid 必须与 registry 当前
    /// `claude_session_id` 相等才清。不等 = 换会话竞态下的陈旧信号(/clear 时 claude 同发
    /// SessionEnd(旧 sid)+ SessionStart(新 sid),async 的 SessionEnd 可滞后数秒;
    /// SessionStart 先处理则 entry 已换代)→ no-op。身份精确匹配后无需 min_age 守卫:
    /// SessionEnd 只在**该** claude 真退出时发出,匹配即真退出。
    MatchClaudeSid(&'a str),
    /// 7768 兜底路径:顶层 prompt 帧不携带 claude 身份,以 MirrorState 存续时长为准——
    /// 升格瞬间的滞后 prompt 帧(存续 < min_age)忽略,见 [`PROMPT_GUARD`]。
    MinAge(Duration),
}

/// 镜像状态注册表 —— `PTY session_id -> MirrorState` 的线程安全映射。
///
/// `Clone` 共享内部 `Arc<Mutex<..>>`(仿 [`HookSecretRegistry`](crate::server::hook_secret::HookSecretRegistry)
/// 范式)。生命周期终点 = PTY 会话死亡:显式 delete 走 [`Self::remove_and_cancel`];
/// reap 路径不接线(SessionManager 够不着本表),残条目由 [`Self::sweep_dead`] 在下一次
/// SessionStart 前懒清扫——泄漏被限定在「死会话到下一次 SessionStart 之间」,量级每条
/// 几百字节,可接受。
#[derive(Clone)]
pub struct MirrorRegistry {
    inner: Arc<Mutex<HashMap<String, MirrorState>>>,
}

impl MirrorRegistry {
    /// 新建空注册表。
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 移除某 PTY 会话的镜像状态并取消其 tailer(会话显式销毁时调用;不存在即 no-op)。
    /// cancel 是防御性的:delete 路径下 session 全 token 已 cancel,child token 本会级联,
    /// 显式再 cancel 一次幂等无害,且覆盖「registry 条目与会话 token 意外脱钩」的异常。
    pub fn remove_and_cancel(&self, session_id: &str) {
        if let Some(st) = self.inner.lock().unwrap().remove(session_id) {
            st.tailer_cancel.cancel();
        }
    }

    /// 懒清扫:移除 registry 中指向已死会话(`session_manager.get(id).is_none()`)的残条目,
    /// 并防御性 cancel 其 tailer。每次 SessionStart 处理前顺手调用(reap 路径的兜底回收)。
    fn sweep_dead(&self, session_manager: &SessionManager) {
        self.inner.lock().unwrap().retain(|sid, st| {
            if session_manager.get(sid).is_some() {
                true
            } else {
                st.tailer_cancel.cancel();
                false
            }
        });
    }

    /// 取某 PTY 会话在跑 tailer 的柄(poke 催读用);无镜像状态 → None。
    fn tailer(&self, session_id: &str) -> Option<TailerHandle> {
        self.inner
            .lock()
            .unwrap()
            .get(session_id)
            .map(|st| st.tailer.clone())
    }

    /// 取某 PTY 会话镜像事件通道的常驻 tx clone(修 #2:Notification 下行用);
    /// 无镜像状态(非镜像会话 / 已清理)→ None,调用方 no-op。
    fn event_tx(&self, session_id: &str) -> Option<mpsc::UnboundedSender<AgentEvent>> {
        self.inner
            .lock()
            .unwrap()
            .get(session_id)
            .map(|st| st.event_tx.clone())
    }

    /// fix10:effort diff 记账——值变(含首见)返回 true 并更新;同值 / 无镜像 → false。
    /// 调用方据此决定是否下发 AgentMeta{effort}(每事件调用,零重复帧)。
    fn update_effort(&self, session_id: &str, effort: &str) -> bool {
        let mut map = self.inner.lock().unwrap();
        match map.get_mut(session_id) {
            Some(st) if st.last_effort.as_deref() != Some(effort) => {
                st.last_effort = Some(effort.to_string());
                true
            }
            _ => false,
        }
    }

    /// SessionStart 编排(决策 1 核心)。全程持锁但**无任何 await/阻塞 I/O**
    /// (spawn_transcript_tailer / register_mirror 都只 spawn task 即返回),
    /// 秒回之余还天然互斥并发 SessionStart(同 PTY 两个 claude 抢跑)。
    ///
    /// - **首次**(registry 无该 PTY id):建通道 → 存常驻 tx clone → 起 tailer →
    ///   `register_mirror`(rx 交 fan-out)。
    /// - **换会话**(claude_session_id 或 transcript_path 变了):cancel 旧 tailer →
    ///   用同一通道的 tx clone + 新 child_token 起新 tailer → 更新状态。**不动 entry、
    ///   不重 register**。
    /// - **同会话重入**(compact 等,两者都没变):只 `poke_catch_up`。
    fn handle_session_start(
        &self,
        pty_sid: &str,
        claude_sid: &str,
        transcript_path: PathBuf,
        session: Arc<Session>,
        agents: &AcpAgentManager,
        event_bus: EventBus,
        bridge: &PermissionBridge,
    ) {
        let mut map = self.inner.lock().unwrap();
        // 竞态复查(锁内、零 await):handler 的 `session_manager.get` 返回 Some 之后、
        // 走到这里之前,并发 delete_session 可能已完整跑完(manager.delete 先 cancel 全
        // token,随后才 remove_and_cancel 清本表)。两侧收敛于本锁:
        // - 锁内看到 token 已取消 ⇒ 会话已死,直接放弃(不插 stale 条目、不建 entry);
        // - 锁内看到 token 未取消 ⇒ 对方的 remove_and_cancel 尚未拿锁,必在本次插表
        //   之后执行,能收走刚插的条目并 cancel 其 tailer——两个方向都不残留。
        if session.cancellation_token().is_cancelled() {
            return;
        }
        // Task D:设置/刷新 7768 兜底回调(首次升格 + 换会话都要;重入重设幂等无害)。
        // **无循环引用论证**:本闭包被 Session 持有,故只捕获 Weak<Session>(清槽用)+
        // MirrorRegistry clone(内部 Arc<Mutex<HashMap>>,MirrorState 不持 Session)+
        // session_id String——绝不捕获 Arc<ServerState> 或 Arc<Session>(否则
        // Session→闭包→ServerState→session_manager→Session 成环,Arc 永不归零泄漏)。
        // 锁序:此处持 registry 锁再拿槽锁(registry→槽),与 cleanup(FIX-3 后同为
        // registry 锁内清槽,同向)一致;run loop 取槽锁只 clone 即释放、锁外才调回调,
        // 不存在反向嵌套,无 ABBA 死锁。
        {
            let registry = self.clone();
            // 审批桥 clone(内部 Arc<Mutex<HashMap<String, oneshot>>>,不持 Session/
            // ServerState,不破坏本闭包的无循环引用论证):7768 硬退出路径也要 drain
            // 该会话的在飞审批(sender drop → hook handler 空响应回落 TUI)。
            let bridge = bridge.clone();
            let weak = Arc::downgrade(&session);
            let sid = pty_sid.to_string();
            *session.on_shell_prompt.lock().unwrap() = Some(Arc::new(move |exit: i32| {
                // FIX-4:回 prompt ≠ claude 退出——Ctrl+Z 挂起(SIGTSTP)/ SIGSTOP 停止同样
                // 让顶层 shell 回 prompt,但 fg 可恢复,不得清镜像(否则恢复后镜像已死,且无
                // SessionStart 重建)。precmd 的 `$?`(7768 首字段)此时 = 128+信号值:
                // SIGTSTP macOS(18)=146 / Linux(20)=148,SIGSTOP macOS(17)=145 / Linux(19)=147,
                // 这四个码一律跳过;fg 后 claude 真退出,下一个 prompt 的 7768 携带正常退出码
                // (0 / 130 / 137 …),走正常清理。
                if matches!(exit, 145..=148) {
                    return;
                }
                // 升级失败 = 会话已销毁(run loop 已停,实际到不了这);残条目由 sweep_dead 兜底。
                let s = weak.upgrade();
                if registry.cleanup(s.as_deref(), &sid, CleanupGuard::MinAge(PROMPT_GUARD)) {
                    bridge.drain_session(&sid);
                }
            }));
        }
        match map.get_mut(pty_sid) {
            // 首次 SessionStart:升格为镜像会话。
            None => {
                let (event_tx, event_rx) = mpsc::unbounded_channel::<AgentEvent>();
                // tailer 的 cancel 必须是 session 全 token 的 child_token(mirror.rs:80 契约):
                // 会话死亡级联停 tailer;换会话时只 cancel child 不伤全 token。
                let tailer_cancel = session.cancellation_token().child_token();
                let entry = agents.register_mirror(
                    pty_sid.to_string(),
                    event_rx,
                    session.clone(),
                    event_bus,
                );
                // MirrorStarted:register_mirror 编排完成后、tailer spawn **之前**入队——
                // claude 启动、镜像已建的下行信号,手机据此从欢迎态切镜像态,覆盖「刚起还
                // 没输 prompt、transcript 零事件」的窗口(hook 零内容事件,tailer 零发射,
                // 否则手机收不到任何 0x50 事件)。先于 tailer spawn 发送 = mpsc FIFO 结构性
                // 保证它排在任何 transcript 内容事件之前;fan-out 入 history,晚 attach 的
                // 客户端回放也能收到。
                let _ = event_tx.send(AgentEvent::MirrorStarted);
                // 升格补 attach(缺口修复):fan-out 只投 attached 集合,而 attach 原本只在
                // 连接建立时发生(ws.rs 步骤6 / ipc_terminal 连接段,彼时 agents 表无 entry
                // → 走 else 分支不 attach);本分支新建 entry 的 attached 为**空**。不补则
                // 升格前已连接的 client 收不到 MirrorStarted 与其后全部镜像事件,只有断线
                // 重连才靠 history 回放看到——真机表现:用户坐在会话里点「启动」,claude
                // 起来但 Agent 页永远「未运行」;「mirror_ended 后秒起新 claude」同理停在
                // welcome(新 entry attached 又是空)。故对该 session 当前全部 connected
                // client 逐个 spawn `entry.attach`(背压回放 + 原子登记进 attached)。
                // - **锁纪律**:attach 是长 await,绝不能在本 registry 锁内同步等;这里持锁
                //   只做「收集 client 列表 + spawn」(两者都非阻塞),真正的回放在锁外任务
                //   里跑。锁嵌套新增 registry→session.clients 一个方向,反向(持 clients 锁
                //   调 MirrorRegistry)全库无call site,无 ABBA。
                // - is_connected 过滤只是省掉必然白跑的 spawn:漏网的刚断线 client 在
                //   attach 的 send_async 返回 false 时自然放弃,无害。
                // - **与连接时 attach 的竞态(由 attach_client 内建双守卫收敛)**:client 恰在
                //   升格瞬间连接/重连(已入 session.clients、其 ws.rs 步骤6 尚未执行)会被两路
                //   各发起一次 attach(同 client 同 conn_gen)。裁决在 attach_client 内(见其
                //   函数级说明),按两路的时序分两种:
                //   ① 顺序(典型):本路补 attach 通道有容量、几乎瞬时完成,步骤6 的 attach
                //     几十 ms 后才到 → 命中「同 conn_gen 幂等守卫」直接 no-op——历史已在同一条
                //     通道上精确一次送达、live 由 fan-out 接续,**零重复**(修复前该路从头整段
                //     重放,claude --resume 的 catch-up 首批几十帧全数重发 → 手机重复气泡)。
                //   ② 并发在飞:per-client in-flight 代次互斥,后登记者独占回放、先登记者在
                //     校验点 abort(停发余帧、不插 attached)→ 重复范围 = 先登记者已发出的帧。
                //     该界以**先登记者被顶替时刻**的已发量为准:两路都只在起飞早期可能在飞
                //     (通道 1024 槽,几帧的回放不会背压滞留),彼时 history 至多含 MirrorStarted
                //     一帧(tailer 尚未 spawn/刚 spawn),故最坏重复该一帧,手机 mirrorStarted
                //     归约幂等(mode 已 mirror 再翻 no-op、零聊天条目)。
                //   attached 按 client_id 单条登记,双插同 id 不破「精确一次」集合语义;BUG-1
                //   起始 remove + BUG-2 conn_gen 守卫对本路径同样生效(重连中的 client 由新
                //   conn_gen 的 attach 接管,陈旧任务自 abort),与上述双守卫叠加语义见
                //   agent::manager 模块级说明。
                let connected: Vec<_> = session
                    .clients
                    .lock()
                    .unwrap()
                    .values()
                    .filter(|c| c.is_connected())
                    .cloned()
                    .collect();
                for client in connected {
                    let entry = entry.clone();
                    tokio::spawn(async move { entry.attach(&client).await });
                }
                let tailer = spawn_transcript_tailer(
                    transcript_path.clone(),
                    event_tx.clone(),
                    tailer_cancel.clone(),
                );
                map.insert(
                    pty_sid.to_string(),
                    MirrorState {
                        claude_session_id: claude_sid.to_string(),
                        transcript_path,
                        tailer,
                        tailer_cancel,
                        event_tx,
                        upgraded_at: Instant::now(),
                        last_effort: None,
                    },
                );
            }
            // claude 换会话(重跑/嵌套/resume/clear):只换 tailer,不换 entry。
            Some(st)
                if st.claude_session_id != claude_sid || st.transcript_path != transcript_path =>
            {
                st.tailer_cancel.cancel(); // 旧 tailer 退出并 drop 它那份 tx
                let tailer_cancel = session.cancellation_token().child_token();
                // 换会话同样发一次 MirrorStarted(新 tailer spawn 之前,先于新 transcript
                // 内容事件):手机若已被 mirror_ended / 宽限自愈落回 welcome,可被拉回
                // mirror;若仍在 mirror 则 no-op 语义(信号事件不产生聊天条目)。
                // 同 sid 重入分支(compact,下方 poke_catch_up)**不发**——身份未变。
                let _ = st.event_tx.send(AgentEvent::MirrorStarted);
                // 用 registry 常驻的同一 event_tx 再 clone → fan-out 的 rx 不关闭,不断流。
                let tailer = spawn_transcript_tailer(
                    transcript_path.clone(),
                    st.event_tx.clone(),
                    tailer_cancel.clone(),
                );
                st.claude_session_id = claude_sid.to_string();
                st.transcript_path = transcript_path;
                st.tailer = tailer;
                st.tailer_cancel = tailer_cancel;
                // 刷新守卫基准:若 7768 处理滞后于新 claude 的 SessionStart(退出→秒起新
                // claude 的竞态),滞后的顶层 prompt 帧落在刷新后 1s 内,被守卫忽略,
                // 不误清刚换上的新镜像。
                st.upgraded_at = Instant::now();
            }
            // 同会话重入(compact 等):只催一次增量读。
            Some(st) => st.tailer.poke_catch_up(),
        }
    }

    /// 幂等清理核心(Task D:SessionEnd hook 与 7768 兜底共用)。锁内 take:不在表 = 已清
    /// (SessionEnd 与 7768 谁先到谁清,后到者 miss)→ no-op 返回 false。
    ///
    /// `guard` 守卫(FIX-1,见 [`CleanupGuard`]):SessionEnd 路径比对 claude 会话身份
    /// (陈旧信号 no-op),7768 路径按 MirrorState 存续时长判滞后帧。
    ///
    /// 清理链条(顺序关键):锁内 remove → **先发 MirrorEnded**(fan-out 此刻还活着,
    /// 会广播给已 attach 客户端并入 history)→ cancel tailer → 清回调槽 → drop
    /// MirrorState(常驻 event_tx 随之 drop)。之后自动:tailer 退出 drop 它那份 tx →
    /// fan-out 在 MirrorEnded 处终结(FIX-5)→ finalize_mirror 身份守卫移除 agents
    /// entry(镜像 entry 自回收,`agent_mirror` 回 false,重进不再回放旧对话)。
    fn cleanup(
        &self,
        session: Option<&Session>,
        session_id: &str,
        guard: CleanupGuard<'_>,
    ) -> bool {
        let mut map = self.inner.lock().unwrap();
        match map.get(session_id) {
            None => return false,
            Some(st) => match guard {
                // 身份不符 = 陈旧 SessionEnd(换会话竞态的滞后信号),不动活镜像。
                CleanupGuard::MatchClaudeSid(sid) if st.claude_session_id != sid => return false,
                // 存续不足 = 升格瞬间的滞后 prompt 帧,忽略。
                CleanupGuard::MinAge(min_age) if st.upgraded_at.elapsed() < min_age => {
                    return false
                }
                _ => {}
            },
        }
        let st = map.remove(session_id).expect("锁内刚 get 命中,条目必在");
        let _ = st.event_tx.send(AgentEvent::MirrorEnded);
        st.tailer_cancel.cancel();
        // FIX-3:清回调槽必须在 registry 锁内。若在锁外清:cleanup 解锁后、清槽前,并发
        // SessionStart 可抢到 registry 锁设好**新段回调**,随后本函数滞后的清槽会把它清成
        // None → 新段 7768 硬退出兜底静默失效(镜像永不回收)。锁内清则与 SessionStart
        // 全程串行,交错窗口结构性消除。
        // 锁序论证(无 ABBA):嵌套只有 registry→槽 一个方向(此处与 handle_session_start
        // 同向);run loop 侧取槽锁仅 clone 即释放、**锁外**才调回调(回调内部再拿 registry
        // 锁),不存在「持槽锁等 registry 锁」的反向嵌套。
        if let Some(s) = session {
            *s.on_shell_prompt.lock().unwrap() = None;
        }
        true
    }
}

/// claude 退出(SessionEnd hook 路径入口):幂等清理镜像。`claude_sid` 为 hook body 携带的
/// claude 会话 uuid,与 registry 当前身份**相等才清**(FIX-1:/clear 竞态下滞后的旧 sid
/// SessionEnd 是陈旧信号,no-op);registry 锁内 take,不在表 = 已清 → no-op;同时清除
/// Session 的 7768 兜底回调槽。逻辑体见 [`MirrorRegistry::cleanup`]。
pub(crate) fn cleanup_mirror(state: &ServerState, session_id: &str, claude_sid: &str) {
    let session = state.session_manager.get(session_id);
    if state.mirrors.cleanup(
        session.as_deref(),
        session_id,
        CleanupGuard::MatchClaudeSid(claude_sid),
    ) {
        // claude 已退出:该会话在飞审批全部作废(sender drop → hook handler 空响应回落;
        // claude 都死了,决策无处可去,手机侧的卡由 mirror_ended 清对话一并消失)。
        state.permission_bridge.drain_session(session_id);
    }
}

impl Default for MirrorRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// agent_mirror 字段映射(决策 4,/api/sessions 用)
// ---------------------------------------------------------------------------

/// `/api/sessions` 的 `agent_mirror` 字段值:agents 表有该会话 entry 且 kind==Mirror 才 true
/// (普通会话无 entry → false;方案 B 的 Acp 会话 kind 不符 → false)。抽成纯函数供
/// `handlers.rs` 两处复用 + 单测锁定(Acp entry 需真实子进程才能入表,纯函数级覆盖该分支)。
pub(crate) fn agent_mirror_flag(kind: Option<AgentKind>) -> bool {
    kind == Some(AgentKind::Mirror)
}

// ---------------------------------------------------------------------------
// POST /api/agent-hook —— handler
// ---------------------------------------------------------------------------

/// Hook JSON contains short metadata and permission prompts, never transcript
/// contents. Keep this public unauthenticated parsing surface tightly bounded.
pub(crate) const AGENT_HOOK_BODY_LIMIT: usize = 64 * 1024;

/// `POST /api/agent-hook`(public 路由——转发脚本无 Bearer;安全靠下述双闸,fail-closed)。
///
/// 响应:除 PermissionRequest 外恒为**空 body 的裸状态码**(零 token 硬约束);状态码只作
/// 诊断语义:403=非本机、401=身份不符、400=SessionStart 缺关键字段、200=其余一切
/// (含未知事件/无镜像状态——hook 是 fire-and-forget,向前兼容)。
/// **唯一的 body 白名单 = PermissionRequest 审批桥**(P2,设计 §4.7 明确豁免):手机决策
/// 后返回 `{"hookSpecificOutput":{…decision…}}`(allow 零注入 / deny 带固定拒绝原因);
/// 超时/未决/非镜像 → 空 200,claude 视为不干预回落 TUI 弹窗(fail-open-to-TUI)。
pub async fn agent_hook(
    Extension(state): Extension<Arc<ServerState>>,
    Extension(ingress): Extension<crate::server::auth::TrustedIngress>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // ── 一闸:必须是 acceptor 证明的 direct loopback。relay 的合成
    // 127.0.0.1 peer 不能伪造 trusted ingress。──
    if ingress != crate::server::auth::TrustedIngress::DirectLoopback {
        return StatusCode::FORBIDDEN.into_response();
    }

    // ── 二闸:session + secret 常量时间校验(未登记/不匹配 → 401)──
    let pty_sid = header_str(&headers, "x-meterm-session");
    let secret = header_str(&headers, "x-meterm-secret");
    if pty_sid.is_empty() || !state.hook_secrets.verify(pty_sid, secret) {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    // ── 二闸都过才解析 body(限制无效流量的解析面)。宽松解析:坏 JSON → Null。──
    let payload: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    // 事件名真相来源 = body 的 `hook_event_name`;缺失回退 header(实证 #7)。
    let event = payload
        .get("hook_event_name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| header_str(&headers, "x-meterm-hook-event"));

    // fix10:统一 effort 回报——每个 hook 事件的子进程都继承 CLAUDE_EFFORT(实测),
    // 经脚本 header 带到。diff 记账(registry),值变才下发;/effort 切换(slash 命令
    // 不触发 UserPromptSubmit)后,任一后续 hook 事件即刷新 statusline。
    // 首次 SessionStart 时会话尚未升格 → 此处 no-op,由 SessionStart 分支升格后补报。
    report_effort(&state, pty_sid, &headers);

    // 审批桥(P2):唯一可能携带响应 body 的事件,单独成流(长 await,不入下面的
    // 状态码 match)。
    if event == "PermissionRequest" {
        return handle_permission_request(&state, pty_sid, &payload).await;
    }

    let status = match event {
        // 同步 hook(async:false,claude 阻塞等响应):本分支只 spawn/insert,秒回。
        "SessionStart" => {
            // 懒清扫:顺手回收指向已死会话的残条目(reap 路径的兜底)。
            state.mirrors.sweep_dead(&state.session_manager);

            // SessionStart 必须有 claude 会话 uuid + transcript 路径(镜像身份与数据源)。
            let claude_sid = payload
                .get("session_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let transcript = payload
                .get("transcript_path")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if claude_sid.is_empty() || transcript.is_empty() {
                return StatusCode::BAD_REQUEST.into_response();
            }
            // 会话已死 → fire-and-forget,200 空返。竞态两侧:
            // - 左侧(verify 后、本 get 前被 delete):此处 get 返回 None,直接空返;
            // - 右侧(get 返回 Some 后 delete 完整跑完):由 handle_session_start 锁内
            //   零 await 复查 cancellation token 兜住,不插 stale 条目(见该函数注释)。
            let Some(session) = state.session_manager.get(pty_sid) else {
                return StatusCode::OK.into_response();
            };
            state.mirrors.handle_session_start(
                pty_sid,
                claude_sid,
                PathBuf::from(transcript),
                session,
                &state.agents,
                state.event_bus.clone(),
                &state.permission_bridge,
            );
            // fix9/fix10(effort 即时显示):首次 SessionStart 时 match 前的统一回报因
            // 会话尚未升格而 no-op,升格完成后补报一次——claude 一启动 statusline 就有
            // 思考等级,不必等第一轮 prompt。缺 header(旧版转发脚本)→ 跳过。
            report_effort(&state, pty_sid, &headers);
            StatusCode::OK
        }
        // 内容 100% 走 transcript;这些 hook 催 tailer 立即增量读,并发 AgentStatus 状态
        // (fix2:agent 页状态跟踪)。无镜像状态(乱序到达/已清扫)→ 忽略,200(fire-and-forget)。
        "UserPromptSubmit" => {
            if let Some(t) = state.mirrors.tailer(pty_sid) {
                t.poke_catch_up();
            }
            // effort 回报已由 match 前的统一路径(report_effort,fix10)处理。
            send_agent_status(&state, pty_sid, "thinking", None);
            StatusCode::OK
        }
        "PreToolUse" => {
            if let Some(t) = state.mirrors.tailer(pty_sid) {
                t.poke_catch_up();
            }
            // detail = 工具名(payload.tool_name),手机状态条显示"执行 <工具>"。
            let tool = payload
                .get("tool_name")
                .and_then(|v| v.as_str())
                .map(String::from);
            // 实时工具卡(fix3:工具进行中态):PreToolUse 携带 tool_use_id + tool_input,
            // 与 transcript tool_use block 的 `.id` 同体系(API tool_use id)。合成
            // ToolCallStart 让手机工具卡在执行开始瞬间出现(status=nil → 运行中徽章),
            // 不必等轮末 transcript 批量落盘;轮末 transcript 的同 id ToolCallStart 重复
            // 到达,由手机归约器幂等吸收(同 id 就地更新、不重复建卡)。缺 tool_use_id
            // (旧版 claude payload)→ 退化为只发状态条,工具卡回到 transcript 时序。
            if let Some(tool_use_id) = payload
                .get("tool_use_id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                if let Some(tx) = state.mirrors.event_tx(pty_sid) {
                    let _ = tx.send(AgentEvent::ToolCallStart {
                        id: tool_use_id.to_string(),
                        title: tool.clone().unwrap_or_else(|| "tool".to_string()),
                        kind: None,
                        raw_input: payload.get("tool_input").cloned().unwrap_or(Value::Null),
                    });
                }
            }
            send_agent_status(&state, pty_sid, "running_tool", tool);
            StatusCode::OK
        }
        "PostToolUse" => {
            if let Some(t) = state.mirrors.tailer(pty_sid) {
                t.poke_catch_up();
            }
            // 工具完成,claude 继续处理结果 → 回思考态。
            send_agent_status(&state, pty_sid, "thinking", None);
            StatusCode::OK
        }
        // 轮结束兜底:catch-up 后若轮仍开着补 TurnComplete{None}(M4 内部逻辑)。
        // 知悉:M4 遗留设计固有竞态——落盘滞后时可能双发 TurnComplete,不在 M3 修。
        "Stop" | "StopFailure" => {
            if let Some(t) = state.mirrors.tailer(pty_sid) {
                t.poke_turn_end();
            }
            // 一轮结束 → 空闲态(fix2)。
            send_agent_status(&state, pty_sid, "idle", None);
            StatusCode::OK
        }
        // claude 退出(Task D 第 8 事件):幂等清理镜像——发 MirrorEnded、停 tailer、清
        // registry + 回调槽,entry 由 fan-out 自回收。无镜像状态(已被 7768 先清/从未升格)
        // → no-op,200(fire-and-forget)。硬退出(SIGKILL/崩溃)收不到本事件,由 OSC 7768
        // ShellState 兜底(见 handle_session_start 设置的回调)。
        // FIX-1:解析 body 的 claude 会话 uuid 并与 registry 当前身份比对,相等才清。
        // /clear 竞态:claude 同发 SessionEnd(旧 sid)+ SessionStart(新 sid),async 的
        // SessionEnd 可滞后数秒;SessionStart 先处理(换会话,entry 保留)时,携带旧 sid 的
        // SessionEnd 是陈旧信号,直清会误杀换会话后的活镜像。缺 session_id → 身份不可证,
        // 保守 no-op(真硬退出由 7768 兜底,不漏清)。
        "SessionEnd" => {
            let claude_sid = payload
                .get("session_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !claude_sid.is_empty() {
                cleanup_mirror(&state, pty_sid, claude_sid);
            }
            StatusCode::OK
        }
        // 感知通知(修 #2):claude 需要用户确认/输入(审批弹窗 "do you want to
        // proceed?"、idle 提醒等)时发 Notification hook。仅镜像态会话把 body 的
        // `message` 经常驻 event_tx 下行(AgentEvent::Notify,冻结契约
        // `{"type":"notify","message":"…"}`),经 fan-out 广播给 attached 客户端,
        // 展示与否由手机侧决定;无镜像状态(非镜像会话 / 已清理)→ no-op,200。
        // 零 token:观察者只读 message 转发,不注入任何东西回 claude(响应仍空 body)。
        "Notification" => {
            if let Some(tx) = state.mirrors.event_tx(pty_sid) {
                let message = payload
                    .get("message")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    // 缺 message(字段缺失/非字符串/空)→ 兜底文案,手机总有可展示内容。
                    .unwrap_or("Claude 需要你的确认")
                    .to_string();
                // 权限类 message 含 "permission"(如 "Claude needs your permission to use
                // Bash");空闲类含 "waiting for your input"。区分(修 #5:任务完成后的空闲
                // 提醒不再误报成审批卡):权限 → 醒目 Notify + awaiting 状态;空闲 → 不发
                // Notify,仅置 idle。子串匹配容错(小写)、文案随版本变时退化为发 Notify 兜底。
                if message.to_lowercase().contains("permission") {
                    let _ = tx.send(AgentEvent::AgentStatus {
                        state: "awaiting".to_string(),
                        detail: None,
                    });
                    // 审批桥有在飞卡 → 抑制 attention 卡(审批卡本身就是提示且可直接批,
                    // 「去终端确认」的指引重复且过时);无在飞(旧 hooks.json 未注入
                    // PermissionRequest / 桥已超时回落 TUI 弹窗)→ 照发,不漏提示。
                    if !state.permission_bridge.has_pending(pty_sid) {
                        let _ = tx.send(AgentEvent::Notify { message });
                    }
                } else if message.to_lowercase().contains("waiting for your input") {
                    let _ = tx.send(AgentEvent::AgentStatus {
                        state: "idle".to_string(),
                        detail: None,
                    });
                } else {
                    // 无法归类的通知(未来新文案)→ 保守发 Notify,不漏真正需要确认的。
                    let _ = tx.send(AgentEvent::Notify { message });
                }
            }
            StatusCode::OK
        }
        // 轮内实时正文(fix4:对话实时展示)。MessageDisplay 在 assistant 消息流式期间
        // 按「新完成行批」触发,`delta` 是 **markdown 原文**(实证,非 TUI 渲染文本)→
        // 直接下行 AssistantDelta,消除「transcript 轮末批量 flush → 正文一次性冒出」的
        // 整轮延迟;同时标记 tailer 本轮 text 已 live 流出(transcript 落盘后跳过,防双份)。
        // index>0 的批前置 "\n":行批语义(行间 \n 分隔、批尾无 \n),批间需补行分隔——
        // 假设偏差最多产生多余空行,好过粘行破坏 markdown。零 token:观察者只读转发。
        "MessageDisplay" => {
            let delta = payload.get("delta").and_then(|v| v.as_str()).unwrap_or("");
            if !delta.is_empty() {
                if let Some(tx) = state.mirrors.event_tx(pty_sid) {
                    let index = payload.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                    let text = if index > 0 {
                        format!("\n{}", delta)
                    } else {
                        delta.to_string()
                    };
                    let _ = tx.send(AgentEvent::AssistantDelta { text });
                    // 只有真的下行了才标记跳过:fan-out 已收尾时不标记,transcript 兜底。
                    if let Some(t) = state.mirrors.tailer(pty_sid) {
                        t.mark_live_assistant();
                    }
                }
            }
            StatusCode::OK
        }
        // 未知事件名(向前兼容)→ 200 无副作用。
        _ => StatusCode::OK,
    };
    status.into_response()
}

// ---------------------------------------------------------------------------
// P2 审批桥:PermissionRequest hook 同步阻塞 → 手机决策 → decision 响应
// ---------------------------------------------------------------------------

/// handler 侧等待手机决策的上限。须 < 转发脚本 curl 的 `-m 90`(否则 curl 先断、响应
/// 无人收),留 10s 余量;更 < claude 的 hook 默认超时 600s。超时即撤登记、空响应,
/// claude 回落原生 TUI 弹窗——终端旁的用户不受手机不在场影响。
const PERMISSION_WAIT: Duration = Duration::from_secs(80);

/// PermissionRequest hook 主流程:仅镜像态桥接;登记 pending → 下行审批卡(复用方案 B
/// 的 `permission_request` 冻结契约与手机审批卡 UI)→ 阻塞等手机 0x52 决策(经
/// `upstream.rs` 回投)→ 返回 decision JSON。任何异常(非镜像/通道断/超时/claude 退出
/// drain)→ 空 200 回落 TUI 弹窗(fail-open-to-TUI)。
async fn handle_permission_request(
    state: &ServerState,
    pty_sid: &str,
    payload: &Value,
) -> Response {
    // 非镜像态(防御:hooks 只注入给镜像会话,但乱序/已清扫仍可能到达)→ 不干预。
    let Some(tx) = state.mirrors.event_tx(pty_sid) else {
        return StatusCode::OK.into_response();
    };
    let tool_name = payload
        .get("tool_name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("工具");
    // request_id 自生成(PermissionRequest payload 无 tool_use_id):手机原样回传,
    // upstream 凭它回投决策。"mperm-" 前缀便于日志区分镜像桥与 ACP 的 JSON-RPC id。
    let request_id = format!("mperm-{}", uuid::Uuid::new_v4());
    let rx = state.permission_bridge.register(pty_sid, &request_id);
    // fix11:AskUserQuestion(选择题工具)走专属事件——questions 原样透传,手机渲染
    // 选项卡 + 自定义输入,答案经 0x52 answer 回传(masko-code 同款机制);
    // 其余工具照旧发固定 允许/拒绝 两选项的审批卡。
    let questions = (tool_name == "AskUserQuestion")
        .then(|| {
            payload
                .get("tool_input")
                .and_then(|i| i.get("questions"))
                .cloned()
        })
        .flatten();
    // fix12:选项对齐终端真实弹窗——"Yes" / "Yes, don't ask again…"(仅当 hook 携带
    // permission_suggestions)/ 拒绝(手机端固定入口,带可选反馈,不再作为 option 下发,
    // 消除旧版"拒绝/驳回"双按钮的语义重复)。
    let suggestions = payload
        .get("permission_suggestions")
        .filter(|s| s.as_array().is_some_and(|a| !a.is_empty()))
        .cloned();
    let mut options = vec![PermissionOption {
        option_id: "allow".to_string(),
        name: "允许".to_string(),
        kind: Some("allow_once".to_string()),
    }];
    if let Some(sug) = &suggestions {
        options.push(PermissionOption {
            option_id: "allow_always".to_string(),
            name: allow_always_label(sug),
            kind: Some("allow_always".to_string()),
        });
    }
    let ev = match questions {
        Some(qs) => AgentEvent::AskQuestion {
            request_id: Value::String(request_id.clone()),
            questions: qs,
        },
        None => AgentEvent::PermissionRequest {
            request_id: Value::String(request_id.clone()),
            title: permission_title(tool_name, payload.get("tool_input")),
            options,
        },
    };
    if tx.send(ev).is_err() {
        // fan-out 已收尾(镜像正被清理):撤登记、回落 TUI。
        state.permission_bridge.remove(&request_id);
        return StatusCode::OK.into_response();
    }
    await_permission_decision(
        &state.permission_bridge,
        &request_id,
        rx,
        PERMISSION_WAIT,
        payload.get("tool_input"),
        suggestions.as_ref(),
    )
    .await
}

/// fix12:「总是允许」选项的显示文案——从 permission_suggestions 首个建议尽量贴近
/// claude 终端第二项的语义(setMode/acceptEdits → 会话级编辑放行;addRules → 按工具
/// 记规则);未知形态兜底通用文案。纯函数,单测锁定。
fn allow_always_label(suggestions: &Value) -> String {
    if let Some(first) = suggestions.as_array().and_then(|a| a.first()) {
        match first.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "setMode" => {
                if first.get("mode").and_then(|v| v.as_str()) == Some("acceptEdits") {
                    return "允许本会话所有编辑".to_string();
                }
            }
            "addRules" => {
                if let Some(tool) = first
                    .get("rules")
                    .and_then(|r| r.as_array())
                    .and_then(|a| a.first())
                    .and_then(|r| r.get("toolName"))
                    .and_then(|v| v.as_str())
                {
                    return format!("总是允许此类 {} 操作", tool);
                }
            }
            _ => {}
        }
    }
    "总是允许,不再询问".to_string()
}

/// 带超时等待手机决策(抽出便于单测注入短超时):
/// - 收到决策 → decision JSON 响应(AllowWithAnswers 需要原 `tool_input` 合并);
/// - 超时 / 通道断(claude 退出 drain / 会话销毁)→ 撤登记 + 空 200(回落 TUI 弹窗)。
async fn await_permission_decision(
    bridge: &PermissionBridge,
    request_id: &str,
    rx: oneshot::Receiver<PermissionReply>,
    wait: Duration,
    tool_input: Option<&Value>,
    suggestions: Option<&Value>,
) -> Response {
    match tokio::time::timeout(wait, rx).await {
        Ok(Ok(reply)) => permission_decision_response(reply, tool_input, suggestions),
        _ => {
            bridge.remove(request_id);
            StatusCode::OK.into_response()
        }
    }
}

/// 决策 → claude 的 hook 输出 JSON(schema 实证自 claude 2.1.206:
/// `hookSpecificOutput.decision.behavior: allow|deny`,deny 可带 `message`,
/// allow 可带 `updatedInput`)。
/// **零 token 白名单**:allow 纯放行零注入;deny 的固定 message 是喂给 claude 的拒绝
/// 原因(与终端里拒绝完全一致的几个 token,设计 §4.7 明确豁免);AllowWithAnswers
/// 的 `updatedInput` = 原 tool_input + 用户自己的回答(fix11 AskUserQuestion,与终端
/// 里作答完全等价)。除此之外不改写工具入参、不带 updatedPermissions/interrupt。
fn permission_decision_response(
    reply: PermissionReply,
    tool_input: Option<&Value>,
    suggestions: Option<&Value>,
) -> Response {
    let decision = match reply {
        PermissionReply::Allow => json!({ "behavior": "allow" }),
        // fix12:「总是允许」= claude 自己建议的 permission_suggestions 原样回作
        // updatedPermissions(与终端选第二项完全一致);无 suggestions(防御:不该出现
        // 该决策)退化为纯 allow。
        PermissionReply::AllowAlways => match suggestions {
            Some(sug) => json!({ "behavior": "allow", "updatedPermissions": sug }),
            None => json!({ "behavior": "allow" }),
        },
        // fix12:deny message = 用户给 Claude 的说明(对齐终端 "No, and tell Claude
        // what to do differently";用户自己的文字注入自己的会话,与终端里输入等价)。
        PermissionReply::Deny(message) => json!({
            "behavior": "deny",
            "message": message.as_deref().unwrap_or("用户在 MeTerm 手机端拒绝了本次操作")
        }),
        PermissionReply::AllowWithAnswers(answers) => {
            // masko-code 同款 wire:updatedInput = 原 tool_input 全量字段 + answers。
            let mut updated = tool_input
                .and_then(|v| v.as_object().cloned())
                .unwrap_or_default();
            updated.insert(
                "answers".to_string(),
                serde_json::to_value(answers).unwrap_or(Value::Null),
            );
            json!({ "behavior": "allow", "updatedInput": Value::Object(updated) })
        }
    };
    let body = json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": decision,
        }
    });
    (StatusCode::OK, axum::Json(body)).into_response()
}

/// 审批卡标题:`工具名: 入参摘要`(command/file_path/path/url 择先,char 边界截断);
/// 无可读入参 → 裸工具名。内容是 claude 请求的原样字节(用户自己的会话),仅作展示。
fn permission_title(tool_name: &str, tool_input: Option<&Value>) -> String {
    const TITLE_DETAIL_LIMIT: usize = 120;
    let detail = tool_input.and_then(|i| {
        ["command", "file_path", "path", "url"]
            .iter()
            .find_map(|k| i.get(k).and_then(|v| v.as_str()))
            .filter(|s| !s.is_empty())
    });
    match detail {
        Some(d) if d.chars().count() > TITLE_DETAIL_LIMIT => {
            let cut: String = d.chars().take(TITLE_DETAIL_LIMIT).collect();
            format!("{}: {}…", tool_name, cut)
        }
        Some(d) => format!("{}: {}", tool_name, d),
        None => tool_name.to_string(),
    }
}

/// 取 header 的 str 值(缺失/非 ASCII → 空串)。
fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

/// fix10:统一 effort 回报——每个 hook 事件的子进程都继承 CLAUDE_EFFORT(实测),经
/// 转发脚本 `X-Meterm-Effort` header 带到。diff 记账([`MirrorRegistry::update_effort`],
/// 值变含首见才下发,零重复帧);缺 header(旧版脚本/env 未设)/ 无镜像 → no-op。
fn report_effort(state: &ServerState, pty_sid: &str, headers: &HeaderMap) {
    let effort = header_str(headers, "x-meterm-effort");
    if !effort.is_empty() && state.mirrors.update_effort(pty_sid, effort) {
        if let Some(tx) = state.mirrors.event_tx(pty_sid) {
            let _ = tx.send(AgentEvent::AgentMeta {
                model: None,
                effort: Some(effort.to_string()),
                context_tokens: None,
                git_branch: None,
                cwd: None,
            });
        }
    }
}

/// 发 AgentStatus 旁路状态(fix2:agent 页状态条)。仅镜像态会话经常驻 event_tx 下行
/// (冻结契约 `{"type":"agent_status","state":"…","detail":"…"}`,detail 为 None 省略);
/// 无镜像状态(非镜像会话 / 已清理)→ no-op。零 token:观察者只读,不注入回 claude。
fn send_agent_status(state: &ServerState, pty_sid: &str, status: &str, detail: Option<String>) {
    if let Some(tx) = state.mirrors.event_tx(pty_sid) {
        let _ = tx.send(AgentEvent::AgentStatus {
            state: status.to_string(),
            detail,
        });
    }
}

// ---------------------------------------------------------------------------
// Tests(拆独立文件,同 mirror_tests 拆法)
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "hook_tests.rs"]
mod hook_tests;

#[cfg(test)]
#[path = "hook_cleanup_tests.rs"]
mod hook_cleanup_tests;

#[cfg(test)]
#[path = "hook_trusted_ingress_tests.rs"]
mod hook_trusted_ingress_tests;

#[cfg(test)]
#[path = "hook_exit_tests.rs"]
mod hook_exit_tests;

#[cfg(test)]
#[path = "hook_status_tests.rs"]
mod hook_status_tests;

#[cfg(test)]
#[path = "hook_permission_tests.rs"]
mod hook_permission_tests;
