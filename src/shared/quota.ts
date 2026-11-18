import type { AgentStatus, RateLimitView } from './types';

export interface QuotaState {
  /** Whether the agent (or the chosen model group) has hit 100% of its usage limit. */
  out: boolean;
  /** Exhausted rate-limit windows that caused `out` to be true. */
  limits: RateLimitView[];
  /** Earliest reset timestamp (epoch ms) among the exhausted limits. */
  resetsAt?: number;
  /** Names of model groups on this agent that still have remaining quota (e.g. `["Gemini"]`). */
  otherGroupsLeft: string[];
  /** Rate-limit windows on this agent that still have remaining quota. */
  availableGroups: RateLimitView[];
}

/**
 * The limits as they stand now: a window whose reset time has passed counts as reset (0% used, `expired`)
 * until the agent reports fresh numbers. Every view (banners, bars, `list_agents`, spawn checks) reads limits
 * through this, so a stale "100% used" never outlives its reset.
 */
export function liveLimits(limits: RateLimitView[] | undefined, now = Date.now()): RateLimitView[] {
  return (limits ?? []).map((l) => (l.resetsAt && l.resetsAt <= now ? { ...l, utilization: 0, status: 'reset', resetsAt: undefined, expired: true } : l));
}

/** The earliest reset time still ahead among `limits` (epoch ms), if any. */
export function nextResetAt(limits: RateLimitView[] | undefined, now = Date.now()): number | undefined {
  return (limits ?? [])
    .map((l) => l.resetsAt)
    .filter((t): t is number => typeof t === 'number' && t > now)
    .sort((a, b) => a - b)[0];
}

