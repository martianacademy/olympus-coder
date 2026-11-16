// Unit tests for the ACP session lifecycle: src/main/acpSessions.ts (capability-gated wrappers, replay gates,
// replay → items, merge, reattach order, fork) and src/main/acpSessionService.ts (with a mock store + host),
// plus a real @agentclientprotocol/sdk client talking to an in-memory mock agent (ordering of the load replay,
// method names and param validation).
// Run: node scripts/acp-sessions.unit.mjs   (Node ≥ 23 strips the TypeScript types itself)
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
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

const S = await import(`${APP}/src/main/acpSessions.ts`);
const SVC = await import(`${APP}/src/main/acpSessionService.ts`);
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

// ---------------------------------------------------------------- fixtures

/** Capabilities as claude-agent-acp 0.107.0 / codex-acp 2.6.0 answer `initialize` (see their dist sources). */
const CLAUDE_CAPS = { loadSession: true, sessionCapabilities: { additionalDirectories: {}, close: {}, delete: {}, fork: {}, list: {}, options: {}, resume: {}, status: {}, systemPrompt: {}, title: {} } };
const CODEX_CAPS = { loadSession: true, sessionCapabilities: { resume: {}, list: {}, close: {}, delete: {}, fork: {}, title: {}, additionalDirectories: {}, systemPrompt: {} } };
const ALL_CAPS = { loadSession: true, sessionCapabilities: { ...CLAUDE_CAPS.sessionCapabilities, archive: {} } };
const NONE_CAPS = {};

/** A connection double: records requests and answers from a handler map. */
function mockConn(handlers = {}) {
  const calls = [];
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      const h = handlers[method];
      if (!h) return {};
      return typeof h === 'function' ? h(params, calls.length) : h;
    },
  };
}
const rpcError = (code, message = 'err') => Object.assign(new Error(message), { code });

// ---------------------------------------------------------------- capabilities

await test('sessionSupport reads Claude, Codex, full and empty capabilities', () => {
  const c = S.sessionSupport(CLAUDE_CAPS);
  assert.deepEqual(c, { load: true, resume: true, list: true, fork: true, close: true, delete: true, archive: false, status: true, options: true, setTitle: true, additionalDirectories: true });
  const x = S.sessionSupport(CODEX_CAPS);
  assert.equal(x.status, false);
  assert.equal(x.options, false);
  assert.equal(x.fork, true);
  assert.equal(x.setTitle, true);
  assert.equal(S.sessionSupport(ALL_CAPS).archive, true);
  assert.deepEqual(S.sessionSupport(NONE_CAPS), S.NO_SESSION_SUPPORT);
  assert.deepEqual(S.sessionSupport(undefined), S.NO_SESSION_SUPPORT);
});

await test('null capabilities and archive without list count as unsupported', () => {
  const s = S.sessionSupport({ loadSession: false, sessionCapabilities: { close: null, fork: null, archive: {} } });
  assert.equal(s.close, false);
  assert.equal(s.fork, false);
  assert.equal(s.archive, false, 'archive needs list');
  assert.equal(s.load, false);
});

// ---------------------------------------------------------------- request wrappers

await test('unsupported methods throw AcpUnsupportedError and send nothing', async () => {
  const conn = mockConn();
  const cases = [
    () => S.loadSession(conn, NONE_CAPS, { sessionId: 's', cwd: '/p' }),
    () => S.resumeSession(conn, NONE_CAPS, { sessionId: 's', cwd: '/p' }),
    () => S.forkSession(conn, NONE_CAPS, { sessionId: 's', cwd: '/p' }),
    () => S.closeSession(conn, NONE_CAPS, 's'),
    () => S.deleteSession(conn, NONE_CAPS, 's'),
    () => S.archiveSession(conn, CLAUDE_CAPS, 's', true),
    () => S.setSessionTitle(conn, NONE_CAPS, 's', 'x'),
    () => S.sessionOptions(conn, CODEX_CAPS, { cwd: '/p' }),
    () => S.listSessionsPage(conn, NONE_CAPS, {}),
  ];
  for (const run of cases) await assert.rejects(run(), S.AcpUnsupportedError);
  assert.equal(conn.calls.length, 0);
});

await test('session/load sends mcpServers always and drops unadvertised fields', async () => {
  const conn = mockConn({ 'session/load': { configOptions: [] } });
  const caps = { loadSession: true, sessionCapabilities: {} };
  await S.loadSession(conn, caps, { sessionId: 's1', cwd: '/p', additionalDirectories: ['/mem'], configOptions: [{ configId: 'model', value: 'x' }] });
  assert.deepEqual(conn.calls[0], { method: 'session/load', params: { sessionId: 's1', cwd: '/p', mcpServers: [] } });
  await S.loadSession(conn, ALL_CAPS, { sessionId: 's1', cwd: '/p', mcpServers: [{ name: 'olympus' }], additionalDirectories: ['/mem'], configOptions: [{ configId: 'model', value: 'x' }], systemPrompt: { text: 'g' }, _meta: { a: 1 } });
  assert.deepEqual(conn.calls[1].params, { sessionId: 's1', cwd: '/p', mcpServers: [{ name: 'olympus' }], additionalDirectories: ['/mem'], systemPrompt: { text: 'g' }, configOptions: [{ configId: 'model', value: 'x' }], _meta: { a: 1 } });
});

