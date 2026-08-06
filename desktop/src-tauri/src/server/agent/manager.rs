//! `AcpAgentManager` —— agent 会话生命周期 + WS 帧广播(下行链路,P1-T2)。
//!
//! 把 T1 的 `AcpClient`(外部 agent 子进程)接进既有 WS 下行管线:一个 agent
//! 会话就是一个**不启动 PTY**的普通 `Session`,只是下行的是 `MSG_AGENT_EVENT`
//! (0x50)JSON 帧而非终端字节(投递机制见下方「精确一次」说明)。手机端零改动
//! 即可经现有 `/ws/{id}`(自动穿透 relay)收到帧(解码是 T3)。
//!
//! agent 会话的身份唯一真相 = 本表:`manager.get(&session_id).is_some()` 即判定
//! 「这是 agent 会话」。**不改 `Session` 结构体、不加字段**。
//!
//! 组成:
//! - [`AgentHistory`]——已编码帧的字节上限环形缓冲,供晚接入的手机回放。
//! - [`FanState`]——history + 「已完成回放(attached)的 client id 集合」,**同一把锁**守护。
//! - [`AgentEntry`]——单个 agent 会话的 client + fan 状态 + fan-out 任务句柄 + 元数据。
//! - [`AcpAgentManager`]——`session_id -> Arc<AgentEntry>` 注册表(Registry 范式,
//!   仿 `PresenceRegistry`/`PushRegistry`)。
//!
//! **精确一次 + 有序**(核心正确性 · attached-set 门控):handle_ws 在步骤2
//! (`add_client`)就把 client 放进 `session.clients`,但 agent 历史回放([`AgentEntry::attach`])
//! 到步骤5才做——这中间隔着两次 `.await`。若 fan-out 用 `session.broadcast`,该窗口内的
//! live 事件既经 broadcast 送到已注册的新 client、又出现在随后回放的 snapshot 里 → **重发+乱序**。
//! 根因:「加入广播集合」与「拍回放 snapshot」不是相对同一把锁原子完成。
//!
//! 修法:fan-out **不用 broadcast**,只投递给 [`FanState::attached`] 集合内的 client;
//! [`attach_client`] **带背压**回放全部历史帧后,才在 fan 锁内**原子**把 client id 插入 attached
//! (回放不持锁 await,靠帧的全局序号 `pushed` 界定「已发送边界」并追赶回放期间的 live 帧,
//!  完整证明见 [`attach_client`])。由此任一 live 事件 E 对某 client:
//! - E 的 fan-out 若在该 client 插入 attached(时刻 T)**之前**执行 → client 不在 attached,不经
//!   fan-out 投递;但 E 已进历史(`seq < pushed_T`),被回放送达**一次**、且按 seq 落在有序位置。
//! - E 的 fan-out 若在**之后**执行(`seq ≥ pushed_T`)→ client 已在 attached → 只经 fan-out 投递
//!   **一次**;回放边界止于 `pushed_T`,不含 E → 不重复。
//! 于是无漏发、无重发、有序——不依赖 `session.broadcast` 的注册时机。
//!
//! **背压回放(消除手机重连溢出/永久环)**:回放用 [`Client::send_async`] 等通道容量而非旧的非阻塞
//! `send`(Full → `disconnect()` + 丢帧),故历史帧数远超 priority 通道容量(1024)也不断连、不截断;
//! 前提是 WS handler 先 spawn writer 再 attach(writer-before-attach)以并发排空通道。
//!
//! **同 client 双路 attach 的互斥/幂等**(与上述不变式的叠加语义):对同一 client,attach 可能被
//! 发起多次——不同 conn_gen 的(reconnect)由 BUG-2 conn_gen 守卫裁决(新连接的 attach 接管,旧的
//! abort);**同 conn_gen** 的(升格补 attach × 连接时 attach,ACP 与 Mirror 同函数、同受保护)由
//! [`attach_client`] 内建的两重守卫裁决:已有一次同代 attach **完整完成** → 幂等守卫使后到者
//! no-op(同一条通道上历史已送达,重放必重复);两路**并发在飞** → per-client in-flight 代次
//! 互斥,后登记者独占、先登记者在校验点 abort。合并后的全局不变式:任意时刻,对每个 client
//! 至多一路 attach 会继续发帧/插入 attached,且「插入 attached」对每个 (client, conn_gen) 至多
//! 一次——「精确一次 + 有序」证明(见 [`attach_client`])以那一次插入为时刻 T,结构不变;
//! BUG-1 起始 remove 仍在每次真正回放前执行,只是其清除对象被幂等守卫精确化为「更旧 conn_gen
//! 的残留」,绝不误摘同代在场者。
//!
//! [`Client::send_async`]: crate::server::session::client::Client::send_async

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{mpsc, Notify};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::{AcpClient, AcpCommand, AgentEvent};
use crate::server::events::{DesktopEvent, EventBus};
use crate::server::protocol;
use crate::server::session::client::Client;
use crate::server::session::manager::SessionManager;
use crate::server::session::Session;

/// 「创建后无人 attach」的回收期限(idle-guard,FIX-L3)。> 握手超时(60s)留足余量,
/// 避免握手慢启动(npx 首次拉依赖)期间被误判为「被抛弃」。到点仍从未 attach → 回收。
const ATTACH_DEADLINE: Duration = Duration::from_secs(120);

// ---------------------------------------------------------------------------
// AgentHistory —— 下行帧历史(字节上限环形缓冲)
// ---------------------------------------------------------------------------

/// agent 会话的下行帧历史 —— 存**已编码的 `MSG_AGENT_EVENT` 帧**,带字节上限。
///
/// 超过 `MAX_BYTES` 时从最旧帧起丢弃(但至少保留最新一帧,即使它单帧就超限)。
/// 取舍已知:晚接入的手机会看到被截断的早期对话——agent 文本量远小于终端全屏刷,
/// 2 MiB 足以容纳一整轮长对话的下行帧。
struct AgentHistory {
    frames: VecDeque<Vec<u8>>,
    /// 已入队帧的累计字节数(= 各帧 len 之和)。
    bytes: usize,
    /// 字节上限;超过则从最旧帧起丢弃。
    max_bytes: usize,
    /// 累计入队帧数(单调,永不回退,含已被淘汰的)。给每帧一个稳定的全局序号:
    /// 第 k 次 push 的帧序号 = push 前的 `pushed` 值;当前最旧在缓冲帧序号 =
    /// `pushed - frames.len()`(= evicted 数)。attach 背压回放据此界定「已发送边界」,
    /// 追赶回放期间新入历史的帧,证明精确一次 + 有序(见 [`attach_client`])。
    pushed: u64,
}

impl AgentHistory {
    /// 历史累计字节上限(约 2 MiB)。
    const MAX_BYTES: usize = 2 * 1024 * 1024;

