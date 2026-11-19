/**
 * Pure helpers for the git worktree chat UI (WorktreeSection, the chat-header chip, the new-chat toggle).
 * No imports with runtime code, so `tests/worktreeUi.unit.mjs` can load this file straight from Node.
 */
import type { WorktreeStatusView } from '@shared/types';

/** An IPC error as a readable sentence (drops Electron's "Error invoking remote method 'x': Error:" prefix). */
export function cleanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String((e as { message?: unknown } | null)?.message ?? e);
  return raw.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, '').trim() || 'Something went wrong.';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 commits ahead · 1 behind · 3 uncommitted" (only the non-zero parts), or "Up to date with main". */
export function worktreeCounts(s: Pick<WorktreeStatusView, 'ahead' | 'behind' | 'dirtyFiles' | 'baseBranch'>): string {
  const parts: string[] = [];
  if (s.ahead) parts.push(`${plural(s.ahead, 'commit')} ahead`);
  if (s.behind) parts.push(`${s.behind} behind`);
  if (s.dirtyFiles) parts.push(`${s.dirtyFiles} uncommitted`);
  return parts.length ? parts.join(' · ') : `Up to date with ${s.baseBranch}`;
}

/** Window event WorktreeSection fires with each status it loads, so the empty chat's toggle can follow it. */
export const WORKTREE_STATUS_EVENT = 'olympus:worktree-status';

/** True when merging would bring something into the base branch (commits ahead or uncommitted files). */
export const hasWorkToMerge = (s: Pick<WorktreeStatusView, 'ahead' | 'dirtyFiles'>): boolean => s.ahead > 0 || s.dirtyFiles > 0;

/** The tooltip on the chat header's branch chip. */
export function worktreeTip(w: { branch: string; baseBranch: string; path: string }): string {
  return `Isolated git worktree\nBranch ${w.branch} (from ${w.baseBranch})\n${w.path}\nOpen the Info panel to merge or remove it.`;
}

/** The message "Ask the agent to resolve" sends into the chat after a merge stopped on conflicts. */
export function resolveConflictsPrompt(o: { branch: string; baseBranch: string; conflicts: string[]; mode: 'merge' | 'squash' }): string {
  const files = o.conflicts.length ? o.conflicts.map((f) => `- ${f}`).join('\n') : '- (git did not list the files)';
  return [
    `Merging this worktree's branch \`${o.branch}\` into \`${o.baseBranch}\` (${o.mode}) stopped on conflicts, and the merge was aborted. Conflicting files:`,
    files,
    '',
    `Please rebase \`${o.branch}\` onto \`${o.baseBranch}\` in this worktree, resolve the conflicts in those files (keep both sides' intent), run the project's checks (type-check, build and tests), and commit the result. Then tell me when it is ready to merge again.`,
  ].join('\n');
}
