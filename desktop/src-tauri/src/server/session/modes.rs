//! 终端私有模式跟踪(DECSET/DECRST)——attach/接管 replay 时恢复模式状态。
//!
//! 环形缓冲只保存最近的输出字节;TUI 启动早期发出的 `ESC[?1049h`(alt-screen)、
//! `ESC[?1002;1006h`(鼠标)等模式序列一旦滚出缓冲区,新 attach 的客户端(手机端)
//! 就永远看不到——xterm 认为鼠标未开、不在 alt-screen:点击被拒、重绘落进普通
//! 缓冲区(错位 + 滚动条占位)。这里对 PTY 输出做增量扫描(容忍序列跨 chunk 分割),
//! 维护"当前生效的私有模式",replay 时在 RIS 之后、缓冲内容之前重放当前模式
//! (tmux 对 attach 客户端的同类做法)。

use std::collections::HashMap;

/// 跟踪的 DECSET 私有模式白名单 `(mode, 默认值)`。
/// 1=DECCKM 应用光标, 7=自动换行(默认开), 25=光标可见(默认开),
/// 47/1047/1049=alt-screen, 1000/1002/1003=鼠标跟踪, 1004=焦点上报,
/// 1005/1006/1015/1016=鼠标编码, 2004=bracketed paste。
const TRACKED: &[(u16, bool)] = &[
    (1, false),
    (7, true),
    (25, true),
    (47, false),
    (1000, false),
    (1002, false),
    (1003, false),
    (1004, false),
    (1005, false),
    (1006, false),
    (1015, false),
    (1016, false),
    (1047, false),
    (1049, false),
    (2004, false),
];

/// 参数区长度上限:超长视为异常序列,放弃解析该条(防御畸形输出)。
const MAX_PARAMS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq)]
enum ParseState {
    Ground,
    Esc,        // 见到 ESC
    Csi,        // 见到 ESC [,还没定私有/普通
    CsiPrivate, // ESC [ ?,收集参数直到终结字节
    CsiOther,   // 非私有 CSI,跳过直到终结字节
}

pub struct ModeTracker {
    state: ParseState,
    params: Vec<u8>,
    /// 只存与默认值不同(或被显式设置过)的模式;查询时回退默认值。
    modes: HashMap<u16, bool>,
}

impl ModeTracker {
    pub fn new() -> Self {
        Self {
            state: ParseState::Ground,
            params: Vec::new(),
            modes: HashMap::new(),
        }
    }

    fn default_of(mode: u16) -> Option<bool> {
        TRACKED.iter().find(|(m, _)| *m == mode).map(|(_, d)| *d)
    }

    /// 增量喂入 PTY 输出字节(与写环形缓冲同源同序,天然处理跨 chunk 分割)。
    pub fn feed(&mut self, data: &[u8]) {
        for &b in data {
            // 任何状态下遇到 ESC 都重新开始(CSI 内混入 ESC 视为序列中断)
            if b == 0x1b {
                self.state = ParseState::Esc;
                continue;
            }
            match self.state {
                ParseState::Ground => {}
                ParseState::Esc => {
                    self.state = match b {
                        b'[' => ParseState::Csi,
                        b'c' => {
                            // RIS 全量复位:所有模式回默认
                            self.modes.clear();
                            ParseState::Ground
                        }
                        _ => ParseState::Ground,
                    };
                }
                ParseState::Csi => {
                    if b == b'?' {
                        self.params.clear();
                        self.state = ParseState::CsiPrivate;
                    } else if (0x40..=0x7e).contains(&b) {
                        self.state = ParseState::Ground; // 无参数普通 CSI 直接终结
                    } else {
                        self.state = ParseState::CsiOther;
                    }
                }
                ParseState::CsiPrivate => {
                    if (0x40..=0x7e).contains(&b) {
                        if b == b'h' || b == b'l' {
                            self.apply(b == b'h');
                        }
                        self.state = ParseState::Ground;
                    } else if self.params.len() >= MAX_PARAMS {
                        self.state = ParseState::CsiOther; // 畸形超长,放弃
                    } else {
                        self.params.push(b);
                    }
                }
                ParseState::CsiOther => {
                    if (0x40..=0x7e).contains(&b) {
                        self.state = ParseState::Ground;
                    }
                }
            }
        }
    }

