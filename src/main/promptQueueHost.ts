// Plugs the send-while-busy queue (src/main/promptQueue.ts) into the live chats of agents.ts and the thread store.
import type { DeskEvents } from '@shared/types';
import type { PromptQueueEvents } from '@shared/promptQueue';
import * as agents from './agents';
import { initPromptQueue, onTurnEnd, resumeAll } from './promptQueue';
import { findThread, listAllThreads, saveThread } from './store';

type Emit = <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => void;
type EmitQueue = <K extends keyof PromptQueueEvents>(channel: K, payload: PromptQueueEvents[K]) => void;

export function startPromptQueue(emit: Emit, emitQueue: EmitQueue): void {
  initPromptQueue({
    thread: (id) => findThread(id),
    save: (t) => saveThread(t),
    pushItem: (threadId, item) => {
      const t = findThread(threadId);
      if (t) saveThread(t);
      emit('thread:item', { threadId, item });
    },
    emit: (view) => emitQueue('queue:state', view),
    agentName: (threadId) => {
      const id = findThread(threadId)?.agentId;
      return agents.allAgents().find((d) => d.id === id)?.name ?? id ?? 'The agent';
    },
    // `running` covers both the user's turns and the ones an agent starts itself (agentInitiated.ts).
    busy: (threadId) => agents.runState(threadId).running,
    connection: (threadId) => agents.connectionState(threadId),
    connect: (threadId) => agents.ensureSession(threadId),
    send: (threadId, q) => agents.deliverPrompt(threadId, q.text, q.attachments ?? [], { fromAgent: q.fromAgent, fromApp: q.fromApp }),
    canSteer: (threadId) => agents.canSteer(threadId),
    steer: (threadId, text, attachments) => agents.steerPrompt(threadId, text, attachments),
    cancel: (threadId) => agents.cancel(threadId),
  });
  agents.setTurnEndListener(onTurnEnd);
}

/** After start-up: chats that still had queued messages (they are kept in the thread) send them once connected. */
export function resumeQueues(): void {
  resumeAll(listAllThreads().filter((m) => (m as { queue?: unknown[] }).queue?.length).map((m) => m.id));
}
