use std::sync::{Arc, TryLockError};
use std::time::{Duration, Instant};

use super::client::{Client, ClientSecurityContext};
use super::state::ClientRole;
use super::{Session, SessionConfig};
use crate::server::auth::{AuthPrincipal, Authenticator, TrustedIngress};
use crate::server::events::EventBus;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderValue};

fn test_session(id: &str) -> Arc<Session> {
    Arc::new(Session::new(
        id.to_string(),
        SessionConfig {
            session_ttl: Duration::from_secs(300),
            reconnect_grace: Duration::from_secs(60),
            ring_buffer_size: 4096,
            log_dir: String::new(),
        },
        EventBus::new(),
    ))
}

fn device_client(
    id: &str,
    security: ClientSecurityContext,
) -> (Arc<Client>, super::client::WsReceivers) {
    client_with_role(id, ClientRole::Viewer, security)
}

fn client_with_role(
    id: &str,
    role: ClientRole,
    security: ClientSecurityContext,
) -> (Arc<Client>, super::client::WsReceivers) {
    let (client, receivers) = Client::new(id.to_string(), "127.0.0.1".to_string(), role, security);
    (Arc::new(client), receivers)
}

fn generation_security(device_id: &str, generation: uuid::Uuid) -> ClientSecurityContext {
    ClientSecurityContext {
        ingress: TrustedIngress::Relay,
        principal: AuthPrincipal::Device {
            device_id: device_id.to_string(),
            device_name: "test phone".to_string(),
            generation,
        },
    }
}

fn ingress_security(device_id: &str, ingress: TrustedIngress) -> ClientSecurityContext {
    ClientSecurityContext {
        ingress,
        principal: AuthPrincipal::Device {
            device_id: device_id.to_string(),
            device_name: "test phone".to_string(),
            generation: uuid::Uuid::new_v4(),
        },
    }
}

fn owner_security(generation: uuid::Uuid) -> ClientSecurityContext {
    ClientSecurityContext {
        ingress: TrustedIngress::DirectLoopback,
        principal: AuthPrincipal::Owner { generation },
    }
}

fn authenticate(authenticator: &Authenticator, token: &str) -> AuthPrincipal {
    let mut request = Request::new(Body::empty());
    request.headers_mut().insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    authenticator.authenticate_request(&request).unwrap()
}

#[test]
fn close_disconnects_clients_and_permanently_rejects_new_dispatch_or_registration() {
    let session = test_session("closed-session");
    let security = ClientSecurityContext::test_device(TrustedIngress::Relay, "device-close");
    let (client, mut receivers) = device_client("phone", security.clone());
    session.add_client(client.clone()).unwrap();
    let conn_gen = client.conn_gen();
    let cancellation = session.cancellation_token();
    let (download_tx, _download_rx) = tokio::sync::mpsc::channel(4);
    let download = session
        .download_registry
        .register(
            super::downloads::DownloadOwner::ws("phone", conn_gen, 1),
            download_tx,
        )
        .unwrap();
    let download_cancellation = download.cancellation_token();
    let end_frame = crate::server::protocol::encode_session_end();

    assert!(session.close_with_frame(end_frame.clone()));
    assert!(session.is_closed());
    assert!(cancellation.is_cancelled());
    assert!(session.download_registry.is_closed());
    assert!(download_cancellation.is_cancelled());
    assert_eq!(
        session.download_registry.phase(&download),
        Some(super::downloads::DownloadPhase::Cancelling)
    );
    assert!(!client.is_connected());
    assert_eq!(receivers.priority_rx.try_recv().unwrap(), end_frame);
    assert!(session
        .current_client_connection("phone", conn_gen)
        .is_none());

    let (late_client, _late_receivers) = device_client("late", security.clone());
    assert_eq!(
        session.add_client(late_client).unwrap_err(),
        "session is closed"
    );
    assert_eq!(
        session
            .reconnect_client(
                "phone",
                "127.0.0.1".to_string(),
                security,
                Duration::from_secs(60),
            )
            .err()
            .unwrap(),
        "session is closed"
    );
    assert!(!session.close_with_frame(crate::server::protocol::encode_session_end()));
    session.download_registry.release(&download);
}

