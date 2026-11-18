// Unit tests for Verify Gate (src/main/verifyGate.ts) + store persistence + MCP tool schema byte-budget guard.
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = mkdtempSync(join(tmpdir(), 'olympus-verifygate-unit-'));
const UD = join(TMP, 'userData');
const HOME = join(TMP, 'home');
const SHARED = join(TMP, 'shared');
for (const d of [UD, HOME, SHARED]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME;
process.env.AGENTDESK_SHARED_ROOT = SHARED;
writeFileSync(join(UD, 'settings.json'), JSON.stringify({ sharedRoot: SHARED, designVersion: 2, orchestrator: { enabled: true, maxParallel: 3, maxPerSession: 8 } }));

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'mock:electron', shortCircuit: true };
    if (spec === './agents' || spec.endsWith('/src/main/agents.ts')) return { url: 'mock:agents', shortCircuit: true };
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
  load(url, ctx, next) {
    if (url === 'mock:electron') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export const app = { getPath: () => ${JSON.stringify(UD)}, getVersion: () => '0.3.0', isPackaged: false, on: () => {} }; export const safeStorage = { isEncryptionAvailable: () => false }; export const shell = {}; export const BrowserWindow = { getAllWindows: () => [] }; export const dialog = {}; export const ipcMain = { handle: () => {}, on: () => {} }; export const nativeTheme = { shouldUseDarkColors: true, on: () => {} };`,
      };
    }
    if (url === 'mock:agents') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `export const agentStatuses = () => ({ defs: [], statuses: [] }); export const allAgents = () => []; export const askUserPermission = async () => true; export const chatsUsingAgent = () => []; export const checkAgent = async () => ({}); export const configureSession = async () => {}; export const forgetThread = () => {}; export const recordOlympusCall = () => {}; export const cancel = async () => {}; export const ensureSession = async () => {}; export const inheritSettings = () => ({}); export const knownOptionsForAgent = () => []; export const limitsService = { get: () => undefined }; export const preferReadOnlyMode = () => {}; export const restartAgent = () => {}; export const runState = () => ({ running: false }); export const sendPrompt = async () => {}; export const startPrompt = async () => {}; export const steerPrompt = async () => false; export const sessionView = () => null; export const switchAgent = async () => {}; export const canSteer = () => false; export const setTurnEndListener = () => {}; export const agentDef = () => undefined;`,
      };
    }
    if (url.endsWith('.json')) {
      return { format: 'json', shortCircuit: true, source: readFileSync(fileURLToPath(url), 'utf8') };
    }
    return next(url, ctx);
  },
});

const VG = await import(`${APP}/src/main/verifyGate.ts`);
const S = await import(`${APP}/src/main/store.ts`);
const ORCH = await import(`${APP}/src/main/orchestrator.ts`);

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

await test('detectVerifyCommand prefers typecheck > check > test and honours lockfile package manager', () => {
  const dirNpm = join(TMP, 'proj-npm');
  mkdirSync(dirNpm, { recursive: true });
  writeFileSync(join(dirNpm, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' } }));
  assert.equal(VG.detectVerifyCommand(dirNpm), 'npm run typecheck');

  const dirPnpm = join(TMP, 'proj-pnpm');
  mkdirSync(dirPnpm, { recursive: true });
  writeFileSync(join(dirPnpm, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  writeFileSync(join(dirPnpm, 'package.json'), JSON.stringify({ scripts: { check: 'biome check' } }));
  assert.equal(VG.detectVerifyCommand(dirPnpm), 'pnpm run check');

  const dirCargo = join(TMP, 'proj-cargo');
  mkdirSync(dirCargo, { recursive: true });
  writeFileSync(join(dirCargo, 'Cargo.toml'), '[package]\nname = "demo"\n');
  assert.equal(VG.detectVerifyCommand(dirCargo), 'cargo test');
});

await test('evaluateTurnVerifyGate skips when disabled, 0 changed files, muted, or read-only role', async () => {
  const dir = join(TMP, 'proj-skip');
  mkdirSync(dir, { recursive: true });
  const base = { threadId: 't-skip', project: { path: dir, verifyGate: { enabled: true, command: 'exit 1' } }, changedFilesCount: 1, muted: false, isReadOnlyRole: false };

  assert.equal((await VG.evaluateTurnVerifyGate({ ...base, project: { path: dir, verifyGate: { enabled: false, command: 'exit 1' } } })).action, 'skipped');
  assert.equal((await VG.evaluateTurnVerifyGate({ ...base, changedFilesCount: 0 })).action, 'skipped');
  assert.equal((await VG.evaluateTurnVerifyGate({ ...base, muted: true })).action, 'skipped');
  assert.equal((await VG.evaluateTurnVerifyGate({ ...base, isReadOnlyRole: true })).action, 'skipped');
});

await test('evaluateTurnVerifyGate retries up to maxRetries on failure, exhausts cleanly, and resets on pass or resetVerifyRetries', async () => {
  const dir = join(TMP, 'proj-gate');
  mkdirSync(dir, { recursive: true });
  const failProj = { path: dir, verifyGate: { enabled: true, command: 'echo "type error in foo.ts:12" >&2 && exit 2', maxRetries: 2 } };

  const r1 = await VG.evaluateTurnVerifyGate({ threadId: 't1', project: failProj, changedFilesCount: 2, muted: false, isReadOnlyRole: false });
  assert.equal(r1.action, 'retry');
  assert.equal(r1.attempt, 1);
  assert.equal(r1.maxRetries, 2);
  assert.match(r1.prompt ?? '', /type error in foo\.ts:12/);
  assert.equal(VG.getVerifyRetries('t1'), 1);

  const r2 = await VG.evaluateTurnVerifyGate({ threadId: 't1', project: failProj, changedFilesCount: 1, muted: false, isReadOnlyRole: false });
  assert.equal(r2.action, 'retry');
  assert.equal(r2.attempt, 2);
  assert.equal(VG.getVerifyRetries('t1'), 2);

  const r3 = await VG.evaluateTurnVerifyGate({ threadId: 't1', project: failProj, changedFilesCount: 1, muted: false, isReadOnlyRole: false });
  assert.equal(r3.action, 'exhausted');
  assert.equal(r3.result?.exitCode, 2);

  // Passing run resets consecutive retry count back to 0.
  const passProj = { path: dir, verifyGate: { enabled: true, command: 'echo "all good"', maxRetries: 2 } };
  const rPass = await VG.evaluateTurnVerifyGate({ threadId: 't1', project: passProj, changedFilesCount: 1, muted: false, isReadOnlyRole: false });
  assert.equal(rPass.action, 'passed');
  assert.equal(VG.getVerifyRetries('t1'), 0);

  // Fresh user turn resets retry count explicitly.
  await VG.evaluateTurnVerifyGate({ threadId: 't1', project: failProj, changedFilesCount: 1, muted: false, isReadOnlyRole: false });
  assert.equal(VG.getVerifyRetries('t1'), 1);
  VG.resetVerifyRetries('t1');
  assert.equal(VG.getVerifyRetries('t1'), 0);
});

await test('store.updateProjectVerifyGate persists config on project record', () => {
  const dir = join(TMP, 'proj-store');
  mkdirSync(dir, { recursive: true });
  const p = S.addProject(dir);
  const updated = S.updateProjectVerifyGate(p.id, { enabled: true, command: 'npm run typecheck', maxRetries: 2 });
  assert.equal(updated?.verifyGate?.enabled, true);
  assert.equal(updated?.verifyGate?.command, 'npm run typecheck');
  assert.equal(S.getProject(p.id)?.verifyGate?.enabled, true);
  assert.equal(S.getProject(p.id)?.verifyGate?.command, 'npm run typecheck');
});

await test('every orchestrator MCP tool schema fits under Antigravity 900-byte enablement cap', () => {
  const dir = join(TMP, 'proj-mcp');
  mkdirSync(dir, { recursive: true });
  const p = S.addProject(dir);
  const t = S.createThread(p.id, 'antigravity', { title: 'Main orchestrator' });
  const tools = ORCH.toolsFor(t);
  assert.ok(tools.some((x) => x.name === 'spawn_subsession'), 'spawn_subsession included');
  assert.ok(tools.some((x) => x.name === 'save_schedule'), 'save_schedule included');
  for (const tool of tools) {
    const serialized = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.inputSchema });
    assert.ok(
      Buffer.byteLength(serialized, 'utf8') <= 910,
      `MCP tool "${tool.name}" is ${Buffer.byteLength(serialized, 'utf8')} bytes (> 910B risks silent disable in Antigravity)`,
    );
  }
});

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
