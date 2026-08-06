//! Agent 镜像 hook 文件生成(M2)。
//!
//! 在 PTY 会话的临时 hook_dir(zsh 经 ZDOTDIR / bash 经 --rcfile)里额外写两个产物,
//! 并在代理 rc(.zshrc/.bashrc)末尾追加一个 `claude` 包装函数:
//!
//! 1. `meterm-claude-hooks.json` —— 传给 `claude --settings` 的会话级 hooks 文件。
//!    纯观察者:SessionStart(非 async,尽快建镜像/拿 transcript_path)+ UserPromptSubmit /
//!    PreToolUse / PostToolUse / Stop / StopFailure / Notification / SessionEnd(全部 async,
//!    不阻塞 claude;SessionEnd 为 Task D 退出检测)。
//!    **绝无任何会进模型上下文的字段**(additionalContext / updatedInput / permissionDecision /
//!    hookSpecificOutput …)—— 零 token 硬约束。
//! 2. `meterm-hook-forward.sh` —— 转发脚本(chmod +x)。读 stdin(hook JSON)+ env
//!    (METERM_SESSION_ID / METERM_HOOK_PORT / METERM_HOOK_SECRET,由 PTY 注入、
//!    claude→hook 子进程按环境继承),带 header POST 到桌面本机端点 `/api/agent-hook`。
//!    curl 失败静默(不影响 claude),不向 stdout 写任何内容(零 token),exit 0。
//!
//! rc 追加的 `claude` 包装函数用 `command claude` 绕过自身(不递归),给真 claude 加
//! `--settings <hooks.json>`。`--settings` hooks 与用户已有 hooks **深合并不覆盖**(已实证),
//! 用户自己敲 `claude`(Q1a)与 MeTerm 自动起 `claude`(Q1b)都被拦截注入,一套机制两种进入。
//!
//! hooks.json 的绝对路径**不字面写死进 rc**,而是引用 `$METERM_CLAUDE_HOOKS` env
//! (由 `PtyTerminal::new` 经 `cmd.env(...)` 注入,不经 shell 解析)。此前把路径直接插进
//! rc 的双引号赋值 `meterm_claude_hooks="<path>"` 会被 shell 解释 `$`/`` ` ``/`"`/`\`,
//! 理论上若 TMPDIR 含这些字符会触发命令替换/语法错误;env 注入从根上消除该插值面。
//!
//! 端点 `/api/agent-hook` 由 M3 建;M2 只把产物落地(claude 一跑就生效),端到端等 M3。

use std::path::Path;

/// 传给 `claude --settings` 的会话级 hooks 文件名(落在 hook_dir 内)。
pub const HOOKS_SETTINGS_NAME: &str = "meterm-claude-hooks.json";
/// 转发脚本文件名(落在 hook_dir 内,chmod +x)。
pub const FORWARD_SCRIPT_NAME: &str = "meterm-hook-forward.sh";

/// 转发脚本内容(观察者事件零 stdout、静默失败;PermissionRequest 审批桥例外)。
/// `$1` = hook 事件名;stdin = claude 传入的 hook JSON。
///
/// PermissionRequest 分支(P2 审批桥):**同步阻塞**长超时(90s)等桌面响应,响应体
/// (`{"hookSpecificOutput":{…decision…}}` 或空)透传到 stdout = hook 输出。桌面超时 /
/// 手机未决 / 任何失败 → 输出空,claude 视为 hook 不干预 → 原生 TUI 弹窗兜底
/// (fail-open-to-TUI,审批永不因镜像层故障被吞)。
/// 其余 8 个观察者事件维持原契约:短超时(2s)、丢弃响应、零 stdout(零 token)。
const FORWARD_SCRIPT: &str = r#"#!/bin/bash
# MeTerm agent 镜像转发脚本。
# $1 = hook 事件名;stdin = claude 传入的 hook JSON。
# env(METERM_SESSION_ID / METERM_HOOK_PORT / METERM_HOOK_SECRET)由 PTY 注入,
# claude→hook 子进程按环境继承。带 header POST 到桌面本机 hook 端点。
# 观察者事件:零 stdout(零 token)、curl 失败静默、始终 exit 0。
# PermissionRequest(审批桥):长超时同步等桌面决策,响应体透传 stdout = hook 输出;
# 失败/超时输出空 → claude 视为不干预,回落原生 TUI 弹窗(fail-open-to-TUI)。
_ev="$1"
_body="$(cat)"
if [ "$_ev" = "PermissionRequest" ]; then
  curl -sS -m 90 -X POST "http://127.0.0.1:${METERM_HOOK_PORT}/api/agent-hook" \
    -H "Content-Type: application/json" \
    -H "X-Meterm-Session: ${METERM_SESSION_ID}" \
    -H "X-Meterm-Secret: ${METERM_HOOK_SECRET}" \
    -H "X-Meterm-Hook-Event: ${_ev}" \
    -H "X-Meterm-Effort: ${CLAUDE_EFFORT}" \
    --data-binary "$_body" 2>/dev/null || true
  exit 0
