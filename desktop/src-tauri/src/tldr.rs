use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read as IoRead;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

// ─── Data types ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct TldrPage {
    pub name: String,
    pub description: String,
    pub examples: Vec<TldrExample>,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TldrExample {
    pub description: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TldrQueryResult {
    pub found: bool,
    pub page: Option<TldrPage>,
    pub language: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TldrStatus {
    pub initialized: bool,
    pub page_count: usize,
    pub last_updated: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CacheMeta {
    last_updated: u64,
    size: u64,
}

// ─── State ───────────────────────────────────────────────────────

pub struct TldrState {
    index: Mutex<HashMap<String, TldrPage>>,
    command_names: Mutex<Vec<String>>,
    data_dir: Mutex<Option<PathBuf>>,
    initialized: Mutex<bool>,
    last_updated: Mutex<Option<u64>>,
}

impl TldrState {
    pub fn new() -> Self {
        Self {
            index: Mutex::new(HashMap::new()),
            command_names: Mutex::new(Vec::new()),
            data_dir: Mutex::new(None),
            initialized: Mutex::new(false),
            last_updated: Mutex::new(None),
        }
    }
}

// ─── Platform priority ──────────────────────────────────────────

fn get_platform_priority() -> Vec<&'static str> {
    #[cfg(target_os = "macos")]
    {
        vec!["osx", "common"]
    }
    #[cfg(target_os = "linux")]
    {
        vec!["linux", "common"]
    }
    #[cfg(target_os = "windows")]
    {
        vec!["windows", "common"]
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        vec!["common"]
    }
}

// ─── Markdown parser ─────────────────────────────────────────────

fn parse_tldr_page(content: &str, name: &str, platform: &str) -> TldrPage {
    let mut description = String::new();
    let mut examples = Vec::new();
    let mut current_desc: Option<String> = None;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            // Title line — skip, we already have the name
            continue;
        } else if let Some(desc) = trimmed.strip_prefix("> ") {
            // Description line
            if !desc.starts_with("More information:") {
                if !description.is_empty() {
                    description.push(' ');
                }
                description.push_str(desc.trim_end_matches('.'));
            }
        } else if let Some(desc) = trimmed.strip_prefix("- ") {
            // Example description
            current_desc = Some(desc.trim_end_matches(':').to_string());
        } else if trimmed.starts_with('`') && trimmed.ends_with('`') && trimmed.len() > 2 {
            // Example command
            let cmd = &trimmed[1..trimmed.len() - 1];
            if let Some(desc) = current_desc.take() {
                examples.push(TldrExample {
                    description: desc,
                    command: cmd.to_string(),
                });
            }
        }
    }

    TldrPage {
        name: name.to_string(),
        description,
        examples,
        platform: platform.to_string(),
    }
}

// ─── ZIP index builder ──────────────────────────────────────────

fn build_index_from_zip(
    zip_path: &std::path::Path,
) -> Result<(HashMap<String, TldrPage>, Vec<String>), String> {
    let file =
        std::fs::File::open(zip_path).map_err(|e| format!("Failed to open ZIP: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Failed to read ZIP: {}", e))?;

    let mut index: HashMap<String, TldrPage> = HashMap::new();
    let mut command_set: std::collections::HashSet<String> = std::collections::HashSet::new();

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("ZIP entry error: {}", e))?;

        let entry_name = entry.name().to_string();

        // Match paths like: pages/common/tar.md  or  pages.zh/osx/brew.md
        // Inside the ZIP, paths start with "tldr-main/" prefix
        let path = entry_name
            .strip_prefix("tldr-main/")
            .unwrap_or(&entry_name);

        if !path.ends_with(".md") {
            continue;
        }

        // Parse: pages[.lang]/platform/command.md
        let parts: Vec<&str> = path.split('/').collect();
        if parts.len() != 3 {
            continue;
        }

        let pages_dir = parts[0]; // "pages" or "pages.zh"
        let platform = parts[1]; // "common", "osx", "linux", etc.
        let filename = parts[2]; // "tar.md"

        // Determine language from directory name
        let lang = if pages_dir == "pages" {
            "en"
        } else if let Some(l) = pages_dir.strip_prefix("pages.") {
            l
        } else {
            continue;
        };

        // Only index relevant platforms
        let valid_platforms = ["common", "osx", "linux", "windows", "android"];
        if !valid_platforms.contains(&platform) {
            continue;
        }

        let cmd_name = filename.strip_suffix(".md").unwrap_or(filename);

        // Read content
        let mut content = String::new();
        if entry.read_to_string(&mut content).is_err() {
            continue;
        }

        let page = parse_tldr_page(&content, cmd_name, platform);
        let key = format!("{}:{}:{}", lang, platform, cmd_name);
        index.insert(key, page);

        // Track unique command names (only from English pages to avoid duplicates)
        if lang == "en" {
            command_set.insert(cmd_name.to_string());
        }
    }

    let mut commands: Vec<String> = command_set.into_iter().collect();
    commands.sort();

    Ok((index, commands))
}

