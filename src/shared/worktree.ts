import type { ThreadMeta, ThreadWorktree } from './types';

/**
 * Git worktree chats: a chat (or sub-session) can run in its own git worktree so parallel agents never edit the
 * same working tree. Every place in the app that resolves a folder from a project id (files, git, terminals,
 * Verify Gate, preview, turn checkpoints) gets a *virtual project id* for such a chat:
 * `<projectId>__wt_<threadId>`. The main process resolves that id to a project record whose `path` is the
 * worktree folder (other fields copied from the base project), so the existing per-project IPC keeps working.
 *
 * The thread itself keeps its real `projectId` (it is stored and listed under the base project).
 */

const SEP = '__wt_';

/** Virtual project id for a worktree chat. */
export const worktreeProjectId = (projectId: string, threadId: string): string => `${projectId}${SEP}${threadId}`;

/** `{ projectId, threadId }` for a virtual worktree project id, otherwise undefined. */
export function parseWorktreeProjectId(id: string): { projectId: string; threadId: string } | undefined {
  const i = id.indexOf(SEP);
  if (i <= 0) return undefined;
  const threadId = id.slice(i + SEP.length);
  return threadId ? { projectId: id.slice(0, i), threadId } : undefined;
}

/**
 * The worktree a chat works in. It stays active after a merge (the chat can keep working and merge again);
 * `mergedAt` only records the last merge. It ends when the worktree is removed (`thread.worktree` cleared).
 */
export const activeWorktree = (t: Pick<ThreadMeta, 'worktree'> | undefined | null): ThreadWorktree | undefined =>
  t?.worktree ?? undefined;

/** The project id every workbench panel should use for this chat (virtual id while its worktree is active). */
export const workspaceProjectId = (t: Pick<ThreadMeta, 'id' | 'projectId' | 'worktree'>): string =>
  activeWorktree(t) ? worktreeProjectId(t.projectId, t.id) : t.projectId;

/** Branch name for a new worktree chat: `olympus/<slug>-<4 chars of the thread id>`. */
export function worktreeBranchName(title: string | undefined, threadId: string): string {
  const slug = (title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  const tail = threadId.replace(/[^a-z0-9]/gi, '').slice(0, 4).toLowerCase() || 'wt';
  return `olympus/${slug ? `${slug}-` : 'chat-'}${tail}`;
}
