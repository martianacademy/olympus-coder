import { StatusCounts, StatusDot } from './StatusDot';
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Clock, Folder, FolderOpen, FolderSearch, GitBranch, History, Pencil, Plus, Settings2, Trash2, X } from 'lucide-react';
import { ProjectDashboard } from './ProjectSettings';
import type { AgentDef, Project, ThreadMeta } from '@shared/types';
import { AgentLogo } from '../logos';
import { createFoldPruner, isProjectFolded, isThreadFolded, revealFreshThreadOnce, setProjectOpen, setThreadOpen, useSidebarFolds, type SidebarFolds } from '../sidebarState';
import { SidebarRowMenu } from './SidebarRowMenu';

interface Props {
  projects: Project[];
  threads: Record<string, ThreadMeta[]>;
  activeId?: string;
  agentDefs: Record<string, AgentDef>;
  onOpen: (id: string) => void;
  onNew: (projectId: string) => void;
  onFork: (t: ThreadMeta) => void;
  onRename: (t: ThreadMeta, title: string) => void;
  onDelete: (t: ThreadMeta) => void;
  onRemoveProject: (p: Project) => void;
  /** Open "Import from agent…" for this project. */
  onImport?: (p: Project) => void;
  onReveal: (p: Project) => void;
  /** The project's folder is missing (renamed or moved): pick where it is now. */
  onLocate?: (p: Project) => void;
  /** Drag a project up or down: the new order of project ids. */
  onReorder?: (ids: string[]) => void;
  /** The sidebar is the narrow slide-over drawer: each row's buttons fold into one "More" menu so names keep the width. */
  compact?: boolean;
}

/** Projects, each with its chats; sub-sessions (forks) sit under the chat they came from. */
export function Sidebar(props: Props) {
  // Folded projects and parent sessions persist (sidebarState.ts): the sidebar unmounts while the app is locked.
  const folds = useSidebarFolds();
  const { projects, threads, activeId } = props;
  // One pruner per mount: it drops folds of sessions it saw deleted, never of sessions a partial list lacks.
  const [pruneFolds] = useState(createFoldPruner);
  useEffect(() => pruneFolds(projects.map((p) => p.id), threads), [pruneFolds, projects, threads]);
  useEffect(() => revealFreshThreadOnce(activeId, projects.map((p) => p.id), threads), [activeId, projects, threads]);
  // Drag and drop to reorder projects: where the dragged one would land (before or after which project).
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  // The project whose dashboard is open.
  const [dash, setDash] = useState<Project | null>(null);
  const finishDrop = () => {
    if (dragId && drop && drop.id !== dragId && props.onReorder) {
      const ids = props.projects.map((p) => p.id).filter((id) => id !== dragId);
      const at = ids.indexOf(drop.id) + (drop.after ? 1 : 0);
      ids.splice(at, 0, dragId);
      props.onReorder(ids);
    }
    setDragId(null);
    setDrop(null);
  };
  if (!props.projects.length) return <p className="muted small" style={{ padding: '4px 8px' }}>No projects yet. Add a folder with + above.</p>;
  return (
    <>
      {props.projects.map((p) => {
        const open = !isProjectFolded(folds, p.id);
        const list = props.threads[p.id] ?? [];
        const ids = new Set(list.map((t) => t.id));
        // A fork whose parent was deleted shows at the top level.
        const roots = list.filter((t) => !t.parentId || !ids.has(t.parentId));
        return (
          <div
            data-testid="sidebar-project"
            data-project-id={p.id}
            data-open={open}
            className={`project ${dragId === p.id ? 'dragging' : ''} ${drop?.id === p.id && dragId !== p.id ? (drop.after ? 'drop-after' : 'drop-before') : ''}`}
            key={p.id}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              // Over the top half of the project's header: before it; anywhere lower (its chats too): after it.
              const head = e.currentTarget.querySelector('.project-head')!.getBoundingClientRect();
              const after = e.clientY > head.top + head.height / 2;
              if (drop?.id !== p.id || drop.after !== after) setDrop({ id: p.id, after });
            }}
            onDrop={(e) => {
              e.preventDefault();
              finishDrop();
            }}
          >
            <div
              className="project-head"
              data-testid="sidebar-project-toggle"
              aria-expanded={open}
              onClick={() => setProjectOpen(p.id, !open)}
              title={`${p.missing ? 'Folder not found: ' : ''}${p.path}\nDrag to reorder`}
              draggable={Boolean(props.onReorder)}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', p.id);
                setDragId(p.id);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDrop(null);
              }}
            >
              {open ? <ChevronDown size={14} className="muted" /> : <ChevronRight size={14} className="muted" />}
              {open ? <FolderOpen size={15} className="muted" /> : <Folder size={15} className="muted" />}
              {/* Name + counts take the free width; on hover the actions float over its right end (sidebar.css), so the
                  row never gets wider than the list and nothing re-lays out. */}
              <span className="project-label">
                <span className="ellipsis project-name" style={{ fontWeight: 550 }}>
                  {p.name}
                </span>
                <StatusCounts threadIds={list.map((t) => t.id)} />
              </span>
              {props.compact ? (
                <SidebarRowMenu
                  title="Project actions"
                  testId="sidebar-project-more"
                  actions={[
                    ...(p.missing && props.onLocate ? [{ label: 'Locate folder…', icon: <FolderSearch size={14} />, onSelect: () => props.onLocate!(p) }] : []),
                    { label: 'New chat in this project', icon: <Plus size={14} />, onSelect: () => props.onNew(p.id) },
                    { label: 'Project dashboard', icon: <Settings2 size={14} />, onSelect: () => setDash(p) },
                    ...(props.onImport ? [{ label: 'Import from agent…', icon: <History size={14} />, onSelect: () => props.onImport!(p) }] : []),
                    { label: 'Remove from list', icon: <X size={14} />, onSelect: () => props.onRemoveProject(p) },
                  ]}
                />
              ) : (
                <span className="project-actions" data-count={props.onImport ? 4 : 3}>
                  <button className="btn ghost icon" title="New chat in this project" onClick={(e) => (e.stopPropagation(), props.onNew(p.id))}>
                    <Plus size={14} />
                  </button>
                  <button
                    className={`btn ghost icon ${dash?.id === p.id ? 'on' : ''}`}
                    title="Project dashboard: usage, activity and instructions for this project's agents"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDash(p);
                    }}
                  >
                    <Settings2 size={13} />
                  </button>
                  {props.onImport && (
                    <button
                      className="btn ghost icon"
                      title="Import from agent: open a session saved by Claude Code, Codex or another agent in this folder"
                      aria-label="Import from agent"
                      data-testid="sidebar-project-import"
                      onClick={(e) => (e.stopPropagation(), props.onImport!(p))}
                    >
                      <History size={13} />
                    </button>
                  )}
                  <button className="btn ghost icon" title="Remove from list" onClick={(e) => (e.stopPropagation(), props.onRemoveProject(p))}>
                    <X size={13} />
                  </button>
                </span>
              )}
            </div>
            {p.missing && props.onLocate && (
              <div className="thread-row muted small" data-testid="project-missing" title={p.path}>
                <span className="grow ellipsis">Folder not found</span>
                <button className="btn ghost small" data-testid="project-locate" onClick={() => props.onLocate!(p)}>
                  <FolderSearch size={13} /> Locate…
                </button>
              </div>
            )}
            {open && roots.map((t) => <ThreadNode key={t.id} t={t} all={list} folds={folds} {...props} />)}
            {open && !list.length && <div className="thread-row muted small">No chats</div>}
          </div>
        );
      })}
      {dash && (
        <ProjectDashboard
          key={dash.id}
          project={dash}
          agentDefs={props.agentDefs}
          threadIds={(props.threads[dash.id] ?? []).map((t) => t.id)}
          onOpenThread={props.onOpen}
          onClose={() => setDash(null)}
        />
      )}
    </>
  );
}

