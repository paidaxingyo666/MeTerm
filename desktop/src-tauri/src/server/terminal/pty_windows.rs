//! Windows ConPTY terminal — xpty integration + PowerShell/cmd hook injection.
//!
//! Uses a dedicated reader thread that sends output via a channel,
//! making `read()` cancel-safe for use in `tokio::select!`.
//! xpty handles ConPTY creation and DLL loading (sideload conpty.dll → kernel32.dll).

use std::io;
use std::sync::Mutex;

use tokio_util::sync::CancellationToken;
use xpty::{CommandBuilder, PtySize, PtySystem};

use super::Terminal;

/// Windows ConPTY terminal backed by xpty.
///
/// Uses a dedicated reader thread that sends output via a channel,
/// making `read()` cancel-safe for use in `tokio::select!`.
pub struct ConPtyTerminal {
    /// Receiver for PTY output (from the dedicated reader thread).
    output_rx: tokio::sync::Mutex<tokio::sync::mpsc::Receiver<io::Result<Vec<u8>>>>,
    writer: Mutex<Option<Box<dyn io::Write + Send>>>,
    master: Mutex<Box<dyn xpty::MasterPty + Send>>,
    done_token: CancellationToken,
}

impl ConPtyTerminal {
    /// Spawn a new ConPTY with the given shell and working directory.
    ///
    /// PowerShell hook injection: adds `-NoExit -Command "..."` for OSC 7 CWD tracking.
    /// cmd.exe: sets PROMPT for OSC 7 CWD tracking.
    pub fn new(shell: &str, cwd: &str, cols: u16, rows: u16) -> Result<Self, String> {
        let pty_system = xpty::native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("ConPTY openpty: {}", e))?;

        // Resolve shell: prefer explicit shell, then PowerShell, then COMSPEC.
        // Matches the default in list_available_shells() so UI and behavior agree.
        let resolved = if shell.is_empty() {
            default_windows_shell()
        } else {
            shell.to_string()
        };

        let mut cmd = {
            let mut cmd = CommandBuilder::new(&resolved);

            let shell_lower = resolved.to_lowercase();
            let basename = shell_lower.rsplit(['\\', '/']).next().unwrap_or(&shell_lower);

            // PowerShell hook: OSC 7 (CWD) + OSC 7766 (init) + OSC 7768 (shell state)
            // Matches Go psStartupHook. Uses [char]27/[char]7 for PowerShell 5 compat.
            if basename.contains("pwsh") || basename.contains("powershell") {
                let hook_script = "& { $global:__mtOrig = $function:prompt; function global:prompt { \
                    [Console]::Write([string][char]27 + ']7;file:///' + (Get-Location).ProviderPath.Replace('\\','/') + [char]7); \
                    $e=[int](-not $?); \
                    if(-not $env:__meterm_hook_ready){$env:__meterm_hook_ready='1'; \
                    [Console]::Write([string][char]27 + ']7766;meterm_init;3' + [char]7);$c=''} \
                    else{try{$c=(Get-History -Count 1).CommandLine}catch{$c=''}}; \
                    [Console]::Write([string][char]27 + ']7768;' + $e + ';' + (Get-Location) + ';' + $c + [char]7); \
                    if($global:__mtOrig){return & $global:__mtOrig}else{return ''} } }";
                cmd.arg("-NoExit");
                cmd.arg("-Command");
                cmd.arg(hook_script);
            }
            // cmd.exe: set PROMPT for OSC 7
            else if basename == "cmd.exe" || basename == "cmd" {
                cmd.env(
                    "PROMPT",
                    "$E]7;file://%COMPUTERNAME%/$P$E\\$P$G",
                );
            }
            // WSL: detected by basename, delegate to pty_wsl.rs
            // (caller should check and use WslPtyTerminal instead)

            cmd
        };

        if !cwd.is_empty() {
            cmd.cwd(cwd);
        }
        cmd.env("TERM", "xterm-256color");

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone reader: {}", e))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take writer: {}", e))?;

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn: {}", e))?;

        let done_token = CancellationToken::new();

        // Spawn dedicated reader thread that sends output via channel.
        // This makes read() cancel-safe for tokio::select!.
        let (output_tx, output_rx) = tokio::sync::mpsc::channel::<io::Result<Vec<u8>>>(64);
        let done_clone = done_token.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 32768];
            loop {
                use std::io::Read;
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
        })
    }
}

#[async_trait::async_trait]
impl Terminal for ConPtyTerminal {
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
        let mut guard = self.writer.lock().unwrap();
        if let Some(ref mut writer) = *guard {
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
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))
    }

    fn done(&self) -> CancellationToken {
        self.done_token.clone()
    }

    async fn close(&self) -> io::Result<()> {
        *self.writer.lock().unwrap() = None;
        self.done_token.cancel();
        Ok(())
    }
}

/// Default shell for Windows: pwsh.exe > powershell.exe > COMSPEC > cmd.exe.
/// Uses fast PATH lookup (no subprocess spawning) to keep session creation instant.
fn default_windows_shell() -> String {
    if find_in_path("pwsh.exe") {
        return "pwsh.exe".to_string();
    }
    // powershell.exe is always available on modern Windows (System32)
    if find_in_path("powershell.exe") {
        return "powershell.exe".to_string();
    }
    std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
}

/// Check if an executable exists in any PATH directory (no subprocess).
fn find_in_path(exe: &str) -> bool {
    let Ok(path_var) = std::env::var("PATH") else { return false };
    path_var.split(';').any(|dir| {
        !dir.is_empty() && std::path::Path::new(dir).join(exe).is_file()
    })
}
