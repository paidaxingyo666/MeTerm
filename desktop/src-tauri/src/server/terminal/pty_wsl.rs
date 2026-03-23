//! WSL Python PTY helper — mirrors Go `terminal/pty_wsl.go`.
//!
//! Bypasses ConPTY stdin injection issues by using a Python PTY helper
//! inside WSL. Communication uses stdin/stdout pipes with OSC 7799 for resize.

use std::io;
use std::process::Stdio;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::Terminal;

/// Python PTY helper script (embedded, same as Go version).
/// Creates a Unix PTY inside WSL, bypassing ConPTY limitations.
const WSL_PTY_HELPER: &str = r#"
import os, sys, pty, select, signal, struct, fcntl, termios

def set_winsize(fd, rows, cols):
    s = struct.pack('HHHH', rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, s)

def main():
    shell = os.environ.get('SHELL', '/bin/bash')
    rows = int(os.environ.get('ROWS', '24'))
    cols = int(os.environ.get('COLS', '80'))

    pid, master_fd = pty.fork()
    if pid == 0:
        # Child: exec shell
        os.execvp(shell, ['-' + os.path.basename(shell)])

    set_winsize(master_fd, rows, cols)
    stdin_fd = sys.stdin.fileno()

    try:
        while True:
            rlist, _, _ = select.select([master_fd, stdin_fd], [], [], 1.0)
            if master_fd in rlist:
                try:
                    data = os.read(master_fd, 65536)
                    if not data:
                        break
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                except OSError:
                    break
            if stdin_fd in rlist:
                data = os.read(stdin_fd, 65536)
                if not data:
                    break
                # Check for OSC 7799 resize: \x1b]7799;{rows};{cols}\x07
                if b'\x1b]7799;' in data:
                    try:
                        start = data.index(b'\x1b]7799;')
                        end = data.index(b'\x07', start)
                        params = data[start+7:end].decode()
                        parts = params.split(';')
                        if len(parts) == 2:
                            r, c = int(parts[0]), int(parts[1])
                            set_winsize(master_fd, r, c)
                            signal.signal(signal.SIGWINCH, lambda *a: None)
                            os.kill(pid, signal.SIGWINCH)
                        # Remove resize sequence from data
                        data = data[:start] + data[end+1:]
                    except (ValueError, IndexError):
                        pass
                if data:
                    os.write(master_fd, data)
    finally:
        os.close(master_fd)
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass

if __name__ == '__main__':
    main()
"#;

/// WSL PTY terminal — runs Python PTY helper inside WSL.
pub struct WslPtyTerminal {
    child: Mutex<Option<Child>>,
    stdin: std::sync::Arc<Mutex<Option<tokio::process::ChildStdin>>>,
    stdout: Mutex<Option<tokio::process::ChildStdout>>,
    done_token: CancellationToken,
}

impl WslPtyTerminal {
    /// Create a new WSL PTY terminal.
    ///
    /// `distro` can be a bare distribution name (e.g., "Ubuntu"),
    /// a full command string (e.g., "wsl.exe -d Ubuntu"), or empty
    /// (uses the default distribution).
    pub async fn new(
        distro: &str,
        shell: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
    ) -> Result<Self, String> {
        let mut cmd = Command::new("wsl.exe");

        // Extract distro name from formats like "wsl.exe -d Ubuntu" or "wsl -d Ubuntu"
        let distro_name = extract_wsl_distro(distro);
        if !distro_name.is_empty() {
            cmd.arg("-d").arg(&distro_name);
        }

        // Set starting directory: use --cd to set WSL-side working directory.
        // Without this, WSL inherits the Windows parent process cwd (often C:\Windows\System32).
        if !cwd.is_empty() {
            let wsl_cwd = windows_to_wsl_path(cwd);
            cmd.arg("--cd").arg(&wsl_cwd);
        } else {
            cmd.arg("--cd").arg("~");
        }

        cmd.arg("-e")
            .arg("python3")
            .arg("-c")
            .arg(WSL_PTY_HELPER);

        cmd.env("ROWS", rows.to_string());
        cmd.env("COLS", cols.to_string());
        if !shell.is_empty() {
            cmd.env("SHELL", shell);
        }

        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        let mut child = cmd.spawn().map_err(|e| format!("WSL spawn failed: {}", e))?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;

        let done_token = CancellationToken::new();
        let _done_clone = done_token.clone();

        // Monitor child exit
        let _child_id = child.id();
        tokio::spawn(async move {
            // Wait a bit then start polling
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                // Check if process still exists
                #[cfg(target_os = "windows")]
                {
                    // On Windows, we can't easily poll without the Child handle
                    // The done_token will be cancelled when read returns 0
                    break;
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let _ = _child_id;
                    break;
                }
            }
        });

