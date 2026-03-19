use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct FetchAiModelsRequest {
    url: String,
    /// HTTP 请求头，格式为 [key, value] 对列表
    headers: Vec<(String, String)>,
}

#[derive(Serialize)]
pub struct FetchAiModelsResponse {
    ok: bool,
    status: u16,
    body: String,
}

/// 通过 Rust reqwest 发起 HTTP GET 请求拉取 AI provider 的模型列表。
/// 在 Windows 的 WebView2 环境中，直接使用浏览器 fetch() 可能因 CORS 策略导致
/// "Failed to fetch" 错误；本命令在 Rust 层发起请求，完全绕过浏览器 CORS 限制。
#[tauri::command]
pub async fn fetch_ai_models(request: FetchAiModelsRequest) -> Result<FetchAiModelsResponse, String> {
    // 基本安全校验：只允许 http/https 协议
    if !request.url.starts_with("http://") && !request.url.starts_with("https://") {
        return Err("only http and https URLs are allowed".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let mut builder = client.get(&request.url);
    for (key, value) in &request.headers {
        builder = builder.header(key.as_str(), value.as_str());
    }

    let resp = builder.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| e.to_string())?;

    Ok(FetchAiModelsResponse {
        ok: status >= 200 && status < 300,
        status,
        body,
    })
}

/// 通过 Rust reqwest 发起 HTTP POST 请求并以流式方式将响应体推送到前端 Channel。
/// 用于 AI 聊天的 SSE 流式输出，完全绕过 WebView2（Windows）的 CORS 限制。
#[tauri::command]
pub async fn fetch_ai_stream(
    url: String,
    headers: Vec<(String, String)>,
    body: String,
    on_event: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("only http and https URLs are allowed".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let mut builder = client.post(&url).body(body);
    for (key, value) in &headers {
        builder = builder.header(key.as_str(), value.as_str());
    }

    let resp = builder.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();

    if status < 200 || status >= 300 {
        let err_body = resp.text().await.unwrap_or_default();
        let snippet = &err_body[..err_body.len().min(300)];
        return Err(format!("HTTP {}: {}", status, snippet));
    }

    let mut resp = resp;
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        let text = String::from_utf8_lossy(&chunk).to_string();
        if on_event.send(text).is_err() {
            // 前端已关闭 channel（窗口关闭或请求取消），停止发送
            break;
        }
    }

    Ok(())
}
