import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What a new install under a running Olympus changed, so the update banner asks for no more than needed:
 * - the main process or preload code changed → only a restart runs it (running agents and terminals stop);
 * - only the window code changed → reloading the window is enough, and everything keeps running (agents and
 *   terminals live in the main process).
 *
 * Every build rewrites the files, so their mtime says nothing; the content does. Hashes are cached per
 * file by mtime + size, so a check that finds nothing new reads nothing.
 */

const cache = new Map<string, { key: string; digest: string }>();

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** One hash over the contents of every file in these folders (order-independent of the file system). */
export function codeHash(dirs: string[]): string {
  const h = createHash('sha1');
  for (const f of dirs.flatMap(filesUnder).sort()) {
    let st;
    try {
      st = statSync(f);
    } catch {
      continue; // removed while listing (an install in progress)
    }
    const key = `${st.mtimeMs}:${st.size}`;
    let hit = cache.get(f);
    if (hit?.key !== key) {
      hit = { key, digest: createHash('sha1').update(readFileSync(f)).digest('hex') };
      cache.set(f, hit);
    }
    h.update(`${f}\0${hit.digest}\n`);
  }
  return h.digest('hex');
}

/** Each page's entry script on disk: `{ 'index.html': 'index-D2gIn503.js', 'remote.html': 'remote-….js' }`. */
export function pageEntries(rendererDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(rendererDir)) return out;
  for (const name of readdirSync(rendererDir)) {
    if (!name.endsWith('.html')) continue;
    try {
      const html = readFileSync(join(rendererDir, name), 'utf8');
      const m = /<script\b[^>]*type="module"[^>]*\bsrc="[^"]*?([^"/]+\.js)"/.exec(html) ?? /<script\b[^>]*\bsrc="[^"]*?([^"/]+\.js)"[^>]*type="module"/.exec(html);
      if (m) out[name] = m[1];
    } catch {
      /* being replaced */
    }
  }
  return out;
}

export interface BuildInfo {
  /** The main process or preload code on disk differs from the one running: a restart is needed. */
  updated: boolean;
  /** The entry script of each page on disk, for a window to compare with its own (a reload is enough). */
  entries: Record<string, string>;
}

/**
 * `mainDir` is the folder of the running main bundle (`out/main`); preload and renderer sit next to it. The
 * running code's hash is taken now, at startup, before any later install can change the files.
 */
export function createBuildInfo(mainDir: string): () => BuildInfo {
  const code = [mainDir, join(mainDir, '..', 'preload')];
  const renderer = join(mainDir, '..', 'renderer');
  const running = codeHash(code);
  return () => ({ updated: codeHash(code) !== running, entries: pageEntries(renderer) });
}
