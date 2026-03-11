package api

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync/atomic"

	"github.com/paidaxingyo666/meterm/executor"
	"github.com/paidaxingyo666/meterm/session"
	"github.com/paidaxingyo666/meterm/terminal"
	"github.com/paidaxingyo666/meterm/web"
)

var verboseMode atomic.Bool

// SetVerbose enables or disables debug logging.
func SetVerbose(v bool) {
	verboseMode.Store(v)
}

// debugLog prints a log message only when verbose mode is enabled.
func debugLog(format string, args ...interface{}) {
	if verboseMode.Load() {
		log.Printf(format, args...)
	}
}

// GenerateToken creates a cryptographically random URL-safe token.
func GenerateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// sshHostKeyErrorResponse checks if err is a host key verification error
// and returns a structured JSON response for the frontend to handle.
func sshHostKeyErrorResponse(err error) (map[string]interface{}, bool) {
	var unknownErr *terminal.HostKeyUnknownError
	if errors.As(err, &unknownErr) {
		return map[string]interface{}{
			"error":       "host_key_unknown",
			"hostname":    unknownErr.Hostname,
			"fingerprint": unknownErr.Fingerprint,
			"key_type":    unknownErr.KeyType,
			"message":     unknownErr.Error(),
		}, true
	}

	var mismatchErr *terminal.HostKeyMismatchError
	if errors.As(err, &mismatchErr) {
		return map[string]interface{}{
			"error":       "host_key_mismatch",
			"hostname":    mismatchErr.Hostname,
			"fingerprint": mismatchErr.Fingerprint,
			"key_type":    mismatchErr.KeyType,
			"message":     mismatchErr.Error(),
		}, true
	}

	return nil, false
}

// pairingManagerInstance is set during route registration for use by WebSocket handlers.
var pairingManagerInstance *PairingManager

func RegisterRoutes(mux *http.ServeMux, sm *session.SessionManager, auth *Authenticator, bm *BanManager, port int) {
	// Pairing endpoints (no authentication required)
	pm := NewPairingManager(auth, sm, bm)
	pairingManagerInstance = pm

	// Discovery (mDNS)
	dm := NewDiscoveryManager(port)

	// pairingCORS applies CORS headers for pairing endpoints, reusing the trusted origin list.
	pairingCORS := func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && isAllowedOrigin(origin, r.Host) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
	}

	mux.HandleFunc("/api/pair", func(w http.ResponseWriter, r *http.Request) {
		pairingCORS(w, r)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		pm.HandlePairCreate(w, r)
	})

	mux.HandleFunc("/api/pair/", func(w http.ResponseWriter, r *http.Request) {
		pairingCORS(w, r)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		subPath := strings.TrimPrefix(r.URL.Path, "/api/pair/")

		// GET /api/pair/pending — requires auth
		if subPath == "pending" {
			auth.Middleware(http.HandlerFunc(pm.HandlePendingList)).ServeHTTP(w, r)
			return
		}

		// POST /api/pair/{id}/respond — requires auth
		if strings.HasSuffix(subPath, "/respond") {
			pairID := strings.TrimSuffix(subPath, "/respond")
			if pairID == "" {
				http.Error(w, "Missing pair ID", http.StatusBadRequest)
				return
			}
			auth.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				pm.HandlePairRespond(w, r, pairID)
			})).ServeHTTP(w, r)
			return
		}

		// GET /api/pair/{id}?secret=xxx — no auth (creator polls)
		pm.HandlePairStatus(w, r)
	})

	// /api/ping — no auth, anyone can verify this instance
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) {
		pairingCORS(w, r)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		dm.HandlePing(w, r)
	})

	// /api/discover — requires auth, local client scans LAN
	mux.Handle("/api/discover", auth.Middleware(http.HandlerFunc(dm.HandleDiscover)))

	// /api/discoverable — requires auth, toggle discoverability
	mux.Handle("/api/discoverable", auth.Middleware(http.HandlerFunc(dm.HandleDiscoverableToggle)))

	mux.Handle("/api/sessions", auth.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			handleCreateSession(sm)(w, r)
		case http.MethodGet:
			handleListSessions(sm)(w, r)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})))

	mux.Handle("/api/sessions/", auth.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
		parts := strings.Split(path, "/")

		// SSH session creation: /api/sessions/ssh
		if len(parts) == 1 && parts[0] == "ssh" {
			if r.Method != http.MethodPost {
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}
			handleCreateSSHSession(sm)(w, r)
			return
		}

		// SSH connection test: /api/sessions/ssh/test
		if len(parts) == 2 && parts[0] == "ssh" && parts[1] == "test" {
			if r.Method != http.MethodPost {
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}
			handleTestSSHConnection(sm)(w, r)
			return
		}

		if len(parts) == 1 && parts[0] != "" {
			switch r.Method {
			case http.MethodGet:
				handleGetSession(sm)(w, r)
			case http.MethodDelete:
				handleDeleteSession(sm)(w, r)
			default:
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			}
			return
		}

		if len(parts) == 2 && parts[1] == "master" {
			if r.Method != http.MethodPost {
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}
			handleSetMaster(sm)(w, r)
			return
		}

		// POST /api/sessions/{id}/private — set session private mode
		if len(parts) == 2 && parts[1] == "private" {
			if r.Method != http.MethodPost {
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}
			handleSetSessionPrivate(sm)(w, r)
			return
		}

		// DELETE /api/sessions/{id}/clients/{cid} — kick client
		if len(parts) == 3 && parts[1] == "clients" {
			if r.Method != http.MethodDelete {
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}
			handleKickClient(sm, bm)(w, r)
			return
		}

		http.Error(w, "Not found", http.StatusNotFound)
	})))

	// Client management
	mux.Handle("/api/clients", auth.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleListClients(sm)(w, r)
	})))

	// Device management (IP-aggregated clients)
	mux.Handle("/api/devices", auth.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleListDevices(sm, pm)(w, r)
	})))

	mux.Handle("/api/devices/", auth.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleKickDevice(sm, bm, pm)(w, r)
	})))

	// IP ban management
	mux.Handle("/api/banned-ips", auth.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			handleListBannedIPs(bm)(w, r)
		case http.MethodPost:
			handleBanIP(bm)(w, r)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})))

	mux.Handle("/api/banned-ips/", auth.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleUnbanIP(bm)(w, r)
	})))

	// Token management
	mux.Handle("/api/token/refresh", auth.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleRefreshToken(auth)(w, r)
	})))

	mux.Handle("/api/token", auth.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleSetToken(auth)(w, r)
	})))

	mux.Handle("/api/token/revoke-all", auth.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleRevokeAll(sm, auth, pm)(w, r)
	})))

	mux.Handle("/api/info", auth.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		handleInfo(sm)(w, r)
	})))

	// JumpServer API proxy routes
	RegisterJumpServerRoutes(mux, auth)

	mux.Handle("/ws/", auth.Middleware(handleWebSocket(sm, bm)))

	// Serve embedded web viewer (production build)
	if web.HasContent() {
		mux.Handle("/", web.Handler())
	}
}

