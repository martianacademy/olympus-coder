import { randomUUID } from 'node:crypto';
import type { ConfigOptionView, SubTaskView, Thread, ThreadItem, ThreadMeta } from '@shared/types';
import { createThread, findThread, listThreads, saveThread, threadMeta } from './store';

/** Minimal runtime handle shared between `agents.ts` and the native sub-agent trackers. */
export interface NativeRuntimeHandle {
  thread: Thread;
  agentId: string;
  conn?: any;
  sessionId?: string;
  status: 'idle' | 'starting' | 'running' | 'needs-login' | 'error';
  error?: string;
  running: boolean;
  configOptions: ConfigOptionView[];
  turn: { agentItemId?: string; thoughtItemId?: string; planItemId?: string };
  toolItems: Map<string, string>;
  pendingPerms: Map<string, (optionId: string | null) => void>;
}

export interface NativeSubagentHost {
  runtimeFor: (threadId: string) => NativeRuntimeHandle;
  bySession: Map<string, NativeRuntimeHandle>;
  addItem: (rt: NativeRuntimeHandle, item: ThreadItem) => ThreadItem;
  pushItem: (rt: NativeRuntimeHandle, item: ThreadItem, throttle?: boolean) => void;
  pushSession: (rt: NativeRuntimeHandle) => void;
  interruptStale: (thread: Thread) => ThreadItem[];
  emitMeta: (meta: ThreadMeta) => void;
  cancelSession: (conn: any, sessionId: string) => Promise<void>;
  textOf: (content: any) => string;
}

interface ChildLiveRecord {
  threadId: string;
  parentThreadId: string;
  sessionId: string;
  status: SubTaskView['status'];
  canCancel: boolean;
  error?: string;
  startedAt: number;
  endedAt?: number;
  msgItems: Map<string, string>;
  userChunkItemId?: string;
  parentCardItemId?: string;
}

let host: NativeSubagentHost | null = null;
const byChildThread = new Map<string, ChildLiveRecord>();
const byChildSession = new Map<string, ChildLiveRecord>();
const fallbackByToolCall = new Map<string, ChildLiveRecord>();

/** Binds the ACP runtime host from `agents.ts` once at startup. */
export function initNativeSubagents(h: NativeSubagentHost): void {
  host = h;
}

/** Walks up `parentId` across nested native sub-agents so all levels attach under the user's chat. */
export function rootUserThread(thread: Thread): Thread {
  let cur: Thread = thread;
  const seen = new Set<string>([cur.id]);
  while (cur.nativeSubagent && cur.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    const parent = findThread(cur.parentId);
    if (!parent) break;
    cur = parent;
  }
  return cur;
}

/** True when the thread itself or its root user chat has `"Approve all"` enabled. */
export function effectiveAutoApprove(thread: Thread): boolean {
  return Boolean(thread.autoApprove || (thread.nativeSubagent && rootUserThread(thread).autoApprove));
}

/** Live state override for `orchestrator.summarize()` on ACP native sub-agent threads. */
export function nativeSubagentSummary(threadId: string) {
  const r = byChildThread.get(threadId);
  return r ? { status: r.status, canCancel: r.canCancel, error: r.error, startedAt: r.startedAt, endedAt: r.endedAt } : undefined;
}

/** Cancels a running native ACP sub-agent session when the user clicks Stop in the Tasks panel. */
export async function cancelNativeSubagent(threadId: string): Promise<boolean> {
  if (!host) return false;
  const rec = byChildThread.get(threadId);
  const t = findThread(threadId);
  if (!t?.nativeSubagent) return false;
  const rt = host.runtimeFor(threadId);
  for (const [id, resolve] of rt.pendingPerms) {
    resolve(null);
    rt.pendingPerms.delete(id);
  }
  const sid = rec?.sessionId ?? t.nativeSessionId;
  const conn = rt.conn ?? (t.parentId ? host.runtimeFor(t.parentId).conn : undefined);
  if (!sid || !conn) return false;
  await host.cancelSession(conn, sid).catch(() => {});
  return true;
}

/** Marks any live native sub-agents attached to a crashed/restarted ACP process as interrupted. */
export function detachNativeSubagentsForConn(conn: any, reason: string): void {
  if (!host) return;
  for (const rec of byChildThread.values()) {
    const rt = host.runtimeFor(rec.threadId);
    if (rt.conn !== conn) continue;
    if (rec.status === 'running' || rec.status === 'starting' || rec.status === 'waiting-permission') {
      rec.status = 'failed';
      rec.error = reason;
      rec.endedAt = Date.now();
      rt.running = false;
      for (const it of host.interruptStale(rt.thread)) host.pushItem(rt, it);
      host.emitMeta(threadMeta(rt.thread));
      host.pushSession(rt);
    }
  }
}

