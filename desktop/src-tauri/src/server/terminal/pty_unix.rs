//! Unix PTY terminal — xpty integration + macOS two-stage login shell + shell hook injection.
//!
//! Mirrors Go `terminal/pty_unix.go`.
//!
//! Shell hooks (OSC 7766/7768) are injected transparently via ZDOTDIR (zsh) or
//! --rcfile (bash). The proxy dotfiles source the user's originals, then install
//! the MeTerm precmd hook. This enables AI Agent integration (shell state tracking,
//! command detection, CWD updates).

use std::io::{self, Read};
use std::sync::Mutex;

use tokio_util::sync::CancellationToken;
use xpty::{CommandBuilder, PtySize, PtySystem};

use super::Terminal;

/// Unix PTY terminal backed by xpty.
///
/// Uses a dedicated reader thread that sends output via a channel,
/// making `read()` cancel-safe for use in `tokio::select!`.
pub struct PtyTerminal {
    /// Receiver for PTY output (from the dedicated reader thread).
    output_rx: tokio::sync::Mutex<tokio::sync::mpsc::Receiver<io::Result<Vec<u8>>>>,
    /// Writer taken from the master PTY.
    writer: Mutex<Option<Box<dyn io::Write + Send>>>,
    /// Master PTY handle (for resize). Wrapped in Mutex because MasterPty is !Sync.
    master: Mutex<Box<dyn xpty::MasterPty + Send>>,
    /// Fired when the child exits.
    done_token: CancellationToken,
    /// Temp directory for shell hook files. Cleaned up on close/drop.
    hook_dir: Option<String>,
}

impl PtyTerminal {
    /// Spawn a new PTY with the given shell and working directory.
    ///
    /// On macOS, implements the two-stage login shell:
    /// 1. Stage 1: `TERM=dumb` login shell loads environment (.zprofile, PATH)
    /// 2. Stage 2: `exec` to interactive shell with `TERM=xterm-256color`
    ///
    /// Shell hooks (OSC 7766/7768) are injected via ZDOTDIR (zsh) or --rcfile (bash).
    ///
    /// `envs`:调用方额外注入的环境变量(agent 终端镜像 M1:METERM_SESSION_ID /
    /// METERM_HOOK_PORT / METERM_HOOK_SECRET)。macOS 两段式 `login -p` 保留 env,
    /// 故这些变量能穿透到最终交互 shell 及其后代(claude / hook 子进程按 env 继承拿到)。
    pub fn new(
        shell: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
        envs: &[(String, String)],
    ) -> Result<Self, String> {
        let pty_system = xpty::native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("openpty: {}", e))?;

        // Resolve shell path (matches Go: $SHELL → /bin/sh fallback)
        let shell = if shell.is_empty() {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
        } else {
            shell.to_string()
        };
        let basename = shell.rsplit('/').next().unwrap_or(&shell).to_string();

        let mut cmd = CommandBuilder::new(&shell);

        if !cwd.is_empty() {
            cmd.cwd(cwd);
        }

        // Terminal identification env vars (so CLI tools can detect MeTerm)
        cmd.env("TERM_PROGRAM", "MeTerm");
        cmd.env("COLORTERM", "truecolor");

        // 调用方注入的环境变量(agent 镜像 hook env 等)。放在 TERM_PROGRAM 之后、
        // login 组装之前:macOS 下 login -p 保留 env,能穿透到 Stage 2 交互 shell。
        apply_envs(&mut cmd, envs);

        // Create hook directory for supported shells (OSC 7766/7768 injection)
        let hook_dir = if basename == "zsh" || basename == "bash" {
            create_hook_dir(&basename)
        } else {
            None
        };

        // Agent 镜像 hooks(M2 修复):hooks settings 绝对路径经 env 注入,不再字面写死进 rc。
        // 原实现把路径直接插进 rc 的双引号 shell 赋值 `meterm_claude_hooks="<path>"`,
        // 若路径含 `$`/`` ` ``/`"`/`\`(理论上 TMPDIR 可控)会被 shell 解释(命令替换等)。
        // 改用 env 传递(与 METERM_SESSION_ID 等既有注入同一模式):env 值不经 shell 解析,
        // rc 里的 claude 包装函数只引用 `$METERM_CLAUDE_HOOKS`,不含任何插值路径。
        apply_claude_hooks_env(&mut cmd, &hook_dir);

