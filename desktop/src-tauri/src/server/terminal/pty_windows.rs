//! Windows ConPTY terminal — xpty integration + PowerShell/cmd hook injection.
//!
//! Mirrors Go `terminal/pty_windows.go` + `internal/conpty/conpty.go`.
//! xpty handles ConPTY creation and DLL loading (sideload conpty.dll → kernel32.dll).

use std::io;
use std::sync::Mutex;

use tokio::task;
use tokio_util::sync::CancellationToken;
use xpty::{CommandBuilder, PtySize, PtySystem};

use super::Terminal;

/// Windows ConPTY terminal backed by xpty.
pub struct ConPtyTerminal {
    reader: Mutex<Option<Box<dyn io::Read + Send>>>,
    writer: Mutex<Option<Box<dyn io::Write + Send>>>,
    master: Mutex<Box<dyn xpty::MasterPty + Send>>,
    child: Mutex<Option<Box<dyn xpty::Child + Send + Sync>>>,
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

        // Resolve shell: prefer explicit shell, then COMSPEC env, then cmd.exe.
        // Avoids new_default_prog() which can fail on Windows with PATH issues.
        let resolved = if shell.is_empty() {
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
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

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone reader: {}", e))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take writer: {}", e))?;

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn: {}", e))?;

        let done_token = CancellationToken::new();
        let done_clone = done_token.clone();

        // Background thread to wait for child exit
        let mut child_for_wait = child;
        std::thread::spawn(move || {
            let _ = child_for_wait.wait();
            done_clone.cancel();
        });

        Ok(Self {
            reader: Mutex::new(Some(reader)),
            writer: Mutex::new(Some(writer)),
            master: Mutex::new(pair.master),
            child: Mutex::new(None),
            done_token,
        })
    }
}

#[async_trait::async_trait]
impl Terminal for ConPtyTerminal {
    async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        let reader = {
            let mut guard = self.reader.lock().unwrap();
            guard.take().ok_or_else(|| {
                io::Error::new(io::ErrorKind::BrokenPipe, "reader already consumed")
            })?
        };

        let buf_len = buf.len();
        let result = task::spawn_blocking(move || {
            let mut local_buf = vec![0u8; buf_len];
            let mut reader = reader;
            use std::io::Read;
            let n = reader.read(&mut local_buf)?;
            Ok::<(Box<dyn io::Read + Send>, Vec<u8>, usize), io::Error>((reader, local_buf, n))
        })
        .await
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;

        match result {
            Ok((reader_back, data, n)) => {
                buf[..n].copy_from_slice(&data[..n]);
                *self.reader.lock().unwrap() = Some(reader_back);
                Ok(n)
            }
            Err(e) => Err(e),
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
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
        }
        self.done_token.cancel();
        Ok(())
    }
}
