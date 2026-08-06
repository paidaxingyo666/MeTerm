//! fix13:会话级 Git REST(手机 Git tab 数据源)。
//!
//! 在**本机会话**的当前工作目录(`Session.current_cwd`,OSC 7/7768 旁路记录)执行 git,
//! 提供状态 / 单文件 diff / 提交历史 / commit / pull / push。端点(Bearer 鉴权组):
//! - `GET  /api/sessions/{id}/git/status`
//! - `GET  /api/sessions/{id}/git/diff?path=<rel>&staged=0|1`
//! - `GET  /api/sessions/{id}/git/log?limit=N`
//! - `POST /api/sessions/{id}/git/commit`  `{message, stageAll}`
//! - `POST /api/sessions/{id}/git/sync`    `{op: "pull"|"push"|"fetch"}`
//! - `GET  /api/sessions/{id}/git/branches`(fix14:本地分支列表)
//! - `GET  /api/sessions/{id}/git/show?hash=`(fix14:单提交详情 diff)
//! - `POST /api/sessions/{id}/git/checkout` `{branch, create}`(fix14)
//! - `POST /api/sessions/{id}/git/stage`    `{path, stage}`(fix14:单文件 stage/unstage)
//! - `POST /api/sessions/{id}/git/discard`  `{path?, untracked}`(fix14:丢弃改动)
//! - `POST /api/sessions/{id}/git/stash`    `{op: "push"|"pop"}`(fix14)
//!
//! 纪律:
//! - **不经 shell**:`Command("git").args(...)`,参数向量传递,无注入面;
//! - `path` 参数必须是仓库内相对路径(拒绝绝对路径与 `..` 组件,防目录穿越);
//! - 仅 `executor_type == "local-shell"` 会话可用(SSH/JumpServer 的 cwd 是远端路径,
//!   git 在桌面跑语义错误)→ 409;无 cwd(shell integration 未上报)→ 409;
//! - git 子进程继承桌面环境(用户自己的 git 配置/凭证);pull/push 失败把 stderr
//!   透传给手机展示,不在桌面弹任何交互。

use std::path::{Component, Path};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

#[cfg(test)]
use std::process::Command;

use axum::extract::{Extension, Path as AxPath, Query};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command as TokioCommand;

use crate::server::ServerState;

/// 取会话的 git 工作目录:本机会话 + 已上报 cwd,否则带业务码报 409。
fn session_git_cwd(state: &ServerState, id: &str) -> Result<String, (StatusCode, Json<Value>)> {
    let Some(session) = state.session_manager.get(id) else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({"error": "session not found"})),
        ));
    };
    let executor = session.executor_type.lock().unwrap().clone();
    if executor != "local-shell" {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({"error": "git is only available for local sessions", "code": "not_local"})),
        ));
    }
    let cwd = session.current_cwd.lock().unwrap().clone();
    match cwd {
        Some(cwd) if !cwd.is_empty() => Ok(cwd),
        _ => Err((
            StatusCode::CONFLICT,
            Json(
                json!({"error": "session cwd unknown (shell integration not reporting)", "code": "no_cwd"}),
            ),
        )),
    }
}

const GIT_STDOUT_LIMIT: usize = 4 * 1024 * 1024;
const GIT_STDERR_LIMIT: usize = 256 * 1024;
const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

async fn read_git_pipe_bounded<R: AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
    stream_name: &str,
) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity(limit.min(8192));
    let mut buffer = [0u8; 8192];
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|error| format!("read git {stream_name}: {error}"))?;
        if count == 0 {
            return Ok(output);
        }
        if count > limit.saturating_sub(output.len()) {
            return Err(format!("git {stream_name} exceeded {limit} byte limit"));
        }
        output.extend_from_slice(&buffer[..count]);
    }
}

