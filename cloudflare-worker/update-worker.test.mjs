import assert from 'node:assert/strict';
import test from 'node:test';

import { handleRequest } from './update-worker.js';

const REPOSITORY = 'paidaxingyo666/MeTerm';
const VALID_SIGNATURE = 'A'.repeat(404);
const SILENT_LOGGER = { error() {} };

function expectedBinary(platformKey, version) {
  const names = {
    'darwin-aarch64': 'MeTerm_aarch64.app.tar.gz',
    'darwin-x86_64': 'MeTerm_x86_64.app.tar.gz',
    'linux-aarch64': `MeTerm_${version}_aarch64.AppImage.tar.gz`,
    'linux-x86_64': `MeTerm_${version}_amd64.AppImage.tar.gz`,
    'windows-x86_64': `MeTerm_${version}_x64-setup.exe`,
  };
  return names[platformKey];
}

function asset(name, tag) {
  return {
    name,
    browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`,
  };
}

function makeRelease(version, platformKey = 'darwin-aarch64', overrides = {}) {
  const tag = overrides.tag_name ?? `v${version}`;
  const binary = expectedBinary(platformKey, version);
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    body: 'release notes',
    published_at: '2026-07-15T00:00:00Z',
    assets: [asset(binary, tag), asset(`${binary}.sig`, tag)],
    ...overrides,
  };
}

function upstream(release, options = {}) {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith('https://api.github.com/')) {
      if (options.releaseError) throw new Error('release network failure');
      if (options.releaseResponse) return options.releaseResponse();
      return new Response(JSON.stringify(release), {
        status: options.releaseStatus ?? 200,
        headers: { 'Content-Type': options.releaseContentType ?? 'application/json; charset=utf-8' },
      });
    }
    if (options.signatureError) throw new Error('signature network failure');
    if (options.signatureResponse) return options.signatureResponse();
    return new Response(options.signatureBody ?? VALID_SIGNATURE, {
      status: options.signatureStatus ?? 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  };
  return { calls, fetchImpl };
}

function request(path, method = 'GET') {
  return new Request(`https://update.example${path}`, { method });
}

async function invoke(path, env, source, method = 'GET') {
  return handleRequest(request(path, method), env, source.fetchImpl, SILENT_LOGGER);
}

async function errorCode(response) {
  return (await response.json()).error;
}

test('default configuration preserves latest-release behavior', async () => {
  const source = upstream(makeRelease('0.2.12'));
  const response = await invoke('/meterm/darwin/aarch64/0.2.11', { GITHUB_REPO: REPOSITORY }, source);

  assert.equal(response.status, 200);
  assert.match(source.calls[0], /\/releases\/latest$/);
  const manifest = await response.json();
  assert.equal(manifest.version, '0.2.12');
  assert.equal(manifest.platforms['darwin-aarch64'].signature, VALID_SIGNATURE);
  assert.equal(manifest.platforms['darwin-aarch64'].url,
    'https://github.com/paidaxingyo666/MeTerm/releases/download/v0.2.12/MeTerm_aarch64.app.tar.gz');
});

test('client older than bridge is pinned to the bridge tag and never fetches latest', async () => {
  const source = upstream(makeRelease('0.2.12'));
  const response = await invoke('/meterm/darwin/aarch64/0.2.11', {
    GITHUB_REPO: REPOSITORY,
    BRIDGE_VERSION: '0.2.12',
    BRIDGE_TAG: 'v0.2.12',
  }, source);

  assert.equal(response.status, 200);
  assert.match(source.calls[0], /\/releases\/tags\/v0\.2\.12$/);
  assert.equal(source.calls.some((url) => url.endsWith('/releases/latest')), false);
  assert.equal((await response.json()).version, '0.2.12');
});

test('client at bridge version proceeds to latest', async () => {
  const source = upstream(makeRelease('0.2.13'));
  const response = await invoke('/meterm/darwin/aarch64/0.2.12', {
    GITHUB_REPO: REPOSITORY,
    BRIDGE_VERSION: '0.2.12',
    BRIDGE_TAG: 'v0.2.12',
  }, source);

  assert.equal(response.status, 200);
  assert.match(source.calls[0], /\/releases\/latest$/);
  assert.equal((await response.json()).version, '0.2.13');
});

test('prerelease is older than its bridge release while build metadata is equal', async (t) => {
  await t.test('prerelease receives bridge', async () => {
    const source = upstream(makeRelease('0.2.12'));
    const response = await invoke('/meterm/darwin/aarch64/0.2.12-rc.1', {
      GITHUB_REPO: REPOSITORY,
      BRIDGE_VERSION: '0.2.12',
      BRIDGE_TAG: 'v0.2.12',
    }, source);
    assert.equal(response.status, 200);
    assert.match(source.calls[0], /\/releases\/tags\/v0\.2\.12$/);
  });

  await t.test('build metadata proceeds to latest', async () => {
    const source = upstream(makeRelease('0.2.13'));
    const response = await invoke('/meterm/darwin/aarch64/0.2.12+local.1', {
      GITHUB_REPO: REPOSITORY,
      BRIDGE_VERSION: '0.2.12',
      BRIDGE_TAG: 'v0.2.12',
    }, source);
    assert.equal(response.status, 200);
    assert.match(source.calls[0], /\/releases\/latest$/);
  });
});

test('bridge upstream failure fails closed without latest fallback', async () => {
  const source = upstream(makeRelease('0.2.12'), { releaseStatus: 503 });
  const response = await invoke('/meterm/darwin/aarch64/0.2.11', {
    GITHUB_REPO: REPOSITORY,
    BRIDGE_VERSION: '0.2.12',
    BRIDGE_TAG: 'v0.2.12',
  }, source);

  assert.equal(response.status, 502);
  assert.equal(await errorCode(response), 'release_fetch_failed');
  assert.equal(source.calls.length, 1);
  assert.match(source.calls[0], /\/releases\/tags\/v0\.2\.12$/);
});

test('exact method, path, platform and strict current semver are enforced', async (t) => {
  const neverFetch = { fetchImpl: async () => { throw new Error('must not fetch'); } };
  const cases = [
    ['/meterm/darwin/aarch64/01.2.3', 400],
    ['/meterm/darwin/aarch64/v1.2.3', 400],
    ['/meterm/darwin/aarch64/1.2', 400],
    ['/meterm/darwin/aarch64/1.2.3/', 404],
    ['/meterm/darwin/aarch64/1.2.3/extra', 404],
    ['/meterm/darwin/aarch64/1.2.3?channel=latest', 404],
    ['/meterm/darwin/aarch64/1.2.3%2Fescape', 404],
    ['/meterm/windows/aarch64/1.2.3', 404],
    ['/Meterm/darwin/aarch64/1.2.3', 404],
  ];
  for (const [path, expectedStatus] of cases) {
    await t.test(path, async () => {
      const response = await invoke(path, { GITHUB_REPO: REPOSITORY }, neverFetch);
      assert.equal(response.status, expectedStatus);
    });
  }

  const methodResponse = await invoke('/meterm/darwin/aarch64/1.2.3',
    { GITHUB_REPO: REPOSITORY }, neverFetch, 'POST');
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.get('allow'), 'GET');
});

