// Packaged-app smoke test for Olympus Coder installers (Linux container / Windows CI runner).
// Launches the INSTALLED app twice with a scratch profile and drives it over CDP:
//   1. fresh profile  → first-run screen renders, no uncaught renderer errors
//   2. onboarded + one project → main UI renders, a real terminal (node-pty) runs a command
// Usage: node smoke.mjs --bin <app executable> --out <dir> [-- extra electron args]
// Needs Node 22+ (global WebSocket/fetch). No npm deps.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
  if (settings) writeFileSync(join(ud, 'settings.json'), JSON.stringify(settings, null, 2));
  if (projects) writeFileSync(join(shared, 'projects.json'), JSON.stringify(projects, null, 2));
  const port = 9300 + Math.floor(Math.random() * 500);
  const env = { ...process.env, AGENTDESK_SHARED_ROOT: shared };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(BIN, [`--remote-debugging-port=${port}`, `--user-data-dir=${ud}`, ...extra], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const app = { child, log, root, port, page: null };
  let target;
  const t0 = Date.now();
  while (!target && Date.now() - t0 < 120_000) {
    if (child.exitCode !== null) break;
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
  app.child.kill();
  await sleep(1500);
  if (app.child.exitCode === null) app.child.kill('SIGKILL');
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

// 1. First run, fresh profile.
try {
  const app = await launch('firstrun', {});
  const text = await waitRendered(app.page);
  check('first run: window renders UI', text.trim().length > 20, JSON.stringify(text.trim().slice(0, 120)));
  await sleep(4000);
  check('first run: main process still alive after render', app.child.exitCode === null);
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
  }
  console.log(`      screenshot: ${await shot(app.page, 'main-after-terminal')}`);
  // Claude Code: ready where it is installed (SDK downloaded on demand), else "not installed" with the install command.
  const claude = await app.page.evaluate(`window.desk.invoke('agents.check', 'claude').then((s) => ({ state: s.state, detail: s.detail || '' }), (e) => ({ state: 'threw', detail: e.message }))`);
  const claudeOk = claude.state === 'not-installed' ? /claude\.ai\/install/.test(claude.detail) : !['error', 'threw'].includes(claude.state);
  check('Claude Code status is usable (ready, or not installed + install command)', claudeOk, `${claude.state}: ${claude.detail.slice(0, 140)}`);
  const errs = errorsOf(app.page);
  check('main UI: no uncaught renderer exceptions', !errs.some((e) => e.startsWith('exception')), errs.slice(0, 5).join(' | '));
  check('main UI: main process still alive', app.child.exitCode === null);
  await quit(app, 'main');
} catch (e) {
  check('main UI', false, e.message);
}

writeFileSync(join(OUT, `${LABEL}-results.json`), JSON.stringify({ label: LABEL, failed, results }, null, 2));
console.log(`\n${LABEL}: ${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
