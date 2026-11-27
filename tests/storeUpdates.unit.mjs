// Unit tests for the Microsoft Store copy in src/main/updates.ts: a copy installed from the Store
// (`process.windowsStore`) never asks GitHub, never downloads or installs, and Settings gets one line,
// "This copy updates through the Microsoft Store." with `managed: 'store'` (no update modes shown).
// Run: node tests/storeUpdates.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; `electron` is stubbed)
// UPDATES_TS=<path to another updates.ts> runs the same checks against that copy (used to show HEAD fails them).
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = mkdtempSync(join(tmpdir(), 'olympus-store-updates-unit-'));
const UD = join(TMP, 'userData');
const SHARED = join(TMP, 'shared');
for (const d of [UD, SHARED]) mkdirSync(d, { recursive: true });
delete process.env.OLYMPUS_HOME;
process.env.AGENTDESK_SHARED_ROOT = SHARED;
writeFileSync(join(UD, 'settings.json'), JSON.stringify({ sharedRoot: SHARED, designVersion: 2, updateMode: 'auto' }));

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
    // Mock of the few electron APIs these modules touch (labelled mock, not the real app). app.quit records calls.
    if (url === 'mock:electron')
      return {
        format: 'module',
        shortCircuit: true,
        source: `export const app = { getPath: () => ${JSON.stringify(UD)}, getVersion: () => '0.1.0', isPackaged: true, quit: () => { globalThis.__quits = (globalThis.__quits || 0) + 1; } }; export const safeStorage = { isEncryptionAvailable: () => false }; export const shell = {};`,
      };
    return next(url, ctx);
  },
});

const U = await import(pathToFileURL(process.env.UPDATES_TS || `${APP}/src/main/updates.ts`).href);
const STORE_TEXT = 'This copy updates through the Microsoft Store.';

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${String(e?.stack ?? e).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

/** A newer release with a Windows installer (sample data). */
const RELEASE = {
  tag_name: 'v0.2.0',
  html_url: 'https://github.com/martianacademy/olympus-coder/releases/tag/v0.2.0',
  draft: false,
  prerelease: false,
  assets: [
    { name: 'Olympus.Coder.Setup.0.2.0.exe', browser_download_url: 'https://github.com/martianacademy/olympus-coder/releases/download/v0.2.0/Olympus.Coder.Setup.0.2.0.exe' },
    { name: 'SHA256SUMS.txt', browser_download_url: 'https://github.com/martianacademy/olympus-coder/releases/download/v0.2.0/SHA256SUMS.txt' },
  ],
};
/** A fake fetch (mock) that records every call and answers with RELEASE. */
function fakeFetch() {
  const calls = [];
  const f = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => RELEASE, text: async () => '' };
  };
  f.calls = calls;
  return f;
}
const deps = (f, extra = {}) => ({ current: '0.1.0', platform: 'win32', arch: 'x64', settings: { updateMode: 'notify' }, fetch: f, ...extra });

await test('Store copy: checkRelease never asks GitHub and returns the Store line', async () => {
  for (const updateMode of ['notify', 'auto', 'off']) {
    const f = fakeFetch();
    const r = await U.checkRelease(deps(f, { store: true, settings: { updateMode } }));
    assert.equal(f.calls.length, 0, `GitHub was asked in ${updateMode} mode`);
    assert.equal(r.info, null);
    assert.equal(r.text, STORE_TEXT);
    assert.equal(r.managed, 'store');
  }
});

await test('Store copy: no installer offered even when a newer release exists', async () => {
  assert.equal(await U.findUpdate(deps(fakeFetch(), { store: true, settings: { updateMode: 'auto' } })), null);
});

await test('not a Store copy: the GitHub check works as before', async () => {
  const f = fakeFetch();
  const r = await U.checkRelease(deps(f, { store: false }));
  assert.equal(f.calls.length, 1);
  assert.equal(r.info.version, '0.2.0');
  assert.match(r.info.downloadUrl, /Setup\.0\.2\.0\.exe$/);
  assert.equal(r.managed, undefined);
});

// The app's checker, as it runs inside the Store package: process.windowsStore = true on Windows.
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const realFetch = globalThis.fetch;
const netCalls = [];
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
process.windowsStore = true;
globalThis.fetch = async (url) => {
  netCalls.push(String(url));
  return { ok: true, status: 200, json: async () => RELEASE, text: async () => '' };
};
try {
  await test('Store copy: Settings gets the Store line before any check ran', async () => {
    const last = U.lastUpdateCheck();
    assert.ok(last, 'lastUpdateCheck() returned nothing');
    assert.equal(last.text, STORE_TEXT);
    assert.equal(last.managed, 'store');
  });

  await test('Store copy: "Check now" in auto mode makes no network request, shows no notice and installs nothing', async () => {
    const events = [];
    process.env.OLYMPUS_UPDATE_DELAY_MS = '3600000';
    U.startUpdateChecker((channel, payload) => events.push([channel, payload]));
    const r = await U.checkNow();
    assert.equal(netCalls.length, 0, `network was used: ${netCalls.join(', ')}`);
    assert.equal(r.text, STORE_TEXT);
    assert.equal(r.managed, 'store');
    assert.equal(U.currentUpdate(), null);
    assert.equal(events.some(([c, p]) => c === 'update:available' && p), false);
    assert.throws(() => U.installAndRestart());
    assert.equal(globalThis.__quits ?? 0, 0, 'the app was asked to quit');
    assert.equal(U.onAppWillQuit(), false);
  });
} finally {
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
  delete process.windowsStore;
  globalThis.fetch = realFetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
