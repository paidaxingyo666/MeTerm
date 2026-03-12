# MeTerm v0.1.5 更新内容

基于 v0.1.4，当前分支 `dev-0.1.5` 未提交变更汇总。

---

## 新功能

### 1. 终端文件链接（Ctrl/Cmd+Click 打开文件）
- **新增文件**: `desktop/src/terminal-file-link.ts`
- 终端输出中的文件路径自动识别并高亮为可点击链接
- **双层检测策略**：正则匹配（绝对/相对路径、带扩展名文件）+ CWD 目录缓存比对
- **交互方式**：
  - Hover 下划线高亮，显示操作提示 tooltip
  - Ctrl/Cmd+Click 直接打开（本地用系统默认程序，SSH 跳转文件管理抽屉）
  - 右键菜单 → "用本机关联程序打开" / "在文件管理器中打开"
- 设置项：可关闭文件链接打开确认弹窗（`fileLinkSkipConfirm`）
- **涉及文件**: terminal-file-link.ts, terminal.ts, drawer.ts, file-manager.ts, i18n.ts, settings.ts, themes.ts, style.css

### 2. Rust 侧文件操作命令
- **新增 Tauri 命令**：`stat_path`（检查路径类型）、`open_path`（系统默认程序打开）、`list_dir_names`（列出目录内容）
- 支持 `~` 展开、Windows MSYS/WSL 路径转换
- 添加 `dirs` crate 依赖
- **涉及文件**: commands.rs, lib.rs, Cargo.toml, Cargo.lock

### 3. SSH 会话 CWD 追踪
- SSH 连接时注入 shell hook（bash/zsh），使远程 shell 通过 OSC 7 上报当前目录
- 启动时 ECHO=0 隐藏 hook 注入，hook 末尾 `stty echo` 恢复回显
- 本地会话注册 OSC 7 handler 追踪 CWD 变化
- SSH 文件管理器初始路径改为 `.`（SFTP 主目录）而非 `/`
- **涉及文件**: ssh.go, terminal.ts, drawer.ts

### 4. 系统休眠/唤醒后自动重连
- 监听 `visibilitychange` 事件，检测系统休眠（>30s 不可见）后自动重连所有本地 WebSocket
- sidecar 重启后也会触发全部重连（`reconnectAll`）
- WebSocket 连接参数（port/token）存储在 ManagedTerminal 上，重连时可更新
- **涉及文件**: main.ts, terminal.ts

### 5. Windows 休眠后 PTY 管道断裂恢复
- 后端 session 检测到 PTY 管道断裂（子进程存活但 pipe 无效）时，尝试通过 TermFactory 重建 PTY
- 重建后重置终端状态（退出备用屏幕、关闭鼠标模式），用户无需手动重新打开终端
- **涉及文件**: session.go

---

## Bug 修复

### 1. IME 输入法卡死问题（macOS WKWebView）
- **问题 A**：切换输入法时终端卡住，无法输入，需再次切换才恢复
- **问题 B**：中文输入法输入字母后逐个删除，最后一个字符残留为"幽灵字符"（黑底白字 compositionView），切换英文输入法后完全无法输入
- **根因**：WKWebView 的 WebKit Bug #165004（compositionend 在 keydown 之前触发）+ compositionend 可能完全不触发
- **修复**：
  - 修复 A：检测浏览器 `isComposing=false` 但 xterm 仍在组合中的不一致状态，主动调用 `compositionend()`
  - 修复 B：flag-based 卡死检测——keydown(229) 时设 flag，compositionupdate 时清 flag，下一次 keydown(229) 检查 flag 判断上一轮是否缺失 compositionupdate → 主动重置 composition 状态
  - WebKit Bug #165004 防护：compositionend 后接管字符发送，避免 xterm 因事件顺序错误漏发字符
- **涉及文件**: terminal.ts（三处：create、attachFromTransfer、openAndConnect）

### 2. 终端容器 padding 和布局修复
- 终端左右 padding 从 15px 减为 4px，减少空间浪费
- 移除 `.terminal-container` 底部 5px inset，统一为 `inset: 0`
- 删除 `ai-bar-hidden` 时的冗余 inset 覆盖规则
- `.xterm-screen` 添加 `min-height: 100% !important` 确保终端内容填满容器
- **涉及文件**: style.css

### 3. 终端 resize settle 增加 400ms pass
- 原来只有 160ms 的 settle pass，在较慢的布局引擎（如 x86 WKWebView）上可能不够
- 新增 400ms settle pass 以捕获 flex 布局完成后的尺寸变化
- **涉及文件**: terminal.ts

### 4. Windows 背景图路径反斜杠修复
- `convertFileSrc` 对反斜杠进行 percent-encode 导致部分 WebView2 无法加载背景图
- 调用前先将 `\` 转为 `/`
- **涉及文件**: main.ts

### 5. CSP img-src 添加 http://asset.localhost
- 部分环境下 `asset:` 协议使用 `http://asset.localhost` 前缀，原 CSP 缺少此源导致图片加载失败
- **涉及文件**: tauri.conf.json

### 6. 修饰键阻止 xterm 自动滚动
- 单独按下 Meta/Control 键时阻止 xterm.js 自动滚到底部，避免影响 Ctrl/Cmd+Click 文件链接操作
- **涉及文件**: terminal.ts

### 7. WebSocket onmessage 错误码处理添加 return
- 收到 `ErrNotMaster` 等错误消息后添加 `return` 避免继续处理后续逻辑
- **涉及文件**: terminal.ts

---

## 涉及文件清单

| 文件 | 变更类型 |
|------|---------|
| `backend/session/session.go` | 修改 — PTY 管道断裂恢复 |
| `backend/terminal/ssh.go` | 修改 — SSH CWD hook 注入 |
| `desktop/src-tauri/Cargo.lock` | 修改 — 新增 dirs 依赖 |
| `desktop/src-tauri/Cargo.toml` | 修改 — 新增 dirs 依赖 |
| `desktop/src-tauri/src/commands.rs` | 修改 — stat_path/open_path/list_dir_names |
| `desktop/src-tauri/src/lib.rs` | 修改 — 注册新命令 |
| `desktop/src-tauri/tauri.conf.json` | 修改 — CSP img-src 修复 |
| `desktop/src/drawer.ts` | 修改 — SSH 初始路径 + navigateToPath + getRemoteDirEntries |
| `desktop/src/file-manager.ts` | 修改 — getFileNames() 方法 |
| `desktop/src/i18n.ts` | 修改 — 文件链接相关翻译（中/英） |
| `desktop/src/main.ts` | 修改 — 休眠检测 + 背景图路径修复 |
| `desktop/src/settings.ts` | 修改 — 文件链接确认弹窗开关 |
| `desktop/src/style.css` | 修改 — 终端 padding + 文件链接 UI 样式 |
| `desktop/src/terminal.ts` | 修改 — IME 修复 + OSC 7 + 文件链接 + 重连 |
| `desktop/src/terminal-file-link.ts` | **新增** — 终端文件链接核心逻辑 |
| `desktop/src/themes.ts` | 修改 — fileLinkSkipConfirm 设置项 |
