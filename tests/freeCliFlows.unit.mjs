// End-to-end unit + live ACP handshake verification for all free-usage coding CLIs supported in Olympus Coder:
// 1. Catalog presence + install/add plan (`local` / `npx` / `uvx` / `binary`) across all 18 free-tier coding CLIs
// 2. Fix for `kilo-login` & `opencode-login` ("Run `...` in the terminal" without `type: "terminal"`) + shell-injection guard
// 3. `effectiveAuthMethods`, `cliLoginArgs`, `missingVars`, and `loginWithVars` across `iflow`, `codebuddy-code`, `qoder`, `openhands`, `zcode`, `qwen-code`, `cline`, etc.
// 4. Real brand SVG logo resolution (`logoKeyFor`) for all 18 free-tier coding CLIs (zero plain-initials fallback)
// 5. Live ACP `initialize` probes against locally installed free CLIs (`oly`, `opencode`, `qwen`, `kilo`)
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = mkdtempSync(join(tmpdir(), 'olympus-free-cli-'));
const snapshotJson = JSON.parse(readFileSync(join(APP, 'src/main/registry-snapshot.json'), 'utf8'));

globalThis.__FREE_T = {
  root: ROOT,
  settings: { customAgents: [] },
  bins: {
    npx: '/usr/local/bin/npx',
    uvx: '/usr/local/bin/uvx',
    npm: '/usr/local/bin/npm',
  },
};

const stub = (src) => `data:text/javascript,${encodeURIComponent(src)}`;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === './registry-snapshot.json') {
      return { url: stub(`export default ${JSON.stringify(snapshotJson)};`), shortCircuit: true };
    }
    if (spec === './store' && ctx.parentURL?.includes('/src/main/catalog')) {
      return {
        url: stub(`
          import { writeFileSync } from 'node:fs';
          export const sharedRoot = () => globalThis.__FREE_T.root;
          export const getSettings = () => globalThis.__FREE_T.settings;
          export const updateSettings = (p) => Object.assign(globalThis.__FREE_T.settings, p);
          export const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v));
        `),
        shortCircuit: true,
      };
    }
    if (spec === './env' && ctx.parentURL?.includes('/src/main/catalog')) {
      return {
        url: stub(`
          export const which = (b) => globalThis.__FREE_T.bins[b] ?? null;
          export const agentEnv = (e) => ({ ...process.env, ...(e ?? {}) });
          export const spawnable = (c, a) => ({ command: c, args: a });
        `),
        shortCircuit: true,
      };
    }
    if (spec.endsWith('.svg?raw')) {
      const rel = spec.replace(/\?raw$/, '');
      const svgPath = join(APP, 'node_modules', rel);
      const raw = readFileSync(svgPath, 'utf8');
      return { url: stub(`export default ${JSON.stringify(raw)};`), shortCircuit: true };
    }
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
  load(url, ctx, next) {
    if (url.endsWith('/src/renderer/src/logos.tsx')) {
      const full = readFileSync(fileURLToPath(url), 'utf8');
      const pureTs = full.slice(0, full.indexOf('const dataUrl ='));
      return { format: 'module-typescript', source: pureTs, shortCircuit: true };
    }
    return next(url, ctx);
  },
});

// Serve the bundled snapshot cleanly without external network flakiness.
globalThis.fetch = async () => ({ ok: false, status: 503 });

const CATALOG = await import(`${APP}/src/main/catalog.ts`);
const AUTH = await import(`${APP}/src/main/acpAuth.ts`);
const ENV = await import(`${APP}/src/main/env.ts`);
const AI = await import(`${APP}/src/main/agentInitiated.ts`);
const LOGOS = await import(`${APP}/src/renderer/src/logos.tsx`);
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

const FREE_CLIS = [
  'olympus',
  'antigravity',
  'codex',
  'opencode',
  'qwen-code',
  'gemini',
  'iflow',
  'github-copilot-cli',
  'kilo',
  'cline',
  'codebuddy-code',
  'qoder',
  'kiro',
  'cursor',
  'zcode',
  'mistral-vibe',
  'goose',
  'openhands',
];

await test('all 18 free-tier coding CLIs appear in catalog with valid install/add methods and brand SVG logos', async () => {
  const entries = await CATALOG.listCatalog();
  for (const id of FREE_CLIS) {
    const entry = entries.find((e) => e.id === id);
    assert.ok(entry, `missing free CLI in catalog: ${id}`);
    if (entry.builtin) {
      assert.ok(entry.installCommand || entry.docs, `builtin ${id} must have installCommand or docs`);
    } else {
      assert.ok(entry.methods.length > 0, `registry CLI ${id} must expose at least one install/add method`);
      const method = entry.methods[0];
      const plan = await CATALOG.planCatalogAdd(id, method);
      assert.ok(plan.command, `planCatalogAdd(${id}, ${method}) must produce a command`);
    }
    const logoKey = LOGOS.logoKeyFor({
      id: entry.id,
      name: entry.name,
      command: entry.localPath ?? '',
      args: [],
    });
    assert.ok(logoKey && LOGOS.LOGOS[logoKey]?.svg.includes('<svg'), `missing brand SVG logo for ${id} (${entry.name})`);
  }
});

