// Unit tests: token-saving rules of the operating guide (src/main/guide.ts, skills.ts, memory.ts).
// Guide hash stable across setting changes, resume sends the guide exactly once (byte-identical system prompt plus a
// compact section delta), lean worker guide, Claude session `_meta` (sub-session idleCompaction off, Workflow blocked),
// no duplicate skills / MEMORY.md for Claude.
// Run: node tests/guideTokens.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; `electron` is stubbed)
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = mkdtempSync(join(tmpdir(), 'olympus-guide-unit-'));
const UD = join(TMP, 'userData');
const HOME = join(TMP, 'home');
const SHARED = join(TMP, 'shared');
const PROJ = join(TMP, 'proj');
for (const d of [UD, HOME, SHARED, PROJ]) mkdirSync(d, { recursive: true });
// Before any import: skills.ts / memory.ts read ~/.claude through os.homedir() (HOME), store.ts reads the shared root.
process.env.HOME = HOME;
process.env.AGENTDESK_SHARED_ROOT = SHARED;
writeFileSync(join(UD, 'settings.json'), JSON.stringify({ sharedRoot: SHARED, designVersion: 2, orchestrator: { enabled: true, maxParallel: 3, maxPerSession: 8 } }));

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'mock:electron', shortCircuit: true };
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
  load(url, ctx, next) {
    // A stub of the few electron APIs these modules touch at import or call time (labelled mock, not the real app).
    if (url === 'mock:electron')
      return { format: 'module', shortCircuit: true, source: `export const app = { getPath: () => ${JSON.stringify(UD)} }; export const safeStorage = { isEncryptionAvailable: () => false }; export const shell = {};` };
    return next(url, ctx);
  },
});

const S = await import(`${APP}/src/main/store.ts`);
const G = await import(`${APP}/src/main/guide.ts`);
const M = await import(`${APP}/src/main/memory.ts`);

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${String(e?.stack ?? e).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

// Fixtures: one project, a main chat and a worker spawned by it, two shared skills (one also in ~/.claude/skills).
const project = S.addProject(PROJ);
const main = S.createThread(project.id, 'claude', { title: 'Main chat' });
const worker = S.createThread(project.id, 'claude', { title: 'Worker', spawnedBy: main.id, parentId: main.id });
const skill = (root, id, desc) => {
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, id, 'SKILL.md'), `---\nname: ${id}\ndescription: ${desc}\n---\n\nBody.\n`);
};
skill(join(SHARED, 'skills'), 'video-maker', 'Make videos.');
skill(join(SHARED, 'skills'), 'db-setup', 'Set up databases.');
skill(join(HOME, '.claude', 'skills'), 'video-maker', 'Make videos.');
const memDir = M.ensureMemory(project);
writeFileSync(join(memDir, 'MEMORY.md'), '# Shared memory index\n\n- [Arch](arch.md) — architecture map\n');
writeFileSync(join(memDir, 'arch.md'), '---\nname: arch\ndescription: architecture map\nmetadata:\n  type: project\n---\n\nBody.\n');
writeFileSync(join(memDir, 'loose.md'), '---\nname: loose\ndescription: not in the index\n---\n\nBody.\n');
writeFileSync(join(memDir, 'BUGS.md'), '# Bugs\n\n## Some bug — 2026-11-16\n- Error: x\n');

const CLAUDE_CAPS = { sessionCapabilities: { systemPrompt: { mode: { override: {} } } } };
const AGY_CAPS = { _meta: { antigravity: { systemPrompt: { append: true } } } };
const count = (hay, needle) => hay.split(needle).length - 1;

await test('guide hash is stable when orchestrator limits change (no numbers in the guide)', () => {
  const before = G.buildGuide(project, main, 'claude');
  S.updateSettings({ orchestrator: { enabled: true, maxParallel: 6, maxPerSession: 20 } });
  const after = G.buildGuide(project, main, 'claude');
  assert.equal(G.guideHash(after), G.guideHash(before));
  assert.equal(after, before);
  assert.ok(/session_info/.test(after.match(/- Limits:.*$/m)[0]), 'the limits line points at session_info');
});