await test('session/fork returns the new id, never sends configOptions, rejects a missing id', async () => {
  const conn = mockConn({ 'session/fork': { sessionId: 'forked', configOptions: [] } });
  const r = await S.forkSession(conn, ALL_CAPS, { sessionId: 'src', cwd: '/p', configOptions: [{ configId: 'm', value: 'v' }], mcpServers: [] });
  assert.equal(r.sessionId, 'forked');
  assert.equal(conn.calls[0].method, 'session/fork');
  assert.equal('configOptions' in conn.calls[0].params, false);
  const bad = mockConn({ 'session/fork': {} });
  await assert.rejects(S.forkSession(bad, ALL_CAPS, { sessionId: 'src', cwd: '/p' }), /without a session id/);
});

await test('close / delete / archive / unarchive send the right methods', async () => {
  const conn = mockConn();
  await S.closeSession(conn, CLAUDE_CAPS, 'a');
  await S.deleteSession(conn, CLAUDE_CAPS, 'b');
  await S.archiveSession(conn, ALL_CAPS, 'c', true);
  await S.archiveSession(conn, ALL_CAPS, 'c', false);
  assert.deepEqual(conn.calls.map((c) => [c.method, c.params.sessionId]), [['session/close', 'a'], ['session/delete', 'b'], ['session/archive', 'c'], ['session/unarchive', 'c']]);
});

await test('set_title trims, returns the stored title, rejects empty', async () => {
  const conn = mockConn({ 'session/set_title': (p) => ({ title: p.title.slice(0, 5) }) });
  assert.equal(await S.setSessionTitle(conn, CLAUDE_CAPS, 's', '  Hello world  '), 'Hello');
  assert.equal(conn.calls[0].params.title, 'Hello world');
  await assert.rejects(S.setSessionTitle(conn, CLAUDE_CAPS, 's', '   '), /cannot be empty/);
  const noTitle = mockConn({ 'session/set_title': {} });
  assert.equal(await S.setSessionTitle(noTitle, CLAUDE_CAPS, 's', 'Kept'), 'Kept');
});

await test('session/status folds to open / saved / missing / unknown', async () => {
  assert.equal(await S.sessionStatus(mockConn({ 'session/status': { status: 'open' } }), CLAUDE_CAPS, 's'), 'open');
  assert.equal(await S.sessionStatus(mockConn({ 'session/status': { status: 'saved' } }), CLAUDE_CAPS, 's'), 'saved');
  assert.equal(await S.sessionStatus(mockConn({ 'session/status': { status: 'hibernating' } }), CLAUDE_CAPS, 's'), 'saved', 'unknown values read as saved');
  assert.equal(await S.sessionStatus(mockConn({ 'session/status': () => Promise.reject(rpcError(-32002)) }), CLAUDE_CAPS, 's'), 'missing');
  assert.equal(await S.sessionStatus(mockConn({ 'session/status': () => Promise.reject(rpcError(-32603)) }), CLAUDE_CAPS, 's'), 'unknown');
  const conn = mockConn();
  assert.equal(await S.sessionStatus(conn, CODEX_CAPS, 's'), 'unknown');
  assert.equal(conn.calls.length, 0, 'no request without the capability');
});

await test('session/options sends sessionId only when load/resume is supported', async () => {
  const conn = mockConn({ 'session/options': { configOptions: [{ id: 'model' }] } });
  const r = await S.sessionOptions(conn, CLAUDE_CAPS, { cwd: '/p', sessionId: 's', additionalDirectories: ['/m'] });
  assert.deepEqual(conn.calls[0].params, { cwd: '/p', additionalDirectories: ['/m'], sessionId: 's' });
  assert.equal(r.configOptions.length, 1);
  const optsOnly = { sessionCapabilities: { options: {} } };
  await S.sessionOptions(conn, optsOnly, { cwd: '/p', sessionId: 's', additionalDirectories: ['/m'] });
  assert.deepEqual(conn.calls[1].params, { cwd: '/p' });
});

// ---------------------------------------------------------------- list + paging