        // ── macOS: /usr/bin/login + two-stage shell ─────────────────────────
        // Uses `login -fp <user> <shell> -c <inner_cmd>` which:
        //   1. Prints "Last login: <time> on <tty>" (reads/writes utmpx with root via setuid)
        //   2. Execs the specified shell as a login shell (argv[0] = "-zsh"/"-bash")
        //   3. Shell runs inner_cmd which sets TERM and exec's to interactive Stage 2
        #[cfg(target_os = "macos")]
        {
            if !is_csh_family(&shell) {
                cmd.env("TERM", "dumb");

                // Set ZDOTDIR for zsh hook (affects both Stage 1 and Stage 2)
                if basename == "zsh" {
                    if let Some(ref dir) = hook_dir {
                        cmd.env("ZDOTDIR", dir);
                    }
                }

                // Build Stage 2 inner command
                let inner_cmd = if basename == "bash" {
                    if let Some(ref dir) = hook_dir {
                        // GNU long options (--rcfile) must precede short options (-i) for bash 3.2
                        format!(
                            "export TERM=xterm-256color; exec {} --rcfile {}/.bashrc -i",
                            shell, dir
                        )
                    } else {
                        format!("export TERM=xterm-256color; exec {} -i", shell)
                    }
                } else {
                    format!("export TERM=xterm-256color; exec {} -i", shell)
                };

                let argv = cmd.get_argv_mut();
                argv.clear();

                // Use /usr/bin/login for "Last login" message + utmpx tracking.
                // login is setuid root so it can read/write utmpx.
                // Format: login -fp <user> <shell> <shell_args...>
                // login execs <shell> with argv[0]="-<basename>" (login shell convention),
                // passing <shell_args> as additional arguments.
                let username = std::env::var("USER").unwrap_or_default();
                if !username.is_empty() {
                    argv.push("/usr/bin/login".into());
                    argv.push("-fp".into());
                    argv.push(username.into());
                    argv.push(shell.clone().into());
                    argv.push("-c".into());
                    argv.push(inner_cmd.into());
                } else {
                    // Fallback: direct spawn without login
                    argv.push(shell.clone().into());
                    argv.push("-l".into());
                    argv.push("-c".into());
                    argv.push(inner_cmd.into());
                }
            } else {
                cmd.env("TERM", "xterm-256color");
            }
        }

        // ── Linux: direct shell + hook injection ────────────────────────────
        #[cfg(not(target_os = "macos"))]
        {
            cmd.env("TERM", "xterm-256color");
            if basename == "zsh" {
                if let Some(ref dir) = hook_dir {
                    cmd.env("ZDOTDIR", dir);
                }
            } else if basename == "bash" {
                if let Some(ref dir) = hook_dir {
                    let argv = cmd.get_argv_mut();
                    argv.push("--rcfile".into());
                    argv.push(format!("{}/.bashrc", dir).into());
                }
            }
        }

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("clone reader: {}", e))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("take writer: {}", e))?;

        eprintln!(
            "[pty] spawning: argv={:?} cwd={:?} hook_dir={:?}",
            cmd.get_argv(),
            cmd.get_cwd(),
            hook_dir
        );
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("spawn: {}", e))?;
        eprintln!("[pty] spawned PID={:?}", child.process_id());

        let done_token = CancellationToken::new();

        // Spawn dedicated reader thread that sends output via channel.
        // This makes read() cancel-safe for tokio::select!.
        let (output_tx, output_rx) = tokio::sync::mpsc::channel::<io::Result<Vec<u8>>>(64);
        let done_clone = done_token.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 32768];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        let _ = output_tx.blocking_send(Ok(Vec::new()));
                        break;
                    }
                    Ok(n) => {
                        if output_tx.blocking_send(Ok(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = output_tx.blocking_send(Err(e));
                        break;
                    }
                }
            }
            let _ = child.wait();
            done_clone.cancel();
        });

        Ok(Self {
            output_rx: tokio::sync::Mutex::new(output_rx),
            writer: Mutex::new(Some(writer)),
            master: Mutex::new(pair.master),
            done_token,
            hook_dir,
        })
    }
}

