import { closeSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { RequestError } from '@agentclientprotocol/sdk/unstable';
import type { ReadTextFileRequest, ReadTextFileResponse, WriteTextFileRequest, WriteTextFileResponse } from '@agentclientprotocol/sdk/unstable';
import type { AgentFileWrite } from '@shared/acpClient';

/**
 * The ACP client file methods: `fs/read_text_file` and `fs/write_text_file`.
 *
 * Both only reach files inside the session's sandbox: the project folder, the session's additional
 * directories, and the OS temp folder. Paths are checked after resolving `..` and every symlink, so a link
 * inside the project that points elsewhere cannot be used to get out. A read returns the editor's unsaved
 * text when the file is open with changes. A write never touches an editor's unsaved text: the window keeps
 * it and shows a conflict.
 *
 * Permission to write is the agent's job (it asks with `session/request_permission` before an edit), so
 * nothing here asks again.
 */

/** A file whose returned text would be larger than this must be read in parts (`line` / `limit`). */
export const MAX_READ_CHARS = 10 * 1024 * 1024;
export const MAX_WRITE_BYTES = 20 * 1024 * 1024;
const CHUNK = 64 * 1024;
const BINARY_SNIFF = 8192;

export interface FsContext {
  /** The folders the session may use: project folder and `additionalDirectories` (absolute). The OS temp folder is added. */
  roots: string[];
  /** Unsaved editor text for an absolute real path, when the file is open with changes. */
  unsavedText?: (realPath: string) => string | undefined;
  /** After a successful write (to update open editors and the chat). */
  onWritten?: (write: AgentFileWrite) => void;
  /** The temp folders that are always allowed (default: the OS temp folder, and `/tmp` on Unix). */
  tempDirs?: string[];
}

let writeListener: (w: AgentFileWrite) => void = () => {};
export const setAgentWriteEmitter = (fn: (w: AgentFileWrite) => void) => {
  writeListener = fn;
};
/** Tells the windows an agent wrote a file: an open editor reloads it, or shows a conflict when it has unsaved edits. */
export const announceAgentWrite = (w: AgentFileWrite) => writeListener(w);

const sameCase = process.platform === 'win32' || process.platform === 'darwin';
const cmp = (p: string) => (sameCase ? p.toLowerCase() : p);

/** The OS temp folders that are always part of the sandbox. */
export function osTempDirs(): string[] {
  return process.platform === 'win32' ? [tmpdir()] : [tmpdir(), '/tmp'];
}

/** The sandbox folders, resolved to real paths (missing ones are dropped). */
export function sandboxRoots(roots: string[], temps: string[] = osTempDirs()): string[] {
  const out = new Map<string, string>();
  for (const r of [...roots, ...temps]) {
    if (typeof r !== 'string' || !r || !isAbsolute(r)) continue;
    try {
      const real = realpathSync.native(r);
      if (statSync(real).isDirectory()) out.set(cmp(real), real);
    } catch {
      /* a folder that does not exist adds nothing */
    }
  }
  return [...out.values()];
}

/** Whether real path `p` is `root` itself or inside it. */
export function isWithin(p: string, root: string): boolean {
  const rel = relative(cmp(root), cmp(p));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

const outside = (path: string) => RequestError.invalidParams({ path }, `Access denied: ${path} is outside the project, its additional folders and the temp folder.`);

function checkPath(path: unknown): string {
  if (typeof path !== 'string' || !path) throw RequestError.invalidParams({ path }, 'path must be a non-empty string.');
  if (path.includes('\0')) throw RequestError.invalidParams({ path }, 'path contains a NUL character.');
  if (!isAbsolute(path)) throw RequestError.invalidParams({ path }, `path must be absolute: ${path}`);
  return resolve(path);
}

/** Resolves an existing file for reading; throws unless its real path is inside a sandbox root. */
export function resolveForRead(path: unknown, roots: string[]): string {
  const full = checkPath(path);
  let real: string;
  try {
    real = realpathSync.native(full);
  } catch (e: any) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') {
      // Say "outside" before "missing", so probing cannot tell which outside files exist.
      resolveForWrite(full, roots);
      throw RequestError.resourceNotFound(full);
    }
    throw RequestError.internalError({ path: full }, e?.message ?? String(e));
  }
  if (!roots.some((r) => isWithin(real, r))) throw outside(full);
  return real;
}

/**
 * Resolves a path for writing: the nearest existing folder is resolved to its real path and the missing
 * parts are added to it (they will be created as plain folders). Refuses broken symlinks anywhere on the
 * way, since writing through one would create its target wherever it points.
 */
export function resolveForWrite(path: unknown, roots: string[]): { target: string; exists: boolean } {
  const full = checkPath(path);
  const missing: string[] = [];
  let cur = full;
  let real: string;
  for (;;) {
    try {
      real = realpathSync.native(cur);
      break;
    } catch (e: any) {
      if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw RequestError.internalError({ path: full }, e?.message ?? String(e));
      let linkThere = false;
      try {
        linkThere = lstatSync(cur).isSymbolicLink();
      } catch {
        /* nothing there at all */
      }
      if (linkThere) {
        if (!roots.some((r) => isWithin(full, r))) throw outside(full);
        throw RequestError.invalidParams({ path: full }, `Refusing to write through a broken symbolic link: ${cur}`);
      }
      const parent = dirname(cur);
      if (parent === cur) throw outside(full);
      missing.unshift(basename(cur));
      cur = parent;
    }
  }
  const target = missing.length ? join(real, ...missing) : real;
  if (!roots.some((r) => isWithin(target, r))) throw outside(full);
  if (roots.some((r) => cmp(r) === cmp(target))) throw RequestError.invalidParams({ path: full }, 'path is a folder, not a file.');
  if (missing.length === 0 && statSync(target).isDirectory()) throw RequestError.invalidParams({ path: full }, 'path is a folder, not a file.');
  return { target, exists: missing.length === 0 };
}

