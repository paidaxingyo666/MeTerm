//! TCP and proxy transports used by the SSH client.

use super::ssh::SshConfig;

const TCP_CONNECT_TIMEOUT_SECS: u64 = 8;

pub(super) async fn establish_connection(
    config: &SshConfig,
) -> Result<tokio::net::TcpStream, String> {
    let target = format!("{}:{}", config.host, config.port);
    let timeout = std::time::Duration::from_secs(TCP_CONNECT_TIMEOUT_SECS);
    let operation: std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<tokio::net::TcpStream, String>> + Send>,
    > = match config.proxy_type.as_str() {
        "socks5" => Box::pin(connect_via_socks5(config, &target)),
        "http" => Box::pin(connect_via_http_connect(config, &target)),
        _ => Box::pin(connect_direct(&target)),
    };

    match tokio::time::timeout(timeout, operation).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "connection timed out ({}s): host {} unreachable",
            TCP_CONNECT_TIMEOUT_SECS, target
        )),
    }
}

async fn connect_direct(target: &str) -> Result<tokio::net::TcpStream, String> {
    tokio::net::TcpStream::connect(target)
        .await
        .map_err(|error| format!("TCP connect {}: {}", target, error))
}

async fn connect_via_socks5(
    config: &SshConfig,
    target: &str,
) -> Result<tokio::net::TcpStream, String> {
    let proxy_addr = format!(
        "{}:{}",
        if config.proxy_host.is_empty() {
            "127.0.0.1"
        } else {
            &config.proxy_host
        },
        if config.proxy_port == 0 {
            1080
        } else {
            config.proxy_port
        },
    );
    let stream = if !config.proxy_username.is_empty() {
        tokio_socks::tcp::Socks5Stream::connect_with_password(
            proxy_addr.as_str(),
            target,
            &config.proxy_username,
            &config.proxy_password,
        )
        .await
        .map_err(|error| format!("SOCKS5 proxy {}: {}", proxy_addr, error))?
    } else {
        tokio_socks::tcp::Socks5Stream::connect(proxy_addr.as_str(), target)
            .await
            .map_err(|error| format!("SOCKS5 proxy {}: {}", proxy_addr, error))?
    };
    Ok(stream.into_inner())
}

async fn connect_via_http_connect(
    config: &SshConfig,
    target: &str,
) -> Result<tokio::net::TcpStream, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let proxy_addr = format!(
        "{}:{}",
        if config.proxy_host.is_empty() {
            "127.0.0.1"
        } else {
            &config.proxy_host
        },
        if config.proxy_port == 0 {
            8080
        } else {
            config.proxy_port
        },
    );
    let mut stream = tokio::net::TcpStream::connect(&proxy_addr)
        .await
        .map_err(|error| format!("HTTP proxy connect {}: {}", proxy_addr, error))?;
    let mut request = format!("CONNECT {} HTTP/1.1\r\nHost: {}\r\n", target, target);
    if !config.proxy_username.is_empty() {
        use base64::Engine;
        let credentials = format!("{}:{}", config.proxy_username, config.proxy_password);
        let encoded = base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes());
        request.push_str(&format!("Proxy-Authorization: Basic {}\r\n", encoded));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|error| format!("HTTP CONNECT send: {}", error))?;

    let mut response = [0u8; 1024];
    let length = stream
        .read(&mut response)
        .await
        .map_err(|error| format!("HTTP CONNECT read: {}", error))?;
    let response = String::from_utf8_lossy(&response[..length]);
    let first_line = response.lines().next().unwrap_or_default();
    if first_line.split_ascii_whitespace().nth(1) != Some("200") {
        return Err(format!("HTTP CONNECT failed: {}", first_line));
    }
    Ok(stream)
}
