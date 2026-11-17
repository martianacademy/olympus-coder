import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ChevronDown, ChevronRight, CornerDownLeft, ExternalLink, FileCode2, ShieldAlert, Square } from 'lucide-react';
import type { AgentDef, ProcAction, RunningTask, SubTaskView, Thread, ThreadItem } from '@shared/types';
import { withItem } from '@shared/itemOrder';
import { api, onEvent, remoteWatch } from '../api';
import { composeInChat } from '../compose';
import { LinkedText } from '../fileLinks';
import { AgentLogo } from '../logos';
import { useStickToBottom } from '../useStickToBottom';
import { Transcript } from './Chat';
import { ElicitationCard } from './ElicitationCard';
import { agentLabel, DoneList, finishedTools, fmtDur, LIVE, liveNow, plain, PlanBox, RunCard, STATUS } from './TaskSteps';

async function useAnswer(c: SubTaskView, agentName = 'Another agent') {
  const t = await api.taskThread(c.meta.id);
  const reply = [...(t?.items ?? [])].reverse().find((i) => i.kind === 'agent');
  if (!reply || reply.kind !== 'agent') return;
  composeInChat(`${agentName} looked at this as a second opinion. Check its answer, and apply the fix if it's right:\n\n${reply.text.trim()}`);
}

export interface TaskCardProps {
  task: SubTaskView;
  open: boolean;
  onToggle: () => void;
  agentDefs: Record<string, AgentDef>;
  rel: (p: string) => string;
  procs: RunningTask[];
  onProcAction: (id: string, action: ProcAction) => Promise<void>;
  onOpenThread: (id: string) => void;
}

/**
 * Expandable sub-session / CLI sub-agent card in the right-side Tasks panel.
 * Shows live status, role, model, current tool/thought activity, inline permission approval,
 * Stop action, and a dual `Live feed | Steps` inspector covering every action of the sub-agent.
 */
export function TaskCard(props: TaskCardProps) {
  const { task: c } = props;
  const st = STATUS[c.status];
  const live = LIVE.has(c.status);
  const def = props.agentDefs[c.meta.agentId];
  const elapsed = c.startedAt ? fmtDur((c.endedAt ?? Date.now()) - c.startedAt) : '';
  const isNative = Boolean(c.meta.nativeSubagent);
  const canStop = live && Boolean(c.meta.spawnedBy || c.meta.secondOpinion || c.canCancel);

  return (
    <div className={`task-card ${st.cls} ${props.open ? 'open' : ''}`} data-testid={`task-card-${c.meta.id}`} data-native-subagent={isNative ? '1' : '0'}>
      <div className="task-card-head" onClick={props.onToggle} data-testid="task-card-toggle">
        <span className={`task-status ${st.cls}`} title={st.label}>
          {st.icon}
        </span>
        {def && <AgentLogo def={def} size={18} />}
        <span className="grow ellipsis task-title" title={c.meta.title}>
          {c.meta.title}
        </span>
        <span className="small muted task-time">{elapsed}</span>
        {props.open ? <ChevronDown size={14} className="muted" /> : <ChevronRight size={14} className="muted" />}
      </div>

      <div className="task-card-sub">
        {live && c.activity ? (
          <span className={`ellipsis ${c.status === 'waiting-permission' ? 'warn-text' : 'shimmer'}`} title={c.activity}>
            {c.activity}
          </span>
        ) : c.error && c.status === 'failed' ? (
          <span className="error-text ellipsis" title={c.error}>
            {c.error}
          </span>
        ) : c.lastReply ? (
          <span className="task-reply">{plain(c.lastReply)}</span>
        ) : (
          <span className="muted">{st.label}</span>
        )}
      </div>

      <div className="task-card-meta small muted">
        <span className={`task-badge ${st.cls}`}>{st.label}</span>
        {isNative ? (
          <>
            <span className="task-origin-pill">CLI sub-agent</span>
            {c.meta.subagentRole && (
              <span className="task-role-pill" title={`Role: ${c.meta.subagentRole}`}>
                {c.meta.subagentRole}
              </span>
            )}
            {c.meta.subagentModel && (
              <span className="task-model-pill mono" title={`Model: ${c.meta.subagentModel}`}>
                {c.meta.subagentModel}
              </span>
            )}
          </>
        ) : (
          <span>{c.meta.secondOpinion ? 'second opinion' : c.meta.spawnedBy ? 'spawned' : 'fork'}</span>
        )}
        <span>· {c.toolCount} steps</span>
        {c.filesTouched.length > 0 && <span title={c.filesTouched.map(props.rel).join('\n')}>· {c.filesTouched.length} files</span>}
        <span className="spacer" />
        {c.meta.secondOpinion && c.status === 'done' && (
          <button className="btn small primary" title="Put this answer into your chat's message box" onClick={() => void useAnswer(c, def?.name)}>
            <CornerDownLeft size={12} /> Use this answer
          </button>
        )}
        {canStop && (
          <button className="btn ghost small" title="Stop this sub-agent" data-testid="subagent-stop" onClick={() => void api.cancel(c.meta.id)}>
            <Square size={11} fill="currentColor" /> Stop
          </button>
        )}
        {!isNative && (
          <button className="btn ghost small" title="Open this sub-session" onClick={() => props.onOpenThread(c.meta.id)}>
            <ExternalLink size={12} /> Open
          </button>
        )}
      </div>

      {props.open && (
        <SubagentInspector
          id={c.meta.id}
          running={live}
          filesTouched={c.filesTouched}
          agentDefs={props.agentDefs}
          rel={props.rel}
          procs={props.procs}
          onProcAction={props.onProcAction}
        />
      )}
    </div>
  );
}

