//! Terminal abstraction — mirrors Go `terminal/terminal.go`.
//!
//! The `Terminal` trait provides a cross-platform interface for reading/writing
//! to pseudo-terminals (PTY) and SSH sessions.

#[cfg(unix)]
pub mod pty_unix;
#[cfg(windows)]
pub mod pty_windows;
pub mod mouse_windows;
pub mod pty_wsl;
pub mod ssh;

use std::io;
use tokio_util::sync::CancellationToken;

/// Cross-platform terminal interface.
///
/// Implementations:
/// - `PtyTerminal` (Unix/macOS via xpty)
/// - `ConPtyTerminal` (Windows via xpty ConPTY)
/// - `WslPtyTerminal` (Windows WSL via Python PTY helper)
/// - `SshTerminal` (remote via russh)
#[async_trait::async_trait]
pub trait Terminal: Send + Sync {
    /// Read output from the terminal. Returns 0 bytes when the PTY is closed.
    async fn read(&self, buf: &mut [u8]) -> io::Result<usize>;

    /// Write input to the terminal.
    async fn write(&self, data: &[u8]) -> io::Result<usize>;

    /// Resize the terminal window.
    fn resize(&self, cols: u16, rows: u16) -> io::Result<()>;

    /// Returns a token that is cancelled when the terminal process exits.
    fn done(&self) -> CancellationToken;

    /// Close the terminal and release resources.
    async fn close(&self) -> io::Result<()>;
}
