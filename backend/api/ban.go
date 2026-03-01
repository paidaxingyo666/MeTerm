package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"sync"
	"time"
)

// BanEntry represents a banned IP address.
type BanEntry struct {
	IP       string    `json:"ip"`
	Reason   string    `json:"reason,omitempty"`
	BannedAt time.Time `json:"banned_at"`
}

// BanManager maintains an IP blacklist with optional file persistence.
type BanManager struct {
	mu       sync.RWMutex
	banned   map[string]BanEntry
	filePath string // empty = no persistence
}

// NewBanManager creates a new BanManager. If filePath is non-empty,
// the ban list is loaded from and persisted to that file.
func NewBanManager(filePath ...string) *BanManager {
	bm := &BanManager{
		banned: make(map[string]BanEntry),
	}
	if len(filePath) > 0 && filePath[0] != "" {
		bm.filePath = filePath[0]
		bm.load()
	}
	return bm
}

// IsBanned checks if an IP is banned.
func (bm *BanManager) IsBanned(ip string) bool {
	bm.mu.RLock()
	defer bm.mu.RUnlock()
	_, ok := bm.banned[ip]
	return ok
}

// Ban adds an IP to the blacklist. Validates IP format and refuses loopback addresses.
func (bm *BanManager) Ban(ip, reason string) error {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return fmt.Errorf("invalid IP address")
	}
	if parsed.IsLoopback() {
		return fmt.Errorf("cannot ban loopback address")
	}
	// Normalize to canonical string form
	canonical := parsed.String()
	bm.mu.Lock()
	bm.banned[canonical] = BanEntry{
		IP:       canonical,
		Reason:   reason,
		BannedAt: time.Now(),
	}
	bm.mu.Unlock()
	bm.save()
	return nil
}

// Unban removes an IP from the blacklist. Returns true if it was banned.
func (bm *BanManager) Unban(ip string) bool {
	bm.mu.Lock()
	_, ok := bm.banned[ip]
	if ok {
		delete(bm.banned, ip)
	}
	bm.mu.Unlock()
	if ok {
		bm.save()
	}
	return ok
}

// List returns all banned entries.
func (bm *BanManager) List() []BanEntry {
	bm.mu.RLock()
	defer bm.mu.RUnlock()
	entries := make([]BanEntry, 0, len(bm.banned))
	for _, e := range bm.banned {
		entries = append(entries, e)
	}
	return entries
}

// load reads the ban list from the persistence file.
func (bm *BanManager) load() {
	if bm.filePath == "" {
		return
	}
	data, err := os.ReadFile(bm.filePath)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[BanManager] failed to read ban file: %v", err)
		}
		return
	}
	var entries []BanEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		log.Printf("[BanManager] failed to parse ban file: %v", err)
		return
	}
	bm.mu.Lock()
	defer bm.mu.Unlock()
	for _, e := range entries {
		bm.banned[e.IP] = e
	}
	if len(entries) > 0 {
		log.Printf("[BanManager] loaded %d banned IPs from %s", len(entries), bm.filePath)
	}
}

// save writes the current ban list to the persistence file.
func (bm *BanManager) save() {
	if bm.filePath == "" {
		return
	}
	bm.mu.RLock()
	entries := make([]BanEntry, 0, len(bm.banned))
	for _, e := range bm.banned {
		entries = append(entries, e)
	}
	bm.mu.RUnlock()

	data, err := json.Marshal(entries)
	if err != nil {
		log.Printf("[BanManager] failed to marshal ban list: %v", err)
		return
	}
	if err := os.WriteFile(bm.filePath, data, 0600); err != nil {
		log.Printf("[BanManager] failed to write ban file: %v", err)
	}
}
