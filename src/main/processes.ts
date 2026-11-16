import { execFile } from 'node:child_process';
import type { ProcAction, RunningTask } from '@shared/types';
import { agentProcesses } from './agents';
import { ptyPid, writePty } from './pty';
import { terminalsAlive } from './terminals';

/**
 * The real programs behind the work in progress, so the Tasks panel can show what each one costs (CPU, memory)
 * and pause, resume or stop it — say a training run that is heating the machine.
 *
 * Two sources: commands an agent runs (each is a shell the agent's process started: `zsh -c …`, `bash -c …`;
 * MCP servers and other helpers are not shells and are left out), and programs running in a workbench
 * terminal (everything below the terminal's shell). Pause is SIGSTOP / SIGCONT on the whole process tree;
 * Windows has no pause, only stop.
 */

export interface Proc {
  pid: number;
  ppid: number;
  stopped: boolean;
  cpu: number;
  rssKB: number;
  secs: number;
  command: string;
}

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve) => execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: 8000, windowsHide: true }, (_e, out) => resolve(String(out ?? ''))));

/** `[[dd-]hh:]mm:ss` from ps, in seconds. */
function etime(s: string): number {
  const [d, rest] = s.includes('-') ? s.split('-') : ['0', s];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(d) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export async function listProcs(): Promise<Proc[]> {
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CreationDate,CommandLine,Name | ConvertTo-Json -Compress',
    ]);
    try {
      const rows = JSON.parse(out) as any[];
      return rows.map((r) => ({
        pid: r.ProcessId,
        ppid: r.ParentProcessId,
        stopped: false,
        cpu: NaN,
        rssKB: Math.round((r.WorkingSetSize ?? 0) / 1024),
        secs: r.CreationDate ? Math.max(0, (Date.now() - new Date(r.CreationDate).getTime()) / 1000) : 0,
        command: r.CommandLine || r.Name || '',
      }));
    } catch {
      return [];
    }
  }
  const out = await run('ps', ['-Aww', '-o', 'pid=,ppid=,stat=,%cpu=,rss=,etime=,command=']);
  const procs: Proc[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) procs.push({ pid: +m[1], ppid: +m[2], stopped: m[3].startsWith('T'), cpu: +m[4], rssKB: +m[5], secs: etime(m[6]), command: m[7] });
  }
  return procs;
}

function childrenMap(procs: Proc[]) {
  const kids = new Map<number, Proc[]>();
  for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  return kids;
}

/** Every process below `pid` (not `pid` itself), parents before children. */
function descendants(pid: number, kids: Map<number, Proc[]>): Proc[] {
  const out: Proc[] = [];
  const walk = (p: number) => {
    for (const c of kids.get(p) ?? []) {
      out.push(c);
      walk(c.pid);
    }
  };
  walk(pid);
  return out;
}

const SHELL = /^(\S*[/\\])?(ba|z|k|fi|da|c|tc)?sh(\.exe)?(\s|$)|^(\S*[/\\])?(pwsh|powershell|cmd)(\.exe)?(\s|$)/i;

