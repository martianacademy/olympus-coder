import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Project, ProjectStats, UsageTotals } from '@shared/types';
import { memoryDir, projectInstructionsPath } from './memory';
import { projectThreads } from './store';
import { addUsage, dayKey, emptyTotals, usageRecords } from './usage';

/**
 * A project's dashboard numbers over the last `days` days (0 = all time):
 * tokens and cost from the usage log, and sessions, messages, tool calls, files, errors and agent time from
 * the project's chats. Everything is counted from what the app recorded; nothing is estimated except cost
 * (which the agents report at API prices).
 */

const DAY = 86_400_000;
/** A turn longer than this is treated as left open (the app was closed mid-turn), not as work time. */
const MAX_TURN = 6 * 3_600_000;

export function projectStats(project: Project, days = 30): ProjectStats {
  const threads = projectThreads(project.id);
  const now = Date.now();
  let first = Infinity;
  for (const t of threads) for (const it of t.items) if (it.ts < first) first = it.ts;
  const allTime = days <= 0;
  const span = allTime ? Math.max(1, Math.min(365, Math.ceil((now - (Number.isFinite(first) ? first : now)) / DAY) + 1)) : days;
  const since = allTime ? 0 : now - days * DAY;

  // Days, oldest first.
  const byDayMap = new Map<string, ProjectStats['byDay'][number]>();
  for (let i = span - 1; i >= 0; i--) byDayMap.set(dayKey(now - i * DAY), { day: dayKey(now - i * DAY), agents: {}, tools: 0, messages: 0, cost: 0 });

  // Tokens and cost.
  const tokens = emptyTotals();
  const byAgent: Record<string, UsageTotals> = {};
  const perThread = new Map<string, { total: number; cost: number }>();
  for (const r of usageRecords(since)) {
    if (r.projectId !== project.id) continue;
    addUsage(tokens, r);
    addUsage((byAgent[r.agentId] ??= emptyTotals()), r);
    const d = byDayMap.get(dayKey(r.ts));
    if (d) {
      d.agents[r.agentId] = (d.agents[r.agentId] ?? 0) + r.total;
      d.cost += r.cost ?? 0;
    }
    const pt = perThread.get(r.threadId) ?? { total: 0, cost: 0 };
    pt.total += r.total;
    pt.cost += r.cost ?? 0;
    perThread.set(r.threadId, pt);
  }

  // Work, from the chats.
  const sessionsByAgent: Record<string, number> = {};
  let sub = 0;
  let active = 0;
  let messages = 0;
  let errors = 0;
  let permissions = 0;
  let agentTimeMs = 0;
  let toolTotal = 0;
  let toolFailed = 0;
  let last = 0;
  const kinds = new Map<string, number>();
  const files = new Map<string, number>();
  const byHour = new Array(24).fill(0);
  const toolsPerThread = new Map<string, number>();

  for (const t of threads) {
    sessionsByAgent[t.agentId] = (sessionsByAgent[t.agentId] ?? 0) + 1;
    if (t.parentId || t.spawnedBy) sub++;
    let touched = false;
    let turnStart = -1;
    let turnEnd = -1;
    const closeTurn = () => {
      if (turnStart >= 0 && turnEnd > turnStart) agentTimeMs += Math.min(MAX_TURN, turnEnd - turnStart);
      turnStart = turnEnd = -1;
    };
    for (const it of t.items) {
      if (it.ts < since) continue;
      touched = true;
      if (it.ts > last) last = it.ts;
      const d = byDayMap.get(dayKey(it.ts));
      if (it.kind === 'user') {
        closeTurn();
        turnStart = it.ts;
        messages++;
        if (d) d.messages++;
        continue;
      }
      turnEnd = Math.max(turnEnd, it.kind === 'tool' && it.endedAt ? it.endedAt : it.ts);
      if (it.kind === 'tool') {
        toolTotal++;
        toolsPerThread.set(t.id, (toolsPerThread.get(t.id) ?? 0) + 1);
        if (it.status === 'failed') toolFailed++;
        const kind = it.olympus ? 'olympus' : it.toolKind || 'other';
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
        byHour[new Date(it.ts).getHours()]++;
        if (d) d.tools++;
        for (const loc of it.locations ?? []) {
          const rel = loc.startsWith(project.path) ? relative(project.path, loc) || '.' : loc;
          files.set(rel, (files.get(rel) ?? 0) + 1);
        }
      } else if (it.kind === 'error') errors++;
      else if (it.kind === 'permission') permissions++;
    }
    closeTurn();
    if (touched) active++;
  }

  const topThreads = threads
    .map((t) => ({ threadId: t.id, title: t.title, agentId: t.agentId, total: perThread.get(t.id)?.total ?? 0, cost: perThread.get(t.id)?.cost ?? 0, tools: toolsPerThread.get(t.id) ?? 0 }))
    .filter((t) => t.total > 0 || t.tools > 0)
    .sort((a, b) => b.total - a.total || b.tools - a.tools)
    .slice(0, 8);

  // Memory: notes (not the index or bug log) and solved bugs.
  const mem = memoryDir(project);
  let memoryNotes = 0;
  let bugs = 0;
  if (existsSync(mem)) {
    const names = readdirSync(mem).filter((f) => f.endsWith('.md'));
    memoryNotes = names.filter((f) => !['MEMORY.md', 'BUGS.md', 'INSTRUCTIONS.md'].includes(f)).length;
    if (names.includes('BUGS.md')) bugs = (readFileSync(join(mem, 'BUGS.md'), 'utf8').match(/^## /gm) ?? []).length;
  }
  let instructions = false;
  try {
    instructions = readFileSync(projectInstructionsPath(project), 'utf8').trim().length > 0;
  } catch {
    /* none yet */
  }

  return {
    days: allTime ? 0 : days,
    sessions: { total: threads.length, sub, active, byAgent: sessionsByAgent },
    tokens,
    byAgent,
    byDay: [...byDayMap.values()],
    byHour,
    tools: { total: toolTotal, failed: toolFailed, byKind: [...kinds.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count) },
    messages,
    agentTimeMs,
    errors,
    permissions,
    filesTouched: files.size,
    topFiles: [...files.entries()]
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    topThreads,
    firstActivity: Number.isFinite(first) ? first : undefined,
    lastActivity: last || undefined,
    memoryNotes,
    bugs,
    instructions,
  };
}
