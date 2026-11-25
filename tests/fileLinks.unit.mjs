// Which inline-code texts in chat become clickable file links (src/renderer/src/fileLinks.tsx `looksLikePath`).
// Regression (2026-11-25): `dist/olympus-chrome-extension-0.3.0.zip` in a reply was plain text — archives,
// installers and packages were missing from the extension list, so it could not be opened or shown in Finder.
// Run: node tests/fileLinks.unit.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transform } from 'rolldown/experimental';

// fileLinks.tsx has JSX: transform it with rolldown (vite's toolchain) into node_modules/.cache so `react` resolves.
const APP = new URL('..', import.meta.url).pathname;
const cache = join(APP, 'node_modules', '.cache');
mkdirSync(cache, { recursive: true });
const dir = mkdtempSync(join(cache, 'filelinks-unit-'));
const out = join(dir, 'fileLinks.mjs');
const src = readFileSync(join(APP, 'src/renderer/src/fileLinks.tsx'), 'utf8');
const res = await transform('fileLinks.tsx', src, { lang: 'tsx', jsx: { runtime: 'automatic' } });
if (res.errors?.length) throw new Error(`transform failed: ${JSON.stringify(res.errors[0])}`);
writeFileSync(out, res.code);
const { looksLikePath } = await import(pathToFileURL(out).href);

let pass = 0;
const check = (name, fn) => {
  fn();
  pass++;
  console.log(`PASS  ${name}`);
};
try {
  check('archives, installers and packages are links', () => {
    for (const p of [
      'dist/olympus-chrome-extension-0.3.0.zip',
      '/tmp/oc-rel-0.3.7/Olympus.Coder-0.3.7-arm64.dmg',
      '~/Downloads/olympus-server-0.3.7-portable.tar.gz',
      'build/app.exe',
      'out/Olympus.AppImage',
      'ext.crx',
      'pkg/tool-1.0-py3-none-any.whl',
    ]) assert.equal(looksLikePath(p), true, p);
  });
  check('source files, images and line refs still are links', () => {
    for (const p of ['src/main/agents.ts:2457', 'README.md', 'tests/a.unit.mjs', '~/out/demo.png', 'docs/x.pdf#L3']) assert.equal(looksLikePath(p), true, p);
  });
  check('commands, versions, schemes and prose are not links', () => {
    for (const p of ['npm run package:chrome-ext', 'v0.3.7', '0.3.0', 'node:assert', 'https://example.com/a.zip', 'key', 'Alt+Shift+S', 'a b.zip'])
      assert.equal(looksLikePath(p), false, p);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${pass} passed, 0 failed`);
