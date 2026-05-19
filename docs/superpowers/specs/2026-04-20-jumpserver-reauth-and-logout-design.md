# JumpServer 会话过期重连与退出登录 — 设计

- 日期：2026-04-20
- 分支：dev-0.2.7
- 范围：desktop/（前端 TS + Rust 后端）

## 背景与问题

MeTerm 已实现 JumpServer 登录、资产浏览、通过 connection token 直连 Koko 的完整链路，但缺两个能力：

1. **会话过期无恢复路径**：JumpServer session 过期后，资产列表/账号查询全部 401/403，Rust 侧 `do_get_multi()`（`desktop/src-tauri/src/server/jumpserver/mod.rs:233-280`）会返回笼统的 `"all API paths failed"`，前端不区分"网络错误"与"认证过期"，用户只能重启应用。
2. **无退出登录能力**：`activeJumpServers` Map、Keychain 中的凭据、localStorage `meterm-active-jumpservers` 等状态没有清理入口；连接账号后无法在不关闭应用的前提下切换账号或清空凭据。

## 设计目标

- 识别会话过期，引导用户手动重登（半主动：显示 banner，不自动弹对话框打断）
- 提供显式退出登录入口（右键面板 header 与 toolbar dropdown item）
- 退出登录**不强制关闭已打开的 asset SSH tab**，因为 pty 与 JumpServer API session 解耦（验证见"关键事实"）
- 最小侵入：不重构多路径 fallback、不新增心跳、不加自动重认证

## 关键事实（来自代码验证）

| 事实 | 证据 |
| --- | --- |
| 连接 token 短期一次性 | `connectToAsset` 每次都重新调用 `createConnectionToken` (`jumpserver-handler.ts:180`) |
| SSH tab 运行期独立于 JumpServer API | tab 建立后只与 Koko 通信，不再触发 JumpServer REST 调用 |
| 掉线 reconnect 必须重新获取 token | `overlays.ts:120-138` 在 reconnect 分支里重调 `createConnectionToken` |
| 登录状态持久化 | Keychain（`com.meterm.app.jumpserver`）+ localStorage（`meterm-active-jumpservers`）+ 内存 Map `activeJumpServers` |
| Toolbar JumpServer 图标仅在有登录连接时可见 | `toolbar.ts:347` `if (activeJumpServers.size > 0)` |
| 多连接时点击 toolbar 图标弹 dropdown | `toolbar.ts:467 showJumpServerDropdown` |

## 方案

### § 1 识别认证失效（Rust）

在 `desktop/src-tauri/src/server/jumpserver/mod.rs` 的 `do_get_multi()` 中，当所有候选路径响应都是 401/403 时，返回字符串以 `"SESSION_EXPIRED:"` 前缀开头（保持 `Result<String, String>` 签名不变）。其它错误（网络/5xx/404）保留原语义。

前端 `jumpserver-api.ts` 在捕获错误字符串时识别前缀，调用 `markSessionExpired(configName)` 并抛一个可区分的错误对象（新 class `JumpServerSessionExpiredError`）。

### § 2 前端认证状态模块（新文件）

新增 `desktop/src/jumpserver-auth-state.ts`：

```ts
export function markSessionExpired(configName: string): void
export function clearExpiredFlag(configName: string): void
export function isSessionExpired(configName: string): boolean
export async function logoutJumpServer(configName: string): Promise<void>
```

`logoutJumpServer` 的副作用（按顺序）：

1. `activeJumpServers.delete(configName)`
2. `deleteJSSecrets(configName)` — 失败仅日志警告，不阻断
3. `syncActiveJumpServersToStorage()` — 同步 localStorage
4. 若该连接对应的面板处于打开状态，`closeJumpServerPanel()`
5. 派发 `document` 事件 `'jumpserver-auth-changed'` (detail: `{ configName, state: 'logged-out' }`)
6. 触发 `renderToolbar()`（通过已有的 `'jumpserver-state-changed'` 事件）

**保留 asset SSH tab**：不遍历 tab、不关闭 session。tab 的 `jumpServerConfigMap` 条目保留——登出后 `isSessionExpired` 仍能为 true，便于 reconnect 路径做检查（见 § 5）。

### § 3 半主动过期 Banner（资产面板）

修改 `desktop/src/jumpserver-panel.ts`：

- 捕获资产/节点/账号加载过程中的 `JumpServerSessionExpiredError`
- 在面板内容区渲染 banner（替换原错误提示）：
  - 标题：`t('jsSessionExpired')` "JumpServer 会话已过期"
  - 描述：`"请重新登录以继续使用资产浏览器。已打开的终端会话不受影响。"`
  - 按钮 1 `t('jsReconnectAction')` "重新登录" → 调用 `ensureJSAuthenticated(config)` → 成功后 `clearExpiredFlag` + 重新加载资产
  - 按钮 2 `t('jsLogoutAction')` "退出登录" → 二次确认 → `logoutJumpServer`

### § 4 右键菜单

**位置 A**：资产面板 header `js-panel-header`（`jumpserver-panel.ts:290`）
**位置 B**：toolbar dropdown 每一项（`toolbar.ts:475-485` 循环内）

两处绑定 `contextmenu` 事件，复用现有 `custom-context-menu` 样式，菜单项：

