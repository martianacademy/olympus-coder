import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, Folder, FolderPlus, Sparkles } from 'lucide-react';
import type { AgentDef, Project, ThreadMeta, UserProfile } from '@shared/types';
import type { AgentsInfo } from '../App';
import { HOME_DRAFT_KEY, useDraft } from '../drafts';
import { useOpenFile } from '../fileLinks';
import { AgentLogo } from '../logos';
import { AttachButton, AttachmentChips, useAttachments } from './Attachments';
import { HomeSessionOptions } from './HomeSessionOptions';
import type { AttachmentView } from '@shared/types';
import { enterSends } from '../platform';

function greeting(name: string) {
  const h = new Date().getHours();
  const first = name.trim().split(/\s+/)[0];
  const late = h < 5 || h >= 22;
  const part = late ? 'Late night coding' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  // Only the late-night line is a question.
  return `${part}${first ? `, ${first}` : ''}${late ? '?' : ''}`;
}

/** Chat mode's start page: greeting, one big composer, and where / with whom the chat should run. */
export function ChatHome(props: {
  profile: UserProfile;
  projects: Project[];
  general: Project | null;
  agents: AgentsInfo;
  agentId: string;
  projectId: string;
  recents: ThreadMeta[];
  onAgent: (id: string) => void;
  onProject: (id: string) => void;
  onAddProject: () => void;
  onStart: (text: string, files: AttachmentView[]) => void;
  onOpen: (id: string) => void;
}) {
  const { text, setText, clear: clearHomeDraft } = useDraft(HOME_DRAFT_KEY);
  const openFile = useOpenFile();
  const [menu, setMenu] = useState<'project' | 'agent' | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const att = useAttachments(HOME_DRAFT_KEY);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  const allProjects = useMemo(() => [...(props.general ? [props.general] : []), ...props.projects], [props.general, props.projects]);
  const project = allProjects.find((p) => p.id === props.projectId) ?? allProjects[0];
  const agent: AgentDef | undefined = props.agents.defs.find((d) => d.id === props.agentId) ?? props.agents.defs[0];
  const canSend = Boolean(text.trim() || att.files.length);
  const send = () => {
    if (!canSend) return;
    const files = att.files;
    const trimmed = text.trim();
    clearHomeDraft();
    props.onStart(trimmed, files);
  };

  return (
    <div className={`chat-home ${att.dragging ? 'pane-dragging' : ''}`} {...att.dropProps}>
      <div className="chat-home-inner">
        <h1 className="greeting">
          <Sparkles size={30} color="var(--accent)" /> {greeting(props.profile.name)}
        </h1>
        <div className={`home-composer ${att.dragging ? 'dragging' : ''}`}>
          <AttachmentChips files={att.files} onRemove={att.remove} onAnnotate={att.annotate} onOpen={(a) => openFile(a.path)} />
          <div className="growable-textarea" data-replicated-value={text}>
            <textarea
              onPaste={att.onPaste}
              ref={ta}
              rows={2}
              spellCheck={false}
              value={text}
              placeholder="Ask anything or describe a task…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (enterSends(e)) {
                  e.preventDefault();
                  send();
                }
              }}
              data-testid="home-composer"
            />
          </div>
          <div className="composer-bar">
            <AttachButton onClick={() => void att.pick()} onFiles={att.addRawFiles} />
            {att.error && <span className="error-text small ellipsis">{att.error}</span>}
            <div className="spacer" />
            <div className="composer-send">
              <button className="btn primary icon send-btn" disabled={!canSend} onClick={send} title="Send">
                <ArrowUp size={17} />
              </button>
            </div>
          </div>
          {att.dragging && <div className="drop-hint">Drop files here</div>}
        </div>
        {/* The agent is chosen in the top-left picker, the same place as everywhere else in the app. */}
        <div className="home-pickers" ref={wrap}>
          <div className="picker">
            <button className="pill mini-select" onClick={() => setMenu(menu === 'project' ? null : 'project')}>
              <Folder size={14} /> <span className="pill-text">{project?.id === 'general' ? 'Project or folder' : project?.name}</span> <ChevronDown size={13} className="pill-caret" />
            </button>
            {menu === 'project' && (
              <div className="menu">
                {allProjects.map((p) => (
                  <div key={p.id} className={`menu-item ${p.id === project?.id ? 'selected' : ''}`} onClick={() => (props.onProject(p.id), setMenu(null))}>
                    <Folder size={15} className="muted" />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div>{p.id === 'general' ? 'General (no project)' : p.name}</div>
                      <div className="small muted ellipsis">{p.path.replace(/^\/Users\/[^/]+/, '~')}</div>
                    </div>
                  </div>
                ))}
                <div className="menu-sep" />
                <div className="menu-item" onClick={() => (setMenu(null), props.onAddProject())}>
                  <FolderPlus size={15} className="muted" /> Add folder…
                </div>
              </div>
            )}
          </div>
          {project && agent && <HomeSessionOptions projectId={project.id} agentId={agent.id} />}
        </div>
        {props.recents.length > 0 && (
          <div className="home-recents">
            <div className="row small muted" style={{ marginBottom: 8 }}>
              Recent chats
            </div>
            <div className="recent-grid">
              {props.recents.slice(0, 3).map((t) => {
                const d = props.agents.defs.find((x) => x.id === t.agentId);
                return (
                  <div key={t.id} className="recent-card" onClick={() => props.onOpen(t.id)}>
                    <div className="row" style={{ gap: 6 }}>
                      {d && <AgentLogo def={d} />}
                      <span className="small muted">{new Date(t.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                    </div>
                    <div className="recent-title">{t.title}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
