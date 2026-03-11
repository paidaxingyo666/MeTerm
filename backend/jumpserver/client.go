package jumpserver

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Client communicates with the JumpServer REST API.
type Client struct {
	baseURL    string
	httpClient *http.Client
	token      string // auth token
	keyword    string // "Bearer" or "Token" — determines Authorization header format
	orgID      string // X-JMS-ORG header
	apiV3      *bool  // nil = unknown, true = v3+, false = v2
	username   string // stored for re-auth after MFA
	password   string // stored for re-auth after MFA
	mu         sync.Mutex
}

// AuthResult is returned from authentication endpoints.
type AuthResult struct {
	Token      string   `json:"token,omitempty"`
	Keyword    string   `json:"keyword,omitempty"`    // "Bearer" or "Token"
	Expiration string   `json:"expiration,omitempty"` // ISO 8601
	MFARequired bool    `json:"mfa_required"`
	MFAChoices  []string `json:"mfa_choices,omitempty"` // ["otp", "sms"]
	Error       string   `json:"error,omitempty"`
	Msg         string   `json:"msg,omitempty"`
}

// Asset represents a JumpServer asset (host).
type Asset struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Address   string          `json:"address"`
	Platform  AssetPlatform   `json:"platform"`
	Domain    string          `json:"domain,omitempty"`
	Comment   string          `json:"comment,omitempty"`
	IsActive  bool            `json:"is_active"`
	OrgID     string          `json:"org_id,omitempty"`
	OrgName   string          `json:"org_name,omitempty"`
	Protocols []AssetProtocol `json:"protocols,omitempty"`
	Nodes     []NodeRef       `json:"nodes,omitempty"`
	Accounts  []string        `json:"accounts,omitempty"`
}

// UnmarshalJSON handles JumpServer v2/v3 field name differences:
// v2: hostname/ip, v3: name/address
func (a *Asset) UnmarshalJSON(data []byte) error {
	type plain Asset
	if err := json.Unmarshal(data, (*plain)(a)); err != nil {
		return err
	}
	// Fallback: v2 uses "hostname" instead of "name", "ip" instead of "address"
	var raw map[string]json.RawMessage
	if json.Unmarshal(data, &raw) == nil {
		if a.Name == "" {
			if v, ok := raw["hostname"]; ok {
				json.Unmarshal(v, &a.Name)
			}
		}
		if a.Address == "" {
			if v, ok := raw["ip"]; ok {
				json.Unmarshal(v, &a.Address)
			}
		}
	}
	return nil
}

// AssetPlatform is the platform info embedded in an asset.
// Supports both object format {"id":1,"name":"Linux"} and string format "Linux".
type AssetPlatform struct {
	ID   int    `json:"id"`
	Name string `json:"name"` // e.g. "Linux", "Windows"
}

// UnmarshalJSON handles both string ("Linux") and object ({"id":1,"name":"Linux"}) formats.
func (p *AssetPlatform) UnmarshalJSON(data []byte) error {
	var s string
	if json.Unmarshal(data, &s) == nil {
		p.Name = s
		return nil
	}
	type plain AssetPlatform
	return json.Unmarshal(data, (*plain)(p))
}

// AssetProtocol describes a protocol available on an asset.
// Supports both object format {"name":"ssh","port":22} and string format "ssh/22".
type AssetProtocol struct {
	ID   int    `json:"id"`
	Name string `json:"name"` // e.g. "ssh", "rdp"
	Port int    `json:"port"`
}

// UnmarshalJSON handles both string ("ssh/22") and object ({"name":"ssh","port":22}) formats.
func (p *AssetProtocol) UnmarshalJSON(data []byte) error {
	// Try string format first: "ssh/22" or "ssh"
	var s string
	if json.Unmarshal(data, &s) == nil {
		parts := strings.SplitN(s, "/", 2)
		p.Name = parts[0]
		if len(parts) > 1 {
			fmt.Sscanf(parts[1], "%d", &p.Port)
		}
		return nil
	}

	// Object format
	type plain AssetProtocol
	return json.Unmarshal(data, (*plain)(p))
}

// NodeRef is a reference to a node in the asset tree.
type NodeRef struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Value string `json:"value,omitempty"`
	Key   string `json:"key,omitempty"`
}

// Node represents a node in the JumpServer asset tree.
type Node struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Key      string `json:"key"`
	Value    string `json:"value"`
	ParentID string `json:"parent,omitempty"`
	ChildCount int  `json:"assets_amount,omitempty"`
}

// Account represents a JumpServer account (system user) for an asset.
type Account struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Username string `json:"username"`
	HasSecret bool  `json:"has_secret"`
	Privileged bool `json:"privileged"`
}

