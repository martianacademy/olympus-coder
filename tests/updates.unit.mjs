// Unit tests for src/main/updates.ts: semver order, installer pick per platform/CPU, skipped version, the setting
// turned off (no request at all), and quiet failures (403 / 404 / offline / bad JSON / drafts / pre-releases).
// Run: node tests/updates.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; `electron` is stubbed)
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = mkdtempSync(join(tmpdir(), 'olympus-updates-unit-'));
const UD = join(TMP, 'userData');
const SHARED = join(TMP, 'shared');
for (const d of [UD, SHARED]) mkdirSync(d, { recursive: true });
delete process.env.OLYMPUS_HOME;
process.env.AGENTDESK_SHARED_ROOT = SHARED;
writeFileSync(join(UD, 'settings.json'), JSON.stringify({ sharedRoot: SHARED, designVersion: 2 }));

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'mock:electron', shortCircuit: true };
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
  load(url, ctx, next) {
    // Mock of the few electron APIs these modules touch (labelled mock, not the real app).
    if (url === 'mock:electron')
      return { format: 'module', shortCircuit: true, source: `export const app = { getPath: () => ${JSON.stringify(UD)}, getVersion: () => '0.1.0' }; export const safeStorage = { isEncryptionAvailable: () => false }; export const shell = {};` };
    return next(url, ctx);
  },
});

const U = await import(`${APP}/src/main/updates.ts`);
const S = await import(`${APP}/src/main/store.ts`);

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${String(e?.stack ?? e).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

const dl = (name) => ({ name, browser_download_url: `https://github.com/martianacademy/olympus-coder/releases/download/v0.2.0/${name}` });
const ASSETS = [
  dl('Olympus.Coder-0.2.0-arm64.dmg'),
  dl('Olympus.Coder-0.2.0-arm64.dmg.blockmap'),
  dl('Olympus.Coder-0.2.0-arm64-mac.zip'),
  dl('Olympus.Coder-0.2.0.dmg'),
  dl('Olympus.Coder.Setup.0.2.0.exe'),
  dl('Olympus.Coder.Setup.0.2.0.exe.blockmap'),
  dl('Olympus.Coder-0.2.0.AppImage'),
  dl('Olympus.Coder-0.2.0-arm64.AppImage'),
  dl('olympus-coder_0.2.0_amd64.deb'),
  dl('SHA256SUMS.txt'),
];
const PAGE = 'https://github.com/martianacademy/olympus-coder/releases/tag/v0.2.0';
const release = (extra = {}) => ({ tag_name: 'v0.2.0', html_url: PAGE, draft: false, prerelease: false, assets: ASSETS, ...extra });
/** A fake fetch (mock, records calls) answering with one status / body or throwing. */
function fakeFetch(answer) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => (typeof answer.body === 'string' ? JSON.parse(answer.body) : answer.body) };
  };
  fn.calls = calls;
  return fn;
}
const deps = (fetch, extra = {}) => ({ current: '0.1.0', platform: 'darwin', arch: 'arm64', settings: { checkForUpdates: true }, fetch, ...extra });

await test('semver compare: numeric parts, v prefix, pre-releases below the release', () => {
  assert.ok(U.compareVersions('0.2.0', '0.1.0') > 0);
  assert.ok(U.compareVersions('v0.10.0', '0.9.9') > 0);
  assert.ok(U.compareVersions('1.0.0', 'v1.0.0') === 0);
  assert.ok(U.compareVersions('0.1.0', '0.1.1') < 0);
  assert.ok(U.compareVersions('1.0.0-beta.1', '1.0.0') < 0);
  assert.ok(U.compareVersions('1.0.0', '1.0.0-rc.1') > 0);
  assert.equal(U.compareVersions('nightly', '0.1.0'), 0);
});

