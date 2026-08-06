//! fix8:agent 菜单动态提取——运行时从本机 claude 二进制提取 `/model` 别名全集与
//! `/effort` 档位全集,消除硬编码漂移(claude 更新增删模型/改档位后自动跟随)。
//!
//! 调研结论(多代理并行深挖 2.1.202/205/206 三版本,佐证见设计记录):
//! - 二进制是 bun 打包的**明文** minified JS(Mach-O `__BUN,__bun` 段,无压缩加密),
//!   直接字节流正则可扫,全扫 ~240MB 仅 0.3s 量级;
//! - `/model` 的**合法别名全集**是一个字面量数组
//!   `["sonnet","opus","haiku","fable","best","sonnet[1m]",…,"opusplan"]`(锚
//!   `["sonnet","opus"` 前缀);菜单的 Default 首项内部 value 为 null、序列化为
//!   `"default"`,不在该数组 → 提取后前插;
//! - `/effort` 基础 5 档是**单处静态数组**
//!   `[{value:"low",label:"low",…},…,{value:"max",…}]`(锚 `{value:"low",label:"low"`,
//!   三版本逐字节一致);`ultracode` 是条件追加的第 6 档(workflows 开启 + 模型支持
//!   xhigh),文本命令 `/effort ultracode` 有效,以其帮助文本存在与否判定;
//! - 跨版本模式稳定、绝对 offset 每版漂移 1-2MB、minified 标识符每版重命名 →
//!   **只锚字符串模式,绝不锚 offset/标识符**;
//! - 无官方替代来源:无 `claude models` 子命令、~/.claude 无菜单 JSON。
//!
//! 兜底纪律(fail-open):提取失败/校验不过 → [`builtin_fallback`] 内置快照
//! (`source:"builtin"`,手机 UI 据此可标注"列表可能过时");菜单只是便利层,
//! `/model` 接受任意模型 ID 直通,提取失败绝不阻断功能。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

use serde::Serialize;

/// 提取结果(REST `GET /api/agent-options` 的响应体)。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AgentOptions {
    /// `/model` 可选值:恒以 "default" 开头,其余为二进制别名全集原序。
    pub models: Vec<String>,
    /// `/effort` 可选值:基础档(low..max)+ 条件档 ultracode(存在时尾追)。
    pub efforts: Vec<String>,
    /// "extracted" = 本机二进制实时提取;"builtin" = 内置快照(提取失败兜底)。
    pub source: &'static str,
}

/// 进程级缓存:`(claude 实体路径, 文件大小, mtime) -> 提取结果`。
/// claude 升级(versions/ 换实体文件)→ 键变 → 自动重扫;桌面进程重启亦重扫。
type CacheKey = (PathBuf, u64, SystemTime);
static CACHE: Mutex<Option<(CacheKey, AgentOptions)>> = Mutex::new(None);

/// 取 agent 菜单选项(带进程级缓存)。任何一步失败都落内置快照,不返回错误。
pub fn agent_options() -> AgentOptions {
    let Some(path) = locate_claude() else {
        return builtin_fallback();
    };
    let Ok(meta) = std::fs::metadata(&path) else {
        return builtin_fallback();
    };
    let key: CacheKey = (
        path.clone(),
        meta.len(),
        meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
    );
    if let Some((cached_key, cached)) = CACHE.lock().unwrap().as_ref() {
        if *cached_key == key {
            return cached.clone();
        }
    }
    // 全量读入(峰值 ~240MB,提取后立即释放;桌面 app 可接受,免 mmap 依赖)。
    let extracted = std::fs::read(&path)
        .ok()
        .and_then(|bytes| extract_from_bytes(&bytes));
    let options = extracted.unwrap_or_else(builtin_fallback);
    *CACHE.lock().unwrap() = Some((key, options.clone()));
    options
}

/// 定位 claude 实体二进制:常见安装路径 + PATH 上的 `which`,再 canonicalize
/// 穿透符号链接(~/.local/bin/claude -> …/versions/x.y.z)。
fn locate_claude() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/bin/claude"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
    candidates.push(PathBuf::from("/usr/local/bin/claude"));
    // 桌面 app 进程的 PATH 常缺用户 shell 的条目,which 只作最后手段。
    if let Ok(out) = std::process::Command::new("which").arg("claude").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                candidates.push(PathBuf::from(s));
            }
        }
    }
    candidates
        .into_iter()
        .find_map(|p| std::fs::canonicalize(p).ok())
}

