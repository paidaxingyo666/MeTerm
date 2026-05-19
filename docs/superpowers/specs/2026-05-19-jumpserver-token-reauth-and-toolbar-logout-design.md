# JumpServer 连接令牌重认证 + Toolbar 登出入口 — 设计

- 日期：2026-05-19
- 分支：dev-0.2.9
- 范围：desktop/（前端 TS + Rust 后端）
- 前置设计：[2026-04-20-jumpserver-reauth-and-logout-design.md](2026-04-20-jumpserver-reauth-and-logout-design.md)

## 背景与问题

v0.2.7 落地了 JumpServer 会话过期识别、登出编排、资产面板 banner、面板 header / dropdown item 右键菜单。但实际使用中暴露两个未覆盖的场景：

### 问题 1：超长时间后无法在终端 reconnect，无法拉起 MFA

JumpServer Cookie 过期但用户**只挂着 SSH tab、从未刷新过资产面板**时：

- `expiredConfigs` 集合永远不会被 [`markSessionExpired`](../../desktop/src/jumpserver-auth-state.ts#L22) 标记 —— 该函数只在 [`jumpserver-panel.ts:407,533`](../../desktop/src/jumpserver-panel.ts#L407) 和 [`jumpserver-browser-window.ts:615,848,1037`](../../desktop/src/jumpserver-browser-window.ts#L615) 捕获到 `JumpServerSessionExpiredError` 时触发。
- 用户在终端 overlay 点 reconnect → [`overlays.ts:157`](../../desktop/src/overlays.ts#L157) 的 `isSessionExpired || !activeJumpServers.has` 判断为 false → 直接走 [`createConnectionToken`](../../desktop/src/overlays.ts#L176)。
- Rust 端 [`create_connection_token`](../../desktop/src-tauri/src/server/jumpserver/mod.rs#L759) 在所有候选 body 都收到 401/403 时，返回的字符串是 `"Failed to create connection token: HTTP 401: ..."`，**没有 `SESSION_EXPIRED:` 前缀**（该前缀只有 [`do_get_multi`](../../desktop/src-tauri/src/server/jumpserver/mod.rs#L291) 才会生成）。
- 前端 [`parseJumpServerError`](../../desktop/src/jumpserver-errors.ts#L21) 找不到前缀 → 返回普通 `Error` → [`overlays.ts:272`](../../desktop/src/overlays.ts#L272) catch 块只显示文本，不触发 `ensureJSAuthenticated`。**MFA 永远不弹**。

### 问题 2：单连接场景无显式登出入口

[`toolbar.ts:353-360`](../../desktop/src/toolbar.ts#L353) 在 `activeJumpServers.size === 1` 时直接 `toggleJumpServerPanel`，没有任何登出路径。多连接场景下 dropdown item 右键菜单虽然已经支持，但发现性极差，且单连接的用户完全无路可走。

## 设计目标

- **修复**：终端 reconnect 与资产卡连接两条路径都能识别 JumpServer 会话过期并自动拉起 MFA，认证成功后**自动重试**一次而不要求用户再点。
- **新功能**：toolbar JumpServer 图标提供显式的"打开 / 重新登录 / 退出登录"入口，单/多连接交互统一。
- **不破坏**：现有右键菜单、banner、popout 流程、Rust 多路径 fallback 语义。

## 关键事实

| 事实 | 证据 |
| --- | --- |
| `do_get_multi` 已会返回 `SESSION_EXPIRED:` 前缀 | `mod.rs:291` |
| `create_connection_token` 走另一条单 URL POST 循环，错误字符串无前缀 | `mod.rs:786-822` |
| `fetchJSON` 在 HTTP 非 2xx 或 200 携带 `error` 字段时调用 `parseJumpServerError` | `jumpserver-api.ts:218-233` |
| `showJsConnectionContextMenu` 已实现"重新登录 / 退出登录（confirm）" | `jumpserver-panel.ts:678` |
| `logoutJumpServer` 已正确编排副作用（Keychain / localStorage / Map / panel / toolbar 事件） | `jumpserver-auth-state.ts:50` |

## 方案

### Part 1 — Rust 错误分类（A1）

修改 `desktop/src-tauri/src/server/jumpserver/mod.rs::create_connection_token`：

```rust
let mut had_auth_failure = false;
let mut had_other_failure = false;

for body in &bodies {
    match self.http.post(&url).headers(self.auth_headers()).json(body).send().await {
        Ok(resp) if resp.status().is_success() => { /* 成功路径不变 */ }
        Ok(resp) => {
            let status = resp.status();
            if status == reqwest::StatusCode::UNAUTHORIZED
                || status == reqwest::StatusCode::FORBIDDEN {
                had_auth_failure = true;
            } else {
                had_other_failure = true;
            }
            // last_err / 日志保留
        }
        Err(e) => {
            had_other_failure = true;
            last_err = e.to_string();
        }
    }
}

if had_auth_failure && !had_other_failure {
    Err(format!("SESSION_EXPIRED: {}", self.base_url))
} else {
    Err(format!("Failed to create connection token: {}", last_err))
}
```

**约束**：只有"所有候选响应都是 401/403 且没有任何其它失败"才触发 SESSION_EXPIRED。任意一次 5xx / 4xx 非认证 / 网络错误都回退原错误，避免把"路径找不到"或"网关错误"误标为会话过期。

### Part 2 — 前端 reconnect 自动重认证 + 重试（A2）

修改 `desktop/src/overlays.ts` 的 reconnect catch 块：

```ts
} catch (err) {
  btn.classList.remove('is-reconnecting');
  overlay.classList.remove('reconnecting');

  // JumpServer 会话过期 → 自动重认证 + 重试一次
  if (jsConfig && isJumpServerSessionExpired(err)) {
    markSessionExpired(jsConfig.config.name);
    errorEl.textContent = '';
    btn.querySelector('span')!.textContent = t('jsReconnectAction');
    StatusBar.setConnection('connecting', `JumpServer: ${jsConfig.config.name}`);

    const ok = await ensureJSAuthenticated(jsConfig.config, true);  // 弹 MFA
    if (!ok) {
      btn.querySelector('span')!.textContent = t('reconnect') || 'Reconnect';
      errorEl.textContent = t('jsLoginRequired');
      StatusBar.setConnection('disconnected', '');
      return;
    }
    // 认证成功 → 重试一次主流程（不再走到这个 catch 时为最终结果）
    btn.click();
    return;
  }

  // 其它错误：原流程
  btn.querySelector('span')!.textContent = t('reconnect') || 'Reconnect';
  errorEl.textContent = String(err);
  StatusBar.setError(`${t('sshFailed')}: ${String(err)}`);
}
```

注意：`btn.click()` 重新走一次完整 onclick 逻辑（包含 isSessionExpired 前置检查 — 但 `clearExpiredFlag` 是在 `ensureJSAuthenticated` 成功路径里调的，所以重试时分支正确进入 createConnectionToken 而不是再走重认证）。

### Part 3 — connectToAsset token 失败自动重试（A3）

修改 `desktop/src/jumpserver-handler.ts::connectToAsset` 第 248-255 行：

```ts
updateConnectingPlaceholder(t('jsConnectingToken'));
let tokenResult = await createConnectionToken(/*...*/).catch((e) => ({ ok: false, error: String(e?.message ?? e), _err: e }));

if (!tokenResult.ok) {
  // SESSION_EXPIRED → 自动重认证 + 重试一次
  if (isJumpServerSessionExpired((tokenResult as any)._err)) {
    markSessionExpired(config.name);
    updateConnectingPlaceholder(t('jsConnectingAuth'));
    const ok = await ensureJSAuthenticated(config, true);
    if (!ok) { await cleanupTab(); return; }
    updateConnectingPlaceholder(t('jsConnectingToken'));
    tokenResult = await createConnectionToken(/*...same args...*/);
  }
  if (!tokenResult.ok || !tokenResult.token) {
    throw new Error(tokenResult.error || 'Failed to create connection token');
  }
}
```

> 实现时注意 `createConnectionToken` 现在 throws（fetchJSON 失败抛 typed error），所以需要包 catch 转回带 `_err` 字段的 result 形态，或者直接 try/catch 包裹这一步。最终采用直接 try/catch 包裹更干净。

### Part 4 — Toolbar 统一 dropdown（B1）

修改 `desktop/src/toolbar.ts:346-362`：

```ts
if (activeJumpServers.size > 0) {
  const jsBtn = ...;
  jsBtn.onclick = () => showJumpServerDropdown(jsBtn);  // 删除单/多分支
}
```

### Part 5 — Dropdown 项末尾 ⋯ 按钮（B2）

修改 `desktop/src/toolbar.ts:467-523`：

```ts
for (const [name, config] of activeJumpServers) {
  const row = document.createElement('div');
  row.className = 'js-dropdown-item';

  const mainBtn = document.createElement('button');
  mainBtn.className = 'js-dropdown-item-main';
  mainBtn.type = 'button';
  mainBtn.textContent = name;
  mainBtn.onclick = () => { cleanup(); toggleJumpServerPanel(config); };

  const actionsBtn = document.createElement('button');
  actionsBtn.className = 'js-dropdown-item-actions';
  actionsBtn.type = 'button';
  actionsBtn.title = t('jsItemActionsTitle');
  actionsBtn.setAttribute('aria-label', t('jsItemActionsTitle'));
  actionsBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/></svg>';
  actionsBtn.onclick = (e) => {
    e.stopPropagation();
    const r = actionsBtn.getBoundingClientRect();
    cleanup();
    showJsConnectionContextMenu(r.left, r.bottom + 4, config);
  };

  row.appendChild(mainBtn);
  row.appendChild(actionsBtn);

  // 保留右键作为快捷方式
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    cleanup();
    showJsConnectionContextMenu(e.clientX, e.clientY, config);
  });

  menu.appendChild(row);
}
```

### Part 6 — CSS 样式

新增样式（位置在 toolbar 相关 css 文件，按现有约定）：

```css
.js-dropdown-item {
  display: flex;
  align-items: stretch;
  width: 100%;
}
.js-dropdown-item-main {
  flex: 1;
  text-align: left;
  /* 沿用 .custom-context-menu-item 的 padding / hover */
}
.js-dropdown-item-actions {
  flex: 0 0 auto;
  width: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.55;
  border-left: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
  background: transparent;
  cursor: pointer;
  color: inherit;
}
.js-dropdown-item-actions:hover { opacity: 1; background: var(--hover-bg, rgba(255,255,255,0.06)); }
.js-dropdown-item-main { /* 复用 .custom-context-menu-item 样式 */ }
```

实现时优先复用 `.custom-context-menu-item` 已有 padding / hover 规则；只增量声明 flex 布局与 ⋯ 按钮自身样式。

### Part 7 — i18n

新增 1 个 key：

| key | 中文 | 英文 |
| --- | --- | --- |
| `jsItemActionsTitle` | 操作 | Actions |

## 非目标（YAGNI）

- 不加心跳 / 自动 token 刷新
- 不动 banner 体验
- 不动 toolbar 图标右键事件（避免双重入口造成混乱；用户已选 dropdown 方案）
- 不重构 do_get_multi 多路径循环
- 不强制关闭已打开的 SSH tab

## 涉及文件清单

| 文件 | 类型 | 改动摘要 |
| --- | --- | --- |
| `desktop/src-tauri/src/server/jumpserver/mod.rs` | 修改 | `create_connection_token` 错误分类返回 SESSION_EXPIRED 前缀 |
| `desktop/src/overlays.ts` | 修改 | reconnect catch 自动重认证 + `btn.click()` 重试 |
| `desktop/src/jumpserver-handler.ts` | 修改 | `connectToAsset` token 失败 → 重认证 → 重试 token |
| `desktop/src/toolbar.ts` | 修改 | 统一 dropdown + 每项双按钮结构 |
| `desktop/src/styles/toolbar.css`（或就近文件） | 修改 | `.js-dropdown-item*` 三个类 |
| `desktop/src/i18n.ts` | 修改 | `jsItemActionsTitle` 中英文 |

## 测试要点（手动）

1. 登录 JumpServer → 等 cookie 过期 → 终端断开 → reconnect → 自动弹 MFA → token 重发 → 终端连上
2. cookie 过期 → 从资产卡"连接" → 自动弹 MFA → token 重发 → 终端连上
3. cookie 有效 → reconnect → 不弹 MFA，正常重连
4. 后端 5xx 模拟 → reconnect → 报错，不误触发 MFA
5. 单连接 → toolbar JS 图标 → 弹 dropdown（1 项 + ⋯）
6. 多连接 → 同上（N 项 + 各自 ⋯）
7. 点项左半 → 打开 / 切换面板
8. 点项末尾 ⋯ → 子菜单"重新登录 / 退出登录"
9. 退出登录 → confirm 框 → 确认 → toolbar 图标消失（最后一个）或该项从 dropdown 移除
10. SSH tab 在登出后仍可输入
11. `cd desktop && bunx tsc --noEmit`、`bunx vite build`、`cd desktop/src-tauri && cargo check` 全过
