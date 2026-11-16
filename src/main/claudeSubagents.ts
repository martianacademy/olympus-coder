/**
 * Mirrors Claude Code's on-disk sub-agents (`subagents/agent-*.jsonl`) and workflow workers
 * (`subagents/workflows/wf_<id>/agent-*.jsonl` + `journal.jsonl`) into Olympus's right-panel `Tasks`.
 *
 * Deduplicates against ACP-streamed sub-agents (`nativeSubagents.ts`) so foreground/background
 * agents already forwarded over ACP never appear twice or receive duplicate chat items.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SubTaskView, Thread } from '@shared/types';
import { createThread, findThread, getProject, listThreads, saveThread, threadMeta } from './store';
import {
  applyClaudeRecords,
  journalResultText,
  parseRecord,
  parseTaskNotification,
  parseWorkflowLaunch,
  type ClaudeChildCursor,
  type JournalEntry,
} from './claudeTranscript';
import { cleanOneLine, readNewLines, type LineTail } from './agyTranscript';
import { nativeSubagentSummary, rootUserThread, type NativeRuntimeHandle, type NativeSubagentHost } from './nativeSubagents';

interface Watch {
  key: string;
  threadId: string;
  rootThreadId: string;
  sessionId: string;
  cursor: ClaudeChildCursor;
  tail: LineTail;
  journal?: LineTail;
  workflow?: boolean;
  lastSize: number;
}

interface ParentWatch {
  rootThreadId: string;
  tail: LineTail;
  running: boolean;
  graceUntil: number;
}

const POLL_MS = 500;
const PARENT_GRACE_MS = 15_000;
const STALE_MS = 90_000;

let host: NativeSubagentHost | null = null;
let poller: NodeJS.Timeout | undefined;
const watches = new Map<string, Watch>();
const parents = new Map<string, ParentWatch>();

const projectsDir = () => process.env.OLYMPUS_CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects');
const projectSlug = (root: Thread) => (getProject(root.projectId)?.path ?? process.cwd()).replaceAll('/', '-');
const sessionDir = (sid: string, root: Thread) => join(projectsDir(), projectSlug(root), sid);
const isLive = (s: SubTaskView['status']) => s === 'starting' || s === 'running';

/** Binds the common host used by ACP native sub-agents and Antigravity transcript mirroring. */
export function initClaudeSubagents(h: NativeSubagentHost): void {
  host = h;
}

/** Returns a live summary for a transcript-backed child when `TasksPanel` summarizes it. */
export function claudeSubagentSummary(threadId: string): Pick<SubTaskView, 'status' | 'canCancel' | 'error' | 'startedAt' | 'endedAt'> | undefined {
  const watch = [...watches.values()].find((item) => item.threadId === threadId);
  return watch
    ? { status: watch.cursor.status, canCancel: false, error: watch.cursor.error, startedAt: watch.cursor.startedAt, endedAt: watch.cursor.endedAt }
    : undefined;
}

/** Scans an already-open Claude parent session once, including children created before app restart. */
export function discoverClaudeSubagents(thread: Thread): void {
  const sid = thread.acpSessions?.claude;
  if (!host || !sid || thread.nativeSubagent) return;
  try {
    const root = rootUserThread(thread);
    const parent = watchParent(sid, root.id);
    syncParent(sid, parent);
    discoverFiles(sid, root);
    for (const watch of watches.values()) {
      if (watch.sessionId === sid) syncChild(watch);
    }
  } catch (error) {
    console.error('[claude-subagents] discover failed:', error);
  }
}

/** Starts or winds down polling as a Claude parent session starts and ends turns. */
export function noteClaudeParentTurn(rt: NativeRuntimeHandle, running: boolean): void {
  if (rt.agentId !== 'claude' || !rt.sessionId) return;
  const root = rootUserThread(rt.thread);
  const parent = watchParent(rt.sessionId, root.id);
  parent.running = running;
  parent.graceUntil = running ? Number.POSITIVE_INFINITY : Date.now() + PARENT_GRACE_MS;
  if (running) {
    syncParent(rt.sessionId, parent);
    discoverFiles(rt.sessionId, root);
    startPolling();
  } else {
    tick();
  }
}

function watchParent(sid: string, rootThreadId: string): ParentWatch {
  let parent = parents.get(sid);
  if (!parent) {
    const root = findThread(rootThreadId);
    const slug = root ? projectSlug(root) : process.cwd().replaceAll('/', '-');
    parent = {
      rootThreadId,
      tail: { file: join(projectsDir(), slug, `${sid}.jsonl`), offset: 0, rest: Buffer.alloc(0) },
      running: false,
      graceUntil: 0,
    };
    parents.set(sid, parent);
  }
  return parent;
}

