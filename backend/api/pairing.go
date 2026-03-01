package api

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/paidaxingyo666/meterm/protocol"
	"github.com/paidaxingyo666/meterm/session"
	"github.com/google/uuid"
)

// PairRequest represents a pending device pairing request.
type PairRequest struct {
	ID         string    `json:"pair_id"`
	DeviceInfo string    `json:"device_info"`
	RemoteAddr string    `json:"remote_addr"`
	Status     string    `json:"status"` // "pending" | "approved" | "denied" | "expired"
	CreatedAt  time.Time `json:"-"`
	tokenSent  bool
	creatorIP  string // IP that created this request — only this IP may poll
	secret     string // secret returned to creator, must be presented when polling
}

// PairedDevice represents a device that has been approved for pairing.
type PairedDevice struct {
	IP         string    `json:"ip"`
	DeviceInfo string    `json:"device_info"`
	PairedAt   time.Time `json:"paired_at"`
}

// PairingManager manages pending pairing requests with TTL and rate limiting.
type PairingManager struct {
	mu            sync.Mutex
	requests      map[string]*PairRequest
	pairedDevices map[string]*PairedDevice // IP -> approved device
	// Rate limiting: IP -> list of request timestamps
	rateMu    sync.Mutex
	rateLimit map[string][]time.Time
	auth      *Authenticator // reference to Authenticator for live token access
	sm        *session.SessionManager
	bans      *BanManager // reference for auto-unban on approval
}

// NewPairingManager creates a new pairing manager.
func NewPairingManager(auth *Authenticator, sm *session.SessionManager, bm *BanManager) *PairingManager {
	pm := &PairingManager{
		requests:      make(map[string]*PairRequest),
		pairedDevices: make(map[string]*PairedDevice),
		rateLimit:     make(map[string][]time.Time),
		auth:          auth,
		sm:            sm,
		bans:          bm,
	}
	go pm.cleanupLoop()
	return pm
}

// cleanupLoop removes expired requests every 10 seconds.
func (pm *PairingManager) cleanupLoop() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		pm.mu.Lock()
		now := time.Now()
		for id, req := range pm.requests {
			if now.Sub(req.CreatedAt) > 60*time.Second {
				if req.Status == "pending" {
					req.Status = "expired"
				}
				// Remove expired/denied entries after additional 30s
				if now.Sub(req.CreatedAt) > 90*time.Second {
					delete(pm.requests, id)
				}
			}
		}
		pm.mu.Unlock()
	}
}

// checkRateLimit returns true if the IP is within rate limits (max 5 per minute).
func (pm *PairingManager) checkRateLimit(ip string) bool {
	pm.rateMu.Lock()
	defer pm.rateMu.Unlock()

	now := time.Now()
	cutoff := now.Add(-1 * time.Minute)

	// Clean old entries
	times := pm.rateLimit[ip]
	valid := times[:0]
	for _, t := range times {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}
	pm.rateLimit[ip] = valid

	if len(valid) >= 5 {
		return false
	}
	pm.rateLimit[ip] = append(pm.rateLimit[ip], now)
	return true
}

// CreateRequest creates a new pairing request and notifies all masters.
func (pm *PairingManager) CreateRequest(deviceInfo, remoteAddr string) *PairRequest {
	// Use crypto/rand for secret instead of UUID for better entropy
	secret, err := GenerateToken()
	if err != nil {
		secret = uuid.New().String() // fallback
	}

	req := &PairRequest{
		ID:         uuid.New().String(),
		DeviceInfo: deviceInfo,
		RemoteAddr: remoteAddr,
		Status:     "pending",
		CreatedAt:  time.Now(),
		creatorIP:  remoteAddr,
		secret:     secret,
	}

	pm.mu.Lock()
	pm.requests[req.ID] = req
	pm.mu.Unlock()

	// Notify all master clients across all sessions
	notifyMsg := protocol.EncodePairNotify(req.ID, req.DeviceInfo, req.RemoteAddr)
	sessions := pm.sm.List()
	for _, s := range sessions {
		masterID := s.Master()
		if masterID != "" {
			s.SendToClient(masterID, notifyMsg)
		}
	}

	return req
}

// GetRequest returns a pairing request by ID.
func (pm *PairingManager) GetRequest(id string) (*PairRequest, bool) {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	req, ok := pm.requests[id]
	return req, ok
}