    fn new() -> Self {
        Self::with_max_bytes(Self::MAX_BYTES)
    }

    /// 指定上限构造(供单测用小上限快速触发丢弃)。
    fn with_max_bytes(max_bytes: usize) -> Self {
        Self {
            frames: VecDeque::new(),
            bytes: 0,
            max_bytes,
            pushed: 0,
        }
    }

    /// 入队一帧;若累计超 `max_bytes` 则从最旧帧起丢弃,直到回到上限内。
    /// 始终保留最新一帧(哪怕它单帧超限),避免刚广播的事件从历史里凭空消失。
    /// `pushed` 单调 +1(即使随后被淘汰),给帧一个稳定全局序号供 attach 追赶回放。
    fn push(&mut self, frame: Vec<u8>) {
        self.pushed += 1;
        self.bytes += frame.len();
        self.frames.push_back(frame);
        while self.bytes > self.max_bytes && self.frames.len() > 1 {
            if let Some(old) = self.frames.pop_front() {
                self.bytes -= old.len();
            }
        }
    }

    /// 克隆「全局序号 ≥ `from_seq` 且仍在缓冲」的帧(顺序 = 入队顺序),供 attach 增量回放。
    /// 更早于当前最旧在缓冲帧(已被 2 MiB 淘汰)的请求段落无法返回——`saturating_sub`
    /// 令其从最旧在缓冲帧起(gap,与既有 2 MiB 截断取舍一致)。
    fn frames_from(&self, from_seq: u64) -> Vec<Vec<u8>> {
        let oldest_seq = self.pushed - self.frames.len() as u64;
        let start = from_seq.saturating_sub(oldest_seq) as usize;
        self.frames.iter().skip(start).cloned().collect()
    }
}

// ---------------------------------------------------------------------------
// FanState —— fan-out 共享态(history + attached 集合,同一把锁)
// ---------------------------------------------------------------------------

/// fan-out 共享态:下行帧历史 + 「已完成回放(attached)的 client 表」+ in-flight attach 代次表。
///
/// 三者**共用同一把锁**是「精确一次 + 有序」的关键(见模块级说明):fan-out 只把
/// live 帧投递给 `attached` 集合;[`attach_client`] 在锁内原子完成「回放 history +
/// 登记 client id」。于是任一 live 事件对某 client 要么只经 fan-out 投递、要么只经
/// 回放送达,绝不二者兼有。
struct FanState {
    history: AgentHistory,
    /// 已完成历史回放、可接收 live fan-out 帧的 client:id → **完成那次 attach 捕获的 conn_gen**。
    ///
    /// value(完成代次)是「同 conn_gen 幂等守卫」的依据(见 [`attach_client`]):conn_gen 仅在
    /// `reconnect`(换下行通道)时 bump,故「完成代次 == 当前 conn_gen」⇔ 历史已在**同一条**下行
    /// 通道上精确一次送达、live 帧由 fan-out 无缝接续——再次 attach 从头回放必然整段重复,应 no-op。
    /// 完成代次 ≠ 当前 conn_gen 的条目才是 reconnect 残留,由 BUG-1 起始 remove 清除后正常回放。
    ///
    /// **惰性剔除**:[`fan_out_one`] 每帧投递时,对投递失败(`send_to_client` 返回 false
    /// ——client 已断开 / 通道关闭 / 不在会话表)的 id 就地从本表移除。由此上界 =
    /// 当前在场 client 数,不随历史连接次数(每次新连接是全新 uuid)单调增长;仍在场的
    /// id 按 client_id 去重(重连复用同 id)。
    ///
    /// **reconnect 残留清理**:惰性剔除只在有 fan_out 事件时触发,`disconnect`/`reconnect`
    /// 本身不碰本表,故同 client_id 掉线又在 grace 内重连(复用同 id)时旧条目可能残留。
    /// 由 [`attach_client`] 起始持锁 `remove(&id)` 兜底清除(BUG-1),恢复「回放期间此 client
    /// 不在 attached」不变式——否则新连接回放期间 fan_out 会并发向其投 live 帧 → 重发/乱序。
    attached: HashMap<String, u64>,
    /// per-client **in-flight attach 代次**(并发双 attach 互斥):id → 该 client 当前**最新**
    /// 一次 attach 的代次(取自 `attach_seq`)。
    ///
    /// 同一 client 同 conn_gen 可能有两路 attach 并发(升格补 attach(hook.rs)× 连接时 attach
    /// (ws.rs 步骤6 / ipc_terminal)),BUG-1 起始 remove + 从头回放会让两路各发整份 history →
    /// wire 整段前缀重复。互斥规则:每次 attach 起始锁内登记自己的代次(覆盖旧值),**后登记者
    /// 独占**;先登记者在各校验点(每帧发送前 + 锁内插入 attached 前)发现「最新代次 ≠ 自己」
    /// 即 abort(不发余帧、不插 attached),重复范围收敛到「其已发出的帧」。
    ///
    /// 条目由该 client 最新一次 attach 在退出时清理(完成 / abort / 掉线;只清仍等于自己代次的,
    /// 防误删后来者)。attach future 被外部整体 drop(如 ws handler 回放中途被拆)时条目可能
    /// 短暂残留,由同 id 的下一次 attach 顶替覆盖并在其退出时清理;量级 ≤ 在场 client 数,
    /// 与 `attached` 的惰性语义同阶,不构成泄漏。
    attach_gen: HashMap<String, u64>,
    /// in-flight attach 代次分配器(锁内单调自增,全 fan 域唯一,永不回退)。
    attach_seq: u64,
}

impl FanState {
    fn new() -> Self {
        Self {
            history: AgentHistory::new(),
            attached: HashMap::new(),
            attach_gen: HashMap::new(),
            attach_seq: 0,
        }
    }

    /// 清理某次 attach 在 `attach_gen` 里的登记(须持 fan 锁调用):**只清仍等于自己代次 `g`
    /// 的条目**——若已被更新的 attach 顶替(条目属于后来者)则不动,防误删。所有 attach 退出
    /// 路径(完成 / 被顶替 abort / conn_gen abort / 掉线 abort)统一经此清理,防 map 残留。
    fn clear_own_attach_gen(&mut self, client_id: &str, g: u64) {
        if self.attach_gen.get(client_id) == Some(&g) {
            self.attach_gen.remove(client_id);
        }
    }
}

// ---------------------------------------------------------------------------
// AgentKind —— agent 会话的事件源类型
// ---------------------------------------------------------------------------

