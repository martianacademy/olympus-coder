import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Local whisper.cpp. Prefers a warm `whisper-server` on 127.0.0.1 (random free port): started on first use (or when
 * the user starts recording), stopped after 10 minutes without use, and always killed on quit. Falls back to one
 * `whisper-cli` run per clip. Never downloads anything: the binary and model must already be on disk.
 */

const log = (...a: unknown[]) => console.log('[voice/whisper]', ...a);
export const IDLE_STOP_MS = 10 * 60_000;
const START_TIMEOUT_MS = 90_000;

interface Running {
  proc: ChildProcess;
  port: number;
  bin: string;
  model: string;
}

let current: Running | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let pidFile: string | null = null;

/** Where the server's pid is kept, so a server left by a crashed run is stopped on the next start. */
export function initWhisperPidFile(file: string) {
  pidFile = file;
  try {
    const pid = Number(readFileSync(file, 'utf8').trim());
    if (pid > 0) {
      execFile('ps', ['-p', String(pid), '-o', 'command='], (err, out) => {
        if (!err && /whisper-server/.test(out)) {
          log('stopping a whisper-server left by an earlier run', pid);
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
      });
    }
    unlinkSync(file);
  } catch {
    /* none */
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function waitUntilUp(port: number, proc: ChildProcess): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < START_TIMEOUT_MS) {
    if (proc.exitCode !== null || proc.signalCode) throw new Error(`whisper-server exited (${proc.exitCode ?? proc.signalCode}).`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      if (r.ok || r.status === 404) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('whisper-server did not start in time.');
}

function armIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    log('idle, stopping whisper-server');
    stopWhisperServer();
  }, IDLE_STOP_MS);
  idleTimer.unref?.();
}

/** Every server this process spawned (normally one), so quit can kill them all. */
const spawned = new Set<ChildProcess>();
/** A start in progress: concurrent callers (prewarm + transcribe) share it instead of spawning a second server. */
let starting: { bin: string; model: string; promise: Promise<Running> } | null = null;

async function spawnServer(bin: string, model: string): Promise<Running> {
  const port = await freePort();
  log('starting', bin, model, 'port', port);
  const proc = spawn(bin, ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-nt'], { stdio: ['ignore', 'ignore', 'pipe'] });
  spawned.add(proc);
  let tail = '';
  proc.stderr?.on('data', (d) => (tail = (tail + String(d)).slice(-2000)));
  proc.on('error', (e) => (tail += ` ${e.message}`));
  proc.on('exit', (code, sig) => {
    log('whisper-server exited', code ?? sig);
    spawned.delete(proc);
    if (current?.proc === proc) current = null;
    if (pidFile && !spawned.size)
      try {
        unlinkSync(pidFile);
      } catch {
        /* none */
      }
  });
  if (pidFile && proc.pid) writeFileSync(pidFile, String(proc.pid));
  try {
    await waitUntilUp(port, proc);
  } catch (e) {
    const why = tail.trim().split('\n').slice(-3).join(' ');
    try {
      proc.kill('SIGKILL');
    } catch {
      /* gone */
    }
    throw new Error(`${e instanceof Error ? e.message : e}${why ? ` ${why}` : ''}`);
  }
  return { proc, port, bin, model };
}

/** Starts (or reuses) the warm server for this model. Resolves with its port once it answers. */
export async function ensureServer(bin: string, model: string): Promise<number> {
  if (current && (current.model !== model || current.bin !== bin || current.proc.exitCode !== null)) stopWhisperServer();
  if (!current) {
    if (!starting || starting.bin !== bin || starting.model !== model) {
      const promise = spawnServer(bin, model);
      const mine = { bin, model, promise };
      starting = mine;
      promise.then(
        (r) => {
          if (starting === mine) {
            starting = null;
            current = r;
          } else {
            // Superseded (another model was asked for meanwhile, or stop was called): don't keep it.
            try {
              r.proc.kill('SIGKILL');
            } catch {
              /* gone */
            }
          }
        },
        () => {
          if (starting === mine) starting = null;
        },
      );
    }
    const r = await starting.promise;
    armIdle();
    return r.port;
  }
  armIdle();
  return current.port;
}

export function whisperServerRunning(): boolean {
  return Boolean(current && current.proc.exitCode === null);
}

export function whisperServerPid(): number | undefined {
  return current?.proc.pid;
}

export function stopWhisperServer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  current = null;
  starting = null;
  for (const p of spawned) {
    if (p.exitCode === null)
      try {
        p.kill('SIGKILL');
      } catch {
        /* gone */
      }
  }
}

export interface WhisperOpts {
  wav: Uint8Array;
  model: string;
  /** ISO code, or undefined for auto-detect. */
  language?: string;
  prompt?: string;
}

export async function transcribeWithServer(bin: string, o: WhisperOpts): Promise<string> {
  const port = await ensureServer(bin, o.model);
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(o.wav)], { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  // Always send both: older whisper-server builds keep the previous request's values otherwise.
  form.append('language', o.language ?? 'auto');
  form.append('prompt', o.prompt ?? '');
  const res = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(180_000) });
  armIdle();
  if (!res.ok) throw new Error(`whisper-server HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const j = (await res.json()) as { text?: string; error?: string };
  if (j.error) throw new Error(`whisper-server: ${j.error}`);
  return (j.text ?? '').trim();
}

export function transcribeWithCli(bin: string, o: WhisperOpts): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-voice-'));
  const file = join(dir, 'clip.wav');
  writeFileSync(file, o.wav);
  const args = ['-m', o.model, '-f', file, '-nt', '-np', '-l', o.language ?? 'auto'];
  if (o.prompt) args.push('--prompt', o.prompt);
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 }, (err, out, stderr) => {
      rmSync(dir, { recursive: true, force: true });
      if (err) return reject(new Error(`whisper-cli failed: ${(stderr || err.message).trim().split('\n').slice(-2).join(' ')}`));
      resolve(
        out
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .join(' ')
          .trim(),
      );
    });
  });
}

/** Methods to try for whisper-local, in order: warm server first, then a per-clip CLI run. */
export function whisperPlan(bins: { server?: string; cli?: string }): { method: 'server' | 'cli'; bin: string }[] {
  const plan: { method: 'server' | 'cli'; bin: string }[] = [];
  if (bins.server) plan.push({ method: 'server', bin: bins.server });
  if (bins.cli) plan.push({ method: 'cli', bin: bins.cli });
  return plan;
}
