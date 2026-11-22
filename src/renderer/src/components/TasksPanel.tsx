import { useCallback, useEffect, useRef, useState } from 'react';
import { Code2, CornerLeftUp, Loader2, ShieldAlert, Split, Workflow, X } from 'lucide-react';
import type { AgentDef, ContextUsage, ProcAction, RunningTask, SubTaskView, Thread } from '@shared/types';
import { api, onEvent } from '../api';
import { everyWhileVisible, useVisibleInterval } from '../visibility';
import { AgentLogo } from '../logos';
import { SessionStatsButton } from './TokenStats';
import { agentLabel, DoneList, finishedTools, LIVE, liveNow, PlanBox, RunCard, STATUS, TaskBrief } from './TaskSteps';
import { TaskCard } from './TaskSubagentCard';
import { ElicitationCard } from './ElicitationCard';
import { PanelSkeleton } from './Skeleton';
import { workspaceProjectId } from '@shared/worktree';

export { liveNow };
/** `loading`: this chat's list has not arrived yet (the panel shows a skeleton meanwhile). */
export type TasksData = { parent?: SubTaskView; children: SubTaskView[]; loading?: boolean };

/**
 * Live list of a session's sub-sessions (orchestrator workers, native CLI sub-agents, or user forks) and its parent.
 * Refreshes on the main process's events for any of them, keeping the Workbench tab badge and Tasks panel current.
 */
export function useTasks(threadId: string | undefined): TasksData {
  const [data, setData] = useState<TasksData>({ children: [] });
  const ids = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSig = useRef('');
  const load = useCallback(() => {
    if (!threadId) return;
    void api
      .tasks(threadId)
      .then((d) => {
        ids.current = new Set(d.children.map((c) => c.meta.id));
        const sig = JSON.stringify(d);
        if (sig === lastSig.current) return;
        lastSig.current = sig;
        setData(d);
      })
      .catch(() => setData((d) => (d.loading ? { ...d, loading: false } : d)));
  }, [threadId]);
  const soon = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      load();
    }, 180);
  }, [load]);
  useEffect(() => {
    lastSig.current = '';
    setData({ children: [], loading: Boolean(threadId) });
    ids.current = new Set();
    load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [load]);
  // On a phone the Mac streams only the chat on screen, so sub-sessions' progress is fetched every few seconds instead
  // (only while the page is on screen).
  useVisibleInterval(() => ids.current.size && load(), 2500, Boolean(window.desk.watch));
  useEffect(
    () =>
      onEvent((channel, payload) => {
        if (channel === 'thread:meta') {
          if (payload.parentId === threadId || ids.current.has(payload.id)) soon();
        } else if (channel === 'thread:deleted') {
          if (payload.parentId === threadId || ids.current.has(payload.id)) soon();
        } else if (channel === 'session:state' || channel === 'thread:item') {
          if (ids.current.has(payload.threadId)) soon();
        }
      }),
    [threadId, soon],
  );
  return data;
}

/** The programs the app started that are running right now, refreshed every 2 s while the panel is open and on screen. */
function useProcs(): [RunningTask[], (l: RunningTask[]) => void, boolean] {
  const [list, setList] = useState<RunningTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const lastSig = useRef('[]');
  const set = useCallback((l: RunningTask[]) => {
    const sig = JSON.stringify(l);
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    setList(l);
  }, []);
  useEffect(() => {
    let gone = false;
    const stop = everyWhileVisible(
      () =>
        void api
          .procs()
          .then((l) => !gone && set(l))
          .catch(() => {})
          .finally(() => !gone && setLoaded(true)),
      2000,
    );
    return () => {
      gone = true;
      stop();
    };
  }, [set]);
  return [list, set, loaded];
}

