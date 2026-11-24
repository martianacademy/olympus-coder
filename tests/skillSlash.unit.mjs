/**
 * Unit tests for composer `/skill` parsing and universal `<active_skill>` injection (`src/main/skillSlash.ts`),
 * plus validation of the 6 domain playbooks in `~/.olympus/skills/`.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseSlashToken, resolveSkillSlash } from '../src/shared/skillSlash.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const fakeSkills = [
  { id: 'quantum', name: 'quantum', description: 'Quantum mechanics & QC playbook', path: '/tmp/skills/quantum/SKILL.md', enabled: true, body: '# Quantum Playbook\nCheck unitarity and CPTP.' },
  { id: 'math', name: 'math', description: 'Mathematical proof playbook', path: '/tmp/skills/math/SKILL.md', enabled: true, body: '# Math Playbook\nVerify lower and upper bounds.' },
  { id: 'compact', name: 'compact', description: 'Collision test skill', path: '/tmp/skills/compact/SKILL.md', enabled: true, body: '# Should never shadow native /compact' },
  { id: 'disabled-one', name: 'disabled-one', description: 'Off', path: '/tmp/skills/disabled-one/SKILL.md', enabled: false, body: '# Disabled' },
  { id: 'huge', name: 'huge', description: 'Oversized body', path: '/tmp/skills/huge/SKILL.md', enabled: true, body: 'X'.repeat(20_000) },
];

const deps = {
  listSkills: () => fakeSkills.map(({ body: _b, ...rest }) => rest),
  getSkill: (id) => {
    const found = fakeSkills.find((s) => s.id === id);
    if (!found) throw new Error('not found');
    return found;
  },
};

test('parseSlashToken extracts leading /token and inline or multiline instructions', () => {
  assert.deepEqual(parseSlashToken('/quantum Prove entanglement'), { token: 'quantum', rest: 'Prove entanglement' });
  assert.deepEqual(parseSlashToken('  /Math\nLine 1\nLine 2'), { token: 'math', rest: 'Line 1\nLine 2' });
  assert.deepEqual(parseSlashToken('/quantum'), { token: 'quantum', rest: '' });
  assert.equal(parseSlashToken('normal message without slash'), null);
});

test('resolveSkillSlash injects full SKILL.md playbook and strips /token from userText', () => {
  const res = resolveSkillSlash('/quantum Verify Bell state entanglement', [{ name: 'compact' }], deps);
  assert.ok(res);
  assert.equal(res.skillId, 'quantum');
  assert.equal(res.userText, 'Verify Bell state entanglement');
  assert.match(res.skillBlock, /<active_skill name="quantum" id="quantum"/);
  assert.match(res.skillBlock, /Check unitarity and CPTP/);
});

test('resolveSkillSlash never shadows native agent ACP slash commands', () => {
  const res = resolveSkillSlash('/compact', [{ name: 'compact' }, { name: '/review' }], deps);
  assert.equal(res, null);
});

test('resolveSkillSlash ignores disabled skills and unknown commands', () => {
  assert.equal(resolveSkillSlash('/disabled-one test', [], deps), null);
  assert.equal(resolveSkillSlash('/does-not-exist test', [], deps), null);
});

test('resolveSkillSlash caps oversized skill bodies safely with path pointer', () => {
  const res = resolveSkillSlash('/huge run', [], deps);
  assert.ok(res);
  assert.ok(res.skillBlock.length < 17_000);
  assert.match(res.skillBlock, /skill body truncated/);
});

test('all 6 domain playbooks exist in ~/.olympus/skills with valid frontmatter and methodology', () => {
  for (const id of ['math', 'quantum', 'physics', 'security', 'research', 'coder']) {
    const p = join(homedir(), '.olympus', 'skills', id, 'SKILL.md');
    assert.ok(existsSync(p), `Missing domain skill: ${p}`);
    const raw = readFileSync(p, 'utf8');
    assert.match(raw, new RegExp(`^---\\nname:\\s*${id}\\b`), `Frontmatter name mismatch in ${p}`);
    assert.match(raw, /\ndescription:\s*"?.+"?\n---/, `Frontmatter description missing in ${p}`);
    assert.ok(raw.length > 800, `Skill ${id} looks unexpectedly thin (${raw.length} chars)`);
  }
});

console.log(`\n${passed} passed, 0 failed`);
