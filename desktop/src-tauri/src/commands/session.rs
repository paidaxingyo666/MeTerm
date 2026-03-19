use tauri::State;
use serde::Serialize;

use crate::sidecar::MeTermProcess;
use super::{auth_client, MeTermConnectionInfo};

#[tauri::command]
pub fn get_meterm_connection_info(
    state: State<'_, MeTermProcess>,
    server_state: State<'_, std::sync::Arc<crate::server::ServerState>>,
) -> Result<MeTermConnectionInfo, String> {
    let use_rust = std::env::var("METERM_RUST_BACKEND").unwrap_or_default() == "1";

    if use_rust {
        // Rust backend mode — return in-process server's port/token
        if !server_state.is_running() {
            return Err("rust backend is not running".into());
        }
        let token = server_state
            .token()
            .ok_or_else(|| "rust backend token not ready".to_string())?;
        Ok(MeTermConnectionInfo {
            port: server_state.port(),
            token,
        })
    } else {
        // Go sidecar mode (original)
        if !state.is_running() {
            return Err("meterm is not running".into());
        }
        let token = state
            .token()
            .ok_or_else(|| "meterm token not ready".to_string())?;
        Ok(MeTermConnectionInfo {
            port: state.port(),
            token,
        })
    }
}

#[tauri::command]
pub fn get_meterm_port(state: State<'_, MeTermProcess>) -> Result<u16, String> {
    if !state.is_running() {
        return Err("meterm is not running".into());
    }
    Ok(state.port())
}

#[tauri::command]
pub fn is_meterm_running(state: State<'_, MeTermProcess>) -> bool {
    state.is_running()
}

#[tauri::command]
pub fn get_pairing_info(state: State<'_, MeTermProcess>) -> Result<String, String> {
    if !state.is_running() {
        return Err("meterm is not running".into());
    }
    let token = state
        .token()
        .ok_or_else(|| "meterm token not ready".to_string())?;

    // Use the LAN-facing port for sharing.  On Windows this is the TCP proxy
    // port that bridges LAN traffic into the WSL2 localhost-only forwarding.
    let port = state.lan_port();

    let host = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "Unknown".to_string());

    let addrs: Vec<String> = local_ip_address::list_afinet_netifas()
        .map(|list| {
            list.into_iter()
                .filter_map(|(_, ip)| {
                    // Only keep private-network IPv4 (RFC 1918) — the addresses
                    // that are actually reachable from a LAN.  This automatically
                    // excludes loopback, link-local/APIPA, public IPs, and any
                    // virtual-adapter addresses (WSL, Hyper-V, Docker, Bluetooth…)
                    // regardless of OS language or adapter naming conventions.
                    let v4 = match ip {
                        std::net::IpAddr::V4(v4) => v4,
                        _ => return None,
                    };
                    let o = v4.octets();
                    let is_private = o[0] == 10                           // 10.0.0.0/8
                        || (o[0] == 172 && (16..=31).contains(&o[1]))     // 172.16.0.0/12
                        || (o[0] == 192 && o[1] == 168);                  // 192.168.0.0/16
                    is_private.then(|| format!("{}:{}", v4, port))
                })
                .collect()
        })
        .unwrap_or_default();

    let info = serde_json::json!({
        "v": 1,
        "addrs": addrs,
        "token": token,
        "name": host,
    });

    Ok(info.to_string())
}

#[tauri::command]
pub async fn create_session(
    state: State<'_, MeTermProcess>,
    shell: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/sessions", port);
    let client = auth_client(&state)?;

    let mut body = serde_json::Map::new();
    if let Some(s) = shell {
        body.insert("shell".into(), serde_json::Value::String(s));
    }
    if let Some(c) = cwd {
        body.insert("cwd".into(), serde_json::Value::String(c));
    }
    let body_empty = body.is_empty();
    let mut req = client.post(&url);
    if !body_empty {
        req = req.json(&serde_json::Value::Object(body));
    }

    eprintln!("[cmd] create_session: POST {} body_empty={}", url, body_empty);
    let resp = req.send().await.map_err(|e| {
        eprintln!("[cmd] create_session send error: {}", e);
        e.to_string()
    })?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    eprintln!("[cmd] create_session response: {} {}", status, body);
    if !status.is_success() {
        return Err(format!("session create failed ({}): {}", status.as_u16(), body));
    }
    if body.is_empty() {
        return Err("session create failed: empty response".to_string());
    }
    Ok(body)
}

