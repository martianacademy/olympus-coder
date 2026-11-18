// Unit tests for src/main/agyQuota.ts: CLI log endpoint discovery (`acp-server-*-<pid>.log`), preferredPid ordering,
// dead-PID filtering, empty-groups warmup skip, and fallback to IDE `hub_<port>.json` with CSRF header.
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const Q = await import(`${APP}/src/main/agyQuota.ts`);

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

function listenMock(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      resolve({ srv, port: srv.address().port });
    });
  });
}

const TMP = mkdtempSync(join(tmpdir(), 'olympus-agyquota-unit-'));

await test('findCliEndpoints discovers HTTP port for alive PID, ignores dead PID, and prioritises preferredPid', () => {
  const cliDir = join(TMP, 'cli1');
  mkdirSync(join(cliDir, 'log'), { recursive: true });
  process.env.ANTIGRAVITY_CLI_DATA_DIR = cliDir;

  // Dead PID 99999999 should be skipped; process.pid and process.ppid are alive.
  writeFileSync(join(cliDir, 'log', 'acp-server-20261118_120000-99999999.log'), 'Language server listening on random port at 41111 for HTTP\n');
  writeFileSync(join(cliDir, 'log', `acp-server-20261118_120001-${process.pid}.log`), 'Language server listening on random port at 42222 for HTTP\n');
  if (process.ppid > 1) {
    writeFileSync(join(cliDir, 'log', `acp-server-20261118_120002-${process.ppid}.log`), 'Language server listening on random port at 43333 for HTTP\n');
    const eps = Q.findCliEndpoints(process.pid);
    assert.equal(eps[0].httpPort, 42222, 'preferredPid comes first even when older');
    assert.ok(!eps.some((e) => e.httpPort === 41111), 'dead PID excluded');
  } else {
    const eps = Q.findCliEndpoints(process.pid);
    assert.deepEqual(eps, [{ httpPort: 42222 }]);
  }
});

await test('fetchAgyQuota reads live agy acp HTTP server when Antigravity IDE hub is absent', async () => {
  const cliDir = join(TMP, 'cli2');
  const hubDir = join(TMP, 'hub2');
  mkdirSync(join(cliDir, 'log'), { recursive: true });
  mkdirSync(join(hubDir, 'daemon'), { recursive: true });
  process.env.ANTIGRAVITY_CLI_DATA_DIR = cliDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = hubDir;

  const { srv, port } = await listenMock((req, res) => {
    assert.equal(req.url, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        response: {
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.75, resetTime: '2026-11-18T20:00:00Z' }],
            },
            {
              displayName: 'Claude and GPT models',
              buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0.6, resetTime: '2026-11-18T21:00:00Z' }],
            },
          ],
        },
      }),
    );
  });

  try {
    writeFileSync(join(cliDir, 'log', `acp-server-20261118_214000-${process.pid}.log`), `I1118] Language server listening on random port at ${port} for HTTP\n`);
    const limits = await Q.fetchAgyQuota({ preferredPid: process.pid });
    assert.equal(limits?.length, 2);
    assert.equal(limits[0].label, 'Gemini · 5-hour');
    assert.equal(Math.round(limits[0].utilization * 100), 25);
    assert.equal(limits[1].label, 'Claude & GPT · 5-hour');
    assert.equal(Math.round(limits[1].utilization * 100), 40);
  } finally {
    srv.close();
  }
});

await test('fetchAgyQuota skips warming CLI server (empty groups) and falls back to IDE hub with CSRF token', async () => {
  const cliDir = join(TMP, 'cli3');
  const hubDir = join(TMP, 'hub3');
  mkdirSync(join(cliDir, 'log'), { recursive: true });
  mkdirSync(join(hubDir, 'daemon'), { recursive: true });
  process.env.ANTIGRAVITY_CLI_DATA_DIR = cliDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = hubDir;

  const warming = await listenMock((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ response: {} }));
  });
  let gotCsrf = '';
  const hub = await listenMock((req, res) => {
    gotCsrf = String(req.headers['x-codeium-csrf-token'] ?? '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        response: {
          groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.9 }] }],
        },
      }),
    );
  });

  try {
    writeFileSync(join(cliDir, 'log', `acp-server-20261118_214100-${process.pid}.log`), `Language server listening on random port at ${warming.port} for HTTP\n`);
    writeFileSync(join(hubDir, 'daemon', `hub_${hub.port}.json`), JSON.stringify({ pid: process.pid, httpPort: hub.port, csrfToken: 'secret-csrf-123' }));
    const limits = await Q.fetchAgyQuota({ preferredPid: process.pid });
    assert.equal(gotCsrf, 'secret-csrf-123');
    assert.equal(limits?.length, 1);
    assert.equal(limits[0].label, 'Gemini · weekly');
  } finally {
    warming.srv.close();
    hub.srv.close();
  }
});

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
