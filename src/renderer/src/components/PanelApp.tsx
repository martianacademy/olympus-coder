import { useCallback, useEffect, useRef, useState } from 'react';
import { PanelRightClose } from 'lucide-react';
import { withItem } from '@shared/itemOrder';
import { PANEL_TITLES, type PanelContext, type PanelTool } from '@shared/panels';
import type { AgentDef, AgentStatus, AppState, DeskEvents, Project, SessionView, Thread, ThreadItem, ThreadMeta } from '@shared/types';
import { api, onEvent } from '../api';
import { parseWorktreeProjectId, workspaceProjectId } from '@shared/worktree';
import { applyTheme, onSystemThemeChange } from '../theme';
import { addTerminal, Workbench, type WorkbenchHandle } from './Workbench';

/**
 * A detached Workbench tool (`?panel=<tool>`, opened by src/main/panels.ts): only that tool, full window, bound to
 * the main window's current code project and chat. Boots like App (app.state, agents, the chat) and then follows
 * desk:event: chat items / session state for Tasks and Info, pty output for Terminal, the main window's switches
 * ('panel:context'), the lock, and the Save menu command.
 */
export function PanelApp({ tool, url }: { tool: PanelTool; url?: string }) {
  const [state, setState] = useState<AppState | null>(null);
  const [ctx, setCtx] = useState<PanelContext | null | undefined>(undefined);
  const [project, setProject] = useState<Project | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  const [agentDefs, setAgentDefs] = useState<Record<string, AgentDef>>({});
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>({});
  const [dark, setDark] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const workbench = useRef<WorkbenchHandle>(null);
  const threadId = useRef<string | undefined>(undefined);
  threadId.current = thread?.id;
  const bumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bump = useCallback(() => {
    if (bumpTimer.current) clearTimeout(bumpTimer.current);
    bumpTimer.current = setTimeout(() => setRefreshKey((k) => k + 1), 700);
  }, []);

  /** Which project / chat to show: the main window's current code chat, else the last one the app opened. */
  const boot = useCallback(async () => {
    const s = await api.state();
    setState(s);
    if (s.lock.locked || !s.settings.onboarded) return;
    const [agents, reported] = await Promise.all([api.agents(), api.panels.context().catch(() => null)]);
    setAgentDefs(Object.fromEntries(agents.defs.map((d) => [d.id, d])));
    setStatuses(Object.fromEntries(agents.statuses.map((x) => [x.id, x])));
    let c = reported;
    if (!c) {
      const last = s.settings.lastThreadId ? (await api.allThreads()).find((t) => t.id === s.settings.lastThreadId) : undefined;
      if (last && last.projectId !== 'general') c = { projectId: workspaceProjectId(last), threadId: last.id };
      else if (s.settings.lastProjectId && s.settings.lastProjectId !== 'general') c = { projectId: s.settings.lastProjectId };
    }
    setCtx(c ?? null);
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  // The project and chat behind the context.
  useEffect(() => {
    if (!ctx) {
      setProject(null);
      setThread(null);
      setSession(null);
      return;
    }
    let live = true;
    void (async () => {
      // A worktree chat's context carries the virtual id (src/shared/worktree.ts): show the base project with the
      // worktree's folder, under the virtual id every panel's IPC uses.
      const wt = parseWorktreeProjectId(ctx.projectId);
      const base = (await api.projects()).find((x) => x.id === (wt?.projectId ?? ctx.projectId)) ?? null;
      const tid = ctx.threadId ?? wt?.threadId;
      const r = tid ? await api.thread(tid) : null;
      if (!live) return;
      const worktree = wt ? r?.thread.worktree : undefined;
      const p = base && worktree ? { ...base, id: ctx.projectId, path: worktree.path } : base;
      setProject(p);
      setThread(r?.thread ?? null);
      setSession(r?.session ?? null);
    })();
    return () => {
      live = false;
    };
  }, [ctx]);

  // Theme, platform and the splash, like the main window (useAppSync), without the sidebar's vibrancy.
  useEffect(() => {
    if (!state) return;
    document.documentElement.dataset.platform = state.platform;
    document.title = PANEL_TITLES[tool];
    const el = document.getElementById('splash');
    if (el) {
      el.classList.add('gone');
      setTimeout(() => el.remove(), 400);
    }
  }, [state?.platform, tool]);
  useEffect(() => {
    if (!state) return;
    const apply = () => {
      applyTheme(state.settings.theme);
      setDark(document.documentElement.dataset.theme === 'dark');
    };
    apply();
    return onSystemThemeChange(apply);
  }, [state?.settings.theme]);

  useEffect(
    () =>
      onEvent((channel, payload) => {
        switch (channel) {
          case 'lock:state':
            if (payload.locked) {
              setCtx(undefined);
              setState((s) => (s ? { ...s, lock: payload } : s));
            } else void boot();
            break;
          case 'panel:context':
            setCtx((payload as DeskEvents['panel:context']) ?? null);
            break;
          case 'agent:status':
            setStatuses((a) => ({ ...a, [(payload as AgentStatus).id]: payload as AgentStatus }));
            break;
          case 'agents:changed': {
            const r = payload as DeskEvents['agents:changed'];
            setAgentDefs(Object.fromEntries(r.defs.map((d) => [d.id, d])));
            setStatuses(Object.fromEntries(r.statuses.map((x) => [x.id, x])));
            break;
          }
          case 'thread:item': {
            if (payload.threadId !== threadId.current) break;
            const item = payload.item as ThreadItem;
            if (item.kind === 'tool' && item.status === 'completed') bump();
            setThread((t) => (t ? { ...t, items: withItem(t.items, item) } : t));
            break;
          }
          case 'thread:meta': {
            const m = payload as ThreadMeta;
            if (m.id === threadId.current) setThread((t) => (t ? { ...t, title: m.title, agentId: m.agentId, autoApprove: m.autoApprove, worktree: m.worktree } : t));
            break;
          }
          case 'session:state':
            if (payload.threadId === threadId.current) {
              if (payload.status !== 'running') bump();
              setSession(payload);
            }
            break;
          case 'terminal:opened':
            addTerminal(payload.projectId, payload.ptyId);
            break;
          case 'menu':
            if (payload === 'save') workbench.current?.save();
            break;
        }
      }),
    [boot, bump],
  );

  const reattach = () => void api.panels.reattach(tool);
  const title = PANEL_TITLES[tool];

  let body: React.ReactNode;
  if (!state || ctx === undefined) body = state?.lock.locked ? <div className="panel-window-empty">Olympus Coder is locked. Unlock it in the main window.</div> : null;
  else if (!ctx || !project) body = <div className="panel-window-empty">Open a code chat in the main window; {title} follows it here.</div>;
  else if (tool === 'tasks' && !thread) body = <div className="panel-window-empty">Open a chat in the main window to see its tasks here.</div>;
  else
    body = (
      <Workbench
        ref={workbench}
        only={tool}
        initialWebUrl={url}
        project={project}
        thread={thread}
        agentDef={thread ? agentDefs[thread.agentId] : undefined}
        agentDefs={agentDefs}
        agentStatus={thread ? statuses[thread.agentId] : undefined}
        session={session}
        onOpenThread={(id) => void api.panels.showInMain({ tab: 'tasks', threadId: id })}
        preview={null}
        onClosePreview={() => {}}
        tab={tool}
        onTab={() => {}}
        onClose={reattach}
        dark={dark}
        refreshKey={refreshKey}
      />
    );

  return (
    <div className="panel-window" data-testid="panel-window" data-tool={tool}>
      <div className="panel-window-head">
        <span className="panel-window-title">{title}</span>
        {project && <span className="panel-window-sub">{project.name}{thread ? ` · ${thread.title}` : ''}</span>}
        <div className="spacer" />
        <button className="panel-reattach" onClick={reattach} title="Close this window and show the tool in the main window" data-testid="panel-reattach">
          <PanelRightClose size={14} /> Re-attach
        </button>
      </div>
      <div className="panel-window-body">{body}</div>
    </div>
  );
}
