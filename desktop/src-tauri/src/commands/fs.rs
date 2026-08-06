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
            if rest.len() >= 2
                && rest.as_bytes()[0].is_ascii_alphabetic()
                && rest.as_bytes()[1] == b'/'
            {
                let drive = rest.as_bytes()[0].to_ascii_uppercase() as char;
                s = format!("{}:{}", drive, rest[1..].replace('/', "\\"));
                return s;
            }
            if rest.len() >= 3
                && rest.as_bytes()[0].is_ascii_alphabetic()
                && rest.as_bytes()[1] == b':'
                && (rest.as_bytes()[2] == b'/' || rest.as_bytes()[2] == b'\\')
            {
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

/// Open a local file with the OS default *text editor*. Used for files
/// with uncommon extensions (e.g. `.jsonl`) that may have no default
/// handler registered — relying on the plain `open_path` would silently
/// do nothing in that case.
#[tauri::command]
pub fn open_text_file(path: String) -> Result<(), String> {
    let resolved = normalize_path(&path);

    #[cfg(target_os = "macos")]
    {
        // `open -t` forces the user's default text editor regardless of
        // whether the file extension has an associated application.
        std::process::Command::new("open")
            .args(["-t", &resolved])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("notepad.exe")
            .arg(&resolved)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        // Try common editors in order; fall back to xdg-open.
        let editors = ["gedit", "kate", "mousepad", "xed", "nano"];
        let mut opened = false;
        for editor in &editors {
            if std::process::Command::new(editor)
                .arg(&resolved)
                .spawn()
                .is_ok()
            {
                opened = true;
                break;
            }
        }
        if !opened {
            std::process::Command::new("xdg-open")
                .arg(&resolved)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
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
    if !matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp"
    ) {
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
    std::fs::copy(&source, &dest).map_err(|e| format!("failed to copy image: {}", e))?;

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
        std::fs::remove_file(target).map_err(|e| format!("failed to delete image: {}", e))?;
    }

    Ok(())
}

/// Take and return the initial open path from CLI args (consumed once).
#[tauri::command]
pub fn take_initial_open_path(state: State<'_, AppLifecycleState>) -> Option<String> {
    state
        .initial_open_path
        .lock()
        .ok()
        .and_then(|mut guard| guard.take())
}

// ─── Agent file I/O (unrestricted, sidecar-style) ───
//
// The Tauri `@tauri-apps/plugin-fs` API enforces a path scope. Static
// access is limited to chat history and the agent audit log; user-picked
// and dropped files are added dynamically by Tauri. The AI agent's
// `read_file` / `write_file` tools therefore cannot read arbitrary local
// files through the plugin — they hit a "path not allowed" error.
//
// These two commands bypass the plugin entirely and use std::fs,
// which is consistent with the rest of the agent's surface area:
// it already has full shell access via run_command, so allowing it
// to read/write arbitrary local files via a dedicated command does
// not expand the attack surface — it just gives a faster, cleaner
// path than round-tripping through the PTY.
//
// Returned as a JSON-friendly struct so the TS side can distinguish
// "binary" / "too large" / "permission denied" from real content.

#[derive(serde::Serialize)]
pub struct AgentReadResult {
    /// UTF-8 file content (None when binary or error).
    pub content: Option<String>,
    /// File size in bytes (always populated when stat succeeds).
    pub size: u64,
    /// True if the file looks binary (null bytes detected).
    pub is_binary: bool,
    /// True if the file exceeds the size limit and content was skipped.
    pub too_large: bool,
}

/// Read a local file by absolute / `~`-prefixed path.
/// Returns the UTF-8 content along with size + binary flag.
/// Errors are returned as Err(String) with a human-readable message.
#[tauri::command]
pub fn agent_read_file(path: String, max_bytes: Option<u64>) -> Result<AgentReadResult, String> {
    let resolved = normalize_path(&path);
    let p = std::path::Path::new(&resolved);

    if !p.exists() {
        return Err(format!("file not found: {}", resolved));
    }
    if !p.is_file() {
        return Err(format!("not a regular file: {}", resolved));
    }

    let meta = std::fs::metadata(p).map_err(|e| format!("stat failed: {}", e))?;
    let size = meta.len();
    let cap = max_bytes.unwrap_or(10 * 1024 * 1024); // 10 MB default

    if size > cap {
        return Ok(AgentReadResult {
            content: None,
            size,
            is_binary: false,
            too_large: true,
        });
    }

    let bytes = std::fs::read(p).map_err(|e| format!("read failed: {}", e))?;

    // Binary detection: any NUL byte in the first 4KB.
    let head = &bytes[..bytes.len().min(4096)];
    if head.contains(&0u8) {
        return Ok(AgentReadResult {
            content: None,
            size,
            is_binary: true,
            too_large: false,
        });
    }

    let content =
        String::from_utf8(bytes).map_err(|e| format!("file is not valid UTF-8: {}", e))?;

    Ok(AgentReadResult {
        content: Some(content),
        size,
        is_binary: false,
        too_large: false,
    })
}

/// Read a local file as raw bytes (for binary inputs like images
/// the agent picks via the file picker). Returns a Vec<u8> serialized
/// as a JSON number array; the TS side rebuilds a Uint8Array from it.
#[tauri::command]
pub fn agent_read_file_bytes(path: String, max_bytes: Option<u64>) -> Result<Vec<u8>, String> {
    let resolved = normalize_path(&path);
    let p = std::path::Path::new(&resolved);
    if !p.is_file() {
        return Err(format!("not a regular file: {}", resolved));
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("stat failed: {}", e))?;
    let cap = max_bytes.unwrap_or(10 * 1024 * 1024);
    if meta.len() > cap {
        return Err(format!(
            "file too large: {} bytes (limit {})",
            meta.len(),
            cap
        ));
    }
    std::fs::read(p).map_err(|e| format!("read failed: {}", e))
}

/// Write a local file by absolute / `~`-prefixed path. Creates parent
/// directories as needed. Overwrites existing files.
#[tauri::command]
pub fn agent_write_file(path: String, content: String) -> Result<u64, String> {
    let resolved = normalize_path(&path);
    let p = std::path::Path::new(&resolved);

    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create parent directory: {}", e))?;
        }
    }

    std::fs::write(p, content.as_bytes()).map_err(|e| format!("write failed: {}", e))?;

    Ok(content.as_bytes().len() as u64)
}

