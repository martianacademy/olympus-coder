// Unit tests: the ~/.agents → ~/.olympus move (src/main/sharedMigration.ts and its call in store.ts getSettings),
// project relocation (src/main/relocate.ts + scripts/relocate-project.mjs), set_timer (src/main/agenttimers.ts),
// and "message agents when their work finishes" off by default (src/main/jobwatch.ts).
// Everything runs on scratch folders under the OS temp dir: HOME is pointed there before any import, so the real
// ~/.agents, ~/.olympus and ~/.claude are never read or written.
// Run: node tests/olympusHome.unit.mjs   (Node ≥ 23 strips the TypeScript types itself; `electron` is stubbed)
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const TMP = realpathSync(mkdtempSync(join(tmpdir(), 'olympus-home-unit-')));
const HOME = join(TMP, 'home');
const UD = join(TMP, 'userData');
mkdirSync(HOME, { recursive: true });
mkdirSync(UD, { recursive: true });
process.env.HOME = HOME;
delete process.env.OLYMPUS_HOME;
delete process.env.AGENTDESK_SHARED_ROOT;

// Stubs read their state from globalThis.__T (labelled mocks: electron, the agent runtime, the app's message queue).
const stub = (src) => `data:text/javascript,${encodeURIComponent(src)}`;
globalThis.__T = { notified: [], tasks: [], scans: 0, settings: { notifyAgentsWhenWorkEnds: false }, running: false, items: [] };
const STUBS = {
  './appmsg': stub(`export const notifyAgent = (id, text) => globalThis.__T.notified.push([id, text]); export const isMuted = () => false;`),
  './agents': stub(`export const runState = () => ({ running: globalThis.__T.running });`),
  './processes': stub(`export const runningTasks = async () => { globalThis.__T.scans++; return globalThis.__T.tasks; };`),
  './terminals': stub(`export const readTerminal = () => '--- last 25 lines ---\\nall done';`),
};
let stubStore = false;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'electron') return { url: 'mock:electron', shortCircuit: true };
    if (STUBS[spec]) return { url: STUBS[spec], shortCircuit: true };
    if (spec === './store' && stubStore)
      return { url: stub(`export const findThread = () => ({ items: globalThis.__T.items }); export const getSettings = () => globalThis.__T.settings;`), shortCircuit: true };
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
  load(url, ctx, next) {
    if (url === 'mock:electron')
      return { format: 'module', shortCircuit: true, source: `export const app = { getPath: () => ${JSON.stringify(UD)} }; export const safeStorage = { isEncryptionAvailable: () => false }; export const shell = {};` };
    return next(url, ctx);
  },
});

