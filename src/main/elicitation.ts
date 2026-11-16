import { randomUUID } from 'node:crypto';
import { RequestError } from '@agentclientprotocol/sdk/unstable';
import { cleanContent, parseElicitSchema, type ElicitContent, type ElicitSchema } from '@shared/elicitation';
import type { ConfirmRequest, ElicitResolution, ThreadItem } from '@shared/types';

/**
 * ACP elicitations: the agent asks the user something (`elicitation/create`). Claude Code sends its
 * AskUserQuestion tool, the "retry with another model?" consent prompt and MCP servers' own questions as forms,
 * and MCP OAuth logins as a link to open (URL mode, finished later by `elicitation/complete`).
 *
 * Each request becomes an `elicitation` item in the chat (or the sub-agent's thread) and waits for the user, like
 * a permission request — but nothing answers it for the user: "Approve all" and tool rules do not apply to
 * questions. Stop answers open ones with `cancel`; the agent can withdraw one (`$/cancel_request`).
 */

type ElicitItem = Extract<ThreadItem, { kind: 'elicitation' }>;

export type ElicitResponse = { action: 'accept'; content?: ElicitContent } | { action: 'decline' } | { action: 'cancel' };

export interface ElicitRuntime {
  thread: { id: string; items: ThreadItem[] };
  agentId: string;
  pendingElicits: Map<string, (r: ElicitResponse, why?: ElicitResolution) => void>;
}

export interface ElicitHost {
  bySession: Map<string, ElicitRuntime>;
  runtimes: () => Iterable<ElicitRuntime>;
  addItem: (rt: ElicitRuntime, item: ThreadItem) => void;
  pushItem: (rt: ElicitRuntime, item: ThreadItem) => void;
  /** The runtime of a chat by thread id (created if needed), for questions Olympus itself asks. */
  forThread?: (threadId: string) => ElicitRuntime;
  log?: (msg: string) => void;
}

let host: ElicitHost | undefined;
export const initElicitations = (h: ElicitHost) => (host = h);

const isWebUrl = (u: unknown): u is string => {
  if (typeof u !== 'string') return false;
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
};

