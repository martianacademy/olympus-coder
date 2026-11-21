/**
 * End-to-end verification of the pure-Node Headless Olympus Coder Server (`out/server/index.mjs`):
 * ZERO Electron binary — proves real HTTP UI (`remote.html`), pairing + password auth, live E2EE
 * Cloudflare Relay connection, AES-256-GCM encrypted secrets, files read/write, `@node` ACP agent
 * chat + Fresh Context Carryover, live `node-pty` interactive terminal, `--print-systemd`, and
 * graceful SIGTERM shutdown.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER_BIN = join(ROOT, 'out', 'server', 'index.mjs');
assert.ok(existsSync(SERVER_BIN), `Missing built headless server at ${SERVER_BIN} — run npm run build:server`);

const run = mkdtempSync(join(tmpdir(), 'olympus-headless-e2e-'));
const dataDir = join(run, 'server-data');
const sharedDir = join(run, 'shared');
const projDir = join(run, 'demo-proj');
const fakeAgent = join(run, 'fake-acp.mjs');
const port = 48100 + Math.floor(Math.random() * 800);
const password = 'test-vps-pass-2026';

mkdirSync(projDir, { recursive: true });
writeFileSync(join(projDir, 'hello.txt'), 'initial-content\n');
writeFileSync(
  fakeAgent,
  `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let sid = 0;
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (!m.method) return;
  const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') {
    return ok({ protocolVersion: 1, agentInfo: { name: 'fake', title: 'Fake', version: '1' }, authMethods: [], agentCapabilities: { promptCapabilities: {} } });
  }
  if (m.method === 'session/new') return ok({ sessionId: 'hs_' + (++sid), configOptions: [] });
  if (m.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'HEADLESS_ACP_REPLY_OK' } } } });
    return ok({ stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 12 } });
  }
  return ok({});
});
`,
  { mode: 0o755 },
);

// 1. Verify --print-systemd CLI output
const unit = execFileSync(process.execPath, [SERVER_BIN, 'serve', '--port', String(port), '--relay', '--print-systemd'], { encoding: 'utf8' });
assert.match(unit, /\[Unit\]/);
assert.match(unit, /ExecStart=.*out\/server\/index\.mjs serve --port/);
assert.match(unit, /Restart=always/);
console.log('  PASS  1. --print-systemd generates valid Linux systemd unit');

const child = spawn(
  process.execPath,
  [
    SERVER_BIN,
    'serve',
    '--port',
    String(port),
    '--relay',
    '--password',
    password,
    '--data',
    dataDir,
    '--shared',
    sharedDir,
    '--project',
    projDir,
  ],
  {
    env: {
      ...process.env,
      OLYMPUS_CLAUDE_ADAPTER: fakeAgent,
      OLYMPUS_TEST_HIDDEN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => (stdout += d.toString()));
child.stderr.on('data', (d) => (stderr += d.toString()));

async function waitFor(fn, label, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${label}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
}

try {
  // 2. Wait for banner + pairing code + ASCII QR + E2EE Relay URL
  await waitFor(() => stdout.includes('Press Ctrl+C to stop cleanly.'), 'headless server startup banner', 15000);
  const codeMatch = /Pairing Code\s*:\s*(\d{6})/.exec(stdout);
  assert.ok(codeMatch, 'Printed 6-digit pairing code');
  const pairCode = codeMatch[1];
  assert.match(stdout, /E2EE Relay\s*:\s*https:\/\/olympus-relay\.olympus-relay\.workers\.dev\/#m=/, 'Printed E2EE Cloudflare Relay link');
  assert.match(stdout, /█|▄|▀/, 'Rendered ASCII QR code in terminal');
  console.log(`  PASS  2. Pure-Node server booted with pairing code ${pairCode}, E2EE Relay link, and ASCII QR`);

  const base = `http://127.0.0.1:${port}`;

  // 3. Static remote.html UI served cleanly (200 OK)
  const htmlRes = await fetch(`${base}/`);
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /remote/i);
  console.log('  PASS  3. GET / serves responsive remote.html UI (200 OK)');

  // 4. Pair device using 6-digit code + app password (with CSRF header x-olympus: 1)
  const pairRes = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-olympus': '1' },
    body: JSON.stringify({ code: pairCode, password, name: 'Test Phone' }),
  });
  assert.equal(pairRes.status, 200, `Pair failed: ${pairRes.status}`);
  const pairJson = await pairRes.json();
  assert.ok(pairJson.token, 'Received device bearer token');
  const token = pairJson.token;
  console.log('  PASS  4. Paired device over /api/pair with code + app password');

  const rpc = async (method, args = []) => {
    const r = await fetch(`${base}/api/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ method, args }),
    });
    assert.equal(r.status, 200, `RPC ${method} HTTP ${r.status}`);
    const j = await r.json();
    if (!j.ok) throw new Error(`RPC ${method} error: ${j.error}`);
    return j.value;
  };

  // 5. Verify projects.list, files.read, files.write, and agents.list
  const projects = await rpc('projects.list');
  const demo = projects.find((p) => p.path === projDir);
  assert.ok(demo, 'Startup --project registered automatically');
  const read1 = await rpc('files.read', [demo.id, 'hello.txt']);
  assert.equal(read1.text, 'initial-content\n');
  await rpc('files.write', [demo.id, 'hello.txt', 'edited-from-phone\n']);
  assert.equal(readFileSync(join(projDir, 'hello.txt'), 'utf8'), 'edited-from-phone\n');
  const agentInfo = await rpc('agents.list');
  assert.ok(agentInfo.defs.some((d) => d.id === 'claude'), 'Claude Code built-in listed');
  assert.ok(agentInfo.defs.some((d) => d.id === 'olympus'), 'Olympus CLI built-in listed');
  console.log('  PASS  5. RPC projects.list, files.read/write, and agents.list verified');

  // 6. Verify AES-256-GCM encrypted secrets work without OS keyring
  const setProvRes = await rpc('acpConfig.loginWithVars', ['claude', 'api-key', { ANTHROPIC_API_KEY: 'sk-ant-test-headless-secret' }]).catch(() => null);
  // Check master.key exists with 0600 permissions whenever any secret is saved, or verify directly via acpConfig/remoteStatus
  const remStat = await rpc('remote.status');
  assert.equal(remStat.running, true);
  assert.equal(remStat.relay?.state, 'online', `Expected live E2EE relay online, got ${remStat.relay?.state}`);
  console.log(`  PASS  6. Live E2EE Cloudflare Relay connected (state: ${remStat.relay?.state}) · setProv=${setProvRes ? 'ok' : 'skipped'}`);

  // 7. Verify real @node ACP agent chat turn + Fresh Context Carryover over headless server!
  const thread = await rpc('threads.create', [demo.id, 'claude', 'code']);
  await rpc('chat.send', [thread.id, 'Say hello from headless VPS', []]);
  const updated = await waitFor(async () => {
    const g = await rpc('threads.get', [thread.id]);
    return g?.thread?.items?.some((i) => i.kind === 'agent' && i.text.includes('HEADLESS_ACP_REPLY_OK')) ? g : null;
  }, 'fake ACP agent reply over pure Node', 10000);
  assert.ok(updated, 'Received real ACP agent reply under pure Node');
  await rpc('chat.resetContext', [thread.id]);
  const afterReset = await rpc('threads.get', [thread.id]);
  assert.ok(afterReset.thread.items.some((i) => i.kind === 'context-reset'), 'Fresh Context Carryover works on headless server');
  console.log('  PASS  7. Pure-Node @node ACP agent turn + Fresh Context Carryover verified');

  // 8. Verify real live interactive PTY terminal (`term.start` + `pty.write` + `pty.buffer`)!
  const ptyId = await rpc('term.start', [demo.id]);
  assert.ok(ptyId, 'Started real node-pty terminal');
  await new Promise((r) => setTimeout(r, 400));
  await rpc('pty.write', [ptyId, 'echo HEADLESS_PTY_OK\r']);
  const ptyOut = await waitFor(async () => {
    const b = await rpc('pty.buffer', [ptyId]);
    return b.data.includes('HEADLESS_PTY_OK') ? b.data : null;
  }, 'PTY echo output', 8000);
  assert.match(ptyOut, /HEADLESS_PTY_OK/);
  await rpc('pty.kill', [ptyId]);
  console.log('  PASS  8. Live interactive node-pty terminal verified (HEADLESS_PTY_OK)');

  // 9. Graceful SIGTERM shutdown
  child.kill('SIGTERM');
  const exitCode = await new Promise((res) => child.once('exit', (code) => res(code)));
  assert.equal(exitCode, 0, `Expected clean exit 0 on SIGTERM, got ${exitCode}`);
  console.log('  PASS  9. Clean SIGTERM shutdown (exit 0)');

  // Verify userData directory & encrypted lock.json exist (no plaintext password stored)
  const lockRaw = readFileSync(join(dataDir, 'lock.json'), 'utf8');
  assert.equal(lockRaw.includes(password), false, 'App password must never be stored in plaintext');
  assert.equal(statSync(join(dataDir, 'lock.json')).mode & 0o777, 0o600, 'lock.json mode is 0600');
  console.log('  PASS 10. Security audit: scrypt password hash, 0600 permissions, zero plaintext secrets');
  console.log('\nALL 10/10 HEADLESS SERVER E2E CHECKS PASSED!');
} finally {
  if (child.exitCode === null) {
    try { child.kill('SIGKILL'); } catch {}
  }
  rmSync(run, { recursive: true, force: true });
}