        Ok(Self {
            child: Mutex::new(Some(child)),
            stdin: std::sync::Arc::new(Mutex::new(Some(stdin))),
            stdout: Mutex::new(Some(stdout)),
            done_token,
        })
    }
}

#[async_trait::async_trait]
impl Terminal for WslPtyTerminal {
    async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        let mut stdout_guard = self.stdout.lock().await;
        if let Some(ref mut stdout) = *stdout_guard {
            let n = stdout.read(buf).await?;
            if n == 0 {
                self.done_token.cancel();
            }
            Ok(n)
        } else {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "stdout closed"))
        }
    }

    async fn write(&self, data: &[u8]) -> io::Result<usize> {
        let mut stdin_guard = self.stdin.lock().await;
        if let Some(ref mut stdin) = *stdin_guard {
            stdin.write(data).await
        } else {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "stdin closed"))
        }
    }

    fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        // Send OSC 7799 resize sequence via spawned async task
        let resize_seq = format!("\x1b]7799;{};{}\x07", rows, cols);
        let stdin_ref = self.stdin.clone();
        tokio::spawn(async move {
            let mut guard = stdin_ref.lock().await;
            if let Some(ref mut stdin) = *guard {
                let _ = stdin.write_all(resize_seq.as_bytes()).await;
            }
        });
        Ok(())
    }

    fn done(&self) -> CancellationToken {
        self.done_token.clone()
    }

    async fn close(&self) -> io::Result<()> {
        *self.stdin.lock().await = None;
        *self.stdout.lock().await = None;
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
        }
        self.done_token.cancel();
        Ok(())
    }
}

/// Convert a Windows path (C:\foo\bar) to WSL path (/mnt/c/foo/bar).
fn windows_to_wsl_path(path: &str) -> String {
    if path.len() >= 2 && path.as_bytes()[1] == b':' {
        let drive = (path.as_bytes()[0] as char).to_lowercase().next().unwrap();
        let rest = path[2..].replace('\\', "/");
        format!("/mnt/{}{}", drive, rest)
    } else {
        path.replace('\\', "/")
    }
}

/// Extract the WSL distro name from a shell string.
///
/// Handles formats:
/// - `"wsl.exe -d Ubuntu"` → `"Ubuntu"`
/// - `"wsl -d Ubuntu-22.04"` → `"Ubuntu-22.04"`
/// - `"Ubuntu"` (bare name) → `"Ubuntu"`
/// - `"wsl.exe"` or `"wsl"` (no -d) → `""` (use default distro)
/// - `""` → `""`
fn extract_wsl_distro(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    // Look for "-d <distro>" pattern
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    for i in 0..parts.len().saturating_sub(1) {
        if parts[i] == "-d" || parts[i] == "--distribution" {
            return parts[i + 1].to_string();
        }
    }

    // If it starts with "wsl" (no -d flag), use default distro
    let lower = trimmed.to_lowercase();
    if lower == "wsl" || lower == "wsl.exe" || lower.starts_with("wsl ") || lower.starts_with("wsl.exe ") {
        return String::new();
    }

    // Bare distro name
    trimmed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_windows_to_wsl_path() {
        assert_eq!(windows_to_wsl_path("C:\\Users\\test"), "/mnt/c/Users/test");
        assert_eq!(windows_to_wsl_path("D:\\foo\\bar"), "/mnt/d/foo/bar");
        assert_eq!(windows_to_wsl_path("/home/user"), "/home/user");
    }

    #[test]
    fn test_extract_wsl_distro() {
        assert_eq!(extract_wsl_distro("wsl.exe -d Ubuntu"), "Ubuntu");
        assert_eq!(extract_wsl_distro("wsl -d Ubuntu-22.04"), "Ubuntu-22.04");
        assert_eq!(extract_wsl_distro("wsl.exe"), "");
        assert_eq!(extract_wsl_distro("wsl"), "");
        assert_eq!(extract_wsl_distro("Ubuntu"), "Ubuntu");
        assert_eq!(extract_wsl_distro(""), "");
    }
}
