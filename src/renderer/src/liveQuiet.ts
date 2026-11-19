import { useRef } from 'react';
import type { ThreadItem } from '@shared/types';

/**
 * How long the agent has sent nothing new, for the chat's live lines (`WorkingIndicator`, the live `WorkGroup`
 * header). Without it they name the newest step's kind ("Writing the reply…") long after that step stopped:
 * Antigravity sends a tool call only once its arguments are fully written, so writing a big file can leave a
 * finished reply under "Writing the reply…" for a minute while nothing is on its way to the screen.
 */

/** A reply or step that has not changed for this long is no longer "being written". */
export const QUIET_AFTER_MS = 4_000;
/** From this long without anything new, the live line says how long it has been quiet. */
export const SHOW_QUIET_AFTER_MS = 20_000;

/** Changes whenever the agent sends something new for this step: more text, a new status, more output. */
export function stepSignature(item: ThreadItem | undefined): string {
  if (!item) return '';
  if (item.kind === 'agent' || item.kind === 'thought') return `${item.id}:${item.text.length}`;
  if (item.kind === 'tool') {
    let size = item.terminalText?.length ?? 0;
    for (const c of item.content) size += (c.text?.length ?? 0) + (c.newText?.length ?? 0);
    return `${item.id}:${item.status}:${item.content.length}:${size}`;
  }
  if (item.kind === 'plan') return `${item.id}:${item.entries.map((e) => `${e.status}|${e.content.length}`).join(',')}`;
  return item.id;
}

/**
 * Milliseconds since `signature` last changed, as of `now`. The first look starts the clock at `since` when
 * given (a finished tool's `endedAt`), else at first sight — opening a chat mid-silence starts it then.
 */
export function useQuietMs(signature: string, now: number, since?: number): number {
  const seen = useRef<{ sig: string; at: number } | null>(null);
  if (seen.current?.sig !== signature) {
    const at = Date.now();
    seen.current = { sig: signature, at: seen.current ? at : Math.min(at, since ?? at) };
  }
  return Math.max(0, now - seen.current.at);
}

/** `quiet 45s` once it has been quiet long enough to mention, else ''. */
export function quietLabel(quietMs: number): string {
  return quietMs >= SHOW_QUIET_AFTER_MS ? `quiet ${Math.round(quietMs / 1000)}s` : '';
}

/** Hover text for a long quiet gap: the agent is still working, and nothing is hidden. */
export function quietTip(agentName: string, quietMs: number): string | undefined {
  if (quietMs < SHOW_QUIET_AFTER_MS) return undefined;
  return `${agentName} has sent nothing new for ${Math.round(quietMs / 1000)}s. It is still working: some agents send a step only once it is fully written (a large file can take a minute), so it may appear all at once.`;
}
