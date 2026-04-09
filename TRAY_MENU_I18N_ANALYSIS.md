# 托盘菜单国际化集成分析

## 1. 当前托盘菜单实现

### 位置
- **文件**: `desktop/src-tauri/src/lib.rs` (第 34-68 行)
- **框架**: Tauri 菜单系统

### 当前结构
```rust
// 硬编码的英文标签
let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
let new_window_item = MenuItem::with_id(app, "new_window", "New Window", true, None::<&str>)?;
let menu = Menu::with_items(app, &[&new_window_item, &quit_item])?;

// 菜单事件处理
.on_menu_event(|app, event| match event.id.as_ref() {
    "quit" => { app.exit(0); }
    "new_window" => { /* show main window */ }
    _ => {}
})
```

### 当前限制
- ✗ 菜单标签硬编码为英文
- ✗ 无法动态更新菜单文本
- ✗ 无法响应语言变更事件
- ✗ 菜单在应用启动时创建，之后不可修改

---

## 2. 前端国际化流程

### 位置
- **i18n 核心**: `desktop/src/i18n.ts`
- **设置面板**: `desktop/src/settings.ts`
- **主应用**: `desktop/src/main.ts`

### 当前流程
```
1. 初始化 (main.ts:185)
   └─ initLanguage() → 从 localStorage 读取或使用浏览器语言
   └─ setLanguage(settings.language) → 设置当前语言

2. 语言变更 (settings.ts:60-66)
   └─ 用户在设置面板选择语言
   └─ setLanguage(language) → 更新全局状态
   └─ saveSettings(newSettings) → 持久化到 localStorage
   └─ onLanguageChange() 回调 → 重新渲染 UI

3. 翻译查询
   └─ t(key) 函数 → 返回 translations[currentLanguage][key]
```

### 翻译数据结构
```typescript
// i18n.ts:23-62
const translations: Record<Language, Translations> = {
  en: { appName, settings, theme, ... },
  zh: { appName, settings, theme, ... }
}
```

### 语言设置存储
- **存储键**: `meterm-language` (localStorage)
- **存储键**: `meterm-settings` (localStorage) - 包含 language 字段
- **类型**: `'en' | 'zh'`

---

## 3. IPC 通信现状

### 现有 Tauri 命令 (commands.rs)
```rust
#[tauri::command]
pub fn get_meterm_port(state: State<'_, MeTermProcess>) -> Result<u16, String>

#[tauri::command]
pub async fn create_session(state: State<'_, MeTermProcess>) -> Result<String, String>

#[tauri::command]
pub async fn list_sessions(state: State<'_, MeTermProcess>) -> Result<String, String>

#[tauri::command]
pub async fn delete_session(state: State<'_, MeTermProcess>, session_id: String) -> Result<String, String>
```

### 前端 IPC 调用 (connection.ts, tabs.ts)
```typescript
import { invoke } from '@tauri-apps/api/core';

// 调用 Rust 命令
await invoke<number>('get_meterm_port');
await invoke<string>('create_session');
await invoke<string>('list_sessions');
await invoke('delete_session', { sessionId });
```

### 事件系统
- **前端**: 使用 CustomEvent 和 DOM 事件监听 (main.ts:255-262)
- **Rust**: 无现有事件发送机制

---

## 4. 菜单重建的技术障碍

### Tauri 菜单 API 限制
1. **菜单在启动时创建** - 在 `setup()` 钩子中创建
2. **无原生动态更新** - Tauri v2 不支持运行时菜单文本更新
3. **菜单项 ID 固定** - 事件处理基于 ID 匹配

### 可行的解决方案

#### 方案 A: 菜单重建（推荐）
- 销毁现有菜单
- 创建新菜单（带新标签）
- 重新绑定事件处理器
- **优点**: 完全支持，无依赖
- **缺点**: 需要存储菜单引用，可能有闪烁

#### 方案 B: 事件驱动更新
- 前端发送语言变更命令到 Rust
- Rust 重建菜单
- **优点**: 清晰的数据流
- **缺点**: 需要新的 Tauri 命令

#### 方案 C: 延迟初始化
- 在应用完全启动后创建菜单
- 读取前端的语言设置
- **优点**: 简单
- **缺点**: 菜单可能延迟出现

---

## 5. 集成方案（最小化、稳健）

### 步骤 1: 添加翻译键到 i18n.ts
```typescript
// desktop/src/i18n.ts
export interface Translations {
  // ... 现有键
  trayQuit: string;        // "Quit" / "退出"
  trayNewWindow: string;   // "New Window" / "新建窗口"
}

const translations: Record<Language, Translations> = {
  en: {
    // ...
    trayQuit: 'Quit',
    trayNewWindow: 'New Window',
  },
  zh: {
    // ...
    trayQuit: '退出',
    trayNewWindow: '新建窗口',
  },
};
```

### 步骤 2: 添加菜单重建命令到 Rust
```rust
// desktop/src-tauri/src/commands.rs
#[tauri::command]
pub fn rebuild_tray_menu(
    app: tauri::AppHandle,
    quit_label: String,
    new_window_label: String,
) -> Result<(), String> {
    // 1. 获取现有托盘
    // 2. 销毁菜单
    // 3. 创建新菜单（使用新标签）
    // 4. 重新绑定事件
    Ok(())
}
```

