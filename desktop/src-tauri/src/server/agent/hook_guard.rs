//! Header-only authorization for the local agent-hook route.
//!
//! This middleware must run before any body extractor so untrusted peers cannot
//! occupy server connections by slowly streaming even a size-bounded body.

use std::sync::Arc;

use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;

use crate::server::auth::TrustedIngress;
use crate::server::ServerState;

fn header<'a>(request: &'a Request, name: &str) -> &'a str {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
}

pub(crate) async fn authorize_before_body(
    state: Arc<ServerState>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if request.extensions().get::<TrustedIngress>() != Some(&TrustedIngress::DirectLoopback) {
        return Err(StatusCode::FORBIDDEN);
    }

    let session_id = header(&request, "x-meterm-session");
    let secret = header(&request, "x-meterm-secret");
    if session_id.is_empty() || !state.hook_secrets.verify(session_id, secret) {
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(next.run(request).await)
}
