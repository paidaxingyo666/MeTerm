# MeTerm

> 多端共享终端会话系统 — 让多人实时协作同一个终端

[English](./README_EN.md)

---

## 项目简介

MeTerm 是一个支持多客户端同时连接的共享终端会话系统。它允许多个用户实时查看和操作同一个终端会话，支持本地终端和 SSH 远程连接，非常适合远程协作、教学演示、远程调试、AI 辅助编程等场景。

### 核心特性

- 🔗 **多客户端共享** — 多个用户可同时连接同一个终端会话，实时同步显示
- 🔐 **角色权限控制** — 支持 Master（完全控制）、Viewer（观察者）、ReadOnly（只读）三种角色
- 🔄 **断线自动重连** — 网络中断后自动重连，保留客户端身份和角色，环形缓冲区补发丢失数据
- 📹 **会话录制回放** — 支持终端会话的完整录制和精确回放（输入/输出/Resize 均记录）
- 🖥️ **SSH 远程连接** — 支持 SSH 连接到远程服务器，复用会话管理能力
- 📁 **SFTP 文件管理** — 内置文件管理抽屉，支持上传/下载/断点续传/拖拽操作
- 🖲️ **跨平台桌面应用** — 提供 Windows / macOS / Linux 原生桌面客户端
- 🤖 **AI 助手胶囊** — 每个终端会话独立的 AI 对话面板，支持多模型（OpenAI / Anthropic / Gemini）
- 🪟 **灵活分屏** — 二叉树布局，支持水平/竖直分割，各分屏独立会话
- 🖼️ **背景图片** — 终端背景图片库，支持缩略图预览和透明度调节
- 🔍 **mDNS 服务发现** — 局域网自动发现设备，无需手动输入 IP
- 🔄 **自动更新** — 内置应用更新检测与一键安装

---

## 架构概览

```
meterm/
├── backend/           # Go 后端服务
│   ├── cmd/           # CLI 入口
│   │   └── muxerd/main.go  # 服务启动
│   ├── api/           # REST API + WebSocket 处理
│   │   ├── handler.go      # 路由注册 + 会话 CRUD API
│   │   ├── ws.go           # WebSocket 处理器
│   │   ├── file_handler.go # 文件操作 WebSocket
│   │   ├── auth.go         # Token 认证中间件
│   │   ├── ban.go          # IP 禁用管理
│   │   ├── discover.go     # mDNS 服务发现
│   │   ├── pairing.go      # 设备配对 API
│   │   └── server_info.go  # 服务器资源监控
│   ├── session/       # 会话管理（状态机 + 环形缓冲区）
│   │   ├── manager.go      # SessionManager 生命周期
│   │   ├── session.go      # Session 核心逻辑
│   │   ├── client.go       # 客户端角色管理
│   │   ├── state.go        # 状态机定义
│   │   └── transfers.go    # 文件传输会话
│   ├── terminal/      # PTY/SSH 终端接口
│   │   ├── terminal.go     # Terminal 接口
│   │   ├── pty_unix.go     # Unix PTY 实现
│   │   ├── pty_windows.go  # Windows ConPTY 实现
│   │   └── ssh.go          # SSH 终端实现
│   ├── protocol/      # 二进制通信协议
│   │   ├── protocol.go     # 基础消息类型
│   │   └── file_messages.go # 文件操作消息
│   ├── executor/      # 执行器抽象
│   │   ├── executor.go     # Executor 接口
│   │   ├── local.go        # 本地 Shell 执行器
│   │   └── ssh.go          # SSH 执行器
│   ├── sftp/          # SFTP 客户端封装
│   ├── recording/     # 会话录制与回放
│   ├── internal/      # 内部实现（ConPTY 等）
│   └── web/           # 前端静态资源嵌入
├── frontend/          # Web 前端（xterm.js + WebSocket）
├── desktop/           # Tauri 桌面应用
│   └── src/
│       ├── terminal.ts     # xterm.js 终端封装
│       ├── connection.ts   # WebSocket 连接管理
│       ├── protocol.ts     # 二进制消息协议
│       ├── tabs.ts         # 多标签页管理
│       ├── tab-drag.ts     # 标签拖拽排序
│       ├── split-pane.ts   # 二叉树分屏布局
│       ├── ssh.ts          # SSH 连接模块
│       ├── remote.ts       # 远程服务器管理
│       ├── drawer.ts       # 抽屉面板（文件/进程/系统信息）
│       ├── file-manager.ts # 文件列表/操作
│       ├── ai-capsule.ts   # AI 助手胶囊 UI
│       ├── ai-agent.ts     # AI 对话逻辑
│       ├── ai-provider.ts  # 多 AI 提供商接口
│       ├── gallery.ts      # 背景图片库
│       ├── updater.ts      # 自动更新检测
│       ├── updater-window.ts # 更新窗口
│       ├── status-bar.ts   # 动态状态栏
│       ├── settings.ts     # 设置面板
│       ├── settings-window.ts # 设置窗口
│       ├── fonts.ts        # 字体管理
│       ├── themes.ts       # 主题/配色/背景
│       ├── notify.ts       # 桌面通知
│       ├── pairing.ts      # 设备配对
│       ├── home.ts         # 首页
│       ├── icons.ts        # 图标资源
│       ├── i18n.ts         # 国际化
│       └── window-utils.ts # 窗口工具
└── cloudflare-worker/ # CF Worker 自动更新服务
```

