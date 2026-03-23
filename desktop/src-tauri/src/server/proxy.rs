//! TCP proxy — forwards LAN connections to the local server.
//!
//! When LAN sharing is enabled, a TCP proxy listens on 0.0.0.0:{lan_port}
//! and forwards connections to 127.0.0.1:{server_port}.
//!
//! Note: PROXY Protocol v1 was removed because axum doesn't parse it,
//! causing all HTTP/WS requests through the proxy to fail with 400.
//! Client IP is logged at the proxy level instead.

use std::net::TcpListener;
use tokio::net::TcpListener as AsyncTcpListener;
use tokio_util::sync::CancellationToken;

/// Allocate a random free port on all interfaces.
pub fn allocate_lan_port() -> Result<u16, String> {
    let listener = TcpListener::bind("0.0.0.0:0")
        .map_err(|e| format!("LAN port allocation failed: {}", e))?;
    listener.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

/// Run the TCP proxy. Forwards connections from `listen_addr` to `forward_addr`.
///
/// Returns when the cancellation token is triggered.
pub async fn run_tcp_proxy(listen_addr: String, forward_addr: String, cancel: CancellationToken) {
    let listener = match AsyncTcpListener::bind(&listen_addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[meterm-proxy] failed to bind {}: {}", listen_addr, e);
            return;
        }
    };

    eprintln!("[meterm-proxy] listening on {} → {}", listen_addr, forward_addr);

    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                eprintln!("[meterm-proxy] stopped");
                break;
            }
            result = listener.accept() => {
                match result {
                    Ok((mut client_stream, client_addr)) => {
                        let forward = forward_addr.clone();
                        tokio::spawn(async move {
                            match tokio::net::TcpStream::connect(&forward).await {
                                Ok(mut upstream) => {
                                    if let Err(e) = tokio::io::copy_bidirectional(&mut client_stream, &mut upstream).await {
                                        eprintln!("[meterm-proxy] connection error from {}: {}", client_addr, e);
                                    }
                                }
                                Err(e) => {
                                    eprintln!("[meterm-proxy] upstream connect failed: {}", e);
                                }
                            }
                        });
                    }
                    Err(e) => {
                        eprintln!("[meterm-proxy] accept error: {}", e);
                    }
                }
            }
        }
    }
}
