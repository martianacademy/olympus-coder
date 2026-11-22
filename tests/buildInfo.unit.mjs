// Unit tests: src/main/buildInfo.ts — after an install under a running Olympus, a restart is asked for only when the
// main process / preload code changed; a window-only change needs just a reload (user's request, 2026-11-22: restarts
// stop background processes).
// Run: node tests/buildInfo.unit.mjs
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const { codeHash, pageEntries, createBuildInfo } = await import(`${APP}/src/main/buildInfo.ts`);

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n     ${e?.stack ?? e}`);
  }
}

/** A fake `out/` like electron-vite writes: main, preload, renderer with two pages. */
function makeOut() {
  const out = mkdtempSync(join(tmpdir(), 'olympus-buildinfo-'));
  for (const d of ['main', 'preload', 'renderer/assets']) mkdirSync(join(out, d), { recursive: true });
  writeFileSync(join(out, 'main', 'index.js'), 'console.log("main v1");');
  writeFileSync(join(out, 'preload', 'index.mjs'), 'export {}; // preload v1');
  page(out, 'index.html', 'index-AAA111.js');
  page(out, 'remote.html', 'remote-BBB222.js');
  return out;
}
const page = (out, name, entry) =>
  writeFileSync(join(out, 'renderer', name), `<!doctype html><html><head>\n<script type="module" crossorigin src="./assets/${entry}"></script>\n<link rel="modulepreload" crossorigin href="./assets/dist-X.js"></head></html>`);

test('page entries are read from each built page', () => {
  const out = makeOut();
  assert.deepEqual(pageEntries(join(out, 'renderer')), { 'index.html': 'index-AAA111.js', 'remote.html': 'remote-BBB222.js' });
  rmSync(out, { recursive: true, force: true });
});

test('a rebuild with the same main code (new mtime only) is NOT a restart', () => {
  const out = makeOut();
  const info = createBuildInfo(join(out, 'main'));
  writeFileSync(join(out, 'main', 'index.js'), 'console.log("main v1");'); // rewritten, same bytes
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(out, 'main', 'index.js'), later, later);
  assert.equal(info().updated, false);
  rmSync(out, { recursive: true, force: true });
});

test('a window-only install: no restart, the new entry is visible for a reload', () => {
  const out = makeOut();
  const info = createBuildInfo(join(out, 'main'));
  page(out, 'index.html', 'index-CCC333.js');
  const r = info();
  assert.equal(r.updated, false);
  assert.equal(r.entries['index.html'], 'index-CCC333.js');
  rmSync(out, { recursive: true, force: true });
});

test('changed main code asks for a restart', () => {
  const out = makeOut();
  const info = createBuildInfo(join(out, 'main'));
  writeFileSync(join(out, 'main', 'index.js'), 'console.log("main v2");');
  assert.equal(info().updated, true);
  rmSync(out, { recursive: true, force: true });
});

test('changed preload asks for a restart too', () => {
  const out = makeOut();
  const info = createBuildInfo(join(out, 'main'));
  writeFileSync(join(out, 'preload', 'index.mjs'), 'export {}; // preload v2');
  assert.equal(info().updated, true);
  rmSync(out, { recursive: true, force: true });
});

test('a new main chunk file counts as a main change', () => {
  const out = makeOut();
  const before = codeHash([join(out, 'main')]);
  writeFileSync(join(out, 'main', 'chunk-1.js'), 'export const x = 1;');
  assert.notEqual(codeHash([join(out, 'main')]), before);
  rmSync(out, { recursive: true, force: true });
});

test('missing folders are fine (no renderer: no entries)', () => {
  assert.deepEqual(pageEntries('/nonexistent/olympus/renderer'), {});
  assert.equal(typeof codeHash(['/nonexistent/olympus/main']), 'string');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
