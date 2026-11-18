import type { DeskEvents, ScheduleKind, ScheduledTask, Thread } from '@shared/types';
import { allAgents } from './agents';
import { agentName } from './guide';
import { deleteSchedule, listSchedules, runSchedule, saveSchedule } from './schedules';
import { getProject, listProjects } from './store';
import { ToolError } from './orchestratorAgents';

type Emit = <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => void;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Main and user-forked sessions may inspect and manage scheduled tasks; workers and read-only second opinions may not. */
export function canManageSchedules(t: Pick<Thread, 'spawnedBy' | 'secondOpinion'>): boolean {
  return !t.spawnedBy && !t.secondOpinion;
}

function describeSchedule(s: ScheduledTask): string {
  const project = getProject(s.projectId)?.name ?? s.projectId;
  const cadence =
    s.kind === 'once'
      ? `once at ${s.at ? new Date(s.at).toLocaleString() : '(unset)'}`
      : s.kind === 'interval'
        ? `every ${s.everyMinutes ?? 60} min`
        : s.kind === 'daily'
          ? `daily at ${s.time ?? '09:00'}`
          : `weekly on ${DAYS[s.weekday ?? 1]} at ${s.time ?? '09:00'}`;
  const state = s.enabled ? (s.nextRun ? `enabled · next: ${new Date(s.nextRun).toLocaleString()}` : 'enabled (completed)') : 'paused';
  const last = s.lastRun ? ` · last: ${new Date(s.lastRun).toLocaleString()}${s.lastThreadId ? ` (chat ${s.lastThreadId})` : ''}` : '';
  return [
    `- **${s.name}** (id: \`${s.id}\`)`,
    `  project: ${project} (\`${s.projectId}\`) · agent: ${agentName(s.agentId)} (\`${s.agentId}\`) · ${cadence} · ${state}${last}`,
    `  prompt: ${s.prompt.replace(/\s+/g, ' ').slice(0, 240)}${s.prompt.length > 240 ? '…' : ''}`,
  ].join('\n');
}

function parseWeekday(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 6) return raw;
  const s = String(raw).trim().toLowerCase();
  if (/^[0-6]$/.test(s)) return Number(s);
  const idx = DAYS.findIndex((d) => d.toLowerCase().startsWith(s.slice(0, 3)));
  if (idx >= 0 && s.length >= 3) return idx;
  throw new ToolError(`Invalid weekday "${raw}". Use 0–6 (0 = Sunday … 6 = Saturday) or a day name such as "Monday".`);
}

function parseOnceTimestamp(atRaw: unknown, inMinutesRaw: unknown): number | undefined {
  if (inMinutesRaw !== undefined && inMinutesRaw !== null && inMinutesRaw !== '') {
    const mins = Number(inMinutesRaw);
    if (!Number.isFinite(mins) || mins <= 0) throw new ToolError('"inMinutes" must be a positive number.');
    return Date.now() + Math.round(mins * 60_000);
  }
  if (atRaw === undefined || atRaw === null || atRaw === '') return undefined;
  if (typeof atRaw === 'number' && Number.isFinite(atRaw)) return atRaw < 1e12 ? atRaw * 1000 : atRaw;
  const parsed = Date.parse(String(atRaw).trim());
  if (!Number.isFinite(parsed)) {
    throw new ToolError(`Invalid "at" timestamp "${atRaw}". Pass an ISO-8601 date-time (e.g. "2026-11-16T09:00:00") or use "inMinutes".`);
  }
  return parsed;
}

function resolveProjectId(rawProject: unknown, fallbackProjectId: string): string {
  if (typeof rawProject !== 'string' || !rawProject.trim()) return fallbackProjectId;
  const wanted = rawProject.trim();
  const projects = listProjects();
  const exact = projects.find((p) => p.id === wanted);
  if (exact) return exact.id;
  const byName = projects.find((p) => p.name.toLowerCase() === wanted.toLowerCase() || p.path === wanted);
  if (byName) return byName.id;
  throw new ToolError(`Unknown project "${wanted}". Available projects: ${projects.map((p) => `${p.name} (${p.id})`).join(', ') || 'none'}.`);
}

