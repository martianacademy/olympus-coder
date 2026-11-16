import { randomUUID } from 'node:crypto';
import type { AcpSessionSupport, AcpSideEffect, NativeArchiveFilter, NativeSessionView } from '@shared/acpSessions';
import type { AgentId, PlanEntryView, ThreadItem, ToolContentView } from '@shared/types';

/**
 * The ACP session lifecycle beyond `session/new`: load (with a history replay), list, fork, close, delete,
 * archive, status, options and set_title. Every call is gated on what the agent advertised in `initialize`;
 * nothing here knows about the app's runtimes, so it works against any connection that can send a request.
 *
 * The replay of `session/load` arrives as ordinary `session/update`s between the request and its answer (and,
 * for Claude with the AIR `loadReplayEnd` capability, ends with a marker update). `ReplayGates` holds those
 * updates back from the chat while a load is open; `replayToItems` + `mergeReplay` then turn them into chat
 * items and keep only the ones the chat does not show yet, so reattaching never duplicates history.
 */

/** Anything that can send an ACP request: the SDK's `conn.agent`, or a test double. */
export interface AcpRequester {
  request(method: string, params: unknown): Promise<any>;
}

/** ACP 2.6.0 method names (`methods.agent.session.*` in the SDK). */
export const SESSION_METHOD = {
  load: 'session/load',
  list: 'session/list',
  fork: 'session/fork',
  close: 'session/close',
  delete: 'session/delete',
  archive: 'session/archive',
  unarchive: 'session/unarchive',
  status: 'session/status',
  options: 'session/options',
  setTitle: 'session/set_title',
  resume: 'session/resume',
} as const;

/** JSON-RPC error the spec uses for "no such session" (`-32002`, resource not found). */
export const SESSION_NOT_FOUND = -32002;

export const NO_SESSION_SUPPORT: AcpSessionSupport = {
  load: false,
  resume: false,
  list: false,
  fork: false,
  close: false,
  delete: false,
  archive: false,
  status: false,
  options: false,
  setTitle: false,
  additionalDirectories: false,
};

/** `{}` means supported; omitted or `null` means not (the spec's rule for every session capability). */
const advertised = (v: unknown) => v !== undefined && v !== null && v !== false;

/** Read the session lifecycle an agent supports from its `agentCapabilities`. */
export function sessionSupport(agentCapabilities: any): AcpSessionSupport {
  const s = agentCapabilities?.sessionCapabilities ?? {};
  const list = advertised(s.list);
  return {
    load: agentCapabilities?.loadSession === true,
    resume: advertised(s.resume),
    list,
    fork: advertised(s.fork),
    close: advertised(s.close),
    delete: advertised(s.delete),
    // The spec requires `list` alongside `archive`; without it the archived filter has nothing to filter.
    archive: advertised(s.archive) && list,
    status: advertised(s.status),
    options: advertised(s.options),
    setTitle: advertised(s.title),
    additionalDirectories: advertised(s.additionalDirectories),
  };
}

export class AcpUnsupportedError extends Error {
  readonly method: string;
  constructor(method: string) {
    super(`This agent does not support ${method}.`);
    this.name = 'AcpUnsupportedError';
    this.method = method;
  }
}

function need(ok: boolean, method: string) {
  if (!ok) throw new AcpUnsupportedError(method);
}

export const isNotFound = (e: any) => e?.code === SESSION_NOT_FOUND;

// ------------------------------------------------------------------ request wrappers

export interface SessionSetupParams {
  sessionId: string;
  cwd: string;
  mcpServers?: any[];
  additionalDirectories?: string[];
  systemPrompt?: unknown;
  /** Initial config values (`[{configId, value}]`), sent only when the agent supports `session/options`. */
  configOptions?: { configId: string; value: string | boolean }[];
  _meta?: Record<string, unknown>;
}

