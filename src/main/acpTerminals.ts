import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename, delimiter, extname, isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { RequestError } from '@agentclientprotocol/sdk/unstable';
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk/unstable';
import { acpTerminalKey, type AcpClientEvents, type AcpExitStatus, type AcpTerminalMeta, type AcpTerminalSnapshot } from '@shared/acpClient';

/**
 * Terminals in agent chats, two kinds:
 *
 * - **Client terminals** (`terminal/create` … `terminal/release`): Olympus runs the command for the agent,
 *   streams it live into the tool's RESULT box, and answers `terminal/output` with the last
 *   `outputByteLimit` bytes. The agent asked the user (`session/request_permission`) before; nothing here
 *   asks again, but a context can refuse (`mayRun`, e.g. no turn running).
 * - **Agent terminals**: Codex and Claude Code run commands themselves and stream them in tool-call
 *   `_meta` (`terminal_info`, `terminal_output` / `terminal_output_delta`, `terminal_exit`);
 *   {@link applyTerminalMeta} collects that so the same box can show it live.
 *
 * Both live in an {@link AcpTerminalStore}, which keeps what the window shows and sends it updates.
 */

/** What the window keeps per terminal (the end of the output). */
export const DISPLAY_CAP = 512 * 1024;
/** Most output retained for the agent when it gives no (or a larger) `outputByteLimit`. */
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Running client terminals one session may have at once. */
export const MAX_LIVE_PER_SESSION = 32;
/** Finished terminals the store remembers (oldest are forgotten first). */
const MAX_REMEMBERED = 300;
/** After `exit`, how long to wait for the output pipes to close (a background child may hold them open). */
const CLOSE_GRACE_MS = 1500;
/** After asking a command to stop, how long before it is killed outright. */
const KILL_GRACE_MS = 3000;
const APPEND_BATCH_MS = 40;

type Emit = <K extends keyof AcpClientEvents>(channel: K, payload: AcpClientEvents[K]) => void;

// ------------------------------------------------------------------ output retained for the agent

/**
 * Output kept within a byte limit by dropping from the start, cut at a character boundary (so the kept text
 * may be a little under the limit). Trimming is lazy: text can grow to ~2× the limit before it is cut.
 */
export class OutputBuffer {
  private text = '';
  private bytes = 0;
  private limit: number;
  truncated = false;

  constructor(limit: number) {
    this.limit = limit;
  }

  append(s: string): void {
    if (!s) return;
    this.text += s;
    this.bytes += Buffer.byteLength(s, 'utf8');
    if (this.bytes > this.limit * 2 + 64 * 1024) this.trim();
  }

  private trim(): void {
    if (this.bytes <= this.limit) return;
    const buf = Buffer.from(this.text, 'utf8');
    let start = buf.length - this.limit;
    // Never start inside a UTF-8 sequence: skip continuation bytes (10xxxxxx).
    while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
    this.text = buf.subarray(start).toString('utf8');
    this.bytes = buf.length - start;
    this.truncated = true;
  }

  read(): { output: string; truncated: boolean } {
    this.trim();
    return { output: this.text, truncated: this.truncated };
  }
}

// ------------------------------------------------------------------ store (what the window shows)