await test('guide hash ignores title changes, not content changes', () => {
  const a = G.buildGuide(project, main, 'claude');
  const b = G.buildGuide(project, { ...main, title: 'Renamed chat' }, 'claude');
  assert.notEqual(a, b);
  assert.equal(G.guideHash(a), G.guideHash(b));
  assert.notEqual(G.guideHash(a), G.guideHash(`${a}\n\n## Extra\n\nnew rule`));
});

await test('guide has no date, time or counts that change by themselves', () => {
  const g = G.buildGuide(project, main, 'claude');
  assert.ok(!/\b20\d\d-\d\d-\d\d\b/.test(g), 'no ISO date');
  assert.ok(!/\b\d{1,2}:\d\d\b/.test(g), 'no clock time');
});

await test('resume: a recorded session gets its original system prompt back, byte for byte', () => {
  const original = G.buildGuide(project, main, 'claude');
  const changed = `${original}\n\n## New section\n\nA new rule.`;
  const prior = { system: original, current: original };
  assert.equal(G.reattachSystemText(prior, changed, CLAUDE_CAPS, 'claude'), original);
  assert.equal(G.reattachSystemText(prior, original, CLAUDE_CAPS, 'claude'), original);
  // A session created without a system prompt (guide went in its first message) gets none on resume.
  assert.equal(G.reattachSystemText({ system: '', current: original }, changed, CLAUDE_CAPS, 'claude'), undefined);
});

await test('resume: a session without a record gets the current guide on Claude only (else it would have none)', () => {
  const g = G.buildGuide(project, main, 'claude');
  assert.equal(G.reattachSystemText(undefined, g, CLAUDE_CAPS, 'claude'), g);
  assert.equal(G.reattachSystemText(undefined, g, CLAUDE_CAPS, 'codex'), undefined);
  assert.equal(G.reattachSystemText(undefined, g, AGY_CAPS, 'antigravity'), undefined);
  assert.equal(G.reattachSystemText({ system: g, current: g }, g, AGY_CAPS, 'antigravity'), undefined);
  assert.equal(G.reattachSystemText(undefined, '', CLAUDE_CAPS, 'claude'), undefined);
});

await test('resume with an unchanged guide: guide present exactly once, no update message', () => {
  const g = G.buildGuide(project, main, 'claude');
  const sys = G.reattachSystemText({ system: g, current: g }, g, CLAUDE_CAPS, 'claude');
  const update = G.guideUpdate(g, g);
  assert.equal(update, '');
  assert.equal(count(`${sys}\n${update}`, '# Olympus Coder — operating guide'), 1);
  assert.equal(G.guideUpdate(g, G.buildGuide(project, { ...main, title: 'Other title' }, 'claude')), '', 'a title-only change sends nothing');
});

await test('resume with a changed guide: old system prompt + one compact delta with only the changed section', () => {
  const g1 = G.buildGuide(project, main, 'claude');
  const g2 = g1.replace('## Honesty — strict, no exceptions\n', '## Honesty — strict, no exceptions\n\n- A new honesty rule.\n');
  assert.notEqual(G.guideHash(g1), G.guideHash(g2));
  const sys = G.reattachSystemText({ system: g1, current: g1 }, g2, CLAUDE_CAPS, 'claude');
  const update = G.guideUpdate(g1, g2);
  assert.equal(sys, g1, 'system prompt unchanged');
  assert.equal(count(`${sys}\n${update}`, '# Olympus Coder — operating guide'), 1, 'the full guide is there once');
  assert.ok(update.includes('- A new honesty rule.'));
  assert.equal(count(update, '\n## '), 1, 'only the changed section');
  assert.ok(!update.includes('## How to work a problem'));
  assert.ok(update.length < g2.length / 3, `delta ${update.length} chars vs guide ${g2.length}`);
});

