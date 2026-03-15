package api

import (
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"encoding/binary"

	"github.com/gorilla/websocket"

	"github.com/paidaxingyo666/meterm/protocol"
	"github.com/paidaxingyo666/meterm/session"
	"github.com/paidaxingyo666/meterm/terminal"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  65536,  // 64KB - increased from 4KB
	WriteBufferSize: 65536,  // 64KB - increased from 4KB
	Subprotocols:    []string{"meterm.v1"},
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		// Allow connections with no Origin header (e.g., native apps, curl)
		if origin == "" {
			return true
		}
		// Reuse the same origin whitelist as CORS middleware
		return isAllowedOrigin(origin, r.Host)
	},
}

// handleWebSocket manages connect/reconnect flow for /ws/:session-id.
//
// Reconnection flow:
//   - Client sends prior client_id as query param.
//   - Server reattaches if the client is disconnected and still within grace.
//   - Server sends MsgHello with stable client_id and role.
//   - Server flushes draining ring buffer to the reconnected client.
func handleWebSocket(sm *session.SessionManager, bm *BanManager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Check IP ban before WebSocket upgrade
		if bm != nil && bm.IsBanned(extractClientIP(r)) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}

		sessionID := strings.TrimPrefix(r.URL.Path, "/ws/")
		s, ok := sm.Get(sessionID)

		// Check session exists BEFORE upgrading to avoid resource waste on invalid IDs
		if !ok {
			http.Error(w, "session not found", http.StatusNotFound)
			return
		}

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			fmt.Printf("WebSocket upgrade failed: %v\n", err)
			return
		}

		// Limit max WebSocket message size to 16MB to prevent DoS.
		// Set immediately after upgrade, before any message processing.
		conn.SetReadLimit(16 * 1024 * 1024)

		var client *session.Client
		clientID := r.URL.Query().Get("client_id")
		mode := r.URL.Query().Get("mode")
		if clientID != "" {
			reconnected, reconnectErr := s.ReconnectClient(clientID, conn, sm.Config().ReconnectGrace)
			if reconnectErr == nil {
				client = reconnected
			}
		}

		if client == nil {
			client = session.NewClient(conn)
			if mode == "readonly" {
				client.Role = session.RoleReadOnly
			}
			if err := s.AddClient(client); err != nil {
				if err.Error() == "session is private" {
					_ = conn.WriteMessage(websocket.BinaryMessage,
						protocol.EncodeError(protocol.ErrSessionPrivate, err.Error()))
				}
				_ = conn.Close()
				return
			}
		}

		// Save connGen so the deferred RemoveClient becomes a no-op if the
		// client is reconnected (connGen incremented) before this goroutine exits.
		connGen := client.ConnGen()
		defer s.RemoveClient(client.ID, connGen)

		client.Send(protocol.EncodeHello(client.ID, client.Role.String(), 1, s.LastCols, s.LastRows))
		client.Send(client.RoleMessage())
		// Always flush output history so new/reconnecting clients can catch up
		s.FlushRingBuffer(client)
		// Nudge PTY resize to force TUI apps to redraw after ring buffer replay
		go func() {
			time.Sleep(500 * time.Millisecond)
			s.NudgeResize()
		}()

		// Track active chunked upload state per connection
		var activeUpload *uploadState
		defer func() {
			if activeUpload != nil {
				activeUpload.Close()
			}
		}()

		// Download flow-control channel: signals pause/resume/cancel to the download goroutine.
		// Buffered so sends never block the message loop.
		downloadCtrl := make(chan downloadSignal, 4)

		// Debounce MsgNudge to prevent goroutine explosion from rapid messages
		var nudgeMu sync.Mutex
		var nudgeTimer *time.Timer

		for {
			msgType, data, err := conn.ReadMessage()
			if err != nil {
				break
			}
			if msgType != websocket.BinaryMessage {
				continue
			}

			messageType, payload, err := protocol.DecodeMessage(data)
			if err != nil {
				continue
			}

			switch messageType {
			case protocol.MsgInput:
				s.HandleInput(client.ID, payload)
			case protocol.MsgResize:
				cols, rows, err := protocol.DecodeResize(payload)
				if err == nil {
					s.HandleResize(client.ID, cols, rows)
				}
			case protocol.MsgNudge:
				nudgeMu.Lock()
				if nudgeTimer != nil {
					nudgeTimer.Stop()
				}
				nudgeTimer = time.AfterFunc(200*time.Millisecond, func() {
					s.NudgeResize()
				})
				nudgeMu.Unlock()
			case protocol.MsgPing:
				handlePing(s, client)
			case protocol.MsgFileList:
				if client.Role != session.RoleMaster {
					continue
				}
				// Run in goroutine: large directories block while listing entries.
				// All writes go through client.SendBlocking → WritePump (single writer).
				payloadCopy := append([]byte(nil), payload...)
				go handleFileListWithProgress(s, client.SendBlocking, payloadCopy)
			case protocol.MsgFileDownloadStart:
				if client.Role != session.RoleMaster {
					continue
				}
				// New download: create fresh control channel (discard old signals)
				downloadCtrl = make(chan downloadSignal, 4)
				payloadCopy := append([]byte(nil), payload...)
				go handleFileDownloadChunked(s, client.SendBlocking, payloadCopy, downloadCtrl)
			case protocol.MsgFileDownloadPause:
				if client.Role != session.RoleMaster {
					continue
				}
				select {
				case downloadCtrl <- sigDownloadPause:
				default:
				}
			case protocol.MsgFileDownloadContinue:
				if client.Role != session.RoleMaster {
					continue
				}
				select {
				case downloadCtrl <- sigDownloadContinue:
				default:
				}
			case protocol.MsgFileDownloadCancel:
				if client.Role != session.RoleMaster {
					continue
				}
				select {
				case downloadCtrl <- sigDownloadCancel:
				default:
				}
			case protocol.MsgFileUploadStart:
				if client.Role != session.RoleMaster {
					continue
				}
				response, state := handleFileUploadStart(s, payload)
				activeUpload = state
				client.Send(response)
			case protocol.MsgFileUploadChunk:
				if client.Role != session.RoleMaster {
					continue
				}
				response, state := handleFileUploadChunk(s, client, payload, activeUpload)
				activeUpload = state
				client.Send(response)
			case protocol.MsgFileUploadResume:
				if client.Role != session.RoleMaster {
					continue
				}
				response, state := handleFileUploadResume(s, payload)
				activeUpload = state
				client.Send(response)
			case protocol.MsgFileDownloadResume:
				if client.Role != session.RoleMaster {
					continue
				}
				// Resume download: create fresh control channel
				downloadCtrl = make(chan downloadSignal, 4)
				payloadCopy := append([]byte(nil), payload...)
				go handleFileDownloadResume(s, client.SendBlocking, payloadCopy, downloadCtrl)
			case protocol.MsgFileOperation:
				response := handleFileOperation(s, client, payload)
				client.Send(response)
			case protocol.MsgServerInfo:
				response := handleServerInfo(s, payload)
				client.Send(response)
			case protocol.MsgSetEncoding:
				encodingName := string(payload)
				s.SetEncoding(encodingName)
			case protocol.MsgFileReadRequest:
			if client.Role != session.RoleMaster {
				continue
			}
			payloadCopy := append([]byte(nil), payload...)
			go handleFileRead(s, client.SendBlocking, payloadCopy)
		case protocol.MsgFileSaveRequest:
			if client.Role != session.RoleMaster {
				continue
			}
			payloadCopy := append([]byte(nil), payload...)
			go handleFileSave(s, client.SendBlocking, payloadCopy)
		case protocol.MsgMasterRequest:
				s.ForwardMasterRequest(client.ID)
			case protocol.MsgMasterApproval:
				if len(payload) >= 2 {
					approved := payload[0] == 1
					requesterID := string(payload[1:])
					s.HandleMasterApproval(client.ID, approved, requesterID)
				}
			case protocol.MsgMasterReclaim:
				// Only the session owner (first master) can reclaim control
				if client.ID == s.Owner() {
					_ = s.SetMaster(client.ID)
				}
			case protocol.MsgPairApproval:
				if len(payload) >= 2 && client.Role == session.RoleMaster && pairingManagerInstance != nil {
					approved := payload[0] == 1
					pairID := string(payload[1:])
					pairingManagerInstance.HandleApproval(approved, pairID)
				}
			}
		}
	}
}

