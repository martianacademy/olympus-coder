import type { ThreadItem } from '@shared/types';
import { fmtStepDuration, parseToolStep, type ParsedToolStep, type ToolItem } from './toolStep';
import { toolStepKind, type StepKind } from './components/stepIcons';

export type WorkStepItem = Extract<ThreadItem, { kind: 'thought' | 'tool' | 'plan' }>;

/** Keys in tool JSON inputs that contain large bodies or internal flags rather than concise header parameters. */
const SKIP_PARAM_KEYS = new Set([
  'content',
  'replacement',
  'target',
  'old_string',
  'new_string',
  'oldtext',
  'newtext',
  'prompt',
  'systemprompt',
  'script',
  'waitmsbeforeasync',
  'toolsummary',
  // Already shown as the step's summary (`parseToolStep` reads `toolSummary` / `description`).
  'description',
  'artifactmetadata',
  'overwrite',
  'append',
]);

/** Shortens a filesystem path to its last two segments so parameters remain readable on a single line. */
export function compactPath(raw: string): string {
  const clean = raw.trim().replace(/^file:\/\//i, '');
  if (!clean) return '';
  const parts = clean.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return clean;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/** Strips markdown formatting from a single line of reasoning text. */
function cleanMarkdownLine(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/^>\s+/, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts a clean one-line preview from a `thought` item's text.
 * When `streaming` is true, tracks the latest meaningful line so the live header updates as reasoning progresses;
 * when settled, uses the opening line so collapsed rows read like concise titles.
 */
export function formatThoughtPreview(text: string, streaming = false): string {
  if (!text) return '';
  const lines = text
    .split(/\r?\n/)
    .map(cleanMarkdownLine)
    .filter(Boolean);
  if (!lines.length) return '';
  if (!streaming) return lines[0];
  const last = lines[lines.length - 1];
  if (last.length < 10 && lines.length >= 2) {
    return `${lines[lines.length - 2]} ${last}`.trim();
  }
  return last;
}

/** Attempts to parse the `Input:` JSON object recorded on a tool call item. */
function parseInputObject(item: ToolItem): Record<string, unknown> | null {
  const inputEntry = item.content.find((c) => c.type !== 'diff' && c.text && /^Input:(?:\s|$)/.test(c.text));
  if (!inputEntry?.text) return null;
  const raw = inputEntry.text.replace(/^Input:\s*/, '').trim();
  if (!raw.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function pickStr(obj: Record<string, unknown> | null, keys: string[]): string {
  if (!obj) return '';
  const targets = new Set(keys.map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(obj)) {
    if (targets.has(k.toLowerCase()) && typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function pickNum(obj: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (!obj) return undefined;
  const targets = new Set(keys.map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(obj)) {
    if (targets.has(k.toLowerCase()) && typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function formatLineSpan(obj: Record<string, unknown> | null): string {
  const start = pickNum(obj, ['StartLine', 'start_line', 'offset']);
  const end = pickNum(obj, ['EndLine', 'end_line']);
  const limit = pickNum(obj, ['limit']);
  if (start !== undefined && end !== undefined) return `L${start}–${end}`;
  if (start !== undefined && limit !== undefined) return `L${start}+${limit}`;
  if (start !== undefined) return `L${start}+`;
  if (limit !== undefined) return `${limit} lines`;
  return '';
}

/** Line range a read step asked for (`L10–40`), from its JSON input or a Claude `Read path (10 - 40)` title. */
export function readLineSpan(item: ToolItem): string {
  const span = formatLineSpan(parseInputObject(item));
  if (span) return span;
  const m = /\((\d+)\s*-\s*(\d+)\)\s*$/.exec(item.title);
  return m ? `L${m[1]}–${m[2]}` : '';
}

/** Query, pattern or URL plus the searched scope of a search / web step, from its JSON input. */
export function toolQueryOf(item: ToolItem): { query: string; scope: string } {
  const obj = parseInputObject(item);
  return {
    query: pickStr(obj, ['Query', 'query', 'Pattern', 'pattern', 'url', 'Url', 'URL']),
    scope: pickStr(obj, ['SearchPath', 'SearchDirectory', 'path', 'Directory', 'domain']),
  };
}

function formatKeyValueFallback(obj: Record<string, unknown> | null): string {
  if (!obj) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (SKIP_PARAM_KEYS.has(k.toLowerCase()) || v === undefined || v === null || v === '') continue;
    if (typeof v === 'string') {
      const trimmed = v.replace(/\s+/g, ' ').trim();
      if (!trimmed) continue;
      const val = trimmed.includes('/') ? compactPath(trimmed) : trimmed.length > 42 ? `${trimmed.slice(0, 42)}…` : trimmed;
      parts.push(`${k}=${val}`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${String(v)}`);
    }
    if (parts.length >= 3) break;
  }
  return parts.join(', ');
}

export interface ToolHeaderDescriptor {
  /** Short badge name (`Read`, `Edit`, `Command`, `Search`, etc.). */
  label: string;
  /** Concise parameter summary (`components/Chat.tsx L1–120`, `$ npx tsc --noEmit`, `"groupItems" in src`). */
  params: string;
  /** Full untruncated hover tooltip text. */
  tooltip: string;
  /** Whether `params` should render in monospace code font. */
  isMono: boolean;
  /** Raw ACP kind (`execute` for commands), used to bucket the settled summary counts. Badge colours use `stepKindColor`. */
  kindKey: string;
}

/**
 * Builds a concise `label + params` descriptor for any tool call so both the live `WorkGroup`
 * header and collapsed rows display the tool name alongside its key parameters.
 */
export function describeToolForHeader(item: ToolItem, parsedProp?: ParsedToolStep): ToolHeaderDescriptor {
  const parsed = parsedProp ?? parseToolStep(item);
  const kindKey = parsed.isCommand ? 'execute' : (item.toolKind ?? 'other');

  if (parsed.isCommand) {
    const cmdPreview = parsed.headerTitle ? `$ ${parsed.headerTitle}` : '';
    const params =
      cmdPreview && parsed.summary
        ? `${cmdPreview}  # ${parsed.summary}`
        : cmdPreview || parsed.summary || 'Running command…';
    return {
      label: parsed.toolLabel,
      params,
      tooltip: parsed.command ? `$ ${parsed.command}` : params,
      isMono: true,
      kindKey,
    };
  }

  const obj = parseInputObject(item);
  const diffPath = item.content.find((c) => c.type === 'diff' && c.path)?.path;
  const rawPath = item.locations[0] ?? diffPath ?? pickStr(obj, ['Path', 'file_path', 'path', 'TargetFile', 'DirectoryPath']);

  if (item.toolKind === 'read' || item.toolKind === 'edit' || item.toolKind === 'delete' || item.toolKind === 'move') {
    const target = rawPath ? compactPath(rawPath) : compactPath(parsed.headerTitle);
    const span = item.toolKind === 'read' ? readLineSpan(item) : '';
    const params = [target, span].filter(Boolean).join(' ');
    return {
      label: parsed.toolLabel,
      params: params || parsed.summary || parsed.headerTitle,
      tooltip: [rawPath || parsed.headerTitle, span].filter(Boolean).join(' '),
      isMono: Boolean(params),
      kindKey,
    };
  }

  if (item.toolKind === 'search' || item.toolKind === 'fetch') {
    const query = pickStr(obj, ['Query', 'query', 'Pattern', 'pattern', 'url', 'Url']);
    const scope = pickStr(obj, ['SearchPath', 'SearchDirectory', 'path', 'Directory', 'domain']);
    if (query) {
      const shortQ = query.length > 48 ? `${query.slice(0, 48)}…` : query;
      const params = scope ? `"${shortQ}" in ${compactPath(scope)}` : `"${shortQ}"`;
      return {
        label: parsed.toolLabel,
        params,
        tooltip: scope ? `"${query}" in ${scope}` : query,
        isMono: true,
        kindKey,
      };
    }
  }

  if (item.olympus?.target?.title) {
    const extra = formatKeyValueFallback(obj);
    const params = extra ? `${item.olympus.target.title} (${extra})` : item.olympus.target.title;
    return {
      label: parsed.toolLabel,
      params,
      tooltip: params,
      isMono: false,
      kindKey,
    };
  }

  const kv = formatKeyValueFallback(obj);
  const base = rawPath ? compactPath(rawPath) : parsed.headerTitle || parsed.summary || '';
  const params =
    base && kv && !base.includes('=')
      ? `${base} (${kv})`
      : kv || base;

  return {
    label: parsed.toolLabel,
    params,
    tooltip: rawPath || params || item.title,
    isMono: Boolean(kv || rawPath),
    kindKey,
  };
}

export interface WorkGroupSummary {
  /** `Worked for 1m 10s`, or the single step's own action line (`Read config.py`, `Thought for 3s`). */
  headline: string;
  /** Short natural counts (`3 commands`, `2 files edited`), most important first; the header drops what does not fit. */
  parts: string[];
  /** Monospace-styled target for a single-step group (a command). */
  headlineTarget: string;
  headlineMono: boolean;
  failedCount: number;
  stoppedCount: number;
  durationLabel: string;
}

const HOME_RE = /^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/]|$)/;
/** Claude Code project folders (`~/.claude/projects/-Users-me-Documents-app`): a whole path flattened into one name. */
const SLUG_SEGMENT = /^-(?:Users|home)-/;

/**
 * Splits a file path into a readable `name` (basename) and a quiet `dir`: relative to `base` when inside it,
 * `~/…` for home paths, at most the last two folders, and flattened `-Users-me-…-app` folder names shortened.
 */
export function displayPath(raw: string, base?: string): { name: string; dir: string } {
  let clean = raw.trim().replace(/^file:\/\//i, '').replace(/[\\/]+$/, '');
  if (!clean) return { name: '', dir: '' };
  const root = base?.replace(/[\\/]+$/, '');
  let prefix = '';
  if (root && clean.startsWith(`${root}/`)) clean = clean.slice(root.length + 1);
  else if (HOME_RE.test(clean)) {
    clean = clean.replace(HOME_RE, '').replace(/^[\\/]/, '');
    prefix = '~';
  } else if (clean.startsWith('/')) prefix = '/';
  const parts = clean.split(/[\\/]+/).filter(Boolean);
  const name = parts.pop() ?? clean;
  const dirs = parts.map((d) => (SLUG_SEGMENT.test(d) ? `…${d.split('-').slice(-2).join('-')}` : d));
  let dir: string;
  const tail = dirs.slice(-2);
  // A shortened `…app` folder already says "somewhere deeper": no second `…/` in front of it.
  if (dirs.length > 2) dir = tail[0].startsWith('…') ? tail.join('/') : `${prefix === '~' ? '~/' : ''}…/${tail.join('/')}`;
  else if (prefix === '~') dir = ['~', ...dirs].join('/');
  else if (prefix === '/') dir = dirs.length ? `/${dirs.join('/')}` : '/';
  else dir = dirs.join('/');
  return { name, dir };
}

/** Past / present verb for each step kind, so rows read `Ran …`, `Read …`, `Edited …` (or `Running …` while live). */
const STEP_VERBS: Record<StepKind, [string, string]> = {
  command: ['Ran', 'Running'],
  read: ['Read', 'Reading'],
  edit: ['Edited', 'Editing'],
  create: ['Wrote', 'Writing'],
  delete: ['Deleted', 'Deleting'],
  move: ['Moved', 'Moving'],
  think: ['Thought', 'Thinking'],
  search: ['Searched', 'Searching'],
  web: ['Fetched', 'Fetching'],
  mcp: ['Called', 'Calling'],
  tool: ['Used', 'Using'],
  plan: ['Updated plan', 'Updating plan'],
  subagent: ['Ran agent', 'Running agent'],
  permission: ['Asked', 'Asking'],
  mode: ['Switched mode', 'Switching mode'],
  memory: ['Saved memory', 'Saving memory'],
  schedule: ['Scheduled', 'Scheduling'],
};

export function stepVerb(kind: StepKind, running: boolean): string {
  const v = STEP_VERBS[kind] ?? STEP_VERBS.tool;
  return running ? v[1] : v[0];
}

export interface StepAction {
  kind: StepKind;
  /** `Ran`, `Reading`, `Thought for 3s`, … */
  verb: string;
  /** What it acted on: a command, a file name, a query, a host. */
  target: string;
  /** Quiet folder after a file name. */
  dir: string;
  /** Target is code (a command, a query). */
  mono: boolean;
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url;
  }
}

/** One calm action line for any tool step: verb + target (+ dimmed folder). */
export function describeToolAction(item: ToolItem, running: boolean, base?: string): StepAction {
  const parsed = parseToolStep(item);
  const kind = toolStepKind(item, parsed);
  const verb = stepVerb(kind, running);
  if (parsed.isCommand) {
    const cmd = parsed.headerTitle || parsed.command || parsed.summary || '';
    return { kind, verb, target: cmd.replace(/\s+/g, ' ').trim(), dir: '', mono: Boolean(parsed.headerTitle || parsed.command) };
  }
  const obj = parseInputObject(item);
  if (kind === 'read' || kind === 'edit' || kind === 'create' || kind === 'delete' || kind === 'move') {
    const diffPath = item.content.find((c) => c.type === 'diff' && c.path)?.path;
    const rawPath =
      item.locations[0] ?? diffPath ?? pickStr(obj, ['Path', 'file_path', 'path', 'TargetFile', 'DirectoryPath']) ?? '';
    const p = displayPath(rawPath || parsed.headerTitle, base);
    return { kind, verb, target: p.name, dir: p.dir, mono: false };
  }
  if (kind === 'search' || kind === 'web') {
    const { query, scope } = toolQueryOf(item);
    if (query) {
      if (/^https?:\/\//i.test(query)) return { kind, verb, target: hostOf(query), dir: '', mono: false };
      return { kind, verb, target: query, dir: scope ? `in ${displayPath(scope, base).name}` : '', mono: true };
    }
  }
  if (kind === 'plan' || kind === 'subagent') {
    return { kind, verb, target: parsed.summary || parsed.headerTitle, dir: '', mono: false };
  }
  const desc = describeToolForHeader(item, parsed);
  const label = parsed.toolLabel;
  // Generic tools read `Used <tool name>` with its parameters quiet after it.
  const target = kind === 'tool' || kind === 'mcp' ? label : parsed.summary || desc.params || parsed.headerTitle;
  const rest = kind === 'tool' || kind === 'mcp' ? parsed.summary || desc.params : '';
  return { kind, verb, target, dir: rest && rest.toLowerCase() !== target.toLowerCase() ? rest : '', mono: false };
}

/** Header line of a reasoning step: `Thinking`, `Thought for 3s` or plain `Thought`. */
export function thoughtVerb(streaming: boolean, durationMs?: number): string {
  if (streaming) return 'Thinking';
  const d = fmtStepDuration(durationMs);
  return d && durationMs && durationMs >= 1000 ? `Thought for ${d}` : 'Thought';
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Summarizes a settled `WorkGroup` into one quiet line: `Worked for 1m 10s` + short natural counts,
 * or the single step's own action line when the group holds just one step.
 */
export function summarizeWorkGroup(items: WorkStepItem[]): WorkGroupSummary {
  let thoughts = 0;
  let plans = 0;
  let failedCount = 0;
  let stoppedCount = 0;
  let firstTs = Infinity;
  let lastEnd = 0;
  const counts = { command: 0, search: 0, web: 0, other: 0 };
  const edited = new Set<string>();
  const read = new Set<string>();

  for (const it of items) {
    if (it.ts < firstTs) firstTs = it.ts;
    if (it.ts > lastEnd) lastEnd = it.ts;
    if (it.kind === 'thought') {
      thoughts++;
      continue;
    }
    if (it.kind === 'plan') {
      plans++;
      continue;
    }
    const parsed = parseToolStep(it);
    const kind = toolStepKind(it, parsed);
    const badExit = parsed.exitCode !== undefined && parsed.exitCode !== 0;
    if (it.status === 'failed' || badExit || it.olympus?.isError) failedCount++;
    if (it.status === 'interrupted') stoppedCount++;
    const end = it.endedAt ?? (parsed.durationMs ? it.ts + parsed.durationMs : it.ts);
    if (end > lastEnd) lastEnd = end;
    const file = it.locations[0] ?? it.content.find((c) => c.type === 'diff' && c.path)?.path ?? it.id;
    if (kind === 'command') counts.command++;
    else if (kind === 'edit' || kind === 'create' || kind === 'delete' || kind === 'move') edited.add(file);
    else if (kind === 'read') read.add(file);
    else if (kind === 'search') counts.search++;
    else if (kind === 'web') counts.web++;
    else if (kind !== 'plan') counts.other++;
    else plans++;
  }

  const durationLabel = lastEnd > firstTs ? fmtStepDuration(lastEnd - firstTs) : '';

  if (items.length === 1) {
    const only = items[0];
    const base = { parts: [], failedCount, stoppedCount, durationLabel };
    if (only.kind === 'thought') {
      return { ...base, headline: 'Thought', headlineTarget: formatThoughtPreview(only.text, false), headlineMono: false };
    }
    if (only.kind === 'plan') {
      return { ...base, headline: 'Updated plan', headlineTarget: plural(only.entries.length, 'task', 'tasks'), headlineMono: false };
    }
    const a = describeToolAction(only, false);
    return { ...base, headline: a.verb, headlineTarget: a.target, headlineMono: a.mono };
  }

  const parts: string[] = [];
  if (counts.command) parts.push(plural(counts.command, 'command', 'commands'));
  if (edited.size) parts.push(`${plural(edited.size, 'file', 'files')} edited`);
  if (read.size) parts.push(`${plural(read.size, 'file', 'files')} read`);
  if (counts.search) parts.push(plural(counts.search, 'search', 'searches'));
  if (counts.web) parts.push(plural(counts.web, 'web fetch', 'web fetches'));
  if (counts.other) parts.push(plural(counts.other, 'other step', 'other steps'));
  if (plans && !parts.length) parts.push('plan updated');
  if (thoughts && !parts.length) parts.push(plural(thoughts, 'thought', 'thoughts'));

  return {
    headline: durationLabel ? `Worked for ${durationLabel}` : 'Worked',
    parts,
    headlineTarget: '',
    headlineMono: false,
    failedCount,
    stoppedCount,
    durationLabel,
  };
}
