use super::client::{Client, ClientSecurityContext};
use super::{Session, TermCtrl};
use crate::server::auth::AuthPrincipal;
use crate::server::protocol;
use crate::server::session::state::{ClientRole, SessionState};
use std::sync::Arc;

/// Immutable authority snapshot for exactly one admitted inbound frame.
///
/// `client_id` is stable across reconnects, so dispatch must never resolve
/// authorization from it after the connection-generation check. Capturing the
/// role/master/owner facts while holding `clients` makes the frame linearize at
/// one point: an H0 viewer cannot borrow H1's later master role, while an H0
/// frame that was already accepted as master may finish normally.
#[derive(Clone)]
pub(crate) struct DispatchAuthority {
    client_id: String,
    conn_gen: u64,
    security: ClientSecurityContext,
    can_control: bool,
    is_owner: bool,
}

impl DispatchAuthority {
    pub(crate) fn client_id(&self) -> &str {
        &self.client_id
    }

    pub(crate) fn conn_gen(&self) -> u64 {
        self.conn_gen
    }

    pub(crate) fn security(&self) -> &ClientSecurityContext {
        &self.security
    }

    pub(crate) fn can_control(&self) -> bool {
        self.can_control
    }

    pub(crate) fn is_owner(&self) -> bool {
        self.is_owner
    }
}

/// Authenticated principal that created a session.
///
/// Device ownership is bound to the exact credential generation so rotating
/// or revoking a paired-device credential cannot inherit access to sessions
/// created by the retired credential.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SessionCreator {
    Owner,
    Device {
        device_id: String,
        generation: uuid::Uuid,
    },
}
impl From<&AuthPrincipal> for SessionCreator {
    fn from(principal: &AuthPrincipal) -> Self {
        match principal {
            AuthPrincipal::Owner { .. } => Self::Owner,
            AuthPrincipal::Device {
                device_id,
                generation,
                ..
            } => Self::Device {
                device_id: device_id.clone(),
                generation: *generation,
            },
        }
    }
}

impl SessionCreator {
    pub(crate) fn allows_principal(&self, principal: &AuthPrincipal) -> bool {
        match principal {
            AuthPrincipal::Owner { .. } => true,
            AuthPrincipal::Device {
                device_id,
                generation,
                ..
            } => self.allows_device(device_id, *generation),
        }
    }

    pub(crate) fn allows_device(&self, device_id: &str, generation: uuid::Uuid) -> bool {
        matches!(
            self,
            Self::Device {
                device_id: owner_id,
                generation: owner_generation,
            } if owner_id == device_id && *owner_generation == generation
        )
    }
}

impl Session {
    pub(crate) fn current_client_connection(
        &self,
        client_id: &str,
        expected_conn_gen: u64,
    ) -> Option<DispatchAuthority> {
        let clients = self.clients.lock().unwrap();
        if *self.state.lock().unwrap() == SessionState::Closed {
            return None;
        }
        let client = clients.get(client_id)?.clone();
        if !client.is_current_connection(expected_conn_gen) {
            return None;
        }
        let security = client.security_context();
        let can_control =
            client.role != ClientRole::ReadOnly && *self.master_id.lock().unwrap() == client_id;
        let is_owner = *self.owner_id.lock().unwrap() == client_id;
        Some(DispatchAuthority {
            client_id: client_id.to_string(),
            conn_gen: expected_conn_gen,
            security,
            can_control,
            is_owner,
        })
    }

    pub(crate) fn client_connection_generation(&self, client_id: &str) -> Option<u64> {
        let clients = self.clients.lock().unwrap();
        let client = clients.get(client_id)?;
        client.is_connected().then(|| client.conn_gen())
    }

    pub(crate) fn touch_client_generation(&self, client_id: &str, expected_conn_gen: u64) -> bool {
        let clients = self.clients.lock().unwrap();
        let Some(client) = clients.get(client_id) else {
            return false;
        };
        if !client.is_current_connection(expected_conn_gen) {
            return false;
        }
        client.touch();
        true
    }

    /// Enqueue terminal input using the immutable admission decision captured
    /// for this frame. Never resolve master status again from stable client_id.
    pub(crate) fn handle_authorized_input(
        &self,
        authority: &DispatchAuthority,
        data: &[u8],
    ) -> bool {
        if !authority.can_control() {
            self.send_to_client_generation(
                authority.client_id(),
                authority.conn_gen(),
                protocol::encode_error(protocol::ERR_NOT_MASTER, "not master"),
            );
            return false;
        }
        let data = data.to_vec();
        let input_tx = self.input_tx.clone();
        tokio::spawn(async move {
            let guard = input_tx.lock().await;
            if let Some(ref tx) = *guard {
                let _ = tx.send(data).await;
            }
        });
        true
    }

