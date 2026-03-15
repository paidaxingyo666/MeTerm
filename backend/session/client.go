package session

import (
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/paidaxingyo666/meterm/protocol"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// ClientRole defines the privilege level of a session client.
type ClientRole int

const (
	// RoleViewer can only observe output.
	RoleViewer ClientRole = 0
	// RoleMaster can send input and resize requests.
	RoleMaster   ClientRole = 1
	RoleReadOnly ClientRole = 2
)

// String returns role name.
func (r ClientRole) String() string {
	if r == RoleMaster {
		return "master"
	}
	if r == RoleReadOnly {
		return "readonly"
	}
	return "viewer"
}

// Client represents a WebSocket participant in a session.
type Client struct {
	ID         string
	Conn       *websocket.Conn
	Role       ClientRole
	SendCh     chan []byte
	LastSeen   time.Time
	Connected  bool
	RemoteAddr string

	done    chan struct{}
	mu      sync.Mutex
	connGen uint64 // incremented on each (Re)connect; used to detect stale goroutine cleanup
}

// NewClient creates a connected client with a generated ID.
func NewClient(conn *websocket.Conn) *Client {
	var remoteAddr string
	if conn != nil {
		host, _, err := net.SplitHostPort(conn.RemoteAddr().String())
		if err != nil {
			remoteAddr = conn.RemoteAddr().String()
		} else {
			remoteAddr = host
		}
	}
	return &Client{
		ID:         uuid.New().String(),
		Conn:       conn,
		Role:       RoleViewer,
		SendCh:     make(chan []byte, 256),
		Connected:  true,
		RemoteAddr: remoteAddr,
		done:       make(chan struct{}),
		connGen:    1,
	}
}

// WritePump drains SendCh and writes binary frames to the socket.
func (c *Client) WritePump() {
	c.mu.Lock()
	conn := c.Conn
	sendCh := c.SendCh
	done := c.done
	c.mu.Unlock()

	if conn == nil || sendCh == nil || done == nil {
		return
	}

	defer conn.Close()

	for {
		select {
		case data, ok := <-sendCh:
			if !ok {
				return
			}
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
				return
			}
		case <-done:
			return
		}
	}
}

// Send enqueues a message when the client is connected.
// If the send buffer is full the client is closed (slow consumer).
func (c *Client) Send(data []byte) {
	c.mu.Lock()
	connected := c.Connected
	sendCh := c.SendCh
	c.mu.Unlock()

	if !connected || sendCh == nil {
		return
	}

	select {
	case sendCh <- data:
	default:
		c.Close()
	}
}

// SendBlocking enqueues a message, blocking until the buffer has room or the
// client disconnects. Returns false when the client is gone so callers can
// abort long-running sends (e.g. file downloads) cleanly.
// Uses recover to guard against a concurrent Close that races the select.
func (c *Client) SendBlocking(data []byte) (ok bool) {
	c.mu.Lock()
	if !c.Connected || c.SendCh == nil || c.done == nil {
		c.mu.Unlock()
		return false
	}
	sendCh := c.SendCh
	done := c.done
	c.mu.Unlock()

	defer func() {
		if r := recover(); r != nil {
			ok = false
		}
	}()

	select {
	case sendCh <- data:
		return true
	case <-done:
		return false
	}
}

// RoleMessage builds a role-change protocol frame for this client.
func (c *Client) RoleMessage() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return protocol.EncodeRoleChange(byte(c.Role))
}

// Disconnect marks client offline but keeps identity for reconnect.
func (c *Client) Disconnect() {
	c.mu.Lock()
	if !c.Connected {
		c.mu.Unlock()
		return
	}
	c.Connected = false
	c.LastSeen = time.Now()
	done := c.done
	sendCh := c.SendCh
	conn := c.Conn
	c.done = nil
	c.SendCh = nil
	c.Conn = nil
	c.mu.Unlock()

	if done != nil {
		close(done)
	}
	if sendCh != nil {
		close(sendCh)
	}
	if conn != nil {
		_ = conn.Close()
	}
}

// Reconnect attaches a new socket and restarts the write pump.
func (c *Client) Reconnect(conn *websocket.Conn) {
	c.mu.Lock()
	c.Conn = conn
	c.SendCh = make(chan []byte, 256)
	c.done = make(chan struct{})
	c.Connected = true
	c.LastSeen = time.Time{}
	c.connGen++
	c.mu.Unlock()

	go c.WritePump()
}

// ConnGen returns the current connection generation.
func (c *Client) ConnGen() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.connGen
}

// Close permanently closes the client connection state.
func (c *Client) Close() {
	c.mu.Lock()
	done := c.done
	sendCh := c.SendCh
	conn := c.Conn
	c.done = nil
	c.SendCh = nil
	c.Conn = nil
	c.Connected = false
	c.mu.Unlock()

	if done != nil {
		close(done)
	}
	if sendCh != nil {
		close(sendCh)
	}
	if conn != nil {
		_ = conn.Close()
	}
}

// String returns a readable client representation.
func (c *Client) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return fmt.Sprintf("Client{id=%s role=%s connected=%t}", c.ID, c.Role.String(), c.Connected)
}
