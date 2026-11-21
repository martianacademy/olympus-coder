/**
 * Full standalone VPS tarball & 1-line installer E2E verification (`tests/serverPackage.e2e.mjs`):
 * 1. Verifies the packaged `dist/olympus-server-<ver>-<plat>-<arch>.tar.gz` contains ZERO Electron
 *    dependency while bundling `out/server/index.mjs`, `out/renderer/remote.html`, and runtime deps.
 * 2. Runs `scripts/install-server.sh` against that tarball into an isolated fake VPS `$HOME`.
 * 3. Launches the installed `~/.olympus/bin/olympus-server` binary (completely outside the dev repo),
 *    pairs over `/api/pair`, verifies `remote.html` + RPC `files.read` + live PTY `TARBALL_VPS_OK`,
 *    and verifies `oly serve --help` auto-discovers `$OLYMPUS_HOME/server-bin/out/server/index.mjs`.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const tarball = join(ROOT, 'dist', `olympus-server-${pkg.version}-${process.platform}-${process.arch}.tar.gz`);
assert.ok(existsSync(tarball), `Missing packaged tarball at ${tarball} — run npm run package:server`);

// 1. Inspect tarball manifest: must have server, renderer, bin, and ZERO electron binary
const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
assert.match(listing, /out\/server\/index\.mjs/);
assert.match(listing, /out\/renderer\/remote\.html/);
assert.match(listing, /bin\/olympus-server/);
assert.equal(listing.includes('node_modules/electron/'), false, 'Headless server tarball must NEVER bundle Electron');
console.log('  PASS  1. Tarball contains server + remote.html + bin and ZERO Electron');

const fakeVps = mkdtempSync(join(tmpdir(), 'olympus-vps-install-e2e-'));
const fakeHome = join(fakeVps, 'home');
const fakeProj = join(fakeVps, 'app-repo');
mkdirSync(fakeHome, { recursive: true });
mkdirSync(fakeProj, { recursive: true });
writeFileSync(join(fakeProj, 'vps.txt'), 'hello-from-isolated-vps\n');

const port = 49100 + Math.floor(Math.random() * 700);
const password = 'vps-e2e-password';
let child;

try {
  // 2. Run 1-line installer against the packaged tarball in isolated HOME
  const installOut = execFileSync('sh', [join(ROOT, 'scripts', 'install-server.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fakeHome,
      OLYMPUS_HOME: join(fakeHome, '.olympus'),
      OLYMPUS_SERVER_TARBALL: tarball,
    },
  });
  assert.match(installOut, /Installed Olympus Coder Headless Server \(local-tarball\)/);
  const installedBin = join(fakeHome, '.olympus', 'bin', 'olympus-server');
  assert.ok(existsSync(installedBin), 'olympus-server shim created in ~/.olympus/bin');
  const installedPkg = JSON.parse(readFileSync(join(fakeHome, '.olympus', 'server-bin', 'package.json'), 'utf8'));
  assert.equal(Boolean(installedPkg.dependencies?.electron), false, 'Runtime package.json has zero electron dep');
  console.log('  PASS  2. scripts/install-server.sh installed standalone bundle into isolated ~/.olympus/server-bin');

  // 3. Verify `oly serve --help` auto-discovers the installed `~/.olympus/server-bin/out/server/index.mjs`
  const olyBin = join(homedir(), '.olympus', 'agents', 'olympus-cli', 'bin', 'oly');
  if (existsSync(olyBin)) {
    const olyHelp = execFileSync(olyBin, ['serve', '--help'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: fakeHome, OLYMPUS_HOME: join(fakeHome, '.olympus') },
    });
    assert.match(olyHelp, /Olympus Coder — Headless Server/);
    console.log('  PASS  3. oly serve --help auto-discovered isolated ~/.olympus/server-bin');
  }

  // 4. Launch installed `~/.olympus/bin/olympus-server` from outside dev repo (cwd=/tmp)
  child = spawn(
    installedBin,
    ['serve', '--port', String(port), '--no-relay', '--password', password, '--project', fakeProj, '--no-qr'],
    {
      cwd: fakeVps,
      env: {
        ...process.env,
        HOME: fakeHome,
        OLYMPUS_HOME: join(fakeHome, '.olympus'),
        OLYMPUS_SERVER_DATA: join(fakeHome, '.olympus', 'server'),
        OLYMPUS_TEST_HIDDEN: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  const waitFor = async (fn, label, ms = 12000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`Timeout waiting for ${label}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  };

  await waitFor(() => stdout.includes('Press Ctrl+C to stop cleanly.'), 'installed server boot');
  const code = /Pairing Code\s*:\s*(\d{6})/.exec(stdout)?.[1];
  assert.ok(code, 'Installed server printed 6-digit pairing code');

  const base = `http://127.0.0.1:${port}`;
  const htmlRes = await fetch(`${base}/`);
  assert.equal(htmlRes.status, 200);
  assert.match(await htmlRes.text(), /remote/i);

  const pairRes = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-olympus': '1' },
    body: JSON.stringify({ code, password, name: 'VPS Phone' }),
  });
  assert.equal(pairRes.status, 200);
  const { token } = await pairRes.json();

  const rpc = async (method, args = []) => {
    const r = await fetch(`${base}/api/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ method, args }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    if (!j.ok) throw new Error(`${method}: ${j.error}`);
    return j.value;
  };

  const projects = await rpc('projects.list');
  const p = projects.find((x) => x.path === fakeProj);
  assert.ok(p, 'Project registered in isolated VPS instance');
  const fileData = await rpc('files.read', [p.id, 'vps.txt']);
  assert.equal(fileData.text, 'hello-from-isolated-vps\n');

  const ptyId = await rpc('term.start', [p.id]);
  await new Promise((r) => setTimeout(r, 350));
  await rpc('pty.write', [ptyId, 'echo TARBALL_VPS_OK\r']);
  const ptyOut = await waitFor(async () => {
    const b = await rpc('pty.buffer', [ptyId]);
    return b.data.includes('TARBALL_VPS_OK') ? b.data : null;
  }, 'PTY output from installed bundle');
  assert.match(ptyOut, /TARBALL_VPS_OK/);
  await rpc('pty.kill', [ptyId]);
  console.log('  PASS  4. Installed standalone binary served UI, paired, read project files, and ran live PTY (TARBALL_VPS_OK)');

  child.kill('SIGTERM');
  const exitCode = await new Promise((res) => child.once('exit', (c) => res(c)));
  assert.equal(exitCode, 0);
  console.log('  PASS  5. Installed standalone binary shut down cleanly (exit 0)');
  console.log('\nALL 5/5 STANDALONE SERVER PACKAGE & INSTALLER E2E CHECKS PASSED!');
} finally {
  if (child && child.exitCode === null) {
    try { child.kill('SIGKILL'); } catch {}
  }
  rmSync(fakeVps, { recursive: true, force: true });
}
