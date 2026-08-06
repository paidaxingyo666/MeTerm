//! Resource and time bounds for remote SSH command and SFTP operations.

use std::fmt;
use std::future::Future;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::Mutex;

use russh::{client, ChannelMsg};

use super::ssh::SshHandler;

pub(crate) const SSH_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const SSH_AUTH_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const SSH_CHANNEL_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const SSH_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
/// Authoritative wall-clock budget for creating an interactive SSH terminal.
/// Individual stage limits above remain useful diagnostics, while this outer
/// limit guarantees an HTTP caller cannot time out first and leave a session
/// that finishes registering after the caller has already given up.
pub(crate) const SSH_SESSION_CONNECT_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const SSH_EXEC_MAX_TIMEOUT_SECS: u64 = 30;
pub(crate) const SSH_EXEC_OUTPUT_LIMIT: usize = 4 * 1024 * 1024;

pub(crate) const SFTP_FILE_READ_LIMIT: usize = 50 * 1024 * 1024;
pub(crate) const SFTP_FILE_READ_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const SFTP_OPERATION_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) async fn operation_with_timeout<T, E, F>(
    label: &str,
    timeout: Duration,
    operation: F,
) -> Result<T, String>
where
    E: fmt::Display,
    F: Future<Output = Result<T, E>>,
{
    match tokio::time::timeout(timeout, operation).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(format!("{}: {}", label, error)),
        Err(_) => Err(format!("{} timed out after {}s", label, timeout.as_secs())),
    }
}

/// Execute a command on the SSH server via a new channel. Both stdout and
/// stderr count against one aggregate cap, and a timeout/overflow closes the
/// channel so the remote process is not left running.
pub async fn ssh_exec(
    session_handle: &std::sync::Arc<Mutex<Option<client::Handle<SshHandler>>>>,
    command: &str,
    timeout_secs: u64,
) -> Result<String, String> {
    let mut guard = session_handle.lock().await;
    let session = guard.as_mut().ok_or("SSH session not available")?;
    let mut channel = operation_with_timeout(
        "exec channel open",
        SSH_CHANNEL_TIMEOUT,
        session.channel_open_session(),
    )
    .await?;

    if let Err(error) = operation_with_timeout(
        "exec request",
        SSH_CHANNEL_TIMEOUT,
        channel.exec(true, command),
    )
    .await
    {
        let _ = tokio::time::timeout(SSH_CLOSE_TIMEOUT, channel.close()).await;
        return Err(error);
    }

    let effective_timeout_secs = timeout_secs.clamp(1, SSH_EXEC_MAX_TIMEOUT_SECS);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(effective_timeout_secs);
    let mut output = Vec::new();
    let result = loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break Err(format!("exec timed out after {}s", effective_timeout_secs));
        }
        match tokio::time::timeout(remaining, channel.wait()).await {
            Ok(Some(ChannelMsg::Data { data }))
            | Ok(Some(ChannelMsg::ExtendedData { data, .. })) => {
                if append_bounded(&mut output, &data, SSH_EXEC_OUTPUT_LIMIT).is_err() {
                    break Err(format!(
                        "exec output exceeds {} byte limit",
                        SSH_EXEC_OUTPUT_LIMIT
                    ));
                }
            }
            Ok(Some(ChannelMsg::Eof)) | Ok(None) => break Ok(output),
            Ok(_) => continue,
            Err(_) => break Err(format!("exec timed out after {}s", effective_timeout_secs)),
        }
    };

    let _ = tokio::time::timeout(SSH_CLOSE_TIMEOUT, channel.close()).await;
    String::from_utf8(result?).map_err(|error| format!("utf8: {}", error))
}

#[derive(Debug)]
pub(crate) enum BoundedReadError {
    TooLarge { limit: usize },
    TimedOut { timeout: Duration },
    Io(std::io::Error),
}

impl fmt::Display for BoundedReadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge { limit } => write!(formatter, "stream exceeds {} byte limit", limit),
            Self::TimedOut { timeout } => {
                write!(
                    formatter,
                    "stream read timed out after {}s",
                    timeout.as_secs()
                )
            }
            Self::Io(error) => write!(formatter, "stream read failed: {}", error),
        }
    }
}

/// Append one SSH channel packet without allowing the aggregate command output
/// buffer to grow beyond `limit`.
pub(crate) fn append_bounded(
    output: &mut Vec<u8>,
    packet: &[u8],
    limit: usize,
) -> Result<(), BoundedReadError> {
    if packet.len() > limit.saturating_sub(output.len()) {
        return Err(BoundedReadError::TooLarge { limit });
    }
    output.extend_from_slice(packet);
    Ok(())
}

/// Read at most `limit + 1` bytes from the real stream. The extra byte makes
/// the limit authoritative even when an SFTP server lies in its metadata or
/// the file grows after the metadata request.
pub(crate) async fn read_bounded<R>(
    reader: &mut R,
    limit: usize,
    timeout: Duration,
) -> Result<Vec<u8>, BoundedReadError>
where
    R: AsyncRead + Unpin,
{
    let read_limit = u64::try_from(limit)
        .unwrap_or(u64::MAX - 1)
        .saturating_add(1);
    let mut limited = reader.take(read_limit);
    let mut content = Vec::with_capacity(limit.min(64 * 1024));

    match tokio::time::timeout(timeout, limited.read_to_end(&mut content)).await {
        Ok(Ok(_)) if content.len() <= limit => Ok(content),
        Ok(Ok(_)) => Err(BoundedReadError::TooLarge { limit }),
        Ok(Err(error)) => Err(BoundedReadError::Io(error)),
        Err(_) => Err(BoundedReadError::TimedOut { timeout }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncWriteExt, DuplexStream};

    async fn stream_with(data: &[u8]) -> DuplexStream {
        let (mut writer, reader) = tokio::io::duplex(data.len().max(1));
        writer.write_all(data).await.unwrap();
        writer.shutdown().await.unwrap();
        reader
    }

    #[test]
    fn append_rejects_packet_that_crosses_limit_without_partial_append() {
        let mut output = b"1234".to_vec();
        let error = append_bounded(&mut output, b"56", 5).unwrap_err();

        assert!(matches!(error, BoundedReadError::TooLarge { limit: 5 }));
        assert_eq!(output, b"1234");
    }

    #[tokio::test]
    async fn bounded_read_accepts_exact_limit() {
        let mut reader = stream_with(b"1234").await;
        let content = read_bounded(&mut reader, 4, Duration::from_secs(1))
            .await
            .unwrap();

        assert_eq!(content, b"1234");
    }

    #[tokio::test]
    async fn bounded_read_consumes_extra_byte_and_rejects_lying_metadata_case() {
        let mut reader = stream_with(b"12345").await;
        let error = read_bounded(&mut reader, 4, Duration::from_secs(1))
            .await
            .unwrap_err();

        assert!(matches!(error, BoundedReadError::TooLarge { limit: 4 }));
    }

    #[tokio::test]
    async fn bounded_read_times_out_on_stalled_stream() {
        let (_writer, mut reader) = tokio::io::duplex(1);
        let error = read_bounded(&mut reader, 4, Duration::from_millis(20))
            .await
            .unwrap_err();

        assert!(matches!(error, BoundedReadError::TimedOut { .. }));
    }
}
