// Unit tests: send while busy — per-chat queue, WhatsApp-style delivery (queued → delivered → seen), "Send now"
// (steer vs stop-and-send), Stop holding the queue, persistence in the thread, and the shared helpers.
// Files: src/main/promptQueue.ts, src/shared/promptQueue.ts.
// Run: node tests/promptQueue.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; no Electron needed)
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

const Q = await import(`${APP}/src/main/promptQueue.ts`);
const SH = await import(`${APP}/src/shared/promptQueue.ts`);

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
const tick = () => new Promise((r) => setTimeout(r, 5));

/** A fake chat + agent: `busy` while a turn runs, `connected` once the CLI is up. */
function fakeHost(opts = {}) {
  const thread = { id: `t${Math.random()}`, agentId: 'claude', items: [], acpSessions: {}, ...(opts.thread ?? {}) };
  const h = {
    thread,
    busy: false,
    connected: opts.connected ?? true,
    agent: opts.connected === false ? 'unknown' : 'ready',
    session: 'idle',
    canSteer: opts.canSteer ?? false,
    steerResult: 'injected',
    connectResult: true,
    sent: [],
    steered: [],
    cancels: 0,
    connects: 0,
    saves: 0,
    pushed: [],
    views: [],
    /** Ends the running turn the way agents.ts does (turn-end listeners). */
    endTurn() {
      h.busy = false;
      Q.onTurnEnd(thread.id);
    },
  };
  h.hostObj = {
    thread: (id) => (id === thread.id ? thread : undefined),
    save: () => h.saves++,
    pushItem: (_t, item) => h.pushed.push({ ...item, delivery: item.delivery && { ...item.delivery } }),
    emit: (v) => h.views.push(v),
    agentName: () => 'Claude Code',
    busy: () => h.busy,
    connection: () => ({ agent: h.agent, session: h.session, connected: h.connected }),
    connect: async () => {
      h.connects++;
      if (h.connectResult) {
        h.connected = true;
        h.agent = 'ready';
      } else h.agent = 'needs-login';
      return h.connectResult;
    },
    // Like agents.ts deliverPrompt: busy / not connected → not sent; else the user item, with delivery set.
    send: async (_t, q) => {
      if (h.busy) return { outcome: 'busy' };
      if (!h.connected) return { outcome: 'offline' };
      const item = {
        kind: 'user',
        id: `u${thread.items.length}`,
        agentId: 'claude',
        text: q.text,
        ts: Date.now(),
        ...(q.attachments?.length ? { attachments: q.attachments } : {}),
        ...(q.fromApp ? { fromApp: true } : {}),
        delivery: { state: 'delivered', via: 'prompt', at: Date.now() },
      };
      thread.items.push(item);
      Q.observe('thread:item', { threadId: thread.id, item });
      h.sent.push(q.text);
      h.busy = true;
      return { outcome: 'sent', item, done: Promise.resolve() };
    },
    canSteer: () => h.canSteer,
    steer: async (_t, text) => {
      if (h.steerResult !== 'injected') return { outcome: h.steerResult };
      const item = { kind: 'user', id: `s${thread.items.length}`, agentId: 'claude', text, ts: Date.now(), delivery: { state: 'delivered', via: 'steer', at: Date.now() } };
      thread.items.push(item);
      Q.observe('thread:item', { threadId: thread.id, item });
      h.steered.push(text);
      return { outcome: 'injected', item };
    },
    cancel: async () => {
      h.cancels++;
      h.endTurn();
    },
  };
  Q.initPromptQueue(h.hostObj);
  return h;
}
const currentHost = (h) => h.hostObj;
const agentOut = (h, text = 'ok') => {
  const item = { kind: 'agent', id: `a${h.thread.items.length}`, agentId: 'claude', text, ts: Date.now() };
  h.thread.items.push(item);
  Q.observe('thread:item', { threadId: h.thread.id, item });
  return item;
};

await test('idle + connected: sends at once, marked delivered (two grey ticks), never shown in the strip', async () => {
  const h = fakeHost();
  assert.equal(Q.submit(h.thread.id, 'hello'), 'sent');
  assert.equal(h.views.length, 0, 'no strip flash');
  await tick();
  assert.deepEqual(h.sent, ['hello']);
  assert.equal(h.thread.queue, undefined);
  const u = h.thread.items[0];
  assert.equal(u.delivery.state, 'delivered');
  assert.equal(u.delivery.via, 'prompt');
});

