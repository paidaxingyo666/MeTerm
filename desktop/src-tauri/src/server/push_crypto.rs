//! 终端通知 Phase 3:后台 APNs 加密推送的地基 —— 桌面把通知内容 seal 成密文,
//! APNs / 中继全程只看到密文,只有持有接收方(手机)私钥才能解出明文(E2E)。
//!
//! 方案(需与手机端 CryptoKit 互操作,不引 libsodium):
//! 1. 手机持一对静态 X25519(Curve25519)密钥,公钥交给桌面(经 `/api/push/register`)。
//! 2. 桌面 `seal`:生成一次性(ephemeral)X25519 密钥对 `(e_priv, e_pub)`
//!    → `shared = X25519(e_priv, recipient_pub)`(ECDH)
//!    → `key = HKDF-SHA256(ikm = shared, salt = [], info = b"meterm-notif-v1")` 取 32 字节
//!    → 随机 12 字节 nonce → `ct = ChaCha20Poly1305(key).encrypt(nonce, plaintext)`
//!    → 输出 `base64(e_pub(32B) || nonce(12B) || ct)`。
//! 3. 手机侧(CryptoKit)对称地:用自己的静态私钥 + 消息里的 `e_pub` 做 ECDH 得到同一个
//!    `shared`,同样的 HKDF 参数派生出同一个 `key`,再用 `nonce` 解 `ct`。
//!
//! 全部用 RustCrypto 纯 Rust crate(x25519-dalek v2 / chacha20poly1305 v0.10 / hkdf v0.12 + sha2),
//! 与生态版本对齐,不引入额外的 C 依赖。

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use x25519_dalek::{EphemeralSecret, PublicKey, StaticSecret};

/// HKDF `info` 参数 —— 固定上下文串,防止跨协议/跨用途的密钥复用攻击。
/// 手机侧 CryptoKit 的 HKDF 派生必须使用完全相同的 info 字节。
const HKDF_INFO: &[u8] = b"meterm-notif-v1";

/// 用接收方(手机)静态 X25519 公钥,把明文 seal 成密文。
/// `desktop_id` 作为 AEAD associated data 参与认证但不加密；relay/APNs 可以路由它，
/// 却无法把密文改挂到另一桌面身份下而仍让手机解密成功。
///
/// 返回 `base64(e_pub(32B) || nonce(12B) || ct)`——ct 尾部自带 Poly1305 tag(16B),
/// 即标准 AEAD 输出,无需单独传 tag。
pub fn seal(recipient_pub: &[u8; 32], desktop_id: &str, plaintext: &[u8]) -> String {
    // 1) 一次性(ephemeral)密钥对,每次调用都不同,提供逐消息密钥隔离与随机化。
    // 接收方仍使用长期静态私钥；该私钥日后失陷时，攻击者可解开其先前保存的密文，
    // 因而这里不能宣称具备完整前向保密。
    let e_priv = EphemeralSecret::random_from_rng(rand::thread_rng());
    let e_pub = PublicKey::from(&e_priv);

    // 2) ECDH:e_priv 与对端静态公钥算共享密钥。
    let recipient_pub = PublicKey::from(*recipient_pub);
    let shared = e_priv.diffie_hellman(&recipient_pub);

    // 3) HKDF-SHA256(ikm=shared, salt=空, info=HKDF_INFO) 派生 32 字节对称密钥。
    let key = derive_key(shared.as_bytes());

    // 4) 随机 12 字节 nonce(ChaCha20Poly1305 = IETF 96-bit nonce,与 CryptoKit ChaChaPoly 一致)。
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let cipher = ChaCha20Poly1305::new((&key).into());
    // encrypt 只在明文/密钥/nonce 尺寸非法时才会失败,这里三者都是构造时定长,不会触发。
    let ct = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad: desktop_id.as_bytes(),
            },
        )
        .expect("chacha20poly1305 encrypt with valid fixed-size inputs cannot fail");

    // 5) 拼接 e_pub || nonce || ct,再 base64 编码成一个字符串,便于 JSON 承载。
    let mut out = Vec::with_capacity(32 + 12 + ct.len());
    out.extend_from_slice(e_pub.as_bytes());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &out)
}

/// 与 `seal` 对称的解密路径(测试专用,验证方案自洽;手机端用 CryptoKit 实现同等逻辑)。
///
/// 输入接收方静态私钥 + `seal` 的 base64 输出,还原明文。
#[cfg(test)]
fn open_for_test(
    recipient_priv: &StaticSecret,
    desktop_id: &str,
    sealed_b64: &str,
) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(sealed_b64)
        .map_err(|e| format!("base64 decode failed: {}", e))?;
    if raw.len() < 32 + 12 {
        return Err("sealed payload too short".to_string());
    }
    let e_pub_bytes: [u8; 32] = raw[0..32].try_into().unwrap();
    let nonce_bytes = &raw[32..44];
    let ct = &raw[44..];

    let e_pub = PublicKey::from(e_pub_bytes);
    let shared = recipient_priv.diffie_hellman(&e_pub);
    let key = derive_key(shared.as_bytes());

    let nonce = Nonce::from_slice(nonce_bytes);
    let cipher = ChaCha20Poly1305::new((&key).into());
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: ct,
                aad: desktop_id.as_bytes(),
            },
        )
        .map_err(|e| format!("decrypt failed: {}", e))
}