#[test]
fn ttl_close_is_atomic_with_connected_client_and_cannot_be_resurrected() {
    let session = Arc::new(Session::new(
        "ttl-close".to_string(),
        SessionConfig {
            session_ttl: Duration::from_millis(1),
            reconnect_grace: Duration::from_secs(60),
            ring_buffer_size: 4096,
            log_dir: String::new(),
        },
        EventBus::new(),
    ));
    let security = ClientSecurityContext::test_device(TrustedIngress::Relay, "device-ttl");
    let (client, _receivers) = device_client("phone", security.clone());
    session.add_client(client.clone()).unwrap();
    let conn_gen = client.conn_gen();

    *session.state.lock().unwrap() = super::state::SessionState::Draining;
    *session.drain_start.lock().unwrap() = Some(Instant::now() - Duration::from_secs(1));
    assert!(!session.try_close_by_ttl(Instant::now()));
    assert!(!session.is_closed());

    session.remove_client("phone", conn_gen);
    *session.drain_start.lock().unwrap() = Some(Instant::now() - Duration::from_secs(1));
    assert!(session.try_close_by_ttl(Instant::now()));
    assert!(session.is_closed());
    assert!(session.cancellation_token().is_cancelled());
    assert_eq!(
        session
            .reconnect_client(
                "phone",
                "127.0.0.1".to_string(),
                security,
                Duration::from_secs(60),
            )
            .err()
            .unwrap(),
        "session is closed"
    );
}

#[test]
fn failed_ipc_downstream_immediately_reconciles_session_state() {
    let session = test_session("dead-ipc");
    let channel = tauri::ipc::Channel::<Vec<u8>>::new(|_| {
        Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "test channel closed").into())
    });
    let client = Arc::new(super::client::Client::new_ipc(
        "ipc-client".to_string(),
        "ipc://local".to_string(),
        ClientRole::Viewer,
        channel,
    ));
    let conn_gen = client.conn_gen();
    session.add_client(client.clone()).unwrap();
    assert_eq!(session.state_string(), "running");
    assert_eq!(session.master(), "ipc-client");

    assert!(!session.send_to_client_generation(
        "ipc-client",
        conn_gen,
        crate::server::protocol::encode_pong(None),
    ));
    assert!(!client.is_connected());
    assert_eq!(session.state_string(), "draining");
    assert!(session
        .current_client_connection("ipc-client", conn_gen)
        .is_none());
}

#[test]
fn private_session_rejects_same_device_reconnect() {
    let session = test_session("private-reconnect");
    let security = ClientSecurityContext::test_device(TrustedIngress::Relay, "device-private-test");
    let (client, _receivers) = device_client("phone", security.clone());
    session.add_client(client.clone()).unwrap();

    assert_eq!(session.set_private(true), 1);
    assert!(!client.is_connected());
    assert!(matches!(
        session.reconnect_client(
            "phone",
            "127.0.0.1".to_string(),
            security,
            Duration::from_secs(60),
        ),
        Err(error) if error == "session is private"
    ));
    assert!(!client.is_connected());
}

#[test]
fn add_and_private_transition_cannot_leave_remote_client_connected() {
    let session = test_session("private-add-race");
    let security = ClientSecurityContext::test_device(TrustedIngress::Relay, "device-race-test");
    let (client, _receivers) = device_client("phone", security);

    // Block insertion on clients. With the required private -> clients lock
    // order, add_client then holds private while waiting here.
    let clients_guard = session.clients.lock().unwrap();
    let add_session = session.clone();
    let add_client = client.clone();
    let add = std::thread::spawn(move || add_session.add_client(add_client));

    let mut observed_private_guard = false;
    for _ in 0..10_000 {
        match session.private.try_lock() {
            Err(TryLockError::WouldBlock) => {
                observed_private_guard = true;
                break;
            }
            Err(TryLockError::Poisoned(_)) => panic!("private mutex poisoned"),
            Ok(guard) => drop(guard),
        }
        std::thread::yield_now();
    }
    assert!(
        observed_private_guard,
        "add_client must retain private guard while awaiting clients"
    );

    let private_session = session.clone();
    let transition = std::thread::spawn(move || private_session.set_private(true));
    drop(clients_guard);

    assert_eq!(add.join().unwrap(), Ok(()));
    assert_eq!(transition.join().unwrap(), 1);
    assert!(*session.private.lock().unwrap());
    assert!(!client.is_connected());
}

