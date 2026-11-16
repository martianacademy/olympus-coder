import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeskEvents, ScheduledTask } from '@shared/types';
import { sendPrompt } from './agents';
import { createThread, getProject, sharedRoot, threadMeta, writeJson } from './store';

/**
 * Scheduled prompts: at the set time Olympus Coder opens a new chat in the task's project with the task's agent
 * and sends the prompt. Tasks live in <sharedRoot>/schedules.json. They run only while the app is open; a
 * run that was missed while it was closed happens once at the next start.
 */

type Emit = <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => void;

const file = () => join(sharedRoot(), 'schedules.json');

function load(): ScheduledTask[] {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as ScheduledTask[];
  } catch {
    return [];
  }
}

function save(tasks: ScheduledTask[], emit: Emit) {
  writeJson(file(), tasks);
  emit('schedules:changed', tasks);
}

function atTime(base: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(base);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

/** Next run strictly after `from`, or undefined when the task will not run again. */
export function computeNextRun(t: ScheduledTask, from = Date.now()): number | undefined {
  switch (t.kind) {
    case 'once':
      return t.at && (!t.lastRun || t.lastRun < t.at) ? t.at : undefined;
    case 'interval': {
      const step = Math.max(1, t.everyMinutes ?? 60) * 60_000;
      return (t.lastRun ?? from) + step <= from ? from + step : (t.lastRun ?? from) + step;
    }
    case 'daily': {
      let d = atTime(new Date(from), t.time ?? '09:00');
      if (d.getTime() <= from) d = new Date(d.getTime() + 86_400_000);
      return d.getTime();
    }
    case 'weekly': {
      let d = atTime(new Date(from), t.time ?? '09:00');
      const diff = ((t.weekday ?? 1) - d.getDay() + 7) % 7;
      d = new Date(d.getTime() + diff * 86_400_000);
      if (d.getTime() <= from) d = new Date(d.getTime() + 7 * 86_400_000);
      return d.getTime();
    }
  }
}

export function listSchedules(): ScheduledTask[] {
  return load();
}

export function saveSchedule(input: Partial<ScheduledTask> & Pick<ScheduledTask, 'name' | 'projectId' | 'agentId' | 'prompt' | 'kind'>, emit: Emit): ScheduledTask[] {
  const tasks = load();
  const existing = input.id ? tasks.find((t) => t.id === input.id) : undefined;
  const task: ScheduledTask = { enabled: true, createdAt: Date.now(), ...existing, ...input, id: existing?.id ?? randomUUID() } as ScheduledTask;
  if (task.kind === 'once' && task.at && task.at !== existing?.at) task.lastRun = undefined;
  task.nextRun = task.enabled ? computeNextRun(task) : undefined;
  if (task.kind === 'once' && !task.nextRun) task.enabled = false;
  save(existing ? tasks.map((t) => (t.id === task.id ? task : t)) : [...tasks, task], emit);
  return load();
}

export function deleteSchedule(id: string, emit: Emit): ScheduledTask[] {
  save(
    load().filter((t) => t.id !== id),
    emit,
  );
  return load();
}

export function runSchedule(id: string, emit: Emit): string | null {
  const tasks = load();
  const task = tasks.find((t) => t.id === id);
  if (!task || !getProject(task.projectId)) return null;
  const stamp = new Date().toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const thread = createThread(task.projectId, task.agentId, { title: `${task.name} · ${stamp}`, scheduleId: task.id });
  emit('thread:meta', threadMeta(thread));
  void sendPrompt(thread.id, task.prompt).catch(() => {});
  task.lastRun = Date.now();
  task.lastThreadId = thread.id;
  task.nextRun = task.enabled ? computeNextRun(task) : undefined;
  if (task.kind === 'once') task.enabled = false;
  save(tasks, emit);
  return thread.id;
}

export function startScheduler(emit: Emit): void {
  const tick = () => {
    const now = Date.now();
    for (const t of load()) {
      if (t.enabled && t.nextRun && t.nextRun <= now) runSchedule(t.id, emit);
    }
  };
  setTimeout(tick, 5_000);
  setInterval(tick, 30_000);
}
