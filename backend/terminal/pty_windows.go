//go:build windows
// +build windows

package terminal

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/paidaxingyo666/meterm/internal/conpty"
)

// PTYEngine manages a ConPTY-backed shell subprocess on Windows.
type PTYEngine struct {
	cpty     *conpty.ConPty
	childPid int // child process PID

	done chan struct{}

	mu     sync.Mutex
	closed bool

	// mouseMode is 1 when the child has enabled mouse tracking (DECSET
	// ?1000h / ?1002h / ?1003h detected in output), 0 otherwise.
	// Updated by Read() scanning ConPTY output — no AttachConsole needed.
	mouseMode int32
}

var _ Terminal = (*PTYEngine)(nil)

// NewPTYEngine creates a ConPTY-backed shell using terminal size cols x rows.
func NewPTYEngine(cols, rows uint16) (*PTYEngine, error) {
	return NewPTYEngineWithShell(cols, rows, "")
}

// NewPTYEngineWithShell creates a ConPTY-backed shell with an explicit shell path.
// If shell is empty, falls back to resolveWindowsShell().
func NewPTYEngineWithShell(cols, rows uint16, shell string) (*PTYEngine, error) {
	var shellPath string
	var shellArgs []string
	var err error
	var commandLine string
	if shell != "" {
		// Shell may be a simple exe ("powershell.exe") or a complex command
		// line from Windows Terminal fragments ("cmd.exe /k \"...\\VsDevCmd.bat\"").
		// For complex command lines (containing quotes or /k), pass directly
		// to ConPTY without splitting — CreateProcess handles parsing natively.
		if strings.ContainsAny(shell, "\"'") || strings.Contains(strings.ToLower(shell), " /k ") {
			commandLine = shell
			shellPath = strings.Fields(shell)[0]
		} else {
			parts := strings.Fields(shell)
			shellPath = parts[0]
			extraArgs := parts[1:]
			base := strings.ToLower(filepath.Base(shellPath))
			switch {
			case base == "pwsh.exe" || base == "powershell.exe":
				shellArgs = append(extraArgs, "-NoLogo", "-NoExit")
			case base == "cmd.exe":
				shellArgs = append(extraArgs, "/Q")
			default:
				shellArgs = extraArgs
			}
			cmdParts := append([]string{shellPath}, shellArgs...)
			commandLine = buildCommandLine(cmdParts)
		}
	} else {
		shellPath, shellArgs, err = resolveWindowsShell()
		if err != nil {
			return nil, err
		}
		cmdParts := append([]string{shellPath}, shellArgs...)
		commandLine = buildCommandLine(cmdParts)
	}

	var workDir string
	if home, homeErr := os.UserHomeDir(); homeErr == nil && home != "" {
		workDir = home
	}

	opts := []conpty.Option{
		conpty.Dimensions(int(cols), int(rows)),
	}
	if workDir != "" {
		opts = append(opts, conpty.WorkDir(workDir))
	}

	cpty, err := conpty.Start(commandLine, opts...)
	if err != nil {
		return nil, fmt.Errorf("conpty start (%s): %w", shellPath, err)
	}
	log.Printf("[conpty] NewPTYEngine: shell=%s args=%v cols=%d rows=%d bundled=%v PID=%d", shellPath, shellArgs, cols, rows, conpty.UsingBundled, cpty.Pid())

	engine := &PTYEngine{
		cpty:     cpty,
		childPid: cpty.Pid(),
		done:     make(chan struct{}),
	}

	go func() {
		defer close(engine.done)
		exitCode, waitErr := cpty.Wait(context.Background())
		if waitErr != nil {
			log.Printf("[conpty] wait error: %v", waitErr)
		}
		log.Printf("[conpty] process exited (PID=%d) exitCode=%d", cpty.Pid(), exitCode)
	}()

	return engine, nil
}

func buildCommandLine(parts []string) string {
	if len(parts) == 0 {
		return ""
	}
	line := parts[0]
	for _, arg := range parts[1:] {
		line += " " + arg
	}
	return line
}

func resolveWindowsShell() (string, []string, error) {
	if s := os.Getenv("METERM_WINDOWS_SHELL"); s != "" {
		if path, err := exec.LookPath(s); err == nil {
			return path, nil, nil
		}
		return s, nil, nil
	}

	type candidate struct {
		exe  string
		args []string
	}
	for _, c := range []candidate{
		{exe: "pwsh.exe", args: []string{"-NoLogo", "-NoExit"}},
		{exe: "powershell.exe", args: []string{"-NoLogo", "-NoExit"}},
		{exe: "cmd.exe", args: []string{"/Q"}},
	} {
		if path, err := exec.LookPath(c.exe); err == nil {
			return path, c.args, nil
		}
	}

	if comspec := os.Getenv("COMSPEC"); comspec != "" {
		return comspec, nil, nil
	}

	return "", nil, fmt.Errorf("no Windows shell found (tried pwsh.exe, powershell.exe, cmd.exe)")
}

func (e *PTYEngine) Read(buf []byte) (int, error) {
	n, err := e.cpty.Read(buf)
	if n > 0 {
		// Scan output for DECSET/DECRST mouse sequences to track mouse mode.
		// If the scan detects mouse mode was disabled via alternate screen
		// exit (ConPTY swallowed the explicit DECRST), append the disable
		// sequences so the frontend (xterm.js) also exits mouse capture.
		if e.scanMouseMode(buf[:n]) {
			extra := mouseDisableSeq
			if n+len(extra) <= len(buf) {
				copy(buf[n:n+len(extra)], extra)
				n += len(extra)
			}
		}
	}
	if err != nil {
		log.Printf("[conpty] Read error (PID=%d): %v (n=%d)", e.childPid, err, n)
	}
	return n, err
}

// Write writes input to PTY. Mouse sequences are separated from regular
// input. Regular input is always written to the ConPTY pipe. Mouse sequences
// are only written when the child has enabled mouse tracking (detected via
// DECSET in output). Outside mouse mode, mouse sequences are dropped to
// prevent raw-text leakage.
func (e *PTYEngine) Write(data []byte) (int, error) {
	// Fast path: no ESC byte means no mouse sequences.
	if bytes.IndexByte(data, 0x1b) == -1 {
		return e.cpty.Write(data)
	}

	regular, mouseRaw := splitMouseRaw(data)

	// Always write regular (non-mouse) input.
	if len(regular) > 0 {
		if _, err := e.cpty.Write(regular); err != nil {
			return 0, err
		}
	}

	// Write mouse sequences only if mouse mode is active.
	if len(mouseRaw) > 0 && e.isMouseModeActive() {
		e.cpty.Write(mouseRaw) //nolint:errcheck
	}

	return len(data), nil
}

func (e *PTYEngine) Resize(cols, rows uint16) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return os.ErrClosed
	}
	return e.cpty.Resize(int(cols), int(rows))
}

func (e *PTYEngine) Done() <-chan struct{} {
	return e.done
}

func (e *PTYEngine) Close() error {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return nil
	}
	e.closed = true
	cpty := e.cpty
	e.mu.Unlock()

	if cpty != nil {
		_ = cpty.Close()
	}

	select {
	case <-e.done:
	case <-time.After(5 * time.Second):
	}

	return nil
}
