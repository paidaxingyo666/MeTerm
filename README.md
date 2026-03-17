<div align="center">

<img src="docs/images/logo.png" alt="MeTerm Logo" width="128">

# MeTerm

**Multi-client shared terminal session system — Real-time terminal collaboration**

[![Build macOS](https://img.shields.io/github/actions/workflow/status/paidaxingyo666/MeTerm/build-macos.yml?style=flat-square&logo=apple&label=macOS)](https://github.com/paidaxingyo666/MeTerm/actions/workflows/build-macos.yml)
[![Build Windows](https://img.shields.io/github/actions/workflow/status/paidaxingyo666/MeTerm/build-windows.yml?style=flat-square&logo=windows&label=Windows)](https://github.com/paidaxingyo666/MeTerm/actions/workflows/build-windows.yml)
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

- AI Assistant Capsule — Floating dialog, supports OpenAI-compatible / Anthropic / Gemini protocols, connect any LLM
- SFTP File Manager — Upload/download/resume/drag-and-drop/queue/remote file editing
- Command completion & tldr help cards
- Home quick search — Local commands + web search (requires self-hosted [SearXNG](https://github.com/searxng/searxng))
- Backgrounds & Themes — 8 terminal themes, 5 color schemes
- Session recording & replay

**Collaboration & networking:**

- Multi-client sharing — Multiple users on the same terminal in real-time
- Role-based access control — Master / Viewer / ReadOnly with role transfer
- mDNS service discovery — Auto-discover devices on LAN
- Auto-reconnection — Ring buffer for missed data

**Other:**

- Windows right-click menu integration (Open in MeTerm)
- Clickable file paths in terminal output (open files/folders directly)
- Auto updates · Internationalization (EN/ZH) · Desktop notifications

---

## Platform Support

| Platform | Architecture | Status |
|----------|-------------|--------|
| macOS | Apple Silicon (arm64) | ✅ Supported |
| macOS | Intel (x86_64) | ✅ Supported |
| Windows | x64 | ✅ Supported |
| Linux | x64 | 🚧 Planned |

---

## Download

<p align="center">
  <a href="https://github.com/paidaxingyo666/MeTerm/releases/latest"><img src="https://img.shields.io/badge/macOS-Download-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download for macOS"></a>
  &nbsp;&nbsp;
  <a href="https://github.com/paidaxingyo666/MeTerm/releases/latest"><img src="https://img.shields.io/badge/Windows-Download-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download for Windows"></a>
</p>

| Platform | Installer |
|----------|-----------|
| macOS (Apple Silicon) | `MeTerm_x.x.x_aarch64.dmg` |
| macOS (Intel) | `MeTerm_x.x.x_x64.dmg` |
| Windows (x64) | `MeTerm_x.x.x_x64-setup.exe` |

> [!WARNING]
> **macOS**: The app is not Apple-signed. macOS may report it as "damaged" or "unverified developer". Run this command in Terminal, then reopen the app:
>
> ```bash
> sudo xattr -rd com.apple.quarantine /Applications/MeTerm.app
> ```

---

## Quick Start

### Prerequisites

| Dependency | Version | Installation |
|------------|---------|-------------|
| **Go** | 1.24+ | [golang.org/dl](https://golang.org/dl/) or `brew install go` |
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

# Start desktop app in dev mode (auto-builds Go sidecar)
make desktop-dev
```

Windows development (from WSL):

```bash
make desktop-dev-win-rebuild      # Rebuild Go sidecar + start dev
make desktop-dev-win              # Start dev (skip sidecar rebuild)
```

<details>
<summary><b>Build Installers</b></summary>

#### macOS

```bash
make release-macos                # Current architecture
make release-macos-arm64          # Apple Silicon
make release-macos-x86_64         # Intel
make release-macos-all            # Build both architectures

# Code signing (requires Apple Developer ID)
./build-macos.sh --arch arm64 --sign
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

```text
MeTerm/
├── backend/           # Go backend (HTTP/WebSocket, PTY/SSH, SFTP)
├── frontend/          # Web frontend (xterm.js + Vite)
├── desktop/           # Tauri v2 desktop app (Rust + TypeScript)
│   ├── src/           #   Frontend TypeScript modules (90+ files)
│   └── src-tauri/     #   Rust backend (Tauri commands, sidecar management)
├── cloudflare-worker/ # CF Worker auto-update service
└── scripts/           # Build helper scripts
```

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| **Backend** | Go, gorilla/websocket, creack/pty, pkg/sftp, grandcat/zeroconf |
| **Frontend** | TypeScript, Vite, xterm.js 5.x, CodeMirror 6 |
| **Desktop** | Tauri v2 (Rust + TypeScript), tokio, reqwest, keyring |
| **Update** | Tauri Updater + Cloudflare Worker |

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