/// agent 会话的事件源类型 —— 决定生命周期与 attach 回放策略。
///
/// - `Acp`(方案 B):事件来自托管的 [`AcpClient`] 子进程;会话**无 PTY**,结束时随子进程
///   删除整个会话([`finalize_fan_out`])。
/// - `Mirror`(方案甲):事件来自**外部喂入**的镜像流(hooks/transcript,M3/M4),`client=None`;
///   底层是**带 PTY 的 local-shell 会话**,镜像结束(claude 退出)**不删会话**——PTY shell 仍在、
///   终端页继续可用([`finalize_mirror`])。attach 时终端环形缓冲 + AI 历史两者都回放。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentKind {
    /// 方案 B:托管 AcpClient 子进程,会话无 PTY,结束删会话。
    Acp,
    /// 方案甲:外部镜像事件源,底层带 PTY,结束不删会话。
    Mirror,
}

// ---------------------------------------------------------------------------
// AgentMeta —— 只读元数据
// ---------------------------------------------------------------------------

/// 单个 agent 会话的只读元数据(供 REST 响应 / 未来 list)。
#[derive(Clone, Debug)]
pub struct AgentMeta {
    /// agent 标识(目前只有 `"claude"`)。
    pub agent: String,
    /// 工作目录(绝对路径)。
    pub cwd: String,
    /// 事件源类型(Acp / Mirror),决定生命周期与 attach 回放(见 [`AgentKind`])。
    pub kind: AgentKind,
}

// ---------------------------------------------------------------------------
// AgentEntry —— 单个 agent 会话
// ---------------------------------------------------------------------------

/// 单个 agent 会话:托管的 `AcpClient` + fan 状态(history + attached)+ fan-out 任务句柄 + 元数据。
pub struct AgentEntry {
    /// 托管的 `AcpClient`。生产路径恒为 `Some`;测试插入口([`AcpAgentManager::insert_for_test`])
    /// 用 `None` 塞一个不带子进程的表条目,供表增删 / 收尾移除断言(无需构造 `AcpClient`)。
    client: Option<Arc<AcpClient>>,
    fan: Arc<Mutex<FanState>>,
    meta: AgentMeta,
    /// fan-out 任务句柄,供显式 [`AcpAgentManager::remove`] 时 abort
    /// (常规销毁走会话 cancel token,fan-out 自收尾)。
    task: Mutex<Option<JoinHandle<()>>>,
    /// 「一次一轮」in-flight 守卫(T4 上行发消息用):某轮 `send_prompt` 进行中置 true。
    /// ACP 一次只能跑一轮,重叠 `send_prompt` 会向子进程发两次 prompt 污染同一会话,
    /// 故上行 `MSG_AGENT_INPUT` 先 [`AgentEntry::begin_turn`] 抢占,失败即回 `agent_busy`。
    busy: AtomicBool,
    /// idle-guard(FIX-L3):是否曾有 client attach 过。[`AgentEntry::attach`] 首次置 true;
    /// `run_fan_out` 的 [`ATTACH_DEADLINE`] 到点时若仍为 false → 判定「创建后无人连接」→ 回收。
    /// 与 `run_fan_out` 共享同一个 `Arc<AtomicBool>`(register 里建、两处各持一克隆)。
    ever_attached: Arc<AtomicBool>,
}

impl AgentEntry {
    /// 把历史帧按序、带背压地回放给刚接入的 client,回放全部完成后在 fan 锁内原子把该
    /// client 登记进 attached 集合——实现「精确一次 + 有序」(见 [`attach_client`] 的证明)。
    /// **async**:回放用背压发送(通道满则等 writer 排空),故历史帧数远超通道容量也不丢、
    /// 不断连。调用方须已 spawn writer 并发排空 priority 通道(writer-before-attach)。
    pub async fn attach(&self, client: &Client) {
        // idle-guard(FIX-L3):标记本会话已有 client 连接过。一旦置 true,`run_fan_out`
        // 的 ATTACH_DEADLINE 便不再回收它(随子进程存活;attached-then-left 不回收,
        // 既定取舍)。attempt 粒度即足够:能走到 attach 说明该会话绝非「创建后从未连接」——
        // 即便该 client 随即掉线(回放中途断开),也是「连过又走」而非「从未连接」。
        self.ever_attached.store(true, Ordering::SeqCst);
        attach_client(&self.fan, client).await;
    }

    /// 托管的 `AcpClient`(供 T4 上行输入 / 控制帧复用)。测试插入口塞的条目为 `None`。
    pub fn client(&self) -> Option<&Arc<AcpClient>> {
        self.client.as_ref()
    }

    /// 只读元数据(REST 响应 / list)。
    pub fn meta(&self) -> &AgentMeta {
        &self.meta
    }

    /// 事件源类型(Acp / Mirror)。供 ws / ipc attach 分支与上行 dispatch 判定
    /// (Mirror 底层有 PTY、无 AcpClient,见 [`AgentKind`])。
    pub fn kind(&self) -> AgentKind {
        self.meta.kind
    }

