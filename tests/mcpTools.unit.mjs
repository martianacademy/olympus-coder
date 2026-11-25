// Unit tests for all 24 Olympus MCP tools: complete 4-hint boolean annotations, Antigravity byte budget, and role gating.
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = mkdtempSync(join(tmpdir(), 'olympus-mcptools-unit-'));
const UD = join(TMP, 'userData');
const HOME = join(TMP, 'home');
const SHARED = join(TMP, 'shared');
for (const d of [UD, HOME, SHARED]) mkdirSync(d, { recursive: true });
process.env.HOME = HOME;
process.env.AGENTDESK_SHARED_ROOT = SHARED;
writeFileSync(
  join(UD, 'settings.json'),
  JSON.stringify({ sharedRoot: SHARED, designVersion: 2, learnAboutUser: true, orchestrator: { enabled: true, maxParallel: 3, maxPerSession: 8 } }),
);

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
        source: `export const app = { getPath: () => ${JSON.stringify(UD)}, getVersion: () => '0.3.2', isPackaged: false, on: () => {} }; export const safeStorage = { isEncryptionAvailable: () => false }; export const shell = {}; export const BrowserWindow = { getAllWindows: () => [] }; export const dialog = {}; export const ipcMain = { handle: () => {}, on: () => {} }; export const nativeTheme = { shouldUseDarkColors: true, on: () => {} };`,
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

const S = await import(`${APP}/src/main/store.ts`);
const ORCH = await import(`${APP}/src/main/orchestrator.ts`);

const EXPECTED_ANNOTATIONS = {
  session_info: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  set_timer: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  list_agents: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  run_in_terminal: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  read_terminal: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_saved_commands: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run_saved_command: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  remember_about_user: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  list_schedules: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  save_schedule: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  delete_schedule: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  run_schedule: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  search_agent_registry: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  add_agent: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  add_custom_agent: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  remove_agent: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  create_project: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  spawn_subsession: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  configure_subsession: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  wait_for_subsessions: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_subsession: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  message_subsession: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  cancel_subsession: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  delete_subsession: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  browser_tabs: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_open: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  browser_read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  browser_act: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  browser_close: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL  ${name}\n    ${e.stack || e}`);
    fail++;
  }
}

const projDir = join(TMP, 'proj');
mkdirSync(projDir, { recursive: true });
const proj = S.addProject(projDir);
const mainThread = S.createThread(proj.id, 'antigravity', { title: 'Main orchestrator' });
const allTools = ORCH.toolsFor(mainThread);

// Antigravity (agy) silently disables every MCP tool whose declaration is too big; a call then fails with
// "tool X is not enabled for server olympus_<code>". Measured 2026-11-26 on agy 1.5.11 across olympus, chrome-devtools
// and product-hunt (declarations cached in ~/.gemini/antigravity-cli/mcp/<server>/<tool>.json): every tool <= 642 bytes
// was enabled, every tool >= 679 bytes was disabled. Measure the way agy stores it (Go encoding/json: name, description,
// parameters; & < > escaped as \u00XX) and keep a margin below 642.
const AGY_TOOL_BYTES_CAP = 620;
const agyDeclarationBytes = (tool) =>
  Buffer.byteLength(
    JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.inputSchema }).replace(
      /[&<>]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    ),
    'utf8',
  );

await test(`all 29 MCP tools declare complete boolean 4-hint annotations, strict schemas, and fit <= ${AGY_TOOL_BYTES_CAP} bytes (Antigravity)`, () => {
  const names = allTools.map((t) => t.name).sort();
  assert.deepEqual(names, Object.keys(EXPECTED_ANNOTATIONS).sort(), 'exact 29 MCP tools registered');
  for (const tool of allTools) {
    assert.deepEqual(tool.annotations, EXPECTED_ANNOTATIONS[tool.name], `annotations for ${tool.name}`);
    for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(typeof tool.annotations[k], 'boolean', `${tool.name}.${k} must be boolean`);
    }
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} closes extra args`);
    const bytes = agyDeclarationBytes(tool);
    assert.ok(bytes <= AGY_TOOL_BYTES_CAP, `MCP tool "${tool.name}" is ${bytes} bytes (> ${AGY_TOOL_BYTES_CAP}B; Antigravity disables it)`);
  }
});

await test('second-opinion read-only threads hide mutating terminal, schedule, agent, project, and orchestration tools', () => {
  const roThread = S.createThread(proj.id, 'claude', { title: 'Second opinion', secondOpinion: true });
  const names = new Set(ORCH.toolsFor(roThread).map((t) => t.name));
  for (const keep of ['session_info', 'set_timer', 'read_terminal', 'list_saved_commands', 'browser_tabs', 'browser_read']) {
    assert.ok(names.has(keep), `expected ${keep} on second-opinion thread`);
  }
  for (const hide of [
    'run_in_terminal',
    'run_saved_command',
    'browser_open',
    'browser_act',
    'browser_close',
    'remember_about_user',
    'list_schedules',
    'save_schedule',
    'delete_schedule',
    'run_schedule',
    'search_agent_registry',
    'add_agent',
    'add_custom_agent',
    'remove_agent',
    'create_project',
    'list_agents',
    'spawn_subsession',
    'configure_subsession',
    'wait_for_subsessions',
    'get_subsession',
    'message_subsession',
    'cancel_subsession',
    'delete_subsession',
  ]) {
    assert.equal(names.has(hide), false, `expected ${hide} hidden on second-opinion thread`);
  }
});

await test('sub-session workers expose terminal + timer tools without orchestration or config-admin tools', () => {
  const workerThread = S.createThread(proj.id, 'claude', { title: 'Worker', spawnedBy: mainThread.id });
  const names = new Set(ORCH.toolsFor(workerThread).map((t) => t.name));
  for (const keep of ['session_info', 'set_timer', 'run_in_terminal', 'read_terminal', 'list_saved_commands', 'run_saved_command']) {
    assert.ok(names.has(keep), `expected ${keep} on worker thread`);
  }
  for (const hide of ['spawn_subsession', 'delete_subsession', 'create_project', 'add_agent', 'save_schedule', 'remember_about_user']) {
    assert.equal(names.has(hide), false, `expected ${hide} hidden on worker thread`);
  }
});

rmSync(TMP, { recursive: true, force: true });
console.log(`\nMCP tools suite: ${pass}/${pass + fail} passed.`);
process.exit(fail ? 1 : 0);
