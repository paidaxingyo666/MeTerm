/**
 * drawer-system-info.ts
 * 系统信息渲染相关：网络图表、进程列表、系统监控、格式化辅助函数
 * 从 drawer.ts 中提取，供 DrawerManagerClass 委托调用。
 */

import type { SysInfoResponse, ProcessListResponse, ServerInfoResponse, NetIfaceInfo } from './protocol';
import { t } from './i18n';
import { escapeHtml } from './status-bar';

export interface NetRatePoint {
  ts: number;
  rxRate: number;
  txRate: number;
}

/** DrawerInstance 中系统信息相关的字段子集 */
export interface SysInfoFields {
  sessionId: string;
  element: HTMLDivElement;
  sysInfo: SysInfoResponse | null;
  prevNetIfaces: NetIfaceInfo[] | null;
  prevNetTimestamp: number;
  netHistory: Map<string, NetRatePoint[]>;
  selectedNic: string;
}

export function updateNetHistory(instance: SysInfoFields, ifaces: NetIfaceInfo[]): void {
  const now = Date.now();
  if (instance.prevNetIfaces && instance.prevNetTimestamp > 0) {
    const dt = (now - instance.prevNetTimestamp) / 1000;
    if (dt > 0) {
      for (const iface of ifaces) {
        const prev = instance.prevNetIfaces.find(p => p.name === iface.name);
        if (prev) {
          const rxRate = Math.max(0, (iface.rx_bytes - prev.rx_bytes) / dt);
          const txRate = Math.max(0, (iface.tx_bytes - prev.tx_bytes) / dt);
          const history = instance.netHistory.get(iface.name) || [];
          history.push({ ts: now, rxRate, txRate });
          if (history.length > 60) history.shift();
          instance.netHistory.set(iface.name, history);
        }
      }
    }
  }
  instance.prevNetIfaces = ifaces;
  instance.prevNetTimestamp = now;

  // Auto-select first NIC if not set
  if (!instance.selectedNic && ifaces.length > 0) {
    instance.selectedNic = ifaces[0].name;
  }
}

