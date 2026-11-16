import { useSyncExternalStore } from 'react';

/**
 * Which projects and parent sessions the user folded in the Code-mode sidebar, kept in this browser profile so
 * the tree comes back exactly as it was left after lock/unlock (`App` swaps the whole tree for `LockScreen`, so
 * the sidebar unmounts), restart, reload, and on the phone/remote build. Anything not listed is open (the
 * default for new projects and sessions). Session folds are grouped by project, so a removed project drops all
 * of its folds at once.
 *
 * Stored shape: `{ "projects": ["<projectId>"], "threads": { "<projectId>": ["<threadId>"] } }`.
 */
const STORAGE_KEY = 'olympus.sidebarFolds.v1';
/** Cap on stored ids: folds of sessions deleted while no sidebar was watching (another device, a closed app) are never pruned. */
const MAX_IDS = 2_000;

export interface SidebarFolds {
  readonly projects: ReadonlySet<string>;
  readonly threads: ReadonlyMap<string, ReadonlySet<string>>;
}

const EMPTY: SidebarFolds = { projects: new Set(), threads: new Map() };
const listeners = new Set<() => void>();
let warnedWrite = false;

const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === 'string' && v.length > 0);

function parse(raw: string | null): SidebarFolds {
  if (!raw) return EMPTY;
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    const rec = data as Record<string, unknown>;
    const projects = new Set(isStringArray(rec.projects) ? rec.projects : []);
    const threads = new Map<string, ReadonlySet<string>>();
    if (rec.threads && typeof rec.threads === 'object' && !Array.isArray(rec.threads)) {
      for (const [pid, ids] of Object.entries(rec.threads as Record<string, unknown>)) {
        if (isStringArray(ids) && ids.length) threads.set(pid, new Set(ids));
      }
    }
    return { projects, threads };
  } catch (err) {
    console.warn(`[sidebar] Ignoring unreadable ${STORAGE_KEY}; every project and session starts open.`, err);
    return EMPTY;
  }
}

function read(): SidebarFolds {
  try {
    return parse(localStorage.getItem(STORAGE_KEY));
  } catch (err) {
    console.warn('[sidebar] localStorage is unavailable; fold state lasts only for this session.', err);
    return EMPTY;
  }
}

let folds = read();

function serialize(f: SidebarFolds): string {
  const threads: Record<string, string[]> = {};
  for (const [pid, ids] of f.threads) if (ids.size) threads[pid] = [...ids];
  return JSON.stringify({ projects: [...f.projects], threads });
}

/** Drops the oldest session folds first (then project folds) once the stored total passes `MAX_IDS`. */
function capped(f: SidebarFolds): SidebarFolds {
  let total = f.projects.size;
  for (const ids of f.threads.values()) total += ids.size;
  if (total <= MAX_IDS) return f;
  let excess = total - MAX_IDS;
  const threads = new Map<string, ReadonlySet<string>>();
  for (const [pid, ids] of f.threads) {
    const keep = [...ids].slice(Math.min(excess, ids.size));
    excess -= ids.size - keep.length;
    if (keep.length) threads.set(pid, new Set(keep));
  }
  const projects = new Set([...f.projects].slice(excess));
  return { projects, threads };
}

function commit(next: SidebarFolds) {
  folds = capped(next);
  try {
    if (!folds.projects.size && !folds.threads.size) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, serialize(folds));
  } catch (err) {
    if (!warnedWrite) console.warn('[sidebar] Could not save fold state; it lasts only for this session.', err);
    warnedWrite = true;
  }
  listeners.forEach((l) => l());
}

// Another window of the same profile (a second desktop window or browser tab) changed the folds.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY && e.key !== null) return;
    folds = read();
    listeners.forEach((l) => l());
  });
}

export const isProjectFolded = (f: SidebarFolds, projectId: string) => f.projects.has(projectId);
export const isThreadFolded = (f: SidebarFolds, projectId: string, threadId: string) => f.threads.get(projectId)?.has(threadId) ?? false;

export function setProjectOpen(projectId: string, open: boolean) {
  if (open !== folds.projects.has(projectId)) return;
  const projects = new Set(folds.projects);
  if (open) projects.delete(projectId);
  else projects.add(projectId);
  commit({ projects, threads: folds.threads });
}

export function setThreadOpen(projectId: string, threadId: string, open: boolean) {
  const cur = folds.threads.get(projectId);
  if (open !== (cur?.has(threadId) ?? false)) return;
  const ids = new Set(cur);
  if (open) ids.delete(threadId);
  else ids.add(threadId);
  const threads = new Map(folds.threads);
  if (ids.size) threads.set(projectId, ids);
  else threads.delete(projectId);
  commit({ projects: folds.projects, threads });
}

