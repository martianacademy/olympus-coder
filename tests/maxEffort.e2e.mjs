/**
 * Isolated, focus-free Electron + CDP end-to-end test for Max Effort (`Max` tab · Dual-Mind Adversarial Thinking).
 * Uses `OLYMPUS_TEST_HIDDEN=1`, isolated `--user-data-dir` + `AGENTDESK_SHARED_ROOT`, and local fake ACP adapters
 * (`OLYMPUS_CLAUDE_ADAPTER` + `OLYMPUS_AGY_BIN`) so zero real user state, focus, or API quota is touched.
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

const scratch = mkdtempSync(join(tmpdir(), 'olympus-max-effort-e2e-'));
const udDir = join(scratch, 'ud');
const sharedDir = join(scratch, 'shared');
const projDir = join(scratch, 'math-lab');
const solverScript = join(scratch, 'fake-solver.mjs');
const criticScript = join(scratch, 'fake-critic.mjs');
const traceLog = join(scratch, 'acp-prompts.jsonl');
const cdpPort = 19400 + Math.floor(Math.random() * 400);

mkdirSync(udDir, { recursive: true });
mkdirSync(sharedDir, { recursive: true });
mkdirSync(projDir, { recursive: true });

// Pre-seed settings so onboarding is skipped cleanly in isolated userData
writeFileSync(
  join(udDir, 'settings.json'),
  JSON.stringify(
    {
      onboarded: true,
      defaultAgent: 'claude',
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
  JSON.stringify([{ id: 'proj_math', name: 'math-lab', path: projDir, createdAt: Date.now() }], null, 2),
);

const makeFakeAgent = (role) => `#!/usr/bin/env node
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
      agentInfo: { name: '${role}', title: '${role}', version: '1.0.0' },
      authMethods: [],
      agentCapabilities: { promptCapabilities: {} },
    });
  }
  if (m.method === 'session/new') {
    return ok({ sessionId: '${role}_' + (++sid), configOptions: [] });
  }
  if (m.method === 'session/prompt') {
    const blocks = Array.isArray(m.params?.prompt) ? m.params.prompt : [];
    const promptText = blocks.map((b) => b.text || '').join('\\n');
    appendFileSync(${JSON.stringify(traceLog)}, JSON.stringify({ role: '${role}', promptText }) + '\\n');

    const sessionId = m.params.sessionId;
    const emitThought = (text) => send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } } },
    });
    const emitText = (text) => send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
    });

    if (promptText.includes('MAX EFFORT · DUAL-MIND DELIBERATION — ROUND 0')) {
      if ('${role}' === 'solver') {
        // Simulates hidden-CoT provider (like Claude Opus) exposing <scratchpad>
        emitText('<scratchpad>Solver blind hypothesis: checking modular invariant mod 8 and parity bounds.</scratchpad>\\nSolver blind proposal: bound parity via mod 8.');
      } else {
        // Simulates streamed-CoT provider (like Gemini Antigravity) streaming agent_thought_chunk + <scratchpad>
        emitThought('Critic streamed CoT: spotted mod 9 cubic residue obstruction (cubes mod 9 in {0,1,8}).');
        emitText('<scratchpad>Discarded naive search; mod 9 obstruction is decisive.</scratchpad>\\nCritic blind proposal: use mod 9 cubic residues.');
      }
    } else if (promptText.includes('MAX EFFORT · DUAL-MIND MIND-CRITIQUE — ROUND')) {
      if ('${role}' === 'solver') {
        emitText('<scratchpad>Verified Critic streamed CoT mod 9 obstruction! Merging mod 8 + mod 9 closes all cases.</scratchpad>\\nVERDICT: CONVERGED\\nUnified proof plan locked.');
      } else {
        emitThought('Critic Round 1 CoT: Solver mod 8 + our mod 9 leaves zero remaining branches.');
        emitText('VERDICT: CONVERGED\\nAll assumptions audited and verified.');
      }
    } else if (promptText.includes('[Max Effort · Dual-Mind Synthesis]')) {
      emitText('**Breakthrough Proof:** Combining the mod 8 parity invariant with the mod 9 cubic obstruction yields the unique solution $(a, b) = (2, 3)$.');
    } else {
      emitText('Fallback reply from ${role}');
    }
    return ok({ stopReason: 'end_turn', usage: { inputTokens: 200, outputTokens: 60 } });
  }
  return ok({});
});
`;

writeFileSync(solverScript, makeFakeAgent('solver'), { mode: 0o755 });
writeFileSync(criticScript, makeFakeAgent('critic'), { mode: 0o755 });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.OLYMPUS_HOME;
env.OLYMPUS_TEST_HIDDEN = '1';
env.OLYMPUS_MAX_EFFORT_ENABLED = '1';
env.AGENTDESK_SHARED_ROOT = sharedDir;
env.OLYMPUS_CLAUDE_ADAPTER = solverScript;
env.OLYMPUS_AGY_BIN = criticScript;

const child = spawn(
  ELECTRON_BIN,
  [REPO, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${udDir}`],
  { env, stdio: ['ignore', 'pipe', 'pipe'] },
);

let stderr = '';
child.stderr.on('data', (d) => (stderr += d.toString()));

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
  throw new Error(`Timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}\nStderr tail: ${stderr.slice(-600)}`);
}

class CdpSession {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.pageErrors = [];
  }
  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        this.consoleErrors.push(text);
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
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(`Eval exception: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

let cdp;
try {
  const target = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    if (!r.ok) return null;
    const list = await r.json();
    return list.find((t) => t.type === 'page' && t.url.includes('index.html'));
  }, 'CDP renderer page');

  cdp = new CdpSession(target.webSocketDebuggerUrl);
  await cdp.connect();

  // Remove splash overlay in hidden mode (timers are throttled in hidden windows) and wait for ModeSwitch
  await waitFor(async () => {
    return cdp.eval(`(() => {
      document.getElementById('splash')?.remove();
      return Boolean(document.querySelector('[data-testid="mode-max"]'));
    })()`);
  }, 'mode-max button rendered');
  console.log('PASS  1. ModeSwitch renders Max (⌘3) button alongside Chat and Code');

  // Click Max mode button
  await cdp.eval(`(() => {
    document.querySelector('[data-testid="mode-max"]').click();
    return true;
  })()`);

  const homeState = await waitFor(async () => {
    return cdp.eval(`(() => {
      const home = document.querySelector('[data-testid="max-home"]');
      const bar = document.querySelector('[data-testid="max-effort-bar"]');
      if (!home || !bar) return null;
      return {
        title: home.querySelector('h1.greeting')?.textContent?.trim() || '',
        sub: home.querySelector('.max-home-sub')?.textContent?.trim() || '',
        solverText: document.querySelector('[data-testid="max-solver-picker"] .max-role-name')?.textContent?.trim() || '',
        criticText: document.querySelector('[data-testid="max-critic-picker"] .max-role-name')?.textContent?.trim() || '',
      };
    })()`);
  }, 'MaxHome and MaxEffortBar rendered');

  assert.match(homeState.title, /Max Effort · Dual-Mind/i);
  assert.match(homeState.sub, /Two frontier models/i);
  console.log(`PASS  2. MaxHome & MaxEffortBar rendered (${homeState.solverText} ⇄ ${homeState.criticText})`);

  // Test Swap button twice so we verify swap & restore Claude (Solver) ⇄ Antigravity (Critic)
  const swapped = await cdp.eval(`(async () => {
    const beforeSolver = document.querySelector('[data-testid="max-solver-picker"] .max-role-name').textContent.trim();
    const beforeCritic = document.querySelector('[data-testid="max-critic-picker"] .max-role-name').textContent.trim();
    document.querySelector('[data-testid="max-swap-agents"]').click();
    await new Promise((r) => setTimeout(r, 200));
    const midSolver = document.querySelector('[data-testid="max-solver-picker"] .max-role-name').textContent.trim();
    const midCritic = document.querySelector('[data-testid="max-critic-picker"] .max-role-name').textContent.trim();
    document.querySelector('[data-testid="max-swap-agents"]').click();
    await new Promise((r) => setTimeout(r, 200));
    const afterSolver = document.querySelector('[data-testid="max-solver-picker"] .max-role-name').textContent.trim();
    return { beforeSolver, beforeCritic, midSolver, midCritic, afterSolver };
  })()`);
  assert.equal(swapped.midSolver, swapped.beforeCritic, 'Swap should move Critic into Solver');
  assert.equal(swapped.midCritic, swapped.beforeSolver, 'Swap should move Solver into Critic');
  assert.equal(swapped.afterSolver, swapped.beforeSolver, 'Second swap restores original Solver');
  console.log('PASS  3. 1-click Solver ⇄ Critic swap works cleanly');

  // Check Desktop (1280x800) and Mobile (390x844) layout invariants on MaxHome
  const desktopOverflow = await cdp.eval(`document.documentElement.scrollWidth > window.innerWidth + 1`);
  assert.equal(desktopOverflow, false, 'Zero horizontal overflow at 1280x800 on MaxHome');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await sleep(200);
  const mobileOverflowHome = await cdp.eval(`document.documentElement.scrollWidth > window.innerWidth + 1`);
  assert.equal(mobileOverflowHome, false, 'Zero horizontal overflow at 390x844 on MaxHome');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await sleep(150);
  console.log('PASS  4. Zero horizontal overflow on MaxHome at both 1280×800 and 390×844');

  // Submit a problem via MaxHome composer!
  await cdp.eval(`(() => {
    const ta = document.querySelector('[data-testid="max-home-composer"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'Find all positive integers (a, b) satisfying 3^a - 2^b = 1 using modular obstructions.');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(120);
  await cdp.eval(`(() => {
    const sendBtn = document.querySelector('[data-testid="max-home-send"]');
    sendBtn.click();
  })()`);

  // Wait for MaxEffortCard to complete with Converged status AND final synthesized message to render!
  const finalUi = await waitFor(async () => {
    return cdp.eval(`(() => {
      const card = document.querySelector('[data-testid="max-deliberation-card"]');
      if (!card || card.getAttribute('data-status') !== 'completed') return null;
      const bodyText = document.body.innerText || '';
      if (!bodyText.includes('Breakthrough Proof:')) return null;
      return {
        status: card.getAttribute('data-status'),
        badge: card.querySelector('.max-delib-badge')?.textContent?.trim() || '',
        hasInternalLeak: bodyText.includes('[Max Effort · Dual-Mind Synthesis]'),
        hasFinalAnswer: bodyText.includes('Breakthrough Proof:'),
      };
    })()`);
  }, 'Dual-Mind deliberation convergence + final synthesis reply', 25000);

  assert.equal(finalUi.status, 'completed');
  assert.equal(finalUi.badge, 'Converged');
  assert.equal(finalUi.hasInternalLeak, false, 'Internal synthesis prompt must remain hidden in Chat UI');
  assert.equal(finalUi.hasFinalAnswer, true);
  console.log('PASS  5. Full Dual-Mind ACP flow converged (Round 0 Blind + Round 1 Mind-Critique → Final Synthesis)');

  // Expand MaxEffortCard and inspect Round 0 & Round 1 raw thinking traces!
  const traceUi = await cdp.eval(`(async () => {
    const toggle = document.querySelector('[data-testid="max-delib-toggle"]');
    if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    await new Promise((r) => setTimeout(r, 120));
    const r0Btn = document.querySelector('[data-testid="max-round-0"] .max-round-head');
    if (r0Btn && r0Btn.getAttribute('aria-expanded') !== 'true') r0Btn.click();
    const r1Btn = document.querySelector('[data-testid="max-round-1"] .max-round-head');
    if (r1Btn && r1Btn.getAttribute('aria-expanded') !== 'true') r1Btn.click();
    await new Promise((r) => setTimeout(r, 120));
    const r0 = document.querySelector('[data-testid="max-round-0"]')?.innerText || '';
    const r1 = document.querySelector('[data-testid="max-round-1"]')?.innerText || '';
    return { r0, r1 };
  })()`);
  assert.match(traceUi.r0, /Solver blind hypothesis/i, 'Round 0 displays Solver <scratchpad> trace');
  assert.match(traceUi.r0, /Critic streamed CoT: spotted mod 9/i, 'Round 0 displays Critic streamed agent_thought_chunk');
  assert.match(traceUi.r1, /VERDICT: CONVERGED/i, 'Round 1 displays converged critique');
  console.log('PASS  6. Expandable MaxEffortCard displays both <scratchpad> and streamed CoT traces per round');

  // Verify ACP prompt log on disk proves peer raw thinking was genuinely exchanged in Round 1!
  const logged = readFileSync(traceLog, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const solverCritique = logged.find((x) => x.role === 'solver' && x.promptText.includes('MAX EFFORT · DUAL-MIND MIND-CRITIQUE — ROUND 1'));
  const criticCritique = logged.find((x) => x.role === 'critic' && x.promptText.includes('MAX EFFORT · DUAL-MIND MIND-CRITIQUE — ROUND 1'));
  assert.ok(solverCritique, 'Solver received Round 1 Mind-Critique prompt');
  assert.ok(criticCritique, 'Critic received Round 1 Mind-Critique prompt');
  assert.match(solverCritique.promptText, /Critic streamed CoT: spotted mod 9/, 'Solver saw Critic raw streamed CoT');
  assert.match(criticCritique.promptText, /Solver blind hypothesis: checking modular invariant mod 8/, 'Critic saw Solver raw <scratchpad>');
  console.log('PASS  7. Verified on-wire ACP exchange: Solver & Critic genuinely received each other’s raw thinking');

  // Check mobile overflow on active Max chat thread with expanded trace card
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await sleep(200);
  const mobileOverflowChat = await cdp.eval(`document.documentElement.scrollWidth > window.innerWidth + 1`);
  assert.equal(mobileOverflowChat, false, 'Zero horizontal overflow at 390x844 on active Max thread');
  console.log('PASS  8. Zero horizontal overflow on active Max chat + expanded deliberation card at 390×844');

  assert.deepEqual(cdp.consoleErrors, [], `Expected 0 console.error, got: ${cdp.consoleErrors.join('; ')}`);
  assert.deepEqual(cdp.pageErrors, [], `Expected 0 page exceptions, got: ${cdp.pageErrors.join('; ')}`);
  console.log('PASS  9. Zero console.error and zero uncaught page exceptions');
} finally {
  cdp?.close();
  try { child.kill('SIGKILL'); } catch {}
  try { execFileSync('pkill', ['-9', '-f', scratch], { stdio: 'ignore' }); } catch {}
  await sleep(300);
  rmSync(scratch, { recursive: true, force: true });
}

// Verify zero leftover test Electron processes pointing at scratch
let leftover = '';
try {
  leftover = execFileSync('pgrep', ['-fl', 'olympus-max-effort-e2e-'], { encoding: 'utf8' }).trim();
} catch {
  leftover = '';
}
assert.equal(leftover, '', `Leftover test Electron processes found: ${leftover}`);
console.log('PASS  10. Clean teardown: 0 leftover hidden Electron or fake ACP processes\n\nALL 10/10 MAX EFFORT E2E CHECKS PASSED!');
process.exit(0);
