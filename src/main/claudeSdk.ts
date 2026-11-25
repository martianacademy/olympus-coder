/**
 * Purpose:
 * Keeps Anthropic's proprietary Claude Agent SDK out of the installers. The SDK is downloaded on first use instead.
 *
 * Why:
 * `@anthropic-ai/claude-agent-sdk` is "© Anthropic PBC. All rights reserved". The installers ship only open-source
 * code: the Apache-2.0 adapter `@agentclientprotocol/claude-agent-acp`, without the SDK it imports and without the
 * SDK's ~330 MB native `claude` binaries. The user's own Claude Code install runs the model.
 *
 * How:
 * - Download the exact SDK version the bundled adapter depends on from the npm registry.
 * - Check it against the registry's sha512 integrity, then unpack it under userData.
 * - Start the adapter through a tiny boot script. Its `module.registerHooks` resolve hook loads
 *   `@anthropic-ai/claude-agent-sdk` from that folder. The adapter code itself is unchanged.
 * Pure functions with explicit paths, so they are unit-testable without Electron.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
const ADAPTER_PACKAGE = ['@agentclientprotocol', 'claude-agent-acp'];
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
/** Bump when the boot script text changes, so an old copy on disk is replaced. */
const BOOT_VERSION = 1;

/** The SDK version the bundled adapter was built against (an exact `x.y.z` in its package.json). */
export function sdkVersionFor(appPath: string): string {
  const pkg = JSON.parse(readFileSync(join(appPath, 'node_modules', ...ADAPTER_PACKAGE, 'package.json'), 'utf8'));
  const v = String(pkg.dependencies?.[SDK_PACKAGE] ?? '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v)) throw new Error(`claude-agent-acp needs ${SDK_PACKAGE}@"${v}", not an exact version`);
  return v;
}

/** True when the SDK ships inside the app (dev runs, `npm install`ed headless servers): nothing to download. */
export function sdkBundled(appPath: string): boolean {
  return existsSync(join(appPath, 'node_modules', ...SDK_PACKAGE.split('/'), 'package.json'));
}

/** `<userData>/vendor/claude-agent-sdk/<version>`: resolution root holding `node_modules/@anthropic-ai/claude-agent-sdk`. */
export function sdkRoot(userData: string, version: string): string {
  return join(userData, 'vendor', 'claude-agent-sdk', version);
}

const okFile = (root: string) => join(root, '.olympus-ok');

/** The SDK for this version is unpacked and complete (a crashed download never leaves the marker). */
export function sdkReady(userData: string, version: string): boolean {
  return existsSync(okFile(sdkRoot(userData, version)));
}

const inflight = new Map<string, Promise<string>>();

/**
 * Makes the SDK available under userData and returns its resolution root. Concurrent callers share one download.
 * `fetchImpl` / `registry` are test seams.
 */
export function ensureClaudeSdk(opts: {
  appPath: string;
  userData: string;
  registry?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (detail: string) => void;
}): Promise<string> {
  const version = sdkVersionFor(opts.appPath);
  const root = sdkRoot(opts.userData, version);
  if (sdkReady(opts.userData, version)) return Promise.resolve(root);
  const key = root;
  let p = inflight.get(key);
  if (!p) {
    p = download(version, root, opts).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

async function download(
  version: string,
  root: string,
  opts: { registry?: string; fetchImpl?: typeof fetch; onProgress?: (detail: string) => void },
): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const registry = (opts.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, '');
  opts.onProgress?.(`Downloading Claude Agent SDK ${version}…`);
  const metaRes = await f(`${registry}/${SDK_PACKAGE}/${version}`, { signal: AbortSignal.timeout(30_000) });
  if (!metaRes.ok) throw new Error(`Could not get ${SDK_PACKAGE}@${version} from the npm registry (HTTP ${metaRes.status})`);
  const meta = (await metaRes.json()) as { dist?: { tarball?: string; integrity?: string } };
  const tarball = meta.dist?.tarball;
  const integrity = meta.dist?.integrity;
  if (!tarball || !integrity?.startsWith('sha512-')) throw new Error(`The npm registry gave no tarball/sha512 for ${SDK_PACKAGE}@${version}`);
  const res = await f(tarball, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`Downloading ${SDK_PACKAGE}@${version} failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = `sha512-${createHash('sha512').update(buf).digest('base64')}`;
  if (got !== integrity) throw new Error(`${SDK_PACKAGE}@${version} failed its integrity check (download corrupted or tampered with)`);

  // Unpack beside the final folder, then move it into place in one rename: a half-written SDK is never used.
  const tmp = `${root}.tmp-${randomBytes(4).toString('hex')}`;
  rmSync(tmp, { recursive: true, force: true });
  try {
    const pkgDir = join(tmp, 'node_modules', ...SDK_PACKAGE.split('/'));
    extractTarGz(buf, pkgDir, 'package/');
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    if (pkg.name !== SDK_PACKAGE || pkg.version !== version) throw new Error(`Unexpected package in the download: ${pkg.name}@${pkg.version}`);
    writeFileSync(okFile(tmp), JSON.stringify({ version, integrity, at: new Date().toISOString() }));
    rmSync(root, { recursive: true, force: true });
    mkdirSync(dirname(root), { recursive: true });
    renameSync(tmp, root);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  opts.onProgress?.(`Claude Agent SDK ${version} ready`);
  return root;
}

/**
 * Unpacks a gzipped npm tarball (ustar + pax/GNU long names) into `dest`, keeping only regular files and folders
 * under `strip`. Entries that would land outside `dest` (absolute, `..`) are rejected; links are never created.
 */
export function extractTarGz(gz: Buffer, dest: string, strip = ''): number {
  const tar = gunzipSync(gz);
  const destRoot = normalize(dest + sep);
  let off = 0;
  let longName: string | undefined;
  let files = 0;
  const str = (b: Buffer) => {
    const z = b.indexOf(0);
    return (z >= 0 ? b.subarray(0, z) : b).toString('utf8');
  };
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = parseInt(str(h.subarray(124, 136)).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      // pax extended header: "<len> key=value\n" records; `path` overrides the next entry's name.
      for (const rec of body.toString('utf8').split('\n')) {
        const m = /^\d+ path=(.*)$/.exec(rec);
        if (m) longName = m[1];
      }
      continue;
    }
    if (type === 'L') {
      longName = str(body);
      continue;
    }
    if (type === 'g') continue;
    const prefix = str(h.subarray(345, 500));
    let name = longName ?? (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
    longName = undefined;
    if (type !== '0' && type !== '5') continue; // symlinks, devices, …: never created
    if (strip) {
      if (!name.startsWith(strip)) continue;
      name = name.slice(strip.length);
    }
    if (!name.replace(/\/+$/, '')) continue; // the archive's own root folder entry (`package/`)
    if (name.startsWith('/') || name.split(/[\\/]/).includes('..')) throw new Error(`Unsafe path in archive: ${name}`);
    const out = normalize(join(dest, name));
    if (!out.startsWith(destRoot) && out + sep !== destRoot) throw new Error(`Unsafe path in archive: ${name}`);
    if (type === '5') {
      mkdirSync(out, { recursive: true });
      continue;
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, body);
    files++;
  }
  return files;
}

/**
 * The boot script (written once under userData). Run as `<node> boot.mjs <sdkRoot> <adapter.js> [...args]`:
 * resolves the SDK from `<sdkRoot>/node_modules`, restores `argv` to `<node> <adapter.js> [...args]`, then loads the
 * adapter exactly as if it had been started directly.
 */
export const BOOT_SOURCE = `// Olympus Coder: starts the Claude ACP adapter with the Claude Agent SDK downloaded on first use (v${BOOT_VERSION}).
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [, , sdkRoot, adapter] = process.argv;
const SDK = '${SDK_PACKAGE}';
if (!existsSync(join(sdkRoot, 'node_modules', ...SDK.split('/'), 'package.json'))) {
  console.error('Claude Agent SDK is not downloaded yet: open Claude Code in Olympus Coder once (it downloads it), then retry.');
  process.exit(1);
}
const parentURL = pathToFileURL(join(sdkRoot, 'olympus-resolve.mjs')).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === SDK || specifier.startsWith(SDK + '/')) return nextResolve(specifier, { ...context, parentURL });
    return nextResolve(specifier, context);
  },
});
process.argv.splice(1, 2);
await import(pathToFileURL(adapter).href);
`;

/** Writes (or refreshes) the boot script under userData and returns its path. */
export function ensureBootScript(userData: string): string {
  const file = join(userData, 'vendor', 'claude-agent-sdk', `boot-v${BOOT_VERSION}.mjs`);
  if (!existsSync(file) || readFileSync(file, 'utf8') !== BOOT_SOURCE) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, BOOT_SOURCE);
  }
  return file;
}
