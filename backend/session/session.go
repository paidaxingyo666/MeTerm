package session

import (
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/encoding/korean"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/traditionalchinese"

	"github.com/paidaxingyo666/meterm/executor"
	"github.com/paidaxingyo666/meterm/protocol"
	"github.com/paidaxingyo666/meterm/recording"
	"github.com/paidaxingyo666/meterm/sftp"
	"github.com/paidaxingyo666/meterm/terminal"
)

// ClientInfo is the API-safe client snapshot.
type ClientInfo struct {
	ID           string    `json:"id"`
	SessionID    string    `json:"session_id"`
	SessionTitle string    `json:"session_title"`
	Role         string    `json:"role"`
	Connected    bool      `json:"connected"`
	LastSeen     time.Time `json:"last_seen,omitempty"`
	RemoteAddr   string    `json:"remote_addr"`
}

// TerminalFactory creates a new Terminal with given dimensions.
// Used by Session to auto-restart the shell on unexpected exit.
type TerminalFactory func(cols, rows uint16) (terminal.Terminal, error)

// Session represents one terminal-sharing room.
type Session struct {
	ID       string
	Term     terminal.Terminal
	Exec     executor.Executor
	Recorder recording.Recorder
	Clients  map[string]*Client
	MasterID string
	OwnerID  string // first master — only they can reclaim
	Private  bool   // when true, only loopback clients can join
	LastCols uint16
	LastRows uint16
	Config   SessionConfig
	State    SessionState

	CreatedAt time.Time

	// TermFactory, if set, allows Run() to restart the terminal
	// when the shell exits unexpectedly (non-zero exit code).
	TermFactory TerminalFactory

	// SFTP and file transfer support
	SFTPClient      *sftp.SFTPClient
	activeUploads   map[uint64]*UploadSession
	activeDownloads map[uint64]*DownloadSession
	transferMu      sync.RWMutex
	transferIDGen   uint64

	ringBuf   []byte
	ringStart int
	ringLen   int
	ringCap   int

	drainDeadline time.Time

	// Encoding conversion for non-UTF-8 terminals
	encodingName string
	encoder      *encoding.Encoder // UTF-8 → target encoding (for input)
	decoder      *encoding.Decoder // target encoding → UTF-8 (for output)

	mu     sync.RWMutex
	ctx    context.Context
	cancel context.CancelFunc
	closed bool
}

// NewSession builds a session around an already-created terminal.
func NewSession(config SessionConfig, term terminal.Terminal, exec executor.Executor) *Session {
	ctx, cancel := context.WithCancel(context.Background())
	ringCap := config.RingBufferSize
	if ringCap <= 0 {
		ringCap = 256 * 1024
	}

	s := &Session{
		ID:              newID(),
		Term:            term,
		Exec:            exec,
		Clients:         make(map[string]*Client),
		LastCols:        80,
		LastRows:        24,
		Config:          config,
		State:           StateCreated,
		CreatedAt:       time.Now(),
		activeUploads:   make(map[uint64]*UploadSession),
		activeDownloads: make(map[uint64]*DownloadSession),
		ringBuf:         make([]byte, ringCap),
		ringCap:         ringCap,
		ctx:             ctx,
		cancel:          cancel,
	}

	// Initialize SFTP client for SSH executors
	if exec.Info().Type == "ssh" {
		if sshTerm, ok := term.(*terminal.SSHTerminal); ok {
			sftpClient, err := sftp.NewSFTPClient(sshTerm.SSHClient())
			if err == nil {
				s.SFTPClient = sftpClient
			}
		}
	}

	go s.Run()
	return s
}

// AddClient adds a new client identity to the session.
func (s *Session) AddClient(client *Client) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.State == StateClosed {
		return fmt.Errorf("session closed")
	}

	if s.Private && !isLoopback(client.RemoteAddr) {
		return fmt.Errorf("session is private")
	}

	s.Clients[client.ID] = client
	if s.MasterID == "" && client.Role != RoleReadOnly {
		s.MasterID = client.ID
		client.Role = RoleMaster
		if s.OwnerID == "" {
			s.OwnerID = client.ID
		}
	}

	if client.Role == RoleMaster {
		_ = s.Term.Resize(s.LastCols, s.LastRows)
	}

	if s.State == StateCreated || s.State == StateDraining {
		s.State = StateRunning
		s.drainDeadline = time.Time{}
	}

	go client.WritePump()
	return nil
}

