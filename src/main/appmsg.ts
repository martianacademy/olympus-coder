import { runState, startPrompt, setTurnEndListener, steerPrompt } from './agents';
import { findThread } from './store';

/**
 * Messages the app itself sends to a chat's agent ("your sub-sessions finished", "the job you started
 * finished"). If the agent is busy, the message waits in a queue and goes out as soon as the turn ends, so
 * nothing is lost and nothing interrupts. After the user presses Stop in a chat, the app stays quiet there
 * until the user writes again; anything that waited goes out after that turn.
 */

interface Pending {
  text: string;
  /** Called once the agent got the message (it answered after it), never when the turn failed to start. */
  onDelivered?: () => void;
}

const queue = new Map<string, Pending[]>();
const muted = new Set<string>();
let started = false;

function start() {
  if (started) return;
  started = true;
  setTurnEndListener((threadId) => setTimeout(() => flush(threadId), 700));
}

/** The agent answered after this item: it received the message (a turn that never reached it has only an error). */
function answered(threadId: string, itemId: string): boolean {
  const items = findThread(threadId)?.items ?? [];
  const at = items.findIndex((i) => i.id === itemId);
  return at >= 0 && items.slice(at + 1).some((i) => i.kind === 'agent' || i.kind === 'tool' || i.kind === 'thought');
}

function flush(threadId: string) {
  const list = queue.get(threadId);
  if (!list?.length || muted.has(threadId) || runState(threadId).running) return;
  queue.delete(threadId);
  const text =
    list.length === 1 ? list[0].text : `[Olympus Coder] A few things finished while you were busy:\n\n${list.map((p) => p.text.replace(/^\[Olympus Coder\] /, '- ')).join('\n\n')}`;
  let sent: ReturnType<typeof startPrompt>;
  try {
    sent = startPrompt(threadId, text, [], { fromApp: true });
  } catch {
    // Could not start a turn now: try again after the next one.
    queue.set(threadId, [...list, ...(queue.get(threadId) ?? [])]);
    return;
  }
  // No item = a turn had started after all, so it waits in the chat's send queue (still delivered, but untracked).
  const item = sent.item;
  if (!item) return;
  void sent.done.then(() => {
    if (!answered(threadId, item.id)) return;
    for (const p of list) p.onDelivered?.();
  });
}

/** Sends the agent a message now, or after its current turn. */
export function notifyAgent(threadId: string, text: string, onDelivered?: () => void) {
  start();
  queue.set(threadId, [...(queue.get(threadId) ?? []), { text, onDelivered }]);
  flush(threadId);
}

/**
 * Puts the message into the agent's running turn (ACP steering), shown as the app's message. Returns false when that
 * did not happen (no turn runs any more, or the agent refused); the caller then sends it another way.
 */
export async function steerAgent(threadId: string, text: string): Promise<boolean> {
  if (muted.has(threadId)) return false;
  const r = await steerPrompt(threadId, text, [], { fromApp: true }).catch(() => ({ outcome: 'failed' as const }));
  return r.outcome === 'injected';
}

export function muteChat(threadId: string) {
  muted.add(threadId);
}
export function unmuteChat(threadId: string) {
  muted.delete(threadId);
}
export const isMuted = (threadId: string) => muted.has(threadId);
