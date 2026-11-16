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

// ---- set_timer: an olympus MCP tool every session has ----

export const TIMER_MAX_MINUTES = 1440;
const TIMERS_PER_CHAT = 20;

/** Kept small: agy silently disables MCP tools with large declarations (see toolsFor in orchestrator.ts). */
export const setTimerToolDef = {
  name: 'set_timer',
  title: 'Set timer',
  description: 'Wake this chat later with "[Olympus Coder] Timer: <note>", e.g. to check work you left running. Olympus does not tell you when background work ends.',
  inputSchema: {
    type: 'object',
    properties: {
      minutes: { type: 'number', minimum: 1, maximum: TIMER_MAX_MINUTES, description: 'Delay, 1–1440.' },
      note: { type: 'string', description: 'What to do then.' },
    },
    required: ['minutes', 'note'],
    additionalProperties: false,
  },
};

/** Checked arguments of set_timer; throws a message for the agent. */
export function parseTimerArgs(args: any): { minutes: number; note: string } {
  const minutes = Number(args?.minutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > TIMER_MAX_MINUTES) throw new Error(`"minutes" must be a number from 1 to ${TIMER_MAX_MINUTES}.`);
  const note = String(args?.note ?? '').replace(/\s+/g, ' ').trim();
  if (!note) throw new Error('"note" is required: say what to check when the timer fires.');
  return { minutes, note: note.slice(0, 600) };
}

let timerSeq = 0;
/** Starts a timer for the chat; when due, the message goes out now or after the agent's current turn. */
export function setTimer(threadId: string, minutes: number, note: string): string {
  const own = [...timers.keys()].filter((k) => k.startsWith(`${threadId}:timer:`)).length;
  if (own >= TIMERS_PER_CHAT) throw new Error(`This chat already has ${TIMERS_PER_CHAT} timers waiting.`);
  const key = `${threadId}:timer:${++timerSeq}`;
  const due = Date.now() + minutes * 60_000;
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      // The user pressed Stop in this chat: stay quiet (dropWakes also clears these).
      if (isMuted(threadId)) return;
      notifyAgent(threadId, `[Olympus Coder] Timer: ${note}`);
    }, minutes * 60_000),
  );
  return `Timer set: this chat gets "[Olympus Coder] Timer: ${note}" at ${new Date(due).toLocaleTimeString()} (in ${minutes} min). Timers end if Olympus Coder quits.`;
}
