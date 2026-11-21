import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { DeskEvents } from '@shared/types';
import {
  afterRestart,
  cleanRecord,
  findDuplicate,
  mayAutoRun,
  recordExit,
  recordStart,
  RESTART_DELAY_MS,
  type SavedCommand,
} from '@shared/savedCommands';
import { getProject } from './store';
import { closeStoppedTabsOf, interruptTerminal, linkTerminal, openTerminal, setSavedCommandHooks, terminalInfo } from './terminals';

/**
 * Saved commands (see src/shared/savedCommands.ts): a project's long-running commands, kept in
 * `userData/saved-commands.json` apart from the terminal tabs, so closing or losing a tab never loses one.
 *
 * A saved command runs in its own terminal as `shell -c <command>`: the terminal's exit is the command's exit,
 * with its exit code, on macOS, Linux and Windows alike. That exit drives the status, keep-running restarts and
 * the crash-loop guard. A tab saved while it was already running its command in an interactive shell is linked
 * as is; its status is read from the shell's foreground process instead (best effort, and never restarted).
 */

type Emit = <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => void;
let emit: Emit = () => {};

let list: SavedCommand[] = [];
/** Terminals the user stopped (closed the tab, pressed Stop): their exit is never a failure nor restarted. */
const userStopped = new Set<string>();
/** Projects whose "stopped when Olympus closed" strip was dismissed, and guard notices dismissed, this app session. */
const noticeDismissed = new Set<string>();
const guardDismissed = new Set<string>();
const restartTimers = new Map<string, ReturnType<typeof setTimeout>>();
let quitting = false;

const file = () => join(app.getPath('userData'), 'saved-commands.json');

function save() {
  try {
    const tmp = `${file()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, commands: list.map((c) => cleanRecord(c)).filter(Boolean) }, null, 1));
    renameSync(tmp, file());
  } catch {
    /* best effort */
  }
}

function changed(projectId: string) {
  save();
  emit('savedcmd:changed', { projectId });
}

const byId = (id: string) => list.find((c) => c.id === id);
function put(next: SavedCommand) {
  list = list.map((c) => (c.id === next.id ? next : c));
  changed(next.projectId);
}

/**
 * A linked interactive-shell tab says "running" only while its shell runs a program; exec terminals report
 * their own exit. Reconciled whenever the list is read and before quitting.
 */
function reconcile() {
  for (const c of list) {
    if (c.lastStatus !== 'running' || !c.ptyId) continue;
    const t = terminalInfo(c.ptyId);
    if (!t || !t.alive || (!t.exec && !t.busy)) {
      const { ptyId: _gone, ...rest } = c;
      list = list.map((x) => (x.id === c.id ? { ...rest, lastStatus: 'stopped' } : x));
      save();
    }
  }
}

export function listSaved(projectId?: string): SavedCommand[] {
  reconcile();
  return list.filter((c) => !projectId || c.projectId === projectId);
}

/** The folder a saved command runs in: its own (relative paths are under the project), or the project folder. */
function folderFor(c: Pick<SavedCommand, 'projectId' | 'cwd'>): string {
  const p = getProject(c.projectId);
  if (!p) throw new Error('That project is not available.');
  if (!c.cwd) return p.path;
  const dir = isAbsolute(c.cwd) ? c.cwd : resolve(p.path, c.cwd);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Folder not found: ${dir}`);
  return dir;
}

/** A folder that is just the project folder is stored as unset (so it follows the project when that moves). */
function sameAsProject(c: Pick<SavedCommand, 'projectId' | 'cwd'>): boolean {
  const p = getProject(c.projectId);
  return Boolean(p && c.cwd && resolve(p.path, c.cwd) === resolve(p.path));
}

export interface SaveInput {
  projectId: string;
  command: string;
  title?: string;
  cwd?: string;
  createdBy?: 'user' | 'agent';
  threadId?: string;
}

