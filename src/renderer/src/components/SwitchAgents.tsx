import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { AgentDef, AgentStatus } from '@shared/types';
import { AgentLogo } from '../logos';
import { liveLimits, quotaState } from '../quota';
import { STATE_LABEL } from './AgentPicker';

/** Buttons shown before the rest collapse into "+N". With 3 or fewer agents all of them show. */
const VISIBLE = 2;

const rank = (s?: AgentStatus) => (s?.state === 'ready' ? 0 : s?.state === 'starting' || s?.state === 'authenticating' ? 1 : 2);

/**
 * "Switch to …" actions for the out-of-quota banner. A few agents get their own button; any number more
 * open a searchable list, so ten agents never overflow the banner.
 */
export function SwitchAgents({ agents, statuses, onSwitch }: { agents: AgentDef[]; statuses: Record<string, AgentStatus>; onSwitch: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLSpanElement>(null);
  const sorted = useMemo(() => [...agents].sort((a, b) => rank(statuses[a.id]) - rank(statuses[b.id])), [agents, statuses]);
  const shown = sorted.length <= VISIBLE + 1 ? sorted : sorted.slice(0, VISIBLE);
  const more = sorted.length - shown.length;
  const filtered = sorted.filter((d) => !q.trim() || `${d.name} ${d.description}`.toLowerCase().includes(q.trim().toLowerCase()));

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  if (!sorted.length) return null;
  const pick = (id: string) => {
    setOpen(false);
    onSwitch(id);
  };

  return (
    <span className="quota-actions" ref={ref}>
      {shown.map((d) => (
        <button key={d.id} className="btn small" onClick={() => pick(d.id)} title={`Continue this chat with ${d.name}`}>
          <AgentLogo def={d} size={16} /> Switch to {d.name}
        </button>
      ))}
      {more > 0 && (
        <span className="switch-more">
          <button className={`btn small more-chip ${open ? 'on' : ''}`} onClick={() => setOpen((o) => !o)} title={`${more} more agents`} data-testid="switch-more">
            <span className="more-logos">
              {sorted.slice(VISIBLE, VISIBLE + 3).map((d) => (
                <AgentLogo key={d.id} def={d} size={16} />
              ))}
            </span>
            +{more}
          </button>
          {open && (
            <div className="menu switch-menu">
              <div className="switch-menu-head">Continue this chat with…</div>
              {sorted.length > 6 && (
                <label className="switch-search">
                  <Search size={14} />
                  <input autoFocus placeholder="Search agents" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && filtered[0] && pick(filtered[0].id)} />
                </label>
              )}
              <div className="switch-list">
                {filtered.map((d) => {
                  const s = statuses[d.id];
                  const quota = quotaState(s);
                  const tight = liveLimits(s?.limits).filter((l) => l.utilization >= 0.8);
                  return (
                    <div key={d.id} className="menu-item" onClick={() => pick(d.id)}>
                      <AgentLogo def={d} size={26} />
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="ellipsis" style={{ fontWeight: 550 }}>
                          {d.name}
                        </div>
                        <div className="small muted row" style={{ gap: 5 }}>
                          <span className={`dot ${s?.state ?? 'unknown'}`} />
                          {STATE_LABEL[s?.state ?? 'unknown']}
                          {s?.plan ? ` · ${s.plan}` : ''}
                          {tight.length > 0 && !quota.out && <span className="quota-line low"> · {tight.map((l) => `${l.label} ${Math.round(l.utilization * 100)}%`).join(', ')}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {!filtered.length && <div className="small muted" style={{ padding: '8px 10px' }}>No agent matches “{q}”.</div>}
              </div>
            </div>
          )}
        </span>
      )}
    </span>
  );
}