const cleanLabel = (s: unknown, max = 90) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

function blocksToText(blocks: unknown): string {
  if (!host) return '';
  if (Array.isArray(blocks)) return blocks.map((b) => host!.textOf(b)).filter(Boolean).join('\n').trim();
  if (blocks && typeof blocks === 'object') return host.textOf(blocks).trim();
  return typeof blocks === 'string' ? blocks.trim() : '';
}

function ensureChildRecord(
  parentRt: NativeRuntimeHandle,
  childSessionId: string,
  opts: { title?: string; role?: string; model?: string; canCancel?: boolean; bindSession?: boolean },
): { rec: ChildLiveRecord; rt: NativeRuntimeHandle } {
  const h = host!;
  const root = rootUserThread(parentRt.thread);
  let rec = byChildSession.get(childSessionId);
  let childThread = rec ? findThread(rec.threadId) : undefined;
  if (!childThread) {
    const m = listThreads(root.projectId).find((x) => x.nativeSubagent && x.parentId === root.id && x.nativeSessionId === childSessionId);
    if (m) childThread = findThread(m.id);
  }

  const title = cleanLabel(opts.title) || cleanLabel(opts.role) || 'Sub-agent';
  const role = cleanLabel(opts.role, 50);
  if (!childThread) {
    childThread = createThread(root.projectId, parentRt.agentId, {
      title,
      parentId: root.id,
      mode: root.mode,
      nativeSubagent: true,
      nativeSessionId: childSessionId,
      subagentRole: role && role.toLowerCase() !== title.toLowerCase() ? role : role || undefined,
      subagentModel: cleanLabel(opts.model, 60) || undefined,
    });
  } else {
    let dirty = false;
    if (opts.title && childThread.title !== title) ((childThread.title = title), (dirty = true));
    if (role && childThread.subagentRole !== role) ((childThread.subagentRole = role), (dirty = true));
    if (opts.model && childThread.subagentModel !== opts.model) ((childThread.subagentModel = cleanLabel(opts.model, 60)), (dirty = true));
    if (dirty) saveThread(childThread);
  }

  const childRt = h.runtimeFor(childThread.id);
  childRt.conn = parentRt.conn;
  if (opts.bindSession !== false) {
    childRt.sessionId = childSessionId;
    h.bySession.set(childSessionId, childRt);
  }
  if (!rec) {
    rec = {
      threadId: childThread.id,
      parentThreadId: root.id,
      sessionId: childSessionId,
      status: 'running',
      canCancel: Boolean(opts.canCancel),
      startedAt: childThread.createdAt,
      msgItems: new Map(),
    };
    byChildThread.set(childThread.id, rec);
    byChildSession.set(childSessionId, rec);
  } else if (opts.canCancel !== undefined) {
    rec.canCancel = Boolean(opts.canCancel);
  }
  h.emitMeta(threadMeta(childThread));
  return { rec, rt: childRt };
}

function updateParentCard(rec: ChildLiveRecord, status: 'in_progress' | 'completed' | 'failed', outputText?: string): void {
  if (!host || !rec.parentCardItemId) return;
  const parentRt = host.runtimeFor(rec.parentThreadId);
  const item = parentRt.thread.items.find((i) => i.id === rec.parentCardItemId);
  if (!item || item.kind !== 'tool') return;
  item.status = status;
  if (status !== 'in_progress' && !item.endedAt) item.endedAt = Date.now();
  if (outputText?.trim()) {
    const capped = outputText.trim().slice(0, 6000);
    item.content = [...item.content.filter((c) => !c.text?.startsWith('Output:')), { type: 'text', text: `Output:\n${capped}` }];
  }
  host.pushItem(parentRt, item, true);
}

