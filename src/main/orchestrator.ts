import { app } from 'electron';
import { NOTE_SECTIONS, addNote } from './usernotes';
import { dropWakes, parseTimerArgs, setTimer, setTimerToolDef } from './agenttimers';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { DeskEvents, SubTaskView, Thread, ThreadItem } from '@shared/types';
import { isModelUnavailableMessage, isQuotaErrorText, isQuotaMessage } from '@shared/quota';
import { workspaceProjectId } from '@shared/worktree';
import { startChatWorktree } from './worktreeChats';
import {
  agentStatuses,
  configureSession,
  forgetThread,
  recordOlympusCall,
  cancel,
  ensureSession,
  inheritSettings,
  preferReadOnlyMode,
  runState,
  sendPrompt,
  sessionView,
  canSteer,
  setTurnEndListener,
} from './agents';
import { agentName, canLearnAboutUser, canOrchestrate, sessionRole, threadFilePath } from './guide';
import { isMuted, muteChat, notifyAgent, steerAgent, unmuteChat } from './appmsg';
import {
  ToolError,
  assertAgentQuotaAvailable,
  extractConfigRequest,
  fallbackAgentsSummary,
  formatAgentCatalog,
  hasConfigOverrides,
  reconfigureSubsession,
} from './orchestratorAgents';
import { listSchedules } from './schedules';
import { canManageSchedules, handleScheduleTool, scheduleToolDefs } from './scheduleTools';
import { agentToolDefs, canManageAgents, handleAgentTool } from './agentTools';
import { canManageProjects, handleProjectTool, projectToolDefs } from './projectTools';
import { browserToolDefs, handleBrowserTool } from './browserTools';
import { agySubagentSummary, discoverAgySubagents } from './agySubagents';
import { claudeSubagentSummary, discoverClaudeSubagents } from './claudeSubagents';
import { nativeSubagentSummary } from './nativeSubagents';
import { createThread, deleteThread, findThread, getProject, getSettings, listThreads, threadMeta } from './store';
import { openTerminal, readTerminal, terminalProject } from './terminals';
import { listSaved, runSaved, saveCommand } from './savedCommands';
import { statusText } from '@shared/savedCommands';
import { acpMcp, mcpStatus } from './acpConfigService';
import { lastTaskIndex, resultItem } from './subtaskOutcome';
import { DisposableTracker } from './disposableSubsessions';
import { LIVE_STATES, buildResultMessage, decideDelivery, doneKey, pickFresh, type FinishedInfo } from './subsessionNotify';

/**
 * Orchestration: the main session's agent spawns and steers sub-sessions through the `olympus` MCP server.
 *
 * The server runs inside the app on 127.0.0.1 (Streamable HTTP, plain JSON responses). Every chat gets its own
 * random URL token, so a call always knows which session made it. Agents that speak MCP over HTTP (Claude Code,
 * Codex) connect directly; the rest (e.g. Antigravity) get a tiny stdio bridge script that forwards each line.
 */

type Emit = <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => void;
let emit: Emit = () => {};
/** Called once from index.ts, after every module has loaded (agents.ts and this file import each other). */
export function initOrchestrator(fn: Emit) {
  emit = fn;
  setTurnEndListener((threadId) => {
    const t = findThread(threadId);
    if (!t) return;
    // A sub-session finished (tell its parent), or this session's own turn ended (results that waited for it go now).
    // Both, so a sub-session that has sub-sessions of its own is told the same way.
    setTimeout(() => {
      if (t.spawnedBy) maybeWake(t.spawnedBy);
      maybeWake(t.id);
      void cleanupDisposable(t.id);
    }, 400);
  });
}

// ------------------------------------------------------------------ sub-session state

/** Spawned, but its first message has not gone out yet. */
const starting = new Set<string>();
/** Stopped with cancel_subsession, until it gets a new message. */
const cancelled = new Set<string>();

const isActive = (id: string) => starting.has(id) || runState(id).running;

/** Disposable sub-sessions whose final report the parent has read (src/main/disposableSubsessions.ts). */
const disposables = new DisposableTracker();

/** The parent read these finished reports: once its turn is over (now, if it has none running), they go. */
function reportsRead(parent: Thread, views: SubTaskView[]) {
  for (const v of views) if (!LIVE_STATES.has(v.status)) disposables.markRead({ id: v.meta.id, disposable: v.meta.disposable, status: v.status, key: doneKey(v) });
  if (disposables.size && !isActive(parent.id)) setTimeout(() => void cleanupDisposable(parent.id), 400);
}

/** Deletes the parent's finished, read, disposable sub-sessions; only between the parent's turns. */
async function cleanupDisposable(parentId: string) {
  if (!disposables.size || isActive(parentId)) return;
  const parent = findThread(parentId);
  if (!parent) return;
  const due = disposables.due(
    childrenOf(parent, true).map((k) => {
      const v = summarize(k);
      return { id: k.id, disposable: k.disposable, status: v.status, key: doneKey(v), active: isActive(k.id) };
    }),
  );
  for (const id of due) {
    disposables.forget(id);
    cancelled.delete(id);
    await deleteChat(id).catch(() => {});
  }
}

/**
 * Telling the parent: the moment a sub-session finishes, the app sends its parent session the result (status, agent,
 * time, changed files, the report up to ~1,500 characters, and which ones still run; src/main/subsessionNotify.ts).
 * Idle parent: a new turn. Busy parent whose agent takes mid-turn input: into the running turn. Otherwise at the end
 * of its turn, unless it read the result itself by then. Results it already read (wait_for_subsessions,
 * get_subsession) and the targets of a wait_for_subsessions call it is inside are never sent; each result goes once.
 * Settings → General "Tell the main session when a sub-session finishes" (`notifyParentOnSubsessionEnd`, default on).
 */
const seen = new Set<string>();
const sent = new Set<string>();
const APP_STARTED = Date.now();
/** Parent id → sub-session id → how many wait_for_subsessions calls of that parent wait for it right now. */
const waiting = new Map<string, Map<string, number>>();

function waitStarted(parentId: string, ids: string[]) {
  const m = waiting.get(parentId) ?? new Map<string, number>();
  for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1);
  waiting.set(parentId, m);
}
function waitEnded(parentId: string, ids: string[]) {
  const m = waiting.get(parentId);
  if (!m) return;
  for (const id of ids) {
    const n = (m.get(id) ?? 1) - 1;
    if (n > 0) m.set(id, n);
    else m.delete(id);
  }
  if (!m.size) waiting.delete(parentId);
}

/** The user pressed Stop / wrote a message: automatic messages pause / resume (see appmsg.ts). */
export function userCancelled(threadId: string) {
  muteChat(threadId);
  dropWakes(threadId);
}
export function userSent(threadId: string) {
  unmuteChat(threadId);
}