const M = await import(`${APP}/src/main/sharedMigration.ts`);
const R = await import(`${APP}/src/main/relocate.ts`);

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL  ${name}\n      ${String(e?.stack ?? e).split('\n').slice(0, 8).join('\n      ')}`);
  }
}

const put = (file, text) => (mkdirSync(dirname(file), { recursive: true }), writeFileSync(file, text));
/** Every path under a folder with its type and content hash (symlinks by target), to prove it did not change. */
function snapshot(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out.push(`${r} -> ${readlinkSync(p)}`);
      else if (st.isDirectory()) (out.push(`${r}/`), walk(p, r));
      else out.push(`${r} ${createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)} ${st.mode & 0o777}`);
    }
  };
  walk(dir, '');
  return out.join('\n');
}

/** A fake ~/.agents shaped like the real one (Olympus items + npx-skills + Olympus CLI items). */
function seedLegacy(home) {
  const L = join(home, '.agents');
  const media = join(L, 'attachments', 'chats', 'chat-1', 'shot.png');
  put(media, 'PNGDATA');
  put(join(L, 'attachments', '2026-11-16', 'paste.png'), 'PASTE');
  put(join(L, 'projects.json'), JSON.stringify([{ id: 'p1', name: 'demo', path: join(home, 'demo'), createdAt: 1 }]));
  put(
    join(L, 'threads', 'p1', 'chat-1.json'),
    JSON.stringify({
      id: 'chat-1',
      projectId: 'p1',
      items: [
        { kind: 'user', text: `see ${join(L, 'memory', 'x', 'MEMORY.md')}`, attachments: [{ path: join(L, 'attachments', '2026-11-16', 'paste.png') }] },
        { kind: 'tool', content: [{ type: 'image', path: media }] },
      ],
    }),
  );
  put(join(L, 'threads', 'p1', 'plain.json'), JSON.stringify({ id: 'plain', items: [{ kind: 'agent', text: 'no media' }] }));
  put(join(L, 'memory', '-x-demo', 'MEMORY.md'), '# index\n');
  put(join(L, 'usage', '2026-11.jsonl'), '{"t":1}\n');
  put(join(L, 'user', 'learned.json'), '[]');
  put(join(L, 'agents', 'goose', '1.0', 'goose'), '#!/bin/sh\necho goose\n');
  chmodSync(join(L, 'agents', 'goose', '1.0', 'goose'), 0o755);
  symlinkSync('1.0', join(L, 'agents', 'goose', 'current'));
  mkdirSync(join(L, 'workspace'), { recursive: true });
  put(join(L, 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: mine\n---\nbody\n');
  put(join(L, 'skills', 'clerk', 'SKILL.md'), '---\nname: clerk\ndescription: third party\n---\n');
  put(join(L, 'skills', '.DS_Store'), 'x');
  put(join(L, '.skill-lock.json'), JSON.stringify({ version: 3, skills: { clerk: {} } }));
  put(join(L, 'registry-cache.json'), '{"from":"agents"}');
  put(join(L, 'bin', 'oly'), 'cli');
  put(join(L, 'olympus-cli', 'settings.json'), '{}');
  return L;
}

const agentsList = (L) => [
  { id: 'opencode', command: join(L, 'agents', 'opencode', '2.3.0', 'opencode'), args: ['acp'] },
  { id: 'wrapped', command: '/usr/bin/env', args: ['node', join(L, 'agents', 'x', 'run.js'), '/elsewhere/.agents/keep'] },
  { id: 'oly', command: 'oly', args: [] },
];

await test('migration: copies only Olympus items, rewrites media + agent paths, never overwrites, ~/.agents unchanged', () => {
  const home = join(TMP, 'h1');
  const L = seedLegacy(home);
  const O = join(home, '.olympus');
  put(join(O, 'registry-cache.json'), '{"from":"olympus"}'); // already there: must win
  put(join(O, 'bin', 'oly'), 'their cli');
  const before = snapshot(L);
  let saved;
  const r = M.migrateLegacySharedRoot({ home, env: {}, saved: { sharedRoot: L, customAgents: agentsList(L) }, save: (p) => (saved = p), log: () => {} });
  assert.equal(r.error, undefined);
  assert.equal(r.ran, true);
  assert.equal(snapshot(L), before, '~/.agents must not change');
  assert.equal(saved.sharedRoot, O);
  // Items
  for (const item of ['projects.json', 'threads', 'memory', 'attachments', 'usage', 'user', 'agents', 'workspace', 'skills']) assert.ok(existsSync(join(O, item)), item);
  assert.equal(readFileSync(join(O, 'attachments', 'chats', 'chat-1', 'shot.png'), 'utf8'), 'PNGDATA');
  assert.equal(readFileSync(join(O, 'registry-cache.json'), 'utf8'), '{"from":"olympus"}', 'existing file kept');
  assert.equal(readFileSync(join(O, 'bin', 'oly'), 'utf8'), 'their cli');
  assert.ok(!existsSync(join(O, 'olympus-cli')), 'CLI folder not copied');
  assert.ok(!existsSync(join(O, '.skill-lock.json')), '.skill-lock.json not copied');
  assert.deepEqual(readdirSync(join(O, 'skills')), ['my-skill']);
  assert.deepEqual(r.thirdPartySkills, ['clerk']);
  assert.equal(readlinkSync(join(O, 'agents', 'goose', 'current')), '1.0', 'symlinks stay symlinks');
  assert.equal(lstatSync(join(O, 'agents', 'goose', '1.0', 'goose')).mode & 0o777, 0o755, 'exec bit kept');
  assert.ok(!existsSync(join(O, '.migrating-from-agents')), 'staging removed');
  // Thread media paths rewritten; other text (a memory path in a message) untouched.
  const t = JSON.parse(readFileSync(join(O, 'threads', 'p1', 'chat-1.json'), 'utf8'));
  assert.equal(t.items[1].content[0].path, join(O, 'attachments', 'chats', 'chat-1', 'shot.png'));
  assert.equal(t.items[0].attachments[0].path, join(O, 'attachments', '2026-11-16', 'paste.png'));
  assert.equal(t.items[0].text, `see ${join(L, 'memory', 'x', 'MEMORY.md')}`);
  assert.equal(r.threadFilesRewritten, 1);
  // Custom agents
  assert.equal(r.customAgentsRewritten, 2);
  assert.equal(saved.customAgents[0].command, join(O, 'agents', 'opencode', '2.3.0', 'opencode'));
  assert.deepEqual(saved.customAgents[1].args, ['node', join(O, 'agents', 'x', 'run.js'), '/elsewhere/.agents/keep']);
  assert.deepEqual(saved.customAgents[2], agentsList(L)[2]);
  // Marker
  const marker = JSON.parse(readFileSync(join(O, '.migrated-from-agents.json'), 'utf8'));
  assert.equal(marker.from, L);
  assert.equal(marker.threadFilesRewritten, 1);
  assert.equal(saved.migratedFromAgents, true, 'the settings remember the switch');
  // A second run on settings that took the switch (the user chose ~/.agents again on purpose) does nothing.
  let again = false;
  const r2 = M.migrateLegacySharedRoot({ home, env: {}, saved: { sharedRoot: L, migratedFromAgents: true }, save: () => (again = true), log: () => {} });
  assert.equal(r2.skipped, 'done-before');
  assert.equal(again, false);
});

await test('migration: an earlier copy whose switch never reached the settings is set aside and copied again', () => {
  const home = join(TMP, 'h-stale');
  const L = seedLegacy(home);
  const O = join(home, '.olympus');
  put(join(O, 'agents', 'olympus-cli', 'keep.txt'), 'cli'); // ~/.olympus had this before the first run
  const r1 = M.migrateLegacySharedRoot({ home, env: {}, saved: { sharedRoot: L, customAgents: agentsList(L) }, save: () => {}, log: () => {} });
  assert.equal(r1.ran, true);
  assert.deepEqual(r1.merged, ['agents']);
  // ~/.agents moves on (newer project data) while the settings still say ~/.agents (the switch was lost).
  put(join(L, 'projects.json'), '[{"id":"p1","path":"/new/place"}]');
  const before = snapshot(L);
  let saved;
  const r2 = M.migrateLegacySharedRoot({ home, env: {}, saved: { sharedRoot: L, customAgents: agentsList(L) }, save: (p) => (saved = p), log: () => {} });
  assert.equal(r2.error, undefined);
  assert.equal(r2.ran, true, 'copied again');
  assert.ok(r2.staleSetAside && existsSync(join(r2.staleSetAside, 'projects.json')) && existsSync(join(r2.staleSetAside, '.migrated-from-agents.json')), 'old copy kept aside');
  assert.ok(!existsSync(join(r2.staleSetAside, 'agents')), 'what ~/.olympus had before is not moved');
  assert.equal(readFileSync(join(O, 'projects.json'), 'utf8'), '[{"id":"p1","path":"/new/place"}]', 'fresh data');
  assert.equal(readFileSync(join(O, 'agents', 'olympus-cli', 'keep.txt'), 'utf8'), 'cli');
  assert.equal(saved.sharedRoot, O);
  assert.equal(saved.migratedFromAgents, true);
  assert.equal(snapshot(L), before, '~/.agents must not change');
});

await test('migration: override env vars and non-default roots are left alone', () => {
  const home = join(TMP, 'h2');
  const L = seedLegacy(home);
  for (const env of [{ OLYMPUS_HOME: join(TMP, 'x') }, { AGENTDESK_SHARED_ROOT: join(TMP, 'y') }]) {
    const r = M.migrateLegacySharedRoot({ home, env, saved: { sharedRoot: L }, save: () => assert.fail('saved'), log: () => {} });
    assert.equal(r.skipped, 'override');
  }
  for (const sharedRoot of [undefined, join(TMP, 'custom'), join(home, '.olympus')]) {
    const r = M.migrateLegacySharedRoot({ home, env: {}, saved: { sharedRoot }, save: () => assert.fail('saved'), log: () => {} });
    assert.equal(r.skipped, 'not-legacy');
  }
  assert.ok(!existsSync(join(home, '.olympus')));
  assert.equal(M.defaultSharedRoot(home, {}), join(home, '.olympus'));
  assert.equal(M.defaultSharedRoot(home, { OLYMPUS_HOME: '/a', AGENTDESK_SHARED_ROOT: '/b' }), '/a');
  assert.equal(M.defaultSharedRoot(home, { AGENTDESK_SHARED_ROOT: '/b' }), '/b');
});

await test('migration: a failed copy keeps the old root, leaves nothing half-copied, and the retry works', () => {
  const home = join(TMP, 'h3');
  const L = seedLegacy(home);
  const before = snapshot(L);
  let saved;
  const r = M.migrateLegacySharedRoot({ home, env: {}, saved: { sharedRoot: L }, save: (p) => (saved = p), log: () => {}, failOn: 'agents' });
  assert.equal(r.ran, false);
  assert.match(r.error, /agents/);
  assert.equal(saved, undefined, 'root not switched');
  assert.deepEqual(readdirSync(join(home, '.olympus')), [], 'no partial copies, no marker');
  assert.equal(snapshot(L), before);
  const r2 = M.migrateLegacySharedRoot({ home, env: {}, saved: { sharedRoot: L }, save: (p) => (saved = p), log: () => {} });
  assert.equal(r2.ran, true);
  assert.equal(saved.sharedRoot, join(home, '.olympus'));
});

await test('store.getSettings(): migrates once at startup and saves the new root + agent paths', async () => {
  const L = seedLegacy(HOME);
  writeFileSync(join(UD, 'settings.json'), JSON.stringify({ sharedRoot: L, designVersion: 2, customAgents: agentsList(L) }));
  const S = await import(`${APP}/src/main/store.ts`);
  const s = S.getSettings();
  assert.equal(s.sharedRoot, join(HOME, '.olympus'));
  assert.equal(s.notifyAgentsWhenWorkEnds, false, 'notify setting defaults off');
  const disk = JSON.parse(readFileSync(join(UD, 'settings.json'), 'utf8'));
  assert.equal(disk.sharedRoot, join(HOME, '.olympus'));
  assert.equal(disk.customAgents[0].command, join(HOME, '.olympus', 'agents', 'opencode', '2.3.0', 'opencode'));
  assert.equal(S.listProjectsWithMissing()[0].missing, true, 'project with a missing folder is listed as missing');
  assert.equal(S.listProjects().length, 0);
  assert.equal(S.DEFAULT_SETTINGS.notifyAgentsWhenWorkEnds, false);
});

await test('relocate: projects.json, memory moved with a symlink, Claude slug symlinked; script and dry run', () => {
  const root = join(TMP, 'reloc');
  const shared = join(root, 'shared');
  const home = join(root, 'home');
  const oldP = join(root, 'Documents', 'code-for.antigravity');
  const newP = join(root, 'Documents', 'olympus', 'olympus-coder');
  mkdirSync(oldP, { recursive: true });
  put(join(shared, 'projects.json'), JSON.stringify([{ id: 'p1', name: 'code-for.antigravity', path: oldP, createdAt: 1 }, { id: 'p2', name: 'Other', path: join(root, 'other'), createdAt: 2 }]));
  const oldSlug = R.pathSlug(oldP);
  assert.ok(!oldSlug.includes('.') && !oldSlug.includes('/'), 'Claude slug rule: / and . become -');
  put(join(shared, 'memory', oldSlug, 'MEMORY.md'), 'index');
  put(join(home, '.claude', 'projects', oldSlug, 's1.jsonl'), '{}');
  mkdirSync(dirname(newP), { recursive: true });
  renameSync(oldP, newP);
  assert.throws(() => R.relocateOnDisk({ sharedRoot: shared, home, oldPath: oldP, newPath: join(root, 'nope') }), /Folder not found/);
  // Dry run changes nothing.
  const dry = R.relocateOnDisk({ sharedRoot: shared, home, oldPath: oldP, newPath: newP, dryRun: true });
  assert.equal(dry.steps.length, 3);
  assert.equal(JSON.parse(readFileSync(join(shared, 'projects.json'), 'utf8'))[0].path, oldP);
  // The real run, through the script (HOME pointed at the scratch home).
  const out = execFileSync(process.execPath, [join(APP, 'scripts', 'relocate-project.mjs'), oldP, newP, '--shared-root', shared], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.match(out, /memory: moved/);
  const projects = JSON.parse(readFileSync(join(shared, 'projects.json'), 'utf8'));
  assert.deepEqual(projects[0], { id: 'p1', name: 'olympus-coder', path: newP, createdAt: 1 });
  assert.equal(projects[1].path, join(root, 'other'));
  const newSlug = R.pathSlug(newP);
  assert.equal(readFileSync(join(shared, 'memory', newSlug, 'MEMORY.md'), 'utf8'), 'index');
  assert.equal(readlinkSync(join(shared, 'memory', oldSlug)), newSlug);
  assert.equal(readFileSync(join(shared, 'memory', oldSlug, 'MEMORY.md'), 'utf8'), 'index', 'old slug still resolves');
  assert.equal(readlinkSync(join(home, '.claude', 'projects', newSlug)), oldSlug);
  assert.equal(readFileSync(join(home, '.claude', 'projects', newSlug, 's1.jsonl'), 'utf8'), '{}');
  // A second folder already used by another project is refused.
  assert.throws(() => R.relocateOnDisk({ sharedRoot: shared, home, oldPath: newP, newPath: newP }), /same/);
  mkdirSync(join(root, 'other'), { recursive: true });
  assert.throws(() => R.relocateOnDisk({ sharedRoot: shared, home, oldPath: newP, newPath: join(root, 'other') }), /already uses/);
});

await test('relocate: new slugs that already exist are merged without overwriting', () => {
  const root = join(TMP, 'reloc2');
  const shared = join(root, 'shared');
  const home = join(root, 'home');
  const oldP = join(root, 'a');
  const newP = join(root, 'b');
  mkdirSync(newP, { recursive: true });
  put(join(shared, 'memory', R.pathSlug(oldP), 'MEMORY.md'), 'old');
  put(join(shared, 'memory', R.pathSlug(oldP), 'BUGS.md'), 'bugs');
  put(join(shared, 'memory', R.pathSlug(newP), 'MEMORY.md'), 'new');
  put(join(home, '.claude', 'projects', R.pathSlug(oldP), 'old.jsonl'), 'o');
  put(join(home, '.claude', 'projects', R.pathSlug(newP), 'new.jsonl'), 'n');
  const r = R.relocateOnDisk({ sharedRoot: shared, home, oldPath: oldP, newPath: newP });
  assert.equal(r.project, undefined);
  assert.equal(readFileSync(join(shared, 'memory', R.pathSlug(newP), 'MEMORY.md'), 'utf8'), 'new');
  assert.equal(readFileSync(join(shared, 'memory', R.pathSlug(newP), 'BUGS.md'), 'utf8'), 'bugs');
  assert.equal(readFileSync(join(shared, 'memory', R.pathSlug(oldP), 'MEMORY.md'), 'utf8'), 'old');
  assert.equal(readFileSync(join(home, '.claude', 'projects', R.pathSlug(newP), 'old.jsonl'), 'utf8'), 'o');
});

await test('set_timer: argument checks, small declaration, fires "[Olympus Coder] Timer: <note>"', async () => {
  const T = await import(`${APP}/src/main/agenttimers.ts`);
  for (const bad of [{}, { minutes: 0, note: 'x' }, { minutes: 1441, note: 'x' }, { minutes: 'soon', note: 'x' }, { minutes: 5 }, { minutes: 5, note: '   ' }])
    assert.throws(() => T.parseTimerArgs(bad), /minutes|note/);
  assert.deepEqual(T.parseTimerArgs({ minutes: 5, note: ' check\n the build ' }), { minutes: 5, note: 'check the build' });
  assert.ok(JSON.stringify(T.setTimerToolDef).length < 840, 'agy drops large tool declarations');
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    globalThis.__T.notified = [];
    const msg = T.setTimer('chat-9', 2, 'read the build log');
    assert.match(msg, /Timer set/);
    mock.timers.tick(119_000);
    assert.equal(globalThis.__T.notified.length, 0);
    mock.timers.tick(1_000);
    assert.deepEqual(globalThis.__T.notified, [['chat-9', '[Olympus Coder] Timer: read the build log']]);
    // A stopped chat's timers are dropped.
    T.setTimer('chat-9', 1, 'never');
    T.dropWakes('chat-9');
    mock.timers.tick(61_000);
    assert.equal(globalThis.__T.notified.length, 1);

    // Persistence across app restarts: timers save to disk, survive quit, prune deleted chats, and fire after restore.
    const timerFile = join(TMP, 'agent-timers.json');
    assert.equal(T.restoreAgentTimers(timerFile, (id) => id !== 'deleted-chat'), 0);
    T.setTimer('chat-live', 3, 'check colab run');
    T.setTimer('deleted-chat', 5, 'gone chat');
    T.keepWake('chat-live', 'tc-wake-1', 10_000, 'inspect logs');
    assert.equal(existsSync(timerFile), true);
    assert.equal(JSON.parse(readFileSync(timerFile, 'utf8')).length, 3);

    T.pauseAgentTimersForQuit();
    assert.equal(existsSync(timerFile), true, 'quit keeps pending timers on disk');
    mock.timers.tick(60_000);
    assert.equal(globalThis.__T.notified.length, 1, 'paused timers do not fire after quit');

    const restored = T.restoreAgentTimers(timerFile, (id) => id !== 'deleted-chat');
    assert.equal(restored, 2, 'deleted chat timer pruned on restore');
    assert.equal(JSON.parse(readFileSync(timerFile, 'utf8')).length, 2);

    // Overdue wake (13s delay < 60s elapsed while closed) fires after the 2s restart settle window.
    mock.timers.tick(2_000);
    assert.equal(globalThis.__T.notified.length, 2);
    assert.match(globalThis.__T.notified[1][1], /Your scheduled wake-up is due: "inspect logs"/);
    // Re-replaying the same wake toolCallId after restore is deduped via `seen`.
    T.keepWake('chat-live', 'tc-wake-1', 10_000, 'inspect logs');

    // Remaining future timer (3 min = 180s; 62s elapsed so 118s left) fires right on schedule and removes the file.
    mock.timers.tick(118_000);
    assert.equal(globalThis.__T.notified.length, 3);
    assert.deepEqual(globalThis.__T.notified[2], ['chat-live', '[Olympus Coder] Timer: check colab run']);
    assert.equal(existsSync(timerFile), false, 'file removed once all timers have fired');
  } finally {
    mock.timers.reset();
  }
});

await test('jobwatch: a finished terminal command sends nothing by default (0 ps scans), and a message when the setting is on', async () => {
  stubStore = true;
  const J = await import(`${APP}/src/main/jobwatch.ts?stubbed`);
  const run = async (on) => {
    globalThis.__T.settings = { notifyAgentsWhenWorkEnds: on };
    globalThis.__T.notified = [];
    globalThis.__T.scans = 0;
    globalThis.__T.tasks = [{ id: `t-${on}`, threadId: 'chat-1', source: 'terminal', ptyId: 'pty-1', title: 'build', secs: 30 }];
    await J.tick();
    globalThis.__T.tasks = [];
    await J.tick();
    await J.tick();
    return { notified: globalThis.__T.notified, scans: globalThis.__T.scans };
  };
  assert.deepEqual(await run(false), { notified: [], scans: 0 });
  const sent = await run(true);
  assert.equal(sent.scans, 3);
  assert.equal(sent.notified.length, 1);
  assert.match(sent.notified[0][1], /^\[Olympus Coder\] The command in terminal "build"/);
});

rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
