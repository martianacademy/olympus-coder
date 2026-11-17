// Unit tests: chat item order around an Olympus Coder confirm card (src/shared/itemOrder.ts).
// The card is created when the agent's MCP call reaches the app over HTTP; the text the agent streamed just before
// can arrive later over ACP. Items the agent streams while the card waits go above it, in main (saved thread) and
// in the renderers (desktop/phone useAppSync, Tasks panel), which must end with the same order.
// Run: node tests/itemOrder.unit.mjs   (Node ≥ 23 strips the TypeScript types itself)
import assert from 'node:assert/strict';
import { insertIndex, isPendingConfirm, lastStreamItem, pendingConfirmStart, withItem } from '../src/shared/itemOrder.ts';

let n = 0;
const test = (name, fn) => {
  fn();
  n++;
  console.log(`PASS  ${name}`);
};
const user = (id) => ({ kind: 'user', id, agentId: 'claude', text: id, ts: 0 });
const agent = (id) => ({ kind: 'agent', id, agentId: 'claude', text: id, ts: 0 });
const tool = (id) => ({ kind: 'tool', id, agentId: 'claude', title: id, status: 'pending', ts: 0 });
const card = (id, extra = {}) => ({ kind: 'elicitation', id, agentId: 'claude', mode: 'form', message: id, schema: { type: 'object', properties: {} }, confirm: { title: id, rows: [], action: 'Add agent' }, ts: 0, ...extra });
const askCard = (id) => ({ kind: 'elicitation', id, agentId: 'claude', mode: 'form', message: id, schema: { type: 'object', properties: {} }, ts: 0 });
const ids = (items) => items.map((i) => i.id).join(',');

/** Main process: agents.ts addItem (splice at insertIndex) + chunk continuation on lastStreamItem. */
function mainApply(items, ev) {
  if (ev.update) {
    const i = items.findIndex((x) => x.id === ev.update.id);
    items[i] = ev.update;
    return { ...ev.update };
  }
  if (ev.chunk) {
    const last = lastStreamItem(items);
    if (last?.kind === 'agent' && last.id === ev.chunk.into) {
      last.text += ev.chunk.text;
      return { ...last };
    }
    const it = agent(ev.chunk.into);
    it.text = ev.chunk.text;
    items.splice(insertIndex(items, it), 0, it);
    return { ...it };
  }
  items.splice(insertIndex(items, ev.add), 0, ev.add);
  return { ...ev.add };
}

test('a pending confirm card is recognised; resolved cards and agent questions are not', () => {
  assert.equal(isPendingConfirm(card('c')), true);
  assert.equal(isPendingConfirm(card('c', { resolved: 'accepted' })), false);
  assert.equal(isPendingConfirm(askCard('q')), false);
  assert.equal(isPendingConfirm(agent('a')), false);
  assert.equal(isPendingConfirm(undefined), false);
});

test('agent text / tools / thoughts / plans go above a waiting confirm card', () => {
  const items = [user('u'), card('c')];
  for (const it of [agent('a'), tool('t'), { kind: 'thought', id: 'th', agentId: 'claude', text: '', ts: 0 }, { kind: 'plan', id: 'p', agentId: 'claude', entries: [], ts: 0 }]) {
    assert.equal(insertIndex(items, it), 1, it.kind);
  }
  assert.equal(ids(withItem(withItem(items, agent('a')), tool('t'))), 'u,a,t,c');
});

test('user messages, errors and other cards are appended after the card', () => {
  const items = [user('u'), card('c')];
  assert.equal(insertIndex(items, user('u2')), 2);
  assert.equal(insertIndex(items, { kind: 'error', id: 'e', agentId: 'claude', text: 'x', ts: 0 }), 2);
  assert.equal(insertIndex(items, card('c2')), 2);
  assert.equal(insertIndex(items, askCard('q')), 2);
});

test('nothing moves without a waiting card, after it is answered, or when it is not last', () => {
  assert.equal(insertIndex([user('u'), agent('a')], tool('t')), 2);
  assert.equal(insertIndex([user('u'), card('c', { resolved: 'declined' })], agent('a')), 2);
  // The user typed after the card: newer agent items belong after that message.
  assert.equal(insertIndex([user('u'), card('c'), user('u2')], agent('a')), 3);
  // An agent's own question (ACP elicitation) is not an Olympus card: unaffected.
  assert.equal(insertIndex([user('u'), askCard('q')], agent('a')), 2);
});

test('two waiting cards at the end: agent items go above both', () => {
  const items = [user('u'), card('c1'), card('c2')];
  assert.equal(pendingConfirmStart(items), 1);
  assert.equal(ids(withItem(items, agent('a'))), 'u,a,c1,c2');
});

test('a chunk continues the agent text above the card instead of starting a new message', () => {
  const items = [user('u'), agent('a'), card('c')];
  assert.equal(lastStreamItem(items).id, 'a');
  assert.equal(lastStreamItem([user('u')]).id, 'u');
  assert.equal(lastStreamItem([]), undefined);
});

test('withItem replaces a known id in place (card answered keeps its slot)', () => {
  const items = [user('u'), agent('a'), card('c')];
  const out = withItem(items, card('c', { resolved: 'accepted' }));
  assert.equal(ids(out), 'u,a,c');
  assert.equal(out[2].resolved, 'accepted');
  assert.notEqual(out, items);
});

test('race replay: card first (HTTP), then the text + tool row (ACP); main and renderer agree', () => {
  // Reproduced 2026-11-17 with real Claude Code in bypass mode: the MCP tools/call reached Olympus 1.75 s before
  // the agent's text did. Events in arrival order, as main applies them and as the renderer receives them.
  const events = [
    { add: user('u') },
    { add: tool('search') },
    { add: card('c') },
    { chunk: { into: 'a', text: 'MARKER-ALPHA: I will now ' } },
    { chunk: { into: 'a', text: 'ask to add the agent.' } },
    { add: tool('add_custom_agent') },
    { update: card('c', { resolved: 'accepted' }) },
    { chunk: { into: 'a2', text: 'Added.' } },
  ];
  const main = [];
  let screen = [];
  for (const ev of events) screen = withItem(screen, mainApply(main, ev));
  assert.equal(ids(main), 'u,search,a,add_custom_agent,c,a2');
  assert.equal(main.find((x) => x.id === 'a').text, 'MARKER-ALPHA: I will now ask to add the agent.');
  assert.equal(ids(screen), ids(main));
  assert.equal(screen.find((x) => x.id === 'a').text, main.find((x) => x.id === 'a').text);
  // Reload: the saved thread is main's array, written as is.
  assert.equal(ids(JSON.parse(JSON.stringify(main))), 'u,search,a,add_custom_agent,c,a2');
});

console.log(`\n${n}/${n} passed`);
