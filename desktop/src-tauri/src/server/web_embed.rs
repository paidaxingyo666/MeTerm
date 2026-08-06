//! Embedded web frontend static file service — mirrors Go `web/embed.go`.
//!
//! Serves the built frontend from `frontend/dist/` with SPA fallback
//! (unknown paths return index.html).

use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

// Note: folder path is relative to Cargo.toml location (desktop/src-tauri/)
#[derive(RustEmbed)]
#[folder = "../../frontend/dist/"]
struct WebAssets;

/// Check if we have any embedded content (dist/ may be empty in dev mode).
pub fn has_content() -> bool {
    WebAssets::get("index.html").is_some()
}

/// Serve a static file or SPA fallback.
pub async fn serve_static(uri: axum::http::Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');

    // API and WebSocket namespaces must never fall through to the SPA. Apart
    // from making missing endpoints unambiguous, this keeps removed sensitive
    // routes verifiably absent instead of returning a misleading HTTP 200.
    if path == "api"
        || path.starts_with("api/")
        || path == "ws"
        || path.starts_with("ws/")
        || path == "ws-events"
    {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }

    // Try exact path first
    if let Some(file) = WebAssets::get(path) {
        return serve_file(path, &file.data);
    }

    // SPA fallback: serve index.html for unknown paths
    if let Some(file) = WebAssets::get("index.html") {
        return serve_file("index.html", &file.data);
    }

    (StatusCode::NOT_FOUND, "not found").into_response()
}

fn serve_file(path: &str, data: &[u8]) -> Response {
    let mime = mime_from_path(path);
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, mime)],
        data.to_vec(),
    )
        .into_response()
}

fn mime_from_path(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn removed_api_routes_never_receive_spa_fallback() {
        let response = serve_static(
            "/api/ssh/connections/id/secrets"
                .parse::<axum::http::Uri>()
                .unwrap(),
        )
        .await
        .into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
