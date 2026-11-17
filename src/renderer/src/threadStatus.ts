import { useSyncExternalStore } from 'react';
import type { RunningTask } from '@shared/types';
import { api, onEvent } from './api';
import { onPageVisibility, pageVisible } from './visibility';

/**
 * What each chat is doing, for the sidebar dots and the chat's background bar: working on a turn, waiting for
 * your approval, still running work in the background after the turn ended (a command the agent left
 * running, a terminal it opened), failed, or finished while you were looking at another chat (cleared when
 * you open it).
 */
export type ThreadStatus = 'running' | 'waiting' | 'background' | 'error' | 'done' | undefined;

const status = new Map<string, ThreadStatus>();
const running = new Set<string>();
const waiting = new Map<string, Set<string>>();
/** Questions from the agent waiting for an answer, per chat. Kept across turn ends (an MCP login link can be open while idle). */
const asking = new Map<string, Set<string>>();
/** Tool cards still running per chat (live tool ids), from item events. */
const liveTools = new Map<string, Set<string>>();
/** Programs the app started, per chat (agent commands and terminals its agent opened), polled. */
let procsByThread = new Map<string, RunningTask[]>();
const listeners = new Set<() => void>();
let activeId: string | undefined;
let started = false;
let version = 0;

const notify = () => {
  version++;
  listeners.forEach((l) => l());
};
const set = (id: string, s: ThreadStatus) => {
  if (status.get(id) === s) return;
  if (s) status.set(id, s);
  else status.delete(id);
  notify();
};
const hasBackground = (id: string) => Boolean(liveTools.get(id)?.size || procsByThread.get(id)?.length);

const recompute = (id: string, finished = false) => {
  if (waiting.get(id)?.size || asking.get(id)?.size) return set(id, 'waiting');
  if (running.has(id)) return set(id, 'running');
  if (hasBackground(id)) return set(id, 'background');
  const cur = status.get(id);
  // A turn or its background work just ended while the user was elsewhere: "done", until they open it.
  if ((finished || cur === 'background') && id !== activeId) return set(id, 'done');
  if (cur === 'running' || cur === 'waiting' || cur === 'background') set(id, undefined);
};

const signature = () =>
  JSON.stringify([[...running].sort(), [...waiting].map(([k, v]) => [k, [...v].sort()]), [...asking].map(([k, v]) => [k, [...v].sort()]), [...liveTools].map(([k, v]) => [k, [...v].sort()])]);

async function resync() {
  const all = await api.chatStates().catch(() => null);
  if (!all) return; // locked, or the main process is busy: keep what we have
  const before = signature();
  const wasRunning = new Set(running);
  const ids = new Set([...running, ...waiting.keys(), ...asking.keys(), ...liveTools.keys(), ...all.map((s) => s.threadId)]);
  running.clear();
  waiting.clear();
  asking.clear();
  liveTools.clear();
  for (const s of all) {
    if (s.status === 'running') running.add(s.threadId);
    if (s.permissionIds?.length) waiting.set(s.threadId, new Set(s.permissionIds));
    if (s.askIds?.length) asking.set(s.threadId, new Set(s.askIds));
    if (s.background.length) liveTools.set(s.threadId, new Set(s.background));
  }
  if (signature() === before) return;
  for (const id of ids) recompute(id, wasRunning.has(id) && !running.has(id));
  notify();
}

