// Send while busy: a per-chat queue of messages typed while the agent works or while its CLI is offline, their
// WhatsApp-style delivery state (queued → delivered → seen), and "Send now" (steer into the running turn where the
// agent supports `_session/steering`, else Stop the turn and send). The queue lives in the thread (`Thread.queue`),
// so it survives a restart and goes out once the agent connects.
//
// No Electron here: promptQueueHost.ts plugs the live chat in (agents.ts) through `PromptQueueHost`; tests use a fake.
import { randomUUID } from 'node:crypto';
import type { AgentStatus, AttachmentView, SessionView, Thread, ThreadItem } from '@shared/types';
import {
  queueReason,
  queuedLabel,
  type PromptQueueView,
  type QueuedPrompt,
  type QueueReason,
  type SteerOutcome,
  type UserDelivery,
} from '@shared/promptQueue';

export interface PromptQueueHost {
  thread(threadId: string): Thread | undefined;
  /** Debounced save of the thread file. */
  save(thread: Thread): void;
  /** Re-sends a changed item to the windows (and saves the thread). */
  pushItem(threadId: string, item: ThreadItem): void;
  emit(view: PromptQueueView): void;
  agentName(threadId: string): string;
  /** A turn runs in this chat (one the user started, or one the agent started on its own). */
  busy(threadId: string): boolean;
  /** The agent CLI's state and this chat's session state; `connected` = it can take a prompt. */
  connection(threadId: string): { agent?: AgentStatus['state']; session?: SessionView['status']; connected: boolean };
  /** Starts the agent / session; true once it can take a prompt. */
  connect(threadId: string): Promise<boolean>;
  /** Sends a queued message as a new turn (agents.ts `deliverPrompt`): `sent` with its user item, else why not. */
  send(threadId: string, q: QueuedPrompt): Promise<{ outcome: 'sent' | 'busy' | 'offline'; item?: ThreadItem; done?: Promise<void> }>;
  /** Whether the chat's agent takes mid-turn input (`_session/steering`). */
  canSteer(threadId: string): boolean;
  /** Injects into the running turn; on `injected` it has added the user item and returns it. */
  steer?(threadId: string, text: string, attachments: AttachmentView[]): Promise<{ outcome: SteerOutcome; item?: ThreadItem }>;
  /** Stops the running turn (`session/cancel`). */
  cancel(threadId: string): Promise<void>;
}

/** Item kinds that show the agent reacted to a message. */
const OUTPUT_KINDS = new Set<ThreadItem['kind']>(['agent', 'thought', 'tool', 'plan', 'plan-doc', 'permission', 'elicitation']);

let host: PromptQueueHost | undefined;
/** Sent messages waiting for the agent's first output, per chat (user item ids). */
const awaitingSeen = new Map<string, string[]>();
/** Chats whose next queued message is going out right now (one at a time, one per turn). */
const draining = new Set<string>();
/** Chats whose queue waits after the user pressed Stop, until they send or press "Send now". */
const held = new Set<string>();
/** Chats with queued messages, to recheck when an agent's CLI comes up. */
const withQueue = new Set<string>();

export function initPromptQueue(h: PromptQueueHost): void {
  host = h;
}

function H(): PromptQueueHost {
  if (!host) throw new Error('Prompt queue not initialised.');
  return host;
}

function reasonFor(threadId: string): QueueReason {
  const c = H().connection(threadId);
  const r = queueReason(c.agent, c.session, c.connected);
  return r === 'busy' && held.has(threadId) && !H().busy(threadId) ? 'held' : r;
}

/** The chat's queue as the composer shows it. */
export function view(threadId: string): PromptQueueView {
  const h = H();
  const t = h.thread(threadId);
  const reason = reasonFor(threadId);
  const name = h.agentName(threadId);
  const items = (t?.queue ?? []).map((q) => ({
    ...q,
    ticks: (reason === 'busy' || reason === 'held' ? 2 : 1) as 1 | 2,
    reason,
    label: queuedLabel(reason, name),
  }));
  return { threadId, items, sendNow: h.canSteer(threadId) ? 'steer' : 'interrupt' };
}

function persist(t: Thread) {
  if (t.queue?.length) withQueue.add(t.id);
  else {
    withQueue.delete(t.id);
    delete t.queue;
  }
  H().save(t);
}

function changed(t: Thread) {
  persist(t);
  H().emit(view(t.id));
}

