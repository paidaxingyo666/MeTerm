//! 桌面级事件总线 — 把各会话的通知性事件 + 会话增删事件 fan-out 给所有
//! presence 订阅者(手机端常驻 WS `/ws-events`,见后续任务)。
//!
//! 设计:
//! - `EventBus` 内部包一个 `tokio::sync::broadcast::Sender`,`publish` 时若无
//!   订阅者会返回 `SendError`,这里直接忽略(符合 broadcast 的"至多不保证有人听"语义)。
//! - `PresenceRegistry` 记录当前在线的 presence 客户端(client_id → 可选 device_id),
//!   P1 阶段只用它判断"是否有人在线"(`has_any`),device_id 留给 P3 做推送判定用。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

use super::auth::TrustedIngress;

/// broadcast channel 容量:presence 订阅者一般很少(手机端 0~1 个),
/// 256 足够覆盖突发通知而不至于让慢订阅者无限堆积内存。
const EVENT_BUS_CAPACITY: usize = 256;

/// 桌面事件 — 经 presence WS 转发给手机的负载类型。
///
/// `#[serde(tag = "t")]` 使 JSON 形如 `{"t":"notify",...}` / `{"t":"sessions"}`,
/// 与手机端 `DesktopEvent` Decodable 按 `t` 字段分派一致。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t")]
pub enum DesktopEvent {
    /// 某会话产生了一条通知性 OSC 事件(如 `OscEvent::Notify`)。
    #[serde(rename = "notify")]
    Notify {
        id: String,
        session_id: String,
        /// 会话标题(OSC 窗口标题,可能为空——未设置过标题的会话原样传空串,
        /// 由手机端回退成"会话 <短id>" 展示,桌面侧不做回退)。
        session_title: String,
        title: String,
        body: String,
    },
    /// 会话列表发生了增删,提示订阅者主动刷新(替代轮询)。
    #[serde(rename = "sessions")]
    SessionsChanged,

    /// 长命令完成(shell 集成 OSC 7768 且耗时超阈值);手机侧本地化格式化后呈现。
    #[serde(rename = "cmd_done")]
    CmdDone {
        id: String,
        session_id: String,
        /// 会话标题,语义同 `Notify::session_title`。
        session_title: String,
        cmd: String,
        exit: i32,
        duration_ms: u64,
    },

    /// agent 会话一轮结束(ACP `TurnComplete`);手机侧提示"该轮已完成"。
    #[serde(rename = "agent_turn_done")]
    AgentTurnDone {
        /// 每条事件唯一 id(手机通知身份 / 去重),生成自 `Uuid::new_v4`。
        id: String,
        session_id: String,
        /// 会话标题,语义同 `Notify::session_title`(agent 会话由 cwd basename 兜底)。
        session_title: String,
    },

    /// agent 会话需要用户审批(ACP 反向请求 `session/request_permission`);
    /// 手机侧提示"需要审批",`title` = 待审批工具标题(来自 `AgentEvent::PermissionRequest.title`)。
    #[serde(rename = "agent_needs_approval")]
    AgentNeedsApproval {
        /// 每条事件唯一 id(手机通知身份 / 去重),生成自 `Uuid::new_v4`。
        id: String,
        session_id: String,
        /// 会话标题,语义同 `Notify::session_title`。
        session_title: String,
        /// 待审批工具标题。
        title: String,
    },
}

/// 桌面事件总线 — `broadcast::Sender` 的轻量封装。
///
/// `Clone` 只是克隆内部 `Sender`(broadcast 的 Sender 本就是 `Arc` 语义的多生产者句柄),
/// 因此多处持有的 `EventBus` 克隆体仍共享同一条 channel。
#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<DesktopEvent>,
}

