import { useEffect, useMemo, useState } from 'react';
import { BarChart3, Gauge, RefreshCw, X } from 'lucide-react';
import type { AgentDef, AgentStatus, ContextUsage, RateLimitView, UsageSummary } from '@shared/types';
import { api } from '../api';
import { AgentLogo } from '../logos';
import { contextLevel } from '../contextLevel';
import { formatLimitsAge, liveLimits } from '../quota';

export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
export const fmtCost = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : '$0');

export function fmtReset(ts?: number) {
  if (!ts) return '';
  const ms = ts - Date.now();
  if (ms <= 0) return 'just reset';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  if (h >= 48) return `resets in ${Math.round(h / 24)} days`;
  return h ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}

const level = (f: number) => (f >= 0.95 ? 'danger' : f >= 0.8 ? 'warning' : 'ok');

/** Small ring next to the send button: how full this session's context window is. */
export function ContextMeter({ usage, onClick }: { usage?: ContextUsage; onClick?: () => void }) {
  if (!usage?.size) return null;
  const f = Math.min(1, usage.used / usage.size);
  const r = 8;
  const c = 2 * Math.PI * r;
  const tip = `Context: ${usage.used.toLocaleString()} / ${usage.size.toLocaleString()} tokens (${Math.round(f * 100)}%)${usage.cost ? ` · session cost ${fmtCost(usage.cost.amount)}` : ''}${usage.model ? ` · ${usage.model}` : ''}`;
  return (
    <button className={`context-meter ctx-${contextLevel(f)}`} title={tip} onClick={onClick} type="button" data-testid="context-meter" data-level={contextLevel(f)}>
      <svg width="20" height="20" viewBox="0 0 20 20">
        <circle cx="10" cy="10" r={r} className="ring-bg" />
        <circle cx="10" cy="10" r={r} className="ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - f)} transform="rotate(-90 10 10)" />
      </svg>
      <span>{f < 0.01 && usage.used > 0 ? '<1' : Math.round(f * 100)}%</span>
    </button>
  );
}

export function Meter({ value, label, right }: { value: number; label: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="meter">
      <div className="row small" style={{ marginBottom: 4 }}>
        <span>{label}</span>
        <span className="spacer" />
        <span className="muted">{right}</span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${level(value)}`} style={{ width: `${Math.max(1.5, value * 100)}%` }} />
      </div>
    </div>
  );
}

export function LimitBars({ limits }: { limits?: RateLimitView[] }) {
  if (!limits?.length) return null;
  // A window past its reset time shows as reset until fresh numbers arrive (see `liveLimits`).
  return (
    <div className="col" style={{ gap: 10 }}>
      {liveLimits(limits).map((l) => (
        <div key={l.window} title={l.note} data-testid="limit-bar" data-window={l.window} data-expired={l.expired ? 'true' : undefined}>
          <Meter
            value={l.utilization}
            label={l.label}
            right={l.expired ? 'Reset · refreshing…' : `${l.utilization >= 0.999 ? 'Used up' : `${Math.round(l.utilization * 100)}% used`}${l.resetsAt ? ` · ${fmtReset(l.resetsAt)}` : ''}`}
          />
        </div>
      ))}
    </div>
  );
}

/** Re-renders every `ms` so relative times ("4 min ago") stay true. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** "Updated 3 min ago" and a small refresh button, under an agent's limits. */
export function LimitsFreshness({ status, agentName, compact }: { status?: AgentStatus; agentName?: string; compact?: boolean }) {
  const now = useNow();
  const [asked, setAsked] = useState(false);
  if (!status || (!status.limitsAt && !status.limits?.length && !status.limitsReadable)) return null;
  const busy = asked || Boolean(status.limitsRefreshing);
  const age = status.limitsRefreshing ? 'Refreshing…' : formatLimitsAge(status.limitsAt, now);
  return (
    <div className={`limits-fresh small muted${compact ? ' compact' : ''}`} data-testid="limits-fresh" data-agent={status.id}>
      <span className="ellipsis" title={status.limitsAt ? `Limits read at ${new Date(status.limitsAt).toLocaleTimeString()}` : undefined}>
        {age}
      </span>
      {status.limitsError && !status.limitsRefreshing && (
        <span className="limits-fresh-err" title={`Last check failed: ${status.limitsError}`}>
          · last check failed
        </span>
      )}
      <button
        type="button"
        className="btn ghost icon tiny"
        data-testid="limits-refresh"
        aria-label={`Refresh ${agentName ?? 'agent'} limits`}
        title={`Refresh ${agentName ?? 'this agent'}'s plan limits now`}
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          setAsked(true);
          void api
            .refreshLimits(status.id)
            .catch(() => {})
            .finally(() => setAsked(false));
        }}
      >
        <RefreshCw size={12} className={busy ? 'spin' : undefined} />
      </button>
    </div>
  );
}

