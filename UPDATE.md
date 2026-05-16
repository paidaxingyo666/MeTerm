# MeTerm 更新记录

## v0.2.9

### 新功能

- **Plan 面板浮在对话框输入栏上方** — 任务计划从聊天消息流里拿出来作为独立悬浮卡片，贴在 AI 对话面板底部、紧靠输入框。Apple 风丝滑动画：入场从底部滑起 + 淡入；进度条 cubic-bezier 平滑填充；项目状态 icon 跳变（pending→in_progress→completed）；运行中项有横向 shimmer；全部完成后高亮 3 秒再滑回。视觉与对话面板 liquid-glass 风格一致，两侧 inset、四角圆角

### 问题修复

- **错误分类器误将「模型不存在」当作「工具不支持」永久降级** — 之前只要错误消息含「not supported」就把 agent 标记为 `toolsSupported=false`，结果一次「Not supported model X」之后所有模型都被切到 chat-only。改为必须同时出现「tool/function」+「not supported/unsupported/unrecognized」才归类为工具不支持
- **切换模型后仍卡在「无工具」模式** — `ToolAgent` 新增 `lastResolvedModel`，runLoop 检测到模型变了就重置 `toolsSupported`。让换模型能恢复
- **Plan UI 任务执行中看不到、做完才突然出现** — 老逻辑里 board 跟 tool card 都 append 到 chat-messages 末尾，每个 tool card 都把 board 顶上去；最后一次 todo_write 才重新拉回底部，所以「任务完成才看到」。新设计把 board 移出 messages 流，作为 chat panel 直接子元素位于消息区与输入框之间

---

## v0.2.8

### 新功能

- **AI 思考模式开关** — 设置面板新增「思考模式」总开关，AI Bar / 侧面板新增脑图标快速切换；启用时向请求体注入 `thinking.type` / `enable_thinking` / `chat_template_kwargs.enable_thinking` 三种字段，覆盖 DeepSeek V4 / Qwen3 / GLM / MiMo / vLLM 等思考模型；本轮对话中途切换无须重连，未知字段被 OpenAI / Anthropic / Gemini 忽略
- **SSH 无凭据连接** — 选「密钥」认证、密钥路径留空时走 OpenSSH 风格梯子：先 `$SSH_AUTH_SOCK` (ssh-agent) 轮询所有 identities，再按 `id_ed25519 → id_ecdsa → id_rsa → id_dsa` 顺序试默认密钥。成功后底部 toast 提示实际走的路径
- **SSH 私钥文件选择器** — 密钥输入框旁新增浏览按钮，原生文件对话框，默认起始 `~/.ssh/`
- **SSH 动态提示** — 切到密钥模式时检测默认密钥与 ssh-agent 状态：placeholder 显示「留空将自动使用 ~/.ssh/id_ed25519」或「留空将通过 ssh-agent 认证」；agent 有身份时显示 `agent: N` 徽章
- **JumpServer 连接反馈即时化** — 点击资产后 tab + 占位符**立即出现**（之前要等 token API 返回才出，资产慢时会等 1-3 秒）；占位符按阶段更新文案：正在认证 → 正在获取连接令牌 → 正在连接 user@host

### 问题修复

- **AI 调用 400「reasoning_content must be passed back」** — Qwen3 / DeepSeek V4 等思考模型要求带 tool_calls 的 assistant 必须回传 reasoning_content。前端在流式累积 reasoning、序列化时强制带回（空也带空串），符合官方文档要求
- **SSH 私钥路径无法连接** — 前端发的是路径但 Rust 后端直接当 PEM 解析必败；补回 Go 后端迁移漏掉的 `~` 展开 + HOME 沙箱 + 文件读取逻辑，russh 终端 / ssh2 SFTP 两条路径都修
- **JumpServer SFTP 无法初始化** — Koko 的连接 token 按 protocol 隔离且常为单次使用，第二条独立 SSH 连接被拒。改为在已认证的终端 session 上起 sftp 子通道（multiplex），普通 SSH 仍走独立连接保留传输性能；SFTP 初始化失败时把具体原因带回前端，不再只是「retry」
- **JumpServer 侧边栏文件树加载慢** — 多个原因叠加：
  - `loadDirectoryRaw` 没加 `soft_limit:5000` 软上限，大目录通过复用通道一次性拉数万条
  - 没用上现有的目录缓存，drawer 刚拉过的目录 sidebar 又走网络
  - `fm.currentPath==='/'` 被误判为「未加载」，导致根目录就是 home 的资产（如多数 JumpServer 资产）侧边栏一直等一个不会再来的事件
