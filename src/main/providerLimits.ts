// Limits of agents that bring their own provider logins (OpenCode), read straight from each provider with the
// credentials the agent already saved. Read-only calls only, no prompts, no tokens spent.
//
// - OpenRouter: `GET /api/v1/key` (documented: key limit, free-model daily requests) and `GET /api/v1/credits`
//   (documented: account credits).
// - GitHub Copilot: `GET api.github.com/copilot_internal/user` (UNDOCUMENTED, the endpoint Copilot's own editors
//   use): `quota_snapshots.premium_interactions` + `quota_reset_date`. Accounts without a plan return no snapshot.
// - OpenCode Zen (OpenCode Console login): no usage or balance API exists, so it is reported as such.
// Electron-free so tests/limits.unit.mjs can run the parsers on plain Node.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RateLimitView } from '@shared/types';

export interface ProviderLimitsResult {
  limits: RateLimitView[];
  /** One honest line when part (or all) of the agent has no quota to show, e.g. "OpenCode Zen · no quota reported". */
  note?: string;
  /** The providers the agent is logged in to, e.g. "GitHub Copilot · OpenCode Zen · OpenRouter". */
  plan?: string;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** The next 00:00 UTC after `now` (OpenRouter's daily counters are per UTC day). */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** When a key limit with `limit_reset` resets: daily at 00:00 UTC, weekly on Monday 00:00 UTC, monthly on the 1st. */
function nextLimitReset(kind: unknown, now: number): number | undefined {
  const d = new Date(now);
  if (kind === 'daily') return nextUtcMidnight(now);
  if (kind === 'weekly') {
    const days = (8 - d.getUTCDay()) % 7 || 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days);
  }
  if (kind === 'monthly') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return undefined;
}

const PERIOD: Record<string, string> = { daily: 'daily', weekly: 'weekly', monthly: 'monthly' };

/** OpenRouter `GET /api/v1/key` → the key's spend limit and the free-model requests of the current UTC day. */
export function parseOpenRouterKey(body: any, now = Date.now()): RateLimitView[] {
  const d = body?.data ?? body;
  if (!d || typeof d !== 'object') return [];
  const out: RateLimitView[] = [];
  const limit = num(d.limit);
  const remaining = num(d.limit_remaining);
  if (limit !== undefined && limit > 0 && remaining !== undefined) {
    // Spent in the limit's own period (limit_reset): what the key limit counts, not the key's lifetime usage.
    const used = Math.max(0, Math.round((limit - remaining) * 1e6) / 1e6);
    const period = typeof d.limit_reset === 'string' ? PERIOD[d.limit_reset] : undefined;
    out.push({
      window: 'openrouter_key',
      label: `OpenRouter key limit${period ? ` · ${period}` : ''}`,
      utilization: clamp01(used / limit),
      resetsAt: nextLimitReset(d.limit_reset, now),
      group: 'OpenRouter',
      amount: { used, limit, unit: 'usd' },
    });
  }
  const free = d.free_model_daily_requests;
  const fLimit = num(free?.limit);
  const fUsed = num(free?.used);
  if (fLimit !== undefined && fLimit > 0 && fUsed !== undefined) {
    out.push({
      window: 'openrouter_free_daily',
      label: 'OpenRouter free-model requests · daily',
      utilization: clamp01(fUsed / fLimit),
      resetsAt: nextUtcMidnight(now),
      group: 'OpenRouter',
      amount: { used: fUsed, limit: fLimit, unit: 'requests' },
    });
  }
  return out;
}

/** OpenRouter `GET /api/v1/credits` → the account's prepaid credits (they never reset). */
export function parseOpenRouterCredits(body: any): RateLimitView | undefined {
  const d = body?.data ?? body;
  const total = num(d?.total_credits);
  const usage = num(d?.total_usage);
  if (total === undefined || usage === undefined || total <= 0) return undefined;
  return { window: 'openrouter_credits', label: 'OpenRouter credits', utilization: clamp01(usage / total), group: 'OpenRouter', amount: { used: usage, limit: total, unit: 'usd' } };
}

/**
 * GitHub Copilot `copilot_internal/user` (undocumented) → premium requests this month, or a note when the account
 * has no quota to show (no plan, billing locked, unlimited).
 */
export function parseCopilotUser(body: any): { limits: RateLimitView[]; note?: string } {
  if (!body || typeof body !== 'object') return { limits: [], note: 'GitHub Copilot · no quota reported' };
  const resetRaw = body.quota_reset_date_utc ?? body.quota_reset_date;
  const resetsAt = typeof resetRaw === 'string' && Number.isFinite(Date.parse(resetRaw)) ? Date.parse(resetRaw) : undefined;
  const p = body.quota_snapshots?.premium_interactions;
  if (p && typeof p === 'object') {
    if (p.unlimited === true) return { limits: [], note: 'GitHub Copilot premium requests · unlimited' };
    const entitlement = num(p.entitlement);
    const remaining = num(p.remaining);
    const pct = num(p.percent_remaining);
    if (entitlement !== undefined && entitlement > 0 && (remaining !== undefined || pct !== undefined)) {
      const used = remaining !== undefined ? Math.max(0, entitlement - remaining) : (entitlement * (100 - (pct as number))) / 100;
      return {
        limits: [
          {
            window: 'copilot_premium',
            label: 'Copilot premium requests · monthly',
            utilization: clamp01(remaining !== undefined ? used / entitlement : (100 - (pct as number)) / 100),
            resetsAt,
            group: 'GitHub Copilot',
            amount: { used: Math.round(used), limit: entitlement, unit: 'requests' },
            ...(p.overage_permitted ? { note: 'Extra premium requests are allowed (billed).' } : {}),
          },
        ],
      };
    }
  }
  const sku = typeof body.access_type_sku === 'string' ? body.access_type_sku : '';
  if (/billing_locked/i.test(sku)) return { limits: [], note: 'GitHub Copilot · billing locked, no premium requests' };
  if (body.chat_enabled === false) return { limits: [], note: 'GitHub Copilot · chat not enabled on this account' };
  return { limits: [], note: 'GitHub Copilot · no quota reported' };
}

// ------------------------------------------------------------------ OpenCode's saved logins

export interface OpenCodeCredential {
  /** `openrouter`, `github-copilot`, `opencode` (OpenCode Console / Zen), … */
  integration: string;
  type?: string;
  key?: string;
  /** OAuth: Copilot's GitHub token sits in `refresh`. */
  refresh?: string;
  access?: string;
}

/** OpenCode's data folder: `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode` (on every platform). */
export function openCodeDataDir(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode');
}

/**
 * The logins OpenCode saved: v2 keeps them in `opencode.db` (`credential` table, active rows), v1 in `auth.json`.
 * Values stay in memory, are sent only to the provider they belong to, and are never logged.
 */
export function readOpenCodeCredentials(dir = openCodeDataDir()): OpenCodeCredential[] {
  const out = new Map<string, OpenCodeCredential>();
  const db = join(dir, 'opencode.db');
  if (existsSync(db)) {
    const sqlite = (process as any).getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined;
    if (sqlite) {
      const conn = new sqlite.DatabaseSync(db, { readOnly: true });
      try {
        const rows = conn.prepare('SELECT integration_id, value, active FROM credential ORDER BY time_updated DESC').all() as any[];
        for (const r of rows) {
          const id = String(r.integration_id ?? '');
          if (!id || r.active === 0 || out.has(id)) continue;
          try {
            const v = JSON.parse(String(r.value));
            out.set(id, { integration: id, type: v?.type, key: v?.key, refresh: v?.refresh, access: v?.access });
          } catch {
            /* a row that isn't JSON: not a login we can use */
          }
        }
      } finally {
        conn.close();
      }
    }
  }
  const auth = join(dir, 'auth.json');
  if (existsSync(auth)) {
    try {
      const j = JSON.parse(readFileSync(auth, 'utf8'));
      for (const [id, v] of Object.entries<any>(j ?? {})) if (!out.has(id)) out.set(id, { integration: id, type: v?.type, key: v?.key, refresh: v?.refresh, access: v?.access });
    } catch {
      /* unreadable auth.json: the db (if any) still counts */
    }
  }
  return [...out.values()];
}

const PROVIDER_NAME: Record<string, string> = { 'github-copilot': 'GitHub Copilot', opencode: 'OpenCode Zen', openrouter: 'OpenRouter', anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google' };
const providerName = (id: string) => PROVIDER_NAME[id] ?? id;

export type FetchJson = (url: string, headers: Record<string, string>) => Promise<{ status: number; body: any }>;

/** fetch with a 10 s limit; the body is JSON or null. */
export const fetchJson: FetchJson = async (url, headers) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'olympus-coder', Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body };
};

