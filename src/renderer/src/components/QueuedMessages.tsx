import { useState } from 'react';
import type { PromptQueueView, QueuedPromptView } from '@shared/promptQueue';
import { promptQueueApi } from '../promptQueueApi';
import { AttachmentChips } from './Attachments';
import { DeliveryTicks } from './DeliveryTicks';

/**
 * Messages waiting to go out, shown dimmed above the composer (below the running reply) with their ticks and small
 * "Send now · Edit · Remove" actions. They leave this list once sent and appear in the chat as normal messages.
 */
export function QueuedMessages({ threadId, queue }: { threadId: string; queue: PromptQueueView | null }) {
  if (!queue?.items.length) return null;
  return (
    <div className="queued-list" data-testid="queued-list">
      {queue.items.map((q) => (
        <QueuedRow key={q.id} threadId={threadId} q={q} sendNowTitle={sendNowTitle(queue, q)} />
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
      {editing !== null ? (
        <textarea
          autoFocus
          value={editing}
          data-testid="queued-edit-input"
          onChange={(e) => setEditing(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(null);
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              const text = editing;
              setEditing(null);
              act(() => promptQueueApi.edit(threadId, q.id, text));
            }
          }}
        />
      ) : (
        <div className="msg-user">{q.text}</div>
      )}
      <div className="queued-foot">
        {editing !== null ? (
          <>
            <button className="link-btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              className="link-btn send-now"
              disabled={!editing.trim()}
              onClick={() => {
                const text = editing;
                setEditing(null);
                act(() => promptQueueApi.edit(threadId, q.id, text));
              }}
            >
              Save
            </button>
          </>
        ) : (
          <>
            <button className="link-btn send-now" disabled={busy} title={sendNowTitle} onClick={() => act(() => promptQueueApi.sendNow(threadId, q.id))} data-testid="queued-send-now">
              Send now
            </button>
            <button className="link-btn" disabled={busy} title="Change this message before it goes out" onClick={() => setEditing(q.text)} data-testid="queued-edit">
              Edit
            </button>
            <button className="link-btn" disabled={busy} title="Remove this message; it won't be sent" onClick={() => act(() => promptQueueApi.remove(threadId, q.id))} data-testid="queued-remove">
              Remove
            </button>
          </>
        )}
        <DeliveryTicks ticks={q.ticks} label={q.label} />
      </div>
    </div>
  );
}