/** The command a shell was started with, without the wrapper agents put around it. */
function shellCommand(cmd: string): string {
  // Claude Code: … && eval '<command>' < /dev/null && pwd -P >| /tmp/claude-…-cwd
  const ev = /\beval '((?:[^']|'"'"')*)'/.exec(cmd);
  if (ev) return ev[1].replace(/'"'"'/g, "'");
  const c = /\s-(?:l?c|c\s+-l|lc)\s+(.*)$/s.exec(cmd);
  return (c ? c[1] : cmd).replace(/^(['"])(.*)\1$/s, '$2').trim();
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function summarize(id: string, root: Proc, tree: Proc[]) {
  const live = tree.length ? tree : [root];
  return {
    id,
    rootPid: root.pid,
    pids: live.map((p) => p.pid),
    procs: live.slice(0, 12).map((p) => ({ pid: p.pid, cpu: p.cpu, memMB: Math.round(p.rssKB / 1024), command: p.command.slice(0, 300) })),
    cpu: live.reduce((a, p) => a + (Number.isFinite(p.cpu) ? p.cpu : 0), 0),
    memMB: Math.round(live.reduce((a, p) => a + p.rssKB, 0) / 1024),
    secs: Math.round(root.secs),
    paused: live.every((p) => p.stopped),
    canPause: process.platform !== 'win32',
  };
}

/**
 * The Tasks panel (2 s), the sidebar status poll (4 s), jobwatch (3 s) and heat (10 s) all ask for this. Each
 * call used to spawn its own `ps -Aww`; now concurrent callers share one in-flight scan, and a result younger
 * than SNAPSHOT_TTL_MS is reused. `fresh` skips the cache (pause/resume/stop must act on the current tree).
 */
const SNAPSHOT_TTL_MS = 1500;
let snapshot: { at: number; tasks: RunningTask[] } | null = null;
let inFlight: Promise<RunningTask[]> | null = null;

/** Everything running right now that the app started, with what it costs. */
export function runningTasks(fresh = false): Promise<RunningTask[]> {
  if (!fresh && snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL_MS) return Promise.resolve(snapshot.tasks);
  if (!fresh && inFlight) return inFlight;
  const p = scanRunningTasks()
    .then((tasks) => {
      snapshot = { at: Date.now(), tasks };
      return tasks;
    })
    .finally(() => {
      if (inFlight === p) inFlight = null;
    });
  if (!fresh) inFlight = p;
  return p;
}

/** Topmost shell roots below `rootPid` at any depth (skipping MCP bridges and shells nested inside an already-claimed shell). */
function topShellsUnder(rootPid: number, kids: Map<number, Proc[]>): Proc[] {
  const out: Proc[] = [];
  const walk = (pid: number, depth: number) => {
    if (depth > 8) return;
    for (const c of kids.get(pid) ?? []) {
      if (/olympus-mcp-bridge|\bmcp\b/i.test(c.command)) continue;
      if (SHELL.test(c.command)) out.push(c);
      else walk(c.pid, depth + 1);
    }
  };
  walk(rootPid, 0);
  return out;
}

function matchShellToThread(
  n: string,
  threads: { threadId: string; running: boolean; tools: { id: string; title: string; command?: string }[] }[],
  requireToolMatch = false,
): { threadId?: string; toolItemId?: string } {
  for (const rt of threads) {
    for (const t of rt.tools) {
      for (const candidate of [t.command, t.title]) {
        const tn = candidate ? norm(candidate) : '';
        if (n && tn && (tn.includes(n.slice(0, 48)) || n.includes(tn.slice(0, 48)))) {
          return { threadId: rt.threadId, toolItemId: t.id };
        }
      }
    }
  }
  if (requireToolMatch) return {};
  const fallback = threads.find((t) => t.running) ?? threads.find((t) => t.tools.length) ?? threads[0];
  return { threadId: fallback?.threadId };
}

async function scanRunningTasks(): Promise<RunningTask[]> {
  const procs = await listProcs();
  const kids = childrenMap(procs);
  const out: RunningTask[] = [];
  const seenShellPids = new Set<number>();
  const agentList = agentProcesses();

  for (const a of agentList) {
    for (const sh of topShellsUnder(a.pid, kids)) {
      seenShellPids.add(sh.pid);
      const command = shellCommand(sh.command);
      const { threadId, toolItemId } = matchShellToThread(norm(command), a.threads, false);
      out.push({
        ...summarize(`agent:${sh.pid}`, sh, [sh, ...descendants(sh.pid, kids)]),
        source: 'agent',
        title: command || sh.command,
        agentId: a.agentId,
        threadId,
        toolItemId,
      });
    }
  }

  // Antigravity (`agy acp`) delegates `run_command` execution to its `language_server_*` daemon rather than spawning
  // shells directly under `agy acp`. Match shells under `language_server` against active Antigravity tool steps.
  const agy = agentList.find((a) => a.agentId === 'antigravity');
  if (agy && agy.threads.some((t) => t.running || t.tools.length > 0)) {
    for (const p of procs) {
      if (!/language_server(?:_macos|_linux|_windows|\b)/i.test(p.command)) continue;
      for (const sh of topShellsUnder(p.pid, kids)) {
        if (seenShellPids.has(sh.pid)) continue;
        const command = shellCommand(sh.command);
        const matched = matchShellToThread(norm(command), agy.threads, true);
        if (!matched.threadId) continue;
        seenShellPids.add(sh.pid);
        out.push({
          ...summarize(`agent:${sh.pid}`, sh, [sh, ...descendants(sh.pid, kids)]),
          source: 'agent',
          title: command || sh.command,
          agentId: 'antigravity',
          threadId: matched.threadId,
          toolItemId: matched.toolItemId,
        });
      }
    }
  }

  for (const t of terminalsAlive()) {
    const pid = ptyPid(t.ptyId);
    if (!pid) continue;
    const tree = descendants(pid, kids);
    if (!tree.length) continue; // the shell is at its prompt
    const top = tree[0];
    // The shell itself may run the loop, its children coming and going: time the terminal's command, not them.
    const base = summarize(`terminal:${t.ptyId}`, top, tree);
    out.push({ ...base, secs: t.command ? Math.round((Date.now() - t.startedAt) / 1000) : base.secs, source: 'terminal', title: t.title, command: t.command, ptyId: t.ptyId, projectId: t.projectId, threadId: t.threadId });
  }
  return out.sort((a, b) => b.cpu - a.cpu);
}

const signal = (pids: number[], sig: NodeJS.Signals) => {
  for (const pid of pids)
    try {
      if (pid > 1 && pid !== process.pid) process.kill(pid, sig);
    } catch {
      /* already gone */
    }
};

/**
 * Pause, resume or stop one task. The task is looked up again first, so only a process tree the app started
 * right now is ever signalled (never a reused pid).
 */
export async function controlTask(id: string, action: ProcAction): Promise<RunningTask[]> {
  const task = (await runningTasks(true)).find((t) => t.id === id);
  if (!task) throw new Error('That task has already finished.');
  const parentsFirst = task.pids;
  const childrenFirst = [...task.pids].reverse();
  if (process.platform === 'win32') {
    if (action !== 'stop') throw new Error('Pausing is not available on Windows.');
    await run('taskkill', ['/PID', String(task.rootPid), '/T', '/F']);
  } else if (action === 'pause') {
    signal(childrenFirst, 'SIGSTOP');
  } else if (action === 'resume') {
    signal(parentsFirst, 'SIGCONT');
  } else {
    // A paused program can't act on a stop request, so wake it first.
    signal(parentsFirst, 'SIGCONT');
    if (task.source === 'terminal' && task.ptyId) writePty(task.ptyId, '\x03'); // like pressing Ctrl+C
    else signal(childrenFirst, 'SIGTERM');
    // Whatever ignores that is ended for good after a moment.
    const still = async () => {
      const alive = new Set((await listProcs()).map((p) => p.pid));
      return childrenFirst.filter((p) => alive.has(p));
    };
    setTimeout(async () => {
      let left = await still();
      if (left.length && task.source === 'terminal') {
        signal(left, 'SIGTERM');
        await new Promise((r) => setTimeout(r, 2000));
        left = await still();
      }
      signal(left, 'SIGKILL');
    }, 2500);
  }
  await new Promise((r) => setTimeout(r, 150));
  return runningTasks(true);
}
