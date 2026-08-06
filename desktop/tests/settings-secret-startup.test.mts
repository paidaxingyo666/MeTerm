import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  SETTINGS_SECRET_PRESENCE_STORAGE_KEY,
  applySettingsSecrets,
  flushSettingsSecrets,
  hydrateSettingsSecretPresenceFromStorage,
  initializeSettingsSecrets,
  stripSettingsSecretsForStorage,
  updateSettingsSecrets,
} from '../src/settings-secrets.ts';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
});

function exampleSettings() {
  return {
    aiProviders: [
      { id: 'openai', type: 'openai', baseUrl: 'https://api.openai.com', apiKey: '' },
      { id: 'gemini', type: 'gemini', baseUrl: 'https://example.test', apiKey: '' },
    ],
    searxngUrl: '',
    searxngUsername: '',
    searxngPassword: '',
  };
}

test('secondary windows hydrate only a versioned non-secret presence cache', () => {
  values.clear();
  values.set(SETTINGS_SECRET_PRESENCE_STORAGE_KEY, JSON.stringify({
    version: 2,
    providerIds: ['openai'],
    hasSearxngPassword: true,
  }));
  assert.equal(hydrateSettingsSecretPresenceFromStorage(), false);

  values.set(SETTINGS_SECRET_PRESENCE_STORAGE_KEY, JSON.stringify({
    version: 1,
    providerIds: ['openai'],
    hasSearxngPassword: true,
  }));

  assert.equal(hydrateSettingsSecretPresenceFromStorage(), true);
  const settings = applySettingsSecrets(exampleSettings());
  assert.equal(settings.aiProviders[0].hasApiKey, true);
  assert.equal(settings.aiProviders[1].hasApiKey, false);
  assert.equal(settings.searxngHasPassword, true);
  assert.equal(settings.aiProviders[0].apiKey, '');
  assert.equal(settings.searxngPassword, '');
});

test('cold startup never invokes native settings credentials', async () => {
  values.clear();
  values.set('meterm-settings', JSON.stringify({
    ...exampleSettings(),
    aiProviders: [{
      id: 'openai',
      type: 'openai',
      baseUrl: 'https://api.openai.com',
      apiKey: 'legacy-only-copy',
    }],
  }));
  let invokeCount = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async () => {
          invokeCount += 1;
          throw new Error('startup must not invoke native');
        },
      },
    },
  });

  await initializeSettingsSecrets('startup');

  assert.equal(invokeCount, 0);
  assert.equal(values.get('meterm-settings-secret-initialization-failed-v1'), '1');
  assert.equal(
    JSON.parse(values.get('meterm-settings')!).aiProviders[0].apiKey,
    'legacy-only-copy',
  );
  assert.deepEqual(JSON.parse(values.get(SETTINGS_SECRET_PRESENCE_STORAGE_KEY)!), {
    version: 1,
    providerIds: [],
    hasSearxngPassword: false,
  });
});

