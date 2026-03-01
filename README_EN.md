# MeTerm

> Multi-client shared terminal session system — Real-time terminal collaboration

[中文](./README.md)

---

## Overview

MeTerm is a shared terminal session system that supports multiple simultaneous client connections. It allows multiple users to view and interact with the same terminal session in real-time, supporting both local terminals and SSH remote connections. Ideal for remote collaboration, teaching demos, remote debugging, AI-assisted programming, and more.

### Key Features

- 🔗 **Multi-client Sharing** — Multiple users can connect to the same terminal session simultaneously with real-time sync
- 🔐 **Role-based Access Control** — Three roles: Master (full control), Viewer (observer), ReadOnly (read-only)
- 🔄 **Auto-reconnection** — Automatic reconnection after network interruption, preserving client identity and role, ring buffer for missed data
- 📹 **Session Recording & Replay** — Complete terminal session recording and precise playback (input/output/resize all recorded)
- 🖥️ **SSH Remote Connection** — SSH to remote servers with full session management capabilities
- 📁 **SFTP File Manager** — Built-in file management drawer with upload/download/resume/drag-and-drop
- 🖲️ **Cross-platform Desktop App** — Windows / macOS / Linux native desktop clients
- 🤖 **AI Assistant Capsule** — Per-session floating AI dialog panel with multi-provider support (OpenAI / Anthropic / Gemini)
- 🪟 **Flexible Split Panes** — Binary tree layout with horizontal/vertical splits, independent sessions per pane
- 🖼️ **Background Images** — Terminal background image gallery with thumbnail preview and opacity control
- 🔍 **mDNS Service Discovery** — Auto-discover devices on LAN, no manual IP entry
- 🔄 **Auto Updates** — Built-in application update detection and one-click installation

---

## Architecture

```
meterm/
├── backend/           # Go backend service
│   ├── cmd/           # CLI entry point
│   │   └── muxerd/main.go  # Server startup
│   ├── api/           # REST API + WebSocket handlers
│   │   ├── handler.go      # Route registration + Session CRUD API
│   │   ├── ws.go           # WebSocket handler
│   │   ├── file_handler.go # File operation WebSocket
│   │   ├── auth.go         # Token authentication middleware
│   │   ├── ban.go          # IP ban management
│   │   ├── discover.go     # mDNS service discovery
│   │   ├── pairing.go      # Device pairing API
│   │   └── server_info.go  # Server resource monitoring
│   ├── session/       # Session management (state machine + ring buffer)
│   │   ├── manager.go      # SessionManager lifecycle
│   │   ├── session.go      # Session core logic
│   │   ├── client.go       # Client role management
│   │   ├── state.go        # State machine definition
│   │   └── transfers.go    # File transfer sessions
│   ├── terminal/      # PTY/SSH terminal interface
│   │   ├── terminal.go     # Terminal interface
│   │   ├── pty_unix.go     # Unix PTY implementation
│   │   ├── pty_windows.go  # Windows ConPTY implementation
│   │   └── ssh.go          # SSH terminal implementation
│   ├── protocol/      # Binary communication protocol
│   │   ├── protocol.go     # Base message types
│   │   └── file_messages.go # File operation messages
│   ├── executor/      # Executor abstraction
│   │   ├── executor.go     # Executor interface
│   │   ├── local.go        # Local shell executor
│   │   └── ssh.go          # SSH executor
│   ├── sftp/          # SFTP client wrapper
│   ├── recording/     # Session recording and replay
│   ├── internal/      # Internal implementations (ConPTY etc.)
│   └── web/           # Frontend static asset embedding
├── frontend/          # Web frontend (xterm.js + WebSocket)
├── desktop/           # Tauri desktop application
│   └── src/
│       ├── terminal.ts     # xterm.js terminal wrapper
│       ├── connection.ts   # WebSocket connection management
│       ├── protocol.ts     # Binary message protocol
│       ├── tabs.ts         # Multi-tab management
│       ├── tab-drag.ts     # Tab drag-and-drop sorting
│       ├── split-pane.ts   # Binary tree split pane layout
│       ├── ssh.ts          # SSH connection module
│       ├── remote.ts       # Remote server management
│       ├── drawer.ts       # Drawer panel (files/processes/system info)
│       ├── file-manager.ts # File list/operations
│       ├── ai-capsule.ts   # AI assistant capsule UI
│       ├── ai-agent.ts     # AI conversation logic
│       ├── ai-provider.ts  # Multi AI provider interface
│       ├── gallery.ts      # Background image gallery
│       ├── updater.ts      # Auto update detection
│       ├── updater-window.ts # Update window
│       ├── status-bar.ts   # Dynamic status bar
│       ├── settings.ts     # Settings panel
│       ├── settings-window.ts # Settings window
│       ├── fonts.ts        # Font management
│       ├── themes.ts       # Theme/colors/backgrounds
│       ├── notify.ts       # Desktop notifications
│       ├── pairing.ts      # Device pairing
│       ├── home.ts         # Home page
│       ├── icons.ts        # Icon resources
│       ├── i18n.ts         # Internationalization
│       └── window-utils.ts # Window utilities
└── cloudflare-worker/ # CF Worker auto-update service
```

