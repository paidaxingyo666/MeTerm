mod commands;
mod sidecar;

/// Debug logging macro - only emits in debug builds, stripped from release.
macro_rules! debug_log {
    ($($arg:tt)*) => {{
        #[cfg(debug_assertions)]
        eprintln!($($arg)*);
    }};
}

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent,
};
use serde::Serialize;

#[derive(Clone, Serialize)]
struct WindowEvent {
	target_window: String,
}
use sidecar::MeTermProcess;

use std::collections::HashSet;
use std::io::Write;

fn get_log_path() -> Option<std::path::PathBuf> {
    // Try LOCALAPPDATA (Windows), then HOME, then USERPROFILE
    std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("HOME"))
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(|d| std::path::PathBuf::from(d).join("meterm-startup.log"))
        .ok()
}

pub fn startup_log(msg: &str) {
    if let Some(path) = get_log_path() {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let elapsed = APP_START.elapsed().as_millis();
            let _ = writeln!(f, "[+{:>6}ms] {}", elapsed, msg);
        }
    }
}

fn startup_log_reset() {
    if let Some(path) = get_log_path() {
        let _ = std::fs::write(&path, "");
    }
}

static APP_START: std::sync::LazyLock<Instant> = std::sync::LazyLock::new(Instant::now);

pub struct AppLifecycleState {
    has_open_tabs: Mutex<bool>,
    is_quitting: AtomicBool,
    last_menu_event: Mutex<Option<(String, Instant)>>,
    windows_allowed_to_close: Mutex<HashSet<String>>,
    initialized_windows: Mutex<HashSet<String>>,
    current_language: Mutex<String>,
    discoverable: Mutex<bool>,
    pending_update: Mutex<Option<String>>,
}

impl AppLifecycleState {
    fn new() -> Self {
        Self {
            has_open_tabs: Mutex::new(false),
            is_quitting: AtomicBool::new(false),
            last_menu_event: Mutex::new(None),
            windows_allowed_to_close: Mutex::new(HashSet::new()),
            initialized_windows: Mutex::new(HashSet::new()),
            current_language: Mutex::new("en".to_string()),
            discoverable: Mutex::new(false),
            pending_update: Mutex::new(None),
        }
    }

    pub fn set_has_open_tabs(&self, has_open_tabs: bool) {
        if let Ok(mut guard) = self.has_open_tabs.lock() {
            *guard = has_open_tabs;
        }
    }

    fn has_open_tabs(&self) -> bool {
        self.has_open_tabs
            .lock()
            .map(|guard| *guard)
            .unwrap_or(false)
    }

    pub fn mark_quitting(&self) {
        self.is_quitting.store(true, Ordering::SeqCst);
    }

    fn is_quitting(&self) -> bool {
        self.is_quitting.load(Ordering::SeqCst)
    }

    pub fn allow_window_close(&self, label: &str) {
        if let Ok(mut guard) = self.windows_allowed_to_close.lock() {
            guard.insert(label.to_string());
        }
    }

    fn is_window_allowed_to_close(&self, label: &str) -> bool {
        self.windows_allowed_to_close
            .lock()
            .map(|guard| guard.contains(label))
            .unwrap_or(false)
    }

    fn remove_window_from_allowed_list(&self, label: &str) {
        if let Ok(mut guard) = self.windows_allowed_to_close.lock() {
            guard.remove(label);
        }
    }

    pub fn mark_window_initialized(&self, label: &str) {
        if let Ok(mut guard) = self.initialized_windows.lock() {
            guard.insert(label.to_string());
        }
    }

    fn is_window_initialized(&self, label: &str) -> bool {
        self.initialized_windows
            .lock()
            .map(|guard| guard.contains(label))
            .unwrap_or(false)
    }

    fn remove_initialized_window(&self, label: &str) {
        if let Ok(mut guard) = self.initialized_windows.lock() {
            guard.remove(label);
        }
    }

    pub fn set_language(&self, language: String) {
        if let Ok(mut guard) = self.current_language.lock() {
            *guard = language;
        }
    }

