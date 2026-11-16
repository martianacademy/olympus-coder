import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import * as pty from 'node-pty';
import type { DeskEvents } from '@shared/types';

type Emit = <K extends keyof DeskEvents>(channel: K, payload: DeskEvents[K]) => void;

/** Real terminals for CLI login flows (they need a TTY: browser links, device codes, prompts). */
const ptys = new Map<string, pty.IPty>();
/** Recent output per terminal, so a terminal view that is re-opened (tab switch, unlock) shows what it missed. */
const scrollback = new Map<string, string>();
const MAX_SCROLLBACK = 256 * 1024;
const written = new Map<string, number>();

/**
 * Matches the `PROMPT_SP` line interactive `zsh` prints at byte 0 when it starts: the `PROMPT_EOL_MARK` (a standout
 * `%` by default, nothing when `PROMPT_EOL_MARK=''`) padded with spaces up to the spawn width, then `\r`s and SGR /
 * erase sequences. It is written before the window has sized the PTY, so when the panel is narrower the spaces wrap
 * and leave a stray `%` (or an empty line) on row 1. Leading DEC private-mode / OSC sequences are kept (`$1`).
 * Captured from macOS zsh 5.9 at 100 columns: `ESC[1mESC[7m%ESC[27mESC[1mESC[0m` + 99 spaces + `\r \r\r…ESC[J`.
 */
// eslint-disable-next-line no-control-regex
const LEADING_ZSH_EOL_MARK =
  /^((?:\x1b\[\?[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))*)(?:(?:\x1b\[[0-9;]*m)*%(?:\x1b\[[0-9;]*m)*)? {19,}\r[ ]*\r*(?:\x1b\[[0-9;]*[mJK])*/;

/** Strips the leading `zsh` `PROMPT_SP` padding line (with or without its `%` mark) from a terminal's first output. */
export function stripLeadingZshEolMark(data: string): string {
  if (!data || !data.includes('\r')) return data;
  return data.replace(LEADING_ZSH_EOL_MARK, '$1');
}

export function startPty(
  spec: { command: string; args: string[]; env: Record<string, string>; cwd?: string; cols?: number; rows?: number },
  emit: Emit,
  onExit: (code: number) => void,
): string {
  const id = randomUUID();
  const cols = Math.max(20, spec.cols ?? 80);
  const rows = Math.max(5, spec.rows ?? 24);
  const p = pty.spawn(spec.command, spec.args, { name: 'xterm-256color', cols, rows, cwd: spec.cwd ?? homedir(), env: spec.env });
  ptys.set(id, p);
  scrollback.set(id, '');
  // Output is sent to the window in batches (every ~8 ms) instead of once per read: a program that redraws
  // the screen produces dozens of small reads per frame, and one message per frame is cheaper and smoother.
  let out = '';
  let inStartup = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (!out) return;
    emit('pty:data', { ptyId: id, data: out, end: written.get(id) ?? 0 });
    out = '';
  };
  p.onData((rawData) => {
    let data = rawData;
    if (inStartup) {
      data = stripLeadingZshEolMark(rawData);
      if (data !== rawData || rawData.includes('\n') || (written.get(id) ?? 0) + rawData.length > 1024) {
        inStartup = false;
      }
    }
    if (!data) return;
    const buf = (scrollback.get(id) ?? '') + data;
    scrollback.set(id, buf.length > MAX_SCROLLBACK ? buf.slice(buf.length - MAX_SCROLLBACK) : buf);
    written.set(id, (written.get(id) ?? 0) + data.length);
    out += data;
    if (out.length > 64 * 1024) flush();
    else if (!timer) timer = setTimeout(flush, 8);
  });
  p.onExit(({ exitCode }) => {
    if (timer) clearTimeout(timer);
    flush();
    ptys.delete(id);
    // The exit note goes through the same path as output, so live and replayed views show it exactly once.
    const note = `\r\n\x1b[2m[process exited with code ${exitCode}]\x1b[0m\r\n`;
    scrollback.set(id, (scrollback.get(id) ?? '') + note);
    const end = (written.get(id) ?? 0) + note.length;
    written.set(id, end);
    emit('pty:data', { ptyId: id, data: note, end });
    emit('pty:exit', { ptyId: id, exitCode });
    onExit(exitCode);
  });
  return id;
}

export const writePty = (id: string, data: string) => ptys.get(id)?.write(data);
export const resizePty = (id: string, cols: number, rows: number) => {
  try {
    ptys.get(id)?.resize(Math.max(20, cols), Math.max(5, rows));
  } catch {
    /* already exited */
  }
};
export const killPty = (id: string) => ptys.get(id)?.kill();
export const killAllPtys = () => {
  for (const p of ptys.values()) p.kill();
};

/** Puts back a terminal's saved output after a restart: no process, only the text, so the tab can show it. */
export function restorePty(id: string, data: string) {
  if (ptys.has(id)) return;
  const cleaned = stripLeadingZshEolMark(data);
  const buf = cleaned.length > MAX_SCROLLBACK ? cleaned.slice(cleaned.length - MAX_SCROLLBACK) : cleaned;
  scrollback.set(id, buf);
  written.set(id, buf.length);
}

/** The program in the foreground of a terminal (e.g. `node`, `python3`), or undefined when it has exited. */
export function ptyForeground(id: string): string | undefined {
  try {
    return ptys.get(id)?.process;
  } catch {
    return undefined;
  }
}

export const ptyPid = (id: string) => ptys.get(id)?.pid;

export const ptyBuffer = (id: string) => ({ data: scrollback.get(id) ?? '', end: written.get(id) ?? 0, alive: ptys.has(id) });
export const forgetPty = (id: string) => {
  ptys.get(id)?.kill();
  scrollback.delete(id);
  written.delete(id);
};