function lineArg(v: unknown, name: string, min: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw RequestError.invalidParams({ [name]: v }, `${name} must be an integer ≥ ${min}.`);
  return v;
}

/**
 * Lines `line`… (1-based) of `text`, at most `limit` of them, with their line endings.
 * A start past the end gives ''.
 */
export function sliceLines(text: string, line?: number, limit?: number): string {
  const first = line ?? 1;
  if (first === 1 && limit === undefined) return text;
  if (limit === 0) return '';
  let start = 0;
  for (let n = 1; n < first; n++) {
    const nl = text.indexOf('\n', start);
    if (nl < 0) return '';
    start = nl + 1;
  }
  if (start >= text.length) return '';
  if (limit === undefined) return text.slice(start);
  let end = start;
  for (let n = 0; n < limit; n++) {
    const nl = text.indexOf('\n', end);
    if (nl < 0) return text.slice(start);
    end = nl + 1;
  }
  return text.slice(start, end);
}

/**
 * Reads lines `line`… of a file from disk in chunks, so a part of a big file can be read without loading
 * all of it. Throws for binary files and when the result would exceed {@link MAX_READ_CHARS}.
 */
export function readFileLines(real: string, line?: number, limit?: number): string {
  const st = statSync(real);
  if (!st.isFile()) throw RequestError.invalidParams({ path: real }, 'path is not a regular file.');
  const fd = openSync(real, 'r');
  try {
    const dec = new StringDecoder('utf8');
    const buf = Buffer.allocUnsafe(CHUNK);
    const first = line ?? 1;
    let lineNo = 1;
    let taken = 0;
    let out = '';
    let sniffed = 0;
    let pos = 0;
    const done = () => limit !== undefined && taken >= limit;
    const takeText = (s: string) => {
      let i = 0;
      while (i < s.length && !done()) {
        const nl = s.indexOf('\n', i);
        const stop = nl < 0 ? s.length : nl + 1;
        if (lineNo >= first) {
          out += s.slice(i, stop);
          if (out.length > MAX_READ_CHARS) throw RequestError.invalidParams({ path: real }, `The file is too large to read at once (over ${MAX_READ_CHARS / 1024 / 1024} MB of text). Read it in parts with line and limit.`);
        }
        if (nl >= 0) {
          if (lineNo >= first) taken++;
          lineNo++;
        }
        i = stop;
      }
    };
    if (limit === 0) return '';
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      if (sniffed < BINARY_SNIFF) {
        const end = Math.min(n, BINARY_SNIFF - sniffed);
        if (buf.subarray(0, end).includes(0)) throw RequestError.invalidParams({ path: real }, 'This is a binary file, not text.');
        sniffed += end;
      }
      pos += n;
      takeText(dec.write(buf.subarray(0, n)));
      if (done()) return out;
    }
    takeText(dec.end());
    return out;
  } finally {
    closeSync(fd);
  }
}

/** `fs/read_text_file`: the editor's unsaved text when there is any, else the file on disk. */
export function readTextFile(params: ReadTextFileRequest, ctx: FsContext): ReadTextFileResponse {
  const roots = sandboxRoots(ctx.roots, ctx.tempDirs);
  const real = resolveForRead(params?.path, roots);
  const line = lineArg(params.line, 'line', 1);
  const limit = lineArg(params.limit, 'limit', 0);
  const unsaved = ctx.unsavedText?.(real);
  if (unsaved !== undefined) {
    const content = sliceLines(unsaved, line, limit);
    if (content.length > MAX_READ_CHARS) throw RequestError.invalidParams({ path: real }, 'The file is too large to read at once. Read it in parts with line and limit.');
    return { content };
  }
  try {
    return { content: readFileLines(real, line, limit) };
  } catch (e: any) {
    if (e instanceof RequestError) throw e;
    throw RequestError.internalError({ path: real }, e?.message ?? String(e));
  }
}

/** `fs/write_text_file`: writes inside the sandbox, creating parent folders. */
export function writeTextFile(params: WriteTextFileRequest, ctx: FsContext): WriteTextFileResponse {
  const roots = sandboxRoots(ctx.roots, ctx.tempDirs);
  const { target, exists } = resolveForWrite(params?.path, roots);
  if (typeof params.content !== 'string') throw RequestError.invalidParams({ path: target }, 'content must be a string.');
  if (Buffer.byteLength(params.content, 'utf8') > MAX_WRITE_BYTES) throw RequestError.invalidParams({ path: target }, `content is larger than ${MAX_WRITE_BYTES / 1024 / 1024} MB.`);
  const unsaved = ctx.unsavedText?.(target);
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, params.content, 'utf8');
  } catch (e: any) {
    throw RequestError.internalError({ path: target }, e?.message ?? String(e));
  }
  ctx.onWritten?.({ path: target, content: params.content, conflict: unsaved !== undefined && unsaved !== params.content, created: !exists, ts: Date.now() });
  return {};
}
