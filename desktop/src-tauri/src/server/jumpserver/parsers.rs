use super::*;

// ---------------------------------------------------------------------------
// Response parsers (handle v2/v3/v4 format differences)
// ---------------------------------------------------------------------------

pub(super) fn parse_asset_response(data: serde_json::Value) -> Result<(Vec<Asset>, u32), String> {
    eprintln!(
        "[jumpserver] parse_asset_response: keys={:?}",
        data.as_object().map(|o| o.keys().collect::<Vec<_>>())
    );

    // Paginated: { results: [...], count: N }
    if let Some(results) = data.get("results") {
        let total = data.get("count").and_then(|c| c.as_u64()).unwrap_or(0) as u32;
        match serde_json::from_value::<Vec<Asset>>(results.clone()) {
            Ok(assets) => return Ok((normalize_assets(assets)?, total)),
            Err(e) => {
                eprintln!("[jumpserver] parse results array failed: {}", e);
                // Try parsing first element to see what fields exist
                if let Some(first) = results.as_array().and_then(|a| a.first()) {
                    eprintln!(
                        "[jumpserver] first asset keys: {:?}",
                        first.as_object().map(|o| o.keys().collect::<Vec<_>>())
                    );
                }
                // Fallback: return empty with total
                return Ok((Vec::new(), total));
            }
        }
    }
    // Direct array
    if data.is_array() {
        match serde_json::from_value::<Vec<Asset>>(data.clone()) {
            Ok(assets) => {
                let total = assets.len() as u32;
                return Ok((normalize_assets(assets)?, total));
            }
            Err(e) => eprintln!("[jumpserver] parse direct array failed: {}", e),
        }
    }
    // Nested { data: [...] }
    if let Some(data_inner) = data.get("data") {
        let assets: Vec<Asset> = serde_json::from_value(data_inner.clone()).unwrap_or_default();
        let total = assets.len() as u32;
        return Ok((normalize_assets(assets)?, total));
    }
    eprintln!("[jumpserver] unexpected asset response format");
    Err("unexpected asset response format".to_string())
}

