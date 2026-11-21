/**
 * Saved commands: long-running commands (watchers, servers) a project keeps across Olympus restarts, so they can
 * be started again with one click, at launch (auto-start), after they stop (keep running), or by an agent.
 *
 * This file is the pure part (no Electron, no disk): the record shape, cleaning what is stored, the status a
 * record gets after a restart, and the crash-loop guard. `src/main/savedCommands.ts` does the disk and terminals.
 */

export type SavedCommandStatus = 'never-run' | 'running' | 'stopped' | 'stopped-by-restart' | 'guard-tripped';

export interface SavedCommand {
  id: string;
  projectId: string;
  title: string;
  /** The exact command line, as typed. */
  command: string;
  /** Folder it runs in; unset means the project folder (so it follows the project when that moves). */
  cwd?: string;
  createdAt: number;
  createdBy: 'user' | 'agent';
  /** The chat whose agent saved it. */
  threadId?: string;
  /** Start it when Olympus starts. */
  autoStart: boolean;
  /** Start it again after it stops (unless the user stopped it). */
  keepRunning: boolean;
  lastStatus: SavedCommandStatus;
  /** Exit code of the last run, when it stopped by itself. */
  lastExitCode?: number;
  lastRunAt?: number;
  /** The terminal running it right now. */
  ptyId?: string;
  /** Times of recent failed starts (pruned to the guard window). */
  failures: number[];
}

/** A start "failed" when the command stopped within this long, or exited non-zero. */
export const QUICK_EXIT_MS = 60_000;
/** The guard trips at this many failed starts within GUARD_WINDOW_MS. */
export const GUARD_FAILURES = 3;
export const GUARD_WINDOW_MS = 10 * 60_000;
/** Wait before a keep-running restart, so a failing command never spins. */
export const RESTART_DELAY_MS = 2_000;

const STATUSES = new Set<SavedCommandStatus>(['never-run', 'running', 'stopped', 'stopped-by-restart', 'guard-tripped']);

/**
 * Only the known fields, with sane types. Anything else (an `env` map, tokens, whatever a caller passed) is
 * dropped, so the file never holds environment variables or secrets.
 */
export function cleanRecord(raw: unknown): SavedCommand | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const id = str(r.id);
  const projectId = str(r.projectId);
  const command = typeof r.command === 'string' ? r.command.trim() : '';
  if (!id || !projectId || !command) return null;
  const status = STATUSES.has(r.lastStatus as SavedCommandStatus) ? (r.lastStatus as SavedCommandStatus) : 'never-run';
  const out: SavedCommand = {
    id,
    projectId,
    title: str(r.title) ?? command.split('\n')[0].slice(0, 60),
    command,
    createdAt: num(r.createdAt) ?? Date.now(),
    createdBy: r.createdBy === 'agent' ? 'agent' : 'user',
    autoStart: r.autoStart === true,
    keepRunning: r.keepRunning === true,
    lastStatus: status,
    failures: Array.isArray(r.failures) ? r.failures.filter((t): t is number => typeof t === 'number' && Number.isFinite(t)).slice(-10) : [],
  };
  const cwd = str(r.cwd);
  if (cwd) out.cwd = cwd;
  const threadId = str(r.threadId);
  if (threadId) out.threadId = threadId;
  const code = num(r.lastExitCode);
  if (code !== undefined) out.lastExitCode = code;
  const ran = num(r.lastRunAt);
  if (ran !== undefined) out.lastRunAt = ran;
  const ptyId = str(r.ptyId);
  if (ptyId) out.ptyId = ptyId;
  return out;
}

/** The same command line, ignoring surrounding and repeated whitespace. */
const sameCommand = (a: string, b: string) => a.trim().replace(/\s+/g, ' ') === b.trim().replace(/\s+/g, ' ');

/** An existing record for this project with the same command (saving it again returns that one). */
export function findDuplicate(list: SavedCommand[], projectId: string, command: string): SavedCommand | undefined {
  return list.find((c) => c.projectId === projectId && sameCommand(c.command, command));
}

/**
 * At startup: no process from the last run is alive any more. A command that was running when Olympus closed
 * (or crashed) is now "stopped-by-restart"; its terminal id is gone.
 */