async fn run_git_with_limits(
    cwd: String,
    args: Vec<String>,
    stdout_limit: usize,
    stderr_limit: usize,
    deadline: Duration,
) -> Result<(bool, String, String), String> {
    let mut child = TokioCommand::new("git")
        .args(&args)
        .current_dir(&cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("spawn git: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "git stdout pipe unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "git stderr pipe unavailable".to_string())?;

    let collected = tokio::time::timeout(deadline, async {
        tokio::try_join!(
            read_git_pipe_bounded(stdout, stdout_limit, "stdout"),
            read_git_pipe_bounded(stderr, stderr_limit, "stderr"),
            async {
                child
                    .wait()
                    .await
                    .map_err(|error| format!("wait for git: {error}"))
            },
        )
    })
    .await;

    match collected {
        Ok(Ok((stdout, stderr, status))) => Ok((
            status.success(),
            String::from_utf8_lossy(&stdout).into_owned(),
            String::from_utf8_lossy(&stderr).into_owned(),
        )),
        Ok(Err(error)) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            Err(error)
        }
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            Err(format!(
                "git command timed out after {}s",
                deadline.as_secs()
            ))
        }
    }
}

/// 跑一条 git 命令，限制运行时间及 stdout/stderr，返回 (exit_ok, stdout, stderr)。
async fn run_git(cwd: String, args: Vec<String>) -> Result<(bool, String, String), String> {
    run_git_with_limits(
        cwd,
        args,
        GIT_STDOUT_LIMIT,
        GIT_STDERR_LIMIT,
        GIT_COMMAND_TIMEOUT,
    )
    .await
}

/// 仓库内相对路径校验(防穿越):非空、非绝对、组件级无 `..`。
fn rel_path_ok(p: &str) -> bool {
    !p.is_empty()
        && !Path::new(p).is_absolute()
        && !Path::new(p)
            .components()
            .any(|c| matches!(c, Component::ParentDir))
}