impl EventBus {
    /// 新建事件总线,内部 channel 容量固定为 `EVENT_BUS_CAPACITY`。
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(EVENT_BUS_CAPACITY);
        Self { tx }
    }

    /// 发布一条事件给所有当前订阅者。
    ///
    /// 无订阅者时 `send` 返回 `Err(SendError)`——这是 broadcast 的正常语义
    /// (没人订阅就没人能收到),不是错误,这里直接忽略、不 panic。
    pub fn publish(&self, e: DesktopEvent) {
        let _ = self.tx.send(e);
    }

    /// 订阅事件总线。只会收到**订阅之后**发布的事件(broadcast 语义,
    /// 订阅前的历史事件不会被回放)。
    pub fn subscribe(&self) -> broadcast::Receiver<DesktopEvent> {
        self.tx.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

/// presence 客户端注册表 — 记录当前连着 `/ws-events` 的客户端。
///
/// key = client_id(每条 presence 连接生成一个),value = 可选 device_id
/// (P1 阶段不强制填,留给 P3 做"该设备是否在线"的推送判定用)。
///
/// `Clone` 共享内部 `Arc<Mutex<..>>`,多处持有的克隆体操作同一份注册表。
#[derive(Clone)]
pub struct PresenceRegistry {
    inner: Arc<Mutex<HashMap<String, PresenceEntry>>>,
}

struct PresenceEntry {
    device_id: Option<String>,
    credential_generation: Option<uuid::Uuid>,
    revocable_device: bool,
    ingress: TrustedIngress,
    cancel: CancellationToken,
}

impl PresenceRegistry {
    /// 新建空注册表。
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 登记一个 presence 客户端上线。
    pub(crate) fn insert(
        &self,
        client_id: String,
        device_id: Option<String>,
        credential_generation: Option<uuid::Uuid>,
        revocable_device: bool,
    ) -> CancellationToken {
        self.insert_with_ingress(
            client_id,
            device_id,
            credential_generation,
            revocable_device,
            TrustedIngress::DirectLoopback,
        )
    }

    pub(crate) fn insert_with_ingress(
        &self,
        client_id: String,
        device_id: Option<String>,
        credential_generation: Option<uuid::Uuid>,
        revocable_device: bool,
        ingress: TrustedIngress,
    ) -> CancellationToken {
        let cancel = CancellationToken::new();
        self.inner.lock().unwrap().insert(
            client_id,
            PresenceEntry {
                device_id,
                credential_generation,
                revocable_device,
                ingress,
                cancel: cancel.clone(),
            },
        );
        cancel
    }

    /// Cancel only presence sockets accepted through one trusted transport.
    pub(crate) fn disconnect_ingress(&self, ingress: TrustedIngress) -> usize {
        let mut entries = self.inner.lock().unwrap();
        let matching: Vec<String> = entries
            .iter()
            .filter(|(_, entry)| entry.ingress == ingress)
            .map(|(client_id, _)| client_id.clone())
            .collect();
        for client_id in &matching {
            if let Some(entry) = entries.remove(client_id) {
                entry.cancel.cancel();
            }
        }
        matching.len()
    }

    /// 注销一个 presence 客户端(断开连接时调用)。
    pub fn remove(&self, client_id: &str) {
        self.inner.lock().unwrap().remove(client_id);
    }

    /// 是否有任意 presence 客户端在线。
    pub fn has_any(&self) -> bool {
        !self.inner.lock().unwrap().is_empty()
    }

    /// 当前在线的所有手机 `device_id` 集合(终端通知 Phase 3:离线推送判定用)。
    ///
    /// 同一 `device_id` 可能有多个 presence client_id(不同页面/重连未及时清理旧连接),
    /// 用 `HashSet` 天然去重。未带 `device_id` 的旧式连接(值为 `None`)不计入。
    pub fn online_devices(&self) -> std::collections::HashSet<String> {
        self.inner
            .lock()
            .unwrap()
            .values()
            .filter_map(|entry| entry.device_id.clone())
            .collect()
    }

    /// Cancel and unregister device-authenticated presence sockets. `None`
    /// revokes all devices; `Some(id)` revokes one stable device identity.
    pub(crate) fn disconnect_device_principals(&self, device_id: Option<&str>) -> usize {
        let mut entries = self.inner.lock().unwrap();
        let matching: Vec<String> = entries
            .iter()
            .filter(|(_, entry)| {
                entry.revocable_device
                    && device_id.is_none_or(|expected| entry.device_id.as_deref() == Some(expected))
            })
            .map(|(client_id, _)| client_id.clone())
            .collect();
        for client_id in &matching {
            if let Some(entry) = entries.remove(client_id) {
                entry.cancel.cancel();
            }
        }
        matching.len()
    }

    pub(crate) fn disconnect_device_generation(
        &self,
        device_id: &str,
        generation: uuid::Uuid,
    ) -> usize {
        let mut entries = self.inner.lock().unwrap();
        let matching: Vec<String> = entries
            .iter()
            .filter(|(_, entry)| {
                entry.device_id.as_deref() == Some(device_id)
                    && entry.credential_generation == Some(generation)
            })
            .map(|(client_id, _)| client_id.clone())
            .collect();
        for client_id in &matching {
            if let Some(entry) = entries.remove(client_id) {
                entry.cancel.cancel();
            }
        }
        matching.len()
    }

    /// Cancel only presence sockets authenticated by a retired owner-token
    /// generation. Device presence entries are marked `revocable_device` and
    /// therefore cannot be swept by an owner rotation.
    pub(crate) fn disconnect_owner_generation(&self, generation: uuid::Uuid) -> usize {
        let mut entries = self.inner.lock().unwrap();
        let matching: Vec<String> = entries
            .iter()
            .filter(|(_, entry)| {
                !entry.revocable_device && entry.credential_generation == Some(generation)
            })
            .map(|(client_id, _)| client_id.clone())
            .collect();
        for client_id in &matching {
            if let Some(entry) = entries.remove(client_id) {
                entry.cancel.cancel();
            }
        }
        matching.len()
    }
}

impl Default for PresenceRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// subscribe 之前发布的事件不应被收到(broadcast 语义:只收订阅之后的)。
    #[tokio::test]
    async fn publish_before_subscribe_is_not_received() {
        let bus = EventBus::new();
        // 先 publish(此时无订阅者,应静默忽略,不 panic)。
        bus.publish(DesktopEvent::SessionsChanged);

        // 再 subscribe,然后 publish 一条新事件。
        let mut rx = bus.subscribe();
        bus.publish(DesktopEvent::Notify {
            id: "id-1".to_string(),
            session_id: "sess-1".to_string(),
            session_title: "会话A".to_string(),
            title: "标题".to_string(),
            body: "正文".to_string(),
        });

        let received = rx.recv().await.expect("应收到 subscribe 之后发布的事件");
        match received {
            DesktopEvent::Notify {
                id,
                session_id,
                session_title,
                title,
                body,
            } => {
                assert_eq!(id, "id-1");
                assert_eq!(session_id, "sess-1");
                assert_eq!(session_title, "会话A");
                assert_eq!(title, "标题");
                assert_eq!(body, "正文");
            }
            other => panic!("expected Notify, got {:?}", other),
        }
    }

    /// 同一条 publish 应能被多个 subscriber 都收到(fan-out)。
    #[tokio::test]
    async fn two_subscribers_both_receive_same_publish() {
        let bus = EventBus::new();
        let mut rx1 = bus.subscribe();
        let mut rx2 = bus.subscribe();

        bus.publish(DesktopEvent::SessionsChanged);

        let e1 = rx1.recv().await.expect("subscriber 1 应收到事件");
        let e2 = rx2.recv().await.expect("subscriber 2 应收到事件");

        assert!(matches!(e1, DesktopEvent::SessionsChanged));
        assert!(matches!(e2, DesktopEvent::SessionsChanged));
    }

    /// PresenceRegistry 的 insert/remove/has_any 基本行为。
    #[test]
    fn presence_registry_insert_remove_has_any() {
        let reg = PresenceRegistry::new();
        assert!(!reg.has_any(), "初始应为空");

        reg.insert("client-a".to_string(), None, None, false);
        assert!(reg.has_any(), "insert 后应非空");

        reg.insert(
            "client-b".to_string(),
            Some("device-123".to_string()),
            Some(uuid::Uuid::new_v4()),
            true,
        );
        assert!(reg.has_any());

        reg.remove("client-a");
        assert!(reg.has_any(), "移除一个后仍有 client-b 在线");

        reg.remove("client-b");
        assert!(!reg.has_any(), "全部移除后应为空");
    }

    /// online_devices:收集所有非 None 的 device_id,去重;不带身份的连接(None)不计入。
    #[test]
    fn presence_registry_online_devices_collects_and_dedups() {
        let reg = PresenceRegistry::new();
        assert!(reg.online_devices().is_empty(), "初始应为空集合");

        // 无 device_id 的旧式连接不应出现在 online_devices 里。
        reg.insert("client-anon".to_string(), None, None, false);
        assert!(
            reg.online_devices().is_empty(),
            "无身份连接不计入 online_devices"
        );

        reg.insert(
            "client-a".to_string(),
            Some("device-1".to_string()),
            Some(uuid::Uuid::new_v4()),
            true,
        );
        reg.insert(
            "client-b".to_string(),
            Some("device-2".to_string()),
            Some(uuid::Uuid::new_v4()),
            true,
        );
        // 同一 device_id 的第二条连接(如重连未及时清理旧连接)应去重。
        reg.insert(
            "client-c".to_string(),
            Some("device-1".to_string()),
            Some(uuid::Uuid::new_v4()),
            true,
        );

        let online = reg.online_devices();
        assert_eq!(online.len(), 2, "去重后应只剩 2 个不同的 device_id");
        assert!(online.contains("device-1"));
        assert!(online.contains("device-2"));

        reg.remove("client-a");
        reg.remove("client-c");
        let online = reg.online_devices();
        assert_eq!(online.len(), 1);
        assert!(online.contains("device-2"));
    }

    #[test]
    fn targeted_and_global_revocation_cancel_presence() {
        let reg = PresenceRegistry::new();
        let a = reg.insert(
            "a".into(),
            Some("device-a".into()),
            Some(uuid::Uuid::new_v4()),
            true,
        );
        let b = reg.insert(
            "b".into(),
            Some("device-b".into()),
            Some(uuid::Uuid::new_v4()),
            true,
        );
        let owner = reg.insert("owner".into(), None, None, false);

        assert_eq!(reg.disconnect_device_principals(Some("device-a")), 1);
        assert!(a.is_cancelled());
        assert!(!b.is_cancelled());
        assert!(!owner.is_cancelled());
        assert_eq!(reg.disconnect_device_principals(None), 1);
        assert!(b.is_cancelled());
        assert!(!owner.is_cancelled());
        assert!(
            reg.has_any(),
            "local owner presence must survive device revoke"
        );
    }

    #[test]
    fn lan_shutdown_cancels_only_direct_remote_presence() {
        let reg = PresenceRegistry::new();
        let direct = reg.insert_with_ingress(
            "direct".into(),
            Some("device-direct".into()),
            Some(uuid::Uuid::new_v4()),
            true,
            TrustedIngress::DirectRemote,
        );
        let relay = reg.insert_with_ingress(
            "relay".into(),
            Some("device-relay".into()),
            Some(uuid::Uuid::new_v4()),
            true,
            TrustedIngress::Relay,
        );
        let local = reg.insert_with_ingress(
            "local".into(),
            None,
            None,
            false,
            TrustedIngress::DirectLoopback,
        );

        assert_eq!(reg.disconnect_ingress(TrustedIngress::DirectRemote), 1);
        assert!(direct.is_cancelled());
        assert!(!relay.is_cancelled());
        assert!(!local.is_cancelled());
    }

    #[test]
    fn generation_cleanup_spares_newly_repaired_presence() {
        let reg = PresenceRegistry::new();
        let old_generation = uuid::Uuid::new_v4();
        let new_generation = uuid::Uuid::new_v4();
        let old = reg.insert(
            "old".into(),
            Some("device-a".into()),
            Some(old_generation),
            true,
        );
        let new = reg.insert(
            "new".into(),
            Some("device-a".into()),
            Some(new_generation),
            true,
        );

        assert_eq!(
            reg.disconnect_device_generation("device-a", old_generation),
            1
        );
        assert!(old.is_cancelled());
        assert!(!new.is_cancelled());
    }

    #[test]
    fn owner_generation_cleanup_spares_new_owner_and_devices() {
        let reg = PresenceRegistry::new();
        let old_generation = uuid::Uuid::new_v4();
        let new_generation = uuid::Uuid::new_v4();
        let old = reg.insert("old-owner".into(), None, Some(old_generation), false);
        let new = reg.insert("new-owner".into(), None, Some(new_generation), false);
        let device = reg.insert(
            "device".into(),
            Some("device-a".into()),
            Some(old_generation),
            true,
        );

        assert_eq!(reg.disconnect_owner_generation(old_generation), 1);
        assert!(old.is_cancelled());
        assert!(!new.is_cancelled());
        assert!(!device.is_cancelled());
    }

    /// DesktopEvent 的 serde 序列化标签形状,确保与手机端约定的 `t` 字段一致。
    #[test]
    fn desktop_event_serializes_with_tag() {
        let notify = DesktopEvent::Notify {
            id: "id-1".to_string(),
            session_id: "sess-1".to_string(),
            session_title: "会话A".to_string(),
            title: "T".to_string(),
            body: "B".to_string(),
        };
        let json = serde_json::to_value(&notify).unwrap();
        assert_eq!(json["t"], "notify");
        assert_eq!(json["id"], "id-1");
        assert_eq!(json["session_id"], "sess-1");
        assert_eq!(json["session_title"], "会话A");

        let sessions = DesktopEvent::SessionsChanged;
        let json = serde_json::to_value(&sessions).unwrap();
        assert_eq!(json["t"], "sessions");

        let cmd_done = DesktopEvent::CmdDone {
            id: "id-2".to_string(),
            session_id: "sess-2".to_string(),
            session_title: "会话B".to_string(),
            cmd: "make build".to_string(),
            exit: 0,
            duration_ms: 30_000,
        };
        let json = serde_json::to_value(&cmd_done).unwrap();
        assert_eq!(json["t"], "cmd_done");
        assert_eq!(json["id"], "id-2");
        assert_eq!(json["session_id"], "sess-2");
        assert_eq!(json["session_title"], "会话B");
        assert_eq!(json["cmd"], "make build");
        assert_eq!(json["exit"], 0);
        assert_eq!(json["duration_ms"], 30_000);

        let turn_done = DesktopEvent::AgentTurnDone {
            id: "id-3".to_string(),
            session_id: "sess-3".to_string(),
            session_title: "会话C".to_string(),
        };
        let json = serde_json::to_value(&turn_done).unwrap();
        assert_eq!(json["t"], "agent_turn_done");
        assert_eq!(json["id"], "id-3");
        assert_eq!(json["session_id"], "sess-3");
        assert_eq!(json["session_title"], "会话C");

        let needs_approval = DesktopEvent::AgentNeedsApproval {
            id: "id-4".to_string(),
            session_id: "sess-4".to_string(),
            session_title: "会话D".to_string(),
            title: "`ls -la`".to_string(),
        };
        let json = serde_json::to_value(&needs_approval).unwrap();
        assert_eq!(json["t"], "agent_needs_approval");
        assert_eq!(json["id"], "id-4");
        assert_eq!(json["session_id"], "sess-4");
        assert_eq!(json["session_title"], "会话D");
        assert_eq!(json["title"], "`ls -la`");
    }
}
