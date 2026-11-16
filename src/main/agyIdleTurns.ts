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
import { buildAgyToolItem, dedupToolTimestamps, parseAgyMessage, readNewLines, type LineTail } from './agyTranscript';

const POLL_MS = 1_000;
const STUCK_AFTER_MS = 20_000;
const MAX_TEXT = 32_000;

interface IdleWatch {
  rt: NativeRuntimeHandle;
  host: NativeSubagentHost;
  tail: LineTail;
  enabled: boolean;
  pendingTools: string[];
  lastToolAt?: number;
  warned: boolean;
}

const watches = new Map<string, IdleWatch>();
let timer: NodeJS.Timeout | undefined;

const cap = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (truncated)` : text);

/** Starts or pauses idle-turn mirroring on the parent transcript as ACP prompts start and finish. */
export function setAgyIdleTurn(rt: NativeRuntimeHandle, host: NativeSubagentHost, enabled: boolean): void {
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
      enabled: false,
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
    // Drain any lines written right before the new ACP prompt begins while still idle, then mute during prompt.
    drainWatch(rt.sessionId, watch);
    watch.enabled = false;
    watch.pendingTools = [];
    watch.lastToolAt = undefined;
    watch.warned = false;
  } else {
    // Advance past records already delivered over ACP during the prompt that just finished.
    readNewLines(watch.tail);
    watch.enabled = true;
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
      watch.enabled &&
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
  if (!watch.enabled && step.type !== 'GENERIC') return;
  const stepIndex = Number(step.step_index);
  if (!Number.isInteger(stepIndex)) return;
  const id = watch.rt.sessionId!;
  const ts = Date.parse(String(step.created_at ?? '')) || Date.now();

  if (step.type === 'SYSTEM_MESSAGE') {
    const content = String(step.content ?? '');
    if (content.includes('All your subagents and background tasks have been stopped')) {
      watch.pendingTools = [];
      watch.lastToolAt = undefined;
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
