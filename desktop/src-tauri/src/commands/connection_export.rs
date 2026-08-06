//! Identity-confirmed SSH connection export.
//!
//! Secret material is loaded and written entirely in Rust. The WebView
//! receives only aggregate counts, never the exported JSON or a credential.

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::server::connections::SavedConnection;
use crate::server::secret_vault::{self, SshSecrets};
use crate::server::ServerState;

const MAX_EXPORT_CONNECTIONS: usize = 1_000;
const MAX_PRIVATE_KEY_BYTES: u64 = 2 * 1024 * 1024;
const MAX_MOBILE_IMPORT_BYTES: usize = 16 * 1024 * 1024;
const MAX_MOBILE_SECRET_BYTES: usize = 64 * 1024;
const MOBILE_PRIVATE_KEY_LABELS: &[&str] = &[
    "PRIVATE KEY",
    "ENCRYPTED PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
    "RSA PRIVATE KEY",
    "EC PRIVATE KEY",
    "DSA PRIVATE KEY",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionExportResult {
    count: usize,
    portable_count: usize,
    missing_credential_count: usize,
    mobile_ready_count: usize,
    mobile_unsupported_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportBundle {
    version: u8,
    connections: Vec<ExportConnection>,
    exported_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportConnection {
    id: String,
    name: String,
    host: String,
    port: u16,
    username: String,
    auth_method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    private_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    passphrase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    skip_shell_hook: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    multiplex_sftp: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_password: Option<String>,
}

impl ExportConnection {
    fn portable(&self) -> bool {
        match self.auth_method.as_str() {
            "password" => self
                .password
                .as_deref()
                .is_some_and(|value| !value.is_empty()),
            "key" => self
                .private_key
                .as_deref()
                .is_some_and(|value| !value.is_empty()),
            _ => false,
        }
    }

    fn mobile_ready(&self) -> bool {
        if !self.portable()
            || self.proxy_type.is_some()
            || self.proxy_host.is_some()
            || self.proxy_port.is_some()
            || self.proxy_username.is_some()
            || self.proxy_password.is_some()
            || !mobile_safe_text(&self.id, 256, false)
            || !mobile_safe_text(&self.name, 256, false)
            || !mobile_safe_text(&self.host, 255, true)
            || !mobile_safe_text(&self.username, 128, false)
            || self.port == 0
        {
            return false;
        }

        match self.auth_method.as_str() {
            "password" => {
                self.password.as_deref().is_some_and(|value| {
                    !value.is_empty() && value.len() <= MAX_MOBILE_SECRET_BYTES
                }) && self.private_key.is_none()
                    && self.passphrase.is_none()
            }
            "key" => {
                self.password.is_none()
                    && self.private_key.as_deref().is_some_and(|value| {
                        !value.is_empty()
                            && value.len() <= MAX_PRIVATE_KEY_BYTES as usize
                            && is_mobile_private_key_pem(value)
                    })
                    && self
                        .passphrase
                        .as_deref()
                        .is_none_or(|value| value.len() <= MAX_MOBILE_SECRET_BYTES)
            }
            _ => false,
        }
    }
}

fn mobile_safe_text(value: &str, max_bytes: usize, reject_whitespace: bool) -> bool {
    !value.trim().is_empty()
        && value == value.trim()
        && value.len() <= max_bytes
        && !value.chars().any(is_mobile_unsafe_display_char)
        && (!reject_whitespace || !value.chars().any(char::is_whitespace))
}

/// Mirrors the mobile importers' rejection of Unicode control and format scalars. Rust has no
/// standard-library general-category predicate, so keep the Unicode 16 `Cf` ranges explicit.
fn is_mobile_unsafe_display_char(value: char) -> bool {
    value.is_control()
        || matches!(
            value,
            '\u{00ad}'
                | '\u{0600}'..='\u{0605}'
                | '\u{061c}'
                | '\u{06dd}'
                | '\u{070f}'
                | '\u{0890}'..='\u{0891}'
                | '\u{08e2}'
                | '\u{180e}'
                | '\u{200b}'..='\u{200f}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{206f}'
                | '\u{feff}'
                | '\u{fff9}'..='\u{fffb}'
                | '\u{110bd}'
                | '\u{110cd}'
                | '\u{13430}'..='\u{1343f}'
                | '\u{1bca0}'..='\u{1bca3}'
                | '\u{1d173}'..='\u{1d17a}'
                | '\u{e0001}'
                | '\u{e0020}'..='\u{e007f}'
        )
}

/// Android and iOS intentionally accept only complete inline PEM containers.
/// Desktop export remains broader (SSH2/PuTTY files are still exported), but
/// those formats must not be reported as ready for the current mobile importer.
fn is_mobile_private_key_pem(value: &str) -> bool {
    let lines: Vec<&str> = value
        .trim()
        .lines()
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| !line.trim().is_empty())
        .collect();
    let Some(first) = lines.first() else {
        return false;
    };
    if lines.len() < 3 {
        return false;
    }
    let Some(label) = first
        .strip_prefix("-----BEGIN ")
        .and_then(|value| value.strip_suffix("-----"))
    else {
        return false;
    };
    MOBILE_PRIVATE_KEY_LABELS.contains(&label)
        && lines.last().is_some_and(|last| {
            last.strip_prefix("-----END ")
                .and_then(|value| value.strip_suffix("-----"))
                == Some(label)
        })
}

fn mobile_ready_count(connections: &[ExportConnection], serialized_bytes: usize) -> usize {
    if serialized_bytes > MAX_MOBILE_IMPORT_BYTES {
        return 0;
    }
    connections
        .iter()
        .filter(|connection| connection.mobile_ready())
        .count()
}

/// Export the requested active registry entries to a private local JSON file.
/// An empty id list means all active entries. Authentication is never reusable:
/// it is immediately consumed by this one fixed write.
#[tauri::command]
pub async fn export_ssh_connections(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<'_, Arc<ServerState>>,
    connection_ids: Vec<String>,
) -> Result<Option<ConnectionExportResult>, String> {
    let label = window.label();
    if label != "main" && label != "settings" && !label.starts_with("window-") {
        return Err("SSH export is unavailable to this window".to_string());
    }
    let selected = select_metadata(&state, connection_ids)?;
    if selected.is_empty() {
        return Err("no SSH connections to export".to_string());
    }
    let Some(output_path) = choose_output_path(&app).await? else {
        return Ok(None);
    };

    let mut consent_snapshots = Vec::with_capacity(selected.len());
    for expected in &selected {
        let id = expected.id.clone();
        let digest = state.connections.read_with(&id, |current| {
            let current = current
                .filter(|connection| connection == expected)
                .ok_or_else(|| "an SSH connection changed before export".to_string())?;
            let secrets = secret_vault::try_load_secrets(&id)?;
            secret_vault::validate_bound_authority(&current, &secrets)?;
            materialize_export_connection(current, secrets).map(|(_, digest)| digest)
        })?;
        consent_snapshots.push((expected.clone(), digest));
    }

    let reason = export_confirmation_reason(selected.len());
    super::user_presence::confirm_for_secret_export(&window, reason).await?;

    let mut connections = Vec::with_capacity(selected.len());
    for (expected, consent_digest) in consent_snapshots {
        let id = expected.id.clone();
        let exported = state.connections.read_with(&id, |current| {
            let current = current
                .filter(|connection| connection == &expected)
                .ok_or_else(|| "an SSH connection changed during export".to_string())?;
            let secrets = secret_vault::try_load_secrets(&id)?;
            secret_vault::validate_bound_authority(&current, &secrets)?;
            let (exported, current_digest) = materialize_export_connection(current, secrets)?;
            if current_digest != consent_digest {
                return Err("an SSH credential changed during export".to_string());
            }
            Ok(exported)
        })?;
        connections.push(exported);
    }

    let portable_count = connections
        .iter()
        .filter(|connection| connection.portable())
        .count();
    let missing_credential_count = connections.len() - portable_count;
    let bundle = ExportBundle {
        version: 1,
        connections,
        exported_at: time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .map_err(|_| "failed to format export timestamp".to_string())?,
    };
    let bytes = serde_json::to_vec_pretty(&bundle)
        .map_err(|_| "failed to serialize SSH connection export".to_string())?;
    let mobile_ready_count = mobile_ready_count(&bundle.connections, bytes.len());
    let mobile_unsupported_count = portable_count - mobile_ready_count;
    crate::server::private_file::atomic_write_private(&output_path, &bytes)?;

    Ok(Some(ConnectionExportResult {
        count: bundle.connections.len(),
        portable_count,
        missing_credential_count,
        mobile_ready_count,
        mobile_unsupported_count,
    }))
}

fn export_confirmation_reason(connection_count: usize) -> String {
    format!("Export {connection_count} SSH connection(s), including saved credentials.")
}

async fn choose_output_path(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name("meterm-connections.json")
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    let selected = receiver
        .await
        .map_err(|_| "export save dialog was interrupted".to_string())?;
    selected
        .map(|path| {
            path.into_path()
                .map_err(|_| "invalid export path".to_string())
                .and_then(validate_output_path)
        })
        .transpose()
}

fn validate_output_path(path: PathBuf) -> Result<PathBuf, String> {
    let display = path.to_string_lossy();
    if display.is_empty() || display.len() > 320 || display.chars().any(char::is_control) {
        return Err("invalid export path".to_string());
    }
    if !path.is_absolute() || path.file_name().is_none() {
        return Err("export path must be an absolute file path".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "invalid export path".to_string())?
        .canonicalize()
        .map_err(|_| "export directory is unavailable".to_string())?;
    Ok(parent.join(path.file_name().expect("validated file name")))
}

fn select_metadata(
    state: &ServerState,
    requested_ids: Vec<String>,
) -> Result<Vec<SavedConnection>, String> {
    if requested_ids.len() > MAX_EXPORT_CONNECTIONS {
        return Err("too many SSH connections requested".to_string());
    }
    let mut selected = if requested_ids.is_empty() {
        state.connections.active()
    } else {
        let mut unique = HashSet::with_capacity(requested_ids.len());
        let mut selected = Vec::with_capacity(requested_ids.len());
        for id in requested_ids {
            if id.is_empty()
                || id.len() > 256
                || id.chars().any(char::is_control)
                || !unique.insert(id.clone())
            {
                return Err("invalid SSH connection selection".to_string());
            }
            let connection = state
                .connections
                .get(&id)
                .filter(|connection| connection.deleted_at.is_none())
                .ok_or_else(|| "SSH connection selection is stale".to_string())?;
            selected.push(connection);
        }
        selected
    };
    if selected.len() > MAX_EXPORT_CONNECTIONS {
        return Err("too many SSH connections requested".to_string());
    }
    selected.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(selected)
}

fn materialize_export_connection(
    connection: SavedConnection,
    secrets: SshSecrets,
) -> Result<(ExportConnection, [u8; 32]), String> {
    let private_key = match (
        secrets.private_key_pem.as_ref(),
        secrets.private_key_path.as_deref(),
    ) {
        (Some(pem), _) if !pem.is_empty() => Some(pem.clone()),
        (None, Some(path)) | (Some(_), Some(path)) if connection.auth_method == "key" => {
            Some(read_bound_private_key(Path::new(&path))?)
        }
        _ => None,
    };
    let digest = credential_snapshot_digest(&secrets, private_key.as_deref())?;
    Ok((
        ExportConnection {
            id: connection.id,
            name: connection.name,
            host: connection.host,
            port: connection.port,
            username: connection.username,
            auth_method: connection.auth_method,
            password: secrets.password.filter(|value| !value.is_empty()),
            private_key,
            passphrase: secrets.passphrase.filter(|value| !value.is_empty()),
            skip_shell_hook: connection.skip_shell_hook,
            multiplex_sftp: connection.multiplex_sftp,
            proxy_type: connection.proxy_type.filter(|value| !value.is_empty()),
            proxy_host: connection.proxy_host.filter(|value| !value.is_empty()),
            proxy_port: connection.proxy_port,
            proxy_username: connection.proxy_username.filter(|value| !value.is_empty()),
            proxy_password: secrets.proxy_password.filter(|value| !value.is_empty()),
        },
        digest,
    ))
}

fn credential_snapshot_digest(
    secrets: &SshSecrets,
    resolved_private_key: Option<&str>,
) -> Result<[u8; 32], String> {
    use sha2::{Digest, Sha256};

    let mut digest = Sha256::new();
    digest.update(
        serde_json::to_vec(secrets).map_err(|_| "failed to snapshot SSH credential".to_string())?,
    );
    if let Some(private_key) = resolved_private_key {
        digest.update(private_key.as_bytes());
    }
    Ok(digest.finalize().into())
}

fn read_bound_private_key(path: &Path) -> Result<String, String> {
    use std::io::Read;

    // Open once and inspect/read through the same handle. A separate
    // metadata(path) + read_to_string(path) sequence lets a concurrently
    // replaced path bypass the size/type decision made for the first file.
    let mut file = std::fs::File::open(path)
        .map_err(|_| "a configured private-key file is unavailable".to_string())?;
    let metadata = file
        .metadata()
        .map_err(|_| "a configured private-key file is unavailable".to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_PRIVATE_KEY_BYTES {
        return Err("configured private-key file is invalid or too large".to_string());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.by_ref()
        .take(MAX_PRIVATE_KEY_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "configured private-key file is unavailable".to_string())?;
    if bytes.len() > MAX_PRIVATE_KEY_BYTES as usize {
        return Err("configured private-key file is invalid or too large".to_string());
    }
    let key = String::from_utf8(bytes)
        .map_err(|_| "configured private-key file is not valid UTF-8".to_string())?;
    let trimmed = key.trim_start();
    if !(trimmed.starts_with("-----BEGIN ")
        || trimmed.starts_with("---- BEGIN SSH2 ")
        || trimmed.starts_with("PuTTY-User-Key-File-"))
    {
        return Err("configured file is not a recognized private key".to_string());
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn password_export() -> ExportConnection {
        ExportConnection {
            id: "connection-id".into(),
            name: "server".into(),
            host: "example.com".into(),
            port: 22,
            username: "root".into(),
            auth_method: "password".into(),
            password: Some("secret".into()),
            private_key: None,
            passphrase: None,
            skip_shell_hook: None,
            multiplex_sftp: None,
            proxy_type: None,
            proxy_host: None,
            proxy_port: None,
            proxy_username: None,
            proxy_password: None,
        }
    }

    #[test]
    fn output_path_must_be_absolute() {
        assert!(validate_output_path(PathBuf::from("relative.json")).is_err());
    }

    #[test]
    fn export_prompt_contains_only_fixed_semantics_and_count() {
        assert_eq!(
            export_confirmation_reason(3),
            "Export 3 SSH connection(s), including saved credentials."
        );
    }

    #[test]
    fn password_export_is_portable_only_with_a_password() {
        let connection = ExportConnection {
            password: None,
            ..password_export()
        };
        assert!(!connection.portable());
        assert!(ExportConnection {
            password: Some("secret".into()),
            ..connection
        }
        .portable());
    }

    #[test]
    fn mobile_ready_matches_mobile_secret_proxy_and_key_format_rules() {
        assert!(password_export().mobile_ready());
        assert!(!ExportConnection {
            proxy_host: Some("proxy.example.com".into()),
            ..password_export()
        }
        .mobile_ready());
        assert!(!ExportConnection {
            password: Some("x".repeat(MAX_MOBILE_SECRET_BYTES + 1)),
            ..password_export()
        }
        .mobile_ready());
        assert!(!ExportConnection {
            name: "hidden\u{200b}format".into(),
            ..password_export()
        }
        .mobile_ready());

        // Assemble the deliberately invalid test PEM at runtime so the source
        // tree never contains text that secret scanners must special-case.
        let pem = format!(
            "-----BEGIN OPENSSH {}-----\nYWJj\n-----END OPENSSH {}-----",
            "PRIVATE KEY", "PRIVATE KEY"
        );
        assert!(ExportConnection {
            auth_method: "key".into(),
            password: None,
            private_key: Some(pem),
            ..password_export()
        }
        .mobile_ready());
        assert!(!ExportConnection {
            auth_method: "key".into(),
            password: None,
            private_key: Some("PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none".into()),
            ..password_export()
        }
        .mobile_ready());
        assert!(!ExportConnection {
            auth_method: "key".into(),
            password: None,
            private_key: Some("---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\nYWJj".into()),
            ..password_export()
        }
        .mobile_ready());
    }

    #[test]
    fn oversized_bundle_marks_every_portable_connection_mobile_unsupported() {
        let connections = vec![password_export()];
        assert_eq!(mobile_ready_count(&connections, MAX_MOBILE_IMPORT_BYTES), 1);
        assert_eq!(
            mobile_ready_count(&connections, MAX_MOBILE_IMPORT_BYTES + 1),
            0
        );
    }

    #[test]
    fn private_key_file_reader_is_bounded() {
        let directory =
            std::env::temp_dir().join(format!("meterm-key-export-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("id_test");
        let key = format!(
            "-----BEGIN OPENSSH {}-----\nYWJj\n-----END OPENSSH {}-----\n",
            "PRIVATE KEY", "PRIVATE KEY"
        );
        std::fs::write(&path, &key).unwrap();
        assert_eq!(read_bound_private_key(&path).unwrap(), key);

        let oversized = std::fs::File::create(&path).unwrap();
        oversized.set_len(MAX_PRIVATE_KEY_BYTES + 1).unwrap();
        drop(oversized);
        assert!(read_bound_private_key(&path)
            .unwrap_err()
            .contains("too large"));

        let _ = std::fs::remove_dir_all(directory);
    }
}
