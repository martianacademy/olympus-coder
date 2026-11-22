// Unit tests: clampTip (src/renderer/src/tooltip.ts) and commandTip (src/renderer/src/cmdFormat.ts) — hovering a
// terminal tab opened with a whole script showed the entire script in a screen-tall tooltip (user's screenshot,
// 2026-11-21). Tooltips now show a short preview.
// Run: node tests/tooltipClamp.unit.mjs
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
// The renderer imports its siblings without an extension (`./platform`), as Vite allows.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('./') && ctx.parentURL?.includes('/src/renderer/') && !/\.\w+$/.test(spec)) spec = new URL(`${spec}.ts`, ctx.parentURL).href;
    return next(spec, ctx);
  },
});
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel', userAgent: '' }, configurable: true });
const { clampTip } = await import(`${APP}/src/renderer/src/tooltip.ts`);
const { commandTip } = await import(`${APP}/src/renderer/src/cmdFormat.ts`);

// The command from the screenshot (shortened body, same shape: cd && mkdir && python3 - <<'PY' … PY).
const SCRIPT = [
  "cd /Users/suru.martian/Documents/marsnext/phobos && mkdir -p training-data/clean_language/tinystories training-data/clean_language/smol_smoltalk && python3 -u - <<'PY'",
  'import time',
  'from pathlib import Path',
  'from huggingface_hub import hf_hub_download',
  '',
  'targets = [',
  '  ("roneneldan/TinyStories", "training-data/clean_language/tinystories", [',
  '    "data/train-00000-of-00004-2d5a1467fff1081b.parquet",',
  '  ]),',
  ']',
  'for repo, out_dir, files in targets:',
  '    print(repo, flush=True)',
  'PY',
].join('\n');

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

test('commandTip: a whole script becomes its first line + how many lines follow', () => {
  const tip = commandTip(SCRIPT);
  assert.equal(tip.split('\n').length, 1, 'one line');
  assert.ok(tip.length <= 120 + ' … (+11 lines)'.length, `short: ${tip.length}`);
  assert.match(tip, /^cd \/Users\/suru\.martian\/Documents\/marsnext\/phobos && mkdir/);
  assert.match(tip, /… \(\+11 lines\)$/, 'blank lines are not counted');
});
test('commandTip: a short one-line command is unchanged', () => {
  assert.equal(commandTip('npm run dev'), 'npm run dev');
});
test('commandTip: two lines say "+1 line"', () => {
  assert.equal(commandTip('echo a\necho b'), 'echo a … (+1 line)');
});
test('commandTip: a long single line is cut with …', () => {
  const t = commandTip('x'.repeat(500));
  assert.equal(t.length, 120);
  assert.ok(t.endsWith('…'));
});
test('clampTip: any tooltip text over 6 lines or 300 characters is cut with …', () => {
  const out = clampTip(SCRIPT);
  assert.ok(out.split('\n').length <= 6, 'at most 6 lines');
  assert.ok(out.length <= 301, `at most 300 chars + …: ${out.length}`);
  assert.ok(out.endsWith('…'));
});
test('clampTip: normal tooltips are untouched', () => {
  assert.equal(clampTip('Run again: npm test'), 'Run again: npm test');
  assert.equal(clampTip('npm run dev\n(running)'), 'npm run dev\n(running)');
});
test('the terminal tab tooltip keeps its status line', () => {
  const tabTip = `${commandTip(SCRIPT)}\n(running)`;
  assert.equal(clampTip(tabTip), tabTip, 'nothing cut, so "(running)" stays');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