// ConnectionToken is returned when creating a connection token.
type ConnectionToken struct {
	ID     string `json:"id"`
	Token  string `json:"token"`
	Value  string `json:"value,omitempty"`  // v4 uses "value" instead of "token"
	Secret string `json:"secret,omitempty"` // v2 uses "secret" as the SSH password
}

// PageResult wraps paginated API responses.
type PageResult struct {
	Count    int             `json:"count"`
	Next     string          `json:"next,omitempty"`
	Previous string          `json:"previous,omitempty"`
	Results  json.RawMessage `json:"results"`
}

// NewClient creates a JumpServer API client.
func NewClient(baseURL string) *Client {
	jar, _ := cookiejar.New(nil)
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		orgID:   "", // empty = use server default org; override via SetOrgID
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
			Jar:     jar,
		},
	}
}

// SetToken sets the auth token for subsequent API calls.
func (c *Client) SetToken(token string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.token = token
}

// SetKeyword sets the Authorization header keyword ("Bearer" or "Token").
func (c *Client) SetKeyword(keyword string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if keyword != "" {
		c.keyword = keyword
	}
}

// SetOrgID sets the organization ID for API calls.
func (c *Client) SetOrgID(orgID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.orgID = orgID
}

// Authenticate performs username/password login.
// If MFA is required, AuthResult.MFARequired will be true and the caller
// must call SubmitMFA with the session cookies preserved in the client.
func (c *Client) Authenticate(username, password string) (*AuthResult, error) {
	// Store credentials for re-auth after MFA
	c.mu.Lock()
	c.username = username
	c.password = password
	c.mu.Unlock()

	body := map[string]string{
		"username": username,
		"password": password,
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", c.baseURL+"/api/v1/authentication/auth/", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("auth request failed: %w", err)
	}
	defer resp.Body.Close()

	respData, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	// Try to parse as various response formats
	var result AuthResult

	// Check if it's an MFA challenge response
	var rawResp map[string]interface{}
	if err := json.Unmarshal(respData, &rawResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %s", string(respData))
	}

	// MFA required response: {"error": "mfa_required", "msg": "...", "data": {"choices": [...]}}
	if errField, ok := rawResp["error"].(string); ok && errField == "mfa_required" {
		result.MFARequired = true
		result.Error = errField
		result.Msg, _ = rawResp["msg"].(string)
		if dataMap, ok := rawResp["data"].(map[string]interface{}); ok {
			if choices, ok := dataMap["choices"].([]interface{}); ok {
				for _, ch := range choices {
					if s, ok := ch.(string); ok {
						result.MFAChoices = append(result.MFAChoices, s)
					}
				}
			}
		}
		return &result, nil
	}

	// Log raw auth response for debugging
	log.Printf("[jumpserver] auth response (HTTP %d): %s", resp.StatusCode, string(respData))

	// Log cookies set by auth
	if u, parseErr := url.Parse(c.baseURL); parseErr == nil {
		cookies := c.httpClient.Jar.Cookies(u)
		names := make([]string, len(cookies))
		for i, ck := range cookies {
			names[i] = ck.Name
		}
		log.Printf("[jumpserver] cookies after auth: %v", names)
	}

	// Check for error first
	if resp.StatusCode >= 400 {
		msg := ""
		if m, ok := rawResp["msg"].(string); ok {
			msg = m
		} else if d, ok := rawResp["detail"].(string); ok {
			msg = d
		}
		if msg == "" {
			msg = string(respData)
		}
		return nil, fmt.Errorf("authentication failed (HTTP %d): %s", resp.StatusCode, msg)
	}

	// Try to extract token from various response formats:
	// Format 1: {"token": "xxx", "keyword": "Bearer"}
	// Format 2: {"data": {"token": "xxx"}, "code": 200}
	// Format 3: {"Token": "xxx"}
	if err := json.Unmarshal(respData, &result); err != nil {
		return nil, fmt.Errorf("failed to parse auth response: %s", string(respData))
	}

	// If top-level token not found, try nested "data.token"
	if result.Token == "" {
		if dataMap, ok := rawResp["data"].(map[string]interface{}); ok {
			if tk, ok := dataMap["token"].(string); ok && tk != "" {
				result.Token = tk
			}
			if kw, ok := dataMap["keyword"].(string); ok && kw != "" {
				result.Keyword = kw
			}
		}
	}

	// Try case-insensitive token field
	if result.Token == "" {
		for key, val := range rawResp {
			if strings.EqualFold(key, "token") {
				if s, ok := val.(string); ok && s != "" {
					result.Token = s
					break
				}
			}
		}
	}

	if result.Token != "" {
		c.SetToken(result.Token)
		c.SetKeyword(result.Keyword)
		log.Printf("[jumpserver] token set: keyword=%q, token=%s...", result.Keyword, result.Token[:min(16, len(result.Token))])
	} else {
		// No token — check for session cookie and use session-based auth
		c.activateSessionAuth("auth")
	}

	return &result, nil
}