/**
 * Every limit OpenCode's logins expose. A provider whose read fails is named in the note (the others still show);
 * the whole read throws only when every provider that has a source failed.
 */
export async function readOpenCodeLimits(creds: OpenCodeCredential[], opts: { fetch?: FetchJson; now?: number } = {}): Promise<ProviderLimitsResult> {
  const get = opts.fetch ?? fetchJson;
  const now = opts.now ?? Date.now();
  const limits: RateLimitView[] = [];
  const notes: string[] = [];
  const errors: string[] = [];
  let sources = 0;
  for (const c of creds) {
    if (c.integration === 'openrouter' && c.key) {
      sources++;
      try {
        const auth = { Authorization: `Bearer ${c.key}` };
        const key = await get('https://openrouter.ai/api/v1/key', auth);
        if (key.status === 401 || key.status === 403) {
          notes.push('OpenRouter · saved key was refused');
          continue;
        }
        if (key.status !== 200) throw new Error(`OpenRouter /key returned HTTP ${key.status}`);
        limits.push(...parseOpenRouterKey(key.body, now));
        const credits = await get('https://openrouter.ai/api/v1/credits', auth).catch(() => null);
        const cr = credits?.status === 200 ? parseOpenRouterCredits(credits.body) : undefined;
        if (cr) limits.push(cr);
      } catch (e: any) {
        errors.push(`OpenRouter: ${e?.message ?? e}`);
      }
    } else if (c.integration === 'github-copilot' && (c.refresh || c.access)) {
      sources++;
      try {
        const r = await get('https://api.github.com/copilot_internal/user', { Authorization: `token ${c.refresh || c.access}` });
        if (r.status === 401) {
          notes.push('GitHub Copilot · login expired');
          continue;
        }
        if (r.status !== 200) throw new Error(`GitHub Copilot returned HTTP ${r.status}`);
        const p = parseCopilotUser(r.body);
        limits.push(...p.limits);
        if (p.note) notes.push(p.note);
      } catch (e: any) {
        errors.push(`GitHub Copilot: ${e?.message ?? e}`);
      }
    } else if (c.integration === 'opencode') {
      // OpenCode Console documents no usage or balance API; free models have no published quota we can read.
      notes.push('OpenCode Zen · no quota reported');
    } else {
      notes.push(`${providerName(c.integration)} · no quota reported`);
    }
  }
  if (sources && errors.length === sources && !limits.length) throw new Error(errors.join('; '));
  for (const e of errors) notes.push(`${e.split(':')[0]} · read failed`);
  const plan = creds.length ? creds.map((c) => providerName(c.integration)).join(' · ') : undefined;
  return {
    // With more than one login, a used-up provider leaves the others usable: never mark the whole agent out.
    limits: creds.length > 1 ? limits.map((l) => ({ ...l, partial: true })) : limits,
    ...(!creds.length ? { note: 'No provider login saved in OpenCode' } : notes.length ? { note: notes.join('; ') } : {}),
    ...(plan ? { plan } : {}),
  };
}