#[async_trait::async_trait]
impl Terminal for PtyTerminal {
    async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
        let mut rx = self.output_rx.lock().await;
        match rx.recv().await {
            Some(Ok(data)) => {
                if data.is_empty() {
                    return Ok(0);
                }
                let n = data.len().min(buf.len());
                buf[..n].copy_from_slice(&data[..n]);
                Ok(n)
            }
            Some(Err(e)) => Err(e),
            None => Ok(0),
        }
    }

    async fn write(&self, data: &[u8]) -> io::Result<usize> {
        let mut writer_guard = self.writer.lock().unwrap();
        if let Some(ref mut writer) = *writer_guard {
            use io::Write;
            writer.write(data)
        } else {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "writer closed"))
        }
    }

    fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        self.master
            .lock()
            .unwrap()
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))
    }

    /// 向 PTY 前台进程组补发 SIGWINCH,强制 TUI 按当前尺寸全量重绘。
    /// 用于接管/attach 后"尺寸未变、内核不发信号"的盲区(内核 tty_do_resize
    /// 对相同 winsize 直接短路)。SIGWINCH 无害:无 handler 的进程默认忽略。
    fn nudge(&self) {
        let pgid = self.master.lock().unwrap().process_group_leader();
        match pgid {
            // 必须严格校验 pgid > 0:kill(0, ...) 会波及 meterm 自身进程组,
            // kill(负全组) 语义由取负实现,pgid 非法时绝不能发。
            Some(pgid) if pgid > 0 => {
                let ret = unsafe { libc::kill(-pgid, libc::SIGWINCH) };
                if ret != 0 {
                    eprintln!(
                        "[pty] nudge SIGWINCH to -{} failed: {}",
                        pgid,
                        std::io::Error::last_os_error()
                    );
                }
            }
            other => eprintln!("[pty] nudge skipped, invalid foreground pgid: {:?}", other),
        }
    }

    fn done(&self) -> CancellationToken {
        self.done_token.clone()
    }

    async fn close(&self) -> io::Result<()> {
        *self.writer.lock().unwrap() = None;
        self.done_token.cancel();
        if let Some(ref dir) = self.hook_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
        Ok(())
    }
}

