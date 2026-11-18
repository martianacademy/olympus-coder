import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ExternalLink, Eye, FileCode, GitBranch, Globe, Info, SquareTerminal, Workflow, X } from 'lucide-react';
import { isPanelTool, PANEL_TITLES, type PanelTool } from '@shared/panels';
import type { AgentDef, AgentStatus, GitStatus, Project, SessionView, Thread } from '@shared/types';
import { api } from '../api';
import { usageLevel } from '../contextLevel';
import { FilePreviewPane, type PreviewTarget } from './FilePreview';
import { FilesPanel, type FilesPanelHandle } from './FilesPanel';
import { GitPanel } from './GitPanel';
import { liveNow, TasksPanel, useTasks } from './TasksPanel';
import { addTerminal, TerminalPanel } from './TerminalPanel';
import { isLocalUrl, WebPreview } from './WebPreview';
import { InfoPanel } from './WorkbenchInfo';

export { addTerminal };

export type WorkbenchTab = 'files' | 'git' | 'terminal' | 'tasks' | 'info' | 'preview' | 'web';

export interface WorkbenchHandle {
  openFile: (path: string, line?: number) => void;
  save: () => void;
}

/** The right-hand coding area of Code mode: files + editor, git, terminals, tasks, and session info. */
export const Workbench = forwardRef<
  WorkbenchHandle,
  {
    project: Project;
    thread: Thread | null;
    agentDef?: AgentDef;
    agentDefs: Record<string, AgentDef>;
    agentStatus?: AgentStatus;
    session: SessionView | null;
    onOpenThread: (id: string) => void;
    onFork?: () => void;
    preview: PreviewTarget | null;
    onClosePreview: () => void;
    tab: WorkbenchTab;
    onTab: (t: WorkbenchTab) => void;
    onClose: () => void;
    dark: boolean;
    refreshKey: number;
    /** Main window: open this tool in a window of its own (src/main/panels.ts). Absent on the phone. */
    onDetach?: (tool: PanelTool, url?: string) => void;
    /**
     * A detached tool window: show only this tool, no tab bar (the window has its own header). Links to other tabs
     * (a file from Git, a terminal from Tasks) go to the main window.
     */
    only?: PanelTool;
    /** The Web tool's page when it opens detached. */
    initialWebUrl?: string;
  }
