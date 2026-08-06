//! Session manager — mirrors Go `session/manager.go`.
//!
//! Maintains the set of active sessions and runs a periodic reaper
//! that cleans up expired clients and sessions.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio_util::sync::CancellationToken;

use super::client::ClientInfo;
use super::state::SessionState;
use super::{access::SessionCreator, Session, SessionConfig};
use crate::server::auth::{AuthPrincipal, TrustedIngress};
use crate::server::events::EventBus;
use crate::server::hook_secret::HookSecretRegistry;

/// Aggregated device info (grouped by IP).
#[derive(Debug, Clone, serde::Serialize)]
pub struct DeviceInfo {
    pub ip: String,
    pub name: String,
    pub sessions: Vec<ClientInfo>,
    pub count: usize,
}

/// Manages all active sessions and runs the reaper.
pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    config: SessionConfig,
    cancel: CancellationToken,
    /// 桌面级事件总线(终端通知 Phase 1):创建每个 `Session` 时把 clone 注入进去,
    /// 使 run loop 能把通知性 OscEvent 额外投递到这里。
    event_bus: EventBus,
    /// hook secret 注册表(agent 终端镜像 M1):会话被 `reap`(TTL/exit/idle)回收时,在此
    /// 一并清除该会话的 hook secret,修 M1「只在创建时登记、销毁时不清」导致的内存慢泄漏。
    /// Clone 共享同一份 `Arc<Mutex<..>>`(仿 `event_bus` 注入模式),与 `ServerState.hook_secrets` 同源。
    hook_secrets: HookSecretRegistry,
}

/// An SSH session that has all of its immutable authorization metadata but is
/// not yet visible in the manager registry.  Terminal wiring contains async
/// cancellation points; keeping the session private until `commit` means a
/// cancelled HTTP/Tauri request can never leave a discoverable ghost tab.
pub(crate) struct PendingSession {
    manager: Arc<SessionManager>,
    session: Arc<Session>,
    committed: bool,
}

impl PendingSession {
    pub(crate) fn session(&self) -> Arc<Session> {
        self.session.clone()
    }

    pub(crate) fn commit(mut self) -> Arc<Session> {
        self.manager
            .sessions
            .lock()
            .unwrap()
            .insert(self.session.id.clone(), self.session.clone());
        self.committed = true;
        self.session.clone()
    }
}

impl Drop for PendingSession {
    fn drop(&mut self) {
        if !self.committed {
            self.session.cancel();
        }
    }
}