function applyRfdState(rec: ChildLiveRecord, childRt: NativeRuntimeHandle, stateObj: any): void {
  if (!host || !stateObj || typeof stateObj !== 'object') return;
  const st = String(stateObj.state ?? '');
  if (st === 'running' || st === 'requires_action') {
    rec.status = st === 'requires_action' ? 'waiting-permission' : 'running';
    rec.endedAt = undefined;
    if (st === 'running') rec.error = undefined;
    childRt.running = true;
    childRt.status = 'running';
  } else if (st === 'idle') {
    const reason = String(stateObj.stopReason ?? 'end_turn');
    const errMsg = typeof stateObj.error?.message === 'string' ? stateObj.error.message : undefined;
    childRt.running = false;
    childRt.status = 'idle';
    rec.endedAt = Date.now();
    rec.userChunkItemId = undefined;
    for (const stale of host.interruptStale(childRt.thread)) host.pushItem(childRt, stale);
    if (reason === 'cancelled') {
      rec.status = 'cancelled';
    } else if (reason === 'error' || errMsg) {
      const finalErr = errMsg ?? 'Sub-agent stopped with an error.';
      rec.status = 'failed';
      rec.error = finalErr;
      const last = childRt.thread.items[childRt.thread.items.length - 1];
      if (!last || last.kind !== 'error' || last.text !== finalErr) {
        host.addItem(childRt, { kind: 'error', id: randomUUID(), agentId: childRt.agentId, text: finalErr, ts: Date.now() });
      }
      updateParentCard(rec, 'failed', finalErr);
    } else {
      rec.status = 'done';
      const lastReply = [...childRt.thread.items].reverse().find((i) => i.kind === 'agent');
      updateParentCard(rec, 'completed', lastReply?.kind === 'agent' ? lastReply.text : undefined);
    }
  }
  saveThread(childRt.thread);
  host.emitMeta(threadMeta(childRt.thread));
  host.pushSession(childRt);
}

/** Updates the child's recorded model when `config_option_update` or `usage_update` arrives. */
export function noteSubagentModel(rt: NativeRuntimeHandle, model: string | undefined, parentToolUseId?: string): void {
  if (!host || !model || model === '<synthetic>') return;
  const clean = cleanLabel(model, 60);
  if (!clean) return;
  const target = rt.thread.nativeSubagent ? rt.thread : parentToolUseId ? findThread(fallbackByToolCall.get(parentToolUseId)?.threadId ?? '') : undefined;
  if (target && target.subagentModel !== clean) {
    target.subagentModel = clean;
    saveThread(target);
    host.emitMeta(threadMeta(target));
  }
}