    pub fn current_language(&self) -> String {
        self.current_language
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| "en".to_string())
    }

    pub fn set_discoverable(&self, value: bool) {
        if let Ok(mut guard) = self.discoverable.lock() {
            *guard = value;
        }
    }

    pub fn is_discoverable(&self) -> bool {
        self.discoverable
            .lock()
            .map(|guard| *guard)
            .unwrap_or(false)
    }

    pub fn set_pending_update(&self, version: Option<String>) {
        if let Ok(mut guard) = self.pending_update.lock() {
            *guard = version;
        }
    }

    pub fn pending_update(&self) -> Option<String> {
        self.pending_update
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or(None)
    }

    fn should_dispatch_menu_event(&self, menu_id: &str) -> bool {
        const DEDUPE_WINDOW: Duration = Duration::from_millis(250);
        let now = Instant::now();
        if let Ok(mut guard) = self.last_menu_event.lock() {
            if let Some((last_id, last_time)) = guard.as_ref() {
                if last_id == menu_id && now.duration_since(*last_time) <= DEDUPE_WINDOW {
                    return false;
                }
            }
            *guard = Some((menu_id.to_string(), now));
        }
        true
    }
}

fn normalize_menu_id(raw: &str) -> Option<&'static str> {
	match raw {
		"new_window" => Some("new_window"),
		"show_home" => Some("show_home"),
		"new_terminal" => Some("new_terminal"),
		"new_private_terminal" => Some("new_private_terminal"),
		"settings" => Some("settings"),
		"close_all_sessions" => Some("close_all_sessions"),
		"quit_all" => Some("quit_all"),
		"quit" => Some("quit"),
		"undo" => Some("undo"),
		"redo" => Some("redo"),
		"cut" => Some("cut"),
		"copy" => Some("copy"),
		"paste" => Some("paste"),
		"select_all" => Some("select_all"),
		"reload" => Some("reload"),
		"show_about" => Some("show_about"),
		"show_shortcuts" => Some("show_shortcuts"),
		"import_connections" => Some("import_connections"),
		"export_connections" => Some("export_connections"),
		"lan_discover" => Some("lan_discover"),
		"check_updates" => Some("check_updates"),
		_ => None,
	}
}

fn get_target_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
	// Try to get the currently focused window first
	for window in app.webview_windows().values() {
		if let Ok(is_focused) = window.is_focused() {
			if is_focused {
				debug_log!("[DEBUG] Using focused window: {}", window.label());
				return Some(window.clone());
			}
		}
	}

	// Fall back to any visible window
	for window in app.webview_windows().values() {
		if let Ok(is_visible) = window.is_visible() {
			if is_visible {
				debug_log!("[DEBUG] Using visible window: {}", window.label());
				return Some(window.clone());
			}
		}
	}

	// Finally, fall back to main window
	debug_log!("[DEBUG] Using main window as fallback");
	app.get_webview_window("main")
}

fn get_quit_confirmation_window(app: &tauri::AppHandle) -> String {
	// For quit confirmation, prefer main window if visible, otherwise any visible window
	if let Some(window) = app.get_webview_window("main") {
		if window.is_visible().unwrap_or(false) {
			return "main".to_string();
		}
	}
	// Find first visible window
	app.webview_windows().values()
		.find(|w| w.is_visible().unwrap_or(false))
		.map(|w| w.label().to_string())
		.unwrap_or_else(|| "main".to_string())
}

