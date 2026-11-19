import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SubTaskView, Thread } from '@shared/types';
import { createThread, findThread, listThreads, saveThread, threadMeta } from './store';
import { cleanOneLine, parseCreatedSubagents, readFirstMessage, readNewLines, syncAgyTranscriptLines, unwrapArgs, type AgyStepCursor, type LineTail } from './agyTranscript';
import { rootUserThread, type NativeRuntimeHandle, type NativeSubagentHost } from './nativeSubagents';
import { setAgyIdleTurn, stopAgyIdleTurns } from './agyIdleTurns';

/**
 * Antigravity's own sub-agents (`invoke_subagent`, `swarm`) run inside `agy acp` and are not announced over ACP:
 * the tool update carries only the input. Each one is a conversation of its own with a brain transcript
 * (`~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`). The parent's transcript says
 * which ones it created ("Created the following subagent: {conversationId, logAbsoluteUri}"), so it is tailed
 * while the parent works, and read once when a chat's tasks are first listed (children from before an app
 * restart). Each child is mirrored into a synthetic child thread (`nativeSubagent`) shown in the Tasks panel.
 */

interface SpawnMeta {
  title?: string;
  role?: string;
  model?: string;
  prompt?: string;
}

/** What a kill stops: the listed conversations, a swarm worker by name, the listed roles, or (none) all of the caller's. */
interface KillCall {
  ids?: string[];
  swarm?: string;
  /** Read from a manage_subagents result ("Killed roles: …") whose call is unknown. */
  roles?: string[];
}

/** A tool call whose result has not been read yet: one that starts a sub-agent or kills some (null: neither). */
type AwaitedCall = { kind: 'spawn'; meta: SpawnMeta } | { kind: 'kill'; kill: KillCall } | null;

interface AgyChildWatch extends AgyStepCursor {
  threadId: string;
  rootThreadId: string;
  /** The conversation that started it. */
  parentCid: string;
  lastMtimeMs: number;
  lastSize: number;
  /** When its parent's transcript announced it. */
  announcedAt?: number;
  /** When a kill stopped it (a sub-agent of it found later was stopped with it). */
  killedAt?: number;
}

interface ActiveParentScan {
  rootThreadId: string;
  sessionIds: Set<string>;
  sinceMs: number;
  idleSinceMs?: number;
}

/** A conversation whose transcript is read for the sub-agents it creates (a chat's session, or a sub-agent). */
interface ParentWatch {
  cid: string;
  rootThreadId: string;
  tail: LineTail;
  /** The latest PLANNER_RESPONSE's tool calls whose results have not been read yet. */
  awaiting: AwaitedCall[];
}

let host: NativeSubagentHost | null = null;
const byCid = new Map<string, AgyChildWatch>();
const byThreadId = new Map<string, AgyChildWatch>();
const parents = new Map<string, ParentWatch>();
const parentScans = new Map<string, ActiveParentScan>();
/** Brain dirs already looked at by the fallback scan: the sender of their first message, or null (not a sub-agent). */
const checkedDirs = new Map<string, string | null>();
/** New brain dirs whose first message is not written yet → when the scan first saw them. */
const pendingDirs = new Map<string, number>();
/** A dir with no first message this long after it appeared is not a sub-agent's (sub-agents get their task at once). */
const PENDING_GIVE_UP_MS = 60_000;
/** Child conversation id → thread id, per root chat (read once from disk, then kept up to date). */
const knownChildren = new Map<string, Map<string, string>>();
/** Sub-agents attached since the last liveness check (see checkAttached). */
const unchecked: AgyChildWatch[] = [];
/** Transcript reads in progress (they nest: attaching a child may run a tick). */
let reading = 0;
let lastBrainRootMtime = 0;
let pollTimer: NodeJS.Timeout | null = null;
/** A sub-agent runs inside the `agy acp` process: an unfinished one last written before this process (or this app) started is dead. */
const appStartedAt = Date.now();
let agyProcStartedAt = 0;

const brainDir = () => process.env.OLYMPUS_AGY_BRAIN_DIR || join(homedir(), '.gemini', 'antigravity-cli', 'brain');
const transcriptOf = (cid: string) => join(brainDir(), cid, '.system_generated', 'logs', 'transcript.jsonl');
const isLive = (s: SubTaskView['status']) => s === 'running' || s === 'starting';

