use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::Emitter;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::process::Command;
#[cfg(target_os = "windows")]
use tauri::Manager;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Create a `wsl` Command with the console window hidden.
#[cfg(target_os = "windows")]
fn wsl_cmd() -> Command {
    let mut cmd = Command::new("wsl");
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Run a `wsl` Command with a timeout to prevent hangs when WSL is partially installed.
#[cfg(target_os = "windows")]
fn wsl_output_with_timeout(mut cmd: Command, timeout_secs: u64) -> Result<std::process::Output, String> {
    use std::io::Read;
    use std::time::{Duration, Instant};

    let mut child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn wsl: {}", e))?;

    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = Vec::new();
                let mut stderr = Vec::new();
                if let Some(mut out) = child.stdout.take() {
                    let _ = out.read_to_end(&mut stdout);
                }
                if let Some(mut err) = child.stderr.take() {
                    let _ = err.read_to_end(&mut stderr);
                }
                return Ok(std::process::Output { status, stdout, stderr });
            }
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("wsl command timed out (WSL may be partially installed or stuck)".to_string());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("wsl wait error: {}", e));
            }
        }
    }
}

pub struct MeTermProcess {
    child: Mutex<Option<CommandChild>>,
    port: Mutex<u16>,
    /// LAN-accessible port (same as sidecar port when proxy is off; proxy port when LAN sharing is on)
    lan_port: Mutex<u16>,
    token: Arc<Mutex<Option<String>>>,
    ready: Arc<AtomicBool>,
    proxy_handle: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl MeTermProcess {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            port: Mutex::new(0),
            lan_port: Mutex::new(0),
            token: Arc::new(Mutex::new(None)),
            ready: Arc::new(AtomicBool::new(false)),
            proxy_handle: Mutex::new(None),
        }
    }

    pub fn port(&self) -> u16 {
        *self.port.lock().unwrap()
    }

    /// Port accessible from the LAN (for sharing / pairing).
    pub fn lan_port(&self) -> u16 {
        *self.lan_port.lock().unwrap()
    }

    pub fn is_running(&self) -> bool {
        self.child.lock().unwrap().is_some()
    }

    pub fn token(&self) -> Option<String> {
        self.token.lock().unwrap().clone()
    }

    pub fn update_token(&self, new_token: String) {
        if let Ok(mut guard) = self.token.lock() {
            *guard = Some(new_token);
        }
    }

    fn reset_auth_state(&self) {
        if let Ok(mut guard) = self.token.lock() {
            *guard = None;
        }
        self.ready.store(false, Ordering::SeqCst);
    }

    pub fn start(&self, app: &tauri::AppHandle) -> Result<u16, String> {
        self.reset_auth_state();
        let port = allocate_port()?;
        let app_handle = app.clone();

        // On Windows, allocate a second port for the LAN-facing TCP proxy.
        // WSL2 port forwarding only exposes services on localhost; the proxy
        // bridges LAN traffic to the WSL-side server.
        // On Windows, LAN proxy is only started when sharing/pairing is active.
        // Default to same port (localhost-only) for security.
        #[cfg(target_os = "windows")]
        let lan_port = port;

        #[cfg(not(target_os = "windows"))]
        let lan_port = port;

        #[cfg(target_os = "windows")]
        let (mut rx, child) = {
            // Windows: prefer native sidecar (ConPTY backend), fall back to WSL
            // only if the native binary is unavailable or fails to start.
            let parent_pid = std::process::id();
            let native_attempt = match app.shell().sidecar("meterm-server") {
                Ok(sidecar) => sidecar
                    .args([
                        "--port",
                        &port.to_string(),
                        "--bind",
                        "127.0.0.1",
                        "--parent-pid",
                        &parent_pid.to_string(),
                    ])
                    .spawn()
                    .map_err(|e| format!("failed to spawn native meterm sidecar: {}", e)),
                Err(e) => Err(format!(
                    "failed to create native meterm sidecar command: {}",
                    e
                )),
            };

            match native_attempt {
                Ok(spawned) => {
                    eprintln!("[meterm] using native Windows sidecar");
                    spawned
                }
                Err(native_err) => {
                    eprintln!(
                        "[meterm] native Windows sidecar unavailable ({}), falling back to WSL",
                        native_err
                    );

                    if let Err(wsl_err) = check_wsl_available() {
                        return Err(format!(
                            "Native Windows backend failed: {}\n\n\
                             WSL fallback also failed: {}\n\n\
                             Please try one of the following:\n\
                             1. Reinstall MeTerm to restore the native Windows backend\n\
                             2. Install WSL 2: wsl --install\n\n\
                             原生 Windows 后端启动失败：{}\n\n\
                             WSL 回退也失败了：{}\n\n\
                             请尝试以下方法之一：\n\
                             1. 重新安装 MeTerm 以恢复原生 Windows 后端\n\
                             2. 安装 WSL 2：wsl --install",
                            native_err, wsl_err, native_err, wsl_err
                        ));
                    }
                    let wsl_path = setup_wsl_binary(app)?;

                    // Verify the deployed binary can actually be executed inside WSL.
                    // This catches cases where `wsl -e` fails due to a missing default
                    // shell (e.g. the distro's login shell is bash but bash is not
                    // installed, causing `execvpe(bash) failed`).
                    let verify = wsl_cmd().args(["-e", "test", "-x", &wsl_path]).output();
                    if let Ok(out) = &verify {
                        if !out.status.success() {
                            let stderr = String::from_utf8_lossy(&out.stderr);
                            let bash_hint = if stderr.contains("execvpe") && stderr.contains("bash")
                            {
                                "\n\nThe default WSL distribution appears to be missing bash.\n\
                                 默认 WSL 发行版似乎缺少 bash。\n\n\
                                 Fix / 修复:\n\
                                 - Install bash: wsl -e sh -c \"apk add bash || apt install -y bash\"\n\
                                 - Or switch default distro: wsl --set-default Ubuntu"
                            } else {
                                ""
                            };
                            return Err(format!(
                                "Native Windows sidecar failed: {}\n\n\
                                 WSL fallback binary verification failed: {}{}\n\
                                 原生 Windows 后端启动失败：{}\n\n\
                                 WSL 回退后端验证失败：{}{}",
                                native_err,
                                stderr.trim(),
                                bash_hint,
                                native_err,
                                stderr.trim(),
                                bash_hint
                            ));
                        }
                    }

                    let sidecar = app.shell().command("wsl").args([
                        "-e",
                        &wsl_path,
                        "--port",
                        &port.to_string(),
                        "--bind",
                        "0.0.0.0", // WSL needs to bind to all interfaces for Windows access
                    ]);

                    sidecar.spawn().map_err(|e| {
                        format!(
                            "failed to spawn meterm via WSL (native error: {}): {}",
                            native_err, e
                        )
                    })?
                }
            }
        };

        #[cfg(not(target_os = "windows"))]
        let (mut rx, child) = {
            // macOS/Linux: Direct sidecar execution
            let parent_pid = std::process::id();

            let sidecar = app
                .shell()
                .sidecar("meterm-server")
                .map_err(|e| format!("failed to create sidecar command: {}", e))?
                .args([
                    "--port",
                    &port.to_string(),
                    "--bind",
                    "127.0.0.1",
                    "--parent-pid",
                    &parent_pid.to_string(),
                ]);

            sidecar
                .spawn()
                .map_err(|e| format!("failed to spawn meterm: {}", e))?
        };

        let token_store = Arc::clone(&self.token);
        let ready_store = Arc::clone(&self.ready);

        tauri::async_runtime::spawn(async move {
            let mut stdout_buf = String::new();
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(line) => {
                        let line = String::from_utf8_lossy(&line);
                        stdout_buf.push_str(&line);
                        while let Some(pos) = stdout_buf.find('\n') {
                            let raw = stdout_buf[..pos].to_string();
                            stdout_buf = stdout_buf[pos + 1..].to_string();
                            let trimmed = raw.trim();
                            if let Some(token) = parse_ready_token(trimmed) {
                                if let Ok(mut guard) = token_store.lock() {
                                    *guard = Some(token);
                                }
                                ready_store.store(true, Ordering::SeqCst);
                                eprintln!("[meterm] ready signal received");
                            } else {
                                eprintln!("[meterm stdout] {}", trimmed);
                            }
                        }
                    }
                    CommandEvent::Stderr(line) => {
                        let line = String::from_utf8_lossy(&line);
                        eprintln!("[meterm stderr] {}", line.trim());
                    }
                    CommandEvent::Terminated(payload) => {
                        if let Ok(mut guard) = token_store.lock() {
                            *guard = None;
                        }
                        ready_store.store(false, Ordering::SeqCst);
                        let _ = app_handle.emit("meterm-exited", ());
                        eprintln!(
                            "[meterm] process terminated: code={:?} signal={:?}",
                            payload.code, payload.signal
                        );
                        break;
                    }
                    CommandEvent::Error(err) => {
                        if let Ok(mut guard) = token_store.lock() {
                            *guard = None;
                        }
                        ready_store.store(false, Ordering::SeqCst);
                        let _ = app_handle.emit("meterm-exited", ());
                        eprintln!("[meterm] error: {}", err);
                    }
                    _ => {}
                }
            }

            if let Ok(mut guard) = token_store.lock() {
                *guard = None;
            }
            ready_store.store(false, Ordering::SeqCst);
        });

        *self.child.lock().unwrap() = Some(child);
        *self.port.lock().unwrap() = port;
        *self.lan_port.lock().unwrap() = lan_port;

        Ok(port)
    }

    pub fn start_lan_proxy(&self) -> Result<u16, String> {
        self.stop_lan_proxy();
        let sidecar_port = self.port();
        let lan_port = allocate_port()?;
        let listen_addr: std::net::SocketAddr = format!("0.0.0.0:{}", lan_port)
            .parse()
            .map_err(|e| format!("invalid listen addr: {}", e))?;
        let forward_addr: std::net::SocketAddr = format!("127.0.0.1:{}", sidecar_port)
            .parse()
            .map_err(|e| format!("invalid forward addr: {}", e))?;
        let handle = tauri::async_runtime::spawn(async move {
            run_tcp_proxy(listen_addr, forward_addr).await;
        });
        *self.proxy_handle.lock().unwrap() = Some(handle);
        *self.lan_port.lock().unwrap() = lan_port;
        eprintln!(
            "[proxy] LAN proxy started: 0.0.0.0:{} -> 127.0.0.1:{}",
            lan_port, sidecar_port
        );
        Ok(lan_port)
    }

    pub fn stop_lan_proxy(&self) {
        if let Some(handle) = self.proxy_handle.lock().unwrap().take() {
            handle.abort();
            eprintln!("[proxy] LAN proxy stopped");
        }
        let port = self.port();
        *self.lan_port.lock().unwrap() = port;
    }

    pub fn stop(&self) {
        self.stop_lan_proxy();
        if let Some(child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
        }
        self.reset_auth_state();
    }
}

