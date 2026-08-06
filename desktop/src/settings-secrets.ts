/**
 * Opaque native credential broker for AI providers and SearXNG.
 *
 * Saved credential bytes never return to the WebView. JavaScript keeps only
 * presence flags plus replacement values while the user is actively editing
 * them. Rust binds each credential to its provider type and canonical base URL.
 */

import { invoke } from '@tauri-apps/api/core';

export const SETTINGS_STORAGE_KEY = 'meterm-settings';
export const SETTINGS_SECRET_PRESENCE_STORAGE_KEY = 'meterm-settings-secret-presence-v1';

const SETTINGS_SECRET_FAILURE_STORAGE_KEY = 'meterm-settings-secret-initialization-failed-v1';
const SETTINGS_SECRET_PRESENCE_VERSION = 1;

const MAX_SECRET_LENGTH = 65_536;
const MAX_PROVIDER_ID_LENGTH = 256;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/u;

interface ProviderLike {
  id: string;
  type: string;
  baseUrl: string;
  apiKey?: string;
  hasApiKey?: boolean;
  clearApiKey?: boolean;
}

interface SecretBearingSettings {
  aiProviders: ProviderLike[];
  searxngUrl: string;
  searxngUsername: string;
  searxngPassword: string;
  searxngHasPassword?: boolean;
  searxngClearPassword?: boolean;
}

interface NativeProviderSecretInput {
  id: string;
  providerType: string;
  baseUrl: string;
  replacement?: string;
}

interface NativeSettingsSecretsRequest {
  providers: NativeProviderSecretInput[];
  searxng: {
    baseUrl: string;
    username: string;
    replacement?: string;
  };
}

interface NativeSecretPresence {
  providerIds: string[];
  hasSearxngPassword: boolean;
}

interface CachedSecretPresence extends NativeSecretPresence {
  version: typeof SETTINGS_SECRET_PRESENCE_VERSION;
}

export type SettingsSecretInitializationMode = 'startup' | 'settings';

interface PlaintextSecrets {
  providerKeys: Record<string, string>;
  searxngPassword: string;
  hasSensitiveFields: boolean;
  hasUnmigratableValue: boolean;
}

interface ProviderMetadata {
  id: string;
  type: string;
  baseUrl: string;
}

let presenceCache: NativeSecretPresence | null = null;
let initializationPromise: Promise<void> | null = null;
let writeTail: Promise<void> = Promise.resolve();
let settingsSessionAllowsNativeWrites = false;
let pendingInitializationRetry = false;
let committedMetadataSnapshot: string | null = null;

const DEFAULT_PROVIDERS: ProviderMetadata[] = [
  { id: 'openai', type: 'openai', baseUrl: 'https://api.openai.com' },
  { id: 'anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { id: 'gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeProviderId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PROVIDER_ID_LENGTH
    && !CONTROL_CHARACTER_RE.test(value);
}

function normalizePresence(value: unknown): NativeSecretPresence | null {
  if (!isRecord(value)
    || value.version !== SETTINGS_SECRET_PRESENCE_VERSION
    || !Array.isArray(value.providerIds)
    || value.providerIds.length > 128
    || typeof value.hasSearxngPassword !== 'boolean') return null;

  const providerIds = value.providerIds.filter(isSafeProviderId);
  if (providerIds.length !== value.providerIds.length || new Set(providerIds).size !== providerIds.length) {
    return null;
  }
  return {
    providerIds: [...providerIds].sort(),
    hasSearxngPassword: value.hasSearxngPassword,
  };
}

function readStoredSettings(): unknown {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    return raw ? JSON.parse(raw) as unknown : null;
  } catch {
    return null;
  }
}

/** Load only non-sensitive presence flags; safe for ordinary secondary windows. */
export function hydrateSettingsSecretPresenceFromStorage(): boolean {
  try {
    const raw = localStorage.getItem(SETTINGS_SECRET_PRESENCE_STORAGE_KEY);
    const result = raw ? normalizePresence(JSON.parse(raw) as unknown) : null;
    if (!result) return false;
    presenceCache = result;
    return true;
  } catch {
    return false;
  }
}

