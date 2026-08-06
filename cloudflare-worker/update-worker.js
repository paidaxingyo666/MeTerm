/**
 * MeTerm Tauri updater proxy.
 *
 * When BRIDGE_VERSION and BRIDGE_TAG are configured, every client older than
 * the bridge is pinned to that immutable release. There is deliberately no
 * fallback to /releases/latest for those clients: doing so would strand an
 * installation that still trusts the legacy updater key.
 */

const DEFAULT_GITHUB_REPO = 'paidaxingyo666/MeTerm';
const PRODUCT_NAME = 'MeTerm';
const MAX_RELEASE_BYTES = 256 * 1024;
const MAX_SIGNATURE_BYTES = 8 * 1024;
const MAX_SIGNATURE_CHARS = 4096;
const MAX_RELEASE_NOTES_CHARS = 64 * 1024;
const MAX_RELEASE_ASSETS = 128;
const MAX_SEMVER_CHARS = 128;

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PUBLISHED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const REPOSITORY_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,100})$/;

const ASSET_BUILDERS = Object.freeze({
  'darwin-aarch64': () => `${PRODUCT_NAME}_aarch64.app.tar.gz`,
  'darwin-x86_64': () => `${PRODUCT_NAME}_x86_64.app.tar.gz`,
  'linux-aarch64': (version) => `${PRODUCT_NAME}_${version}_aarch64.AppImage.tar.gz`,
  'linux-x86_64': (version) => `${PRODUCT_NAME}_${version}_amd64.AppImage.tar.gz`,
  'windows-x86_64': (version) => `${PRODUCT_NAME}_${version}_x64-setup.exe`,
});

const RESPONSE_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
});

class UpdaterError extends Error {
  constructor(status, code) {
    super(code);
    this.name = 'UpdaterError';
    this.status = status;
    this.code = code;
  }
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env, globalThis.fetch, console);
  },
};

export async function handleRequest(request, env = {}, fetchImpl = globalThis.fetch, logger = console) {
  const url = new URL(request.url);

  try {
    const route = parseRoute(request, url);
    const repository = parseRepository(env.GITHUB_REPO ?? DEFAULT_GITHUB_REPO);
    const bridge = parseBridgeConfig(env);
    const releaseReference = bridge && compareSemver(route.currentVersion, bridge.version) < 0
      ? { kind: 'bridge', tag: bridge.tag, version: bridge.version }
      : { kind: 'latest' };

    const release = await fetchRelease(fetchImpl, env, repository, releaseReference);
    const releaseVersion = parseRelease(release, releaseReference);

    if (compareSemver(releaseVersion, route.currentVersion) <= 0) {
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    }

    const expected = expectedAssets(route.platformKey, releaseVersion.raw);
    const binaryAsset = uniqueAsset(release.assets, expected.binary);
    const signatureAsset = uniqueAsset(release.assets, expected.signature);
    validateAssetUrl(binaryAsset.browser_download_url, repository, release.tag_name, expected.binary);
    validateAssetUrl(signatureAsset.browser_download_url, repository, release.tag_name, expected.signature);

    const signature = await fetchSignature(fetchImpl, signatureAsset.browser_download_url);
    const manifest = {
      version: releaseVersion.raw,
      notes: release.body ?? '',
      pub_date: release.published_at,
      platforms: {
        [route.platformKey]: {
          signature,
          url: binaryAsset.browser_download_url,
        },
      },
    };

    return new Response(JSON.stringify(manifest), { status: 200, headers: RESPONSE_HEADERS });
  } catch (error) {
    const normalized = error instanceof UpdaterError
      ? error
      : new UpdaterError(502, 'upstream_failure');
    logFailure(logger, normalized, url.pathname);
    const headers = { ...RESPONSE_HEADERS };
    if (normalized.status === 405) headers.Allow = 'GET';
    return new Response(JSON.stringify({ error: normalized.code }), {
      status: normalized.status,
      headers,
    });
  }
}