/** Binds the runtime host so Antigravity child transcripts stream into `store` and renderer events. */
export function initAgySubagents(h: NativeSubagentHost): void {
  host = h;
}

/** A new `agy acp` process started: sub-agents written to before this moment cannot still be running. */
export function noteAgyProcessStarted(at: number): void {
  agyProcStartedAt = at;
  stopAgyIdleTurns();
}

/** Live state override for `orchestrator.summarize()` on Antigravity sub-agent threads. */
export function agySubagentSummary(threadId: string): {
  status?: SubTaskView['status'];
  canCancel?: boolean;
  error?: string;
  startedAt?: number;
  endedAt?: number;
} | undefined {
  const w = byThreadId.get(threadId);
  return w ? { status: w.status, error: w.error, startedAt: w.startedAt, endedAt: w.endedAt } : undefined;
}

/** Marks live Antigravity sub-agents interrupted if the `agy acp` process exits. */
export function detachAgySubagents(reason: string): void {
  agyProcStartedAt = Date.now(); // whatever runs next is a new process
  stopAgyIdleTurns();
  for (const w of byCid.values()) if (isLive(w.status)) endWatch(w, 'failed', reason);
}

/**
 * Finds the Antigravity sub-agents of a chat that the app has not mirrored yet: the ones its current session
 * created, including before an app restart. Called when the chat's tasks are listed; cheap after the first call.
 */
export function discoverAgySubagents(thread: Thread): void {
  const cid = thread.acpSessions?.antigravity;
  if (!host || !cid || thread.nativeSubagent) return;
  try {
    syncParent(watchParent(cid, rootUserThread(thread).id));
  } catch (e) {
    // Listing the chat's tasks must not fail because a transcript could not be read; the next listing retries.
    console.error('[agy-subagents] reading the parent transcript failed:', e);
  }
}

/** Notifies the watcher when an Antigravity turn starts or finishes on a session. */
export function noteAgyParentTurn(rt: NativeRuntimeHandle, running: boolean, opts: { liveAcp?: boolean } = {}): void {
  if (rt.agentId !== 'antigravity' || !rt.sessionId) return;
  if (host) setAgyIdleTurn(rt, host, !running, opts);
  const root = rootUserThread(rt.thread);
  watchParent(rt.sessionId, root.id);
  const scan = parentScans.get(root.id);
  if (running) {
    if (!scan) parentScans.set(root.id, { rootThreadId: root.id, sessionIds: new Set([rt.sessionId]), sinceMs: Date.now() - 5000 });
    else {
      scan.sessionIds.add(rt.sessionId);
      scan.idleSinceMs = undefined;
    }
    ensurePolling();
  } else if (scan) {
    scan.idleSinceMs = Date.now();
    tick();
  }
}

