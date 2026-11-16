import { execFile } from 'node:child_process';
import type { PortInfo } from '@shared/types';
import { listProcs } from './processes';

/**
 * TCP ports in use (listening) by the user's programs, with the program behind each, so "address already in
 * use" can be answered with who has the port and a way to stop it. Ephemeral ports (49152+) that system
 * services and apps open for themselves are left out unless Olympus started the program.
 */

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve) => execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout: 8000, windowsHide: true }, (_e, out) => resolve(String(out ?? ''))));

async function listening(): Promise<{ pid: number; port: number; address: string; name: string }[]> {
  const out: { pid: number; port: number; address: string; name: string }[] = [];
  if (process.platform === 'win32') {
    const net = await run('netstat', ['-ano', '-p', 'tcp']);
    for (const m of net.matchAll(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/gm)) out.push({ address: m[1], port: +m[2], pid: +m[3], name: '' });
    return out;
  }
  const lsof = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']);
  let pid = 0;
  let name = '';
  for (const line of lsof.split('\n')) {
    if (line[0] === 'p') pid = +line.slice(1);
    else if (line[0] === 'c') name = line.slice(1);
    else if (line[0] === 'n') {
      const m = /^(.*):(\d+)$/.exec(line.slice(1));
      if (m) out.push({ pid, port: +m[2], address: m[1], name });
    }
  }
  return out;
}

export async function listPorts(): Promise<PortInfo[]> {
  const [socks, procs] = await Promise.all([listening(), listProcs()]);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  /** Started by Olympus: this app's process is one of its ancestors. */
  const ours = (pid: number) => {
    for (let p = byPid.get(pid), hops = 0; p && hops < 40; p = byPid.get(p.ppid), hops++) if (p.ppid === process.pid) return true;
    return false;
  };
  const seen = new Map<string, PortInfo>();
  for (const s of socks) {
    const key = `${s.pid}:${s.port}`;
    if (seen.has(key)) continue;
    const started = ours(s.pid);
    if (s.port >= 49152 && !started) continue;
    const proc = byPid.get(s.pid);
    seen.set(key, {
      port: s.port,
      address: s.address === '*' || s.address === '[::]' || s.address === '0.0.0.0' ? 'all interfaces' : s.address.replace(/^\[|\]$/g, ''),
      pid: s.pid,
      name: s.name || proc?.command.split(/[\\/]/).pop()?.split(' ')[0] || `pid ${s.pid}`,
      command: proc?.command ?? s.name,
      startedHere: started,
      self: s.pid === process.pid,
    });
  }
  return [...seen.values()].sort((a, b) => Number(b.startedHere) - Number(a.startedHere) || a.port - b.port);
}

/** Ends the program holding a port: SIGTERM, then SIGKILL if it is still there after a moment. */
export async function stopPortOwner(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) throw new Error('That process cannot be stopped from here.');
  const owners = new Set((await listening()).map((s) => s.pid));
  if (!owners.has(pid)) throw new Error('That program no longer holds a port.');
  if (process.platform === 'win32') {
    await run('taskkill', ['/PID', String(pid), '/T', '/F']);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  await new Promise((r) => setTimeout(r, 1500));
  try {
    process.kill(pid, 0);
    process.kill(pid, 'SIGKILL');
  } catch {
    /* gone */
  }
}
