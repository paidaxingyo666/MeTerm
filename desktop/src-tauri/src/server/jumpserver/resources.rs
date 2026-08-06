use super::*;

impl JumpServerClient {
    /// Get user assets with pagination and search. Matches Go GetUserAssets/GetNodeAssets.
    pub async fn get_assets(
        &self,
        search: &str,
        node_id: &str,
        page: u32,
        page_size: u32,
    ) -> Result<(Vec<Asset>, u32), String> {
        if !(1..=10_000).contains(&page)
            || !(1..=MAX_JUMPSERVER_ASSETS_PER_PAGE as u32).contains(&page_size)
            || !valid_display_text(search, 256)
            || (!node_id.is_empty() && !valid_resource_id(node_id))
        {
            return Err("invalid JumpServer asset query".to_string());
        }
        let offset = (page - 1)
            .checked_mul(page_size)
            .ok_or_else(|| "invalid JumpServer asset query".to_string())?;
        let mut query = format!("?offset={}&limit={}", offset, page_size);
        if !search.is_empty() {
            query.push_str(&format!("&search={}", urlencoding::encode(search)));
        }

        // Favorite is a virtual node — fetch favorite IDs then filter (matches Go getFavoriteAssets)
        if node_id == "favorite" {
            return self.get_favorite_assets(search, page, page_size).await;
        }

        let paths = if !node_id.is_empty() {
            // Node-specific: ALL paths get node_id in query (matches Go: q.Set("node_id", nodeID))
            let q = format!("{}&node_id={}", query, urlencoding::encode(node_id));
            vec![
                format!("/api/v1/perms/users/self/nodes/{}/assets/{}", node_id, q),
                format!("/api/v1/perms/users/nodes/{}/assets/{}", node_id, q),
                format!("/api/v1/perms/users/self/assets/{}", q),
            ]
        } else {
            // All assets
            vec![
                format!("/api/v1/perms/users/self/assets/{}", query),
                format!("/api/v1/perms/users/assets/{}", query),
            ]
        };
        let path_refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();

        match self.do_get_multi(&path_refs).await {
            Ok((path, data)) => {
                eprintln!(
                    "[jumpserver] get_assets response from {}: keys={:?} is_array={}",
                    path,
                    data.as_object().map(|o| o.keys().collect::<Vec<_>>()),
                    data.is_array()
                );
                if let Some(results) = data.get("results") {
                    if let Some(first) = results.as_array().and_then(|a| a.first()) {
                        eprintln!(
                            "[jumpserver] first asset keys: {:?}",
                            first.as_object().map(|o| o.keys().collect::<Vec<_>>())
                        );
                        eprintln!(
                            "[jumpserver] first asset platform: {:?}",
                            first.get("platform")
                        );
                    }
                }
                let result = parse_asset_response(data)?;
                if result.0.len() > MAX_JUMPSERVER_ASSETS_PER_PAGE {
                    return Err("JumpServer asset response exceeded the item limit".to_string());
                }
                Ok(result)
            }
            Err(e) => Err(e),
        }
    }