---

## 功能详解

### 1. 会话生命周期

```
          ┌──────────┐
          │ Created  │  等待首个客户端连接
          └────┬─────┘
               │ 客户端连接
               ▼
          ┌──────────┐
     ┌───>│ Running  │  客户端在线，PTY 输出广播给所有人
     │    └────┬─────┘
     │         │ 最后一个客户端断开
     │         ▼
     │    ┌──────────┐
     │    │ Draining │  无客户端，PTY 输出写入环形缓冲区
     │    └────┬─────┘  TTL 倒计时（默认 5 分钟）
     │         │
     │    ┌────┴────────────┐
     │    │                 │
     │    ▼                 ▼
     └── 重连           ┌──────────┐
                       │  Closed  │  会话关闭，资源释放
                       └──────────┘
```

### 2. 客户端角色系统

| 角色 | 值 | 输入 | 调整大小 | 可提升 | 适用场景 |
|------|-----|------|----------|--------|----------|
| Viewer | 0 | ✗ | ✗ | ✓ | 观察者，可被提升为 Master |
| Master | 1 | ✓ | ✓ | — | 完全控制，同时只有一个 |
| ReadOnly | 2 | ✗ | ✗ | ✗ | AI/机器人，永不提升 |

**角色转移机制：**
- Viewer 可发送 `MsgMasterRequest` 请求成为 Master
- 当前 Master 收到 `MsgMasterRequestNotify` 通知
- Master 可批准/拒绝请求
- 支持主动 `MsgMasterReclaim` 收回控制权

### 3. SSH 远程连接

支持通过 SSH 连接到远程服务器：
- 密码认证 / SSH 密钥认证
- 自定义端口（默认 22）
- 复用本地会话的所有功能（录制、多客户端、权限控制）
- SSH 会话自动启用 SFTP 文件管理

### 4. SFTP 文件管理抽屉

SSH 会话中可用的文件管理功能：
- **文件浏览** — 列表视图，支持排序
- **上传/下载** — 分块传输，实时进度
- **断点续传** — 网络中断后自动恢复
- **拖拽操作** — 从本地拖入上传，拖出下载
- **文件操作** — 删除、重命名、新建文件夹、压缩/解压
- **服务器监控** — 实时显示 CPU/内存/磁盘使用率
- **大目录优化** — 100+ 文件时发送加载进度更新

### 5. 分屏布局

二叉树分屏系统：
- **水平/竖直分割** — 将当前面板一分为二
- **独立会话** — 每个分屏窗格有独立的终端会话
- **配比调整** — 拖动分割线调整面板大小（比例 0-1）
- **嵌套分割** — 支持任意层级的嵌套分屏

### 6. 终端字体与主题

**内置字体（woff2 格式，离线可用）：**

| 字体 | 连字 | Nerd Font |
|------|------|-----------|
| JetBrains Mono | ✅ | ✅ |
| Fira Code | ✅ | ✅ |
| Cascadia Code | ✅ | ✅ |
| Source Code Pro | ❌ | ✅ |
| Hack | ❌ | ✅ |
| Iosevka | ✅ | ✅ |
| Menlo (系统) | ❌ | ❌ |