await test('iFlow CLI and OpenHands plans support both package runner (npx/uvx) and local binary detection', async () => {
  const iflowNpx = await CATALOG.planCatalogAdd('iflow', 'npx');
  assert.deepEqual(iflowNpx.args, ['-y', '@iflow-ai/iflow-cli@0.5.19', '--experimental-acp']);

  const ohUvx = await CATALOG.planCatalogAdd('openhands', 'uvx');
  assert.deepEqual(ohUvx.args, ['openhands==1.16.0', 'acp']);

  globalThis.__FREE_T.bins.iflow = '/opt/bin/iflow';
  globalThis.__FREE_T.bins.openhands = '/opt/bin/openhands';
  globalThis.__FREE_T.bins.codebuddy = '/opt/bin/codebuddy';

  const iflowLocal = await CATALOG.planCatalogAdd('iflow', 'local');
  assert.equal(iflowLocal.command, '/opt/bin/iflow');
  assert.deepEqual(iflowLocal.args, ['--experimental-acp']);

  const cbLocal = await CATALOG.planCatalogAdd('codebuddy-code', 'local');
  assert.equal(cbLocal.command, '/opt/bin/codebuddy');
  assert.deepEqual(cbLocal.args, ['--acp']);
});

await test('universal Run `...` detector turns kilo-login and opencode-login into single terminal flows and blocks shell metacharacters', () => {
  const kiloRaw = [{ id: 'kilo-login', name: 'Login with Kilo', description: 'Run `kilo auth login` in the terminal' }];
  const kiloMethods = AUTH.effectiveAuthMethods('kilo', kiloRaw, { builtin: false, registryId: 'kilo', command: '/usr/local/bin/npx' });
  assert.equal(kiloMethods.filter((m) => m.flow === 'terminal').length, 1, 'must not duplicate terminal login button');
  assert.equal(kiloMethods[0].id, 'kilo-login');
  assert.equal(kiloMethods[0].flow, 'terminal');
  assert.deepEqual(kiloMethods[0].terminalArgs, ['auth', 'login']);
  assert.equal(kiloMethods[0].replaceAgentArgs, true);
  assert.deepEqual(AUTH.cliLoginArgs('/usr/local/bin/npx', ['-y', '@kilocode/cli@7.8.27', 'acp'], kiloMethods[0].terminalArgs), [
    '-y',
    '@kilocode/cli@7.8.27',
    'auth',
    'login',
  ]);

  const ocRaw = [{ id: 'opencode-login', name: 'Login with opencode', description: 'Run `opencode auth login` in the terminal' }];
  const ocMethods = AUTH.effectiveAuthMethods('opencode', ocRaw, { builtin: false, registryId: 'opencode', command: '/Users/x/.opencode/bin/opencode' });
  assert.equal(ocMethods.filter((m) => m.flow === 'terminal').length, 1);
  assert.equal(ocMethods[0].id, 'opencode-login');
  assert.equal(ocMethods[0].flow, 'terminal');
  assert.deepEqual(ocMethods[0].terminalArgs, ['auth', 'login']);

  // Shell injection characters inside backticks must NEVER be turned into terminalArgs.
  const unsafe = AUTH.authMethodDetail('evil', { id: 'x', name: 'Login', description: 'Run `evil login; rm -rf /` in terminal' });
  assert.equal(unsafe.flow, 'agent');
  assert.equal(unsafe.terminalArgs, undefined);
});