impl Drop for PtyTerminal {
    fn drop(&mut self) {
        if let Some(ref dir) = self.hook_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// 把调用方指定的环境变量逐条应用到 `CommandBuilder`。
/// 抽成独立函数,便于单测断言透传(不必 spawn 真实 shell)。
fn apply_envs(cmd: &mut CommandBuilder, envs: &[(String, String)]) {
    for (k, v) in envs {
        cmd.env(k, v);
    }
}

/// 若 `hook_dir` 存在(zsh/bash 会话已建 hook 目录),把 agent 镜像 hooks settings 的
/// 绝对路径写入 `METERM_CLAUDE_HOOKS` env,供 rc 里的 `claude` 包装函数引用
/// (`--settings "$METERM_CLAUDE_HOOKS"`),不再把路径字面插进 rc 的 shell 字符串。
/// 抽成独立函数,便于单测断言(不必 spawn 真实 shell)。
fn apply_claude_hooks_env(cmd: &mut CommandBuilder, hook_dir: &Option<String>) {
    if let Some(dir) = hook_dir {
        let settings_path = std::path::Path::new(dir).join(super::hook_files::HOOKS_SETTINGS_NAME);
        cmd.env("METERM_CLAUDE_HOOKS", &settings_path);
    }
}

// ── Shell hook injection ────────────────────────────────────────────────────

/// Create a temporary directory with shell hook files (precmd / PROMPT_COMMAND).
/// Returns the directory path, or None if creation failed.
fn create_hook_dir(shell_basename: &str) -> Option<String> {
    let dir = std::env::temp_dir().join(format!("meterm-hook-{}", uuid::Uuid::new_v4()));
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    match shell_basename {
        "zsh" => create_zsh_hooks(&dir),
        "bash" => create_bash_hooks(&dir),
        _ => return None,
    }
    Some(dir.to_string_lossy().to_string())
}

/// Create proxy zsh dotfiles that source user's originals then install MeTerm hook.
fn create_zsh_hooks(dir: &std::path::Path) {
    // .zshenv: proxy user's .zshenv, preserve our ZDOTDIR for .zshrc loading
    let _ = std::fs::write(
        dir.join(".zshenv"),
        "# MeTerm: proxy user zshenv, keep ZDOTDIR for hook injection\n\
         __mt_zd=\"$ZDOTDIR\"\n\
         ZDOTDIR=\"$HOME\"\n\
         [[ -f \"$HOME/.zshenv\" ]] && source \"$HOME/.zshenv\"\n\
         ZDOTDIR=\"$__mt_zd\"\n\
         unset __mt_zd\n",
    );

    // .zprofile: proxy user's .zprofile (login shell only)
    let _ = std::fs::write(
        dir.join(".zprofile"),
        "[[ -f \"$HOME/.zprofile\" ]] && source \"$HOME/.zprofile\"\n",
    );

    // .zshrc: proxy user's .zshrc, then install precmd hook
    let _ = std::fs::write(
        dir.join(".zshrc"),
        "# MeTerm: proxy user zshrc + install precmd hook\n\
         ZDOTDIR=\"$HOME\"\n\
         # Fix HISTFILE: ZDOTDIR override causes zsh default HISTFILE to point at temp hook dir.\n\
         # Reset to standard default; user .zshrc can still override.\n\
         HISTFILE=\"$HOME/.zsh_history\"\n\
         [[ -f \"$HOME/.zshrc\" ]] && source \"$HOME/.zshrc\"\n\
         \n\
         # ── MeTerm shell hook (preexec/precmd, 记录命令耗时) ──\n\
         zmodload zsh/datetime 2>/dev/null\n\
         __meterm_cmd_start=''\n\
         __meterm_cmd_running=0\n\
         __meterm_preexec(){\n\
           # 标记本轮提示周期确实执行过命令,避免空回车误报上一条命令耗时\n\
           __meterm_cmd_running=1\n\
           if [ -n \"$EPOCHREALTIME\" ]; then\n\
             __meterm_cmd_start=\"$EPOCHREALTIME\"\n\
           else\n\
             __meterm_cmd_start=\"$SECONDS\"\n\
           fi\n\
         }\n\
         __meterm_precmd(){\n\
           local e=$?\n\
           local c\n\
           local dur=0\n\
           if [ -z \"$__meterm_hook_ready\" ]; then\n\
             export __meterm_hook_ready=1\n\
             printf '\\033]7766;meterm_init;1\\007'\n\
             c=''\n\
           else\n\
             c=$(fc -ln -1 2>/dev/null)\n\
             if [ \"$__meterm_cmd_running\" = \"1\" ] && [ -n \"$__meterm_cmd_start\" ]; then\n\
               if [ -n \"$EPOCHREALTIME\" ]; then\n\
                 dur=$(( (EPOCHREALTIME - __meterm_cmd_start) * 1000 ))\n\
                 dur=${dur%%.*}\n\
               else\n\
                 dur=$(( (SECONDS - __meterm_cmd_start) * 1000 ))\n\
               fi\n\
               [ -z \"$dur\" ] && dur=0\n\
               [ \"$dur\" -lt 0 ] 2>/dev/null && dur=0\n\
             fi\n\
           fi\n\
           __meterm_cmd_running=0\n\
           printf '\\033]7768;%d;%s;%s;%d\\007' \"$e\" \"$PWD\" \"$c\" \"$dur\"\n\
         }\n\
         autoload -Uz add-zsh-hook 2>/dev/null && { add-zsh-hook preexec __meterm_preexec; add-zsh-hook precmd __meterm_precmd; }\n\
         setopt HIST_IGNORE_SPACE 2>/dev/null\n",
    );

    // .zlogin: proxy user's .zlogin (login shell only)
    let _ = std::fs::write(
        dir.join(".zlogin"),
        "[[ -f \"$HOME/.zlogin\" ]] && source \"$HOME/.zlogin\"\n",
    );

    // ── Agent 镜像 hook 产物(M2)──
    // 写会话级 hooks settings JSON + 转发脚本,并在 .zshrc 末尾(用户 rc + OSC hook 之后)
    // 追加 claude 包装函数。claude 一跑就被注入观察者 hooks(端到端等 M3 的端点)。
    super::hook_files::install_agent_mirror(dir, &dir.join(".zshrc"));
}

/// Create proxy bash .bashrc that sources user's original then installs MeTerm hook.
fn create_bash_hooks(dir: &std::path::Path) {
    let _ = std::fs::write(
        dir.join(".bashrc"),
        "# MeTerm: proxy user bashrc + install PROMPT_COMMAND hook\n\
         [[ -f \"$HOME/.bashrc\" ]] && source \"$HOME/.bashrc\"\n\
         \n\
         # ── MeTerm shell hook (DEBUG trap 近似 preexec + PROMPT_COMMAND 近似 precmd,记录命令耗时) ──\n\
         __meterm_cmd_start=''\n\
         __meterm_cmd_running=0\n\
         __meterm_in_prompt=0\n\
         __meterm_preexec(){\n\
           # DEBUG trap 每条简单命令都触发,包括 PROMPT_COMMAND 自身(尤其是空提示符回车时,\n\
           # 没有用户命令可执行,DEBUG 仍会在调用 __meterm_precmd 前触发一次)。\n\
           # 用 $BASH_COMMAND 精确识别并排除\"即将执行的是我们自己的 precmd\"这种情况,\n\
           # 而不是依赖时间重合——否则空回车会被误记为一次耗时几乎为 0 的伪命令。\n\
           [ -n \"$COMP_LINE\" ] && return\n\
           case \"$BASH_COMMAND\" in __meterm_precmd*) return ;; esac\n\
           [ \"$__meterm_in_prompt\" = \"1\" ] && return\n\
           [ \"$__meterm_cmd_running\" = \"1\" ] && return\n\
           __meterm_cmd_running=1\n\
           if [ -n \"$EPOCHREALTIME\" ]; then\n\
             __meterm_cmd_start=\"$EPOCHREALTIME\"\n\
           else\n\
             __meterm_cmd_start=\"$EPOCHSECONDS\"\n\
           fi\n\
         }\n\
         trap '__meterm_preexec' DEBUG\n\
         __meterm_precmd(){\n\
           local e=$?\n\
           local c\n\
           local dur=0\n\
           __meterm_in_prompt=1\n\
           if [ -z \"$__meterm_hook_ready\" ]; then\n\
             export __meterm_hook_ready=1\n\
             printf '\\033]7766;meterm_init;0\\007'\n\
             c=''\n\
           else\n\
             c=$(fc -ln -1 2>/dev/null)\n\
             if [ \"$__meterm_cmd_running\" = \"1\" ] && [ -n \"$__meterm_cmd_start\" ]; then\n\
               if [ -n \"$EPOCHREALTIME\" ]; then\n\
                 # bash 的 $(( )) 只支持整数运算,EPOCHREALTIME 形如 秒.微秒(固定6位小数)\n\
                 # 拆成 秒/微秒两段分别做整数运算,避免依赖 awk/bc 等外部工具\n\
                 local __s_sec=${__meterm_cmd_start%.*}\n\
                 local __s_usec=${__meterm_cmd_start#*.}\n\
                 local __e_sec=${EPOCHREALTIME%.*}\n\
                 local __e_usec=${EPOCHREALTIME#*.}\n\
                 dur=$(( (10#$__e_sec - 10#$__s_sec) * 1000 + (10#$__e_usec - 10#$__s_usec) / 1000 ))\n\
               else\n\
                 dur=$(( (EPOCHSECONDS - __meterm_cmd_start) * 1000 ))\n\
               fi\n\
               [ -z \"$dur\" ] && dur=0\n\
               [ \"$dur\" -lt 0 ] 2>/dev/null && dur=0\n\
             fi\n\
           fi\n\
           __meterm_cmd_running=0\n\
           printf '\\033]7768;%d;%s;%s;%d\\007' \"$e\" \"$PWD\" \"$c\" \"$dur\"\n\
           __meterm_in_prompt=0\n\
         }\n\
         PROMPT_COMMAND=\"__meterm_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"\n\
         export HISTCONTROL=\"${HISTCONTROL:+$HISTCONTROL:}ignorespace\"\n",
    );

    // ── Agent 镜像 hook 产物(M2)──
    // 写会话级 hooks settings JSON + 转发脚本,并在 .bashrc 末尾(用户 rc + OSC hook 之后)
    // 追加 claude 包装函数。claude 一跑就被注入观察者 hooks(端到端等 M3 的端点)。
    super::hook_files::install_agent_mirror(dir, &dir.join(".bashrc"));
}

/// Check if the shell is csh or tcsh (which don't support -l properly).
#[cfg(target_os = "macos")]
fn is_csh_family(shell: &str) -> bool {
    let basename = shell.rsplit('/').next().unwrap_or(shell);
    basename == "csh" || basename == "tcsh"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_hook_dir_zsh() {
        let dir = create_hook_dir("zsh");
        assert!(dir.is_some());
        let dir = dir.unwrap();
        assert!(std::path::Path::new(&dir).join(".zshrc").exists());
        assert!(std::path::Path::new(&dir).join(".zshenv").exists());
        assert!(std::path::Path::new(&dir).join(".zprofile").exists());
        assert!(std::path::Path::new(&dir).join(".zlogin").exists());
        // Check hook content
        let zshrc = std::fs::read_to_string(std::path::Path::new(&dir).join(".zshrc")).unwrap();
        assert!(zshrc.contains("__meterm_precmd"));
        assert!(zshrc.contains("7766;meterm_init;1"));
        assert!(zshrc.contains("7768"));
        assert!(
            zshrc.contains("HISTFILE=\"$HOME/.zsh_history\""),
            "HISTFILE fix must be present"
        );
        // Agent 镜像产物(M2):hooks JSON + 转发脚本落地,.zshrc 末尾追加 claude 包装函数。
        assert!(std::path::Path::new(&dir)
            .join("meterm-claude-hooks.json")
            .exists());
        assert!(std::path::Path::new(&dir)
            .join("meterm-hook-forward.sh")
            .exists());
        assert!(zshrc.contains("claude() {"), "zsh rc 须含 claude 包装函数");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_create_hook_dir_bash() {
        let dir = create_hook_dir("bash");
        assert!(dir.is_some());
        let dir = dir.unwrap();
        assert!(std::path::Path::new(&dir).join(".bashrc").exists());
        let bashrc = std::fs::read_to_string(std::path::Path::new(&dir).join(".bashrc")).unwrap();
        assert!(bashrc.contains("__meterm_precmd"));
        assert!(bashrc.contains("7766;meterm_init;0"));
        assert!(bashrc.contains("PROMPT_COMMAND"));
        // Agent 镜像产物(M2):hooks JSON + 转发脚本落地,.bashrc 末尾追加 claude 包装函数。
        assert!(std::path::Path::new(&dir)
            .join("meterm-claude-hooks.json")
            .exists());
        assert!(std::path::Path::new(&dir)
            .join("meterm-hook-forward.sh")
            .exists());
        assert!(
            bashrc.contains("claude() {"),
            "bash rc 须含 claude 包装函数"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_apply_envs_passthrough() {
        // 断言 apply_envs 把每一对 env 都写进 CommandBuilder(agent hook env 透传的核心一步)。
        let mut cmd = CommandBuilder::new("/bin/sh");
        let envs = vec![
            ("METERM_SESSION_ID".to_string(), "sess-xyz".to_string()),
            ("METERM_HOOK_PORT".to_string(), "51234".to_string()),
            ("METERM_HOOK_SECRET".to_string(), "top-secret".to_string()),
        ];
        apply_envs(&mut cmd, &envs);
        assert_eq!(
            cmd.get_env("METERM_SESSION_ID"),
            Some(std::ffi::OsStr::new("sess-xyz"))
        );
        assert_eq!(
            cmd.get_env("METERM_HOOK_PORT"),
            Some(std::ffi::OsStr::new("51234"))
        );
        assert_eq!(
            cmd.get_env("METERM_HOOK_SECRET"),
            Some(std::ffi::OsStr::new("top-secret"))
        );
    }

    #[test]
    fn test_apply_envs_empty_is_noop() {
        // 空 envs(SSH/agent 会话不注入的场景)不应改动已有 env。
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.env("TERM_PROGRAM", "MeTerm");
        apply_envs(&mut cmd, &[]);
        assert_eq!(
            cmd.get_env("TERM_PROGRAM"),
            Some(std::ffi::OsStr::new("MeTerm"))
        );
        assert_eq!(cmd.get_env("METERM_HOOK_SECRET"), None);
    }

    #[test]
    fn test_apply_claude_hooks_env_sets_when_hook_dir_present() {
        // hook_dir 存在时,METERM_CLAUDE_HOOKS 须指向 <hook_dir>/meterm-claude-hooks.json,
        // 且不经字面路径插值(这是 PtyTerminal 侧对 M2 rc 插值缺陷的修复入口)。
        let mut cmd = CommandBuilder::new("/bin/sh");
        let hook_dir = Some("/tmp/meterm-hook-abc".to_string());
        apply_claude_hooks_env(&mut cmd, &hook_dir);
        let expected =
            std::path::Path::new("/tmp/meterm-hook-abc").join("meterm-claude-hooks.json");
        assert_eq!(
            cmd.get_env("METERM_CLAUDE_HOOKS"),
            Some(expected.as_os_str())
        );
    }

    #[test]
    fn test_apply_claude_hooks_env_noop_when_no_hook_dir() {
        // 非 zsh/bash(无 hook_dir)时不应设置该 env。
        let mut cmd = CommandBuilder::new("/bin/sh");
        apply_claude_hooks_env(&mut cmd, &None);
        assert_eq!(cmd.get_env("METERM_CLAUDE_HOOKS"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_is_csh_family() {
        assert!(is_csh_family("/bin/csh"));
        assert!(is_csh_family("/bin/tcsh"));
        assert!(!is_csh_family("/bin/zsh"));
        assert!(!is_csh_family("/bin/bash"));
    }
}
