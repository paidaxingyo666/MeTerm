//! 桌面中继隧道客户端(设计稿 §7.1 · 下游任务 B2)。
//!
//! 让手机从任意网络按 `device_id` 到达本机:桌面主动出站到中继服务端建一条持久 WSS,
//! 在这条 WS 上跑 **yamux(桌面为 accept 方,`Mode::Server`)**——中继是 dialer,它每收到一台
//! 手机接入就在这条 WS 上开一条新子流。桌面把**每条子流**喂进与 LAN 完全相同的
//! `serve_tls_stream`(TLS-accept → axum Router),因此手机↔桌面全程端到端 TLS,中继只是盲管。
//!
//! 关键点:
//! - 子流**始终是端到端 TLS**。普通连接以 TLS record `0x16` 开始；续期专用连接先发
//!   Relay 认证且绑定 route/grant 的有界 preface，再开始 TLS。裸 `0xF1` 永远不分流。
//! - 钉死中继自签证书:自定义 rustls `ServerCertVerifier` 只校验叶子证书 SHA256 == `cert_fp`,忽略系统 CA。
//! - 中继子流虽使用合成 loopback peer 适配 ConnectInfo,权限只看 acceptor 注入的
//!   `TrustedIngress::Relay`,绝不继承本机 loopback 权限。
//! - WS/yamux 出错 → 指数退避重连。

use std::future::poll_fn;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::{Buf, BytesMut};
use futures::io::{AsyncRead as FuturesRead, AsyncWrite as FuturesWrite};
use futures::{Sink, Stream};
use tauri::{State, WebviewWindow};
use tokio::io::{AsyncRead as TokioRead, AsyncReadExt, AsyncWrite as TokioWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{header, HeaderValue, Uri};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;
use tokio_util::compat::FuturesAsyncReadCompatExt;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::WebPkiSupportedAlgorithms;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, DigitallySignedStruct, Error as TlsError, SignatureScheme};

use tokio_rustls::TlsAcceptor;

pub(crate) use super::relay_credentials::load_relay_config;
pub use super::relay_credentials::RelayConfig;
use super::relay_credentials::{
    relay_config_path, save_relay_config, update_relay_config, updated_relay_config,
    validate_relay_config, validate_relay_endpoint, validate_secret,
};
use super::relay_renewal_preface::{classify_relay_stream, RelayStreamKind};
use crate::server::ServerState;

// ─────────────────────────────── 配置 + 持久化 ───────────────────────────────

const MAX_RELAY_STREAMS: usize = 64;
const RELAY_RECEIVE_WINDOW: usize = MAX_RELAY_STREAMS * 256 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

fn is_valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'@')
        })
}

fn yamux_config() -> yamux::Config {
    let mut config = yamux::Config::default();
    config
        .set_max_num_streams(MAX_RELAY_STREAMS)
        .set_max_connection_receive_window(Some(RELAY_RECEIVE_WINDOW))
        .set_split_send_size(64 * 1024)
        .set_read_after_close(false);
    config
}

