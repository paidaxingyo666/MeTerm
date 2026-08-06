//! 会话无关的本机文件 REST(手机主页「文件」tab 数据源)。
//!
//! 与会话 WS 文件协议(file_handler.rs)互补:不依赖任何 PTY 会话、不需要 master,
//! 持 Bearer token 即可浏览/传输**桌面本机**文件——信任级与既有会话文件协议一致
//! (token 持有者本就可经会话协议全盘读写,此处不新增攻击面)。端点(Bearer 鉴权组):
//! - `GET  /api/files/list?path=~&hidden=0&limit=5000`
//! - `GET  /api/files/download?path=`(流式,Content-Disposition RFC5987 文件名)
//! - `POST /api/files/upload?path=&overwrite=0`(原始字节流;临时文件+原子 rename;
//!   同名默认自动加 ` (N)` 后缀,`overwrite=1` 就地覆盖——文本编辑器保存用)
//! - `POST /api/files/op` `{op: mkdir|rename|delete, path, new_path?}`
//!
//! 纪律:
//! - 路径经 [`file_handler::expand_tilde`] 展开(`~`/`~/...`);空路径 400;
//! - 阻塞 fs 调用(read_dir / 元数据批量)放 `spawn_blocking`,不占 async 线程;
//! - 上传先写同目录 `.meterm-upload-*.part` 再 rename(同卷原子,失败清理残件);
//! - rename 目标已存在 → 409(不静默覆盖);delete 目录递归。

use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::Query;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;
use tokio::io::AsyncWriteExt;

use super::file_handler::{expand_tilde, FileInfo};

/// 统一错误响应:`{"error": "..."}` + 状态码。
fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

/// 展开 `~` 并拒绝空路径。
fn resolve(path: &str) -> Result<String, Response> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "path must not be empty"));
    }
    Ok(expand_tilde(trimmed))
}

// ---------------------------------------------------------------------------
// GET /api/files/list
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ListQuery {
    pub path: String,
    #[serde(default)]
    pub hidden: bool,
    /// 软上限(默认 5000,0 = 不限)。超限截断并回 truncated/total。
    pub limit: Option<usize>,
}