function persistPresence(result: NativeSecretPresence): void {
  const normalized = normalizePresence({
    ...result,
    version: SETTINGS_SECRET_PRESENCE_VERSION,
  });
  if (!normalized) throw new Error('invalid native settings credential presence');
  const cached: CachedSecretPresence = {
    version: SETTINGS_SECRET_PRESENCE_VERSION,
    ...normalized,
  };
  localStorage.setItem(SETTINGS_SECRET_PRESENCE_STORAGE_KEY, JSON.stringify(cached));
  presenceCache = normalized;
}

function initializationFailedPreviously(): boolean {
  try {
    return localStorage.getItem(SETTINGS_SECRET_FAILURE_STORAGE_KEY) === '1';
  } catch {
    return true;
  }
}

function markInitializationFailed(): void {
  pendingInitializationRetry = true;
  try { localStorage.setItem(SETTINGS_SECRET_FAILURE_STORAGE_KEY, '1'); } catch { /* best effort */ }
}

function clearInitializationFailure(): void {
  pendingInitializationRetry = false;
  try { localStorage.removeItem(SETTINGS_SECRET_FAILURE_STORAGE_KEY); } catch { /* best effort */ }
}

function asSecret(value: unknown): string {
  return typeof value === 'string' && value.length <= MAX_SECRET_LENGTH ? value : '';
}

function providerMetadata(value: unknown): ProviderMetadata[] {
  if (isRecord(value) && Array.isArray(value.aiProviders)) {
    const providers = value.aiProviders.flatMap((candidate): ProviderMetadata[] => {
      if (!isRecord(candidate)
        || !isSafeProviderId(candidate.id)
        || !['openai', 'anthropic', 'gemini'].includes(String(candidate.type))
        || typeof candidate.baseUrl !== 'string') return [];
      return [{ id: candidate.id, type: String(candidate.type), baseUrl: candidate.baseUrl }];
    });
    if (providers.length > 0) return providers;
  }

  const providers = DEFAULT_PROVIDERS.map(provider => ({ ...provider }));
  if (isRecord(value) && typeof value.aiProviderType === 'string') {
    const legacy = providers.find(provider => provider.type === value.aiProviderType);
    if (legacy && typeof value.aiBaseUrl === 'string' && value.aiBaseUrl) {
      legacy.baseUrl = value.aiBaseUrl;
    }
  }
  return providers;
}

