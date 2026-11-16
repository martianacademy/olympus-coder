// Unit tests for src/main/disposableSubsessions.ts: when a spawned sub-session is deleted by itself.
// Run: node tests/disposableSubsessions.unit.mjs
import assert from 'node:assert/strict';
import { DisposableTracker } from '../src/main/disposableSubsessions.ts';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('PASS ', name); } catch (e) { fail++; console.log('FAIL ', name, '—', e.message); } };
const c = (status, extra = {}) => ({ id: 'a', disposable: true, status, key: `a@${status}@r1`, active: false, ...extra });

t('finished + report read + turn ended → deleted (done, failed, cancelled)', () => {
  for (const s of ['done', 'failed', 'cancelled']) {
    const d = new DisposableTracker();
    d.markRead(c(s));
    assert.deepEqual(d.due([c(s)]), ['a'], s);
  }
});
t('report not read → kept', () => {
  assert.deepEqual(new DisposableTracker().due([c('done')]), []);
});
t('message / configure before the turn ends cancels it for that round', () => {
  const d = new DisposableTracker();
  d.markRead(c('done'));
  d.reset('a');
  assert.deepEqual(d.due([c('done')]), []);
  // The next round: its new report read again → goes.
  const next = c('done', { key: 'a@done@r2' });
  d.markRead(next);
  assert.deepEqual(d.due([next]), ['a']);
});
t('a newer result than the one read (it was messaged and finished again) → kept until read', () => {
  const d = new DisposableTracker();
  d.markRead(c('done'));
  assert.deepEqual(d.due([c('done', { key: 'a@done@r2' })]), []);
});
t('keep:true (not disposable) is never deleted', () => {
  const d = new DisposableTracker();
  d.markRead(c('done', { disposable: false }));
  d.markRead(c('done', { disposable: undefined, id: 'b' }));
  assert.deepEqual(d.due([c('done', { disposable: false }), c('done', { disposable: undefined, id: 'b' })]), []);
  assert.equal(d.size, 0);
});
t('quota-exceeded / needs-login / idle stay so the parent can switch the agent', () => {
  const d = new DisposableTracker();
  for (const s of ['quota-exceeded', 'needs-login', 'idle']) d.markRead(c(s));
  assert.equal(d.size, 0);
  assert.deepEqual(d.due(['quota-exceeded', 'needs-login', 'idle'].map((s) => c(s))), []);
});
t('running again (active) → not deleted', () => {
  const d = new DisposableTracker();
  d.markRead(c('done'));
  assert.deepEqual(d.due([c('done', { active: true })]), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
