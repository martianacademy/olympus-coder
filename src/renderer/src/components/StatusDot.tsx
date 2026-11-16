import { statusLabel, useStatusCounts, useThreadStatus, type ThreadStatus } from '../threadStatus';

/** A chat's state, just left of the agent logo in its sidebar row: spinning (working), amber (needs approval), red (error), green (finished, unread). */
export function StatusDot({ threadId, edge }: { threadId: string; edge?: boolean }) {
  const s = useThreadStatus(threadId);
  if (!s) return null;
  // Just left of the agent's logo (in the row's chevron slot), so it reads as that agent's state.
  return (
    <span className={`status-slot ${edge ? 'edge' : ''}`}>
      <span className={`status-dot s-${s}`} title={statusLabel(s)} aria-label={statusLabel(s)} />
    </span>
  );
}

const ORDER: NonNullable<ThreadStatus>[] = ['waiting', 'error', 'running', 'background', 'done'];
const PLURAL: Record<NonNullable<ThreadStatus>, string> = {
  waiting: 'waiting for you',
  error: 'stopped with an error',
  running: 'working',
  background: 'running in the background',
  done: 'finished, not opened yet',
};

/** A project's sessions at a glance: one small dot + count per state (approval first, then errors, working …). */
export function StatusCounts({ threadIds }: { threadIds: string[] }) {
  const counts = useStatusCounts(threadIds);
  const shown = ORDER.filter((s) => counts[s]);
  if (!shown.length) return null;
  return (
    <span className="status-counts" title={shown.map((s) => `${counts[s]} ${PLURAL[s]}`).join('\n')}>
      {shown.map((s) => (
        <span key={s} className={`sc s-${s}`}>
          <span className={`status-dot s-${s}`} />
          {counts[s]}
        </span>
      ))}
    </span>
  );
}