function syncParent(sid: string, parent: ParentWatch): void {
  for (const line of readNewLines(parent.tail)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rawObj: Record<string, unknown>;
    try {
      rawObj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const notif = parseTaskNotification(rawObj);
    if (notif) {
      for (const taskId of notif.taskIds) {
        const watch =
          watches.get(`${sid}:${taskId}`) ??
          [...watches.values()].find((w) => w.sessionId === sid && w.cursor.agentId === taskId);
        if (watch) {
          const nextStatus =
            notif.status === 'failed'
              ? 'failed'
              : notif.status === 'killed' || notif.status === 'stopped'
                ? 'cancelled'
                : 'done';
          finish(watch, nextStatus, notif.at);
        }
      }
    }
    const launch = parseWorkflowLaunch(rawObj);
    const root = findThread(parent.rootThreadId);
    if (launch && root) discoverFiles(sid, root, launch.name);
  }
}

function discoverFiles(sid: string, root: Thread, workflowName?: string): void {
  const sessionPath = sessionDir(sid, root);
  if (!existsSync(sessionPath)) return;
  const subDir = join(sessionPath, 'subagents');
  if (!existsSync(subDir)) return;
  const files: { file: string; id: string; title?: string; workflow?: boolean; journal?: string }[] = [];
  const visit = (dir: string, workflow?: boolean, journal?: string): void => {
    for (const name of safeReadDir(dir)) {
      const path = join(dir, name);
      if (name.endsWith('.jsonl') && name.startsWith('agent-')) {
        files.push({
          file: path,
          id: name.slice('agent-'.length, -'.jsonl'.length),
          title: workflow ? workflowName : undefined,
          workflow,
          journal,
        });
      } else if ((name === 'workflows' || name.startsWith('wf_')) && isDirSafe(path)) {
        const j = join(path, 'journal.jsonl');
        visit(path, true, existsSync(j) ? j : journal);
      }
    }
  };
  visit(subDir);
  for (const file of files) attach(sid, root, file);
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirSafe(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isAcpManagedChild(thread: Thread, agentId: string): boolean {
  if (nativeSubagentSummary(thread.id)) return true;
  // An ACP-streamed child stores random UUID item ids; a JSONL-mirrored child prefixes ids with `<agentId>:`.
  return thread.items.some((item) => !item.id.startsWith(`${agentId}:`));
}

function attach(
  sid: string,
  root: Thread,
  file: { file: string; id: string; title?: string; workflow?: boolean; journal?: string },
): void {
  if (!host || !file.id) return;
  const key = `${sid}:${file.id}`;
  if (watches.has(key)) return;

  const existingMeta = listThreads(root.projectId).find(
    (meta) =>
      meta.nativeSubagent &&
      meta.parentId === root.id &&
      (meta.nativeSessionId === file.id || meta.nativeSessionId?.startsWith(`${file.id}:generation:`)),
  );
  const existingThread = existingMeta ? findThread(existingMeta.id) : undefined;
  // Never double-append items onto a child that `nativeSubagents.ts` is already streaming over ACP.
  if (existingThread && isAcpManagedChild(existingThread, file.id)) return;

  const thread =
    existingThread ??
    createThread(root.projectId, 'claude', {
      title: file.title || 'Sub-agent',
      parentId: root.id,
      mode: root.mode,
      nativeSubagent: true,
      nativeSessionId: file.id,
      subagentRole: file.workflow ? 'Workflow' : undefined,
    });
  if (file.title && thread.title === 'Sub-agent') {
    thread.title = file.title;
    saveThread(thread);
  }

  const rt = host.runtimeFor(thread.id);
  const cursor: ClaudeChildCursor = {
    agentId: file.id,
    status: 'running',
    startedAt: thread.createdAt,
    lastRecordAt: 0,
  };
  const watch: Watch = {
    key,
    threadId: thread.id,
    rootThreadId: root.id,
    sessionId: sid,
    cursor,
    tail: { file: file.file, offset: 0, rest: Buffer.alloc(0) },
    journal: file.journal ? { file: file.journal, offset: 0, rest: Buffer.alloc(0) } : undefined,
    workflow: file.workflow,
    lastSize: 0,
  };
  watches.set(key, watch);
  rt.running = true;
  host.emitMeta(threadMeta(thread));
  host.pushSession(rt);
  syncChild(watch);
  if (isLive(watch.cursor.status)) startPolling();
}

function syncChild(watch: Watch): void {
  if (!host) return;
  const rt = host.runtimeFor(watch.threadId);
  const lines = readNewLines(watch.tail);
  let changed = lines.length > 0 && applyClaudeRecords(host, rt, watch.cursor, lines);

  if (watch.cursor.model && rt.thread.subagentModel !== watch.cursor.model) {
    rt.thread.subagentModel = watch.cursor.model;
    changed = true;
  }
  if (rt.thread.title === 'Sub-agent' && rt.thread.task) {
    const firstLine = cleanOneLine(rt.thread.task.split('\n')[0], 72);
    if (firstLine) {
      rt.thread.title = firstLine;
      changed = true;
    }
  }

  if (watch.journal) {
    for (const line of readNewLines(watch.journal)) {
      let entry: JournalEntry;
      try {
        entry = JSON.parse(line) as JournalEntry;
      } catch {
        continue;
      }
      if (entry.agentId && entry.agentId !== watch.cursor.agentId) continue;
      if (entry.type === 'started' && entry.label) {
        const nextTitle = cleanOneLine(entry.phase ? `${entry.label} (${entry.phase})` : entry.label, 80);
        if (nextTitle && rt.thread.title !== nextTitle) {
          rt.thread.title = nextTitle;
          changed = true;
        }
      }
      if (entry.type === 'result') {
        const resText = journalResultText(entry.result);
        if (resText && !watch.cursor.reported) {
          const itemId = `${watch.cursor.agentId}:journal-result`;
          if (!rt.thread.items.some((x) => x.id === itemId)) {
            host.addItem(rt, { kind: 'agent', id: itemId, agentId: 'claude', text: resText, ts: Date.now() });
          }
          watch.cursor.reported = true;
        }
        changed = finish(watch, 'done') || changed;
      }
      if (entry.type === 'failed') {
        changed = finish(watch, 'failed', Date.now(), `Workflow agent ${entry.agentId ?? ''} failed`.trim()) || changed;
      }
    }
  }

  const size = existsSync(watch.tail.file) ? statSync(watch.tail.file).size : 0;
  if (size > watch.lastSize) {
    watch.lastSize = size;
    if (!watch.cursor.lastRecordAt) watch.cursor.lastRecordAt = Date.now();
  }
  if (isLive(watch.cursor.status) && watch.cursor.lastRecordAt && Date.now() - watch.cursor.lastRecordAt > STALE_MS) {
    finish(watch, 'done', watch.cursor.lastRecordAt);
  }
  if (changed) {
    saveThread(rt.thread);
    host.emitMeta(threadMeta(rt.thread));
    host.pushSession(rt);
  }
}

function finish(watch: Watch, status: 'done' | 'failed' | 'cancelled', at = Date.now(), error?: string): boolean {
  if (!host || !isLive(watch.cursor.status)) return false;
  watch.cursor.status = status;
  watch.cursor.endedAt = at;
  watch.cursor.error = error;
  const rt = host.runtimeFor(watch.threadId);
  rt.running = false;
  for (const item of host.interruptStale(rt.thread)) host.pushItem(rt, item);
  saveThread(rt.thread);
  host.emitMeta(threadMeta(rt.thread));
  host.pushSession(rt);
  return true;
}

function shouldKeepPolling(now = Date.now()): boolean {
  for (const p of parents.values()) {
    if (p.running || now < p.graceUntil) return true;
  }
  for (const w of watches.values()) {
    if (isLive(w.cursor.status)) return true;
  }
  return false;
}

function tick(): void {
  const now = Date.now();
  for (const [sid, parent] of parents) {
    if (!parent.running && now >= parent.graceUntil) continue;
    try {
      syncParent(sid, parent);
      const root = findThread(parent.rootThreadId);
      if (root) discoverFiles(sid, root);
    } catch (error) {
      console.error('[claude-subagents] parent scan failed:', error);
    }
  }
  for (const watch of watches.values()) {
    if (!isLive(watch.cursor.status)) continue;
    try {
      syncChild(watch);
    } catch (error) {
      console.error('[claude-subagents] child scan failed:', error);
    }
  }
  if (!shouldKeepPolling(now)) stopPolling();
}

function startPolling(): void {
  if (!poller) {
    poller = setInterval(tick, POLL_MS);
    poller.unref?.();
  }
}

function stopPolling(): void {
  if (poller) clearInterval(poller);
  poller = undefined;
}
