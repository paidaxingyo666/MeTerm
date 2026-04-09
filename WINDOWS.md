# Windows Support via WSL / Windows WSL 支持

## Overview / 概述

MeTerm now supports Windows through WSL (Windows Subsystem for Linux) integration. The frontend Tauri application runs natively on Windows, while the backend server runs in WSL.

MeTerm 现在通过 WSL（Windows 子系统 Linux）集成支持 Windows。前端 Tauri 应用原生运行在 Windows 上，而后端服务器运行在 WSL 中。

---

## Requirements / 系统要求

### Windows Version / Windows 版本
- **Windows 10** version 2004 or higher (Build 19041+)
- **Windows 11** (recommended / 推荐)

### WSL 2 Installation / WSL 2 安装

#### First-time Setup / 首次设置

1. **Open PowerShell as Administrator** / 以管理员身份打开 PowerShell

2. **Install WSL 2** / 安装 WSL 2:
   ```powershell
   wsl --install
   ```

3. **Restart your computer** / 重启计算机

4. **Verify installation** / 验证安装:
   ```powershell
   wsl --status
   ```

#### If WSL is already installed / 如果已安装 WSL

Check your WSL version:
```powershell
wsl --list --verbose
```

If you're using WSL 1, upgrade to WSL 2:
```powershell
wsl --set-version Ubuntu 2
```

---

## How It Works / 工作原理

```
┌─────────────────────────────────────┐
│   Windows (Native)                  │
│   ┌─────────────────────────────┐   │
│   │  MeTerm (Tauri)    │   │
│   │  - Frontend UI              │   │
│   │  - WebSocket Client         │   │
│   └──────────┬──────────────────┘   │
│              │ HTTP/WebSocket       │
│              │ (127.0.0.1:PORT)     │
└──────────────┼──────────────────────┘
               │
┌──────────────┼──────────────────────┐
│   WSL 2 (Linux VM)                  │
│   ┌──────────▼──────────────────┐   │
│   │  meterm-server (Go)         │   │
│   │  - PTY Management           │   │
│   │  - Session Management       │   │
│   │  - WebSocket Server         │   │
│   └─────────────────────────────┘   │
│                                     │
└─────────────────────────────────────┘
```

1. **Tauri frontend** runs natively on Windows
2. **Backend server** is automatically deployed to `~/.meterm/` in WSL
3. **Communication** happens via HTTP/WebSocket over localhost
4. **Terminals** run in the Linux environment inside WSL

---

## First Launch / 首次启动

When you launch MeTerm on Windows for the first time:

1. **WSL Detection** / WSL 检测
   - The app checks if WSL is installed and running
   - If not found, you'll see installation instructions

2. **Binary Deployment** / 二进制部署
   - The backend binary is copied to WSL: `~/.meterm/meterm-server`
   - This happens automatically, no manual steps needed

3. **Server Start** / 服务器启动
   - The backend server starts in WSL
   - The frontend connects via localhost

---

## Troubleshooting / 故障排除

### WSL not found / WSL 未找到

**Error message:**
```
WSL not found. Please install WSL 2
```

**Solution:**
1. Open PowerShell as Administrator
2. Run: `wsl --install`
3. Restart your computer
4. Launch MeTerm again

---

### WSL not working properly / WSL 运行不正常

**Error message:**
```
WSL is installed but not working properly
```

**Solution:**
Check WSL status:
```powershell
wsl --status
wsl --list --verbose
```

Restart WSL:
```powershell
wsl --shutdown
wsl
```

---

### Backend fails to start / 后端启动失败

**Check WSL Linux distribution:**
```powershell
wsl --list
```

**Test manual launch:**
```powershell
wsl -e ~/.meterm/meterm-server --port 8080 --bind 0.0.0.0
```

---

### Connection issues / 连接问题

**Verify network access from Windows to WSL:**
```powershell
wsl -e ip addr show eth0
```

The backend binds to `0.0.0.0` to allow Windows to connect to WSL.

---

## Building from Source / 从源码构建

### Build all platform binaries / 构建所有平台二进制

```bash
./build-backends.sh
```

This will generate:
- `meterm-server-aarch64-apple-darwin` (macOS ARM64)
- `meterm-server-x86_64-apple-darwin` (macOS Intel)
- `meterm-server-x86_64-unknown-linux-gnu` (Linux/WSL)

### Build Tauri app for Windows / 为 Windows 构建 Tauri 应用

```bash
cd desktop
npm install
npm run tauri build -- --target x86_64-pc-windows-msvc
```

---

## Known Limitations / 已知限制

1. **WSL 2 Required** / 需要 WSL 2
   - WSL 1 is not supported (lacks proper PTY support)
   - WSL 1 不受支持（缺少适当的 PTY 支持）

2. **Performance** / 性能
   - Slight overhead due to WSL virtualization layer
   - Generally negligible for terminal use
   - 由于 WSL 虚拟化层会有轻微开销
   - 对于终端使用通常可以忽略不计

3. **File Paths** / 文件路径
   - Paths are relative to the WSL filesystem
   - Use `/mnt/c/` to access Windows C: drive
   - 路径相对于 WSL 文件系统
   - 使用 `/mnt/c/` 访问 Windows C: 盘

---

## Future Improvements / 未来改进

- [ ] Native Windows ConPTY support (no WSL dependency)
- [ ] Automatic WSL installation prompt
- [ ] Multi-distro WSL support (currently uses default)
- [ ] Performance optimizations

---

## Support / 支持

If you encounter issues on Windows, please report them with:

遇到问题请提供以下信息：

- Windows version: `winver`
- WSL version: `wsl --version`
- WSL status: `wsl --status`
- Error messages from the app
- Application logs

---

**Enjoy MeTerm on Windows! / 在 Windows 上享受 MeTerm！**
