import { useEffect, useState } from 'react';
import { Clock, Pause, Pencil, Play, Plus, Trash2, Zap } from 'lucide-react';
import type { AgentDef, Project, ScheduledTask, ScheduleKind } from '@shared/types';
import { AgentSelect } from './AgentSelect';
import { api, onEvent } from '../api';
import { AgentLogo } from '../logos';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function describe(t: ScheduledTask) {
  switch (t.kind) {
    case 'once':
      return t.at ? `Once · ${new Date(t.at).toLocaleString()}` : 'Once';
    case 'interval':
      return (t.everyMinutes ?? 60) % 60 === 0 ? ((t.everyMinutes ?? 60) === 60 ? 'Every hour' : `Every ${(t.everyMinutes ?? 60) / 60} hours`) : `Every ${t.everyMinutes} minutes`;
    case 'daily':
      return `Daily at ${t.time}`;
    case 'weekly':
      return `Every ${DAYS[t.weekday ?? 1]} at ${t.time}`;
  }
}

const toLocalInput = (ts: number) => {
  const d = new Date(ts - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

type Draft = Partial<ScheduledTask> & { kind: ScheduleKind };

/** Scheduled prompts: at the set time a new chat opens in the project and the agent gets the prompt. */
export function ScheduledView({
  projects,
  agentDefs,
  defaultProjectId,
  defaultAgent,
  onOpenThread,
}: {
  projects: Project[];
  agentDefs: Record<string, AgentDef>;
  defaultProjectId?: string;
  defaultAgent: string;
  onOpenThread: (id: string) => void;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void api.schedules().then(setTasks);
    return onEvent((ch, p) => {
      if (ch === 'schedules:changed') setTasks(p);
    });
  }, []);

  const newDraft = (): Draft => ({
    name: '',
    projectId: defaultProjectId ?? projects[0]?.id,
    agentId: defaultAgent,
    prompt: '',
    kind: 'daily',
    time: '09:00',
    weekday: 1,
    everyMinutes: 60,
    at: Date.now() + 3600_000,
    enabled: true,
  });

  async function save() {
    if (!draft) return;
    if (!draft.name?.trim() || !draft.prompt?.trim() || !draft.projectId) return setError('Name, project and prompt are required.');
    if (draft.kind === 'once' && (!draft.at || draft.at <= Date.now())) return setError('Choose a time in the future.');
    setTasks(await api.saveSchedule({ ...draft, name: draft.name.trim(), prompt: draft.prompt.trim() }));
    setDraft(null);
    setError('');
  }

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? '(project removed)';

  return (
    <>
      <div className="main-head">
        <Clock size={17} />
        <span className="title">Scheduled</span>
        <div className="spacer" />
        {!draft && (
          <button className="btn primary small" onClick={() => setDraft(newDraft())} disabled={!projects.length}>
            <Plus size={14} /> New task
          </button>
        )}
      </div>
      <div className="page">
        <div className="page-inner">
          <p className="muted small" style={{ marginTop: 0 }}>
            At the set time, Olympus Coder opens a new chat in the project and sends the prompt to the chosen agent. Tasks run only while the app is open; a run missed while the app was closed runs once the next time it opens.
          </p>

          {draft && (
            <div className="card task-card col" style={{ gap: 10 }}>
              <b>{draft.id ? 'Edit task' : 'New scheduled task'}</b>
              <input className="input" placeholder="Name (e.g. Daily standup summary)" value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <div className="grid-2">
                <select className="select" value={draft.projectId} onChange={(e) => setDraft({ ...draft, projectId: e.target.value })}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <AgentSelect value={draft.agentId ?? ''} agents={Object.values(agentDefs)} onChange={(id) => setDraft({ ...draft, agentId: id })} />
              </div>
              <textarea className="textarea" rows={4} placeholder="What should the agent do…" value={draft.prompt ?? ''} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
              <div className="seg">
                {(
                  [
                    ['once', 'Once'],
                    ['interval', 'Interval'],
                    ['daily', 'Daily'],
                    ['weekly', 'Weekly'],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} className={draft.kind === k ? 'active' : ''} onClick={() => setDraft({ ...draft, kind: k })}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="row">
                {draft.kind === 'once' && (
                  <input className="input" style={{ maxWidth: 260 }} type="datetime-local" value={toLocalInput(draft.at ?? Date.now())} onChange={(e) => setDraft({ ...draft, at: new Date(e.target.value).getTime() })} />
                )}
                {draft.kind === 'interval' && (
                  <select className="select" style={{ maxWidth: 220 }} value={draft.everyMinutes} onChange={(e) => setDraft({ ...draft, everyMinutes: Number(e.target.value) })}>
                    {[15, 30, 60, 120, 180, 360, 720].map((m) => (
                      <option key={m} value={m}>
                        {m < 60 ? `Every ${m} minutes` : m === 60 ? 'Every hour' : `Every ${m / 60} hours`}
                      </option>
                    ))}
                  </select>
                )}
                {draft.kind === 'weekly' && (
                  <select className="select" style={{ maxWidth: 180 }} value={draft.weekday} onChange={(e) => setDraft({ ...draft, weekday: Number(e.target.value) })}>
                    {DAYS.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                )}
                {(draft.kind === 'daily' || draft.kind === 'weekly') && (
                  <input className="input" style={{ maxWidth: 140 }} type="time" value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
                )}
              </div>
              {error && <div className="error-text">{error}</div>}
              <div className="row">
                <button className="btn primary" onClick={() => void save()}>
                  Save
                </button>
                <button className="btn ghost" onClick={() => (setDraft(null), setError(''))}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {!tasks.length && !draft && (
            <div className="muted" style={{ textAlign: 'center', marginTop: 60 }}>
              <Clock size={28} />
              <p>No scheduled tasks yet.</p>
            </div>
          )}

          {tasks.map((t) => {
            const d = agentDefs[t.agentId];
            return (
              <div className="card task-card" key={t.id} style={{ opacity: t.enabled ? 1 : 0.6 }}>
                <div className="row">
                  {d && <AgentLogo def={d} />}
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{t.name}</div>
                    <div className="small muted">
                      {describe(t)} · {projectName(t.projectId)} · {d?.name ?? t.agentId}
                    </div>
                  </div>
                  <button className="btn small" title="Run now" onClick={async () => {
                    const id = await api.runSchedule(t.id);
                    if (id) onOpenThread(id);
                  }}>
                    <Zap size={13} /> Run now
                  </button>
                  <button className="btn small" title={t.enabled ? 'Pause' : 'Resume'} onClick={async () => setTasks(await api.saveSchedule({ ...t, enabled: !t.enabled }))}>
                    {t.enabled ? <Pause size={13} /> : <Play size={13} />}
                  </button>
                  <button className="btn small" title="Edit" onClick={() => setDraft({ ...t })}>
                    <Pencil size={13} />
                  </button>
                  <button
                    className="btn small danger"
                    title="Delete"
                    onClick={async () => {
                      if (confirm(`Delete task "${t.name}"?`)) setTasks(await api.deleteSchedule(t.id));
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <div className="small" style={{ marginTop: 8, whiteSpace: 'pre-wrap', userSelect: 'text' }}>
                  {t.prompt}
                </div>
                <div className="small muted" style={{ marginTop: 6 }}>
                  {t.enabled && t.nextRun ? `Next run: ${new Date(t.nextRun).toLocaleString()}` : 'Paused / complete'}
                  {t.lastRun && (
                    <>
                      {' · '}Last run: {new Date(t.lastRun).toLocaleString()}
                      {t.lastThreadId && (
                        <>
                          {' · '}
                          <span className="link-like" style={{ color: 'var(--accent)' }} onClick={() => onOpenThread(t.lastThreadId!)}>
                            Open chat
                          </span>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