export function formatUptime(seconds: number): string {
  if (seconds <= 0) return '-';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatRate(bytesPerSec: number): string {
  return formatBytes(bytesPerSec) + '/s';
}

export function renderNetChart(instance: SysInfoFields): string {
  const ifaces = instance.prevNetIfaces || [];
  if (ifaces.length === 0) return '';

  const nic = instance.selectedNic;
  const history = instance.netHistory.get(nic) || [];

  const nicOptions = ifaces.map(i =>
    `<option value="${i.name}"${i.name === nic ? ' selected' : ''}>${i.name}</option>`
  ).join('');

  let lastRx = 0, lastTx = 0;
  if (history.length > 0) {
    const last = history[history.length - 1];
    lastRx = last.rxRate;
    lastTx = last.txRate;
  }

  let chartSvg = '';
  if (history.length >= 2) {
    const maxPoints = 60;
    const W = 200;
    const H = 50;
    const points = history.slice(-maxPoints);
    const maxRate = Math.max(...points.map(p => Math.max(p.rxRate, p.txRate)), 1024);
    const xStep = W / (maxPoints - 1);
    const offset = maxPoints - points.length;

    const toY = (v: number) => H - (v / maxRate) * (H - 4) - 2;

    const rxPts = points.map((p, i) => `${(offset + i) * xStep},${toY(p.rxRate)}`).join(' ');
    const txPts = points.map((p, i) => `${(offset + i) * xStep},${toY(p.txRate)}`).join(' ');

    chartSvg = `<svg class="net-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <polyline points="${rxPts}" fill="none" stroke="#4ade80" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
      <polyline points="${txPts}" fill="none" stroke="#f59e0b" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    </svg>`;
  } else {
    chartSvg = '<div class="net-chart-empty">...</div>';
  }

  return `<div class="server-info-item net-chart-section" data-session="${instance.sessionId}">
    <div class="server-info-label net-chart-header">
      ${t('serverInfoNetwork')}
      <select class="net-nic-select" data-session="${instance.sessionId}">${nicOptions}</select>
    </div>
    <div class="net-chart-container">${chartSvg}</div>
    <div class="net-chart-legend">
      <span class="net-rx">↓ ${formatRate(lastRx)}</span>
      <span class="net-tx">↑ ${formatRate(lastTx)}</span>
    </div>
  </div>`;
}

export function renderProgressBar(percent: number): string {
  const pct = Math.max(0, Math.min(100, percent));
  const colorClass = pct > 90 ? 'critical' : pct > 70 ? 'warning' : '';
  return `<div class="sysinfo-progress ${colorClass}"><div class="sysinfo-progress-fill" style="width:${pct}%"></div><span class="sysinfo-progress-text">${pct.toFixed(0)}%</span></div>`;
}

export function renderSysInfo(instance: SysInfoFields): void {
  const info = instance.sysInfo;
  if (!info) return;

  const serverInfoEl = instance.element.querySelector(`#server-info-${instance.sessionId}`) as HTMLElement;
  if (!serverInfoEl) return;

  const memPercent = info.mem_total > 0 ? (info.mem_used / info.mem_total) * 100 : 0;

  // Keep existing connection info (host/user) at the top
  const existingConn = serverInfoEl.querySelector('.server-info-conn');
  const connHtml = existingConn ? existingConn.outerHTML : '';

  const disksHtml = (info.disks || []).map(d => {
    const pct = d.total > 0 ? (d.used / d.total) * 100 : 0;
    return `<div class="server-info-item">
      <div class="server-info-label">${t('serverInfoDisk')} ${escapeHtml(String(d.mount))}</div>
      <div class="server-info-value server-info-value-small">${formatBytes(d.used)} / ${formatBytes(d.total)}</div>
      ${renderProgressBar(pct)}
    </div>`;
  }).join('');

  serverInfoEl.innerHTML = `
    ${connHtml}
    <div class="server-info-item">
      <div class="server-info-label">${t('serverInfoOS')}</div>
      <div class="server-info-value">${escapeHtml(String(info.os_name || info.os_type))}</div>
    </div>
    <div class="server-info-item">
      <div class="server-info-label">${t('serverInfoKernel')}</div>
      <div class="server-info-value">${escapeHtml(String(info.kernel))} ${escapeHtml(String(info.arch))}</div>
    </div>
    <div class="server-info-item">
      <div class="server-info-label">${t('serverInfoUptime')}</div>
      <div class="server-info-value">${formatUptime(info.uptime_seconds)}</div>
    </div>
    <div class="server-info-item">
      <div class="server-info-label">${t('serverInfoCPU')} · ${escapeHtml(String(info.cpu_cores))} cores</div>
      <div class="server-info-value server-info-value-small">${escapeHtml(String(info.cpu_model))}</div>
      ${renderProgressBar(info.cpu_usage)}
    </div>
    <div class="server-info-item">
      <div class="server-info-label">${t('serverInfoMemory')}</div>
      <div class="server-info-value server-info-value-small">${formatBytes(info.mem_used)} / ${formatBytes(info.mem_total)}</div>
      ${renderProgressBar(memPercent)}
    </div>
    ${renderNetChart(instance)}
    ${disksHtml}
  `;

  // Bind NIC selector event after innerHTML update
  const nicSelect = serverInfoEl.querySelector(`.net-nic-select[data-session="${instance.sessionId}"]`) as HTMLSelectElement;
  if (nicSelect) {
    nicSelect.addEventListener('change', () => {
      instance.selectedNic = nicSelect.value;
      renderSysInfo(instance);
    });
  }

  // 仅在文本被截断时显示 tooltip
  serverInfoEl.querySelectorAll('.server-info-value, .server-info-value-small, .server-info-label').forEach((el) => {
    el.addEventListener('mouseenter', () => {
      const htmlEl = el as HTMLElement;
      if (htmlEl.scrollWidth > htmlEl.clientWidth) {
        htmlEl.title = htmlEl.textContent || '';
      } else {
        htmlEl.removeAttribute('title');
      }
    });
  });
}

export function renderProcessList(instance: SysInfoFields, data: ProcessListResponse): void {
  const tbody = instance.element.querySelector(`#process-list-${instance.sessionId}`) as HTMLElement;
  if (!tbody) return;

  tbody.innerHTML = data.processes.map(p => `
    <tr>
      <td>${p.pid}</td>
      <td class="process-name">${escapeHtml(String(p.command))}</td>
      <td>${escapeHtml(String(p.user))}</td>
      <td class="${p.cpu > 50 ? 'high-usage' : ''}">${p.cpu.toFixed(1)}</td>
      <td class="${p.mem > 50 ? 'high-usage' : ''}">${p.mem.toFixed(1)}</td>
      <td>${escapeHtml(String(p.time))}</td>
    </tr>
  `).join('');

  // 仅在文本被截断时显示 tooltip
  tbody.querySelectorAll('td').forEach((td) => {
    td.addEventListener('mouseenter', () => {
      if (td.scrollWidth > td.clientWidth) {
        td.title = td.textContent || '';
      } else {
        td.removeAttribute('title');
      }
    });
  });
}

export function handleServerInfoResponse(instance: SysInfoFields, data: ServerInfoResponse): void {
  if (data.type === 'sysinfo') {
    const sysInfo = data as SysInfoResponse;
    instance.sysInfo = sysInfo;
    updateNetHistory(instance, sysInfo.net_ifaces || []);
    renderSysInfo(instance);
  } else if (data.type === 'processes') {
    renderProcessList(instance, data as ProcessListResponse);
  }
}