interface StoreEntry {
  meta: AcpTerminalMeta;
  output: string;
  pending: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export class AcpTerminalStore {
  private entries = new Map<string, StoreEntry>();
  private emit: Emit = () => {};
  private listeners = new Set<(meta: AcpTerminalMeta) => void>();

  setEmitter(fn: Emit): void {
    this.emit = fn;
  }

  /** Called whenever a terminal's state (not its output) changes: started, exited, released. */
  onChange(fn: (meta: AcpTerminalMeta) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Starts showing a terminal (or updates what is known about one already shown). */
  open(owner: string, terminalId: string, info: { source: AcpTerminalMeta['source']; command?: string; cwd?: string; running?: boolean }): AcpTerminalMeta {
    const key = acpTerminalKey(owner, terminalId);
    const e = this.entries.get(key);
    if (e) {
      if (info.command && !e.meta.command) e.meta.command = info.command;
      if (info.cwd && !e.meta.cwd) e.meta.cwd = info.cwd;
      this.changed(e);
      return e.meta;
    }
    const meta: AcpTerminalMeta = {
      key,
      owner,
      terminalId,
      source: info.source,
      command: info.command,
      cwd: info.cwd,
      running: info.running ?? true,
      released: false,
      clipped: false,
      end: 0,
      startedAt: Date.now(),
    };
    const entry: StoreEntry = { meta, output: '', pending: '', timer: null };
    this.entries.set(key, entry);
    this.prune();
    this.changed(entry);
    return meta;
  }

  append(key: string, data: string): void {
    const e = this.entries.get(key);
    if (!e || !data) return;
    e.output += data;
    e.meta.end += data.length;
    if (e.output.length > DISPLAY_CAP * 1.25) {
      let cut = e.output.length - DISPLAY_CAP;
      // Keep surrogate pairs whole.
      const c = e.output.charCodeAt(cut);
      if (c >= 0xdc00 && c <= 0xdfff) cut++;
      e.output = e.output.slice(cut);
      e.meta.clipped = true;
    }
    e.pending += data;
    if (e.pending.length > 64 * 1024) this.flush(e);
    else if (!e.timer) e.timer = setTimeout(() => this.flush(e), APPEND_BATCH_MS);
  }

  /** The command ended. Later output for an agent terminal is ignored (a replayed update). */
  exit(key: string, status: AcpExitStatus): void {
    const e = this.entries.get(key);
    if (!e || e.meta.exitStatus) return;
    this.flush(e);
    e.meta.exitStatus = { exitCode: status.exitCode ?? null, signal: status.signal ?? null };
    e.meta.running = false;
    e.meta.endedAt = Date.now();
    this.changed(e);
  }

  release(key: string): void {
    const e = this.entries.get(key);
    if (!e || e.meta.released) return;
    this.flush(e);
    e.meta.released = true;
    this.changed(e);
  }

  meta(key: string): AcpTerminalMeta | undefined {
    const e = this.entries.get(key);
    return e ? { ...e.meta } : undefined;
  }

  snapshot(key: string): AcpTerminalSnapshot | null {
    const e = this.entries.get(key);
    return e ? { ...e.meta, output: e.output } : null;
  }

  /** The end of the output as plain text (for saving into the chat), at most `maxChars`. */
  tailText(key: string, maxChars = 64_000): string | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    const t = e.output.length > maxChars ? e.output.slice(e.output.length - maxChars) : e.output;
    return e.meta.clipped || e.output.length > maxChars ? `… (earlier output not kept)\n${t}` : t;
  }

  /** Terminals of one chat. */
  ofOwner(owner: string): AcpTerminalMeta[] {
    return [...this.entries.values()].filter((e) => e.meta.owner === owner).map((e) => ({ ...e.meta }));
  }

  /** Forgets every terminal of a chat (the chat was deleted). */
  forgetOwner(owner: string): void {
    for (const [k, e] of this.entries) {
      if (e.meta.owner !== owner) continue;
      if (e.timer) clearTimeout(e.timer);
      this.entries.delete(k);
    }
  }

  private flush(e: StoreEntry): void {
    if (e.timer) clearTimeout(e.timer);
    e.timer = null;
    if (!e.pending) return;
    const append = e.pending;
    e.pending = '';
    this.emit('acp:terminal', { key: e.meta.key, append, end: e.meta.end });
  }

  private changed(e: StoreEntry): void {
    const meta = { ...e.meta };
    this.emit('acp:terminal', { key: meta.key, meta });
    for (const l of this.listeners) l(meta);
  }

  private prune(): void {
    if (this.entries.size <= MAX_REMEMBERED) return;
    for (const [k, e] of this.entries) {
      if (this.entries.size <= MAX_REMEMBERED) break;
      if (e.meta.running) continue;
      if (e.timer) clearTimeout(e.timer);
      this.entries.delete(k);
    }
  }
}

// ------------------------------------------------------------------ agent terminals from tool-call `_meta`

interface MetaTerminal {
  terminalId: string;
  cwd?: string;
  output?: string;
  exit?: AcpExitStatus;
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * The terminal facts in a tool call's `_meta` (Codex / Claude Code convention):
 * `terminal_info {terminal_id, cwd?}`, `terminal_output` or `terminal_output_delta {terminal_id, data}`
 * (both are appended), `terminal_exit {terminal_id, exit_code, signal}`. Malformed parts are skipped.
 */
export function parseTerminalMeta(meta: unknown): MetaTerminal[] {
  const m = rec(meta);
  if (!m) return [];
  const byId = new Map<string, MetaTerminal>();
  const get = (id: unknown) => {
    if (typeof id !== 'string' || !id) return null;
    let t = byId.get(id);
    if (!t) byId.set(id, (t = { terminalId: id }));
    return t;
  };
  const info = rec(m.terminal_info);
  if (info) {
    const t = get(info.terminal_id);
    if (t && typeof info.cwd === 'string') t.cwd = info.cwd;
  }
  for (const k of ['terminal_output', 'terminal_output_delta'] as const) {
    const o = rec(m[k]);
    const t = o && get(o.terminal_id);
    if (t && typeof o!.data === 'string') t.output = (t.output ?? '') + (o!.data as string);
  }
  const ex = rec(m.terminal_exit);
  if (ex) {
    const t = get(ex.terminal_id);
    if (t) t.exit = { exitCode: typeof ex.exit_code === 'number' ? ex.exit_code : null, signal: typeof ex.signal === 'string' ? ex.signal : null };
  }
  return [...byId.values()];
}

/** The command line in a tool call's `rawInput` (`command` as a string or an argv list), for the BASH box. */
export function commandOfRawInput(rawInput: unknown): string | undefined {
  const r = rec(rawInput);
  const c = r?.command ?? r?.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) {
    // Codex sends `["bash", "-lc", "<script>"]`: show the script.
    if (c.length === 3 && /^(?:ba|z|da|k)?sh$/.test(basename(c[0])) && /^-l?c$/.test(c[1])) return c[2];
    return c.join(' ');
  }
  return undefined;
}

/**
 * Applies one tool-call update's terminal `_meta` to the store. Returns the keys of the terminals it
 * touched (the tool card shows these live). Output that arrives after the exit is ignored, so a replayed
 * history (`session/load`) does not double it.
 */
export function applyTerminalMeta(store: AcpTerminalStore, owner: string, meta: unknown, rawInput?: unknown): string[] {
  const keys: string[] = [];
  for (const t of parseTerminalMeta(meta)) {
    const key = acpTerminalKey(owner, t.terminalId);
    const known = store.meta(key);
    if (known && known.source === 'client') continue; // never mix with a terminal Olympus runs itself
    if (!known || t.cwd) store.open(owner, t.terminalId, { source: 'agent', cwd: t.cwd, command: commandOfRawInput(rawInput) });
    if (t.output && !store.meta(key)?.exitStatus) store.append(key, t.output);
    if (t.exit) store.exit(key, t.exit);
    keys.push(key);
  }
  return keys;
}

// ------------------------------------------------------------------ how a command is started

export interface SpawnSpec {
  file: string;
  args: string[];
  /** Windows: pass `args` to `cmd.exe` exactly as built (they are pre-quoted). */
  verbatim?: boolean;
  /** Shown in the BASH box. */
  display: string;
}

// cmd.exe meta characters (same rules as cross-spawn).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function escapeCmdArg(arg: string, doubleEscape: boolean): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  a = `"${a}"`.replace(CMD_META, '^$1');
  return doubleEscape ? a.replace(CMD_META, '^$1') : a;
}
const escapeCmdCommand = (c: string) => c.replace(CMD_META, '^$1');

