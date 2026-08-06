<div align="center">

<img src="docs/images/logo.png" alt="MeTerm Logo" width="128">

# MeTerm

**Multi-client shared terminal session system — Real-time terminal collaboration**

[![Build macOS](https://img.shields.io/github/actions/workflow/status/paidaxingyo666/MeTerm/build-macos.yml?style=flat-square&logo=apple&label=macOS)](https://github.com/paidaxingyo666/MeTerm/actions/workflows/build-macos.yml)
[![Build Windows](https://img.shields.io/github/actions/workflow/status/paidaxingyo666/MeTerm/build-windows.yml?style=flat-square&logo=windows&label=Windows)](https://github.com/paidaxingyo666/MeTerm/actions/workflows/build-windows.yml)
[![Build Linux](https://img.shields.io/github/actions/workflow/status/paidaxingyo666/MeTerm/build-linux.yml?style=flat-square&logo=linux&label=Linux)](https://github.com/paidaxingyo666/MeTerm/actions/workflows/build-linux.yml)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/github/v/release/paidaxingyo666/MeTerm?style=flat-square&color=brightgreen)](https://github.com/paidaxingyo666/MeTerm/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/paidaxingyo666/MeTerm/total?style=flat-square&color=orange)](https://github.com/paidaxingyo666/MeTerm/releases)

[中文](./README_CN.md) · [Download](#download) · [Quick Start](#quick-start) · [Docs](#documentation) · [Acknowledgements](#acknowledgements)

</div>

---

## Screenshots

| Terminal | Split Pane |
|:---:|:---:|
| ![terminal](docs/images/terminal.png) | ![split-pane](docs/images/split-pane.png) |

| SFTP File Manager | Home Search |
|:---:|:---:|
| ![file-manager](docs/images/file-manager.png) | ![home-search](docs/images/home-search.png) |

| JumpServer Asset Browser | JumpServer Terminal | JumpServer File Manager |
|:---:|:---:|:---:|
| ![jumpserver-browser](docs/images/jumpserver-3.png) | ![jumpserver-terminal](docs/images/jumpserver-2.png) | ![jumpserver-files](docs/images/jumpserver-1.png) |

| Picture-in-Picture |
|:---:|
| ![pip](docs/images/pip.png) |

| AI Assistant | Settings |
|:---:|:---:|
| ![ai-capsule](docs/images/ai-capsule.png) | ![settings](docs/images/settings.png) |

---

## Key Features

**Four session types:**

- **Local Terminal** — Out-of-the-box local shell sessions
- **SSH Remote** — Password/key authentication to remote servers
- **JumpServer** — Browse and connect bastion host assets (tested v2 & v4, supports MFA authentication)
- **Remote Sharing** — Join shared sessions on other MeTerm devices in the LAN

**Tab management:**

- Multi-tab with drag-to-reorder, drag tab out to create new window
- Split pane layout (horizontal/vertical, independent sessions per pane)
- Picture-in-Picture (PiP) floating window

**Terminal enhancements:**

- AI Assistant & Agent — Floating dialog or side panel, supports OpenAI-compatible / Anthropic / Gemini protocols; Agent mode adds multi-pane awareness, file transfer, task planning, structured search, and per-session PTY lock
- SFTP File Manager — Breadcrumb navigation, keyboard nav, file search, multi-select, remote copy/move, chmod, bookmarks, speed limit, transfer notifications, drag-and-drop, resume, parallel high-speed transfers via adaptive SFTP pipeline
- Built-in Editor — Remote file editing, Markdown preview, image preview, word wrap, multi-format formatting (JSON/XML/HTML/CSS)
- Shell Hook Integration — OSC 7766/7768 semantic prompts: click-to-move cursor, drag-select-to-edit in command area; automatic fallback when hook is unavailable
- Command completion & tldr help cards
- Home quick search — Local commands + web search (requires self-hosted [SearXNG](https://github.com/searxng/searxng))
- Themes & Backgrounds — 8 terminal themes, Neo-Brutalism theme (standard + rounded variants, 11 presets: Cyberpunk / Abyss / Lavender / Midnight / Candy / Retro / Aurora / Dracula / Exposure / Pure Black series + custom palette with real-time cross-window sync)
- Terminal font enhancements — Font weight control, text sharpening, font size shortcuts (Ctrl/Cmd +/-)
- Session recording & replay

**Collaboration & networking:**

- Multi-client sharing — Multiple users on the same terminal in real-time
- Role-based access control — Master / Viewer / ReadOnly with role transfer
- mDNS/Bonjour service discovery — System Bonjour publication on macOS, portable discovery on Windows/Linux
- Auto-reconnection — Ring buffer for missed data

**Other:**

- Windows right-click menu integration (Open in MeTerm)
- Clickable file paths in terminal output (open files/folders directly)
- SSH proxy support — SOCKS5 / HTTP CONNECT, independent proxy config per JumpServer
- OSC enhancements — OSC 52 clipboard passthrough, OSC 8 hyperlinks, image display protocol
- Chrome-style tab switching shortcuts (Ctrl/Cmd 1-9)
- Window always-on-top pin button
- Auto-create local session on startup (optional)
- Auto updates · Internationalization (EN/ZH) · Desktop notifications

---

## Platform Support

| Platform | Architecture | Status |
|----------|-------------|--------|
| macOS | Apple Silicon (arm64) | ✅ Supported |
| macOS | Intel (x86_64) | ✅ Supported |
| Windows | x64 | ✅ Supported |
| Linux | x64 (amd64) | ✅ Supported (tested on Ubuntu 24.04) |
| Linux | arm64 | ✅ Supported (tested on Ubuntu 24.04) |

---

## Download

<p align="center">
  <a href="https://github.com/paidaxingyo666/MeTerm/releases/latest"><img src="https://img.shields.io/badge/macOS-Download-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS"></a>
  &nbsp;&nbsp;
  <a href="https://github.com/paidaxingyo666/MeTerm/releases/latest"><img src="https://img.shields.io/badge/Windows-Download-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows"></a>
  &nbsp;&nbsp;
  <a href="https://github.com/paidaxingyo666/MeTerm/releases/latest"><img src="https://img.shields.io/badge/Linux-Download-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Download for Linux"></a>
</p>

| Platform | Installer |
|----------|-----------|
| macOS (Apple Silicon) | `MeTerm_x.x.x_aarch64.dmg` |
| macOS (Intel) | `MeTerm_x.x.x_x64.dmg` |
| Windows (x64) | `MeTerm_x.x.x_x64-setup.exe` |
| Linux (amd64) | `.deb` / `.AppImage` / `.rpm` |
| Linux (arm64) | `.deb` / `.AppImage` / `.rpm` |

> [!NOTE]
> **Linux**: Only tested on **Ubuntu 24.04**. Other distributions have not been tested yet — feedback and bug reports are welcome.

> [!NOTE]
> **macOS**: Public v0.2.11 builds use Developer ID signing, notarization, and
> stapling. Every newer release candidate must independently pass the signing,
> notarization, and Keychain upgrade checks in `docs/RELEASE_CHECKLIST.md` before
> distribution; an unsigned local development build is not a release artifact.

---

## Quick Start

### Prerequisites

| Dependency | Version | Installation |
|------------|---------|-------------|
| **Node.js** | 20+ | [nodejs.org](https://nodejs.org/) or `brew install node` |
| **Rust** | latest stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **Make** | — | macOS built-in; Linux: `sudo apt install build-essential` |

### Development Setup

```bash
# Clone the repository
git clone https://github.com/paidaxingyo666/MeTerm.git
cd MeTerm

# Install desktop frontend dependencies
cd desktop && npm install && cd ..

# Start desktop app in dev mode
make desktop-dev
```

For macOS mobile-control or relay validation, use the isolated, Apple
Development-signed bundle instead of the unsigned hot-reload executable:

```bash
make desktop-run-dev              # Builds/signs and opens MeTerm Dev.app (com.meterm.dev)
```

This target never opens or overwrites an installed production `MeTerm.app`.
Use the same signing identity on later rebuilds so development Keychain access
continues to match the app's designated requirement.

`desktop-build-dev` is the only supported target that enables the
`development-credential-recovery` feature (together with
`development-mobile-control`). The feature is rejected in Release builds and
the import command additionally verifies the exact signed `MeTerm Dev.app`
identity before it can run.

`MeTerm Dev` never scans the production Keychain at startup. To recover one
missing development credential, right-click that saved SSH connection and use
the development-only import action. Only that connection's exact authority is
shown in the native owner-presence prompt. In any macOS Keychain dialog choose
**Allow**, never **Always Allow**. This action may read only the quarantined
production `com.meterm.app.ssh.v2` item and can never read the clean production
v3 vault. A bound v2 item must match the authority; an unbound v2 item is bound
only after the explicit owner confirmation describing that possibility. The
source remains unchanged, the copy is written to the isolated Dev service,
cancellation is not retried on a later launch, and normal Dev runtime never
falls back to a production vault. Desktop private-key paths are deliberately
not copied from v2; reselect the file locally so the native confirmation can
show the exact normalized path. A desktop key-ladder grant copies no production
secret bytes and writes only a fresh authority marker after owner confirmation.

Normal startup also does not open Keychain for old localStorage/name-keyed SSH,
Remote, JumpServer, or settings credentials. It only inspects Web Storage and
records redacted pending/manual/complete states or a non-secret presence cache.
Re-save the corresponding connection/settings when needed. Until the formal,
owner-confirmed recovery UI is implemented, old credentials are not claimed as
recoverable by the distributed app.

Windows development (from WSL):

```bash
make desktop-dev-win              # Start dev
```

<details>
<summary><b>Build Installers</b></summary>

#### macOS

```bash
make release-macos                # Current architecture
make release-macos-arm64          # Apple Silicon
make release-macos-x86_64         # Intel
make release-macos-all            # Build both architectures

# Code signing uses an existing local Keychain identity; it never exports the private key.
APPLE_SIGNING_IDENTITY='Developer ID Application: …' \
  ./build-macos.sh --arch arm64 --sign

# Notarization additionally requires APPLE_API_KEY_ID, APPLE_API_ISSUER_ID,
# and APPLE_API_KEY_PATH pointing to a local App Store Connect .p8 file.
APPLE_SIGNING_IDENTITY='Developer ID Application: …' \
  ./build-macos.sh --arch arm64 --sign --notarize
```

#### Windows

```bash
make desktop-build-win            # One-click build from WSL
```

#### Generic

```bash
make desktop-build                # Tauri production build (current platform)
```

</details>

---

## Architecture

Since v0.2.0, MeTerm has migrated from a Go sidecar architecture to a **pure Rust in-process backend**, eliminating external process management and inter-process communication overhead.

```text
MeTerm/
├── desktop/              # Tauri v2 desktop app
│   ├── src/              #   Frontend TypeScript (90+ modules)
│   │   ├── ai-capsule*   #     AI assistant (floating dialog, tools, agent)
│   │   ├── file-manager  #     SFTP file manager
│   │   ├── session       #     Session management (Tauri IPC)
│   │   ├── terminal-*    #     Terminal instances (local/remote)
│   │   ├── split-pane    #     Split pane layout
│   │   └── ...
│   └── src-tauri/        #   Rust backend
│       └── src/
│           ├── commands/  #     Tauri IPC commands (session, window, menu, AI, etc.)
│           └── server/    #     In-process HTTP/WebSocket server
│               ├── session/    # Session state machine & manager
│               ├── terminal/   # Cross-platform PTY (Unix/Windows/WSL/SSH)
│               ├── executor/   # Local & SSH executors
│               ├── jumpserver/ # JumpServer asset browser
│               ├── dispatch    # Binary protocol message routing
│               ├── file_handler# File transfer (SFTP adaptive pipeline)
│               ├── auth        # Bearer token authentication
│               ├── discover    # mDNS service discovery
│               └── ...
├── frontend/             # Standalone web frontend (xterm.js + Vite)
├── control-broker/       # Standalone fail-closed control-plane protocol core (Release scopes blocked)
├── cloudflare-worker/    # CF Worker auto-update service
└── scripts/              # Build helper scripts
```

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| **Backend** | Rust, Axum, Tokio, xpty (cross-platform PTY), russh (SSH/SFTP terminal path), ssh2/libssh2 (desktop SSH file transfer), mdns-sd |
| **Frontend** | TypeScript, Vite, xterm.js 5.x, CodeMirror 6 |
| **Desktop** | Tauri v2 (Rust + TypeScript), reqwest, keyring, rusqlite |
| **Control Broker** | Standalone Rust process/protocol core; platform service adapters are not release-ready |
| **Update** | Tauri Updater + Cloudflare Worker |

### Architecture Highlights

- **Single-process** — Backend server runs in-process via Tokio, no external sidecar management
- **Cross-platform PTY** — Unified abstraction over Unix PTY, Windows ConPTY, WSL, and SSH
- **Session state machine** — Created → Running → Draining (with ring buffer) → Closed, supporting seamless reconnection
- **Binary protocol** — Custom binary messaging over WebSocket for efficient terminal I/O
- **Adaptive SFTP pipeline** — Dynamic window scaling (2→64) based on RTT for high-throughput file transfers
- **Desktop SSH transfer backend** — Desktop SSH uploads and downloads can use a dedicated native transfer path to avoid terminal-path bottlenecks

---

## Documentation

| Document | Description |
|----------|-------------|
| [REST API Reference](docs/API.md) | Complete API endpoints and usage examples |
| [Binary Protocol](docs/PROTOCOL.md) | WebSocket binary communication protocol spec |
| [Configuration](docs/CONFIGURATION.md) | Server parameters, client settings, role system |
| [Session Recording](docs/RECORDING.md) | Recording format and playback |

---

## Contributing

Issues and Pull Requests are welcome!

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## Acknowledgements

MeTerm is built on top of many excellent open-source projects. Thanks to all contributors!

See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for full third-party license details.

---

## License

[MIT License](LICENSE)
