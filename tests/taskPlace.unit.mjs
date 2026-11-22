// Unit tests: taskThread / taskPlace (src/renderer/src/taskPlace.ts) — the heat toast names a busy program's
// project and chat, and Show opens that chat (user's request, 2026-11-21: "click karke waha jana chahiye").
// Run: node tests/taskPlace.unit.mjs
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    else if (spec.startsWith('./') && ctx.parentURL?.includes('/src/shared/') && !/\.\w+$/.test(spec)) spec = new URL(`${spec}.ts`, ctx.parentURL).href;
    return next(spec, ctx);
  },
});
const { taskThread, taskPlace } = await import(`${APP}/src/renderer/src/taskPlace.ts`);

const projects = [
  { id: 'p1', name: 'ml-prize-hunter' },
  { id: 'p2', name: 'oss-bounty-hunter' },
];
const threads = [
  { id: 't1', projectId: 'p1', title: 'Train the model', updatedAt: 100 },
  { id: 't2', projectId: 'p1', title: 'Older chat', updatedAt: 50 },
  { id: 't3', projectId: 'p2', title: 'Watchers', updatedAt: 200 },
  { id: 't4', projectId: 'p1', title: 'Worktree chat', updatedAt: 300, worktree: { path: '/tmp/wt', branch: 'olympus/x', baseBranch: 'main', status: 'active' } },
  { id: 'g1', projectId: 'general', title: 'Quick question', updatedAt: 10 },
];

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

test("an agent's program: its own chat and project", () => {
  assert.equal(taskThread({ threadId: 't2', projectId: 'p1' }, threads).id, 't2');
  assert.deepEqual(taskPlace({ threadId: 't2', projectId: 'p1' }, threads, projects), { project: 'ml-prize-hunter', chat: 'Older chat' });
});
test("a terminal the user opened (no chat): the project's most recent non-worktree chat", () => {
  assert.equal(taskThread({ projectId: 'p1' }, threads).id, 't1');
  assert.deepEqual(taskPlace({ projectId: 'p1' }, threads, projects), { project: 'ml-prize-hunter', chat: 'Train the model' });
});
test("a worktree chat's terminal (virtual project id): that chat, named by the real project", () => {
  assert.equal(taskThread({ projectId: 'p1__wt_t4' }, threads).id, 't4');
  assert.deepEqual(taskPlace({ projectId: 'p1__wt_t4' }, threads, projects), { project: 'ml-prize-hunter', chat: 'Worktree chat' });
});
test('a chat not loaded in this window still opens by id; project from the task', () => {
  assert.deepEqual(taskThread({ threadId: 'zz', projectId: 'p2' }, threads), { id: 'zz', meta: undefined });
  assert.deepEqual(taskPlace({ threadId: 'zz', projectId: 'p2' }, threads, projects), { project: 'oss-bounty-hunter' });
});
test('Chat mode (general project) reads "Chat"', () => {
  assert.deepEqual(taskPlace({ threadId: 'g1' }, threads, projects), { project: 'Chat', chat: 'Quick question' });
});
test('nothing known: no chat to open, no place words', () => {
  assert.equal(taskThread({}, threads), undefined);
  assert.deepEqual(taskPlace({}, threads, projects), {});
  assert.equal(taskThread({ projectId: 'nope' }, threads), undefined);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
