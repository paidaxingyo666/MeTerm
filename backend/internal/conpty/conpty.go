//go:build windows
// +build windows

// Package conpty provides a Go wrapper around Windows ConPTY (Pseudo Console).
//
// It prefers a bundled conpty.dll + OpenConsole.exe (from the Microsoft
// Terminal project) for modern ConPTY features (mouse passthrough, correct
// resize behaviour). If the bundled DLL is not found, it falls back to the
// inbox kernel32.dll implementation.
package conpty

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ---------------------------------------------------------------------------
// DLL / proc initialisation
// ---------------------------------------------------------------------------

var (
	initOnce sync.Once

	conptyDLL *windows.LazyDLL

	procCreatePseudoConsole               *windows.LazyProc
	procResizePseudoConsole               *windows.LazyProc
	procClosePseudoConsole                *windows.LazyProc
	procInitializeProcThreadAttributeList *windows.LazyProc
	procUpdateProcThreadAttribute         *windows.LazyProc

	// UsingBundled reports whether we loaded the bundled conpty.dll.
	UsingBundled bool
)

func ensureInit() {
	initOnce.Do(func() {
		// Default to bundled conpty.dll + OpenConsole.exe from the Windows
		// Terminal project. The bundled conpty.dll's CreatePseudoConsole
		// looks for OpenConsole.exe in its own directory (via
		// GetModuleFileName) and uses it as the console host instead of
		// the system conhost.exe. OpenConsole contains bug fixes for
		// Win10 issues (TUI exit killing the shell, resize phantoms, etc.)
		// that have NOT been backported to the inbox conhost.
		//
		// If OpenConsole.exe is missing, conpty.dll falls back to the
		// system conhost.exe, which has the Win10 bugs.
		//
		// Set METERM_CONPTY=inbox to force the system kernel32.dll.
		useInbox := os.Getenv("METERM_CONPTY") == "inbox"

		if !useInbox {
			if exe, err := os.Executable(); err == nil {
				exeDir := filepath.Dir(exe)
				dllPath := filepath.Join(exeDir, "conpty.dll")
				if _, statErr := os.Stat(dllPath); statErr == nil {
					candidate := windows.NewLazyDLL(dllPath)
					if p := candidate.NewProc("CreatePseudoConsole"); p.Find() == nil {
						conptyDLL = candidate
						UsingBundled = true
						log.Printf("[conpty] using bundled conpty.dll: %s", dllPath)
					}
				}
			}
			if conptyDLL == nil {
				log.Printf("[conpty] bundled conpty.dll not found, falling back to kernel32")
			}
		} else {
			log.Printf("[conpty] METERM_CONPTY=inbox — forced system kernel32.dll")
		}

		if conptyDLL == nil {
			conptyDLL = windows.NewLazySystemDLL("kernel32.dll")
			if !useInbox {
				log.Printf("[conpty] using system kernel32.dll (inbox ConPTY)")
			}
		}

		procCreatePseudoConsole = conptyDLL.NewProc("CreatePseudoConsole")
		procResizePseudoConsole = conptyDLL.NewProc("ResizePseudoConsole")
		procClosePseudoConsole = conptyDLL.NewProc("ClosePseudoConsole")

		// These are always from kernel32.
		k32 := windows.NewLazySystemDLL("kernel32.dll")
		procInitializeProcThreadAttributeList = k32.NewProc("InitializeProcThreadAttributeList")
		procUpdateProcThreadAttribute = k32.NewProc("UpdateProcThreadAttribute")
	})
}

// IsAvailable returns true if CreatePseudoConsole can be called.
func IsAvailable() bool {
	ensureInit()
	return procCreatePseudoConsole.Find() == nil &&
		procResizePseudoConsole.Find() == nil &&
		procClosePseudoConsole.Find() == nil
}

// ---------------------------------------------------------------------------
// Low-level types
// ---------------------------------------------------------------------------

const (
	_STILL_ACTIVE                        uint32  = 259
	_S_OK                                uintptr = 0
	_PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE uintptr = 0x20016
	defaultWidth                                 = 80
	defaultHeight                                = 40
)

type coord struct {
	X, Y int16
}

func (c *coord) pack() uintptr {
	return uintptr((int32(c.Y) << 16) | int32(c.X))
}

type hpcon windows.Handle

// handleIO wraps a raw Windows pipe handle for Read/Write.
type handleIO struct {
	handle windows.Handle
}

func (h *handleIO) Read(p []byte) (int, error) {
	var n uint32
	err := windows.ReadFile(h.handle, p, &n, nil)
	return int(n), err
}

func (h *handleIO) Write(p []byte) (int, error) {
	var n uint32
	err := windows.WriteFile(h.handle, p, &n, nil)
	return int(n), err
}

