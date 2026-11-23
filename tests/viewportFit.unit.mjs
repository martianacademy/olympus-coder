// Unit tests: fitHeight (src/renderer/src/remote/viewportFit.ts) — iOS home-screen app height. Numbers are an
// iPhone 430x932pt screen whose standalone page reports heights 59pt short (status bar), and a 406pt keyboard
// (the user's screenshot, 2026-11-19).
// Run: node tests/viewportFit.unit.mjs
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const { fitHeight } = await import(`${APP}/src/renderer/src/remote/viewportFit.ts`);

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
const phone = (visible, innerWidth = 430) => ({ visible, innerWidth, screenWidth: 430, screenHeight: 932 });
const fresh = { orientation: '', base: 0 };

test('keyboard closed: the status-bar shortfall is added back to fill the screen', () => {
  const r = fitHeight(phone(873), fresh);
  assert.equal(r.height, 932);
  assert.equal(r.keyboard, false);
});

test('keyboard open: the app ends right above the keyboard (no page scroll, no band)', () => {
  const closed = fitHeight(phone(873), fresh);
  const open = fitHeight(phone(873 - 406), closed.state);
  assert.equal(open.height, 932 - 406);
  assert.equal(open.keyboard, true);
  const again = fitHeight(phone(873), open.state);
  assert.equal(again.height, 932, 'closing the keyboard restores full height');
  assert.equal(again.keyboard, false);
});

test('a page that already reports the full height gets no extra', () => {
  assert.equal(fitHeight(phone(932), fresh).height, 932);
});

test('small height changes are not the keyboard', () => {
  const closed = fitHeight(phone(873), fresh);
  assert.equal(fitHeight(phone(873 - 40), closed.state).keyboard, false);
});

test('rotation re-measures: landscape uses the short screen side', () => {
  const portrait = fitHeight(phone(873), fresh);
  const land = fitHeight({ visible: 410, innerWidth: 932, screenWidth: 430, screenHeight: 932 }, portrait.state);
  assert.equal(land.state.orientation, 'landscape');
  assert.equal(land.height, 430);
  assert.equal(land.keyboard, false, 'portrait base is not reused in landscape');
});

test('an iPad split / Slide Over window (narrower than the screen) is left as reported', () => {
  const r = fitHeight({ visible: 1200, innerWidth: 678, screenWidth: 1024, screenHeight: 1366 }, fresh);
  assert.equal(r.height, 1200);
});

test('1-frame full-height spike on keyboard dismiss never leaves a 59pt bottom gap', () => {
  const boot = fitHeight(phone(873), fresh);
  assert.equal(boot.height, 932);
  const open = fitHeight(phone(467), boot.state);
  assert.equal(open.height, 526);
  // iOS momentarily reports visible === 932 while dismissing keyboard after Send, then settles back to 873.
  const spike = fitHeight(phone(932), open.state);
  assert.equal(spike.height, 932);
  assert.equal(spike.keyboard, false);
  const settled = fitHeight(phone(873), spike.state);
  assert.equal(settled.height, 932, 'settled closed height must remain full 932px with zero bottom gap');
  assert.equal(settled.keyboard, false);
  const reopen = fitHeight(phone(467), settled.state);
  assert.equal(reopen.height, 526, 'reopening keyboard must still preserve 59pt shortfall');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