**外观配置：**
- 8 个内置终端主题
- 5 种配色方案（auto / dark / darker / navy / light）
- 终端背景图片 + 透明度调节
- Nerd Font 开关（图标字体）
- 编程连字开关
- 加粗字重
- 多种编码支持：UTF-8、GBK、GB18030、Big5、EUC-JP、EUC-KR

### 7. AI 助手胶囊

每个终端会话独立的浮动 AI 对话框：
- 两种状态：收起（圆形图标）/ 展开（胶囊面板）
- **多 AI 提供商** — OpenAI / Anthropic / Gemini，可自定义 API 端点
- 模型选择器，支持动态获取模型列表
- 两种发送模式：
  - **发送命令 (⌘)** — 直接发送到终端执行
  - **发送提示 (✦)** — 与 AI 对话
- 可拖拽定位
- 可配置温度、最大 Token 数、上下文行数

### 8. 动态状态栏

胶囊式状态栏：

**常驻胶囊（左区）：**
- 连接状态 — 颜色编码 + 呼吸/闪烁动画
- 延迟测量 — Ping/Pong RTT，5 秒均值
- 会话计数 — 多标签页时显示

**活动胶囊（右区）：**
- 文件传输 — 上传/下载进度条
- AI 状态 — 思考中动画

### 9. 桌面端特性

- **分屏终端** — 水平/竖直分割，独立会话
- **多窗口支持** — Tab 拖拽到空白区域创建新窗口
- **单 Tab 保护** — 单标签窗口拖动移动整个窗口
- **背景图片** — 图片库管理，缩略图预览，透明度调节
- **自动更新** — 内置版本检测 + 一键更新安装
- **系统托盘** — 后台运行，托盘菜单控制，更新徽章
- **国际化** — 中英双语，托盘菜单跟随语言
- **桌面通知** — 终端事件通知

### 10. mDNS 服务发现

局域网自动设备发现：
- 服务类型：`_meterm._tcp.local.`
- 扫描超时：10 秒（默认 5 秒）
- 返回设备名、IP、端口
- 支持启用/禁用广播

---

## 二进制协议

WebSocket 使用高效的二进制协议：

**帧格式：** `[type: 1 byte][payload: N bytes]`

| 消息类型 | Hex | 方向 | 说明 |
|----------|-----|------|------|
| Output | 0x01 | S→C | PTY 输出流 |
| Input | 0x02 | C→S | 键盘输入 |
| Resize | 0x03 | C→S | 终端大小变化 |
| Ping | 0x04 | C→S | 心跳请求 |
| Pong | 0x05 | S→C | 心跳响应 |
| SessionEnd | 0x06 | S→C | 会话结束 |
| Error | 0x07 | S→C | 错误通知 |
| RoleChange | 0x08 | S→C | 角色变更 |
| Hello | 0x09 | S→C | 握手/重连元数据 |
| FileList | 0x0A | C→S | 请求文件列表 |
| FileListResp | 0x0B | S→C | 文件列表响应 |
| FileUploadStart | 0x0C | C→S | 开始上传 |
| FileUploadChunk | 0x0D | C→S | 上传数据块 |
| FileDownloadStart | 0x0E | C→S | 开始下载 |
| FileDownloadChunk | 0x0F | S→C | 下载数据块 |
| FileOperation | 0x10 | C→S | 文件操作（删除/重命名等）|
| FileOperationResp | 0x11 | S→C | 文件操作响应 |
| ServerInfo | 0x12 | C⇄S | 服务器信息 |
| TransferProgress | 0x13 | S→C | 传输进度 |
| UploadResume | 0x14 | C→S | 恢复上传 |
| DownloadResume | 0x15 | C→S | 恢复下载 |
| FileListProgress | 0x16 | S→C | 大目录加载进度 |
| SetEncoding | 0x17 | C→S | 设置终端编码 |
| Nudge | 0x18 | C→S | 请求 PTY SIGWINCH |
| MasterRequest | 0x19 | C→S | 请求成为 Master |
| MasterRequestNotify | 0x1A | S→C | 通知当前 Master |
| MasterApproval | 0x1B | C→S | 批准/拒绝请求 |
| MasterReclaim | 0x1C | C→S | Master 收回控制权 |
| PairNotify | 0x1D | S→C | 配对请求通知 |
| PairApproval | 0x1E | C→S | 配对审批结果 |
| FileDownloadPause | 0x20 | C→S | 暂停下载 |
| FileDownloadContinue | 0x21 | C→S | 恢复已暂停的下载 |
| FileDownloadCancel | 0x22 | C→S | 取消下载 |