// RemoveClient disconnects a client but keeps it for grace-period reconnection.
// connGen is the connection generation at the time the goroutine started; if the
// client has since been reconnected (generation changed), this is a stale cleanup
// and the disconnect is skipped. Pass 0 to force unconditional disconnect.
func (s *Session) RemoveClient(clientID string, connGen uint64) {
	s.mu.Lock()
	client, ok := s.Clients[clientID]
	if !ok {
		s.mu.Unlock()
		return
	}

	// Skip if the client was reconnected after this goroutine started.
	if connGen > 0 && client.ConnGen() != connGen {
		s.mu.Unlock()
		return
	}

	client.Disconnect()
	connected := s.connectedClientCountLocked()

	if connected == 0 && s.State == StateRunning {
		if s.Config.SessionTTL == 0 {
			s.mu.Unlock()
			s.Close()
			return
		}
		s.State = StateDraining
		s.drainDeadline = time.Now().Add(s.Config.SessionTTL)
	}

	s.mu.Unlock()
}

// ReconnectClient reattaches an existing disconnected client socket.
func (s *Session) ReconnectClient(clientID string, conn *websocket.Conn, grace time.Duration) (*Client, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.State == StateClosed {
		return nil, fmt.Errorf("session closed")
	}

	if s.Private {
		client, ok := s.Clients[clientID]
		if ok && !isLoopback(client.RemoteAddr) {
			return nil, fmt.Errorf("session is private")
		}
	}

	client, ok := s.Clients[clientID]
	if !ok {
		return nil, fmt.Errorf("client not found")
	}
	if client.Connected {
		// Old connection is stale (e.g. system sleep / reconnectAll race).
		// Force-disconnect old socket so this reconnect can proceed.
		// The old goroutine's deferred RemoveClient will be a no-op
		// because connGen has changed.
		client.Disconnect()
	}
	// After force-disconnect, LastSeen is just set to now, so grace check passes.
	if grace > 0 && !client.LastSeen.IsZero() && time.Since(client.LastSeen) > grace {
		return nil, fmt.Errorf("client reconnect grace expired")
	}

	client.Reconnect(conn)

	if s.State == StateCreated || s.State == StateDraining {
		s.State = StateRunning
		s.drainDeadline = time.Time{}
	}

	return client, nil
}

// FlushRingBuffer sends buffered output history to one client (non-destructive).
func (s *Session) FlushRingBuffer(client *Client) {
	buf := s.peekRingSnapshot()
	if len(buf) == 0 {
		return
	}
	// Prepend terminal reset (RIS) so ring buffer replay starts from clean state.
	// Without this, ring buffer may begin mid-escape-sequence causing garbage.
	client.Send(protocol.EncodeMessage(protocol.MsgOutput, []byte("\x1bc")))
	for len(buf) > 0 {
		n := 4096
		if len(buf) < n {
			n = len(buf)
		}
		client.Send(protocol.EncodeMessage(protocol.MsgOutput, buf[:n]))
		buf = buf[n:]
	}
}

// ConnectedClientCount returns currently connected clients.
func (s *Session) ConnectedClientCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.connectedClientCountLocked()
}

// ClientCount returns the total tracked clients including disconnected ones.
func (s *Session) ClientCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.Clients)
}

// SessionTitle returns a human-readable title derived from the executor info.
func (s *Session) SessionTitle() string {
	if s.Exec == nil {
		return s.ID[:8]
	}
	info := s.Exec.Info()
	switch info.Type {
	case "ssh":
		user := info.Labels["username"]
		host := info.Labels["host"]
		port := info.Labels["port"]
		if port != "" && port != "22" {
			return fmt.Sprintf("%s@%s:%s", user, host, port)
		}
		return fmt.Sprintf("%s@%s", user, host)
	case "local-shell":
		if shell := info.Labels["shell"]; shell != "" {
			return shell
		}
		return "shell"
	default:
		return info.Type
	}
}

