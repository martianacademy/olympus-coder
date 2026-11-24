/**
 * Isolated, focus-free Electron + CDP end-to-end test for composer `@` file & attachment mentions:
 * proves attached composer files appear FIRST (`Attached in message`), project files appear below
 * (`Project files`, skipping `node_modules`), emails don't falsely trigger, and on-wire ACP prompt
 * receives both the `@file` references and `@name → path` attachment mapping.
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const ELECTRON_BIN = join(REPO, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
assert.ok(existsSync(ELECTRON_BIN), `Missing Electron binary at ${ELECTRON_BIN}`);

const scratch = mkdtempSync(join(tmpdir(), 'olympus-mention-e2e-'));
const udDir = join(scratch, 'ud');
const sharedDir = join(scratch, 'shared');
const projDir = join(scratch, 'quantum-lab');
const fakeAgent = join(scratch, 'fake-agent.mjs');
const promptLog = join(scratch, 'prompts.jsonl');
const cdpPort = 19700 + Math.floor(Math.random() * 200);

mkdirSync(udDir, { recursive: true });
mkdirSync(sharedDir, { recursive: true });
mkdirSync(join(projDir, 'src/quantum'), { recursive: true });
mkdirSync(join(projDir, 'src/math'), { recursive: true });
mkdirSync(join(projDir, 'node_modules/pkg'), { recursive: true });

writeFileSync(join(projDir, 'README.md'), '# Quantum Lab\n');
writeFileSync(join(projDir, 'src/quantum/circuit.py'), 'def bell_state(): pass\n');
writeFileSync(join(projDir, 'src/math/proof.py'), 'def check_mod9(): pass\n');
writeFileSync(join(projDir, 'node_modules/pkg/ignored.js'), 'module.exports = 1;\n');

// Minimal valid 1x1 PNG file to attach to the composer
const pngPath = join(scratch, 'bloch-sphere.png');
const tinyPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=';
writeFileSync(pngPath, Buffer.from(tinyPngBase64, 'base64'));

writeFileSync(
  join(udDir, 'settings.json'),
  JSON.stringify(
    {
      onboarded: true,
      uiMode: 'code',
      defaultAgent: 'claude',
      lastProjectId: 'proj_qlab',
      sharedRoot: sharedDir,
      migratedFromAgents: true,
      customAgents: [],
    },
    null,
    2,
  ),
);
writeFileSync(
  join(sharedDir, 'projects.json'),
  JSON.stringify([{ id: 'proj_qlab', name: 'quantum-lab', path: projDir, createdAt: Date.now() }], null, 2),
);

writeFileSync(
  fakeAgent,
  `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let sid = 0;

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (!m.method) return;
  const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') {
    return ok({
      protocolVersion: 1,
      agentInfo: { name: 'fake-claude', title: 'Fake Claude', version: '1.0.0' },
      authMethods: [],
      agentCapabilities: { promptCapabilities: { image: true } },
    });
  }
  if (m.method === 'session/new') return ok({ sessionId: 'mn_' + (++sid), configOptions: [] });
  if (m.method === 'session/prompt') {
    const blocks = Array.isArray(m.params?.prompt) ? m.params.prompt : [];
    const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text);
    appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify({ joined: texts.join('\\n---\\n') }) + '\\n');
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'MENTION_RECEIVED_OK' } } },
    });
    return ok({ stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 12 } });
  }
  return ok({});
});
`,
  { mode: 0o755 },
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.OLYMPUS_HOME;
env.OLYMPUS_TEST_HIDDEN = '1';
env.AGENTDESK_SHARED_ROOT = sharedDir;
env.OLYMPUS_CLAUDE_ADAPTER = fakeAgent;

const child = spawn(
  ELECTRON_BIN,
  [REPO, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${udDir}`],
  { env, stdio: ['ignore', 'pipe', 'pipe'] },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (e) {
      lastErr = e;
    }
    await sleep(150);
  }
  throw new Error(`Timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.pageErrors = [];
  }
  async connect() {
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        this.consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.pageErrors.push(msg.params?.exceptionDetails?.text || 'Uncaught exception');
      }
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

let cdp;
try {
  const target = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    if (!r.ok) return null;
    return (await r.json()).find((t) => t.type === 'page' && t.url.includes('index.html'));
  }, 'renderer page');

  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();

  // Wait for Code composer to mount (or create a chat in quantum-lab)
  await waitFor(() => cdp.eval(`(() => {
    document.getElementById('splash')?.remove();
    const ta = document.querySelector('[data-testid="composer"]');
    if (ta) return true;
    const newBtn = document.querySelector('.new-chat-btn, [title*="New chat"]');
    if (newBtn) newBtn.click();
    return false;
  })()`), 'Code composer ready');

  // 1. Attach bloch-sphere.png directly via real paste ClipboardEvent on composer textarea
  await cdp.eval(`(async () => {
    const bin = atob(${JSON.stringify(tinyPngBase64)});
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'bloch-sphere.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ta = document.querySelector('[data-testid="composer"]');
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);

  await waitFor(() => cdp.eval(`(document.querySelector('.composer')?.innerText || '').includes('bloch-sphere.png')`), 'attachment chip rendered');
  console.log('PASS  1. Attached bloch-sphere.png into composer');

  // 2. Type `Explain @` -> verify Attached file is FIRST and project files are BELOW (skipping node_modules)
  const menuState = await waitFor(() => cdp.eval(`(async () => {
    const ta = document.querySelector('[data-testid="composer"]');
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'Explain @');
    ta.setSelectionRange(9, 9);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const items = [...document.querySelectorAll('[data-testid="mention-item"]')];
    if (items.length < 4) return null;
    return {
      sections: [...document.querySelectorAll('.mention-section')].map((s) => s.textContent?.trim()),
      rows: items.map((el) => ({
        kind: el.getAttribute('data-kind'),
        label: el.querySelector('.mention-name')?.textContent?.trim() || '',
        detail: el.querySelector('.slash-desc')?.textContent?.trim() || '',
      })),
    };
  })()`), 'mention-menu with attachments + project files');

  assert.deepEqual(menuState.sections, ['Attached in message', 'Project files']);
  assert.equal(menuState.rows[0].kind, 'attachment');
  assert.match(menuState.rows[0].label, /bloch-sphere\.png.*Attached/);
  assert.ok(menuState.rows.some((r) => r.kind === 'file' && r.label === 'circuit.py' && r.detail === 'src/quantum'));
  assert.ok(!menuState.rows.some((r) => r.label.includes('ignored.js')), 'node_modules must be skipped');
  console.log('PASS  2. `@` menu lists Attached file FIRST and Project files BELOW (node_modules skipped)');

  // 3. Click attached item -> inserts `@bloch-sphere.png `, then type `with @cir` and pick `src/quantum/circuit.py`
  const afterPicks = await cdp.eval(`(async () => {
    document.querySelector('[data-testid="mention-item"][data-kind="attachment"]').click();
    await new Promise((r) => setTimeout(r, 120));
    const ta = document.querySelector('[data-testid="composer"]');
    const afterFirst = ta.value;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    const next = afterFirst + 'with @cir';
    setter.call(ta, next);
    ta.setSelectionRange(next.length, next.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    document.querySelector('[data-testid="mention-item"][data-kind="file"]').click();
    await new Promise((r) => setTimeout(r, 120));
    return { afterFirst, finalVal: ta.value };
  })()`);
  assert.equal(afterPicks.afterFirst, 'Explain @bloch-sphere.png ');
  assert.equal(afterPicks.finalVal, 'Explain @bloch-sphere.png with @src/quantum/circuit.py ');
  console.log('PASS  3. Picking attachment + project file inserts exact `@bloch-sphere.png` & `@src/quantum/circuit.py`');

  // 4. Verify email address does not trigger mention popup
  const emailOpen = await cdp.eval(`(async () => {
    const ta = document.querySelector('[data-testid="composer"]');
    const orig = ta.value;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    const withEmail = orig + 'cc user@gmail.com';
    setter.call(ta, withEmail);
    ta.setSelectionRange(withEmail.length, withEmail.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    const isOpen = Boolean(document.querySelector('[data-testid="mention-menu"]'));
    setter.call(ta, orig);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return isOpen;
  })()`);
  assert.equal(emailOpen, false, 'Email addresses must not open @ mention menu');
  console.log('PASS  4. Email addresses do not falsely trigger `@` mention menu');

  // 5. Send message and verify on-wire ACP prompt has both `@` refs AND `- @bloch-sphere.png → <path>` mapping
  await sleep(100);
  await cdp.eval(`document.querySelector('.composer .send-btn').click()`);
  await waitFor(() => cdp.eval(`(document.body.innerText || '').includes('MENTION_RECEIVED_OK')`), 'agent reply');

  const logEntry = JSON.parse(readFileSync(promptLog, 'utf8').trim().split('\n')[0]);
  assert.match(logEntry.joined, /Explain @bloch-sphere\.png with @src\/quantum\/circuit\.py/);
  assert.match(logEntry.joined, /- @bloch-sphere\.png → .*bloch-sphere\.png \(image\/png\)/);
  console.log('PASS  5. On-wire ACP payload includes both `@` references and explicit `@bloch-sphere.png → path` mapping');

  // 6. Desktop + Mobile overflow & 0 console errors
  const deskOverflow = await cdp.eval(`document.documentElement.scrollWidth > window.innerWidth + 1`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await sleep(150);
  const mobOverflow = await cdp.eval(`document.documentElement.scrollWidth > window.innerWidth + 1`);
  assert.equal(deskOverflow, false);
  assert.equal(mobOverflow, false);
  assert.deepEqual(cdp.consoleErrors, []);
  assert.deepEqual(cdp.pageErrors, []);
  console.log('PASS  6. Zero horizontal overflow (1280×800 & 390×844) and 0 console/page errors');
} finally {
  cdp?.close();
  try { child.kill('SIGKILL'); } catch {}
  try { execFileSync('pkill', ['-9', '-f', scratch], { stdio: 'ignore' }); } catch {}
  await sleep(250);
  rmSync(scratch, { recursive: true, force: true });
}

console.log('\nALL 6/6 @-MENTION E2E CHECKS PASSED!');
process.exit(0);
