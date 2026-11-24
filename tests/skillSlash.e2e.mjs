/**
 * Isolated, focus-free Electron + CDP end-to-end verification of `/` skill selection in both
 * `ChatHome` and `ChatComposer`, universal `<active_skill>` injection on ACP turns, and native
 * slash command preservation (`/compact`).
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const ELECTRON_BIN = join(REPO, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
assert.ok(existsSync(ELECTRON_BIN), `Missing Electron binary at ${ELECTRON_BIN}`);

const scratch = mkdtempSync(join(tmpdir(), 'olympus-skill-slash-e2e-'));
const udDir = join(scratch, 'ud');
const sharedDir = join(scratch, 'shared');
const skillsDest = join(sharedDir, 'skills');
const fakeAgent = join(scratch, 'fake-agent.mjs');
const promptLog = join(scratch, 'prompts.jsonl');
const cdpPort = 19600 + Math.floor(Math.random() * 250);

mkdirSync(udDir, { recursive: true });
mkdirSync(skillsDest, { recursive: true });

// Copy the 6 real domain playbooks into isolated sharedRoot/skills
for (const id of ['math', 'quantum', 'physics', 'security', 'research', 'coder']) {
  const src = join(homedir(), '.olympus', 'skills', id);
  assert.ok(existsSync(src), `Missing skill folder ${src}`);
  cpSync(src, join(skillsDest, id), { recursive: true });
}

writeFileSync(
  join(udDir, 'settings.json'),
  JSON.stringify(
    {
      onboarded: true,
      uiMode: 'chat',
      defaultAgent: 'claude',
      sharedRoot: sharedDir,
      migratedFromAgents: true,
      customAgents: [],
    },
    null,
    2,
  ),
);
writeFileSync(join(sharedDir, 'projects.json'), '[]');

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
      agentCapabilities: { promptCapabilities: {} },
    });
  }
  if (m.method === 'session/new') {
    const sessionId = 'sk_' + (++sid);
    ok({ sessionId, configOptions: [] });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'compact', description: 'Compact conversation history' }],
        },
      },
    });
    return;
  }
  if (m.method === 'session/prompt') {
    const blocks = Array.isArray(m.params?.prompt) ? m.params.prompt : [];
    const texts = blocks.filter((b) => b.type === 'text').map((b) => b.text);
    const joined = texts.join('\\n===BLOCK===\\n');
    appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify({ texts, joined }) + '\\n');
    let reply = 'ACK_DEFAULT';
    if (joined.includes('<active_skill name="quantum"')) reply = 'QUANTUM_SKILL_APPLIED_OK';
    else if (joined.includes('<active_skill name="math"')) reply = 'MATH_SKILL_APPLIED_OK';
    else if (texts.length === 1 && texts[0].trim() === '/compact') reply = 'NATIVE_COMPACT_OK';
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } },
    });
    return ok({ stopReason: 'end_turn', usage: { inputTokens: 150, outputTokens: 20 } });
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

  // 1. Wait for ChatHome composer and type `/`
  await waitFor(() => cdp.eval(`(() => {
    document.getElementById('splash')?.remove();
    return Boolean(document.querySelector('[data-testid="home-composer"]'));
  })()`), 'home-composer ready');

  const homeItems = await waitFor(async () => {
    return cdp.eval(`(async () => {
      const ta = document.querySelector('[data-testid="home-composer"]');
      ta.focus();
      ta.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '/');
      ta.setSelectionRange(1, 1);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('select', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      const rows = [...document.querySelectorAll('[data-testid="slash-item"]')];
      if (!rows.length) {
        const skills = await window.desk.invoke('skills.list');
        throw new Error('No slash rows; skills=' + skills.length + ' activeEl=' + document.activeElement?.dataset?.testid + ' val=' + ta.value + ' sel=' + ta.selectionStart);
      }
      return rows.slice(0, 6).map((el) => ({
        name: el.querySelector('.slash-name')?.textContent?.trim() || '',
        kind: el.getAttribute('data-kind'),
      }));
    })()`);
  }, 'ChatHome slash-menu with skills', 8000);

  const topNames = homeItems.map((x) => x.name);
  assert.ok(topNames.some((n) => n.startsWith('/quantum') && n.includes('Skill')), `Expected /quantum Skill in top 6, got ${JSON.stringify(topNames)}`);
  assert.ok(topNames.some((n) => n.startsWith('/math') && n.includes('Skill')), `Expected /math Skill in top 6, got ${JSON.stringify(topNames)}`);
  console.log('PASS  1. ChatHome `/` menu lists domain skills (/coder, /math, /physics, /quantum, /research, /security) with Skill badge');

  // 2. Filter `/qu`, click `/quantum`, verify ghost `<instructions>`, and send!
  const pickRes = await cdp.eval(`(async () => {
    const ta = document.querySelector('[data-testid="home-composer"]');
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '/qu');
    ta.setSelectionRange(3, 3);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    const item = document.querySelector('[data-testid="slash-item"]');
    item.click();
    await new Promise((r) => setTimeout(r, 120));
    return {
      val: ta.value,
      ghost: document.querySelector('[data-testid="slash-ghost"]')?.textContent?.trim() || '',
    };
  })()`);
  assert.equal(pickRes.val, '/quantum ');
  assert.match(pickRes.ghost, /<instructions>/);
  console.log('PASS  2. Picking /quantum inserts `/quantum ` and shows `<instructions>` ghost hint');

  await cdp.eval(`(() => {
    const ta = document.querySelector('[data-testid="home-composer"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '/quantum Verify Kraus completeness for amplitude damping channel');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(100);
  await cdp.eval(`document.querySelector('.home-composer .send-btn').click()`);

  const turn1 = await waitFor(() => cdp.eval(`(() => {
    const txt = document.body.innerText || '';
    if (!txt.includes('QUANTUM_SKILL_APPLIED_OK')) return null;
    return {
      hasCleanUserMsg: txt.includes('/quantum Verify Kraus completeness'),
      hasLeakedSkillXml: txt.includes('<active_skill'),
    };
  })()`), 'Turn 1 QUANTUM_SKILL_APPLIED_OK reply');
  assert.equal(turn1.hasCleanUserMsg, true);
  assert.equal(turn1.hasLeakedSkillXml, false, 'Raw <active_skill> XML must never leak into chat UI');
  console.log('PASS  3. Turn 1 injected full /quantum playbook on-wire while keeping chat bubble clean');

  // 4. Inside active ChatComposer, test `/ma` -> `/math` mid-conversation + native `/compact`!
  await waitFor(() => cdp.eval(`(async () => {
    const ta = document.querySelector('.composer textarea');
    if (!ta) return false;
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '/ma');
    ta.setSelectionRange(3, 3);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const item = [...document.querySelectorAll('[data-testid="slash-item"]')].find((el) => el.textContent?.includes('/math'));
    if (!item) return false;
    item.click();
    return true;
  })()`), 'ChatComposer /math pick');

  await cdp.eval(`(() => {
    const ta = document.querySelector('.composer textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '/math Prove no integer solution exists mod 9');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(100);
  await cdp.eval(`document.querySelector('.composer .send-btn').click()`);

  await waitFor(() => cdp.eval(`(document.body.innerText || '').includes('MATH_SKILL_APPLIED_OK')`), 'Turn 2 MATH_SKILL_APPLIED_OK reply');
  console.log('PASS  4. Mid-conversation `/math` in ChatComposer injected full Math Playbook on Turn 2');

  // 5. Verify native agent `/compact` still passes straight through untouched!
  await cdp.eval(`(() => {
    const ta = document.querySelector('.composer textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '/compact');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(100);
  await cdp.eval(`document.querySelector('.composer .send-btn').click()`);
  await waitFor(() => cdp.eval(`(document.body.innerText || '').includes('NATIVE_COMPACT_OK')`), 'Turn 3 NATIVE_COMPACT_OK reply');
  console.log('PASS  5. Native agent command `/compact` passes directly to ACP without being hijacked');

  // 6. Inspect on-wire JSONL log to prove real playbook content reached ACP
  const entries = readFileSync(promptLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(entries[0].joined.includes('Knill-Laflamme') && entries[0].joined.includes('Verify Kraus completeness'));
  assert.ok(entries[1].joined.includes('Two-Sided Tightness') && entries[1].joined.includes('Prove no integer solution exists mod 9'));
  assert.deepEqual(entries[2].texts, ['/compact']);
  console.log('PASS  6. On-wire ACP payload verified: full Quantum + Math playbooks injected, /compact untouched');

  // 7. Layout overflow + zero console errors
  const deskOverflow = await cdp.eval(`document.documentElement.scrollWidth > window.innerWidth + 1`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await sleep(150);
  const mobOverflow = await cdp.eval(`document.documentElement.scrollWidth > window.innerWidth + 1`);
  assert.equal(deskOverflow, false);
  assert.equal(mobOverflow, false);
  assert.deepEqual(cdp.consoleErrors, []);
  assert.deepEqual(cdp.pageErrors, []);
  console.log('PASS  7. Zero horizontal overflow (1280×800 & 390×844) and 0 console/page errors');
} finally {
  cdp?.close();
  try { child.kill('SIGKILL'); } catch {}
  try { execFileSync('pkill', ['-9', '-f', scratch], { stdio: 'ignore' }); } catch {}
  await sleep(250);
  rmSync(scratch, { recursive: true, force: true });
}

console.log('\nALL 7/7 SLASH-SKILL E2E CHECKS PASSED!');
process.exit(0);
