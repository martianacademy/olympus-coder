// Agent-initiated turns (src/main/agentInitiated.ts) driven in the SAME order as agents.ts `routeUpdate`:
// noteAgentInitiatedUpdate → beginAgentInitiatedTurn (only when idle) → the update's item is applied.
// Regression (2026-11-25): one Antigravity wake-up became a new "Agent-initiated work" bubble per step (134 in one
// chat) — the settle delay was picked before the first thought existed (2.5s), and 2.5s after a tool result is
// shorter than agy's silent thinking before its next step.
// Run: node tests/agentInitiated.unit.mjs   (AGENT_INITIATED_MODULE=<path> runs it against another copy)
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

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

process.env.OLYMPUS_IDLE_SETTLE_MS = '100';
process.env.OLYMPUS_THOUGHT_SETTLE_MS = '1500';
const modPath = process.env.AGENT_INITIATED_MODULE || new URL('../src/main/agentInitiated.ts', import.meta.url).pathname;
const AI = await import(pathToFileURL(modPath).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL  ${name}\n      ${e.message.split('\n').join('\n      ')}`);
  }
}

let events = [];
AI.initAgentInitiated({
  addItem: (r, item) => {
    r.thread.items.push(item);
    return item;
  },
  pushItem() {},
  pushSession() {},
  snapshotBefore: async () => undefined,
  finishCheckpoint: async () => {},
  onTurnEnd() {},
  onAgentTurn: (_r, running) => events.push(running),
});

let n = 0;
function makeRt(items = []) {
  return { agentId: 'antigravity', sessionId: `s${++n}`, running: false, turn: {}, toolItems: new Map(), thread: { id: `t${n}`, items } };
}
/** One ACP update as routeUpdate handles it; `item` is what applyUpdate would add or change. */
function route(rt, sessionUpdate, item) {
  if (AI.noteAgentInitiatedUpdate(rt, { sessionUpdate })) return;
  if (!rt.running && ['agent_message_chunk', 'agent_thought_chunk', 'tool_call'].includes(sessionUpdate)) AI.beginAgentInitiatedTurn(rt);
  if (item) {
    const i = rt.thread.items.findIndex((x) => x.id === item.id);
    if (i >= 0) rt.thread.items[i] = item;
    else rt.thread.items.push(item);
  }
}
const thought = (id) => ({ kind: 'thought', id, agentId: 'antigravity', text: 'thinking', ts: Date.now() });
const tool = (id, status) => ({ kind: 'tool', id, agentId: 'antigravity', title: 'Run manage_task', toolKind: 'execute', status, content: [], locations: [], ts: Date.now() });
const reply = (id) => ({ kind: 'agent', id, agentId: 'antigravity', text: 'done', ts: Date.now() });
const headers = (rt) => rt.thread.items.filter((i) => i.kind === 'user');

await test('one agy wake-up (tool → silent gap → thought → silent gap → thought → tool → reply) is ONE turn', async () => {
  events = [];
  const rt = makeRt();
  route(rt, 'tool_call', tool('a', 'in_progress'));
  route(rt, 'tool_call_update', tool('a', 'completed'));
  await sleep(400); // agy thinks silently after the tool result (real: ~11s vs the 2.5s settle)
  route(rt, 'agent_thought_chunk', thought('b'));
  await sleep(400); // silent tool-JSON generation after a single thought chunk
  route(rt, 'agent_thought_chunk', thought('c'));
  await sleep(400);
  route(rt, 'tool_call', tool('d', 'completed'));
  await sleep(400);
  assert.deepEqual(events, [true], `turn events so far: ${JSON.stringify(events)}`);
  assert.equal(headers(rt).length, 1, 'a single "Agent-initiated work" header');
  route(rt, 'agent_message_chunk', reply('e'));
  await sleep(300);
  assert.deepEqual(events, [true, false], 'the reply settles the turn quickly');
  assert.equal(rt.running, false);
});

await test('a turn whose first update is a thought is not ended by the short settle (delay judged after the thought)', async () => {
  events = [];
  const rt = makeRt();
  route(rt, 'agent_thought_chunk', thought('x'));
  await sleep(500);
  assert.deepEqual(events, [true]);
  await sleep(1300); // past the thought settle with nothing new: the turn ends by itself
  assert.deepEqual(events, [true, false]);
});

await test("agy's own wake message (mirrored SYSTEM_MESSAGE) heads the turn: no extra bubble", async () => {
  events = [];
  const wake = { kind: 'user', id: 's:idle:sys:9', agentId: 'antigravity', fromAgent: 'antigravity', fromApp: true, text: 'Task "task-519" finished', ts: Date.now() };
  const rt = makeRt([reply('old'), wake]);
  route(rt, 'tool_call', tool('t1', 'completed'));
  route(rt, 'agent_message_chunk', reply('r1'));
  await sleep(300);
  assert.deepEqual(headers(rt).map((u) => u.text), ['Task "task-519" finished']);
  assert.deepEqual(events, [true, false]);
});

await test('a stale or user-written last message still gets its own "Agent-initiated work" header', async () => {
  const oldWake = { kind: 'user', id: 'w-old', agentId: 'antigravity', fromApp: true, text: 'old wake', ts: Date.now() - 10 * 60_000 };
  const rt1 = makeRt([oldWake]);
  route(rt1, 'agent_message_chunk', reply('r'));
  assert.equal(headers(rt1).at(-1).text, 'Agent-initiated work');
  const rt2 = makeRt([{ kind: 'user', id: 'u', agentId: 'antigravity', text: 'mine', ts: Date.now() }]);
  route(rt2, 'agent_message_chunk', reply('r'));
  assert.equal(headers(rt2).at(-1).text, 'Agent-initiated work');
  await sleep(300);
});

await test('end_of_turn still ends the turn at once', async () => {
  events = [];
  const rt = makeRt();
  route(rt, 'agent_thought_chunk', thought('q'));
  route(rt, 'end_of_turn');
  assert.deepEqual(events, [true, false]);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
