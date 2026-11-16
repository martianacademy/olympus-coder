// Unit tests: ACP client fs + terminal methods (src/main/acpClientFs.ts, acpTerminals.ts, editorBuffers.ts).
// Run: node tests/acpClient.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; no Electron needed)
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
});

const F = await import(`${APP}/src/main/acpClientFs.ts`);
const T = await import(`${APP}/src/main/acpTerminals.ts`);
const B = await import(`${APP}/src/main/editorBuffers.ts`);

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
const INVALID = -32602;
const NOT_FOUND = -32002;
async function rejects(fn, code, re) {
  let err;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected an error');
  if (code !== undefined) assert.equal(err.code, code, `code ${err.code}: ${err.message}`);
  if (re) assert.match(err.message + ' ' + JSON.stringify(err.data ?? ''), re);
  return err;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- fixtures
// Everything lives in one scratch folder. The real OS temp folder is swapped for TMP inside it, so OUT is
// really outside the sandbox (by default the OS temp folder is always allowed).
mkdirSync('/tmp/olympus-acpclient-e2e', { recursive: true });
const BASE = realpathSync(mkdtempSync('/tmp/olympus-acpclient-e2e/unit-'));
const PROJ = join(BASE, 'proj');
const EXTRA = join(BASE, 'extra');
const OUT = join(BASE, 'outside');
const TMP = join(BASE, 'tmp');
mkdirSync(TMP);
for (const d of [PROJ, EXTRA, OUT, join(PROJ, 'sub')]) mkdirSync(d, { recursive: true });
writeFileSync(join(PROJ, 'a.txt'), 'one\ntwo\nthree\nfour\n');
writeFileSync(join(PROJ, 'crlf.txt'), 'l1\r\nl2\r\nl3');
writeFileSync(join(OUT, 'secret.txt'), 'TOP SECRET');
writeFileSync(join(EXTRA, 'e.txt'), 'extra file');
writeFileSync(join(PROJ, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
symlinkSync(join(OUT, 'secret.txt'), join(PROJ, 'link-out.txt'));
symlinkSync(OUT, join(PROJ, 'linkdir'));
symlinkSync(join(PROJ, 'a.txt'), join(PROJ, 'link-in.txt'));
symlinkSync(join(OUT, 'does-not-exist.txt'), join(PROJ, 'dangling.txt'));

const writes = [];
const ctx = { roots: [PROJ, EXTRA], tempDirs: [TMP], unsavedText: (p) => B.unsavedEditorText(p), onWritten: (w) => writes.push(w) };
const read = (path, extra = {}) => F.readTextFile({ sessionId: 's', path, ...extra }, ctx).content;
const write = (path, content) => F.writeTextFile({ sessionId: 's', path, content }, ctx);

// ---------------------------------------------------------------- fs/read_text_file
await test('read: whole file', () => assert.equal(read(join(PROJ, 'a.txt')), 'one\ntwo\nthree\nfour\n'));
await test('read: line/limit (1-based, keeps line endings)', () => {
  const p = join(PROJ, 'a.txt');
  assert.equal(read(p, { line: 2, limit: 2 }), 'two\nthree\n');
  assert.equal(read(p, { line: 4 }), 'four\n');
  assert.equal(read(p, { line: 5 }), '');
  assert.equal(read(p, { line: 99, limit: 3 }), '');
  assert.equal(read(p, { limit: 1 }), 'one\n');
  assert.equal(read(p, { limit: 0 }), '');
  assert.equal(read(p, { line: null, limit: null }), 'one\ntwo\nthree\nfour\n');
  assert.equal(read(join(PROJ, 'crlf.txt'), { line: 2, limit: 5 }), 'l2\r\nl3');
});
await test('read: bad line/limit → invalid params', async () => {
  const p = join(PROJ, 'a.txt');
  await rejects(() => read(p, { line: 0 }), INVALID);
  await rejects(() => read(p, { line: -2 }), INVALID);
  await rejects(() => read(p, { line: 1.5 }), INVALID);
  await rejects(() => read(p, { limit: -1 }), INVALID);
});
await test('read: relative path and NUL refused', async () => {
  await rejects(() => read('a.txt'), INVALID, /absolute/);
  await rejects(() => read(join(PROJ, 'a\0.txt')), INVALID);
});
await test('read: `..` escape refused', async () => {
  await rejects(() => read(join(PROJ, '..', 'outside', 'secret.txt')), INVALID, /outside/);
  await rejects(() => read(join(PROJ, 'sub', '..', '..', 'outside', 'secret.txt')), INVALID, /outside/);
});
await test('read: symlink pointing outside refused (file and folder link)', async () => {
  await rejects(() => read(join(PROJ, 'link-out.txt')), INVALID, /outside/);
  await rejects(() => read(join(PROJ, 'linkdir', 'secret.txt')), INVALID, /outside/);
});
await test('read: symlink to a file inside the project allowed', () => assert.equal(read(join(PROJ, 'link-in.txt'), { limit: 1 }), 'one\n'));
await test('read: additional directory and temp folder allowed', () => {
  assert.equal(read(join(EXTRA, 'e.txt')), 'extra file');
  writeFileSync(join(TMP, 't.txt'), 'tmp ok');
  assert.equal(read(join(TMP, 't.txt')), 'tmp ok');
  // The default sandbox includes the real OS temp folder.
  assert.ok(F.sandboxRoots([]).includes(realpathSync(tmpdir())));
});
await test('read: missing inside → not found; missing outside → access denied', async () => {
  await rejects(() => read(join(PROJ, 'nope.txt')), NOT_FOUND);
  await rejects(() => read(join(OUT, 'nope.txt')), INVALID, /outside/);
  await rejects(() => read('/etc/passwd'), INVALID, /outside/);
});
await test('read: binary file refused; folder refused', async () => {
  await rejects(() => read(join(PROJ, 'bin.dat')), INVALID, /binary/);
  await rejects(() => read(join(PROJ, 'sub')), INVALID);
});
await test('read: big file in parts (chunked) + UTF-8 across chunk boundaries', () => {
  const lines = [];
  for (let i = 1; i <= 200_000; i++) lines.push(`line ${i} ✓ 😀`);
  const p = join(PROJ, 'big.txt');
  writeFileSync(p, lines.join('\n') + '\n');
  assert.equal(read(p, { line: 150_000, limit: 3 }), `line 150000 ✓ 😀\nline 150001 ✓ 😀\nline 150002 ✓ 😀\n`);
  assert.equal(read(p, { line: 200_000 }), `line 200000 ✓ 😀\n`);
  assert.equal(read(p), readFileSync(p, 'utf8'));
});
await test('read: more than 10 MB of text at once refused, parts still fine', async () => {
  const p = join(PROJ, 'huge.txt');
  writeFileSync(p, ('x'.repeat(1023) + '\n').repeat(11 * 1024));
  await rejects(() => read(p), INVALID, /too large/);
  assert.equal(read(p, { line: 5000, limit: 1 }).length, 1024);
});
await test('read: unsaved editor text wins over disk (with line/limit)', () => {
  B.reportEditorBuffers('win1', PROJ, [{ path: 'a.txt', text: 'UNSAVED 1\nUNSAVED 2\n' }]);
  assert.equal(read(join(PROJ, 'a.txt')), 'UNSAVED 1\nUNSAVED 2\n');
  assert.equal(read(join(PROJ, 'a.txt'), { line: 2 }), 'UNSAVED 2\n');
  // Through a symlink to the same file too.
  assert.equal(read(join(PROJ, 'link-in.txt'), { limit: 1 }), 'UNSAVED 1\n');
  B.reportEditorBuffers('win1', PROJ, []);
  assert.equal(read(join(PROJ, 'a.txt'), { limit: 1 }), 'one\n');
});
await test('editor buffers: outside paths ignored, stale reports expire, newest window wins', () => {
  B.reportEditorBuffers('w', PROJ, [{ path: '../outside/secret.txt', text: 'x' }, { path: '/etc/passwd', text: 'x' }]);
  assert.equal(B.unsavedEditorText(join(OUT, 'secret.txt')), undefined);
  B.reportEditorBuffers('old', PROJ, [{ path: 'a.txt', text: 'OLD' }], 1000);
  B.reportEditorBuffers('new', PROJ, [{ path: 'a.txt', text: 'NEW' }], 2000);
  assert.equal(B.unsavedEditorText(join(PROJ, 'a.txt'), 3000), 'NEW');
  assert.equal(B.unsavedEditorText(join(PROJ, 'a.txt'), 2000 + 91_000), undefined);
  B.clearEditorBuffers();
});

// ---------------------------------------------------------------- fs/write_text_file
await test('write: creates parent folders, reports created + no conflict', () => {
  writes.length = 0;
  write(join(PROJ, 'new', 'deep', 'f.txt'), 'hello');
  assert.equal(readFileSync(join(PROJ, 'new', 'deep', 'f.txt'), 'utf8'), 'hello');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].created, true);
  assert.equal(writes[0].conflict, false);
  write(join(PROJ, 'new', 'deep', 'f.txt'), 'again');
  assert.equal(writes[1].created, false);
});
await test('write: `..` escape refused and nothing written', async () => {
  await rejects(() => write(join(PROJ, '..', 'outside', 'pwn.txt'), 'x'), INVALID, /outside/);
  assert.equal(existsSync(join(OUT, 'pwn.txt')), false);
});
await test('write: through folder symlink pointing outside refused (incl. missing subfolders)', async () => {
  await rejects(() => write(join(PROJ, 'linkdir', 'pwn.txt'), 'x'), INVALID, /outside/);
  await rejects(() => write(join(PROJ, 'linkdir', 'a', 'b', 'pwn.txt'), 'x'), INVALID, /outside/);
  assert.equal(existsSync(join(OUT, 'pwn.txt')), false);
  assert.equal(existsSync(join(OUT, 'a')), false);
});
await test('write: through file symlink pointing outside refused', async () => {
  await rejects(() => write(join(PROJ, 'link-out.txt'), 'x'), INVALID, /outside/);
  assert.equal(readFileSync(join(OUT, 'secret.txt'), 'utf8'), 'TOP SECRET');
});
await test('write: broken symlink refused, its target not created', async () => {
  await rejects(() => write(join(PROJ, 'dangling.txt'), 'x'), INVALID, /symbolic link|outside/);
  assert.equal(existsSync(join(OUT, 'does-not-exist.txt')), false);
});
await test('write: folder path, project root and absolute outside path refused', async () => {
  await rejects(() => write(join(PROJ, 'sub'), 'x'), INVALID, /folder/);
  await rejects(() => write(PROJ, 'x'), INVALID, /folder/);
  await rejects(() => write(join(OUT, 'x.txt'), 'x'), INVALID, /outside/);
  await rejects(() => write('rel.txt', 'x'), INVALID, /absolute/);
});
await test('write: non-string content refused', async () => {
  await rejects(() => F.writeTextFile({ sessionId: 's', path: join(PROJ, 'c.txt'), content: 5 }, ctx), INVALID);
});
await test('write: file with unsaved edits → conflict flagged (disk written, editor keeps its text)', () => {
  writes.length = 0;
  B.reportEditorBuffers('win1', PROJ, [{ path: 'sub/conf.txt', text: 'user edits' }]);
  write(join(PROJ, 'sub', 'conf.txt'), 'agent text');
  assert.equal(writes[0].conflict, true);
  assert.equal(readFileSync(join(PROJ, 'sub', 'conf.txt'), 'utf8'), 'agent text');
  // Same text as the unsaved buffer: nothing to resolve.
  write(join(PROJ, 'sub', 'conf.txt'), 'user edits');
  assert.equal(writes[1].conflict, false);
  B.clearEditorBuffers();
});

// ---------------------------------------------------------------- output buffer
await test('OutputBuffer: truncates from the start at a character boundary', () => {
  const full = 'aé€😀'.repeat(50) + 'END';
  for (const limit of [0, 1, 2, 3, 4, 5, 7, 10, 33, 100]) {
    const b = new T.OutputBuffer(limit);
    for (const ch of full) b.append(ch);
    const { output, truncated } = b.read();
    assert.ok(Buffer.byteLength(output) <= limit, `limit ${limit}: ${Buffer.byteLength(output)} bytes`);
    assert.ok(full.endsWith(output), `limit ${limit}: kept text is a suffix`);
    assert.ok(!output.includes('\uFFFD'), 'no broken characters');
    assert.equal(truncated, true);
    assert.ok(Buffer.byteLength(output) > limit - 4, 'drops at most one character extra');
  }
  const small = new T.OutputBuffer(1000);
  small.append('hi');
  assert.deepEqual(small.read(), { output: 'hi', truncated: false });
});

// ---------------------------------------------------------------- client terminals
const events = [];
const store = new T.AcpTerminalStore();
store.setEmitter((ch, p) => events.push([ch, p]));
const mgr = new T.AcpTerminalManager(store);
const tctx = (over = {}) => ({ sessionId: 'S1', owner: 'thread-1', defaultCwd: PROJ, env: { ...process.env }, ...over });
const run = async (params, c = tctx()) => {
  const { terminalId } = await mgr.create({ sessionId: c.sessionId, ...params }, c);
  return terminalId;
};

await test('terminal: shell command line, output + exit 0, default cwd = project', async () => {
  const id = await run({ command: 'echo hello; pwd' });
  const ex = await mgr.waitForExit({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' });
  assert.deepEqual(ex, { exitCode: 0, signal: null });
  const o = mgr.output({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' });
  assert.equal(o.output, `hello\n${PROJ}\n`);
  assert.equal(o.truncated, false);
  assert.deepEqual(o.exitStatus, { exitCode: 0, signal: null });
});
await test('terminal: args run directly (no shell), stderr merged', async () => {
  const id = await run({ command: process.execPath, args: ['-e', 'process.stdout.write("a b;$HOME\\n"); process.stderr.write("err\\n")'] });
  await mgr.waitForExit({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' });
  const out = mgr.output({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' }).output;
  assert.ok(out.includes('a b;$HOME\n') && out.includes('err\n'), JSON.stringify(out));
});
await test('terminal: non-zero exit code, cwd and env honoured', async () => {
  const id = await run({ command: 'pwd; echo "$OLY_TEST"; exit 3', cwd: join(PROJ, 'sub'), env: [{ name: 'OLY_TEST', value: 'v=1 ✓' }] });
  const ex = await mgr.waitForExit({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' });
  assert.deepEqual(ex, { exitCode: 3, signal: null });
  assert.equal(mgr.output({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' }).output, `${join(PROJ, 'sub')}\nv=1 ✓\n`);
});
await test('terminal: outputByteLimit keeps the end, sets truncated', async () => {
  const id = await run({ command: process.execPath, args: ['-e', 'for (let i = 0; i < 2000; i++) process.stdout.write(`row ${i} é😀\\n`)'], outputByteLimit: 100 });
  await mgr.waitForExit({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' });
  const o = mgr.output({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' });
  assert.equal(o.truncated, true);
  assert.ok(Buffer.byteLength(o.output) <= 100 && Buffer.byteLength(o.output) > 90, String(Buffer.byteLength(o.output)));
  assert.ok(o.output.endsWith('row 1999 é😀\n'));
  assert.ok(!o.output.includes('\uFFFD'));
  // The window still has everything (well under its cap).
  assert.ok(store.snapshot(`thread-1/${id}`).output.startsWith('row 0 '));
});
await test('terminal: UTF-8 split across pipe writes decodes cleanly', async () => {
  const id = await run({ command: process.execPath, args: ['-e', 'const b = Buffer.from("😀✓"); process.stdout.write(b.subarray(0, 2)); setTimeout(() => process.stdout.write(b.subarray(2)), 50)'] });
  await mgr.waitForExit({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' });
  assert.equal(mgr.output({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' }).output, '😀✓');
});
await test('terminal: kill stops the whole process tree; output and exit stay readable', async () => {
  const id = await run({ command: 'sleep 30 & echo $!; echo started; wait' });
  let o;
  for (let i = 0; i < 50; i++) {
    o = mgr.output({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' });
    if (o.output.includes('started')) break;
    await sleep(50);
  }
  const bgPid = Number(o.output.split('\n')[0]);
  assert.ok(bgPid > 0 && alive(bgPid), 'background child running');
  assert.deepEqual(mgr.kill({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' }), {});
  const ex = await mgr.waitForExit({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' });
  assert.equal(ex.exitCode, null);
  assert.equal(ex.signal, 'SIGTERM');
  await sleep(100);
  assert.equal(alive(bgPid), false, 'background child killed too');
  const after = mgr.output({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' });
  assert.ok(after.output.includes('started'));
  assert.deepEqual(after.exitStatus, { exitCode: null, signal: 'SIGTERM' });
});
await test('terminal: SIGTERM-ignoring command is killed after the grace period', async () => {
  const id = await run({ command: "trap '' TERM; echo ready; while :; do sleep 0.1; done" });
  for (let i = 0; i < 50 && !mgr.output({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' }).output.includes('ready'); i++) await sleep(50);
  const t0 = Date.now();
  mgr.kill({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' });
  const ex = await mgr.waitForExit({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' });
  assert.equal(ex.signal, 'SIGKILL');
  assert.ok(Date.now() - t0 >= 2500, 'waited for the grace period');
});
await test('terminal: release kills a running command, frees the id, window keeps the output', async () => {
  const id = await run({ command: 'echo kept; sleep 30' });
  for (let i = 0; i < 50 && !mgr.output({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' }).output.includes('kept'); i++) await sleep(50);
  const waiting = mgr.waitForExit({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' });
  assert.deepEqual(mgr.release({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' }), {});
  const ex = await waiting;
  assert.equal(ex.signal, 'SIGTERM');
  await rejects(() => mgr.output({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' }), INVALID, /released/);
  await rejects(() => mgr.release({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' }), INVALID);
  const snap = store.snapshot(`thread-1/${id}`);
  assert.equal(snap.released, true);
  assert.equal(snap.running, false);
  assert.ok(snap.output.includes('kept'));
});
await test('terminal: ids are scoped to their session', async () => {
  const id = await run({ command: 'echo mine' });
  await rejects(() => mgr.output({ sessionId: 'S2', terminalId: id }, { sessionId: 'S2' }), INVALID);
  await rejects(() => mgr.kill({ sessionId: 'S2', terminalId: id }, { sessionId: 'S2' }), INVALID);
  await rejects(() => mgr.waitForExit({ sessionId: 'S2', terminalId: 'nope' }, { sessionId: 'S2' }), INVALID);
  await mgr.waitForExit({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' });
});
await test('terminal: bad requests refused (cwd, args, env, limit, command, mayRun)', async () => {
  await rejects(() => run({ command: 'echo', cwd: 'relative/dir' }), INVALID, /absolute/);
  await rejects(() => run({ command: 'echo', cwd: join(PROJ, 'nope') }), INVALID, /existing folder/);
  await rejects(() => run({ command: 'echo', args: [1] }), INVALID);
  await rejects(() => run({ command: 'echo', env: [{ name: 'A=B', value: 'x' }] }), INVALID);
  await rejects(() => run({ command: 'echo', outputByteLimit: -1 }), INVALID);
  await rejects(() => run({ command: '  ' }), INVALID);
  await rejects(() => run({ command: 'echo hi' }, tctx({ mayRun: () => 'No turn is running.' })), -32600, /No turn/);
});
await test('terminal: missing program (direct spawn) → error, nothing left behind', async () => {
  await rejects(() => run({ command: '/no/such/program-xyz', args: ['a'] }), -32603, /Could not start/);
  const sh = await run({ command: 'no-such-program-xyz-123' });
  const ex = await mgr.waitForExit({ sessionId: 'S1', terminalId: sh }, { sessionId: 'S1' });
  assert.equal(ex.exitCode, 127);
});
await test('terminal: Stop turn (killOwner) and session end (releaseSession)', async () => {
  const a = await run({ command: 'sleep 30' });
  const b = await run({ command: 'sleep 30' }, tctx({ owner: 'thread-2' }));
  assert.equal(mgr.killOwner('thread-1'), 1);
  assert.equal((await mgr.waitForExit({ sessionId: 'S1', terminalId: a }, { sessionId: 'S1' })).signal, 'SIGTERM');
  assert.equal(store.meta(`thread-2/${b}`).running, true);
  mgr.releaseSession('S1');
  await rejects(() => mgr.output({ sessionId: 'S1', terminalId: b }, { sessionId: 'S1' }), INVALID);
  for (let i = 0; i < 40 && store.meta(`thread-2/${b}`).running; i++) await sleep(50);
  assert.equal(store.meta(`thread-2/${b}`).running, false);
  assert.equal(store.meta(`thread-2/${b}`).released, true);
});
await test('store: appends line up with `end`, meta events on start/exit/release', async () => {
  events.length = 0;
  const id = await run({ command: process.execPath, args: ['-e', 'for (let i = 0; i < 5; i++) setTimeout(() => process.stdout.write(`x${i}\\n`), i * 60)'] });
  await mgr.waitForExit({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' });
  mgr.release({ sessionId: 'S1', terminalId: id }, { sessionId: 'S1' });
  const mine = events.filter(([, p]) => p.key === `thread-1/${id}`).map(([, p]) => p);
  let text = '';
  for (const e of mine) {
    if (e.append === undefined) continue;
    text += e.append;
    assert.equal(e.end, text.length);
  }
  assert.equal(text, 'x0\nx1\nx2\nx3\nx4\n');
  const metas = mine.filter((e) => e.meta).map((e) => e.meta);
  assert.equal(metas[0].running, true);
  assert.ok(metas.some((m) => m.exitStatus?.exitCode === 0 && !m.released));
  assert.equal(metas.at(-1).released, true);
  const lastAppend = mine.findLastIndex((e) => e.append !== undefined);
  const exitMeta = mine.findIndex((e) => e.meta?.exitStatus);
  assert.ok(lastAppend < exitMeta, 'all output is sent before the exit');
});
await test('store: window copy is clipped to the end past its cap', () => {
  const s = new T.AcpTerminalStore();
  s.open('o', 't', { source: 'agent' });
  const chunk = 'y'.repeat(100 * 1024);
  for (let i = 0; i < 8; i++) s.append('o/t', chunk);
  const snap = s.snapshot('o/t');
  assert.equal(snap.clipped, true);
  assert.ok(snap.output.length <= T.DISPLAY_CAP * 1.25);
  assert.equal(snap.end, 800 * 1024);
  assert.match(s.tailText('o/t', 10), /^… \(earlier output not kept\)\nyyyyyyyyyy$/);
});

// ---------------------------------------------------------------- agent terminals from tool _meta
await test('meta: Codex terminal_info + terminal_output_delta stream + terminal_exit', () => {
  const s = new T.AcpTerminalStore();
  const ev = [];
  s.setEmitter((ch, p) => ev.push(p));
  const raw = { command: ['/bin/zsh', '-lc', 'npm test'] };
  assert.deepEqual(T.applyTerminalMeta(s, 'th', { terminal_info: { terminal_id: 'call_1', cwd: '/w' } }, raw), ['th/call_1']);
  T.applyTerminalMeta(s, 'th', { terminal_output_delta: { terminal_id: 'call_1', data: 'PASS a\n' } });
  T.applyTerminalMeta(s, 'th', { terminal_output_delta: { terminal_id: 'call_1', data: 'PASS b\n' } });
  let snap = s.snapshot('th/call_1');
  assert.equal(snap.output, 'PASS a\nPASS b\n');
  assert.equal(snap.running, true);
  assert.equal(snap.command, 'npm test');
  assert.equal(snap.cwd, '/w');
  assert.equal(snap.source, 'agent');
  // End of command: last output and exit in one update (output is applied first).
  T.applyTerminalMeta(s, 'th', { terminal_output_delta: { terminal_id: 'call_1', data: 'done\n' }, terminal_exit: { terminal_id: 'call_1', exit_code: 1, signal: null } });
  snap = s.snapshot('th/call_1');
  assert.equal(snap.output, 'PASS a\nPASS b\ndone\n');
  assert.deepEqual(snap.exitStatus, { exitCode: 1, signal: null });
  assert.equal(snap.running, false);
  // A replay of the same updates (session/load) does not double the text.
  T.applyTerminalMeta(s, 'th', { terminal_output_delta: { terminal_id: 'call_1', data: 'PASS a\n' } });
  T.applyTerminalMeta(s, 'th', { terminal_exit: { terminal_id: 'call_1', exit_code: 0, signal: null } });
  assert.equal(s.snapshot('th/call_1').output, 'PASS a\nPASS b\ndone\n');
  assert.equal(s.snapshot('th/call_1').exitStatus.exitCode, 1);
});
await test('meta: Claude style (terminal_output once, then terminal_exit; interrupted = null code)', () => {
  const s = new T.AcpTerminalStore();
  T.applyTerminalMeta(s, 'th', { terminal_info: { terminal_id: 'toolu_1' } }, { command: 'ls -la', description: 'List' });
  T.applyTerminalMeta(s, 'th', { terminal_output: { terminal_id: 'toolu_1', data: 'a\nb\n' } });
  T.applyTerminalMeta(s, 'th', { claudeCode: { toolName: 'Bash' }, terminal_exit: { terminal_id: 'toolu_1', exit_code: null, signal: null } });
  const snap = s.snapshot('th/toolu_1');
  assert.equal(snap.command, 'ls -la');
  assert.equal(snap.output, 'a\nb\n');
  assert.deepEqual(snap.exitStatus, { exitCode: null, signal: null });
});
await test('meta: output without terminal_info still shows; malformed parts skipped; client terminals untouched', () => {
  const s = new T.AcpTerminalStore();
  assert.deepEqual(T.applyTerminalMeta(s, 'th', { terminal_output_delta: { terminal_id: 'x', data: 'hi' } }), ['th/x']);
  assert.equal(s.snapshot('th/x').output, 'hi');
  assert.deepEqual(T.applyTerminalMeta(s, 'th', { terminal_output_delta: { data: 'no id' }, terminal_exit: 'bad', terminal_info: null }), []);
  assert.deepEqual(T.applyTerminalMeta(s, 'th', null), []);
  assert.deepEqual(T.applyTerminalMeta(s, 'th', { other: 1 }), []);
  s.open('th', 'mine', { source: 'client', command: 'echo' });
  assert.deepEqual(T.applyTerminalMeta(s, 'th', { terminal_output_delta: { terminal_id: 'mine', data: 'spoof' } }), []);
  assert.equal(s.snapshot('th/mine').output, '');
});
await test('commandOfRawInput: string, Codex argv with -lc, plain argv', () => {
  assert.equal(T.commandOfRawInput({ command: 'git status' }), 'git status');
  assert.equal(T.commandOfRawInput({ command: ['/bin/bash', '-lc', 'cargo test && echo ok'] }), 'cargo test && echo ok');
  assert.equal(T.commandOfRawInput({ command: ['rg', '-n', 'foo'] }), 'rg -n foo');
  assert.equal(T.commandOfRawInput({}), undefined);
  assert.equal(T.commandOfRawInput(null), undefined);
});

// ---------------------------------------------------------------- spawn specs per platform
await test('buildSpawn: Unix shell line, Unix argv, Windows cmd line, exe, .cmd shim escaping', () => {
  assert.deepEqual(T.buildSpawn('ls -la | wc -l', [], { platform: 'linux', shell: '/bin/bash' }), { file: '/bin/bash', args: ['-c', 'ls -la | wc -l'], display: 'ls -la | wc -l' });
  const u = T.buildSpawn('git', ['commit', '-m', "it's done"], { platform: 'darwin', shell: '/bin/zsh' });
  assert.deepEqual(u.args, ['commit', '-m', "it's done"]);
  assert.equal(u.file, 'git');
  assert.equal(u.display, `git commit -m 'it'\\''s done'`);
  const w = T.buildSpawn('dir /b', [], { platform: 'win32', shell: '', comspec: 'C:\\Windows\\system32\\cmd.exe' });
  assert.deepEqual(w, { file: 'C:\\Windows\\system32\\cmd.exe', args: ['/d', '/s', '/c', '"dir /b"'], verbatim: true, display: 'dir /b' });
  const exe = T.buildSpawn('git', ['status'], { platform: 'win32', shell: '', resolved: 'C:\\Git\\cmd\\git.exe' });
  assert.deepEqual([exe.file, exe.args, exe.verbatim], ['C:\\Git\\cmd\\git.exe', ['status'], undefined]);
  const shim = T.buildSpawn('npm', ['run', 'a&b'], { platform: 'win32', shell: '', resolved: 'C:\\p\\node_modules\\.bin\\npm.cmd' });
  assert.equal(shim.file, 'cmd.exe');
  assert.equal(shim.verbatim, true);
  assert.equal(shim.args[3], '"C:\\p\\node_modules\\.bin\\npm.cmd ^^^"run^^^" ^^^"a^^^&b^^^""');
  const plain = T.buildSpawn('tool', ['x y'], { platform: 'win32', shell: '', resolved: 'C:\\t\\tool.bat' });
  assert.equal(plain.args[3], '"C:\\t\\tool.bat ^"x^ y^""');
});
await test('posixShell: POSIX-style $SHELL kept, others fall back to bash/sh', () => {
  assert.equal(T.posixShell({ SHELL: '/bin/zsh' }), existsSync('/bin/zsh') ? '/bin/zsh' : existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
  assert.equal(T.posixShell({ SHELL: '/usr/local/bin/fish' }), existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
  assert.equal(T.posixShell({}), existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
});

// ---------------------------------------------------------------- done
mgr.killAll();
rmSync(BASE, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
