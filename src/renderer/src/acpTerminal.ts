import { useCallback, useSyncExternalStore } from 'react';
import type { AcpTerminalEvent, AcpTerminalSnapshot } from '@shared/acpClient';
import { onEvent } from './api';

/**
 * Live output of agent terminals (`acp:terminal` events) for the tool boxes in the chat.
 *
 * A box asks for a terminal by key: the first one fetches a snapshot, then appends arrive as events. Each
 * append carries `end` (total characters written so far), so an append the snapshot already holds is
 * skipped and a gap (missed events) triggers a fresh snapshot. Nothing is kept once no box shows a terminal.
 */

/** Same cap as the main process keeps per terminal. */
const KEEP_CHARS = 512 * 1024;

interface Live {
  snap: AcpTerminalSnapshot | null;
  /** Appends that arrived while the snapshot was loading. */
  queued: AcpTerminalEvent[];
  loading: boolean;
  listeners: Set<() => void>;
}

const live = new Map<string, Live>();
let unsubscribe: (() => void) | null = null;

const notify = (l: Live) => {
  for (const fn of l.listeners) fn();
};

/**
 * State only moves forward (running → ended, then released), so a state event that arrives out of order
 * (phone link: events and requests travel separately) never undoes a newer one.
 */
function applyMeta(l: Live, m: NonNullable<AcpTerminalEvent['meta']>) {
  const s = l.snap;
  if (!s) return;
  l.snap = {
    ...s,
    command: s.command ?? m.command,
    cwd: s.cwd ?? m.cwd,
    running: s.running && m.running,
    released: s.released || m.released,
    exitStatus: s.exitStatus ?? m.exitStatus,
    endedAt: s.endedAt ?? m.endedAt,
    clipped: s.clipped || m.clipped,
  };
}

function applyAppend(l: Live, e: AcpTerminalEvent): 'ok' | 'gap' {
  const s = l.snap;
  if (!s || e.append === undefined || e.end === undefined) return 'ok';
  if (e.end <= s.end) return 'ok';
  const start = e.end - e.append.length;
  if (start > s.end) return 'gap';
  let output = s.output + e.append.slice(s.end - start);
  let clipped = s.clipped;
  if (output.length > KEEP_CHARS * 1.25) {
    output = output.slice(output.length - KEEP_CHARS);
    clipped = true;
  }
  l.snap = { ...s, output, clipped, end: e.end };
  return 'ok';
}

function load(key: string, l: Live) {
  if (l.loading) return;
  l.loading = true;
  void window.desk
    .invoke('acpTerminal.snapshot', key)
    .then((snap: AcpTerminalSnapshot | null) => {
      l.loading = false;
      l.snap = snap;
      const queued = l.queued;
      l.queued = [];
      for (const e of queued) if (e.meta) applyMeta(l, e.meta);
      if (snap && queued.some((e) => applyAppend(l, e) === 'gap')) return load(key, l);
      notify(l);
    })
    .catch(() => {
      l.loading = false;
    });
}

function ensureSubscribed() {
  if (unsubscribe) return;
  unsubscribe = onEvent((channel, payload: AcpTerminalEvent) => {
    if (channel !== 'acp:terminal') return;
    const l = live.get(payload.key);
    if (!l) return;
    if (l.loading) {
      l.queued.push(payload);
      return;
    }
    if (!l.snap) return load(payload.key, l);
    if (payload.meta) applyMeta(l, payload.meta);
    if (payload.append !== undefined && applyAppend(l, payload) === 'gap') return load(payload.key, l);
    notify(l);
  });
}

function subscribe(key: string, fn: () => void): () => void {
  ensureSubscribed();
  let l = live.get(key);
  if (!l) {
    l = { snap: null, queued: [], loading: false, listeners: new Set() };
    live.set(key, l);
    load(key, l);
  }
  l.listeners.add(fn);
  return () => {
    l!.listeners.delete(fn);
    if (!l!.listeners.size) live.delete(key);
  };
}

/** The live terminal behind a tool box, or null while loading / when the app no longer has it (after a restart). */
export function useAcpTerminal(key: string | undefined): AcpTerminalSnapshot | null {
  const sub = useCallback((fn: () => void) => (key ? subscribe(key, fn) : () => {}), [key]);
  const get = useCallback(() => (key ? (live.get(key)?.snap ?? null) : null), [key]);
  return useSyncExternalStore(sub, get, get);
}

/** Stops a command Olympus runs for an agent (Stop on the box). */
export const stopAcpTerminal = (key: string) => window.desk.invoke('acpTerminal.stop', key) as Promise<boolean>;
