# 配置参考 / Configuration Reference

## 服务端参数

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

## 客户端设置

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

## 会话生命周期

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

## 客户端角色系统

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