// SubmitMFA submits an MFA verification code.
// The session cookies from Authenticate must still be present in the client.
func (c *Client) SubmitMFA(mfaType, code string) (*AuthResult, error) {
	body := map[string]string{
		"type": mfaType,
		"code": code,
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", c.baseURL+"/api/v1/authentication/mfa/challenge/", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("MFA request failed: %w", err)
	}
	defer resp.Body.Close()

	respData, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("failed to read MFA response: %w", err)
	}

	log.Printf("[jumpserver] MFA response (HTTP %d): %s", resp.StatusCode, string(respData))

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("MFA verification failed (HTTP %d): %s", resp.StatusCode, string(respData))
	}

	var result AuthResult
	if err := json.Unmarshal(respData, &result); err != nil {
		return nil, fmt.Errorf("failed to parse MFA response: %s", string(respData))
	}

	// Try multiple token extraction formats (same as Authenticate)
	if result.Token == "" {
		var rawResp map[string]interface{}
		_ = json.Unmarshal(respData, &rawResp)
		if rawResp != nil {
			// Try nested "data.token"
			if dataMap, ok := rawResp["data"].(map[string]interface{}); ok {
				if tk, ok := dataMap["token"].(string); ok && tk != "" {
					result.Token = tk
				}
				if kw, ok := dataMap["keyword"].(string); ok && kw != "" {
					result.Keyword = kw
				}
			}
			// Try case-insensitive
			if result.Token == "" {
				for key, val := range rawResp {
					if strings.EqualFold(key, "token") {
						if s, ok := val.(string); ok && s != "" {
							result.Token = s
							break
						}
					}
				}
			}
		}
	}

	if result.Token != "" {
		c.SetToken(result.Token)
		c.SetKeyword(result.Keyword)
		log.Printf("[jumpserver] MFA token set: keyword=%q, token=%s...", result.Keyword, result.Token[:min(16, len(result.Token))])
	} else {
		// No token in MFA response — re-auth with saved credentials
		// After MFA confirmation, the session should allow auth to return a token now
		c.mu.Lock()
		user := c.username
		pass := c.password
		c.mu.Unlock()
		if user != "" && pass != "" {
			log.Printf("[jumpserver] no token in MFA response, re-authenticating...")
			reResult, reErr := c.ReAuthenticate(user, pass)
			if reErr != nil {
				log.Printf("[jumpserver] re-auth after MFA failed: %v", reErr)
				c.activateSessionAuth("MFA-fallback")
			} else if reResult.Token != "" {
				result.Token = reResult.Token
			}
		} else {
			log.Printf("[jumpserver] no credentials stored for re-auth")
			c.activateSessionAuth("MFA-fallback")
		}
	}

	return &result, nil
}

// ReAuthenticate re-calls the auth endpoint using the EXISTING session cookies.
// After MFA confirmation, JumpServer should now return a token on re-auth
// because the MFA requirement is already satisfied in the session.
func (c *Client) ReAuthenticate(username, password string) (*AuthResult, error) {
	body := map[string]string{
		"username": username,
		"password": password,
	}
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", c.baseURL+"/api/v1/authentication/auth/", bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Referer", c.baseURL+"/")
	// Add CSRF token from session cookies
	if u, parseErr := url.Parse(c.baseURL); parseErr == nil {
		for _, cookie := range c.httpClient.Jar.Cookies(u) {
			if cookie.Name == "csrftoken" {
				req.Header.Set("X-CSRFToken", cookie.Value)
				break
			}
		}
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("re-auth request failed: %w", err)
	}
	defer resp.Body.Close()

	respData, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("failed to read re-auth response: %w", err)
	}

	log.Printf("[jumpserver] re-auth response (HTTP %d): %s", resp.StatusCode, string(respData))

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("re-auth failed (HTTP %d): %s", resp.StatusCode, string(respData))
	}

	var result AuthResult
	_ = json.Unmarshal(respData, &result)

	// Try to extract token
	var rawResp map[string]interface{}
	_ = json.Unmarshal(respData, &rawResp)

	if result.Token == "" && rawResp != nil {
		if dataMap, ok := rawResp["data"].(map[string]interface{}); ok {
			if tk, ok := dataMap["token"].(string); ok && tk != "" {
				result.Token = tk
			}
			if kw, ok := dataMap["keyword"].(string); ok && kw != "" {
				result.Keyword = kw
			}
		}
	}

	if result.Token != "" {
		c.SetToken(result.Token)
		c.SetKeyword(result.Keyword)
		log.Printf("[jumpserver] re-auth token set: keyword=%q, token=%s...", result.Keyword, result.Token[:min(16, len(result.Token))])
	} else {
		// Still no token — check if session cookie auth works
		c.activateSessionAuth("re-auth")
	}

	return &result, nil
}

