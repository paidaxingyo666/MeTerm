# meterm Design Document / 设计文档

> Multi-client shared terminal session system — v0.2 Architecture  
> 多端共享终端会话系统 — v0.2 架构演化版

---

## 1. Project Structure / 项目结构

```
meterm/
├── backend/
│   ├── main.go                         # Entrypoint: HTTP server + signal handling + CLI flags
│   │                                   # 入口: HTTP 服务器 + 信号处理 + CLI 参数 (--log-dir)
│   ├── e2e_test.go                     # E2E tests: basic flow / multi-client / reconnect / delete
│   │                                   # E2E 测试: 基础流程 / 多客户端 / 重连 / 删除
│   ├── go.mod / go.sum
│   ├── cmd/
│   │   └── meterm/
│   │       └── main.go                 # CLI tool: sessions ls|inspect|kill
│   │                                   # CLI 工具: 会话管理命令行
│   ├── executor/
│   │   ├── executor.go                 # Executor interface (Start/Stop/Info)
│   │   │                               # Executor 接口: 执行后端抽象
│   │   └── local.go                    # LocalShellExecutor: wraps PTYEngine
│   │                                   # 本地 Shell 执行器: 包装 PTYEngine
│   ├── recording/
│   │   ├── recorder.go                 # Recorder interface + LogEntry + direction constants
│   │   │                               # Recorder 接口 + 日志条目 + 方向常量
│   │   ├── file.go                     # FileRecorder: binary log with background flush
│   │   │                               # 文件记录器: 二进制日志 + 后台刷盘
│   │   ├── terminal.go                 # RecordingTerminal: Terminal decorator for auto-recording
│   │   │                               # 录制终端: Terminal 装饰器, 自动录制 I/O
│   │   └── replay.go                   # ReplayReader: read back recorded sessions
│   │                                   # 回放读取器: 读取录制的会话
│   ├── protocol/
│   │   └── protocol.go                 # Binary protocol: message types 0x01-0x09, encode/decode
│   │                                   # 二进制协议: 消息类型 0x01-0x09, 编解码
│   ├── terminal/
│   │   ├── terminal.go                 # Terminal interface (Read/Write/Resize/Done/Close)
│   │   │                               # Terminal 接口定义
│   │   └── pty.go                      # PTYEngine: implements Terminal via creack/pty
│   │                                   # PTYEngine: 通过 creack/pty 实现 Terminal 接口
│   ├── session/
│   │   ├── state.go                    # SessionState enum + transitions
│   │   │                               # SessionState 枚举 + 状态转换
│   │   ├── session.go                  # Session: state machine + ring buffer + Exec/Recorder
│   │   │                               # Session: 状态机 + 环形缓冲区 + 执行器/录制器
│   │   ├── client.go                   # Client: roles (master/viewer/readonly) + reconnect
│   │   │                               # Client: 角色 (master/viewer/readonly) + 断线重连
│   │   └── manager.go                  # SessionManager: CreateWithExecutor + LogDir + reaper
│   │                                   # SessionManager: 执行器创建 + 日志目录 + 回收
│   └── api/
│       ├── handler.go                  # REST API: POST/GET/DELETE /api/sessions + executor_type
│       │                               # REST API 处理器 + executor_type 字段
│       └── ws.go                       # WebSocket handler: /ws/:id + ?mode=readonly
│                                       # WebSocket 处理器 + 只读模式支持
├── frontend/
│   ├── src/
│   │   ├── main.ts                     # xterm.js + WebSocket + auto-reconnect
│   │   │                               # xterm.js 终端 + WebSocket + 自动重连
│   │   ├── protocol.ts                 # Frontend protocol: MsgHello parsing + encode/decode
│   │   │                               # 前端协议: MsgHello 解析 + 编解码
│   │   └── style.css
│   ├── index.html
│   ├── vite.config.ts                  # port: 5174, host: 0.0.0.0 (LAN accessible)
│   │                                   # 端口: 5174, 局域网可访问
│   └── package.json
└── Makefile
```

---

## 2. Session Lifecycle / Session 生命周期

