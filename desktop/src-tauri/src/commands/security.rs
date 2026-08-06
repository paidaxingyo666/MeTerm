use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::State;

use crate::server::ServerState;

// ─── Native-only cleanup for insecure legacy Keychain ACLs ───

const RELEASE_INSECURE_LEGACY_KEYCHAIN_SERVICES: &[&str] = &[
    "com.meterm.dev.ssh",
    "com.meterm.app.jumpserver",
    "com.meterm.dev.jumpserver",
    "com.meterm.app.remote",
    "com.meterm.dev.remote",
    "com.meterm.app.settings",
    "com.meterm.dev.settings",
];

// Debug builds never perform service-wide Keychain deletion. Even a
// `com.meterm.dev.*` service can contain entries created under an older signing
// requirement, and SecItemDelete then returns errSecInvalidOwnerEdit. Legacy
// cleanup remains a strict release migration; development uses fresh,
// channel-specific vault services instead.
const DEBUG_INSECURE_LEGACY_KEYCHAIN_SERVICES: &[&str] = &[];

fn insecure_legacy_keychain_services_for_build(debug_build: bool) -> &'static [&'static str] {
    if debug_build {
        DEBUG_INSECURE_LEGACY_KEYCHAIN_SERVICES
    } else {
        RELEASE_INSECURE_LEGACY_KEYCHAIN_SERVICES
    }
}

/// Fixed-service helper reserved for an explicit, owner-confirmed maintenance
/// flow. Normal server startup must never call it. This is not a Tauri command,
/// takes no caller-supplied service name, and excludes current authority-bound
/// services.
#[allow(dead_code)]
pub(crate) fn scrub_insecure_legacy_keychain_services_for_maintenance() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        for service in insecure_legacy_keychain_services_for_build(cfg!(debug_assertions)) {
            macos_service_scrub::scrub(service)?;
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod macos_service_scrub {
    use std::ffi::c_void;
    use std::ptr;

    type CfIndex = isize;
    type CfStringEncoding = u32;
    type CfStringRef = *const c_void;
    type CfMutableDictionaryRef = *const c_void;
    type OsStatus = i32;

    const UTF8: CfStringEncoding = 0x0800_0100;
    const ERR_SEC_SUCCESS: OsStatus = 0;
    const ERR_SEC_ITEM_NOT_FOUND: OsStatus = -25300;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
        fn CFStringCreateWithBytes(
            alloc: *const c_void,
            bytes: *const u8,
            length: CfIndex,
            encoding: CfStringEncoding,
            external: u8,
        ) -> CfStringRef;
        fn CFDictionaryCreateMutable(
            alloc: *const c_void,
            capacity: CfIndex,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> CfMutableDictionaryRef;
        fn CFDictionarySetValue(
            dictionary: CfMutableDictionaryRef,
            key: *const c_void,
            value: *const c_void,
        );
        fn CFRelease(value: *const c_void);
    }

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        static kSecClass: CfStringRef;
        static kSecClassGenericPassword: CfStringRef;
        static kSecAttrService: CfStringRef;
        fn SecItemDelete(query: *const c_void) -> OsStatus;
    }

    pub(super) fn scrub(service: &str) -> Result<(), String> {
        unsafe {
            let service_ref = CFStringCreateWithBytes(
                ptr::null(),
                service.as_ptr(),
                service.len() as CfIndex,
                UTF8,
                0,
            );
            if service_ref.is_null() {
                return Err("failed to create legacy Keychain query".to_string());
            }
            let query = CFDictionaryCreateMutable(
                ptr::null(),
                0,
                ptr::addr_of!(kCFTypeDictionaryKeyCallBacks),
                ptr::addr_of!(kCFTypeDictionaryValueCallBacks),
            );
            if query.is_null() {
                CFRelease(service_ref);
                return Err("failed to create legacy Keychain query".to_string());
            }
            CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
            CFDictionarySetValue(query, kSecAttrService, service_ref);
            let status = SecItemDelete(query);
            CFRelease(query);
            CFRelease(service_ref);
            match status {
                ERR_SEC_SUCCESS | ERR_SEC_ITEM_NOT_FOUND => Ok(()),
                other => Err(format!("legacy Keychain maintenance scrub failed: {other}")),
            }
        }
    }
}

// ─── One-time localStorage migration from old bundle ID ───