fn dispatch_menu_action(app: &tauri::AppHandle, action: &str) {
	let Some(window) = get_target_window(app) else {
		debug_log!("[DEBUG] Failed to get any window");
		return;
	};

	let window_label = window.label().to_string();
	debug_log!("[DEBUG] Dispatching {} to window {}", action, window_label);

		match action {
			"new_window" => {
				#[cfg(target_os = "windows")]
				{
					let _ = window.show();
					let _ = window.set_focus();
					let payload = WindowEvent { target_window: window_label.clone() };
					match app.emit("menu-new-window", payload) {
						Ok(_) => debug_log!("[DEBUG] Successfully emitted menu-new-window to {}", window_label),
						Err(_e) => debug_log!("[DEBUG] Failed to emit menu-new-window: {}", _e),
					}
				}

				#[cfg(not(target_os = "windows"))]
				{
					debug_log!("[DEBUG] Creating new window");
					use tauri::WebviewWindowBuilder;
					use tauri::WebviewUrl;
					#[cfg(target_os = "macos")]
					use tauri::TitleBarStyle;

					let new_window_label = format!(
						"window-{}",
						std::time::SystemTime::now()
							.duration_since(std::time::UNIX_EPOCH)
							.unwrap()
							.as_millis()
					);

					#[allow(unused_mut)]
					let mut builder = WebviewWindowBuilder::new(app, &new_window_label, WebviewUrl::default())
						.title("MeTerm")
						.inner_size(1000.0, 700.0)
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

					match builder.build() {
						Ok(new_window) => {
							debug_log!("[DEBUG] Successfully created new window: {}", new_window_label);
							let _ = new_window.show();
							let _ = new_window.set_focus();
						}
						Err(_e) => debug_log!("[DEBUG] Failed to create new window: {}", _e),
					}
				}
			}
			"show_home" => {
			let _ = window.show();
			let _ = window.set_focus();
			let payload = WindowEvent { target_window: window_label.clone() };
			match app.emit("menu-show-home", payload) {
				Ok(_) => debug_log!("[DEBUG] Successfully emitted menu-show-home to {}", window_label),
				Err(_e) => debug_log!("[DEBUG] Failed to emit menu-show-home: {}", _e),
			}
		}
		"new_terminal" => {
			let _ = window.show();
			let _ = window.set_focus();
			let payload = WindowEvent { target_window: window_label.clone() };
			match app.emit("menu-new-terminal", payload) {
				Ok(_) => debug_log!("[DEBUG] Successfully emitted menu-new-terminal to {}", window_label),
				Err(_e) => debug_log!("[DEBUG] Failed to emit menu-new-terminal: {}", _e),
			}
		}
		"new_private_terminal" => {
			let _ = window.show();
			let _ = window.set_focus();
			let payload = WindowEvent { target_window: window_label.clone() };
			match app.emit("menu-new-private-terminal", payload) {
				Ok(_) => debug_log!("[DEBUG] Successfully emitted menu-new-private-terminal to {}", window_label),
				Err(_e) => debug_log!("[DEBUG] Failed to emit menu-new-private-terminal: {}", _e),
			}
		}
		"settings" => {
			let _ = window.show();
			let _ = window.set_focus();
			let payload = WindowEvent { target_window: window_label.clone() };
			match app.emit("menu-open-settings", payload) {
				Ok(_) => debug_log!("[DEBUG] Successfully emitted menu-open-settings to {}", window_label),
				Err(_e) => debug_log!("[DEBUG] Failed to emit menu-open-settings: {}", _e),
			}
		}
		"close_all_sessions" => {
			let _ = window.show();
			let _ = window.set_focus();
			let payload = WindowEvent { target_window: window_label.clone() };
			match app.emit("menu-close-all-sessions", payload) {
				Ok(_) => debug_log!("[DEBUG] Successfully emitted menu-close-all-sessions to {}", window_label),
				Err(_e) => debug_log!("[DEBUG] Failed to emit menu-close-all-sessions: {}", _e),
			}
		}
		"quit" => {
			// Send window close request to all windows, each window will confirm independently
			debug_log!("[DEBUG] Sending window close request to all windows");
			// Get all window labels
			let window_labels: Vec<String> = app.webview_windows().keys().map(|k| k.to_string()).collect();
			for label in window_labels {
				let payload = WindowEvent { target_window: label.clone() };
				let _ = app.emit("window-close-requested", payload);
			}
		}
		"quit_all" => {
			debug_log!("[DEBUG] Quit all requested");

			// First, show, unminimize, and bring to front all windows
			for window in app.webview_windows().values() {
				let _ = window.show();
				let _ = window.unminimize();
				let _ = window.set_focus();
				#[cfg(target_os = "macos")]
				{
					// On macOS, ensure windows are brought to front
					let _ = window.set_always_on_top(true);
					let _ = window.set_always_on_top(false);
				}
				debug_log!("[DEBUG] Window {} shown and focused", window.label());
			}

			// Wait a bit to ensure windows are visible
			std::thread::sleep(std::time::Duration::from_millis(300));

			// Send event to frontend to show confirmation dialog
			// Choose one window to show the dialog
			let target_label = get_quit_confirmation_window(app);
			debug_log!("[DEBUG] Sending quit-all confirmation request to window: {}", target_label);
			let _ = app.emit("menu-quit-all-requested", WindowEvent { target_window: target_label });
		}
		"undo" => {
			let _ = app.emit("menu-undo", WindowEvent { target_window: window_label.clone() });
		}
		"redo" => {
			let _ = app.emit("menu-redo", WindowEvent { target_window: window_label.clone() });
		}
		"cut" => {
			let _ = app.emit("menu-cut", WindowEvent { target_window: window_label.clone() });
		}
		"copy" => {
			let _ = app.emit("menu-copy", WindowEvent { target_window: window_label.clone() });
		}
		"paste" => {
			let _ = app.emit("menu-paste", WindowEvent { target_window: window_label.clone() });
		}
		"select_all" => {
			let _ = app.emit("menu-select-all", WindowEvent { target_window: window_label.clone() });
		}
		"reload" => {
			let _ = app.emit("menu-reload", WindowEvent { target_window: window_label.clone() });
		}
		"show_about" => {
			let _ = app.emit("menu-show-about", WindowEvent { target_window: window_label.clone() });
		}
		"show_shortcuts" => {
			let _ = app.emit("menu-show-shortcuts", WindowEvent { target_window: window_label.clone() });
		}
		"import_connections" => {
			let _ = window.show();
			let _ = window.set_focus();
			let _ = app.emit("menu-import-connections", WindowEvent { target_window: window_label.clone() });
		}
		"export_connections" => {
			let _ = window.show();
			let _ = window.set_focus();
			let _ = app.emit("menu-export-connections", WindowEvent { target_window: window_label.clone() });
		}
		"lan_discover" => {
			let lifecycle = app.state::<AppLifecycleState>();
			let new_state = !lifecycle.is_discoverable();
			lifecycle.set_discoverable(new_state);
			// Rebuild tray menu with updated checked state
			let lang = lifecycle.current_language();
			let _ = commands::set_tray_language(app.clone(), lang);
			let _ = app.emit("menu-toggle-lan-discover", serde_json::json!({ "enabled": new_state }));
		}
		"check_updates" => {
			let _ = window.show();
			let _ = window.set_focus();
			let payload = WindowEvent { target_window: window_label.clone() };
			let _ = app.emit("menu-check-updates", payload);
		}
		_ => {}
	}
}

