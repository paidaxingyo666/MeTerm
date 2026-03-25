# MeTerm 已知缺陷 / Known Issues

> 记录已知但暂不修复的缺陷和限制，供后续版本参考。
> Known defects and limitations deferred to future versions.

---

## JS-001: 多 JumpServer 实例单窗口限制

**模块**: `jumpserver-browser-window.ts`, `jumpserver-panel.ts`

**现象**: 当连接多个 JumpServer 时，资产浏览器窗口为单实例设计（固定 label `jumpserver-browser`），后连接的 JumpServer 配置会覆盖前一个。

**影响范围**:
- `localStorage` 中的 `jumpserver-config` 会被最后一次连接覆盖
- 独立窗口和停靠面板共用同一份配置，无法同时浏览不同 JumpServer 的资产
- 面板 `startDockedBrowser()` 和独立窗口 `openJumpServerBrowser()` 均读取同一个 config key

**当前状态**: 暂不修复。99% 场景只需连接单个 JumpServer，多实例需求极低。

**未来方案**（如需支持）:
1. 窗口 label 加入 JumpServer ID 后缀，支持多窗口并存
2. `localStorage` key 按 JumpServer ID 隔离
3. 面板支持多 tab 切换不同 JumpServer

---

## LNX-001: Wayland 上窗口置顶和画中画不生效

**模块**: `toolbar.ts` (`toggleAlwaysOnTop`), `pip.ts` (`enterPip`)

**现象**: 在 Ubuntu Wayland 会话下，点击「窗口置顶」或「画中画」按钮后窗口不会置于最上层。X11 会话下正常。

**根因**: Wayland 协议的安全模型不允许应用自行设置窗口层级。`setAlwaysOnTop(true)` 底层调用 `gtk_window_set_keep_above()`，在 X11 上通过 `_NET_WM_STATE_ABOVE` hint 生效，但 Wayland 合成器（GNOME Mutter）不支持此操作。画中画依赖 `setAlwaysOnTop(true)`，因此一并不生效。

**验证方式**:
```bash
# X11 后端下正常
GDK_BACKEND=x11 cargo tauri dev
```

**当前状态**: 平台限制，暂不修复。

**可能的方案**:
1. **UI 层面**: Wayland 下隐藏置顶和画中画按钮，避免用户困惑
2. **`gtk-layer-shell`**: Wayland 专用协议扩展，可实现窗口置顶，但仅 `wlr-layer-shell` 兼容的合成器支持（Sway、Hyprland 等），GNOME Mutter **不支持**
3. **等待 Wayland 生态**: 未来 `xdg-toplevel` 扩展可能增加 always-on-top 能力

---

## LNX-002: GTK CSD 顶部微小间隙（已修复）

**模块**: `commands/window.rs` (`apply_gtk_csd`)

**现象**: Linux CSD 模式下窗口顶部有数像素的透明间隙。

**根因**: 初始使用 `GtkBox` 作为空 titlebar widget，GTK 为其分配了最小高度。

**修复**: 参照 Firefox 的实现，改用 `GtkFixed`（`gtk_fixed_new()`）作为 titlebar widget，GTK 不为其分配任何空间。

---
