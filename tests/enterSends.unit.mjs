// Unit tests: enterSends (src/renderer/src/platform.ts) — Enter sends on a computer keyboard; on a touch-only phone
// (no Shift+Enter) Enter adds a new line and only the Send button sends (user's request, 2026-11-20).
// Run: node tests/enterSends.unit.mjs
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
let media = {};
globalThis.matchMedia = (q) => ({ matches: Boolean(media[q]) });
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel', userAgent: '' }, configurable: true });
const { enterSends, touchOnly } = await import(`${APP}/src/renderer/src/platform.ts`);

const PHONE = { '(pointer: coarse)': true, '(any-pointer: fine)': false };
const MAC = { '(pointer: coarse)': false, '(any-pointer: fine)': true };
const IPAD_TRACKPAD = { '(pointer: coarse)': true, '(any-pointer: fine)': true };
const key = (k, shift = false, composing = false) => ({ key: k, shiftKey: shift, nativeEvent: { isComposing: composing } });

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

test('computer: Enter sends, Shift+Enter is a new line', () => {
  media = MAC;
  assert.equal(touchOnly(), false);
  assert.equal(enterSends(key('Enter')), true);
  assert.equal(enterSends(key('Enter', true)), false);
});
test('phone: Enter is a new line (only the Send button sends)', () => {
  media = PHONE;
  assert.equal(touchOnly(), true);
  assert.equal(enterSends(key('Enter')), false);
});
test('iPad with a trackpad/keyboard: Enter sends like a computer', () => {
  media = IPAD_TRACKPAD;
  assert.equal(enterSends(key('Enter')), true);
});
test('IME composing (Hindi/Japanese input): Enter never sends', () => {
  media = MAC;
  assert.equal(enterSends(key('Enter', false, true)), false);
});
test('other keys never send', () => {
  media = MAC;
  assert.equal(enterSends(key('a')), false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