await test('agent output after the message turns it seen (blue)', async () => {
  const h = fakeHost();
  Q.submit(h.thread.id, 'hello');
  await tick();
  agentOut(h);
  assert.equal(h.thread.items[0].delivery.state, 'seen');
  assert.ok(h.thread.items[0].delivery.seenAt);
  assert.equal(h.pushed.at(-1).delivery.state, 'seen');
});

await test('user / error items and output from before the message do not count as seen', async () => {
  const h = fakeHost();
  const old = agentOut(h, 'earlier reply');
  Q.submit(h.thread.id, 'hello');
  await tick();
  Q.observe('thread:item', { threadId: h.thread.id, item: old });
  const err = { kind: 'error', id: 'e', agentId: 'claude', text: 'x', ts: 1 };
  h.thread.items.push(err);
  Q.observe('thread:item', { threadId: h.thread.id, item: err });
  Q.observe('thread:item', { threadId: h.thread.id, item: h.thread.items[0] });
  assert.equal(h.thread.items[1].delivery.state, 'delivered');
});

await test('a message sent outside the queue (new chat home, chat.send) with ticks also turns blue', () => {
  const h = fakeHost();
  const u = { kind: 'user', id: 'x1', agentId: 'claude', text: 'hi', ts: 1, delivery: { state: 'delivered', via: 'prompt', at: 1 } };
  h.thread.items.push(u);
  Q.observe('thread:item', { threadId: h.thread.id, item: u });
  agentOut(h);
  assert.equal(u.delivery.state, 'seen');
});

await test('busy: queued with two ticks; goes out FIFO, one per turn end', async () => {
  const h = fakeHost();
  h.busy = true;
  assert.equal(Q.submit(h.thread.id, 'one'), 'queued');
  assert.equal(Q.submit(h.thread.id, 'two'), 'queued');
  const v = Q.view(h.thread.id);
  assert.equal(v.items.length, 2);
  assert.equal(v.items[0].ticks, 2);
  assert.equal(v.items[0].reason, 'busy');
  assert.match(v.items[0].label, /^Queued — Claude Code is connected/);
  assert.equal(v.sendNow, 'interrupt');
  assert.ok(h.saves > 0, 'queue persisted in the thread');
  h.endTurn();
  await tick();
  assert.deepEqual(h.sent, ['one']);
  assert.equal(h.thread.queue.length, 1);
  h.endTurn();
  await tick();
  assert.deepEqual(h.sent, ['one', 'two']);
  assert.equal(h.thread.queue, undefined);
});

await test('a new message waits behind older queued ones even if the chat is free', () => {
  const h = fakeHost();
  h.busy = true;
  Q.submit(h.thread.id, 'first');
  h.busy = false;
  h.connected = false;
  assert.equal(Q.submit(h.thread.id, 'second'), 'queued');
  assert.deepEqual(h.thread.queue.map((q) => q.text), ['first', 'second']);
});

await test('offline: one tick, starts the agent, delivered once it connects', async () => {
  const h = fakeHost({ connected: false });
  assert.equal(Q.submit(h.thread.id, 'hi'), 'queued');
  const v = h.views.at(-1);
  assert.equal(v.items[0].ticks, 1);
  assert.equal(v.items[0].reason, 'offline');
  assert.match(v.items[0].label, /offline/);
  await tick();
  assert.equal(h.connects, 1);
  assert.deepEqual(h.sent, ['hi']);
  assert.equal(h.thread.items[0].delivery.state, 'delivered');
});

await test('offline connect: the message stays in the strip (editable) until it really goes out', async () => {
  const h = fakeHost({ connected: false });
  let release;
  h.connectResult = true;
  const slow = new Promise((r) => (release = r));
  const orig = h.connects;
  Q.initPromptQueue({ ...currentHost(h), connect: async () => { await slow; h.connected = true; h.agent = 'ready'; return true; } });
  Q.submit(h.thread.id, 'tpyo');
  assert.equal(h.thread.queue.length, 1);
  assert.equal(Q.edit(h.thread.id, h.thread.queue[0].id, 'typo'), true);
  release();
  await tick();
  assert.deepEqual(h.sent, ['typo']);
  assert.equal(h.connects, orig);
});

