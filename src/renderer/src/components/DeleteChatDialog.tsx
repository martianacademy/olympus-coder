import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { AcpSideEffect, DeleteChatTargets } from '@shared/acpSessions';
import type { ThreadMeta } from '@shared/types';
import type { AgentsInfo } from '../App';
import { acpSessionsApi } from '../acpSessionsApi';
import '../acpSessions.css';

/** "3 unmerged commits", "2 uncommitted files", or both. Uncommitted files are committed to the branch before the folder goes. */
function unmergedText(ahead: number, dirty: number): string {
  const parts = [
    ahead ? `${ahead} unmerged commit${ahead === 1 ? '' : 's'}` : '',
    dirty ? `${dirty} uncommitted file${dirty === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return parts.join(' and ') || 'unmerged work';
}

const listNames = (names: string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * Delete a chat. When the chat has user-visible sub-sessions (workers, forks, nested forks), offers an opt-in
 * checkbox to delete them too; when agents hold saved sessions (`session/delete`), offers an opt-in checkbox to
 * delete those too (otherwise agent sessions are only closed and remain in the agent's own history).
 */
export function DeleteChatDialog(props: {
  thread: ThreadMeta;
  initialSubsessions?: { id: string; title: string }[];
  agents: AgentsInfo;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const [targets, setTargets] = useState<DeleteChatTargets | null>(null);
  const [alsoSubsessions, setAlsoSubsessions] = useState(false);
  const [alsoAgent, setAlsoAgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    const fallbackSubs = props.initialSubsessions ?? [];
    acpSessionsApi
      .deleteTargets(props.thread.id)
      .then((res) => live && setTargets(res))
      .catch(() =>
        acpSessionsApi
          .deletable(props.thread.id)
          .then((list) => {
            if (!live) return;
            const ownAgents = [...new Set(list.map((s) => s.agentId))];
            setTargets({ ownAgents, subsessions: fallbackSubs, allAgents: ownAgents });
          })
          .catch(() => live && setTargets({ ownAgents: [], subsessions: fallbackSubs, allAgents: [] })),
      );
    return () => {
      live = false;
    };
  }, [props.thread.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && props.onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy]);

  const subsessions = targets?.subsessions ?? props.initialSubsessions ?? [];
  const subCount = subsessions.length;
  const deleteSubs = alsoSubsessions && subCount > 0;
  const agentIds = targets ? (deleteSubs ? targets.allAgents : targets.ownAgents) : null;
  const nameOf = (id: string) => props.agents.defs.find((d) => d.id === id)?.name ?? id;
  const names = listNames((agentIds ?? []).map(nameOf));
  // Worktrees that would lose their folder: this chat's own, plus its sub-sessions' when those are deleted too.
  const worktrees = (targets?.unmergedWorktrees ?? []).filter((w) => w.id === props.thread.id || deleteSubs);

  async function remove() {
    setBusy(true);
    let results: Record<string, AcpSideEffect> = {};
    try {
      results = await acpSessionsApi.deleteChat(props.thread.id, alsoAgent && Boolean(agentIds?.length), deleteSubs);
    } catch {
      setBusy(false);
      setFailed(['__chat']);
      return;
    }
    const bad = alsoAgent ? Object.entries(results).filter(([, r]) => r !== 'done').map(([id]) => nameOf(id)) : [];
    if (bad.length) {
      setBusy(false);
      setFailed(bad);
      return;
    }
    props.onDeleted();
  }

  const done = failed.length > 0 && failed[0] !== '__chat';

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && !busy && (done ? props.onDeleted() : props.onCancel())}>
      <div className="modal narrow acps-confirm" role="alertdialog" aria-label="Delete chat" data-testid="delete-chat-dialog">
        <div className="modal-head row">
          <span>{done ? (deleteSubs ? 'Chats deleted' : 'Chat deleted') : 'Delete chat?'}</span>
        </div>
        <div className="modal-body col acps-confirm-body">
          {done ? (
            <div className="small">
              {listNames(failed)} couldn't delete {failed.length > 1 ? 'their' : 'its'} saved {deleteSubs ? 'sessions' : 'session'}.{' '}
              {deleteSubs ? 'They stay' : 'It stays'} in the agent's own history.
            </div>
          ) : (
            <>
              <div>
                “<span className="acps-confirm-title">{props.thread.title}</span>” will be removed from Olympus Coder. This can't be undone.
              </div>
              {subCount > 0 && (
                <label className="acps-check" data-testid="delete-chat-also-subsessions">
                  <input type="checkbox" checked={alsoSubsessions} onChange={(e) => setAlsoSubsessions(e.target.checked)} disabled={busy} />
                  <span>
                    Also delete {subCount === 1 ? 'its sub-session' : `all ${subCount} sub-sessions`}
                    <span className="small muted acps-check-hint">
                      {subCount === 1
                        ? `“${subsessions[0].title}” — leave unchecked to keep it in the sidebar.`
                        : 'Leave unchecked to keep them as top-level chats in the sidebar.'}
                    </span>
                  </span>
                </label>
              )}
              {agentIds && agentIds.length > 0 && (
                <label className="acps-check" data-testid="delete-chat-also-agent">
                  <input type="checkbox" checked={alsoAgent} onChange={(e) => setAlsoAgent(e.target.checked)} disabled={busy} />
                  <span>
                    Also delete the saved {deleteSubs ? 'sessions' : 'session'} in {names}
                    <span className="small muted acps-check-hint">
                      {deleteSubs
                        ? "The agent's own copies of these conversations, used to resume them."
                        : "The agent's own copy of this conversation, used to resume it."}
                    </span>
                  </span>
                </label>
              )}
              {worktrees.length > 0 && (
                <div className="col small" style={{ gap: 4 }} data-testid="delete-chat-worktrees">
                  {worktrees.map((w) => (
                    <div key={w.id} className="muted">
                      <span className="mono">{w.branch}</span> has {unmergedText(w.ahead, w.dirtyFiles)}. The folder is removed; the branch is kept.
                    </div>
                  ))}
                </div>
              )}
              {failed[0] === '__chat' && <div className="error-text">The chat couldn't be deleted. Try again.</div>}
            </>
          )}
        </div>
        <div className="acps-actions row">
          <div className="spacer" />
          {done ? (
            <button className="btn primary" onClick={props.onDeleted} autoFocus>
              Close
            </button>
          ) : (
            <>
              <button className="btn" onClick={props.onCancel} disabled={busy}>
                Cancel
              </button>
              <button className="btn danger acps-danger" onClick={() => void remove()} disabled={busy || agentIds === null} autoFocus data-testid="delete-chat-confirm">
                {busy && <Loader2 size={14} className="spin" />} Delete
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