/// 解析 `git status --porcelain=v1 -b` 输出(纯函数,单测):
/// 首行 `## branch...upstream [ahead N, behind M]`;文件行 `XY path`(X=staged 态,
/// Y=worktree 态,`??`=untracked,`R`/`C` 行带 ` -> ` 取新路径)。
pub(crate) fn parse_git_status(porcelain: &str) -> Value {
    let mut branch = String::new();
    let mut ahead = 0i64;
    let mut behind = 0i64;
    let mut files: Vec<Value> = Vec::new();
    for line in porcelain.lines() {
        if let Some(head) = line.strip_prefix("## ") {
            // "main...origin/main [ahead 1, behind 2]" / "main" / "No commits yet on main"
            let name_part = head.split("...").next().unwrap_or(head);
            branch = name_part
                .strip_prefix("No commits yet on ")
                .unwrap_or(name_part)
                .trim()
                .to_string();
            if let Some(brackets) = head.split('[').nth(1) {
                for seg in brackets.trim_end_matches(']').split(',') {
                    let seg = seg.trim();
                    if let Some(n) = seg.strip_prefix("ahead ") {
                        ahead = n.trim().parse().unwrap_or(0);
                    } else if let Some(n) = seg.strip_prefix("behind ") {
                        behind = n.trim().parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let (xy, rest) = line.split_at(2);
        let path_part = rest.trim_start();
        // 重命名/复制行 "R  old -> new":列表与 diff 都取新路径。
        let path = path_part.rsplit(" -> ").next().unwrap_or(path_part);
        let staged_flag = xy.chars().next().unwrap_or(' ');
        let worktree_flag = xy.chars().nth(1).unwrap_or(' ');
        files.push(json!({
            "path": path,
            "status": xy.trim(),
            // staged = X 列非空格非 ?(?? 是 untracked);同一文件可能两列都有。
            "staged": staged_flag != ' ' && staged_flag != '?',
            "unstaged": worktree_flag != ' ' || xy == "??",
        }));
    }
    json!({ "branch": branch, "ahead": ahead, "behind": behind, "files": files })
}

/// `GET /api/sessions/{id}/git/status`。非 git 仓库 → `{isRepo:false}`(200,前端显示空态)。
pub async fn git_status(
    Extension(state): Extension<Arc<ServerState>>,
    AxPath(id): AxPath<String>,
) -> impl IntoResponse {
    let cwd = match session_git_cwd(&state, &id) {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };
    match run_git(
        cwd,
        vec!["status".into(), "--porcelain=v1".into(), "-b".into()],
    )
    .await
    {
        Ok((true, stdout, _)) => {
            let mut v = parse_git_status(&stdout);
            v["isRepo"] = json!(true);
            Json(v).into_response()
        }
        // git 非 0:最常见 = 不在仓库内(fatal: not a git repository)。
        Ok((false, _, _)) => Json(json!({"isRepo": false})).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct DiffQuery {
    path: String,
    #[serde(default)]
    staged: bool,
}

/// `GET /api/sessions/{id}/git/diff?path=&staged=`。untracked 文件用
/// `git diff --no-index /dev/null <path>`(退出码 1 = 有差异,正常)。
pub async fn git_diff(
    Extension(state): Extension<Arc<ServerState>>,
    AxPath(id): AxPath<String>,
    Query(q): Query<DiffQuery>,
) -> impl IntoResponse {
    let cwd = match session_git_cwd(&state, &id) {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };
    if !rel_path_ok(&q.path) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "path must be a repo-relative path"})),
        )
            .into_response();
    }
    let args: Vec<String> = if q.staged {
        vec![
            "diff".into(),
            "--cached".into(),
            "--".into(),
            q.path.clone(),
        ]
    } else {
        vec!["diff".into(), "--".into(), q.path.clone()]
    };
    match run_git(cwd.clone(), args).await {
        Ok((_, stdout, _)) if !stdout.is_empty() => Json(json!({"diff": stdout})).into_response(),
        Ok(_) => {
            // 空 diff:可能是 untracked 新文件 → no-index 对比(退出码 1 属正常差异)。
            match run_git(
                cwd,
                vec![
                    "diff".into(),
                    "--no-index".into(),
                    "--".into(),
                    "/dev/null".into(),
                    q.path.clone(),
                ],
            )
            .await
            {
                Ok((_, stdout, _)) => Json(json!({"diff": stdout})).into_response(),
                Err(e) => {
                    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))).into_response()
                }
            }
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct LogQuery {
    #[serde(default = "default_log_limit")]
    limit: u32,
}
fn default_log_limit() -> u32 {
    30
}

/// `GET /api/sessions/{id}/git/log?limit=`。`%x1f`(unit separator)分隔字段,
/// 免转义歧义:hash / subject / author / 相对时间。
pub async fn git_log(
    Extension(state): Extension<Arc<ServerState>>,
    AxPath(id): AxPath<String>,
    Query(q): Query<LogQuery>,
) -> impl IntoResponse {
    let cwd = match session_git_cwd(&state, &id) {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };
    let limit = q.limit.clamp(1, 200);
    match run_git(
        cwd,
        vec![
            "log".into(),
            "--pretty=format:%h%x1f%s%x1f%an%x1f%cr".into(),
            format!("-n{}", limit),
        ],
    )
    .await
    {
        Ok((true, stdout, _)) => {
            let commits: Vec<Value> = stdout
                .lines()
                .filter_map(|l| {
                    let mut it = l.split('\u{1f}');
                    Some(json!({
                        "hash": it.next()?,
                        "subject": it.next().unwrap_or(""),
                        "author": it.next().unwrap_or(""),
                        "date": it.next().unwrap_or(""),
                    }))
                })
                .collect();
            Json(json!({ "commits": commits })).into_response()
        }
        // 空仓库(无提交)git log 非 0:回空列表而非错误。
        Ok((false, _, _)) => Json(json!({ "commits": [] })).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct CommitReq {
    message: String,
    #[serde(default)]
    stage_all: bool,
}

/// `POST /api/sessions/{id}/git/commit`:可选 `git add -A` 后 `git commit -m <msg>`。
/// message 经参数向量传递(无 shell 注入面);失败把 git stderr 透传给手机。
pub async fn git_commit(
    Extension(state): Extension<Arc<ServerState>>,
    AxPath(id): AxPath<String>,
    Json(req): Json<CommitReq>,
) -> impl IntoResponse {
    let cwd = match session_git_cwd(&state, &id) {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };
    let msg = req.message.trim();
    if msg.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "commit message must not be empty"})),
        )
            .into_response();
    }
    if req.stage_all {
        match run_git(cwd.clone(), vec!["add".into(), "-A".into()]).await {
            Ok((true, _, _)) => {}
            Ok((false, _, stderr)) => {
                return (StatusCode::CONFLICT, Json(json!({"error": stderr}))).into_response()
            }
            Err(e) => {
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e})))
                    .into_response()
            }
        }
    }
    match run_git(cwd, vec!["commit".into(), "-m".into(), msg.to_string()]).await {
        Ok((true, stdout, _)) => Json(json!({"ok": true, "output": stdout})).into_response(),
        Ok((false, stdout, stderr)) => (
            StatusCode::CONFLICT,
            Json(json!({"error": if stderr.is_empty() { stdout } else { stderr }})),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct SyncReq {
    op: String,
}

/// `POST /api/sessions/{id}/git/sync`:pull(--ff-only,拒绝隐式 merge)/ push。
/// 凭证走桌面用户自己的 git 配置;需要交互(askpass)时会失败,stderr 透传。
pub async fn git_sync(
    Extension(state): Extension<Arc<ServerState>>,
    AxPath(id): AxPath<String>,
    Json(req): Json<SyncReq>,
) -> impl IntoResponse {
    let cwd = match session_git_cwd(&state, &id) {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };
    let args: Vec<String> = match req.op.as_str() {
        "pull" => vec!["pull".into(), "--ff-only".into()],
        "push" => vec!["push".into()],
        // fetch:只更新远端引用(刷新 ahead/behind),不动工作区。
        "fetch" => vec!["fetch".into(), "--all".into(), "--prune".into()],
        other => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": format!("unknown op: {}", other)})),
            )
                .into_response()
        }
    };
    match run_git(cwd, args).await {
        Ok((true, stdout, stderr)) => {
            // git 常把进度写 stderr(push 成功也有),成功时合并展示。
            Json(json!({"ok": true, "output": format!("{}{}", stdout, stderr)})).into_response()
        }
        Ok((false, stdout, stderr)) => (
            StatusCode::CONFLICT,
            Json(json!({"error": if stderr.is_empty() { stdout } else { stderr }})),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))).into_response(),
    }
}

