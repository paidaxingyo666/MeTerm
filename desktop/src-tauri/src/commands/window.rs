use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct WindowGeometry {
    pub label: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
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
        .transparent(true)
        .visible(false)
        .background_color(tauri::window::Color(45, 45, 45, 255));

    #[cfg(target_os = "macos")]
    {
        use tauri::LogicalPosition;
        builder = builder
            .hidden_title(true)
            .accept_first_mouse(true)
            .title_bar_style(TitleBarStyle::Overlay)
            .traffic_light_position(LogicalPosition::new(14.0, 18.0));
    }

    #[cfg(target_os = "windows")]
    {
        builder = builder.decorations(false).transparent(false);
    }
    let win = builder.build().map_err(|e| e.to_string())?;

    // macOS: alpha=0 + orderBack: adds window to compositor behind all others,
    // so WKWebView renders in background without any visible flash.
    // reveal_window later sets alpha=1 + makeKeyAndOrderFront:.
    #[cfg(target_os = "macos")]
    {
        use objc2::msg_send;
        use objc2_app_kit::NSWindow;
        let ns_ptr = win.ns_window().map_err(|e| e.to_string())? as *const NSWindow;
        unsafe {
            let _: () = msg_send![ns_ptr, setAlphaValue: 0.0_f64];
            let nil: *const objc2::runtime::AnyObject = std::ptr::null();
            let _: () = msg_send![ns_ptr, orderBack: nil];
        }
    }

    let lifecycle = app.state::<crate::AppLifecycleState>();
    lifecycle.track_window_created(&window_label);

    Ok(window_label)
}

#[tauri::command]
pub fn get_window_position(window: tauri::Window) -> Result<(f64, f64), String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    Ok((pos.x as f64 / scale, pos.y as f64 / scale))
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

/// Create a transparent sub-window from the Rust side.
/// This ensures `.transparent(true)` is applied via `WebviewWindowBuilder` — same as
/// the main window defined in tauri.conf.json.  TypeScript's `new WebviewWindow()`
/// may not propagate the transparent flag correctly on macOS.
#[tauri::command]
pub fn create_transparent_window(
    app: AppHandle,
    label: String,
    url: String,
    title: String,
    width: f64,
    height: f64,
    resizable: bool,
) -> Result<(), String> {
    use tauri::WebviewUrl;

    if app.get_webview_window(&label).is_some() {
        // Already exists — just show & focus
        let w = app.get_webview_window(&label).unwrap();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }

    let webview_url = if url.starts_with("http") {
        WebviewUrl::External(url.parse::<tauri::Url>().map_err(|e| e.to_string())?)
    } else {
        WebviewUrl::App(url.into())
    };

    #[allow(unused_mut)]
    let mut builder = tauri::WebviewWindowBuilder::new(&app, &label, webview_url)
        .title(&title)
        .inner_size(width, height)
        .resizable(resizable)
        .center()
        .visible(false)
        .transparent(true)
        .background_color(tauri::window::Color(45, 45, 45, 255));

    #[cfg(target_os = "macos")]
    {
        use tauri::{TitleBarStyle, LogicalPosition};
        builder = builder
            .decorations(true)
            .hidden_title(true)
            .title_bar_style(TitleBarStyle::Overlay)
            .traffic_light_position(LogicalPosition::new(14.0, 18.0));
    }

    #[cfg(target_os = "windows")]
    {
        builder = builder.decorations(false);
    }

    let win = builder.build().map_err(|e| e.to_string())?;

    // macOS: set alpha=0, then show() to add window to compositor invisibly.
    // This avoids the orderFront: recomposite flash — the window is in the
    // macOS: alpha=0 + orderBack: adds to compositor behind all windows
    #[cfg(target_os = "macos")]
    {
        use objc2::msg_send;
        use objc2_app_kit::NSWindow;
        let ns_ptr = win.ns_window().map_err(|e| e.to_string())? as *const NSWindow;
        unsafe {
            let _: () = msg_send![ns_ptr, setAlphaValue: 0.0_f64];
            let nil: *const objc2::runtime::AnyObject = std::ptr::null();
            let _: () = msg_send![ns_ptr, orderBack: nil];
        }
    }

    let lifecycle = app.state::<crate::AppLifecycleState>();
    lifecycle.track_window_created(&label);

    Ok(())
}

