/**
 * MeTerm — Tauri Updater Proxy (Cloudflare Worker)
 *
 * Endpoint pattern (configured in tauri.conf.json):
 *   https://update.meterm.app/meterm/{{target}}/{{arch}}/{{current_version}}
 *
 * Tauri passes:
 *   target  — "darwin" | "linux" | "windows"
 *   arch    — "x86_64" | "aarch64"
 *   current_version — e.g. "0.1.0"
 *
 * The worker fetches the latest GitHub Release and returns a JSON response
 * in Tauri's update manifest format, or 204 when no update is needed.
 *
 * GitHub Release asset naming convention (must match in CI):
 *   darwin/aarch64  → meterm_*_aarch64.app.tar.gz + .sig
 *   darwin/x86_64   → meterm_*_x86_64.app.tar.gz  + .sig
 *   linux/x86_64    → meterm_*_amd64.AppImage      + .sig
 *   linux/aarch64   → meterm_*_aarch64.AppImage    + .sig
 *   windows/x86_64  → MeTerm_*_x64-setup.exe       + .sig
 */

// 从 Cloudflare Worker 环境变量读取，wrangler.toml 中配置：
// [vars]
// GITHUB_REPO = "paidaxingyo666/meterm"
const DEFAULT_GITHUB_REPO = 'paidaxingyo666/meterm';

// Asset suffix patterns: [target, arch] → substring that uniquely identifies the binary
const ASSET_PATTERNS = {
  'darwin-aarch64': { binary: 'aarch64.app.tar.gz', sig: 'aarch64.app.tar.gz.sig' },
  'darwin-x86_64':  { binary: 'x86_64.app.tar.gz',  sig: 'x86_64.app.tar.gz.sig'  },
  'linux-x86_64':   { binary: 'amd64.AppImage',       sig: 'amd64.AppImage.sig'      },
  'linux-aarch64':  { binary: 'aarch64.AppImage',     sig: 'aarch64.AppImage.sig'    },
  'windows-x86_64': { binary: 'x64-setup.exe',       sig: 'x64-setup.exe.sig'      },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Expected path: /meterm/<target>/<arch>/<current_version>
    const parts = url.pathname.split('/').filter(Boolean);
    // parts[0] = "meterm", [1] = target, [2] = arch, [3] = current_version
    if (parts.length < 4 || parts[0] !== 'meterm') {
      return new Response('Not found', { status: 404 });
    }

    const [, target, arch, currentVersion] = parts;
    const platformKey = `${target}-${arch}`;
    const patterns = ASSET_PATTERNS[platformKey];
    if (!patterns) {
      return new Response(`Unsupported platform: ${platformKey}`, { status: 400 });
    }

    // Fetch latest release from GitHub
    const repo = env.GITHUB_REPO || DEFAULT_GITHUB_REPO;
    const githubApi = `https://api.github.com/repos/${repo}/releases/latest`;
    let release;
    try {
      const resp = await fetch(githubApi, {
        headers: {
          'User-Agent': 'MeTerm-Updater-Worker/1.0',
          'Accept': 'application/vnd.github+json',
          // If a GitHub token is configured as a secret, use it to avoid rate limits
          ...(env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${env.GITHUB_TOKEN}` } : {}),
        },
        cf: { cacheTtl: 60, cacheEverything: true },
      });
      if (!resp.ok) {
        return new Response(`GitHub API error: ${resp.status}`, { status: 502 });
      }
      release = await resp.json();
    } catch (err) {
      return new Response(`Upstream error: ${err.message}`, { status: 502 });
    }

    // Strip leading "v" from tag name (e.g. "v0.1.1" → "0.1.1")
    const latestVersion = (release.tag_name || '').replace(/^v/, '');

    // Compare versions — if current >= latest, return 204 (no update)
    if (!latestVersion || !isNewer(latestVersion, currentVersion)) {
      return new Response(null, { status: 204 });
    }

    // Find binary and signature assets
    const assets = release.assets || [];
    const binaryAsset = assets.find((a) => a.name.endsWith(patterns.binary));
    const sigAsset    = assets.find((a) => a.name.endsWith(patterns.sig));

    if (!binaryAsset || !sigAsset) {
      // Assets not published yet for this platform — no update available
      return new Response(null, { status: 204 });
    }

    // Fetch the signature content (it's a small text file)
    let signature = '';
    try {
      const sigResp = await fetch(sigAsset.browser_download_url);
      if (sigResp.ok) {
        signature = (await sigResp.text()).trim();
      }
    } catch { /* leave empty if fetch fails */ }

    // Build Tauri v2 update manifest
    const body = JSON.stringify({
      version: latestVersion,
      notes: release.body || '',
      pub_date: release.published_at || new Date().toISOString(),
      platforms: {
        [tauriPlatformKey(target, arch)]: {
          signature,
          url: binaryAsset.browser_download_url,
        },
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      },
    });
  },
};

/**
 * Convert target+arch to Tauri's platform key format.
 * Examples: "darwin-aarch64" → "darwin-aarch64", "windows-x86_64" → "windows-x86_64"
 */
function tauriPlatformKey(target, arch) {
  return `${target}-${arch}`;
}

/**
 * Simple semver comparison: returns true if `candidate` is strictly newer than `current`.
 * Handles "1.2.3" format (pre-release tags are ignored).
 */
function isNewer(candidate, current) {
  const parse = (v) => v.replace(/[^0-9.]/g, '').split('.').map(Number);
  const [ca, cb, cc] = parse(candidate);
  const [ua, ub, uc] = parse(current);
  if (ca !== ua) return ca > ua;
  if (cb !== ub) return cb > ub;
  return cc > uc;
}