---

## Features

### 1. Session Lifecycle

```
          ┌──────────┐
          │ Created  │  Waiting for first client
          └────┬─────┘
               │ Client connects
               ▼
          ┌──────────┐
     ┌───>│ Running  │  Clients online, PTY output broadcast to all
     │    └────┬─────┘
     │         │ Last client disconnects
     │         ▼
     │    ┌──────────┐
     │    │ Draining │  No clients, PTY output written to ring buffer
     │    └────┬─────┘  TTL countdown (default 5 min)
     │         │
     │    ┌────┴────────────┐
     │    │                 │
     │    ▼                 ▼
     └── Reconnect      ┌──────────┐
                       │  Closed  │  Session closed, resources released
                       └──────────┘
```

### 2. Client Role System

| Role | Value | Input | Resize | Promotable | Use Case |
|------|-------|-------|--------|------------|----------|
| Viewer | 0 | ✗ | ✗ | ✓ | Observer, can be promoted to Master |
| Master | 1 | ✓ | ✓ | — | Full control, only one at a time |
| ReadOnly | 2 | ✗ | ✗ | ✗ | AI/bots, never promotable |

**Role Transfer Mechanism:**

- Viewer can send `MsgMasterRequest` to become Master
- Current Master receives `MsgMasterRequestNotify`
- Master can approve/deny the request
- Supports active `MsgMasterReclaim` to take back control

### 3. SSH Remote Connection

SSH to remote servers with:

- Password / SSH key authentication
- Custom port (default 22)
- All local session features (recording, multi-client, access control)
- Automatic SFTP file management for SSH sessions

### 4. SFTP File Manager Drawer

File management for SSH sessions:

- **File Browse** — List view with sorting
- **Upload/Download** — Chunked transfer with real-time progress
- **Resume Transfer** — Auto-recover after network interruption
- **Drag & Drop** — Drag in to upload, drag out to download
- **File Operations** — Delete, rename, create folder, compress/extract
- **Server Monitoring** — Real-time CPU/memory/disk usage
- **Large Directory Optimization** — Progress updates for 100+ files

### 5. Split Pane Layout

Binary tree split pane system:

- **Horizontal/Vertical Split** — Divide current panel in two
- **Independent Sessions** — Each split pane has its own terminal session
- **Ratio Adjustment** — Drag divider to resize panels (ratio 0-1)
- **Nested Splits** — Support arbitrary nesting levels

### 6. Terminal Fonts & Themes

**Built-in Fonts (woff2 format, offline ready):**

| Font | Ligatures | Nerd Font |
| ---- | --------- | --------- |
| JetBrains Mono | ✅ | ✅ |
| Fira Code | ✅ | ✅ |
| Cascadia Code | ✅ | ✅ |
| Source Code Pro | ❌ | ✅ |
| Hack | ❌ | ✅ |
| Iosevka | ✅ | ✅ |
| Menlo (System) | ❌ | ❌ |