const toolBaseName = (rawTitle: unknown, rawName?: unknown) =>
  String(rawName ?? rawTitle ?? '').trim().replace(/^Run\s+/i, '').split(/[\s:(]/)[0].toLowerCase();

/** Title, role and model of a sub-agent from its `invoke_subagent` input ({Prompt, Role, TypeName, Model}). */
function invokeMeta(inp: Record<string, any>): SpawnMeta {
  const role = cleanOneLine(inp.Role ?? inp.role, 60);
  const typeName = cleanOneLine(inp.TypeName ?? inp.typeName, 40);
  const prompt = typeof (inp.Prompt ?? inp.prompt) === 'string' ? String(inp.Prompt ?? inp.prompt).trim() : '';
  const model = cleanOneLine(inp.Model ?? inp.model, 50);
  return {
    title: role || cleanOneLine(prompt.split('\n')[0], 72) || 'Sub-agent',
    role: typeName && typeName !== 'self' && typeName.toLowerCase() !== role.toLowerCase() ? (role ? `${role} · ${typeName}` : typeName) : role || typeName || undefined,
    model: model && model !== 'inherit' ? model : undefined,
    prompt: prompt || undefined,
  };
}

/** A swarm worker's card title; `swarm` kill names the worker, so it is matched against this. */
const swarmTitle = (name: unknown) => `Swarm: ${cleanOneLine(name, 50)}`;

/** Title, model and brief of a swarm worker from its `swarm` add input ({action: "add", name, brief, model}). */
function swarmMeta(inp: Record<string, any>): SpawnMeta {
  const name = cleanOneLine(inp.name ?? inp.Name, 50);
  const brief = typeof (inp.brief ?? inp.Brief) === 'string' ? String(inp.brief ?? inp.Brief).trim() : '';
  const model = cleanOneLine(inp.model ?? inp.Model, 50);
  return {
    title: name ? swarmTitle(name) : cleanOneLine(brief.split('\n')[0], 72) || 'Swarm worker',
    role: 'swarm',
    model: model && model !== 'inherit' ? model : undefined,
    prompt: brief || undefined,
  };
}

/** What a tool call means for sub-agents: one it starts, the ones it kills, or nothing. */
function awaitedCall(name: string, inp: Record<string, any>): AwaitedCall {
  const action = cleanOneLine(inp.Action ?? inp.action, 20).toLowerCase();
  if (name === 'invoke_subagent') return { kind: 'spawn', meta: invokeMeta(inp) };
  if (name === 'swarm' && action === 'add') return { kind: 'spawn', meta: swarmMeta(inp) };
  if (name === 'swarm' && action === 'kill' && typeof inp.name === 'string') return { kind: 'kill', kill: { swarm: inp.name } };
  if (name !== 'manage_subagents') return null;
  if (action === 'kill_all') return { kind: 'kill', kill: {} };
  const ids = inp.ConversationIds ?? inp.conversationIds;
  return action === 'kill' && Array.isArray(ids) ? { kind: 'kill', kill: { ids: ids.map(String) } } : null;
}

/**
 * Inspects Antigravity ACP tool events. Sub-agent tools make the parent's transcript worth reading now; a tool
 * update that does carry the "Created the following subagent" result (agy 1.5.8 sends none) attaches the child.
 */
export function onAgyToolEvent(rt: NativeRuntimeHandle, u: any): void {
  if (!host || rt.agentId !== 'antigravity') return;
  const root = rootUserThread(rt.thread);
  if (u?.sessionUpdate === 'tool_call_update') {
    const text = [...(u.content ?? []).map((c: any) => host!.textOf(c.content ?? c)), typeof u.rawOutput === 'string' ? u.rawOutput : u.rawOutput ? JSON.stringify(u.rawOutput) : ''].join('\n');
    const created = parseCreatedSubagents(text, brainDir());
    if (!created.length) return;
    const inp = unwrapArgs(u.rawInput);
    const meta = !u.rawInput ? undefined : cleanOneLine(inp.action, 20).toLowerCase() === 'add' ? swarmMeta(inp) : invokeMeta(inp);
    readBatch(() => {
      for (const c of created) attachAgyChild(c.cid, root.id, rt.sessionId ?? '', c.logFile, meta);
    });
    return;
  }
  if (u?.sessionUpdate !== 'tool_call') return;
  // A live tool call: agy is streaming this work over ACP, so the transcript mirror must not show it again.
  if (rt.sessionId) noteAgyParentTurn(rt, true, { liveAcp: true });
  const name = toolBaseName(u.title, u.name);
  if (name === 'invoke_subagent' || name === 'swarm') ensurePolling();
  // A kill shows at once; its result in the parent's transcript is read too (that also covers an app restart).
  const call = awaitedCall(name, unwrapArgs(u.rawInput));
  if (call?.kind === 'kill' && rt.sessionId) stopKilled(rt.sessionId, call.kill);
}

function endWatch(w: AgyChildWatch, status: SubTaskView['status'], error?: string, at?: number): void {
  if (!host) return;
  w.status = status;
  w.error = error;
  w.endedAt = w.endedAt ?? at ?? Date.now();
  const rt = host.runtimeFor(w.threadId);
  rt.running = false;
  for (const stale of host.interruptStale(rt.thread)) host.pushItem(rt, stale);
  host.emitMeta(threadMeta(rt.thread));
  host.pushSession(rt);
}

/**
 * Ends the sub-agents a kill stopped as cancelled, with the ones they started ("… and their descendants"):
 * the listed conversations, else the caller's own sub-agents (all, or the swarm worker or roles named).
 */
function stopKilled(callerCid: string, kill: KillCall, at = Date.now()): void {
  const titleOf = (w: AgyChildWatch) => findThread(w.threadId)?.title.toLowerCase() ?? '';
  const swarm = kill.swarm === undefined ? undefined : swarmTitle(kill.swarm).toLowerCase();
  const roles = kill.roles?.map((r) => cleanOneLine(r, 60).toLowerCase());
  const hit = (w: AgyChildWatch) =>
    kill.ids ? kill.ids.includes(w.cid) : w.parentCid === callerCid && (swarm !== undefined ? titleOf(w) === swarm : roles ? roles.includes(titleOf(w)) : true);
  const stopped = new Set([...byCid.values()].filter(hit));
  for (let grew = stopped.size > 0; grew; ) {
    grew = false;
    for (const w of byCid.values()) {
      if (!stopped.has(w) && [...stopped].some((s) => s.cid === w.parentCid)) {
        stopped.add(w);
        grew = true;
      }
    }
  }
  for (const w of stopped) {
    w.killedAt = w.killedAt ?? at;
    if (isLive(w.status)) endWatch(w, 'cancelled', undefined, at);
  }
}

function watchParent(cid: string, rootThreadId: string): ParentWatch {
  let pw = parents.get(cid);
  if (!pw) {
    pw = { cid, rootThreadId, tail: { file: transcriptOf(cid), offset: 0, rest: Buffer.alloc(0) }, awaiting: [] };
    parents.set(cid, pw);
  }
  return pw;
}

/**
 * Reads what a parent conversation wrote since last time. Tool results follow their PLANNER_RESPONSE in call
 * order, so the result announcing a child is paired with the `invoke_subagent` / swarm add call (role, model)
 * behind it, and a kill's result with the kill call (which sub-agents it stopped).
 */
function syncParent(pw: ParentWatch): void {
  readBatch(() => {
    for (const line of readNewLines(pw.tail)) {
      const type = /"type":"([A-Z_]+)"/.exec(line.slice(0, 200))?.[1];
      if (type === 'PLANNER_RESPONSE') {
        if (!line.includes('"tool_calls"')) continue;
        const step = parseLine(line);
        const calls: any[] = Array.isArray(step?.tool_calls) ? step.tool_calls : [];
        pw.awaiting = calls.map((tc) => awaitedCall(String(tc?.name ?? ''), unwrapArgs(tc?.args)));
      } else if (type === 'GENERIC') {
        const call = pw.awaiting.shift() ?? null;
        // Most results are not about sub-agents: skip them unparsed (a long chat's transcript is several MB).
        if (line.includes('Created the following subagent')) {
          const step = parseLine(line);
          const announcedAt = Date.parse(step?.created_at ?? '') || undefined;
          for (const c of parseCreatedSubagents(step?.content, brainDir())) {
            const meta = call?.kind === 'spawn' ? call.meta : takeFirst(pw, 'spawn')?.meta;
            attachAgyChild(c.cid, pw.rootThreadId, pw.cid, c.logFile, meta, announcedAt);
          }
        } else if (call?.kind === 'kill' || line.includes('Successfully killed')) {
          syncKill(pw, call, parseLine(line));
        }
      }
    }
  });
}

/**
 * A kill's result: "Successfully killed N subagent(s) and their descendants.\nKilled roles: …" (manage_subagents),
 * or a swarm kill's "… killed". The children it stopped just stop writing; they are cancelled, not crashed.
 */
function syncKill(pw: ParentWatch, call: AwaitedCall, step: any): void {
  const content = typeof step?.content === 'string' ? step.content : '';
  const kill = call?.kind === 'kill' ? call.kill : takeFirst(pw, 'kill')?.kill;
  const ok = kill?.swarm !== undefined ? /\bkilled\b/i.test(content) : content.includes('Successfully killed');
  if (!ok || step?.status === 'ERROR') return;
  const roles = /^Killed roles:[ \t]*(.+)$/m.exec(content)?.[1].split(', ') ?? [];
  stopKilled(pw.cid, kill ?? { roles }, Date.parse(step?.created_at ?? '') || undefined);
}

/** Results arrived out of call order: the next unread call of that kind in the same response. */
function takeFirst<K extends 'spawn' | 'kill'>(pw: ParentWatch, kind: K): Extract<AwaitedCall, { kind: K }> | undefined {
  const at = pw.awaiting.findIndex((c) => c?.kind === kind);
  return at < 0 ? undefined : (pw.awaiting.splice(at, 1, null)[0] as Extract<AwaitedCall, { kind: K }>);
}

function parseLine(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined; // only complete lines are read, so this is a record agy itself wrote broken
  }
}

