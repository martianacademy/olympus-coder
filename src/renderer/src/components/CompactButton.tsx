import { useEffect, useState } from 'react';
import { Loader2, Shrink } from 'lucide-react';
import type { SessionView, ThreadItem } from '@shared/types';
import type { PromptQueueView } from '@shared/promptQueue';
import { contextFraction, contextLevel } from '../contextLevel';
import { promptQueueApi } from '../promptQueueApi';

/** The slash command that compacts an agent's context (Claude Code and Codex both name it `compact`). */
const COMPACT = '/compact';
const DONE = new Set(['completed', 'failed', 'cancelled']);
const TIP = 'Summarizes the conversation so far to free up context. Uses some tokens once; later messages get cheaper.';

export const canCompact = (session: SessionView | null | undefined) => Boolean(session?.commands.some((c) => c.name === 'compact'));

/** True while this chat's agent is compacting: its running turn is a `/compact`, or it reports a compaction in progress. */
export function isCompacting(items: ThreadItem[], running: boolean): boolean {
  if (!running) return false;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'compaction' && !DONE.has(it.status)) return true;
    if (it.kind === 'user' && !it.viaAgent) return it.text.trim() === COMPACT;
  }
  return false;
}

/**
 * "Compact context": sends `/compact` through the normal send path, so a busy chat queues it (with ticks).
 * Shown only when the chat's agent advertises a `compact` command.
 */
export function CompactButton(props: {
  threadId: string;
  session: SessionView | null | undefined;
  /** From `isCompacting` (the thread's items). */
  compacting: boolean;
  queue: PromptQueueView | null;
  /** `full`: labelled button (Info panel), with a calm notice under it when the context is red.
   *  `chip`: next to the composer's context ring — a quiet icon at green, a yellow / red chip (`contextLevel`). */
  variant: 'full' | 'chip';
}) {
  const { threadId, session, compacting, variant } = props;
  const queued = Boolean(props.queue?.items.some((q) => q.text.trim() === COMPACT));
  const [sending, setSending] = useState(false);
  // The click is "in flight" until the queue or the thread shows it (or a few seconds pass).
  useEffect(() => {
    if (!sending) return;
    if (queued || compacting) return setSending(false);
    const t = setTimeout(() => setSending(false), 4000);
    return () => clearTimeout(t);
  }, [sending, queued, compacting]);
  if (!canCompact(session)) return null;

  const busy = sending || queued || compacting;
  const fill = contextFraction(session?.usage);
  const lvl = contextLevel(fill ?? 0);
  const label = compacting ? 'Compacting…' : queued ? 'Compact queued' : 'Compact context';
  const tip = queued ? `${TIP} Queued — it runs when the current reply ends.` : TIP;
  const click = () => {
    if (busy) return;
    setSending(true);
    void promptQueueApi.submit(threadId, COMPACT).catch(() => setSending(false));
  };
  const icon = busy ? <Loader2 size={variant === 'full' ? 14 : 13} className="spin" /> : <Shrink size={variant === 'full' ? 14 : 13} />;

  if (variant === 'full')
    return (
      <>
        <button type="button" className={`btn small compact-btn ctx-${lvl}`} disabled={busy} title={tip} onClick={click} data-testid="compact-context" data-level={lvl}>
          {icon} {label}
        </button>
        {lvl === 'red' && fill !== null && !busy && (
          <div className="compact-notice" role="status" data-testid="compact-notice">
            <span>
              Context is {Math.round(fill * 100)}% full. Compact now to keep replies fast and use fewer tokens.
            </span>
            <button type="button" className="link-btn" onClick={click} data-testid="compact-notice-action">
              Compact now
            </button>
          </div>
        )}
      </>
    );
  const hint = lvl !== 'green';
  return (
    <button
      type="button"
      className={`compact-chip ctx-${lvl} ${hint || busy ? 'labelled' : ''}`}
      disabled={busy}
      title={`${label} — ${tip}`}
      aria-label={label}
      onClick={click}
      data-testid="compact-chip"
      data-level={lvl}
    >
      {icon}
      {(hint || busy) && <span>{compacting ? 'Compacting…' : queued ? 'Queued' : 'Compact'}</span>}
    </button>
  );
}
