import type { PlanEntryView, SubTaskView, ThreadItem, ToolContentView } from '@shared/types';
import type { NativeRuntimeHandle, NativeSubagentHost } from './nativeSubagents';
import { cleanOneLine } from './agyTranscript';

/**
 * Turns the JSONL that Claude Code writes for its own sub-agents into chat items. Shapes verified on disk
 * (Claude Code, 2026-11-13..15, `~/.claude/projects/<slug>/<sessionId>/subagents/…/agent-<agentId>.jsonl`):
 * - one record per line; `type` is `user`, `assistant`, `attachment`, `api-request`, `api-request-blob`,
 *   `api-request-shape` (only `user` and `assistant` matter here);
 * - `assistant` records hold exactly ONE content block (`thinking`, `text` or `tool_use`) plus `message.model` and
 *   `message.stop_reason` (`tool_use`, `end_turn`, or null while a message was cut off);
 * - `user` records hold the task (string content, the first record), `isMeta` system reminders, or `tool_result`
 *   blocks (`is_error`); a result with `toolEndsTurn: true` ends the run (after `SubagentHandback`);
 * - background agents finish with a `SubagentHandback` tool call whose `input.message` is the report.
 */

const MAX_TEXT = 32_000;
const capText = (s: string, max = MAX_TEXT) => (s.length > max ? `${s.slice(0, max)}\n… (truncated)` : s);

/** One content block of a Claude message (only the fields this module reads). */
interface ClaudeBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** One line of a Claude Code session or sub-agent JSONL (only the fields this module reads). */
export interface ClaudeRecord {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  toolEndsTurn?: boolean;
  message?: { role?: string; model?: string; stop_reason?: string | null; content?: string | ClaudeBlock[] };
}

/** Where the reader of one sub-agent file stands, and what that sub-agent is doing. */
export interface ClaudeChildCursor {
  agentId: string;
  status: SubTaskView['status'];
  error?: string;
  startedAt: number;
  endedAt?: number;
  /** Timestamp of the newest record read (not the file's mtime: Claude Code touches old files later). */
  lastRecordAt: number;
  /** Model of its latest response. */
  model?: string;
  /** Its `SubagentHandback` report was written since the last message it received. */
  reported?: boolean;
}

/** Parses one JSONL line; undefined for a broken line (only complete lines are passed in). */
export function parseRecord(line: string): ClaudeRecord | undefined {
  if (!line || line.startsWith('{"type":"api-request')) return undefined; // big request dumps, never shown
  try {
    const r: unknown = JSON.parse(line);
    return r && typeof r === 'object' ? (r as ClaudeRecord) : undefined;
  } catch {
    return undefined;
  }
}

/** Text of a `tool_result` content: a string, or text blocks (images are named, not inlined). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c: unknown) => {
      const b = c as ClaudeBlock;
      return b?.type === 'text' && typeof b.text === 'string' ? b.text : b?.type === 'image' ? '[image]' : '';
    })
    .filter(Boolean)
    .join('\n');
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** A chat tool item for one Claude `tool_use` block, shaped like the ones the ACP adapter produces. */
function buildToolItem(agentId: string, b: ClaudeBlock, ts: number): ThreadItem {
  const name = str(b.name) || 'tool';
  const inp = b.input ?? {};
  const path = str(inp.file_path) || str(inp.notebook_path) || str(inp.path);
  let title = name;
  let toolKind: string | undefined;
  let locations: string[] = [];
  let content: ToolContentView[] = [];
  const summary = cleanOneLine(inp.description ?? inp.toolSummary, 160) || undefined;

  if (name === 'Bash') {
    toolKind = 'execute';
    title = str(inp.command).trim() || 'Run command';
  } else if (name === 'Read') {
    toolKind = 'read';
    title = path ? `Read ${path}` : 'Read file';
  } else if (name === 'Edit') {
    toolKind = 'edit';
    title = path ? `Edit ${path}` : 'Edit file';
    content = [{ type: 'diff', path: path || undefined, oldText: capText(str(inp.old_string)), newText: capText(str(inp.new_string)) }];
  } else if (name === 'MultiEdit' && Array.isArray(inp.edits)) {
    toolKind = 'edit';
    title = path ? `Edit ${path}` : 'Edit file';
    content = (inp.edits as Record<string, unknown>[]).map((e) => ({ type: 'diff', path: path || undefined, oldText: capText(str(e?.old_string)), newText: capText(str(e?.new_string)) }));
  } else if (name === 'Write') {
    toolKind = 'edit';
    title = path ? `Write ${path}` : 'Write file';
    content = [{ type: 'diff', path: path || undefined, oldText: null, newText: capText(str(inp.content)) }];
  } else if (name === 'NotebookEdit') {
    toolKind = 'edit';
    title = path ? `Edit ${path}` : 'Edit notebook';
  } else if (name === 'Grep' || name === 'Glob') {
    toolKind = 'search';
    const q = cleanOneLine(inp.pattern, 100);
    title = q ? `${name}: ${q}${path ? ` in ${path}` : ''}` : name;
  } else if (name === 'WebFetch') {
    toolKind = 'fetch';
    title = str(inp.url) ? `Fetch ${str(inp.url)}` : 'Fetch';
  } else if (name === 'WebSearch') {
    toolKind = 'fetch';
    title = inp.query ? `Search web: ${cleanOneLine(inp.query, 100)}` : 'Search web';
  } else if (name === 'Agent' || name === 'Task') {
    toolKind = 'think';
    title = `Sub-agent: ${cleanOneLine(inp.description, 80) || 'task'}`;
  } else if (Object.keys(inp).length) {
    content = [{ type: 'text', text: `Input:\n${capText(JSON.stringify(inp, null, 2), 4000)}` }];
  }
  if (path && toolKind) locations = [path];
  const id = `${agentId}:tool:${b.id ?? ts}`;
  return { kind: 'tool', id, agentId: 'claude', toolCallId: b.id ?? id, title, summary, toolKind, status: 'in_progress', content, locations, ts };
}