/** Saves a command for a project, or returns the one already saved with the same command line. */
export function saveCommand(input: SaveInput): SavedCommand {
  const command = String(input.command ?? '').trim();
  if (!command) throw new Error('The command is empty.');
  if (!getProject(input.projectId)) throw new Error('Project not found.');
  const dup = findDuplicate(list, input.projectId, command);
  if (dup) return dup;
  const rec = cleanRecord({
    id: randomUUID(),
    projectId: input.projectId,
    title: input.title?.trim() || undefined,
    command,
    cwd: input.cwd?.trim() || undefined,
    createdAt: Date.now(),
    createdBy: input.createdBy ?? 'user',
    threadId: input.threadId,
    autoStart: false,
    keepRunning: false,
    lastStatus: 'never-run',
    failures: [],
  })!;
  if (rec.cwd) folderFor(rec);
  if (sameAsProject(rec)) delete rec.cwd;
  list = [...list, rec];
  changed(rec.projectId);
  return rec;
}

/** Saves the command of an open tab; a tab running it right now is linked, so its status shows as running. */
export function saveFromTerminal(ptyId: string): SavedCommand {
  const t = terminalInfo(ptyId);
  if (!t?.command) throw new Error('This terminal has no command to save.');
  if (t.savedId && byId(t.savedId)) return byId(t.savedId)!;
  const rec = saveCommand({ projectId: t.projectId, command: t.command, title: t.title, cwd: t.cwd, createdBy: 'user' });
  if (t.busy && !(rec.ptyId && terminalInfo(rec.ptyId)?.alive)) {
    linkTerminal(ptyId, rec.id);
    put(recordStart(rec, ptyId, Date.now(), false));
  }
  return byId(rec.id)!;
}

export function updateSaved(id: string, patch: Partial<Pick<SavedCommand, 'title' | 'command' | 'cwd' | 'autoStart' | 'keepRunning'>>): SavedCommand {
  const c = byId(id);
  if (!c) throw new Error('That saved command is gone.');
  const next = cleanRecord({
    ...c,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.command !== undefined ? { command: patch.command } : {}),
    ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
    ...(patch.autoStart !== undefined ? { autoStart: Boolean(patch.autoStart) } : {}),
    ...(patch.keepRunning !== undefined ? { keepRunning: Boolean(patch.keepRunning) } : {}),
  });
  if (!next) throw new Error('The command is empty.');
  if (next.command !== c.command && list.some((x) => x.id !== id && findDuplicate([x], next.projectId, next.command))) throw new Error('That command is already saved.');
  if (next.cwd) folderFor(next);
  if (sameAsProject(next)) delete next.cwd;
  put(next);
  return next;
}

/** Forgets a saved command. A terminal running it keeps running, as an ordinary tab. */
export function deleteSaved(id: string) {
  const c = byId(id);
  if (!c) return;
  clearTimeout(restartTimers.get(id));
  restartTimers.delete(id);
  list = list.filter((x) => x.id !== id);
  changed(c.projectId);
}

/**
 * Starts a saved command in a fresh terminal tab in its folder. One that is already running is not started twice:
 * its terminal is returned. `manual` (the user's Run, or an agent asked to) clears a tripped guard.
 */
export function runSaved(id: string, opts: { manual: boolean; threadId?: string } = { manual: true }): { ptyId: string; title: string; alreadyRunning?: boolean } {
  const c = byId(id);
  if (!c) throw new Error('That saved command is gone.');
  clearTimeout(restartTimers.get(id));
  restartTimers.delete(id);
  if (c.ptyId) {
    const t = terminalInfo(c.ptyId);
    if (t?.alive && (t.exec || t.busy)) return { ptyId: c.ptyId, title: t.title, alreadyRunning: true };
  }
  const cwd = folderFor(c);
  closeStoppedTabsOf(c.id); // keep-running restarts and Run again never pile up tabs
  let ptyId = '';
  const r = openTerminal(c.projectId, c.command, c.title, opts.threadId, { cwd, savedId: c.id, exec: true, onExit: (code, signal) => onExit(c.id, ptyId, signal ? 128 + signal : code) });
  ptyId = r.ptyId;
  guardDismissed.delete(c.id);
  put(recordStart(byId(id) ?? c, r.ptyId, Date.now(), opts.manual));
  return r;
}

function onExit(id: string, ptyId: string, code: number) {
  if (quitting) return; // the app is closing: the status stays "running" and becomes stopped-by-restart next launch
  const c = byId(id);
  const stopped = userStopped.delete(ptyId);
  if (!c) return;
  const out = recordExit(c, ptyId, code, Date.now(), stopped);
  if (out.next === c) return;
  put(out.next);
  if (out.restart) {
    restartTimers.set(
      id,
      setTimeout(() => {
        restartTimers.delete(id);
        const now = byId(id);
        if (!now || quitting || !now.keepRunning || now.lastStatus === 'running' || !mayAutoRun(now, Date.now()) || !getProject(now.projectId)) return;
        try {
          runSaved(id, { manual: false });
        } catch (e) {
          console.error('[saved commands] restart failed:', e);
        }
      }, RESTART_DELAY_MS),
    );
  }
}

