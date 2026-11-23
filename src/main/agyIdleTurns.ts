/**
 * Mirrors Antigravity (`agy acp`) steps taken on its own after an ACP `session/prompt` ends.
 *
 * `agy acp` v1.5.8 only streams `session/update` notifications while a `session/prompt` RPC is open.
 * When a background task or `invoke_subagent` child finishes later, `agy` wakes up internally, writes
 * new `SYSTEM_MESSAGE` / `PLANNER_RESPONSE` / `GENERIC` records to its brain `transcript.jsonl`, and
 * stalls silently if a tool needs user approval. This module tails the parent transcript while idle,
 * renders those steps with full tool kinds/diffs, and posts a wake-up hint if an idle tool stalls.
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ThreadItem } from '@shared/types';
import type { NativeRuntimeHandle, NativeSubagentHost } from './nativeSubagents';
import { noteNativeWake } from './wakeSignals';
import { buildAgyToolItem, dedupToolTimestamps, parseAgyMessage, readNewLines, type LineTail } from './agyTranscript';

const POLL_MS = 1_000;
const STUCK_AFTER_MS = 20_000;
const MAX_TEXT = 32_000;

/**
 * - `on`: the chat is idle; every new transcript step is mirrored.
 * - `muted`: an ACP prompt is open and streams its own steps; only `GENERIC` results are read, to finish
 *   tool steps this mirror already showed.
 * - `live`: agy streams work it started itself over ACP (an agent-initiated turn); like `muted`, plus
 *   `SYSTEM_MESSAGE` handoffs (ACP does not send those).
 */
type WatchMode = 'on' | 'muted' | 'live';

interface IdleWatch {
  rt: NativeRuntimeHandle;
  host: NativeSubagentHost;
  tail: LineTail;
  mode: WatchMode;
  pendingTools: string[];
  lastToolAt?: number;
  warned: boolean;
}

const watches = new Map<string, IdleWatch>();
let timer: NodeJS.Timeout | undefined;