---

## 快速开始

### 环境要求

- Go 1.25+
- Node.js 20+
- Rust (rustup)
- Make

### 启动开发环境

```bash
# 克隆项目
git clone https://github.com/paidaxingyo666/meterm.git
cd meterm

# 安装前端依赖
cd frontend && npm install && cd ..

# 启动后端 + 前端（并行）
make dev
```

访问 http://localhost:5174 即可使用。

### 单独启动

```bash
# 仅启动后端（端口 8080）
make backend

# 仅启动前端（端口 5174）
make frontend
```

---

## 使用方式

### 创建会话

```bash
# 通过 REST API 创建新会话
curl -X POST http://localhost:8080/api/sessions
# 返回: {"id": "xxx-xxx-xxx", "state": "created", ...}
```

### 连接终端

在浏览器中访问 `http://localhost:5174?session=<session-id>` 即可连接。

### WebSocket 连接

```
ws://localhost:8080/ws/<session-id>
ws://localhost:8080/ws/<session-id>?client_id=<id>      # 重连
ws://localhost:8080/ws/<session-id>?mode=readonly       # 只读模式
```

### 会话管理 CLI

```bash
# 构建 CLI 工具
cd backend && go build -o ../bin/meterm ./cmd/muxerd

# 列出所有会话
./bin/meterm --addr http://localhost:8080 sessions ls

# 查看会话详情
./bin/meterm sessions inspect <session-id>

# 终止会话
./bin/meterm sessions kill <session-id>
```

---

## REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/sessions` | 创建本地会话 |
| `GET` | `/api/sessions` | 列出所有会话 |
| `GET` | `/api/sessions/:id` | 获取会话详情 |
| `DELETE` | `/api/sessions/:id` | 删除会话 |
| `POST` | `/api/sessions/ssh` | 创建 SSH 会话 |
| `POST` | `/api/sessions/ssh/test` | 测试 SSH 连接 |
| `POST` | `/api/sessions/:id/master` | 切换 Master 角色 |
| `POST` | `/api/sessions/:id/private` | 设置会话私有模式 |
| `DELETE` | `/api/sessions/:id/clients/:cid` | 踢出客户端 |
| `GET` | `/api/clients` | 列出所有客户端 |
| `GET` | `/api/devices` | 列出所有已知设备 |
| `GET` | `/api/info` | 获取服务信息 |
| `POST` | `/api/discover` | mDNS 扫描局域网设备 |
| `POST` | `/api/discoverable` | 切换 mDNS 可发现性 |
| `POST` | `/api/pair` | 创建配对请求 |
| `GET` | `/api/pair/:id?secret=xxx` | 查询配对状态 |
| `GET` | `/api/pair/pending` | 列出待批准的配对 |
| `POST` | `/api/pair/:id/respond` | 批准/拒绝配对 |
| `GET` | `/api/token` | 获取当前 Token |
| `POST` | `/api/token/refresh` | 刷新 Token |
| `POST` | `/api/token/revoke-all` | 撤销所有 Token |
| `GET` | `/api/banned-ips` | 列出被禁用的 IP |
| `GET` | `/api/ping` | 健康检查（无需认证）|

---

## 桌面应用

### 开发模式

```bash
# 构建桌面端 sidecar
make desktop-sidecar

# 开发模式运行（macOS / Linux）
make desktop-dev

# Windows 开发（从 WSL 执行）
# 前置条件：Windows 侧需安装 Node.js、Rust/Cargo、Go
make desktop-dev-win-rebuild    # 开发模式（重建 Go sidecar）
make desktop-dev-win            # 开发模式（不重建 Go sidecar）
# Go 后端有改动时，务必使用带 rebuild 的命令
```

### 构建安装包

#### macOS

**环境要求：** Go 1.25+, Rust (rustup), Node.js 20+

```bash
# 构建当前架构的 DMG 安装包
make release-macos

# 指定架构构建
make release-macos-arm64        # Apple Silicon (M1/M2/M3/M4)
make release-macos-x86_64       # Intel Mac
make release-macos-all          # 同时构建两个架构

# 启用代码签名（需要 Apple Developer ID 证书）
./build-macos.sh --arch arm64 --sign

# 完整选项
./build-macos.sh --help
```

