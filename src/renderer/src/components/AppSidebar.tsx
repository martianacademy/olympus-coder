import { useMemo } from 'react';
import { Clock, FolderOpen, FolderPlus, PanelLeftClose, Search, Settings as SettingsIcon, SquarePen } from 'lucide-react';
import type { AgentDef, AgentStatus, Project, ThreadMeta, UiMode, UserProfile } from '@shared/types';
import { keys } from '../platform';
import { ChatThreadLists, ModeSwitch } from './ChatNav';
import { ProfileButton } from './Profile';
import type { SettingsTab } from './Settings';
import { Sidebar } from './Sidebar';

export type AppPage = 'thread' | 'home' | 'projects' | 'scheduled' | 'usage';

const modeOf = (t: { mode?: UiMode }): UiMode => t.mode ?? 'code';

export interface AppSidebarProps {
  mode: UiMode;
  page: AppPage;
  activeId?: string;
  sbCollapsed: boolean;
  isDrawer: boolean;
  sidebarW: number;
  projects: Project[];
  threads: Record<string, ThreadMeta[]>;
  allThreads: ThreadMeta[];
  agentDefs: Record<string, AgentDef>;
  currentAgentStatus?: AgentStatus;
  profile: UserProfile;
  lockEnabled: boolean;
  onToggleSidebar: () => void;
  onSwitchMode: (m: UiMode) => void;
  onNewChatHome: () => void;
  onNewCodeChat: (projectId?: string) => void;
  onShowSearch: () => void;
  onSelectPage: (p: AppPage) => void;
  onOpenSettings: (tab: SettingsTab) => void;
  onOpenThread: (id: string) => void;
  onPinThread: (t: ThreadMeta, pinned: boolean) => void;
  onForkThread: (t: ThreadMeta) => void;
  onRenameThread: (t: ThreadMeta, title: string) => void;
  onDeleteThread: (t: ThreadMeta) => void;
  onAddProject: () => void;
  onRemoveProject: (p: Project) => void;
  /** "Import from agent…": the agent's own saved sessions for this project. */
  onImportProject: (p: Project) => void;
  onRevealProject: (p: Project) => void;
  onReorderProjects: (ids: string[]) => void;
  onShowProfile: () => void;
  onMemory: () => void;
}

/**
 * Left navigation column on wide screens (`> 900px`) and accessible modal slide-over drawer on tablet/phone (`<= 900px`).
 * Following WCAG / modern navigation-drawer semantics, `role="dialog"` and `aria-modal="true"` apply only while
 * acting as an open overlay drawer on narrow viewports.
 */
