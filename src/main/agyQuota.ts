import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RateLimitView } from '@shared/types';

/**
 * Antigravity quota. agy reports no quota over ACP, but its local daemon (the same one the Antigravity IDE
 * talks to) answers `RetrieveUserQuotaSummary` on 127.0.0.1. The daemon writes its port and a CSRF token to
 * ~/.gemini/antigravity/daemon/hub_<port>.json. Nothing leaves the machine and no Google token is touched.
 *
 * This API is undocumented, so every failure just means "no quota data".
 */

interface Discovery {
  pid: number;
  httpPort: number;
  csrfToken: string;
}

function daemonDir(): string {
  const base = process.env.ANTIGRAVITY_APP_DATA_DIR || join(homedir(), '.gemini', 'antigravity');
  return join(base, 'daemon');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The newest daemon discovery file whose process is still running. */
function findDaemon(): Discovery | null {
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
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Discovery;
      if (d.httpPort && d.csrfToken && alive(d.pid)) return d;
    } catch {
      /* torn or old file */
    }
  }
  return null;
}

const GROUP_LABEL = (name: string) => (/gemini/i.test(name) ? 'Gemini' : /claude|gpt/i.test(name) ? 'Claude & GPT' : name);
const WINDOW_LABEL = (w: string) => (w === '5h' ? '5-hour' : w === 'weekly' ? 'weekly' : w);

export async function fetchAgyQuota(): Promise<RateLimitView[] | null> {
  const d = findDaemon();
  if (!d) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${d.httpPort}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': d.csrfToken },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    const out: RateLimitView[] = [];
    for (const g of body?.response?.groups ?? []) {
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