// ListClients returns client metadata snapshots.
func (s *Session) ListClients() []ClientInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()

	title := s.SessionTitle()
	items := make([]ClientInfo, 0, len(s.Clients))
	for _, c := range s.Clients {
		items = append(items, ClientInfo{
			ID:           c.ID,
			SessionID:    s.ID,
			SessionTitle: title,
			Role:         c.Role.String(),
			Connected:    c.Connected,
			LastSeen:     c.LastSeen,
			RemoteAddr:   c.RemoteAddr,
		})
	}
	return items
}

// SetMaster changes the master role to a target client.
func (s *Session) SetMaster(clientID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	newMaster, ok := s.Clients[clientID]
	if !ok {
		return fmt.Errorf("client not found: %s", clientID)
	}

	if s.MasterID != "" {
		if oldMaster, ok := s.Clients[s.MasterID]; ok {
			oldMaster.Role = RoleViewer
			oldMaster.Send(protocol.EncodeRoleChange(byte(RoleViewer)))
		}
	}

	s.MasterID = clientID
	newMaster.Role = RoleMaster
	newMaster.Send(protocol.EncodeRoleChange(byte(RoleMaster)))
	_ = s.Term.Resize(s.LastCols, s.LastRows)
	return nil
}

// ForwardMasterRequest sends a master request notification to the current master.
func (s *Session) ForwardMasterRequest(requesterID string) {
	s.mu.RLock()
	masterClient, ok := s.Clients[s.MasterID]
	s.mu.RUnlock()
	if !ok || !masterClient.Connected {
		return
	}
	masterClient.Send(protocol.EncodeMasterRequestNotify(requesterID, s.ID))
}

// HandleMasterApproval processes a master approval/denial from the current master.
func (s *Session) HandleMasterApproval(approverID string, approved bool, requesterID string) {
	s.mu.RLock()
	isMaster := s.MasterID == approverID
	requester, ok := s.Clients[requesterID]
	s.mu.RUnlock()

	if !isMaster {
		return
	}
	if !ok || !requester.Connected {
		return
	}

	if approved {
		_ = s.SetMaster(requesterID)
	} else {
		requester.Send(protocol.EncodeMasterDenied())
	}
}

// Broadcast sends a frame to all connected clients.
func (s *Session) Broadcast(data []byte) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, client := range s.Clients {
		client.Send(data)
	}
}

// SendToClient sends a frame to a specific client by ID.
func (s *Session) SendToClient(clientID string, data []byte) {
	s.mu.RLock()
	client, ok := s.Clients[clientID]
	s.mu.RUnlock()
	if ok && client.Connected {
		client.Send(data)
	}
}

// HandleInput writes master input into terminal.
func (s *Session) HandleInput(clientID string, data []byte) {
	s.mu.RLock()
	client, ok := s.Clients[clientID]
	isMaster := ok && s.MasterID == clientID && client.Role != RoleReadOnly
	s.mu.RUnlock()
	if isMaster {
		// Convert UTF-8 input to target encoding if set
		s.mu.RLock()
		enc := s.encoder
		s.mu.RUnlock()
		if enc != nil {
			if converted, err := enc.Bytes(data); err == nil {
				data = converted
			}
		}
		_, _ = s.Term.Write(data)
		s.recordInput(data)
	}
}

// HandleResize applies master resize to terminal.
// Always calls Term.Resize even if dimensions unchanged — this triggers
// SIGWINCH so fullscreen TUI apps (vim, opencode, etc.) redraw correctly.
func (s *Session) HandleResize(clientID string, cols, rows uint16) {
	s.mu.RLock()
	client, ok := s.Clients[clientID]
	isMaster := ok && s.MasterID == clientID && client.Role != RoleReadOnly
	s.mu.RUnlock()
	if !isMaster || cols == 0 || rows == 0 {
		return
	}
	s.mu.Lock()
	s.LastCols = cols
	s.LastRows = rows
	s.mu.Unlock()
	_ = s.Term.Resize(cols, rows)
	s.recordResize(cols, rows)
	// 广播新尺寸给所有客户端，让 viewer 同步调整
	s.Broadcast(protocol.EncodeResize(cols, rows))
}