fn short_id(value: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(value.as_bytes());
    digest[..6]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn build_register_request(
    config: &RelayConfig,
    device_id: &str,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, String> {
    if !is_valid_id(device_id) {
        return Err("device-id".to_string());
    }
    let full_url = format!(
        "{}/register?device_id={}",
        config.url.trim_end_matches('/'),
        urlencoding::encode(device_id),
    );
    let mut request = full_url
        .into_client_request()
        .map_err(|_| "request".to_string())?;
    let authorization = HeaderValue::from_str(&format!("Bearer {}", config.token))
        .map_err(|_| "authorization".to_string())?;
    request
        .headers_mut()
        .insert(header::AUTHORIZATION, authorization);
    Ok(request)
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct RelayPushEndpoint {
    pub base_url: String,
    pub token: String,
    pub cert_fp: String,
}

impl std::fmt::Debug for RelayPushEndpoint {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("RelayPushEndpoint(redacted)")
    }
}

/// 只读 getter:取离线推送需要的 HTTPS 基址、独立令牌和证书指纹。
///
/// 复用 `load_relay_config`(不新增持久化格式),仅当中继已启用且 URL、token、指纹均
/// 通过严格配置校验时才返回端点——否则视为"中继未配置",分发器应整体跳过推送
/// (离线手机收不到通知,但不影响 LAN/APP 内的既有行为)。
///
/// `RelayConfig.url` 是 WS 基址(`wss://host:port`),中继的 HTTP 推送端点与之同源,
/// 这里只允许 `wss://` → `https://`;实际 POST 复用同一 leaf fingerprint pin。
pub(crate) fn push_endpoint_config(state_dir: &str) -> Option<RelayPushEndpoint> {
    if state_dir.is_empty() {
        return None;
    }
    let cfg = load_relay_config(state_dir);
    if !cfg.enabled {
        return None;
    }
    let push_token = cfg
        .push_token
        .as_deref()
        .filter(|token| !token.is_empty())?;
    let http_base = to_https_base(&cfg.url)?;
    Some(RelayPushEndpoint {
        base_url: http_base,
        token: push_token.to_string(),
        cert_fp: cfg.cert_fp,
    })
}

/// 已验证的 `wss://` 基址转换成同源 `https://` 推送基址。
fn to_https_base(ws_url: &str) -> Option<String> {
    ws_url
        .strip_prefix("wss://")
        .map(|rest| format!("https://{rest}"))
}

fn build_push_request_head(
    authority: &str,
    desktop_id: &str,
    token: &str,
    body_len: usize,
) -> Result<Vec<u8>, String> {
    if authority.is_empty()
        || authority.bytes().any(|byte| byte == b'\r' || byte == b'\n')
        || !is_valid_id(desktop_id)
        || validate_secret(token).is_err()
    {
        return Err("configuration".to_string());
    }
    Ok(format!(
        "POST /push HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer {token}\r\nX-MeTerm-Desktop-ID: {desktop_id}\r\nContent-Type: application/json\r\nContent-Length: {body_len}\r\nConnection: close\r\n\r\n"
    )
    .into_bytes())
}

/// POST 推送密文时复用 WSS 的 leaf fingerprint pin;所有错误都映射为
/// 不含 URL/token/body 的阶段标识。
pub(crate) async fn post_pinned_push(
    endpoint: &RelayPushEndpoint,
    desktop_id: &str,
    body: &[u8],
) -> Result<u16, String> {
    tokio::time::timeout(
        CONNECT_TIMEOUT,
        post_pinned_push_inner(endpoint, desktop_id, body),
    )
    .await
    .map_err(|_| "timeout".to_string())?
}

async fn post_pinned_push_inner(
    endpoint: &RelayPushEndpoint,
    desktop_id: &str,
    body: &[u8],
) -> Result<u16, String> {
    let uri: Uri = endpoint
        .base_url
        .parse()
        .map_err(|_| "configuration".to_string())?;
    if uri.scheme_str() != Some("https")
        || uri.host().is_none_or(str::is_empty)
        || !matches!(uri.path(), "" | "/")
        || uri.query().is_some()
    {
        return Err("configuration".to_string());
    }
    let host = uri.host().ok_or_else(|| "configuration".to_string())?;
    let port = uri.port_u16().unwrap_or(443);
    let authority = uri
        .authority()
        .ok_or_else(|| "configuration".to_string())?
        .as_str();
    let head = build_push_request_head(authority, desktop_id, &endpoint.token, body.len())?;

    let tcp = TcpStream::connect((host, port))
        .await
        .map_err(|_| "tcp".to_string())?;
    let connector = TlsConnector::from(Arc::new(
        build_client_config(&endpoint.cert_fp).map_err(|_| "tls".to_string())?,
    ));
    let server_name = ServerName::try_from(host.to_string()).map_err(|_| "tls".to_string())?;
    let mut tls = connector
        .connect(server_name, tcp)
        .await
        .map_err(|_| "tls".to_string())?;
    tls.write_all(&head)
        .await
        .map_err(|_| "request".to_string())?;
    tls.write_all(body)
        .await
        .map_err(|_| "request".to_string())?;
    tls.flush().await.map_err(|_| "request".to_string())?;

    const MAX_RESPONSE_HEAD: usize = 16 * 1024;
    let mut response = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        if let Some(end) = response.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
            let head = std::str::from_utf8(&response[..end]).map_err(|_| "response".to_string())?;
            let status = head
                .lines()
                .next()
                .and_then(|line| line.split_ascii_whitespace().nth(1))
                .and_then(|value| value.parse::<u16>().ok())
                .filter(|status| (100..=599).contains(status))
                .ok_or_else(|| "response".to_string())?;
            return Ok(status);
        }
        if response.len() >= MAX_RESPONSE_HEAD {
            return Err("response".to_string());
        }
        let read = tls
            .read(&mut chunk)
            .await
            .map_err(|_| "response".to_string())?;
        if read == 0 {
            return Err("response".to_string());
        }
        response.extend_from_slice(&chunk[..read]);
    }
}