impl Drop for MeTermProcess {
    fn drop(&mut self) {
        self.stop_lan_proxy();
        self.stop();
    }
}

fn allocate_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|addr| addr.port())
        .map_err(|e| format!("failed to allocate port: {}", e))
}

fn parse_ready_token(line: &str) -> Option<String> {
    let prefix = "METERM_READY token=";
    if !line.starts_with(prefix) {
        return None;
    }
    let token = line.trim_start_matches(prefix).trim();
    if token.is_empty() {
        return None;
    }
    Some(token.to_string())
}

// ============================================================================
// Windows WSL Support
// ============================================================================

#[cfg(target_os = "windows")]
fn check_wsl_available() -> Result<(), String> {
    let install_msg = "WSL is not available or no Linux distribution is installed.\n\
                       Please set up WSL 2 with a Linux distribution:\n\n\
                       1. Open PowerShell as Administrator\n\
                       2. Run: wsl --install\n\
                       3. Restart your computer\n\
                       4. Open a terminal and run `wsl` to finish the Linux setup\n\
                       5. Launch this application again\n\n\
                       WSL 不可用或未安装 Linux 发行版。\n\
                       请按以下步骤设置 WSL 2：\n\n\
                       1. 以管理员身份打开 PowerShell\n\
                       2. 运行：wsl --install\n\
                       3. 重启计算机\n\
                       4. 打开终端运行 `wsl` 完成 Linux 初始化设置\n\
                       5. 重新启动本应用";

    // Check that wsl.exe exists and the WSL subsystem is functional.
    // Use timeout to prevent hangs when WSL feature is partially installed.
    let status_output = wsl_output_with_timeout(
        { let mut c = wsl_cmd(); c.arg("--status"); c },
        10,
    )
    .map_err(|_| install_msg.to_string())?;

    if !status_output.status.success() {
        return Err(install_msg.to_string());
    }

    // The most reliable check: actually try to run a command inside WSL.
    // `wsl --status` and `wsl --list` output UTF-16 LE on Windows, making
    // text parsing fragile.  A direct execution test avoids encoding issues
    // and also catches distros that exist but aren't fully initialized.
    //
    // Some WSL distributions (e.g. Alpine) don't have bash installed, but
    // the default login shell may be configured as bash.  `wsl -e` bypasses
    // the login shell and exec's the command directly, so `echo` should work.
    // If it still fails (e.g. WSL internally needs bash for init), fall back
    // to `sh -c "echo ok"` which is available on virtually every distro.
    let test = wsl_output_with_timeout(
        { let mut c = wsl_cmd(); c.args(["-e", "echo", "ok"]); c },
        10,
    )
    .map_err(|_| install_msg.to_string())?;

    if !test.status.success() {
        // `wsl -e echo ok` failed — try via POSIX sh as fallback.
        let test_sh = wsl_output_with_timeout(
            { let mut c = wsl_cmd(); c.args(["-e", "sh", "-c", "echo ok"]); c },
            10,
        )
        .map_err(|_| install_msg.to_string())?;

        if !test_sh.status.success() {
            let stderr = String::from_utf8_lossy(&test.stderr);
            let stderr_sh = String::from_utf8_lossy(&test_sh.stderr);
            let detail = if !stderr.trim().is_empty() || !stderr_sh.trim().is_empty() {
                format!(
                    "\n\nFailed to execute command in WSL.\n\
                     WSL 中执行命令失败。\n\n\
                     Detail / 详情:\n{}\n{}\n\n\
                     This usually means the default WSL distribution is not properly set up,\n\
                     or its default shell (bash) is not installed.\n\
                     这通常意味着默认 WSL 发行版未正确设置，或其默认 shell（bash）未安装。\n\n\
                     Try running in PowerShell / 请在 PowerShell 中尝试：\n\
                     1. wsl --install Ubuntu\n\
                     2. Or: wsl --set-default Ubuntu",
                    stderr.trim(),
                    stderr_sh.trim()
                )
            } else {
                install_msg.to_string()
            };
            return Err(detail);
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn get_wsl_home() -> Result<String, String> {
    // Try multiple methods — `bash` may not exist (e.g. Alpine) or its
    // profile scripts may error out, so we fall back progressively.

    // Method 1: printenv — no shell needed at all.
    if let Ok(output) = wsl_cmd().args(["-e", "printenv", "HOME"]).output() {
        if output.status.success() {
            let home = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !home.is_empty() {
                return Ok(home);
            }
        }
    }

    // Method 2: POSIX sh — available on virtually every distro.
    if let Ok(output) = wsl_cmd().args(["-e", "sh", "-c", "echo ~"]).output() {
        if output.status.success() {
            let home = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !home.is_empty() && home != "~" {
                return Ok(home);
            }
        }
    }

    // Method 3: derive from whoami.
    if let Ok(output) = wsl_cmd().args(["-e", "whoami"]).output() {
        if output.status.success() {
            let user = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !user.is_empty() {
                if user == "root" {
                    return Ok("/root".to_string());
                }
                return Ok(format!("/home/{}", user));
            }
        }
    }

    Err("Failed to detect WSL home directory.\n\
         Please ensure your WSL distribution is fully initialized \
         (open a terminal and run `wsl` to complete setup).\n\n\
         无法获取 WSL 主目录。\n\
         请确保 WSL 发行版已完成初始化（打开终端运行 `wsl` 完成设置）。"
        .to_string())
}

#[cfg(target_os = "windows")]
fn get_binary_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Get the resource directory where Tauri places bundled resources
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource directory: {}", e))?;

    // Look for the Linux binary
    let binary_name = "meterm-server-x86_64-unknown-linux-gnu";
    let binary_path = resource_dir.join("binaries").join(binary_name);

    if !binary_path.exists() {
        // In development mode, try the src-tauri/binaries directory
        let dev_path = resource_dir
            .parent()
            .ok_or("Invalid resource path")?
            .join("src-tauri")
            .join("binaries")
            .join(binary_name);

        if dev_path.exists() {
            return Ok(dev_path);
        }

        return Err(format!(
            "Backend binary not found at {} or {}",
            binary_path.display(),
            dev_path.display()
        ));
    }

    Ok(binary_path)
}

#[cfg(target_os = "windows")]
fn setup_wsl_binary(app: &tauri::AppHandle) -> Result<String, String> {
    let wsl_home = get_wsl_home()?;
    let wsl_target_dir = format!("{}/.meterm", wsl_home);
    let wsl_binary_path = format!("{}/meterm-server", wsl_target_dir);

    // Create directory in WSL
    let mkdir_result = wsl_cmd()
        .args(["-e", "mkdir", "-p", &wsl_target_dir])
        .output()
        .map_err(|e| format!("Failed to create WSL directory: {}", e))?;

    if !mkdir_result.status.success() {
        let stderr = String::from_utf8_lossy(&mkdir_result.stderr);
        return Err(format!(
            "Failed to create .meterm directory in WSL: {}",
            stderr.trim()
        ));
    }

    // Get the Windows path to the binary
    let binary_path = get_binary_path(app)?;
    let windows_path = binary_path
        .to_str()
        .ok_or("Invalid binary path")?
        .to_string();

    // Convert Windows path to WSL path (C:\foo\bar -> /mnt/c/foo/bar)
    let wsl_source_path = convert_to_wsl_path(&windows_path)?;

    // Kill any running meterm-server before overwriting the binary.
    // Without this, `cp` fails with "Text file busy" if the previous app
    // session crashed without cleanly stopping the sidecar.
    let _ = wsl_cmd()
        .args([
            "-e",
            "sh",
            "-c",
            "pkill -x meterm-server 2>/dev/null; sleep 0.3",
        ])
        .output();

    // Copy binary to WSL
    eprintln!(
        "[WSL] Copying binary from {} to {}",
        wsl_source_path, wsl_binary_path
    );
    let cp_result = wsl_cmd()
        .args(["-e", "cp", &wsl_source_path, &wsl_binary_path])
        .output()
        .map_err(|e| format!("Failed to copy binary to WSL: {}", e))?;

    if !cp_result.status.success() {
        let stderr = String::from_utf8_lossy(&cp_result.stderr);
        return Err(format!("Failed to copy binary to WSL: {}", stderr));
    }

    // Make binary executable
    let chmod_result = wsl_cmd()
        .args(["-e", "chmod", "+x", &wsl_binary_path])
        .output()
        .map_err(|e| format!("Failed to chmod binary in WSL: {}", e))?;

    if !chmod_result.status.success() {
        return Err("Failed to make binary executable in WSL".to_string());
    }

    eprintln!("[WSL] Binary deployed successfully to {}", wsl_binary_path);
    Ok(wsl_binary_path)
}

#[cfg(target_os = "windows")]
fn convert_to_wsl_path(windows_path: &str) -> Result<String, String> {
    // Convert Windows path to WSL path
    // C:\foo\bar -> /mnt/c/foo/bar
    let mut path = windows_path.replace('\\', "/");

    // Tauri may return verbatim paths like \\?\C:\foo\bar.
    if let Some(stripped) = path.strip_prefix("//?/") {
        path = stripped.to_string();
    }

    if let Some(drive_letter) = path.chars().next() {
        if path.len() > 2 && path.chars().nth(1) == Some(':') {
            let drive = drive_letter.to_lowercase();
            let rest = &path[2..];
            return Ok(format!("/mnt/{}{}", drive, rest));
        }
    }

    Err(format!("Invalid Windows path format: {}", windows_path))
}

// ============================================================================
// TCP Proxy — bridges LAN (0.0.0.0) → localhost for on-demand LAN sharing
// ============================================================================

async fn run_tcp_proxy(listen_addr: std::net::SocketAddr, forward_addr: std::net::SocketAddr) {
    use tokio::net::TcpListener;

    let listener = match TcpListener::bind(listen_addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[proxy] Failed to bind {}: {}", listen_addr, e);
            return;
        }
    };

    loop {
        let (mut inbound, client_addr) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                eprintln!("[proxy] Accept error: {}", e);
                continue;
            }
        };

        let forward = forward_addr;
        tokio::spawn(async move {
            if let Ok(mut outbound) = tokio::net::TcpStream::connect(forward).await {
                let proxy_header = if client_addr.is_ipv4() {
                    format!(
                        "PROXY TCP4 {} {} {} {}\r\n",
                        client_addr.ip(),
                        forward.ip(),
                        client_addr.port(),
                        forward.port()
                    )
                } else {
                    format!(
                        "PROXY TCP6 {} {} {} {}\r\n",
                        client_addr.ip(),
                        forward.ip(),
                        client_addr.port(),
                        forward.port()
                    )
                };
                if tokio::io::AsyncWriteExt::write_all(&mut outbound, proxy_header.as_bytes())
                    .await
                    .is_ok()
                {
                    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                }
            }
        });
    }
}
