//! Unix PTY terminal — xpty integration + macOS two-stage login shell + shell hook injection.
//!
//! Mirrors Go `terminal/pty_unix.go`.
//!
//! Shell hooks (OSC 7766/7768) are injected transparently via ZDOTDIR (zsh) or
//! --rcfile (bash). The proxy dotfiles source the user's originals, then install
//! the MeTerm precmd hook. This enables AI Agent integration (shell state tracking,
//! command detection, CWD updates).

use std::io::{self, Read};
use std::sync::Mutex;

use tokio_util::sync::CancellationToken;
use xpty::{CommandBuilder, PtySize, PtySystem};

use super::Terminal;

/// Unix PTY terminal backed by xpty.
///
/// Uses a dedicated reader thread that sends output via a channel,
/// making `read()` cancel-safe for use in `tokio::select!`.
pub struct PtyTerminal {
    /// Receiver for PTY output (from the dedicated reader thread).
    output_rx: tokio::sync::Mutex<tokio::sync::mpsc::Receiver<io::Result<Vec<u8>>>>,
    /// Writer taken from the master PTY.
    writer: Mutex<Option<Box<dyn io::Write + Send>>>,
    /// Master PTY handle (for resize). Wrapped in Mutex because MasterPty is !Sync.
    master: Mutex<Box<dyn xpty::MasterPty + Send>>,
    /// Fired when the child exits.
    done_token: CancellationToken,
    /// Temp directory for shell hook files. Cleaned up on close/drop.
    hook_dir: Option<String>,
}

impl PtyTerminal {
    /// Spawn a new PTY with the given shell and working directory.
    ///
    /// On macOS, implements the two-stage login shell:
    /// 1. Stage 1: `TERM=dumb` login shell loads environment (.zprofile, PATH)
    /// 2. Stage 2: `exec` to interactive shell with `TERM=xterm-256color`
    ///
    /// Shell hooks (OSC 7766/7768) are injected via ZDOTDIR (zsh) or --rcfile (bash).
    pub fn new(shell: &str, cwd: &str, cols: u16, rows: u16) -> Result<Self, String> {
        let pty_system = xpty::native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("openpty: {}", e))?;

        // Resolve shell path (matches Go: $SHELL → /bin/sh fallback)
        let shell = if shell.is_empty() {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
        } else {
            shell.to_string()
        };
        let basename = shell.rsplit('/').next().unwrap_or(&shell).to_string();

        let mut cmd = CommandBuilder::new(&shell);

        if !cwd.is_empty() {
            cmd.cwd(cwd);
        }

        // Terminal identification env vars (so CLI tools can detect MeTerm)
        cmd.env("TERM_PROGRAM", "MeTerm");
        cmd.env("COLORTERM", "truecolor");

        // Create hook directory for supported shells (OSC 7766/7768 injection)
        let hook_dir = if basename == "zsh" || basename == "bash" {
            create_hook_dir(&basename)
        } else {
            None
        };

        // ── macOS: two-stage login shell ────────────────────────────────────
        #[cfg(target_os = "macos")]
        {
            if !is_csh_family(&shell) {
                cmd.env("TERM", "dumb");

                // Set ZDOTDIR for zsh hook (affects both Stage 1 and Stage 2)
                if basename == "zsh" {
                    if let Some(ref dir) = hook_dir {
                        cmd.env("ZDOTDIR", dir);
                    }
                }

                // Build Stage 2 inner command
                let inner_cmd = if basename == "bash" {
                    if let Some(ref dir) = hook_dir {
                        format!("export TERM=xterm-256color; exec {} -i --rcfile {}/.bashrc", shell, dir)
                    } else {
                        format!("export TERM=xterm-256color; exec {} -i", shell)
                    }
                } else {
                    format!("export TERM=xterm-256color; exec {} -i", shell)
                };

                // Use full shell path as argv[0] (matches Go exec.Command behavior).
                // The -l flag marks login shell; no need for the Unix "-basename" convention.
                let argv = cmd.get_argv_mut();
                argv.clear();
                argv.push(shell.clone().into());
                argv.push("-l".into());
                argv.push("-c".into());
                argv.push(inner_cmd.into());
            } else {
                cmd.env("TERM", "xterm-256color");
            }
        }

