import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const { buildFixErrorPrompt } = await import(`${APP}/src/shared/fixError.ts`);

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.error(`FAIL  ${name}\n`, e);
  }
}

test('command failure strips ANSI codes, includes exit code, command, output, and git diff', () => {
  const p = buildFixErrorPrompt({
    source: 'command',
    title: 'npm test',
    command: 'npm test',
    exitCode: 1,
    output: '\x1b[31mError: expected 2 to equal 3\x1b[0m\n  at src/math.ts:10:5',
    gitSummary: ' M src/math.ts\n\n@@ -1 +1 @@\n-export const x = 2;\n+export const x = 3;',
  });
  assert.match(p, /This command failed \(exit 1\)/);
  assert.match(p, /`\$ npm test`/);
  assert.ok(!p.includes('\x1b['), 'ANSI stripped');
  assert.match(p, /Error: expected 2 to equal 3/);
  assert.match(p, /Uncommitted git changes in this project:\n```diff/);
  assert.match(p, /\+export const x = 3;/);
});

test('web-console failure notes screenshot attachment and caps huge outputs/diffs cleanly', () => {
  const p = buildFixErrorPrompt({
    source: 'web-console',
    title: 'http://localhost:5173/',
    output: 'A'.repeat(6500),
    gitSummary: 'D'.repeat(4500),
    hasScreenshot: true,
  });
  assert.match(p, /A screenshot of the current page is attached\./);
  assert.match(p, /earlier characters omitted/);
  assert.match(p, /diff truncated/);
});

test('tests failure includes bulleted failedItems and omits git block when clean', () => {
  const p = buildFixErrorPrompt({
    source: 'tests',
    title: '2 tests failed (vitest) in terminal "Tests"',
    failedItems: ['- auth > rejects expired token (src/auth.test.ts:14)'],
    output: 'FAIL src/auth.test.ts',
    gitSummary: '   ',
  });
  assert.match(p, /- auth > rejects expired token/);
  assert.ok(!p.includes('Uncommitted git changes'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
