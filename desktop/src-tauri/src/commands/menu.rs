use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Manager,
};
#[cfg(not(target_os = "windows"))]
use tauri::menu::Submenu;
use tauri::State;

use crate::AppLifecycleState;

pub fn tray_label(language: &str, key: &str) -> &'static str {
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
        ("zh", "pip_toggle") => "画中画",
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
        (_, "pip_toggle") => "Picture-in-Picture",
        _ => "",
    }
}

/// Build the "Check for Updates" menu item label, appending a badge dot
/// when a pending update version is known.
pub fn build_check_updates_label(language: &str, pending_version: Option<&str>) -> String {
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
pub fn app_label(language: &str, key: &str) -> &'static str {
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
        ("zh", "pip_toggle") => "画中画",
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
        (_, "pip_toggle") => "Picture-in-Picture",
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
    let view_pip_item = MenuItem::with_id(app, "pip_toggle", app_label(language, "pip_toggle"), true, Some("CmdOrCtrl+Shift+P"))
        .map_err(|e| e.to_string())?;
    let view_reload_item = MenuItem::with_id(app, "reload", app_label(language, "reload"), true, Some("CmdOrCtrl+R"))
        .map_err(|e| e.to_string())?;
    let view_sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let view_submenu = Submenu::with_items(app, app_label(language, "view"), true, &[&view_show_home_item, &view_pip_item, &view_sep, &view_reload_item])
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

    let pip_toggle_item = MenuItem::with_id(
        &app,
        "pip_toggle",
        tray_label(&language, "pip_toggle"),
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
            &pip_toggle_item,
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
