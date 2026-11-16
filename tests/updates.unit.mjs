// Unit tests for src/main/updates.ts + updateInstall.ts: semver order, installer pick per platform/CPU, skipped
// version, updates off (no request at all), quiet failures (403 / 404 / offline / bad JSON / drafts / pre-releases),
// checkForUpdates → updateMode migration, the Wi-Fi gate, SHA256SUMS + checksum pass/fail, resumable download from a
// local server, unpacking a real dummy .app from zip and dmg (macOS), and the install helpers (the macOS one is run
// for real on a dummy bundle in a temp folder, success and roll-back).
// Run: node tests/updates.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; `electron` is stubbed)
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = mkdtempSync(join(tmpdir(), 'olympus-updates-unit-'));
const UD = join(TMP, 'userData');
const SHARED = join(TMP, 'shared');
for (const d of [UD, SHARED]) mkdirSync(d, { recursive: true });
delete process.env.OLYMPUS_HOME;
process.env.AGENTDESK_SHARED_ROOT = SHARED;
// Saved before updateMode existed, with "Check for updates" off: must become updateMode 'off'.
writeFileSync(join(UD, 'settings.json'), JSON.stringify({ sharedRoot: SHARED, designVersion: 2, checkForUpdates: false }));

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'mock:electron', shortCircuit: true };
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
  load(url, ctx, next) {
    // Mock of the few electron APIs these modules touch (labelled mock, not the real app).
    if (url === 'mock:electron')
      return { format: 'module', shortCircuit: true, source: `export const app = { getPath: () => ${JSON.stringify(UD)}, getVersion: () => '0.1.0' }; export const safeStorage = { isEncryptionAvailable: () => false }; export const shell = {};` };
    return next(url, ctx);
  },
});

const U = await import(`${APP}/src/main/updates.ts`);
const S = await import(`${APP}/src/main/store.ts`);
const I = await import(`${APP}/src/main/updateInstall.ts`);

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${String(e?.stack ?? e).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

const dl = (name) => ({ name, browser_download_url: `https://github.com/martianacademy/olympus-coder/releases/download/v0.2.0/${name}` });
const ASSETS = [
  dl('Olympus.Coder-0.2.0-arm64.dmg'),
  dl('Olympus.Coder-0.2.0-arm64.dmg.blockmap'),
  dl('Olympus.Coder-0.2.0-arm64-mac.zip'),
  dl('Olympus.Coder-0.2.0.dmg'),
  dl('Olympus.Coder.Setup.0.2.0.exe'),
  dl('Olympus.Coder.Setup.0.2.0.exe.blockmap'),
  dl('Olympus.Coder-0.2.0.AppImage'),
  dl('Olympus.Coder-0.2.0-arm64.AppImage'),
  dl('olympus-coder_0.2.0_amd64.deb'),
  dl('SHA256SUMS.txt'),
];
const PAGE = 'https://github.com/martianacademy/olympus-coder/releases/tag/v0.2.0';
const release = (extra = {}) => ({ tag_name: 'v0.2.0', html_url: PAGE, draft: false, prerelease: false, assets: ASSETS, ...extra });
/** A fake fetch (mock, records calls) answering with one status / body or throwing. */
function fakeFetch(answer) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => (typeof answer.body === 'string' ? JSON.parse(answer.body) : answer.body) };
  };
  fn.calls = calls;
  return fn;
}
const deps = (fetch, extra = {}) => ({ current: '0.1.0', platform: 'darwin', arch: 'arm64', settings: { updateMode: 'notify' }, fetch, ...extra });

await test('semver compare: numeric parts, v prefix, pre-releases below the release', () => {
  assert.ok(U.compareVersions('0.2.0', '0.1.0') > 0);
  assert.ok(U.compareVersions('v0.10.0', '0.9.9') > 0);
  assert.ok(U.compareVersions('1.0.0', 'v1.0.0') === 0);
  assert.ok(U.compareVersions('0.1.0', '0.1.1') < 0);
  assert.ok(U.compareVersions('1.0.0-beta.1', '1.0.0') < 0);
  assert.ok(U.compareVersions('1.0.0', '1.0.0-rc.1') > 0);
  assert.equal(U.compareVersions('nightly', '0.1.0'), 0);
});