        // ── Linux: direct shell + hook injection ────────────────────────────
        #[cfg(not(target_os = "macos"))]
        {
            cmd.env("TERM", "xterm-256color");
            if basename == "zsh" {
                if let Some(ref dir) = hook_dir {
                    cmd.env("ZDOTDIR", dir);
                }
            } else if basename == "bash" {
                if let Some(ref dir) = hook_dir {
                    let argv = cmd.get_argv_mut();
                    argv.push("--rcfile".into());
                    argv.push(format!("{}/.bashrc", dir).into());
                }
            }
        }

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone reader: {}", e))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take writer: {}", e))?;

        eprintln!("[pty] spawning: argv={:?} cwd={:?} hook_dir={:?}", cmd.get_argv(), cmd.get_cwd(), hook_dir);
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn: {}", e))?;
        eprintln!("[pty] spawned PID={:?}", child.process_id());

        let done_token = CancellationToken::new();

        // Spawn dedicated reader thread that sends output via channel.
        // This makes read() cancel-safe for tokio::select!.
        let (output_tx, output_rx) = tokio::sync::mpsc::channel::<io::Result<Vec<u8>>>(64);
        let done_clone = done_token.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 32768];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        let _ = output_tx.blocking_send(Ok(Vec::new()));
                        break;
                    }
                    Ok(n) => {
                        if output_tx.blocking_send(Ok(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = output_tx.blocking_send(Err(e));
                        break;
                    }
                }
            }
            let _ = child.wait();
            done_clone.cancel();
        });

        Ok(Self {
            output_rx: tokio::sync::Mutex::new(output_rx),
            writer: Mutex::new(Some(writer)),
            master: Mutex::new(pair.master),
            done_token,
            hook_dir,
        })
    }
}

#[async_trait::async_trait]
impl Terminal for PtyTerminal {
    async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        let mut rx = self.output_rx.lock().await;
        match rx.recv().await {
            Some(Ok(data)) => {
                if data.is_empty() {
                    return Ok(0);
                }
                let n = data.len().min(buf.len());
                buf[..n].copy_from_slice(&data[..n]);
                Ok(n)
            }
            Some(Err(e)) => Err(e),
            None => Ok(0),
        }
    }

    async fn write(&self, data: &[u8]) -> io::Result<usize> {
        let mut writer_guard = self.writer.lock().unwrap();
        if let Some(ref mut writer) = *writer_guard {
            use io::Write;
            writer.write(data)
        } else {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "writer closed"))
        }
    }

    fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        self.master
            .lock()
            .unwrap()
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))
    }

    fn done(&self) -> CancellationToken {
        self.done_token.clone()
    }

    async fn close(&self) -> io::Result<()> {
        *self.writer.lock().unwrap() = None;
        self.done_token.cancel();
        if let Some(ref dir) = self.hook_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
        Ok(())
    }
}