export function TasksPanel(props: {
  thread: Thread;
  data: TasksData;
  agentDefs: Record<string, AgentDef>;
  projectPath: string;
  running: boolean;
  onOpenThread: (id: string) => void;
  onShowTerminal?: (ptyId: string) => void;
}) {
  const { thread, data } = props;
  const [openId, setOpenId] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [allProcs, setProcs, procsLoaded] = useProcs();
  const now = liveNow(thread);
  const childIdSet = new Set(data.children.map((c) => c.meta.id));
  const parentProcs = allProcs.filter((p) => (p.source === 'agent' ? p.threadId === thread.id : p.projectId === thread.projectId || p.projectId === workspaceProjectId(thread)));
  const subagentProcs = allProcs.filter((p) => p.source === 'agent' && p.threadId && childIdSet.has(p.threadId));
  const liveChildren = data.children.filter((c) => LIVE.has(c.status));
  const doneChildren = data.children.filter((c) => !LIVE.has(c.status));
  const anyLive = liveChildren.length > 0 || props.running || now.tools.length > 0 || now.background.length > 0 || parentProcs.length > 0 || subagentProcs.length > 0;

  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [anyLive]);
  useEffect(() => setOpenId(null), [thread.id]);

  // Auto-open a sub-session or CLI sub-agent when it pauses for user permission, or when the first live CLI sub-agent starts.
  const waiting = data.children.find((c) => c.status === 'waiting-permission')?.meta.id;
  const singleLiveNative = liveChildren.length === 1 && liveChildren[0].meta.nativeSubagent ? liveChildren[0].meta.id : undefined;
  const autoOpened = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (waiting) setOpenId((o) => o ?? waiting);
  }, [waiting]);
  useEffect(() => {
    if (singleLiveNative && !autoOpened.current.has(singleLiveNative)) {
      autoOpened.current.add(singleLiveNative);
      setOpenId((o) => o ?? singleLiveNative);
    }
  }, [singleLiveNative]);

  const role = thread.spawnedBy ? 'Sub-session · worker' : thread.parentId ? 'Sub-session · fork' : thread.mode === 'chat' ? 'Main session' : 'Main session · orchestrator';
  const rel = (p: string) => (p.startsWith(`${props.projectPath}/`) ? p.slice(props.projectPath.length + 1) : p);
  const act = async (id: string, action: ProcAction) => setProcs(await api.procControl(id, action));

  const claimed = new Set<string>();
  const toolCards = [...now.tools.map((t) => ({ t, bg: false })), ...now.background.map((t) => ({ t, bg: true }))].map(({ t, bg }) => {
    const proc = parentProcs.find((p) => p.toolItemId === t.id);
    if (proc) claimed.add(proc.id);
    return { t, bg, proc };
  });
  const loose = parentProcs.filter((p) => !claimed.has(p.id));
  const runningCount = toolCards.length + loose.length + liveChildren.length;
  const done = finishedTools(thread);

  const card = (child: SubTaskView) => (
    <TaskCard
      key={child.meta.id}
      task={child}
      open={openId === child.meta.id}
      onToggle={() => setOpenId((o) => (o === child.meta.id ? null : child.meta.id))}
      agentDefs={props.agentDefs}
      rel={rel}
      procs={subagentProcs}
      onProcAction={act}
      onOpenThread={props.onOpenThread}
    />
  );

  return (
    <div className="tasks-panel" data-testid="tasks-panel">
      <div className="tasks-head">
        <div className="row" style={{ gap: 8 }}>
          <Workflow size={15} className="muted" />
          <span className="tasks-role">{role}</span>
          <span className="small muted ellipsis" title={thread.id}>
            {thread.id.slice(0, 8)}
          </span>
          <span className="grow" />
          <span className={`session-state ${props.running || liveChildren.length > 0 || now.background.length || parentProcs.some((p) => p.threadId === thread.id) ? 'live' : ''}`}>
            {props.running || liveChildren.length > 0 ? <Loader2 size={12} className="spin" /> : <span className="live-dot" />}
            {props.running || liveChildren.length > 0 ? 'working' : now.background.length || parentProcs.some((p) => p.threadId === thread.id) ? 'background work' : 'idle'}
          </span>
        </div>
        {data.parent && (
          <div className="tasks-parent link-like" onClick={() => props.onOpenThread(data.parent!.meta.id)} title="Open the parent session">
            <CornerLeftUp size={13} />
            {props.agentDefs[data.parent.meta.agentId] && <AgentLogo def={props.agentDefs[data.parent.meta.agentId]} size={16} />}
            <span className="ellipsis">{data.parent.meta.title}</span>
            <span className={`task-badge ${STATUS[data.parent.status].cls}`}>{STATUS[data.parent.status].label}</span>
          </div>
        )}
        {thread.task && <TaskBrief text={thread.task} />}
      </div>

      {now.perms.map((p) => (
        <div key={p.id} className="live-perm">
          <div className="row small" style={{ gap: 6 }}>
            <ShieldAlert size={13} className="warn-text" />
            <b>Waiting for your permission</b>
          </div>
          <div className="live-perm-title">{p.title}</div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {p.options.map((o) => (
              <button key={o.optionId} className={`btn small ${o.kind.startsWith('allow') ? 'primary' : ''}`} onClick={() => void api.permission(thread.id, p.id, o.optionId)}>
                {o.name}
              </button>
            ))}
          </div>
        </div>
      ))}
      {now.asks.map((a) => (
        <ElicitationCard key={a.id} item={a} threadId={thread.id} agentName={props.agentDefs[a.agentId]?.name ?? 'The agent'} compact />
      ))}

      <div className="tasks-section" data-testid="tasks-running-section">
        <div className="tasks-section-head">
          <span>Running</span>
          {runningCount > 0 && <span className="count">{runningCount}</span>}
        </div>
        {liveChildren.map(card)}
        {toolCards.map(({ t, bg, proc }) => (
          <RunCard
            key={t.id}
            title={t.title}
            label={bg ? 'In the background' : agentLabel(props.agentDefs, t.agentId)}
            agent={props.agentDefs[t.agentId]}
            since={t.ts}
            proc={proc}
            tool={t}
            threadId={thread.id}
            isBackground={bg}
            rel={rel}
            onAction={act}
            onOpen={proc?.ptyId && props.onShowTerminal ? () => props.onShowTerminal!(proc.ptyId!) : undefined}
          />
        ))}
        {loose.map((p) => (
          <RunCard
            key={p.id}
            title={p.title}
            label={p.source === 'terminal' ? 'Terminal' : agentLabel(props.agentDefs, p.agentId)}
            agent={p.agentId ? props.agentDefs[p.agentId] : undefined}
            proc={p}
            rel={rel}
            onAction={act}
            onOpen={p.ptyId && props.onShowTerminal ? () => props.onShowTerminal!(p.ptyId!) : undefined}
          />
        ))}
        {!runningCount && (data.loading || !procsLoaded) && <PanelSkeleton rows={2} head={false} />}
        {!runningCount && !data.loading && procsLoaded && (
          <div className="tasks-none small muted">{props.running ? 'The agent is thinking — commands and sub-agents it runs show up here.' : 'Nothing running.'}</div>
        )}
      </div>

      {now.plan.length > 0 && <PlanBox entries={now.plan} />}

      {(done.length > 0 || doneChildren.length > 0) && (
        <div className="tasks-section" data-testid="tasks-done-section">
          <div className="tasks-section-head">
            <span>Done</span>
            <span className="count">{done.length + doneChildren.length}</span>
          </div>
          {doneChildren.map(card)}
          <DoneList thread={thread} items={done} rel={rel} />
        </div>
      )}

      {!data.children.length && !thread.parentId && (
        <p className="tasks-hint small muted">
          <Workflow size={13} /> Sub-sessions and native CLI sub-agents run in parallel and show up here live. You can also fork this chat yourself (
          <Split size={11} className="fork-icon" />
          ).
        </p>
      )}
    </div>
  );
}

