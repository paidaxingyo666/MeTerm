package executor

import "github.com/paidaxingyo666/meterm/terminal"

type Executor interface {
	Start() (terminal.Terminal, error)
	Stop() error
	Info() ExecutorInfo
}

type ExecutorInfo struct {
	Type   string
	Labels map[string]string
}