- **JumpServer 侧边栏不跟随 auto-cd** — `FileManager.onPathChanged` 从单回调改成订阅者集合，sidebar 长期 follower 跟随 FM 的路径变化（auto-cd / 终端 cd），面包栏手动输入或锁定时停止跟随
- **重命名报「Invalid filename」** — `renameFile(oldPath, newName)` API 改了支持绝对路径但校验没跟着改，必拒；改为只校验 basename
- **侧边栏树重命名 1-2 秒空白** — sidebar 模式下 drawer 的「重命名中...」overlay 被隐藏，用户无反馈；新增乐观更新：按 Enter 立刻在树里改名 + 服务端响应回来 refreshAll 自然吻合；失败时也派发 file-op-done 自动回滚
- **树移动文件后展开节点闭合** — `refreshAll` 把 expansion 快照捕获放在第一个 await 之后，并发 refresh 时读到的是被另一个调用清掉的空 nodeMap；快照挪到 await 之前 + 删除 `onMove` 里冗余的 setTimeout refreshAll

---

## v0.2.7

### 新功能

- **JumpServer 会话过期处理** — 全链路会话过期识别与恢复：资产面板 banner、pop-out 窗口引导回主窗口、面板 header 右键菜单（重新登录 / 退出登录）、toolbar 下拉项右键菜单、掉线重连前置过期/登出检查
- **JumpServer SFTP 认证自愈** — 凭据失效时自动刷新并恢复传输；新增 SFTP 凭据刷新 HTTP 端点；错误分类细化（`SFTP_AUTH_FAILED` / `SESSION_EXPIRED`），分类器覆盖上传/下载嵌套 error 字段
- **AI Agent 中文化** — 工具卡名称中文显示（`run_command` → 运行命令、`read_terminal` → 读取终端、`todo_write` → 更新计划等 19 项），任务计划状态中文化（待办 / 进行中 / 已完成），`wait_for_user_input` 状态文案中文化
- **任务计划 UI 优化** — 宽度对齐工具卡片，padding/字号/边距收紧，去掉状态徽章 uppercase 防中文挤压
- **文件管理器右键菜单优化** — "刷新"提到一级菜单；自定义右键菜单（Tab/Shell/文件链接）补齐高斯模糊样式
- **文件名校验放宽** — 支持 Linux/SFTP 合法字符（含括号、空格等 POSIX 文件系统允许的字符）

### 问题修复

- **更新重启被退出确认对话框拦截** — 修复点击"立即重启"后被退出确认弹窗拦截导致更新不生效
- **终端粘贴图片被 AI Bar 全局捕获** — 修复在终端 Cmd/Ctrl+V 粘贴时,AI Bar 错误地从系统剪贴板拉取图片附加到聊天
- **任务计划 UI 被挤压消失** — 修复长聊天中 plan board 被后续消息挤压到 0 高
- **思考块泄漏 XML 标签碎片** — 过滤 `</think>` / `</arg_value>` 等流式残片,历史压缩切到换行边界减少 dangling 片段
- **树视图右键新建文件夹路径错乱** — 修复对话框停留过久后 contextPath 5 秒超时漂移导致目录创建到错误位置;新建后自动展开父目录立即显示

---

## v0.2.6

### 新功能

- **Neo-Brutalism 可选主题** — 含圆角变体 + 11 套预设配色（赛博朋克/深渊/薰衣草/午夜/糖果/复古/极光/德古拉/曝光/纯黑系列）+ 自定义调色板，支持跨窗口实时同步

### 问题修复

- **SSH 锁屏恢复后 OSC 响应回显为可见文本** — 修复 OSC 10/11/12 颜色查询在锁屏恢复后泄漏到终端输出
- **锁屏恢复后 TUI 鼠标模式丢失及内容不完整** — 恢复鼠标跟踪状态并重绘 TUI 界面
- **JumpServer v2 资产浏览器平台字段未显示** — 修复 v2 API 响应字段解析
- **分屏切换时命令高亮闪烁 + 分割面板虚假滚动条** — 修复跨面板高亮闪烁及多余滚动条
- **窗口缩小时滚动区域高度计算错误** — 修复缩小窗口后出现异常滚动条的问题

---

## v0.2.5

### 新功能