// ─────────────────────────────── Tauri 命令 ───────────────────────────────

/// Redacted configuration exposed to the settings WebView. Secret-bearing
/// `RelayConfig` is deliberately runtime-only and has no serialization path.
#[derive(serde::Serialize)]
pub struct RelayConfigView {
    pub url: String,
    pub cert_fp: String,
    pub enabled: bool,
    pub has_registration_token: bool,
    pub has_push_token: bool,
}

/// 读取当前中继配置。前端设置面板用。无 app 数据目录时返回默认值。
#[tauri::command]
pub async fn get_relay_config(
    window: WebviewWindow,
    state: State<'_, Arc<ServerState>>,
) -> Result<RelayConfigView, String> {
    require_relay_window(&window)?;
    let dir = state.config.log_dir.clone();
    let config = if dir.is_empty() {
        RelayConfig::default()
    } else {
        load_relay_config(&dir)
    };
    Ok(RelayConfigView {
        url: config.url,
        cert_fp: config.cert_fp,
        enabled: config.enabled,
        has_registration_token: !config.token.is_empty(),
        has_push_token: config.push_token.is_some_and(|token| !token.is_empty()),
    })
}

/// 写入中继配置并落盘。改动在**下次启动**生效(v1 不做在线重连,避免管理任务句柄的复杂度)。
#[tauri::command]
pub async fn set_relay_config(
    window: WebviewWindow,
    state: State<'_, Arc<ServerState>>,
    url: String,
    token: String,
    push_token: Option<String>,
    cert_fp: String,
    enabled: bool,
) -> Result<(), String> {
    require_relay_window(&window)?;
    let dir = state.config.log_dir.clone();
    if dir.is_empty() {
        return Err("no app data dir; relay config cannot be persisted".to_string());
    }
    update_relay_config(&dir, url, token, push_token, cert_fp, enabled)
}

fn require_relay_window(window: &WebviewWindow) -> Result<(), String> {
    let label = window.label();
    if label == "main" || label == "settings" || label.starts_with("window-") {
        Ok(())
    } else {
        Err("relay configuration is unavailable to this window".to_string())
    }
}

// ─────────────────────────────── 证书指纹钉死校验器 ───────────────────────────────

/// 自定义 rustls 服务端证书校验器:只认叶子证书 SHA256 == `expected_fp`(小写 hex),
/// **忽略系统 CA / 主机名 / 有效期**——中继是自签,靠指纹钉死信任。
/// 握手签名仍交给 ring 的算法校验(确保密文出自被钉死的那张证书的私钥)。
#[derive(Debug)]
struct FingerprintVerifier {
    expected_fp: String,
    supported: WebPkiSupportedAlgorithms,
}

impl FingerprintVerifier {
    fn new(expected_fp: &str) -> Self {
        let provider = rustls::crypto::ring::default_provider();
        Self {
            expected_fp: expected_fp.to_lowercase(),
            supported: provider.signature_verification_algorithms,
        }
    }
}

