import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SubTaskView, ThreadItem, ToolContentView } from '@shared/types';
import type { NativeRuntimeHandle, NativeSubagentHost } from './nativeSubagents';

const MAX_DIFF_CHARS = 64_000;
const capText = (s: string, max = MAX_DIFF_CHARS) => (s.length > max ? `${s.slice(0, max)}\n… (truncated)` : s);

/** Collapses whitespace into a single-line bounded label. */
export function cleanOneLine(v: unknown, max = 80): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** Unwraps double-JSON-encoded string arguments written in Antigravity `transcript.jsonl` tool calls. */
export function unwrapArgs(raw: unknown): Record<string, any> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') {
      const t = v.trim();
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try {
          out[k] = JSON.parse(t);
          continue;
        } catch {
          /* keep original string */
        }
      }
    }
    out[k] = v;
  }
  return out;
}

/**
 * The text and sender of an Antigravity message record. Messages between conversations (a sub-agent's task from its
 * parent, its report back) are SYSTEM_MESSAGE records whose content reads
 * "The following is a <SYSTEM_MESSAGE> not actually sent by the user…\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=…
 * sender=<conversation id> priority=… content=<text>\n</SYSTEM_MESSAGE>"; older builds wrote "sender=<id>: <text>".
 */
export function parseAgyMessage(raw: unknown): { sender?: string; text: string } {
  const s = typeof raw === 'string' ? raw : '';
  const wrapped = /<SYSTEM_MESSAGE>[ \t]*\r?\n([\s\S]*?)\s*<\/SYSTEM_MESSAGE>\s*$/.exec(s);
  const body = (wrapped ? wrapped[1] : s).replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '').trim();
  const msg = /^\[Message\]([^\n]*?)\bcontent=([\s\S]*)$/.exec(body);
  if (msg) return { sender: /\bsender=([0-9a-fA-F-]{8,})/.exec(msg[1])?.[1], text: msg[2].trim() };
  const legacy = /^sender=([0-9a-fA-F-]{8,})[:\s]*([\s\S]*)$/.exec(body);
  return legacy ? { sender: legacy[1], text: legacy[2].trim() } : { text: body };
}

/** New complete lines of a growing JSONL file, read from where the last call stopped (never the whole file again). */
export interface LineTail {
  file: string;
  offset: number;
  rest: Buffer;
}

export function readNewLines(t: LineTail): string[] {
  if (!existsSync(t.file)) return []; // not written yet
  const fd = openSync(t.file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size < t.offset) {
      t.offset = 0; // rewritten from scratch
      t.rest = Buffer.alloc(0);
    }
    if (size === t.offset) return [];
    const buf = Buffer.alloc(size - t.offset);
    const n = readSync(fd, buf, 0, buf.length, t.offset);
    t.offset += n;
    const data = t.rest.length ? Buffer.concat([t.rest, buf.subarray(0, n)]) : buf.subarray(0, n);
    const end = data.lastIndexOf(0x0a);
    if (end < 0) {
      t.rest = Buffer.from(data);
      return [];
    }
    t.rest = Buffer.from(data.subarray(end + 1));
    return data.subarray(0, end).toString('utf8').split('\n');
  } finally {
    closeSync(fd);
  }
}

/**
 * The first record of a sub-agent's `transcript.jsonl`: who sent its task and the task text. `complete` is false
 * while that first line is still being written, so a caller can look again instead of giving up on the file.
 */
export function readFirstMessage(logFile: string): { complete: boolean; sender?: string; prompt?: string } {
  const first = readFirstLine(logFile)?.trim();
  if (!first) return { complete: false };
  let obj: any;
  try {
    obj = JSON.parse(first);
  } catch {
    return { complete: true }; // not an agy transcript
  }
  if (obj?.type !== 'SYSTEM_MESSAGE') return { complete: true };
  const m = parseAgyMessage(obj.content);
  return { complete: true, sender: m.sender, prompt: m.text || undefined };
}

