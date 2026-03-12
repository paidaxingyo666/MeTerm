use tauri::State;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Manager,
};
#[cfg(not(target_os = "windows"))]
use tauri::menu::Submenu;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};

use crate::{sidecar::MeTermProcess, AppLifecycleState};

/// Validates that an ID string (session_id, client_id) contains only safe characters.
fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("invalid id length".to_string());
    }
    if id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        Ok(())
    } else {
        Err("invalid id format".to_string())
    }
}

/// Validates that a string is a valid IP address.
fn validate_ip(ip: &str) -> Result<(), String> {
    ip.parse::<std::net::IpAddr>()
        .map(|_| ())
        .map_err(|_| "invalid IP address".to_string())
}

#[derive(Serialize)]
pub struct MeTermConnectionInfo {
    port: u16,
    token: String,
}

fn make_auth_headers(token: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    let value = HeaderValue::from_str(&format!("Bearer {}", token)).map_err(|e| e.to_string())?;
    headers.insert(AUTHORIZATION, value);
    Ok(headers)
}

fn auth_client(state: &MeTermProcess) -> Result<reqwest::Client, String> {
    let token = state
        .token()
        .ok_or_else(|| "meterm token not ready".to_string())?;
    let headers = make_auth_headers(&token)?;
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_meterm_connection_info(state: State<'_, MeTermProcess>) -> Result<MeTermConnectionInfo, String> {
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

fn tray_label(language: &str, key: &str) -> &'static str {
    match (language, key) {
        ("zh", "new_window") => "新窗口",
        ("zh", "show_home") => "显示主页",
        ("zh", "new_terminal") => "新建终端",
        ("zh", "new_private_terminal") => "新建私有终端",
        ("zh", "settings") => "设置",
        ("zh", "close_all_sessions") => "关闭所有会话",
        ("zh", "quit") => "关闭窗口",
        ("zh", "quit_all") => "退出应用",
        ("zh", "import_connections") => "导入连接",
        ("zh", "export_connections") => "导出连接",
        ("zh", "lan_discover") => "局域网发现",
        ("zh", "check_updates") => "检查更新",
        (_, "new_window") => "New Window",
        (_, "show_home") => "Show Home",
        (_, "new_terminal") => "New Terminal",
        (_, "new_private_terminal") => "New Private Terminal",
        (_, "settings") => "Settings",
        (_, "close_all_sessions") => "Close All Sessions",
        (_, "quit") => "Close Window",
        (_, "quit_all") => "Quit Application",
        (_, "import_connections") => "Import Connections",
        (_, "export_connections") => "Export Connections",
        (_, "lan_discover") => "LAN Discovery",
        (_, "check_updates") => "Check for Updates",
        _ => "",
    }
}

/// Build the "Check for Updates" menu item label, appending a badge dot
/// when a pending update version is known.
fn build_check_updates_label(language: &str, pending_version: Option<&str>) -> String {
    let base = tray_label(language, "check_updates");
    match pending_version {
        Some(v) => format!("{} ● (v{})", base, v),
        None => base.to_string(),
    }
}

/// Same as build_check_updates_label but for the native app menu bar.
#[cfg(not(target_os = "windows"))]
fn build_check_updates_app_label(language: &str, pending_version: Option<&str>) -> String {
    let base = app_label(language, "check_updates");
    match pending_version {
        Some(v) => format!("{} ● (v{})", base, v),
        None => base.to_string(),
    }
}

#[cfg(not(target_os = "windows"))]
fn app_label(language: &str, key: &str) -> &'static str {
    match (language, key) {
        ("zh", "app") => "应用",
        ("zh", "file") => "文件",
        ("zh", "edit") => "编辑",
        ("zh", "view") => "视图",
        ("zh", "window") => "窗口",
        ("zh", "help") => "帮助",
        ("zh", "new_window") => "新窗口",
        ("zh", "show_home") => "显示主页",
        ("zh", "new_terminal") => "新建终端",
        ("zh", "settings") => "设置",
        ("zh", "close_all_sessions") => "关闭所有会话",
        ("zh", "quit") => "退出",
        ("zh", "undo") => "撤销",
        ("zh", "redo") => "重做",
        ("zh", "cut") => "剪切",
        ("zh", "copy") => "复制",
        ("zh", "paste") => "粘贴",
        ("zh", "select_all") => "全选",
        ("zh", "reload") => "重新载入",
        ("zh", "show_about") => "关于 MeTerm",
        ("zh", "show_shortcuts") => "快捷键",
        ("zh", "check_updates") => "检查更新",
        (_, "app") => "App",
        (_, "file") => "File",
        (_, "edit") => "Edit",
        (_, "view") => "View",
        (_, "window") => "Window",
        (_, "help") => "Help",
        (_, "new_window") => "New Window",
        (_, "show_home") => "Show Home",
        (_, "new_terminal") => "New Terminal",
        (_, "settings") => "Settings",
        (_, "close_all_sessions") => "Close All Sessions",
        (_, "quit") => "Quit",
        (_, "undo") => "Undo",
        (_, "redo") => "Redo",
        (_, "cut") => "Cut",
        (_, "copy") => "Copy",
        (_, "paste") => "Paste",
        (_, "select_all") => "Select All",
        (_, "reload") => "Reload",
        (_, "show_about") => "About MeTerm",
        (_, "show_shortcuts") => "Keyboard Shortcuts",
        (_, "check_updates") => "Check for Updates",
        _ => "",
    }
}