function scanPlaintextSecrets(value: unknown, providers: ProviderMetadata[]): PlaintextSecrets {
  const providerKeys: Record<string, string> = {};
  if (!isRecord(value)) {
    return {
      providerKeys,
      searxngPassword: '',
      hasSensitiveFields: false,
      hasUnmigratableValue: false,
    };
  }

  let hasSensitiveFields = Object.prototype.hasOwnProperty.call(value, 'searxngPassword')
    || Object.prototype.hasOwnProperty.call(value, 'aiApiKey');
  let hasUnmigratableValue = false;
  if (Array.isArray(value.aiProviders)) {
    const idCounts = new Map<string, number>();
    for (const provider of value.aiProviders) {
      if (isRecord(provider) && isSafeProviderId(provider.id)) {
        idCounts.set(provider.id, (idCounts.get(provider.id) ?? 0) + 1);
      }
    }
    for (const provider of value.aiProviders) {
      if (!isRecord(provider)) continue;
      if (!Object.prototype.hasOwnProperty.call(provider, 'apiKey')) continue;
      hasSensitiveFields = true;
      if (typeof provider.apiKey !== 'string') {
        hasUnmigratableValue = true;
        continue;
      }
      if (!provider.apiKey) continue;
      if (!isSafeProviderId(provider.id)) {
        hasUnmigratableValue = true;
        continue;
      }
      const id = provider.id;
      const hasUsableMetadata = idCounts.get(id) === 1
        && typeof provider.type === 'string'
        && ['openai', 'anthropic', 'gemini'].includes(provider.type)
        && typeof provider.baseUrl === 'string'
        && Boolean(provider.baseUrl.trim());
      if (!hasUsableMetadata || provider.apiKey.length > MAX_SECRET_LENGTH) {
        hasUnmigratableValue = true;
        continue;
      }
      providerKeys[id] = provider.apiKey;
    }
  }

  if (Object.prototype.hasOwnProperty.call(value, 'aiApiKey')) {
    if (typeof value.aiApiKey !== 'string') {
      hasUnmigratableValue = true;
    } else if (value.aiApiKey) {
      const oldType = typeof value.aiProviderType === 'string' ? value.aiProviderType : 'openai';
      const targets = providers.filter(candidate => candidate.type === oldType
        && Boolean(candidate.baseUrl.trim()));
      if (value.aiApiKey.length > MAX_SECRET_LENGTH || targets.length !== 1) {
        hasUnmigratableValue = true;
      } else {
        providerKeys[targets[0].id] = value.aiApiKey;
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'searxngPassword')) {
    if (typeof value.searxngPassword !== 'string') {
      hasUnmigratableValue = true;
    } else if (value.searxngPassword
      && (value.searxngPassword.length > MAX_SECRET_LENGTH
        || typeof value.searxngUrl !== 'string'
        || !value.searxngUrl.trim())) {
      hasUnmigratableValue = true;
    }
  }
  return {
    providerKeys,
    searxngPassword: asSecret(value.searxngPassword),
    hasSensitiveFields,
    hasUnmigratableValue,
  };
}

function sanitizedSettings(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const sanitized: Record<string, unknown> = { ...value };
  if (Array.isArray(value.aiProviders)) {
    sanitized.aiProviders = value.aiProviders.map((provider) => {
      if (!isRecord(provider)) return provider;
      const copy: Record<string, unknown> = { ...provider };
      delete copy.apiKey;
      delete copy.hasApiKey;
      delete copy.clearApiKey;
      return copy;
    });
  }
  delete sanitized.searxngPassword;
  delete sanitized.searxngHasPassword;
  delete sanitized.searxngClearPassword;
  delete sanitized.aiApiKey;
  return sanitized;
}

/**
 * Keep an unsuccessful legacy plaintext migration's one existing copy. New
 * values typed in the settings UI are never added to Web Storage.
 */
function preserveExistingPlaintext(sanitized: unknown): unknown {
  const existing = readStoredSettings();
  if (!isRecord(sanitized) || !isRecord(existing)) return sanitized;

  const preserved: Record<string, unknown> = { ...sanitized };
  for (const key of ['aiApiKey', 'aiProviderType', 'aiBaseUrl'] as const) {
    if (Object.prototype.hasOwnProperty.call(existing, key)) preserved[key] = existing[key];
  }
  if (Object.prototype.hasOwnProperty.call(existing, 'searxngPassword')) {
    preserved.searxngPassword = existing.searxngPassword;
  }

  if (Array.isArray(existing.aiProviders)) {
    const plaintext = scanPlaintextSecrets(existing, providerMetadata(existing));
    if (plaintext.hasUnmigratableValue) {
      // Ambiguous/invalid records cannot be joined by id without overwriting a
      // different credential. Preserve the source array losslessly until an
      // explicit recovery flow can resolve it.
      preserved.aiProviders = existing.aiProviders.map(provider => (
        isRecord(provider) ? { ...provider } : provider
      ));
      return preserved;
    }
    const nextProviders = Array.isArray(preserved.aiProviders)
      ? preserved.aiProviders.map(provider => isRecord(provider) ? { ...provider } : provider)
      : [];
    for (const oldProvider of existing.aiProviders) {
      if (!isRecord(oldProvider) || !Object.prototype.hasOwnProperty.call(oldProvider, 'apiKey')) continue;
      const index = nextProviders.findIndex(provider => isRecord(provider)
        && isSafeProviderId(provider.id)
        && provider.id === oldProvider.id);
      if (index >= 0 && isRecord(nextProviders[index])) {
        nextProviders[index] = { ...nextProviders[index], apiKey: oldProvider.apiKey };
      } else {
        nextProviders.push({ ...oldProvider });
      }
    }
    preserved.aiProviders = nextProviders;
  }
  return preserved;
}

/** Remove credential inputs and derived presence flags before Web Storage. */
export function stripSettingsSecretsForStorage(value: unknown): unknown {
  const sanitized = sanitizedSettings(value);
  const existing = readStoredSettings();
  const plaintext = scanPlaintextSecrets(existing, providerMetadata(existing));
  // This direct source scan also closes the race where a secondary window saves
  // before the primary window has persisted the manual/failure latch.
  return plaintext.hasSensitiveFields ? preserveExistingPlaintext(sanitized) : sanitized;
}

function scrubLocalSettingsSecrets(value: unknown): void {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(sanitizedSettings(value)));
}

