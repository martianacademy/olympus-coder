/**
 * Packages the pure-Node Olympus Coder Headless Server into a compact, zero-Electron standalone
 * tarball (`dist/olympus-server-<version>-<platform>-<arch>.tar.gz`) ready for Linux/macOS VPS
 * hosts and GitHub Releases.
 *
 * Includes:
 * - `out/server/index.mjs` (single-file headless backend)
 * - `out/renderer/` (responsive `remote.html` + assets UI)
 * - `bin/olympus-server` (executable wrapper)
 * - `package.json` with ONLY the 5 headless runtime dependencies (zero Electron / Vite / React)
 * - `node_modules/` installed cleanly for the current OS/arch when `--bundle-deps` (default) is set
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version || '0.3.1';
const plat = process.platform;
const arch = process.arch;
const portableOnly = process.argv.includes('--portable');

const serverEntry = join(ROOT, 'out', 'server', 'index.mjs');
const rendererDir = join(ROOT, 'out', 'renderer');
if (!existsSync(serverEntry) || !existsSync(join(rendererDir, 'remote.html'))) {
  throw new Error('Missing out/server/index.mjs or out/renderer/remote.html — run `npm run build:server` first.');
}

const distDir = join(ROOT, 'dist');
const stageName = portableOnly ? `olympus-server-${version}-portable` : `olympus-server-${version}-${plat}-${arch}`;
const stageDir = join(distDir, '.stage-server', stageName);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(join(stageDir, 'out', 'server'), { recursive: true });
mkdirSync(join(stageDir, 'bin'), { recursive: true });

// 1. Copy compiled headless backend + responsive phone/browser UI
cpSync(serverEntry, join(stageDir, 'out', 'server', 'index.mjs'));
cpSync(rendererDir, join(stageDir, 'out', 'renderer'), { recursive: true });

// 2. Write minimal runtime package.json (zero Electron!)
const runtimePkg = {
  name: 'olympus-coder-server',
  version,
  description: 'Headless pure-Node Olympus Coder server for VPS / cloud hosts (full phone & browser UI over E2EE Relay).',
  private: true,
  license: pkg.license || 'Apache-2.0',
  type: 'module',
  bin: { 'olympus-server': './bin/olympus-server' },
  dependencies: {
    '@agentclientprotocol/claude-agent-acp': pkg.dependencies['@agentclientprotocol/claude-agent-acp'],
    '@agentclientprotocol/codex-acp': pkg.dependencies['@agentclientprotocol/codex-acp'],
    '@agentclientprotocol/sdk': pkg.dependencies['@agentclientprotocol/sdk'],
    qrcode: pkg.devDependencies?.qrcode || '^1.5.6',
  },
  // Optional so minimal Linux VPS hosts without python3/build-essential never fail install;
  // CI runners with build tools compile native node-pty, and src/main/pty.ts falls back cleanly otherwise.
  optionalDependencies: {
    'node-pty': pkg.dependencies['node-pty'],
  },
};
writeFileSync(join(stageDir, 'package.json'), JSON.stringify(runtimePkg, null, 2) + '\n');

// 3. Executable bin/olympus-server entrypoint
const binPath = join(stageDir, 'bin', 'olympus-server');
writeFileSync(binPath, '#!/usr/bin/env node\nimport "../out/server/index.mjs";\n', { mode: 0o755 });
chmodSync(binPath, 0o755);

// 4. Install production runtime dependencies for the target OS/arch (skipping Electron entirely)
if (!portableOnly) {
  console.log(`Installing headless runtime deps into ${stageName} (zero Electron)...`);
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline'], {
    cwd: stageDir,
    stdio: 'inherit',
  });
  // Prune foreign-OS node-pty prebuilds & Windows debug symbols (~55 MB) and ensure spawn-helper is executable.
  const prebuildsDir = join(stageDir, 'node_modules', 'node-pty', 'prebuilds');
  if (existsSync(prebuildsDir)) {
    const keepKey = `${plat}-${arch}`;
    for (const entry of readdirSync(prebuildsDir)) {
      if (entry !== keepKey) rmSync(join(prebuildsDir, entry), { recursive: true, force: true });
    }
    const helper = join(prebuildsDir, keepKey, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
  if (plat !== 'win32') {
    rmSync(join(stageDir, 'node_modules', 'node-pty', 'third_party', 'conpty'), { recursive: true, force: true });
  }
}

// 5. Create compressed tarball
const archiveName = `${stageName}.tar.gz`;
const archivePath = join(distDir, archiveName);
rmSync(archivePath, { force: true });
execFileSync('tar', ['-czf', archivePath, '-C', join(distDir, '.stage-server'), stageName], { stdio: 'inherit' });
rmSync(join(distDir, '.stage-server'), { recursive: true, force: true });

const sizeMb = (statSync(archivePath).size / (1024 * 1024)).toFixed(2);
console.log(`✓ Packaged headless server: dist/${archiveName} (${sizeMb} MB)`);
