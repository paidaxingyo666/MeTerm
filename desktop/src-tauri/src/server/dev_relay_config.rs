//! Native-only provisioning for the isolated development relay identity.
//!
//! This module is compiled only into the non-distributable macOS development
//! build. Secrets arrive over a Unix socket, are never accepted on the command
//! line or through the WebView, and are committed by the exact signed app
//! binary that will subsequently read the Keychain entry.

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;
use zeroize::{Zeroize, Zeroizing};

use super::relay_credentials::{
    load_relay_config, relay_config_path, update_relay_config, validate_relay_endpoint,
    validate_secret,
};

pub(crate) const CONFIGURE_FLAG: &str = "--configure-dev-relay";
const MAX_INPUT_BYTES: u64 = 512;
const MAX_METADATA_BYTES: u64 = 64 * 1024;
const DEVELOPMENT_TEAM_ID: &str = "G5J7URYYG5";
// The full certificate CN contains the developer's personal Apple ID, so it is
// injected at build time instead of living in the (published) source tree.
// `make desktop-dev` / `make desktop-build-dev` derive it from the local
// keychain; a build without it fails closed here rather than weakening the
// signer check.
const DEVELOPMENT_SIGNER_CN: Option<&str> = option_env!("METERM_DEV_SIGNER_CN");

fn development_signer_cn() -> Result<&'static str, String> {
    DEVELOPMENT_SIGNER_CN
        .map(str::trim)
        .filter(|cn| cn.starts_with("Apple Development:"))
        .ok_or_else(|| {
            "development signer identity was not embedded at build time; build through \
             `make desktop-dev` / `make desktop-build-dev`, or export METERM_DEV_SIGNER_CN \
             with the full Apple Development certificate CN before building"
                .to_string()
        })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DevelopmentRelayMetadata {
    version: u8,
    url: String,
    cert_fp: String,
    enabled: bool,
}

/// Handle the one development-only native provisioning flag before startup
/// logging or Tauri initialization can observe command-line arguments.
pub(crate) fn handle_cli(args: &[OsString]) -> Result<(), String> {
    if args.len() != 2 || args[1] != CONFIGURE_FLAG {
        return Err(
            "invalid dev relay provisioning invocation; no additional arguments are allowed"
                .to_string(),
        );
    }
    configure_from_socket()
}

fn configure_from_socket() -> Result<(), String> {
    disable_core_dumps()?;
    validate_development_app_identity()?;

    let state_dir = development_server_state_dir()?;
    let metadata_path = PathBuf::from(relay_config_path(&state_dir));
    let existing = read_development_metadata(&metadata_path)?;
    if existing.version != 2 {
        return Err("unsupported development relay metadata version".to_string());
    }
    validate_relay_endpoint(&existing.url, &existing.cert_fp)
        .map_err(|_| "validated development relay authority metadata is unavailable".to_string())?;

    require_socket_stdin()?;
    let mut input = Zeroizing::new(Vec::new());
    std::io::stdin()
        .lock()
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut input)
        .map_err(|_| "failed to read dev relay provisioning record".to_string())?;
    if input.len() as u64 > MAX_INPUT_BYTES {
        return Err("dev relay provisioning input is oversized".to_string());
    }
    let input_bytes = std::mem::take(&mut *input);
    let raw_string = match String::from_utf8(input_bytes) {
        Ok(value) => value,
        Err(error) => {
            let mut bytes = error.into_bytes();
            bytes.zeroize();
            return Err("dev relay provisioning input must be UTF-8".to_string());
        }
    };
    let raw = Zeroizing::new(raw_string);
    let lines: Vec<&str> = raw.lines().collect();
    if lines.len() != 4 {
        return Err(
            "dev relay input must contain authority, pin, and two secret lines".to_string(),
        );
    }
    validate_relay_endpoint(lines[0], lines[1])?;
    validate_secret(lines[2])?;
    validate_secret(lines[3])?;
    if lines[2].eq_ignore_ascii_case(lines[3]) {
        return Err("dev relay registration and push secrets must differ".to_string());
    }
    if existing.url != lines[0] || !existing.cert_fp.eq_ignore_ascii_case(lines[1]) {
        return Err("dev relay authority does not match the pre-validated metadata".to_string());
    }

    let expected_url = lines[0].to_string();
    let expected_cert_fp = lines[1].to_ascii_lowercase();
    update_relay_config(
        &state_dir,
        expected_url.clone(),
        lines[2].to_ascii_lowercase(),
        Some(lines[3].to_ascii_lowercase()),
        expected_cert_fp.clone(),
        true,
    )?;

    let status = load_relay_config(&state_dir);
    let stored_metadata = read_development_metadata(&metadata_path)?;
    let metadata_ok = stored_metadata.version == 2 && stored_metadata.enabled;
    let authority_matches = status.url == expected_url
        && status.cert_fp.eq_ignore_ascii_case(&expected_cert_fp)
        && stored_metadata.url == expected_url
        && stored_metadata
            .cert_fp
            .eq_ignore_ascii_case(&expected_cert_fp);
    let registration_present = validate_secret(&status.token).is_ok();
    let push_present = status
        .push_token
        .as_deref()
        .is_some_and(|secret| validate_secret(secret).is_ok());
    let secrets_distinct = status
        .push_token
        .as_deref()
        .is_some_and(|push| !push.eq_ignore_ascii_case(&status.token));
    let all_ok = metadata_ok
        && status.enabled
        && authority_matches
        && registration_present
        && push_present
        && secrets_distinct;
    eprintln!(
        "[dev-relay-config] metadata_v2={metadata_ok} enabled={} authority_matches={authority_matches} registration_present={registration_present} push_present={push_present} secrets_distinct={secrets_distinct}",
        status.enabled
    );
    if all_ok {
        Ok(())
    } else {
        Err("native dev relay credential verification failed".to_string())
    }
}