function start() {
  if (started) return;
  started = true;
  onEvent((ch, p) => {
    if (ch === 'session:state') {
      const was = running.has(p.threadId);
      if (p.status === 'running') running.add(p.threadId);
      else {
        running.delete(p.threadId);
        waiting.delete(p.threadId); // a finished turn has no open permission requests
      }
      if (p.status === 'error' || p.status === 'needs-login') {
        if (p.threadId !== activeId) set(p.threadId, 'error');
        return;
      }
      recompute(p.threadId, was && p.status !== 'running');
    } else if (ch === 'thread:item') {
      const it = p.item;
      if (it.kind === 'permission') {
        const w = waiting.get(p.threadId) ?? new Set<string>();
        if (it.resolved) {
          w.delete(it.id);
          w.delete('?');
        } else w.add(it.id);
        waiting.set(p.threadId, w);
        recompute(p.threadId);
      } else if (it.kind === 'elicitation') {
        const w = asking.get(p.threadId) ?? new Set<string>();
        if (it.resolved) w.delete(it.id);
        else w.add(it.id);
        asking.set(p.threadId, w);
        recompute(p.threadId);
      } else if (it.kind === 'tool') {
        const t = liveTools.get(p.threadId) ?? new Set<string>();
        const before = t.size;
        if (it.status === 'in_progress' || it.status === 'pending') t.add(it.id);
        else t.delete(it.id);
        liveTools.set(p.threadId, t);
        if (t.size !== before) recompute(p.threadId);
      } else if (it.kind === 'error' && !running.has(p.threadId) && p.threadId !== activeId) {
        set(p.threadId, 'error');
      }
    }
  });
  // The truth from the main process: when the window (re)loads, when it is shown again, right after an unlock
  // (no events reach the window while the app is locked, so a tool or turn that ended meanwhile would look running
  // for ever), and every few seconds as a safety net — often while work is going, rarely when all is idle.
  const resyncLoop = pacedLoop(resync, BUSY_MS, IDLE_RESYNC_MS);
  onEvent((ch, p) => ch === 'lock:state' && !p?.locked && void resync());
  // The real programs behind background work (a `ps` scan in the main process, the heaviest call here): every few
  // seconds only while some chat has work going, a program is still alive, or a terminal was just used.
  const poll = async () => {
    const list = await api.procs().catch(() => [] as RunningTask[]);
    const next = new Map<string, RunningTask[]>();
    for (const t of list) if (t.threadId) next.set(t.threadId, [...(next.get(t.threadId) ?? []), t]);
    const touched = new Set([...procsByThread.keys(), ...next.keys()]);
    const changed = JSON.stringify([...procsByThread]) !== JSON.stringify([...next]);
    procsByThread = next;
    if (changed) {
      for (const id of touched) recompute(id);
      notify();
    }
  };
  const procsLoop = pacedLoop(poll, BUSY_MS, IDLE_PROCS_MS);
  // Something is starting: check sooner than the idle pace (a no-op when a check is already that close).
  onEvent((ch, p) => {
    if (ch === 'session:state') {
      resyncLoop.wake(BUSY_MS);
      procsLoop.wake(p.status === 'running' ? BUSY_MS : 600);
    } else if (ch === 'thread:item' && p.item.kind === 'tool' && (p.item.status === 'in_progress' || p.item.status === 'pending')) {
      procsLoop.wake(BUSY_MS);
    } else if (ch === 'terminal:opened' || ch === 'terminal:changed' || ch === 'pty:exit' || ch === 'pty:data') {
      // A terminal in use may be running a program a chat owns (an agent's run_in_terminal, a dev server).
      activityUntil = Date.now() + ACTIVITY_MS;
      procsLoop.wake(ch === 'pty:data' ? BUSY_MS : 600);
    }
  });
}

const BUSY_MS = 4000;
const IDLE_RESYNC_MS = 15_000;
const IDLE_PROCS_MS = 30_000;
/** How long after a terminal was last used its programs are still checked at the busy pace. */
const ACTIVITY_MS = 20_000;
let activityUntil = 0;
const anyIn = (m: Map<string, Set<string>>) => [...m.values()].some((s) => s.size > 0);
/** Some chat is working, waiting, has a tool or program still running, or a terminal was just used. */
const busy = () => running.size > 0 || anyIn(liveTools) || anyIn(waiting) || procsByThread.size > 0 || Date.now() < activityUntil;

/**
 * Runs `fn` now and then again and again: every `busyMs` while `busy()`, else every `idleMs`; never while the page
 * is hidden (a background phone page, a hidden window), and once at once when it is shown again. `wake(ms)` brings
 * the next run forward to at most `ms` from now.
 */
function pacedLoop(fn: () => Promise<void>, busyMs: number, idleMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let due = Infinity;
  let inFlight = false;
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
    due = Infinity;
  };
  const at = (ms: number) => {
    stop();
    if (!pageVisible()) return;
    due = Date.now() + ms;
    timer = setTimeout(run, ms);
  };
  const run = () => {
    stop();
    if (inFlight) return; // the run in progress schedules the next one
    inFlight = true;
    void fn().finally(() => {
      inFlight = false;
      if (timer === undefined) at(busy() ? busyMs : idleMs);
    });
  };
  onPageVisibility((visible) => (visible ? run() : stop()));
  run();
  return {
    wake(ms: number) {
      if (!pageVisible() || due - Date.now() <= ms) return;
      at(ms);
    },
  };
}

/** The chat in front: its "done" / "error" mark is cleared, since the user is looking at it. */
export function setActiveThread(id: string | undefined) {
  activeId = id;
  if (id && (status.get(id) === 'done' || status.get(id) === 'error')) set(id, undefined);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useThreadStatus(id: string): ThreadStatus {
  start();
  return useSyncExternalStore(subscribe, () => status.get(id));
}

/** A chat's background work right now: its programs (with CPU) and how many tool cards are still running. */
export function useBackgroundWork(id: string): { procs: RunningTask[]; tools: number } {
  start();
  useSyncExternalStore(subscribe, () => version);
  return { procs: procsByThread.get(id) ?? [], tools: liveTools.get(id)?.size ?? 0 };
}

/** How many of these chats are in each state (states with none are left out), for a project's summary. */
export function useStatusCounts(ids: string[]): Partial<Record<NonNullable<ThreadStatus>, number>> {
  start();
  useSyncExternalStore(subscribe, () => version);
  const out: Partial<Record<NonNullable<ThreadStatus>, number>> = {};
  for (const id of ids) {
    const s = status.get(id);
    if (s) out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}

const LABEL: Record<NonNullable<ThreadStatus>, string> = {
  running: 'Working',
  waiting: 'Waiting for you',
  background: 'Running in the background',
  error: 'Stopped with an error',
  done: 'Finished — not opened yet',
};
export const statusLabel = (s: ThreadStatus) => (s ? LABEL[s] : '');
