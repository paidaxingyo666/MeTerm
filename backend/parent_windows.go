//go:build windows
// +build windows

package main

import "golang.org/x/sys/windows"

func parentProcessAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)

	event, waitErr := windows.WaitForSingleObject(h, 0)
	if waitErr != nil {
		return false
	}
	return event == uint32(windows.WAIT_TIMEOUT)
}