```
              ┌──────────┐
              │ Created  │  NewSession(): waiting for first client
              │  已创建   │  NewSession(): 等待首个客户端
              └────┬─────┘
                   │ AddClient() / ReconnectClient()
                   ▼
              ┌──────────┐
         ┌───>│ Running  │  ≥1 client connected, PTY output broadcast to all
         │    │  运行中   │  ≥1 客户端在线, PTY 输出广播给所有客户端
         │    └────┬─────┘
         │         │ Last client disconnects (connectedCount == 0)
         │         │ 最后一个客户端断开
         │         ▼
         │    ┌──────────┐
         │    │ Draining │  No clients online, PTY output → ring buffer
         │    │  排空中   │  无客户端在线, PTY 输出写入环形缓冲区
         │    └────┬─────┘  TTL countdown starts (default 5 min)
         │         │        TTL 倒计时开始 (默认 5 分钟)
         │    ┌────┴────────────┐
         │    │                 │
         │    │ Client reconnect│ TTL expired / PTY exit / API DELETE
         │    │ 客户端重连       │ TTL 到期 / PTY 退出 / API 删除
         │    ▼                 ▼
         │  Back to Running ┌──────────┐
         │  回到运行中       │  Closed  │  Terminal closed, all clients disconnected
         └─────────────────>│  已关闭   │  终端关闭, 所有客户端断开, 资源释放
                            └──────────┘
```

**State Transition Rules / 状态转换规则**:

| From → To | Trigger / 触发条件 |
|-----------|-------------------|
| Created → Running | First client joins / 首个客户端加入 |
| Running → Draining | Last connected client disconnects (TTL > 0) / 最后客户端断开 (TTL > 0) |
| Running → Closed | Last client disconnects (TTL == 0), or PTY exits / 最后客户端断开 (TTL == 0) 或 PTY 退出 |
| Draining → Running | Client reconnects / 客户端重连 |
| Draining → Closed | TTL expired, PTY exit, or API delete / TTL 到期、PTY 退出或 API 删除 |

---

## 3. Terminal Interface / Terminal 接口定义

```go
// terminal/terminal.go
package terminal

type Terminal interface {
    // Read reads PTY output into buf, returns bytes read.
    // 从 PTY 读取输出到 buf, 返回读取的字节数
    Read(buf []byte) (int, error)

    // Write sends user input to PTY stdin.
    // 将用户输入写入 PTY 的 stdin
    Write(data []byte) (int, error)

    // Resize changes the PTY window size.
    // 修改 PTY 窗口大小
    Resize(cols, rows uint16) error

    // Done returns a channel closed when the PTY process exits.
    // 返回一个在 PTY 进程退出时关闭的 channel
    Done() <-chan struct{}

    // Close terminates the PTY process and releases resources.
    // 终止 PTY 进程并释放资源
    Close() error
}
```

Current implementation: `PTYEngine` (via `creack/pty`). The interface design allows future replacement with SSH tunnel, Docker exec, or mock terminal for testing. In v0.2, Session no longer creates Terminal directly — it receives one from an `Executor`.

当前实现: `PTYEngine` (使用 `creack/pty`)。接口设计允许未来替换为 SSH 隧道、Docker exec、或测试用 mock terminal。v0.2 中 Session 不再直接创建 Terminal — 而是从 `Executor` 接收。

---

## 4. Session Core Code / Session 核心代码示例

```go
// session/session.go — Key methods / 关键方法

// Run is the Session's main loop, running in a dedicated goroutine.
// It reads PTY output and dispatches based on current state:
//   Running  → Broadcast(MsgOutput) to all clients
//   Draining → appendRingLocked() into ring buffer
//   PTY exit → Broadcast(MsgSessionEnd), Close()
//
// Run 是 Session 的主循环, 在独立 goroutine 中运行。
// 根据当前状态分发 PTY 输出:
//   Running  → 广播给所有客户端
//   Draining → 写入环形缓冲区
//   PTY 退出 → 广播 SessionEnd, 关闭
func (s *Session) Run() { ... }

// AddClient registers a new client. The first client automatically
// becomes Master. Transitions Draining → Running.
//
// AddClient 注册新客户端。首个客户端自动成为 Master。
// 触发 Draining → Running 状态转换。
func (s *Session) AddClient(client *Client) error { ... }

// ReconnectClient reattaches a disconnected client's WebSocket,
// preserving its identity and role. Flushes ring buffer afterward.
//
// ReconnectClient 重新连接断线客户端的 WebSocket,
// 保留其身份和角色。之后补发环形缓冲区内容。
func (s *Session) ReconnectClient(clientID string, conn *websocket.Conn, grace time.Duration) (*Client, error) { ... }

// FlushRingBuffer sends buffered draining output to a reconnected client.
// FlushRingBuffer 将 Draining 期间缓存的输出发送给重连客户端。
func (s *Session) FlushRingBuffer(client *Client) { ... }
```