#[cfg(target_os = "windows")]
pub fn set_app_menu_language(app: &AppHandle, _language: &str) -> Result<(), String> {
    // Windows uses custom in-app menu in the toolbar.
    // Remove native menu so no system menubar/accelerators are shown.
    // This operation should be idempotent; if the menu is already removed,
    // we keep going instead of treating it as a hard failure.
    if let Err(e) = app.remove_menu() {
        eprintln!("[DEBUG] remove_menu ignored on Windows: {}", e);
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn set_app_menu_language(app: &AppHandle, language: &str) -> Result<(), String> {
    let pending_version = app
        .try_state::<crate::AppLifecycleState>()
        .and_then(|s| s.pending_update());
    let app_settings_item = MenuItem::with_id(app, "settings", app_label(language, "settings"), true, Some("CmdOrCtrl+,"))
        .map_err(|e| e.to_string())?;
    let app_quit_item = MenuItem::with_id(app, "quit", app_label(language, "quit"), true, Some("CmdOrCtrl+Q"))
        .map_err(|e| e.to_string())?;
    let app_sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let app_submenu = Submenu::with_items(app, app_label(language, "app"), true, &[&app_settings_item, &app_sep, &app_quit_item])
        .map_err(|e| e.to_string())?;

    let file_new_window_item = MenuItem::with_id(app, "new_window", app_label(language, "new_window"), true, Some("CmdOrCtrl+N"))
        .map_err(|e| e.to_string())?;
    let file_new_terminal_item = MenuItem::with_id(app, "new_terminal", app_label(language, "new_terminal"), true, Some("CmdOrCtrl+T"))
        .map_err(|e| e.to_string())?;
    let file_show_home_item = MenuItem::with_id(app, "show_home", app_label(language, "show_home"), true, Some("CmdOrCtrl+1"))
        .map_err(|e| e.to_string())?;
    let file_close_all_item = MenuItem::with_id(app, "close_all_sessions", app_label(language, "close_all_sessions"), true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let file_sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let file_submenu = Submenu::with_items(
        app,
        app_label(language, "file"),
        true,
        &[&file_new_window_item, &file_new_terminal_item, &file_show_home_item, &file_sep, &file_close_all_item],
    )
    .map_err(|e| e.to_string())?;

    let edit_undo_item = MenuItem::with_id(app, "undo", app_label(language, "undo"), true, Some("CmdOrCtrl+Z"))
        .map_err(|e| e.to_string())?;
    let edit_redo_item = MenuItem::with_id(app, "redo", app_label(language, "redo"), true, Some("CmdOrCtrl+Shift+Z"))
        .map_err(|e| e.to_string())?;
    let edit_cut_item = MenuItem::with_id(app, "cut", app_label(language, "cut"), true, Some("CmdOrCtrl+X"))
        .map_err(|e| e.to_string())?;
    let edit_copy_item = MenuItem::with_id(app, "copy", app_label(language, "copy"), true, Some("CmdOrCtrl+C"))
        .map_err(|e| e.to_string())?;
    let edit_paste_item = MenuItem::with_id(app, "paste", app_label(language, "paste"), true, Some("CmdOrCtrl+V"))
        .map_err(|e| e.to_string())?;
    let edit_select_all_item = MenuItem::with_id(app, "select_all", app_label(language, "select_all"), true, Some("CmdOrCtrl+A"))
        .map_err(|e| e.to_string())?;
    let edit_sep1 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let edit_sep2 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let edit_submenu = Submenu::with_items(
        app,
        app_label(language, "edit"),
        true,
        &[&edit_undo_item, &edit_redo_item, &edit_sep1, &edit_cut_item, &edit_copy_item, &edit_paste_item, &edit_sep2, &edit_select_all_item],
    )
    .map_err(|e| e.to_string())?;

    let view_show_home_item = MenuItem::with_id(app, "show_home", app_label(language, "show_home"), true, Some("CmdOrCtrl+1"))
        .map_err(|e| e.to_string())?;
    let view_reload_item = MenuItem::with_id(app, "reload", app_label(language, "reload"), true, Some("CmdOrCtrl+R"))
        .map_err(|e| e.to_string())?;
    let view_submenu = Submenu::with_items(app, app_label(language, "view"), true, &[&view_show_home_item, &view_reload_item])
        .map_err(|e| e.to_string())?;

    let window_new_window_item = MenuItem::with_id(app, "new_window", app_label(language, "new_window"), true, Some("CmdOrCtrl+N"))
        .map_err(|e| e.to_string())?;
    let window_show_home_item = MenuItem::with_id(app, "show_home", app_label(language, "show_home"), true, Some("CmdOrCtrl+1"))
        .map_err(|e| e.to_string())?;
    let window_new_terminal_item = MenuItem::with_id(app, "new_terminal", app_label(language, "new_terminal"), true, Some("CmdOrCtrl+T"))
        .map_err(|e| e.to_string())?;
    let window_settings_item = MenuItem::with_id(app, "settings", app_label(language, "settings"), true, Some("CmdOrCtrl+,"))
        .map_err(|e| e.to_string())?;
    let window_submenu = Submenu::with_items(
        app,
        app_label(language, "window"),
        true,
        &[&window_new_window_item, &window_show_home_item, &window_new_terminal_item, &window_settings_item],
    )
    .map_err(|e| e.to_string())?;

    let help_about_item = MenuItem::with_id(app, "show_about", app_label(language, "show_about"), true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let help_shortcuts_item = MenuItem::with_id(app, "show_shortcuts", app_label(language, "show_shortcuts"), true, Some("CmdOrCtrl+/"))
        .map_err(|e| e.to_string())?;
    let check_updates_label = build_check_updates_app_label(language, pending_version.as_deref());
    let help_check_updates_item = MenuItem::with_id(app, "check_updates", check_updates_label.as_str(), true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let help_sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let help_submenu = Submenu::with_items(app, app_label(language, "help"), true, &[&help_check_updates_item, &help_sep, &help_about_item, &help_shortcuts_item])
        .map_err(|e| e.to_string())?;

    let menu = Menu::with_items(
        app,
        &[&app_submenu, &file_submenu, &edit_submenu, &view_submenu, &window_submenu, &help_submenu],
    )
    .map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
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
    let mut req = client.post(&url);
    if !body.is_empty() {
        req = req.json(&serde_json::Value::Object(body));
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("session create failed ({}): {}", status.as_u16(), body));
    }
    if body.is_empty() {
        return Err("session create failed: empty response".to_string());
    }
    Ok(body)
}

#[derive(serde::Serialize)]
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

        fn try_shell(exe: &str, test_args: &[&str]) -> bool {
            let mut cmd = Command::new(exe);
            cmd.args(test_args);
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            cmd.output().map(|o| o.status.success()).unwrap_or(false)
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
            if let Ok(out) = where_cmd.output() {
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
            if let Ok(out) = reg_cmd.output() {
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
                                || Command::new("where").arg(&exe_path)
                                    .output().map(|o| o.status.success()).unwrap_or(false);
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
                if let Ok(out) = cmd.output() {
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
            if let Ok(out) = cmd.output() {
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

#[tauri::command]
pub async fn create_ssh_session(
    state: State<'_, MeTermProcess>,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    trusted_fingerprint: Option<String>,
    skip_shell_hook: Option<bool>,
) -> Result<String, String> {
    let meterm_port = state.port();
    let url = format!("http://127.0.0.1:{}/api/sessions/ssh", meterm_port);
    let client = auth_client(&state)?;

    let body = serde_json::json!({
        "host": host,
        "port": port,
        "username": username,
        "auth_method": auth_method,
        "password": password.unwrap_or_default(),
        "private_key": private_key.unwrap_or_default(),
        "passphrase": passphrase.unwrap_or_default(),
        "trusted_fingerprint": trusted_fingerprint.unwrap_or_default(),
        "skip_shell_hook": skip_shell_hook.unwrap_or(false),
    });

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;

    // Return host key errors as structured JSON (409 Conflict) instead of generic error
    if status.as_u16() == 409 {
        return Ok(text);
    }

    if !status.is_success() {
        return Err(text);
    }

    Ok(text)
}

#[tauri::command]
pub async fn test_ssh_connection(
    state: State<'_, MeTermProcess>,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    password: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    trusted_fingerprint: Option<String>,
) -> Result<String, String> {
    let meterm_port = state.port();
    let url = format!("http://127.0.0.1:{}/api/sessions/ssh/test", meterm_port);
    let client = auth_client(&state)?;

    let body = serde_json::json!({
        "host": host,
        "port": port,
        "username": username,
        "auth_method": auth_method,
        "password": password.unwrap_or_default(),
        "private_key": private_key.unwrap_or_default(),
        "passphrase": passphrase.unwrap_or_default(),
        "trusted_fingerprint": trusted_fingerprint.unwrap_or_default(),
    });

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;

    // Return host key errors as structured JSON (409 Conflict)
    if status.as_u16() == 409 {
        return Ok(text);
    }

    if !status.is_success() {
        // Return a valid JSON error so frontend can parse it
        return Ok(serde_json::json!({"ok": false, "error": text}).to_string());
    }

    Ok(text)
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
    validate_id(&session_id)?;
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

#[tauri::command]
pub fn set_tray_language(app: AppHandle, language: String) -> Result<(), String> {
    // Store the language in app state
    let lifecycle = app.state::<crate::AppLifecycleState>();
    lifecycle.set_language(language.clone());
    let pending_version = lifecycle.pending_update();

    let tray = app
        .tray_by_id("main-tray")
        .ok_or_else(|| "tray icon not found".to_string())?;

    let new_window_item = MenuItem::with_id(
        &app,
        "new_window",
        tray_label(&language, "new_window"),
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let show_home_item = MenuItem::with_id(
        &app,
        "show_home",
        tray_label(&language, "show_home"),
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let new_terminal_item = MenuItem::with_id(
        &app,
        "new_terminal",
        tray_label(&language, "new_terminal"),
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let new_private_terminal_item = MenuItem::with_id(
        &app,
        "new_private_terminal",
        tray_label(&language, "new_private_terminal"),
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let settings_item = MenuItem::with_id(
        &app,
        "settings",
        tray_label(&language, "settings"),
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let import_connections_item = MenuItem::with_id(
        &app,
        "import_connections",
        tray_label(&language, "import_connections"),
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let export_connections_item = MenuItem::with_id(
        &app,
        "export_connections",
        tray_label(&language, "export_connections"),
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let close_all_sessions_item = MenuItem::with_id(
        &app,
        "close_all_sessions",
        tray_label(&language, "close_all_sessions"),
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let quit_item = MenuItem::with_id(
        &app,
        "quit",
        tray_label(&language, "quit"),
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let quit_all_item = MenuItem::with_id(
        &app,
        "quit_all",
        tray_label(&language, "quit_all"),
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;

    let checked = lifecycle.is_discoverable();
    let lan_discover_item = CheckMenuItem::with_id(
        &app,
        "lan_discover",
        tray_label(&language, "lan_discover"),
        true,
        checked,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;

    let check_updates_label = build_check_updates_label(&language, pending_version.as_deref());
    let check_updates_item = MenuItem::with_id(
        &app,
        "check_updates",
        check_updates_label.as_str(),
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;

    let separator = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    let separator2 = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    let separator3 = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    let separator4 = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;

    let menu = Menu::with_items(
        &app,
        &[
            &new_window_item,
            &show_home_item,
            &new_terminal_item,
            &new_private_terminal_item,
            &settings_item,
            &separator3,
            &lan_discover_item,
            &separator2,
            &import_connections_item,
            &export_connections_item,
            &close_all_sessions_item,
            &separator4,
            &check_updates_item,
            &separator,
            &quit_item,
            &quit_all_item,
        ],
    )
    .map_err(|e| e.to_string())?;

    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    set_app_menu_language(&app, &language)?;
    Ok(())
}

/// Called from the frontend when an update is found (or cleared).
/// Updates the tray and native menu bar to show/hide the badge indicator.
#[tauri::command]
pub fn set_update_badge(app: AppHandle, state: State<'_, AppLifecycleState>, version: Option<String>) -> Result<(), String> {
    state.set_pending_update(version);
    let lang = state.current_language();
    set_tray_language(app, lang)
}

#[tauri::command]
pub fn request_app_quit(app: AppHandle, state: State<'_, AppLifecycleState>) {
    state.mark_quitting();
    app.exit(0);
}

/// Restart the meterm sidecar in-place. Called by the frontend when it detects
/// the sidecar has crashed (meterm-exited event) and wants to auto-recover
/// instead of quitting the app.
#[tauri::command]
pub async fn restart_meterm(
    app: AppHandle,
    meterm: State<'_, MeTermProcess>,
) -> Result<(), String> {
    meterm.stop();
    // Brief pause to allow the OS to release the port before rebinding.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    meterm.start(&app).map(|_| ())
}

#[tauri::command]
pub fn hide_main_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
pub fn set_has_open_tabs(state: State<'_, AppLifecycleState>, has_open_tabs: bool) {
    state.set_has_open_tabs(has_open_tabs);
}

#[tauri::command]
pub fn allow_window_close(app: AppHandle, window_label: String) -> Result<(), String> {
    let lifecycle = app.state::<crate::AppLifecycleState>();
    lifecycle.allow_window_close(&window_label);
    eprintln!("[DEBUG] Window {} marked as allowed to close", window_label);
    Ok(())
}

#[tauri::command]
pub fn mark_window_initialized(app: AppHandle, window_label: String) {
    let lifecycle = app.state::<crate::AppLifecycleState>();
    lifecycle.mark_window_initialized(&window_label);
    crate::startup_log(&format!("mark_window_initialized: {}", window_label));
    eprintln!("[DEBUG] Window {} marked as initialized", window_label);
}

#[derive(Serialize)]
pub struct WindowGeometry {
    pub label: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[tauri::command]
pub fn get_all_window_geometries(app: AppHandle) -> Result<Vec<WindowGeometry>, String> {
    let mut geometries = Vec::new();
    for (label, window) in app.webview_windows() {
        if label == "settings" {
            continue;
        }
        let scale = window.scale_factor().unwrap_or(1.0);
        let pos = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        geometries.push(WindowGeometry {
            label: label.to_string(),
            x: pos.x as f64 / scale,
            y: pos.y as f64 / scale,
            width: size.width as f64 / scale,
            height: size.height as f64 / scale,
        });
    }
    Ok(geometries)
}

#[tauri::command]
pub fn create_window_at_position(app: AppHandle, x: f64, y: f64) -> Result<String, String> {
    crate::startup_log(&format!("create_window_at_position: x={}, y={}", x, y));
    use tauri::WebviewWindowBuilder;
    use tauri::WebviewUrl;
    #[cfg(target_os = "macos")]
    use tauri::TitleBarStyle;

    let window_label = format!(
        "window-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    );

    let width = 1000.0_f64;
    let height = 700.0_f64;
    let win_x = (x - width / 2.0).max(0.0);
    let win_y = (y - 30.0).max(0.0);

    let url = WebviewUrl::default();

    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(&app, &window_label, url)
        .title("MeTerm")
        .inner_size(width, height)
        .position(win_x, win_y)
        .resizable(true)
        .decorations(true)
        .transparent(true);

    #[cfg(target_os = "macos")]
    {
        use tauri::LogicalPosition;
        builder = builder
            .hidden_title(true)
            .accept_first_mouse(true)
            .title_bar_style(TitleBarStyle::Overlay)
            .traffic_light_position(LogicalPosition::new(14.0, 18.0));
    }

    // On Windows: disable both native chrome and window-level transparency.
    // WebView2 does not reliably initialise the Direct Composition transparent
    // compositor for dynamically created windows, leaving them permanently white.
    // The app's dark background is fully CSS-driven, so native transparency is
    // not required.
    #[cfg(target_os = "windows")]
    {
        builder = builder.decorations(false).transparent(false);
    }
    builder.build().map_err(|e| e.to_string())?;

    Ok(window_label)
}

#[tauri::command]
pub fn get_window_position(window: tauri::Window) -> Result<(f64, f64), String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    Ok((pos.x as f64 / scale, pos.y as f64 / scale))
}

/// Attach a child window to a parent so it follows the parent's movement (macOS native).
/// On non-macOS platforms this is a no-op.
#[tauri::command]
pub fn dock_child_window(app: AppHandle, parent_label: String, child_label: String) -> Result<(), String> {
    let _parent = app.get_webview_window(&parent_label)
        .ok_or_else(|| format!("parent window '{}' not found", parent_label))?;
    let _child = app.get_webview_window(&child_label)
        .ok_or_else(|| format!("child window '{}' not found", child_label))?;

    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSWindow, NSWindowOrderingMode};
        let parent_ptr = _parent.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
        let child_ptr = _child.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
        unsafe {
            (*parent_ptr).addChildWindow_ordered(&*child_ptr, NSWindowOrderingMode::NSWindowAbove);
        }
    }
    Ok(())
}

/// Detach a child window from its parent so it can move independently.
#[tauri::command]
pub fn undock_child_window(app: AppHandle, parent_label: String, child_label: String) -> Result<(), String> {
    let _parent = app.get_webview_window(&parent_label)
        .ok_or_else(|| format!("parent window '{}' not found", parent_label))?;
    let _child = app.get_webview_window(&child_label)
        .ok_or_else(|| format!("child window '{}' not found", child_label))?;

    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWindow;
        let parent_ptr = _parent.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
        let child_ptr = _child.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
        unsafe {
            (*parent_ptr).removeChildWindow(&*child_ptr);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn set_discoverable_state(app: AppHandle, checked: bool) -> Result<(), String> {
    let lifecycle = app.state::<crate::AppLifecycleState>();
    lifecycle.set_discoverable(checked);

    // Rebuild tray menu with updated CheckMenuItem state
    let language = lifecycle.current_language();
    set_tray_language(app, language)
}

#[tauri::command]
pub fn get_main_window_count(app: AppHandle) -> u32 {
    app.webview_windows()
        .keys()
        .filter(|k| {
            let s = k.as_str();
            s != "settings" && s != "jumpserver-browser" && s != "about"
        })
        .count() as u32
}

// ─── LAN sharing toggle (TCP proxy + mDNS) ───

#[tauri::command]
pub async fn toggle_lan_sharing(
    state: State<'_, MeTermProcess>,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    let port = state.port();

    if enabled {
        let lan_port = state.start_lan_proxy()?;
        let client = auth_client(&state)?;
        let url = format!("http://127.0.0.1:{}/api/discoverable", port);
        let resp = client
            .post(&url)
            .json(&serde_json::json!({ "enabled": true, "port": lan_port }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            state.stop_lan_proxy();
            return Err("Failed to enable discoverability".into());
        }
        Ok(serde_json::json!({ "ok": true, "lan_port": lan_port }))
    } else {
        let client = auth_client(&state)?;
        let url = format!("http://127.0.0.1:{}/api/discoverable", port);
        let _ = client
            .post(&url)
            .json(&serde_json::json!({ "enabled": false }))
            .send()
            .await;
        state.stop_lan_proxy();
        Ok(serde_json::json!({ "ok": true }))
    }
}

// ─── Secure credential storage via OS keychain ───

/// Validate that the keychain service name is in the allowed namespace.
/// Only services with the "com.meterm." prefix are permitted to prevent
/// arbitrary access to other applications' keychain entries.
fn validate_keychain_service(service: &str) -> Result<(), String> {
    if service.starts_with("com.meterm.") && service.len() <= 128 {
        Ok(())
    } else {
        Err("invalid keychain service name".to_string())
    }
}

#[tauri::command]
pub async fn store_credential(service: String, account: String, secret: String) -> Result<(), String> {
    validate_keychain_service(&service)?;
    let entry = keyring::Entry::new(&service, &account)
        .map_err(|e| format!("keyring init error: {}", e))?;
    entry.set_password(&secret)
        .map_err(|e| format!("keyring store error: {}", e))
}

#[tauri::command]
pub async fn get_credential(service: String, account: String) -> Result<String, String> {
    validate_keychain_service(&service)?;
    let entry = keyring::Entry::new(&service, &account)
        .map_err(|e| format!("keyring init error: {}", e))?;
    entry.get_password()
        .map_err(|e| format!("keyring get error: {}", e))
}

#[tauri::command]
pub async fn delete_credential(service: String, account: String) -> Result<(), String> {
    validate_keychain_service(&service)?;
    let entry = keyring::Entry::new(&service, &account)
        .map_err(|e| format!("keyring init error: {}", e))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // already deleted, not an error
        Err(e) => Err(format!("keyring delete error: {}", e)),
    }
}

// ─── Device management (IP-aggregated) ───

#[tauri::command]
pub async fn list_devices(state: State<'_, MeTermProcess>) -> Result<String, String> {
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/devices", port);
    let client = auth_client(&state)?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn kick_device(
    state: State<'_, MeTermProcess>,
    ip: String,
    ban: Option<bool>,
) -> Result<String, String> {
    validate_ip(&ip)?;
    let port = state.port();
    let ban_param = if ban.unwrap_or(false) { "?ban=true" } else { "" };
    let url = format!("http://127.0.0.1:{}/api/devices/{}{}", port, ip, ban_param);
    let client = auth_client(&state)?;

    let resp = client
        .delete(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_session_private(
    state: State<'_, MeTermProcess>,
    session_id: String,
    private: bool,
) -> Result<String, String> {
    validate_id(&session_id)?;
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/sessions/{}/private", port, session_id);
    let client = auth_client(&state)?;

    let body = serde_json::json!({ "private": private });

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.text().await.map_err(|e| e.to_string())
}

// ─── Client management ───

#[tauri::command]
pub async fn list_clients(state: State<'_, MeTermProcess>) -> Result<String, String> {
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/clients", port);
    let client = auth_client(&state)?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn kick_client(
    state: State<'_, MeTermProcess>,
    session_id: String,
    client_id: String,
    ban: Option<bool>,
) -> Result<String, String> {
    validate_id(&session_id)?;
    validate_id(&client_id)?;
    let port = state.port();
    let ban_param = if ban.unwrap_or(false) { "?ban=true" } else { "" };
    let url = format!(
        "http://127.0.0.1:{}/api/sessions/{}/clients/{}{}",
        port, session_id, client_id, ban_param
    );
    let client = auth_client(&state)?;

    let resp = client
        .delete(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.text().await.map_err(|e| e.to_string())
}

// ─── IP ban management ───

#[tauri::command]
pub async fn list_banned_ips(state: State<'_, MeTermProcess>) -> Result<String, String> {
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/banned-ips", port);
    let client = auth_client(&state)?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ban_ip(
    state: State<'_, MeTermProcess>,
    ip: String,
    reason: Option<String>,
) -> Result<String, String> {
    validate_ip(&ip)?;
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/banned-ips", port);
    let client = auth_client(&state)?;

    let body = serde_json::json!({
        "ip": ip,
        "reason": reason.unwrap_or_default(),
    });

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unban_ip(
    state: State<'_, MeTermProcess>,
    ip: String,
) -> Result<String, String> {
    validate_ip(&ip)?;
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/banned-ips/{}", port, ip);
    let client = auth_client(&state)?;

    let resp = client
        .delete(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.text().await.map_err(|e| e.to_string())
}

// ─── Background image management ───

#[tauri::command]
pub async fn copy_background_image(
    app: AppHandle,
    source_path: String,
    old_path: Option<String>,
) -> Result<String, String> {
    use std::path::Path;

    // Canonicalize to resolve symlinks and prevent path traversal attacks
    let source = std::fs::canonicalize(&source_path)
        .map_err(|_| "source file does not exist or is inaccessible".to_string())?;
    if !source.is_file() {
        return Err("source path is not a regular file".to_string());
    }

    // Validate file extension
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp") {
        return Err("unsupported image format".to_string());
    }

    // Get app data directory and create backgrounds subdirectory
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to get app data dir: {}", e))?;
    let bg_dir = app_data.join("backgrounds");
    std::fs::create_dir_all(&bg_dir)
        .map_err(|e| format!("failed to create backgrounds dir: {}", e))?;

    // Generate unique filename using timestamp
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let dest_name = format!("bg_{}.{}", ts, ext);
    let dest = bg_dir.join(&dest_name);

    // Copy the file
    std::fs::copy(&source, &dest)
        .map_err(|e| format!("failed to copy image: {}", e))?;

    // Delete old background image if provided and it's inside our backgrounds dir
    if let Some(old) = old_path {
        let old_p = Path::new(&old);
        if old_p.starts_with(&bg_dir) && old_p.is_file() {
            let _ = std::fs::remove_file(old_p);
        }
    }

    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn delete_background_image(app: AppHandle, path: String) -> Result<(), String> {
    use std::path::Path;

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to get app data dir: {}", e))?;
    let bg_dir = app_data.join("backgrounds");
    let target = Path::new(&path);

    // Only delete files inside our backgrounds directory (prevent path traversal)
    if target.starts_with(&bg_dir) && target.is_file() {
        std::fs::remove_file(target)
            .map_err(|e| format!("failed to delete image: {}", e))?;
    }

    Ok(())
}

// ─── Token management ───

#[tauri::command]
pub async fn refresh_token(state: State<'_, MeTermProcess>) -> Result<String, String> {
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/token/refresh", port);
    let client = auth_client(&state)?;

    let resp = client
        .post(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let text = resp.text().await.map_err(|e| e.to_string())?;

    // Update the local token store so subsequent requests use the new token
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(new_token) = parsed.get("token").and_then(|v| v.as_str()) {
            state.update_token(new_token.to_string());
        }
    }

    Ok(text)
}

#[tauri::command]
pub async fn set_custom_token(
    state: State<'_, MeTermProcess>,
    token: String,
) -> Result<String, String> {
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/token", port);
    let client = auth_client(&state)?;

    let body = serde_json::json!({ "token": token });

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(text);
    }

    // Backend returns {"ok": true} without echoing the token (security).
    // Use the token from our parameter directly.
    state.update_token(token);

    Ok(text)
}

#[tauri::command]
pub async fn revoke_all_clients(state: State<'_, MeTermProcess>) -> Result<String, String> {
    let port = state.port();
    let url = format!("http://127.0.0.1:{}/api/token/revoke-all", port);
    let client = auth_client(&state)?;

    let resp = client
        .post(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let text = resp.text().await.map_err(|e| e.to_string())?;

    // Update local token store with the auto-refreshed token
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(new_token) = parsed.get("new_token").and_then(|v| v.as_str()) {
            state.update_token(new_token.to_string());
        }
    }

    Ok(text)
}

// ─── AI 模型列表拉取（通过 Rust reqwest 绕过浏览器 CORS 限制）───

#[derive(Deserialize)]
pub struct FetchAiModelsRequest {
    url: String,
    /// HTTP 请求头，格式为 [key, value] 对列表
    headers: Vec<(String, String)>,
}

#[derive(Serialize)]
pub struct FetchAiModelsResponse {
    ok: bool,
    status: u16,
    body: String,
}

/// 通过 Rust reqwest 发起 HTTP GET 请求拉取 AI provider 的模型列表。
/// 在 Windows 的 WebView2 环境中，直接使用浏览器 fetch() 可能因 CORS 策略导致
/// "Failed to fetch" 错误；本命令在 Rust 层发起请求，完全绕过浏览器 CORS 限制。
#[tauri::command]
pub async fn fetch_ai_models(request: FetchAiModelsRequest) -> Result<FetchAiModelsResponse, String> {
    // 基本安全校验：只允许 http/https 协议
    if !request.url.starts_with("http://") && !request.url.starts_with("https://") {
        return Err("only http and https URLs are allowed".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let mut builder = client.get(&request.url);
    for (key, value) in &request.headers {
        builder = builder.header(key.as_str(), value.as_str());
    }

    let resp = builder.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| e.to_string())?;

    Ok(FetchAiModelsResponse {
        ok: status >= 200 && status < 300,
        status,
        body,
    })
}

/// 通过 Rust reqwest 发起 HTTP POST 请求并以流式方式将响应体推送到前端 Channel。
/// 用于 AI 聊天的 SSE 流式输出，完全绕过 WebView2（Windows）的 CORS 限制。
#[tauri::command]
pub async fn fetch_ai_stream(
    url: String,
    headers: Vec<(String, String)>,
    body: String,
    on_event: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("only http and https URLs are allowed".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let mut builder = client.post(&url).body(body);
    for (key, value) in &headers {
        builder = builder.header(key.as_str(), value.as_str());
    }

    let resp = builder.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();

    if status < 200 || status >= 300 {
        let err_body = resp.text().await.unwrap_or_default();
        let snippet = &err_body[..err_body.len().min(300)];
        return Err(format!("HTTP {}: {}", status, snippet));
    }

    let mut resp = resp;
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        let text = String::from_utf8_lossy(&chunk).to_string();
        if on_event.send(text).is_err() {
            // 前端已关闭 channel（窗口关闭或请求取消），停止发送
            break;
        }
    }

    Ok(())
}

/// Restart the app via `open -a` on macOS so the new process is properly
/// associated with the .app bundle (inherits Local Network privacy, TCC
/// permissions, etc.).  Falls back to Tauri's built-in restart on other
/// platforms or in dev mode (binary not inside a .app bundle).
#[tauri::command]
pub fn restart_app_via_open(app: AppHandle) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(exe) = std::env::current_exe() {
            // exe: …/MeTerm.app/Contents/MacOS/meterm
            if let Some(bundle) = exe
                .parent()                   // MacOS/
                .and_then(|p| p.parent())   // Contents/
                .and_then(|p| p.parent())   // MeTerm.app
            {
                if bundle.extension().map_or(false, |e| e == "app") {
                    let bundle_path = bundle.display().to_string();
                    // Spawn a detached shell that waits for us to exit, then re-opens the app
                    let _ = std::process::Command::new("sh")
                        .args(["-c", &format!("sleep 1 && open -a '{}'", bundle_path)])
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .spawn();
                    app.exit(0);
                    return;
                }
            }
        }
    }
    // Fallback: use Tauri's default restart
    app.restart();
}

/// Expand `~` prefix and on Windows convert WSL/MSYS paths to native paths.
fn normalize_path(path: &str) -> String {
    let mut s = path.to_string();

    // Expand ~ to home directory
    if s.starts_with("~/") || s == "~" {
        if let Some(home) = dirs::home_dir() {
            s = if s == "~" {
                home.display().to_string()
            } else {
                format!("{}{}", home.display(), &s[1..])
            };
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Convert MSYS/Git Bash paths: /c/Users/... → C:\Users\...
        // Also handle file:// URL pathname: /C:/Users/... → C:\Users\...
        if let Some(rest) = s.strip_prefix('/') {
            if rest.len() >= 2 && rest.as_bytes()[0].is_ascii_alphabetic() && rest.as_bytes()[1] == b'/' {
                let drive = rest.as_bytes()[0].to_ascii_uppercase() as char;
                s = format!("{}:{}", drive, rest[1..].replace('/', "\\"));
                return s;
            }
            if rest.len() >= 3 && rest.as_bytes()[0].is_ascii_alphabetic() && rest.as_bytes()[1] == b':' && (rest.as_bytes()[2] == b'/' || rest.as_bytes()[2] == b'\\') {
                let drive = rest.as_bytes()[0].to_ascii_uppercase() as char;
                s = format!("{}:{}", drive, rest[2..].replace('/', "\\"));
                return s;
            }
        }

        // Convert WSL Linux paths: /home/... → \\wsl.localhost\<distro>\home\...
        if s.starts_with('/') {
            if let Ok(out) = std::process::Command::new("wsl.exe")
                .args(["-e", "wslpath", "-w", &s])
                .output()
            {
                if out.status.success() {
                    let win_path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !win_path.is_empty() {
                        return win_path;
                    }
                }
            }
        }
    }

    s
}

/// Check whether a local path is a file, directory, or does not exist.
/// Returns "file", "dir", or "none".
#[tauri::command]
pub fn stat_path(path: String) -> String {
    let resolved = normalize_path(&path);
    let p = std::path::Path::new(&resolved);
    if p.is_dir() {
        "dir".to_string()
    } else if p.is_file() {
        "file".to_string()
    } else {
        "none".to_string()
    }
}

/// Open a local file or folder using the OS default handler.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let resolved = normalize_path(&path);

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&resolved)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &resolved])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&resolved)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Take and return the initial open path from CLI args (consumed once).
#[tauri::command]
pub fn take_initial_open_path(
    state: State<'_, AppLifecycleState>,
) -> Option<String> {
    state.initial_open_path.lock().ok().and_then(|mut guard| guard.take())
}

/// List file/directory names in a directory. Returns Vec<(name, is_dir)>.
#[tauri::command]
pub fn list_dir_names(path: String) -> Result<Vec<(String, bool)>, String> {
    let resolved = normalize_path(&path);
    let entries = std::fs::read_dir(&resolved).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        result.push((name, is_dir));
    }
    Ok(result)
}

// ── Context Menu Integration ──

/// Register system context menu ("Open in MeTerm") for Finder/Explorer.
#[tauri::command]
pub fn register_context_menu() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        register_macos_quick_action()
    }
    #[cfg(target_os = "windows")]
    {
        register_windows_context_menu()
    }
    #[cfg(target_os = "linux")]
    {
        Err("Context menu registration is not supported on Linux yet".into())
    }
}

/// Unregister system context menu.
#[tauri::command]
pub fn unregister_context_menu() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        unregister_macos_quick_action()
    }
    #[cfg(target_os = "windows")]
    {
        unregister_windows_context_menu()
    }
    #[cfg(target_os = "linux")]
    {
        Err("Context menu registration is not supported on Linux yet".into())
    }
}

/// Check if context menu is registered.
#[tauri::command]
pub fn is_context_menu_registered() -> bool {
    #[cfg(target_os = "macos")]
    {
        is_finder_extension_enabled()
    }
    #[cfg(target_os = "windows")]
    {
        use winreg::RegKey;
        use winreg::enums::HKEY_CLASSES_ROOT;
        RegKey::predef(HKEY_CLASSES_ROOT)
            .open_subkey(r"Directory\shell\MeTerm")
            .is_ok()
    }
    #[cfg(target_os = "linux")]
    {
        false
    }
}

#[cfg(target_os = "macos")]
const FINDER_EXT_BUNDLE_ID: &str = "com.meterm.dev.finder-extension";

#[cfg(target_os = "macos")]
fn is_finder_extension_enabled() -> bool {
    // Check if the extension is registered and enabled via pluginkit
    let output = std::process::Command::new("pluginkit")
        .args(["-m", "-i", FINDER_EXT_BUNDLE_ID])
        .output();
    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            // pluginkit -m returns a line with "+" if enabled, "-" if disabled
            stdout.contains("+")
        }
        Err(_) => false,
    }
}

#[cfg(target_os = "macos")]
fn register_macos_quick_action() -> Result<(), String> {
    // Check if .appex is bundled (release mode)
    let app_path = std::env::current_exe().map_err(|e| e.to_string())?;
    let appex_exists = app_path
        .parent() // MacOS
        .and_then(|p| p.parent()) // Contents
        .map(|p| p.join("PlugIns/MeTermFinder.appex").exists())
        .unwrap_or(false);

    if !appex_exists {
        return Err("Finder Extension 仅在正式构建版本中可用（dev 模式不支持）".into());
    }

    // Enable the bundled Finder Extension via pluginkit
    let output = std::process::Command::new("pluginkit")
        .args(["-e", "use", "-i", FINDER_EXT_BUNDLE_ID])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("pluginkit enable failed: {}", stderr));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn unregister_macos_quick_action() -> Result<(), String> {
    // Disable the Finder Extension via pluginkit
    let output = std::process::Command::new("pluginkit")
        .args(["-e", "ignore", "-i", FINDER_EXT_BUNDLE_ID])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("pluginkit disable failed: {}", stderr));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn register_windows_context_menu() -> Result<(), String> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};

    let exe_path = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .to_string();

    // Register for directories: Directory\shell\MeTerm
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let base = r"Software\Classes\Directory\shell\MeTerm";
    let (key, _) = hkcu.create_subkey(base).map_err(|e| e.to_string())?;
    key.set_value("", &"Open in MeTerm").map_err(|e| e.to_string())?;
    key.set_value("Icon", &exe_path).map_err(|e| e.to_string())?;

    let (cmd_key, _) = hkcu.create_subkey(&format!(r"{}\command", base))
        .map_err(|e| e.to_string())?;
    cmd_key.set_value("", &format!("\"{}\" \"%V\"", exe_path))
        .map_err(|e| e.to_string())?;

    // Register for directory background: Directory\Background\shell\MeTerm
    let bg_base = r"Software\Classes\Directory\Background\shell\MeTerm";
    let (bg_key, _) = hkcu.create_subkey(bg_base).map_err(|e| e.to_string())?;
    bg_key.set_value("", &"Open in MeTerm").map_err(|e| e.to_string())?;
    bg_key.set_value("Icon", &exe_path).map_err(|e| e.to_string())?;

    let (bg_cmd_key, _) = hkcu.create_subkey(&format!(r"{}\command", bg_base))
        .map_err(|e| e.to_string())?;
    bg_cmd_key.set_value("", &format!("\"{}\" \"%V\"", exe_path))
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn unregister_windows_context_menu() -> Result<(), String> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);

    let _ = hkcu.delete_subkey_all(r"Software\Classes\Directory\shell\MeTerm");
    let _ = hkcu.delete_subkey_all(r"Software\Classes\Directory\Background\shell\MeTerm");

    Ok(())
}