/** Standalone right-side Tasks workbench used in Chat mode (or General workspace) when tasks/sub-agents are opened. */
export function ChatTasksWorkbench(props: {
  thread: Thread;
  projectPath: string;
  agentDefs: Record<string, AgentDef>;
  running: boolean;
  sessionUsage?: ContextUsage;
  onOpenThread: (id: string) => void;
  onFork?: () => void;
  onSwitchToCode?: () => void;
  onClose: () => void;
}) {
  const tasks = useTasks(props.thread.id);
  const now = liveNow(props.thread);
  const liveCount = tasks.children.filter((c) => LIVE.has(c.status)).length + now.tools.length + now.background.length;
  const needsYou = tasks.children.some((c) => c.status === 'waiting-permission') || now.perms.length > 0 || now.asks.length > 0;
  const label = liveCount ? `Tasks (${liveCount})` : tasks.children.length ? `Tasks · ${tasks.children.length}` : 'Tasks';

  return (
    <div className="workbench">
      <div className="workbench-tabs">
        <button className="active" data-testid="wb-tasks" title={label}>
          <Workflow size={14} className={needsYou ? 'warn-text' : liveCount ? 'pulse' : ''} /> <span className="wb-label">{label}</span>
        </button>
        <div className="spacer" />
        <span className="wb-sheet-action">
          <SessionStatsButton thread={props.thread} usage={props.sessionUsage} agentDefs={props.agentDefs} />
        </span>
        {props.onSwitchToCode && (
          <button className="btn ghost small wb-sheet-action" data-testid="wb-switch-code" title="Open this project in Code mode" onClick={props.onSwitchToCode}>
            <Code2 size={14} /> Code
          </button>
        )}
        {props.onFork && (
          <button
            className="btn ghost icon wb-sheet-action"
            data-testid="wb-fork"
            title="Fork: start a new sub-session from this whole chat"
            aria-label="Fork chat"
            onClick={props.onFork}
          >
            <Split size={16} className="fork-icon" />
          </button>
        )}
        <button className="btn ghost icon" title="Close panel" aria-label="Close panel" data-testid="wb-close" onClick={props.onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="workbench-body">
        <div className="wb-pane" style={{ display: 'flex' }}>
          <TasksPanel
            thread={props.thread}
            data={tasks}
            agentDefs={props.agentDefs}
            projectPath={props.projectPath}
            running={props.running}
            onOpenThread={props.onOpenThread}
          />
        </div>
      </div>
    </div>
  );
}
