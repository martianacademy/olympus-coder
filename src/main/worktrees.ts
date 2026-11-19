import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { ThreadWorktree, WorktreeMergeResult, WorktreeStatusView } from '@shared/types';

/**
 * Git worktree chats (see src/shared/worktree.ts): a chat runs in `<sharedRoot>/worktrees/<projectId>/<short id>`
 * on its own branch. Everything here takes paths and runs the user's `git` with an argument array (never a
 * shell) and a timeout. No Electron import: the integration test runs this file under plain Node.
 *
 * Zero-download setup: top-level `node_modules`, `.venv`, `venv` are symlinked from the source folder (junctions on
 * Windows) and untracked top-level `.env` / `.env.*` files are copied. These "setup paths" are left out of the
 * dirty count and out of every automatic commit (a symlinked folder is a file to git, so `node_modules/` in a
 * .gitignore does not hide it, and worktrees share the main repository's `info/exclude`, so filtering is the
 * only way that does not touch the user's repository config).
 */

/** Top-level folders linked from the source folder into a new worktree. */
export const LINKED_DIRS = ['node_modules', '.venv', 'venv'] as const;
/** Top-level files copied (untracked `.env` and `.env.*`). */
export const isEnvFile = (name: string) => name === '.env' || name.startsWith('.env.');

let gitEnv: () => NodeJS.ProcessEnv = () => process.env;
/** The app passes the user's login-shell environment (agentEnv) so `git` is found as in a terminal. */
export const configureWorktreeGit = (env: () => NodeJS.ProcessEnv) => void (gitEnv = env);

export class GitError extends Error {
  readonly code: number | null;
  readonly stdout: string;
  constructor(message: string, code: number | null, stdout: string) {
    super(message);
    this.code = code;
    this.stdout = stdout;
  }
}

export function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...gitEnv(), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }, timeout, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new GitError((stderr || stdout || err.message).trim(), typeof err.code === 'number' ? err.code : null, String(stdout)));
        else resolve(String(stdout));
      },
    );
  });
}

const tryGit = (cwd: string, args: string[], timeout?: number) => git(cwd, args, timeout).then((s) => s.trim(), () => undefined);

/** Where a chat's worktree goes. */
export const worktreeDir = (sharedRoot: string, projectId: string, threadId: string) => join(sharedRoot, 'worktrees', projectId, threadId.slice(0, 8));

/** The branch checked out in `dir`; throws a readable error for a non-git folder, a detached HEAD or no commits. */
export async function currentBranch(dir: string): Promise<string> {
  if (!existsSync(dir)) throw new Error(`${dir} does not exist.`);
  if ((await tryGit(dir, ['rev-parse', '--is-inside-work-tree'])) !== 'true') throw new Error('This project is not a git repository.');
  const branch = await tryGit(dir, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (!branch) throw new Error('This project is on a detached HEAD. Check out a branch first.');
  if (!(await tryGit(dir, ['rev-parse', '--verify', '-q', 'HEAD']))) throw new Error('This project has no commits yet. Make a first commit before using a worktree.');
  return branch;
}

/** The `LINKED_DIRS` symlinks our setup made at the top level of `dir` (a worktree folder). Sync, no git. */
export function setupLinks(dir: string): string[] {
  const out: string[] = [];
  for (const name of LINKED_DIRS) {
    try {
      if (lstatSync(join(dir, name)).isSymbolicLink()) out.push(name);
    } catch {
      /* not there */
    }
  }
  return out;
}

/**
 * Names a worktree's setup step added at its top level: our symlinks, and `.env*` files git does not track.
 * Computed from the folder (nothing stored), so it also covers worktrees from an earlier run of the app.
 */
export async function setupPaths(dir: string): Promise<string[]> {
  const out: string[] = setupLinks(dir);
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter(isEnvFile);
  } catch {
    /* folder gone */
  }
  if (names.length) {
    const tracked = new Set((await tryGit(dir, ['ls-files', '-z', '--', ...names]))?.split('\0').filter(Boolean) ?? []);
    out.push(...names.filter((n) => !tracked.has(n)));
  }
  return out;
}

