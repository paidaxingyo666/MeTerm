//go:build !windows
// +build !windows

package terminal

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"

	"github.com/paidaxingyo666/meterm/internal/buildinfo"
)

// PTYEngine manages a PTY and its shell subprocess.
type PTYEngine struct {
	ptmx    *os.File
	cmd     *exec.Cmd
	done    chan struct{}
	mu      sync.Mutex
	closed  bool
	hookDir string // temp dir for shell hook files; cleaned up on Close()
}

var _ Terminal = (*PTYEngine)(nil)

// NewPTYEngine creates a PTY-backed shell using terminal size cols x rows.
func NewPTYEngine(cols, rows uint16) (Terminal, error) {
	return NewPTYEngineWithShell(cols, rows, "")
}

// NewPTYEngineWithShell creates a PTY-backed shell with an explicit shell path.
// If shell is empty, falls back to $SHELL or /bin/bash.
func NewPTYEngineWithShell(cols, rows uint16, shell string) (Terminal, error) {
	return NewPTYEngineWithShellAndCwd(cols, rows, shell, "")
}

// NewPTYEngineWithShellAndCwd creates a PTY-backed shell with explicit shell path and working directory.
// If cwd is empty, falls back to user home directory.
func NewPTYEngineWithShellAndCwd(cols, rows uint16, shell, cwd string) (Terminal, error) {
	if shell == "" {
		shell = os.Getenv("SHELL")
	}
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
	shellBase := filepath.Base(shell)
	if runtime.GOOS == "darwin" {
		// csh/tcsh don't support -l flag; launch them directly
		if shellBase == "csh" || shellBase == "tcsh" {
			cmd = exec.Command(shell)
		} else {
			innerCmd := fmt.Sprintf("export TERM=xterm-256color; exec %s -i", shell)
			cmd = exec.Command(shell, "-l", "-c", innerCmd)
		}
	} else {
		cmd = exec.Command(shell)
	}

	// Build env: filter out any existing TERM/TERM_PROGRAM/COLORTERM, then set appropriately.
	env := make([]string, 0, len(os.Environ())+4)
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "TERM=") &&
			!strings.HasPrefix(e, "TERM_PROGRAM=") &&
			!strings.HasPrefix(e, "TERM_PROGRAM_VERSION=") &&
			!strings.HasPrefix(e, "COLORTERM=") {
			env = append(env, e)
		}
	}
	if runtime.GOOS == "darwin" && shellBase != "csh" && shellBase != "tcsh" {
		// Login-phase sees TERM=dumb; the exec'd shell overrides to xterm-256color.
		env = append(env, "TERM=dumb")
	} else {
		env = append(env, "TERM=xterm-256color")
	}
	// Identify as MeTerm so CLI tools (Claude Code, etc.) can detect terminal capabilities.
	env = append(env, "TERM_PROGRAM=MeTerm")
	env = append(env, "TERM_PROGRAM_VERSION="+buildinfo.Version)
	env = append(env, "COLORTERM=truecolor")
	// Pre-install shell hook via startup files (transparent, no PTY command injection).
	// zsh: ZDOTDIR → temp dir with proxy .zshrc that installs precmd hook
	// bash: --rcfile → temp .bashrc that sources user config then installs hook
	var hookDir string
	switch shellBase {
	case "zsh":
		if dir, ok := setupZshHook(env); ok {
			env = dir.env
			hookDir = dir.path
		}
	case "bash":
		if dir, ok := setupBashHook(env); ok {
			hookDir = dir.path
			// bash: use --rcfile for the interactive shell
			if runtime.GOOS == "darwin" {
				// Rewrite innerCmd to use --rcfile
				innerCmd := fmt.Sprintf("export TERM=xterm-256color; exec %s -i --rcfile %s/.bashrc",
					shell, dir.path)
				cmd = exec.Command(shell, "-l", "-c", innerCmd)
			} else {
				cmd = exec.Command(shell, "--rcfile", filepath.Join(dir.path, ".bashrc"))
			}
		}
	}

	cmd.Env = env
	if cwd != "" {
		cmd.Dir = cwd
	} else if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: rows, Cols: cols})
	if err != nil {
		if hookDir != "" {
			os.RemoveAll(hookDir)
		}
		return nil, err
	}

	engine := &PTYEngine{
		ptmx:    ptmx,
		cmd:     cmd,
		done:    make(chan struct{}),
		hookDir: hookDir,
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

	// Clean up temp hook directory
	if e.hookDir != "" {
		os.RemoveAll(e.hookDir)
	}

	return e.ptmx.Close()
}

// ─── Shell hook injection helpers ──────────────────────────────────────────

// hookDirResult holds the temp directory path and modified env for shell hook injection.
type hookDirResult struct {
	path string
	env  []string
}

