package session

// SessionState is the lifecycle state of a session.
//
// Valid transitions:
//   - Created -> Running (first client attaches)
//   - Running -> Draining (last connected client detaches, TTL > 0)
//   - Running -> Closed (PTY exits, DELETE, or TTL=0 and last client detaches)
//   - Draining -> Running (client reconnects before TTL)
//   - Draining -> Closed (TTL expires or DELETE)
//   - Created -> Closed (DELETE before any client)
type SessionState int

const (
	// StateCreated means the PTY exists but no client has attached yet.
	StateCreated SessionState = iota
	// StateRunning means at least one client is attached.
	StateRunning
	// StateDraining means no connected clients; output is buffered until TTL/reconnect.
	StateDraining
	// StateClosed means the session has been fully shut down.
	StateClosed
)

// String returns the human-readable state name.
func (s SessionState) String() string {
	switch s {
	case StateCreated:
		return "created"
	case StateRunning:
		return "running"
	case StateDraining:
		return "draining"
	case StateClosed:
		return "closed"
	default:
		return "unknown"
	}
}
