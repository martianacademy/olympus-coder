// Unit test for src/main/projectWatch.ts: projects.json changes are announced exactly once, whoever wrote them.
// Run: node tests/projectWatch.unit.mjs
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const { watchProjectsFile } = await import(`${APP}/src/main/projectWatch.ts`);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DEBOUNCE = 200;
/** Long enough for macOS FSEvents to deliver plus the debounce. */
const SETTLE = 900;

let pass = 0;
let fail = 0;
async function test(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-projwatch-'));
  const file = join(dir, 'projects.json');
  writeFileSync(file, JSON.stringify([{ id: 'a', name: 'A', path: '/tmp/a', createdAt: 1 }], null, 2));
  let count = 0;
  const w = watchProjectsFile({ dir: () => dir, onChange: () => count++, debounceMs: DEBOUNCE });
  try {
    await wait(150); // let the watcher start before the first write
    await fn({ dir, file, w, count: () => count });
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.error(`FAIL  ${name}\n`, e);
  } finally {
    w.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Same as store.writeJson / an agent's careful write: temp file + rename (a new inode). */
function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}
const two = [
  { id: 'a', name: 'A', path: '/tmp/a', createdAt: 1 },
  { id: 'b', name: 'B', path: '/tmp/b', createdAt: 2 },
];

await test('nothing is announced at start', async ({ count }) => {
  await wait(SETTLE);
  assert.equal(count(), 0);
});

await test('external atomic replace fires exactly one event', async ({ file, count }) => {
  atomicWrite(file, two);
  await wait(SETTLE);
  assert.equal(count(), 1);
});

await test('a second external replace after the first fires again (watcher survives the inode swap)', async ({ file, count }) => {
  atomicWrite(file, two);
  await wait(SETTLE);
  atomicWrite(file, [two[1]]);
  await wait(SETTLE);
  assert.equal(count(), 2);
});

await test("the app's own write (write + notify) fires exactly one event", async ({ file, w, count }) => {
  atomicWrite(file, two);
  w.notify();
  assert.equal(count(), 1, 'announced at once by notify');
  await wait(SETTLE);
  assert.equal(count(), 1, 'the watcher event that follows sees the same content');
});

await test('debounce: a burst of writes fires once, with the last content', async ({ file, count }) => {
  for (let i = 0; i < 6; i++) {
    atomicWrite(file, [...two, { id: `x${i}`, name: `X${i}`, path: `/tmp/x${i}`, createdAt: 3 + i }]);
    await wait(20);
  }
  await wait(SETTLE);
  assert.equal(count(), 1);
});

await test('an unchanged rewrite fires none', async ({ file, count }) => {
  atomicWrite(file, [{ id: 'a', name: 'A', path: '/tmp/a', createdAt: 1 }]);
  await wait(SETTLE);
  assert.equal(count(), 0);
});

await test('half-written / invalid JSON fires none; the valid write after it fires one', async ({ file, count }) => {
  writeFileSync(file, '[{"id": "a", "na');
  await wait(SETTLE);
  assert.equal(count(), 0);
  atomicWrite(file, two);
  await wait(SETTLE);
  assert.equal(count(), 1);
});

await test('other files in the shared root are ignored', async ({ dir, count }) => {
  writeFileSync(join(dir, 'schedules.json'), '[]');
  atomicWrite(join(dir, 'settings-like.json'), { a: 1 });
  await wait(SETTLE);
  assert.equal(count(), 0);
});

await test('rearm follows a moved shared root and announces its different list', async ({ file }) => {
  const other = mkdtempSync(join(tmpdir(), 'olympus-projwatch-b-'));
  try {
    atomicWrite(join(other, 'projects.json'), two);
    let n = 0;
    let root = dirname(file);
    const w2 = watchProjectsFile({ dir: () => root, onChange: () => n++, debounceMs: DEBOUNCE });
    root = other;
    w2.rearm();
    assert.equal(n, 1, 'new root has a different list');
    await wait(150);
    atomicWrite(join(other, 'projects.json'), [two[1]]);
    await wait(SETTLE);
    assert.equal(n, 2, 'watches the new root');
    atomicWrite(file, [two[0], { id: 'z', name: 'Z', path: '/tmp/z', createdAt: 9 }]);
    await wait(SETTLE);
    assert.equal(n, 2, 'old root is no longer watched by w2');
    w2.close();
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
