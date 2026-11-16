/**
 * Purpose:
 * Tracks ACP work that starts after a prompt has finished.
 *
 * Responsibilities:
 * - Render async task lifecycle updates as existing tool steps.
 * - Give autonomous agent turns normal running, Stop, checkpoint, and turn-end behavior.
 * - Queue prompts received while an autonomous turn is active.
 */
import { randomUUID } from 'node:crypto';
import type { ThreadItem } from '@shared/types';

interface AgentInitiatedRuntime {
  thread: { id: string; items: ThreadItem[]; nativeSubagent?: unknown };
  agentId: string;
  sessionId?: string;
  running: boolean;
  pendingPerms?: Map<string, unknown>;
  pendingElicits?: Map<string, unknown>;
  turn: { agentItemId?: string; thoughtItemId?: string; planItemId?: string };
  toolItems: Map<string, string>;
  conn?: { conn?: { agent: { request(method: string, params: unknown): Promise<unknown> } } };
}

interface ActiveTurn {
  userItem: Extract<ThreadItem, { kind: 'user' }>;
  before: Promise<string | undefined>;
  startedAtIndex: number;
  hasTaskLifecycle: boolean;
  settleTimer?: NodeJS.Timeout;
  ended: boolean;
}

interface AsyncTaskItem {
  item?: Extract<ThreadItem, { kind: 'tool' }>;
  autonomousTurn: boolean;
  canStop: boolean;
}

interface AgentInitiatedHost {
  addItem: (rt: AgentInitiatedRuntime, item: ThreadItem) => ThreadItem;
  pushItem: (rt: AgentInitiatedRuntime, item: ThreadItem, throttle?: boolean) => void;
  pushSession: (rt: AgentInitiatedRuntime) => void;
  snapshotBefore: (rt: AgentInitiatedRuntime, label: string) => Promise<string | undefined>;
  finishCheckpoint: (rt: AgentInitiatedRuntime, item: ThreadItem, before: string) => Promise<void>;
  onTurnEnd: (threadId: string) => void;
}

let host: AgentInitiatedHost | undefined;
const activeTurns = new Map<string, ActiveTurn>();
const tasksByThread = new Map<string, Map<string, AsyncTaskItem>>();
const promptQueues = new Map<string, { draining: boolean; pending: Array<() => Promise<void>> }>();
const pausedPromptDrains = new Set<string>();
const ORIGINAL_UPDATE_META = 'olympusCoder.originalSessionUpdate';
export const ORIGINAL_AUTH_METHOD_META = 'olympusCoder.rawAuthMethod';
const SDK_V1_SESSION_UPDATES = new Set([
  'user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan', 'plan_update',
  'plan_removed', 'available_commands_update', 'current_mode_update', 'config_option_update', 'session_info_update',
  'usage_update', 'notice', 'compaction_update', 'compaction_summary_chunk', 'subagent_update', 'session_message',
  'session_message_chunk',
]);

/** Binds turn and persistence operations from the ACP runtime. */
export function initAgentInitiated(h: AgentInitiatedHost): void {
  host = h;
}

/** Preserves adapter-specific session updates and raw `authMethods` fields through ACP v1's strict SDK validator. */
export function preserveUnknownSessionUpdates(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) controller.enqueue(encoder.encode(rewriteSessionUpdateLine(line) + '\n'));
    },
    flush(controller) {
      buffered += decoder.decode();
      if (buffered) controller.enqueue(encoder.encode(rewriteSessionUpdateLine(buffered)));
    },
  }));
}

/** Restores a raw adapter update carried through the SDK's known v1 notification shape. */
export function unwrapSessionUpdate(update: any): any {
  return update?._meta?.[ORIGINAL_UPDATE_META] ?? update;
}

