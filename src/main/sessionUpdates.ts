import { randomUUID } from 'node:crypto';
import type { PlanEntryView, Thread, ThreadItem } from '@shared/types';

/**
 * ACP session updates beyond messages and tools: plans (`plan_update` / `plan_removed`), notices, context
 * compaction, user messages from the agent's side, Codex session failures; plus the turn-level helpers around
 * them (stop reasons, error text, which errors mean "log in", slash commands, agent titles). agents.ts routes
 * the updates here; nothing in this file talks to the agent.
 */

/** What one turn has created so far, to update the same thread items as more updates arrive. */
export interface TurnState {
  agentItemId?: string;
  thoughtItemId?: string;
  /** Legacy `plan` update: the session's one plan. */
  planItemId?: string;
  /** ACP `messageId` of the agent message / thought being streamed: a new id starts a new message. */
  agentMsgId?: string;
  thoughtMsgId?: string;
  /** `plan_update` plans of this turn: `items:<planId>` / `doc:<planId>` → thread item id. */
  plans?: Record<string, string>;
  /** The user message (`user_message_chunk`) being streamed from the agent's side. */
  userMsg?: { messageId?: string; text: string; itemId?: string; at: number };
  /** Text blocks Olympus sent with this turn's prompt: an agent echoing them back is not shown twice. */
  sentTexts?: string[];
  /** Tool calls the agent started this turn, the item index of the first, and whether the turn was stopped as a runaway loop (agents.ts). */
  toolCalls?: number;
  toolsFrom?: number;
  runaway?: boolean;
}

export interface UpdateRuntime {
  thread: Thread;
  agentId: string;
  turn: TurnState;
}

export interface UpdateHost {
  addItem: (rt: UpdateRuntime, item: ThreadItem) => void;
  pushItem: (rt: UpdateRuntime, item: ThreadItem, throttle?: boolean) => void;
  /** Text of one ACP content block. */
  textOf: (content: any) => string;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function findLast<T extends ThreadItem>(items: ThreadItem[], pred: (i: ThreadItem) => i is T): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (pred(it)) return it;
  }
  return undefined;
}

const byId = (rt: UpdateRuntime, id?: string) => (id ? rt.thread.items.find((i) => i.id === id) : undefined);

// ------------------------------------------------------------------ plans

export function planEntries(list: unknown): PlanEntryView[] {
  return (Array.isArray(list) ? list : []).map((e: any) => ({ content: String(e?.content ?? ''), status: e?.status, priority: e?.priority }));
}

/**
 * `plan_update`: an item plan becomes the checklist the app already shows; a markdown or file plan becomes a plan
 * document. Each plan id has one thread item per turn, replaced whole by every update (as ACP specifies).
 */
export function applyPlanUpdate(host: UpdateHost, rt: UpdateRuntime, u: any, now = Date.now()): void {
  const p = u?.plan;
  const planId = str(p?.planId);
  if (!p || !planId) return;
  const plans = (rt.turn.plans ??= {});
  if (p.type === 'items') {
    const entries = planEntries(p.entries);
    const existing = byId(rt, plans[`items:${planId}`]);
    if (existing?.kind === 'plan' && !existing.removed) {
      existing.entries = entries;
      host.pushItem(rt, existing, true);
      return;
    }
    const item: ThreadItem = { kind: 'plan', id: randomUUID(), agentId: rt.agentId, planId, entries, ts: now };
    plans[`items:${planId}`] = item.id;
    host.addItem(rt, item);
    return;
  }
  if (p.type !== 'markdown' && p.type !== 'file') return;
  const format: 'markdown' | 'file' = p.type;
  const content = format === 'markdown' ? (typeof p.content === 'string' ? p.content : '') : undefined;
  const uri = format === 'file' ? str(p.uri) : undefined;
  if (format === 'file' && !uri) return;
  const existing = byId(rt, plans[`doc:${planId}`]);
  if (existing?.kind === 'plan-doc' && !existing.removed) {
    existing.format = format;
    existing.content = content;
    existing.uri = uri;
    host.pushItem(rt, existing, true);
    return;
  }
  const item: ThreadItem = { kind: 'plan-doc', id: randomUUID(), agentId: rt.agentId, planId, format, ...(content !== undefined ? { content } : {}), ...(uri ? { uri } : {}), ts: now };
  plans[`doc:${planId}`] = item.id;
  host.addItem(rt, item);
}