impl ServerCertVerifier for FingerprintVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        let got = sha256_hex(end_entity.as_ref());
        if got.eq_ignore_ascii_case(&self.expected_fp) {
            Ok(ServerCertVerified::assertion())
        } else {
            // 指纹不符:按证书应用层校验失败拒绝(不泄露期望值)。
            Err(TlsError::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.supported)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.supported)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.supported.supported_schemes()
    }
}

/// 证书 DER 的 SHA256 → 小写 hex(64 字符)。与 `server::tls` 的指纹算法一致。
fn sha256_hex(der: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(der);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(digest.len() * 2);
    for &b in digest.iter() {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// 用钉指纹的校验器装配 rustls `ClientConfig`(ring 后端,与项目其余部分一致)。
fn build_client_config(cert_fp: &str) -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = Arc::new(FingerprintVerifier::new(cert_fp));
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("tls protocol versions: {}", e))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    Ok(config)
}

// ─────────────────────────────── WS 二进制帧 <-> 字节流适配器 ───────────────────────────────
// 与 relay/src/ws_stream.rs 对称:只用 Binary 帧承载隧道字节;控制/文本帧不进字节流;
// 收到 Close 或流结束 = EOF。适配器不看内容,契合零知识盲管。

/// 把 [`WebSocketStream`] 适配成 futures-io 双工字节流(供 yamux 运行其上)。
struct WsByteStream<S> {
    ws: WebSocketStream<S>,
    /// 上一条 Binary 帧尚未被上层读走的残余。
    read_buf: BytesMut,
    /// 对端已关闭,后续读一律 EOF。
    closed: bool,
}

impl<S> WsByteStream<S> {
    fn new(ws: WebSocketStream<S>) -> Self {
        Self {
            ws,
            read_buf: BytesMut::new(),
            closed: false,
        }
    }
}

fn to_io<E: std::fmt::Display>(e: E) -> io::Error {
    io::Error::new(io::ErrorKind::Other, e.to_string())
}

