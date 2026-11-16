// Unit + live ACP handshake tests for connected CLI providers:
// 1. Node/npx shim (`env.ts`) when host `/opt/homebrew/bin/node` crashes (SIGABRT) or is outdated
// 2. Preservation of `env_var` authMethods through `@agentclientprotocol/sdk` Zod parsing (`agentInitiated.ts` + `acpAuth.ts`)
// 3. CLI terminal login + env-var fallbacks (`effectiveAuthMethods`, `cliLoginArgs`, `acpConfigService.ts`)
// 4. `isAuthError` + `describeError` across JSON-RPC `error.data` shapes (Kilo, Goose, Mistral Vibe, OpenCode)
// 5. Live ACP `initialize` / `session/new` probes against installed `~/.agents/agents/*` binaries when present
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import assert from 'node:assert/strict';

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

const ENV = await import(`${APP}/src/main/env.ts`);
const AI = await import(`${APP}/src/main/agentInitiated.ts`);
const A = await import(`${APP}/src/main/acpAuth.ts`);
const SU = await import(`${APP}/src/main/sessionUpdates.ts`);
const SVC = await import(`${APP}/src/main/acpConfigService.ts`);
const CFG = await import(`${APP}/src/main/acpConfig.ts`);
const SDK = await import(`${APP}/node_modules/@agentclientprotocol/sdk/dist/v1/unstable/acp.js`);

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${String(e?.stack ?? e).split('\n').slice(0, 8).join('\n      ')}`);
  }
}

await test('ensureHealthyNodeShim rescues npx and strips ELECTRON_RUN_AS_NODE for grandchildren', () => {
  const shim = ENV.ensureHealthyNodeShim();
  // Either host node is already >= 20.17 and healthy, or the shim was created and works.
  const env = ENV.agentEnv();
  const ver = execFileSync(shim ?? 'node', ['-p', 'process.versions.node'], { env, encoding: 'utf8' }).trim();
  const [maj, min] = ver.split('.').map(Number);
  assert.ok(maj > 20 || (maj === 20 && min >= 17), `expected healthy node >= 20.17, got ${ver}`);

  if (shim) {
    // Inside the shim, ELECTRON_RUN_AS_NODE must be cleaned from process.env so child Electron apps run normally.
    const flag = execFileSync(shim, ['-p', 'String(process.env.ELECTRON_RUN_AS_NODE)'], { env, encoding: 'utf8' }).trim();
    assert.equal(flag, 'undefined');
  }

  const npxPath = ENV.which('npx');
  if (npxPath) {
    const spec = ENV.spawnable(npxPath, ['--version']);
    const npxVer = execFileSync(spec.command, spec.args, { env, encoding: 'utf8' }).trim();
    assert.match(npxVer, /^\d+\.\d+\.\d+/);
  }
});

await test('preserveUnknownSessionUpdates preserves env_var authMethods through real ACP SDK Zod parser', async () => {
  const c2a = new TransformStream();
  const a2c = new TransformStream();
  const wrappedIncoming = AI.preserveUnknownSessionUpdates(a2c.readable);
  const clientStream = SDK.ndJsonStream(c2a.writable, wrappedIncoming);

  const writer = a2c.writable.getWriter();
  const reader = c2a.readable.getReader();
  const dec = new TextDecoder();
  const enc = new TextEncoder();

  // Mock agent loop reading raw JSON-RPC and replying with an env_var authMethod that SDK Zod normally strips.
  (async () => {
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          const reply = {
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: {},
              agentInfo: { name: 'env-var-agent', version: '1.0.0' },
              authMethods: [
                {
                  id: 'mistral-key',
                  name: 'Mistral API Key',
                  description: 'Enter your Mistral key',
                  type: 'env_var',
                  link: 'https://console.mistral.ai/api-keys',
                  vars: [
                    { name: 'MISTRAL_API_KEY', label: 'API Key', secret: true },
                    { name: 'MISTRAL_BASE_URL', label: 'Endpoint', secret: false, optional: true },
                  ],
                },
              ],
            },
          };
          await writer.write(enc.encode(`${JSON.stringify(reply)}\n`));
        }
      }
    }
  })();

  const conn = SDK.client({ name: 'olympus-test' }).connect(clientStream);
  const init = await conn.agent.request(SDK.methods.agent.initialize, {
    protocolVersion: SDK.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, auth: { terminal: true } },
    clientInfo: { name: 'olympus-coder', version: '0.1.0' },
  });

  // Confirm our `_meta` hook preserved the raw authMethod on `_meta['olympusCoder.rawAuthMethod']` AND `visibleMethods` parses it even if top-level `type`/`vars`/`link` are stripped by Zod!
  assert.ok(init.authMethods[0]._meta?.[AI.ORIGINAL_AUTH_METHOD_META], 'expected rawAuthMethod preserved in _meta');
  const strippedByZod = [{ id: init.authMethods[0].id, name: init.authMethods[0].name, description: init.authMethods[0].description, _meta: init.authMethods[0]._meta }];
  const methods = A.visibleMethods('custom-mistral', strippedByZod);
  assert.equal(methods.length, 1);
  assert.equal(methods[0].flow, 'env-vars');
  assert.equal(methods[0].link, 'https://console.mistral.ai/api-keys');
  assert.deepEqual(methods[0].vars, [
    { name: 'MISTRAL_API_KEY', label: 'API Key', secret: true, optional: false },
    { name: 'MISTRAL_BASE_URL', label: 'Endpoint', secret: false, optional: true },
  ]);
  conn.close?.();
  await writer.close().catch(() => {});
});

await test('effectiveAuthMethods & cliLoginArgs cover Goose, Mistral Vibe, Kilo, OpenCode, Kimi, Gemini, and leave builtins intact', async () => {
  // Built-ins are never polluted with synthetic CLI methods.
  const codexMethods = A.effectiveAuthMethods('codex', [{ id: 'chat-gpt', name: 'ChatGPT' }], { builtin: true, command: '@node' });
  assert.deepEqual(codexMethods.map((m) => m.id), ['chat-gpt']);

  // Goose upgrades `goose-provider` to terminal `goose configure` AND adds env fallback.
  const goose = A.effectiveAuthMethods(
    'goose',
    [{ id: 'goose-provider', name: 'Configure Provider', description: 'Run `goose configure` to set up your AI provider and API key' }],
    { builtin: false, registryId: 'goose', command: '/Users/x/.agents/agents/goose/1.59.0/goose' },
  );
  assert.equal(goose[0].id, 'goose-provider');
  assert.equal(goose[0].flow, 'terminal');
  assert.deepEqual(goose[0].terminalArgs, ['configure']);
  assert.equal(goose[0].replaceAgentArgs, true);
  assert.equal(goose[1].id, '__olympus_env_vars');
  assert.equal(goose[1].flow, 'env-vars');
  assert.equal(goose[1].vars[0].name, 'GOOSE_PROVIDER');

  // Mistral Vibe keeps browser-auth and gains MISTRAL_API_KEY fallback.
  const vibe = A.effectiveAuthMethods(
    'mistral-vibe',
    [{ id: 'browser-auth', name: 'Sign in through Mistral AI Studio' }],
    { builtin: false, registryId: 'mistral-vibe', command: '/Users/x/.agents/agents/mistral-vibe/3.1.1/vibe-acp' },
  );
  assert.deepEqual(vibe.map((m) => `${m.id}:${m.flow}`), ['browser-auth:agent', '__olympus_env_vars:api-key']);
  assert.equal(vibe[1].vars[0].name, 'MISTRAL_API_KEY');
  assert.equal(vibe[1].synthetic, true);

  // Kilo (empty authMethods) gets both `kilo auth login` terminal method and multi-provider env-vars method.
  const kilo = A.effectiveAuthMethods('kilo', [], { builtin: false, registryId: 'kilo', command: '/opt/homebrew/bin/npx' });
  assert.deepEqual(kilo.map((m) => `${m.id}:${m.flow}`), ['__olympus_cli_login:terminal', '__olympus_env_vars:env-vars']);
  assert.deepEqual(A.cliLoginArgs('/opt/homebrew/bin/npx', ['-y', '@kilocode/cli', 'acp'], kilo[0].terminalArgs), ['-y', '@kilocode/cli', 'auth', 'login']);
  assert.deepEqual(A.cliLoginArgs('/Users/x/.agents/agents/opencode/2.3.0/opencode', ['acp'], ['auth', 'login']), ['auth', 'login']);
  assert.deepEqual(A.cliLoginArgs('/opt/homebrew/bin/uvx', ['kimi-cli', 'acp'], ['login']), ['kimi-cli', 'login']);

  // All-optional multi-provider key form requires at least one key.
  assert.deepEqual(A.missingVars(kilo[1], {}), ['at least one API key']);
  assert.deepEqual(A.missingVars(kilo[1], { OPENROUTER_API_KEY: 'sk-or-123' }), []);

  // Synthetic loginWithVars stores encrypted key & restarts agent WITHOUT calling unsupported `authenticate` RPC.
  const secMap = new Map();
  const secrets = { getSecret: (k) => secMap.get(k), setSecret: (k, v) => (v ? secMap.set(k, v) : secMap.delete(k)) };
  let restarted = 0;
  let authRpcCalls = 0;
  let markedReady = false;
  SVC.initAcpConfigService({ secrets, emit: () => {} });
  SVC.setAcpConfigHost({
    connection: async () => ({
      conn: {
        async request(method) {
          if (method === 'authenticate') authRpcCalls++;
          throw Object.assign(new Error('Method not found'), { code: -32601 });
        },
      },
      caps: {},
    }),
    rawAuthMethods: () => [{ id: 'browser-auth', name: 'Sign in through Mistral AI Studio' }],
    restartAgent: async () => void restarted++,
    agentMeta: () => ({ builtin: false, registryId: 'mistral-vibe', command: 'vibe-acp' }),
    savedVarNames: () => [...secMap.keys()].filter((k) => k.startsWith('mistral-vibe:')).map((k) => k.split(':')[1]),
    markAuthenticated: () => {
      markedReady = true;
    },
  });
  const details = await SVC.loginWithVars('mistral-vibe', '__olympus_env_vars', { MISTRAL_API_KEY: 'mk-secret-9999' });
  assert.equal(restarted, 1);
  assert.equal(authRpcCalls, 0);
  assert.equal(markedReady, true);
  assert.deepEqual(details.savedVars, ['MISTRAL_API_KEY']);
  assert.equal(secMap.get('mistral-vibe:MISTRAL_API_KEY'), 'mk-secret-9999');
});

await test('isAuthError & describeError detect JSON-RPC error.data auth failures without false positives', () => {
  const kiloErr = Object.assign(new Error('Internal error'), { code: -32603, data: 'You need to sign in to use this model.' });
  assert.equal(SU.isAuthError(kiloErr), true);
  assert.match(SU.describeError(kiloErr), /You need to sign in to use this model/);

  const gooseErr = Object.assign(new Error('Internal error'), { code: -32603, data: 'Failed to resolve provider and model: Configuration value not found: GOOSE_PROVIDER' });
  assert.equal(SU.isAuthError(gooseErr), true);

  const vibeErr = Object.assign(new Error('Missing API key for mistral provider.'), { code: -32000, data: null });
  assert.equal(SU.isAuthError(vibeErr), true);

  const opencodeErr = Object.assign(new Error('Authentication required'), { code: -32000, data: 'provider authentication required' });
  assert.equal(SU.isAuthError(opencodeErr), true);

  const nonAuthErr = Object.assign(new Error('Internal error'), { code: -32603, data: 'SQLite disk I/O error' });
  assert.equal(SU.isAuthError(nonAuthErr), false);
});

async function probeInstalledBinary(binPath, args) {
  const proc = spawn(binPath, args, { env: ENV.agentEnv(), cwd: APP, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr?.on('data', (d) => {
    stderr += d.toString();
  });
  const incoming = AI.preserveUnknownSessionUpdates(Readable.toWeb(proc.stdout));
  const stream = SDK.ndJsonStream(Writable.toWeb(proc.stdin), incoming);
  const conn = SDK.client({ name: 'olympus-probe' }).connect(stream);
  try {
    const init = await conn.agent.request(SDK.methods.agent.initialize, {
      protocolVersion: SDK.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        auth: { terminal: true },
        subagents: {},
        plan: {},
        session: { notices: {}, compaction: {}, ...CFG.CONFIG_SESSION_CAPS },
        elicitation: { form: {}, url: {} },
      },
      clientInfo: { name: 'olympus-coder', title: 'Olympus Coder', version: '0.1.0' },
    });
    let sessionRes = null;
    let sessionErr = null;
    try {
      sessionRes = await conn.agent.request(SDK.methods.agent.session.new, { cwd: APP, mcpServers: [] });
    } catch (e) {
      sessionErr = e;
    }
    return { init, sessionRes, sessionErr, stderr };
  } catch (e) {
    if (/semctl: Operation not permitted|Standalone server exited/i.test(stderr)) {
      return { skippedBySandbox: true, stderr };
    }
    throw e;
  } finally {
    conn.close?.();
    proc.kill();
  }
}

await test('strict ACP v1 agent rejecting unstable clientCapabilities (-32602) succeeds on baseline retry', async () => {
  const c2a = new TransformStream();
  const a2c = new TransformStream();
  const clientStream = SDK.ndJsonStream(c2a.writable, AI.preserveUnknownSessionUpdates(a2c.readable));
  const writer = a2c.writable.getWriter();
  const reader = c2a.readable.getReader();
  const dec = new TextDecoder();
  const enc = new TextEncoder();

  let initAttempts = 0;
  (async () => {
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          initAttempts++;
          if (msg.params?.clientCapabilities?.subagents || msg.params?.clientCapabilities?.plan) {
            await writer.write(enc.encode(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid params: unknown field `subagents`' } })}\n`));
          } else {
            await writer.write(
              enc.encode(
                `${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'strict-v1', version: '1.0' }, authMethods: [] } })}\n`,
              ),
            );
          }
        }
      }
    }
  })();

  const conn = SDK.client({ name: 'olympus-strict-test' }).connect(clientStream);
  const baseCaps = { fs: { readTextFile: true, writeTextFile: true }, terminal: true, auth: { terminal: true } };
  const fullCaps = { ...baseCaps, subagents: {}, plan: {} };
  let init;
  try {
    init = await conn.agent.request(SDK.methods.agent.initialize, { protocolVersion: SDK.PROTOCOL_VERSION, clientCapabilities: fullCaps, clientInfo: { name: 'olympus', version: '1' } });
  } catch (e) {
    assert.equal(e.code, -32602);
    init = await conn.agent.request(SDK.methods.agent.initialize, { protocolVersion: SDK.PROTOCOL_VERSION, clientCapabilities: baseCaps, clientInfo: { name: 'olympus', version: '1' } });
  }
  assert.equal(initAttempts, 2);
  assert.equal(init.agentInfo.name, 'strict-v1');
  conn.close?.();
  await writer.close().catch(() => {});
});

