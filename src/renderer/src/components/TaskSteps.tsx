import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock,
  FilePen,
  FileText,
  Globe,
  Loader2,
  Pause,
  Play,
  Search,
  ShieldAlert,
  Square,
  SquareTerminal,
  Trash2,
} from 'lucide-react';
import type { AgentDef, ProcAction, RunningTask, SubTaskView, Thread, ThreadItem } from '@shared/types';
import { api } from '../api';
import { everyWhileVisible } from '../visibility';
import { copyText } from '../clipboard';
import { stripAnsi } from '../compose';
import { LinkedText } from '../fileLinks';
import { AgentLogo } from '../logos';
import { parseToolStep } from '../toolStep';

export type ToolItem = Extract<ThreadItem, { kind: 'tool' }>;
export type PermItem = Extract<ThreadItem, { kind: 'permission' }>;
export type AskItem = Extract<ThreadItem, { kind: 'elicitation' }>;

export const LIVE = new Set<SubTaskView['status']>(['starting', 'running', 'waiting-permission']);

export const STATUS: Record<SubTaskView['status'], { label: string; icon: React.ReactNode; cls: string }> = {
  starting: { label: 'Starting', icon: <Loader2 size={14} className="spin" />, cls: 'live' },
  running: { label: 'Running', icon: <Loader2 size={14} className="spin" />, cls: 'live' },
  'waiting-permission': { label: 'Needs your approval', icon: <ShieldAlert size={14} />, cls: 'warn' },
  done: { label: 'Done', icon: <CircleCheck size={14} />, cls: 'ok' },
  failed: { label: 'Failed', icon: <CircleX size={14} />, cls: 'bad' },
  cancelled: { label: 'Cancelled', icon: <CircleSlash size={14} />, cls: 'muted' },
  'needs-login': { label: 'Needs login', icon: <ShieldAlert size={14} />, cls: 'warn' },
  'quota-exceeded': { label: 'Limit reached', icon: <ShieldAlert size={14} />, cls: 'warn' },
  idle: { label: 'Idle', icon: <Clock size={14} />, cls: 'muted' },
};