/** Drop the fields the agent did not advertise, as the spec requires of a client. */
function setupParams(support: AcpSessionSupport, p: SessionSetupParams, withMcp: 'required' | 'optional'): Record<string, unknown> {
  const out: Record<string, unknown> = { sessionId: p.sessionId, cwd: p.cwd };
  if (withMcp === 'required' || p.mcpServers) out.mcpServers = p.mcpServers ?? [];
  if (p.additionalDirectories?.length && support.additionalDirectories) out.additionalDirectories = p.additionalDirectories;
  if (p.systemPrompt != null) out.systemPrompt = p.systemPrompt;
  if (p.configOptions?.length && support.options) out.configOptions = p.configOptions;
  if (p._meta) out._meta = p._meta;
  return out;
}

/** `session/load`. The history replay arrives as `session/update`s before this resolves (see `loadWithReplay`). */
export async function loadSession(conn: AcpRequester, caps: any, p: SessionSetupParams): Promise<any> {
  const support = sessionSupport(caps);
  need(support.load, SESSION_METHOD.load);
  return (await conn.request(SESSION_METHOD.load, setupParams(support, p, 'required'))) ?? {};
}

/** `session/resume` (no replay). */
export async function resumeSession(conn: AcpRequester, caps: any, p: SessionSetupParams): Promise<any> {
  const support = sessionSupport(caps);
  need(support.resume, SESSION_METHOD.resume);
  return (await conn.request(SESSION_METHOD.resume, setupParams(support, p, 'optional'))) ?? {};
}

/** `session/fork`: a new session that starts with the source session's context. Resolves the new id. */
export async function forkSession(conn: AcpRequester, caps: any, p: SessionSetupParams): Promise<{ sessionId: string; response: any }> {
  const support = sessionSupport(caps);
  need(support.fork, SESSION_METHOD.fork);
  const { configOptions: _ignored, ...rest } = p; // fork has no initial config values in ACP 2.6.0
  const response = (await conn.request(SESSION_METHOD.fork, setupParams(support, rest, 'optional'))) ?? {};
  if (typeof response.sessionId !== 'string' || !response.sessionId) throw new Error('The agent answered session/fork without a session id.');
  return { sessionId: response.sessionId, response };
}

export async function closeSession(conn: AcpRequester, caps: any, sessionId: string): Promise<void> {
  need(sessionSupport(caps).close, SESSION_METHOD.close);
  await conn.request(SESSION_METHOD.close, { sessionId });
}

export async function deleteSession(conn: AcpRequester, caps: any, sessionId: string): Promise<void> {
  need(sessionSupport(caps).delete, SESSION_METHOD.delete);
  await conn.request(SESSION_METHOD.delete, { sessionId });
}

export async function archiveSession(conn: AcpRequester, caps: any, sessionId: string, archived: boolean): Promise<void> {
  need(sessionSupport(caps).archive, archived ? SESSION_METHOD.archive : SESSION_METHOD.unarchive);
  await conn.request(archived ? SESSION_METHOD.archive : SESSION_METHOD.unarchive, { sessionId });
}

/** `session/set_title`. Resolves the title the agent stored (it may normalize it). */
export async function setSessionTitle(conn: AcpRequester, caps: any, sessionId: string, title: string): Promise<string> {
  need(sessionSupport(caps).setTitle, SESSION_METHOD.setTitle);
  const clean = title.trim();
  if (!clean) throw new Error('A session title cannot be empty.');
  const r = await conn.request(SESSION_METHOD.setTitle, { sessionId, title: clean });
  return typeof r?.title === 'string' ? r.title : clean;
}

/**
 * `session/status`, folded to what the app decides on: `open` (in the agent's memory), `saved` (on disk only;
 * the spec says to read unknown values as `saved`), `missing` (`-32002`), or `unknown` (not supported, or the
 * check failed).
 */
export type SessionStatusView = 'open' | 'saved' | 'missing' | 'unknown';
export async function sessionStatus(conn: AcpRequester, caps: any, sessionId: string): Promise<SessionStatusView> {
  if (!sessionSupport(caps).status) return 'unknown';
  try {
    const r = await conn.request(SESSION_METHOD.status, { sessionId });
    return r?.status === 'open' ? 'open' : 'saved';
  } catch (e) {
    return isNotFound(e) ? 'missing' : 'unknown';
  }
}