await test('needs login: stays queued (one tick) until the agent reports ready', async () => {
  const h = fakeHost({ connected: false });
  h.connectResult = false;
  Q.submit(h.thread.id, 'hi');
  await tick();
  assert.equal(h.sent.length, 0);
  const v = Q.view(h.thread.id);
  assert.equal(v.items[0].reason, 'login');
  assert.equal(v.items[0].ticks, 1);
  h.agent = 'ready';
  h.connected = true;
  Q.observe('agent:status', { id: 'claude', state: 'ready' });
  await tick();
  assert.deepEqual(h.sent, ['hi']);
});

await test('restart: a queue saved in the thread goes out when the session comes up', async () => {
  const h = fakeHost({ connected: false, thread: { queue: [{ id: 'q1', text: 'saved', ts: 1 }] } });
  Q.observe('session:state', { threadId: h.thread.id, status: 'starting' });
  await tick();
  assert.equal(h.sent.length, 0);
  h.connected = true;
  Q.observe('session:state', { threadId: h.thread.id, status: 'idle' });
  await tick();
  assert.deepEqual(h.sent, ['saved']);
});

await test('startup resume: connects the agent of a chat that still had queued messages', async () => {
  const h = fakeHost({ connected: false, thread: { queue: [{ id: 'q1', text: 'from last run', ts: 1 }] } });
  Q.resumeAll([h.thread.id, 'unknown-chat']);
  await tick();
  assert.equal(h.connects, 1);
  assert.deepEqual(h.sent, ['from last run']);
});

await test('sendPrompt while busy (orchestrator / app message) queues with its sender', async () => {
  const h = fakeHost();
  h.busy = true;
  Q.enqueue(h.thread.id, 'sub-sessions finished', [], { fromApp: true });
  assert.equal(h.thread.queue[0].fromApp, true);
  h.endTurn();
  await tick();
  assert.equal(h.thread.items[0].fromApp, true);
});

await test('Send now without steering: stops the turn and sends the chosen message first', async () => {
  const h = fakeHost();
  h.busy = true;
  Q.submit(h.thread.id, 'a');
  Q.submit(h.thread.id, 'b');
  const b = h.thread.queue[1];
  assert.equal(await Q.sendNow(h.thread.id, b.id), 'interrupting');
  assert.equal(h.cancels, 1);
  await tick();
  assert.deepEqual(h.sent, ['b']);
  assert.deepEqual(h.thread.queue.map((q) => q.text), ['a']);
  assert.equal(h.thread.queue[0].urgent, undefined);
});

await test('Send now with steering: injected into the running turn, no cancel, seen on next output', async () => {
  const h = fakeHost({ canSteer: true });
  h.busy = true;
  const earlier = agentOut(h, 'working…');
  Q.submit(h.thread.id, 'also check tests');
  assert.equal(Q.view(h.thread.id).sendNow, 'steer');
  const id = h.thread.queue[0].id;
  assert.equal(await Q.sendNow(h.thread.id, id), 'steered');
  assert.equal(h.cancels, 0);
  assert.deepEqual(h.steered, ['also check tests']);
  assert.equal(h.thread.queue, undefined);
  const u = h.thread.items.find((i) => i.kind === 'user');
  assert.equal(u.delivery.via, 'steer');
  assert.equal(u.delivery.state, 'delivered');
  // Output of the item from before the steer is not the answer; the new reply below it is.
  Q.observe('thread:item', { threadId: h.thread.id, item: earlier });
  assert.equal(u.delivery.state, 'delivered');
  agentOut(h, 'ok, checking tests');
  assert.equal(u.delivery.state, 'seen');
});

await test('Send now with steering when the turn just ended (promptRequired): sent as a prompt', async () => {
  const h = fakeHost({ canSteer: true });
  h.busy = true;
  Q.submit(h.thread.id, 'x');
  h.steerResult = 'promptRequired';
  // The adapter found no running turn; by the time it answers, the chat is free.
  const id = h.thread.queue[0].id;
  const p = Q.sendNow(h.thread.id, id);
  h.busy = false;
  assert.equal(await p, 'sent');
  assert.deepEqual(h.sent, ['x']);
  assert.equal(h.cancels, 0);
});