await test('asset pick: mac arm64 / x64 dmg, win exe, linux AppImage per CPU, none → undefined', () => {
  const pick = (p, a) => U.pickAsset(ASSETS, p, a)?.split('/').pop();
  assert.equal(pick('darwin', 'arm64'), 'Olympus.Coder-0.2.0-arm64.dmg');
  assert.equal(pick('darwin', 'x64'), 'Olympus.Coder-0.2.0.dmg');
  assert.equal(pick('win32', 'x64'), 'Olympus.Coder.Setup.0.2.0.exe');
  assert.equal(pick('linux', 'x64'), 'Olympus.Coder-0.2.0.AppImage');
  assert.equal(pick('linux', 'arm64'), 'Olympus.Coder-0.2.0-arm64.AppImage');
  assert.equal(U.pickAsset([dl('Olympus.Coder-0.2.0.dmg')], 'darwin', 'arm64'), undefined);
  assert.equal(U.pickAsset(ASSETS, 'freebsd', 'x64'), undefined);
});

await test('newer release → version, release page and this platform\'s installer; request has UA + timeout', async () => {
  const f = fakeFetch({ status: 200, body: release() });
  const u = await U.findUpdate(deps(f));
  assert.deepEqual(u, { version: '0.2.0', pageUrl: PAGE, downloadUrl: ASSETS[0].browser_download_url });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, U.RELEASES_API);
  assert.match(f.calls[0].init.headers['User-Agent'], /Olympus/);
  assert.ok(f.calls[0].init.signal instanceof AbortSignal);
  assert.equal(f.calls[0].init.headers.Authorization, undefined);
});

await test('no installer for this platform → Download falls back to the release page', async () => {
  const u = await U.findUpdate(deps(fakeFetch({ status: 200, body: release({ assets: [dl('SHA256SUMS.txt')] }) })));
  assert.equal(u.downloadUrl, PAGE);
});

await test('same or older version → null', async () => {
  assert.equal(await U.findUpdate(deps(fakeFetch({ status: 200, body: release({ tag_name: 'v0.1.0' }) }))), null);
  assert.equal(await U.findUpdate(deps(fakeFetch({ status: 200, body: release({ tag_name: 'v0.0.9' }) }))), null);
});

await test('drafts, pre-releases and pre-release tags are ignored', async () => {
  assert.equal(await U.findUpdate(deps(fakeFetch({ status: 200, body: release({ draft: true }) }))), null);
  assert.equal(await U.findUpdate(deps(fakeFetch({ status: 200, body: release({ prerelease: true }) }))), null);
  assert.equal(await U.findUpdate(deps(fakeFetch({ status: 200, body: release({ tag_name: 'v0.3.0-beta.1' }) }))), null);
});

await test('skipped version → null; a later version still shows', async () => {
  assert.equal(await U.findUpdate(deps(fakeFetch({ status: 200, body: release() }), { settings: { checkForUpdates: true, skippedUpdate: '0.2.0' } })), null);
  const u = await U.findUpdate(deps(fakeFetch({ status: 200, body: release({ tag_name: 'v0.2.1' }) }), { settings: { checkForUpdates: true, skippedUpdate: '0.2.0' } }));
  assert.equal(u.version, '0.2.1');
});

await test('setting off → no request at all', async () => {
  const f = fakeFetch({ status: 200, body: release() });
  assert.equal(await U.findUpdate(deps(f, { settings: { checkForUpdates: false } })), null);
  assert.equal(f.calls.length, 0);
});

await test('403 / 404 / 500 / offline / timeout / bad JSON → null without throwing', async () => {
  for (const a of [{ status: 403, body: {} }, { status: 404, body: {} }, { status: 500, body: {} }, { status: 200, body: 'not json{' }, new TypeError('fetch failed'), new DOMException('timed out', 'TimeoutError')])
    assert.equal(await U.findUpdate(deps(fakeFetch(a))), null);
});

await test('skipUpdate stores the version in settings; checkForUpdates defaults to on', () => {
  assert.equal(S.getSettings().checkForUpdates, true);
  U.skipUpdate('0.2.0');
  assert.equal(S.getSettings().skippedUpdate, '0.2.0');
});

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
