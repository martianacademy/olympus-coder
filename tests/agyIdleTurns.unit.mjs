// Antigravity transcript mirror (src/main/agyIdleTurns.ts): steps agy takes on its own between prompts.
// Regression (2026-11-19): a live ACP tool call muted the mirror and cleared its open tools, so the four steps
// it had already shown never got their results and sat in Tasks as "running · inside the agent" for hours,
// next to the same steps delivered over ACP.
// Run: node tests/agyIdleTurns.unit.mjs   (AGY_IDLE_MODULE=<path> runs it against another copy of the module)
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Same resolver as the other main-process unit tests: extensionless relative imports → `.ts`.
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

const brain = mkdtempSync(join(tmpdir(), 'agy-idle-unit-'));
process.env.OLYMPUS_AGY_BRAIN_DIR = brain;
process.env.OLYMPUS_IDLE_SETTLE_MS = '120';
process.env.OLYMPUS_THOUGHT_SETTLE_MS = '2000';
const modPath = process.env.AGY_IDLE_MODULE || new URL('../src/main/agyIdleTurns.ts', import.meta.url).pathname;
const M = await import(pathToFileURL(modPath).href);
const AI = await import(pathToFileURL(new URL('../src/main/agentInitiated.ts', import.meta.url).pathname).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL = 1_300; // the mirror polls every second
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

function makeChat(sessionId) {
  const dir = join(brain, sessionId, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'transcript.jsonl');
  writeFileSync(file, '');
  const rt = { agentId: 'antigravity', sessionId, thread: { id: `t-${sessionId}`, items: [] } };
  const host = { addItem: (r, item) => r.thread.items.push(item), pushItem() {}, pushSession() {} };
  const write = (...steps) => appendFileSync(file, steps.map((s) => JSON.stringify(s) + '\n').join(''));
  const tools = () => rt.thread.items.filter((i) => i.kind === 'tool');
  return { rt, host, write, tools };
}
const at = (n) => new Date(Date.UTC(2026, 10, 18, 17, 49, n)).toISOString();
const planner = (i, calls, extra = {}) => ({ step_index: i, type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(i % 60), tool_calls: calls, ...extra });
const generic = (i, out = 'Command exited with code 0.') => ({ step_index: i, type: 'GENERIC', status: 'DONE', created_at: at(i % 60), content: `Created At: x\nCompleted At: y\n${out}` });
const run = (cmd) => ({ name: 'run_command', args: { CommandLine: cmd } });
const edit = (p) => ({ name: 'edit_file', args: { Path: p, Target: 'a', Replacement: 'b' } });

await test('incident: tools shown idle, then a live ACP tool call mutes the mirror → their results still complete them', async () => {
  const c = makeChat('s-incident');
  M.setAgyIdleTurn(c.rt, c.host, true);
  c.write({ step_index: 813, type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: at(11), content: 'Task id "x/task-811" finished with result: ok' });
  c.write(planner(814, [run('curl -sI relay'), edit('/m/a.md'), edit('/m/MEMORY.md'), edit('/m/o.md')]));
  await sleep(POLL);
  assert.equal(c.tools().length, 4, 'the four idle tool steps are shown');
  assert.ok(c.tools().every((t) => t.status === 'in_progress'));
  // agy now streams the same work over ACP (agentInitiated / onAgyToolEvent): mirror goes quiet.
  M.setAgyIdleTurn(c.rt, c.host, false, { liveAcp: true });
  c.write(generic(815), generic(816), generic(817), generic(818));
  await sleep(POLL);
  const st = c.tools().map((t) => t.status);
  assert.deepEqual(st, ['completed', 'completed', 'completed', 'completed'], `statuses: ${st.join(', ')}`);
  M.setAgyIdleTurn(c.rt, c.host, true); // the agent-initiated turn ends
  await sleep(50);
  assert.ok(c.tools().every((t) => t.status === 'completed'));
});

await test('live ACP work: steps written while agy streams them over ACP are not mirrored a second time', async () => {
  const c = makeChat('s-live');
  M.setAgyIdleTurn(c.rt, c.host, true);
  await sleep(50);
  M.setAgyIdleTurn(c.rt, c.host, false, { liveAcp: true }); // ACP agent-initiated turn begins
  c.write({ step_index: 20, type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: at(20), content: 'Task id "x/task-9" finished with result: done' });
  c.write(planner(21, [run('npm test')], { thinking: 'checking', content: 'Running tests' }), generic(22));
  await sleep(POLL);
  assert.equal(c.tools().length, 0, 'tool steps come over ACP only');
  assert.equal(c.rt.thread.items.filter((i) => i.kind === 'thought' || i.kind === 'agent').length, 0, 'no duplicate thought/reply');
  assert.equal(c.rt.thread.items.filter((i) => i.kind === 'user').length, 1, 'the SYSTEM_MESSAGE handoff (not sent over ACP) is still shown');
  M.setAgyIdleTurn(c.rt, c.host, true);
});

await test('a tool step that never gets a result ends as interrupted when the next step starts', async () => {
  const c = makeChat('s-orphan');
  M.setAgyIdleTurn(c.rt, c.host, true);
  c.write(planner(30, [run('ssh box'), run('ls')]), generic(31));
  await sleep(POLL);
  assert.deepEqual(c.tools().map((t) => t.status), ['completed', 'in_progress']);
  c.write(planner(32, [], { content: 'Done.' }));
  await sleep(POLL);
  assert.deepEqual(c.tools().map((t) => t.status), ['completed', 'interrupted']);
});

await test('a user prompt still mirrors lines written just before it, and keeps open tools for their results', async () => {
  const c = makeChat('s-prompt');
  M.setAgyIdleTurn(c.rt, c.host, true);
  c.write(planner(40, [run('long job')]));
  M.setAgyIdleTurn(c.rt, c.host, false); // user prompt starts right after agy wrote the step
  assert.equal(c.tools().length, 1, 'drained before muting');
  c.write(generic(41));
  await sleep(POLL);
  assert.equal(c.tools()[0].status, 'completed');
});

await test('step 592 incident: silent gap between ACP thought and tool_call keeps ONE autonomous turn and 0 duplicate idle tools', async () => {
  const c = makeChat('s-step592');
  const fullRt = { ...c.rt, running: false, turn: {}, toolItems: new Map() };
  let agentTurnEvents = [];
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
    onAgentTurn: (r, running) => {
      agentTurnEvents.push(running);
      M.setAgyIdleTurn(r, c.host, !running, { liveAcp: true });
    },
  });
  M.setAgyIdleTurn(fullRt, c.host, true);

  // 1. Background task finishes; agy streams `agent_thought_chunk` over ACP, then stays silent > IDLE_TURN_SETTLE_MS (350ms > 120ms) while generating 3 tool calls.
  AI.beginAgentInitiatedTurn(fullRt);
  fullRt.thread.items.push({ kind: 'thought', id: 'th-1', agentId: 'antigravity', text: 'Planning release publish...', ts: Date.now() });
  AI.noteAgentInitiatedUpdate(fullRt, { sessionUpdate: 'agent_thought_chunk' });
  c.write({ step_index: 591, type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: at(50), content: 'Task id "x/task-589" finished with result: ok' });
  await sleep(350);

  // Must STILL be running in the single autonomous turn (`onAgentTurn(false)` NOT called prematurely!).
  assert.deepEqual(agentTurnEvents, [true]);

  // 2. Now agy finishes generating step 592: writes transcript + streams ACP tool calls, then final agent reply.
  c.write(planner(592, [run('gh release edit v0.3.1'), edit('/m/releases.md'), edit('/m/MEMORY.md')]));
  fullRt.thread.items.push({ kind: 'tool', id: 'acp-tool-1', agentId: 'antigravity', title: 'gh release edit', toolKind: 'execute', status: 'completed', content: [], locations: [], ts: Date.now() });
  c.write(generic(593), generic(594), generic(595));
  await sleep(POLL);

  // Zero `:idle:tool:592:*` duplicates created!
  assert.equal(fullRt.thread.items.filter((i) => i.id.includes(':idle:tool:')).length, 0);
  assert.equal(fullRt.thread.items.filter((i) => i.text === 'Agent-initiated work').length, 1);

  // 3. Final agent reply arrives -> settles cleanly after IDLE_TURN_SETTLE_MS (~120ms).
  fullRt.thread.items.push({ kind: 'agent', id: 'ag-1', agentId: 'antigravity', text: 'Published v0.3.1!', ts: Date.now() });
  AI.noteAgentInitiatedUpdate(fullRt, { sessionUpdate: 'agent_message_chunk' });
  await sleep(250);
  assert.deepEqual(agentTurnEvents, [true, false]);
});

await test('orphaned :idle:tool:* items in thread (even when pendingTools is empty and muted) are swept closed on next USER_INPUT', async () => {
  const c = makeChat('s-sweep');
  // Simulate already-stuck `:idle:tool:592:0` in thread items while watch starts muted on a user prompt.
  c.rt.thread.items.push({
    kind: 'tool',
    id: 's-sweep:idle:tool:592:0',
    agentId: 'antigravity',
    title: 'gh release edit v0.3.1',
    toolKind: 'execute',
    status: 'in_progress',
    content: [],
    locations: [],
    ts: Date.now(),
  });
  M.setAgyIdleTurn(c.rt, c.host, false); // muted
  c.write({ step_index: 597, type: 'USER_INPUT', status: 'DONE', created_at: at(57), content: 'next message' });
  await sleep(POLL);
  assert.equal(c.rt.thread.items[0].status, 'interrupted');
});

M.stopAgyIdleTurns();
rmSync(brain, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
