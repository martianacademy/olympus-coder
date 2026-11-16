import type { ThreadItem } from '@shared/types';

export type ToolItem = Extract<ThreadItem, { kind: 'tool' }>;

/**
 * Normalized view of a tool call item for rendering in Chat, WorkingIndicator, and TasksPanel.
 * Separates tool name, human summary, command/input text, and clean response output across
 * Antigravity, Claude Code, Codex, registry ACP agents, and Olympus MCP tools.
 */
export interface ParsedToolStep {
  /** True when this step executes a shell command (`execute` or `run_in_terminal`). */
  isCommand: boolean;
  /** Short human-readable tool category/name shown in the header badge (`Command`, `Terminal`, `Read`, `Edit`, etc.). */
  toolLabel: string;
  /** Full untruncated shell command for command steps; empty otherwise. */
  command: string;
  /** Compact single-line subject/preview (without repeating `toolLabel` or a leading `$ `). */
  headerTitle: string;
  /** Human-readable intent summary (e.g. `toolSummary`, Bash `description`, or terminal tab title). */
  summary?: string;
  /** Formatted input payload for non-command tools that record `Input:`. */
  input: string;
  /** Clean response / stdout+stderr text with agent wrappers and code fences removed. */
  output: string;
  /** Process exit status reported by the agent (`0`, `1`, `127`, `143`, etc.), if known. */
  exitCode?: number;
  /** Execution duration in milliseconds (`endedAt - ts` or `Completed At - Created At`). */
  durationMs?: number;
  /** Local file path when the agent saved full untruncated command output to disk. */
  truncatedOutputPath?: string;
  /** True when the agent explicitly reported that the command produced no output. */
  explicitNoOutput: boolean;
}

const GENERIC_CMD_TITLE = /^(?:Tool|(?:Run\s+)?(?:bash|sh|zsh|shell|cmd|powershell|pwsh|terminal|execute|command|run_command))$/i;

const LEGACY_OLYMPUS_RE = /olympus(?:[_.]{1,2}[0-9a-f]{4,16})?[_.]{1,2}([a-z_]+)\b/i;

const AGY_TRUNCATED_RE =
  /^The tool's output was truncated due to being too long\.\s*You can find the full output in a file at (file:\/\/\/\S+?)\.\n+Here is a preview with the middle of the output truncated:\n/;

const AGY_HEADER_RE =
  /^(?:Created At:\s*([^\n]+)\n(?:Completed At:\s*([^\n]+)\n)?)?(?:Command exited with code (-?\d+)\.|(Command was terminated by signal or canceled\.))?[ \t]*\n*/;

const SUBSESSION_TOOLS = new Set([
  'spawn_subsession',
  'configure_subsession',
  'wait_for_subsessions',
  'get_subsession',
  'message_subsession',
  'cancel_subsession',
]);

const SCHEDULE_TOOLS = new Set(['list_schedules', 'save_schedule', 'delete_schedule', 'run_schedule']);

/**
 * Formats a step duration in milliseconds into a short human-readable label (`1.2s`, `4s`, `2m 05s`).
 * Returns an empty string when duration is unknown or below 200ms.
 */
export function fmtStepDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 200) return '';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 10_000) {
    const tenths = Math.round(ms / 100) / 10;
    return Number.isInteger(tenths) ? `${tenths}s` : `${tenths.toFixed(1)}s`;
  }
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The app's own MCP tool name behind a tool item (`spawn_subsession`, `run_in_terminal`, ...), if it is one. */
export function resolveOlympusTool(t: ToolItem): string | undefined {
  if (t.olympus?.tool) return t.olympus.tool;
  const m = LEGACY_OLYMPUS_RE.exec(t.title);
  if (m) return m[1].toLowerCase();
  if (/^Run in terminal(?::|$)/.test(t.title)) return 'run_in_terminal';
  if (t.title === 'Read terminal') return 'read_terminal';
  if (t.title === 'Session info') return 'session_info';
  if (t.title === 'List agents') return 'list_agents';
  if (t.title === 'List scheduled tasks') return 'list_schedules';
  if (t.title.startsWith('Save scheduled task')) return 'save_schedule';
  if (t.title.startsWith('Delete scheduled task')) return 'delete_schedule';
  if (t.title.startsWith('Run scheduled task')) return 'run_schedule';
  if (t.title.startsWith('Configure sub-session')) return 'configure_subsession';
  if (t.title.startsWith('Learned about you')) return 'remember_about_user';
  return undefined;
}

