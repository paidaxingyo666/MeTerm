//! 终端通知 Phase 3:离线手机推送分发器 —— 订阅桌面事件总线(`EventBus`),
//! 对当前"离线"(未连 presence WS `/ws-events`)的每台已注册手机,把事件 seal
//! 成密文后 POST 给中继代发 APNs。
//!
//! 设计要点:
//! - 在线手机走 presence WS 实时收事件(见 `ws::handle_events_ws`),不需要 APNs;
//!   本分发器只服务"手机不在线"的场景(锁屏/后台/无网),故先算 `online` 集合排除。
//! - `session_id`/`title`/`body` 等业务字段全部序列化进 seal 的密文里,中继与 APNs
//!   全程只看到不透明密文(`payload` 字段)——不会泄露会话内容或路由信息。
//! - 单台手机推送失败(网络错误/中继 4xx/5xx)只记日志,不影响其它手机、不中断循环;
//!   日志里绝不打印 URL / token / device_id / 明文 / 密文,只打不可逆短哈希 + 结果。

use std::collections::HashSet;
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::broadcast;

use super::events::DesktopEvent;
use super::push_crypto;
use super::push_registry::PushRegistration;
use super::relay_client;
use super::ServerState;

/// POST 给中继的请求体——字段名是中继契约的一部分,不可随意改名。
#[derive(Serialize)]
struct RelayPushRequest<'a> {
    apns_token: &'a str,
    env: &'a str,
    payload: &'a str,
}

/// 待推送目标:从 `offline_targets` 算出,只携带 POST 中继所需的最小字段。
#[derive(Clone, PartialEq, Eq)]
pub struct PushTarget {
    pub device_id: String,
    pub apns_token: String,
    pub env: String,
    pub notif_pub: [u8; 32],
    pub credential_generation: uuid::Uuid,
}

impl std::fmt::Debug for PushTarget {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PushTarget(redacted)")
    }
}

impl PushTarget {
    fn is_current(&self, authenticator: &super::auth::Authenticator) -> bool {
        authenticator.is_device_generation_current(&self.device_id, self.credential_generation)
    }
}

/// 纯函数:给定"全部已注册手机"+"当前在线 device_id 集合",算出需要推送的目标列表
/// (即注册表里存在、但不在 `online` 集合里的手机)。
///
/// 抽成纯函数是为了不依赖网络/事件总线也能单测——离线判定的核心逻辑在这里,
/// HTTP POST 部分（`run` 里）无法在单测中覆盖，只能靠这个函数 + 编译验证。
fn offline_targets(
    all: &[(String, PushRegistration)],
    online: &HashSet<String>,
) -> Vec<PushTarget> {
    all.iter()
        .filter(|(device_id, _)| !online.contains(device_id))
        .filter_map(|(device_id, reg)| {
            reg.credential_generation
                .map(|credential_generation| PushTarget {
                    device_id: device_id.clone(),
                    apns_token: reg.apns_token.clone(),
                    env: reg.env.clone(),
                    notif_pub: reg.notif_pub,
                    credential_generation,
                })
        })
        .collect()
}

/// 事件是否需要触发离线推送——只有"通知性"事件需要:`Notify`/`CmdDone` 以及 agent 会话的
/// `AgentTurnDone`/`AgentNeedsApproval`(P1-T6)。`SessionsChanged` 这类纯 UI 刷新提示对离线
/// 手机没有意义,忽略。
fn should_push(event: &DesktopEvent) -> bool {
    matches!(
        event,
        DesktopEvent::Notify { .. }
            | DesktopEvent::CmdDone { .. }
            | DesktopEvent::AgentTurnDone { .. }
            | DesktopEvent::AgentNeedsApproval { .. }
    )
}