#[test]
fn generation_cleanup_spares_newly_repaired_session_client() {
    let session = test_session("generation-cleanup");
    let old_generation = uuid::Uuid::new_v4();
    let new_generation = uuid::Uuid::new_v4();
    let (old, _old_receivers) =
        device_client("old", generation_security("device-a", old_generation));
    let (new, _new_receivers) =
        device_client("new", generation_security("device-a", new_generation));
    session.add_client(old.clone()).unwrap();
    session.add_client(new.clone()).unwrap();

    assert_eq!(
        session.disconnect_device_generation("device-a", old_generation),
        1
    );
    assert!(!old.is_connected());
    assert!(new.is_connected());
}

#[test]
fn owner_generation_cleanup_spares_new_owner_device_and_local_ipc() {
    let session = test_session("owner-generation-cleanup");
    let old_generation = uuid::Uuid::new_v4();
    let new_generation = uuid::Uuid::new_v4();
    let (old, _old_receivers) = device_client("old-owner", owner_security(old_generation));
    let (new, _new_receivers) = device_client("new-owner", owner_security(new_generation));
    let (device, _device_receivers) = device_client(
        "device",
        generation_security("device-a", uuid::Uuid::new_v4()),
    );
    let (local_ipc, _ipc_receivers) =
        device_client("local-ipc", ClientSecurityContext::direct_loopback_owner());
    for client in [&old, &new, &device, &local_ipc] {
        session.add_client(client.clone()).unwrap();
    }

    assert_eq!(session.disconnect_owner_generation(old_generation), 1);
    assert!(!old.is_connected());
    assert!(new.is_connected());
    assert!(device.is_connected());
    assert!(local_ipc.is_connected());
}

#[test]
fn lan_shutdown_disconnects_only_direct_remote_clients() {
    let session = test_session("lan-ingress-cleanup");
    let (direct, _direct_receivers) = device_client(
        "direct",
        ingress_security("device-direct", TrustedIngress::DirectRemote),
    );
    let (relay, _relay_receivers) = device_client(
        "relay",
        ingress_security("device-relay", TrustedIngress::Relay),
    );
    let (local, _local_receivers) =
        device_client("local", ClientSecurityContext::direct_loopback_owner());
    for client in [&direct, &relay, &local] {
        session.add_client(client.clone()).unwrap();
    }

    assert_eq!(session.disconnect_ingress(TrustedIngress::DirectRemote), 1);
    assert!(!direct.is_connected());
    assert!(relay.is_connected());
    assert!(local.is_connected());
    assert_eq!(
        session.master(),
        "local",
        "forced teardown must atomically promote the trusted local owner"
    );
}

#[test]
fn later_client_promotion_does_not_rewrite_immutable_owner() {
    let session = test_session("immutable-owner");
    let (first, _) = device_client(
        "first",
        ingress_security("device-first", TrustedIngress::Relay),
    );
    session.add_client(first.clone()).unwrap();
    assert_eq!(session.master(), "first");
    assert_eq!(session.owner(), "first");

    session.remove_client("first", first.conn_gen());
    let (second, _) = device_client(
        "second",
        ingress_security("device-second", TrustedIngress::Relay),
    );
    session.add_client(second).unwrap();

    assert_eq!(session.master(), "second");
    assert_eq!(
        session.owner(),
        "first",
        "owner is first-master reclaim authority, not the latest promotion"
    );
}

#[test]
fn explicit_kick_clears_master_when_no_successor_exists() {
    let session = test_session("kick-clears-master");
    let (phone, _) = device_client(
        "phone",
        ingress_security("device-phone", TrustedIngress::Relay),
    );
    session.add_client(phone.clone()).unwrap();
    assert_eq!(session.master(), "phone");

    assert!(session.kick_client("phone").1);
    assert!(!phone.is_connected());
    assert!(
        session.master().is_empty(),
        "explicitly kicked stable IDs must not retain implicit master authority"
    );
    assert_eq!(session.state_string(), "draining");
}

