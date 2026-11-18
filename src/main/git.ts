import { execFile } from 'node:child_process';
import type { GitBranch, GitCommit, GitFileChange, GitStash, GitStatus } from '@shared/types';
import { agentEnv } from './env';
import { inside } from './files';
import { getProject } from './store';

/**
 * Git for the Code view: everything runs the user's own `git` in the project folder, with arguments passed
 * as an array (never through a shell). Prompts are disabled so a push that needs a password fails with a
 * message instead of hanging; credentials come from the user's usual helper (macOS keychain, gh, ssh agent).
 */

function cwd(projectId: string) {
  const p = getProject(projectId);
  if (!p) throw new Error('Project not found.');
  return p.path;
}

function git(projectId: string, args: string[], opts: { timeout?: number; maxBuffer?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd: cwd(projectId),
        env: agentEnv({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }),
        timeout: opts.timeout ?? 60_000,
        maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || stdout || err.message).trim()));
        else resolve(stdout);
      },
    );
  });
}

/** Paths from the renderer must be inside the project; git gets them after `--` so they are never options. */
function paths(projectId: string, list: string[]): string[] {
  for (const p of list) inside(projectId, p);
  return ['--', ...list];
}

export async function status(projectId: string): Promise<GitStatus> {
  let out: string;
  try {
    out = await git(projectId, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  } catch (e: any) {
    if (/not a git repository/i.test(e.message)) return { isRepo: false, branch: '', ahead: 0, behind: 0, detached: false, files: [] };
    throw e;
  }
  const st: GitStatus = { isRepo: true, branch: '', ahead: 0, behind: 0, detached: false, files: [] };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      st.branch = line.slice(14);
      st.detached = st.branch === '(detached)';
    } else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) [st.ahead, st.behind] = [Number(m[1]), Number(m[2])];
    } else if (line[0] === '1' || line[0] === '2') {
      // 1 XY sub mH mI mW hH hI path   |   2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const f = line.split(' ');
      const xy = f[1];
      const path = f.slice(line[0] === '1' ? 8 : 9).join(' ');
      const change: GitFileChange = { path, index: xy[0], worktree: xy[1], untracked: false, conflicted: false };
      if (line[0] === '2') change.from = parts[++i];
      st.files.push(change);
    } else if (line[0] === 'u') {
      const f = line.split(' ');
      st.files.push({ path: f.slice(10).join(' '), index: 'U', worktree: 'U', untracked: false, conflicted: true });
    } else if (line[0] === '?') {
      st.files.push({ path: line.slice(2), index: '.', worktree: '?', untracked: true, conflicted: false });
    }
  }
  return st;
}

export const init = (projectId: string) => git(projectId, ['init']);

/** Unified diff for one file: staged (index vs HEAD) or working tree (files vs index). Untracked files show as all-new. */
export async function diff(projectId: string, path: string, staged: boolean, untracked: boolean): Promise<string> {
  if (untracked) {
    try {
      return await git(projectId, ['diff', '--no-color', '--no-index', '--', '/dev/null', path]);
    } catch (e: any) {
      // --no-index exits 1 when files differ, which is always the case here.
      return e.message.startsWith('diff --git') ? e.message : '';
    }
  }
  return git(projectId, ['diff', '--no-color', ...(staged ? ['--cached'] : []), ...paths(projectId, [path])]);
}

/** Compact uncommitted status + diff summary for 1-click "Fix this error" prompts (empty if clean or not a repo). */
export async function workingDiff(projectId: string, maxChars = 3500): Promise<string> {
  try {
    const short = (await git(projectId, ['status', '--short', '--untracked-files=normal'], { timeout: 8000 })).trim();
    if (!short) return '';
    const patch = (await git(projectId, ['diff', 'HEAD', '--no-color', '-U2'], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }).catch(() => '')).trim();
    const combined = patch ? `${short}\n\n${patch}` : short;
    return combined.length > maxChars ? `${combined.slice(0, maxChars)}\n… (diff truncated)` : combined;
  } catch {
    return '';
  }
}

export const stage = (projectId: string, files: string[]) => git(projectId, ['add', '-A', ...paths(projectId, files)]);
export const stageAll = (projectId: string) => git(projectId, ['add', '-A']);
export const unstage = (projectId: string, files: string[]) => git(projectId, ['restore', '--staged', ...paths(projectId, files)]);
export const unstageAll = (projectId: string) => git(projectId, ['reset', '-q']);

