import { useEffect, useState } from 'react';
import type { AttachmentView } from '@shared/types';
import type { PromptQueueView } from '@shared/promptQueue';
import { onEvent } from './api';

/** Renderer calls for the send-while-busy queue (handlers `queue.*` in src/main/index.ts). */
const call = <T,>(method: string, ...args: unknown[]): Promise<T> => window.desk.invoke(method, ...args);

export const promptQueueApi = {
  /** Sends now, or queues while the agent is busy or offline. */
  submit: (threadId: string, text: string, files: AttachmentView[] = []) => call<'sent' | 'queued'>('queue.submit', threadId, text, files),
  get: (threadId: string) => call<PromptQueueView>('queue.get', threadId),
  remove: (threadId: string, id: string) => call<unknown>('queue.remove', threadId, id),
  edit: (threadId: string, id: string, text: string) => call<boolean>('queue.edit', threadId, id, text),
  sendNow: (threadId: string, id: string) => call<string>('queue.sendNow', threadId, id),
};

/** The chat's queued messages, live. */
export function usePromptQueue(threadId: string): PromptQueueView | null {
  const [view, setView] = useState<PromptQueueView | null>(null);
  useEffect(() => {
    setView(null);
    let live = true;
    void promptQueueApi
      .get(threadId)
      .then((v) => live && setView(v))
      .catch(() => {});
    const off = onEvent((channel, payload) => {
      if (channel === 'queue:state' && (payload as PromptQueueView).threadId === threadId) setView(payload as PromptQueueView);
    });
    return () => {
      live = false;
      off();
    };
  }, [threadId]);
  return view;
}
