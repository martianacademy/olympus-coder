// Unit tests: git worktree chats — the shared id helpers (src/shared/worktree.ts) and the pure parsers of
// src/main/worktrees.ts (porcelain status, left/right counts, worktree list, setup-path rules).
// Run: node tests/worktree.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; no Electron needed)
// The real-git flow (create → status → merge → conflict → remove) is covered by an integration script against
// scratch repositories, not here.
import assert from 'node:assert/strict';

const S = await import('../src/shared/worktree.ts');
const W = await import('../src/main/worktrees.ts');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
};

const TID = '7f7c6503-77e2-4661-9925-ce517c438691';

test('worktreeProjectId / parseWorktreeProjectId round-trip', () => {
  const id = S.worktreeProjectId('proj-1', TID);
  assert.equal(id, `proj-1__wt_${TID}`);
  assert.deepEqual(S.parseWorktreeProjectId(id), { projectId: 'proj-1', threadId: TID });
});

test('parseWorktreeProjectId rejects plain ids and empty parts', () => {
  assert.equal(S.parseWorktreeProjectId('proj-1'), undefined);
  assert.equal(S.parseWorktreeProjectId('general'), undefined);
  assert.equal(S.parseWorktreeProjectId('__wt_abc'), undefined);
  assert.equal(S.parseWorktreeProjectId('proj__wt_'), undefined);
});

test('activeWorktree / workspaceProjectId follow thread.worktree (still active after a merge)', () => {
  const wt = { path: '/w', branch: 'olympus/x-7f7c', baseBranch: 'main', baseCommit: 'abc', createdAt: 1 };
  assert.equal(S.activeWorktree({}), undefined);
  assert.equal(S.activeWorktree(undefined), undefined);
  assert.equal(S.workspaceProjectId({ id: TID, projectId: 'p' }), 'p');
  assert.equal(S.workspaceProjectId({ id: TID, projectId: 'p', worktree: wt }), `p__wt_${TID}`);
  assert.equal(S.workspaceProjectId({ id: TID, projectId: 'p', worktree: { ...wt, mergedAt: 5 } }), `p__wt_${TID}`);
});

test('worktreeBranchName: slug + 4 id chars, fallback for empty titles', () => {
  assert.equal(S.worktreeBranchName('Fix the Auth bug!', TID), 'olympus/fix-the-auth-bug-7f7c');
  assert.equal(S.worktreeBranchName(undefined, TID), 'olympus/chat-7f7c');
  assert.equal(S.worktreeBranchName('   ', TID), 'olympus/chat-7f7c');
  // Non-ASCII titles still give a git-safe name (accents currently become separators: 'u-ni-c-de').
  assert.match(S.worktreeBranchName('Ünïcødé — ✨', TID), /^olympus\/[a-z0-9]+(-[a-z0-9]+)*-7f7c$/);
  const long = S.worktreeBranchName('a'.repeat(31) + ' bcdef', TID);
  assert.ok(!/--|-$/.test(long.replace(/-7f7c$/, '')), long);
  assert.ok(long.length <= 'olympus/'.length + 32 + 5);
});

test('worktreeDir: <sharedRoot>/worktrees/<projectId>/<8 chars of the thread id>', () => {
  assert.equal(W.worktreeDir('/s', 'proj', TID), '/s/worktrees/proj/7f7c6503');
});

test('isEnvFile: .env and .env.* only', () => {
  assert.ok(W.isEnvFile('.env'));
  assert.ok(W.isEnvFile('.env.local'));
  assert.ok(!W.isEnvFile('.envrc'));
  assert.ok(!W.isEnvFile('env'));
  assert.deepEqual([...W.LINKED_DIRS], ['node_modules', '.venv', 'venv']);
});

test('parsePorcelainZ: modified, untracked, renamed (new path), dir entries', () => {
  const out = [' M src/a.ts', '?? new file.txt', 'R  b-new.ts', 'b-old.ts', 'A  dir/', 'D  gone.ts', ''].join('\0');
  assert.deepEqual(W.parsePorcelainZ(out), ['src/a.ts', 'new file.txt', 'b-new.ts', 'dir', 'gone.ts']);
  assert.deepEqual(W.parsePorcelainZ(''), []);
});

test('parseLeftRight: "<behind>\\t<ahead>"', () => {
  assert.deepEqual(W.parseLeftRight('2\t5\n'), { behind: 2, ahead: 5 });
  assert.deepEqual(W.parseLeftRight('0 0'), { behind: 0, ahead: 0 });
  assert.deepEqual(W.parseLeftRight(''), { behind: 0, ahead: 0 });
});

test('parseWorktreeList: main first, branch names without refs/heads, detached has none', () => {
  const out = [
    'worktree /repo',
    'HEAD 1111',
    'branch refs/heads/main',
    '',
    'worktree /s/worktrees/p/7f7c6503',
    'HEAD 2222',
    'branch refs/heads/olympus/x-7f7c',
    '',
    'worktree /tmp/detached',
    'HEAD 3333',
    'detached',
    '',
  ].join('\n');
  assert.deepEqual(W.parseWorktreeList(out), [
    { path: '/repo', branch: 'main' },
    { path: '/s/worktrees/p/7f7c6503', branch: 'olympus/x-7f7c' },
    { path: '/tmp/detached' },
  ]);
});

console.log(`\n${passed} worktree unit tests passed`);
