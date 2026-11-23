/**
 * "The agent woke itself" signals, kept free of imports so the transcript mirror and the agent-initiated turn code
 * (and their unit tests) can report a wake without pulling in the timer store.
 *
 * Why: when an agent schedules a wake-up (Antigravity's `schedule`, Claude's `ScheduleWakeup`), `agenttimers.ts`
 * arms a backup wake a little after the agent's own deadline, for agents/versions that cannot act between turns
 * and for app restarts. Agents that DO wake themselves then got a second "[Olympus Coder] Your scheduled wake-up is
 * due" message a few seconds after their own one. A native wake now cancels the backup it makes redundant.
 */

export interface PendingWake {
  key: string;
  threadId: string;
  kind: 'wake' | 'timer';
  dueAt: number;
  note: string;
}

/** A native wake this close to a backup's due time is the same wake (the backup is armed `WAKE_GRACE_MS` late). */
export const NATIVE_WAKE_WINDOW_MS = 20_000;

type Listener = (threadId: string, text: string) => void;
const listeners = new Set<Listener>();

export function onNativeWake(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reports that the agent of `threadId` started work on its own; `text` is its wake prompt when known. */
export function noteNativeWake(threadId: string, text = ''): void {
  for (const fn of listeners) {
    try {
      fn(threadId, text);
    } catch {
      /* a listener must never break the mirror */
    }
  }
}

/** Shorter texts are too generic to tie a wake prompt to a note. */
const MIN_MATCH = 6;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Keys of the pending backup wakes a native wake makes redundant. With a prompt text: wakes whose note matches it
 * (either one may be cut short, so a prefix either way), plus note-less wakes due soon. Without text: every wake of the chat due soon.
 * `set_timer` timers (`kind: 'timer'`) are never touched: the agent asked Olympus itself for those.
 */
export function wakesSatisfiedBy(entries: Iterable<PendingWake>, threadId: string, text: string, now: number): string[] {
  const said = norm(text);
  const out: string[] = [];
  for (const e of entries) {
    if (e.kind !== 'wake' || e.threadId !== threadId) continue;
    const note = norm(e.note);
    const dueSoon = e.dueAt - now <= NATIVE_WAKE_WINDOW_MS;
    const matches = said.length >= MIN_MATCH && note.length >= MIN_MATCH && (said.startsWith(note) || note.startsWith(said));
    if (matches || ((!said || !note) && dueSoon)) out.push(e.key);
  }
  return out;
}
