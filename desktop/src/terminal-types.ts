import type { Terminal } from '@xterm/xterm';
import type { CanvasAddon } from '@xterm/addon-canvas';
import type { FitAddon } from '@xterm/addon-fit';
import type { LigaturesAddon } from '@xterm/addon-ligatures';
import type { WebglAddon } from '@xterm/addon-webgl';

export type SessionStatus = 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'notfound' | 'disconnected';

export interface SessionInfo {
  id: string;
  title: string;
  status: SessionStatus;
}

export interface ManagedTerminal {
  id: string;
  title: string;
  shellTitle: string;
  hasOscTitle: boolean;
  terminal: Terminal;
  thumbnailTerminal: Terminal;
  fitAddon: FitAddon;
  canvasAddon: CanvasAddon | null;
  webglAddon: WebglAddon | null;
  ligaturesAddon: LigaturesAddon | null;
  container: HTMLDivElement;
  thumbnailContainer: HTMLDivElement;
  ws: WebSocket | null;
  clientId: string | null;
  ended: boolean;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Port used for local WebSocket connection (updated on sidecar restart) */
  _port: number;
  /** Auth token for local WebSocket connection (updated on sidecar restart) */
  _token: string;
  resizeDebounce: ReturnType<typeof setTimeout> | null;
  settleTimers: ReturnType<typeof setTimeout>[];
  lastSentCols: number;
  lastSentRows: number;
  observer: ResizeObserver | null;
  onStatus: (status: SessionStatus) => void;
  onTitleChange: (title: string) => void;
  /** Count of \n bytes to filter from incoming data after SIGWINCH, 0 = disabled */
  _postResizeNewlineFilter: number;
  _postResizeFilterTimer: ReturnType<typeof setTimeout> | null;
  /** True once user has sent any input — disables post-resize \n filter */
  _hasUserInput: boolean;
  /** Suppress MsgRoleChange during cross-window tab transfer grace period */
  _transferGrace: boolean;
  /** Remote WebSocket URL override */
  remoteWsUrl?: string;
  /** Remote authentication token */
  remoteToken?: string;
  /** Whether this is a remote viewer session */
  isRemote?: boolean;
  /** Whether this session was kicked by the host */
  kicked?: boolean;
  /** Last reported OSC background color — used to detect actual theme change */
  _lastOscBg?: string;
  /** OSC 7766 marker resolvers — key is marker ID, value resolves with exit code */
  _oscMarkerResolvers: Map<string, (exitCode: number) => void>;
  /** Shell integration state — tracked via OSC 7768 prompt hook */
  shellState: {
    phase: 'unknown' | 'ready' | 'agent_executing' | 'user_active';
    lastExitCode: number;
    cwd: string;
    hookInjected: boolean;
    lastInputSource: 'none' | 'agent' | 'user';
    lastUserInputAt: number;
    agentCommandSeq: number;
  };
}