await test('list page maps SessionInfo, sends archived only with the capability', async () => {
  const conn = mockConn({
    'session/list': {
      sessions: [
        { sessionId: 'a', cwd: '/p', title: '  Fix   the build ', updatedAt: '2026-11-15T10:00:00Z', archived: false },
        { sessionId: 'b', cwd: '/p', title: null },
        { cwd: '/p', title: 'no id' },
      ],
      nextCursor: 'c2',
    },
  });
  const r = await S.listSessionsPage(conn, ALL_CAPS, { cwd: '/p', archived: 'only' });
  assert.deepEqual(conn.calls[0].params, { cwd: '/p', archived: 'only' });
  assert.equal(r.sessions.length, 2);
  assert.equal(r.sessions[0].title, 'Fix the build');
  assert.equal(r.sessions[0].updatedAt, Date.parse('2026-11-15T10:00:00Z'));
  assert.equal(r.sessions[0].archived, false);
  assert.equal(r.sessions[1].title, 'Untitled session');
  assert.equal(r.nextCursor, 'c2');
  await S.listSessionsPage(conn, CLAUDE_CAPS, { cwd: '/p', archived: 'only', cursor: 'c2' });
  assert.deepEqual(conn.calls[1].params, { cwd: '/p', cursor: 'c2' }, 'no archived filter without archive');
  await S.listSessionsPage(conn, ALL_CAPS, { archived: 'exclude' });
  assert.deepEqual(conn.calls[2].params, {}, 'exclude is the default and is not sent');
});

await test('listAllSessions follows cursors, dedupes, stops on a repeated cursor and at maxPages', async () => {
  const pages = { undefined: { sessions: [{ sessionId: '1', cwd: '/p' }, { sessionId: '2', cwd: '/p' }], nextCursor: 'p2' }, p2: { sessions: [{ sessionId: '2', cwd: '/p' }, { sessionId: '3', cwd: '/p' }], nextCursor: 'p3' }, p3: { sessions: [{ sessionId: '4', cwd: '/p' }] } };
  const conn = mockConn({ 'session/list': (p) => pages[String(p.cursor)] });
  const r = await S.listAllSessions(conn, CLAUDE_CAPS, { cwd: '/p' });
  assert.deepEqual(r.sessions.map((s) => s.sessionId), ['1', '2', '3', '4']);
  assert.equal(r.truncated, false);
  const loop = mockConn({ 'session/list': { sessions: [{ sessionId: 'x', cwd: '/p' }], nextCursor: 'same' } });
  const l = await S.listAllSessions(loop, CLAUDE_CAPS, {});
  assert.equal(loop.calls.length, 2, 'a cursor that does not advance stops paging');
  assert.equal(l.truncated, false);
  let n = 0;
  const endless = mockConn({ 'session/list': () => ({ sessions: [{ sessionId: `s${n}`, cwd: '/p' }], nextCursor: `c${++n}` }) });
  const e = await S.listAllSessions(endless, CLAUDE_CAPS, { maxPages: 3 });
  assert.equal(e.sessions.length, 3);
  assert.equal(e.truncated, true);
});

await test('bestEffort reports done / unsupported / failed / timeout', async () => {
  assert.equal(await S.bestEffort(async () => {}), 'done');
  assert.equal(await S.bestEffort(() => S.closeSession(mockConn(), NONE_CAPS, 's')), 'unsupported');
  assert.equal(await S.bestEffort(async () => Promise.reject(new Error('x'))), 'failed');
  const t0 = Date.now();
  assert.equal(await S.bestEffort(() => new Promise(() => {}), 40), 'failed');
  assert.ok(Date.now() - t0 < 1000);
});

// ---------------------------------------------------------------- reattach + fork

await test('reattachOrder prefers resume, load for an empty chat, nothing when missing', () => {
  const claude = S.sessionSupport(CLAUDE_CAPS);
  assert.deepEqual(S.reattachOrder(claude, {}), []);
  assert.deepEqual(S.reattachOrder(claude, { previous: 's' }), ['resume', 'load']);
  assert.deepEqual(S.reattachOrder(claude, { previous: 's', wantHistory: true }), ['load', 'resume']);
  assert.deepEqual(S.reattachOrder(claude, { previous: 's', status: 'missing' }), []);
  assert.deepEqual(S.reattachOrder(S.sessionSupport({ loadSession: true }), { previous: 's' }), ['load']);
  assert.deepEqual(S.reattachOrder(S.sessionSupport({ sessionCapabilities: { resume: {} } }), { previous: 's', wantHistory: true }), ['resume']);
  assert.deepEqual(S.reattachOrder(S.NO_SESSION_SUPPORT, { previous: 's' }), []);
});

