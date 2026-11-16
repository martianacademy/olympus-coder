import { realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type { EditorBufferReport } from '@shared/acpClient';

/**
 * Unsaved editor text, as the windows report it, so `fs/read_text_file` gives an agent what the user sees
 * and `fs/write_text_file` can tell when it would clash with unsaved edits.
 *
 * Each window (the desktop one, a phone) reports the full list of its unsaved files for a project whenever
 * it changes, and again every ~20 s while there are any. A report replaces that window's previous list for the
 * project; a window that stops reporting (closed phone tab) is forgotten after {@link STALE_MS}.
 */

const STALE_MS = 90_000;
const MAX_BUFFER_CHARS = 10 * 1024 * 1024;

interface Entry {
  text: string;
  at: number;
}

/** `client \0 project root` → (absolute real path → unsaved text). */
const reports = new Map<string, Map<string, Entry>>();

/** Paths are compared case-insensitively where the file system usually is (Windows, macOS). */
const keyOf = (p: string) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);

function realRoot(root: string): string {
  try {
    return realpathSync.native(root);
  } catch {
    return resolve(root);
  }
}

/**
 * Replaces what window `clientId` reported for the project at `projectRoot` with `list` (an empty list:
 * nothing unsaved). Entries with paths outside the project are ignored.
 */
export function reportEditorBuffers(clientId: string, projectRoot: string, list: EditorBufferReport[], now = Date.now()): void {
  if (!clientId || !projectRoot || !isAbsolute(projectRoot)) return;
  const root = realRoot(projectRoot);
  const id = `${clientId}\0${keyOf(root)}`;
  if (!Array.isArray(list) || list.length === 0) {
    reports.delete(id);
    return;
  }
  const map = new Map<string, Entry>();
  for (const b of list) {
    if (!b || typeof b.path !== 'string' || typeof b.text !== 'string' || b.text.length > MAX_BUFFER_CHARS) continue;
    if (!b.path || isAbsolute(b.path) || b.path.includes('\0')) continue;
    const full = normalize(join(root, b.path));
    if (!full.startsWith(root.endsWith(sep) ? root : root + sep)) continue;
    // Looked up by real path (what the fs handlers resolve to), so a file reached through a symlink still matches.
    let real = full;
    try {
      real = realpathSync.native(full);
    } catch {
      /* a new, never-saved file */
    }
    map.set(keyOf(real), { text: b.text, at: now });
  }
  if (map.size) reports.set(id, map);
  else reports.delete(id);
}

/** The newest unsaved editor text for the file at absolute real path `realPath`, if any window has one. */
export function unsavedEditorText(realPath: string, now = Date.now()): string | undefined {
  const k = keyOf(realPath);
  let best: Entry | undefined;
  for (const [id, map] of reports) {
    const e = map.get(k);
    if (!e) continue;
    if (now - e.at > STALE_MS) {
      map.delete(k);
      if (!map.size) reports.delete(id);
      continue;
    }
    if (!best || e.at > best.at) best = e;
  }
  return best?.text;
}

/** Forgets everything one window reported (it closed or reloaded). */
export function forgetEditorClient(clientId: string): void {
  for (const id of [...reports.keys()]) if (id.startsWith(`${clientId}\0`)) reports.delete(id);
}

/** Test helper: forget every report. */
export function clearEditorBuffers(): void {
  reports.clear();
}
