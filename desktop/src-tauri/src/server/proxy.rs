//! TCP proxy + PROXY Protocol v1 — mirrors sidecar.rs LAN proxy logic.
//!
//! When LAN sharing is enabled, a TCP proxy listens on 0.0.0.0:{lan_port}
//! and forwards connections to 127.0.0.1:{server_port}, injecting a
//! PROXY Protocol v1 header so the server knows the real client IP.
//!
//! Format: `PROXY TCP4 <src_ip> <dst_ip> <src_port> <dst_port>\r\n`

use std::net::TcpListener;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener as AsyncTcpListener;
use tokio_util::sync::CancellationToken;

/// Allocate a random free port on all interfaces.
pub fn allocate_lan_port() -> Result<u16, String> {
    let listener = TcpListener::bind("0.0.0.0:0")
        .map_err(|e| format!("LAN port allocation failed: {}", e))?;
    listener.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

/// Run the TCP proxy. Forwards connections from `listen_addr` to `forward_addr`,
/// injecting a PROXY Protocol v1 header.
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
                    Ok((client_stream, client_addr)) => {
                        let forward = forward_addr.clone();
                        tokio::spawn(async move {
                            if let Err(e) = proxy_connection(client_stream, client_addr, &forward).await {
                                eprintln!("[meterm-proxy] connection error: {}", e);
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

async fn proxy_connection(
    mut client: tokio::net::TcpStream,
    client_addr: std::net::SocketAddr,
    forward_addr: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut upstream = tokio::net::TcpStream::connect(forward_addr).await?;
    let forward_parsed: std::net::SocketAddr = forward_addr.parse()?;

    // Inject PROXY Protocol v1 header
    let proto = if client_addr.is_ipv4() { "TCP4" } else { "TCP6" };
    let proxy_header = format!(
        "PROXY {} {} {} {} {}\r\n",
        proto,
        client_addr.ip(),
        forward_parsed.ip(),
        client_addr.port(),
        forward_parsed.port(),
    );
    upstream.write_all(proxy_header.as_bytes()).await?;

    // Bidirectional copy
    tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
    Ok(())
}
