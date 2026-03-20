//! OSC sequence filter — intercepts MeTerm-specific OSC sequences from terminal
//! output in the Rust layer, before they reach WebView2.
//!
//! The filter is a byte-level state machine that scans terminal output, extracts
//! OSC 7/7766/7768/9/777 sequences into structured events, and returns clean
//! output (without those sequences) for xterm.js rendering.
//!
//! Other OSC sequences (0/1/2/10/11 etc.) are passed through unchanged.

use serde::Serialize;

/// Maximum OSC body length before we consider it corrupted and flush.
const MAX_OSC_BODY: usize = 4096;

/// OSC numbers that MeTerm intercepts (not forwarded to frontend).
const INTERCEPTED_OSC: &[u32] = &[7, 9, 777, 7766, 7768];

/// Structured event extracted from an OSC sequence.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t")]
pub enum OscEvent {
    /// OSC 7: CWD change — `file://hostname/path`
    #[serde(rename = "cwd")]
    Cwd { cwd: String },

    /// OSC 7766: Shell marker — `marker_id;data`
    #[serde(rename = "marker")]
    Marker { id: String, data: String },

    /// OSC 7768: Shell state — `exit_code;cwd;last_cmd`
    #[serde(rename = "shell")]
    ShellState {
        exit: i32,
        cwd: String,
        cmd: String,
    },

    /// OSC 9;4: Progress indicator — `4;state;percent`
    #[serde(rename = "progress")]
    Progress { state: u8, percent: u8 },

    /// OSC 9 (non-progress) / OSC 777: Notification
    #[serde(rename = "notify")]
    Notify { title: String, body: String },
}

/// State machine states for OSC parsing.
#[derive(Debug, Clone, Copy, PartialEq)]
enum State {
    /// Normal text output.
    Normal,
    /// Just saw ESC (0x1b), waiting for next byte.
    Esc,
    /// ESC ] confirmed — reading OSC number digits.
    OscNum,
    /// Reading OSC body (after the first `;` or if no digits).
    OscBody,
    /// Inside OscBody, just saw ESC — waiting for `\` to form ST terminator.
    OscBodyEsc,
}

/// Byte-level OSC filter with internal state for cross-read-boundary support.
pub struct OscFilter {
    state: State,
    /// Current OSC number being parsed.
    osc_num: u32,
    /// OSC body accumulator (for cross-boundary support).
    osc_buf: Vec<u8>,
    /// Bytes pending after ESC that might not be an OSC start.
    /// If ESC is followed by something other than `]`, these are flushed to output.
    pending: Vec<u8>,
}

impl OscFilter {
    pub fn new() -> Self {
        Self {
            state: State::Normal,
            osc_num: 0,
            osc_buf: Vec::with_capacity(256),
            pending: Vec::with_capacity(8),
        }
    }

    /// Process a chunk of terminal output.
    ///
    /// Returns `(clean_output, events)`:
    /// - `clean_output`: terminal data with intercepted OSC sequences removed
    /// - `events`: structured events extracted from intercepted OSC sequences
    pub fn feed(&mut self, input: &[u8]) -> (Vec<u8>, Vec<OscEvent>) {
        let mut clean = Vec::with_capacity(input.len());
        let mut events = Vec::new();

        for &b in input {
            match self.state {
                State::Normal => {
                    if b == 0x1b {
                        self.state = State::Esc;
                        self.pending.clear();
                        self.pending.push(b);
                    } else {
                        clean.push(b);
                    }
                }

                State::Esc => {
                    if b == b']' {
                        // ESC ] → OSC start
                        self.state = State::OscNum;
                        self.osc_num = 0;
                        self.osc_buf.clear();
                        self.pending.clear();
                    } else {
                        // Not an OSC — flush pending ESC + this byte as normal output
                        clean.extend_from_slice(&self.pending);
                        clean.push(b);
                        self.pending.clear();
                        self.state = State::Normal;
                    }
                }

                State::OscNum => {
                    if b.is_ascii_digit() {
                        self.osc_num = self.osc_num * 10 + (b - b'0') as u32;
                    } else if b == b';' {
                        // End of number, start of body
                        self.state = State::OscBody;
                    } else if b == 0x07 {
                        // BEL terminator with no body
                        self.dispatch_osc(&mut clean, &mut events);
                        self.state = State::Normal;
                    } else if b == 0x1b {
                        // Could be ST (ESC \)
                        self.state = State::OscBodyEsc;
                    } else {
                        // Unexpected byte in OSC number — treat entire sequence as body
                        self.osc_buf.push(b);
                        self.state = State::OscBody;
                    }
                }

                State::OscBody => {
                    if b == 0x07 {
                        // BEL terminator
                        self.dispatch_osc(&mut clean, &mut events);
                        self.state = State::Normal;
                    } else if b == 0x1b {
                        self.state = State::OscBodyEsc;
                    } else {
                        self.osc_buf.push(b);
                        // Safety: flush if body is too long
                        if self.osc_buf.len() > MAX_OSC_BODY {
                            self.flush_corrupted(&mut clean);
                            self.state = State::Normal;
                        }
                    }
                }

                State::OscBodyEsc => {
                    if b == b'\\' {
                        // ST terminator (ESC \)
                        self.dispatch_osc(&mut clean, &mut events);
                        self.state = State::Normal;
                    } else {
                        // Not ST — the ESC + this byte are part of body
                        self.osc_buf.push(0x1b);
                        self.osc_buf.push(b);
                        self.state = State::OscBody;
                    }
                }
            }
        }

        (clean, events)
    }