await test('guide update names removed sections and falls back to the full guide without a base', () => {
  const g1 = G.buildGuide(project, main, 'claude');
  const g2 = g1.replace(/\n\n## Progress updates & final reply style[\s\S]*?(?=\n\n## )/, '');
  assert.notEqual(g1, g2);
  const update = G.guideUpdate(g1, g2);
  assert.match(update, /no longer apply: "Progress updates & final reply style"/);
  const full = G.guideUpdate('', g2);
  assert.ok(full.endsWith(g2) && full.startsWith('[Olympus Coder] Your operating guide has been updated.'));
});

await test('guide update falls back to the full guide when a heading repeats (user markdown in project instructions)', () => {
  const g1 = G.buildGuide(project, main, 'claude');
  const g2 = `${g1}\n\n## Notes\n\none\n\n## Notes\n\ntwo`;
  assert.ok(G.guideUpdate(g1, g2).endsWith(g2));
});

await test('session guide record round-trips on disk', () => {
  G.writeSessionGuide('sess/1:a', { system: 'S', current: 'C' });
  assert.deepEqual(G.readSessionGuide('sess/1:a'), { system: 'S', current: 'C' });
  assert.equal(G.readSessionGuide('missing'), undefined);
});

await test('worker guide is lean but keeps honesty, memory write-back and verification rules', () => {
  for (const agent of ['claude', 'codex', 'antigravity']) {
    const m = G.buildGuide(project, { ...main, agentId: agent }, agent);
    const w = G.buildGuide(project, { ...worker, agentId: agent }, agent);
    assert.ok(w.length < m.length * 0.6, `${agent}: worker ${w.length} vs main ${m.length}`);
    assert.ok(w.includes('## Honesty — strict, no exceptions'));
    assert.ok(w.includes('Worker role exception'));
    assert.ok(w.includes('BUGS.md'));
    assert.ok(/Verify: type-check, build, run the tests/.test(w));
    assert.ok(w.includes('## Your role: sub-session (worker)'));
    assert.ok(!w.includes('## Your role: orchestrator'));
    assert.ok(!w.includes('## Learning about the user'));
  }
});

await test('Claude guide leaves out shared skills Claude lists itself; other agents get all', () => {
  const c = G.buildGuide(project, main, 'claude');
  assert.ok(c.includes('**db-setup**'));
  assert.ok(!c.includes('**video-maker**'));
  const x = G.buildGuide(project, { ...main, agentId: 'codex' }, 'codex');
  assert.ok(x.includes('**db-setup**') && x.includes('**video-maker**'));
  const w = G.buildGuide(project, { ...worker, agentId: 'codex' }, 'codex');
  assert.ok(!w.includes('**db-setup**') && w.includes('/<skill>/SKILL.md'), 'workers get the folder, not the list');
});

await test('Claude preamble does not repeat MEMORY.md (auto-memory has it); others get the catalog', () => {
  const c = M.buildPreamble(project, main, 'claude', false);
  assert.ok(!c.includes('architecture map'), 'indexed entry not repeated');
  assert.ok(c.includes('loose.md'), 'unindexed file still listed');
  assert.ok(c.includes('BUGS.md'));
  const x = M.buildPreamble(project, main, 'codex', false);
  assert.ok(x.includes('architecture map') && x.includes('arch.md'));
  // Auto-memory turned off in Claude's settings: the full catalog again.
  mkdirSync(join(PROJ, '.claude'), { recursive: true });
  writeFileSync(join(PROJ, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryEnabled: false }));
  assert.ok(M.buildPreamble(project, main, 'claude', false).includes('architecture map'));
  rmSync(join(PROJ, '.claude', 'settings.local.json'));
});

await test('Claude session meta: sub-sessions get idleCompaction false, main keeps it; Workflow blocked in both', () => {
  const w = G.claudeSessionMeta('claude', '/mem', true)._meta.claudeCode.options;
  const m = G.claudeSessionMeta('claude', '/mem', false)._meta.claudeCode.options;
  assert.equal(w.settings.idleCompaction, false);
  assert.equal(w.settings.autoMemoryDirectory, '/mem');
  assert.ok(!('idleCompaction' in m.settings));
  assert.deepEqual(w.disallowedTools, ['Workflow']);
  assert.deepEqual(m.disallowedTools, ['Workflow']);
  assert.deepEqual(G.claudeSessionMeta('codex', '/mem', true), {});
});

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