await test('asset pick: mac arm64 / x64 dmg, win exe, linux AppImage per CPU, none → undefined', () => {
  const pick = (p, a) => U.pickAsset(ASSETS, p, a)?.split('/').pop();
  assert.equal(pick('darwin', 'arm64'), 'Olympus.Coder-0.2.0-arm64.dmg');
  assert.equal(pick('darwin', 'x64'), 'Olympus.Coder-0.2.0.dmg');
  assert.equal(pick('win32', 'x64'), 'Olympus.Coder.Setup.0.2.0.exe');
  assert.equal(pick('linux', 'x64'), 'Olympus.Coder-0.2.0.AppImage');
  assert.equal(pick('linux', 'arm64'), 'Olympus.Coder-0.2.0-arm64.AppImage');
  assert.equal(U.pickAsset([dl('Olympus.Coder-0.2.0.dmg')], 'darwin', 'arm64'), undefined);
  assert.equal(U.pickAsset(ASSETS, 'freebsd', 'x64'), undefined);
});

await test('newer release → version, release page and this platform\'s installer; request has UA + timeout', async () => {
  const f = fakeFetch({ status: 200, body: release() });
  const u = await U.findUpdate(deps(f));
  assert.deepEqual(u, { version: '0.2.0', pageUrl: PAGE, downloadUrl: ASSETS[0].browser_download_url });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, U.RELEASES_API);
  assert.match(f.calls[0].init.headers['User-Agent'], /Olympus/);
  assert.ok(f.calls[0].init.signal instanceof AbortSignal);
  assert.equal(f.calls[0].init.headers.Authorization, undefined);
});

await test('no installer for this platform → Download falls back to the release page', async () => {
  const u = await U.findUpdate(deps(fakeFetch({ status: 200, body: release({ assets: [dl('SHA256SUMS.txt')] }) })));
  assert.equal(u.downloadUrl, PAGE);
});

await test('same or older version → null', async () => {
  assert.equal(await U.findUpdate(deps(fakeFetch({ status: 200, body: release({ tag_name: 'v0.1.0' }) }))), null);
  assert.equal(await U.findUpdate(deps(fakeFetch({ status: 200, body: release({ tag_name: 'v0.0.9' }) }))), null);
});

await test('drafts, pre-releases and pre-release tags are ignored', async () => {
  assert.equal(await U.findUpdate(deps(fakeFetch({ status: 200, body: release({ draft: true }) }))), null);
  assert.equal(await U.findUpdate(deps(fakeFetch({ status: 200, body: release({ prerelease: true }) }))), null);
  assert.equal(await U.findUpdate(deps(fakeFetch({ status: 200, body: release({ tag_name: 'v0.3.0-beta.1' }) }))), null);
});

await test('skipped version → null; a later version still shows', async () => {
  assert.equal(await U.findUpdate(deps(fakeFetch({ status: 200, body: release() }), { settings: { updateMode: 'notify', skippedUpdate: '0.2.0' } })), null);
  const u = await U.findUpdate(deps(fakeFetch({ status: 200, body: release({ tag_name: 'v0.2.1' }) }), { settings: { updateMode: 'notify', skippedUpdate: '0.2.0' } }));
  assert.equal(u.version, '0.2.1');
});

await test('updates off → no request at all', async () => {
  const f = fakeFetch({ status: 200, body: release() });
  assert.equal(await U.findUpdate(deps(f, { settings: { updateMode: 'off' } })), null);
  assert.equal((await U.checkRelease(deps(f, { settings: { updateMode: 'off' } }))).text, 'Updates are off.');
  assert.equal(f.calls.length, 0);
});

await test('auto mode checks like notify; check result lines for Settings', async () => {
  const r = await U.checkRelease(deps(fakeFetch({ status: 200, body: release() }), { settings: { updateMode: 'auto' } }));
  assert.equal(r.info.version, '0.2.0');
  assert.equal(r.release.assets.length, ASSETS.length);
  assert.equal(r.text, 'Olympus Coder 0.2.0 is available.');
  assert.equal((await U.checkRelease(deps(fakeFetch({ status: 200, body: release({ tag_name: 'v0.1.0' }) })))).text, 'Up to date (0.1.0).');
  assert.equal((await U.checkRelease(deps(fakeFetch({ status: 403, body: {} })))).text, 'Could not check: GitHub answered 403.');
  assert.equal((await U.checkRelease(deps(fakeFetch(new TypeError('fetch failed'))))).text, 'Could not reach GitHub.');
});