/** "Updated just now" / "Updated 4 min ago" / "Updated 2 h ago" for a limits reading. */
export function formatLimitsAge(at: number | undefined, now = Date.now()): string {
  if (!at) return 'Not read yet';
  const mins = Math.floor((now - at) / 60_000);
  if (mins < 1) return 'Updated just now';
  if (mins < 60) return `Updated ${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `Updated ${h} h ago`;
  return `Updated ${Math.floor(h / 24)} days ago`;
}

/** One limit window as text, e.g. "5-hour limit: 37% used (resets in 2h 5m)" or "5-hour limit: reset, refreshing". */
export function formatLimitLine(l: RateLimitView): string {
  if (l.expired) return `${l.label}: reset, refreshing`;
  const pct = Number.isFinite(l.utilization) ? `${Math.round(l.utilization * 100)}% used` : (l.status ?? 'unknown');
  const reset = formatResetTime(l.resetsAt);
  const amount = formatLimitAmount(l.amount);
  const extra = [amount, reset].filter(Boolean).join(', ');
  return `${l.label}: ${pct}${extra ? ` (${extra})` : ''}`;
}

/** "$1.39 of $10" / "37 of 300 requests" for a limit with real amounts, else "". */
export function formatLimitAmount(a: RateLimitView['amount']): string {
  if (!a) return '';
  if (a.unit === 'usd') {
    const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
    return `${usd(a.used)} of ${usd(a.limit)}`;
  }
  return `${Math.round(a.used).toLocaleString('en-US')} of ${Math.round(a.limit).toLocaleString('en-US')} requests`;
}

function modelGroupOf(model?: string): string | undefined {
  if (!model) return undefined;
  // OpenCode / Olympus CLI model ids carry their provider: `openrouter/…`, `github-copilot/…`.
  if (/^openrouter\//i.test(model)) return 'OpenRouter';
  if (/^github-copilot\//i.test(model)) return 'GitHub Copilot';
  if (/gemini/i.test(model)) return 'Gemini';
  if (/claude|gpt|opus|sonnet|haiku|o[134]/i.test(model)) return 'Claude & GPT';
  return undefined;
}

/**
 * Evaluates whether an agent (and optionally a specific model) has remaining usage quota.
 * Shared across the main-process orchestrator and the renderer composer/agent switcher.
 */
export function quotaState(status: AgentStatus | undefined, model?: string): QuotaState {
  // Expired windows count as reset (available), not as missing: see `liveLimits`.
  // A limit on one of several providers (OpenCode's OpenRouter credits) counts only for that provider's models.
  const wanted = modelGroupOf(model);
  const all = liveLimits(status?.limits).filter((l) => !l.partial || (wanted !== undefined && l.group === wanted));
  if (!all.length) return { out: false, limits: [], otherGroupsLeft: [], availableGroups: [] };

  const isHit = (l: RateLimitView) => l.status === 'rejected' || l.utilization >= 0.999;
  const availableGroups = all.filter((l) => !isHit(l));

  const groups = [...new Set(all.map((l) => l.group).filter((g): g is string => Boolean(g)))];
  if (!groups.length) {
    const hit = all.filter(isHit);
    const resetsAt = hit.map((l) => l.resetsAt).filter((x): x is number => Boolean(x)).sort((a, b) => a - b)[0];
    return { out: hit.length > 0, limits: hit, resetsAt, otherGroupsLeft: [], availableGroups };
  }

  const wantedGroup = wanted;
  const groupHasQuota = (g: string) => !all.filter((l) => l.group === g).some(isHit);
  const freeGroupNames = groups.filter(groupHasQuota);

  if (wantedGroup && groups.includes(wantedGroup)) {
    const hit = all.filter((l) => l.group === wantedGroup && isHit(l));
    const resetsAt = hit.map((l) => l.resetsAt).filter((x): x is number => Boolean(x)).sort((a, b) => a - b)[0];
    return {
      out: hit.length > 0,
      limits: hit,
      resetsAt,
      otherGroupsLeft: freeGroupNames.filter((g) => g !== wantedGroup),
      availableGroups,
    };
  }

  const allGroupsOut = freeGroupNames.length === 0;
  const hit = allGroupsOut ? all.filter(isHit) : [];
  const resetsAt = hit.map((l) => l.resetsAt).filter((x): x is number => Boolean(x)).sort((a, b) => a - b)[0];
  return {
    out: allGroupsOut,
    limits: hit,
    resetsAt,
    otherGroupsLeft: freeGroupNames,
    availableGroups,
  };
}

/**
 * Detects short conversational replies emitted by CLI agents when a plan/usage limit is hit
 * instead of throwing a protocol error (kept strict on length so code/docs discussing rate limits never match).
 */
export function isQuotaMessage(text: string | undefined): boolean {
  if (!text || text.length >= 320) return false;
  return /hit your.{0,20}limit|out of (extra )?usage|usage limit.{0,30}(reached|exceeded|hit)|quota (exceeded|reached)|rate.?limit.{0,20}(reached|exceeded)|credit balance is too low/i.test(text);
}

/**
 * Detects short replies in which the agent refuses to run because the chosen model can't be used
 * (e.g. Codex: "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.").
 * Agents send these as plain text, so without this a turn that never started looks finished.
 */
export function isModelUnavailableMessage(text: string | undefined): boolean {
  // Codex prefixes non-fatal "Warning: Model metadata for … not found" lines even to normal replies.
  const body = text?.replace(/^\s*warning:.*$/gim, '').trim();
  if (!body || body.length >= 400) return false;
  return /\bmodel\b.{0,80}\b(is not supported|not supported (when|with|for)|does not exist|not found|is not available|unavailable|you do not have access)|\b(unknown|invalid|unsupported) model\b/i.test(
    body,
  );
}

/**
 * Detects protocol/API quota or rate-limit error messages recorded on `error` thread items.
 */
export function isQuotaErrorText(text: string | undefined): boolean {
  if (!text || text.length >= 800) return false;
  if (isQuotaMessage(text)) return true;
  return /\b(429|rate_limit_error|insufficient_quota|resource_exhausted|quota_exceeded|billing_hard_limit_reached)\b|exceeded your current quota|too many requests|exhausted.{0,25}(quota|capacity)/i.test(
    text,
  );
}

/** Formats a reset timestamp (epoch ms, or seconds if < 1e12) into a concise human-readable duration. */
export function formatResetTime(resetsAt?: number): string {
  if (!resetsAt) return '';
  const tsMs = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  const d = new Date(tsMs);
  const mins = Math.round((d.getTime() - Date.now()) / 60_000);
  if (mins <= 0) return 'resets shortly';
  if (mins < 60) return `resets in ${mins}m`;
  if (mins < 24 * 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `resets in ${h}h${m ? ` ${m}m` : ''}`;
  }
  // Beyond a week (monthly quotas, a far weekly reset) the date reads better than a weekday: "resets Dec 1".
  if (mins > 7 * 24 * 60) return `resets ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  return `resets ${d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
}
