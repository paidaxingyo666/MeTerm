package protocol

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
)

// Message types for the binary WebSocket protocol.
//
// Frame format:
//   - Byte 0: message type
//   - Bytes 1..N: payload
const (
	MsgOutput     byte = 0x01 // PTY output stream
	MsgInput      byte = 0x02 // User keyboard input
	MsgResize     byte = 0x03 // Terminal window size change
	MsgPing       byte = 0x04 // Heartbeat request
	MsgPong       byte = 0x05 // Heartbeat response
	MsgSessionEnd byte = 0x06 // PTY process exited
	MsgError      byte = 0x07 // Error notification
	MsgRoleChange byte = 0x08 // Role change notification
	MsgHello      byte = 0x09 // Initial handshake / reconnection metadata
	MsgNudge               byte = 0x18 // Request PTY nudge resize (triggers SIGWINCH)
	MsgMasterRequest       byte = 0x19 // Viewer requests to become master
	MsgMasterRequestNotify byte = 0x1A // Notify current master of a master request
	MsgMasterApproval      byte = 0x1B // Master approves/denies a master request
	MsgMasterReclaim       byte = 0x1C // Master reclaims control
	MsgPairNotify          byte = 0x1D // Pairing request notification (server → master)
	MsgPairApproval        byte = 0x1E // Pairing approval result (master → server)
)

// Error codes in MsgError payloads.
const (
	ErrNotMaster        byte = 0x01
	ErrSessionNotFound  byte = 0x02
	ErrSessionPrivate   byte = 0x03
	ErrKicked           byte = 0x04
	ErrInternal         byte = 0xFF
)

// EncodeMessage builds a protocol frame.
func EncodeMessage(msgType byte, payload []byte) []byte {
	msg := make([]byte, 1+len(payload))
	msg[0] = msgType
	copy(msg[1:], payload)
	return msg
}

// DecodeMessage parses a protocol frame.
func DecodeMessage(data []byte) (msgType byte, payload []byte, err error) {
	if len(data) < 1 {
		return 0, nil, errors.New("message too short")
	}
	return data[0], data[1:], nil
}

// EncodeResize encodes terminal resize data.
// Payload format: [cols:uint16 big-endian][rows:uint16 big-endian].
func EncodeResize(cols, rows uint16) []byte {
	payload := make([]byte, 4)
	binary.BigEndian.PutUint16(payload[0:2], cols)
	binary.BigEndian.PutUint16(payload[2:4], rows)
	return EncodeMessage(MsgResize, payload)
}

// DecodeResize decodes terminal resize payload.
func DecodeResize(payload []byte) (cols, rows uint16, err error) {
	if len(payload) != 4 {
		return 0, 0, fmt.Errorf("invalid resize payload length: %d", len(payload))
	}
	cols = binary.BigEndian.Uint16(payload[0:2])
	rows = binary.BigEndian.Uint16(payload[2:4])
	return cols, rows, nil
}

// EncodeError encodes an error frame payload.
// Payload format: [code:1 byte][message:utf-8 bytes].
func EncodeError(code byte, message string) []byte {
	payload := make([]byte, 1+len(message))
	payload[0] = code
	copy(payload[1:], []byte(message))
	return EncodeMessage(MsgError, payload)
}

// EncodeRoleChange encodes role updates.
// Payload format: [role:1 byte] where 0=viewer, 1=master, 2=readonly.
func EncodeRoleChange(role byte) []byte {
	if role > 2 {
		role = 0
	}
	return EncodeMessage(MsgRoleChange, []byte{role})
}

// EncodeMasterRequestNotify builds a master request notification frame.
// Payload JSON format: {"requester_id":"uuid","session_id":"uuid"}
func EncodeMasterRequestNotify(requesterID, sessionID string) []byte {
	payload, _ := json.Marshal(map[string]string{
		"requester_id": requesterID,
		"session_id":   sessionID,
	})
	return EncodeMessage(MsgMasterRequestNotify, payload)
}

// EncodeMasterApprovalResponse builds a role-change or denial notification for the requester.
// When denied, it sends MsgError with ErrNotMaster code and a denial message.
func EncodeMasterDenied() []byte {
	return EncodeError(ErrNotMaster, "master request denied")
}

// EncodePairNotify builds a pairing request notification frame.
// Payload JSON format: {"pair_id":"uuid","device_info":"...","remote_addr":"..."}
func EncodePairNotify(pairID, deviceInfo, remoteAddr string) []byte {
	payload, _ := json.Marshal(map[string]string{
		"pair_id":     pairID,
		"device_info": deviceInfo,
		"remote_addr": remoteAddr,
	})
	return EncodeMessage(MsgPairNotify, payload)
}

// EncodeHello encodes connection metadata for initial connect/reconnect.
// Payload JSON format:
// {"client_id":"uuid","role":"master|viewer","protocol_version":1,"cols":120,"rows":40}
func EncodeHello(clientID, role string, protocolVersion int, cols, rows uint16) []byte {
	payload, err := json.Marshal(map[string]interface{}{
		"client_id":        clientID,
		"role":             role,
		"protocol_version": protocolVersion,
		"cols":             cols,
		"rows":             rows,
	})
	if err != nil {
		payload = []byte(`{"client_id":"","role":"viewer","protocol_version":1}`)
	}
	return EncodeMessage(MsgHello, payload)
}