fn handle_menu_event(app: &tauri::AppHandle, raw_id: &str) {
	debug_log!("[DEBUG] Menu event received: raw_id={}", raw_id);
	let Some(action) = normalize_menu_id(raw_id) else {
		debug_log!("[DEBUG] Ignored unknown menu id: {}", raw_id);
		return;
	};
	debug_log!("[DEBUG] Normalized action: {}", action);
	let lifecycle = app.state::<AppLifecycleState>();

	// Block window-creating actions until the main window has fully initialized.
	// During startup, Tauri/Windows may fire spurious menu events that should not
	// create new windows.
	if (action == "new_window" || action == "new_terminal" || action == "new_private_terminal")
		&& !lifecycle.is_window_initialized("main")
	{
		debug_log!("[DEBUG] Blocked {} during startup (main window not yet initialized)", action);
		return;
	}

	if !lifecycle.should_dispatch_menu_event(action) {
		debug_log!("[DEBUG] Blocked duplicate event for: {}", action);
		return;
	}
	debug_log!("[DEBUG] Dispatching action: {}", action);
	dispatch_menu_action(app, action);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = *APP_START; // initialize timer
    startup_log_reset();
    startup_log("=== App starting ===");

    let meterm = MeTermProcess::new();
    let lifecycle = AppLifecycleState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            startup_log(&format!("Single-instance callback: args={:?}", args));
            // Another instance was launched — focus the existing main window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(meterm)
        .manage(lifecycle)
        .setup(|app| {
            startup_log("Setup: begin");

            // Override macOS notification application ID so the notification icon
            // matches our app instead of Terminal.app (the plugin default in dev mode)
            #[cfg(target_os = "macos")]
            {
                let _ = notify_rust::set_application("com.meterm.dev");
            }
            // Log all windows that exist at this point
            let win_labels: Vec<String> = app.webview_windows().keys().cloned().collect();
            startup_log(&format!("Setup: existing windows = {:?}", win_labels));

            let meterm = app.state::<MeTermProcess>();
            let port = match meterm.start(app.handle()) {
                Ok(p) => p,
                Err(e) => {
                    startup_log(&format!("FATAL: backend start failed: {}", e));
                    eprintln!("FATAL: backend start failed: {}", e);
                    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                    app.dialog()
                        .message(&e)
                        .title("MeTerm")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                    std::process::exit(1);
                }
            };

            startup_log(&format!("Setup: sidecar started on port {}", port));
            eprintln!("meterm sidecar started on 127.0.0.1:{}", port);

            let quit_item = MenuItem::with_id(app, "quit", "Close Window", true, None::<&str>)?;
            let quit_all_item = MenuItem::with_id(app, "quit_all", "Quit Application", true, None::<&str>)?;
            let new_window_item = MenuItem::with_id(app, "new_window", "New Window", true, None::<&str>)?;
            let show_home_item = MenuItem::with_id(app, "show_home", "Show Home", true, None::<&str>)?;
            let new_terminal_item = MenuItem::with_id(app, "new_terminal", "New Terminal", true, None::<&str>)?;
            let new_private_terminal_item = MenuItem::with_id(app, "new_private_terminal", "New Private Terminal", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let import_connections_item = MenuItem::with_id(app, "import_connections", "Import Connections", true, None::<&str>)?;
            let export_connections_item = MenuItem::with_id(app, "export_connections", "Export Connections", true, None::<&str>)?;
            let close_all_sessions_item = MenuItem::with_id(app, "close_all_sessions", "Close All Sessions", true, None::<&str>)?;
            let lan_discover_item = CheckMenuItem::with_id(app, "lan_discover", "LAN Discovery", true, false, None::<&str>)?;
            let check_updates_item = MenuItem::with_id(app, "check_updates", "Check for Updates", true, None::<&str>)?;

            use tauri::menu::PredefinedMenuItem;
            let separator = PredefinedMenuItem::separator(app)?;
            let separator2 = PredefinedMenuItem::separator(app)?;
            let separator3 = PredefinedMenuItem::separator(app)?;
            let separator4 = PredefinedMenuItem::separator(app)?;

            let menu = Menu::with_items(
                app,
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
            )?;

			let _tray = TrayIconBuilder::with_id("main-tray")
				.icon(app.default_window_icon().unwrap().clone())
				.menu(&menu)
				.show_menu_on_left_click(false)
				.on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

			app.on_menu_event(|app, event| {
				startup_log(&format!("on_menu_event: id={}", event.id().as_ref()));
				handle_menu_event(app, event.id().as_ref());
			});

            // Initialize app menu with default language (English)
            commands::set_app_menu_language(app.handle(), "en")
                .map_err(|e| format!("Failed to set app menu: {}", e))?;

            startup_log("Setup: complete");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_meterm_connection_info,
            commands::get_meterm_port,
            commands::is_meterm_running,
            commands::get_pairing_info,
            commands::create_session,
            commands::create_ssh_session,
            commands::test_ssh_connection,
            commands::list_sessions,
            commands::delete_session,
            commands::set_tray_language,
            commands::set_has_open_tabs,
            commands::request_app_quit,
            commands::restart_meterm,
            commands::hide_main_window,
            commands::allow_window_close,
            commands::mark_window_initialized,
            commands::get_all_window_geometries,
            commands::create_window_at_position,
            commands::get_window_position,
            commands::toggle_lan_sharing,
            commands::store_credential,
            commands::get_credential,
            commands::delete_credential,
            commands::list_clients,
            commands::kick_client,
            commands::list_devices,
            commands::kick_device,
            commands::set_session_private,
            commands::list_banned_ips,
            commands::ban_ip,
            commands::unban_ip,
            commands::refresh_token,
            commands::set_custom_token,
            commands::revoke_all_clients,
            commands::set_discoverable_state,
            commands::get_main_window_count,
            commands::copy_background_image,
            commands::delete_background_image,
            commands::fetch_ai_models,
            commands::set_update_badge,
        ])
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|app_handle, event| {
            match event {
                RunEvent::WindowEvent { label, event, .. } => {
                    // Log all window events for diagnostics
                    let event_name = match &event {
                        tauri::WindowEvent::CloseRequested { .. } => "CloseRequested",
                        tauri::WindowEvent::Destroyed => "Destroyed",
                        tauri::WindowEvent::Focused(true) => "Focused(true)",
                        tauri::WindowEvent::Focused(false) => "Focused(false)",
                        tauri::WindowEvent::Moved(_) => "Moved",
                        tauri::WindowEvent::Resized(_) => "Resized",
                        tauri::WindowEvent::ScaleFactorChanged { .. } => "ScaleFactorChanged",
                        tauri::WindowEvent::ThemeChanged(_) => "ThemeChanged",
                        _ => "Other",
                    };
                    // Skip noisy move/resize events, log everything else
                    if !matches!(event_name, "Moved" | "Resized" | "Other") {
                        let all_wins: Vec<String> = app_handle.webview_windows().keys().cloned().collect();
                        startup_log(&format!("WindowEvent: label={}, event={}, all_windows={:?}", label, event_name, all_wins));
                    }

                    if let tauri::WindowEvent::Destroyed = event {
                        // Clean up initialized window tracking
                        let lifecycle = app_handle.state::<AppLifecycleState>();
                        lifecycle.remove_initialized_window(&label);

                        // When a utility window is destroyed, skip the main-window check
                        let is_utility = label == "settings" || label == "tray-dialog" || label == "updater";
                        if !is_utility {
                            let has_main_windows = app_handle.webview_windows().keys()
                                .any(|k| k.as_str() != "settings" && k.as_str() != "tray-dialog" && k.as_str() != "updater");

                            if !has_main_windows {
                                // Last main window closed — close all utility windows
                                for util_label in &["settings", "updater"] {
                                    if let Some(w) = app_handle.get_webview_window(util_label) {
                                        let _ = w.close();
                                    }
                                }
                            }
                        }
                    }
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        let lifecycle = app_handle.state::<AppLifecycleState>();

                        // Always allow utility windows to close
                        if label == "settings" || label == "tray-dialog" || label == "updater" {
                            debug_log!("[DEBUG] Window {} close allowed (utility)", label);
                            return;
                        }

                        // Allow close if quitting the entire app
                        if lifecycle.is_quitting() {
                            debug_log!("[DEBUG] Window {} close allowed (quitting)", label);
                            return;
                        }

                        // Allow close if this window is in the allowed list
                        if lifecycle.is_window_allowed_to_close(&label) {
                            debug_log!("[DEBUG] Window {} close allowed (confirmed)", label);
                            lifecycle.remove_window_from_allowed_list(&label);
                            return;
                        }

                        // Allow close if JS hasn't initialized yet (blank/failed window)
                        if !lifecycle.is_window_initialized(&label) {
                            debug_log!("[DEBUG] Window {} close allowed (not initialized)", label);
                            return;
                        }

                        // Otherwise, prevent close and ask for confirmation
                        api.prevent_close();
                        debug_log!("[DEBUG] Window {} close prevented, emitting close request", label);
                        let payload = WindowEvent { target_window: label.clone() };
                        let _ = app_handle.emit("window-close-requested", payload);
                    }
                }
                RunEvent::ExitRequested { api, .. } => {
                    startup_log("ExitRequested event received");
                    let lifecycle = app_handle.state::<AppLifecycleState>();
                    // When user quits the app (Cmd+Q), we need to handle it properly
                    if lifecycle.is_quitting() {
                        return;
                    }
                    // Count how many windows have open tabs
                    let has_tabs = lifecycle.has_open_tabs();
                    if has_tabs {
                        api.prevent_exit();
                        debug_log!("[DEBUG] Exit prevented, has open tabs");
                        // Send quit request only to one window to avoid multiple dialogs
                        let target_label = get_quit_confirmation_window(app_handle);
                        debug_log!("[DEBUG] Sending quit request to window: {}", target_label);
                        let _ = app_handle.emit("menu-request-quit", WindowEvent { target_window: target_label });
                    } else {
                        // No tabs open, allow exit
                        lifecycle.mark_quitting();
                    }
                }
                #[cfg(target_os = "macos")]
                RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } => {
                    if !has_visible_windows {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
                RunEvent::Exit => {
                    let meterm = app_handle.state::<MeTermProcess>();
                    meterm.stop();
                }
                _ => {}
            }
        });
}
