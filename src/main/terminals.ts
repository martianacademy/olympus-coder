import { app } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DeskEvents, TerminalView } from '@shared/types';
import { agentEnv, userShell } from './env';
import { forgetPty, ptyBuffer, ptyForeground, restorePty, startPty, writePty } from './pty';
import { getProject } from './store';

/**
 * The workbench's terminals: plain shells (the + button), and terminals opened with a command already typed in
 * (the Run button on a shell code block, or an agent's `run_in_terminal` tool). Each runs in the user's login
 * shell in the project folder and stays open after the command ends.
 *
 * The list and each terminal's recent output are saved to disk, so after Olympus restarts the tabs come back
 * with their output (marked stopped, with "Run again"). The processes themselves end with the app.
 */

type Emit = <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => void;
let emit: Emit = () => {};
export const setTerminalEmitter = (fn: Emit) => {
  emit = fn;
};

interface Opened {
  projectId: string;
  title: string;
  command?: string;
  startedAt: number;
  exitCode?: number;
  /** Came back from disk after a restart: output only, no process. */
  restored?: boolean;
  /** The chat whose agent opened it (run_in_terminal), so its work counts as that chat's. */
  threadId?: string;
}
const opened = new Map<string, Opened>();
let counter = 0;

/** A tab-sized name for a command: its first line, with paths cut to their last part (`bash /a/b/run.sh` → `bash run.sh`). */
export function shortTitle(text: string): string {
  const line = text.split('\n').find((l) => l.trim())?.trim() ?? text.trim();
  const short = line
    .replace(/^(cd\s+\S+\s*(&&|;)\s*)+/, '') // a leading `cd somewhere &&` says little
    .replace(/"([^"]*\/[^"]*)"|'([^']*\/[^']*)'|((?:~|\.{0,2})?\/[^\s"']+)/g, (m, a?: string, b?: string, c?: string) => {
      const path = (a ?? b ?? c ?? m).replace(/\/+$/, '');
      return path.split('/').pop() || path;
    })
    .replace(/\s+/g, ' ');
  return short.length > 32 ? `${short.slice(0, 31)}…` : short || 'Terminal';
}

const changed = (projectId: string) => {
  saveSoon();
  emit('terminal:changed', { projectId });
};

export function openTerminal(projectId: string, command?: string, title?: string, threadId?: string): { ptyId: string; title: string } {
  const p = getProject(projectId);
  if (!p) throw new Error('Project not found.');
  const cmd = command?.trim() || undefined;
  const name = shortTitle(title?.trim() || cmd || `Terminal ${++counter}`);
  let typed = !cmd;
  const typeCommand = () => {
    if (typed) return;
    typed = true;
    writePty(ptyId, `${cmd}\r`);
  };
  // Output marks the saved copy as stale; it is written to disk every few seconds.
  const tap: Emit = (channel, payload) => {
    if (channel === 'pty:data') dirty = true;
    emit(channel, payload);
  };
  const ptyId = startPty({ ...userShell(), env: agentEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', PROMPT_EOL_MARK: '' }), cwd: p.path }, tap, (code) => {
    const o = opened.get(ptyId);
    if (o) o.exitCode = code;
    changed(projectId);
  });
  opened.set(ptyId, { projectId, title: name, command: cmd, startedAt: Date.now(), ...(threadId ? { threadId } : {}) });
  if (threadId) closeOldAgentTerminals(projectId, threadId);
  emit('terminal:opened', { projectId, ptyId, title: name, command: cmd });
  changed(projectId);
  // Type the command once the shell has drawn its first prompt (or after a moment, for a quiet shell).
  if (cmd) {
    const started = Date.now();
    const poll = setInterval(() => {
      if (ptyBuffer(ptyId).end > 0 && Date.now() - started > 250) {
        clearInterval(poll);
        setTimeout(typeCommand, 150);
      } else if (Date.now() - started > 3000) {
        clearInterval(poll);
        typeCommand();
      }
    }, 100);
  }
  return { ptyId, title: name };
}

/** Agent-opened terminals kept per chat: an agent that runs one probe after another does not pile up tabs. */
const KEEP_PER_CHAT = 3;

/** Closes a chat's oldest agent-opened terminals beyond KEEP_PER_CHAT, skipping any still running a command. */
function closeOldAgentTerminals(projectId: string, threadId: string) {
  const own = [...opened].filter(([, o]) => o.projectId === projectId && o.threadId === threadId);
  let extra = own.length - KEEP_PER_CHAT;
  for (const [id, o] of own) {
    if (extra <= 0) break;
    if (!o.restored && ptyBuffer(id).alive && busy(id)) continue;
    forgetPty(id);
    opened.delete(id);
    extra--;
  }
}

/** Whether the shell is running a program of its own right now (not just sitting at its prompt). */
function busy(ptyId: string): boolean {
  const fg = ptyForeground(ptyId);
  if (!fg) return false;
  const shell = basename(userShell().command).replace(/\.exe$/i, '');
  return basename(fg).replace(/\.exe$/i, '').replace(/^-/, '') !== shell;
}

function view(ptyId: string, o: Opened): TerminalView {
  const alive = !o.restored && ptyBuffer(ptyId).alive;
  return { ptyId, projectId: o.projectId, title: o.title, command: o.command, alive, busy: alive && busy(ptyId), exitCode: o.exitCode, restored: o.restored, startedAt: o.startedAt, threadId: o.threadId };
}

/** A project's terminals in the order they were opened. */
export function listTerminals(projectId: string): TerminalView[] {
  return [...opened].filter(([, o]) => o.projectId === projectId).map(([id, o]) => view(id, o));
}

export function closeTerminal(ptyId: string) {
  const o = opened.get(ptyId);
  forgetPty(ptyId);
  opened.delete(ptyId);
  if (o) changed(o.projectId);
}

/** A stopped terminal again: its command in a new terminal (or a fresh shell), in place of the old tab. */
export function rerunTerminal(ptyId: string): { ptyId: string; title: string } {
  const o = opened.get(ptyId);
  if (!o) throw new Error('That terminal is gone.');
  closeTerminal(ptyId);
  return openTerminal(o.projectId, o.command, o.command ? o.title : undefined, o.threadId);
}

/** Terminals whose shell is running (any project). */
export function terminalsAlive(): { ptyId: string; projectId: string; title: string; threadId?: string; command?: string; startedAt: number }[] {
  return [...opened]
    .filter(([id, o]) => !o.restored && ptyBuffer(id).alive)
    .map(([ptyId, o]) => ({ ptyId, projectId: o.projectId, title: o.title, threadId: o.threadId, command: o.command, startedAt: o.startedAt }));
}

/** Terminals still running a program, for the quit warning. */
export function busyTerminals(): TerminalView[] {
  return [...opened].map(([id, o]) => view(id, o)).filter((t) => t.busy);
}

// ---- saved across restarts ----

const MAX_SAVED = 96 * 1024;
const file = () => join(app.getPath('userData'), 'terminals.json');
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveSoon() {
  dirty = true;
  if (!saveTimer) saveTimer = setTimeout(flushTerminals, 1500);
}
setInterval(() => dirty && flushTerminals(), 5000).unref?.();

interface Saved extends Opened {
  ptyId: string;
  data: string;
  /** Still running when it was saved: shown as "stopped when Olympus closed" after a restart. */
  wasAlive: boolean;
}

export function flushTerminals() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  dirty = false;
  const list: Saved[] = [...opened].map(([ptyId, o]) => {
    const b = ptyBuffer(ptyId);
    return { ...o, ptyId, data: b.data.length > MAX_SAVED ? b.data.slice(b.data.length - MAX_SAVED) : b.data, wasAlive: !o.restored && b.alive };
  });
  try {
    const tmp = `${file()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, terminals: list }));
    renameSync(tmp, file());
  } catch {
    /* best effort */
  }
}

const STOPPED_NOTE = '\r\n\x1b[0m\x1b[2m── stopped when Olympus closed · Run again to restart ──\x1b[0m\r\n';

/** At startup: the terminals that were open when Olympus last closed, with their output. */
export function restoreTerminals() {
  if (!existsSync(file())) return;
  try {
    const saved = JSON.parse(readFileSync(file(), 'utf8')) as { terminals?: Saved[] };
    for (const t of saved.terminals ?? []) {
      if (!t.ptyId || !getProject(t.projectId)) continue;
      restorePty(t.ptyId, t.data + (t.wasAlive ? STOPPED_NOTE : ''));
      opened.set(t.ptyId, { projectId: t.projectId, title: t.title, command: t.command, startedAt: t.startedAt, exitCode: t.exitCode, restored: true, threadId: t.threadId });
      const n = /^Terminal (\d+)$/.exec(t.title);
      if (n) counter = Math.max(counter, Number(n[1]));
    }
  } catch {
    /* a damaged file just means no restored tabs */
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g;

/** The last `lines` lines a terminal printed, as plain text, plus whether it is still running. */
export function readTerminal(ptyId: string, lines = 60): string {
  const o = opened.get(ptyId);
  if (!o) throw new Error(`No terminal with id ${ptyId} was opened by run_in_terminal.`);
  const b = ptyBuffer(ptyId);
  const text = b.data.replace(ANSI, '');
  const tail = text.split('\n').slice(-Math.max(1, Math.min(400, lines))).join('\n').trimEnd();
  const state = o.restored ? 'stopped when Olympus was closed' : b.alive ? 'shell still open' : `shell exited${o.exitCode !== undefined ? ` (code ${o.exitCode})` : ''}`;
  return `Terminal "${o.title}" (${ptyId}) — ${state}, started ${Math.round((Date.now() - o.startedAt) / 1000)}s ago.\n--- last ${lines} lines ---\n${tail || '(no output yet)'}`;
}

export const terminalProject = (ptyId: string) => opened.get(ptyId)?.projectId;