func (h *handleIO) Close() error {
	return windows.CloseHandle(h.handle)
}

// ---------------------------------------------------------------------------
// ConPty – public API
// ---------------------------------------------------------------------------

// ConPty holds a pseudo-console session.
type ConPty struct {
	hpc                          hpcon
	pi                           *windows.ProcessInformation
	ptyIn, ptyOut, cmdIn, cmdOut *handleIO
}

// Option configures a ConPty session.
type Option func(*args)

type args struct {
	coords  coord
	workDir string
	env     []string
}

// Dimensions sets the initial terminal size.
func Dimensions(width, height int) Option {
	return func(a *args) { a.coords = coord{int16(width), int16(height)} }
}

// WorkDir sets the working directory for the child process.
func WorkDir(dir string) Option {
	return func(a *args) { a.workDir = dir }
}

// Env sets explicit environment variables for the child process.
func Env(env []string) Option {
	return func(a *args) { a.env = env }
}

// Start creates a ConPTY pseudo-console and launches commandLine inside it.
func Start(commandLine string, opts ...Option) (*ConPty, error) {
	ensureInit()
	if !IsAvailable() {
		return nil, fmt.Errorf("ConPTY is not available on this Windows version")
	}

	a := &args{coords: coord{defaultWidth, defaultHeight}}
	for _, o := range opts {
		o(a)
	}

	var cmdIn, cmdOut, ptyIn, ptyOut windows.Handle
	if err := windows.CreatePipe(&ptyIn, &cmdIn, nil, 0); err != nil {
		return nil, fmt.Errorf("CreatePipe: %w", err)
	}
	if err := windows.CreatePipe(&cmdOut, &ptyOut, nil, 0); err != nil {
		closeHandles(ptyIn, cmdIn)
		return nil, fmt.Errorf("CreatePipe: %w", err)
	}

	hpc, err := createPseudoConsole(&a.coords, ptyIn, ptyOut)
	if err != nil {
		closeHandles(ptyIn, ptyOut, cmdIn, cmdOut)
		return nil, err
	}

	pi, err := createProcess(hpc, commandLine, a.workDir, a.env)
	if err != nil {
		closeHandles(ptyIn, ptyOut, cmdIn, cmdOut)
		closePseudoConsole(hpc)
		return nil, fmt.Errorf("create process: %w", err)
	}

	return &ConPty{
		hpc:    hpc,
		pi:     pi,
		ptyIn:  &handleIO{ptyIn},
		ptyOut: &handleIO{ptyOut},
		cmdIn:  &handleIO{cmdIn},
		cmdOut: &handleIO{cmdOut},
	}, nil
}

// Resize changes the pseudo-console dimensions.
func (c *ConPty) Resize(width, height int) error {
	co := coord{int16(width), int16(height)}
	return resizePseudoConsole(c.hpc, &co)
}

// Read reads output from the child process.
func (c *ConPty) Read(p []byte) (int, error) { return c.cmdOut.Read(p) }

// Write sends input to the child process.
func (c *ConPty) Write(p []byte) (int, error) { return c.cmdIn.Write(p) }

// Pid returns the child process ID.
func (c *ConPty) Pid() int { return int(c.pi.ProcessId) }

// Wait blocks until the child exits and returns its exit code.
func (c *ConPty) Wait(ctx context.Context) (uint32, error) {
	for {
		if err := ctx.Err(); err != nil {
			return _STILL_ACTIVE, fmt.Errorf("wait canceled: %w", err)
		}
		ret, _ := windows.WaitForSingleObject(c.pi.Process, 1000)
		switch ret {
		case uint32(windows.WAIT_TIMEOUT):
			continue
		case windows.WAIT_OBJECT_0:
			// Process exited normally.
			var code uint32
			err := windows.GetExitCodeProcess(c.pi.Process, &code)
			return code, err
		default:
			// WAIT_FAILED or WAIT_ABANDONED — verify via GetExitCodeProcess
			// before declaring the process dead. This prevents false
			// positives from transient handle states.
			var code uint32
			if err := windows.GetExitCodeProcess(c.pi.Process, &code); err != nil {
				return _STILL_ACTIVE, fmt.Errorf("WaitForSingleObject returned 0x%x and GetExitCodeProcess failed: %w", ret, err)
			}
			if code == _STILL_ACTIVE {
				// Process is still running — the wait was a false alarm.
				log.Printf("[conpty] WaitForSingleObject returned 0x%x but process still active (PID=%d), retrying", ret, c.pi.ProcessId)
				continue
			}
			return code, nil
		}
	}
}

