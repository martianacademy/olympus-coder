// Unit tests: ACP session settings (booleans, grouped selects, legacy modes), MCP status + partial session/new retry
// + MCP over ACP (`mcp/message`, real SDK on in-memory streams), model providers, login methods / status / links.
// Files: src/main/acpConfig.ts, acpMcp.ts, acpProviders.ts, acpAuth.ts, acpConfigService.ts, src/shared/acpConfig.ts.
// Run: node tests/acpConfig.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; no Electron needed)
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
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

const C = await import(`${APP}/src/main/acpConfig.ts`);
const SH = await import(`${APP}/src/shared/acpConfig.ts`);
const M = await import(`${APP}/src/main/acpMcp.ts`);
const P = await import(`${APP}/src/main/acpProviders.ts`);
const A = await import(`${APP}/src/main/acpAuth.ts`);
const SVC = await import(`${APP}/src/main/acpConfigService.ts`);
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
    console.log(`FAIL  ${name}\n      ${String(e?.stack ?? e).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

// ---------------------------------------------------------------- config options

// Shapes as claude-agent-acp 0.107 / codex-acp 2.6 send them to a client with `session.configOptions.boolean`.
const CLAUDE_OPTS = [
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Manual' }, { value: 'plan', name: 'Plan' }] },
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'opus', options: [{ value: 'opus', name: 'Opus', description: 'Best' }, { value: 'sonnet', name: 'Sonnet' }] },
  { id: 'fast', name: 'Fast mode', category: 'model_config', type: 'boolean', currentValue: false, description: 'Faster responses on supported models' },
  { id: 'ultracode', name: 'Ultracode', category: 'model_config', type: 'boolean', currentValue: true },
];
const CODEX_MODE = {
  id: 'mode',
  name: 'Mode',
  category: 'mode',
  type: 'select',
  currentValue: 'agent',
  options: [
    { group: 'sandbox-modes', name: 'Sandbox Modes', options: [{ value: 'read-only', name: 'Read only' }, { value: 'agent', name: 'Auto review' }] },
    { group: 'permission-profiles', name: 'Permission Profiles', options: [{ value: 'permission-profile:ci', name: 'CI' }] },
  ],
};

await test('mapConfigOptions keeps booleans as On/Off toggles with string values', () => {
  const v = C.mapConfigOptions(CLAUDE_OPTS);
  assert.deepEqual(v.map((o) => o.id), ['mode', 'model', 'fast', 'ultracode']);
  const fast = v.find((o) => o.id === 'fast');
  assert.equal(fast.type, 'boolean');
  assert.equal(fast.currentValue, 'false');
  assert.deepEqual(fast.options.map((x) => x.value), ['true', 'false']);
  assert.equal(v.find((o) => o.id === 'ultracode').currentValue, 'true');
  assert.equal(SH.isBooleanOption(fast), true);
  assert.equal(SH.isOn(fast), false);
  assert.equal(v.find((o) => o.id === 'model').options[0].description, 'Best');
});

await test('mapConfigOptions keeps select groups (headers + each choice\'s group) and drops unknown types', () => {
  const [mode, ...rest] = C.mapConfigOptions([CODEX_MODE, { id: 'x', name: 'X', type: 'slider', currentValue: 3 }, null, { name: 'no id' }]);
  assert.equal(rest.length, 0);
  assert.deepEqual(mode.groups, [{ id: 'sandbox-modes', name: 'Sandbox Modes' }, { id: 'permission-profiles', name: 'Permission Profiles' }]);
  assert.deepEqual(mode.options.map((o) => `${o.group}/${o.value}`), ['sandbox-modes/read-only', 'sandbox-modes/agent', 'permission-profiles/permission-profile:ci']);
  const sections = SH.groupedChoices(mode);
  assert.deepEqual(sections.map((s) => [s.group?.name, s.choices.length]), [['Sandbox Modes', 2], ['Permission Profiles', 1]]);
  // A flat select has one unnamed section.
  const flat = C.mapConfigOption(CLAUDE_OPTS[1]);
  assert.deepEqual(SH.groupedChoices(flat).map((s) => s.group), [undefined]);
});

await test('select without type (older agents) still maps; legacy modes become __mode', () => {
  assert.equal(C.mapConfigOptions([{ id: 'm', name: 'M', currentValue: 'a', options: [{ value: 'a', name: 'A' }] }]).length, 1);
  const legacy = C.configView({ modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }] } });
  assert.equal(legacy[0].id, '__mode');
  assert.equal(legacy[0].currentValue, 'ask');
  assert.deepEqual(C.configView({ configOptions: CLAUDE_OPTS, modes: { currentModeId: 'x', availableModes: [{ id: 'x', name: 'X' }] } }).map((o) => o.id)[0], 'mode');
  assert.deepEqual(C.configView({}), []);
});

await test('configRequest: boolean → {type:boolean, value}, select → {value}, __mode → session/set_mode', () => {
  const v = C.mapConfigOptions(CLAUDE_OPTS);
  assert.deepEqual(C.configRequest('s1', v, 'fast', 'true'), { method: 'session/set_config_option', params: { sessionId: 's1', configId: 'fast', type: 'boolean', value: true } });
  assert.deepEqual(C.configRequest('s1', v, 'ultracode', 'off'), { method: 'session/set_config_option', params: { sessionId: 's1', configId: 'ultracode', type: 'boolean', value: false } });
  assert.deepEqual(C.configRequest('s1', v, 'model', 'sonnet'), { method: 'session/set_config_option', params: { sessionId: 's1', configId: 'model', value: 'sonnet' } });
  assert.deepEqual(C.configRequest('s1', v, '__mode', 'code'), { method: 'session/set_mode', params: { sessionId: 's1', modeId: 'code' } });
  assert.throws(() => C.configRequest('s1', v, 'fast', 'maybe'), /on\/off/);
});

await test('afterSet uses the agent\'s full list, else patches one value (booleans normalised)', () => {
  const v = C.mapConfigOptions(CLAUDE_OPTS);
  const fromAgent = C.afterSet(v, 'fast', 'true', { configOptions: [{ ...CLAUDE_OPTS[2], currentValue: true }] });
  assert.deepEqual(fromAgent.map((o) => o.id), ['fast']);
  const patched = C.afterSet(v, 'fast', 'on', {});
  assert.equal(patched.find((o) => o.id === 'fast').currentValue, 'true');
  assert.equal(C.afterSet(C.configView({ modes: { currentModeId: 'a', availableModes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } }), '__mode', 'b', { configOptions: [] })[0].currentValue, 'b');
});

await test('initialConfigOptions types saved defaults from known options; skips unknown toggles and invalid values', () => {
  const known = C.mapConfigOptions(CLAUDE_OPTS);
  const out = C.initialConfigOptions({ fast: 'true', model: 'sonnet', mode: 'nope', __autoApprove: '1', newsel: 'x', newbool: 'true' }, known);
  assert.deepEqual(out, [
    { configId: 'fast', type: 'boolean', value: true },
    { configId: 'model', value: 'sonnet' },
    { configId: 'newsel', value: 'x' },
  ]);
});

await test('defaultsToApply: only differing, valid values; __mode allowed, other __ keys not', () => {
  const opts = [...C.mapConfigOptions(CLAUDE_OPTS), ...C.legacyOptions({ modes: { currentModeId: 'a', availableModes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } })];
  assert.deepEqual(C.defaultsToApply({ fast: 'on', ultracode: 'true', model: 'gone', __mode: 'b', __autoApprove: '1' }, opts), [
    ['fast', 'true'],
    ['__mode', 'b'],
  ]);
});

await test('matchChoice: toggles accept on/off/yes/true; selects keep loose matching', () => {
  const v = C.mapConfigOptions(CLAUDE_OPTS);
  const fast = v.find((o) => o.id === 'fast');
  assert.equal(C.matchChoice(fast, 'ON').value, 'true');
  assert.equal(C.matchChoice(fast, 'no').value, 'false');
  assert.equal(C.matchChoice(fast, 'fast'), undefined);
  const model = v.find((o) => o.id === 'model');
  assert.equal(C.matchChoice(model, 'Sonn').value, 'sonnet');
  assert.equal(C.matchChoice(model, 'o'), undefined); // ambiguous
});

await test('withCurrentMode follows current_mode_update for mode and __mode options', () => {
  const opts = [...C.mapConfigOptions(CLAUDE_OPTS)];
  assert.equal(C.withCurrentMode(opts, 'plan').find((o) => o.id === 'mode').currentValue, 'plan');
  assert.equal(C.withCurrentMode(opts, 'plan').find((o) => o.id === 'model').currentValue, 'opus');
});

await test('shared labels: toggle tooltip names the setting and its state; pill labels', () => {
  const fast = C.mapConfigOption(CLAUDE_OPTS[2]);
  assert.match(SH.toggleTooltip(fast), /^Fast mode — Faster responses.*\nFast mode is off\. Click to turn it on\.$/s);
  assert.equal(SH.optionPillLabel(C.mapConfigOption(CLAUDE_OPTS[1]), 'Opus'), 'Opus');
  assert.equal(SH.optionPillLabel(fast, 'On'), 'Fast mode: On');
  assert.equal(SH.parseBool('Enabled'), true);
  assert.equal(SH.parseBool('maybe'), undefined);
  assert.deepEqual(C.CONFIG_SESSION_CAPS, { configOptions: { boolean: {} } });
});

// ---------------------------------------------------------------- MCP status

await test('mcpStatusFromUpdate: Codex startup tool calls (failed / skipped / cancelled / auth) are status, hidden from the chat', () => {
  const tc = (name, text) => ({
    sessionUpdate: 'tool_call',
    toolCallId: `mcp_startup.${encodeURIComponent(name)}.1234-uuid`,
    kind: 'other',
    title: `mcp__${name}__startup`,
    status: 'failed',
    content: [{ type: 'content', content: { type: 'text', text } }],
  });
  const f = M.mcpStatusFromUpdate(tc('github', '[codex-acp forwarded startup error] MCP server `github` failed to start: spawn gh ENOENT'));
  assert.deepEqual({ ...f }, { name: 'github', state: 'failed', reason: 'MCP server `github` failed to start: spawn gh ENOENT', hide: true });
  assert.equal(M.mcpStatusFromUpdate(tc('linear', '[codex-acp] MCP server `linear` was not started, because the Codex config already defines an MCP server with this name.')).state, 'skipped');
  assert.equal(M.mcpStatusFromUpdate(tc('slow', '[codex-acp forwarded startup error] MCP server `slow` startup was cancelled.')).state, 'cancelled');
  assert.equal(M.mcpStatusFromUpdate(tc('notion', 'MCP server `notion` failed to start: OAuth reauthentication required')).state, 'needs-auth');
  // By id only (title rewritten).
  assert.equal(M.mcpStatusFromUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'mcp_startup.my%20server.abcd', title: 'x' }).name, 'my server');
  assert.equal(M.mcpStatusFromUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file' }), null);
});

await test('mcpStatusFromUpdate: Claude notices and tagged message chunks', () => {
  const n = M.mcpStatusFromUpdate({ sessionUpdate: 'notice', severity: 'warning', title: 'MCP server "db" failed to start', description: 'Its tools are unavailable in this session. Run /mcp for the error.' });
  assert.equal(n.name, 'db');
  assert.equal(n.state, 'failed');
  assert.equal(n.hide, false);
  assert.equal(M.mcpStatusFromUpdate({ sessionUpdate: 'notice', title: 'MCP server "x" needs authentication' }).state, 'needs-auth');
  assert.equal(M.mcpStatusFromUpdate({ sessionUpdate: 'notice', title: 'Context is almost full' }), null);
  const chunk = M.mcpStatusFromUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '> **x**' }, _meta: { claudeCode: { kind: 'mcpServerStatus', server: 'x', status: 'failed' } } });
  assert.equal(chunk.state, 'failed');
});

await test('McpStatusStore: begin / apply / markReady never hides a reported problem; emits each change', () => {
  const seen = [];
  const st = new M.McpStatusStore((s) => seen.push(s));
  const rows = M.describeServers([{ type: 'http', name: 'olympus', url: 'u', headers: [] }, { name: 'github', command: 'gh', args: [], env: [] }], 'olympus', 1);
  assert.deepEqual(rows.map((r) => [r.name, r.source, r.transport, r.state]), [['olympus', 'olympus', 'http', 'sent'], ['github', 'connector', 'stdio', 'sent']]);
  st.begin('t1', 'codex', rows);
  st.markReady('t1', 'olympus');
  st.apply('t1', { name: 'github', state: 'failed', reason: 'boom' });
  st.markReady('t1', 'github');
  st.apply('t1', { name: 'extra server', state: 'skipped' });
  const s = st.get('t1');
  assert.deepEqual(s.servers.map((r) => `${r.name}:${r.state}`), ['olympus:ready', 'github:failed', 'extra server:skipped']);
  assert.equal(s.servers[1].reason, 'boom');
  assert.equal(seen.length, 4);
  assert.equal(st.apply('unknown', { name: 'a', state: 'failed' }), undefined);
  // Codex reports names with whitespace replaced by _.
  st.begin('t2', 'codex', M.describeServers([{ name: 'my server', command: 'x', args: [], env: [] }], undefined));
  st.apply('t2', { name: 'my_server', state: 'failed' });
  assert.equal(st.get('t2').servers.length, 1);
  assert.equal(st.get('t2').servers[0].state, 'failed');
});

// ---------------------------------------------------------------- session/new partial retry

const OLY = { type: 'http', name: 'olympus', url: 'http://127.0.0.1:1/mcp/t', headers: [] };
const GH = { name: 'github', command: 'gh', args: [], env: [] };
const GHE = { name: 'github-enterprise', command: 'ghe', args: [], env: [] };
const SSE = { type: 'sse', name: 'events', url: 'http://x', headers: [] };
const rpcErr = (message, data, code = -32602) => Object.assign(new Error(message), { code, data });

await test('nextCreateAttempt: drops only the server the error names (data.name, quoted, longest match)', () => {
  const cur = { servers: [OLY, GH, GHE], systemPrompt: true };
  const a = M.nextCreateAttempt(rpcErr('MCP server names must be unique', { name: 'github' }), cur, 'olympus');
  assert.deepEqual(a.servers.map((s) => s.name), ['olympus', 'github-enterprise']);
  assert.equal(a.systemPrompt, true);
  assert.deepEqual(a.dropped.map((d) => d.name), ['github']);
  assert.match(a.note, /Started without the MCP server "github"/);
  const b = M.nextCreateAttempt(rpcErr('failed to start MCP server `github-enterprise`: bad config'), cur, 'olympus');
  assert.deepEqual(b.dropped.map((d) => d.name), ['github-enterprise']);
  assert.equal(M.serverNamedIn(rpcErr('MCP server github failed'), cur.servers), 'github');
  // A word that merely contains a name is not a match.
  assert.equal(M.serverNamedIn(rpcErr('githubby is broken'), cur.servers), undefined);
});

await test('nextCreateAttempt: a refused transport drops all servers of it; then system prompt; then connectors; then all; then null', () => {
  let cur = { servers: [OLY, GH, SSE], systemPrompt: true };
  const steps = [];
  const errs = [rpcErr("Codex doesn't support MCP SSE transport protocol"), rpcErr('Internal error', undefined, -32603), rpcErr('Internal error', undefined, -32603), rpcErr('Internal error', undefined, -32603), rpcErr('x')];
  for (const e of errs) {
    const n = M.nextCreateAttempt(e, cur, 'olympus');
    if (!n) {
      steps.push('null');
      break;
    }
    steps.push(`${n.servers.map((s) => s.name).join('+') || '-'}|${n.systemPrompt ? 'sp' : 'nosp'}|${n.dropped.map((d) => d.name).join('+') || '-'}`);
    cur = n;
  }
  assert.deepEqual(steps, ['olympus+github|sp|events', 'olympus+github|nosp|-', 'olympus|nosp|github', '-|nosp|olympus', 'null']);
  assert.equal(M.transportRefusedIn(rpcErr('ACP transport is not supported')), 'acp');
});

// ---------------------------------------------------------------- MCP over ACP (real SDK, in-memory)

function pipePair() {
  const a = new TransformStream();
  const b = new TransformStream();
  return { client: SDK.ndJsonStream(a.writable, b.readable), agent: SDK.ndJsonStream(b.writable, a.readable) };
}

await test('AcpMcpServing serves the olympus rpc over mcp/message (tools/list, tools/call, server/discover, inner errors)', async () => {
  const calls = [];
  const served = new M.AcpMcpServing({
    rpc: async (threadId, msg) => {
      calls.push([threadId, msg.method, msg.id]);
      if (msg.method === 'initialize') return { jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'olympus' }, capabilities: { tools: {} }, protocolVersion: msg.params.protocolVersion } };
      if (msg.method === 'tools/list') return { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'session_info' }] } };
      if (msg.method === 'tools/call') return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `hi ${msg.params.name}` }] } };
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
    },
  });
  const pipes = pipePair();
  const clientConn = SDK.client({ name: 'olympus-unit' }).onRequest(SDK.methods.client.mcp.message, served.handleRequest).connect(pipes.client);
  const agentConn = SDK.agent({ name: 'mock-agent' }).connect(pipes.agent);
  const decl = await served.declare(clientConn.agent, 'thread-1', 'olympus');
  assert.equal(decl.type, 'acp');
  assert.equal(decl.name, 'olympus');
  assert.ok(decl.serverId);
  const caller = new SDK.McpOverAcpCaller({ clientInfo: { name: 'mock-agent', version: '1' } });
  const list = await caller.request(agentConn.client, decl.serverId, 'tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ['session_info']);
  const call = await caller.request(agentConn.client, decl.serverId, 'tools/call', { name: 'session_info', arguments: {} });
  assert.equal(call.result.content[0].text, 'hi session_info');
  const disc = await caller.request(agentConn.client, decl.serverId, 'server/discover', {});
  assert.equal(disc.result.serverInfo.name, 'olympus');
  assert.equal(disc.result.protocolVersion, '2026-07-28');
  const bad = await caller.request(agentConn.client, decl.serverId, 'resources/list', {});
  assert.equal(bad.error.code, -32601);
  assert.deepEqual(calls.map((c) => c[0] + ':' + c[1]), ['thread-1:tools/list', 'thread-1:tools/call', 'thread-1:initialize', 'thread-1:resources/list']);
  // After release, the agent gets the binding's "server unavailable".
  await served.release('thread-1');
  await assert.rejects(caller.request(agentConn.client, decl.serverId, 'tools/list', {}), (e) => e.code === -33001);
  clientConn.close?.();
  agentConn.close?.();
});

await test('supportsAcpMcp only with mcpCapabilities.acp === true', () => {
  assert.equal(M.supportsAcpMcp({ mcpCapabilities: { acp: true, http: true } }), true);
  assert.equal(M.supportsAcpMcp({ mcpCapabilities: { acp: false, http: true } }), false); // codex-acp 2.6
  assert.equal(M.supportsAcpMcp({ mcpCapabilities: { http: true, sse: true } }), false); // claude-agent-acp 0.107
  assert.equal(M.supportsAcpMcp({}), false); // agy 1.5.8
});

// ---------------------------------------------------------------- providers

function memSecrets() {
  const m = new Map();
  return { m, getSecret: (k) => m.get(k), setSecret: (k, v) => (v ? m.set(k, v) : m.delete(k)) };
}

function mockProviderAgent({ supported = ['anthropic', 'bedrock', 'vertex'], providerId = 'main', failSet } = {}) {
  const calls = [];
  let current = { apiType: 'anthropic', baseUrl: 'https://api.anthropic.com' };
  const conn = {
    async request(method, params) {
      calls.push([method, JSON.parse(JSON.stringify(params))]);
      if (method === 'providers/list') return { providers: [{ providerId, supported, required: false, current }] };
      if (method === 'providers/set') {
        if (failSet) throw Object.assign(new Error(`Model discovery failed: 401 for Authorization: Bearer ${params.headers?.Authorization?.slice(7)}`), { code: -32603 });
        current = { apiType: params.apiType, baseUrl: params.baseUrl };
        return {};
      }
      if (method === 'providers/disable') {
        current = { apiType: 'anthropic', baseUrl: 'https://api.anthropic.com' };
        return {};
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { conn, calls, caps: { providers: {} } };
}

await test('providers: list → slots; set sends key in a header, stores config + key encrypted (key never in the view)', async () => {
  const sec = memSecrets();
  const ag = mockProviderAgent();
  const svc = new P.ProviderService(sec, { connection: async () => ({ conn: ag.conn, caps: ag.caps }) });
  const v0 = await svc.view('claude');
  assert.equal(v0.known, true);
  assert.equal(v0.supported, true);
  assert.deepEqual(v0.slots[0], { providerId: 'main', supported: ['anthropic', 'bedrock', 'vertex'], required: false, current: { apiType: 'anthropic', baseUrl: 'https://api.anthropic.com' } });
  const v1 = await svc.set('claude', { providerId: 'main', apiType: 'anthropic', baseUrl: ' https://gw.example.com ', keyHeader: 'authorization', apiKey: 'sk-secret-123' });
  const set = ag.calls.find((c) => c[0] === 'providers/set')[1];
  assert.deepEqual(set, { providerId: 'main', apiType: 'anthropic', baseUrl: 'https://gw.example.com', headers: { Authorization: 'Bearer sk-secret-123' } });
  assert.equal(v1.saved.hasKey, true);
  assert.equal(JSON.stringify(v1).includes('sk-secret-123'), false);
  assert.equal(sec.getSecret('provider:claude:key'), 'sk-secret-123');
  assert.equal(JSON.parse(sec.getSecret('provider:claude')).baseUrl, 'https://gw.example.com');
  // Update without a key keeps the saved key.
  await svc.set('claude', { providerId: 'main', apiType: 'anthropic', baseUrl: 'https://gw2.example.com', keyHeader: 'x-api-key' });
  assert.deepEqual(ag.calls.filter((c) => c[0] === 'providers/set')[1][1].headers, { 'x-api-key': 'sk-secret-123' });
});

await test('providers: validation (url, api type, vertex project/region) and vertex _meta', async () => {
  const sec = memSecrets();
  const ag = mockProviderAgent();
  const svc = new P.ProviderService(sec, { connection: async () => ({ conn: ag.conn, caps: ag.caps }) });
  await assert.rejects(svc.set('claude', { providerId: 'main', apiType: 'anthropic', baseUrl: 'ftp://x', keyHeader: 'none' }), /base URL/);
  await assert.rejects(svc.set('claude', { providerId: 'main', apiType: 'openai', baseUrl: 'https://x', keyHeader: 'none' }), /API type/);
  await assert.rejects(svc.set('claude', { providerId: 'other', apiType: 'anthropic', baseUrl: 'https://x', keyHeader: 'none' }), /no model provider/);
  await assert.rejects(svc.set('claude', { providerId: 'main', apiType: 'vertex', baseUrl: 'https://aiplatform.googleapis.com', keyHeader: 'none' }), /project ID/);
  await svc.set('claude', { providerId: 'main', apiType: 'vertex', baseUrl: 'https://aiplatform.googleapis.com', keyHeader: 'none', vertex: { projectId: 'p1', region: 'us-east5' } });
  const set = ag.calls.find((c) => c[0] === 'providers/set')[1];
  assert.deepEqual(set._meta, { claudeCode: { vertex: { projectId: 'p1', region: 'us-east5' } } });
  assert.deepEqual(set.headers, {});
  assert.equal(ag.calls.filter((c) => c[0] === 'providers/set').length, 1);
});

await test('providers: a refused set keeps nothing and scrubs the key from the error', async () => {
  const sec = memSecrets();
  const ag = mockProviderAgent({ failSet: true, supported: ['openai'], providerId: 'openai' });
  const svc = new P.ProviderService(sec, { connection: async () => ({ conn: ag.conn, caps: ag.caps }) });
  await assert.rejects(svc.set('codex', { providerId: 'openai', apiType: 'openai', baseUrl: 'https://gw', keyHeader: 'authorization', apiKey: 'sk-live-999' }), (e) => {
    assert.equal(e.message.includes('sk-live-999'), false);
    assert.match(e.message, /did not accept this provider/);
    return true;
  });
  assert.equal(sec.m.size, 0);
});

await test('providers: reapply after restart; disable forgets config + key; unsupported / not running agents', async () => {
  const sec = memSecrets();
  const ag = mockProviderAgent();
  const svc = new P.ProviderService(sec, { connection: async () => ({ conn: ag.conn, caps: ag.caps }) });
  await svc.set('claude', { providerId: 'main', apiType: 'anthropic', baseUrl: 'https://gw', keyHeader: 'authorization', apiKey: 'k-1234' });
  const fresh = mockProviderAgent();
  assert.equal(await svc.reapply('claude', fresh.conn, fresh.caps), undefined);
  assert.deepEqual(fresh.calls[0], ['providers/set', { providerId: 'main', apiType: 'anthropic', baseUrl: 'https://gw', headers: { Authorization: 'Bearer k-1234' } }]);
  const refusing = mockProviderAgent({ failSet: true });
  const err = await svc.reapply('claude', refusing.conn, refusing.caps);
  assert.match(err, /401/);
  assert.equal(err.includes('k-1234'), false);
  assert.equal(svc.saved('claude').error, err);
  assert.equal(await svc.reapply('claude', fresh.conn, {}), undefined); // agent without providers: nothing sent
  await svc.disable('claude');
  assert.deepEqual(ag.calls.filter((c) => c[0] === 'providers/disable'), [['providers/disable', { providerId: 'main' }]]);
  assert.equal(sec.m.size, 0);
  const none = new P.ProviderService(sec, { connection: async () => null });
  assert.deepEqual(await none.view('x', false), { agentId: 'x', known: false, supported: false, slots: [] });
  const agy = new P.ProviderService(sec, { connection: async () => ({ conn: ag.conn, caps: {} }) });
  assert.equal((await agy.view('antigravity')).supported, false);
  assert.equal(P.scrubKey('header x-api-key: abcdef and Bearer zzz', undefined), 'header x-api-key: ••• and Bearer •••');
});

// ---------------------------------------------------------------- login

await test('auth methods: terminal, agent, Codex api-key (_meta), env_var with several vars, gateway hidden', () => {
  const raw = [
    { id: 'claude-ai-login', name: 'Claude Subscription', type: 'terminal', args: ['--cli', 'auth', 'login'] },
    { id: 'chat-gpt', name: 'ChatGPT' },
    { id: 'api-key', name: 'API Key', _meta: { 'api-key': { provider: 'openai' } } },
    { id: 'gemini-api-key', name: 'Gemini API key' },
    { id: 'azure', name: 'Azure', type: 'env_var', vars: [{ name: 'AZURE_KEY', label: 'Key' }, { name: 'AZURE_ENDPOINT', secret: false }, { name: 'AZURE_ORG', optional: true }], link: 'https://example.com/keys' },
    { id: 'gateway', name: 'Custom model gateway', _meta: { gateway: { protocol: 'openai' } } },
  ];
  const codex = A.visibleMethods('codex', raw);
  assert.deepEqual(codex.map((m) => `${m.id}:${m.flow}`), ['claude-ai-login:terminal', 'chat-gpt:agent', 'api-key:api-key', 'gemini-api-key:api-key', 'azure:env-vars']);
  assert.deepEqual(codex[2].vars, [{ name: 'CODEX_API_KEY', label: 'API key', secret: true, optional: false }]);
  assert.equal(codex[2].keyInMeta, true);
  assert.deepEqual(A.visibleMethods('antigravity', raw)[3].vars[0].name, 'GEMINI_API_KEY');
  const azure = codex[4];
  assert.deepEqual(azure.vars, [{ name: 'AZURE_KEY', label: 'Key', secret: true, optional: false }, { name: 'AZURE_ENDPOINT', secret: false, optional: false }, { name: 'AZURE_ORG', secret: true, optional: true }]);
  assert.equal(azure.link, 'https://example.com/keys');
  assert.deepEqual(A.missingVars(azure, { AZURE_KEY: 'k' }), ['AZURE_ENDPOINT']);
  assert.deepEqual(A.authenticateParams(codex[2], { CODEX_API_KEY: 'sk-1' }), { methodId: 'api-key', _meta: { 'api-key': { apiKey: 'sk-1' } } });
  assert.deepEqual(A.authenticateParams(azure, { AZURE_KEY: 'k' }), { methodId: 'azure' });
  assert.throws(() => A.authenticateParams(codex[0]), /terminal/);
  // An unknown agent's api-key method with no known variable stays an agent login (nothing to ask for).
  assert.equal(A.authMethodDetail('mystery', { id: 'api-key', name: 'Key' }).flow, 'agent');
  const env = A.envForMethods('codex', raw, (k) => ({ 'codex:AZURE_KEY': 'k1', 'codex:AZURE_ENDPOINT': 'https://e', 'codex:CODEX_API_KEY': 'sk' })[k]);
  assert.deepEqual(env, { CODEX_API_KEY: 'sk', AZURE_KEY: 'k1', AZURE_ENDPOINT: 'https://e' });
});

await test('auth status: spec auth/status (Claude), Codex _auth/status_update, logged out, junk', () => {
  const claude = A.parseAuthStatus({ state: 'authenticated', accounts: [{ label: 'Suru', email: 'a@b.c', active: true, _meta: { claudeCode: { kind: 'account', plan: 'Claude Max' } } }] }, 5);
  assert.deepEqual(claude, { state: 'authenticated', kind: 'account', accounts: [{ label: 'Suru', email: 'a@b.c', plan: 'Claude Max', active: true }], at: 5 });
  assert.equal(A.activeAccount(claude).plan, 'Claude Max');
  const codex = A.parseAuthStatus({ authStatus: { kind: 'account', label: 'ChatGPT', account: { email: 'x@y.z', plan: 'pro' } } }, 6);
  assert.equal(codex.state, 'authenticated');
  assert.equal(codex.kind, 'account');
  assert.deepEqual(codex.accounts[0], { label: 'ChatGPT', email: 'x@y.z', plan: 'pro', active: true });
  assert.equal(A.parseAuthStatus({ authStatus: { kind: 'none', label: 'Not signed in' } }).state, 'unauthenticated');
  assert.equal(A.parseAuthStatus({ state: 'weird' }).state, 'unknown');
  assert.equal(A.parseAuthStatus({ state: 'not_required' }).state, 'not_required');
  assert.equal(A.parseAuthStatus({ foo: 1 }), null);
  assert.equal(A.parseAuthStatus(null), null);
});

await test('login links: only request-scoped URL elicitations during a login; accept keeps the code visible until the login ends', async () => {
  const events = [];
  const links = new A.LoginLinks((agentId, link) => events.push([agentId, link ? link.message : null]));
  const params = { mode: 'url', url: 'https://auth.openai.com/device', message: 'Sign in to ChatGPT and enter this code: ABCD-1234', elicitationId: 'e1' };
  assert.equal(links.handles('codex', params), false); // no login running
  let finishLogin;
  const login = links.during('codex', () => new Promise((r) => (finishLogin = r)));
  assert.equal(links.handles('codex', params), true);
  assert.equal(links.handles('codex', { ...params, sessionId: 's1' }), false);
  assert.equal(links.handles('codex', { ...params, url: 'javascript:alert(1)' }), false);
  assert.equal(links.handles('claude', params), false);
  const answer = links.request('codex', params);
  assert.equal(links.current('codex').message, params.message);
  links.answer('codex', { action: 'accept' });
  assert.deepEqual(await answer, { action: 'accept' });
  assert.ok(links.current('codex'), 'the code stays shown after opening the link');
  finishLogin('ok');
  assert.equal(await login, 'ok');
  assert.equal(links.current('codex'), undefined);
  assert.deepEqual(events, [['codex', params.message], ['codex', null]]);
  // A declined link resolves and disappears; an aborted request cancels.
  const l2 = links.during('codex', () => new Promise((r) => setTimeout(r, 20)));
  const ac = new AbortController();
  const a2 = links.request('codex', params, ac.signal);
  ac.abort();
  assert.deepEqual(await a2, { action: 'cancel' });
  await l2;
  // elicitation/complete for the link.
  const l3 = links.during('codex', () => new Promise((r) => setTimeout(r, 20)));
  const a3 = links.request('codex', params);
  assert.equal(links.complete('e1'), true);
  assert.deepEqual(await a3, { action: 'accept' });
  assert.equal(links.complete('nope'), false);
  await l3;
});

// ---------------------------------------------------------------- service (mock host)

await test('service: auth details, loginWithVars (restart + authenticate, values never echoed), MCP status + events', async () => {
  const sec = memSecrets();
  const events = [];
  SVC.initAcpConfigService({ secrets: sec, emit: (c, p) => events.push([c, p]) });
  const calls = [];
  let restarted = 0;
  const RAW = [
    { id: 'chat-gpt', name: 'ChatGPT' },
    { id: 'api-key', name: 'API Key', _meta: { 'api-key': { provider: 'openai' } } },
  ];
  const conn = {
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'auth/status') return { state: 'unauthenticated' };
      if (method === 'authenticate' && params._meta?.['api-key']?.apiKey === 'bad-key-0000') throw new Error('Invalid key bad-key-0000 rejected');
      return {};
    },
  };
  SVC.setAcpConfigHost({
    connection: async () => ({ conn, caps: { auth: { logout: {}, status: {} }, providers: {} } }),
    rawAuthMethods: () => RAW,
    restartAgent: async () => void restarted++,
  });
  const d = await SVC.authDetails('codex');
  assert.deepEqual(d.methods.map((m) => m.flow), ['agent', 'api-key']);
  assert.equal(d.canLogout, true);
  assert.equal(d.canCheckStatus, true);
  assert.equal(d.info.state, 'unauthenticated');
  await assert.rejects(SVC.loginWithVars('codex', 'api-key', {}), /Enter API key/);
  await assert.rejects(SVC.loginWithVars('codex', 'chat-gpt', {}), /does not take keys/);
  await assert.rejects(SVC.loginWithVars('codex', 'api-key', { CODEX_API_KEY: 'bad-key-0000' }), (e) => !e.message.includes('bad-key-0000'));
  const ok = await SVC.loginWithVars('codex', 'api-key', { CODEX_API_KEY: 'sk-good-1111' });
  assert.deepEqual(ok.savedVars, ['CODEX_API_KEY']);
  assert.equal(JSON.stringify(ok).includes('sk-good-1111'), false);
  assert.equal(restarted, 2);
  assert.deepEqual(calls.filter((c) => c[0] === 'authenticate').at(-1)[1], { methodId: 'api-key', _meta: { 'api-key': { apiKey: 'sk-good-1111' } } });
  // A later login with the field empty reuses the saved key.
  await SVC.loginWithVars('codex', 'api-key', {});
  assert.equal(calls.filter((c) => c[0] === 'authenticate').at(-1)[1]._meta['api-key'].apiKey, 'sk-good-1111');
  SVC.noteAuthStatus('codex', { authStatus: { kind: 'api_key', label: 'API key' } });
  assert.equal(SVC.authInfoFor('codex').state, 'authenticated');
  assert.ok(events.some(([c]) => c === 'auth:info'));
  SVC.mcpStatus.begin('t9', 'codex', M.describeServers([OLY], 'olympus'));
  SVC.mcpStatus.apply('t9', { name: 'olympus', state: 'failed', reason: 'x' });
  assert.equal(SVC.mcpStatusFor('t9').servers[0].state, 'failed');
  assert.equal(SVC.mcpStatusFor('nope'), null);
  assert.ok(events.filter(([c]) => c === 'mcp:status').length >= 2);
  SVC.forgetLoginVar('codex', 'CODEX_API_KEY');
  assert.equal(sec.m.size, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
