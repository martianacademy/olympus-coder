// Unit tests: the agent manager tools on the olympus MCP server — role gating, argument checks, built-in / in-use
// removal refused, the confirm card (real src/main/elicitation.ts) with yes / no / withdrawn, one change at a time,
// small declarations, and the real ACP initialize probe (customAgents.ts) against tiny local agents.
// Files: src/main/agentTools.ts, src/main/customAgents.ts, src/main/elicitation.ts.
// Run: node tests/agentTools.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; no Electron needed)
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
// Stubs read their state from globalThis.__T so each test can set it up.
const stub = (src) => `data:text/javascript,${encodeURIComponent(src)}`;
const STUBS = {
  './agents': stub(`
    const T = () => globalThis.__T;
    export const allAgents = () => T().agents;
    export const chatsUsingAgent = (id) => T().using[id] ?? [];
    export const checkAgent = async (id) => { T().calls.push(['check', id]); return T().status ?? { id, state: 'ready' }; };
    export const agentStatuses = () => ({ defs: T().agents, statuses: [] });
    export const restartAgent = (id) => T().calls.push(['restart', id]);`),
  './catalog': stub(`
    const T = () => globalThis.__T;
    export const listCatalog = async () => T().catalog;
    export const planCatalogAdd = async (id, method) => ({ name: 'Fake Agent', description: '', version: '1.0.0', command: '/usr/local/bin/npx', args: ['-y', 'fake-agent@1', '--acp'] });
    export const addFromCatalog = async (id, method) => { T().calls.push(['install', id, method]); if (T().installGate) await T().installGate; return id; };`),
  './customAgents': stub(`
    const T = () => globalThis.__T;
    export const announceAgents = () => T().calls.push(['announce']);
    export const addCustomAgent = (def) => { T().calls.push(['save', def.name, def.command, def.args]); return { ...def, id: 'my-agent' }; };
    export const removeCustomAgent = (id) => T().calls.push(['remove', id]);
    export const probeAcp = async (cmd, args) => { T().calls.push(['probe', cmd]); if (T().probeError) throw new Error(T().probeError); return 'Fake 1.0'; };`),
  './orchestratorAgents': stub(`export class ToolError extends Error {}`),
  './store': stub(`
    export const findThread = (id) => ({ id, title: 'Chat ' + id });
    export const getSettings = () => globalThis.__T.settings;
    export const updateSettings = (p) => Object.assign(globalThis.__T.settings, p);`),
};
let realCustomAgents = false;
registerHooks({
  resolve(spec, ctx, next) {
    // The real customAgents.ts (probe test) still gets stubbed ./agents and ./store.
    if (STUBS[spec] && !(spec === './customAgents' && realCustomAgents)) return { url: STUBS[spec], shortCircuit: true };
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
});

const E = await import(`${APP}/src/main/elicitation.ts`);
const A = await import(`${APP}/src/main/agentTools.ts`);
realCustomAgents = true;
const C = await import(`${APP}/src/main/customAgents.ts?real`);

// One chat runtime, as agents.ts gives the elicitation host.
const rt = { thread: { id: 'main', items: [] }, agentId: 'claude', pendingElicits: new Map() };
E.initElicitations({
  bySession: new Map(),
  runtimes: () => [rt],
  addItem: (r, item) => r.thread.items.push(item),
  pushItem: () => {},
  forThread: () => rt,
});

const BUILTINS = [
  { id: 'claude', name: 'Claude Code', builtin: true, command: '@node', args: [] },
  { id: 'codex', name: 'Codex', builtin: true, command: '@node', args: [] },
];
const reset = (extra = {}) => {
  rt.thread.items = [];
  rt.pendingElicits.clear();
  globalThis.__T = {
    agents: [...BUILTINS, { id: 'gemini', name: 'Gemini CLI', builtin: false, command: 'gemini', args: ['--experimental-acp'] }],
    using: {},
    calls: [],
    settings: { customAgents: [] },
    catalog: [
      { id: 'claude', name: 'Claude Code', description: '', builtin: true, added: true, methods: [], blocked: {} },
      { id: 'fake-agent', name: 'Fake Agent', description: 'A test agent', builtin: false, added: false, methods: ['npx', 'uvx'], blocked: { uvx: 'Needs uv (uvx)' } },
      { id: 'other', name: 'Other Agent', description: 'Something else', builtin: false, added: true, methods: ['binary'], blocked: {} },
    ],
    ...extra,
  };
};
const main = { id: 'main', agentId: 'claude', projectId: 'p' };
const worker = { ...main, spawnedBy: 'x' };
const second = { ...main, secondOpinion: true };
const emit = () => {};
const run = (name, args, t = main, closed) => A.handleAgentTool(t, name, args, emit, closed);
const card = () => rt.thread.items.filter((i) => i.kind === 'elicitation' && !i.resolved).at(-1);
const waitCard = async () => {
  for (let i = 0; i < 100 && !card(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(card(), 'confirm card shown');
  return card();
};
const answer = (action) => E.answerElicitation(rt, card().id, action);

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    reset();
    await fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${String(e?.stack ?? e).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

await test('only main and forked sessions manage agents', async () => {
  assert.equal(A.canManageAgents(main), true);
  assert.equal(A.canManageAgents({ ...main, parentId: 'p1' }), true);
  assert.equal(A.canManageAgents(worker), false);
  assert.equal(A.canManageAgents(second), false);
  for (const t of [worker, second]) await assert.rejects(run('add_custom_agent', { name: 'X', command: 'x' }, t), /cannot add or remove agents/);
  assert.equal(await run('session_info', {}), undefined, 'other tools are not handled here');
});

await test('declarations are small, annotated and closed to extra arguments', () => {
  const defs = A.agentToolDefs();
  assert.deepEqual(defs.map((d) => d.name), A.AGENT_TOOLS);
  for (const d of defs) {
    const size = JSON.stringify(d).length;
    assert.ok(size < 600, `${d.name} declaration is ${size} chars`);
    assert.equal(d.inputSchema.additionalProperties, false);
    assert.ok(d.annotations && typeof d.annotations === 'object');
  }
  assert.equal(defs.find((d) => d.name === 'search_agent_registry').annotations.readOnlyHint, true);
  assert.equal(defs.find((d) => d.name === 'remove_agent').annotations.destructiveHint, true);
  assert.deepEqual(defs.find((d) => d.name === 'add_agent').annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
});

await test('search lists registry agents with usable methods, never built-ins', async () => {
  const all = await run('search_agent_registry', {});
  assert.match(all, /Fake Agent\*\* \(id: `fake-agent`\)/);
  assert.match(all, /methods: npx \(unavailable: uvx: Needs uv \(uvx\)\)/);
  assert.match(all, /Other Agent.*already added/);
  assert.doesNotMatch(all, /Claude Code/);
  assert.doesNotMatch(await run('search_agent_registry', { query: 'test agent' }), /Other Agent/);
  assert.match(await run('search_agent_registry', { query: 'zzz' }), /No registry agents match "zzz"/);
});

await test('argument checks: required, types, methods, unknown keys (no API keys)', async () => {
  await assert.rejects(run('add_agent', {}), /"registry_id" is required/);
  await assert.rejects(run('add_agent', { registry_id: 'fake-agent', method: 'brew' }), /Invalid method "brew"/);
  await assert.rejects(run('add_agent', { registry_id: 'fake-agent', api_key: 'sk-1' }), /Unknown argument: api_key.*never passed here/);
  await assert.rejects(run('add_agent', { registry_id: 'nope' }), /No registry agent with id "nope"/);
  await assert.rejects(run('add_agent', { registry_id: 'claude' }), /built into Olympus Coder/);
  await assert.rejects(run('add_agent', { registry_id: 'other' }), /already added/);
  await assert.rejects(run('add_agent', { registry_id: 'fake-agent', method: 'uvx' }), /not available: Needs uv/);
  await assert.rejects(run('add_agent', { registry_id: 'fake-agent', method: 'binary' }), /no "binary" method/);
  await assert.rejects(run('add_custom_agent', { name: 'X' }), /"command" is required/);
  await assert.rejects(run('add_custom_agent', { name: 'X', command: 'x', args: 'a b' }), /"args" must be an array of strings/);
  await assert.rejects(run('add_custom_agent', { name: 'X', command: 'x', env: { KEY: '1' } }), /Unknown argument: env/);
  await assert.rejects(run('remove_agent', {}), /"id" is required/);
  assert.equal(rt.thread.items.length, 0, 'no card for invalid calls');
  assert.deepEqual(globalThis.__T.calls, []);
});

await test('built-in, unknown and in-use agents are not removed', async () => {
  await assert.rejects(run('remove_agent', { id: 'claude' }), /built into Olympus Coder and cannot be removed/);
  await assert.rejects(run('remove_agent', { id: 'nope' }), /No agent with id "nope". Added agents: gemini/);
  globalThis.__T.using.gemini = ['t1'];
  await assert.rejects(run('remove_agent', { id: 'gemini' }), /in use by 1 running chat \(Chat t1\)/);
  assert.equal(rt.thread.items.length, 0);
  assert.deepEqual(globalThis.__T.calls, []);
});

await test('declining the card changes nothing', async () => {
  const p = run('add_custom_agent', { name: 'My Agent', command: '/opt/my agent', args: ['acp', '--x=1'] });
  const c = await waitCard();
  assert.equal(c.confirm.action, 'Add agent');
  assert.equal(c.confirm.title, 'Claude Code wants to add My Agent');
  assert.deepEqual(c.confirm.rows.find((r) => r.label === 'Command'), { label: 'Command', value: "'/opt/my agent' acp --x=1", code: true });
  answer('decline');
  assert.equal(await p, 'The user declined.');
  assert.equal(c.resolved, 'declined');
  assert.deepEqual(globalThis.__T.calls, [], 'no probe, no save');
  // Dismiss (cancel) and remove are declines too.
  const r = run('remove_agent', { id: 'gemini' });
  const rc = await waitCard();
  assert.equal(rc.confirm.danger, true);
  answer('cancel');
  assert.equal(await r, 'The user declined.');
  assert.deepEqual(globalThis.__T.calls, []);
});

await test('a dropped MCP request withdraws the card', async () => {
  let gone = false;
  const p = run('remove_agent', { id: 'gemini' }, main, () => gone);
  const c = await waitCard();
  gone = true;
  assert.equal(await p, 'The user declined.');
  assert.equal(c.resolved, 'withdrawn');
  assert.deepEqual(globalThis.__T.calls, []);
});

await test('approve: custom agent is probed, then saved', async () => {
  const p = run('add_custom_agent', { name: 'My Agent', command: 'node', args: ['agent.mjs'] });
  await waitCard();
  answer('accept');
  const out = await p;
  assert.match(out, /Added My Agent \(agent id `my-agent`; answered initialize as Fake 1.0\)\. Status: ready/);
  assert.deepEqual(globalThis.__T.calls, [['probe', 'node'], ['save', 'My Agent', 'node', ['agent.mjs']], ['check', 'my-agent']]);
});

await test('approve: a broken command is refused with its error and not saved', async () => {
  globalThis.__T.probeError = 'The command exited (code 3) before answering ACP initialize.\nboom';
  const p = run('add_custom_agent', { name: 'Broken', command: 'node', args: ['-e', 'process.exit(3)'] });
  await waitCard();
  answer('accept');
  await assert.rejects(p, /Not saved: node -e 'process.exit\(3\)' did not work as an ACP agent\. The command exited \(code 3\)[\s\S]*boom/);
  assert.deepEqual(globalThis.__T.calls, [['probe', 'node']]);
});

await test('one change at a time; registry add then reports needs-login', async () => {
  let release;
  globalThis.__T.installGate = new Promise((r) => (release = r));
  globalThis.__T.status = { id: 'fake-agent', state: 'needs-login' };
  const first = run('add_agent', { registry_id: 'fake-agent' });
  const c = await waitCard();
  assert.deepEqual(
    c.confirm.rows.map((r) => [r.label, r.value]),
    [
      ['Agent', 'Fake Agent 1.0.0'],
      ['Source', 'ACP registry · fake-agent · npx'],
      ['Command', '/usr/local/bin/npx -y fake-agent@1 --acp'],
    ],
  );
  await assert.rejects(run('add_custom_agent', { name: 'Y', command: 'y' }), /Another agent change is in progress \(adding fake-agent\)/);
  await assert.rejects(run('remove_agent', { id: 'gemini' }), /Another agent change is in progress/);
  answer('accept');
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(run('add_agent', { registry_id: 'fake-agent' }), /in progress/, 'still busy while installing');
  release();
  const out = await first;
  assert.match(out, /Added Fake Agent \(agent id `fake-agent`, npx\)\. Status: needs login\. The user must log in via Settings → Agents & login/);
  assert.deepEqual(globalThis.__T.calls, [['install', 'fake-agent', 'npx'], ['announce'], ['check', 'fake-agent']]);
  // Free again afterwards.
  const r = run('remove_agent', { id: 'gemini' });
  await waitCard();
  answer('accept');
  assert.match(await r, /Removed Gemini CLI \(gemini\)/);
  assert.deepEqual(globalThis.__T.calls.at(-1), ['remove', 'gemini']);
});

await test('busy flag is cleared after an error', async () => {
  await assert.rejects(run('add_agent', { registry_id: 'nope' }), /No registry agent/);
  const p = run('remove_agent', { id: 'gemini' });
  await waitCard();
  answer('decline');
  assert.equal(await p, 'The user declined.');
});

// ---- the real ACP initialize probe ----
const dir = mkdtempSync(join(tmpdir(), 'olympus-probe-'));
const good = join(dir, 'good.mjs');
writeFileSync(
  good,
  `import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'Tiny', version: '0.1' } } }) + '\\n');
});`,
);
const rpcErr = join(dir, 'err.mjs');
writeFileSync(
  rpcErr,
  `process.stdin.once('data', () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 0, error: { code: -32603, message: 'not today' } }) + '\\n'));`,
);
const silent = join(dir, 'silent.mjs');
writeFileSync(silent, `process.stdin.resume(); setInterval(() => {}, 1000);`);

await test('probe: a real ACP agent answers initialize', async () => {
  assert.equal(await C.probeAcp(process.execPath, [good]), 'Tiny 0.1');
});
await test('probe: real errors for exit, JSON-RPC error, missing command, timeout', async () => {
  await assert.rejects(C.probeAcp(process.execPath, ['-e', 'console.error("bad flag"); process.exit(3)']), /exited \(code 3\) before answering ACP initialize\.\nbad flag/);
  await assert.rejects(C.probeAcp(process.execPath, [rpcErr]), /ACP initialize failed: not today/);
  await assert.rejects(C.probeAcp('definitely-not-a-command-xyz', []), /"definitely-not-a-command-xyz" was not found/);
  await assert.rejects(C.probeAcp(process.execPath, [silent], {}, 600), /No answer to ACP initialize within 1 s/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
