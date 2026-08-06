/**
 * Broker for SSH operations backed by the Rust ConnectionRegistry/secret_vault.
 *
 * The WebView supplies only a stable connection id. Rust materializes metadata
 * and credentials in-process, performs the fixed test/connect operation, and
 * returns only an outcome or session id. Vault plaintext never crosses IPC.
 */

import type { SSHConnectionConfig } from './ssh';
import {
  createSSHSession,
  loadSavedConnections,
  showHostKeyConfirmDialog,
  testSSHConnection,
} from './ssh';
import { existingConnectionId } from './connection-sync';
import { t } from './i18n';

type BrokerBackedConfig = SSHConnectionConfig & { serverConnectionId?: string };

type HostKeyChallenge = {
  error: 'host_key_unknown' | 'host_key_mismatch';
  hostname: string;
  fingerprint: string;
  key_type: string;
  message?: string;
};

type TestResult = { ok: boolean; error?: string };

function brokerConnectionId(config: SSHConnectionConfig): string | undefined {
  const explicit = (config as BrokerBackedConfig).serverConnectionId;
  return explicit || (config.name ? existingConnectionId(config.name) : undefined);
}

function matchesSavedMetadata(config: SSHConnectionConfig): boolean {
  const id = brokerConnectionId(config);
  const saved = loadSavedConnections().find((candidate) => (
    candidate.name === config.name
    || Boolean(id && candidate.serverConnectionId === id)
  ));
  if (!saved) return false;
  return saved.host === config.host
    && saved.port === config.port
    && saved.username === config.username
    && saved.authMethod === config.authMethod
    && saved.usesDesktopKeyLadder === config.usesDesktopKeyLadder
    && saved.proxyType === config.proxyType
    && saved.proxyHost === config.proxyHost
    && saved.proxyPort === config.proxyPort
    && saved.proxyUsername === config.proxyUsername
    && saved.skipShellHook === config.skipShellHook
    && saved.multiplexSftp === config.multiplexSftp;
}

/**
 * User-entered credentials and local key paths intentionally take the raw
 * connection path. Metadata-only saved connections use the id-bound Broker.
 */
export function shouldUseSavedSessionBroker(config: SSHConnectionConfig): boolean {
  return Boolean(
    brokerConnectionId(config)
      && matchesSavedMetadata(config)
      && !config.password
      && !config.privateKey
      && !config.passphrase
      && !config.proxyPassword,
  );
}

async function postSavedOperation(
  path: 'saved' | 'saved/test',
  id: string,
  ownerPort: number,
  ownerAuthToken: string,
  trustedFingerprint?: string,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${ownerPort}/api/sessions/ssh/${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ownerAuthToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id,
      trusted_fingerprint: trustedFingerprint || null,
    }),
  });
  let body: Record<string, unknown> = {};
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // The status-specific generic error below intentionally avoids echoing an
    // arbitrary non-JSON response into the UI.
  }
  return { response, body };
}

function asHostKeyChallenge(body: Record<string, unknown>): HostKeyChallenge | undefined {
  if (body.error !== 'host_key_unknown' && body.error !== 'host_key_mismatch') return undefined;
  if (typeof body.hostname !== 'string'
    || typeof body.fingerprint !== 'string'
    || typeof body.key_type !== 'string') return undefined;
  return body as HostKeyChallenge;
}

function hostKeyMismatchMessage(challenge: HostKeyChallenge): string {
  return t('sshHostKeyMismatchMsg')
    .replace('{hostname}', challenge.hostname)
    .replace('{fingerprint}', challenge.fingerprint)
    .replace('{keyType}', challenge.key_type);
}

async function confirmUnknownHost(challenge: HostKeyChallenge): Promise<boolean> {
  return showHostKeyConfirmDialog(
    challenge.hostname,
    challenge.fingerprint,
    challenge.key_type,
  );
}

export async function createSSHSessionForConfig(
  config: SSHConnectionConfig,
  ownerPort: number,
  ownerAuthToken: string,
  trustedFingerprint?: string,
): Promise<string> {
  const id = brokerConnectionId(config);
  if (!id || !shouldUseSavedSessionBroker(config)) {
    return createSSHSession(config, trustedFingerprint);
  }

  const { response, body } = await postSavedOperation(
    'saved', id, ownerPort, ownerAuthToken, trustedFingerprint,
  );
  const challenge = asHostKeyChallenge(body);
  if (challenge?.error === 'host_key_mismatch') {
    throw new Error(hostKeyMismatchMessage(challenge));
  }
  if (challenge?.error === 'host_key_unknown') {
    if (!(await confirmUnknownHost(challenge))) {
      throw new Error('Connection cancelled by user');
    }
    return createSSHSessionForConfig(
      config,
      ownerPort,
      ownerAuthToken,
      challenge.fingerprint,
    );
  }

  if (!response.ok || typeof body.id !== 'string' || !body.id) {
    const error = typeof body.error === 'string'
      ? body.error
      : `saved SSH connection failed (${response.status})`;
    throw new Error(error);
  }
  return body.id;
}

export async function testSSHConnectionForConfig(
  config: SSHConnectionConfig,
  ownerPort: number,
  ownerAuthToken: string,
  trustedFingerprint?: string,
): Promise<TestResult> {
  const id = brokerConnectionId(config);
  if (!id || !shouldUseSavedSessionBroker(config)) {
    return testSSHConnection(config, trustedFingerprint);
  }

  const { response, body } = await postSavedOperation(
    'saved/test', id, ownerPort, ownerAuthToken, trustedFingerprint,
  );
  const challenge = asHostKeyChallenge(body);
  if (challenge?.error === 'host_key_mismatch') {
    return { ok: false, error: hostKeyMismatchMessage(challenge) };
  }
  if (challenge?.error === 'host_key_unknown') {
    if (!(await confirmUnknownHost(challenge))) {
      return { ok: false, error: 'Connection cancelled by user' };
    }
    return testSSHConnectionForConfig(
      config,
      ownerPort,
      ownerAuthToken,
      challenge.fingerprint,
    );
  }

  if (!response.ok) {
    const error = typeof body.error === 'string'
      ? body.error
      : `saved SSH connection test failed (${response.status})`;
    return { ok: false, error };
  }
  return {
    ok: body.ok === true,
    error: typeof body.error === 'string' ? body.error : undefined,
  };
}