/** Handles ACP native sub-agent session updates (`subagent_update`, `session_message*`, `user_message*`, AIR draft). */
export function handleNativeSubagentUpdate(rt: NativeRuntimeHandle, u: any): boolean {
  if (!host || !u?.sessionUpdate) return false;
  const kind = String(u.sessionUpdate);

  // codex-acp folds AIR `subagent_spawned` / `subagent_state_update` into one `_subagent_update`:
  // a spawn carries `name`/`task`, a later change carries `state`.
  if (kind === '_subagent_update') {
    const sid = String(u.subagentSessionId ?? '');
    if (!sid) return true;
    const known = byChildSession.has(sid);
    if (!known && (u.task != null || u.name != null || u.state == null)) handleNativeSubagentUpdate(rt, { ...u, sessionUpdate: 'subagent_spawned' });
    if (u.state != null) handleNativeSubagentUpdate(rt, { ...u, sessionUpdate: 'subagent_state_update' });
    return true;
  }

  if (kind === 'subagent_update') {
    const childSid = typeof u.sessionId === 'string' ? u.sessionId : '';
    if (!childSid) return true;
    const { rec, rt: childRt } = ensureChildRecord(rt, childSid, {
      title: u.title ?? undefined,
      role: u.description ?? undefined,
      canCancel: u.capabilities ? Boolean(u.capabilities.cancel) : undefined,
    });
    if (u.state) applyRfdState(rec, childRt, u.state);
    else {
      childRt.running = rec.status === 'running' || rec.status === 'starting' || rec.status === 'waiting-permission';
      host.pushSession(childRt);
    }
    return true;
  }

  if (kind === 'subagent_spawned' || kind === 'async_task_spawned') {
    const childSid = String(u.subagentSessionId ?? u.taskId ?? '');
    if (!childSid) return true;
    const { rec, rt: childRt } = ensureChildRecord(rt, childSid, {
      title: u.task ?? u.title ?? u.name,
      role: u.name ?? u.subagentType,
      canCancel: Boolean(u.capabilities?.cancel),
    });
    childRt.running = true;
    rec.status = 'running';
    const promptText = cleanLabel(u.prompt, 20_000) || blocksToText(u.prompt);
    if (promptText && !childRt.thread.items.some((i) => i.kind === 'user')) {
      childRt.thread.task = promptText;
      host.addItem(childRt, { kind: 'user', id: randomUUID(), agentId: childRt.agentId, fromAgent: rt.agentId, text: promptText, ts: Date.now() });
    }
    host.emitMeta(threadMeta(childRt.thread));
    host.pushSession(childRt);
    return true;
  }

  if (kind === 'subagent_state_update' || kind === 'async_task_state_update') {
    const rec = byChildSession.get(String(u.subagentSessionId ?? u.taskId ?? ''));
    if (!rec) return true;
    const childRt = host.runtimeFor(rec.threadId);
    const raw = String(u.state?.state ?? u.state ?? u.status ?? '').toLowerCase();
    const stopReason = ['completed', 'done', 'idle', 'succeeded'].includes(raw)
      ? 'end_turn'
      : ['cancelled', 'canceled', 'stopped'].includes(raw)
        ? 'cancelled'
        : ['failed', 'error'].includes(raw)
          ? 'error'
          : '';
    applyRfdState(rec, childRt, stopReason ? { state: 'idle', stopReason, error: { message: u.error?.message ?? u.message } } : { state: 'running' });
    return true;
  }

  if (kind === 'state_update' && rt.thread.nativeSubagent) {
    const rec = byChildThread.get(rt.thread.id);
    if (rec) applyRfdState(rec, rt, u.state ?? u);
    return true;
  }

  if (kind === 'session_message' || kind === 'session_message_chunk') {
    const isChunk = kind === 'session_message_chunk';
    const msgId = String(u.messageId ?? randomUUID());
    const text = blocksToText(u.content);
    if (!text) return true;

    if (rt.thread.nativeSubagent) {
      const rec = byChildThread.get(rt.thread.id);
      const isOutgoing = u.senderSessionId && u.senderSessionId === rt.sessionId;
      const existing = rec?.msgItems.get(msgId) ? rt.thread.items.find((i) => i.id === rec.msgItems.get(msgId)) : undefined;
      if (existing && (existing.kind === 'user' || existing.kind === 'agent')) {
        existing.text = isChunk ? existing.text + text : text;
        host.pushItem(rt, existing, isChunk);
        return true;
      }
      if (isOutgoing) {
        const lastAg = [...rt.thread.items].reverse().find((i) => i.kind === 'agent');
        if (lastAg?.kind === 'agent' && lastAg.text.trim() === text.trim()) return true;
        const item: ThreadItem = { kind: 'agent', id: randomUUID(), agentId: rt.agentId, text, ts: Date.now() };
        rec?.msgItems.set(msgId, item.id);
        host.addItem(rt, item);
      } else {
        if (!rt.thread.task) rt.thread.task = text;
        if (rt.thread.title === 'Sub-agent') rt.thread.title = cleanLabel(text.split('\n')[0], 72) || 'Sub-agent';
        rt.turn = {};
        const item: ThreadItem = { kind: 'user', id: randomUUID(), agentId: rt.agentId, fromAgent: rt.agentId, text, ts: Date.now() };
        rec?.msgItems.set(msgId, item.id);
        host.addItem(rt, item);
        host.emitMeta(threadMeta(rt.thread));
      }
      return true;
    }

    const toChild = typeof u.recipientSessionId === 'string' ? byChildSession.get(u.recipientSessionId) : undefined;
    if (toChild) {
      const childT = findThread(toChild.threadId);
      const label = `Sub-agent (${childT?.subagentRole ? `${childT.subagentRole}: ` : ''}${childT?.title ?? 'Task'})`;
      const existing = toChild.parentCardItemId ? rt.thread.items.find((i) => i.id === toChild.parentCardItemId) : undefined;
      if (existing?.kind === 'tool' && isChunk) {
        existing.content = [{ type: 'text', text: `${existing.content[0]?.text ?? 'Input:\n'}${text}` }];
        host.pushItem(rt, existing, true);
      } else {
        const card: ThreadItem = {
          kind: 'tool',
          id: randomUUID(),
          agentId: rt.agentId,
          toolCallId: `subagent:${msgId}`,
          title: label,
          summary: childT?.title ?? label,
          toolKind: 'think',
          status: 'in_progress',
          content: [{ type: 'text', text: `Input:\n${text.slice(0, 6000)}` }],
          locations: [],
          ts: Date.now(),
        };
        toChild.parentCardItemId = card.id;
        host.addItem(rt, card);
      }
      return true;
    }

    const fromChild = typeof u.senderSessionId === 'string' ? byChildSession.get(u.senderSessionId) : undefined;
    if (fromChild) {
      updateParentCard(fromChild, 'completed', text);
      const childRt = host.runtimeFor(fromChild.threadId);
      if (!childRt.thread.items.some((i) => i.kind === 'agent' && i.text.trim() === text.trim())) {
        host.addItem(childRt, { kind: 'agent', id: randomUUID(), agentId: childRt.agentId, text, ts: Date.now() });
        host.emitMeta(threadMeta(childRt.thread));
      }
    }
    return true;
  }

  if ((kind === 'user_message_chunk' || kind === 'user_message') && rt.thread.nativeSubagent) {
    const text = blocksToText(u.content);
    if (!text) return true;
    const rec = byChildThread.get(rt.thread.id);
    const cur = rec?.userChunkItemId ? rt.thread.items.find((i) => i.id === rec.userChunkItemId) : undefined;
    if (cur?.kind === 'user' && kind === 'user_message_chunk') {
      cur.text += text;
      rt.thread.task = cur.text;
      host.pushItem(rt, cur, true);
    } else {
      const item: ThreadItem = { kind: 'user', id: randomUUID(), agentId: rt.agentId, fromAgent: rt.agentId, text, ts: Date.now() };
      if (rec) rec.userChunkItemId = item.id;
      if (!rt.thread.task) rt.thread.task = text;
      host.addItem(rt, item);
      host.emitMeta(threadMeta(rt.thread));
    }
    return true;
  }

  return false;
}

