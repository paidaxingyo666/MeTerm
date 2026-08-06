use std::sync::Arc;

use crate::server::session::Session;

pub(super) fn request(session: &Arc<Session>, client_id: &str, conn_gen: u64) {
    let _ = session.forward_master_request_for_generation(client_id, conn_gen);
}

pub(super) fn approval(session: &Arc<Session>, client_id: &str, conn_gen: u64, payload: &[u8]) {
    if payload.len() < 9 {
        return;
    }
    let approved = match payload[0] {
        0 => false,
        1 => true,
        _ => return,
    };
    let requester_conn_gen = u64::from_be_bytes(payload[1..9].try_into().expect("length checked"));
    if let Ok(requester_id) = std::str::from_utf8(&payload[9..]) {
        session.approve_master_for_connections(
            client_id,
            conn_gen,
            approved,
            requester_id,
            requester_conn_gen,
        );
    }
}
