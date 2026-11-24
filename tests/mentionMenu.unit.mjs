/**
 * Unit tests for composer `@` mention detection, attachment-first ranking, and token formatting
 * (`src/shared/mentionMenu.ts`).
 */
import assert from 'node:assert/strict';
import { detectMention, formatMentionInsert, rankMentions } from '../src/shared/mentionMenu.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const attachments = [
  { id: 'a1', name: 'bloch-sphere.png', path: '/tmp/a1-bloch-sphere.png', mime: 'image/png', size: 1200, preview: 'data:image/png;base64,AA==' },
  { id: 'a2', name: 'circuit notes.pdf', path: '/tmp/a2-circuit notes.pdf', mime: 'application/pdf', size: 4200 },
];

const files = [
  { name: 'README.md', path: 'README.md', dir: false },
  { name: 'circuit.py', path: 'src/quantum/circuit.py', dir: false },
  { name: 'proof.py', path: 'src/math/proof.py', dir: false },
  { name: 'src', path: 'src', dir: true },
];

test('detectMention matches at start, mid-sentence, and after punctuation while ignoring emails', () => {
  assert.deepEqual(detectMention('@', 1), { start: 0, end: 1, query: '' });
  assert.deepEqual(detectMention('compare @bloch with @cir', 24), { start: 20, end: 24, query: 'cir' });
  assert.deepEqual(detectMention('see (@proof', 11), { start: 5, end: 11, query: 'proof' });
  assert.equal(detectMention('contact user@gmail.com', 22), null);
  assert.equal(detectMention('done @bloch ', 12), null);
});

test('formatMentionInsert quotes filenames containing spaces and appends a trailing space', () => {
  assert.equal(formatMentionInsert('src/quantum/circuit.py'), '@src/quantum/circuit.py ');
  assert.equal(formatMentionInsert('circuit notes.pdf'), '@"circuit notes.pdf" ');
});

test('rankMentions always places attached composer files ahead of project files', () => {
  const all = rankMentions(attachments, files, '');
  assert.equal(all[0].kind, 'attachment');
  assert.equal(all[0].label, 'bloch-sphere.png');
  assert.equal(all[1].kind, 'attachment');
  assert.equal(all[1].label, 'circuit notes.pdf');
  assert.equal(all[2].kind, 'file');
  assert.ok(all.every((x) => x.label !== 'src'), 'Directories must be excluded');
});

test('rankMentions keeps matching attachments above matching project files when filtering', () => {
  const res = rankMentions(attachments, files, 'circuit');
  assert.equal(res.length, 2);
  assert.equal(res[0].kind, 'attachment');
  assert.equal(res[0].label, 'circuit notes.pdf');
  assert.equal(res[1].kind, 'file');
  assert.equal(res[1].target, 'src/quantum/circuit.py');
  assert.equal(res[1].detail, 'src/quantum');
});

console.log(`\n${passed} passed, 0 failed`);
