use std::{
    future::Future,
    io::{self, SeekFrom},
    pin::Pin,
    sync::Arc,
    task::{ready, Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf},
    runtime::Handle,
};

use super::Metadata;
use crate::{
    client::{error::Error, rawsession::SftpResult, session::Extensions, RawSftpSession},
    protocol::StatusCode,
};

type StateFn<T> = Option<Pin<Box<dyn Future<Output = io::Result<T>> + Send + Sync + 'static>>>;

const MAX_READ_LENGTH: u64 = 261120;
const MAX_WRITE_LENGTH: u64 = 261120;

struct FileState {
    f_read: StateFn<Option<Vec<u8>>>,
    f_seek: StateFn<u64>,
    f_write: StateFn<usize>,
    f_flush: StateFn<()>,
    f_shutdown: StateFn<()>,
}

/// Provides high-level methods for interaction with a remote file.
///
/// In order to properly close the handle, [`shutdown`] on a file should be called.
/// Also implement [`AsyncSeek`] and other async i/o implementations.
///
/// # Weakness
/// Using [`SeekFrom::End`] is costly and time-consuming because we need to
/// request the actual file size from the remote server.
pub struct File {
    session: Arc<RawSftpSession>,
    handle: String,
    state: FileState,
    pos: u64,
    closed: bool,
    extensions: Arc<Extensions>,
}

impl File {
    pub(crate) fn new(
        session: Arc<RawSftpSession>,
        handle: String,
        extensions: Arc<Extensions>,
    ) -> Self {
        Self {
            session,
            handle,
            state: FileState {
                f_read: None,
                f_seek: None,
                f_write: None,
                f_flush: None,
                f_shutdown: None,
            },
            pos: 0,
            closed: false,
            extensions,
        }
    }

    /// Queries metadata about the remote file.
    pub async fn metadata(&self) -> SftpResult<Metadata> {
        Ok(self.session.fstat(self.handle.as_str()).await?.attrs)
    }

    /// Sets metadata for a remote file.
    pub async fn set_metadata(&self, metadata: Metadata) -> SftpResult<()> {
        self.session
            .fsetstat(self.handle.as_str(), metadata)
            .await
            .map(|_| ())
    }

    /// Write all data using pipelined SFTP writes.
    ///
    /// Splits the buffer into chunks of `max_write_len`, sends all SFTP Write
    /// requests without waiting, then collects all Status responses.
    /// This turns N sequential round-trips into 1 round-trip of latency.
    pub async fn write_all_pipelined(&mut self, buf: &[u8]) -> io::Result<()> {
        if buf.is_empty() {
            return Ok(());
        }

        let max_write_len = self
            .extensions
            .limits
            .as_ref()
            .and_then(|l| l.write_len)
            .unwrap_or(MAX_WRITE_LENGTH) as usize;

        let mut pending = Vec::new();
        let mut offset = self.pos;
        let mut remaining = buf;

        // Phase 1: Send all Write packets without waiting for responses
        while !remaining.is_empty() {
            let len = std::cmp::min(remaining.len(), max_write_len);
            let chunk = remaining[..len].to_vec();
            remaining = &remaining[len..];

            match self.session.write_no_wait(self.handle.as_str(), offset, chunk) {
                Ok(pw) => {
                    pending.push(pw);
                    offset += len as u64;
                }
                Err(e) => {
                    // Try to collect any already-sent writes before returning error
                    for pw in pending {
                        let _ = pw.wait().await;
                    }
                    return Err(io::Error::new(io::ErrorKind::Other, e.to_string()));
                }
            }
        }

        // Phase 2: Collect all Status responses
        for pw in pending {
            pw.wait()
                .await
                .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
        }

        self.pos = offset;
        Ok(())
    }

