//! 终端通知 Phase 3:手机推送注册表 —— 记录每台手机(`device_id`)的 APNs token
//! + 通知加密公钥(`notif_pub`,见 `push_crypto`),供后续任务(后台加密推送)按
//! `device_id` 查出对应的 APNs 凭据 + 加密目标。
//!
//! 当前仅做内存注册表(进程重启即丢失)——手机每次前台/建连时重新 register 即可,
//! 与 `PresenceRegistry` 的定位一致,不做持久化。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// 单台手机的推送注册信息。
#[derive(Clone, PartialEq, Eq)]
pub struct PushRegistration {
    /// APNs device token(手机从 `didRegisterForRemoteNotificationsWithDeviceToken` 拿到,
    /// 转成 hex 字符串上报)。
    pub apns_token: String,
    /// 手机静态 X25519 公钥(32 字节),`push_crypto::seal` 的接收方。
    pub notif_pub: [u8; 32],
    /// APNs 环境:`"sandbox"`(Xcode/Debug 开发包)或 `"production"`
    /// (TestFlight/App Store Release 包)。
    /// 两者证书/网关不同,推送时必须按此字段选择对应的 APNs 端点。
    pub env: String,
    /// Runtime-only generation of the Device credential that registered this
    /// target. Internal legacy entries use `None`.
    pub credential_generation: Option<uuid::Uuid>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PushRegistrationOutcome {
    Registered,
    CredentialRevoked,
    NotificationKeyMismatch,
}

impl std::fmt::Debug for PushRegistration {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PushRegistration(redacted)")
    }
}

/// 手机推送注册表 —— `device_id -> PushRegistration` 的线程安全映射。
///
/// `Clone` 共享内部 `Arc<Mutex<..>>`,与 `PresenceRegistry`/`EventBus` 同一模式,
/// 多处持有的克隆体操作同一份数据。
#[derive(Clone)]
pub struct PushRegistry {
    inner: Arc<Mutex<HashMap<String, PushRegistration>>>,
}

impl PushRegistry {
    /// 新建空注册表。
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 登记/更新一台手机的推送信息(同一 `device_id` 重复调用即覆盖旧值)。
    pub fn register(
        &self,
        device_id: String,
        apns_token: String,
        notif_pub: [u8; 32],
        env: String,
    ) {
        self.register_for_generation(device_id, apns_token, notif_pub, env, None);
    }

    pub(crate) fn register_for_generation(
        &self,
        device_id: String,
        apns_token: String,
        notif_pub: [u8; 32],
        env: String,
        credential_generation: Option<uuid::Uuid>,
    ) {
        self.inner.lock().unwrap().insert(
            device_id,
            PushRegistration {
                apns_token,
                notif_pub,
                env,
                credential_generation,
            },
        );
    }

    pub(crate) fn register_if_current_generation(
        &self,
        authenticator: &super::auth::Authenticator,
        device_id: &str,
        apns_token: &str,
        notif_pub: [u8; 32],
        env: &str,
        generation: uuid::Uuid,
    ) -> PushRegistrationOutcome {
        authenticator
            .with_current_device_generation(device_id, generation, || {
                let mut entries = self.inner.lock().unwrap();
                if entries.get(device_id).is_some_and(|registration| {
                    registration.credential_generation == Some(generation)
                        && registration.notif_pub != notif_pub
                }) {
                    return PushRegistrationOutcome::NotificationKeyMismatch;
                }
                entries.insert(
                    device_id.to_string(),
                    PushRegistration {
                        apns_token: apns_token.to_string(),
                        notif_pub,
                        env: env.to_string(),
                        credential_generation: Some(generation),
                    },
                );
                PushRegistrationOutcome::Registered
            })
            .unwrap_or(PushRegistrationOutcome::CredentialRevoked)
    }

    /// 查询某台手机的推送注册信息(不存在则 `None`)。
    pub fn get(&self, device_id: &str) -> Option<PushRegistration> {
        self.inner.lock().unwrap().get(device_id).cloned()
    }

    /// 导出当前所有已注册的手机(推送 fan-out 场景用:遍历所有在线设备逐个推送)。
    pub fn all(&self) -> Vec<(String, PushRegistration)> {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// Snapshot only registrations whose exact device credential generation
    /// is still current. Legacy generation-less entries are never eligible for
    /// dispatch because they cannot be tied to an authenticated device.
    pub(crate) fn all_current(
        &self,
        authenticator: &super::auth::Authenticator,
    ) -> Vec<(String, PushRegistration)> {
        self.all()
            .into_iter()
            .filter(|(device_id, registration)| {
                registration
                    .credential_generation
                    .is_some_and(|generation| {
                        authenticator.is_device_generation_current(device_id, generation)
                    })
            })
            .collect()
    }

    pub(crate) fn remove(&self, device_id: &str) -> bool {
        self.inner.lock().unwrap().remove(device_id).is_some()
    }

    pub(crate) fn remove_generation(&self, device_id: &str, generation: uuid::Uuid) -> bool {
        let mut entries = self.inner.lock().unwrap();
        if entries
            .get(device_id)
            .and_then(|entry| entry.credential_generation)
            != Some(generation)
        {
            return false;
        }
        entries.remove(device_id).is_some()
    }

    pub(crate) fn clear(&self) -> usize {
        let mut entries = self.inner.lock().unwrap();
        let count = entries.len();
        entries.clear();
        count
    }
}

impl Default for PushRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_pub(fill: u8) -> [u8; 32] {
        [fill; 32]
    }

