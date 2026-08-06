//! Runtime authorization helpers for resources whose required device scope is
//! determined by the resource itself rather than only by the HTTP path.

use super::auth::{AuthPrincipal, Authenticator};
use super::device_auth::DeviceScope;
use super::events::DesktopEvent;
use super::session::Session;
use super::ServerState;

pub(crate) fn session_scope(session: &Session) -> DeviceScope {
    if session.executor_type.lock().unwrap().as_str() == "ssh" {
        DeviceScope::SshDesktopConnect
    } else {
        DeviceScope::DesktopControl
    }
}

pub(crate) fn can_access_session(
    authenticator: &Authenticator,
    principal: &AuthPrincipal,
    session: &Session,
) -> bool {
    if let AuthPrincipal::Device {
        device_id,
        generation,
        ..
    } = principal
    {
        return can_device_access_session(authenticator, device_id, *generation, session);
    }
    let scope = session_scope(session);
    if !authenticator.principal_has_scope(principal, scope) {
        return false;
    }
    scope != DeviceScope::SshDesktopConnect || session.creator_allows_principal(principal)
}

fn can_device_access_session(
    authenticator: &Authenticator,
    device_id: &str,
    generation: uuid::Uuid,
    session: &Session,
) -> bool {
    let scope = session_scope(session);
    authenticator.device_generation_has_scope(device_id, generation, scope)
        && (scope != DeviceScope::SshDesktopConnect
            || session.creator_allows_device(device_id, generation))
}

pub(crate) fn can_receive_event(
    state: &ServerState,
    principal: &AuthPrincipal,
    event: &DesktopEvent,
) -> bool {
    if matches!(principal, AuthPrincipal::Owner { .. }) {
        return true;
    }
    let session_id = match event {
        DesktopEvent::SessionsChanged => return true,
        DesktopEvent::Notify { session_id, .. }
        | DesktopEvent::CmdDone { session_id, .. }
        | DesktopEvent::AgentTurnDone { session_id, .. }
        | DesktopEvent::AgentNeedsApproval { session_id, .. } => session_id,
    };
    state
        .session_manager
        .get(session_id)
        .is_some_and(|session| can_access_session(&state.authenticator, principal, &session))
}