impl Drop for PtyTerminal {
    fn drop(&mut self) {
        if let Some(ref dir) = self.hook_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

// ── Shell hook injection ────────────────────────────────────────────────────

/// Create a temporary directory with shell hook files (precmd / PROMPT_COMMAND).
/// Returns the directory path, or None if creation failed.
fn create_hook_dir(shell_basename: &str) -> Option<String> {
    let dir = std::env::temp_dir().join(format!("meterm-hook-{}", uuid::Uuid::new_v4()));
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    match shell_basename {
        "zsh" => create_zsh_hooks(&dir),
        "bash" => create_bash_hooks(&dir),
        _ => return None,
    }
    Some(dir.to_string_lossy().to_string())
}

/// Create proxy zsh dotfiles that source user's originals then install MeTerm hook.
fn create_zsh_hooks(dir: &std::path::Path) {
    // .zshenv: proxy user's .zshenv, preserve our ZDOTDIR for .zshrc loading
    let _ = std::fs::write(
        dir.join(".zshenv"),
        "# MeTerm: proxy user zshenv, keep ZDOTDIR for hook injection\n\
         __mt_zd=\"$ZDOTDIR\"\n\
         ZDOTDIR=\"$HOME\"\n\
         [[ -f \"$HOME/.zshenv\" ]] && source \"$HOME/.zshenv\"\n\
         ZDOTDIR=\"$__mt_zd\"\n\
         unset __mt_zd\n",
    );

    // .zprofile: proxy user's .zprofile (login shell only)
    let _ = std::fs::write(
        dir.join(".zprofile"),
        "[[ -f \"$HOME/.zprofile\" ]] && source \"$HOME/.zprofile\"\n",
    );

    // .zshrc: proxy user's .zshrc, then install precmd hook
    let _ = std::fs::write(
        dir.join(".zshrc"),
        "# MeTerm: proxy user zshrc + install precmd hook\n\
         ZDOTDIR=\"$HOME\"\n\
         [[ -f \"$HOME/.zshrc\" ]] && source \"$HOME/.zshrc\"\n\
         \n\
         # ── MeTerm shell hook (precmd) ──\n\
         __meterm_precmd(){\n\
           local e=$?\n\
           local c\n\
           if [ -z \"$__meterm_hook_ready\" ]; then\n\
             export __meterm_hook_ready=1\n\
             printf '\\033]7766;meterm_init;1\\007'\n\
             c=''\n\
           else\n\
             c=$(fc -ln -1 2>/dev/null)\n\
           fi\n\
           printf '\\033]7768;%d;%s;%s\\007' \"$e\" \"$PWD\" \"$c\"\n\
         }\n\
         autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __meterm_precmd\n\
         setopt HIST_IGNORE_SPACE 2>/dev/null\n",
    );

    // .zlogin: proxy user's .zlogin (login shell only)
    let _ = std::fs::write(
        dir.join(".zlogin"),
        "[[ -f \"$HOME/.zlogin\" ]] && source \"$HOME/.zlogin\"\n",
    );
}

/// Create proxy bash .bashrc that sources user's original then installs MeTerm hook.
fn create_bash_hooks(dir: &std::path::Path) {
    let _ = std::fs::write(
        dir.join(".bashrc"),
        "# MeTerm: proxy user bashrc + install PROMPT_COMMAND hook\n\
         [[ -f \"$HOME/.bashrc\" ]] && source \"$HOME/.bashrc\"\n\
         \n\
         # ── MeTerm shell hook (PROMPT_COMMAND) ──\n\
         __meterm_precmd(){\n\
           local e=$?\n\
           local c\n\
           if [ -z \"$__meterm_hook_ready\" ]; then\n\
             export __meterm_hook_ready=1\n\
             printf '\\033]7766;meterm_init;0\\007'\n\
             c=''\n\
           else\n\
             c=$(fc -ln -1 2>/dev/null)\n\
           fi\n\
           printf '\\033]7768;%d;%s;%s\\007' \"$e\" \"$PWD\" \"$c\"\n\
         }\n\
         PROMPT_COMMAND=\"__meterm_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"\n\
         export HISTCONTROL=\"${HISTCONTROL:+$HISTCONTROL:}ignorespace\"\n",
    );
}

/// Check if the shell is csh or tcsh (which don't support -l properly).
#[cfg(target_os = "macos")]
fn is_csh_family(shell: &str) -> bool {
    let basename = shell.rsplit('/').next().unwrap_or(shell);
    basename == "csh" || basename == "tcsh"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_hook_dir_zsh() {
        let dir = create_hook_dir("zsh");
        assert!(dir.is_some());
        let dir = dir.unwrap();
        assert!(std::path::Path::new(&dir).join(".zshrc").exists());
        assert!(std::path::Path::new(&dir).join(".zshenv").exists());
        assert!(std::path::Path::new(&dir).join(".zprofile").exists());
        assert!(std::path::Path::new(&dir).join(".zlogin").exists());
        // Check hook content
        let zshrc = std::fs::read_to_string(std::path::Path::new(&dir).join(".zshrc")).unwrap();
        assert!(zshrc.contains("__meterm_precmd"));
        assert!(zshrc.contains("7766;meterm_init;1"));
        assert!(zshrc.contains("7768"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_create_hook_dir_bash() {
        let dir = create_hook_dir("bash");
        assert!(dir.is_some());
        let dir = dir.unwrap();
        assert!(std::path::Path::new(&dir).join(".bashrc").exists());
        let bashrc = std::fs::read_to_string(std::path::Path::new(&dir).join(".bashrc")).unwrap();
        assert!(bashrc.contains("__meterm_precmd"));
        assert!(bashrc.contains("7766;meterm_init;0"));
        assert!(bashrc.contains("PROMPT_COMMAND"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_is_csh_family() {
        assert!(is_csh_family("/bin/csh"));
        assert!(is_csh_family("/bin/tcsh"));
        assert!(!is_csh_family("/bin/zsh"));
        assert!(!is_csh_family("/bin/bash"));
    }
}