/** `plan_removed`: the newest item of that plan stops being shown (earlier turns' copies stay as history). */
export function applyPlanRemoved(host: UpdateHost, rt: UpdateRuntime, u: any): void {
  const planId = str(u?.planId);
  if (!planId) return;
  const item = findLast(rt.thread.items, (i): i is Extract<ThreadItem, { kind: 'plan' | 'plan-doc' }> => (i.kind === 'plan' || i.kind === 'plan-doc') && i.planId === planId && !i.removed);
  if (rt.turn.plans) {
    delete rt.turn.plans[`items:${planId}`];
    delete rt.turn.plans[`doc:${planId}`];
  }
  if (!item) return;
  item.removed = true;
  host.pushItem(rt, item);
}

// ------------------------------------------------------------------ notices

export function applyNotice(host: UpdateHost, rt: UpdateRuntime, u: any, now = Date.now()): void {
  const title = str(u?.title);
  const description = str(u?.description);
  if (!title && !description) return;
  host.addItem(rt, {
    kind: 'notice',
    id: randomUUID(),
    agentId: rt.agentId,
    severity: str(u?.severity) || 'info',
    title: title || description,
    ...(title && description ? { description } : {}),
    ts: now,
  });
}

/**
 * A Codex session failure (JetBrains AIR `sessionFailure`: on a `session_info_update` or a prompt response's
 * `_meta`). Errors become the chat's usual error row (so quota and failure detection keep working), warnings a
 * notice; later revisions of the same failure update that row. Returns true when it asks the user to log in.
 */
export function applySessionFailure(host: UpdateHost, rt: UpdateRuntime, f: any, now = Date.now()): boolean {
  const id = str(f?.id);
  if (!id) return false;
  const key = `failure:${id}`;
  const title = str(f.title) || 'The agent reported a problem.';
  const details = str(f.details);
  const login = f.category === 'access' || (Array.isArray(f.actions) && f.actions.includes('login'));
  const asError = f.severity === 'error' || login;
  const at = rt.thread.items.findIndex((i) => (i.kind === 'error' || i.kind === 'notice') && i.key === key);
  const prev = at >= 0 ? rt.thread.items[at] : undefined;
  const next: ThreadItem = asError
    ? { kind: 'error', id: prev?.id ?? randomUUID(), agentId: rt.agentId, text: details && !title.includes(details) ? `${title}\n${details}` : title, key, ts: prev?.ts ?? now }
    : {
        kind: 'notice',
        id: prev?.id ?? randomUUID(),
        agentId: rt.agentId,
        severity: str(f.severity) || 'warning',
        title,
        ...(details && !title.includes(details) ? { description: details } : {}),
        key,
        ts: prev?.ts ?? now,
      };
  if (prev) {
    rt.thread.items[at] = next;
    host.pushItem(rt, next);
  } else host.addItem(rt, next);
  return login;
}

// ------------------------------------------------------------------ context compaction

const TERMINAL_COMPACTION = new Set(['completed', 'failed', 'cancelled']);

function compactionItem(rt: UpdateRuntime, compactionId: string, now: number): { item: Extract<ThreadItem, { kind: 'compaction' }>; isNew: boolean } {
  const found = findLast(rt.thread.items, (i): i is Extract<ThreadItem, { kind: 'compaction' }> => i.kind === 'compaction' && i.compactionId === compactionId);
  if (found) return { item: found, isNew: false };
  return { item: { kind: 'compaction', id: randomUUID(), agentId: rt.agentId, compactionId, status: 'in_progress', ts: now }, isNew: true };
}