/** A `TodoWrite` input as the chat's plan item. */
function planEntries(inp: Record<string, unknown> | undefined): PlanEntryView[] {
  const todos = Array.isArray(inp?.todos) ? (inp!.todos as Record<string, unknown>[]) : [];
  return todos
    .map((t) => ({
      content: cleanOneLine(t?.content ?? t?.activeForm, 200),
      status: (t?.status === 'completed' || t?.status === 'in_progress' ? t.status : 'pending') as PlanEntryView['status'],
    }))
    .filter((e) => e.content);
}

/** True for user text that Claude Code injected (reminders, hook notes) rather than a message to the agent. */
const isInjected = (s: string) => /^\s*<(system-reminder|local-command|command-name|task-notification)\b/.test(s);

/**
 * Applies newly read records of one sub-agent file to its chat. Item ids derive from record uuids and tool ids,
 * so reading the same file again (after an app restart) replaces items instead of duplicating them.
 * Returns true when the chat or the cursor's status changed.
 */
export function applyClaudeRecords(host: NativeSubagentHost, rt: NativeRuntimeHandle, cur: ClaudeChildCursor, lines: string[]): boolean {
  const aid = cur.agentId;
  const upsert = (item: ThreadItem) => {
    const idx = rt.thread.items.findIndex((x) => x.id === item.id);
    if (idx >= 0) {
      rt.thread.items[idx] = item;
      host.pushItem(rt, item, true);
    } else host.addItem(rt, item);
  };
  const setRunning = () => {
    cur.status = 'running';
    cur.endedAt = undefined;
    cur.error = undefined;
    rt.running = true;
  };
  const setDone = (ts: number) => {
    cur.status = 'done';
    cur.endedAt = ts;
    rt.running = false;
  };

  let changed = false;
  for (const line of lines) {
    const r = parseRecord(line.trim());
    if (!r || (r.type !== 'user' && r.type !== 'assistant')) continue;
    const ts = Date.parse(r.timestamp ?? '') || Date.now();
    cur.lastRecordAt = Math.max(cur.lastRecordAt, ts);
    const key = `${aid}:${r.uuid ?? ts}`;
    const content = r.message?.content;

    if (r.type === 'user') {
      if (r.isMeta) continue;
      const blocks: ClaudeBlock[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      blocks.forEach((b, bi) => {
        if (b.type === 'tool_result' && b.tool_use_id) {
          const item = rt.thread.items.find((x) => x.id === `${aid}:tool:${b.tool_use_id}`);
          if (item?.kind !== 'tool') return;
          item.status = b.is_error ? 'failed' : 'completed';
          item.endedAt = ts;
          const out = capText(resultText(b.content).trim(), 16_000);
          item.content = [...item.content.filter((c) => c.type === 'diff' || c.text?.startsWith('Input:')), ...(out ? [{ type: 'text' as const, text: out }] : [])];
          host.pushItem(rt, item, true);
          changed = true;
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() && !isInjected(b.text)) {
          // The first message is the whole task; a later one is a SendMessage that resumes the agent.
          if (!rt.thread.task) rt.thread.task = b.text.trim();
          upsert({ kind: 'user', id: `${key}:${bi}`, agentId: 'claude', fromAgent: 'claude', text: capText(b.text.trim()), ts });
          cur.reported = false;
          setRunning();
          changed = true;
        }
      });
      if (r.toolEndsTurn) {
        setDone(ts);
        changed = true;
      }
      continue;
    }

    // assistant: exactly one block per record
    if (r.message?.model && r.message.model !== '<synthetic>') cur.model = r.message.model;
    for (const [bi, b] of (Array.isArray(content) ? content : []).entries()) {
      if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
        upsert({ kind: 'thought', id: `${key}:${bi}`, agentId: 'claude', text: capText(b.thinking.trim()), ts });
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        upsert({ kind: 'agent', id: `${key}:${bi}`, agentId: 'claude', text: capText(b.text.trim()), ts });
      } else if (b.type === 'tool_use' && b.name === 'SubagentHandback') {
        const report = str(b.input?.message).trim();
        if (report) upsert({ kind: 'agent', id: `${key}:${bi}`, agentId: 'claude', text: capText(report), ts });
        cur.reported = true;
      } else if (b.type === 'tool_use' && b.name === 'TodoWrite') {
        const entries = planEntries(b.input);
        if (entries.length) upsert({ kind: 'plan', id: `${aid}:plan`, agentId: 'claude', entries, ts });
      } else if (b.type === 'tool_use') {
        upsert(buildToolItem(aid, b, ts));
      } else continue;
      changed = true;
    }
    if (r.message?.stop_reason === 'end_turn') setDone(ts);
    else if (cur.status !== 'running') setRunning();
    changed = true;
  }
  return changed;
}

