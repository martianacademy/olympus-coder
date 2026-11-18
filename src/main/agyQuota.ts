import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RateLimitView } from '@shared/types';

/**
 * Antigravity quota reader (`RetrieveUserQuotaSummary` on 127.0.0.1).
 *
 * Reads from two local sources (nothing leaves the machine and no Google token is touched):
 * 1. Running `agy acp` CLI servers (`~/.gemini/antigravity-cli/log/acp-server-*-<pid>.log`), which start an
 *    in-process Go `LanguageServerService` on `127.0.0.1:<httpPort>` as soon as any ACP session opens — so
 *    quota works inside Olympus Coder even when the standalone Antigravity IDE desktop app is closed or uninstalled.
 * 2. Fallback to the Antigravity IDE daemon (`~/.gemini/antigravity/daemon/hub_<port>.json`, with `x-codeium-csrf-token`).
 */

interface QuotaEndpoint {
  httpPort: number;
  csrfToken?: string;
}

interface HubDiscovery {
  pid: number;
  httpPort: number;
  csrfToken: string;
}

function daemonDir(): string {
  const base = process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity');
  return join(base, 'daemon');
}

function cliLogDir(): string {
  const base = process.env.ANTIGRAVITY_CLI_DATA_DIR || join(homedir(), '.gemini', 'antigravity-cli');
  return join(base, 'log');
}

function alive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readHead(path: string, maxBytes = 8192): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Active `agy acp` in-process HTTP servers discovered from `acp-server-*-<pid>.log` (`preferredPid` first). */
export function findCliEndpoints(preferredPid?: number): QuotaEndpoint[] {
  const dir = cliLogDir();
  let entries: { file: string; pid: number; mtime: number }[];
  try {
    entries = readdirSync(dir)
      .map((file) => {
        const m = /^acp-server-[^-]+-(\d+)\.log$/.exec(file);
        if (!m) return null;
        const pid = Number(m[1]);
        if (!alive(pid)) return null;
        return { file, pid, mtime: statSync(join(dir, file)).mtimeMs };
      })
      .filter((x): x is { file: string; pid: number; mtime: number } => x !== null)
      .sort((a, b) => {
        if (preferredPid) {
          if (a.pid === preferredPid && b.pid !== preferredPid) return -1;
          if (b.pid === preferredPid && a.pid !== preferredPid) return 1;
        }
        return b.mtime - a.mtime;
      });
  } catch {
    return [];
  }

  const out: QuotaEndpoint[] = [];
  const seenPorts = new Set<number>();
  for (const e of entries.slice(0, 6)) {
    const head = readHead(join(dir, e.file));
    const m = /Language server listening on random port at (\d+) for HTTP\b/.exec(head);
    if (!m) continue;
    const httpPort = Number(m[1]);
    if (httpPort > 0 && !seenPorts.has(httpPort)) {
      seenPorts.add(httpPort);
      out.push({ httpPort });
    }
  }
  return out;
}

/** The newest Antigravity IDE daemon discovery file whose process is still running. */
export function findHubDaemon(): QuotaEndpoint | null {
  const dir = daemonDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /^hub_\d+\.json$/.test(f));
  } catch {
    return null;
  }
  const sorted = files.map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { f } of sorted) {
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8')) as HubDiscovery;
      if (d.httpPort && d.csrfToken && alive(d.pid)) return { httpPort: d.httpPort, csrfToken: d.csrfToken };
    } catch {
      /* torn or old file */
    }
  }
  return null;
}

const GROUP_LABEL = (name: string) => (/gemini/i.test(name) ? 'Gemini' : /claude|gpt/i.test(name) ? 'Claude & GPT' : name);
const WINDOW_LABEL = (w: string) => (w === '5h' ? '5-hour' : w === 'weekly' ? 'weekly' : w);

async function queryEndpoint(ep: QuotaEndpoint): Promise<RateLimitView[] | null> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' };
    if (ep.csrfToken) headers['x-codeium-csrf-token'] = ep.csrfToken;
    const res = await fetch(`http://127.0.0.1:${ep.httpPort}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    const groups = body?.response?.groups;
    if (!Array.isArray(groups) || groups.length === 0) return null;
    const out: RateLimitView[] = [];
    for (const g of groups) {
      for (const b of g.buckets ?? []) {
        // A disabled bucket "does not currently apply" (e.g. the 5-hour limit once the weekly one is hit).
        if (b.disabled) continue;
        const remaining = Math.max(0, Math.min(1, Number(b.remainingFraction ?? 1)));
        out.push({
          window: String(b.bucketId ?? `${g.displayName}-${b.window}`),
          label: `${GROUP_LABEL(String(g.displayName ?? ''))} · ${WINDOW_LABEL(String(b.window ?? ''))}`,
          utilization: 1 - remaining,
          resetsAt: b.resetTime ? Date.parse(b.resetTime) : undefined,
          status: remaining <= 0 ? 'rejected' : 'allowed',
          group: String(g.displayName ?? ''),
          note: typeof b.description === 'string' ? b.description : undefined,
        });
      }
    }
    return out;
  } catch {
    return null;
  }
}

export async function fetchAgyQuota(opts: { preferredPid?: number } = {}): Promise<RateLimitView[] | null> {
  const hub = findHubDaemon();
  const candidates: QuotaEndpoint[] = [...findCliEndpoints(opts.preferredPid), ...(hub ? [hub] : [])];
  for (const ep of candidates) {
    const limits = await queryEndpoint(ep);
    if (limits) return limits;
  }
  return null;
}
