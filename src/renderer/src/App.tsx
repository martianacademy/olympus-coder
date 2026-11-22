import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanelLeftOpen } from 'lucide-react';
import type { AgentDef, AgentStatus, AppState, AttachmentView, DeskEvents, Project, RunningTask, SessionView, Thread, ThreadMeta, UiMode, UserProfile } from '@shared/types';
import { api, onEvent, remoteWatch } from './api';
import { collectSubsessions } from '@shared/acpSessions';
import { acpSessionsApi } from './acpSessionsApi';
import { keys } from './platform';
import { AgentPicker } from './components/AgentPicker';
import { AppMain } from './components/AppMain';
import { AppOverlays } from './components/AppOverlays';
import { AppSidebar, type AppPage } from './components/AppSidebar';
import { type PreviewTarget } from './components/FilePreview';
import { type SettingsTab } from './components/Settings';
import { ChatTasksWorkbench } from './components/TasksPanel';
import { addTerminal } from './terminalBus';
import type { WorkbenchHandle, WorkbenchTab } from './components/Workbench';
import type { PanelTool } from '@shared/panels';

const DeleteChatDialog = lazy(() => import('./components/DeleteChatDialog').then((m) => ({ default: m.DeleteChatDialog })));
const ImportSessionsDialog = lazy(() => import('./components/ImportSessionsDialog').then((m) => ({ default: m.ImportSessionsDialog })));
const LockScreen = lazy(() => import('./components/LockScreen').then((m) => ({ default: m.LockScreen })));
const Onboarding = lazy(() => import('./components/Onboarding').then((m) => ({ default: m.Onboarding })));
const Workbench = lazy(() => import('./components/Workbench').then((m) => ({ default: m.Workbench })));
import { OpenFileContext, RunCommandContext } from './fileLinks';
import { isRemoteBrowser, useResponsiveShell } from './responsive';
import { setActiveThread } from './threadStatus';
import { doneOpening, markOpening } from './openingThread';
import { useAppSync } from './useAppSync';
import { workspaceProjectId } from '@shared/worktree';
import { taskPlace, taskThread } from './taskPlace';
import { addDraftFiles, getDraft, setDraftText } from './drafts';
import { cleanError } from './worktreeUi';

export interface AgentsInfo {
  defs: AgentDef[];
  statuses: Record<string, AgentStatus>;
}

const modeOf = (t: { mode?: UiMode }): UiMode => t.mode ?? 'code';