function ThreadNode(
  props: Props & { t: ThreadMeta; all: ThreadMeta[]; folds: SidebarFolds },
) {
  const { t, all } = props;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);
  const children = all.filter((c) => c.parentId === t.id);
  const open = !isThreadFolded(props.folds, t.projectId, t.id);
  const d = props.agentDefs[t.agentId];
  const commit = () => {
    setEditing(false);
    const v = title.trim();
    if (v && v !== t.title) props.onRename(t, v);
    else setTitle(t.title);
  };
  return (
    <>
      <div
        className={`thread-row ${t.id === props.activeId ? 'active' : ''}`}
        data-testid="sidebar-thread"
        data-thread-id={t.id}
        data-open={children.length > 0 ? open : undefined}
        onClick={() => !editing && props.onOpen(t.id)}
        onDoubleClick={() => setEditing(true)}
      >
        <span
          className="toggle"
          data-testid={children.length > 0 ? 'sidebar-thread-toggle' : undefined}
          aria-expanded={children.length > 0 ? open : undefined}
          onClick={(e) => {
            if (!children.length) return;
            e.stopPropagation();
            setThreadOpen(t.projectId, t.id, !open);
          }}
        >
          {children.length > 0 ? open ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <StatusDot threadId={t.id} />}
        </span>
        {/* Rows with sub-sessions have a chevron right before the logo: their dot sits just left of it. */}
        {children.length > 0 && <StatusDot threadId={t.id} edge />}
        {t.scheduleId ? <Clock size={15} className="muted" /> : d && <AgentLogo def={d} />}
        {editing ? (
          <input
            className="rename-input"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commit}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setTitle(t.title);
                setEditing(false);
              }
            }}
          />
        ) : (
          <span className="title" title={t.title}>
            {t.title}
          </span>
        )}

        {!editing && (
          <span className="row-actions">
            {props.compact ? (
              <SidebarRowMenu
                title="Session actions"
                testId="sidebar-thread-more"
                actions={[
                  { label: 'New sub-session (fork)', icon: <GitBranch size={14} />, onSelect: () => props.onFork(t) },
                  { label: 'Rename', icon: <Pencil size={13} />, onSelect: () => setEditing(true) },
                  { label: 'Delete', icon: <Trash2 size={14} />, onSelect: () => props.onDelete(t), danger: true },
                ]}
              />
            ) : (
              <>
                <button className="btn ghost icon" title="New sub-session (fork)" onClick={(e) => (e.stopPropagation(), props.onFork(t))}>
                  <GitBranch size={13} />
                </button>
                <button className="btn ghost icon" title="Rename" onClick={(e) => (e.stopPropagation(), setEditing(true))}>
                  <Pencil size={12} />
                </button>
                <button className="btn ghost icon" title="Delete" onClick={(e) => (e.stopPropagation(), props.onDelete(t))}>
                  <Trash2 size={13} />
                </button>
              </>
            )}
          </span>
        )}
      </div>
      {open && children.length > 0 && (
        <div className="thread-children">
          {children.map((c) => (
            <ThreadNode key={c.id} {...props} t={c} />
          ))}
        </div>
      )}
    </>
  );
}