// NudgeResize triggers a PTY resize to force TUI applications to redraw.
// It shrinks by 1 row, waits for the app to handle SIGWINCH, then restores.
// Does NOT broadcast resize to clients — callers handle client-side refresh separately.
func (s *Session) NudgeResize() {
	s.mu.RLock()
	cols := s.LastCols
	rows := s.LastRows
	s.mu.RUnlock()
	if cols == 0 || rows == 0 {
		return
	}
	// Shrink by 1 row — triggers SIGWINCH, app sees different size and redraws
	_ = s.Term.Resize(cols, rows-1)
	// Give the app time to process SIGWINCH with the changed size
	time.Sleep(100 * time.Millisecond)
	// Restore original size — triggers another SIGWINCH + final redraw
	_ = s.Term.Resize(cols, rows)
}

// Run reads terminal output and dispatches it based on state.
func (s *Session) Run() {
	type readResult struct {
		data []byte
		err  error
		from terminal.Terminal // which terminal produced this result
	}

	readCh := make(chan readResult, 4) // buffered to avoid blocking stale readers

	startReader := func(term terminal.Terminal) {
		go func() {
			buf := make([]byte, 4096)
			for {
				n, err := term.Read(buf)
				if n > 0 {
					cp := make([]byte, n)
					copy(cp, buf[:n])
					readCh <- readResult{data: cp, from: term}
				}
				if err != nil {
					readCh <- readResult{err: err, from: term}
					return
				}
			}
		}()
	}

	startReader(s.Term)

	const maxRestarts = 3
	restartCount := 0

	for {
		select {
		case <-s.ctx.Done():
			log.Printf("[session:%s] Run: ctx done", s.ID[:8])
			return

		case <-s.Term.Done():
			log.Printf("[session:%s] Run: Term.Done() fired — child process exited", s.ID[:8])

			// Try to restart the terminal if a factory is available,
			// there are connected clients, and we haven't exhausted
			// restart attempts.
			s.mu.RLock()
			factory := s.TermFactory
			connected := s.connectedClientCountLocked()
			cols, rows := s.LastCols, s.LastRows
			state := s.State
			s.mu.RUnlock()

			if factory != nil && connected > 0 && state == StateRunning && restartCount < maxRestarts {
				if cols == 0 {
					cols = 80
				}
				if rows == 0 {
					rows = 24
				}
				newTerm, err := factory(cols, rows)
				if err != nil {
					log.Printf("[session:%s] Run: terminal restart failed: %v", s.ID[:8], err)
				} else {
					restartCount++
					log.Printf("[session:%s] Run: terminal restarted (%d/%d)", s.ID[:8], restartCount, maxRestarts)

					// Close old terminal (its reader will error out and
					// send to readCh, but we'll ignore it via the `from`
					// field check below).
					oldTerm := s.Term
					s.mu.Lock()
					s.Term = newTerm
					// Clear ring buffer so reconnecting clients don't
					// replay stale TUI escape sequences from the dead
					// shell. The new shell will fill fresh content.
					s.ringLen = 0
					s.ringStart = 0
					s.mu.Unlock()
					_ = oldTerm.Close()

					// Start new reader.
					startReader(newTerm)

					// Prepare the frontend for the new shell:
					//
					// 1. Exit alternate screen — the TUI may have been
					//    killed before sending \x1b[?1049l, leaving
					//    xterm.js in the alternate buffer (no scrollback).
					//    The cursor is restored to where it was when the
					//    TUI entered alternate screen — i.e. just past
					//    the last content line.
					// 2. Disable mouse tracking — the TUI's DECRST
					//    may have been lost when ConPTY killed the pipe.
					// 3. Scroll content into scrollback by emitting `rows`
					//    newlines FROM THE RESTORED CURSOR POSITION.
					//    Because the cursor sits near the content end,
					//    only the content rows (not dozens of blank lines)
					//    are pushed into scrollback. The blank area below
					//    stays in the visible region and gets overwritten
					//    naturally by the new ConPTY output (which starts
					//    at row 0).
					//    Do NOT jump to bottom first (\x1b[999;1H) — that
					//    would cause ALL visible rows (including blanks)
					//    to scroll into scrollback, creating a large gap.
					var seq string
					seq += "\x1b[?1049l"                                          // ensure main buffer
					seq += "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l"       // disable mouse
					seq += strings.Repeat("\n", int(rows))                        // scroll content into scrollback
					s.Broadcast(protocol.EncodeMessage(protocol.MsgOutput, []byte(seq)))
					continue
				}
			}

			s.Broadcast(protocol.EncodeMessage(protocol.MsgSessionEnd, nil))
			time.Sleep(100 * time.Millisecond)
			s.Close()
			return

		case result := <-readCh:
			// Ignore results from a stale (replaced) terminal.
			if result.from != s.Term {
				if result.err != nil {
					log.Printf("[session:%s] Run: ignoring stale Read error from old terminal: %v", s.ID[:8], result.err)
				}
				continue
			}

			if result.err != nil {
				// Check if the terminal is still alive. If Done() is
				// already closed, this is a real exit — the Done case
				// above will handle restart or close on the next iteration.
				select {
				case <-s.Term.Done():
					log.Printf("[session:%s] Run: Read error after exit: %v", s.ID[:8], result.err)
					continue
				default:
				}
				log.Printf("[session:%s] Run: Read error: %v — waiting for Term.Done()", s.ID[:8], result.err)
				select {
				case <-s.Term.Done():
					log.Printf("[session:%s] Run: child exited after Read error", s.ID[:8])
					continue // let Done case handle restart
				case <-time.After(5 * time.Second):
					log.Printf("[session:%s] Run: child still alive 5s after Read error", s.ID[:8])
				case <-s.ctx.Done():
					log.Printf("[session:%s] Run: ctx done while waiting after Read error", s.ID[:8])
					return
				}

				// The child process is still alive but the pipe is broken.
				// This can happen after system hibernate on Windows (ConPTY pipe
				// becomes invalid while the process handle remains valid).
				// Try to restart the PTY via factory instead of closing the session.
				s.mu.RLock()
				pipeFactory := s.TermFactory
				pipeConnected := s.connectedClientCountLocked()
				pipeCols, pipeRows := s.LastCols, s.LastRows
				pipeState := s.State
				s.mu.RUnlock()

				if pipeFactory != nil && pipeConnected > 0 && pipeState == StateRunning && restartCount < maxRestarts {
					if pipeCols == 0 {
						pipeCols = 80
					}
					if pipeRows == 0 {
						pipeRows = 24
					}
					newTerm, fErr := pipeFactory(pipeCols, pipeRows)
					if fErr != nil {
						log.Printf("[session:%s] Run: pipe-break PTY restart failed: %v", s.ID[:8], fErr)
					} else {
						restartCount++
						log.Printf("[session:%s] Run: pipe-break PTY restarted (%d/%d)", s.ID[:8], restartCount, maxRestarts)
						oldTerm := s.Term
						s.mu.Lock()
						s.Term = newTerm
						s.ringLen = 0
						s.ringStart = 0
						s.mu.Unlock()
						_ = oldTerm.Close()
						startReader(newTerm)
						var seq string
						seq += "\x1b[?1049l"
						seq += "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l"
						seq += strings.Repeat("\n", int(pipeRows))
						s.Broadcast(protocol.EncodeMessage(protocol.MsgOutput, []byte(seq)))
						continue
					}
				}

				s.Broadcast(protocol.EncodeMessage(protocol.MsgSessionEnd, nil))
				time.Sleep(100 * time.Millisecond)
				s.Close()
				return
			}

			s.mu.Lock()
			dec := s.decoder
			draining := s.State == StateDraining && s.connectedClientCountLocked() == 0
			s.mu.Unlock()

			outData := result.data
			// Convert output from target encoding to UTF-8 if set
			if dec != nil {
				if converted, err := dec.Bytes(outData); err == nil {
					outData = converted
				}
			}

			// Always append to ring buffer for history replay
			s.mu.Lock()
			s.appendRingLocked(outData)
			s.mu.Unlock()

			if draining {
				continue // no connected clients, skip broadcast
			}

			s.Broadcast(protocol.EncodeMessage(protocol.MsgOutput, outData))
			s.recordOutput(outData)
		}
	}
}