// HandleApproval processes a master's approval or denial of a pairing request.
func (pm *PairingManager) HandleApproval(approved bool, pairID string) {
	var unbanIP string

	pm.mu.Lock()
	req, ok := pm.requests[pairID]
	if !ok || req.Status != "pending" {
		pm.mu.Unlock()
		return
	}

	if approved {
		req.Status = "approved"
		// Track paired device so it appears in device list immediately
		pm.pairedDevices[req.RemoteAddr] = &PairedDevice{
			IP:         req.RemoteAddr,
			DeviceInfo: req.DeviceInfo,
			PairedAt:   time.Now(),
		}
		unbanIP = req.RemoteAddr
	} else {
		req.Status = "denied"
	}
	pm.mu.Unlock()

	// Auto-unban outside pm.mu to avoid holding the lock during file I/O
	if unbanIP != "" && pm.bans != nil && pm.bans.IsBanned(unbanIP) {
		pm.bans.Unban(unbanIP)
		log.Printf("[Pairing] auto-unbanned %s after pairing approval", unbanIP)
	}
}

// ListPairedDevices returns all approved paired devices.
func (pm *PairingManager) ListPairedDevices() []PairedDevice {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	out := make([]PairedDevice, 0, len(pm.pairedDevices))
	for _, d := range pm.pairedDevices {
		out = append(out, *d)
	}
	return out
}

// RemovePairedDevice removes a paired device by IP.
func (pm *PairingManager) RemovePairedDevice(ip string) {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	delete(pm.pairedDevices, ip)
}

// ClearPairedDevices removes all paired devices.
func (pm *PairingManager) ClearPairedDevices() {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	pm.pairedDevices = make(map[string]*PairedDevice)
}

// extractClientIP extracts the client IP from the request.
// Does NOT trust X-Forwarded-For to prevent IP spoofing (no reverse proxy expected).
func extractClientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// HandlePairCreate handles POST /api/pair
func (pm *PairingManager) HandlePairCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	clientIP := extractClientIP(r)
	if !pm.checkRateLimit(clientIP) {
		http.Error(w, "Too many requests", http.StatusTooManyRequests)
		return
	}

	var body struct {
		DeviceInfo string `json:"device_info"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if body.DeviceInfo == "" {
		body.DeviceInfo = fmt.Sprintf("Unknown device (%s)", clientIP)
	}
	// Limit deviceInfo length to prevent memory abuse
	if len(body.DeviceInfo) > 256 {
		body.DeviceInfo = body.DeviceInfo[:256]
	}

	req := pm.CreateRequest(body.DeviceInfo, clientIP)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"pair_id": req.ID,
		"status":  req.Status,
		"secret":  req.secret,
	})
}

// HandlePendingList handles GET /api/pair/pending (requires auth).
// Returns all pending pairing requests for the master to review.
func (pm *PairingManager) HandlePendingList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	pm.mu.Lock()
	var pending []map[string]string
	for _, req := range pm.requests {
		if req.Status == "pending" {
			pending = append(pending, map[string]string{
				"pair_id":     req.ID,
				"device_info": req.DeviceInfo,
				"remote_addr": req.RemoteAddr,
				"created_at":  req.CreatedAt.Format(time.RFC3339),
			})
		}
	}
	pm.mu.Unlock()

	if pending == nil {
		pending = []map[string]string{}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"requests": pending})
}

// HandlePairRespond handles POST /api/pair/{id}/respond (requires auth).
// Allows the master to approve or deny a pairing request via HTTP.
func (pm *PairingManager) HandlePairRespond(w http.ResponseWriter, r *http.Request, pairID string) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var body struct {
		Approved bool `json:"approved"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 256)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	pm.HandleApproval(body.Approved, pairID)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// HandlePairStatus handles GET /api/pair/{id}
func (pm *PairingManager) HandlePairStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	pairID := strings.TrimPrefix(r.URL.Path, "/api/pair/")
	if pairID == "" {
		http.Error(w, "Missing pair ID", http.StatusBadRequest)
		return
	}

	req, ok := pm.GetRequest(pairID)
	if !ok {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "expired"})
		return
	}

	// Security: verify the poller is the original creator (IP + secret)
	clientIP := extractClientIP(r)
	secret := r.URL.Query().Get("secret")
	if clientIP != req.creatorIP || secret == "" ||
		subtle.ConstantTimeCompare([]byte(secret), []byte(req.secret)) != 1 {
		http.Error(w, "unauthorized", http.StatusForbidden)
		return
	}

	pm.mu.Lock()
	resp := map[string]string{"status": req.Status}
	if req.Status == "approved" && !req.tokenSent {
		resp["token"] = pm.auth.GetToken()
		req.tokenSent = true
	}
	pm.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
