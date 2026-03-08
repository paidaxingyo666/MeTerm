package executor

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"sync"

	"github.com/paidaxingyo666/meterm/terminal"
)

type LocalShellExecutor struct {
	cols uint16
	rows uint16

	shell string
	term  terminal.Terminal

	mu      sync.Mutex
	started bool
}

var _ Executor = (*LocalShellExecutor)(nil)

func NewLocalShellExecutor(cols, rows uint16) *LocalShellExecutor {
	return NewLocalShellExecutorWithShell(cols, rows, "")
}

func NewLocalShellExecutorWithShell(cols, rows uint16, shell string) *LocalShellExecutor {
	if shell == "" {
		shell = os.Getenv("SHELL")
	}
	if shell == "" {
		if runtime.GOOS == "windows" {
			// On Windows, prefer PowerShell over cmd.exe.
			// resolveWindowsShell() in pty_windows.go handles the full
			// priority chain (METERM_WINDOWS_SHELL → pwsh → powershell → cmd).
			// Here we just need a reasonable default for the executor field;
			// the actual resolution happens in PTYEngine. Pass empty to let
			// PTYEngine's resolveWindowsShell() decide.
			shell = ""
		} else {
			shell = "/bin/bash"
		}
	}

	return &LocalShellExecutor{
		cols:  cols,
		rows:  rows,
		shell: shell,
	}
}

func (e *LocalShellExecutor) Start() (terminal.Terminal, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.started {
		return nil, fmt.Errorf("executor already started")
	}

	term, err := terminal.NewPTYEngineWithShell(e.cols, e.rows, e.shell)
	if err != nil {
		return nil, err
	}

	e.term = term
	e.started = true
	return term, nil
}

func (e *LocalShellExecutor) Stop() error {
	e.mu.Lock()
	term := e.term
	if !e.started {
		e.mu.Unlock()
		return nil
	}
	e.started = false
	e.term = nil
	e.mu.Unlock()

	if term != nil {
		return term.Close()
	}
	return nil
}

func (e *LocalShellExecutor) Info() ExecutorInfo {
	e.mu.Lock()
	defer e.mu.Unlock()

	return ExecutorInfo{
		Type: "local-shell",
		Labels: map[string]string{
			"shell": e.shell,
			"cols":  strconv.FormatUint(uint64(e.cols), 10),
			"rows":  strconv.FormatUint(uint64(e.rows), 10),
		},
	}
}
