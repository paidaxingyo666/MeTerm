# Windows Support / Windows 支持

## Current Architecture / 当前架构

MeTerm is a native Windows Tauri v2 application. Its Axum HTTP/WebSocket
server, authentication, SSH implementation and terminal/session management are
Rust modules linked into the same process. There is no Go backend, sidecar
executable or WSL server deployment.

MeTerm 是原生 Windows Tauri v2 应用。Axum HTTP/WebSocket 服务、身份验证、
SSH 和终端/会话管理都是链接到同一进程的 Rust 模块。当前不存在 Go
后端、sidecar 可执行文件或部署到 WSL 内的服务。

```text
┌─ Windows: MeTerm.exe (one native Tauri/Rust process) ───────────┐
│  WebView UI                                                    │
│       ↕ local HTTP/WebSocket                                   │
│  In-process Rust server (Axum/Tokio/auth/SSH/session/relay)     │
│       ├─ Native shell: Windows ConPTY                         │
│       ├─ Optional Linux shell: wsl.exe + WSL PTY helper       │
│       └─ Remote shell: native Rust SSH                         │
└─────────────────────────────────────────────────────────────────────┘
```

WSL is optional at runtime and is used only when the user opens a WSL shell.
The documented `make desktop-*-win` developer workflow is launched from WSL
because it conveniently invokes Windows PowerShell against a Windows-local
build directory; this does not place the application server in WSL.

WSL 在运行时不是必需项，只有用户选择 WSL shell 时才会使用。文档中的
`make desktop-*-win` 从 WSL 发起，是为了调用 Windows PowerShell 并在
Windows 本地目录构建，不代表应用服务运行在 WSL 中。

## Runtime Requirements / 运行要求

- Windows x64. The current supported scripts and release artifacts target
  `x86_64-pc-windows-msvc`.
- Windows 10 version 2004 (Build 19041) or later for the core application;
  Windows 11 is recommended.
- Microsoft Edge WebView2 Runtime.
- WSL is not required for PowerShell, Command Prompt or SSH sessions. Optional
  WSL sessions require an installed distribution with `python3`; WSL 2 is the
  release-tested configuration.

- Windows x64；当前脚本和发布产物目标为 `x86_64-pc-windows-msvc`。
- 核心应用最低 Windows 10 2004（Build 19041），推荐 Windows 11。
- 需要 Microsoft Edge WebView2 Runtime。
- PowerShell、命令提示符和 SSH 不需要 WSL。可选 WSL 会话需要已安装的
  Linux 发行版和 `python3`；发布验证以 WSL 2 为准。

> **Identity-confirmed features require Windows 11 Build 22000 or later.**
> The Win32 `IUserConsentVerifierInterop` API used for exporting saved SSH
> credentials and binding legacy SSH/JumpServer/remote/AI/search credentials is
> unavailable on Windows 10. Those operations fail closed on Windows 10: no
> export file is written and no legacy credential is migrated. Windows 10 core
> support therefore does not imply feature parity for these privileged
> operations.
>
> **需要系统身份确认的功能最低要求 Windows 11 Build 22000。** 导出已保存
> SSH 凭据，以及绑定旧版 SSH、JumpServer、远端查看、AI/搜索凭据，依赖
> Win32 `IUserConsentVerifierInterop`。Windows 10 不提供该接口，上述操作会
> 失败关闭：不写入导出文件，不迁移旧凭据。Windows 10 核心支持不代表
> 这些高权限操作功能对等。

## Development and Build Requirements / 开发与构建要求

Install these tools on the **Windows side**:

- Node.js and npm
- Rust stable with the MSVC toolchain
- Visual Studio 2022 Build Tools with the Desktop development with C++ workload
- WebView2 Runtime

请在 **Windows 侧**安装：Node.js/npm、Rust stable MSVC toolchain、带“使用
C++ 的桌面开发”工作负载的 Visual Studio 2022 Build Tools，以及 WebView2 Runtime。

The WSL shell that launches the workflow needs `make`, `bash`, `curl`, `unzip`,
`wslpath` and access to `powershell.exe`. Go is not required.

发起构建的 WSL shell 需要 `make`、`bash`、`curl`、`unzip`、`wslpath`，
并且可以调用 `powershell.exe`。不需要 Go。

Verify the Windows-side tools from WSL:

```bash
powershell.exe -NoProfile -Command 'node --version; npm --version; rustc --version; cargo --version'
```

## Supported Workflows / 受支持的流程

Run from the repository root in WSL:

```bash
make desktop-dev-win
make desktop-build-win
```

两个命令会：

1. Prepare pinned `conpty.dll` and `OpenConsole.exe` inputs when absent.
2. Mirror only `desktop/` and `frontend/` into
   `%LOCALAPPDATA%\meterm-rust-dev` on the Windows filesystem. Windows build
   tools do not compile from a WSL UNC path.