await test('403 / 404 / 500 / offline / timeout / bad JSON → null without throwing', async () => {
  for (const a of [{ status: 403, body: {} }, { status: 404, body: {} }, { status: 500, body: {} }, { status: 200, body: 'not json{' }, new TypeError('fetch failed'), new DOMException('timed out', 'TimeoutError')])
    assert.equal(await U.findUpdate(deps(fakeFetch(a))), null);
});
await test('mode migration: saved checkForUpdates=false → updateMode off (file rewritten); defaults notify / Wi-Fi off / install on quit', () => {
  const s = S.getSettings();
  assert.equal(s.updateMode, 'off');
  assert.equal('checkForUpdates' in s, false);
  const saved = JSON.parse(readFileSync(join(UD, 'settings.json'), 'utf8'));
  assert.equal(saved.updateMode, 'off');
  assert.equal('checkForUpdates' in saved, false);
  assert.equal(S.DEFAULT_SETTINGS.updateMode, 'notify');
  assert.equal(S.DEFAULT_SETTINGS.updateWifiOnly, false);
  assert.equal(S.DEFAULT_SETTINGS.updateInstallOnQuit, true);
  const on = { checkForUpdates: true };
  assert.equal(S.migrateUpdateMode(on), true);
  assert.deepEqual(on, { updateMode: 'notify' });
  const kept = { checkForUpdates: false, updateMode: 'auto' };
  S.migrateUpdateMode(kept);
  assert.deepEqual(kept, { updateMode: 'auto' });
  const fresh = {};
  assert.equal(S.migrateUpdateMode(fresh), false);
  assert.deepEqual(fresh, {});
});

await test('skipUpdate stores the version in settings', () => {
  U.skipUpdate('0.2.0');
  assert.equal(S.getSettings().skippedUpdate, '0.2.0');
});

await test('install asset pick: mac zip first (per CPU), dmg fallback; win exe; linux AppImage', () => {
  const pick = (assets, p, a) => I.pickInstallAsset(assets, p, a)?.name;
  assert.equal(pick(ASSETS, 'darwin', 'arm64'), 'Olympus.Coder-0.2.0-arm64-mac.zip');
  assert.equal(pick([...ASSETS, dl('Olympus.Coder-0.2.0-mac.zip')], 'darwin', 'x64'), 'Olympus.Coder-0.2.0-mac.zip');
  assert.equal(pick(ASSETS, 'darwin', 'x64'), 'Olympus.Coder-0.2.0.dmg');
  assert.equal(pick(ASSETS.filter((a) => !a.name.endsWith('.zip')), 'darwin', 'arm64'), 'Olympus.Coder-0.2.0-arm64.dmg');
  assert.equal(pick(ASSETS, 'win32', 'x64'), 'Olympus.Coder.Setup.0.2.0.exe');
  assert.equal(pick(ASSETS, 'linux', 'arm64'), 'Olympus.Coder-0.2.0-arm64.AppImage');
  assert.equal(pick([dl('SHA256SUMS.txt')], 'darwin', 'arm64'), undefined);
});

await test('Wi-Fi gate: default route on the Wi-Fi port, ethernet, VPN tunnel, offline, no Wi-Fi, cannot tell', async () => {
  const PORTS = 'Hardware Port: Ethernet Adapter (en4)\nDevice: en4\n\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: x\n';
  const fake = (route, ip = '', ports = PORTS) => async (file) => {
    if (file.endsWith('networksetup')) {
      if (ports instanceof Error) throw ports;
      return ports;
    }
    if (file.endsWith('route')) {
      if (!route) throw new Error('not in table');
      return `   route to: default\n  interface: ${route}\n`;
    }
    if (file.endsWith('ipconfig')) {
      if (!ip) throw new Error('no address');
      return `${ip}\n`;
    }
    throw new Error(file);
  };
  assert.equal(await I.onWifi('darwin', fake('en0')), true);
  assert.equal(await I.onWifi('darwin', fake('en4')), false);
  assert.equal(await I.onWifi('darwin', fake('utun3', '192.168.1.4')), true);
  assert.equal(await I.onWifi('darwin', fake('utun3')), false);
  assert.equal(await I.onWifi('darwin', fake('')), false);
  assert.equal(await I.onWifi('darwin', fake('en0', '', 'Hardware Port: Ethernet\nDevice: en4\n')), false);
  assert.equal(await I.onWifi('darwin', fake('en0', '', new Error('boom'))), undefined);
  assert.equal(await I.onWifi('linux', fake('en0')), undefined);
  assert.equal(U.waitForWifi(false, false), false);
  assert.equal(U.waitForWifi(true, true), false);
  assert.equal(U.waitForWifi(true, false), true);
  assert.equal(U.waitForWifi(true, undefined), true); // cannot tell → wait
  if (process.platform === 'darwin') assert.notEqual(await I.onWifi('darwin'), undefined); // real commands answer
});

