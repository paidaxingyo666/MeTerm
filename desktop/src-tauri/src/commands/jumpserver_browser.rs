use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, WebviewWindow};

const BROWSER_LABEL: &str = "jumpserver-browser";
const MAX_EVENT_BYTES: usize = 64 * 1024;

const CONTEXT_REQUEST: &str = "jumpserver-browser-context-request";
const RPC_REQUEST: &str = "jumpserver-browser-rpc-request";
const SESSION_EXPIRED: &str = "jumpserver-session-expired-reopen";
const SNAP_DOCK: &str = "jumpserver-snap-dock";
const DOCK_TO_PANEL: &str = "jumpserver-dock-to-panel";
const CONNECT_ASSET: &str = "jumpserver-connect-asset";

fn object(value: &Value) -> Result<&Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| "invalid JumpServer browser event payload".to_string())
}

fn has_only_keys(map: &Map<String, Value>, allowed: &[&str]) -> bool {
    map.keys().all(|key| allowed.contains(&key.as_str()))
}

fn safe_request_id(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|value| {
        (16..=128).contains(&value.len())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    })
}

fn safe_resource_id(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|value| {
        (1..=256).contains(&value.len())
            && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
            })
    })
}

fn safe_text(value: Option<&Value>, max_len: usize) -> bool {
    value.and_then(Value::as_str).is_some_and(|value| {
        !value.is_empty() && value.len() <= max_len && !value.chars().any(char::is_control)
    })
}

fn safe_display_text(value: Option<&Value>, max_len: usize) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| text.len() <= max_len && !text.chars().any(char::is_control))
}

fn optional_safe_text(value: Option<&Value>, max_len: usize) -> bool {
    value.is_none()
        || value
            .and_then(Value::as_str)
            .is_some_and(|text| text.len() <= max_len && !text.chars().any(char::is_control))
}

fn bounded_json(value: &Value, depth: usize) -> bool {
    if depth > 8 {
        return false;
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => true,
        Value::String(value) => value.len() <= 4096 && !value.contains('\0'),
        Value::Array(values) => {
            values.len() <= 64 && values.iter().all(|value| bounded_json(value, depth + 1))
        }
        Value::Object(values) => {
            values.len() <= 32
                && values.keys().all(|key| key.len() <= 64)
                && values.values().all(|value| bounded_json(value, depth + 1))
        }
    }
}

fn validate_context_request(payload: &Value) -> Result<(), String> {
    let map = object(payload)?;
    if has_only_keys(map, &["requestId", "browserLabel"])
        && safe_request_id(map.get("requestId"))
        && map.get("browserLabel").and_then(Value::as_str) == Some(BROWSER_LABEL)
    {
        Ok(())
    } else {
        Err("invalid JumpServer browser context request".to_string())
    }
}

fn valid_positive_integer(value: Option<&Value>, max: u64) -> bool {
    value.is_none()
        || value
            .and_then(Value::as_u64)
            .is_some_and(|value| value > 0 && value <= max)
}

fn validate_rpc_request(payload: &Value) -> Result<(), String> {
    let map = object(payload)?;
    if !has_only_keys(
        map,
        &[
            "requestId",
            "browserLabel",
            "configName",
            "operation",
            "params",
        ],
    ) || !safe_request_id(map.get("requestId"))
        || map.get("browserLabel").and_then(Value::as_str) != Some(BROWSER_LABEL)
        || !safe_text(map.get("configName"), 256)
    {
        return Err("invalid JumpServer browser RPC request".to_string());
    }
    let params = map
        .get("params")
        .and_then(Value::as_object)
        .ok_or_else(|| "invalid JumpServer browser RPC parameters".to_string())?;
    let valid = match map.get("operation").and_then(Value::as_str) {
        Some("assets") => {
            has_only_keys(params, &["search", "nodeId", "page", "pageSize"])
                && optional_safe_text(params.get("search"), 256)
                && (params.get("nodeId").is_none() || safe_resource_id(params.get("nodeId")))
                && valid_positive_integer(params.get("page"), 10_000)
                && valid_positive_integer(params.get("pageSize"), 100)
        }
        Some("nodes") => params.is_empty(),
        Some("accounts") => {
            has_only_keys(params, &["assetId"]) && safe_resource_id(params.get("assetId"))
        }
        _ => false,
    };
    valid
        .then_some(())
        .ok_or_else(|| "invalid JumpServer browser RPC parameters".to_string())
}

