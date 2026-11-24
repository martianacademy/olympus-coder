/**
 * Pure `@` file/attachment mention detection, ranking, and token formatting for Olympus Coder's
 * composer (`ChatComposer` & `ChatHome`). Zero React/Electron imports so main, renderer, and unit
 * tests share identical behavior.
 *
 * Ordering guarantee: files currently attached/uploaded in the composer ALWAYS rank ahead of
 * project repository files so users can reference uploaded screenshots, PDFs, or notes first.
 */
import type { AttachmentView, FileEntry } from './types';

export interface MentionMatch {
  /** Index of `@` in the draft string. */
  start: number;
  /** Caret end index of the `@query` token. */
  end: number;
  /** Characters typed after `@` (without `@`). */
  query: string;
}

export interface MentionItem {
  id: string;
  kind: 'attachment' | 'file';
  /** Primary display name (clean filename for attachments, basename for project files). */
  label: string;
  /** Secondary context (e.g. parent folder path for project files, or note/size for attachments). */
  detail?: string;
  /** Value inserted after `@` (filename for attachments, project-relative POSIX path for repo files). */
  target: string;
  /** Full absolute or project-relative path for deduplication. */
  path: string;
  mime?: string;
  preview?: string;
}

/** Allowed characters immediately before `@` (prevents triggering inside email addresses like `a@b.com`). */
const BEFORE_AT = /[\s(\[{"',:;/]/;

/**
 * Finds an active `@query` mention token ending at `caret`, or returns null when caret is not
 * inside a valid mention trigger (e.g. inside an email address or after a space).
 */
export function detectMention(text: string, caret: number): MentionMatch | null {
  if (caret <= 0 || caret > text.length) return null;
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === '@') {
      if (i > 0 && !BEFORE_AT.test(text[i - 1])) return null;
      return { start: i, end: caret, query: text.slice(i + 1, caret) };
    }
    if (/[\s]/.test(ch)) return null;
    i--;
  }
  return null;
}

/** Formats the inserted mention string with trailing space, quoting names that contain whitespace. */
export function formatMentionInsert(target: string): string {
  return /\s/.test(target) ? `@"${target}" ` : `@${target} `;
}

function scoreText(label: string, fullPath: string, q: string): number {
  if (!q) return 1;
  const lowName = label.toLowerCase();
  const lowPath = fullPath.toLowerCase();
  if (lowName === q) return 100;
  if (lowName.startsWith(q)) return 82;
  if (lowName.split(/[-_.\s/]/).some((w) => w.startsWith(q))) return 66;
  if (lowPath.startsWith(q)) return 56;
  if (lowName.includes(q)) return 46;
  if (lowPath.includes(q)) return 32;
  // Subsequence fuzzy match on path
  let k = 0;
  for (const ch of lowPath) if (ch === q[k]) k++;
  return k === q.length ? 16 : 0;
}

function parentFolder(relPath: string): string | undefined {
  const idx = relPath.lastIndexOf('/');
  return idx > 0 ? relPath.slice(0, idx) : undefined;
}

/**
 * Ranks composer attachments FIRST and project files SECOND for a typed `@query`.
 * Empty query returns every attached file at the top followed by project files up to `limit`.
 */
export function rankMentions(
  attachments: readonly AttachmentView[],
  projectFiles: readonly FileEntry[],
  query: string,
  limit = 40,
): MentionItem[] {
  const q = query.trim().toLowerCase();
  const seenPaths = new Set<string>();

  const attScored = attachments
    .map((a, i) => {
      seenPaths.add(a.path);
      const s = scoreText(a.name, a.name, q);
      const item: MentionItem = {
        id: `att:${a.path}:${i}`,
        kind: 'attachment',
        label: a.name,
        detail: a.note ? a.note : a.mime?.startsWith('image/') ? 'Attached image' : 'Attached file',
        target: a.name,
        path: a.path,
        mime: a.mime,
        preview: a.preview,
      };
      return { item, s, i };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);

  const fileScored = projectFiles
    .filter((f) => !f.dir && !seenPaths.has(f.path))
    .map((f, i) => {
      const s = scoreText(f.name, f.path, q);
      const item: MentionItem = {
        id: `file:${f.path}`,
        kind: 'file',
        label: f.name,
        detail: parentFolder(f.path),
        target: f.path,
        path: f.path,
      };
      return { item, s, i };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.item.path.split('/').length - b.item.path.split('/').length || a.i - b.i)
    .map((x) => x.item);

  const remaining = Math.max(0, limit - attScored.length);
  return [...attScored, ...fileScored.slice(0, remaining)];
}
