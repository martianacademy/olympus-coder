#!/usr/bin/env node
/**
 * Builds the Chrome Web Store upload: dist/olympus-chrome-extension-<version>.zip
 *
 * The repo manifest keeps `"key"` so an unpacked install always gets the pinned dev ID
 * (mblgbbfnfhiaphmdkigkkhadealbpkig). The Web Store rejects a `key` on upload and assigns its own ID,
 * so the zip's manifest drops it. After the first upload, add the Store ID to ALLOWED_EXTENSION_IDS in
 * src/main/browserBridge.ts (and ship an app release) before the listing goes public.
 *
 * Run: node scripts/package-chrome-extension.mjs
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'extensions', 'olympus-chrome');
const FILES = ['manifest.json', 'background.js', 'cdp.js', 'overlay.js', 'pageHelpers.js', 'icon.png', 'icons'];

const manifest = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
delete manifest.key;

const stage = mkdtempSync(join(tmpdir(), 'olympus-chrome-pkg-'));
try {
  for (const f of FILES) {
    if (!existsSync(join(SRC, f))) throw new Error(`Missing extension file: ${f}`);
    if (f !== 'manifest.json') cpSync(join(SRC, f), join(stage, f), { recursive: true });
  }
  writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const f of ['background.js', 'cdp.js', 'overlay.js', 'pageHelpers.js']) execFileSync(process.execPath, ['--check', join(stage, f)]);

  const outDir = join(ROOT, 'dist');
  mkdirSync(outDir, { recursive: true });
  const zip = join(outDir, `olympus-chrome-extension-${manifest.version}.zip`);
  rmSync(zip, { force: true });
  execFileSync('zip', ['-q', '-r', '-X', zip, '.'], { cwd: stage });
  console.log(`✓ ${zip}`);
  console.log(`  version ${manifest.version} · key removed · ${FILES.length} entries`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