/// 列目录。响应 `{path(展开后绝对), files:[FileInfo], truncated, total?}`;
/// FileInfo 序列化为 snake_case(is_dir/is_link/link_target),与手机 FileEntry
/// 解码键一致(会话协议同款,勿漂移)。符号链接解引用一次填 is_dir/size(悬空链接
/// 保持 is_dir=false),并带 link_target。
pub async fn files_list(Query(q): Query<ListQuery>) -> Response {
    let resolved = match resolve(&q.path) {
        Ok(p) => p,
        Err(e) => return e,
    };
    let limit = q.limit.unwrap_or(5000);
    let show_hidden = q.hidden;
    // read_dir + 每项元数据是阻塞 I/O(大目录可达数千次 stat)→ blocking 池。
    let listed = tokio::task::spawn_blocking(move || list_dir_blocking(&resolved, show_hidden))
        .await
        .unwrap_or_else(|e| Err(format!("list task failed: {}", e)));
    match listed {
        Ok((path, mut files)) => {
            let total = files.len();
            let truncated = limit > 0 && total > limit;
            if truncated {
                files.truncate(limit);
            }
            let mut body = json!({ "path": path, "files": files, "truncated": truncated });
            if truncated {
                body["total"] = json!(total);
            }
            Json(body).into_response()
        }
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

/// 阻塞版列目录(逻辑与 file_handler::handle_file_list 的 local 分支同口径;
/// 该函数绑死协议帧收发形态,不便直接复用,这里保持行为一致的独立实现)。
fn list_dir_blocking(resolved: &str, show_hidden: bool) -> Result<(String, Vec<FileInfo>), String> {
    let entries = std::fs::read_dir(resolved).map_err(|e| format!("{}: {}", resolved, e))?;
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        // entry.metadata() = symlink_metadata 语义(不解引用),用于判断链接本身。
        let Ok(meta) = entry.metadata() else { continue };
        let is_link = meta.file_type().is_symlink();
        let mut is_dir = meta.is_dir();
        let mut size = meta.len() as i64;
        let mut link_target = None;
        if is_link {
            // 解引用一次:指向目录的链接按目录呈现(上层免特判);悬空链接保底 file。
            if let Ok(target) = std::fs::metadata(entry.path()) {
                is_dir = target.is_dir();
                size = target.len() as i64;
            }
            if let Ok(tp) = std::fs::read_link(entry.path()) {
                link_target = Some(tp.display().to_string());
            }
        }
        files.push(FileInfo {
            name,
            size,
            mode: String::new(),
            mtime: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            is_dir,
            owner: String::new(),
            group: String::new(),
            is_link,
            link_target,
        });
    }
    Ok((resolved.to_string(), files))
}

// ---------------------------------------------------------------------------
// GET /api/files/download
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct PathQuery {
    pub path: String,
}

/// 下载文件:流式响应(64KB 块),带 Content-Length(URLSession 原生进度依赖)与
/// RFC5987 UTF-8 文件名。目录 → 400;不存在/不可读 → 404。
pub async fn files_download(Query(q): Query<PathQuery>) -> Response {
    let resolved = match resolve(&q.path) {
        Ok(p) => p,
        Err(e) => return e,
    };
    let meta = match tokio::fs::metadata(&resolved).await {
        Ok(m) => m,
        Err(e) => return err(StatusCode::NOT_FOUND, format!("{}: {}", resolved, e)),
    };
    if meta.is_dir() {
        return err(StatusCode::BAD_REQUEST, "path is a directory");
    }
    let file = match tokio::fs::File::open(&resolved).await {
        Ok(f) => f,
        Err(e) => return err(StatusCode::NOT_FOUND, format!("{}: {}", resolved, e)),
    };
    let name = Path::new(&resolved)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    let stream = tokio_util::io::ReaderStream::with_capacity(file, 64 * 1024);
    (
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_LENGTH, meta.len().to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename*=UTF-8''{}", rfc5987_encode(&name)),
            ),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}

/// RFC5987 ext-value 百分号编码(attr-char 直通,其余含 UTF-8 多字节全部 %XX)。
fn rfc5987_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'!'
            | b'#'
            | b'$'
            | b'&'
            | b'+'
            | b'-'
            | b'.'
            | b'^'
            | b'_'
            | b'`'
            | b'|'
            | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// POST /api/files/upload
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct UploadQuery {
    /// 目标**文件**完整路径(非目录)。
    pub path: String,
    /// true = 就地覆盖(文本编辑器保存);false(默认)= 同名自动加 ` (N)` 后缀。
    #[serde(default)]
    pub overwrite: bool,
}

/// 上传:body 原始字节流 → 同目录 `.part` 临时文件 → 原子 rename 落位。
/// 成功响应 `{name, path}`(自动加后缀时手机据此刷新展示)。
/// 该路由在注册处 `DefaultBodyLimit::disable()`(axum 默认 2MB 上限对文件传输无意义)。
pub async fn files_upload(Query(q): Query<UploadQuery>, body: Body) -> Response {
    let resolved = match resolve(&q.path) {
        Ok(p) => p,
        Err(e) => return e,
    };
    let target = PathBuf::from(&resolved);
    let Some(dir) = target.parent().map(Path::to_path_buf) else {
        return err(StatusCode::BAD_REQUEST, "path has no parent directory");
    };
    match tokio::fs::metadata(&dir).await {
        Ok(m) if m.is_dir() => {}
        _ => return err(StatusCode::BAD_REQUEST, "parent directory does not exist"),
    }
    let final_path = if q.overwrite {
        target
    } else {
        unique_target(&target).await
    };
    // 临时文件与目标同目录:rename 同卷原子;uuid 防并发上传互踩。
    let tmp = dir.join(format!(".meterm-upload-{}.part", uuid::Uuid::new_v4()));
    let mut f = match tokio::fs::File::create(&tmp).await {
        Ok(f) => f,
        Err(e) => {
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("create temp: {}", e),
            )
        }
    };
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                drop(f);
                let _ = tokio::fs::remove_file(&tmp).await;
                return err(StatusCode::BAD_REQUEST, format!("read body: {}", e));
            }
        };
        if let Err(e) = f.write_all(&chunk).await {
            drop(f);
            let _ = tokio::fs::remove_file(&tmp).await;
            return err(StatusCode::INTERNAL_SERVER_ERROR, format!("write: {}", e));
        }
    }
    if let Err(e) = f.flush().await {
        drop(f);
        let _ = tokio::fs::remove_file(&tmp).await;
        return err(StatusCode::INTERNAL_SERVER_ERROR, format!("flush: {}", e));
    }
    drop(f);
    if let Err(e) = tokio::fs::rename(&tmp, &final_path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return err(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("finalize: {}", e),
        );
    }
    let name = final_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Json(json!({ "name": name, "path": final_path.display().to_string() })).into_response()
}

