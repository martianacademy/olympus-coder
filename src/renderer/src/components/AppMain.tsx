import type { ReactNode, RefObject } from 'react';
import { Code2, FileCode, FolderPlus, GitBranch, Info, MessageSquarePlus, PanelRightOpen, SquareTerminal, Workflow } from 'lucide-react';
import type { AgentDef, AttachmentView, Project, SessionView, Thread, ThreadMeta, UiMode, UserProfile } from '@shared/types';
import type { AgentsInfo } from '../App';
import type { AppPage } from './AppSidebar';
import type { WorkbenchTab } from './Workbench';
import { AppMark } from './AppMark';
import { Chat } from './Chat';
import { ChatHome } from './ChatHome';
import { ProjectsPage } from './ChatNav';
import { ScheduledView } from './ScheduledView';
import { liveNow, useTasks } from './TasksPanel';
import { UsagePage } from './Usage';

const modeOf = (t: { mode?: UiMode }): UiMode => t.mode ?? 'code';

export interface AppMainProps {
  mainRef: RefObject<HTMLElement | null>;
  mode: UiMode;
  page: AppPage;
  active: Thread | null;
  project?: Project;
  general: Project | null;
  projects: Project[];
  allThreads: ThreadMeta[];
  session: SessionView | null;
  agents: AgentsInfo;
  agentDefs: Record<string, AgentDef>;
  currentAgent: string;
  currentProjectId?: string;
  homeProject: string;
  profile: UserProfile;
  picker: ReactNode;
  wbOpen: boolean;
  wbTab: WorkbenchTab;
  isSheetWorkbench: boolean;
  showThread: boolean;
  codeWorkbench: boolean;
  onToggleWorkbench: (tab: WorkbenchTab) => void;
  onSetPage: (p: AppPage) => void;
  onSetHomeProject: (pid: string) => void;
  onOpenThread: (id: string) => void;
  onNewChatHome: (pid?: string) => void;
  onNewCodeChat: (pid?: string) => void;
  onAddProject: (then?: 'code' | 'none') => Promise<Project | null>;
  onStartChat: (text: string, files?: AttachmentView[]) => void;
  onPickAgent: (agentId: string) => void;
  onSwitchMode: (m: UiMode) => void;
  onSetModeOnly: (m: UiMode) => void;
  onLoginAgent: (agentId: string) => void;
  onForkActive: (uptoItemId?: string) => void;
  onOpenInfoWorkbench: () => void;
  onAutoApprove: (on: boolean) => void;
}

/**
 * Primary `<main>` workspace router rendering Usage, Scheduled tasks, Projects,
 * active Chat/Code thread, ChatHome, or the Code mode empty state.
 */