impl SessionManager {
    pub fn new(
        config: SessionConfig,
        event_bus: EventBus,
        hook_secrets: HookSecretRegistry,
    ) -> Arc<Self> {
        let mgr = Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            config,
            cancel: CancellationToken::new(),
            event_bus,
            hook_secrets,
        });

        // Start the reaper task
        let mgr_weak = Arc::downgrade(&mgr);
        let cancel = mgr.cancel.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(10));
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = interval.tick() => {
                        if let Some(mgr) = mgr_weak.upgrade() {
                            mgr.reap();
                        } else {
                            break;
                        }
                    }
                }
            }
        });

        mgr
    }

    /// Create a new session. Returns the session ID.
    pub fn create(&self) -> Arc<Session> {
        self.create_with_creator(None, "local-shell", None)
    }

    /// Create an SSH session bound to the authenticated principal that
    /// requested it. Both type and binding are installed before the session
    /// enters the registry, so authorization never observes a partial record.
    #[cfg(test)]
    pub(crate) fn create_for_principal(&self, principal: &AuthPrincipal) -> Arc<Session> {
        self.create_with_creator(Some(SessionCreator::from(principal)), "ssh", None)
    }

    /// Prepare an already-connected SSH terminal's metadata without publishing
    /// it. The caller wires the terminal and then commits the returned guard.
    pub(crate) fn prepare_connected_ssh_for_principal(
        self: &Arc<Self>,
        principal: &AuthPrincipal,
        config: crate::server::terminal::ssh::SshConfig,
    ) -> PendingSession {
        PendingSession {
            manager: self.clone(),
            session: self.build_with_creator(
                Some(SessionCreator::from(principal)),
                "ssh",
                Some(config),
            ),
            committed: false,
        }
    }

    /// Local-owner counterpart used by the Tauri SSH command.
    pub(crate) fn prepare_connected_ssh(
        self: &Arc<Self>,
        config: crate::server::terminal::ssh::SshConfig,
    ) -> PendingSession {
        PendingSession {
            manager: self.clone(),
            session: self.build_with_creator(None, "ssh", Some(config)),
            committed: false,
        }
    }

    fn create_with_creator(
        &self,
        creator: Option<SessionCreator>,
        executor_type: &str,
        ssh_config: Option<crate::server::terminal::ssh::SshConfig>,
    ) -> Arc<Session> {
        let session = self.build_with_creator(creator, executor_type, ssh_config);
        self.sessions
            .lock()
            .unwrap()
            .insert(session.id.clone(), session.clone());
        session
    }

    fn build_with_creator(
        &self,
        creator: Option<SessionCreator>,
        executor_type: &str,
        ssh_config: Option<crate::server::terminal::ssh::SshConfig>,
    ) -> Arc<Session> {
        let id = uuid::Uuid::new_v4().to_string();
        let session = Arc::new(Session::new_with_creator(
            id.clone(),
            self.config.clone(),
            self.event_bus.clone(),
            creator,
        ));
        *session.executor_type.lock().unwrap() = executor_type.to_string();
        *session.ssh_config.lock().unwrap() = ssh_config;
        session
    }

    /// Get a session by ID.
    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }

    /// List all sessions.
    pub fn list(&self) -> Vec<Arc<Session>> {
        self.sessions.lock().unwrap().values().cloned().collect()
    }

    /// Delete a session by ID.
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "session not found".to_string())?;
        // Mark Closed and disconnect first. A WebSocket that already retained
        // this Arc can no longer dispatch during the map-removal window.
        session.close_with_frame(crate::server::protocol::encode_session_end_deleted());
        let mut sessions = self.sessions.lock().unwrap();
        let removed = if sessions
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, &session))
        {
            sessions.remove(id).is_some()
        } else {
            false
        };
        drop(sessions);
        if removed {
            self.hook_secrets.remove(id);
        }
        Ok(())
    }

    /// Roll back a local PTY record whose executor never started. Local shells
    /// are registered before PTY startup so their early shell hook can resolve
    /// the session; every startup failure must use this path to remove that
    /// temporary visibility and its hook credential together.
    pub(crate) fn discard_unstarted(&self, id: &str) -> bool {
        let Some(session) = self.sessions.lock().unwrap().get(id).cloned() else {
            // Preserve the old orphan-secret cleanup behavior even if startup
            // already removed the registry entry.
            self.hook_secrets.remove(id);
            return false;
        };
        // The session is briefly visible before PTY startup finishes, so a
        // mobile client may already retain this Arc. Close it before removal;
        // cancellation alone would leave that client able to dispatch.
        session.close_with_frame(crate::server::protocol::encode_session_end_deleted());
        let mut sessions = self.sessions.lock().unwrap();
        let removed = if sessions
            .get(id)
            .is_some_and(|current| Arc::ptr_eq(current, &session))
        {
            sessions.remove(id).is_some()
        } else {
            false
        };
        drop(sessions);
        if removed {
            self.hook_secrets.remove(id);
        }
        removed
    }

    /// List all clients across all sessions.
    /// List all remote clients across all sessions (excludes local IPC clients).
    pub fn list_all_clients(&self) -> Vec<ClientInfo> {
        let sessions = self.sessions.lock().unwrap();
        let mut all = Vec::new();
        for session in sessions.values() {
            all.extend(
                session
                    .list_clients()
                    .into_iter()
                    .filter(|c| c.device_id.is_some() || c.ingress != "direct_loopback"),
            );
        }
        all
    }

    /// List devices grouped by IP (excluding loopback).
    pub fn list_devices(&self) -> Vec<DeviceInfo> {
        let all_clients = self.list_all_clients();
        let mut by_ip: HashMap<String, Vec<ClientInfo>> = HashMap::new();
        for client in all_clients {
            let ip = client.remote_addr.clone();
            if ip.is_empty() {
                continue;
            }
            by_ip.entry(ip).or_default().push(client);
        }
        by_ip
            .into_iter()
            .map(|(ip, sessions)| DeviceInfo {
                count: sessions.len(),
                name: ip.clone(),
                ip,
                sessions,
            })
            .collect()
    }

    /// Kick all clients from a specific IP across all sessions.
    pub fn kick_by_ip(&self, ip: &str) -> usize {
        let sessions = self.sessions.lock().unwrap();
        let mut total = 0;
        for session in sessions.values() {
            total += session.kick_by_ip(ip);
        }
        total
    }

    /// Disconnect all remote (non-loopback) clients across all sessions.
    /// Sends ERR_KICKED and promotes next master if the master was kicked.
    pub fn disconnect_all_clients(&self) -> usize {
        self.disconnect_device_principals(None)
    }

    /// Immediately disconnect all authenticated device/relay WebSockets, or
    /// just one stable device ID after a targeted credential revocation.
    pub(crate) fn disconnect_device_principals(&self, device_id: Option<&str>) -> usize {
        let sessions = self.sessions.lock().unwrap();
        let mut total = 0;
        for session in sessions.values() {
            total += session.disconnect_device_principals(device_id);
        }
        total
    }

    pub(crate) fn disconnect_device_generation(
        &self,
        device_id: &str,
        generation: uuid::Uuid,
    ) -> usize {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .map(|session| session.disconnect_device_generation(device_id, generation))
            .sum()
    }

    pub(crate) fn disconnect_owner_generation(&self, generation: uuid::Uuid) -> usize {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .map(|session| session.disconnect_owner_generation(generation))
            .sum()
    }

    /// Disconnect only clients accepted through one trusted transport class.
    /// LAN shutdown uses this to preserve relay and local IPC sessions.
    pub(crate) fn disconnect_ingress(&self, ingress: TrustedIngress) -> usize {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .map(|session| session.disconnect_ingress(ingress))
            .sum()
    }

    /// Stop the manager and close all sessions.
    pub fn stop(&self) {
        self.cancel.cancel();
        let sessions: Vec<Arc<Session>> = self
            .sessions
            .lock()
            .unwrap()
            .drain()
            .map(|(_, s)| s)
            .collect();
        for session in sessions {
            session.close_with_frame(crate::server::protocol::encode_session_end());
        }
    }

    /// Periodic reaper — expire disconnected clients and close timed-out sessions.
    fn reap(&self) {
        let now = Instant::now();
        let grace = self.config.reconnect_grace;

        let session_list: Vec<Arc<Session>> =
            self.sessions.lock().unwrap().values().cloned().collect();

        let mut to_remove: Vec<(String, Arc<Session>)> = Vec::new();

        for session in &session_list {
            // 断开心跳停跳(>90s 无任何消息)的 IPC 僵尸客户端,
            // 之后走常规 disconnected→grace→expire 流程
            session.disconnect_stale_ipc_clients(std::time::Duration::from_secs(90));

            // Expire disconnected clients past grace period
            let expired = session.expired_disconnected_clients(now, grace);
            for (client_id, conn_gen) in expired {
                session.expire_client_for_generation(&client_id, conn_gen, grace);
            }

            // Check if session should be closed by TTL.
            // FIX-L1:agent 会话「随子进程存活」——手机全断开使其 Draining 也豁免 client-TTL
            // 回收(否则手机后台 5min 后 agent CLI 被半路杀掉,削弱异步通知/长任务卖点)。
            // 其回收改由子进程死亡 / idle-guard / 显式 delete 三路兜住(agent::manager::finalize)。
            // 终端会话逻辑完全不变;Closed(含显式 delete 后)仍照常清(见下)。
            let ttl_claimed = !session.is_agent() && session.try_close_by_ttl(now);

            // Also remove sessions closed by terminal EOF or explicit shutdown.
            if ttl_claimed || *session.state.lock().unwrap() == SessionState::Closed {
                to_remove.push((session.id.clone(), session.clone()));
            }
        }

        if !to_remove.is_empty() {
            let mut sessions = self.sessions.lock().unwrap();
            for (id, expected) in to_remove {
                let removed = if sessions
                    .get(&id)
                    .is_some_and(|current| Arc::ptr_eq(current, &expected))
                {
                    sessions.remove(&id).is_some()
                } else {
                    false
                };
                if removed {
                    // 修 M1 泄漏:会话被回收时一并清除其 hook secret(secret 绑 PTY 会话生命周期;
                    // 镜像 finalize 不清 secret,同一 PTY 可再跑 claude,secret 只在会话真正消失时清)。
                    self.hook_secrets.remove(&id);
                }
            }
        }
    }

    /// Get session config.
    pub fn config(&self) -> &SessionConfig {
        &self.config
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_ssh_config() -> crate::server::terminal::ssh::SshConfig {
        crate::server::terminal::ssh::SshConfig {
            host: "example.invalid".to_string(),
            port: 22,
            username: "tester".to_string(),
            auth_method: crate::server::terminal::ssh::SshAuthMethod::Password,
            password: "test-only".to_string(),
            private_key: String::new(),
            passphrase: String::new(),
            trusted_fingerprint: String::new(),
            disable_hook: true,
            multiplex_sftp: false,
            proxy_type: String::new(),
            proxy_host: String::new(),
            proxy_port: 0,
            proxy_username: String::new(),
            proxy_password: String::new(),
        }
    }

    /// 测试用小 session_ttl(1s):配合 `make_draining_over_ttl` 的小 offset(2s),
    /// 令「drain_start 超 TTL」只需回拨 2s——避免旧版回拨 400s 在低 uptime 主机上 panic
    /// (见 `make_draining_over_ttl`)。TTL 大小不影响 agent 会话的豁免语义(FIX-L1 按
    /// `is_agent()` 豁免,与 TTL 无关),只决定终端会话是否被判超时回收。
    fn test_config() -> SessionConfig {
        SessionConfig {
            session_ttl: Duration::from_secs(1),
            reconnect_grace: Duration::from_secs(60),
            ring_buffer_size: 1024,
            log_dir: String::new(),
        }
    }

    /// 把会话置成「Draining 且 drain_start 超 session_ttl」的可回收态。
    ///
    /// drain_start 回拨 2s(> test_config 的 1s TTL,必被判超时),而非旧版的 400s——
    /// 旧版在 uptime < 400s 的新开机主机(缓存构建的 CI)上 `checked_sub` 返回 None →
    /// `unwrap` panic → 假失败。2s offset 远小于任何现实 uptime(编译+测试启动已远超 2s);
    /// 再以 `unwrap_or_else(Instant::now)` 兜底,彻底杜绝 panic。
    fn make_draining_over_ttl(session: &Session) {
        *session.state.lock().unwrap() = SessionState::Draining;
        let drained_at = Instant::now()
            .checked_sub(Duration::from_secs(2))
            .unwrap_or_else(Instant::now);
        *session.drain_start.lock().unwrap() = Some(drained_at);
    }

    /// FIX-L1:同为「Draining 且超 client-TTL」时,agent 会话被 reaper **豁免**(不回收),
    /// 终端会话仍被回收。锁定豁免只针对 executor_type=="agent",终端生命周期不变。
    #[tokio::test]
    async fn reaper_exempts_agent_session_from_client_ttl_but_reaps_terminal() {
        let mgr = SessionManager::new(test_config(), EventBus::new(), HookSecretRegistry::new());

        // agent 会话:Draining 且 drain_start 远超 TTL。
        let agent = mgr.create();
        *agent.executor_type.lock().unwrap() = "agent".to_string();
        make_draining_over_ttl(&agent);
        let agent_id = agent.id.clone();

        // 终端会话(默认 executor_type=local-shell):同样条件。
        let term = mgr.create();
        make_draining_over_ttl(&term);
        let term_id = term.id.clone();

        mgr.reap();

        assert!(
            mgr.get(&agent_id).is_some(),
            "agent 会话应豁免 client-TTL 回收(随子进程存活)"
        );
        assert!(
            mgr.get(&term_id).is_none(),
            "终端会话超 client-TTL 应照常被 reap"
        );
    }

    /// FIX-L1 补充:处于 Closed 的 agent 会话仍被 reaper 清除(豁免只针对 client-TTL 的
    /// Draining 回收,不豁免 Closed / 显式 delete)。
    #[tokio::test]
    async fn reaper_still_removes_closed_agent_session() {
        let mgr = SessionManager::new(test_config(), EventBus::new(), HookSecretRegistry::new());
        let agent = mgr.create();
        *agent.executor_type.lock().unwrap() = "agent".to_string();
        *agent.state.lock().unwrap() = SessionState::Closed;
        let agent_id = agent.id.clone();

        mgr.reap();

        assert!(
            mgr.get(&agent_id).is_none(),
            "Closed 的 agent 会话不豁免,应被 reaper 清除"
        );
    }

    /// 修 M1 泄漏(§M5-5):会话被 `reap` 回收(TTL/exit/idle)时,其 hook secret 也一并从
    /// 注册表清除——否则 M1 只在创建时登记、销毁时不清,注册表随会话增删无界慢泄漏。
    #[tokio::test]
    async fn reaper_clears_hook_secret_for_reaped_session() {
        let hook_secrets = HookSecretRegistry::new();
        let mgr = SessionManager::new(test_config(), EventBus::new(), hook_secrets.clone());

        // 终端会话:模拟 M1 在会话创建时随机生成并登记 hook secret。
        let term = mgr.create();
        let term_id = term.id.clone();
        hook_secrets.register(term_id.clone(), "s3cr3t".to_string());
        assert!(
            hook_secrets.verify(&term_id, "s3cr3t"),
            "前置:secret 已登记"
        );

        // 令其 Draining 且超 client-TTL → 本轮 reap 回收。
        make_draining_over_ttl(&term);
        mgr.reap();

        assert!(
            mgr.get(&term_id).is_none(),
            "终端会话超 client-TTL 应被 reap"
        );
        assert!(
            !hook_secrets.verify(&term_id, "s3cr3t"),
            "reap 回收会话后应清除其 hook secret(修 M1 泄漏)"
        );
    }

    #[tokio::test]
    async fn discard_unstarted_removes_session_secret_and_cancels_it() {
        use super::super::client::{Client, ClientSecurityContext};
        use super::super::state::ClientRole;

        let hook_secrets = HookSecretRegistry::new();
        let mgr = SessionManager::new(test_config(), EventBus::new(), hook_secrets.clone());
        let session = mgr.create();
        let id = session.id.clone();
        let cancelled = session.cancellation_token();
        let security = ClientSecurityContext::direct_loopback_owner();
        let (client, mut receivers) = Client::new(
            "startup-client".to_string(),
            "127.0.0.1".to_string(),
            ClientRole::Viewer,
            security.clone(),
        );
        let client = Arc::new(client);
        let conn_gen = client.conn_gen();
        session.add_client(client.clone()).unwrap();
        hook_secrets.register(id.clone(), "startup-only".to_string());

        assert!(mgr.discard_unstarted(&id));
        assert!(mgr.get(&id).is_none());
        assert!(!hook_secrets.verify(&id, "startup-only"));
        assert!(cancelled.is_cancelled());
        assert!(session.is_closed());
        assert!(!client.is_connected());
        assert_eq!(
            receivers.priority_rx.try_recv().unwrap(),
            crate::server::protocol::encode_session_end_deleted()
        );
        assert!(session
            .current_client_connection("startup-client", conn_gen)
            .is_none());
        let (late, _late_receivers) = Client::new(
            "late".to_string(),
            "127.0.0.1".to_string(),
            ClientRole::Viewer,
            security.clone(),
        );
        assert_eq!(
            session.add_client(Arc::new(late)).unwrap_err(),
            "session is closed"
        );
        assert_eq!(
            session
                .reconnect_client(
                    "startup-client",
                    "127.0.0.1".to_string(),
                    security,
                    Duration::from_secs(60),
                )
                .err()
                .unwrap(),
            "session is closed"
        );
        assert!(!mgr.discard_unstarted(&id));
    }

    #[tokio::test]
    async fn pending_ssh_session_is_invisible_until_commit() {
        let mgr = SessionManager::new(test_config(), EventBus::new(), HookSecretRegistry::new());
        let pending = mgr.prepare_connected_ssh(test_ssh_config());
        let id = pending.session().id.clone();

        assert!(mgr.get(&id).is_none());
        assert!(mgr.list().is_empty());

        let committed = pending.commit();
        assert!(Arc::ptr_eq(&committed, &mgr.get(&id).unwrap()));
    }

    #[tokio::test]
    async fn dropping_pending_ssh_session_never_registers_it() {
        let mgr = SessionManager::new(test_config(), EventBus::new(), HookSecretRegistry::new());
        let pending = mgr.prepare_connected_ssh(test_ssh_config());
        let id = pending.session().id.clone();

        drop(pending);

        assert!(mgr.get(&id).is_none());
        assert!(mgr.list().is_empty());
    }
}