fn validate_config_action(payload: &Value) -> Result<(), String> {
    let map = object(payload)?;
    (has_only_keys(map, &["configName"]) && safe_text(map.get("configName"), 256))
        .then_some(())
        .ok_or_else(|| "invalid JumpServer browser action".to_string())
}

fn validate_connect_asset(payload: &Value) -> Result<(), String> {
    let map = object(payload)?;
    let asset = map.get("asset").and_then(Value::as_object);
    let account = map.get("account").and_then(Value::as_object);
    let valid = has_only_keys(map, &["configName", "asset", "account"])
        && safe_text(map.get("configName"), 256)
        && asset.is_some_and(|asset| {
            has_only_keys(asset, &["id", "name", "address", "platform", "protocols"])
                && safe_resource_id(asset.get("id"))
                && safe_display_text(asset.get("name"), 512)
                && safe_display_text(asset.get("address"), 512)
                && asset
                    .get("platform")
                    .is_some_and(|value| bounded_json(value, 0))
                && asset
                    .get("protocols")
                    .is_some_and(|value| bounded_json(value, 0))
        })
        && account.is_some_and(|account| {
            has_only_keys(account, &["id", "name", "username", "privileged"])
                && safe_resource_id(account.get("id"))
                && safe_display_text(account.get("name"), 512)
                && safe_display_text(account.get("username"), 512)
                && account.get("privileged").and_then(Value::as_bool).is_some()
        });
    valid
        .then_some(())
        .ok_or_else(|| "invalid JumpServer browser connection request".to_string())
}

fn validate_forwarded_event(event: &str, payload: &Value) -> Result<(), String> {
    if !bounded_json(payload, 0)
        || serde_json::to_vec(payload)
            .map_err(|_| "invalid JumpServer browser event payload".to_string())?
            .len()
            > MAX_EVENT_BYTES
    {
        return Err("JumpServer browser event payload is too large".to_string());
    }
    match event {
        CONTEXT_REQUEST => validate_context_request(payload),
        RPC_REQUEST => validate_rpc_request(payload),
        SESSION_EXPIRED | SNAP_DOCK | DOCK_TO_PANEL => validate_config_action(payload),
        CONNECT_ASSET => validate_connect_asset(payload),
        _ => Err("JumpServer browser event is not allowed".to_string()),
    }
}

/// Narrow broker for the unprivileged JumpServer utility window. The browser has no generic
/// Tauri event emit permission, so even injected script cannot forge menu, tab-transfer, file,
/// credential, or lifecycle events in a trusted main window.
#[tauri::command]
pub fn forward_jumpserver_browser_event(
    app: AppHandle,
    webview_window: WebviewWindow,
    event: String,
    payload: Value,
) -> Result<(), String> {
    if webview_window.label() != BROWSER_LABEL {
        return Err("JumpServer browser event rejected for this window".to_string());
    }
    validate_forwarded_event(&event, &payload)?;
    app.emit(&event, payload)
        .map_err(|_| "failed to forward JumpServer browser event".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_expected_browser_events_and_shapes_are_allowed() {
        let context = json!({
            "requestId": "01234567-89ab-cdef-0123-456789abcdef",
            "browserLabel": BROWSER_LABEL,
        });
        assert!(validate_forwarded_event(CONTEXT_REQUEST, &context).is_ok());
        assert!(validate_forwarded_event("menu-new-private-terminal", &context).is_err());

        let rpc = json!({
            "requestId": "01234567-89ab-cdef-0123-456789abcdef",
            "browserLabel": BROWSER_LABEL,
            "configName": "production",
            "operation": "assets",
            "params": { "search": "db", "page": 1, "pageSize": 50 },
        });
        assert!(validate_forwarded_event(RPC_REQUEST, &rpc).is_ok());
        let mut invalid = rpc;
        invalid["params"]["pageSize"] = json!(1000);
        assert!(validate_forwarded_event(RPC_REQUEST, &invalid).is_err());
    }
}
