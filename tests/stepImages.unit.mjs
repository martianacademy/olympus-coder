// Unit tests: stepImages (src/renderer/src/stepImages.ts) — extracting image thumbnails for WorkGroup headers
// and individual ToolRow headers across Claude Code, Antigravity, Codex, and MCP rich image blocks.
// Run: node tests/stepImages.unit.mjs
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const { extractGroupImages, extractToolImages, isImagePath } = await import(`${APP}/src/renderer/src/stepImages.ts`);

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

const mkTool = (overrides = {}) => ({
  kind: 'tool',
  id: 't1',
  ts: 1000,
  title: 'Read /tmp/a.png',
  toolKind: 'read',
  status: 'completed',
  locations: [],
  content: [],
  ...overrides,
});

test('isImagePath detects local image extensions and rejects web/code paths', () => {
  assert.equal(isImagePath('/tmp/shot.png'), true);
  assert.equal(isImagePath('docs/hero.WEBP'), true);
  assert.equal(isImagePath('file:///tmp/my%20pic.jpeg#L1'), true);
  assert.equal(isImagePath('/tmp/a.png:1'), true);
  assert.equal(isImagePath('src/app.ts'), false);
  assert.equal(isImagePath('https://example.com/a.png'), false);
  assert.equal(isImagePath('data:image/png;base64,abc'), false);
});

test('Claude Read with BOTH location + persisted rich copy pairs into ONE entry (durable ref + readable name)', () => {
  const item = mkTool({
    title: 'Read /tmp/olympus-e2e/sheet_chat_dark.png',
    locations: ['/tmp/olympus-e2e/sheet_chat_dark.png'],
    locationRefs: [{ path: '/tmp/olympus-e2e/sheet_chat_dark.png', line: 1 }],
    content: [
      {
        type: 'text',
        text: '[Image: /Users/me/.olympus/attachments/chats/c1/6f60326d.png]',
        rich: {
          type: 'image',
          mimeType: 'image/png',
          path: '/Users/me/.olympus/attachments/chats/c1/6f60326d.png',
          size: 136389,
        },
      },
    ],
  });
  const imgs = extractToolImages(item);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].ref, '/Users/me/.olympus/attachments/chats/c1/6f60326d.png');
  assert.equal(imgs[0].name, 'sheet_chat_dark.png');
  assert.equal(imgs[0].mime, 'image/png');
});

test('Antigravity read_file with locations + Input JSON (no rich block) extracts once', () => {
  const item = mkTool({
    title: 'File ../../tmp/vxr_live_s.png',
    locations: ['/tmp/vxr_live_s.png'],
    content: [{ type: 'text', text: 'Input:\n{\n  "Path": "/tmp/vxr_live_s.png"\n}' }],
  });
  const imgs = extractToolImages(item);
  assert.deepEqual(imgs, [{ ref: '/tmp/vxr_live_s.png', name: 'vxr_live_s.png' }]);
});

test('relative image path resolves against project base', () => {
  const item = mkTool({
    title: 'Read docs/arch.png',
    locations: ['docs/arch.png'],
  });
  const imgs = extractToolImages(item, '/Users/me/proj');
  assert.deepEqual(imgs, [{ ref: '/Users/me/proj/docs/arch.png', name: 'arch.png' }]);
});

test('MCP tool returning multiple rich images with no locations keeps all', () => {
  const item = mkTool({
    title: 'Generate mockups',
    toolKind: 'other',
    content: [
      { type: 'text', text: '[Image]', rich: { type: 'image', mimeType: 'image/png', path: '/chats/a.png' } },
      { type: 'text', text: '[Image]', rich: { type: 'image', mimeType: 'image/webp', path: '/chats/b.webp' } },
    ],
  });
  const imgs = extractToolImages(item);
  assert.equal(imgs.length, 2);
  assert.deepEqual(imgs.map((i) => i.ref), ['/chats/a.png', '/chats/b.webp']);
});

test('embedded blob image resource & file:// image resource_link are extracted', () => {
  const item = mkTool({
    title: 'Fetch assets',
    toolKind: 'other',
    content: [
      {
        type: 'text',
        text: '',
        rich: { type: 'resource', uri: 'file:///proj/logo.svg', encoding: 'blob', mimeType: 'image/svg+xml', path: '/chats/blob.svg' },
      },
      {
        type: 'text',
        text: '',
        rich: { type: 'resource_link', uri: 'file:///proj/hero%20banner.jpg', name: 'Hero Banner', mimeType: 'image/jpeg' },
      },
    ],
  });
  const imgs = extractToolImages(item);
  assert.equal(imgs.length, 2);
  assert.equal(imgs[0].name, 'logo.svg');
  assert.equal(imgs[0].ref, '/chats/blob.svg');
  assert.equal(imgs[1].name, 'Hero Banner');
  assert.equal(imgs[1].ref, '/proj/hero banner.jpg');
});

test('shell commands mentioning .png inside script text are NOT scraped as false thumbnails', () => {
  const item = mkTool({
    title: 'cat > test.mjs <<EOF\nconst IMG = "sample.png";\nEOF',
    toolKind: 'execute',
    content: [{ type: 'text', text: 'Input:\n{"CommandLine": "ls /tmp/fake.png"}' }],
  });
  assert.deepEqual(extractToolImages(item), []);
});

test('failed Read without rich content yields no thumbnail', () => {
  const item = mkTool({
    status: 'failed',
    locations: ['/tmp/missing.png'],
  });
  assert.deepEqual(extractToolImages(item), []);
});

test('extractGroupImages aggregates across steps in order, keeping distinct rich snapshots and deduping identical refs', () => {
  const items = [
    { kind: 'thought', id: 'th1', ts: 100, text: 'Checking screenshots' },
    mkTool({ id: 't1', locations: ['/tmp/a.png'], content: [{ type: 'text', text: '', rich: { type: 'image', mimeType: 'image/png', path: '/chats/snap1.png' } }] }),
    mkTool({ id: 't2', toolKind: 'execute', title: 'npm test', locations: [] }),
    mkTool({ id: 't3', locations: ['/tmp/a.png'], content: [{ type: 'text', text: '', rich: { type: 'image', mimeType: 'image/png', path: '/chats/snap2.png' } }] }),
    mkTool({ id: 't4', locations: ['/tmp/b.jpg'] }),
    mkTool({ id: 't5', locations: ['/tmp/b.jpg'] }),
  ];
  const imgs = extractGroupImages(items);
  assert.equal(imgs.length, 3);
  assert.deepEqual(
    imgs.map((i) => [i.ref, i.name]),
    [
      ['/chats/snap1.png', 'a.png'],
      ['/chats/snap2.png', 'a.png'],
      ['/tmp/b.jpg', 'b.jpg'],
    ],
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