/** Opens a project and the given parent sessions in one write, so a session the user navigated to is visible. */
export function revealInSidebar(projectId: string, parentThreadIds: readonly string[]) {
  const cur = folds.threads.get(projectId);
  const foldedParents = parentThreadIds.filter((id) => cur?.has(id));
  if (!folds.projects.has(projectId) && !foldedParents.length) return;
  const projects = new Set(folds.projects);
  projects.delete(projectId);
  const threads = new Map(folds.threads);
  if (cur && foldedParents.length) {
    const ids = new Set(cur);
    for (const id of foldedParents) ids.delete(id);
    if (ids.size) threads.set(projectId, ids);
    else threads.delete(projectId);
  }
  commit({ projects, threads });
}

type ThreadLists<T> = Readonly<Record<string, readonly T[] | undefined>>;

/**
 * A pruner for one mounted sidebar: it forgets the folds of removed projects, and of sessions that were in a
 * project's list on an earlier call and are gone from it now (deleted). A session missing from a list it was never
 * seen in is kept: right after startup or unlock a project's list can hold only the sessions a `thread:meta` event
 * added before the project's own load. Nothing is pruned while the project list is empty (locked, still loading).
 */
export function createFoldPruner() {
  // Session ids of each project's list on the previous call. A list that went missing (lock, reload) is forgotten,
  // so the possibly partial list that comes back first is never compared with the older full one.
  const seen = new Map<string, ReadonlySet<string>>();
  return (projectIds: readonly string[], threadsByProject: ThreadLists<{ id: string }>) => {
    if (!projectIds.length) return;
    const live = new Set(projectIds);
    const deleted = new Map<string, Set<string>>();
    for (const pid of live) {
      const list = threadsByProject[pid];
      if (!list) {
        seen.delete(pid);
        continue;
      }
      const now = new Set(list.map((t) => t.id));
      const gone = [...(seen.get(pid) ?? [])].filter((id) => !now.has(id));
      if (gone.length) deleted.set(pid, new Set(gone));
      seen.set(pid, now);
    }
    for (const pid of seen.keys()) if (!live.has(pid)) seen.delete(pid);

    let changed = false;
    const projects = new Set([...folds.projects].filter((id) => live.has(id)));
    if (projects.size !== folds.projects.size) changed = true;
    const threads = new Map<string, ReadonlySet<string>>();
    for (const [pid, ids] of folds.threads) {
      if (!live.has(pid)) {
        changed = true;
        continue;
      }
      const gone = deleted.get(pid);
      const keep = gone ? [...ids].filter((id) => !gone.has(id)) : [...ids];
      if (keep.length !== ids.size) changed = true;
      if (keep.length) threads.set(pid, keep.length === ids.size ? ids : new Set(keep));
    }
    if (changed) commit({ projects, threads });
  };
}

/** A session that became active this soon after it was created was just started (new chat, fork) by the user. */
const FRESH_MS = 30_000;
/** Clock difference tolerated between this page and the desktop that stamps `createdAt` (phone/remote build). */
const CLOCK_SLACK_MS = 2_000;
/** A session created before this page loaded was restored (reload, restart), not just started here. */
const pageLoadedAt = Date.now();
/** Sessions already checked for a reveal. Module scope: a sidebar remount (unlock, Chat ↔ Code) must not reveal again. */
const revealChecked = new Set<string>();

/**
 * Reveals a session the user just started (new chat in a folded project, fork of a folded session) once per page,
 * and saves that open state. Restoring an older session on startup, reload or unlock never changes the saved folds.
 */
export function revealFreshThreadOnce(
  activeId: string | undefined,
  projectIds: readonly string[],
  threadsByProject: ThreadLists<{ id: string; parentId?: string; createdAt: number }>,
) {
  if (!activeId || revealChecked.has(activeId)) return;
  for (const pid of projectIds) {
    const list = threadsByProject[pid];
    const t = list?.find((x) => x.id === activeId);
    if (!list || !t) continue;
    revealChecked.add(activeId);
    if (t.createdAt < pageLoadedAt - CLOCK_SLACK_MS || Math.abs(Date.now() - t.createdAt) > FRESH_MS) return;
    const parents: string[] = [];
    for (let id = t.parentId; id && !parents.includes(id); id = list.find((x) => x.id === id)?.parentId) parents.push(id);
    revealInSidebar(pid, parents);
    return;
  }
}

/** The current folds; a new object on every change, so components re-render only when something was folded or opened. */
export const useSidebarFolds = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => folds,
  );
