import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Settings2 } from 'lucide-react';
import type { AgentsInfo } from '../App';
import { AgentLogo } from '../logos';
import { liveLimits, quotaState } from '../quota';
import { fmtReset } from './Usage';

const STATE_LABEL: Record<string, string> = {
  ready: 'Ready',
  'needs-login': 'Login required',
  authenticating: 'Logging in…',
  'not-installed': 'Not installed',
  error: 'Error',
  starting: 'Starting…',
  unknown: 'Not started',
};

/** The top-left dropdown: pick which coding agent answers in this chat. */
export function AgentPicker({
  agents,
  current,
  onPick,
  onManage,
  onLogin,
}: {
  agents: AgentsInfo;
  current: string;
  onPick: (id: string) => void;
  onManage: () => void;
  onLogin: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const def = agents.defs.find((d) => d.id === current) ?? agents.defs[0];
  const st = def ? agents.statuses[def.id] : undefined;
  if (!def) return null;
  return (
    <div className="picker" ref={ref}>
      <button className="picker-btn" onClick={() => setOpen((o) => !o)} data-testid="agent-picker" title="Switch agent — the chat keeps its history and shared memory">
        <AgentLogo def={def} />
        <span className="picker-name ellipsis" style={{ fontWeight: 600 }}>{def.name}</span>
        <span className={`dot ${st?.state ?? 'unknown'}`} />
        <ChevronDown size={15} className="muted picker-chev" />
      </button>
      {open && (
        <div className="menu">
          {agents.defs.map((d) => {
            const s = agents.statuses[d.id];
            return (
              <div
                key={d.id}
                className={`menu-item ${d.id === current ? 'selected' : ''}`}
                onClick={() => {
                  setOpen(false);
                  if (s?.state === 'not-installed') return onManage();
                  onPick(d.id);
                }}
              >
                <AgentLogo def={d} />
                <div className="grow">
                  <div style={{ fontWeight: 550 }}>{d.name}</div>
                  <div className="small muted row" style={{ gap: 5 }}>
                    <span className={`dot ${s?.state ?? 'unknown'}`} />
                    {STATE_LABEL[s?.state ?? 'unknown']}
                    {s?.version ? ` · v${s.version}` : ''}
                  </div>
                  {(() => {
                    const q = quotaState(s);
                    if (q.out) return <div className="small quota-line out">Quota used up{q.resetsAt ? ` · ${fmtReset(q.resetsAt)}` : ''}</div>;
                    const low = liveLimits(s?.limits).filter((l) => l.utilization >= 0.8);
                    if (low.length) return <div className="small quota-line low">{low.map((l) => `${l.label} ${Math.round(l.utilization * 100)}%`).join(' · ')}</div>;
                    if (q.otherGroupsLeft.length && liveLimits(s?.limits).some((l) => l.utilization >= 0.999)) return <div className="small quota-line low">Only {q.otherGroupsLeft.join(', ')} models have quota</div>;
                    return null;
                  })()}
                </div>
                {s?.state === 'needs-login' && (
                  <button
                    className="btn small primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(false);
                      onLogin(d.id);
                    }}
                  >
                    Login
                  </button>
                )}
                {d.id === current && <Check size={15} />}
              </div>
            );
          })}
          <div className="menu-sep" />
          <div
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            <Settings2 size={16} className="muted" />
            <span>Manage or add agents…</span>
          </div>
        </div>
      )}
    </div>
  );
}

export { STATE_LABEL };