// Close terminates the pseudo-console and releases all handles.
func (c *ConPty) Close() error {
	closePseudoConsole(c.hpc)
	return closeHandles(
		c.pi.Process,
		c.pi.Thread,
		c.ptyIn.handle,
		c.ptyOut.handle,
		c.cmdIn.handle,
		c.cmdOut.handle,
	)
}

// ---------------------------------------------------------------------------
// Win32 helpers
// ---------------------------------------------------------------------------

func createPseudoConsole(c *coord, hIn, hOut windows.Handle) (hpcon, error) {
	var hpc hpcon
	ret, _, _ := procCreatePseudoConsole.Call(
		c.pack(),
		uintptr(hIn),
		uintptr(hOut),
		0,
		uintptr(unsafe.Pointer(&hpc)),
	)
	if ret != _S_OK {
		return 0, fmt.Errorf("CreatePseudoConsole failed: 0x%x", ret)
	}
	return hpc, nil
}

func resizePseudoConsole(hpc hpcon, c *coord) error {
	ret, _, _ := procResizePseudoConsole.Call(uintptr(hpc), c.pack())
	if ret != _S_OK {
		return fmt.Errorf("ResizePseudoConsole failed: 0x%x", ret)
	}
	return nil
}

func closePseudoConsole(hpc hpcon) {
	if procClosePseudoConsole.Find() == nil {
		procClosePseudoConsole.Call(uintptr(hpc)) //nolint:errcheck
	}
}

type startupInfoEx struct {
	startupInfo   windows.StartupInfo
	attributeList []byte
}

func createProcess(hpc hpcon, commandLine, workDir string, env []string) (*windows.ProcessInformation, error) {
	cmdLine, err := windows.UTF16PtrFromString(commandLine)
	if err != nil {
		return nil, err
	}

	var currentDir *uint16
	if workDir != "" {
		currentDir, err = windows.UTF16PtrFromString(workDir)
		if err != nil {
			return nil, err
		}
	}

	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT)
	var envBlock *uint16
	if env != nil {
		flags |= uint32(windows.CREATE_UNICODE_ENVIRONMENT)
		envBlock = createEnvBlock(env)
	}

	siEx, err := getStartupInfoEx(hpc)
	if err != nil {
		return nil, err
	}

	var pi windows.ProcessInformation
	err = windows.CreateProcess(
		nil,
		cmdLine,
		nil,
		nil,
		false,
		flags,
		envBlock,
		currentDir,
		&siEx.startupInfo,
		&pi,
	)
	if err != nil {
		return nil, err
	}
	return &pi, nil
}

func getStartupInfoEx(hpc hpcon) (*startupInfoEx, error) {
	var siEx startupInfoEx
	siEx.startupInfo.Cb = uint32(unsafe.Sizeof(windows.StartupInfo{}) + unsafe.Sizeof(&siEx.attributeList[0]))
	siEx.startupInfo.Flags |= windows.STARTF_USESTDHANDLES

	var size uintptr
	procInitializeProcThreadAttributeList.Call(0, 1, 0, uintptr(unsafe.Pointer(&size))) //nolint:errcheck
	siEx.attributeList = make([]byte, size)

	ret, _, err := procInitializeProcThreadAttributeList.Call(
		uintptr(unsafe.Pointer(&siEx.attributeList[0])),
		1, 0,
		uintptr(unsafe.Pointer(&size)),
	)
	if ret != 1 {
		return nil, fmt.Errorf("InitializeProcThreadAttributeList: %v", err)
	}

	ret, _, err = procUpdateProcThreadAttribute.Call(
		uintptr(unsafe.Pointer(&siEx.attributeList[0])),
		0,
		_PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
		uintptr(hpc),
		unsafe.Sizeof(hpc),
		0, 0,
	)
	if ret != 1 {
		return nil, fmt.Errorf("UpdateProcThreadAttribute: %v", err)
	}
	return &siEx, nil
}

func closeHandles(handles ...windows.Handle) error {
	var first error
	for _, h := range handles {
		if h != windows.InvalidHandle && h != 0 {
			if err := windows.CloseHandle(h); err != nil && first == nil {
				first = err
			}
		}
	}
	return first
}

// createEnvBlock builds a Windows-compatible environment block.
func createEnvBlock(envv []string) *uint16 {
	if len(envv) == 0 {
		return &utf16.Encode([]rune("\x00\x00"))[0]
	}
	length := 0
	for _, s := range envv {
		length += len(s) + 1
	}
	length++

	b := make([]byte, length)
	i := 0
	for _, s := range envv {
		l := len(s)
		copy(b[i:i+l], s)
		b[i+l] = 0
		i += l + 1
	}
	b[i] = 0
	return &utf16.Encode([]rune(string(b)))[0]
}
