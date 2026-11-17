import { execFile } from 'node:child_process';
import { basename, extname } from 'node:path';

/**
 * Project words for the transcription prompt: identifiers that appeared in the chat recently and the project's file
 * names, so whisper spells `ChatComposer`, `useAppSync` or `package.json` the way the code does. Kept short.
 */

/** Words that look like code: CamelCase, camelCase, snake_case, kebab-case files, or names with an extension. */
const IDENT = /\b(?:[\w-]+\.(?:tsx?|jsx?|mjs|json|md|css|py|rs|go|sh|ya?ml|toml)|[A-Za-z][A-Za-z0-9]*[a-z][A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*_[a-z0-9_]+)\b/g;

/** Ranked by how often they occur (most recent text first breaks ties). */
export function extractIdentifiers(texts: string[], limit = 12): string[] {
  const count = new Map<string, number>();
  const order: string[] = [];
  for (const t of texts) {
    for (const m of t.matchAll(IDENT)) {
      const w = m[0];
      if (w.length < 4 || w.length > 40) continue;
      if (!count.has(w)) order.push(w);
      count.set(w, (count.get(w) ?? 0) + 1);
    }
  }
  return order
    .map((w, i) => ({ w, n: count.get(w)!, i }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.w);
}

/** File stems worth hinting: code-like names (CamelCase / separators), not index/main/test noise. */
export function fileStems(paths: string[], limit = 8, prefer: string[] = []): string[] {
  const noise = /^(index|main|types|utils?|test|spec|readme|license|changelog)$/i;
  const stems = new Set<string>();
  for (const p of paths) {
    const stem = basename(p, extname(p));
    if (stem.length < 4 || stem.length > 32 || noise.test(stem)) continue;
    if (/[A-Z]/.test(stem.slice(1)) || /[-_]/.test(stem)) stems.add(stem);
  }
  const lower = prefer.map((w) => w.toLowerCase());
  return [...stems]
    .sort((a, b) => Number(lower.some((w) => w.includes(b.toLowerCase()))) - Number(lower.some((w) => w.includes(a.toLowerCase()))) || a.length - b.length)
    .slice(0, limit);
}

const filesCache = new Map<string, { at: number; files: string[] }>();

/** `git ls-files` of the project (cached 60 s); empty when it isn't a git repo or takes too long. */
export function projectFiles(dir: string): Promise<string[]> {
  const hit = filesCache.get(dir);
  if (hit && Date.now() - hit.at < 60_000) return Promise.resolve(hit.files);
  return new Promise((resolve) => {
    execFile('git', ['ls-files'], { cwd: dir, timeout: 1500, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      const files = err ? [] : out.split('\n').filter(Boolean).slice(0, 20_000);
      filesCache.set(dir, { at: Date.now(), files });
      resolve(files);
    });
  });
}