**Appearance Options:**

- 8 built-in terminal themes
- 5 color schemes (auto / dark / darker / navy / light)
- Terminal background image + opacity control
- Nerd Font toggle (icon fonts)
- Programming ligatures toggle
- Bold font weight
- Multiple encodings: UTF-8, GBK, GB18030, Big5, EUC-JP, EUC-KR

### 7. AI Assistant Capsule

Per-session floating AI dialog:

- Two states: collapsed (circular icon) / expanded (pill panel)
- **Multi AI Provider** — OpenAI / Anthropic / Gemini with custom API endpoints
- Model selector with dynamic model list fetching
- Two send modes:
  - **Send Command (⌘)** — Execute directly in terminal
  - **Send Prompt (✦)** — Chat with AI
- Draggable positioning
- Configurable temperature, max tokens, and context lines

### 8. Dynamic Status Bar

Capsule-style status bar:

**Permanent Capsules (Left):**

- Connection status — Color-coded + breathing/blink animation
- Latency measurement — Ping/Pong RTT, 5-second average
- Session count — Shown with multiple tabs

**Activity Capsules (Right):**

- File transfer — Upload/download progress bar
- AI status — Thinking animation

### 9. Desktop Features

- **Split Pane Terminal** — Horizontal/vertical splits with independent sessions
- **Multi-window Support** — Drag tab to empty space to create new window
- **Single Tab Protection** — Dragging single-tab window moves entire window
- **Background Images** — Image gallery, thumbnail preview, opacity control
- **Auto Updates** — Built-in version check + one-click update
- **System Tray** — Background running with tray menu control, update badge
- **Internationalization** — English/Chinese, tray menu follows language
- **Desktop Notifications** — Terminal event notifications

### 10. mDNS Service Discovery

Auto device discovery on LAN:

- Service type: `_meterm._tcp.local.`
- Scan timeout: 10 seconds (default 5)
- Returns device name, IP, port
- Enable/disable broadcasting

---

## Binary Protocol

WebSocket uses efficient binary protocol:

**Frame Format:** `[type: 1 byte][payload: N bytes]`

| Message Type | Hex | Direction | Description |
|--------------|-----|-----------|-------------|
| Output | 0x01 | S→C | PTY output stream |
| Input | 0x02 | C→S | Keyboard input |
| Resize | 0x03 | C→S | Terminal size change |
| Ping | 0x04 | C→S | Heartbeat request |
| Pong | 0x05 | S→C | Heartbeat response |
| SessionEnd | 0x06 | S→C | Session ended |
| Error | 0x07 | S→C | Error notification |
| RoleChange | 0x08 | S→C | Role change |
| Hello | 0x09 | S→C | Handshake/reconnect metadata |
| FileList | 0x0A | C→S | Request file list |
| FileListResp | 0x0B | S→C | File list response |
| FileUploadStart | 0x0C | C→S | Start upload |
| FileUploadChunk | 0x0D | C→S | Upload data chunk |
| FileDownloadStart | 0x0E | C→S | Start download |
| FileDownloadChunk | 0x0F | S→C | Download data chunk |
| FileOperation | 0x10 | C→S | File operation (delete/rename etc.) |
| FileOperationResp | 0x11 | S→C | File operation response |
| ServerInfo | 0x12 | C⇄S | Server info |
| TransferProgress | 0x13 | S→C | Transfer progress |
| UploadResume | 0x14 | C→S | Resume upload |
| DownloadResume | 0x15 | C→S | Resume download |
| FileListProgress | 0x16 | S→C | Large directory loading progress |
| SetEncoding | 0x17 | C→S | Set terminal encoding |
| Nudge | 0x18 | C→S | Request PTY SIGWINCH |
| MasterRequest | 0x19 | C→S | Request to become Master |
| MasterRequestNotify | 0x1A | S→C | Notify current Master |
| MasterApproval | 0x1B | C→S | Approve/deny request |
| MasterReclaim | 0x1C | C→S | Master reclaims control |
| PairNotify | 0x1D | S→C | Pairing request notification |
| PairApproval | 0x1E | C→S | Pairing approval result |
| FileDownloadPause | 0x20 | C→S | Pause download |
| FileDownloadContinue | 0x21 | C→S | Resume paused download |
| FileDownloadCancel | 0x22 | C→S | Cancel download |

