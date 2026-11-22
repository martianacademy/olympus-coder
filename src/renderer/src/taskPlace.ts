import type { Project, RunningTask, ThreadMeta } from '@shared/types';
import { parseWorktreeProjectId, workspaceProjectId } from '@shared/worktree';

/**
 * Where a running program lives, for the heat toast (HeatToast.tsx): the chat to open and its project's name.
 * An agent's command or terminal names its chat; a terminal the user opened only names its project (a worktree
 * chat's terminal: the virtual id `<project>__wt_<thread>`), so the most recent chat working there stands in.
 */
export function taskThread(t: Pick<RunningTask, 'threadId' | 'projectId'>, threads: ThreadMeta[]): { id: string; meta?: ThreadMeta } | undefined {
  if (t.threadId) return { id: t.threadId, meta: threads.find((x) => x.id === t.threadId) };
  if (!t.projectId) return undefined;
  const wt = parseWorktreeProjectId(t.projectId);
  if (wt) return { id: wt.threadId, meta: threads.find((x) => x.id === wt.threadId) };
  const meta = threads.filter((x) => workspaceProjectId(x) === t.projectId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return meta ? { id: meta.id, meta } : undefined;
}

/** The program's project and chat in words ("ml-prize-hunter", "Train the model"); either may be unknown. */
export function taskPlace(t: Pick<RunningTask, 'threadId' | 'projectId'>, threads: ThreadMeta[], projects: Pick<Project, 'id' | 'name'>[]): { project?: string; chat?: string } {
  const th = taskThread(t, threads);
  const pid = (t.projectId && (parseWorktreeProjectId(t.projectId)?.projectId ?? t.projectId)) || th?.meta?.projectId;
  const project = pid === 'general' ? 'Chat' : projects.find((p) => p.id === pid)?.name;
  return { ...(project ? { project } : {}), ...(th?.meta?.title ? { chat: th.meta.title } : {}) };
}
