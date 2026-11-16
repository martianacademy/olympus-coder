import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Brain, Clock, Coins, Database, DatabaseZap, Sigma } from 'lucide-react';
import type { AgentDef, ContextUsage, PromptUsage, ReplyUsage, Thread } from '@shared/types';
import { contextLevel } from '../contextLevel';
import { AgentLogo } from '../logos';
import { fmtCost, fmtTokens } from './Usage';

const exact = (n: number) => n.toLocaleString();
const fmtDur = (ms: number) => (ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

/** Rough token count for text being typed (≈4 characters per token for English / Hinglish). */
export const estimateTokens = (text: string) => (text.trim() ? Math.max(1, Math.round(text.length / 4)) : 0);

function Row({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="tok-row" title={hint}>
      <span className="tok-row-icon">{icon}</span>
      <span className="grow">{label}</span>
      <b>{value}</b>
    </div>
  );
}

/** Under a user message: everything the model read for this turn. Hover for the breakdown. */
export function PromptChip({ usage }: { usage: PromptUsage }) {
  return (
    <span className="tok-chip has-card" data-testid="prompt-chip">
      <ArrowUpRight size={12} />
      {fmtTokens(usage.prompt)} in
      <span className="tok-card">
        <span className="tok-card-title">Tokens read for this message</span>
        <Row icon={<ArrowUpRight size={13} />} label="New input" value={exact(usage.input)} hint="Tokens sent for the first time this turn" />
        <Row icon={<Database size={13} />} label="Cache read" value={exact(usage.cacheRead)} hint="Earlier context served from cache (cheaper, faster)" />
        <Row icon={<DatabaseZap size={13} />} label="Cache write" value={exact(usage.cacheWrite)} hint="New context cached for later turns" />
        <span className="tok-card-sep" />
        <Row icon={<Sigma size={13} />} label="Total prompt" value={exact(usage.prompt)} />
      </span>
    </span>
  );
}

/** Under an agent reply: tokens written, time taken, cost. */
export function ReplyChip({ usage }: { usage: ReplyUsage }) {
  return (
    <span className="tok-chips">
      <span className="tok-chip has-card" data-testid="reply-chip">
        <ArrowDownRight size={12} />
        {fmtTokens(usage.output)} out
        <span className="tok-card">
          <span className="tok-card-title">In this reply</span>
          <Row icon={<ArrowDownRight size={13} />} label="Output tokens" value={exact(usage.output)} />
          {usage.thought > 0 && <Row icon={<Brain size={13} />} label="Thinking" value={exact(usage.thought)} />}
          <Row icon={<Clock size={13} />} label="Time" value={fmtDur(usage.durationMs)} />
          {usage.cost !== undefined && <Row icon={<Coins size={13} />} label="Cost (API estimate)" value={fmtCost(usage.cost)} />}
          {usage.model && <span className="tok-card-foot">{usage.model}</span>}
        </span>
      </span>
      {usage.thought > 0 && (
        <span className="tok-chip">
          <Brain size={12} />
          {fmtTokens(usage.thought)}
        </span>
      )}
      <span className="tok-chip">
        <Clock size={12} />
        {fmtDur(usage.durationMs)}
      </span>
      {usage.cost !== undefined && usage.cost > 0 && (
        <span className="tok-chip">
          <Coins size={12} />
          {fmtCost(usage.cost)}
        </span>
      )}
    </span>
  );
}

interface Totals {
  turns: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  prompt: number;
  output: number;
  thought: number;
  cost: number;
  hasCost: boolean;
  durationMs: number;
  perTurn: { prompt: number; output: number; agentId: string }[];
  byAgent: Record<string, { prompt: number; output: number; cost: number; turns: number }>;
}

export function sessionTotals(thread: Thread): Totals {
  const t: Totals = { turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, prompt: 0, output: 0, thought: 0, cost: 0, hasCost: false, durationMs: 0, perTurn: [], byAgent: {} };
  let pending: { prompt: number; agentId: string } | null = null;
  for (const it of thread.items) {
    if (it.kind === 'user' && it.usage) {
      t.turns += 1;
      t.input += it.usage.input;
      t.cacheRead += it.usage.cacheRead;
      t.cacheWrite += it.usage.cacheWrite;
      t.prompt += it.usage.prompt;
      pending = { prompt: it.usage.prompt, agentId: it.agentId };
      const a = (t.byAgent[it.agentId] ??= { prompt: 0, output: 0, cost: 0, turns: 0 });
      a.prompt += it.usage.prompt;
      a.turns += 1;
    }
    if (it.kind === 'agent' && it.usage) {
      t.output += it.usage.output;
      t.thought += it.usage.thought;
      t.durationMs += it.usage.durationMs;
      if (it.usage.cost !== undefined) {
        t.cost += it.usage.cost;
        t.hasCost = true;
      }
      const a = (t.byAgent[it.agentId] ??= { prompt: 0, output: 0, cost: 0, turns: 0 });
      a.output += it.usage.output;
      a.cost += it.usage.cost ?? 0;
      t.perTurn.push({ prompt: pending?.prompt ?? 0, output: it.usage.output, agentId: it.agentId });
      pending = null;
    }
  }
  return t;
}

/** The whole chat at a glance: context window, input / cache / output split, every turn, every agent. */
export function SessionStats({ thread, usage, agentDefs, action }: { thread: Thread; usage?: ContextUsage; agentDefs: Record<string, AgentDef>; action?: ReactNode }) {
  const t = sessionTotals(thread);
  const ctx = usage?.size ? Math.min(1, usage.used / usage.size) : 0;
  const R = 34;
  const C = 2 * Math.PI * R;
  const split = [
    { key: 'in', label: 'New input', v: t.input, cls: 'c-in' },
    { key: 'cr', label: 'Cache read', v: t.cacheRead, cls: 'c-cr' },
    { key: 'cw', label: 'Cache write', v: t.cacheWrite, cls: 'c-cw' },
    { key: 'out', label: 'Output', v: t.output, cls: 'c-out' },
  ];
  const all = split.reduce((a, s) => a + s.v, 0) || 1;
  const maxTurn = Math.max(1, ...t.perTurn.map((p) => p.prompt + p.output));
  const agents = Object.entries(t.byAgent);
  return (
    <div className="stats">
      <div className="stats-top">
        <div className="stats-ring">
          <svg width="84" height="84" viewBox="0 0 84 84">
            <circle cx="42" cy="42" r={R} className="ring-bg" />
            <circle cx="42" cy="42" r={R} className={`ring-fg ${usage?.size ? `ctx-${contextLevel(ctx)}` : ''}`} strokeDasharray={C} strokeDashoffset={C * (1 - ctx)} transform="rotate(-90 42 42)" />
          </svg>
          <div className="stats-ring-label">
            <b>{usage?.size ? `${ctx < 0.01 && usage.used ? '<1' : Math.round(ctx * 100)}%` : '—'}</b>
            <span>context</span>
          </div>
        </div>
        <div className="col" style={{ gap: 4, minWidth: 0 }}>
          <div className="stats-big">{usage?.size ? `${fmtTokens(usage.used)} / ${fmtTokens(usage.size)}` : 'Context unknown'}</div>
          <div className="small muted">Tokens currently in the context window{usage?.model ? ` · ${usage.model}` : ''}</div>
          <div className="small muted">
            {t.turns} {t.turns === 1 ? 'turn' : 'turns'} · {fmtDur(t.durationMs)} agent time
          </div>
          {action}
        </div>
      </div>

      <div className="stats-tiles">
        <div className="tile">
          <ArrowUpRight size={14} />
          <span>Total input</span>
          <b>{fmtTokens(t.prompt)}</b>
        </div>
        <div className="tile">
          <ArrowDownRight size={14} />
          <span>Total output</span>
          <b>{fmtTokens(t.output)}</b>
        </div>
        <div className="tile">
          <Database size={14} />
          <span>Cache read</span>
          <b>{fmtTokens(t.cacheRead)}</b>
        </div>
        <div className="tile">
          <DatabaseZap size={14} />
          <span>Cache write</span>
          <b>{fmtTokens(t.cacheWrite)}</b>
        </div>
        <div className="tile">
          <Brain size={14} />
          <span>Thinking</span>
          <b>{t.thought ? fmtTokens(t.thought) : '—'}</b>
        </div>
        <div className="tile">
          <Coins size={14} />
          <span>Cost est.</span>
          <b>{t.hasCost ? fmtCost(t.cost) : '—'}</b>
        </div>
      </div>

      <div>
        <div className="split-bar">
          {split.map((s) => (s.v ? <div key={s.key} className={s.cls} style={{ flex: s.v }} title={`${s.label}: ${exact(s.v)}`} /> : null))}
        </div>
        <div className="split-legend">
          {split.map((s) => (
            <span key={s.key}>
              <i className={s.cls} /> {s.label} {s.v && s.v / all < 0.01 ? '<1' : Math.round((s.v / all) * 100)}%
            </span>
          ))}
        </div>
      </div>

      {t.perTurn.length > 0 && (
        <div>
          <div className="small muted" style={{ marginBottom: 6 }}>
            Per turn (input + output)
          </div>
          <div className="turn-bars">
            {t.perTurn.map((p, i) => (
              <div key={i} className="turn-bar" title={`Turn ${i + 1} · ${agentDefs[p.agentId]?.name ?? p.agentId}\nInput ${exact(p.prompt)} · Output ${exact(p.output)}`}>
                <div className="tb-stack" style={{ height: `${((p.prompt + p.output) / maxTurn) * 100}%` }}>
                  <div className="c-out" style={{ flex: Math.max(p.output, maxTurn * 0.02) }} />
                  <div className="c-in" style={{ flex: p.prompt }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {agents.length > 1 && (
        <div className="col" style={{ gap: 6 }}>
          <div className="small muted">By agent (this chat)</div>
          {agents.map(([id, a]) => (
            <div key={id} className="row small">
              {agentDefs[id] && <AgentLogo def={agentDefs[id]} size={18} />}
              <span className="grow">{agentDefs[id]?.name ?? id}</span>
              <span className="muted">
                {a.turns} {a.turns === 1 ? 'turn' : 'turns'} · ↑{fmtTokens(a.prompt)} · ↓{fmtTokens(a.output)}
                {a.cost ? ` · ${fmtCost(a.cost)}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
      {!t.turns && <div className="small muted">Send a message to see per-turn usage here.</div>}
      <div className="small muted">Each turn the agent rereads the full context (mostly from cache), so total input can exceed the context size.</div>
    </div>
  );
}

/** Header button "Σ 39k" that opens the session stats. */
export const SessionStatsButton = memo(function SessionStatsButton(props: { thread: Thread; usage?: ContextUsage; agentDefs: Record<string, AgentDef> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const t = useMemo(() => sessionTotals(props.thread), [props.thread.items]);
  return (
    <div className="picker stats-picker" ref={ref}>
      <button className={`stats-btn ${open ? 'on' : ''}`} onClick={() => setOpen((o) => !o)} title="Tokens and context for this chat" data-testid="session-stats">
        <Sigma size={14} />
        <span>{fmtTokens(t.prompt + t.output)}</span>
        {props.usage?.size ? <span className={`ctx-pct ctx-${contextLevel(props.usage.used / props.usage.size)}`} data-testid="session-stats-pct">· {Math.max(t.prompt ? 1 : 0, Math.round((props.usage.used / props.usage.size) * 100))}%</span> : null}
      </button>
      {open && (
        <div className="menu stats-pop">
          <SessionStats {...props} />
        </div>
      )}
    </div>
  );
});
