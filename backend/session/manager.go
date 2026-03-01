package session

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/paidaxingyo666/meterm/executor"
	"github.com/paidaxingyo666/meterm/terminal"
	"github.com/google/uuid"

	"github.com/paidaxingyo666/meterm/recording"
)

// DeviceInfo aggregates connected clients by IP address.
type DeviceInfo struct {
	IP       string       `json:"ip"`
	Name     string       `json:"name,omitempty"`
	Sessions []ClientInfo `json:"sessions"`
	Count    int          `json:"count"`
}

// SessionConfig configures lifecycle, reconnect, and buffering behavior.
type SessionConfig struct {
	SessionTTL     time.Duration
	ReconnectGrace time.Duration
	RingBufferSize int
	LogDir         string
}

// SessionManager tracks all active sessions and runs reaper cleanup.
type SessionManager struct {
	sessions map[string]*Session
	mu       sync.RWMutex
	config   SessionConfig

	stopCh chan struct{}
	wg     sync.WaitGroup
}

// NewSessionManager creates a manager and starts the periodic reaper.
func NewSessionManager(config SessionConfig) *SessionManager {
	if config.RingBufferSize <= 0 {
		config.RingBufferSize = 1024 * 1024 // 1MB — enough for history replay
	}

	sm := &SessionManager{
		sessions: make(map[string]*Session),
		config:   config,
		stopCh:   make(chan struct{}),
	}

	sm.wg.Add(1)
	go sm.reaper()
	return sm
}

// Config returns manager-level session settings.
func (sm *SessionManager) Config() SessionConfig {
	return sm.config
}

// Create allocates a new session with a PTY terminal engine.
func (sm *SessionManager) Create() (*Session, error) {
	return sm.CreateWithExecutor(executor.NewLocalShellExecutor(80, 24))
}

func (sm *SessionManager) CreateWithExecutor(exec executor.Executor) (*Session, error) {
	if exec == nil {
		return nil, fmt.Errorf("executor is nil")
	}

	term, err := exec.Start()
	if err != nil {
		return nil, fmt.Errorf("failed to start executor: %w", err)
	}

	s := NewSession(sm.config, term, exec)

	// For local shell sessions, provide a factory so Run() can auto-restart
	// the terminal if the shell exits unexpectedly (e.g. ConPTY bug on Win10
	// where alternate screen restore kills the shell process).
	if exec.Info().Type == "local-shell" {
		s.TermFactory = func(cols, rows uint16) (terminal.Terminal, error) {
			return terminal.NewPTYEngine(cols, rows)
		}
	}

	if sm.config.LogDir != "" {
		if err := os.MkdirAll(sm.config.LogDir, 0o700); err != nil {
			s.Close()
			return nil, fmt.Errorf("failed to create log dir: %w", err)
		}

		rec, err := recording.NewFileRecorder(filepath.Join(sm.config.LogDir, s.ID+".log"))
		if err != nil {
			s.Close()
			return nil, fmt.Errorf("failed to create recorder: %w", err)
		}
		s.SetRecorder(rec)
	}

	sm.mu.Lock()
	sm.sessions[s.ID] = s
	sm.mu.Unlock()

	return s, nil
}

// Get returns a session by ID.
func (sm *SessionManager) Get(id string) (*Session, bool) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	s, ok := sm.sessions[id]
	return s, ok
}

// List returns all sessions.
func (sm *SessionManager) List() []*Session {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	out := make([]*Session, 0, len(sm.sessions))
	for _, s := range sm.sessions {
		out = append(out, s)
	}
	return out
}

// Delete removes and closes a session.
func (sm *SessionManager) Delete(id string) error {
	sm.mu.Lock()
	s, ok := sm.sessions[id]
	if !ok {
		sm.mu.Unlock()
		return fmt.Errorf("session not found: %s", id)
	}
	delete(sm.sessions, id)
	sm.mu.Unlock()

	s.Close()
	return nil
}

// Remove removes a session from manager map.
func (sm *SessionManager) Remove(id string) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	delete(sm.sessions, id)
}

// ListAllClients returns client info across all sessions.
func (sm *SessionManager) ListAllClients() []ClientInfo {
	sessions := sm.List()
	var all []ClientInfo
	for _, s := range sessions {
		all = append(all, s.ListClients()...)
	}
	return all
}

// ListDevices returns clients grouped by IP, excluding loopback addresses.
func (sm *SessionManager) ListDevices() []DeviceInfo {
	all := sm.ListAllClients()
	byIP := make(map[string][]ClientInfo)
	for _, c := range all {
		if !c.Connected {
			continue
		}
		ip := c.RemoteAddr
		if ip == "" {
			continue
		}
		parsed := net.ParseIP(ip)
		if parsed != nil && parsed.IsLoopback() {
			continue
		}
		byIP[ip] = append(byIP[ip], c)
	}
	devices := make([]DeviceInfo, 0, len(byIP))
	for ip, clients := range byIP {
		devices = append(devices, DeviceInfo{
			IP:       ip,
			Sessions: clients,
			Count:    len(clients),
		})
	}
	return devices
}

// KickByIP disconnects all clients with the given IP across all sessions.
// Returns the total number of clients kicked.
func (sm *SessionManager) KickByIP(ip string) int {
	sessions := sm.List()
	total := 0
	for _, s := range sessions {
		total += s.KickByIP(ip)
	}
	return total
}

// DisconnectAllClients forcefully disconnects every client across all sessions.
// Returns the number of clients disconnected.
func (sm *SessionManager) DisconnectAllClients() int {
	sessions := sm.List()
	count := 0
	for _, s := range sessions {
		clients := s.ListClients()
		for _, ci := range clients {
			if ci.Connected {
				if _, ok := s.KickClient(ci.ID); ok {
					count++
				}
			}
		}
	}
	return count
}

// Stop stops background reaper and closes remaining sessions.
func (sm *SessionManager) Stop() {
	select {
	case <-sm.stopCh:
		return
	default:
		close(sm.stopCh)
	}

	sm.wg.Wait()

	for _, s := range sm.List() {
		s.Close()
	}
}

func (sm *SessionManager) reaper() {
	defer sm.wg.Done()

	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-sm.stopCh:
			return
		case <-ticker.C:
			now := time.Now()
			sessions := sm.List()

			for _, s := range sessions {
				for _, clientID := range s.ExpiredDisconnectedClients(now, sm.config.ReconnectGrace) {
					s.ExpireClient(clientID)
				}

				if s.ShouldCloseByTTL(now) {
					_ = sm.Delete(s.ID)
				}
			}
		}
	}
}

func newID() string {
	return uuid.New().String()
}
