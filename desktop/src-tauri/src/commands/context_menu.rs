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
    use winreg::enums::HKEY_CURRENT_USER;

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