function parseRoute(request, url) {
  if (request.method !== 'GET') throw new UpdaterError(405, 'method_not_allowed');
  if (url.search || url.pathname.includes('%')) throw new UpdaterError(404, 'not_found');

  const parts = url.pathname.split('/');
  if (parts.length !== 5 || parts[0] !== '' || parts[1] !== 'meterm') {
    throw new UpdaterError(404, 'not_found');
  }

  const platformKey = `${parts[2]}-${parts[3]}`;
  if (!Object.hasOwn(ASSET_BUILDERS, platformKey)) throw new UpdaterError(404, 'not_found');

  return {
    platformKey,
    currentVersion: parseSemver(parts[4], 400, 'invalid_current_version'),
  };
}

function parseRepository(value) {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new UpdaterError(503, 'invalid_configuration');
  }
  const match = REPOSITORY_PATTERN.exec(value);
  if (!match || match[2] === '.' || match[2] === '..' || match[2].endsWith('.git')) {
    throw new UpdaterError(503, 'invalid_configuration');
  }
  return { owner: match[1], name: match[2] };
}

function parseBridgeConfig(env) {
  const versionValue = env.BRIDGE_VERSION;
  const tagValue = env.BRIDGE_TAG;
  const versionConfigured = typeof versionValue === 'string' && versionValue.length > 0;
  const tagConfigured = typeof tagValue === 'string' && tagValue.length > 0;

  if (!versionConfigured && !tagConfigured && versionValue == null && tagValue == null) return null;
  if (!versionConfigured || !tagConfigured || versionValue !== versionValue.trim() || tagValue !== tagValue.trim()) {
    throw new UpdaterError(503, 'invalid_bridge_configuration');
  }

  const version = parseSemver(versionValue, 503, 'invalid_bridge_configuration');
  if (tagValue !== `v${version.raw}`) {
    throw new UpdaterError(503, 'invalid_bridge_configuration');
  }
  return { version, tag: tagValue };
}

function parseSemver(value, status, code) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SEMVER_CHARS) {
    throw new UpdaterError(status, code);
  }
  const match = SEMVER_PATTERN.exec(value);
  if (!match) throw new UpdaterError(status, code);

  return {
    raw: value,
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: match[4] == null ? null : match[4].split('.'),
  };
}

function compareSemver(left, right) {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] > right.core[index]) return 1;
    if (left.core[index] < right.core[index]) return -1;
  }

  if (left.prerelease == null && right.prerelease == null) return 0;
  if (left.prerelease == null) return 1;
  if (right.prerelease == null) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart == null) return -1;
    if (rightPart == null) return 1;
    if (leftPart === rightPart) continue;

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return BigInt(leftPart) > BigInt(rightPart) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

async function fetchRelease(fetchImpl, env, repository, reference) {
  const suffix = reference.kind === 'bridge'
    ? `/releases/tags/${encodeURIComponent(reference.tag)}`
    : '/releases/latest';
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}${suffix}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'MeTerm-Updater-Worker/2.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length > 0) {
    headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  }

  let response;
  try {
    response = await fetchImpl(apiUrl, {
      headers,
      redirect: 'error',
      cf: { cacheEverything: true, cacheTtl: 60 },
    });
  } catch {
    throw new UpdaterError(502, 'release_fetch_failed');
  }
  if (response.status !== 200) throw new UpdaterError(502, 'release_fetch_failed');

  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/(?:vnd\.github\+)?json(?:\s*;|$)/i.test(contentType)) {
    throw new UpdaterError(502, 'invalid_release_response');
  }

  const text = await readBoundedText(response, MAX_RELEASE_BYTES, 'release_response_too_large');
  try {
    return JSON.parse(text);
  } catch {
    throw new UpdaterError(502, 'invalid_release_response');
  }
}