const agentsRoot = join(homedir(), '.agents', 'agents');

const gooseBin = join(agentsRoot, 'goose', '1.59.0', 'goose');
if (existsSync(gooseBin)) {
  await test('live ACP probe: installed Goose 1.59.0 initializes and reports needs-login with terminal configure flow', async () => {
    const r = await probeInstalledBinary(gooseBin, ['acp']);
    if (r.skippedBySandbox) return;
    const methods = A.effectiveAuthMethods('goose', r.init.authMethods, { builtin: false, registryId: 'goose', command: gooseBin });
    assert.equal(methods[0].flow, 'terminal');
    assert.deepEqual(methods[0].terminalArgs, ['configure']);
    if (r.sessionErr) {
      assert.equal(SU.isAuthError(r.sessionErr), true);
      assert.match(SU.describeError(r.sessionErr), /GOOSE_PROVIDER|provider/i);
    }
  });
}

const vibeBin = join(agentsRoot, 'mistral-vibe', '3.1.1', 'vibe-acp');
if (existsSync(vibeBin)) {
  await test('live ACP probe: installed Mistral Vibe 3.1.1 accepts full clientCapabilities and exposes MISTRAL_API_KEY login', async () => {
    const r = await probeInstalledBinary(vibeBin, []);
    if (r.skippedBySandbox) return;
    const methods = A.effectiveAuthMethods('mistral-vibe', r.init.authMethods, { builtin: false, registryId: 'mistral-vibe', command: vibeBin });
    assert.ok(methods.some((m) => m.flow === 'api-key' && m.vars[0]?.name === 'MISTRAL_API_KEY'));
    if (r.sessionErr) {
      assert.equal(SU.isAuthError(r.sessionErr), true);
      assert.match(SU.describeError(r.sessionErr), /Missing API key/i);
    }
  });
}

