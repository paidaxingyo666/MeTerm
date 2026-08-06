//! 审批桥(P2:PermissionRequest hook 同步阻塞桥到手机)。
//!
//! 链路:claude 弹权限前触发 `PermissionRequest` hook(**非 async**,claude 阻塞等 hook
//! 输出)→ 转发脚本长超时 POST `/api/agent-hook` → handler 在本桥登记 pending、把审批卡
//! (`AgentEvent::PermissionRequest`,复用方案 B 的 0x50 冻结契约与手机审批卡 UI)下行 →
//! 手机 0x52 approve/reject → `upstream.rs` 经 [`PermissionBridge::resolve`] 回投决策 →
//! handler 返回 `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":…}}`
//! → claude 按 allow/deny 放行/拒绝,**全程 TUI 不弹窗**(local 模式手机可批,Happy 做不到)。
//!
//! **回落纪律(fail-open-to-TUI)**:任何异常路径——桥超时、claude 退出 drain、通道断、
//! 非镜像会话——handler 都返回**空 body**,claude 视为 hook 不干预 → 原生 TUI 弹窗兜底。
//! 审批永远不会因镜像层故障而被吞。
//!
//! **零 token 白名单**(§4.7):allow 返回纯 decision(不带 updatedInput/updatedPermissions,
//! 零注入);deny 携带固定 message(喂给 claude 的拒绝原因,与终端里拒绝完全一致的几个 token,
//! 设计明确豁免)。除此之外本桥不产生任何会进模型上下文的输出。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

/// 手机对一次审批请求的决策。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionReply {
    /// 允许本次(behavior=allow,零注入)。对齐终端第一项 "Yes"。
    Allow,
    /// 总是允许(fix12:behavior=allow + updatedPermissions=hook 携带的
    /// permission_suggestions 原样)。对齐终端第二项 "Yes, don't ask again…"。
    AllowAlways,
    /// 拒绝本次(behavior=deny)。`message` = 用户给 Claude 的说明(对齐终端第三项
    /// "No, and tell Claude what to do differently");None → 固定默认文案。
    Deny(Option<String>),
    /// 带答案允许(fix11:AskUserQuestion——behavior=allow + updatedInput 预填
    /// `answers`,key=question 原文、value=答案文本;masko-code 同款 wire)。
    /// 注:answers 是用户自己的回答注入自己的会话,与终端里作答等价,零额外 token 面。
    AllowWithAnswers(HashMap<String, String>),
}

/// 一条在飞的审批请求:决策回投通道 + 归属的 PTY 会话(claude 退出时按会话 drain)。
struct PendingPermission {
    pty_sid: String,
    tx: oneshot::Sender<PermissionReply>,
}

/// 审批 pending 注册表:`request_id(自生成 uuid)-> 在飞审批`。
///
/// `Clone` 共享内部 `Arc<Mutex<..>>`(仿 `MirrorRegistry` 范式)。**不持有 Session /
/// ServerState**(只有 String + oneshot sender),可被 7768 兜底回调闭包安全捕获,
/// 无 Arc 循环风险。生命周期:handler 登记 → 手机决策 `resolve` / handler 超时
/// `remove` / claude 退出 `drain_session`,三者幂等收敛(sender drop = handler 的
/// rx 收 Err → 空响应回落 TUI)。
#[derive(Clone)]
pub struct PermissionBridge {
    inner: Arc<Mutex<HashMap<String, PendingPermission>>>,
}

impl PermissionBridge {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 登记一条在飞审批,返回决策接收端(handler 带超时 await 它)。
    /// 同 request_id 重复登记会顶替旧条目(uuid 自生成,实际不可能撞)。
    pub fn register(&self, pty_sid: &str, request_id: &str) -> oneshot::Receiver<PermissionReply> {
        let (tx, rx) = oneshot::channel();
        self.inner.lock().unwrap().insert(
            request_id.to_string(),
            PendingPermission {
                pty_sid: pty_sid.to_string(),
                tx,
            },
        );
        rx
    }