#[cfg(test)]
#[path = "git_handlers/tests.rs"]
mod tests;

// ---------------------------------------------------------------------------
// fix14:分支 / 提交详情 / stage / 丢弃 / stash
// ---------------------------------------------------------------------------

/// 分支名安全校验:非空、不以 `-` 开头(防被 git 当 flag)、无空白/控制字符。
/// 具体合法性交给 git 自己(check-ref-format 语义),这里只挡注入面。
fn branch_name_ok(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && !name.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// commit hash 校验:4-40 位十六进制。
fn hash_ok(h: &str) -> bool {
    (4..=40).contains(&h.len()) && h.chars().all(|c| c.is_ascii_hexdigit())
}

/// `GET /api/sessions/{id}/git/branches`:本地分支列表(名字 + 是否当前 + 上游)。
pub async fn git_branches(
    Extension(state): Extension<Arc<ServerState>>,
    AxPath(id): AxPath<String>,
) -> impl IntoResponse {
    let cwd = match session_git_cwd(&state, &id) {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };
    // unit separator 分隔字段,免转义歧义;%(HEAD) 当前分支为 "*"。
    match run_git(
        cwd,
        vec![
            "branch".into(),
            "--format=%(refname:short)\u{1f}%(HEAD)\u{1f}%(upstream:short)".into(),
        ],
    )
    .await
    {
        Ok((true, stdout, _)) => {
            let branches: Vec<Value> = stdout
                .lines()
                .filter_map(|l| {
                    let mut it = l.split('\u{1f}');
                    let name = it.next()?.trim();
                    if name.is_empty() {
                        return None;
                    }
                    Some(json!({
                        "name": name,
                        "current": it.next().unwrap_or("").trim() == "*",
                        "upstream": it.next().unwrap_or("").trim(),
                    }))
                })
                .collect();
            Json(json!({ "branches": branches })).into_response()
        }
        Ok((false, _, stderr)) => {
            (StatusCode::CONFLICT, Json(json!({"error": stderr}))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct ShowQuery {
    hash: String,
}

/// 提交详情 diff 的展示上限(200 KiB,超出截断——手机滚动视图撑不住整包大提交)。
const SHOW_LIMIT: usize = 200 * 1024;

/// `GET /api/sessions/{id}/git/show?hash=`:单提交详情(commit 信息 + 全量 patch)。
pub async fn git_show(
    Extension(state): Extension<Arc<ServerState>>,
    AxPath(id): AxPath<String>,
    Query(q): Query<ShowQuery>,
) -> impl IntoResponse {
    let cwd = match session_git_cwd(&state, &id) {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };
    if !hash_ok(&q.hash) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "hash must be 4-40 hex chars"})),
        )
            .into_response();
    }
    match run_git(
        cwd,
        vec![
            "show".into(),
            q.hash.clone(),
            "--stat".into(),
            "--patch".into(),
        ],
    )
    .await
    {
        Ok((true, stdout, _)) => {
            let mut text = stdout;
            if text.len() > SHOW_LIMIT {
                // char 边界截断(与 mirror 的展示截断同法)。
                let mut end = SHOW_LIMIT;
                while end > 0 && !text.is_char_boundary(end) {
                    end -= 1;
                }
                text.truncate(end);
                text.push_str("\n…(内容过长已截断)");
            }
            Json(json!({ "diff": text })).into_response()
        }
        Ok((false, _, stderr)) => {
            (StatusCode::CONFLICT, Json(json!({"error": stderr}))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct CheckoutReq {
    branch: String,
    #[serde(default)]
    create: bool,
}

/// `POST /api/sessions/{id}/git/checkout`:切换(或 `-b` 新建)分支。
/// 有未提交改动被 git 拒绝时,stderr 原样透传给手机(引导先 stash/commit)。
pub async fn git_checkout(
    Extension(state): Extension<Arc<ServerState>>,
    AxPath(id): AxPath<String>,
    Json(req): Json<CheckoutReq>,
) -> impl IntoResponse {
    let cwd = match session_git_cwd(&state, &id) {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };
    if !branch_name_ok(&req.branch) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid branch name"})),
        )
            .into_response();
    }
    let mut args: Vec<String> = vec!["checkout".into()];
    if req.create {
        args.push("-b".into());
    }
    args.push(req.branch.clone());
    match run_git(cwd, args).await {
        Ok((true, stdout, stderr)) => {
            Json(json!({"ok": true, "output": format!("{}{}", stdout, stderr)})).into_response()
        }
        Ok((false, stdout, stderr)) => (
            StatusCode::CONFLICT,
            Json(json!({"error": if stderr.is_empty() { stdout } else { stderr }})),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct StageReq {
    path: String,
    stage: bool,
}

/// `POST /api/sessions/{id}/git/stage`:单文件 stage(`git add`)/ unstage
/// (`git restore --staged`)。路径经 `--` 分隔(防 flag 注入)+ 相对路径校验。
pub async fn git_stage(
    Extension(state): Extension<Arc<ServerState>>,
    AxPath(id): AxPath<String>,
    Json(req): Json<StageReq>,
) -> impl IntoResponse {
    let cwd = match session_git_cwd(&state, &id) {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };
    if !rel_path_ok(&req.path) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "path must be a repo-relative path"})),
        )
            .into_response();
    }
    let args: Vec<String> = if req.stage {
        vec!["add".into(), "--".into(), req.path.clone()]
    } else {
        vec![
            "restore".into(),
            "--staged".into(),
            "--".into(),
            req.path.clone(),
        ]
    };
    match run_git(cwd, args).await {
        Ok((true, _, _)) => Json(json!({"ok": true})).into_response(),
        Ok((false, stdout, stderr)) => (
            StatusCode::CONFLICT,
            Json(json!({"error": if stderr.is_empty() { stdout } else { stderr }})),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct DiscardReq {
    /// None = 丢弃全部(restore staged+worktree + clean untracked)。
    path: Option<String>,
    /// 单文件时:untracked 文件走 `git clean`(restore 对其无意义)。
    #[serde(default)]
    untracked: bool,
}

/// `POST /api/sessions/{id}/git/discard`:丢弃改动(**不可逆**,手机端双确认后才调)。
/// 单文件:tracked → `restore --staged` + `restore`;untracked → `clean -f`。
/// 全部:`restore --staged .` + `restore .` + `clean -fd`。
pub async fn git_discard(
    Extension(state): Extension<Arc<ServerState>>,
    AxPath(id): AxPath<String>,
    Json(req): Json<DiscardReq>,
) -> impl IntoResponse {
    let cwd = match session_git_cwd(&state, &id) {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };
    let steps: Vec<Vec<String>> = match &req.path {
        Some(p) => {
            if !rel_path_ok(p) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error": "path must be a repo-relative path"})),
                )
                    .into_response();
            }
            if req.untracked {
                vec![vec!["clean".into(), "-f".into(), "--".into(), p.clone()]]
            } else {
                vec![
                    vec!["restore".into(), "--staged".into(), "--".into(), p.clone()],
                    vec!["restore".into(), "--".into(), p.clone()],
                ]
            }
        }
        None => vec![
            vec!["restore".into(), "--staged".into(), "--".into(), ".".into()],
            vec!["restore".into(), "--".into(), ".".into()],
            vec!["clean".into(), "-fd".into()],
        ],
    };
    for args in steps {
        // 各步尽力执行:空仓库无 HEAD 时 restore --staged 会报错,不中断后续步骤
        // (最终以 status 刷新为准;手机端操作后必刷新)。
        let _ = run_git(cwd.clone(), args).await;
    }
    Json(json!({"ok": true})).into_response()
}

#[derive(Deserialize)]
pub struct StashReq {
    op: String,
}

/// `POST /api/sessions/{id}/git/stash`:push(暂存工作区,含 untracked)/ pop(恢复)。
pub async fn git_stash(
    Extension(state): Extension<Arc<ServerState>>,
    AxPath(id): AxPath<String>,
    Json(req): Json<StashReq>,
) -> impl IntoResponse {
    let cwd = match session_git_cwd(&state, &id) {
        Ok(c) => c,
        Err(e) => return e.into_response(),
    };
    let args: Vec<String> = match req.op.as_str() {
        "push" => vec!["stash".into(), "push".into(), "--include-untracked".into()],
        "pop" => vec!["stash".into(), "pop".into()],
        other => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": format!("unknown op: {}", other)})),
            )
                .into_response()
        }
    };
    match run_git(cwd, args).await {
        Ok((true, stdout, stderr)) => {
            Json(json!({"ok": true, "output": format!("{}{}", stdout, stderr)})).into_response()
        }
        Ok((false, stdout, stderr)) => (
            StatusCode::CONFLICT,
            Json(json!({"error": if stderr.is_empty() { stdout } else { stderr }})),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))).into_response(),
    }
}