// setupZshHook creates a temp ZDOTDIR with proxy dotfiles that source the user's
// original config, then install the MeTerm precmd hook. This is completely
// transparent — the user sees no injection commands, no history entries, no flash.
func setupZshHook(env []string) (hookDirResult, bool) {
	dir, err := os.MkdirTemp("", "meterm-hook-")
	if err != nil {
		return hookDirResult{}, false
	}

	// .zshenv: proxy user's .zshenv, preserve our ZDOTDIR for .zshrc loading
	zshenv := "# MeTerm: proxy user zshenv, keep ZDOTDIR for hook injection\n" +
		"__mt_zd=\"$ZDOTDIR\"\n" +
		"ZDOTDIR=\"$HOME\"\n" +
		"[[ -f \"$HOME/.zshenv\" ]] && source \"$HOME/.zshenv\"\n" +
		"ZDOTDIR=\"$__mt_zd\"\n" +
		"unset __mt_zd\n"
	_ = os.WriteFile(filepath.Join(dir, ".zshenv"), []byte(zshenv), 0644)

	// .zprofile: proxy user's .zprofile (login shell only)
	_ = os.WriteFile(filepath.Join(dir, ".zprofile"),
		[]byte("[[ -f \"$HOME/.zprofile\" ]] && source \"$HOME/.zprofile\"\n"), 0644)

	// .zshrc: proxy user's .zshrc, then install hook
	zshrc := "# MeTerm: proxy user zshrc + install precmd hook\n" +
		"ZDOTDIR=\"$HOME\"\n" +
		"[[ -f \"$HOME/.zshrc\" ]] && source \"$HOME/.zshrc\"\n" +
		"\n" +
		"# ── MeTerm shell hook (precmd) ──\n" +
		"__meterm_precmd(){\n" +
		"  local e=$?\n" +
		"  local c\n" +
		"  if [ -z \"$__meterm_hook_ready\" ]; then\n" +
		"    export __meterm_hook_ready=1\n" +
		"    printf '\\033]7766;meterm_init;1\\007'\n" +
		"    c=''\n" +
		"  else\n" +
		"    c=$(fc -ln -1 2>/dev/null)\n" +
		"  fi\n" +
		"  printf '\\033]7768;%d;%s;%s\\007' \"$e\" \"$PWD\" \"$c\"\n" +
		"}\n" +
		"autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __meterm_precmd\n" +
		"setopt HIST_IGNORE_SPACE 2>/dev/null\n"
	_ = os.WriteFile(filepath.Join(dir, ".zshrc"), []byte(zshrc), 0644)

	// .zlogin: proxy user's .zlogin (login shell only)
	_ = os.WriteFile(filepath.Join(dir, ".zlogin"),
		[]byte("[[ -f \"$HOME/.zlogin\" ]] && source \"$HOME/.zlogin\"\n"), 0644)

	// Filter existing ZDOTDIR from env and add ours
	filtered := make([]string, 0, len(env)+1)
	for _, e := range env {
		if !strings.HasPrefix(e, "ZDOTDIR=") {
			filtered = append(filtered, e)
		}
	}
	filtered = append(filtered, "ZDOTDIR="+dir)

	return hookDirResult{path: dir, env: filtered}, true
}

// setupBashHook creates a temp .bashrc that sources the user's original config,
// then installs the MeTerm PROMPT_COMMAND hook. Caller should start bash with
// --rcfile pointing to the temp .bashrc.
func setupBashHook(env []string) (hookDirResult, bool) {
	dir, err := os.MkdirTemp("", "meterm-hook-")
	if err != nil {
		return hookDirResult{}, false
	}

	bashrc := "# MeTerm: proxy user bashrc + install PROMPT_COMMAND hook\n" +
		"[[ -f \"$HOME/.bashrc\" ]] && source \"$HOME/.bashrc\"\n" +
		"\n" +
		"# ── MeTerm shell hook (PROMPT_COMMAND) ──\n" +
		"__meterm_precmd(){\n" +
		"  local e=$?\n" +
		"  local c\n" +
		"  if [ -z \"$__meterm_hook_ready\" ]; then\n" +
		"    export __meterm_hook_ready=1\n" +
		"    printf '\\033]7766;meterm_init;0\\007'\n" +
		"    c=''\n" +
		"  else\n" +
		"    c=$(fc -ln -1 2>/dev/null)\n" +
		"  fi\n" +
		"  printf '\\033]7768;%d;%s;%s\\007' \"$e\" \"$PWD\" \"$c\"\n" +
		"}\n" +
		"PROMPT_COMMAND=\"__meterm_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"\n" +
		"export HISTCONTROL=\"${HISTCONTROL:+$HISTCONTROL:}ignorespace\"\n"
	_ = os.WriteFile(filepath.Join(dir, ".bashrc"), []byte(bashrc), 0644)

	return hookDirResult{path: dir, env: env}, true
}