// activateSessionAuth checks the cookie jar for session cookies and activates session-based auth.
func (c *Client) activateSessionAuth(source string) {
	if u, err := url.Parse(c.baseURL); err == nil {
		cookies := c.httpClient.Jar.Cookies(u)
		names := make([]string, len(cookies))
		hasSession := false
		for i, ck := range cookies {
			names[i] = ck.Name
			if ck.Name == "sessionid" || ck.Name == "jms_sessionid" {
				hasSession = true
			}
		}
		log.Printf("[jumpserver] cookies after %s: %v", source, names)
		if hasSession {
			log.Printf("[jumpserver] no token after %s, using session cookie for auth", source)
			c.mu.Lock()
			c.keyword = "__session__"
			c.token = ""
			c.mu.Unlock()
		} else {
			log.Printf("[jumpserver] WARNING: no token and no session cookie after %s", source)
		}
	}
}

// setAuthHeaders adds authentication, CSRF, and organization headers to a request.
func (c *Client) setAuthHeaders(req *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	// DRF requires Accept header to properly handle API authentication
	req.Header.Set("Accept", "application/json")
	if c.token != "" {
		kw := c.keyword
		if kw == "" {
			kw = "Bearer"
		}
		req.Header.Set("Authorization", kw+" "+c.token)
	}
	// keyword == "__session__" means using cookie-based auth — no Authorization header
	// The http.Client cookie jar will automatically send session cookies
	if c.orgID != "" {
		req.Header.Set("X-JMS-ORG", c.orgID)
	}
	// JumpServer uses Django CSRF — extract csrftoken cookie and send as header
	if u, err := url.Parse(c.baseURL); err == nil {
		for _, cookie := range c.httpClient.Jar.Cookies(u) {
			if cookie.Name == "csrftoken" {
				req.Header.Set("X-CSRFToken", cookie.Value)
				break
			}
		}
	}
	// Always set Referer for CSRF validation
	req.Header.Set("Referer", c.baseURL+"/")
}

// isSessionAuth returns true when using cookie-based session authentication.
func (c *Client) isSessionAuth() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.keyword == "__session__"
}

// doGetMulti tries multiple paths in order, returning the first successful result.
// On 404, tries the next path. On 401, retries without Authorization header (cookie-only auth for v2).
// If all fail, returns an error listing all attempted paths.
func (c *Client) doGetMulti(paths []string, query url.Values) ([]byte, error) {
	var lastErr error
	var tried []string

	// If using session-cookie auth, skip token-based doGet and go straight to cookie-only
	sessionAuth := c.isSessionAuth()

	for _, path := range paths {
		if sessionAuth {
			// Session-cookie mode: only use cookie-based requests
			data, err := c.doGetCookieOnly(path, query)
			if err == nil {
				return data, nil
			}
			tried = append(tried, path)
			lastErr = err
			if strings.Contains(err.Error(), "HTTP 404") {
				continue
			}
			continue // try next path for 401/403 too
		}

		data, err := c.doGet(path, query)
		if err == nil {
			return data, nil
		}
		tried = append(tried, path)
		lastErr = err
		if strings.Contains(err.Error(), "HTTP 404") {
			continue // try next path
		}
		if strings.Contains(err.Error(), "HTTP 401") || strings.Contains(err.Error(), "HTTP 403") {
			// Token auth rejected — retry same path with cookie-only auth
			data2, err2 := c.doGetCookieOnly(path, query)
			if err2 == nil {
				return data2, nil
			}
			lastErr = err2
			continue // try next path
		}
		return nil, err // other errors — don't retry
	}
	return nil, fmt.Errorf("all API paths failed (tried: %s): %w", strings.Join(tried, ", "), lastErr)
}