await test('canForkNatively only at the end of what the agent saw', () => {
  const items = [
    { kind: 'user', id: 'u1' },
    { kind: 'agent', id: 'a1' },
    { kind: 'tool', id: 't1' },
    { kind: 'error', id: 'e1' },
    { kind: 'permission', id: 'p1' },
  ];
  assert.equal(S.canForkNatively(items), true);
  assert.equal(S.canForkNatively(items, 't1'), true, 'only non-context items after it');
  assert.equal(S.canForkNatively(items, 'e1'), true);
  assert.equal(S.canForkNatively(items, 'a1'), false);
  assert.equal(S.canForkNatively(items, 'u1'), false);
  assert.equal(S.canForkNatively(items, 'nope'), false);
});

await test('fork sources are taken once and only by the same agent', () => {
  S.noteForkSource('child', { agentId: 'claude', sessionId: 'src' });
  assert.equal(S.takeForkSource('child', 'codex'), undefined, 'another agent drops it');
  assert.equal(S.peekForkSource('child'), undefined);
  S.noteForkSource('child2', { agentId: 'claude', sessionId: 'src' });
  assert.deepEqual(S.takeForkSource('child2', 'claude'), { agentId: 'claude', sessionId: 'src' });
  assert.equal(S.takeForkSource('child2', 'claude'), undefined);
});

// ---------------------------------------------------------------- replay gates

const MARKER = { sessionUpdate: 'session_info_update', _meta: { jetbrains: { air: { loadReplayEnd: true } } } };

await test('ReplayGates hold history, pass state updates, stop at the end marker', () => {
  const g = new S.ReplayGates();
  assert.equal(g.offer('s1', { sessionUpdate: 'agent_message_chunk' }), false, 'no gate open');
  g.begin('s1');
  assert.equal(g.isOpen('s1'), true);
  assert.equal(g.offer('s1', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } }), true);
  assert.equal(g.offer('s1', { sessionUpdate: 'tool_call', toolCallId: 't' }), true);
  assert.equal(g.offer('s1', { sessionUpdate: 'some_future_update' }), true, 'unknown kinds are history too');
  assert.equal(g.offer('s1', { sessionUpdate: 'available_commands_update' }), false);
  assert.equal(g.offer('s1', { sessionUpdate: 'usage_update' }), false);
  assert.equal(g.offer('s1', { sessionUpdate: 'session_info_update', title: 'T' }), false);
  assert.equal(g.offer('s2', { sessionUpdate: 'agent_message_chunk' }), false, 'other sessions pass');
  assert.equal(g.offer(undefined, { sessionUpdate: 'agent_message_chunk' }), false);
  assert.equal(g.offer('s1', MARKER), true, 'the marker itself is swallowed');
  assert.equal(g.offer('s1', { sessionUpdate: 'agent_message_chunk' }), false, 'live after the marker');
  const held = g.end('s1');
  assert.equal(held.length, 3);
  assert.equal(g.isOpen('s1'), false);
  assert.deepEqual(g.end('s1'), []);
});

await test('loadWithReplay closes the gate on success and on failure', async () => {
  const g = new S.ReplayGates();
  const conn = mockConn({
    'session/load': () => {
      g.offer('s', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old' } });
      return { configOptions: [] };
    },
  });
  const r = await S.loadWithReplay(conn, CLAUDE_CAPS, { sessionId: 's', cwd: '/p' }, g);
  assert.equal(r.updates.length, 1);
  assert.equal(g.isOpen('s'), false);
  const bad = mockConn({ 'session/load': () => Promise.reject(rpcError(-32002)) });
  await assert.rejects(S.loadWithReplay(bad, CLAUDE_CAPS, { sessionId: 's', cwd: '/p' }, g));
  assert.equal(g.isOpen('s'), false);
});

// ---------------------------------------------------------------- replay → items

const txt = (text) => ({ type: 'text', text });

await test('replayToItems joins chunks, splits on messageId, maps tools and plans', () => {
  const items = S.replayToItems(
    [
      { sessionUpdate: 'user_message_chunk', content: txt('Fix ') },
      { sessionUpdate: 'user_message_chunk', content: txt('the bug') },
      { sessionUpdate: 'agent_thought_chunk', content: txt('thinking') },
      { sessionUpdate: 'agent_message_chunk', content: txt('Sure. '), messageId: 'm1' },
      { sessionUpdate: 'agent_message_chunk', content: txt('Looking.'), messageId: 'm1' },
      { sessionUpdate: 'agent_message_chunk', content: txt('Second message'), messageId: 'm2' },
      { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Read file', kind: 'read', status: 'pending', locations: [{ path: '/p/a.ts', line: 3 }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed', content: [{ type: 'content', content: txt('file body') }] },
      { sessionUpdate: 'tool_call', toolCallId: 'tc2', title: 'Run', kind: 'execute', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'ghost', status: 'completed' },
      { sessionUpdate: 'plan', entries: [{ content: 'a', status: 'pending', priority: 'high' }] },
      { sessionUpdate: 'plan', entries: [{ content: 'a', status: 'completed', priority: 'high' }, { content: 'b', status: 'weird' }] },
      { sessionUpdate: 'agent_message_chunk', content: txt('Done.') },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: '' } },
      { sessionUpdate: 'agent_message_chunk', content: txt('') },
    ],
    'claude',
    { startTs: 1000 },
  );
  assert.deepEqual(items.map((i) => i.kind), ['user', 'thought', 'agent', 'agent', 'tool', 'tool', 'plan', 'agent']);
  assert.equal(items[0].text, 'Fix the bug');
  assert.equal(items[2].text, 'Sure. Looking.');
  assert.equal(items[3].text, 'Second message');
  assert.equal(items[4].status, 'completed');
  assert.deepEqual(items[4].locations, ['/p/a.ts']);
  assert.equal(items[4].content[0].text, 'file body');
  assert.equal(items[5].status, 'interrupted', 'open tools at the end are interrupted');
  assert.deepEqual(items[6].entries, [{ content: 'a', status: 'completed', priority: 'high' }, { content: 'b', status: 'pending' }]);
  assert.equal(items[7].text, 'Done.[image]');
  assert.ok(items.every((i, n) => n === 0 || i.ts > items[n - 1].ts), 'timestamps keep order');
  assert.ok(items.every((i) => i.agentId === 'claude' && typeof i.id === 'string'));
});