/** Links / copies the setup paths from `from` into `to` (both folders at the same level of their repositories). */
export function setupWorktree(from: string, to: string): string[] {
  const done: string[] = [];
  for (const name of LINKED_DIRS) {
    const src = join(from, name);
    const dst = join(to, name);
    try {
      if (!statSync(src).isDirectory() || existsSync(dst)) continue; // tracked (checked out) or missing: leave it
      symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
      done.push(name);
    } catch {
      /* no such folder in the source */
    }
  }
  let names: string[] = [];
  try {
    names = readdirSync(from).filter(isEnvFile);
  } catch {
    /* unreadable */
  }
  for (const name of names) {
    const src = join(from, name);
    const dst = join(to, name);
    try {
      if (!statSync(src).isFile() || existsSync(dst)) continue; // tracked files are already checked out
      copyFileSync(src, dst);
      done.push(name);
    } catch {
      /* skip */
    }
  }
  return done;
}

export interface CreateWorktreeArgs {
  sharedRoot: string;
  projectId: string;
  threadId: string;
  branch: string;
  /** The folder the worktree branches from: the base project, or the parent chat's worktree. */
  fromPath: string;
}

/** `git worktree add -b <branch> <dir> HEAD` from `fromPath`, then the zero-download setup. */
export async function createWorktree(a: CreateWorktreeArgs): Promise<ThreadWorktree> {
  const baseBranch = await currentBranch(a.fromPath);
  const baseCommit = (await git(a.fromPath, ['rev-parse', 'HEAD'])).trim();
  // A project folder inside a bigger repository: the chat works in the same sub-folder of the new worktree.
  const prefix = (await tryGit(a.fromPath, ['rev-parse', '--show-prefix'])) ?? '';
  const root = worktreeDir(a.sharedRoot, a.projectId, a.threadId);
  if (existsSync(root)) throw new Error(`The worktree folder already exists: ${root}`);
  mkdirSync(dirname(root), { recursive: true });
  try {
    await git(a.fromPath, ['worktree', 'add', '-b', a.branch, root, 'HEAD'], 120_000);
  } catch (e: any) {
    throw new Error(`Could not create the worktree: ${e?.message ?? e}`);
  }
  const path = prefix ? join(root, prefix) : root;
  setupWorktree(a.fromPath, path);
  return { path, branch: a.branch, baseBranch, baseCommit, createdAt: Date.now() };
}

/** Paths from `git status --porcelain -z` (renames give the new path). */
export function parsePorcelainZ(out: string): string[] {
  const parts = out.split('\0');
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const x = e[0];
    files.push(e.slice(3).replace(/\/$/, ''));
    if (x === 'R' || x === 'C') i++; // the source path follows as its own field
  }
  return files;
}

/** `rev-list --left-right --count base...branch` → { behind, ahead }. */
export function parseLeftRight(out: string): { behind: number; ahead: number } {
  const [l, r] = out.trim().split(/\s+/).map((n) => Number(n) || 0);
  return { behind: l ?? 0, ahead: r ?? 0 };
}

/** Uncommitted paths in the worktree (`dirty`) and the setup paths git would otherwise report (`setup`). */
async function dirtyPaths(dir: string): Promise<{ dirty: string[]; setup: string[] }> {
  const skip = new Set(await setupPaths(dir));
  const out = await git(dir, ['status', '--porcelain', '-z', '--untracked-files=all', '--', '.']);
  // Paths are relative to the repository root; the setup paths sit in `dir` (the project's sub-folder).
  const prefix = (await tryGit(dir, ['rev-parse', '--show-prefix'])) ?? '';
  const dirty: string[] = [];
  const setup: string[] = [];
  for (const p of parsePorcelainZ(out)) {
    const local = prefix ? relative(prefix.replace(/\/$/, ''), p) : p;
    if (skip.has(local)) setup.push(local);
    else dirty.push(p);
  }
  return { dirty, setup };
}