/// 同名冲突自动唯一化:`name.ext` → `name (1).ext` → `name (2).ext` …(上限 999,
/// 极端情况退回 uuid 后缀,保证总能落盘)。
async fn unique_target(target: &Path) -> PathBuf {
    if !matches!(tokio::fs::try_exists(target).await, Ok(true)) {
        return target.to_path_buf();
    }
    let dir = target.parent().unwrap_or(Path::new("."));
    let stem = target
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = target
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for n in 1..=999u32 {
        let candidate = dir.join(format!("{} ({}){}", stem, n, ext));
        if !matches!(tokio::fs::try_exists(&candidate).await, Ok(true)) {
            return candidate;
        }
    }
    dir.join(format!("{}-{}{}", stem, uuid::Uuid::new_v4(), ext))
}

// ---------------------------------------------------------------------------
// POST /api/files/op
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct OpRequest {
    pub op: String,
    pub path: String,
    #[serde(default)]
    pub new_path: Option<String>,
}

/// 文件操作:mkdir(create_dir_all)/ rename(目标已存在 → 409,不静默覆盖)/
/// delete(目录递归)。成功 `{"ok":true}`。
pub async fn files_op(Json(req): Json<OpRequest>) -> Response {
    let path = match resolve(&req.path) {
        Ok(p) => p,
        Err(e) => return e,
    };
    let op = req.op.clone();
    let new_path = match req.new_path.as_deref() {
        Some(np) => match resolve(np) {
            Ok(p) => Some(p),
            Err(e) => return e,
        },
        None => None,
    };
    let result = tokio::task::spawn_blocking(move || op_blocking(&op, &path, new_path.as_deref()))
        .await
        .unwrap_or_else(|e| {
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("op task failed: {}", e),
            ))
        });
    match result {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err((status, msg)) => err(status, msg),
    }
}

