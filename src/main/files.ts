import { shell } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { FileContent, FileEntry } from '@shared/types';
import { getProject } from './store';

/**
 * File explorer and editor backend. Every path must stay inside the project folder, so a bug or a crafted
 * path in the renderer can't read or write elsewhere on the disk.
 */

const MAX_EDIT_BYTES = 2 * 1024 * 1024;
/** Hidden by default in the tree; still reachable by path. */
const HIDDEN = new Set(['.git', '.DS_Store']);

function root(projectId: string): string {
  const p = getProject(projectId);
  if (!p) throw new Error('Project not found.');
  return realpathSync(p.path);
}

/** Resolve `rel` inside the project and refuse anything that escapes it (`..`, absolute paths, symlinks out). */
export function inside(projectId: string, rel: string): string {
  const base = root(projectId);
  const full = resolve(base, rel || '.');
  // A path that doesn't exist yet (new file, new folders) is checked through its nearest existing ancestor, so a
  // symlinked folder pointing outside the project can't be used as a way out (`link/a/b/new.txt`).
  let existing = full;
  let rest = '';
  let real: string | undefined;
  for (;;) {
    try {
      real = join(realpathSync(existing), rest);
      break;
    } catch {
      const up = dirname(existing);
      if (up === existing) break;
      rest = rest ? join(basename(existing), rest) : basename(existing);
      existing = up;
    }
  }
  if (!real) throw new Error('This path is outside the project folder.');
  if (real !== base && !real.startsWith(base + sep)) throw new Error('This path is outside the project folder.');
  return full;
}

const relOf = (projectId: string, full: string) => relative(root(projectId), full).split(sep).join('/');

export function listDir(projectId: string, rel: string): FileEntry[] {
  const dir = inside(projectId, rel);
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => !HIDDEN.has(d.name))
    .map((d) => {
      const full = join(dir, d.name);
      let isDir = d.isDirectory();
      let size: number | undefined;
      try {
        const st = statSync(full);
        isDir = st.isDirectory();
        size = isDir ? undefined : st.size;
      } catch {
        /* broken symlink */
      }
      return { name: d.name, path: relOf(projectId, full), dir: isDir, size };
    })
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.dir ? -1 : 1));
}

export function readFile(projectId: string, rel: string): FileContent {
  const full = inside(projectId, rel);
  const st = statSync(full);
  const base = { path: rel, size: st.size, mtime: st.mtimeMs };
  if (st.size > MAX_EDIT_BYTES) return { ...base, text: '', binary: false, tooLarge: true };
  const buf = readFileSync(full);
  // A NUL byte in the first 8 KB means binary (same rule git uses).
  if (buf.subarray(0, 8192).includes(0)) return { ...base, text: '', binary: true, tooLarge: false };
  return { ...base, text: buf.toString('utf8'), binary: false, tooLarge: false };
}

/** Saves the file. `expectedMtime` guards against overwriting a change an agent made since the file was opened. */
export function writeFile(projectId: string, rel: string, text: string, expectedMtime?: number): { mtime: number; conflict?: boolean } {
  const full = inside(projectId, rel);
  if (expectedMtime && existsSync(full)) {
    const now = statSync(full).mtimeMs;
    if (Math.abs(now - expectedMtime) > 1) return { mtime: now, conflict: true };
  }
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text, 'utf8');
  return { mtime: statSync(full).mtimeMs };
}

export function createEntry(projectId: string, rel: string, dir: boolean): FileEntry {
  const full = inside(projectId, rel);
  if (existsSync(full)) throw new Error('A file or folder with this name already exists.');
  if (dir) mkdirSync(full, { recursive: true });
  else {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, '');
  }
  return { name: full.split(sep).pop()!, path: relOf(projectId, full), dir };
}

export function renameEntry(projectId: string, from: string, to: string): void {
  const a = inside(projectId, from);
  const b = inside(projectId, to);
  if (existsSync(b)) throw new Error('A file or folder with this name already exists.');
  renameSync(a, b);
}

/** Moves to the macOS Trash (recoverable), never a permanent delete. */
export async function trashEntry(projectId: string, rel: string): Promise<void> {
  const full = inside(projectId, rel);
  if (full === root(projectId)) throw new Error('The project folder itself cannot be deleted.');
  await shell.trashItem(full);
}

export function revealEntry(projectId: string, rel: string): void {
  shell.showItemInFolder(inside(projectId, rel));
}
