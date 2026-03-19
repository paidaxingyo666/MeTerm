//! Session state machine — mirrors Go `session/state.go`.
//!
//! State transitions:
//! ```text
//! Created  → Running   (first client connects)
//! Running  → Draining  (last client disconnects)
//! Running  → Closed    (PTY exits / DELETE API)
//! Draining → Running   (reconnect before TTL)
//! Draining → Closed    (TTL expires)
//! ```

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    /// PTY exists but no clients have connected yet.
    Created,
    /// At least one client is connected.
    Running,
    /// All clients disconnected; buffering output until TTL or reconnect.
    Draining,
    /// Fully closed — resources released.
    Closed,
}

impl SessionState {
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionState::Created => "created",
            SessionState::Running => "running",
            SessionState::Draining => "draining",
            SessionState::Closed => "closed",
        }
    }
}

impl fmt::Display for SessionState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Client roles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ClientRole {
    Viewer = 0,
    Master = 1,
    ReadOnly = 2,
}

impl ClientRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            ClientRole::Viewer => "viewer",
            ClientRole::Master => "master",
            ClientRole::ReadOnly => "readonly",
        }
    }

    pub fn from_u8(v: u8) -> Self {
        match v {
            1 => ClientRole::Master,
            2 => ClientRole::ReadOnly,
            _ => ClientRole::Viewer,
        }
    }
}

impl fmt::Display for ClientRole {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}