/** A message reached the agent: it turns blue once the agent reacts. */
function track(threadId: string, item: ThreadItem | undefined, via: UserDelivery['via']) {
  if (!item || item.kind !== 'user') return;
  if (!item.delivery) {
    item.delivery = { state: 'delivered', via, at: Date.now() };
    H().pushItem(threadId, item);
  }
  const list = awaitingSeen.get(threadId) ?? [];
  if (!list.includes(item.id) && item.delivery.state === 'delivered') awaitingSeen.set(threadId, [...list, item.id]);
}

function add(threadId: string, text: string, attachments: AttachmentView[], extra: Pick<QueuedPrompt, 'fromAgent' | 'fromApp'>): Thread {
  const t = H().thread(threadId);
  if (!t) throw new Error('Chat not found.');
  (t.queue ??= []).push({
    id: randomUUID(),
    text,
    ts: Date.now(),
    ...(attachments.length ? { attachments } : {}),
    ...(extra.fromAgent ? { fromAgent: extra.fromAgent } : {}),
    ...(extra.fromApp ? { fromApp: true } : {}),
  });
  return t;
}

/**
 * A message from the composer. It joins the queue and goes out at once when the chat is free (connecting the agent
 * first if needed). Returns `sent` when it is going out straight away (the strip doesn't flash it), else `queued`.
 */
export function submit(threadId: string, text: string, attachments: AttachmentView[] = []): 'sent' | 'queued' {
  const h = H();
  const before = h.thread(threadId)?.queue?.length ?? 0;
  const straight = !before && !h.busy(threadId) && h.connection(threadId).connected && !draining.has(threadId);
  const t = add(threadId, text, attachments, {});
  held.delete(threadId);
  if (straight) persist(t);
  else changed(t);
  void drain(threadId, true);
  return straight ? 'sent' : 'queued';
}

/** A message `sendPrompt` got while a turn runs (orchestrator, app notices, a second window): it waits its turn. */
export function enqueue(threadId: string, text: string, attachments: AttachmentView[] = [], extra: Pick<QueuedPrompt, 'fromAgent' | 'fromApp'> = {}): void {
  changed(add(threadId, text, attachments, extra));
}

/**
 * Sends the next queued message ("Send now" first) if the chat is free. One per turn: the rest wait for its end.
 * With `connect`, an agent that isn't up is started first; the message stays in the queue (editable) meanwhile.
 */
export async function drain(threadId: string, connect = false): Promise<boolean> {
  const h = H();
  const t = h.thread(threadId);
  if (!t?.queue?.length || draining.has(threadId) || h.busy(threadId)) return false;
  // After Stop the queue waits, unless the user picked one with "Send now".
  if (held.has(threadId) && !t.queue.some((q) => q.urgent)) return false;
  draining.add(threadId);
  try {
    if (!h.connection(threadId).connected) {
      if (!connect) return false;
      const ok = await h.connect(threadId).catch(() => false);
      if (!ok) {
        h.emit(view(threadId));
        return false;
      }
    }
    // Read again after the wait: it may have been edited, removed or picked for "Send now" meanwhile.
    const queue = t.queue ?? [];
    const next = queue.find((q) => q.urgent) ?? queue[0];
    if (!next || h.busy(threadId)) return false;
    const res = await h.send(threadId, { ...next, urgent: undefined }).catch(() => ({ outcome: 'offline' as const, item: undefined, done: undefined }));
    if (res.outcome !== 'sent') {
      h.emit(view(threadId));
      return false;
    }
    const i = t.queue?.indexOf(next) ?? -1;
    if (i >= 0) t.queue!.splice(i, 1);
    held.delete(threadId);
    changed(t);
    track(threadId, res.item, 'prompt');
    void res.done?.catch(() => {});
    return true;
  } finally {
    draining.delete(threadId);
  }
}

export function remove(threadId: string, id: string): QueuedPrompt | undefined {
  const t = H().thread(threadId);
  const i = t?.queue?.findIndex((q) => q.id === id) ?? -1;
  if (!t || i < 0) return undefined;
  const [gone] = t.queue!.splice(i, 1);
  changed(t);
  return gone;
}

export function edit(threadId: string, id: string, text: string): boolean {
  const t = H().thread(threadId);
  const q = t?.queue?.find((x) => x.id === id);
  if (!t || !q || !text.trim()) return false;
  q.text = text.trim();
  changed(t);
  return true;
}

export type SendNowResult = 'sent' | 'steered' | 'interrupting' | 'connecting' | 'missing';

/**
 * "Send now": into the running turn where the agent can steer, else Stop the turn (the message goes out as soon as
 * it ends). A free chat sends it straight away; an offline agent is started first.
 */