// doGetCookieOnly performs a GET request using only cookies (no Authorization header).
// JumpServer v2 uses session-based auth via Django cookies.
func (c *Client) doGetCookieOnly(path string, query url.Values) ([]byte, error) {
	u := c.baseURL + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}

	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}
	// Only set CSRF, org, and referer — no Authorization header
	req.Header.Set("Accept", "application/json")
	c.mu.Lock()
	if c.orgID != "" {
		req.Header.Set("X-JMS-ORG", c.orgID)
	}
	c.mu.Unlock()
	if pu, err := url.Parse(c.baseURL); err == nil {
		for _, cookie := range c.httpClient.Jar.Cookies(pu) {
			if cookie.Name == "csrftoken" {
				req.Header.Set("X-CSRFToken", cookie.Value)
				break
			}
		}
	}
	req.Header.Set("Referer", c.baseURL+"/")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 400 {
		// Log cookies being sent for debugging
		cookieNames := []string{}
		if pu, parseErr := url.Parse(u); parseErr == nil {
			for _, ck := range c.httpClient.Jar.Cookies(pu) {
				cookieNames = append(cookieNames, ck.Name)
			}
		}
		log.Printf("[jumpserver] GET %s (cookie-only) → HTTP %d, cookies=%v", u, resp.StatusCode, cookieNames)
		return nil, fmt.Errorf("API error (HTTP %d): %s", resp.StatusCode, string(data))
	}

	log.Printf("[jumpserver] GET %s (cookie-only) → HTTP %d (%d bytes)", u, resp.StatusCode, len(data))
	return data, nil
}

// doGet performs an authenticated GET request.
func (c *Client) doGet(path string, query url.Values) ([]byte, error) {
	u := c.baseURL + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}

	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}
	c.setAuthHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 400 {
		authHdr := req.Header.Get("Authorization")
		if len(authHdr) > 20 {
			authHdr = authHdr[:20] + "..."
		}
		log.Printf("[jumpserver] GET %s → HTTP %d (auth=%q)", u, resp.StatusCode, authHdr)
		return nil, fmt.Errorf("API error (HTTP %d): %s", resp.StatusCode, string(data))
	}

	log.Printf("[jumpserver] GET %s → HTTP %d (%d bytes)", u, resp.StatusCode, len(data))
	return data, nil
}

// doPost performs an authenticated POST request.
func (c *Client) doPost(path string, body interface{}) ([]byte, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", c.baseURL+path, bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	c.setAuthHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respData, err := io.ReadAll(io.LimitReader(resp.Body, 10<<20))
	if err != nil {
		return nil, err
	}

	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("API error (HTTP %d): %s", resp.StatusCode, string(respData))
	}

	return respData, nil
}

// logDebugAssets logs the first asset's name/address for debugging field mapping.
func logDebugAssets(assets []Asset) {
	if len(assets) > 0 {
		a := assets[0]
		log.Printf("[jumpserver] first asset: id=%s name=%q address=%q platform=%q", a.ID, a.Name, a.Address, a.Platform.Name)
	}
}

// GetUserAssets returns assets the authenticated user has permission to access.
func (c *Client) GetUserAssets(search string, page, pageSize int) ([]Asset, int, error) {
	q := url.Values{}
	if search != "" {
		q.Set("search", search)
	}
	if page > 0 {
		q.Set("offset", fmt.Sprintf("%d", (page-1)*pageSize))
	}
	if pageSize > 0 {
		q.Set("limit", fmt.Sprintf("%d", pageSize))
	}

	data, err := c.doGetMulti([]string{
		"/api/v1/perms/users/self/assets/",
		"/api/v1/perms/users/assets/",
		"/api/v1/assets/assets/",
	}, q)
	if err != nil {
		return nil, 0, err
	}

	var page_ PageResult
	if err := json.Unmarshal(data, &page_); err != nil {
		// Try as direct array (some JumpServer versions)
		var assets []Asset
		if err2 := json.Unmarshal(data, &assets); err2 != nil {
			return nil, 0, fmt.Errorf("failed to parse assets: %w", err)
		}
		logDebugAssets(assets)
		return assets, len(assets), nil
	}

	var assets []Asset
	if err := json.Unmarshal(page_.Results, &assets); err != nil {
		// Log first raw item for debugging field format
		var rawItems []json.RawMessage
		if json.Unmarshal(page_.Results, &rawItems) == nil && len(rawItems) > 0 {
			log.Printf("[jumpserver] first raw asset: %s", string(rawItems[0]))
		}
		return nil, 0, fmt.Errorf("failed to parse asset results: %w", err)
	}
	logDebugAssets(assets)

	return assets, page_.Count, nil
}