构建产物输出到 `dist/` 目录：
```
dist/
├── MeTerm_0.1.0_aarch64-arm64.dmg    # Apple Silicon
└── MeTerm_0.1.0_x86_64-x86_64.dmg    # Intel
```

<details>
<summary>代码签名与公证配置</summary>

签名需要 Apple Developer Program 会员资格和 Developer ID Application 证书。

```bash
# 设置签名环境变量
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="your@email.com"
export APPLE_TEAM_ID="TEAMID"
export APPLE_PASSWORD="@keychain:AC_PASSWORD"  # App-specific password

# 构建 + 签名 + 公证
./build-macos.sh --arch arm64 --sign --notarize
```

未签名的应用安装时需要：右键点击 .app → 打开，或在「系统设置 → 隐私与安全性」中允许。
</details>

#### Windows

```bash
# 从 WSL 一键构建安装包（输出到 Downloads）
make desktop-build-win
```

#### 通用生产构建

```bash
# Tauri 生产构建（当前平台）
make desktop-build
```

---

## 配置选项

### 服务端参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port` | `8080` | HTTP 服务端口 |
| `--bind` | `127.0.0.1` | 绑定地址（`0.0.0.0` 允许局域网访问）|
| `--ttl` | 5m | 无客户端后会话存活时间 |
| `--grace` | 60s | 断线后保留身份的时间 |
| `--ring-buffer` | 256KB | Draining 期间的缓冲区大小 |
| `--log-dir` | 无 | 启用会话录制的日志目录 |
| `--parent-pid` | 0 | 父进程 PID（用于 sidecar 生命周期绑定）|
| `--verbose` | `false` | 启用详细调试日志 |

### 客户端设置

```typescript
interface AppSettings {
  // 外观
  theme: string;                   // 终端主题名称
  colorScheme: ColorScheme;        // 配色方案 (auto/dark/darker/navy/light)
  opacity: number;                 // 窗口透明度 (%)
  fontSize: number;                // 终端字号
  fontFamily: string;              // 字体 key
  enableNerdFont: boolean;         // Nerd Font 开关
  enableLigatures: boolean;        // 编程连字
  enableBoldFont: boolean;         // 加粗字重
  encoding: string;                // 编码方式
  language: 'en' | 'zh';           // 界面语言

  // 背景
  backgroundImage: string;         // 背景图片路径
  backgroundImageOpacity: number;  // 背景图片透明度 (%)

  // 窗口与布局
  rememberWindowSize: boolean;     // 记住窗口尺寸
  windowWidth: number;             // 窗口宽度
  windowHeight: number;            // 窗口高度
  rememberDrawerLayout: boolean;   // 记住抽屉布局
  drawerHeight: number;            // 抽屉高度
  drawerSidebarWidth: number;      // 抽屉侧栏宽度
  fileManagerFontSize: number;     // 文件管理器字号

  // AI
  aiProviders: AIProviderEntry[];  // AI 提供商列表
  aiActiveModel: string;           // 当前活跃模型
  aiTemperature: number;           // 模型温度
  aiMaxTokens: number;             // 最大 Token 数
  aiContextLines: number;          // 终端上下文行数
  aiBarOpacity: number;            // AI 胶囊透明度

  // 通知
  enableTerminalNotifications: boolean; // 终端事件桌面通知
  previewRefreshRate: number;      // 预览刷新率
}
```

---

## 会话录制格式

二进制日志，每条记录：

```
[timestamp: int64 LE][direction: 1 byte][length: uint32 LE][data: N bytes]
```

**方向标记：**
- `'i'` — 用户键盘输入
- `'o'` — PTY 输出
- `'r'` — 终端 Resize 事件
- `'e'` — 会话生命周期事件

---

## 技术栈

- **Backend**: Go 1.25+, gorilla/websocket, creack/pty, pkg/sftp, grandcat/zeroconf
- **Frontend**: TypeScript, Vite, xterm.js 5.x
- **Desktop**: Tauri v2 (Rust + TypeScript), tokio, reqwest, keyring
- **Update**: Tauri Updater + Cloudflare Worker

---

## 许可证

MIT License