    /// 手机决策回投:移除 pending 并 send。返回 `false` = 无此 request_id
    /// (已超时清理 / 已决策 / claude 已退出 drain),调用方回「审批已过期」错误帧。
    pub fn resolve(&self, request_id: &str, reply: PermissionReply) -> bool {
        match self.inner.lock().unwrap().remove(request_id) {
            Some(p) => p.tx.send(reply).is_ok(),
            None => false,
        }
    }

    /// handler 超时路径:撤销登记(rx 已 drop,决策无处可投)。幂等。
    pub fn remove(&self, request_id: &str) {
        self.inner.lock().unwrap().remove(request_id);
    }

    /// claude 退出 / 会话销毁:移除该 PTY 会话全部在飞审批。sender drop → 各 handler 的
    /// rx 立即收 Err → 空响应(回落 TUI;claude 都退出了,响应也只是给已死进程)。
    pub fn drain_session(&self, pty_sid: &str) {
        self.inner
            .lock()
            .unwrap()
            .retain(|_, p| p.pty_sid != pty_sid);
    }

    /// 该 PTY 会话是否有在飞审批(Notification 分支据此抑制重复的 attention 卡:
    /// 审批卡已在手机上,attention「去终端确认」的指引是多余且过时的)。
    pub fn has_pending(&self, pty_sid: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .values()
            .any(|p| p.pty_sid == pty_sid)
    }
}

impl Default for PermissionBridge {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// register → resolve(Allow):rx 收到决策;resolve 返回 true;条目被移除
    /// (再次 resolve 返回 false)。
    #[tokio::test]
    async fn register_then_resolve_delivers_reply_exactly_once() {
        let bridge = PermissionBridge::new();
        let rx = bridge.register("pty-1", "req-1");
        assert!(bridge.has_pending("pty-1"));

        assert!(bridge.resolve("req-1", PermissionReply::Allow));
        assert_eq!(rx.await.unwrap(), PermissionReply::Allow);
        assert!(!bridge.has_pending("pty-1"), "决策后条目应移除");
        assert!(
            !bridge.resolve("req-1", PermissionReply::Deny(None)),
            "重复决策应返回 false(已决)"
        );
    }

    /// 未登记的 request_id → resolve 返回 false(超时清理后手机迟到的决策)。
    #[tokio::test]
    async fn resolve_unknown_request_returns_false() {
        let bridge = PermissionBridge::new();
        assert!(!bridge.resolve("ghost", PermissionReply::Allow));
    }

    /// remove(handler 超时路径)后 resolve false;rx 收 Err(sender drop)。
    #[tokio::test]
    async fn remove_drops_sender_and_blocks_late_resolve() {
        let bridge = PermissionBridge::new();
        let rx = bridge.register("pty-1", "req-1");
        bridge.remove("req-1");
        assert!(rx.await.is_err(), "remove 后 rx 应收 Err(空响应回落 TUI)");
        assert!(!bridge.resolve("req-1", PermissionReply::Allow));
    }

    /// drain_session:只清该会话的 pending,别的会话不受影响;被清的 rx 收 Err。
    #[tokio::test]
    async fn drain_session_only_clears_that_session() {
        let bridge = PermissionBridge::new();
        let rx_a = bridge.register("pty-a", "req-a");
        let rx_b = bridge.register("pty-b", "req-b");

        bridge.drain_session("pty-a");
        assert!(rx_a.await.is_err(), "被 drain 的审批应收 Err");
        assert!(!bridge.has_pending("pty-a"));
        assert!(bridge.has_pending("pty-b"), "别的会话不受影响");

        assert!(bridge.resolve("req-b", PermissionReply::Deny(None)));
        assert_eq!(rx_b.await.unwrap(), PermissionReply::Deny(None));
    }
}