    /// 应用 `ESC [ ? params (h|l)`:params 以 ';' 分隔,白名单内的记录状态。
    fn apply(&mut self, set: bool) {
        for part in self.params.split(|&b| b == b';') {
            if let Ok(s) = std::str::from_utf8(part) {
                if let Ok(m) = s.parse::<u16>() {
                    if Self::default_of(m).is_some() {
                        self.modes.insert(m, set);
                    }
                }
            }
        }
        self.params.clear();
    }

    /// 生成 replay 前缀:当前状态与默认不同的模式,逐条 `ESC[?{m}h/l`。
    /// 顺序按白名单声明序(1049 alt-screen 在鼠标之前无关紧要:全部在内容之前发出)。
    pub fn replay_seq(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for &(m, default) in TRACKED {
            let cur = self.modes.get(&m).copied().unwrap_or(default);
            if cur != default {
                out.extend_from_slice(
                    format!("\x1b[?{}{}", m, if cur { 'h' } else { 'l' }).as_bytes(),
                );
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_set_and_replay() {
        let mut t = ModeTracker::new();
        t.feed(b"hello\x1b[?1049h\x1b[?1002;1006hworld");
        let seq = String::from_utf8(t.replay_seq()).unwrap();
        assert!(seq.contains("\x1b[?1002h"));
        assert!(seq.contains("\x1b[?1006h"));
        assert!(seq.contains("\x1b[?1049h"));
        assert!(!seq.contains("?1000h"));
    }

    #[test]
    fn test_reset_via_decrst() {
        let mut t = ModeTracker::new();
        t.feed(b"\x1b[?1002;1006h\x1b[?1002l");
        let seq = String::from_utf8(t.replay_seq()).unwrap();
        assert!(!seq.contains("?1002h"));
        assert!(seq.contains("\x1b[?1006h"));
    }

    #[test]
    fn test_default_on_mode_disabled() {
        // 25(光标可见)默认开,被关掉时 replay 要发 l
        let mut t = ModeTracker::new();
        t.feed(b"\x1b[?25l");
        let seq = String::from_utf8(t.replay_seq()).unwrap();
        assert_eq!(seq, "\x1b[?25l");
        // 重新打开后回到默认,不再出现在 replay 中
        t.feed(b"\x1b[?25h");
        assert!(t.replay_seq().is_empty());
    }

    #[test]
    fn test_chunk_split_sequence() {
        // 序列跨 chunk 分割也要正确解析(read 边界不可控)
        let mut t = ModeTracker::new();
        t.feed(b"\x1b[?10");
        t.feed(b"02;10");
        t.feed(b"06h");
        let seq = String::from_utf8(t.replay_seq()).unwrap();
        assert!(seq.contains("\x1b[?1002h"));
        assert!(seq.contains("\x1b[?1006h"));
    }

    #[test]
    fn test_ris_resets_all() {
        let mut t = ModeTracker::new();
        t.feed(b"\x1b[?1049h\x1b[?1006h\x1b[?25l");
        t.feed(b"\x1bc");
        assert!(t.replay_seq().is_empty());
    }

    #[test]
    fn test_untracked_and_plain_csi_ignored() {
        let mut t = ModeTracker::new();
        // 普通 CSI(SGR 颜色)、非白名单私有模式(12 光标闪烁)都不产生 replay
        t.feed(b"\x1b[31m\x1b[?12h\x1b[2J\x1b[H");
        assert!(t.replay_seq().is_empty());
    }

    #[test]
    fn test_esc_interrupts_csi() {
        // CSI 中途混入新 ESC:旧序列作废,新序列正常解析
        let mut t = ModeTracker::new();
        t.feed(b"\x1b[?10\x1b[?1006h");
        let seq = String::from_utf8(t.replay_seq()).unwrap();
        assert_eq!(seq, "\x1b[?1006h");
    }
}
