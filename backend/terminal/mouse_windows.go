//go:build windows
// +build windows

package terminal

import (
	"bytes"
	"log"
	"sync/atomic"
)

// ---------------------------------------------------------------------------
// Mouse mode detection via VT output sequences
// ---------------------------------------------------------------------------

// DECSET/DECRST sequences that TUI apps use to enable/disable mouse tracking.
// We scan ConPTY output for these to detect when mouse passthrough is safe.
var (
	// DECSET mouse enable sequences (any of these means mouse mode is on)
	mouseEnablePatterns = [][]byte{
		[]byte("\x1b[?1000h"), // X10 mouse
		[]byte("\x1b[?1002h"), // button-event tracking
		[]byte("\x1b[?1003h"), // any-event tracking
	}

	// DECRST mouse disable sequences (last one seen means mouse mode is off)
	mouseDisablePatterns = [][]byte{
		[]byte("\x1b[?1000l"),
		[]byte("\x1b[?1002l"),
		[]byte("\x1b[?1003l"),
	}
)

// mouseDisableSeq is sent to the frontend when mouse mode is disabled but
// ConPTY swallowed the DECRST sequences. xterm.js needs these to exit mouse
// capture and allow normal text selection.
var mouseDisableSeq = []byte("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l")

// scanMouseMode scans output data for DECSET/DECRST mouse sequences and
// updates the engine's mouse mode state. Returns true if mouse mode
// transitioned from enabled to disabled (caller should append mouseDisableSeq
// to ensure the frontend also exits mouse mode).
func (e *PTYEngine) scanMouseMode(data []byte) (disabledNow bool) {
	if bytes.IndexByte(data, 0x1b) == -1 {
		return
	}

	wasMouseMode := atomic.LoadInt32(&e.mouseMode) != 0

	for _, pat := range mouseEnablePatterns {
		if bytes.Contains(data, pat) {
			if atomic.CompareAndSwapInt32(&e.mouseMode, 0, 1) {
				log.Printf("[conpty] mouse mode enabled (detected DECSET in output, PID=%d)", e.childPid)
			}
			return // enable takes priority if both found in same chunk
		}
	}

	for _, pat := range mouseDisablePatterns {
		if bytes.Contains(data, pat) {
			if atomic.CompareAndSwapInt32(&e.mouseMode, 1, 0) {
				log.Printf("[conpty] mouse mode disabled (detected DECRST in output, PID=%d)", e.childPid)
			}
			// Explicit DECRST found in output — ConPTY passed it through,
			// so the frontend will see it. No injection needed.
			return false
		}
	}

	// Alternate screen exit (DECRST 1049 / DECRC) without explicit mouse
	// disable — ConPTY swallowed the mouse DECRST sequences. Signal the
	// caller to inject them so xterm.js exits mouse capture mode.
	if wasMouseMode && bytes.Contains(data, []byte("\x1b[?1049l")) {
		if atomic.CompareAndSwapInt32(&e.mouseMode, 1, 0) {
			log.Printf("[conpty] mouse mode disabled (alternate screen exit, PID=%d) — will inject DECRST", e.childPid)
			return true
		}
	}
	return false
}

// isMouseModeActive returns true if the child is in mouse tracking mode.
func (e *PTYEngine) isMouseModeActive() bool {
	return atomic.LoadInt32(&e.mouseMode) != 0
}

// ---------------------------------------------------------------------------
// SGR mouse sequence parser
// ---------------------------------------------------------------------------

type sgrMouseEvent struct {
	button    int
	x, y      int
	isRelease bool
}

// splitMouseRaw separates SGR/X10 mouse sequences from regular input,
// returning raw bytes for both (no parsing into structs).
func splitMouseRaw(data []byte) (regular []byte, mouseRaw []byte) {
	if bytes.IndexByte(data, 0x1b) == -1 {
		return data, nil
	}

	i := 0
	for i < len(data) {
		if data[i] == 0x1b && i+2 < len(data) && data[i+1] == '[' && data[i+2] == '<' {
			_, consumed := parseSGRMouseAt(data, i)
			if consumed > 0 {
				mouseRaw = append(mouseRaw, data[i:i+consumed]...)
				i += consumed
				continue
			}
		}
		if data[i] == 0x1b && i+5 < len(data) && data[i+1] == '[' && data[i+2] == 'M' {
			mouseRaw = append(mouseRaw, data[i:i+6]...)
			i += 6
			continue
		}
		regular = append(regular, data[i])
		i++
	}
	return regular, mouseRaw
}

func parseSGRMouseAt(data []byte, pos int) (sgrMouseEvent, int) {
	if pos+8 > len(data) {
		return sgrMouseEvent{}, 0
	}
	i := pos + 3
	limit := len(data)
	if limit > pos+32 {
		limit = pos + 32
	}
	nums := [3]int{}
	numIdx := 0
	start := i
	for i < limit {
		ch := data[i]
		if ch >= '0' && ch <= '9' {
			i++
			continue
		}
		if ch == ';' && numIdx < 2 {
			nums[numIdx] = atoiBytes(data[start:i])
			numIdx++
			i++
			start = i
			continue
		}
		if (ch == 'M' || ch == 'm') && numIdx == 2 {
			nums[2] = atoiBytes(data[start:i])
			return sgrMouseEvent{
				button:    nums[0],
				x:         nums[1],
				y:         nums[2],
				isRelease: ch == 'm',
			}, i + 1 - pos
		}
		return sgrMouseEvent{}, 0
	}
	return sgrMouseEvent{}, 0
}

func atoiBytes(b []byte) int {
	n := 0
	for _, ch := range b {
		n = n*10 + int(ch-'0')
	}
	return n
}