// GetNodes returns the asset node tree.
// Prioritizes /children/tree/ endpoints which return the full flattened tree,
// falling back to top-level-only endpoints.
func (c *Client) GetNodes() ([]Node, error) {
	q := url.Values{}
	q.Set("limit", "1000") // Ensure we get all nodes, not just first page
	data, err := c.doGetMulti([]string{
		"/api/v1/perms/users/nodes/children/tree/",
		"/api/v1/perms/users/self/nodes/children/tree/",
		"/api/v1/perms/users/self/nodes/",
		"/api/v1/perms/users/nodes/",
	}, q)
	if err != nil {
		return nil, err
	}

	// Debug: log raw response for diagnosis
	logLen := len(data)
	if logLen > 500 {
		logLen = 500
	}
	log.Printf("[jumpserver] GetNodes raw response (%d bytes): %s", len(data), string(data[:logLen]))

	// The /children/tree/ endpoints return a zTree-compatible format:
	// { id, name, title, pId, isParent, meta: { data: { id, key, value }, type: "node" } }
	// The root call returns only top-level nodes; children are loaded by passing ?id=<treeId>
	allNodes, err := c.fetchTreeNodesRecursive(data)
	if err == nil && len(allNodes) > 0 {
		log.Printf("[jumpserver] GetNodes: parsed %d tree nodes (with children)", len(allNodes))
		return allNodes, nil
	}

	// Standard Node format (from /self/nodes/ etc.)
	var nodes []Node
	if err := json.Unmarshal(data, &nodes); err == nil && len(nodes) > 0 && nodes[0].ID != "" {
		log.Printf("[jumpserver] GetNodes: parsed %d standard nodes", len(nodes))
		return nodes, nil
	}

	// Try paginated format
	var page_ PageResult
	if err2 := json.Unmarshal(data, &page_); err2 == nil {
		if err := json.Unmarshal(page_.Results, &nodes); err == nil {
			log.Printf("[jumpserver] GetNodes: parsed %d paginated nodes", len(nodes))
			return nodes, nil
		}
	}

	log.Printf("[jumpserver] GetNodes: failed to parse response (first 200 bytes): %s", string(data[:min(len(data), 200)]))
	return nil, fmt.Errorf("failed to parse nodes response")
}

// zTreeNode represents a single node in the JumpServer zTree response format.
type zTreeNode struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Title    string `json:"title"`
	PID      string `json:"pId"`
	IsParent bool   `json:"isParent"`
	Meta     struct {
		Data struct {
			ID    string `json:"id"`
			Key   string `json:"key"`
			Value string `json:"value"`
		} `json:"data"`
		Type string `json:"type"`
	} `json:"meta"`
}

// parseZTreeNodes converts raw zTree nodes into our Node structs.
// Uses meta.data.id (UUID) as Node.ID for asset queries.
func parseZTreeNodes(treeNodes []zTreeNode) []Node {
	nodes := make([]Node, 0, len(treeNodes))
	for _, tn := range treeNodes {
		name := tn.Name
		if name == "" {
			name = tn.Title
		}
		// Extract assets_amount from title format "NodeName (N)"
		assetsAmount := 0
		if tn.Title != "" {
			if idx := strings.LastIndex(tn.Title, " ("); idx >= 0 {
				numStr := strings.TrimRight(tn.Title[idx+2:], ")")
				if n, err := strconv.Atoi(numStr); err == nil {
					assetsAmount = n
					if name == tn.Title {
						name = tn.Title[:idx]
					}
				}
			}
		}
		// Use meta.data.id (UUID) as Node.ID for asset API queries
		nodeID := tn.Meta.Data.ID
		if nodeID == "" {
			nodeID = tn.ID // fallback
		}
		nodes = append(nodes, Node{
			ID:         nodeID,
			Name:       name,
			Key:        tn.Meta.Data.Key,
			Value:      tn.Meta.Data.Value,
			ParentID:   tn.PID,
			ChildCount: assetsAmount,
		})
	}
	return nodes
}

// fetchTreeNodesRecursive parses root zTree data and recursively fetches children.
// Uses a seen set to prevent infinite loops (some endpoints return siblings/parents).
func (c *Client) fetchTreeNodesRecursive(rootData []byte) ([]Node, error) {
	var rootNodes []zTreeNode
	if err := json.Unmarshal(rootData, &rootNodes); err != nil {
		return nil, err
	}
	if len(rootNodes) == 0 {
		return nil, fmt.Errorf("empty tree response")
	}

	// Detect tree format
	isTreeFormat := false
	for _, tn := range rootNodes {
		if tn.PID != "" || tn.Meta.Data.Key != "" || tn.Title != "" || tn.IsParent {
			isTreeFormat = true
			break
		}
	}
	if !isTreeFormat {
		return nil, fmt.Errorf("not a tree format response")
	}

	// Track seen tree IDs to prevent infinite recursion
	seen := make(map[string]bool)
	for _, tn := range rootNodes {
		seen[tn.ID] = true
	}

	allNodes := parseZTreeNodes(rootNodes)
	log.Printf("[jumpserver] root tree: %d nodes", len(rootNodes))

	// Recursively fetch children for nodes with isParent=true
	for _, tn := range rootNodes {
		if tn.IsParent {
			children := c.fetchChildNodes(tn.ID, seen)
			allNodes = append(allNodes, children...)
		}
	}

	return allNodes, nil
}

