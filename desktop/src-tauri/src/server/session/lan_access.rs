//! Runtime teardown for one trusted ingress class.

use crate::server::auth::TrustedIngress;
use crate::server::protocol;

use super::Session;

impl Session {
    pub(crate) fn disconnect_ingress(&self, ingress: TrustedIngress) -> usize {
        let clients = self.clients.lock().unwrap();
        let mut count = 0;
        for client in clients.values() {
            if !client.is_connected() || client.security_context().ingress != ingress {
                continue;
            }
            client.send(protocol::encode_error(
                protocol::ERR_KICKED,
                "LAN access disabled",
            ));
            client.disconnect();
            count += 1;
        }
        let mut master = self.master_id.lock().unwrap();
        Self::reconcile_master_locked(&clients, &mut master, true, true);
        drop(master);
        self.reconcile_state_locked(&clients);
        count
    }
}
