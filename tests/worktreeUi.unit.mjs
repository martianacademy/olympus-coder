// Unit tests: pure helpers behind the git worktree chat UI (src/renderer/src/worktreeUi.ts) — readable IPC errors,
// the ahead/behind/uncommitted summary, when merging has anything to bring, and the conflict-resolution prompt.
// Run: node tests/worktreeUi.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; no Electron needed)
import assert from 'node:assert/strict';

const { cleanError, worktreeCounts, hasWorkToMerge, resolveConflictsPrompt, worktreeTip } = await import('../src/renderer/src/worktreeUi.ts');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
};

test('cleanError drops the Electron IPC prefix', () => {
  assert.equal(
    cleanError(new Error("Error invoking remote method 'desk:invoke': Error: This project is not a git repository.")),
    'This project is not a git repository.',
  );
  assert.equal(cleanError(new Error('Plain message')), 'Plain message');
  assert.equal(cleanError('string error'), 'string error');
  assert.equal(cleanError({ message: 'obj' }), 'obj');
  assert.equal(cleanError(new Error('')), 'Something went wrong.');
});

test('worktreeCounts lists only the non-zero parts', () => {
  assert.equal(worktreeCounts({ ahead: 3, behind: 1, dirtyFiles: 2, baseBranch: 'main' }), '3 commits ahead · 1 behind · 2 uncommitted');
  assert.equal(worktreeCounts({ ahead: 1, behind: 0, dirtyFiles: 0, baseBranch: 'main' }), '1 commit ahead');
  assert.equal(worktreeCounts({ ahead: 0, behind: 0, dirtyFiles: 0, baseBranch: 'dev' }), 'Up to date with dev');
});

test('hasWorkToMerge: commits ahead or uncommitted files', () => {
  assert.equal(hasWorkToMerge({ ahead: 0, dirtyFiles: 0 }), false);
  assert.equal(hasWorkToMerge({ ahead: 2, dirtyFiles: 0 }), true);
  assert.equal(hasWorkToMerge({ ahead: 0, dirtyFiles: 1 }), true);
});

test('resolveConflictsPrompt names the branches, every file, and the steps', () => {
  const p = resolveConflictsPrompt({ branch: 'olympus/x-ab12', baseBranch: 'main', conflicts: ['src/a.ts', 'README.md'], mode: 'squash' });
  assert.match(p, /`olympus\/x-ab12` into `main` \(squash\)/);
  assert.match(p, /^- src\/a\.ts$/m);
  assert.match(p, /^- README\.md$/m);
  assert.match(p, /rebase `olympus\/x-ab12` onto `main`/);
  assert.match(p, /run the project's checks/);
  assert.match(p, /commit the result/);
  assert.match(resolveConflictsPrompt({ branch: 'b', baseBranch: 'main', conflicts: [], mode: 'merge' }), /git did not list the files/);
});

test('worktreeTip shows branch, base and path', () => {
  const t = worktreeTip({ branch: 'olympus/y', baseBranch: 'main', path: '/tmp/wt/y' });
  assert.match(t, /Branch olympus\/y \(from main\)/);
  assert.match(t, /\/tmp\/wt\/y/);
});

console.log(`\n${passed} passed`);
