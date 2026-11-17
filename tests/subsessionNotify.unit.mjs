// Unit tests: telling the parent the moment a sub-session finishes (src/main/subsessionNotify.ts, the delivery
// callback of src/main/appmsg.ts, the `notifyParentOnSubsessionEnd` default in src/main/store.ts).
// Run: node tests/subsessionNotify.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; `electron` and the agent
// runtime are stubbed — labelled mocks below; HOME / userData point at a scratch folder)
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'olympus-notify-unit-')));
const HOME = join(TMP, 'home');
const UD = join(TMP, 'userData');
mkdirSync(join(HOME, '.olympus'), { recursive: true });
mkdirSync(UD, { recursive: true });
process.env.HOME = HOME;
delete process.env.OLYMPUS_HOME;
delete process.env.AGENTDESK_SHARED_ROOT;

// Mocks for appmsg.ts: the agent runtime (startPrompt / steerPrompt) and the thread store, driven by globalThis.__T.
const stub = (src) => `data:text/javascript,${encodeURIComponent(src)}`;
globalThis.__T = { running: false, started: [], items: [], listeners: [], finish: null, steer: 'injected', steered: [] };
const AGENTS = stub(`
  const T = globalThis.__T;
  export const runState = () => ({ running: T.running });
  export const setTurnEndListener = (fn) => T.listeners.push(fn);
  export const startPrompt = (id, text, att, opts) => {
    if (T.running) return { done: Promise.resolve() };
    const item = { kind: 'user', id: 'u' + T.started.length, text, fromApp: opts.fromApp };
    T.items.push(item); T.started.push([id, text, opts]); T.running = true;
    return { item, done: new Promise((r) => (T.finish = () => { T.running = false; r(); })) };
  };
  export const steerPrompt = async (id, text, att, opts) => { T.steered.push([id, text, opts]); return { outcome: T.steer }; };
`);
const STORE_STUB = stub(`export const findThread = () => ({ items: globalThis.__T.items });`);
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'mock:electron', shortCircuit: true };
    const fromAppmsg = ctx.parentURL?.includes('/src/main/appmsg.ts');
    if (fromAppmsg && spec === './agents') return { url: AGENTS, shortCircuit: true };
    if (fromAppmsg && spec === './store') return { url: STORE_STUB, shortCircuit: true };
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
  load(url, ctx, next) {
    if (url === 'mock:electron')
      return { format: 'module', shortCircuit: true, source: `export const app = { getPath: () => ${JSON.stringify(UD)} }; export const safeStorage = { isEncryptionAvailable: () => false }; export const shell = {};` };
    return next(url, ctx);
  },
});

const N = await import(`${APP}/src/main/subsessionNotify.ts`);
const { DisposableTracker } = await import(`${APP}/src/main/disposableSubsessions.ts`);

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

const info = (o = {}) => ({ id: 'id-a', title: 'Fix A', status: 'done', agent: 'Claude Code', model: 'Opus 5.5', durationMs: 252_000, files: [], report: 'All good.', ...o });

// ---------------------------------------------------------------- message building

await test('one result: title, id, status, agent + model, time, files none, whole short report', () => {
  const { text, fullReport } = N.buildResultMessage([info()], []);
  assert.match(text, /^\[Olympus Coder\] Sub-session "Fix A" finished\./);
  assert.match(text, /### "Fix A" — done\nid: id-a · agent: Claude Code \(Opus 5\.5\) · time: 4m 12s\nfiles changed: none\nreport:\nAll good\./);
  assert.match(text, /No other sub-sessions are running\./);
  assert.ok(!text.includes('get_subsession'), 'no "full report" pointer when nothing was cut');
  assert.deepEqual(fullReport, ['id-a']);
});

await test('files list capped at 10 with "+N more"', () => {
  const files = Array.from({ length: 13 }, (_, i) => `src/f${i}.ts`);
  const { text } = N.buildResultMessage([info({ files })], []);
  assert.match(text, /files changed \(13\): src\/f0\.ts, .*src\/f9\.ts \+3 more/);
  assert.ok(!text.includes('src/f10.ts'));
});

await test('long report cut at a line boundary under 1,500 chars, with the get_subsession pointer; not counted as read', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `line ${String(i).padStart(2, '0')} ${'x'.repeat(40)}`);
  const report = lines.join('\n');
  const { text, fullReport } = N.buildResultMessage([info({ report })], []);
  const body = text.split('report:\n')[1].split('\n…full report')[0];
  assert.ok(body.length <= N.REPORT_CAP, `body ${body.length}`);
  assert.ok(lines.includes(body.split('\n').at(-1)), 'last kept line is whole');
  assert.match(text, /\n…full report: get_subsession id-a/);
  assert.deepEqual(fullReport, []);
  // One huge line: cut at a space, never mid-word.
  const words = N.capReport('word '.repeat(600));
  assert.equal(words.full, false);
  assert.ok(words.text.endsWith('word') && words.text.length <= N.REPORT_CAP);
});