export const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** A report's first lines without Markdown marks, for the card preview. */
export const plain = (md: string) =>
  md
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/\|?\s*:?-{3,}:?\s*/g, ' ')
    .replace(/[*_`#>|]+/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

export const agentLabel = (defs: Record<string, AgentDef>, id?: string) => (id ? (defs[id]?.name ?? id) : 'Agent');

/** CPU summed over a program's processes, in percent of one core: above one full core it is "warm", above three "hot". */
const heat = (cpu: number) => (!Number.isFinite(cpu) ? '' : cpu >= 300 ? 'hot' : cpu >= 100 ? 'warm' : '');

/** How a step reads: a file (name stands out, folder quiet), a command (mono), or plain text. */
function stepParts(title: string, kind: string | undefined, rel: (p: string) => string): { type: 'file' | 'cmd' | 'text'; main: string; dim: string } {
  const t = title.split('\n')[0].replace(/^Run in terminal: /, '');
  const file = /^(?:File|Read|Edit|Write|Delete|Move)\s+(.+)$/.exec(t);
  if (file && !/\s/.test(file[1].trim())) {
    const path = rel(file[1].trim());
    const at = path.lastIndexOf('/');
    return { type: 'file', main: at >= 0 ? path.slice(at + 1) : path, dim: at >= 0 ? path.slice(0, at) : '' };
  }
  if (kind === 'execute' || /^(cd |bash |sh |python|node |npm |npx |git |ls|cat |sleep |make |go |cargo |colab )/.test(t)) {
    return { type: 'cmd', main: t.replace(/^(cd\s+\S+\s*&&\s*)+/, ''), dim: '' };
  }
  return { type: 'text', main: t, dim: '' };
}

function useTerminalTail(ptyId: string | undefined, on: boolean, lines = 14): string {
  const [text, setText] = useState('');
  useEffect(() => {
    if (!ptyId || !on) return;
    let gone = false;
    const load = () =>
      void api.ptyBuffer(ptyId).then((b) => {
        if (gone) return;
        const rows = stripAnsi(b.data).split('\n').map((l) => l.trimEnd());
        setText(rows.filter((l, i) => l || i > rows.length - 3).slice(-lines).join('\n'));
      });
    const stop = everyWhileVisible(load, 1500);
    return () => {
      gone = true;
      stop();
    };
  }, [ptyId, on, lines]);
  return text;
}

export function RunCard(props: {
  title: string;
  label: string;
  agent?: AgentDef;
  since?: number;
  proc?: RunningTask;
  tool?: ToolItem;
  threadId?: string;
  isBackground?: boolean;
  rel: (p: string) => string;
  onAction: (id: string, action: ProcAction) => Promise<void>;
  onOpen?: () => void;
}) {
  const { proc, tool } = props;
  const [busy, setBusy] = useState<ProcAction | 'inside' | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const tail = useTerminalTail(proc?.ptyId, open);
  const run = async (a: ProcAction) => {
    if (!proc) return;
    setBusy(a);
    setError('');
    try {
      await props.onAction(proc.id, a);
      if (a === 'stop' && props.isBackground && props.threadId && tool) {
        await api.stopTool(props.threadId, tool.id).catch(() => {});
      }
    } catch (e: any) {
      setError(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy(null);
    }
  };
  const stopInside = async () => {
    if (!props.threadId || !tool) return;
    setBusy('inside');
    setError('');
    try {
      await api.stopTool(props.threadId, tool.id);
    } catch (e: any) {
      setError(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy(null);
    }
  };
  const elapsed = proc ? proc.secs * 1000 : props.since ? Date.now() - props.since : 0;
  const parsedTool = tool ? parseToolStep(tool) : undefined;
  const parts = stepParts(parsedTool?.isCommand ? parsedTool.command : props.title, parsedTool?.isCommand ? 'execute' : tool?.toolKind, props.rel);
  const runSummary = parsedTool?.summary;
  const output = parsedTool?.output ?? '';
  return (
    <div className={`run-card ${proc?.paused ? 'paused' : ''} ${proc ? heat(proc.cpu) : ''} ${open ? 'open' : ''}`} data-testid="run-card">
      <div className="run-card-head" onClick={() => setOpen((o) => !o)} title={open ? 'Hide details' : 'Show what it is doing'}>
        <span className="run-chev">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
        <span className="run-icon">{proc?.paused ? <Pause size={13} /> : <Loader2 size={13} className="spin" />}</span>
        <span className={`run-title ${parts.type === 'cmd' ? 'mono' : ''} ellipsis`}>
          {parts.type === 'cmd' ? (
            <>
              {parts.main}
              {runSummary && <span className="run-dim">  # {runSummary}</span>}
            </>
          ) : runSummary ? (
            runSummary
          ) : (
            <>
              {parts.main}
              {parts.dim && <span className="run-dim"> {parts.dim}</span>}
            </>
          )}
        </span>
        {(proc || (props.threadId && tool)) && (
          <div className="run-actions" onClick={(e) => e.stopPropagation()}>
            {proc?.canPause &&
              (proc.paused ? (
                <button className="btn small run-btn" disabled={!!busy} onClick={() => void run('resume')} title="Resume (SIGCONT)">
                  <Play size={12} /> Resume
                </button>
              ) : (
                <button className="btn small run-btn" disabled={!!busy} onClick={() => void run('pause')} title="Pause right away (SIGSTOP)">
                  <Pause size={12} /> Pause
                </button>
              ))}
            <button
              className="btn small run-btn danger"
              data-testid="run-card-stop"
              disabled={busy === 'stop' || busy === 'inside'}
              onClick={() => void (proc ? run('stop') : stopInside())}
              title={proc ? 'Stop process now' : 'Cancel / clear stuck step'}
            >
              <Square size={11} /> Stop
            </button>
          </div>
        )}
      </div>
      <div className="run-meta small muted">
        {props.agent ? <AgentLogo def={props.agent} size={13} /> : props.label === 'Terminal' ? <SquareTerminal size={12} /> : null}
        <span>{props.label}</span>
        {elapsed > 0 && <span>{fmtDur(elapsed)}</span>}
        {proc?.paused && <span className="run-paused">paused</span>}
        {proc && Number.isFinite(proc.cpu) && <span className={`run-cpu ${heat(proc.cpu)}`}>CPU {Math.round(proc.cpu)}%</span>}
        {proc && <span>{proc.memMB >= 1024 ? `${(proc.memMB / 1024).toFixed(1)} GB` : `${proc.memMB} MB`}</span>}
        {!proc && <span>inside the agent</span>}
      </div>
      {error && <div className="run-error small">{error}</div>}
      {open && (
        <div className="run-detail">
          <div className="run-full mono">{(proc?.command ?? props.title).replace(/^Run in terminal: /, '')}</div>
          {proc?.ptyId ? (
            <>
              <div className="run-detail-label">
                Live output
                {props.onOpen && (
                  <button className="link-btn small" onClick={props.onOpen}>
                    Open in Terminal
                  </button>
                )}
              </div>
              <pre className="run-tail">{tail || 'No output yet.'}</pre>
            </>
          ) : output ? (
            <>
              <div className="run-detail-label">Output so far</div>
              <pre className="run-tail">
                <LinkedText text={output.split('\n').slice(-20).join('\n')} />
              </pre>
            </>
          ) : (
            <div className="small muted">{proc ? "The agent hasn't shared this command's output yet." : 'This step runs inside the agent; there is no output to show yet.'}</div>
          )}
        </div>
      )}
    </div>
  );
}

const ago = (ts: number) => {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

const KIND_INFO: Record<string, { label: string; tone: string; icon: React.ReactNode }> = {
  read: { label: 'Read', tone: 'var(--muted)', icon: <FileText size={14} /> },
  edit: { label: 'Edited', tone: 'var(--muted)', icon: <FilePen size={14} /> },
  delete: { label: 'Deleted', tone: 'var(--muted)', icon: <Trash2 size={14} /> },
  move: { label: 'Moved', tone: 'var(--muted)', icon: <FileText size={14} /> },
  search: { label: 'Searched', tone: 'var(--muted)', icon: <Search size={14} /> },
  execute: { label: 'Ran', tone: 'var(--muted)', icon: <SquareTerminal size={14} /> },
  fetch: { label: 'Fetched', tone: 'var(--muted)', icon: <Globe size={14} /> },
  think: { label: 'Thought', tone: 'var(--muted)', icon: <CircleCheck size={14} /> },
};

function CopyBtn({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn ghost small step-copy"
      onClick={(e) => {
        e.stopPropagation();
        void copyText(text).then((ok) => {
          if (!ok) return;
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

export function DoneList({ thread, items, rel, limit }: { thread: Thread; items: ToolItem[]; rel: (p: string) => string; limit: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const owner = new Map<string, { id: string; text: string; ts: number }>();
  let cur: { id: string; text: string; ts: number } | undefined;
  for (const it of thread.items) {
    if (it.kind === 'user') cur = { id: it.id, text: it.text, ts: it.ts };
    else if (it.kind === 'tool' && cur) owner.set(it.id, cur);
  }
  const shown = items.slice(0, limit);
  const groups: { key: string; head?: { text: string; ts: number }; items: ToolItem[] }[] = [];
  for (const t of shown) {
    const o = owner.get(t.id);
    const key = o?.id ?? 'none';
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(t);
    else groups.push({ key, head: o, items: [t] });
  }
  return (
    <div className="done-list">
      {groups.map((g) => (
        <div key={g.key + g.items[0].id} className="done-group">
          {g.head && (
            <div className="done-group-head" title={g.head.text}>
              <span className="ellipsis grow">{g.head.text.replace(/\s+/g, ' ').slice(0, 120) || 'Message'}</span>
              <span className="done-when">{ago(g.head.ts)}</span>
            </div>
          )}
          {g.items.map((t) => (
            <StepCard key={t.id} t={t} rel={rel} open={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function StepCard({ t, rel, open, onToggle }: { t: ToolItem; rel: (p: string) => string; open: boolean; onToggle: () => void }) {
  const parsed = parseToolStep(t);
  const parts = stepParts(parsed.isCommand ? parsed.command : t.title, parsed.isCommand ? 'execute' : t.toolKind, rel);
  const code = parsed.exitCode;
  const bad = t.status === 'failed' || (code !== undefined && code !== 0);
  const stopped = t.status === 'interrupted';
  const kind = t.olympus && !parsed.isCommand ? undefined : KIND_INFO[parsed.isCommand ? 'execute' : (t.toolKind ?? '')];
  const info = kind ?? { label: t.olympus ? 'Olympus' : 'Step', tone: 'var(--muted)', icon: <CircleCheck size={14} /> };
  const diffs = open ? t.content.filter((c) => c.type === 'diff') : [];
  const dur = parsed.durationMs && parsed.durationMs >= 1000 ? fmtDur(parsed.durationMs) : '';
  const cmdText = parsed.command || t.title;
  return (
    <div className={`step-card ${bad ? 'failed' : ''} ${stopped ? 'stopped' : ''} ${open ? 'open' : ''}`} style={{ ['--tone' as any]: info.tone }}>
      <button className="step-head" onClick={onToggle} title={cmdText}>
        <span className="step-icon">{bad ? <CircleX size={14} /> : stopped ? <CircleSlash size={14} /> : info.icon}</span>
        <span className="step-main">
          <span className={`step-title ellipsis ${!parsed.summary && parts.type === 'cmd' ? 'mono' : ''}`}>
            {parsed.summary ? (
              parsed.summary
            ) : (
              <>
                {parts.main}
              </>
            )}
          </span>
          <span className="step-sub ellipsis">
            {info.label}
            {parsed.summary && parts.type === 'cmd' ? ` · ${parts.main}` : parts.dim ? ` · ${parts.dim}` : ''}
          </span>
        </span>
        {code !== undefined ? <span className={`step-pill ${bad ? 'bad' : ''}`}>exit {code}</span> : bad ? <span className="step-pill bad">failed</span> : stopped ? <span className="step-pill">stopped</span> : null}
        {dur && <span className="step-dur">{dur}</span>}
        <ChevronRight size={14} className="step-chev" />
      </button>
      {open && (
        <div className="step-body">
          {parts.type === 'cmd' ? (
            <div className="step-block">
              <div className="step-block-head">
                <span>Command</span>
                <CopyBtn text={cmdText} label="Copy" />
              </div>
              <pre className="step-pre mono">{cmdText}</pre>
            </div>
          ) : (
            parts.type === 'file' && <div className="step-path mono">{t.locations.length ? t.locations.map(rel).join('\n') : parts.dim ? `${parts.dim}/${parts.main}` : parts.main}</div>
          )}
          {parsed.input && parts.type !== 'cmd' && (
            <div className="step-block">
              <div className="step-block-head">
                <span>Input</span>
              </div>
              <pre className="step-pre mono small-pre">{parsed.input.length > 3000 ? `${parsed.input.slice(0, 3000)}\n…` : parsed.input}</pre>
            </div>
          )}
          {diffs.map((d, i) => {
            const oldL = (d.oldText ?? '').split('\n');
            const newL = (d.newText ?? '').split('\n');
            return (
              <div key={i} className="step-block">
                <div className="step-block-head">
                  <span>Changes{d.path ? ` · ${rel(d.path)}` : ''}</span>
                  <span className="step-diffstat">
                    <span className="add">+{d.newText ? newL.length : 0}</span> <span className="del">−{d.oldText ? oldL.length : 0}</span>
                  </span>
                </div>
                <pre className="step-pre mono step-diff">
                  {d.oldText ? oldL.slice(0, 40).map((l, j) => <div key={`o${j}`} className="diff-del">- {l}</div>) : null}
                  {newL.slice(0, 60).map((l, j) => <div key={`n${j}`} className="diff-add">+ {l}</div>)}
                  {newL.length > 60 && <div className="muted">… {newL.length - 60} more lines</div>}
                </pre>
              </div>
            );
          })}
          {parsed.output ? (
            <div className="step-block">
              <div className="step-block-head">
                <span>
                  Response
                  {code !== undefined && <span className={`step-code ${bad ? 'bad' : ''}`}>exit {code}</span>}
                </span>
                <CopyBtn text={parsed.output} label="Copy response" />
              </div>
              <pre className="step-pre mono">
                <LinkedText text={parsed.output.length > 8000 ? `${parsed.output.slice(0, 8000)}\n… (${parsed.output.length - 8000} more characters)` : parsed.output} />
              </pre>
            </div>
          ) : (
            !diffs.length && <div className="small muted">{parsed.isCommand && !bad ? 'No output (completed silently).' : 'No output was shared for this step.'}</div>
          )}
          <div className="step-meta">
            {new Date(t.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            {dur ? ` · took ${dur}` : ''}
          </div>
        </div>
      )}
    </div>
  );
}

export function PlanBox({ entries }: { entries: ReturnType<typeof liveNow>['plan'] }) {
  const done = entries.filter((e) => e.status === 'completed').length;
  return (
    <div className="tasks-section">
      <div className="tasks-section-head">
        <span>Plan</span>
        <span className="count">
          {done}/{entries.length}
        </span>
      </div>
      <div className="live-group">
        {entries.map((e, i) => (
          <div key={i} className={`live-row plan-${e.status}`}>
            {e.status === 'completed' ? <CircleCheck size={13} className="ok-text" /> : e.status === 'in_progress' ? <Loader2 size={13} className="spin live-spin" /> : <Clock size={13} className="muted" />}
            <span className="grow">{e.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function liveNow(thread: Thread) {
  const items = thread.items;
  let lastUser = -1;
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user') ((lastUser = i), (i = -1));
  const turn = items.slice(lastUser + 1);
  const plan = [...items].reverse().find((i) => i.kind === 'plan');
  const isSubagentWrapper = (i: ToolItem) => Boolean(i.toolCallId?.startsWith('subagent:'));
  const isLive = (i: ThreadItem): i is ToolItem =>
    i.kind === 'tool' && (i.status === 'pending' || i.status === 'in_progress') && !isSubagentWrapper(i);
  const tools = turn.filter(isLive);
  const background = items.slice(0, lastUser + 1).filter(isLive);
  const perms = items.filter((i): i is PermItem => i.kind === 'permission' && !i.resolved);
  const asks = items.filter((i): i is AskItem => i.kind === 'elicitation' && !i.resolved);
  return { plan: plan?.kind === 'plan' && !plan.removed ? plan.entries : [], tools, background, perms, asks };
}

export function finishedTools(thread: Thread): ToolItem[] {
  return thread.items
    .filter((i): i is ToolItem => i.kind === 'tool' && i.status !== 'pending' && i.status !== 'in_progress' && !i.toolCallId?.startsWith('subagent:'))
    .sort((a, b) => (b.endedAt ?? b.ts) - (a.endedAt ?? a.ts))
    .slice(0, 80);
}

export function TaskBrief({ text, label = 'Task from the orchestrator' }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="task-brief">
      <button className="btn ghost small muted" onClick={() => setOpen((o) => !o)} style={{ paddingLeft: 2 }}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {label}
      </button>
      {open && <div className="task-brief-body">{text}</div>}
    </div>
  );
}