function rewriteSessionUpdateLine(line: string): string {
  if (!line.trim()) return line;
  try {
    const message = JSON.parse(line);
    if (Array.isArray(message?.result?.authMethods) && message.result.authMethods.length > 0) {
      let wrapped = false;
      message.result.authMethods = message.result.authMethods.map((m: any) => {
        if (!m || typeof m !== 'object' || m._meta?.[ORIGINAL_AUTH_METHOD_META]) return m;
        wrapped = true;
        const { _meta, ...rest } = m;
        const cleanMeta = _meta && typeof _meta === 'object' ? _meta : {};
        return { ...m, _meta: { ...cleanMeta, [ORIGINAL_AUTH_METHOD_META]: { ...rest, ...(_meta ? { _meta } : {}) } } };
      });
      if (wrapped) return JSON.stringify(message);
    }
    const update = message?.params?.update;
    if (message?.method !== 'session/update' || !update || SDK_V1_SESSION_UPDATES.has(update.sessionUpdate)) return line;
    message.params.update = { sessionUpdate: 'session_info_update', _meta: { [ORIGINAL_UPDATE_META]: update } };
    return JSON.stringify(message);
  } catch {
    return line;
  }
}

const IDLE_TURN_SETTLE_MS = 2_500;

/** Starts a distinct, checkpointed turn for work initiated by the agent. */
export function beginAgentInitiatedTurn(rt: AgentInitiatedRuntime, cause?: string, hasTaskLifecycle = false): void {
  if (!host || rt.thread.nativeSubagent) return;
  const existing = activeTurns.get(rt.thread.id);
  if (existing) {
    if (hasTaskLifecycle) {
      existing.hasTaskLifecycle = true;
      clearSettleTimer(existing);
    } else {
      scheduleIdleSettle(rt, existing);
    }
    return;
  }
  const userItem: Extract<ThreadItem, { kind: 'user' }> = {
    kind: 'user',
    id: randomUUID(),
    agentId: rt.agentId,
    fromApp: true,
    agentInitiated: true,
    text: cause?.trim() || 'Agent-initiated work',
    ts: Date.now(),
  };
  const active: ActiveTurn = {
    userItem,
    before: host.snapshotBefore(rt, userItem.text),
    startedAtIndex: rt.thread.items.length,
    hasTaskLifecycle,
    ended: false,
  };
  activeTurns.set(rt.thread.id, active);
  rt.running = true;
  rt.turn = {};
  host.addItem(rt, userItem);
  host.pushSession(rt);
  if (!hasTaskLifecycle) scheduleIdleSettle(rt, active);
}

/** Refreshes idle settle tracking and handles explicit end-of-turn notifications. */
export function noteAgentInitiatedUpdate(rt: AgentInitiatedRuntime, update: any): boolean {
  const kind = String(update?.sessionUpdate ?? '');
  if (kind === 'end_of_turn' || kind === '_end_of_turn') {
    endAgentInitiatedTurn(rt);
    return true;
  }
  const active = activeTurns.get(rt.thread.id);
  if (active && !active.hasTaskLifecycle) scheduleIdleSettle(rt, active);
  return false;
}