await test('Send now with a failed steer falls back to stop-and-send', async () => {
  const h = fakeHost({ canSteer: true });
  h.busy = true;
  Q.submit(h.thread.id, 'x');
  h.steerResult = 'failed';
  assert.equal(await Q.sendNow(h.thread.id, h.thread.queue[0].id), 'interrupting');
  assert.equal(h.cancels, 1);
  await tick();
  assert.deepEqual(h.sent, ['x']);
});

await test('Stop holds the queue; sending or Send now releases it', async () => {
  const h = fakeHost();
  h.busy = true;
  Q.submit(h.thread.id, 'later');
  Q.onUserStop(h.thread.id);
  h.endTurn();
  await tick();
  assert.equal(h.sent.length, 0);
  const v = Q.view(h.thread.id);
  assert.equal(v.items[0].reason, 'held');
  assert.equal(v.items[0].ticks, 2);
  assert.equal(await Q.sendNow(h.thread.id, v.items[0].id), 'sent');
  assert.deepEqual(h.sent, ['later']);
  // A new message after Stop also releases the queue (older ones first).
  h.busy = true;
  Q.submit(h.thread.id, 'q2');
  Q.onUserStop(h.thread.id);
  h.endTurn();
  await tick();
  assert.deepEqual(h.sent, ['later']);
  Q.submit(h.thread.id, 'q3');
  await tick();
  assert.deepEqual(h.sent, ['later', 'q2']);
});

await test('edit and remove before it goes out', () => {
  const h = fakeHost();
  h.busy = true;
  Q.submit(h.thread.id, 'typo');
  Q.submit(h.thread.id, 'drop me');
  const [a, b] = h.thread.queue;
  assert.equal(Q.edit(h.thread.id, a.id, '  fixed  '), true);
  assert.equal(h.thread.queue[0].text, 'fixed');
  assert.equal(Q.edit(h.thread.id, a.id, '   '), false);
  assert.equal(Q.remove(h.thread.id, b.id).text, 'drop me');
  assert.equal(Q.remove(h.thread.id, 'nope'), undefined);
  assert.deepEqual(h.thread.queue.map((q) => q.text), ['fixed']);
  assert.equal(Q.edit(h.thread.id, 'nope', 'x'), false);
});

await test('attachments travel with a queued message', async () => {
  const h = fakeHost();
  h.busy = true;
  const files = [{ path: '/tmp/a.png', name: 'a.png', mime: 'image/png', size: 1 }];
  Q.submit(h.thread.id, '', files);
  assert.deepEqual(h.thread.queue[0].attachments, files);
  h.endTurn();
  await tick();
  assert.deepEqual(h.thread.items[0].attachments, files);
});

await test('observe never throws on odd payloads', () => {
  fakeHost();
  Q.observe('thread:item', null);
  Q.observe('session:state', {});
  Q.observe('agent:status', undefined);
});

await test('shared helpers: steering capability, steer outcome, reasons, labels', () => {
  assert.equal(SH.steeringSupported({ _meta: { steering: { supported: true } } }), true);
  assert.equal(SH.steeringSupported({ _meta: { antigravity: { tier: true } } }), false);
  assert.equal(SH.steeringSupported(undefined), false);
  assert.equal(SH.steerOutcome({ outcome: 'injected' }), 'injected');
  assert.equal(SH.steerOutcome({ outcome: 'startedNewTurn' }), 'injected');
  assert.equal(SH.steerOutcome({ outcome: 'promptRequired', reason: 'noRunningTurn' }), 'promptRequired');
  assert.equal(SH.steerOutcome({ outcome: 'failed' }), 'failed');
  assert.equal(SH.steerOutcome(null), 'failed');
  assert.deepEqual(SH.steerParams('s1', [{ type: 'text', text: 'x' }])._meta, { steering: { idleBehavior: 'promptRequired' } });
  assert.equal(SH.queueReason('needs-login', 'idle', false), 'login');
  assert.equal(SH.queueReason('ready', 'starting', false), 'starting');
  assert.equal(SH.queueReason('not-installed', 'idle', false), 'error');
  assert.equal(SH.queueReason('unknown', 'idle', false), 'offline');
  assert.equal(SH.queueReason('ready', 'running', true), 'busy');
  assert.match(SH.deliveryLabel({ state: 'seen', via: 'prompt', at: 1 }, 'Codex'), /^Seen — Codex/);
  assert.match(SH.deliveryLabel({ state: 'delivered', via: 'prompt', at: 1 }, 'Codex'), /^Delivered — Codex/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
