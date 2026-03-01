package executor

import (
	"fmt"
	"strconv"
	"sync"

	"github.com/paidaxingyo666/meterm/terminal"
)

// SSHExecutor creates an SSH-backed terminal session.
type SSHExecutor struct {
	config terminal.SSHConfig
	cols   uint16
	rows   uint16
	term   terminal.Terminal

	mu      sync.Mutex
	started bool
}

var _ Executor = (*SSHExecutor)(nil)

// NewSSHExecutor creates a new SSH executor with the given config.
func NewSSHExecutor(cfg terminal.SSHConfig, cols, rows uint16) *SSHExecutor {
	if cfg.Port == 0 {
		cfg.Port = 22
	}
	return &SSHExecutor{
		config: cfg,
		cols:   cols,
		rows:   rows,
	}
}

func (e *SSHExecutor) Start() (terminal.Terminal, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.started {
		return nil, fmt.Errorf("executor already started")
	}

	term, err := terminal.NewSSHTerminal(e.config, e.cols, e.rows)
	if err != nil {
		return nil, err
	}

	e.term = term
	e.started = true
	return term, nil
}

func (e *SSHExecutor) Stop() error {
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

func (e *SSHExecutor) Info() ExecutorInfo {
	e.mu.Lock()
	defer e.mu.Unlock()

	return ExecutorInfo{
		Type: "ssh",
		Labels: map[string]string{
			"host":     e.config.Host,
			"port":     strconv.FormatUint(uint64(e.config.Port), 10),
			"username": e.config.Username,
			"auth":     e.config.AuthMethod,
			"cols":     strconv.FormatUint(uint64(e.cols), 10),
			"rows":     strconv.FormatUint(uint64(e.rows), 10),
		},
	}
}