test('all supported platform pairs require their exact asset names', async (t) => {
  const platforms = [
    ['darwin', 'aarch64'],
    ['darwin', 'x86_64'],
    ['linux', 'aarch64'],
    ['linux', 'x86_64'],
    ['windows', 'x86_64'],
  ];
  for (const [target, arch] of platforms) {
    await t.test(`${target}-${arch}`, async () => {
      const platformKey = `${target}-${arch}`;
      const source = upstream(makeRelease('0.2.12', platformKey));
      const response = await invoke(`/meterm/${target}/${arch}/0.2.11`,
        { GITHUB_REPO: REPOSITORY }, source);
      assert.equal(response.status, 200);
      assert.match((await response.json()).platforms[platformKey].url,
        new RegExp(`${expectedBinary(platformKey, '0.2.12').replaceAll('.', '\\.')}$`));
    });
  }
});

test('partial or inconsistent bridge configuration fails before any upstream request', async (t) => {
  const neverFetch = { fetchImpl: async () => { throw new Error('must not fetch'); } };
  const cases = [
    { BRIDGE_VERSION: '0.2.12' },
    { BRIDGE_TAG: 'v0.2.12' },
    { BRIDGE_VERSION: '0.2.12', BRIDGE_TAG: 'v0.2.13' },
    { BRIDGE_VERSION: ' 0.2.12', BRIDGE_TAG: 'v0.2.12' },
  ];
  for (const bridge of cases) {
    await t.test(JSON.stringify(bridge), async () => {
      const response = await invoke('/meterm/darwin/aarch64/0.2.11',
        { GITHUB_REPO: REPOSITORY, ...bridge }, neverFetch);
      assert.equal(response.status, 503);
      assert.equal(await errorCode(response), 'invalid_bridge_configuration');
    });
  }
});

test('bridge endpoint must return the configured tag and version', async () => {
  const source = upstream(makeRelease('0.2.13'));
  const response = await invoke('/meterm/darwin/aarch64/0.2.11', {
    GITHUB_REPO: REPOSITORY,
    BRIDGE_VERSION: '0.2.12',
    BRIDGE_TAG: 'v0.2.12',
  }, source);

  assert.equal(response.status, 502);
  assert.equal(await errorCode(response), 'bridge_release_mismatch');
  assert.equal(source.calls.length, 1);
});