fi
curl -sS -m 2 -X POST "http://127.0.0.1:${METERM_HOOK_PORT}/api/agent-hook" \
  -H "Content-Type: application/json" \
  -H "X-Meterm-Session: ${METERM_SESSION_ID}" \
  -H "X-Meterm-Secret: ${METERM_HOOK_SECRET}" \
  -H "X-Meterm-Hook-Event: ${_ev}" \
  -H "X-Meterm-Effort: ${CLAUDE_EFFORT}" \
  --data-binary "$_body" >/dev/null 2>&1 || true
exit 0
"#;

/// 单个 command 型 hook 对象(exec 形式:command 指向转发脚本,args 传事件名,不经 shell)。
fn command_hook(script: &str, event: &str, is_async: bool) -> serde_json::Value {
    serde_json::json!({
        "type": "command",
        "command": script,
        "args": [event],
        "async": is_async,
    })
}

/// 单个事件分组。矩阵型事件(PreToolUse/PostToolUse)带空 matcher(匹配全部);
/// 其余事件无 matcher。
fn event_group(script: &str, event: &str, is_async: bool, with_matcher: bool) -> serde_json::Value {
    let hook = command_hook(script, event, is_async);
    if with_matcher {
        serde_json::json!({ "matcher": "", "hooks": [hook] })
    } else {
        serde_json::json!({ "hooks": [hook] })
    }
}

/// 构造会话级 hooks settings JSON(pretty)。`script` = 转发脚本绝对路径。
///
/// 8 个观察者事件 + 1 个审批桥事件(PermissionRequest);除 SessionStart 与
/// PermissionRequest 外全部 `async: true`;PreToolUse/PostToolUse/PermissionRequest
/// 为矩阵型事件带空 matcher。全部为 command 型,**注册表本身不含任何注入字段**
/// (零 token;审批桥的 decision 输出由转发脚本按响应体透传,见 [`FORWARD_SCRIPT`])。
pub fn build_hooks_settings_json(script: &str) -> String {
    let settings = serde_json::json!({
        "hooks": {
            // 非 async:尽快建镜像 + 拿 transcript_path(M4 用)。
            "SessionStart":     [event_group(script, "SessionStart", false, false)],
            // 以下全部 async:纯观察、不阻塞 claude → 零延迟、零 token。
            "UserPromptSubmit": [event_group(script, "UserPromptSubmit", true, false)],
            "PreToolUse":       [event_group(script, "PreToolUse", true, true)],
            "PostToolUse":      [event_group(script, "PostToolUse", true, true)],
            "Stop":             [event_group(script, "Stop", true, false)],
            "StopFailure":      [event_group(script, "StopFailure", true, false)],
            "Notification":     [event_group(script, "Notification", true, false)],
            // Task D:claude 正常退出信号 → 桌面幂等清理镜像(发 MirrorEnded、停 tailer)。
            // async(纯观察者):不阻塞 claude 退出流程,零 token。硬退出(SIGKILL/崩溃)
            // 收不到本事件,由 OSC 7768 ShellState 兜底(见 agent/hook.rs)。
            "SessionEnd":       [event_group(script, "SessionEnd", true, false)],
            // P2 审批桥:**非 async**(claude 阻塞等 hook 输出 = 等手机决策),矩阵型
            // 空 matcher(全部工具)。桌面超时/失败输出空 → 回落原生 TUI 弹窗。
            "PermissionRequest": [event_group(script, "PermissionRequest", false, true)],
            // fix4 对话实时展示:assistant 正文流式期间按「新完成行批」触发,delta 为
            // markdown 原文(实证)→ 桌面直接下行 AssistantDelta,消除整轮延迟。
            // async(纯观察者):零延迟、零 token;带空 matcher(实测该形态触发正常)。
            "MessageDisplay": [event_group(script, "MessageDisplay", true, true)],
        }
    });
    serde_json::to_string_pretty(&settings).unwrap_or_default()
}