    #[test]
    fn register_then_get_roundtrips() {
        let reg = PushRegistry::new();
        assert_eq!(reg.get("device-a"), None, "未注册应返回 None");

        reg.register(
            "device-a".to_string(),
            "apns-token-abc".to_string(),
            sample_pub(1),
            "sandbox".to_string(),
        );

        let got = reg.get("device-a").expect("注册后应能查到");
        assert_eq!(got.apns_token, "apns-token-abc");
        assert_eq!(got.notif_pub, sample_pub(1));
        assert_eq!(got.env, "sandbox");
    }

    #[test]
    fn register_overwrites_existing_entry() {
        let reg = PushRegistry::new();
        reg.register(
            "device-a".to_string(),
            "old-token".to_string(),
            sample_pub(1),
            "sandbox".to_string(),
        );
        reg.register(
            "device-a".to_string(),
            "new-token".to_string(),
            sample_pub(2),
            "production".to_string(),
        );

        let got = reg.get("device-a").unwrap();
        assert_eq!(got.apns_token, "new-token");
        assert_eq!(got.notif_pub, sample_pub(2));
        assert_eq!(got.env, "production");
    }

    #[test]
    fn all_lists_every_registered_device() {
        let reg = PushRegistry::new();
        reg.register(
            "device-a".to_string(),
            "tok-a".to_string(),
            sample_pub(1),
            "sandbox".to_string(),
        );
        reg.register(
            "device-b".to_string(),
            "tok-b".to_string(),
            sample_pub(2),
            "production".to_string(),
        );

        let mut all = reg.all();
        all.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].0, "device-a");
        assert_eq!(all[0].1.apns_token, "tok-a");
        assert_eq!(all[1].0, "device-b");
        assert_eq!(all[1].1.apns_token, "tok-b");
    }

    #[test]
    fn remove_and_clear_revoke_push_destinations() {
        let reg = PushRegistry::new();
        reg.register(
            "device-a".into(),
            "tok-a".into(),
            sample_pub(1),
            "sandbox".into(),
        );
        reg.register(
            "device-b".into(),
            "tok-b".into(),
            sample_pub(2),
            "production".into(),
        );
        assert!(reg.remove("device-a"));
        assert!(!reg.remove("device-a"));
        assert!(reg.get("device-a").is_none());
        assert_eq!(reg.clear(), 1);
        assert!(reg.all().is_empty());
    }

    #[test]
    fn generation_cleanup_spares_newly_repaired_push_target() {
        let reg = PushRegistry::new();
        let old_generation = uuid::Uuid::new_v4();
        let new_generation = uuid::Uuid::new_v4();
        reg.register_for_generation(
            "device-a".into(),
            "new-token".into(),
            sample_pub(3),
            "production".into(),
            Some(new_generation),
        );

        assert!(!reg.remove_generation("device-a", old_generation));
        assert!(reg.get("device-a").is_some());
        assert!(reg.remove_generation("device-a", new_generation));
        assert!(reg.get("device-a").is_none());
    }

    #[test]
    fn current_generation_can_refresh_token_but_cannot_replace_notification_key() {
        let authenticator = super::super::auth::Authenticator::new("O".repeat(32));
        let token = authenticator
            .issue_device_token("device-a", "phone")
            .unwrap();
        let mut request = axum::extract::Request::new(axum::body::Body::empty());
        request.headers_mut().insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        let generation = match authenticator.authenticate_request(&request) {
            Some(super::super::auth::AuthPrincipal::Device { generation, .. }) => generation,
            _ => panic!("issued token must authenticate as device"),
        };
        let reg = PushRegistry::new();

        assert_eq!(
            reg.register_if_current_generation(
                &authenticator,
                "device-a",
                "old-token",
                sample_pub(1),
                "sandbox",
                generation,
            ),
            PushRegistrationOutcome::Registered
        );
        assert_eq!(
            reg.register_if_current_generation(
                &authenticator,
                "device-a",
                "new-token",
                sample_pub(1),
                "production",
                generation,
            ),
            PushRegistrationOutcome::Registered
        );
        assert_eq!(
            reg.register_if_current_generation(
                &authenticator,
                "device-a",
                "attacker-token",
                sample_pub(2),
                "production",
                generation,
            ),
            PushRegistrationOutcome::NotificationKeyMismatch
        );

        let current = reg.get("device-a").unwrap();
        assert_eq!(current.apns_token, "new-token");
        assert_eq!(current.notif_pub, sample_pub(1));
        assert_eq!(current.env, "production");
    }
}
