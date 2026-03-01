package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/grandcat/zeroconf"
)

const (
	mdnsServiceType   = "_meterm._tcp"
	mdnsDomain        = "local."
	discoverMaxTime   = 10 * time.Second
	discoverDefault   = 5 * time.Second
	maxTxtFieldLen    = 256
	maxDiscoverResult = 50
)

// DiscoveryManager manages mDNS service registration and discovery.
type DiscoveryManager struct {
	mu       sync.Mutex
	server   *zeroconf.Server
	port     int
	hostname string

	// Concurrency guard: only one scan at a time
	scanSem chan struct{}
}

// NewDiscoveryManager creates a new DiscoveryManager for the given port.
func NewDiscoveryManager(port int) *DiscoveryManager {
	hostname, _ := os.Hostname()
	return &DiscoveryManager{
		port:     port,
		hostname: hostname,
		scanSem:  make(chan struct{}, 1),
	}
}

// SetDiscoverable enables or disables mDNS service registration.
func (dm *DiscoveryManager) SetDiscoverable(enabled bool) error {
	dm.mu.Lock()
	defer dm.mu.Unlock()

	if enabled {
		if dm.server != nil {
			return nil // already registered
		}
		txt := []string{"v=1"}
		server, err := zeroconf.Register(
			dm.hostname,
			mdnsServiceType,
			mdnsDomain,
			dm.port,
			txt,
			nil, // all interfaces
		)
		if err != nil {
			return fmt.Errorf("mDNS register failed: %w", err)
		}
		dm.server = server
		log.Printf("[mdns] Registered service: %s.%s port=%d", dm.hostname, mdnsServiceType, dm.port)
		return nil
	}

	// Disable
	if dm.server != nil {
		dm.server.Shutdown()
		dm.server = nil
		log.Println("[mdns] Service unregistered")
	}
	return nil
}

// IsDiscoverable returns whether the service is currently registered.
func (dm *DiscoveryManager) IsDiscoverable() bool {
	dm.mu.Lock()
	defer dm.mu.Unlock()
	return dm.server != nil
}

// Shutdown stops the mDNS service if running.
func (dm *DiscoveryManager) Shutdown() {
	dm.mu.Lock()
	defer dm.mu.Unlock()
	if dm.server != nil {
		dm.server.Shutdown()
		dm.server = nil
	}
}

// HandlePing responds with basic service identifier (no auth required).
// Only returns the service type for verification — no version or hostname.
func (dm *DiscoveryManager) HandlePing(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{
		"service": "meterm",
	})
}

// DiscoveredService represents a discovered mDNS service.
type DiscoveredService struct {
	Name string `json:"name"`
	Host string `json:"host"`
	Port int    `json:"port"`
}

// HandleDiscover scans the LAN for meterm services (requires auth).
// Only one scan runs at a time to prevent resource exhaustion.
func (dm *DiscoveryManager) HandleDiscover(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Concurrency guard: reject if another scan is in progress
	select {
	case dm.scanSem <- struct{}{}:
		defer func() { <-dm.scanSem }()
	default:
		http.Error(w, "A scan is already in progress", http.StatusTooManyRequests)
		return
	}

	timeout := discoverDefault
	if ts := r.URL.Query().Get("timeout"); ts != "" {
		if secs, err := strconv.Atoi(ts); err == nil && secs > 0 {
			timeout = time.Duration(secs) * time.Second
			if timeout > discoverMaxTime {
				timeout = discoverMaxTime
			}
		}
	}

	resolver, err := zeroconf.NewResolver(nil)
	if err != nil {
		log.Printf("[discover] failed to create resolver: %v", err)
		http.Error(w, "failed to create resolver", http.StatusInternalServerError)
		return
	}

	entries := make(chan *zeroconf.ServiceEntry)
	var services []DiscoveredService
	var mu sync.Mutex

	localIPs := getLocalIPs()

	go func() {
		for entry := range entries {
			// Pick the first IPv4 address
			var host string
			for _, ip := range entry.AddrIPv4 {
				host = ip.String()
				break
			}
			if host == "" {
				for _, ip := range entry.AddrIPv6 {
					host = ip.String()
					break
				}
			}
			if host == "" {
				continue
			}

			// Filter out self
			if entry.Port == dm.port && isLocalIP(host, localIPs) {
				continue
			}

			// Use instance name, truncate for safety
			name := entry.Instance
			if len(name) > maxTxtFieldLen {
				name = name[:maxTxtFieldLen]
			}

			mu.Lock()
			if len(services) < maxDiscoverResult {
				services = append(services, DiscoveredService{
					Name: name,
					Host: host,
					Port: entry.Port,
				})
			}
			mu.Unlock()
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	if err := resolver.Browse(ctx, mdnsServiceType, mdnsDomain, entries); err != nil {
		log.Printf("[discover] browse failed: %v", err)
		http.Error(w, "discovery browse failed", http.StatusInternalServerError)
		return
	}

	<-ctx.Done()

	mu.Lock()
	result := services
	mu.Unlock()

	if result == nil {
		result = []DiscoveredService{}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"services": result,
	})
}

// HandleDiscoverableToggle handles GET/POST for discoverable state (requires auth).
func (dm *DiscoveryManager) HandleDiscoverableToggle(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{
			"discoverable": dm.IsDiscoverable(),
		})

	case http.MethodPost:
		var req struct {
			Enabled bool `json:"enabled"`
			Port    int  `json:"port,omitempty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}
		if req.Port > 0 && req.Port <= 65535 {
			dm.mu.Lock()
			dm.port = req.Port
			dm.mu.Unlock()
		}
		if err := dm.SetDiscoverable(req.Enabled); err != nil {
			log.Printf("[discover] set discoverable error: %v", err)
			http.Error(w, "failed to update discoverable state", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":           true,
			"discoverable": dm.IsDiscoverable(),
		})

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// getLocalIPs returns all local non-loopback IP addresses.
func getLocalIPs() []string {
	var ips []string
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ips
	}
	for _, addr := range addrs {
		if ipNet, ok := addr.(*net.IPNet); ok && !ipNet.IP.IsLoopback() {
			ips = append(ips, ipNet.IP.String())
		}
	}
	return ips
}

// isLocalIP checks if the given IP string is in the local IP list.
func isLocalIP(ip string, localIPs []string) bool {
	for _, lip := range localIPs {
		if lip == ip {
			return true
		}
	}
	return false
}