/// rc 末尾追加的 `claude` 包装函数片段。hooks.json 绝对路径**不作为参数写死进 rc**,
/// 而是引用 `$METERM_CLAUDE_HOOKS` env(由 `PtyTerminal::new` 注入,值与此处写入
/// `HOOKS_SETTINGS_NAME` 的路径一致)——避免路径含 shell 特殊字符时被字面插值解释。
///
/// `command claude` 绕过本函数取真 claude(不递归),zsh/bash 同语法。追加在用户 rc 之后:
/// 若用户自己也定义了 `claude` 函数/别名,本函数会覆盖它(已知取舍,注释标注)。
///
/// 防御性守卫:同时判 env 是否已设 **且** hooks 文件是否真实存在(`-f`),两者皆满足才注入
/// `--settings`。仅判 env 是否设(旧实现)不够——`install_agent_mirror` 第 2 步的
/// hooks.json 写入是 best-effort(`let _ = std::fs::write(...)`),若该步失败(例如磁盘满/
/// 权限问题)而 env 仍已注入(PtyTerminal::new 先于 install_agent_mirror 写 env,顺序上
/// 不依赖写入是否成功),`claude --settings <不存在的文件>` 会直接报错退出、**不执行**
/// (已实测),等于把用户的核心命令 `claude` 搞挂。加 `-f` 后,任一条件不满足都退化为
/// 裸 `command claude "$@"`(不注入 hooks,claude 照常可用)——最坏只是没镜像,claude
/// 永不因此失败。
pub fn claude_wrapper_snippet() -> String {
    "\n# ── MeTerm: 给 claude 注入会话级镜像 hooks(--settings 与用户 hooks 深合并,不覆盖) ──\n\
     # 已知取舍:若用户在自己的 rc 里也定义了 claude 函数/别名,本函数追加在后会覆盖它。\n\
     # hooks.json 路径经 METERM_CLAUDE_HOOKS env 注入(PtyTerminal::new 写入),不写死进 rc。\n\
     # 守卫同时判 env 已设 + 文件存在(-f):hooks.json 写入是 best-effort,写失败时若只判\n\
     # env 会导致 --settings 指向缺失文件,claude 直接报错不执行,搞挂核心命令。\n\
     claude() {\n\
       if [ -n \"$METERM_CLAUDE_HOOKS\" ] && [ -f \"$METERM_CLAUDE_HOOKS\" ]; then\n\
         command claude --settings \"$METERM_CLAUDE_HOOKS\" \"$@\"\n\
       else\n\
         command claude \"$@\"\n\
       fi\n\
     }\n"
    .to_string()
}