#[tauri::command]
pub async fn list_sessions(state: State<'_, MeTermProcess>) -> Result<String, String> {
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/sessions", port);
    let client = auth_client(&state)?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_session(
    state: State<'_, MeTermProcess>,
    session_id: String,
) -> Result<String, String> {
    super::validate_id(&session_id)?;
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/sessions/{}", port, session_id);
    let client = auth_client(&state)?;

    let resp = client
        .delete(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.text().await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct ShellInfo {
    pub path: String,
    pub name: String,
    pub is_default: bool,
}

#[tauri::command]
pub fn list_available_shells() -> Vec<ShellInfo> {
    let mut shells = Vec::new();

    #[cfg(not(target_os = "windows"))]
    {
        let default_shell = std::env::var("SHELL").unwrap_or_default();

        // Read /etc/shells
        if let Ok(content) = std::fs::read_to_string("/etc/shells") {
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if std::path::Path::new(line).exists() {
                    let name = std::path::Path::new(line)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(line)
                        .to_string();
                    shells.push(ShellInfo {
                        path: line.to_string(),
                        is_default: line == default_shell,
                        name,
                    });
                }
            }
        }
        // Ensure at least bash is present
        if shells.is_empty() {
            if std::path::Path::new("/bin/bash").exists() {
                shells.push(ShellInfo {
                    path: "/bin/bash".to_string(),
                    name: "bash".to_string(),
                    is_default: default_shell == "/bin/bash",
                });
            }
            if std::path::Path::new("/bin/sh").exists() {
                shells.push(ShellInfo {
                    path: "/bin/sh".to_string(),
                    name: "sh".to_string(),
                    is_default: default_shell == "/bin/sh",
                });
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;

        /// Wait for a child process with a timeout, polling every 50ms.
        fn wait_with_timeout(child: &mut std::process::Child, timeout: std::time::Duration) -> Option<std::process::ExitStatus> {
            let start = std::time::Instant::now();
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => return Some(status),
                    Ok(None) => {
                        if start.elapsed() >= timeout {
                            let _ = child.kill();
                            let _ = child.wait();
                            return None;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    Err(_) => return None,
                }
            }
        }

        /// Run a subprocess with a 3-second timeout to prevent blocking the UI.
        fn try_shell(exe: &str, test_args: &[&str]) -> bool {
            let mut cmd = Command::new(exe);
            cmd.args(test_args);
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            match cmd.spawn() {
                Ok(mut child) => {
                    wait_with_timeout(&mut child, std::time::Duration::from_secs(3))
                        .map(|s| s.success())
                        .unwrap_or(false)
                }
                Err(_) => false,
            }
        }

        /// Run a command and capture output with a timeout.
        /// Reads stdout/stderr in separate threads to prevent pipe-buffer deadlock
        /// (child blocks writing to a full pipe while we wait for it to exit).
        fn output_with_timeout(cmd: &mut Command, timeout: std::time::Duration) -> Option<std::process::Output> {
            use std::io::Read;
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            let mut child = cmd.spawn().ok()?;

            // Take pipe handles BEFORE waiting — readers drain the pipes concurrently
            // so the child never blocks on a full buffer.
            let stdout_handle = child.stdout.take();
            let stderr_handle = child.stderr.take();

            let stdout_thread = std::thread::spawn(move || {
                let mut buf = Vec::new();
                if let Some(mut r) = stdout_handle { let _ = r.read_to_end(&mut buf); }
                buf
            });
            let stderr_thread = std::thread::spawn(move || {
                let mut buf = Vec::new();
                if let Some(mut r) = stderr_handle { let _ = r.read_to_end(&mut buf); }
                buf
            });

            let status = wait_with_timeout(&mut child, timeout);

            // I/O threads finish once the child exits (or is killed by timeout).
            let stdout = stdout_thread.join().unwrap_or_default();
            let stderr = stderr_thread.join().unwrap_or_default();

            status.map(|s| std::process::Output { status: s, stdout, stderr })
        }

        // PowerShell 7 (pwsh) — default on Windows
        if try_shell("pwsh.exe", &["--version"]) {
            shells.push(ShellInfo {
                path: "pwsh.exe".to_string(),
                name: "PowerShell 7".to_string(),
                is_default: true,
            });
        }

        // Windows PowerShell 5
        let has_pwsh = shells.iter().any(|s| s.is_default);
        if try_shell("powershell.exe", &["-Command", "echo ok"]) {
            shells.push(ShellInfo {
                path: "powershell.exe".to_string(),
                name: "Windows PowerShell".to_string(),
                is_default: !has_pwsh,
            });
        }

        // cmd.exe
        if try_shell("cmd.exe", &["/C", "echo ok"]) {
            shells.push(ShellInfo {
                path: "cmd.exe".to_string(),
                name: "Command Prompt".to_string(),
                is_default: false,
            });
        }

        // Git Bash — try multiple detection methods
        let git_bash: Option<String> = (|| {
            // 1. Common installation paths
            for p in &[
                r"C:\Program Files\Git\bin\bash.exe",
                r"C:\Program Files (x86)\Git\bin\bash.exe",
            ] {
                if std::path::Path::new(p).exists() {
                    return Some(p.to_string());
                }
            }

            // 2. Find git.exe in PATH → derive bash.exe location
            //    git.exe is at <install>/cmd/git.exe, bash.exe is at <install>/bin/bash.exe
            let mut where_cmd = Command::new("where");
            where_cmd.arg("git.exe");
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                where_cmd.creation_flags(0x08000000);
            }
            if let Some(out) = output_with_timeout(&mut where_cmd, std::time::Duration::from_secs(3)) {
                if out.status.success() {
                    if let Ok(text) = String::from_utf8(out.stdout) {
                        if let Some(git_path) = text.lines().next() {
                            let git_exe = std::path::Path::new(git_path.trim());
                            if let Some(install_dir) = git_exe.parent().and_then(|p| p.parent()) {
                                let bash = install_dir.join("bin").join("bash.exe");
                                if bash.exists() {
                                    return Some(bash.to_string_lossy().to_string());
                                }
                            }
                        }
                    }
                }
            }

            // 3. Registry: HKLM\SOFTWARE\GitForWindows\InstallPath
            let mut reg_cmd = Command::new("reg");
            reg_cmd.args(&["query", r"HKLM\SOFTWARE\GitForWindows", "/v", "InstallPath"]);
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                reg_cmd.creation_flags(0x08000000);
            }
            if let Some(out) = output_with_timeout(&mut reg_cmd, std::time::Duration::from_secs(3)) {
                if out.status.success() {
                    if let Ok(text) = String::from_utf8(out.stdout) {
                        for line in text.lines() {
                            if line.contains("InstallPath") {
                                if let Some(path_str) = line.split("REG_SZ").nth(1) {
                                    let bash = std::path::Path::new(path_str.trim())
                                        .join("bin")
                                        .join("bash.exe");
                                    if bash.exists() {
                                        return Some(bash.to_string_lossy().to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }

            None
        })();
        if let Some(bash_path) = git_bash {
            shells.push(ShellInfo {
                path: bash_path,
                name: "Git Bash".to_string(),
                is_default: false,
            });
        }

        // Discover additional shells from Windows Terminal profile fragments.
        // Apps like VS 2022, Azure CLI, etc. register profiles as JSON fragments in:
        //   %LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\<app>\*.json
        //   %ProgramData%\Microsoft\Windows Terminal\Fragments\<app>\*.json
        {
            let known_names: std::collections::HashSet<String> = shells.iter()
                .map(|s| s.name.to_lowercase())
                .collect();
            let known_cmds: std::collections::HashSet<String> = shells.iter()
                .map(|s| s.path.to_lowercase())
                .collect();

            let mut frag_dirs = Vec::new();
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                frag_dirs.push(std::path::PathBuf::from(&local).join(r"Microsoft\Windows Terminal\Fragments"));
            }
            if let Ok(pdata) = std::env::var("ProgramData") {
                frag_dirs.push(std::path::PathBuf::from(&pdata).join(r"Microsoft\Windows Terminal\Fragments"));
            }

            for frag_dir in &frag_dirs {
                let Ok(apps) = std::fs::read_dir(frag_dir) else { continue };
                for app_entry in apps.flatten() {
                    let app_path = app_entry.path();
                    if !app_path.is_dir() { continue; }
                    let Ok(files) = std::fs::read_dir(&app_path) else { continue };
                    for file_entry in files.flatten() {
                        let fp = file_entry.path();
                        if fp.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
                        let Ok(content) = std::fs::read_to_string(&fp) else { continue };
                        let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else { continue };
                        let Some(profiles) = json.get("profiles").and_then(|p| p.as_array()) else { continue };
                        for profile in profiles {
                            let Some(name) = profile.get("name").and_then(|n| n.as_str()) else { continue };
                            let Some(cmdline) = profile.get("commandline").and_then(|c| c.as_str()) else { continue };
                            let cmdline = cmdline.trim();
                            if cmdline.is_empty() { continue; }
                            // Skip if already detected (by name or command path)
                            if known_names.contains(&name.to_lowercase()) { continue; }
                            let first_token = cmdline.split_whitespace().next().unwrap_or(cmdline)
                                .trim_matches('"').to_lowercase();
                            if known_cmds.contains(&first_token) { continue; }
                            // Validate: check that the executable exists
                            let exe_path = first_token.replace('/', r"\");
                            let exe_exists = std::path::Path::new(&exe_path).exists()
                                || {
                                    let mut wh = Command::new("where");
                                    wh.arg(&exe_path);
                                    #[cfg(target_os = "windows")]
                                    { use std::os::windows::process::CommandExt; wh.creation_flags(0x08000000); }
                                    output_with_timeout(&mut wh, std::time::Duration::from_secs(2))
                                        .map(|o| o.status.success()).unwrap_or(false)
                                };
                            if !exe_exists {
                                // For cmd /k "batch.bat" patterns, validate the batch file
                                let valid = if first_token.ends_with("cmd.exe") || first_token == "cmd" {
                                    true // cmd.exe always exists, the batch file is the arg
                                } else {
                                    false
                                };
                                if !valid { continue; }
                            }
                            shells.push(ShellInfo {
                                path: cmdline.to_string(),
                                name: name.to_string(),
                                is_default: false,
                            });
                        }
                    }
                }
            }
        }

        // Visual Studio Developer shells — detected via vswhere.exe
        // VS profiles are NOT registered as WT fragments; they use a built-in
        // dynamic profile generator via COM ISetupConfiguration API.
        // We replicate the same detection using vswhere.exe.
        {
            let vswhere = std::path::PathBuf::from(
                std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".to_string())
            ).join(r"Microsoft Visual Studio\Installer\vswhere.exe");

            if vswhere.exists() {
                let mut cmd = Command::new(&vswhere);
                cmd.args(&["-all", "-prerelease", "-format", "json"]);
                #[cfg(target_os = "windows")]
                {
                    use std::os::windows::process::CommandExt;
                    cmd.creation_flags(0x08000000);
                }
                if let Some(out) = output_with_timeout(&mut cmd, std::time::Duration::from_secs(5)) {
                    if out.status.success() {
                        if let Ok(text) = String::from_utf8(out.stdout) {
                            if let Ok(instances) = serde_json::from_str::<Vec<serde_json::Value>>(&text) {
                                for inst in &instances {
                                    let Some(path) = inst.get("installationPath").and_then(|v| v.as_str()) else { continue };
                                    let display = inst.get("displayName").and_then(|v| v.as_str()).unwrap_or("Visual Studio");

                                    // Developer Command Prompt
                                    let vsdevcmd = std::path::Path::new(path).join(r"Common7\Tools\VsDevCmd.bat");
                                    if vsdevcmd.exists() {
                                        shells.push(ShellInfo {
                                            path: format!(r#"cmd.exe /k "{}""#, vsdevcmd.to_string_lossy()),
                                            name: format!("Developer CMD - {}", display),
                                            is_default: false,
                                        });
                                    }

                                    // Developer PowerShell
                                    let devshell_dll = std::path::Path::new(path)
                                        .join(r"Common7\Tools\Microsoft.VisualStudio.DevShell.dll");
                                    if devshell_dll.exists() {
                                        shells.push(ShellInfo {
                                            path: format!(
                                                r#"powershell.exe -NoExit -Command "& {{Import-Module '{}'; Enter-VsDevShell -VsInstallPath '{}' -SkipAutomaticLocation}}""#,
                                                devshell_dll.to_string_lossy(),
                                                path
                                            ),
                                            name: format!("Developer PS - {}", display),
                                            is_default: false,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // WSL — list all installed distros
        {
            let mut cmd = Command::new("wsl.exe");
            cmd.args(&["--list", "--quiet"]);
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000);
            }
            if let Some(out) = output_with_timeout(&mut cmd, std::time::Duration::from_secs(5)) {
                if out.status.success() {
                    // wsl --list always outputs UTF-16LE on Windows.
                    // UTF-16LE ASCII looks like 'U\x00b\x00...' which passes
                    // String::from_utf8 but produces garbled text with \0 bytes.
                    // Always decode as UTF-16LE first.
                    let bytes = &out.stdout;
                    let is_utf16 = bytes.len() >= 2
                        && (bytes.len() % 2 == 0)
                        && (bytes[0] == 0xFF && bytes[1] == 0xFE  // BOM
                            || bytes.len() >= 4 && bytes[1] == 0x00);  // ASCII in UTF-16LE
                    let text = if is_utf16 {
                        let u16s: Vec<u16> = bytes
                            .chunks_exact(2)
                            .map(|c| u16::from_le_bytes([c[0], c[1]]))
                            .collect();
                        String::from_utf16_lossy(&u16s)
                    } else {
                        String::from_utf8_lossy(bytes).into_owned()
                    };
                    for line in text.lines() {
                        let distro = line.trim().trim_start_matches('\u{feff}');
                        if distro.is_empty() || distro.contains('\0') {
                            continue;
                        }
                        shells.push(ShellInfo {
                            path: format!("wsl.exe -d {}", distro),
                            name: format!("WSL: {}", distro),
                            is_default: false,
                        });
                    }
                }
            }
        }
    }

    shells
}
