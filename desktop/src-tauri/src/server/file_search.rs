// Recursive file search rooted at a path, for both local filesystem (walkdir)
// and SFTP sessions (recursive read_dir — covers SSH and JumpServer, which are
// both SFTP-backed). Hits are streamed back to the client via MSG_FILE_SEARCH_RESP
// batches (done=false), ending with a final done=true batch. The frontend matches
// responses by request_id and ignores stale ones, so no server-side cancel is
// needed — caps bound the work either way.

use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

use super::protocol;
use super::session::Session;

#[derive(Deserialize)]
pub struct SearchRequest {
    pub path: String,
    pub query: String,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub max_results: Option<usize>,
}

#[derive(Serialize, Clone)]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

#[derive(Serialize)]
struct SearchResponse<'a> {
    request_id: &'a Option<String>,
    hits: &'a [SearchHit],
    done: bool,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

const DEFAULT_CAP: usize = 2000;
const HARD_CAP: usize = 5000;
const BATCH: usize = 60;
const MAX_DIRS: usize = 20000;
const MAX_DEPTH: usize = 20;

fn is_junk_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "build" | ".next" | ".venv" | "__pycache__"
    )
}

fn send_batch(
    session: &Session,
    client_id: &str,
    expected_conn_gen: u64,
    request_id: &Option<String>,
    hits: &[SearchHit],
    done: bool,
    truncated: bool,
    error: Option<String>,
) -> bool {
    let resp = SearchResponse {
        request_id,
        hits,
        done,
        truncated,
        error,
    };
    let data = serde_json::to_vec(&resp).unwrap_or_default();
    session.send_to_client_generation(
        client_id,
        expected_conn_gen,
        protocol::encode_message(protocol::MSG_FILE_SEARCH_RESP, &data),
    )
}

/// Recursive search over the LOCAL filesystem (blocking — call via spawn_blocking).
pub fn handle_local_file_search(
    payload: &[u8],
    session: &Session,
    client_id: &str,
    expected_conn_gen: u64,
) {
    use walkdir::WalkDir;

    let req: SearchRequest = match serde_json::from_slice(payload) {
        Ok(r) => r,
        Err(e) => {
            send_batch(
                session,
                client_id,
                expected_conn_gen,
                &None,
                &[],
                true,
                false,
                Some(e.to_string()),
            );
            return;
        }
    };
    let q = req.query.trim().to_lowercase();
    if q.is_empty() {
        send_batch(
            session,
            client_id,
            expected_conn_gen,
            &req.request_id,
            &[],
            true,
            false,
            None,
        );
        return;
    }
    let cap = req.max_results.unwrap_or(DEFAULT_CAP).min(HARD_CAP);

    let mut batch: Vec<SearchHit> = Vec::with_capacity(BATCH);
    let mut total = 0usize;
    let mut truncated = false;

    let walker = WalkDir::new(&req.path)
        .follow_links(false)
        .max_depth(MAX_DEPTH)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            if e.file_type().is_dir() {
                return !is_junk_dir(&e.file_name().to_string_lossy());
            }
            true
        });

    for entry in walker.flatten() {
        if entry.depth() == 0 {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.to_lowercase().contains(&q) {
            continue;
        }
        batch.push(SearchHit {
            path: entry.path().to_string_lossy().to_string(),
            name,
            is_dir: entry.file_type().is_dir(),
        });
        total += 1;
        if total >= cap {
            truncated = true;
            break;
        }
        if batch.len() >= BATCH {
            if !send_batch(
                session,
                client_id,
                expected_conn_gen,
                &req.request_id,
                &batch,
                false,
                false,
                None,
            ) {
                return;
            }
            batch.clear();
        }
    }

    send_batch(
        session,
        client_id,
        expected_conn_gen,
        &req.request_id,
        &batch,
        true,
        truncated,
        None,
    );
}

/// Recursive search over an SFTP session (BFS via read_dir). Covers SSH and
/// JumpServer (both expose an SftpSession).
pub async fn handle_sftp_file_search(
    payload: &[u8],
    sftp: &SftpSession,
    session: &Session,
    client_id: &str,
    expected_conn_gen: u64,
) {
    let req: SearchRequest = match serde_json::from_slice(payload) {
        Ok(r) => r,
        Err(e) => {
            send_batch(
                session,
                client_id,
                expected_conn_gen,
                &None,
                &[],
                true,
                false,
                Some(e.to_string()),
            );
            return;
        }
    };
    let q = req.query.trim().to_lowercase();
    if q.is_empty() {
        send_batch(
            session,
            client_id,
            expected_conn_gen,
            &req.request_id,
            &[],
            true,
            false,
            None,
        );
        return;
    }
    let cap = req.max_results.unwrap_or(DEFAULT_CAP).min(HARD_CAP);

    // Resolve a relative root (e.g. ".") to an absolute path.
    let root = if !req.path.starts_with('/') {
        sftp.canonicalize(&req.path)
            .await
            .unwrap_or_else(|_| req.path.clone())
    } else {
        req.path.clone()
    };

    let mut batch: Vec<SearchHit> = Vec::with_capacity(BATCH);
    let mut total = 0usize;
    let mut truncated = false;
    let mut dirs_visited = 0usize;
    let mut queue: VecDeque<(String, usize)> = VecDeque::new();
    queue.push_back((root, 0));

    'outer: while let Some((dir, depth)) = queue.pop_front() {
        if dirs_visited >= MAX_DIRS {
            truncated = true;
            break;
        }
        dirs_visited += 1;

        let entries = match sftp.read_dir(dir.clone()).await {
            Ok(e) => e,
            Err(_) => continue, // skip unreadable dirs (permissions etc.)
        };
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let attrs = entry.metadata();
            let is_link = attrs.is_symlink();
            let is_dir = attrs.is_dir();
            let full = if dir.ends_with('/') {
                format!("{}{}", dir, name)
            } else {
                format!("{}/{}", dir, name)
            };

            if name.to_lowercase().contains(&q) {
                batch.push(SearchHit {
                    path: full.clone(),
                    name: name.clone(),
                    is_dir,
                });
                total += 1;
                if total >= cap {
                    truncated = true;
                    break 'outer;
                }
                if batch.len() >= BATCH {
                    if !send_batch(
                        session,
                        client_id,
                        expected_conn_gen,
                        &req.request_id,
                        &batch,
                        false,
                        false,
                        None,
                    ) {
                        return;
                    }
                    batch.clear();
                }
            }

            // Recurse into real subdirectories (never follow symlinks → no loops).
            if is_dir && !is_link && depth + 1 < MAX_DEPTH && !is_junk_dir(&name) {
                queue.push_back((full, depth + 1));
            }
        }
    }

    send_batch(
        session,
        client_id,
        expected_conn_gen,
        &req.request_id,
        &batch,
        true,
        truncated,
        None,
    );
}
