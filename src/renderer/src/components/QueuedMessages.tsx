import { useState } from 'react';
import type { PromptQueueView, QueuedPromptView } from '@shared/promptQueue';
import { promptQueueApi, usePromptQueue } from '../promptQueueApi';
import { addDraftFiles, getDraft, setDraftText } from '../drafts';
import { AttachmentChips } from './Attachments';
import { DeliveryTicks } from './DeliveryTicks';

/**
 * Messages waiting to go out, rendered inside the scrollable chat stream (below the running reply)
 * with their delivery ticks and "Send now · Edit · Remove" actions so long pending prompts and
 * attachments scroll naturally instead of squeezing the chat viewport.
 */
export function QueuedMessages({ threadId, queue }: { threadId: string; queue?: PromptQueueView | null }) {
  const liveQueue = usePromptQueue(threadId);
  const effective = queue !== undefined ? queue : liveQueue;
  if (!effective?.items.length) return null;
  return (
    <div className="queued-list" data-testid="queued-list">
      {effective.items.map((q) => (
        <QueuedRow key={q.id} threadId={threadId} q={q} sendNowTitle={sendNowTitle(effective, q)} />
      ))}
    </div>
  );
}

function sendNowTitle(queue: PromptQueueView, q: QueuedPromptView): string {
  if (q.ticks === 1) return 'Start the agent and send this first';
  if (q.reason === 'held') return 'Send this now';
  return queue.sendNow === 'steer' ? 'Add this to the running reply now (the agent reads it mid-turn)' : 'Stop the current reply and send this right away';
}

function QueuedRow({ threadId, q, sendNowTitle }: { threadId: string; q: QueuedPromptView; sendNowTitle: string }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<unknown>) => {
    setBusy(true);
    void fn()
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  return (
    <div className="queued-msg" data-testid="queued-msg" data-reason={q.reason}>
      {q.attachments?.length ? <AttachmentChips files={q.attachments} /> : null}
      <div className="msg-user">{q.text}</div>
      {editing !== null && (
        // The composer already has a draft: edit the queued message in a roomy window instead.
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setEditing(null)}>
          <div className="modal queued-edit-modal" role="dialog" aria-label="Edit queued message" data-testid="queued-edit-dialog">
            <div className="modal-head row">
              <span>Edit queued message</span>
            </div>
            <div className="modal-body col">
              <textarea
                autoFocus
                value={editing}
                data-testid="queued-edit-input"
                onChange={(e) => setEditing(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditing(null);
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && editing.trim()) {
                    e.preventDefault();
                    const text = editing;
                    setEditing(null);
                    act(() => promptQueueApi.edit(threadId, q.id, text));
                  }
                }}
              />
              <div className="row queued-edit-actions">
                <span className="small muted grow">⌘↵ to save · Esc to cancel</span>
                <button className="btn ghost small" onClick={() => setEditing(null)}>
                  Cancel
                </button>
                <button
                  className="btn primary small"
                  disabled={!editing.trim()}
                  data-testid="queued-edit-save"
                  onClick={() => {
                    const text = editing;
                    setEditing(null);
                    act(() => promptQueueApi.edit(threadId, q.id, text));
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="queued-foot">
        {
          <>
            <button className="link-btn send-now" disabled={busy} title={sendNowTitle} onClick={() => act(() => promptQueueApi.sendNow(threadId, q.id))} data-testid="queued-send-now">
              Send now
            </button>
            <button
              className="link-btn"
              disabled={busy}
              title="Change this message before it goes out"
              onClick={() => {
                // An empty composer: take the message back into it (with its files) to edit and send again there.
                const draft = getDraft(threadId);
                if (draft.text.trim() || draft.files.length) return setEditing(q.text);
                act(async () => {
                  const removed = await promptQueueApi.remove(threadId, q.id);
                  if (!removed) return; // already on its way to the agent
                  setDraftText(threadId, q.text);
                  if (q.attachments?.length) addDraftFiles(threadId, q.attachments);
                  requestAnimationFrame(() => {
                    const box = document.querySelector<HTMLTextAreaElement>('textarea[data-testid="composer"]');
                    box?.focus();
                    box?.setSelectionRange(box.value.length, box.value.length);
                  });
                });
              }}
              data-testid="queued-edit"
            >
              Edit
            </button>
            <button className="link-btn" disabled={busy} title="Remove this message; it won't be sent" onClick={() => act(() => promptQueueApi.remove(threadId, q.id))} data-testid="queued-remove">
              Remove
            </button>
          </>
        }
        <DeliveryTicks ticks={q.ticks} label={q.label} />
      </div>
    </div>
  );
}
