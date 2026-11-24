import { StatusDot } from './StatusDot';
import { useState } from 'react';
import { ChevronDown, ChevronRight, Code2, Flame, FolderOpen, FolderPlus, MessageSquare, MessageSquarePlus, Pin, PinOff, Trash2 } from 'lucide-react';
import type { AgentDef, Project, ThreadMeta, UiMode } from '@shared/types';
import { AgentLogo } from '../logos';

/** Top-left mode switcher: Chat (talk), Code (workbench), and optionally Max (Dual-Mind adversarial deliberation). */
export function ModeSwitch({ mode, onMode, showMax = false }: { mode: UiMode; onMode: (m: UiMode) => void; showMax?: boolean }) {
  return (
    <div className="mode-switch" role="tablist">
      <button className={mode === 'chat' ? 'active' : ''} onClick={() => onMode('chat')} title="Chat (⌘1)" data-testid="mode-chat">
        <MessageSquare size={16} />
        <span className="mode-switch-label">Chat</span>
      </button>
      <button className={mode === 'code' ? 'active' : ''} onClick={() => onMode('code')} title="Code (⌘2)" data-testid="mode-code">
        <Code2 size={16} />
        <span className="mode-switch-label">Code</span>
      </button>
      {showMax && (
        <button className={mode === 'max' ? 'active' : ''} onClick={() => onMode('max')} title="Max effort — Dual-Mind deliberation (⌘3)" data-testid="mode-max">
          <Flame size={16} />
          <span className="mode-switch-label">Max</span>
        </button>
      )}
    </div>
  );
}

function Section({ title, children, initial = true }: { title: string; children: React.ReactNode; initial?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <div style={{ marginTop: 6 }}>
      <div className="section-label clickable" onClick={() => setOpen((o) => !o)}>
        {title} {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </div>
      {open && children}
    </div>
  );
}

/** Chat / Max mode sidebar body: pinned sessions, then recent conversations for the active mode. */
export function ChatThreadLists(props: {
  threads: ThreadMeta[];
  listMode?: 'chat' | 'max';
  activeId?: string;
  agentDefs: Record<string, AgentDef>;
  onOpen: (id: string) => void;
  onPin: (t: ThreadMeta, pinned: boolean) => void;
  onDelete: (t: ThreadMeta) => void;
}) {
  const [all, setAll] = useState(false);
  const targetMode = props.listMode ?? 'chat';
  const visible = props.threads.filter((t) => !t.parentId && !t.nativeSubagent);
  const pinned = visible.filter((t) => t.pinned && (t.mode ?? 'code') === targetMode);
  const recents = visible.filter((t) => !t.pinned && (t.mode ?? 'code') === targetMode);
  const shown = all ? recents : recents.slice(0, 15);
  const row = (t: ThreadMeta) => {
    const d = props.agentDefs[t.agentId];
    return (
      <div key={t.id} className={`thread-row flat ${t.id === props.activeId ? 'active' : ''}`} onClick={() => props.onOpen(t.id)} title={t.title}>
        <StatusDot threadId={t.id} />
        {t.mode !== 'chat' && d ? <AgentLogo def={d} /> : null}
        <span className="title">{t.title}</span>
        <span className="row-actions">
          <button className="btn ghost icon" title={t.pinned ? 'Unpin' : 'Pin'} onClick={(e) => (e.stopPropagation(), props.onPin(t, !t.pinned))}>
            {t.pinned ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
          <button className="btn ghost icon" title="Delete" onClick={(e) => (e.stopPropagation(), props.onDelete(t))}>
            <Trash2 size={13} />
          </button>
        </span>
      </div>
    );
  };
  return (
    <>
      {pinned.length > 0 && <Section title="Pinned">{pinned.map(row)}</Section>}
      <Section title="Recents">
        {shown.map(row)}
        {!recents.length && <div className="small muted" style={{ padding: '4px 10px' }}>No chats yet.</div>}
        {recents.length > 15 && (
          <div className="thread-row flat muted small" onClick={() => setAll((a) => !a)}>
            {all ? 'Show less' : `View all (${recents.length})`}
          </div>
        )}
      </Section>
    </>
  );
}

/** Chat mode's Projects page: every project folder, with a way into its chats or its code. */
export function ProjectsPage(props: {
  projects: Project[];
  threads: ThreadMeta[];
  onChat: (projectId: string) => void;
  onCode: (projectId: string) => void;
  onAdd: () => void;
}) {
  return (
    <>
      <div className="main-head">
        <FolderOpen size={17} />
        <span className="title">Projects</span>
        <div className="spacer" />
        <button className="btn primary small" onClick={props.onAdd}>
          <FolderPlus size={14} /> Add project
        </button>
      </div>
      <div className="page">
        <div className="page-inner">
          {!props.projects.length && <p className="muted">No projects yet. Add a folder with your code.</p>}
          <div className="project-grid">
            {props.projects.map((p) => {
              const list = props.threads.filter((t) => t.projectId === p.id);
              const last = list[0]?.updatedAt;
              return (
                <div key={p.id} className="card project-card">
                  <div className="row">
                    <FolderOpen size={18} color="var(--accent)" />
                    <b className="ellipsis">{p.name}</b>
                  </div>
                  <div className="small muted ellipsis" title={p.path}>
                    {p.path.replace(/^\/Users\/[^/]+/, '~')}
                  </div>
                  <div className="small muted">
                    {list.length} chats{last ? ` · ${new Date(last).toLocaleDateString()}` : ''}
                  </div>
                  <div className="row" style={{ marginTop: 6 }}>
                    <button className="btn small" onClick={() => props.onChat(p.id)}>
                      <MessageSquarePlus size={13} /> Chat
                    </button>
                    <button className="btn small primary" onClick={() => props.onCode(p.id)}>
                      <Code2 size={13} /> Open in Code
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
