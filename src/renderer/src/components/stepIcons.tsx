import {
  BookmarkPlus,
  Bot,
  Brain,
  Clock,
  FilePen,
  FilePlus,
  FileText,
  FolderInput,
  Globe,
  ListTodo,
  Plug,
  Search,
  ShieldCheck,
  SquareTerminal,
  ToggleLeft,
  Trash2,
  Wrench,
} from 'lucide-react';
import { parseToolStep, resolveOlympusTool, type ParsedToolStep, type ToolItem } from '../toolStep';
import type { WorkStepItem } from '../workStepSummary';

/** What a single step is, at a glance: drives the rail icon, the live header icon and the content box. */
export type StepKind =
  | 'command'
  | 'read'
  | 'edit'
  | 'create'
  | 'delete'
  | 'move'
  | 'think'
  | 'search'
  | 'web'
  | 'mcp'
  | 'tool'
  | 'plan'
  | 'subagent'
  | 'permission'
  | 'mode'
  | 'memory'
  | 'schedule';

const ICONS: Record<StepKind, typeof Wrench> = {
  command: SquareTerminal,
  read: FileText,
  edit: FilePen,
  create: FilePlus,
  delete: Trash2,
  move: FolderInput,
  think: Brain,
  search: Search,
  web: Globe,
  mcp: Plug,
  tool: Wrench,
  plan: ListTodo,
  subagent: Bot,
  permission: ShieldCheck,
  mode: ToggleLeft,
  memory: BookmarkPlus,
  schedule: Clock,
};

/** Native sub-agent launchers across CLIs (Claude `Task`/`Agent`, Antigravity `invoke_subagent`/`swarm`, ...). */
const SUBAGENT_TITLE = /^(?:Run\s+)?(?:task|agent|dispatch_agent|spawn_agent|delegate_task|invoke_subagent|swarm)(?:\b|_)/i;
/** MCP tool titles: `mcp__server__tool` (Claude), `mcp_server_<hash>_tool` (Antigravity), `name (MCP)`. */
const MCP_TITLE = /(?:^|[\s:])mcp(?:__|_|:)|\(MCP\)|^MCP Tool\b/i;
/** Claude `think`-kind titles that are task-list (plan) tools: `Update TODOs: …`, `Create task: …`, `List tasks`, `Get task`. */
export const CLAUDE_PLAN_TITLE = /\btodos?\b|^(?:create|update|get|list) tasks?\b/i;
/** Claude `think`-kind titles that are plain tools, not sub-agents: `Report 2 findings`, `Compact conversation`. */
export const CLAUDE_TOOL_TITLE = /^report\b.*\bfindings?\b|^compact conversation\b/i;

/** A Write/Create edit whose diffs carry no previous text: a brand-new file. */
function isCreateStep(item: ToolItem): boolean {
  const title = item.title.trim();
  if (/^(?:Create|New file)\b/i.test(title)) return true;
  if (!/^Write\b/i.test(title)) return false;
  const diffs = item.content.filter((c) => c.type === 'diff');
  return diffs.length > 0 && diffs.every((d) => !d.oldText);
}

/** Derives the step kind of a tool call from its ACP `toolKind`, the app's own tool name and its title. */
export function toolStepKind(item: ToolItem, parsedProp?: ParsedToolStep): StepKind {
  const parsed = parsedProp ?? parseToolStep(item);
  if (parsed.isCommand) return 'command';
  const oly = resolveOlympusTool(item);
  if (oly) {
    if (oly.includes('subsession')) return 'subagent';
    if (oly === 'remember_about_user') return 'memory';
    if (oly.includes('schedule')) return 'schedule';
    return 'mcp';
  }
  const title = item.title.trim();
  if (SUBAGENT_TITLE.test(title)) return 'subagent';
  switch (item.toolKind) {
    case 'read':
      return 'read';
    case 'edit':
      return isCreateStep(item) ? 'create' : 'edit';
    case 'delete':
      return 'delete';
    case 'move':
      return 'move';
    case 'search':
      // Antigravity labels its web search as `"query" on Web` with the plain `search` kind.
      return /\bon (?:the )?web$/i.test(title) ? 'web' : 'search';
    case 'fetch':
      return 'web';
    case 'switch_mode':
      return 'mode';
    case 'think':
      // Claude Code reports TodoWrite, its task-list tools (TaskCreate/Update/List/Get), ReportFindings, compaction
      // and the `Agent`/`Task` sub-agent tool (titled with its free-form description) all with the `think` kind.
      if (CLAUDE_PLAN_TITLE.test(title)) return 'plan';
      if (CLAUDE_TOOL_TITLE.test(title)) return 'tool';
      return /^(?:think|thinking|reason)/i.test(title) ? 'think' : 'subagent';
    default:
      break;
  }
  if (/\bpermission\b/i.test(title)) return 'permission';
  if (MCP_TITLE.test(title)) return 'mcp';
  return 'tool';
}

/**
 * `.k-*` colour class key for a step kind, so a badge or icon is coloured by what the step is rather than by its
 * raw ACP `toolKind` (Claude reports `TodoWrite` and `Task` as `think`, which would paint Plan / Sub-agent purple).
 */
export function stepKindColor(kind: StepKind): string {
  switch (kind) {
    case 'think':
      return 'think';
    case 'command':
      return 'execute';
    case 'read':
    case 'edit':
    case 'delete':
    case 'move':
    case 'search':
      return kind;
    case 'create':
      return 'edit'; // A new file is still a file write: same colour as edits (there is no `.k-create` rule).
    case 'web':
      return 'fetch';
    default:
      return 'other';
  }
}

/** Step kind of any WorkGroup item: reasoning, a plan checklist or a tool call. */
export function workStepKind(item: WorkStepItem): StepKind {
  if (item.kind === 'thought') return 'think';
  if (item.kind === 'plan') return 'plan';
  return toolStepKind(item);
}

/** The small type glyph for a step kind (lucide, like the rest of the app). */
export function StepIcon({ kind, size = 12 }: { kind: StepKind; size?: number }) {
  const Icon = ICONS[kind] ?? Wrench;
  return <Icon size={size} strokeWidth={2.1} />;
}
