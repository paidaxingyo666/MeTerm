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
    /// 注入 PTY 的额外环境变量(agent 终端镜像 M1:METERM_* hook env)。
    /// 默认空;创建点用 `with_envs` 填充。SSH/JumpServer executor 不涉及。
    pub envs: Vec<(String, String)>,
}

impl LocalShellExecutor {
    pub fn new(shell: String, cwd: String, cols: u16, rows: u16) -> Self {
        Self {
            shell,
            cwd,
            cols,
            rows,
            envs: Vec::new(),
        }
    }

    /// 注入额外环境变量(agent 镜像 hook env)。builder 风格,返回 self 便于链式调用。
    pub fn with_envs(mut self, envs: Vec<(String, String)>) -> Self {
        self.envs = envs;
        self
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
                &self.envs,
            )?;
            Ok(Box::new(term))
        }

        #[cfg(windows)]
        {
            // Check if shell is a WSL distribution
            let shell_lower = self.shell.to_lowercase();
            if shell_lower.contains("wsl")
                || shell_lower.ends_with(".exe") && shell_lower.contains("wsl")
            {
                // WSL: use Python PTY helper
                let term = crate::server::terminal::pty_wsl::WslPtyTerminal::new(
                    &self.shell, // distro name or "wsl"
                    "",          // default shell inside WSL
                    &self.cwd,
                    self.cols,
                    self.rows,
                    &self.envs,
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
                    &self.envs,
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