#[test]
fn private_transition_promotes_remaining_local_owner() {
    let session = test_session("private-promotes-local");
    let (remote, _remote_receivers) = device_client(
        "remote",
        ingress_security("device-remote", TrustedIngress::Relay),
    );
    let (local, _local_receivers) =
        device_client("local", ClientSecurityContext::direct_loopback_owner());
    session.add_client(remote.clone()).unwrap();
    session.add_client(local.clone()).unwrap();
    assert_eq!(session.master(), "remote");

    assert_eq!(session.set_private(true), 1);
    assert!(!remote.is_connected());
    assert!(local.is_connected());
    assert_eq!(session.master(), "local");
}

#[test]
fn buffered_frame_security_recheck_rejects_retired_generations() {
    let owner_token = "A".repeat(32);
    let authenticator = Authenticator::new(owner_token.clone());
    let owner = ClientSecurityContext {
        ingress: TrustedIngress::DirectRemote,
        principal: authenticate(&authenticator, &owner_token),
    };
    let device_token = authenticator
        .issue_device_token("device-a", "Test Phone")
        .unwrap();
    let device = ClientSecurityContext {
        ingress: TrustedIngress::Relay,
        principal: authenticate(&authenticator, &device_token),
    };
    let local = ClientSecurityContext::direct_loopback_owner();
    assert!(owner.is_current(&authenticator));
    assert!(device.is_current(&authenticator));
    assert!(local.is_current(&authenticator));

    authenticator.set_token("B".repeat(32)).unwrap();
    authenticator
        .issue_device_token("device-a", "Repaired Phone")
        .unwrap();
    assert!(!owner.is_current(&authenticator));
    assert!(!device.is_current(&authenticator));
    assert!(local.is_current(&authenticator));
}

#[test]
fn takeover_requires_exact_connected_client_generation_and_principal() {
    let session = test_session("takeover-generation");
    let (owner, _owner_rx) = device_client("owner", ClientSecurityContext::direct_loopback_owner());
    session.add_client(owner).unwrap();

    let device_generation = uuid::Uuid::new_v4();
    let security = generation_security("device-a", device_generation);
    let principal = security.principal.clone();
    let (phone, _phone_rx) = device_client("phone", security.clone());
    session.add_client(phone.clone()).unwrap();
    let old_conn_gen = phone.conn_gen();

    let _replacement_rx = session
        .reconnect_client(
            "phone",
            "127.0.0.1".to_string(),
            security,
            Duration::from_secs(60),
        )
        .unwrap();
    let current_conn_gen = phone.conn_gen();
    assert_ne!(old_conn_gen, current_conn_gen);
    assert!(session
        .set_master_for_connection("phone", old_conn_gen, &principal)
        .is_err());
    assert_eq!(session.master(), "owner");

    let wrong_principal = AuthPrincipal::Device {
        device_id: "device-a".to_string(),
        device_name: "repaired phone".to_string(),
        generation: uuid::Uuid::new_v4(),
    };
    assert!(session
        .set_master_for_connection("phone", current_conn_gen, &wrong_principal)
        .is_err());
    assert_eq!(session.master(), "owner");

    session
        .set_master_for_connection("phone", current_conn_gen, &principal)
        .unwrap();
    assert_eq!(session.master(), "phone");
    session.remove_client("phone", current_conn_gen);
    assert_eq!(session.master(), "owner");
    assert!(session
        .set_master_for_connection("phone", current_conn_gen, &principal)
        .is_err());
    assert_eq!(session.master(), "owner");
}

