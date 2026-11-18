import { createHash } from 'node:crypto';
import { readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

/**
 * Tells the app when `<sharedRoot>/projects.json` changed, whoever wrote it: the app itself (`notify()` right after
 * its own write), or an agent / script / other process (a watcher on the shared-root DIRECTORY, because an atomic
 * replace swaps the file's inode and a watch on the file itself would go deaf). Every path compares a hash of the
 * file's content with the last announced one, so the app's own write is announced once (the watcher's later event
 * sees the same content) and an unchanged rewrite is never announced. Half-written or unreadable content is
 * skipped; the next write event brings the real one.
 */

export interface ProjectsWatcher {
  /** Call after the app wrote projects.json: announces now if the content changed. */
  notify(): void;
  /** The shared root may have moved (settings): watch the new folder, and announce if its list differs. */
  rearm(): void;
  close(): void;
}

export interface ProjectsWatchOptions {
  dir: () => string;
  onChange: () => void;
  file?: string;
  debounceMs?: number;
}

const hashOf = (s: string) => createHash('sha1').update(s).digest('hex');

export function watchProjectsFile(opts: ProjectsWatchOptions): ProjectsWatcher {
  const name = opts.file ?? 'projects.json';
  const debounceMs = opts.debounceMs ?? 200;
  let dir = '';
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastHash: string | null = null;

  /** Hash of a readable JSON array in the file; null when missing, half-written or not a list. */
  const current = (): string | null => {
    try {
      const raw = readFileSync(join(dir, name), 'utf8');
      return Array.isArray(JSON.parse(raw)) ? hashOf(raw) : null;
    } catch {
      return null;
    }
  };

  const check = () => {
    const h = current();
    if (h === null || h === lastHash) return;
    lastHash = h;
    opts.onChange();
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      check();
    }, debounceMs);
    timer.unref?.();
  };

  const arm = () => {
    watcher?.close();
    watcher = null;
    dir = opts.dir();
    try {
      watcher = watch(dir, { persistent: false }, (_event, file) => {
        // Some platforms omit the name; then check anyway (the hash keeps it quiet when nothing changed).
        if (!file || String(file) === name) schedule();
      });
      watcher.on('error', (e) => {
        console.warn(`[projects] watcher on ${dir} stopped: ${e.message}`);
        watcher?.close();
        watcher = null;
      });
    } catch (e: any) {
      console.warn(`[projects] cannot watch ${dir}: ${e?.message ?? e}`);
    }
  };

  arm();
  lastHash = current();

  return {
    notify: check,
    rearm() {
      if (opts.dir() === dir && watcher) return;
      arm();
      check();
    },
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
      watcher?.close();
      watcher = null;
    },
  };
}