function requestForMetadata(
  value: unknown,
  providers: ProviderMetadata[],
  plaintext: PlaintextSecrets,
): NativeSettingsSecretsRequest {
  const raw = isRecord(value) ? value : {};
  return {
    providers: providers.filter(provider => provider.baseUrl.trim()).map(provider => ({
      id: provider.id,
      providerType: provider.type,
      baseUrl: provider.baseUrl,
      ...(plaintext.providerKeys[provider.id]
        ? { replacement: plaintext.providerKeys[provider.id] }
        : {}),
    })),
    searxng: {
      baseUrl: typeof raw.searxngUrl === 'string' ? raw.searxngUrl : '',
      username: typeof raw.searxngUsername === 'string' ? raw.searxngUsername : '',
      ...(plaintext.searxngPassword ? { replacement: plaintext.searxngPassword } : {}),
    },
  };
}

function metadataSnapshot(request: NativeSettingsSecretsRequest): string {
  return JSON.stringify({
    providers: request.providers.map(({ id, providerType, baseUrl }) => ({
      id,
      providerType,
      baseUrl,
    })),
    searxng: {
      baseUrl: request.searxng.baseUrl,
      username: request.searxng.username,
    },
  });
}

function hasExplicitReplacement(request: NativeSettingsSecretsRequest): boolean {
  return request.providers.some(provider => provider.replacement !== undefined)
    || request.searxng.replacement !== undefined;
}

/**
 * Migrate legacy values and refresh only native presence flags. Saved secrets
 * are never materialized in JavaScript.
 */
export async function initializeSettingsSecrets(
  mode: SettingsSecretInitializationMode = 'startup',
): Promise<void> {
  const cached = hydrateSettingsSecretPresenceFromStorage();
  const stored = readStoredSettings();
  const providers = providerMetadata(stored);
  const plaintext = scanPlaintextSecrets(stored, providers);

  // Cold startup is strictly Web-Storage-only. It must never touch Keychain,
  // even on the first run or when a cache is missing. Legacy plaintext remains
  // in its sole existing location until the user explicitly opens Settings.
  if (mode === 'startup') {
    if (!cached) {
      try {
        persistPresence({ providerIds: [], hasSearxngPassword: false });
      } catch {
        presenceCache = { providerIds: [], hasSearxngPassword: false };
      }
    }
    if (plaintext.hasSensitiveFields) markInitializationFailed();
    return;
  }

  pendingInitializationRetry = initializationFailedPreviously();
  settingsSessionAllowsNativeWrites = true;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    if (mode === 'settings') await flushSettingsSecrets().catch(() => {});
    if (plaintext.hasUnmigratableValue) {
      markInitializationFailed();
      console.warn('[settings] Legacy plaintext credential exceeds the migration limit');
      return;
    }
    try {
      const request = requestForMetadata(stored, providers, plaintext);
      const result = await invoke<NativeSecretPresence>('initialize_settings_secrets', {
        request,
      });
      if (plaintext.hasSensitiveFields && stored !== null) scrubLocalSettingsSecrets(stored);
      persistPresence(result);
      committedMetadataSnapshot = metadataSnapshot(request);
      clearInitializationFailure();
    } catch (error) {
      // Keep the only legacy plaintext copy until the native write succeeds.
      // Startup will not retry until the user explicitly opens Settings.
      markInitializationFailed();
      console.warn('[settings] Native credential broker initialization failed:', error);
    }
  })();

  try {
    await initializationPromise;
  } finally {
    initializationPromise = null;
  }
}

/** Merge native presence flags, never credential bytes, into AppSettings. */
export function applySettingsSecrets<T extends SecretBearingSettings>(settings: T): T {
  const providerIds = new Set(presenceCache?.providerIds ?? []);
  return {
    ...settings,
    aiProviders: settings.aiProviders.map(provider => ({
      ...provider,
      apiKey: '',
      hasApiKey: providerIds.has(provider.id),
      clearApiKey: false,
    })),
    searxngPassword: '',
    searxngHasPassword: presenceCache?.hasSearxngPassword ?? false,
    searxngClearPassword: false,
  };
}

