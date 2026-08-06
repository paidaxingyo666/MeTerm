/**
 * remote-session-poller — 发现远端(手机)创建的会话,自动开标签 attach。
 *
 * 手机端 "+" 新建会话只存在于服务端,桌面此前无感知;手机关闭后会话进入
 * draining,桌面也无从"继续"。这里以 pair-poller 同款方式每 3s 轮询
 * /api/sessions,对"无本机客户端 && 已存在 3s 以上 && running/draining"
 * 的会话调用 TabManager.addTabForSession 静默开标签:
 *  - attach 后本端即成为 loopback 客户端,其他窗口据 has_local_client 跳过
 *    (多窗口不重复开标签);
 *  - 3s 年龄门槛避开桌面自身 addTab 的 POST→注册竞态窗口;
 *  - 手机是 master 时,桌面 attach 即以 viewer 进入镜像(HELLO 携带尺寸);
 *    手机关闭后桌面被提升 master → exitMirror 恢复自身尺寸,可无缝续用。
 */

import { TabManager } from './tabs';
import { TerminalRegistry } from './terminal';

interface RemoteSessionInfo {
  id: string;
  state: string;
  has_local_client?: boolean;
  created_at?: string;
  executor_type?: string;   // 'ssh' | 'local' | 'jumpserver';决定 Drawer 文件浏览走远端还是本地
  ssh_host?: string;        // SSH 目标(供桌面侧回填 Drawer 连接信息);非 SSH 为空
  ssh_username?: string;
  ssh_port?: number;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
/** 已处理(或处理失败)的会话,不反复尝试。 */
const handledSessionIds = new Set<string>();

export function startRemoteSessionPoller(port: number, token: string): void {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!resp.ok) return;
      const data = await resp.json();
      const now = Date.now();
      for (const s of (data.sessions || []) as RemoteSessionInfo[]) {
        if (handledSessionIds.has(s.id)) continue;
        // created = 刚建立还没有客户端连接(手机建完未连/断开早于发现),同样要接
        if (s.state !== 'created' && s.state !== 'running' && s.state !== 'draining') continue;
        if (s.has_local_client) continue;                    // 本端或其他窗口已持有
        if (TerminalRegistry.get(s.id)) continue;            // 双保险
        const age = s.created_at ? now - Date.parse(s.created_at) : Infinity;
        if (age < 3000) continue;                            // 避开本端创建竞态窗口
        handledSessionIds.add(s.id);
        console.info(`[remote-session] discovered ${s.id} (state=${s.state}, executor=${s.executor_type}), auto-attaching`);
        // SSH 会话带上服务端返回的连接信息,供桌面回填 Drawer(书签主机名/初始路径)。
        const sshInfo = (s.executor_type === 'ssh' && s.ssh_host)
          ? { host: s.ssh_host, username: s.ssh_username || '', port: s.ssh_port || 22 }
          : undefined;
        TabManager.addTabForSession(s.id, port, token, undefined, s.executor_type, sshInfo);
      }
    } catch { /* 网络错误忽略,下轮重试 */ }
  }, 3000);
}
