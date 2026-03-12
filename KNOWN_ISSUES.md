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
