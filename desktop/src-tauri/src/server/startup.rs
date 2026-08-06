//! In-process HTTP/WebSocket server startup and background task orchestration.

use super::*;

/// Start the in-process HTTP/WebSocket server.
pub async fn start(config: ServerConfig) -> Result<Arc<ServerState>, String> {
    let port = if config.log_dir.is_empty() {
        allocate_port()?
    } else {
        allocate_port_persistent(&config.log_dir)?
    };
    let token = generate_token();
    let persisted_lan_policy = lan_access::load_policy(&config.log_dir);

    let ban_file = if config.log_dir.is_empty() {
        None
    } else {
        Some(format!("{}/banned-ips.json", config.log_dir))
    };

    // SSH 连接同步注册表:与 ban_file 同一个 app_data_dir,空目录时传空路径
    // (ConnectionRegistry 读写失败静默忽略,等价于 BanManager 的 None 分支)。
    let connections_path = if config.log_dir.is_empty() {
        std::path::PathBuf::new()
    } else {
        std::path::PathBuf::from(&config.log_dir).join("ssh-connections.json")
    };
    let connections = Arc::new(ConnectionRegistry::new(connections_path)?);
    // Starting the local terminal/server must never enumerate or mutate saved
    // credential items. Legacy SSH/ACL maintenance is an explicit,
    // owner-confirmed recovery operation; normal use loads only the exact
    // connection selected by the user. This also prevents a denied Keychain
    // ACL from causing an authorization-dialog loop on every launch.

    let session_config = SessionConfig {
        session_ttl: config.session_ttl,
        reconnect_grace: config.reconnect_grace,
        ring_buffer_size: config.ring_buffer_size,
        log_dir: config.log_dir.clone(),
    };

    let ban_manager = Arc::new(BanManager::new(ban_file));
    let mut authenticator = if config.token_file.is_empty() {
        Authenticator::new(token)
    } else {
        Authenticator::new_persistent(token, config.token_file.clone())
    };
    // 审查发现:ban_manager 此前从未挂到 Authenticator(封禁检查是死代码),接上
    authenticator.set_ban_manager(ban_manager.clone());
    let authenticator = Arc::new(authenticator);
    // 桌面级事件总线(终端通知 Phase 1):先建好,注入 SessionManager(→ 每个 Session),
    // 再原样存进 ServerState——同一条 channel,SessionManager 与 ServerState 各持一份 clone。
    let event_bus = EventBus::new();
    // hook secret 注册表:先建好注入 SessionManager(reap 清理会话 secret),再存进 ServerState
    // (同源 clone)——修 M1 的 reap secret 泄漏。
    let hook_secrets = HookSecretRegistry::new();
    let session_manager =
        SessionManager::new(session_config, event_bus.clone(), hook_secrets.clone());
    let pairing_manager = PairingManager::new(
        authenticator.clone(),
        session_manager.clone(),
        ban_manager.clone(),
    );

    // 设备 ID:有 state_dir 就持久化(见 load_or_create_device_id),否则临时生成
    // (与 allocate_port 在空 log_dir 时退化为非持久端口的模式一致)。
    let device_id = if config.log_dir.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        load_or_create_device_id(&config.log_dir)
    };

    // 自签 TLS:有 state_dir 时证书元数据落盘，私钥只从 OS credential vault 读取。
    // vault 缺失、authority 错配、旧文件转换失败或证书/私钥不匹配都必须阻止启动，
    // 不能退回明文 HTTP。空 state_dir 仅保留给无持久化的内部测试模式。
    let (tls_acceptor, cert_fp) = if config.log_dir.is_empty() {
        (None, String::new())
    } else {
        let (server_config, fp) = tls::load_or_create_cert(&config.log_dir, &device_id)
            .map_err(|error| format!("TLS identity initialization failed: {error}"))?;
        eprintln!("[meterm-server] TLS ready, cert fingerprint(sha256)={}", fp);
        (
            Some(tokio_rustls::TlsAcceptor::from(Arc::new(server_config))),
            fp,
        )
    };

    let discovery_manager = match DiscoveryManager::new(port, device_id.clone(), cert_fp.clone()) {
        Ok(dm) => {
            eprintln!("[meterm] mDNS discovery manager initialized");
            Some(dm)
        }
        Err(e) => {
            eprintln!(
                "[meterm] mDNS discovery manager failed: {} — LAN scanning disabled",
                e
            );
            None
        }
    };

    // 中继配置:提前加载一次(供 relay_url/relay_cert_fp 展示字段用),隧道 spawn 复用同一份,
    // 避免重复读盘。仅启用时对已认证手机发布 url/指纹与 scoped capability;
    // 桌面登记/HMAC 根密钥从不返回给客户端。
    let relay_config = if config.log_dir.is_empty() {
        relay_client::RelayConfig::default()
    } else {
        relay_client::load_relay_config(&config.log_dir)
    };
    let (relay_url, relay_cert_fp) = if relay_config.enabled {
        (relay_config.url.clone(), relay_config.cert_fp.clone())
    } else {
        (String::new(), String::new())
    };

    let lan_access = lan_access::LanAccessControl::new(&config.log_dir);
    let state = Arc::new(ServerState {
        port,
        lan_port: AtomicU16::new(port),
        ready: AtomicBool::new(false),
        proxy_handle: std::sync::Mutex::new(None),
        proxy_cancel: std::sync::Mutex::new(None),
        config,
        session_manager,
        authenticator,
        ban_manager,
        pairing_manager,
        jumpserver_sessions: jumpserver::ssh_session::JumpServerSessionRegistry::new(),
        connections,
        discovery_manager,
        bypass_proxy: AtomicBool::new(true),
        // Runtime always starts closed. Persisted policy is restored only after
        // the listener exists and before the accept loop is spawned.
        lan_access,
        device_name: std::sync::Mutex::new(String::new()),
        device_id,
        cert_fp,
        relay_url,
        relay_cert_fp,
        relay_register_token: if relay_config.enabled {
            relay_config.token.clone()
        } else {
            String::new()
        },
        event_bus,
        presence: PresenceRegistry::new(),
        push: PushRegistry::new(),
        agents: agent::AcpAgentManager::new(),
        hook_secrets,
        mirrors: agent::MirrorRegistry::new(),
        permission_bridge: agent::PermissionBridge::new(),
    });

    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("bind {}: {}", addr, e))?;

    if let Err(error) = state.restore_lan_access(persisted_lan_policy) {
        eprintln!("[lan] persisted policy restore failed; staying closed: {error}");
    }

    // Spawn the serve loop inside a supervisor that auto-restarts on
    // panic, error, or unexpected exit. Without this, a single panic in
    // the serve loop silently kills the server and ALL WebSocket sessions
    // fail with "Socket is not connected".
    //
    // 每条连接经 run_accept_loop → serve_connection:peek 首字节分流 TLS / 明文,
    // 两条路都喂 build_router 出来的同一个 Router(TLS 供钉指纹的手机,明文供现有手机 + 本机前端)。
    // 中继隧道复用同一 TLS acceptor(子流始终端到端 TLS),故先克隆一份留给它。
    let tls_acceptor_for_relay = tls_acceptor.clone();
    let state_for_serve = state.clone();
    let addr_for_restart = addr.clone();
    tokio::spawn(async move {
        // First run uses the already-bound listener.
        let app = build_router(state_for_serve.clone());
        log_serve_exit(
            tokio::spawn(run_accept_loop(
                listener,
                app,
                tls_acceptor.clone(),
                state_for_serve.clone(),
            ))
            .await,
        );

        // Auto-restart loop: rebind to the same port and rebuild the router.
        loop {
            eprintln!("[meterm-server] restarting in 500ms...");
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

            let listener = match tokio::net::TcpListener::bind(&addr_for_restart).await {
                Ok(l) => l,
                Err(e) => {
                    eprintln!(
                        "[meterm-server] rebind {} failed: {} — retrying",
                        addr_for_restart, e
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    continue;
                }
            };

            let app = build_router(state_for_serve.clone());
            eprintln!("[meterm-server] restarted on {}", addr_for_restart);

            log_serve_exit(
                tokio::spawn(run_accept_loop(
                    listener,
                    app,
                    tls_acceptor.clone(),
                    state_for_serve.clone(),
                ))
                .await,
            );
        }
    });

    state.ready.store(true, Ordering::SeqCst);
    eprintln!("[meterm-server] ready on 0.0.0.0:{}", port);

    // 离线手机推送分发器(终端通知 Phase 3):订阅 event_bus,对当前不在线的已注册手机
    // seal+POST 给中继代发 APNs。中继未启用/未配置时分发器内部整体 no-op(见 push_dispatch::run)。
    tokio::spawn(push_dispatch::run(state.clone()));

    // 中继隧道客户端(出站注册):复用上面已加载的 relay_config(避免重复读盘);enabled 时后台建立
    // 持久 WSS 到中继,跑 yamux(Server 模式)接子流,每条子流喂进 serve_tls_stream(同一 Router)。
    // 需要 TLS(子流始终端到端 TLS)才启用;disabled / 无 TLS / 无目录 → no-op,LAN 与既有行为完全不变。
    if let Some(acceptor) = tls_acceptor_for_relay {
        if relay_config.enabled {
            eprintln!("[relay-client] enabled — spawning configured tunnel");
            let state_for_relay = state.clone();
            tokio::spawn(relay_client::run_relay_tunnel(
                state_for_relay,
                acceptor,
                relay_config,
            ));
        }
    }

    Ok(state)
}
