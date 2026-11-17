import type { SubTaskView } from '@shared/types';

/**
 * Telling a parent session the moment its sub-sessions finish (src/main/orchestrator.ts `maybeWake`).
 * Pure helpers, free of Electron, so they can be unit-tested (tests/subsessionNotify.unit.mjs).
 */

export const LIVE_STATES = new Set<SubTaskView['status']>(['starting', 'running', 'waiting-permission']);

/** Identifies one finished result of a sub-session: a new round (message_subsession) gives a new key. */
export const doneKey = (v: Pick<SubTaskView, 'resultId' | 'endedAt'> & { meta: { id: string } }) => `${v.meta.id}@${v.resultId ?? v.endedAt ?? 0}`;

/**
 * Finished results the parent has not had yet: finished in this run of the app (seen / sent are kept in memory, so
 * after a restart old results would otherwise arrive again), not read by the parent (wait_for_subsessions,
 * get_subsession), not sent already, and not a target of a wait_for_subsessions call the parent is inside right now
 * (that call returns the result itself; sending it as well would say it twice).
 */
export function pickFresh(
  views: SubTaskView[],
  o: { seen: Set<string>; sent: Set<string>; waitingFor: Set<string>; appStarted: number },
): SubTaskView[] {
  return views.filter(
    (v) => !LIVE_STATES.has(v.status) && v.endedAt && v.endedAt > o.appStarted && !o.seen.has(doneKey(v)) && !o.sent.has(doneKey(v)) && !o.waitingFor.has(v.meta.id),
  );
}

export type Delivery = 'turn' | 'steer' | 'later';

/**
 * How a result reaches the parent now: a new turn when it is idle; into its running turn when its agent takes
 * mid-turn input (ACP `_session/steering`); otherwise `later` — nothing now, the parent's turn end looks again
 * (by then it may have read the result itself, so nothing is said twice). A muted chat (the user pressed Stop)
 * gets nothing until the user writes again.
 */
export function decideDelivery(p: { busy: boolean; canSteer: boolean; muted: boolean }): Delivery | 'none' {
  if (p.muted) return 'none';
  if (!p.busy) return 'turn';
  return p.canSteer ? 'steer' : 'later';
}

export const REPORT_CAP = 1500;
export const FILES_CAP = 10;

/** The report, cut at a line boundary under `cap` characters. `full` = nothing was cut. */
export function capReport(text: string, cap = REPORT_CAP): { text: string; full: boolean } {
  const t = text.trim();
  if (t.length <= cap) return { text: t, full: true };
  const cut = t.slice(0, cap);
  const nl = cut.lastIndexOf('\n');
  // A single huge line: cut at the last space instead, so a word is never split.
  const at = nl > cap * 0.5 ? nl : Math.max(cut.lastIndexOf(' '), Math.floor(cap * 0.8));
  return { text: cut.slice(0, at).trimEnd(), full: false };
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export interface FinishedInfo {
  id: string;
  title: string;
  status: SubTaskView['status'];
  agent: string;
  model?: string;
  /** Time of this round: from its task message to its result. */
  durationMs?: number;
  files: string[];
  /** The whole final reply (or the error text for a failed one). */
  report?: string;
  /** Quota-exceeded / needs-login: which agents can take over. */
  fallback?: string;
}

const STATUS_LABEL: Partial<Record<SubTaskView['status'], string>> = { idle: 'ended without a reply', cancelled: 'cancelled' };

/**
 * One message for every result that finished together. `fullReport` lists the ids whose whole report is in it
 * (they count as read, like get_subsession, so a disposable one can go after the parent's turn).
 */
export function buildResultMessage(done: FinishedInfo[], running: { id: string; title: string }[]): { text: string; fullReport: string[] } {
  const fullReport: string[] = [];
  const blocks = done.map((d) => {
    const lines = [`### "${d.title}" — ${STATUS_LABEL[d.status] ?? d.status}`];
    lines.push([`id: ${d.id}`, `agent: ${d.agent}${d.model ? ` (${d.model})` : ''}`, d.durationMs !== undefined ? `time: ${fmtDuration(d.durationMs)}` : ''].filter(Boolean).join(' · '));
    if (d.files.length) {
      const more = d.files.length > FILES_CAP ? ` +${d.files.length - FILES_CAP} more` : '';
      lines.push(`files changed (${d.files.length}): ${d.files.slice(0, FILES_CAP).join(', ')}${more}`);
    } else lines.push('files changed: none');
    const label = d.status === 'failed' || d.status === 'quota-exceeded' || d.status === 'needs-login' ? 'error' : 'report';
    if (d.report?.trim()) {
      const r = capReport(d.report);
      lines.push(`${label}:\n${r.text}${r.full ? '' : `\n…full report: get_subsession ${d.id}`}`);
      if (r.full) fullReport.push(d.id);
    } else {
      lines.push(`${label}: (none)`);
      fullReport.push(d.id);
    }
    if (d.fallback) lines.push(`fallback: ${d.fallback} Switch it in place (keeping its context) with configure_subsession or message_subsession passing "agent"/"model".`);
    return lines.join('\n');
  });
  const head = done.length === 1 ? `[Olympus Coder] Sub-session "${done[0].title}" finished.` : `[Olympus Coder] ${done.length} sub-sessions finished.`;
  const tail = running.length
    ? `Still running: ${running.map((r) => `"${r.title}" (id ${r.id})`).join(', ')}. Olympus will message you when they finish too.`
    : 'No other sub-sessions are running.';
  const advice = 'Verify the parts that matter yourself, then continue with any work that no longer waits on the others.';
  return { text: `${head}\n\n${blocks.join('\n\n')}\n\n${tail} ${advice}`, fullReport };
}