/** Quick check for whether a tool item represents a shell command execution. */
export function isCommandStep(t: ToolItem): boolean {
  return t.toolKind === 'execute' || resolveOlympusTool(t) === 'run_in_terminal';
}

/** Collapses a command into a single-line preview for compact headers while preserving meaning. */
function oneLineCommand(cmd: string): string {
  const stripped = cmd.trim().replace(/^(?:cd\s+\S+\s*&&\s*)+/, '');
  return (stripped || cmd).replace(/\s+/g, ' ').trim();
}

/** Case-insensitive extraction of a string field from JSON input (including 6000-char truncated JSON). */
function extractJsonField(rawJson: string, parsed: Record<string, unknown> | null, keys: string[]): string {
  const lowerTargets = new Set(keys.map((k) => k.toLowerCase()));
  if (parsed) {
    for (const [k, v] of Object.entries(parsed)) {
      if (lowerTargets.has(k.toLowerCase()) && typeof v === 'string' && v.trim()) {
        return v.trim();
      }
    }
  }
  for (const k of keys) {
    const m = new RegExp(`"${k}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i').exec(rawJson);
    if (m) {
      try {
        return (JSON.parse(`"${m[1]}"`) as string).trim();
      } catch {
        return m[1].trim();
      }
    }
  }
  return '';
}

function deriveToolLabel(t: ToolItem, isCommand: boolean, olympusTool: string | undefined): string {
  if (olympusTool === 'run_in_terminal') return 'Terminal';
  if (isCommand) return 'Command';
  if (olympusTool === 'session_info') return 'Session info';
  if (olympusTool === 'list_agents') return 'Agents';
  if (olympusTool === 'read_terminal') return 'Read terminal';
  if (olympusTool === 'remember_about_user') return 'Memory';
  if (olympusTool && SCHEDULE_TOOLS.has(olympusTool)) return 'Schedule';
  if (olympusTool && SUBSESSION_TOOLS.has(olympusTool)) return 'Sub-session';

  const trimmedTitle = t.title.trim();
  switch (t.toolKind) {
    case 'read':
      return 'Read';
    case 'edit':
      return /^Write\b/i.test(trimmedTitle) ? 'Write' : 'Edit';
    case 'delete':
      return 'Delete';
    case 'move':
      return 'Move';
    case 'search':
      return 'Search';
    case 'fetch':
      return /^Search\b/i.test(trimmedTitle) ? 'Web search' : 'Web';
    case 'think':
      // Claude Code's `think`-kind tools: same split as `toolStepKind` in stepIcons.tsx.
      if (/\btodos?\b|^(?:create|update|get|list) tasks?\b/i.test(trimmedTitle)) return 'Plan';
      if (/^report\b.*\bfindings?\b/i.test(trimmedTitle)) return 'Findings';
      if (/^compact conversation\b/i.test(trimmedTitle)) return 'Compact';
      return /^(?:think|thinking|reason)/i.test(trimmedTitle) ? 'Think' : 'Sub-agent';
    case 'switch_mode':
      return 'Mode';
    default: {
      const m = /^(?:Run\s+)?([\w.:-]+)(?::\s*|$)/.exec(trimmedTitle);
      return m ? m[1] : 'Tool';
    }
  }
}

function deriveNonCommandSubject(
  t: ToolItem,
  toolLabel: string,
  olympusTool: string | undefined,
  inputObj: Record<string, unknown> | null,
  output: string,
): string {
  const rawTitle = t.title.replace(/\s+/g, ' ').trim();
  if (olympusTool === 'read_terminal') {
    const termName = /^Terminal "([^"]+)"/.exec(output)?.[1]?.trim();
    return termName ?? '';
  }
  if (olympusTool === 'session_info' || olympusTool === 'list_agents' || olympusTool === 'list_schedules') return '';
  if (olympusTool && SCHEDULE_TOOLS.has(olympusTool)) {
    return rawTitle.replace(/^(?:Save|Delete|Run)\s+scheduled\s+task(?::\s*)?/i, '').trim();
  }
  if (olympusTool === 'remember_about_user') {
    return rawTitle.replace(/^Learned about you(?::\s*)?/i, '').trim();
  }
  if (olympusTool && SUBSESSION_TOOLS.has(olympusTool)) {
    return rawTitle.replace(/^Run\s+\S+:\s*/i, '').trim();
  }

  switch (t.toolKind) {
    case 'read':
      return rawTitle.replace(/^(?:Read|File)\s+/i, '').trim();
    case 'edit':
      return rawTitle.replace(/^(?:Write|Edit|Update|File)\s+/i, '').trim();
    case 'delete':
      return rawTitle.replace(/^(?:Delete|Remove|File)\s+/i, '').trim();
    case 'move':
      return rawTitle.replace(/^(?:Move|Rename|File)\s+/i, '').trim();
    case 'fetch':
      return rawTitle.replace(/^(?:Search|Fetch)\s+/i, '').trim();
    default: {
      const withColon = /^(?:Run\s+)?[\w.:-]+:\s*(.+)$/.exec(rawTitle);
      if (withColon) return withColon[1].trim();
      const bare = rawTitle.replace(/^Run\s+/i, '').trim();
      if (bare.toLowerCase() === toolLabel.toLowerCase()) {
        const action = inputObj ? extractJsonField('', inputObj, ['Action', 'action', 'query', 'pattern']) : '';
        return action;
      }
      return rawTitle;
    }
  }
}

const parsedCache = new WeakMap<ToolItem, { sig: string; val: ParsedToolStep }>();

function toolStepSig(t: ToolItem): string {
  const last = t.content[t.content.length - 1];
  const lastLen = last ? (last.type === 'diff' ? (last.newText?.length ?? 0) : (last.text?.length ?? 0)) : 0;
  return `${t.status}|${t.title}|${t.summary ?? ''}|${t.endedAt ?? ''}|${t.content.length}|${lastLen}|${t.olympus?.result?.length ?? -1}|${t.olympus?.isError ?? ''}|${t.terminalKey ?? ''}|${t.terminalText?.length ?? -1}|${t.terminalExitCode ?? ''}`;
}

/**
 * Parses a `ThreadItem` of kind `'tool'` into clean `toolLabel`, `summary`, `command`,
 * `input`, `output`, `exitCode`, and `durationMs` fields without mutating stored thread data.
 * Memoized per `ToolItem` via WeakMap so repeated renders are O(1).
 */
export function parseToolStep(t: ToolItem): ParsedToolStep {
  const sig = toolStepSig(t);
  const cached = parsedCache.get(t);
  if (cached && cached.sig === sig) return cached.val;

  const olympusTool = resolveOlympusTool(t);
  const isRunInTerm = olympusTool === 'run_in_terminal';
  // A tool with a terminal behind it (ACP `terminal` content or `_meta.terminal_*`) is a command too.
  const isCommand = t.toolKind === 'execute' || isRunInTerm || Boolean(t.terminalKey);
  const toolLabel = deriveToolLabel(t, isCommand, olympusTool);

  let rawInputText = '';
  const rawOutputs: string[] = [];

  for (const c of t.content) {
    // Media, resources and links (`rich`) render on their own (RichContent.tsx), not as output text.
    if (c.type === 'diff' || c.rich || !c.text) continue;
    const normalized = c.text.replace(/\r\n/g, '\n');
    if (/^Input:(?:\s|$)/.test(normalized)) {
      rawInputText = normalized.replace(/^Input:\s*/, '');
    } else {
      rawOutputs.push(normalized.replace(/^Output:\s*\n?/, ''));
    }
  }

  let inputObj: Record<string, unknown> | null = null;
  let formattedInput = rawInputText.trim();
  if (formattedInput) {
    try {
      const parsed: unknown = JSON.parse(formattedInput);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        inputObj = parsed as Record<string, unknown>;
      }
      formattedInput = JSON.stringify(parsed, null, 2);
    } catch {
      /* Input is plain text or truncated JSON; keep as-is. */
    }
  }

  let summary =
    t.summary?.replace(/\s+/g, ' ').trim() ||
    extractJsonField(rawInputText, inputObj, ['toolSummary', 'description']) ||
    undefined;

  // Claude Code sends a 1-line human description in `content` while a Bash command is still running.
  const preCompletion = t.status === 'pending' || t.status === 'in_progress' || t.status === 'interrupted';
  if (
    t.toolKind === 'execute' &&
    preCompletion &&
    rawOutputs.length === 1 &&
    !rawOutputs[0].trimStart().startsWith('```') &&
    !/^(?:Created At:|Exit code -?\d+|Command exited with code )/.test(rawOutputs[0].trimStart()) &&
    !rawOutputs[0].includes('\n') &&
    rawOutputs[0].trim().length <= 200
  ) {
    summary = summary ?? rawOutputs[0].trim();
    rawOutputs.length = 0;
  }

  let command = '';
  if (isCommand) {
    if (isRunInTerm) {
      const fromOlympus = t.olympus?.text?.trim() ?? '';
      const fromInput = extractJsonField(rawInputText, inputObj, ['command', 'CommandLine', 'cmd']);
      const legacyTerm = /^Run\s+\S*run_in_terminal:\s*(.+?)\s+—\s+(.+)$/is.exec(t.title);
      const fromTitle = legacyTerm?.[2]?.trim() ?? /^Run in terminal:\s*(.+)$/s.exec(t.title)?.[1]?.trim() ?? '';
      const fromResult = /and typed:\s*([^\n]+)/.exec(t.olympus?.result ?? rawOutputs[0] ?? '')?.[1]?.trim() ?? '';
      command = fromOlympus || fromInput || fromTitle || fromResult || t.title;
      const tabTitle =
        extractJsonField(rawInputText, inputObj, ['title']) ||
        legacyTerm?.[1]?.trim() ||
        /^Opened terminal "([^"]+)"/.exec((t.olympus?.result ?? rawOutputs[0] ?? '').trim())?.[1]?.trim() ||
        '';
      if (tabTitle && !summary) summary = tabTitle;
    } else {
      const fromInput = extractJsonField(rawInputText, inputObj, ['CommandLine', 'command', 'cmd']);
      const titleTrimmed = t.title.trim();
      if (fromInput && (GENERIC_CMD_TITLE.test(titleTrimmed) || (!rawInputText.endsWith('…') && fromInput.length > titleTrimmed.length))) {
        command = fromInput;
      } else {
        command = titleTrimmed || fromInput || 'command';
      }
    }
  }

  // Olympus MCP calls on Antigravity only populate `Input:` in `t.content` while storing the response on `t.olympus.result`.
  let rawOut = rawOutputs.join('\n').trim();
  if (!rawOut && t.olympus?.result) {
    rawOut = t.olympus.result.replace(/\r\n/g, '\n').trim();
  }
  // The saved end of a live terminal's output (Claude's Bash output only comes this way).
  if (!rawOut && t.terminalText) rawOut = t.terminalText.replace(/\r\n/g, '\n').trim();

  let exitCode: number | undefined = typeof t.terminalExitCode === 'number' ? t.terminalExitCode : undefined;
  let parsedDurMs: number | undefined;
  let truncatedOutputPath: string | undefined;
  let explicitNoOutput = false;

  const trimmedStart = rawOut.trimStart();
  const wasFenced = trimmedStart.startsWith('```');
  let fenceLang = '';

  if (wasFenced) {
    const exactFence = /^```([\w.-]*)[ \t]*\n([\s\S]*?)\n?```[ \t]*$/.exec(trimmedStart);
    if (exactFence) {
      fenceLang = exactFence[1].toLowerCase();
      rawOut = exactFence[2];
    } else if (isCommand) {
      const openFence = /^```([\w.-]*)[ \t]*\n/.exec(trimmedStart);
      if (openFence) {
        fenceLang = openFence[1].toLowerCase();
        rawOut = trimmedStart.slice(openFence[0].length).replace(/\n?```[ \t]*$/, '');
      }
    }
    // Claude Code prefixes non-zero command blocks (` ```\nExit code N\n... `) with the exit status line.
    if (isCommand && fenceLang !== 'console') {
      const claudeExit = /^Exit code (-?\d+)(?:\n([\s\S]*))?$/.exec(rawOut);
      if (claudeExit) {
        exitCode = Number(claudeExit[1]);
        rawOut = claudeExit[2] ?? '';
      }
    }
  } else {
    const truncMatch = AGY_TRUNCATED_RE.exec(rawOut);
    if (truncMatch) {
      try {
        truncatedOutputPath = decodeURIComponent(truncMatch[1].replace(/^file:\/\//i, ''));
      } catch {
        truncatedOutputPath = truncMatch[1].replace(/^file:\/\//i, '');
      }
      rawOut = rawOut.slice(truncMatch[0].length);
    }

    const agyHead = AGY_HEADER_RE.exec(rawOut);
    if (agyHead && (agyHead[1] || agyHead[3] !== undefined || agyHead[4])) {
      const createdMs = agyHead[1] ? Date.parse(agyHead[1].trim()) : NaN;
      const completedMs = agyHead[2] ? Date.parse(agyHead[2].trim()) : NaN;
      if (Number.isFinite(createdMs) && Number.isFinite(completedMs) && completedMs >= createdMs) {
        parsedDurMs = completedMs - createdMs;
      }
      if (agyHead[3] !== undefined) {
        exitCode = Number(agyHead[3]);
      }
      let rest = rawOut.slice(agyHead[0].length);
      rest = rest.replace(/^There were sandbox errors[^\n]*\n+/, '');
      if (/^Command output:[ \t]*(?:\n|$)/.test(rest)) {
        rawOut = rest.replace(/^Command output:[ \t]*\n?/, '');
        if (!rawOut.trim()) explicitNoOutput = true;
      } else if (/^No output from the command\.\s*$/.test(rest) || rest.trim() === '') {
        rawOut = '';
        explicitNoOutput = true;
      } else {
        rawOut = rest;
      }
    }
  }

  // Drop blank edges but keep the first line's indentation (line-numbered file reads, aligned tables).
  const output = rawOut.trim() ? rawOut.replace(/^(?:[ \t]*\n)+/, '').trimEnd() : '';
  if (exitCode === undefined && t.toolKind === 'execute' && t.status === 'completed' && !t.olympus?.isError) {
    exitCode = 0;
  }
  const durationMs =
    t.endedAt !== undefined && t.endedAt >= t.ts
      ? t.endedAt - t.ts
      : parsedDurMs;

  const cleanSummary = summary ? summary.replace(/\s+/g, ' ').trim() : undefined;
  const headerTitle = isCommand
    ? oneLineCommand(command)
    : deriveNonCommandSubject(t, toolLabel, olympusTool, inputObj, output);

  const result: ParsedToolStep = {
    isCommand,
    toolLabel,
    command,
    headerTitle,
    summary: cleanSummary && cleanSummary !== command ? cleanSummary : undefined,
    input: isCommand ? '' : formattedInput,
    output,
    exitCode,
    durationMs,
    truncatedOutputPath,
    explicitNoOutput,
  };
  parsedCache.set(t, { sig, val: result });
  return result;
}
