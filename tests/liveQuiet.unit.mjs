// Unit tests: the chat's live lines notice when the agent has gone quiet (src/renderer/src/liveQuiet.ts) —
// the step fingerprint changes on every new chunk / status / output and nothing else, and the quiet label
// and hover text only show from 20 s.
// Run: node tests/liveQuiet.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; no Electron needed)
import assert from 'node:assert/strict';

const { stepSignature, quietLabel, quietTip, QUIET_AFTER_MS, SHOW_QUIET_AFTER_MS } = await import('../src/renderer/src/liveQuiet.ts');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
};

const agent = (text) => ({ kind: 'agent', id: 'a1', agentId: 'antigravity', text, ts: 1 });
const tool = (patch = {}) => ({
  kind: 'tool',
  id: 't1',
  agentId: 'antigravity',
  toolCallId: 'c1',
  title: 'File package.json',
  toolKind: 'edit',
  status: 'in_progress',
  content: [{ type: 'diff', path: '/x/package.json', oldText: null, newText: '{}' }],
  locations: ['/x/package.json'],
  ts: 1,
  ...patch,
});

test('no step: empty fingerprint', () => assert.equal(stepSignature(undefined), ''));
test('reply text: same text keeps the fingerprint, a new chunk changes it', () => {
  assert.equal(stepSignature(agent('Ab main')), stepSignature(agent('Ab main')));
  assert.notEqual(stepSignature(agent('Ab main')), stepSignature(agent('Ab main files likh raha hu')));
});
test('thought text counts like a reply', () => {
  const th = (text) => ({ kind: 'thought', id: 'th', agentId: 'claude', text, ts: 1 });
  assert.notEqual(stepSignature(th('a')), stepSignature(th('ab')));
});
test('tool: status change, more output, terminal output each change the fingerprint', () => {
  const base = stepSignature(tool());
  assert.equal(base, stepSignature(tool()));
  assert.notEqual(base, stepSignature(tool({ status: 'completed' })));
  assert.notEqual(base, stepSignature(tool({ content: [...tool().content, { type: 'text', text: 'Created file.' }] })));
  assert.notEqual(base, stepSignature(tool({ content: [{ type: 'text', text: 'line 1' }] })), 'different output');
  assert.notEqual(stepSignature(tool({ terminalText: 'a' })), stepSignature(tool({ terminalText: 'ab' })));
});
test('plan: an entry moving on changes the fingerprint', () => {
  const plan = (status) => ({ kind: 'plan', id: 'p1', agentId: 'claude', entries: [{ content: 'Write files', status, priority: 'medium' }], ts: 1 });
  assert.equal(stepSignature(plan('pending')), stepSignature(plan('pending')));
  assert.notEqual(stepSignature(plan('pending')), stepSignature(plan('in_progress')));
});
test('a different step id is a different step', () => {
  assert.notEqual(stepSignature(tool()), stepSignature(tool({ id: 't2' })));
});
test('thresholds: "being written" ends before the quiet label appears', () => {
  assert.ok(QUIET_AFTER_MS > 0 && QUIET_AFTER_MS < SHOW_QUIET_AFTER_MS);
});
test('quiet label only from 20 s, in whole seconds', () => {
  assert.equal(quietLabel(0), '');
  assert.equal(quietLabel(SHOW_QUIET_AFTER_MS - 1), '');
  assert.equal(quietLabel(SHOW_QUIET_AFTER_MS), 'quiet 20s');
  assert.equal(quietLabel(61_400), 'quiet 61s');
});
test('hover text only from 20 s, names the agent and says it is still working', () => {
  assert.equal(quietTip('Antigravity', 5_000), undefined);
  const tip = quietTip('Antigravity', 45_000);
  assert.match(tip, /^Antigravity has sent nothing new for 45s\. It is still working/);
});

console.log(`\n${passed}/${passed} passed`);