test('malformed plaintext sources are never scrubbed as a successful migration', async () => {
  values.clear();
  values.set('meterm-settings', JSON.stringify({
    ...exampleSettings(),
    aiProviders: [
      {
        id: 'invalid\nid',
        type: 'openai',
        baseUrl: 'https://api.openai.com',
        apiKey: 'must-survive',
      },
      {
        id: 'duplicate',
        type: 'openai',
        baseUrl: 'https://one.example',
        apiKey: 'must-also-survive',
      },
      {
        id: 'duplicate',
        type: 'openai',
        baseUrl: 'https://two.example',
        apiKey: 'second-duplicate-must-survive',
      },
    ],
    searxngUrl: '',
    searxngPassword: 'unbound-password-must-survive',
  }));
  let invokeCount = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async () => {
          invokeCount += 1;
          throw new Error('unmigratable plaintext must not reach native');
        },
      },
    },
  });

  await initializeSettingsSecrets('settings');

  assert.equal(invokeCount, 0);
  const retained = JSON.parse(values.get('meterm-settings')!);
  assert.equal(retained.aiProviders[0].apiKey, 'must-survive');
  assert.equal(retained.aiProviders[1].apiKey, 'must-also-survive');
  assert.equal(retained.aiProviders[2].apiKey, 'second-duplicate-must-survive');
  assert.equal(retained.searxngPassword, 'unbound-password-must-survive');
  assert.equal(values.get('meterm-settings-secret-initialization-failed-v1'), '1');

  const replacement = exampleSettings();
  replacement.aiProviders[0].apiKey = 'new-explicit-replacement';
  updateSettingsSecrets(replacement);
  await assert.rejects(flushSettingsSecrets(), /explicit cleanup/);
  assert.equal(invokeCount, 0);

  const afterSave = stripSettingsSecretsForStorage(replacement) as ReturnType<typeof exampleSettings>;
  assert.equal(afterSave.aiProviders[1].apiKey, 'must-also-survive');
  assert.equal(afterSave.aiProviders[2].apiKey, 'second-duplicate-must-survive');
});

test('secondary save preserves plaintext before any failure latch exists', () => {
  values.clear();
  values.set('meterm-settings', JSON.stringify({
    ...exampleSettings(),
    aiProviders: [{
      id: 'openai',
      type: 'openai',
      baseUrl: 'https://api.openai.com',
      apiKey: 'race-safe-only-copy',
    }],
  }));

  const result = stripSettingsSecretsForStorage(exampleSettings()) as ReturnType<typeof exampleSettings>;

  assert.equal(values.has('meterm-settings-secret-initialization-failed-v1'), false);
  assert.equal(result.aiProviders[0].apiKey, 'race-safe-only-copy');
});

test('failed migration preserves only the existing plaintext copy', () => {
  values.clear();
  values.set('meterm-settings-secret-initialization-failed-v1', '1');
  values.set('meterm-settings', JSON.stringify({
    ...exampleSettings(),
    aiProviders: [{
      id: 'openai',
      type: 'openai',
      baseUrl: 'https://api.openai.com',
      apiKey: 'legacy-only-copy',
    }],
    searxngPassword: 'legacy-search-copy',
  }));

  const result = stripSettingsSecretsForStorage({
    ...exampleSettings(),
    aiProviders: [{
      id: 'openai',
      type: 'openai',
      baseUrl: 'https://api.openai.com',
      apiKey: 'new-value-must-not-enter-storage',
    }],
    searxngPassword: 'new-search-value-must-not-enter-storage',
  }) as ReturnType<typeof exampleSettings>;

  assert.equal(result.aiProviders[0].apiKey, 'legacy-only-copy');
  assert.equal(result.searxngPassword, 'legacy-search-copy');
});

test('startup routing keeps ordinary secondary windows away from native initialization', async () => {
  const [main, listeners, frontend, native] = await Promise.all([
    readFile(new URL('../src/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/event-listeners.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/settings-secrets.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/commands/settings_secrets.rs', import.meta.url), 'utf8'),
  ]);

  assert.match(main, /initializeSettingsSecrets\('settings'\)/);
  assert.match(
    main,
    /label === 'main'[\s\S]*?initializeSettingsSecrets\('startup'\)[\s\S]*?else[\s\S]*?hydrateSettingsSecretPresenceFromStorage\(\)/,
  );
  assert.doesNotMatch(listeners, /initializeSettingsSecrets/);
  assert.match(listeners, /hydrateSettingsSecretPresenceFromStorage\(\)/);
  assert.match(frontend, /if \(!settingsSessionAllowsNativeWrites\) return;/);
  const initializationGuard = native.match(
    /fn is_settings_initialization_window[\s\S]*?\n}/,
  )?.[0] ?? '';
  assert.match(initializationGuard, /label == "settings"/);
  assert.doesNotMatch(initializationGuard, /label == "main"|starts_with/);
});