---

## Quick Start

### Prerequisites

- Go 1.25+
- Node.js 20+
- Rust (rustup)
- Make

### Development Setup

```bash
# Clone the repository
git clone https://github.com/paidaxingyo666/meterm.git
cd meterm

# Install frontend dependencies
cd frontend && npm install && cd ..

# Start backend + frontend (parallel)
make dev
```

Visit http://localhost:5174 to use the application.

### Individual Services

```bash
# Start backend only (port 8080)
make backend

# Start frontend only (port 5174)
make frontend
```

---

## Usage

### Create a Session

```bash
# Create a new session via REST API
curl -X POST http://localhost:8080/api/sessions
# Response: {"id": "xxx-xxx-xxx", "state": "created", ...}
```

### Connect to Terminal

Visit `http://localhost:5174?session=<session-id>` in your browser to connect.

### WebSocket Connection

```
ws://localhost:8080/ws/<session-id>
ws://localhost:8080/ws/<session-id>?client_id=<id>      # Reconnect
ws://localhost:8080/ws/<session-id>?mode=readonly       # Read-only mode
```

### Session Management CLI

```bash
# Build CLI tool
cd backend && go build -o ../bin/meterm ./cmd/muxerd

# List all sessions
./bin/meterm --addr http://localhost:8080 sessions ls

# Inspect session details
./bin/meterm sessions inspect <session-id>

# Kill a session
./bin/meterm sessions kill <session-id>
```

---

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/sessions` | Create local session |
| `GET` | `/api/sessions` | List all sessions |
| `GET` | `/api/sessions/:id` | Get session details |
| `DELETE` | `/api/sessions/:id` | Delete session |
| `POST` | `/api/sessions/ssh` | Create SSH session |
| `POST` | `/api/sessions/ssh/test` | Test SSH connection |
| `POST` | `/api/sessions/:id/master` | Transfer Master role |
| `POST` | `/api/sessions/:id/private` | Set session private mode |
| `DELETE` | `/api/sessions/:id/clients/:cid` | Kick client |
| `GET` | `/api/clients` | List all clients |
| `GET` | `/api/devices` | List all known devices |
| `GET` | `/api/info` | Get server info |
| `POST` | `/api/discover` | mDNS scan for LAN devices |
| `POST` | `/api/discoverable` | Toggle mDNS discoverability |
| `POST` | `/api/pair` | Create pairing request |
| `GET` | `/api/pair/:id?secret=xxx` | Query pairing status |
| `GET` | `/api/pair/pending` | List pending pairings |
| `POST` | `/api/pair/:id/respond` | Approve/reject pairing |
| `GET` | `/api/token` | Get current token |
| `POST` | `/api/token/refresh` | Refresh token |
| `POST` | `/api/token/revoke-all` | Revoke all tokens |
| `GET` | `/api/banned-ips` | List banned IPs |
| `GET` | `/api/ping` | Health check (no auth required) |

---

## Desktop Application

### Development

```bash
# Build desktop sidecar
make desktop-sidecar

# Run in development mode (macOS / Linux)
make desktop-dev

# Windows development (from WSL)
# Prerequisites: Node.js, Rust/Cargo, Go must be installed on Windows side
make desktop-dev-win-rebuild    # Dev mode (rebuild Go sidecar)
make desktop-dev-win            # Dev mode (skip Go sidecar rebuild)
# When Go backend changes, always use the rebuild command
```

### Build Installers

#### macOS

**Prerequisites:** Go 1.25+, Rust (rustup), Node.js 20+

```bash
# Build DMG installer for current architecture
make release-macos