/// Save user-dropped/picked attachment bytes to a stable location in
/// `<app-data>/attachments/`. Returns the absolute path so the agent
/// can feed it into upload_file / read_file / run_command. Parent
/// directory is created on demand. The on-disk filename is prefixed
/// with a timestamp + short random hash to avoid collisions when the
/// user drops two files with the same name.
#[tauri::command]
pub async fn agent_save_attachment(
    app: AppHandle,
    name: String,
    bytes: Vec<u8>,
) -> Result<AgentAttachmentInfo, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to get app data dir: {}", e))?;
    let att_dir = app_data.join("attachments");
    std::fs::create_dir_all(&att_dir)
        .map_err(|e| format!("failed to create attachments dir: {}", e))?;

    // Sanitize the filename: replace path separators so the user can't
    // escape the attachments dir via "../../etc/passwd"-style names.
    let safe_name: String = name
        .chars()
        .map(|c| {
            if c == '/' || c == '\\' || c == '\0' {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = safe_name.trim().trim_start_matches('.');
    let final_name = if trimmed.is_empty() {
        "attachment"
    } else {
        trimmed
    };

    // Timestamp + short random suffix for collision avoidance.
    // UUID v4 for collision-proof filenames (the uuid crate is already a dep).
    let id = uuid::Uuid::new_v4();
    let prefixed = format!("{}-{}", id, final_name);

    let dest = att_dir.join(&prefixed);
    let size = bytes.len() as u64;
    std::fs::write(&dest, &bytes).map_err(|e| format!("write attachment failed: {}", e))?;

    Ok(AgentAttachmentInfo {
        path: dest.to_string_lossy().to_string(),
        size,
    })
}

#[derive(serde::Serialize)]
pub struct AgentAttachmentInfo {
    pub path: String,
    pub size: u64,
}

/// Remove an attachment file previously created by agent_save_attachment.
/// Only removes files that live inside `<app-data>/attachments/` — any
/// path outside that directory is rejected to prevent the frontend from
/// weaponizing this command into a general-purpose unlink.
#[tauri::command]
pub fn agent_delete_attachment(app: AppHandle, path: String) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to get app data dir: {}", e))?;
    let att_dir = app_data.join("attachments");
    let target = std::path::Path::new(&path);
    if !target.starts_with(&att_dir) {
        return Err("attachment path is outside the managed attachments directory".to_string());
    }
    if target.is_file() {
        std::fs::remove_file(target).map_err(|e| format!("delete failed: {}", e))?;
    }
    Ok(())
}

/// Copy a local file (or ~/-prefixed / Windows-style) to another local
/// path. Used by the agent's upload_file / download_file tools when
/// BOTH endpoints are local — no SFTP involved. Parent directories are
/// created on demand. Uses std::fs::copy which is zero-copy on systems
/// that support it (macOS APFS clonefile, Linux CoW FS).
#[tauri::command]
pub fn agent_copy_local_file(source_path: String, dest_path: String) -> Result<u64, String> {
    let src = normalize_path(&source_path);
    let dst = normalize_path(&dest_path);
    let src_p = std::path::Path::new(&src);
    if !src_p.exists() {
        return Err(format!("source not found: {}", src));
    }
    if !src_p.is_file() {
        return Err(format!("source is not a regular file: {}", src));
    }
    let dst_p = std::path::Path::new(&dst);
    if let Some(parent) = dst_p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create parent directory: {}", e))?;
        }
    }
    let bytes = std::fs::copy(src_p, dst_p).map_err(|e| format!("copy failed: {}", e))?;
    Ok(bytes)
}

