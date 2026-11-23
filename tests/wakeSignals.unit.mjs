// Duplicate wake-ups (src/main/wakeSignals.ts + agenttimers.ts backup wakes).
// Regression (2026-11-22): every Antigravity `schedule` produced two prompts a few seconds apart: agy's own wake
// message (mirrored by agyIdleTurns as `:idle:sys:<step>`) and then the app's backup "[Olympus Coder] Your
// scheduled wake-up is due: …". A native wake must now cancel the backup it makes redundant.
// Run: node tests/wakeSignals.unit.mjs
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// agenttimers.ts imports the Electron-side agents/appmsg modules: stub just what it uses.
const sent = [];
globalThis.__wakeTestSent = sent;
const STUBS = {
  '/src/main/agents.ts': 'export const runState = () => ({ running: false });',
  '/src/main/appmsg.ts': 'export const isMuted = () => false; export const notifyAgent = (t, m) => globalThis.__wakeTestSent.push([t, m]);',
};
registerHooks({
  load(url, ctx, next) {
    const stub = Object.entries(STUBS).find(([end]) => url.endsWith(end));
    return stub ? { format: 'module', source: stub[1], shortCircuit: true } : next(url, ctx);
  },
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
});

const brain = mkdtempSync(join(tmpdir(), 'wake-signals-unit-'));
process.env.OLYMPUS_AGY_BRAIN_DIR = brain;
process.env.OLYMPUS_IDLE_SETTLE_MS = '120';
const src = (f) => pathToFileURL(new URL(`../src/main/${f}`, import.meta.url).pathname).href;
const W = await import(src('wakeSignals.ts'));
const M = await import(src('agyIdleTurns.ts'));
const AI = await import(src('agentInitiated.ts'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL = 1_300;
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

const NOW = 1_800_000_000_000;
const wake = (key, threadId, dueIn, note = '') => ({ key, threadId, kind: 'wake', dueAt: NOW + dueIn, note });

await test('the wake prompt matches its backup by note (case, spacing and truncation ignored)', () => {
  const entries = [
    wake('a', 't1', 9_000, 'Check install terminal ac22 and reply to user'),
    wake('b', 't1', 300_000, 'Check the E2E run later'),
    wake('c', 't2', 9_000, 'Check install terminal ac22 and reply to user'),
    { key: 'd', threadId: 't1', kind: 'timer', dueAt: NOW + 5_000, note: 'Check install terminal ac22 and reply to user' },
  ];
  assert.deepEqual(W.wakesSatisfiedBy(entries, 't1', '  check install   terminal ac22 and reply to user', NOW), ['a']);
  // agy may cut a long prompt short, and our note is capped at 600 chars: a prefix in either direction matches.
  assert.deepEqual(W.wakesSatisfiedBy(entries, 't1', 'Check install terminal ac22', NOW), ['a']);
  // A match does not depend on the window: a late native wake still cancels its own backup.
  assert.deepEqual(W.wakesSatisfiedBy(entries, 't1', 'Check the E2E run later', NOW), ['b']);
});

await test('a different prompt cancels nothing that has a note; set_timer timers are never touched', () => {
  const entries = [wake('a', 't1', 5_000, 'Check install terminal'), { key: 'd', threadId: 't1', kind: 'timer', dueAt: NOW + 1_000, note: '' }];
  assert.deepEqual(W.wakesSatisfiedBy(entries, 't1', 'Task id "x/task-9" finished with result: ok', NOW), []);
});

await test('without a prompt text: only wakes due within the window are cancelled', () => {
  const entries = [wake('soon', 't1', 8_000, 'x'), wake('late', 't1', W.NATIVE_WAKE_WINDOW_MS + 60_000, 'y'), wake('noteless', 't1', 4_000)];
  assert.deepEqual(W.wakesSatisfiedBy(entries, 't1', '', NOW), ['soon', 'noteless']);
  // With text, a note-less wake can still only be matched by time.
  assert.deepEqual(W.wakesSatisfiedBy(entries, 't1', 'anything', NOW), ['noteless']);
});

await test('listeners: called, unsubscribed, and a throwing listener does not stop the others', () => {
  const got = [];
  const offBad = W.onNativeWake(() => {
    throw new Error('boom');
  });
  const off = W.onNativeWake((t, s) => got.push([t, s]));
  W.noteNativeWake('t9', 'hello');
  off();
  offBad();
  W.noteNativeWake('t9', 'again');
  assert.deepEqual(got, [['t9', 'hello']]);
});

function makeChat(sessionId) {
  const dir = join(brain, sessionId, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'transcript.jsonl');
  writeFileSync(file, '');
  const rt = { agentId: 'antigravity', sessionId, thread: { id: `t-${sessionId}`, items: [] } };
  const host = { addItem: (r, item) => r.thread.items.push(item), pushItem() {}, pushSession() {} };
  const write = (...steps) => appendFileSync(file, steps.map((s) => JSON.stringify(s) + '\n').join(''));
  return { rt, host, write };
}
const sys = (i, content, created_at = new Date().toISOString()) => ({ step_index: i, type: 'SYSTEM_MESSAGE', status: 'DONE', created_at, content });

await test('agy mirror: its own wake message is reported (idle and muted), stale or "stopped" lines are not', async () => {
  const got = [];
  const off = W.onNativeWake((t, s) => got.push([t, s]));
  const c = makeChat('s-wake');
  M.setAgyIdleTurn(c.rt, c.host, true);
  c.write(sys(1, 'Check install terminal ac2237c8 and reply to user'));
  await sleep(POLL);
  assert.deepEqual(got, [['t-s-wake', 'Check install terminal ac2237c8 and reply to user']]);
  assert.equal(c.rt.thread.items.filter((i) => i.kind === 'user').length, 1, 'the wake prompt itself is still shown once');

  M.setAgyIdleTurn(c.rt, c.host, false); // an Olympus prompt is running: mirror muted
  c.write(sys(2, 'Check the build log'));
  c.write(sys(3, 'Old wake', new Date(Date.now() - 10 * 60_000).toISOString()));
  c.write(sys(4, 'All your subagents and background tasks have been stopped.'));
  await sleep(POLL);
  off();
  M.setAgyIdleTurn(c.rt, c.host, true);
  assert.deepEqual(got.map((g) => g[1]), ['Check install terminal ac2237c8 and reply to user', 'Check the build log']);
});

await test('agent-initiated turn start reports a wake for its chat (Claude ScheduleWakeup / agy over ACP)', async () => {
  const got = [];
  const off = W.onNativeWake((t, s) => got.push([t, s]));
  AI.initAgentInitiated({
    addItem: (r, item) => (r.thread.items.push(item), item),
    pushItem() {},
    pushSession() {},
    snapshotBefore: async () => undefined,
    finishCheckpoint: async () => {},
    onTurnEnd() {},
  });
  const rt = { agentId: 'claude', sessionId: 's-ai', thread: { id: 't-ai', items: [] }, running: false };
  AI.beginAgentInitiatedTurn(rt);
  AI.beginAgentInitiatedTurn(rt); // same turn continuing: no second report
  off();
  await sleep(300); // let the idle settle end the turn
  assert.deepEqual(got, [['t-ai', '']]);
});

await test('agenttimers: a native wake cancels its backup (saved file too); other chats and set_timer stay', async () => {
  const T = await import(src('agenttimers.ts'));
  const file = join(brain, 'agent-timers.json');
  T.restoreAgentTimers(file);
  const keys = () => JSON.parse(readFileSync(file, 'utf8')).map((e) => e.key).sort();
  T.keepWake('t-a', 'call-1', 145_000, 'Check install terminal ac2237c8 and reply to user');
  T.keepWake('t-b', 'call-2', 145_000, 'Check install terminal ac2237c8 and reply to user');
  T.setTimer('t-a', 5, 'look at the deploy');
  assert.equal(keys().length, 3);
  W.noteNativeWake('t-a', 'Check install terminal ac2237c8 and reply to user');
  assert.deepEqual(keys().filter((k) => k.includes('call-')), ['t-b:call-2'], 'only chat t-a\'s backup wake is gone');
  assert.ok(keys().some((k) => k.startsWith('t-a:timer:')), 'the set_timer timer stays');
  // A wake the agent never fulfils still fires as the safety net.
  T.keepWake('t-c', 'call-3', 1, 'nobody wakes me');
  await sleep(10_500);
  assert.deepEqual(sent.map(([t]) => t), ['t-c']);
  assert.match(sent[0][1], /scheduled wake-up is due: "nobody wakes me"/);
  T.dropWakes('t-a');
  T.dropWakes('t-b');
  T.pauseAgentTimersForQuit();
});

M.stopAgyIdleTurns();
rmSync(brain, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
