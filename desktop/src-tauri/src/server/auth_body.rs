//! Request-body security wrappers shared by authenticated HTTP routes.

use std::fmt;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::{Body, BodyDataStream, Bytes};
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;
use futures_util::Stream;

use super::auth::{AuthPrincipal, Authenticator};

/// Maximum idle interval between request-body frames. This is deliberately an
/// idle timeout rather than a total timeout so legitimate large uploads can
/// continue while making progress.
pub(crate) const REQUEST_BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
struct CredentialRevoked;

impl fmt::Display for CredentialRevoked {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("credential revoked while request body was in flight")
    }
}

impl std::error::Error for CredentialRevoked {}

/// A stream that revalidates the exact process-local credential generation
/// before every attempt to read another request-body frame. Rotation or
/// revocation therefore terminates pre-opened slow JSON and upload requests.
struct RevocationAwareStream {
    inner: BodyDataStream,
    authenticator: Arc<Authenticator>,
    principal: AuthPrincipal,
    terminated: bool,
}

impl Stream for RevocationAwareStream {
    type Item = Result<Bytes, axum::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.terminated {
            return Poll::Ready(None);
        }
        if !self.authenticator.is_principal_current(&self.principal) {
            self.terminated = true;
            return Poll::Ready(Some(Err(axum::Error::new(CredentialRevoked))));
        }
        Pin::new(&mut self.inner).poll_next(cx)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        self.inner.size_hint()
    }
}

pub(crate) fn revocation_aware(
    body: Body,
    authenticator: Arc<Authenticator>,
    principal: AuthPrincipal,
) -> Body {
    Body::from_stream(RevocationAwareStream {
        inner: body.into_data_stream(),
        authenticator,
        principal,
        terminated: false,
    })
}

fn with_idle_timeout(body: Body, timeout: Duration) -> Body {
    Body::new(tower_http::timeout::TimeoutBody::new(timeout, body))
}

/// Apply tower-http's per-frame timeout while preserving axum's concrete Body
/// type for all inner route middleware and extractors. WebSocket upgrades do
/// not poll their empty HTTP request body, so the upgrade path is unaffected.
pub(crate) async fn idle_timeout_middleware(mut request: Request, next: Next) -> Response {
    let body = std::mem::take(request.body_mut());
    *request.body_mut() = with_idle_timeout(body, REQUEST_BODY_IDLE_TIMEOUT);
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use axum::extract::Json;
    use axum::http::{header, HeaderValue, StatusCode};
    use axum::middleware;
    use axum::routing::post;
    use axum::Router;
    use futures_util::stream;
    use tokio::sync::oneshot;
    use tower::ServiceExt;

    use super::*;
    use crate::server::auth::{auth_middleware, TrustedIngress};

    #[test]
    fn request_body_idle_timeout_is_thirty_seconds() {
        assert_eq!(REQUEST_BODY_IDLE_TIMEOUT, Duration::from_secs(30));
    }

    #[tokio::test]
    async fn idle_timeout_returns_a_body_error() {
        let body = Body::from_stream(stream::pending::<Result<Bytes, std::io::Error>>());
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            axum::body::to_bytes(with_idle_timeout(body, Duration::from_millis(10)), 1),
        )
        .await
        .expect("test timeout wrapper should wake")
        .expect_err("an idle request body must fail");
        assert!(result.to_string().contains("data was not received"));
    }

    #[tokio::test]
    async fn preopened_old_generation_body_is_rejected_after_rotation() {
        let authenticator = Arc::new(Authenticator::new("O".repeat(32)));
        let old_token = authenticator
            .issue_device_token("device-a", "Old Phone")
            .unwrap();
        let executed = Arc::new(AtomicBool::new(false));
        let handler_executed = executed.clone();

        let auth_for_layer = authenticator.clone();
        let app = Router::new()
            .route(
                "/mutate",
                post(move |Json(_): Json<serde_json::Value>| {
                    let executed = handler_executed.clone();
                    async move {
                        executed.store(true, Ordering::SeqCst);
                        StatusCode::NO_CONTENT
                    }
                }),
            )
            .layer(middleware::from_fn(move |request, next| {
                let authenticator = auth_for_layer.clone();
                async move {
                    auth_middleware(axum::extract::Extension(authenticator), request, next).await
                }
            }));

        let (polled_tx, polled_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let body = Body::from_stream(stream::once(async move {
            let _ = polled_tx.send(());
            let _ = release_rx.await;
            Ok::<_, std::io::Error>(Bytes::from_static(br#"{"ok":true}"#))
        }));
        let mut request = Request::post("/mutate").body(body).unwrap();
        request
            .extensions_mut()
            .insert(TrustedIngress::DirectLoopback);
        request.headers_mut().insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {old_token}")).unwrap(),
        );
        request.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );

        let response_task = tokio::spawn(app.oneshot(request));
        tokio::time::timeout(Duration::from_secs(2), polled_rx)
            .await
            .expect("body should reach its initial pending poll")
            .expect("poll signal should remain open");

        authenticator
            .issue_device_token("device-a", "Repaired Phone")
            .unwrap();
        let _ = release_tx.send(());

        let response = tokio::time::timeout(Duration::from_secs(2), response_task)
            .await
            .expect("stale body should fail promptly")
            .expect("router task should not panic")
            .unwrap();
        assert!(response.status().is_client_error());
        assert!(!executed.load(Ordering::SeqCst));
    }
}