- "重新登录" → `ensureJSAuthenticated`（若未过期则为无操作提示"当前连接有效"）
- "退出登录" → confirm 后 `logoutJumpServer`

不给 toolbar 图标本体加右键（单连接时点击已是切换面板的主操作，右键语义模糊且易误触；方案 A 已排除）。

### § 5 掉线 reconnect 前置检查

修改 `desktop/src/overlays.ts:113-138` 的 reconnect 按钮点击逻辑：

```ts
if (jsConfig) {
  if (isSessionExpired(jsConfig.config.name) || !activeJumpServers.has(jsConfig.config.name)) {
    // 显示提示 + 打开登录对话框（复用 ensureJSAuthenticated）
    errorEl.textContent = t('jsLoginRequired');
    // 可选：按钮文案改为"登录 JumpServer"，点击触发登录流程，成功后再次点击 reconnect
    return;
  }
  // ... 原 createConnectionToken 流程
}
```

## 非目标（YAGNI）

- 不做心跳探测 / 自动 token 刷新
- 不做"会话即将过期"提示
- 不做新增标题栏图标（用户问题中描述的"窗口标题栏 JumpServer 图标"指的是现有 toolbar 右上角按钮）
- 不重构 `do_get_multi` 多路径循环，只改错误分类
- 不在退出登录时强制关闭 SSH tab

## 数据与依赖关系图

```
用户点"重新登录" ──┐
banner 按钮 ──────┤
右键菜单项 ───────┴──> ensureJSAuthenticated(config)
                         │
                         └─> 成功: clearExpiredFlag + 重新 load 资产
                             失败: 保持 banner

用户点"退出登录" ──> confirm ──> logoutJumpServer(configName)
                                     ├─> 清 Keychain / localStorage / Map
                                     ├─> 关面板
                                     └─> emit 事件 → toolbar 重渲染

API 401/403 ──> Rust: "SESSION_EXPIRED:" 前缀
               ──> TS: JumpServerSessionExpiredError + markSessionExpired
               ──> 面板渲染 banner
               ──> overlays.ts reconnect 按钮检查后阻止 createConnectionToken
```

## 错误处理与边界

- `deleteJSSecrets` 失败：日志警告，流程继续（避免"半登出"卡死）
- 登出过程中存在进行中的 API 请求：允许自然完成/失败；`activeJumpServers.delete()` 同步，后续调用短路
- 多连接场景登出单连接：其它连接不受影响；`activeJumpServers.size === 0` 时 toolbar 图标自动消失
- 已登出后 SSH tab 掉线 reconnect：§ 5 前置检查覆盖
- 目前代码已支持多连接（`activeJumpServers` 是 Map、`showJumpServerDropdown` 存在），但该路径未经充分验证。设计不主动扩展多连接能力，仅保证右键菜单在 dropdown item 上可用

## i18n 新增 key

| key | 中文 | 英文 |
| --- | --- | --- |
| `jsSessionExpired` | JumpServer 会话已过期 | JumpServer session expired |
| `jsSessionExpiredDesc` | 请重新登录以继续使用资产浏览器。已打开的终端会话不受影响。 | Please sign in again to continue. Existing terminal sessions are not affected. |
| `jsReconnectAction` | 重新登录 | Sign in again |
| `jsLogoutAction` | 退出登录 | Sign out |
| `jsLogoutConfirm` | 退出登录 {name}？已打开的终端会话会保留。 | Sign out of {name}? Existing terminal sessions will be preserved. |
| `jsLoginRequired` | 请先重新登录 JumpServer | Please sign in to JumpServer first |

## 测试（手动）

无前端单元测试基建，验收清单：

1. 登录 JumpServer → 正常加载 → 让 session 过期（后端重启或删 cookie）→ 切换节点/刷新 → 显示过期 banner
2. banner "重新登录" → 走 MFA/密码 → 成功后资产列表恢复
3. 面板 header 右键 → "退出登录" → 确认 → toolbar 图标消失；`security find-generic-password -s com.meterm.app.jumpserver` 无残留
4. 登出前有 asset SSH tab → 登出后 tab 仍可交互输入
5. 步骤 4 的 tab 主动断开 → reconnect overlay 显示"请先重新登录"
6. 多连接：两个 JumpServer 登录后，toolbar 点击 → dropdown 出现；某 item 右键 → 登出仅影响该连接
7. `cd desktop && bunx tsc --noEmit`、`bunx vite build`、`cd src-tauri && cargo check` 全部通过

## 涉及文件清单

- 新增：`desktop/src/jumpserver-auth-state.ts`
- 修改：`desktop/src-tauri/src/server/jumpserver/mod.rs`（错误前缀）
- 修改：`desktop/src/jumpserver-api.ts`（错误识别 + `JumpServerSessionExpiredError`）
- 修改：`desktop/src/jumpserver-handler.ts`（导出 `ensureJSAuthenticated` 供登出后重登）
- 修改：`desktop/src/jumpserver-panel.ts`（过期 banner + header 右键菜单）
- 修改：`desktop/src/toolbar.ts`（dropdown item 右键菜单）
- 修改：`desktop/src/overlays.ts`（reconnect 前置检查）
- 修改：`desktop/src/i18n.ts`（新增中英文 key）
