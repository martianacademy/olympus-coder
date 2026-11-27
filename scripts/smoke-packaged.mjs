// Packaged-app smoke test for Olympus Coder installers (Linux container / Windows CI runner).
// Launches the INSTALLED app twice with a scratch profile and drives it over CDP:
//   1. fresh profile  → first-run screen renders, no uncaught renderer errors
//   2. onboarded + one project → main UI renders, a real terminal (node-pty) runs a command
// Usage: node smoke.mjs --bin <app executable> --out <dir> [-- extra electron args]
// Microsoft Store package (Windows): add --msix <PackageFamilyName>!<AppId>. The app is then started INSIDE its
// package (Invoke-CommandInDesktopPackage, so it has package identity like a Store install) instead of as a child
// process, its liveness is read over CDP, and extra checks run: the Store update line, package identity and
// unvirtualized %APPDATA% writes from the app's own terminal.
// Needs Node 22+ (global WebSocket/fetch). No npm deps.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const extra = sep >= 0 ? argv.slice(sep + 1) : [];
const opt = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 && (sep < 0 || i < sep) ? argv[i + 1] : undefined;
};
const BIN = opt('--bin');
const OUT = opt('--out') || join(process.cwd(), 'smoke-out');
const LABEL = opt('--label') || process.platform;
/** "<PackageFamilyName>!<AppId>" of an installed MSIX package (Windows only). */
const MSIX = opt('--msix');
const [MSIX_PFN, MSIX_APP] = (MSIX || '').split('!');
if (MSIX && (process.platform !== 'win32' || !MSIX_PFN || !MSIX_APP)) {
  console.error(`--msix needs Windows and "<PackageFamilyName>!<AppId>", got: ${MSIX}`);
  process.exit(2);
}
const STORE_UPDATE_TEXT = 'This copy updates through the Microsoft Store.';
if (!BIN || !existsSync(BIN)) {
  console.error(`--bin missing or not found: ${BIN}`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failed = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitJson(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function cdp(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method) events.push(m);
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq;
      const t = setTimeout(() => rej(new Error(`CDP ${method} timeout`)), 60_000);
      pending.set(id, (m) => {
        clearTimeout(t);
        m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { ws, send, evaluate, events, close: () => ws.close() };
}

async function shot(page, name) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  const file = join(OUT, `${LABEL}-${name}.png`);
  writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

function errorsOf(page) {
  const out = [];
  for (const e of page.events) {
    if (e.method === 'Runtime.exceptionThrown') out.push(`exception: ${e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text}`);
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
      out.push(`console.error: ${e.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
  }
  return out;
}

async function launch(tag, { settings, projects }) {
  const root = mkdtempSync(join(tmpdir(), `oc-smoke-${tag}-`));
  const ud = join(root, 'ud');
  const shared = join(root, 'shared');
  mkdirSync(ud, { recursive: true });
  mkdirSync(shared, { recursive: true });
  // A packaged launch may not inherit this process's environment: the scratch shared folder also goes in settings.
  if (settings || MSIX) writeFileSync(join(ud, 'settings.json'), JSON.stringify(MSIX ? { ...settings, sharedRoot: shared } : settings, null, 2));
  if (projects) writeFileSync(join(shared, 'projects.json'), JSON.stringify(projects, null, 2));
  const port = 9300 + Math.floor(Math.random() * 500);
  const env = { ...process.env, AGENTDESK_SHARED_ROOT: shared };
  delete env.ELECTRON_RUN_AS_NODE;
  const log = [];
  let child;
  let alive;
  if (MSIX) {
    // Start it inside its package, the way Windows starts a Store app; the PowerShell launcher exits at once.
    const logFile = join(root, 'electron.log');
    const args = `--remote-debugging-port=${port} "--user-data-dir=${ud}" --enable-logging=file "--log-file=${logFile}" ${extra.join(' ')}`.trim();
    const ps = `Invoke-CommandInDesktopPackage -PackageFamilyName '${MSIX_PFN}' -AppId '${MSIX_APP}' -Command '${BIN.replace(/'/g, "''")}' -Args '${args.replace(/'/g, "''")}'`;
    log.push(`launch: ${ps}\n`);
    try {
      log.push(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env, encoding: 'utf8', timeout: 60_000 }));
    } catch (e) {
      log.push(`launcher failed: ${e.message}\n${e.stdout ?? ''}${e.stderr ?? ''}`);
    }
    child = { exitCode: null, logFile };
    alive = async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })).ok;
      } catch {
        return false;
      }
    };
  } else {
    child = spawn(BIN, [`--remote-debugging-port=${port}`, `--user-data-dir=${ud}`, ...extra], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => log.push(String(d)));
    child.stderr.on('data', (d) => log.push(String(d)));
    alive = async () => child.exitCode === null;
  }
  const app = { child, log, root, port, page: null, alive };
  let target;
  const t0 = Date.now();
  while (!target && Date.now() - t0 < 120_000) {
    if (!MSIX && child.exitCode !== null) break;
    try {
      const list = await waitJson(`http://127.0.0.1:${port}/json`, 5_000);
      target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    } catch {
      /* still starting */
    }
    if (!target) await sleep(500);
  }
  if (!target) {
    writeFileSync(join(OUT, `${LABEL}-${tag}-app.log`), log.join(''));
    throw new Error(`no renderer page (exit=${child.exitCode}) — see ${LABEL}-${tag}-app.log`);
  }
  app.page = await cdp(target.webSocketDebuggerUrl);
  await app.page.send('Runtime.enable');
  await app.page.send('Page.enable');
  return app;
}

async function quit(app, tag) {
  try {
    app.page?.close();
  } catch {
    /* closed */
  }
  if (MSIX) {
    // Not our child process: end the packaged app (and the shells/agents it started) by image name.
    try {
      execFileSync('taskkill', ['/F', '/T', '/IM', basename(BIN)], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
    await sleep(1500);
    try {
      copyFileSync(app.child.logFile, join(OUT, `${LABEL}-${tag}-electron.log`));
    } catch {
      /* no log written */
    }
  } else {
    app.child.kill();
    await sleep(1500);
    if (app.child.exitCode === null) app.child.kill('SIGKILL');
  }
  writeFileSync(join(OUT, `${LABEL}-${tag}-app.log`), app.log.join(''));
}

/** Waits until the React root has rendered real text. */
async function waitRendered(page, ms = 90_000, want = '') {
  const t0 = Date.now();
  let text = '';
  while (Date.now() - t0 < ms) {
    try {
      text = await page.evaluate(`document.readyState === 'complete' ? (document.getElementById('root')?.innerText || '') : ''`);
      if (text.trim().length > 20 && (!want || text.includes(want))) return text;
    } catch {
      /* navigating */
    }
    await sleep(500);
  }
  return text;
}

// The installed app's own version (asar is disabled, so package.json sits in resources/app).
const resDir = process.platform === 'darwin' ? join(dirname(BIN), '..', 'Resources') : join(dirname(BIN), 'resources');
try {
  const v = JSON.parse(readFileSync(join(resDir, 'app', 'package.json'), 'utf8')).version;
  check('installed app version', !!v, v);
} catch (e) {
  check('installed app version', false, String(e.message));
}

// Installers are fully open source: Anthropic's proprietary Claude Agent SDK is downloaded on first use instead.
{
  const nm = join(resDir, 'app', 'node_modules', '@anthropic-ai');
  const left = existsSync(nm) ? readdirSync(nm).filter((n) => n.startsWith('claude-agent-sdk')) : [];
  check('no proprietary Claude Agent SDK in the installer', left.length === 0, left.join(', '));
}

/**
 * MSIX only, in the app's own terminal (a child of the packaged app, so it runs in the package too):
 * 1. it has package identity (proves the launch really was a Store-style packaged launch);
 * 2. a NEW file it writes under %APPDATA% is visible at the real %APPDATA% (build/appxmanifest.xml turns write
 *    virtualization off, so `npm install -g` from the app lands where the user's own terminal finds it).
 * The command runs in Windows PowerShell whatever the terminal's shell is, and has no `$` so no outer shell
 * expands anything; the markers are split ('OLY_PK'+'G_') so the echoed input never matches.
 */
async function msixTerminalChecks(page, ptyId) {
  const probe = `oly-msix-probe-${process.pid}-${Date.now()}.txt`;
  const real = join(process.env.APPDATA || '', probe);
  rmSync(real, { force: true });
  // Package identity straight from the Win32 API (GetCurrentPackageFamilyName): 0 = identity, 15700 =
  // APPMODEL_ERROR_NO_PACKAGE; any other code is printed so a broken probe can't pass for "no identity".
  const script = [
    `Add-Type -Namespace Oly -Name Pkg -MemberDefinition '[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern int GetCurrentPackageFamilyName(ref uint length, System.Text.StringBuilder name);'`,
    `$len = [uint32]0; $sb = $null`,
    `$rc = [Oly.Pkg]::GetCurrentPackageFamilyName([ref]$len, $sb)`,
    `if ($rc -eq 122) { $sb = New-Object System.Text.StringBuilder ([int]$len); $rc = [Oly.Pkg]::GetCurrentPackageFamilyName([ref]$len, $sb) }`,
    `if ($rc -eq 0) { 'OLY_PK' + 'G_' + $sb.ToString() + '_END' } else { 'OLY_PK' + 'G_NONE' + $rc + '_END' }`,
    `Set-Content -LiteralPath (Join-Path ([Environment]::GetFolderPath('ApplicationData')) '${probe}') -Value ok`,
    `'OLY_WR' + 'OTE_END'`,
  ].join('\n');
  // -EncodedCommand (UTF-16LE base64): no quoting or `$` expansion by whatever shell the terminal runs.
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  await page.evaluate(`window.desk.invoke('pty.write', ${JSON.stringify(ptyId)}, ${JSON.stringify(`powershell -NoProfile -EncodedCommand ${enc}\r`)})`);
  let buf = '';
  for (let i = 0; i < 60 && !/OLY_WROTE_END/.test(buf); i++) {
    await sleep(500);
    const b = await page.evaluate(`window.desk.invoke('pty.buffer', ${JSON.stringify(ptyId)})`);
    buf = (b?.data || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r?\n/g, '\n');
  }
  const pfn = /OLY_PKG_([A-Za-z0-9._-]+?)_END/.exec(buf)?.[1];
  check('MSIX: the app (and its terminal) runs with package identity', pfn === MSIX_PFN, pfn ? `family name ${pfn}` : JSON.stringify(buf.trim().slice(-200)));
  const wrote = /OLY_WROTE_END/.test(buf);
  check('MSIX: a new %APPDATA% file written inside the package is visible outside it (no write virtualization)', wrote && existsSync(real), wrote ? real : 'the probe command did not finish');
  rmSync(real, { force: true });
  // Diagnostic only (not a check): which package Windows itself lists for the app's processes.
  try {
    const rows = execFileSync('tasklist', ['/apps', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).split(/\r?\n/).filter((l) => /Olympus/i.test(l));
    console.log(`INFO  tasklist /apps: ${rows.length ? rows.join(' | ') : 'no Olympus process listed'}`);
  } catch (e) {
    console.log(`INFO  tasklist /apps failed: ${e.message}`);
  }
}

// 1. First run, fresh profile.
try {
  const app = await launch('firstrun', {});
  const text = await waitRendered(app.page);
  check('first run: window renders UI', text.trim().length > 20, JSON.stringify(text.trim().slice(0, 120)));
  await sleep(4000);
  check('first run: main process still alive after render', await app.alive());
  const errs = errorsOf(app.page);
  check('first run: no uncaught renderer exceptions', !errs.some((e) => e.startsWith('exception')), errs.slice(0, 5).join(' | '));
  console.log(`      screenshot: ${await shot(app.page, 'firstrun')}`);
  await quit(app, 'firstrun');
} catch (e) {
  check('first run', false, e.message);
}

// 2. Onboarded profile with one project: main UI + real terminal through node-pty.
try {
  const projDir = mkdtempSync(join(tmpdir(), 'oc-smoke-project-'));
  writeFileSync(join(projDir, 'README.md'), '# smoke project\n');
  const projectId = 'smoke-project-0001';
  const app = await launch('main', {
    settings: { onboarded: true },
    projects: [{ id: projectId, name: 'smoke-project', path: projDir, createdAt: Date.now() }],
  });
  const text = await waitRendered(app.page, 90_000, 'smoke-project'); // projects load a moment after the shell
  check('main UI: renders with the seeded project', text.includes('smoke-project'), JSON.stringify(text.trim().slice(0, 160)));
  await sleep(3000); // let the splash fade so the screenshot shows the real UI
  console.log(`      screenshot: ${await shot(app.page, 'main')}`);

  const ptyId = await app.page.evaluate(`window.desk.invoke('term.start', ${JSON.stringify(projectId)})`);
  check('terminal: term.start returns a pty id', typeof ptyId === 'string' && ptyId.length > 0, String(ptyId));
  if (ptyId) {
    await sleep(2500);
    // Only the shell's own expansion can print the expected line; the echoed input never matches it.
    // Windows: PowerShell expands $($env:…), cmd expands %…% — one of the two lines works in either shell.
    const cmd =
      process.platform === 'win32'
        ? 'echo "OLY_PTY_$($env:COMPUTERNAME)_OK"\recho OLY_PTY_%COMPUTERNAME%_OK\r'
        : 'echo OLY_PTY_$((40+2))_OK\r';
    await app.page.evaluate(`window.desk.invoke('pty.write', ${JSON.stringify(ptyId)}, ${JSON.stringify(cmd)})`);
    let buf = '';
    const want = process.platform === 'win32' ? /OLY_PTY_[A-Za-z0-9-]+_OK/ : /OLY_PTY_42_OK/;
    for (let i = 0; i < 40 && !want.test(buf); i++) {
      await sleep(500);
      const b = await app.page.evaluate(`window.desk.invoke('pty.buffer', ${JSON.stringify(ptyId)})`);
      buf = b?.data || '';
    }
    const hit = buf.match(want)?.[0];
    check('terminal: shell ran a command (node-pty works)', !!hit, hit ? `matched ${hit}` : JSON.stringify(buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim().slice(-160)));
    if (MSIX) await msixTerminalChecks(app.page, ptyId);
  }
  console.log(`      screenshot: ${await shot(app.page, 'main-after-terminal')}`);
  // Claude Code: ready where it is installed (SDK downloaded on demand), else "not installed" with the install command.
  const claude = await app.page.evaluate(`window.desk.invoke('agents.check', 'claude').then((s) => ({ state: s.state, detail: s.detail || '' }), (e) => ({ state: 'threw', detail: e.message }))`);
  const claudeOk = claude.state === 'not-installed' ? /claude\.ai\/install/.test(claude.detail) : !['error', 'threw'].includes(claude.state);
  check('Claude Code status is usable (ready, or not installed + install command)', claudeOk, `${claude.state}: ${claude.detail.slice(0, 140)}`);
  // OLY_SMOKE_EXPECT_CLAUDE=installed (CI installs Claude Code with npm first): it must be detected, the SDK downloaded
  // on demand and the adapter started — "ready" or "needs-login" (no account on CI), never "not-installed"/"error".
  if (process.env.OLY_SMOKE_EXPECT_CLAUDE === 'installed') {
    check('Claude Code installed by the user is detected and its adapter starts (SDK on demand)', ['ready', 'needs-login'].includes(claude.state), `${claude.state}: ${claude.detail.slice(0, 160)}`);
  }
  if (MSIX) {
    // A Store copy never offers the GitHub installer: Settings shows one line and "Check now" asks nobody.
    const last = await app.page.evaluate(`window.desk.invoke('updates.lastCheck')`);
    check('Store copy: Settings says it updates through the Microsoft Store', last?.managed === 'store' && last?.text === STORE_UPDATE_TEXT, JSON.stringify(last));
    const now = await app.page.evaluate(`window.desk.invoke('updates.check')`);
    check('Store copy: "Check now" answers with the Store line', now?.managed === 'store' && now?.text === STORE_UPDATE_TEXT, JSON.stringify(now));
    check('Store copy: no update notice', (await app.page.evaluate(`window.desk.invoke('updates.current')`)) == null);
  }
  const errs = errorsOf(app.page);
  check('main UI: no uncaught renderer exceptions', !errs.some((e) => e.startsWith('exception')), errs.slice(0, 5).join(' | '));
  check('main UI: main process still alive', await app.alive());
  await quit(app, 'main');
} catch (e) {
  check('main UI', false, e.message);
}

writeFileSync(join(OUT, `${LABEL}-results.json`), JSON.stringify({ label: LABEL, failed, results }, null, 2));
console.log(`\n${LABEL}: ${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