/**
 * `compaction_update`: the first one places the row, later ones with the same id patch it. `summary` and `error`
 * follow ACP patch rules: left out = unchanged, `null` (or an empty summary) = cleared, a value replaces.
 */
export function applyCompactionUpdate(host: UpdateHost, rt: UpdateRuntime, u: any, now = Date.now()): void {
  const compactionId = str(u?.compactionId);
  if (!compactionId) return;
  const { item, isNew } = compactionItem(rt, compactionId, now);
  if (str(u.status)) item.status = str(u.status);
  if (u.summary !== undefined) {
    const text = Array.isArray(u.summary) ? u.summary.map((b: any) => host.textOf(b)).filter(Boolean).join('\n\n') : '';
    if (text) item.summary = text;
    else delete item.summary;
  }
  if (u.error !== undefined) {
    if (u.error === null || !String(u.error).trim()) delete item.error;
    else item.error = String(u.error);
  }
  if (TERMINAL_COMPACTION.has(item.status)) item.endedAt ??= now;
  else delete item.endedAt;
  if (isNew) host.addItem(rt, item);
  else host.pushItem(rt, item);
}

/** `compaction_summary_chunk`: appended to that compaction's summary in the order received (a new id starts one). */
export function applyCompactionChunk(host: UpdateHost, rt: UpdateRuntime, u: any, now = Date.now()): void {
  const compactionId = str(u?.compactionId);
  const text = host.textOf(u?.content);
  if (!compactionId || !text) return;
  const { item, isNew } = compactionItem(rt, compactionId, now);
  item.summary = (item.summary ?? '') + text;
  if (isNew) host.addItem(rt, item);
  else host.pushItem(rt, item, true);
}

// ------------------------------------------------------------------ user messages from the agent's side

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Whether `text` (so far) is the start of something Olympus itself sent in this turn. */
function isEcho(sent: string[] | undefined, text: string): boolean {
  const t = norm(text);
  return Boolean(t && sent?.some((s) => norm(s).startsWith(t)));
}

/**
 * `user_message_chunk` on a root chat: a message typed in another client of the session, or one the agent replays
 * or injects. Shown as a user message marked as coming from the agent's session. Chunks that only repeat what
 * Olympus sent this turn stay hidden (the user's own message is already in the chat).
 */
export function applyUserMessageChunk(host: UpdateHost, rt: UpdateRuntime, u: any, now = Date.now()): void {
  const text = Array.isArray(u?.content) ? u.content.map((c: any) => host.textOf(c)).filter(Boolean).join('\n') : host.textOf(u?.content);
  if (!text) return;
  const messageId = str(u?.messageId) || undefined;
  const items = rt.thread.items;
  const cur = rt.turn.userMsg;
  const same =
    cur &&
    u.sessionUpdate === 'user_message_chunk' &&
    (messageId ? cur.messageId === messageId : !cur.messageId && (cur.itemId ? items[items.length - 1]?.id === cur.itemId : items.length === cur.at));
  const msg = same && cur ? cur : { messageId, text: '', at: items.length };
  rt.turn.userMsg = msg;
  msg.text += text;
  const shown = byId(rt, msg.itemId);
  if (shown?.kind === 'user') {
    shown.text = msg.text;
    host.pushItem(rt, shown, true);
    return;
  }
  if (isEcho(rt.turn.sentTexts, msg.text)) return;
  const item: ThreadItem = { kind: 'user', id: randomUUID(), agentId: rt.agentId, text: msg.text, viaAgent: true, ts: now };
  msg.itemId = item.id;
  host.addItem(rt, item);
}

/**
 * Whether an agent message / thought chunk continues the item being streamed. A chunk whose ACP `messageId` differs
 * from the one being streamed starts a new message; chunks without ids keep the old behaviour (one per turn run).
 */
