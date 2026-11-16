// Unit tests for src/main/subtaskOutcome.ts: a finished sub-session must keep the same result identity when the
// agent later runs a maintenance turn on its own (e.g. "Agent-initiated work" → Compact conversation), and a new
// reply from such a turn must count as news. Run: node --experimental-strip-types tests/subtaskOutcome.unit.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isSideTurn, lastTaskIndex, outcomeLine, resultItem } from '../src/main/subtaskOutcome.ts';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('PASS ', name); } catch (e) { fail++; console.log('FAIL ', name, '—', e.message); } };
const u = (id, extra = {}) => ({ kind: 'user', id, agentId: 'claude', text: 'task', ts: 1, ...extra });
const ag = (id) => ({ kind: 'agent', id, agentId: 'claude', text: `reply ${id}`, ts: 2 });
const tool = (id) => ({ kind: 'tool', id, agentId: 'claude', title: 'Compact conversation', toolKind: 'think', status: 'completed', content: [], locations: [], ts: 3 });
const err = (id) => ({ kind: 'error', id, agentId: 'claude', text: 'boom', ts: 4 });

t('agent-initiated user items are side turns (flag and legacy text)', () => {
  assert.equal(isSideTurn(u('a', { agentInitiated: true })), true);
  assert.equal(isSideTurn(u('b', { fromApp: true, text: 'Agent-initiated work' })), true);
  assert.equal(isSideTurn(u('c', { viaAgent: true })), true);
  assert.equal(isSideTurn(u('d', { fromApp: true, text: '[Olympus Coder] your sub-sessions finished' })), false);
  assert.equal(isSideTurn(u('e')), false);
});
t('compaction turn after the report keeps the same result', () => {
  const base = [u('t1'), tool('x'), ag('r1')];
  const later = [...base, u('ai', { fromApp: true, agentInitiated: true, text: 'Agent-initiated work' }), tool('compact')];
  assert.equal(resultItem(base).id, 'r1');
  assert.equal(resultItem(later).id, 'r1');
  assert.equal(lastTaskIndex(later), 0);
});
t('a new reply from an agent-initiated turn is a new result', () => {
  const items = [u('t1'), ag('r1'), u('ai', { agentInitiated: true }), ag('r2')];
  assert.equal(resultItem(items).id, 'r2');
});
t('a real follow-up task resets the result to its own outcome', () => {
  assert.equal(resultItem([u('t1'), ag('r1'), u('t2')]).id, 't2');
  assert.equal(resultItem([u('t1'), ag('r1'), u('t2'), ag('r2')]).id, 'r2');
});
t('an error after the reply is the result; a reply after an error wins back', () => {
  assert.equal(resultItem([u('t1'), ag('r1'), err('e1')]).id, 'e1');
  assert.equal(resultItem([u('t1'), err('e1'), ag('r1')]).id, 'r1');
});
t('outcomeLine is one meaningful line', () => {
  const v = { meta: {}, status: 'done', lastReply: '**Phase 2 is done.** All green.\nmore', filesTouched: ['a', 'b'], toolCount: 3, pendingPermissions: 0 };
  assert.equal(outcomeLine(v), 'done: Phase 2 is done. All green. · 2 files changed');
  assert.equal(outcomeLine({ ...v, status: 'failed', error: 'Model X not supported', filesTouched: [] }), 'failed: Model X not supported');
  assert.equal(outcomeLine({ ...v, status: 'idle', filesTouched: [] }), 'ended without a reply');
});

// Real threads that produced the bogus "finished (idle)" wake-ups on 2026-11-16.
const dir = join(homedir(), '.agents/threads/fce12d12-79c6-4b13-85bc-33262fc92faf');
const ids = ['ee06f582-020c-43ac-b5f1-f1113edad58d', '3ec4dda1-9d44-4069-b6e5-630f29aa2c5d', 'b777effd-3e51-484c-8221-f73f1cf79888', '01c6b2d3-9f21-4e3e-b32a-542f3ebe11b5', 'da46a704-e9c2-4df8-87d3-64de769d533e'];
for (const id of ids) {
  const f = join(dir, `${id}.json`);
  if (!existsSync(f)) continue;
  const items = JSON.parse(readFileSync(f, 'utf8')).items;
  t(`real thread ${id.slice(0, 8)}: result is the agent's last report, not the later maintenance turn`, () => {
    const r = resultItem(items);
    assert.equal(r?.kind, 'agent');
    // cut the thread right after that report: the identity must be the same as on the full thread
    const cutAt = items.findIndex((i) => i.id === r.id);
    assert.equal(resultItem(items.slice(0, cutAt + 1)).id, r.id);
  });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
