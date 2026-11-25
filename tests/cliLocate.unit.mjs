// Locating a user-installed Claude Code (src/main/cliLocate.ts), Windows layouts simulated with temp folders.
// Regression (2026-11-25, v0.3.8): installers stopped bundling claude.exe, so a Windows Claude Code installed with
// npm (`%APPDATA%\npm\claude` / `claude.cmd` shims, unspawnable) read as "not installed". The real binary is
// `node_modules/@anthropic-ai/claude-code/bin/claude.exe` next to the shims.
// Run: node tests/cliLocate.unit.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
});
const L = await import(pathToFileURL(new URL('../src/main/cliLocate.ts', import.meta.url).pathname).href);

const TMP = mkdtempSync(join(tmpdir(), 'cli-locate-'));
const touch = (p) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '');
  return p;
};
let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`FAIL  ${name}\n      ${e.message.split('\n').join('\n      ')}`);
  }
}

function layout(name) {
  const home = join(TMP, name, 'home');
  const appData = join(home, 'AppData', 'Roaming');
  const spec = {
    bin: 'claude',
    dirs: [join(home, '.local', 'bin'), join(home, '.claude', 'local')],
    npmExe: ['@anthropic-ai', 'claude-code', 'bin', 'claude.exe'],
  };
  const npmDir = join(appData, 'npm');
  const npmExe = join(npmDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return { home, appData, spec, npmDir, npmExe };
}
const find = (l, found, platform = 'win32') => L.pickCli(L.cliCandidates(l.spec, found, platform, { APPDATA: l.appData }), platform);

test('Windows npm install: PATH finds the extensionless shim → the package\'s real claude.exe is used', () => {
  const l = layout('npm');
  const shim = touch(join(l.npmDir, 'claude'));
  touch(join(l.npmDir, 'claude.cmd'));
  touch(l.npmExe);
  assert.equal(find(l, shim), l.npmExe);
});

test('Windows npm install with a stale PATH (shim not found): %APPDATA%\\npm package is still found', () => {
  const l = layout('npm-stale');
  touch(l.npmExe);
  assert.equal(find(l, null), l.npmExe);
});

test('Windows native installer: claude.exe in ~/.local/bin is found even before PATH has it', () => {
  const l = layout('native');
  const exe = touch(join(l.home, '.local', 'bin', 'claude.exe'));
  assert.equal(find(l, null), exe);
});

test('Windows: a PATH hit that is already an .exe wins', () => {
  const l = layout('exe-on-path');
  const exe = touch(join(TMP, 'exe-on-path', 'tools', 'claude.exe'));
  touch(l.npmExe);
  assert.equal(find(l, exe), exe);
});

test('Windows: only unspawnable shims (no package exe, no native) → not installed', () => {
  const l = layout('shims-only');
  const shim = touch(join(l.npmDir, 'claude.cmd'));
  assert.equal(find(l, shim), null);
});

test('macOS/Linux: the PATH hit is used as is; ~/.local/bin is the fallback; npm path never consulted', () => {
  const l = layout('posix');
  const onPath = touch(join(TMP, 'posix', 'usr', 'bin', 'claude'));
  assert.equal(find(l, onPath, 'darwin'), onPath);
  const native = touch(join(l.home, '.local', 'bin', 'claude'));
  assert.equal(find(l, null, 'linux'), native);
  assert.ok(!L.cliCandidates(l.spec, null, 'darwin', { APPDATA: l.appData }).some((p) => p.includes('node_modules')));
});

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
