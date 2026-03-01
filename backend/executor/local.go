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
	shell := os.Getenv("SHELL")
	if shell == "" {
		if runtime.GOOS == "windows" {
			if c := os.Getenv("COMSPEC"); c != "" {
				shell = c
			} else {
				shell = "powershell.exe"
			}
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

	term, err := terminal.NewPTYEngine(e.cols, e.rows)
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