test('missing or duplicate exact assets fail closed', async (t) => {
  const full = makeRelease('0.2.12');
  const [binary, signature] = full.assets;
  const cases = [
    ['missing binary', [signature]],
    ['missing signature', [binary]],
    ['duplicate binary', [binary, binary, signature]],
    ['duplicate signature', [binary, signature, signature]],
  ];
  for (const [name, assets] of cases) {
    await t.test(name, async () => {
      const source = upstream({ ...full, assets });
      const response = await invoke('/meterm/darwin/aarch64/0.2.11',
        { GITHUB_REPO: REPOSITORY }, source);
      assert.equal(response.status, 502);
      assert.equal(await errorCode(response), 'release_asset_mismatch');
      assert.equal(source.calls.length, 1);
    });
  }
});

test('non-exact or non-HTTPS GitHub asset URLs fail before signature fetch', async (t) => {
  const base = makeRelease('0.2.12');
  const maliciousUrls = [
    'http://github.com/paidaxingyo666/MeTerm/releases/download/v0.2.12/MeTerm_aarch64.app.tar.gz',
    'https://evil.example/paidaxingyo666/MeTerm/releases/download/v0.2.12/MeTerm_aarch64.app.tar.gz',
    'https://github.com/paidaxingyo666/MeTerm/releases/download/v0.2.12/other.app.tar.gz',
  ];
  for (const url of maliciousUrls) {
    await t.test(new URL(url).hostname, async () => {
      const assets = [{ ...base.assets[0], browser_download_url: url }, base.assets[1]];
      const source = upstream({ ...base, assets });
      const response = await invoke('/meterm/darwin/aarch64/0.2.11',
        { GITHUB_REPO: REPOSITORY }, source);
      assert.equal(response.status, 502);
      assert.equal(await errorCode(response), 'invalid_release_asset_url');
      assert.equal(source.calls.length, 1);
    });
  }
});

test('signature absence, invalid encoding, failure and oversize all fail closed', async (t) => {
  const release = makeRelease('0.2.12');
  const cases = [
    ['empty', { signatureBody: '' }, 'invalid_signature_response'],
    ['not base64', { signatureBody: 'not-a-minisign signature' }, 'invalid_signature_response'],
    ['status failure', { signatureStatus: 404 }, 'signature_fetch_failed'],
    ['network failure', { signatureError: true }, 'signature_fetch_failed'],
    ['oversize', { signatureBody: 'A'.repeat(8196) }, 'signature_response_too_large'],
  ];
  for (const [name, options, code] of cases) {
    await t.test(name, async () => {
      const source = upstream(release, options);
      const response = await invoke('/meterm/darwin/aarch64/0.2.11',
        { GITHUB_REPO: REPOSITORY }, source);
      assert.equal(response.status, 502);
      assert.equal(await errorCode(response), code);
    });
  }
});

test('release upstream failure, malformed response and byte overflow fail closed', async (t) => {
  const cases = [
    ['network failure', { releaseError: true }, 'release_fetch_failed'],
    ['status failure', { releaseStatus: 500 }, 'release_fetch_failed'],
    ['wrong content type', { releaseContentType: 'text/html' }, 'invalid_release_response'],
    ['malformed JSON', {
      releaseResponse: () => new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    }, 'invalid_release_response'],
    ['declared oversize', {
      releaseResponse: () => new Response('{}', {
        headers: { 'Content-Type': 'application/json', 'Content-Length': '999999' },
      }),
    }, 'release_response_too_large'],
    ['streamed oversize', {
      releaseResponse: () => new Response('x'.repeat(256 * 1024 + 1), {
        headers: { 'Content-Type': 'application/json' },
      }),
    }, 'release_response_too_large'],
  ];
  for (const [name, options, code] of cases) {
    await t.test(name, async () => {
      const source = upstream(makeRelease('0.2.12'), options);
      const response = await invoke('/meterm/darwin/aarch64/0.2.11',
        { GITHUB_REPO: REPOSITORY }, source);
      assert.equal(response.status, 502);
      assert.equal(await errorCode(response), code);
    });
  }
});

test('same or older latest release returns 204 without fetching a signature', async (t) => {
  for (const latest of ['0.2.11', '0.2.10']) {
    await t.test(latest, async () => {
      const source = upstream(makeRelease(latest));
      const response = await invoke('/meterm/darwin/aarch64/0.2.11',
        { GITHUB_REPO: REPOSITORY }, source);
      assert.equal(response.status, 204);
      assert.equal(source.calls.length, 1);
    });
  }
});