---

## 5. Reconnection Logic / 重连逻辑实现

### Backend (Go) / 后端

```
[WebSocket Handler: /ws/:session-id?client_id=<id>]
  │
  ├─ client_id parameter present? / client_id 参数存在?
  │    ├─ Yes → s.ReconnectClient(clientID, conn, grace)
  │    │         ├─ Success → Reuse old Client (role preserved)
  │    │         │             成功 → 复用旧 Client (保留角色)
  │    │         └─ Failure → Fall back to new client
  │    │                       失败 → 降级为新客户端
  │    └─ No  → Create new Client / 创建新 Client
  │
  ├─ Send MsgHello {client_id, role, protocol_version}
  ├─ Send MsgRoleChange
  ├─ If reconnect → FlushRingBuffer (replay buffered output)
  │                  若是重连 → 补发缓存输出
  └─ Enter read loop / 进入读循环
       MsgInput  → PTY stdin
       MsgResize → PTY resize
       MsgPing   → MsgPong
```

### Frontend (TypeScript) / 前端

```
connect()
  │
  ├─ Build URL: ws://host/ws/<sessionId>?client_id=<storedClientId>
  │   构建 URL (携带已存储的 clientId)
  ├─ onopen  → reconnectAttempt = 0
  ├─ onmessage → handleMessage()
  │     ├─ MsgHello     → Store clientId (for next reconnect)
  │     │                  存储 clientId (用于下次重连)
  │     ├─ MsgRoleChange → Update status bar / 更新状态栏
  │     ├─ MsgOutput     → terminal.write()
  │     └─ MsgSessionEnd → sessionEnded = true, stop reconnecting
  │                         停止重连
  │
  └─ onclose → scheduleReconnect()
        ├─ sessionEnded?              → Stop / 停止
        ├─ attempt >= 10?             → Stop / 停止
        └─ setTimeout(connect, delay)
             delay = min(1000 * 2^attempt, 16000)
```

**Backoff strategy / 退避策略**: 1s → 2s → 4s → 8s → 16s → 16s → ... (max 10 attempts / 最多 10 次)

---

## 6. Resize Handling / Resize 处理实现

### Frontend → Backend / 前端 → 后端

```typescript
// frontend/src/main.ts
terminal.onResize(({ cols, rows }) => {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(encodeResize(cols, rows));
  }
});
```

**Protocol format / 协议格式**: `[0x03][cols:uint16 big-endian][rows:uint16 big-endian]` (5 bytes)

### Backend processing / 后端处理

```go
// api/ws.go — WebSocket read loop
case protocol.MsgResize:
    cols, rows, err := protocol.DecodeResize(payload)
    if err == nil {
        s.HandleResize(client.ID, cols, rows)
    }

// session/session.go — Only Master can resize / 只有 Master 才能 resize
func (s *Session) HandleResize(clientID string, cols, rows uint16) {
    if s.MasterID == clientID {
        _ = s.Term.Resize(cols, rows)
    }
}

// terminal/pty.go — Apply to PTY / 应用到 PTY
func (e *PTYEngine) Resize(cols, rows uint16) error {
    return pty.Setsize(e.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
}
```

---

## 7. Design Summary / 简要设计说明

### Architecture Principles / 架构原则

| Principle / 原则 | Description / 说明 |
|------------------|-------------------|
| Single-process, stdlib-first | No HTTP frameworks, databases, or microservices. Uses `net/http.ServeMux` + `gorilla/websocket` |
| 单进程、标准库优先 | 不引入 HTTP 框架、数据库、微服务。使用标准库 + gorilla/websocket |
| Interface abstraction | `Terminal` interface decouples PTY implementation; replaceable with SSH, Docker, Mock |
| 接口抽象 | Terminal 接口解耦 PTY 实现, 可替换为 SSH、Docker、Mock |
| State-machine driven | Session has 4 explicit states; transitions are atomic under mutex |
| 状态机驱动 | Session 有 4 个明确状态, 状态转换在锁保护下原子执行 |
| Binary protocol | WebSocket frames use `[type:1B][payload:NB]`; only MsgHello uses JSON |
| 二进制协议 | WebSocket 帧格式 `[type:1B][payload:NB]`, 仅 MsgHello 使用 JSON |

### Reliability Mechanisms / 可靠性机制