pub(crate) fn can_device_receive_event(
    state: &ServerState,
    device_id: &str,
    generation: uuid::Uuid,
    event: &DesktopEvent,
) -> bool {
    let session_id = match event {
        DesktopEvent::SessionsChanged => return true,
        DesktopEvent::Notify { session_id, .. }
        | DesktopEvent::CmdDone { session_id, .. }
        | DesktopEvent::AgentTurnDone { session_id, .. }
        | DesktopEvent::AgentNeedsApproval { session_id, .. } => session_id,
    };
    state
        .session_manager
        .get(session_id)
        .is_some_and(|session| {
            can_device_access_session(&state.authenticator, device_id, generation, &session)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{header, HeaderValue};
    use std::sync::Arc;

    fn device_principal(authenticator: &Authenticator, token: &str) -> AuthPrincipal {
        let mut request = Request::new(Body::empty());
        request.headers_mut().insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        authenticator.authenticate_request(&request).unwrap()
    }

    fn ssh_session_for(
        state: &ServerState,
        principal: &AuthPrincipal,
    ) -> Arc<crate::server::session::Session> {
        state.session_manager.create_for_principal(principal)
    }

    fn owner_principal(authenticator: &Authenticator) -> AuthPrincipal {
        AuthPrincipal::Owner {
            generation: authenticator.current_owner_generation(),
        }
    }

    fn device_identity(principal: &AuthPrincipal) -> (&str, uuid::Uuid) {
        let AuthPrincipal::Device {
            device_id,
            generation,
            ..
        } = principal
        else {
            panic!("expected device principal")
        };
        (device_id, *generation)
    }

    #[cfg(feature = "development-mobile-control")]
    #[tokio::test]
    async fn ssh_access_is_bound_to_exact_device_generation() {
        let state = Arc::new(crate::server::create_dummy_state());
        let first_token = state
            .authenticator
            .issue_device_token("device-1", "Phone")
            .unwrap();
        let first = device_principal(&state.authenticator, &first_token);
        let ssh = ssh_session_for(&state, &first);

        assert!(can_access_session(&state.authenticator, &first, &ssh));
        assert!(can_access_session(
            &state.authenticator,
            &owner_principal(&state.authenticator),
            &ssh
        ));

        let other_token = state
            .authenticator
            .issue_device_token("device-2", "Other phone")
            .unwrap();
        let other = device_principal(&state.authenticator, &other_token);
        assert!(!can_access_session(&state.authenticator, &other, &ssh));

        let rotated_token = state
            .authenticator
            .issue_device_token("device-1", "Phone")
            .unwrap();
        let rotated = device_principal(&state.authenticator, &rotated_token);
        assert!(!can_access_session(&state.authenticator, &first, &ssh));
        assert!(!can_access_session(&state.authenticator, &rotated, &ssh));

        let rotated_ssh = ssh_session_for(&state, &rotated);
        assert!(can_access_session(
            &state.authenticator,
            &rotated,
            &rotated_ssh
        ));
        state.authenticator.revoke_device("device-1").unwrap();
        assert!(!can_access_session(
            &state.authenticator,
            &rotated,
            &rotated_ssh
        ));
    }

    #[tokio::test]
    async fn session_access_respects_development_scope_and_ssh_creator_acl() {
        let state = Arc::new(crate::server::create_dummy_state());
        let token = state
            .authenticator
            .issue_device_token("device-1", "Phone")
            .unwrap();
        let principal = device_principal(&state.authenticator, &token);
        let owner = owner_principal(&state.authenticator);

        let local = state.session_manager.create();
        let ssh = state.session_manager.create();
        *ssh.executor_type.lock().unwrap() = "ssh".to_string();
        let agent = state.session_manager.create();
        *agent.executor_type.lock().unwrap() = "agent".to_string();

        assert_eq!(
            can_access_session(&state.authenticator, &principal, &local),
            cfg!(feature = "development-mobile-control")
        );
        assert!(!can_access_session(&state.authenticator, &principal, &ssh));
        assert_eq!(
            can_access_session(&state.authenticator, &principal, &agent),
            cfg!(feature = "development-mobile-control")
        );
        assert!(can_access_session(&state.authenticator, &owner, &local));
        assert!(can_access_session(&state.authenticator, &owner, &ssh));
        assert!(can_access_session(&state.authenticator, &owner, &agent));
    }

    #[cfg(feature = "development-mobile-control")]
    #[tokio::test]
    async fn event_delivery_requires_the_same_current_creator_generation() {
        let state = Arc::new(crate::server::create_dummy_state());
        let token = state
            .authenticator
            .issue_device_token("device-1", "Phone")
            .unwrap();
        let principal = device_principal(&state.authenticator, &token);
        let local = state.session_manager.create();
        let ssh = ssh_session_for(&state, &principal);

        let event = |session_id: &str| DesktopEvent::Notify {
            id: "event".to_string(),
            session_id: session_id.to_string(),
            session_title: "title".to_string(),
            title: "notice".to_string(),
            body: "body".to_string(),
        };
        assert!(can_receive_event(&state, &principal, &event(&local.id)));
        assert!(can_receive_event(&state, &principal, &event(&ssh.id)));
        let (device_id, generation) = device_identity(&principal);
        assert!(can_device_receive_event(
            &state,
            device_id,
            generation,
            &event(&ssh.id)
        ));

        let other_token = state
            .authenticator
            .issue_device_token("device-2", "Other phone")
            .unwrap();
        let other = device_principal(&state.authenticator, &other_token);
        let (other_id, other_generation) = device_identity(&other);
        assert!(!can_receive_event(&state, &other, &event(&ssh.id)));
        assert!(!can_device_receive_event(
            &state,
            other_id,
            other_generation,
            &event(&ssh.id)
        ));

        let rotated_token = state
            .authenticator
            .issue_device_token("device-1", "Phone")
            .unwrap();
        let rotated = device_principal(&state.authenticator, &rotated_token);
        let (rotated_id, rotated_generation) = device_identity(&rotated);
        assert!(!can_receive_event(&state, &principal, &event(&ssh.id)));
        assert!(!can_receive_event(&state, &rotated, &event(&ssh.id)));
        assert!(!can_device_receive_event(
            &state,
            device_id,
            generation,
            &event(&ssh.id)
        ));
        assert!(!can_device_receive_event(
            &state,
            rotated_id,
            rotated_generation,
            &event(&ssh.id)
        ));
    }
}