func (s *Session) SetRecorder(rec recording.Recorder) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Recorder = rec
}

// Close shuts down the session exactly once.
func (s *Session) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.State = StateClosed
	s.cancel()

	clients := make([]*Client, 0, len(s.Clients))
	for _, c := range s.Clients {
		clients = append(clients, c)
	}
	s.Clients = make(map[string]*Client)
	term := s.Term
	recorder := s.Recorder
	exec := s.Exec
	sftpClient := s.SFTPClient
	s.mu.Unlock()

	// Send session-end to each client so remote viewers show the closed
	// overlay before we tear down connections.
	if len(clients) > 0 {
		endMsg := protocol.EncodeMessage(protocol.MsgSessionEnd, nil)
		for _, c := range clients {
			c.Send(endMsg)
		}
		time.Sleep(100 * time.Millisecond)
	}

	for _, client := range clients {
		client.Close()
	}
	if sftpClient != nil {
		_ = sftpClient.Close()
	}
	if term != nil {
		_ = term.Close()
	}
	if recorder != nil {
		_ = recorder.Close()
	}
	if exec != nil {
		_ = exec.Stop()
	}
}

// lookupEncoding returns the encoding.Encoding for a given name.
func lookupEncoding(name string) encoding.Encoding {
	switch name {
	case "gbk":
		return simplifiedchinese.GBK
	case "gb18030":
		return simplifiedchinese.GB18030
	case "big5":
		return traditionalchinese.Big5
	case "euc-jp":
		return japanese.EUCJP
	case "euc-kr":
		return korean.EUCKR
	case "iso-8859-1":
		return charmap.ISO8859_1
	default:
		return nil
	}
}

