import { useEffect, useMemo, useState } from 'react';
import { Archive, ArchiveRestore, ChevronDown, Loader2, X } from 'lucide-react';
import type { AcpSessionSupport, NativeSessionView } from '@shared/acpSessions';
import type { AgentDef, ThreadMeta } from '@shared/types';
import type { AgentsInfo } from '../App';
import { acpSessionsApi, sessionAge } from '../acpSessionsApi';
import { AgentLogo } from '../logos';
import '../acpSessions.css';

/**
 * "Import from <Agent>": the agent's own saved sessions for this project's folder (`session/list`, paged), each
 * opening as an Olympus chat bound to that session. Sessions that already are a chat open it instead.
 */
export function ImportSessionsDialog(props: {
  projectId: string;
  projectName: string;
  agents: AgentsInfo;
  agentId: string;
  onClose: () => void;
  onOpen: (meta: ThreadMeta) => void;
}) {
  const usable = useMemo(() => props.agents.defs.filter((d) => props.agents.statuses[d.id]?.state !== 'not-installed'), [props.agents]);
  const [agentId, setAgentId] = useState(usable.some((d) => d.id === props.agentId) ? props.agentId : (usable[0]?.id ?? props.agentId));
  const [archived, setArchived] = useState(false);
  const [sessions, setSessions] = useState<NativeSessionView[]>([]);
  const [support, setSupport] = useState<AcpSessionSupport | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const def: AgentDef | undefined = props.agents.defs.find((d) => d.id === agentId);

  async function load(more: boolean) {
    setLoading(true);
    setError('');
    try {
      const page = await acpSessionsApi.list(props.projectId, agentId, { cursor: more ? cursor : undefined, archived: archived ? 'only' : 'exclude' });
      setSupport(page.support);
      setSessions((prev) => (more ? [...prev, ...page.sessions.filter((s) => !prev.some((p) => p.sessionId === s.sessionId))] : page.sessions));
      setCursor(page.nextCursor);
    } catch (e: any) {
      if (!more) setSessions([]);
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSessions([]);
    setCursor(undefined);
    setSupport(null);
    void load(false);
  }, [agentId, archived, props.projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function open(s: NativeSessionView) {
    setBusyId(s.sessionId);
    setError('');
    try {
      props.onOpen(await acpSessionsApi.importSession(props.projectId, agentId, { sessionId: s.sessionId, title: s.title, archived: s.archived }));
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function toggleArchive(s: NativeSessionView) {
    setBusyId(s.sessionId);
    const r = await acpSessionsApi.setArchived(agentId, s.sessionId, !s.archived).catch(() => 'failed' as const);
    setBusyId(null);
    if (r === 'done') setSessions((all) => all.filter((x) => x.sessionId !== s.sessionId));
    else setError(`${def?.name ?? 'The agent'} couldn't ${s.archived ? 'unarchive' : 'archive'} this session.`);
  }

  const agentName = def?.name ?? agentId;
  const empty = !loading && !error && support?.list && sessions.length === 0;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal narrow acps-dialog" role="dialog" aria-label={`Import from ${agentName}`} data-testid="import-sessions-dialog">
        <div className="modal-head row">
          {def && <AgentLogo def={def} />}
          <span className="ellipsis">Import from {agentName}</span>
          <div className="spacer" />
          <button className="btn ghost icon" title="Close" onClick={props.onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="acps-toolbar row">
          <label className="pill mini-select" title="Agent whose saved sessions to list">
            <span className="pill-text">{agentName}</span>
            <ChevronDown size={13} className="pill-caret" />
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Agent" data-testid="import-sessions-agent">
              {usable.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <span className="small muted ellipsis acps-where" title={props.projectName}>
            in {props.projectName}
          </span>
          <div className="spacer" />
          {support?.archive && (
            <button className={`pill-toggle ${archived ? 'on' : ''}`} title="Show only sessions archived in the agent" onClick={() => setArchived((a) => !a)} data-testid="import-sessions-archived">
              <Archive size={12} /> Archived
            </button>
          )}
        </div>
        <div className="modal-body acps-list" data-testid="import-sessions-list">
          {support && !support.list && <div className="acps-note muted">{agentName} can't list its saved sessions.</div>}
          {empty && <div className="acps-note muted">{archived ? 'No archived sessions for this folder.' : `No ${agentName} sessions for this folder yet.`}</div>}
          {sessions.map((s) => (
            <div
              key={s.sessionId}
              className={`acps-row ${busyId === s.sessionId ? 'busy' : ''}`}
              role="button"
              tabIndex={0}
              title={s.threadId ? 'Open the chat for this session' : 'Import as a new chat'}
              onClick={() => busyId === null && void open(s)}
              onKeyDown={(e) => e.key === 'Enter' && busyId === null && void open(s)}
              data-testid="import-session-row"
            >
              <div className="acps-row-main">
                <div className="acps-title ellipsis">{s.title}</div>
                <div className="acps-meta small muted">
                  {sessionAge(s.updatedAt)}
                  {s.threadId && <span className="acps-tag">In Olympus</span>}
                </div>
              </div>
              {busyId === s.sessionId ? (
                <Loader2 size={14} className="spin muted" />
              ) : (
                support?.archive && (
                  <button
                    className="btn ghost icon acps-row-action"
                    title={s.archived ? `Unarchive in ${agentName}` : `Archive in ${agentName}`}
                    onClick={(e) => (e.stopPropagation(), void toggleArchive(s))}
                    data-testid="import-session-archive"
                  >
                    {s.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                  </button>
                )
              )}
            </div>
          ))}
          {loading && (
            <div className="acps-note muted row">
              <Loader2 size={14} className="spin" /> Loading sessions…
            </div>
          )}
          {error && <div className="error-text acps-note">{error}</div>}
          {cursor && !loading && (
            <button className="btn ghost acps-more" onClick={() => void load(true)} data-testid="import-sessions-more">
              Load more
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
