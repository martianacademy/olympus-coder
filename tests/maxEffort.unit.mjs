import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_EFFORT,
  buildBlindPrompt,
  buildCarryoverLedger,
  buildCritiquePrompt,
  buildSynthesisPrompt,
  clampThoughtWindow,
  extractMindTrace,
  normalizeMaxEffort,
  parseVerdictConverged,
  pickDefaultCriticAgent,
} from '../src/shared/maxEffort.ts';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    pass++;
  } catch (err) {
    console.error(`FAIL  ${name}\n`, err);
    fail++;
  }
}

test('normalizeMaxEffort clamps maxRounds (1..4) and watchdogSeconds (0 or 30..600)', () => {
  assert.deepEqual(normalizeMaxEffort({ maxRounds: 9, watchdogSeconds: 10 }), { maxRounds: 4, watchdogSeconds: 30 });
  assert.deepEqual(normalizeMaxEffort({ maxRounds: 0, watchdogSeconds: 0 }), { maxRounds: 1, watchdogSeconds: 0 });
  assert.deepEqual(normalizeMaxEffort({ criticAgentId: '  antigravity  ' }, DEFAULT_MAX_EFFORT), {
    criticAgentId: 'antigravity',
    maxRounds: 2,
    watchdogSeconds: 180,
  });
});

test('pickDefaultCriticAgent selects a ready agent from a different model family', () => {
  const defs = [
    { id: 'claude', name: 'Claude Code', badge: 'CC', color: '#f97316', description: '', builtin: true, command: 'claude', args: [] },
    { id: 'codex', name: 'Codex', badge: 'CX', color: '#10b981', description: '', builtin: true, command: 'codex', args: [] },
    { id: 'antigravity', name: 'Antigravity', badge: 'AG', color: '#3b82f6', description: '', builtin: true, command: 'agy', args: [] },
  ];
  const statuses = {
    claude: { id: 'claude', state: 'ready', authMethods: [], hasApiKey: false, canLogout: false },
    codex: { id: 'codex', state: 'needs-login', authMethods: [], hasApiKey: false, canLogout: false },
    antigravity: { id: 'antigravity', state: 'ready', authMethods: [], hasApiKey: false, canLogout: false },
  };
  assert.equal(pickDefaultCriticAgent('claude', defs, statuses), 'antigravity');
  assert.equal(pickDefaultCriticAgent('antigravity', defs, statuses), 'claude');
});

test('extractMindTrace merges streamed ACP thought chunks and <scratchpad> fallback while stripping <scratchpad> from reply', () => {
  const items = [
    { kind: 'thought', id: 't1', agentId: 'antigravity', text: 'Tried mod 5 invariance first.', ts: 1 },
    {
      kind: 'agent',
      id: 'a1',
      agentId: 'antigravity',
      text: '<scratchpad>Discarded mod 13 because doubling breaks it.</scratchpad>\n\nCandidate max is 12.',
      ts: 2,
    },
  ];
  const res = extractMindTrace(items);
  assert.ok(res.thought.includes('Tried mod 5 invariance first.'));
  assert.ok(res.thought.includes('Discarded mod 13 because doubling breaks it.'));
  assert.equal(res.reply, 'Candidate max is 12.');
});

test('clampThoughtWindow bounds runaway 50k thinking traces while preserving head and tail insights', () => {
  const long = 'HEAD_SPARK_MOD5 ' + 'x'.repeat(20_000) + ' TAIL_STUCK_CLIQUE';
  const clamped = clampThoughtWindow(long, 1000);
  assert.ok(clamped.length <= 1050);
  assert.ok(clamped.startsWith('HEAD_SPARK_MOD5'));
  assert.ok(clamped.endsWith('TAIL_STUCK_CLIQUE'));
  assert.ok(clamped.includes('[middle thinking omitted]'));
});

test('parseVerdictConverged enforces explicit VERDICT: CONVERGED and rejects FATAL_FLAW or CONTINUE', () => {
  assert.equal(parseVerdictConverged('Everything looks good, I agree!'), false);
  assert.equal(parseVerdictConverged('Checked all pairs.\nVERDICT: CONVERGED'), true);
  assert.equal(parseVerdictConverged('VERDICT: CONVERGED\nWait: FATAL_FLAW: x=27 breaks'), false);
  assert.equal(parseVerdictConverged('VERDICT: CONVERGED\nActually:\nVERDICT: CONTINUE'), false);
});

test('buildCritiquePrompt includes watchdog rescue notice, rolling ledger, and peer raw thinking', () => {
  const ledger = buildCarryoverLedger([
    {
      round: 0,
      phase: 'blind',
      solverThought: 'st',
      solverReply: 'Solver proposed 11',
      criticThought: 'ct',
      criticReply: 'Critic proposed 12',
      solverConverged: false,
      criticConverged: false,
      durationMs: 1000,
    },
  ]);
  const prompt = buildCritiquePrompt({
    problemText: 'Find max |S|.',
    round: 1,
    maxRounds: 2,
    role: 'critic',
    ownPrevReply: 'My prior check',
    peerName: 'Antigravity',
    peerThought: 'K4 and K3 limit |S| <= 11',
    peerReply: '',
    peerWatchdog: true,
    ledger,
  });
  assert.ok(prompt.includes('Stuck-Thinking Watchdog'));
  assert.ok(prompt.includes('K4 and K3 limit |S| <= 11'));
  assert.ok(prompt.includes('Prior Rounds Ledger'));
  assert.ok(buildBlindPrompt('Find max |S|.', 'solver').includes('<scratchpad>'));
  assert.ok(
    buildSynthesisPrompt({
      problemText: 'Find max |S|.',
      rounds: [
        {
          round: 1,
          phase: 'critique',
          solverThought: '',
          solverReply: 'Max is 12',
          criticThought: '',
          criticReply: 'Verified 66 pairs',
          solverConverged: true,
          criticConverged: true,
          durationMs: 2000,
        },
      ],
      converged: true,
      solverName: 'Claude Code',
      criticName: 'Antigravity',
    }).includes('CONVERGED'),
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