const kimiBin = join(agentsRoot, 'kimi', '1.52.0', 'kimi');
if (existsSync(kimiBin)) {
  await test('live ACP probe: installed Kimi 1.52.0 initializes and exposes terminal + API key fallbacks', async () => {
    const r = await probeInstalledBinary(kimiBin, ['acp']);
    if (r.skippedBySandbox) return;
    assert.ok(r.init.agentInfo);
    const methods = A.effectiveAuthMethods('kimi', r.init.authMethods, { builtin: false, registryId: 'kimi', command: kimiBin });
    assert.ok(methods.some((m) => m.flow === 'terminal'));
    assert.ok(methods.some((m) => m.flow === 'api-key' || m.flow === 'env-vars'));
    if (r.sessionErr) {
      assert.equal(SU.isAuthError(r.sessionErr), true);
    }
  });
}

const opencodeV2Bin = join(agentsRoot, 'opencode-v2', '2.3.0', 'opencode');
if (existsSync(opencodeV2Bin)) {
  await test('live ACP probe: installed OpenCode v2 2.3.0 initializes and creates a live session cleanly', async () => {
    const r = await probeInstalledBinary(opencodeV2Bin, ['acp']);
    if (r.skippedBySandbox) return;
    assert.ok(r.init.agentInfo);
    if (r.sessionErr) {
      assert.equal(SU.isAuthError(r.sessionErr), true);
    } else {
      assert.ok(r.sessionRes?.sessionId, 'expected a valid sessionId from opencode-v2');
    }
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