/// rc 末尾(紧跟 `claude` 包装函数之后)追加的守卫式自动运行片段(M7:显式新建镜像会话)。
///
/// 该行**静态无条件写进所有 zsh/bash 会话的 rc**,运行与否由 `METERM_AUTO_CLAUDE` env 控制:
/// - 普通会话无该 env → 守卫不成立 → no-op(零副作用、零 token)。
/// - REST 建会话请求 `auto_claude=true` 时,handlers.rs 注入 `METERM_AUTO_CLAUDE=1`,
///   rc 加载完(claude() 已定义、用户原 rc 已 source)时守卫成立 → 自动跑 `claude`。
///
/// 关键约束:
/// - 必须紧跟 `claude()` 定义**之后**追加(函数已定义才能调),`claude` 走上面的包装函数(带 hooks)。
/// - `unset METERM_AUTO_CLAUDE` 先行:防止用户手动 `source ~/.zshrc` 时重复触发
///   (rc 只在 shell 启动时 source 一次,unset 后 re-source 守卫不再成立)。
/// - 单行 POSIX `if`(zsh/bash 通用),不注入任何额外文本——与手敲 `claude` 走完全相同下游。
pub fn auto_run_snippet() -> String {
    "\n# ── MeTerm: 显式新建镜像会话时自动进入 claude(仅当 METERM_AUTO_CLAUDE 置位)──\n\
     # 静态写进所有 zsh/bash 会话 rc,运行与否由 env 控制;普通会话无 env → no-op(零副作用)。\n\
     # unset 先行:防止用户手动 `source ~/.zshrc` 重复触发;rc 只在 shell 启动 source 一次。\n\
     # 紧跟 claude() 定义之后,claude 走上面刚定义的包装函数(带 --settings hooks)。\n\
     if [ -n \"$METERM_AUTO_CLAUDE\" ]; then unset METERM_AUTO_CLAUDE; claude; fi\n"
        .to_string()
}