const cap = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (truncated)` : text);

/**
 * Starts or pauses idle-turn mirroring on the parent transcript as ACP prompts start and finish.
 * `liveAcp`: the pause is because agy is streaming the steps over ACP right now, so steps already written
 * to the transcript are not mirrored a second time (they arrive over ACP).
 */
export function setAgyIdleTurn(rt: NativeRuntimeHandle, host: NativeSubagentHost, enabled: boolean, opts: { liveAcp?: boolean } = {}): void {
  if (rt.agentId !== 'antigravity' || !rt.sessionId) return;
  let watch = watches.get(rt.sessionId);
  const file = join(
    process.env.OLYMPUS_AGY_BRAIN_DIR || join(homedir(), '.gemini', 'antigravity-cli', 'brain'),
    rt.sessionId,
    '.system_generated',
    'logs',
    'transcript.jsonl',
  );
  if (!watch) {
    const offset = existsSync(file) ? statSync(file).size : 0;
    watch = {
      rt,
      host,
      tail: { file, offset, rest: Buffer.alloc(0) },
      mode: 'muted',
      pendingTools: [],
      warned: false,
    };
    watches.set(rt.sessionId, watch);
  } else {
    watch.tail.file = file;
  }
  watch.rt = rt;
  watch.host = host;
  if (!enabled) {
    // A user prompt: lines written while still idle are mirrored first. Live ACP work: those lines are the very
    // steps ACP is streaming, so mute first. Either way the tools this mirror already showed stay pending: their
    // GENERIC results are still read while muted (clearing them left those steps "running" forever).
    if (opts.liveAcp) watch.mode = 'live';
    drainWatch(rt.sessionId, watch);
    watch.mode = opts.liveAcp ? 'live' : 'muted';
    watch.lastToolAt = undefined;
    watch.warned = false;
  } else {
    // Records of the turn that just finished were delivered over ACP: read them muted (only results of this
    // mirror's own open tools apply), then listen again.
    if (watch.mode === 'on') watch.mode = 'muted';
    drainWatch(rt.sessionId, watch);
    watch.mode = 'on';
  }
  if (!timer) {
    timer = setInterval(poll, POLL_MS);
    timer.unref?.();
  }
}

/** Stops idle tailing when the Antigravity ACP process exits. */
export function stopAgyIdleTurns(): void {
  watches.clear();
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Releases the transcript tail when its owning chat is deleted or forgotten. */
export function forgetAgyIdleTurn(sessionId: string): void {
  watches.delete(sessionId);
  if (!watches.size && timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

function poll(): void {
  for (const [sessionId, watch] of watches) {
    drainWatch(sessionId, watch);
  }
  if (!watches.size && timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

function drainWatch(sessionId: string, watch: IdleWatch): void {
  try {
    for (const line of readNewLines(watch.tail)) {
      consume(watch, line);
    }
    if (
      watch.mode === 'on' &&
      watch.pendingTools.length > 0 &&
      !watch.warned &&
      watch.lastToolAt &&
      Date.now() - watch.lastToolAt >= STUCK_AFTER_MS
    ) {
      watch.warned = true;
      upsertItem(watch, {
        kind: 'error',
        id: `${sessionId}:idle-approval:${watch.tail.offset}`,
        agentId: 'antigravity',
        text: 'Antigravity continued working after its reply and a tool step has been waiting over 20s — it may be waiting for an approval that `agy acp` cannot send between prompts. Send a short reply (e.g. "continue") so Antigravity re-asks for approval in this chat.',
        ts: Date.now(),
      });
    }
  } catch (error) {
    console.error('[agy-idle-turns] transcript poll failed:', error);
  }
}

function consume(watch: IdleWatch, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let step: Record<string, unknown>;
  try {
    step = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return;
  }
  const stepIndex = Number(step.step_index);
  if (!Number.isInteger(stepIndex)) return;
  const ts = Date.parse(String(step.created_at ?? '')) || Date.now();
  // A new model step or user message means any previous step's tools are over: close both tracked `pendingTools`
  // and any orphaned `:idle:tool:<olderStep>:*` items in the thread so nothing stays stuck in Tasks → Running.
  if (step.type === 'PLANNER_RESPONSE' || step.type === 'USER_INPUT') closePending(watch, ts, stepIndex);
  // agy woke itself (its own `schedule` fired): the app's backup wake for it would arrive seconds later as a
  // duplicate prompt, so cancel it. Read in every mode, and only for fresh lines.
  if (step.type === 'SYSTEM_MESSAGE' && Date.now() - ts < 120_000) {
    const content = String(step.content ?? '');
    if (!content.includes('All your subagents and background tasks have been stopped')) {
      noteNativeWake(watch.rt.thread.id, parseAgyMessage(content).text || content);
    }
  }
  if (watch.mode === 'muted' && step.type !== 'GENERIC') return;
  if (watch.mode === 'live' && step.type !== 'GENERIC' && step.type !== 'SYSTEM_MESSAGE') return;
  const id = watch.rt.sessionId!;

  if (step.type === 'SYSTEM_MESSAGE') {
    const content = String(step.content ?? '');
    if (content.includes('All your subagents and background tasks have been stopped')) {
      closePending(watch, ts);
      return;
    }
    const parsed = parseAgyMessage(content);
    if (parsed.text) {
      upsertItem(watch, {
        kind: 'user',
        id: `${id}:idle:sys:${stepIndex}`,
        agentId: 'antigravity',
        fromAgent: 'antigravity',
        fromApp: true,
        text: cap(parsed.text),
        ts,
      });
    }
    return;
  }

  if (step.type === 'PLANNER_RESPONSE') {
    const thinking = typeof step.thinking === 'string' ? step.thinking.trim() : '';
    if (thinking) {
      upsertItem(watch, { kind: 'thought', id: `${id}:idle:thought:${stepIndex}`, agentId: 'antigravity', text: cap(thinking), ts });
    }
    const calls = Array.isArray(step.tool_calls) ? (step.tool_calls as Record<string, unknown>[]) : [];
    watch.pendingTools = [];
    for (const [index, call] of calls.entries()) {
      const built = buildAgyToolItem(`${id}:idle`, stepIndex, index, call, ts);
      upsertItem(watch, built.item);
      watch.pendingTools.push(built.item.id);
    }
    if (calls.length > 0) {
      watch.lastToolAt = Date.now();
      watch.warned = false;
    }
    const text = typeof step.content === 'string' ? step.content.trim() : '';
    if (text) {
      upsertItem(watch, { kind: 'agent', id: `${id}:idle:agent:${stepIndex}`, agentId: 'antigravity', text: cap(text), ts });
    }
    return;
  }

  if (step.type === 'GENERIC') {
    const toolId = watch.pendingTools.shift();
    const item = toolId ? watch.rt.thread.items.find((entry) => entry.id === toolId) : undefined;
    if (item?.kind === 'tool') {
      const cleanOut = cap(dedupToolTimestamps(String(step.content ?? '')));
      const isErr = step.status === 'ERROR' || /Command exited with code [1-9]\d*/.test(cleanOut);
      item.status = isErr ? 'failed' : 'completed';
      item.endedAt = ts;
      const preserved = item.content.filter((c) => c.type === 'diff' || c.text?.startsWith('Input:'));
      item.content = cleanOut.trim() ? [...preserved, { type: 'text', text: cleanOut }] : preserved;
      watch.host.pushItem(watch.rt, item, true);
      watch.host.pushSession(watch.rt);
    }
    if (!watch.pendingTools.length) watch.lastToolAt = undefined;
  }
}

/** Ends this mirror's open tool steps that will get no result (marked interrupted, with the time). */
function closePending(watch: IdleWatch, ts: number, beforeStepIndex?: number): void {
  const closed = new Set<string>();
  const finish = (item: ThreadItem | undefined) => {
    if (item?.kind === 'tool' && (item.status === 'pending' || item.status === 'in_progress')) {
      item.status = 'interrupted';
      item.endedAt = ts;
      closed.add(item.id);
      watch.host.pushItem(watch.rt, item, true);
    }
  };
  for (const toolId of watch.pendingTools) {
    finish(watch.rt.thread.items.find((entry) => entry.id === toolId));
  }
  const idlePrefix = `${watch.rt.sessionId}:idle:tool:`;
  for (const item of watch.rt.thread.items) {
    if (item.kind !== 'tool' || !item.id.startsWith(idlePrefix) || closed.has(item.id)) continue;
    if (item.status !== 'pending' && item.status !== 'in_progress') continue;
    const stepPart = Number(item.id.slice(idlePrefix.length).split(':')[0]);
    if (beforeStepIndex === undefined || (!Number.isNaN(stepPart) && stepPart < beforeStepIndex)) {
      finish(item);
    }
  }
  watch.pendingTools = [];
  watch.lastToolAt = undefined;
  if (closed.size > 0) watch.host.pushSession(watch.rt);
}

function upsertItem(watch: IdleWatch, item: ThreadItem): void {
  const idx = watch.rt.thread.items.findIndex((x) => x.id === item.id);
  if (idx >= 0) {
    watch.rt.thread.items[idx] = item;
    watch.host.pushItem(watch.rt, item, true);
  } else {
    watch.host.addItem(watch.rt, item);
  }
  watch.host.pushSession(watch.rt);
}
