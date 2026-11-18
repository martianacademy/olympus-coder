// Unit tests: the phone's own Appearance (theme.phone) on top of the Mac's theme; the Mac never applies it.
// File: src/shared/themes.ts (withPhoneTheme). Run: node tests/phoneTheme.unit.mjs   (Node ≥ 23, no Electron needed)
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const { DEFAULT_THEME, withPhoneTheme } = await import(pathToFileURL(`${APP}/src/shared/themes.ts`).href);

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}

const mac = { ...DEFAULT_THEME };

t('no phone settings = exactly the Mac theme', () => assert.deepEqual(withPhoneTheme(mac), mac));
t('empty phone settings = exactly the Mac theme', () => assert.deepEqual(withPhoneTheme({ ...mac, phone: {} }), { ...mac, phone: {} }));
t('old settings file without new keys still loads', () => {
  const old = { preset: 'graphite', mode: 'dark', fontSize: 15, overrides: {} };
  assert.equal(withPhoneTheme(old).fontSize, 15);
  assert.equal(withPhoneTheme(old).codeFontSize, DEFAULT_THEME.codeFontSize);
});

t('phone mode wins, Mac mode untouched in the input', () => {
  const theme = { ...mac, mode: 'light', phone: { mode: 'dark' } };
  assert.equal(withPhoneTheme(theme).mode, 'dark');
  assert.equal(theme.mode, 'light');
});

t('text size 17 on a 14 Mac scales code 12.5 → 15 (rounded to .5), chat follows', () => {
  const r = withPhoneTheme({ ...mac, phone: { fontSize: 17 } });
  assert.equal(r.fontSize, 17);
  assert.equal(r.codeFontSize, 15);
  assert.equal(r.chatFontSize, 0); // 0 = same as the (phone) app size
});
t('explicit Mac chat/editor/terminal/sidebar sizes scale with the phone text size', () => {
  const r = withPhoneTheme({ ...mac, chatFontSize: 15, editorFontSize: 13, terminalFontSize: 12, sidebarFontSize: 13, phone: { fontSize: 21 } });
  assert.equal(r.chatFontSize, Math.round(15 * 1.5));
  assert.equal(r.editorFontSize, 19.5);
  assert.equal(r.terminalFontSize, 18);
  assert.equal(r.sidebarFontSize, Math.round(13 * 1.5));
});
t('"follow" sizes (0) stay 0 so they follow the phone values', () => {
  const r = withPhoneTheme({ ...mac, phone: { fontSize: 18 } });
  assert.equal(r.editorFontSize, 0);
  assert.equal(r.terminalFontSize, 0);
  assert.equal(r.sidebarFontSize, 0);
});
t('phone chat and code sizes win over the scaling', () => {
  const r = withPhoneTheme({ ...mac, phone: { fontSize: 18, chatFontSize: 20, codeFontSize: 13 } });
  assert.equal(r.chatFontSize, 20);
  assert.equal(r.codeFontSize, 13);
});
t('phone text size equal to the Mac changes nothing', () => {
  const r = withPhoneTheme({ ...mac, chatFontSize: 15, phone: { fontSize: 14 } });
  assert.equal(r.chatFontSize, 15);
  assert.equal(r.codeFontSize, 12.5);
});
t('line spacing and steps size', () => {
  const r = withPhoneTheme({ ...mac, phone: { lineHeight: 1.8, stepsSize: 'larger' } });
  assert.equal(r.lineHeight, 1.8);
  assert.equal(r.stepsSize, 'larger');
  assert.equal(r.fontSize, 14);
});
t('Mac-only keys (colors, fonts, radius) are never changed', () => {
  const theme = { ...mac, preset: 'ocean', radius: 4, uiFont: 'serif', phone: { fontSize: 18, mode: 'dark' } };
  const r = withPhoneTheme(theme);
  assert.equal(r.preset, 'ocean');
  assert.equal(r.radius, 4);
  assert.equal(r.uiFont, 'serif');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
