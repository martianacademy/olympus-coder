import type { SubTaskView } from '@shared/types';

/**
 * Disposable sub-sessions (spawn_subsession without `keep: true`): deleted automatically once ALL hold —
 * it finished (done / failed / cancelled; a quota-exceeded or needs-login one stays so the parent can switch its
 * agent), the parent read that final report (wait_for_subsessions, or get_subsession after it finished), and the
 * parent's turn has ended. message_subsession / configure_subsession before that cancel it for that round.
 */
export const DISPOSABLE_DONE = new Set<SubTaskView['status']>(['done', 'failed', 'cancelled']);

export interface DisposableCandidate {
  id: string;
  disposable?: boolean;
  status: SubTaskView['status'];
  /** Identifies this finished result ("id@status@resultId"): a new round gives a new key. */
  key: string;
  active: boolean;
}

export class DisposableTracker {
  /** Sub-session id → key of the finished result its parent read. */
  private read = new Map<string, string>();

  /** The parent got this finished report. Only finished, disposable sub-sessions count. */
  markRead(c: Pick<DisposableCandidate, 'id' | 'disposable' | 'status' | 'key'>): void {
    if (c.disposable && DISPOSABLE_DONE.has(c.status)) this.read.set(c.id, c.key);
  }

  /** A follow-up went out (message / configure): this round is no longer up for deletion. */
  reset(id: string): void {
    this.read.delete(id);
  }

  get size(): number {
    return this.read.size;
  }

  forget(id: string): void {
    this.read.delete(id);
  }

  /** Ids to delete now; call only when the parent's turn has ended. */
  due(children: DisposableCandidate[]): string[] {
    return children
      .filter((c) => c.disposable && !c.active && DISPOSABLE_DONE.has(c.status) && this.read.get(c.id) === c.key)
      .map((c) => c.id);
  }
}
