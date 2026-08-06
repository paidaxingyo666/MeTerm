//! Native owner-presence verification for fixed credential operations.
//!
//! This module deliberately has no Tauri command of its own. Callers must
//! describe and immediately perform one fixed privileged operation after a
//! successful check; a reusable "authenticated" boolean would become a
//! confused-deputy capability for a compromised WebView.

use std::sync::OnceLock;

static AUTH_PROMPT_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
const MAX_PROMPT_FIELD_BYTES: usize = 240;
const TRUNCATED_FIELD_SUFFIX_BYTES: usize = 20;

/// Render caller-controlled metadata as a bounded, left-to-right ASCII field.
///
/// Native authentication dialogs are a security boundary. Unicode control,
/// format, bidi, line/paragraph-separator, and other non-ASCII characters are
/// escaped instead of being allowed to reorder or hide the trusted operation
/// text around them. Quotes and backslashes are escaped as well, so a field
/// cannot break out of the brackets supplied by the caller.
pub(crate) fn safe_prompt_field(value: &str) -> String {
    let mut output = String::new();
    let mut truncated = false;
    let body_limit = MAX_PROMPT_FIELD_BYTES - TRUNCATED_FIELD_SUFFIX_BYTES;

    for character in value.chars() {
        let rendered = if character.is_ascii_alphanumeric()
            || matches!(character, ' ' | '.' | '-' | '_' | ':' | '/' | '@' | '#')
        {
            character.to_string()
        } else {
            format!("\\u{{{:X}}}", character as u32)
        };
        if output.len() + rendered.len() > body_limit {
            truncated = true;
            break;
        }
        output.push_str(&rendered);
    }

    if output.is_empty() {
        output.push_str("<empty>");
    } else if truncated {
        use sha2::{Digest, Sha256};

        let digest = Sha256::digest(value.as_bytes());
        output.push_str("...#");
        for byte in &digest[..8] {
            output.push_str(&format!("{byte:02x}"));
        }
    }
    output
}

pub async fn confirm_for_secret_export(
    window: &tauri::WebviewWindow,
    reason: String,
) -> Result<(), String> {
    confirm(window, reason, "com.meterm.app.export-connections").await
}

pub async fn confirm_for_credential_binding(
    window: &tauri::WebviewWindow,
    reason: String,
) -> Result<(), String> {
    confirm(window, reason, "com.meterm.app.credential-binding").await
}

pub(crate) fn validate_reason(reason: &str) -> Result<(), String> {
    if reason.is_empty()
        || reason.len() > 4_096
        || !reason
            .chars()
            .all(|character| character == ' ' || character.is_ascii_graphic())
    {
        Err("invalid authentication reason".to_string())
    } else {
        Ok(())
    }
}

async fn confirm(
    window: &tauri::WebviewWindow,
    reason: String,
    action_id: &'static str,
) -> Result<(), String> {
    validate_reason(&reason)?;

    let _guard = AUTH_PROMPT_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;

    #[cfg(target_os = "windows")]
    {
        let _ = action_id;
        platform_confirm(window, &reason).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        tokio::task::spawn_blocking(move || platform_confirm(&reason, action_id))
            .await
            .map_err(|_| "identity confirmation task failed".to_string())?
    }
}

#[cfg(target_os = "macos")]
fn platform_confirm(reason: &str, _action_id: &str) -> Result<(), String> {
    use block2::RcBlock;
    use objc2_foundation::NSString;
    use objc2_local_authentication::{LAContext, LAPolicy};
    use std::sync::mpsc::sync_channel;
    use std::time::Duration;

    let context = unsafe { LAContext::new() };
    unsafe {
        context
            .canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication)
            .map_err(|_| "device owner authentication is unavailable".to_string())?;
    }

    let localized_reason = NSString::from_str(reason);
    let (sender, receiver) = sync_channel(1);
    let reply = RcBlock::new(move |success: objc2::runtime::Bool, _error| {
        let _ = sender.send(success.as_bool());
    });
    unsafe {
        context.evaluatePolicy_localizedReason_reply(
            LAPolicy::DeviceOwnerAuthentication,
            &localized_reason,
            &reply,
        );
    }

    match receiver.recv_timeout(Duration::from_secs(120)) {
        Ok(true) => Ok(()),
        Ok(false) => Err("identity confirmation was rejected".to_string()),
        Err(_) => {
            unsafe { context.invalidate() };
            Err("identity confirmation timed out".to_string())
        }
    }
}