| Mechanism / 机制 | Config / 配置 | Description / 说明 |
|------------------|--------------|-------------------|
| Client reconnect / 断线重连 | `--grace 60s` | Preserve client identity and role for 60s after disconnect / 断线后保留身份和角色 60 秒 |
| Ring buffer / 环形缓冲区 | `--ring-buffer 256KB` | Buffer PTY output during Draining, replay on reconnect / Draining 期间缓存输出, 重连后补发 |
| Session TTL | `--ttl 5m` | Keep session alive 5 min after all clients disconnect / 无客户端后保留 5 分钟 |
| Reaper / 回收器 | Every 10s / 每 10 秒 | Clean up expired clients and sessions / 清理过期客户端和 session |
| Frontend reconnect / 前端重连 | Exponential backoff 1-16s | Max 10 attempts / 指数退避, 最多 10 次 |

### REST API Reference / REST API 文档

| Method | Path | Description / 说明 | Response |
|--------|------|-------------------|----------|
| `POST` | `/api/sessions` | Create new session / 创建新 session | `201 {id, created_at, state}` |
| `GET` | `/api/sessions` | List all sessions / 列出所有 session | `200 {sessions: [...]}` |
| `GET` | `/api/sessions/:id` | Get session detail / 获取 session 详情 | `200 {id, clients, master_id, state}` |
| `DELETE` | `/api/sessions/:id` | Delete session / 删除 session | `200 {ok: true}` |
| `PUT` | `/api/sessions/:id/master` | Transfer Master role / 切换 Master | `200 {ok, master_id}` |
| `WS` | `/ws/:id[?client_id=<id>]` | WebSocket connect/reconnect / WebSocket 连接/重连 | Binary protocol |

### Protocol Messages / 协议消息类型

| Type | Hex | Direction / 方向 | Payload |
|------|-----|-----------------|---------|
| Output | `0x01` | Server → Client | Raw PTY bytes / PTY 原始字节 |
| Input | `0x02` | Client → Server | Raw keyboard bytes / 键盘输入字节 |
| Resize | `0x03` | Client → Server | `[cols:u16be][rows:u16be]` |
| Ping | `0x04` | Client → Server | (none) |
| Pong | `0x05` | Server → Client | (none) |
| SessionEnd | `0x06` | Server → Client | (none) |
| Error | `0x07` | Server → Client | `[code:u8][message:utf8]` |
| RoleChange | `0x08` | Server → Client | `[role:u8]` (0=viewer, 1=master, 2=readonly) |
| Hello | `0x09` | Server → Client | JSON `{client_id, role, protocol_version}` |

---

## 8. Executor Abstraction (v0.2) / Executor 抽象

Executor is a **factory + lifecycle wrapper** for Terminal. It decouples "how to start an execution environment" from "how Session forwards byte streams".

Executor 是 Terminal 的**工厂 + 生命周期包装器**。它将"如何启动执行环境"与"Session 如何转发字节流"解耦。

```go
// executor/executor.go
type Executor interface {
    Start() (terminal.Terminal, error)  // Create and return a Terminal
    Stop() error                        // Shut down the execution environment
    Info() ExecutorInfo                 // Metadata for inspection/CLI
}

type ExecutorInfo struct {
    Type   string            // "local-shell", "docker", "ssh" (future)
    Labels map[string]string // {"shell": "/bin/zsh", "cols": "80", "rows": "24"}
}
```

### LocalShellExecutor

```go
// executor/local.go
type LocalShellExecutor struct { ... }

func NewLocalShellExecutor(cols, rows uint16) *LocalShellExecutor
func (e *LocalShellExecutor) Start() (terminal.Terminal, error)  // Calls terminal.NewPTYEngine
func (e *LocalShellExecutor) Stop() error                        // Calls terminal.Close(), idempotent
func (e *LocalShellExecutor) Info() ExecutorInfo                 // Type: "local-shell"
```

### Session Integration / Session 集成

```
SessionManager.Create()
  → CreateWithExecutor(NewLocalShellExecutor(80, 24))
    → exec.Start() → terminal.Terminal
    → NewSession(config, term, exec)
    → Session holds both Term (I/O hot path) and Exec (lifecycle + metadata)
```

**Close order / 关闭顺序**: clients → terminal → recorder → executor

### Future Executors / 未来执行器

