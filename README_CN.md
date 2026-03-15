<div align="center">

<img src="docs/images/logo.png" alt="MeTerm Logo" width="128">

# MeTerm

**多端共享终端会话系统 — 让多人实时协作同一个终端**

[![Build macOS](https://img.shields.io/github/actions/workflow/status/paidaxingyo666/MeTerm/build-macos.yml?style=flat-square&logo=apple&label=macOS)](https://github.com/paidaxingyo666/MeTerm/actions/workflows/build-macos.yml)
[![Build Windows](https://img.shields.io/github/actions/workflow/status/paidaxingyo666/MeTerm/build-windows.yml?style=flat-square&logo=windows&label=Windows)](https://github.com/paidaxingyo666/MeTerm/actions/workflows/build-windows.yml)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/github/v/release/paidaxingyo666/MeTerm?style=flat-square&color=brightgreen)](https://github.com/paidaxingyo666/MeTerm/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/paidaxingyo666/MeTerm/total?style=flat-square&color=orange)](https://github.com/paidaxingyo666/MeTerm/releases)

[English](./README.md) · [下载安装](#下载安装) · [快速开始](#快速开始) · [文档](#文档) · [开源致谢](#开源致谢)

</div>

---

## 截图预览

| 终端主界面 | 分屏布局 |
|:---:|:---:|
| ![terminal](docs/images/terminal.png) | ![split-pane](docs/images/split-pane.png) |

| SFTP 文件管理 | 主页搜索 |
|:---:|:---:|
| ![file-manager](docs/images/file-manager.png) | ![home-search](docs/images/home-search.png) |

| JumpServer 资产浏览 | JumpServer 终端 | JumpServer 文件管理 |
|:---:|:---:|:---:|
| ![jumpserver-browser](docs/images/jumpserver-3.png) | ![jumpserver-terminal](docs/images/jumpserver-2.png) | ![jumpserver-files](docs/images/jumpserver-1.png) |

| 画中画 |
|:---:|
| ![pip](docs/images/pip.png) |

| AI 助手 | 设置面板 |
|:---:|:---:|
| ![ai-capsule](docs/images/ai-capsule.png) | ![settings](docs/images/settings.png) |

---

## 核心特性

**四种会话类型：**

- **本地终端** — 开箱即用的本地 Shell 会话
- **SSH 远程连接** — 密码/密钥认证，连接远程服务器
- **JumpServer 堡垒机** — 浏览并连接堡垒机资产（已测试 v2 与 v4，支持 MFA 认证）
- **远程共享** — 连接局域网内其他 MeTerm 设备，加入共享会话

**标签页管理：**

- 多标签页，拖拽排序，拖出标签创建新窗口
- 分屏布局（水平/竖直分割，各分屏独立会话）
- 画中画（PiP）浮动窗口

**终端增强：**

- AI 助手胶囊 — 浮动对话面板，支持 OpenAI 兼容 / Anthropic / Gemini 三种协议，可接入任意 LLM
- SFTP 文件管理 — 上传/下载/断点续传/拖拽/队列/远程文件直接编辑
- 命令补全 & tldr 帮助卡片
- 主页快速搜索 — 本地命令 + Web 搜索（需自建 [SearXNG](https://github.com/searxng/searxng) 实例）
- 背景图片 & 主题 — 8 个终端主题，5 种配色
- 会话录制回放

**协作与网络：**

- 多客户端共享 — 多人实时连接同一终端
- 角色权限控制 — Master / Viewer / ReadOnly，支持权限转移
- mDNS 服务发现 — 局域网自动发现设备
- 断线自动重连 — 环形缓冲区补发丢失数据

**其他：**

- Windows 右键菜单集成（在 MeTerm 中打开）
- 终端内文件路径可点击（直接打开文件/文件夹）
- 自动更新 · 国际化（中/英） · 桌面通知

---

## 平台支持

| 平台 | 架构 | 状态 |
|------|------|------|
| macOS | Apple Silicon (arm64) | ✅ 已支持 |
| macOS | Intel (x86_64) | ✅ 已支持 |
| Windows | x64 | ✅ 已支持 |
| Linux | x64 | 🚧 计划中 |

---

## 下载安装

<p align="center">
  <a href="https://github.com/paidaxingyo666/MeTerm/releases/latest"><img src="https://img.shields.io/badge/macOS-下载-000000?style=for-the-badge&logo=apple&logoColor=white" alt="macOS 下载"></a>
  &nbsp;&nbsp;
  <a href="https://github.com/paidaxingyo666/MeTerm/releases/latest"><img src="https://img.shields.io/badge/Windows-下载-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Windows 下载"></a>
</p>

| 平台 | 安装包 |
|------|--------|
| macOS (Apple Silicon) | `MeTerm_x.x.x_aarch64.dmg` |
| macOS (Intel) | `MeTerm_x.x.x_x64.dmg` |
| Windows (x64) | `MeTerm_x.x.x_x64-setup.exe` |

> [!WARNING]
> **macOS**：应用未经 Apple 签名，首次打开可能提示"已损坏"或"无法验证开发者"。请在终端执行以下命令后重新打开：
>
> ```bash
> sudo xattr -rd com.apple.quarantine /Applications/MeTerm.app
> ```

---

## 快速开始

### 环境要求

| 依赖 | 版本 | 安装方式 |
|------|------|----------|
| **Go** | 1.24+ | [golang.org/dl](https://golang.org/dl/) 或 `brew install go` |
| **Node.js** | 20+ | [nodejs.org](https://nodejs.org/) 或 `brew install node` |
| **Rust** | latest stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **Make** | — | macOS 自带；Linux: `sudo apt install build-essential` |

### 启动开发环境

```bash
# 克隆项目
git clone https://github.com/paidaxingyo666/MeTerm.git
cd MeTerm

# 安装桌面端前端依赖
cd desktop && npm install && cd ..

# 启动桌面应用开发模式（自动构建 Go sidecar）
make desktop-dev
```

Windows 开发（从 WSL 执行）：

```bash
make desktop-dev-win-rebuild      # 重建 Go sidecar + 启动开发
make desktop-dev-win              # 启动开发（跳过 sidecar 重建）
```

<details>
<summary><b>构建安装包</b></summary>

#### macOS

```bash
make release-macos                # 当前架构
make release-macos-arm64          # Apple Silicon
make release-macos-x86_64         # Intel
make release-macos-all            # 同时构建两个架构

# 代码签名（需要 Apple Developer ID）
./build-macos.sh --arch arm64 --sign
```

#### Windows

```bash
make desktop-build-win            # 从 WSL 一键构建
```

#### 通用

```bash
make desktop-build                # Tauri 生产构建（当前平台）
```

</details>

---

## 架构概览

```text
MeTerm/
├── backend/           # Go 后端（HTTP/WebSocket 服务、PTY/SSH、SFTP）
├── frontend/          # Web 前端（xterm.js + Vite）
├── desktop/           # Tauri v2 桌面应用（Rust + TypeScript）
│   ├── src/           #   前端 TypeScript 模块（90+ 文件）
│   └── src-tauri/     #   Rust 后端（Tauri 命令、sidecar 管理）
├── cloudflare-worker/ # CF Worker 自动更新服务
└── scripts/           # 构建辅助脚本
```

## 技术栈

| 层级 | 技术 |
|------|------|
| **后端** | Go, gorilla/websocket, creack/pty, pkg/sftp, grandcat/zeroconf |
| **前端** | TypeScript, Vite, xterm.js 5.x |
| **桌面** | Tauri v2 (Rust + TypeScript), tokio, reqwest, keyring |
| **更新** | Tauri Updater + Cloudflare Worker |

---

## 文档

| 文档 | 说明 |
|------|------|
| [REST API 参考](docs/API.md) | 完整的 API 接口列表和使用示例 |
| [二进制协议](docs/PROTOCOL.md) | WebSocket 二进制通信协议规范 |
| [配置参考](docs/CONFIGURATION.md) | 服务端参数、客户端设置、角色系统 |
| [会话录制](docs/RECORDING.md) | 录制格式和回放说明 |

---

## 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交修改 (`git commit -m 'Add amazing feature'`)
4. 推送分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

---

## 开源致谢

MeTerm 的诞生离不开以下优秀的开源项目，感谢所有贡献者！

完整的第三方许可证信息请参阅 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)。

---

## 许可证

[MIT License](LICENSE)