// fetchChildNodes fetches child nodes for a given tree node ID, recursively.
// The seen map prevents visiting the same node twice.
func (c *Client) fetchChildNodes(treeID string, seen map[string]bool) []Node {
	q := url.Values{}
	// JumpServer zTree uses autoParam: ['id=key'], so the backend expects ?key=<value>
	q.Set("key", treeID)

	data, err := c.doGetMulti([]string{
		"/api/v1/perms/users/nodes/children/tree/",
		"/api/v1/perms/users/self/nodes/children/tree/",
	}, q)
	if err != nil {
		log.Printf("[jumpserver] failed to fetch children for %q: %v", treeID, err)
		return nil
	}

	var childNodes []zTreeNode
	if err := json.Unmarshal(data, &childNodes); err != nil {
		return nil
	}

	// Filter out already-seen nodes to prevent cycles
	var newNodes []zTreeNode
	for _, cn := range childNodes {
		if !seen[cn.ID] {
			seen[cn.ID] = true
			newNodes = append(newNodes, cn)
		}
	}

	if len(newNodes) == 0 {
		return nil
	}

	log.Printf("[jumpserver] node %q: %d new children (filtered from %d)", treeID, len(newNodes), len(childNodes))

	result := parseZTreeNodes(newNodes)

	// Recurse for any new children that also have children
	for _, cn := range newNodes {
		if cn.IsParent {
			grandChildren := c.fetchChildNodes(cn.ID, seen)
			result = append(result, grandChildren...)
		}
	}

	return result
}

// parseAssetsResponse parses a paginated or direct array assets response.
func (c *Client) parseAssetsResponse(data []byte) ([]Asset, int, error) {
	var page_ PageResult
	if err := json.Unmarshal(data, &page_); err != nil {
		var assets []Asset
		if err2 := json.Unmarshal(data, &assets); err2 != nil {
			return nil, 0, fmt.Errorf("failed to parse assets: %w", err)
		}
		logDebugAssets(assets)
		return assets, len(assets), nil
	}

	var assets []Asset
	if err := json.Unmarshal(page_.Results, &assets); err != nil {
		var rawItems []json.RawMessage
		if json.Unmarshal(page_.Results, &rawItems) == nil && len(rawItems) > 0 {
			log.Printf("[jumpserver] first raw asset: %s", string(rawItems[0]))
		}
		return nil, 0, fmt.Errorf("failed to parse asset results: %w", err)
	}
	logDebugAssets(assets)
	return assets, page_.Count, nil
}

// getFavoriteAssets fetches favorite asset IDs then loads full asset details.
func (c *Client) getFavoriteAssets(q url.Values) ([]Asset, int, error) {
	favData, err := c.doGetMulti([]string{
		"/api/v1/assets/favorite-assets/",
		"/api/v1/assets/favorites/",
	}, nil)
	if err != nil {
		log.Printf("[jumpserver] favorites API failed: %v, returning empty", err)
		return nil, 0, nil
	}

	// Response is [{ "user": "uuid", "asset": "uuid" }, ...]
	var favRecords []struct {
		Asset string `json:"asset"`
	}
	if err := json.Unmarshal(favData, &favRecords); err != nil {
		log.Printf("[jumpserver] failed to parse favorites: %v", err)
		return nil, 0, nil
	}

	if len(favRecords) == 0 {
		return nil, 0, nil
	}

	// Fetch all user assets and filter by favorite IDs
	favIDs := make(map[string]bool, len(favRecords))
	for _, f := range favRecords {
		favIDs[f.Asset] = true
	}
	log.Printf("[jumpserver] favorite asset IDs: %d", len(favIDs))

	allQ := url.Values{}
	allQ.Set("limit", "1000")
	if s := q.Get("search"); s != "" {
		allQ.Set("search", s)
	}
	allAssets, _, err := c.GetUserAssets(allQ.Get("search"), 1, 1000)
	if err != nil {
		return nil, 0, err
	}

	var matched []Asset
	for _, a := range allAssets {
		if favIDs[a.ID] {
			matched = append(matched, a)
		}
	}

	return matched, len(matched), nil
}