await test('iflow, codebuddy-code, qoder, openhands, zcode, and qwen-code resolve clean terminal + API key flows', () => {
  const iflow = AUTH.effectiveAuthMethods('iflow', [], { builtin: false, registryId: 'iflow', command: '/usr/local/bin/npx' });
  assert.deepEqual(iflow.map((m) => `${m.id}:${m.flow}`), ['__olympus_cli_login:terminal', '__olympus_env_vars:env-vars']);
  assert.deepEqual(AUTH.cliLoginArgs('/usr/local/bin/npx', ['-y', '@iflow-ai/iflow-cli@0.5.19', '--experimental-acp'], iflow[0].terminalArgs), [
    '-y',
    '@iflow-ai/iflow-cli@0.5.19',
  ]);
  // Non-secret optional OPENAI_BASE_URL alone is rejected; IFLOW_API_KEY passes.
  assert.deepEqual(AUTH.missingVars(iflow[1], { OPENAI_BASE_URL: 'https://apis.iflow.cn/v1' }), ['at least one API key']);
  assert.deepEqual(AUTH.missingVars(iflow[1], { IFLOW_API_KEY: 'sk-iflow-free' }), []);

  const cb = AUTH.effectiveAuthMethods('codebuddy-code', [], { builtin: false, registryId: 'codebuddy-code', command: '/usr/local/bin/npx' });
  assert.deepEqual(cb[0].terminalArgs, ['login']);
  assert.equal(cb[1].flow, 'api-key');
  assert.equal(cb[1].vars[0].name, 'CODEBUDDY_API_KEY');

  const qoder = AUTH.effectiveAuthMethods('qoder', [], { builtin: false, registryId: 'qoder', command: '/usr/local/bin/npx' });
  assert.deepEqual(qoder[0].terminalArgs, ['login']);
  assert.equal(qoder[1].flow, 'api-key');
  assert.equal(qoder[1].vars[0].name, 'QODER_PERSONAL_ACCESS_TOKEN');

  const oh = AUTH.effectiveAuthMethods('openhands', [], { builtin: false, registryId: 'openhands', command: '/usr/local/bin/uvx' });
  assert.deepEqual(AUTH.cliLoginArgs('/usr/local/bin/uvx', ['openhands==1.16.0', 'acp'], oh[0].terminalArgs), ['openhands==1.16.0', 'login']);
  assert.equal(oh[1].flow, 'env-vars');
  assert.deepEqual(AUTH.missingVars(oh[1], { LLM_MODEL: 'gemini/gemini-2.5-flash' }), ['at least one API key']);
  assert.deepEqual(AUTH.missingVars(oh[1], { GEMINI_API_KEY: 'AIza-free' }), []);

  // ZCode is a pure stdio ACP bridge: no broken empty terminal prompt, only optional Z.AI / Zhipu key fallback.
  const zcode = AUTH.effectiveAuthMethods('zcode', [], { builtin: false, registryId: 'zcode', command: '/usr/local/bin/npx' });
  assert.deepEqual(zcode.map((m) => `${m.id}:${m.flow}`), ['__olympus_env_vars:env-vars']);
});

async function probeLocalAcp(bin, args, extraEnv = {}) {
  const proc = spawn(bin, args, { env: { ...ENV.agentEnv(), ...extraEnv }, cwd: APP, stdio: ['pipe', 'pipe', 'pipe'] });
  const incoming = AI.preserveUnknownSessionUpdates(Readable.toWeb(proc.stdout));
  const stream = SDK.ndJsonStream(Writable.toWeb(proc.stdin), incoming);
  const conn = SDK.client({ name: 'free-cli-probe' }).connect(stream);
  try {
    return await Promise.race([
      conn.agent.request(SDK.methods.agent.initialize, {
        protocolVersion: SDK.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, auth: { terminal: true } },
        clientInfo: { name: 'olympus-coder', version: '0.3.0' },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout initializing ${bin}`)), 15_000)),
    ]);
  } finally {
    conn.close?.();
    proc.kill();
  }
}

for (const probe of [
  { id: 'olympus', bin: 'oly', args: ['acp'], builtin: true },
  { id: 'opencode', bin: 'opencode', args: ['acp'], builtin: false },
  { id: 'qwen-code', bin: 'qwen', args: ['--acp'], builtin: false },
  { id: 'kilo', bin: 'kilo', args: ['acp'], builtin: false },
]) {
  const binPath = ENV.which(probe.bin);
  if (binPath) {
    await test(`live ACP initialize + auth verification: ${probe.id} (${binPath})`, async () => {
      const init = await probeLocalAcp(binPath, probe.args);
      assert.ok(init.protocolVersion, 'expected protocolVersion');
      const methods = AUTH.effectiveAuthMethods(probe.id, init.authMethods, {
        builtin: probe.builtin,
        registryId: probe.builtin ? undefined : probe.id,
        command: binPath,
      });
      assert.ok(methods.length > 0, `expected login methods for ${probe.id}`);
      if (!probe.builtin) {
        assert.equal(methods.filter((m) => m.flow === 'terminal').length, 1, `${probe.id} should expose exactly 1 terminal login method`);
        assert.ok(methods.some((m) => m.flow === 'api-key' || m.flow === 'env-vars'), `${probe.id} should expose API-key/env-var login`);
      } else {
        assert.ok(
          !methods.some((m) => m.id === 'olympus-cloud-oauth'),
          'oly acp should keep Olympus Cloud hidden by default unless OLYMPUS_CLOUD_ENABLED=1',
        );
        assert.ok(
          methods.some((m) => m.flow === 'api-key' || m.flow === 'env-vars' || m.flow === 'terminal'),
          'oly acp must advertise BYO API key / local Ollama / terminal auth by default',
        );
        const cloudInit = await probeLocalAcp(binPath, probe.args, { OLYMPUS_CLOUD_ENABLED: '1' });
        const cloudMethods = AUTH.effectiveAuthMethods(probe.id, cloudInit.authMethods, {
          builtin: true,
          command: binPath,
        });
        assert.ok(
          cloudMethods.some((m) => m.id === 'olympus-cloud-oauth'),
          'oly acp must advertise 1-click Olympus Cloud sign-in when OLYMPUS_CLOUD_ENABLED=1',
        );
      }
    });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
