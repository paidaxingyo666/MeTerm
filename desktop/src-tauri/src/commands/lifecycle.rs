use tauri::{AppHandle, Manager, State};

use crate::AppLifecycleState;

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

/// Called from frontend when a window is created via the JS WebviewWindow API
/// (Windows path) so the Rust grace-period protection can track it.
#[tauri::command]
pub fn track_window_created_ts(app: AppHandle, window_label: String) {
    let lifecycle = app.state::<crate::AppLifecycleState>();
    lifecycle.track_window_created(&window_label);
}

#[tauri::command]
pub fn request_app_quit(app: AppHandle, state: State<'_, AppLifecycleState>) {
    state.mark_quitting();
    app.exit(0);
}