export function AppSidebar(props: AppSidebarProps) {
  const {
    mode,
    page,
    activeId,
    sbCollapsed,
    isDrawer,
    sidebarW,
    projects,
    threads,
    allThreads,
    agentDefs,
    currentAgentStatus,
    profile,
    lockEnabled,
  } = props;

  // Stable between renders, so the sidebar's fold pruning and reveal effects run only when the lists change.
  const codeThreads = useMemo(() => Object.fromEntries(Object.entries(threads).map(([k, v]) => [k, v.filter((t) => modeOf(t) === 'code')])), [threads]);

  const drawerOpen = isDrawer && !sbCollapsed;
  const closeIfDrawer = () => {
    if (drawerOpen) props.onToggleSidebar();
  };

  return (
    <>
      {drawerOpen && <div className="drawer-backdrop" onClick={props.onToggleSidebar} data-testid="drawer-backdrop" aria-hidden="true" />}
      <aside
        className={`sidebar ${isDrawer ? 'is-drawer' : ''} ${drawerOpen ? 'drawer-open' : ''}`}
        data-testid="app-sidebar"
        style={isDrawer ? undefined : { width: sidebarW }}
        role={drawerOpen ? 'dialog' : undefined}
        aria-modal={drawerOpen ? true : undefined}
        aria-label={drawerOpen ? 'Navigation menu' : 'Sidebar'}
        aria-hidden={sbCollapsed}
      >
        <div className="titlebar">
          <button className="btn ghost icon" title={`Hide sidebar (${keys('⌘B')})`} aria-label="Hide sidebar" onClick={props.onToggleSidebar} data-testid="sidebar-hide">
            <PanelLeftClose size={isDrawer ? 22 : 16} strokeWidth={isDrawer ? 2.1 : 2} />
          </button>
          <div className="spacer" />
          <ModeSwitch mode={mode} onMode={props.onSwitchMode} />
        </div>

        <nav className="nav">
          {mode === 'chat' ? (
            <>
              <button
                className={`nav-item ${page === 'home' ? 'active' : ''}`}
                onClick={() => {
                  props.onNewChatHome();
                  closeIfDrawer();
                }}
              >
                <SquarePen size={16} /> New chat <span className="kbd">{keys('⌘N')}</span>
              </button>
              <button
                className="nav-item"
                onClick={() => {
                  closeIfDrawer();
                  props.onShowSearch();
                }}
              >
                <Search size={16} /> Search <span className="kbd">{keys('⌘K')}</span>
              </button>
              <button
                className={`nav-item ${page === 'projects' ? 'active' : ''}`}
                onClick={() => {
                  props.onSelectPage('projects');
                  closeIfDrawer();
                }}
              >
                <FolderOpen size={16} /> Projects
              </button>
              <button
                className={`nav-item ${page === 'scheduled' ? 'active' : ''}`}
                onClick={() => {
                  props.onSelectPage('scheduled');
                  closeIfDrawer();
                }}
              >
                <Clock size={16} /> Scheduled
              </button>
              <button
                className="nav-item"
                onClick={() => {
                  closeIfDrawer();
                  props.onOpenSettings('appearance');
                }}
              >
                <SettingsIcon size={16} /> Customize
              </button>
            </>
          ) : (
            <>
              <button
                className="nav-item"
                onClick={() => {
                  props.onNewCodeChat();
                  closeIfDrawer();
                }}
              >
                <SquarePen size={16} /> New session <span className="kbd">{keys('⌘N')}</span>
              </button>
              <button
                className="nav-item"
                onClick={() => {
                  closeIfDrawer();
                  props.onShowSearch();
                }}
              >
                <Search size={16} /> Search <span className="kbd">{keys('⌘K')}</span>
              </button>
              <button
                className={`nav-item ${page === 'scheduled' ? 'active' : ''}`}
                onClick={() => {
                  props.onSelectPage('scheduled');
                  closeIfDrawer();
                }}
              >
                <Clock size={16} /> Scheduled
              </button>
            </>
          )}
        </nav>

        <div className="sidebar-scroll">
          {mode === 'chat' ? (
            <ChatThreadLists
              threads={allThreads}
              activeId={activeId}
              agentDefs={agentDefs}
              onOpen={(id) => {
                props.onOpenThread(id);
                closeIfDrawer();
              }}
              onPin={props.onPinThread}
              onDelete={props.onDeleteThread}
            />
          ) : (
            <>
              <div className="section-label">
                Projects
                <div className="spacer" />
                <button className="btn ghost icon" title="Add project" aria-label="Add project" onClick={props.onAddProject}>
                  <FolderPlus size={15} />
                </button>
              </div>
              <Sidebar
                projects={projects}
                threads={codeThreads}
                agentDefs={agentDefs}
                activeId={activeId}
                onOpen={(id) => {
                  props.onOpenThread(id);
                  closeIfDrawer();
                }}
                onNew={(pid) => {
                  props.onNewCodeChat(pid);
                  closeIfDrawer();
                }}
                onFork={props.onForkThread}
                onRename={props.onRenameThread}
                onDelete={props.onDeleteThread}
                onRemoveProject={props.onRemoveProject}
                onImport={(p) => {
                  props.onImportProject(p);
                  closeIfDrawer();
                }}
                onReveal={props.onRevealProject}
                onReorder={props.onReorderProjects}
                compact={isDrawer}
              />
            </>
          )}
        </div>

        <div className="sidebar-foot">
          <ProfileButton
            profile={profile}
            lockEnabled={lockEnabled}
            onEdit={() => {
              closeIfDrawer();
              props.onShowProfile();
            }}
            onSettings={() => {
              closeIfDrawer();
              props.onOpenSettings('general');
            }}
            onUsage={() => {
              props.onSelectPage('usage');
              closeIfDrawer();
            }}
            plan={currentAgentStatus?.plan}
            limits={currentAgentStatus?.limits}
            limitsStatus={currentAgentStatus}
            onMemory={() => {
              closeIfDrawer();
              props.onMemory();
            }}
          />
        </div>
      </aside>
    </>
  );
}