/** A `<task-notification>` that Claude Code queues for the parent session when a background task stops. */
export interface TaskNotification {
  taskIds: string[];
  toolUseId?: string;
  /** Seen on disk: `completed`, `failed`, `killed`, `stopped` (none on Monitor events). */
  status?: string;
  summary?: string;
  at: number;
}

/**
 * Reads a parent-session `queue-operation` enqueue record carrying a task notification, e.g.
 * `<task-notification>\n<task-id>a4ba…</task-id>\n<tool-use-id>toolu_…</tool-use-id>\n…<status>completed</status>\n
 * <summary>Agent "…" finished</summary>…`. Undefined for any other record.
 */
export function parseTaskNotification(r: Record<string, unknown>): TaskNotification | undefined {
  if (r.type !== 'queue-operation' || r.operation !== 'enqueue' || typeof r.content !== 'string') return undefined;
  const c = r.content;
  if (!c.includes('<task-notification>')) return undefined;
  const taskIds = [...c.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map((m) => m[1].trim());
  const status = /<status>([^<]+)<\/status>/.exec(c)?.[1].trim();
  if (!taskIds.length || !status) return undefined;
  return {
    taskIds,
    toolUseId: /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(c)?.[1].trim(),
    status,
    summary: /<summary>([^<]*)<\/summary>/.exec(c)?.[1].trim(),
    at: Date.parse(String(r.timestamp ?? '')) || Date.now(),
  };
}

/** A `Workflow` launch read from the parent session: `toolUseResult {taskType: "local_workflow", taskId, runId, workflowName}`. */
export interface WorkflowLaunch {
  taskId: string;
  runId: string;
  name?: string;
  toolUseId?: string;
}

/** Reads a parent-session `user` record whose tool result launched a background workflow. */
export function parseWorkflowLaunch(r: Record<string, unknown>): WorkflowLaunch | undefined {
  const tur = r.toolUseResult as Record<string, unknown> | undefined;
  if (r.type !== 'user' || !tur || tur.taskType !== 'local_workflow' || typeof tur.runId !== 'string' || typeof tur.taskId !== 'string') return undefined;
  const msg = r.message as ClaudeRecord['message'];
  const first = Array.isArray(msg?.content) ? msg!.content[0] : undefined;
  return { taskId: tur.taskId, runId: tur.runId, name: str(tur.workflowName) || undefined, toolUseId: first?.tool_use_id };
}

/** One line of a workflow run's `journal.jsonl`: `launched`, `started {agentId,label,phase}`, `result {agentId,result}`, `failed {agentId}`. */
export interface JournalEntry {
  type: string;
  agentId?: string;
  label?: string;
  phase?: string;
  result?: unknown;
}

/** Text of a journal `result`: a string as-is, a structured result (e.g. a review verdict) as pretty JSON. */
export function journalResultText(result: unknown): string {
  if (typeof result === 'string') return result.trim();
  if (result === undefined || result === null) return '';
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