/** Releases in-memory orchestrator tracking when a chat or sub-session is deleted. */
export function forgetOrchestratorThread(threadId: string) {
  dropWakes(threadId);
  starting.delete(threadId);
  cancelled.delete(threadId);
  disposables.forget(threadId);
  waiting.delete(threadId);
  for (const [parentId, m] of waiting) {
    m.delete(threadId);
    if (!m.size) waiting.delete(parentId);
  }
}

/** The model a sub-session runs on: its model setting, else what its last reply reported. */
function modelOf(t: Thread): string | undefined {
  const sv = sessionView(t.id);
  const opt = sv.configOptions.find((o) => o.category === 'model' || o.id === 'model');
  const name = opt ? (opt.options.find((o) => o.value === opt.currentValue)?.name ?? opt.currentValue) : undefined;
  if (name) return name;
  for (let i = t.items.length - 1; i >= 0; i--) {
    const it = t.items[i];
    if (it.kind === 'agent' && it.usage?.model) return it.usage.model;
  }
  return sv.usage?.model;
}

function finishedInfo(t: Thread, v: SubTaskView): FinishedInfo {
  const task = t.items[lastTaskIndex(t.items)];
  const blocked = v.status === 'quota-exceeded' || v.status === 'needs-login';
  const errorLike = v.status === 'failed' || blocked;
  return {
    id: t.id,
    title: t.title,
    status: v.status,
    agent: agentName(t.agentId),
    model: modelOf(t),
    durationMs: task && v.endedAt ? v.endedAt - task.ts : undefined,
    files: v.filesTouched,
    report: errorLike ? (v.error ?? v.lastReply) : v.lastReply,
    fallback: blocked ? fallbackAgentsSummary(t.agentId) : undefined,
  };
}

function maybeWake(parentId: string) {
  if (getSettings().notifyParentOnSubsessionEnd === false) return;
  const parent = findThread(parentId);
  if (!parent) return;
  const route = decideDelivery({ busy: isActive(parentId), canSteer: canSteer(parentId), muted: isMuted(parentId) });
  if (route === 'none' || route === 'later') return;
  const kids = childrenOf(parent, true);
  if (!kids.length) return;
  // The whole reply (not the usual 600 characters), so the message can tell whether it carried all of it.
  const views = kids.map((k) => summarize(k, 1_000_000));
  const fresh = pickFresh(views, { seen, sent, waitingFor: new Set(waiting.get(parentId)?.keys() ?? []), appStarted: APP_STARTED });
  if (!fresh.length) return;
  for (const v of fresh) sent.add(doneKey(v));
  const running = views.filter((v) => LIVE_STATES.has(v.status)).map((v) => ({ id: v.meta.id, title: v.meta.title }));
  const { text, fullReport } = buildResultMessage(
    fresh.map((v) => finishedInfo(kids.find((k) => k.id === v.meta.id)!, v)),
    running,
  );
  // Counts as read only once the parent's agent really got it: a disposable one goes after that turn, never before.
  const delivered = () => {
    const whole = fresh.filter((v) => fullReport.includes(v.meta.id));
    for (const v of whole) seen.add(doneKey(v));
    reportsRead(parent, whole);
  };
  if (route === 'turn') return notifyAgent(parentId, text, delivered);
  void steerAgent(parentId, text).then((ok) => {
    if (ok) return delivered();
    // Not taken into the turn (it just ended, or the agent refused): give them back to the normal path.
    for (const v of fresh) sent.delete(doneKey(v));
    if (!isActive(parentId)) maybeWake(parentId);
  });
}

/** Sub-sessions of a session: the ones it spawned, and (unless `spawnedOnly`) the user's forks of it. */
export function childrenOf(parent: Pick<Thread, 'id' | 'projectId'>, spawnedOnly = false): Thread[] {
  return listThreads(parent.projectId)
    .filter((m) => (spawnedOnly ? m.spawnedBy === parent.id : m.parentId === parent.id))
    .map((m) => findThread(m.id))
    .filter((t): t is Thread => Boolean(t))
    .sort((a, b) => a.createdAt - b.createdAt);
}

const EDIT_KINDS = new Set(['edit', 'delete', 'move']);

