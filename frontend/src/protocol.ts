// Message types (0x01-0x08) - must match backend/protocol.go
export const MsgOutput = 0x01;      // PTY output stream
export const MsgInput = 0x02;       // User keyboard input
export const MsgResize = 0x03;      // Terminal window size change
export const MsgPing = 0x04;        // Heartbeat request
export const MsgPong = 0x05;        // Heartbeat response
export const MsgSessionEnd = 0x06;  // PTY process exited
export const MsgError = 0x07;       // Error notification
export const MsgRoleChange = 0x08;  // Role change notification
export const MsgHello = 0x09;       // Connection metadata (client_id, role, protocol_version)
export const MsgMasterRequest = 0x19;       // Viewer requests to become master
export const MsgMasterRequestNotify = 0x1a; // Notify current master of a master request
export const MsgMasterApproval = 0x1b;      // Master approves/denies a master request
export const MsgMasterReclaim = 0x1c;       // Master reclaims control

// Error codes - must match backend/protocol.go
export const ErrNotMaster = 0x01;         // Non-master tried to send input
export const ErrSessionNotFound = 0x02;   // Session does not exist
export const ErrInternal = 0xff;          // Internal error

/**
 * Encode a message with type and payload
 * Frame format: [type: 1 byte][payload: N bytes]
 */
export function encodeMessage(type: number, payload: Uint8Array): Uint8Array {
  const message = new Uint8Array(1 + payload.length);
  message[0] = type;
  message.set(payload, 1);
  return message;
}

/**
 * Decode a message into type and payload
 */
export function decodeMessage(data: ArrayBuffer): { type: number; payload: Uint8Array } {
  const view = new Uint8Array(data);
  if (view.length < 1) {
    throw new Error('Message too short');
  }
  return {
    type: view[0],
    payload: view.slice(1),
  };
}

/**
 * Encode terminal resize message
 * Payload: 4 bytes = cols (uint16 big-endian) + rows (uint16 big-endian)
 * Example: 80x24 → [0x00, 0x50, 0x00, 0x18]
 */
export function encodeResize(cols: number, rows: number): Uint8Array {
  const payload = new Uint8Array(4);
  // Big-endian encoding
  payload[0] = (cols >> 8) & 0xff;
  payload[1] = cols & 0xff;
  payload[2] = (rows >> 8) & 0xff;
  payload[3] = rows & 0xff;
  return encodeMessage(MsgResize, payload);
}

/**
 * Decode terminal resize payload
 */
export function decodeResize(payload: Uint8Array): { cols: number; rows: number } {
  if (payload.length !== 4) {
    throw new Error(`Invalid resize payload length: ${payload.length}`);
  }
  const cols = (payload[0] << 8) | payload[1];
  const rows = (payload[2] << 8) | payload[3];
  return { cols, rows };
}

export interface HelloMessage {
  client_id: string;
  role: string;
  protocol_version: number;
}

export function decodeHello(payload: Uint8Array): HelloMessage {
  const text = new TextDecoder().decode(payload);
  return JSON.parse(text) as HelloMessage;
}