func handleCreateSession(sm *session.SessionManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Accept optional shell parameter from request body
		var shell string
		if r.Body != nil && r.ContentLength > 0 {
			var req struct {
				Shell string `json:"shell"`
			}
			r.Body = http.MaxBytesReader(w, r.Body, 1024)
			if err := json.NewDecoder(r.Body).Decode(&req); err == nil {
				shell = req.Shell
			}
		}

		s, err := sm.CreateWithShell(shell)
		if err != nil {
			log.Printf("[handler] session create error: %v", err)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"id":         s.ID,
			"created_at": s.CreatedAt,
			"state":      s.StateString(),
		})
	}
}

func handleListSessions(sm *session.SessionManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sessions := sm.List()
		items := make([]map[string]interface{}, 0, len(sessions))
		for _, s := range sessions {
			executorType := "unknown"
			if s.Exec != nil {
				executorType = s.Exec.Info().Type
			}
			items = append(items, map[string]interface{}{
				"id":            s.ID,
				"title":         s.SessionTitle(),
				"clients":       s.ClientCount(),
				"created_at":    s.CreatedAt,
				"state":         s.StateString(),
				"executor_type": executorType,
				"private":       s.IsPrivate(),
			})
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"sessions": items})
	}
}

func handleGetSession(sm *session.SessionManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sessionID := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
		s, ok := sm.Get(sessionID)
		if !ok {
			http.Error(w, "Session not found", http.StatusNotFound)
			return
		}

		executorType := "unknown"
		if s.Exec != nil {
			executorType = s.Exec.Info().Type
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"id":               s.ID,
			"clients":          s.ClientCount(),
			"connected_clients": s.ConnectedClientCount(),
			"created_at":       s.CreatedAt,
			"state":            s.StateString(),
			"executor_type":    executorType,
			"private":          s.IsPrivate(),
		})
	}
}