#[cfg(test)]
mod fix14_tests {
    use super::*;

    #[test]
    fn branch_and_hash_validation() {
        assert!(branch_name_ok("dev-0.2.12"));
        assert!(branch_name_ok("feature/x_1"));
        assert!(!branch_name_ok("-rf"), "以 - 开头会被 git 当 flag,必拒");
        assert!(!branch_name_ok("a b"));
        assert!(!branch_name_ok(""));
        assert!(hash_ok("70bcd33"));
        assert!(hash_ok("abcdef0123456789abcdef0123456789abcdef01"));
        assert!(!hash_ok("70bcd33; rm"));
        assert!(!hash_ok("abc"));
    }

    /// 端到端(真实 git):stage → unstage → discard 单文件 → stash push/pop → 分支解析。
    #[tokio::test]
    async fn fix14_roundtrip_in_temp_repo() {
        let dir = std::env::temp_dir().join(format!("meterm-git14-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().into_owned();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .args(args)
                .current_dir(&dir)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {:?}: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init", "-b", "main"]);
        std::fs::write(dir.join("a.txt"), "v1\n").unwrap();
        git(&["add", "-A"]);
        git(&[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-m",
            "init",
        ]);

        // stage 单文件:改动后 add → porcelain 显示已 stage。
        std::fs::write(dir.join("a.txt"), "v2\n").unwrap();
        let (ok, _, _) = run_git(cwd.clone(), vec!["add".into(), "--".into(), "a.txt".into()])
            .await
            .unwrap();
        assert!(ok);
        let (_, st, _) = run_git(
            cwd.clone(),
            vec!["status".into(), "--porcelain=v1".into(), "-b".into()],
        )
        .await
        .unwrap();
        assert_eq!(parse_git_status(&st)["files"][0]["staged"], true);

        // unstage → 回工作区改动。
        let (ok, _, _) = run_git(
            cwd.clone(),
            vec![
                "restore".into(),
                "--staged".into(),
                "--".into(),
                "a.txt".into(),
            ],
        )
        .await
        .unwrap();
        assert!(ok);
        let (_, st, _) = run_git(
            cwd.clone(),
            vec!["status".into(), "--porcelain=v1".into(), "-b".into()],
        )
        .await
        .unwrap();
        assert_eq!(parse_git_status(&st)["files"][0]["staged"], false);

        // stash push → 工作区干净;pop → 改动回来。
        let (ok, _, _) = run_git(
            cwd.clone(),
            vec!["stash".into(), "push".into(), "--include-untracked".into()],
        )
        .await
        .unwrap();
        assert!(ok);
        let (_, st, _) = run_git(
            cwd.clone(),
            vec!["status".into(), "--porcelain=v1".into(), "-b".into()],
        )
        .await
        .unwrap();
        assert!(
            parse_git_status(&st)["files"]
                .as_array()
                .unwrap()
                .is_empty(),
            "stash 后应干净"
        );
        let (ok, _, _) = run_git(cwd.clone(), vec!["stash".into(), "pop".into()])
            .await
            .unwrap();
        assert!(ok);

        // discard 单文件(tracked)→ 干净。
        let _ = run_git(
            cwd.clone(),
            vec![
                "restore".into(),
                "--staged".into(),
                "--".into(),
                "a.txt".into(),
            ],
        )
        .await;
        let (ok, _, _) = run_git(
            cwd.clone(),
            vec!["restore".into(), "--".into(), "a.txt".into()],
        )
        .await
        .unwrap();
        assert!(ok);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "v1\n");

        // 分支:新建 + 列表解析(当前分支标记)。
        let (ok, _, _) = run_git(
            cwd.clone(),
            vec!["checkout".into(), "-b".into(), "feat/x".into()],
        )
        .await
        .unwrap();
        assert!(ok);
        let (ok, stdout, _) = run_git(
            cwd.clone(),
            vec![
                "branch".into(),
                "--format=%(refname:short)\u{1f}%(HEAD)\u{1f}%(upstream:short)".into(),
            ],
        )
        .await
        .unwrap();
        assert!(ok);
        let names: Vec<&str> = stdout
            .lines()
            .map(|l| l.split('\u{1f}').next().unwrap())
            .collect();
        assert!(names.contains(&"feat/x") && names.contains(&"main"));
        let current = stdout.lines().find(|l| l.contains('*')).unwrap();
        assert!(
            current.starts_with("feat/x"),
            "当前分支应为 feat/x: {}",
            current
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