impl<S> FuturesRead for WsByteStream<S>
where
    S: TokioRead + TokioWrite + Unpin,
{
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        loop {
            if !this.read_buf.is_empty() {
                if buf.is_empty() {
                    return Poll::Ready(Ok(0));
                }
                let n = std::cmp::min(buf.len(), this.read_buf.len());
                buf[..n].copy_from_slice(&this.read_buf[..n]);
                this.read_buf.advance(n);
                return Poll::Ready(Ok(n));
            }
            if this.closed {
                return Poll::Ready(Ok(0));
            }
            match Pin::new(&mut this.ws).poll_next(cx) {
                Poll::Ready(Some(Ok(msg))) => match msg {
                    Message::Binary(data) => {
                        if data.is_empty() {
                            continue;
                        }
                        this.read_buf.extend_from_slice(data.as_ref());
                    }
                    Message::Ping(_) | Message::Pong(_) | Message::Text(_) | Message::Frame(_) => {
                        continue;
                    }
                    Message::Close(_) => {
                        this.closed = true;
                        return Poll::Ready(Ok(0));
                    }
                },
                Poll::Ready(Some(Err(e))) => return Poll::Ready(Err(to_io(e))),
                Poll::Ready(None) => {
                    this.closed = true;
                    return Poll::Ready(Ok(0));
                }
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

impl<S> FuturesWrite for WsByteStream<S>
where
    S: TokioRead + TokioWrite + Unpin,
{
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        match Pin::new(&mut this.ws).poll_ready(cx) {
            Poll::Ready(Ok(())) => {
                let msg = Message::binary(buf.to_vec());
                match Pin::new(&mut this.ws).start_send(msg) {
                    Ok(()) => Poll::Ready(Ok(buf.len())),
                    Err(e) => Poll::Ready(Err(to_io(e))),
                }
            }
            Poll::Ready(Err(e)) => Poll::Ready(Err(to_io(e))),
            Poll::Pending => Poll::Pending,
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        Pin::new(&mut this.ws).poll_flush(cx).map_err(to_io)
    }

    fn poll_close(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        Pin::new(&mut this.ws).poll_close(cx).map_err(to_io)
    }
}

// ─────────────────────────────── 隧道主循环 ───────────────────────────────

/// 出站中继隧道:`enabled` 时循环(指数退避)建连并驱动 yamux(Server 模式)接子流。
/// `disabled` / 缺 url / 缺指纹 → 立即返回(no-op)。
pub async fn run_relay_tunnel(
    state: Arc<ServerState>,
    tls_acceptor: TlsAcceptor,
    config: RelayConfig,
) {
    if !config.enabled {
        eprintln!("[relay-client] disabled; not connecting");
        return;
    }
    if validate_relay_config(&config).is_err() {
        eprintln!("[relay-client] configuration rejected; not connecting");
        return;
    }

    let device_id = state.device_id().to_string();
    let mut backoff = Duration::from_secs(1);
    let max_backoff = Duration::from_secs(60);

    loop {
        match run_once(&state, &tls_acceptor, &config, &device_id).await {
            Ok(()) => {
                eprintln!("[relay-client] session ended (relay closed); reconnecting");
                // 连接曾成功建立,退避归位。
                backoff = Duration::from_secs(1);
            }
            Err(stage) => {
                eprintln!("[relay-client] session error stage={stage}; retry in {backoff:?}");
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = std::cmp::min(backoff.saturating_mul(2), max_backoff);
    }
}

/// 建一条 WSS 到中继并驱动 yamux(Server 模式)接子流,每条子流喂给 TLS Router。
/// 返回 `Ok(())` 表示会话正常结束(中继关闭),`Err` 表示建连/驱动出错(触发退避)。
async fn run_once(
    state: &Arc<ServerState>,
    tls_acceptor: &TlsAcceptor,
    config: &RelayConfig,
    device_id: &str,
) -> Result<(), String> {
    let ws = connect_ws(config, device_id).await?;
    eprintln!("[relay-client] registered device={}", short_id(device_id));

    let socket = WsByteStream::new(ws);
    // 桌面是 accept 方(中继 dial 子流)→ Mode::Server。
    let mut conn = yamux::Connection::new(socket, yamux_config(), yamux::Mode::Server);

    // 两个 Router 各建一次：普通路径保留完整 API；通过认证的续期 preface 只能进入最小恢复面。
    let app = super::build_router(state.clone());
    let renewal_app = super::build_relay_renewal_router(state.clone());
    let register_secret: Arc<str> = Arc::from(config.token.as_str());
    let expected_desktop_device_id: Arc<str> = Arc::from(device_id);

    // 持续 poll_next_inbound 驱动整条 yamux 连接(推进所有子流的收发),并把新入站子流交给处理任务。
    loop {
        match poll_fn(|cx| conn.poll_next_inbound(cx)).await {
            Some(Ok(substream)) => {
                let acceptor = tls_acceptor.clone();
                let app = app.clone();
                let renewal_app = renewal_app.clone();
                let register_secret = register_secret.clone();
                let expected_desktop_device_id = expected_desktop_device_id.clone();
                tokio::spawn(async move {
                    // 合成 loopback 只用于 ConnectInfo 兼容;acceptor 另行注入
                    // `TrustedIngress::Relay`,因此不会继承本机 owner/hook/private 权限。
                    // IP 封禁仍会把中继流量看成占位地址;设备撤销按 stable device_id 执行。
                    let peer = std::net::SocketAddr::from(([127, 0, 0, 1], 0));
                    // 子流是 futures-io，compat 成 tokio-io 后先按连接层标记分流。
                    let compat = substream.compat();
                    let Some((kind, stream)) = classify_relay_stream(
                        compat,
                        register_secret.as_bytes(),
                        &expected_desktop_device_id,
                    )
                    .await
                    else {
                        return;
                    };
                    let (selected_app, origin) = match kind {
                        RelayStreamKind::Full => (app, super::auth::ConnectionOrigin::Relay),
                        RelayStreamKind::Renewal(context) => (
                            renewal_app.layer(axum::Extension(context)),
                            super::auth::ConnectionOrigin::RelayRenewal,
                        ),
                    };
                    super::transport::serve_tls_stream(
                        stream,
                        acceptor,
                        selected_app,
                        peer,
                        origin,
                    )
                    .await;
                });
            }
            Some(Err(_)) => return Err("yamux".to_string()),
            None => return Ok(()),
        }
    }
}

/// TCP → 钉指纹 TLS → WS 升级。登记 secret 仅在 Authorization header。
async fn connect_ws(
    config: &RelayConfig,
    device_id: &str,
) -> Result<WebSocketStream<TlsStream<TcpStream>>, String> {
    validate_relay_config(config).map_err(|_| "configuration".to_string())?;
    if !is_valid_id(device_id) {
        return Err("device-id".to_string());
    }
    let uri = validate_relay_endpoint(&config.url, &config.cert_fp)
        .map_err(|_| "configuration".to_string())?;
    let host = uri
        .host()
        .ok_or_else(|| "configuration".to_string())?
        .to_string();
    let port = uri.port_u16().unwrap_or(443);

    let request = build_register_request(config, device_id)?;

    // TCP。
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|_| "tcp-timeout".to_string())?
        .map_err(|_| "tcp".to_string())?;

    // 钉指纹 TLS(忽略系统 CA)。
    let client_config = build_client_config(&config.cert_fp)?;
    let connector = TlsConnector::from(Arc::new(client_config));
    let server_name = ServerName::try_from(host.clone()).map_err(|_| "server-name".to_string())?;
    let tls = tokio::time::timeout(CONNECT_TIMEOUT, connector.connect(server_name, tcp))
        .await
        .map_err(|_| "tls-timeout".to_string())?
        .map_err(|_| "tls".to_string())?;

    // WS 握手(我们已挂好 TLS,故走 client_async 而非 connect_async)。
    let ws_config = WebSocketConfig::default()
        .read_buffer_size(32 * 1024)
        .write_buffer_size(64 * 1024)
        .max_write_buffer_size(2 * 1024 * 1024)
        .max_message_size(Some(1024 * 1024))
        .max_frame_size(Some(256 * 1024));
    let (ws, _resp) = tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::client_async_with_config(request, tls, Some(ws_config)),
    )
    .await
    .map_err(|_| "ws-timeout".to_string())?
    .map_err(|_| "ws".to_string())?;
    Ok(ws)
}

// ─────────────────────────────── 测试 ───────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const REGISTER_SECRET: &str =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const PUSH_SECRET: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const REPLACEMENT_REGISTER_SECRET: &str =
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const REPLACEMENT_PUSH_SECRET: &str =
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    fn valid_config() -> RelayConfig {
        RelayConfig {
            url: "wss://relay.example.com:8443".to_string(),
            token: REGISTER_SECRET.to_string(),
            push_token: Some(PUSH_SECRET.to_string()),
            cert_fp: "ab".repeat(32),
            enabled: true,
        }
    }

    /// 配置存/取往返:落盘后读回应完全一致。
    #[test]
    fn relay_config_save_load_roundtrip() {
        let dir =
            std::env::temp_dir().join(format!("meterm-relay-cfg-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state_dir = dir.to_string_lossy().to_string();

        // 默认:文件不存在 → 默认值(disabled)。
        let d = load_relay_config(&state_dir);
        assert!(!d.enabled, "default relay config must be disabled");
        assert!(d.url.is_empty());

        let cfg = valid_config();
        save_relay_config(&state_dir, &cfg).expect("save");
        let back = load_relay_config(&state_dir);
        assert_eq!(cfg, back, "relay config must round-trip through disk");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = relay_config_path(&state_dir);
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn relay_authority_change_is_atomic_and_never_inherits_secrets() {
        let previous = valid_config();

        // Redacted getter values retain secrets only for the exact same
        // authority; certificate fingerprint case is not an authority change.
        let same = updated_relay_config(
            previous.clone(),
            previous.url.clone(),
            String::new(),
            None,
            previous.cert_fp.to_uppercase(),
            false,
        );
        assert_eq!(same.token, REGISTER_SECRET);
        assert_eq!(same.push_token.as_deref(), Some(PUSH_SECRET));

        // A URL or pin change clears the candidate credential bundle. It cannot
        // become a valid enabled configuration until both replacements arrive.
        let changed_without_secrets = updated_relay_config(
            previous.clone(),
            "wss://attacker.example:8443".to_string(),
            String::new(),
            None,
            "cd".repeat(32),
            true,
        );
        assert!(changed_without_secrets.token.is_empty());
        assert!(changed_without_secrets.push_token.is_none());
        assert!(validate_relay_config(&changed_without_secrets).is_err());

        // Validation happens before the atomic write, so an incomplete change
        // leaves the complete old authority transaction untouched on disk.
        let dir = std::env::temp_dir().join(format!(
            "meterm-relay-authority-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let state_dir = dir.to_string_lossy().to_string();
        save_relay_config(&state_dir, &previous).unwrap();
        assert!(save_relay_config(&state_dir, &changed_without_secrets).is_err());
        assert_eq!(load_relay_config(&state_dir), previous);

        let replacement = updated_relay_config(
            previous,
            "wss://new-relay.example:8443".to_string(),
            REPLACEMENT_REGISTER_SECRET.to_string(),
            Some(REPLACEMENT_PUSH_SECRET.to_string()),
            "ef".repeat(32),
            true,
        );
        save_relay_config(&state_dir, &replacement).unwrap();
        let stored = load_relay_config(&state_dir);
        assert_eq!(stored, replacement);
        assert_eq!(stored.token, REPLACEMENT_REGISTER_SECRET);
        assert_eq!(stored.push_token.as_deref(), Some(REPLACEMENT_PUSH_SECRET));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 指纹校验器:匹配的叶子证书通过,不匹配的拒绝(纯本地,无网络)。
    #[test]
    fn fingerprint_verifier_accepts_match_rejects_mismatch() {
        // 生成一张自签叶子证书,取其 DER + 指纹。
        let certified = rcgen::generate_simple_self_signed(vec!["localhost".to_string()])
            .expect("generate self-signed cert");
        let der: CertificateDer<'static> = certified.cert.der().clone();
        let fp = sha256_hex(der.as_ref());
        assert_eq!(fp.len(), 64, "sha256 hex must be 64 chars");

        let name = ServerName::try_from("localhost").unwrap();
        let now = UnixTime::now();

        // 匹配指纹 → 通过。
        let good = FingerprintVerifier::new(&fp);
        assert!(
            good.verify_server_cert(&der, &[], &name, &[], now).is_ok(),
            "matching fingerprint must verify"
        );

        // 大写指纹也应匹配(大小写不敏感)。
        let good_upper = FingerprintVerifier::new(&fp.to_uppercase());
        assert!(
            good_upper
                .verify_server_cert(&der, &[], &name, &[], now)
                .is_ok(),
            "fingerprint match must be case-insensitive"
        );

        // 不匹配指纹 → 拒绝。
        let bad = FingerprintVerifier::new(&"0".repeat(64));
        assert!(
            bad.verify_server_cert(&der, &[], &name, &[], now).is_err(),
            "mismatched fingerprint must be rejected"
        );
    }

    /// 推送只接受经过校验的 WSS 基址,绝不降级为明文 HTTP。
    #[test]
    fn to_https_base_refuses_downgrade() {
        assert_eq!(
            to_https_base("wss://relay.example.com:8443"),
            Some("https://relay.example.com:8443".to_string())
        );
        assert_eq!(to_https_base("ws://127.0.0.1:9000"), None);
        assert_eq!(to_https_base("https://already-http.example.com"), None);
    }

    /// push_endpoint_config:未启用 / url 或 token 为空 / 目录为空 → None;
    /// 启用且齐全 → 返回带 HTTPS 基址、token 和 pin 的端点。
    #[test]
    fn push_endpoint_config_reflects_enabled_state() {
        let dir = std::env::temp_dir().join(format!(
            "meterm-relay-push-cfg-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let state_dir = dir.to_string_lossy().to_string();

        // 空目录 → None。
        assert_eq!(push_endpoint_config(""), None);
        // 目录存在但无配置文件(默认 disabled)→ None。
        assert_eq!(push_endpoint_config(&state_dir), None);

        // enabled 但 token 为空 → 仍是 None(不能拿去鉴权)。
        let cfg_no_token = RelayConfig {
            url: "wss://relay.example.com:8443".to_string(),
            token: String::new(),
            push_token: None,
            cert_fp: "ab".repeat(32),
            enabled: true,
        };
        assert!(save_relay_config(&state_dir, &cfg_no_token).is_err());

        // 齐全且 enabled → 优先独立 push token。
        let cfg = valid_config();
        save_relay_config(&state_dir, &cfg).unwrap();
        let got = push_endpoint_config(&state_dir).expect("enabled + url + token 齐全应返回 Some");
        assert_eq!(got.base_url, "https://relay.example.com:8443");
        assert_eq!(got.token, PUSH_SECRET);
        assert_eq!(got.cert_fp, "ab".repeat(32));

        // 缺少独立 push token 的旧配置必须 fail closed,不能复用 register secret。
        let mut legacy = valid_config();
        legacy.push_token = None;
        assert!(save_relay_config(&state_dir, &legacy).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn relay_endpoint_and_secret_validation_fail_closed() {
        for url in [
            "ws://relay.example.com",
            "https://relay.example.com",
            "wss://user:pass@relay.example.com",
            "wss://relay.example.com/path",
            "wss://relay.example.com?token=x",
        ] {
            let mut config = valid_config();
            config.url = url.to_string();
            assert!(validate_relay_config(&config).is_err(), "{url}");
        }
        let mut weak = valid_config();
        weak.token = "short".into();
        assert!(validate_relay_config(&weak).is_err());
        let mut spaced = valid_config();
        spaced.token = "register secret with spaces 0123456789abcdef".into();
        assert!(validate_relay_config(&spaced).is_err());
        let mut reused = valid_config();
        reused.push_token = Some(reused.token.clone());
        assert!(validate_relay_config(&reused).is_err());

        let mut non_hex = valid_config();
        non_hex.token = "z".repeat(64);
        assert!(validate_relay_config(&non_hex).is_err());

        let mut legacy = valid_config();
        legacy.push_token = None;
        assert!(validate_relay_config(&legacy).is_err());
    }

    #[test]
    fn register_request_keeps_secret_out_of_uri() {
        let request = build_register_request(&valid_config(), "desktop-123").unwrap();
        let uri = request.uri().to_string();
        assert_eq!(
            uri,
            "wss://relay.example.com:8443/register?device_id=desktop-123"
        );
        assert!(!uri.contains(REGISTER_SECRET));
        assert_eq!(
            request
                .headers()
                .get(header::AUTHORIZATION)
                .unwrap()
                .to_str()
                .unwrap(),
            format!("Bearer {REGISTER_SECRET}")
        );
    }

    #[test]
    fn pinned_push_request_keeps_secret_in_header_only() {
        let head = String::from_utf8(
            build_push_request_head("relay.example.com:8443", "desktop-123", PUSH_SECRET, 12)
                .unwrap(),
        )
        .unwrap();
        assert!(head.starts_with("POST /push HTTP/1.1\r\n"));
        assert!(head.contains(&format!("Authorization: Bearer {PUSH_SECRET}\r\n")));
        assert!(head.contains("X-MeTerm-Desktop-ID: desktop-123\r\n"));
        assert!(!head.lines().next().unwrap().contains(PUSH_SECRET));
        assert!(head.contains("Content-Length: 12\r\n"));
    }
}

#[cfg(test)]
#[path = "relay_client_renewal_tests.rs"]
mod renewal_tests;
