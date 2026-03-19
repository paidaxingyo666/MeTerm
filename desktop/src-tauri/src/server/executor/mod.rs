//! Executor abstraction — mirrors Go `executor/executor.go`.
//!
//! An executor creates a Terminal by starting a local shell or SSH connection.

pub mod local;
pub mod ssh;

use std::collections::HashMap;

use super::terminal::Terminal;

/// Information about an executor (for API responses).
#[derive(Debug, Clone, serde::Serialize)]
pub struct ExecutorInfo {
    /// "local-shell", "ssh", or "jumpserver"
    #[serde(rename = "type")]
    pub executor_type: String,
    /// Additional labels (shell, host, username, etc.)
    pub labels: HashMap<String, String>,
}

/// Trait for creating terminals.
#[async_trait::async_trait]
pub trait Executor: Send + Sync {
    /// Start the executor and return a Terminal.
    async fn start(&self) -> Result<Box<dyn Terminal>, String>;

    /// Stop the executor.
    async fn stop(&self) -> Result<(), String>;

    /// Return metadata about this executor.
    fn info(&self) -> ExecutorInfo;
}