/** The Stop button on a saved command: Ctrl+C, and it is not restarted. */
export function stopSaved(id: string) {
  const c = byId(id);
  if (!c?.ptyId) return;
  userStopped.add(c.ptyId);
  clearTimeout(restartTimers.get(id));
  interruptTerminal(c.ptyId);
}

/** A project's commands that were running when Olympus last closed, unless the strip was dismissed. */
export function restartNotice(projectId: string): { stoppedByRestart: string[]; guardTripped: string[] } {
  const own = listSaved(projectId);
  return {
    stoppedByRestart: noticeDismissed.has(projectId) ? [] : own.filter((c) => c.lastStatus === 'stopped-by-restart').map((c) => c.id),
    guardTripped: own.filter((c) => c.lastStatus === 'guard-tripped' && !guardDismissed.has(c.id)).map((c) => c.id),
  };
}

export function dismissNotice(projectId: string, kind: 'restart' | 'guard', id?: string) {
  if (kind === 'restart') noticeDismissed.add(projectId);
  else if (id) guardDismissed.add(id);
  emit('savedcmd:changed', { projectId });
}

/** Restart all: every command of the project that stopped when Olympus closed. */
export function restartAll(projectId: string): { started: number; errors: string[] } {
  let started = 0;
  const errors: string[] = [];
  for (const c of listSaved(projectId).filter((x) => x.lastStatus === 'stopped-by-restart')) {
    try {
      runSaved(c.id, { manual: true });
      started++;
    } catch (e: any) {
      errors.push(`${c.title}: ${e?.message ?? e}`);
    }
  }
  return { started, errors };
}

/** Called just before the app kills its terminals: their exits are the quit, not the commands stopping. */
export function savedCommandsQuitting() {
  reconcile();
  quitting = true;
  for (const t of restartTimers.values()) clearTimeout(t);
  restartTimers.clear();
  save();
}

/** At startup (after restoreTerminals): load, mark what was running as stopped-by-restart, run auto-start ones. */
export function initSavedCommands(fn: Emit) {
  emit = fn;
  try {
    if (existsSync(file())) {
      const raw = JSON.parse(readFileSync(file(), 'utf8')) as { commands?: unknown[] };
      list = afterRestart((raw.commands ?? []).map(cleanRecord).filter((c): c is SavedCommand => Boolean(c)));
    }
  } catch {
    list = []; // a damaged file just means no saved commands
  }
  save();
  setSavedCommandHooks({
    closed: (_savedId, ptyId) => userStopped.add(ptyId),
    rerun: (savedId) => (byId(savedId) ? runSaved(savedId, { manual: true }) : undefined),
  });
  const now = Date.now();
  for (const c of list) {
    if (!c.autoStart || !getProject(c.projectId) || !mayAutoRun(c, now)) continue;
    try {
      runSaved(c.id, { manual: false });
    } catch (e) {
      console.error('[saved commands] auto-start failed:', c.title, e);
    }
  }
}

/** The window's (and the phone page's) IPC methods, spread into `handlers` in src/main/index.ts. */
export const savedCommandHandlers = {
  'saved.list': (projectId: string) => listSaved(projectId),
  'saved.save': (input: SaveInput) => saveCommand({ ...input, createdBy: 'user', threadId: undefined }),
  'saved.saveFromTerminal': (ptyId: string) => saveFromTerminal(ptyId),
  'saved.update': (id: string, patch: Parameters<typeof updateSaved>[1]) => updateSaved(id, patch),
  'saved.delete': (id: string) => deleteSaved(id),
  'saved.run': (id: string) => runSaved(id, { manual: true }),
  'saved.stop': (id: string) => stopSaved(id),
  'saved.notice': (projectId: string) => restartNotice(projectId),
  'saved.dismiss': (projectId: string, kind: 'restart' | 'guard', id?: string) => dismissNotice(projectId, kind, id),
  'saved.restartAll': (projectId: string) => restartAll(projectId),
};