#[test]
fn readonly_client_cannot_enter_any_master_path() {
    let session = test_session("readonly-master-paths");
    let (owner, _owner_rx) = device_client("owner", ClientSecurityContext::direct_loopback_owner());
    let owner_conn_gen = owner.conn_gen();
    session.add_client(owner).unwrap();

    let readonly_security = generation_security("readonly-device", uuid::Uuid::new_v4());
    let readonly_principal = readonly_security.principal.clone();
    let (readonly, _readonly_rx) =
        client_with_role("readonly", ClientRole::ReadOnly, readonly_security);
    let readonly_conn_gen = readonly.conn_gen();
    session.add_client(readonly).unwrap();

    assert_eq!(session.master(), "owner");
    assert!(session
        .set_master_for_connection("readonly", readonly_conn_gen, &readonly_principal)
        .is_err());
    assert!(session
        .forward_master_request_for_connection("readonly", readonly_conn_gen, &readonly_principal,)
        .is_err());
    assert!(session
        .forward_master_request_for_generation("readonly", readonly_conn_gen)
        .is_err());

    // A valid master may answer the request, but a readonly target must never
    // become master. The response is an effective rejection.
    assert!(session.approve_master_for_connections(
        "owner",
        owner_conn_gen,
        true,
        "readonly",
        readonly_conn_gen,
    ));
    assert_eq!(session.master(), "owner");

    // Readonly is also forbidden from acting as an approver.
    assert!(!session.approve_master_for_connections(
        "readonly",
        readonly_conn_gen,
        true,
        "owner",
        owner_conn_gen,
    ));
    assert_eq!(session.master(), "owner");
}

#[test]
fn dispatch_authority_snapshot_does_not_borrow_a_reconnected_clients_master_role() {
    let session = test_session("authority-snapshot");
    let (owner, _owner_rx) = device_client("owner", ClientSecurityContext::direct_loopback_owner());
    session.add_client(owner).unwrap();

    let viewer_security = generation_security("viewer-device", uuid::Uuid::new_v4());
    let viewer_principal = viewer_security.principal.clone();
    let (viewer, _viewer_rx) = device_client("viewer", viewer_security.clone());
    session.add_client(viewer.clone()).unwrap();
    let old_conn_gen = viewer.conn_gen();
    let authority = session
        .current_client_connection("viewer", old_conn_gen)
        .expect("viewer connection should be admitted");
    assert!(!authority.can_control());

    let _replacement_rx = session
        .reconnect_client(
            "viewer",
            "127.0.0.1".to_string(),
            viewer_security,
            Duration::from_secs(60),
        )
        .unwrap();
    let current_conn_gen = viewer.conn_gen();
    assert_ne!(old_conn_gen, current_conn_gen);
    session
        .set_master_for_connection("viewer", current_conn_gen, &viewer_principal)
        .unwrap();
    assert_eq!(session.master(), "viewer");
    assert!(session
        .current_client_connection("viewer", current_conn_gen)
        .expect("reconnected viewer should now be master")
        .can_control());

    assert_eq!(authority.client_id(), "viewer");
    assert_eq!(authority.conn_gen(), old_conn_gen);
    assert!(!authority.can_control());
}

#[test]
fn master_approval_cannot_promote_a_reconnected_requester() {
    let session = test_session("approval-generation");
    let security = ClientSecurityContext::direct_loopback_owner();
    let (owner, _owner_rx) = device_client("owner", security.clone());
    let (phone, _phone_rx) = device_client("phone", security.clone());
    let owner_conn_gen = owner.conn_gen();
    session.add_client(owner).unwrap();
    session.add_client(phone.clone()).unwrap();
    let old_conn_gen = phone.conn_gen();

    let _replacement_rx = session
        .reconnect_client(
            "phone",
            "127.0.0.1".to_string(),
            security,
            Duration::from_secs(60),
        )
        .unwrap();
    let current_conn_gen = phone.conn_gen();

    assert!(!session.approve_master_for_connections(
        "owner",
        owner_conn_gen,
        true,
        "phone",
        old_conn_gen,
    ));
    assert_eq!(session.master(), "owner");

    assert!(session.approve_master_for_connections(
        "owner",
        owner_conn_gen,
        true,
        "phone",
        current_conn_gen,
    ));
    assert_eq!(session.master(), "phone");
}

