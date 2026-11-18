import {
  collectSubsessions,
  type AcpSessionSupport,
  type AcpSideEffect,
  type DeletableAgentSession,
  type DeleteChatTargets,
  type HomeSessionOptions,
  type NativeArchiveFilter,
  type NativeSessionPage,
} from '@shared/acpSessions';
import type { AgentId, ConfigOptionView, Project, Settings, Thread, ThreadMeta } from '@shared/types';
import {
  archiveSession,
  bestEffort,
  canForkNatively,
  closeSession,
  deleteSession,
  listSessionsPage,
  NO_SESSION_SUPPORT,
  noteForkSource,
  sessionOptions,
  sessionStatus,
  sessionSupport,
  setSessionTitle,
  type AcpRequester,
  type SessionStatusView,
} from './acpSessions';

/**
 * The app's side of the ACP session lifecycle: what the sidebar, the delete dialog, rename, fork and the new-chat
 * home screen ask for. Agent processes come from a host (agents.ts registers it); chats and settings from the
 * store. Both are injected, so this file never imports Electron and runs under plain Node in the unit tests.
 */

export interface AcpSessionHost {
  /** The agent's ACP connection and `agentCapabilities`. `start` starts its process when it is not running. */
  connection(agentId: AgentId, start: boolean): Promise<{ conn: AcpRequester; caps: any } | null>;
  /** The app's view of a setup answer's `modes` + `configOptions` (agents.ts's mapper). */
  configView(res: any): ConfigOptionView[];
}

export interface AcpSessionStore {
  getProject(id: string): Project | undefined;
  findThread(id: string): Thread | undefined;
  listThreads(projectId: string): ThreadMeta[];
  getThread(projectId: string, id: string): Thread | undefined;
  createThread(projectId: string, agentId: string, extra?: Partial<Thread>): Thread;
  forkThread(parent: Thread, uptoItemId?: string): Thread;
  saveThreadNow(t: Thread): void;
  threadMeta(t: Thread): ThreadMeta;
  flushThreads(): void;
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
}

export interface AcpSessionDeps {
  store: AcpSessionStore;
  /** Reattach a chat to its agent session (agents.ensureSession). */
  ensureSession(threadId: string): Promise<boolean>;
  /** The options the app last saw for this agent (agents.knownOptionsForAgent), for agents without `session/options`. */
  knownOptions(agentId: AgentId): ConfigOptionView[];
}

let deps: AcpSessionDeps | undefined;
let host: AcpSessionHost | undefined;

export const initAcpSessionService = (d: AcpSessionDeps) => void (deps = d);
/** Called by agents.ts once it can hand out connections. */
export const setAcpSessionHost = (h: AcpSessionHost) => void (host = h);

function need(): AcpSessionDeps {
  if (!deps) throw new Error('Agent sessions are not ready yet.');
  return deps;
}

async function connect(agentId: AgentId, start: boolean) {
  if (!host) return null;
  try {
    return await host.connection(agentId, start);
  } catch {
    return null;
  }
}

/** What this agent supports. Starts the agent when `start` (the import list needs a running agent anyway). */
export async function supportFor(agentId: AgentId, start = true): Promise<AcpSessionSupport> {
  const c = await connect(agentId, start);
  return c ? sessionSupport(c.caps) : NO_SESSION_SUPPORT;
}

function projectOrThrow(projectId: string): Project {
  const p = need().store.getProject(projectId);
  if (!p) throw new Error('Project not found.');
  return p;
}

/** Olympus chats of this project bound to a session of this agent, by session id. */
function boundChats(projectId: string, agentId: AgentId): Map<string, string> {
  const { store } = need();
  const out = new Map<string, string>();
  for (const meta of store.listThreads(projectId)) {
    const t = store.getThread(projectId, meta.id);
    const sid = t?.acpSessions?.[agentId];
    if (sid) out.set(sid, t!.id);
  }
  return out;
}

// ------------------------------------------------------------------ import from the agent

