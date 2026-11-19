// Unit tests: agents offered next to the official ACP registry (EXTRA_AGENTS in src/main/catalog.ts, e.g. ZCode):
// listed with their npx method, added with the pinned package and its env (ZCode starts in `build`, never the
// bridge's `yolo`), an official entry with the same id wins, the local CLI method keeps the env, and the registry
// cache file holds only the official list.
// Run: node tests/catalogExtras.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; no Electron needed)
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = mkdtempSync(join(tmpdir(), 'olympus-catalog-'));
globalThis.__T = { root: ROOT, settings: { customAgents: [] }, bins: {} };
const stub = (src) => `data:text/javascript,${encodeURIComponent(src)}`;
const STUBS = {
  './registry-snapshot.json': stub(`export default { agents: [] };`),
  './env': stub(`
    export const which = (b) => globalThis.__T.bins[b] ?? null;
    export const agentEnv = (e) => ({ ...process.env, ...(e ?? {}) });
    export const spawnable = (c, a) => ({ command: c, args: a });`),
  './store': stub(`
    import { writeFileSync } from 'node:fs';
    export const sharedRoot = () => globalThis.__T.root;
    export const getSettings = () => globalThis.__T.settings;
    export const updateSettings = (p) => Object.assign(globalThis.__T.settings, p);
    export const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v));`),
};
registerHooks({
  resolve(spec, ctx, next) {
    if (STUBS[spec]) return { url: STUBS[spec], shortCircuit: true };
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
});

// The official registry the app "downloads"; set per test before the module's cache is filled.
let official = [{ id: 'other-agent', name: 'Other Agent', distribution: { npx: { package: 'other@1' } } }];
let fetches = 0;
globalThis.fetch = async () => {
  fetches++;
  return { ok: true, json: async () => ({ agents: official }) };
};

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n     ${e?.stack ?? e}`);
  }
}

const C = await import(`${APP}/src/main/catalog.ts`);
globalThis.__T.bins.npx = '/usr/local/bin/npx';

await test('ZCode is listed next to the official registry, with its npx method', async () => {
  const all = await C.listCatalog();
  const z = all.find((e) => e.id === 'zcode');
  assert.ok(z, 'zcode entry present');
  assert.equal(z.name, 'ZCode');
  assert.equal(z.builtin, false);
  assert.equal(z.added, false);
  assert.deepEqual(z.methods, ['npx']);
  assert.match(z.description, /ZCode app installed and signed in/);
  assert.ok(all.some((e) => e.id === 'other-agent'), 'official entries still listed');
});

await test('adding ZCode runs the pinned bridge and starts sessions in build mode, not yolo', async () => {
  const plan = await C.planCatalogAdd('zcode', 'npx');
  assert.equal(plan.command, '/usr/local/bin/npx');
  assert.deepEqual(plan.args, ['-y', 'zcode-acp-server@0.89.0']);
  assert.deepEqual(plan.env, { ZCODE_ACP_MODE: 'build' });
  const events = [];
  const id = await C.addFromCatalog('zcode', 'npx', (ch, p) => events.push([ch, p.phase]));
  assert.equal(id, 'zcode');
  const def = globalThis.__T.settings.customAgents.find((d) => d.registryId === 'zcode');
  assert.equal(def.name, 'ZCode');
  assert.deepEqual(def.env, { ZCODE_ACP_MODE: 'build' });
  assert.deepEqual(events.at(-1), ['catalog:progress', 'done']);
  assert.equal((await C.listCatalog()).find((e) => e.id === 'zcode').added, true);
});

await test('an installed zcode-acp-server is offered as the local method and keeps the env', async () => {
  globalThis.__T.bins['zcode-acp-server'] = '/opt/bin/zcode-acp-server';
  const z = (await C.listCatalog()).find((e) => e.id === 'zcode');
  assert.deepEqual(z.methods, ['local', 'npx']);
  const plan = await C.planCatalogAdd('zcode', 'local');
  assert.equal(plan.command, '/opt/bin/zcode-acp-server');
  assert.deepEqual(plan.args, []);
  assert.deepEqual(plan.env, { ZCODE_ACP_MODE: 'build' });
  delete globalThis.__T.bins['zcode-acp-server'];
});

await test('the registry cache file holds only the official list', async () => {
  assert.equal(fetches, 1, 'fetched once, then served from memory');
  const cached = JSON.parse(readFileSync(join(ROOT, 'registry-cache.json'), 'utf8'));
  assert.deepEqual(cached.agents.map((a) => a.id), ['other-agent']);
});

await test('an official registry entry with the same id wins over the extra one', async () => {
  // A fresh module copy with an empty in-memory cache and no cache file.
  official = [{ id: 'zcode', name: 'ZCode (official)', version: '2.0.0', distribution: { npx: { package: '@zai/zcode-acp@2' } } }];
  globalThis.__T.root = mkdtempSync(join(tmpdir(), 'olympus-catalog-'));
  const C2 = await import(`${APP}/src/main/catalog.ts?fresh`);
  const z = (await C2.listCatalog()).filter((e) => e.id === 'zcode');
  assert.equal(z.length, 1, 'listed once');
  assert.equal(z[0].name, 'ZCode (official)');
  const plan = await C2.planCatalogAdd('zcode', 'npx');
  assert.deepEqual(plan.args, ['-y', '@zai/zcode-acp@2']);
  assert.equal(plan.env, undefined);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