const LEGACY_UI_PREFERENCE_KEYS: &[&str] = &[
    "meterm-language",
    "meterm-hide-update-icon",
    "meterm-hide-to-tray-pref",
    "meterm-pairing-autoclose",
    "meterm-ai-bar-collapsed",
    "meterm-ai-layout-mode",
    "meterm-ai-side-width",
    "meterm-js-panel-width",
    "meterm-js-browser-docked",
    "meterm-editor-font-size",
    "meterm-editor-window-size",
];
const MAX_LEGACY_PREFERENCE_BYTES: usize = 8 * 1024;
static LEGACY_STORAGE_CONSUMED: OnceLock<Mutex<bool>> = OnceLock::new();

fn should_consume_legacy_ui_preferences(debug_build: bool) -> bool {
    // The signed development bundle itself uses com.meterm.dev. Treating that
    // live WebKit store as a legacy Release source would delete its own state
    // and retrigger migrations on every launch.
    !debug_build
}

/// One-shot, main-window-only migration for a strict list of non-secret UI
/// preferences. Only exact allowlisted UI rows are consumed; credential/history
/// rows remain untouched for an explicit recovery or cleanup flow. A second
/// call in the same process returns no data. Debug is always a no-op because
/// com.meterm.dev is its current, not legacy, WebKit store.
#[tauri::command]
pub async fn consume_legacy_ui_preferences(
    window: tauri::WebviewWindow,
) -> Result<Option<HashMap<String, String>>, String> {
    if window.label() != "main" {
        return Err("legacy preference migration is main-window startup only".to_string());
    }
    if !should_consume_legacy_ui_preferences(cfg!(debug_assertions)) {
        return Ok(None);
    }
    let mut consumed = LEGACY_STORAGE_CONSUMED
        .get_or_init(|| Mutex::new(false))
        .lock()
        .map_err(|_| "legacy preference migration is unavailable".to_string())?;
    if *consumed {
        return Ok(None);
    }

    let home = dirs::home_dir().ok_or("cannot determine home directory")?;
    let old_base = home.join("Library/WebKit/com.meterm.dev/WebsiteData/Default");
    if !old_base.exists() {
        *consumed = true;
        return Ok(None);
    }

    let mut databases = Vec::new();
    for entry in walkdir::WalkDir::new(&old_base)
        .max_depth(8)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if entry.file_type().is_file() && entry.file_name() == "localstorage.sqlite3" {
            databases.push(entry.into_path());
            if databases.len() > 32 {
                return Err("too many legacy localStorage databases".to_string());
            }
        }
    }

    let mut result = HashMap::new();
    for path in databases {
        result.extend(consume_sqlite_localstorage(&path)?);
    }
    *consumed = true;
    if result.is_empty() {
        Ok(None)
    } else {
        Ok(Some(result))
    }
}

fn consume_sqlite_localstorage(path: &std::path::Path) -> Result<HashMap<String, String>, String> {
    use rusqlite::OptionalExtension;

    let mut conn = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| "failed to open legacy localStorage".to_string())?;
    conn.pragma_update(None, "secure_delete", "ON")
        .map_err(|_| "failed to secure legacy localStorage".to_string())?;
    let transaction = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| "failed to lock legacy localStorage".to_string())?;
    let mut result = HashMap::new();

    for key in LEGACY_UI_PREFERENCE_KEYS {
        let raw = transaction
            .query_row(
                "SELECT value FROM ItemTable WHERE key = ?1 LIMIT 1",
                [key],
                |row| decode_localstorage_value(row.get_ref(0)?),
            )
            .optional()
            .map_err(|_| "failed to read legacy localStorage".to_string())?;
        if let Some(Ok(value)) = raw {
            if let Some(value) = validate_legacy_preference(key, value) {
                result.insert((*key).to_string(), value);
            }
        }
        transaction
            .execute("DELETE FROM ItemTable WHERE key = ?1", [key])
            .map_err(|_| "failed to consume legacy UI preference".to_string())?;
    }
    transaction
        .commit()
        .map_err(|_| "failed to commit legacy localStorage migration".to_string())?;
    let _ = conn.pragma_update(None, "wal_checkpoint", "TRUNCATE");
    Ok(result)
}