// SetEncoding changes the character encoding for this session.
// When set to a non-UTF-8 encoding, input is converted from UTF-8 to the
// target encoding, and output is converted from the target encoding to UTF-8.
func (s *Session) SetEncoding(name string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if name == "utf-8" || name == "" {
		s.encodingName = ""
		s.encoder = nil
		s.decoder = nil
		return
	}

	enc := lookupEncoding(name)
	if enc == nil {
		return
	}

	s.encodingName = name
	s.encoder = enc.NewEncoder()
	s.decoder = enc.NewDecoder()
}

// KickClient forcefully disconnects a client and removes it from the session.
// Returns the client's remote address and whether it was found.
func (s *Session) KickClient(clientID string) (remoteAddr string, found bool) {
	s.mu.Lock()

	client, ok := s.Clients[clientID]
	if !ok {
		s.mu.Unlock()
		return "", false
	}

	remoteAddr = client.RemoteAddr
	wasMaster := s.MasterID == clientID
	delete(s.Clients, clientID)

	// Elect new master if needed (reuse ExpireClient election logic)
	if wasMaster {
		s.MasterID = ""
		for id, c := range s.Clients {
			if !c.Connected || c.Role == RoleReadOnly {
				continue
			}
			c.Role = RoleMaster
			s.MasterID = id
			c.Send(c.RoleMessage())
			break
		}
	}
	s.mu.Unlock()

	// Send kicked notification before closing (outside lock)
	client.Send(protocol.EncodeError(protocol.ErrKicked, "kicked by host"))
	time.Sleep(50 * time.Millisecond)
	client.Close()

	return remoteAddr, true
}

// SetPrivate toggles private mode. When enabled, all remote (non-loopback)
// clients are kicked. Returns the number of clients kicked.
func (s *Session) SetPrivate(private bool) int {
	s.mu.Lock()
	s.Private = private
	if !private {
		s.mu.Unlock()
		return 0
	}
	// Kick all remote clients
	var toKick []string
	for id, c := range s.Clients {
		if !isLoopback(c.RemoteAddr) {
			toKick = append(toKick, id)
		}
	}
	s.mu.Unlock()

	kicked := 0
	for _, id := range toKick {
		if _, ok := s.KickClient(id); ok {
			kicked++
		}
	}
	return kicked
}

// IsPrivate reports whether the session is in private mode.
func (s *Session) IsPrivate() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.Private
}

// KickByIP disconnects all clients from the given IP address.
// Returns the number of clients kicked.
func (s *Session) KickByIP(ip string) int {
	s.mu.RLock()
	var toKick []string
	for id, c := range s.Clients {
		if c.RemoteAddr == ip {
			toKick = append(toKick, id)
		}
	}
	s.mu.RUnlock()

	kicked := 0
	for _, id := range toKick {
		if _, ok := s.KickClient(id); ok {
			kicked++
		}
	}
	return kicked
}

