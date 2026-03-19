//! SSH executor — full implementation using russh SshTerminal.

use std::collections::HashMap;

use super::{Executor, ExecutorInfo};
use crate::server::terminal::ssh::{SshConfig, SshTerminal};
use crate::server::terminal::Terminal;

/// SSH executor.
pub struct SshExecutor {
    pub config: SshConfig,
    pub cols: u16,
    pub rows: u16,
}

impl SshExecutor {
    pub fn new(config: SshConfig, cols: u16, rows: u16) -> Self {
        Self { config, cols, rows }
    }
}

impl SshExecutor {
    /// Start and return both the terminal and SFTP client.
    pub async fn start_with_sftp(&self) -> Result<(SshTerminal, Option<std::sync::Arc<russh_sftp::client::SftpSession>>), String> {
        let term = SshTerminal::connect(&self.config, self.cols, self.rows).await?;
        let sftp = term.sftp.clone();
        Ok((term, sftp))
    }
}

#[async_trait::async_trait]
impl Executor for SshExecutor {
    async fn start(&self) -> Result<Box<dyn Terminal>, String> {
        let term = SshTerminal::connect(&self.config, self.cols, self.rows).await?;
        Ok(Box::new(term))
    }

    async fn stop(&self) -> Result<(), String> {
        Ok(())
    }

    fn info(&self) -> ExecutorInfo {
        let mut labels = HashMap::new();
        labels.insert("host".to_string(), self.config.host.clone());
        labels.insert("port".to_string(), self.config.port.to_string());
        labels.insert("username".to_string(), self.config.username.clone());
        ExecutorInfo {
            executor_type: "ssh".to_string(),
            labels,
        }
    }
}