    /// Apply resize using the same one-frame admission snapshot as input.
    pub(crate) fn handle_authorized_resize(
        &self,
        authority: &DispatchAuthority,
        cols: u16,
        rows: u16,
    ) -> bool {
        if !authority.can_control() {
            return false;
        }
        *self.last_cols.lock().unwrap() = cols;
        *self.last_rows.lock().unwrap() = rows;
        let msg = protocol::encode_resize(cols, rows);
        let clients = self.clients.lock().unwrap();
        let current_master = self.master_id.lock().unwrap().clone();
        for client in clients.values() {
            if client.is_connected() && client.id != current_master {
                client.send(msg.clone());
            }
        }
        drop(clients);

        let resize_tx = self.resize_tx.clone();
        tokio::spawn(async move {
            let guard = resize_tx.lock().await;
            if let Some(ref tx) = *guard {
                let _ = tx.send(TermCtrl::Resize(cols, rows)).await;
            }
        });
        true
    }

    /// Promote only the exact authenticated, currently-connected WebSocket generation.
    ///
    /// The clients lock serializes this check with reconnect_client. An HTTP takeover that was
    /// issued by H0 therefore cannot arrive after H1 reuses the stable client ID and promote H1.
    pub(crate) fn set_master_for_connection(
        &self,
        client_id: &str,
        expected_conn_gen: u64,
        principal: &AuthPrincipal,
    ) -> Result<(), String> {
        let clients = self.clients.lock().unwrap();
        let client = clients
            .get(client_id)
            .ok_or_else(|| "client not found".to_string())?;
        if !client.matches_request_principal(principal) {
            return Err("client identity mismatch".to_string());
        }
        if !client.is_current_connection(expected_conn_gen) {
            return Err("stale client connection".to_string());
        }
        if client.role == ClientRole::ReadOnly {
            return Err("readonly client cannot become master".to_string());
        }

        let mut master = self.master_id.lock().unwrap();
        if *master == client_id {
            return Ok(());
        }
        if let Some(old) = clients.get(master.as_str()) {
            old.send(protocol::encode_role_change(ClientRole::Viewer as u8));
        }
        *master = client_id.to_string();
        client.send(protocol::encode_role_change(ClientRole::Master as u8));
        Ok(())
    }

    pub(crate) fn forward_master_request_for_connection(
        &self,
        requester_id: &str,
        expected_conn_gen: u64,
        principal: &AuthPrincipal,
    ) -> Result<(), String> {
        let clients = self.clients.lock().unwrap();
        let requester = clients
            .get(requester_id)
            .ok_or_else(|| "client not found".to_string())?;
        if !requester.matches_request_principal(principal) {
            return Err("client identity mismatch".to_string());
        }
        if !requester.is_current_connection(expected_conn_gen) {
            return Err("stale client connection".to_string());
        }
        if requester.role == ClientRole::ReadOnly {
            return Err("readonly client cannot request master".to_string());
        }
        let master_id = self.master_id.lock().unwrap().clone();
        let master = clients
            .get(&master_id)
            .filter(|client| client.is_connected())
            .ok_or_else(|| "master not connected".to_string())?;
        master.send(protocol::encode_master_request_notify(
            requester_id,
            &self.id,
            expected_conn_gen,
        ));
        Ok(())
    }

    pub(crate) fn forward_master_request_for_generation(
        &self,
        requester_id: &str,
        expected_conn_gen: u64,
    ) -> Result<(), String> {
        let clients = self.clients.lock().unwrap();
        let requester = clients
            .get(requester_id)
            .ok_or_else(|| "client not found".to_string())?;
        if !requester.is_current_connection(expected_conn_gen) {
            return Err("stale client connection".to_string());
        }
        if requester.role == ClientRole::ReadOnly {
            return Err("readonly client cannot request master".to_string());
        }
        let master_id = self.master_id.lock().unwrap().clone();
        let master = clients
            .get(&master_id)
            .filter(|client| client.is_connected())
            .ok_or_else(|| "master not connected".to_string())?;
        master.send(protocol::encode_master_request_notify(
            requester_id,
            &self.id,
            expected_conn_gen,
        ));
        Ok(())
    }

