import assert from 'node:assert/strict';
import {
  buildFreshCarryoverSection,
  collectEditedFiles,
  extractCarryoverMeta,
  isFreshCarryoverPending,
  lastTurnTimestamp,
  threadHasConversation,
} from '../src/shared/freshCarryover.ts';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.error(`  FAIL  ${name}:`, err);
  }
}

test('threadHasConversation, lastTurnTimestamp, and isFreshCarryoverPending track thread state accurately', () => {
  assert.equal(threadHasConversation([]), false);
  assert.equal(lastTurnTimestamp([]), 0);
  assert.equal(isFreshCarryoverPending([]), false);

  const items = [
    { kind: 'user', id: 'u1', agentId: 'claude', text: 'Fix billing bug', ts: 1000 },
    { kind: 'agent', id: 'a1', agentId: 'claude', text: 'Found it in src/billing.ts', ts: 2000 },
    { kind: 'context-reset', id: 'r1', agentId: 'claude', ts: 3000, previousUsed: 142_000, estimatedCarryover: 2500, editedFilesCount: 2 },
    { kind: 'notice', id: 'n1', agentId: 'claude', title: 'Session started', ts: 3100 },
  ];
  assert.equal(threadHasConversation(items), true);
  assert.equal(lastTurnTimestamp(items), 2000);
  assert.equal(isFreshCarryoverPending(items), true, 'trailing notice after context-reset still keeps fresh carryover pending');

  items.push({ kind: 'user', id: 'u2', agentId: 'claude', text: 'Continue with tests', ts: 4000 });
  assert.equal(isFreshCarryoverPending(items), false, 'once a new user turn arrives, pending flag clears');
  assert.equal(lastTurnTimestamp(items), 4000);
});

test('collectEditedFiles extracts unique edited/written files while ignoring read-only or failed tool calls', () => {
  const items = [
    { kind: 'tool', id: 't1', agentId: 'claude', callId: 'c1', title: 'Read src/config.ts', toolKind: 'read', status: 'completed', locations: ['src/config.ts'], ts: 1 },
    { kind: 'tool', id: 't2', agentId: 'claude', callId: 'c2', title: 'Edit src/billing.ts', toolKind: 'edit', status: 'completed', locations: ['src/billing.ts'], ts: 2 },
    { kind: 'tool', id: 't3', agentId: 'claude', callId: 'c3', title: 'Edit src/billing.ts', toolKind: 'edit', status: 'completed', locations: ['src/billing.ts'], ts: 3 },
    { kind: 'tool', id: 't4', agentId: 'claude', callId: 'c4', title: 'Write src/logger.ts', status: 'completed', locations: ['src/logger.ts'], ts: 4 },
    { kind: 'tool', id: 't5', agentId: 'claude', callId: 'c5', title: 'Edit src/broken.ts', toolKind: 'edit', status: 'failed', locations: ['src/broken.ts'], ts: 5 },
  ];
  const files = collectEditedFiles(items);
  assert.deepEqual(files.map((f) => f.path), ['src/billing.ts', 'src/logger.ts']);
});

test('buildFreshCarryoverSection produces a compact zero-bloat brief with goal, modified files, recent turns, and transcript pointer', () => {
  const thread = {
    id: 'thr_abc',
    items: [
      { kind: 'user', id: 'u1', agentId: 'codex', text: 'Refactor payment billing validation and add receipt formatter', ts: 1000 },
      { kind: 'tool', id: 't1', agentId: 'codex', callId: 'c1', title: 'Edit src/billing.ts', toolKind: 'edit', status: 'completed', locations: ['src/billing.ts'], ts: 1500 },
      { kind: 'agent', id: 'a1', agentId: 'codex', text: 'Fixed negative amount validation in src/billing.ts.', ts: 2000 },
    ],
  };
  const compact = 'USER: Refactor payment billing validation\n\nCodex [tool completed]: Edit src/billing.ts (src/billing.ts)\n\nCodex: Fixed negative amount validation.';
  const meta = extractCarryoverMeta(thread, compact);
  assert.equal(meta.editedFiles.length, 1);
  assert.ok(meta.estimatedTokens >= 200 && meta.estimatedTokens < 2000);

  const brief = buildFreshCarryoverSection({
    thread,
    compactTranscript: compact,
    transcriptPath: '/Users/test/.olympus/threads/proj1/thr_abc.json',
    previousUsed: 145_000,
  });
  assert.match(brief, /Fresh context carryover/);
  assert.match(brief, /145,000 tokens/);
  assert.match(brief, /Refactor payment billing validation/);
  assert.match(brief, /`src\/billing\.ts`/);
  assert.match(brief, /\/Users\/test\/\.olympus\/threads\/proj1\/thr_abc\.json/);
  assert.match(brief, /re-read any file on demand/i);
});

const failed = results.filter((r) => !r.ok);
console.log(`\nFresh Context Carryover suite: ${results.length - failed.length}/${results.length} passed.`);
if (failed.length) process.exit(1);