    /// 尝试开启一轮:当前空闲(busy=false)则原子置 true 返回 true;
    /// 已有轮次进行中返回 false(调用方回 `agent_busy`)。
    pub fn try_begin_turn(&self) -> bool {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    /// 结束一轮:清 busy,放行下一轮。务必在 `send_prompt` 返回(无论成败)后调用;
    /// 常规路径经 [`TurnGuard`] 的 Drop 自动完成,即使任务 panic 也会清。
    pub fn end_turn(&self) {
        self.busy.store(false, Ordering::Release);
    }

    /// 尝试开启一轮并返回 RAII 守卫:成功 `Some(guard)`(drop 时自动 [`end_turn`]),
    /// 已在进行中则 `None`。上行发消息用它保证 `end_turn` 不遗漏(spawn 任务 panic
    /// 时守卫仍随栈展开 drop → 清 busy,不会永久卡死会话)。
    ///
    /// [`end_turn`]: AgentEntry::end_turn
    pub fn begin_turn(self: &Arc<Self>) -> Option<TurnGuard> {
        if self.try_begin_turn() {
            Some(TurnGuard {
                entry: self.clone(),
            })
        } else {
            None
        }
    }
}

/// 轮次 RAII 守卫:由 [`AgentEntry::begin_turn`] 构造(此刻已 begin),drop 时自动
/// `end_turn`。持 `Arc<AgentEntry>` 以便移入 `tokio::spawn` 的任务,任务结束(成功 /
/// `send_prompt` 返回 Err / panic 展开)后守卫 drop → 清 busy,杜绝忘记 `end_turn`。
pub struct TurnGuard {
    entry: Arc<AgentEntry>,
}

impl Drop for TurnGuard {
    fn drop(&mut self) {
        self.entry.end_turn();
    }
}

/// attach:把已入历史的帧按序、**带背压**地回放给刚接入的 client,回放全部完成后在 fan 锁内
/// **原子**把 client id 插入 attached 集合。抽成自由函数便于单测(无需构造 `AcpClient`)。
///
/// 与旧实现(持 fan 锁、非阻塞 `send` 逐帧灌入 1024 槽 priority 通道)的本质区别:
/// - 回放用 [`Client::send_async`](crate::server::session::client::Client::send_async)
///   **等待通道容量**——通道满则挂起等 writer 排空,而非旧实现的 Full → `disconnect()` + 丢帧。
///   故历史帧数远超通道容量(`PRIORITY_SEND_CHANNEL_SIZE=1024`)也不丢、不断连、不截断
///   (根治「手机重连撞溢出 → 断连 → 再重连 → 永久环」)。**前提**:调用方已 spawn writer
///   并发排空 priority 通道(WS 侧 writer-before-attach;IPC 通道无背压,send_async 即时返回)。
/// - **不持 fan 锁 `.await`**(持 std Mutex 跨 await 会阻塞 fan_out):每轮只在锁内「快照一批
///   未发送帧 + 读 `pushed` 边界」,释放锁后 await 背压发送;回放期间新入历史的 live 帧下一轮
///   追赶,直到某轮锁内发现「已追平」→ 原子插入 attached 并结束。
///
/// **精确一次 + 有序证明**(设插入 attached 的那次持锁为时刻 T,此刻 `next_seq == pushed_T`):
/// - `seq < pushed_T` 的帧:插入前已在各追赶轮里按 seq 递增全部 `send_async` 入通道,且都在
///   T 之前完成(T 的持锁发生在最后一批发送返回之后)。
/// - `seq ≥ pushed_T` 的帧:由 [`fan_out_one`] 投递;但它只投给 attached 集合里的 id,而本
///   client 在 T 之前不在 attached,故这些 live 帧入通道必然在 T 之后(fan_out 需持锁见到已 attach)。
/// 两集合不相交、并集为全部;通道 FIFO ⇒ 先回放帧(`seq<pushed_T`)后 live 帧(`seq≥pushed_T`),
/// 各恰一次、全局有序——不依赖 broadcast 的注册时机。回放中途 client 掉线(`send_async` 返回
/// false)则**不**插入 attached(fan-out 自然不再投递),直接返回,不留死 id。
///
/// **reconnect 路径的两重守卫**(上面证明的前提「回放期间本 client 不在 attached」对全新 uuid
/// 天然成立,但对同 client_id 重连被打破——把「回放移出 fan 锁」后暴露,故显式恢复):
/// - **BUG-1 起始 remove**:attached 只靠 [`fan_out_one`] 惰性剔除,`disconnect`/`reconnect` 都
///   不碰它;同 id 掉线又重连(换新通道、id 不变)时旧条目可能残留 attached。故起始持锁先
///   `attached.remove(&id)`,恢复不变式——回放全程本 client 不在 attached,fan_out 不向新通道并发
///   投 live 帧,末尾 T 再插入。于是 reconnect 与全新 attach 完全等价(同上精确一次 + 有序证明)。
/// - **BUG-2 conn_gen 守卫**:背压化让 attach 成了跨多个 `.await` 的长任务;被顶替的旧 attach 恢复
///   后 `send_async` 会重读已换成新通道的 downstream(reconnect 后 connected=true),把陈旧历史帧灌进
///   新连接。故起始持锁捕获 `gen = conn_gen()`,回放各校验点(每帧发送前 + 持锁插入前)比对 `conn_gen()
///   == gen`,不等(被 reconnect bump)即 abort:不发余下帧、不插 attached(新 handler 的新 attach
///   已接管回放)。持锁内的校验与插入原子完成,杜绝「校验通过后、拿锁前被顶替仍插 id」竞态。
///
/// **同 client 同 conn_gen 双路 attach 的两重守卫**(升格补 attach(hook.rs)× 连接时 attach
/// (ws.rs 步骤6 / ipc_terminal)对同一 client 各发起一次时,上面两守卫都不触发——conn_gen 未变、
/// attached 无陈旧残留——BUG-1 remove + 从头回放会把同一条通道上已送达的前缀整段重发):
/// - **同 conn_gen 幂等守卫**(顺序 case,典型时序):起始锁内发现 `attached[id] == 本次 gen`
///   ⇒ 此前已有一次 attach 在**同一** conn_gen(= 同一条下行通道,conn_gen 仅 reconnect 换通道时
///   bump)上完整完成:历史已精确一次送达、live 帧由 fan-out 无缝接续 → 本次 attach **no-op**,
///   零重复。执行到 BUG-1 remove 的残留条目必属更旧 conn_gen(gen 持锁读、锁内 attached 不可变,
///   且 conn_gen 单调 ⇒ 条目代次 ≤ gen,不等即更旧),remove 只清真残留、绝不误摘同代在场者。
/// - **in-flight 代次互斥**(并发 case):起始锁内自增 `attach_seq` 分配代次 g 并登记为该 client
///   最新 attach(`attach_gen[id] = g`,覆盖旧值);各校验点(与 conn_gen 同点)比对
///   `attach_gen[id] == g`,不等(被更新的 attach 顶替)即 abort——不发余帧、不插 attached。
///   **后登记者独占**回放,重复范围收敛到「先登记者已发出的帧」(升格瞬间 history 典型只有
///   MirrorStarted 一帧)。退出各路径经 [`FanState::clear_own_attach_gen`] 清理登记,map 不残留。
///
/// 两守卫与既有证明的叠加:幂等守卫命中时不回放、不动 attached(精确一次由先前那次 attach 的
/// 证明继续覆盖);互斥保证任意时刻至多一路「存活的」attach 在为该 client 回放,被顶替者不再
/// 发帧也不插 attached,于是「精确一次 + 有序」证明中的时刻 T(插入 attached 的持锁点)对每个
/// (client, conn_gen) 至多发生一次,由最终存活的那路完成——证明结构不变。
async fn attach_client(fan: &Mutex<FanState>, client: &Client) {
    let (gen, g, mut next_seq) = {
        let mut f = fan.lock().unwrap();
        // BUG-2 守卫的代次捕获,**持锁读**:锁内 attached 不可能被并发 attach 改动,配合
        // conn_gen 单调性可证下方 BUG-1 remove 只清「严格更旧代次」的残留(见函数级说明),
        // 消除「捕获与首锁之间恰逢 reconnect+新 attach 完成,remove 误摘同代在场者」的窗口。
        let gen = client.conn_gen();
        // 同 conn_gen 幂等守卫:同一条下行通道上已完整 attach 过 → no-op(顺序双 attach 零重复;
        // 不动 attached,live 帧继续由 fan_out 投递)。
        if f.attached.get(&client.id) == Some(&gen) {
            return;
        }
        // BUG-1:把本 client.id 的陈旧残留(必属更旧 conn_gen)从 attached 剔除,恢复
        // 「回放期间此 client 不在 attached」不变式。
        f.attached.remove(&client.id);
        // in-flight 代次互斥:登记本次 attach 为该 client 最新(覆盖旧值,顶替一切在飞同伴)。
        f.attach_seq += 1;
        let g = f.attach_seq;
        f.attach_gen.insert(client.id.clone(), g);
        // 回放起点 = 当前最旧仍在缓冲帧的全局序号(更早的已被 2 MiB 淘汰,无法回放)。
        (gen, g, f.history.pushed - f.history.frames.len() as u64)
    };
    loop {
        let batch = {
            let mut f = fan.lock().unwrap();
            // 校验点(持锁,与下方 attached 插入原子):BUG-2 conn_gen + in-flight 互斥。
            // 原子性杜绝「校验通过后、拿锁前被顶替仍把 id 插进 attached」的 check-then-act 竞态
            // (那会让 fan_out 向尚在回放的新连接并发投 live 帧)。
            if client.conn_gen() != gen || f.attach_gen.get(&client.id) != Some(&g) {
                f.clear_own_attach_gen(&client.id, g);
                return;
            }
            let pushed = f.history.pushed;
            if next_seq >= pushed {
                // 已追平:原子登记进 attached(记录完成时的 conn_gen,供同代幂等守卫),后续
                // live 帧改由 fan_out 投递(见证明);同锁内清掉自己的 in-flight 登记
                // (上方刚校验过条目 == g,直接移除)。
                f.attached.insert(client.id.clone(), gen);
                f.attach_gen.remove(&client.id);
                return;
            }
            let batch = f.history.frames_from(next_seq);
            next_seq = pushed;
            batch
        };
        for frame in batch {
            // 校验点(每帧发送前):BUG-2 conn_gen(被 reconnect 顶替)+ in-flight 互斥
            // (被同代新 attach 顶替),任一命中立即放弃——不发余下帧、不插 attached,把
            // 陈旧/重复帧污染通道的窗口收敛到最多一帧。互斥比对须持 fan 锁(临界区仅一次
            // map 查,极短);清理只清仍等于自己代次的登记。
            {
                let mut f = fan.lock().unwrap();
                if client.conn_gen() != gen || f.attach_gen.get(&client.id) != Some(&g) {
                    f.clear_own_attach_gen(&client.id, g);
                    return;
                }
            }
            // Clone the exact generation's sender under Client's downstream
            // lock. Reconnect may not redirect an H0 replay frame into H1.
            if !client.send_async_for_generation(gen, frame).await {
                fan.lock().unwrap().clear_own_attach_gen(&client.id, g);
                return;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// fan-out —— event → 编码 → 入历史 + 广播
// ---------------------------------------------------------------------------

/// 把一条 `AgentEvent` 编码为 `MSG_AGENT_EVENT`(0x50)帧:`[0x50][JSON]`。
/// 抽成独立函数便于单测(断言首字节 + payload 往返)。
fn encode_agent_event(ev: &AgentEvent) -> Vec<u8> {
    let json = serde_json::to_vec(ev).unwrap_or_default();
    protocol::encode_message(protocol::MSG_AGENT_EVENT, &json)
}

/// 处理一条 agent 事件:编码 →【持 fan 锁】入历史 + 只投递给 attached 集合,原子化。
///
/// **不用 `session.broadcast`**:broadcast 会打到所有 connected client(含 handle_ws 步骤2
/// 已注册、但尚未回放的新 client),与随后 attach 的 snapshot 回放重叠 → 重发。只投递给
/// attached(已完成回放)的 client,与 [`attach_client`] 共用同一把锁,精确一次(见模块级说明)。
/// `send_to_client` 只做非阻塞 try_send,临界区短。抽出便于用真实 `Session` + 假 `Client` 单测。
///
/// **惰性剔除**:`send_to_client` 返回 false(client 失联:断开 / 通道关闭 / 不在会话表)时,
/// 该 id 已无意义,投递后统一从 attached 移除——上界收敛到当前在场 client 数,避免历史
/// 断开连接的死 id 无界堆积、每帧空投。先收集失败 id、遍历后再 remove,避免边遍历边改集合。
///
/// **额外副作用(P1-T6)**:除上面照常的帧下行外,对通知性事件再向 `event_bus` publish 一份
/// `DesktopEvent`(经 presence + APNs 下发手机通知):`TurnComplete`→`AgentTurnDone`、
/// `PermissionRequest`→`AgentNeedsApproval`。仅额外副作用,不改变任何事件的帧下行;publish
/// 在 fan 锁释放后进行(broadcast send 非阻塞)。
fn fan_out_one(fan: &Mutex<FanState>, session: &Session, event_bus: &EventBus, ev: &AgentEvent) {
    let frame = encode_agent_event(ev);
    {
        let mut f = fan.lock().unwrap();
        f.history.push(frame.clone());
        let mut dead: Vec<(String, u64)> = Vec::new();
        for (id, expected_conn_gen) in &f.attached {
            if !session.send_to_client_generation(id, *expected_conn_gen, frame.clone()) {
                dead.push((id.clone(), *expected_conn_gen));
            }
        }
        for (id, expected_conn_gen) in dead {
            if f.attached.get(&id) == Some(&expected_conn_gen) {
                f.attached.remove(&id);
            }
        }
    }

    // 额外副作用:通知性事件 publish 到桌面事件总线(不影响上面的帧下行)。
    match ev {
        AgentEvent::TurnComplete { .. } => {
            event_bus.publish(DesktopEvent::AgentTurnDone {
                id: uuid::Uuid::new_v4().to_string(),
                session_id: session.id.clone(),
                session_title: session.title.lock().unwrap().clone(),
            });
        }
        AgentEvent::PermissionRequest { title, .. } => {
            event_bus.publish(DesktopEvent::AgentNeedsApproval {
                id: uuid::Uuid::new_v4().to_string(),
                session_id: session.id.clone(),
                session_title: session.title.lock().unwrap().clone(),
                title: title.clone(),
            });
        }
        _ => {}
    }
}

/// 等待「AcpClient 子进程已关闭」信号:已置 `closed` 立即返回;否则**先注册 waiter
/// (`enable`)再复查 `closed`**——消除「注册前恰好 notify、注册后错过唤醒」的竞态。
/// 前提:置信方(reader EOF / `AcpClient::shutdown`)**先 `closed.store(true)` 再
/// `notify_waiters()`**,故本函数返回时 `closed` 必为 true。抽成自由函数便于单测注入。
async fn wait_closed(closed: &AtomicBool, notify: &Notify) {
    if closed.load(Ordering::SeqCst) {
        return;
    }
    let notified = notify.notified();
    tokio::pin!(notified);
    // enable:在下一次 `closed` 复查之前就把 waiter 挂上——若此后 notify 触发,必被唤醒;
    // 若 notify 已在 enable 前触发(则 closed 已 true),下方复查直接返回,不 await(否则永挂)。
    notified.as_mut().enable();
    if closed.load(Ordering::SeqCst) {
        return;
    }
    notified.await;
}

/// fan-out 主循环:归一事件流 → 逐条编码 + 入历史 + 投递给 attached。四条结束路径:
/// ① `event_rx` 关闭(`None`,生产上 event_tx 常驻 AcpClient,基本只在测试触发);
/// ② `cancel` 触发(会话被显式 delete / stop);③ **子进程关闭**(`wait_closed`,FIX-L2);
/// ④ **idle-guard**(FIX-L3):创建后 `attach_deadline` 内从未 attach **且当前无 connected
/// client** → 视为被抛弃(有 connected client = 正连接中的会话,不误杀,见 idle 分支注释)。
/// 结束后由 [`AcpAgentManager::register`] 的 spawn 包装层收尾(shutdown 子进程 + 移除
/// AgentEntry + 移除 Session)。抽成独立函数便于单测(注入 channel / cancel / closed / 极短 deadline)。
async fn run_fan_out(
    fan: Arc<Mutex<FanState>>,
    session: Arc<Session>,
    event_bus: EventBus,
    cancel: CancellationToken,
    mut event_rx: mpsc::UnboundedReceiver<AgentEvent>,
    closed: Arc<AtomicBool>,
    closed_notify: Arc<Notify>,
    ever_attached: Arc<AtomicBool>,
    attach_deadline: Duration,
) {
    let idle = tokio::time::sleep(attach_deadline);
    tokio::pin!(idle);
    loop {
        tokio::select! {
            ev = event_rx.recv() => {
                match ev {
                    Some(e) => fan_out_one(&fan, &session, &event_bus, &e),
                    None => break, // AcpClient event_rx 关闭(子进程结束/shutdown)
                }
            }
            _ = cancel.cancelled() => break, // 会话被 reap/delete
            _ = wait_closed(&closed, &closed_notify) => break, // 子进程退出 → 回收(FIX-L2)
            _ = &mut idle => {
                // idle-guard(FIX-L3):创建后 attach_deadline 内从未 attach → 判「被抛弃」→ 回收。
                if !ever_attached.load(Ordering::SeqCst) {
                    // FIX(lifecycle-race):仅凭 ever_attached 会误杀「正在连接中」的会话——client
                    // 在 handle_ws 步骤2(add_client)就已登记进 session.clients、connected,但要到
                    // 步骤6(attach)才置 ever_attached,中间隔着 hello/role 的 await。deadline 恰落在
                    // 这个 add_client→attach 窗口时,单看 !ever_attached 会把正连接的会话误回收。故再
                    // 验「当前确无 connected client」:真从头到尾无人连才回收(idle-guard 原语义);
                    // 有 connected client(正连接中)则重置 deadline 再给一轮——待 attach 完成走下面
                    // 的 86400 分支,或该连接掉线(connected 归零)后下一轮再回收,不留僵尸。
                    if session.connected_client_count() == 0 {
                        break;
                    }
                    idle
                        .as_mut()
                        .reset(tokio::time::Instant::now() + attach_deadline);
                } else {
                    // 已 attach 过:随子进程存活,guard 失效。把已 elapsed 的定时器推到极远,
                    // 避免每轮立即就绪造成忙轮询(此后回收只靠子进程死亡 / cancel)。
                    idle
                        .as_mut()
                        .reset(tokio::time::Instant::now() + Duration::from_secs(86_400));
                }
            }
        }
    }
}

/// 镜像会话 fan-out 主循环(方案甲):归一**外部喂入**的镜像事件流(M3 hooks / M4 transcript)→
/// 逐条编码 + 入历史 + 投递给 attached(复用 [`fan_out_one`],与 ACP 同一套「精确一次 + 有序」不变式)。
///
/// 与 ACP 的 [`run_fan_out`] 的关键区别 —— 镜像**没有 AcpClient 子进程**,故只有三条结束路径:
/// ① `event_rx` 关闭(`None`:全部 event_tx drop);② `cancel` 触发(底层 PTY 会话被
/// delete/reap → `session.cancel()`);③ **MirrorEnded 终结**(FIX-5:claude 退出,cleanup
/// 发出的最后一条事件——广播完它立即收尾,不再 drain 尾随事件)。
/// **不 wait_closed**(无子进程可等)、**不 idle-guard**(镜像在 SessionStart 时 claude 已在跑,
/// 非「创建后无人连」——会话存活由终端会话生命周期 + reaper 负责,不在此回收)。`select!` 别无
/// 其它分支,退出条件封闭可证:除上述三条外无从返回,故绝不因 idle / 无子进程而误退。抽成独立
/// 函数便于单测(注入 channel / cancel,断言恰在这三条路径结束、其余情形一直阻塞不误退)。
async fn run_mirror_fan_out(
    fan: Arc<Mutex<FanState>>,
    session: Arc<Session>,
    event_bus: EventBus,
    cancel: CancellationToken,
    mut event_rx: mpsc::UnboundedReceiver<AgentEvent>,
) {
    loop {
        tokio::select! {
            ev = event_rx.recv() => {
                match ev {
                    Some(e) => {
                        // FIX-5:MirrorEnded 是终结事件——广播完即收尾。event_rx 随本函数
                        // 返回而 drop,此后 tailer 并发滞留的 send 直接失败(其 send-fail
                        // 路径本就退出),结构性保证 MirrorEnded 是 wire 上最后一条
                        // (手机端不会被尾随事件拉回镜像态、冒孤儿气泡)。
                        let ended = matches!(e, AgentEvent::MirrorEnded);
                        fan_out_one(&fan, &session, &event_bus, &e);
                        if ended {
                            break;
                        }
                    }
                    None => break, // 镜像事件源关闭(全部 sender drop)
                }
            }
            _ = cancel.cancelled() => break, // 底层 PTY 会话被 delete/reap
        }
    }
}

/// fan-out 主循环结束后的收尾:`shutdown`(kill 子进程,幂等)→ 从 AcpAgentManager
/// 移除本条目 → **从 SessionManager 移除本 Session**。三步覆盖所有终局,不留残留。
///
/// 第三步(FIX-L2 的关键):子进程死亡 / idle-guard 路径下 Session 仍在 SessionManager
/// 表中、且被 FIX-L1 豁免了 client-TTL 回收,若不移除即成永不回收的僵尸。`delete` 会
/// 广播 SESSION_END + cancel + 清理;若会话已被显式 delete / stop 移走 → 返回 Err,忽略
/// (幂等,不重复广播/清理)。故三条回收路径(子进程死 / idle-guard / 显式 delete)终态一致:
/// AgentEntry 与 Session 都被清。
///
/// 把「post-loop 收尾」抽成独立函数 + 注入 `shutdown` future:`register` 真实路径传
/// `client.shutdown()`;测试传一个设置 flag 的 future,即可在**无真实子进程**下锁定
/// 「各终止路径都会 remove_entry + delete Session」。
async fn finalize_fan_out<F>(
    manager: &AcpAgentManager,
    session_manager: &SessionManager,
    session_id: &str,
    shutdown: F,
) where
    F: std::future::Future<Output = ()>,
{
    shutdown.await;
    manager.remove_entry(session_id);
    let _ = session_manager.delete(session_id);
}

/// 镜像会话 fan-out 收尾(方案甲):**只从 AcpAgentManager 移除自己的条目**。
///
/// 与 ACP 的 [`finalize_fan_out`] 的根本区别:镜像结束 = claude 退出(SessionEnd hook),但底层
/// local-shell 会话的 PTY shell **仍在运行**、终端页继续可用,故**绝不删 Session**(那会误杀
/// 用户的 shell)。也**不 shutdown**(无子进程)、**不清 hook secret**(secret 绑 PTY 会话生命
/// 周期,同一 PTY 可再跑 claude → 再 register_mirror;secret 由 `SessionManager::reap` 在会话真正
/// 消失时统一清,见 §M5-5)。
///
/// FIX-2:必须带身份守卫删除([`AcpAgentManager::remove_entry_if_same`])——Task D 的
/// cleanup 打破了「entry 会话期内从不移除」旧不变式,cleanup 后新 SessionStart 可在旧
/// fan-out drain 完(毫秒级窗口)之前 register 新 entry,裸 remove 会误删新 entry
/// (新镜像 agents.get→None,手机整段无法 attach)。抽成独立函数便于单测。
fn finalize_mirror(manager: &AcpAgentManager, session_id: &str, entry: &Arc<AgentEntry>) {
    manager.remove_entry_if_same(session_id, entry);
}

// ---------------------------------------------------------------------------
// AcpAgentManager —— 注册表
// ---------------------------------------------------------------------------

/// agent 会话注册表 —— `session_id -> Arc<AgentEntry>` 的线程安全映射。
///
/// `Clone` 共享内部 `Arc<Mutex<..>>`,与 `PresenceRegistry`/`PushRegistry` 同一模式,
/// 多处持有的克隆体操作同一份数据。
#[derive(Clone)]
pub struct AcpAgentManager {
    inner: Arc<Mutex<HashMap<String, Arc<AgentEntry>>>>,
}

impl AcpAgentManager {
    /// 新建空注册表。
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 查询某会话的 agent 条目(不存在则 `None`)。存在即判定「这是 agent 会话」。
    pub fn get(&self, id: &str) -> Option<Arc<AgentEntry>> {
        self.inner.lock().unwrap().get(id).cloned()
    }

    /// 当前托管的 agent 会话数。
    pub fn len(&self) -> usize {
        self.inner.lock().unwrap().len()
    }

    /// 是否无任何 agent 会话。
    pub fn is_empty(&self) -> bool {
        self.inner.lock().unwrap().is_empty()
    }

    /// 登记一个 agent 会话并起 fan-out 任务(一次搞定,handler 更薄)。
    ///
    /// fan-out 任务:`run_fan_out`(event_rx → 编码 + 入历史 + 广播)结束后收尾——
    /// `client.shutdown()`(kill 子进程,幂等)+ 移除 AgentEntry + 移除 Session。
    /// run_fan_out 的四条结束路径(event_rx 关闭 / cancel(显式 delete·stop)/ **子进程
    /// 退出**(FIX-L2)/ **idle-guard**(FIX-L3))都会驱动其返回并收尾,从而**无子进程 /
    /// 会话泄漏**。agent 会话「随子进程存活」:手机断连使其 Draining 时被 reaper 豁免
    /// client-TTL 回收(FIX-L1),回收改由上述子进程死 / idle-guard / 显式 delete 三路兜住。
    pub fn register(
        &self,
        session_id: String,
        client: Arc<AcpClient>,
        event_rx: mpsc::UnboundedReceiver<AgentEvent>,
        session: Arc<Session>,
        session_manager: Arc<SessionManager>,
        event_bus: EventBus,
        cancel: CancellationToken,
        meta: AgentMeta,
    ) -> Arc<AgentEntry> {
        let fan = Arc::new(Mutex::new(FanState::new()));
        let ever_attached = Arc::new(AtomicBool::new(false));
        let entry = Arc::new(AgentEntry {
            client: Some(client.clone()),
            fan: fan.clone(),
            meta,
            task: Mutex::new(None),
            busy: AtomicBool::new(false),
            ever_attached: ever_attached.clone(),
        });
        // 先存表:fan-out 收尾能据 session_id 移除自己;ws attach 分支能据表判定 agent 会话。
        self.inner
            .lock()
            .unwrap()
            .insert(session_id.clone(), entry.clone());

        let manager = self.clone();
        // 子进程关闭信号(reader EOF / shutdown 触发),供 run_fan_out 感知子进程死亡。
        let (closed, closed_notify) = client.closed_signal();
        let handle = tokio::spawn(async move {
            run_fan_out(
                fan,
                session,
                event_bus,
                cancel,
                event_rx,
                closed,
                closed_notify,
                ever_attached,
                ATTACH_DEADLINE,
            )
            .await;
            // 收尾:kill 子进程(shutdown 幂等,与外部 remove 不冲突)+ 移除 AgentEntry +
            // 移除 Session(子进程死 / idle-guard 路径下 Session 仍在表且豁免了 TTL,须显式清)。
            finalize_fan_out(&manager, &session_manager, &session_id, client.shutdown()).await;
        });
        *entry.task.lock().unwrap() = Some(handle);
        entry
    }

    /// 登记一个**镜像**会话(方案甲)并起镜像 fan-out 任务。
    ///
    /// 与 [`register`](Self::register) 的三点关键区别:
    /// - `client=None`、`kind=Mirror`:事件源不是 AcpClient 子进程,而是外部喂入的 `event_rx`
    ///   (M3 的 hook 端点 / M4 的 transcript tailer 归一为 [`AgentEvent`] 后 send)。
    /// - fan-out 用 [`run_mirror_fan_out`]:只有 `event_rx 关闭` / `cancel` 两条结束路径,
    ///   **不 wait_closed**(无子进程)、**不 idle-guard**(镜像在 SessionStart 时 claude 已在跑)。
    /// - 收尾用 [`finalize_mirror`]:**只 remove_entry,绝不删 PTY 会话**——镜像结束 = claude 退出,
    ///   但底层 local-shell 会话仍在、终端页继续可用(会话回收另由终端 reaper / 显式 delete 负责)。
    ///
    /// `cancel` 取自底层 PTY 会话的 cancellation token:会话被 delete/reap 时 `session.cancel()`
    /// 触发,镜像 fan-out 随之收尾。fan / history / attached 与 ACP 路径完全一致(共用 `fan_out_one`
    /// / `attach_client`),故「精确一次 + 有序」+ 背压回放不变式对镜像事件同样成立。
    pub fn register_mirror(
        &self,
        session_id: String,
        event_rx: mpsc::UnboundedReceiver<AgentEvent>,
        session: Arc<Session>,
        event_bus: EventBus,
    ) -> Arc<AgentEntry> {
        let fan = Arc::new(Mutex::new(FanState::new()));
        let entry = Arc::new(AgentEntry {
            client: None, // 镜像无 AcpClient,事件源是外部喂入的 mpsc
            fan: fan.clone(),
            meta: AgentMeta {
                agent: "claude".to_string(),
                cwd: String::new(),
                kind: AgentKind::Mirror,
            },
            task: Mutex::new(None),
            busy: AtomicBool::new(false),
            // 镜像不参与 idle-guard(run_mirror_fan_out 无该分支);字段仍在,attach 照常置 true。
            ever_attached: Arc::new(AtomicBool::new(true)),
        });
        // 先存表:ws / ipc attach 分支据表判定 agent 会话;收尾据 session_id 移除自己。
        self.inner
            .lock()
            .unwrap()
            .insert(session_id.clone(), entry.clone());

        let manager = self.clone();
        // 底层 PTY 会话的 cancel token:会话被 delete/reap 时触发,驱动镜像 fan-out 收尾。
        let cancel = session.cancellation_token();
        // FIX-2:收尾任务持有自己的 entry Arc,finalize 时锁内 Arc::ptr_eq 比对身份——
        // 旧 fan-out 滞后收尾不误删新 SessionStart 刚 register 的新 entry。
        // (任务由 tokio runtime 拥有,结束即 drop 捕获,entry 的这份 Arc 不成环。)
        let fanout_entry = entry.clone();
        let handle = tokio::spawn(async move {
            run_mirror_fan_out(fan, session, event_bus, cancel, event_rx).await;
            // 镜像收尾:只从表移除**自己的** entry,**绝不删 PTY 会话**、不清 secret(见 finalize_mirror)。
            finalize_mirror(&manager, &session_id, &fanout_entry);
        });
        *entry.task.lock().unwrap() = Some(handle);
        entry
    }

    /// 测试专用:直接往注册表塞一个条目(绕过 `register` 的子进程依赖),
    /// 供表增删([`manager_remove_entry_updates_table`])与收尾移除([`finalize_fan_out`])断言。
    #[cfg(test)]
    fn insert_for_test(&self, id: &str, entry: Arc<AgentEntry>) {
        self.inner.lock().unwrap().insert(id.to_string(), entry);
    }

    /// 仅从表移除条目(不 shutdown、不 abort)。fan-out 收尾路径调用;若已被外部
    /// `remove` 移走则为 no-op。
    fn remove_entry(&self, id: &str) -> Option<Arc<AgentEntry>> {
        self.inner.lock().unwrap().remove(id)
    }

    /// 身份守卫移除(FIX-2):仅当表中该 id 现存条目与 `expected` 是**同一个 Arc**
    /// (`Arc::ptr_eq`,锁内比对)才移除,返回是否移除。镜像收尾专用:旧 fan-out 滞后收尾
    /// 时表中可能已被新 SessionStart 换成新 entry,裸 remove 会误删新 entry——ptr_eq
    /// 比对后旧收尾只能删旧 entry(见 [`finalize_mirror`])。
    fn remove_entry_if_same(&self, id: &str, expected: &Arc<AgentEntry>) -> bool {
        let mut map = self.inner.lock().unwrap();
        if map.get(id).is_some_and(|cur| Arc::ptr_eq(cur, expected)) {
            map.remove(id);
            true
        } else {
            false
        }
    }

    /// 显式清理一个 agent 会话:从表移除 → `shutdown` 子进程 → abort fan-out 任务。
    ///
    /// 常规销毁由会话 cancel token 驱动 fan-out 自收尾;此法供未来显式清理路径。
    /// 与 fan-out 自收尾并发也安全:`remove_entry` 保证只有一方拿到 entry,
    /// `shutdown` 幂等,重复 abort 无害。
    pub async fn remove(&self, id: &str) {
        let entry = self.inner.lock().unwrap().remove(id);
        if let Some(entry) = entry {
            if let Some(client) = entry.client() {
                client.shutdown().await;
            }
            let handle = entry.task.lock().unwrap().take();
            if let Some(h) = handle {
                h.abort();
            }
        }
    }
}

impl Default for AcpAgentManager {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// validate_agent_req —— 创建请求校验(纯函数)
// ---------------------------------------------------------------------------

/// agent 会话创建请求的校验错误(REST handler 映射为 400 + `code`)。
#[derive(Debug, PartialEq, Eq)]
pub enum AgentReqError {
    /// 未知/不支持的 agent 名。
    UnsupportedAgent,
    /// cwd 非法(空 / 非绝对路径 / 不存在 / 不是目录)。
    InvalidCwd,
}

impl AgentReqError {
    /// 稳定的机器可读错误码(REST 响应 `{"code": ...}`)。
    pub fn code(&self) -> &'static str {
        match self {
            AgentReqError::UnsupportedAgent => "unsupported_agent",
            AgentReqError::InvalidCwd => "invalid_cwd",
        }
    }
}

/// 校验 agent 会话创建参数(纯函数,便于单测)。成功返回拉起 agent 的 `AcpCommand`。
///
/// - `agent`:目前只认 `"claude"` → `AcpCommand::claude_code()`;其它 → `UnsupportedAgent`。
/// - `cwd`:必须非空、绝对路径、存在且是目录;否则 `InvalidCwd`。
pub fn validate_agent_req(agent: &str, cwd: &str) -> Result<AcpCommand, AgentReqError> {
    let cmd = match agent {
        "claude" => AcpCommand::claude_code(),
        _ => return Err(AgentReqError::UnsupportedAgent),
    };
    let path = std::path::Path::new(cwd);
    if cwd.is_empty() || !path.is_absolute() || !path.is_dir() {
        return Err(AgentReqError::InvalidCwd);
    }
    Ok(cmd)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "manager_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "manager_guard_validation_tests.rs"]
mod guard_validation_tests;

// 镜像会话(方案甲 M5)测试拆到独立文件,保持两个测试文件都在 1000 行以内(项目规范)。
#[cfg(test)]
#[path = "manager_mirror_tests.rs"]
mod mirror_tests;
