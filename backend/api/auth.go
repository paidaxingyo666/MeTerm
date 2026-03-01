package api

import (
	"crypto/subtle"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

type Authenticator struct {
	mu    sync.RWMutex
	token string
	bans  *BanManager
}

func NewAuthenticator(token string) *Authenticator {
	return &Authenticator{token: token}
}

// GetToken returns the current token (thread-safe).
func (a *Authenticator) GetToken() string {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.token
}

// SetToken updates the token at runtime (thread-safe).
func (a *Authenticator) SetToken(t string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.token = t
}

// SetBanManager attaches a BanManager for IP-level access control.
func (a *Authenticator) SetBanManager(bm *BanManager) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.bans = bm
}

func (a *Authenticator) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Security headers
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")

		// CORS: only allow trusted origins instead of reflecting any origin.
		origin := r.Header.Get("Origin")
		if origin != "" && isAllowedOrigin(origin, r.Host) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")

		// Handle preflight
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		// IP ban check before authentication
		a.mu.RLock()
		bm := a.bans
		a.mu.RUnlock()
		if bm != nil && bm.IsBanned(extractClientIP(r)) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		if !a.ValidateRequest(r) {
			a.Unauthorized(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *Authenticator) Unauthorized(w http.ResponseWriter) {
	http.Error(w, "unauthorized", http.StatusUnauthorized)
}

func (a *Authenticator) ValidateRequest(r *http.Request) bool {
	if a == nil {
		return false
	}
	currentToken := a.GetToken()
	if currentToken == "" {
		return false
	}

	if token, ok := parseAuthorizationBearer(r.Header.Get("Authorization")); ok {
		return tokenEquals(token, currentToken)
	}

	if token, ok := parseWebSocketProtocolBearer(r.Header.Get("Sec-WebSocket-Protocol")); ok {
		return tokenEquals(token, currentToken)
	}

	return false
}

func tokenEquals(got, expected string) bool {
	if len(got) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(expected)) == 1
}

func parseAuthorizationBearer(header string) (string, bool) {
	if !strings.HasPrefix(header, "Bearer ") {
		return "", false
	}
	t := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	if t == "" {
		return "", false
	}
	return t, true
}

func parseWebSocketProtocolBearer(header string) (string, bool) {
	if header == "" {
		return "", false
	}
	parts := strings.Split(header, ",")
	for _, part := range parts {
		p := strings.TrimSpace(part)
		if strings.HasPrefix(p, "bearer.") {
			t := strings.TrimPrefix(p, "bearer.")
			if t != "" {
				return t, true
			}
		}
	}
	return "", false
}

// isAllowedOrigin checks whether the given Origin is trusted.
// Uses url.Parse for strict scheme + host[:port] matching to prevent bypass.
func isAllowedOrigin(origin, host string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		// Scheme-only origin (no host) — allow tauri scheme
		if u != nil && u.Scheme == "tauri" {
			return true
		}
		return false
	}

	// Tauri webview origin: tauri://localhost (Windows) or https://tauri.localhost (macOS/Linux)
	if u.Scheme == "tauri" && (u.Host == "localhost" || u.Host == "") {
		return true
	}
	if (u.Scheme == "https" || u.Scheme == "http") && u.Host == "tauri.localhost" {
		return true
	}

	// Localhost (local sidecar mode) — exact hostname match
	if u.Scheme == "http" {
		h := u.Hostname() // strips port if present
		if h == "localhost" || h == "127.0.0.1" {
			return true
		}
	}

	// Same-origin: exact host[:port] match
	if host != "" && u.Host == host {
		return true
	}

	return false
}