export async function worktreeStatus(wt: ThreadWorktree): Promise<WorktreeStatusView> {
  const base: WorktreeStatusView = { exists: false, path: wt.path, branch: wt.branch, baseBranch: wt.baseBranch, ahead: 0, behind: 0, dirtyFiles: 0, changedFiles: [] };
  if (!existsSync(wt.path) || (await tryGit(wt.path, ['rev-parse', '--is-inside-work-tree'])) !== 'true') return base;
  const lr = parseLeftRight((await tryGit(wt.path, ['rev-list', '--left-right', '--count', `${wt.baseBranch}...${wt.branch}`])) ?? '0 0');
  const { dirty } = await dirtyPaths(wt.path);
  const committed = ((await tryGit(wt.path, ['diff', '--name-only', `${wt.baseBranch}...HEAD`])) ?? '').split('\n').filter(Boolean);
  const changedFiles = [...new Set([...committed, ...dirty])].sort();
  return { ...base, exists: true, ...lr, dirtyFiles: dirty.length, changedFiles, merged: lr.ahead === 0 && dirty.length === 0 };
}

/** `-c user.name/-c user.email` when the repository has no identity, so an automatic commit never fails on it. */
async function identityArgs(dir: string): Promise<string[]> {
  const email = await tryGit(dir, ['config', 'user.email']);
  return email ? [] : ['-c', 'user.name=Olympus', '-c', 'user.email=olympus@localhost'];
}