function childThreadFor(root: Thread, cid: string): Thread | undefined {
  let known = knownChildren.get(root.id);
  if (!known) {
    known = new Map(listThreads(root.projectId).filter((m) => m.nativeSubagent && m.parentId === root.id && m.nativeSessionId).map((m) => [m.nativeSessionId!, m.id]));
    knownChildren.set(root.id, known);
  }
  const id = known.get(cid);
  return id ? findThread(id) : undefined;
}

function attachAgyChild(cid: string, rootThreadId: string, parentCid: string, logFile: string, meta?: SpawnMeta, announcedAt?: number): AgyChildWatch | undefined {
  if (!host) return undefined;
  const existing = byCid.get(cid);
  if (existing) {
    // Found first by the fallback scan (titled from its prompt): the parent's call has the real role and model.
    const t = findThread(existing.threadId);
    if (t && meta?.title && t.subagentRole === 'subagent') {
      Object.assign(t, { title: meta.title, subagentRole: meta.role, subagentModel: meta.model });
      saveThread(t);
      host.emitMeta(threadMeta(t));
    }
    syncWatch(existing);
    return existing;
  }
  const root = findThread(rootThreadId);
  if (!root) return undefined;

  let child = childThreadFor(root, cid);
  if (!child) {
    child = createThread(root.projectId, 'antigravity', {
      title: meta?.title || 'Sub-agent',
      parentId: root.id,
      mode: root.mode,
      nativeSubagent: true,
      nativeSessionId: cid,
      subagentRole: meta?.role,
      subagentModel: meta?.model,
      task: meta?.prompt,
    });
    knownChildren.get(root.id)?.set(cid, child.id);
    if (meta?.prompt) {
      child.items.push({ kind: 'user', id: `${cid}:seed:0`, agentId: 'antigravity', fromAgent: 'antigravity', text: meta.prompt, ts: Date.now() });
      saveThread(child);
    }
  }

  parentScans.get(root.id)?.sessionIds.add(cid);
  watchParent(cid, root.id); // a sub-agent may start sub-agents of its own
  const watch: AgyChildWatch = {
    cid,
    threadId: child.id,
    rootThreadId: root.id,
    parentCid,
    logFile,
    parsedLines: 0,
    lastMtimeMs: 0,
    lastSize: 0,
    announcedAt,
    pendingToolItemIds: [],
    status: 'running',
    startedAt: child.createdAt,
    lastActivityAt: Date.now(),
  };
  byCid.set(cid, watch);
  byThreadId.set(child.id, watch);

  const rt = host.runtimeFor(child.id);
  rt.running = true;
  host.emitMeta(threadMeta(child));
  host.pushSession(rt);
  syncWatch(watch);
  // Whether it is still alive is decided once the read that found it is done: a kill may come later in it.
  unchecked.push(watch);
  ensurePolling();
  return watch;
}

