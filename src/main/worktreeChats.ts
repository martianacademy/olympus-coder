import { existsSync } from 'node:fs';
import type { Thread, ThreadMeta, WorktreeMergeResult, WorktreeStatusView } from '@shared/types';
import { activeWorktree, worktreeBranchName, worktreeProjectId } from '@shared/worktree';
import { forgetCheckpoints } from './checkpoints';
import { findThread, projectRecord, saveThreadNow, sharedRoot } from './store';
import { createWorktree, mergeWorktree, removeWorktree, worktreeStatus, type RemoveResult } from './worktrees';

/**
 * The chat side of git worktrees (src/main/worktrees.ts does the git work): creating one for a new chat or
 * sub-session, status / merge / remove by thread id, and cleanup when a chat is deleted.
 */

const repoPathOf = (t: Pick<ThreadMeta, 'projectId'>): string => {
  const p = projectRecord(t.projectId);
  if (!p) throw new Error('Project not found.');
  return p.path;
};

const chatOrThrow = (threadId: string): Thread => {
  const t = findThread(threadId);
  if (!t) throw new Error('Chat not found.');
  return t;
};

/**
 * Gives `t` its own worktree (saved on the thread). It branches from the parent chat's worktree when `parent`
 * runs in one (base branch = the parent's branch), otherwise from the project folder.
 */
export async function startChatWorktree(t: Thread, parent?: Thread): Promise<Thread> {
  if (activeWorktree(t)) return t;
  const parentWt = activeWorktree(parent);
  const fromPath = parentWt && existsSync(parentWt.path) ? parentWt.path : repoPathOf(t);
  const title = t.title && t.title !== 'New chat' ? t.title : undefined;
  t.worktree = await createWorktree({ sharedRoot: sharedRoot(), projectId: t.projectId, threadId: t.id, branch: worktreeBranchName(title, t.id), fromPath });
  saveThreadNow(t);
  return t;
}

export async function chatWorktreeStatus(threadId: string): Promise<WorktreeStatusView | null> {
  const wt = activeWorktree(findThread(threadId));
  return wt ? worktreeStatus(wt) : null;
}

export async function mergeChatWorktree(threadId: string, mode: 'merge' | 'squash', message?: string): Promise<WorktreeMergeResult> {
  const t = chatOrThrow(threadId);
  const wt = activeWorktree(t);
  if (!wt) return { ok: false, mode, error: 'This chat does not run in a worktree.' };
  if (mode !== 'merge' && mode !== 'squash') return { ok: false, mode, error: `Unknown merge mode "${mode}".` };
  const r = await mergeWorktree(wt, { repoPath: repoPathOf(t), mode, title: t.title, ...(message ? { message } : {}) });
  if (r.ok) saveThreadNow(t); // mergedAt
  return r;
}

/** Removes the chat's worktree (work is committed on its branch first; an unmerged branch is kept). */
export async function removeChatWorktree(threadId: string): Promise<RemoveResult> {
  const t = chatOrThrow(threadId);
  const wt = activeWorktree(t);
  if (!wt) return { ok: true };
  const r = await removeWorktree(wt, { repoPath: repoPathOf(t), title: t.title });
  if (r.ok) {
    delete t.worktree;
    saveThreadNow(t);
    forgetCheckpoints(worktreeProjectId(t.projectId, t.id)); // the turn snapshots of the worktree folder
  }
  return r;
}

/** After a chat was deleted (any path: sidebar, delete_subsession, disposable cleanup): remove its worktree. */
export async function removeDeletedChatWorktree(meta: ThreadMeta): Promise<void> {
  const wt = activeWorktree(meta);
  if (!wt) return;
  try {
    const r = await removeWorktree(wt, { repoPath: repoPathOf(meta), title: meta.title });
    if (r.ok) forgetCheckpoints(worktreeProjectId(meta.projectId, meta.id));
    if (!r.ok) console.error(`[worktree] removing ${wt.path} for deleted chat ${meta.id} failed: ${r.error}`);
    else if (r.branchKept) console.log(`[worktree] removed ${wt.path}; unmerged branch ${wt.branch} kept`);
  } catch (e) {
    console.error(`[worktree] removing ${wt.path} for deleted chat ${meta.id} failed:`, e);
  }
}