// GetNodeAssets returns assets under a specific node.
func (c *Client) GetNodeAssets(nodeID, search string, page, pageSize int) ([]Asset, int, error) {
	q := url.Values{}
	if search != "" {
		q.Set("search", search)
	}
	if page > 0 {
		q.Set("offset", fmt.Sprintf("%d", (page-1)*pageSize))
	}
	if pageSize > 0 {
		q.Set("limit", fmt.Sprintf("%d", pageSize))
	}

	// "favorite" is a virtual node — favorite-assets API returns { user, asset } records,
	// not full Asset objects. We extract asset IDs and fetch details separately.
	if nodeID == "favorite" {
		return c.getFavoriteAssets(q)
	}

	// For real nodes, use path-based endpoint (most reliable) with node_id fallback
	q.Set("node_id", nodeID)
	data, err := c.doGetMulti([]string{
		fmt.Sprintf("/api/v1/perms/users/self/nodes/%s/assets/", nodeID),
		fmt.Sprintf("/api/v1/perms/users/nodes/%s/assets/", nodeID),
		"/api/v1/perms/users/self/assets/",
		"/api/v1/perms/users/assets/",
	}, q)
	if err != nil {
		return nil, 0, err
	}

	return c.parseAssetsResponse(data)
}

// GetAssetAccounts returns accounts (system users) available for a specific asset.
func (c *Client) GetAssetAccounts(assetID string) ([]Account, error) {
	data, err := c.doGetMulti([]string{
		fmt.Sprintf("/api/v1/perms/users/self/assets/%s/accounts/", assetID),
		fmt.Sprintf("/api/v1/perms/users/assets/%s/system-users/", assetID),
		fmt.Sprintf("/api/v1/perms/users/assets/%s/accounts/", assetID),
	}, nil)
	if err != nil {
		return nil, err
	}

	var accounts []Account
	if err := json.Unmarshal(data, &accounts); err != nil {
		return nil, fmt.Errorf("failed to parse accounts: %w", err)
	}

	return accounts, nil
}

// CreateConnectionToken creates a temporary token for connecting to an asset.
// This token can be used with Koko's WebSocket endpoint.
func (c *Client) CreateConnectionToken(assetID, accountName, accountID, protocol string) (*ConnectionToken, error) {
	if protocol == "" {
		protocol = "ssh"
	}

	// Try multiple body formats for different JumpServer versions
	// v3+: { "asset": UUID, "account": "username", "protocol": "ssh" }
	// v2:  { "asset": UUID, "system_user": UUID, "protocol": "ssh" }
	bodies := []map[string]interface{}{
		{"asset": assetID, "account": accountName, "protocol": protocol},
	}
	if accountID != "" {
		// v2 format uses system_user ID
		bodies = append(bodies, map[string]interface{}{
			"asset": assetID, "system_user": accountID, "protocol": protocol,
		})
	}

	var lastErr error
	for _, body := range bodies {
		log.Printf("[jumpserver] creating connection token: %v", body)
		data, err := c.doPost("/api/v1/authentication/connection-token/", body)
		if err != nil {
			log.Printf("[jumpserver] connection token failed: %v", err)
			lastErr = err
			continue
		}

		log.Printf("[jumpserver] connection token raw response: %s", string(data))

		var ct ConnectionToken
		if err := json.Unmarshal(data, &ct); err != nil {
			lastErr = fmt.Errorf("failed to parse connection token: %w", err)
			continue
		}

		// Different JumpServer versions use different field names:
		// v2: "id" is the token value itself
		// v3: "token" field
		// v4: "value" field
		if ct.Token == "" && ct.Value != "" {
			ct.Token = ct.Value
		}
		if ct.Token == "" && ct.ID != "" {
			ct.Token = ct.ID
		}

		if ct.Token != "" {
			log.Printf("[jumpserver] connection token created: id=%s tokenLen=%d", ct.ID, len(ct.Token))
			return &ct, nil
		}
		lastErr = fmt.Errorf("empty connection token response")
	}

	return nil, lastErr
}

// TestConnection validates that the client can reach the JumpServer API.
func (c *Client) TestConnection() error {
	req, err := http.NewRequest("GET", c.baseURL+"/api/health/", nil)
	if err != nil {
		return err
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("connection failed: %w", err)
	}
	defer resp.Body.Close()

	// JumpServer returns 200 on health check
	if resp.StatusCode >= 500 {
		return fmt.Errorf("server error (HTTP %d)", resp.StatusCode)
	}

	return nil
}