/// 把 agent 镜像产物装进 hook_dir 并在 rc 末尾追加 claude 包装函数。
///
/// - `dir`:会话 hook_dir(退出时随 PtyTerminal drop 清理)。
/// - `rc_file`:代理 rc 绝对路径(zsh = `dir/.zshrc`,bash = `dir/.bashrc`),须已写入。
///
/// 全部 best-effort(与既有 hook 写入一致):任何一步失败都不影响终端会话本身。
pub fn install_agent_mirror(dir: &Path, rc_file: &Path) {
    // 1. 转发脚本 + chmod 0o755
    let script_path = dir.join(FORWARD_SCRIPT_NAME);
    if std::fs::write(&script_path, FORWARD_SCRIPT).is_ok() {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755));
    }

    // 2. hooks settings JSON
    let settings_path = dir.join(HOOKS_SETTINGS_NAME);
    let _ = std::fs::write(
        &settings_path,
        build_hooks_settings_json(&script_path.to_string_lossy()),
    );

    // 3. rc 末尾追加 claude 包装函数(引用 METERM_CLAUDE_HOOKS env,不写死路径;
    //    该 env 由 PtyTerminal::new 注入,值 = 本函数上面写入的 settings_path),
    //    紧跟其后再追加 M7 守卫式自动运行行(同一文件句柄顺序写,保证守卫行在函数定义之后)。
    use std::io::Write;
    let snippet = claude_wrapper_snippet();
    if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(rc_file) {
        let _ = f.write_all(snippet.as_bytes());
        // 守卫式自动运行:普通会话(无 METERM_AUTO_CLAUDE)下 no-op,零副作用。
        let _ = f.write_all(auto_run_snippet().as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用固定脚本路径。
    const SCRIPT: &str = "/tmp/meterm-hook-xyz/meterm-hook-forward.sh";

    /// 全部事件所在的注册表键(8 观察者 + 1 审批桥 + 1 实时正文)。
    const ALL_EVENTS: [&str; 10] = [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "Stop",
        "StopFailure",
        "Notification",
        "SessionEnd",
        "PermissionRequest",
        "MessageDisplay",
    ];

    /// 事件齐全且恰好只有这 10 个(不多不少):8 观察者 + PermissionRequest(P2 审批桥)
    /// + MessageDisplay(fix4 实时正文)。
    #[test]
    fn test_hooks_has_exactly_ten_events() {
        let json = build_hooks_settings_json(SCRIPT);
        let v: serde_json::Value = serde_json::from_str(&json).expect("hooks JSON 必须可解析");
        let hooks = v["hooks"].as_object().expect("必须有 hooks 对象");
        assert_eq!(hooks.len(), ALL_EVENTS.len(), "事件数必须恰为 10");
        for ev in ALL_EVENTS {
            assert!(hooks.contains_key(ev), "缺少事件 {}", ev);
        }
    }

    /// SessionStart 与 PermissionRequest 非 async(前者尽快建镜像,后者阻塞等手机决策);
    /// 其余 8 个观察者事件(含 MessageDisplay)async: true。
    #[test]
    fn test_async_flags_per_event() {
        let json = build_hooks_settings_json(SCRIPT);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let async_of =
            |event: &str| -> Option<bool> { v["hooks"][event][0]["hooks"][0]["async"].as_bool() };
        assert_eq!(
            async_of("SessionStart"),
            Some(false),
            "SessionStart 必须非 async"
        );
        assert_eq!(
            async_of("PermissionRequest"),
            Some(false),
            "PermissionRequest 必须非 async(claude 阻塞等 hook 输出 = 等手机决策)"
        );
        for ev in [
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
            "Stop",
            "StopFailure",
            "Notification",
            "SessionEnd",
            "MessageDisplay",
        ] {
            assert_eq!(
                async_of(ev),
                Some(true),
                "{} 必须 async(纯观察者,不阻塞 claude 退出)",
                ev
            );
        }
    }

    /// 每个事件的 command 指向转发脚本,args 为该事件名,type 为 command。
    #[test]
    fn test_command_points_to_forward_script_with_event_arg() {
        let json = build_hooks_settings_json(SCRIPT);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        for ev in ALL_EVENTS {
            let hook = &v["hooks"][ev][0]["hooks"][0];
            assert_eq!(hook["type"], "command", "{} type 必须 command", ev);
            assert_eq!(hook["command"], SCRIPT, "{} command 必须指向转发脚本", ev);
            assert_eq!(hook["args"][0], ev, "{} args 首元素必须是事件名", ev);
        }
    }

    /// 矩阵型/带空 matcher 事件(PreToolUse/PostToolUse/PermissionRequest/MessageDisplay);
    /// 其余无 matcher 键。
    #[test]
    fn test_matrix_events_have_empty_matcher_others_none() {
        let json = build_hooks_settings_json(SCRIPT);
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        for ev in [
            "PreToolUse",
            "PostToolUse",
            "PermissionRequest",
            "MessageDisplay",
        ] {
            assert_eq!(v["hooks"][ev][0]["matcher"], "", "{} 必须空 matcher", ev);
        }
        for ev in [
            "SessionStart",
            "UserPromptSubmit",
            "Stop",
            "StopFailure",
            "Notification",
            "SessionEnd",
        ] {
            assert!(
                v["hooks"][ev][0].get("matcher").is_none(),
                "{} 不应有 matcher 键",
                ev
            );
        }
    }

    /// 零 token 守死:hooks JSON(注册表)绝不含任何会进模型上下文的注入字段。
    /// 审批桥的 decision 输出走转发脚本响应体透传,不进注册表。
    #[test]
    fn test_no_injection_fields_zero_token() {
        let json = build_hooks_settings_json(SCRIPT);
        for forbidden in [
            "additionalContext",
            "updatedInput",
            "permissionDecision",
            "hookSpecificOutput",
            "systemMessage",
            "decision",
            "\"prompt\"",
        ] {
            assert!(
                !json.contains(forbidden),
                "hooks JSON 不得含注入字段 {}(零 token 硬约束)",
                forbidden
            );
        }
    }

    /// 转发脚本:正确 endpoint / 三个 header / 静默失败 / 观察者事件无 stdout / exit 0;
    /// PermissionRequest 分支长超时 + 响应体透传 stdout(审批桥)。
    #[test]
    fn test_forward_script_contract() {
        let s = FORWARD_SCRIPT;
        assert!(s.starts_with("#!/bin/bash"), "须有 shebang");
        assert!(
            s.contains("http://127.0.0.1:${METERM_HOOK_PORT}/api/agent-hook"),
            "endpoint 须指向本机 /api/agent-hook"
        );
        assert!(
            s.contains("X-Meterm-Session: ${METERM_SESSION_ID}"),
            "缺 session header"
        );
        assert!(
            s.contains("X-Meterm-Secret: ${METERM_HOOK_SECRET}"),
            "缺 secret header"
        );
        assert!(s.contains("X-Meterm-Hook-Event: ${_ev}"), "缺事件名 header");
        // fix7:思考等级回报——claude 把当前 effort 经 CLAUDE_EFFORT env 暴露给 hook
        // 子进程;env 未设时 curl 对空值 header 直接不发送,桌面侧读不到即跳过。
        assert!(
            s.contains("X-Meterm-Effort: ${CLAUDE_EFFORT}"),
            "缺 effort header"
        );
        assert!(s.contains("|| true"), "curl 失败须静默(|| true)");
        assert!(
            s.contains(">/dev/null 2>&1"),
            "观察者事件 curl 输出须丢弃(零 stdout)"
        );
        assert!(s.trim_end().ends_with("exit 0"), "须 exit 0");
        // 零 token:脚本不得自己拼接任何 stdout 输出(无 echo/printf;审批桥的 stdout
        // 是桌面响应体原样透传,不是脚本生成的文本)。
        assert!(
            !s.contains("echo "),
            "转发脚本不得 echo(会污染 stdout / 增 token)"
        );
        assert!(!s.contains("printf "), "转发脚本不得 printf 到 stdout");
    }

    /// 审批桥分支契约:按事件名分流;长超时(-m 90,远大于观察者的 2s、小于 claude 的
    /// 600s hook 超时);响应体**不重定向**(透传 stdout = hook 输出);失败静默(2>/dev/null
    /// + || true → 输出空,claude 视为不干预回落 TUI 弹窗)。
    #[test]
    fn test_forward_script_permission_branch() {
        let s = FORWARD_SCRIPT;
        assert!(
            s.contains(r#"if [ "$_ev" = "PermissionRequest" ]; then"#),
            "须按事件名分流 PermissionRequest"
        );
        // 分支体:长超时 + stderr 丢弃但 stdout 透传。
        let branch = s
            .split(r#"if [ "$_ev" = "PermissionRequest" ]; then"#)
            .nth(1)
            .and_then(|rest| rest.split("fi").next())
            .expect("须有 PermissionRequest 分支体");
        assert!(branch.contains("-m 90"), "审批桥须长超时 90s");
        assert!(branch.contains("2>/dev/null"), "审批桥须丢弃 stderr");
        assert!(
            !branch.contains(">/dev/null 2>&1"),
            "审批桥不得丢弃 stdout(响应体 = hook 输出)"
        );
        assert!(
            branch.contains("|| true"),
            "审批桥 curl 失败须静默(输出空回落 TUI)"
        );
        assert!(branch.contains("exit 0"), "审批桥分支须 exit 0");
    }

    /// claude 包装函数片段:command claude + --settings + 引用 env(不写死路径)+ 不递归 + 防御性守卫。
    #[test]
    fn test_claude_wrapper_snippet() {
        let snippet = claude_wrapper_snippet();
        assert!(snippet.contains("claude()"), "须定义 claude 函数");
        assert!(
            snippet.contains("command claude --settings \"$METERM_CLAUDE_HOOKS\""),
            "须用 command claude 绕过自身 + --settings 引用 METERM_CLAUDE_HOOKS env 注入"
        );
        assert!(
            snippet.contains("[ -n \"$METERM_CLAUDE_HOOKS\" ]"),
            "须有 env 是否已设的防御性守卫"
        );
        assert!(
            snippet.contains("[ -f \"$METERM_CLAUDE_HOOKS\" ]"),
            "须有 hooks 文件是否真实存在的防御性守卫(防 best-effort 写失败时 --settings 指向缺失文件搞挂 claude)"
        );
        assert!(
            snippet.contains("command claude \"$@\""),
            "env 未设或文件不存在时须退化为直接 command claude(不注入 hooks 仍可用,claude 永不因此失败)"
        );
        assert!(snippet.contains("\"$@\""), "须透传用户其余参数");
        // 不得再把绝对路径字面写死进片段(消除 rc 里的路径插值)。
        assert!(
            !snippet.contains("meterm_claude_hooks=\""),
            "不得再有字面路径赋值行"
        );
        assert!(!snippet.contains("/tmp/"), "片段本身不含任何字面临时路径");
    }

    /// 守卫式自动运行片段(M7):含 METERM_AUTO_CLAUDE 判定 + unset 防重触 + 调 claude。
    #[test]
    fn test_auto_run_snippet() {
        let snippet = auto_run_snippet();
        // 守卫:仅当 METERM_AUTO_CLAUDE 置位才运行。
        assert!(
            snippet.contains("[ -n \"$METERM_AUTO_CLAUDE\" ]"),
            "须以 METERM_AUTO_CLAUDE 是否置位作为守卫"
        );
        // unset 先行:防止用户手动 `source ~/.zshrc` 重复触发。
        assert!(
            snippet.contains("unset METERM_AUTO_CLAUDE"),
            "须 unset METERM_AUTO_CLAUDE 防 re-source 重复触发"
        );
        // 调 claude(走上面刚定义的包装函数,带 --settings hooks)。
        assert!(snippet.contains("claude;"), "须在守卫内调用 claude");
        // 单行 if(POSIX,zsh/bash 通用);not 加任何额外文本(零 token)。
        assert!(
            snippet.contains(
                "if [ -n \"$METERM_AUTO_CLAUDE\" ]; then unset METERM_AUTO_CLAUDE; claude; fi"
            ),
            "须为单行 POSIX 守卫,不注入任何额外文本(零 token)"
        );
        // 片段本身不含任何字面临时路径。
        assert!(!snippet.contains("/tmp/"), "片段本身不含任何字面临时路径");
    }

    /// M7 字节序:install_agent_mirror 写出的 rc 里,守卫自动运行行必须在 claude() 定义**之后**
    /// (函数已定义才能调),且 rc 同时含 METERM_AUTO_CLAUDE / unset / claude。
    #[test]
    fn test_install_agent_mirror_auto_run_after_wrapper() {
        let dir = std::env::temp_dir().join(format!("meterm-hf-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let rc = dir.join(".zshrc");
        std::fs::write(&rc, "# existing rc\n").unwrap();

        install_agent_mirror(&dir, &rc);

        let rc_content = std::fs::read_to_string(&rc).unwrap();
        // rc 含守卫自动运行行的三要素。
        assert!(
            rc_content.contains("METERM_AUTO_CLAUDE"),
            "rc 须含 METERM_AUTO_CLAUDE 守卫"
        );
        assert!(
            rc_content.contains("unset METERM_AUTO_CLAUDE"),
            "rc 须含 unset(防 re-source)"
        );
        // 字节序:claude() { 定义在前,守卫自动运行行在后(函数已定义才能调)。
        let def_at = rc_content
            .find("claude() {")
            .expect("rc 须含 claude() 定义");
        let run_at = rc_content
            .find("if [ -n \"$METERM_AUTO_CLAUDE\"")
            .expect("rc 须含守卫自动运行行");
        assert!(
            def_at < run_at,
            "守卫自动运行行必须在 claude() 定义之后(def_at={} run_at={})",
            def_at,
            run_at
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 端到端落地:写文件 + chmod + rc 追加。
    #[test]
    fn test_install_agent_mirror_writes_files_and_appends_wrapper() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("meterm-hf-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let rc = dir.join(".zshrc");
        std::fs::write(&rc, "# existing rc\n").unwrap();

        install_agent_mirror(&dir, &rc);

        // 转发脚本存在且可执行
        let script = dir.join(FORWARD_SCRIPT_NAME);
        assert!(script.exists(), "转发脚本须落地");
        let mode = std::fs::metadata(&script).unwrap().permissions().mode();
        assert!(mode & 0o111 != 0, "转发脚本须可执行");

        // hooks JSON 存在且可解析,command 指向该脚本
        let settings = dir.join(HOOKS_SETTINGS_NAME);
        assert!(settings.exists(), "hooks.json 须落地");
        let json = std::fs::read_to_string(&settings).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            v["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            script.to_string_lossy().as_ref()
        );

        // rc 保留原有内容并在末尾追加 claude 包装函数
        let rc_content = std::fs::read_to_string(&rc).unwrap();
        assert!(rc_content.contains("# existing rc"), "原 rc 内容须保留");
        assert!(
            rc_content.contains("claude() {"),
            "rc 末尾须追加 claude 包装函数"
        );
        assert!(
            rc_content.contains("METERM_CLAUDE_HOOKS"),
            "rc 须引用 METERM_CLAUDE_HOOKS env 而非写死路径"
        );
        assert!(
            !rc_content.contains(settings.to_string_lossy().as_ref()),
            "rc 不得再把 hooks.json 绝对路径字面插进 shell 赋值(消除插值面)"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
