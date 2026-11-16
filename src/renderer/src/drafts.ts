import { useCallback, useSyncExternalStore } from 'react';
import type { AttachmentView } from '@shared/types';

export interface ComposerDraft {
  text: string;
  files: AttachmentView[];
  updatedAt: number;
}

const STORAGE_KEY = 'olympus.drafts.v1';
const MAX_DRAFTS = 60;
const SAVE_DEBOUNCE_MS = 250;

/** Draft key used by Chat mode's `ChatHome` ("New chat") composer before a thread exists. */
export const HOME_DRAFT_KEY = '__home__';

const EMPTY_FILES: AttachmentView[] = [];
const EMPTY_DRAFT: ComposerDraft = Object.freeze({ text: '', files: EMPTY_FILES, updatedAt: 0 });

const drafts = new Map<string, ComposerDraft>();
const keyListeners = new Map<string, Set<() => void>>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function isValidFile(x: unknown): x is AttachmentView {
  if (!x || typeof x !== 'object') return false;
  const f = x as Record<string, unknown>;
  return typeof f.path === 'string' && f.path.length > 0 && typeof f.name === 'string' && typeof f.mime === 'string' && typeof f.size === 'number';
}

function loadInitialDrafts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return;
    const entries: [string, ComposerDraft][] = [];
    for (const [k, v] of Object.entries(parsed)) {
      if (!v || typeof v !== 'object') continue;
      const rec = v as Record<string, unknown>;
      const text = typeof rec.text === 'string' ? rec.text : '';
      const files = Array.isArray(rec.files) ? rec.files.filter(isValidFile) : EMPTY_FILES;
      const updatedAt = typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0;
      if (!text && files.length === 0) continue;
      entries.push([k, { text, files, updatedAt }]);
    }
    entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [k, d] of entries.slice(-MAX_DRAFTS)) {
      drafts.set(k, d);
    }
  } catch {
    /* corrupted or unavailable storage: start clean in memory */
  }
}

loadInitialDrafts();

function notifyKey(key: string) {
  keyListeners.get(key)?.forEach((fn) => fn());
}

/** Writes all non-empty drafts to `localStorage` immediately, stripping image preview thumbnails only if quota is exceeded. */
export function flushDraftsNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    if (drafts.size === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const full: Record<string, ComposerDraft> = {};
    for (const [k, d] of drafts) {
      if (d.text || d.files.length > 0) full[k] = d;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(full));
    } catch {
      const slim: Record<string, ComposerDraft> = {};
      for (const [k, d] of Object.entries(full)) {
        slim[k] = {
          text: d.text,
          files: d.files.map(({ preview: _preview, ...rest }) => rest),
          updatedAt: d.updatedAt,
        };
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
    }
  } catch {
    /* private mode or storage locked: in-memory drafts still work for the session */
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(flushDraftsNow, SAVE_DEBOUNCE_MS);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushDraftsNow);
  window.addEventListener('beforeunload', flushDraftsNow);
}

function writeDraft(key: string, text: string, files: AttachmentView[]) {
  if (!text && files.length === 0) {
    if (!drafts.has(key)) return;
    drafts.delete(key);
    notifyKey(key);
    scheduleSave();
    return;
  }
  if (!drafts.has(key) && drafts.size >= MAX_DRAFTS) {
    let oldestKey: string | undefined;
    let oldestTs = Infinity;
    for (const [k, d] of drafts) {
      if (d.updatedAt < oldestTs) {
        oldestTs = d.updatedAt;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) {
      drafts.delete(oldestKey);
      notifyKey(oldestKey);
    }
  }
  drafts.set(key, { text, files: files.length ? files : EMPTY_FILES, updatedAt: Date.now() });
  notifyKey(key);
  scheduleSave();
}

export function getDraft(key: string): ComposerDraft {
  return drafts.get(key) ?? EMPTY_DRAFT;
}

export function setDraftText(key: string, next: string | ((prev: string) => string)) {
  const cur = getDraft(key);
  const text = typeof next === 'function' ? next(cur.text) : next;
  if (text === cur.text) return;
  writeDraft(key, text, cur.files);
}

export function addDraftFiles(key: string, list: AttachmentView[]) {
  if (!list.length) return;
  const cur = getDraft(key);
  const fresh = list.filter((a) => !cur.files.some((c) => c.path === a.path));
  if (!fresh.length) return;
  writeDraft(key, cur.text, [...cur.files, ...fresh]);
}

export function removeDraftFile(key: string, path: string) {
  const cur = getDraft(key);
  const next = cur.files.filter((a) => a.path !== path);
  if (next.length === cur.files.length) return;
  writeDraft(key, cur.text, next);
}

export function updateDraftFilePreview(key: string, path: string, preview: string) {
  const cur = drafts.get(key);
  if (!cur) return;
  let changed = false;
  const files = cur.files.map((f) => {
    if (f.path === path && f.preview !== preview) {
      changed = true;
      return { ...f, preview };
    }
    return f;
  });
  if (!changed) return;
  drafts.set(key, { ...cur, files });
  notifyKey(key);
}

/** Clears both prompt text and attached files for `key` and flushes storage immediately. */
export function clearDraft(key: string) {
  if (!drafts.has(key)) return;
  drafts.delete(key);
  notifyKey(key);
  flushDraftsNow();
}

/**
 * Subscribes a composer (`ChatComposer` for `threadId`, or `ChatHome` for `HOME_DRAFT_KEY`) to its own draft.
 * Keyed per-thread listeners ensure typing in one chat never re-renders any other component.
 */
export function useDraft(key: string) {
  const draft = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        let set = keyListeners.get(key);
        if (!set) {
          set = new Set();
          keyListeners.set(key, set);
        }
        set.add(listener);
        return () => {
          const cur = keyListeners.get(key);
          if (!cur) return;
          cur.delete(listener);
          if (cur.size === 0) keyListeners.delete(key);
        };
      },
      [key],
    ),
    () => getDraft(key),
  );

  const setText = useCallback((next: string | ((prev: string) => string)) => setDraftText(key, next), [key]);
  const clear = useCallback(() => clearDraft(key), [key]);

  return { text: draft.text, files: draft.files, setText, clear };
}