await test('SHA256SUMS parse (two spaces, binary *, CRLF, junk) and checksum pass / fail', async () => {
  const a = 'a'.repeat(64);
  const B = 'B'.repeat(64);
  const sums = I.parseSums(`${a}  Olympus.Coder-0.2.0-arm64.dmg\r\n${B} *Olympus.Coder-0.2.0-arm64-mac.zip\nnot a line\n`);
  assert.equal(sums.get('Olympus.Coder-0.2.0-arm64.dmg'), a);
  assert.equal(sums.get('Olympus.Coder-0.2.0-arm64-mac.zip'), 'b'.repeat(64));
  assert.equal(sums.size, 2);
  const f = join(TMP, 'blob.bin');
  writeFileSync(f, 'hello update');
  const want = createHash('sha256').update('hello update').digest('hex');
  assert.equal(await I.sha256File(f), want);
  writeFileSync(f, 'hello updatE');
  assert.notEqual(await I.sha256File(f), want);
});

await test('download: progress, resumes a .part with Range (206), starts over on 200, fails on 404', async () => {
  const body = Buffer.alloc(300_000, 7);
  for (let i = 0; i < body.length; i++) body[i] = i % 251;
  const seen = [];
  let honourRange = true;
  const srv = createServer((req, res) => {
    seen.push(req.headers.range ?? '');
    if (req.url !== '/file') return res.writeHead(404).end();
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    if (m && honourRange) {
      const from = Number(m[1]);
      res.writeHead(206, { 'Content-Length': body.length - from, 'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}` });
      return res.end(body.subarray(from));
    }
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const dest = join(TMP, 'dl', 'app.zip');
    const progress = [];
    await I.download(`${base}/file`, dest, { fetch, onProgress: (r, t) => progress.push([r, t]) });
    assert.deepEqual(readFileSync(dest), body);
    assert.deepEqual(progress.at(-1), [body.length, body.length]);
    assert.equal(existsSync(`${dest}.part`), false);
    // A cut download: the first 100 000 bytes are already there.
    rmSync(dest);
    writeFileSync(`${dest}.part`, body.subarray(0, 100_000));
    await I.download(`${base}/file`, dest, { fetch });
    assert.equal(seen.at(-1), 'bytes=100000-');
    assert.deepEqual(readFileSync(dest), body);
    // A server that ignores Range: the part file is replaced, not appended to.
    rmSync(dest);
    writeFileSync(`${dest}.part`, body.subarray(0, 5000));
    honourRange = false;
    await I.download(`${base}/file`, dest, { fetch });
    assert.deepEqual(readFileSync(dest), body);
    await assert.rejects(I.download(`${base}/missing`, join(TMP, 'dl', 'x'), { fetch }), /HTTP 404/);
  } finally {
    srv.close();
  }
});

await test('bundleOf: running executable → .app', () => {
  assert.equal(I.bundleOf('/Applications/Olympus Coder.app/Contents/MacOS/Olympus Coder'), '/Applications/Olympus Coder.app');
  assert.equal(I.bundleOf('/usr/local/bin/node'), undefined);
});

await test('helper scripts: macOS via perl setsid, Windows NSIS /S, Linux AppImage; all parse', () => {
  const dir = join(TMP, 'updates');
  const mac = I.helperCommand({ platform: 'darwin', pid: 42, target: '/Applications/Olympus Coder.app', next: '/x/app/Olympus Coder.app', dir, relaunch: true });
  assert.equal(mac.file, '/usr/bin/perl');
  assert.deepEqual(mac.args.slice(0, 4), ['-MPOSIX', '-e', 'POSIX::setsid(); exec @ARGV', '/bin/bash']);
  assert.deepEqual(mac.args.slice(4), [join(dir, 'install-update.sh'), '42', '/Applications/Olympus Coder.app', '/x/app/Olympus Coder.app', join(dir, 'previous'), join(dir, 'install.log'), '1']);
  for (const step of ['kill -0 "$PID"', 'mv "$TARGET" "$BACKUP"', 'mv "$NEW" "$TARGET"', 'codesign --verify --deep --strict "$TARGET"', 'com.apple.quarantine', '/usr/bin/open']) assert.ok(mac.text.includes(step), step);
  const win = I.helperCommand({ platform: 'win32', pid: 7, target: 'C:\\\\x.exe', next: 'C:\\\\u\\\\Setup.exe', dir, relaunch: false });
  assert.equal(win.file, 'cmd.exe');
  assert.ok(win.text.includes('/S') && win.text.includes('tasklist') && win.text.includes('\r\n'));
  assert.equal(win.args.at(-1), '0');
  const lin = I.helperCommand({ platform: 'linux', pid: 7, target: '/home/u/Olympus.AppImage', next: '/u/new.AppImage', dir, relaunch: true });
  assert.equal(lin.file, '/bin/sh');
  assert.ok(lin.text.includes('chmod +x'));
  // Syntax only (not run on real Windows / Linux machines).
  const sh = join(TMP, 'h.sh');
  writeFileSync(sh, mac.text);
  execFileSync('/bin/bash', ['-n', sh]);
  writeFileSync(sh, lin.text);
  execFileSync('/bin/sh', ['-n', sh]);
});

/** A tiny ad-hoc signed .app (shell-script executable) with a package.json version — a dummy, not Olympus. */
function dummyApp(dir, version, name = 'Olympus Coder') {
  const app = join(dir, `${name}.app`);
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents/Resources/app'), { recursive: true });
  writeFileSync(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>dummy</string><key>CFBundleIdentifier</key><string>test.olympus.updater.dummy</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  writeFileSync(join(app, 'Contents/MacOS/dummy'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(app, 'Contents/MacOS/dummy'), 0o755);
  writeFileSync(join(app, 'Contents/Resources/app/package.json'), JSON.stringify({ version }));
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
  return app;
}

if (process.platform === 'darwin') {
  await test('stageMacApp: real zip and dmg of a dummy app → checked .app; wrong version / broken signature refused', async () => {
    const src = join(TMP, 'src');
    const app = dummyApp(src, '0.2.1');
    const zip = join(TMP, 'u.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
    const dmg = join(TMP, 'u.dmg');
    execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-srcfolder', app, '-volname', 'Olympus Coder', '-format', 'UDZO', dmg]);
    const a = await I.stageMacApp(zip, join(TMP, 'stage-zip'), '0.2.1');
    assert.equal(a, join(TMP, 'stage-zip', 'Olympus Coder.app'));
    assert.equal(await I.bundleVersion(a), '0.2.1');
    const b = await I.stageMacApp(dmg, join(TMP, 'stage-dmg'), '0.2.1');
    assert.equal(await I.bundleVersion(b), '0.2.1');
    assert.equal(existsSync(join(TMP, 'stage-dmg.mnt')), false); // unmounted and removed
    assert.equal(execFileSync('/usr/bin/xattr', ['-l', b]).toString().includes('com.apple.quarantine'), false);
    await assert.rejects(I.stageMacApp(zip, join(TMP, 'stage-v'), '0.3.0'), /version 0\.2\.1, not 0\.3\.0/);
    assert.equal(existsSync(join(TMP, 'stage-v')), false);
    // Tampered after signing.
    writeFileSync(join(app, 'Contents/Resources/app/package.json'), JSON.stringify({ version: '0.2.1', x: 1 }));
    const bad = join(TMP, 'bad.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, bad]);
    await assert.rejects(I.stageMacApp(bad, join(TMP, 'stage-bad'), '0.2.1'), /signature/);
  });

  await test('macOS helper run for real: swaps a dummy bundle (backup kept, log written); a bad new bundle rolls back', async () => {
    const root = join(TMP, 'helper');
    const apps = join(root, 'Applications');
    const target = dummyApp(apps, '0.2.0');
    const next = dummyApp(join(root, 'stage'), '0.2.1');
    const dir = join(root, 'updates');
    const runHelper = (nextPath) => {
      const c = I.helperCommand({ platform: 'darwin', pid: 999999, target, next: nextPath, dir, relaunch: false });
      mkdirSync(dir, { recursive: true });
      writeFileSync(c.script, c.text, { mode: 0o755 });
      execFileSync(c.file, c.args, { timeout: 60_000 }); // pid 999999 is not running: no wait
    };
    runHelper(next);
    assert.equal(JSON.parse(readFileSync(join(target, 'Contents/Resources/app/package.json'), 'utf8')).version, '0.2.1');
    assert.equal(JSON.parse(readFileSync(join(dir, 'previous', 'Olympus Coder.app', 'Contents/Resources/app/package.json'), 'utf8')).version, '0.2.0');
    assert.equal(existsSync(next), false);
    const log = readFileSync(join(dir, 'install.log'), 'utf8');
    assert.match(log, /installed/);
    assert.match(log, /done/);
    // A new bundle that fails codesign: the 0.2.1 in place comes back.
    const broken = dummyApp(join(root, 'stage2'), '0.2.2');
    writeFileSync(join(broken, 'Contents/MacOS/dummy'), '#!/bin/sh\necho tampered\n');
    assert.throws(() => runHelper(broken));
    assert.equal(JSON.parse(readFileSync(join(target, 'Contents/Resources/app/package.json'), 'utf8')).version, '0.2.1');
    assert.match(readFileSync(join(dir, 'install.log'), 'utf8'), /FAILED: codesign --verify failed[\s\S]*previous version restored/);
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
