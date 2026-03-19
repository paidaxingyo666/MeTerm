mod commands;
#[allow(dead_code, unused_imports)]
mod server;
mod sidecar;
mod tldr;
mod vibrancy;

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
use std::sync::Arc;

use std::collections::{HashSet, HashMap};
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
    /// Tracks when each window was created for grace period protection
    window_created_at: Mutex<HashMap<String, Instant>>,
    current_language: Mutex<String>,
    discoverable: Mutex<bool>,
    pending_update: Mutex<Option<String>>,
    /// Path from CLI args — consumed once by frontend on first load.
    initial_open_path: Mutex<Option<String>>,
}

impl AppLifecycleState {
    fn new_with_path(path: Option<String>) -> Self {
        Self {
            initial_open_path: Mutex::new(path),
            has_open_tabs: Mutex::new(false),
            is_quitting: AtomicBool::new(false),
            last_menu_event: Mutex::new(None),
            windows_allowed_to_close: Mutex::new(HashSet::new()),
            initialized_windows: Mutex::new(HashSet::new()),
            window_created_at: Mutex::new(HashMap::new()),
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

    /// Returns true if any main (non-utility) window has been initialized.
    fn has_any_initialized_main_window(&self) -> bool {
        const UTILITY_WINDOWS: &[&str] = &["settings", "tray-dialog", "updater", "about"];
        self.initialized_windows
            .lock()
            .map(|guard| guard.iter().any(|l| !UTILITY_WINDOWS.contains(&l.as_str())))
            .unwrap_or(false)
    }

    fn remove_initialized_window(&self, label: &str) {
        if let Ok(mut guard) = self.initialized_windows.lock() {
            guard.remove(label);
        }
        if let Ok(mut guard) = self.window_created_at.lock() {
            guard.remove(label);
        }
    }

    /// Record when a window was created (for grace period protection).
    pub fn track_window_created(&self, label: &str) {
        if let Ok(mut guard) = self.window_created_at.lock() {
            guard.insert(label.to_string(), Instant::now());
        }
    }

    /// Check if a window was created less than `grace` duration ago.
    fn is_within_grace_period(&self, label: &str, grace: Duration) -> bool {
        self.window_created_at
            .lock()
            .map(|guard| {
                guard.get(label).is_some_and(|t| t.elapsed() < grace)
            })
            .unwrap_or(false)
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
		"pip_toggle" => Some("pip_toggle"),
		_ => None,
	}
}

fn get_target_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
	// Utility windows (settings, updater, tray-dialog) are never menu targets —
	// menu actions must be dispatched to a main window so they are actually handled.
	let is_main = |label: &str| {
		label != "settings" && label != "updater" && label != "about" && label != "tray-dialog"
	};

	// Try to get the currently focused main window first
	for window in app.webview_windows().values() {
		if !is_main(window.label()) { continue; }
		if let Ok(is_focused) = window.is_focused() {
			if is_focused {
				debug_log!("[DEBUG] Using focused window: {}", window.label());
				return Some(window.clone());
			}
		}
	}

	// Fall back to any visible main window
	for window in app.webview_windows().values() {
		if !is_main(window.label()) { continue; }
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

/// For edit operations (undo/redo/cut/copy/paste/select_all), use the
/// actually focused window — including utility windows like "settings".
fn get_focused_window(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
	for window in app.webview_windows().values() {
		if let Ok(true) = window.is_focused() {
			return Some(window.clone());
		}
	}
	None
}

fn dispatch_menu_action(app: &tauri::AppHandle, action: &str) {
	// Edit operations should target the actually focused window so they
	// work correctly in utility windows (settings, etc.).
	let is_edit_action = matches!(action, "undo" | "redo" | "cut" | "copy" | "paste" | "select_all");
	let target = if is_edit_action {
		get_focused_window(app).or_else(|| get_target_window(app))
	} else {
		get_target_window(app)
	};
	let Some(window) = target else {
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
							let lifecycle = app.state::<AppLifecycleState>();
							lifecycle.track_window_created(&new_window_label);
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
			let payload = WindowEvent { target_window: "main".to_string() };
			match app.emit("menu-open-settings", payload) {
				Ok(_) => debug_log!("[DEBUG] Successfully emitted menu-open-settings to main"),
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
			let _ = app.emit("menu-show-about", WindowEvent { target_window: "main".to_string() });
		}
		"show_shortcuts" => {
			let _ = app.emit("menu-show-shortcuts", WindowEvent { target_window: "main".to_string() });
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
			let _ = app.emit("menu-check-updates", WindowEvent { target_window: "main".to_string() });
		}
		"pip_toggle" => {
			let payload = WindowEvent { target_window: window_label.clone() };
			let _ = app.emit("menu-pip-toggle", payload);
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

	// Block window-creating actions until at least one main window has fully initialized.
	// During startup, Tauri/Windows may fire spurious menu events that should not
	// create new windows.
	if (action == "new_window" || action == "new_terminal" || action == "new_private_terminal")
		&& !lifecycle.has_any_initialized_main_window()
	{
		debug_log!("[DEBUG] Blocked {} during startup (no initialized main window)", action);
		return;
	}

	if !lifecycle.should_dispatch_menu_event(action) {
		debug_log!("[DEBUG] Blocked duplicate event for: {}", action);
		return;
	}
	debug_log!("[DEBUG] Dispatching action: {}", action);
	dispatch_menu_action(app, action);
}

/// Extract the first directory path from CLI args (skip the binary path at index 0).
fn extract_open_path(args: &[String]) -> Option<String> {
    for arg in args.iter().skip(1) {
        // Skip flags
        if arg.starts_with('-') {
            continue;
        }
        let path = std::path::Path::new(arg);
        if path.is_dir() {
            return Some(arg.clone());
        }
        // Also accept files — open terminal at parent directory
        if path.exists() {
            if let Some(parent) = path.parent() {
                return Some(parent.to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = *APP_START; // initialize timer
    startup_log_reset();
    startup_log("=== App starting ===");

    // Parse CLI args for "open in terminal" path
    let cli_args: Vec<String> = std::env::args().collect();
    let initial_path = extract_open_path(&cli_args);
    startup_log(&format!("CLI args: {:?}, initial_path: {:?}", cli_args, initial_path));

    // Rust in-process backend is now the default. Go sidecar only if METERM_GO_SIDECAR=1.
    let use_go_sidecar = std::env::var("METERM_GO_SIDECAR").unwrap_or_default() == "1";
    startup_log(&format!("Backend mode: {}", if use_go_sidecar { "Go (sidecar)" } else { "Rust (in-process)" }));

    let meterm = MeTermProcess::new();
    let lifecycle = AppLifecycleState::new_with_path(initial_path);

    // Server state is created in setup() where Tauri's async runtime is available.

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            startup_log(&format!("Single-instance callback: args={:?}", args));
            // Another instance was launched — focus the existing main window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();

                // If the second instance was launched with a path argument, emit open-path event
                if let Some(path) = extract_open_path(&args) {
                    startup_log(&format!("Single-instance: emitting open-path: {}", path));
                    let _ = app.emit("open-path", path);
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init()) // kept for optional Go sidecar fallback
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(meterm)
        .manage(lifecycle)
        .manage(tldr::TldrState::new())
        .setup(|app| {
            startup_log("Setup: begin");

            // Override macOS notification application ID so the notification icon
            // matches our app instead of Terminal.app (the plugin default in dev mode)
            #[cfg(target_os = "macos")]
            {
                let _ = notify_rust::set_application("com.meterm.dev");
            }
            // Log all windows that exist at this point and track their creation time
            let win_labels: Vec<String> = app.webview_windows().keys().cloned().collect();
            startup_log(&format!("Setup: existing windows = {:?}", win_labels));
            {
                let lifecycle = app.state::<AppLifecycleState>();
                for lbl in &win_labels {
                    lifecycle.track_window_created(lbl);
                }
            }

            let use_go_sidecar = std::env::var("METERM_GO_SIDECAR").unwrap_or_default() == "1";

            // Start the in-process Rust server
            let server_state: Arc<server::ServerState> = {
                let config = server::ServerConfig::default();
                match tauri::async_runtime::block_on(server::start(config)) {
                    Ok(state) => {
                        startup_log(&format!("Setup: Rust server on port {}", state.port()));
                        eprintln!("[meterm] Rust server on 127.0.0.1:{}", state.port());
                        state
                    }
                    Err(e) => {
                        startup_log(&format!("FATAL: Rust server failed: {}", e));
                        eprintln!("[meterm] FATAL: Rust server failed: {}", e);
                        Arc::new(server::create_dummy_state())
                    }
                }
            };
            let server_state_for_inject = server_state.clone();
            app.manage(server_state);

            if use_go_sidecar {
                // Legacy Go sidecar mode (for testing/comparison only).
                let meterm = app.state::<MeTermProcess>();
                let port = match meterm.start(app.handle()) {
                    Ok(p) => p,
                    Err(e) => {
                        startup_log(&format!("FATAL: Go sidecar failed: {}", e));
                        eprintln!("FATAL: Go sidecar failed: {}", e);
                        use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                        app.dialog()
                            .message(&e)
                            .title("MeTerm")
                            .kind(MessageDialogKind::Error)
                            .blocking_show();
                        std::process::exit(1);
                    }
                };
                startup_log(&format!("Setup: Go sidecar on port {}", port));
                eprintln!("meterm sidecar started on 127.0.0.1:{}", port);
            } else {
                // Default: Rust backend — inject port/token into MeTermProcess
                let meterm = app.state::<MeTermProcess>();
                meterm.inject_rust_backend(
                    server_state_for_inject.port(),
                    server_state_for_inject.token().unwrap_or_default(),
                );
                startup_log("Setup: using Rust backend");
            }

            let quit_item = MenuItem::with_id(app, "quit", "Close Window", true, None::<&str>)?;
            let quit_all_item = MenuItem::with_id(app, "quit_all", "Quit Application", true, None::<&str>)?;
            let new_window_item = MenuItem::with_id(app, "new_window", "New Window", true, None::<&str>)?;
            let show_home_item = MenuItem::with_id(app, "show_home", "Show Home", true, None::<&str>)?;
            let new_terminal_item = MenuItem::with_id(app, "new_terminal", "New Terminal", true, None::<&str>)?;
            let new_private_terminal_item = MenuItem::with_id(app, "new_private_terminal", "New Private Terminal", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let pip_toggle_item = MenuItem::with_id(app, "pip_toggle", "Picture-in-Picture", true, None::<&str>)?;
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

            // Register minimize-restore anti-flash for vibrancy
            #[cfg(target_os = "macos")]
            {
                if let Some(main_win) = app.get_webview_window("main") {
                    match vibrancy::register_vibrancy_anti_flash(&main_win) {
                        Ok(guard) => {
                            std::mem::forget(guard);
                            startup_log("Setup: vibrancy anti-flash registered");
                        }
                        Err(e) => {
                            startup_log(&format!("Setup: vibrancy anti-flash failed: {}", e));
                        }
                    }
                }
            }

            startup_log("Setup: complete");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // session
            commands::session::get_meterm_connection_info,
            commands::session::get_meterm_port,
            commands::session::is_meterm_running,
            commands::session::get_pairing_info,
            commands::session::create_session,
            commands::session::list_sessions,
            commands::session::delete_session,
            commands::session::list_available_shells,
            // ssh
            commands::ssh::create_ssh_session,
            commands::ssh::test_ssh_connection,
            // menu
            commands::menu::set_tray_language,
            commands::menu::set_update_badge,
            // lifecycle
            commands::lifecycle::set_has_open_tabs,
            commands::lifecycle::request_app_quit,
            commands::lifecycle::restart_meterm,
            commands::lifecycle::allow_window_close,
            commands::lifecycle::mark_window_initialized,
            commands::lifecycle::track_window_created_ts,
            // window
            commands::window::hide_main_window,
            commands::window::get_all_window_geometries,
            commands::window::create_window_at_position,
            commands::window::get_window_position,
            commands::window::dock_child_window,
            commands::window::undock_child_window,
            commands::window::get_main_window_count,
            commands::window::create_transparent_window,
            commands::window::set_window_vibrancy,
            commands::window::set_traffic_lights_visible,
            commands::window::restart_app_via_open,
            // lan
            commands::lan::toggle_lan_sharing,
            commands::lan::set_discoverable_state,
            commands::lan::list_clients,
            commands::lan::kick_client,
            commands::lan::list_devices,
            commands::lan::kick_device,
            commands::lan::set_session_private,
            // security
            commands::security::store_credential,
            commands::security::get_credential,
            commands::security::delete_credential,
            commands::security::list_banned_ips,
            commands::security::ban_ip,
            commands::security::unban_ip,
            commands::security::refresh_token,
            commands::security::set_custom_token,
            commands::security::revoke_all_clients,
            // ai
            commands::ai::fetch_ai_models,
            commands::ai::fetch_ai_stream,
            // fs
            commands::fs::stat_path,
            commands::fs::open_path,
            commands::fs::list_dir_names,
            commands::fs::copy_background_image,
            commands::fs::delete_background_image,
            commands::fs::take_initial_open_path,
            // context_menu
            commands::context_menu::register_context_menu,
            commands::context_menu::unregister_context_menu,
            commands::context_menu::is_context_menu_registered,
            // tldr
            tldr::tldr_init,
            tldr::tldr_query,
            tldr::tldr_status,
            tldr::tldr_list_commands,
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
                        let is_utility = label == "settings" || label == "tray-dialog" || label == "updater" || label == "about";
                        if !is_utility {
                            const UTIL_LABELS: &[&str] = &["settings", "tray-dialog", "updater", "about"];
                            let lifecycle = app_handle.state::<AppLifecycleState>();
                            let has_main_windows = app_handle.webview_windows().keys()
                                .any(|k| {
                                    let s = k.as_str();
                                    // Skip utility windows
                                    if UTIL_LABELS.contains(&s) { return false; }
                                    // Count windows that are initialized OR still within grace period
                                    lifecycle.is_window_initialized(s) ||
                                        lifecycle.is_within_grace_period(s, Duration::from_secs(3))
                                });

                            if !has_main_windows {
                                // Last main window closed — close all utility windows
                                for util_label in &["settings", "updater", "about"] {
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
                        if label == "settings" || label == "tray-dialog" || label == "updater" || label == "about" {
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

                        // Allow close if JS hasn't initialized yet (blank/failed window),
                        // BUT protect windows within a 3-second grace period after creation
                        // to prevent race conditions where WebView2 hasn't finished loading yet.
                        if !lifecycle.is_window_initialized(&label) {
                            if lifecycle.is_within_grace_period(&label, Duration::from_secs(3)) {
                                api.prevent_close();
                                debug_log!("[DEBUG] Window {} close prevented (within grace period)", label);
                                return;
                            }
                            debug_log!("[DEBUG] Window {} close allowed (not initialized, past grace period)", label);
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
                    // Stop Go sidecar (if running)
                    let meterm = app_handle.state::<MeTermProcess>();
                    meterm.stop();
                    // Stop Rust server session manager
                    let server = app_handle.state::<Arc<server::ServerState>>();
                    server.session_manager.stop();
                }
                _ => {}
            }
        });
}
