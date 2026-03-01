export const MsgOutput = 0x01;
export const MsgInput = 0x02;
export const MsgResize = 0x03;
export const MsgPing = 0x04;
export const MsgPong = 0x05;
export const MsgSessionEnd = 0x06;
export const MsgError = 0x07;
export const MsgRoleChange = 0x08;
export const MsgHello = 0x09;

// File management messages
export const MsgFileList = 0x0a;
export const MsgFileListResp = 0x0b;
export const MsgFileUploadStart = 0x0c;
export const MsgFileUploadChunk = 0x0d;
export const MsgFileDownloadStart = 0x0e;
export const MsgFileDownloadChunk = 0x0f;
export const MsgFileOperation = 0x10;
export const MsgFileOperationResp = 0x11;
export const MsgServerInfo = 0x12;
export const MsgTransferProgress = 0x13;
export const MsgFileUploadResume = 0x14;
export const MsgFileDownloadResume = 0x15;
export const MsgFileListProgress = 0x16;
export const MsgSetEncoding = 0x17;
export const MsgNudge = 0x18;
export const MsgMasterRequest = 0x19;
export const MsgMasterRequestNotify = 0x1a;
export const MsgMasterApproval = 0x1b;
export const MsgMasterReclaim = 0x1c;
export const MsgPairNotify = 0x1d;
export const MsgPairApproval = 0x1e;

// Download flow control (client → server)
export const MsgFileDownloadPause = 0x20;
export const MsgFileDownloadContinue = 0x21;
export const MsgFileDownloadCancel = 0x22;

export const ErrNotMaster = 0x01;
export const ErrSessionNotFound = 0x02;
export const ErrSessionPrivate = 0x03;
export const ErrKicked = 0x04;
export const ErrInternal = 0xff;

export function encodeMessage(type: number, payload: Uint8Array): Uint8Array {
  const message = new Uint8Array(1 + payload.length);
  message[0] = type;
  message.set(payload, 1);
  return message;
}

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

export function encodeResize(cols: number, rows: number): Uint8Array {
  const payload = new Uint8Array(4);
  payload[0] = (cols >> 8) & 0xff;
  payload[1] = cols & 0xff;
  payload[2] = (rows >> 8) & 0xff;
  payload[3] = rows & 0xff;
  return encodeMessage(MsgResize, payload);
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

// File management types
export interface FileInfo {
  name: string;
  size: number;
  mode: string;
  mtime: number;
  is_dir: boolean;
  owner: string;
  group: string;
  is_link?: boolean;
}

export interface FileListResponse {
  path: string;
  files: FileInfo[];
}

export interface ServerInfoRequest {
  type: 'sysinfo' | 'processes';
}

export interface DiskInfo {
  mount: string;
  total: number;
  used: number;
  available: number;
}

export interface NetIfaceInfo {
  name: string;
  rx_bytes: number;
  tx_bytes: number;
}

export interface SysInfoResponse {
  type: 'sysinfo';
  hostname: string;
  os_type: string;
  os_name: string;
  kernel: string;
  arch: string;
  uptime_seconds: number;
  cpu_model: string;
  cpu_cores: number;
  cpu_usage: number;
  mem_total: number;
  mem_used: number;
  disks: DiskInfo[];
  net_ifaces?: NetIfaceInfo[];
}

export interface ProcessInfo {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  time: string;
  command: string;
}

export interface ProcessListResponse {
  type: 'processes';
  processes: ProcessInfo[];
}

export type ServerInfoResponse = SysInfoResponse | ProcessListResponse;

export interface FileOperationRequest {
  operation: 'delete' | 'rename' | 'mkdir' | 'touch' | 'stat';
  path: string;
  new_path?: string;
}

export interface ErrorResponse {
  code: string;
  message: string;
}

export interface FileListProgressResponse {
  loaded: number;
  total: number;
}
