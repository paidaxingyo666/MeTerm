const APP_COMMANDS: &[&str] = &[
    "get_meterm_connection_info",
    "get_pairing_info",
    "create_session",
    "list_sessions",
    "delete_session",
    "list_available_shells",
    "inject_osc_marker",
    "create_ssh_session",
    "test_ssh_connection",
    "detect_default_ssh_key",
    "check_ssh_agent",
    "start_session_file_download",
    "control_session_file_download",
    "start_session_file_upload",
    "control_session_file_upload",
    "set_tray_language",
    "set_update_badge",
    "set_has_open_tabs",
    "request_app_quit",
    "allow_window_close",
    "mark_window_initialized",
    "track_window_created_ts",
    "hide_main_window",
    "get_all_window_geometries",
    "create_window_at_position",
    "create_drag_preview_window",
    "get_window_position",
    "dock_child_window",
    "undock_child_window",
    "get_main_window_count",
    "create_transparent_window",
    "set_window_vibrancy",
    "set_traffic_lights_visible",
    "restart_app_via_open",
    "reveal_window",
    "get_lan_access_state",
    "set_lan_access",
    "set_lan_discovery",
    "discover_lan",
    "get_device_name",
    "set_device_name",
    "ping_remote",
    "list_clients",
    "kick_client",
    "list_devices",
    "list_paired_credentials",
    "revoke_paired_credential",
    "kick_device",
    "set_session_private",
    "remote_store_token",
    "remote_has_token",
    "remote_delete_token",
    "remote_list_sessions",
    "remote_connect_session",
    "remote_send_frame",
    "remote_close_session",
    "jumpserver_migrate_credentials",
    "jumpserver_store_credentials",
    "jumpserver_credential_status",
    "jumpserver_delete_credentials",
    "export_ssh_connections",
    "get_relay_config",
    "set_relay_config",
    "sync_get_connections",
    "sync_import_named_connection",
    "sync_upsert_connection",
    "sync_update_connection_password",
    "sync_delete_connection",
    "sync_migrate_known_secrets",
    "sync_development_credential_recovery_available",
    "sync_import_production_credential_for_development",
    "consume_legacy_ui_preferences",
    "list_banned_ips",
    "ban_ip",
    "unban_ip",
    "refresh_token",
    "set_custom_token",
    "revoke_all_clients",
    "set_proxy_mode",
    "ipc_connect_session",
    "ipc_disconnect_session",
    "ipc_session_input",
    "ipc_session_resize",
    "ipc_session_ping",
    "ipc_session_control",
    "forward_jumpserver_browser_event",
    "initialize_settings_secrets",
    "update_settings_secrets",
    "fetch_ai_models",
    "fetch_searxng_search",
    "fetch_ai_stream",
    "stat_path",
    "open_path",
    "open_text_file",
    "list_dir_names",
    "copy_background_image",
    "delete_background_image",
    "take_initial_open_path",
    "agent_read_file",
    "agent_read_file_bytes",
    "agent_write_file",
    "agent_write_file_bytes",
    "agent_copy_local_file",
    "sftp_stat_remote",
    "agent_save_attachment",
    "agent_delete_attachment",
    "agent_list_directory",
    "agent_glob_search",
    "agent_grep_search",
    "read_clipboard_image",
    "register_context_menu",
    "unregister_context_menu",
    "is_context_menu_registered",
    "tldr_init",
    "tldr_query",
    "tldr_status",
    "tldr_list_commands",
];

fn quoted_entries(block: &str) -> std::collections::BTreeSet<String> {
    block
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            line.strip_prefix('"')
                .and_then(|value| value.strip_suffix(","))
                .and_then(|value| value.strip_suffix('"'))
                .map(str::to_owned)
        })
        .collect()
}

fn assert_app_command_acl_is_current() {
    use std::collections::BTreeSet;

    let source = std::fs::read_to_string("src/lib.rs").expect("read src/lib.rs");
    let handler = source
        .split_once(".invoke_handler(tauri::generate_handler![")
        .and_then(|(_, rest)| rest.split_once("])"))
        .map(|(block, _)| block)
        .expect("find Tauri invoke handler command list");
    let registered: BTreeSet<String> = handler
        .lines()
        .filter_map(|line| {
            let line = line.trim().strip_suffix(',')?;
            if line.starts_with("//") {
                return None;
            }
            line.rsplit_once("::")
                .map(|(_, command)| command.to_owned())
        })
        .collect();
    let declared: BTreeSet<String> = APP_COMMANDS
        .iter()
        .map(|command| (*command).to_owned())
        .collect();
    assert_eq!(
        registered, declared,
        "Tauri command ACL drift: keep APP_COMMANDS synchronized with generate_handler"
    );

    let permissions = std::fs::read_to_string("permissions/app-commands.toml")
        .expect("read permissions/app-commands.toml");
    let main_permission = permissions
        .split("[[permission]]")
        .nth(1)
        .expect("find main-window-commands permission");
    let allow_block = main_permission
        .split_once("commands.allow = [")
        .and_then(|(_, rest)| rest.split_once(']'))
        .map(|(block, _)| block)
        .expect("find main-window-commands allow list");
    assert_eq!(
        quoted_entries(allow_block),
        declared,
        "Tauri command ACL drift: keep main-window-commands synchronized with APP_COMMANDS"
    );
}

fn assert_development_mobile_control_is_not_distributable() {
    let mobile_control = std::env::var_os("CARGO_FEATURE_DEVELOPMENT_MOBILE_CONTROL").is_some();
    let credential_recovery =
        std::env::var_os("CARGO_FEATURE_DEVELOPMENT_CREDENTIAL_RECOVERY").is_some();
    let profile = std::env::var("PROFILE").unwrap_or_default();
    assert!(
        (!mobile_control && !credential_recovery) || profile == "debug",
        "development-only control and credential recovery features are restricted to Cargo's debug profile"
    );
    assert!(
        !credential_recovery || mobile_control,
        "development-credential-recovery requires development-mobile-control"
    );
}

fn main() {
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_DEVELOPMENT_MOBILE_CONTROL");
    println!("cargo:rerun-if-env-changed=CARGO_FEATURE_DEVELOPMENT_CREDENTIAL_RECOVERY");
    println!("cargo:rerun-if-env-changed=PROFILE");
    assert_development_mobile_control_is_not_distributable();
    println!("cargo:rerun-if-changed=src/lib.rs");
    println!("cargo:rerun-if-changed=permissions/app-commands.toml");
    assert_app_command_acl_is_current();

    // Force Cargo to recompile when the embedded web frontend changes.
    // rust_embed uses include_bytes!() at compile time (release mode),
    // but Cargo doesn't automatically track those external files.
    // We track individual files in dist/ so any rebuild triggers recompilation.
    let dist = std::path::Path::new("../../frontend/dist");
    if dist.exists() {
        for entry in std::fs::read_dir(dist).into_iter().flatten().flatten() {
            println!("cargo:rerun-if-changed={}", entry.path().display());
        }
        // Also track the assets subdirectory
        let assets = dist.join("assets");
        if assets.exists() {
            for entry in std::fs::read_dir(&assets).into_iter().flatten().flatten() {
                println!("cargo:rerun-if-changed={}", entry.path().display());
            }
        }
    }
    println!("cargo:rerun-if-changed=../../frontend/dist/");

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to run Tauri build script")
}