fn device_log_id(device_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(device_id.as_bytes());
    digest[..6]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// 推送分发器主循环:订阅 `EventBus`,收到通知性事件后对所有离线手机 seal+POST。
///
/// 常驻后台任务,预期与 `ServerState` 同生命周期;`Err(Closed)` 时退出
/// (理论上不会发生,`EventBus` 由 `ServerState` 常驻持有,不会被 drop)。
pub async fn run(state: Arc<ServerState>) {
    let mut rx = state.event_bus.subscribe();
    loop {
        let event = match rx.recv().await {
            Ok(e) => e,
            // 订阅者太慢被 broadcast 丢弃了一部分历史事件——跳过,继续订阅后续事件。
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            // 所有 Sender 都已 drop(理论上不会发生,EventBus 由 ServerState 常驻持有)。
            Err(broadcast::error::RecvError::Closed) => break,
        };

        if !should_push(&event) {
            continue;
        }

        let online = state.presence.online_devices();
        let all = state.push.all_current(&state.authenticator);
        let targets = offline_targets(&all, &online);
        if targets.is_empty() {
            continue;
        }

        // 中继基址/token 未配置(未启用中继)→ 离线手机确实推不到,整体跳过本轮,
        // 不对每个 target 重复报错刷屏。
        let Some(endpoint) = relay_client::push_endpoint_config(&state.config.log_dir) else {
            continue;
        };

        let plaintext = match serde_json::to_vec(&event) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[push-dispatch] failed to serialize event: {}", e);
                continue;
            }
        };

        for target in targets {
            if !target.is_current(&state.authenticator) {
                continue;
            }
            if !super::device_access::can_device_receive_event(
                &state,
                &target.device_id,
                target.credential_generation,
                &event,
            ) {
                continue;
            }
            let payload = push_crypto::seal(&target.notif_pub, state.device_id(), &plaintext);
            // Recheck after sealing, immediately before the irreversible HTTP
            // request. A revoke that races an already-started request cannot be
            // cancelled, but no queued stale target begins a new request.
            if !target.is_current(&state.authenticator) {
                continue;
            }
            if !super::device_access::can_device_receive_event(
                &state,
                &target.device_id,
                target.credential_generation,
                &event,
            ) {
                continue;
            }
            let result = post_push(&endpoint, state.device_id(), &target, &payload).await;
            let device_id = device_log_id(&target.device_id);
            match result {
                Ok(status) if (200..300).contains(&status) => {
                    eprintln!(
                        "[push-dispatch] device={} push ok status={}",
                        device_id, status
                    );
                }
                Ok(status) => {
                    eprintln!(
                        "[push-dispatch] device={} push rejected status={}",
                        device_id, status
                    );
                }
                Err(_) => {
                    // 底层错误统一折叠,日志不携带 relay URL/token/body。
                    eprintln!("[push-dispatch] device={} push failed", device_id);
                }
            }
        }
    }
}

