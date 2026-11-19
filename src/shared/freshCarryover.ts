import type { Thread, ThreadItem } from './types';

/**
 * Pure, zero-LLM-cost Fresh Context Carryover builder (`src/shared/freshCarryover.ts`).
 *
 * When a chat's context window gets bloated across any of the 18+ ACP agents (Claude Code, Codex,
 * Antigravity, Gemini CLI, Qwen Code, OpenCode, `oly`, etc.), `resetContext` closes the bloated
 * ACP session and starts a fresh `session/new` in the exact same chat thread while keeping 100%
 * of visible messages and shadow-git Undo checkpoints intact.
 *
 * This module builds the tight (~2k-4k token) carryover brief sent once with the next message:
 * original goal, modified files list (with +/- counts), compact recent exchanges (zero raw
 * `read_file` or terminal dumps), and the full transcript JSON path for on-demand grep.
 */

export const CACHE_COLD_AFTER_MS = 5 * 60_000;
export const DEFAULT_CARRYOVER_TRANSCRIPT_CHARS = 9_000;

export interface CarryoverEditedFile {
  path: string;
  added?: number;
  removed?: number;
}

export interface CarryoverMeta {
  originalGoal: string;
  editedFiles: CarryoverEditedFile[];
  estimatedTokens: number;
}

/** True if the thread has at least one real user or agent turn worth carrying over. */
export function threadHasConversation(items: ThreadItem[]): boolean {
  return items.some((i) => i.kind === 'user' || i.kind === 'agent');
}

/** Epoch ms of the most recent user/agent message in the thread (used to detect cold >5m caches). */
export function lastTurnTimestamp(items: ThreadItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'user' || it.kind === 'agent') return it.ts;
  }
  return 0;
}

/**
 * True when the thread ends with a `context-reset` divider (ignoring trailing notices/errors)
 * so the very next prompt's preamble should use the compact Fresh Context Carryover brief.
 */
export function isFreshCarryoverPending(items: ThreadItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const k = items[i].kind;
    if (k === 'context-reset') return true;
    if (k === 'user' || k === 'agent' || k === 'switch') return false;
  }
  return false;
}

/** Extract unique modified files from edit/write tool calls across the thread. */
export function collectEditedFiles(items: ThreadItem[]): CarryoverEditedFile[] {
  const byPath = new Map<string, CarryoverEditedFile>();
  for (const it of items) {
    if (it.kind !== 'tool' || it.status === 'failed') continue;
    const isEdit =
      it.toolKind === 'edit' ||
      /^(?:edit|write|create|modify|patch|update)\b/i.test(it.title.trim());
    if (!isEdit) continue;
    const paths = it.locations?.length ? it.locations : [];
    for (const raw of paths) {
      const clean = raw.trim();
      if (!clean) continue;
      if (!byPath.has(clean)) byPath.set(clean, { path: clean });
    }
  }
  return [...byPath.values()].slice(0, 30);
}

/** Compute original goal, edited files, and estimated token size of the carryover brief. */
export function extractCarryoverMeta(
  thread: Pick<Thread, 'items'>,
  compactTranscriptText: string,
): CarryoverMeta {
  const firstUser = thread.items.find((i): i is Extract<ThreadItem, { kind: 'user' }> => i.kind === 'user' && Boolean(i.text.trim()));
  const rawGoal = firstUser?.text.replace(/\s+/g, ' ').trim() ?? '';
  const originalGoal = rawGoal.length > 700 ? `${rawGoal.slice(0, 700)}…` : rawGoal;
  const editedFiles = collectEditedFiles(thread.items);

  // Conservative chars/3.5 token estimate including framing + edited file list + compact recent transcript.
  const filesChars = editedFiles.reduce((s, f) => s + f.path.length + 6, 0);
  const totalChars = 550 + originalGoal.length + filesChars + Math.min(compactTranscriptText.length, DEFAULT_CARRYOVER_TRANSCRIPT_CHARS);
  return {
    originalGoal,
    editedFiles,
    estimatedTokens: Math.max(200, Math.ceil(totalChars / 3.5)),
  };
}

/** Format the compact Fresh Context Carryover markdown section injected into `buildPreamble`. */
export function buildFreshCarryoverSection(opts: {
  thread: Pick<Thread, 'id' | 'items'>;
  compactTranscript: string;
  transcriptPath: string;
  previousUsed?: number;
}): string {
  const meta = extractCarryoverMeta(opts.thread, opts.compactTranscript);
  const parts: string[] = [];
  const savings =
    opts.previousUsed && opts.previousUsed > 0
      ? ` (previous session had ~${opts.previousUsed.toLocaleString()} tokens; this brief is ~${meta.estimatedTokens.toLocaleString()} tokens)`
      : '';
  parts.push(
    `## Fresh context carryover (clean session in the same chat)${savings}\n\n` +
      `The user started a fresh context session to drop old raw file reads and terminal logs while staying in the same chat. ` +
      `All earlier messages and Undo checkpoints remain intact in the full transcript at \`${opts.transcriptPath}\` — grep or read specific files on demand only if needed.`,
  );
  if (meta.originalGoal) {
    parts.push(`### Original goal\n${meta.originalGoal}`);
  }
  if (meta.editedFiles.length) {
    parts.push(
      `### Files modified earlier in this chat\n${meta.editedFiles.map((f) => `- \`${f.path}\``).join('\n')}`,
    );
  }
  if (opts.compactTranscript.trim()) {
    parts.push(
      `### Recent conversation (raw tool outputs omitted — re-read any file on demand)\n\n${opts.compactTranscript.trim()}`,
    );
  }
  return parts.join('\n\n');
}