/** Handler for `elicitation/create`. `signal` aborts when the agent withdraws the request. */
export async function createElicitation(params: any, signal?: AbortSignal): Promise<ElicitResponse> {
  const h = host;
  if (!h) return Promise.resolve({ action: 'cancel' });
  const rt = typeof params?.sessionId === 'string' ? h.bySession.get(params.sessionId) : undefined;
  // Request-scoped elicitations (before any session) and unknown sessions have no chat to ask in.
  if (!rt) {
    h.log?.(`[elicitation] no chat for ${params?.sessionId ? `session ${params.sessionId}` : 'a request-scoped elicitation'}; cancelled`);
    return Promise.resolve({ action: 'cancel' });
  }
  const mode = params?.mode;
  const message = typeof params?.message === 'string' ? params.message : '';
  let item: ElicitItem;
  if (mode === 'form') {
    const schema = (params.requestedSchema ?? { type: 'object', properties: {} }) as ElicitSchema;
    const { unsupported } = parseElicitSchema(schema);
    if (unsupported.length) throw RequestError.invalidParams(undefined, `Olympus Coder cannot show these form fields: ${unsupported.join(', ')}`);
    item = { kind: 'elicitation', id: randomUUID(), agentId: rt.agentId, mode, message, schema, toolCallId: params.toolCallId ?? undefined, ts: Date.now() };
  } else if (mode === 'url') {
    if (!isWebUrl(params.url)) throw RequestError.invalidParams(undefined, 'Only http and https links can be opened.');
    item = {
      kind: 'elicitation',
      id: randomUUID(),
      agentId: rt.agentId,
      mode,
      message,
      url: params.url,
      elicitationId: typeof params.elicitationId === 'string' ? params.elicitationId : undefined,
      toolCallId: params.toolCallId ?? undefined,
      ts: Date.now(),
    };
  } else {
    throw RequestError.invalidParams(undefined, `Unsupported elicitation mode: ${String(mode)}`);
  }
  if (signal?.aborted) return Promise.resolve({ action: 'cancel' });
  h.addItem(rt, item);
  return new Promise((resolve) => {
    const onAbort = () => rt.pendingElicits.get(item.id)?.({ action: 'cancel' }, 'withdrawn');
    rt.pendingElicits.set(item.id, (r, why) => {
      rt.pendingElicits.delete(item.id);
      signal?.removeEventListener('abort', onAbort);
      if (!item.resolved) {
        item.resolved = why ?? (r.action === 'accept' ? 'accepted' : r.action === 'decline' ? 'declined' : 'cancelled');
        if (r.action === 'accept' && r.content && Object.keys(r.content).length) item.answer = r.content;
        h.pushItem(rt, item);
      }
      resolve(r);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Olympus Coder itself asks the user in a chat to approve an action (e.g. an agent's add_agent tool call). The same
 * question card as an agent's elicitation, so it shows on the phone too and is never answered by "Approve all" or a
 * bypass mode. Resolves true only when the user approves; Stop, dismiss, decline or `signal` give false.
 */
export async function confirmInThread(threadId: string, confirm: ConfirmRequest, signal?: AbortSignal): Promise<boolean> {
  const h = host;
  if (!h?.forThread) throw new Error('Olympus Coder cannot ask in this chat right now.');
  const rt = h.forThread(threadId);
  if (signal?.aborted) return false;
  const item: ElicitItem = {
    kind: 'elicitation',
    id: randomUUID(),
    agentId: rt.agentId,
    mode: 'form',
    message: confirm.title,
    schema: { type: 'object', properties: {} },
    confirm,
    ts: Date.now(),
  };
  h.addItem(rt, item);
  return new Promise((resolve) => {
    const onAbort = () => rt.pendingElicits.get(item.id)?.({ action: 'cancel' }, 'withdrawn');
    rt.pendingElicits.set(item.id, (r, why) => {
      rt.pendingElicits.delete(item.id);
      signal?.removeEventListener('abort', onAbort);
      if (!item.resolved) {
        item.resolved = why ?? (r.action === 'accept' ? 'accepted' : r.action === 'decline' ? 'declined' : 'cancelled');
        h.pushItem(rt, item);
      }
      resolve(r.action === 'accept');
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The user answered a question card. Throws (with a message for the card) when the answer is not valid. */
export function answerElicitation(rt: ElicitRuntime, itemId: string, action: string, content?: Record<string, unknown> | null): void {
  const finish = rt.pendingElicits.get(itemId);
  if (!finish) throw new Error('This question is no longer waiting for an answer.');
  const item = rt.thread.items.find((i): i is ElicitItem => i.id === itemId && i.kind === 'elicitation');
  if (action === 'accept') {
    // URL mode: accepting means the user opened the link; nothing else is sent.
    finish(item?.mode === 'form' ? { action: 'accept', content: cleanContent(item.schema, content) } : { action: 'accept' });
  } else if (action === 'decline') finish({ action: 'decline' });
  else finish({ action: 'cancel' });
}

/** Stop / the agent went away: open questions are answered with `cancel` and marked with `why`. */
export function cancelElicitations(rt: ElicitRuntime, why: ElicitResolution = 'cancelled'): void {
  for (const finish of [...rt.pendingElicits.values()]) finish({ action: 'cancel' }, why);
}

/** Handler for `elicitation/complete`: the flow behind a link finished (e.g. an MCP server's OAuth login). */
export function completeElicitation(params: any): void {
  const h = host;
  const id = params?.elicitationId;
  if (!h || typeof id !== 'string') return;
  for (const rt of h.runtimes()) {
    const item = rt.thread.items.find((i): i is ElicitItem => i.kind === 'elicitation' && i.mode === 'url' && i.elicitationId === id);
    if (!item) continue;
    item.completed = true;
    const finish = rt.pendingElicits.get(item.id);
    // Finished before the user clicked: the link's job is done, so the request no longer waits on them.
    if (finish) finish({ action: 'accept' });
    else h.pushItem(rt, item);
    return;
  }
}