function parseRelease(release, reference) {
  if (release == null || typeof release !== 'object' || Array.isArray(release)) {
    throw new UpdaterError(502, 'invalid_release_response');
  }
  if (release.draft !== false || release.prerelease !== false) {
    throw new UpdaterError(502, 'invalid_release_response');
  }
  if (typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v')) {
    throw new UpdaterError(502, 'invalid_release_response');
  }

  const version = parseSemver(release.tag_name.slice(1), 502, 'invalid_release_response');
  if (release.tag_name !== `v${version.raw}`) throw new UpdaterError(502, 'invalid_release_response');
  if (reference.kind === 'bridge'
      && (release.tag_name !== reference.tag || compareSemver(version, reference.version) !== 0)) {
    throw new UpdaterError(502, 'bridge_release_mismatch');
  }

  if (release.body != null
      && (typeof release.body !== 'string' || release.body.length > MAX_RELEASE_NOTES_CHARS)) {
    throw new UpdaterError(502, 'invalid_release_response');
  }
  if (typeof release.published_at !== 'string'
      || !PUBLISHED_AT_PATTERN.test(release.published_at)
      || Number.isNaN(Date.parse(release.published_at))) {
    throw new UpdaterError(502, 'invalid_release_response');
  }
  if (!Array.isArray(release.assets) || release.assets.length > MAX_RELEASE_ASSETS) {
    throw new UpdaterError(502, 'invalid_release_response');
  }
  return version;
}

function expectedAssets(platformKey, version) {
  const builder = ASSET_BUILDERS[platformKey];
  const binary = builder(version);
  return { binary, signature: `${binary}.sig` };
}

function uniqueAsset(assets, expectedName) {
  const matches = assets.filter((asset) => asset != null
    && typeof asset === 'object'
    && asset.name === expectedName);
  if (matches.length !== 1 || typeof matches[0].browser_download_url !== 'string') {
    throw new UpdaterError(502, 'release_asset_mismatch');
  }
  return matches[0];
}

function validateAssetUrl(value, repository, tag, assetName) {
  const expected = `https://github.com/${repository.owner}/${repository.name}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
  if (value !== expected) throw new UpdaterError(502, 'invalid_release_asset_url');

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new UpdaterError(502, 'invalid_release_asset_url');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.port
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new UpdaterError(502, 'invalid_release_asset_url');
  }
}

async function fetchSignature(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': 'MeTerm-Updater-Worker/2.0',
      },
      redirect: 'follow',
    });
  } catch {
    throw new UpdaterError(502, 'signature_fetch_failed');
  }
  if (response.status !== 200) throw new UpdaterError(502, 'signature_fetch_failed');

  const raw = await readBoundedText(response, MAX_SIGNATURE_BYTES, 'signature_response_too_large');
  const signature = raw.trim();
  if (signature.length === 0 || signature.length > MAX_SIGNATURE_CHARS
      || signature.length % 4 !== 0 || !BASE64_PATTERN.test(signature)) {
    throw new UpdaterError(502, 'invalid_signature_response');
  }
  return signature;
}

async function readBoundedText(response, limit, tooLargeCode) {
  const declared = response.headers.get('content-length');
  if (declared != null) {
    if (!/^(?:0|[1-9]\d*)$/.test(declared) || BigInt(declared) > BigInt(limit)) {
      throw new UpdaterError(502, tooLargeCode);
    }
  }
  if (response.body == null) throw new UpdaterError(502, 'empty_upstream_response');

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel('response exceeds byte limit');
        } catch {
          // The size violation remains authoritative even if cancellation fails.
        }
        throw new UpdaterError(502, tooLargeCode);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(combined);
  } catch {
    throw new UpdaterError(502, 'invalid_upstream_encoding');
  }
}

function logFailure(logger, error, path) {
  if (error.status < 500 || logger == null || typeof logger.error !== 'function') return;
  logger.error(JSON.stringify({
    event: 'updater_request_failed',
    code: error.code,
    status: error.status,
    path,
  }));
}
