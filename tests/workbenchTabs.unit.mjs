// Unit tests: workbenchTabs (src/renderer/src/workbenchTabs.ts) — custom tab order normalization,
// drag-reordering, and next-visible-tab selection when a detached tool hides from the main tab bar.
// Run: node tests/workbenchTabs.unit.mjs
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const { commitTabReorder, DEFAULT_WB_TABS, normalizeTabOrder, pickNextVisibleTab, reorderTabs } = await import(
  `${APP}/src/renderer/src/workbenchTabs.ts`
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

test('normalizeTabOrder preserves valid custom order and appends missing defaults', () => {
  assert.deepEqual(normalizeTabOrder(['terminal', 'files']), ['terminal', 'files', 'info', 'git', 'tasks']);
  assert.deepEqual(normalizeTabOrder(['git', 'git', 'bogus', 42, 'info']), ['git', 'info', 'files', 'terminal', 'tasks']);
  assert.deepEqual(normalizeTabOrder(null), [...DEFAULT_WB_TABS]);
});

test('reorderTabs moves source into target slot without mutating original', () => {
  const start = [...DEFAULT_WB_TABS];
  assert.deepEqual(reorderTabs(start, 'files', 'terminal'), ['info', 'git', 'terminal', 'files', 'tasks']);
  assert.deepEqual(reorderTabs(start, 'tasks', 'info'), ['tasks', 'info', 'files', 'git', 'terminal']);
  assert.deepEqual(reorderTabs(start, 'git', 'git'), start);
  assert.deepEqual(start, [...DEFAULT_WB_TABS]);
});

test('pickNextVisibleTab picks neighbour after detached tab, else before, else null when none left', () => {
  const all = ['files', 'git', 'terminal', 'tasks', 'info'];
  assert.equal(pickNextVisibleTab(all, ['git', 'terminal', 'tasks', 'info'], 'files'), 'git');
  assert.equal(pickNextVisibleTab(all, ['files', 'git', 'tasks', 'info'], 'terminal'), 'tasks');
  assert.equal(pickNextVisibleTab(all, ['files', 'git', 'terminal', 'tasks'], 'info'), 'tasks');
  assert.equal(pickNextVisibleTab(all, ['files', 'git'], 'git'), 'git');
  assert.equal(pickNextVisibleTab(all, [], 'files'), null);
});

test('commitTabReorder inserts at target slot while preserving detached/hidden tabs', () => {
  // All visible: move files (0) to index 2 among [git, terminal, tasks, info] -> [git, terminal, files, tasks, info]
  assert.deepEqual(
    commitTabReorder(['files', 'git', 'terminal', 'tasks', 'info'], 'files', ['git', 'terminal', 'tasks', 'info'], 2),
    ['git', 'terminal', 'files', 'tasks', 'info'],
  );
  // With git detached (hidden at index 1): move info to index 0 among [files, terminal, tasks] -> [info, git, files, terminal, tasks]
  assert.deepEqual(
    commitTabReorder(['files', 'git', 'terminal', 'tasks', 'info'], 'info', ['files', 'terminal', 'tasks'], 0),
    ['info', 'git', 'files', 'terminal', 'tasks'],
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