const quoteForDisplay = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

/**
 * How to start `command` with `args` on `platform`.
 * - No args: `command` is a command line for the shell (`<shell> -c` on Unix, `cmd.exe /d /s /c` on Windows).
 * - With args on Unix: the program is run directly, without a shell.
 * - With args on Windows: `.exe` / `.com` run directly; anything else (`.cmd` / `.bat`, unresolved names)
 *   through `cmd.exe` with each argument escaped. `resolved` is the program found on PATH, if any.
 */
export function buildSpawn(command: string, args: string[], opts: { platform: NodeJS.Platform; shell: string; comspec?: string; resolved?: string }): SpawnSpec {
  if (opts.platform === 'win32') {
    const comspec = opts.comspec || 'cmd.exe';
    if (!args.length) return { file: comspec, args: ['/d', '/s', '/c', `"${command}"`], verbatim: true, display: command };
    const display = [command, ...args].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
    const resolved = opts.resolved;
    if (resolved && /\.(?:exe|com)$/i.test(resolved)) return { file: resolved, args, display };
    const shim = !!resolved && /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved);
    const line = [escapeCmdCommand(resolved ?? command), ...args.map((a) => escapeCmdArg(a, shim))].join(' ');
    return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`], verbatim: true, display };
  }
  if (!args.length) return { file: opts.shell, args: ['-c', command], display: command };
  return { file: command, args, display: [command, ...args].map(quoteForDisplay).join(' ') };
}

/** The shell for command lines on Unix: the user's if it is a POSIX-style one, else bash, else sh. */
export function posixShell(env: Record<string, string | undefined> = process.env): string {
  const s = env.SHELL;
  if (s && isAbsolute(s) && /^(?:ba|z|da|k)?sh$/.test(basename(s)) && existsSync(s)) return s;
  return existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
}

/** Windows: finds `command` on PATH with PATHEXT, like cmd.exe would. */
export function whichWindows(command: string, env: Record<string, string | undefined>, cwd: string): string | undefined {
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasDir = /[\\/]/.test(command);
  const dirs = hasDir ? [''] : [cwd, ...(env.PATH || env.Path || '').split(delimiter).filter(Boolean)];
  const names = extname(command) ? [command, ...exts.map((e) => command + e)] : exts.map((e) => command + e);
  for (const d of dirs) {
    for (const n of names) {
      const p = d ? join(d, n) : n;
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

/** Ends a command and everything it started: the process group on Unix, the process tree on Windows. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

// ------------------------------------------------------------------ client terminals

export interface TerminalContext {
  /** The ACP session asking. Terminal ids are only valid within the session that created them. */
  sessionId: string;
  /** The chat (thread id) whose tool box shows the terminal. */
  owner: string;
  /** Folder for commands that give no `cwd` (the project folder). */
  defaultCwd: string;
  /** Environment the command starts from (the agent environment); the request's `env` is added on top. */
  env: Record<string, string>;
  /** Refuse to start a command unless this returns true (return a reason to refuse with it). */
  mayRun?: () => true | string;
}

interface ClientTerminal {
  id: string;
  key: string;
  sessionId: string;
  owner: string;
  child: ChildProcess;
  out: OutputBuffer;
  exit?: AcpExitStatus;
  exited: Promise<AcpExitStatus>;
  killTimer?: ReturnType<typeof setTimeout>;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw RequestError.invalidParams({ [name]: v }, `${name} must be a non-empty string.`);
  return v;
};

export class AcpTerminalManager {
  private terms = new Map<string, ClientTerminal>();
  private store: AcpTerminalStore;
  private platform: NodeJS.Platform;

  constructor(store: AcpTerminalStore, platform: NodeJS.Platform = process.platform) {
    this.store = store;
    this.platform = platform;
  }

  private find(sessionId: string, terminalId: unknown): ClientTerminal {
    const t = typeof terminalId === 'string' ? this.terms.get(terminalId) : undefined;
    if (!t || t.sessionId !== sessionId) throw RequestError.invalidParams({ terminalId }, `No terminal with id ${String(terminalId)} in this session (it may have been released).`);
    return t;
  }

  /** `terminal/create`: starts the command and returns at once; output streams into the store. */
  async create(params: CreateTerminalRequest, ctx: TerminalContext): Promise<CreateTerminalResponse> {
    const command = str(params?.command, 'command');
    const args = params.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw RequestError.invalidParams({ args }, 'args must be a list of strings.');
    if ([command, ...args].some((a) => a.includes('\0'))) throw RequestError.invalidParams(undefined, 'command and args must not contain NUL characters.');
    const limitIn = params.outputByteLimit;
    if (limitIn != null && (typeof limitIn !== 'number' || !Number.isInteger(limitIn) || limitIn < 0)) throw RequestError.invalidParams({ outputByteLimit: limitIn }, 'outputByteLimit must be a whole number ≥ 0.');
    const limit = Math.min(limitIn ?? MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);

    let cwd = ctx.defaultCwd;
    if (params.cwd != null) {
      if (typeof params.cwd !== 'string' || !isAbsolute(params.cwd)) throw RequestError.invalidParams({ cwd: params.cwd }, 'cwd must be an absolute path.');
      cwd = params.cwd;
    }
    try {
      if (!statSync(cwd).isDirectory()) throw new Error();
    } catch {
      throw RequestError.invalidParams({ cwd }, `cwd is not an existing folder: ${cwd}`);
    }

    const env: Record<string, string> = { ...ctx.env };
    for (const v of params.env ?? []) {
      if (!v || typeof v.name !== 'string' || !v.name || /[=\0]/.test(v.name) || typeof v.value !== 'string' || v.value.includes('\0')) {
        throw RequestError.invalidParams({ env: v }, 'env entries need a name (no "=") and a string value.');
      }
      if (this.platform === 'win32') {
        for (const k of Object.keys(env)) if (k.toLowerCase() === v.name.toLowerCase()) delete env[k];
      }
      env[v.name] = v.value;
    }

    const live = [...this.terms.values()].filter((t) => t.sessionId === ctx.sessionId && !t.exit).length;
    if (live >= MAX_LIVE_PER_SESSION) throw RequestError.invalidRequest(undefined, `Too many running terminals in this session (${MAX_LIVE_PER_SESSION}). Release some first.`);
    const allowed = ctx.mayRun ? ctx.mayRun() : true;
    if (allowed !== true) throw RequestError.invalidRequest(undefined, allowed || 'Olympus is not running a turn for this session, so it will not start commands.');

    const spec = buildSpawn(command, args, {
      platform: this.platform,
      shell: this.platform === 'win32' ? '' : posixShell(env),
      comspec: env.ComSpec || env.COMSPEC || process.env.ComSpec,
      resolved: this.platform === 'win32' && args.length ? whichWindows(command, env, cwd) : undefined,
    });

    const child = spawn(spec.file, spec.args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: this.platform !== 'win32',
      windowsHide: true,
      windowsVerbatimArguments: spec.verbatim,
    });
    await new Promise<void>((ok, fail) => {
      child.once('spawn', () => ok());
      child.once('error', (e) => fail(RequestError.internalError({ command: spec.display }, `Could not start the command: ${e.message}`)));
    });

    const id = randomUUID();
    const key = acpTerminalKey(ctx.owner, id);
    const out = new OutputBuffer(limit);
    this.store.open(ctx.owner, id, { source: 'client', command: spec.display, cwd });
    const onText = (s: string) => {
      if (!s) return;
      out.append(s);
      this.store.append(key, s);
    };
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    child.stdout!.on('data', (b: Buffer) => onText(decoders[0].write(b)));
    child.stderr!.on('data', (b: Buffer) => onText(decoders[1].write(b)));

    let settle!: (s: AcpExitStatus) => void;
    const t: ClientTerminal = { id, key, sessionId: ctx.sessionId, owner: ctx.owner, child, out, exited: new Promise<AcpExitStatus>((done) => (settle = done)) };
    let status: AcpExitStatus | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (t.exit) return;
      if (grace) clearTimeout(grace);
      if (t.killTimer) clearTimeout(t.killTimer);
      onText(decoders[0].end());
      onText(decoders[1].end());
      child.stdout?.destroy();
      child.stderr?.destroy();
      t.exit = status ?? { exitCode: null, signal: null };
      this.store.exit(key, t.exit);
      settle(t.exit);
    };
    child.once('exit', (code, signal) => {
      status = { exitCode: code, signal: signal ?? null };
      // Output still in the pipes arrives before `close`; a background child that keeps them open must not hang us.
      grace = setTimeout(finish, CLOSE_GRACE_MS);
    });
    child.once('close', (code, signal) => {
      status ??= { exitCode: code, signal: signal ?? null };
      finish();
    });
    // Errors after a successful start (a failed kill) must not become uncaught exceptions.
    child.on('error', () => {});
    this.terms.set(id, t);
    return { terminalId: id };
  }

  /** `terminal/output`: the retained output (last `outputByteLimit` bytes) and, once ended, the exit status. */
  output(params: TerminalOutputRequest, ctx: { sessionId: string }): TerminalOutputResponse {
    const t = this.find(ctx.sessionId, params?.terminalId);
    const { output, truncated } = t.out.read();
    return { output, truncated, exitStatus: t.exit ?? null };
  }

  /** `terminal/wait_for_exit`: resolves when the command has ended. */
  async waitForExit(params: WaitForTerminalExitRequest, ctx: { sessionId: string }): Promise<WaitForTerminalExitResponse> {
    const t = this.find(ctx.sessionId, params?.terminalId);
    const s = await t.exited;
    return { exitCode: s.exitCode, signal: s.signal };
  }

  /** `terminal/kill`: stops the command; the terminal stays valid for `output` / `wait_for_exit`. */
  kill(params: KillTerminalRequest, ctx: { sessionId: string }): KillTerminalResponse {
    this.stop(this.find(ctx.sessionId, params?.terminalId));
    return {};
  }

  /** `terminal/release`: stops the command if it still runs and forgets the id; the window keeps the output. */
  release(params: ReleaseTerminalRequest, ctx: { sessionId: string }): ReleaseTerminalResponse {
    const t = this.find(ctx.sessionId, params?.terminalId);
    this.stop(t);
    this.terms.delete(t.id);
    this.store.release(t.key);
    return {};
  }

  private stop(t: ClientTerminal, hard = false): void {
    if (t.exit) return;
    killTree(t.child, hard ? 'SIGKILL' : 'SIGTERM');
    if (!hard && !t.killTimer) {
      t.killTimer = setTimeout(() => {
        if (!t.exit) killTree(t.child, 'SIGKILL');
      }, KILL_GRACE_MS);
      t.killTimer.unref?.();
    }
  }

  /** The user stopped the turn (or pressed Stop on the box): stop that chat's running commands, keep the terminals. */
  killOwner(owner: string): number {
    let n = 0;
    for (const t of this.terms.values()) {
      if (t.owner !== owner || t.exit) continue;
      this.stop(t);
      n++;
    }
    return n;
  }

  /** Stop button on one box (by store key). Only terminals Olympus runs can be stopped from here. */
  killKey(key: string): boolean {
    for (const t of this.terms.values()) {
      if (t.key !== key) continue;
      if (t.exit) return false;
      this.stop(t);
      return true;
    }
    return false;
  }

  /** The agent session ended or was dropped: stop and release all of its terminals. */
  releaseSession(sessionId: string): void {
    for (const t of [...this.terms.values()]) {
      if (t.sessionId !== sessionId) continue;
      this.stop(t);
      this.terms.delete(t.id);
      this.store.release(t.key);
    }
  }

  /** App quit: kill every command right away. */
  killAll(): void {
    for (const t of this.terms.values()) if (!t.exit) killTree(t.child, 'SIGKILL');
  }

  /** Running client terminals (for the Tasks list). */
  running(): { key: string; owner: string; sessionId: string; pid?: number; command?: string; startedAt: number }[] {
    return [...this.terms.values()]
      .filter((t) => !t.exit)
      .map((t) => {
        const m = this.store.meta(t.key);
        return { key: t.key, owner: t.owner, sessionId: t.sessionId, pid: t.child.pid, command: m?.command, startedAt: m?.startedAt ?? Date.now() };
      });
  }
}

/** The app's store and manager. */
export const acpTerminalStore = new AcpTerminalStore();
export const acpTerminals = new AcpTerminalManager(acpTerminalStore);