/// HKDF-SHA256(ikm, salt=空, info=HKDF_INFO) → 32 字节对称密钥。
fn derive_key(ikm: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(None, ikm);
    let mut key = [0u8; 32];
    hk.expand(HKDF_INFO, &mut key)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    key
}

/// 解析手机传来的 X25519 公钥字符串,支持 hex(64 个十六进制字符)或 base64(标准/无填充)。
///
/// **手机侧应发送 hex**(64 位小写十六进制字符串)——与项目里现有指纹字段
/// (`cert_fp`/`relay_cert_fp`)风格一致,便于日志/调试直接肉眼比对。
/// 这里同时兼容 base64 只是为了对接口更宽容(未来切换或误传时不至于直接拒绝),
/// 不代表推荐格式。
pub fn parse_pub_hex_or_b64(s: &str) -> Option<[u8; 32]> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }

    // 优先尝试 hex:必须恰好 64 个十六进制字符(32 字节)。
    if s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
        if let Some(bytes) = decode_hex(s) {
            return Some(bytes);
        }
    }

    // 否则尝试 base64(标准 / URL-safe,允许有无填充)。
    use base64::Engine;
    let candidates: [Result<Vec<u8>, base64::DecodeError>; 4] = [
        base64::engine::general_purpose::STANDARD.decode(s),
        base64::engine::general_purpose::STANDARD_NO_PAD.decode(s),
        base64::engine::general_purpose::URL_SAFE.decode(s),
        base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s),
    ];
    for candidate in candidates {
        if let Ok(bytes) = candidate {
            if bytes.len() == 32 {
                let mut out = [0u8; 32];
                out.copy_from_slice(&bytes);
                return Some(out);
            }
        }
    }

    None
}

// ============================================================================
// 推送注册输入白名单校验(P3 安全修复 I1/I2)
// ============================================================================

/// APNs device token 长度范围,与 `relay/src/push.rs` 的同名校验保持一致(见该文件注释):
/// 真实 iOS token 定长 64 位十六进制(32 字节),上限留到 200 防止未来变长时误伤。
const APNS_TOKEN_MIN_LEN: usize = 64;
const APNS_TOKEN_MAX_LEN: usize = 200;

/// 校验 `apns_token`:必须是纯十六进制字符串,长度落在
/// `[APNS_TOKEN_MIN_LEN, APNS_TOKEN_MAX_LEN]` 区间内。
///
/// P3 安全修复(I1):此前 `register_push` 只判空,任意字符串都会原样存入 `state.push`
/// 并在后续推送时拼进中继 `/push` 请求体、最终进入 APNs 请求 URL。白名单为纯十六进制后,
/// 不可能带 `/`、`?`、`..` 等特殊字符,从源头(注册入口)就挡住畸形/恶意值。
pub fn is_valid_apns_token(token: &str) -> bool {
    let len = token.len();
    (APNS_TOKEN_MIN_LEN..=APNS_TOKEN_MAX_LEN).contains(&len)
        && token.chars().all(|c| c.is_ascii_hexdigit())
}

/// 校验 `env`:必须显式是 `"sandbox"` 或 `"production"` 之一。
///
/// P3 安全修复(I2):此前只判空,任何非空字符串(拼写错误/恶意值)都会被存下来,
/// 后续请求中继代发推送时可能被中继一侧的宽松判断静默错发到错误环境。改为注册入口
/// 就显式白名单拒绝,不再允许未知值进入系统。
pub fn is_valid_env(env: &str) -> bool {
    matches!(env, "sandbox" | "production")
}

/// 手写 hex 解码(避免为此单独引入 `hex` crate;项目里其余指纹字段也是手写十六进制格式化)。
/// 输入长度必须是偶数且全为合法十六进制字符,否则返回 `None`。
fn decode_hex(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    let bytes = s.as_bytes();
    for i in 0..32 {
        let hi = hex_digit(bytes[i * 2])?;
        let lo = hex_digit(bytes[i * 2 + 1])?;
        out[i] = (hi << 4) | lo;
    }
    Some(out)
}