    /// Read multiple chunks using pipelined SFTP read requests.
    ///
    /// Sends `count` SSH_FXP_READ requests at once, then collects responses
    /// in order. Returns a Vec of data chunks. Stops at EOF.
    /// This turns N sequential round-trips into ~1 round-trip of latency.
    pub async fn read_pipelined(&mut self, count: usize) -> io::Result<Vec<Vec<u8>>> {
        if count == 0 {
            return Ok(Vec::new());
        }

        let max_read_len = self
            .extensions
            .limits
            .as_ref()
            .and_then(|l| l.read_len)
            .unwrap_or(MAX_READ_LENGTH) as u32;

        // Phase 1: Send all read requests without waiting
        let mut pending = Vec::with_capacity(count);
        for _ in 0..count {
            match self.session.read_no_wait(self.handle.as_str(), self.pos, max_read_len) {
                Ok(pr) => {
                    pending.push(pr);
                    self.pos += max_read_len as u64;
                }
                Err(e) => {
                    // Collect already-sent reads before returning error
                    for pr in pending {
                        let _ = pr.wait().await;
                    }
                    return Err(io::Error::new(io::ErrorKind::Other, e.to_string()));
                }
            }
        }

        // Phase 2: Collect responses in order
        let mut results = Vec::with_capacity(count);
        for pr in pending {
            match pr.wait().await {
                Ok(Some(data)) => {
                    if data.is_empty() {
                        break;
                    }
                    results.push(data);
                }
                Ok(None) => break, // EOF
                Err(e) => return Err(io::Error::new(io::ErrorKind::Other, e.to_string())),
            }
        }

        // Adjust pos: we advanced by count * max_read_len, but may have read less
        let actual_bytes: u64 = results.iter().map(|d| d.len() as u64).sum();
        let advanced = count as u64 * max_read_len as u64;
        if actual_bytes < advanced {
            self.pos -= advanced - actual_bytes;
        }

        Ok(results)
    }

    /// Send a single SFTP Write without waiting for the response.
    /// Returns a [`PendingWrite`] token and the number of bytes submitted.
    /// The caller must collect the token later. At most `max_write_len` bytes
    /// are sent per call; the caller should loop for larger buffers.
    pub fn write_no_wait(&mut self, data: &[u8]) -> io::Result<(crate::client::rawsession::PendingWrite, usize)> {
        let max_write_len = self
            .extensions
            .limits
            .as_ref()
            .and_then(|l| l.write_len)
            .unwrap_or(MAX_WRITE_LENGTH) as usize;

        let len = std::cmp::min(data.len(), max_write_len);
        let chunk = data[..len].to_vec();

        let pw = self
            .session
            .write_no_wait(self.handle.as_str(), self.pos, chunk)
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

        self.pos += len as u64;
        Ok((pw, len))
    }

    /// Attempts to sync all data.
    ///
    /// If the server does not support `fsync@openssh.com` sending the request will
    /// be omitted, but will still pseudo-successfully
    pub async fn sync_all(&self) -> SftpResult<()> {
        if !self.extensions.fsync {
            return Ok(());
        }

        self.session.fsync(self.handle.as_str()).await.map(|_| ())
    }
}

impl Drop for File {
    fn drop(&mut self) {
        if self.closed {
            return;
        }

        if let Ok(handle) = Handle::try_current() {
            let session = self.session.clone();
            let file_handle = self.handle.clone();

            handle.spawn(async move {
                let _ = session.close(file_handle).await;
            });
        }
    }
}

impl AsyncRead for File {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let poll = Pin::new(match self.state.f_read.as_mut() {
            Some(f) => f,
            None => {
                let session = self.session.clone();
                let max_read_len = self
                    .extensions
                    .limits
                    .as_ref()
                    .and_then(|l| l.read_len)
                    .unwrap_or(MAX_READ_LENGTH) as usize;

                let file_handle = self.handle.clone();

                let offset = self.pos;
                let len = if buf.remaining() > max_read_len {
                    max_read_len
                } else {
                    buf.remaining()
                };

                self.state.f_read.get_or_insert(Box::pin(async move {
                    let result = session.read(file_handle, offset, len as u32).await;

                    match result {
                        Ok(data) => Ok(Some(data.data)),
                        Err(Error::Status(status)) if status.status_code == StatusCode::Eof => {
                            Ok(None)
                        }
                        Err(e) => Err(io::Error::new(io::ErrorKind::Other, e.to_string())),
                    }
                }))
            }
        })
        .poll(cx);