await test('replayToItems uses a custom mapper', () => {
  const items = S.replayToItems([{ sessionUpdate: 'tool_call', toolCallId: 't', title: 'raw', rawInput: { command: 'ls' } }], 'codex', {
    mapper: { ...S.DEFAULT_REPLAY_MAPPER, toolTitle: (t, raw) => `${t}:${raw.command}`, toolSummary: () => 'sum' },
  });
  assert.equal(items[0].title, 'raw:ls');
  assert.equal(items[0].summary, 'sum');
});

// ---------------------------------------------------------------- merge

let idn = 0;
const U = (text) => ({ kind: 'user', id: `u${idn++}`, agentId: 'claude', text, ts: idn });
const A = (text) => ({ kind: 'agent', id: `a${idn++}`, agentId: 'claude', text, ts: idn });
const T = (toolCallId) => ({ kind: 'tool', id: `t${idn++}`, agentId: 'claude', toolCallId, title: 'x', status: 'completed', content: [], locations: [], ts: idn });

await test('mergeReplay: an empty chat takes the whole replay', () => {
  const replayed = [U('hi'), A('hello')];
  assert.equal(S.mergeReplay([], replayed), replayed);
  assert.equal(S.mergeReplay([{ kind: 'error', id: 'e', agentId: 'claude', text: 'x', ts: 1 }], replayed), replayed);
});

await test('mergeReplay: the same history adds nothing (no duplicates)', () => {
  const chat = [U('Fix the bug'), A('Sure.'), T('tc1'), A('Done.')];
  const replayed = [U('[Olympus Coder] context…\n\nFix the bug\n\nAttached files:\n- a.png'), A('Sure.'), T('tc1'), A('Done.')];
  assert.deepEqual(S.mergeReplay(chat, replayed), []);
});

await test('mergeReplay: only work after the last known item is added', () => {
  const chat = [U('Fix the bug'), A('Sure.'), T('tc1'), A('Done')];
  const replayed = [U('Fix the bug'), A('Sure.'), T('tc1'), A('Done, all tests pass.'), T('tc9'), A('Background job finished.')];
  const add = S.mergeReplay(chat, replayed);
  assert.deepEqual(add.map((i) => i.kind), ['tool', 'agent']);
  assert.equal(add[0].toolCallId, 'tc9');
});

await test('mergeReplay: a replay that matches nothing in a non-empty chat adds nothing', () => {
  assert.deepEqual(S.mergeReplay([U('alpha'), A('beta')], [U('gamma'), A('delta')]), []);
});

// ---------------------------------------------------------------- real SDK client ↔ in-memory mock agent

/** A tiny ACP agent on in-memory streams: answers with `handler(method, params, notify)`. */
function memoryAgent(handler) {
  const toAgent = new TransformStream();
  const toClient = new TransformStream();
  const enc = new TextEncoder();
  const writer = toClient.writable.getWriter();
  const send = (msg) => writer.write(enc.encode(JSON.stringify(msg) + '\n'));
  const received = [];
  (async () => {
    const reader = toAgent.readable.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += value;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        received.push(msg);
        if (msg.id === undefined) continue;
        const notify = (update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params.sessionId, update } });
        try {
          const result = await handler(msg.method, msg.params, notify);
          await send({ jsonrpc: '2.0', id: msg.id, result: result ?? {} });
        } catch (e) {
          await send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32603, message: e.message } });
        }
      }
    }
  })();
  return { stream: SDK.ndJsonStream(toAgent.writable, toClient.readable), received };
}