/** A file's first line, read in chunks only up to its first newline (undefined: no file, or no newline yet). */
function readFirstLine(file: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return undefined; // not written yet
  }
  try {
    const buf = Buffer.alloc(64 * 1024);
    const chunks: Buffer[] = [];
    for (let pos = 0; ; ) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) return undefined; // the first line is still being written
      const nl = buf.subarray(0, n).indexOf(0x0a);
      chunks.push(Buffer.from(buf.subarray(0, nl < 0 ? n : nl)));
      if (nl >= 0) return Buffer.concat(chunks).toString('utf8');
      pos += n;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * The sub-agents an Antigravity `invoke_subagent` result announces: "Created the following subagent:
 * {"conversationId": "…", "logAbsoluteUri": "file:///…/transcript.jsonl", …}". The ACP tool update carries no
 * output, so this text is only found in the parent's own brain transcript.
 */
export function parseCreatedSubagents(content: unknown, brainRoot: string): { cid: string; logFile: string }[] {
  const text = typeof content === 'string' ? content : '';
  if (!text.includes('Created the following subagent')) return [];
  const out: { cid: string; logFile: string }[] = [];
  for (const block of text.split(/Created the following subagent/).slice(1)) {
    const cid = /"conversationId"\s*:\s*"([0-9a-fA-F-]{8,})"/.exec(block)?.[1];
    if (!cid) continue;
    const uri = /"logAbsoluteUri"\s*:\s*"(file:\/\/[^"]+)"/.exec(block)?.[1];
    const fallback = join(brainRoot, cid, '.system_generated', 'logs', 'transcript.jsonl');
    out.push({ cid, logFile: uri ? fileUriPath(uri, fallback) : fallback });
  }
  return out;
}

function fileUriPath(uri: string, fallback: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return fallback; // a malformed URI: agy's default location for that conversation
  }
}

/** Strips duplicated back-to-back `Created At / Completed At` header pairs on Antigravity `GENERIC` steps. */
export function dedupToolTimestamps(raw: string): string {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  if (lines.length >= 4 && lines[0].startsWith('Created At:') && lines[1].startsWith('Completed At:') && lines[2] === lines[0] && lines[3] === lines[1]) {
    lines.splice(2, 2);
  }
  return lines.join('\n');
}

/** Converts one Antigravity `PLANNER_RESPONSE.tool_calls[i]` entry into a rich `ThreadItem` (with diffs for edits). */
export function buildAgyToolItem(cid: string, stepIdx: number, tcIdx: number, tc: any, ts: number): { item: ThreadItem; replyMessage?: string } {
  const name = String(tc?.name ?? 'tool');
  const args = unwrapArgs(tc?.args);
  const id = `${cid}:tool:${stepIdx}:${tcIdx}`;
  const summary = cleanOneLine(args.toolSummary ?? args.Description ?? args.description, 160) || undefined;
  let title = `Run ${name}`;
  let toolKind: string | undefined;
  let locations: string[] = [];
  let content: ToolContentView[] = [];
  let replyMessage: string | undefined;

  if (name === 'run_command') {
    toolKind = 'execute';
    title = typeof args.CommandLine === 'string' && args.CommandLine.trim() ? args.CommandLine.trim() : 'Run command';
  } else if (name === 'read_file') {
    toolKind = 'read';
    const p = typeof args.Path === 'string' ? args.Path : '';
    title = p ? `Read ${p}` : 'Read file';
    if (p) locations = [p];
  } else if (name === 'edit_file') {
    toolKind = 'edit';
    const p = typeof args.Path === 'string' ? args.Path : '';
    title = p ? `Edit ${p}` : 'Edit file';
    if (p) locations = [p];
    content = [{ type: 'diff', path: p || undefined, oldText: typeof args.Target === 'string' ? capText(args.Target) : null, newText: capText(String(args.Replacement ?? '')) }];
  } else if (name === 'write_file') {
    toolKind = 'edit';
    const p = typeof args.Path === 'string' ? args.Path : '';
    title = p ? `Write ${p}` : 'Write file';
    if (p) locations = [p];
    content = [{ type: 'diff', path: p || undefined, oldText: null, newText: capText(String(args.Content ?? '')) }];
  } else if (name === 'search_web') {
    toolKind = 'fetch';
    title = args.query ? `Search web: ${cleanOneLine(args.query, 100)}` : 'Search web';
  } else if (name === 'send_message') {
    toolKind = 'think';
    title = 'Send report to parent session';
    if (typeof args.Message === 'string' && args.Message.trim()) replyMessage = args.Message.trim();
  } else if (/search|grep|find/i.test(name)) {
    toolKind = 'search';
    const q = cleanOneLine(args.Query ?? args.query ?? args.Pattern ?? args.pattern ?? args.SearchPath ?? args.Path, 100);
    title = q ? `${name}: ${q}` : name;
  } else if (Object.keys(args).length) {
    content = [{ type: 'text', text: `Input:\n${capText(JSON.stringify(args, null, 2), 4000)}` }];
  }

  return {
    item: { kind: 'tool', id, agentId: 'antigravity', toolCallId: tc?.id ?? id, title, summary, toolKind, status: 'in_progress', content, locations, ts },
    replyMessage,
  };
}