/// Write a local file as raw bytes. Used by upload_file / download_file
/// to ship binary payloads (PNGs, compiled artifacts, archives) without
/// the lossy UTF-8 round-trip that `agent_write_file` would force.
#[tauri::command]
pub fn agent_write_file_bytes(path: String, bytes: Vec<u8>) -> Result<u64, String> {
    let resolved = normalize_path(&path);
    let p = std::path::Path::new(&resolved);

    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create parent directory: {}", e))?;
        }
    }

    std::fs::write(p, &bytes).map_err(|e| format!("write failed: {}", e))?;
    Ok(bytes.len() as u64)
}

// ─── Agent filesystem search (list / glob / grep) ───
//
// Three structured commands powering the TS-side ai-tools-search.ts
// helpers. Each command keeps the result well under any reasonable
// LLM context window by enforcing both per-result and total-output
// caps. They use std::fs / walkdir / globset / regex — none of which
// require unsafe code.

#[derive(serde::Serialize)]
pub struct AgentDirEntry {
    pub name: String,
    /// "file" | "dir" | "symlink" | "other"
    pub kind: String,
    pub size: u64,
    /// Modification time as a unix epoch in seconds.
    pub mtime: i64,
}

#[derive(serde::Serialize)]
pub struct AgentDirListing {
    pub path: String,
    pub entries: Vec<AgentDirEntry>,
    pub truncated: bool,
}