function requestForSettings(settings: SecretBearingSettings): NativeSettingsSecretsRequest {
  return {
    providers: settings.aiProviders.filter(provider => provider.baseUrl.trim()).map(provider => {
      let replacement: string | undefined;
      if (provider.clearApiKey) replacement = '';
      else if (asSecret(provider.apiKey)) replacement = provider.apiKey;
      return {
        id: provider.id,
        providerType: provider.type,
        baseUrl: provider.baseUrl,
        ...(replacement !== undefined ? { replacement } : {}),
      };
    }),
    searxng: {
      baseUrl: settings.searxngUrl,
      username: settings.searxngUsername,
      ...(
        settings.searxngClearPassword
          ? { replacement: '' }
          : asSecret(settings.searxngPassword)
            ? { replacement: settings.searxngPassword }
            : {}
      ),
    },
  };
}

function mergePendingPlaintext(
  request: NativeSettingsSecretsRequest,
  plaintext: PlaintextSecrets,
): NativeSettingsSecretsRequest {
  return {
    providers: request.providers.map(provider => ({
      ...provider,
      ...(provider.replacement === undefined && plaintext.providerKeys[provider.id]
        ? { replacement: plaintext.providerKeys[provider.id] }
        : {}),
    })),
    searxng: {
      ...request.searxng,
      ...(request.searxng.replacement === undefined && plaintext.searxngPassword
        ? { replacement: plaintext.searxngPassword }
        : {}),
    },
  };
}

/** Queue authority metadata and any user-entered replacements for Rust. */
export function updateSettingsSecrets(settings: SecretBearingSettings): void {
  // `saveSettings` is shared by terminal windows (for example, resize state).
  // Only the explicit Settings WebView may turn that generic save into a
  // Keychain mutation.
  if (!settingsSessionAllowsNativeWrites) return;
  const settingsRequest = requestForSettings(settings);
  const explicitReplacement = hasExplicitReplacement(settingsRequest);
  const retryInitialization = pendingInitializationRetry && explicitReplacement;
  if (pendingInitializationRetry && !retryInitialization) return;
  if (!presenceCache && !retryInitialization) return;
  if (!explicitReplacement
    && committedMetadataSnapshot === metadataSnapshot(settingsRequest)) return;
  let request = settingsRequest;
  if (retryInitialization) {
    const stored = readStoredSettings();
    const plaintext = scanPlaintextSecrets(stored, providerMetadata(stored));
    if (plaintext.hasUnmigratableValue) {
      writeTail = writeTail.catch(() => {}).then(() => Promise.reject(
        new Error('legacy plaintext credentials require explicit cleanup before migration'),
      ));
      return;
    }
    request = mergePendingPlaintext(settingsRequest, plaintext);
  }
  const providerReplacements = new Map(
    request.providers
      .filter(provider => provider.replacement !== undefined)
      .map(provider => [provider.id, provider.replacement]),
  );
  const searxReplacement = request.searxng.replacement;

  for (const provider of settings.aiProviders) {
    const replacement = providerReplacements.get(provider.id);
    if (replacement !== undefined) provider.hasApiKey = Boolean(replacement);
  }
  if (searxReplacement !== undefined) settings.searxngHasPassword = Boolean(searxReplacement);

  writeTail = writeTail.catch(() => {}).then(async () => {
    let result: NativeSecretPresence;
    try {
      result = await invoke<NativeSecretPresence>(
        retryInitialization ? 'initialize_settings_secrets' : 'update_settings_secrets',
        { request },
      );
      if (retryInitialization) {
        const stored = readStoredSettings();
        if (stored !== null) scrubLocalSettingsSecrets(stored);
        clearInitializationFailure();
      }
      persistPresence(result);
      committedMetadataSnapshot = metadataSnapshot(request);
    } catch (error) {
      if (retryInitialization) markInitializationFailed();
      throw error;
    }
    const present = new Set(result.providerIds);
    for (const provider of settings.aiProviders) {
      provider.hasApiKey = present.has(provider.id);
      const replacement = providerReplacements.get(provider.id);
      if (replacement !== undefined && provider.apiKey === replacement) provider.apiKey = '';
      provider.clearApiKey = false;
    }
    settings.searxngHasPassword = result.hasSearxngPassword;
    if (searxReplacement !== undefined && settings.searxngPassword === searxReplacement) {
      settings.searxngPassword = '';
    }
    settings.searxngClearPassword = false;
  });
}

/** Wait until all native credential broker updates have settled. */
export function flushSettingsSecrets(): Promise<void> {
  return writeTail;
}
