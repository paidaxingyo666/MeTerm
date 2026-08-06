//! Atomic writes for local secret-bearing files.

use std::ffi::OsString;
use std::io::Write;
use std::path::Path;

#[derive(Debug)]
pub(crate) struct AtomicWriteError {
    message: String,
    replacement_visible: bool,
}

impl AtomicWriteError {
    pub(crate) fn before_replace(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            replacement_visible: false,
        }
    }

    fn after_replace(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            replacement_visible: true,
        }
    }

    pub(crate) fn replacement_visible(&self) -> bool {
        self.replacement_visible
    }
}

impl std::fmt::Display for AtomicWriteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

pub(crate) fn atomic_write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    match atomic_write_private_staged(path, bytes) {
        Ok(()) => Ok(()),
        Err(error) if error.replacement_visible() => {
            // The destination already contains the complete fsynced file. It
            // is no longer safe for callers to roll back related state as if
            // replacement never happened; only crash durability is uncertain.
            eprintln!("[private-file] parent directory sync failed after commit: {error}");
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn atomic_write_private_staged(
    path: &Path,
    bytes: &[u8],
) -> Result<(), AtomicWriteError> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|error| {
        AtomicWriteError::before_replace(format!("create {}: {}", parent.display(), error))
    })?;

    let file_name = path.file_name().ok_or_else(|| {
        AtomicWriteError::before_replace(format!("invalid private file path: {}", path.display()))
    })?;
    let mut temp_name = OsString::from(".");
    temp_name.push(file_name);
    temp_name.push(format!(".tmp-{}", uuid::Uuid::new_v4()));
    let temp = parent.join(temp_name);

    let mut file = create_private_file(&temp).map_err(AtomicWriteError::before_replace)?;
    if let Err(error) = file
        .write_all(bytes)
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_all())
    {
        drop(file);
        let _ = std::fs::remove_file(&temp);
        return Err(AtomicWriteError::before_replace(format!(
            "write {}: {}",
            temp.display(),
            error
        )));
    }
    drop(file);

    if let Err(error) = atomic_replace(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(AtomicWriteError::before_replace(format!(
            "replace {}: {}",
            path.display(),
            error
        )));
    }
    sync_parent_directory(parent).map_err(AtomicWriteError::after_replace)?;
    Ok(())
}

#[cfg(test)]
thread_local! {
    static FAIL_NEXT_PARENT_SYNC: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[cfg(test)]
pub(crate) fn fail_next_parent_sync_for_test() {
    FAIL_NEXT_PARENT_SYNC.with(|flag| flag.set(true));
}

#[cfg(test)]
fn injected_parent_sync_failure() -> bool {
    FAIL_NEXT_PARENT_SYNC.with(|flag| flag.replace(false))
}

#[cfg(not(test))]
fn injected_parent_sync_failure() -> bool {
    false
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> Result<(), String> {
    if injected_parent_sync_failure() {
        return Err("injected parent directory sync failure".to_string());
    }
    let directory = std::fs::File::open(parent)
        .map_err(|error| format!("open {} for sync: {}", parent.display(), error))?;
    directory
        .sync_all()
        .map_err(|error| format!("sync {}: {}", parent.display(), error))
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> Result<(), String> {
    if injected_parent_sync_failure() {
        return Err("injected parent directory sync failure".to_string());
    }
    // Windows uses MoveFileExW with MOVEFILE_WRITE_THROUGH in atomic_replace.
    Ok(())
}

#[cfg(unix)]
fn create_private_file(path: &Path) -> Result<std::fs::File, String> {
    use std::fs::OpenOptions;
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options.write(true).create_new(true).mode(0o600);
    options
        .open(path)
        .map_err(|error| format!("create {}: {}", path.display(), error))
}

#[cfg(windows)]
fn create_private_file(path: &Path) -> Result<std::fs::File, String> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_NONE,
    };

    // Apply the protected DACL as part of CreateFileW. Creating the file first
    // and tightening it afterward leaves a race in shared directories: another
    // account can retain a permissive read handle before any secret bytes are
    // written, and a later DACL update cannot revoke that handle.
    let sddl: Vec<u16> = "D:P(A;;FA;;;SY)(A;;FA;;;OW)"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl.as_ptr()),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
        .map_err(|_| "failed to create private Windows file ACL".to_string())?;
    }

    let result = (|| {
        let wide_path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let security_attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        };
        let handle = unsafe {
            CreateFileW(
                PCWSTR(wide_path.as_ptr()),
                windows::Win32::Foundation::GENERIC_WRITE.0,
                FILE_SHARE_NONE,
                Some(&security_attributes),
                CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        }
        .map_err(|error| format!("create {}: {}", path.display(), error))?;

        // CreateFileW returned a unique owned handle. Transfer it immediately
        // to File so every later error path closes it exactly once.
        Ok(unsafe { std::fs::File::from_raw_handle(handle.0) })
    })();
    unsafe {
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
    }
    result
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        atomic_write_private, atomic_write_private_staged, fail_next_parent_sync_for_test,
    };

    #[test]
    fn replaces_existing_file_without_leaving_a_partial_write() {
        let directory =
            std::env::temp_dir().join(format!("meterm-private-file-test-{}", uuid::Uuid::new_v4()));
        let path = directory.join("secret");

        atomic_write_private(&path, b"first").unwrap();
        atomic_write_private(&path, b"second").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        let entries = std::fs::read_dir(&directory).unwrap().count();
        assert_eq!(entries, 1);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn post_replace_sync_failure_reports_visible_commit_without_reverting_file() {
        let directory = std::env::temp_dir().join(format!(
            "meterm-private-file-post-replace-test-{}",
            uuid::Uuid::new_v4()
        ));
        let path = directory.join("secret");
        atomic_write_private(&path, b"before").unwrap();

        fail_next_parent_sync_for_test();
        let error = atomic_write_private_staged(&path, b"after").unwrap_err();
        assert!(error.replacement_visible());
        assert_eq!(std::fs::read(&path).unwrap(), b"after");

        let _ = std::fs::remove_dir_all(directory);
    }
}
