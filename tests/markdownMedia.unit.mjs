// Unit tests: markdownMedia (src/renderer/src/markdownMedia.ts) — detecting and extracting
// local image, video, and audio Markdown links (`[shot.png](file:///...)`) for inline previews.
// Run: node tests/markdownMedia.unit.mjs
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const { displayMediaLabel, extractBlockMediaLinks, isLocalMediaHref, MAX_BLOCK_MEDIA_LINKS, mediaKindFromHref } = await import(
  `${APP}/src/renderer/src/markdownMedia.ts`
);

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

const el = (tagName, children = [], properties = {}) => ({ type: 'element', tagName, properties, children });
const txt = (value) => ({ type: 'text', value });
const link = (href, label) => el('a', typeof label === 'string' ? [txt(label)] : label, { href });

test('mediaKindFromHref identifies local images, videos, and audio across path styles', () => {
  assert.equal(mediaKindFromHref('file:///Users/dev/shot.png'), 'image');
  assert.equal(mediaKindFromHref('file://localhost/tmp/my%20pic.WEBP'), 'image');
  assert.equal(mediaKindFromHref('/tmp/photo.heic'), 'image');
  assert.equal(mediaKindFromHref('~/Desktop/diagram.svg'), 'image');
  assert.equal(mediaKindFromHref('./docs/hero.jpg'), 'image');
  assert.equal(mediaKindFromHref('C:\\Users\\suru\\card.png'), 'image');
  assert.equal(mediaKindFromHref('file:///tmp/demo.mp4'), 'video');
  assert.equal(mediaKindFromHref('/tmp/clip.MOV'), 'video');
  assert.equal(mediaKindFromHref('/tmp/voice.m4a'), 'audio');
  assert.equal(isLocalMediaHref('file:///tmp/shot.png'), true);
});

test('mediaKindFromHref rejects web URLs, code/doc files, line anchors, and unknown schemes', () => {
  assert.equal(mediaKindFromHref('https://example.com/pic.png'), null);
  assert.equal(mediaKindFromHref('http://localhost:3000/a.png'), null);
  assert.equal(mediaKindFromHref('mailto:test@example.com'), null);
  assert.equal(mediaKindFromHref('data:image/png;base64,abc'), null);
  assert.equal(mediaKindFromHref('#section-1'), null);
  assert.equal(mediaKindFromHref('ftp://server/a.png'), null);
  assert.equal(mediaKindFromHref('file:///tmp/notes.md'), null);
  assert.equal(mediaKindFromHref('file:///tmp/report.pdf'), null);
  assert.equal(mediaKindFromHref('file:///tmp/icon.svg#L10-L20'), null);
  assert.equal(mediaKindFromHref('/tmp/icon.svg:12'), null);
  assert.equal(mediaKindFromHref(''), null);
  assert.equal(mediaKindFromHref(undefined), null);
});

test('extractBlockMediaLinks marks a standalone media-link paragraph as standalone', () => {
  const p = el('p', [link('file:///Users/dev/olympus-comparison-modern.png', 'olympus-comparison-modern.png')]);
  const res = extractBlockMediaLinks(p);
  assert.equal(res.standalone, true);
  assert.deepEqual(res.links, [
    { href: 'file:///Users/dev/olympus-comparison-modern.png', label: 'olympus-comparison-modern.png', kind: 'image' },
  ]);
});

test('extractBlockMediaLinks marks stacked media links separated by <br> as standalone', () => {
  const p = el('p', [
    link('file:///tmp/a.png', 'a.png'),
    el('br'),
    txt('\n'),
    link('file:///tmp/b.mp4', 'b.mp4'),
  ]);
  const res = extractBlockMediaLinks(p);
  assert.equal(res.standalone, true);
  assert.equal(res.links.length, 2);
  assert.equal(res.links[0].kind, 'image');
  assert.equal(res.links[1].kind, 'video');
});

test('extractBlockMediaLinks keeps prose paragraphs non-standalone while extracting inline media links', () => {
  const p = el('p', [
    txt('Check out '),
    link('file:///tmp/before.png', 'before.png'),
    txt(' and '),
    link('file:///tmp/after.png', 'after.png'),
    txt('!'),
  ]);
  const res = extractBlockMediaLinks(p);
  assert.equal(res.standalone, false);
  assert.deepEqual(
    res.links.map((l) => l.href),
    ['file:///tmp/before.png', 'file:///tmp/after.png'],
  );
});