/// List the immediate contents of a directory. Does NOT recurse —
/// callers wanting recursive enumeration should use agent_glob_search
/// or run_command + find via the SSH path.
#[tauri::command]
pub fn agent_list_directory(
    path: String,
    show_hidden: Option<bool>,
    max_entries: Option<usize>,
) -> Result<AgentDirListing, String> {
    let resolved = normalize_path(&path);
    let p = std::path::Path::new(&resolved);
    if !p.exists() {
        return Err(format!("directory not found: {}", resolved));
    }
    if !p.is_dir() {
        return Err(format!("not a directory: {}", resolved));
    }

    let show_hidden = show_hidden.unwrap_or(false);
    let cap = max_entries.unwrap_or(200).min(2000);

    let read = std::fs::read_dir(p).map_err(|e| format!("read_dir failed: {}", e))?;
    let mut entries: Vec<AgentDirEntry> = Vec::new();
    let mut truncated = false;

    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        if entries.len() >= cap {
            truncated = true;
            break;
        }
        let ft = entry.file_type().ok();
        let kind = match ft {
            Some(t) if t.is_dir() => "dir",
            Some(t) if t.is_symlink() => "symlink",
            Some(t) if t.is_file() => "file",
            _ => "other",
        }
        .to_string();
        let meta = entry.metadata().ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let mtime = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        entries.push(AgentDirEntry {
            name,
            kind,
            size,
            mtime,
        });
    }

    Ok(AgentDirListing {
        path: resolved,
        entries,
        truncated,
    })
}

#[derive(serde::Serialize)]
pub struct GlobMatch {
    pub path: String,
    pub is_dir: bool,
}

/// Recursive glob search rooted at `cwd`. Skips the usual junk dirs
/// (.git, node_modules, target, dist, build, .next, .venv) so the
/// results stay focused on user code.
#[tauri::command]
pub fn agent_glob_search(
    pattern: String,
    cwd: String,
    max_results: Option<usize>,
) -> Result<Vec<GlobMatch>, String> {
    use globset::{GlobBuilder, GlobMatcher};
    use walkdir::WalkDir;

    let resolved = normalize_path(&cwd);
    let root = std::path::Path::new(&resolved);
    if !root.exists() {
        return Err(format!("cwd not found: {}", resolved));
    }

    let cap = max_results.unwrap_or(200).min(2000);

    let glob = GlobBuilder::new(&pattern)
        .literal_separator(false)
        .case_insensitive(false)
        .build()
        .map_err(|e| format!("invalid glob pattern: {}", e))?;
    let matcher: GlobMatcher = glob.compile_matcher();

    let mut hits: Vec<GlobMatch> = Vec::new();

    let walker = WalkDir::new(root)
        .follow_links(false)
        .max_depth(20)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            // Always allow the root itself.
            if e.depth() == 0 {
                return true;
            }
            // Prune well-known noise directories.
            if e.file_type().is_dir() {
                !matches!(
                    name.as_ref(),
                    ".git"
                        | "node_modules"
                        | "target"
                        | "dist"
                        | "build"
                        | ".next"
                        | ".venv"
                        | "__pycache__"
                )
            } else {
                true
            }
        });

    for entry in walker.flatten() {
        if hits.len() >= cap {
            break;
        }
        if entry.depth() == 0 {
            continue;
        }
        let rel = entry.path().strip_prefix(root).unwrap_or(entry.path());
        let rel_str = rel.to_string_lossy();
        if matcher.is_match(rel.as_os_str()) || matcher.is_match(rel_str.as_ref()) {
            hits.push(GlobMatch {
                path: entry.path().to_string_lossy().to_string(),
                is_dir: entry.file_type().is_dir(),
            });
        }
    }

    Ok(hits)
}

#[derive(serde::Serialize)]
pub struct GrepHit {
    pub path: String,
    pub line: u32,
    pub text: String,
}

#[derive(serde::Serialize)]
pub struct GrepResult {
    pub hits: Vec<GrepHit>,
    pub files_scanned: u32,
    pub truncated: bool,
}