- **AI Agent 系统** — 多面板感知、跨面板操作；任务规划、文件传输、结构化搜索、会话 PTY 锁；复用 SFTP 链路实现通用文件附件；传输进度可视化、文件管理器同步、智能超时检测
- **内置编辑器增强** — Markdown 渲染预览、图片预览、自动换行
- **SFTP 高速传输** — 双通道 WebSocket + 文件传输并行化 + 内存优化；下载路径修复
- **文件管理器大目录性能优化** — 虚拟滚动渲染、详情弹窗、符号链接修复；文件管理侧边栏、上传下载全面优化
- **终端字体大小快捷键** — Ctrl/Cmd +/- 实时调整终端字号
- **审计日志** — 改用系统默认文本编辑器打开

### 问题修复

- **上传冲突/取消卡片显示正确状态** — 区分用户主动取消与被动冲突的卡片状态
- **upload_file 重名文件拦截** — 不再静默覆盖，正确弹出冲突确认
- **Agent 传输四项修复** — 重名检测、取消感知、文件列表刷新、引导消息竞态

---

## v0.2.4

### 新功能

- **文件管理器全面升级**
  - 面包屑导航 + 键盘导航 + 文件搜索 + 多选操作
  - 远程文件复制/移动、状态栏、文件属性弹窗、符号链接支持
  - chmod 权限修改、书签收藏、限速控制、传输完成通知
  - 右键菜单增强（空白区域支持 + 显示隐藏文件切换）
  - 缩略图开关（关闭可节省内存并隐藏总览按钮）
  - 删除确认弹窗显示 rm 命令并提供复制按钮；批量上传冲突支持全部覆盖/全部跳过
- **内置编辑器格式化** — 一键格式化 JSON/XML/HTML/CSS
- **终端字体增强** — 新增字体选项、字重控制、文字锐化
- **AI 对话框侧栏模式** — 可切换为侧边栏，液态玻璃 UI 风格，Markdown 渲染增强
- **Shell Hook 回退模式** — 无 Shell Hook 时，鼠标点击依然可定位光标、拖拽依然可选中编辑
- **服务器信息紧凑卡片** — 工具栏图标化、AI bar 动态占位提示

### 问题修复

- 多个文件管理相关细节修复（拖拽上传防抖、路径重复拼接、UI 遮挡等）

---

## v0.2.3

### 新功能

- **Linux 平台支持** — 新增 Linux x64 / arm64 CI 构建（已测试 Ubuntu 24.04），发布 `.deb` / `.AppImage` / `.rpm` 包
- **README 下载入口更新** — 新增 Linux 平台下载链接和安装说明

---

## v0.2.2

### 新功能

- **OSC 序列全面增强**
  - OSC 52 剪贴板穿透（支持远程程序向本地剪贴板写入）
  - OSC 8 超链接（终端内可点击 URL）
  - OSC 133 语义提示符拦截
  - 图片显示协议支持
  - Unicode 11 字符宽度更新
- **Shell Hook 注入**
  - 点击移动光标（基于 OSC 7768 语义提示符，支持精确定位）
  - 命令区拖拽选中编辑（删除/替换/剪切/复制）
- **Linux UI 完善** — 多轮适配 GTK CSD/圆角/透明窗口，修复顶部透明条、下拉框主题化等问题

---

## v0.2.1

### 新功能

- **本地终端 IPC Channel** — 替代 WebSocket，本地会话连接延迟更低
- **SSH 代理支持** — SOCKS5 / HTTP CONNECT 代理，JumpServer 可独立配置代理
- **窗口置顶按钮** — 快速将当前窗口固定在最前
- **Chrome 风格标签切换快捷键** — Ctrl/Cmd 1-9 直接跳转对应标签
- **自定义设备名 + 远程设备别名** — 局域网共享时可自定义显示名称
- **可配置代理模式** — 本地终端与远程终端可分别配置连接方式

### 问题修复

- **开发版与安装版单实例冲突** — 修复使用相同 identifier 导致无法同时运行的问题

---

## v0.2.0

### 架构迁移

- **纯 Rust 进程内后端** — 从 Go sidecar 架构迁移至 Rust in-process，消除外部进程管理和 IPC 开销
- 后端基于 Axum + Tokio，支持 WebSocket 二进制协议
- 跨平台 PTY：统一抽象 Unix PTY、Windows ConPTY、WSL、SSH
- 会话状态机：Created → Running → Draining（环形缓冲区）→ Closed，支持无缝重连
- SFTP 自适应流水线：基于 RTT 动态调整窗口（2→64），实现高吞吐传输