/// Parse zTree format nodes. Matches Go parseZTreeNodes exactly:
/// - meta.data.id (UUID) → Node.id (for asset queries)
/// - pId → Node.parent_id (for tree building by frontend)
/// - title "(N)" → assets_amount
pub(super) fn parse_ztree_nodes(arr: &[serde_json::Value]) -> Vec<Node> {
    arr.iter()
        .filter_map(|item| {
            let tree_id = item
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let title = item
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let pid = item
                .get("pId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut name = item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                name = title.clone();
            }

            let mut assets_amount = 0u32;
            if let Some(idx) = title.rfind(" (") {
                if let Some(end) = title[idx + 2..].find(')') {
                    if let Ok(n) = title[idx + 2..idx + 2 + end].parse::<u32>() {
                        assets_amount = n;
                        if name == title {
                            name = title[..idx].to_string();
                        }
                    }
                }
            }

            // meta.data.id = UUID for asset queries, meta.data.key/value for tree
            let meta_data = item.get("meta").and_then(|m| m.get("data"));
            let node_id = meta_data
                .and_then(|d| d.get("id"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(&tree_id)
                .to_string();
            let key = meta_data
                .and_then(|d| d.get("key"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let value = meta_data
                .and_then(|d| d.get("value"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            if node_id.is_empty() && name.is_empty() {
                return None;
            }

            Some(Node {
                id: node_id,
                name,
                key,
                value,
                parent_id: pid,
                assets_amount,
            })
        })
        .collect()
}

pub(super) fn validate_ztree_input(arr: &[serde_json::Value]) -> Result<(), String> {
    if arr.len() > MAX_JUMPSERVER_NODES
        || arr.iter().any(|item| {
            let string_field_valid = |key: &str, max_bytes: usize| {
                item.get(key)
                    .and_then(serde_json::Value::as_str)
                    .is_none_or(|value| valid_display_text(value, max_bytes))
            };
            let tree_id = item
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let meta_id = item
                .get("meta")
                .and_then(|meta| meta.get("data"))
                .and_then(|data| data.get("id"))
                .and_then(serde_json::Value::as_str);
            let meta_data = item.get("meta").and_then(|meta| meta.get("data"));
            let meta_string_valid = |key: &str| {
                meta_data
                    .and_then(|data| data.get(key))
                    .and_then(serde_json::Value::as_str)
                    .is_none_or(|value| valid_display_text(value, 4_096))
            };
            !valid_resource_id(tree_id)
                || meta_id.is_some_and(|value| !valid_resource_id(value))
                || !string_field_valid("name", 4_096)
                || !string_field_valid("title", 4_096)
                || !string_field_valid("pId", 4_096)
                || !meta_string_valid("key")
                || !meta_string_valid("value")
        })
    {
        return Err("invalid JumpServer node response".to_string());
    }
    Ok(())
}

pub(super) fn normalize_assets(mut assets: Vec<Asset>) -> Result<Vec<Asset>, String> {
    for asset in &mut assets {
        // v2 compatibility: hostname → name, ip → address
        if asset.name.is_empty() && !asset.hostname.is_empty() {
            asset.name = asset.hostname.clone();
        }
        if asset.address.is_empty() && !asset.ip.is_empty() {
            asset.address = asset.ip.clone();
        }
        // v2 compatibility: platform is string "Linux" → normalize to {"name": "Linux"}
        if let Some(s) = asset.platform.as_str() {
            asset.platform = serde_json::json!({"name": s});
        }
        if !valid_resource_id(&asset.id)
            || !valid_display_text(&asset.name, 4_096)
            || !valid_display_text(&asset.address, 4_096)
            || !valid_display_text(&asset.comment, 4_096)
            || asset.protocols.len() > 64
            || serde_json::to_vec(asset).map_or(true, |serialized| serialized.len() > 64 * 1024)
        {
            return Err("invalid JumpServer asset response".to_string());
        }
    }
    Ok(assets)
}

pub(super) fn validate_nodes(nodes: Vec<Node>) -> Result<Vec<Node>, String> {
    if nodes.len() > MAX_JUMPSERVER_NODES
        || nodes.iter().any(|node| {
            !valid_resource_id(&node.id)
                || !valid_display_text(&node.name, 4_096)
                || !valid_display_text(&node.key, 4_096)
                || !valid_display_text(&node.value, 4_096)
                || !valid_display_text(&node.parent_id, 4_096)
        })
    {
        return Err("invalid JumpServer node response".to_string());
    }
    Ok(nodes)
}

pub(super) fn validate_accounts(accounts: Vec<Account>) -> Result<Vec<Account>, String> {
    if accounts.len() > MAX_JUMPSERVER_ACCOUNTS
        || accounts.iter().any(|account| {
            !valid_resource_id(&account.id)
                || !valid_display_text(&account.name, 512)
                || !valid_display_text(&account.username, 512)
                || !valid_display_text(&account.alias, 512)
        })
    {
        return Err("invalid JumpServer account response".to_string());
    }
    Ok(accounts)
}

/// Parse standard node response. Returns flat list with parent_id (frontend builds tree).
pub(super) fn parse_node_response(data: serde_json::Value) -> Result<Vec<Node>, String> {
    // Standard array
    if let Ok(nodes) = serde_json::from_value::<Vec<Node>>(data.clone()) {
        if !nodes.is_empty() {
            return validate_nodes(nodes);
        }
    }
    // Paginated { results: [...] }
    if let Some(results) = data.get("results") {
        if let Ok(nodes) = serde_json::from_value::<Vec<Node>>(results.clone()) {
            return validate_nodes(nodes);
        }
    }
    // zTree fallback
    if let Some(arr) = data.as_array() {
        return validate_nodes(parse_ztree_nodes(arr));
    }
    Err("unexpected node response format".to_string())
}