// isLoopback checks if the given IP string is a loopback address.
func isLoopback(addr string) bool {
	ip := net.ParseIP(addr)
	if ip == nil {
		return false
	}
	return ip.IsLoopback()
}

// ExpireClient removes a disconnected client after grace period.
func (s *Session) ExpireClient(clientID string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	client, ok := s.Clients[clientID]
	if !ok || client.Connected {
		return
	}

	wasMaster := s.MasterID == clientID
	delete(s.Clients, clientID)

	if !wasMaster {
		return
	}

	s.MasterID = ""
	for id, c := range s.Clients {
		if !c.Connected || c.Role == RoleReadOnly {
			continue
		}
		c.Role = RoleMaster
		s.MasterID = id
		c.Send(c.RoleMessage())
		break
	}
}

func (s *Session) recordOutput(data []byte) {
	s.mu.RLock()
	rec := s.Recorder
	s.mu.RUnlock()
	if rec == nil || len(data) == 0 {
		return
	}

	cp := make([]byte, len(data))
	copy(cp, data)
	_ = rec.Record(recording.LogEntry{
		Timestamp: time.Now().UnixMicro(),
		Direction: recording.DirOutput,
		Data:      cp,
	})
}

func (s *Session) recordInput(data []byte) {
	s.mu.RLock()
	rec := s.Recorder
	s.mu.RUnlock()
	if rec == nil || len(data) == 0 {
		return
	}

	cp := make([]byte, len(data))
	copy(cp, data)
	_ = rec.Record(recording.LogEntry{
		Timestamp: time.Now().UnixMicro(),
		Direction: recording.DirInput,
		Data:      cp,
	})
}

func (s *Session) recordResize(cols, rows uint16) {
	s.mu.RLock()
	rec := s.Recorder
	s.mu.RUnlock()
	if rec == nil {
		return
	}

	data := make([]byte, 4)
	binary.BigEndian.PutUint16(data[0:2], cols)
	binary.BigEndian.PutUint16(data[2:4], rows)
	_ = rec.Record(recording.LogEntry{
		Timestamp: time.Now().UnixMicro(),
		Direction: recording.DirResize,
		Data:      data,
	})
}

// ExpiredDisconnectedClients lists reconnect-grace-expired client IDs.
func (s *Session) ExpiredDisconnectedClients(now time.Time, grace time.Duration) []string {
	if grace <= 0 {
		return nil
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	ids := make([]string, 0)
	for id, c := range s.Clients {
		if c.Connected || c.LastSeen.IsZero() {
			continue
		}
		if now.Sub(c.LastSeen) > grace {
			ids = append(ids, id)
		}
	}
	return ids
}

// ShouldCloseByTTL reports whether draining TTL has expired.
func (s *Session) ShouldCloseByTTL(now time.Time) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.State != StateDraining {
		return false
	}
	if s.drainDeadline.IsZero() {
		return false
	}
	return now.After(s.drainDeadline)
}

func (s *Session) connectedClientCountLocked() int {
	count := 0
	for _, c := range s.Clients {
		if c.Connected {
			count++
		}
	}
	return count
}

// StateString returns state as API-friendly text.
func (s *Session) StateString() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.State.String()
}

// Master returns current master client ID.
func (s *Session) Master() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.MasterID
}

// Owner returns the session owner (first master) client ID.
func (s *Session) Owner() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.OwnerID
}

// peekRingSnapshot returns a copy of the ring buffer without clearing it.
func (s *Session) peekRingSnapshot() []byte {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.ringLen == 0 {
		return nil
	}

	out := make([]byte, s.ringLen)
	for i := 0; i < s.ringLen; i++ {
		idx := (s.ringStart + i) % s.ringCap
		out[i] = s.ringBuf[idx]
	}
	return out
}

// appendRingLocked stores output in a circular buffer and overwrites oldest bytes.
func (s *Session) appendRingLocked(data []byte) {
	if s.ringCap == 0 || len(data) == 0 {
		return
	}

	for _, b := range data {
		if s.ringLen < s.ringCap {
			idx := (s.ringStart + s.ringLen) % s.ringCap
			s.ringBuf[idx] = b
			s.ringLen++
			continue
		}
		s.ringBuf[s.ringStart] = b
		s.ringStart = (s.ringStart + 1) % s.ringCap
	}
}
