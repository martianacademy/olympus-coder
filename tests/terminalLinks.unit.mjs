// Unit tests: terminalLinks (src/renderer/src/terminalLinks.ts) — multi-row wrapped URL extraction
// for long OAuth URLs in narrow terminals (such as LoginDialog).
// Run: node tests/terminalLinks.unit.mjs
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const { collectWrappedRows, extractWrappedUrls } = await import(`${APP}/src/renderer/src/terminalLinks.ts`);

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

function mkBuf(spec) {
  const lines = spec.map(([text, isWrapped]) => ({
    isWrapped,
    translateToString: (trimRight) => (trimRight ? text.replace(/\s+$/, '') : text),
  }));
  return (i) => lines[i];
}

test('single-line URL strips trailing punctuation and computes 1-based range', () => {
  const buf = mkBuf([['Visit https://github.com/login/device. ', false]]);
  const rows = collectWrappedRows(buf, 0);
  const links = extractWrappedUrls(rows, 1);
  assert.equal(links.length, 1);
  assert.equal(links[0].url, 'https://github.com/login/device');
  assert.deepEqual(links[0].range, { start: { x: 7, y: 1 }, end: { x: 37, y: 1 } });
  assert.deepEqual(links[0].targetSpan, [6, 37]);
});

test('300-char Copilot OAuth URL wrapped across 6 rows resolves completely from any hovered row', () => {
  const fullUrl =
    'https://github.com/login/oauth/authorize?client_id=Ov23ctDVkRmgkPke0Mmm&redirect_uri=http%3A%2F%2F127.0.0.1%3A50942%2Fcallback&scope=read%3Auser+read%3Aorg+repo+gist&state=n6Wa8cFWep_klTWcxuqNbw&code_challenge=4PSiP0dz49z-IOf7RYqU3aL4LfvZ84_02aFlJG3wyRA&code_challenge_method=S256';
  const cols = 60;
  const spec = [['If it does not open automatically, visit:', false]];
  for (let i = 0; i < fullUrl.length; i += cols) {
    spec.push([fullUrl.slice(i, i + cols), i > 0]);
  }
  spec.push(['Waiting for authorization...', false]);

  const buf = mkBuf(spec);
  // Hover on row 4 (1-based; 0-based index 3 = middle of the wrapped URL)
  const rows = collectWrappedRows(buf, 3);
  assert.equal(rows.length, Math.ceil(fullUrl.length / cols));
  const links = extractWrappedUrls(rows, 4);
  assert.equal(links.length, 1);
  assert.equal(links[0].url, fullUrl);
  assert.deepEqual(links[0].range.start, { x: 1, y: 2 });
  assert.equal(links[0].range.end.y, 1 + Math.ceil(fullUrl.length / cols));
});

test('two URLs in one logical wrapped line return only URLs touching the queried row', () => {
  const buf = mkBuf([
    ['First https://example.com/one and then some padding text    ', false],
    ['and second https://example.com/two here', true],
  ]);
  const r1 = extractWrappedUrls(collectWrappedRows(buf, 0), 1);
  assert.deepEqual(
    r1.map((l) => l.url),
    ['https://example.com/one'],
  );
  const r2 = extractWrappedUrls(collectWrappedRows(buf, 1), 2);
  assert.deepEqual(
    r2.map((l) => l.url),
    ['https://example.com/two'],
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
