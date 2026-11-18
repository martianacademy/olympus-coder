// Unit tests: money `$` must not turn chat text into KaTeX math, while real math still renders.
// File: src/shared/markdownMath.ts. Each case is also parsed with the real remark-math (same plugins as the chat).
// Run: node tests/markdownMath.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; no Electron needed)
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { visit } from 'unist-util-visit';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const { normalizeMath } = await import(pathToFileURL(`${APP}/src/shared/markdownMath.ts`).href);

/** Inline and display math bodies remark-math finds after our clean-up. */
function mathIn(md) {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(normalizeMath(md));
  const found = [];
  visit(tree, (n) => {
    if (n.type === 'inlineMath' || n.type === 'math') found.push(n.value);
  });
  return found;
}
/** Plain text remark sees (math/code bodies excluded), to check the `$` signs survive as text. */
function textIn(md) {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(normalizeMath(md));
  let s = '';
  visit(tree, 'text', (n) => {
    s += n.value;
  });
  return s;
}

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}

// --- money, the reported bug ---
const BUG = 'Test ke liye **Ashburn + vm.mini (2 vCPU, 8 GB, $0.05/hr)** kaafi hai. vm.small ($0.09/hr) bhi theek hai.';
t('reported line: no math, both prices kept', () => {
  assert.deepEqual(mathIn(BUG), []);
  assert.match(textIn(BUG), /\$0\.05\/hr/);
  assert.match(textIn(BUG), /\$0\.09\/hr/);
});
const BUG2 = 'aapne vm.small chuna hai jo $0.09/hr ka hai, par neeche total **$0.19/hr** dikh raha hai.';
t('second reported line (closing $ before bold price)', () => {
  assert.deepEqual(mathIn(BUG2), []);
  assert.match(textIn(BUG2), /\$0\.19\/hr/);
});
t('range "$5-$10"', () => assert.deepEqual(mathIn('Costs $5-$10 per month.'), []));
t('"$5 and $10"', () => assert.deepEqual(mathIn('Between $5 and $10.'), []));
t('"$1,000 to $2,000"', () => assert.deepEqual(mathIn('From $1,000 to $2,000 a year.'), []));
t('three prices in one line', () => assert.deepEqual(mathIn('A $1, B $2, C $3'), []));
t('price inside a table cell', () => assert.deepEqual(mathIn('| plan | price |\n|---|---|\n| mini | $0.05/hr ($36/mo) |'), []));
t('price in a list item', () => assert.deepEqual(mathIn('- mini: $0.05/hr\n- small: $0.09/hr'), []));

// --- real math still works ---
t('$x$ inline', () => assert.deepEqual(mathIn('Let $x$ be the input.'), ['x']));
t('$2^n$ starts with a digit', () => assert.deepEqual(mathIn('There are $2^n$ subsets.'), ['2^n']));
t('two formulas in one line', () => assert.deepEqual(mathIn('If $a=1$ and $b=2$ then $a+b=3$.'), ['a=1', 'b=2', 'a+b=3']));
t('math next to money', () => assert.deepEqual(mathIn('It costs $5, but $x^2$ grows.'), ['x^2']));
t('$$ display block', () => assert.deepEqual(mathIn('$$\nE = mc^2\n$$'), ['E = mc^2']));
t('one-line $$…$$ becomes display', () => assert.deepEqual(mathIn('$$E = mc^2$$'), ['E = mc^2']));
t('\\( \\) inline', () => assert.deepEqual(mathIn('Here \\( a + b \\) works.'), ['a + b']));
t('\\[ \\] display', () => assert.deepEqual(mathIn('\\[ \\sum_i x_i \\]'), ['\\sum_i x_i']));

// --- code is never touched ---
t('fenced code keeps $ as written', () => {
  const md = '```bash\necho "$HOME $PATH costs $5"\n```';
  assert.equal(normalizeMath(md), md);
});
t('indented fence in a list keeps $', () => {
  const md = '1. Run:\n   ```bash\n   echo $A $B\n   ```';
  assert.equal(normalizeMath(md), md);
});
t('open fence while streaming keeps $', () => {
  const md = 'Run this:\n```bash\necho $A $B';
  assert.equal(normalizeMath(md), md);
});
t('inline code keeps $', () => {
  const md = 'Use `echo $A $B` and pay $5 or $6.';
  assert.equal(normalizeMath(md).includes('`echo $A $B`'), true);
  assert.deepEqual(mathIn(md), []);
});

// --- leaves text alone when nothing would change ---
t('lone $ untouched', () => assert.equal(normalizeMath('Only $5 here.'), 'Only $5 here.'));
t('no $ at all untouched', () => assert.equal(normalizeMath('plain text'), 'plain text'));
t('already escaped \\$ untouched', () => {
  const md = 'Costs \\$5 and \\$10.';
  assert.equal(normalizeMath(md), md);
  assert.deepEqual(mathIn(md), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