    /// Dispatch a completed OSC sequence: either intercept it as an event,
    /// or pass it through to clean output if it's not a MeTerm OSC.
    fn dispatch_osc(&mut self, clean: &mut Vec<u8>, events: &mut Vec<OscEvent>) {
        if INTERCEPTED_OSC.contains(&self.osc_num) {
            // Parse and emit as event
            let body = String::from_utf8_lossy(&self.osc_buf).to_string();
            if let Some(ev) = self.parse_event(self.osc_num, &body) {
                events.push(ev);
            }
        } else {
            // Not intercepted — reconstruct and pass through
            clean.push(0x1b);
            clean.push(b']');
            clean.extend_from_slice(self.osc_num.to_string().as_bytes());
            if !self.osc_buf.is_empty() {
                clean.push(b';');
                clean.extend_from_slice(&self.osc_buf);
            }
            clean.push(0x07); // Use BEL as canonical terminator
        }
        self.osc_buf.clear();
        self.osc_num = 0;
    }

    /// Parse an intercepted OSC body into a structured event.
    fn parse_event(&self, num: u32, body: &str) -> Option<OscEvent> {
        match num {
            7 => {
                // OSC 7: file://hostname/path → extract path
                let cwd = if let Some(rest) = body.strip_prefix("file://") {
                    // Skip hostname (up to first `/` after `file://`)
                    if let Some(idx) = rest.find('/') {
                        rest[idx..].to_string()
                    } else {
                        rest.to_string()
                    }
                } else {
                    body.to_string()
                };
                if cwd.is_empty() {
                    None
                } else {
                    Some(OscEvent::Cwd { cwd })
                }
            }
            7766 => {
                // OSC 7766: marker_id;data
                let mut parts = body.splitn(2, ';');
                let id = parts.next().unwrap_or("").to_string();
                let data = parts.next().unwrap_or("").to_string();
                Some(OscEvent::Marker { id, data })
            }
            7768 => {
                // OSC 7768: exit_code;cwd;last_cmd
                let mut parts = body.splitn(3, ';');
                let exit = parts
                    .next()
                    .and_then(|s| s.parse::<i32>().ok())
                    .unwrap_or(0);
                let cwd = parts.next().unwrap_or("").to_string();
                let cmd = parts.next().unwrap_or("").trim().to_string();
                Some(OscEvent::ShellState { exit, cwd, cmd })
            }
            9 => {
                // OSC 9: "4;state;percent" (progress) or "text" (notify)
                if body.starts_with("4;") {
                    let mut parts = body[2..].splitn(2, ';');
                    let state = parts
                        .next()
                        .and_then(|s| s.parse::<u8>().ok())
                        .unwrap_or(0);
                    let percent = parts
                        .next()
                        .and_then(|s| s.parse::<u8>().ok())
                        .unwrap_or(0);
                    Some(OscEvent::Progress { state, percent })
                } else {
                    Some(OscEvent::Notify {
                        title: String::new(),
                        body: body.to_string(),
                    })
                }
            }
            777 => {
                // OSC 777: notify;title;body
                let mut parts = body.splitn(3, ';');
                let _action = parts.next(); // "notify"
                let title = parts.next().unwrap_or("").to_string();
                let body = parts.next().unwrap_or("").to_string();
                Some(OscEvent::Notify { title, body })
            }
            _ => None,
        }
    }

