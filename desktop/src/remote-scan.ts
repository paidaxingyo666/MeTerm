import { invoke } from '@tauri-apps/api/core';

import { t } from './i18n';
import { hasRemoteToken } from './remote-storage';
import type { RemoteServerInfo } from './remote';
import { getDeviceAlias } from './settings-sharing';

interface ScanService {
  name: string;
  host: string;
  port: number;
}

type ShowStatus = (msg: string, type: 'success' | 'error' | 'info') => void;
type ConnectRemote = (info: RemoteServerInfo) => Promise<void>;

const SCAN_SVG = '<svg class="remote-scan-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2"/><path d="M4.93 4.93a5 5 0 0 1 6.14 0"/><path d="M11.07 11.07a5 5 0 0 1-6.14 0"/><path d="M2.81 2.81a8 8 0 0 1 10.38 0"/><path d="M13.19 13.19a8 8 0 0 1-10.38 0"/></svg>';

export function buildScanPanel(
  container: HTMLElement,
  showStatus: ShowStatus,
  sessionList: HTMLElement,
  doConnect: ConnectRemote,
): void {
  const panel = document.createElement('div');
  panel.className = 'remote-scan-panel';

  const results = document.createElement('div');
  results.className = 'remote-scan-results';
  panel.appendChild(results);

  const footer = document.createElement('div');
  footer.className = 'remote-scan-footer';
  footer.style.display = 'none';
  panel.appendChild(footer);

  let scanAbort: AbortController | null = null;
  let isScanning = false;

  function createScanButton(small: boolean): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = small ? 'remote-scan-trigger small' : 'remote-scan-trigger';
    button.innerHTML = `${SCAN_SVG}<span>${small ? t('remoteRescan') : t('remoteScanLan')}</span>`;
    button.onclick = () => {
      if (isScanning) {
        scanAbort?.abort();
        resetScanUI();
      } else {
        void startScan();
      }
    };
    return button;
  }

  function showEmptyState(): void {
    results.innerHTML = '';
    footer.style.display = 'none';
    const emptyState = document.createElement('div');
    emptyState.className = 'remote-scan-empty-state';
    emptyState.appendChild(createScanButton(false));
    results.appendChild(emptyState);
  }

  async function startScan(): Promise<void> {
    scanAbort?.abort();
    scanAbort = new AbortController();
    isScanning = true;

    results.innerHTML = '';
    footer.style.display = 'none';
    const scanningState = document.createElement('div');
    scanningState.className = 'remote-scan-empty-state';
    const scanningButton = document.createElement('button');
    scanningButton.className = 'remote-scan-trigger scanning';
    scanningButton.innerHTML = `${SCAN_SVG}<span>${t('remoteScanScanning')}</span>`;
    scanningButton.onclick = () => {
      scanAbort?.abort();
      resetScanUI();
    };
    scanningState.appendChild(scanningButton);
    results.appendChild(scanningState);

    try {
      const raw = await invoke<string>('discover_lan');
      const data: unknown = JSON.parse(raw);
      const services = parseServices(data);

      if (services.length === 0) {
        results.innerHTML = '';
        const emptyMessage = document.createElement('div');
        emptyMessage.className = 'remote-scan-empty';
        emptyMessage.textContent = t('remoteScanEmpty');
        results.appendChild(emptyMessage);
      } else {
        results.innerHTML = '';
        for (const service of services) {
          renderScanCard(results, service, showStatus, sessionList, doConnect);
        }
      }

      footer.innerHTML = '';
      footer.style.display = '';
      footer.appendChild(createScanButton(true));
      if (services.length > 0) {
        const status = document.createElement('span');
        status.className = 'remote-scan-status';
        status.textContent = t('remoteScanFound').replace('{count}', String(services.length));
        footer.appendChild(status);
      }
    } catch (error) {
      if (scanAbort?.signal.aborted) {
        showEmptyState();
        return;
      }
      const errorMessage = String(error);
      results.innerHTML = '';
      const errorElement = document.createElement('div');
      errorElement.className = 'remote-scan-empty';
      errorElement.textContent = errorMessage.includes('not running') || errorMessage.includes('token not ready')
        ? t('remoteScanNoLocalServer')
        : `${t('remoteScanError')}: ${errorMessage}`;
      results.appendChild(errorElement);

      footer.innerHTML = '';
      footer.style.display = '';
      footer.appendChild(createScanButton(true));
    } finally {
      isScanning = false;
    }
  }

  function resetScanUI(): void {
    isScanning = false;
    showEmptyState();
  }

  showEmptyState();
  container.appendChild(panel);
}

function parseServices(data: unknown): ScanService[] {
  if (!data || typeof data !== 'object') return [];
  const services = (data as { services?: unknown }).services;
  if (!Array.isArray(services)) return [];
  return services.filter((service): service is ScanService => {
    if (!service || typeof service !== 'object') return false;
    const value = service as Record<string, unknown>;
    return typeof value.name === 'string'
      && typeof value.host === 'string'
      && typeof value.port === 'number'
      && Number.isInteger(value.port)
      && value.port > 0
      && value.port <= 65535;
  });
}

function renderScanCard(
  container: HTMLElement,
  service: ScanService,
  showStatus: ShowStatus,
  sessionList: HTMLElement,
  doConnect: ConnectRemote,
): void {
  const card = document.createElement('div');
  card.className = 'remote-scan-card';

  const info = document.createElement('div');
  info.className = 'remote-scan-card-info';
  const name = document.createElement('div');
  name.className = 'remote-scan-card-name';
  name.textContent = getDeviceAlias(service.host) || service.name;
  const address = document.createElement('div');
  address.className = 'remote-scan-card-addr';
  address.textContent = `${service.host}:${service.port}`;
  info.appendChild(name);
  info.appendChild(address);
  card.appendChild(info);

  const badge = document.createElement('span');
  badge.className = 'remote-scan-card-badge verifying';
  badge.textContent = t('remoteScanVerifying');
  card.appendChild(badge);

  const connectButton = document.createElement('button');
  connectButton.className = 'ssh-btn ssh-btn-primary';
  connectButton.textContent = t('remoteScanConnect');
  connectButton.disabled = true;
  card.appendChild(connectButton);
  container.appendChild(card);

  void verifyScanService(service, badge, connectButton);
  connectButton.onclick = () => {
    void (async () => {
      const brokeredInfo: RemoteServerInfo = {
        host: service.host,
        port: service.port,
        token: '',
        name: service.name,
        secure: true,
      };
      if (await hasRemoteToken(brokeredInfo)) {
        void doConnect({
          ...brokeredInfo,
        });
        return;
      }
      sessionList.innerHTML = '';
      showStatus(t('remoteSecurePairingUnavailable'), 'error');
    })();
  };
}

async function verifyScanService(
  service: ScanService,
  badge: HTMLElement,
  connectButton: HTMLButtonElement,
): Promise<void> {
  try {
    // Native TCP reachability check only; no credential is transmitted.
    const raw = await invoke<string>('ping_remote', { host: service.host, port: service.port });
    const data: unknown = JSON.parse(raw);
    if (data && typeof data === 'object' && (data as { service?: unknown }).service === 'meterm') {
      badge.className = 'remote-scan-card-badge verified';
      badge.textContent = t('remoteScanVerified');
      connectButton.disabled = false;
      return;
    }
  } catch { /* handled below */ }
  badge.className = 'remote-scan-card-badge failed';
  badge.textContent = t('remoteScanUnreachable');
}
