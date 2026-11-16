import { useEffect, useState } from 'react';
import type { ThreadItem } from '@shared/types';
import { estimateTokens, fmtTokens } from '../tokens';
import { useBackgroundWork } from '../threadStatus';
import { parseToolStep } from '../toolStep';

/**
 * Shared animated Olympus Coder brand mark: the erupting volcano, curly-brace cloud,
 * and streaming code token bars used in `WorkingIndicator`, `BackgroundBar`, and `WorkGroup`.
 */
export function BrandWorkingMark({ calm, compact }: { calm?: boolean; compact?: boolean }) {
  return (
    <>
      {/* In the same rounded box as an agent's logo (AgentLogo, 22px), so both marks read as one set. */}
      <span className="agent-logo wb-mark-box" style={{ width: 22, height: 22 }} aria-hidden>
        <svg className={`wb-mark ${calm ? 'calm' : ''} ${compact ? 'compact' : ''}`} width={16} height={13} viewBox="4 12 92 74" aria-hidden>
          <path
            className="wb-volcano"
            d="M 7 83 C 18.4 78.55 32.65 48.29 35.5 38.5 L 41.8 38.5 L 41.8 39.7 A 8.2 8.2 0 0 0 58.2 39.7 L 58.2 38.5 L 64.5 38.5 C 67.35 48.29 81.6 78.55 93 83 Z"
          />
          <circle className="wb-glow" cx="50" cy="39.7" r="5.8" />
          <path
            className="wb-cloud"
            pathLength="100"
            d="M 25 27 C 25 21.5 25 21.5 33 21.5 L 42 21.5 C 48.5 21.5 50 16 50 16 C 50 16 51.5 21.5 58 21.5 L 67 21.5 C 75 21.5 75 21.5 75 27"
          />
          <circle className="wb-ball" cx="50" cy="39.7" r="5.8" />
        </svg>
      </span>
      <span className={`wb-code ${calm ? 'calm' : ''} ${compact ? 'compact' : ''}`} aria-hidden>
        {compact ? (
          <>
            <i className="k" style={{ width: 10, animationDelay: '0s' }} />
            <i className="t" style={{ width: 15, animationDelay: '.12s' }} />
            <i className="s" style={{ width: 8, animationDelay: '.24s' }} />
          </>
        ) : calm ? (
          <>
            <i className="k" style={{ width: 12, animationDelay: '0s' }} />
            <i className="t" style={{ width: 18, animationDelay: '.2s' }} />
            <i className="s" style={{ width: 9, animationDelay: '.4s' }} />
          </>
        ) : (
          <>
            <i className="k" style={{ width: 14, animationDelay: '0s' }} />
            <i className="t" style={{ width: 22, animationDelay: '.1s' }} />
            <i className="s" style={{ width: 10, animationDelay: '.2s' }} />
            <i className="t" style={{ width: 18, animationDelay: '.3s' }} />
            <i className="k" style={{ width: 8, animationDelay: '.4s' }} />
          </>
        )}
      </span>
    </>
  );
}

/**
 * "The agent is working" at the bottom of a running chat when no live `WorkGroup`
 * is currently anchoring the active tail (for example right after sending a prompt
 * or while streaming a visible agent reply).
 */
export function WorkingIndicator({ items, agentName }: { items: ThreadItem[]; agentName: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  let lastUser = -1;
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user') ((lastUser = i), (i = -1));
  const turn = items.slice(lastUser + 1);
  const since = lastUser >= 0 ? items[lastUser].ts : Date.now();
  const secs = Math.max(0, Math.round((Date.now() - since) / 1000));
  const last = [...turn].reverse().find((i) => i.kind !== 'plan');
  const waitingPerm = turn.some((i) => i.kind === 'permission' && !i.resolved);
  const waitingAnswer = turn.some((i) => i.kind === 'elicitation' && !i.resolved);
  const tool = [...turn].reverse().find((i) => i.kind === 'tool' && (i.status === 'in_progress' || i.status === 'pending'));
  const written = estimateTokens(turn);

  let text: string;
  if (waitingPerm) text = 'Waiting for your approval';
  else if (waitingAnswer) text = 'Waiting for your answer';
  else if (!last) text = secs < 6 ? `Sending to ${agentName}…` : `Waiting for ${agentName} to start…`;
  else if (tool && tool.kind === 'tool') {
    const p = parseToolStep(tool);
    if (p.isCommand) text = p.toolLabel === 'Terminal' ? 'Running in terminal…' : 'Running command…';
    else if (p.headerTitle) text = `${p.toolLabel} · ${p.headerTitle}`;
    else text = `Running ${p.toolLabel}…`;
  } else if (last.kind === 'thought') text = 'Thinking…';
  else if (last.kind === 'agent') text = 'Writing the reply…';
  else if (last.kind === 'tool') text = 'Working out the next step…';
  else text = 'Working…';

  return (
    <div className={`working-brand ${waitingPerm || waitingAnswer ? 'paused' : ''}`} role="status" aria-live="polite">
      <BrandWorkingMark />
      <span className="wb-text shimmer ellipsis">{text}</span>
      <span className="wb-meta">
        {secs}s{written > 0 ? ` · ≈${fmtTokens(written)} tokens` : ''}
      </span>
    </div>
  );
}

/**
 * After a turn ends, work it left running (a command in the agent's background, a terminal it opened) shows
 * here, quieter than the working indicator, with View to open the Tasks tab.
 */
export function BackgroundBar({ threadId }: { threadId: string }) {
  const { procs, tools } = useBackgroundWork(threadId);
  const count = Math.max(procs.length, tools);
  if (!count) return null;
  const names = procs
    .map(
      (p) =>
        p.title
          .split('\n')[0]
          .replace(/^(bash|sh|zsh|python3?|node) +/, '')
          .split('/')
          .pop() ?? p.title,
    )
    .slice(0, 3);
  const cpu = procs.reduce((a, p) => a + (Number.isFinite(p.cpu) ? p.cpu : 0), 0);
  return (
    <div className="working-brand bg-bar" role="status">
      <BrandWorkingMark calm />
      <span className="wb-text ellipsis">
        {count} running in the background
        {names.length ? ` · ${names.join(' · ')}` : ''}
      </span>
      {procs.length > 0 && <span className="wb-meta">CPU {Math.round(cpu)}%</span>}
      <button className="btn ghost small bg-view" onClick={() => window.dispatchEvent(new CustomEvent('olympus:show-tasks'))}>
        View
      </button>
    </div>
  );
}