    /// Flush corrupted/too-long OSC as raw bytes to clean output.
    fn flush_corrupted(&mut self, clean: &mut Vec<u8>) {
        clean.push(0x1b);
        clean.push(b']');
        clean.extend_from_slice(self.osc_num.to_string().as_bytes());
        if !self.osc_buf.is_empty() {
            clean.push(b';');
            clean.extend_from_slice(&self.osc_buf);
        }
        self.osc_buf.clear();
        self.osc_num = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_passthrough() {
        let mut f = OscFilter::new();
        let (clean, events) = f.feed(b"hello world");
        assert_eq!(clean, b"hello world");
        assert!(events.is_empty());
    }

    #[test]
    fn intercept_osc7_cwd() {
        let mut f = OscFilter::new();
        let input = b"\x1b]7;file://host/home/user\x07rest";
        let (clean, events) = f.feed(input);
        assert_eq!(clean, b"rest");
        assert_eq!(events.len(), 1);
        match &events[0] {
            OscEvent::Cwd { cwd } => assert_eq!(cwd, "/home/user"),
            _ => panic!("expected Cwd event"),
        }
    }

    #[test]
    fn intercept_osc7768_shell_state() {
        let mut f = OscFilter::new();
        let input = b"\x1b]7768;0;/tmp;ls -la\x07";
        let (clean, events) = f.feed(input);
        assert!(clean.is_empty());
        assert_eq!(events.len(), 1);
        match &events[0] {
            OscEvent::ShellState { exit, cwd, cmd } => {
                assert_eq!(*exit, 0);
                assert_eq!(cwd, "/tmp");
                assert_eq!(cmd, "ls -la");
            }
            _ => panic!("expected ShellState"),
        }
    }

    #[test]
    fn passthrough_non_intercepted_osc() {
        let mut f = OscFilter::new();
        // OSC 2 (window title) should pass through
        let input = b"\x1b]2;My Title\x07";
        let (clean, events) = f.feed(input);
        assert_eq!(clean, b"\x1b]2;My Title\x07");
        assert!(events.is_empty());
    }

    #[test]
    fn cross_boundary_osc() {
        let mut f = OscFilter::new();
        // Split OSC 7768 across two reads
        let (clean1, events1) = f.feed(b"before\x1b]7768;0;/ho");
        let (clean2, events2) = f.feed(b"me;pwd\x07after");
        assert_eq!(clean1, b"before");
        assert!(events1.is_empty());
        assert_eq!(clean2, b"after");
        assert_eq!(events2.len(), 1);
        match &events2[0] {
            OscEvent::ShellState { cwd, cmd, .. } => {
                assert_eq!(cwd, "/home");
                assert_eq!(cmd, "pwd");
            }
            _ => panic!("expected ShellState"),
        }
    }

    #[test]
    fn st_terminator() {
        let mut f = OscFilter::new();
        // OSC terminated with ESC \ instead of BEL
        let input = b"\x1b]7;file://h/tmp\x1b\\rest";
        let (clean, events) = f.feed(input);
        assert_eq!(clean, b"rest");
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn mixed_osc_and_text() {
        let mut f = OscFilter::new();
        let input = b"A\x1b]7;file://h/a\x07B\x1b]2;title\x07C\x1b]7768;1;/b;echo\x07D";
        let (clean, events) = f.feed(input);
        // A + B + passthrough OSC 2 + C + D
        assert_eq!(clean, b"AB\x1b]2;title\x07CD");
        assert_eq!(events.len(), 2); // OSC 7 + OSC 7768
    }

    #[test]
    fn esc_not_osc() {
        let mut f = OscFilter::new();
        // ESC [ is CSI, not OSC — should pass through
        let input = b"\x1b[1;32mgreen\x1b[0m";
        let (clean, events) = f.feed(input);
        assert_eq!(clean, input.as_slice());
        assert!(events.is_empty());
    }

    #[test]
    fn osc9_progress() {
        let mut f = OscFilter::new();
        let input = b"\x1b]9;4;1;75\x07";
        let (clean, events) = f.feed(input);
        assert!(clean.is_empty());
        match &events[0] {
            OscEvent::Progress { state, percent } => {
                assert_eq!(*state, 1);
                assert_eq!(*percent, 75);
            }
            _ => panic!("expected Progress"),
        }
    }

    #[test]
    fn osc777_notify() {
        let mut f = OscFilter::new();
        let input = b"\x1b]777;notify;Build;Done!\x07";
        let (clean, events) = f.feed(input);
        assert!(clean.is_empty());
        match &events[0] {
            OscEvent::Notify { title, body } => {
                assert_eq!(title, "Build");
                assert_eq!(body, "Done!");
            }
            _ => panic!("expected Notify"),
        }
    }
}