/// Apply or clear window vibrancy (blur) effect.
/// macOS: Sidebar effect, Windows: Mica + Acrylic fallback.
/// `fallback_r/g/b` (0.0–1.0): solid background color shown when vibrancy
/// briefly disengages (Stage Manager transitions, etc.). Pass the theme's
/// primary background color.
#[tauri::command]
pub fn set_window_vibrancy(
    app: AppHandle,
    label: String,
    enabled: bool,
    fallback_r: Option<f64>,
    fallback_g: Option<f64>,
    fallback_b: Option<f64>,
) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("window '{}' not found", label))?;

    if enabled {
        use tauri::window::{Effect, EffectState, EffectsBuilder};

        let config = EffectsBuilder::new()
            .effects({
                #[cfg(target_os = "macos")]
                { vec![Effect::Sidebar] }
                #[cfg(target_os = "windows")]
                { vec![Effect::Mica, Effect::Acrylic] }
                #[cfg(not(any(target_os = "macos", target_os = "windows")))]
                { vec![] }
            })
            .state(EffectState::Active)
            .build();
        window.set_effects(config).map_err(|e| e.to_string())?;

        // Set solid fallback background color for vibrancy flash prevention
        #[cfg(target_os = "macos")]
        if let (Some(r), Some(g), Some(b)) = (fallback_r, fallback_g, fallback_b) {
            let _ = crate::vibrancy::set_vibrancy_fallback_color(&window, r, g, b);
        }
    } else {
        window
            .set_effects(None::<tauri::utils::config::WindowEffectsConfig>)
            .map_err(|e| e.to_string())?;

        // Reset to transparent background when vibrancy is off
        #[cfg(target_os = "macos")]
        {
            use objc2_app_kit::NSWindow;
            let ns_window_raw = window.ns_window().map_err(|e| e.to_string())?;
            let ns_window = unsafe { &*(ns_window_raw as *const NSWindow) };
            ns_window.setBackgroundColor(None);
        }
    }
    Ok(())
}

/// Hide or show macOS traffic light buttons (close/minimize/zoom).
#[tauri::command]
pub fn set_traffic_lights_visible(window: tauri::Window, visible: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSWindow, NSWindowButton};
        let ns_window_raw = window.ns_window().map_err(|e| e.to_string())?;
        let ns_window = unsafe { &*(ns_window_raw as *const NSWindow) };

        let buttons = [
            NSWindowButton::NSWindowCloseButton,
            NSWindowButton::NSWindowMiniaturizeButton,
            NSWindowButton::NSWindowZoomButton,
        ];
        for button_type in &buttons {
            if let Some(btn) = ns_window.standardWindowButton(*button_type) {
                btn.setHidden(!visible);
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    { let _ = (window, visible); }

    Ok(())
}

#[tauri::command]
pub fn get_main_window_count(app: AppHandle) -> u32 {
    const UTILITY_LABELS: &[&str] = &["settings", "jumpserver-browser", "about", "updater", "tray-dialog"];
    app.webview_windows()
        .keys()
        .filter(|k| !UTILITY_LABELS.contains(&k.as_str()))
        .count() as u32
}

#[tauri::command]
pub fn hide_main_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
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

/// Reveal a window that was created with alphaValue=0 (anti-flash).
/// Called by JS after the first frame is fully painted.
#[tauri::command]
pub fn reveal_window(app: AppHandle, label: String) -> Result<(), String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("window '{}' not found", label))?;

    #[cfg(target_os = "macos")]
    {
        use objc2::msg_send;
        use objc2_app_kit::NSWindow;
        let ns_ptr = window.ns_window().map_err(|e| e.to_string())? as *const NSWindow;
        unsafe {
            let _: () = msg_send![ns_ptr, setAlphaValue: 1.0_f64];
            let nil: *const objc2::runtime::AnyObject = std::ptr::null();
            let _: () = msg_send![ns_ptr, makeKeyAndOrderFront: nil];
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(())
}
