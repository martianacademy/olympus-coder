import type { ThreadItem } from './types';

/**
 * Where a new chat item goes. Used by the main process (the saved thread) and by every screen that adds live
 * `thread:item` events to a chat (desktop, phone, Tasks panel), so they all show the same order.
 *
 * An Olympus Coder confirm card (`confirmInThread`, e.g. for `add_agent`) is created when the agent's MCP tool call
 * reaches the app over HTTP. The text and steps the agent streamed just before that call come over the agent's ACP
 * connection, a different channel, and can arrive later (seen with Claude Code in bypass mode; the adapter's stdout
 * lags the CLI's direct HTTP call). While such a card waits, the agent is blocked on that tool call, so anything it
 * streams meanwhile was produced before the card: those items go above the waiting card, which stays last.
 */

/** An Olympus Coder confirm card that still waits for the user. */
export const isPendingConfirm = (it: ThreadItem | undefined): boolean => it?.kind === 'elicitation' && Boolean(it.confirm) && !it.resolved;

/** What the agent streams during a turn (ACP session updates). User messages, errors and other cards are not moved. */
const AGENT_STREAM = new Set<ThreadItem['kind']>(['agent', 'thought', 'tool', 'plan', 'plan-doc']);

/** Index of the first of the pending confirm cards at the end of the chat (`items.length` when there are none). */
export function pendingConfirmStart(items: readonly ThreadItem[]): number {
  let i = items.length;
  while (i > 0 && isPendingConfirm(items[i - 1])) i--;
  return i;
}

/** Where `item` (not in the chat yet) is inserted. */
export function insertIndex(items: readonly ThreadItem[], item: ThreadItem): number {
  return AGENT_STREAM.has(item.kind) ? pendingConfirmStart(items) : items.length;
}

/** The newest item the agent's stream can continue (a text chunk extends it): the one before any waiting confirm card. */
export function lastStreamItem(items: readonly ThreadItem[]): ThreadItem | undefined {
  return items[pendingConfirmStart(items) - 1];
}

/** A copy of `items` with `item` replaced in place (same id) or inserted where it belongs. */
export function withItem(items: readonly ThreadItem[], item: ThreadItem): ThreadItem[] {
  const i = items.findIndex((x) => x.id === item.id);
  if (i >= 0) return items.map((x, j) => (j === i ? item : x));
  const at = insertIndex(items, item);
  return [...items.slice(0, at), item, ...items.slice(at)];
}