        if poll.is_ready() {
            self.state.f_read = None;
        }

        match poll {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
            Poll::Ready(Ok(None)) => Poll::Ready(Ok(())),
            Poll::Ready(Ok(Some(data))) => {
                self.pos += data.len() as u64;
                buf.put_slice(&data[..]);
                Poll::Ready(Ok(()))
            }
        }
    }
}

impl AsyncSeek for File {
    fn start_seek(mut self: Pin<&mut Self>, position: io::SeekFrom) -> io::Result<()> {
        match self.state.f_seek {
            Some(_) => Err(io::Error::new(
                io::ErrorKind::Other,
                "other file operation is pending, call poll_complete before start_seek",
            )),
            None => {
                let session = self.session.clone();
                let file_handle = self.handle.clone();
                let cur_pos = self.pos as i64;

                self.state.f_seek = Some(Box::pin(async move {
                    let new_pos = match position {
                        SeekFrom::Start(pos) => pos as i64,
                        SeekFrom::Current(pos) => cur_pos + pos,
                        SeekFrom::End(pos) => {
                            let result = session
                                .fstat(file_handle)
                                .await
                                .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;

                            match result.attrs.size {
                                Some(size) => size as i64 + pos,
                                None => {
                                    return Err(io::Error::new(
                                        io::ErrorKind::Other,
                                        "file size unknown",
                                    ))
                                }
                            }
                        }
                    };

                    if new_pos < 0 {
                        return Err(io::Error::new(
                            io::ErrorKind::Other,
                            "cannot move file pointer before the beginning",
                        ));
                    }

                    Ok(new_pos as u64)
                }));

                Ok(())
            }
        }
    }

    fn poll_complete(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        match self.state.f_seek.as_mut() {
            None => Poll::Ready(Ok(self.pos)),
            Some(f) => {
                self.pos = ready!(Pin::new(f).poll(cx))?;
                self.state.f_seek = None;
                Poll::Ready(Ok(self.pos))
            }
        }
    }
}

impl AsyncWrite for File {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<Result<usize, io::Error>> {
        let poll = Pin::new(match self.state.f_write.as_mut() {
            Some(f) => f,
            None => {
                let session = self.session.clone();
                let max_write_len = self
                    .extensions
                    .limits
                    .as_ref()
                    .and_then(|l| l.write_len)
                    .unwrap_or(MAX_WRITE_LENGTH) as usize;

                let file_handle = self.handle.clone();
                let data = buf.to_vec();

                let offset = self.pos;
                let len = if data.len() > max_write_len {
                    max_write_len
                } else {
                    data.len()
                };

                self.state.f_write.get_or_insert(Box::pin(async move {
                    session
                        .write(file_handle, offset, data[..len].to_vec())
                        .await
                        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
                    Ok(len)
                }))
            }
        })
        .poll(cx);

        if poll.is_ready() {
            self.state.f_write = None;
        }

        if let Poll::Ready(Ok(len)) = poll {
            self.pos += len as u64;
        }

        poll
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), io::Error>> {
        if !self.extensions.fsync {
            return Poll::Ready(Ok(()));
        }

        let poll = Pin::new(match self.state.f_flush.as_mut() {
            Some(f) => f,
            None => {
                let session = self.session.clone();
                let file_handle = self.handle.clone();

                self.state.f_flush.get_or_insert(Box::pin(async move {
                    session
                        .fsync(file_handle)
                        .await
                        .map(|_| ())
                        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))
                }))
            }
        })
        .poll(cx);

        if poll.is_ready() {
            self.state.f_flush = None;
        }

        poll
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Result<(), io::Error>> {
        let poll = Pin::new(match self.state.f_shutdown.as_mut() {
            Some(f) => f,
            None => {
                let session = self.session.clone();
                let file_handle = self.handle.clone();

                self.state.f_shutdown.get_or_insert(Box::pin(async move {
                    session
                        .close(file_handle)
                        .await
                        .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
                    Ok(())
                }))
            }
        })
        .poll(cx);

        if poll.is_ready() {
            self.state.f_shutdown = None;
            self.closed = true;
        }

        poll
    }
}
