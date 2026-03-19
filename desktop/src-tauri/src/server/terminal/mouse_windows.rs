//! Windows mouse tracking — mirrors Go `terminal/mouse_windows.go`.
//!
//! Scans ConPTY output for DECSET/DECRST mouse mode sequences and tracks
//! whether mouse mode is active. When mouse mode is disabled via alternate
//! screen exit (ConPTY swallows the explicit DECRST), appends disable
//! sequences so the frontend also exits mouse capture.

/// Mouse mode disable sequence: DECRST ?1000, ?1002, ?1003, ?1006
pub const MOUSE_DISABLE_SEQ: &[u8] = b"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";

/// DECSET patterns that enable mouse tracking.
const MOUSE_ENABLE_PATTERNS: &[&[u8]] = &[
    b"\x1b[?1000h", // Basic mouse tracking
    b"\x1b[?1002h", // Button event tracking
    b"\x1b[?1003h", // Any event tracking
];

/// DECRST patterns that disable mouse tracking.
const MOUSE_DISABLE_PATTERNS: &[&[u8]] = &[
    b"\x1b[?1000l",
    b"\x1b[?1002l",
    b"\x1b[?1003l",
];

/// Alternate screen exit (may not have explicit mouse disable).
const ALT_SCREEN_EXIT: &[u8] = b"\x1b[?1049l";

/// Scan output buffer for mouse mode changes.
/// Returns true if mouse mode was disabled via alternate screen exit
/// (caller should inject MOUSE_DISABLE_SEQ).
pub fn scan_mouse_mode(data: &[u8], mouse_mode_active: &mut bool) -> bool {
    let mut inject_disable = false;

    // Check for mouse enable
    for pattern in MOUSE_ENABLE_PATTERNS {
        if contains_bytes(data, pattern) {
            *mouse_mode_active = true;
        }
    }

    // Check for mouse disable
    for pattern in MOUSE_DISABLE_PATTERNS {
        if contains_bytes(data, pattern) {
            *mouse_mode_active = false;
        }
    }

    // Check for alternate screen exit when mouse was active
    if *mouse_mode_active && contains_bytes(data, ALT_SCREEN_EXIT) {
        *mouse_mode_active = false;
        inject_disable = true;
    }

    inject_disable
}

/// Split input data into regular (non-mouse) and mouse sequences.
/// Mouse sequences are SGR format: ESC [ < Ps ; Px ; Py M/m
pub fn split_mouse_raw(data: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let mut regular = Vec::new();
    let mut mouse = Vec::new();
    let mut i = 0;

    while i < data.len() {
        if data[i] == 0x1b && i + 2 < data.len() && data[i + 1] == b'[' && data[i + 2] == b'<' {
            // Start of SGR mouse sequence: ESC [ < ... M or ESC [ < ... m
            let start = i;
            i += 3;
            while i < data.len() && data[i] != b'M' && data[i] != b'm' {
                i += 1;
            }
            if i < data.len() {
                i += 1; // include the M/m
                mouse.extend_from_slice(&data[start..i]);
            }
        } else {
            regular.push(data[i]);
            i += 1;
        }
    }

    (regular, mouse)
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_mouse_enable_disable() {
        let mut active = false;
        let data = b"\x1b[?1000h some output";
        assert!(!scan_mouse_mode(data, &mut active));
        assert!(active);

        let data2 = b"\x1b[?1000l";
        assert!(!scan_mouse_mode(data2, &mut active));
        assert!(!active);
    }

    #[test]
    fn test_scan_alt_screen_exit() {
        let mut active = true;
        let data = b"\x1b[?1049l";
        assert!(scan_mouse_mode(data, &mut active));
        assert!(!active);
    }

    #[test]
    fn test_split_mouse_raw() {
        let data = b"hello\x1b[<0;10;20Mworld";
        let (regular, mouse) = split_mouse_raw(data);
        assert_eq!(regular, b"helloworld");
        assert_eq!(mouse, b"\x1b[<0;10;20M");
    }
}