func handleCreateSSHSession(sm *session.SessionManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Host               string `json:"host"`
			Port               uint16 `json:"port"`
			Username           string `json:"username"`
			AuthMethod         string `json:"auth_method"`
			Password           string `json:"password"`
			PrivateKey         string `json:"private_key"`
			Passphrase         string `json:"passphrase"`
			TrustedFingerprint string `json:"trusted_fingerprint"`
			SkipShellHook      bool   `json:"skip_shell_hook"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 8192)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}

		if req.Host == "" || req.Username == "" {
			http.Error(w, "host and username are required", http.StatusBadRequest)
			return
		}
		if req.Port == 0 {
			req.Port = 22
		}

		cfg := terminal.SSHConfig{
			Host:               req.Host,
			Port:               req.Port,
			Username:           req.Username,
			AuthMethod:         req.AuthMethod,
			Password:           req.Password,
			PrivateKey:         req.PrivateKey,
			Passphrase:         req.Passphrase,
			TrustedFingerprint: req.TrustedFingerprint,
			SkipShellHook:      req.SkipShellHook,
		}

		exec := executor.NewSSHExecutor(cfg, 80, 24)
		s, err := sm.CreateWithExecutor(exec)
		if err != nil {
			if resp, ok := sshHostKeyErrorResponse(err); ok {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusConflict)
				_ = json.NewEncoder(w).Encode(resp)
				return
			}
			http.Error(w, fmt.Sprintf("SSH session creation failed: %v", err), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"id":            s.ID,
			"created_at":    s.CreatedAt,
			"state":         s.StateString(),
			"executor_type": "ssh",
		})
	}
}

func handleTestSSHConnection(_ *session.SessionManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Host               string `json:"host"`
			Port               uint16 `json:"port"`
			Username           string `json:"username"`
			AuthMethod         string `json:"auth_method"`
			Password           string `json:"password"`
			PrivateKey         string `json:"private_key"`
			Passphrase         string `json:"passphrase"`
			TrustedFingerprint string `json:"trusted_fingerprint"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 8192)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}

		if req.Host == "" || req.Username == "" {
			http.Error(w, "host and username are required", http.StatusBadRequest)
			return
		}
		if req.Port == 0 {
			req.Port = 22
		}

		cfg := terminal.SSHConfig{
			Host:               req.Host,
			Port:               req.Port,
			Username:           req.Username,
			AuthMethod:         req.AuthMethod,
			Password:           req.Password,
			PrivateKey:         req.PrivateKey,
			Passphrase:         req.Passphrase,
			TrustedFingerprint: req.TrustedFingerprint,
		}

		// Try to connect and immediately close
		sshTerm, err := terminal.NewSSHTerminal(cfg, 80, 24)
		if err != nil {
			if resp, ok := sshHostKeyErrorResponse(err); ok {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusConflict)
				_ = json.NewEncoder(w).Encode(resp)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok":    false,
				"error": "SSH connection test failed",
			})
			return
		}
		_ = sshTerm.Close()

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok": true,
		})
	}
}

func handleDeleteSession(sm *session.SessionManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sessionID := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
		if err := sm.Delete(sessionID); err != nil {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}
}

func handleSetMaster(sm *session.SessionManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/sessions/"), "/")
		if len(parts) < 2 {
			http.Error(w, "Invalid path", http.StatusBadRequest)
			return
		}

		sessionID := parts[0]
		s, ok := sm.Get(sessionID)
		if !ok {
			http.Error(w, "Session not found", http.StatusNotFound)
			return
		}

		var req struct {
			ClientID string `json:"client_id"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1024)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}

		// HTTP API only supports requesting master transfer via approval flow.
		// Direct master transfer is only allowed through authenticated WebSocket
		// messages (MsgMasterApproval) where client identity is verified by connection.
		s.ForwardMasterRequest(req.ClientID)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":        true,
			"requested": true,
		})
	}
}

func handleInfo(sm *session.SessionManager) http.HandlerFunc {
	hostname, _ := os.Hostname()
	return func(w http.ResponseWriter, r *http.Request) {
		sessions := sm.List()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"name":     hostname,
			"version":  "0.0.3",
			"sessions": len(sessions),
		})
	}
}

// ── Client management handlers ──

func handleListClients(sm *session.SessionManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		clients := sm.ListAllClients()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"clients": clients})
	}
}

func handleKickClient(sm *session.SessionManager, bm *BanManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
		parts := strings.Split(path, "/")
		if len(parts) != 3 || parts[1] != "clients" {
			http.Error(w, "Invalid path", http.StatusBadRequest)
			return
		}
		sessionID := parts[0]
		clientID := parts[2]

		s, ok := sm.Get(sessionID)
		if !ok {
			http.Error(w, "Session not found", http.StatusNotFound)
			return
		}

		remoteAddr, found := s.KickClient(clientID)
		if !found {
			http.Error(w, "Client not found", http.StatusNotFound)
			return
		}

		// Only ban if explicitly requested
		var bannedIP string
		if r.URL.Query().Get("ban") == "true" && remoteAddr != "" {
			if err := bm.Ban(remoteAddr, "kicked"); err == nil {
				bannedIP = remoteAddr
			}
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":        true,
			"banned_ip": bannedIP,
		})
	}
}

// ── IP ban handlers ──

func handleListBannedIPs(bm *BanManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		entries := bm.List()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"banned_ips": entries})
	}
}

func handleBanIP(bm *BanManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			IP     string `json:"ip"`
			Reason string `json:"reason"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1024)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}
		if req.IP == "" {
			http.Error(w, "ip is required", http.StatusBadRequest)
			return
		}
		if err := bm.Ban(req.IP, req.Reason); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}
}