# Build for specific architecture
make release-macos-arm64        # Apple Silicon (M1/M2/M3/M4)
make release-macos-x86_64       # Intel Mac
make release-macos-all          # Build both architectures

# Enable code signing (requires Apple Developer ID certificate)
./build-macos.sh --arch arm64 --sign

# Full options
./build-macos.sh --help
```

Build artifacts output to `dist/`:

```
dist/
├── MeTerm_0.1.0_aarch64-arm64.dmg    # Apple Silicon
└── MeTerm_0.1.0_x86_64-x86_64.dmg    # Intel
```

<details>
<summary>Code Signing & Notarization</summary>

Signing requires Apple Developer Program membership and a Developer ID Application certificate.

```bash
# Set signing environment variables
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="your@email.com"
export APPLE_TEAM_ID="TEAMID"
export APPLE_PASSWORD="@keychain:AC_PASSWORD"  # App-specific password

# Build + sign + notarize
./build-macos.sh --arch arm64 --sign --notarize
```

Unsigned apps require: Right-click .app → Open, or allow in System Settings → Privacy & Security.
</details>

#### Windows

```bash
# One-click build from WSL (output to Downloads)
make desktop-build-win
```

#### Generic Production Build

```bash
# Tauri production build (current platform)
make desktop-build
```

---

## Configuration

### Server Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--port` | `8080` | HTTP server port |
| `--bind` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN access) |
| `--ttl` | 5m | Session survival time without clients |
| `--grace` | 60s | Time to preserve identity after disconnect |
| `--ring-buffer` | 256KB | Buffer size during Draining state |
| `--log-dir` | none | Log directory for session recording |
| `--parent-pid` | 0 | Parent process PID (sidecar lifecycle binding) |
| `--verbose` | `false` | Enable verbose debug logging |

### Client Settings

```typescript
interface AppSettings {
  // Appearance
  theme: string;                   // Terminal theme name
  colorScheme: ColorScheme;        // Color scheme (auto/dark/darker/navy/light)
  opacity: number;                 // Window opacity (%)
  fontSize: number;                // Terminal font size
  fontFamily: string;              // Font key
  enableNerdFont: boolean;         // Nerd Font toggle
  enableLigatures: boolean;        // Programming ligatures
  enableBoldFont: boolean;         // Bold font weight
  encoding: string;                // Encoding
  language: 'en' | 'zh';           // UI language

  // Background
  backgroundImage: string;         // Background image path
  backgroundImageOpacity: number;  // Background image opacity (%)

  // Window & Layout
  rememberWindowSize: boolean;     // Remember window size
  windowWidth: number;             // Window width
  windowHeight: number;            // Window height
  rememberDrawerLayout: boolean;   // Remember drawer layout
  drawerHeight: number;            // Drawer height
  drawerSidebarWidth: number;      // Drawer sidebar width
  fileManagerFontSize: number;     // File manager font size

  // AI
  aiProviders: AIProviderEntry[];  // AI provider list
  aiActiveModel: string;           // Active model
  aiTemperature: number;           // Model temperature
  aiMaxTokens: number;             // Max tokens
  aiContextLines: number;          // Terminal context lines
  aiBarOpacity: number;            // AI capsule opacity

  // Notifications
  enableTerminalNotifications: boolean; // Terminal event desktop notifications
  previewRefreshRate: number;      // Preview refresh rate
}
```

---

## Session Recording Format

Binary log, each record:

```
[timestamp: int64 LE][direction: 1 byte][length: uint32 LE][data: N bytes]
```

**Direction markers:**

- `'i'` — User keyboard input
- `'o'` — PTY output
- `'r'` — Terminal resize event
- `'e'` — Session lifecycle event

---

## Tech Stack

- **Backend**: Go 1.25+, gorilla/websocket, creack/pty, pkg/sftp, grandcat/zeroconf
- **Frontend**: TypeScript, Vite, xterm.js 5.x
- **Desktop**: Tauri v2 (Rust + TypeScript), tokio, reqwest, keyring
- **Update**: Tauri Updater + Cloudflare Worker

---

## License

MIT License