#[test]
fn approval_rejects_stale_or_demoted_approver_and_normal_release_still_works() {
    let session = test_session("approval-approver-generation");
    let owner_security = ClientSecurityContext::direct_loopback_owner();
    let (owner, _owner_rx) = device_client("owner", owner_security.clone());
    session.add_client(owner.clone()).unwrap();
    let stale_owner_conn_gen = owner.conn_gen();

    let delegate_security = generation_security("delegate-device", uuid::Uuid::new_v4());
    let delegate_principal = delegate_security.principal.clone();
    let (delegate, _delegate_rx) = device_client("delegate", delegate_security);
    session.add_client(delegate.clone()).unwrap();

    let phone_security = generation_security("phone-device", uuid::Uuid::new_v4());
    let (phone, _phone_rx) = device_client("phone", phone_security);
    session.add_client(phone.clone()).unwrap();

    let _replacement_rx = session
        .reconnect_client(
            "owner",
            "127.0.0.1".to_string(),
            owner_security,
            Duration::from_secs(60),
        )
        .unwrap();
    let owner_conn_gen = owner.conn_gen();
    assert_ne!(stale_owner_conn_gen, owner_conn_gen);

    assert!(!session.approve_master_for_connections(
        "owner",
        stale_owner_conn_gen,
        true,
        "phone",
        phone.conn_gen(),
    ));
    assert_eq!(session.master(), "owner");

    session
        .set_master_for_connection("delegate", delegate.conn_gen(), &delegate_principal)
        .unwrap();
    assert_eq!(session.master(), "delegate");

    assert!(!session.approve_master_for_connections(
        "owner",
        owner_conn_gen,
        true,
        "phone",
        phone.conn_gen(),
    ));
    assert_eq!(session.master(), "delegate");

    assert!(session.approve_master_for_connections(
        "delegate",
        delegate.conn_gen(),
        true,
        "phone",
        phone.conn_gen(),
    ));
    assert_eq!(session.master(), "phone");

    assert!(session.release_master_for_connection("phone", phone.conn_gen()));
    assert_eq!(session.master(), "owner");
}

#[test]
fn stale_release_and_reclaim_cannot_change_master() {
    let session = test_session("stale-release-reclaim");
    let owner_security = ClientSecurityContext::direct_loopback_owner();
    let owner_principal = owner_security.principal.clone();
    let (owner, _owner_rx) = device_client("owner", owner_security.clone());
    session.add_client(owner.clone()).unwrap();

    let phone_security = generation_security("phone-device", uuid::Uuid::new_v4());
    let phone_principal = phone_security.principal.clone();
    let (phone, _phone_rx) = device_client("phone", phone_security.clone());
    session.add_client(phone.clone()).unwrap();
    session
        .set_master_for_connection("phone", phone.conn_gen(), &phone_principal)
        .unwrap();
    assert_eq!(session.master(), "phone");

    let stale_phone_conn_gen = phone.conn_gen();
    let _replacement_phone_rx = session
        .reconnect_client(
            "phone",
            "127.0.0.1".to_string(),
            phone_security,
            Duration::from_secs(60),
        )
        .unwrap();
    assert_ne!(stale_phone_conn_gen, phone.conn_gen());
    assert!(!session.release_master_for_connection("phone", stale_phone_conn_gen));
    assert_eq!(session.master(), "phone");

    let stale_owner_conn_gen = owner.conn_gen();
    let _replacement_owner_rx = session
        .reconnect_client(
            "owner",
            "127.0.0.1".to_string(),
            owner_security,
            Duration::from_secs(60),
        )
        .unwrap();
    assert_ne!(stale_owner_conn_gen, owner.conn_gen());
    assert!(!session.reclaim_master_for_connection("owner", stale_owner_conn_gen));
    assert_eq!(session.master(), "phone");

    // Sanity-check the retained owner identity is still principal-compatible;
    // only the stale connection generation prevented reclaim.
    assert!(session
        .set_master_for_connection("owner", stale_owner_conn_gen, &owner_principal)
        .is_err());
    assert_eq!(session.master(), "phone");
}