/** `session/options`: the modes and config options a session would start with, without creating one. */
export async function sessionOptions(conn: AcpRequester, caps: any, p: { cwd: string; additionalDirectories?: string[]; sessionId?: string; _meta?: Record<string, unknown> }): Promise<any> {
  const support = sessionSupport(caps);
  need(support.options, SESSION_METHOD.options);
  const params: Record<string, unknown> = { cwd: p.cwd };
  if (p.additionalDirectories?.length && support.additionalDirectories) params.additionalDirectories = p.additionalDirectories;
  // The spec allows `sessionId` only for agents that can load or resume it.
  if (p.sessionId && (support.load || support.resume)) params.sessionId = p.sessionId;
  if (p._meta) params._meta = p._meta;
  return (await conn.request(SESSION_METHOD.options, params)) ?? {};
}

const parseTime = (s: unknown): number | undefined => {
  if (typeof s !== 'string' || !s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
};

/** One `SessionInfo` as the import list shows it. */
export function toNativeSessionView(info: any): NativeSessionView | null {
  if (!info || typeof info.sessionId !== 'string' || !info.sessionId) return null;
  const title = typeof info.title === 'string' && info.title.trim() ? info.title.replace(/\s+/g, ' ').trim() : 'Untitled session';
  return {
    sessionId: info.sessionId,
    cwd: typeof info.cwd === 'string' ? info.cwd : '',
    title,
    updatedAt: parseTime(info.updatedAt),
    ...(typeof info.archived === 'boolean' ? { archived: info.archived } : {}),
  };
}

export interface ListPageRequest {
  cwd?: string;
  cursor?: string;
  archived?: NativeArchiveFilter;
}

/** One page of `session/list`. The archive filter is sent only to agents that support archiving. */
export async function listSessionsPage(conn: AcpRequester, caps: any, req: ListPageRequest): Promise<{ sessions: NativeSessionView[]; nextCursor?: string }> {
  const support = sessionSupport(caps);
  need(support.list, SESSION_METHOD.list);
  const params: Record<string, unknown> = {};
  if (req.cwd) params.cwd = req.cwd;
  if (req.cursor) params.cursor = req.cursor;
  if (req.archived && req.archived !== 'exclude' && support.archive) params.archived = req.archived;
  const r = (await conn.request(SESSION_METHOD.list, params)) ?? {};
  const sessions = (Array.isArray(r.sessions) ? r.sessions : []).map(toNativeSessionView).filter(Boolean) as NativeSessionView[];
  const nextCursor = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined;
  return { sessions, ...(nextCursor ? { nextCursor } : {}) };
}

/** Follow `nextCursor` up to `maxPages` pages (a guard against an agent that never stops paging). */
export async function listAllSessions(conn: AcpRequester, caps: any, req: Omit<ListPageRequest, 'cursor'> & { maxPages?: number }): Promise<{ sessions: NativeSessionView[]; truncated: boolean }> {
  const out: NativeSessionView[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  const max = req.maxPages ?? 20;
  for (let page = 0; page < max; page++) {
    const r = await listSessionsPage(conn, caps, { ...req, cursor });
    for (const s of r.sessions) if (!seen.has(s.sessionId)) (seen.add(s.sessionId), out.push(s));
    if (!r.nextCursor || r.nextCursor === cursor) return { sessions: out, truncated: false };
    cursor = r.nextCursor;
  }
  return { sessions: out, truncated: true };
}

/** Run an agent-side side effect without letting it fail or stall the app's own action. */
export async function bestEffort(run: () => Promise<unknown>, timeoutMs = 4000): Promise<AcpSideEffect> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return 'done';
  } catch (e) {
    return e instanceof AcpUnsupportedError ? 'unsupported' : 'failed';
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ reattach planning

export type ReattachKind = 'resume' | 'load';

/**
 * How to reattach a chat to its saved agent session, best first. `session/resume` is cheaper (no replay), so it
 * wins for a chat that already shows its history; a chat with no items yet (an import) prefers `session/load`,
 * whose replay is the only way to show that history. `missing` (from `session/status`) skips straight to a new
 * session instead of a request that can only fail.
 */
export function reattachOrder(support: AcpSessionSupport, opts: { previous?: string; status?: SessionStatusView; wantHistory?: boolean } = {}): ReattachKind[] {
  if (!opts.previous || opts.status === 'missing') return [];
  const order: ReattachKind[] = [];
  if (opts.wantHistory && support.load) order.push('load');
  if (support.resume) order.push('resume');
  if (support.load && !order.includes('load')) order.push('load');
  return order;
}

// ------------------------------------------------------------------ fork

/** Items that are part of what the agent saw; anything after the fork point of these kinds rules a native fork out. */
const CONTEXT_KINDS = new Set<ThreadItem['kind']>(['user', 'agent', 'thought', 'tool', 'plan']);

/**
 * `session/fork` copies the whole agent session, so it is only right when the chat is forked at its end:
 * nothing the agent saw may come after the fork point. Forking from an earlier message keeps the text replay.
 */
export function canForkNatively(items: ThreadItem[], uptoItemId?: string): boolean {
  if (!uptoItemId) return true;
  const at = items.findIndex((i) => i.id === uptoItemId);
  if (at < 0) return false;
  return !items.slice(at + 1).some((i) => CONTEXT_KINDS.has(i.kind));
}

export interface ForkSource {
  agentId: AgentId;
  sessionId: string;
}

/**
 * A forked chat waits for its first agent session; this remembers which agent session it should fork from.
 * In memory only: after a restart the fork falls back to the text replay it always had.
 */
const forkSources = new Map<string, ForkSource>();
export const noteForkSource = (threadId: string, src: ForkSource) => void forkSources.set(threadId, src);
export function takeForkSource(threadId: string, agentId: AgentId): ForkSource | undefined {
  const src = forkSources.get(threadId);
  if (!src) return undefined;
  forkSources.delete(threadId);
  return src.agentId === agentId ? src : undefined;
}
export const peekForkSource = (threadId: string) => forkSources.get(threadId);

// ------------------------------------------------------------------ history replay

/** Claude's AIR marker: one `session_info_update` with `_meta.jetbrains.air.loadReplayEnd: true` after the replay. */
export function isReplayEndMarker(update: any): boolean {
  return update?.sessionUpdate === 'session_info_update' && update?._meta?.jetbrains?.air?.loadReplayEnd === true;
}

/**
 * Updates that describe the session's state rather than its history: they still reach the chat during a load
 * (commands for the `/` menu, the current mode and options, context usage, the title).
 */
const STATE_UPDATES = new Set(['available_commands_update', 'current_mode_update', 'config_option_update', 'usage_update', 'session_info_update']);

class ReplayCollector {
  updates: any[] = [];
  ended = false;
}

/** Open loads, by session id. `offer` returns true for an update that belongs to a replay (held back). */
export class ReplayGates {
  private open = new Map<string, ReplayCollector>();

  begin(sessionId: string): void {
    this.open.set(sessionId, new ReplayCollector());
  }

  isOpen(sessionId: string): boolean {
    return this.open.has(sessionId);
  }

  offer(sessionId: string | undefined, update: any): boolean {
    const c = sessionId ? this.open.get(sessionId) : undefined;
    if (!c) return false;
    if (isReplayEndMarker(update)) {
      c.ended = true;
      return true;
    }
    if (c.ended) return false; // live traffic after the marker, before the load answer
    if (STATE_UPDATES.has(String(update?.sessionUpdate))) return false;
    c.updates.push(update);
    return true;
  }

  /** Close the gate and hand over what it held. */
  end(sessionId: string): any[] {
    const c = this.open.get(sessionId);
    this.open.delete(sessionId);
    return c?.updates ?? [];
  }
}

/** The app-wide gates; `routeUpdate` asks them first. */
export const replayGates = new ReplayGates();

/** `session/load` with its replay captured. The gate is closed whether or not the load succeeds. */
export async function loadWithReplay(conn: AcpRequester, caps: any, p: SessionSetupParams, gates: ReplayGates = replayGates): Promise<{ response: any; updates: any[] }> {
  gates.begin(p.sessionId);
  try {
    const response = await loadSession(conn, caps, p);
    return { response, updates: gates.end(p.sessionId) };
  } catch (e) {
    gates.end(p.sessionId);
    throw e;
  }
}

/** How replayed content and tool calls become chat items; the app passes its own mappers (agents.ts). */
export interface ReplayMapper {
  text(content: any): string;
  toolContent(list: any[] | undefined): ToolContentView[];
  toolTitle(title: string | undefined, rawInput: any): string | undefined;
  toolSummary?(rawInput: any, content: ToolContentView[] | undefined, kind: string | undefined, status: string | undefined, title: string | undefined): string | undefined;
}

const plainText = (c: any): string => {
  if (!c) return '';
  if (c.type === 'text') return c.text ?? '';
  if (c.type === 'resource_link') return `[${c.name ?? c.uri}](${c.uri})`;
  if (c.type === 'image') return '[image]';
  return '';
};

export const DEFAULT_REPLAY_MAPPER: ReplayMapper = {
  text: plainText,
  toolContent: (list) =>
    (list ?? [])
      .filter((c: any) => c?.type !== 'session')
      .map((c: any): ToolContentView => {
        if (c.type === 'diff') return { type: 'diff', path: c.path, oldText: c.oldText ?? null, newText: c.newText ?? '' };
        if (c.type === 'content') return { type: 'text', text: plainText(c.content) };
        if (c.type === 'terminal') return { type: 'terminal', text: `terminal ${c.terminalId}` };
        return { type: 'other', text: JSON.stringify(c).slice(0, 2000) };
      }),
  toolTitle: (title) => title,
};

const FINISHED = new Set(['completed', 'failed']);
const PLAN_STATUS = new Set(['pending', 'in_progress', 'completed']);

/**
 * Turn a replay into chat items: message chunks join into one message (a new `messageId` starts a new one),
 * tool calls take their later updates, plans keep their last state. Tools still open at the end of a replay
 * belonged to a turn that ended long ago, so they show as interrupted.
 */
export function replayToItems(updates: any[], agentId: AgentId, opts: { mapper?: ReplayMapper; startTs?: number } = {}): ThreadItem[] {
  const m = opts.mapper ?? DEFAULT_REPLAY_MAPPER;
  const items: ThreadItem[] = [];
  const tools = new Map<string, Extract<ThreadItem, { kind: 'tool' }>>();
  let ts = opts.startTs ?? Date.now();
  const nextTs = () => ts++;
  let open: { kind: 'user' | 'agent' | 'thought'; messageId?: string; item: ThreadItem } | undefined;
  let plan: Extract<ThreadItem, { kind: 'plan' }> | undefined;

  for (const u of updates) {
    const kind = u?.sessionUpdate;
    const chatKind = kind === 'user_message_chunk' ? 'user' : kind === 'agent_message_chunk' || kind === 'agent_message' ? 'agent' : kind === 'agent_thought_chunk' || kind === 'agent_thought' ? 'thought' : undefined;
    if (chatKind) {
      const text = Array.isArray(u.content) ? u.content.map(m.text).filter(Boolean).join('\n') : m.text(u.content);
      if (!text) continue;
      const messageId = typeof u.messageId === 'string' ? u.messageId : undefined;
      const sameMessage = open && open.kind === chatKind && (!messageId || !open.messageId || messageId === open.messageId) && items[items.length - 1] === open.item;
      if (sameMessage && open && (open.item.kind === 'user' || open.item.kind === 'agent' || open.item.kind === 'thought')) {
        open.item.text += text;
        if (messageId) open.messageId = messageId;
      } else {
        const item = { kind: chatKind, id: randomUUID(), agentId, text, ts: nextTs() } as ThreadItem;
        items.push(item);
        open = { kind: chatKind, messageId, item };
      }
      continue;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = String(u.toolCallId ?? '');
      if (!id) continue;
      let item = tools.get(id);
      const content = u.content?.length ? m.toolContent(u.content) : undefined;
      if (!item) {
        if (kind === 'tool_call_update' && !u.title) continue; // an update for a call the replay never started
        item = {
          kind: 'tool',
          id: randomUUID(),
          agentId,
          toolCallId: id,
          title: m.toolTitle(u.title, u.rawInput) ?? 'Tool',
          summary: m.toolSummary?.(u.rawInput, content, u.kind, u.status, u.title),
          toolKind: u.kind,
          status: u.status ?? 'pending',
          content: content ?? [],
          locations: (u.locations ?? []).map((l: any) => l?.path).filter(Boolean),
          ts: nextTs(),
        };
        tools.set(id, item);
        items.push(item);
      } else {
        if (u.title) item.title = m.toolTitle(u.title, u.rawInput) ?? item.title;
        if (u.kind) item.toolKind = u.kind;
        if (u.status) item.status = u.status;
        if (content) item.content = content;
        if (u.locations?.length) item.locations = u.locations.map((l: any) => l?.path).filter(Boolean);
      }
      open = undefined;
      continue;
    }
    if (kind === 'plan') {
      const entries: PlanEntryView[] = (u.entries ?? []).map((e: any) => ({
        content: String(e?.content ?? ''),
        status: PLAN_STATUS.has(e?.status) ? e.status : 'pending',
        ...(e?.priority ? { priority: String(e.priority) } : {}),
      }));
      if (plan && items[items.length - 1] === plan) plan.entries = entries;
      else {
        plan = { kind: 'plan', id: randomUUID(), agentId, entries, ts: nextTs() };
        items.push(plan);
      }
      open = undefined;
      continue;
    }
    // Anything else (notices, compaction, sub-agent traffic, unknown) has no history item of its own yet.
  }
  for (const t of tools.values()) {
    if (!FINISHED.has(t.status)) t.status = 'interrupted';
    t.endedAt = t.ts;
  }
  return items;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Whether a replayed item is one the chat already shows. A replayed user message may carry more than the chat's
 * message (the app's context preamble, the attached-files list), so it only has to contain it; an agent message
 * the app saved mid-stream may be a prefix of the replayed one.
 */
function sameItem(existing: ThreadItem, replayed: ThreadItem): boolean {
  if (existing.kind !== replayed.kind) return false;
  switch (replayed.kind) {
    case 'tool':
      return existing.kind === 'tool' && existing.toolCallId === replayed.toolCallId;
    case 'user': {
      if (existing.kind !== 'user') return false;
      const e = norm(existing.text);
      const r = norm(replayed.text);
      return e ? r.includes(e) : !r;
    }
    case 'agent':
    case 'thought': {
      if (existing.kind !== replayed.kind) return false;
      const e = norm(existing.text);
      const r = norm(replayed.text);
      return Boolean(e) && (r === e || r.startsWith(e));
    }
    case 'plan':
      return existing.kind === 'plan' && JSON.stringify(existing.entries) === JSON.stringify(replayed.entries);
    default:
      return false;
  }
}

/**
 * The replayed items the chat does not show yet. Everything up to the last replayed item that matches one in
 * the chat is already there; only what follows it is new (work the agent did while the app was closed). An empty
 * chat (an import) takes the whole replay. A replay that matches nothing in a non-empty chat cannot be lined up
 * safely, so nothing is added: duplicates are worse than a gap the agent still has in its own context.
 */
export function mergeReplay(existing: ThreadItem[], replayed: ThreadItem[]): ThreadItem[] {
  const visible = existing.filter((i) => CONTEXT_KINDS.has(i.kind));
  if (!visible.length) return replayed;
  const toolIds = new Set(visible.flatMap((i) => (i.kind === 'tool' ? [i.toolCallId] : [])));
  const byKind = new Map<string, ThreadItem[]>();
  for (const i of visible) byKind.set(i.kind, [...(byKind.get(i.kind) ?? []), i]);
  const known = (r: ThreadItem) => (r.kind === 'tool' ? toolIds.has(r.toolCallId) : (byKind.get(r.kind) ?? []).some((e) => sameItem(e, r)));
  for (let at = replayed.length - 1; at >= 0; at--) {
    if (known(replayed[at])) return replayed.slice(at + 1);
  }
  return [];
}