/** Runs transcript reads; the sub-agents they attached are checked when the outermost read is done. */
function readBatch(fn: () => void): void {
  reading++;
  try {
    fn();
  } finally {
    if (--reading === 0) checkAttached();
  }
}

/** Ends the newly attached sub-agents that cannot be running: killed with their parent, or dead with their process. */
function checkAttached(): void {
  for (const w of unchecked.splice(0)) {
    if (!isLive(w.status)) continue;
    const killedAt = byCid.get(w.parentCid)?.killedAt;
    if (killedAt !== undefined) {
      w.killedAt = killedAt;
      endWatch(w, 'cancelled', undefined, killedAt);
      continue;
    }
    // No final answer, and its transcript was last written (or, if it has none, it was started) before the agy
    // process that ran it (or this app) started: it died with that process.
    const lastWrite = w.lastMtimeMs || w.announcedAt || Date.now();
    if (lastWrite < Math.max(appStartedAt, agyProcStartedAt)) {
      endWatch(w, 'failed', w.lastMtimeMs ? 'Stopped before it finished: the Antigravity process that ran it has exited.' : 'Its transcript is gone: Antigravity removed this sub-agent.');
    }
  }
}

/** Fallback for children no parent transcript announces: new brain dirs whose first message came from a watched session. */
function scanBrainForChildren(): void {
  if (!parentScans.size) return;
  const rootDir = brainDir();
  if (!existsSync(rootDir)) return; // agy has not created its brain folder yet
  const rootMtime = statSync(rootDir).mtimeMs;
  let names: string[];
  if (rootMtime > lastBrainRootMtime) {
    lastBrainRootMtime = rootMtime;
    names = readdirSync(rootDir);
  } else if (pendingDirs.size) {
    names = [...pendingDirs.keys()]; // no new dirs: only the ones still waiting for their first message
  } else {
    return;
  }

  const now = Date.now();
  const minSince = Math.min(...[...parentScans.values()].map((s) => s.sinceMs));
  for (const name of names) guarded(`checking brain dir ${name}`, () => scanBrainDir(rootDir, name, minSince, now));
}

