//! Connection acceptor helpers and trusted-ingress metadata injection.

use axum::Router;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;

use super::auth::{ConnectionOrigin, TransportSecurity, TrustedIngress};

const PRE_AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ACTIVE_CONNECTIONS: usize = 512;

pub(super) fn connection_slots() -> Arc<Semaphore> {
    Arc::new(Semaphore::new(MAX_ACTIVE_CONNECTIONS))
}

/// Whether an accept error is transient and may be retried after a short delay.
pub(super) fn is_transient_accept_error(error: &std::io::Error) -> bool {
    use std::io::ErrorKind::*;
    matches!(
        error.kind(),
        ConnectionAborted | ConnectionReset | Interrupted | WouldBlock
    )
}

/// Peek the first byte, select TLS or plaintext HTTP, and inject metadata that
/// is derived solely from this trusted acceptor rather than request headers.
pub(super) async fn serve_connection(
    stream: tokio::net::TcpStream,
    peer: std::net::SocketAddr,
    app: Router,
    tls: Option<tokio_rustls::TlsAcceptor>,
) {
    use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
    use hyper_util::server::conn::auto::Builder;
    use hyper_util::service::TowerToHyperService;
    use tower::Layer;

    let mut first = [0u8; 1];
    let peek = match tokio::time::timeout(PRE_AUTH_TIMEOUT, stream.peek(&mut first)).await {
        Ok(result) => result,
        Err(_) => return,
    };
    match peek {
        Ok(0) => return,
        Ok(_) => {}
        Err(error) => {
            eprintln!("[meterm-server] peek {peer} failed: {error}");
            return;
        }
    }

    if first[0] == 0x16 {
        let Some(acceptor) = tls else {
            eprintln!("[meterm-server] {peer} sent TLS without an acceptor; dropping");
            return;
        };
        serve_tls_stream(stream, acceptor, app, peer, ConnectionOrigin::Direct).await;
        return;
    }

    let ingress = TrustedIngress::from_connection(ConnectionOrigin::Direct, peer);
    let tower_service = axum::Extension(axum::extract::ConnectInfo(peer)).layer(
        axum::Extension(ConnectionOrigin::Direct).layer(
            axum::Extension(ingress)
                .layer(axum::Extension(TransportSecurity::Plaintext).layer(app)),
        ),
    );
    let service = TowerToHyperService::new(tower_service);
    let mut builder = Builder::new(TokioExecutor::new());
    builder
        .http1()
        .timer(TokioTimer::new())
        .header_read_timeout(PRE_AUTH_TIMEOUT);
    if let Err(error) = builder
        .serve_connection_with_upgrades(TokioIo::new(stream), service)
        .await
    {
        eprintln!("[meterm-server] plain conn {peer} ended: {error}");
    }
}

/// Accept TLS on a direct socket or relay yamux substream and inject the
/// acceptor-derived ingress marker before serving the shared axum router.
pub(super) async fn serve_tls_stream<S>(
    stream: S,
    acceptor: tokio_rustls::TlsAcceptor,
    app: Router,
    peer: std::net::SocketAddr,
    origin: ConnectionOrigin,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
    use hyper_util::server::conn::auto::Builder;
    use hyper_util::service::TowerToHyperService;
    use tower::Layer;

    let ingress = TrustedIngress::from_connection(origin, peer);
    let tower_service =
        axum::Extension(axum::extract::ConnectInfo(peer)).layer(axum::Extension(origin).layer(
            axum::Extension(ingress).layer(axum::Extension(TransportSecurity::Tls).layer(app)),
        ));
    let service = TowerToHyperService::new(tower_service);

    match tokio::time::timeout(PRE_AUTH_TIMEOUT, acceptor.accept(stream)).await {
        Ok(Ok(tls_stream)) => {
            let mut builder = Builder::new(TokioExecutor::new());
            builder
                .http1()
                .timer(TokioTimer::new())
                .header_read_timeout(PRE_AUTH_TIMEOUT);
            if let Err(error) = builder
                .serve_connection_with_upgrades(TokioIo::new(tls_stream), service)
                .await
            {
                eprintln!("[meterm-server] TLS conn {peer} ended: {error}");
            }
        }
        Ok(Err(error)) => eprintln!("[meterm-server] TLS handshake {peer} failed: {error}"),
        Err(_) => eprintln!("[meterm-server] TLS handshake {peer} timed out"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pre_auth_time_and_connection_limits_are_bounded() {
        assert_eq!(PRE_AUTH_TIMEOUT, Duration::from_secs(10));
        let slots = connection_slots();
        let permits: Vec<_> = (0..MAX_ACTIVE_CONNECTIONS)
            .map(|_| slots.clone().try_acquire_owned().unwrap())
            .collect();
        assert!(slots.clone().try_acquire_owned().is_err());
        drop(permits);
        assert_eq!(slots.available_permits(), MAX_ACTIVE_CONNECTIONS);
    }
}