fn op_blocking(op: &str, path: &str, new_path: Option<&str>) -> Result<(), (StatusCode, String)> {
    let io = |e: std::io::Error| (StatusCode::BAD_REQUEST, e.to_string());
    match op {
        "mkdir" => std::fs::create_dir_all(path).map_err(io),
        "delete" => {
            let p = Path::new(path);
            if p.is_dir() {
                std::fs::remove_dir_all(p).map_err(io)
            } else {
                std::fs::remove_file(p).map_err(io)
            }
        }
        "rename" => {
            let Some(np) = new_path else {
                return Err((StatusCode::BAD_REQUEST, "rename requires new_path".into()));
            };
            if Path::new(np).exists() {
                return Err((StatusCode::CONFLICT, format!("{}: already exists", np)));
            }
            std::fs::rename(path, np).map_err(io)
        }
        other => Err((StatusCode::BAD_REQUEST, format!("unknown op: {}", other))),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 独立临时目录(git_handlers 测试同款手法;测试结束尽力清理)。
    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("meterm-files-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn body_json(resp: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// list:隐藏文件过滤、目录标记、截断口径。
    #[tokio::test]
    async fn list_filters_hidden_and_marks_dirs() {
        let dir = temp_dir();
        std::fs::write(dir.join("a.txt"), b"hello").unwrap();
        std::fs::write(dir.join(".hidden"), b"x").unwrap();
        std::fs::create_dir(dir.join("sub")).unwrap();

        let resp = files_list(Query(ListQuery {
            path: dir.display().to_string(),
            hidden: false,
            limit: None,
        }))
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        let files = v["files"].as_array().unwrap();
        assert_eq!(files.len(), 2, "隐藏文件须被过滤");
        let sub = files.iter().find(|f| f["name"] == "sub").unwrap();
        assert_eq!(sub["is_dir"], true);
        let a = files.iter().find(|f| f["name"] == "a.txt").unwrap();
        assert_eq!(a["size"], 5);

        // hidden=1 → 三项都在。
        let resp = files_list(Query(ListQuery {
            path: dir.display().to_string(),
            hidden: true,
            limit: None,
        }))
        .await;
        let v = body_json(resp).await;
        assert_eq!(v["files"].as_array().unwrap().len(), 3);

        // limit=1 → 截断标记 + total。
        let resp = files_list(Query(ListQuery {
            path: dir.display().to_string(),
            hidden: true,
            limit: Some(1),
        }))
        .await;
        let v = body_json(resp).await;
        assert_eq!(v["truncated"], true);
        assert_eq!(v["total"], 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// list:不存在的路径 → 400 带 error。
    #[tokio::test]
    async fn list_missing_path_is_400() {
        let resp = files_list(Query(ListQuery {
            path: "/nonexistent-meterm-test-dir".into(),
            hidden: false,
            limit: None,
        }))
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert!(body_json(resp).await["error"].is_string());
    }

    /// download:内容与 Content-Disposition/Length;目录 → 400。
    #[tokio::test]
    async fn download_streams_file_with_headers() {
        let dir = temp_dir();
        std::fs::write(dir.join("中文 名.bin"), b"payload").unwrap();
        let resp = files_download(Query(PathQuery {
            path: dir.join("中文 名.bin").display().to_string(),
        }))
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers()[header::CONTENT_LENGTH], "7");
        let cd = resp.headers()[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .to_string();
        let encoded = cd
            .strip_prefix("attachment; filename*=UTF-8''")
            .unwrap_or_else(|| panic!("cd 前缀不符: {}", cd));
        assert!(
            !encoded.contains(' '),
            "RFC5987 编码值不得含裸空格: {}",
            encoded
        );
        assert_eq!(encoded, "%E4%B8%AD%E6%96%87%20%E5%90%8D.bin");
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&bytes[..], b"payload");

        let resp = files_download(Query(PathQuery {
            path: dir.display().to_string(),
        }))
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// upload:落盘内容、同名自动后缀、overwrite 就地覆盖、残件清理不可见。
    #[tokio::test]
    async fn upload_writes_suffixes_and_overwrites() {
        let dir = temp_dir();
        let target = dir.join("up.txt").display().to_string();
        let q = |overwrite| {
            Query(UploadQuery {
                path: target.clone(),
                overwrite,
            })
        };

        let resp = files_upload(q(false), Body::from("v1")).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await["name"], "up.txt");
        assert_eq!(std::fs::read(dir.join("up.txt")).unwrap(), b"v1");

        // 同名不覆盖 → up (1).txt。
        let resp = files_upload(q(false), Body::from("v2")).await;
        let v = body_json(resp).await;
        assert_eq!(v["name"], "up (1).txt");
        assert_eq!(std::fs::read(dir.join("up (1).txt")).unwrap(), b"v2");
        assert_eq!(
            std::fs::read(dir.join("up.txt")).unwrap(),
            b"v1",
            "原文件不被动"
        );

        // overwrite=1 → 就地覆盖。
        let resp = files_upload(q(true), Body::from("v3")).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(std::fs::read(dir.join("up.txt")).unwrap(), b"v3");

        // 目录里不残留 .part 临时文件。
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".part"))
            .collect();
        assert!(leftovers.is_empty(), "不得残留临时文件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// upload:父目录不存在 → 400。
    #[tokio::test]
    async fn upload_missing_parent_is_400() {
        let resp = files_upload(
            Query(UploadQuery {
                path: "/nonexistent-meterm-dir/x.txt".into(),
                overwrite: false,
            }),
            Body::from("x"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    /// op:mkdir / rename(冲突 409)/ delete(目录递归)。
    #[tokio::test]
    async fn op_mkdir_rename_delete_roundtrip() {
        let dir = temp_dir();
        let sub = dir.join("nested/deep");
        let op = |op: &str, path: String, new_path: Option<String>| {
            files_op(Json(OpRequest {
                op: op.into(),
                path,
                new_path,
            }))
        };

        assert_eq!(
            op("mkdir", sub.display().to_string(), None).await.status(),
            StatusCode::OK
        );
        assert!(sub.is_dir());

        std::fs::write(sub.join("f.txt"), b"x").unwrap();
        // rename 到已存在目标 → 409。
        std::fs::write(dir.join("occupied.txt"), b"y").unwrap();
        let resp = op(
            "rename",
            sub.join("f.txt").display().to_string(),
            Some(dir.join("occupied.txt").display().to_string()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::CONFLICT);
        // 正常 rename。
        let resp = op(
            "rename",
            sub.join("f.txt").display().to_string(),
            Some(sub.join("g.txt").display().to_string()),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(sub.join("g.txt").exists());

        // delete 目录递归。
        let resp = op("delete", dir.join("nested").display().to_string(), None).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(!dir.join("nested").exists());

        // 未知 op → 400。
        let resp = op("chmodx", dir.display().to_string(), None).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `~` 展开:list("~") 必须解析为 home 绝对路径(与会话协议同口径)。
    #[tokio::test]
    async fn tilde_expands_to_home() {
        let resp = files_list(Query(ListQuery {
            path: "~".into(),
            hidden: false,
            limit: Some(1),
        }))
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        let home = dirs::home_dir().unwrap().display().to_string();
        assert_eq!(v["path"], home);
    }

    /// 空路径 → 400。
    #[tokio::test]
    async fn empty_path_is_400() {
        let resp = files_list(Query(ListQuery {
            path: "  ".into(),
            hidden: false,
            limit: None,
        }))
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }
}