/** Commits every uncommitted change in the worktree (setup paths excluded). Returns the new commit or undefined. */
export async function autoCommit(dir: string, message: string): Promise<string | undefined> {
  const { dirty, setup } = await dirtyPaths(dir);
  if (!dirty.length) return undefined;
  // Only setup paths git reports are excluded (excluding an ignored path makes `git add` fail).
  await git(dir, ['add', '-A', '--', '.', ...setup.map((s) => `:(exclude)${s}`)]);
  // Hooks are skipped: this is a safety commit of the agent's work, never a reason to lose it.
  await git(dir, [...(await identityArgs(dir)), 'commit', '--no-verify', '-q', '-m', message]);
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

/** `git worktree list --porcelain` → [{ path, branch? }], main worktree first. */
export function parseWorktreeList(out: string): { path: string; branch?: string }[] {
  const list: { path: string; branch?: string }[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) list.push({ path: line.slice(9) });
    else if (line.startsWith('branch ') && list.length) list[list.length - 1].branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return list;
}

const autoMessage = (title: string) => `Olympus: changes from ${title.replace(/\s+/g, ' ').trim().slice(0, 72) || 'chat'}`;

/** Files with merge conflicts in `dir`. */
const conflictedFiles = async (dir: string) => ((await tryGit(dir, ['diff', '--name-only', '--diff-filter=U'])) ?? '').split('\n').filter(Boolean);

export interface MergeArgs {
  /** Any folder of the repository (the base project); the target is found by the branch it has checked out. */
  repoPath: string;
  mode: 'merge' | 'squash';
  title: string;
  message?: string;
}

/**
 * Merges (`--no-ff`) or squashes the worktree's branch into `baseBranch` in the working tree that has
 * `baseBranch` checked out. Dirty files in the worktree are committed first. A conflict is aborted, leaving
 * the target tree as it was, and the files are returned. After a merge the worktree's branch is moved to the
 * new commit, so the chat keeps working on top of what was merged (ahead 0, behind 0).
 */
export async function mergeWorktree(wt: ThreadWorktree, a: MergeArgs): Promise<WorktreeMergeResult> {
  const fail = (error: string, conflicts?: string[]): WorktreeMergeResult => ({ ok: false, mode: a.mode, error, ...(conflicts ? { conflicts } : {}) });
  if (!existsSync(wt.path)) return fail('The worktree folder is gone.');
  try {
    await autoCommit(wt.path, autoMessage(a.title));
  } catch (e: any) {
    return fail(`Could not commit the worktree's changes: ${e?.message ?? e}`);
  }
  const list = parseWorktreeList(await git(a.repoPath, ['worktree', 'list', '--porcelain']));
  const target = list.find((w) => w.branch === wt.baseBranch && w.path !== wt.path);
  if (!target) return fail(`Switch ${list[0]?.path ?? a.repoPath} to ${wt.baseBranch} first.`);
  const dir = target.path;
  if ((await git(dir, ['rev-list', '--count', `${wt.baseBranch}..${wt.branch}`])).trim() === '0') return fail('Nothing to merge: the branch has no new commits.');
  const message = a.message?.trim() || (a.mode === 'squash' ? `${a.title.trim() || wt.branch} (Olympus, ${wt.branch})` : `Merge ${wt.branch} (Olympus: ${a.title.trim() || 'chat'})`);
  const id = await identityArgs(dir);
  try {
    if (a.mode === 'merge') await git(dir, [...id, 'merge', '--no-ff', '--no-edit', '-m', message, wt.branch], 120_000);
    else {
      await git(dir, ['merge', '--squash', wt.branch], 120_000);
      await git(dir, [...id, 'commit', '--no-verify', '-q', '-m', message]);
    }
  } catch (e: any) {
    const conflicts = await conflictedFiles(dir);
    if (a.mode === 'merge') await tryGit(dir, ['merge', '--abort']);
    if (a.mode === 'squash' || (await tryGit(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']))) await tryGit(dir, ['reset', '--merge']);
    if (conflicts.length) return fail(`Merging ${wt.branch} into ${wt.baseBranch} conflicts in ${conflicts.length} file(s). The merge was aborted.`, conflicts);
    return fail(e?.message ?? String(e));
  }
  const commitSha = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  // Follow the merge in the worktree (its changes are all committed, so this cannot lose work).
  if (a.mode === 'merge') await tryGit(wt.path, ['merge', '--ff-only', '-q', commitSha]);
  else await tryGit(wt.path, ['reset', '--keep', '-q', commitSha]);
  wt.mergedAt = Date.now();
  return { ok: true, mode: a.mode, commitSha };
}

export interface RemoveResult {
  ok: boolean;
  branchKept?: boolean;
  /** The commit that saved uncommitted work before the folder was removed. */
  savedCommit?: string;
  error?: string;
}

/**
 * Removes the worktree folder without losing work: uncommitted changes are committed on its branch first, our
 * symlinks are unlinked (so nothing ever deletes through them into the source folder), then
 * `git worktree remove --force` + `prune`. The branch is deleted only when fully merged (`branch -d`).
 */
export async function removeWorktree(wt: ThreadWorktree, a: { repoPath: string; title: string }): Promise<RemoveResult> {
  let savedCommit: string | undefined;
  const exists = existsSync(wt.path);
  if (exists) {
    try {
      savedCommit = await autoCommit(wt.path, autoMessage(a.title));
    } catch (e: any) {
      return { ok: false, error: `Could not commit the worktree's changes, so it was kept: ${e?.message ?? e}` };
    }
    for (const name of LINKED_DIRS) {
      try {
        if (lstatSync(join(wt.path, name)).isSymbolicLink()) unlinkSync(join(wt.path, name));
      } catch {
        /* not there */
      }
    }
  }
  const root = exists ? ((await tryGit(wt.path, ['rev-parse', '--show-toplevel'])) ?? wt.path) : wt.path;
  if (exists) {
    try {
      await git(a.repoPath, ['worktree', 'remove', '--force', root], 120_000);
    } catch (e: any) {
      return { ok: false, savedCommit, error: `Could not remove the worktree: ${e?.message ?? e}` };
    }
  }
  await tryGit(a.repoPath, ['worktree', 'prune']);
  const deleted = (await tryGit(a.repoPath, ['branch', '-d', wt.branch])) !== undefined;
  const branchExists = Boolean(await tryGit(a.repoPath, ['rev-parse', '--verify', '-q', `refs/heads/${wt.branch}`]));
  return { ok: true, ...(savedCommit ? { savedCommit } : {}), ...(!deleted && branchExists ? { branchKept: true } : {}) };
}