fn decode_localstorage_value(
    value: rusqlite::types::ValueRef<'_>,
) -> rusqlite::Result<Result<String, ()>> {
    let decoded = match value {
        rusqlite::types::ValueRef::Text(bytes) if bytes.len() <= MAX_LEGACY_PREFERENCE_BYTES => {
            std::str::from_utf8(bytes)
                .map(str::to_string)
                .map_err(|_| ())
        }
        rusqlite::types::ValueRef::Blob(bytes)
            if bytes.len() <= MAX_LEGACY_PREFERENCE_BYTES && bytes.len() % 2 == 0 =>
        {
            let utf16 = bytes
                .chunks_exact(2)
                .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
                .collect::<Vec<_>>();
            String::from_utf16(&utf16).map_err(|_| ())
        }
        _ => Err(()),
    };
    Ok(decoded)
}

fn validate_legacy_preference(key: &str, value: String) -> Option<String> {
    match key {
        "meterm-language" if matches!(value.as_str(), "en" | "zh") => Some(value),
        "meterm-hide-update-icon" if value == "1" => Some(value),
        "meterm-hide-to-tray-pref" if value == "always_hide" => Some(value),
        "meterm-pairing-autoclose" if matches!(value.as_str(), "true" | "false") => Some(value),
        "meterm-ai-bar-collapsed" if matches!(value.as_str(), "0" | "1") => Some(value),
        "meterm-ai-layout-mode" if matches!(value.as_str(), "bottom" | "side") => Some(value),
        "meterm-ai-side-width" | "meterm-js-panel-width" => value
            .parse::<u16>()
            .ok()
            .filter(|width| (100..=4_000).contains(width))
            .map(|width| width.to_string()),
        "meterm-js-browser-docked" if matches!(value.as_str(), "true" | "false") => Some(value),
        "meterm-editor-font-size" => value
            .parse::<u8>()
            .ok()
            .filter(|size| (10..=24).contains(size))
            .map(|size| size.to_string()),
        "meterm-editor-window-size" => {
            let parsed = serde_json::from_str::<serde_json::Value>(&value).ok()?;
            let width = parsed.get("width")?.as_u64()?;
            let height = parsed.get("height")?.as_u64()?;
            if !(320..=8_192).contains(&width) || !(240..=8_192).contains(&height) {
                return None;
            }
            Some(serde_json::json!({ "width": width, "height": height }).to_string())
        }
        _ => None,
    }
}

// ─── IP ban management ───

#[tauri::command]
pub async fn list_banned_ips(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<ServerState>>,
) -> Result<String, String> {
    require_security_window(&window)?;
    let bans = state.ban_manager.list();
    Ok(serde_json::json!({ "banned_ips": bans }).to_string())
}

#[tauri::command]
pub async fn ban_ip(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<ServerState>>,
    ip: String,
    reason: Option<String>,
) -> Result<String, String> {
    require_security_window(&window)?;
    super::validate_ip(&ip)?;
    state
        .ban_manager
        .ban(&ip, &reason.unwrap_or_default())
        .map_err(|e| e)?;
    state.session_manager.kick_by_ip(&ip);
    Ok(serde_json::json!({ "ok": true }).to_string())
}

#[tauri::command]
pub async fn unban_ip(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<ServerState>>,
    ip: String,
) -> Result<String, String> {
    require_security_window(&window)?;
    super::validate_ip(&ip)?;
    let found = state.ban_manager.unban(&ip);
    Ok(serde_json::json!({ "ok": true, "found": found }).to_string())
}

// ─── Token management ───

#[tauri::command]
pub async fn refresh_token(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<ServerState>>,
) -> Result<String, String> {
    require_security_window(&window)?;
    let new_token = crate::server::generate_token();
    state.update_token(new_token.clone())?;
    Ok(serde_json::json!({ "ok": true, "token": new_token }).to_string())
}

#[tauri::command]
pub async fn set_custom_token(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<ServerState>>,
    token: String,
) -> Result<String, String> {
    require_security_window(&window)?;
    state.update_token(token)?;
    Ok(serde_json::json!({ "ok": true }).to_string())
}

#[tauri::command]
pub async fn revoke_all_clients(
    window: tauri::WebviewWindow,
    state: State<'_, Arc<ServerState>>,
) -> Result<String, String> {
    require_security_window(&window)?;
    let new_token = crate::server::generate_token();
    let outcome = state
        .revoke_all_for_local_owner(new_token.clone())
        .map_err(|error| error.to_string())?;
    let cleanup = state.disconnect_device_generations(&outcome.retired_devices);
    Ok(serde_json::json!({
        "ok": outcome.devices_revoked,
        "new_token": new_token,
        "owner_rotated": true,
        "devices_revoked": outcome.devices_revoked,
        "device_error": outcome.device_error,
        "disconnected": cleanup.disconnected,
        "presence_disconnected": cleanup.presence_disconnected,
        "push_removed": cleanup.push_removed,
    })
    .to_string())
}