export function AppMain(props: AppMainProps) {
  const {
    mainRef,
    mode,
    page,
    active,
    project,
    general,
    projects,
    allThreads,
    session,
    agents,
    agentDefs,
    currentAgent,
    currentProjectId,
    homeProject,
    profile,
    picker,
    wbOpen,
    wbTab,
    isSheetWorkbench,
    showThread,
    codeWorkbench,
  } = props;

  const tasks = useTasks(showThread && active ? active.id : undefined);
  const now = showThread && active ? liveNow(active) : { tools: [], background: [], perms: [], asks: [], plan: [] };
  const runningTasks =
    tasks.children.filter((c) => c.status === 'running' || c.status === 'starting' || c.status === 'waiting-permission').length + now.tools.length + now.background.length;
  const needsYou = tasks.children.some((c) => c.status === 'waiting-permission') || now.perms.length > 0 || now.asks.length > 0;
  const tasksTitle = runningTasks ? `Tasks (${runningTasks} running)` : tasks.children.length ? `Tasks (${tasks.children.length})` : 'Tasks: sub-sessions & CLI sub-agents';

  const sheetDrawerButton = (
    <button
      type="button"
      className={`btn ghost icon wb-drawer-btn ${wbOpen ? 'on' : ''} ${needsYou ? 'needs-attention' : ''}`}
      title={codeWorkbench ? `${tasksTitle} · Files, Git, Terminal & Info` : tasksTitle}
      aria-label="Open workspace tools drawer"
      aria-expanded={wbOpen}
      onClick={() => {
        const targetTab: WorkbenchTab = !codeWorkbench ? 'tasks' : wbOpen ? wbTab : needsYou ? 'tasks' : wbTab;
        props.onToggleWorkbench(targetTab);
      }}
      data-testid="head-wb-drawer"
    >
      <PanelRightOpen size={22} strokeWidth={2.1} className={needsYou ? 'warn-text' : runningTasks ? 'pulse' : ''} />
      {(needsYou || runningTasks > 0) && (
        <span className={`wb-drawer-badge ${needsYou ? 'warn' : ''}`}>{needsYou ? '!' : runningTasks}</span>
      )}
    </button>
  );

  const wbButtons = isSheetWorkbench ? (
    sheetDrawerButton
  ) : codeWorkbench && !wbOpen ? (
    <div className="head-tools">
      {(
        [
          ['files', <FileCode size={16} key="f" />, 'Files'],
          ['git', <GitBranch size={16} key="g" />, 'Git'],
          ['terminal', <SquareTerminal size={16} key="t" />, 'Terminal (Ctrl+`)'],
          ['tasks', <Workflow size={16} key="k" className={needsYou ? 'warn-text' : runningTasks ? 'pulse' : ''} />, tasksTitle],
          ['info', <Info size={16} key="i" />, 'Info'],
        ] as const
      ).map(([tab, icon, title]) => (
        <button key={tab} className={`btn ghost ${tab === 'tasks' && runningTasks > 0 ? 'small' : 'icon'} ${wbOpen && wbTab === tab ? 'on' : ''}`} title={title} aria-label={title} onClick={() => props.onToggleWorkbench(tab)} data-testid={`head-wb-${tab}`}>
          {icon}
          {tab === 'tasks' && runningTasks > 0 && <span>{runningTasks}</span>}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <main className="main" ref={mainRef}>
      {page === 'usage' ? (
        <UsagePage
          defs={agents.defs}
          statuses={agents.statuses}
          onOpenThread={props.onOpenThread}
          onClose={() => props.onSetPage(active ? 'thread' : mode === 'chat' ? 'home' : 'thread')}
        />
      ) : page === 'scheduled' ? (
        <ScheduledView
          projects={projects}
          agentDefs={agentDefs}
          defaultProjectId={currentProjectId}
          defaultAgent={currentAgent}
          onOpenThread={props.onOpenThread}
        />
      ) : page === 'projects' && mode === 'chat' ? (
        <ProjectsPage
          projects={projects}
          threads={allThreads}
          onAdd={() => void props.onAddProject('none')}
          onChat={(pid) => props.onNewChatHome(pid)}
          onCode={(pid) => {
            props.onSetModeOnly('code');
            const last = allThreads.find((t) => t.projectId === pid && modeOf(t) === 'code');
            if (last) props.onOpenThread(last.id);
            else props.onNewCodeChat(pid);
          }}
        />
      ) : showThread && active && project ? (
        <Chat
          key={active.id}
          thread={active}
          project={project}
          session={session}
          agentDef={agentDefs[active.agentId]}
          agentDefs={agentDefs}
          agentStatus={agents.statuses[active.agentId]}
          parentTitle={active.parentId ? allThreads.find((t) => t.id === active.parentId)?.title : undefined}
          headerLeft={picker}
          headerRight={
            mode === 'chat' ? (
              isSheetWorkbench ? (
                sheetDrawerButton
              ) : (
                <div className="head-tools">
                  <button
                    className={`btn ghost ${runningTasks > 0 || tasks.children.length > 0 ? 'small' : 'icon'} ${wbOpen ? 'on' : ''}`}
                    title={tasksTitle}
                    aria-label={tasksTitle}
                    onClick={() => props.onToggleWorkbench('tasks')}
                    data-testid="head-wb-tasks"
                  >
                    <Workflow size={15} className={needsYou ? 'warn-text' : runningTasks ? 'pulse' : ''} />
                    {(runningTasks > 0 || tasks.children.length > 0) && <span>{runningTasks ? `Tasks (${runningTasks})` : `Tasks · ${tasks.children.length}`}</span>}
                  </button>
                  {active.projectId !== 'general' && (
                    <button className="btn ghost small" title="Open this project in Code mode" onClick={() => props.onSwitchMode('code')}>
                      <Code2 size={14} /> Code
                    </button>
                  )}
                </div>
              )
            ) : (
              wbButtons
            )
          }
          onLogin={() => props.onLoginAgent(active.agentId)}
          onFork={props.onForkActive}
          onOpenThread={props.onOpenThread}
          onUsage={() => (mode === 'code' && codeWorkbench ? props.onOpenInfoWorkbench() : props.onSetPage('usage'))}
          compactInComposer={!(mode === 'code' && codeWorkbench)}
          allStatuses={agents.statuses}
          onSwitchAgent={props.onPickAgent}
          onAutoApprove={props.onAutoApprove}
        />
      ) : mode === 'chat' ? (
        <>
          <div className="main-head">{picker}</div>
          <ChatHome
            profile={profile}
            projects={projects}
            general={general}
            agents={agents}
            agentId={currentAgent}
            projectId={homeProject}
            recents={allThreads.filter((t) => modeOf(t) === 'chat')}
            onAgent={props.onPickAgent}
            onProject={props.onSetHomeProject}
            onAddProject={async () => {
              const p = await props.onAddProject('none');
              if (p) props.onSetHomeProject(p.id);
            }}
            onStart={props.onStartChat}
            onOpen={props.onOpenThread}
          />
        </>
      ) : (
        <>
          <div className="main-head">{picker}</div>
          <div className="empty">
            <div>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <AppMark size={56} />
              </div>
              <h1>What are we building today?</h1>
              <p className="muted">Pick a project or add a new one. Files, Git and Terminal open in the right panel with each session.</p>
              <div className="row" style={{ justifyContent: 'center', marginTop: 16, flexWrap: 'wrap' }}>
                <button className="btn primary" onClick={() => props.onNewCodeChat()}>
                  <MessageSquarePlus size={16} /> New session
                </button>
                <button className="btn" onClick={() => void props.onAddProject()}>
                  <FolderPlus size={16} /> Add project
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