export function summarize(t: Thread, replyMax = 600): SubTaskView {
  const rs = runState(t.id);
  const nat = t.nativeSubagent ? (nativeSubagentSummary(t.id) ?? agySubagentSummary(t.id) ?? claudeSubagentSummary(t.id)) : undefined;
  const items = t.items;
  // The last real task message. Turns the agent opened by itself (background results, context compaction) and
  // user messages echoed from the agent's own session don't start a new task.
  const lastUser = lastTaskIndex(items);
  const after = items.slice(lastUser + 1);
  const lastAgentIdx = after.map((i) => i.kind).lastIndexOf('agent');
  const lastErrIdx = after.map((i) => i.kind).lastIndexOf('error');
  const lastAgent = lastAgentIdx >= 0 ? (after[lastAgentIdx] as Extract<ThreadItem, { kind: 'agent' }>) : undefined;
  const lastErr = lastErrIdx >= 0 ? (after[lastErrIdx] as Extract<ThreadItem, { kind: 'error' }>) : undefined;
  const tools = items.filter((i): i is Extract<ThreadItem, { kind: 'tool' }> => i.kind === 'tool');
  const files = [...new Set(tools.filter((x) => EDIT_KINDS.has(x.toolKind ?? '') || x.content.some((c) => c.type === 'diff')).flatMap((x) => [...x.locations, ...x.content.filter((c) => c.type === 'diff' && c.path).map((c) => c.path!)]))];
  // Permission requests and questions from the agent both block it until the user answers.
  const pendingPerm = items.filter((i) => (i.kind === 'permission' || i.kind === 'elicitation') && !i.resolved);

  let status: SubTaskView['status'];
  if (t.nativeSubagent && (pendingPerm.length || rs.pendingPermissions)) status = 'waiting-permission';
  else if (nat?.status) status = nat.status;
  else if (starting.has(t.id)) status = 'starting';
  else if (rs.running) status = pendingPerm.length || rs.pendingPermissions ? 'waiting-permission' : 'running';
  else if (rs.status === 'needs-login') status = 'needs-login';
  else if (cancelled.has(t.id)) status = 'cancelled';
  else if (lastErr && lastErrIdx > lastAgentIdx) status = isQuotaErrorText(lastErr.text) ? 'quota-exceeded' : 'failed';
  else if (lastAgent || (t.nativeSubagent && tools.length > 0))
    status = lastAgent && isQuotaMessage(lastAgent.text) ? 'quota-exceeded' : lastAgent && isModelUnavailableMessage(lastAgent.text) ? 'failed' : 'done';
  else status = 'idle';

  let activity: string | undefined;
  if (status === 'running' || status === 'starting' || status === 'waiting-permission') {
    const plan = [...items].reverse().find((i) => i.kind === 'plan');
    const step = plan?.kind === 'plan' && !plan.removed ? plan.entries.find((e) => e.status === 'in_progress')?.content : undefined;
    const last = after[after.length - 1];
    if (status === 'waiting-permission') {
      const p = pendingPerm[pendingPerm.length - 1];
      activity = p?.kind === 'elicitation' ? `Waiting for your answer: ${p.message.replace(/\s+/g, ' ').slice(0, 120)}` : `Waiting for your permission: ${p?.kind === 'permission' ? p.title : 'a tool call'}`;
    }
    else if (last?.kind === 'tool') activity = last.summary && last.summary !== last.title ? `${last.summary} · ${last.title.split('\n')[0].slice(0, 90)}` : last.title.split('\n')[0].slice(0, 140);
    else if (last?.kind === 'thought') activity = `Thinking: ${last.text.replace(/\s+/g, ' ').trim().slice(-110)}`;
    else if (last?.kind === 'agent') activity = 'Writing response…';
    else activity = step ?? (status === 'starting' ? 'Starting…' : 'Working…');
    if (step && status !== 'waiting-permission') activity = `${step} — ${activity}`;
  }
  const firstUser = items.find((i) => i.kind === 'user');
  const reply = lastAgent?.text.trim();
  const quotaOrErrText = lastErr && lastErrIdx > lastAgentIdx ? lastErr.text : lastAgent?.text;
  const liveNow = status === 'running' || status === 'starting' || status === 'waiting-permission';
  // The outcome to report: the latest error or reply of this task, so later maintenance turns don't count as news.
  const result = resultItem(items);
  return {
    meta: threadMeta(t),
    status,
    activity,
    lastReply: reply ? (reply.length > replyMax ? `${reply.slice(0, replyMax)}…` : reply) : undefined,
    error: status === 'failed' ? (nat?.error ?? lastErr?.text ?? lastAgent?.text) : status === 'quota-exceeded' ? quotaOrErrText : rs.error,
    filesTouched: files,
    toolCount: tools.length,
    pendingPermissions: pendingPerm.length,
    canCancel: nat?.canCancel,
    startedAt: firstUser?.ts ?? nat?.startedAt ?? (t.nativeSubagent ? t.createdAt : undefined),
    endedAt: !liveNow ? (nat?.endedAt ?? result?.ts ?? (items.length ? items[items.length - 1].ts : undefined)) : undefined,
    resultId: liveNow ? undefined : nat?.endedAt ? `${status}@${nat.endedAt}` : `${status}@${result?.id ?? ''}`,
  };
}

/** For the Tasks panel. */
export function listTasks(threadId: string): { parent?: SubTaskView; children: SubTaskView[] } {
  const t = findThread(threadId);
  if (!t) return { children: [] };
  discoverAgySubagents(t); // Antigravity's own sub-agents, also ones from before an app restart
  discoverClaudeSubagents(t); // Claude Code's on-disk sub-agents and workflow children
  const parent = t.parentId ? findThread(t.parentId) : undefined;
  return { parent: parent ? summarize(parent) : undefined, children: childrenOf(t).map((c) => summarize(c)) };
}

// ------------------------------------------------------------------ tools

const fmtDur = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

export function describe(v: SubTaskView, full: boolean, replyMax = 8000): string {
  const kind = `${v.meta.spawnedBy ? ` · ${v.meta.disposable ? 'disposable' : 'kept'}` : ''}${v.meta.worktree ? ` · worktree ${v.meta.worktree.branch}` : ''}`;
  const lines = [`### ${v.meta.title} — ${v.status}`, `id: ${v.meta.id} · agent: ${agentName(v.meta.agentId)}${kind}`];
  const dur = v.startedAt ? fmtDur((v.endedAt ?? Date.now()) - v.startedAt) : undefined;
  lines.push([dur && `time: ${dur}`, `${v.toolCount} tool calls`, v.filesTouched.length ? `files changed: ${v.filesTouched.join(', ')}` : 'no file edits'].filter(Boolean).join(' · '));
  if (v.activity) lines.push(`now: ${v.activity}`);
  if (v.status === 'waiting-permission') lines.push(`The user must approve this in the Tasks panel (or in the sub-session) before it can continue.`);
  if (v.error) lines.push(`error: ${v.error}`);
  if (v.status === 'quota-exceeded' || v.status === 'needs-login') {
    lines.push(`fallback: ${fallbackAgentsSummary(v.meta.agentId)} Switch this sub-session in place (preserving its context) via configure_subsession or message_subsession with "agent"/"model".`);
  }
  if (full && v.lastReply) {
    const truncated = v.lastReply.length > replyMax;
    lines.push(`report:\n${v.lastReply}${truncated ? `\n(Report truncated at ${replyMax} chars — read the full reply in ${threadFilePath(v.meta)})` : ''}`);
  }
  return lines.join('\n');
}