export interface AgyStepCursor {
  cid: string;
  logFile: string;
  parsedLines: number;
  pendingToolItemIds: string[];
  status: SubTaskView['status'];
  error?: string;
  startedAt: number;
  endedAt?: number;
  lastActivityAt: number;
  /** It sent its report to the parent (send_message) since the last message it received. */
  reported?: boolean;
}

/** Incrementally parses newly appended lines in `transcript.jsonl` (falling back to `transcript_full.jsonl` when truncated). */
export function syncAgyTranscriptLines(host: NativeSubagentHost, rt: NativeRuntimeHandle, cur: AgyStepCursor, raw: string): boolean {
  const completeLines = raw.endsWith('\n') ? raw.slice(0, -1).split('\n') : raw.split('\n').slice(0, -1);
  if (completeLines.length <= cur.parsedLines) return false;

  let fullLines: string[] | null = null;
  const fullPath = join(dirname(cur.logFile), 'transcript_full.jsonl');
  const resolveStep = (idx: number, fallback: any): any => {
    if (!Array.isArray(fallback?.truncated_fields) || !fallback.truncated_fields.length) return fallback;
    if (fullLines === null) {
      try {
        fullLines = existsSync(fullPath) ? readFileSync(fullPath, 'utf8').split('\n') : [];
      } catch {
        fullLines = [];
      }
    }
    const fl = fullLines[idx]?.trim();
    if (!fl) return fallback;
    try {
      return JSON.parse(fl);
    } catch {
      return fallback;
    }
  };

  const upsert = (item: ThreadItem) => {
    const idx = rt.thread.items.findIndex((x) => x.id === item.id);
    if (idx >= 0) {
      rt.thread.items[idx] = item;
      host.pushItem(rt, item, true);
    } else {
      host.addItem(rt, item);
    }
  };

  let changed = false;
  for (let i = cur.parsedLines; i < completeLines.length; i++) {
    const line = completeLines[i].trim();
    if (!line) continue;
    let step: any;
    try {
      step = resolveStep(i, JSON.parse(line));
    } catch {
      continue;
    }
    const ts = step.created_at ? Date.parse(step.created_at) || Date.now() : Date.now();
    if (i === 0 && step.created_at) cur.startedAt = ts;

    if (step.type === 'SYSTEM_MESSAGE') {
      const content = String(step.content ?? '');
      if (content.includes('All your subagents and background tasks have been stopped')) {
        cur.status = 'cancelled';
        cur.endedAt = ts;
        rt.running = false;
        changed = true;
        continue;
      }
      const msg = parseAgyMessage(content).text;
      if (msg) {
        cur.reported = false;
        // The first message is the sub-agent's whole task (the parent's copy of it may be cut short).
        if (i === 0 || !rt.thread.task) rt.thread.task = msg;
        if (rt.thread.title === 'Sub-agent') rt.thread.title = cleanOneLine(msg.split('\n')[0], 72) || 'Sub-agent';
        const seeded = rt.thread.items.find((x) => x.id === `${cur.cid}:seed:0`);
        if (i === 0 && seeded && seeded.kind === 'user') {
          seeded.text = msg;
          seeded.ts = ts;
          host.pushItem(rt, seeded, true);
        } else {
          upsert({ kind: 'user', id: `${cur.cid}:user:${i}`, agentId: 'antigravity', fromAgent: 'antigravity', text: msg, ts });
        }
        cur.status = 'running';
        cur.endedAt = undefined;
        rt.running = true;
        changed = true;
      }
    } else if (step.type === 'USER_INPUT') {
      const msg = String(step.content ?? '').replace(/^<USER_REQUEST>\s*|\s*<\/USER_REQUEST>$/g, '').trim();
      if (msg && !rt.thread.items.some((x) => x.kind === 'user')) {
        if (!rt.thread.task) rt.thread.task = msg;
        upsert({ kind: 'user', id: `${cur.cid}:user:${i}`, agentId: 'antigravity', fromAgent: 'antigravity', text: msg, ts });
        changed = true;
      }
    } else if (step.type === 'PLANNER_RESPONSE') {
      if (typeof step.thinking === 'string' && step.thinking.trim()) {
        upsert({ kind: 'thought', id: `${cur.cid}:thought:${i}`, agentId: 'antigravity', text: capText(step.thinking.trim(), 32_000), ts });
        changed = true;
      }
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      if (calls.length > 0) {
        calls.forEach((tc: any, tcIdx: number) => {
          const { item, replyMessage } = buildAgyToolItem(cur.cid, i, tcIdx, tc, ts);
          upsert(item);
          cur.pendingToolItemIds.push(item.id);
          if (replyMessage) {
            upsert({ kind: 'agent', id: `${cur.cid}:reply:${i}:${tcIdx}`, agentId: 'antigravity', text: capText(replyMessage, 32_000), ts });
            cur.reported = true;
          }
        });
        if (typeof step.content === 'string' && step.content.trim()) {
          upsert({ kind: 'agent', id: `${cur.cid}:agent:${i}`, agentId: 'antigravity', text: capText(step.content.trim(), 32_000), ts });
        }
        cur.status = 'running';
        cur.endedAt = undefined;
        rt.running = true;
        changed = true;
      } else {
        // After a send_message report, a short closing line ("findings delivered to the caller") would replace
        // the report as the card's final answer: the report stays the answer.
        const text = typeof step.content === 'string' ? step.content.trim() : '';
        if (text && !(cur.reported && text.length <= 600)) {
          upsert({ kind: 'agent', id: `${cur.cid}:agent:${i}`, agentId: 'antigravity', text: capText(text, 32_000), ts });
        }
        cur.status = 'done';
        cur.endedAt = ts;
        rt.running = false;
        changed = true;
      }
    } else if (step.type === 'GENERIC') {
      const toolItemId = cur.pendingToolItemIds.shift();
      const toolItem = toolItemId ? rt.thread.items.find((x) => x.id === toolItemId) : undefined;
      const cleanOut = capText(dedupToolTimestamps(String(step.content ?? '')), 32_000);
      const completedMatch = /^Completed At:\s*(.+)$/m.exec(cleanOut);
      const endTs = completedMatch ? Date.parse(completedMatch[1].trim()) || ts : ts;
      const isErr = step.status === 'ERROR' || /Command exited with code [1-9]\d*/.test(cleanOut);
      if (toolItem && toolItem.kind === 'tool') {
        toolItem.status = isErr ? 'failed' : 'completed';
        toolItem.endedAt = endTs;
        const diffs = toolItem.content.filter((c) => c.type === 'diff');
        toolItem.content = cleanOut.trim() ? [...diffs, { type: 'text', text: cleanOut }] : diffs;
        host.pushItem(rt, toolItem, true);
        changed = true;
      }
    } else if (step.type === 'ERROR_MESSAGE') {
      // A model/API error agy reports and usually retries ("API error (attempt 1): …"): shown, not fatal.
      const errText = cleanOneLine(step.error ?? step.content ?? 'Model request failed.', 500);
      upsert({ kind: 'error', id: `${cur.cid}:err:${i}`, agentId: 'antigravity', text: errText, ts });
      changed = true;
    } else if (step.status === 'ERROR') {
      const errText = cleanOneLine(step.content ?? step.error ?? 'Sub-agent step failed.', 500);
      upsert({ kind: 'error', id: `${cur.cid}:err:${i}`, agentId: 'antigravity', text: errText, ts });
      cur.status = 'failed';
      cur.error = errText;
      cur.endedAt = ts;
      rt.running = false;
      changed = true;
    }
  }
  cur.parsedLines = completeLines.length;
  return changed;
}