/** Handles async task notifications so the renderer can use its existing tool-step UI. */
export function handleAsyncTaskUpdate(rt: AgentInitiatedRuntime, update: any): boolean {
  const kind = String(update?.sessionUpdate ?? '');
  if (!['async_task_spawned', '_async_task_spawned', 'async_task_progress', '_async_task_progress', 'async_task_state_update', '_async_task_state_update'].includes(kind)) return false;
  const taskId = String(update.asyncTaskId ?? update.taskId ?? '');
  if (!taskId || !host) return true;
  const state = getTaskMap(rt.thread.id);

  if (kind.endsWith('spawned')) {
    const autonomousTurn = update.taskType === 'turn' || update.name === 'Claude is working';
    if (autonomousTurn) beginAgentInitiatedTurn(rt, update.description ?? update.name, true);
    const existing = state.get(taskId);
    if (existing?.item) {
      existing.autonomousTurn ||= autonomousTurn;
      if (update.description) existing.item.summary = String(update.description);
      host.pushItem(rt, existing.item, true);
      return true;
    }
    const linkedItem = typeof update.toolCallId === 'string' ? getToolItem(rt, update.toolCallId) : undefined;
    const showInTranscript = update.showInTranscript !== false && !autonomousTurn;
    if (linkedItem) {
      linkedItem.status = 'in_progress';
      if (update.description) linkedItem.summary = String(update.description);
      state.set(taskId, { item: linkedItem, autonomousTurn, canStop: update.canStop !== false });
      host.pushItem(rt, linkedItem, true);
      return true;
    }
    if (!showInTranscript) {
      state.set(taskId, { autonomousTurn, canStop: update.canStop !== false });
      return true;
    }
    const item: Extract<ThreadItem, { kind: 'tool' }> = {
      kind: 'tool',
      id: randomUUID(),
      agentId: rt.agentId,
      toolCallId: `async:${taskId}`,
      title: cleanText(update.name) || cleanText(update.taskType) || 'Background task',
      summary: cleanText(update.description),
      toolKind: 'execute',
      status: 'in_progress',
      content: [],
      locations: [],
      ts: Date.now(),
    };
    state.set(taskId, { item, autonomousTurn, canStop: update.canStop !== false });
    host.addItem(rt, item);
    return true;
  }

  const task = state.get(taskId);
  if (!task) return true;
  if (kind.endsWith('progress')) {
    const summary = cleanText(update.summary) || cleanText(update.description) || cleanText(update.lastToolName);
    if (summary && task.item) task.item.summary = summary;
    if (update.outputFilePath && task.item && task.item.content.length === 0) {
      task.item.content = [{ type: 'text', text: `Output file: ${String(update.outputFilePath)}` }];
    }
    if (task.item) host.pushItem(rt, task.item, true);
    return true;
  }
  const terminal = String(update.state?.state ?? update.state ?? update.status ?? '').toLowerCase();
  const status = ['completed', 'done', 'succeeded'].includes(terminal)
    ? 'completed'
    : ['failed', 'error'].includes(terminal)
      ? 'failed'
      : ['stopped', 'cancelled', 'canceled'].includes(terminal)
        ? 'cancelled'
        : 'in_progress';
  if (task.item) {
    task.item.status = status;
    if (status !== 'in_progress') task.item.endedAt = Date.now();
    if (update.summary) task.item.summary = cleanText(update.summary) ?? task.item.summary;
    host.pushItem(rt, task.item, true);
  }
  if (status !== 'in_progress') {
    state.delete(taskId);
    if (task.autonomousTurn) endAgentInitiatedTurn(rt);
  }
  return true;
}

/** Queues a prompt instead of rejecting it while an autonomous turn owns the session. */
export function queuePromptDuringAgentTurn(rt: AgentInitiatedRuntime, send: () => Promise<void>): boolean {
  if (!activeTurns.has(rt.thread.id)) return false;
  const queue = promptQueues.get(rt.thread.id) ?? { draining: false, pending: [] };
  queue.pending.push(send);
  promptQueues.set(rt.thread.id, queue);
  return true;
}

/** Ends an autonomous turn when its ACP process exits before sending a terminal task update. */
export function interruptAgentInitiatedTurn(rt: AgentInitiatedRuntime): void {
  endAgentInitiatedTurn(rt);
}

/** Resumes the FIFO of prompts queued behind an autonomous turn. */
export function drainQueuedPrompts(rt: AgentInitiatedRuntime): void {
  drainPromptQueue(rt.thread.id);
}

/** Holds queued prompt dispatch until a Stop request has reached the agent. */
export function pauseQueuedPrompts(rt: AgentInitiatedRuntime, paused: boolean): void {
  if (paused) pausedPromptDrains.add(rt.thread.id);
  else {
    pausedPromptDrains.delete(rt.thread.id);
    drainPromptQueue(rt.thread.id);
  }
}

