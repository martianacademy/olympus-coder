// Unit tests: phone link streaming — item patches (append-only text, object/array diffs, round trips) and the
// per-connection event filter (chats / terminals on screen, slim items for the rest, catch-up when one opens,
// merging, older pages without a view). Files: src/shared/itemPatch.ts, src/main/remoteStream.ts.
// Run: node tests/remoteStream.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; no Electron needed)
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const PTY_STUB = `data:text/javascript,export const ptyBuffer = (id) => ({ data: 'SCROLLBACK:' + id, end: 100, alive: true });`;
registerHooks({
  resolve(spec, ctx, next) {
    // remoteStream.ts reads terminal scrollback from ./pty (node-pty is built for Electron): a stub here.
    if (spec === './pty') return { url: PTY_STUB, shortCircuit: true };
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
});

const P = await import(`${APP}/src/shared/itemPatch.ts`);
const { RemoteStream } = await import(`${APP}/src/main/remoteStream.ts`);

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roundTrip = (a, b) => {
  const p = P.diffItem(P.snapshot(a), b);
  const got = p ? P.applyItemPatch(structuredClone(a), JSON.parse(JSON.stringify(p))) : a;
  assert.deepEqual(JSON.parse(JSON.stringify(got)), JSON.parse(JSON.stringify(b)));
  return p;
};

await test('growing text is sent as the appended tail only', () => {
  const p = roundTrip({ kind: 'agent', id: 'a', text: 'Hello' }, { kind: 'agent', id: 'a', text: 'Hello world' });
  assert.deepEqual(p, { o: { text: { a: ' world' } } });
});
await test('equal items give no patch', () => {
  assert.equal(P.diffItem(P.snapshot({ a: 1, b: [1, { c: 'x' }] }), { a: 1, b: [1, { c: 'x' }] }), undefined);
});
await test('replaced text, removed key, shrunk array, nested tool content', () => {
  roundTrip({ text: 'abc', x: 1, arr: [1, 2, 3] }, { text: 'xyz', arr: [1] });
  roundTrip(
    { kind: 'tool', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'line 1\n' } }] },
    { kind: 'tool', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'line 1\nline 2\n' } }, { type: 'diff', path: 'a.ts' }], endedAt: 5 },
  );
  roundTrip({ a: null, b: 'q' }, { a: { deep: [1] }, b: null });
});
await test('random round trips (500 mutations of a live item)', () => {
  let live = { kind: 'tool', id: 't', status: 'pending', content: [], terminalText: '' };
  let rnd = 7;
  const r = (n) => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31), rnd % n);
  let prevSnap = P.snapshot(live);
  let phone = structuredClone(live);
  for (let i = 0; i < 500; i++) {
    const op = r(6);
    if (op === 0) live.terminalText += `out ${i}\n`;
    else if (op === 1) live.content.push({ type: 'content', content: { type: 'text', text: `c${i}` } });
    else if (op === 2 && live.content.length) live.content[r(live.content.length)].content = { type: 'text', text: `swap${i}` };
    else if (op === 3) live.status = ['pending', 'in_progress', 'completed'][r(3)];
    else if (op === 4 && live.content.length) live.content.pop();
    else if (op === 5) live.terminalText = live.terminalText.slice(r(10));
    const p = P.diffItem(prevSnap, live);
    if (p) phone = P.applyItemPatch(phone, JSON.parse(JSON.stringify(p)));
    prevSnap = P.snapshot(live);
    assert.deepEqual(phone, JSON.parse(JSON.stringify(live)), `step ${i}`);
  }
});
await test('applying a patch keeps untouched parts (React memo friendly)', () => {
  const prev = { text: 'a', parts: [{ big: 1 }], meta: { x: 1 } };
  const next = P.applyItemPatch(prev, { o: { text: { a: 'b' } } });
  assert.equal(next.parts, prev.parts);
  assert.equal(next.meta, prev.meta);
  assert.notEqual(next, prev);
});

