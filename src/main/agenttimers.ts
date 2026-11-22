import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isMuted, notifyAgent } from './appmsg';
import { runState } from './agents';

/**
 * Agent self wake-ups. Some agents can schedule themselves to look again later (Antigravity's `schedule` tool:
 * "in 145 s, read the log"). Over ACP an agent can only act inside a turn, so once its turn has ended the
 * timer fires into nothing and its next command waits until someone sends a message — it looks stuck. The app
 * keeps those timers instead (and persists them to `<userData>/agent-timers.json` across restarts): when one is
 * due and the agent is idle, it sends the agent a short message, which opens the turn it needs.
 */

export interface SavedAgentTimer {
  key: string;
  threadId: string;
  kind: 'wake' | 'timer';
  dueAt: number;
  note: string;
}

const MAX_DELAY = 24 * 3_600_000;
const STALE_OVERDUE_MS = 24 * 3_600_000;
const RESTART_SETTLE_MS = 2000;
const timers = new Map<string, NodeJS.Timeout>();
const entries = new Map<string, SavedAgentTimer>();
/** Tool calls already turned into a wake-up (agents re-send the same call when its timer completes). */
const seen = new Set<string>();
let storeFile: string | undefined;

function persistEntries() {
  if (!storeFile) return;
  try {
    if (!entries.size) {
      rmSync(storeFile, { force: true });
      return;
    }
    mkdirSync(dirname(storeFile), { recursive: true });
    const tmp = `${storeFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify([...entries.values()], null, 2), { mode: 0o600 });
    renameSync(tmp, storeFile);
  } catch {
    /* best effort */
  }
}

function fireEntry(entry: SavedAgentTimer) {
  timers.delete(entry.key);
  entries.delete(entry.key);
  persistEntries();
  if (entry.kind === 'wake') {
    // The user pressed Stop in this chat: stay quiet. Busy right now: the agent is already working.
    if (isMuted(entry.threadId) || runState(entry.threadId).running) return;
    notifyAgent(
      entry.threadId,
      `[Olympus Coder] Your scheduled wake-up is due${entry.note ? `: "${entry.note.slice(0, 600)}"` : ''}. Carry on with it now. (Between turns you can't act on your own, so the app sends this message when a timer you set is due.)`,
    );
    return;
  }
  if (isMuted(entry.threadId)) return;
  notifyAgent(entry.threadId, `[Olympus Coder] Timer: ${entry.note}`);
}

function armEntry(entry: SavedAgentTimer, minDelayMs = 0) {
  const prev = timers.get(entry.key);
  if (prev) clearTimeout(prev);
  entries.set(entry.key, entry);
  const delay = Math.max(minDelayMs, entry.dueAt - Date.now());
  timers.set(
    entry.key,
    setTimeout(() => fireEntry(entry), delay),
  );
}

/**
 * Configures disk persistence for pending timers and restores any unexpired timers from the previous app run.
 * Timers whose chat was deleted or that expired more than 24 h ago are pruned cleanly.
 */
export function restoreAgentTimers(filePath: string, threadExists: (threadId: string) => boolean = () => true): number {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  entries.clear();
  storeFile = filePath;
  if (!existsSync(filePath)) return 0;
  let list: SavedAgentTimer[] = [];
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    if (Array.isArray(raw)) list = raw;
  } catch {
    rmSync(filePath, { force: true });
    return 0;
  }
  const now = Date.now();
  let restored = 0;
  for (const item of list) {
    if (!item || typeof item.key !== 'string' || typeof item.threadId !== 'string' || typeof item.dueAt !== 'number') continue;
    if (item.kind !== 'wake' && item.kind !== 'timer') continue;
    if (!threadExists(item.threadId) || now - item.dueAt > STALE_OVERDUE_MS) continue;
    if (item.kind === 'wake') seen.add(item.key);
    const m = /^.+:timer:(\d+)$/.exec(item.key);
    if (m) timerSeq = Math.max(timerSeq, Number(m[1]));
    armEntry({ key: item.key, threadId: item.threadId, kind: item.kind, dueAt: item.dueAt, note: String(item.note ?? '').slice(0, 600) }, RESTART_SETTLE_MS);
    restored++;
  }
  persistEntries();
  return restored;
}

/** Stops in-memory Node timeouts on app shutdown while leaving `agent-timers.json` intact for the next launch. */
export function pauseAgentTimersForQuit() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

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
  const delay = ms + 3000;
  armEntry({ key, threadId, kind: 'wake', dueAt: Date.now() + delay, note: note.slice(0, 600) });
  persistEntries();
}

/** Drops a chat's wake-ups (chat deleted or stopped by the user). */
export function dropWakes(threadId: string) {
  let changed = false;
  for (const [k, t] of timers) {
    if (k.startsWith(`${threadId}:`)) {
      clearTimeout(t);
      timers.delete(k);
      changed = true;
    }
  }
  for (const k of [...entries.keys()]) {
    if (k.startsWith(`${threadId}:`)) {
      entries.delete(k);
      changed = true;
    }
  }
  if (changed) persistEntries();
}

// ---- set_timer: an olympus MCP tool every session has ----

export const TIMER_MAX_MINUTES = 1440;
const TIMERS_PER_CHAT = 20;

/** Kept small: agy silently disables MCP tools with large declarations (see toolsFor in orchestrator.ts). */
export const setTimerToolDef = {
  name: 'set_timer',
  title: 'Set timer',
  description: 'Wake this chat later with "[Olympus Coder] Timer: <note>", e.g. to check a terminal or background command you left running (Olympus does not tell you when those end; sub-session results arrive by themselves).',
  inputSchema: {
    type: 'object',
    properties: {
      minutes: { type: 'number', minimum: 1, maximum: TIMER_MAX_MINUTES, description: 'Delay, 1–1440.' },
      note: { type: 'string', description: 'What to do then.' },
    },
    required: ['minutes', 'note'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
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
  const own = [...entries.keys()].filter((k) => k.startsWith(`${threadId}:timer:`)).length;
  if (own >= TIMERS_PER_CHAT) throw new Error(`This chat already has ${TIMERS_PER_CHAT} timers waiting.`);
  const key = `${threadId}:timer:${++timerSeq}`;
  const due = Date.now() + minutes * 60_000;
  armEntry({ key, threadId, kind: 'timer', dueAt: due, note });
  persistEntries();
  return `Timer set: this chat gets "[Olympus Coder] Timer: ${note}" at ${new Date(due).toLocaleTimeString()} (in ${minutes} min; persisted across restarts).`;
}
