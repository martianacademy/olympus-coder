import { app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { TurnFileChange } from '@shared/types';

/**
 * Checkpoints: a snapshot of the project's files before and after every agent turn, so a turn's changes can be
 * shown as a diff and undone (and redone).
 *
 * Snapshots live in a separate "shadow" git repository per project under the app's data folder
 * (`<userData>/checkpoints/<projectId>.git`), with the project folder as its work tree. The project's own git
 * repository, branches and index are never touched; its .gitignore files are honoured.
 *
 * Size limits keep this cheap: files over 20 MB (videos, model weights, datasets) are left out of snapshots, and a
 * project with more than 2 GB or 150,000 files is not snapshotted at all (that is remembered for a week). A
 * snapshot that fails part-way has its half-written files removed at once, and an empty store is deleted.
 */

const DEFAULT_EXCLUDES = [
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  '.cache/',
  '.parcel-cache/',
  '.gradle/',
  'target/',
  'Pods/',
  'DerivedData/',
  '.DS_Store',
  '*.log',
  '*.sqlite-journal',
];

const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 2 * 1024 ** 3;
const MAX_FILES = 150_000;
const OFF_FOR = 7 * 86_400_000;

const checkpointsRoot = () => join(app.getPath('userData'), 'checkpoints');
const repoDir = (projectId: string) => join(checkpointsRoot(), `${projectId}.git`);
const offFile = (projectId: string) => join(checkpointsRoot(), `${projectId}.off.json`);
const gb = (n: number) => `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
/** Projects where snapshots are off for this run (too big, no git, or a folder that must not be snapshotted). */
const disabled = new Map<string, string>();
const queues = new Map<string, Promise<unknown>>();

/** One git command at a time per project (the shadow index has a lock). */
function queued<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(projectId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(projectId, next);
  return next;
}

function git(projectId: string, cwd: string, args: string[], timeout = 60_000): Promise<string> {
  const env = {
    ...process.env,
    GIT_DIR: repoDir(projectId),
    GIT_WORK_TREE: cwd,
    GIT_AUTHOR_NAME: 'Olympus Coder',
    GIT_AUTHOR_EMAIL: 'checkpoints@olympus.local',
    GIT_COMMITTER_NAME: 'Olympus Coder',
    GIT_COMMITTER_EMAIL: 'checkpoints@olympus.local',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
  const base = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'advice.addEmbeddedRepo=false'];
  return new Promise((res, rej) =>
    execFile('git', [...base, ...args], { cwd, env, maxBuffer: 64 * 1024 * 1024, timeout, windowsHide: true }, (e, out, err) => {
      if (e) rej(Object.assign(new Error(String(err || e.message).trim()), { code: (e as any).code, killed: (e as any).killed }));
      else res(String(out));
    }),
  );
}

/** Folders that are never snapshotted: the home folder itself, the disk root, the app's own data. */
function unsafeFolder(path: string): string | undefined {
  const p = resolve(path);
  if (p === resolve(homedir()) || p === sep || /^[A-Za-z]:\\?$/.test(p)) return 'This folder is too broad to snapshot.';
  if (p.startsWith(resolve(app.getPath('userData')))) return 'App data folder.';
  return undefined;
}

async function ensureRepo(projectId: string, cwd: string) {
  const dir = repoDir(projectId);
  if (existsSync(join(dir, 'HEAD'))) return;
  mkdirSync(dir, { recursive: true });
  await git(projectId, cwd, ['init', '--quiet']);
  writeExcludes(projectId, new Set());
}

// ---- big files and big projects ----

/** Files left out of snapshots for being too big, per project (kept in the shadow repo's info/exclude). */
const bigFiles = new Map<string, Set<string>>();
const escapeIgnore = (p: string) => `/${p.replace(/([\\*?[\]!#])/g, '\\$1').replace(/^ /, '\\ ')}`;

function writeExcludes(projectId: string, big: Set<string>) {
  const dir = join(repoDir(projectId), 'info');
  mkdirSync(dir, { recursive: true });
  const lines = [...DEFAULT_EXCLUDES, '', '# Files over 20 MB, left out by Olympus Coder', ...[...big].sort().map(escapeIgnore)];
  writeFileSync(join(dir, 'exclude'), `${lines.join('\n')}\n`);
  bigFiles.set(projectId, big);
}

function loadBig(projectId: string): Set<string> {
  let set = bigFiles.get(projectId);
  if (!set) {
    set = new Set();
    try {
      const text = readFileSync(join(repoDir(projectId), 'info', 'exclude'), 'utf8');
      const at = text.indexOf('# Files over 20 MB');
      if (at >= 0)
        for (const l of text.slice(at).split('\n').slice(1))
          if (l.startsWith('/')) set.add(l.slice(1).replace(/^\\ /, ' ').replace(/\\(.)/g, '$1'));
    } catch {
      /* new repo */
    }
    bigFiles.set(projectId, set);
  }
  return set;
}

/**
 * Before `git add`: looks at the files that would be added (new or changed, .gitignore honoured), leaves out
 * the ones over 20 MB, and on the first snapshot refuses a project that is too big overall. Returns a reason
 * when the project is too big.
 */
async function guardSize(projectId: string, cwd: string, first: boolean): Promise<string | undefined> {
  const list = await git(projectId, cwd, ['ls-files', '-z', '--others', '--modified', '--exclude-standard'], 30_000);
  const names = list.split('\0').filter(Boolean);
  if (first && names.length > MAX_FILES) return `This project has more than ${MAX_FILES.toLocaleString()} files, too many to snapshot.`;
  const big = loadBig(projectId);
  const before = big.size;
  const tracked: string[] = [];
  let total = 0;
  for (const n of names) {
    let size = 0;
    try {
      const st = lstatSync(join(cwd, n));
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue; // deleted
    }
    if (size > MAX_FILE) {
      if (!big.has(n)) {
        big.add(n);
        tracked.push(n);
      }
    } else total += size;
  }
  if (first && total > MAX_TOTAL) return `This project has ${gb(total)} of files (without ones over 20 MB), too much to snapshot.`;
  if (big.size !== before) {
    writeExcludes(projectId, big);
    // A file that was small in an earlier snapshot and is big now stops being tracked.
    if (!first) await git(projectId, cwd, ['rm', '-q', '--cached', '--ignore-unmatch', '--', ...tracked]).catch(() => '');
  }
  return undefined;
}

function hasCommit(dir: string): boolean {
  try {
    const head = readFileSync(join(dir, 'HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref: ') ? head.slice(5) : '';
    if (!ref) return /^[0-9a-f]{40}$/.test(head);
    if (existsSync(join(dir, ref))) return true;
    return existsSync(join(dir, 'packed-refs')) && readFileSync(join(dir, 'packed-refs'), 'utf8').includes(` ${ref}`);
  } catch {
    return false;
  }
}

/** After a failed or killed git command: half-written objects and a stale lock go; an empty store goes entirely. */
function cleanUp(projectId: string) {
  const dir = repoDir(projectId);
  if (!existsSync(dir)) return;
  if (!hasCommit(dir)) return rmSync(dir, { recursive: true, force: true });
  rmSync(join(dir, 'index.lock'), { force: true });
  const objects = join(dir, 'objects');
  try {
    for (const sub of readdirSync(objects)) {
      const p = join(objects, sub);
      if (sub.startsWith('tmp_')) rmSync(p, { force: true });
      else if (statSync(p).isDirectory()) for (const f of readdirSync(p)) if (f.startsWith('tmp_')) rmSync(join(p, f), { force: true });
    }
  } catch {
    /* nothing to clean */
  }
}

/** Snapshots stay off for a project that was too big, for a week (then it is checked again). */
function rememberedOff(projectId: string): string | undefined {
  try {
    const j = JSON.parse(readFileSync(offFile(projectId), 'utf8'));
    if (Date.now() - j.at < OFF_FOR) return String(j.reason);
    rmSync(offFile(projectId), { force: true });
  } catch {
    /* none */
  }
  return undefined;
}
function turnOff(projectId: string, reason: string, remember: boolean) {
  disabled.set(projectId, reason);
  if (remember) {
    mkdirSync(checkpointsRoot(), { recursive: true });
    writeFileSync(offFile(projectId), JSON.stringify({ reason, at: Date.now() }));
  }
}

/** At start-up: clears what earlier failed snapshots left behind (e.g. a big project's first try that timed out). */
export function cleanUpCheckpoints() {
  try {
    for (const f of readdirSync(checkpointsRoot())) if (f.endsWith('.git')) cleanUp(f.slice(0, -4));
  } catch {
    /* no checkpoints yet */
  }
}

/**
 * Takes a snapshot of the project folder and returns its commit id, or undefined when snapshots are off for
 * this project (reason kept for the UI). The first snapshot of a big project can take a while; one that
 * runs past the time limit turns checkpoints off for that project for this run.
 */
export function snapshot(projectId: string, cwd: string, label: string, timeout = 45_000): Promise<string | undefined> {
  if (disabled.has(projectId)) return Promise.resolve(undefined);
  const unsafe = unsafeFolder(cwd) ?? rememberedOff(projectId);
  if (unsafe) {
    disabled.set(projectId, unsafe);
    return Promise.resolve(undefined);
  }
  return queued(projectId, async () => {
    try {
      await ensureRepo(projectId, cwd);
      const first = !hasCommit(repoDir(projectId));
      const tooBig = await guardSize(projectId, cwd, first);
      if (tooBig) {
        turnOff(projectId, tooBig, true);
        cleanUp(projectId);
        return undefined;
      }
      await git(projectId, cwd, ['add', '-A', '--ignore-errors', '.'], timeout);
      const head = await git(projectId, cwd, ['rev-parse', '--verify', '-q', 'HEAD']).then((s) => s.trim()).catch(() => '');
      if (head) {
        // Nothing changed since the last snapshot: reuse it.
        const same = await git(projectId, cwd, ['diff', '--cached', '--quiet']).then(() => true).catch(() => false);
        if (same) return head;
      }
      await git(projectId, cwd, ['commit', '-q', '--no-verify', '--allow-empty', '-m', label], timeout);
      return (await git(projectId, cwd, ['rev-parse', 'HEAD'])).trim();
    } catch (e: any) {
      if (e?.code === 'ENOENT') disabled.set(projectId, 'git is not installed.');
      else if (e?.killed || /maxBuffer/i.test(String(e?.message))) turnOff(projectId, 'The project is too big to snapshot quickly.', true);
      cleanUp(projectId);
      return undefined;
    }
  });
}

export const checkpointsOff = (projectId: string) => disabled.get(projectId);

/** The files that differ between two snapshots, with line counts. */
export function changes(projectId: string, cwd: string, a: string, b: string): Promise<TurnFileChange[]> {
  return queued(projectId, async () => {
    if (a === b) return [];
    const [status, nums] = await Promise.all([
      git(projectId, cwd, ['diff', '--no-renames', '--name-status', '-z', a, b]),
      git(projectId, cwd, ['diff', '--no-renames', '--numstat', '-z', a, b]),
    ]);
    const counts = new Map<string, { added: number; removed: number; binary: boolean }>();
    for (const rec of nums.split('\0').filter(Boolean)) {
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
      if (m) counts.set(m[3], { added: m[1] === '-' ? 0 : +m[1], removed: m[2] === '-' ? 0 : +m[2], binary: m[1] === '-' });
    }
    const parts = status.split('\0').filter(Boolean);
    const out: TurnFileChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const st = parts[i][0] as 'A' | 'M' | 'D' | 'T';
      const path = parts[i + 1];
      const c = counts.get(path) ?? { added: 0, removed: 0, binary: false };
      out.push({ path, status: st === 'T' ? 'M' : st, ...c });
    }
    return out;
  });
}

export function fileDiff(projectId: string, cwd: string, a: string, b: string, path: string): Promise<string> {
  return queued(projectId, () => git(projectId, cwd, ['diff', '--no-renames', '--no-color', a, b, '--', path]));
}

/** Files whose current content is not what snapshot `at` has (changed again since). */
export function changedSince(projectId: string, cwd: string, at: string, paths: string[]): Promise<string[]> {
  return queued(projectId, async () => {
    if (!paths.length) return [];
    await git(projectId, cwd, ['add', '-A', '--ignore-errors', '--', ...paths]).catch(() => '');
    const out = await git(projectId, cwd, ['diff', '--cached', '--no-renames', '--name-only', '-z', at, '--', ...paths]);
    return out.split('\0').filter(Boolean);
  });
}

/**
 * Puts `paths` back to how they are in snapshot `to`: files that don't exist there are deleted. A snapshot of
 * the current state is taken first and returned, so this can be reversed.
 */
export async function restore(projectId: string, cwd: string, to: string, paths: string[]): Promise<string | undefined> {
  const backup = await snapshot(projectId, cwd, 'before restore');
  if (!backup) throw new Error(checkpointsOff(projectId) ?? 'Could not take a snapshot first.');
  await queued(projectId, async () => {
    const exists = new Set(
      (await git(projectId, cwd, ['ls-tree', '-r', '--name-only', '-z', to, '--', ...paths])).split('\0').filter(Boolean),
    );
    const back = paths.filter((p) => exists.has(p));
    for (let i = 0; i < back.length; i += 200) await git(projectId, cwd, ['checkout', to, '--', ...back.slice(i, i + 200)]);
    const root = resolve(cwd);
    for (const p of paths.filter((p) => !exists.has(p))) {
      const full = resolve(cwd, p);
      if (!full.startsWith(root + sep)) continue;
      rmSync(full, { force: true });
      // Folders the turn created and that are now empty go too.
      for (let dir = dirname(full); dir.startsWith(root + sep); dir = dirname(dir)) {
        try {
          if (readdirSync(dir).length) break;
          rmdirSync(dir);
        } catch {
          break;
        }
      }
    }
  });
  return backup;
}

/** Drops a project's snapshots (when the project is removed from the app). */
export function forgetCheckpoints(projectId: string) {
  rmSync(repoDir(projectId), { recursive: true, force: true });
  rmSync(offFile(projectId), { force: true });
  bigFiles.delete(projectId);
  disabled.delete(projectId);
}