/** Usage page: plan limits per agent, tokens and cost per day, agent and chat. */
export function UsagePage({ defs, statuses, onOpenThread, onClose }: { defs: AgentDef[]; statuses: Record<string, AgentStatus>; onOpenThread: (id: string) => void; onClose?: () => void }) {
  const [days, setDays] = useState(30);
  const [sum, setSum] = useState<UsageSummary | null>(null);
  useEffect(() => {
    void api.usage(days).then(setSum);
  }, [days]);
  useEffect(() => {
    void api.refreshLimits().catch(() => {});
  }, []);
  const defOf = useMemo(() => Object.fromEntries(defs.map((d) => [d.id, d])), [defs]);
  const maxDay = Math.max(1, ...(sum?.byDay ?? []).map((d) => Object.values(d.agents).reduce((a, b) => a + b, 0)));
  const agentIds = Object.keys(sum?.byAgent ?? {});
  const total = Object.values(sum?.byAgent ?? {}).reduce((a, t) => ({ tokens: a.tokens + t.total, cost: a.cost + t.cost, turns: a.turns + t.turns }), { tokens: 0, cost: 0, turns: 0 });

  return (
    <>
      <div className="main-head">
        <Gauge size={17} />
        <span className="title">Usage</span>
        <div className="spacer" />
        <div className="seg">
          {[7, 30, 90].map((d) => (
            <button key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>
              {d} days
            </button>
          ))}
        </div>
        {onClose && (
          <button className="btn ghost icon" onClick={onClose}>
            <X size={16} />
          </button>
        )}
      </div>
      <div className="page">
        <div className="page-inner col" style={{ gap: 18 }}>
          <div className="usage-cards">
            {defs.map((d) => {
              const st = statuses[d.id];
              const t = sum?.byAgent[d.id];
              return (
                <div key={d.id} className="card usage-card">
                  <div className="row">
                    <AgentLogo def={d} size={26} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <b>{d.name}</b>
                      <div className="small muted">{st?.plan ?? 'Plan: not reported by agent'}</div>
                    </div>
                  </div>
                  {st?.limits?.length ? (
                    <LimitBars limits={st.limits} />
                  ) : (
                    <div className="small muted">
                      {st?.limitsReadable
                        ? 'No plan limits to show (an API-key login has none).'
                        : st?.limitsRefreshing
                          ? 'Reading plan limits…'
                          : st?.limitsReadable === false
                            ? 'This agent does not report plan limits.'
                            : 'Plan limits show once the agent reports them.'}
                    </div>
                  )}
                  <div className="usage-stats">
                    <span>
                      <b>{fmtTokens(t?.total ?? 0)}</b> tokens
                    </span>
                    <span>
                      <b>{t?.turns ?? 0}</b> turns
                    </span>
                    {(t?.cost ?? 0) > 0 && (
                      <span title="Estimate based on API pricing. Not billed on subscription plans.">
                        <b>{fmtCost(t!.cost)}</b> est.
                      </span>
                    )}
                  </div>
                  <LimitsFreshness status={st} agentName={d.name} />
                </div>
              );
            })}
          </div>

          <div className="card" style={{ padding: 16 }}>
            <div className="row" style={{ marginBottom: 12 }}>
              <BarChart3 size={16} />
              <b>Tokens per day</b>
              <div className="spacer" />
              <span className="small muted">
                {days} days: {fmtTokens(total.tokens)} tokens · {total.turns} turns{total.cost > 0 ? ` · ${fmtCost(total.cost)} est.` : ''}
              </span>
            </div>
            <div className="day-chart">
              {(sum?.byDay ?? []).map((d) => {
                const dayTotal = Object.values(d.agents).reduce((a, b) => a + b, 0);
                return (
                  <div key={d.day} className="day-col" title={`${d.day}: ${fmtTokens(dayTotal)} tokens${d.cost ? ` · ${fmtCost(d.cost)}` : ''}\n${Object.entries(d.agents).map(([a, v]) => `${defOf[a]?.name ?? a}: ${fmtTokens(v)}`).join('\n')}`}>
                    <div className="day-stack" style={{ height: `${(dayTotal / maxDay) * 100}%` }}>
                      {Object.entries(d.agents).map(([a, v]) => (
                        <div key={a} style={{ flex: v, background: defOf[a]?.color ?? 'var(--muted)' }} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="row small muted" style={{ justifyContent: 'space-between', marginTop: 6 }}>
              <span>{sum?.byDay[0]?.day.slice(5)}</span>
              <span className="row" style={{ gap: 12 }}>
                {agentIds.map((a) => (
                  <span key={a} className="row" style={{ gap: 5 }}>
                    <span className="legend-dot" style={{ background: defOf[a]?.color ?? 'var(--muted)' }} /> {defOf[a]?.name ?? a}
                  </span>
                ))}
              </span>
              <span>Today</span>
            </div>
          </div>

          {agentIds.length > 0 && (
            <div className="card" style={{ padding: 16 }}>
              <b>By agent</b>
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Turns</th>
                    <th>Input</th>
                    <th>Output</th>
                    <th>Cache read</th>
                    <th>Cache write</th>
                    <th>Total</th>
                    <th>Cost est.</th>
                  </tr>
                </thead>
                <tbody>
                  {agentIds.map((a) => {
                    const t = sum!.byAgent[a];
                    return (
                      <tr key={a}>
                        <td className="row" style={{ gap: 6 }}>
                          {defOf[a] && <AgentLogo def={defOf[a]} size={18} />} {defOf[a]?.name ?? a}
                        </td>
                        <td>{t.turns}</td>
                        <td>{fmtTokens(t.input)}</td>
                        <td>{fmtTokens(t.output)}</td>
                        <td>{fmtTokens(t.cacheRead)}</td>
                        <td>{fmtTokens(t.cacheWrite)}</td>
                        <td>
                          <b>{fmtTokens(t.total)}</b>
                        </td>
                        <td>{t.cost > 0 ? fmtCost(t.cost) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {(sum?.topThreads.length ?? 0) > 0 && (
            <div className="card" style={{ padding: 16 }}>
              <b>Top chats by tokens</b>
              <div className="col" style={{ gap: 2, marginTop: 8 }}>
                {sum!.topThreads.map((t) => (
                  <div key={t.threadId} className="git-row" onClick={() => onOpenThread(t.threadId)}>
                    {defOf[t.agentId] && <AgentLogo def={defOf[t.agentId]} size={18} />}
                    <span className="grow ellipsis">{t.title}</span>
                    <span className="small muted">{fmtTokens(t.total)}{t.cost ? ` · ${fmtCost(t.cost)}` : ''}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <p className="small muted">
            Tokens come from the usage each agent reports and are saved in <code>~/.olympus/usage/</code>. Cost is an estimate at API prices; subscription plans such as Claude Max, ChatGPT or Google AI are not billed separately.
          </p>
        </div>
      </div>
    </>
  );
}