await test('SDK: load replay arrives before the answer; gates hold it, state updates pass', async () => {
  const gates = new S.ReplayGates();
  const routed = [];
  const agent = memoryAgent(async (method, params, notify) => {
    if (method === 'session/load') {
      await notify({ sessionUpdate: 'user_message_chunk', content: txt('Old question') });
      await notify({ sessionUpdate: 'agent_message_chunk', content: txt('Old answer') });
      await notify({ sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Read', status: 'completed' });
      await notify({ sessionUpdate: 'available_commands_update', availableCommands: [] });
      await notify(MARKER);
      return { configOptions: [] };
    }
    return {};
  });
  const conn = SDK.client({ name: 'unit' })
    .onNotification(SDK.methods.client.session.update, ({ params }) => {
      if (gates.offer(params.sessionId, params.update)) return;
      routed.push(params.update.sessionUpdate);
    })
    .connect(agent.stream);
  const r = await S.loadWithReplay(conn.agent, CLAUDE_CAPS, { sessionId: 'sess-1', cwd: '/tmp/p' }, gates);
  assert.deepEqual(r.updates.map((u) => u.sessionUpdate), ['user_message_chunk', 'agent_message_chunk', 'tool_call']);
  assert.deepEqual(routed, ['available_commands_update']);
  const items = S.replayToItems(r.updates, 'claude');
  assert.deepEqual(items.map((i) => i.kind), ['user', 'agent', 'tool']);
  conn.close?.();
});

await test('SDK: list / fork / close / delete / archive / status / options / set_title pass the SDK validators', async () => {
  const agent = memoryAgent(async (method, params) => {
    switch (method) {
      case 'session/list':
        return params.cursor ? { sessions: [{ sessionId: 'b', cwd: '/tmp/p', title: 'B' }] } : { sessions: [{ sessionId: 'a', cwd: '/tmp/p', title: 'A', updatedAt: '2026-11-16T00:00:00Z', archived: false }], nextCursor: 'n1' };
      case 'session/fork':
        return { sessionId: 'forked-1' };
      case 'session/status':
        if (params.sessionId === 'gone') throw Object.assign(new Error('Session not found'), { code: -32002 });
        return { status: 'saved' };
      case 'session/options':
        return { configOptions: [{ id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: 'opus', options: [{ value: 'opus', name: 'Opus' }] }] };
      case 'session/set_title':
        return { title: params.title.toUpperCase() };
      default:
        return {};
    }
  });
  const conn = SDK.client({ name: 'unit' }).connect(agent.stream);
  const all = await S.listAllSessions(conn.agent, ALL_CAPS, { cwd: '/tmp/p', archived: 'include' });
  assert.deepEqual(all.sessions.map((s) => s.sessionId), ['a', 'b']);
  assert.equal((await S.forkSession(conn.agent, ALL_CAPS, { sessionId: 'a', cwd: '/tmp/p', mcpServers: [] })).sessionId, 'forked-1');
  await S.closeSession(conn.agent, ALL_CAPS, 'a');
  await S.deleteSession(conn.agent, ALL_CAPS, 'b');
  await S.archiveSession(conn.agent, ALL_CAPS, 'a', true);
  await S.archiveSession(conn.agent, ALL_CAPS, 'a', false);
  assert.equal(await S.sessionStatus(conn.agent, ALL_CAPS, 'a'), 'saved');
  assert.equal(await S.sessionStatus(conn.agent, ALL_CAPS, 'gone'), 'missing');
  assert.equal((await S.sessionOptions(conn.agent, ALL_CAPS, { cwd: '/tmp/p' })).configOptions[0].id, 'model');
  assert.equal(await S.setSessionTitle(conn.agent, ALL_CAPS, 'a', 'renamed'), 'RENAMED');
  const methods = agent.received.map((m) => m.method);
  for (const m of ['session/list', 'session/fork', 'session/close', 'session/delete', 'session/archive', 'session/unarchive', 'session/status', 'session/options', 'session/set_title']) assert.ok(methods.includes(m), `${m} sent`);
  assert.deepEqual(agent.received.find((m) => m.method === 'session/list').params, { cwd: '/tmp/p', archived: 'include' });
  conn.close?.();
});

// ---------------------------------------------------------------- service (mock store + host)

function serviceFixture({ caps = ALL_CAPS, handlers = {}, running = true } = {}) {
  const threads = new Map();
  const project = { id: 'p1', name: 'Proj', path: '/tmp/p', createdAt: 0 };
  let settings = { agentDefaults: { claude: { model: 'sonnet' } } };
  let n = 0;
  const store = {
    getProject: (id) => (id === 'p1' ? project : undefined),
    findThread: (id) => threads.get(id),
    listThreads: (pid) => [...threads.values()].filter((t) => t.projectId === pid).map(({ items, acpSessions, ...m }) => m),
    getThread: (_pid, id) => threads.get(id),
    createThread: (projectId, agentId, extra = {}) => {
      const t = { id: `t${++n}`, projectId, agentId, title: 'New chat', createdAt: 0, updatedAt: 0, items: [], acpSessions: {}, ...extra };
      threads.set(t.id, t);
      return t;
    },
    forkThread: (parent, upto) => store.createThread(parent.projectId, parent.agentId, { title: `↳ ${parent.title}`, parentId: parent.id, items: structuredClone(parent.items) }),
    saveThreadNow: () => {},
    threadMeta: ({ items, acpSessions, ...m }) => m,
    flushThreads: () => {},
    getSettings: () => settings,
    updateSettings: (patch) => (settings = { ...settings, ...patch }),
  };
  const conn = mockConn(handlers);
  const ensured = [];
  SVC.initAcpSessionService({ store, ensureSession: async (id) => (ensured.push(id), true), knownOptions: () => [{ id: 'model', name: 'Model', category: 'model', currentValue: 'opus', options: [{ value: 'opus', name: 'Opus' }, { value: 'sonnet', name: 'Sonnet' }] }] });
  const started = [];
  SVC.setAcpSessionHost({
    connection: async (agentId, start) => {
      if (start) started.push(agentId);
      return running || start ? { conn, caps } : null;
    },
    configView: (res) => (res.configOptions ?? []).map((o) => ({ id: o.id, name: o.name, category: o.category, currentValue: o.currentValue, options: o.options })),
  });
  return { store, threads, conn, ensured, started, get settings() { return settings; } };
}

await test('service: listNative marks bound chats, filters other folders, passes cursor + archived', async () => {
  const f = serviceFixture({
    handlers: {
      'session/list': { sessions: [{ sessionId: 's1', cwd: '/tmp/p', title: 'One' }, { sessionId: 's2', cwd: '/tmp/p', title: 'Two' }, { sessionId: 's3', cwd: '/elsewhere', title: 'Other' }], nextCursor: 'c' },
    },
  });
  const bound = f.store.createThread('p1', 'claude', { acpSessions: { claude: 's2' } });
  const page = await SVC.listNative('p1', 'claude', { cursor: 'x', archived: 'only' });
  assert.deepEqual(f.conn.calls[0].params, { cwd: '/tmp/p', cursor: 'x', archived: 'only' });
  assert.deepEqual(page.sessions.map((s) => [s.sessionId, s.threadId]), [['s1', undefined], ['s2', bound.id]]);
  assert.equal(page.nextCursor, 'c');
  await assert.rejects(SVC.listNative('nope', 'claude'), /Project not found/);
});

await test('service: listNative on an agent without list returns an empty page with its support', async () => {
  serviceFixture({ caps: CODEX_CAPS });
  const r = await SVC.listNative('p1', 'codex');
  assert.equal(r.support.list, true);
  serviceFixture({ caps: NONE_CAPS });
  const none = await SVC.listNative('p1', 'x');
  assert.equal(none.support.list, false);
  assert.deepEqual(none.sessions, []);
});

await test('service: importNative binds a new chat, reuses a bound one, unarchives first', async () => {
  const f = serviceFixture();
  const meta = await SVC.importNative('p1', 'claude', { sessionId: 'native-1', title: '  Refactor   auth  ', archived: true });
  const t = f.threads.get(meta.id);
  assert.deepEqual(t.acpSessions, { claude: 'native-1' });
  assert.equal(t.title, 'Refactor auth');
  assert.equal(f.conn.calls[0].method, 'session/unarchive');
  assert.deepEqual(f.ensured, [meta.id]);
  const again = await SVC.importNative('p1', 'claude', { sessionId: 'native-1', title: 'x' });
  assert.equal(again.id, meta.id, 'the same session opens the same chat');
  assert.equal(f.threads.size, 1);
});

await test('service: delete chat closes by default, deletes only on opt-in', async () => {
  const f = serviceFixture();
  const t = f.store.createThread('p1', 'claude', { acpSessions: { claude: 'sc', codex: 'sx' } });
  const closed = await SVC.beforeDeleteChat(t.id, false);
  assert.deepEqual(closed, { claude: 'done', codex: 'done' });
  assert.deepEqual(f.conn.calls.map((c) => c.method), ['session/close', 'session/close']);
  f.conn.calls.length = 0;
  const deleted = await SVC.beforeDeleteChat(t.id, true);
  assert.deepEqual(deleted, { claude: 'done', codex: 'done' });
  assert.deepEqual(f.conn.calls.map((c) => [c.method, c.params.sessionId]), [['session/delete', 'sc'], ['session/delete', 'sx']]);
});

await test('service: delete opt-in on an agent without delete falls back to close', async () => {
  const f = serviceFixture({ caps: { sessionCapabilities: { close: {} } } });
  const t = f.store.createThread('p1', 'claude', { acpSessions: { claude: 'sc' } });
  assert.deepEqual(await SVC.beforeDeleteChat(t.id, true), { claude: 'unsupported' });
  assert.deepEqual(f.conn.calls.map((c) => c.method), ['session/close']);
});

await test('service: deletableSessions hides agents known not to delete', async () => {
  const f = serviceFixture({ caps: CODEX_CAPS });
  const t = f.store.createThread('p1', 'codex', { acpSessions: { codex: 'sx' } });
  assert.deepEqual(await SVC.deletableSessions(t.id), [{ agentId: 'codex', sessionId: 'sx', canDelete: true }]);
  const g = serviceFixture({ caps: { sessionCapabilities: { close: {} } } });
  const t2 = g.store.createThread('p1', 'x', { acpSessions: { x: 's' } });
  assert.deepEqual(await SVC.deletableSessions(t2.id), []);
  const h = serviceFixture({ running: false });
  const t3 = h.store.createThread('p1', 'claude', { acpSessions: { claude: 's' } });
  assert.deepEqual(await SVC.deletableSessions(t3.id), [{ agentId: 'claude', sessionId: 's' }], 'not running: offered, support unknown');
});

await test('service: syncTitle stores the current agent title, skips agents that are not running', async () => {
  const f = serviceFixture({ handlers: { 'session/set_title': (p) => ({ title: `${p.title}!` }) } });
  const t = f.store.createThread('p1', 'claude', { title: 'Old', acpSessions: { claude: 'sc' } });
  t.title = 'New name';
  const r = await SVC.syncTitle(t.id, 'New name');
  assert.equal(r.title, 'New name!');
  assert.equal(t.title, 'New name!');
  const g = serviceFixture({ running: false });
  const t2 = g.store.createThread('p1', 'claude', { acpSessions: { claude: 'sc' } });
  const r2 = await SVC.syncTitle(t2.id, 'Name');
  assert.deepEqual(r2, { title: 'Name', results: { claude: 'not-running' } });
  assert.deepEqual(g.started, [], 'rename never starts an agent');
});

await test('service: forkChat marks a native fork only at the end of the chat', () => {
  const f = serviceFixture();
  const parent = f.store.createThread('p1', 'claude', { title: 'Main', acpSessions: { claude: 'sp' }, items: [U('q'), A('a'), U('q2'), A('a2')] });
  const end = SVC.forkChat(parent.id);
  assert.equal(end.nativeFork, true);
  assert.deepEqual(S.takeForkSource(end.meta.id, 'claude'), { agentId: 'claude', sessionId: 'sp' });
  const mid = SVC.forkChat(parent.id, parent.items[1].id);
  assert.equal(mid.nativeFork, false);
  assert.equal(S.peekForkSource(mid.meta.id), undefined);
  const noSession = f.store.createThread('p1', 'claude', { items: [U('q')] });
  assert.equal(SVC.forkChat(noSession.id).nativeFork, false);
});

await test('service: homeOptions uses session/options with saved defaults, else known options', async () => {
  const f = serviceFixture({
    handlers: { 'session/options': { configOptions: [{ id: 'model', name: 'Model', category: 'model', currentValue: 'opus', options: [{ value: 'opus', name: 'Opus' }, { value: 'sonnet', name: 'Sonnet' }] }] } },
  });
  const r = await SVC.homeOptions('p1', 'claude');
  assert.equal(r.supported, true);
  assert.equal(r.configOptions[0].currentValue, 'sonnet', 'saved default shows');
  assert.deepEqual(f.conn.calls[0], { method: 'session/options', params: { cwd: '/tmp/p' } });
  serviceFixture({ caps: CODEX_CAPS });
  const fb = await SVC.homeOptions('p1', 'claude');
  assert.equal(fb.supported, false);
  assert.equal(fb.configOptions[0].currentValue, 'sonnet');
  const g = serviceFixture();
  SVC.setHomeOption('claude', 'effort', 'high');
  assert.deepEqual(g.settings.agentDefaults.claude, { model: 'sonnet', effort: 'high' });
});

await test('service: chatSessionStatus reports the current agent session', async () => {
  const f = serviceFixture({ handlers: { 'session/status': { status: 'open' } } });
  const t = f.store.createThread('p1', 'claude', { acpSessions: { claude: 'sc' } });
  assert.deepEqual(await SVC.chatSessionStatus(t.id), { agentId: 'claude', sessionId: 'sc', status: 'open' });
  const t2 = f.store.createThread('p1', 'claude');
  assert.deepEqual(await SVC.chatSessionStatus(t2.id), { agentId: 'claude', status: 'unknown' });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