// ─── Query logic ────────────────────────────────────────────────

fn query_impl(
    index: &HashMap<String, TldrPage>,
    command: &str,
    language: &str,
) -> TldrQueryResult {
    let platforms = get_platform_priority();
    let cmd = command.to_lowercase();

    // Try requested language first, then fall back to English
    let langs: Vec<&str> = if language == "en" {
        vec!["en"]
    } else {
        vec![language, "en"]
    };

    for lang in &langs {
        for platform in &platforms {
            let key = format!("{}:{}:{}", lang, platform, cmd);
            if let Some(page) = index.get(&key) {
                return TldrQueryResult {
                    found: true,
                    page: Some(page.clone()),
                    language: lang.to_string(),
                };
            }
        }
    }

    TldrQueryResult {
        found: false,
        page: None,
        language: language.to_string(),
    }
}

// ─── Cache helpers ──────────────────────────────────────────────

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

const CACHE_EXPIRY_SECS: u64 = 7 * 24 * 3600; // 7 days
const DOWNLOAD_URL: &str =
    "https://github.com/tldr-pages/tldr/releases/latest/download/tldr.zip";

fn ensure_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let dir = app_data.join("tldr");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create tldr dir: {}", e))?;
    Ok(dir)
}

fn read_meta(dir: &std::path::Path) -> Option<CacheMeta> {
    let meta_path = dir.join("meta.json");
    let content = std::fs::read_to_string(meta_path).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_meta(dir: &std::path::Path, meta: &CacheMeta) -> Result<(), String> {
    let meta_path = dir.join("meta.json");
    let content =
        serde_json::to_string(meta).map_err(|e| format!("Failed to serialize meta: {}", e))?;
    std::fs::write(meta_path, content)
        .map_err(|e| format!("Failed to write meta: {}", e))
}

// ─── Tauri commands ─────────────────────────────────────────────

#[tauri::command]
pub async fn tldr_init(
    app: AppHandle,
    state: State<'_, TldrState>,
    _language: String,
    force_update: bool,
) -> Result<TldrStatus, String> {
    let dir = ensure_data_dir(&app)?;
    let zip_path = dir.join("tldr.zip");

    *state.data_dir.lock().unwrap() = Some(dir.clone());

    // Check if we need to download
    let need_download = if force_update || !zip_path.exists() {
        true
    } else if let Some(meta) = read_meta(&dir) {
        now_unix().saturating_sub(meta.last_updated) > CACHE_EXPIRY_SECS
    } else {
        true
    };

    if need_download {
        // Download ZIP
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| format!("HTTP client error: {}", e))?;

        let resp = client
            .get(DOWNLOAD_URL)
            .send()
            .await
            .map_err(|e| format!("Download failed: {}", e))?;

        if !resp.status().is_success() {
            // If download fails but we have a cached ZIP, use it
            if zip_path.exists() {
                // Fall through to build index from cache
            } else {
                return Err(format!("Download failed with status: {}", resp.status()));
            }
        } else {
            let bytes = resp
                .bytes()
                .await
                .map_err(|e| format!("Failed to read response: {}", e))?;

            std::fs::write(&zip_path, &bytes)
                .map_err(|e| format!("Failed to save ZIP: {}", e))?;

            write_meta(
                &dir,
                &CacheMeta {
                    last_updated: now_unix(),
                    size: bytes.len() as u64,
                },
            )?;
        }
    }

    // Build index from ZIP
    if !zip_path.exists() {
        return Err("No tldr data available".to_string());
    }

    let (new_index, commands) = build_index_from_zip(&zip_path)?;
    let page_count = new_index.len();

    *state.index.lock().unwrap() = new_index;
    *state.command_names.lock().unwrap() = commands;
    *state.initialized.lock().unwrap() = true;

    let last_updated = read_meta(&dir).map(|m| m.last_updated);
    *state.last_updated.lock().unwrap() = last_updated;

    Ok(TldrStatus {
        initialized: true,
        page_count,
        last_updated,
    })
}

#[tauri::command]
pub fn tldr_query(
    state: State<'_, TldrState>,
    command: String,
    language: String,
) -> Result<TldrQueryResult, String> {
    let index = state.index.lock().unwrap();
    Ok(query_impl(&index, &command, &language))
}

#[tauri::command]
pub fn tldr_status(state: State<'_, TldrState>) -> Result<TldrStatus, String> {
    let initialized = *state.initialized.lock().unwrap();
    let page_count = state.index.lock().unwrap().len();
    let last_updated = *state.last_updated.lock().unwrap();

    Ok(TldrStatus {
        initialized,
        page_count,
        last_updated,
    })
}

#[tauri::command]
pub fn tldr_list_commands(state: State<'_, TldrState>) -> Result<Vec<String>, String> {
    let commands = state.command_names.lock().unwrap();
    Ok(commands.clone())
}
