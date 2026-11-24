import { memo, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, CircleSlash, Flame, ShieldAlert } from 'lucide-react';
import type { AgentDef, MaxDeliberationItem, MaxRoundTrace } from '@shared/types';
import { AgentLogo } from '../logos';
import { useStepChoice } from '../prefs';
import { fmtStepDuration } from '../toolStep';
import { Markdown } from './ChatMarkdown';
import { BrandWorkingMark } from './Working';
import '../maxEffort.css';

function RoundBlock({
  trace,
  solverDef,
  criticDef,
  solverId,
  criticId,
}: {
  trace: MaxRoundTrace;
  solverDef?: AgentDef;
  criticDef?: AgentDef;
  solverId: string;
  criticId: string;
}) {
  const [open, setOpen] = useState(false);
  const label = trace.phase === 'blind' ? 'Round 0 · Parallel blind thinking' : `Round ${trace.round} · Cross-mind critique`;
  const bothConv = trace.solverConverged && trace.criticConverged;
  const anyWatchdog = Boolean(trace.solverWatchdog || trace.criticWatchdog);

  return (
    <div className="max-round" data-testid={`max-round-${trace.round}`}>
      <button type="button" className="max-round-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span style={{ fontWeight: 600 }}>{label}</span>
        {anyWatchdog && (
          <span className="max-delib-badge warn" title="Stuck-Thinking Watchdog rescued a runaway solo loop">
            Watchdog rescue
          </span>
        )}
        {bothConv && <span className="max-delib-badge ok">Converged</span>}
        <span className="grow" />
        <span className="max-delib-meta">{fmtStepDuration(trace.durationMs)}</span>
      </button>
      {open && (
        <div className="max-round-grid">
          <div className="max-mind-col">
            <div className="max-mind-title">
              {solverDef && <AgentLogo def={solverDef} size={16} />}
              <span>Solver · {solverDef?.name ?? solverId}</span>
              {trace.solverWatchdog && <span className="max-delib-badge warn">Watchdog</span>}
              {trace.solverConverged && <span className="max-delib-badge ok">Converged</span>}
            </div>
            {trace.solverThought && (
              <div className="max-thought-box" title="Captured raw thinking / scratchpad">
                {trace.solverThought}
              </div>
            )}
            {trace.solverReply && (
              <div className="max-reply-box msg-agent">
                <Markdown text={trace.solverReply} />
              </div>
            )}
          </div>

          <div className="max-mind-col">
            <div className="max-mind-title">
              {criticDef && <AgentLogo def={criticDef} size={16} />}
              <span>Critic · {criticDef?.name ?? criticId}</span>
              {trace.criticWatchdog && <span className="max-delib-badge warn">Watchdog</span>}
              {trace.criticConverged && <span className="max-delib-badge ok">Converged</span>}
            </div>
            {trace.criticThought && (
              <div className="max-thought-box" title="Captured raw thinking / scratchpad">
                {trace.criticThought}
              </div>
            )}
            {trace.criticReply && (
              <div className="max-reply-box msg-agent">
                <Markdown text={trace.criticReply} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Minimal collapsible Dual-Mind Deliberation card rendered inside `Chat.tsx` for `kind: 'max-deliberation'`.
 * Shows live phase & timer while deliberating, and collapses cleanly into a 1-line expandable summary once finished.
 */
export const MaxEffortCard = memo(function MaxEffortCard({
  item,
  agentDefs,
}: {
  item: MaxDeliberationItem;
  agentDefs: Record<string, AgentDef>;
}) {
  const [choice, setChoice] = useStepChoice(`maxdelib:${item.id}`);
  const open = choice ?? false;
  const running = item.status === 'running';
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);

  const solverDef = agentDefs[item.solverAgentId];
  const criticDef = agentDefs[item.criticAgentId];
  const solverName = solverDef?.name ?? item.solverAgentId;
  const criticName = criticDef?.name ?? item.criticAgentId;
  const elapsed = fmtStepDuration((item.endedAt ?? now) - item.ts);

  const summaryTitle = running
    ? item.phaseLabel
    : item.status === 'cancelled'
      ? `Dual-Mind deliberation stopped · ${solverName} ⇄ ${criticName}`
      : item.status === 'failed'
        ? `Dual-Mind deliberation failed · ${item.error ?? 'error'}`
        : `Dual-Mind deliberation · ${solverName} ⇄ ${criticName} (${item.rounds.length} ${item.rounds.length === 1 ? 'pass' : 'passes'})`;

  const statusIcon = running ? (
    <BrandWorkingMark />
  ) : item.status === 'failed' ? (
    <AlertCircle size={14} style={{ color: 'var(--danger)' }} />
  ) : item.status === 'cancelled' ? (
    <CircleSlash size={14} className="muted" />
  ) : item.converged ? (
    <CheckCircle2 size={14} style={{ color: 'var(--success, #22c55e)' }} />
  ) : (
    <Flame size={14} style={{ color: 'var(--accent)' }} />
  );

  return (
    <div className={`max-delib ${running ? 'is-running' : ''}`} data-testid="max-deliberation-card" data-status={item.status}>
      <button type="button" className="max-delib-head" onClick={() => setChoice(!open)} aria-expanded={open} data-testid="max-delib-toggle">
        {statusIcon}
        <span className={`max-delib-title ${running ? 'shimmer' : ''}`}>{summaryTitle}</span>
        {!running && item.status === 'completed' && (
          <span className={`max-delib-badge ${item.converged ? 'ok' : ''}`}>
            {item.converged ? 'Converged' : 'Max rounds'}
          </span>
        )}
        <span className="max-delib-meta">{elapsed}</span>
        {item.rounds.length > 0 && (open ? <ChevronDown size={13} className="muted" /> : <ChevronRight size={13} className="muted" />)}
      </button>

      {item.error && (
        <div className="max-delib-body" style={{ color: 'var(--danger)', fontSize: 'var(--t-meta)' }}>
          <ShieldAlert size={13} /> {item.error}
        </div>
      )}

      {open && item.rounds.length > 0 && (
        <div className="max-delib-body" data-testid="max-delib-rounds">
          {item.rounds.map((r) => (
            <RoundBlock
              key={`${r.phase}-${r.round}`}
              trace={r}
              solverDef={solverDef}
              criticDef={criticDef}
              solverId={item.solverAgentId}
              criticId={item.criticAgentId}
            />
          ))}
        </div>
      )}
    </div>
  );
});