function collect(interval = 0) {
  const got = [];
  const s = new RemoteStream((batch) => (got.push(...batch), true), interval);
  return { s, got };
}
const item = (id, extra) => ({ kind: 'agent', id, agentId: 'x', text: '', ts: 1, ...extra });

await test('no view yet (older page): every event in full, as before', async () => {
  const { s, got } = collect();
  const it = item('i1', { text: 'Hi' });
  s.push('thread:item', { threadId: 'T', item: it });
  await sleep(5);
  it.text += ' there';
  s.push('thread:item', { threadId: 'T', item: it });
  s.push('pty:data', { ptyId: 'P', data: 'x', end: 1 });
  await sleep(5);
  assert.deepEqual(got.map(([c]) => c), ['thread:item', 'thread:item', 'pty:data']);
});
await test('chat on screen: first full, then patches; others: nothing for messages', async () => {
  const { s, got } = collect();
  s.setView({ threads: ['T'], ptys: [], patch: true });
  const it = item('i1', { text: 'Hi' });
  s.push('thread:item', { threadId: 'T', item: it });
  await sleep(5);
  it.text += ' there';
  s.push('thread:item', { threadId: 'T', item: it });
  s.push('thread:item', { threadId: 'OTHER', item: item('o1', { text: 'secret long text' }) });
  await sleep(5);
  assert.deepEqual(got.map(([c]) => c), ['thread:item', 'thread:patch']);
  assert.deepEqual(got[1][1], { threadId: 'T', id: 'i1', p: { o: { text: { a: ' there' } } } });
});
await test('other chats: permission items in full, tool status changes slim and once', async () => {
  const { s, got } = collect();
  s.setView({ threads: ['T'], ptys: [], patch: true });
  s.push('thread:item', { threadId: 'B', item: { kind: 'permission', id: 'p1', resolved: false } });
  const tool = { kind: 'tool', id: 't1', agentId: 'x', toolCallId: 'c', title: 'npm i', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'x'.repeat(5000) } }], locations: [], ts: 1 };
  s.push('thread:item', { threadId: 'B', item: tool });
  await sleep(5);
  s.push('thread:item', { threadId: 'B', item: tool }); // same status: nothing
  await sleep(5);
  tool.status = 'completed';
  s.push('thread:item', { threadId: 'B', item: tool });
  await sleep(5);
  assert.deepEqual(got.map(([c, p]) => `${c}:${p.item.kind}:${p.item.status ?? ''}`), ['thread:item:permission:', 'thread:item:tool:in_progress', 'thread:item:tool:completed']);
  assert.equal(got[1][1].item.content.length, 0, 'slim tool item has no output');
});
await test('opening a chat sends what changed meanwhile, in full', async () => {
  const { s, got } = collect();
  s.setView({ threads: ['T'], ptys: [], patch: true });
  const it = item('b1', { text: 'background reply' });
  s.push('thread:item', { threadId: 'B', item: it });
  it.text += ' grows';
  s.push('thread:item', { threadId: 'B', item: it });
  await sleep(5);
  assert.equal(got.length, 0);
  s.setView({ threads: ['B'], ptys: [], patch: true });
  await sleep(5);
  assert.deepEqual(got.map(([c, p]) => [c, p.item?.text]), [['thread:item', 'background reply grows']]);
  it.text += '!';
  s.push('thread:item', { threadId: 'B', item: it });
  await sleep(5);
  assert.deepEqual(got[1], ['thread:patch', { threadId: 'B', id: 'b1', p: { o: { text: { a: '!' } } } }]);
});
await test('a chat that leaves the screen and comes back starts with a full item; resync forces one', async () => {
  const { s, got } = collect();
  s.setView({ threads: ['T'], ptys: [], patch: true });
  const it = item('i1', { text: 'a' });
  s.push('thread:item', { threadId: 'T', item: it });
  await sleep(5);
  s.setView({ threads: [], ptys: [], patch: true });
  s.setView({ threads: ['T'], ptys: [], patch: true });
  it.text += 'b';
  s.push('thread:item', { threadId: 'T', item: it });
  await sleep(5);
  assert.deepEqual(got.map(([c]) => c), ['thread:item', 'thread:item']);
  s.setView({ threads: ['T'], ptys: [], patch: true, resync: ['T\ni1'] });
  it.text += 'c';
  s.push('thread:item', { threadId: 'T', item: it });
  await sleep(5);
  assert.equal(got[2][0], 'thread:item');
});
await test('terminals: output only for shown ones, scrollback when one opens, merged per terminal', async () => {
  const { s, got } = collect(30);
  s.setView({ threads: [], ptys: [], patch: true });
  s.push('pty:data', { ptyId: 'P', data: 'hidden', end: 6 });
  s.push('pty:exit', { ptyId: 'P', exitCode: 0 });
  await sleep(40);
  assert.deepEqual(got.map(([c]) => c), ['pty:exit']);
  s.setView({ threads: [], ptys: ['P'], patch: true });
  await sleep(40);
  assert.deepEqual(got[1], ['pty:data', { ptyId: 'P', data: 'SCROLLBACK:P', end: 100 }]);
  s.push('pty:data', { ptyId: 'P', data: 'a', end: 101 });
  s.push('pty:data', { ptyId: 'P', data: 'b', end: 102 });
  s.push('pty:data', { ptyId: 'P', data: 'c', end: 103 });
  await sleep(40);
  // The first goes out at once (the interval since the last write has passed), the rest merged.
  assert.deepEqual(got.slice(2), [['pty:data', { ptyId: 'P', data: 'a', end: 101 }], ['pty:data', { ptyId: 'P', data: 'bc', end: 103 }]]);
});
await test('merging: first event at once, then at most one batch per interval with the latest item', async () => {
  const batches = [];
  const s = new RemoteStream((b) => (batches.push(b), true), 50);
  s.setView({ threads: ['T'], ptys: [], patch: true });
  const it = item('i1', { text: '' });
  for (let i = 0; i < 20; i++) {
    it.text += `${i},`;
    s.push('thread:item', { threadId: 'T', item: it });
  }
  assert.equal(batches.length, 1, 'first one is sent straight away');
  await sleep(80);
  assert.equal(batches.length, 2);
  assert.equal(batches[1].length, 1, 'one merged patch');
  s.dispose();
});