pub(crate) fn validate_development_app_identity() -> Result<(), String> {
    let signer_cn = development_signer_cn()?;
    let executable = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .map_err(|_| "cannot resolve the current development app executable".to_string())?;
    let app = executable
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .filter(|path| path.file_name() == Some(OsStr::new("MeTerm Dev.app")))
        .ok_or_else(|| "provisioning must run from the signed MeTerm Dev.app bundle".to_string())?;
    let expected_executable = app.join("Contents").join("MacOS").join("meterm");
    if std::fs::canonicalize(&expected_executable).ok().as_ref() != Some(&executable) {
        return Err("unexpected MeTerm Dev executable path".to_string());
    }

    let verification = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(format!(
            "-R=identifier \"com.meterm.dev\" and anchor apple generic and certificate leaf[subject.OU] = \"{DEVELOPMENT_TEAM_ID}\" and certificate leaf[subject.CN] = \"{signer_cn}\""
        ))
        .arg(app)
        .output()
        .map_err(|_| "failed to invoke native code-signature verification".to_string())?;
    if !verification.status.success() {
        return Err("MeTerm Dev bundle signature verification failed".to_string());
    }
    let details = Command::new("/usr/bin/codesign")
        .args(["-d", "--verbose=4"])
        .arg(&executable)
        .output()
        .map_err(|_| "failed to inspect the development code signature".to_string())?;
    if !details.status.success() {
        return Err("MeTerm Dev executable is not signed".to_string());
    }
    let signature_text = String::from_utf8_lossy(&details.stderr);
    if !signature_text
        .lines()
        .any(|line| line == "Identifier=com.meterm.dev")
        || !signature_text
            .lines()
            .any(|line| line.strip_prefix("Authority=") == Some(signer_cn))
        || !signature_text
            .lines()
            .any(|line| line.strip_prefix("TeamIdentifier=") == Some(DEVELOPMENT_TEAM_ID))
    {
        return Err("unexpected MeTerm Dev signing identity".to_string());
    }

    let identifier = Command::new("/usr/bin/plutil")
        .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"])
        .arg(app.join("Contents").join("Info.plist"))
        .output()
        .map_err(|_| "failed to inspect the development bundle identifier".to_string())?;
    if !identifier.status.success()
        || String::from_utf8_lossy(&identifier.stdout).trim() != "com.meterm.dev"
    {
        return Err("unexpected MeTerm Dev bundle identifier".to_string());
    }
    Ok(())
}

fn development_server_state_dir() -> Result<String, String> {
    let path = effective_user_home_directory()?
        .join("Library")
        .join("Application Support")
        .join("com.meterm.dev")
        .join("server");
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|_| "isolated MeTerm Dev server state directory is unavailable".to_string())?;
    if !metadata.file_type().is_dir()
        || metadata.uid() != effective_uid()
        || metadata.permissions().mode() & 0o022 != 0
        || std::fs::canonicalize(&path).ok().as_ref() != Some(&path)
    {
        return Err("isolated MeTerm Dev server state directory is unsafe".to_string());
    }
    Ok(path.to_string_lossy().into_owned())
}

fn read_development_metadata(path: &Path) -> Result<DevelopmentRelayMetadata, String> {
    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let mut file = options
        .open(path)
        .map_err(|_| "failed to open dev relay metadata".to_string())?;
    let before = file
        .metadata()
        .map_err(|_| "failed to inspect dev relay metadata".to_string())?;
    validate_metadata_properties(&before)?;

    let mut bytes = Vec::with_capacity(before.len() as usize);
    file.by_ref()
        .take(MAX_METADATA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "failed to read dev relay metadata".to_string())?;
    if bytes.len() as u64 != before.len() || bytes.len() as u64 > MAX_METADATA_BYTES {
        return Err("dev relay metadata size changed or is oversized".to_string());
    }
    let after = file
        .metadata()
        .map_err(|_| "failed to re-inspect dev relay metadata".to_string())?;
    validate_metadata_properties(&after)?;
    if before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.len() != after.len()
        || before.mode() != after.mode()
        || before.uid() != after.uid()
        || before.nlink() != after.nlink()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err("dev relay metadata changed while loading".to_string());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "failed to decode metadata-only dev relay configuration".to_string())
}