const FALLBACK_SUBAGENT_TOOLS = new Set(['task', 'agent', 'dispatch_agent', 'spawn_agent', 'delegate_task']);

/** Fallback mirroring for custom ACP agents that do not emit RFD `subagent_update` (excluding Antigravity). */
export function maybeMirrorInBandSubagent(rt: NativeRuntimeHandle, u: any): NativeRuntimeHandle | undefined {
  if (!host || rt.agentId === 'antigravity' || rt.thread.nativeSubagent) return undefined;
  const parentToolId = typeof u?._meta?.claudeCode?.parentToolUseId === 'string' ? u._meta.claudeCode.parentToolUseId : undefined;
  if (parentToolId && fallbackByToolCall.has(parentToolId)) return host.runtimeFor(fallbackByToolCall.get(parentToolId)!.threadId);

  if (u?.sessionUpdate === 'tool_call') {
    const rawName = String(u._meta?.claudeCode?.toolName ?? u.name ?? u.title ?? '').replace(/^Run\s+/i, '').split(/[\s:(]/)[0].toLowerCase();
    if (!FALLBACK_SUBAGENT_TOOLS.has(rawName)) return undefined;
    for (const rec of byChildThread.values()) if (rec.parentThreadId === rt.thread.id) return undefined;
    const inp = (u.rawInput && typeof u.rawInput === 'object' ? u.rawInput : {}) as Record<string, unknown>;
    const promptText = cleanLabel(inp.prompt ?? inp.task ?? inp.instructions, 20_000);
    const title = cleanLabel(inp.description ?? inp.title ?? inp.name) || cleanLabel(promptText.split('\n')[0], 72) || 'Sub-agent';
    const role = cleanLabel(inp.subagent_type ?? inp.role ?? inp.agent_type, 50);
    const { rec, rt: childRt } = ensureChildRecord(rt, `inband:${rt.thread.id}:${u.toolCallId}`, {
      title,
      role,
      model: typeof inp.model === 'string' ? inp.model : undefined,
      canCancel: false,
      bindSession: false,
    });
    childRt.running = true;
    rec.status = 'running';
    if (promptText) {
      childRt.thread.task = promptText;
      host.addItem(childRt, { kind: 'user', id: randomUUID(), agentId: childRt.agentId, fromAgent: rt.agentId, text: promptText, ts: Date.now() });
    }
    fallbackByToolCall.set(u.toolCallId, rec);
    host.emitMeta(threadMeta(childRt.thread));
    host.pushSession(childRt);
  } else if (u?.sessionUpdate === 'tool_call_update' && fallbackByToolCall.has(u.toolCallId) && (u.status === 'completed' || u.status === 'failed')) {
    const rec = fallbackByToolCall.get(u.toolCallId)!;
    const childRt = host.runtimeFor(rec.threadId);
    const outText = blocksToText(u.content?.map((c: any) => c.content ?? c)) || (typeof u.rawOutput === 'string' ? u.rawOutput : u.rawOutput ? JSON.stringify(u.rawOutput, null, 2) : '');
    if (outText) host.addItem(childRt, { kind: u.status === 'failed' ? 'error' : 'agent', id: randomUUID(), agentId: childRt.agentId, text: outText, ts: Date.now() });
    applyRfdState(rec, childRt, { state: 'idle', stopReason: u.status === 'failed' ? 'error' : 'end_turn', ...(u.status === 'failed' ? { error: { message: outText || 'Sub-agent failed.' } } : {}) });
    fallbackByToolCall.delete(u.toolCallId);
  }
  return undefined;
}
