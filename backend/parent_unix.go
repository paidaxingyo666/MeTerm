//go:build !windows
// +build !windows

package main

import (
	"errors"
	"syscall"
)

func parentProcessAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