export function continuesMessage(streamingId: string | undefined, chunkId: unknown): boolean {
  const id = str(chunkId);
  return !(id && streamingId && id !== streamingId);
}

// ------------------------------------------------------------------ turns, errors, titles

const STOP_REASON_TEXT: Record<string, string> = {
  max_tokens: 'The reply was cut off because it reached the model’s output limit. Ask the agent to continue.',
  max_turn_requests: 'The agent stopped because it reached its step limit for one turn. Send a message to let it continue.',
  refusal: 'The model declined to continue with this request.',
};

/** What to tell the user when a turn ends with something other than `end_turn` / `cancelled` (undefined = nothing). */
export function stopReasonText(reason: unknown): string | undefined {
  const r = str(reason);
  if (!r || r === 'end_turn' || r === 'cancelled') return undefined;
  return STOP_REASON_TEXT[r] ?? `The agent ended the turn early (${r.replace(/_/g, ' ')}).`;
}

/** Text of a failed JSON-RPC request, with the error's `data` when it says more than the message. */
export function describeError(e: any): string {
  const msg = str(e?.message) || String(e ?? 'Unknown error');
  const d = e?.data;
  const detail = typeof d === 'string' ? str(d) : str(d?.message) || str(d?.details) || str(d?.error);
  if (!detail || msg.includes(detail)) return msg;
  if (/^(internal error|server error|request failed|unknown error)\.?$/i.test(msg)) return detail;
  return `${msg}\n${detail}`;
}

const AUTH_TEXT =
  /authentication required|provider authentication required|not (logged|signed) in|unauthenticated|unauthori[sz]ed|\b401\b|(?:invalid|missing|no)\s+(?:[\w-]+\s+){0,3}api[-_ ]?key|api[-_ ]?key\b.{0,24}\b(missing|required|not set|not found|invalid)|\b(need|please|must)\s+(?:to\s+)?(log|sign) ?in\b|\b(log|sign) ?in\b.{0,24}\b(required|again|expired|to continue|to use|first)|\bauth(entication|orization)?\b.{0,24}\b(failed|expired|invalid|error)|credentials?\b.{0,24}\b(missing|expired|invalid|not found)|configuration value not found:\s*goose_provider|no provider configured/i;

/**
 * Whether a failed request means the agent needs a login or provider setup. Checks both `message` and `data`
 * (`describeError`) because CLI agents often wrap auth failures inside `-32603 Internal error` `data`.
 */
export function isAuthError(e: any): boolean {
  const msg = describeError(e);
  if (e?.code === -32000 && /^\s*authentication required/i.test(String(e?.message ?? ''))) return true;
  return AUTH_TEXT.test(msg);
}

/** A message that is an agent command ("/review x"): it must reach the agent as the prompt's only text block. */
export function isSlashCommand(text: string): boolean {
  return /^\/[^\s/]+(?:\s|$)/.test(text.trimStart());
}

/**
 * The title an agent's `session_info_update` gives this chat, if it should be applied: later renames by the agent
 * count, a user's own rename always wins, and chats the app named (sub-sessions, sub-agents, second opinions,
 * scheduled runs) keep their name unless it is still "New chat". `null` / empty titles are ignored.
 */
export function agentTitleFor(thread: Thread, title: unknown): string | undefined {
  if (typeof title !== 'string') return undefined;
  // Agents that name a chat after its first prompt (ZCode) see Olympus's own `<olympus-context>` block first: drop
  // it, so a cut-off block gives no title and a whole one leaves the user's own words.
  const own = title.replace(/^\s*<olympus-context\b[^>]*>[\s\S]*?(?:<\/olympus-context>|$)/, '');
  const clean = own.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!clean || clean === thread.title || thread.titleSetByUser) return undefined;
  const appNamed = thread.nativeSubagent || thread.spawnedBy || thread.secondOpinion || thread.scheduleId;
  if (appNamed && thread.title !== 'New chat') return undefined;
  return clean;
}