    /// Atomically release control from one exact connection generation.
    pub(crate) fn release_master_for_connection(
        &self,
        client_id: &str,
        expected_conn_gen: u64,
    ) -> bool {
        let clients = self.clients.lock().unwrap();
        let Some(source) = clients.get(client_id) else {
            return false;
        };
        if !source.is_current_connection(expected_conn_gen) || source.role == ClientRole::ReadOnly {
            return false;
        }

        let mut master = self.master_id.lock().unwrap();
        if *master != client_id {
            return false;
        }
        let eligible = |candidate: &&Arc<Client>| {
            candidate.id != client_id
                && candidate.is_connected()
                && candidate.role != ClientRole::ReadOnly
        };
        let candidate = clients
            .values()
            .filter(eligible)
            .find(|candidate| candidate.is_trusted_local_owner())
            .or_else(|| clients.values().find(eligible));
        let Some(next) = candidate else {
            return false;
        };

        source.send(protocol::encode_role_change(ClientRole::Viewer as u8));
        *master = next.id.clone();
        next.send(protocol::encode_role_change(ClientRole::Master as u8));
        true
    }

    /// Atomically reclaim control for the immutable session owner connection.
    pub(crate) fn reclaim_master_for_connection(
        &self,
        client_id: &str,
        expected_conn_gen: u64,
    ) -> bool {
        let clients = self.clients.lock().unwrap();
        let Some(source) = clients.get(client_id) else {
            return false;
        };
        if !source.is_current_connection(expected_conn_gen)
            || source.role == ClientRole::ReadOnly
            || *self.owner_id.lock().unwrap() != client_id
        {
            return false;
        }

        let mut master = self.master_id.lock().unwrap();
        if *master == client_id {
            return true;
        }
        if let Some(old) = clients.get(master.as_str()) {
            old.send(protocol::encode_role_change(ClientRole::Viewer as u8));
        }
        *master = client_id.to_string();
        source.send(protocol::encode_role_change(ClientRole::Master as u8));
        true
    }

    /// Apply one approval/rejection without any check-then-act master race.
    ///
    /// Both source and target are rebound to their exact live generations while
    /// holding `clients`; `master_id` is verified and changed under the same
    /// critical section. A demoted approver or reconnected requester can never
    /// overwrite a newer master.
    pub(crate) fn approve_master_for_connections(
        &self,
        approver_id: &str,
        approver_conn_gen: u64,
        approved: bool,
        requester_id: &str,
        requester_conn_gen: u64,
    ) -> bool {
        let clients = self.clients.lock().unwrap();
        let Some(approver) = clients.get(approver_id) else {
            return false;
        };
        if !approver.is_current_connection(approver_conn_gen)
            || approver.role == ClientRole::ReadOnly
        {
            return false;
        }

        let mut master = self.master_id.lock().unwrap();
        if *master != approver_id {
            return false;
        }

        let Some(requester) = clients.get(requester_id) else {
            return false;
        };
        if !requester.is_current_connection(requester_conn_gen) {
            return false;
        }

        let effective_approval = approved && requester.role != ClientRole::ReadOnly;
        if effective_approval && requester_id != approver_id {
            approver.send(protocol::encode_role_change(ClientRole::Viewer as u8));
            *master = requester_id.to_string();
            requester.send(protocol::encode_role_change(ClientRole::Master as u8));
        }
        requester.send(protocol::encode_master_approval(
            effective_approval,
            requester_id,
            requester_conn_gen,
        ));
        true
    }

    pub(crate) fn send_to_client_generation(
        &self,
        client_id: &str,
        expected_conn_gen: u64,
        data: Vec<u8>,
    ) -> bool {
        let clients = self.clients.lock().unwrap();
        let sent = clients
            .get(client_id)
            .filter(|client| client.is_current_connection(expected_conn_gen))
            .is_some_and(|client| client.send(data));
        if !sent {
            let mut master = self.master_id.lock().unwrap();
            Self::reconcile_master_locked(&clients, &mut master, false, true);
            drop(master);
            self.reconcile_state_locked(&clients);
        }
        sent
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(device_id: &str, generation: uuid::Uuid) -> AuthPrincipal {
        AuthPrincipal::Device {
            device_id: device_id.to_string(),
            device_name: "Phone".to_string(),
            generation,
        }
    }

    #[test]
    fn device_creator_requires_exact_id_and_generation() {
        let generation = uuid::Uuid::new_v4();
        let creator = SessionCreator::from(&device("device-a", generation));

        assert!(creator.allows_principal(&device("device-a", generation)));
        assert!(!creator.allows_principal(&device("device-a", uuid::Uuid::new_v4())));
        assert!(!creator.allows_principal(&device("device-b", generation)));
    }

    #[test]
    fn owner_is_an_administrative_superuser_but_owns_no_device_generation() {
        let owner = AuthPrincipal::Owner {
            generation: uuid::Uuid::new_v4(),
        };
        let creator = SessionCreator::from(&owner);

        assert!(creator.allows_principal(&owner));
        assert!(!creator.allows_device("device-a", uuid::Uuid::new_v4()));
    }
}
