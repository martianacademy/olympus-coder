import type { RunningTask } from '@shared/types';
import { runState } from './agents';
import { notifyAgent } from './appmsg';
import { runningTasks } from './processes';
import { findThread, getSettings } from './store';
import { readTerminal } from './terminals';

/**
 * Tells an agent when work it started has finished: a command in a terminal it opened with run_in_terminal,
 * or a command it left running in its own background. Only jobs that ran at least ~10 seconds count (the
 * agent handles quick ones itself), and not while the agent is still in the very turn that started the job
 * (it is watching). The message waits in the queue if the agent is busy (appmsg.ts).
 * Off by default (Settings → General, `notifyAgentsWhenWorkEnds`): agents check their own commands. Sub-session
 * results have their own setting (`notifyParentOnSubsessionEnd`, on by default; orchestrator.ts `maybeWake`).
 */

interface Job {
  threadId: string;
  task: RunningTask;
  firstSeen: number;
  misses: number;
  /** The chat's latest message when the job was first seen: "still the same turn" test. */
  turn?: string;
}

const MIN_RUN = 10_000;
const jobs = new Map<string, Job>();

const lastUserId = (threadId: string) => {
  const items = findThread(threadId)?.items ?? [];
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user') return items[i].id;
  return undefined;
};

const fmt = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

function describe(j: Job): string {
  const ran = fmt(Date.now() - j.firstSeen);
  if (j.task.source === 'terminal' && j.task.ptyId) {
    let tail = '';
    try {
      tail = readTerminal(j.task.ptyId, 25).split('--- last 25 lines ---\n')[1] ?? '';
    } catch {
      /* terminal closed */
    }
    return `The command in terminal "${j.task.title}" (${j.task.ptyId}) finished after about ${ran}.${tail.trim() ? ` Its last lines:\n\`\`\`text\n${tail.trim()}\n\`\`\`` : ''}`;
  }
  return `The command you left running finished after about ${ran}: \`${j.task.title.split('\n')[0].slice(0, 200)}\`.`;
}

/** One check (every 3 s via startJobWatch; exported for the unit test). */
export async function tick() {
  if (!getSettings().notifyAgentsWhenWorkEnds) {
    if (jobs.size) jobs.clear();
    return;
  }
  const tasks = (await runningTasks().catch(() => [] as RunningTask[])).filter((t) => t.threadId);
  const now = Date.now();
  const seen = new Set<string>();
  for (const t of tasks) {
    seen.add(t.id);
    const j = jobs.get(t.id);
    if (j) {
      j.task = t;
      j.misses = 0;
    } else jobs.set(t.id, { threadId: t.threadId!, task: t, firstSeen: now - t.secs * 1000, misses: 0, turn: lastUserId(t.threadId!) });
  }
  const finished = new Map<string, Job[]>();
  for (const [id, j] of jobs) {
    if (seen.has(id)) continue;
    // Gone twice in a row (a loop's children come and go between polls).
    if (++j.misses < 2) continue;
    jobs.delete(id);
    if (now - j.firstSeen < MIN_RUN) continue;
    if (runState(j.threadId).running && lastUserId(j.threadId) === j.turn) continue; // the agent is still on it
    // An agent's own background command: only when its tool card is still open. Agents that track their
    // background work themselves (Claude Code tells itself when one ends) close the card at once.
    if (j.task.source === 'agent') {
      const item = findThread(j.threadId)?.items.find((i) => i.id === j.task.toolItemId);
      if (!item || item.kind !== 'tool' || (item.status !== 'in_progress' && item.status !== 'pending')) continue;
    }
    finished.set(j.threadId, [...(finished.get(j.threadId) ?? []), j]);
  }
  for (const [threadId, list] of finished) {
    const body = list.map(describe).join('\n\n');
    notifyAgent(threadId, `[Olympus Coder] ${body}\n\nCheck the result and carry on with what you told the user you would do next; if nothing more is needed, give the user a short update.`);
  }
}

export function startJobWatch() {
  setInterval(() => void tick(), 3000).unref?.();
}