/// 纯函数:从二进制字节流提取 (models, efforts)。校验不过 → None(上层落兜底)。
pub(crate) fn extract_from_bytes(bytes: &[u8]) -> Option<AgentOptions> {
    let models = extract_models(bytes)?;
    let efforts = extract_efforts(bytes)?;
    Some(AgentOptions {
        models,
        efforts,
        source: "extracted",
    })
}

/// `/model` 别名全集:锚 `["sonnet","opus"` 开头的字面量字符串数组。
/// 可能多处命中(跨版本实测 1 处,防御取**项数最多**者);前插 "default"。
/// 校验:项数 3..=24、必含 "sonnet" 与 "opus"、项均为 `[a-z0-9\[\].-]{1,24}`。
fn extract_models(bytes: &[u8]) -> Option<Vec<String>> {
    let re = regex::bytes::Regex::new(r#"\["sonnet","opus"(?:,"[a-z0-9\[\].-]{1,24}")*\]"#)
        .expect("静态正则必合法");
    let item_re = regex::bytes::Regex::new(r#""([a-z0-9\[\].-]{1,24})""#).expect("静态正则必合法");
    let best: Vec<String> = re
        .find_iter(bytes)
        .map(|m| {
            item_re
                .captures_iter(m.as_bytes())
                .filter_map(|c| String::from_utf8(c[1].to_vec()).ok())
                .collect::<Vec<_>>()
        })
        .max_by_key(Vec::len)?;
    if best.len() < 3 || best.len() > 24 {
        return None;
    }
    if !best.iter().any(|m| m == "sonnet") || !best.iter().any(|m| m == "opus") {
        return None;
    }
    // Default 菜单首项(内部 value:null、序列化 "default")不在别名数组,前插。
    let mut models = Vec::with_capacity(best.len() + 1);
    models.push("default".to_string());
    models.extend(best);
    Some(models)
}

/// `/effort` 档位:锚 `{value:"low",label:"low"` 的静态菜单数组段,段内拆全部
/// `value:"…"`;`ultracode`(条件第 6 档)以其帮助文本存在与否判定,存在则尾追。
/// 校验:基础档 3..=10 项、首项 "low"、必含 "high"。
fn extract_efforts(bytes: &[u8]) -> Option<Vec<String>> {
    let seg_re = regex::bytes::Regex::new(r#"\{value:"low",label:"low"[^\]]{0,600}?\]"#)
        .expect("静态正则必合法");
    let val_re = regex::bytes::Regex::new(r#"value:"([a-z]{1,16})""#).expect("静态正则必合法");
    let seg = seg_re.find(bytes)?;
    let mut efforts: Vec<String> = val_re
        .captures_iter(seg.as_bytes())
        .filter_map(|c| String::from_utf8(c[1].to_vec()).ok())
        .collect();
    efforts.dedup();
    if efforts.len() < 3 || efforts.len() > 10 {
        return None;
    }
    if efforts.first().map(String::as_str) != Some("low") || !efforts.iter().any(|e| e == "high") {
        return None;
    }
    // ultracode:条件追加档(workflows + 模型支持 xhigh),帮助文本是稳定锚
    // (`- ultracode: xhigh + dynamic workflow orchestration`)。选中后 claude 内部
    // 折算为 effortLevel=xhigh + ultracode:true,CLAUDE_EFFORT 只回报 "xhigh"。
    const ULTRACODE_ANCHOR: &[u8] = b"ultracode: xhigh + dynamic workflow orchestration";
    if bytes
        .windows(ULTRACODE_ANCHOR.len())
        .any(|w| w == ULTRACODE_ANCHOR)
    {
        efforts.push("ultracode".to_string());
    }
    Some(efforts)
}

/// 内置快照(提取失败兜底;与 2.1.206 实测一致)。菜单只是便利层——
/// `/model`/`/effort` 接受直通文本,过时快照最多是少个新选项,不阻断任何功能。
pub(crate) fn builtin_fallback() -> AgentOptions {
    AgentOptions {
        models: [
            "default",
            "sonnet",
            "opus",
            "haiku",
            "fable",
            "best",
            "sonnet[1m]",
            "opus[1m]",
            "fable[1m]",
            "opusplan",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
        efforts: ["low", "medium", "high", "xhigh", "max", "ultracode"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        source: "builtin",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 合成一段带真实模式的假二进制(别名数组 + effort 菜单段 + ultracode 帮助文本)。
    fn fixture(with_ultracode: bool) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(b"\x00\x01junk-prefix");
        b.extend_from_slice(
            br#"ope=["sonnet","opus","haiku","fable","best","sonnet[1m]","opus[1m]","fable[1m]","opusplan"]"#,
        );
        b.extend_from_slice(b"\xffmore junk\x00");
        b.extend_from_slice(
            br#"Hoa=[{value:"low",label:"low",color:"warning"},{value:"medium",label:"medium",color:"success"},{value:"high",label:"high",color:"permission"},{value:"xhigh",label:"xhigh",color:"autoAccept-shimmer"},{value:"max",label:"max",color:"rainbow-animated"}]"#,
        );
        if with_ultracode {
            b.extend_from_slice(
                b"`- ultracode: xhigh + dynamic workflow orchestration (this session only)`",
            );
        }
        b.extend_from_slice(b"trailing\x00");
        b
    }

    /// 主路径:别名全集 + default 前插;effort 5 档 + ultracode 尾追;source=extracted。
    #[test]
    fn extracts_models_and_efforts_from_fixture() {
        let opts = extract_from_bytes(&fixture(true)).expect("fixture 应提取成功");
        assert_eq!(
            opts.models,
            vec![
                "default",
                "sonnet",
                "opus",
                "haiku",
                "fable",
                "best",
                "sonnet[1m]",
                "opus[1m]",
                "fable[1m]",
                "opusplan"
            ],
            "别名原序 + default 前插"
        );
        assert_eq!(
            opts.efforts,
            vec!["low", "medium", "high", "xhigh", "max", "ultracode"],
            "基础 5 档 + ultracode 尾追"
        );
        assert_eq!(opts.source, "extracted");
    }

    /// 无 ultracode 帮助文本(未来若移除该模式)→ 只有基础档,不误报。
    #[test]
    fn ultracode_only_when_anchor_present() {
        let opts = extract_from_bytes(&fixture(false)).unwrap();
        assert_eq!(opts.efforts, vec!["low", "medium", "high", "xhigh", "max"]);
    }

    /// 校验:别名数组缺 opus 锚(模式变化)→ None(上层落兜底,不部分采用)。
    #[test]
    fn missing_model_anchor_returns_none() {
        let mut b = fixture(true);
        // 破坏别名数组锚("opus" → "opux"),effort 段保留 → 整体仍须 None。
        let pos = b.windows(6).position(|w| w == b"\"opus\"").unwrap();
        b[pos + 4] = b'x';
        assert!(extract_from_bytes(&b).is_none(), "锚破坏须整体判失败");
    }

    /// 校验:effort 段缺失 → None。
    #[test]
    fn missing_effort_segment_returns_none() {
        let mut b = Vec::new();
        b.extend_from_slice(br#"["sonnet","opus","haiku"]"#);
        assert!(extract_from_bytes(&b).is_none());
    }

    /// 内置快照自身必须过同一套语义(别名含 sonnet/opus、effort 首 low 含 high)。
    #[test]
    fn builtin_fallback_is_self_consistent() {
        let f = builtin_fallback();
        assert_eq!(f.source, "builtin");
        assert_eq!(f.models.first().map(String::as_str), Some("default"));
        assert!(f.models.iter().any(|m| m == "sonnet") && f.models.iter().any(|m| m == "opus"));
        assert_eq!(f.efforts.first().map(String::as_str), Some("low"));
        assert!(f.efforts.iter().any(|e| e == "ultracode"));
    }

    /// 真实本机二进制(存在才跑):提取成功且与内置快照语义兼容。
    /// CI/无 claude 环境自动跳过(不硬编码版本路径,走 locate)。
    #[test]
    fn real_binary_extraction_when_available() {
        let Some(path) = locate_claude() else {
            eprintln!("[skip] 本机无 claude,跳过真实二进制提取测试");
            return;
        };
        let bytes = std::fs::read(&path).expect("claude 二进制应可读");
        let opts = extract_from_bytes(&bytes)
            .unwrap_or_else(|| panic!("真实二进制提取失败(模式漂移?): {}", path.display()));
        assert_eq!(opts.source, "extracted");
        assert!(
            opts.models.len() >= 4,
            "真实别名全集至少 4 项: {:?}",
            opts.models
        );
        assert!(
            opts.efforts.iter().any(|e| e == "xhigh"),
            "efforts: {:?}",
            opts.efforts
        );
    }
}
