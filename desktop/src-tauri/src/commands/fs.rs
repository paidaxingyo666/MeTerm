use tauri::{AppHandle, Manager, State};

use crate::AppLifecycleState;

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

/// Take and return the initial open path from CLI args (consumed once).
#[tauri::command]
pub fn take_initial_open_path(
    state: State<'_, AppLifecycleState>,
) -> Option<String> {
    state.initial_open_path.lock().ok().and_then(|mut guard| guard.take())
}
