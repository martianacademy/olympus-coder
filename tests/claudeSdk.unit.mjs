// Claude Agent SDK on demand (src/main/claudeSdk.ts): installers ship without Anthropic's proprietary SDK; the app
// downloads the exact version, checks sha512, unpacks it, and boots the open-source adapter against it.
// Run: node tests/claudeSdk.unit.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
});

const APP = new URL('..', import.meta.url).pathname;
const S = await import(pathToFileURL(join(APP, 'src/main/claudeSdk.ts')).href);
const TMP = mkdtempSync(join(tmpdir(), 'claude-sdk-unit-'));
const REAL_SDK = join(APP, 'node_modules/@anthropic-ai/claude-agent-sdk');
const REAL_ADAPTER = join(APP, 'node_modules/@agentclientprotocol/claude-agent-acp');
const VERSION = JSON.parse(readFileSync(join(REAL_ADAPTER, 'package.json'), 'utf8')).dependencies['@anthropic-ai/claude-agent-sdk'];

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL  ${name}\n      ${String(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

/** One raw ustar header block (for archives `tar` refuses to make, e.g. with `..`). */
function header(name, size, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.fill(' ', 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
const rawTar = (entries) => gzipSync(Buffer.concat([...entries.flatMap(([n, body, t]) => [header(n, body.length, t), pad(body)]), Buffer.alloc(1024)]));

/** A gzipped npm-style tarball (`package/…`) of `dir`, made with the system tar (pax long names, symlinks kept). */
function packDir(dir) {
  const stage = mkdtempSync(join(TMP, 'pack-'));
  cpSync(dir, join(stage, 'package'), { recursive: true, verbatimSymlinks: true });
  const out = join(stage, 'pkg.tgz');
  execFileSync('tar', ['-czf', out, '-C', stage, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } }); // no macOS ._ files
  return readFileSync(out);
}

await test('extractTarGz: files + long (>100 char) paths unpack under the strip prefix; symlinks are never created', () => {
  const src = mkdtempSync(join(TMP, 'src-'));
  const long = join('a'.repeat(60), 'b'.repeat(60), 'deep.mjs');
  mkdirSync(join(src, 'a'.repeat(60), 'b'.repeat(60)), { recursive: true });
  writeFileSync(join(src, long), 'export const deep = 1;\n');
  writeFileSync(join(src, 'package.json'), '{"name":"x","version":"1.0.0"}');
  symlinkSync('/etc/hosts', join(src, 'link-out'));
  const dest = join(TMP, 'x1');
  const n = S.extractTarGz(packDir(src), dest, 'package/');
  assert.equal(n, 2, 'two regular files');
  assert.equal(readFileSync(join(dest, long), 'utf8'), 'export const deep = 1;\n');
  assert.equal(existsSync(join(dest, 'link-out')), false, 'symlink not created');
});

await test('extractTarGz: rejects `..` and absolute entries (path traversal)', () => {
  assert.throws(() => S.extractTarGz(rawTar([['package/../../evil.txt', Buffer.from('x')]]), join(TMP, 'x2'), 'package/'), /Unsafe path/);
  assert.equal(existsSync(join(TMP, 'evil.txt')), false);
  assert.throws(() => S.extractTarGz(rawTar([['/abs/evil.txt', Buffer.from('x')]]), join(TMP, 'x3')), /Unsafe path/);
});

// A local "npm registry" serving the real SDK tarball, so the download path runs end to end without the network.
const sdkTgz = packDir(REAL_SDK);
const good = `sha512-${createHash('sha512').update(sdkTgz).digest('base64')}`;
let integrity = good;
let hits = 0;
const server = createServer((req, res) => {
  hits++;
  if (req.url === `/@anthropic-ai/claude-agent-sdk/${VERSION}`) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ dist: { tarball: `http://127.0.0.1:${server.address().port}/sdk.tgz`, integrity } }));
  }
  if (req.url === '/sdk.tgz') return res.end(sdkTgz);
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const registry = `http://127.0.0.1:${server.address().port}`;

// An "installed app" with the open-source adapter only (no @anthropic-ai/claude-agent-sdk), like a packaged build.
const appPath = join(TMP, 'app');
cpSync(REAL_ADAPTER, join(appPath, 'node_modules/@agentclientprotocol/claude-agent-acp'), { recursive: true });

await test('packaged layout: SDK not bundled, version read from the adapter (exact pin)', () => {
  assert.equal(S.sdkBundled(appPath), false);
  assert.equal(S.sdkBundled(APP), true, 'dev checkout still has it');
  assert.equal(S.sdkVersionFor(appPath), VERSION);
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

await test('tampered download (integrity mismatch) is rejected and leaves nothing usable behind', async () => {
  const ud = join(TMP, 'ud-bad');
  integrity = `sha512-${createHash('sha512').update('not the sdk').digest('base64')}`;
  await assert.rejects(() => S.ensureClaudeSdk({ appPath, userData: ud, registry }), /integrity check/);
  assert.equal(S.sdkReady(ud, VERSION), false);
  const vendor = join(ud, 'vendor', 'claude-agent-sdk');
  assert.ok(!existsSync(vendor) || readdirSync(vendor).every((n) => !n.includes('.tmp-')), 'no temp folders left');
  integrity = good;
});

const ud = join(TMP, 'ud');
let root;
await test('download → sha512 verified → unpacked → ready; concurrent + later calls reuse it (one download)', async () => {
  hits = 0;
  const progress = [];
  const [a, b] = await Promise.all([
    S.ensureClaudeSdk({ appPath, userData: ud, registry, onProgress: (d) => progress.push(d) }),
    S.ensureClaudeSdk({ appPath, userData: ud, registry }),
  ]);
  root = a;
  assert.equal(a, b);
  assert.equal(hits, 2, 'metadata + tarball fetched once');
  assert.equal(S.sdkReady(ud, VERSION), true);
  const pkg = JSON.parse(readFileSync(join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8'));
  assert.equal(pkg.version, VERSION);
  assert.ok(existsSync(join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')));
  assert.ok(progress.some((p) => p.includes('Downloading')));
  await S.ensureClaudeSdk({ appPath, userData: ud, registry });
  assert.equal(hits, 2, 'already ready: no new request');
});

const electron = (() => {
  try {
    const p = join(APP, 'node_modules/electron/dist', readFileSync(join(APP, 'node_modules/electron/path.txt'), 'utf8').trim());
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
})();
const runtime = electron ?? process.execPath; // production runs the adapter with Electron's own Node
const runEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

await test('boot script: an adapter outside any node_modules imports the SDK from the downloaded copy; argv restored', () => {
  const boot = S.ensureBootScript(ud);
  assert.equal(S.ensureBootScript(ud), boot, 'idempotent');
  const dir = mkdtempSync(join(TMP, 'fake-adapter-'));
  const fake = join(dir, 'index.js');
  writeFileSync(
    fake,
    `import * as sdk from '@anthropic-ai/claude-agent-sdk';
     console.log(JSON.stringify({ query: typeof sdk.query, resolved: import.meta.resolve('@anthropic-ai/claude-agent-sdk'), argv: process.argv.slice(1) }));`,
  );
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const out = JSON.parse(execFileSync(runtime, [boot, root, fake, '--flag', 'x'], { env: runEnv, encoding: 'utf8' }).trim().split('\n').pop());
  assert.equal(out.query, 'function');
  assert.ok(out.resolved.startsWith(pathToFileURL(realpathSync(root)).href), `resolved inside the downloaded root: ${out.resolved}`);
  assert.deepEqual(out.argv, [fake, '--flag', 'x']);
});

await test('boot script without a downloaded SDK exits with a clear message', () => {
  const boot = S.ensureBootScript(ud);
  let err = '';
  try {
    execFileSync(runtime, [boot, join(TMP, 'nope'), join(TMP, 'nope.js')], { env: runEnv, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    err = String(e.stderr);
  }
  assert.match(err, /not downloaded yet/);
});

await test('real claude-agent-acp (from the SDK-less app) answers ACP initialize through the boot script', async () => {
  const boot = S.ensureBootScript(ud);
  const adapter = join(appPath, 'node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js');
  // The SDK-less app tree has no other deps: give the adapter its open-source deps the way a packaged app has them.
  for (const dep of ['@agentclientprotocol/sdk', 'diff', 'zod', '@anthropic-ai/sdk', '@modelcontextprotocol/sdk']) {
    const from = join(APP, 'node_modules', dep);
    if (existsSync(from)) cpSync(from, join(appPath, 'node_modules', dep), { recursive: true, dereference: true });
  }
  assert.equal(existsSync(join(appPath, 'node_modules/@anthropic-ai/claude-agent-sdk')), false, 'still no bundled SDK');
  const child = spawn(runtime, [boot, root, adapter], { env: { ...runEnv, CLAUDE_CODE_EXECUTABLE: '/nonexistent/claude' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }) + '\n');
  const t0 = Date.now();
  while (!out.includes('"id":1') && Date.now() - t0 < 30_000 && child.exitCode === null) await new Promise((r) => setTimeout(r, 100));
  child.kill();
  const line = out.split('\n').find((l) => l.includes('"id":1'));
  assert.ok(line, `no initialize response. stderr: ${err.slice(0, 400)}`);
  const msg = JSON.parse(line);
  assert.ok(msg.result?.protocolVersion, `initialize result: ${line.slice(0, 200)}`);
});

server.close();
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed${electron ? ' (runtime: Electron as Node)' : ''}`);
process.exit(failures.length ? 1 : 0);
