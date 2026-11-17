import { useSyncExternalStore } from 'react';

/**
 * The chat the user just picked that is still loading (its items can take a moment over the phone relay). While it
 * is set, the chat on screen shows a skeleton instead of the previous chat's messages. Cleared when the picked chat
 * mounts, or after a while if it never does (it was deleted, the load failed).
 */
let opening: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const GIVE_UP_MS = 12_000;

export function markOpening(id: string) {
  clearTimeout(timer);
  opening = id;
  timer = setTimeout(() => doneOpening(id), GIVE_UP_MS);
  notify();
}

/** The chat `id` is on screen now (no id: stop waiting for any). */
export function doneOpening(id?: string) {
  if (opening === undefined || (id !== undefined && opening !== id)) return;
  clearTimeout(timer);
  opening = undefined;
  notify();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useOpeningThread = () => useSyncExternalStore(subscribe, () => opening);