3. Install/build the standalone `frontend/` that the in-process Rust server
   embeds.
4. Install/build `desktop/` and run native `tauri dev` or `tauri build`.

1. 在缺失时准备锁定版本的 `conpty.dll` 和 `OpenConsole.exe`。
2. 只把 `desktop/` 和 `frontend/` 同步到 Windows 文件系统上的
   `%LOCALAPPDATA%\meterm-rust-dev`。Windows 构建工具不从 WSL UNC 路径编译。
3. 安装并构建会被进程内 Rust 服务嵌入的独立 `frontend/`。
4. 安装并构建 `desktop/`，执行原生 `tauri dev` 或 `tauri build`。

Installers produced by `make desktop-build-win` are copied to the Windows
user's Downloads directory. `desktop/scripts/build-win-local.ps1` is only a
developer convenience for building unsynced changes already made in the cached
Windows worktree; it is not the release path.

`make desktop-build-win` 会把安装包复制到 Windows 用户的 Downloads 目录。
`desktop/scripts/build-win-local.ps1` 只用于测试缓存工作树中尚未同步的本地
修改，不是发布路径。

`desktop-dev-win-rebuild` and `dev-win-rebuild.ps1` remain only as deprecated
compatibility aliases. Tauri/Cargo now rebuilds the in-process Rust server
automatically; there is no separate server binary to rebuild.

`desktop-dev-win-rebuild` 和 `dev-win-rebuild.ps1` 只作为已废弃的兼容别名保留。
Tauri/Cargo 会自动重新编译进程内 Rust 服务，已没有独立服务二进制需要重建。

## First Launch / 首次启动

- The Rust server starts inside `MeTerm.exe`; no backend is copied to WSL and
  no child server process is launched.
- Native terminals use ConPTY and select `pwsh.exe`, `powershell.exe` or
  `cmd.exe` as available.
- Selecting a WSL shell launches `wsl.exe` and the PTY helper inside that
  distribution. Other app functionality remains native Windows.
- SSH sessions connect directly from the Rust process.

- Rust 服务在 `MeTerm.exe` 内启动；不会把后端复制到 WSL，也不会启动子服务进程。
- 原生终端通过 ConPTY 运行，按可用性选择 `pwsh.exe`、`powershell.exe` 或
  `cmd.exe`。
- 选择 WSL shell 时，应用会调用 `wsl.exe` 和发行版内的 PTY helper；其他功能
  仍在 Windows 原生进程内。
- SSH 会话由 Rust 进程直连。

## Troubleshooting / 故障排查

### Windows-local worktree is stale / Windows 缓存工作树异常

Stop MeTerm, remove `%LOCALAPPDATA%\meterm-rust-dev`, then rerun the supported
make target. This directory is a generated mirror; do not delete the source
checkout in WSL.

退出 MeTerm，删除 `%LOCALAPPDATA%\meterm-rust-dev`，然后重新执行受支持的 make
目标。该目录是生成的镜像，不要删除 WSL 中的源码工作树。

### ConPTY files are missing / ConPTY 文件缺失

```bash
bash scripts/download-conpty.sh
```

The files are generated inputs ignored by Git. The supported make targets run
this helper automatically when either file is absent.

这些文件是 Git 忽略的生成输入。受支持的 make 目标在任一文件缺失时会自动
执行该脚本。

### WSL shell fails / WSL shell 失败

```powershell
wsl --status
wsl --list --verbose
wsl -e python3 --version
```

This affects only WSL terminal sessions. Native PowerShell/cmd and SSH do not
depend on the WSL distribution.

该问题只影响 WSL 终端会话。原生 PowerShell/cmd 和 SSH 不依赖 WSL 发行版。

### Build tools are not found / 找不到构建工具

The WSL scripts intentionally use Windows `node.exe`, `cargo.exe` and MSVC.
Confirm their versions with the verification command above and ensure Visual
Studio Build Tools installed the Windows SDK. Go is not part of this workflow.

WSL 脚本会使用 Windows 侧的 `node.exe`、`cargo.exe` 和 MSVC。请执行上文验证
命令，并确认 Visual Studio Build Tools 已安装 Windows SDK。该流程不使用 Go。

## Release Validation / 发布验证

Local make targets produce development artifacts. Before distribution, use a
native Windows release runner, code-sign the installer, test SmartScreen and
the updater signature chain, and complete the Windows real-machine checks in
`docs/RELEASE_CHECKLIST.md`.

本地 make 目标产生的是开发构建产物。分发前必须在原生 Windows 发布 runner 上
构建，对安装包签名，测试 SmartScreen 和更新签名链，并完成
`docs/RELEASE_CHECKLIST.md` 中的 Windows 真机检查。