await test('a batch that could not be delivered (phone locked) makes the next one full, not a patch', async () => {
  const got = [];
  let up = true;
  const s = new RemoteStream((b) => (up ? (got.push(...JSON.parse(JSON.stringify(b))), true) : false), 0);
  s.setView({ threads: ['T'], ptys: [], patch: true });
  const it = item('i1', { text: 'a' });
  s.push('thread:item', { threadId: 'T', item: it });
  await sleep(5);
  up = false;
  it.text += 'b';
  s.push('thread:item', { threadId: 'T', item: it });
  await sleep(5);
  up = true;
  it.text += 'c';
  s.push('thread:item', { threadId: 'T', item: it });
  await sleep(5);
  assert.deepEqual(got.map(([c, p]) => [c, p.item?.text]), [['thread:item', 'a'], ['thread:item', 'abc']]);
});
await test('opening a chat catches up only on recent changes (older ones come with the chat load)', async () => {
  const { s, got } = collect();
  s.setView({ threads: ['T'], ptys: [], patch: true });
  const realNow = Date.now;
  try {
    Date.now = () => realNow() - 60_000;
    s.push('thread:item', { threadId: 'B', item: item('old', { text: 'long ago' }) });
    Date.now = realNow;
    s.push('thread:item', { threadId: 'B', item: item('new', { text: 'just now' }) });
    s.setView({ threads: ['B'], ptys: [], patch: true });
    await sleep(5);
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(got.map(([, p]) => p.item.id), ['new']);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
