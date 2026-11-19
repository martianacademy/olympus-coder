// Unit tests: agentTitleFor (src/main/sessionUpdates.ts) — the chat title an agent's `session_info_update` suggests.
// Agents that title a chat from its first prompt (ZCode) must never turn Olympus's own `<olympus-context>` block
// into the chat title (seen 2026-11-19: `<olympus-context agent="zcode">…`).
// Run: node tests/agentTitle.unit.mjs
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
});
const { agentTitleFor } = await import(`${APP}/src/main/sessionUpdates.ts`);

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
const chat = (over = {}) => ({ id: 't', projectId: 'p', title: 'New chat', agentId: 'zcode', createdAt: 1, updatedAt: 1, items: [], ...over });

test('a cut-off Olympus context block gives no title', () => {
  assert.equal(agentTitleFor(chat(), '<olympus-context agent="zcode">\nYou are running inside Olympus Coder. Your sys'), undefined);
});

test('a whole context block is dropped and the user text after it becomes the title', () => {
  const t = '<olympus-context agent="zcode">\n## Local time\n\nWednesday\n</olympus-context>\n\nFix the login   bug';
  assert.equal(agentTitleFor(chat(), t), 'Fix the login bug');
});

test('only a leading block is dropped; ordinary titles are unchanged', () => {
  assert.equal(agentTitleFor(chat(), 'Explain <olympus-context> tags'), 'Explain <olympus-context> tags');
  assert.equal(agentTitleFor(chat(), '  Refactor   auth  '), 'Refactor auth');
});

test('existing rules still hold: user rename wins, app-named chats keep their name, non-strings ignored', () => {
  assert.equal(agentTitleFor(chat({ title: 'Mine', titleSetByUser: true }), 'Agent title'), undefined);
  assert.equal(agentTitleFor(chat({ title: 'Sub task', spawnedBy: 'x' }), 'Agent title'), undefined);
  assert.equal(agentTitleFor(chat(), null), undefined);
  assert.equal(agentTitleFor(chat({ title: 'Same' }), 'Same'), undefined);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