fn validate_metadata_properties(metadata: &std::fs::Metadata) -> Result<(), String> {
    if !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_METADATA_BYTES
        || metadata.uid() != effective_uid()
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.nlink() != 1
    {
        return Err("dev relay metadata owner, mode, type, or size is unsafe".to_string());
    }
    Ok(())
}

fn require_socket_stdin() -> Result<(), String> {
    // SAFETY: a zeroed stat structure is valid output storage for fstat.
    let mut metadata: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: STDIN_FILENO is an integer descriptor and metadata is writable.
    if unsafe { libc::fstat(libc::STDIN_FILENO, &mut metadata) } != 0
        || metadata.st_mode & libc::S_IFMT != libc::S_IFSOCK
        || socket_type(libc::STDIN_FILENO)? != libc::SOCK_STREAM
        || !is_unnamed_unix_socket(libc::STDIN_FILENO, false)?
        || !is_unnamed_unix_socket(libc::STDIN_FILENO, true)?
    {
        return Err("dev relay provisioning requires a private Unix socket on stdin".to_string());
    }
    let mut peer_uid: libc::uid_t = 0;
    let mut peer_gid: libc::gid_t = 0;
    // SAFETY: both output pointers are valid, and stdin was verified as a
    // connected AF_UNIX stream socket above.
    if unsafe { libc::getpeereid(libc::STDIN_FILENO, &mut peer_uid, &mut peer_gid) } != 0
        || peer_uid != effective_uid()
    {
        return Err("dev relay provisioning socket peer is not the effective user".to_string());
    }
    let timeout = libc::timeval {
        tv_sec: 10,
        tv_usec: 0,
    };
    // SAFETY: timeout points to a complete timeval for SO_RCVTIMEO and is not
    // retained by the kernel after setsockopt returns.
    if unsafe {
        libc::setsockopt(
            libc::STDIN_FILENO,
            libc::SOL_SOCKET,
            libc::SO_RCVTIMEO,
            (&timeout as *const libc::timeval).cast(),
            std::mem::size_of_val(&timeout) as libc::socklen_t,
        )
    } != 0
    {
        return Err("failed to bound dev relay provisioning socket reads".to_string());
    }
    Ok(())
}

fn socket_type(fd: libc::c_int) -> Result<libc::c_int, String> {
    let mut value: libc::c_int = 0;
    let mut length = std::mem::size_of_val(&value) as libc::socklen_t;
    // SAFETY: value and length point to initialized writable storage of the
    // exact type requested from SOL_SOCKET/SO_TYPE.
    if unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_TYPE,
            (&mut value as *mut libc::c_int).cast(),
            &mut length,
        )
    } != 0
    {
        return Err("failed to inspect dev relay provisioning socket".to_string());
    }
    Ok(value)
}

fn is_unnamed_unix_socket(fd: libc::c_int, peer: bool) -> Result<bool, String> {
    // SAFETY: a zeroed sockaddr_un is valid output storage for getsockname or
    // getpeername, and the supplied length exactly describes that storage.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of_val(&address) as libc::socklen_t;
    let result = unsafe {
        if peer {
            libc::getpeername(
                fd,
                (&mut address as *mut libc::sockaddr_un).cast(),
                &mut length,
            )
        } else {
            libc::getsockname(
                fd,
                (&mut address as *mut libc::sockaddr_un).cast(),
                &mut length,
            )
        }
    };
    if result != 0 {
        return Err("failed to inspect dev relay provisioning socket endpoint".to_string());
    }
    Ok(address.sun_family as libc::c_int == libc::AF_UNIX
        && address.sun_path.iter().all(|byte| *byte == 0))
}

fn effective_user_home_directory() -> Result<PathBuf, String> {
    // Use the account database, not HOME, which a launcher can override.
    let mut record: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    let suggested = unsafe { libc::sysconf(libc::_SC_GETPW_R_SIZE_MAX) };
    let buffer_len = if suggested > 0 {
        suggested as usize
    } else {
        16 * 1024
    };
    let mut buffer = vec![0_u8; buffer_len.clamp(1024, 1024 * 1024)];
    // SAFETY: record, buffer, and result are valid writable storage for the
    // duration of getpwuid_r; the returned pw_dir points inside buffer.
    let code = unsafe {
        libc::getpwuid_r(
            effective_uid(),
            &mut record,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        )
    };
    if code != 0 || result.is_null() || record.pw_dir.is_null() {
        return Err("effective user home directory is unavailable".to_string());
    }
    // SAFETY: successful getpwuid_r returned a NUL-terminated pw_dir inside
    // the still-live buffer.
    let bytes = unsafe { std::ffi::CStr::from_ptr(record.pw_dir) }.to_bytes();
    Ok(PathBuf::from(OsStr::from_bytes(bytes)))
}

fn disable_core_dumps() -> Result<(), String> {
    let limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `limit` points to a fully initialized rlimit structure and
    // setrlimit retains no pointer after returning.
    if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limit) } == 0 {
        Ok(())
    } else {
        Err("failed to disable core dumps for dev relay provisioning".to_string())
    }
}

fn effective_uid() -> u32 {
    // SAFETY: geteuid has no preconditions and does not dereference pointers.
    unsafe { libc::geteuid() }
}
