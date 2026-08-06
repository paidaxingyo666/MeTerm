use std::io::{self, Read};
use std::path::Path;

use serde::Deserialize;

pub(super) const DEFAULT_FILE_READ_LIMIT: usize = 50 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub(super) struct FileReadRequest {
    pub path: String,
    #[serde(default)]
    pub max_bytes: Option<u64>,
}

pub(super) fn parse_file_read_request(
    payload: &[u8],
    server_limit: usize,
) -> Result<(String, usize), String> {
    let request: FileReadRequest =
        serde_json::from_slice(payload).map_err(|error| format!("parse: {error}"))?;
    if request.path.is_empty() {
        return Err("path is required".to_string());
    }
    let requested = match request.max_bytes {
        Some(0) => return Err("max_bytes must be greater than zero".to_string()),
        Some(value) => usize::try_from(value).unwrap_or(usize::MAX),
        None => server_limit,
    };
    Ok((request.path, requested.min(server_limit)))
}

pub(super) enum BoundedLocalReadError {
    Io(io::Error),
    TooLarge,
}

/// Metadata is only an early rejection. `take(limit + 1)` is the allocation boundary
/// if a file grows or is replaced between metadata and read.
pub(super) fn read_local_bounded(
    path: &Path,
    limit: usize,
) -> Result<Vec<u8>, BoundedLocalReadError> {
    let metadata = std::fs::metadata(path).map_err(BoundedLocalReadError::Io)?;
    if metadata.len() > limit as u64 {
        return Err(BoundedLocalReadError::TooLarge);
    }
    let file = std::fs::File::open(path).map_err(BoundedLocalReadError::Io)?;
    let mut content = Vec::with_capacity((metadata.len() as usize).min(limit));
    file.take(limit as u64 + 1)
        .read_to_end(&mut content)
        .map_err(BoundedLocalReadError::Io)?;
    if content.len() > limit {
        return Err(BoundedLocalReadError::TooLarge);
    }
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_limit_is_bounded_and_legacy_request_has_safe_default() {
        let (_, requested) = parse_file_read_request(
            br#"{"path":"/tmp/x","max_bytes":1234}"#,
            DEFAULT_FILE_READ_LIMIT,
        )
        .unwrap();
        assert_eq!(requested, 1234);

        let (_, legacy) =
            parse_file_read_request(br#"{"path":"/tmp/x"}"#, DEFAULT_FILE_READ_LIMIT).unwrap();
        assert_eq!(legacy, DEFAULT_FILE_READ_LIMIT);

        assert!(parse_file_read_request(
            br#"{"path":"/tmp/x","max_bytes":0}"#,
            DEFAULT_FILE_READ_LIMIT
        )
        .is_err());
    }

    #[test]
    fn local_read_stops_at_limit() {
        let path = std::env::temp_dir().join(format!("meterm-read-limit-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"12345").unwrap();
        assert!(matches!(
            read_local_bounded(&path, 4),
            Err(BoundedLocalReadError::TooLarge)
        ));
        let _ = std::fs::remove_file(path);
    }
}