function steps(t: Thread, n = 20): string {
  const out: string[] = [];
  for (const i of t.items.slice(-n * 2)) {
    if (i.kind === 'tool') out.push(`- [${i.status}] ${i.title}${i.locations.length ? ` (${i.locations.join(', ')})` : ''}`);
    else if (i.kind === 'agent') out.push(`- said: ${i.text.replace(/\s+/g, ' ').slice(0, 200)}`);
    else if (i.kind === 'error') out.push(`- error: ${i.text.slice(0, 300)}`);
    else if (i.kind === 'permission') out.push(`- permission ${i.resolved ? `(${i.resolved})` : '(waiting)'}: ${i.title}`);
    else if (i.kind === 'elicitation') out.push(`- question ${i.resolved ? `(${i.resolved})` : '(waiting for the user)'}: ${i.message.replace(/\s+/g, ' ').slice(0, 200)}`);
    else if (i.kind === 'user') out.push(`- ${i.fromAgent ? 'orchestrator' : i.fromApp ? 'app' : 'user'}: ${i.text.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  return out.slice(-n).join('\n');
}

function ownChild(parent: Thread, id: unknown): Thread {
  const c = typeof id === 'string' ? findThread(id) : undefined;
  if (!c || c.spawnedBy !== parent.id) throw new ToolError(`No sub-session with id "${id}" was spawned by this session. Call session_info to see the ids.`);
  return c;
}

function sessionInfo(t: Thread): string {
  const project = getProject(workspaceProjectId(t)) ?? getProject(t.projectId);
  const parent = t.parentId ? findThread(t.parentId) : undefined;
  const o = getSettings().orchestrator;
  const role = sessionRole(t);
  const roleLabel =
    role === 'main'
      ? canOrchestrate(t)
        ? 'main session (orchestrator)'
        : 'main session'
      : role === 'worker'
        ? 'sub-session (worker)'
        : role === 'second-opinion'
          ? 'sub-session (second opinion, read-only)'
          : 'sub-session (fork)';
  const lines = [
    `Session: ${t.id}`,
    `Title: ${t.title}`,
    `Agent: ${agentName(t.agentId)}`,
    `Role: ${roleLabel}`,
    `Project: ${project?.name ?? t.projectId} — ${project?.path ?? ''}`,
    ...(t.worktree ? [`Worktree: branch ${t.worktree.branch} (from ${t.worktree.baseBranch})`] : []),
    `Transcript: ${threadFilePath(t)}`,
  ];
  if (parent) lines.push(`Parent session: ${parent.id} — "${parent.title}" (${agentName(parent.agentId)}), transcript ${threadFilePath(parent)}`);
  if (t.task) lines.push(`Task given by the orchestrator:\n${t.task}`);
  if (canOrchestrate(t)) {
    const kids = childrenOf(t, true);
    lines.push(`Orchestration: on — at most ${o.maxParallel} running at once, ${o.maxPerSession} per session (${kids.length} used, ${kids.filter((k) => isActive(k.id)).length} running).`);
  }
  if (canManageSchedules(t)) {
    const projSchedules = listSchedules().filter((s) => s.projectId === t.projectId);
    if (projSchedules.length) {
      lines.push(`Scheduled tasks in this project: ${projSchedules.length} (${projSchedules.filter((s) => s.enabled).length} active — call list_schedules for details).`);
    }
  }
  const kids = childrenOf(t).map((c) => summarize(c));
  lines.push(kids.length ? `\nSub-sessions:\n\n${kids.map((k) => describe(k, false)).join('\n\n')}` : `\nSub-sessions: none`);
  return lines.join('\n');
}

/**
 * Second opinion: the same question, asked of other agents in parallel. Each gets the conversation up to that
 * message in a sub-session of its own, set to read-only where the agent has such a mode, and is told not to
 * change files, so several agents never edit the same files at once. Their answers show in the Tasks panel.
 */
export async function secondOpinion(parentId: string, itemId: string, agentIds: string[]): Promise<string[]> {
  const parent = findThread(parentId);
  if (!parent) throw new Error('Chat not found.');
  const at = parent.items.findIndex((i) => i.id === itemId);
  const item = parent.items[at];
  if (!item || item.kind !== 'user') throw new Error('Pick one of your messages.');
  const { defs, statuses } = agentStatuses();
  const history = structuredClone(parent.items.slice(0, at)).filter((i: ThreadItem) => !((i.kind === 'permission' || i.kind === 'elicitation') && !i.resolved));
  const question = [
    'Second opinion. The question below is also being worked on elsewhere in this project, so:',
    "- Don't change any files and don't run commands that change anything. Read and investigate only.",
    '- Then reply with: (1) the cause, in a few sentences; (2) the fix, as exact changes with file paths (a unified diff or before / after snippets); (3) how sure you are and how to check it.',
    '',
    'The question:',
    item.text,
  ].join('\n');
  const ids: string[] = [];
  for (const agentId of agentIds) {
    const def = defs.find((d) => d.id === agentId);
    const st = statuses.find((s) => s.id === agentId)?.state;
    if (!def || st === 'not-installed' || st === 'needs-login') continue;
    const child = createThread(parent.projectId, agentId, {
      title: `Second opinion · ${def.name}`,
      parentId: parent.id,
      secondOpinion: true,
      task: item.text,
      mode: parent.mode ?? 'code',
      items: history.map((i: ThreadItem) => ({ ...i, id: randomUUID() })),
    });
    emit('thread:meta', threadMeta(child));
    ids.push(child.id);
    void (async () => {
      try {
        if (await ensureSession(child.id)) await preferReadOnlyMode(child.id);
      } catch {
        /* sendPrompt reports a failure in the sub-session */
      }
      await sendPrompt(child.id, question, item.attachments ?? [], { fromApp: true }).catch(() => {});
    })();
  }
  if (!ids.length) throw new Error('None of those agents is ready (installed and logged in).');
  return ids;
}

async function spawn(parent: Thread, args: any): Promise<string> {
  if (!canOrchestrate(parent)) throw new ToolError(sessionRole(parent) === 'main' ? 'Orchestration is turned off in Settings.' : 'Sub-sessions cannot spawn further sub-sessions.');
  const title = String(args?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 70);
  const task = String(args?.task ?? '').trim();
  if (!title || !task) throw new ToolError('Both "title" and "task" are required.');
  const o = getSettings().orchestrator;
  const kids = childrenOf(parent, true);
  if (kids.length >= o.maxPerSession) throw new ToolError(`This session has already spawned ${kids.length} sub-sessions, the limit (${o.maxPerSession}). Reuse one with message_subsession or configure_subsession, or do the rest yourself.`);
  const active = kids.filter((k) => isActive(k.id));
  if (active.length >= o.maxParallel)
    throw new ToolError(`${active.length} sub-sessions are already running (the limit is ${o.maxParallel}): ${active.map((k) => `"${k.title}" (${k.id})`).join(', ')}. Call wait_for_subsessions first.`);
  const agentId = String(args?.agent ?? '').trim() || parent.agentId;
  const cfg = extractConfigRequest(args);
  await assertAgentQuotaAvailable(agentId, cfg.model);

  const keep = args?.keep === true || args?.keep === 'true';
  const inWorktree = args?.worktree === true || args?.worktree === 'true';
  const child = createThread(parent.projectId, agentId, {
    title,
    parentId: parent.id,
    spawnedBy: parent.id,
    task,
    mode: parent.mode ?? 'code',
    ...(keep ? {} : { disposable: true }),
    ...(parent.autoApprove ? { autoApprove: true } : {}),
  });
  if (inWorktree) {
    try {
      await startChatWorktree(child, parent);
    } catch (e: any) {
      deleteThread(child);
      throw new ToolError(e?.message ?? String(e));
    }
  }
  starting.add(child.id);
  let appliedNote = '';
  try {
    const ok = await ensureSession(child.id);
    if (ok) {
      await inheritSettings(parent.id, child.id);
      if (hasConfigOverrides(cfg)) {
        const res = await configureSession(child.id, cfg);
        if (res.applied.length) appliedNote = ` (${res.applied.join(', ')})`;
      }
    } else if (hasConfigOverrides(cfg)) {
      throw new Error(`${agentName(agentId)} failed to start.`);
    }
  } catch (e: any) {
    if (hasConfigOverrides(cfg)) {
      starting.delete(child.id);
      forgetThread(child.id);
      deleteThread(child);
      throw new ToolError(e?.message ?? String(e));
    }
    /* When no explicit config override was requested, let sendPrompt record the startup failure inside the sub-session. */
  }
  emit('thread:meta', threadMeta(child));
  void sendPrompt(child.id, task, [], { fromAgent: parent.agentId }).catch(() => {});
  starting.delete(child.id);
  const life = keep ? 'Kept until you delete it.' : 'Disposable: deleted automatically after you read its final report and your turn ends.';
  const where = child.worktree ? ` in its own git worktree (branch ${child.worktree.branch})` : '';
  return `Started sub-session "${title}" (id ${child.id}) with ${agentName(agentId)}${appliedNote}${where}. The user can watch it in the Tasks panel. ${life} Olympus sends you its result the moment it finishes; call wait_for_subsessions only if you need it in this turn.`;
}

async function waitFor(parent: Thread, args: any, closed: () => boolean): Promise<string> {
  const timeout = Math.max(1, Math.min(55, Number(args?.timeout_seconds) || 50)) * 1000;
  const ids: string[] = Array.isArray(args?.ids) && args.ids.length ? args.ids.map(String) : childrenOf(parent, true).filter((k) => isActive(k.id)).map((k) => k.id);
  const targets = ids.map((id) => ownChild(parent, id));
  if (!targets.length) {
    const all = childrenOf(parent, true).map((c) => summarize(c, 8000));
    for (const v of all) if (!LIVE_STATES.has(v.status)) seen.add(doneKey(v));
    reportsRead(parent, all);
    return all.length ? `No sub-sessions are running. Latest state:\n\n${all.map((v) => describe(v, true)).join('\n\n')}` : 'This session has no sub-sessions.';
  }
  // While this call waits, a target's result comes back in its answer; it is not sent as a message as well.
  const waitIds = targets.map((t) => t.id);
  waitStarted(parent.id, waitIds);
  try {
    return await waitLoop(parent, targets, timeout, closed);
  } finally {
    waitEnded(parent.id, waitIds);
  }
}

async function waitLoop(parent: Thread, targets: Thread[], timeout: number, closed: () => boolean): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && !closed()) {
    const active = targets.filter((t) => isActive(t.id));
    if (!active.length) break;
    const hitLimit = targets.some((t) => {
      if (isActive(t.id)) return false;
      const v = summarize(findThread(t.id) ?? t);
      return (v.status === 'quota-exceeded' || v.status === 'needs-login') && !seen.has(doneKey(v));
    });
    if (hitLimit) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const views = targets.map((t) => summarize(findThread(t.id) ?? t, 8000));
  for (const v of views) if (!LIVE_STATES.has(v.status)) seen.add(doneKey(v));
  reportsRead(parent, views);
  const still = views.filter((v) => ['running', 'starting', 'waiting-permission'].includes(v.status));
  const blocked = views.filter((v) => v.status === 'quota-exceeded' || v.status === 'needs-login');
  const head = blocked.length && still.length
    ? `${blocked.length} sub-session stopped due to a quota limit or login issue (${still.length} still running) — you can switch it now with configure_subsession or message_subsession.`
    : still.length
      ? `${still.length} of ${views.length} still running — call wait_for_subsessions again to keep waiting.`
      : `All ${views.length} finished.`;
  return `${head}\n\n${views.map((v) => describe(v, true)).join('\n\n')}`;
}

async function message(parent: Thread, args: any): Promise<string> {
  const c = ownChild(parent, args?.id);
  const text = String(args?.text ?? '').trim();
  if (!text) throw new ToolError('"text" is required.');
  if (isActive(c.id)) throw new ToolError(`"${c.title}" is still running. Wait for it, or cancel it first.`);
  disposables.reset(c.id);
  const requestedAgent = typeof args?.agent === 'string' && args.agent.trim() ? args.agent.trim() : undefined;
  const cfg = extractConfigRequest(args);
  if (requestedAgent || hasConfigOverrides(cfg)) {
    return reconfigureSubsession(
      parent,
      c,
      { ...args, prompt: text },
      { isActive, clearCancelled: (id) => cancelled.delete(id) },
    );
  }
  await assertAgentQuotaAvailable(c.agentId);
  cancelled.delete(c.id);
  void sendPrompt(c.id, text, [], { fromAgent: parent.agentId }).catch(() => {});
  return `Sent to "${c.title}" (${c.id}) on ${agentName(c.agentId)}. Call wait_for_subsessions to get its reply.`;
}

/** Deletes a chat the same way the sidebar does (closes its agent session, keeps the agent's own saved copy). */
let deleteChat: (threadId: string) => Promise<unknown> = async () => {
  throw new ToolError('Deleting sub-sessions is not available yet.');
};
export const setChatDeleter = (fn: (threadId: string) => Promise<unknown>) => (deleteChat = fn);

/** A finished one-off sub-session: remove it from the sidebar and Tasks once its result has been checked. */
async function removeSubsession(parent: Thread, args: any): Promise<string> {
  const c = ownChild(parent, args?.id);
  if (isActive(c.id)) throw new ToolError(`"${c.title}" is still running. Call cancel_subsession or wait_for_subsessions first.`);
  const title = c.title;
  await deleteChat(c.id);
  cancelled.delete(c.id);
  disposables.forget(c.id);
  return `Deleted sub-session "${title}" (${c.id}). Its chat is gone from the sidebar and Tasks panel, and it no longer counts toward this session's limit.`;
}

async function stop(parent: Thread, args: any): Promise<string> {
  const c = ownChild(parent, args?.id);
  if (!isActive(c.id)) return `"${c.title}" is not running.`;
  cancelled.add(c.id);
  await cancel(c.id);
  return `Asked "${c.title}" (${c.id}) to stop.`;
}

export function toolsFor(t: Thread) {
  const info = {
    name: 'session_info',
    title: 'Session info',
    description: 'This Olympus Coder session: id, title, role, project, transcript path, parent session, and every sub-session with its live status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
  const readTerm = {
    name: 'read_terminal',
    title: 'Read terminal',
    description: 'The latest output of a terminal opened with run_in_terminal, as plain text, and whether its shell is still open.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, lines: { type: 'number', minimum: 1, maximum: 400, description: 'How many trailing lines (default 60).' } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
  const listSavedTool = {
    name: 'list_saved_commands',
    title: 'List saved commands',
    description: "This project's saved commands (watchers, servers kept across Olympus restarts): id, title, command, folder, status, auto-start.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
  const term = t.secondOpinion
    ? [readTerm, listSavedTool]
    : [
        {
          name: 'run_in_terminal',
          title: 'Run in terminal',
          description:
            "Open a terminal tab in the right panel (project folder, login shell) and run a command live. Use for servers, watchers, log tails, or commands the user wants to watch. Returns terminal id for read_terminal.",
          inputSchema: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'Command line to run.' },
              title: { type: 'string', description: 'Short tab name (optional).' },
              persist: { type: 'boolean', description: 'Save across restarts (watchers, servers).' },
            },
            required: ['command'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        },
        readTerm,
        listSavedTool,
        {
          name: 'run_saved_command',
          title: 'Run saved command',
          description: 'Start a saved command (id from list_saved_commands) in a fresh terminal tab in its folder. Returns the terminal id for read_terminal; one already running is not started twice.',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        },
      ];
  const learn = canLearnAboutUser(t)
    ? [
        {
          name: 'remember_about_user',
          title: 'Remember about the user',
          description:
            "Save one short, durable note about the user's style, workflow, interests, or setup so future sessions adapt. Only from what they said or did — never guesses, health, religion, politics, finances, family, secrets, or other people.",
          inputSchema: {
            type: 'object',
            properties: {
              section: { type: 'string', enum: Object.keys(NOTE_SECTIONS) },
              note: { type: 'string', description: 'One sentence, under 240 chars.' },
            },
            required: ['section', 'note'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
      ]
    : [];
  const schedules = canManageSchedules(t) ? scheduleToolDefs() : [];
  const agentMgmt = canManageAgents(t) ? agentToolDefs() : [];
  const projectMgmt = canManageProjects(t) ? projectToolDefs() : [];
  const browser = browserToolDefs(Boolean(t.secondOpinion));
  if (!canOrchestrate(t)) return [info, setTimerToolDef, ...term, ...browser, ...learn, ...schedules, ...agentMgmt, ...projectMgmt];
  // Keep every declaration under ~620 bytes: Antigravity disables MCP tools over ~650 bytes ("tool … is not enabled
  // for server …"; agy 1.5.11 enabled ≤642, disabled ≥679, see tests/mcpTools.unit.mjs). Agent ids are validated
  // server-side (assertAgentQuotaAvailable) instead of an `enum`; list_agents shows the ids, models, modes and efforts.
  const configProps = {
    model: { type: 'string' },
    mode: { type: 'string' },
    effort: { type: 'string' },
    config: { type: 'object' },
  };
  return [
    info,
    setTimerToolDef,
    {
      name: 'list_agents',
      title: 'List agents & limits',
      description:
        'List all CLI agents in Olympus Coder with their installation/login status, live usage quota & reset windows, and configurable parameters (models, modes, effort levels). Call before choosing a fallback agent or higher-capability model.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ...term,
    ...browser,
    ...learn,
    ...schedules,
    ...agentMgmt,
    ...projectMgmt,
    {
      name: 'spawn_subsession',
      title: 'Spawn sub-session',
      description: 'Start a parallel sub-session worker. Include goal, file scope, known facts, and how to verify.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          task: { type: 'string' },
          agent: { type: 'string', description: `Default ${t.agentId}.` },
          model: { type: 'string' },
          mode: { type: 'string' },
          effort: { type: 'string' },
          config: { type: 'object' },
          keep: { type: 'boolean', description: 'Keep after report.' },
          worktree: { type: 'boolean', description: 'Own git worktree.' },
        },
        required: ['title', 'task'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    {
      name: 'configure_subsession',
      title: 'Configure or switch sub-session',
      description:
        'Switch an idle or stopped sub-session to another agent, model, mode or effort (see list_agents), keeping history. Optional prompt resumes it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          agent: { type: 'string' },
          ...configProps,
          prompt: { type: 'string' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    {
      name: 'wait_for_subsessions',
      title: 'Wait for sub-sessions',
      description:
        'Wait for sub-sessions (default: all running) to finish and return reports. Returns early on quota-exceeded/needs-login. Max timeout_seconds 55 (default 50).',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'Sub-session ids; omit for all running.' },
          timeout_seconds: { type: 'number', minimum: 1, maximum: 55, description: 'Default 50.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'get_subsession',
      title: 'Get sub-session',
      description: 'Status, task, recent steps and latest report of one sub-session this session spawned.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'message_subsession',
      title: 'Message sub-session',
      description:
        'Send a follow-up to a finished or quota-stopped sub-session; optionally switch its agent, model, mode or effort (see list_agents).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          agent: { type: 'string' },
          ...configProps,
        },
        required: ['id', 'text'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    {
      name: 'cancel_subsession',
      title: 'Cancel sub-session',
      description: 'Stop a running sub-session this session spawned.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'delete_subsession',
      title: 'Delete sub-session',
      description:
        'Delete a finished sub-session this session spawned (removes chat from sidebar/Tasks and frees a slot; refuses a running one).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
  ];
}

async function callTool(threadId: string, name: string, args: any, closed: () => boolean): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const t = findThread(threadId);
  if (!t) return { content: [{ type: 'text', text: 'This session no longer exists.' }], isError: true };
  try {
    let text: string;
    switch (name) {
      case 'session_info':
        text = sessionInfo(t);
        break;
      case 'set_timer':
        try {
          const a = parseTimerArgs(args);
          text = setTimer(t.id, a.minutes, a.note);
        } catch (e: any) {
          throw new ToolError(e?.message ?? String(e));
        }
        break;
      case 'list_agents':
        if (!canOrchestrate(t)) throw new ToolError('list_agents is available only to main orchestrator sessions.');
        text = await formatAgentCatalog(t.agentId);
        break;
      case 'remember_about_user':
        if (!canLearnAboutUser(t)) throw new ToolError('Saving user notes is disabled for this session.');
        try {
          text = addNote(String(args?.section ?? ''), String(args?.note ?? ''), t.agentId);
        } catch (e: any) {
          throw new ToolError(e?.message ?? String(e));
        }
        break;
      case 'run_in_terminal': {
        if (t.secondOpinion) throw new ToolError('Second-opinion sessions are read-only and cannot run terminal commands.');
        const command = String(args?.command ?? '').trim();
        if (!command) throw new ToolError('"command" is required.');
        const title = typeof args?.title === 'string' ? args.title : undefined;
        if (args?.persist === true) {
          let rec;
          try {
            rec = saveCommand({ projectId: workspaceProjectId(t), command, title, createdBy: 'agent', threadId: t.id });
          } catch (e: any) {
            throw new ToolError(e?.message ?? String(e));
          }
          const r = runSaved(rec.id, { manual: true, threadId: t.id });
          text = `${r.alreadyRunning ? 'Already running in' : 'Saved as saved command'} "${rec.title}" (saved id ${rec.id}) ${r.alreadyRunning ? '' : 'and started in '}terminal "${r.title}" (id ${r.ptyId}): ${command}\nIt can be restarted after an Olympus restart (run_saved_command, or the user's Saved commands list). Check it with read_terminal {"id": "${r.ptyId}"}.`;
          break;
        }
        const r = openTerminal(workspaceProjectId(t), command, title, t.id);
        text = `Opened terminal "${r.title}" (id ${r.ptyId}) in the user's right panel and typed: ${command}\nThe user sees the output live. Check it with read_terminal {"id": "${r.ptyId}"}.${t.projectId === 'general' ? ' (In Chat mode the user sees terminals only after switching to Code mode.)' : ''}`;
        break;
      }
      case 'list_saved_commands': {
        const own = [...new Set([t.projectId, workspaceProjectId(t)])].flatMap((p) => listSaved(p));
        text = own.length
          ? own.map((c) => `- id ${c.id} · "${c.title}" · ${statusText(c)}${c.ptyId ? ` (terminal ${c.ptyId})` : ''} · auto-start ${c.autoStart ? 'on' : 'off'}${c.keepRunning ? ' · keep running' : ''}\n  command: ${c.command}\n  folder: ${c.cwd ?? '(project folder)'}`).join('\n')
          : 'No saved commands in this project. run_in_terminal with persist: true saves one.';
        break;
      }
      case 'run_saved_command': {
        if (t.secondOpinion) throw new ToolError('Second-opinion sessions are read-only and cannot run terminal commands.');
        const id = String(args?.id ?? '');
        const c = listSaved().find((x) => x.id === id);
        if (!c) throw new ToolError(`No saved command with id ${id}. See list_saved_commands.`);
        if (c.projectId !== t.projectId && c.projectId !== workspaceProjectId(t)) throw new ToolError('That saved command belongs to another project.');
        try {
          const r = runSaved(id, { manual: true, threadId: t.id });
          text = `${r.alreadyRunning ? 'Already running in' : 'Started in'} terminal "${r.title}" (id ${r.ptyId}): ${c.command}\nCheck it with read_terminal {"id": "${r.ptyId}"}.`;
        } catch (e: any) {
          throw new ToolError(e?.message ?? String(e));
        }
        break;
      }
      case 'read_terminal': {
        const id = String(args?.id ?? '');
        if (terminalProject(id) && terminalProject(id) !== t.projectId && terminalProject(id) !== workspaceProjectId(t)) throw new ToolError('That terminal belongs to another project.');
        try {
          text = readTerminal(id, Number(args?.lines) || 60);
        } catch (e: any) {
          throw new ToolError(e?.message ?? String(e));
        }
        break;
      }
      case 'spawn_subsession':
        text = await spawn(t, args);
        break;
      case 'configure_subsession': {
        if (!canOrchestrate(t)) throw new ToolError('configure_subsession is available only to main orchestrator sessions.');
        const c = ownChild(t, args?.id);
        disposables.reset(c.id);
        text = await reconfigureSubsession(t, c, args, { isActive, clearCancelled: (id) => cancelled.delete(id) });
        break;
      }
      case 'wait_for_subsessions':
        text = await waitFor(t, args, closed);
        break;
      case 'get_subsession': {
        const c = ownChild(t, args?.id);
        const v = summarize(c, 8000);
        if (!LIVE_STATES.has(v.status)) seen.add(doneKey(v));
        reportsRead(t, [v]);
        text = `${describe(v, true)}\n\ntask:\n${c.task ?? ''}\n\nrecent steps:\n${steps(c) || '(none yet)'}`;
        break;
      }
      case 'message_subsession':
        text = await message(t, args);
        break;
      case 'cancel_subsession':
        text = await stop(t, args);
        break;
      case 'delete_subsession':
        if (!canOrchestrate(t)) throw new ToolError('delete_subsession is available only to main orchestrator sessions.');
        text = await removeSubsession(t, args);
        break;
      case 'list_schedules':
      case 'save_schedule':
      case 'delete_schedule':
      case 'run_schedule': {
        const schedOut = await handleScheduleTool(t, name, args, emit);
        if (schedOut === undefined) throw new ToolError(`Unknown tool ${name}.`);
        text = schedOut;
        break;
      }
      case 'search_agent_registry':
      case 'add_agent':
      case 'add_custom_agent':
      case 'remove_agent': {
        const agentOut = await handleAgentTool(t, name, args, emit, closed);
        if (agentOut === undefined) throw new ToolError(`Unknown tool ${name}.`);
        text = agentOut;
        break;
      }
      case 'create_project': {
        const projectOut = await handleProjectTool(t, name, args, emit);
        if (projectOut === undefined) throw new ToolError(`Unknown tool ${name}.`);
        text = projectOut;
        break;
      }
      case 'browser_tabs':
      case 'browser_open':
      case 'browser_read':
      case 'browser_act':
      case 'browser_close': {
        const browserOut = await handleBrowserTool(name, args, Boolean(t.secondOpinion));
        if (browserOut === undefined) throw new ToolError(`Unknown tool ${name}.`);
        text = browserOut;
        break;
      }
      default:
        throw new ToolError(`Unknown tool ${name}.`);
    }
    record(t, name, args, text, false);
    return { content: [{ type: 'text', text }] };
  } catch (e: any) {
    const text = e instanceof ToolError ? e.message : `Error: ${e?.message ?? e}`;
    record(t, name, args, text, true);
    return { content: [{ type: 'text', text }], isError: true };
  }
}

/** Keeps what the agent asked and what the app answered on the chat's tool card (the same for every agent). */
function record(t: Thread, tool: string, args: any, result: string, isError: boolean) {
  try {
    const id = tool === 'spawn_subsession' ? /\(id ([0-9a-f-]{36})\)/.exec(result)?.[1] : typeof args?.id === 'string' ? args.id : undefined;
    const child = id ? findThread(id) : undefined;
    const ids: string[] = Array.isArray(args?.ids) ? args.ids.map(String) : [];
    const text =
      tool === 'spawn_subsession'
        ? String(args?.task ?? '')
        : tool === 'message_subsession'
          ? String(args?.text ?? args?.message ?? '')
          : tool === 'configure_subsession'
            ? [args?.agent && `agent=${args.agent}`, args?.model && `model=${args.model}`, args?.mode && `mode=${args.mode}`, args?.effort && `effort=${args.effort}`, args?.prompt]
                .filter(Boolean)
                .join(' · ')
            : tool === 'run_in_terminal'
              ? String(args?.command ?? '')
              : tool === 'wait_for_subsessions' && ids.length
                ? ids.map((x) => findThread(x)?.title ?? x).join(', ')
                : undefined;
    recordOlympusCall(t.id, {
      tool,
      target: child ? { id: child.id, title: child.title } : tool === 'spawn_subsession' && args?.title ? { id: '', title: String(args.title) } : undefined,
      text: text || undefined,
      result: result.length > 20000 ? `${result.slice(0, 20000)}\n…` : result,
      isError,
    });
  } catch {
    /* showing it is a nicety; the call itself already went through */
  }
}

// ------------------------------------------------------------------ MCP over HTTP

let server: Server | undefined;
let port = 0;
let starting_: Promise<void> | undefined;
const tokenToThread = new Map<string, string>();
const threadToToken = new Map<string, string>();

function tokenFor(threadId: string): string {
  let tok = threadToToken.get(threadId);
  if (!tok) {
    tok = randomBytes(18).toString('base64url');
    threadToToken.set(threadId, tok);
    tokenToThread.set(tok, threadId);
  }
  return tok;
}

async function handleRpc(threadId: string, msg: any, closed: () => boolean): Promise<any | undefined> {
  if (!msg || typeof msg !== 'object' || msg.id === undefined || msg.id === null) return undefined; // notification
  const ok = (result: any) => ({ jsonrpc: '2.0', id: msg.id, result });
  // The agent reached this chat's server: show it as ready in the chat's MCP status.
  if (msg.method === 'tools/list' || msg.method === 'tools/call') mcpStatus.markOwnReady(threadId);
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'olympus', title: 'Olympus Coder', version: app.getVersion() },
        instructions: 'Olympus Coder session tools: session_info, run_in_terminal / read_terminal (a terminal the user watches in the right panel), list_saved_commands / run_saved_command (commands kept across restarts), and for a main session the sub-session tools (spawn, wait, get, message, cancel, delete).',
      });
    case 'ping':
      return ok({});
    case 'tools/list': {
      const t = findThread(threadId);
      return ok({ tools: t ? toolsFor(t) : [] });
    }
    case 'tools/call':
      return ok(await callTool(threadId, String(msg.params?.name ?? ''), msg.params?.arguments ?? {}, closed));
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

// The same handler serves agents that take MCP over the ACP connection (`mcp/message`, acpMcp.ts).
acpMcp.setRpc(handleRpc);

function onRequest(req: IncomingMessage, res: ServerResponse) {
  // Only local MCP clients: right host (no DNS rebinding), no browser origin, a known token.
  const host = req.headers.host ?? '';
  const m = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec((req.url ?? '').split('?')[0]);
  const threadId = m ? tokenToThread.get(m[1]) : undefined;
  if (host !== `127.0.0.1:${port}` || req.headers.origin || !threadId) {
    res.writeHead(403).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  let closed = false;
  res.on('close', () => (closed = true));
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > 2_000_000) req.destroy();
    else chunks.push(c);
  });
  req.on('end', async () => {
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }
    const isClosed = () => closed;
    const replies = Array.isArray(body) ? (await Promise.all(body.map((x) => handleRpc(threadId, x, isClosed)))).filter(Boolean) : [await handleRpc(threadId, body, isClosed)].filter(Boolean);
    if (closed) return;
    if (!replies.length) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
  });
}

/**
 * Forwards newline-delimited JSON-RPC from stdin to an MCP HTTP endpoint (the app's own, or a remote connector),
 * for agents without HTTP MCP. Handles JSON and SSE replies, the mcp-session-id header, and extra headers
 * passed as JSON in OLYMPUS_BRIDGE_HEADERS.
 */
const BRIDGE = `'use strict';
const url = process.argv[2];
let extra = {};
try { extra = JSON.parse(process.env.OLYMPUS_BRIDGE_HEADERS || '{}'); } catch {}
let session;
let buf = '';
let pending = 0;
let ended = false;
const maybeExit = () => { if (ended && pending === 0) process.exit(0); };
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});
process.stdin.on('end', () => { ended = true; maybeExit(); });
async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  pending++;
  try {
    const headers = Object.assign({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, session ? { 'mcp-session-id': session } : {}, extra);
    const r = await fetch(url, { method: 'POST', headers, body: line });
    session = r.headers.get('mcp-session-id') || session;
    if (r.status === 202) return;
    const text = (await r.text()).trim();
    if (!text) return;
    if ((r.headers.get('content-type') || '').includes('text/event-stream')) {
      for (const l of text.split('\\n')) if (l.startsWith('data:')) { try { out(JSON.parse(l.slice(5).trim())); } catch {} }
    } else {
      const j = JSON.parse(text);
      (Array.isArray(j) ? j : [j]).forEach(out);
    }
  } catch (e) {
    if (msg && msg.id !== undefined && msg.id !== null) out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'MCP server not reachable: ' + e.message } });
  } finally {
    pending--;
    maybeExit();
  }
}
`;
const bridgePath = () => join(app.getPath('userData'), 'olympus-mcp-bridge.cjs');

function ensureServer(): Promise<void> {
  if (server && port) return Promise.resolve();
  if (!starting_) {
    starting_ = new Promise<void>((resolve, reject) => {
      const s = createServer(onRequest);
      s.requestTimeout = 120_000;
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        server = s;
        port = (s.address() as any).port;
        try {
          writeFileSync(bridgePath(), BRIDGE);
        } catch {
          /* stdio agents just won't get the tools */
        }
        resolve();
      });
    }).finally(() => (starting_ = undefined));
  }
  return starting_;
}

/**
 * The `mcpServers` entry for a chat's ACP session (HTTP when the agent supports it, else the stdio bridge),
 * registered under `name` ("olympus", or a per-chat name for agents with one shared registry: claimOlympusServerName).
 */
export async function mcpServersFor(threadId: string, caps: any, name: string): Promise<any[]> {
  await ensureServer();
  const url = `http://127.0.0.1:${port}/mcp/${tokenFor(threadId)}`;
  if (caps?.mcpCapabilities?.http) return [{ type: 'http', name, url, headers: [] }];
  return [bridgeEntry(name, url)];
}

/** A stdio `mcpServers` entry that runs the bridge (Electron as Node) against an HTTP MCP endpoint. */
export function bridgeEntry(name: string, url: string, headers: Record<string, string> = {}): any {
  void ensureServer(); // also writes the bridge script
  const env = [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }];
  if (Object.keys(headers).length) env.push({ name: 'OLYMPUS_BRIDGE_HEADERS', value: JSON.stringify(headers) });
  return { name, command: process.execPath, args: [bridgePath(), url], env };
}

export function stopOrchestrator() {
  server?.close();
  server = undefined;
  port = 0;
}