// ─── Proxy settings ───

#[tauri::command]
pub fn set_proxy_mode(window: tauri::WebviewWindow, mode: String) -> Result<(), String> {
    require_security_window(&window)?;
    let bypass = mode != "system";
    let old_bypass =
        crate::server::jumpserver::BYPASS_PROXY.swap(bypass, std::sync::atomic::Ordering::Relaxed);
    // 仅在代理模式真正改变时才清空 client pool，避免重复调用时丢失认证状态
    if old_bypass != bypass {
        crate::server::jumpserver::clear_client_pool();
        eprintln!(
            "[settings] proxy mode changed: {} (bypass={})",
            mode, bypass
        );
    } else {
        eprintln!(
            "[settings] proxy mode: {} (bypass={}, unchanged)",
            mode, bypass
        );
    }
    Ok(())
}

fn require_security_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    let label = window.label();
    if label == "main" || label == "settings" || label.starts_with("window-") {
        Ok(())
    } else {
        Err("security operation is unavailable to this window".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_preference_allowlist_rejects_secret_bearing_keys() {
        assert!(validate_legacy_preference("meterm-language", "zh".to_string()).is_some());
        for key in [
            "meterm-settings",
            "meterm-ssh-connections",
            "meterm-remote-connections",
            "meterm-jumpserver-connections",
            "meterm-ai-history",
        ] {
            assert!(validate_legacy_preference(key, "secret".to_string()).is_none());
        }
    }

    #[test]
    fn maintenance_scrub_excludes_current_and_per_connection_migration_services() {
        for service in [
            "com.meterm.app.ssh",
            "com.meterm.app.ssh.v2",
            "com.meterm.app.ssh.v3",
            "com.meterm.app.jumpserver.v3",
            "com.meterm.app.remote.v2",
            "com.meterm.app.settings.v2",
            "com.meterm.app.settings.v3",
        ] {
            assert!(!RELEASE_INSECURE_LEGACY_KEYCHAIN_SERVICES.contains(&service));
        }
    }

    #[test]
    fn debug_startup_skips_legacy_keychain_mutation() {
        let services = insecure_legacy_keychain_services_for_build(true);
        assert_eq!(services, DEBUG_INSECURE_LEGACY_KEYCHAIN_SERVICES);
        assert!(services.is_empty());
        assert!(!should_consume_legacy_ui_preferences(true));
    }

    #[test]
    fn release_maintenance_scrub_retains_the_complete_security_baseline() {
        assert_eq!(
            insecure_legacy_keychain_services_for_build(false),
            RELEASE_INSECURE_LEGACY_KEYCHAIN_SERVICES
        );
        assert!(should_consume_legacy_ui_preferences(false));
    }

    #[test]
    fn sqlite_consume_returns_only_safe_preferences_and_preserves_other_rows() {
        let path = std::env::temp_dir().join(format!(
            "meterm-legacy-localstorage-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute(
            "CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
            ("meterm-language", "zh"),
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
            (
                "meterm-editor-window-size",
                r#"{"width":900,"height":700,"token":"secret"}"#,
            ),
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
            ("meterm-ssh-connections", r#"{"password":"secret"}"#),
        )
        .unwrap();
        drop(conn);

        let migrated = consume_sqlite_localstorage(&path).unwrap();
        assert_eq!(
            migrated.get("meterm-language").map(String::as_str),
            Some("zh")
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                migrated.get("meterm-editor-window-size").unwrap()
            )
            .unwrap(),
            serde_json::json!({ "width": 900, "height": 700 })
        );
        assert!(!migrated.contains_key("meterm-ssh-connections"));
        assert!(!migrated.values().any(|value| value.contains("secret")));

        let conn = rusqlite::Connection::open(&path).unwrap();
        let remaining: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM ItemTable WHERE key GLOB 'meterm-*'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 1);
        let preserved: String = conn
            .query_row(
                "SELECT value FROM ItemTable WHERE key = 'meterm-ssh-connections'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(preserved.contains("secret"));
        drop(conn);
        let _ = std::fs::remove_file(path);
    }
}