    /// Get node tree. Matches Go GetNodes — fetches /children/tree/ then recursively loads children.
    pub async fn get_nodes(&self) -> Result<Vec<Node>, String> {
        let paths = [
            "/api/v1/perms/users/self/nodes/children/tree/?limit=1000",
            "/api/v1/perms/users/nodes/children/tree/?limit=1000",
            "/api/v1/perms/users/self/nodes/?limit=1000",
            "/api/v1/perms/users/nodes/?limit=1000",
        ];

        match self.do_get_multi(&paths).await {
            Ok((_, data)) => {
                if let Some(arr) = data.as_array() {
                    if !arr.is_empty() {
                        let is_ztree = arr[0].get("pId").is_some()
                            || arr[0].get("title").is_some()
                            || arr[0].get("isParent").is_some();
                        if is_ztree {
                            validate_ztree_input(arr)?;
                            // Recursive fetch children (matches Go fetchTreeNodesRecursive)
                            let mut all_nodes = parse_ztree_nodes(arr);
                            let mut seen: std::collections::HashSet<String> = arr
                                .iter()
                                .filter_map(|n| {
                                    n.get("id").and_then(|v| v.as_str()).map(String::from)
                                })
                                .collect();
                            let mut remaining_nodes =
                                MAX_JUMPSERVER_NODES.saturating_sub(seen.len());
                            let mut remaining_requests = MAX_JUMPSERVER_NODE_REQUESTS;
                            let traversal_deadline =
                                tokio::time::Instant::now() + std::time::Duration::from_secs(30);

                            for item in arr {
                                let is_parent = item
                                    .get("isParent")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);
                                let tree_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                if is_parent && !tree_id.is_empty() {
                                    let children = self
                                        .fetch_child_nodes(
                                            tree_id,
                                            &mut seen,
                                            &mut remaining_nodes,
                                            &mut remaining_requests,
                                            1,
                                            traversal_deadline,
                                        )
                                        .await?;
                                    all_nodes.extend(children);
                                }
                            }
                            return validate_nodes(all_nodes);
                        }
                    }
                }
                let nodes = parse_node_response(data)?;
                if nodes.len() > MAX_JUMPSERVER_NODES {
                    return Err("JumpServer node response exceeded the item limit".to_string());
                }
                Ok(nodes)
            }
            Err(e) => Err(e),
        }
    }

    /// Fetch favorite assets. Matches Go getFavoriteAssets.
    async fn get_favorite_assets(
        &self,
        search: &str,
        page: u32,
        page_size: u32,
    ) -> Result<(Vec<Asset>, u32), String> {
        // Get favorite asset IDs
        let fav_paths = [
            "/api/v1/assets/favorite-assets/",
            "/api/v1/assets/favorites/",
        ];
        let fav_ids: Vec<String> = match self.do_get_multi(&fav_paths).await {
            Ok((_, data)) => {
                if let Some(arr) = data.as_array() {
                    if arr.len() > MAX_JUMPSERVER_NODES {
                        return Err(
                            "JumpServer favorite response exceeded the item limit".to_string()
                        );
                    }
                    let ids: Vec<String> = arr
                        .iter()
                        .filter_map(|v| v.get("asset").and_then(|a| a.as_str()).map(String::from))
                        .collect();
                    if ids.iter().any(|id| !valid_resource_id(id)) {
                        return Err("invalid JumpServer favorite response".to_string());
                    }
                    ids
                } else {
                    Vec::new()
                }
            }
            Err(_) => Vec::new(),
        };
        if fav_ids.is_empty() {
            return Ok((Vec::new(), 0));
        }

        // Fetch all assets and filter by favorite IDs (avoid recursion by calling do_get_multi directly)
        let query = format!(
            "?offset=0&limit=1000{}",
            if !search.is_empty() {
                format!("&search={}", urlencoding::encode(search))
            } else {
                String::new()
            }
        );
        let asset_paths = [
            format!("/api/v1/perms/users/self/assets/{}", query),
            format!("/api/v1/perms/users/assets/{}", query),
        ];
        let ap: Vec<&str> = asset_paths.iter().map(|s| s.as_str()).collect();
        let (all_assets, _) = match self.do_get_multi(&ap).await {
            Ok((_, data)) => parse_asset_response(data)?,
            Err(e) => return Err(e),
        };
        let fav_set: std::collections::HashSet<&str> = fav_ids.iter().map(|s| s.as_str()).collect();
        let matched: Vec<Asset> = all_assets
            .into_iter()
            .filter(|a| fav_set.contains(a.id.as_str()))
            .collect();
        let total = matched.len() as u32;
        let start = ((page - 1) as usize).saturating_mul(page_size as usize);
        let page_assets = matched
            .into_iter()
            .skip(start)
            .take(page_size as usize)
            .collect();
        Ok((page_assets, total))
    }

    /// Recursively fetch child nodes. Matches Go fetchChildNodes.
    async fn fetch_child_nodes(
        &self,
        tree_id: &str,
        seen: &mut std::collections::HashSet<String>,
        remaining_nodes: &mut usize,
        remaining_requests: &mut usize,
        depth: usize,
        deadline: tokio::time::Instant,
    ) -> Result<Vec<Node>, String> {
        if depth > MAX_JUMPSERVER_NODE_DEPTH || *remaining_requests == 0 {
            return Err("JumpServer node traversal exceeded the limit".to_string());
        }
        *remaining_requests -= 1;
        let paths = [
            format!(
                "/api/v1/perms/users/self/nodes/children/tree/?key={}",
                urlencoding::encode(tree_id)
            ),
            format!(
                "/api/v1/perms/users/nodes/children/tree/?key={}",
                urlencoding::encode(tree_id)
            ),
        ];
        let path_refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();

        let remaining_time = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining_time.is_zero() {
            return Err("JumpServer node traversal timed out".to_string());
        }
        let data = match tokio::time::timeout(remaining_time, self.do_get_multi(&path_refs)).await {
            Ok(Ok((_, data))) => data,
            Ok(Err(_)) => return Ok(Vec::new()),
            Err(_) => return Err("JumpServer node traversal timed out".to_string()),
        };

        let arr = match data.as_array() {
            Some(a) => a,
            None => return Ok(Vec::new()),
        };
        validate_ztree_input(arr)?;

        // Filter already-seen nodes
        let mut new_items: Vec<&serde_json::Value> = Vec::new();
        for item in arr {
            let id = item
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            if !id.is_empty() && seen.insert(id.to_string()) {
                if *remaining_nodes == 0 {
                    return Err("JumpServer node response exceeded the item limit".to_string());
                }
                *remaining_nodes -= 1;
                new_items.push(item);
            }
        }

        if new_items.is_empty() {
            return Ok(Vec::new());
        }

        let new_arr: Vec<serde_json::Value> = new_items.iter().map(|v| (*v).clone()).collect();
        let mut result = parse_ztree_nodes(&new_arr);

        // Recurse for children with isParent=true
        for item in &new_items {
            let is_parent = item
                .get("isParent")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if is_parent && !id.is_empty() {
                let grandchildren = Box::pin(self.fetch_child_nodes(
                    id,
                    seen,
                    remaining_nodes,
                    remaining_requests,
                    depth + 1,
                    deadline,
                ))
                .await?;
                result.extend(grandchildren);
            }
        }

        Ok(result)
    }

    /// Get accounts for an asset. Matches Go GetAssetAccounts:
    /// Strategy 1: dedicated accounts endpoints (v2/v3)
    /// Strategy 2: v4 asset detail → permed_accounts field
    pub async fn get_accounts(&self, asset_id: &str) -> Result<Vec<Account>, String> {
        if !valid_resource_id(asset_id) {
            return Err("invalid JumpServer asset id".to_string());
        }
        // Strategy 1: accounts sub-endpoints
        let paths = [
            format!("/api/v1/perms/users/self/assets/{}/accounts/", asset_id),
            format!("/api/v1/perms/users/assets/{}/system-users/", asset_id),
            format!("/api/v1/perms/users/assets/{}/accounts/", asset_id),
        ];
        let path_refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();

        if let Ok((_, data)) = self.do_get_multi(&path_refs).await {
            // Direct array
            if let Ok(accounts) = serde_json::from_value::<Vec<Account>>(data.clone()) {
                if !accounts.is_empty() {
                    return validate_accounts(accounts);
                }
            }
            // Paginated {results: [...]}
            if let Some(results) = data.get("results") {
                if let Ok(accounts) = serde_json::from_value::<Vec<Account>>(results.clone()) {
                    if !accounts.is_empty() {
                        return validate_accounts(accounts);
                    }
                }
            }
        }

        // Strategy 2: v4 asset detail → permed_accounts (matches Go getAccountsFromAssetDetail)
        eprintln!(
            "[jumpserver] accounts sub-endpoint failed, trying v4 asset detail for {}",
            asset_id
        );
        let detail_paths = [
            format!("/api/v1/perms/users/self/assets/{}/", asset_id),
            format!("/api/v1/perms/users/my/assets/{}/", asset_id),
        ];
        let dp: Vec<&str> = detail_paths.iter().map(|s| s.as_str()).collect();

        match self.do_get_multi(&dp).await {
            Ok((_, data)) => {
                eprintln!(
                    "[jumpserver] asset detail keys: {:?}",
                    data.as_object().map(|o| o.keys().collect::<Vec<_>>())
                );
                // Extract permed_accounts
                if let Some(permed) = data.get("permed_accounts").and_then(|v| v.as_array()) {
                    let accounts: Vec<Account> = permed
                        .iter()
                        .filter_map(|v| serde_json::from_value::<Account>(v.clone()).ok())
                        .collect();
                    if !accounts.is_empty() {
                        return validate_accounts(accounts);
                    }
                }
                // Try accounts field
                if let Some(accts) = data.get("accounts").and_then(|v| v.as_array()) {
                    let accounts: Vec<Account> = accts
                        .iter()
                        .filter_map(|v| serde_json::from_value::<Account>(v.clone()).ok())
                        .collect();
                    if !accounts.is_empty() {
                        return validate_accounts(accounts);
                    }
                }
                Err("no accounts found in asset detail".to_string())
            }
            Err(e) => Err(format!("asset detail failed: {}", e)),
        }
    }

    /// Create a connection token. Matches Go CreateConnectionToken exactly:
    /// tries multiple account identifiers × multiple body formats.
    pub async fn create_connection_token(
        &self,
        req: &ConnectionTokenRequest,
    ) -> Result<ConnectionToken, String> {
        if !valid_resource_id(&req.asset_id)
            || !valid_display_text(&req.account, 512)
            || !valid_display_text(&req.account_name, 512)
            || !valid_display_text(&req.account_alias, 512)
            || (!req.account_id.is_empty() && !valid_resource_id(&req.account_id))
            || (!req.protocol.is_empty() && req.protocol != "ssh")
        {
            return Err("invalid JumpServer connection request".to_string());
        }
        let protocol = if req.protocol.is_empty() {
            "ssh"
        } else {
            &req.protocol
        };

        // Collect unique account identifiers (matches Go priority order)
        let mut seen = std::collections::HashSet::new();
        let mut account_names = Vec::new();
        for name in [
            &req.account_alias,
            &req.account_name,
            &req.account,
            &req.account_id,
        ] {
            if !name.is_empty() && seen.insert(name.clone()) {
                account_names.push(name.clone());
            }
        }

        // Build request bodies: v4 (with connect_method), v3 (without), v2 (system_user)
        let mut bodies = Vec::new();
        for acct in &account_names {
            bodies.push(serde_json::json!({"asset": req.asset_id, "account": acct, "protocol": protocol, "connect_method": "web_cli"}));
        }
        for acct in &account_names {
            bodies.push(
                serde_json::json!({"asset": req.asset_id, "account": acct, "protocol": protocol}),
            );
        }
        if !req.account_id.is_empty() {
            bodies.push(serde_json::json!({"asset": req.asset_id, "system_user": req.account_id, "protocol": protocol}));
        }

        let url = format!("{}/api/v1/authentication/connection-token/", self.base_url);
        let mut last_err = String::from("no account identifiers");
        // 区分认证类失败（401/403）与其它失败：仅在「所有候选响应都是 401/403
        // 且没有任何其它失败」时才发出 SESSION_EXPIRED 信号，避免误把 5xx/网络
        // 错误/空 token 当成会话过期。
        let mut had_auth_failure = false;
        let mut had_other_failure = false;

        for body in &bodies {
            eprintln!("[jumpserver] requesting connection credential");
            match self
                .http
                .post(&url)
                .headers(self.auth_headers())
                .json(body)
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    match read_json_response(resp).await {
                        Ok(data) => {
                            eprintln!("[jumpserver] connection credential response received");
                            // Extract token from various field names (v2/v3/v4)
                            let mut id = data
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            if !id.is_empty() && !valid_resource_id(&id) {
                                id.clear();
                            }
                            let mut token = data
                                .get("token")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            if token.is_empty() {
                                token = data
                                    .get("value")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                            }
                            if token.is_empty() && !id.is_empty() {
                                token = id.clone();
                            }
                            let mut secret = data
                                .get("secret")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            if !valid_secret_value(&secret) {
                                secret.clear();
                            }

                            if valid_bearer_token(&token) {
                                return Ok(ConnectionToken { id, token, secret });
                            }
                            had_other_failure = true;
                            last_err = "empty connection token".to_string();
                        }
                        Err(e) => {
                            had_other_failure = true;
                            last_err = e.to_string();
                        }
                    }
                }
                Ok(resp) => {
                    let status = resp.status();
                    if status == reqwest::StatusCode::UNAUTHORIZED
                        || status == reqwest::StatusCode::FORBIDDEN
                    {
                        had_auth_failure = true;
                    } else {
                        had_other_failure = true;
                    }
                    eprintln!(
                        "[jumpserver] connection credential request failed: HTTP {}",
                        status
                    );
                    last_err = format!("HTTP {}", status);
                }
                Err(e) => {
                    had_other_failure = true;
                    last_err = e.to_string();
                }
            }
        }

        if had_auth_failure && !had_other_failure {
            // 所有候选 body 都是 401/403 — 会话过期，前端按此识别走 ensureJSAuthenticated。
            Err(format!("SESSION_EXPIRED: {}", self.base_url))
        } else {
            Err(format!("Failed to create connection token: {}", last_err))
        }
    }
}
