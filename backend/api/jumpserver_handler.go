package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/paidaxingyo666/meterm/jumpserver"
)

// jumpserverClients stores JumpServer clients keyed by base URL.
// Each client maintains its own session cookies for MFA flow.
var (
	jsClients   = make(map[string]*jumpserver.Client)
	jsClientsMu sync.Mutex
)

// normalizeBaseURL trims trailing slashes to ensure consistent map keys.
func normalizeBaseURL(u string) string {
	return strings.TrimRight(u, "/")
}

// getJSClient returns or creates a JumpServer client for the given base URL.
func getJSClient(baseURL string) *jumpserver.Client {
	key := normalizeBaseURL(baseURL)
	jsClientsMu.Lock()
	defer jsClientsMu.Unlock()
	if c, ok := jsClients[key]; ok {
		return c
	}
	c := jumpserver.NewClient(key)
	jsClients[key] = c
	return c
}

// resetJSClient removes a cached client (e.g., on logout or token change).
func resetJSClient(baseURL string) {
	key := normalizeBaseURL(baseURL)
	jsClientsMu.Lock()
	defer jsClientsMu.Unlock()
	delete(jsClients, key)
}

// handleJumpServerAuth handles POST /api/jumpserver/auth
// Request: { "base_url": "https://js.example.com", "username": "admin", "password": "xxx" }
// Response: { "token": "xxx", "mfa_required": false } or { "mfa_required": true, "mfa_choices": ["otp"] }
func handleJumpServerAuth() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req struct {
			BaseURL  string `json:"base_url"`
			Username string `json:"username"`
			Password string `json:"password"`
			OrgID    string `json:"org_id,omitempty"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}

		if req.BaseURL == "" || req.Username == "" {
			http.Error(w, "base_url and username are required", http.StatusBadRequest)
			return
		}

		// Reset client for fresh session (new cookies)
		resetJSClient(req.BaseURL)
		client := getJSClient(req.BaseURL)
		if req.OrgID != "" {
			client.SetOrgID(req.OrgID)
		}

		result, err := client.Authenticate(req.Username, req.Password)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK) // Return 200 with error in body for frontend handling
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok":    false,
				"error": err.Error(),
			})
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":           true,
			"token":        result.Token,
			"mfa_required": result.MFARequired,
			"mfa_choices":  result.MFAChoices,
			"expiration":   result.Expiration,
		})
	}
}

// handleJumpServerMFA handles POST /api/jumpserver/mfa
// Request: { "base_url": "https://js.example.com", "type": "otp", "code": "123456" }
func handleJumpServerMFA() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req struct {
			BaseURL string `json:"base_url"`
			Type    string `json:"type"` // "otp", "sms"
			Code    string `json:"code"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1024)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}

		client := getJSClient(req.BaseURL)
		result, err := client.SubmitMFA(req.Type, req.Code)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok":    false,
				"error": err.Error(),
			})
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":         true,
			"token":      result.Token,
			"expiration": result.Expiration,
		})
	}
}