>(function Workbench(props, ref) {
  const only = props.only;
  const files = useRef<FilesPanelHandle>(null);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [localKey, setLocalKey] = useState(0);
  const key = props.refreshKey + localKey;
  const touch = useCallback(() => setLocalKey((k) => k + 1), []);

  useEffect(() => {
    let last = 0;
    const onFocus = () => {
      const now = Date.now();
      if (now - last < 2000) return;
      last = now;
      touch();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [touch]);

  useEffect(() => {
    if (props.tab === 'git' || props.tab === 'info') touch();
  }, [props.tab, touch]);

  const [visited, setVisited] = useState<Set<WorkbenchTab>>(new Set([props.tab]));
  useEffect(() => setVisited((v) => (v.has(props.tab) ? v : new Set([...v, props.tab]))), [props.tab]);
  const gitPanelMounted = visited.has('git');

  useEffect(() => {
    if (gitPanelMounted) return;
    void api.git.status(props.project.id).then(setGit).catch(() => setGit(null));
  }, [props.project.id, key, gitPanelMounted]);

  /** Switch tab; in a detached window, another tool is shown by the main window instead. */
  const goTab = (t: WorkbenchTab) => {
    if (!only) return props.onTab(t);
    if (t !== only) void api.panels.showInMain({ tab: t });
  };
  const openFile = (p: string, line?: number) => {
    if (only && only !== 'files') return void api.panels.showInMain({ tab: 'files', path: p, ...(line ? { line } : {}) });
    props.onTab('files');
    setVisited((v) => new Set([...v, 'files']));
    requestAnimationFrame(() => files.current?.open(p, line));
  };
  useImperativeHandle(ref, () => ({ openFile, save: () => files.current?.saveActive() }));

  const [webUrl, setWebUrl] = useState<string | null>(props.initialWebUrl ?? null);
  useEffect(() => {
    const on = (e: Event) => {
      const url = (e as CustomEvent<{ url: string }>).detail.url;
      if (!isLocalUrl(url)) return void api.openExternal(url);
      // A detached tool other than Web: the main window's Web tab shows the page.
      if (only && only !== 'web') return void api.panels.showInMain({ tab: 'web', path: url });
      setWebUrl(url);
      if (!only) props.onTab('web');
    };
    window.addEventListener('olympus:web-preview', on);
    return () => window.removeEventListener('olympus:web-preview', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tasks = useTasks(props.thread?.id);
  const now = props.thread ? liveNow(props.thread) : { tools: [], background: [], perms: [], asks: [] };
  const runningTasks =
    tasks.children.filter((c) => c.status === 'running' || c.status === 'starting' || c.status === 'waiting-permission').length + now.tools.length + now.background.length;
  const needsYou = tasks.children.some((c) => c.status === 'waiting-permission') || now.perms.length > 0 || now.asks.length > 0;

  const gitMarks: Record<string, string> = {};
  for (const f of git?.files ?? []) gitMarks[f.path] = f.untracked ? '?' : f.worktree !== '.' ? f.worktree : f.index;

  const tabs: { id: WorkbenchTab; label: string; icon: React.ReactNode }[] = [
    { id: 'files', label: 'Files', icon: <FileCode size={14} /> },
    { id: 'git', label: git?.files.length ? `Git (${git.files.length})` : 'Git', icon: <GitBranch size={14} /> },
    { id: 'terminal', label: 'Terminal', icon: <SquareTerminal size={14} /> },
    {
      id: 'tasks',
      label: runningTasks ? `Tasks (${runningTasks})` : tasks.children.length ? `Tasks · ${tasks.children.length}` : 'Tasks',
      icon: <Workflow size={14} className={needsYou ? 'warn-text' : runningTasks ? 'pulse' : ''} />,
    },
    {
      id: 'info',
      label: 'Info',
      // A small red dot while this chat's context is past the red threshold (the Info panel offers Compact).
      icon: (
        <span className={`wb-info-icon ${usageLevel(props.session?.usage) === 'red' && props.tab !== 'info' ? 'ctx-alert' : ''}`} data-testid="wb-info-icon">
          <Info size={14} />
        </span>
      ),
    },
  ];
  if (props.preview) {
    const name = props.preview.ref.startsWith('olympus-turn:')
      ? 'Turn changes'
      : props.preview.ref.replace(/[#?].*$/, '').replace(/:\d+(:\d+)?$/, '').split('/').pop() || 'Preview';
    tabs.push({ id: 'preview', label: name, icon: <Eye size={14} /> });
  }
  if (webUrl) tabs.push({ id: 'web', label: webUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''), icon: <Globe size={14} /> });

  return (
    <div className={`workbench ${only ? 'is-detached' : ''}`}>
      {!only && (
        <div className="workbench-tabs">
          {tabs.map((t) => [
            <button key={t.id} className={props.tab === t.id ? 'active' : ''} onClick={() => props.onTab(t.id)} data-testid={`wb-${t.id}`} title={t.label}>
              {t.icon} <span className="wb-label">{t.label}</span>
            </button>,
            // Next to the active (or hovered) tab: open this tool in its own window. The tab keeps working here too.
            props.onDetach && isPanelTool(t.id) && (t.id !== 'tasks' || props.thread) && (
              <button
                key={`${t.id}-detach`}
                className="wb-detach"
                title={`Open ${PANEL_TITLES[t.id]} in a new window`}
                aria-label={`Open ${PANEL_TITLES[t.id]} in a new window`}
                data-testid={`wb-detach-${t.id}`}
                onClick={() => props.onDetach?.(t.id as PanelTool, t.id === 'web' ? webUrl ?? undefined : undefined)}
              >
                <ExternalLink size={12} />
              </button>
            ),
          ])}
          <div className="spacer" />
          {props.onFork && props.thread && (
            <button
              className="btn ghost icon wb-sheet-action"
              title="Fork: start a new sub-session from this whole chat"
              aria-label="Fork session"
              data-testid="wb-fork"
              onClick={() => props.onFork?.()}
            >
              <GitBranch size={16} />
            </button>
          )}
          <button className="btn ghost icon" title="Close panel" aria-label="Close panel" data-testid="wb-close" onClick={props.onClose}>
            <X size={18} />
          </button>
        </div>
      )}
      <div className="workbench-body">
        {visited.has('files') && (
          <div className="wb-pane" style={{ display: props.tab === 'files' ? 'flex' : 'none' }}>
            <FilesPanel key={props.project.id} ref={files} projectId={props.project.id} dark={props.dark} gitMarks={gitMarks} refreshKey={props.refreshKey} onSaved={touch} />
          </div>
        )}
        {visited.has('git') && (
          <div className="wb-pane" style={{ display: props.tab === 'git' ? 'flex' : 'none' }}>
            <GitPanel key={props.project.id} projectId={props.project.id} refreshKey={key} onStatus={setGit} onOpenFile={openFile} />
          </div>
        )}
        {visited.has('terminal') && (
          <div className="wb-pane" style={{ display: props.tab === 'terminal' ? 'flex' : 'none' }}>
            <TerminalPanel projectId={props.project.id} visible={props.tab === 'terminal'} canCompose={Boolean(props.thread)} onClose={only ? () => {} : props.onClose} />
          </div>
        )}
        {props.tab === 'tasks' && props.thread && (
          <div className="wb-pane" style={{ display: 'flex' }}>
            <TasksPanel
              thread={props.thread}
              data={tasks}
              agentDefs={props.agentDefs}
              projectPath={props.project.path}
              running={props.session?.status === 'running'}
              onOpenThread={props.onOpenThread}
              onShowTerminal={(ptyId) => {
                if (only) return void api.panels.showInMain({ tab: 'terminal', ptyId });
                addTerminal(props.project.id, ptyId);
                props.onTab('terminal');
              }}
            />
          </div>
        )}
        {webUrl && (
          <div className="wb-pane" style={{ display: props.tab === 'web' ? 'flex' : 'none' }}>
            <WebPreview
              key={webUrl}
              url={webUrl}
              projectId={props.project.id}
              onClose={() => {
                if (only) return props.onClose();
                setWebUrl(null);
                if (props.tab === 'web') props.onTab('terminal');
              }}
            />
          </div>
        )}
        {props.tab === 'preview' && props.preview && (
          <div className="wb-pane" style={{ display: 'flex' }}>
            <FilePreviewPane target={props.preview} dark={props.dark} onClose={props.onClosePreview} editProjectId={props.project.id} onEdit={openFile} />
          </div>
        )}
        {props.tab === 'info' && (
          <div className="wb-pane" style={{ display: 'flex' }}>
            <InfoPanel {...props} refreshKey={key} git={git} onOpenFile={openFile} onTab={goTab} />
          </div>
        )}
      </div>
    </div>
  );
});
