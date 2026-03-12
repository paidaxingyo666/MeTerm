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
	cwd   string
	term  terminal.Terminal

	mu      sync.Mutex
	started bool
}

var _ Executor = (*LocalShellExecutor)(nil)

func NewLocalShellExecutor(cols, rows uint16) *LocalShellExecutor {
	return NewLocalShellExecutorWithShell(cols, rows, "")
}

func NewLocalShellExecutorWithShell(cols, rows uint16, shell string) *LocalShellExecutor {
	return NewLocalShellExecutorWithCwd(cols, rows, shell, "")
}

// NewLocalShellExecutorWithCwd creates a local shell executor with explicit shell and working directory.
func NewLocalShellExecutorWithCwd(cols, rows uint16, shell, cwd string) *LocalShellExecutor {
	if shell == "" {
		shell = os.Getenv("SHELL")
	}
	if shell == "" {
		if runtime.GOOS == "windows" {
			shell = ""
		} else {
			shell = "/bin/bash"
		}
	}

	return &LocalShellExecutor{
		cols:  cols,
		rows:  rows,
		shell: shell,
		cwd:   cwd,
	}
}

func (e *LocalShellExecutor) Start() (terminal.Terminal, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.started {
		return nil, fmt.Errorf("executor already started")
	}

	term, err := terminal.NewPTYEngineWithShellAndCwd(e.cols, e.rows, e.shell, e.cwd)
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
