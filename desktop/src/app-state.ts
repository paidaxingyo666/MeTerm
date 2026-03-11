/**
 * app-state.ts — Global application state variables and types.
 * Extracted from main.ts to reduce file size and improve modularity.
 */
import type { AppSettings } from './themes';
import type { SSHConnectionConfig } from './ssh';
import type { RemoteServerInfo } from './remote';
import type { JumpServerConfig, JumpServerAsset, JumpServerAccount } from './jumpserver-api';

// ── Core connection state ──
export let port = 0;
export let authToken = '';
export let metermReady = false;

export function setPort(v: number): void { port = v; }
export function setAuthToken(v: string): void { authToken = v; }
export function setMetermReady(v: boolean): void { metermReady = v; }

// ── Pair request deduplication and polling ──
export const handledPairIds = new Set<string>();
export let pairPollTimer: ReturnType<typeof setInterval> | null = null;
export function setPairPollTimer(v: ReturnType<typeof setInterval> | null): void { pairPollTimer = v; }

// ── Settings ──
export let settings: AppSettings;
export function setSettings(s: AppSettings): void { settings = s; }

// ── View state ──
export let isHomeView = true;
export let isGalleryView = false;
export function setIsHomeView(v: boolean): void { isHomeView = v; }
export function setIsGalleryView(v: boolean): void { isGalleryView = v; }

export type ViewMode = 'home' | 'gallery' | 'terminal';

export let isQuitFlowRunning = false;
export function setIsQuitFlowRunning(v: boolean): void { isQuitFlowRunning = v; }

// ── Session maps ──
export const sshConfigMap = new Map<string, SSHConnectionConfig>();
export const remoteInfoMap = new Map<string, RemoteServerInfo>();
export const sessionProgressMap = new Map<string, { state: number; percent: number }>();
export const remoteTabNumbers = new Map<string, number>();
export const jumpServerConfigMap = new Map<string, {
  config: JumpServerConfig;
  asset: JumpServerAsset;
  account: JumpServerAccount;
}>();
// Active (authenticated) JumpServer connections — keyed by config name
export const activeJumpServers = new Map<string, JumpServerConfig>();

export let nextRemoteTabNumber = 1;
export function setNextRemoteTabNumber(v: number): void { nextRemoteTabNumber = v; }
export function incrementNextRemoteTabNumber(): number { return nextRemoteTabNumber++; }

// ── Platform detection ──
export const ua = navigator.userAgent.toLowerCase();
export const isWindowsPlatform = ua.includes('windows');
export const isMacPlatform = ua.includes('macintosh') || ua.includes('mac os');
document.documentElement.classList.toggle('platform-windows', isWindowsPlatform);
document.documentElement.classList.toggle('platform-macos', isMacPlatform);
document.documentElement.classList.toggle('platform-linux', !isWindowsPlatform && !isMacPlatform);
