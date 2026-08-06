//! agent 终端镜像地基(方案甲 M1):hook secret 注册表 —— `session_id -> secret`。
//!
//! 每个 local-shell 会话创建时生成一个随机 secret,连同 `session_id`/`port` 一起
//! 注入 PTY 环境变量(`METERM_SESSION_ID`/`METERM_HOOK_PORT`/`METERM_HOOK_SECRET`),
//! 并在此登记。后续(M3)的 hook 回报端点凭 `session_id` 取出登记的 secret,用**常量
//! 时间比较**校验来路,防止本机其它进程伪造回报。
//!
//! 仅内存注册表(进程重启即丢),与 `PushRegistry`/`PresenceRegistry` 同一定位:
//! 会话本就随进程存活,secret 无需持久化。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::auth::constant_time_eq;

/// hook secret 注册表 —— `session_id -> secret` 的线程安全映射。
///
/// `Clone` 共享内部 `Arc<Mutex<..>>`(同 `PushRegistry` 模式),多处克隆体操作同一份数据。
#[derive(Clone)]
pub struct HookSecretRegistry {
    inner: Arc<Mutex<HashMap<String, String>>>,
}

impl HookSecretRegistry {
    /// 新建空注册表。
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 登记/更新某会话的 hook secret(同一 `session_id` 重复调用即覆盖旧值)。
    pub fn register(&self, session_id: String, secret: String) {
        self.inner.lock().unwrap().insert(session_id, secret);
    }

    /// 清除某会话的 hook secret(会话销毁时调用;不存在即 no-op)。
    pub fn remove(&self, session_id: &str) {
        self.inner.lock().unwrap().remove(session_id);
    }

    /// 常量时间比较,校验某会话回报是否携带正确 secret。
    /// 会话未登记或 secret 不匹配均返回 `false`。
    pub fn verify(&self, session_id: &str, secret: &str) -> bool {
        match self.inner.lock().unwrap().get(session_id) {
            Some(expected) => constant_time_eq(expected.as_bytes(), secret.as_bytes()),
            None => false,
        }
    }
}

impl Default for HookSecretRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// 组装注入 local-shell PTY 的 3 个 hook 环境变量(创建点用)。
///
/// 抽成独立函数便于单测键名 / 取值,并保证 `handlers.rs` 与 `commands/session.rs`
/// 两个创建点组装完全一致。键名必须与 M2/M3 的 shell 函数 + hook 端点约定保持一致。
pub fn hook_envs(session_id: &str, port: u16, secret: &str) -> Vec<(String, String)> {
    vec![
        ("METERM_SESSION_ID".to_string(), session_id.to_string()),
        ("METERM_HOOK_PORT".to_string(), port.to_string()),
        ("METERM_HOOK_SECRET".to_string(), secret.to_string()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_missing_session_is_false() {
        let reg = HookSecretRegistry::new();
        assert!(
            !reg.verify("no-such-session", "anything"),
            "未登记会话应校验失败"
        );
    }

    #[test]
    fn register_then_verify_correct_secret() {
        let reg = HookSecretRegistry::new();
        reg.register("sess-1".to_string(), "s3cr3t-token".to_string());
        assert!(
            reg.verify("sess-1", "s3cr3t-token"),
            "正确 secret 应校验通过"
        );
    }

    #[test]
    fn verify_wrong_secret_is_false() {
        let reg = HookSecretRegistry::new();
        reg.register("sess-1".to_string(), "s3cr3t-token".to_string());
        assert!(
            !reg.verify("sess-1", "wrong-token"),
            "错误 secret 应校验失败"
        );
        // 长度不同也必须 false(constant_time_eq 长度不等直接短路)。
        assert!(
            !reg.verify("sess-1", "s3cr3t-token-extra"),
            "长度不同的 secret 应校验失败"
        );
    }

    #[test]
    fn register_overwrites_and_verify_follows() {
        let reg = HookSecretRegistry::new();
        reg.register("sess-1".to_string(), "old-secret".to_string());
        reg.register("sess-1".to_string(), "new-secret".to_string());
        assert!(
            !reg.verify("sess-1", "old-secret"),
            "旧 secret 覆盖后应失效"
        );
        assert!(reg.verify("sess-1", "new-secret"), "新 secret 应生效");
    }

    #[test]
    fn remove_clears_secret() {
        let reg = HookSecretRegistry::new();
        reg.register("sess-1".to_string(), "s3cr3t".to_string());
        assert!(reg.verify("sess-1", "s3cr3t"));
        reg.remove("sess-1");
        assert!(!reg.verify("sess-1", "s3cr3t"), "remove 后应校验失败");
        // 重复 remove 不 panic。
        reg.remove("sess-1");
    }

    #[test]
    fn clone_shares_backing_store() {
        let reg = HookSecretRegistry::new();
        let clone = reg.clone();
        reg.register("sess-1".to_string(), "s3cr3t".to_string());
        // 克隆体共享同一份 Arc<Mutex<..>>,一处登记另一处即可校验。
        assert!(clone.verify("sess-1", "s3cr3t"), "克隆体应看到同一份数据");
    }

    #[test]
    fn hook_envs_builds_three_expected_pairs() {
        let envs = hook_envs("sess-abc", 51234, "the-secret");
        assert_eq!(envs.len(), 3);
        // 用 map 校验键名 + 取值(顺序无关,但键名/取值必须精确——M2/M3 依赖)。
        let map: std::collections::HashMap<_, _> = envs.into_iter().collect();
        assert_eq!(
            map.get("METERM_SESSION_ID").map(String::as_str),
            Some("sess-abc")
        );
        assert_eq!(
            map.get("METERM_HOOK_PORT").map(String::as_str),
            Some("51234")
        );
        assert_eq!(
            map.get("METERM_HOOK_SECRET").map(String::as_str),
            Some("the-secret")
        );
    }
}
