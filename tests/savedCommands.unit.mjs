// Unit tests: the pure logic of saved commands (src/shared/savedCommands.ts) — dedupe, status after a restart,
// the crash-loop guard (trips at 3 failed starts within 10 minutes, not before), user stops, and that nothing but
// the known fields (no env vars, no secrets) is ever stored.
// Run: node tests/savedCommands.unit.mjs   (Node ≥ 23 strips the TypeScript types itself)
import { registerHooks } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import assert from 'node:assert/strict';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@shared/')) spec = pathToFileURL(`${APP}/src/shared/${spec.slice(8)}.ts`).href;
    try {
      return next(spec, ctx);
    } catch (e) {
      if (spec.startsWith('.') || spec.startsWith('file:')) return next(`${spec}.ts`, ctx);
      throw e;
    }
  },
});
const S = await import(`${APP}/src/shared/savedCommands.ts`);

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n     ${e?.stack ?? e}`);
  }
}

const T0 = 1_800_000_000_000;
const rec = (over = {}) => S.cleanRecord({ id: 'a', projectId: 'p', title: 'watch', command: 'python3 watch.py', createdAt: T0, createdBy: 'agent', autoStart: false, keepRunning: false, lastStatus: 'never-run', failures: [], ...over });

/** Starts and ends one run: `ranMs` after the start it exits with `code`. */
function cycle(c, n, ranMs, code, userStopped = false) {
  const startAt = T0 + n * 1000;
  const started = S.recordStart(c, `pty${n}`, startAt, false);
  return S.recordExit(started, `pty${n}`, code, startAt + ranMs, userStopped);
}

test('dedupe: same project + same command (whitespace-insensitive) is found; other project or command is not', () => {
  const list = [rec({ id: 'a', command: 'npm run  dev' }), rec({ id: 'b', projectId: 'q', command: 'npm test' })];
  assert.equal(S.findDuplicate(list, 'p', '  npm run dev ')?.id, 'a');
  assert.equal(S.findDuplicate(list, 'q', 'npm run dev'), undefined);
  assert.equal(S.findDuplicate(list, 'p', 'npm run build'), undefined);
});

test('after a restart: running → stopped-by-restart, terminal id dropped; other statuses unchanged', () => {
  const out = S.afterRestart([rec({ id: 'r', lastStatus: 'running', ptyId: 'old' }), rec({ id: 's', lastStatus: 'stopped', lastExitCode: 1 }), rec({ id: 'g', lastStatus: 'guard-tripped' }), rec({ id: 'n' })]);
  assert.equal(out[0].lastStatus, 'stopped-by-restart');
  assert.equal(out[0].ptyId, undefined);
  assert.deepEqual(out.slice(1).map((c) => c.lastStatus), ['stopped', 'guard-tripped', 'never-run']);
  assert.equal(out[1].lastExitCode, 1);
});

test('no env or unknown fields are stored; types are cleaned; bad records are dropped', () => {
  const c = S.cleanRecord({ id: 'x', projectId: 'p', command: ' run.sh ', env: { API_KEY: 'sk-secret' }, token: 'abc', autoStart: 'yes', lastStatus: 'weird', failures: [1, 'x', 2] });
  assert.equal(JSON.stringify(c).includes('sk-secret'), false);
  assert.equal('env' in c || 'token' in c, false);
  assert.equal(c.command, 'run.sh');
  assert.equal(c.autoStart, false);
  assert.equal(c.lastStatus, 'never-run');
  assert.deepEqual(c.failures, [1, 2]);
  assert.equal(S.cleanRecord({ id: 'x', projectId: 'p', command: '  ' }), null);
  assert.equal(S.cleanRecord(null), null);
});

test('guard: keep-running command that exits at once is restarted twice, then guard-tripped on the 3rd failure', () => {
  let c = rec({ keepRunning: true });
  const o1 = cycle(c, 1, 200, 0);
  assert.equal(o1.failed, true);
  assert.equal(o1.restart, true);
  assert.equal(o1.next.lastStatus, 'stopped');
  const o2 = cycle(o1.next, 2, 200, 1);
  assert.equal(o2.restart, true);
  assert.equal(o2.next.failures.length, 2);
  const o3 = cycle(o2.next, 3, 200, 1);
  assert.equal(o3.next.lastStatus, 'guard-tripped');
  assert.equal(o3.restart, false);
  assert.equal(S.mayAutoRun(o3.next, T0 + 5000), false);
});

test('guard: failures spread over more than 10 minutes never trip it', () => {
  let c = rec({ keepRunning: true });
  for (let i = 0; i < 6; i++) {
    const startAt = T0 + i * 6 * 60_000; // one quick failure every 6 minutes: at most 2 inside any 10-minute window
    const started = S.recordStart(c, `p${i}`, startAt, false);
    const o = S.recordExit(started, `p${i}`, 1, startAt + 500, false);
    assert.notEqual(o.next.lastStatus, 'guard-tripped', `run ${i}`);
    assert.equal(o.restart, true);
    c = o.next;
  }
  assert.ok(c.failures.length <= 2);
});

test('a long run that exits 0 is not a failure; a long run that exits non-zero is', () => {
  const ok = cycle(rec({ keepRunning: true }), 1, 5 * 60_000, 0);
  assert.equal(ok.failed, false);
  assert.equal(ok.restart, true);
  const bad = cycle(rec({ keepRunning: true }), 1, 5 * 60_000, 2);
  assert.equal(bad.failed, true);
  assert.equal(bad.next.lastExitCode, 2);
});

test('user stops (closed tab, Stop, Ctrl+C exit codes on POSIX and Windows) never fail or restart', () => {
  for (const [code, user] of [[129, true], [0, true], [130, false], [3221225786, false], [-1073741510, false]]) {
    const o = cycle(rec({ keepRunning: true }), 1, 100, code, user);
    assert.equal(o.failed, false, `code ${code}`);
    assert.equal(o.restart, false, `code ${code}`);
    assert.equal(o.next.lastStatus, 'stopped');
  }
});

test('manual-only commands are never guard-tripped nor restarted; a manual start clears the guard', () => {
  let c = rec();
  for (let i = 1; i <= 4; i++) {
    const o = cycle(c, i, 100, 1);
    assert.equal(o.restart, false);
    assert.equal(o.next.lastStatus, 'stopped');
    c = o.next;
  }
  const tripped = rec({ keepRunning: true, lastStatus: 'guard-tripped', failures: [T0, T0 + 1, T0 + 2] });
  const again = S.recordStart(tripped, 'new', T0 + 10, true);
  assert.equal(again.lastStatus, 'running');
  assert.deepEqual(again.failures, []);
  assert.equal(S.recordStart(tripped, 'new', T0 + 10, false).failures.length, 3);
});

test('an exit from an older terminal does not touch the current run', () => {
  const c = S.recordStart(rec({ keepRunning: true }), 'current', T0, false);
  const o = S.recordExit(c, 'old', 1, T0 + 10, false);
  assert.equal(o.next, c);
  assert.equal(o.restart, false);
});

test('exec args: POSIX shells get -l -i -c, PowerShell -Command, cmd /c — command passed as one argument', () => {
  assert.deepEqual(S.execArgs('/bin/zsh', 'a | b'), ['-l', '-i', '-c', 'a | b']);
  assert.deepEqual(S.execArgs('/usr/bin/fish', 'x'), ['-l', '-i', '-c', 'x']);
  assert.deepEqual(S.execArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'x'), ['-NoLogo', '-Command', 'x']);
  assert.deepEqual(S.execArgs('C:\\Windows\\System32\\cmd.exe', 'x'), ['/d', '/s', '/c', 'x']);
});

test('status text', () => {
  assert.equal(S.statusText(rec({ lastStatus: 'stopped', lastExitCode: 3 })), 'stopped (exit code 3)');
  assert.equal(S.statusText(rec({ lastStatus: 'stopped-by-restart' })), 'stopped when Olympus closed');
  assert.match(S.statusText(rec({ lastStatus: 'guard-tripped' })), /failed 3 times within 10 minutes/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