export function scheduleToolDefs(currentAgentId: string) {
  // Kept small on purpose: agy silently disables MCP tools with large declarations (see toolsFor in orchestrator.ts).
  return [
    {
      name: 'list_schedules',
      title: 'List scheduled tasks',
      description:
        'List Olympus Coder persistent scheduled tasks (once, interval, daily, or weekly prompts that open a project chat at the scheduled time). Defaults to all scheduled tasks, marking which belong to this project.',
      inputSchema: {
        type: 'object',
        properties: {
          projectOnly: { type: 'boolean', description: 'When true, show only scheduled tasks for this session’s project.' },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'save_schedule',
      title: 'Save scheduled task',
      description: 'Create or update (`id`) a scheduled prompt that opens a project chat when due.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Update id; omit to create.' },
          name: { type: 'string' },
          prompt: { type: 'string' },
          kind: { type: 'string', enum: ['once', 'interval', 'daily', 'weekly'] },
          agent: { type: 'string', description: `Default ${currentAgentId}.` },
          projectId: { type: 'string', description: 'Default this project.' },
          at: { type: 'string', description: 'ISO-8601 (once).' },
          inMinutes: { type: 'number', minimum: 1 },
          everyMinutes: { type: 'number', minimum: 1 },
          time: { type: 'string', description: '"HH:MM" (daily/weekly).' },
          weekday: { type: 'string', description: '0-6 or day name.' },
          enabled: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'delete_schedule',
      title: 'Delete scheduled task',
      description: 'Delete a persistent scheduled task by id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Schedule id from list_schedules.' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      name: 'run_schedule',
      title: 'Run scheduled task now',
      description: 'Trigger an existing scheduled task immediately in a new project chat, returning the created chat id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Schedule id from list_schedules.' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
  ];
}

export async function handleScheduleTool(thread: Thread, toolName: string, args: any, emit: Emit): Promise<string | undefined> {
  if (!['list_schedules', 'save_schedule', 'delete_schedule', 'run_schedule'].includes(toolName)) return undefined;
  if (!canManageSchedules(thread)) throw new ToolError('Sub-sessions cannot modify or trigger persistent scheduled tasks.');

  if (toolName === 'list_schedules') {
    const all = listSchedules();
    const list = args?.projectOnly ? all.filter((s) => s.projectId === thread.projectId) : all;
    if (!list.length) return args?.projectOnly ? 'No scheduled tasks for this project.' : 'No scheduled tasks configured.';
    return `Scheduled tasks (${list.length}):\n\n${list.map(describeSchedule).join('\n\n')}`;
  }

  if (toolName === 'save_schedule') {
    const all = listSchedules();
    const existing = typeof args?.id === 'string' && args.id.trim() ? all.find((s) => s.id === args.id.trim()) : undefined;
    if (args?.id && !existing) throw new ToolError(`No scheduled task found with id "${args.id}". Call list_schedules first.`);

    const name = typeof args?.name === 'string' ? args.name.trim() : existing?.name ?? '';
    const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : existing?.prompt ?? '';
    if (!name || !prompt) throw new ToolError('Both "name" and "prompt" are required when creating a scheduled task.');

    const kind = (typeof args?.kind === 'string' ? args.kind.trim() : existing?.kind ?? 'daily') as ScheduleKind;
    if (!['once', 'interval', 'daily', 'weekly'].includes(kind)) {
      throw new ToolError(`Invalid schedule kind "${kind}". Expected one of: once, interval, daily, weekly.`);
    }

    const projectId = resolveProjectId(args?.projectId, existing?.projectId ?? thread.projectId);
    if (projectId === 'general') {
      throw new ToolError('Scheduled tasks require a code project folder. Pass a project name/id in "projectId" or open a project chat.');
    }

    const agentId = typeof args?.agent === 'string' && args.agent.trim() ? args.agent.trim() : (existing?.agentId ?? thread.agentId);
    const validAgents = allAgents().map((a) => a.id);
    if (!validAgents.includes(agentId)) {
      throw new ToolError(`Unknown agent "${agentId}". Available: ${validAgents.join(', ')}.`);
    }

    const enabled = typeof args?.enabled === 'boolean' ? args.enabled : (existing?.enabled ?? true);
    let at = parseOnceTimestamp(args?.at, args?.inMinutes) ?? existing?.at;
    let everyMinutes = args?.everyMinutes !== undefined ? Number(args.everyMinutes) : existing?.everyMinutes;
    let time = typeof args?.time === 'string' ? args.time.trim() : existing?.time;
    let weekday = parseWeekday(args?.weekday) ?? existing?.weekday;

    if (kind === 'once') {
      if (!at || (enabled && at <= Date.now())) {
        throw new ToolError('For kind="once", provide a future time via "at" (ISO-8601) or "inMinutes" (> 0).');
      }
    } else if (kind === 'interval') {
      everyMinutes = Math.max(1, Math.round(Number(everyMinutes ?? 60)));
      if (!Number.isFinite(everyMinutes) || everyMinutes < 1) throw new ToolError('For kind="interval", "everyMinutes" must be at least 1.');
    } else if (kind === 'daily' || kind === 'weekly') {
      time = time || '09:00';
      if (!TIME_RE.test(time)) throw new ToolError(`Invalid "time" "${time}". Expected 24-hour "HH:MM" (e.g. "09:00" or "18:30").`);
      if (kind === 'weekly') weekday = weekday ?? 1;
    }

    const savedList = saveSchedule(
      {
        id: existing?.id,
        name,
        projectId,
        agentId,
        prompt,
        kind,
        at,
        everyMinutes,
        time,
        weekday,
        enabled,
      },
      emit,
    );
    const saved = existing ? savedList.find((s) => s.id === existing.id) : savedList[savedList.length - 1];
    return `${existing ? 'Updated' : 'Created'} scheduled task:\n\n${saved ? describeSchedule(saved) : name}`;
  }

  if (toolName === 'delete_schedule') {
    const id = String(args?.id ?? '').trim();
    const target = listSchedules().find((s) => s.id === id);
    if (!target) throw new ToolError(`No scheduled task found with id "${id}".`);
    deleteSchedule(id, emit);
    return `Deleted scheduled task "${target.name}" (${id}).`;
  }

  const id = String(args?.id ?? '').trim();
  const target = listSchedules().find((s) => s.id === id);
  if (!target) throw new ToolError(`No scheduled task found with id "${id}".`);
  const threadId = await runSchedule(id, emit);
  if (!threadId) throw new ToolError(`Could not run scheduled task "${target.name}" (its project may have been removed).`);
  return `Triggered scheduled task "${target.name}" (${id}) in new chat ${threadId}.`;
}