| Executor | Description / 说明 |
|----------|-------------------|
| `DockerExecutor` | Start container, attach stdin/stdout as Terminal |
| `SSHExecutor` | SSH to remote host, forward PTY |
| `MockExecutor` | For testing, returns in-memory pipe |

---

## 9. Session Recording (v0.2) / 会话录制

### Log Format / 日志格式

Binary file, one entry per I/O event:

```
[timestamp:int64 LE][direction:1 byte][length:uint32 LE][data:N bytes]
```

| Direction | Byte | Description / 说明 |
|-----------|------|-------------------|
| Input | `'i'` | User keyboard input / 用户键盘输入 |
| Output | `'o'` | PTY output / PTY 输出 |
| Resize | `'r'` | Terminal resize `[cols:u16be][rows:u16be]` / 终端调整大小 |
| Event | `'e'` | Session lifecycle event / 会话生命周期事件 |

### Recorder Interface / Recorder 接口

```go
// recording/recorder.go
type Recorder interface {
    Record(entry LogEntry) error
    Close() error
}
```

### FileRecorder

- Writes to `<log-dir>/<session-id>.log`
- 64KB buffered writer with 500ms background flush
- Thread-safe via mutex, idempotent Close

### RecordingTerminal (Decorator) / 录制终端 (装饰器)

Wraps any `terminal.Terminal`, automatically records all Read (output) and Write (input) with data copies:

```go
// recording/terminal.go
type RecordingTerminal struct { inner terminal.Terminal; rec Recorder }
func (t *RecordingTerminal) Read(buf []byte) (int, error)   // Read + record 'o'
func (t *RecordingTerminal) Write(data []byte) (int, error) // Record 'i' + Write
func (t *RecordingTerminal) Resize(cols, rows uint16) error // Record 'r' + Resize
```

### Replay / 回放

```go
// recording/replay.go
reader, _ := recording.NewReplayReader("path/to/session.log")
for {
    entry, err := reader.Next()  // Returns LogEntry or io.EOF
    if err == io.EOF { break }
    // Play back with timing based on entry.Timestamp
}
```

### Configuration / 配置

```bash
meterm --log-dir /var/log/meterm  # Enable recording / 启用录制
meterm                             # No recording (default) / 不录制 (默认)
```

---

## 10. Session Management CLI (v0.2) / 会话管理命令行

The CLI is a standalone binary that talks to the running server via REST API.

CLI 是独立二进制程序，通过 REST API 与运行中的服务器通信。

```bash
# List all sessions / 列出所有会话
meterm --addr http://localhost:8080 sessions ls
# Output / 输出:
# ID                                    STATE     CLIENTS  MASTER     CREATED
# a110f352-bb9b-429e-8299-9187c53cf748  running   2        e329700c   2026-02-11T14:26:59Z

# Inspect a session / 查看会话详情
meterm sessions inspect <session-id>
# Output: pretty-printed JSON with clients, master_id, state, executor_type

# Kill a session / 终止会话
meterm sessions kill <session-id>
# Output: "killed"
```

Build: `go build -o meterm ./cmd/meterm/`

---

## 11. ReadOnly Attach Mode (v0.2) / 只读附加模式

### Client Roles / 客户端角色

| Role | Value | Input | Resize | Promotable | Description / 说明 |
|------|-------|-------|--------|------------|-------------------|
| Viewer | 0 | ✗ | ✗ | ✓ | Observes output, can be promoted to Master / 观察输出, 可提升为 Master |
| Master | 1 | ✓ | ✓ | — | Full control / 完全控制 |
| ReadOnly | 2 | ✗ | ✗ | ✗ | Observes only, never promotable (for AI/bots) / 仅观察, 不可提升 (适用于 AI/机器人) |

### WebSocket Connection / WebSocket 连接

```
ws://host/ws/<session-id>?mode=readonly    # Connect as ReadOnly / 以只读模式连接
ws://host/ws/<session-id>                  # Connect as normal Viewer / 正常 Viewer 连接
```

### Server Enforcement / 服务端限制

- ReadOnly clients receive MsgOutput but HandleInput/HandleResize silently reject their messages
- ReadOnly clients are skipped during Master auto-promotion when current Master disconnects
- Hello message includes `"role": "readonly"` so client knows its mode

ReadOnly 客户端接收 MsgOutput 但 HandleInput/HandleResize 静默拒绝其消息。Master 断开时自动提升跳过 ReadOnly 客户端。Hello 消息包含 `"role": "readonly"` 告知客户端模式。