/// Recursive content search via the `regex` crate. Skips binaries
/// (any file containing a NUL byte in the first 4 KB) and junk dirs.
/// `glob` optionally constrains which files are scanned.
#[tauri::command]
pub fn agent_grep_search(
    pattern: String,
    path: String,
    glob: Option<String>,
    case_insensitive: Option<bool>,
    max_hits: Option<usize>,
) -> Result<GrepResult, String> {
    use globset::{GlobBuilder, GlobMatcher};
    use regex::RegexBuilder;
    use walkdir::WalkDir;

    let resolved = normalize_path(&path);
    let root = std::path::Path::new(&resolved);
    if !root.exists() {
        return Err(format!("path not found: {}", resolved));
    }

    let cap = max_hits.unwrap_or(100).min(1000);
    let ci = case_insensitive.unwrap_or(false);

    let re = RegexBuilder::new(&pattern)
        .case_insensitive(ci)
        .build()
        .map_err(|e| format!("invalid regex: {}", e))?;

    let glob_matcher: Option<GlobMatcher> = match glob {
        Some(g) if !g.is_empty() => Some(
            GlobBuilder::new(&g)
                .literal_separator(false)
                .build()
                .map_err(|e| format!("invalid glob filter: {}", e))?
                .compile_matcher(),
        ),
        _ => None,
    };

    let mut hits: Vec<GrepHit> = Vec::new();
    let mut files_scanned: u32 = 0;
    let mut truncated = false;

    let walker = WalkDir::new(root)
        .follow_links(false)
        .max_depth(20)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            if e.depth() == 0 {
                return true;
            }
            if e.file_type().is_dir() {
                !matches!(
                    name.as_ref(),
                    ".git"
                        | "node_modules"
                        | "target"
                        | "dist"
                        | "build"
                        | ".next"
                        | ".venv"
                        | "__pycache__"
                )
            } else {
                true
            }
        });

    'outer: for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        if let Some(m) = &glob_matcher {
            let name = entry.file_name().to_string_lossy();
            if !m.is_match(name.as_ref()) {
                continue;
            }
        }

        // Cheap binary sniff: read up to 4 KB, bail on NUL.
        let path = entry.path();
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        // Hard cap per-file size at 1 MB to avoid pathological cases.
        if bytes.len() > 1024 * 1024 {
            continue;
        }
        let head = &bytes[..bytes.len().min(4096)];
        if head.contains(&0u8) {
            continue;
        }
        let content = match std::str::from_utf8(&bytes) {
            Ok(s) => s,
            Err(_) => continue,
        };
        files_scanned += 1;

        for (idx, line) in content.lines().enumerate() {
            if re.is_match(line) {
                if hits.len() >= cap {
                    truncated = true;
                    break 'outer;
                }
                hits.push(GrepHit {
                    path: path.to_string_lossy().to_string(),
                    line: (idx + 1) as u32,
                    text: line.to_string(),
                });
            }
        }
    }

    Ok(GrepResult {
        hits,
        files_scanned,
        truncated,
    })
}

// ─── Clipboard image read (for AI agent input attachments) ───
//
// Why a Rust command?  WebView's standard clipboard API exposes
// images via the `paste` event's `clipboardData.items`, but on
// macOS WKWebView (which Tauri uses) this works only when the image
// originated from another web page.  System screenshots placed on
// the clipboard via Cmd+Shift+Ctrl+4 / screencapture / iOS Universal
// Clipboard arrive as NSImage on the NSPasteboard, and WKWebView
// does NOT translate them into a clipboardData entry.  The user's
// `paste` event simply doesn't fire (or fires with no items).
//
// We bypass this by reading the system pasteboard directly. The
// returned struct contains base64 PNG data so it slots into the
// agent's existing AttachedImage type.

#[derive(serde::Serialize)]
pub struct ClipboardImageResult {
    /// Base64 PNG (no data: prefix). None if the clipboard has no image.
    pub data: Option<String>,
    pub media_type: Option<String>,
    /// Pixel dimensions, informational.
    pub width: u32,
    pub height: u32,
}