fn hex_digit(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 核心往返测试:本地生成一对接收方 X25519 密钥,seal 后用对应私钥解出明文。
    /// 这条能过就证明 seal 的 ECDH + HKDF + AEAD 组合方案自洽
    /// (手机侧 CryptoKit 互操作留给 P3-T4/T5 验证)。
    #[test]
    fn seal_then_open_roundtrip_recovers_plaintext() {
        let recipient_priv = StaticSecret::random_from_rng(rand::thread_rng());
        let recipient_pub = PublicKey::from(&recipient_priv);

        let plaintext = b"hello";
        let sealed = seal(recipient_pub.as_bytes(), "desktop-123", plaintext);

        let opened =
            open_for_test(&recipient_priv, "desktop-123", &sealed).expect("decrypt should succeed");
        assert_eq!(opened, plaintext);
    }

    #[test]
    fn ciphertext_is_bound_to_desktop_identity() {
        let recipient_priv = StaticSecret::random_from_rng(rand::thread_rng());
        let recipient_pub = PublicKey::from(&recipient_priv);
        let sealed = seal(recipient_pub.as_bytes(), "desktop-a", b"notification");

        assert!(open_for_test(&recipient_priv, "desktop-b", &sealed).is_err());
    }

    /// 每次 seal 都应使用不同的 ephemeral 密钥/nonce,输出应不同(逐消息密钥隔离 + 语义安全)。
    #[test]
    fn seal_is_non_deterministic_across_calls() {
        let recipient_priv = StaticSecret::random_from_rng(rand::thread_rng());
        let recipient_pub = PublicKey::from(&recipient_priv);

        let a = seal(recipient_pub.as_bytes(), "desktop-123", b"same input");
        let b = seal(recipient_pub.as_bytes(), "desktop-123", b"same input");
        assert_ne!(a, b, "两次 seal 输出不应相同(ephemeral key + random nonce)");
    }

    /// 用错误的接收方私钥解密应失败(AEAD 认证失败,而非返回错误明文)。
    #[test]
    fn open_with_wrong_key_fails() {
        let recipient_priv = StaticSecret::random_from_rng(rand::thread_rng());
        let recipient_pub = PublicKey::from(&recipient_priv);
        let wrong_priv = StaticSecret::random_from_rng(rand::thread_rng());

        let sealed = seal(recipient_pub.as_bytes(), "desktop-123", b"secret");
        let result = open_for_test(&wrong_priv, "desktop-123", &sealed);
        assert!(
            result.is_err(),
            "用错误私钥解密应失败,而不是静默返回错误明文"
        );
    }

    /// hex(64 字符,不分大小写)应能正确解析成 32 字节。
    #[test]
    fn parse_pub_accepts_hex() {
        let bytes: [u8; 32] = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd,
            0xee, 0xff, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x01,
        ];
        let hex_lower: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
        assert_eq!(parse_pub_hex_or_b64(&hex_lower), Some(bytes));

        let hex_upper = hex_lower.to_uppercase();
        assert_eq!(parse_pub_hex_or_b64(&hex_upper), Some(bytes));
    }

    /// base64(标准编码)也应能解析成 32 字节 —— 兼容性兜底,不代表推荐格式。
    #[test]
    fn parse_pub_accepts_base64() {
        let bytes = [7u8; 32];
        let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
        assert_eq!(parse_pub_hex_or_b64(&b64), Some(bytes));
    }

    /// 非法输入(错误长度 / 非法字符)应返回 None,而不是 panic。
    #[test]
    fn parse_pub_rejects_invalid_input() {
        assert_eq!(parse_pub_hex_or_b64(""), None);
        assert_eq!(parse_pub_hex_or_b64("not-hex-or-b64!!"), None);
        assert_eq!(parse_pub_hex_or_b64("deadbeef"), None); // 太短
    }

    #[test]
    fn apns_token_validation_accepts_real_shape() {
        assert!(is_valid_apns_token(&"a".repeat(64)));
        assert!(is_valid_apns_token(&"A".repeat(64)));
        assert!(is_valid_apns_token(&"f".repeat(200)));
    }

    #[test]
    fn apns_token_validation_rejects_bad_shape() {
        assert!(!is_valid_apns_token(&"a".repeat(63)));
        assert!(!is_valid_apns_token(&"a".repeat(201)));
        assert!(!is_valid_apns_token(&format!("{}g", "a".repeat(63))));
        assert!(!is_valid_apns_token(""));
        assert!(!is_valid_apns_token("../../etc/passwd"));
        assert!(!is_valid_apns_token(&format!("{}/evil", "a".repeat(64))));
    }

    #[test]
    fn env_validation_is_explicit_whitelist() {
        assert!(is_valid_env("sandbox"));
        assert!(is_valid_env("production"));
        assert!(!is_valid_env("Production"));
        assert!(!is_valid_env("prod"));
        assert!(!is_valid_env(""));
        assert!(!is_valid_env("sandbox "));
    }
}