/// 实际发起一次证书指纹固定的中继推送 POST。失败返回折叠后的阶段错误;有响应则
/// 返回状态码(由调用方判断是否 2xx),不在这里 panic 或 unwrap。
async fn post_push(
    endpoint: &relay_client::RelayPushEndpoint,
    desktop_id: &str,
    target: &PushTarget,
    payload: &str,
) -> Result<u16, String> {
    let body = RelayPushRequest {
        apns_token: &target.apns_token,
        env: &target.env,
        payload,
    };
    let body = serde_json::to_vec(&body).map_err(|_| "request".to_string())?;
    relay_client::post_pinned_push(endpoint, desktop_id, &body).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{header, HeaderValue};

    fn sample_reg(fill: u8, env: &str) -> PushRegistration {
        PushRegistration {
            apns_token: format!("token-{}", fill),
            notif_pub: [fill; 32],
            env: env.to_string(),
            credential_generation: Some(uuid::Uuid::from_u128(fill as u128 + 1)),
        }
    }

    fn device_generation(
        authenticator: &super::super::auth::Authenticator,
        token: &str,
    ) -> uuid::Uuid {
        let mut request = Request::new(Body::empty());
        request.headers_mut().insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        let Some(super::super::auth::AuthPrincipal::Device { generation, .. }) =
            authenticator.authenticate_request(&request)
        else {
            panic!("device token should authenticate");
        };
        generation
    }

    /// 空注册表 → 无论 online 是什么,结果都应为空列表。
    #[test]
    fn offline_targets_empty_registry_yields_empty() {
        let all: Vec<(String, PushRegistration)> = Vec::new();
        let online: HashSet<String> = ["device-1".to_string()].into_iter().collect();
        assert!(offline_targets(&all, &online).is_empty());

        let online_empty: HashSet<String> = HashSet::new();
        assert!(offline_targets(&all, &online_empty).is_empty());
    }

    /// 在线的手机应被排除;离线的手机应入选,且字段原样带出。
    #[test]
    fn offline_targets_excludes_online_includes_offline() {
        let all = vec![
            ("device-online".to_string(), sample_reg(1, "sandbox")),
            ("device-offline".to_string(), sample_reg(2, "production")),
        ];
        let online: HashSet<String> = ["device-online".to_string()].into_iter().collect();

        let targets = offline_targets(&all, &online);
        assert_eq!(targets.len(), 1, "只有离线的那台手机应入选");
        assert_eq!(targets[0].device_id, "device-offline");
        assert_eq!(targets[0].apns_token, "token-2");
        assert_eq!(targets[0].env, "production");
        assert_eq!(targets[0].notif_pub, [2u8; 32]);
        assert_eq!(
            targets[0].credential_generation,
            sample_reg(2, "production").credential_generation.unwrap()
        );
    }

    /// 全部在线 → 结果为空(没有需要离线推送的目标)。
    #[test]
    fn offline_targets_all_online_yields_empty() {
        let all = vec![
            ("device-a".to_string(), sample_reg(1, "sandbox")),
            ("device-b".to_string(), sample_reg(2, "sandbox")),
        ];
        let online: HashSet<String> = ["device-a".to_string(), "device-b".to_string()]
            .into_iter()
            .collect();
        assert!(offline_targets(&all, &online).is_empty());
    }

    /// 全部离线(online 为空集合)→ 全部入选。
    #[test]
    fn offline_targets_none_online_includes_all() {
        let all = vec![
            ("device-a".to_string(), sample_reg(1, "sandbox")),
            ("device-b".to_string(), sample_reg(2, "production")),
        ];
        let online: HashSet<String> = HashSet::new();
        let targets = offline_targets(&all, &online);
        assert_eq!(targets.len(), 2);
    }

    #[test]
    fn target_generation_recheck_rejects_rotated_credential() {
        let authenticator = super::super::auth::Authenticator::new("O".repeat(32));
        let old_token = authenticator
            .issue_device_token("device-a", "phone")
            .unwrap();
        let target = PushTarget {
            device_id: "device-a".into(),
            apns_token: "token-a".into(),
            env: "sandbox".into(),
            notif_pub: [7; 32],
            credential_generation: device_generation(&authenticator, &old_token),
        };
        assert!(target.is_current(&authenticator));

        authenticator
            .issue_device_token("device-a", "phone repaired")
            .unwrap();
        assert!(!target.is_current(&authenticator));
    }

    #[test]
    fn generationless_registration_never_becomes_dispatch_target() {
        let mut registration = sample_reg(1, "sandbox");
        registration.credential_generation = None;
        let targets = offline_targets(
            &[("legacy-device".to_string(), registration)],
            &HashSet::new(),
        );
        assert!(targets.is_empty());
    }

    /// should_push:只有通知性事件(Notify/CmdDone/AgentTurnDone/AgentNeedsApproval)返回 true,
    /// SessionsChanged 返回 false。
    #[test]
    fn should_push_for_notify_cmd_done_and_agent_events() {
        assert!(should_push(&DesktopEvent::Notify {
            id: "1".to_string(),
            session_id: "s1".to_string(),
            session_title: "会话1".to_string(),
            title: "t".to_string(),
            body: "b".to_string(),
        }));
        assert!(should_push(&DesktopEvent::CmdDone {
            id: "2".to_string(),
            session_id: "s1".to_string(),
            session_title: "会话1".to_string(),
            cmd: "make".to_string(),
            exit: 0,
            duration_ms: 1000,
        }));
        assert!(should_push(&DesktopEvent::AgentTurnDone {
            id: "3".to_string(),
            session_id: "s1".to_string(),
            session_title: "会话1".to_string(),
        }));
        assert!(should_push(&DesktopEvent::AgentNeedsApproval {
            id: "4".to_string(),
            session_id: "s1".to_string(),
            session_title: "会话1".to_string(),
            title: "`ls -la`".to_string(),
        }));
        assert!(!should_push(&DesktopEvent::SessionsChanged));
    }

    #[test]
    fn device_log_id_is_stable_without_exposing_raw_prefix() {
        let raw = "phone-sensitive-device-identifier";
        let id = device_log_id(raw);
        assert_eq!(id.len(), 12);
        assert_eq!(id, device_log_id(raw));
        assert!(!raw.contains(&id));
        assert!(!id.contains(&raw[..8]));
    }
}
