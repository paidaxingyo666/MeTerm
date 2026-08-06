# MeTerm 更新记录

## v0.2.12

### Agent 双形态(原生 TUI + 手机聊天镜像)

- **审批桥(手机可批)** — claude 弹权限确认时,手机 Agent 页直接出审批卡(允许/拒绝),点了即回投给 claude,**终端不再弹窗**;手机 90 秒未决/离线自动回落原生 TUI 弹窗,审批永不被吞。local TUI 模式手机可批,这是 Happy 做不到的
- **对话实时展示** — assistant 正文改走 MessageDisplay hook 实时流式下行(markdown 原文行批),不再等整轮结束 transcript 落盘才一次性冒出;hook 失联轮自动回落 transcript 全文兜底,历史回放不受影响
- **工具进行中态** — PreToolUse hook 实时合成工具卡(执行开始瞬间出现「运行中」spinner 徽章),轮末 transcript 的重复卡由手机归约器幂等吸收(同 id 就地合并,不重复建卡、不打断流式气泡)
- **Agent 页状态条** — 顶部实时显示 claude 在做什么:思考中(紫)/ 执行 <工具>(蓝)/ 等待你的确认(橙);idle 自动隐藏。由 hook 事件流驱动(UserPromptSubmit/PreToolUse/PostToolUse/Stop/Notification),零 token
- **启动模式** — 欢迎页新增启动模式选择:标准 / 继续上次对话(--continue)/ 计划模式(--permission-mode plan)/ 跳过权限确认(--dangerously-skip-permissions,红色警示);对当前目录与选目录启动均生效
- **通知去重** — 审批卡在手机上时不再同时弹「去终端确认」的 attention 卡;任务完成后的空闲提醒不再误报成审批提示(状态条置 idle)
- **Agent 页 statusline(对齐 ccstatusline)** — 输入框下方状态行:模型(展示名,可点切换 /model)· 思考等级(可点切换 /effort)· git 分支 · 上下文占用百分比(分级着色,接近 compact 阈值转橙/红);数据零侵入取自 transcript(model/usage/gitBranch/cwd)与 hook 的 CLAUDE_EFFORT,不注入 statusLine 配置、不影响用户终端里自己的 statusline
- **模型/思考等级菜单动态化(告别硬编码漂移)** — 新增 `GET /api/agent-options`:桌面运行时从本机 claude 二进制提取 /model 别名全集与 /effort 档位全集(claude 升级增删模型后自动跟随,含 ultracode 第 6 档),带进程级缓存与结构校验;提取失败逐级回落(内置快照,UI 可标注);手机菜单 label 按规则生成,未知新别名自动可读
- **状态指示器归位** — 从页面左上角移进对话流,跟在最新消息下方(思考中/执行工具/等待确认小胶囊),出现自动滚入视野
- **工具卡合并 + 紧凑化** — 同批连续工具调用合并为一张组卡(每工具一行、独立展开、独立运行中/完成徽章);卡片留白减半、不再占满全宽
- **Agent 页标题** — 跟随会话标签名(与终端页一致),不再固定显示 "Agent"
- **审批卡对齐终端语义** — 选项 = 允许 / 总是允许(claude 建议的 don't-ask-again,回 updatedPermissions)/ 拒绝(可附"告诉 Claude 该怎么做"反馈);已决后收缩为一行结果摘要
- **AskUserQuestion 选择题** — claude 问选择题时手机出问题卡:单选点即提交、多选、自定义文本回答;答案经 updatedInput.answers 回传(masko-code 同款机制)
- **对话体验** — 气泡长按复制;列表底部锚定(新内容自动追随、键盘弹出内容跟随上推);右上角操作菜单(打断 / /compact / 复制全部对话 / /clear)
- **新增底部 tab:任务** — claude 任务清单(TodoWrite)实时展示:进度条 + pending/进行中/已完成状态,claude 退出自动清空
- **新增底部 tab:Git(GitHub 图标)** — 会话目录的仓库面板:分支与 ahead/behind、变更文件列表(点开逐行着色 diff,支持 untracked)、提交说明输入 + 全部暂存提交、pull(--ff-only)/push、提交历史;桌面新增 5 个会话级 git REST 端点(仅本机会话,cwd 由 shell integration OSC 上报实时跟踪)
- **Git tab 完善(fix14)** — 右上角操作菜单:切换分支(sheet 列表,当前打勾)/ 新建分支 / Fetch / Stash 暂存与恢复 / 丢弃全部改动(双确认);文件行右滑暂存/取消暂存(带绿勾反馈)、左滑丢弃(确认);提交历史点开看完整提交 diff(git show,超长截断)、长按复制 hash;桌面再增 6 个 git 端点(branches/show/checkout/stage/discard/stash),分支名防 flag 注入、hash 严格校验
- **Git tab 图标** — GitHub mark 换 SF Symbol 分支符号(arrow.triangle.branch),自动跟随 tab 高亮着色,删自定义资源

### 主页「文件」tab(配对电脑文件管理)

- **文件浏览** — 主页第 2 个 tab 从占位实现为配对桌面本机文件浏览器:从家目录逐级进入(系统返回/右滑),图标/大小/修改时间与会话页一致,下拉刷新、搜索过滤当前目录、显示隐藏文件;不依赖终端会话、不需要接管;桌面新增 4 个会话无关文件 REST 端点(list/download/upload/op,Bearer 鉴权,上传临时文件+原子落位、同名自动加 (N) 后缀)
- **传输队列** — 右上角队列按钮(进行中数量角标):多任务上传/下载并发 2,进度条、取消、失败重试、清除已完成;下载落系统文件 app 可见的 MeTerm/Downloads(完成项点开预览、可分享);上传支持文件多选与相册照片
- **预览分流** — 点文件:图片/音视频/PDF/Office 走 QuickLook;小文本原生预览可编辑保存;可执行/库/压缩包等不可预览类型直接弹操作菜单(下载到文件/复制路径),不再下载后弹无意义占位页;下载后再过一遍 canPreview 兜底(损坏/伪装扩展名)
- **多桌面 + 冷启动** — 顶部多桌面切换器(会话页同款,0/1 台自动隐藏);冷启动三态:离线橙条 / 首载「连接中…」占位 / 失败内联通知卡带重试,桌面回连自动重载,不闪空态不弹错
- **切换桌面传输保护** — 有进行中的传输任务时,切换桌面(切换器/桌面管理页任一入口)先弹确认「中断传输并切换」,确认后干净取消在飞任务再切换;无任务直切零打扰
- **系统分享接入(用 MeTerm 打开)** — 注册为通用文档处理 app:文件 app 分享菜单与任何应用的「用其他应用打开」里出现 MeTerm,选中后进「上传到电脑」引导——选目标电脑(多台可选,默认当前活跃)→ 逐级浏览选目标文件夹 → 逐文件进度上传(失败单个重试);多文件连续分享合并一次引导;冷启动预热窗口静默重试 3 发(显示"连接中…",不闪假错),回连自动重载

### 问题修复 / 优化

- **连接 JumpServer 堡垒机报「No common algorithm」** — SSH 算法偏好不再隐式继承 russh 的默认表。上游默认表在版本间会漂移，而漂移会静默改变「能连上哪些服务器」：russh 0.46 不提供 `ssh-rsa` 主机密钥算法，而 JumpServer Koko 的 RSA 主机密钥恰恰只以这一个名字宣告，两边交集为空导致密钥交换直接失败，且旧版错误信息不含任何算法类别、无从诊断。现改为在上游表基础上**只做追加**（上游新增的 mlkem768 等仍自动获得）：补 `ssh-rsa` 主机密钥、补 OpenSSH/Go 标配但 russh 至今不默认提供的 `ecdh-sha2-nistp256/384/521` 密钥交换、补 `aes128-gcm@openssh.com`；追加项一律排在末尾，现代服务器的协商结果不变。桌面端的终端会话与 SFTP 两条连接、移动端 SSH 核心一处，共三处保持同一套偏好，并由两侧同构的单元测试锚定——今后升级 russh 若收窄可连服务器集合，由 CI 而不是用户在堡垒机前发现。同时补回上游 0.61 移出默认的 SHA-1 HMAC（`hmac-sha1` / `hmac-sha1-etm`），但严格排在全部 SHA-2 MAC 之后——只支持 SHA-1 MAC 的老堡垒机与网络设备恢复可连（这是升级 russh 相对 v0.2.11 的回退），而现代对端不受任何影响：它们要么提供 SHA-2 MAC，要么协商到 AEAD 密码从而根本不进行 MAC 协商。该排序由单元测试锚定，防止今后被无意提前
- **macOS 开发版钥匙串弹窗收口** — SSH、Remote、JumpServer 与 Settings 启动均不再逐条自动扫描/重试旧 Keychain：主窗口只检查 Web Storage 并记录脱敏 pending/manual/complete 状态或非敏感 presence cache，辅助窗口只读 cache；明文来源保留，只允许由显式连接、设置或后续正式 recovery UI 处理。原生 Release 服务启动也不再扫描 registry 对应 SSH 项或整库删除 legacy service。签名 `MeTerm Dev` 的单连接 v2 恢复永不读取正式 v3，桌面私钥路径必须本机重选，key-ladder 只写新 authority marker。SSH、Remote、JumpServer、Settings、Relay 与 TLS 的 macOS 新 account 均采用 add-only 创建；SSH 不凭公开 binding 自动提升 v2，Relay 孤儿/legacy current item 不会被覆盖。SSH registry 双写使用 before-image、延迟删源及 post-rename 可见提交语义。Relay 禁用状态启动不读取/删除 vault。真实签名升级、包括 SSH/Remote/JumpServer/Settings/Relay 在内的 deterministic current-item ACL provenance/随机 generation、持久崩溃恢复 journal、正式 recovery UI 与孤儿审计等事项仍按发布清单阻断
- **macOS 终端从后台恢复后低频字形错乱** — 窗口重新聚焦时仅重建 xterm 渲染纹理并全量重绘；WebGL context 无法恢复时自动回退默认 renderer。保留锁屏/休眠与 PiP 退出原有的 SIGWINCH 尺寸抖动逻辑，普通聚焦不改变 PTY 尺寸
- **移动端与中继安全加固** — 中继参数不再出现在 Android/iOS 界面或普通日志；移动端改用设备级可撤销凭据与固定证书，桌面端按精确凭据代次断开连接/推送，慢请求在正文读取期间持续复验撤销状态；本机 Agent Hook 在读取正文前校验可信入口和会话密钥，并限制为 64 KiB/30 秒空闲超时。完整威胁模型与正式分发阻断项见 `docs/SECURITY.md`
- **分发安全基线与供应链闸门** — 标准桌面 Release 的移动控制 scope 默认全空并由编译期/36 路由矩阵共同锁定；Android 改为直接使用 AndroidKeyStore 与有界 RFC 6455 reader，正式 AAB 强制 upload key 签名校验；iOS 加入 privacy manifest、Keychain group 隔离与 production APNs entitlement，FFI 原生依赖固定最低系统 18.0。新增依赖锁定、含 Control Broker 与更新服务 Worker 的 9 份 CycloneDX SBOM、统一审计脚本、Relay 最小权限 systemd 样例及 `docs/RELEASE_CHECKLIST.md`；9 份 SBOM 本机已成功生成，OSV/审计门禁对 RSA、`quick-xml` 与 allowed/unmaintained 残余持续失败关闭
- **正式签名隔离拆分** — 针对旧工作流“同 runner 构建后再注入长期密钥”的风险，macOS、Windows、Linux、Android、iOS 已全部改为新鲜 build → 唯一生产 signer → 新鲜 public-only verifier；所有 `v*` 仍在 checkout/Environment/secret 前阻断，直到真实签名演练、源码证据单一编排、密钥迁移和仓库外保护闭环
- **独立 Control Broker 第一阶段** — 新增第四个独立 Rust workspace，落地严格长度前缀 CBOR、transport peer 认证门、固定只读 `status.get`、版本/deadline/大小/in-flight/replay 失败关闭及跨进程负向测试；生产 binary 从不自行创建 listener，继续返回 `blocked`/空 scope，不迁移或暴露任何现有 secret
- **Linux Control Broker 第二阶段** — 增加只接受 systemd fd 3 的固定 Unix socket adapter，校验 `SO_PEERCRED`、PID/start-time/UID/GID、root-owned App inode 与 SHA-256 manifest，并加入连接限额、hash 单调时钟预算/I/O deadline、hardened service/socket/sysusers/tmpfiles 及负向测试；仍为 status-only，跨 UID `/proc` 发行矩阵未验收时失败关闭，不授予 root/`CAP_SYS_PTRACE`，不启用任何 scope
- **Windows/macOS Control Broker 第二阶段** — Windows 落地 restricted service SID、固定 pipe、token/file ID/ACL/Authenticode 验证；macOS 落地 XPC audit-token/Developer ID requirement、root manifest/file ID/SHA-256/CDHash 验证与 `_meterm-control`/SMAppService 部署输入。两者仍只返回 `blocked`/空 scope，不持有 secret 或联网；当前 macOS App 的动态库/可执行内存例外会被新 peer policy 故意拒绝，三平台仍需完成 clean-machine 安装/升级/回滚、secret/scope/业务 operation 迁移
- **依赖残余风险收口** — 桌面 `plist` 升至 1.10.0 并移除一组易受攻击的 `quick-xml 0.38`；剩余 Windows 通知/Linux 构建期 XML 路径与 RSA SSH advisory 已记录可达性和发布签字要求

---

## v0.2.11

### 新功能

- **macOS 代码签名 + 公证** — 使用 Apple Developer ID 对 App 与 DMG 签名并公证、装订（staple），下载后**双击即可打开**，不再需要手动解除隔离（`xattr -cr`）
- **访达右键「Open in MeTerm」** — macOS Finder 右键菜单可直接用 MeTerm 打开所选目录/文件所在目录（Finder Sync 扩展，签名后自动生效）
- **主页改为连接侧边栏** — 取消独立主页，连接管理改为停靠式左侧侧边栏（鼠标悬浮工具栏按钮可浮出菜单，不遮挡终端）；应用启动默认打开一个本地终端
- **标签拖出独立窗口** — 标签可拖到窗口外新建独立应用窗口，拖动时有跟随预览
- **AI 对话侧栏化** — AI 对话改为仅在侧边栏，agent 按钮移到工具栏（分享按钮左侧），底部命令输入框默认折叠
- **文件侧栏递归搜索** — 文件树新增搜索按钮，支持本地与 SFTP/JumpServer 递归搜索
- **面板增强** — 右键可将面板抽取为独立标签；面板可拖动重排（拖到中间替换、靠边插入）；移动手柄激活时向左滑出显示该面板标题
- **文件树「在访达/资源管理器中打开」** — 本地会话右键菜单新增（macOS 访达 / Windows 资源管理器）

### 问题修复 / 优化

- **工具栏图标体系统一** — 按钮纯图标化（激活高亮），AI 改文字图标、文件管理器改侧边栏式图标，左右两侧图标大小与间距统一；标签栏与终端之间留出呼吸间距且无接缝
- **面板区分更清晰** — 去掉激活面板外高亮框，改为未激活面板内容暗化 + 面板间可见分隔线（悬浮/拖动高亮）
- **状态栏自动隐藏** — 空闲时收起并回收占位空间，连接/传输/AI 活动时再显示
- **连接侧边栏跟随毛玻璃设置** — 关闭毛玻璃后侧边栏显示为实色，不再固定半透明
- **Windows 本地搜索结果定位** — 修复本地搜索命中路径分隔符与文件树不一致，导致点击结果无法定位、目录列错位
- **Linux 拖拽预览透明** — 修复拖拽预览窗口在 GTK 下透明边距被渲染成不透明方块

---

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
