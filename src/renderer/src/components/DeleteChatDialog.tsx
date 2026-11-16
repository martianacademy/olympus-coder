import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { AcpSideEffect } from '@shared/acpSessions';
import type { ThreadMeta } from '@shared/types';
import type { AgentsInfo } from '../App';
import { acpSessionsApi } from '../acpSessionsApi';
import '../acpSessions.css';

const listNames = (names: string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * Delete a chat. When agents hold a saved session for it, one checkbox (off by default) also deletes those
 * (`session/delete`); otherwise the agent sessions are only closed and stay in the agent's own history.
 */
export function DeleteChatDialog(props: { thread: ThreadMeta; agents: AgentsInfo; onCancel: () => void; onDeleted: () => void }) {
  const [agentIds, setAgentIds] = useState<string[] | null>(null);
  const [alsoAgent, setAlsoAgent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    acpSessionsApi
      .deletable(props.thread.id)
      .then((list) => live && setAgentIds([...new Set(list.map((s) => s.agentId))]))
      .catch(() => live && setAgentIds([]));
    return () => {
      live = false;
    };
  }, [props.thread.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && props.onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy]);

  const nameOf = (id: string) => props.agents.defs.find((d) => d.id === id)?.name ?? id;
  const names = listNames((agentIds ?? []).map(nameOf));

  async function remove() {
    setBusy(true);
    let results: Record<string, AcpSideEffect> = {};
    try {
      results = await acpSessionsApi.deleteChat(props.thread.id, alsoAgent && Boolean(agentIds?.length));
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
          <span>{done ? 'Chat deleted' : 'Delete chat?'}</span>
        </div>
        <div className="modal-body col acps-confirm-body">
          {done ? (
            <div className="small">
              {listNames(failed)} couldn't delete {failed.length > 1 ? 'their' : 'its'} saved session. It stays in the agent's own history.
            </div>
          ) : (
            <>
              <div>
                “<span className="acps-confirm-title">{props.thread.title}</span>” will be removed from Olympus Coder. This can't be undone.
              </div>
              {agentIds && agentIds.length > 0 && (
                <label className="acps-check" data-testid="delete-chat-also-agent">
                  <input type="checkbox" checked={alsoAgent} onChange={(e) => setAlsoAgent(e.target.checked)} disabled={busy} />
                  <span>
                    Also delete the saved session in {names}
                    <span className="small muted acps-check-hint">The agent's own copy of this conversation, used to resume it.</span>
                  </span>
                </label>
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
