import { isMuted, notifyAgent } from './appmsg';
import { runState } from './agents';

/**
 * Agent self wake-ups. Some agents can schedule themselves to look again later (Antigravity's `schedule` tool:
 * "in 145 s, read the log"). Over ACP an agent can only act inside a turn, so once its turn has ended the
 * timer fires into nothing and its next command waits until someone sends a message — it looks stuck. The app
 * keeps those timers instead: when one is due and the agent is idle, it sends the agent a short message, which
 * opens the turn it needs.
 */

const MAX_DELAY = 24 * 3_600_000;
const timers = new Map<string, NodeJS.Timeout>();
/** Tool calls already turned into a wake-up (agents re-send the same call when its timer completes). */
const seen = new Set<string>();

/** The delay and the note of a scheduling tool call, if this is one (any agent, any key casing). */
export function scheduleOf(rawTitle: string | undefined, rawInput: any): { ms: number; note: string } | undefined {
  if (!rawInput || typeof rawInput !== 'object') return undefined;
  const lower = Object.fromEntries(Object.entries(rawInput).map(([k, v]) => [k.toLowerCase(), v]));
  const secs = Number(lower.durationseconds ?? lower.delayseconds ?? lower.seconds ?? NaN);
  const named = /\b(schedule|wake ?up|timer)\b/i.test(rawTitle ?? '');
  if (!named || !Number.isFinite(secs) || secs <= 0) return undefined;
  const note = String(lower.prompt ?? lower.reason ?? lower.message ?? '').trim();
  return { ms: Math.min(MAX_DELAY, secs * 1000), note };
}

/** Remembers an agent's wake-up, once per tool call. */
export function keepWake(threadId: string, toolCallId: string, ms: number, note: string) {
  const key = `${threadId}:${toolCallId}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > 5000) seen.clear();
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      // The user pressed Stop in this chat: stay quiet. Busy right now: the agent is already working.
      if (isMuted(threadId) || runState(threadId).running) return;
      notifyAgent(
        threadId,
        `[Olympus Coder] Your scheduled wake-up is due${note ? `: "${note.slice(0, 600)}"` : ''}. Carry on with it now. (Between turns you can't act on your own, so the app sends this message when a timer you set is due.)`,
      );
    }, ms + 3000),
  );
}

/** Drops a chat's wake-ups (chat deleted or stopped by the user). */
export function dropWakes(threadId: string) {
  for (const [k, t] of timers) if (k.startsWith(`${threadId}:`)) (clearTimeout(t), timers.delete(k));
}
