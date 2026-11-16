import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, BarChart3, Brain, Bug, Clock, Coins, FileCode2, FolderOpen, Hammer, LayoutDashboard, MessageSquare, Save, ScrollText, ShieldAlert, Users, X } from 'lucide-react';
import type { AgentDef, Project, ProjectStats } from '@shared/types';
import { api } from '../api';
import { AgentLogo } from '../logos';
import { CodeEditor } from './Editor';
import { StatusCounts } from './StatusDot';
import { fmtCost, fmtTokens } from './Usage';

/**
 * A project's dashboard, opened from the gear on its row: what has happened in this project (tokens, cost,
 * sessions, tool calls, files, agent time, charts) and its instructions — the rules every agent must follow
 * here. All numbers come from what the app recorded; cost is the agents' own API-price estimate.
 */

const KIND_LABEL: Record<string, string> = {
  read: 'Read files',
  edit: 'Edit files',
  delete: 'Delete',
  move: 'Move / rename',
  search: 'Search',
  execute: 'Run commands',
  think: 'Think',
  fetch: 'Web',
  olympus: 'Sub-sessions & terminals',
  switch_mode: 'Mode switch',
  other: 'Other',
};

const fmtDuration = (ms: number) => {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.round(h / 24)}d ${h % 24}h`;
};
const fmtDate = (ts?: number) => (ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fmtAgo = (ts?: number) => {
  if (!ts) return '—';
  const s = (Date.now() - ts) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
};

type Tab = 'overview' | 'instructions';

export function ProjectDashboard(props: { project: Project; agentDefs: Record<string, AgentDef>; threadIds: string[]; onOpenThread: (id: string) => void; onClose: () => void }) {
  const { project } = props;
  const [tab, setTab] = useState<Tab>('overview');
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [error, setError] = useState('');
  const [instr, setInstr] = useState<{ text: string; saved: string } | null>(null);
  const [flash, setFlash] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    api
      .projectStats(project.id, days)
      .then((s) => live && setStats(s))
      .catch((e) => live && setError(String(e?.message ?? e)));
    return () => {
      live = false;
    };
  }, [project.id, days]);
  useEffect(() => {
    void api.memory(project.id).then((m) => m && setInstr({ text: m.projectInstructions, saved: m.projectInstructions }));
  }, [project.id]);

  const dirty = Boolean(instr && instr.text !== instr.saved);
  const close = () => {
    if (dirty && !confirm('Discard your unsaved instructions?')) return;
    props.onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const save = async () => {
    if (!instr) return;
    try {
      await api.writeProjectInstructions(project.id, instr.text);
      setInstr({ ...instr, saved: instr.text });
      setStats((s) => (s ? { ...s, instructions: instr.text.trim().length > 0 } : s));
      setFlash('Saved. Every agent in this project follows it from its next message.');
      setTimeout(() => setFlash(''), 3000);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal pdash" role="dialog" aria-label={`${project.name} dashboard`}>
        <div className="pdash-head">
          <div className="pdash-icon">
            <FolderOpen size={18} />
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <b className="ellipsis pdash-title">{project.name}</b>
              <StatusCounts threadIds={props.threadIds} />
            </div>
            <span className="small muted ellipsis" style={{ display: 'block' }}>
              {stats
                ? `${stats.sessions.total} session${stats.sessions.total === 1 ? '' : 's'} · started ${fmtDate(stats.firstActivity)} · last activity ${fmtAgo(stats.lastActivity)}`
                : 'Counting…'}
            </span>
          </div>
          <button className="btn small" title={`Open ${project.path}`} onClick={() => void api.revealProject(project.id)}>
            <FolderOpen size={14} /> Open folder
          </button>
          <button className="btn ghost icon" title="Close (Esc)" onClick={close}>
            <X size={17} />
          </button>
        </div>

        <div className="pdash-tabs">
          <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>
            <LayoutDashboard size={14} /> Overview
          </button>
          <button className={tab === 'instructions' ? 'active' : ''} onClick={() => setTab('instructions')}>
            <ScrollText size={14} /> Instructions
            {stats?.instructions || instr?.saved.trim() ? <span className="pdash-dot" title="Set" /> : null}
            {dirty && <span className="small muted">· unsaved</span>}
          </button>
          <span className="grow" />
          {tab === 'overview' && (
            <div className="seg">
              {[
                [7, '7 days'],
                [30, '30 days'],
                [90, '90 days'],
                [0, 'All time'],
              ].map(([d, label]) => (
                <button key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d as number)}>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="pdash-body">
          {error && <p className="small error-text">{error}</p>}
          {tab === 'overview' ? (
            stats ? (
              <Overview stats={stats} defs={props.agentDefs} onOpenThread={(id) => (props.onOpenThread(id), close())} onInstructions={() => setTab('instructions')} />
            ) : (
              !error && <p className="muted small">Counting…</p>
            )
          ) : (
            <div className="pdash-instr">
              <div className="row" style={{ gap: 8 }}>
                <div className="grow">
                  <b>Instructions for this project</b>
                  <div className="small muted">
                    Rules every agent (Claude, Gemini, Codex…) must follow in this project only — e.g. "Rust: no unwrap() in library code", "every result needs a checked
                    proof". Given in full to every session; running chats get changes with their next message.
                  </div>
                </div>
                <button className="btn primary" disabled={!dirty} onClick={() => void save()} title="Save (⌘S)">
                  <Save size={14} /> Save
                </button>
              </div>
              <div className="pdash-editor">
                {instr && (
                  <CodeEditor path="INSTRUCTIONS.md" value={instr.text} dark={document.documentElement.dataset.theme === 'dark'} onChange={(text) => setInstr((c) => (c ? { ...c, text } : c))} onSave={() => void save()} />
                )}
              </div>
              <div className="row small" style={{ gap: 8 }}>
                <span className={flash ? 'ok-row' : 'muted'}>{flash || 'Markdown. Short, strict rules work best.'}</span>
                <span className="grow" />
                <button className="btn ghost small" onClick={() => void api.revealMemory(project.id)}>
                  <Brain size={13} /> Memory folder
                </button>
                <button className="btn ghost small" onClick={() => void api.revealProject(project.id)}>
                  <FolderOpen size={13} /> Open project folder
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const KIND_COLOR: Record<string, string> = {
  execute: 'var(--accent)',
  read: '#58a6ff',
  edit: '#3fb950',
  search: '#bc8cff',
  olympus: '#e3b341',
  fetch: '#39c5cf',
  think: '#a5a5ff',
  delete: '#ff7b72',
  move: '#56d364',
  switch_mode: '#f778ba',
  other: '#8b949e',
};

type TipState = { x: number; y: number; body: React.ReactNode } | null;
type SetTip = (t: TipState) => void;

function Overview({ stats, defs, onOpenThread, onInstructions }: { stats: ProjectStats; defs: Record<string, AgentDef>; onOpenThread: (id: string) => void; onInstructions: () => void }) {
  const color = (a: string) => defs[a]?.color ?? '#8b949e';
  const name = (a: string) => defs[a]?.name ?? a;
  const [tip, setTipRaw] = useState<TipState>(null);
  // Keep the hover card on screen; it is dropped when the page scrolls under the pointer.
  const setTip: SetTip = (t) => setTipRaw(t && { ...t, x: t.x + 250 > window.innerWidth ? t.x - 270 : t.x, y: Math.min(t.y, window.innerHeight - 160) });
  useEffect(() => {
    const body = document.querySelector('.pdash-body');
    const clear = () => setTipRaw(null);
    body?.addEventListener('scroll', clear, { passive: true });
    return () => body?.removeEventListener('scroll', clear);
  }, []);
  const t = stats.tokens;
  const failPct = stats.tools.total ? Math.round((stats.tools.failed / stats.tools.total) * 100) : 0;
  const dayTokens = stats.byDay.map((d) => Object.values(d.agents).reduce((a, b) => a + b, 0));
  const agents = useMemo(() => {
    const ids = new Set([...Object.keys(stats.byAgent), ...Object.keys(stats.sessions.byAgent)]);
    return [...ids].map((id) => ({ id, tokens: stats.byAgent[id]?.total ?? 0, sessions: stats.sessions.byAgent[id] ?? 0 })).sort((a, b) => b.tokens - a.tokens || b.sessions - a.sessions);
  }, [stats]);

  return (
    <div className="pdash-grid">
      <div className="pdash-kpis">
        <Kpi tone="#f0883e" icon={<Coins size={15} />} label="Tokens" value={fmtTokens(t.total)} sub={`${fmtTokens(t.input)} in · ${fmtTokens(t.output)} out`} tip={`Cache read ${fmtTokens(t.cacheRead)} · cache write ${fmtTokens(t.cacheWrite)}`} spark={dayTokens} />
        <Kpi tone="#3fb950" icon={<BarChart3 size={15} />} label="Cost" value={t.cost > 0 ? fmtCost(t.cost) : '—'} sub={`${t.turns} turns`} tip="Estimated at API prices. Subscription plans are not billed per token." spark={stats.byDay.map((d) => d.cost)} />
        <Kpi tone="#58a6ff" icon={<Users size={15} />} label="Sessions" value={String(stats.sessions.total)} sub={`${stats.sessions.active} active · ${stats.sessions.sub} sub`} tip="Active = had activity in this period. Sub = sub-sessions and forks." />
        <Kpi tone="#bc8cff" icon={<MessageSquare size={15} />} label="Messages" value={String(stats.messages)} tip="Messages you sent in this period." spark={stats.byDay.map((d) => d.messages)} />
        <Kpi
          tone="#e3b341"
          icon={<Hammer size={15} />}
          label="Tool calls"
          value={String(stats.tools.total)}
          badge={stats.tools.total ? { text: `${failPct}% failed`, bad: failPct >= 15 } : undefined}
          tip={`${stats.tools.failed} failed`}
          spark={stats.byDay.map((d) => d.tools)}
        />
        <Kpi tone="#39c5cf" icon={<Clock size={15} />} label="Agent time" value={fmtDuration(stats.agentTimeMs)} tip="From each message you sent until the agent's turn finished." />
        <Kpi tone="#56d364" icon={<FileCode2 size={15} />} label="Files touched" value={String(stats.filesTouched)} tip="Files agents read, edited or searched." />
        <Kpi
          tone="#ff7b72"
          icon={<ShieldAlert size={15} />}
          label="Errors"
          value={String(stats.errors)}
          badge={{ text: `${stats.permissions} approvals`, bad: false }}
          tip="Agent errors · permission requests"
        />
      </div>

      <div className="card pdash-card span-8">
        <CardHead icon={<BarChart3 size={15} />} title="Tokens per day">
          {agents
            .filter((a) => a.tokens > 0)
            .map((a) => (
              <span key={a.id} className="pdash-legend">
                <i style={{ background: color(a.id) }} /> {name(a.id)}
              </span>
            ))}
        </CardHead>
        {t.total > 0 ? (
          <ColumnChart
            values={dayTokens}
            stacks={stats.byDay.map((d) => Object.entries(d.agents).map(([a, v]) => ({ value: v, color: color(a) })))}
            fmt={fmtTokens}
            labels={stats.byDay.map((d) => d.day)}
            setTip={setTip}
            tipFor={(i) => (
              <>
                <b>{niceDay(stats.byDay[i].day)}</b>
                <div>{fmtTokens(dayTokens[i])} tokens{stats.byDay[i].cost ? ` · ${fmtCost(stats.byDay[i].cost)}` : ''}</div>
                {Object.entries(stats.byDay[i].agents)
                  .sort((x, y) => y[1] - x[1])
                  .map(([a, v]) => (
                  <div key={a} className="pdash-tip-row">
                    <i style={{ background: color(a) }} /> {name(a)} <span>{fmtTokens(v)}</span>
                  </div>
                ))}
              </>
            )}
          />
        ) : (
          <Empty text="No token usage in this period" />
        )}
      </div>

      <div className="card pdash-card span-4">
        <CardHead icon={<Hammer size={15} />} title="Tool mix" />
        {stats.tools.total ? (
          <Donut
            center={String(stats.tools.total)}
            centerSub="tool calls"
            parts={stats.tools.byKind.map((k) => ({ key: k.kind, label: KIND_LABEL[k.kind] ?? k.kind, value: k.count, color: KIND_COLOR[k.kind] ?? '#8b949e' }))}
          />
        ) : (
          <Empty text="No tool calls yet" />
        )}
      </div>

      <div className="card pdash-card span-8">
        <CardHead icon={<Activity size={15} />} title="Activity">
          <span className="pdash-legend">
            <i style={{ background: 'var(--accent)' }} /> tool calls
          </span>
        </CardHead>
        {stats.tools.total || stats.messages ? (
          <>
            <ColumnChart
              values={stats.byDay.map((d) => d.tools)}
              fmt={(n) => String(Math.round(n))}
              labels={stats.byDay.map((d) => d.day)}
              setTip={setTip}
              short
              tipFor={(i) => (
                <>
                  <b>{niceDay(stats.byDay[i].day)}</b>
                  <div>{stats.byDay[i].tools} tool calls</div>
                  <div>{stats.byDay[i].messages} messages from you</div>
                </>
              )}
            />
            <HourStrip byHour={stats.byHour} setTip={setTip} />
          </>
        ) : (
          <Empty text="No activity in this period" />
        )}
      </div>

      <div className="card pdash-card span-4">
        <CardHead icon={<Users size={15} />} title="Agents" />
        {agents.length ? (
          <Donut
            center={fmtTokens(agents.reduce((a, b) => a + b.tokens, 0))}
            centerSub="tokens"
            parts={agents
              .filter((a) => a.tokens > 0)
              .map((a) => ({ key: a.id, label: name(a.id), value: a.tokens, color: color(a.id), icon: defs[a.id] ? <AgentLogo def={defs[a.id]} size={13} /> : undefined, right: `${a.sessions}` }))}
            fmt={fmtTokens}
            rightTitle="sessions"
          />
        ) : (
          <Empty text="No sessions yet" />
        )}
      </div>

      <div className="card pdash-card span-6">
        <CardHead icon={<FileCode2 size={15} />} title="Most touched files" />
        {stats.topFiles.length ? (
          <div className="pdash-rank">
            {stats.topFiles.map((f) => (
              <div key={f.path} className="pdash-rank-row">
                <FileLabel path={f.path} />
                <div className="pdash-rank-bar">
                  <div style={{ width: `${(f.count / stats.topFiles[0].count) * 100}%` }} />
                </div>
                <span className="pdash-rank-n">{f.count}</span>
              </div>
            ))}
          </div>
        ) : (
          <Empty text="No files touched in this period" />
        )}
      </div>

      <div className="card pdash-card span-6">
        <CardHead icon={<MessageSquare size={15} />} title="Busiest chats" />
        {stats.topThreads.length ? (
          <div className="pdash-rank">
            {stats.topThreads.map((c) => (
              <button key={c.threadId} className="pdash-chat" onClick={() => onOpenThread(c.threadId)} title={`Open "${c.title}"`}>
                {defs[c.agentId] ? <AgentLogo def={defs[c.agentId]} size={15} /> : <MessageSquare size={14} />}
                <span className="grow ellipsis">{c.title}</span>
                {c.total > 0 && <span className="pdash-pill">{fmtTokens(c.total)}</span>}
                {c.tools > 0 && (
                  <span className="pdash-pill ghost">
                    <Hammer size={10} /> {c.tools}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <Empty text="No chats in this period" />
        )}
      </div>

      <div className="pdash-foot pdash-wide">
        <button className={`pdash-chip ${stats.instructions ? 'ok' : 'cta'}`} onClick={onInstructions}>
          <ScrollText size={13} /> {stats.instructions ? 'Instructions set' : 'Add project instructions'}
        </button>
        <span className="pdash-chip" title="Facts agents saved for this project">
          <Brain size={13} /> {stats.memoryNotes} memory {stats.memoryNotes === 1 ? 'note' : 'notes'}
        </span>
        <span className="pdash-chip" title="Solved bugs in the project's bug log">
          <Bug size={13} /> {stats.bugs} {stats.bugs === 1 ? 'bug' : 'bugs'} logged
        </span>
      </div>

      {tip && (
        <div className="pdash-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.body}
        </div>
      )}
    </div>
  );
}

const niceDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

function CardHead({ icon, title, children }: { icon: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="pdash-card-head">
      <span className="pdash-card-icon">{icon}</span>
      <b>{title}</b>
      <span className="grow" />
      {children}
    </div>
  );
}

function Kpi(p: { tone: string; icon: React.ReactNode; label: string; value: string; sub?: string; tip?: string; spark?: number[]; badge?: { text: string; bad: boolean } }) {
  return (
    <div className="card pdash-kpi" title={p.tip} style={{ ['--tone' as any]: p.tone }}>
      <div className="pdash-kpi-top">
        <span className="pdash-kpi-icon">{p.icon}</span>
        <span className="pdash-kpi-label">{p.label}</span>
        {p.badge && <span className={`pdash-badge ${p.badge.bad ? 'bad' : ''}`}>{p.badge.text}</span>}
      </div>
      <div className="pdash-kpi-value">{p.value}</div>
      <div className="pdash-kpi-bottom">
        <span className="pdash-kpi-sub ellipsis">{p.sub ?? ''}</span>
        {p.spark && p.spark.some((v) => v > 0) && <Spark values={p.spark} />}
      </div>
    </div>
  );
}

/** A tiny area chart of a series (oldest → today). */
function Spark({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  const n = values.length;
  const pts = values.map((v, i) => [n === 1 ? 50 : (i / (n - 1)) * 100, 26 - (v / max) * 22] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  return (
    <svg className="pdash-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden>
      <path d={`${line} L100,28 L0,28 Z`} className="area" />
      <path d={line} className="line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const Empty = ({ text }: { text: string }) => <div className="pdash-empty">{text}</div>;

/** Columns per day with soft gridlines; stacked when `stacks` is given; hover shows a card. */
function ColumnChart(p: {
  values: number[];
  stacks?: { value: number; color: string }[][];
  labels: string[];
  fmt: (n: number) => string;
  tipFor: (i: number) => React.ReactNode;
  setTip: SetTip;
  short?: boolean;
}) {
  const max = Math.max(1, ...p.values);
  const [hover, setHover] = useState(-1);
  const show = (i: number, e: React.MouseEvent) => {
    setHover(i);
    p.setTip({ x: e.clientX + 14, y: e.clientY - 10, body: p.tipFor(i) });
  };
  const n = p.labels.length;
  return (
    <div className={`pdash-cols ${p.short ? 'short' : ''}`}>
      <div className="pdash-gridlines">
        {[1, 0.5, 0].map((f) => (
          <div key={f} className="pdash-gridline">
            <span>{f ? p.fmt(max * f) : ''}</span>
          </div>
        ))}
      </div>
      <div
        className="pdash-cols-plot"
        onMouseLeave={() => {
          setHover(-1);
          p.setTip(null);
        }}
      >
        {p.values.map((v, i) => (
          <div key={i} className={`pdash-col ${hover === i ? 'hover' : ''}`} onMouseMove={(e) => show(i, e)}>
            <div className="pdash-col-bar" style={{ height: `${(v / max) * 100}%` }}>
              {p.stacks ? p.stacks[i].map((s, j) => <div key={j} style={{ flex: s.value, background: s.color }} />) : <div style={{ flex: 1, background: 'var(--accent)' }} />}
            </div>
          </div>
        ))}
      </div>
      <div className="pdash-cols-x">
        <span>{niceDay(p.labels[0]).replace(/^\w+,?\s*/, '')}</span>
        {n > 2 && <span>{niceDay(p.labels[Math.floor(n / 2)]).replace(/^\w+,?\s*/, '')}</span>}
        <span>Today</span>
      </div>
    </div>
  );
}

/** 24 cells, one per hour of the day, brighter where more tool calls happened. */
function HourStrip({ byHour, setTip }: { byHour: number[]; setTip: SetTip }) {
  const max = Math.max(1, ...byHour);
  return (
    <div className="pdash-hours">
      <span className="pdash-hours-label">By hour</span>
      <div className="pdash-hours-cells" onMouseLeave={() => setTip(null)}>
        {byHour.map((v, h) => (
          <div
            key={h}
            className="pdash-hour"
            style={{ opacity: v ? 0.18 + 0.82 * (v / max) : 0.07 }}
            onMouseMove={(e) => setTip({ x: e.clientX + 14, y: e.clientY - 10, body: <><b>{String(h).padStart(2, '0')}:00 – {String(h).padStart(2, '0')}:59</b><div>{v} tool calls</div></> })}
          />
        ))}
      </div>
      <div className="pdash-hours-x">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
    </div>
  );
}

/** A ring split into parts, the total in the middle, and a short legend. */
function Donut(p: { parts: { key: string; label: string; value: number; color: string; icon?: React.ReactNode; right?: string }[]; center: string; centerSub: string; fmt?: (n: number) => string; rightTitle?: string }) {
  const total = p.parts.reduce((a, b) => a + b.value, 0) || 1;
  const [hover, setHover] = useState<string | null>(null);
  const R = 42;
  const C = 2 * Math.PI * R;
  let acc = 0;
  const shown = p.parts.slice(0, 6);
  const rest = p.parts.slice(6).reduce((a, b) => a + b.value, 0);
  return (
    <div className="pdash-donut">
      <svg viewBox="0 0 110 110" className="pdash-donut-svg">
        <circle cx="55" cy="55" r={R} className="pdash-donut-bg" />
        {p.parts.map((part) => {
          const len = (part.value / total) * C;
          const el = (
            <circle
              key={part.key}
              cx="55"
              cy="55"
              r={R}
              stroke={part.color}
              strokeDasharray={`${Math.max(0, len - 1.5)} ${C}`}
              strokeDashoffset={-acc}
              className={`pdash-donut-seg ${hover && hover !== part.key ? 'dim' : ''}`}
              transform="rotate(-90 55 55)"
              onMouseEnter={() => setHover(part.key)}
              onMouseLeave={() => setHover(null)}
            />
          );
          acc += len;
          return el;
        })}
        <text x="55" y="53" className="pdash-donut-num">
          {p.center}
        </text>
        <text x="55" y="68" className="pdash-donut-sub">
          {p.centerSub}
        </text>
      </svg>
      <div className="pdash-donut-legend">
        {shown.map((part) => (
          <div key={part.key} className={`pdash-donut-item ${hover === part.key ? 'on' : ''}`} onMouseEnter={() => setHover(part.key)} onMouseLeave={() => setHover(null)}>
            <i style={{ background: part.color }} />
            {part.icon}
            <span className="grow ellipsis">{part.label}</span>
            <span className="pdash-donut-val" title={part.right ? `${part.right} ${p.rightTitle ?? ''}` : undefined}>
              {Math.round((part.value / total) * 100)}%
            </span>
          </div>
        ))}
        {rest > 0 && (
          <div className="pdash-donut-item">
            <i style={{ background: '#8b949e' }} />
            <span className="grow">More</span>
            <span className="pdash-donut-val">{Math.round((rest / total) * 100)}%</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** A path inside the project as it is; one outside it (e.g. the shared memory) shortened, with a tag. */
function FileLabel({ path }: { path: string }) {
  if (!path.startsWith('/') && !/^[A-Za-z]:\\/.test(path))
    return (
      <span className="mono ellipsis" title={path}>
        {path}
      </span>
    );
  const parts = path.split(/[\\/]/).filter(Boolean);
  return (
    <span className="row" style={{ gap: 6, minWidth: 0 }} title={path}>
      <span className="mono ellipsis">…/{parts.slice(-2).join('/')}</span>
      <span className="pdash-tag">outside project</span>
    </span>
  );
}