test('extractBlockMediaLinks unwraps bold/italic formatting around links', () => {
  const p = el('p', [el('strong', [link('file:///tmp/hero.png', 'Hero card')])]);
  const res = extractBlockMediaLinks(p);
  assert.equal(res.standalone, true);
  assert.deepEqual(res.links, [{ href: 'file:///tmp/hero.png', label: 'Hero card', kind: 'image' }]);
});

test('extractBlockMediaLinks skips links that already wrap an <img> (no duplicate preview)', () => {
  const p = el('p', [link('file:///tmp/shot.png', [el('img', [], { src: 'file:///tmp/shot.png', alt: 'shot' })])]);
  const res = extractBlockMediaLinks(p);
  assert.equal(res.standalone, false);
  assert.equal(res.links.length, 0);
});

test('extractBlockMediaLinks handles tight <li> but does not double-collect from loose <li><p>', () => {
  const tightLi = el('li', [txt('Preview: '), link('file:///tmp/shot.png', 'shot.png')]);
  const tightRes = extractBlockMediaLinks(tightLi);
  assert.equal(tightRes.standalone, false);
  assert.equal(tightRes.links.length, 1);

  const looseLi = el('li', [el('p', [link('file:///tmp/shot.png', 'shot.png')])]);
  const looseRes = extractBlockMediaLinks(looseLi);
  assert.equal(looseRes.links.length, 0);
});

test('extractBlockMediaLinks deduplicates repeated hrefs and enforces cap', () => {
  const children = [];
  for (let i = 0; i < MAX_BLOCK_MEDIA_LINKS + 4; i++) {
    children.push(link(`file:///tmp/img-${i}.png`, `img-${i}.png`));
  }
  children.push(link('file:///tmp/img-0.png', 'duplicate'));
  const res = extractBlockMediaLinks(el('p', children));
  assert.equal(res.links.length, MAX_BLOCK_MEDIA_LINKS);
  assert.equal(new Set(res.links.map((l) => l.href)).size, MAX_BLOCK_MEDIA_LINKS);
});

test('displayMediaLabel prefers clean labels and falls back to basename for raw paths', () => {
  assert.equal(displayMediaLabel('olympus-comparison-modern.png', 'file:///a/b/olympus-comparison-modern.png', 'olympus-comparison-modern.png'), 'olympus-comparison-modern.png');
  assert.equal(displayMediaLabel('After redesign', 'file:///a/b/shot.png', 'shot.png'), 'After redesign');
  assert.equal(displayMediaLabel('/a/b/shot.png', '/a/b/shot.png', 'shot.png'), 'shot.png');
  assert.equal(displayMediaLabel('file:///a/b/shot.png', 'file:///a/b/shot.png', 'shot.png'), 'shot.png');
  assert.equal(displayMediaLabel('', 'file:///a/b/shot.png', 'shot.png'), 'shot.png');
});

test('inline code naming an absolute or ~/ local media file previews like a link', () => {
  const code = (value) => el('code', [txt(value)]);
  // "Demo ready: **`~/Downloads/demo.mp4`** (1080p)" — prose stays, preview attaches below.
  const prose = extractBlockMediaLinks(el('p', [txt('Demo ready: '), el('strong', [code('~/Downloads/demo.mp4')]), txt(' (1080p)')]));
  assert.deepEqual(prose.links, [{ href: '~/Downloads/demo.mp4', label: '', kind: 'video' }]);
  assert.equal(prose.standalone, false);
  // A paragraph that is only the path upgrades in place.
  const alone = extractBlockMediaLinks(el('p', [code('/tmp/shot.png')]));
  assert.deepEqual(alone.links, [{ href: '/tmp/shot.png', label: '', kind: 'image' }]);
  assert.equal(alone.standalone, true);
  assert.equal(extractBlockMediaLinks(el('li', [code('file:///tmp/voice.m4a')])).links[0].kind, 'audio');
  // Relative names, non-media files, line anchors and paths with spaces stay plain code.
  for (const v of ['assets/logo.png', 'src/app.ts', '/tmp/a.png:12', '/tmp/my shot.png', 'npm run build']) {
    const res = extractBlockMediaLinks(el('p', [txt('see '), code(v)]));
    assert.equal(res.links.length, 0, v);
  }
  // The same path as a link and as code is one preview.
  const both = extractBlockMediaLinks(el('p', [link('/tmp/shot.png', 'shot'), txt(' or '), code('/tmp/shot.png')]));
  assert.equal(both.links.length, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
