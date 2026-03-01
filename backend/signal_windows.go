//go:build windows
// +build windows

package main

import (
	"os"
	"os/signal"
)

func registerTerminationSignals(ch chan<- os.Signal) {
	signal.Notify(ch, os.Interrupt)
}