// handlePing responds to MsgPing. For SSH sessions, it measures the actual
// SSH round-trip latency via a keepalive request and encodes the result (ms)
// as a 4-byte big-endian uint32 in the MsgPong payload. For local sessions,
// the payload is empty (frontend uses its own RTT measurement).
//
// If the SSH keepalive fails or times out (10s), the session is closed and
// MsgSessionEnd is broadcast so the frontend can show reconnection UI.
func handlePing(s *session.Session, client *session.Client) {
	if s.Exec.Info().Type == "ssh" {
		if sshTerm, ok := s.Term.(*terminal.SSHTerminal); ok {
			sshClient := sshTerm.SSHClient()
			start := time.Now()

			type keepaliveResult struct {
				err error
			}
			ch := make(chan keepaliveResult, 1)
			go func() {
				_, _, err := sshClient.SendRequest("keepalive@openssh.com", true, nil)
				ch <- keepaliveResult{err: err}
			}()

			select {
			case r := <-ch:
				if r.err == nil {
					rttMs := uint32(time.Since(start).Milliseconds())
					payload := make([]byte, 4)
					binary.BigEndian.PutUint32(payload, rttMs)
					client.Send(protocol.EncodeMessage(protocol.MsgPong, payload))
					return
				}
				log.Printf("[SSH] keepalive failed for session %s: %v", s.ID, r.err)
			case <-time.After(10 * time.Second):
				log.Printf("[SSH] keepalive timed out for session %s", s.ID)
			}

			// SSH connection is dead — notify clients and close session
			s.Broadcast(protocol.EncodeMessage(protocol.MsgSessionEnd, nil))
			time.Sleep(100 * time.Millisecond)
			s.Close()
			return
		}
	}
	client.Send(protocol.EncodeMessage(protocol.MsgPong, nil))
}