await test('batch: several results in one message, still-running list', () => {
  const { text, fullReport } = N.buildResultMessage(
    [info(), info({ id: 'id-b', title: 'Fix B', status: 'failed', report: 'TypeError: x is undefined', model: undefined, durationMs: 5000 })],
    [{ id: 'id-c', title: 'Fix C' }],
  );
  assert.match(text, /^\[Olympus Coder\] 2 sub-sessions finished\./);
  assert.match(text, /### "Fix B" — failed\nid: id-b · agent: Claude Code · time: 5s\nfiles changed: none\nerror:\nTypeError/);
  assert.match(text, /Still running: "Fix C" \(id id-c\)\. Olympus will message you when they finish too\./);
  assert.deepEqual(fullReport, ['id-a', 'id-b']);
});

await test('quota-exceeded keeps the fallback hint; cancelled / idle labels', () => {
  const { text } = N.buildResultMessage([info({ status: 'quota-exceeded', report: 'You hit your limit', fallback: 'Fallbacks: Codex (ready).' })], []);
  assert.match(text, /— quota-exceeded/);
  assert.match(text, /error:\nYou hit your limit/);
  assert.match(text, /fallback: Fallbacks: Codex \(ready\)\. Switch it in place .*configure_subsession or message_subsession/);
  assert.match(N.buildResultMessage([info({ status: 'idle', report: undefined })], []).text, /— ended without a reply[\s\S]*report: \(none\)/);
  assert.match(N.buildResultMessage([info({ status: 'cancelled' })], []).text, /— cancelled/);
});

// ---------------------------------------------------------------- delivery decision + no duplicates

await test('delivery: idle → new turn, busy + steer → steer, busy without steer → later, muted → none', () => {
  assert.equal(N.decideDelivery({ busy: false, canSteer: false, muted: false }), 'turn');
  assert.equal(N.decideDelivery({ busy: false, canSteer: true, muted: false }), 'turn');
  assert.equal(N.decideDelivery({ busy: true, canSteer: true, muted: false }), 'steer');
  assert.equal(N.decideDelivery({ busy: true, canSteer: false, muted: false }), 'later');
  assert.equal(N.decideDelivery({ busy: true, canSteer: true, muted: true }), 'none');
  assert.equal(N.decideDelivery({ busy: false, canSteer: false, muted: true }), 'none');
});

const view = (id, status, endedAt = 2000, resultId = `${status}@r1`) => ({ meta: { id, title: id }, status, endedAt: N.LIVE_STATES.has(status) ? undefined : endedAt, resultId: N.LIVE_STATES.has(status) ? undefined : resultId, filesTouched: [] });

await test('fresh: finished since start, not read, not sent, not waited for by a running wait_for_subsessions', () => {
  const views = [view('a', 'done'), view('b', 'running'), view('c', 'failed'), view('d', 'done', 500), view('e', 'done'), view('f', 'done')];
  const seen = new Set([N.doneKey(views[4])]); // e: read with get_subsession / wait_for_subsessions
  const sent = new Set([N.doneKey(views[5])]); // f: told already
  const fresh = N.pickFresh(views, { seen, sent, waitingFor: new Set(['c']), appStarted: 1000 });
  assert.deepEqual(fresh.map((v) => v.meta.id), ['a']); // b running, c inside a wait, d before start, e read, f sent
  // The same sub-session messaged again and finished again: a new result key → told again.
  const again = view('f', 'done', 3000, 'done@r2');
  assert.deepEqual(N.pickFresh([again], { seen, sent, waitingFor: new Set(), appStarted: 1000 }).length, 1);
});

await test('a parent blocked in wait_for_subsessions gets the result once: the wait returns it, then it counts as seen', () => {
  const seen = new Set();
  const sent = new Set();
  const v = view('a', 'done');
  // While the wait runs: not sent.
  assert.equal(N.pickFresh([v], { seen, sent, waitingFor: new Set(['a']), appStarted: 0 }).length, 0);
  // The wait returns it and marks it seen (orchestrator.ts waitLoop) → after the wait it is not sent either.
  seen.add(N.doneKey(v));
  assert.equal(N.pickFresh([v], { seen, sent, waitingFor: new Set(), appStarted: 0 }).length, 0);
});

// ---------------------------------------------------------------- settings default

await test('notifyParentOnSubsessionEnd defaults on, also for an old settings file with notifyAgentsWhenWorkEnds: false', async () => {
  writeFileSync(join(UD, 'settings.json'), JSON.stringify({ sharedRoot: join(HOME, '.olympus'), designVersion: 2, notifyAgentsWhenWorkEnds: false }));
  const S = await import(`${APP}/src/main/store.ts`);
  assert.equal(S.DEFAULT_SETTINGS.notifyParentOnSubsessionEnd, true);
  assert.equal(S.DEFAULT_SETTINGS.notifyAgentsWhenWorkEnds, false);
  const s = S.getSettings();
  assert.equal(s.notifyAgentsWhenWorkEnds, false);
  assert.equal(s.notifyParentOnSubsessionEnd, true);
});

// ---------------------------------------------------------------- delivered before deleted

const A = await import(`${APP}/src/main/appmsg.ts`);
const reset = () => Object.assign(globalThis.__T, { running: false, started: [], items: [], finish: null, steer: 'injected', steered: [] });
const tick = () => new Promise((r) => setTimeout(r, 5));

await test('idle parent: the message starts a turn at once as an app message; counts as read only after the agent answered', async () => {
  reset();
  const tracker = new DisposableTracker();
  const cand = { id: 'kid', disposable: true, status: 'done', key: 'kid@done@r1', active: false };
  let delivered = 0;
  A.notifyAgent('parent', '[Olympus Coder] Sub-session "kid" finished.', () => (delivered++, tracker.markRead(cand)));
  assert.equal(globalThis.__T.started.length, 1, 'sent right away');
  assert.equal(globalThis.__T.started[0][2].fromApp, true);
  await tick();
  assert.equal(delivered, 0, 'not read while the turn is still starting');
  assert.deepEqual(tracker.due([cand]), [], 'disposable kept before delivery');
  globalThis.__T.items.push({ kind: 'agent', id: 'a1', text: 'ok' });
  globalThis.__T.finish();
  await tick();
  assert.equal(delivered, 1);
  assert.deepEqual(tracker.due([cand]), ['kid'], 'deletable once the parent got it and its turn ended');
});

await test('a turn that never reached the agent (only an error after it) does not count as delivered', async () => {
  reset();
  let delivered = 0;
  A.notifyAgent('parent', 'msg', () => delivered++);
  globalThis.__T.items.push({ kind: 'error', id: 'e1', text: 'Agent failed to start.' });
  globalThis.__T.finish();
  await tick();
  assert.equal(delivered, 0);
});

await test('busy parent (queued for its turn end): nothing sent and nothing marked until that turn ends', async () => {
  reset();
  globalThis.__T.running = true;
  let delivered = 0;
  A.notifyAgent('p2', 'later msg', () => delivered++);
  assert.equal(globalThis.__T.started.length, 0, 'queued, not sent');
  await tick();
  assert.equal(delivered, 0);
  globalThis.__T.running = false;
  for (const fn of globalThis.__T.listeners) fn('p2');
  await new Promise((r) => setTimeout(r, 750)); // appmsg flushes 700 ms after a turn ends
  assert.equal(globalThis.__T.started.length, 1, 'sent after the turn ended');
  globalThis.__T.items.push({ kind: 'tool', id: 't1' });
  globalThis.__T.finish();
  await tick();
  assert.equal(delivered, 1);
});

await test('steer: goes into the running turn as an app message (fromApp); refused → false', async () => {
  reset();
  assert.equal(await A.steerAgent('p', 'hello'), true);
  assert.deepEqual(globalThis.__T.steered[0][2], { fromApp: true });
  globalThis.__T.steer = 'promptRequired';
  assert.equal(await A.steerAgent('p', 'hello'), false);
  A.muteChat('p');
  globalThis.__T.steer = 'injected';
  assert.equal(await A.steerAgent('p', 'hello'), false, 'muted chat (user pressed Stop) gets nothing');
  A.unmuteChat('p');
});

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
