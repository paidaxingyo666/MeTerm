//! Terminal abstraction — mirrors Go `terminal/terminal.go`.
//!
//! The `Terminal` trait provides a cross-platform interface for reading/writing
//! to pseudo-terminals (PTY) and SSH sessions.

#[cfg(unix)]
pub mod hook_files;
pub mod mouse_windows;
#[cfg(unix)]
pub mod pty_unix;
#[cfg(windows)]
pub mod pty_windows;
pub mod pty_wsl;
pub mod ssh;
mod ssh_algorithms;
mod ssh_auth;
pub(crate) mod ssh_limits;
mod ssh_transport;

#[cfg(test)]
mod ssh_tests;

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

    /// 无条件促使前台应用重绘(接管/attach 后尺寸相同时内核不会发 SIGWINCH,
    /// TUI 不会自行重绘)。Unix PTY 实现为向前台进程组补发 SIGWINCH
    /// (dtach/abduco 的标准做法);SSH/Windows 无等价信号能力,默认 no-op。
    fn nudge(&self) {}

    /// Returns a token that is cancelled when the terminal process exits.
    fn done(&self) -> CancellationToken;

    /// Close the terminal and release resources.
    async fn close(&self) -> io::Result<()>;
}