#[test]
fn reaper_candidate_cannot_expire_a_reconnected_generation() {
    let session = test_session("reaper-generation");
    let owner_security = ClientSecurityContext::direct_loopback_owner();
    let (owner, _owner_rx) = device_client("owner", owner_security);
    session.add_client(owner).unwrap();

    let phone_security = generation_security("phone-device", uuid::Uuid::new_v4());
    let (phone, _phone_rx) = device_client("phone", phone_security.clone());
    session.add_client(phone.clone()).unwrap();
    let old_conn_gen = phone.conn_gen();
    session.remove_client("phone", old_conn_gen);

    let expired = session.expired_disconnected_clients(std::time::Instant::now(), Duration::ZERO);
    assert_eq!(expired, vec![("phone".to_string(), old_conn_gen)]);

    let _replacement_rx = session
        .reconnect_client(
            "phone",
            "127.0.0.1".to_string(),
            phone_security,
            Duration::from_secs(60),
        )
        .unwrap();
    assert_ne!(phone.conn_gen(), old_conn_gen);
    let master_before = session.master();

    assert!(!session.expire_client_for_generation("phone", old_conn_gen, Duration::ZERO));
    assert!(session
        .current_client_connection("phone", phone.conn_gen())
        .is_some());
    assert_eq!(session.master(), master_before);
}

#[test]
fn disconnect_master_transition_serializes_with_reconnect() {
    let session = test_session("disconnect-reconnect-serialization");
    let phone_security = generation_security("phone-device", uuid::Uuid::new_v4());
    let (phone, _phone_rx) = device_client("phone", phone_security.clone());
    let (desktop, _desktop_rx) =
        device_client("desktop", ClientSecurityContext::direct_loopback_owner());
    session.add_client(phone.clone()).unwrap();
    session.add_client(desktop).unwrap();
    let old_conn_gen = phone.conn_gen();

    // Hold master_id so remove_client reaches its transition point while
    // retaining clients. A concurrent reconnect must remain blocked until the
    // disconnect + promotion transaction commits.
    let master_guard = session.master_id.lock().unwrap();
    let remove_session = session.clone();
    let remove = std::thread::spawn(move || remove_session.remove_client("phone", old_conn_gen));
    while phone.is_connected() {
        std::thread::yield_now();
    }

    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let reconnect_session = session.clone();
    let reconnect = std::thread::spawn(move || {
        let result = reconnect_session.reconnect_client(
            "phone",
            "127.0.0.1".to_string(),
            phone_security,
            Duration::from_secs(60),
        );
        done_tx.send(result.is_ok()).unwrap();
    });
    assert!(
        done_rx.recv_timeout(Duration::from_millis(50)).is_err(),
        "reconnect must wait for the exact-generation master transition"
    );

    drop(master_guard);
    assert_eq!(remove.join().unwrap(), 1);
    assert!(done_rx.recv_timeout(Duration::from_secs(2)).unwrap());
    reconnect.join().unwrap();
    assert!(phone.is_connected());
    assert_ne!(phone.conn_gen(), old_conn_gen);
    assert_eq!(session.master(), "desktop");
}

#[tokio::test]
async fn stale_websocket_generation_cannot_dispatch_master_release() {
    let state = crate::server::create_dummy_state();
    let session = test_session("dispatch-generation");
    let security = ClientSecurityContext::direct_loopback_owner();
    let (phone, _phone_rx) = device_client("phone", security.clone());
    let (desktop, _desktop_rx) = device_client("desktop", security.clone());
    session.add_client(phone.clone()).unwrap();
    session.add_client(desktop).unwrap();
    assert_eq!(session.master(), "phone");
    let old_conn_gen = phone.conn_gen();

    let _replacement_rx = session
        .reconnect_client(
            "phone",
            "127.0.0.1".to_string(),
            security,
            Duration::from_secs(60),
        )
        .unwrap();
    let current_conn_gen = phone.conn_gen();
    super::super::dispatch::dispatch_message(
        &session,
        "phone",
        old_conn_gen,
        crate::server::protocol::MSG_MASTER_RELEASE,
        &[],
        &state,
    )
    .await;
    assert_eq!(session.master(), "phone");

    super::super::dispatch::dispatch_message(
        &session,
        "phone",
        current_conn_gen,
        crate::server::protocol::MSG_MASTER_RELEASE,
        &[],
        &state,
    )
    .await;
    assert_eq!(session.master(), "desktop");
}
