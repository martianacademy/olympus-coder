import type { SubTaskView, ThreadItem } from '@shared/types';

/**
 * Pure helpers for how a sub-session's outcome is judged and reported to the orchestrator (src/main/orchestrator.ts).
 * Kept free of Electron so they can be unit-tested (tests/subtaskOutcome.unit.mjs).
 */

/** A user item that opens an agent's own turn or echoes its session, not a task from the user / orchestrator. */
export const isSideTurn = (i: ThreadItem): boolean =>
  i.kind === 'user' && Boolean(i.agentInitiated || i.viaAgent || (i.fromApp && i.text === 'Agent-initiated work'));

/** Index of the last real task message (from the user or the orchestrator), or -1. */
export function lastTaskIndex(items: ThreadItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user' && !isSideTurn(items[i])) return i;
  return -1;
}

/**
 * The item that stands for a finished task's outcome: its latest error when that came after its latest reply,
 * else its latest reply, else the task message itself. Later maintenance turns (compaction) don't change it.
 */
export function resultItem(items: ThreadItem[]): ThreadItem | undefined {
  const start = lastTaskIndex(items);
  const after = items.slice(start + 1);
  const a = after.map((i) => i.kind).lastIndexOf('agent');
  const e = after.map((i) => i.kind).lastIndexOf('error');
  return e >= 0 && e > a ? after[e] : a >= 0 ? after[a] : start >= 0 ? items[start] : undefined;
}

/** One line about what a finished sub-session produced, for the wake-up message. */
export function outcomeLine(v: SubTaskView): string {
  const first = (t?: string) => (t ?? '').replace(/\*\*/g, '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 180) ?? '';
  const files = v.filesTouched.length ? ` · ${v.filesTouched.length} file${v.filesTouched.length === 1 ? '' : 's'} changed` : '';
  if (v.status === 'failed') return `failed: ${first(v.error) || 'no error text'}${files}`;
  if (v.status === 'cancelled') return `stopped${files}`;
  if (v.status === 'idle') return `ended without a reply${files}`;
  return `${v.status}: ${first(v.lastReply) || 'no reply text'}${files}`;
}
