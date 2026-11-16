import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageRecord, UsageSummary, UsageTotals } from '@shared/types';
import { findThread, sharedRoot } from './store';

/**
 * Token / cost log. One JSON line per agent turn in <sharedRoot>/usage/YYYY-MM.jsonl, so every app and
 * agent sharing the folder can read it, and old months stay small.
 */

const dir = () => join(sharedRoot(), 'usage');
const monthFile = (ts: number) => join(dir(), `${new Date(ts).toISOString().slice(0, 7)}.jsonl`);

export function recordUsage(r: UsageRecord): void {
  mkdirSync(dir(), { recursive: true });
  appendFileSync(monthFile(r.ts), `${JSON.stringify(r)}\n`);
}

const empty = (): UsageTotals => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
function add(t: UsageTotals, r: UsageRecord) {
  t.turns += 1;
  t.input += r.input;
  t.output += r.output;
  t.cacheRead += r.cacheRead;
  t.cacheWrite += r.cacheWrite;
  t.total += r.total;
  t.cost += r.cost ?? 0;
}

const dayKey = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Usage records since a time (every month file is scanned; they are small). */
export function usageRecords(since: number): UsageRecord[] {
  const records: UsageRecord[] = [];
  if (existsSync(dir())) {
    for (const f of readdirSync(dir()).filter((x) => x.endsWith('.jsonl'))) {
      for (const line of readFileSync(join(dir(), f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as UsageRecord;
          if (r.ts >= since) records.push(r);
        } catch {
          /* skip a torn line */
        }
      }
    }
  }
  return records;
}

export const emptyTotals = (): UsageTotals => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
export const addUsage = (t: UsageTotals, r: UsageRecord) => add(t, r);
export { dayKey };

export function usageSummary(days = 30): UsageSummary {
  const since = Date.now() - days * 86_400_000;
  const records: UsageRecord[] = [];
  if (existsSync(dir())) {
    for (const f of readdirSync(dir()).filter((x) => x.endsWith('.jsonl'))) {
      for (const line of readFileSync(join(dir(), f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as UsageRecord;
          if (r.ts >= since) records.push(r);
        } catch {
          /* skip a torn line */
        }
      }
    }
  }
  const byAgent: Record<string, UsageTotals> = {};
  const byDayMap = new Map<string, { agents: Record<string, number>; cost: number }>();
  const byThread = new Map<string, { agentId: string; total: number; cost: number }>();
  const today = empty();
  const todayKey = dayKey(Date.now());
  for (let i = days - 1; i >= 0; i--) byDayMap.set(dayKey(Date.now() - i * 86_400_000), { agents: {}, cost: 0 });
  for (const r of records) {
    add((byAgent[r.agentId] ??= empty()), r);
    const d = byDayMap.get(dayKey(r.ts));
    if (d) {
      d.agents[r.agentId] = (d.agents[r.agentId] ?? 0) + r.total;
      d.cost += r.cost ?? 0;
    }
    if (dayKey(r.ts) === todayKey) add(today, r);
    const t = byThread.get(r.threadId) ?? { agentId: r.agentId, total: 0, cost: 0 };
    t.total += r.total;
    t.cost += r.cost ?? 0;
    t.agentId = r.agentId;
    byThread.set(r.threadId, t);
  }
  const topThreads = [...byThread.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 8)
    .map(([threadId, t]) => ({ threadId, title: findThread(threadId)?.title ?? '(deleted chat)', ...t }));
  return { days, byAgent, byDay: [...byDayMap.entries()].map(([day, v]) => ({ day, ...v })), topThreads, today };
}
