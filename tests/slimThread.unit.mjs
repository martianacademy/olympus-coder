// Unit tests: slimThreadForRemote (src/shared/slimThread.ts) — shrinks huge threads for remote phones while
// preserving usage totals, message history, rich image blocks, and recent tool bodies.
// Run: node tests/slimThread.unit.mjs
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const { slimThreadForRemote } = await import(`${APP}/src/shared/slimThread.ts`);

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n     ${e?.stack ?? e}`);
  }
}

const mkThread = (items) => ({
  id: 't1',
  projectId: 'p1',
  title: 'Test',
  agentId: 'claude',
  createdAt: 1,
  updatedAt: 2,
  acpSessions: {},
  items,
});

test('small thread without oversized payloads returns the exact same reference', () => {
  const th = mkThread([
    { kind: 'user', id: 'u1', ts: 1, text: 'hello' },
    { kind: 'agent', id: 'a1', ts: 2, agentId: 'claude', text: 'world' },
  ]);
  assert.equal(slimThreadForRemote(th), th);
});

test('strips bulky old diffs/previews/thoughts while preserving user/agent text, usage, rich images, and recent items', () => {
  const bigStr = 'x'.repeat(50_000);
  const oldItems = [
    {
      kind: 'user',
      id: 'u-old',
      ts: 1,
      text: 'old prompt kept in full',
      usage: { input: 100, cacheRead: 200, cacheWrite: 0, prompt: 300 },
      attachments: [{ name: 'pic.png', path: '/tmp/pic.png', mime: 'image/png', size: 1000, preview: 'data:image/png;base64,' + bigStr }],
    },
    { kind: 'thought', id: 'th-old', ts: 2, text: 't'.repeat(2000) },
    {
      kind: 'tool',
      id: 'tool-old',
      ts: 3,
      title: 'echo ' + 'a'.repeat(1000),
      toolKind: 'edit',
      status: 'completed',
      locations: ['/proj/a.ts'],
      terminalText: 'o'.repeat(5000),
      content: [
        { type: 'diff', path: '/proj/a.ts', oldText: bigStr, newText: bigStr },
        { type: 'text', text: '[Image]', rich: { type: 'image', mimeType: 'image/png', path: '/chats/keep.png' } },
      ],
    },
  ];
  const filler = Array.from({ length: 120 }, (_, i) => ({ kind: 'agent', id: `a-${i}`, ts: 10 + i, agentId: 'claude', text: `msg ${i}` }));
  const recentTool = {
    kind: 'tool',
    id: 'tool-recent',
    ts: 999,
    title: 'Edit recent.ts',
    toolKind: 'edit',
    status: 'completed',
    locations: ['/proj/recent.ts'],
    content: [{ type: 'diff', path: '/proj/recent.ts', oldText: 'old', newText: 'new' }],
  };
  const orig = mkThread([...oldItems, ...filler, recentTool]);
  const slim = slimThreadForRemote(orig);

  // Original not mutated
  assert.ok(orig.items[0].attachments[0].preview.length > 50_000);
  assert.equal(orig.items[2].content[0].oldText.length, 50_000);

  // Old user keeps full text + usage + attachment metadata, drops inline base64 preview
  assert.equal(slim.items[0].text, 'old prompt kept in full');
  assert.deepEqual(slim.items[0].usage, { input: 100, cacheRead: 200, cacheWrite: 0, prompt: 300 });
  assert.equal(slim.items[0].attachments[0].path, '/tmp/pic.png');
  assert.equal(slim.items[0].attachments[0].preview, undefined);

  // Old thought trimmed
  assert.ok(slim.items[1].text.length <= 305);

  // Old tool trimmed, diff keeps path, rich image untouched
  assert.ok(slim.items[2].title.length <= 305);
  assert.equal(slim.items[2].content[0].path, '/proj/a.ts');
  assert.equal(slim.items[2].content[0].oldText, '');
  assert.deepEqual(slim.items[2].content[1].rich, { type: 'image', mimeType: 'image/png', path: '/chats/keep.png' });

  // Recent tool kept intact
  assert.deepEqual(slim.items.at(-1).content[0], { type: 'diff', path: '/proj/recent.ts', oldText: 'old', newText: 'new' });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