/** Throws away working-tree changes. Untracked files are removed with `git clean` for those paths only. */
export async function discard(projectId: string, files: string[], untracked: boolean): Promise<void> {
  if (untracked) await git(projectId, ['clean', '-f', ...paths(projectId, files)]);
  else await git(projectId, ['restore', '--worktree', ...paths(projectId, files)]);
}

export async function commit(projectId: string, message: string, opts: { amend?: boolean; all?: boolean } = {}): Promise<string> {
  if (!message.trim() && !opts.amend) throw new Error('Enter a commit message.');
  if (opts.all) await stageAll(projectId);
  const args = ['commit', '-m', message];
  if (opts.amend) args.push('--amend');
  if (opts.amend && !message.trim()) args.splice(1, 2, '--no-edit');
  return git(projectId, args);
}

export async function push(projectId: string, opts: { setUpstream?: boolean; force?: boolean } = {}): Promise<string> {
  const st = await status(projectId);
  const args = ['push'];
  if (opts.force) args.push('--force-with-lease');
  if (!st.upstream || opts.setUpstream) args.push('-u', 'origin', st.branch);
  return git(projectId, args, { timeout: 180_000 });
}

export const pull = (projectId: string, rebase = false) => git(projectId, ['pull', rebase ? '--rebase' : '--no-rebase'], { timeout: 180_000 });
export const fetchAll = (projectId: string) => git(projectId, ['fetch', '--all', '--prune'], { timeout: 180_000 });

export async function branches(projectId: string): Promise<GitBranch[]> {
  const out = await git(projectId, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(HEAD)\t%(refname)\t%(refname:short)\t%(upstream:short)\t%(committerdate:unix)',
    'refs/heads',
    'refs/remotes',
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [head, ref, name, upstream, date] = l.split('\t');
      return { name, current: head === '*', remote: ref.startsWith('refs/remotes/'), upstream: upstream || undefined, lastCommit: Number(date) * 1000 };
    })
    .filter((b) => !b.name.endsWith('/HEAD'));
}

const validBranch = (name: string) => {
  if (!/^[\w./-]+$/.test(name) || name.startsWith('-') || name.includes('..')) throw new Error('Invalid branch name.');
  return name;
};

/** Switch branch. For a remote branch like origin/feature, creates the local tracking branch. */
export async function checkout(projectId: string, name: string, remote: boolean): Promise<string> {
  validBranch(name);
  if (remote) {
    const local = name.split('/').slice(1).join('/');
    return git(projectId, ['switch', '--track', '-c', local, name]).catch(() => git(projectId, ['switch', local]));
  }
  return git(projectId, ['switch', name]);
}

export const createBranch = (projectId: string, name: string) => git(projectId, ['switch', '-c', validBranch(name)]);
export const deleteBranch = (projectId: string, name: string, force = false) => git(projectId, ['branch', force ? '-D' : '-d', validBranch(name)]);
export const merge = (projectId: string, name: string) => git(projectId, ['merge', '--no-edit', validBranch(name)]);

export async function log(projectId: string, limit = 100): Promise<GitCommit[]> {
  let out: string;
  try {
    out = await git(projectId, ['log', `-n${limit}`, '--date=unix', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%D%x1f%s%x1e']);
  } catch (e: any) {
    if (/does not have any commits|bad default revision/i.test(e.message)) return [];
    throw e;
  }
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, short, author, email, date, refs, subject] = r.split('\x1f');
      return { hash, short, author, email, date: Number(date) * 1000, refs, subject };
    });
}

export const show = (projectId: string, hash: string) => {
  if (!/^[0-9a-f]{4,64}$/i.test(hash)) throw new Error('Invalid commit hash.');
  return git(projectId, ['show', '--no-color', '--stat', '--patch', hash]);
};

export async function stashes(projectId: string): Promise<GitStash[]> {
  const out = await git(projectId, ['stash', 'list', '--format=%gd%x1f%s']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref, message] = l.split('\x1f');
      return { ref, message };
    });
}

const stashRef = (ref: string) => {
  if (!/^stash@\{\d+\}$/.test(ref)) throw new Error('Invalid stash ref.');
  return ref;
};
export const stashSave = (projectId: string, message: string) => git(projectId, ['stash', 'push', '--include-untracked', ...(message.trim() ? ['-m', message.trim()] : [])]);
export const stashPop = (projectId: string, ref: string) => git(projectId, ['stash', 'pop', stashRef(ref)]);
export const stashApply = (projectId: string, ref: string) => git(projectId, ['stash', 'apply', stashRef(ref)]);
export const stashDrop = (projectId: string, ref: string) => git(projectId, ['stash', 'drop', stashRef(ref)]);