export async function sendNow(threadId: string, id: string): Promise<SendNowResult> {
  const h = H();
  const t = h.thread(threadId);
  const q = t?.queue?.find((x) => x.id === id);
  if (!t || !q) return 'missing';
  held.delete(threadId);
  q.urgent = true;
  changed(t);
  if (!h.busy(threadId)) return (await drain(threadId, true)) ? 'sent' : 'connecting';
  if (h.canSteer(threadId) && h.steer) {
    const res = await h.steer(threadId, q.text, q.attachments ?? []).catch(() => ({ outcome: 'failed' as const, item: undefined }));
    if (res.outcome === 'injected') {
      const i = t.queue?.indexOf(q) ?? -1;
      if (i >= 0) t.queue!.splice(i, 1);
      changed(t);
      track(threadId, res.item, 'steer');
      return 'steered';
    }
    // The turn ended meanwhile: it goes out as a normal prompt.
    if (res.outcome === 'promptRequired' && (await drain(threadId, true))) return 'sent';
    if (!h.busy(threadId)) return (await drain(threadId, true)) ? 'sent' : 'connecting';
  }
  await h.cancel(threadId).catch(() => {});
  return 'interrupting';
}

/** A turn ended: the next queued message goes out (after the other turn-end listeners and queues have run). */
export function onTurnEnd(threadId: string): void {
  setTimeout(() => {
    if (!host) return;
    void drain(threadId).then((sent) => {
      if (!sent && host) H().emit(view(threadId));
    });
  }, 0);
}

/** The user pressed Stop: queued messages wait (they could be about the work just stopped) until sent on purpose. */
export function onUserStop(threadId: string): void {
  if (H().thread(threadId)?.queue?.length) held.add(threadId);
}

/** The agent produced output: messages it got before that output are seen. */
export function onItem(threadId: string, item: ThreadItem): void {
  if (!item) return;
  // Any message that went out with ticks (composer, queue, steering, a new chat's first message) is watched.
  if (item.kind === 'user' && item.delivery?.state === 'delivered') {
    const list = awaitingSeen.get(threadId) ?? [];
    if (!list.includes(item.id)) awaitingSeen.set(threadId, [...list, item.id]);
    return;
  }
  const ids = awaitingSeen.get(threadId);
  if (!ids?.length || !OUTPUT_KINDS.has(item.kind)) return;
  const t = H().thread(threadId);
  if (!t) return;
  const at = t.items.findIndex((i) => i.id === item.id);
  const keep: string[] = [];
  for (const id of ids) {
    const n = t.items.findIndex((i) => i.id === id);
    const u = t.items[n];
    if (!u || u.kind !== 'user' || u.delivery?.state !== 'delivered') continue;
    // Only output placed after the message answers it (a steered message gets a new reply below it, agents.ts).
    if (at > n) {
      u.delivery = { ...u.delivery, state: 'seen', seenAt: Date.now() };
      H().pushItem(threadId, u);
    } else keep.push(id);
  }
  if (keep.length) awaitingSeen.set(threadId, keep);
  else awaitingSeen.delete(threadId);
}

/** The agent CLI or a chat's session changed state: refresh the ticks, and send queued messages if it is now up. */
export function onConnectionChange(threadId?: string, agentId?: string): void {
  if (!host) return;
  const ids = threadId ? [threadId] : [...withQueue].filter((id) => !agentId || H().thread(id)?.agentId === agentId);
  for (const id of ids) {
    const t = H().thread(id);
    if (!t?.queue?.length) continue;
    withQueue.add(id);
    if (draining.has(id)) continue;
    void drain(id).then((sent) => {
      if (!sent && host) H().emit(view(id));
    });
  }
}

/** At startup: chats that still had queued messages connect their agent and send them. */
export function resumeAll(threadIds: string[]): void {
  for (const id of threadIds) {
    if (!H().thread(id)?.queue?.length) continue;
    withQueue.add(id);
    void drain(id, true);
  }
}

/**
 * Feeds the app's own events in (index.ts calls it from `emit`), so the queue follows the chat without extra hooks:
 * session/agent state → ticks and sending, new or updated items → "seen".
 */
export function observe(channel: string, payload: unknown): void {
  if (!host) return;
  try {
    if (channel === 'session:state') onConnectionChange((payload as SessionView).threadId);
    else if (channel === 'agent:status') onConnectionChange(undefined, (payload as AgentStatus).id);
    else if (channel === 'thread:item') {
      const p = payload as { threadId: string; item: ThreadItem };
      onItem(p.threadId, p.item);
    }
  } catch {
    /* the queue must never break the app's events */
  }
}

/** Forget a deleted chat. */
export function forget(threadId: string): void {
  awaitingSeen.delete(threadId);
  held.delete(threadId);
  withQueue.delete(threadId);
  draining.delete(threadId);
}
