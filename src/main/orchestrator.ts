import { app } from 'electron';
import { NOTE_SECTIONS, addNote } from './usernotes';
import { dropWakes, parseTimerArgs, setTimer, setTimerToolDef } from './agenttimers';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { DeskEvents, SubTaskView, Thread, ThreadItem } from '@shared/types';
import { isModelUnavailableMessage, isQuotaErrorText, isQuotaMessage } from '@shared/quota';
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
  setTurnEndListener,
} from './agents';
import { agentName, canLearnAboutUser, canOrchestrate, sessionRole, threadFilePath } from './guide';
import { isMuted, muteChat, notifyAgent, unmuteChat } from './appmsg';
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
import { agySubagentSummary, discoverAgySubagents } from './agySubagents';
import { claudeSubagentSummary, discoverClaudeSubagents } from './claudeSubagents';
import { nativeSubagentSummary } from './nativeSubagents';
import { createThread, deleteThread, findThread, getProject, getSettings, listThreads, threadMeta } from './store';
import { openTerminal, readTerminal, terminalProject } from './terminals';
import { acpMcp, mcpStatus } from './acpConfigService';
import { lastTaskIndex, outcomeLine, resultItem } from './subtaskOutcome';
import { DisposableTracker } from './disposableSubsessions';

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
    // A sub-session finished, or the main session itself went idle: either may complete the picture.
    setTimeout(() => {
      maybeWake(t.spawnedBy ?? t.id);
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
  if (!parent || !canOrchestrate(parent)) return;
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
 * Waking the orchestrator: whenever a main session is idle and one or more of its sub-sessions have finished since
 * it last looked, the app sends it one short message (naming the ones still running) so it can check that work and
 * move on without waiting for slower siblings or for the user to ask. Sub-sessions that finish while it is busy are
 * picked up in one batch when its turn ends. A finished state ("id@endedAt") counts as seen once the orchestrator
 * read it, and wakes it at most once.
 */
const seen = new Set<string>();
const woken = new Set<string>();
const APP_STARTED = Date.now();

const doneKey = (v: SubTaskView) => `${v.meta.id}@${v.resultId ?? v.endedAt ?? 0}`;
const LIVE_STATES = new Set<SubTaskView['status']>(['starting', 'running', 'waiting-permission']);

/** The user pressed Stop / wrote a message: automatic messages pause / resume (see appmsg.ts). */
export function userCancelled(threadId: string) {
  muteChat(threadId);
  dropWakes(threadId);
}
export function userSent(threadId: string) {
  unmuteChat(threadId);
}

function maybeWake(parentId: string) {
  const parent = findThread(parentId);
  if (!parent || !canOrchestrate(parent) || isMuted(parentId) || isActive(parentId)) return;
  const kids = childrenOf(parent, true);
  if (!kids.length) return;
  const views = kids.map((k) => summarize(k));
  // Only work that finished in this run of the app: what is seen / woken is kept in memory, so after a restart
  // sub-sessions that finished long ago would otherwise wake the parent again.
  const fresh = views.filter((v) => !LIVE_STATES.has(v.status) && v.endedAt && v.endedAt > APP_STARTED && !seen.has(doneKey(v)) && !woken.has(doneKey(v)));
  if (!fresh.length) return;
  for (const v of fresh) woken.add(doneKey(v));
  // Off by default: the parent checks its sub-sessions itself (wait_for_subsessions, get_subsession, set_timer).
  if (!getSettings().notifyAgentsWhenWorkEnds) return;

  const running = views.filter((v) => LIVE_STATES.has(v.status));
  const stillRunning = running.length
    ? ` Still running: ${running.map((v) => `"${v.meta.title}"`).join(', ')} — you will get another message when more finish.`
    : ' No other sub-sessions are running.';
  const blocked = fresh.filter((v) => v.status === 'quota-exceeded' || v.status === 'needs-login');
  const list = fresh.map((v) => `"${v.meta.title}" (id ${v.meta.id}, ${v.status})`).join(', ');
  const outcomes = fresh.map((v) => `- "${v.meta.title}" (id ${v.meta.id}) — ${outcomeLine(v)}`).join('\n');
  const text = blocked.length
    ? `[Olympus Coder] Sub-session ${list} stopped due to an agent quota limit or login issue.${stillRunning} ${fallbackAgentsSummary(blocked[0].meta.agentId)} Use configure_subsession or message_subsession (with "agent"/"model") to switch it and continue from its existing context.`
    : `[Olympus Coder] ${fresh.length > 1 ? `${fresh.length} sub-sessions have` : 'A sub-session has'} a new result:\n${outcomes}\n${stillRunning.trim()} Read the full report${fresh.length > 1 ? 's' : ''} with get_subsession, verify the parts that matter yourself, and start any follow-up work that no longer depends on the running ones.`;
  notifyAgent(parentId, text);
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
  const kind = v.meta.spawnedBy ? ` · ${v.meta.disposable ? 'disposable' : 'kept'}` : '';
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
  const project = getProject(t.projectId);
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
  const child = createThread(parent.projectId, agentId, {
    title,
    parentId: parent.id,
    spawnedBy: parent.id,
    task,
    mode: parent.mode ?? 'code',
    ...(keep ? {} : { disposable: true }),
    ...(parent.autoApprove ? { autoApprove: true } : {}),
  });
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
  return `Started sub-session "${title}" (id ${child.id}) with ${agentName(agentId)}${appliedNote}. The user can watch it in the Tasks panel. ${life} Call wait_for_subsessions to get its report.`;
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
    annotations: { readOnlyHint: true },
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
    annotations: { readOnlyHint: true },
  };
  const term = t.secondOpinion
    ? [readTerm]
    : [
        {
          name: 'run_in_terminal',
          title: 'Run in terminal',
          description:
            "Open a terminal tab in the user's right panel (in this project's folder, in their login shell) and run a command there, so the user watches its output live. Use it when the user wants to see a command run, or for long-running or interactive commands (servers, watchers, log tails, training runs) — instead of telling the user to run it. Returns the terminal id; check its output with read_terminal. The shell stays open after the command finishes.",
          inputSchema: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'The command line to run.' },
              title: { type: 'string', description: 'Short tab name, e.g. "dev server". Optional.' },
            },
            required: ['command'],
            additionalProperties: false,
          },
        },
        readTerm,
      ];
  const learn = canLearnAboutUser(t)
    ? [
        {
          name: 'remember_about_user',
          title: 'Remember about the user',
          description:
            "Save one short, durable note about the user so every future session can adapt to them: how they communicate (language, tone, length they like), how they think, how they approach problems, their interests, their context (place, work, setup), or preferences. Only from what the user said or did — never guesses. Never health, religion, politics, sexuality, finances, family, secrets or credentials, or other people. Only new things; the user sees every note and can delete it.",
          inputSchema: {
            type: 'object',
            properties: {
              section: { type: 'string', enum: Object.keys(NOTE_SECTIONS) },
              note: { type: 'string', description: 'One sentence, under 240 characters, e.g. "Writes in Hinglish; wants short answers with the next step at the end."' },
            },
            required: ['section', 'note'],
            additionalProperties: false,
          },
        },
      ]
    : [];
  const schedules = canManageSchedules(t) ? scheduleToolDefs(t.agentId) : [];
  const agentMgmt = canManageAgents(t) ? agentToolDefs() : [];
  if (!canOrchestrate(t)) return [info, setTimerToolDef, ...term, ...learn, ...schedules, ...agentMgmt];
  // Keep these schemas small: Antigravity (agy 1.5.8) silently disables MCP tools whose declaration is too large
  // ("tool … is not enabled for server …"; seen at ≥1144 chars, fine at ≤840). Agent ids are validated server-side
  // (assertAgentQuotaAvailable) instead of a long `enum`; list_agents shows the ids, models, modes and efforts.
  const agent = (what: string) => ({ type: 'string', description: `${what} (an id from list_agents).` });
  const configProps = {
    model: { type: 'string', description: 'Optional model (see list_agents).' },
    mode: { type: 'string', description: 'Optional mode, e.g. code, plan, auto.' },
    effort: { type: 'string', description: 'Optional effort, e.g. low, medium, high, max.' },
    config: { type: 'object', description: 'Optional configOption id → value map.' },
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
      annotations: { readOnlyHint: true },
    },
    ...term,
    ...learn,
    ...schedules,
    ...agentMgmt,
    {
      name: 'spawn_subsession',
      title: 'Spawn sub-session',
      description:
        'Start a sub-session: another agent that does one task in parallel and reports back. It sees only your task text, so include goal, scope, known facts, definition of done, how to verify and what to report.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name shown to the user.' },
          task: { type: 'string', description: 'The complete task brief.' },
          agent: agent(`CLI agent; default ${t.agentId}`),
          ...configProps,
          keep: { type: 'boolean', description: 'Keep after its report (default: auto-delete).' },
        },
        required: ['title', 'task'],
        additionalProperties: false,
      },
    },
    {
      name: 'configure_subsession',
      title: 'Configure or switch sub-session',
      description:
        'Switch an idle or stopped sub-session to another agent and/or change its model, mode, effort or config, keeping its history. Optional `prompt` resumes it right away.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Sub-session id.' },
          agent: agent('New CLI agent'),
          ...configProps,
          prompt: { type: 'string', description: 'Optional follow-up to send after switching.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      name: 'wait_for_subsessions',
      title: 'Wait for sub-sessions',
      description:
        'Wait until the given sub-sessions (default: all running ones) finish, then return their status and final reports. Returns early if a sub-session hits "quota-exceeded" or "needs-login" so you can switch its agent right away. Waits up to timeout_seconds (default 50, max 55) while any target is still running or awaiting user permission.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'Sub-session ids. Omit for all running ones.' },
          timeout_seconds: { type: 'number', minimum: 1, maximum: 55, description: 'Default 50.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_subsession',
      title: 'Get sub-session',
      description: 'Status, task, recent steps and latest report of one sub-session this session spawned.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'message_subsession',
      title: 'Message sub-session',
      description:
        'Send a follow-up (a correction, the next step, or "continue") to a finished or quota-stopped sub-session; optionally switch its agent or model in the same step.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          agent: agent('Optional CLI agent to switch to'),
          ...configProps,
        },
        required: ['id', 'text'],
        additionalProperties: false,
      },
    },
    {
      name: 'cancel_subsession',
      title: 'Cancel sub-session',
      description: 'Stop a running sub-session this session spawned.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    },
    {
      name: 'delete_subsession',
      title: 'Delete sub-session',
      description:
        'Delete a finished sub-session this session spawned: its chat leaves the sidebar and Tasks panel, its agent session is closed (the agent keeps its own saved copy) and it frees a slot of the per-session limit. Disposable sub-sessions go by themselves after you read their report; use this for kept ones (keep: true) you no longer need. Refuses a running one.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
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
        const r = openTerminal(t.projectId, command, typeof args?.title === 'string' ? args.title : undefined, t.id);
        text = `Opened terminal "${r.title}" (id ${r.ptyId}) in the user's right panel and typed: ${command}\nThe user sees the output live. Check it with read_terminal {"id": "${r.ptyId}"}.${t.projectId === 'general' ? ' (In Chat mode the user sees terminals only after switching to Code mode.)' : ''}`;
        break;
      }
      case 'read_terminal': {
        const id = String(args?.id ?? '');
        if (terminalProject(id) && terminalProject(id) !== t.projectId) throw new ToolError('That terminal belongs to another project.');
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
        instructions: 'Olympus Coder session tools: session_info, run_in_terminal / read_terminal (a terminal the user watches in the right panel), and for a main session the sub-session tools (spawn, wait, get, message, cancel, delete).',
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
