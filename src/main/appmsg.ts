import { runState, sendPrompt, setTurnEndListener } from './agents';

/**
 * Messages the app itself sends to a chat's agent ("your sub-sessions finished", "the job you started
 * finished"). If the agent is busy, the message waits in a queue and goes out as soon as the turn ends, so
 * nothing is lost and nothing interrupts. After the user presses Stop in a chat, the app stays quiet there
 * until the user writes again; anything that waited goes out after that turn.
 */

const queue = new Map<string, string[]>();
const muted = new Set<string>();
let started = false;

function start() {
  if (started) return;
  started = true;
  setTurnEndListener((threadId) => setTimeout(() => flush(threadId), 700));
}

function flush(threadId: string) {
  const list = queue.get(threadId);
  if (!list?.length || muted.has(threadId) || runState(threadId).running) return;
  queue.delete(threadId);
  const text = list.length === 1 ? list[0] : `[Olympus Coder] A few things finished while you were busy:\n\n${list.map((t) => t.replace(/^\[Olympus Coder\] /, '- ')).join('\n\n')}`;
  void sendPrompt(threadId, text, [], { fromApp: true }).catch(() => {
    // Busy after all (another message got in first): try again after that turn.
    queue.set(threadId, [...list, ...(queue.get(threadId) ?? [])]);
  });
}

/** Sends the agent a message now, or after its current turn. */
export function notifyAgent(threadId: string, text: string) {
  start();
  queue.set(threadId, [...(queue.get(threadId) ?? []), text]);
  flush(threadId);
}

export function muteChat(threadId: string) {
  muted.add(threadId);
}
export function unmuteChat(threadId: string) {
  muted.delete(threadId);
}
export const isMuted = (threadId: string) => muted.has(threadId);
