//! Local shell executor — mirrors Go `executor/local.go`.
//!
//! Starts a local PTY shell. Supports auto-restart (up to 3 times)
//! when the shell exits while clients are still connected.

use std::collections::HashMap;

use super::{Executor, ExecutorInfo};
use crate::server::terminal::Terminal;

/// Local shell executor.
pub struct LocalShellExecutor {
    pub shell: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
}

impl LocalShellExecutor {
    pub fn new(shell: String, cwd: String, cols: u16, rows: u16) -> Self {
        Self {
            shell,
            cwd,
            cols,
            rows,
        }
    }
}

#[async_trait::async_trait]
impl Executor for LocalShellExecutor {
    async fn start(&self) -> Result<Box<dyn Terminal>, String> {
        #[cfg(unix)]
        {
            let term = crate::server::terminal::pty_unix::PtyTerminal::new(
                &self.shell,
                &self.cwd,
                self.cols,
                self.rows,
            )?;
            Ok(Box::new(term))
        }

        #[cfg(windows)]
        {
            // Check if shell is a WSL distribution
            let shell_lower = self.shell.to_lowercase();
            if shell_lower.contains("wsl") || shell_lower.ends_with(".exe") && shell_lower.contains("wsl") {
                // WSL: use Python PTY helper
                let term = crate::server::terminal::pty_wsl::WslPtyTerminal::new(
                    &self.shell, // distro name or "wsl"
                    "",          // default shell inside WSL
                    &self.cwd,
                    self.cols,
                    self.rows,
                )
                .await?;
                Ok(Box::new(term))
            } else {
                // Native Windows: ConPTY
                let term = crate::server::terminal::pty_windows::ConPtyTerminal::new(
                    &self.shell,
                    &self.cwd,
                    self.cols,
                    self.rows,
                )?;
                Ok(Box::new(term))
            }
        }
    }

    async fn stop(&self) -> Result<(), String> {
        Ok(())
    }

    fn info(&self) -> ExecutorInfo {
        let mut labels = HashMap::new();
        labels.insert("shell".to_string(), self.shell.clone());
        if !self.cwd.is_empty() {
            labels.insert("cwd".to_string(), self.cwd.clone());
        }
        ExecutorInfo {
            executor_type: "local-shell".to_string(),
            labels,
        }
    }
}