// handleJumpServerTokenAuth handles POST /api/jumpserver/token-auth
// For direct token authentication (Private Token or Access Key).
// Request: { "base_url": "https://js.example.com", "token": "xxx" }
func handleJumpServerTokenAuth() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req struct {
			BaseURL string `json:"base_url"`
			Token   string `json:"token"`
			OrgID   string `json:"org_id,omitempty"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 2048)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}

		client := getJSClient(req.BaseURL)
		client.SetToken(req.Token)
		// Private Token uses "Token" keyword; try it first, then "Bearer"
		client.SetKeyword("Token")
		if req.OrgID != "" {
			client.SetOrgID(req.OrgID)
		}

		// Validate by fetching assets
		_, _, err := client.GetUserAssets("", 1, 1)
		if err != nil {
			// Retry with Bearer keyword
			client.SetKeyword("Bearer")
			_, _, err = client.GetUserAssets("", 1, 1)
		}
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok":    false,
				"error": "Token validation failed: " + err.Error(),
			})
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
		})
	}
}

// handleJumpServerAssets handles GET /api/jumpserver/assets
// Query params: base_url, search, node_id, page, page_size
func handleJumpServerAssets() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		q := r.URL.Query()
		baseURL := q.Get("base_url")
		if baseURL == "" {
			http.Error(w, "base_url is required", http.StatusBadRequest)
			return
		}

		search := q.Get("search")
		nodeID := q.Get("node_id")
		page, _ := strconv.Atoi(q.Get("page"))
		pageSize, _ := strconv.Atoi(q.Get("page_size"))
		if page <= 0 {
			page = 1
		}
		if pageSize <= 0 {
			pageSize = 50
		}

		client := getJSClient(baseURL)

		var assets []jumpserver.Asset
		var total int
		var err error

		if nodeID != "" {
			log.Printf("[jumpserver-handler] GetNodeAssets: nodeID=%s search=%q page=%d", nodeID, search, page)
			assets, total, err = client.GetNodeAssets(nodeID, search, page, pageSize)
		} else {
			assets, total, err = client.GetUserAssets(search, page, pageSize)
		}

		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok":    false,
				"error": err.Error(),
			})
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":     true,
			"assets": assets,
			"total":  total,
			"page":   page,
		})
	}
}

// handleJumpServerNodes handles GET /api/jumpserver/nodes
// Query params: base_url
func handleJumpServerNodes() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		baseURL := r.URL.Query().Get("base_url")
		if baseURL == "" {
			http.Error(w, "base_url is required", http.StatusBadRequest)
			return
		}

		client := getJSClient(baseURL)
		nodes, err := client.GetNodes()
		if err != nil {
			log.Printf("[jumpserver-handler] GetNodes error: %v", err)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok":    false,
				"error": err.Error(),
			})
			return
		}

		// Debug: log node details
		for i, n := range nodes {
			if i < 20 {
				log.Printf("[jumpserver-handler] node[%d]: id=%s key=%q name=%q parent=%q assets=%d",
					i, n.ID, n.Key, n.Name, n.ParentID, n.ChildCount)
			}
		}
		log.Printf("[jumpserver-handler] GetNodes: returning %d nodes total", len(nodes))

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":    true,
			"nodes": nodes,
		})
	}
}

// handleJumpServerAccounts handles GET /api/jumpserver/accounts
// Query params: base_url, asset_id
func handleJumpServerAccounts() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		q := r.URL.Query()
		baseURL := q.Get("base_url")
		assetID := q.Get("asset_id")
		if baseURL == "" || assetID == "" {
			http.Error(w, "base_url and asset_id are required", http.StatusBadRequest)
			return
		}

		client := getJSClient(baseURL)
		accounts, err := client.GetAssetAccounts(assetID)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok":    false,
				"error": err.Error(),
			})
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":       true,
			"accounts": accounts,
		})
	}
}

// handleJumpServerConnectionToken handles POST /api/jumpserver/connection-token
// Request: { "base_url": "...", "asset_id": "...", "account": "...", "protocol": "ssh" }
func handleJumpServerConnectionToken() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req struct {
			BaseURL   string `json:"base_url"`
			AssetID   string `json:"asset_id"`
			Account   string `json:"account"`
			AccountID string `json:"account_id"`
			Protocol  string `json:"protocol"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 2048)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}

		if req.BaseURL == "" || req.AssetID == "" || (req.Account == "" && req.AccountID == "") {
			http.Error(w, "base_url, asset_id, and account are required", http.StatusBadRequest)
			return
		}

		client := getJSClient(req.BaseURL)
		ct, err := client.CreateConnectionToken(req.AssetID, req.Account, req.AccountID, req.Protocol)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok":    false,
				"error": err.Error(),
			})
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":     true,
			"id":     ct.ID,
			"token":  ct.Token,
			"secret": ct.Secret,
		})
	}
}

// handleJumpServerTest handles POST /api/jumpserver/test
// Tests connectivity to a JumpServer instance.
// Request: { "base_url": "https://js.example.com" }
func handleJumpServerTest() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req struct {
			BaseURL string `json:"base_url"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1024)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}

		client := jumpserver.NewClient(req.BaseURL)
		err := client.TestConnection()

		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok":    false,
				"error": err.Error(),
			})
		} else {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok": true,
			})
		}
	}
}

// RegisterJumpServerRoutes registers all JumpServer proxy API routes.
func RegisterJumpServerRoutes(mux *http.ServeMux, auth *Authenticator) {
	mux.Handle("/api/jumpserver/auth", auth.Middleware(handleJumpServerAuth()))
	mux.Handle("/api/jumpserver/mfa", auth.Middleware(handleJumpServerMFA()))
	mux.Handle("/api/jumpserver/token-auth", auth.Middleware(handleJumpServerTokenAuth()))
	mux.Handle("/api/jumpserver/assets", auth.Middleware(handleJumpServerAssets()))
	mux.Handle("/api/jumpserver/nodes", auth.Middleware(handleJumpServerNodes()))
	mux.Handle("/api/jumpserver/accounts", auth.Middleware(handleJumpServerAccounts()))
	mux.Handle("/api/jumpserver/connection-token", auth.Middleware(handleJumpServerConnectionToken()))
	mux.Handle("/api/jumpserver/test", auth.Middleware(handleJumpServerTest()))
}