export function afterRestart(list: SavedCommand[]): SavedCommand[] {
  return list.map((c) => {
    const { ptyId: _gone, ...rest } = c;
    return c.lastStatus === 'running' ? { ...rest, lastStatus: 'stopped-by-restart' } : rest;
  });
}

/** Failure times still inside the guard window. */
export const recentFailures = (failures: number[], now: number) => failures.filter((t) => now - t < GUARD_WINDOW_MS);

/** Whether these failures trip the crash-loop guard. */
export const guardTrips = (failures: number[], now: number) => recentFailures(failures, now).length >= GUARD_FAILURES;

/** A run started in terminal `ptyId`. `manual` (the user's Run) clears a tripped guard and its failures. */
export function recordStart(c: SavedCommand, ptyId: string, now: number, manual: boolean): SavedCommand {
  const { lastExitCode: _old, ...rest } = c;
  return { ...rest, ptyId, lastStatus: 'running', lastRunAt: now, failures: manual ? [] : recentFailures(c.failures, now) };
}

/**
 * Exit codes that mean the user interrupted it (Ctrl+C / the Stop button): 130 = 128 + SIGINT on macOS and
 * Linux shells; 0xC000013A (STATUS_CONTROL_C_EXIT) on Windows, seen as unsigned or signed.
 */
export const isInterrupt = (code: number) => code === 130 || code === 3221225786 || code === -1073741510;

export interface ExitOutcome {
  next: SavedCommand;
  /** This run counts as a failed start. */
  failed: boolean;
  /** Start it again (keep running), after RESTART_DELAY_MS. */
  restart: boolean;
}

/**
 * The run in terminal `ptyId` ended with `code` (the shell's exit code, which is the command's: saved commands
 * run as `shell -c`; a process killed by a signal counts as 128 + signal, as shells report it). `userStopped`: the user closed its tab or pressed Stop, so it is never restarted.
 */
export function recordExit(c: SavedCommand, ptyId: string, code: number, now: number, userStopped: boolean): ExitOutcome {
  if (c.ptyId !== ptyId) return { next: c, failed: false, restart: false }; // an older run's tab
  const { ptyId: _gone, ...rest } = c;
  const stoppedByUser = userStopped || isInterrupt(code);
  const failed = !stoppedByUser && (code !== 0 || (c.lastRunAt !== undefined && now - c.lastRunAt < QUICK_EXIT_MS));
  const failures = failed ? [...recentFailures(c.failures, now), now] : recentFailures(c.failures, now);
  const base: SavedCommand = { ...rest, lastExitCode: code, failures };
  if (failed && guardTrips(failures, now) && (c.keepRunning || c.autoStart)) return { next: { ...base, lastStatus: 'guard-tripped' }, failed, restart: false };
  return { next: { ...base, lastStatus: 'stopped' }, failed, restart: !stoppedByUser && c.keepRunning };
}

/** Whether Olympus may start it by itself (at launch or after a stop): never once the guard has tripped. */
export const mayAutoRun = (c: SavedCommand, now: number) => c.lastStatus !== 'guard-tripped' && !guardTrips(c.failures, now);

/** One short, plain line for a status (list rows, agent tool output). */
export function statusText(c: SavedCommand): string {
  switch (c.lastStatus) {
    case 'running':
      return 'running';
    case 'stopped':
      return c.lastExitCode !== undefined ? `stopped (exit code ${c.lastExitCode})` : 'stopped';
    case 'stopped-by-restart':
      return 'stopped when Olympus closed';
    case 'guard-tripped':
      return `not restarted: failed ${GUARD_FAILURES} times within ${GUARD_WINDOW_MS / 60_000} minutes`;
    default:
      return 'never run';
  }
}

/**
 * How a saved command is started inside the user's shell: as `shell -c <command>`, so the terminal's process
 * IS the command and its exit (with the command's exit code) is the terminal's exit. This works the same on
 * macOS, Linux and Windows; watching an interactive shell's foreground process does not (node-pty reports
 * only the shell's own name on Windows). `-l -i` keeps the login + interactive startup files (PATH from
 * .zprofile / .zshrc / nvm …) that the typed-in terminals get.
 */
export function execArgs(shell: string, command: string): string[] {
  const name = shell.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
  if (name === 'pwsh' || name === 'powershell') return ['-NoLogo', '-Command', command];
  if (name === 'cmd') return ['/d', '/s', '/c', command];
  return ['-l', '-i', '-c', command];
}