### 步骤 3: 前端调用菜单重建
```typescript
// desktop/src/main.ts - 在 onLanguageChange 回调中
onLanguageChange: async () => {
    // 重新渲染 UI
    renderTabs();
    
    // 重建托盘菜单
    await invoke('rebuild_tray_menu', {
        quitLabel: t('trayQuit'),
        newWindowLabel: t('trayNewWindow'),
    });
    
    // ... 其他更新
},
```

### 步骤 4: 初始化时使用正确的语言
```rust
// desktop/src-tauri/src/lib.rs - setup() 中
// 从前端读取语言设置（通过命令或配置文件）
// 或使用默认语言创建菜单，让前端在加载后重建
```

---

## 6. 文件修改清单

### 需要修改的文件
1. **`desktop/src/i18n.ts`**
   - 添加 `trayQuit` 和 `trayNewWindow` 翻译键
   - 更新 `Translations` 接口

2. **`desktop/src-tauri/src/commands.rs`**
   - 添加 `rebuild_tray_menu` 命令
   - 实现菜单重建逻辑

3. **`desktop/src-tauri/src/lib.rs`**
   - 在 `invoke_handler` 中注册 `rebuild_tray_menu`
   - 可选：存储菜单引用以便重建

4. **`desktop/src/settings.ts`**
   - 在 `onLanguageChange` 回调中调用 `rebuild_tray_menu`

5. **`desktop/src/main.ts`**
   - 在 `onLanguageChange` 回调中调用菜单重建

### 不需要修改
- ✓ `desktop/src-tauri/src/sidecar.rs` - 无关
- ✓ `desktop/src/themes.ts` - 无关
- ✓ `desktop/src/connection.ts` - 无关
- ✓ `desktop/src/tabs.ts` - 无关

---

## 7. 实现复杂度评估

### 低复杂度部分
- ✓ 添加翻译键 (5 分钟)
- ✓ 前端调用命令 (5 分钟)

### 中等复杂度部分
- ⚠ 菜单重建逻辑 (30 分钟)
  - 需要理解 Tauri 菜单 API
  - 需要处理菜单引用生命周期
  - 需要测试菜单事件绑定

### 总体工作量
- **前端**: ~10 分钟
- **Rust**: ~30-45 分钟
- **测试**: ~15 分钟
- **总计**: ~1 小时

---

## 8. 替代方案对比

| 方案 | 复杂度 | 可维护性 | 用户体验 | 推荐度 |
|------|--------|---------|---------|--------|
| **菜单重建** | 中 | 高 | 好 | ⭐⭐⭐⭐⭐ |
| 事件驱动 | 中 | 中 | 好 | ⭐⭐⭐ |
| 延迟初始化 | 低 | 低 | 差 | ⭐⭐ |
| 硬编码多语言 | 低 | 低 | 差 | ⭐ |

---

## 9. 关键技术细节

### Tauri 菜单 API
```rust
// 创建菜单项
let item = MenuItem::with_id(app, id, label, enabled, accelerator)?;

// 创建菜单
let menu = Menu::with_items(app, &[&item1, &item2])?;

// 绑定到托盘
TrayIconBuilder::with_id("main-tray")
    .menu(&menu)
    .on_menu_event(|app, event| { /* 处理事件 */ })
    .build(app)?;
```

### 菜单重建的关键点
1. **菜单项生命周期** - 菜单项必须在菜单创建时存在
2. **事件处理** - 每次重建都需要重新绑定 `on_menu_event`
3. **托盘引用** - 需要存储托盘引用以便更新

### 推荐的存储方式
```rust
// 使用 Tauri 的 State 管理
pub struct AppState {
    tray: Arc<Mutex<Option<TrayIcon>>>,
}

// 或使用全局变量（不推荐）
static TRAY: Mutex<Option<TrayIcon>> = Mutex::new(None);
```

---

## 10. 风险和缓解

### 风险 1: 菜单闪烁
- **原因**: 销毁和重建菜单
- **缓解**: 使用快速的菜单重建，或在后台线程中执行

### 风险 2: 事件处理丢失
- **原因**: 重建时事件处理器未正确绑定
- **缓解**: 确保每次重建都绑定完整的事件处理器

### 风险 3: 内存泄漏
- **原因**: 旧菜单引用未正确释放
- **缓解**: 使用 Rust 的所有权系统，确保旧菜单被销毁

---

## 总结

**推荐方案**: 菜单重建 + 事件驱动

**核心流程**:
1. 前端语言变更 → 调用 `rebuild_tray_menu` 命令
2. Rust 接收命令 → 销毁旧菜单 → 创建新菜单（新标签）
3. 菜单事件继续正常工作

**最小化修改**:
- 5 个文件修改
- ~100 行代码添加
- 无新依赖
- 完全向后兼容

**集成点**:
- IPC: `invoke('rebuild_tray_menu', { quitLabel, newWindowLabel })`
- 触发点: `settings.ts` 的 `onLanguageChange` 回调
- 数据源: `i18n.ts` 的翻译对象
