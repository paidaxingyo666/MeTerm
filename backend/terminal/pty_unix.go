//go:build !windows
// +build !windows

package terminal

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

// PTYEngine manages a PTY and its shell subprocess.
type PTYEngine struct {
	ptmx   *os.File
	cmd    *exec.Cmd
	done   chan struct{}
	mu     sync.Mutex
	closed bool
}

var _ Terminal = (*PTYEngine)(nil)

// NewPTYEngine creates a PTY-backed shell using terminal size cols x rows.
func NewPTYEngine(cols, rows uint16) (*PTYEngine, error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/bash"
	}

	// On macOS, GUI apps inherit minimal PATH from launchd, so we need a
	// login shell to source .zprofile and pick up Homebrew/fnm/pyenv paths.
	// However, launching directly with "-l" and TERM=xterm-256color causes
	// zsh plugin managers (zinit, oh-my-zsh, etc.) to output ANSI color
	// codes during init.  When those colors appear inside process
	// substitutions (source <(…)), zsh interprets the escape-bracket
	// sequences as glob patterns, producing "bad pattern" errors.
	//
	// Fix: start the login shell with TERM=dumb so the profile phase is
	// color-free, then exec into an interactive shell with the real TERM.
	// The login (non-interactive) phase sources zshenv + zprofile (PATH);
	// the exec'd interactive shell sources zshenv + zshrc (plugins) — each
	// file is sourced exactly once, matching normal terminal behaviour.
	var cmd *exec.Cmd
	if runtime.GOOS == "darwin" {
		innerCmd := fmt.Sprintf("export TERM=xterm-256color; exec %s -i", shell)
		cmd = exec.Command(shell, "-l", "-c", innerCmd)
	} else {
		cmd = exec.Command(shell)
	}

	// Build env: filter out any existing TERM, then set appropriately.
	env := make([]string, 0, len(os.Environ())+1)
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "TERM=") {
			env = append(env, e)
		}
	}
	if runtime.GOOS == "darwin" {
		// Login-phase sees TERM=dumb; the exec'd shell overrides to xterm-256color.
		env = append(env, "TERM=dumb")
	} else {
		env = append(env, "TERM=xterm-256color")
	}
	cmd.Env = env
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: rows, Cols: cols})
	if err != nil {
		return nil, err
	}

	engine := &PTYEngine{
		ptmx: ptmx,
		cmd:  cmd,
		done: make(chan struct{}),
	}

	go func() {
		defer close(engine.done)
		_ = engine.cmd.Wait()
	}()

	return engine, nil
}

// Read reads PTY output.
func (e *PTYEngine) Read(buf []byte) (int, error) {
	return e.ptmx.Read(buf)
}

// Write writes input to PTY.
func (e *PTYEngine) Write(data []byte) (int, error) {
	return e.ptmx.Write(data)
}

// Resize updates terminal dimensions and signals the process group.
func (e *PTYEngine) Resize(cols, rows uint16) error {
	if err := pty.Setsize(e.ptmx, &pty.Winsize{Rows: rows, Cols: cols}); err != nil {
		return err
	}
	// Send SIGWINCH to the foreground process group
	if e.cmd.Process != nil {
		// Get the process group ID and send SIGWINCH
		if pgid, err := syscall.Getpgid(e.cmd.Process.Pid); err == nil {
			_ = syscall.Kill(-pgid, syscall.SIGWINCH)
		} else {
			// Fallback: send to the process directly
			_ = e.cmd.Process.Signal(syscall.SIGWINCH)
		}
	}
	return nil
}

// Done returns a channel that closes when the shell exits.
func (e *PTYEngine) Done() <-chan struct{} {
	return e.done
}

// Close gracefully stops the shell: SIGHUP, then SIGKILL after timeout.
func (e *PTYEngine) Close() error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.closed {
		return nil
	}
	e.closed = true

	if e.cmd.Process != nil {
		_ = e.cmd.Process.Signal(syscall.SIGHUP)
	}

	select {
	case <-e.done:
	case <-time.After(5 * time.Second):
		if e.cmd.Process != nil {
			_ = e.cmd.Process.Signal(syscall.SIGKILL)
		}
		<-e.done
	}

	return e.ptmx.Close()
}