#[cfg(target_os = "windows")]
async fn platform_confirm(window: &tauri::WebviewWindow, reason: &str) -> Result<(), String> {
    use windows::core::{factory, HSTRING};
    use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
    use windows_future::IAsyncOperation;

    // UserConsentVerifier::RequestVerificationAsync is a UWP-only API. A
    // Win32/Tauri app must use the interop factory and associate the prompt
    // with the exact window that initiated the privileged operation.
    let prompt_window = window.clone();
    let message = reason.to_string();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let operation =
                (|| -> Result<IAsyncOperation<UserConsentVerificationResult>, String> {
                    let hwnd = prompt_window
                        .hwnd()
                        .map_err(|_| "cannot identify the authentication window".to_string())?;
                    let verifier = factory::<UserConsentVerifier, IUserConsentVerifierInterop>()
                        .map_err(|_| "device owner authentication is unavailable".to_string())?;
                    let hwnd = HWND(hwnd.0);
                    let message = HSTRING::from(message);
                    unsafe {
                        verifier.RequestVerificationForWindowAsync::<
                        IAsyncOperation<UserConsentVerificationResult>,
                    >(hwnd, &message)
                    }
                    .map_err(|_| "device owner authentication is unavailable".to_string())
                })();
            let _ = sender.send(operation);
        })
        .map_err(|_| "cannot open the identity confirmation prompt".to_string())?;

    let operation = receiver
        .await
        .map_err(|_| "identity confirmation was interrupted".to_string())??;
    let result = operation
        .await
        .map_err(|_| "identity confirmation failed".to_string())?;
    if result == UserConsentVerificationResult::Verified {
        Ok(())
    } else {
        Err("identity confirmation was rejected".to_string())
    }
}

#[cfg(target_os = "linux")]
fn platform_confirm(reason: &str, action_id: &str) -> Result<(), String> {
    let pid = std::process::id();
    let stat = std::fs::read_to_string("/proc/self/stat")
        .map_err(|_| "cannot determine process start time".to_string())?;
    let close_paren = stat
        .rfind(')')
        .ok_or_else(|| "cannot determine process start time".to_string())?;
    // Fields after the executable name begin at proc field 3; starttime is
    // field 22, therefore index 19 in this suffix.
    let start_time = stat[close_paren + 1..]
        .split_whitespace()
        .nth(19)
        .ok_or_else(|| "cannot determine process start time".to_string())?;
    let uid = unsafe { libc::geteuid() };
    let subject = format!("{},{},{}", pid, start_time, uid);
    let status = std::process::Command::new("/usr/bin/pkcheck")
        .args([
            "--action-id",
            action_id,
            "--process",
            &subject,
            "--allow-user-interaction",
            "--detail",
            "operation",
            reason,
        ])
        .status()
        .map_err(|_| "polkit identity confirmation is unavailable".to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("identity confirmation was rejected".to_string())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn platform_confirm(_reason: &str, _action_id: &str) -> Result<(), String> {
    Err("identity-confirmed export is unsupported on this platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::{safe_prompt_field, validate_reason, MAX_PROMPT_FIELD_BYTES};

    #[test]
    fn rejects_non_ascii_or_invisible_text_before_opening_a_system_prompt() {
        for reason in [
            "bad\nreason",
            "bad\u{200b}reason",
            "bad\u{2028}reason",
            "bad\u{202e}reason",
            "bad\u{2066}reason",
        ] {
            assert!(validate_reason(reason).is_err(), "accepted {reason:?}");
        }
    }

    #[test]
    fn prompt_fields_escape_delimiters_and_unicode_bidi_controls() {
        let rendered = safe_prompt_field("prod\"]\u{202e}evil\n\u{2066}x\\中");
        assert_eq!(
            rendered,
            "prod\\u{22}\\u{5D}\\u{202E}evil\\u{A}\\u{2066}x\\u{5C}\\u{4E2D}"
        );
        let reason = format!("Bind credential. Authority: [{rendered}]");
        assert!(validate_reason(&reason).is_ok());
    }

    #[test]
    fn prompt_fields_cannot_escape_brackets_and_inject_trusted_labels() {
        let rendered = safe_prompt_field("prod] SSH authority: [evil");
        assert_eq!(rendered, "prod\\u{5D} SSH authority: \\u{5B}evil");
        assert!(!rendered.contains('['));
        assert!(!rendered.contains(']'));

        let reason = format!("Bind credential. Connection name: [{rendered}]");
        assert!(validate_reason(&reason).is_ok());
        assert!(reason.starts_with("Bind credential. Connection name: ["));
        assert!(reason.ends_with(']'));
    }

    #[test]
    fn prompt_fields_are_bounded_after_escaping() {
        let rendered = safe_prompt_field(&"\u{202e}".repeat(1_000));
        assert!(rendered.len() <= MAX_PROMPT_FIELD_BYTES);
        assert!(rendered.contains("...#"));
        assert_eq!(rendered.rsplit('#').next().unwrap().len(), 16);
    }

    #[test]
    fn truncated_prompt_fields_keep_distinct_digest_suffixes() {
        let prefix = "a".repeat(1_000);
        let first = safe_prompt_field(&format!("{prefix}one"));
        let second = safe_prompt_field(&format!("{prefix}two"));
        assert_ne!(first, second);
    }
}