/// Read the system clipboard. If it contains an image (RGBA framebuffer),
/// re-encode it as PNG and return base64 data. If the clipboard has no
/// image, returns an empty result instead of an error so the caller can
/// quietly fall through to the file picker.
#[tauri::command]
pub fn read_clipboard_image() -> Result<ClipboardImageResult, String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("failed to open clipboard: {}", e))?;

    let img = match clipboard.get_image() {
        Ok(img) => img,
        Err(arboard::Error::ContentNotAvailable) => {
            return Ok(ClipboardImageResult {
                data: None,
                media_type: None,
                width: 0,
                height: 0,
            });
        }
        Err(e) => return Err(format!("clipboard read failed: {}", e)),
    };

    let width = img.width as u32;
    let height = img.height as u32;
    if width == 0 || height == 0 {
        return Ok(ClipboardImageResult {
            data: None,
            media_type: None,
            width: 0,
            height: 0,
        });
    }

    // arboard returns raw RGBA8.  Hand-roll a minimal PNG encoder by
    // building a tiny zlib-compressed scanline stream and the four
    // standard PNG chunks (IHDR, IDAT, IEND).  We do this rather than
    // pulling in the `png` crate to keep build size down.
    //
    // For simplicity we just re-use std::io::Write into a Vec<u8> and
    // call into the existing `image_to_png` helper below.
    let png_bytes = encode_rgba_to_png(&img.bytes, width, height)
        .map_err(|e| format!("PNG encoding failed: {}", e))?;
    let b64 = B64.encode(&png_bytes);

    Ok(ClipboardImageResult {
        data: Some(b64),
        media_type: Some("image/png".into()),
        width,
        height,
    })
}

/// Encode a raw RGBA8 buffer to PNG bytes using a minimal hand-rolled
/// implementation. We avoid pulling in the `png` crate to keep the
/// dependency tree small. Compresses with zlib via flate2 (already a
/// transitive dependency through several other crates we use).
fn encode_rgba_to_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let stride = (width as usize) * 4;
    if rgba.len() < stride * (height as usize) {
        return Err(format!(
            "rgba buffer too small: {} bytes for {}x{}",
            rgba.len(),
            width,
            height
        ));
    }

    // Build the filtered scanline stream: each scanline is prefixed
    // with a single 0 byte (filter type 'None').
    let mut filtered = Vec::with_capacity((stride + 1) * height as usize);
    for y in 0..height as usize {
        filtered.push(0u8);
        let start = y * stride;
        filtered.extend_from_slice(&rgba[start..start + stride]);
    }

    // zlib-compress via miniz_oxide (a transitive dep we already pull
    // in via several upstream crates; safe to use directly).
    let compressed = miniz_oxide::deflate::compress_to_vec_zlib(&filtered, 6);

    // ── Assemble the PNG file ──
    let mut out: Vec<u8> = Vec::with_capacity(8 + 25 + 12 + compressed.len() + 12);
    // PNG signature
    out.extend_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);

    // Helper to write a chunk (length + type + data + CRC).
    fn write_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let crc_start = out.len();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        let crc = crc32(&out[crc_start..]);
        out.extend_from_slice(&crc.to_be_bytes());
    }

    // IHDR
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.push(8); // bit depth
    ihdr.push(6); // color type: RGBA
    ihdr.push(0); // compression
    ihdr.push(0); // filter
    ihdr.push(0); // interlace
    write_chunk(&mut out, b"IHDR", &ihdr);

    // IDAT
    write_chunk(&mut out, b"IDAT", &compressed);

    // IEND
    write_chunk(&mut out, b"IEND", &[]);

    Ok(out)
}

/// Tiny IEEE-802.3 CRC32 implementation. Reflected polynomial 0xedb88320.
fn crc32(data: &[u8]) -> u32 {
    static mut TABLE: [u32; 256] = [0; 256];
    static INIT: std::sync::Once = std::sync::Once::new();
    unsafe {
        INIT.call_once(|| {
            for i in 0..256u32 {
                let mut c = i;
                for _ in 0..8 {
                    if c & 1 != 0 {
                        c = 0xedb88320 ^ (c >> 1);
                    } else {
                        c >>= 1;
                    }
                }
                TABLE[i as usize] = c;
            }
        });
        let mut crc = 0xffffffffu32;
        for &b in data {
            let idx = ((crc ^ b as u32) & 0xff) as usize;
            crc = TABLE[idx] ^ (crc >> 8);
        }
        crc ^ 0xffffffff
    }
}