func handleUnbanIP(bm *BanManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw := strings.TrimPrefix(r.URL.Path, "/api/banned-ips/")
		if raw == "" {
			http.Error(w, "ip is required", http.StatusBadRequest)
			return
		}
		parsed := net.ParseIP(raw)
		if parsed == nil {
			http.Error(w, "invalid IP address", http.StatusBadRequest)
			return
		}
		found := bm.Unban(parsed.String())
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "found": found})
	}
}

// ── Token management handlers ──

func handleRefreshToken(auth *Authenticator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		newToken, err := GenerateToken()
		if err != nil {
			http.Error(w, "failed to generate token", http.StatusInternalServerError)
			return
		}
		auth.SetToken(newToken)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(map[string]string{"token": newToken})
	}
}

func handleSetToken(auth *Authenticator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Token string `json:"token"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1024)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}
		if len(req.Token) < 8 {
			http.Error(w, "token must be at least 8 characters", http.StatusBadRequest)
			return
		}
		auth.SetToken(req.Token)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}
}

func handleRevokeAll(sm *session.SessionManager, auth *Authenticator, pm *PairingManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		count := sm.DisconnectAllClients()

		// Refresh token to invalidate all existing paired devices
		newToken, err := GenerateToken()
		if err == nil {
			auth.SetToken(newToken)
		}

		// Clear paired devices list
		pm.ClearPairedDevices()

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		resp := map[string]interface{}{"ok": true, "disconnected": count}
		if err == nil {
			resp["new_token"] = newToken
		}
		_ = json.NewEncoder(w).Encode(resp)
	}
}

// ── Device management handlers ──

func handleListDevices(sm *session.SessionManager, pm *PairingManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		devices := sm.ListDevices()

		// Merge paired devices that have no active session connections
		paired := pm.ListPairedDevices()
		existingIPs := make(map[string]int, len(devices))
		for i, d := range devices {
			existingIPs[d.IP] = i
		}
		for _, p := range paired {
			if idx, ok := existingIPs[p.IP]; ok {
				// Device already has sessions; fill in the name from pairing
				if devices[idx].Name == "" {
					devices[idx].Name = p.DeviceInfo
				}
			} else {
				// Paired but no session connections yet
				devices = append(devices, session.DeviceInfo{
					IP:       p.IP,
					Name:     p.DeviceInfo,
					Sessions: []session.ClientInfo{},
					Count:    0,
				})
			}
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"devices": devices})
	}
}

func handleKickDevice(sm *session.SessionManager, bm *BanManager, pm *PairingManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw := strings.TrimPrefix(r.URL.Path, "/api/devices/")
		if raw == "" {
			http.Error(w, "ip is required", http.StatusBadRequest)
			return
		}
		parsed := net.ParseIP(raw)
		if parsed == nil {
			http.Error(w, "invalid IP address", http.StatusBadRequest)
			return
		}
		ip := parsed.String()
		kicked := sm.KickByIP(ip)

		// Remove from paired devices
		pm.RemovePairedDevice(ip)

		// Only ban if explicitly requested
		var bannedIP string
		if r.URL.Query().Get("ban") == "true" {
			if err := bm.Ban(ip, "device kicked"); err == nil {
				bannedIP = ip
			}
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":        true,
			"kicked":    kicked,
			"banned_ip": bannedIP,
		})
	}
}

func handleSetSessionPrivate(sm *session.SessionManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/sessions/"), "/")
		if len(parts) < 2 {
			http.Error(w, "Invalid path", http.StatusBadRequest)
			return
		}
		sessionID := parts[0]
		s, ok := sm.Get(sessionID)
		if !ok {
			http.Error(w, "Session not found", http.StatusNotFound)
			return
		}

		var req struct {
			Private bool `json:"private"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 256)
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}

		kicked := s.SetPrivate(req.Private)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":      true,
			"private": req.Private,
			"kicked":  kicked,
		})
	}
}