function SubagentInspector(props: {
  id: string;
  running: boolean;
  filesTouched: string[];
  agentDefs: Record<string, AgentDef>;
  rel: (p: string) => string;
  procs: RunningTask[];
  onProcAction: (id: string, action: ProcAction) => Promise<void>;
}) {
  const { id, running, agentDefs, rel } = props;
  const [t, setT] = useState<Thread | null>(null);
  const [view, setView] = useState<'feed' | 'steps'>('feed');
  const [showPrompt, setShowPrompt] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const { away, jumpToBottom } = useStickToBottom(box, inner, t ? `${id}:${view}` : `${id}:loading`, t?.items);

  useEffect(() => {
    let alive = true;
    const unwatch = remoteWatch('thread', id);
    void api.taskThread(id).then((x) => alive && setT(x));
    const off = onEvent((channel, payload) => {
      if (channel === 'thread:item' && payload.threadId === id) {
        const item = payload.item as ThreadItem;
        setT((cur) => (cur ? { ...cur, items: withItem(cur.items, item) } : cur));
      } else if (channel === 'thread:meta' && payload.id === id) {
        setT((cur) => (cur ? { ...cur, ...payload } : cur));
      }
    });
    return () => {
      alive = false;
      unwatch();
      off();
    };
  }, [id]);

  if (!t) return <div className="small muted" style={{ padding: 10 }}>Loading…</div>;

  const now = liveNow(t);
  const doneSteps = finishedTools(t);
  const totalSteps = now.tools.length + now.background.length + doneSteps.length;
  const subProcs = props.procs.filter((p) => p.threadId === t.id);

  return (
    <div className="subagent-inspector" data-testid="subagent-inspector">
      {now.perms.map((p) => (
        <div key={p.id} className="live-perm" style={{ margin: '8px 10px 0' }} data-testid="subagent-perm">
          <div className="row small" style={{ gap: 6 }}>
            <ShieldAlert size={13} className="warn-text" />
            <b>Sub-agent needs your permission</b>
          </div>
          <div className="live-perm-title">{p.title}</div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {p.options.map((o) => (
              <button key={o.optionId} className={`btn small ${o.kind.startsWith('allow') ? 'primary' : ''}`} onClick={() => void api.permission(t.id, p.id, o.optionId)}>
                {o.name}
              </button>
            ))}
          </div>
        </div>
      ))}
      {now.asks.map((a) => (
        <div key={a.id} style={{ margin: '8px 10px 0' }} data-testid="subagent-ask">
          <ElicitationCard item={a} threadId={t.id} agentName={agentDefs[a.agentId]?.name ? `${agentDefs[a.agentId].name} sub-agent` : 'The sub-agent'} compact />
        </div>
      ))}

      <div className="subagent-toolbar">
        <div className="subagent-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={view === 'feed'} className={view === 'feed' ? 'active' : ''} onClick={() => setView('feed')} data-testid="subagent-tab-feed">
            Live feed
          </button>
          <button type="button" role="tab" aria-selected={view === 'steps'} className={view === 'steps' ? 'active' : ''} onClick={() => setView('steps')} data-testid="subagent-tab-steps">
            Steps ({totalSteps})
          </button>
        </div>
        {t.task && (
          <button type="button" className="btn ghost small muted" onClick={() => setShowPrompt((s) => !s)} data-testid="subagent-prompt-toggle">
            {showPrompt ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Task prompt
          </button>
        )}
      </div>

      {showPrompt && t.task && (
        <div className="subagent-prompt-box" data-testid="subagent-prompt-box">
          <b className="small">Instructions from parent agent</b>
          <div className="subagent-prompt-body">{t.task}</div>
        </div>
      )}

      {view === 'feed' ? (
        <div className="task-transcript" ref={box} tabIndex={-1} style={{ borderTop: 'none' }}>
          <div ref={inner}>
            <Transcript thread={t} agentDefs={agentDefs} running={running} />
          </div>
          {away && (
            <div className="jump-latest-wrap">
              <button type="button" className={`btn small jump-latest ${running ? 'is-live' : ''}`} onClick={jumpToBottom}>
                <ArrowDown size={13} />
                <span>{running ? 'Follow live' : 'Jump to latest'}</span>
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="subagent-steps-pane" data-testid="subagent-steps-pane">
          {props.filesTouched.length > 0 && (
            <div className="subagent-files-bar">
              <FileCode2 size={13} className="muted" />
              <span className="muted">Files changed:</span>
              {props.filesTouched.map((fp) => (
                <span key={fp} className="mono">
                  <LinkedText text={rel(fp)} />
                </span>
              ))}
            </div>
          )}
          {[...now.tools.map((tool) => ({ tool, bg: false })), ...now.background.map((tool) => ({ tool, bg: true }))].map(({ tool, bg }) => (
            <RunCard
              key={tool.id}
              title={tool.title}
              label={bg ? 'In the background' : agentLabel(agentDefs, tool.agentId)}
              agent={agentDefs[tool.agentId]}
              since={tool.ts}
              proc={subProcs.find((p) => p.toolItemId === tool.id)}
              tool={tool}
              threadId={t.id}
              isBackground={bg}
              rel={rel}
              onAction={props.onProcAction}
            />
          ))}
          {now.plan.length > 0 && <PlanBox entries={now.plan} />}
          {doneSteps.length > 0 ? (
            <DoneList thread={t} items={doneSteps} rel={rel} limit={Infinity} />
          ) : (
            !now.tools.length && !now.background.length && <div className="small muted">No tool steps recorded yet.</div>
          )}
        </div>
      )}
    </div>
  );
}