export default function App() {
  const {
    wbOpen,
    setWbOpen,
    sbCollapsed,
    setSbCollapsed,
    toggleSidebar,
    isDrawerSidebar,
    isSheetWorkbench,
    sidebarW,
    panelWidth,
    startSidebarResize,
    startWorkbenchResize,
  } = useResponsiveShell();
  const [state, setState] = useState<AppState | null>(null);
  const [agents, setAgents] = useState<AgentsInfo>({ defs: [], statuses: {} });
  const [projects, setProjects] = useState<Project[]>([]);
  const [general, setGeneral] = useState<Project | null>(null);
  const [threads, setThreads] = useState<Record<string, ThreadMeta[]>>({});
  const [active, setActive] = useState<Thread | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  const [page, setPage] = useState<AppPage>('thread');
  const [homeProject, setHomeProject] = useState('general');
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [loginAgent, setLoginAgent] = useState<string | null>(null);
  /** The chat whose delete is being confirmed, and the project whose agent sessions are being imported. */
  const [deleting, setDeleting] = useState<ThreadMeta | null>(null);
  const [importFor, setImportFor] = useState<Project | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [wbTab, setWbTab] = useState<WorkbenchTab>('files');
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const previewCtx = useRef<{ projectId?: string; workbench: boolean; tasksAvailable?: boolean }>({ workbench: false });

  const openFileRef = useCallback((ref: string) => {
    setPreview({ ref, projectId: previewCtx.current.projectId, nonce: Date.now() });
    if (previewCtx.current.workbench) {
      setWbTab('preview');
      setWbOpen(true);
    }
  }, []);

  useEffect(() => {
    const on = () => {
      if (!previewCtx.current.workbench && !previewCtx.current.tasksAvailable) return;
      setWbTab('tasks');
      setWbOpen(true);
    };
    window.addEventListener('olympus:show-tasks', on);
    const guardDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', guardDrop);
    window.addEventListener('drop', guardDrop);
    return () => {
      window.removeEventListener('olympus:show-tasks', on);
      window.removeEventListener('dragover', guardDrop);
      window.removeEventListener('drop', guardDrop);
    };
  }, []);

  const workbench = useRef<WorkbenchHandle>(null);
  const mainRef = useRef<HTMLElement>(null);
  const activeId = useRef<string | null>(null);
  activeId.current = active?.id ?? null;
  useEffect(() => setActiveThread(active?.id), [active?.id]);
  useEffect(() => remoteWatch('thread', active?.id), [active?.id]);
  const lastStatus = useRef<string | undefined>(undefined);
  const menuHandler = useRef<(cmd: string) => void>(() => {});
  const threadGone = useRef<(d: { id: string; projectId: string; parentId?: string }) => void>(() => {});
  const projectsChanged = useRef<(list: Project[]) => void>(() => {});
  const deletedIds = useRef(new Set<string>());
  const openingFallback = useRef<string | null>(null);

  const locked = Boolean(state?.lock.locked);
  const settings = state?.settings;
  const mode: UiMode = settings?.uiMode ?? 'code';
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const { dark, refreshKey } = useAppSync({
    state,
    setState,
    setAgents,
    setProjects,
    setThreads,
    setActive,
    setSession,
    setSettingsTab,
    setLoginAgent,
    setShowProfile,
    setShowSearch,
    setWbTab,
    setWbOpen,
    setSbCollapsed,
    isDrawerSidebar,
    sbCollapsed,
    isSheetWorkbench,
    wbOpen,
    mode,
    activeIdRef: activeId,
    lastStatusRef: lastStatus,
    previewCtxRef: previewCtx,
    mainRef,
    onMenuCommand: (cmd) => menuHandler.current(cmd),
    onThreadDeleted: (d) => threadGone.current(d),
    onProjectsChanged: (list) => projectsChanged.current(list),
  });

  const loadAgents = useCallback(async () => {
    const r = await api.agents();
    setAgents({ defs: r.defs, statuses: Object.fromEntries(r.statuses.map((s) => [s.id, s])) });
  }, []);

  const loadThreads = useCallback(async (projectId: string) => {
    const list = await api.threads(projectId);
    setThreads((t) => ({ ...t, [projectId]: list }));
  }, []);

  const setMode = useCallback(async (m: UiMode) => {
    setState((s) => (s ? { ...s, settings: { ...s.settings, uiMode: m } } : s));
    await api.updateSettings({ uiMode: m });
  }, []);

  const openThread = useCallback(
    async (id: string) => {
      // Any way of opening another chat (sidebar, Home, Search, a parent link): a skeleton until it has loaded.
      if (id !== activeId.current) markOpening(id);
      const r = await api.thread(id);
      if (!r || deletedIds.current.has(id)) {
        if (openingFallback.current === id) openingFallback.current = null;
        return doneOpening(id);
      }
      if (openingFallback.current === id) openingFallback.current = null;
      setPage('thread');
      setActive(r.thread);
      setSession(r.session);
      lastStatus.current = r.session.status;
      if (modeRef.current !== modeOf(r.thread)) void setMode(modeOf(r.thread));
      void api.ensureSession(id);
    },
    [setMode],
  );

  const loadAll = useCallback(async () => {
    const s = await api.state();
    setState(s);
    if (s.lock.locked || !s.settings.onboarded) return;
    await loadAgents();
    const [ps, g] = await Promise.all([api.projects(), api.generalProject()]);
    setProjects(ps);
    setGeneral(g);
    await Promise.all([...ps.map((p) => loadThreads(p.id)), loadThreads(g.id)]);
    const last = s.settings.lastThreadId ? (await api.allThreads()).find((t) => t.id === s.settings.lastThreadId) : undefined;
    if (last && modeOf(last) === s.settings.uiMode) await openThread(last.id);
    else if (s.settings.uiMode === 'chat') setPage('home');
  }, [loadAgents, loadThreads, openThread]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // The open chat was deleted (here, by an agent's delete_subsession, or from a phone): show its parent, else the
  // project's newest chat, else nothing. `deletedIds` + `openingFallback` handle multi-delete batches cleanly even
  // when a sub-session was active and its parent gets deleted right after it in the same batch.
  threadGone.current = (d) => {
    if (deletedIds.current.size > 500) deletedIds.current.clear();
    deletedIds.current.add(d.id);
    if (!activeId.current || !deletedIds.current.has(activeId.current)) return;
    if (openingFallback.current && !deletedIds.current.has(openingFallback.current)) return;
    const list = (threads[d.projectId] ?? []).filter((t) => !deletedIds.current.has(t.id));
    const next = list.find((t) => t.id === d.parentId) ?? list.find((t) => !t.parentId) ?? list[0];
    if (next) {
      openingFallback.current = next.id;
      return void openThread(next.id);
    }
    openingFallback.current = null;
    activeId.current = null;
    setActive(null);
    setSession(null);
    if (modeRef.current === 'chat') setPage('home');
  };

  // projects.json changed (live event): take the list as main sends it (order + `missing`), and load the chats of
  // projects this window has not loaded yet. Fold state lives in sidebarState.ts and is keyed by id, so it stays.
  projectsChanged.current = (list) => {
    setProjects(list);
    for (const p of list) if (!(p.id in threads)) void loadThreads(p.id);
  };

  const allThreads = useMemo(() => Object.values(threads).flat().sort((a, b) => b.updatedAt - a.updatedAt), [threads]);
  const currentProjectId =
    active?.projectId && active.projectId !== 'general'
      ? active.projectId
      : settings?.lastProjectId && projects.some((p) => p.id === settings.lastProjectId)
        ? settings.lastProjectId
        : projects[0]?.id;
  const currentAgent = active?.agentId ?? settings?.defaultAgent ?? 'claude';

  async function addProject(then: 'code' | 'none' = 'code') {
    let customPath: string | undefined;
    if (isRemoteBrowser()) {
      const entered = prompt('Enter the folder path on your Mac (e.g. ~/Documents/my-app):');
      if (!entered?.trim()) return null;
      customPath = entered.trim();
    }
    const p = await api.addProject(customPath);
    if (!p) return null;
    setProjects(await api.projects());
    await loadThreads(p.id);
    if (then === 'code') await newCodeChat(p.id, currentAgent, true);
    return p;
  }

  async function newCodeChat(projectId = currentProjectId, agentId = currentAgent, known = false) {
    let pid = projectId;
    if (!known && (!pid || !projects.some((p) => p.id === pid))) {
      const p = await addProject('none');
      if (!p) return;
      pid = p.id;
    }
    if (!pid) return;
    const t = await api.createThread(pid, agentId, 'code');
    await loadThreads(pid);
    await openThread(t.id);
  }

  /**
   * The empty code chat's "Worktree: Off / Isolated" switch. A chat's worktree is set when it is created, so this
   * replaces the still-empty chat with a new one (same project and agent, the draft carried over) and deletes the
   * empty one. Throws a readable error (e.g. the folder is not a git repository) and then changes nothing.
   */
  async function setEmptyChatWorktree(t: ThreadMeta, on: boolean) {
    if (Boolean(t.worktree) === on) return;
    const next = await api.createThread(t.projectId, t.agentId, 'code', on ? { worktree: true } : undefined);
    const draft = getDraft(t.id);
    if (draft.text) setDraftText(next.id, draft.text);
    if (draft.files.length) addDraftFiles(next.id, draft.files);
    await openThread(next.id);
    // The empty chat's `thread:deleted` must not move the window away from the new one (threadGone).
    activeId.current = next.id;
    try {
      await acpSessionsApi.deleteChat(t.id, true, false);
    } catch (e) {
      alert(`The new chat is open, but the empty one couldn't be deleted: ${cleanError(e)}`);
    }
    await loadThreads(t.projectId);
  }

  function newChatHome(projectId = 'general') {
    setActive(null);
    setSession(null);
    setHomeProject(projectId);
    setPage('home');
    if (mode !== 'chat') void setMode('chat');
  }

  async function startChat(text: string, files: AttachmentView[] = []) {
    const pid = homeProject === 'general' || projects.some((p) => p.id === homeProject) ? homeProject : 'general';
    const t = await api.createThread(pid, currentAgent, 'chat');
    await api.send(t.id, text, files);
    await loadThreads(pid);
    await openThread(t.id);
  }

  async function pickAgent(agentId: string) {
    if (settings && settings.defaultAgent !== agentId) {
      const s = await api.updateSettings({ defaultAgent: agentId });
      setState((st) => (st ? { ...st, settings: s } : st));
    }
    if (active && page === 'thread' && active.agentId !== agentId) {
      try {
        setSession(await api.switchAgent(active.id, agentId));
        setActive((t) => (t ? { ...t, agentId } : t));
      } catch (e: any) {
        alert(e?.message ?? e);
      }
    }
    if (agents.statuses[agentId]?.state === 'needs-login') setLoginAgent(agentId);
  }

  async function forkThread(threadId: string, uptoItemId?: string) {
    // A fork at the end of a chat also forks the agent's own session (session/fork) when the agent supports it.
    const { meta } = await acpSessionsApi.fork(threadId, uptoItemId);
    await loadThreads(meta.projectId);
    await openThread(meta.id);
  }

  async function renameThread(t: ThreadMeta, wanted: string) {
    // The agent sessions behind the chat get the name too (session/set_title); show the title the agent stored.
    const { title } = await acpSessionsApi.rename(t.id, wanted);
    setThreads((all) => ({ ...all, [t.projectId]: (all[t.projectId] ?? []).map((x) => (x.id === t.id ? { ...x, title } : x)) }));
    if (active?.id === t.id) setActive((a) => (a ? { ...a, title } : a));
  }

  async function pinThread(t: ThreadMeta, pinned: boolean) {
    await api.pinThread(t.id, pinned);
    setThreads((all) => ({ ...all, [t.projectId]: (all[t.projectId] ?? []).map((x) => (x.id === t.id ? { ...x, pinned } : x)) }));
  }

  function deleteThread(t: ThreadMeta) {
    setDeleting(t);
  }

  /** After DeleteChatDialog removed the chat (and, if the user ticked it, the agent's saved session). */
  async function afterDelete(t: ThreadMeta) {
    setDeleting(null);
    // The main process's `thread:deleted` event already moved away from the chat if it was open (threadGone).
    await loadThreads(t.projectId);
  }

  const updateSettings = async (patch: Partial<AppState['settings']>) => {
    const s = await api.updateSettings(patch);
    setState((st) => (st ? { ...st, settings: s } : st));
  };

  function switchMode(m: UiMode) {
    if (m === mode) return;
    void setMode(m);
    if (m === 'chat') {
      if (!active || modeOf(active) !== 'chat') {
        setActive(null);
        setPage('home');
      }
    } else {
      setPage('thread');
      if (!active || modeOf(active) !== 'code') {
        const last = allThreads.find((t) => modeOf(t) === 'code');
        if (last) void openThread(last.id);
        else setActive(null);
      }
    }
  }

  function toggleWorkbench(tab: WorkbenchTab) {
    if (wbOpen && wbTab === tab) setWbOpen(false);
    else {
      setWbTab(tab);
      setWbOpen(true);
    }
  }

  menuHandler.current = (cmd: string) => {
    if (cmd === 'settings') setSettingsTab('general');
    if (cmd === 'new-chat') mode === 'chat' ? newChatHome() : void newCodeChat();
    if (cmd === 'search') setShowSearch(true);
    if (cmd === 'mode-chat') switchMode('chat');
    if (cmd === 'mode-code') switchMode('code');
    if (cmd === 'save') workbench.current?.save();
    if (cmd === 'terminal' && mode === 'code') toggleWorkbench('terminal');
    if (cmd === 'sidebar') toggleSidebar();
  };

  // Detached Workbench tool windows (src/main/panels.ts) follow this window's current code project and chat.
  // A worktree chat's workbench (files, git, terminals, preview, Verify Gate) works in its worktree: the virtual
  // project id from src/shared/worktree.ts. The sidebar, thread lists and memory stay on the real `projectId`.
  const workspaceId = active ? workspaceProjectId(active) : undefined;
  const panelProjectId = mode === 'code' && page === 'thread' && active && modeOf(active) === 'code' && active.projectId !== 'general' ? workspaceId : undefined;
  useEffect(() => {
    if (!panelProjectId || !api.panels.available()) return;
    api.panels.setContext({ projectId: panelProjectId, ...(activeId.current ? { threadId: activeId.current } : {}) }).catch(() => {});
  }, [panelProjectId, active?.id]);
  const panelShow = useRef<(d: DeskEvents['panel:show']) => void>(() => {});
  panelShow.current = (d) => {
    if (d.threadId) void openThread(d.threadId);
    setWbOpen(true);
    // Wait a frame so the Workbench is mounted (it may have been closed) before it opens a file or a page.
    requestAnimationFrame(() => {
      if (d.ptyId && workspaceId) addTerminal(workspaceId, d.ptyId);
      if (d.tab === 'files' && d.path) return workbench.current?.openFile(d.path, d.line);
      if (d.tab === 'web' && d.path) return void window.dispatchEvent(new CustomEvent('olympus:web-preview', { detail: { url: d.path } }));
      setWbTab(d.tab as WorkbenchTab);
    });
  };
  const [detachedPanels, setDetachedPanels] = useState<PanelTool[]>([]);
  useEffect(() => {
    if (!api.panels.available()) return;
    api.panels.list().then(setDetachedPanels).catch(() => {});
  }, []);
  useEffect(
    () =>
      onEvent((channel, payload) => {
        if (channel === 'panel:closed') {
          const closed = payload as DeskEvents['panel:closed'];
          setDetachedPanels((prev) => prev.filter((t) => t !== closed.tool));
          if (closed.reattach) {
            setWbTab(closed.tool);
            setWbOpen(true);
          }
        }
        if (channel === 'panel:show') panelShow.current(payload as DeskEvents['panel:show']);
      }),
    [],
  );
  const detachTool = useCallback((tool: PanelTool, url?: string) => {
    api.panels
      .detach(tool, url)
      .then((list) => setDetachedPanels(list))
      .catch((e) => alert(e?.message ?? String(e)));
  }, []);

  const agentDefs = useMemo(() => Object.fromEntries(agents.defs.map((d) => [d.id, d])), [agents.defs]);
  const activeProjectId = workspaceId;
  const runCommand = useCallback((cmd: string) => {
    if (activeProjectId) void api.runInTerminal(activeProjectId, cmd);
  }, [activeProjectId]);
  const openThreadById = useCallback((id: string) => void openThread(id), [openThread]);
  // The heat toast's Show: the chat that started the program, with that program's terminal tab (or Tasks) open.
  const showTask = useCallback(
    async (t: RunningTask) => {
      const th = taskThread(t, allThreads);
      if (th) await openThread(th.id);
      setWbOpen(true);
      // A frame later the opened chat's Workbench is mounted, as in panelShow.
      requestAnimationFrame(() => {
        if (t.ptyId && t.projectId) {
          addTerminal(t.projectId, t.ptyId);
          setWbTab('terminal');
        } else window.dispatchEvent(new CustomEvent('olympus:show-tasks'));
      });
    },
    [allThreads, openThread],
  );
  const placeOfTask = useCallback((t: RunningTask) => taskPlace(t, allThreads, projects), [allThreads, projects]);
  const forkRef = useRef(forkThread);
  forkRef.current = forkThread;
  const forkActive = useCallback((upto?: string) => {
    if (activeId.current) void forkRef.current(activeId.current, upto);
  }, []);

  if (!state) return null;
  if (locked) {
    return (
      <Suspense fallback={null}>
        <LockScreen lock={state.lock} onUnlocked={() => void loadAll()} />
      </Suspense>
    );
  }
  if (!state.settings.onboarded) {
    return (
      <Suspense fallback={null}>
        <Onboarding state={state} onState={setState} onDone={async () => { await updateSettings({ onboarded: true }); await loadAll(); }} />
      </Suspense>
    );
  }

  const baseProject = active ? (active.projectId === 'general' ? general ?? undefined : projects.find((p) => p.id === active.projectId)) : undefined;
  // The project the chat's panels see: for a worktree chat, the base project with the virtual id and the worktree folder.
  const project = baseProject && active?.worktree && workspaceId ? { ...baseProject, id: workspaceId, path: active.worktree.path } : baseProject;
  const profile: UserProfile = state.settings.profile;
  const picker = <AgentPicker agents={agents} current={currentAgent} onPick={pickAgent} onManage={() => setSettingsTab('agents')} onLogin={setLoginAgent} />;
  const showThread = Boolean(page === 'thread' && active && project && modeOf(active) === mode);
  const codeWorkbench = Boolean(mode === 'code' && showThread && active && active.projectId !== 'general');
  const chatTasksPanel = Boolean(!codeWorkbench && showThread && active && project);
  previewCtx.current = { projectId: workspaceId ?? homeProject, workbench: codeWorkbench, tasksAvailable: codeWorkbench || chatTasksPanel };
  const showSidebarOpenBtn = sbCollapsed || isDrawerSidebar;
  const closePreview = () => {
    setPreview(null);
    if (wbTab === 'preview') setWbTab('files');
  };

  return (
    <OpenFileContext.Provider value={openFileRef}>
      <RunCommandContext.Provider value={codeWorkbench && active ? runCommand : null}>
        <div className={`app mode-${mode} ${sbCollapsed ? 'sb-collapsed' : ''} ${isDrawerSidebar ? 'drawer-layout' : ''} ${isSheetWorkbench ? 'sheet-layout' : ''}`}>
          <AppSidebar
            mode={mode}
            page={page}
            activeId={page === 'thread' ? active?.id : undefined}
            sbCollapsed={sbCollapsed}
            isDrawer={isDrawerSidebar}
            sidebarW={sidebarW}
            projects={projects}
            threads={threads}
            allThreads={allThreads}
            agentDefs={agentDefs}
            currentAgentStatus={agents.statuses[currentAgent]}
            profile={profile}
            lockEnabled={state.lock.enabled}
            onToggleSidebar={toggleSidebar}
            onSwitchMode={switchMode}
            onNewChatHome={() => newChatHome()}
            onNewCodeChat={(pid) => void newCodeChat(pid)}
            onShowSearch={() => setShowSearch(true)}
            onSelectPage={setPage}
            onOpenSettings={setSettingsTab}
            onOpenThread={(id) => void openThread(id)}
            onPinThread={(t, p) => void pinThread(t, p)}
            onForkThread={(t) => void forkThread(t.id)}
            onRenameThread={(t, title) => void renameThread(t, title)}
            onDeleteThread={deleteThread}
            onAddProject={() => void addProject()}
            onImportProject={setImportFor}
            onRemoveProject={async (p) => {
              if (!confirm(`Remove "${p.name}" from the list? The folder and its chats stay on disk.`)) return;
              await api.removeProject(p.id);
              setProjects(await api.projects());
              if (active?.projectId === p.id) setActive(null);
            }}
            onRevealProject={(p) => api.revealProject(p.id)}
            onLocateProject={async (p) => {
              try {
                if (await api.relocateProject(p.id)) setProjects(await api.projects());
              } catch (e: any) {
                alert(e?.message ?? String(e));
              }
            }}
            onReorderProjects={(ids) => {
              setProjects((ps) => ids.map((id) => ps.find((p) => p.id === id)!).filter(Boolean));
              void api.reorderProjects(ids);
            }}
            onShowProfile={() => setShowProfile(true)}
            onMemory={() => {
              if (mode === 'code' && codeWorkbench) toggleWorkbench('info');
              else setShowMemory((v) => !v);
            }}
          />
          {!sbCollapsed && !isDrawerSidebar && <div className="resizer sb-resizer" onMouseDown={startSidebarResize} title="Drag to resize the sidebar" />}

          <AppMain
            mainRef={mainRef}
            mode={mode}
            page={page}
            active={active}
            project={project}
            general={general}
            projects={projects}
            allThreads={allThreads}
            session={session}
            agents={agents}
            agentDefs={agentDefs}
            currentAgent={currentAgent}
            currentProjectId={currentProjectId}
            homeProject={homeProject}
            profile={profile}
            picker={picker}
            wbOpen={wbOpen}
            wbTab={wbTab}
            detachedTools={detachedPanels}
            isSheetWorkbench={isSheetWorkbench}
            showThread={showThread}
            codeWorkbench={codeWorkbench}
            onToggleWorkbench={toggleWorkbench}
            onSetPage={setPage}
            onSetHomeProject={setHomeProject}
            onOpenThread={openThreadById}
            onNewChatHome={newChatHome}
            onNewCodeChat={(pid) => void newCodeChat(pid)}
            onAddProject={addProject}
            onStartChat={(text, files) => void startChat(text, files)}
            onPickAgent={(id) => void pickAgent(id)}
            onSwitchMode={switchMode}
            onSetModeOnly={(m) => void setMode(m)}
            onLoginAgent={setLoginAgent}
            onForkActive={forkActive}
            onOpenInfoWorkbench={() => {
              setWbTab('info');
              setWbOpen(true);
            }}
            onAutoApprove={(on) => setActive((t) => (t ? { ...t, autoApprove: on } : t))}
            onSetWorktree={setEmptyChatWorktree}
          />

          {(codeWorkbench || chatTasksPanel) && wbOpen && project && (
            <>
              {!isSheetWorkbench && <div className="resizer wb-resizer" onMouseDown={startWorkbenchResize} title="Drag to resize" />}
              <div className={`workbench-col ${isSheetWorkbench ? 'is-sheet' : ''}`} style={isSheetWorkbench ? undefined : { width: panelWidth }}>
                {codeWorkbench ? (
                  <Suspense fallback={<div className="workbench"><div className="muted small" style={{ padding: 16 }}>Loading…</div></div>}>
                    <Workbench
                      ref={workbench}
                      project={project}
                      thread={active}
                      agentDef={active ? agentDefs[active.agentId] : undefined}
                      agentDefs={agentDefs}
                      agentStatus={active ? agents.statuses[active.agentId] : undefined}
                      session={session}
                      onOpenThread={openThreadById}
                      onFork={() => forkActive()}
                      preview={preview}
                      onClosePreview={closePreview}
                      tab={wbTab}
                      onTab={setWbTab}
                      onClose={() => setWbOpen(false)}
                      dark={dark}
                      refreshKey={refreshKey}
                      onDetach={api.panels.available() ? detachTool : undefined}
                      detachedTools={detachedPanels}
                      onThreadChanged={() => active && void openThread(active.id)}
                    />
                  </Suspense>
                ) : (
                  active && (
                    <ChatTasksWorkbench
                      thread={active}
                      projectPath={project.path}
                      agentDefs={agentDefs}
                      running={session?.status === 'running'}
                      sessionUsage={session?.usage}
                      onFork={() => forkActive()}
                      onSwitchToCode={
                        mode === 'chat' && active.projectId !== 'general'
                          ? () => {
                              setWbOpen(false);
                              switchMode('code');
                            }
                          : undefined
                      }
                      onOpenThread={openThreadById}
                      onClose={() => setWbOpen(false)}
                    />
                  )
                )}
              </div>
            </>
          )}

          {showSidebarOpenBtn && !(isDrawerSidebar && !sbCollapsed) && !(isSheetWorkbench && wbOpen) && (
            <button className="btn ghost icon sb-toggle-float" title={`Show sidebar (${keys('⌘B')})`} aria-label="Show sidebar" onClick={toggleSidebar} data-testid="sidebar-show">
              <PanelLeftOpen size={isDrawerSidebar ? 22 : 16} strokeWidth={isDrawerSidebar ? 2.1 : 2} />
            </button>
          )}

          <AppOverlays
            state={state}
            setState={setState}
            agents={agents}
            agentDefs={agentDefs}
            profile={profile}
            dark={dark}
            codeWorkbench={codeWorkbench}
            preview={preview}
            onClosePreview={() => setPreview(null)}
            showMemory={showMemory}
            memoryProjectId={active?.projectId ?? homeProject ?? 'general'}
            memoryThreadItems={active?.items.length ?? 0}
            onCloseMemory={() => setShowMemory(false)}
            settingsTab={settingsTab}
            onSettingsTab={setSettingsTab}
            showProfile={showProfile}
            onCloseProfile={() => setShowProfile(false)}
            showSearch={showSearch}
            onCloseSearch={() => setShowSearch(false)}
            loginAgent={loginAgent}
            onLoginAgent={setLoginAgent}
            onLoadAgents={loadAgents}
            onOpenThread={openThreadById}
            taskPlace={placeOfTask}
            onShowTask={(t) => void showTask(t)}
            totalChats={Object.values(threads).reduce((n, l) => n + l.length, 0)}
            onUpdateSettings={(patch) => void updateSettings(patch)}
          />
          <Suspense fallback={null}>
            {deleting && (
              <DeleteChatDialog
                thread={deleting}
                initialSubsessions={collectSubsessions(threads[deleting.projectId] ?? [], deleting.id).map((s) => ({ id: s.id, title: s.title }))}
                agents={agents}
                onCancel={() => setDeleting(null)}
                onDeleted={() => void afterDelete(deleting)}
              />
            )}
            {importFor && (
              <ImportSessionsDialog
                projectId={importFor.id}
                projectName={importFor.name}
                agents={agents}
                agentId={currentAgent}
                onClose={() => setImportFor(null)}
                onOpen={(meta) => {
                  setImportFor(null);
                  void loadThreads(meta.projectId).then(() => openThread(meta.id));
                }}
              />
            )}
          </Suspense>
        </div>
      </RunCommandContext.Provider>
    </OpenFileContext.Provider>
  );
}
