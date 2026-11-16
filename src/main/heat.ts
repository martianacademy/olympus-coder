import { powerMonitor } from 'electron';
import type { DeskEvents, RunningTask } from '@shared/types';
import { runningTasks } from './processes';

/**
 * Heat alerts: tells the user when a program the app started keeps several cores busy for about a minute, or
 * when macOS reports the machine is getting hot (thermal state "serious" / "critical"), naming the heaviest
 * program so it can be paused or stopped right from the alert. Per-program GPU use can't be read without
 * admin rights, so CPU stands in for it.
 */

type Emit = <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => void;

const HOT_CPU = 300; // percent of one core: three cores
const SAMPLES = 6; // × 10 s ≈ a minute
const COOLDOWN = 10 * 60_000;

export function startHeatWatch(emit: Emit) {
  const streak = new Map<string, number>();
  const told = new Map<string, number>();
  let thermal = 'nominal';

  const heaviest = (tasks: RunningTask[]) => [...tasks].sort((a, b) => b.cpu - a.cpu)[0];

  const tick = async () => {
    const tasks = (await runningTasks().catch(() => [])).filter((t) => !t.paused && Number.isFinite(t.cpu));
    const live = new Set(tasks.map((t) => t.id));
    for (const id of streak.keys()) if (!live.has(id)) streak.delete(id);
    for (const t of tasks) {
      const n = t.cpu >= HOT_CPU ? (streak.get(t.id) ?? 0) + 1 : 0;
      streak.set(t.id, n);
      if (n >= SAMPLES && Date.now() - (told.get(t.id) ?? 0) > COOLDOWN) {
        told.set(t.id, Date.now());
        emit('heat:alert', { reason: 'cpu', task: t, thermal });
      }
    }
  };
  setInterval(() => void tick(), 10_000).unref?.();

  if (process.platform === 'darwin') {
    try {
      thermal = powerMonitor.getCurrentThermalState?.() ?? 'nominal';
    } catch {
      /* not available */
    }
    powerMonitor.on('thermal-state-change', (e: any) => {
      const state = String(e?.state ?? e ?? 'unknown');
      const worse = ['serious', 'critical'].includes(state) && !['serious', 'critical'].includes(thermal);
      thermal = state;
      if (!worse) return;
      void runningTasks()
        .catch(() => [])
        .then((tasks) => emit('heat:alert', { reason: 'thermal', thermal: state, task: heaviest(tasks.filter((t) => !t.paused)) }));
    });
  }
}