function scanBrainDir(rootDir: string, name: string, minSince: number, now: number): void {
  if (byCid.has(name) || checkedDirs.get(name) === null) {
    pendingDirs.delete(name);
    return;
  }
  const dir = join(rootDir, name);
  const logFile = join(dir, '.system_generated', 'logs', 'transcript.jsonl');
  let sender = checkedDirs.get(name);
  let prompt: string | undefined;
  if (sender === undefined) {
    const st = existsSync(dir) ? statSync(dir) : undefined;
    if (!st?.isDirectory() || st.mtimeMs < minSince) {
      pendingDirs.delete(name);
      return;
    }
    const first = readFirstMessage(logFile);
    // A brand-new dir: its transcript (or its first line) is still being written, so look again next tick;
    // one that stays empty (a session never prompted) is given up on.
    if (!first.complete) {
      const seen = pendingDirs.get(name);
      if (seen === undefined) pendingDirs.set(name, now);
      else if (now - seen > PENDING_GIVE_UP_MS) {
        pendingDirs.delete(name);
        checkedDirs.set(name, null);
      }
      return;
    }
    pendingDirs.delete(name);
    sender = first.sender ?? null;
    prompt = first.prompt;
    checkedDirs.set(name, sender);
  }
  if (!sender) return;
  for (const scan of parentScans.values()) {
    if (scan.sessionIds.has(sender)) {
      attachAgyChild(name, scan.rootThreadId, sender, logFile, prompt ? { title: cleanOneLine(prompt.split('\n')[0], 72) || 'Sub-agent', role: 'subagent', prompt } : undefined);
      return;
    }
  }
}

function syncWatch(w: AgyChildWatch): void {
  if (!host) return;
  let raw: string;
  try {
    const s = statSync(w.logFile);
    if (s.mtimeMs === w.lastMtimeMs && s.size === w.lastSize) return;
    raw = readFileSync(w.logFile, 'utf8');
    w.lastMtimeMs = s.mtimeMs;
    w.lastSize = s.size;
    w.lastActivityAt = s.mtimeMs;
  } catch (e) {
    // Not written yet (agy creates the folder first), or unreadable right now: the next tick looks again.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[agy-subagents] reading a sub-agent transcript failed:', e);
    return;
  }
  const rt = host.runtimeFor(w.threadId);
  if (syncAgyTranscriptLines(host, rt, w, raw)) {
    saveThread(rt.thread);
    host.emitMeta(threadMeta(rt.thread));
    host.pushSession(rt);
  }
}

function tick(): void {
  try {
    readBatch(tickOnce);
  } catch (e) {
    console.error('[agy-subagents] poll failed:', e);
  }
}

/** One transcript that cannot be read (removed or broken mid-read) is logged and skipped; the others still update. */
function guarded(what: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error(`[agy-subagents] ${what} failed:`, e);
  }
}

function tickOnce(): void {
  const now = Date.now();
  let anyActive = false;
  for (const [rootId, scan] of parentScans) {
    if (!scan.idleSinceMs || now - scan.idleSinceMs <= 15_000) anyActive = true;
    else parentScans.delete(rootId);
  }
  // Parents are read while their chat works, or while they are themselves a running sub-agent.
  for (const pw of parents.values()) {
    if (parentScans.has(pw.rootThreadId) || isLive(byCid.get(pw.cid)?.status ?? 'done')) guarded(`reading parent transcript ${pw.cid}`, () => syncParent(pw));
  }
  guarded('scanning the brain folder', scanBrainForChildren);
  for (const w of byCid.values()) {
    guarded(`reading sub-agent transcript ${w.cid}`, () => syncWatch(w));
    if (isLive(w.status) && now - w.lastActivityAt < 20 * 60_000) anyActive = true;
  }
  if (!anyActive && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function ensurePolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(tick, 600);
  pollTimer.unref?.();
  tick();
}