/** One page of the agent's own sessions in this project's folder, newest first as the agent sorts them. */
export async function listNative(projectId: string, agentId: AgentId, opts: { cursor?: string; archived?: NativeArchiveFilter } = {}): Promise<NativeSessionPage> {
  const project = projectOrThrow(projectId);
  const c = await connect(agentId, true);
  if (!c) throw new Error('The agent is not running. Check that it is installed and logged in.');
  const support = sessionSupport(c.caps);
  if (!support.list) return { agentId, support, sessions: [] };
  const page = await listSessionsPage(c.conn, c.caps, { cwd: project.path, cursor: opts.cursor, archived: opts.archived });
  const bound = boundChats(projectId, agentId);
  return {
    agentId,
    support,
    // `cwd` is a filter the agent applies; a session it still reports from elsewhere is not this project's.
    sessions: page.sessions.filter((s) => !s.cwd || s.cwd === project.path).map((s) => ({ ...s, ...(bound.has(s.sessionId) ? { threadId: bound.get(s.sessionId) } : {}) })),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

/**
 * Bring one of the agent's sessions into Olympus: a chat bound to that session id. Opening it reattaches with
 * `session/load` (its replay fills the chat) or `session/resume`. A session that is already a chat opens that chat.
 */
export async function importNative(projectId: string, agentId: AgentId, session: { sessionId: string; title?: string; archived?: boolean }): Promise<ThreadMeta> {
  const { store } = need();
  projectOrThrow(projectId);
  const existing = boundChats(projectId, agentId).get(session.sessionId);
  if (existing) {
    const t = store.findThread(existing);
    if (t) return store.threadMeta(t);
  }
  // An archived session is unarchived first: the spec asks clients to do so before loading or resuming one.
  if (session.archived) {
    const c = await connect(agentId, true);
    if (c && sessionSupport(c.caps).archive) await archiveSession(c.conn, c.caps, session.sessionId, false).catch(() => {});
  }
  const title = (session.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 70) || 'Imported session';
  const t = store.createThread(projectId, agentId, { title, acpSessions: { [agentId]: session.sessionId } });
  void deps!.ensureSession(t.id).catch(() => {});
  return store.threadMeta(t);
}

export async function setNativeArchived(agentId: AgentId, sessionId: string, archived: boolean): Promise<AcpSideEffect> {
  const c = await connect(agentId, true);
  if (!c) return 'not-running';
  if (!sessionSupport(c.caps).archive) return 'unsupported';
  return bestEffort(() => archiveSession(c.conn, c.caps, sessionId, archived), 15_000);
}

/** Delete one of the agent's own sessions (the import list's delete). Only on an explicit user action. */
export async function deleteNative(agentId: AgentId, sessionId: string): Promise<AcpSideEffect> {
  const c = await connect(agentId, true);
  if (!c) return 'not-running';
  if (!sessionSupport(c.caps).delete) return 'unsupported';
  return bestEffort(() => deleteSession(c.conn, c.caps, sessionId), 15_000);
}

// ------------------------------------------------------------------ chat delete / close

/**
 * User-visible sub-sessions (`!nativeSubagent`) under `threadId` in the project tree (workers, forks, second
 * opinions, and nested forks), ordered leaves-first so children are deleted before their parent.
 */
export function subsessionsOf(threadId: string): ThreadMeta[] {
  const { store } = need();
  const root = store.findThread(threadId);
  if (!root) return [];
  return collectSubsessions(store.listThreads(root.projectId), threadId);
}

/**
 * The agent sessions behind a chat, for the delete dialog. `canDelete` is known only for agents running now
 * (`undefined` = not running, the dialog still offers it and the delete starts the agent).
 */
export async function deletableSessions(threadId: string): Promise<(DeletableAgentSession & { canDelete?: boolean })[]> {
  const t = need().store.findThread(threadId);
  if (!t) return [];
  const out: (DeletableAgentSession & { canDelete?: boolean })[] = [];
  for (const [agentId, sessionId] of Object.entries(t.acpSessions ?? {})) {
    if (!sessionId) continue;
    const c = await connect(agentId, false);
    out.push({ agentId, sessionId, ...(c ? { canDelete: sessionSupport(c.caps).delete } : {}) });
  }
  return out.filter((s) => s.canDelete !== false);
}

/**
 * Everything `DeleteChatDialog` needs for a chat: its own deletable agent IDs, its user-visible sub-sessions,
 * and the union of deletable agent IDs when sub-sessions are deleted alongside the parent.
 */
export async function deleteTargets(threadId: string): Promise<DeleteChatTargets> {
  const subs = subsessionsOf(threadId);
  const own = await deletableSessions(threadId);
  const ownAgents = [...new Set(own.map((s) => s.agentId))];
  if (!subs.length) return { ownAgents, subsessions: [], allAgents: ownAgents };
  const allSet = new Set<AgentId>(ownAgents);
  for (const sub of subs) {
    for (const s of await deletableSessions(sub.id)) allSet.add(s.agentId);
  }
  return {
    ownAgents,
    subsessions: subs.map((s) => ({ id: s.id, title: s.title })),
    allAgents: [...allSet],
  };
}

/** Release the agent side of a chat: `session/close` on every agent that is running and supports it. */
export async function closeChatSessions(threadId: string): Promise<Record<AgentId, AcpSideEffect>> {
  const t = deps?.store.findThread(threadId);
  const out: Record<AgentId, AcpSideEffect> = {};
  for (const [agentId, sessionId] of Object.entries(t?.acpSessions ?? {})) {
    if (!sessionId) continue;
    const c = await connect(agentId, false);
    out[agentId] = !c ? 'not-running' : sessionSupport(c.caps).close ? await bestEffort(() => closeSession(c.conn, c.caps, sessionId)) : 'unsupported';
  }
  return out;
}

/**
 * Before one or more chats are deleted: with `alsoAgentSessions` (the user ticked the box) each agent deletes its
 * own saved sessions; otherwise the sessions are only closed, so the agent can still list and resume them.
 * Deduplicates `(agentId, sessionId)` pairs and preserves any non-`'done'` outcome per agent.
 */
export async function beforeDeleteChats(threadIds: readonly string[], alsoAgentSessions: boolean): Promise<Record<AgentId, AcpSideEffect>> {
  const out: Record<AgentId, AcpSideEffect> = {};
  const seenPairs = new Set<string>();
  const record = (agentId: AgentId, effect: AcpSideEffect) => {
    const prev = out[agentId];
    if (!prev || prev === 'done') out[agentId] = effect;
  };
  for (const threadId of threadIds) {
    const t = (alsoAgentSessions ? need().store : deps?.store)?.findThread(threadId);
    for (const [agentId, sessionId] of Object.entries(t?.acpSessions ?? {})) {
      if (!sessionId) continue;
      const key = `${agentId}\0${sessionId}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      if (!alsoAgentSessions) {
        const c = await connect(agentId, false);
        record(agentId, !c ? 'not-running' : sessionSupport(c.caps).close ? await bestEffort(() => closeSession(c.conn, c.caps, sessionId)) : 'unsupported');
        continue;
      }
      const effect = await deleteNative(agentId, sessionId);
      record(agentId, effect);
      if (effect === 'unsupported') {
        // Still release it: an agent that cannot delete may at least close.
        const c = await connect(agentId, false);
        if (c && sessionSupport(c.caps).close) await bestEffort(() => closeSession(c.conn, c.caps, sessionId));
      }
    }
  }
  return out;
}

/**
 * Before a single chat is deleted: closes or deletes its saved agent sessions.
 */
export async function beforeDeleteChat(threadId: string, alsoAgentSessions: boolean): Promise<Record<AgentId, AcpSideEffect>> {
  return beforeDeleteChats([threadId], alsoAgentSessions);
}

// ------------------------------------------------------------------ rename / fork / status

/**
 * After a chat is renamed: tell every running agent bound to it (`session/set_title`), so its own session list
 * shows the same name. Returns the title the chat's current agent stored (it may normalize it), else the input.
 */
export async function syncTitle(threadId: string, title: string): Promise<{ title: string; results: Record<AgentId, AcpSideEffect> }> {
  const t = need().store.findThread(threadId);
  const results: Record<AgentId, AcpSideEffect> = {};
  let stored = title;
  for (const [agentId, sessionId] of Object.entries(t?.acpSessions ?? {})) {
    if (!sessionId) continue;
    const c = await connect(agentId, false);
    if (!c) {
      results[agentId] = 'not-running';
      continue;
    }
    if (!sessionSupport(c.caps).setTitle) {
      results[agentId] = 'unsupported';
      continue;
    }
    results[agentId] = await bestEffort(async () => {
      const got = await setSessionTitle(c.conn, c.caps, sessionId, title);
      if (agentId === t!.agentId && got.trim()) stored = got;
    });
  }
  if (t && stored !== title) {
    t.title = stored;
    need().store.saveThreadNow(t);
  }
  return { title: stored, results };
}

/**
 * Fork a chat. The copy of its messages is made as before; when the fork is at the end of the chat and the agent
 * session behind it is known, the new chat's first session forks that agent session (`session/fork`, at session
 * start in agents.ts), so the model keeps its real context instead of a text replay.
 */
export function forkChat(parentId: string, uptoItemId?: string): { meta: ThreadMeta; nativeFork: boolean } {
  const { store } = need();
  const parent = store.findThread(parentId);
  if (!parent) throw new Error('Chat not found.');
  store.flushThreads();
  const child = store.forkThread(parent, uptoItemId);
  const source = parent.acpSessions?.[parent.agentId];
  const nativeFork = Boolean(source) && canForkNatively(parent.items, uptoItemId);
  if (nativeFork) noteForkSource(child.id, { agentId: parent.agentId, sessionId: source! });
  return { meta: store.threadMeta(child), nativeFork };
}

/** `session/status` of the chat's current agent session, without starting the agent. */
export async function chatSessionStatus(threadId: string): Promise<{ agentId: AgentId; sessionId?: string; status: SessionStatusView }> {
  const t = need().store.findThread(threadId);
  if (!t) throw new Error('Chat not found.');
  const sessionId = t.acpSessions?.[t.agentId];
  if (!sessionId) return { agentId: t.agentId, status: 'unknown' };
  const c = await connect(t.agentId, false);
  return { agentId: t.agentId, sessionId, status: c ? await sessionStatus(c.conn, c.caps, sessionId) : 'unknown' };
}

// ------------------------------------------------------------------ new-chat home screen

/** The user's saved choices for this agent's new chats, laid over the options a new session would start with. */
function withDefaults(agentId: AgentId, options: ConfigOptionView[]): ConfigOptionView[] {
  const saved = need().store.getSettings().agentDefaults?.[agentId] ?? {};
  return options.map((o) => {
    const v = saved[o.id];
    return v !== undefined && v !== o.currentValue && o.options.some((x) => x.value === v) ? { ...o, currentValue: v } : o;
  });
}

/**
 * The model / mode / setting pills of the home screen, before any session exists: `session/options` when the
 * agent supports it, else the options the app last saw for this agent. Either way the saved defaults show.
 */
export async function homeOptions(projectId: string, agentId: AgentId): Promise<HomeSessionOptions> {
  const project = projectOrThrow(projectId);
  const fallback = () => withDefaults(agentId, need().knownOptions(agentId));
  const c = await connect(agentId, true);
  if (!c || !host) return { agentId, supported: false, configOptions: fallback() };
  if (!sessionSupport(c.caps).options) return { agentId, supported: false, configOptions: fallback() };
  try {
    const res = await sessionOptions(c.conn, c.caps, { cwd: project.path });
    return { agentId, supported: true, configOptions: withDefaults(agentId, host.configView(res)) };
  } catch (e: any) {
    return { agentId, supported: true, configOptions: fallback(), error: e?.message ?? String(e) };
  }
}

/** A pill changed on the home screen: it becomes this agent's default, which every new session starts with. */
export function setHomeOption(agentId: AgentId, configId: string, value: string): Settings {
  const { store } = need();
  const all = store.getSettings().agentDefaults ?? {};
  return store.updateSettings({ agentDefaults: { ...all, [agentId]: { ...(all[agentId] ?? {}), [configId]: value } } });
}