/** Stops async tasks using the adapter extension, then guarantees any autonomous turn unwinds. */
export async function stopAsyncTasks(rt: AgentInitiatedRuntime, onlyTaskId?: string): Promise<void> {
  const tasks = tasksByThread.get(rt.thread.id);
  if (tasks && rt.conn?.conn) {
    const ids = [...tasks.entries()]
      .filter(([id, task]) => task.canStop && (!onlyTaskId || id === onlyTaskId || task.item?.id === onlyTaskId) && (!task.item || task.item.status === 'in_progress'))
      .map(([id]) => id);
    await Promise.all(ids.map((asyncTaskId) => rt.conn!.conn!.agent.request('_session/async_task/stop', {
      sessionId: rt.sessionId,
      asyncTaskId,
    }).catch(() => undefined)));
  }
  if (!onlyTaskId) {
    const active = activeTurns.get(rt.thread.id);
    if (active && !active.hasTaskLifecycle) {
      endAgentInitiatedTurn(rt);
    } else if (active) {
      const t = setTimeout(() => endAgentInitiatedTurn(rt), 1_500);
      t.unref?.();
    }
  }
}

/** Ends one autonomous turn once, saves its checkpoint, and starts any queued prompt. */
function endAgentInitiatedTurn(rt: AgentInitiatedRuntime): void {
  const active = activeTurns.get(rt.thread.id);
  if (!active || active.ended || !host) return;
  active.ended = true;
  clearSettleTimer(active);
  activeTurns.delete(rt.thread.id);
  rt.running = false;
  host.pushSession(rt);
  host.onTurnEnd(rt.thread.id);
  void active.before.then(async (before) => {
    if (before) await host?.finishCheckpoint(rt, active.userItem, before);
    drainPromptQueue(rt.thread.id);
  });
}

function clearSettleTimer(active: ActiveTurn): void {
  if (active.settleTimer) clearTimeout(active.settleTimer);
  active.settleTimer = undefined;
}

function hasOpenTurnWork(rt: AgentInitiatedRuntime, active: ActiveTurn): boolean {
  if ((rt.pendingPerms?.size ?? 0) > 0 || (rt.pendingElicits?.size ?? 0) > 0) return true;
  for (let i = active.startedAtIndex; i < rt.thread.items.length; i++) {
    const it = rt.thread.items[i];
    if (it.kind === 'tool' && (it.status === 'pending' || it.status === 'in_progress')) return true;
    if ((it.kind === 'permission' || it.kind === 'elicitation') && !it.resolved) return true;
  }
  return false;
}

function scheduleIdleSettle(rt: AgentInitiatedRuntime, active: ActiveTurn): void {
  clearSettleTimer(active);
  active.settleTimer = setTimeout(() => {
    if (active.ended || active.hasTaskLifecycle) return;
    if (hasOpenTurnWork(rt, active)) {
      scheduleIdleSettle(rt, active);
      return;
    }
    endAgentInitiatedTurn(rt);
  }, IDLE_TURN_SETTLE_MS);
  active.settleTimer.unref?.();
}

function getTaskMap(threadId: string): Map<string, AsyncTaskItem> {
  let tasks = tasksByThread.get(threadId);
  if (!tasks) tasksByThread.set(threadId, (tasks = new Map()));
  return tasks;
}

function cleanText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 1000) : undefined;
}

function getToolItem(rt: AgentInitiatedRuntime, toolCallId: string): Extract<ThreadItem, { kind: 'tool' }> | undefined {
  const itemId = rt.toolItems.get(toolCallId);
  const item = rt.thread.items.find((entry) => entry.id === itemId);
  return item?.kind === 'tool' ? item : undefined;
}

function drainPromptQueue(threadId: string): void {
  const queue = promptQueues.get(threadId);
  if (!queue || queue.draining || !queue.pending.length || activeTurns.has(threadId) || pausedPromptDrains.has(threadId)) return;
  queue.draining = true;
  const next = queue.pending.shift()!;
  void next().finally(() => {
    queue.draining = false;
    if (!queue.pending.length) promptQueues.delete(threadId);
    else drainPromptQueue(threadId);
  });
}
